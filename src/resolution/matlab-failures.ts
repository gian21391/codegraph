/**
 * The MATLAB references that failed to resolve and are deleted instead of
 * parked as failed: the calls nothing in the project could ever answer.
 * Kept, each would be one row in every function that makes it, and on a
 * large MATLAB codebase those are most of the database.
 *
 *   - A bare call of a built-in's name (`plot(x)`, `set(h, …)`, `@isempty`)
 *     that no project function answered: MATLAB's own.
 *   - A call no symbol carries a name of (see matlabUnmatchableKeys), unless
 *     written with arguments (`f(x)`): a bare read (`t = cfg;`, a command
 *     `setup_paths`) is a variable of the workspace, a member (`v.field(k)`)
 *     a struct's field, a qualified name (`pkg.f`, `Cls.m`) an outside
 *     package's. A call written with arguments is a call leaving the index,
 *     which the viewer lists.
 *
 * What is discarded is gone for good: a sync that later adds a symbol of the
 * name links the calls in the files it re-indexes, not those in a file it
 * leaves alone — a member call written with arguments too (`r =
 * a.recalib(2)`, its row gone while no symbol was named `recalib`) — which a
 * full re-index does (pinned in __tests__/matlab-resolution.test.ts).
 */

import type { UnresolvedRef } from './types';
import { MATLAB_BUILTINS, callsByName } from '../extraction/languages/matlab-builtins';
import { matlabFileNames } from '../extraction/languages/matlab-path';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { referenceNameTail } from '../db/reference-tail';

/**
 * The references a resolution pass may discard (see the top of this file):
 * the ones it extracted afresh. Any other failure is a reference of a file a
 * sync left alone — one whose target the sync removed (its edge went back to
 * a reference), or one re-opened for a retry — and is kept, parked as failed,
 * so that the sync that brings its target back links it again, as it would a
 * TypeScript call. A pass given none (a full index) takes every reference
 * for a fresh one.
 */
export interface MatlabFreshReferences {
  /** The files a sync extracted again. */
  files: ReadonlySet<string>;
  /**
   * The MATLAB rows already pending when the sync began: an interrupted
   * run's, which no pass ever attempted, as fresh as a full index's. A sync
   * killed after re-opening references in files it left alone (its rebind,
   * an edge it took back to a reference) leaves those pending too, and they
   * count: one whose target is gone is deleted, not parked, so a target that
   * comes back later does not relink it. That is what a full index of that
   * state holds, which is all a sync has to match.
   */
  rowIds: ReadonlySet<number>;
}

function isFreshReference(ref: UnresolvedRef, fresh: MatlabFreshReferences | undefined): boolean {
  return fresh === undefined || fresh.files.has(ref.filePath) || (ref.rowId != null && fresh.rowIds.has(ref.rowId));
}

/** Whether `ref` is a bare MATLAB call of a built-in's name, or a handle to one (`plot(x)`, `@plot`; not `Cls::plot` or `obj.plot`). */
function isMatlabBuiltinCall(ref: { referenceName: string; referenceKind: string; language?: string }): boolean {
  return ref.language === 'matlab' && callsByName(ref.referenceKind) && MATLAB_BUILTINS.has(ref.referenceName);
}

/** Whether a MATLAB reference name is a member or qualified one (`v.f`, `pkg::f`), not a bare name. */
function isDottedMatlabName(name: string): boolean {
  return name.includes('.') || name.includes(':');
}

/**
 * The names a project symbol would have to carry for a MATLAB call that
 * resolved to nothing to be worth keeping: its name and the tail it is parked
 * under (`v.f` → `f`, `pkg::sub::f` → `f`), the two the dead-code check and
 * the failed-ref retry match symbols on, each also as a file's (`f.m`, a
 * script's only node). Null for any other reference, which is always kept.
 *
 * `m(obj, …)` on an object of a known class (`Cls::m`, dispatched under the
 * name written) is a call written with arguments, kept like any `f(x)` —
 * unless the name written is a built-in's (`size(c, 2)`), which, the class's
 * method and the project's functions failing, is the built-in's call.
 */
function matlabUnmatchableKeys(ref: UnresolvedRef): string[] | null {
  if (ref.language !== 'matlab' || ref.referenceKind !== 'calls') return null;
  const { dispatch } = matlabRefFacts(ref);
  if (dispatch !== undefined && !MATLAB_BUILTINS.has(dispatch)) return null;
  const name = ref.referenceName;
  const tail = ref.nameTail ?? referenceNameTail(name, ref.referenceKind);
  const names = tail === name ? [name] : [name, tail];
  return [...names, ...names.flatMap(matlabFileNames)];
}

/**
 * The failures among `failures` to delete (see the top of this file): only
 * fresh ones. Whether a symbol carries a name is asked of `known`, the names
 * every node carries (read when the pass began, after its definitions were
 * stored), or, when the pass has none (its caches dropped since), of
 * `carriedAmong`, which asks the index.
 */
export function unanswerableMatlabFailures(
  failures: readonly UnresolvedRef[],
  fresh: MatlabFreshReferences | undefined,
  known: ReadonlySet<string> | null,
  carriedAmong: (names: string[]) => ReadonlySet<string>,
): Set<UnresolvedRef> {
  const discarded = new Set<UnresolvedRef>();
  const pending: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  for (const ref of failures) {
    if (ref.language !== 'matlab' || !isFreshReference(ref, fresh)) continue;
    if (isMatlabBuiltinCall(ref)) discarded.add(ref);
    else {
      const keys = matlabUnmatchableKeys(ref);
      if (keys) pending.push({ ref, keys });
    }
  }
  if (pending.length === 0) return discarded;
  const carried = known ?? carriedAmong(pending.flatMap((p) => p.keys));
  for (const { ref, keys } of pending) {
    if (keys.some((k) => carried.has(k))) continue;
    if (isDottedMatlabName(ref.referenceName) || matlabRefFacts(ref).form !== undefined) discarded.add(ref);
  }
  return discarded;
}

/**
 * `failures` split into the ones kept (parked as failed) and the `discarded`
 * ones deleted. A discarded reference with no row id (a caller's hand-built
 * one) is deleted by its (from, name, kind) key, which reaches every row of
 * that key: so it goes only when no kept failure has that key, else it is
 * kept with them.
 */
export function splitDiscarded(
  failures: readonly UnresolvedRef[],
  discarded: ReadonlySet<UnresolvedRef>,
): { kept: UnresolvedRef[]; deleted: UnresolvedRef[] } {
  if (discarded.size === 0) return { kept: [...failures], deleted: [] };
  const keyOf = (ref: UnresolvedRef): string => `${ref.fromNodeId}\0${ref.referenceName}\0${ref.referenceKind}`;
  const keptKeys = new Set<string>();
  for (const ref of failures) if (!discarded.has(ref)) keptKeys.add(keyOf(ref));
  const kept: UnresolvedRef[] = [];
  const deleted: UnresolvedRef[] = [];
  for (const ref of failures) {
    if (!discarded.has(ref) || (ref.rowId == null && keptKeys.has(keyOf(ref)))) kept.push(ref);
    else deleted.push(ref);
  }
  return { kept, deleted };
}
