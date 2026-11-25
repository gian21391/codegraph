import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Node, NodeKind, UnresolvedReference } from '../../types';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import { getParser } from '../grammars';
import { matlabFileStem, matlabPathScope } from './matlab-path';
import { MATLAB_LINE_END, hasMatlabKeywordPart, matlabParseText, matlabUnreadReason } from './matlab-syntax';
import {
  ERRORING_ON_OBJECTS,
  MATLAB_BUILTINS,
  MATLAB_CELLFUN_NAMES,
  OBJECT_RETURNING_BUILTINS,
  VALUE_RETURNING_ON_OBJECTS,
  isMatlabLowerConstructorName,
} from './matlab-builtins';
import { JAVA_PACKAGE_ROOTS, isJavaImport } from './matlab-java';
import { COMPUTED_TAG, CTOR_TAG, MATLAB_ARG_PLACES, RUNTIME_TAG, argItemsOf, isMatlabArgsCandidate, matlabRefCandidates, spreadItem, type MatlabArgValue, type MatlabCallArgs, type MatlabRefFacts } from './matlab-ref-facts';
import { GuardScope, type MatlabGuard } from './matlab-guards';
import { MATLAB_ANCHORED_BASE, MATLAB_ANCHORED_STRIDE } from './matlab-places';
import {
  HOLE,
  MAX_TEXT,
  NAME_SHAPED,
  argValue,
  bracesIndex,
  callArgs,
  callersUnknown,
  chainHead,
  childField,
  commandItems,
  errorVariable,
  evaluate,
  fieldOf,
  isColonIndex,
  isCutName,
  isOneBuiltStruct,
  literalIndex,
  namedChildren,
  noteParsedText,
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
  loadMakesUnlisted,
  loadedNames,
  matlabClearOf,
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
 *                 (`uicontrol('Callback', 'dialpane(''ViewGain'')')`,
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
 *                 caller passes (`feval(basisf, S)`), and under which tests
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
  for (const c of namedChildren(node)) {
    if (c.type === 'comment') continue;
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
    // A name the parser cut out of a word says nothing (see isCutName).
    if (parts.some(isCutName)) continue;
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
    .split(MATLAB_LINE_END)
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
 * `s.f{1}(k, :) = …`, `CF.(name).Monitor.Params{1} = …`, `[a.b, c(2)] = …` —
 * reached up the chain (a call's callee, a field chain's parts, the outputs'
 * list), never through an index's arguments, which are read.
 */
function isAssignmentTarget(node: SyntaxNode): boolean {
  let n = node;
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (p.type === 'assignment') return childField(p, 'left')?.id === n.id;
    if (p.type === 'field_expression' || p.type === 'multioutput_variable') continue;
    if (p.type === 'function_call' && childField(p, 'name')?.id === n.id) continue;
    return false;
  }
  return false;
}

/**
 * Whether a field chain is the middle of a longer one: the grammar reads
 * `CF.Q2.Level.P{1}(6, :)` as `CF.(Q2.Level.P{1})(6, :)`, so the inner
 * chain's head `Q2` is a field of `CF`, not a variable, a package or a class.
 */
function isInnerChain(node: SyntaxNode): boolean {
  const call = node.parent;
  if (call?.type !== 'function_call' || childField(call, 'name')?.id !== node.id) return false;
  const outer = call.parent;
  return outer?.type === 'field_expression' && childField(outer, 'object')?.id !== call.id;
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
  /**
   * In an old-style class's constructor (`@Gizmo/Gizmo.m`): its output holds
   * nothing on entry, and is the object only once the body makes it
   * (`obj = class(s, 'Gizmo')`: see ownObjectKept). A classdef's
   * constructor is given the object.
   */
  made?: true;
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
  /**
   * Variable → the class its every assignment that may construct names, a
   * lower-case callee's included (`g = gadget();` → `gadget`: an old-style
   * class's constructor is named so, `@gadget/gadget.m`): read for a call's
   * dispatch alone (see dispatchClass), where the resolver takes the
   * class's method only when the name is a class that has one and the path
   * otherwise. Never a member call's receiver: `s = load_cfg(); s.tol(1)`
   * reads a field of what a function returned.
   */
  dispatchHints?: ReadonlyMap<string, ClassHint>;
  /** A function's or a script's writes, for where a call's class hint holds (see hintHolds). */
  hintWrites?: HintWrites;
  /**
   * In a method, variable → its class, for the method's own object when the
   * method never writes it whole and no write it cannot see may (see
   * objectCopyHints), and for a variable that takes nothing but that object
   * or an element of it (`e = ets(i)`): read for a call's dispatch only (see
   * argumentDispatchClass), never a member call's receiver.
   */
  copyHints?: ReadonlyMap<string, ClassHint>;
  /**
   * In a method whose class's own superclass list names a
   * `matlab.mixin.indexing.*` class (`RedefinesParen`): false — `obj(k)` runs
   * the class's own indexing there, which may return anything, so an element
   * of `copyHints`' variables is no object of the class.
   */
  elementsOfClass?: boolean;
  /** In a function, the variables it writes what is no object with, or declares global (see ScopeFacts.opaque): see mayHoldObject. */
  opaque?: ReadonlySet<string>;
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
   * In a function, the names of `runtime` that a `load` name list alone makes
   * (`load(f, 'a')`), with those loads, placed, and the function's clears: a
   * read is of a name made at runtime only where one of the loads may have
   * run before it (see loadReaches); a read before every one is a call,
   * MATLAB doc 'load' (a variable is there once the load has run).
   */
  runtimeLoads?: { sites: ReadonlyMap<string, readonly Placed[]> } & ClearSites;
  /**
   * A script's top level: each of its variables written where the walk can
   * place it (see ScopeFacts.writeSites), with its writes, placed, and the
   * script's clears. A script's reads go in text order (the user's ruling,
   * step 11): a read with no write of the name before it in text order (see
   * writeReaches) reads no variable of the script's, and is a call.
   * A name written where no place is known (by code `eval` runs) is a
   * variable everywhere.
   */
  textOrder?: { sites: ReadonlyMap<string, readonly Placed[]> } & ClearSites;
  /**
   * In a function, a script's top level or code `eval` runs where it is: the
   * `load`s there that may make names the code does not spell (see
   * LoadSites). A name no variable there read after one may be one it made:
   * its reference carries the `runtime` fact (see loadMayMake).
   */
  loads?: LoadSites;
  /** Code `eval` runs where it is: the argument that gives it, in the tree of the code around (its place in that code's text order). */
  at?: SyntaxNode;
  /**
   * A function that is nested, or holds nested functions: its workspace is
   * static, and MATLAB refuses a `load` there that would add a variable its
   * code does not spell ("Attempt to add … to a static workspace"), so no
   * load there makes a name the code does not spell (see addRuntimeNames).
   */
  staticWorkspace?: boolean;
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
  /** The assignments that construct it (`g = Gizmo(…)`), by node id: where a call's dispatch takes it (see hintHolds). */
  sites?: ReadonlySet<number>;
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
 * assignments only (it may reassign its parent's variable). `at`, for a
 * call's dispatch: the argument read there, where the hint holds only if
 * every write of `v` that may reach it constructs the class (see hintHolds).
 */
function classHintOf(f: Frame, v: string, dispatch = false, at?: SyntaxNode): ClassHint | undefined {
  return classHintKept(f, v, dispatch, at)?.hint;
}

/** No condition on a hint (see Kept). */
const NONE_KEPT: ReadonlySet<string> = new Set();

/**
 * A class hint where it is read, with what it holds on (see classHintOf):
 * `kept`, the MATLAB functions the object went through on the way, by a
 * write that may reach the read (`x = x ~= 0`: `ne`), which give an object
 * of the class back only when the class defines or inherits a method of the
 * name (see keepsObject): the resolver's to ask (the `keptBy` fact).
 */
interface Kept {
  hint: ClassHint;
  kept: ReadonlySet<string>;
}

/** classHintOf, with the hint's conditions (see Kept). */
function classHintKept(f: Frame, v: string, dispatch = false, at?: SyntaxNode): Kept | undefined {
  let g = f;
  let pos = at;
  while (g.kind === 'lambda' || g.kind === 'eval') {
    // What eval'd code assigns hides what the code around it said.
    const own = g.classHints.get(v);
    if (own) return { hint: own, kept: NONE_KEPT };
    if (g.locals.has(v)) return undefined;
    // Code `eval` runs reads at the `eval`'s place in the code around; a lambda where it is written.
    if (g.kind === 'eval' && g.at) pos = g.at;
    g = g.parent!;
  }
  const hint = g.classHints.get(v) ?? (dispatch ? g.dispatchHints?.get(v) : undefined);
  if (!hint) {
    // Constructed as two classes: the first, in the order of their first constructions in the text, that holds
    // where the read is (hintHolds). Two may both hold (`k = gadget(); k = widget(k)`: keepsObject reads a
    // lower-case callee's call through, so `gadget`'s construction reaches past `widget`'s): the earlier one,
    // `gadget`, whichever read comes first, as the order is the text's.
    const choices = hintChoices(g.classHints, v) ?? (dispatch ? hintChoices(g.dispatchHints, v) : undefined);
    if (!choices || !pos || !g.hintWrites) return undefined;
    for (const choice of choices) {
      const kept = hintHolds(g.hintWrites, v, choice, pos);
      if (kept) return { hint: choice, kept };
    }
    return undefined;
  }
  if (!pos || !g.hintWrites) return { hint, kept: NONE_KEPT };
  const kept = hintHolds(g.hintWrites, v, hint, pos);
  return kept ? { hint, kept } : undefined;
}

/**
 * A function's or a script's writes, read for where a class hint holds (see
 * hintHolds): its ScopeFacts.writeSites and clears, with what holds a value
 * on entry (a parameter, a nested function's shared variable), and each
 * name's whole writes, placed, once asked.
 */
interface HintWrites {
  facts: Pick<ScopeFacts, 'writeSites' | 'clears' | 'clearedAt' | 'clearedBy'>;
  scope: SyntaxNode;
  source: string;
  input: (v: string) => boolean;
  /**
   * The class a variable of the scope holds where `at` reads it, by the
   * hints' reaching rule (a class hint's, or the method's own object: see
   * classHintOf, isOwnObject), for keepsObject's elements; undefined when
   * the code does not say.
   */
  classAt: (w: string, at: SyntaxNode) => string | undefined;
  /** Each name's whole writes that do not keep its object, placed, by name and the hint's class (see hintWritesPlaced). */
  placed: Map<string, PlacedWrites>;
  /** The keys of `placed` being worked out: one asked again while it is holds no class (see hintWritesPlaced). */
  computing: Set<string>;
  /** How many times an ask found its key being worked out: an answer worked out past one is not kept (see hintWritesPlaced). */
  cycles: number;
  /** The method's own object's whole writes that do anything but keep it, placed, with what each does (see ownObjectKept). */
  own: Map<string, Array<{ at: Placed; kind: string }>>;
  clears?: ClearSites;
}

/** A hint's class when it holds with no condition (see Kept): an element of a concatenation asks no method of its class. */
function heldWithoutCondition(held: Kept | undefined): string | undefined {
  return held && held.kept.size === 0 ? held.hint.cls : undefined;
}

/** HintWrites for `scope`. */
function hintWritesOf(facts: ScopeFacts, scope: SyntaxNode, source: string, input: (v: string) => boolean, classAt: HintWrites['classAt']): HintWrites {
  return { facts, scope, source, input, classAt, placed: new Map(), computing: new Set(), cycles: 0, own: new Map() };
}

/**
 * Whether write site `site` of `v` (see ScopeFacts.writeSites) writes it
 * whole: an assignment to `v` itself (`v = …`, `[v, w] = …`), a loop's or a
 * `catch`'s variable, a `global` / `persistent` declaration, a `load` that
 * lists it. Not one into it (`v.f = …`, `v(k) = …`), which keeps what it is,
 * nor the array evidence that makes a function's name a variable.
 */
function writesWhole(site: SyntaxNode, v: string, source: string): boolean {
  switch (site.type) {
    case 'assignment': {
      const left = childField(site, 'left');
      if (left?.type === 'identifier') return getNodeText(left, source) === v;
      return left?.type === 'multioutput_variable' && namedChildren(left).some((o) => o.type === 'identifier' && getNodeText(o, source) === v);
    }
    case 'function_call':
      return getNodeText(childField(site, 'name') ?? site, source) === 'load';
    case 'command': {
      const cmd = namedChildren(site).find((a) => a.type === 'command_name');
      return cmd !== undefined && getNodeText(cmd, source) === 'load';
    }
    default:
      return true;
  }
}

/** The operators whose value is their function's (see keepsObject): the class's own method of the name, or MATLAB's. */
const OPERATOR_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['==', 'eq'], ['~=', 'ne'], ['!=', 'ne'], ['<', 'lt'], ['<=', 'le'], ['>', 'gt'], ['>=', 'ge'],
  ['&', 'and'], ['|', 'or'], ['~', 'not'], ['!', 'not'],
]);

/**
 * Whether assignment `site` gives `v`, which holds an object of class `cls`
 * (a class hint's), a value of that class again, so that the hint is read
 * through it; parentheses around the right side are read through. MATLAB:
 * indexing an object array with parentheses (`v = v(1)`, `v = v(2:end)`)
 * gives an array of its class, and so does its transpose (`v = v'`, `v =
 * v(end:-1:1)'`). A concatenation with `v` among its elements (or `v(…)`, a
 * transpose of either) keeps it: MATLAB gives the class, or the class's own
 * concatenation runs (project rule), or it errors (R2026a: `[k, 1]`,
 * objects of two classes) and the path reaches nothing; one without `v`
 * keeps it as concatenationHolds tells (`[w, Gizmo()]`, `[w, 5]`).
 * Not `v = v{1}` nor `v = v.prop`, whose
 * values the code does not state, nor `[]`, a double. A construction of
 * another class with `v` passed (`k = Widget(k)`) keeps it, as the update
 * idiom below (step 15 round 8b: whether `Widget` is a class is the
 * resolver's to tell; S18). And a project rule for what a call returns,
 * which the index does not follow: a call that is passed `v` (`v = f(…, v,
 * …)`) gives it back when `f` is the project's (no MATLAB function has its
 * name: the value object's update idiom, `report = update(report, x)`,
 * `obj = Zconf(obj)`, whatever the callee's case), or one of
 * OBJECT_RETURNING_BUILTINS (`a = set(a, 'v', 2)`), or an operator's form
 * of one (`a = a + 1`, `a = -a`), or a method called on `v` itself (`obj =
 * obj.scale(2)`), or a function of MATLAB's name the file defines itself
 * (see matlabNameKeeps). Any other of MATLAB's functions, and a
 * comparison's or a logical operator's form (`x = x ~= 0` is `ne`, `~x`
 * `not`, `x & y` `and`, `x && y`), calls the class's own method of the name
 * when the class defines or inherits one (doc 'Method Invocation',
 * 'Operator Overloading'), and MATLAB's otherwise: one that errors on an
 * object (ERRORING_ON_OBJECTS, MATLAB R2026a) ends no hint, since no path
 * through it reaches a later call with anything else; one that gives a
 * value of another class (VALUE_RETURNING_ON_OBJECTS: `n = numel(v)`, `c =
 * class(v)`), or any name not measured, keeps the object on the condition
 * that the class has the method, the function's name returned for the
 * resolver to ask (the `keptBy` fact: see Kept). True when the write keeps
 * it, false when it does not.
 */
function keepsObject(site: SyntaxNode, v: string, cls: string, hw: HintWrites): boolean | string {
  if (site.type !== 'assignment') return false;
  const source = hw.source;
  const right = unparenthesised(childField(site, 'right'));
  const isV = (n: SyntaxNode | null | undefined): boolean => n?.type === 'identifier' && getNodeText(n, source) === v;
  if (right?.type === 'function_call' && !bracesIndex(right)) {
    const callee = childField(right, 'name');
    if (callee?.type !== 'identifier') return false;
    const f = getNodeText(callee, source);
    if (f === v) return true;
    const args = callArgs(right);
    if (!args.some(isV)) return false;
    // `k = Zconf(k)`, `k = update(k, 2)`: a project rule, the update idiom, whatever the callee's case: a call that is
    // passed the variable itself gives back its class (step 15 round 8b). Whether `Widget` in `k = Widget(k)` is a
    // class is the resolver's to tell, and a sync would have to follow it turning between a function and a class
    // (a re-open keyed by the construction's name, not built: S18), so the write keeps the class `k` had.
    if (!MATLAB_BUILTINS.has(f)) return true;
    if (OBJECT_RETURNING_BUILTINS.has(f)) return true;
    return matlabNameKeeps(f, cls, args, isV);
  }
  if (right && OPERATOR_FORMS.has(right.type)) {
    if (!namedChildren(right).some(isV)) return false;
    // `x && y`, `x || y`: an error on an object (MATLAB R2026a), so no path through it reaches a later call.
    if (right.type === 'boolean_operator') return true;
    const op = right.type === 'not_operator' ? '~' : (right.children.find((c) => !c.isNamed)?.type ?? '');
    const f = OPERATOR_FUNCTIONS.get(op);
    // An arithmetic operator's form keeps it (project rule, step 15 round 3).
    if (f === undefined) return right.type !== 'comparison_operator';
    return ERRORING_ON_OBJECTS.has(f) ? true : f;
  }
  if (right?.type === 'postfix_operator') return isObjectOfClass(right, v, cls, hw);
  if (right?.type === 'matrix') {
    const elements = bracketParts(right).filter((r) => r.type === 'row').flatMap(bracketParts);
    if (elements.length === 0) return false;
    // `v` among the elements: MATLAB gives its class, or the class's own concatenation runs, or it errors (MATLAB
    // R2026a: `[k, 1]`, objects of two classes) and reaches nothing: the object either way (step 15 round 7).
    if (elements.some((e) => isSelfExpression(e, v, source))) return true;
    return concatenationHolds(elements, v, cls, hw);
  }
  if (right?.type === 'field_expression') {
    const parts = namedChildren(right);
    const last = parts[parts.length - 1];
    if (parts.length < 2 || last?.type !== 'function_call' || bracesIndex(last)) return false;
    // `obj = obj.scale(2)`; `v = pkg.update(v)`, `v = s.step(v)`: a package's function, another object's method.
    if (parts.length === 2 && isV(parts[0])) return true;
    return parts[0]!.type === 'identifier' && !MATLAB_BUILTINS.has(getNodeText(parts[0]!, source)) && callArgs(last).some(isV);
  }
  return false;
}

/** Whether assignment `site` constructs class `cls` (see constructedClassOf): a hint of that class's own write. */
function constructsClass(site: SyntaxNode, cls: string, source: string): boolean {
  const right = site.type === 'assignment' ? unparenthesised(childField(site, 'right')) : null;
  return right !== null && constructedClassOf(right, source) === cls;
}

/** The operator forms keepsObject reads (see OPERATOR_FUNCTIONS). */
const OPERATOR_FORMS: ReadonlySet<string> = new Set(['binary_operator', 'unary_operator', 'comparison_operator', 'not_operator', 'boolean_operator']);

/** `e` with the parentheses around it read through (`x = (x ~= 0)`: doc 'Operator Precedence'). */
function unparenthesised(e: SyntaxNode | null): SyntaxNode | null {
  let n = e;
  while (n?.type === 'parenthesis') {
    const parts = bracketParts(n);
    if (parts.length !== 1) return n;
    n = parts[0]!;
  }
  return n;
}

/** Whether `e` is `v` itself, an element of it (`v(k)`), or a transpose or a parenthesised form of those (see keepsObject). */
function isSelfExpression(e: SyntaxNode, v: string, source: string): boolean {
  const n = unparenthesised(e);
  if (!n) return false;
  if (n.type === 'identifier') return getNodeText(n, source) === v;
  if (n.type === 'function_call') {
    const callee = childField(n, 'name');
    return !bracesIndex(n) && callee?.type === 'identifier' && getNodeText(callee, source) === v && !namedChildren(n).some((c) => c.type === 'superclass');
  }
  if (n.type === 'postfix_operator') {
    const parts = bracketParts(n);
    return parts.length === 1 && isSelfExpression(parts[0]!, v, source);
  }
  return false;
}

/**
 * Whether `v = f(…, v, …)`, `f` one of MATLAB's names off the allow-list, keeps
 * `v`'s class `cls` (see keepsObject): a function of the file's own (a local
 * function, which MATLAB calls before its own; the file's main function,
 * unless it is a method file's own name called on an object of another class:
 * MATLAB R2026a runs its own function there), a method of the file's classdef
 * called on an object of its class, or one of ERRORING_ON_OBJECTS (the
 * class's own runs, or the path stops): true; otherwise `f`, the method the
 * class must have (VALUE_RETURNING_ON_OBJECTS, and any name not measured).
 */
function matlabNameKeeps(f: string, cls: string, args: readonly SyntaxNode[], isV: (n: SyntaxNode | null | undefined) => boolean): boolean | string {
  if (fileFunctions.has(f) && !(classFile && f === fileStem && cls !== fileFolderClass)) return true;
  if (cls === fileClass && fileMethods.has(f) && isV(args.find((a) => !PLAIN_VALUE_ARGS.has(a.type)))) return true;
  return ERRORING_ON_OBJECTS.has(f) ? true : f;
}

/** A matrix's or a bracket's parts, less the line continuations and comments written in it, which are no elements. */
function bracketParts(n: SyntaxNode): SyntaxNode[] {
  return namedChildren(n).filter((c) => c.type !== 'line_continuation' && c.type !== 'comment');
}

/**
 * Whether expression `e`, in a write of `v` (which holds an object of class
 * `cls`), is an object of that class (see keepsObject), as MATLAB gives one:
 * `v` itself, or another variable of the scope whose class where `e` reads
 * it is `cls` by the hints' own rule (HintWrites.classAt); an element of
 * either taken with parentheses (`v(k)`, `w(2:end)`); a construction of the
 * class (`Gizmo()`, `pkg.Gizmo(…)`, a lower-case callee's `gadget()`, as
 * the hint's own: the resolver takes the class only where a call of that
 * name reaches it, see constructedClass in ../../resolution/matlab-lookup);
 * a transpose of one (`v'`, `v.'`), one in parentheses, and a concatenation
 * concatenationHolds takes for one. Not `v{k}`, `v.prop`, a number, nor any
 * other call's value.
 */
function isObjectOfClass(e: SyntaxNode, v: string, cls: string, hw: HintWrites): boolean {
  const source = hw.source;
  /** Whether `w`, read at `at`, is `v` or a variable of the class there. */
  const variableOfClass = (w: string, at: SyntaxNode): boolean => w === v || hw.classAt(w, at) === cls;
  switch (e.type) {
    case 'identifier': {
      const w = getNodeText(e, source);
      // Any variable the hints answer for, the method's own object (which the scope need not write) too.
      return variableOfClass(w, e) || (!hw.facts.writeSites.has(w) && constructedClassOf(e, source) === cls);
    }
    case 'function_call': {
      if (bracesIndex(e) || namedChildren(e).some((c) => c.type === 'superclass')) return false;
      const callee = childField(e, 'name');
      if (callee?.type !== 'identifier') return false;
      const w = getNodeText(callee, source);
      return variableOfClass(w, callee) || (!hw.facts.writeSites.has(w) && constructedClassOf(e, source) === cls);
    }
    case 'field_expression': {
      const head = namedChildren(e)[0];
      return head?.type === 'identifier' && !hw.facts.writeSites.has(getNodeText(head, source)) && constructedClassOf(e, source) === cls;
    }
    case 'postfix_operator':
    case 'parenthesis': {
      const parts = bracketParts(e);
      return parts.length === 1 && isObjectOfClass(parts[0]!, v, cls, hw);
    }
    case 'matrix':
      return concatenationHolds(bracketParts(e).filter((r) => r.type === 'row').flatMap(bracketParts), v, cls, hw);
  }
  return false;
}

/**
 * Whether a concatenation of `elements` (`[a, 5]`), in a write of `v` (which
 * holds an object of class `cls`), is an object of that class: when at least
 * one element is one (isObjectOfClass) and no element is known to hold an
 * object of another class (heldClassOf). MATLAB R2026a gives one of three:
 * an array of the class, the class's own `horzcat` or `vertcat` run (which,
 * by the project rule, gives the object back), or an error (`[k, 5]`, `[5,
 * k]` and `[k, w]` with `w` of another class, for a classdef and an
 * old-style class alike), past which the path reaches nothing. Two known
 * classes (`[a, b]`, a `Gizmo` and a `Widget`) give no class: which one
 * MATLAB's precedence takes the index does not tell (step 15 round 7b).
 */
function concatenationHolds(elements: readonly SyntaxNode[], v: string, cls: string, hw: HintWrites): boolean {
  if (!elements.some((x) => isObjectOfClass(x, v, cls, hw))) return false;
  return !elements.some((x) => {
    const held = heldClassOf(x, v, hw);
    return held !== null && held !== cls;
  });
}

/**
 * The class element `e` of a concatenation in a write of `v` is known to
 * hold an object of (see concatenationHolds), or null: another variable's
 * class where `e` reads it (HintWrites.classAt), an element of it taken with
 * parentheses, a construction's (constructedClassOf), through a transpose,
 * parentheses or an inner concatenation (the one class its elements are
 * known to hold; '' for two). `v` itself is asked about by the caller.
 */
function heldClassOf(e: SyntaxNode, v: string, hw: HintWrites): string | null {
  const source = hw.source;
  const named = (w: string, at: SyntaxNode, n: SyntaxNode): string | null => {
    if (w === v) return null;
    return hw.classAt(w, at) ?? (hw.facts.writeSites.has(w) ? null : constructedClassOf(n, source));
  };
  switch (e.type) {
    case 'identifier':
      return named(getNodeText(e, source), e, e);
    case 'function_call': {
      if (bracesIndex(e) || namedChildren(e).some((c) => c.type === 'superclass')) return null;
      const callee = childField(e, 'name');
      return callee?.type === 'identifier' ? named(getNodeText(callee, source), callee, e) : null;
    }
    case 'field_expression': {
      const head = namedChildren(e)[0];
      return head?.type === 'identifier' && !hw.facts.writeSites.has(getNodeText(head, source)) ? constructedClassOf(e, source) : null;
    }
    case 'postfix_operator':
    case 'parenthesis': {
      const parts = bracketParts(e);
      return parts.length === 1 ? heldClassOf(parts[0]!, v, hw) : null;
    }
    case 'matrix': {
      const held = new Set<string>();
      for (const x of bracketParts(e).filter((r) => r.type === 'row').flatMap(bracketParts)) {
        const c = heldClassOf(x, v, hw);
        if (c !== null) held.add(c);
      }
      // Two known classes: no one class it holds, '' (another than any).
      return held.size === 0 ? null : held.size === 1 ? [...held][0]! : '';
    }
  }
  return null;
}

/**
 * The whole writes of `v` (see writesWhole) that do not give back its object
 * of class `cls` (see keepsObject), placed: the writes a hint of `v` stops
 * at. Worked out once per name and class; one asked for again while it is
 * worked out (a cycle of variables, `k = [w]; w = [k]` round a loop) is null:
 * the asker's element holds no class it can tell, whichever read asked first,
 * and no answer worked out past such an ask is kept (HintWrites.cycles), so
 * the next read works it out again rather than take one an earlier read's
 * order made. (A concatenation with the variable itself among its elements
 * asks no other variable: see keepsObject.)
 */
function hintWritesPlaced(hw: HintWrites, v: string, cls: string): PlacedWrites | null {
  const key = `${v}\0${cls}`;
  const known = hw.placed.get(key);
  if (known) return known;
  if (hw.computing.has(key)) {
    hw.cycles++;
    return null;
  }
  hw.computing.add(key);
  const cyclesBefore = hw.cycles;
  try {
    const writes: Placed[] = [];
    const kept: Array<{ at: Placed; name: string }> = [];
    for (const s of hw.facts.writeSites.get(v) ?? []) {
      if (!writesWhole(s, v, hw.source)) continue;
      const keeps = keepsObject(s, v, cls, hw);
      // A construction of the class is one of the hint's own writes, whatever it is passed (`k = Gizmo(k)`).
      if (keeps === false || constructsClass(s, cls, hw.source)) writes.push(placed(s, hw.scope));
      else if (typeof keeps === 'string') kept.push({ at: placed(s, hw.scope), name: keeps });
    }
    const out = Object.assign(writes, { kept });
    // Kept only when no ask inside it met a key being worked out: an answer that depends on which read asked first
    // is worked out again for each read, the same whichever comes first.
    if (hw.cycles === cyclesBefore) hw.placed.set(key, out);
    return out;
  } finally {
    hw.computing.delete(key);
  }
}

/**
 * The writes a hint stops at (see hintWritesPlaced), with `kept`: the writes
 * that pass the object to a MATLAB function, which give it back only when
 * the class has a method of the name (see keepsObject).
 */
type PlacedWrites = Placed[] & { kept: ReadonlyArray<{ at: Placed; name: string }> };

/** The names of the `kept` writes (see PlacedWrites) that may reach `p` past `enders` and `clears`. */
function keptReaching(
  writes: PlacedWrites,
  p: SyntaxNode,
  enders: readonly Placed[],
  clears: readonly Placed[],
  makes: (site: SyntaxNode) => boolean = () => false,
): ReadonlySet<string> {
  if (writes.kept.length === 0) return NONE_KEPT;
  const out = new Set<string>();
  // (One that makes the object, `obj = class(s, 'Gizmo')` for the own object, asks nothing: see makesOwnObject.)
  for (const { at, name } of writes.kept) if (!makes(at.node) && loadReaches(at, p, [...clears, ...enders], true) && !returnsAfter(at, p)) out.add(name);
  return out.size > 0 ? out : NONE_KEPT;
}

/**
 * Whether class hint `hint` of `v` holds where `p` reads it (MATLAB doc
 * 'Method Invocation': a method of the class of the argument's value at the
 * call): every whole write of `v` that may reach `p` is one of the hint's
 * constructions (one that gives `v` back from a call on it is read through:
 * see keepsObject), at least one does, and when `v` holds something on entry,
 * one comes before `p` whenever `p` runs. A write may reach `p` as a load
 * may (see loadReaches, a `try` body's reaching its `catch` clause as in
 * writeReaches), each other whole write of `v` and each clear of it ending
 * it as a clear ends a load: `g = gadget(); g = 5; tidy(g)` dispatches on a
 * double, and so does `if c, g = 5; end` between. One a `return` follows in
 * its block reaches nothing after the block (see returnsAfter).
 */
function hintHolds(hw: HintWrites, v: string, hint: ClassHint, p: SyntaxNode): ReadonlySet<string> | null {
  if (!hint.sites) return NONE_KEPT;
  const writes = hintWritesPlaced(hw, v, hint.cls);
  if (!writes) return null;
  const clears = clearsOf((hw.clears ??= clearSitesOf(hw.facts, hw.scope)), v);
  let reached = false;
  for (const s of writes) {
    if (!loadReaches(s, p, [...clears, ...writes.filter((w) => w !== s)], true) || returnsAfter(s, p)) continue;
    if (!hint.sites.has(s.node.id)) return null;
    reached = true;
  }
  if (!reached) return null;
  if (hw.input(v) && !writes.some((w) => w.node.endIndex <= p.startIndex && runsWith(w, p))) return null;
  return keptReaching(writes, p, writes, clears);
}

/**
 * The class a call's first argument `arg` may be an object of, from
 * Frame.dispatchHints alone, where dispatchClass says nothing: a variable
 * a lower-case callee made (`g = gadget(); tidy(g)`), whose callee only the
 * resolver can tell a class from a function (see MatlabRefFacts.argClass).
 */
function argumentClassHint(arg: SyntaxNode | null | undefined, source: string): { cls: string; kept: ReadonlySet<string> } | undefined {
  const f = frame();
  const first = arg?.type === 'identifier' ? getNodeText(arg, source) : null;
  // (The method's own object never comes here: dispatchClass answers for it first.)
  if (!first) return undefined;
  const held = classHintKept(f, first, true, arg!);
  return held && !isJavaClass(held.hint.cls) ? { cls: held.hint.cls, kept: held.kept } : undefined;
}

/**
 * The class of the object variable `v` holds where frame `f` reads it, or of
 * an element of it (`indexed`: `v(k)`), from Frame.copyHints: a function's
 * own, which a lambda's parameter or what eval'd code assigns hides.
 */
function copyHintOf(f: Frame, v: string, indexed = false): ClassHint | undefined {
  let g = f;
  while (g.kind === 'lambda' || g.kind === 'eval') {
    if (g.locals.has(v) || g.classHints.has(v)) return undefined;
    g = g.parent!;
  }
  if (indexed && g.elementsOfClass === false) return undefined;
  return g.copyHints?.get(v);
}

/**
 * Whether the variable `v`, where frame `f` (a function's, or code in one)
 * reads it, may hold an object of a class: a parameter, or a variable the
 * function writes nothing but calls' results, copies and elements of
 * variables to — never a text, a number, a handle, a cell, a struct, a
 * field's value or a cell's contents, and no global (whatever code
 * elsewhere put there).
 * Not a lambda's parameter: what `arrayfun` or `cellfun` passes it is an
 * element of an array or a cell's contents, of whatever class. Not in a
 * script, whose variables may be any code's.
 */
function mayHoldObject(f: Frame, v: string): boolean {
  for (let g: Frame | null = f; g; g = g.parent) {
    if (g.kind === 'lambda') {
      if (g.locals.has(v)) return false;
      continue;
    }
    if (g.kind !== 'function') return false;
    if (g.opaque?.has(v) || g.structFields.has(v)) return false;
    if (g.locals.has(v)) return true;
  }
  return false;
}

/**
 * Whether a call's first argument is a variable that may hold an object (see
 * mayHoldObject), as it is or indexed with parentheses (`f(x, …)`, `f(q(k),
 * …)`) — the `objectArg` fact (see matlab-ref-facts.ts), written only where
 * the resolver may take the call for the class's method: in a class
 * folder's function file (classFile), in a function whose first parameter
 * holds the object (not `cb(~, src)`, where the object is the one set
 * aside). The method's own object is not asked: a call on it is dispatched.
 */
function objectArgument(args: readonly SyntaxNode[], source: string): boolean {
  const f = frame();
  let top: Frame | null = null;
  for (let g: Frame | null = f; g; g = g.parent) if (g.kind === 'function') top = g;
  if (top?.params?.[0] === null) return false;
  const a = args[0];
  let v: string | null = null;
  if (a?.type === 'identifier') v = getNodeText(a, source);
  else if (a?.type === 'function_call' && !bracesIndex(a) && !namedChildren(a).some((c) => c.type === 'superclass')) {
    const callee = childField(a, 'name');
    if (callee?.type === 'identifier') v = getNodeText(callee, source);
  }
  return v !== null && isLocal(f, v) && v !== f.self?.name && mayHoldObject(f, v);
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

/**
 * Whether `name` is one code run at runtime made where frame `f` reads it,
 * at `at` (see Frame.runtime and Frame.runtimeLoads), and no variable there.
 * Code `eval` runs reads at the `eval`'s place in the code around.
 */
function isRuntimeName(f: Frame, name: string, at: SyntaxNode): boolean {
  if (isVariableAt(f, name, at)) return false;
  let pos = at;
  for (let g: Frame | null = f; g; g = g.parent) {
    if (g.runtime?.has(name)) {
      const listed = g.runtimeLoads?.sites.get(name);
      if (!listed) return true;
      const p = pos;
      const clears = clearsOf(g.runtimeLoads!, name);
      return listed.some((s) => loadReaches(s, p, clears));
    }
    if (g.kind === 'eval' && g.at) pos = g.at;
  }
  return false;
}

/** The facts of a bare reference to `name` from frame `f`, at `at`: `runtime` when code run at runtime made the name (see Frame.runtime). */
function runtimeFact(f: Frame, name: string, at: SyntaxNode): MatlabRefFacts {
  return isRuntimeName(f, name, at) ? { runtime: true } : {};
}

/**
 * Whether `name` is a variable where frame `f` reads it, at `at`: as
 * isLocal, but in a script's top level only where a write of it comes before
 * (see Frame.textOrder). Code `eval` runs reads at the `eval`'s
 * place in the code around; a lambda where it is written (it takes what is
 * a variable when it is made).
 */
function isVariableAt(f: Frame, name: string, at: SyntaxNode): boolean {
  let pos = at;
  for (let g: Frame | null = f; g; g = g.parent) {
    if (g.locals.has(name)) {
      const sites = g.textOrder?.sites.get(name);
      if (!sites) return true;
      const p = pos;
      const clears = clearsOf(g.textOrder!, name);
      return sites.some((s) => writeReaches(s, p, clears));
    }
    if (g.kind === 'eval' && g.at) pos = g.at;
  }
  return false;
}

/**
 * Whether write `s` of a script's variable comes before what is read at `p`
 * in text order, with the name still a variable there: `s` ends before `p`
 * (a read in the write itself, `x = x(2)`, comes first), in no clause of an
 * `if` / `switch` that `p` is in another clause of, nor in a `catch` clause
 * read from its `try` body (a `try` body's write may have run before the
 * statement that erred, and the `catch` clause runs after it: MATLAB doc
 * 'try, catch'), and no clear of the name that runs whenever either does
 * comes between them (as for a load: see loadReaches). Not round a loop: a read before the write in the loop's body
 * is a call on the loop's first pass, a real call, even when later passes
 * read the variable.
 */
function writeReaches(s: Placed, p: SyntaxNode, clears: readonly Placed[]): boolean {
  if (s.node.endIndex > p.startIndex) return false;
  if (s.clauses.some((c) => within(p, c.parent!) && !within(p, c) && !isTryBody(c))) return false;
  const ends = (c: Placed): boolean => runsWith(c, p) || runsWith(c, s.node);
  return !clears.some((c) => s.node.endIndex <= c.node.startIndex && c.node.endIndex <= p.startIndex && ends(c));
}

/**
 * A statement of a scope, and the parts of the scope it runs in that run only
 * sometimes, innermost first: the clauses of the `if` / `switch` / `try`
 * statements around it (a clause is a `block` or an `…_clause` child of one),
 * and the bodies of the `for` / `while` loops around it.
 */
interface Placed {
  node: SyntaxNode;
  clauses: readonly SyntaxNode[];
  loops: readonly SyntaxNode[];
}

const BRANCH_STATEMENT = /^(?:if|switch|try)_statement$/;
const LOOP_STATEMENT = /^(?:for|parfor|while)_statement$/;

/** `node` of `scope`, placed (see Placed). */
function placed(node: SyntaxNode, scope: SyntaxNode): Placed {
  const clauses: SyntaxNode[] = [];
  const loops: SyntaxNode[] = [];
  for (let n = node, p = node.parent; p && p.id !== scope.id; n = p, p = p.parent) {
    if (BRANCH_STATEMENT.test(p.type) && (n.type === 'block' || n.type.endsWith('_clause'))) clauses.push(n);
    else if (LOOP_STATEMENT.test(p.type) && n.type === 'block') loops.push(n);
  }
  return { node, clauses, loops };
}

/**
 * The `load`s of a scope that may make names its code does not spell (see
 * loadMakesUnlisted), and code an `eval` there runs that holds one: each
 * statement (the `eval` call for code it runs). And the scope's `clear` /
 * `clearvars` statements (see ClearSites), each of which ends what a load
 * before it made of the names it removes.
 */
interface LoadSites extends ClearSites {
  sites: readonly Placed[];
}

/**
 * A scope's clears, placed: the `clear` / `clearvars` statements that remove
 * every variable (ScopeFacts.clears), and by name those that name one
 * (`clear x`, `clearvars x`, `clear('x')`: ScopeFacts.clearedAt), MATLAB doc
 * 'clear'. Each ends what a write or a load before it made of the names it
 * removes (see writeReaches, loadReaches).
 */
interface ClearSites {
  clears: readonly Placed[];
  named?: ReadonlyMap<string, readonly Placed[]>;
  /** Those with a pattern (ScopeFacts.clearedBy), each with the test of the names it removes. */
  matched?: ReadonlyArray<{ at: Placed; removes: (v: string) => boolean }>;
}

/** The clears among `c` that remove `name` (see ClearSites). */
function clearsOf(c: ClearSites, name: string): readonly Placed[] {
  const named = c.named?.get(name);
  const matched = c.matched?.filter((m) => m.removes(name)).map((m) => m.at) ?? [];
  return named || matched.length > 0 ? [...c.clears, ...(named ?? []), ...matched] : c.clears;
}

/** A scope's clears, placed (see ClearSites). */
function clearSitesOf(facts: Pick<ScopeFacts, 'clears' | 'clearedAt' | 'clearedBy'>, scope: SyntaxNode): ClearSites {
  const clears = facts.clears.map((c) => placed(c, scope));
  const matched = facts.clearedBy.length > 0 ? facts.clearedBy.map((m) => ({ at: placed(m.at, scope), removes: m.removes })) : undefined;
  if (facts.clearedAt.size === 0) return { clears, ...(matched ? { matched } : {}) };
  const named = new Map<string, Placed[]>();
  for (const [v, at] of facts.clearedAt) named.set(v, at.map((c) => placed(c, scope)));
  return { clears, named, ...(matched ? { matched } : {}) };
}

/**
 * Whether `node` of `scope` runs in a `parfor` loop or an `spmd` block, whose
 * workspace a `load` that does not list its names is refused in (a
 * transparency violation). `parfor` parses as a `for_statement`.
 */
function inParallelBlock(node: SyntaxNode, scope: SyntaxNode): boolean {
  for (let p = node.parent; p && p.id !== scope.id; p = p.parent) {
    if (p.type === 'spmd_statement' || (p.type === 'for_statement' && p.child(0)?.type === 'parfor')) return true;
  }
  return false;
}

/** The load sites and clears of `scope`, placed (see LoadSites), less sites in a parallel block (see inParallelBlock); undefined when no site is left. */
function loadSitesOf(sites: readonly SyntaxNode[], facts: Pick<ScopeFacts, 'clears' | 'clearedAt' | 'clearedBy'>, scope: SyntaxNode): LoadSites | undefined {
  const kept = sites.filter((s) => !inParallelBlock(s, scope));
  if (kept.length === 0) return undefined;
  return { sites: kept.map((s) => placed(s, scope)), ...clearSitesOf(facts, scope) };
}

/** Whether clause `c` (see Placed) is the body of a `try` statement, whose `catch` clause runs after part of it may have. */
function isTryBody(c: SyntaxNode): boolean {
  return c.type === 'block' && c.parent?.type === 'try_statement';
}

/** Whether `inner` lies within `outer`'s text. */
function within(inner: SyntaxNode, outer: SyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/** Whether placed statement `c` runs whenever `n` does: every clause and loop body around `c` holds `n` too. */
function runsWith(c: Placed, n: SyntaxNode): boolean {
  return c.clauses.every((r) => within(n, r)) && c.loops.every((r) => within(n, r));
}

/**
 * Whether load site `s` may have run before what is read at `p` (not part of
 * the load itself), with what it made still there: a loop body holds both
 * (a read before it runs after it on the next pass), or it comes before `p`
 * in text order, in no clause of an `if` / `switch` / `try` that `p` is in
 * another clause of (`if a, load(f), else, x = g(1); end`: `g` is called
 * when the load did not run; `try, load(f), catch, …`: the catch runs when
 * it failed). Either way, no clear may come between them, on the way round
 * the loop for a read before the load in it, that runs whenever `p` does or
 * whenever the load does (one in a clause or a loop body neither is in may
 * not have run). `tryBodyReachesCatch`: for a write rather than a load, which
 * a `try` body may have run before the statement that erred (see
 * writeReaches).
 */
function loadReaches(s: Placed, p: SyntaxNode, clears: readonly Placed[], tryBodyReachesCatch = false): boolean {
  if (within(p, s.node)) return false;
  const ends = (c: Placed): boolean => runsWith(c, p) || runsWith(c, s.node);
  const loop = s.loops.find((l) => within(p, l));
  if (loop && s.node.endIndex > p.startIndex) {
    return !clears.some((c) => within(c.node, loop) && (c.node.startIndex >= s.node.endIndex || c.node.endIndex <= p.startIndex) && ends(c));
  }
  if (s.node.endIndex > p.startIndex) return false;
  if (!loop && s.clauses.some((c) => within(p, c.parent!) && !within(p, c) && !(tryBodyReachesCatch && isTryBody(c)))) return false;
  return !clears.some((c) => s.node.endIndex <= c.node.startIndex && c.node.endIndex <= p.startIndex && ends(c));
}

/**
 * Whether a name read at `at` in frame `f` (and no variable there) may be one
 * a `load` that does not list its names made (see Frame.loads and
 * loadReaches). Code `eval` runs where it is reads at the `eval`'s place in
 * the code around. A function's own workspace ends the walk: a nested
 * function and its parent have a static one, where no load may make a name
 * the code does not spell (see addRuntimeNames), and another function of the
 * file is another workspace.
 */
function loadMayMake(f: Frame, at: SyntaxNode, name: string): boolean {
  let pos = at;
  for (let g: Frame | null = f; g; g = g.parent) {
    const loads = g.loads;
    const p = pos;
    const clears = loads ? clearsOf(loads, name) : [];
    if (loads?.sites.some((s) => loadReaches(s, p, clears))) return true;
    if (g.kind === 'function') return false;
    if (g.kind === 'eval' && g.at) pos = g.at;
  }
  return false;
}

/** Arguments written as what no index of an array is: a text, a handle, a function, a cell. */
const NO_INDEX_ARGS: ReadonlySet<string> = new Set(['string', 'handle_operator', 'lambda', 'cell']);

/**
 * Whether `f(…)` reads as no index of an array, whatever a `load` made: a
 * statement of its own that passes arguments, or whose display a `;` turns
 * off (`hz_mark(x, y)`, `slab37(50, 1);`: an index there would do nothing
 * but show the value, which code leaves to a debugging session; a call for
 * its effect is what such a statement is), several outputs (`[a, b] =
 * f(x)`: an array's index gives one), or passing what no
 * array is indexed by — a text or a handle (`sigtag('HaltFeed')`, `g(@h)`),
 * written so or as its record says (see MatlabCallArgs), a function, a cell,
 * or a struct the caller built (`tk_analysis(cfg)`).
 */
function readsAsCall(call: SyntaxNode, args: MatlabCallArgs | undefined): boolean {
  if (isStatement(call) && (call.nextSibling?.type === ';' || callArgs(call).length > 0)) return true;
  const p = call.parent;
  if (p?.type === 'assignment' && childField(p, 'right')?.id === call.id && childField(p, 'left')?.type === 'multioutput_variable') return true;
  if (callArgs(call).some((a) => NO_INDEX_ARGS.has(a.type))) return true;
  if (!args) return false;
  return Object.values(args).some((v) => argItemsOf(v).some((x) => (typeof x === 'string' && (x.startsWith("'") || x.startsWith('@'))) || (typeof x === 'object' && 'o' in x)));
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
  constructions: Array<{ v: string; head: string; cls: string; bare: boolean; at: SyntaxNode }>;
  /**
   * `v = name(…)` / `v = name` for a lower-case `name` that is no variable and
   * no built-in's: a call whose value may be an object of a class of that
   * name (`g = gadget();`, an old-style class's constructor, `@gadget/
   * gadget.m`) or anything a function returns. Read for a call's dispatch
   * alone (see Frame.dispatchHints), in the shape of `constructions`.
   */
  lowerConstructions: Array<{ v: string; head: string; cls: string; bare: boolean; at: SyntaxNode }>;
  /**
   * `v = w`, `v = w(…)` (parentheses), `for v = w`: the variable and the one it
   * takes a copy of, or an element (`element`: the last two) — an object of
   * `w`'s class when `w` holds one (see objectCopyHints).
   */
  objectCopies: Array<{ v: string; from: string; element: boolean }>;
  /** How many times each name is written whole: an assignment's own target, an output of a multiple assignment, a loop's, a `catch`'s, a `global` or `persistent` declaration's. */
  writes: Map<string, number>;
  /**
   * The names written here with what is no object of the project's: a value
   * of itself (a text, a handle, a cell, a struct, a text built: see
   * `valued`), a number, a field's value or a cell's contents (`v = w.f`,
   * `v = w{k}`, `for v = w.f`), and the globals declared here (see
   * Frame.opaque).
   */
  opaque: Set<string>;
  structFields: Set<string>;
  /** The code arguments of the `eval` / `evalc` calls here (`eval(code, catchCode)`), with the name called and the call. */
  evalCodes: Array<{ callee: string; arg: SyntaxNode; call: SyntaxNode }>;
  /** The names `load(f, 'a', 'b')` / `load f a b` statements here make (in a script, variables too). */
  loaded: Set<string>;
  /** Each of those names, with the `load` statements that list it. */
  loadedAt: Map<string, SyntaxNode[]>;
  /**
   * Each name written here (see `locals`), with the statements that write it:
   * an assignment of any form, a loop's, a `catch`'s, a `global` or
   * `persistent` declaration, a `load` that lists it. Read for a script's
   * top level, whose reads go in text order (see Frame.textOrder).
   */
  writeSites: Map<string, SyntaxNode[]>;
  /** The `load` statements here that may make names they do not spell (`load f`, `load(f)`: see loadMakesUnlisted), in text order. */
  loads: SyntaxNode[];
  /**
   * The `clear` / `clearvars` statements here that remove every variable
   * (`clear`, `clear all`, or one whose names are not known: see
   * matlabClearOf), in text order.
   */
  clears: SyntaxNode[];
  /** Each name a `clear` / `clearvars` here names (`clear x`, `clear('x')`), with those statements: each ends what wrote the name. */
  clearedAt: Map<string, SyntaxNode[]>;
  /** The `clear` / `clearvars` statements here with a pattern (`clear xa*`, `-regexp`, `-except`), each with the test of the names it removes. */
  clearedBy: Array<{ at: SyntaxNode; removes: (v: string) => boolean }>;
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
  /**
   * Whether code here may write a variable where no assignment shows it:
   * code run as text (`eval`, `evalc`, `evalin`, `assignin`), a script run
   * (`run`, or a statement that may run one). A `load` is `loads` and
   * `loaded`'s to say. See objectCopyHints.
   */
  hiddenWrites: boolean;
  /** Whether functions are nested in it, which share its variables. */
  nested: boolean;
  /**
   * In a script: the names it leaves in the workspace that runs it, read in
   * text order. Those assigned, declared `global` or `load`ed since the last
   * `clear` that removes them (see matlabClearOf: every variable, the names
   * it lists, the ones its pattern matches, the globals declared before
   * it); a `persistent` declaration (refused outside a function) makes none.
   * Unused in a function.
   */
  made: Set<string>;
}

/** Calls that may set names the code does not spell: a `load`, a `clear`, code run by `eval`, a script `run`. */
const CLOBBERING_CALL = /^(?:load|clear|clearvars|eval|evalc|evalin|run)$/;

/** Calls that may write a variable no assignment shows (see ScopeFacts.hiddenWrites). */
const HIDDEN_WRITER = /^(?:eval|evalc|evalin|assignin|run)$/;

/** Calls whose value the interpreter computes (see evaluateCall in matlab-values.ts). */
const VALUE_CALLS = /^(?:struct|strcat|sprintf|upper|lower|strtrim|deblank|char|func2str|str2func|mfilename)$/;

/**
 * `Cls(…)` / `pkg.Cls(…)` (MATLAB names classes in UpperCamelCase): [head,
 * class] — a capitalised callee that is no variable reads as a constructor.
 * So does a bare `Cls` (`aa = VaultStore;`), the constructor called with
 * no arguments. Not a built-in's name, either way (`x = NaN;`, `x = NaN(n,
 * 1)`, `e = MException(…)`): what it makes is MATLAB's, none of whose
 * methods is the project's. (Whether the head is a variable is the
 * caller's to ask.)
 */
function constructorShape(rhs: SyntaxNode | null, source: string): [string, string] | null {
  if (rhs?.type === 'identifier') {
    const text = getNodeText(rhs, source);
    return /^[A-Z]/.test(text) && !MATLAB_BUILTINS.has(text) ? [text, text] : null;
  }
  if (rhs?.type === 'function_call') {
    const name = childField(rhs, 'name');
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
    const name = childField(last, 'name');
    const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
    return /^[A-Z]/.test(text) ? [path[0]!, [...path, text].join('::')] : null;
  }
  return null;
}

/** A lower-case `name(…)` / `name` that may be a constructor (see ScopeFacts.lowerConstructions): the name. */
function lowerConstructorShape(rhs: SyntaxNode | null, source: string): string | null {
  const name = rhs?.type === 'identifier' ? rhs : rhs?.type === 'function_call' && !bracesIndex(rhs) ? childField(rhs, 'name') : null;
  const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
  return isMatlabLowerConstructorName(text) ? text : null;
}

/** The class a construction-shaped expression names, a lower-case callee's too (see constructorShape, lowerConstructorShape): for keepsObject. */
function constructedClassOf(n: SyntaxNode, source: string): string | null {
  return constructorShape(n, source)?.[1] ?? lowerConstructorShape(n, source);
}

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
  const lowerConstructions: ScopeFacts['lowerConstructions'] = [];
  const objectCopies: ScopeFacts['objectCopies'] = [];
  const writes = new Map<string, number>();
  const opaque = new Set<string>();
  /** `w` for a right side `w` or `w(…)` (parentheses): what `v = w(…)` may take an element of. */
  const copiedFrom = (rhs: SyntaxNode | null): string | null => {
    if (rhs?.type === 'identifier') return getNodeText(rhs, source);
    if (rhs?.type !== 'function_call' || bracesIndex(rhs) || namedChildren(rhs).some((c) => c.type === 'superclass')) return null;
    const name = childField(rhs, 'name');
    return name?.type === 'identifier' ? getNodeText(name, source) : null;
  };
  const structFields = new Set<string>();
  const evalCodes: ScopeFacts['evalCodes'] = [];
  const loaded = new Set<string>();
  const loadedAt = new Map<string, SyntaxNode[]>();
  const writeSites = new Map<string, SyntaxNode[]>();
  /** The statement the walk is at (see writeSites). */
  let site: SyntaxNode = scope;
  const wrote = (v: string, at: SyntaxNode): void => {
    const list = writeSites.get(v);
    if (list) list.push(at);
    else writeSites.set(v, [at]);
  };
  const loads: SyntaxNode[] = [];
  const clears: SyntaxNode[] = [];
  /** A `load` statement with these arguments: the names it lists, and whether it may make more (a text with a part nothing here knows says no name). */
  const loadStatement = (at: SyntaxNode, items: readonly (string | null)[]): void => {
    for (const v of loadedNames(items)) {
      loadedName(v);
      const list = loadedAt.get(v);
      if (list) list.push(at);
      else loadedAt.set(v, [at]);
      wrote(v, at);
    }
    if (loadMakesUnlisted(items.map((s) => (s !== null && s.includes(PLACEHOLDER) ? null : s)))) loads.push(at);
  };
  const assigned = new Set<string>();
  const valued = new Set<string>();
  const copies: ScopeFacts['copies'] = [];
  const passed = new Set<string>();
  let clobbers = false;
  let hiddenWrites = false;
  let nested = false;
  const scriptNames = new Set<string>();
  /** The names declared `global` so far, in walk order: the ones a `clear global` removes (see MatlabClear). */
  const globals = new Set<string>();
  const clearedAt = new Map<string, SyntaxNode[]>();
  const clearedBy: ScopeFacts['clearedBy'] = [];
  /** `v` is one of the scope's variables, made here (see ScopeFacts.made). */
  const local = (v: string): void => {
    locals.add(v);
    scriptNames.add(v);
    wrote(v, site);
  };
  const loadedName = (v: string): void => {
    loaded.add(v);
    scriptNames.add(v);
  };
  /**
   * A `clear` / `clearvars` statement with these arguments (see matlabClearOf,
   * ScopeFacts.clears, clearedAt, clearedBy, made). The names it removes are
   * no longer made from here on, in walk order: MATLAB runs a script's
   * statements in order, so an assignment after the clear makes its name
   * again (`clear xb; xb = 5;`, `clear xa*; xa1 = 5;`).
   */
  const cleared = (at: SyntaxNode, name: string, items: readonly (string | null)[]): void => {
    const removed = matlabClearOf(name, items);
    if (removed === 'all') {
      scriptNames.clear();
      clears.push(at);
      return;
    }
    if ('removes' in removed) {
      clearedBy.push({ at, removes: removed.removes });
      for (const v of [...scriptNames]) if (removed.removes(v)) scriptNames.delete(v);
      return;
    }
    // `clear global …`: the globals declared before it that it names, and no other variable.
    for (const v of 'names' in removed ? removed.names : [...globals].filter(removed.globals)) {
      scriptNames.delete(v);
      const list = clearedAt.get(v);
      if (list) list.push(at);
      else clearedAt.set(v, [at]);
    }
  };

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
        const name = childField(rhs, 'name');
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
    if (node?.type === 'identifier') {
      writes.set(name, (writes.get(name) ?? 0) + 1);
      if (from === 'value' || rhs?.type === 'number' || rhs?.type === 'field_expression' || (rhs?.type === 'function_call' && bracesIndex(rhs))) opaque.add(name);
    }
  };

  const constructed = (rhs: SyntaxNode | null): [string, string] | null => constructorShape(rhs, source);
  // Only where the extraction reads a call of the name (a reference of it the index stores: see
  // matlabFilesConstructing in ../../resolution/matlab-builtin-carriers): not an index read (`g = gadget(:)`),
  // nor a bare name on a line of text the parser could not read (see inUnreadText).
  const lowerConstructed = (rhs: SyntaxNode | null): string | null =>
    (rhs?.type === 'function_call' && indexesLikeArray(rhs)) || (rhs?.type === 'identifier' && inUnreadText(rhs, source)) ? null : lowerConstructorShape(rhs, source);

  /** `x(k) = …` makes x a variable. */
  const indexAssigned = (left: SyntaxNode): void => {
    const name = childField(left, 'name');
    if (name) local(getNodeText(name, source));
  };
  /** `v.f = …` / `v.f(k) = …`: v is a variable, and f a field the scope fills in; `s(k).f = …` makes s one. */
  const fieldAssigned = (left: SyntaxNode): void => {
    const obj = childField(left, 'object');
    if (obj?.type === 'identifier') {
      const v = getNodeText(obj, source);
      local(v);
      const parts = namedChildren(left);
      const field = parts[parts.findIndex((p) => p.id === obj.id) + 1];
      const fieldName = field?.type === 'function_call' ? childField(field, 'name') : field;
      if (fieldName?.type === 'identifier') structFields.add(`${v}.${getNodeText(fieldName, source)}`);
    } else if (obj?.type === 'function_call') indexAssigned(obj);
  };

  const walk = (n: SyntaxNode): void => {
    for (const c of namedChildren(n)) {
      site = c;
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
        case 'persistent_operator': {
          identifiersIn(c, source, locals);
          identifiersIn(c, source, assigned);
          // A declaration writes the name whole: `global e` gives it the global's value, `persistent e` the last call's (`[]` at first).
          const declared = new Set<string>();
          identifiersIn(c, source, declared);
          for (const v of declared) {
            writes.set(v, (writes.get(v) ?? 0) + 1);
            wrote(v, c);
          }
          if (c.type === 'global_operator') {
            identifiersIn(c, source, scriptNames);
            identifiersIn(c, source, opaque);
            identifiersIn(c, source, globals);
          }
          continue;
        }
        case 'identifier':
          // `setup_vars`: a statement that may run a script.
          if ((n.type === 'block' || n.type === 'source_file') && !MATLAB_BUILTINS.has(getNodeText(c, source))) clobbers = hiddenWrites = true;
          // `clear` alone removes every variable: it ends what a load before it made (see LoadSites).
          if ((n.type === 'block' || n.type === 'source_file') && /^clear(?:vars)?$/.test(getNodeText(c, source))) clears.push(c);
          break;
        case 'assignment': {
          const left = childField(c, 'left');
          const right = childField(c, 'right');
          if (left?.type === 'multioutput_variable') for (const out of namedChildren(left)) written(out, null);
          else written(left, right);
          if (left?.type === 'identifier') {
            const v = getNodeText(left, source);
            local(v);
            const right = childField(c, 'right');
            const made = constructed(right);
            const lower = made ? null : lowerConstructed(right);
            if (made) constructions.push({ v, head: made[0], cls: made[1], bare: right?.type === 'identifier', at: c });
            else if (lower) lowerConstructions.push({ v, head: lower, cls: lower, bare: right?.type === 'identifier', at: c });
            else if (right?.type === 'function_call' && /^(?:struct|load)$/.test(getNodeText(childField(right, 'name') ?? right, source))) {
              structFields.add(v);
            }
            const from = copiedFrom(right);
            if (from !== null && from !== v) objectCopies.push({ v, from, element: right?.type !== 'identifier' });
          } else if (left?.type === 'multioutput_variable') {
            // `[a, s.f, x(k), ~] = …`
            for (const out of namedChildren(left)) {
              if (out.type === 'identifier') local(getNodeText(out, source));
              else if (out.type === 'field_expression') fieldAssigned(out);
              else if (out.type === 'function_call') indexAssigned(out);
            }
          } else if (left?.type === 'function_call') indexAssigned(left);
          else if (left?.type === 'field_expression') fieldAssigned(left);
          break;
        }
        case 'iterator': {
          const [v = null, range = null] = namedChildren(c);
          if (v?.type === 'identifier') local(getNodeText(v, source));
          written(v, range);
          // `for e = ets`: each column of the array ets, an object of its class.
          const from = v?.type === 'identifier' ? copiedFrom(range) : null;
          if (from !== null && from !== getNodeText(v!, source)) objectCopies.push({ v: getNodeText(v!, source), from, element: true });
          break;
        }
        case 'catch_clause': {
          // `catch ME` — the error variable is on the `catch` line. An
          // identifier on a later line is a statement (a command-syntax call).
          const v = errorVariable(c);
          if (v) {
            // Written on the `catch` line: the clause's body reads it.
            site = v;
            local(getNodeText(v, source));
          }
          written(v, null);
          break;
        }
        case 'function_call': {
          const callee = childField(c, 'name');
          if (callee?.type !== 'identifier') break;
          // Not a chain's field (`s.c{k}`, `obj.load(f)`).
          if (n.type === 'field_expression' && childField(n, 'object')?.id !== c.id) break;
          const name = getNodeText(callee, source);
          if (name === 'load' && isStatement(c)) {
            loadStatement(c, callArgs(c).map((a) => stringLiteral(a, source)));
          } else if ((name === 'clear' || name === 'clearvars') && isStatement(c)) {
            cleared(c, name, callArgs(c).map((a) => stringLiteral(a, source)));
          } else if (name === 'eval' || name === 'evalc') {
            for (const arg of callArgs(c).slice(0, 2)) evalCodes.push({ callee: name, arg, call: c });
          }
          const args = callArgs(c);
          if (CLOBBERING_CALL.test(name) || (args.length === 0 && isStatement(c) && !MATLAB_BUILTINS.has(name))) clobbers = true;
          if (HIDDEN_WRITER.test(name) || (args.length === 0 && isStatement(c) && !MATLAB_BUILTINS.has(name))) hiddenWrites = true;
          if (!MATLAB_BUILTINS.has(name)) {
            for (const a of args) {
              const head = a.type === 'identifier' || a.type === 'field_expression' || (a.type === 'function_call' && bracesIndex(a)) ? chainHead(a) : null;
              if (head) passed.add(getNodeText(head, source));
            }
          }
          // `c{k}` / `a(end)` in a function: c and a are its variables.
          if (isFunction && arrayEvidence(c) === 'variable') local(name);
          break;
        }
        case 'command': {
          const cmd = namedChildren(c).find((a) => a.type === 'command_name');
          // A command whose name the parser cut out of a word (see isCutName) says nothing.
          if (!cmd) break;
          const name = getNodeText(cmd, source);
          if (CLOBBERING_CALL.test(name) || !MATLAB_BUILTINS.has(name)) clobbers = true;
          if (HIDDEN_WRITER.test(name) || !MATLAB_BUILTINS.has(name)) hiddenWrites = true;
          if (name === 'clear' || name === 'clearvars') cleared(c, name, commandItems(c, source));
          if (name !== 'load') break;
          loadStatement(c, commandItems(c, source));
          break;
        }
      }
      walk(c);
    }
  };
  walk(scope);
  if (!isFunction) for (const v of loaded) locals.add(v);
  return { locals, constructions, lowerConstructions, objectCopies, writes, opaque, structFields, evalCodes, loaded, loadedAt, writeSites, loads, clears, clearedAt, clearedBy, assigned, valued, copies, passed, clobbers, hiddenWrites, nested, made: scriptNames };
}

/**
 * The class a variable holds, where every constructor-shaped assignment to it
 * agrees. A Java class's (`m = javax.swing.JFrame()`) is one too, and says
 * that what is called on the variable is Java's: see isJavaClass. Not one
 * whose callee is a function of the file (`g = Gizmo();` beside a local
 * function `Gizmo`, which comes before a class of the name: MATLAB doc
 * 'Function Precedence Order'): that assignment constructs nothing.
 */
function classHintsFrom(facts: ScopeFacts, isVariable: (name: string) => boolean): ReadonlyMap<string, ClassHint> {
  if (facts.constructions.length === 0) return NO_HINTS;
  const byClass = new Map<string, Map<string, ClassHint & { sites: Set<number> }>>();
  for (const { v, head, cls, bare, at } of facts.constructions) {
    if (isVariable(head)) continue; // `c = cfg.Make()` on a variable `cfg`: a field's value
    if (isFileFunctionHead(head)) continue;
    let classes = byClass.get(v);
    if (!classes) byClass.set(v, (classes = new Map()));
    const had = classes.get(cls);
    if (had) {
      had.bare &&= bare;
      had.sites.add(at.id);
    } else classes.set(cls, { cls, bare, sites: new Set([at.id]) });
  }
  // A variable constructed as two classes (`k = Gizmo(); k = Widget(k);`) has no hint of its own; where a read is
  // placed, the one whose constructions alone reach it holds (see classHintKept).
  const hints = new Map<string, ClassHint>();
  const choices = new Map<string, ClassHint[]>();
  for (const [v, classes] of byClass) {
    if (classes.size === 1) hints.set(v, [...classes.values()][0]!);
    else choices.set(v, [...classes.values()]);
  }
  return choices.size > 0 ? Object.assign(hints, { choices }) : hints;
}

/** The hints of each class a variable is constructed as, when it is two or more (see classHintsFrom). */
function hintChoices(hints: ReadonlyMap<string, ClassHint> | undefined, v: string): readonly ClassHint[] | undefined {
  return (hints as { choices?: ReadonlyMap<string, ClassHint[]> } | undefined)?.choices?.get(v);
}

/**
 * Whether a constructor-shaped callee `head` is a function of the file being
 * walked (see fileFunctions): a local or nested one, or the file's own, which
 * a call of the name from the file reaches before any class (MATLAB doc
 * 'Function Precedence Order'). Not a class folder's file's own (`@gadget/
 * gadget.m`, an old-style class's constructor: its class's).
 */
function isFileFunctionHead(head: string): boolean {
  return fileFunctions.has(head) && !(classFile && head === fileStem);
}

/** Frame.dispatchHints: classHintsFrom over every assignment that may construct, a lower-case callee's too; none when there is none of those. */
function dispatchHintsFrom(facts: ScopeFacts, isVariable: (name: string) => boolean): ReadonlyMap<string, ClassHint> | undefined {
  if (facts.lowerConstructions.length === 0) return undefined;
  return classHintsFrom({ ...facts, constructions: [...facts.constructions, ...facts.lowerConstructions] }, isVariable);
}

/**
 * In a method, the variables that hold its own object `self` or an element of
 * it: `self` itself, and those that take nothing but it or an element of it
 * (`new = this;`, `e = ets(i);`, `for e = ets`, `b = a(1)` after `a = this`):
 * an object of its class, which MATLAB's own indexing gives inside the
 * class's methods (`elements`: not where the class's own superclass list
 * names a `matlab.mixin.indexing.*` class, whose indexing the class writes —
 * then only `self` and its whole copies).
 *
 * Every write of each of them must be seen:
 *   - none when the method writes `self` whole (`ets = double(ets)`: it may
 *     hold anything after), or when a write may hide from the function's own
 *     assignments — a nested function (or the function is one: they share
 *     its workspace), code run as text or a script run (see
 *     ScopeFacts.hiddenWrites), a `load` that may make names it does not
 *     list (ScopeFacts.loads);
 *   - every whole write of a copy is one of those shapes: `e = ets(i); e =
 *     3;` says nothing, nor does a `load` that lists it, nor a `global` or
 *     `persistent` declaration of it (ScopeFacts.writes).
 * None in an operator method (`plus(a, b)`, OPERATOR_METHODS): MATLAB calls
 * it when any operand is an object of the class, so its first parameter
 * may hold a number (`2 + c`).
 * Not a parameter (what it holds first is the caller's), nor a variable a
 * construction names (`hints`, classHintsFrom's to say). Only the method's
 * own object: a variable constructed (`q = Shape(…)`) may hold what a
 * function of a capitalised name returns, which a dispatch on an element of
 * it would take for an object of a class of that name.
 */
function objectCopyHints(
  hints: ReadonlyMap<string, ClassHint>,
  facts: ScopeFacts,
  self: Self | null,
  params: ReadonlySet<string>,
  nested: boolean,
  elements: boolean,
  name: string,
): ReadonlyMap<string, ClassHint> {
  if (!self || OPERATOR_METHODS.has(name) || nested || facts.nested || facts.hiddenWrites || facts.loads.length > 0) return NO_HINTS;
  if ((facts.writes.get(self.name) ?? 0) > 0 || facts.loaded.has(self.name)) return NO_HINTS;
  const own: ClassHint = { cls: self.cls, bare: false };
  const out = new Map<string, ClassHint>([[self.name, own]]);
  const sources = new Map<string, string[]>();
  for (const { v, from, element } of facts.objectCopies) {
    if (hints.has(v) || params.has(v) || v === self.name || facts.loaded.has(v)) continue;
    // Not an element where the class indexes itself: the copy is then known to hold nothing.
    const list = sources.get(v) ?? [];
    list.push(element && !elements ? '' : from);
    sources.set(v, list);
  }
  // A copy of a copy (`a = this; b = a(1);`) is known once the first is: a few rounds settle any chain the code writes.
  for (let round = 0, grew = true; grew && round < 4; round++) {
    grew = false;
    for (const [v, froms] of sources) {
      if (out.has(v) || froms.length !== (facts.writes.get(v) ?? 0)) continue;
      if (!froms.every((w) => out.has(w))) continue;
      out.set(v, own);
      grew = true;
    }
  }
  return out;
}

/**
 * The methods MATLAB calls for an operator (`a + b` → `plus(a, b)`), and for
 * indexing and concatenation, any of whose operands may be the object: the
 * operator table of "Implementing Operators for Your Class".
 */
const OPERATOR_METHODS: ReadonlySet<string> = new Set([
  'plus', 'minus', 'uminus', 'uplus', 'times', 'mtimes', 'rdivide', 'ldivide', 'mrdivide', 'mldivide', 'power', 'mpower',
  'lt', 'gt', 'le', 'ge', 'ne', 'eq', 'and', 'or', 'not', 'colon', 'ctranspose', 'transpose', 'horzcat', 'vertcat',
  'subsref', 'subsasgn', 'subsindex',
]);

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
  const first = args ? namedChildren(args)[0] : undefined;
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
  /** Where on `at`'s line the name starts, when not where `at` does; `anchored` for a name no text written at `at` spells (see unplacedRefs). */
  column: number | 'anchored' = at.startPosition.column,
): UnresolvedReference | undefined {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  // A keyword is never a name (see hasMatlabKeywordPart).
  if (!fromNodeId || !name || hasMatlabKeywordPart(name)) return undefined;
  const candidates = matlabRefCandidates(facts);
  const anchored = column === 'anchored';
  const ref: UnresolvedReference = {
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: (anchored ? at.endPosition.row : at.startPosition.row) + 1,
    column: anchored ? at.endPosition.column : column,
    ...(candidates ? { candidates } : {}),
  };
  // A name no text written there spells, which a value gives (see anchoredRefs): placed once the file is walked.
  if (anchored) unplacedRefs.add(ref);
  ctx.addUnresolvedReference(ref);
  if (anchored && codeDepth === 0) refPlaces.push(ref);
  return ref;
}

