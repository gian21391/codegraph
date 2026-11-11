/**
 * MATLAB name resolution — MATLAB's own function precedence, not name matching.
 *
 * MATLAB finds a name in a fixed order, and nothing outside that order is in
 * reach:
 *
 *   1. a nested or local function of the calling file (and a class the file
 *      itself defines — its constructor);
 *   2. a function in a `private/` folder beside the calling file;
 *   3. a function file's primary function or a class on the path — outside
 *      any `+package` folder, or in a package the calling file `import`s.
 *
 * A package member is otherwise reached only by its full name (`pkg.sub.f`),
 * which the extractor writes as the qualified ref `pkg::sub::f`; a method
 * through its class (`Cls::m`, from `Cls.m()` or `obj.m()` on a method's own
 * object), found on the class or else on its superclasses, read from the
 * `classdef X < A & B` signature. A method on a variable of no stated class
 * (`robot.accel(…)` on a parameter) resolves only when one class defines it
 * and no property shares its name. A local function of ANOTHER file is never
 * reachable — that is what made the generic name matcher unsafe here: every
 * MATLAB project has a dozen local `parseInputs` / `helper`s.
 *
 * Authoritative: a MATLAB ref this does not resolve stays unresolved (a
 * built-in such as `disp`, a toolbox function) rather than falling through to
 * fuzzy matching.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'enum']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** `pkg::sub` for `pkg::sub::f`; '' for a top-level name. */
