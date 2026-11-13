import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import { matlabFileStem, matlabPathScope } from './matlab-path';
import { isOctave } from './matlab-syntax';
import { MATLAB_BUILTINS } from './matlab-builtins';
import { JAVA_PACKAGE_ROOTS, isJavaImport } from './matlab-java';
import { matlabRefCandidates, type MatlabRefFacts } from './matlab-ref-facts';

/**
 * MATLAB extractor (vendored acristoffers/tree-sitter-matlab, ABI 15).
 *
 * Everything goes through the visitNode hook: the grammar spells a call and an
 * index read the same way (`f(x)` is a `function_call` whether `f` is a
 * function or a matrix), and a method, a nested function and a local function
 * are all one `function_definition`, so which is which is decided here from
 * the surrounding code rather than from node-type lists.
 *
 *   - functions:  a file's FIRST function is the one MATLAB calls by the file's
 *                 name (`isExported`, and named so whatever its line
 *                 declares); the ones after it, and nested ones, are
 *                 local to the file (`isExported: false` — the resolver keeps
 *                 another file's calls off them). In a class folder
 *                 (`@Account/deposit.m`) the first function is a method of
 *                 that class; `@Account/Account.m` holding a function is an
 *                 old-style class's constructor, and a class node of that
 *                 name contains it.
 *   - packages:   `+pkg/+sub/f.m` qualifies what the file defines as
 *                 `pkg::sub::f`, so `pkg.sub.f(x)` resolves by qualified name.
 *   - classdef:   class (an `enumeration` class with members is an enum);
 *                 `< Base & handle` → extends refs; properties → property
 *                 (Constant → constant); `methods (Static, Access = private)`
 *                 blocks set the static / visibility flags on their methods,
 *                 `methods (Abstract)` the abstract one; `get.Prop` /
 *                 `set.Prop` keep their prefix.
 *   - calls:      `f(x)`, `f` as a value, `pkg.f(x)`, `Cls.staticM(x)`,
 *                 `obj.m(x)`, `m@Super(obj)`, and command syntax
 *                 (`setup_paths`, `hold on`). A name the enclosing function
 *                 assigns, takes as an argument or declares global is a
 *                 VARIABLE there (MATLAB decides that per function,
 *                 statically): `x(3)` on one is an index read and emits
 *                 nothing. So does `x(:, k)`, `a(end)` or `c{k}` on any name,
 *                 what an assignment writes (`s.f{1}(k, :) = …`), and a Java
 *                 class (`java.lang.String(…)`).
 *                 `obj.m()` and `m(obj, …)` on a method's own object (its
 *                 first parameter, or a constructor's output) are `Cls::m`.
 *                 On a variable assigned from a constructor (`c = pkg.Cls(…)`,
 *                 `c = Cls;`) they are `pkg::Cls::m`. On any other variable
 *                 `v.m()` is `v.m`, which the resolver links only to an
 *                 unambiguous method; a field the function fills in itself
 *                 emits nothing. How each was written (with arguments, bare,
 *                 as a statement, the name a dispatched call was written
 *                 with) rides along: see matlab-ref-facts.ts. A built-in's
 *                 name is recorded like any other: whether a project function
 *                 of that name is what it reaches is the resolver's to say
 *                 (see MATLAB_BUILTINS).
 *   - handles:    `@f` / `@pkg.f` / `@obj.m` are function references
 *                 (callbacks: `cellfun(@f, …)`, `'Callback', @onClick`).
 *   - imports:    `import pkg.Cls` (command syntax); `import pkg.*` is an
 *                 import node only, since no node stands for a package.
 *
 * Octave is not supported: a file with Octave-only syntax (a `#` comment line,
 * `endfunction` / `endif` / …) gets its file node and nothing else, rather
 * than the commands and cut-short functions the MATLAB grammar reads it as.
 */

/** Built-in base classes: never a project symbol, so no extends edge to guess at. */
const BUILTIN_BASES =
  /^(?:handle|dynamicprops|hgsetget|matlab\..*|matlab|event\..*|sym|double|single|logical|char|u?int(?:8|16|32|64))$/;

/** Parent node types under which a bare identifier is READ as a value (or called with no arguments). */
const VALUE_PARENTS = new Set([
  'binary_operator',
  'unary_operator',
  'comparison_operator',
  'boolean_operator',
  'not_operator',
  'postfix_operator',
  'parenthesis',
  'row',
  'range',
]);

/** Statements whose `condition` is read as a value: `if isReady`, `while keepGoing`, `switch mode`, `case modeA`. */
const CONDITION_PARENTS = new Set(['if_statement', 'elseif_clause', 'while_statement', 'switch_statement', 'case_clause']);

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

/** Identifiers directly under a node (e.g. `function_output`, `multioutput_variable`, `global_operator`). */
function identifiersIn(node: SyntaxNode, source: string, into: Set<string>): void {
  for (const c of namedChildren(node)) {
    if (c.type === 'identifier') into.add(getNodeText(c, source));
    else if (c.type === 'multioutput_variable') identifiersIn(c, source, into);
  }
}

/** The leading `attributes` child of a classdef / properties / methods node (comments aside). */
function leadingAttributes(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type === 'comment') continue;
    return c.type === 'attributes' ? c : null;
  }
  return null;
}

/**
 * Attribute names (lowercased) of a node's leading `attributes`, with their
 * values: `Access = private` → access→private, `Static` → static→true.
 */
