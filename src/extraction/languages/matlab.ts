import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Node, NodeKind, UnresolvedReference } from '../../types';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import { getParser } from '../grammars';
import { matlabFileStem, matlabPathScope } from './matlab-path';
import { isOctave } from './matlab-syntax';
import { MATLAB_BUILTINS, MATLAB_CELLFUN_NAMES } from './matlab-builtins';
import { JAVA_PACKAGE_ROOTS, isJavaImport } from './matlab-java';
import { COMPUTED_TAG, MATLAB_ARG_PLACES, RUNTIME_TAG, argItemsOf, isMatlabArgsCandidate, matlabRefCandidates, spreadItem, type MatlabArgValue, type MatlabCallArgs, type MatlabRefFacts } from './matlab-ref-facts';
import { GuardScope, type MatlabGuard } from './matlab-guards';
import {
  HOLE,
  MAX_TEXT,
  NAME_SHAPED,
  argValue,
  bracesIndex,
  callArgs,
  callersUnknown,
  chainHead,
  commandItems,
  errorVariable,
  evaluate,
  fieldOf,
  isColonIndex,
  isOneBuiltStruct,
  literalIndex,
  namedChildren,
  parseSymPath,
  stringLiteral,
  templateOf,
  type FnVal,
  type Val,
} from './matlab-values';
import {
  CALLBACK_PROPERTY,
  NO_VALUES,
  SINK_WORDS,
  interpretScope,
  isWasmMemoryError,
  loadedNames,
  sinkInputs,
  type InterpHost,
  type ParsedCode,
  type ScopeOptions,
  type ScopeValues,
} from './matlab-interp';

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
 *                 emits nothing. Written without parentheses (`m.reset;`,
 *                 `s = Model.make;`) a member is a call too on the method's
 *                 own object, a constructed variable, or a class or package
 *                 name — never on another variable, where it is a struct's
 *                 field. How each was written (with arguments, bare,
 *                 as a statement, the name a dispatched call was written
 *                 with) rides along: see matlab-ref-facts.ts. A built-in's
 *                 name is recorded like any other: whether a project function
 *                 of that name is what it reaches is the resolver's to say
 *                 (see MATLAB_BUILTINS).
 *   - handles:    `@f` / `@pkg.f` / `@obj.m` are function references
 *                 (callbacks: `cellfun(@f, …)`, `'Callback', @onClick`).
 *   - names given as text: what each function's code holds is followed
 *                 statement by statement (see matlab-interp.ts), so that
 *                 `feval(m, …)` calls each function `m` can name there,
 *                 `fh(x)` calls what the handle `fh` can hold, and
 *                 `str2func('f')` / `cellfun('f', c)` reference `f`. Code
 *                 given as text is read as code: what `eval` / `evalc` run
 *                 (where they are), what `evalin` runs, and a GUI callback
 *                 written as text to one of MATLAB's GUI functions
 *                 (`uicontrol('Callback', 'corgui(''ShowResp'')')`,
 *                 `h.Callback = 'go'`), which, run later on an event,
 *                 references what it calls. A name with a part nothing here
 *                 knows (`eval([op '(''x'')'])`) is no reference. A name
 *                 eval'd code assigns or `load(f, 'a', 'b')` makes is, in a
 *                 function, still called as MATLAB would (it reads the
 *                 function's names from its code), marked as made at
 *                 runtime, as is every name of code run in another
 *                 workspace: the resolver drops one nothing answers. In a
 *                 script such a name is a variable. `S = load(f)` is a
 *                 struct.
 *   - what calls pass: a call of a function written with arguments records
 *                 what each argument holds where the code says (the
 *                 `args` fact, see matlab-ref-facts.ts), and
 *                 matlabParamSinks finds where a function calls what its
 *                 caller passes (`feval(regr, S)`), and under which tests
 *                 of what the caller passed (matlab-guards.ts): the two
 *                 halves ../../resolution/matlab-argument-synthesizer.ts
 *                 joins. A parameter passed on under such a test is not
 *                 recorded.
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
  /**
   * Whose view: a function's, a lambda's, a class body's, the file's top
   * level, or code given as text that `eval` runs where it is (which sees
   * that code's variables, and what it assigns besides).
   */
  kind: 'function' | 'lambda' | 'class' | 'file' | 'eval';
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
  /**
   * What the dynamic calls of a function's (or a script's) code read, by
   * node (see matlab-interp.ts): set once the scope is interpreted, before
   * its walk. A lambda reads its enclosing code's; code given as text has
   * none of its own (another tree) and reads its literals only.
   */
  values?: ScopeValues;
  /**
   * In a function, the names code it runs as text (`eval('x = 3;')`) or a
   * `load` name list makes at runtime. MATLAB reads the function's names
   * from its own code before it runs, so such a name is still a function
   * where it is called (`if …, eval('f = @g;'), end; f(1)` calls `f.m`);
   * its references carry the `runtime` fact (see matlab-ref-facts.ts), which
   * lets the resolver drop one nothing answers.
   */
  runtime?: ReadonlySet<string>;
  /**
   * A function's parameters in order (null for an ignored `~`), when each
   * holds what the caller passed (see Sym in matlab-values.ts): a function's
   * own, not a nested one's (it shares its workspace), not a lambda's.
   */
  params?: readonly (string | null)[];
  /** Where the function is defined (`line:column` of its first line, 1-based line): the key its parameter sinks are listed under. */
  site?: string;
  /** Its parameters passed on unchanged wherever read (see forwardable). */
  forwards?: ReadonlySet<string>;
  /** Its parameters it never writes to, nor into (see isUntouchedParameter). */
  untouchedParams?: ReadonlySet<string>;
  /** Its definition, which the conditions of its sinks and calls are read from (see guardScope). */
  def?: SyntaxNode;
  /** Those conditions, read when first asked for (see guardScope). */
  guards?: GuardScope;
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
  while (g.kind === 'lambda' || g.kind === 'eval') {
    // What eval'd code assigns hides what the code around it said.
    const own = g.classHints.get(v);
    if (own) return own;
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
    else if (g.kind === 'eval' && g.locals.has(v)) return false;
  }
  return false;
}

/** Whether `name` is one code run at runtime made where frame `f` reads it (see Frame.runtime), and no variable there. */
function isRuntimeName(f: Frame, name: string): boolean {
  if (isLocal(f, name)) return false;
  for (let g: Frame | null = f; g; g = g.parent) if (g.runtime?.has(name)) return true;
  return false;
}

/** The facts of a bare reference to `name` from frame `f`: `runtime` when code run at runtime made the name (see Frame.runtime). */
function runtimeFact(f: Frame, name: string): MatlabRefFacts {
  return isRuntimeName(f, name) ? { runtime: true } : {};
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
  /** The code arguments of the `eval` / `evalc` calls here (`eval(code, catchCode)`), with the name called. */
  evalCodes: Array<{ callee: string; arg: SyntaxNode }>;
  /** The names `load(f, 'a', 'b')` / `load f a b` statements here make (in a script, variables too). */
  loaded: Set<string>;
  /** Every name written here: assigned, indexed or field-assigned into, a loop's, a `catch`'s, a global. */
  assigned: Set<string>;
  /** The names written here from a value the interpreter may know of itself: a text, a handle, a cell, a struct, a text built. */
  valued: Set<string>;
  /** `x = y`, `x = y.f`, `x = y{k}`: [x, y], x known when y is (see knownNames). */
  copies: Array<[string, string]>;
  /** The variables (heads of `v` / `v.f`) passed to a call that is no built-in's. */
  passed: Set<string>;
  /** Whether something here may set names it does not spell: `load`, `clear`, `eval`, `run`, a statement that may run a script. */
  clobbers: boolean;
  /** Whether functions are nested in it, which share its variables. */
  nested: boolean;
}

