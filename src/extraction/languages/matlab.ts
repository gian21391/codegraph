import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import { matlabPathScope } from './matlab-path';
import { isOctave } from './matlab-syntax';

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
 *                 that class.
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
 *                 VARIABLE there — MATLAB decides that per function,
 *                 statically — so `x(3)` on one is an index read and emits
 *                 nothing. `obj.m()` and `m(obj, …)` on a method's own object
 *                 (its first parameter; a constructor's output) are `Cls::m`;
 *                 on a variable the function assigns from a constructor
 *                 (`c = pkg.Cls(…)`) it is `pkg::Cls::m` (the function-syntax
 *                 form carries the written `m` too: MATLAB may take a function
 *                 of that name first, or after the class lacks the method);
 *                 `v.m()` on any other variable is `v.m`, which the resolver
 *                 links only to an unambiguous method (a struct field indexed
 *                 reads the same, and one the function itself fills in emits
 *                 nothing). The
 *                 hottest built-ins (`size`, `zeros`, `pi`, …) are not
 *                 recorded at all: see MATLAB_BUILTINS.
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
  /^(?:handle|dynamicprops|hgsetget|matlab\..*|matlab|double|single|logical|char|u?int(?:8|16|32|64))$/;

/**
 * The hottest MATLAB built-ins, never recorded as a bare call: they would
 * stay unresolved refs in every function that uses them (on PlatEMO, the
 * most-called names here are most of the unresolved refs, and over half the
 * database). Core MATLAB only — no toolbox function, nothing a project
 * commonly defines itself (`load`, `set`, `delete`, `plot`), nor `char` /
 * `class`, which classes overload and call bare on other values. A project MAY
 * shadow one (`size.m` on its path) — calls to that are lost, the price of
 * the set. Only a bare call is skipped: `numel(obj)` on a method's own object
 * is `Cls::numel` (a class's overload) and is kept, so is `disp(c)` on a
 * variable the function says holds a class (see callRef), and so is `@size`.
 */
const MATLAB_BUILTINS: ReadonlySet<string> = new Set([
  // constants and argument counts
  'pi', 'true', 'false', 'Inf', 'inf', 'NaN', 'nan', 'eps', 'nargin', 'nargout',
  // array construction and shape
  'size', 'length', 'numel', 'isscalar', 'zeros', 'ones', 'eye', 'rand', 'randn', 'randi', 'randperm',
  'repmat', 'reshape', 'cat', 'linspace', 'meshgrid', 'cell', 'struct', 'deal',
  'transpose', 'fliplr', 'diag', 'full', 'sparse', 'cell2mat',
  // arithmetic, reductions and sets
  'sum', 'prod', 'cumsum', 'cumprod', 'mean', 'std', 'max', 'min', 'abs', 'sqrt', 'exp', 'log', 'sin', 'cos',
  'acos', 'asin', 'atan', 'real', 'imag', 'conj', 'floor', 'ceil', 'round', 'mod', 'rem', 'sign', 'norm',
  'sort', 'sortrows', 'unique', 'setdiff', 'intersect', 'ismember', 'any', 'all', 'find',
  // predicates and conversion
  'isempty', 'isfield', 'isnumeric', 'ischar', 'iscell', 'isstruct', 'isnan', 'isinf', 'isa',
  'isequal', 'strcmp', 'strcmpi', 'num2str', 'str2double', 'sprintf', 'double', 'logical', 'fieldnames',
  'func2str', 'feval', 'cellfun', 'arrayfun', 'fullfile', 'fileparts', 'mfilename', 'exist',
  // output and errors
  'disp', 'fprintf', 'error', 'warning', 'assert', 'rethrow',
]);

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

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
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

/** Attribute names (lowercased) of a node's leading `attributes`, with their values: `Access = private` → access→private, `Static` → static→true. */
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
function helpText(node: SyntaxNode, source: string): string | undefined {
  const comment = namedChildren(node).find((c) => c.type === 'comment');
  if (!comment) return undefined;
  const text = getNodeText(comment, source)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*%[{}]?\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return text || undefined;
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
  classHints: ReadonlyMap<string, string>;
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
const NO_HINTS: ReadonlyMap<string, string> = new Map();

/**
 * The walk's frames. Pushed and popped around each scope's children within
 * one synchronous extraction, so it is empty between files — no state outlives
 * the file it was computed for.
 */
const frames: Frame[] = [];

/** Outside every frame (only if a walk ever starts below the file's root): nothing in scope. */
const NO_FRAME: Frame = { kind: 'file', qual: [], locals: EMPTY, classHints: NO_HINTS, structFields: EMPTY, self: null, parent: null };

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
function classHintOf(f: Frame, v: string): string | undefined {
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
  /** `v = Cls(…)` / `v = pkg.Cls(…)`: the variable, the callee's head (which must be no variable), and the class it names. */
  constructions: Array<{ v: string; head: string; cls: string }>;
  structFields: Set<string>;
}

/** The variables of `scope` (a function_definition or a script's source_file) and what its assignments say about them — one walk, its nested functions excluded. */
function scanScope(scope: SyntaxNode, source: string): ScopeFacts {
  const locals = new Set<string>();
  const constructions: ScopeFacts['constructions'] = [];
  const structFields = new Set<string>();

  /** `Cls(…)` / `pkg.Cls(…)` (MATLAB names classes in UpperCamelCase): [head, class] — a capitalised callee that is no variable reads as a constructor. */
  const constructed = (rhs: SyntaxNode | null): [string, string] | null => {
    if (rhs?.type === 'function_call') {
      const name = getChildByField(rhs, 'name');
      const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
      return /^[A-Z]/.test(text) ? [text, text] : null;
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
            if (made) constructions.push({ v, head: made[0], cls: made[1] });
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

/** The class a variable holds, where every constructor-shaped assignment to it agrees. */
function classHintsFrom(facts: ScopeFacts, isVariable: (name: string) => boolean): ReadonlyMap<string, string> {
  if (facts.constructions.length === 0) return NO_HINTS;
  const hints = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const { v, head, cls } of facts.constructions) {
    if (isVariable(head)) continue; // `c = cfg.Make()` on a variable `cfg`: a field's value
    if (hints.has(v) && hints.get(v) !== cls) conflicted.add(v);
    else hints.set(v, cls);
  }
  for (const v of conflicted) hints.delete(v);
  return hints;
}

/** The single variable a function returns (`obj` in `function obj = Sub(…)`), or null. */
function singleOutput(fn: SyntaxNode, source: string): string | null {
  const out = namedChildren(fn).find((c) => c.type === 'function_output');
  if (!out) return null;
  const names = new Set<string>();
  identifiersIn(out, source, names);
  return names.size === 1 ? [...names][0]! : null;
}

/** A function's first parameter, when it is a name (`~` ignores the object: no self). */
function firstParameter(fn: SyntaxNode, source: string): string | null {
  const args = namedChildren(fn).find((c) => c.type === 'function_arguments');
  const first = args?.namedChild(0);
  return first?.type === 'identifier' ? getNodeText(first, source) : null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * `written` is set on a function-syntax call that dispatches on its first
 * argument (`m(obj, …)` → `Cls::m`): the name as written, which MATLAB looks up
 * as a function before the class's methods and after them on the path. It
 * rides in the ref's `candidates`; a dotted `obj.m()` carries none and reaches
 * the class's method or nothing.
 */
function addRef(ctx: ExtractorContext, name: string, kind: 'calls' | 'function_ref' | 'extends' | 'imports', at: SyntaxNode, written?: string): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId || !name) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
    ...(written ? { candidates: [written] } : {}),
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
 *   - else a package path or a class: `pkg.sub.f`, `Cls.staticM`, `pkg.Cls`.
 */
function memberRef(path: string[], member: string): string | null {
  const f = frame();
  const head = path[0]!;
  if (f.self && head === f.self.name) return path.length === 1 ? `${f.self.cls}::${member}` : null;
  if (isLocal(f, head)) {
    if (path.length !== 1) return null;
    const cls = classHintOf(f, head);
    if (cls) return `${cls}::${member}`;
    if (readsStructField(f, head, member)) return null;
    return `${head}.${member}`;
  }
  return [...path, member].join('::');
}

/**
 * `a.b.f(x)` / `obj.m(x)` / `Cls.m(x)`: the reference for the first call in a
 * field chain whose receiver is a plain dotted name. Later calls in a chain
 * (`obj.get().run()`) act on a returned value with no static type — silent.
 */
function fieldChainRef(node: SyntaxNode, source: string): { name: string; at: SyntaxNode } | null {
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
    if (callee?.type !== 'identifier') return null;
    const name = memberRef(path, getNodeText(callee, source));
    return name ? { name, at: f } : null;
  }
  return null;
}

/** `@f` / `@pkg.f` / `@obj.m` (`@(x) …` is a lambda node, not this). */
function handleRef(node: SyntaxNode, source: string): string | null {
  const names = dottedName(node, source);
  if (!names) return null;
  return names.length === 1 ? names[0]! : memberRef(names.slice(0, -1), names[names.length - 1]!);
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
 * the class overloads (`char(s, '…')`); a hot built-in (MATLAB_BUILTINS) is
 * then no call worth recording.
 */
function callRef(node: SyntaxNode, name: string, source: string): { name: string; dispatch: boolean } | null {
  const f = frame();
  const sup = namedChildren(node).find((c) => c.type === 'superclass');
  if (sup) {
    const base = dottedName(sup, source);
    if (!base) return null;
    const method = isLocal(f, name) ? base[base.length - 1]! : name;
    return { name: [...base, method].join('::'), dispatch: false };
  }
  if (isLocal(f, name)) return null;
  const firstArg = namedChildren(node).find((c) => c.type === 'arguments')?.namedChild(0);
  const first = firstArg?.type === 'identifier' ? getNodeText(firstArg, source) : null;
  const cls = !first ? undefined : f.self && first === f.self.name ? f.self.cls : classHintOf(f, first);
  if (cls) return { name: `${cls}::${name}`, dispatch: true };
  return MATLAB_BUILTINS.has(name) ? null : { name, dispatch: false };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function functionSignature(node: SyntaxNode, source: string): string {
  const args = namedChildren(node).find((c) => c.type === 'function_arguments');
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
  const stem = primary ? /^([A-Za-z][A-Za-z0-9_]*)\.m$/.exec(ctx.filePath.replace(/^.*[\\/]/, '')) : null;
  if (stem) name = stem[1]!;
  const scope = primary ? matlabPathScope(ctx.filePath) : null;
  const classFolder = scope?.classFolder;
  const kind: NodeKind = block || classFolder ? 'method' : 'function';
  const qual = classFolder ? [...scope!.packages, classFolder] : outer.qual;

  const extra: Partial<Node> = {
    qualifiedName: [...qual, name].join('::'),
    signature: functionSignature(node, source),
    docstring: helpText(node, source),
  };
  if (block) {
    const vis = visibilityFrom(block.attrs);
    if (vis) extra.visibility = vis;
    if (block.attrs.get('static') === 'true') extra.isStatic = true;
    if (block.attrs.get('abstract') === 'true') extra.isAbstract = true;
  } else if (kind === 'function') {
    extra.isExported = primary && stem !== null;
  }

  const fn = ctx.createNode(kind, name, node, extra);
  if (!fn || node.type === 'function_signature') return; // a declaration: no body to walk

  // The method's own object: a constructor's output, any other non-static
  // method's first parameter. A nested function sees its method's; a local
  // function has none.
  let self: Self | null = null;
  const cls = block ? (block.attrs.get('static') === 'true' ? null : block.cls) : classFolder ? qual.join('::') : null;
  if (cls) {
    const isConstructor = name === (block ? block.className : classFolder);
    const v = isConstructor ? singleOutput(node, source) : firstParameter(node, source);
    if (v) self = { name: v, cls };
  } else if (nested) {
    self = outer.self;
  }

  const facts = scanScope(node, source);
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
    for (const c of namedChildren(node)) {
      if (c.type === 'block' || c.type === 'arguments_statement' || c.type === 'function_definition') ctx.visitNode(c);
    }
  });
  ctx.popScope();
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

  const outer = frame();
  const cls = ctx.createNode(isEnum ? 'enum' : 'class', name, node, {
    qualifiedName: [...outer.qual, name].join('::'),
    docstring: helpText(node, source),
    signature,
    ...(attrs.get('abstract') === 'true' ? { isAbstract: true } : {}),
  });
  if (!cls) return;

  const qual = [...outer.qual, name];
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
    if (!target.endsWith('.*')) addRef(ctx, target.replace(/\./g, '::'), 'imports', arg);
  }
}

/** A script's top level, or a function file's (its code outside every function is a script's). */
function extractFile(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const facts = scanScope(node, source);
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
  // Not fields in this grammar (its fields are argument, arguments, condition,
  // expression, field, left, name, object, operand, right; `block` and
  // `function_arguments` are node types). Unread: every definition goes
  // through visitNode, never the generic extraction these configure.
  bodyField: 'block',
  paramsField: 'function_arguments',

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
        const args = namedChildren(node).find((c) => c.type === 'arguments');
        if (args) identifiersIn(args, source, params);
        const self = outer.self && params.has(outer.self.name) ? null : outer.self;
        const lambda: Frame = { kind: 'lambda', qual: outer.qual, locals: params, classHints: NO_HINTS, structFields: EMPTY, self, parent: outer };
        inFrame(lambda, () => {
          for (const c of namedChildren(node)) if (c.type !== 'arguments') ctx.visitNode(c);
        });
        return true;
      }

      case 'function_call': {
        const parent = node.parent;
        // A field of a chain (`pkg.f(x)`, `obj.m()`): the field_expression owns it.
        if (parent?.type === 'field_expression' && getChildByField(parent, 'object')?.id !== node.id) return false;
        // `x(k) = …` assigns into x.
        if (parent?.type === 'assignment' && getChildByField(parent, 'left')?.id === node.id) return false;
        const callee = getChildByField(node, 'name');
        if (callee?.type !== 'identifier') return false;
        const written = getNodeText(callee, source);
        const ref = callRef(node, written, source);
        if (ref) addRef(ctx, ref.name, 'calls', node, ref.dispatch ? written : undefined);
        return false; // arguments still walked
      }

      case 'field_expression': {
        if (node.parent?.type === 'assignment' && getChildByField(node.parent, 'left')?.id === node.id) return false;
        const ref = fieldChainRef(node, source);
        if (ref) addRef(ctx, ref.name, 'calls', ref.at);
        return false;
      }

      case 'identifier': {
        // A bare name read as a value is a zero-argument call when it is no variable: `t = loadConfig;`.
        const parent = node.parent;
        if (!parent) return false;
        const asValue =
          VALUE_PARENTS.has(parent.type) ||
          (parent.type === 'assignment' && getChildByField(parent, 'right')?.id === node.id) ||
          // `go(x, Solver=1)`: `Solver` names the argument.
          (parent.type === 'arguments' && parent.parent?.type === 'function_call' && node.nextSibling?.type !== '=') ||
          // `catch⏎ cleanupAll`: a statement of its own, not the error variable.
          (parent.type === 'catch_clause' && errorVariable(parent)?.id !== node.id);
        if (!asValue) return false;
        const name = getNodeText(node, source);
        if (!MATLAB_BUILTINS.has(name) && !isLocal(frame(), name)) addRef(ctx, name, 'calls', node);
        return false;
      }

      case 'command': {
        const cmd = namedChildren(node).find((c) => c.type === 'command_name');
        if (!cmd) return true;
        const name = getNodeText(cmd, source);
        if (name === 'import') extractImport(node, ctx);
        else if (!MATLAB_BUILTINS.has(name) && !isLocal(frame(), name)) addRef(ctx, name, 'calls', node);
        return true;
      }

      case 'handle_operator': {
        const target = handleRef(node, source);
        if (target) addRef(ctx, target, 'function_ref', node);
        return true;
      }
    }
    return false;
  },
};