function attributesOf(node: SyntaxNode, source: string): Map<string, string> {
  const out = new Map<string, string>();
  const attrs = leadingAttributes(node);
  if (!attrs) return out;
  for (const attr of namedChildren(attrs)) {
    if (attr.type !== 'attribute') continue;
    const parts = namedChildren(attr);
    const key = parts[0] ? getNodeText(parts[0], source).toLowerCase() : '';
    if (!key) continue;
    const value = parts[1] ? getNodeText(parts[1], source).replace(/^['"]|['"]$/g, '').toLowerCase() : 'true';
    out.set(key, value);
  }
  return out;
}

function visibilityFrom(attrs: Map<string, string>): 'public' | 'private' | 'protected' | undefined {
  const access = attrs.get('access') ?? attrs.get('getaccess');
  if (access === 'private') return 'private';
  if (access === 'protected') return 'protected';
  if (access === 'public') return 'public';
  return undefined;
}

/** `%`-comment text of a function's or class's help block (the first comment child), markers stripped. */
function helpText(children: readonly SyntaxNode[], source: string): string | undefined {
  const comment = children.find((c) => c.type === 'comment');
  if (!comment) return undefined;
  const text = getNodeText(comment, source)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*%[{}]?\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * What `f(…)` / `f{…}` says of `f`: `'variable'` when only an array can be
 * indexed so — braces (a cell's contents) or an `end` that can be its own
 * only (`a(end)`, `b(2:end)`, `c(end-1, [1 end])`); `'index'` when this
 * site reads as indexing but `f` may still be a function — a bare `:` among
 * its arguments (`x(:, 2)`; MATLAB passes `f(:)` a `':'`); else null. An
 * `end` belongs to the innermost array indexed around it, and a function
 * call is no array: `pop(select(2, end))` is pop's `end` when select is a
 * function. So in a call inside another call's arguments an `end` says
 * nothing, and neither does one inside an index or a lambda in its own
 * arguments (`g(x(end))`).
 */
function arrayEvidence(call: SyntaxNode): 'variable' | 'index' | null {
  let evidence = arrayEvidenceMemo.get(call.id);
  if (evidence === undefined) arrayEvidenceMemo.set(call.id, (evidence = readArrayEvidence(call)));
  return evidence;
}

/**
 * arrayEvidence's answers for the file being walked, by node id: scanScope
 * asks for a function's calls, then the walk for each call again. Reset by
 * extractFile, like javaImported.
 */
let arrayEvidenceMemo = new Map<number, 'variable' | 'index' | null>();

function readArrayEvidence(call: SyntaxNode): 'variable' | 'index' | null {
  for (let i = 0; i < call.childCount; i++) if (call.child(i)?.type === '{') return 'variable';
  const args = namedChildren(call).find((c) => c.type === 'arguments');
  if (!args) return null;
  const ownEnd = (n: SyntaxNode): boolean => {
    if (n.type === 'end_keyword') return true;
    if (n.type === 'function_call' || n.type === 'lambda') return false;
    return namedChildren(n).some(ownEnd);
  };
  const argList = namedChildren(args);
  if (!isInCallArguments(call) && argList.some(ownEnd)) return 'variable';
  if (argList.some((a) => a.type === 'spread_operator')) return 'index';
  return null;
}

/** Whether `f(…)` / `f{…}` can only be indexing here (see arrayEvidence). */
function indexesLikeArray(call: SyntaxNode): boolean {
  return arrayEvidence(call) !== null;
}

/** Whether `node` sits in a call's (or index's) arguments, at any depth of its expression. */
function isInCallArguments(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'arguments' && p.parent?.type === 'function_call') return true;
    if (p.type === 'block' || p.type === 'source_file' || p.type === 'function_definition') return false;
  }
  return false;
}

/** Whether an expression is a statement of its own (`run('setup');`, `if ok, run('a'), end`), not a value. */
function isStatement(node: SyntaxNode): boolean {
  const p = node.parent?.type;
  return p === 'block' || p === 'source_file';
}

/**
 * Whether `node` is part of what an assignment writes to — `x(k) = …`,
 * `s.f{1}(k, :) = …`, `AO.(name).Monitor.Params{1} = …`, `[a.b, c(2)] = …` —
 * reached up the chain (a call's callee, a field chain's parts, the outputs'
 * list), never through an index's arguments, which are read.
 */
function isAssignmentTarget(node: SyntaxNode): boolean {
  let n = node;
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (p.type === 'assignment') return getChildByField(p, 'left')?.id === n.id;
    if (p.type === 'field_expression' || p.type === 'multioutput_variable') continue;
    if (p.type === 'function_call' && getChildByField(p, 'name')?.id === n.id) continue;
    return false;
  }
  return false;
}

/**
 * Whether a field chain is the middle of a longer one: the grammar reads
 * `AO.Q2.Setpoint.P{1}(6, :)` as `AO.(Q2.Setpoint.P{1})(6, :)`, so the inner
 * chain's head `Q2` is a field of `AO`, not a variable, a package or a class.
 */
function isInnerChain(node: SyntaxNode): boolean {
  const call = node.parent;
  if (call?.type !== 'function_call' || getChildByField(call, 'name')?.id !== node.id) return false;
  const outer = call.parent;
  return outer?.type === 'field_expression' && getChildByField(outer, 'object')?.id !== call.id;
}

/** A dotted name's identifiers (`pkg.Base` in a `superclass`, `@pkg.f`), or null when anything else is in it. */
function dottedName(node: SyntaxNode, source: string): string[] | null {
  const ids = namedChildren(node);
  if (ids.length === 0 || ids.some((c) => c.type !== 'identifier')) return null;
  return ids.map((c) => getNodeText(c, source));
}

// ---------------------------------------------------------------------------
// Frames — what the code at hand sees: its variables, what they hold, its object
// ---------------------------------------------------------------------------

interface Self {
  /** The variable that holds the method's own object. */
  name: string;
  /** Its class, `pkg::Cls`. */
  cls: string;
}

/**
 * One function's view, computed once when the walk enters it (a function, a
 * lambda, a class body, or a script's top level) and popped when it leaves.
 */
interface Frame {
  /** Whose view: a function's, a lambda's, a class body's, or the file's top level. */
  kind: 'function' | 'lambda' | 'class' | 'file';
  /** Scope path the definitions inside are qualified with (`pkg`, `Cls`, `fn`). */
  qual: readonly string[];
  /** Variables assigned, passed in or declared HERE (a lambda's: its parameters) — see isLocal for the ones it shares. */
  locals: ReadonlySet<string>;
  /** Variable → the class its every constructor-shaped assignment here names (`c = pkg.Cls(…)` → `pkg::Cls`). */
  classHints: ReadonlyMap<string, ClassHint>;
  /** `v.f` for every field assigned here, and `v` for every `v = struct(…)`: `v.f(…)` there reads a field. */
  structFields: ReadonlySet<string>;
  /** The method's own object, when the code is a non-static method's (or nested in one, and no lambda parameter hides it). */
  self: Self | null;
  /**
   * The frame whose variables this one also sees: a nested function's parent
   * function (they share one workspace), a lambda's enclosing code. Looked up
   * through, never copied, so a frame costs only what it declares itself.
   * Null for a top-level function, a class body and the file.
   */
  parent: Frame | null;
}

const EMPTY: ReadonlySet<string> = new Set();
/**
 * The class a variable holds, and whether only a bare name said so (`aa =
 * Archive;`): that is a class's constructor called with no arguments, or as
 * well a function's call (`G = GetCfg;`), which only the resolver can tell.
 */
interface ClassHint {
  cls: string;
  bare: boolean;
}

const NO_HINTS: ReadonlyMap<string, ClassHint> = new Map();

/**
 * The walk's frames. Pushed and popped around each scope's children within
 * one synchronous extraction, so it is empty between files — no state outlives
 * the file it was computed for.
 */
const frames: Frame[] = [];

/** Outside every frame (only if a walk ever starts below the file's root): nothing in scope. */
const NO_FRAME: Frame = { kind: 'file', qual: [], locals: EMPTY, classHints: NO_HINTS, structFields: EMPTY, self: null, parent: null };

/**
 * The classes the file imports from Java by name (`import java.util.ArrayList`
 * → `ArrayList`), set while extractFile walks it: `ArrayList()` there is
 * Java's constructor. Read for the whole file, as a wildcard's names cannot be.
 */
let javaImported: ReadonlySet<string> = EMPTY;

/** Whether a dotted name's head is Java's: `java`, `javax`, or a class the file imports from Java. */
function isJavaHead(head: string): boolean {
  return JAVA_PACKAGE_ROOTS.has(head) || javaImported.has(head);
}

/** Whether a class hint (`javax::swing::JFrame`, `ArrayList` imported from Java) names a Java class: its methods are never the project's. */
function isJavaClass(cls: string): boolean {
  return isJavaHead(cls.split('::')[0]!);
}

/** The classes `root`'s `import java.….Cls` / `import javax.….Cls` statements name (a wildcard's are unknown). */
function javaImportsOf(root: SyntaxNode, source: string): ReadonlySet<string> {
  if (!/\bimport\s+javax?\./.test(source)) return EMPTY;
  const names = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    for (const c of namedChildren(n)) {
      if (c.type !== 'command') {
        walk(c);
        continue;
      }
      const cmd = namedChildren(c).find((a) => a.type === 'command_name');
      if (!cmd || getNodeText(cmd, source) !== 'import') continue;
      for (const arg of namedChildren(c)) {
        const target = arg.type === 'command_argument' ? getNodeText(arg, source).trim() : '';
        if (isJavaImport(target) && !target.endsWith('.*')) names.add(target.slice(target.lastIndexOf('.') + 1));
      }
    }
  };
  walk(root);
  return names;
}

