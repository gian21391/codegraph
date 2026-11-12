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
 *   5. a function in a `private/` folder beside the calling file;
 *   6. a method of the class of the call's first argument, when the extractor
 *      knows it (`m(obj, …)` on a method's own object, `area(c)` after
 *      `c = Shape(…)`: the ref is `Cls::m`, the written name in `candidates`);
 *   7. a class kept in a class folder (`@Cls/`), then a function file's
 *      function or a class on the path — outside every `+package` folder: a
 *      package member is reached by its full name even from its own package.
 *      A call written as a statement of its own (`setup_paths`, `run
 *      setup_paths`) reaches a script on the path too: its file node.
 *
 * An import holds in the function that makes it and the functions nested in
 * it, not in the file's other functions. Of several equally near same-named
 * files the first in `genpath` order is picked (see `nearest`).
 *
 * A package member is otherwise reached only by its full name (`pkg.sub.f`),
 * which the extractor writes as the qualified ref `pkg::sub::f`; a method
 * through its class (`Cls::m`, from `Cls.m()` or `obj.m()` on a method's own
 * object), found on the class or else on its superclasses, read from the
 * `classdef X < A & B` signature. A method on a variable of no stated class
 * (`robot.accel(…)` on a parameter) resolves only when one class defines it,
 * or one class and subclasses of it that override it, and no property shares
 * its name. A local function of ANOTHER file is never
 * reachable — that is what made the generic name matcher unsafe here: every
 * MATLAB project has a dozen local `parseInputs` / `helper`s.
 *
 * A class-folder method declared in its classdef (`d = norm2(obj)`) and
 * written in its own file (`@Pt/norm2.m`) is two nodes of one qualified name:
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
import { isMatlabScriptFile } from '../graph/matlab-scripts';
const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'enum']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);
const NAMED_KINDS: ReadonlySet<string> = new Set([...CALLABLE_KINDS, ...TYPE_KINDS]);
const METHOD_KINDS: ReadonlySet<string> = new Set(['method']);

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** `pkg::sub` for `pkg::sub::f`, `pkg::Cls` for its method `pkg::Cls::m`; '' for a top-level name. */
function ownerOf(n: Node): string {
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

/** Whether a node sits in a class folder (`…/@Cls/x.m`). */
function inClassFolder(n: Node): boolean {
  return /(?:^|\/)@[^/]+\/[^/]+$/.test(n.filePath);
}

/** The function or class a package file defines (`+util/size.m` → `util::size`); its local functions are not. */
function isPackageMember(n: Node): boolean {
  return ownerOf(n) !== '' && (TYPE_KINDS.has(n.kind) || (n.kind === 'function' && n.isExported === true));
}

/** A class-folder method in its own file (`@Pt/norm2.m` → `Pt::norm2`): the one with the body. */
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
 * it was read from and needs no clearing of its own.
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

/** A path-visible definition by exact qualified name: a package function, a class, a class's method. */
function byQualifiedName(qn: string, callerFile: string, context: ResolutionContext, kinds: ReadonlySet<string>): Node | undefined {
  const hits = matlab(context.getNodesByQualifiedName(qn)).filter(
    (n) => kinds.has(n.kind) && (n.kind !== 'function' || n.isExported || n.filePath === callerFile) && privateInReach(n, callerFile),
  );
  return nearest(preferBodies(hits), callerFile);
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
 * Per context, by class id: superclassesOf's answers. They are read from
 * node rows alone (the class's signature, the classes its names resolve to),
 * so they hold as long as the context's node caches do, and go with them
 * (clearMatlabLookupMemos, from ReferenceResolver.clearCaches).
 */
const SUPERCLASSES = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/** Drop the superclass memo (see ReferenceResolver.clearCaches). */
export function clearMatlabLookupMemos(context: ResolutionContext): void {
  SUPERCLASSES.delete(context);
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
  const m = /<\s*(.+)$/.exec(cls.signature ?? '');
  for (const raw of m ? m[1]!.split('&') : []) {
    const name = raw.trim().replace(/\./g, '::');
    if (!name) continue;
    // A superclass list sees no import: it is outside every function.
    const sup = resolveType(name, { file: cls.filePath, imports: NO_IMPORTS }, context);
    if (sup && sup.id !== cls.id) out.push(sup);
  }
  memo.set(cls.id, out);
  return out;
}

/**
 * Method `name` on class `cls` or the first superclass (depth-first, as MATLAB
 * lists them) that defines it: the one `cls` itself holds (in its classdef
 * file or its class folder) when another copy of the class defines it too,
 * else the one nearest `callerFile`.
 */
function methodOnHierarchy(cls: Node, name: string, callerFile: string, context: ResolutionContext, seen = new Set<string>()): Node | undefined {
  if (seen.has(cls.id)) return undefined;
  seen.add(cls.id);
  const own = preferBodies(matlab(context.getNodesByQualifiedName(`${cls.qualifiedName}::${name}`)).filter((n) => n.kind === 'method'));
  if (own.length > 0) {
    const held = own.filter((n) => n.filePath === cls.filePath || (inClassFolder(cls) && dirOf(n.filePath) === dirOf(cls.filePath)));
    return nearest(held.length > 0 ? held : own, callerFile);
  }
  for (const sup of superclassesOf(cls, context)) {
    const hit = methodOnHierarchy(sup, name, callerFile, context, seen);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The method `name` of class `cls` (`pkg::Cls`, or as the code wrote it) that
 * a call on one of its objects dispatches to. The constructor is no such
 * method: `Cls(obj, …)` calls the class, which the path lookup reaches.
 */
function dispatchedMethod(cls: string, name: string, caller: Caller, context: ResolutionContext): Node | undefined {
  if (cls === name || cls.endsWith(`::${name}`)) return undefined;
  const direct = byQualifiedName(`${cls}::${name}`, caller.file, context, METHOD_KINDS);
  if (direct) return direct;
  const owner = resolveType(cls, caller, context);
  return owner && methodOnHierarchy(owner, name, caller.file, context);
}

/** `pkg::sub::f`, `Cls::m`, `pkg::Cls`, `pkg::Cls::m`. */
function resolveQualified(name: string, caller: Caller, context: ResolutionContext): Node | undefined {
  const direct = byQualifiedName(name, caller.file, context, NAMED_KINDS);
  if (direct) return direct;
  const cut = name.lastIndexOf('::');
  const owner = name.slice(0, cut);
  const member = name.slice(cut + 2);
  // The owner through an import (`Circle.unit()` after `import geom.*`).
  if (!owner.includes('::')) {
    const expansions = [caller.imports.exact.get(owner), ...caller.imports.wildcards.map((p) => `${p}::${owner}`)];
    for (const qn of expansions) {
      if (!qn) continue;
      const hit = byQualifiedName(`${qn}::${member}`, caller.file, context, NAMED_KINDS);
      if (hit) return hit;
    }
  }
  // An inherited method: the owner is a class that does not define it itself.
  const cls = resolveType(owner, caller, context);
  if (!cls) return undefined;
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
 * and before the path.
 */
function resolveBare(name: string, caller: Caller, context: ResolutionContext, dispatch?: string, statement?: () => boolean): Node | undefined {
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
    (n) => ((n.kind === 'function' && n.isExported) || TYPE_KINDS.has(n.kind)) && privateInReach(n, from) && ownerOf(n) === '',
  );
  const priv = onPath.filter((n) => /(?:^|\/)private\//.test(n.filePath));
  if (priv.length > 0) return nearest(priv, from);
  // 6. The first argument's class's own method.
  if (dispatch) {
    const method = dispatchedMethod(dispatch, name, caller, context);
    if (method) return method;
  }
  // 7. A class-folder class, then the path. Never a method otherwise: one
  // called with function syntax on an object of a known class arrives with
  // `dispatch`, and any other `char(s, …)` is the built-in even inside a
  // class that overloads it. A script on the path is a file of it like a
  // function's, but runs only as a statement of its own (`setup_paths`,
  // `run setup_paths`): it takes no argument and returns nothing.
  const folderClasses = onPath.filter((n) => TYPE_KINDS.has(n.kind) && inClassFolder(n));
  let target: Node | undefined;
  if (folderClasses.length > 0) target = nearest(folderClasses, from);
  else {
    const scripts = statement ? scriptsNamed(name, context) : [];
    target = nearest(scripts.length > 0 && statement!() ? [...onPath, ...scripts] : onPath, from);
  }
  return target && !nearerInexactMatch(name, target, from, context) ? target : undefined;
}

/**
 * Whether a file of the path that matches `name` only when case is ignored
 * lies strictly nearer the caller than `target`, the nearest exact match: a
 * function file (`FindCells.m` for `findcells`), a class, a script, the help
 * text of a MEX function (`RingPass.m` beside `RingPass.c` for `ringpass`), or
 * a class folder's constructor-shaped file (`@tps/TPS.m` for `TPS` or `tps`).
 * MATLAB matches a name with its case, and errors when it finds no exact match
 * ("Cannot find an exact (case-sensitive) match"), so the call is not to the
 * far file: the code was written against the near one, which runs only on an
 * old release on a case-blind file system, or nowhere. No edge then. An exact
 * match in the caller's own folder is never beaten.
 */
function nearerInexactMatch(name: string, target: Node, callerFile: string, context: ResolutionContext): boolean {
  const bar = nearness(target.filePath, callerFile);
  if (bar === Number.MAX_SAFE_INTEGER) return false;
  const lower = name.toLowerCase();
  const variants = [lower, `${lower}.m`].flatMap((k) => context.getNodesByLowerName(k));
  return matlab(variants).some((n) => {
    if (nearness(n.filePath, callerFile) <= bar || !privateInReach(n, callerFile)) return false;
    const owner = ownerOf(n);
    // `@tps/TPS.m`: a constructor's file, its folder's name in another case or its own.
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
 * Whether the bare name `name` at `column` of line `row` is a statement of its
 * own — `setup_paths`, `setup_paths;`, `if ok, setup_paths, end` — or the
 * script a `run` statement names (`run setup_paths`, `run('setup_paths.m')`):
 * the only way a script runs. Not when it is a value (`x = name`, `f(name)`,
 * `[name, 1]`) or continues an earlier line; what the line does not show
 * plainly is no statement.
 */
function writtenAsStatement(lines: readonly string[] | null | undefined, row: number, column: number, name: string): boolean {
  const text = lines?.[row - 1];
  if (text === undefined || text.slice(column, column + name.length) !== name) return false;
  const before = text.slice(0, column);
  const after = text.slice(column + name.length);
  const prev = row >= 2 ? lines![row - 2]! : '';
  if (/\.\.\./.test(prev.replace(/%.*$/, ''))) return false;
  if (/^\s*run\s*\(\s*['"]$/.test(before)) return /^(?:\.[mM])?['"]\s*\)\s*(?:[;,%]|$)/.test(after);
  if (/^\s*run\s+['"]?$/.test(before)) return /^(?:\.[mM])?['"]?\s*(?:[;,%]|$)/.test(after);
  if (!/^\s*(?:[;,%]|$)/.test(after)) return false;
  return /(?:^|[;,])\s*(?:(?:else|try|otherwise)\s+)?$/.test(before) && atTopLevel(before);
}

/** Whether `code` (a line's start) leaves no bracket or string open, so a `,` / `;` in it ends a statement. */
function atTopLevel(code: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let prev = '';
  for (const ch of code) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || (ch === "'" && !/[\w)\]}.']/.test(prev))) quote = ch;
    else if (ch === '%') return false;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch !== ' ' && ch !== '\t') prev = ch;
  }
  return depth === 0 && quote === null;
}

/**
 * `v.m()` on a variable whose class the function never states (a parameter,
 * mostly): the method, when exactly one class defines a method of that name
 * and nothing in the project has a property of that name — `opts.tol(1)` on a
 * struct, or `robot.links(1)` on a property, reads exactly the same. When
 * several classes define it and one of them is a superclass of all the others
 * (`Problem.CalGrad(x)` on a PROBLEM, whose subclasses override `CalGrad`),
 * `v` holds that class or one of its subclasses: the call is that class's
 * method, overridden or not.
 */
function resolveVariableMethod(name: string, callerFile: string, context: ResolutionContext): Node | undefined {
  const member = name.slice(name.lastIndexOf('.') + 1);
  const named = matlab(context.getNodesByName(member));
  if (named.some((n) => n.kind === 'property' || n.kind === 'constant')) return undefined;
  const all = named.filter((n) => n.kind === 'method');
  // A class-folder method's `Static` is on its classdef's declaration.
  const statics = new Set(all.filter((n) => n.isStatic).map((n) => n.qualifiedName));
  const methods = preferBodies(all.filter((n) => !statics.has(n.qualifiedName)));
  const classes = new Set(methods.map(ownerOf));
  if (classes.size === 0) return undefined;
  // Of each class's copies, the one nearest the caller.
  const chosen = new Map<string, Node>();
  for (const owner of classes) {
    const copy = nearest(methods.filter((n) => ownerOf(n) === owner), callerFile);
    if (!copy) return undefined;
    chosen.set(owner, copy);
  }
  if (chosen.size === 1) return [...chosen.values()][0];
  const root = commonRoot(chosen, context);
  return root === undefined ? undefined : chosen.get(root);
}

/**
 * Of the classes whose methods `chosen` holds (by class), the one every other
 * one inherits from, or undefined when there is no single such class. Each
 * class's superclasses are read from the copy of it its method is in, so a
 * copy elsewhere is not taken for it.
 */
function commonRoot(chosen: ReadonlyMap<string, Node>, context: ResolutionContext): string | undefined {
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
  const roots = [...ancestry.keys()].filter((r) => [...ancestry.values()].every((a) => a.has(r)));
  return roots.length === 1 ? roots[0] : undefined;
}

export function matchMatlabReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  let target: Node | undefined;
  /** The name the target was looked up by, when not `name`. */
  let via = name;
  switch (ref.referenceKind) {
    case 'extends':
      target = resolveType(name, { file: ref.filePath, imports: NO_IMPORTS }, context);
      break;
    case 'imports':
      target = byQualifiedName(name, ref.filePath, context, NAMED_KINDS);
      break;
    case 'calls':
    case 'function_ref': {
      // `aa.getData()` after `aa = Archive;`: `Archive::getData`, the
      // variable's own `aa.getData` in `candidates` — taken when the bare
      // name is a function of the project's and no class (`G = GetCfg;`
      // calls the function: what it returns has no class the code states).
      // A name the project defines nothing of stays a class: `r = SE2;` makes
      // an object of a toolbox's class, whose methods are none of the project's.
      const variable = name.includes('::') ? ref.candidates?.find((c) => c.includes('.')) : undefined;
      // `m(obj, …)`: `Cls::m`, the name as written in `candidates`.
      const written = ref.referenceKind === 'calls' && name.includes('::') && !variable ? ref.candidates?.[0] : undefined;
      const hinted = variable === undefined ? undefined : name.slice(0, name.lastIndexOf('::'));
      const unhinted = hinted !== undefined && !resolveType(hinted, callerOf(ref, context), context) &&
        resolveBare(hinted, callerOf(ref, context), context)?.kind === 'function';
      if (unhinted) via = variable!;
      target = written ? resolveBare(written, callerOf(ref, context), context, name.slice(0, name.lastIndexOf('::')))
        : unhinted ? resolveVariableMethod(variable!, ref.filePath, context)
        : name.includes('::') ? resolveQualified(name, callerOf(ref, context), context)
        : name.includes('.') ? resolveVariableMethod(name, ref.filePath, context)
        : resolveBare(name, callerOf(ref, context), context, undefined, ref.referenceKind === 'calls'
          ? () => writtenAsStatement(context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/), ref.line, ref.column, name)
          : undefined);
      // A handle names a function: `@Cls` is its constructor, or the class
      // itself when it declares none (MATLAB gives it a default one).
      if (target && ref.referenceKind === 'function_ref' && TYPE_KINDS.has(target.kind)) {
        const cls: Node = target;
        target = matlab(context.getNodesByQualifiedName(`${cls.qualifiedName}::${cls.name}`)).find((n) => n.kind === 'method') ?? cls;
      }
      break;
    }
    default:
      return null;
  }
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: via.includes('.') && !via.includes('::') ? 0.7 : target.filePath === ref.filePath ? 0.95 : 0.9,
    resolvedBy: ref.referenceKind === 'function_ref' ? 'function-ref' : via.includes('::') ? 'qualified-name' : 'exact-match',
  };
}
