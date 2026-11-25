/**
 * What the MATLAB extractor knows of how a reference is written, from the
 * syntax tree, which the resolver needs and could not read back from the
 * name: carried in the reference's `candidates`, so that it survives the
 * `unresolved_refs` row (its `candidates` column) and the edge a resolved
 * reference becomes (`metadata.refCandidates`, read back when the edge is
 * dropped and resurrected as a reference). One tagged string per fact:
 *
 *   - `dispatch:<m>` — a function-syntax call on an object of a known class
 *     (`m(obj, …)`, `area(c)` after `c = Shape(…)`), recorded as `Cls::m`:
 *     the name as written, which MATLAB looks up as a function before the
 *     class's methods and after them on the path;
 *   - `selfArg` — a `dispatch:` call whose object is the method's own (`m(obj,
 *     …)` in a method of `Cls`, `f(2, obj)`, `f(obj(k))`, a copy of it: see
 *     argumentDispatchClass in matlab.ts): of the caller's own class, as
 *     written, whether or not the project defines that class where a call
 *     of its name reaches (`@double/f.m`, a class folder with no
 *     constructor). Any other `dispatch:` call's class is the one a call of
 *     its constructor's name reaches from the caller (constructedClass in
 *     ../../resolution/matlab-lookup.ts), and so is an `argClass:` one's;
 *   - `keptBy:<f>` — on a `dispatch:` or `argClass:` call, one per name: the
 *     object's class is read through a write that may reach the call and
 *     passes the object to a MATLAB function `f` (`x = x ~= 0` is `ne`, `fa
 *     = reshape(fa, n, 1)`), which gives an object of the class back only
 *     when the class defines or inherits a method `f` (doc 'Method
 *     Invocation', 'Operator Overloading'): the resolver takes the class
 *     only when it has every such method (see resolveBare in
 *     ../../resolution/matlab-lookup.ts), and a sync re-opens the call where
 *     a definition of `f` comes or goes (reopenMatlabKeptByCalls in
 *     ../../resolution/matlab-sync.ts);
 *   - `ctor` — a lower-case callee's construction (`g = gadget(…)`) that an
 *     on-object call under a built-in's name was read on in the file (`disp(g)`):
 *     the evidence a class of the name arriving may give the file rows to
 *     write (matlabFilesConstructing in ../../resolution/matlab-builtin-carriers).
 *     The resolver reads nothing of it;
 *   - `argClass:<Cls>` — the dispatch lookup of `dispatch:` for a call
 *     recorded under the name as written (`tidy(g)` after `g = gadget();`),
 *     whose first argument a lower-case callee made, which may be an
 *     old-style class's constructor (`@gadget/gadget.m`) or any function:
 *     the resolver takes `Cls`'s method only when `Cls` is a class that has
 *     one, and the call is otherwise the plain call it is written as (no
 *     `dispatch` fact: every rule for a plain call holds for it);
 *   - `variable:<v.m>` — a member call through a class only a bare name gave
 *     (`aa = Archive; aa.getData()` → `Archive::getData`): the variable's own
 *     dotted name, taken when that bare name is a function, not a class;
 *   - `bare` — a bare name written without an argument list: read as a value
 *     (`t = cfg;`, `if isReady`) or a command (`hold on`); or a member written
 *     without one (`m.reset;`, `x = Model.make;`), on the method's own object,
 *     a variable the function says holds a class, or a class or package
 *     name: a call of a method, or a read of a property, which only the
 *     resolver can tell apart;
 *   - `statement` — a bare name that is a statement of its own
 *     (`setup_paths`, `if ok, setup_paths, end`, `catch⏎ cleanupAll`), or
 *     the script a `run` statement names (`run setup_paths`,
 *     `run('setup_paths.m')`): the only way a script runs. Bare as well.
 *   - `runtime` — a name only code run at runtime may make a variable: one
 *     that `eval`'d code assigns or a `load` name list makes in a function
 *     (`eval('f = @g;'); f(1)` — MATLAB reads `f` as a function from the
 *     function's own code, so `f.m` is called unless the eval ran); one read
 *     after a `load` that does not list what it makes (`load(f); x =
 *     DEVnum(3);`, in a function whose workspace is not static, a script or
 *     code `eval` runs: see loadMayMake in matlab.ts), unless the call reads
 *     as no index (a text passed, a statement of its own with arguments:
 *     `sigtag('HaltFeed')`, `hz_mark(x, y)`); and
 *     every name of code run in another workspace (a callback given as text,
 *     what `evalin` runs), whose variables the index cannot see: resolved
 *     like any other, and dropped when nothing answers it (see
 *     ../../resolution/matlab-failures.ts).
 *   - `self` — a member call on the method's own object (`obj.step()`,
 *     `veh.dxstate(t, y)`), recorded as `Cls::m`: one whose class neither
 *     defines nor inherits `m` runs a subclass's (see
 *     ../../resolution/matlab-override-synthesizer.ts);
 *   - `param` — a member call on a parameter of the calling function that the
 *     function never writes to, nor into a field of (`Problem.Evaluation(x)`
 *     in `main(Algorithm, Problem)`): a receiver named like one of the classes
 *     defining the method holds that class's object (see variableMethod in
 *     ../../resolution/matlab-lookup.ts);
 *   - `computed` — a member or qualified name (`pkg::scale`, `Model::make`)
 *     that the value interpreter built from anything but one literal written
 *     where it is given: `feval(strcat('pkg.', 'scale'), x)`, `a =
 *     lower('PKG.SHIFT'); feval(a)`, `eval(['x = Model.' 'make(r);'])`, a
 *     handle `str2func` made of a built text. No text spells the name, so its
 *     row is kept whatever carries the member (see
 *     ../../resolution/matlab-failures.ts);
 *   - `objectArg` — a call of a name that is no built-in's, written with
 *     arguments, whose first argument is a variable of the calling function
 *     that may hold an object (a parameter, or a variable written only with
 *     calls' results, copies and elements; not a lambda's parameter: see
 *     objectArgument in matlab.ts), as it is or indexed with parentheses
 *     (`children(tree, uid)`, `f(q(i), p)`), and no class the code states,
 *     in a class folder's function file (`@Cls/f.m`, not the classdef
 *     `@Cls/Cls.m`), in a function whose first parameter is not `~`: where
 *     nothing else answers, it is taken for a call of the class's method
 *     (see classMethodGuess in ../../resolution/matlab-lookup.ts), a guess
 *     the edge says it is;
 *   - `emptyCall` — a call written with an empty argument list as a
 *     statement of its own (`probe();`, `probe()`), or `feval` of one name
 *     and nothing more, so (`feval('probe');`), or a call so of a variable
 *     holding a handle (`h();`): a script MATLAB finds first for the name
 *     runs then, as for a statement `probe` (MATLAB R2026a: `probe()` runs
 *     the script, `probe(2)` is an error), so the resolver takes the script
 *     (see resolveBare in ../../resolution/matlab-lookup.ts). Every other
 *     rule for a call written with arguments holds for it;
 *   - `args:<json>` — what a call written with arguments (`fitmodel(S, Y,
 *     'basis0')`, `gui('LoadLattice', h)` in callback code) passes, where
 *     the code says (see MatlabCallArgs): read by nothing in resolution, it
 *     rides to the edge the call becomes as `metadata.args` (not in
 *     `refCandidates`, and back from there when the edge is resurrected), for
 *     ../../resolution/matlab-argument-synthesizer.ts to read against what the
 *     called function does with its parameters.
 *
 * No form fact means written with arguments (`f(x)`, `f()`), or a name that
 * is no bare one (`pkg.f(x)`, `@f`): what the reader cannot tell apart from
 * a call is kept, never discarded — unless it carries `runtime`.
 */