function frame(): Frame {
  return frames[frames.length - 1] ?? NO_FRAME;
}

/** Whether `name` is a variable where frame `f` reads it: its own, or one of a workspace it shares. */
function isLocal(f: Frame, name: string): boolean {
  for (let g: Frame | null = f; g; g = g.parent) if (g.locals.has(name)) return true;
  return false;
}

/**
 * The class variable `v` holds where frame `f` reads it. A lambda's parameter
 * holds whatever the lambda is called with; a nested function goes by its own
 * assignments only (it may reassign its parent's variable).
 */
function classHintOf(f: Frame, v: string): ClassHint | undefined {
  let g = f;
  while (g.kind === 'lambda') {
    if (g.locals.has(v)) return undefined;
    g = g.parent!;
  }
  return g.classHints.get(v);
}

/** Whether `v.member(…)` reads a field there: `v` is made a struct, or that field filled in (a lambda parameter `v` is another variable). */
function readsStructField(f: Frame, v: string, member: string): boolean {
  const field = `${v}.${member}`;
  for (let g: Frame | null = f; g; g = g.parent) {
    if (g.kind === 'lambda') {
      if (g.locals.has(v)) return false;
    } else if (g.structFields.has(v) || g.structFields.has(field)) return true;
  }
  return false;
}

function inFrame(f: Frame, walk: () => void): void {
  frames.push(f);
  try {
    walk();
  } finally {
    frames.pop();
  }
}

interface ScopeFacts {
  locals: Set<string>;
  /**
   * `v = Cls(…)` / `v = pkg.Cls(…)` / `v = Cls`: the variable, the callee's
   * head (which must be no variable), the class it names, and whether it is
   * a bare name.
   */
  constructions: Array<{ v: string; head: string; cls: string; bare: boolean }>;
  structFields: Set<string>;
}

/**
 * The variables of `scope` (a function_definition or a script's source_file)
 * and what its assignments say about them — one walk, its nested functions
 * excluded. In a function, a name indexed as only an array can be (`c{k}`,
 * `a(end)`: see arrayEvidence) is one of its variables too — MATLAB decides
 * that per function, so every use of it there, before or after, is one. A
 * script's workspace is the caller's, and what a name is there may change
 * between its lines: there the evidence holds at its own site only.
 */
