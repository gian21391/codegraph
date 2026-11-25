/**
 * MATLAB name resolution — MATLAB's own function precedence, not name matching.
 *
 * A bare name `f` is, in MATLAB's order (the extractor has already dropped
 * the variables, which come first):
 *
 *   1. a name the calling function imports explicitly (`import pkg.f`);
 *   2. a nested function the caller can see: one nested in the caller or in a
 *      function the caller is nested in (its parent's, its siblings');
 *   3. a local function of the calling file — any function of the file not
 *      nested in another — or a class the file itself defines, unless the
 *      file is a package's (`+util/size.m` is `util.size` from itself too);
 *   4. a member of a package the calling function imports (`import pkg.*`);
 *   5. a function in a `private/` folder beside the calling file, or a script
 *      there, which a call of a form that runs one (see below) runs and any
 *      other call of the name finds first and reaches nothing by;
 *   6. a method of the class of the call's first argument, when the extractor
 *      knows it (`m(obj, …)` on a method's own object, `area(c)` after
 *      `c = Shape(…)`: the ref is `Cls::m`, the written name in `candidates`);
 *   7. a class kept in a class folder (`@Cls/`), then a function file's
 *      function or a class on the path — outside every `+package` folder: a
 *      package member is reached by its full name even from its own package.
 *      A call of a form that runs a script reaches a script on the path too:
 *      its file node. Those forms are a statement of its own (`setup_paths`,
 *      `run setup_paths`), a callback given as text that is one
 *      (`'Callback', 'refresh_plots'`), a call with an empty argument list as
 *      a statement (`setup_paths();`, `feval('setup_paths');`) and a handle
 *      (`@setup_paths`, which names the script): see runsScript. A call of
 *      any other form (`f(2)`, `x = f;`, `feval('f', 2)`) whose first file
 *      of the name, by the same rules, is a script reaches nothing: MATLAB
 *      runs the first `f` it finds, and a script called so is an error
 *      ('Execution of script f as a function is not supported'), not a call
 *      of a farther function.
 *   8. Last, when nothing above answers: a stub, the help text of a MEX
 *      function of the name (`chanGet.m`, `%` help text only, beside the
 *      `chanGet.mexa64` the index never reads; see ../graph/matlab-scripts),
 *      for a call of any form: its file node, the help being what the call
 *      reaches. One in a `private/` folder in reach first, then by the path
 *      rules of step 7, a script of the name competing (a stub behind a
 *      nearer script is never reached). MATLAB would put a MEX file in a
 *      folder before a function file in a later one, but the index sees no
 *      MEX file, and a help text with none beside it is an empty script:
 *      last is the side that adds no wrong edge. Never a built-in's name.
 *      Every form of a call ranks a stub against a script the same way, as
 *      MATLAB finds the same first file of the name for `f`, `f()` and
 *      `f(1)`: the stub when the path rules pick it over every script of
 *      the name; else the script, which a form that runs one runs, and any
 *      other reaches nothing by (MATLAB runs the script, and the call
 *      errors). A nearer `.m` of the name that the
 *      index reads as no MATLAB (Octave, binary) blocks no farther stub,
 *      though MATLAB would find that file first; an empty one is a script.
 *
 * An import holds in the function that makes it and the functions nested in
 * it, not in the file's other functions. Of several equally near same-named
 * files the first in `genpath` order is picked (see `nearest`).
 *
 * When the project's startup code sets a search path (../graph/
 * matlab-search-path), it decides between same-named definitions instead
 * (see `choose`): a caller the path runs sees only what is visible from it,
 * the current folder first, then path order, and a name defined only off the
 * path gets no edge; any other caller takes its own folder's copy, then the
 * path's, then the nearest. Steps 1, 4 and 6 (an import, a wildcard import,
 * the class of the first argument) find their target by its qualified name
 * through the same choice, so they respect the path too: a package or a
 * class only off the path is not imported or dispatched to from a caller on
 * it, as in MATLAB. Steps 2, 3 and 5 are the same either way.
 *
 * A package member is otherwise reached only by its full name (`pkg.sub.f`),
 * which the extractor writes as the qualified ref `pkg::sub::f`; a method
 * through its class (`Cls::m`, from `Cls.m()` or `obj.m()` on a method's own
 * object), found on the class or else on its superclasses, read from the
 * `classdef X < A & B` signature. A method on a variable of no stated class
 * (`robot.accel(…)` on a parameter) resolves only when one class defines it,
 * or one class and subclasses of it that override it, and no property shares
 * its name — or, when several unrelated classes define it, the one a
 * capitalised parameter the function never writes to is named after,
 * ignoring case (`Problem.Evaluation(x)` in `main(Algorithm, Problem)` →
 * `PROBLEM`'s; never a lower-case `model`, a struct far more often).
 * A member written without parentheses on such a variable is a struct's
 * field, never a method. A local function of ANOTHER file is never
 * reachable — that is what made the generic name matcher unsafe here: every
 * MATLAB project has a dozen local `readOpts` / `helper`s.
 *
 * A class-folder method declared in its classdef (`d = magsq(obj)`) and
 * written in its own file (`@Pt/magsq.m`) is two nodes of one qualified name:
 * the method file's, which has the body, is the one linked. (The declaration's
 * `Static` / `Access` attributes are not carried to the method file's node;
 * lookups read them from the declaration.)
 *
 * Authoritative: a MATLAB ref this does not resolve stays unresolved (a
 * built-in such as `disp`, a toolbox function) rather than falling through to
 * fuzzy matching.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { matlabFileNames, matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';
import { matlabRefFacts, type MatlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { MATLAB_BUILTINS, MATLAB_METHOD_ONLY_NAMES } from '../extraction/languages/matlab-builtins';
import { MATLAB_DOCUMENTED_METHOD_NAMES } from '../extraction/languages/matlab-builtin-names';
import { isMatlabScriptFile, isMatlabStubFile } from '../graph/matlab-scripts';
import { dirOf, matlabLookupFolder, type MatlabSearchPath } from '../graph/matlab-search-path';

const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'enum']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);
const NAMED_KINDS: ReadonlySet<string> = new Set([...CALLABLE_KINDS, ...TYPE_KINDS]);
const METHOD_KINDS: ReadonlySet<string> = new Set(['method']);
/** What a qualified name names directly: a package's function or class (a method goes through its class: see qualifiedMethod). */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['function', ...TYPE_KINDS]);

/** `pkg::sub` for `pkg::sub::f`, `pkg::Cls` for its method `pkg::Cls::m`; '' for a top-level name. */
export function ownerOf(n: Pick<Node, 'qualifiedName'>): string {
  const i = n.qualifiedName.lastIndexOf('::');
  return i < 0 ? '' : n.qualifiedName.slice(0, i);
}

function matlab(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.language === 'matlab');
}

/** Whether a `private/` folder's file is in reach of the caller: from the folder's parent or the folder itself. */
function privateInReach(candidate: Node, callerFile: string): boolean {
  const dir = dirOf(candidate.filePath);
  if (!/(?:^|\/)private$/.test(dir)) return true;
  const callerDir = dirOf(callerFile);
  return callerDir === dir || callerDir === dirOf(dir);
}

/** Whether a method is its class's constructor (`pkg::Cls::Cls`). */
export function isConstructor(n: Pick<Node, 'name' | 'qualifiedName'>): boolean {
  const owner = ownerOf(n);
  return owner === n.name || owner.endsWith(`::${n.name}`);
}

/** Whether a node sits in a class folder (`…/@Cls/x.m`). */
function inClassFolder(n: Node): boolean {
  return /(?:^|\/)@[^/]+\/[^/]+$/.test(n.filePath);
}

/**
 * Whether `n` is a class written in a file of another name, with its case
 * (`classdef Gadget` in `gadget.m`), or in a class folder's file of another
 * name than the folder's (`@Gadget/gadget.m`): MATLAB finds a class by the
 * file of its name, and a class folder's class by the file named after the
 * folder (doc 'Class Folders'; a classdef's name must match its file's), so
 * this one is no class it knows: no superclass, no subclass of the classes
 * it lists (its own `extends` link nothing, and the override synthesizer
 * reads no hierarchy through it: ./matlab-override-synthesizer), no home of
 * its folder's methods, nor what a call of its name makes.
 */