/**
 * One value an argument may hold, as the call site knows it:
 *   - `'text` — a text: a name (`'basis0`), or code an `eval` may run
 *     (`'helper(3)`);
 *   - `@name` — a handle to a named function, its reference name as the
 *     caller's `@name` gives it (`@basis1`, `@pkg::f`), looked up where the
 *     caller is;
 *   - `n` — the caller's own parameter n, as passed to it;
 *   - `{p, f?, s?}` — the caller's parameter p, or its field path f (`a.b`);
 *     `s` when code that may change an object ran before (a field read off
 *     it says nothing then);
 *   - `{r, s?}` — `varargin{:}`, the last argument: it and every argument
 *     after it are the caller's parameters from r on;
 *   - `{o}` — a struct the caller built, the values of the fields it knows.
 */
export type MatlabArgItem =
  | string
  | number
  | { p: number; f?: string; s?: 1 }
  | { r: number; s?: 1 }
  | { o: { [field: string]: MatlabArgValue } };

/** An argument's values: every one it may hold (one, or several). */
export type MatlabArgValue = MatlabArgItem | MatlabArgItem[];

/** Argument places a call's record covers, from the first: past them, nothing is recorded. */
export const MATLAB_ARG_PLACES = 8;

/** What a call passes, by argument position (0-based), for the arguments whose every value is known. */
export type MatlabCallArgs = { [position: string]: MatlabArgValue };

/** An argument's values as a list. */
export function argItemsOf(v: MatlabArgValue): MatlabArgItem[] {
  return Array.isArray(v) ? v : [v];
}

/** The `varargin{:}` item among an argument's values (see MatlabArgItem), if it has one. */
export function spreadItem(v: MatlabArgValue): { r: number; s?: 1 } | undefined {
  return argItemsOf(v).find((x): x is { r: number; s?: 1 } => typeof x === 'object' && 'r' in x);
}

export interface MatlabRefFacts {
  dispatch?: string;
  /** The `argClass:<Cls>` fact's class (see the top of this file). */
  argClass?: string;
  /** The `emptyCall` fact (see the top of this file). */
  emptyCall?: boolean;
  /** The `selfArg` fact (see the top of this file). */
  selfArg?: boolean;
  /** The `keptBy:<f>` facts' names, sorted (see the top of this file). */
  keptBy?: string[];
  variable?: string;
  form?: 'bare' | 'statement';
  runtime?: boolean;
  self?: boolean;
  param?: boolean;
  computed?: boolean;
  objectArg?: boolean;
  args?: MatlabCallArgs;
}