function scanScope(scope: SyntaxNode, source: string, isFunction: boolean): ScopeFacts {
  const locals = new Set<string>();
  const constructions: ScopeFacts['constructions'] = [];
  const structFields = new Set<string>();

  /**
   * `Cls(…)` / `pkg.Cls(…)` (MATLAB names classes in UpperCamelCase): [head,
   * class] — a capitalised callee that is no variable reads as a constructor.
   * So does a bare `Cls` (`aa = ArchAppliance;`), the constructor called with
   * no arguments. Not a built-in's name, either way (`x = NaN;`, `x = NaN(n,
   * 1)`, `e = MException(…)`): what it makes is MATLAB's, none of whose
   * methods is the project's.
   */
  const constructed = (rhs: SyntaxNode | null): [string, string] | null => {
    if (rhs?.type === 'identifier') {
      const text = getNodeText(rhs, source);
      return /^[A-Z]/.test(text) && !MATLAB_BUILTINS.has(text) ? [text, text] : null;
    }
    if (rhs?.type === 'function_call') {
      const name = getChildByField(rhs, 'name');
      const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
      return /^[A-Z]/.test(text) && !MATLAB_BUILTINS.has(text) ? [text, text] : null;
    }
    if (rhs?.type === 'field_expression') {
      const parts = namedChildren(rhs);
      const last = parts[parts.length - 1];
      if (parts.length < 2 || last?.type !== 'function_call') return null;
      const path: string[] = [];
      for (const p of parts.slice(0, -1)) {
        if (p.type !== 'identifier') return null;
        path.push(getNodeText(p, source));
      }
      const name = getChildByField(last, 'name');
      const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
      return /^[A-Z]/.test(text) ? [path[0]!, [...path, text].join('::')] : null;
    }
    return null;
  };

  /** `x(k) = …` makes x a variable. */
  const indexAssigned = (left: SyntaxNode): void => {
    const name = getChildByField(left, 'name');
    if (name) locals.add(getNodeText(name, source));
  };
  /** `v.f = …` / `v.f(k) = …`: v is a variable, and f a field the scope fills in; `s(k).f = …` makes s one. */
  const fieldAssigned = (left: SyntaxNode): void => {
    const obj = getChildByField(left, 'object');
    if (obj?.type === 'identifier') {
      const v = getNodeText(obj, source);
      locals.add(v);
      const field = obj.nextNamedSibling;
      const fieldName = field?.type === 'function_call' ? getChildByField(field, 'name') : field;
      if (fieldName?.type === 'identifier') structFields.add(`${v}.${getNodeText(fieldName, source)}`);
    } else if (obj?.type === 'function_call') indexAssigned(obj);
  };

  const walk = (n: SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (!c) continue;
      switch (c.type) {
        case 'function_definition':
        case 'class_definition':
        case 'lambda': // its parameters are its own; it assigns nothing
          continue;
        case 'function_output':
        case 'function_arguments':
        case 'global_operator':
        case 'persistent_operator':
          identifiersIn(c, source, locals);
          continue;
        case 'assignment': {
          const left = getChildByField(c, 'left');
          if (left?.type === 'identifier') {
            const v = getNodeText(left, source);
            locals.add(v);
            const right = getChildByField(c, 'right');
            const made = constructed(right);
            if (made) constructions.push({ v, head: made[0], cls: made[1], bare: right?.type === 'identifier' });
            else if (right?.type === 'function_call' && getNodeText(getChildByField(right, 'name') ?? right, source) === 'struct') {
              structFields.add(v);
            }
          } else if (left?.type === 'multioutput_variable') {
            // `[a, s.f, x(k), ~] = …`
            for (const out of namedChildren(left)) {
              if (out.type === 'identifier') locals.add(getNodeText(out, source));
              else if (out.type === 'field_expression') fieldAssigned(out);
              else if (out.type === 'function_call') indexAssigned(out);
            }
          } else if (left?.type === 'function_call') indexAssigned(left);
          else if (left?.type === 'field_expression') fieldAssigned(left);
          break;
        }
        case 'iterator': {
          const v = c.namedChild(0);
          if (v?.type === 'identifier') locals.add(getNodeText(v, source));
          break;
        }
        case 'catch_clause': {
          // `catch ME` — the error variable is on the `catch` line. An
          // identifier on a later line is a statement (a command-syntax call).
          const v = errorVariable(c);
          if (v) locals.add(getNodeText(v, source));
          break;
        }
        case 'function_call': {
          // `c{k}` / `a(end)` in a function: c and a are its variables. Not a
          // chain's field (`s.c{k}`), which is no variable.
          if (!isFunction) break;
          const callee = getChildByField(c, 'name');
          if (callee?.type !== 'identifier') break;
          if (n.type === 'field_expression' && getChildByField(n, 'object')?.id !== c.id) break;
          if (arrayEvidence(c) === 'variable') locals.add(getNodeText(callee, source));
          break;
        }
      }
      walk(c);
    }
  };
  walk(scope);
  return { locals, constructions, structFields };
}

/** A `catch_clause`'s error variable: its identifier on the `catch` keyword's own row. */
function errorVariable(clause: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < clause.namedChildCount; i++) {
    const c = clause.namedChild(i);
    if (!c || c.type === 'comment') continue;
    return c.type === 'identifier' && c.startPosition.row === clause.startPosition.row ? c : null;
  }
  return null;
}

/**
 * The class a variable holds, where every constructor-shaped assignment to it
 * agrees. A Java class's (`m = javax.swing.JFrame()`) is one too, and says
 * that what is called on the variable is Java's: see isJavaClass.
 */