export function isMatlabMisnamedClass(n: Pick<Node, 'kind' | 'name' | 'filePath'>): boolean {
  if (!TYPE_KINDS.has(n.kind)) return false;
  const stem = matlabFileStem(n.filePath);
  if (stem !== n.name) return true;
  const folder = matlabPathScope(n.filePath).classFolder;
  return folder !== undefined && stem !== folder;
}

/** The function or class a package file defines (`+util/size.m` → `util::size`); its local functions are not. */
function isPackageMember(n: Node): boolean {
  return ownerOf(n) !== '' && (TYPE_KINDS.has(n.kind) || (n.kind === 'function' && n.isExported === true));
}

/** A class-folder method in its own file (`@Pt/magsq.m` → `Pt::magsq`): the one with the body. */
function isMethodFile(n: Node): boolean {
  return n.kind === 'method' && inClassFolder(n) && matlabFileStem(n.filePath) === n.name;
}

/**
 * Drops a classdef's declaration of a method whose method file is among
 * `nodes`: the same qualified name in the same class folder (another copy of
 * the class elsewhere is another class, whichever file holds its body).
 */
function preferBodies(nodes: Node[]): Node[] {
  const bodies = nodes.filter(isMethodFile);
  if (bodies.length === 0 || bodies.length === nodes.length) return nodes;
  const defined = new Set(bodies.map((n) => `${dirOf(n.filePath)}\0${n.qualifiedName}`));
  return nodes.filter((n) => isMethodFile(n) || !defined.has(`${dirOf(n.filePath)}\0${n.qualifiedName}`));
}

interface Imports {
  /** `import pkg.*` → `pkg::…` */
  wildcards: string[];
  /** `import pkg.Cls` → Cls ↦ pkg::Cls */
  exact: Map<string, string>;
}

const NO_IMPORTS: Imports = { wildcards: [], exact: new Map() };

/** What a file holds, read once per file for all its refs (see `fileFacts`). */
interface FileFacts {
  /** Its functions and methods, by qualified name. */
  functions: Map<string, Node>;
  /** Its MATLAB nodes, by id and by name. */
  byId: Map<string, Node>;
  byName: Map<string, Node[]>;
  /** Its imports, each with the qualified name of the function that makes it ('' outside every function). */
  imports: { node: Node; owner: string }[];
}

/**
 * Per file, keyed by the node array the context returns for it: that array is
 * the resolver's per-file cache entry, which it replaces whenever it drops its
 * caches (a sync, an LRU eviction), so an entry here never outlives the nodes
 * it was read from, needs no clearing of its own, and is held no longer than
 * the resolver's LRU holds the nodes. A context that built a new array per
 * call would still be answered right, only by reading the file's nodes again
 * for every reference: the resolver's does not (pinned in
 * __tests__/matlab-resolution.test.ts).
 */
const FILE_FACTS = new WeakMap<Node[], FileFacts>();

function fileFacts(filePath: string, context: ResolutionContext): FileFacts {
  const all = context.getNodesInFile(filePath);
  let facts = FILE_FACTS.get(all);
  if (facts) return facts;
  facts = { functions: new Map(), byId: new Map(), byName: new Map(), imports: [] };
  for (const n of matlab(all)) {
    facts.byId.set(n.id, n);
    const named = facts.byName.get(n.name);
    if (named) named.push(n);
    else facts.byName.set(n.name, [n]);
    if (CALLABLE_KINDS.has(n.kind)) facts.functions.set(n.qualifiedName, n);
  }
  for (const n of facts.byId.values()) {
    if (n.kind !== 'import') continue;
    const owner = n.qualifiedName.endsWith(`::${n.name}`) ? n.qualifiedName.slice(0, -(n.name.length + 2)) : '';
    facts.imports.push({ node: n, owner });
  }
  FILE_FACTS.set(all, facts);
  return facts;
}

/** Where a ref is written: its file, the functions it sits in and the imports they make. */
interface Caller {
  file: string;
  /** What the file holds. */
  facts: FileFacts;
  /** The calling function's qualified name, then each function it is nested in, innermost first. */
  scopes: string[];
  imports: Imports;
}

/** A function of the file that another function of it nests (`gui::cb` in gui), by the qualified name of that parent. */
function nestingParent(n: Node, functions: ReadonlyMap<string, Node>): string | null {
  const owner = ownerOf(n);
  return owner && functions.has(owner) ? owner : null;
}

function callerOf(ref: UnresolvedRef, context: ResolutionContext): Caller {
  const facts = fileFacts(ref.filePath, context);
  const { functions } = facts;
  const from = facts.byId.get(ref.fromNodeId);
  const scopes: string[] = [];
  for (let fn = from && CALLABLE_KINDS.has(from.kind) ? from : undefined; fn; ) {
    scopes.push(fn.qualifiedName);
    const parent = nestingParent(fn, functions);
    fn = parent ? functions.get(parent) : undefined;
  }
  // An import holds in the function that makes it and in the functions nested
  // in it. One made outside every function (a script's) holds in the script's code.
  const wildcards: string[] = [];
  const exact = new Map<string, string>();
  for (const { node: n, owner } of facts.imports) {
    if (functions.has(owner) ? !scopes.includes(owner) : scopes.length > 0) continue;
    if (n.name.endsWith('.*')) wildcards.push(n.name.slice(0, -2).replace(/\./g, '::'));
    else {
      const qn = n.name.replace(/\./g, '::');
      const cut = qn.lastIndexOf('::');
      exact.set(cut < 0 ? qn : qn.slice(cut + 2), qn);
    }
  }
  return { file: ref.filePath, facts, scopes, imports: { wildcards, exact } };
}

/**
 * MATLAB's `genpath` order of two folders: segment by segment in ASCII order,
 * a folder before its own subfolders (`genpath` walks depth-first, listing a
 * folder before what it holds, its subfolders as `dir` sorts them).
 */