/** Calls that may set names the code does not spell: a `load`, a `clear`, code run by `eval`, a script `run`. */
const CLOBBERING_CALL = /^(?:load|clear|clearvars|eval|evalc|evalin|run)$/;

/** Calls whose value the interpreter computes (see evaluateCall in matlab-values.ts). */
const VALUE_CALLS = /^(?:struct|strcat|sprintf|upper|lower|strtrim|deblank|char|func2str|str2func|mfilename)$/;

/**
 * The variables of `scope` (a function_definition or a script's source_file)
 * and what its assignments say about them — one walk, its nested functions
 * excluded. In a function, a name indexed as only an array can be (`c{k}`,
 * `a(end)`: see arrayEvidence) is one of its variables too — MATLAB decides
 * that per function, so every use of it there, before or after, is one. A
 * script's workspace is the caller's, and what a name is there may change
 * between its lines: there the evidence holds at its own site only.
 * `load(f, 'a', 'b')` / `load f a b` as a statement makes `a` and `b` —
 * variables of a script, and in a function names made at runtime (see
 * Frame.runtime) — and `S = load(f)` makes S a struct (`S.k(2)` reads a
 * field).
 */
function scanScope(scope: SyntaxNode, source: string, isFunction: boolean): ScopeFacts {
  const locals = new Set<string>();
  const constructions: ScopeFacts['constructions'] = [];
  const structFields = new Set<string>();
  const evalCodes: ScopeFacts['evalCodes'] = [];
  const loaded = new Set<string>();
  const assigned = new Set<string>();
  const valued = new Set<string>();
  const copies: ScopeFacts['copies'] = [];
  const passed = new Set<string>();
  let clobbers = false;
  let nested = false;

  /**
   * What an assignment's right side may be known as (see ScopeFacts): a
   * value of itself, a copy of another variable (its head), or nothing.
   */
  const valueish = (rhs: SyntaxNode | null): 'value' | SyntaxNode | null => {
    if (!rhs) return null;
    switch (rhs.type) {
      case 'string':
      case 'handle_operator':
      case 'cell':
        return 'value';
      case 'identifier':
      case 'field_expression':
        return chainHead(rhs);
      case 'matrix':
        return /['"]/.test(getNodeText(rhs, source)) ? 'value' : null;
      case 'function_call': {
        const name = getChildByField(rhs, 'name');
        if (name?.type !== 'identifier') return null;
        if (VALUE_CALLS.test(getNodeText(name, source))) return 'value';
        return arrayEvidence(rhs) === 'variable' ? name : null;
      }
    }
    return null;
  };
  /** Notes `node`'s head as written, from `rhs`. */
  const written = (node: SyntaxNode | null, rhs: SyntaxNode | null): void => {
    const head = chainHead(node);
    if (!head) return;
    const name = getNodeText(head, source);
    assigned.add(name);
    const from = valueish(rhs);
    if (from === 'value') valued.add(name);
    else if (from) copies.push([name, getNodeText(from, source)]);
  };

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
          nested = true;
          continue;
        case 'class_definition':
        case 'lambda': // its parameters are its own; it assigns nothing
          continue;
        case 'function_output':
        case 'function_arguments':
          identifiersIn(c, source, locals);
          continue;
        case 'global_operator':
        case 'persistent_operator':
          identifiersIn(c, source, locals);
          identifiersIn(c, source, assigned);
          continue;
        case 'identifier':
          // `setup_vars`: a statement that may run a script.
          if ((n.type === 'block' || n.type === 'source_file') && !MATLAB_BUILTINS.has(getNodeText(c, source))) clobbers = true;
          break;
        case 'assignment': {
          const left = getChildByField(c, 'left');
          const right = getChildByField(c, 'right');
          if (left?.type === 'multioutput_variable') for (const out of namedChildren(left)) written(out, null);
          else written(left, right);
          if (left?.type === 'identifier') {
            const v = getNodeText(left, source);
            locals.add(v);
            const right = getChildByField(c, 'right');
            const made = constructed(right);
            if (made) constructions.push({ v, head: made[0], cls: made[1], bare: right?.type === 'identifier' });
            else if (right?.type === 'function_call' && /^(?:struct|load)$/.test(getNodeText(getChildByField(right, 'name') ?? right, source))) {
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
          written(v, c.namedChild(1));
          break;
        }
        case 'catch_clause': {
          // `catch ME` — the error variable is on the `catch` line. An
          // identifier on a later line is a statement (a command-syntax call).
          const v = errorVariable(c);
          if (v) locals.add(getNodeText(v, source));
          written(v, null);
          break;
        }
        case 'function_call': {
          const callee = getChildByField(c, 'name');
          if (callee?.type !== 'identifier') break;
          // Not a chain's field (`s.c{k}`, `obj.load(f)`).
          if (n.type === 'field_expression' && getChildByField(n, 'object')?.id !== c.id) break;
          const name = getNodeText(callee, source);
          if (name === 'load' && isStatement(c)) {
            for (const v of loadedNames(callArgs(c).map((a) => stringLiteral(a, source)))) loaded.add(v);
          } else if (name === 'eval' || name === 'evalc') {
            for (const arg of callArgs(c).slice(0, 2)) evalCodes.push({ callee: name, arg });
          }
          const args = callArgs(c);
          if (CLOBBERING_CALL.test(name) || (args.length === 0 && isStatement(c) && !MATLAB_BUILTINS.has(name))) clobbers = true;
          if (!MATLAB_BUILTINS.has(name)) {
            for (const a of args) {
              const head = a.type === 'identifier' || a.type === 'field_expression' || (a.type === 'function_call' && bracesIndex(a)) ? chainHead(a) : null;
              if (head) passed.add(getNodeText(head, source));
            }
          }
          // `c{k}` / `a(end)` in a function: c and a are its variables.
          if (isFunction && arrayEvidence(c) === 'variable') locals.add(name);
          break;
        }
        case 'command': {
          const cmd = namedChildren(c).find((a) => a.type === 'command_name');
          const name = cmd ? getNodeText(cmd, source) : '';
          if (CLOBBERING_CALL.test(name) || !MATLAB_BUILTINS.has(name)) clobbers = true;
          if (name !== 'load') break;
          for (const v of loadedNames(commandItems(c, source))) loaded.add(v);
          break;
        }
      }
      walk(c);
    }
  };
  walk(scope);
  if (!isFunction) for (const v of loaded) locals.add(v);
  return { locals, constructions, structFields, evalCodes, loaded, assigned, valued, copies, passed, clobbers, nested };
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

/** A function's parameters in order, null for an ignored one (`~`). */
function parameterList(children: readonly SyntaxNode[], source: string): (string | null)[] {
  const args = children.find((c) => c.type === 'function_arguments');
  if (!args) return [];
  return namedChildren(args)
    .filter((c) => c.type !== 'comment' && c.type !== 'line_continuation')
    .map((c) => (c.type === 'identifier' ? getNodeText(c, source) : null));
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
  if (f.self && head === f.self.name) return path.length === 1 ? { name: `${f.self.cls}::${member}`, self: true } : null;
  if (isLocal(f, head)) {
    if (path.length !== 1) return null;
    const hint = classHintOf(f, head);
    const field = readsStructField(f, head, member);
    if (hint) {
      if (isJavaClass(hint.cls)) return null;
      return { name: `${hint.cls}::${member}`, ...(hint.bare && !field ? { variable: `${head}.${member}` } : {}) };
    }
    if (field) return null;
    return { name: `${head}.${member}`, ...(isUntouchedParameter(f, head) ? { param: true } : {}) };
  }
  if (isJavaHead(head)) return null;
  return { name: [...path, member].join('::') };
}

/**
 * Whether `v`, where frame `f` reads it, is a parameter of the function the
 * code is in that the function never writes to: not assigned, not indexed or
 * field-assigned into (`problem.x = 1` makes it a struct the function fills
 * in), and no lambda parameter hiding it. A nested function's parameters are
 * variables of the workspace it shares, which is never asked here.
 */
function isUntouchedParameter(f: Frame, v: string): boolean {
  let g = f;
  while (g.kind === 'lambda' || g.kind === 'eval') {
    if (g.locals.has(v) || !g.parent) return false;
    g = g.parent;
  }
  return g.kind === 'function' && g.untouchedParams?.has(v) === true;
}

/**
 * A member reference: its name, and for one through a bare-name hint (`aa =
 * Archive; aa.getData()` → `Archive::getData`) the variable's own (`aa.getData`),
 * which the resolver takes instead when `Archive` is no class.
 */
interface MemberRef {
  name: string;
  variable?: string;
  /** On the method's own object (the `self` fact). */
  self?: boolean;
  /** On a parameter the function never writes to (the `param` fact). */
  param?: boolean;
}

/**
 * `a.b.f(x)` / `obj.m(x)` / `Cls.m(x)`: the reference for the first call in a
 * field chain whose receiver is a plain dotted name. Later calls in a chain
 * (`obj.get().run()`) act on a returned value with no static type — silent,
 * and so is a first call that can only be indexing (`s.data(end)`, `obj.c{k}`).
 */
function fieldChainRef(node: SyntaxNode, source: string): (MemberRef & { at: SyntaxNode; bare?: true }) | null {
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
  return path.length === 2 ? bareMemberRef(node, path[0]!, path[1]!) : null;
}

/**
 * `m.reset;`, `x = m.compute;`, `s = Model.make;`, `v = pkg.pf;`: a member
 * written without an argument list, which MATLAB calls when it is a method
 * (or a package's function) and reads when it is a property, a constant or an
 * enumeration member — which only the resolver can tell, so the reference
 * carries the `bare` fact (a read gets no edge, and its row stays only while
 * a callable symbol carries the name: see ../../resolution/matlab-failures).
 * Only where the head says whose member it is: the
 * method's own object, a variable the function says holds a class, or a name
 * that is no variable (a class or a package). On any other variable it is a
 * struct's field far more often than a method of one class (`data.fsample`):
 * nothing. Nor deeper (`obj.p.m`, a property's value), nor in a statement the
 * parser could not read whole (text that is no code: `hs_err_pid30205.log`
 * in a listing pasted into a file).
 */
function bareMemberRef(node: SyntaxNode, head: string, member: string): (MemberRef & { at: SyntaxNode; bare: true }) | null {
  if (inUnreadStatement(node)) return null;
  const f = frame();
  const own = f.self !== null && head === f.self.name;
  if (!own && isLocal(f, head) && !classHintOf(f, head)) return null;
  // `gcf.Position`: a property of what a built-in returns.
  if (!own && !isLocal(f, head) && MATLAB_BUILTINS.has(head)) return null;
  const ref = memberRef([head], member);
  if (!ref || ref.name.includes('.')) return null;
  return { ...ref, at: node, bare: true };
}

/** Whether `node` is in a command's arguments, or in a statement whose parse has an error in it. */
function inUnreadStatement(node: SyntaxNode): boolean {
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.type === 'command' || n.type === 'ERROR') return true;
    const p = n.parent?.type;
    if (p === 'block' || p === 'source_file') return n.hasError;
    if (n.type === 'function_definition' || n.type === 'class_definition') return false;
  }
  return false;
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
  const cls = dispatchClass(children.find((c) => c.type === 'arguments')?.namedChild(0), source);
  if (cls) return { name: `${cls}::${name}`, dispatch: true };
  return { name, dispatch: false };
}