function classHintsFrom(facts: ScopeFacts, isVariable: (name: string) => boolean): ReadonlyMap<string, ClassHint> {
  if (facts.constructions.length === 0) return NO_HINTS;
  const hints = new Map<string, ClassHint>();
  const conflicted = new Set<string>();
  for (const { v, head, cls, bare } of facts.constructions) {
    if (isVariable(head)) continue; // `c = cfg.Make()` on a variable `cfg`: a field's value
    const had = hints.get(v);
    if (had && had.cls !== cls) conflicted.add(v);
    else hints.set(v, { cls, bare: bare && (had?.bare ?? true) });
  }
  for (const v of conflicted) hints.delete(v);
  return hints;
}

/** The single variable a function returns (`obj` in `function obj = Sub(…)`), or null. */
function singleOutput(children: readonly SyntaxNode[], source: string): string | null {
  const out = children.find((c) => c.type === 'function_output');
  if (!out) return null;
  const names = new Set<string>();
  identifiersIn(out, source, names);
  return names.size === 1 ? [...names][0]! : null;
}

/** A function's first parameter, when it is a name (`~` ignores the object: no self). */
function firstParameter(children: readonly SyntaxNode[], source: string): string | null {
  const args = children.find((c) => c.type === 'function_arguments');
  const first = args?.namedChild(0);
  return first?.type === 'identifier' ? getNodeText(first, source) : null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** A reference from the innermost scope, with how it is written (see matlab-ref-facts.ts) in its `candidates`. */
function addRef(
  ctx: ExtractorContext,
  name: string,
  kind: 'calls' | 'function_ref' | 'extends' | 'imports',
  at: SyntaxNode,
  facts: MatlabRefFacts = {},
  /** Where on `at`'s line the name starts, when not where `at` does. */
  column = at.startPosition.column,
): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId || !name) return;
  const candidates = matlabRefCandidates(facts);
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: at.startPosition.row + 1,
    column,
    ...(candidates ? { candidates } : {}),
  });
}

/**
 * What `a.b.m` names, called (`a.b.m(x)`) or as a handle (`@a.b.m`), with
 * `path` = [a, b] the dotted receiver:
 *   - on the method's own object: `Cls::m` (`obj.Prop.m()` is a property's
 *     value — nothing);
 *   - on a variable: through its class when the function says what it holds,
 *     nothing when the function fills that field in itself or made it a
 *     struct, else `v.m`, which the resolver links only to a method no
 *     property shares a name with (deeper, `s.field.m()`, is a field's value);
 *   - else a package path or a class: `pkg.sub.f`, `Cls.staticM`, `pkg.Cls` —
 *     but not Java's (`java.lang.String(…)`, `ArrayList.valueOf` where the
 *     file imports `java.util.ArrayList`): nothing, and nothing either on a
 *     variable that holds a Java object (`m = javax.swing.JFrame(); m.show()`).
 */
function memberRef(path: string[], member: string): MemberRef | null {
  const f = frame();
  const head = path[0]!;
  if (f.self && head === f.self.name) return path.length === 1 ? { name: `${f.self.cls}::${member}` } : null;
  if (isLocal(f, head)) {
    if (path.length !== 1) return null;
    const hint = classHintOf(f, head);
    const field = readsStructField(f, head, member);
    if (hint) {
      if (isJavaClass(hint.cls)) return null;
      return { name: `${hint.cls}::${member}`, ...(hint.bare && !field ? { variable: `${head}.${member}` } : {}) };
    }
    return field ? null : { name: `${head}.${member}` };
  }
  if (isJavaHead(head)) return null;
  return { name: [...path, member].join('::') };
}

/**
 * A member reference: its name, and for one through a bare-name hint (`aa =
 * Archive; aa.getData()` → `Archive::getData`) the variable's own (`aa.getData`),
 * which the resolver takes instead when `Archive` is no class.
 */
interface MemberRef {
  name: string;
  variable?: string;
}

/**
 * `a.b.f(x)` / `obj.m(x)` / `Cls.m(x)`: the reference for the first call in a
 * field chain whose receiver is a plain dotted name. Later calls in a chain
 * (`obj.get().run()`) act on a returned value with no static type — silent,
 * and so is a first call that can only be indexing (`s.data(end)`, `obj.c{k}`).
 */
function fieldChainRef(node: SyntaxNode, source: string): (MemberRef & { at: SyntaxNode }) | null {
  const object = getChildByField(node, 'object');
  if (object?.type !== 'identifier') return null;
  const path = [getNodeText(object, source)];
  for (let i = 1; i < node.namedChildCount; i++) {
    const f = node.namedChild(i);
    if (!f) continue;
    if (f.type === 'identifier') {
      path.push(getNodeText(f, source));
      continue;
    }
    if (f.type !== 'function_call') return null;
    const callee = getChildByField(f, 'name');
    if (callee?.type !== 'identifier' || indexesLikeArray(f)) return null;
    const ref = memberRef(path, getNodeText(callee, source));
    return ref ? { ...ref, at: f } : null;
  }
  return null;
}

/** `@f` / `@pkg.f` / `@obj.m` (`@(x) …` is a lambda node, not this). */
function handleRef(node: SyntaxNode, source: string): MemberRef | null {
  const names = dottedName(node, source);
  if (!names) return null;
  return names.length === 1 ? { name: names[0]! } : memberRef(names.slice(0, -1), names[names.length - 1]!);
}

/**
 * `f(x)` — a call, or an index read on a variable (nothing). `m@Super(obj, …)`
 * calls the superclass's method and `obj@Super(…)` (in a constructor, on its
 * output) the superclass's constructor. `m(obj, …)` whose first argument is
 * the method's own object (`char(obj)`, `rne(robot, …)`), or a variable the
 * function says holds a class (`c = Shape(…); area(c)`), is `Cls::m` with
 * `dispatch` set: MATLAB takes the class's method when it has one, behind the
 * caller's own and imported functions and ahead of the path — the resolver
 * decides from the class. Any other call is a function call, even of a name
 * the class overloads (`char(s, '…')`).
 */
