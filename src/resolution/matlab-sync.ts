/**
 * What a sync must re-open for MATLAB that the definition delta cannot see:
 * the answers that depend on more than which names a changed file defines.
 *
 *   - A script runs by its file's name, and its calls end at its file node,
 *     which a re-index keeps: a file that becomes a script, or stops being
 *     one, changes no name it defines (reopenMatlabScriptRuns). So does a
 *     stub, the help text of a MEX function, which a call of its name
 *     nothing else answers reaches (../graph/matlab-scripts). And a name
 *     the delta does hold moves the calls of its script's or stub's file
 *     node, and of its case variants, which are no edges of the name
 *     (reopenMatlabNamesakes).
 *   - A method call reaches an inherited method through the superclass lists
 *     of the classes between: a class whose list changes (`Mid < pkg.Base`
 *     → `Mid < handle`) changes no name either (MatlabSuperclassChange).
 */

import type { Node, NodeKind, UnresolvedReference } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';
import { isMatlabPathScript, isMatlabPathStub, matlabAncestorClasses, matlabSuperclassNames } from './matlab-lookup';
import { matlabFileNames, matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';
import { dirOf } from '../graph/matlab-search-path';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { wakeMatlabBuiltinRows } from './matlab-builtin-carriers';

/** What a script runs before, or a stub comes after: a function file's function, or a class on the path. */
const NAMESAKE_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'enum']);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The files among a sync's `changedFilePaths` whose script verdict
 * reopenMatlabScriptRuns has to settle: the MATLAB files, and an Objective-C
 * `.m` that MATLAB code still calls into (one that was a MATLAB script before
 * this sync re-read it). One indexed read per `.m` path, so an Objective-C
 * project's sync does no more.
 */
export function matlabScriptCandidates(queries: QueryBuilder, changedFilePaths: readonly string[]): string[] {
  return changedFilePaths.filter((p) => {
    if (matlabFileStem(p) === null) return false;
    const language = queries.getFileByPath(p)?.language;
    if (language === 'matlab') return true;
    return language !== undefined && queries.hasCrossFileIncomingEdgeFromLanguage(`file:${p}`, p, 'matlab');
  });
}

/**
 * Put back in the pending set the MATLAB calls a sync's `.m` files may now
 * answer differently because one became a script MATLAB runs by its name or
 * a stub (the help text of a MEX function), or stopped being one (a function
 * went in, its code went out leaving only help text, it turned to Octave),
 * for the sync's resolution sweep. The calls into a changed file's node go
 * back as the references they were, whatever it is now: a script that became
 * a stub answers calls with arguments too, and the statements it answered may
 * be a farther function's now (a stub comes last), and the reverse. The calls
 * linked to another copy of the file's name, and those parked as failed under
 * the name of one that is a script or a stub (`setup_paths` for
 * `setup_paths.m`), or kept dormant as a built-in's call only the path gave a
 * copy of (`sound` for `sound.m`), go back too: it may answer them now; for a script, so do
 * the statements linked to a farther function or class of its name. Calls in
 * `changedFilePaths` are left alone: the sync resolved them already.
 * `matlabFilePaths` are the ones matlabScriptCandidates picks out of them.
 * Returns the number of references put back, and the rows of the ones that
 * were calls into a changed file: the sync judges those as a fresh index
 * judges its rows (see MatlabFreshReferences), since such a file can be one
 * whose text turned to Octave or binary, which carries no name (a fresh index
 * keeps no row of a call of it).
 */
