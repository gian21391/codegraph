/**
 * MATLAB dispatch to subclasses, as synthesized `calls` edges.
 *
 * A call on a method's own object (`obj.main(obj.pro)` in `ALGORITHM::Solve`)
 * resolves to the first definition up the class's hierarchy — the base's,
 * often an empty hook or an `Abstract` declaration. At runtime the object is
 * a subclass's, and its override runs: `NSGAII::main`. Static resolution
 * cannot follow that, so a flow through a template method stopped at the
 * base. Two kinds of edge bridge it, `provenance: 'heuristic'`:
 *
 *   - `matlab-override`: each method of a class → the same-named method of
 *     each class that inherits it (`ALGORITHM::main → NSGAII::main`), from
 *     the nearest class up each line of superclasses that defines it (`A <
 *     handle` declares `step`, `B < A` does not, `C < B` does: `A::step →
 *     C::step`). A chain composes: `A::m → B::m → C::m`. MATLAB has no
 *     overloading by parameters, so a same-named method is always the
 *     override. Not the constructor, a property's `get.` / `set.` accessor, a
 *     static method (called on the class, never dispatched on an object), or
 *     a private one (never inherited). `Hidden` methods are linked like any
 *     other: the attribute is not kept on the node.
 *   - `matlab-subclass-method`: a call on a method's own object of a method
 *     its class neither defines nor inherits (`veh.deriv(t, y, u)` in
 *     `Vehicle`, which leaves `deriv` to its subclasses), a failed reference
 *     with the `self` fact → the nearest definition down each line of
 *     subclasses (`Bicycle::deriv`, `Unicycle::deriv`). Only a call on the
 *     method's own object: one on a variable of no stated class says nothing
 *     of its class.
 *
 * No cap: a base method has as many edges out as there are overrides
 * (`ALGORITHM::main` in PlatEMO has hundreds), and a capped list would be a
 * partial one.
 *
 * Methods are read by qualified name (`Cls::m`), not through `contains`: a
 * class folder's method files (`@Cls/m.m`) are contained by the class-folder
 * pass of the same synthesis batch, whose edges are not stored yet. Of a
 * method declared in its classdef and written in its own file, the file's
 * node, which has the body, is the one linked (as resolution does). The
 * classes come from the resolved `extends` edges; an old-style `@Cls` class
 * (a constructor function, `class(s, 'Cls', parent)`) has none, and gets no
 * edge here.
 *
 * A synthesis refresh recomputes every edge from the stored graph after a
 * sync, so a sync ends with the edges a fresh index of the same files has —
 * given the failed self-call rows a fresh index has, which the rule of
 * ./matlab-failures keeps the same in a sync as in a fresh index (the row of
 * `veh.deriv(t, y, u)` stays while any symbol is named `deriv`, and a sync
 * that adds the first one extracts `Vehicle`'s file again: see
 * ./matlab-builtin-carriers).
 */

import type { Edge, Node, UnresolvedReference } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import { isMatlabClassFolderFile } from './matlab-class-folders';
import { dirOf } from '../graph/matlab-search-path';
import { isConstructor, ownerOf } from './matlab-lookup';

export const MATLAB_OVERRIDE = 'matlab-override';
export const MATLAB_SUBCLASS_METHOD = 'matlab-subclass-method';

const CLASS_KINDS = ['class', 'enum'] as const;

/** A class's methods by name, one node per name: the method file's where a classdef declares it too. */
interface ClassMethods {
  byName: Map<string, Node>;
  /** The names any copy of which is static or private: never dispatched to, nor from. */
  closed: Set<string>;
}

interface Hierarchy {
  /** A class's direct superclasses and subclasses, by its id, from the resolved `extends` edges. */
  supers: Map<string, Node[]>;
  subs: Map<string, Node[]>;
  /** A class's own methods (in its classdef file or its class folder). */
  methodsOf(cls: Node): ClassMethods;
}

/** Whether `m`, a method of a class whose methods are `methods`, may be dispatched to or from: no constructor, no accessor, nothing static or private. */
function dispatchable(m: Node, methods: ClassMethods): boolean {
  return !isConstructor(m) && !m.name.includes('.') && !methods.closed.has(m.name);
}

async function readHierarchy(queries: QueryBuilder, onYield: MaybeYield): Promise<Hierarchy | null> {
  const classes = new Map<string, Node>();
  for (const cls of queries.iterateNodesByKindIn([...CLASS_KINDS], ['matlab'])) classes.set(cls.id, cls);
  const supers = new Map<string, Node[]>();
  const subs = new Map<string, Node[]>();
  let scanned = 0;
  for (const cls of classes.values()) {
    if ((++scanned & 63) === 0) await onYield();
    for (const e of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const sup = classes.get(e.target);
      if (!sup || sup.id === cls.id) continue;
      const up = supers.get(cls.id);
      if (up) up.push(sup);
      else supers.set(cls.id, [sup]);
      const down = subs.get(sup.id);
      if (down) down.push(cls);
      else subs.set(sup.id, [cls]);
    }
  }
  if (supers.size === 0) return null;
  // Every MATLAB method, by the qualified name of its class.
  const byOwner = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKindIn('method', ['matlab'])) {
    if ((++scanned & 63) === 0) await onYield();
    const owner = ownerOf(m);
    const list = byOwner.get(owner);
    if (list) list.push(m);
    else byOwner.set(owner, [m]);
  }
  const memo = new Map<string, ClassMethods>();
  const methodsOf = (cls: Node): ClassMethods => {
    const hit = memo.get(cls.id);
    if (hit) return hit;
    const folder = isMatlabClassFolderFile(cls.filePath) ? dirOf(cls.filePath) : null;
    const byName = new Map<string, Node>();
    const closed = new Set<string>();
    for (const m of byOwner.get(cls.qualifiedName) ?? []) {
      // Another copy of the class elsewhere holds its own methods.
      if (m.filePath !== cls.filePath && (folder === null || dirOf(m.filePath) !== folder)) continue;
      if (m.isStatic || m.visibility === 'private') closed.add(m.name);
      const had = byName.get(m.name);
      // The method file (`@Cls/m.m`) over the classdef's declaration of it.
      if (!had || (had.filePath === cls.filePath && m.filePath !== cls.filePath)) byName.set(m.name, m);
    }
    const out = { byName, closed };
    memo.set(cls.id, out);
    return out;
  };
  return { supers, subs, methodsOf };
}