function genpathOrder(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < x.length && i < y.length; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * Of several same-named definitions, the one nearest the caller: same folder,
 * then the longest shared folder prefix. Equally near ones are settled by path
 * order: MATLAB runs the first of duplicate path functions on its search path,
 * and `addpath(genpath(root))` is how a project usually puts itself there, so
 * the first in `genpath` order is the one that runs. Only a tie goes by path
 * order; two in one folder, which path order cannot tell apart, give none.
 */
function nearest(candidates: Node[], callerFile: string): Node | undefined {
  if (candidates.length <= 1) return candidates[0];
  let best: Node[] = [];
  let bestScore = -1;
  for (const c of candidates) {
    const score = nearness(c.filePath, callerFile);
    if (score > bestScore) {
      best = [c];
      bestScore = score;
    } else if (score === bestScore) best.push(c);
  }
  if (best.length === 1) return best[0];
  const [first, second] = best.map((c) => dirOf(c.filePath)).sort(genpathOrder);
  return first === second ? undefined : best.find((c) => dirOf(c.filePath) === first);
}

/** How near a file is to the caller's: the same folder above all, then the number of leading folders they share. */
function nearness(filePath: string, callerFile: string): number {
  const dir = dirOf(filePath);
  const callerDir = dirOf(callerFile);
  if (dir === callerDir) return Number.MAX_SAFE_INTEGER;
  const a = dir.split('/');
  const b = callerDir.split('/');
  let score = 0;
  while (score < a.length && score < b.length && a[score] === b[score]) score++;
  return score;
}

function searchPathOf(context: ResolutionContext): MatlabSearchPath | null {
  return context.getMatlabSearchPath?.() ?? null;
}

/** The folder a caller runs from when it is off the path: its own (a class folder's or a package's parent, a `private/` folder's parent). */
export function callerFolder(callerFile: string): string {
  const folder = matlabLookupFolder(callerFile);
  return folder ?? dirOf(dirOf(callerFile));
}

/** Of same-named visible candidates, the first in path order (equally placed ones settled by `nearest`); undefined for none. */
function firstOnPath(searchPath: MatlabSearchPath, candidates: Node[], callerFile: string): Node | undefined {
  const ordered = searchPath.visibleInOrder(candidates);
  if (ordered.length === 0) return undefined;
  const best = searchPath.rankOf(ordered[0]!.filePath);
  const top = ordered.filter((n) => searchPath.rankOf(n.filePath) === best);
  return top.length === 1 ? top[0] : nearest(top, callerFile);
}

/**
 * Of several same-named definitions, the one MATLAB runs from `callerFile`.
 * With no search path in force, the nearest (see `nearest`). With one: for a
 * caller the path runs, the first visible one in path order, or none; for
 * any other, a copy in the folder it runs from, then the first visible one,
 * then the nearest.
 *
 * `builtin`: MATLAB defines the name itself (MATLAB_BUILTINS), and with a
 * search path its own function runs unless a copy comes first: one in the
 * folder the caller runs from, or on the path ahead of MATLAB's own folders.
 * A copy put after them (`addpath(…, '-end')`, as
 * `matlab/user1/commands/sound.m`), and for a caller off the path a copy in
 * some other folder off it (`vendor/fitpack/override/optimset.m`), is
 * never reached: none.
 */
function choose(candidates: Node[], callerFile: string, context: ResolutionContext, builtin = false): Node | undefined {
  const searchPath = searchPathOf(context);
  if (!searchPath || candidates.length === 0) return nearest(candidates, callerFile);
  const reached = builtin ? candidates.filter((n) => searchPath.isBeforeMatlab(n.filePath)) : candidates;
  if (searchPath.isCallerOnPath(callerFile)) return firstOnPath(searchPath, reached, callerFile);
  const home = callerFolder(callerFile);
  const own = candidates.filter((n) => matlabLookupFolder(n.filePath) === home);
  if (own.length > 0) return nearest(own, callerFile);
  const visible = firstOnPath(searchPath, reached, callerFile);
  return visible ?? (builtin ? undefined : nearest(candidates, callerFile));
}

/**
 * Whether a project's `.m` file `copyFile` of a built-in's name may be what
 * MATLAB runs for a bare call of the name from `callerFile`, ahead of
 * MATLAB's own function, by the rules `choose` applies to a built-in's name:
 * a copy in the folder the caller runs from (the current folder, for a
 * caller off the path; for one on it, a folder the current one may be), one
 * ahead of MATLAB's own folders on the path, a `private/` one in reach. With
 * no path in force, any copy may be. A copy in a package or a class folder
 * never is (no bare call reaches it). A call that failed while such a copy
 * stands failed for another reason than MATLAB's own function winning: a
 * script called with arguments, a nearer case variant, a stub (the help of
 * a MEX function MATLAB runs instead): see ./matlab-failures.
 */
export function matlabBuiltinCopyMayWin(callerFile: string, copyFile: string, context: ResolutionContext): boolean {
  const scope = matlabPathScope(copyFile);
  if (scope.packages.length > 0 || scope.classFolder !== undefined) return false;
  const dir = dirOf(copyFile);
  if (/(?:^|\/)private$/.test(dir)) {
    const callerDir = dirOf(callerFile);
    return callerDir === dir || callerDir === dirOf(dir);
  }
  const searchPath = searchPathOf(context);
  if (!searchPath) return true;
  if (dir === callerFolder(callerFile)) return true;
  return searchPath.isBeforeMatlab(copyFile);
}

/** `candidates` a caller the path runs can see; all of them for any other caller, or with no path. */
function seenFrom(candidates: Node[], callerFile: string, context: ResolutionContext): Node[] {
  const searchPath = searchPathOf(context);
  if (!searchPath || !searchPath.isCallerOnPath(callerFile)) return candidates;
  return candidates.filter((n) => searchPath.isVisible(n.filePath));
}

/**
 * A path-visible definition by exact qualified name: a package function, a
 * class, a class's method. Never a file's local function, even from its own
 * file: one is reached by its bare name there alone (step 3 of resolveBare;
 * doc 'Local Functions'), and `pkg.f` names the package's `f.m` even from a
 * file of the package that has a local `f` (doc 'Namespaces').
 */
function byQualifiedName(qn: string, callerFile: string, context: ResolutionContext, kinds: ReadonlySet<string>): Node | undefined {
  const hits = matlab(context.getNodesByQualifiedName(qn)).filter(
    (n) => kinds.has(n.kind) && (n.kind !== 'function' || n.isExported) && !isMatlabMisnamedClass(n) && privateInReach(n, callerFile),
  );
  return choose(preferBodies(hits), callerFile, context);
}

/** A class written as `Name` or `pkg.Name` where `caller` is: its exact qualified name, else through the caller's imports. */
function resolveType(written: string, caller: Pick<Caller, 'file' | 'imports'>, context: ResolutionContext): Node | undefined {
  const exact = byQualifiedName(written, caller.file, context, TYPE_KINDS);
  if (exact) return exact;
  if (written.includes('::')) return undefined;
  const imported = caller.imports.exact.get(written);
  if (imported) {
    const hit = byQualifiedName(imported, caller.file, context, TYPE_KINDS);
    if (hit) return hit;
  }
  for (const pkg of caller.imports.wildcards) {
    const hit = byQualifiedName(`${pkg}::${written}`, caller.file, context, TYPE_KINDS);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Per context: superclassesOf's answers by class id, and resolveVariableMethod's
 * by member and calling folder. They are read from node rows alone (a class's
 * signature, the nodes a name finds), so they hold as long as the context's
 * node caches do, and go with them (clearMatlabLookupMemos, from
 * ReferenceResolver.clearCaches).
 */
const SUPERCLASSES = new WeakMap<ResolutionContext, Map<string, Node[]>>();
const VARIABLE_METHODS = new WeakMap<ResolutionContext, Map<string, VariableMethods>>();

/** Drop the memos above (see ReferenceResolver.clearCaches). */
export function clearMatlabLookupMemos(context: ResolutionContext): void {
  SUPERCLASSES.delete(context);
  VARIABLE_METHODS.delete(context);
}

/**
 * A class's superclass list as written in its `classdef X < A & B` signature,
 * which the extractor writes from the AST on one line: `['A', 'pkg::B']`.
 */
export function matlabSuperclassNames(cls: Pick<Node, 'signature'>): string[] {
  const m = /<\s*(.+)$/.exec(cls.signature ?? '');
  if (!m) return [];
  return m[1]!.split('&').map((raw) => raw.trim().replace(/\./g, '::')).filter((name) => name.length > 0);
}

/**
 * The classes the superclass names `bases`, written in `filePath`, resolve to,
 * and every class those inherit from.
 */
export function matlabAncestorClasses(bases: readonly string[], filePath: string, context: ResolutionContext): Node[] {
  const seen = new Map<string, Node>();
  const walk = (cls: Node): void => {
    if (seen.has(cls.id)) return;
    seen.set(cls.id, cls);
    for (const sup of superclassesOf(cls, context)) walk(sup);
  };
  for (const name of bases) {
    const cls = superclassNamed(name, filePath, context);
    if (cls) walk(cls);
  }
  return [...seen.values()];
}

/**
 * The class a name in a classdef's superclass list, written in `filePath`,
 * resolves to (a superclass list sees no import: it is outside every
 * function). None when that is an old-style class (an `@Cls` folder's
 * constructor, no classdef): MATLAB refuses such a superclass (R2026a:
 * "The specified superclass … cannot be found on MATLAB's search path, or
 * is shadowed"), so the classdef inherits nothing from it, and its
 * `extends` reaches nothing; nor a farther classdef of the name, which the
 * first one shadows.
 */
function superclassNamed(name: string, filePath: string, context: ResolutionContext): Node | undefined {
  const sup = resolveType(name, { file: filePath, imports: NO_IMPORTS }, context);
  return sup && !isOldStyleClass(sup) ? sup : undefined;
}

/**
 * Superclasses of a class, from its `classdef X < A & B` signature (the
 * extractor writes it from the AST, one line) — not from its `extends` edges:
 * a sync resolves the refs of the files it changed before it reopens the
 * `extends` of an unchanged class whose superclass moved, and a call resolved
 * in between would find the chain cut.
 */
function superclassesOf(cls: Node, context: ResolutionContext): Node[] {
  let memo = SUPERCLASSES.get(context);
  if (!memo) SUPERCLASSES.set(context, (memo = new Map()));
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const out: Node[] = [];
  for (const name of matlabSuperclassNames(cls)) {
    const sup = superclassNamed(name, cls.filePath, context);
    if (sup && sup.id !== cls.id) out.push(sup);
  }
  memo.set(cls.id, out);
  return out;
}

/**
 * The methods `name` that the class definition `cls` has itself: MATLAB's
 * class is the one definition its name resolves to (doc 'Class Precedence
 * and MATLAB Path': of same-named classes the first on the path is the
 * class; 'Function Precedence Order'), so its methods are the ones in that
 * definition's file or, in a class folder, in that folder (doc 'Class
 * Folders'); another copy of the class elsewhere is another class, whichever
 * file holds its method. An old-style class (an `@Cls` folder whose `Cls.m`
 * is a constructor function, no classdef) also has the methods of every
 * other `@Cls` folder that is no classdef's folder, one that holds a
 * constructor of its own too: the legacy class's methods are the functions
 * of every `@Cls` folder on the path, its constructor the first on the path
 * (MATLAB R2026a: `methods(g)` lists the methods of three `@gadget` folders,
 * two of them with a constructor, and each one runs), the one the path
 * rules pick of those (see choose).
 */
function heldMethods(cls: Node, name: string, callerFile: string, context: ResolutionContext): Node | undefined {
  const all = preferBodies(matlab(context.getNodesByQualifiedName(`${cls.qualifiedName}::${name}`)).filter((n) => n.kind === 'method'));
  if (all.length === 0) return undefined;
  const held = all.filter((n) => matlabMethodHeldBy(cls, n));
  if (held.length > 0) return nearest(held, callerFile);
  if (!isOldStyleClass(cls)) return undefined;
  const classdefs = matlabClassdefFolders(matlab(context.getNodesByQualifiedName(cls.qualifiedName)));
  const loose = all.filter((n) => inClassFolder(n) && !classdefs.has(dirOf(n.filePath)));
  return loose.length > 0 ? choose(loose, callerFile, context) : undefined;
}

/**
 * The class folders among `copies` (the nodes of one qualified name) that
 * hold a classdef of it: a classdef's methods are its own folder's alone, so
 * an old-style class of the name takes none of them (see heldMethods).
 */
export function matlabClassdefFolders(copies: readonly Pick<Node, 'kind' | 'filePath' | 'signature'>[]): Set<string> {
  const out = new Set<string>();
  for (const c of copies) {
    if (TYPE_KINDS.has(c.kind) && /(?:^|\/)@[^/]+\/[^/]+$/.test(c.filePath) && (c.signature ?? '').startsWith('classdef')) out.add(dirOf(c.filePath));
  }
  return out;
}

/** Whether method node `m` (`Cls::m`) is one class definition `cls` holds: in its file, or in its class folder (see heldMethods). */
export function matlabMethodHeldBy(cls: Pick<Node, 'filePath'>, m: Pick<Node, 'filePath'>): boolean {
  return m.filePath === cls.filePath || (/(?:^|\/)@[^/]+\/[^/]+$/.test(cls.filePath) && dirOf(m.filePath) === dirOf(cls.filePath));
}

/**
 * Method `name` on class `cls` or the first superclass (depth-first, as MATLAB
 * lists them) that defines it, each class the definition its name resolves
 * to and its methods its own (see heldMethods). Never through a superclass
 * chain that comes back to a class on it (see inCycle): MATLAB defines no
 * class there, so no method is inherited along it. (MATLAB defines none of
 * the classes in or below such a chain at all; their own methods are still
 * linked, as a sync can only follow a chain upwards: see
 * MatlabSuperclassChange in ./matlab-sync.)
 */
function methodOnHierarchy(cls: Node, name: string, callerFile: string, context: ResolutionContext): Node | undefined {
  const own = heldMethods(cls, name, callerFile, context);
  if (own) return own;
  if (inCycle(cls, context)) return undefined;
  const seen = new Set<string>();
  const walk = (c: Node): Node | undefined => {
    if (seen.has(c.id)) return undefined;
    seen.add(c.id);
    const own = heldMethods(c, name, callerFile, context);
    if (own) return own;
    for (const sup of superclassesOf(c, context)) {
      const hit = walk(sup);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(cls);
}

/**
 * Whether class `cls`'s superclass chain, each superclass resolved as MATLAB
 * would (superclassesOf), comes back to a class on it: `A < B`, `B < A`.
 * MATLAB refuses such a definition (a class cannot be its own superclass,
 * however far up), and a class below it, which needs it defined, with it
 * (see methodOnHierarchy for what is linked there).
 */
function inCycle(cls: Node, context: ResolutionContext): boolean {
  const onPath = new Set<string>();
  const done = new Set<string>();
  const walk = (c: Node): boolean => {
    if (onPath.has(c.id)) return true;
    if (done.has(c.id)) return false;
    onPath.add(c.id);
    for (const sup of superclassesOf(c, context)) if (walk(sup)) return true;
    onPath.delete(c.id);
    done.add(c.id);
    return false;
  };
  return walk(cls);
}

/**
 * A method by its qualified name (`Cls::m`, `pkg::Cls::m`) where `caller` is:
 * on the class the owner resolves to there, or a superclass of it (see
 * methodOnHierarchy). When the project defines no class of the owner's name
 * at all (methods of a built-in type's class folder, `@double/f.m`), the
 * method by its name, as the path rules pick it.
 */
function qualifiedMethod(owner: string, member: string, caller: Pick<Caller, 'file' | 'imports'>, context: ResolutionContext): Node | undefined {
  const cls = resolveType(owner, caller, context);
  if (cls) return methodOnHierarchy(cls, member, caller.file, context);
  if (matlab(context.getNodesByQualifiedName(owner)).some((n) => TYPE_KINDS.has(n.kind))) return undefined;
  return byQualifiedName(`${owner}::${member}`, caller.file, context, METHOD_KINDS);
}

/**
 * The class an object the extractor says is of class `cls` (`Gizmo`,
 * `pkg::Gizmo`, `gadget`: the dispatch and argClass facts) is of, where
 * `caller` is: what a call of the name there makes (MATLAB doc 'Function
 * Precedence Order'), its qualified name, when that is a class (a classdef,
 * or an old-style class's constructor in an `@gadget` folder) — `Gizmo`
 * imported from a package is that package's. None when a function wins the
 * lookup (a local, a private or a plain function of the name: `g =
 * gadget();` then makes no object, and `tidy(g)` dispatches on no class), or
 * nothing answers it, even in the class's own folder (`@gadget/helper.m`
 * with no constructor: `gadget()` there runs a function of the name, and a
 * legacy object is made by its folder's constructor alone, doc 'class').
 * Which copy of the class answers is the method lookup's (qualifiedMethod).
 * `own`: the object is the method's own (the selfArg fact), of the caller's
 * class as written, whether or not the project defines that class where a
 * call of its name reaches (`@double/f.m`, a class folder with no
 * constructor).
 */
function constructedClass(cls: string, caller: Caller, context: ResolutionContext, own: boolean): string | undefined {
  if (own) return cls;
  const made = cls.includes('::') ? resolveQualified(cls, caller, context) : resolveBare(cls, caller, context);
  return made && TYPE_KINDS.has(made.kind) ? made.qualifiedName : undefined;
}

/**
 * The method `name` of class `cls` (`pkg::Cls`, or as the code wrote it) that
 * a call on one of its objects dispatches to. The constructor is no such
 * method: `Cls(obj, …)` calls the class, which the path lookup reaches.
 */
function dispatchedMethod(cls: string, name: string, caller: Caller, context: ResolutionContext): Node | undefined {
  if (cls === name || cls.endsWith(`::${name}`)) return undefined;
  return qualifiedMethod(cls, name, caller, context);
}

/**
 * Whether class `cls` has a method `f` an object of it gets from a call of
 * the name where `caller` makes it: its own or inherited (qualifiedMethod),
 * or, for a caller in the class's folder itself, a function of that folder's
 * `private/` (MATLAB R2026a: `x ~= 0` and `ne(x, 0)` in a method of `@Qpv`
 * run `@Qpv/private/ne.m`; `numel(k)` in a function outside `@Qpz` runs
 * MATLAB's `numel`, not `@Qpz/private/numel.m`: doc 'Private Functions').
 * See the keptBy fact in ../extraction/languages/matlab-ref-facts.
 */
function classHasMethod(cls: string, f: string, caller: Caller, context: ResolutionContext): boolean {
  if (qualifiedMethod(cls, f, caller, context) !== undefined) return true;
  const name = cls.includes('::') ? cls.slice(cls.lastIndexOf('::') + 2) : cls;
  // The caller's own folder (a private function of the folder is in reach of it too: see privateInReach).
  const at = caller.file.lastIndexOf('/');
  let dir = `/${at < 0 ? '' : caller.file.slice(0, at + 1)}`;
  if (dir.endsWith(`/@${name}/private/`)) dir = dir.slice(0, -'private/'.length);
  if (!dir.endsWith(`/@${name}/`)) return false;
  const priv = `${dir.slice(1)}private/`;
  return matlab(context.getNodesByName(f)).some((n) => n.kind === 'function' && n.filePath.startsWith(priv) && !n.filePath.slice(priv.length).includes('/'));
}

/** `pkg::sub::f`, `Cls::m`, `pkg::Cls`, `pkg::Cls::m`. */
function resolveQualified(name: string, caller: Caller, context: ResolutionContext): Node | undefined {
  // A package's function or class; a method only on the class its owner resolves to (see qualifiedMethod).
  const direct = byQualifiedName(name, caller.file, context, MEMBER_KINDS);
  if (direct) return direct;
  const cut = name.lastIndexOf('::');
  const owner = name.slice(0, cut);
  const member = name.slice(cut + 2);
  // The owner through an import (`Circle.unit()` after `import geom.*`).
  if (!owner.includes('::')) {
    const expansions = [caller.imports.exact.get(owner), ...caller.imports.wildcards.map((p) => `${p}::${owner}`)];
    for (const qn of expansions) {
      if (!qn) continue;
      const hit = byQualifiedName(`${qn}::${member}`, caller.file, context, MEMBER_KINDS) ?? qualifiedMethod(qn, member, caller, context);
      if (hit) return hit;
    }
  }
  // A method of the class, its own or inherited.
  const cls = resolveType(owner, caller, context);
  if (!cls) return qualifiedMethod(owner, member, caller, context);
  const method = methodOnHierarchy(cls, member, caller.file, context);
  if (method) return method;
  // `obj@Base(…)` names Base's constructor (`Base::Base`); a class that
  // declares none has MATLAB's default one — the class itself. A `calls` ref
  // that lands on a class is recorded as `instantiates`, so this edge reads
  // `Sub::Sub -instantiates-> Base` although a superclass-constructor call
  // makes no new object: the class node is the only one standing for its
  // default constructor, and an edge to it beats none for a flow through
  // the constructor chain.
  return member === cls.name ? cls : undefined;
}

/**
 * A bare `f` in MATLAB's precedence order (see the top of this file).
 * `dispatch`: the class of the call's first argument (`pkg::Cls`), whose
 * method `f` comes after the caller's own, imported and private functions
 * and before the path (`ownObject`: the method's own object, the selfArg
 * fact: see constructedClass), when that class has a method of each of
 * `keptBy`'s names (the keptBy fact: see ../extraction/languages/matlab-ref-facts). `runs`: the call is of a form that runs a
 * script MATLAB finds first for the name (see runsScript); any other form
 * that finds one first reaches nothing.
 */
function resolveBare(
  name: string,
  caller: Caller,
  context: ResolutionContext,
  dispatch?: string,
  runs = false,
  ownObject = false,
  keptBy: readonly string[] = [],
): Node | undefined {
  const from = caller.file;
  const { imports, scopes } = caller;
  // 1. An explicit import.
  const imported = imports.exact.get(name);
  if (imported) {
    const hit = byQualifiedName(imported, from, context, NAMED_KINDS);
    if (hit) return hit;
  }
  // 2–3. A nested function the caller sees (the innermost), then a local
  // function of the file, or a class it defines — but not the package
  // function or class the file is (`+util/size.m`): that is `util.size`
  // even from its own file, and a bare `size` there is the built-in.
  const { functions } = caller.facts;
  let local: Node | undefined;
  let nested: Node | undefined;
  let nestedDepth = Infinity;
  for (const n of caller.facts.byName.get(name) ?? []) {
    if (isPackageMember(n)) continue;
    if (n.kind === 'function') {
      const parent = nestingParent(n, functions);
      if (parent === null) local ??= n;
      else {
        const depth = scopes.indexOf(parent);
        if (depth >= 0 && depth < nestedDepth) {
          nested = n;
          nestedDepth = depth;
        }
      }
    } else if (TYPE_KINDS.has(n.kind)) local ??= n;
  }
  if (nested) return nested;
  if (local) return local;
  // 4. A member of a package the caller imports.
  for (const pkg of imports.wildcards) {
    const hit = byQualifiedName(`${pkg}::${name}`, from, context, NAMED_KINDS);
    if (hit) return hit;
  }
  // 5. Private functions in reach — and what is on the path, outside every package.
  const onPath = matlab(context.getNodesByName(name)).filter(
    (n) => ((n.kind === 'function' && n.isExported) || (TYPE_KINDS.has(n.kind) && !isMatlabMisnamedClass(n))) && privateInReach(n, from) && ownerOf(n) === '',
  );
  const priv = onPath.filter((n) => /(?:^|\/)private\//.test(n.filePath));
  // A private script in reach comes as early as a private function does (doc 'Function Precedence Order': private
  // functions, before the path): one that is first runs for a call of a form that runs it, and any other reaches nothing.
  const privScripts = scriptsNamed(name, context).filter((f) => /(?:^|\/)private\//.test(f.filePath) && privateInReach(f, from));
  if (priv.length > 0 || privScripts.length > 0) {
    const first = nearest(privScripts.length > 0 ? [...priv, ...privScripts] : priv, from);
    return first?.kind === 'file' && !runs ? undefined : first;
  }
  // 6. The first argument's class's own method, when its constructor's call reaches that class from here, and the
  // object is still one of it: a write the call reads it through passed it to a MATLAB function the class has a
  // method of (`x = x ~= 0`, the class's `ne`: the `keptBy` fact), every one.
  if (dispatch) {
    const cls = constructedClass(dispatch, caller, context, ownObject);
    const method = cls && keptBy.every((f) => classHasMethod(cls, f, caller, context)) && dispatchedMethod(cls, name, caller, context);
    if (method) return method;
  }
  // 7. A class-folder class, then the path. Never a method otherwise: one
  // called with function syntax on an object of a known class arrives with
  // `dispatch`, and any other `char(s, …)` is the built-in even inside a
  // class that overloads it. A script on the path is a file of it like a
  // function's, but runs only for a call of a form that runs it (`setup_paths`,
  // `run setup_paths`, `setup_paths();`, `@setup_paths`: `runs`): it takes no
  // argument and returns nothing. MATLAB takes the first file of the name on
  // the path all the same, and a call of any other form that finds a script
  // there is an error ('Execution of script … as a function is not
  // supported'): it reaches no farther function, and no edge. A private
  // script out of the caller's reach is none of its (step 5 took those in it).
  const folderClasses = onPath.filter((n) => TYPE_KINDS.has(n.kind) && inClassFolder(n));
  let target: Node | undefined;
  const scriptsHere = (): Node[] => scriptsNamed(name, context).filter((f) => privateInReach(f, from));
  if (searchPathOf(context)) {
    // A class folder's class on the path comes before any function; one the
    // caller cannot see leaves the functions and scripts it can.
    const builtin = MATLAB_BUILTINS.has(name);
    target = folderClasses.length > 0 ? choose(folderClasses, from, context, builtin) : undefined;
    if (!target) {
      const rest = onPath.filter((n) => !folderClasses.includes(n));
      const scripts = scriptsHere();
      target = choose(scripts.length > 0 ? [...rest, ...scripts] : rest, from, context, builtin);
    }
  } else if (folderClasses.length > 0) target = nearest(folderClasses, from);
  else {
    const scripts = scriptsHere();
    target = nearest(scripts.length > 0 ? [...onPath, ...scripts] : onPath, from);
  }
  // 8. A stub, when nothing above answers (one it found and a nearer case
  // variant beat answers no call, nor does a stub then); and when the first
  // file of the name is a script, a stub the path rules pick before every
  // script (stubTarget): MATLAB finds the same first file of the name for
  // every form of the call (`f`, `f()`, `f(1)`), and only what it does then
  // differs. A script there runs for a call of a form that runs it, and
  // answers no other (the call is an error): nothing does then.
  if (target && target.kind === 'file' && isMatlabScriptFile(target, context)) {
    const stub = stubTarget(name, from, context);
    if (stub) return !nearerInexactMatch(name, stub, from, context) ? stub : undefined;
    if (!runs) return undefined;
  }
  target ??= stubTarget(name, from, context);
  return target && !nearerInexactMatch(name, target, from, context) ? target : undefined;
}

/**
 * Step 8 (see the top of this file): the stub of `name` MATLAB reaches from
 * `from` — one in a `private/` folder in reach, the nearest; else the one the
 * path rules pick among the stubs and the scripts of the name (`choose`,
 * `nearest`), when that is a stub. A built-in's name has none.
 */
function stubTarget(name: string, from: string, context: ResolutionContext): Node | undefined {
  if (MATLAB_BUILTINS.has(name)) return undefined;
  const files = matlabFileNames(name).flatMap((fileName) => (context.isAbsentName?.(fileName) ? [] : context.getNodesByName(fileName)));
  const stubs = files.filter((file) => isMatlabStubFile(file, context) && privateInReach(file, from));
  if (stubs.length === 0) return undefined;
  const priv = stubs.filter((file) => /(?:^|\/)private\//.test(file.filePath));
  if (priv.length > 0) return nearest(priv, from);
  const scripts = files.filter((file) => isMatlabScriptFile(file, context) && privateInReach(file, from));
  const all = scripts.length > 0 ? [...stubs, ...scripts] : stubs;
  const picked = searchPathOf(context) ? choose(all, from, context) : nearest(all, from);
  return picked && stubs.includes(picked) ? picked : undefined;
}

/**
 * Whether a file of the path that matches `name` only when case is ignored
 * lies strictly nearer the caller than `target`, the nearest exact match: a
 * function file (`FindSlots.m` for `findslots`), a class, a script, the help
 * text of a MEX function (`LoopStep.m` beside `LoopStep.c` for `loopstep`), or
 * a class folder's constructor-shaped file (`@gmap/GMAP.m` for `GMAP` or `gmap`).
 * MATLAB matches a name with its case, and errors when it finds no exact match
 * ("Cannot find an exact (case-sensitive) match"), so the call is not to the
 * far file: the code was written against the near one, which runs only on an
 * old release on a case-blind file system, or nowhere. No edge then. An exact
 * match in the caller's own folder is never beaten.
 */
function nearerInexactMatch(name: string, target: Node, callerFile: string, context: ResolutionContext): boolean {
  const searchPath = searchPathOf(context);
  // A target the path chose (for any caller) is beaten only by a match
  // earlier on the path: one off it runs nowhere MATLAB looks. Else nearer
  // is nearer by folder, as with no path.
  const onPath = searchPath !== null && (searchPath.isCallerOnPath(callerFile) || searchPath.isVisible(target.filePath));
  const bar = onPath ? searchPath!.rankOf(target.filePath) : nearness(target.filePath, callerFile);
  if (bar === undefined || (!onPath && bar === Number.MAX_SAFE_INTEGER)) return false;
  const beats = (n: Node): boolean => {
    if (!onPath) return nearness(n.filePath, callerFile) > bar;
    const rank = searchPath!.rankOf(n.filePath);
    return rank !== undefined && rank < bar;
  };
  const lower = name.toLowerCase();
  const variants = [lower, `${lower}.m`].flatMap((k) => context.getNodesByLowerName(k));
  return matlab(variants).some((n) => {
    if (!beats(n) || !privateInReach(n, callerFile)) return false;
    const owner = ownerOf(n);
    // `@gmap/GMAP.m`: a constructor's file, its folder's name in another case or its own.
    if (n.kind === 'method') return isMethodFile(n) && !owner.includes('::') && owner.toLowerCase() === lower && (owner !== name || n.name !== name);
    if (n.name === name || (n.kind === 'file' && matlabFileStem(n.name) === name)) return false;
    if (n.kind === 'file') {
      const scope = matlabPathScope(n.filePath);
      return n.name.toLowerCase() === `${lower}.m` && scope.packages.length === 0 && scope.classFolder === undefined;
    }
    return owner === '' && ((n.kind === 'function' && n.isExported === true) || TYPE_KINDS.has(n.kind));
  });
}

/**
 * The file nodes of the scripts named `name` (`name.m`) that the path holds
 * (see ../graph/matlab-scripts for what a script is).
 */
function scriptsNamed(name: string, context: ResolutionContext): Node[] {
  return matlabFileNames(name).flatMap((fileName) =>
    context.isAbsentName?.(fileName) ? [] : context.getNodesByName(fileName).filter((file) => isMatlabScriptFile(file, context)));
}

/**
 * Whether `filePath`, a MATLAB file, is a script MATLAB runs by its name:
 * for a sync, which re-opens the calls into a file that stopped being one.
 */
export function isMatlabPathScript(filePath: string, context: ResolutionContext): boolean {
  const file = context.getNodesInFile(filePath).find((n) => n.kind === 'file');
  return file !== undefined && isMatlabScriptFile(file, context);
}

/**
 * Whether `filePath`, a MATLAB file, is a stub a call of its name may reach
 * (step 8): for a sync, which re-opens the calls of a file that became one.
 */
export function isMatlabPathStub(filePath: string, context: ResolutionContext): boolean {
  const file = context.getNodesInFile(filePath).find((n) => n.kind === 'file');
  return file !== undefined && isMatlabStubFile(file, context);
}

/**
 * `v.m()` on a variable whose class the function never states (a parameter,
 * mostly): the method, when exactly one class defines a method of that name
 * and nothing in the project has a property of that name — `opts.tol(1)` on a
 * struct, or `robot.links(1)` on a property, reads exactly the same. When
 * several classes define it and one of them is a superclass of all the others
 * (`Problem.SlopeAll(x)` on a PROBLEM, whose subclasses override `SlopeAll`),
 * `v` holds that class or one of its subclasses: the call is that class's
 * method, overridden or not.
 */
function resolveVariableMethod(name: string, callerFile: string, context: ResolutionContext, param = false): VariableMethod | undefined {
  const dot = name.lastIndexOf('.');
  const member = name.slice(dot + 1);
  // The answer depends on the caller only through its folder (see nearest).
  const key = `${member}\0${dirOf(callerFile)}`;
  let memo = VARIABLE_METHODS.get(context);
  if (!memo) VARIABLE_METHODS.set(context, (memo = new Map()));
  let hit = memo.get(key);
  if (hit === undefined) memo.set(key, (hit = variableMethod(member, callerFile, context)));
  if (hit.method) return { method: hit.method };
  if (!param || hit.roots.length < 2) return undefined;
  // `Problem.Evaluation(x)` in `main(Algorithm, Problem)`: of the classes at
  // the top of the method's hierarchies, the one the parameter is named after.
  // Capitalised, as a class's name is: a lower-case `model` beside a class
  // `Model` is far more often a struct (MATLAB variables are lower-case).
  const written = name.slice(0, dot);
  if (!/^[A-Z]/.test(written)) return undefined;
  const receiver = written.toLowerCase();
  const named = hit.roots.filter((m) => {
    const owner = ownerOf(m);
    return owner.slice(owner.lastIndexOf(':') + 1).toLowerCase() === receiver;
  });
  return named.length === 1 ? { method: named[0]!, byReceiverName: true } : undefined;
}

/** What a `v.m()` on a variable of no stated class resolves to (see resolveVariableMethod). */
interface VariableMethod {
  method: Node;
  /** Picked from several hierarchies' roots by the parameter's name (the edge says so: `via: 'receiver-name'`). */
  byReceiverName?: boolean;
}

/**
 * A member's answer for a `v.m()`, per member and calling folder: the method
 * when one class, or one hierarchy, defines it; else the roots' methods, one
 * per class that inherits it from none of the others (none when a property
 * shares the name, or a copy is not seen from the caller).
 */
interface VariableMethods {
  method: Node | null;
  roots: Node[];
}

const NO_VARIABLE_METHODS: VariableMethods = { method: null, roots: [] };

function variableMethod(member: string, callerFile: string, context: ResolutionContext): VariableMethods {
  const named = matlab(context.getNodesByName(member));
  if (named.some((n) => n.kind === 'property' || n.kind === 'constant')) return NO_VARIABLE_METHODS;
  // A constructor (`PathA::PathA`) is called through its class, never on an object; a misnamed class has none
  // (MATLAB knows no such class: see isMatlabMisnamedClass).
  const all = named.filter((n) => n.kind === 'method' && !isConstructor(n) && !context.getNodesInFile(n.filePath).some(isMatlabMisnamedClass));
  // A class-folder method's `Static` is on its classdef's declaration.
  const statics = new Set(all.filter((n) => n.isStatic).map((n) => n.qualifiedName));
  // With a search path, a caller it runs sees only the classes on it.
  const methods = seenFrom(preferBodies(all.filter((n) => !statics.has(n.qualifiedName))), callerFile, context);
  const classes = new Set(methods.map(ownerOf));
  if (classes.size === 0) return NO_VARIABLE_METHODS;
  // Of each class's copies, the one MATLAB would see from the caller.
  const chosen = new Map<string, Node>();
  for (const owner of classes) {
    const copy = choose(methods.filter((n) => ownerOf(n) === owner), callerFile, context);
    if (!copy) return NO_VARIABLE_METHODS;
    chosen.set(owner, copy);
  }
  if (chosen.size === 1) return { method: [...chosen.values()][0]!, roots: [] };
  const roots = hierarchyRoots(chosen, context);
  if (roots === undefined) return NO_VARIABLE_METHODS;
  if (roots.length === 1) return { method: chosen.get(roots[0]!)!, roots: [] };
  return { method: null, roots: roots.map((r) => chosen.get(r)!) };
}

/**
 * Of the classes whose methods `chosen` holds (by class), the ones that
 * inherit from none of the others: one when every other one inherits from
 * it. Undefined when a class is not found. Each class's superclasses are
 * read from the copy of it its method is in, so a copy elsewhere is not taken
 * for it.
 */
function hierarchyRoots(chosen: ReadonlyMap<string, Node>, context: ResolutionContext): string[] | undefined {
  const ancestry = new Map<string, Set<string>>();
  for (const [owner, method] of chosen) {
    const cls = byQualifiedName(owner, method.filePath, context, TYPE_KINDS);
    if (!cls) return undefined;
    const seen = new Set<string>();
    const walk = (c: Node): void => {
      if (seen.has(c.qualifiedName)) return;
      seen.add(c.qualifiedName);
      for (const sup of superclassesOf(c, context)) walk(sup);
    };
    walk(cls);
    ancestry.set(owner, seen);
  }
  const common = [...ancestry.keys()].filter((r) => [...ancestry.values()].every((a) => a.has(r)));
  if (common.length === 1) return common;
  return [...ancestry.keys()].filter((r) => [...ancestry.keys()].every((o) => o === r || !ancestry.get(r)!.has(o)));
}

/**
 * `m(x, …)` in a class folder's function file (`@C/f.m`, never the classdef
 * `@C/C.m`: the extractor writes the `objectArg` fact there alone) that
 * nothing else answers, on a variable that may hold an object (the
 * `objectArg` fact, see ../extraction/languages/matlab-ref-facts): the
 * method of the caller's own copy of `C` (see homeMethod) that a call on an
 * object of it runs, taken for the call: the class's code calls its own
 * methods on its objects in function syntax (`JoinGmapByStep(q(i), p,
 * 1)` in `@gmap/BKZ07.m`, `children(tree, uid)` in `@doctree/editor.m`). A
 * guess — the argument's class is not stated —, which the edge says it is
 * (`via: 'caller-class'`).
 *
 * None for
 *   - a name MATLAB has: a built-in's, one of its classes' methods' (step 8's
 *     lists), or any method base MATLAB documents
 *     (MATLAB_DOCUMENTED_METHOD_NAMES: `copy` of `matlab.mixin.Copyable`);
 *   - a name any MATLAB function, class or property of the project carries
 *     (the call may be meant for it, or the name read as a field);
 *   - a name a class outside the caller's copy's hierarchy defines a method
 *     of (otherClassDefines: `friction` of a `Link` beside
 *     `@Robot/friction.m`), whose object the argument may as well be;
 *   - a method named after its class in another case (`@gmap/GMAP.m`, which a
 *     case-blind file system once took for the constructor).
 * Every input is a definition of `m` (its definition delta), a file `m.m`
 * in the caller's folder (reopenMatlabScriptRuns in ./matlab-sync), a
 * superclass list or a copy of a class coming or going (MatlabSuperclassChange
 * in ./matlab-sync: one that takes a class into the hierarchy or out of it
 * reaches it before or after, and the method found with it), or the path; a
 * sync re-opens the call for each.
 */
function classMethodGuess(name: string, caller: Caller, context: ResolutionContext): Node | undefined {
  if (MATLAB_BUILTINS.has(name) || MATLAB_METHOD_ONLY_NAMES.has(name) || DOCUMENTED_METHODS.has(name)) return undefined;
  const cls = callerClass(caller);
  if (!cls || cls === name || cls.endsWith(`::${name}`)) return undefined;
  const named = matlab(context.getNodesByName(name));
  if (named.some((n) => GUESS_BLOCKING_KINDS.has(n.kind))) return undefined;
  const home = homeClass(cls, caller.file, context);
  const method = homeMethod(cls, name, caller, home, context);
  if (!method) return undefined;
  const owner = ownerOf(method);
  if (owner.slice(owner.lastIndexOf(':') + 1).toLowerCase() === name.toLowerCase()) return undefined;
  return otherClassDefines(named, cls, home, context) ? undefined : method;
}

/** What a name a guess is not made for carries (see classMethodGuess). */
const GUESS_BLOCKING_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'enum', 'property', 'constant']);

/** classMethodGuess's third list (see ../extraction/languages/matlab-builtin-names): read nowhere else. */
const DOCUMENTED_METHODS: ReadonlySet<string> = new Set(MATLAB_DOCUMENTED_METHOD_NAMES);

/** The copy of class `cls` the caller's class folder holds (`@C/C.m`, a classdef or an old-style constructor), if any. */
function homeClass(cls: string, callerFile: string, context: ResolutionContext): Node | undefined {
  const dir = dirOf(callerFile);
  return matlab(context.getNodesByQualifiedName(cls)).find((n) => TYPE_KINDS.has(n.kind) && dirOf(n.filePath) === dir && !isMatlabMisnamedClass(n));
}

/**
 * The method `name` that a call on an object of the caller's own copy of
 * `cls` runs: the one its class folder holds (a method file `@C/m.m`, or
 * the classdef's own), else the one the copy `home` inherits through its
 * superclass list. Never a method of another copy of `cls` (a toolbox's
 * `Octave/@ChainLink/rne.m` is Octave code, and `@ChainLink/rne.m` is
 * another implementation's): none when the caller's folder has a file
 * `m.m` with no method in it, which is what runs.
 */
function homeMethod(cls: string, name: string, caller: Caller, home: Node | undefined, context: ResolutionContext): Node | undefined {
  const dir = dirOf(caller.file);
  const own = preferBodies(matlab(context.getNodesByQualifiedName(`${cls}::${name}`)).filter((n) => n.kind === 'method' && dirOf(n.filePath) === dir));
  if (own.length > 0) return choose(own, caller.file, context);
  if (matlabFileNames(name).some((f) => context.getNodesInFile(`${dir}/${f}`).length > 0)) return undefined;
  if (!home || inCycle(home, context)) return undefined;
  for (const sup of superclassesOf(home, context)) {
    const hit = methodOnHierarchy(sup, name, caller.file, context);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Whether a class outside the hierarchy of `home` — the caller's copy of
 * `cls` (homeClass) — owns one of the methods among `named` (a name's
 * MATLAB nodes), anywhere in the project, on the path or off it. Each
 * method counts with the copy of its class that holds it (the classdef in
 * its file, or the class of its class folder): that copy must descend from
 * `home` or be one of its ancestors, every superclass resolved as MATLAB
 * would (superclassesOf); a method no copy holds, or any method at all when
 * there is no `home`, blocks. A class whose name is `cls`'s in any case does
 * not count (`@gmap` beside a copy `@GMAP`, another copy of `cls`): it
 * stops no guess, and homeMethod never links to it.
 */
function otherClassDefines(named: readonly Node[], cls: string, home: Node | undefined, context: ResolutionContext): boolean {
  const lower = cls.toLowerCase();
  let above: Set<string> | undefined;
  for (const m of named) {
    if (m.kind !== 'method') continue;
    const owner = ownerOf(m);
    if (owner === '' || owner.toLowerCase() === lower) continue;
    if (!home) return true;
    above ??= ancestorIds(home, context);
    const copies = matlab(context.getNodesByQualifiedName(owner)).filter(
      (c) => TYPE_KINDS.has(c.kind) && (c.filePath === m.filePath || (inClassFolder(m) && dirOf(c.filePath) === dirOf(m.filePath))),
    );
    if (copies.length === 0) return true;
    for (const c of copies) if (!above.has(c.id) && !ancestorIds(c, context).has(home.id)) return true;
  }
  return false;
}

/** The ids of `cls` and of every class it inherits from, each superclass resolved as MATLAB would (superclassesOf). */
function ancestorIds(cls: Node, context: ResolutionContext): Set<string> {
  const seen = new Set<string>();
  const walk = (c: Node): void => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    for (const sup of superclassesOf(c, context)) walk(sup);
  };
  walk(cls);
  return seen;
}

/**
 * The class whose folder the caller's file is in (`@Cls/f.m`,
 * `+pkg/@Cls/f.m`), for classMethodGuess; undefined for any other file.
 */
function callerClass(caller: Caller): string | undefined {
  const scope = matlabPathScope(caller.file);
  return scope.classFolder === undefined ? undefined : [...scope.packages, scope.classFolder].join('::');
}

/**
 * Whether `cls` is an old-style class: an `@Cls` folder whose `Cls.m` is a
 * constructor function (`class(s, 'Cls')`), not a `classdef`. Its object is
 * a struct: `obj.f` reads a field of it, never a method.
 */
function isOldStyleClass(cls: Node | undefined): boolean {
  return cls !== undefined && cls.kind === 'class' && !(cls.signature ?? '').startsWith('classdef');
}

export function matchMatlabReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const found = matlabTarget(ref, context);
  if (!found) return null;
  const { target, via } = found;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: found.byCallerClass || (via.includes('.') && !via.includes('::')) ? 0.7 : target.filePath === ref.filePath ? 0.95 : 0.9,
    resolvedBy: ref.referenceKind === 'function_ref' ? 'function-ref' : via.includes('::') ? 'qualified-name' : 'exact-match',
    // A guess from the parameter's name, or from the caller's class: marked one (see ../graph/synthesized-hop).
    ...(found.byReceiverName ? { metadata: { via: 'receiver-name' }, provenance: 'heuristic' as const } : {}),
    ...(found.byCallerClass ? { metadata: { via: 'caller-class' }, provenance: 'heuristic' as const } : {}),
  };
}

/** What a reference resolves to, and the name it was looked up by (the reference's own, or a variable's in its facts). */
interface Found {
  target: Node;
  via: string;
  /** A `v.m()` whose class the parameter's name gave (see resolveVariableMethod). */
  byReceiverName?: boolean;
  /** An `m(x, …)` taken for a method of the caller's class (see classMethodGuess). */
  byCallerClass?: boolean;
}

function foundBy(target: Node | undefined, via: string): Found | null {
  return target ? { target, via } : null;
}

function foundByVariable(found: VariableMethod | undefined, via: string): Found | null {
  if (!found) return null;
  return { target: found.method, via, ...(found.byReceiverName ? { byReceiverName: true } : {}) };
}

function matlabTarget(ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const name = ref.referenceName;
  switch (ref.referenceKind) {
    case 'extends': {
      // A misnamed class is no class MATLAB knows (see isMatlabMisnamedClass): it extends nothing.
      const from = fileFacts(ref.filePath, context).byId.get(ref.fromNodeId);
      if (from && isMatlabMisnamedClass(from)) return null;
      return foundBy(superclassNamed(name, ref.filePath, context), name);
    }
    case 'imports':
      return foundBy(byQualifiedName(name, ref.filePath, context, NAMED_KINDS), name);
    case 'calls':
      return callTarget(ref, context);
    case 'function_ref': {
      const found = callTarget(ref, context);
      return found && { target: handleTarget(found.target, context), via: found.via };
    }
    default:
      return null;
  }
}

/** A handle names a function: `@Cls` is its constructor, or the class itself when it declares none (MATLAB gives it a default one). */
function handleTarget(target: Node, context: ResolutionContext): Node {
  if (!TYPE_KINDS.has(target.kind)) return target;
  return matlab(context.getNodesByQualifiedName(`${target.qualifiedName}::${target.name}`)).find((n) => n.kind === 'method') ?? target;
}

/**
 * Whether a bare name's reference is of a form that runs a script MATLAB
 * finds first for the name (MATLAB R2026a, a script first on the path and a
 * function farther: `probe` as a statement, `probe()`, `feval('probe')`
 * and a handle `@probe`, called with nothing, run the script; `probe(2)`,
 * `feval('probe', 2)`, `h(2)` and `v = probe;` are errors): a statement of
 * its own, a call so with an empty argument list (the `emptyCall` fact), a
 * callback given as text that is a statement, and a handle (`@probe`,
 * `str2func('probe')`), which names the script. Not a call with arguments
 * in a callback given as text (`'probe(1)'`, a reference with the `runtime`
 * fact): MATLAB runs that text as a call.
 */
function runsScript(ref: UnresolvedRef, facts: MatlabRefFacts): boolean {
  return facts.form === 'statement' || facts.emptyCall === true || (ref.referenceKind === 'function_ref' && !facts.runtime);
}

/** A call's or a handle's target (see the top of this file for the order MATLAB looks a name up in). */
function callTarget(ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const name = ref.referenceName;
  const facts = matlabRefFacts(ref);
  let caller: Caller | undefined;
  const callerHere = (): Caller => (caller ??= callerOf(ref, context));
  if (!name.includes('::')) {
    if (name.includes('.')) {
      // A member written without an argument list on a variable of no stated
      // class is a struct's field (`data.smprate`): the extractor emits none,
      // and none is linked.
      if (facts.form === 'bare') return null;
      return foundByVariable(resolveVariableMethod(name, ref.filePath, context, facts.param === true), name);
    }
    // `tidy(g)` after `g = gadget();`: the class's method at step 6 when `gadget` is a class (the `argClass` fact).
    const hit = resolveBare(name, callerHere(), context, ref.referenceKind === 'calls' ? facts.argClass : undefined, runsScript(ref, facts), false, facts.keptBy);
    if (hit || !facts.objectArg || ref.referenceKind !== 'calls') return foundBy(hit, name);
    const guess = classMethodGuess(name, callerHere(), context);
    return guess ? { target: guess, via: name, byCallerClass: true } : null;
  }
  const owner = name.slice(0, name.lastIndexOf('::'));
  // `this.path` on an old-style class's object is a field of its struct, not
  // its `path` method (inside the class's methods, always).
  if (facts.form === 'bare' && isOldStyleClass(resolveType(owner, callerHere(), context))) return null;
  if (facts.variable !== undefined) {
    // `aa.getData()` after `aa = Archive;`: `Archive::getData`, unless the bare
    // name is a function of the project's and no class (`G = GetCfg;` calls
    // the function, and what it returns has no class the code states): then
    // the variable's own `aa.getData`. A name the project defines nothing of
    // stays a class: `r = SE2;` makes an object of a toolbox's class, whose
    // methods are none of the project's.
    if (!resolveType(owner, callerHere(), context) && resolveBare(owner, callerHere(), context)?.kind === 'function') {
      return facts.form === 'bare' ? null : foundByVariable(resolveVariableMethod(facts.variable, ref.filePath, context), facts.variable);
    }
    return foundBy(resolveQualified(name, callerHere(), context), name);
  }
  // `m(obj, …)`: `Cls::m`, looked up by the name as written, the class's method in its place.
  if (ref.referenceKind === 'calls' && facts.dispatch !== undefined) {
    return foundBy(resolveBare(facts.dispatch, callerHere(), context, owner, false, facts.selfArg === true, facts.keptBy), name);
  }
  return foundBy(resolveQualified(name, callerHere(), context), name);
}