function packageOf(n: Node): string {
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

interface FileImports {
  /** `import pkg.*` → `pkg::…` */
  wildcards: string[];
  /** `import pkg.Cls` → Cls ↦ pkg::Cls */
  exact: Map<string, string>;
}

function importsOf(file: string, context: ResolutionContext): FileImports {
  const wildcards: string[] = [];
  const exact = new Map<string, string>();
  for (const n of context.getNodesInFile(file)) {
    if (n.kind !== 'import' || n.language !== 'matlab') continue;
    if (n.name.endsWith('.*')) wildcards.push(n.name.slice(0, -2).replace(/\./g, '::'));
    else {
      const qn = n.name.replace(/\./g, '::');
      exact.set(qn.slice(qn.lastIndexOf('::') + 2), qn);
    }
  }
  // Code inside a package names its siblings through the package as well; a
  // file's own package is the last place to look, not a rule MATLAB has.
  const own = context.getNodesInFile(file).find((n) => n.language === 'matlab' && n.kind !== 'file' && n.kind !== 'import');
  if (own) {
    const pkg = ownPackage(own);
    if (pkg) wildcards.push(pkg);
  }
  return { wildcards, exact };
}

/** The `+package` path a file's definitions sit in, from one of its nodes. */
function ownPackage(n: Node): string {
  const dirs = n.filePath.split('/').slice(0, -1);
  if (dirs.length > 0 && dirs[dirs.length - 1]!.startsWith('@')) dirs.pop();
  const pkgs: string[] = [];
  for (let i = dirs.length - 1; i >= 0 && dirs[i]!.startsWith('+'); i--) pkgs.unshift(dirs[i]!.slice(1));
  return pkgs.join('::');
}

/** Of several same-named files, the one nearest the caller: same folder, then the longest shared folder prefix. */
function nearest(candidates: Node[], callerFile: string): Node | undefined {
  if (candidates.length <= 1) return candidates[0];
  const callerDir = dirOf(callerFile);
  let best: Node | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const dir = dirOf(c.filePath);
    let score = 0;
    if (dir === callerDir) score = Number.MAX_SAFE_INTEGER;
    else {
      const a = dir.split('/');
      const b = callerDir.split('/');
      while (score < a.length && score < b.length && a[score] === b[score]) score++;
    }
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** A path-visible definition by exact qualified name: a package function, a class, a class's method. */
function byQualifiedName(qn: string, callerFile: string, context: ResolutionContext, kinds: ReadonlySet<string>): Node | undefined {
  const hits = matlab(context.getNodesByQualifiedName(qn)).filter(
    (n) => kinds.has(n.kind) && (n.kind !== 'function' || n.isExported || n.filePath === callerFile) && privateInReach(n, callerFile),
  );
  return nearest(hits, callerFile);
}

/** A class written as `Name` or `pkg.Name` where `from` is: its exact qualified name, an import, its package, else a unique class of that name. */
function resolveType(written: string, from: string, context: ResolutionContext): Node | undefined {
  const exact = byQualifiedName(written, from, context, TYPE_KINDS);
  if (exact) return exact;
  if (written.includes('::')) return undefined;
  const imports = importsOf(from, context);
  const imported = imports.exact.get(written);
  if (imported) {
    const hit = byQualifiedName(imported, from, context, TYPE_KINDS);
    if (hit) return hit;
  }
  for (const pkg of imports.wildcards) {
    const hit = byQualifiedName(`${pkg}::${written}`, from, context, TYPE_KINDS);
    if (hit) return hit;
  }
  return undefined;
}

/** Superclasses of a class, from its `classdef X < A & B` signature. */
function superclassesOf(cls: Node, context: ResolutionContext): Node[] {
  const m = /<\s*(.+)$/.exec(cls.signature ?? '');
  if (!m) return [];
  const out: Node[] = [];
  for (const raw of m[1]!.split('&')) {
    const name = raw.trim().replace(/\./g, '::');
    if (!name) continue;
    const sup = resolveType(name, cls.filePath, context);
    if (sup && sup.id !== cls.id) out.push(sup);
  }
  return out;
}

/** Method `name` on class `cls` or the first superclass (depth-first, as MATLAB lists them) that defines it. */
function methodOnHierarchy(cls: Node, name: string, context: ResolutionContext, seen = new Set<string>()): Node | undefined {
  if (seen.has(cls.id)) return undefined;
  seen.add(cls.id);
  const own = matlab(context.getNodesByQualifiedName(`${cls.qualifiedName}::${name}`)).find((n) => n.kind === 'method');
  if (own) return own;
  for (const sup of superclassesOf(cls, context)) {
    const hit = methodOnHierarchy(sup, name, context, seen);
    if (hit) return hit;
  }
  return undefined;
}

/** `pkg::sub::f`, `Cls::m`, `pkg::Cls`, `pkg::Cls::m`. */
function resolveQualified(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const from = ref.filePath;
  const kinds = new Set([...CALLABLE_KINDS, ...TYPE_KINDS]);
  const direct = byQualifiedName(name, from, context, kinds);
  if (direct) return direct;
  const cut = name.lastIndexOf('::');
  const owner = name.slice(0, cut);
  const member = name.slice(cut + 2);
  // The owner through an import / the file's package (`Circle.unit()` after `import geom.*`).
  if (!owner.includes('::')) {
    const imports = importsOf(from, context);
    const expansions = [imports.exact.get(owner), ...imports.wildcards.map((p) => `${p}::${owner}`)];
    for (const qn of expansions) {
      if (!qn) continue;
      const hit = byQualifiedName(`${qn}::${member}`, from, context, kinds);
      if (hit) return hit;
    }
  }
  // An inherited method: the owner is a class that does not define it itself.
  const cls = resolveType(owner, from, context);
  return cls ? methodOnHierarchy(cls, member, context) : undefined;
}

/** A bare `f` in MATLAB's precedence order. */
function resolveBare(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const from = ref.filePath;
  const named = matlab(context.getNodesByName(name));
  // 1. The calling file's own functions, and a class it defines.
  const local = named.filter((n) => n.filePath === from && (n.kind === 'function' || TYPE_KINDS.has(n.kind)));
  if (local.length > 0) return local[0];
  // 2–3. Private functions in reach, then path functions and classes.
  const imports = importsOf(from, context);
  const onPath = named.filter((n) => {
    if (!(n.kind === 'function' && n.isExported) && !TYPE_KINDS.has(n.kind)) return false;
    if (!privateInReach(n, from)) return false;
    const pkg = packageOf(n);
    return pkg === '' || imports.wildcards.includes(pkg) || imports.exact.get(name) === n.qualifiedName;
  });
  const priv = onPath.filter((n) => /(?:^|\/)private\//.test(n.filePath));
  // Never a method: one called with function syntax on its own object
  // (`char(obj)`) arrives as `Cls::m` from the extractor, and any other
  // `char(s, …)` is the built-in even inside a class that overloads it.
  return nearest(priv.length > 0 ? priv : onPath, from);
}

/**
 * `v.m()` on a variable whose class the function never states (a parameter,
 * mostly): the method, when exactly one class defines a method of that name
 * and nothing in the project has a property of that name — `opts.tol(1)` on a
 * struct, or `robot.links(1)` on a property, reads exactly the same.
 */
function resolveVariableMethod(name: string, context: ResolutionContext): Node | undefined {
  const member = name.slice(name.lastIndexOf('.') + 1);
  const named = matlab(context.getNodesByName(member));
  if (named.some((n) => n.kind === 'property' || n.kind === 'constant')) return undefined;
  const methods = named.filter((n) => n.kind === 'method' && !n.isStatic);
  const owners = new Set(methods.map((m) => packageOf(m)));
  return owners.size === 1 ? methods[0] : undefined;
}

export function matchMatlabReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  let target: Node | undefined;
  switch (ref.referenceKind) {
    case 'extends':
      target = resolveType(name, ref.filePath, context);
      break;
    case 'imports':
      target = byQualifiedName(name, ref.filePath, context, new Set([...CALLABLE_KINDS, ...TYPE_KINDS]));
      break;
    case 'calls':
    case 'function_ref':
      target = name.includes('::') ? resolveQualified(name, ref, context)
        : name.includes('.') ? resolveVariableMethod(name, context)
        : resolveBare(name, ref, context);
      // A handle names a function: `@Cls` is its constructor.
      if (target && ref.referenceKind === 'function_ref' && TYPE_KINDS.has(target.kind)) {
        target = matlab(context.getNodesByQualifiedName(`${target.qualifiedName}::${target.name}`)).find((n) => n.kind === 'method');
      }
      break;
    default:
      return null;
  }
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: name.includes('.') && !name.includes('::') ? 0.7 : target.filePath === ref.filePath ? 0.95 : 0.9,
    resolvedBy: ref.referenceKind === 'function_ref' ? 'function-ref' : name.includes('::') ? 'qualified-name' : 'exact-match',
  };
}