export function reopenMatlabScriptRuns(
  queries: QueryBuilder,
  context: ResolutionContext,
  matlabFilePaths: readonly string[],
  changedFilePaths: readonly string[],
): { count: number; fromEdges: number[] } {
  const fresh = new Set(changedFilePaths);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const copyEdges = new Set<number>();
  const copyRefs: UnresolvedReference[] = [];
  const stems = new Set<string>();
  // A copy that is one of these files has its own edges put back below, once.
  const changed = new Set(matlabFilePaths);
  for (const filePath of matlabFilePaths) {
    const stem = matlabFileStem(filePath);
    if (!stem) continue;
    // Only the edges into the file node: a script's or a stub's calls end there.
    for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(`file:${filePath}`, filePath, 'matlab')) {
      if (fresh.has(edge.sourceFilePath)) continue;
      const ref = resurrectRefFromDroppedEdge(edge);
      if (!ref) continue;
      edgeIds.push(edge.edgeId);
      refs.push(ref);
    }
    // A class folder's file `m.m` that holds no method `m` (Octave, help
    // text, nothing) is what a call of `m` on an object of the class runs:
    // the calls in the folder's other files that a guess took for an
    // inherited method `m` (classMethodGuess in ./matlab-lookup) go back,
    // though no definition of `m` came or went. One that holds the method
    // again is the delta's.
    if (matlabPathScope(filePath).classFolder !== undefined && !queries.getNodesByFileOfKinds(filePath, ['method'], 'matlab').some((n) => n.name === stem)) {
      const dir = dirOf(filePath);
      for (const method of queries.getNodesByName(stem)) {
        if (method.language !== 'matlab' || method.kind !== 'method') continue;
        for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(method.id, method.filePath, 'matlab')) {
          if (fresh.has(edge.sourceFilePath) || dirOf(edge.sourceFilePath) !== dir || copyEdges.has(edge.edgeId)) continue;
          const ref = resurrectRefFromDroppedEdge(edge);
          if (!ref) continue;
          copyEdges.add(edge.edgeId);
          copyRefs.push(ref);
        }
      }
    }
    const script = isMatlabPathScript(filePath, context);
    if (script || isMatlabPathStub(filePath, context)) {
      stems.add(stem);
      // A script runs a statement before a farther function or class of its
      // name, which answered it while this file was help text, Octave or
      // nothing: the delta's rebind for the name, which no definition here
      // changed (a stub comes after them all, and takes nothing from them).
      // Only a statement can move (a script takes no argument), and every one
      // is read through the namesakes themselves, so no name is too common
      // for it (`getam`, thousands of calls of its functions).
      if (script) {
        for (const namesake of queries.getNodesByName(stem)) {
          if (namesake.language !== 'matlab' || !NAMESAKE_KINDS.has(namesake.kind)) continue;
          for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(namesake.id, namesake.filePath, 'matlab')) {
            if (fresh.has(edge.sourceFilePath) || copyEdges.has(edge.edgeId)) continue;
            const ref = resurrectRefFromDroppedEdge(edge);
            if (!ref || matlabRefFacts(ref).form !== 'statement') continue;
            copyEdges.add(edge.edgeId);
            copyRefs.push(ref);
          }
        }
      }
      // A script or a stub that was a function, help text or Octave a sync
      // ago left its calls linked to a farther copy of its file, which kept
      // its file node and so its name: no definition changed, and a nearer
      // one answers them now. They go back as the references they were, as
      // an added file's do.
      const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
      for (const copy of queries.getNodesByName(fileName)) {
        if (copy.kind !== 'file' || changed.has(copy.filePath) || copy.language !== 'matlab') continue;
        for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(copy.id, copy.filePath, 'matlab')) {
          if (fresh.has(edge.sourceFilePath) || copyEdges.has(edge.edgeId)) continue;
          const ref = resurrectRefFromDroppedEdge(edge);
          if (!ref) continue;
          copyEdges.add(edge.edgeId);
          copyRefs.push(ref);
        }
      }
    }
  }
  const fromEdges = edgeIds.length > 0 ? queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs) : [];
  if (copyEdges.size > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds([...copyEdges], copyRefs);
  const rowIds = stems.size === 0 ? [] : queries.getRetryableFailedReferences([...stems]).flatMap((ref) =>
    ref.language === 'matlab' && stems.has(ref.referenceName) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  const woken = stems.size === 0 ? 0 : wakeMatlabBuiltinRows(queries, stems, fresh);
  return { count: refs.length + copyRefs.length + queries.reopenFailedReferences(rowIds) + woken, fromEdges };
}

/**
 * Put back in the pending set the MATLAB calls a sync's definition delta
 * moves that its rebind (the edges into a node of a delta name) cannot see,
 * for the sync's resolution sweep, in files the sync left alone:
 *
 *   - the calls linked to a file node `n.m` (or `n.M`) of a name `n` a
 *     function, class or method of came or went: a script or a stub
 *     answered them, which a new definition of the name may take (a stub
 *     comes last; a statement runs the nearer of a script and a function),
 *     though the file node kept its name (an Octave `n.m` turned into a
 *     function, `n` added as a method of a class an object of is passed);
 *   - the calls linked to a node whose name equals a delta name only when
 *     case is ignored (`foo`, `foo.m` for a `Foo.m` or `FOO.m` added or
 *     removed): a nearer case variant vetoes them (nearerInexactMatch in
 *     ./matlab-lookup), and they are no edge of the delta's names; and the
 *     failed calls of those names, which a case variant that went no longer
 *     vetoes, and the dormant ones of a built-in's (`sound` for a `Sound.m`
 *     gone: see wakeMatlabBuiltinRows). Nodes of the delta's exact names are
 *     the rebind's.
 *
 * Read through the file nodes and the nodes of each name, not by target name,
 * so no name is too common to be reopened (a script with six copies). The
 * calls into a changed file's node are reopenMatlabScriptRuns's. Returns the
 * number of references put back.
 */
export function reopenMatlabNamesakes(
  queries: QueryBuilder,
  definitionDelta: readonly string[],
  changedFilePaths: readonly string[],
): number {
  if (definitionDelta.length === 0 || !queries.hasFilesOfLanguage('matlab')) return 0;
  const fresh = new Set(changedFilePaths);
  const delta = new Set(definitionDelta);
  // `n` for a name `n` and for a file name `n.m`, the case of each kept.
  const stems = new Set<string>();
  for (const name of delta) {
    const stem = IDENTIFIER.test(name) ? name : matlabFileStem(name);
    if (stem !== null) stems.add(stem);
  }
  if (stems.size === 0) return 0;
  // A definition's own file nodes: the exact `n.m` / `n.M` of each delta name.
  const exactFiles = new Set<string>();
  for (const name of delta) if (IDENTIFIER.test(name)) for (const f of matlabFileNames(name)) exactFiles.add(f);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const seenEdges = new Set<number>();
  const seenNodes = new Set<string>();
  // The names of the case variants found, whose failed calls a variant that
  // went no longer vetoes: the delta's own are retried by the sync already.
  const variants = new Set<string>();
  const keys = new Set([...stems].flatMap((stem) => [stem.toLowerCase(), `${stem.toLowerCase()}.m`]));
  for (const key of keys) {
    for (const node of queries.getNodesByLowerName(key)) {
      if (node.language !== 'matlab' || seenNodes.has(node.id)) continue;
      seenNodes.add(node.id);
      const called = node.kind === 'file' ? matlabFileStem(node.name) : node.name;
      if (called !== null && !delta.has(called)) variants.add(called);
      if (node.kind === 'file' && fresh.has(node.filePath)) continue;
      // The rebind's, unless a definition's own file (it may hold more calls than the rebind takes of one name).
      // Nor a symbol named like a file the delta holds alone (`foo` for `foo.m` gone or come): a stub comes after
      // it, an Octave or encrypted file blocks nothing, and a new script's (an empty file's too) statements are
      // reopened with the script runs.
      if ((delta.has(node.name) || (node.kind !== 'file' && stems.has(node.name))) && !exactFiles.has(node.name)) continue;
      for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(node.id, node.filePath, 'matlab')) {
        if (fresh.has(edge.sourceFilePath) || seenEdges.has(edge.edgeId)) continue;
        seenEdges.add(edge.edgeId);
        const ref = resurrectRefFromDroppedEdge(edge);
        if (!ref) continue;
        edgeIds.push(edge.edgeId);
        refs.push(ref);
      }
    }
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs);
  // No per-name ceiling: the veto of every row of these names just changed, however many there are.
  const rowIds = variants.size === 0 ? [] : queries.getRetryableFailedReferences([...variants], Number.MAX_SAFE_INTEGER).flatMap((ref) =>
    ref.language === 'matlab' && variants.has(ref.referenceName) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  const woken = variants.size === 0 ? 0 : wakeMatlabBuiltinRows(queries, variants, fresh);
  return refs.length + queries.reopenFailedReferences(rowIds) + woken;
}

const CLASS_KINDS: readonly NodeKind[] = ['class', 'enum'];

/**
 * A file's MATLAB classes, by qualified name, each with its superclass list as
 * written. Reads only the file's MATLAB class and enum rows, so an Objective-C
 * `.m`, or a MATLAB file of functions, costs one empty index seek.
 */
function classesIn(queries: QueryBuilder, file: string): Map<string, { bases: string[]; filePath: string }> {
  const out = new Map<string, { bases: string[]; filePath: string }>();
  for (const n of queries.getNodesByFileOfKinds(file, CLASS_KINDS, 'matlab')) {
    out.set(n.qualifiedName, { bases: matlabSuperclassNames(n), filePath: n.filePath });
  }
  return out;
}

/**
 * The MATLAB classes whose superclass lists a sync changes, and the names
 * that reach: a call that reached a method through the old list (`s.greet()`
 * on a `Sub < Mid`, `Mid < pkg.Base` → `pkg::Base::greet`) must go back to a
 * reference when the list loses it, and one that failed must be retried when
 * the list gains it. Both wait under the method's name, so the names of the
 * methods of every class the old and the new lists reach, with their
 * ancestors, are what the sync's rebind re-opens (edges into a method of the
 * name, failures under it), as if a definition of that name had come or gone.
 * A class that comes or goes counts as a list changed from or to nothing, and
 * re-opens every name its ancestors' methods have, edges included, not only
 * the names it defines (the definition delta has those): it can be the link
 * another class's chain was missing (`Sub < Mid`, `Mid.m` new) or a nearer
 * copy of a class, and either changes what an inherited call or a `v.m`
 * common root already answers. So it re-opens, too, the names of the
 * methods its class folder holds (a call of one may hang on the class
 * standing: see classMethodGuess in ./matlab-lookup; its classdef's own are
 * the delta's), and the lists of the other copies of its qualified name
 * that stand after the sync, with their ancestors and their own methods: a
 * superclass written `Mid` resolves to the first copy of `Mid` on the path,
 * so a copy that comes ahead of another (`lib/Mid.m < handle` put before
 * `app/Mid.m < Node`), or goes, moves every class written `< Mid` from one
 * copy's chain to the other's, with no list changed that reaches either.
 *
 * `before` is told each file the sync is about to change or remove, while its
 * rows are there to read (as the parameter-flow pass is); `changedNames` is
 * asked once the sync has stored what it re-extracted.
 */
export class MatlabSuperclassChange {
  private readonly classesBefore = new Map<string, Map<string, { bases: string[]; filePath: string }>>();

  constructor(private readonly queries: QueryBuilder) {}

  before(file: string): void {
    if (matlabFileStem(file) === null || this.classesBefore.has(file)) return;
    this.classesBefore.set(file, classesIn(this.queries, file));
  }

  changedNames(context: ResolutionContext): string[] {
    const reached: { bases: string[]; filePath: string }[] = [];
    const names = new Set<string>();
    /** The qualified names that gained or lost a copy. */
    const moved = new Set<string>();
    let matlabFiles: string[] | undefined;
    for (const [file, before] of this.classesBefore) {
      const after = classesIn(this.queries, file);
      for (const qn of new Set([...before.keys(), ...after.keys()])) {
        const was = before.get(qn);
        const now = after.get(qn);
        if (was && now && was.bases.join('&') === now.bases.join('&')) continue;
        for (const c of [was, now]) if (c !== undefined && c.bases.length > 0) reached.push(c);
        if (was && now) continue;
        moved.add(qn);
        // A class folder's methods, which the folder's files are named after: its `contains` edges come later, from synthesis.
        if (/(?:^|\/)@[^/]+\/[^/]+$/.test(file)) {
          const dir = dirOf(file);
          matlabFiles ??= this.queries.getFilePathsOfLanguage('matlab');
          for (const f of matlabFiles) {
            const stem = dirOf(f) === dir ? matlabFileStem(f) : null;
            if (stem !== null) names.add(stem);
          }
        }
      }
    }
    for (const qn of moved) {
      for (const copy of context.getNodesByQualifiedName(qn)) {
        if (copy.language !== 'matlab' || !CLASS_KINDS.includes(copy.kind)) continue;
        reached.push({ bases: matlabSuperclassNames(copy), filePath: copy.filePath });
        for (const n of this.methodsOf(copy)) names.add(n);
      }
    }
    for (const { bases, filePath } of reached) {
      for (const cls of matlabAncestorClasses(bases, filePath, context)) {
        for (const n of this.methodsOf(cls)) names.add(n);
      }
    }
    return [...names];
  }

  /** The names of a class's methods: in its classdef file, and those the class folder's pass made it contain. */
  private methodsOf(cls: Node): Set<string> {
    const names = new Set<string>();
    const prefix = `${cls.qualifiedName}::`;
    for (const n of this.queries.getNodesByFileOfKinds(cls.filePath, ['method'], 'matlab')) {
      if (n.qualifiedName.startsWith(prefix)) names.add(n.name);
    }
    const contained = this.queries.getOutgoingEdges(cls.id, ['contains']).map((e) => e.target);
    for (const n of this.queries.getNodesByIds(contained).values()) if (n.kind === 'method') names.add(n.name);
    return names;
  }
}
