/**
 * The MATLAB references that failed to resolve and are deleted instead of
 * parked as failed: the calls nothing in the project could ever answer.
 * Kept, each would be one row in every function that makes it, and on a
 * large MATLAB codebase those are most of the database.
 *
 *   - A bare call of a built-in's name (`plot(x)`, `set(h, …)`, `@isempty`)
 *     that no project function answered, and no project symbol carries the
 *     name of: MATLAB's own. One that a project symbol carries is kept: where
 *     that definition stands (off the search path, behind a nearer case
 *     variant) may change with the path, and a sync that changes it must
 *     link the call as a fresh index would.
 *   - A member or qualified call (`v.f(x)`, `Cls.m`, `pkg.f`, `obj@Base(x)`;
 *     see matlabMemberCall) whose member no symbol could answer: written with
 *     arguments, no symbol of the member's name (nor a `.m` file of it);
 *     written without (`t = m.Total;`, `Cls.MAX`, the `bare` fact), no
 *     callable one — a property, a constant, an enumeration member or a field
 *     of the name is read, never called. Only MATLAB's symbols and `.m`
 *     files count: a MATLAB call resolves to nothing else. One the member's
 *     name has an answer for is kept, a read of the class's own property too
 *     (resolution gives that one no edge): which of a class's members is a
 *     property and which a method, and which class a head names, is other
 *     files' to say, and the row is what a sync that changes them links
 *     again. The rule depends on the project's symbols alone, never on which
 *     file a sync extracted, so it holds in every file: a sync ends with the
 *     rows a fresh index of the same files has. One whose name the value
 *     interpreter built (the `computed` fact: `feval(strcat('pkg.', 'f'))`,
 *     `eval(['x = Model.' 'make;'])`) is kept whatever carries its member: no
 *     text spells the name, so no word scan could find its file again when
 *     a carrier comes back, and its row is what relinks it then.
 *   - Any other call no symbol carries a name of (see matlabUnmatchableKeys),
 *     unless written with arguments (`f(x)`): a bare read (`t = cfg;`, a
 *     command `setup_paths`) is a variable of the workspace. A call written
 *     with arguments is a call leaving the index, which the viewer lists —
 *     unless it is of a name code run at runtime makes (the `runtime` fact:
 *     `eval('x = 3;'); x(2)`, a `load`ed name, anything a callback given as
 *     text or `evalin` runs), most often a variable there; such a handle
 *     reference (a callback's) goes the same way.
 *
 * A bare name's failure is judged only where its file was extracted afresh
 * (see MatlabFreshReferences), and what is discarded of it is gone for good:
 * a sync that later adds a symbol of the name links the bare reads in the
 * files it re-indexes, not those in a file it leaves alone, which a full
 * re-index does (pinned in __tests__/matlab-resolution.test.ts). A
 * built-in's name and a member's are the exceptions: a sync that gives one
 * its first carrier (of the kind the rule asks for) extracts the files
 * naming it again, and one that takes the last away drops the rows the rule
 * no longer keeps (see ./matlab-builtin-carriers).
 */

import type { UnresolvedRef } from './types';
import { MATLAB_BUILTINS, callsByName } from '../extraction/languages/matlab-builtins';
import { matlabFileNames } from '../extraction/languages/matlab-path';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { referenceNameTail } from '../db/reference-tail';

/**
 * The references a resolution pass may discard (see the top of this file):
 * the ones it extracted afresh, a member call aside, which is judged
 * wherever it is. Any other failure is a reference of a file a
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
 * The node kinds that hold a value rather than run code: a member of one of
 * these kinds written without an argument list is read, never called.
 */
export const MATLAB_VALUE_KINDS: readonly string[] = ['property', 'constant', 'enum_member', 'field'];

/**
 * A MATLAB member or qualified call, the rule's subject (see the top of this
 * file): `v.f(x)`, `v.f`, `Cls::m`, `pkg::f`, `Base::Base` for `obj@Base(x)`;
 * what its member is named (the tail it is parked under), and whether it was
 * written without an argument list, so that only a callable symbol answers
 * it. Not `m(obj, …)` (`Cls::m` with the `dispatch` fact: a call written as
 * a function's, kept like any `f(x)`), and no handle.
 */
export function matlabMemberCall(ref: { referenceName: string; referenceKind: string; language?: string; candidates?: readonly string[] }): { member: string; bare: boolean } | null {
  if (ref.language !== 'matlab' || ref.referenceKind !== 'calls' || !isDottedMatlabName(ref.referenceName)) return null;
  const facts = matlabRefFacts(ref);
  if (facts.dispatch !== undefined) return null;
  return { member: referenceNameTail(ref.referenceName, ref.referenceKind), bare: facts.form !== undefined };
}

/** The names a symbol answering a name `name` may carry: its own, and its `.m` file's (`f`, `f.m`). */
export function matlabNameKeys(name: string): string[] {
  return [name, ...matlabFileNames(name)];
}