function callRef(node: SyntaxNode, name: string, source: string): { name: string; dispatch: boolean } | null {
  const f = frame();
  const children = namedChildren(node);
  const sup = children.find((c) => c.type === 'superclass');
  if (sup) {
    const base = dottedName(sup, source);
    if (!base) return null;
    const method = isLocal(f, name) ? base[base.length - 1]! : name;
    return { name: [...base, method].join('::'), dispatch: false };
  }
  if (isLocal(f, name)) return null;
  // `ArrayList()` where the file imports `java.util.ArrayList`: Java's constructor.
  if (javaImported.has(name)) return null;
  const firstArg = children.find((c) => c.type === 'arguments')?.namedChild(0);
  const first = firstArg?.type === 'identifier' ? getNodeText(firstArg, source) : null;
  const cls = !first ? undefined : f.self && first === f.self.name ? f.self.cls : classHintOf(f, first)?.cls;
  // On a Java object (`set(m, …)`), the function as written: no class of the project's.
  if (cls && !isJavaClass(cls)) return { name: `${cls}::${name}`, dispatch: true };
  return { name, dispatch: false };
}

/**
 * `run setup_paths` / `run('setup_paths.m')`: the script (or function) run
 * by that name, as a call of it written where the name is. A path
 * (`run('lib/setup')`) or a name built at runtime names nothing the index can
 * tell from here. `holder` is the call's arguments or the command; `statement`
 * whether the `run` is a statement of its own, the only way a script runs.
 */