/**
 * The calls the file's walk read as a lower-case callee's construction (`g =
 * gadget(…)`, `g = gadget;`), by the callee's name lowered, and the names of
 * the ones an on-object call under a built-in's name was read on (`disp(g)`:
 * the A10 rows, see matlabBuiltinDispatchKept in
 * ../../resolution/matlab-failures). Once the file is walked, those
 * constructions carry the `ctor` fact: the evidence a class of the name
 * arriving may give the file such rows to write (matlabFilesConstructing in
 * ../../resolution/matlab-builtin-carriers). Set while extractFile walks
 * the file.
 */
let ctorRefs: Array<{ key: string; ref: UnresolvedReference }> = [];
let a10Keys: Set<string> = new Set();

/** Notes `ref`, written at `node`, when `node` is the right side of `v = name(…)` / `v = name` a lower-case construction reads (see ctorRefs). */
function noteConstruction(node: SyntaxNode, ref: UnresolvedReference | undefined, source: string): void {
  const parent = node.parent;
  if (!ref || parent?.type !== 'assignment' || childField(parent, 'right')?.id !== node.id || childField(parent, 'left')?.type !== 'identifier') return;
  const name = lowerConstructorShape(node, source);
  if (name) ctorRefs.push({ key: name.toLowerCase(), ref });
}