/**
 * Whether a MATLAB row is a member call kept for a later sync rather than a
 * call leaving the index: written without an argument list (most often a
 * read of a property), or with a name the value interpreter built (see the
 * top of this file). PARKED_MATLAB_MEMBER_READ_SQL (../db/queries) states
 * the same in SQL, for the surfaces that leave such rows out.
 */
export function isParkedMatlabMemberRow(ref: { referenceName: string; referenceKind: string; language?: string; candidates?: readonly string[] }): boolean {
  const call = matlabMemberCall(ref);
  return call !== null && (call.bare || matlabRefFacts(ref).computed === true);
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
 * method and the project's functions failing, is the built-in's call. A
 * name made at runtime (the `runtime` fact) goes by its keys whatever its
 * form or kind.
 */
function matlabUnmatchableKeys(ref: UnresolvedRef): string[] | null {
  if (ref.language !== 'matlab') return null;
  const { dispatch, runtime } = matlabRefFacts(ref);
  if (ref.referenceKind !== 'calls' && !(runtime && ref.referenceKind === 'function_ref')) return null;
  if (dispatch !== undefined && !MATLAB_BUILTINS.has(dispatch) && !runtime) return null;
  const name = ref.referenceName;
  const tail = ref.nameTail ?? referenceNameTail(name, ref.referenceKind);
  const names = tail === name ? [name] : [name, tail];
  return [...names, ...names.flatMap(matlabFileNames)];
}

/**
 * Which of a list of names MATLAB's symbols carry: any of them, or a
 * callable one (no property, constant, enumeration member or field).
 */
export interface MatlabCarriers {
  any(names: string[]): ReadonlySet<string>;
  callable(names: string[]): ReadonlySet<string>;
}

/**
 * The failures among `failures` to delete (see the top of this file): a
 * member call's wherever it is (one with the `computed` fact never), any
 * other only when fresh. Whether a symbol carries a name is asked of
 * `known`, the names every node carries (read when the pass began, after its
 * definitions were stored), or, when the pass has none (its caches dropped
 * since), of `carriedAmong`, which asks the index; a member's carriers, of
 * `members`, which asks it of MATLAB's symbols alone.
 *
 * A built-in's name that a project symbol carries is kept too, with a MATLAB
 * search path in force or not: the call failed because of where the
 * project's definition is (off the path, or behind a nearer case variant),
 * and a path that comes, changes or goes later (a sync re-resolves every
 * MATLAB reference then) may make it the one MATLAB runs, as a fresh index
 * would find it.
 */
export function unanswerableMatlabFailures(
  failures: readonly UnresolvedRef[],
  fresh: MatlabFreshReferences | undefined,
  known: ReadonlySet<string> | null,
  carriedAmong: (names: string[]) => ReadonlySet<string>,
  members: MatlabCarriers,
): Set<UnresolvedRef> {
  const discarded = new Set<UnresolvedRef>();
  const pending: Array<{ ref: UnresolvedRef; keys: string[]; builtin: boolean }> = [];
  const bareMembers: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  const calledMembers: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  for (const ref of failures) {
    if (ref.language !== 'matlab') continue;
    const member = matlabMemberCall(ref);
    if (member) {
      // Judged in every file, fresh or not: the rule reads the project's
      // symbols only, and a sync keeps it true where they change (see
      // ./matlab-builtin-carriers). A computed name is kept.
      if (matlabRefFacts(ref).computed) continue;
      if (member.bare) bareMembers.push({ ref, keys: matlabNameKeys(member.member) });
      else calledMembers.push({ ref, keys: matlabUnmatchableKeys(ref)! });
      continue;
    }
    if (!isFreshReference(ref, fresh)) continue;
    if (isMatlabBuiltinCall(ref)) {
      pending.push({ ref, keys: matlabNameKeys(ref.referenceName), builtin: true });
    } else {
      const keys = matlabUnmatchableKeys(ref);
      if (keys) pending.push({ ref, keys, builtin: false });
    }
  }
  const dropUncarried = (list: Array<{ ref: UnresolvedRef; keys: string[] }>, carried: (names: string[]) => ReadonlySet<string>): void => {
    if (list.length === 0) return;
    const found = carried(list.flatMap((p) => p.keys));
    for (const { ref, keys } of list) if (!keys.some((k) => found.has(k))) discarded.add(ref);
  };
  dropUncarried(bareMembers, (names) => members.callable(names));
  dropUncarried(calledMembers, (names) => members.any(names));
  if (pending.length === 0) return discarded;
  const carried = known ?? carriedAmong(pending.flatMap((p) => p.keys));
  for (const { ref, keys, builtin } of pending) {
    if (keys.some((k) => carried.has(k))) continue;
    const facts = matlabRefFacts(ref);
    if (builtin || isDottedMatlabName(ref.referenceName) || facts.form !== undefined || facts.runtime) discarded.add(ref);
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