function runRef(holder: SyntaxNode | undefined, ctx: ExtractorContext, statement: boolean): void {
  const args = holder ? namedChildren(holder).filter((c) => c.type !== 'command_name' && c.type !== 'comment') : [];
  if (args.length !== 1) return;
  const arg = args[0]!;
  const at = arg.type === 'string' ? namedChildren(arg).find((c) => c.type === 'string_content') : arg.type === 'command_argument' ? arg : undefined;
  if (!at) return;
  const m = /^(['"]?)([A-Za-z][A-Za-z0-9_]*)(?:\.[mM])?\1$/.exec(getNodeText(at, ctx.source));
  if (m) addRef(ctx, m[2]!, 'calls', at, { form: statement ? 'statement' : 'bare' }, at.startPosition.column + m[1]!.length);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function functionSignature(node: SyntaxNode, children: readonly SyntaxNode[], source: string): string {
  const args = children.find((c) => c.type === 'function_arguments');
  const name = getChildByField(node, 'name');
  const end = args?.endIndex ?? name?.endIndex ?? node.endIndex;
  const text = source.slice(node.startIndex, end).replace(/\s+/g, ' ').trim();
  return node.type === 'function_signature' && !text.startsWith('function') ? `function ${text}` : text;
}

/** Whether this top-level function is the file's own (the first thing in a function file). */
function isPrimaryFunction(node: SyntaxNode): boolean {
  if (node.parent?.type !== 'source_file') return false;
  for (let s = node.previousNamedSibling; s; s = s.previousNamedSibling) {
    if (s.type !== 'comment') return false;
  }
  return true;
}

/** A classdef `methods` block, read once for all its functions. */
interface MethodsBlock {
  attrs: Map<string, string>;
  /** The class's qualified name, `pkg::Cls`. */
  cls: string;
  /** The class's own name — a method of that name is its constructor. */
  className: string;
}

function extractFunction(node: SyntaxNode, ctx: ExtractorContext, block: MethodsBlock | null = null): void {
  const source = ctx.source;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  let name = getNodeText(nameNode, source);
  const accessor = source.slice(Math.max(0, nameNode.startIndex - 4), nameNode.startIndex);
  if (accessor === 'get.' || accessor === 'set.') name = accessor + name;

  const outer = frame();
  // A function defined inside another one's body shares its workspace.
  const nested = outer.kind === 'function';
  const primary = !block && isPrimaryFunction(node);
  // MATLAB calls a function file by its file name, whatever its first line
  // declares (`foo.m` holding `function bar()` is `foo`; the signature keeps `bar`).
  // A file name that is no identifier (`my-tool.m`, `2go.m`) MATLAB cannot call
  // at all: its primary function keeps the declared name and is not exported,
  // so only its own file reaches it.
  const stem = primary ? matlabFileStem(ctx.filePath) : null;
  if (stem) name = stem;
  const scope = primary ? matlabPathScope(ctx.filePath) : null;
  const classFolder = scope?.classFolder;
  const kind: NodeKind = block || classFolder ? 'method' : 'function';
  const qual = classFolder ? [...scope!.packages, classFolder] : outer.qual;

  const children = namedChildren(node);
  const extra: Partial<Node> = {
    qualifiedName: [...qual, name].join('::'),
    signature: functionSignature(node, children, source),
    docstring: helpText(children, source),
  };
  if (block) {
    const vis = visibilityFrom(block.attrs);
    if (vis) extra.visibility = vis;
    if (block.attrs.get('static') === 'true') extra.isStatic = true;
    if (block.attrs.get('abstract') === 'true') extra.isAbstract = true;
  } else if (kind === 'function') {
    extra.isExported = primary && stem !== null;
  }

  // `@Cls/Cls.m` holding a function is an old-style class's constructor: the
  // folder is the class, which no classdef declares. Its class node stands
  // where the constructor does and contains it (and, through the class-folder
  // pass, the folder's other methods), so `Cls(…)` instantiates the class as
  // it does a classdef's and `@Cls` names the constructor.
  const oldStyleClass = classFolder !== undefined && name === classFolder
    ? ctx.createNode('class', name, node, { qualifiedName: qual.join('::'), docstring: extra.docstring })
    : null;
  if (oldStyleClass) ctx.pushScope(oldStyleClass.id);
  const fn = ctx.createNode(kind, name, node, extra);
  if (!fn || node.type === 'function_signature') {
    if (oldStyleClass) ctx.popScope();
    return; // a declaration: no body to walk
  }

  // The method's own object: a constructor's output, any other non-static
  // method's first parameter. A nested function sees its method's; a local
  // function has none.
  let self: Self | null = null;
  const cls = block ? (block.attrs.get('static') === 'true' ? null : block.cls) : classFolder ? qual.join('::') : null;
  if (cls) {
    const isConstructor = name === (block ? block.className : classFolder);
    const v = isConstructor ? singleOutput(children, source) : firstParameter(children, source);
    if (v) self = { name: v, cls };
  } else if (nested) {
    self = outer.self;
  }

  const facts = scanScope(node, source, true);
  const parent = nested ? outer : null;
  const f: Frame = {
    kind: 'function',
    qual: [...qual, name],
    locals: facts.locals,
    classHints: classHintsFrom(facts, (v) => facts.locals.has(v) || (parent !== null && isLocal(parent, v))),
    structFields: facts.structFields,
    self,
    parent,
  };

  ctx.pushScope(fn.id);
  inFrame(f, () => {
    for (const c of children) {
      if (c.type === 'block' || c.type === 'arguments_statement' || c.type === 'function_definition') ctx.visitNode(c);
    }
  });
  ctx.popScope();
  if (oldStyleClass) ctx.popScope();
}

function extractClass(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, source);
  const children = namedChildren(node);
  const isEnum = children.some((c) => c.type === 'enumeration' && namedChildren(c).some((e) => e.type === 'enum'));
  const attrs = attributesOf(node, source);
  const attrsNode = leadingAttributes(node);

  const supers = children.find((c) => c.type === 'superclasses');
  const bases = supers
    ? namedChildren(supers)
        .filter((c) => c.type === 'property_name')
        .map((c) => namedChildren(c).map((i) => getNodeText(i, source)).join('.'))
    : [];
  // Written from the AST, so a superclass list over several lines (with
  // `...` continuations and comments) reads `classdef X < A & B` — the
  // resolver finds inherited methods through it.
  const signature = [
    'classdef',
    ...(attrsNode ? [getNodeText(attrsNode, source).replace(/\s+/g, ' ').trim()] : []),
    name,
    ...(bases.length > 0 ? ['<', bases.join(' & ')] : []),
  ].join(' ');

  const qual = [...frame().qual, name];
  const cls = ctx.createNode(isEnum ? 'enum' : 'class', name, node, {
    qualifiedName: qual.join('::'),
    docstring: helpText(children, source),
    signature,
    ...(attrs.get('abstract') === 'true' ? { isAbstract: true } : {}),
  });
  if (!cls) return;

  const classFrame: Frame = { kind: 'class', qual, locals: EMPTY, classHints: NO_HINTS, structFields: EMPTY, self: null, parent: null };
  ctx.pushScope(cls.id);
  inFrame(classFrame, () => {
    for (const base of bases) {
      if (!BUILTIN_BASES.test(base)) addRef(ctx, base.replace(/\./g, '::'), 'extends', supers!);
    }
    for (const section of children) {
      if (section.type === 'properties') {
        const sectionAttrs = attributesOf(section, source);
        const constant = sectionAttrs.get('constant') === 'true';
        const vis = visibilityFrom(sectionAttrs);
        for (const prop of namedChildren(section)) {
          if (prop.type !== 'property') continue;
          const propName = getChildByField(prop, 'name');
          if (!propName) continue;
          const pname = getNodeText(propName, source);
          ctx.createNode(constant ? 'constant' : 'property', pname, prop, {
            qualifiedName: [...qual, pname].join('::'),
            signature: getNodeText(prop, source).replace(/\s+/g, ' ').trim(),
            ...(vis ? { visibility: vis } : {}),
          });
          const dflt = namedChildren(prop).find((c) => c.type === 'default_value');
          if (dflt) ctx.visitNode(dflt);
        }
      } else if (section.type === 'enumeration') {
        for (const member of namedChildren(section)) {
          if (member.type !== 'enum') continue;
          const id = namedChildren(member).find((c) => c.type === 'identifier');
          if (id) {
            const mname = getNodeText(id, source);
            ctx.createNode('enum_member', mname, member, { qualifiedName: [...qual, mname].join('::') });
          }
        }
      } else if (section.type === 'methods') {
        const block: MethodsBlock = { attrs: attributesOf(section, source), cls: qual.join('::'), className: name };
        for (const m of namedChildren(section)) {
          if (m.type === 'function_definition' || m.type === 'function_signature') extractFunction(m, ctx, block);
        }
      }
    }
  });
  ctx.popScope();
}

function extractImport(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const arg of namedChildren(node)) {
    if (arg.type !== 'command_argument') continue;
    const target = getNodeText(arg, ctx.source).trim();
    if (!/^[A-Za-z_][\w.]*(?:\.\*)?$/.test(target)) continue;
    ctx.createNode('import', target, node, { signature: getNodeText(node, ctx.source).trim().slice(0, 100) });
    // `import pkg.*` names a package, and no node stands for one: the import
    // node is all there is (the resolver reads it for the names it brings in).
    // So does `import java.util.ArrayList`: Java's, never the project's.
    if (!target.endsWith('.*') && !isJavaImport(target)) {
      addRef(ctx, target.replace(/\./g, '::'), 'imports', arg);
    }
  }
}

/** A script's top level, or a function file's (its code outside every function is a script's). */
function extractFile(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  javaImported = javaImportsOf(node, source);
  try {
    const facts = scanScope(node, source, false);
    const f: Frame = {
      kind: 'file',
      qual: matlabPathScope(ctx.filePath).packages,
      locals: facts.locals,
      classHints: classHintsFrom(facts, (v) => facts.locals.has(v)),
      structFields: facts.structFields,
      self: null,
      parent: null,
    };
    inFrame(f, () => {
      for (const c of namedChildren(node)) ctx.visitNode(c);
    });
  } finally {
    javaImported = EMPTY;
    arrayEvidenceMemo = new Map();
  }
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export const matlabExtractor: LanguageExtractor = {
  functionTypes: [], // function_definition is a function, method, nested or local function — decided in visitNode
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [], // `f(x)` is a call or an index read — decided in visitNode
  variableTypes: [],
  nameField: 'name',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    const source = ctx.source;
    // The file's root — `source_file`, or `ERROR` when the parse failed at the
    // top (as an Octave file with a `##` header often does). Octave is
    // unsupported: its file node, nothing read from it.
    if (!node.parent) {
      if (!isOctave(source)) extractFile(node, ctx);
      return true;
    }
    switch (node.type) {
      case 'class_definition':
        extractClass(node, ctx);
        return true;

      case 'function_definition':
      case 'function_signature':
        extractFunction(node, ctx);
        return true;

      case 'lambda': {
        // `@(x) …`: its parameters are variables in its body only, and hide
        // any variable (or own object) of the same name around it.
        const outer = frame();
        const params = new Set<string>();
        const children = namedChildren(node);
        const args = children.find((c) => c.type === 'arguments');
        if (args) identifiersIn(args, source, params);
        const self = outer.self && params.has(outer.self.name) ? null : outer.self;
        const lambda: Frame = { kind: 'lambda', qual: outer.qual, locals: params, classHints: NO_HINTS, structFields: EMPTY, self, parent: outer };
        inFrame(lambda, () => {
          for (const c of children) if (c.type !== 'arguments') ctx.visitNode(c);
        });
        return true;
      }

      case 'function_call': {
        const parent = node.parent;
        // A field of a chain (`pkg.f(x)`, `obj.m()`): the field_expression owns it.
        if (parent?.type === 'field_expression' && getChildByField(parent, 'object')?.id !== node.id) return false;
        // `x(k) = …`, `[y, x(k)] = …` assign into x.
        if (isAssignmentTarget(node)) return false;
        const callee = getChildByField(node, 'name');
        // `x(:, 2)`, `a(end)`, `c{k}`: x, a and c hold arrays.
        if (callee?.type !== 'identifier' || indexesLikeArray(node)) return false;
        const written = getNodeText(callee, source);
        const ref = callRef(node, written, source);
        // Written with arguments: the list right after the name. Not where a
        // parse that recovered from an error put something else between
        // (`Tune = (0.2, 0.1)` in a notes file read as MATLAB).
        const form = callee.nextSibling?.type === '(' ? undefined : 'bare';
        if (ref) addRef(ctx, ref.name, 'calls', node, { ...(ref.dispatch ? { dispatch: written } : {}), ...(form ? { form } : {}) });
        if (ref?.name === 'run') runRef(namedChildren(node).find((c) => c.type === 'arguments'), ctx, isStatement(node));
        return false; // arguments still walked
      }

      case 'field_expression': {
        // `s.f(k) = …` writes a field; `Q2.Setpoint.P` in `AO.Q2.Setpoint.P{1}(6, :)` is no chain of its own.
        if (isAssignmentTarget(node) || isInnerChain(node)) return false;
        const ref = fieldChainRef(node, source);
        if (ref) addRef(ctx, ref.name, 'calls', ref.at, ref.variable ? { variable: ref.variable } : {});
        return false;
      }

      case 'identifier': {
        // A bare name read as a value is a zero-argument call when it is no variable: `t = loadConfig;`.
        const parent = node.parent;
        if (!parent) return false;
        // `catch⏎ cleanupAll`: a statement of its own, not the error variable.
        const statement = parent.type === 'catch_clause' && errorVariable(parent)?.id !== node.id;
        const asValue =
          statement ||
          VALUE_PARENTS.has(parent.type) ||
          (parent.type === 'assignment' && getChildByField(parent, 'right')?.id === node.id) ||
          // `if isReady`, `while keepGoing`, `switch mode`, `case modeA`: the condition.
          (CONDITION_PARENTS.has(parent.type) && getChildByField(parent, 'condition')?.id === node.id) ||
          // `for k = getRange`: the range, not the loop variable.
          (parent.type === 'iterator' && parent.namedChild(0)?.id !== node.id) ||
          // `go(x, Solver=1)`: `Solver` names the argument.
          (parent.type === 'arguments' && parent.parent?.type === 'function_call' && node.nextSibling?.type !== '=');
        if (!asValue) return false;
        const name = getNodeText(node, source);
        if (!isLocal(frame(), name) && !javaImported.has(name)) addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare' });
        return false;
      }

      case 'command': {
        const cmd = namedChildren(node).find((c) => c.type === 'command_name');
        if (!cmd) return true;
        const name = getNodeText(cmd, source);
        if (name === 'import') extractImport(node, ctx);
        else if (!isLocal(frame(), name)) {
          // `setup_paths`: a statement of its own; `hold on` takes arguments.
          // (`setup_paths ;` reads with an empty argument, which is none.)
          const statement = !namedChildren(node).some((c) => c.type === 'command_argument' && getNodeText(c, source).trim() !== '');
          addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare' });
          if (name === 'run') runRef(node, ctx, true);
        }
        return true;
      }

      case 'handle_operator': {
        const target = handleRef(node, source);
        if (target) addRef(ctx, target.name, 'function_ref', node, target.variable ? { variable: target.variable } : {});
        return true;
      }
    }
    return false;
  },
};
