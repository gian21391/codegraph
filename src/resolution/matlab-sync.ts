/**
 * What a sync must re-open for MATLAB that the definition delta cannot see:
 * the answers that depend on more than which names a changed file defines.
 *
 *   - A script runs by its file's name, and its calls end at its file node,
 *     which a re-index keeps: a file that becomes a script, or stops being
 *     one, changes no name it defines (reopenMatlabScriptRuns).
 *   - A method call reaches an inherited method through the superclass lists
 *     of the classes between: a class whose list changes (`Mid < pkg.Base`
 *     → `Mid < handle`) changes no name either (MatlabSuperclassChange).
 */

import type { Node, NodeKind, UnresolvedReference } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';
import { isMatlabPathScript, matlabAncestorClasses, matlabSuperclassNames } from './matlab-lookup';
import { matlabFileStem } from '../extraction/languages/matlab-path';

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
 * answer differently because one became a script MATLAB runs by its name, or
 * stopped being one (a function went in, its code went out leaving only help
 * text, it turned to Octave), for the sync's resolution sweep. The calls into
 * a file that is no script now go back as the references they were; the
 * calls parked as failed under the name of one that is a script
 * (`setup_paths` for `setup_paths.m`) are retried. Calls in `changedFilePaths`
 * are left alone: the sync resolved them already. `matlabFilePaths` are the
 * ones matlabScriptCandidates picks out of them. Returns the number of
 * references put back.
 */
export function reopenMatlabScriptRuns(
  queries: QueryBuilder,
  context: ResolutionContext,
  matlabFilePaths: readonly string[],
  changedFilePaths: readonly string[],
): number {
  const fresh = new Set(changedFilePaths);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const stems = new Set<string>();
  for (const filePath of matlabFilePaths) {
    const stem = matlabFileStem(filePath);
    if (!stem) continue;
    if (isMatlabPathScript(filePath, context)) {
      stems.add(stem);
      continue;
    }
    // Only the edges into the file node: a script's calls end there.
    for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(`file:${filePath}`, filePath, 'matlab')) {
      if (fresh.has(edge.sourceFilePath)) continue;
      const ref = resurrectRefFromDroppedEdge(edge);
      if (!ref) continue;
      edgeIds.push(edge.edgeId);
      refs.push(ref);
    }
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
  const rowIds = stems.size === 0 ? [] : queries.getRetryableFailedReferences([...stems]).flatMap((ref) =>
    ref.language === 'matlab' && stems.has(ref.referenceName) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  return refs.length + queries.reopenFailedReferences(rowIds);
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
 * common root already answers.
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
    const reached = new Map<string, { bases: string[]; filePath: string }[]>();
    for (const [file, before] of this.classesBefore) {
      const after = classesIn(this.queries, file);
      for (const qn of new Set([...before.keys(), ...after.keys()])) {
        const was = before.get(qn);
        const now = after.get(qn);
        if (was && now && was.bases.join('&') === now.bases.join('&')) continue;
        const lists = [was, now].filter((c): c is { bases: string[]; filePath: string } => c !== undefined && c.bases.length > 0);
        if (lists.length > 0) reached.set(qn, lists);
      }
    }
    if (reached.size === 0) return [];
    const names = new Set<string>();
    for (const lists of reached.values()) {
      for (const { bases, filePath } of lists) {
        for (const cls of matlabAncestorClasses(bases, filePath, context)) {
          for (const n of this.methodsOf(cls)) names.add(n);
        }
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