/**
 * The nearest definitions of `name` up each line of `cls`'s superclasses
 * (`cls` itself left out): a line ends at the first class that has it.
 */
function nearestAbove(h: Hierarchy, cls: Node, name: string): Array<{ cls: Node; method: Node }> {
  const out: Array<{ cls: Node; method: Node }> = [];
  const seen = new Set<string>([cls.id]);
  const climb = (from: Node): void => {
    for (const sup of h.supers.get(from.id) ?? []) {
      if (seen.has(sup.id)) continue;
      seen.add(sup.id);
      const method = h.methodsOf(sup).byName.get(name);
      if (method) out.push({ cls: sup, method });
      else climb(sup);
    }
  };
  climb(cls);
  return out;
}

/** The nearest definitions of `name` down each line of `cls`'s subclasses (`cls` itself left out). */
function nearestBelow(h: Hierarchy, cls: Node, name: string): Array<{ cls: Node; method: Node }> {
  const out: Array<{ cls: Node; method: Node }> = [];
  const seen = new Set<string>([cls.id]);
  const descend = (from: Node): void => {
    for (const sub of h.subs.get(from.id) ?? []) {
      if (seen.has(sub.id)) continue;
      seen.add(sub.id);
      const method = h.methodsOf(sub).byName.get(name);
      if (method) out.push({ cls: sub, method });
      else descend(sub);
    }
  };
  descend(cls);
  return out;
}

/** Whether `cls` defines `name` or inherits it from a class above. */
function definesOrInherits(h: Hierarchy, cls: Node, name: string): boolean {
  return h.methodsOf(cls).byName.has(name) || nearestAbove(h, cls, name).length > 0;
}

/** The class `ref` (`Cls::m`, from a method of Cls) was written in: the copy of `Cls` its file is, or is in the class folder of. */
function callerClass(ref: UnresolvedReference, owner: string, classesNamed: Map<string, Node[]>): Node | undefined {
  const file = ref.filePath ?? '';
  return (classesNamed.get(owner) ?? []).find(
    (c) => c.filePath === file || (isMatlabClassFolderFile(c.filePath) && isMatlabClassFolderFile(file) && dirOf(c.filePath) === dirOf(file)),
  );
}

export async function matlabOverrideEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  const h = await readHierarchy(queries, onYield);
  if (!h) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const push = (edge: Edge): void => {
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  let scanned = 0;
  // Base → override.
  const classesWithSupers = [...h.supers.keys()];
  const byId = new Map<string, Node>();
  for (const list of h.subs.values()) for (const c of list) byId.set(c.id, c);
  for (const id of classesWithSupers) {
    if ((++scanned & 63) === 0) await onYield();
    const cls = byId.get(id)!;
    const own = h.methodsOf(cls);
    for (const [name, m] of own.byName) {
      if (!dispatchable(m, own)) continue;
      for (const { cls: base, method: bm } of nearestAbove(h, cls, name)) {
        if (!dispatchable(bm, h.methodsOf(base)) || bm.id === m.id) continue;
        push({
          source: bm.id,
          target: m.id,
          kind: 'calls',
          line: bm.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: MATLAB_OVERRIDE, via: name, registeredAt: `${m.filePath}:${m.startLine}` },
        });
      }
    }
  }
  // A call on the own object of a method only subclasses define → each of theirs.
  const failed = queries.getFailedMatlabSelfCalls();
  if (failed.length === 0) return edges;
  const classesNamed = new Map<string, Node[]>();
  for (const list of [...h.subs.values(), ...h.supers.values()]) {
    for (const c of list) {
      const named = classesNamed.get(c.qualifiedName);
      if (!named) classesNamed.set(c.qualifiedName, [c]);
      else if (!named.some((n) => n.id === c.id)) named.push(c);
    }
  }
  for (const ref of failed) {
    if ((++scanned & 63) === 0) await onYield();
    const cut = ref.referenceName.lastIndexOf('::');
    if (cut < 0) continue;
    const owner = ref.referenceName.slice(0, cut);
    const name = ref.referenceName.slice(cut + 2);
    const cls = callerClass(ref, owner, classesNamed);
    if (!cls || definesOrInherits(h, cls, name)) continue;
    for (const { cls: sub, method } of nearestBelow(h, cls, name)) {
      if (!dispatchable(method, h.methodsOf(sub))) continue;
      push({
        source: ref.fromNodeId,
        target: method.id,
        kind: 'calls',
        line: ref.line,
        column: ref.column,
        provenance: 'heuristic',
        metadata: { synthesizedBy: MATLAB_SUBCLASS_METHOD, via: name, registeredAt: `${method.filePath}:${method.startLine}` },
      });
    }
  }
  return edges;
}