/**
 * The class whose method a call passing `arg` first dispatches to, when the
 * code says what `arg` holds: the method's own object, or a variable the
 * function says holds a class (`c = Shape(…)`). Not a Java object's (`set(m,
 * …)` on one is the function as written: no class of the project's).
 */
function dispatchClass(arg: SyntaxNode | null | undefined, source: string): string | undefined {
  const f = frame();
  const first = arg?.type === 'identifier' ? getNodeText(arg, source) : null;
  const cls = !first ? undefined : f.self && first === f.self.name ? f.self.cls : classHintOf(f, first)?.cls;
  return cls && !isJavaClass(cls) ? cls : undefined;
}

/**
 * `run setup_paths` / `run('setup_paths.m')` / `run(name)` after `name =
 * 'setup_paths'`: the script (or function) run by that name, as a call of it
 * written where the name is. A path (`run('lib/setup')`) or a name with a
 * part nothing here knows names nothing the index can tell from here.
 * `holder` is the call's arguments or the command; `statement` whether the
 * `run` is a statement of its own, the only way a script runs.
 */
function runRef(holder: SyntaxNode | undefined, ctx: ExtractorContext, statement: boolean): void {
  const args = holder ? namedChildren(holder).filter((c) => c.type !== 'command_name' && c.type !== 'comment') : [];
  if (args.length !== 1) return;
  const arg = args[0]!;
  const at = arg.type === 'string' ? namedChildren(arg).find((c) => c.type === 'string_content') : arg.type === 'command_argument' ? arg : undefined;
  if (!at) {
    if (arg.type === 'string') return; // `run('')`
    for (const text of valueAt(arg, ctx.source).strs) {
      const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\.[mM])?$/.exec(text);
      if (m) addRef(ctx, m[1]!, 'calls', arg, { form: statement ? 'statement' : 'bare' });
    }
    return;
  }
  const m = /^(['"]?)([A-Za-z][A-Za-z0-9_]*)(?:\.[mM])?\1$/.exec(getNodeText(at, ctx.source));
  if (m) addRef(ctx, m[2]!, 'calls', at, { form: statement ? 'statement' : 'bare' }, at.startPosition.column + m[1]!.length);
}

// ---------------------------------------------------------------------------
// Names given as text: feval, str2func, code eval runs, callbacks, handles
// ---------------------------------------------------------------------------

/** The file's name as `mfilename` returns it in its own code (and code it evals); null in code run in another workspace. */
let fileStem: string | null = null;

/** How deep the walk is in code given as text: `eval('eval(''f'')')` reaches 2, and no deeper. */
let codeDepth = 0;
const MAX_CODE_DEPTH = 2;

/** What stands for a HOLE in code given as text: a name holding it names nothing. */
const PLACEHOLDER = 'CgHole__';

/**
 * The functions the file defines outside a class, and the ones nested in
 * them: a statement naming one calls it, and runs no script. Set while
 * extractFile walks the file.
 */
let fileFunctions: ReadonlySet<string> = EMPTY;

/** The functions `root` defines outside a class (see fileFunctions). */
function fileFunctionsOf(root: SyntaxNode, source: string): ReadonlySet<string> {
  const names = new Set<string>();
  const add = (fn: SyntaxNode): void => {
    const name = getChildByField(fn, 'name');
    if (name) names.add(getNodeText(name, source));
    const body = namedChildren(fn).find((c) => c.type === 'block');
    for (const c of body ? namedChildren(body) : []) if (c.type === 'function_definition') add(c);
  };
  for (const c of namedChildren(root)) if (c.type === 'function_definition') add(c);
  return names;
}

/** Code given as text, parsed: its tree's root, the text it was parsed from (HOLEs as PLACEHOLDER), and what its statements say of its variables. */
interface ParsedText {
  root: SyntaxNode;
  text: string;
  facts: ScopeFacts;
}

/**
 * Code given as text, parsed once per file (the interpretation of a scope,
 * the names its evals make and the walk of what they call share it): its
 * text, HOLEs replaced → its tree, and the parse when it is clean. Every tree
 * is deleted by extractFile.
 */
let codeTrees = new Map<string, { tree: Tree | null; parsed: ParsedText | null }>();

/** Code given as text, parsed (see codeTrees); null when it is too long or does not parse cleanly as MATLAB. */
function parseCode(code: string): ParsedText | null {
  const text = code.split(HOLE).join(PLACEHOLDER);
  if (text.length > MAX_TEXT) return null;
  let entry = codeTrees.get(text);
  if (entry === undefined) {
    let tree: Tree | null = null;
    try {
      tree = getParser('matlab')?.parse(text) ?? null;
    } catch (e) {
      // A corrupted wasm heap must reach the worker, which restarts with a fresh one.
      if (isWasmMemoryError(e)) throw e;
    }
    // A parse that recovered from an error says nothing for sure of what the code does.
    const parsed = tree && !tree.rootNode.hasError ? { root: tree.rootNode, text, facts: scanScope(tree.rootNode, text, false) } : null;
    codeTrees.set(text, (entry = { tree, parsed }));
  }
  return entry.parsed;
}

/** What interpretation asks of the walk, for code `source` whose variables `isVariable` says. */
function interpHost(source: string, isVariable: (name: string) => boolean): InterpHost {
  return {
    source,
    mfilename: () => fileStem,
    isLocal: isVariable,
    handle: (node) => handleRef(node, source),
    named: namedRef,
    isFileFunction: (name) => fileFunctions.has(name),
    code: (text): ParsedCode | null => {
      const parsed = parseCode(text);
      if (!parsed) return null;
      const own = parsed.facts.locals;
      return { root: parsed.root, host: interpHost(parsed.text, (n) => own.has(n) || isVariable(n)) };
    },
  };
}

/**
 * The function a name given as text (`str2func('pkg.f')`, `feval('pkg.f',
 * …)`) names: `f`, or `pkg::f` as `@pkg.f` would. Nothing when the head is a
 * variable here (MATLAB would not read a variable from text) or Java's.
 */
function namedRef(path: readonly string[]): FnVal | null {
  if (path.length === 1) return { name: path[0]! };
  const head = path[0]!;
  if (isLocal(frame(), head) || isJavaHead(head)) return null;
  return { name: path.join('::') };
}

/** What the scope's interpretation recorded for `node`, looked up through lambdas to the code around them. */
function recordedValue(node: SyntaxNode): Val | undefined {
  for (let g: Frame | null = frame(); g; g = g.parent) if (g.values) return g.values.get(node.id);
  return undefined;
}

/** What `node` holds where it is, what the caller passed included: as recorded, else as written (its literals). */
function rawValueAt(node: SyntaxNode, source: string): Val {
  return recordedValue(node) ?? evaluate(node, null, interpHost(source, (name) => isLocal(frame(), name)));
}

/** What `node` holds where it is, as this file alone says it (what the caller passed unknown: see callersUnknown). */
function valueAt(node: SyntaxNode, source: string): Val {
  return callersUnknown(rawValueAt(node, source));
}

/**
 * The names a walk may know the value of where they are passed (see
 * needsWalk): one written from a value (ScopeFacts.valued), or copied from
 * one so known or from a parameter (`r = regr`, `t = s.f`); a parameter
 * itself when it is assigned, or when something may set names unspelled.
 */
function knownNames(facts: ScopeFacts, params: ReadonlySet<string>): Set<string> {
  const known = new Set(facts.valued);
  for (const p of params) if (facts.assigned.has(p) || facts.clobbers) known.add(p);
  for (let grew = true; grew;) {
    grew = false;
    for (const [to, from] of facts.copies) {
      if (!known.has(to) && (known.has(from) || params.has(from))) {
        known.add(to);
        grew = true;
      }
    }
  }
  return known;
}

/**
 * Whether a scope is worth interpreting: its code has a call built from
 * text, or passes a call (no built-in's) a variable the walk may know the
 * value of (see knownNames). A parameter passed on as it is needs no walk
 * (see forwardable). A walk for parameter sinks reads every function it is
 * asked for: a call of a parameter (`fh(x)`) is a sink too.
 */
function needsWalk(scope: SyntaxNode, params: readonly (string | null)[] | undefined, source: string, facts: ScopeFacts): boolean {
  if (sinkCollector || SINK_WORDS.test(getNodeText(scope, source))) return true;
  if (facts.passed.size === 0) return false;
  const known = knownNames(facts, new Set(params?.filter((p): p is string => p !== null)));
  for (const v of facts.passed) if (known.has(v)) return true;
  return false;
}

/** The values a scope's dynamic calls read and its calls pass (see matlab-interp.ts), when it is walked (see needsWalk). */
function scopeValues(scope: SyntaxNode, options: ScopeOptions, source: string, walk: boolean): ScopeValues {
  return walk ? interpretScope(scope, options, interpHost(source, (name) => isLocal(frame(), name))) : NO_VALUES;
}

/**
 * The parameters a function that is not walked passes on unchanged wherever
 * it reads them: none written anywhere in it, and nothing in it that may set
 * names it does not spell or write them unseen — no `load`, `clear`, `eval`
 * or `run`, no statement that may run a script, no nested function (it
 * shares the workspace). What a call passes as one is what the function was
 * passed (see forwardedArg). A walked function's calls pass what its walk
 * says, and nothing where the walk says nothing (it hit its budget, or the
 * parameter is unknown there).
 */
function forwardable(params: readonly (string | null)[], facts: ScopeFacts, walked: boolean): ReadonlySet<string> {
  if (walked || facts.clobbers || facts.nested) return EMPTY;
  return new Set(params.filter((p): p is string => p !== null && !facts.assigned.has(p)));
}

/**
 * The names a scope's code makes at runtime — what the code its `eval`s run
 * assigns or loads (`eval('x = 3;')`), what its `load` lists name: a
 * script's variables (`x(2)` there reads x), a function's runtime names (see
 * Frame.runtime). A name with a part nothing here knows is passed over.
 */
function addRuntimeNames(facts: ScopeFacts, f: Frame, source: string, isFunction: boolean): void {
  const made = new Set<string>(isFunction ? facts.loaded : []);
  for (const { callee, arg } of facts.evalCodes) {
    if (isLocal(f, callee)) continue;
    for (const code of valueAt(arg, source).strs) {
      for (const n of parseCode(code)?.facts.locals ?? []) if (!n.includes(PLACEHOLDER)) made.add(n);
    }
  }
  if (made.size === 0) return;
  if (isFunction) f.runtime = made;
  else for (const n of made) facts.locals.add(n);
}

/**
 * The references of a call that names what it calls at runtime (see
 * sinkInputs), from what its arguments hold: `feval(m, …)` calls each
 * function `m` can name, `str2func('f')` and `cellfun('f', c)` reference f,
 * the code `eval` / `evalc` / `evalin` run is read as code, and so is a
 * callback property's value given as text (`'Callback', 'go'`). `named`
 * whether the call is of the function as written (not a method a class
 * dispatches it to): only callbacks are read otherwise.
 */
function dynamicCallRefs(node: SyntaxNode, name: string, ctx: ExtractorContext, named: boolean): void {
  const source = ctx.source;
  const args = callArgs(node);
  for (const { index, kind } of sinkInputs(name, args, source)) {
    if (kind === 'run' || (!named && kind !== 'callback')) continue;
    const arg = args[index]!;
    if (sinkCollector) collectParamSink(arg, name, kind, args, index, isStatement(node), source);
    const v = valueAt(arg, source);
    const computed = !writtenAsLiteral(arg);
    switch (kind) {
      case 'feval':
        handleCalls(v.fns, v.strs, arg, args[1], ctx, computed);
        break;
      case 'function':
        // A handle written with `@` is referenced there.
        for (const text of v.strs) {
          if (!NAME_SHAPED.test(text) || (name === 'cellfun' && MATLAB_CELLFUN_NAMES.has(text))) continue;
          const f = namedRef(text.split('.'));
          if (f) addRef(ctx, f.name, 'function_ref', arg, computedFact(f.name, computed));
        }
        break;
      case 'eval':
        // `x = eval('cfgscript')` evaluates an expression, which a script is not; `evalc` runs it as a statement.
        codeRefs(v.strs, arg, ctx, 'here', name === 'eval' && !isStatement(node), computed);
        break;
      case 'evalin':
        // `p = evalin('base', 'SimParams')` reads what a name holds there, most
        // often a variable of that workspace: no telling it from a call.
        codeRefs(isStatement(node) ? v.strs : v.strs.filter((c) => !/^\s*[A-Za-z]\w*\s*;?\s*$/.test(c)), arg, ctx, 'elsewhere', !isStatement(node), computed);
        break;
      case 'callback':
        codeRefs(v.strs, arg, ctx, 'callback', false, computed);
        break;
    }
  }
}

/**
 * Whether an argument is one literal written where it is passed (`'pkg.f'`,
 * `"pkg.f"`, `@pkg.f`): what it names, the text spells. Anything else
 * (`strcat('pkg.', 'f')`, `[p '.f']`, `lower('PKG.F')`, a variable holding
 * any of these) is a value the interpreter built.
 */
function writtenAsLiteral(arg: SyntaxNode): boolean {
  return arg.type === 'string' || arg.type === 'handle_operator';
}

/** Whether a reference name is a member or qualified one (`v.f`, `pkg::f`). */
function isDottedName(name: string): boolean {
  return name.includes('.') || name.includes(':');
}

/**
 * The `computed` fact of a reference to `name` built from a value the
 * interpreter built (see writtenAsLiteral), when the name is a dotted one:
 * no text spells it, so its row must not wait on a word scan (see
 * ../../resolution/matlab-failures.ts).
 */
function computedFact(name: string, computed: boolean): MatlabRefFacts {
  return computed && isDottedName(name) ? { computed: true } : {};
}

/**
 * Calls of the functions `fns` hold and the names `strs` give (`feval`'s
 * first argument, or what `fh` holds in `fh(x)`), at `at`. A plain name
 * dispatches on the object passed first (`dispatchOn`) as a call written so
 * would: `feval('area', c)` after `c = Shape(…)` is `Shape::area`.
 */
function handleCalls(fns: readonly FnVal[], strs: readonly string[], at: SyntaxNode, dispatchOn: SyntaxNode | undefined, ctx: ExtractorContext, computed: boolean): void {
  const cls = dispatchClass(dispatchOn, ctx.source);
  const call = (f: FnVal): void => {
    if (cls && /^[A-Za-z]\w*$/.test(f.name)) addRef(ctx, `${cls}::${f.name}`, 'calls', at, { dispatch: f.name });
    else addRef(ctx, f.name, 'calls', at, { ...(f.variable ? { variable: f.variable } : {}), ...computedFact(f.name, computed) });
  };
  for (const text of strs) {
    const f = NAME_SHAPED.test(text) ? namedRef(text.split('.')) : null;
    if (f) call(f);
  }
  for (const f of fns) call(f);
}

/**
 * Where code given as text runs: `here` (`eval`: the code around it sees
 * what it assigns, and it sees the code's variables), `elsewhere` (`evalin`:
 * another workspace, none of whose variables the code here says), or as a
 * `callback`, in the base workspace, on an event — what it calls is
 * referenced, as `@onClick` is, not called here. What code run elsewhere
 * names is a name made at runtime (see Frame.runtime): that workspace's
 * variables are none the index can see.
 */
type CodeMode = 'here' | 'elsewhere' | 'callback';

/** The variables `locals` and the names made at runtime around frame `f`: in code `eval` runs there, those are variables when it runs. */
function withRuntimeNames(locals: ReadonlySet<string>, f: Frame): ReadonlySet<string> {
  let out: Set<string> | null = null;
  for (let g: Frame | null = f; g; g = g.parent) {
    for (const n of g.runtime ?? []) (out ??= new Set(locals)).add(n);
  }
  return out ?? locals;
}

/**
 * The references of code given as text, each string of it parsed and walked
 * as code (definitions in it aside), all at `at`, the argument that gives
 * it. `asValue` says the code is evaluated for a value (`x = eval('cfg')`),
 * where no statement runs a script. Code in code is read to MAX_CODE_DEPTH;
 * code the walk fails on gives nothing.
 */
function codeRefs(codes: readonly string[], at: SyntaxNode, ctx: ExtractorContext, mode: CodeMode, asValue = false, computed = false): void {
  if (codeDepth >= MAX_CODE_DEPTH) return;
  for (const code of new Set(codes)) {
    const parsed = parseCode(code);
    if (!parsed) continue;
    const { root, text, facts } = parsed;
    const outer = frame();
    const here = mode === 'here';
    const f: Frame = {
      kind: here ? 'eval' : 'file',
      qual: outer.qual,
      locals: here ? withRuntimeNames(facts.locals, outer) : facts.locals,
      classHints: classHintsFrom(facts, (v) => facts.locals.has(v) || (here && isLocal(outer, v))),
      structFields: facts.structFields,
      self: here && outer.self && !facts.locals.has(outer.self.name) ? outer.self : null,
      parent: here ? outer : null,
      values: NO_VALUES,
    };
    const refs: UnresolvedReference[] = [];
    const sub = codeContext(ctx, text, at, { callback: mode === 'callback', runtime: !here, asValue, computed }, refs);
    const memo = arrayEvidenceMemo;
    const stem = fileStem;
    // Node ids are per tree: this one's must not meet the file's in the memo.
    arrayEvidenceMemo = new Map();
    if (!here) fileStem = null;
    codeDepth++;
    try {
      inFrame(f, () => {
        for (const c of namedChildren(root)) sub.visitNode(c);
      });
    } catch (e) {
      if (isWasmMemoryError(e)) throw e;
      refs.length = 0; // code the walk cannot follow names nothing for sure
    } finally {
      codeDepth--;
      arrayEvidenceMemo = memo;
      fileStem = stem;
    }
    for (const r of refs) ctx.addUnresolvedReference(r);
  }
}

/** What code given as text defines is nobody's: no symbol of the file. */
const DEFINITIONS: ReadonlySet<string> = new Set(['function_definition', 'function_signature', 'class_definition']);

/** How codeContext passes a reference of code given as text on. */
interface CodeRefStyle {
  /** A callback's: what it calls is referenced (`function_ref`). */
  callback: boolean;
  /** Code run in another workspace: every name a name made at runtime (the `runtime` fact). */
  runtime: boolean;
  /** Code evaluated for a value: a statement there is an expression, never a script run (`statement` read as `bare`). */
  asValue: boolean;
  /** Code whose text the interpreter built (no one literal written where it is given): a dotted name in it is `computed`. */
  computed: boolean;
}

/**
 * The context code given as text is walked in: the visitor's own, over the
 * code's tree. It defines nothing; its references are the enclosing scope's,
 * at `at`'s place in the file, styled as `style` says, and gathered in
 * `sink`; one whose name holds a part nothing here knows is dropped.
 */
function codeContext(outer: ExtractorContext, source: string, at: SyntaxNode, style: CodeRefStyle, sink: UnresolvedReference[]): ExtractorContext {
  const line = at.startPosition.row + 1;
  const column = at.startPosition.column;
  const sub: ExtractorContext = {
    createNode: () => null,
    visitNode: (n) => {
      if (DEFINITIONS.has(n.type)) return;
      if (!matlabExtractor.visitNode!(n, sub)) for (const c of namedChildren(n)) sub.visitNode(c);
    },
    visitFunctionBody: () => {},
    walkInitializer: () => {},
    addUnresolvedReference: (ref) => {
      // An argument with a part nothing here knows is no value the call is known to pass: its record goes, the call stays.
      let candidates = (ref.candidates ?? []).filter((c) => !(isMatlabArgsCandidate(c) && c.includes(PLACEHOLDER)));
      if (ref.referenceName.includes(PLACEHOLDER) || candidates.some((c) => c.includes(PLACEHOLDER))) return;
      if (style.asValue) candidates = candidates.map((c) => (c === 'statement' ? 'bare' : c));
      if (style.runtime && !candidates.includes(RUNTIME_TAG)) candidates = [...candidates, RUNTIME_TAG];
      if (style.computed && isDottedName(ref.referenceName) && !candidates.includes(COMPUTED_TAG)) candidates = [...candidates, COMPUTED_TAG];
      const out: UnresolvedReference = { ...ref, line, column };
      if (candidates.length > 0) out.candidates = candidates;
      else delete out.candidates;
      if (style.callback && ref.referenceKind === 'calls') out.referenceKind = 'function_ref';
      sink.push(out);
    },
    pushScope: () => {},
    popScope: () => {},
    get filePath() {
      return outer.filePath;
    },
    source,
    get nodeStack() {
      return outer.nodeStack;
    },
    get nodes() {
      return outer.nodes;
    },
  };
  return sub;
}

// ---------------------------------------------------------------------------
// What calls pass, and what functions do with what they are passed
// ---------------------------------------------------------------------------

/**
 * Whether an argument may stand for several (a comma-separated list):
 * `c{:}`, `c{k}` with k no literal, `s(2:3).f` — every argument after it is
 * at a place nothing here can count to.
 */
function mayExpand(arg: SyntaxNode, source: string): boolean {
  if (arg.type === 'function_call') return bracesIndex(arg) && literalIndex(arg, source) === null;
  if (arg.type !== 'field_expression') return false;
  const parts = namedChildren(arg);
  return parts.some((p, i) => p.type === 'function_call' && literalIndex(p, source) === null && (bracesIndex(p) || (i < parts.length - 1 && callArgs(p).length > 0)));
}

/**
 * Whether a field read passed as an argument (`s.f`, `s.a.b`) may stand for
 * several: of a struct array its field is a list (`f(s.name, 'x')` of a 1×2
 * `s` passes three), so unless each struct it reads through is one the code
 * built, of one element, as the walk recorded it, the argument's place and
 * every one after it are unknown.
 */
function fieldMayExpand(arg: SyntaxNode, source: string): boolean {
  if (arg.type !== 'field_expression') return false;
  const parts = namedChildren(arg);
  let v = parts[0]?.type === 'identifier' ? recordedValue(parts[0]) : undefined;
  for (const p of parts.slice(1)) {
    if (!isOneBuiltStruct(v) || p.type !== 'identifier') return true;
    v = fieldOf(v, getNodeText(p, source));
  }
  return false;
}

/** Whether an argument's place, and every one after it, cannot be counted to (see mayExpand, fieldMayExpand). */
function uncountable(arg: SyntaxNode, source: string): boolean {
  return mayExpand(arg, source) || fieldMayExpand(arg, source);
}

/**
 * What an argument passes when it is a parameter the function passes on
 * unchanged (see forwardable): that parameter, sealed (no field read off it
 * is claimed), or, for `varargin{:}`, the parameters from its place on.
 */
function forwardedArg(arg: SyntaxNode, source: string): ReturnType<typeof argValue> {
  const f = frame();
  if (f.kind !== 'function' || !f.params || !f.forwards || f.forwards.size === 0) return null;
  const spread = arg.type === 'function_call' && bracesIndex(arg) && isColonIndex(arg);
  const head = arg.type === 'identifier' ? arg : spread ? getChildByField(arg, 'name') : null;
  const name = head?.type === 'identifier' ? getNodeText(head, source) : null;
  if (!name || !f.forwards.has(name)) return null;
  const k = f.params.indexOf(name);
  const variadic = name === 'varargin' && k === f.params.length - 1;
  if (spread) return variadic ? { r: k, s: 1 } : null;
  return variadic ? null : { p: k, s: 1 };
}

/**
 * The `args` fact of `f(a, b, …)` (see matlab-ref-facts.ts): each argument
 * whose every value is known, by its place — counted up to the first that
 * may stand for several (see uncountable), or, in code given as text, one
 * with a part nothing knows (`['f(' args ', ''x'')']`: any number of
 * arguments), and including `varargin{:}` when it is the last.
 */
function callArgsFact(node: SyntaxNode, source: string): MatlabCallArgs | undefined {
  const args = callArgs(node);
  let out: MatlabCallArgs | undefined;
  let guarded: boolean | undefined;
  for (let i = 0; i < Math.min(args.length, MATLAB_ARG_PLACES); i++) {
    const arg = args[i]!;
    if (arg.type !== 'string' && getNodeText(arg, source).includes(PLACEHOLDER)) break;
    let v = argValue(rawValueAt(arg, source)) ?? forwardedArg(arg, source);
    // A parameter passed on under a condition a caller decides: the callee cannot tell which callers get here.
    if (v !== null && passesParameter(v) && (guarded ??= guardScope(frame(), source)?.guarded(node) ?? true)) {
      if (spreadItem(v)) break;
      v = null;
    }
    if (v !== null && spreadItem(v)) {
      if (!Array.isArray(v) && i === args.length - 1) (out ??= {})[i] = v;
      break;
    }
    if (uncountable(arg, source)) break;
    if (v !== null) (out ??= {})[i] = v;
  }
  return out;
}

/** Whether an argument's values include what the caller passed (its parameter, `varargin{:}`, a struct field holding one). */
function passesParameter(v: MatlabArgValue): boolean {
  return argItemsOf(v).some((x) => typeof x === 'number' || (typeof x === 'object' && ('p' in x || 'r' in x || Object.values(x.o).some(passesParameter))));
}

/** What a parameter sink does with the value it reads (see MatlabParamSink). */
interface SinkUse {
  /** The call that reads it: `feval`, `str2func`, `eval`, or the variable called (`fh(x)`). */
  readonly sink: string;
  /** What values it takes: any (`feval`), texts only (`str2func`, a template, code), handles only (`fh(x)`: a text there is indexed). */
  readonly takes: 'any' | 'text' | 'handle';
  /** What it makes of one: a call, a reference (a function named as a handle), or code it runs here. */
  readonly edge: 'calls' | 'function_ref' | 'code';
  /** Code evaluated for a value (`x = eval(c)`): a statement there runs no script. */
  readonly asValue: boolean;
}

/**
 * A place where a function does with a value its caller passed what it would
 * do with a literal written there (`feval(regr, S)`, `str2func(varargin{1})`,
 * `eval(code)`, `fh(x)`, `feval(['ft_' method], …)`): which parameter (and
 * field of it), the text around it, and where.
 */
export interface MatlabParamSink extends SinkUse {
  /** The function's site (see Frame.site). */
  readonly fn: string;
  /** The parameter's position (a variadic one counts on from the positional ones). */
  readonly position: number;
  /** The fields read off it (`cfg.winfunc` → [winfunc]). */
  readonly path: readonly string[];
  /** The text before and after it, for a template (`ft_` and ``); '' and '' for the value as it is. */
  readonly prefix: string;
  readonly suffix: string;
  /** The parameter as the code names it: `regr`, `varargin{1}`, `cfg.winfunc`. */
  readonly param: string;
  /** Where the reference a literal would make is (1-based line). */
  readonly line: number;
  readonly column: number;
  /** The tests of this value it runs under: only a value they admit reaches it (see matlab-guards.ts). */
  readonly guards?: readonly MatlabGuard[];
}

/** The parameter sinks a walk collects (see matlabParamSinks). */
interface SinkCollector {
  /** Whether a function at this site is one to walk. */
  wants(site: string): boolean;
  /** Notes the sinks `v` (what a sink reads at `at`) holds, in the function walked now. */
  add(v: Val, use: SinkUse, at: SyntaxNode): void;
  readonly sinks: MatlabParamSink[];
  /** Each sink's frame and node, for the code a caller passes to an `eval` sink. */
  readonly places: Map<MatlabParamSink, { frame: Frame; at: SyntaxNode }>;
}

/** Set while matlabParamSinks walks a file: the extractor's sinks report to it. */
let sinkCollector: SinkCollector | null = null;

/** The parameter at `position` with `path` as the code names it, in a function whose parameters are `params`; null when it has none there. */
function paramName(params: readonly (string | null)[], position: number, path: readonly string[]): string | null {
  const last = params.length - 1;
  const name = params[last] === 'varargin' && position >= last ? `varargin{${position - last + 1}}` : params[position];
  return name ? [name, ...path].join('.') : null;
}

/** A collector for the functions at `sites` of a file whose text is `source` (see SinkCollector). */
function newSinkCollector(sites: ReadonlySet<string>, source: string): SinkCollector {
  const sinks: MatlabParamSink[] = [];
  const places = new Map<MatlabParamSink, { frame: Frame; at: SyntaxNode }>();
  return {
    sinks,
    places,
    wants: (site) => sites.has(site),
    add(v, use, at) {
      const f = frame();
      if (!f.params || !f.site) return;
      const found: Array<{ position: number; path: readonly string[]; prefix: string; suffix: string; takes: SinkUse['takes'] }> = [];
      for (const s of v.syms) {
        const p = parseSymPath(s.path);
        if (p?.kind === 'spread') found.push({ position: p.position, path: [], prefix: '', suffix: '', takes: use.takes });
        else if (p?.kind === 'param') found.push({ position: p.position, path: p.fields, prefix: '', suffix: '', takes: use.takes });
      }
      if (use.takes !== 'handle') {
        for (const text of v.strs) {
          const t = templateOf(text);
          const p = t && parseSymPath(t.path);
          if (p?.kind === 'param') found.push({ position: p.position, path: p.fields, prefix: t!.prefix, suffix: t!.suffix, takes: 'text' });
        }
      }
      // What one of several parameters holds (`if nargin < 2, b = a; end; feval(b)`): which one depends on
      // how many the caller passed, which no call's record says. Nothing, rather than each caller's every one.
      const positions = new Set(found.map((one) => one.position));
      if (positions.size > 1) return;
      for (const one of found) {
        const param = paramName(f.params, one.position, one.path);
        if (param === null) continue;
        // Under a condition what a caller passes decides (`if strcmp(action, 'run')`, an earlier `return`): only
        // the values it admits when it tests this very one, nothing when it tests anything else (see matlab-guards.ts).
        const guards = guardScope(f, source)?.sinkGuards(at, one) ?? null;
        if (guards === null) continue;
        const sink: MatlabParamSink = {
          ...use,
          ...(guards.length > 0 ? { guards } : {}),
          takes: one.takes,
          fn: f.site,
          position: one.position,
          path: one.path,
          prefix: one.prefix,
          suffix: one.suffix,
          param,
          line: at.startPosition.row + 1,
          column: at.startPosition.column,
        };
        sinks.push(sink);
        places.set(sink, { frame: f, at });
      }
    },
  };
}

/**
 * The conditions frame `f`'s code runs under (see matlab-guards.ts): its
 * function's, read once. Null where no function's own walk is (a nested
 * function's, a script's), or the code is text run by `eval`, whose tree is
 * not the function's.
 */
function guardScope(f: Frame, source: string): GuardScope | null {
  let g: Frame | null = f;
  while (g && g.kind === 'lambda') g = g.parent;
  if (!g || g.kind !== 'function' || !g.def || !g.params) return null;
  return (g.guards ??= new GuardScope(g.def, g.params, source));
}

/**
 * Notes the parameter sink a dynamic call's argument may be (see
 * MatlabParamSink): `feval`'s function, a text `str2func` or a function
 * taker reads, code `eval` / `evalc` run here. Not `evalin` or a callback
 * (another workspace), and not where an argument before it may stand for
 * several (its place is not this one), nor a `feval` that would dispatch on
 * its object's class.
 */
function collectParamSink(arg: SyntaxNode, name: string, kind: string, args: readonly SyntaxNode[], index: number, statement: boolean, source: string): void {
  if (!sinkCollector || args.slice(0, index).some((a) => uncountable(a, source))) return;
  let use: SinkUse;
  if (kind === 'feval') {
    if (dispatchClass(args[1], source) !== undefined) return;
    use = { sink: name, takes: 'any', edge: 'calls', asValue: false };
  } else if (kind === 'function') use = { sink: name, takes: name === 'str2func' ? 'text' : 'any', edge: 'function_ref', asValue: false };
  else if (kind === 'eval') use = { sink: name, takes: 'text', edge: 'code', asValue: name === 'eval' && !statement };
  else return;
  sinkCollector.add(rawValueAt(arg, source), use, arg);
}

/** A context that walks a file for what it reads, keeping no node: its references go to `refs`, from `from` when no function is on the stack. */
function collectingContext(source: string, filePath: string, refs: UnresolvedReference[], from: string | null): ExtractorContext {
  let ids = 0;
  const stack: string[] = from ? [from] : [];
  const ctx: ExtractorContext = {
    createNode: (kind, name) => ({ id: `matlab-sink-walk:${++ids}`, kind, name }) as Node,
    visitNode: (n) => {
      if (!matlabExtractor.visitNode!(n, ctx)) for (const c of namedChildren(n)) ctx.visitNode(c);
    },
    visitFunctionBody: () => {},
    walkInitializer: () => {},
    addUnresolvedReference: (ref) => refs.push(ref),
    pushScope: (id) => stack.push(id),
    popScope: () => void stack.pop(),
    filePath,
    source,
    nodeStack: stack,
    nodes: [],
  };
  return ctx;
}

/**
 * The parameter sinks of the functions of a MATLAB file defined at `sites`
 * (see Frame.site), found by the walk extraction makes of them — the same
 * frames, values and sinks — and, while the file's tree lives, what code a
 * caller passes to one of its `eval` sinks references, read in that
 * function's frame as code `eval` runs there (its references from
 * `CALLEE`). `root` is the file's parsed tree — of its whole text, or of the
 * lines of the functions asked for, the others blank — and `functions` the
 * names of every function the file defines; the tree's owner deletes it.
 */
export function matlabParamSinks<T>(
  root: SyntaxNode,
  source: string,
  filePath: string,
  sites: ReadonlySet<string>,
  functions: ReadonlySet<string>,
  use: (sinks: readonly MatlabParamSink[], codeRefs: (sink: MatlabParamSink, code: string) => UnresolvedReference[]) => T,
): T {
  if (isOctave(source)) return use([], () => []);
  return inFile(root, source, filePath, () => {
    // `source` may hold only the functions asked for: the file's others are named by the caller.
    fileFunctions = new Set([...fileFunctions, ...functions]);
    const collector = newSinkCollector(sites, source);
    sinkCollector = collector;
    try {
      walkFile(root, collectingContext(source, filePath, [], null));
    } finally {
      sinkCollector = null;
    }
    const codeRefsOf = (sink: MatlabParamSink, code: string): UnresolvedReference[] => {
      const place = collector.places.get(sink);
      if (!place || sink.edge !== 'code') return [];
      const out: UnresolvedReference[] = [];
      const sub = collectingContext(source, filePath, out, CALLEE);
      inFrame(place.frame, () => codeRefs([code], place.at, sub, 'here', sink.asValue));
      return out;
    };
    return use(collector.sinks, codeRefsOf);
  });
}

/** The `fromNodeId` of the references matlabParamSinks reads off code a caller passes: the function holding the sink. */
export const CALLEE = 'matlab-param-sink:callee';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * A function's first line as written, its parameter list as parameterList
 * reads it (`function y = f(a, ~, varargin)`: no comment, no `...`), which
 * matlabParameterNames reads back.
 */
function functionSignature(node: SyntaxNode, children: readonly SyntaxNode[], source: string): string {
  const args = children.find((c) => c.type === 'function_arguments');
  const name = getChildByField(node, 'name');
  const head = source.slice(node.startIndex, args?.startIndex ?? name?.endIndex ?? node.endIndex).replace(/\s+/g, ' ').trim();
  const params = args ? `(${parameterList(children, source).map((p) => p ?? '~').join(', ')})` : '';
  const text = head + params;
  return node.type === 'function_signature' && !text.startsWith('function') ? `function ${text}` : text;
}

/** A MATLAB function's parameter names in order, as its signature lists them (see functionSignature; `~` for an ignored one); null for none it could read. */
export function matlabParameterNames(signature: string | undefined): string[] | null {
  const list = /\(([^()]*)\)\s*$/.exec(signature ?? '')?.[1];
  if (list === undefined) return signature !== undefined && !signature.trimEnd().endsWith(')') ? [] : null;
  if (list.trim() === '') return [];
  const params = list.split(',').map((p) => p.trim());
  return params.every((p) => p === '~' || /^[A-Za-z]\w*$/.test(p)) ? params : null;
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

/** The parameters among `params` that the scope `facts` were read from never writes to (see ScopeFacts.assigned). */
function untouched(params: readonly (string | null)[], facts: ScopeFacts): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of params) if (p && !facts.assigned.has(p)) out.add(p);
  return out;
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
  const site = `${node.startPosition.row + 1}:${node.startPosition.column}`;
  // A declaration has no body to walk; a walk for parameter sinks walks only the functions it was asked for.
  if (!fn || node.type === 'function_signature' || (sinkCollector && !sinkCollector.wants(site))) {
    if (oldStyleClass) ctx.popScope();
    return;
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
  // A nested function's parameters are variables of the workspace it shares: what they hold is not followed.
  const params = nested ? undefined : parameterList(children, source);
  const walk = needsWalk(node, params, source, facts);
  const f: Frame = {
    kind: 'function',
    qual: [...qual, name],
    locals: facts.locals,
    classHints: classHintsFrom(facts, (v) => facts.locals.has(v) || (parent !== null && isLocal(parent, v))),
    structFields: facts.structFields,
    self,
    parent,
    ...(params ? { params, forwards: forwardable(params, facts, walk), def: node, untouchedParams: untouched(params, facts) } : {}),
    site,
  };

  // What holds something on entry: the parameters, and a method's output (a constructor's is the object).
  const inputs = new Set<string>();
  for (const c of children) {
    if (c.type === 'function_arguments' || (c.type === 'function_output' && kind === 'method')) identifiersIn(c, source, inputs);
  }
  const own = new Set<string>(inputs);
  for (const c of children) if (c.type === 'function_output') identifiersIn(c, source, own);
  const options: ScopeOptions = {
    isFunction: true,
    inputs,
    // A nested function shares its parent's variables (its own parameters and outputs aside).
    shared: parent ? (v) => !own.has(v) && isLocal(parent, v) : () => false,
    ...(params ? { params } : {}),
  };

  ctx.pushScope(fn.id);
  inFrame(f, () => {
    f.values = scopeValues(node, options, source, walk);
    addRuntimeNames(facts, f, source, true);
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
  inFile(node, ctx.source, ctx.filePath, () => walkFile(node, ctx));
}

/** Runs `body` with what the walk keeps of the file `root` is (its Java imports, its functions, its name), all of it dropped after. */
function inFile<T>(root: SyntaxNode, source: string, filePath: string, body: () => T): T {
  javaImported = javaImportsOf(root, source);
  fileFunctions = fileFunctionsOf(root, source);
  fileStem = matlabFileStem(filePath);
  try {
    return body();
  } finally {
    javaImported = EMPTY;
    arrayEvidenceMemo = new Map();
    fileStem = null;
    codeDepth = 0;
    fileFunctions = EMPTY;
    for (const { tree } of codeTrees.values()) tree?.delete();
    codeTrees = new Map();
  }
}

/** Walks a file from its root (see extractFile); a walk for parameter sinks walks its definitions only. */
function walkFile(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
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
    // A function file's or a class file's top level runs nothing of its own.
    const script = !sinkCollector && namedChildren(node).some((c) => !DEFINITIONS.has(c.type) && c.type !== 'comment');
    f.values = script ? scopeValues(node, { isFunction: false, inputs: EMPTY, shared: () => false }, source, needsWalk(node, undefined, source, facts)) : NO_VALUES;
    addRuntimeNames(facts, f, source, false);
    for (const c of namedChildren(node)) if (!sinkCollector || DEFINITIONS.has(c.type)) ctx.visitNode(c);
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
        // (`Tune = (0.2, 0.1)` in a notes file read as MATLAB). A superclass
        // call (`obj@Base(x)`, `m@Base(obj)`) has its `@Base` between: a
        // call written with arguments too, never a member read.
        const sup = callee.nextSibling?.type === '@' && callee.nextSibling.nextSibling?.type === 'superclass' ? callee.nextSibling.nextSibling : null;
        const form = (sup ?? callee).nextSibling?.type === '(' ? undefined : 'bare';
        // (A walk for parameter sinks keeps no reference: what calls pass is no part of it.)
        const args = form || sinkCollector || MATLAB_BUILTINS.has(written) ? undefined : callArgsFact(node, source);
        if (ref) addRef(ctx, ref.name, 'calls', node, { ...(ref.dispatch ? { dispatch: written } : {}), ...(form ? { form } : {}), ...runtimeFact(frame(), written), ...(args ? { args } : {}) });
        if (ref?.name === 'run') runRef(namedChildren(node).find((c) => c.type === 'arguments'), ctx, isStatement(node));
        if (ref) dynamicCallRefs(node, written, ctx, ref.name === written);
        else if (isLocal(frame(), written)) {
          // `fh(x)` after `fh = @solve`: a call of what the handle holds.
          const held = recordedValue(callee);
          // What the handle holds was given elsewhere: computed, as far as this call's text says.
          if (held && held.fns.length > 0) handleCalls(held.fns, [], node, callArgs(node)[0], ctx, true);
          if (held && sinkCollector && dispatchClass(callArgs(node)[0], source) === undefined) {
            sinkCollector.add(held, { sink: written, takes: 'handle', edge: 'calls', asValue: false }, node);
          }
        }
        return false; // arguments still walked
      }

      case 'assignment': {
        // `h.Callback = 'go'`, `s(k).KeyPressFcn = …`: callback code given as text.
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');
        if (left?.type === 'field_expression' && right) {
          const parts = namedChildren(left);
          const last = parts[parts.length - 1];
          if (last?.type === 'identifier' && CALLBACK_PROPERTY.test(getNodeText(last, source))) codeRefs(valueAt(right, source).strs, right, ctx, 'callback', false, !writtenAsLiteral(right));
        }
        return false;
      }

      case 'field_expression': {
        // `s.f(k) = …` writes a field; `Q2.Setpoint.P` in `AO.Q2.Setpoint.P{1}(6, :)` is no chain of its own.
        if (isAssignmentTarget(node) || isInnerChain(node)) return false;
        const ref = fieldChainRef(node, source);
        const head = getChildByField(node, 'object');
        if (ref) {
          addRef(ctx, ref.name, 'calls', ref.at, {
            ...(ref.variable ? { variable: ref.variable } : {}),
            ...(ref.bare ? { form: 'bare' as const } : {}),
            ...(head ? runtimeFact(frame(), getNodeText(head, source)) : {}),
            ...(ref.self ? { self: true } : {}),
            ...(ref.param ? { param: true } : {}),
          });
        }
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
        if (!isLocal(frame(), name) && !javaImported.has(name)) addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare', ...runtimeFact(frame(), name) });
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
          addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare', ...runtimeFact(frame(), name) });
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