/** Gives the `ctor` fact to the constructions of ctorRefs an on-object call was read on (see ctorRefs). */
function tagConstructions(): void {
  for (const { key, ref } of ctorRefs) {
    if (!a10Keys.has(key) || ref.candidates?.includes(CTOR_TAG)) continue;
    // Before the `args` fact, which an edge keeps apart and a resurrected reference puts back last (see splitMatlabArgs).
    const cands = ref.candidates ?? [];
    const at = cands.findIndex(isMatlabArgsCandidate);
    ref.candidates = at < 0 ? [...cands, CTOR_TAG] : [...cands.slice(0, at), CTOR_TAG, ...cands.slice(at)];
  }
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
function memberRef(path: string[], member: string, at: SyntaxNode): MemberRef | null {
  const f = frame();
  const head = path[0]!;
  if (f.self && head === f.self.name) return path.length === 1 ? { name: `${f.self.cls}::${member}`, self: true } : null;
  // In a script, a head read before every write of it in text order is no variable there (see isVariableAt).
  if (isVariableAt(f, head, at)) {
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
  const object = childField(node, 'object');
  if (object?.type !== 'identifier') return null;
  const path = [getNodeText(object, source)];
  for (const f of namedChildren(node).slice(1)) {
    if (f.type === 'identifier') {
      path.push(getNodeText(f, source));
      continue;
    }
    if (f.type !== 'function_call') return null;
    const callee = childField(f, 'name');
    if (callee?.type !== 'identifier' || indexesLikeArray(f)) return null;
    const ref = memberRef(path, getNodeText(callee, source), node);
    return ref ? { ...ref, at: f } : null;
  }
  return path.length >= 2 ? bareMemberRef(node, path.slice(0, -1), path[path.length - 1]!) : null;
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
 * that is no variable (a class or a package, at any depth: `b =
 * pkg.sub.low;` calls `pkg.sub.low`, doc 'Namespaces'). On any other
 * variable it is a struct's field far more often than a method of one class
 * (`data.smprate`): nothing. Nor deeper on a variable (`obj.p.m`, a
 * property's value), nor in a statement the parser could not read whole
 * (text that is no code: `core_dump_77413.log` in a listing pasted into a
 * file).
 */
function bareMemberRef(node: SyntaxNode, path: string[], member: string): (MemberRef & { at: SyntaxNode; bare: true }) | null {
  if (inUnreadStatement(node)) return null;
  const f = frame();
  const head = path[0]!;
  const own = f.self !== null && head === f.self.name;
  const variable = !own && isVariableAt(f, head, node);
  if (variable && !classHintOf(f, head)) return null;
  // `gcf.Position`: a property of what a built-in returns.
  if (!own && !variable && MATLAB_BUILTINS.has(head)) return null;
  const ref = memberRef(path, member, node);
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

/**
 * Whether a command (`hold on`) or a bare name (`setup_paths`, `t = cfg;`)
 * stands on a line that holds text the parser could not read as MATLAB: a
 * missing node, or a token of an `ERROR` node of its own, outside the
 * statements the parser still read whole inside it. The text of a data
 * table, a readme or a pasted console session reads as commands and names:
 * `2660 W20  81.15 …` is the number 2660, a comma the parser put in, and the
 * command `W20`; `5) @4:48, kicker off` a broken range and the command
 * `kicker`. But an `ERROR` that an unclosed bracket opens can run to the end
 * of the file, through lines that parse as statements of their own
 * (`soundchime;`, `t0 = getclock;`): those are code, and their line holds no
 * text of the error's own. A call written with its arguments (`f(x)`), a
 * handle (`@f`) and a dotted call stay wherever they are: code in a broken
 * file is still code.
 */
function inUnreadText(node: SyntaxNode, source: string): boolean {
  return parseErrorRows(node.tree, source).has(node.startPosition.row);
}

/** Per parse tree, the lines that hold parse-error text (see inUnreadText): read once, pruned to the subtrees that hold an error. */
const PARSE_ERROR_ROWS = new WeakMap<Tree, Set<number>>();

/** Tokens an `ERROR` holds that are no text of the error's own: statement and entry separators, comments. */
const ERROR_SEPARATORS = new Set([';', ',', '\n', 'comment', 'line_continuation']);

function parseErrorRows(tree: Tree, source: string): Set<number> {
  const memo = PARSE_ERROR_ROWS.get(tree);
  if (memo) return memo;
  const rows = new Set<number>();
  const mark = (n: SyntaxNode): void => {
    for (let r = n.startPosition.row; r <= n.endPosition.row; r++) rows.add(r);
  };
  // The characters of an `ERROR` that none of its children covers, the ones
  // it skipped (`data rates` in `correctors data rates (pollrates)`): the
  // lines of those that are neither blank nor a separator (`soundchime;`).
  const skipped = (from: number, to: number, row: number): void => {
    for (let i = from; i < to; i++) {
      const c = source.charCodeAt(i);
      if (c === 10) row++;
      else if (c !== 32 && c !== 9 && c !== 13 && c !== 59 && c !== 44) rows.add(row);
    }
  };
  const walk = (n: SyntaxNode): void => {
    if (n.isMissing) return mark(n);
    const own = n.type === 'ERROR';
    if (own && n.childCount === 0) return mark(n);
    let at = n.startIndex;
    let row = n.startPosition.row;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c) continue;
      if (own) skipped(at, c.startIndex, row);
      // An `ERROR` without children (a skipped character) counts no error of its own, by tree-sitter's count.
      if (c.hasError || c.type === 'ERROR' || c.isMissing) walk(c);
      else if (own && c.childCount === 0 && !ERROR_SEPARATORS.has(c.type)) mark(c);
      at = c.endIndex;
      row = c.endPosition.row;
    }
    if (own) skipped(at, n.endIndex, row);
  };
  if (tree.rootNode.hasError) walk(tree.rootNode);
  PARSE_ERROR_ROWS.set(tree, rows);
  return rows;
}

/** `@f` / `@pkg.f` / `@obj.m` (`@(x) …` is a lambda node, not this). */
function handleRef(node: SyntaxNode, source: string): MemberRef | null {
  const names = dottedName(node, source);
  if (!names) return null;
  return names.length === 1 ? { name: names[0]! } : memberRef(names.slice(0, -1), names[names.length - 1]!, node);
}

/**
 * `f(x)` — a call, or an index read on a variable (nothing). `m@Super(obj, …)`
 * calls the superclass's method and `obj@Super(…)` (in a constructor, on its
 * output) the superclass's constructor. `m(obj, …)` whose first argument the
 * code says is an object of a class (see dispatchClass and
 * argumentDispatchClass: `char(obj)`, `rne(robot, …)`, `area(c)` after `c =
 * Shape(…)`, `f(obj(k))`, `isfixed(e)` after `e = ets(i)`) is `Cls::m` with
 * `dispatch` set: MATLAB takes the class's method when it
 * has one, behind the caller's own and imported functions and ahead of the
 * path — the resolver decides from the class. So is one whose first such
 * argument comes after numbers and texts only (`f(2, obj)`): MATLAB
 * dispatches on the leftmost object, and a number or a text is none. Any
 * other call is a function call, even of a name the class overloads
 * (`char(s, '…')`).
 */
function callRef(node: SyntaxNode, name: string, source: string): { name: string; dispatch: boolean; argClass?: string; selfArg?: boolean; keptBy?: string[] } | null {
  const f = frame();
  const children = namedChildren(node);
  const sup = children.find((c) => c.type === 'superclass');
  if (sup) {
    const base = dottedName(sup, source);
    if (!base) return null;
    const method = isLocal(f, name) ? base[base.length - 1]! : name;
    return { name: [...base, method].join('::'), dispatch: false };
  }
  if (isVariableAt(f, name, node)) return null;
  // `ArrayList()` where the file imports `java.util.ArrayList`: Java's constructor.
  if (javaImported.has(name)) return null;
  const argList = children.find((c) => c.type === 'arguments');
  const first = argList ? namedChildren(argList)[0] : undefined;
  const hinted = dispatchClassKept(first, source);
  // The method's own object (dispatchClass's first answer), or what argumentDispatchClass reads, an object of it: `selfArg`.
  const own = hinted !== undefined ? isOwnObject(first, source) : true;
  const cls = hinted?.cls ?? (MATLAB_BUILTINS.has(name) ? undefined : argumentDispatchClass(callArgs(node), source));
  if (cls) return { name: `${cls}::${name}`, dispatch: true, ...(own ? { selfArg: true } : {}), ...keptFact(hinted?.kept) };
  // `tidy(g)` after `g = gadget();`: named as written, the class it may dispatch to carried (see argumentClassHint).
  const argClass = argList ? argumentClassHint(namedChildren(argList)[0], source) : undefined;
  // `disp(g)`, a built-in's name: `gadget::disp`, as `disp(k)` after `k = Gizmo();` is, the class's method
  // coming before MATLAB's function (doc 'Function Precedence Order'), whose call the extraction otherwise drops.
  // (The argClass fact rides along: a lower-case callee's construction, which may be any function's call.) Not
  // through a write a method of the class must answer (`g = ne(g, 0)`): the plain built-in's call then, which
  // the extraction drops as any (project rule: see matlabBuiltinDispatchKept in ../../resolution/matlab-failures).
  if (argClass && MATLAB_BUILTINS.has(name)) {
    if (argClass.kept.size === 0) a10Keys.add(argClass.cls.toLowerCase());
    return argClass.kept.size === 0 ? { name: `${argClass.cls}::${name}`, dispatch: true, argClass: argClass.cls } : { name, dispatch: false };
  }
  return { name, dispatch: false, ...(argClass ? { argClass: argClass.cls, ...keptFact(argClass.kept) } : {}) };
}

/** The `keptBy` fact of a hint's conditions (see Kept), sorted, or nothing. */
function keptFact(kept: ReadonlySet<string> | undefined): { keptBy?: string[] } {
  return kept && kept.size > 0 ? { keptBy: [...kept].sort() } : {};
}

/**
 * The class whose method a call passing `arg` first dispatches to, when the
 * code says what `arg` holds: the method's own object, or a variable the
 * function says holds a class (`c = Shape(…)`). Not a Java object's (`set(m,
 * …)` on one is the function as written: no class of the project's).
 */
function dispatchClass(arg: SyntaxNode | null | undefined, source: string): string | undefined {
  return dispatchClassKept(arg, source)?.cls;
}

/** dispatchClass, with the hint's conditions (see Kept). */
function dispatchClassKept(arg: SyntaxNode | null | undefined, source: string): { cls: string; kept: ReadonlySet<string> } | undefined {
  const f = frame();
  const first = arg?.type === 'identifier' ? getNodeText(arg, source) : null;
  if (!first) return undefined;
  const own = f.self !== null && first === f.self.name ? ownObjectKept(f, f.self, arg!) : null;
  if (own) return { cls: f.self!.cls, kept: own };
  const held = classHintKept(f, first, false, arg!);
  return held && !isJavaClass(held.hint.cls) ? { cls: held.hint.cls, kept: held.kept } : undefined;
}

/**
 * Whether `arg` is the method's own object (see dispatchClass), of the class
 * of the method's file (the `selfArg` fact), where it is read: the variable
 * that holds it, which no write that may reach `arg` has made something else
 * (see ownObjectKept).
 */
function isOwnObject(arg: SyntaxNode | null | undefined, source: string): boolean {
  const f = frame();
  return f.self !== null && arg?.type === 'identifier' && getNodeText(arg, source) === f.self.name && ownObjectKept(f, f.self, arg) !== null;
}

/**
 * Whether the method's own object `self` is what its variable holds where
 * frame `f` reads it at `at`, with the conditions it holds on (see Kept), or
 * null. MATLAB gives a method its object (doc 'Method Invocation'), so the
 * hint ends only at a write whose value is clearly something else (see
 * ownWriteKind: a literal, `[]`, a cell, a field's value, a cell's contents,
 * a construction of another class) that may reach `at` by the reaching rule
 * of every hint (see hintHolds); a write through one of MATLAB's
 * functions that give a value of another class (VALUE_RETURNING_ON_OBJECTS)
 * holds it on the condition the class has a method of the name; any other
 * write keeps it (another variable, `varargin{…}`, a project call). One that
 * makes an object of the class (see makesOwnObject) ends what came before
 * it; in an old-style constructor, whose output holds nothing on entry
 * (Self.made), one of those must reach `at` too. Code `eval` runs reads at
 * the `eval`'s place, and a write it makes hides the object.
 */
function ownObjectKept(f: Frame, self: Self, at: SyntaxNode): ReadonlySet<string> | null {
  let g = f;
  let pos = at;
  while (g.kind === 'lambda' || g.kind === 'eval') {
    if (g.locals.has(self.name)) return null;
    if (g.kind === 'eval' && g.at) pos = g.at;
    g = g.parent!;
  }
  const hw = g.hintWrites;
  if (!hw) return NONE_KEPT;
  const key = `${self.name}\0#own`;
  let writes = hw.own.get(key);
  if (!writes) {
    writes = [];
    for (const site of hw.facts.writeSites.get(self.name) ?? []) {
      if (!writesWhole(site, self.name, hw.source)) continue;
      const kind = ownWriteKind(site, self, hw);
      if (kind !== 'keeps') writes.push({ at: placed(site, hw.scope), kind });
    }
    hw.own.set(key, writes);
  }
  const enders = writes.filter((w) => w.kind === 'ends' || w.kind === 'makes').map((w) => w.at);
  const clears = clearsOf((hw.clears ??= clearSitesOf(hw.facts, hw.scope)), self.name);
  const reaches = (s: Placed): boolean => loadReaches(s, pos, [...clears, ...enders.filter((w) => w !== s)], true) && !returnsAfter(s, pos);
  if (writes.some((w) => w.kind === 'ends' && reaches(w.at))) return null;
  // An old-style constructor's output is the object only where a write that makes it reaches.
  if (self.made && !writes.some((w) => w.kind === 'makes' && reaches(w.at))) return null;
  const kept = new Set<string>();
  for (const w of writes) if (w.kind !== 'ends' && w.kind !== 'makes' && reaches(w.at)) kept.add(w.kind);
  return kept.size > 0 ? kept : NONE_KEPT;
}

/**
 * What whole write `site` of the method's own object's variable does to it
 * (see ownObjectKept): `makes` an object of the class (makesOwnObject),
 * `ends` it with a value that is clearly something else (a number, a text, a
 * logical literal, `[]`, a cell, a field's value `x.p`, a cell's contents
 * `x{…}` but `varargin{…}`'s, a construction of another class, a `catch`'s
 * error), holds it on a method of the class (the name: one of
 * VALUE_RETURNING_ON_OBJECTS the file does not define), or `keeps` it. The
 * update idiom (a call that gives back what it is passed) needs the object
 * passed: a right side that does not hold the variable ends it (`obj =
 * zt(3)`, `obj = zeros(2)`, `obj = -1`), but a copy of another variable or an
 * element of one (`obj = other`, `obj = w(2)`, `obj = varargin{1}`), whose
 * value the code does not state (step 15 round 8).
 */
function ownWriteKind(site: SyntaxNode, self: Self, hw: HintWrites): 'ends' | 'makes' | 'keeps' | string {
  const source = hw.source;
  if (site.type === 'catch_clause' || site.parent?.type === 'catch_clause') return 'ends';
  if (site.type !== 'assignment') return 'keeps';
  if (makesOwnObject(site, self, source)) return 'makes';
  const right = unparenthesised(childField(site, 'right'));
  if (!right) return 'keeps';
  if (!mentionsName(right, self.name, source)) {
    if (right.type === 'identifier') {
      const w = getNodeText(right, source);
      return w === 'true' || w === 'false' ? 'ends' : 'keeps';
    }
    if (right.type === 'function_call') {
      const callee = childField(right, 'name');
      const f = callee?.type === 'identifier' ? getNodeText(callee, source) : '';
      if (bracesIndex(right)) return f === 'varargin' ? 'keeps' : 'ends';
      // An element of another variable of the scope (`w(2)`), not a call.
      if (f !== '' && (hw.facts.writeSites.has(f) || hw.input(f))) return 'keeps';
    }
    return 'ends';
  }
  // The right side holds the variable.
  switch (right.type) {
    case 'cell':
      return 'ends';
    case 'field_expression': {
      const parts = namedChildren(right);
      return parts[parts.length - 1]?.type === 'identifier' ? 'ends' : 'keeps';
    }
    case 'matrix': {
      const keeps = keepsObject(site, self.name, self.cls, hw);
      return keeps === false ? 'ends' : 'keeps';
    }
    case 'function_call': {
      const callee = childField(right, 'name');
      if (callee?.type !== 'identifier') return 'keeps';
      const f = getNodeText(callee, source);
      // `obj = obj{1}`, a cell's contents.
      if (bracesIndex(right)) return 'ends';
      if (MATLAB_BUILTINS.has(f)) {
        if (!VALUE_RETURNING_ON_OBJECTS.has(f) || OBJECT_RETURNING_BUILTINS.has(f)) return 'keeps';
        const keeps = matlabNameKeeps(f, self.cls, callArgs(right), (n) => n?.type === 'identifier' && getNodeText(n, source) === self.name);
        return keeps === true ? 'keeps' : f;
      }
      // `obj = Zconf(obj)`: the update idiom keeps it (project rule, see keepsObject); a construction of another
      // class that is not passed the object itself (`obj = Widget(obj.n)`) gives that class.
      if (callArgs(right).some((a) => a.type === 'identifier' && getNodeText(a, source) === self.name)) return 'keeps';
      const made = hw.facts.writeSites.has(f) ? null : constructorShape(right, source)?.[1];
      return made && made !== self.cls ? 'ends' : 'keeps';
    }
  }
  return 'keeps';
}

/**
 * Whether write `s` is followed, in the block that holds it, by a `return`
 * (which then runs whenever `s` does), and `p` lies after that block: the
 * function, or the script, has returned before `p` could read what `s` wrote
 * (`if isempty(a), a = val; return; end`, MATLAB doc 'return'). Inside a
 * `try` body, only when nothing from the write (its own right side) to the
 * `return` can throw: a call or an operator there may, and the write then
 * reaches the `catch` clause and what follows (doc 'try, catch'); `k = 5;
 * return` cannot (step 15 round 8).
 */
function returnsAfter(s: Placed, p: SyntaxNode): boolean {
  const block = s.node.parent;
  if (!block || block.type !== 'block' || within(p, block) || p.startIndex < block.endIndex) return false;
  const ret = namedChildren(block).find((c) => c.type === 'return_statement' && c.startIndex >= s.node.endIndex);
  if (!ret) return false;
  if (!s.clauses.some(isTryBody) && !isTryBody(block)) return true;
  const between = namedChildren(block).filter((c) => c.startIndex >= s.node.endIndex && c.endIndex <= ret.startIndex);
  const right = s.node.type === 'assignment' ? childField(s.node, 'right') : s.node;
  return ![right, ...between].some((n) => n !== null && mayThrow(n));
}

/** Whether running `n` may throw (see returnsAfter): it holds a call, a bare name (a command), or an operator. */
function mayThrow(n: SyntaxNode): boolean {
  if (n.type === 'function_call' || n.type === 'command' || n.type === 'identifier' || OPERATOR_FORMS.has(n.type) || n.type === 'postfix_operator') return true;
  return namedChildren(n).some(mayThrow);
}

/** Whether expression `e` reads the name `v` anywhere in it (`f(2, v)`, `[v.x, 1]`, `-v`). */
function mentionsName(e: SyntaxNode, v: string, source: string): boolean {
  if (e.type === 'identifier') return getNodeText(e, source) === v;
  return namedChildren(e).some((c) => mentionsName(c, v, source));
}

/**
 * Whether write `site` makes an object of the method's class `self.cls`: a
 * construction of it (`obj = Gizmo(…)`, see constructedClassOf), or, in an
 * old-style class, MATLAB's `class(s, …)` with any class name (`mfilename`,
 * a text, a variable: doc 'class', which an old-style class's constructor
 * alone may call with a name, its own).
 */
function makesOwnObject(site: SyntaxNode, self: Self, source: string): boolean {
  const right = site.type === 'assignment' ? unparenthesised(childField(site, 'right')) : null;
  if (!right) return false;
  if (constructedClassOf(right, source) === self.cls) return true;
  if (right.type !== 'function_call' || getNodeText(childField(right, 'name') ?? right, source) !== 'class') return false;
  return callArgs(right).length >= 2;
}

/**
 * What dispatchClass adds, in a method, for a call of a name that is no
 * built-in's (one of a built-in's name stays the built-in's call unless
 * dispatchClass says otherwise: `numel(obj(k))`): the first argument that is
 * no number or text (MATLAB dispatches on the leftmost object, and neither
 * is one), when it is
 *   - the method's own object (`f(2, obj)`, which dispatchClass does not
 *     read past the `2`);
 *   - an element of it (`obj(k)`: parentheses, not a cell's braces), which
 *     MATLAB's own indexing gives inside the class's methods;
 *   - a variable that takes nothing but it or an element of it (`e =
 *     ets(i)`, `new = this`, `for e = ets`).
 * An object of the method's class, then, so long as every write of it is
 * seen (see objectCopyHints: `ets = double(ets)` says nothing more).
 */
function argumentDispatchClass(args: readonly SyntaxNode[], source: string): string | undefined {
  const arg = args.find((a) => !PLAIN_VALUE_ARGS.has(a.type));
  if (!arg) return undefined;
  const f = frame();
  let cls: string | undefined;
  if (arg.type === 'identifier') cls = copyHintOf(f, getNodeText(arg, source))?.cls;
  else if (arg.type === 'function_call' && !bracesIndex(arg) && !namedChildren(arg).some((c) => c.type === 'superclass')) {
    const callee = childField(arg, 'name');
    const v = callee?.type === 'identifier' ? getNodeText(callee, source) : null;
    if (v !== null) cls = copyHintOf(f, v, true)?.cls;
  }
  return cls && !isJavaClass(cls) ? cls : undefined;
}

/** Arguments that are no object: a number or a text, which MATLAB dispatches on only when no argument is an object. */
const PLAIN_VALUE_ARGS: ReadonlySet<string> = new Set(['number', 'string']);

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
      if (m) addRef(ctx, m[1]!, 'calls', arg, { form: statement ? 'statement' : 'bare' }, 'anchored');
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

/**
 * The methods a class file's classdef defines (property accessors aside): a
 * call there may be the class's own. Set while extractFile walks the file.
 */
let fileMethods: ReadonlySet<string> = EMPTY;

/** The class the file's classdef defines (`pkg::Cls`), whose methods are fileMethods; null in a file with none. Set while extractClass walks it. */
let fileClass: string | null = null;

/** In a class folder's file (`+pkg/@Cls/f.m`), that folder's class (`pkg::Cls`); null elsewhere. Set while extractFile walks the file. */
let fileFolderClass: string | null = null;

/**
 * Whether the file is a function file in a class folder (`@Cls/f.m`), the
 * code whose calls the `objectArg` fact is written for (see
 * objectArgument): not the class's classdef file (`@Cls/Cls.m`), whose
 * methods call their class's methods on the object they are given
 * (`render(obj)`, `obj.render()`), and where a variable is as often an
 * argument or an event's source (`render(L)` in a constructor, `render(src)`
 * in a callback). Set while extractFile walks the file.
 */
let classFile = false;

/** The methods `root`'s classdef defines (see fileMethods). */
function fileMethodsOf(root: SyntaxNode, source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const cls of namedChildren(root)) {
    if (cls.type !== 'class_definition') continue;
    for (const section of namedChildren(cls)) {
      if (section.type !== 'methods') continue;
      for (const m of namedChildren(section)) {
        const name = m.type === 'function_definition' || m.type === 'function_signature' ? childField(m, 'name') : null;
        if (!name || /^[gs]et\.$/.test(source.slice(Math.max(0, name.startIndex - 4), name.startIndex))) continue;
        names.add(getNodeText(name, source));
      }
    }
  }
  return names;
}

/**
 * Whether `load` where frame `f` calls it is MATLAB's: no variable there, no
 * function of the file, and no method of the file's classdef (`load(obj,
 * f)` there may call the class's own; a `load` of another file — a project
 * `load.m`, `@Cls/load.m` — is not seen from this file's text).
 */
function loadIsMatlabs(f: Frame): boolean {
  return !isLocal(f, 'load') && !fileFunctions.has('load') && !fileMethods.has('load');
}

/** Whether frame `f` (code eval runs or a lambda, read through to the function around) is a function whose workspace is static (see Frame.staticWorkspace). */
function inStaticWorkspace(f: Frame): boolean {
  let g: Frame | null = f;
  while (g && (g.kind === 'lambda' || g.kind === 'eval')) g = g.parent;
  return g?.staticWorkspace === true;
}

/** The functions `root` defines outside a class (see fileFunctions). */
function fileFunctionsOf(root: SyntaxNode, source: string): ReadonlySet<string> {
  const names = new Set<string>();
  const add = (fn: SyntaxNode): void => {
    const name = childField(fn, 'name');
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
      if (tree) noteParsedText(tree, text);
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
 * one so known or from a parameter (`r = basisf`, `t = s.f`); a parameter
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
 * Frame.runtime). A name with a part nothing here knows is passed over. And
 * the `load`s that may make names no code spells (see Frame.loads): its own,
 * and the `eval`s whose code holds one (`eval(['load ' f])`), unless `load`
 * is not MATLAB's there (see loadIsMatlabs), or the function's workspace is
 * static (see Frame.staticWorkspace). A name only a `load` list makes is one
 * where such a load may have run (Frame.runtimeLoads); in a static workspace
 * none is made. Returns the names made at runtime.
 */
function addRuntimeNames(facts: ScopeFacts, f: Frame, scope: SyntaxNode, source: string, isFunction: boolean): ReadonlySet<string> {
  // A static workspace takes no variable its code does not spell: a `load` that lists one there is an error
  // (MATLAB 'Attempt to add … to a static workspace'), and the name stays a call.
  const listed = isFunction && !f.staticWorkspace ? facts.loaded : EMPTY;
  const made = new Set<string>();
  const loadCalled = !f.staticWorkspace && loadIsMatlabs(f);
  const sites: SyntaxNode[] = loadCalled ? [...facts.loads] : [];
  for (const { callee, arg, call } of facts.evalCodes) {
    if (isLocal(f, callee)) continue;
    let loads = false;
    for (const code of valueAt(arg, source).strs) {
      const parsed = parseCode(code);
      for (const n of parsed?.facts.locals ?? []) if (!n.includes(PLACEHOLDER)) made.add(n);
      if (parsed && parsed.facts.loads.length > 0) loads = true;
    }
    // (An `eval(code, catchCode)` call's two codes are consecutive entries.)
    if (loads && loadCalled && sites[sites.length - 1] !== call) sites.push(call);
  }
  const loads = loadSitesOf(sites, facts, scope);
  if (loads) f.loads = loads;
  // A name only a load list makes is one where such a load may have run (see Frame.runtimeLoads).
  const byLoad = new Map<string, Placed[]>();
  for (const n of listed) if (!made.has(n)) byLoad.set(n, (facts.loadedAt.get(n) ?? []).map((s) => placed(s, scope)));
  for (const n of listed) made.add(n);
  if (made.size === 0) return made;
  if (isFunction) {
    f.runtime = made;
    if (byLoad.size > 0) f.runtimeLoads = { sites: byLoad, ...clearSitesOf(facts, scope) };
  } else for (const n of made) facts.locals.add(n);
  return made;
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
        // `feval('probe');`: one name and nothing more, as a statement, runs a script of it (the `emptyCall` fact).
        handleCalls(v.fns, v.strs, arg, args[1], ctx, computed, args.length === 1 && isStatement(node));
        break;
      case 'function':
        // A handle written with `@` is referenced there.
        for (const text of v.strs) {
          if (!NAME_SHAPED.test(text) || (name === 'cellfun' && MATLAB_CELLFUN_NAMES.has(text))) continue;
          const f = namedRef(text.split('.'));
          if (f) addRef(ctx, f.name, 'function_ref', arg, computedFact(f.name, computed), computed ? 'anchored' : undefined);
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
function handleCalls(fns: readonly FnVal[], strs: readonly string[], at: SyntaxNode, dispatchOn: SyntaxNode | undefined, ctx: ExtractorContext, computed: boolean, emptyCall = false): void {
  const held = dispatchClassKept(dispatchOn, ctx.source);
  const cls = held?.cls;
  const own = cls !== undefined && isOwnObject(dispatchOn, ctx.source);
  // A value's names (one of several a variable may hold, what `mfilename` returns) are no text written at `at`: anchored (see anchoredRefs).
  const column = computed ? 'anchored' : undefined;
  const call = (f: FnVal): void => {
    if (cls && /^[A-Za-z]\w*$/.test(f.name)) addRef(ctx, `${cls}::${f.name}`, 'calls', at, { dispatch: f.name, ...(own ? { selfArg: true } : {}), ...keptFact(held?.kept) }, column);
    else addRef(ctx, f.name, 'calls', at, { ...(f.variable ? { variable: f.variable } : {}), ...computedFact(f.name, computed), ...(emptyCall && !isDottedName(f.name) ? { emptyCall } : {}) }, column);
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
 * as code (definitions in it aside), placed in the file as codeContext says
 * from `at`, the argument that gives it. `asValue` says the code is
 * evaluated for a value (`x = eval('cfg')`), where no statement runs a
 * script. Code in code is read to MAX_CODE_DEPTH; code the walk fails on
 * gives nothing.
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
    if (here) {
      f.at = at;
      const loads = loadIsMatlabs(outer) && !inStaticWorkspace(outer) ? loadSitesOf(facts.loads, facts, root) : undefined;
      if (loads) f.loads = loads;
    }
    const refs: UnresolvedReference[] = [];
    // The literals written where the code is given, when that is all it is: its references are placed in them.
    const sub = codeContext(ctx, text, at, textPieces(at, code, ctx.source), { callback: mode === 'callback', runtime: !here, asValue, computed }, refs);
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
    for (const r of refs) {
      ctx.addUnresolvedReference(r);
      if (codeDepth === 0 && unplacedRefs.has(r)) refPlaces.push(r);
    }
  }
}

/**
 * The references of a file whose name no text written in the file spells,
 * in the order the walk wrote them, each still at its anchor (see
 * unplacedRefs), while the file is walked (see inFile).
 */
let refPlaces: UnresolvedReference[] = [];

/**
 * The references placed at an anchor, not where a name is written: one of
 * code given as text that is no literal (concatenated with a value, computed,
 * read from a variable, one of several strings a variable may hold) or that
 * a literal holds only across pieces, and a name a value gives a call
 * (`feval(fn, …)`, `fh(x)`, `run(s)`, `str2func(s)`, `feval(mfilename, …)`).
 * The anchor is where the code runs, or the call is made: the end of the
 * argument that gives it (of the call, for `fh(x)`), after every reference
 * of the argument's own code and before any after it. Code in code maps an
 * anchor as it maps a place.
 */
const unplacedRefs = new WeakSet<UnresolvedReference>();

/**
 * Places the anchored references of a file (see unplacedRefs), once its walk
 * is done: the k-th at an anchor goes to column `MATLAB_ANCHORED_BASE +
 * anchor × MATLAB_ANCHORED_STRIDE + k` of the anchor's line. No line reaches
 * such a column, so no reference written in the file is there, and two
 * anchored references never share one: the store keeps one edge per source,
 * target, kind, line and column, and two references at one place would be
 * one edge, which a sync turns back into one row where a fresh index has
 * two. The order code runs in reads such a place as its anchor
 * (matlabPlaceOrder): after the argument's own code, before what follows it,
 * and in the walk's order among themselves. The rule reads the file alone,
 * so a fresh index and a sync, which both extract the whole file, place the
 * references alike. The references were handed to the file's context as they
 * are, which keeps them (see TreeSitterExtractor's context): they move in
 * place.
 */
function placeTextRefs(): void {
  const next = new Map<string, number>();
  for (const ref of refPlaces) {
    const key = `${ref.line}:${ref.column}`;
    const k = next.get(key) ?? 0;
    next.set(key, k + 1);
    ref.column = MATLAB_ANCHORED_BASE + ref.column * MATLAB_ANCHORED_STRIDE + k;
  }
}

/**
 * A string literal written where code is given, holding the code's text from
 * its character `offset` on: `text`, written `quote…quote` at `line` and
 * `column` (its opening quote).
 */
interface TextPiece {
  text: string;
  offset: number;
  line: number;
  column: number;
  quote: string;
}

/**
 * The literals the argument `at` writes `code` in, when that is all it is:
 * one literal (`'f; g'`, `"f; g"`), or a row of char literals concatenated
 * (`['disp(1); ' 'mkvars']`, over continued lines too). Null for anything
 * else (a value, a call, a piece that is a string object, which makes a
 * string array, not one text).
 */
function textPieces(at: SyntaxNode, code: string, source: string): TextPiece[] | null {
  const piece = (node: SyntaxNode, offset: number): TextPiece | null => {
    const text = stringLiteral(node, source);
    return text === null ? null : { text, offset, line: node.startPosition.row + 1, column: node.startPosition.column, quote: source[node.startIndex]! };
  };
  if (at.type === 'string') {
    const one = piece(at, 0);
    return one && one.text === code ? [one] : null;
  }
  const rows = at.type === 'matrix' ? namedChildren(at).filter((c) => c.type !== 'comment' && c.type !== 'line_continuation') : [];
  if (rows.length !== 1 || rows[0]!.type !== 'row') return null;
  const pieces: TextPiece[] = [];
  let offset = 0;
  for (const c of namedChildren(rows[0]!)) {
    if (c.type === 'comment' || c.type === 'line_continuation') continue;
    const p = c.type === 'string' && source[c.startIndex] === "'" ? piece(c, offset) : null;
    if (!p) return null;
    pieces.push(p);
    offset += p.text.length;
  }
  return pieces.length > 0 && pieces.map((p) => p.text).join('') === code ? pieces : null;
}

/** How many characters the name written at `column` of the code's line `line` takes (`f`, `pkg.f`, `@f`), at least one. */
function writtenNameLength(code: string, line: number, column: number): number {
  const text = code.split('\n')[line - 1] ?? '';
  return /^@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/.exec(text.slice(column))?.[0].length ?? 1;
}

/**
 * Where in the file the place `column` of the code's line `line` is written,
 * when the code is `pieces` and the `length` characters from there are all in
 * one of them: a quote of the text is written twice (`''`, or `""` in a
 * string). A length of 0 (an anchor) may also be a piece's end, its closing
 * quote. Null otherwise (a literal holds one line, and a name may be built
 * across pieces).
 */
function piecePlace(pieces: readonly TextPiece[], line: number, column: number, length: number): { line: number; column: number } | null {
  if (line !== 1) return null;
  for (const p of pieces) {
    const from = column - p.offset;
    if (from < 0 || from + length > p.text.length || (length > 0 && from >= p.text.length)) continue;
    let at = 1;
    for (let i = 0; i < from; i++) at += p.text[i] === p.quote ? 2 : 1;
    return { line: p.line, column: p.column + at };
  }
  return null;
}

/**
 * `candidates` with the fact `tag` added before the `args` fact, which comes
 * last in every reference's candidates (see matlabRefCandidates): an edge
 * keeps `args` apart and puts it back last (joinMatlabArgs), so a reference
 * a sync turns back from an edge lists its facts as its row did.
 */
function withFact(candidates: readonly string[], tag: string): string[] {
  const at = candidates.findIndex(isMatlabArgsCandidate);
  return at < 0 ? [...candidates, tag] : [...candidates.slice(0, at), tag, ...candidates.slice(at)];
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
 * styled as `style` says, and gathered in `sink`; one whose name holds a part
 * nothing here knows is dropped. Each comes in at its place in the code's
 * text (`source`) and leaves at its place in the code around `at`, the
 * argument that gives the code, so that no two of one file share a place:
 * when the argument is `pieces`, the literals that write the code, where its
 * name is written in them; otherwise, and for a name built across pieces, it
 * is anchored at the argument's end (see unplacedRefs). Code in code maps
 * level by level, each from its text to the code around it, an anchor as a
 * place.
 */
function codeContext(outer: ExtractorContext, source: string, at: SyntaxNode, pieces: readonly TextPiece[] | null, style: CodeRefStyle, sink: UnresolvedReference[]): ExtractorContext {
  const anchor = { line: at.endPosition.row + 1, column: at.endPosition.column };
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
      if (style.runtime && !candidates.includes(RUNTIME_TAG)) candidates = withFact(candidates, RUNTIME_TAG);
      if (style.computed && isDottedName(ref.referenceName) && !candidates.includes(COMPUTED_TAG)) candidates = withFact(candidates, COMPUTED_TAG);
      const anchored = unplacedRefs.has(ref);
      const place = pieces && piecePlace(pieces, ref.line, ref.column, anchored ? 0 : writtenNameLength(source, ref.line, ref.column));
      const out: UnresolvedReference = { ...ref, ...(place ?? anchor) };
      if (!place || anchored) unplacedRefs.add(out);
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
  const head = arg.type === 'identifier' ? arg : spread ? childField(arg, 'name') : null;
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
 * do with a literal written there (`feval(basisf, S)`, `str2func(varargin{1})`,
 * `eval(code)`, `fh(x)`, `feval(['tk_' method], …)`): which parameter (and
 * field of it), the text around it, and where.
 */
export interface MatlabParamSink extends SinkUse {
  /** The function's site (see Frame.site). */
  readonly fn: string;
  /** The parameter's position (a variadic one counts on from the positional ones). */
  readonly position: number;
  /** The fields read off it (`cfg.taperfn` → [taperfn]). */
  readonly path: readonly string[];
  /** The text before and after it, for a template (`tk_` and ``); '' and '' for the value as it is. */
  readonly prefix: string;
  readonly suffix: string;
  /** The parameter as the code names it: `basisf`, `varargin{1}`, `cfg.taperfn`. */
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
  if (matlabUnreadReason(source) !== null) return use([], () => []);
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

/**
 * The names a script's code makes in the workspace that runs it: every
 * variable its top level assigns in any form, a `for` or `catch` variable, a
 * `global` it declares, and each name a `load f a b` list makes, in text
 * order: a `clear` that may remove more than it names (`clear`, `clear all`,
 * `clearvars -except …`) leaves only those made after it, and a name a
 * `clear` names is not made (scanScope's `made`; nested and local functions
 * excluded). A `persistent` declaration makes none: MATLAB refuses it
 * outside a function. `root` is the parse of the whole file `source`, which
 * its owner deletes; a file whose text is read as no MATLAB code (see
 * matlabUnreadReason) makes none. For
 * ../../resolution/matlab-script-workspace.ts.
 */
export function matlabScriptMadeNames(root: SyntaxNode, source: string, filePath: string): Set<string> {
  if (matlabUnreadReason(source) !== null) return new Set();
  return inFile(root, source, filePath, () => scanScope(root, source, false).made);
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
  const name = childField(node, 'name');
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
  /** Whether the class's own superclass list names a `matlab.mixin.indexing.*` class: it indexes its objects itself (see Frame.elementsOfClass). */
  indexesItself: boolean;
}

/** The parameters among `params` that the scope `facts` were read from never writes to (see ScopeFacts.assigned). */
function untouched(params: readonly (string | null)[], facts: ScopeFacts): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of params) if (p && !facts.assigned.has(p)) out.add(p);
  return out;
}

function extractFunction(node: SyntaxNode, ctx: ExtractorContext, block: MethodsBlock | null = null): void {
  const source = ctx.source;
  const nameNode = childField(node, 'name');
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
    if (v) self = { name: v, cls, ...(isConstructor && !block ? { made: true as const } : {}) };
  } else if (nested) {
    self = outer.self;
  }

  const facts = scanScope(node, source, true);
  const parent = nested ? outer : null;
  // A nested function's parameters are variables of the workspace it shares: what they hold is not followed.
  const params = nested ? undefined : parameterList(children, source);
  const walk = needsWalk(node, params, source, facts);
  const isVariable = (v: string): boolean => facts.locals.has(v) || (parent !== null && isLocal(parent, v));
  const classHints = classHintsFrom(facts, isVariable);
  const dispatchHints = dispatchHintsFrom(facts, isVariable);
  const f: Frame = {
    kind: 'function',
    qual: [...qual, name],
    locals: facts.locals,
    classHints,
    ...(dispatchHints ? { dispatchHints } : {}),
    copyHints: objectCopyHints(classHints, facts, self, new Set(parameterList(children, source).filter((p): p is string => p !== null)), nested, block?.indexesItself !== true, name),
    ...(block?.indexesItself ? { elementsOfClass: false } : {}),
    opaque: facts.opaque,
    structFields: facts.structFields,
    self,
    parent,
    ...(params ? { params, forwards: forwardable(params, facts, walk), def: node, untouchedParams: untouched(params, facts) } : {}),
    site,
    ...(nested || facts.nested ? { staticWorkspace: true } : {}),
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
  f.hintWrites = hintWritesOf(facts, node, source, (v) => inputs.has(v) || options.shared(v), (w, at) =>
    f.self?.name === w ? (ownObjectKept(f, f.self, at)?.size === 0 ? f.self.cls : undefined) : heldWithoutCondition(classHintKept(f, w, true, at)));

  ctx.pushScope(fn.id);
  inFrame(f, () => {
    f.values = scopeValues(node, options, source, walk);
    addRuntimeNames(facts, f, node, source, true);
    for (const c of children) {
      if (c.type === 'block' || c.type === 'arguments_statement' || c.type === 'function_definition') ctx.visitNode(c);
    }
  });
  ctx.popScope();
  if (oldStyleClass) ctx.popScope();
}

function extractClass(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const nameNode = childField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, source);
  const children = namedChildren(node);
  const isEnum = children.some((c) => c.type === 'enumeration' && namedChildren(c).some((e) => e.type === 'enum'));
  const attrs = attributesOf(node, source);
  const attrsNode = leadingAttributes(node);

  const supers = children.find((c) => c.type === 'superclasses');
  const baseNodes = supers ? namedChildren(supers).filter((c) => c.type === 'property_name' && !namedChildren(c).some(isCutName)) : [];
  const bases = baseNodes.map((c) => namedChildren(c).map((i) => getNodeText(i, source)).join('.'));
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
  fileClass = qual.join('::');
  const indexesItself = bases.some((b) => /^matlab\.mixin\.indexing\./.test(b));
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
    // Each at its own name: two references of one file at one place would be one edge (see codeContext).
    bases.forEach((base, i) => {
      if (!BUILTIN_BASES.test(base)) addRef(ctx, base.replace(/\./g, '::'), 'extends', baseNodes[i]!);
    });
    for (const section of children) {
      if (section.type === 'properties') {
        const sectionAttrs = attributesOf(section, source);
        const constant = sectionAttrs.get('constant') === 'true';
        const vis = visibilityFrom(sectionAttrs);
        for (const prop of namedChildren(section)) {
          if (prop.type !== 'property') continue;
          const propName = childField(prop, 'name');
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
        const block: MethodsBlock = { attrs: attributesOf(section, source), cls: qual.join('::'), className: name, indexesItself };
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
  noteParsedText(root.tree, source);
  javaImported = javaImportsOf(root, source);
  fileFunctions = fileFunctionsOf(root, source);
  fileMethods = fileMethodsOf(root, source);
  fileStem = matlabFileStem(filePath);
  classFile = matlabPathScope(filePath).classFolder !== undefined && !namedChildren(root).some((c) => c.type === 'class_definition');
  const scope = matlabPathScope(filePath);
  fileFolderClass = scope.classFolder !== undefined ? [...scope.packages, scope.classFolder].join('::') : null;
  try {
    const out = body();
    placeTextRefs();
    tagConstructions();
    return out;
  } finally {
    refPlaces = [];
    javaImported = EMPTY;
    arrayEvidenceMemo = new Map();
    fileStem = null;
    codeDepth = 0;
    fileFunctions = EMPTY;
    fileMethods = EMPTY;
    fileClass = null;
    fileFolderClass = null;
    ctorRefs = [];
    a10Keys = new Set();
    classFile = false;
    for (const { tree } of codeTrees.values()) tree?.delete();
    codeTrees = new Map();
  }
}

/**
 * A script's variables in text order (see Frame.textOrder): each name with
 * its writes, placed; not a name code `eval` runs may write (`made`), whose
 * place is unknown: a variable everywhere.
 */
function textOrderOf(facts: ScopeFacts, made: ReadonlySet<string>, scope: SyntaxNode): Frame['textOrder'] {
  const sites = new Map<string, Placed[]>();
  for (const [v, at] of facts.writeSites) if (!made.has(v)) sites.set(v, at.map((s) => placed(s, scope)));
  return { sites, ...clearSitesOf(facts, scope) };
}

/** Walks a file from its root (see extractFile); a walk for parameter sinks walks its definitions only. */
function walkFile(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const facts = scanScope(node, source, false);
  const classHints = classHintsFrom(facts, (v) => facts.locals.has(v));
  const dispatchHints = dispatchHintsFrom(facts, (v) => facts.locals.has(v));
  const f: Frame = {
    kind: 'file',
    qual: matlabPathScope(ctx.filePath).packages,
    locals: facts.locals,
    classHints,
    dispatchHints,
    structFields: facts.structFields,
    self: null,
    parent: null,
    // A script's variables hold nothing on entry the index sees: it is read as run on its own.
    hintWrites: hintWritesOf(facts, node, source, () => false, (w, at) => heldWithoutCondition(classHintKept(f, w, true, at))),
  };
  inFrame(f, () => {
    // A function file's or a class file's top level runs nothing of its own.
    const script = !sinkCollector && namedChildren(node).some((c) => !DEFINITIONS.has(c.type) && c.type !== 'comment');
    f.values = script ? scopeValues(node, { isFunction: false, inputs: EMPTY, shared: () => false }, source, needsWalk(node, undefined, source, facts)) : NO_VALUES;
    const madeByEval = addRuntimeNames(facts, f, node, source, false);
    if (script) f.textOrder = textOrderOf(facts, madeByEval, node);
    for (const c of namedChildren(node)) if (!sinkCollector || DEFINITIONS.has(c.type)) ctx.visitNode(c);
  });
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export const matlabExtractor: LanguageExtractor = {
  // The text the grammar reads: CRLF as LF, and a `%{` after code no block comment's start (see matlabParseText).
  preParse: matlabParseText,
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
    // unsupported, and a binary (an encrypted MATLAB Compiler file) no code:
    // its file node, nothing read from it.
    if (!node.parent) {
      if (matlabUnreadReason(source) === null) extractFile(node, ctx);
      return true;
    }
    // A name the parser cut out of a word (`igure` of `figure(1);` in a region
    // it could not read) is no name: nothing is read from it. The tree walk
    // hands this hook its nodes itself; every other reader takes them through
    // namedChildren and childField, which never hand one out (see isCutName).
    if (isCutName(node)) return true;
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
        if (parent?.type === 'field_expression' && childField(parent, 'object')?.id !== node.id) return false;
        // `x(k) = …`, `[y, x(k)] = …` assign into x.
        if (isAssignmentTarget(node)) return false;
        const callee = childField(node, 'name');
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
        // A plain name's call after a `load` that may have made it (see loadMayMake) may read a variable, unless it reads as no index (see readsAsCall).
        const loaded = ref?.name === written && !MATLAB_BUILTINS.has(written) && loadMayMake(frame(), node, written) && !readsAsCall(node, args);
        const runtime: MatlabRefFacts = loaded ? { runtime: true } : runtimeFact(frame(), written, node);
        // `m(x, …)` on a variable that may hold an object: the resolver may take the caller's class's method (see objectArgument).
        const objectArg = classFile && ref !== null && !ref.dispatch && ref.name === written && !form && !runtime.runtime && !MATLAB_BUILTINS.has(written) && objectArgument(callArgs(node), source);
        // `probe();`: an empty argument list, as a statement, runs a script of the name (the `emptyCall` fact).
        const emptyCall = !form && ref !== null && ref.name === written && callArgs(node).length === 0 && isStatement(node);
        if (ref) noteConstruction(node, addRef(ctx, ref.name, 'calls', node, { ...(ref.dispatch ? { dispatch: written } : {}), ...(ref.selfArg ? { selfArg: true } : {}), ...(ref.argClass && !form ? { argClass: ref.argClass } : {}), ...(ref.keptBy && (ref.dispatch || (ref.argClass && !form)) ? { keptBy: ref.keptBy } : {}), ...(form ? { form } : {}), ...runtime, ...(args ? { args } : {}), ...(objectArg ? { objectArg: true } : {}), ...(emptyCall ? { emptyCall } : {}) }), source);
        if (ref?.name === 'run') runRef(namedChildren(node).find((c) => c.type === 'arguments'), ctx, isStatement(node));
        if (ref) dynamicCallRefs(node, written, ctx, ref.name === written);
        else if (isLocal(frame(), written)) {
          // `fh(x)` after `fh = @solve`: a call of what the handle holds.
          const held = recordedValue(callee);
          // What the handle holds was given elsewhere: computed, as far as this call's text says.
          if (held && held.fns.length > 0) handleCalls(held.fns, [], node, callArgs(node)[0], ctx, true, callArgs(node).length === 0 && isStatement(node));
          if (held && sinkCollector && dispatchClass(callArgs(node)[0], source) === undefined) {
            sinkCollector.add(held, { sink: written, takes: 'handle', edge: 'calls', asValue: false }, node);
          }
        }
        return false; // arguments still walked
      }

      case 'assignment': {
        // `h.Callback = 'go'`, `s(k).KeyPressFcn = …`: callback code given as text.
        const left = childField(node, 'left');
        const right = childField(node, 'right');
        if (left?.type === 'field_expression' && right) {
          const parts = namedChildren(left);
          const last = parts[parts.length - 1];
          if (last?.type === 'identifier' && CALLBACK_PROPERTY.test(getNodeText(last, source))) codeRefs(valueAt(right, source).strs, right, ctx, 'callback', false, !writtenAsLiteral(right));
        }
        return false;
      }

      case 'field_expression': {
        // `s.f(k) = …` writes a field; `Q2.Level.P` in `CF.Q2.Level.P{1}(6, :)` is no chain of its own.
        if (isAssignmentTarget(node) || isInnerChain(node)) return false;
        const ref = fieldChainRef(node, source);
        const head = childField(node, 'object');
        if (ref) {
          addRef(ctx, ref.name, 'calls', ref.at, {
            ...(ref.variable ? { variable: ref.variable } : {}),
            ...(ref.bare ? { form: 'bare' as const } : {}),
            ...(head ? runtimeFact(frame(), getNodeText(head, source), node) : {}),
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
          (parent.type === 'assignment' && childField(parent, 'right')?.id === node.id) ||
          // `if isReady`, `while keepGoing`, `switch mode`, `case modeA`: the condition.
          (CONDITION_PARENTS.has(parent.type) && childField(parent, 'condition')?.id === node.id) ||
          // `for k = getRange`: the range, not the loop variable.
          (parent.type === 'iterator' && parent.namedChild(0)?.id !== node.id) ||
          // `go(x, Solver=1)`: `Solver` names the argument.
          (parent.type === 'arguments' && parent.parent?.type === 'function_call' && node.nextSibling?.type !== '=');
        if (!asValue) return false;
        const name = getNodeText(node, source);
        if (!isVariableAt(frame(), name, node) && !javaImported.has(name) && !inUnreadText(node, source)) {
          // A read after a `load` that may have made the name (see loadMayMake); not a statement, which may run a script here.
          const loaded = !statement && !MATLAB_BUILTINS.has(name) && loadMayMake(frame(), node, name);
          noteConstruction(node, addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare', ...(loaded ? { runtime: true } : runtimeFact(frame(), name, node)) }), source);
        }
        return false;
      }

      case 'command': {
        const cmd = namedChildren(node).find((c) => c.type === 'command_name');
        if (!cmd) return true;
        const name = getNodeText(cmd, source);
        if (name === 'import') extractImport(node, ctx);
        else if (!isVariableAt(frame(), name, node) && !inUnreadText(node, source)) {
          // `setup_paths`: a statement of its own; `hold on` takes arguments.
          // (`setup_paths ;` reads with an empty argument, which is none.)
          const statement = !namedChildren(node).some((c) => c.type === 'command_argument' && getNodeText(c, source).trim() !== '');
          addRef(ctx, name, 'calls', node, { form: statement ? 'statement' : 'bare', ...runtimeFact(frame(), name, node) });
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