const DISPATCH = 'dispatch:';
const VARIABLE = 'variable:';
/** The `argClass` fact's tag. */
const ARG_CLASS = 'argClass:';
/** The `args` fact's tag. */
const ARGS = 'args:';
/** The `runtime` fact's tag. */
export const RUNTIME_TAG = 'runtime';
/** The `self` fact's tag. */
const SELF_TAG = 'self';
/** The `param` fact's tag. */
const PARAM_TAG = 'param';
/** The `computed` fact's tag. */
export const COMPUTED_TAG = 'computed';
/** The `objectArg` fact's tag. */
const OBJECT_ARG_TAG = 'objectArg';
/** The `emptyCall` fact's tag. */
const EMPTY_CALL_TAG = 'emptyCall';
/** The `selfArg` fact's tag. */
const SELF_ARG_TAG = 'selfArg';
/** The `keptBy` fact's tag. */
export const KEPT_BY = 'keptBy:';
/** The `ctor` fact's tag: a lower-case construction an on-object call under a built-in's name was read on (see ctorRefs in matlab.ts). */
export const CTOR_TAG = 'ctor';

/** `facts` as a reference's `candidates`, or undefined when there are none. */
export function matlabRefCandidates(facts: MatlabRefFacts): string[] | undefined {
  const out: string[] = [];
  if (facts.dispatch) out.push(DISPATCH + facts.dispatch);
  if (facts.argClass) out.push(ARG_CLASS + facts.argClass);
  if (facts.variable) out.push(VARIABLE + facts.variable);
  if (facts.form) out.push(facts.form);
  if (facts.runtime) out.push(RUNTIME_TAG);
  if (facts.self) out.push(SELF_TAG);
  if (facts.param) out.push(PARAM_TAG);
  if (facts.computed) out.push(COMPUTED_TAG);
  if (facts.objectArg) out.push(OBJECT_ARG_TAG);
  if (facts.emptyCall) out.push(EMPTY_CALL_TAG);
  if (facts.selfArg) out.push(SELF_ARG_TAG);
  for (const f of facts.keptBy ?? []) out.push(KEPT_BY + f);
  if (facts.args) out.push(ARGS + JSON.stringify(facts.args));
  return out.length > 0 ? out : undefined;
}

/** Whether a candidate is the `args` fact's (see the top of this file). */
export function isMatlabArgsCandidate(c: string): boolean {
  return c.startsWith(ARGS);
}

/**
 * A MATLAB reference's `candidates` as an edge keeps them: the `args` fact
 * apart (`metadata.args`, a JSON value), the rest as they are
 * (`metadata.refCandidates`).
 */
export function splitMatlabArgs(candidates: readonly string[]): { rest: string[]; args?: MatlabCallArgs } {
  let args: MatlabCallArgs | undefined;
  const rest: string[] = [];
  for (const c of candidates) {
    if (isMatlabArgsCandidate(c)) args = parseArgs(c);
    else rest.push(c);
  }
  return { rest, ...(args ? { args } : {}) };
}

/** The candidates `splitMatlabArgs` split, as one list again: what a resurrected edge's reference carries. */
export function joinMatlabArgs(rest: readonly string[], args: unknown): string[] {
  return args && typeof args === 'object' ? [...rest, ARGS + JSON.stringify(args)] : [...rest];
}

/** The `args` fact's value, or undefined when its text is not one. */
function parseArgs(c: string): MatlabCallArgs | undefined {
  try {
    const v: unknown = JSON.parse(c.slice(ARGS.length));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as MatlabCallArgs) : undefined;
  } catch {
    return undefined;
  }
}

/** The facts a MATLAB reference's `candidates` carry (see the top of this file), `args` aside; an unknown tag is passed over. */
export function matlabRefFacts(ref: { candidates?: readonly string[] }): MatlabRefFacts {
  const facts: MatlabRefFacts = {};
  for (const c of ref.candidates ?? []) {
    if (c.startsWith(DISPATCH)) facts.dispatch = c.slice(DISPATCH.length);
    else if (c.startsWith(ARG_CLASS)) facts.argClass = c.slice(ARG_CLASS.length);
    else if (c.startsWith(VARIABLE)) facts.variable = c.slice(VARIABLE.length);
    else if (c === 'bare' || c === 'statement') facts.form = c;
    else if (c === RUNTIME_TAG) facts.runtime = true;
    else if (c === SELF_TAG) facts.self = true;
    else if (c === PARAM_TAG) facts.param = true;
    else if (c === COMPUTED_TAG) facts.computed = true;
    else if (c === OBJECT_ARG_TAG) facts.objectArg = true;
    else if (c === EMPTY_CALL_TAG) facts.emptyCall = true;
    else if (c === SELF_ARG_TAG) facts.selfArg = true;
    else if (c.startsWith(KEPT_BY)) (facts.keptBy ??= []).push(c.slice(KEPT_BY.length));
    // `args` is resolution's to carry, not to read: see splitMatlabArgs.
  }
  return facts;
}
