/**
 * The MATLAB references that failed to resolve and are not parked as failed:
 * the calls nothing in the project answers now. A built-in's call is
 * deleted: kept, each would be one row in every function that makes it, and
 * on a large MATLAB codebase those are most of the database. Any other is
 * kept as a dormant row (DORMANT_REF_STATUS in ../db/queries), which no
 * reader counts and the sync that gives its name a carrier wakes (see
 * ./matlab-builtin-carriers).
 *
 *   - A bare call of a built-in's name (`plot(x)`, `set(h, …)`, `@isempty`)
 *     that no project function answered, and no symbol that could answer a
 *     bare MATLAB call carries the name of (MATLAB_CALLABLE_NODES: a MATLAB
 *     symbol, no property, constant, enumeration member or field, which a
 *     bare call never runs; a C++ method or a Java one never answers a
 *     MATLAB call): MATLAB's own, deleted. One that such a symbol carries is
 *     kept: where that definition stands (off the search path, after
 *     MATLAB's own folders, behind a nearer case variant) may change with
 *     the path, and a sync that changes it must link the call as a fresh
 *     index would. It is dormant only where MATLAB's own function wins: every
 *     such carrier is one MATLAB runs by that bare name only through the
 *     path (MATLAB_PATH_CARRIER_KINDS: a function file, a script, a plain
 *     function of another file), and no `.m` file of the name is one MATLAB
 *     may run ahead of its own from the caller (matlabBuiltinCopyMayWin in
 *     ./matlab-lookup: physbase's `sound`, whose project copy its startup
 *     adds with `addpath(…, '-end')`, and a copy off the path or out of
 *     reach, are not). It stays failed when a method, a class or an
 *     enumeration carries the name (a call of the class's own overload that
 *     resolution missed is worth counting), and when a copy that may win
 *     still left the call unlinked: a script called with arguments (MATLAB
 *     errors), a stub (MATLAB runs the MEX file), a nearer case variant's
 *     veto, or a copy in the caller's folder, where which copy runs is the
 *     current folder's to say. A sync wakes such a dormant row wherever it
 *     would re-open a failed one (see ./matlab-builtin-carriers).
 *   - A member or qualified call (`v.f(x)`, `Cls.m`, `pkg.f`, `obj@Base(x)`;
 *     see matlabMemberCall) whose member no symbol could answer: written with
 *     arguments, no symbol of the member's name that a dotted call can reach
 *     (MATLAB_MEMBER_NODES: a method, a class, a package's function, a `.m`
 *     file in a class or package folder) — a plain, local or nested
 *     function, a script, a property or a field of the name is never what
 *     `am.X(i)`, `handles.f1(k)` or `jLabel.setText(s)` runs, which index a
 *     struct's field or a property, or call Java; written without
 *     (`t = m.Total;`, `Cls.MAX`, the `bare` fact), no callable one — a
 *     property, a constant, an enumeration member or a field of the name is
 *     read, never called. Only MATLAB's symbols and `.m` files count: a
 *     MATLAB call resolves to nothing else. One the member's name has an
 *     answer for is kept, a read of the class's own property too (resolution
 *     gives that one no edge): which of a class's members is a property and
 *     which a method, and which class a head names, is other files' to say,
 *     and the row is what a sync that changes them links again. The rule
 *     depends on the project's symbols alone, never on which file a sync
 *     extracted, so it holds in every file: a sync ends with the
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
 *     reference (a callback's) goes the same way. Nor is one of a name base
 *     MATLAB has only as a method of one of its own classes
 *     (MATLAB_METHOD_ONLY_NAMES: `parse(p, …)` on an `inputParser`,
 *     `keys(m)`) that no symbol able to answer a bare MATLAB call carries
 *     the name of (MATLAB_CALLABLE_NODES, as a built-in's: a property, a
 *     Java field or a C++ method keeps none): no project code answers it,
 *     and the only code of the name MATLAB has is its class's method; kept
 *     dormant under its name, which the carrier step wakes when such a
 *     symbol of the name comes. Nor is one of a name a
 *     script makes that the call's scope ran before it (`alsglobe` declaring
 *     `global IDXgolden`, then `IDXgolden(k)`): a variable that script left
 *     in the scope's workspace. That one is judged after resolution, by a
 *     pass of its own over every such call (see isMatlabPlainCall and
 *     ./matlab-script-workspace), which keeps it dormant.
 *
 * Every class is kept dormant, and judged wherever its file is, fresh or
 * not: the rule reads the project's symbols alone (and, for a built-in's,
 * where its copies stand on the search path), so a failure in a file a sync
 * left alone goes dormant as a fresh index's does.
 * Each dormant row is stored under its tail (the name of a bare read, a
 * command or a name made at runtime; the member of `v.f` or `T::size`), the
 * one key its carriers are looked up by. A built-in's call is deleted only
 * where its file was extracted afresh (see MatlabFreshReferences): its rule
 * asks where the project's `.m` files are as well (see
 * ../extraction/languages/matlab-builtins), and a sync that gives the name
 * its first carrier extracts the files naming it again.
 */

import type { NodeFilter, QueryBuilder } from '../db/queries';
import type { UnresolvedRef } from './types';
import { MATLAB_BUILTINS, MATLAB_METHOD_ONLY_NAMES, callsByName } from '../extraction/languages/matlab-builtins';
import { matlabFileNames } from '../extraction/languages/matlab-path';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { referenceNameTail } from '../db/reference-tail';

/**
 * The references a resolution pass may delete as a built-in's call (see the
 * top of this file): the ones it extracted afresh. Any other built-in's
 * failure is a reference of a file a sync left alone — one whose target the
 * sync removed (its edge went back to a reference), or one re-opened for a
 * retry — and is kept, parked as failed, so that the sync that brings its
 * target back links it again, as it would a TypeScript call. A pass given
 * none (a full index) takes every reference for a fresh one. Every other
 * class goes dormant wherever it is.
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
   * state holds, which is all a sync has to match. And the rows the sync's
   * scripts pass turns back from calls into a file that is no script now
   * (see reopenMatlabScriptRuns in ./matlab-sync).
   */
  rowIds: ReadonlySet<number>;
}

function isFreshReference(ref: UnresolvedRef, fresh: MatlabFreshReferences | undefined): boolean {
  return fresh === undefined || fresh.files.has(ref.filePath) || (ref.rowId != null && fresh.rowIds.has(ref.rowId));
}

/** Whether `ref` is a bare MATLAB call of a built-in's name, or a handle to one (`plot(x)`, `@plot`; not `Cls::plot` or `obj.plot`). */
export function isMatlabBuiltinCall(ref: { referenceName: string; referenceKind: string; language?: string }): boolean {
  return ref.language === 'matlab' && callsByName(ref.referenceKind) && MATLAB_BUILTINS.has(ref.referenceName);
}

/**
 * Whether `ref` is a bare MATLAB call of a name base MATLAB has only as a
 * method of one of its own classes (MATLAB_METHOD_ONLY_NAMES: `parse` of
 * `inputParser`, `keys` of `containers.Map`): no built-in, a call like any
 * other in every other respect, but one that no callable MATLAB symbol
 * carries the name of is kept dormant, not live (see the top of this file).
 */
function isMatlabMethodNameCall(ref: { referenceName: string; referenceKind: string; language?: string }): boolean {
  return ref.language === 'matlab' && ref.referenceKind === 'calls' && MATLAB_METHOD_ONLY_NAMES.has(ref.referenceName);
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
 * The nodes that carry a name for a MATLAB call that is no built-in's (a
 * built-in's are MATLAB_CALLABLE_NODES): any but the file node of a `.m`
 * file whose text extraction read as no MATLAB code (Octave source, an
 * encrypted MATLAB Compiler file: see matlabUnreadReason), which answers no
 * call. A file of comments only (the help of a MEX function) and a script
 * carry their names.
 */
export const MATLAB_CARRIER_NODES: NodeFilter = { readable: true };
/** The MATLAB nodes: a sync diffs their names, file by file, for the member calls' carriers (see ./matlab-builtin-carriers). */
export const MATLAB_NODES: NodeFilter = { language: 'matlab', readable: true };
/**
 * The MATLAB nodes that carry a member's name for a call written without an
 * argument list: the callable ones. And the ones that carry a built-in's
 * name for its bare call (see the top of this file).
 */
export const MATLAB_CALLABLE_NODES: NodeFilter = { language: 'matlab', exceptKinds: MATLAB_VALUE_KINDS, readable: true };
/**
 * The kinds of the callable MATLAB nodes that MATLAB runs by a bare name only
 * through the search path, if at all: a function (a function file's, a local
 * or nested one of another file, a package's) and a file node (a script, the
 * help text of a MEX function). A built-in's call that only these carry is
 * kept dormant (see the top of this file).
 */
export const MATLAB_PATH_CARRIER_KINDS: readonly string[] = ['function', 'file'];
/** The callable MATLAB nodes of any other kind: a method, a class, an enumeration. */
const MATLAB_OVERLOAD_CARRIER_NODES: NodeFilter = { ...MATLAB_CALLABLE_NODES, exceptKinds: [...MATLAB_VALUE_KINDS, ...MATLAB_PATH_CARRIER_KINDS] };
/**
 * The MATLAB nodes that carry a member's name for a call written with
 * arguments (`v.f(x)`, `pkg.f(x)`, `Cls.m(x)`, `obj@Base(x)`): the ones such
 * a call can reach, which are the ones resolution links it to
 * (callTarget in ./matlab-lookup) — a method (in a classdef or a class
 * folder), a class or an enumeration (`pkg.Cls(x)`, `obj@Base(x)` on a class
 * that declares no constructor), a package's function (`pkg::f`, exported:
 * isPackageMember) — and the file node of a `.m` file directly in a class or
 * a package folder (`+pkg/f.m`, `@Cls/f.m`: the help text of a MEX function
 * that MATLAB reaches as `pkg.f(x)`, which the index never reads). Never a
 * plain, local or nested function, a script or any other `.m` file, a
 * property, a constant, an enumeration member or a field: `a.f(x)` reaches
 * none of them. (A nested or package-local function `pkg::helper` is
 * reached by its qualified name from its own file alone, where the call
 * resolves to it and so never fails.) Every one is a callable node too.
 */
export const MATLAB_MEMBER_NODES: NodeFilter = { language: 'matlab', readable: true, matlabMember: true };

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
 * Which of `keys` (names a call's carrier would carry, see
 * matlabUnmatchableKeys) a node of the project carries: a name any node has
 * (asked of `known`, the names every node carries, when the caller has it),
 * and a `.m` file's name only when the file is a carrier
 * (MATLAB_CARRIER_NODES): a file nothing is read from carries none.
 */
export function matlabCarriedKeys(keys: Iterable<string>, known: ReadonlySet<string> | null, queries: QueryBuilder): (key: string) => boolean {
  const all = [...keys];
  const named = known ?? queries.getNodeNamesAmong(all);
  const fileKeys = new Set<string>();
  for (const k of all) if (named.has(k) && /\.[mM]$/.test(k)) fileKeys.add(k);
  const carriedFiles = fileKeys.size > 0 ? queries.getNodeNamesAmong(fileKeys, MATLAB_CARRIER_NODES) : fileKeys;
  return (k) => named.has(k) && (!fileKeys.has(k) || carriedFiles.has(k));
}

/**
 * Whether `ref` has the shape of a call a fresh pass parks as failed, not
 * dormant, when nothing carries its name: a MATLAB `calls` row of a bare
 * name (no member, no qualifier) that is no built-in's, written with
 * arguments (no `form` fact), with no `runtime`, `dispatch` or `computed`
 * fact, and no name MATLAB has only as a method (see isMatlabMethodNameCall)
 * — `IDXgolden(k)`. When a script its scope ran before it makes the
 * name, it is one of the variables that script left in the scope's workspace,
 * and kept dormant instead (see ./matlab-script-workspace). Its carriers are
 * not asked here.
 */
export function isMatlabPlainCall(ref: { referenceName: string; referenceKind: string; language?: string; candidates?: readonly string[] }): boolean {
  if (ref.language !== 'matlab' || ref.referenceKind !== 'calls' || isDottedMatlabName(ref.referenceName)) return false;
  if (MATLAB_BUILTINS.has(ref.referenceName) || MATLAB_METHOD_ONLY_NAMES.has(ref.referenceName)) return false;
  const facts = matlabRefFacts(ref);
  return facts.form === undefined && !facts.runtime && facts.dispatch === undefined && !facts.computed;
}

/** The failures a resolution pass does not park as failed (see the top of this file). */
export interface UnanswerableMatlabFailures {
  /** A built-in's calls no symbol could answer, deleted. */
  deleted: Set<UnresolvedRef>;
  /** Every other class's, and a built-in's call only the path could give a copy of, kept dormant. */
  dormant: Set<UnresolvedRef>;
}

/**
 * Whether MATLAB's own function is what a bare call of a built-in's name
 * runs from `ref`'s caller, as far as the project's copies of the name tell:
 * no `.m` file of the name (`carriers`, the files carrying each name:
 * MATLAB_CALLABLE_NODES) is one MATLAB may run ahead of its own there
 * (`mayWin`: see matlabBuiltinCopyMayWin in ./matlab-lookup). One that may,
 * and that the call still failed to link, is a script called with
 * arguments (MATLAB errors), a stub (MATLAB runs the MEX file), a copy a
 * nearer case variant vetoes, or one in a folder the current one may be:
 * the call is no call of MATLAB's, and stays live.
 */
function matlabOwnFunctionWins(
  ref: UnresolvedRef,
  carriers: ReadonlyMap<string, ReadonlySet<string>>,
  mayWin: (callerFile: string, copyFile: string) => boolean,
): boolean {
  return !matlabFileNames(ref.referenceName).some((k) => [...(carriers.get(k) ?? [])].some((f) => mayWin(ref.filePath, f)));
}

/**
 * Of `list`, a built-in's failures, the ones to delete (no symbol carries
 * the name that could answer the call: only a fresh one, see
 * MatlabFreshReferences) and the ones to keep dormant (every carrier one
 * that only the path gives, none in the caller's folder: see the top of
 * this file), into `deleted` and `dormant`; the rest stay failed. Whether a
 * symbol carries a name is asked of `known` first, when the caller has it.
 */
function judgeMatlabBuiltinFailures(
  list: ReadonlyArray<{ ref: UnresolvedRef; keys: string[]; fresh: boolean }>,
  known: ReadonlySet<string> | null,
  queries: QueryBuilder,
  out: UnanswerableMatlabFailures,
  mayWin: (callerFile: string, copyFile: string) => boolean,
): void {
  if (list.length === 0) return;
  const keys = new Set(list.flatMap((p) => p.keys).filter((k) => known === null || known.has(k)));
  const carriers = keys.size > 0 ? queries.getFilesCarryingNames(keys, MATLAB_CALLABLE_NODES) : new Map<string, Set<string>>();
  const overloads = carriers.size > 0 ? queries.getNodeNamesAmong(carriers.keys(), MATLAB_OVERLOAD_CARRIER_NODES) : new Set<string>();
  for (const { ref, keys: own, fresh } of list) {
    const carried = own.filter((k) => carriers.has(k));
    if (carried.length === 0) {
      if (fresh) out.deleted.add(ref);
    } else if (!carried.some((k) => overloads.has(k)) && matlabOwnFunctionWins(ref, carriers, mayWin)) {
      out.dormant.add(ref);
    }
  }
}

/**
 * The failures among `failures` not to park as failed (see the top of this
 * file): a built-in's call no symbol could answer, only when fresh, to
 * delete, and one only the path gives copies of, wherever it is, to keep
 * dormant; any other, wherever it is, to keep dormant (a member call with
 * the `computed` fact never).
 * Whether a symbol carries a name is asked of
 * `known`, the names every node carries (read when the pass began, after its
 * definitions were stored), or, when the pass has none (its caches dropped
 * since), of the index; a member's carriers, of MATLAB's symbols alone
 * (MATLAB_MEMBER_NODES for a call with arguments, MATLAB_CALLABLE_NODES for
 * one without).
 *
 * No node of a `.m` file whose text was read as no MATLAB code carries a
 * name (MATLAB_CARRIER_NODES): Octave's `datestr.m`, MATLAB Compiler's
 * encrypted `pause.m` answer no call, and their names keep no row.
 *
 * A built-in's name that a symbol able to answer the call carries (one of
 * MATLAB_CALLABLE_NODES) is kept too, with a MATLAB search path in force or
 * not: the call failed because of where the project's definition is (off
 * the path, after MATLAB's own folders, or behind a nearer case variant),
 * and a path that comes, changes or goes later (a sync re-resolves every
 * MATLAB reference then, its dormant built-in calls with them) may make it
 * the one MATLAB runs, as a fresh index would find it. Kept dormant or
 * failed, by its carriers (see judgeMatlabBuiltinFailures).
 */
export function unanswerableMatlabFailures(
  failures: readonly UnresolvedRef[],
  fresh: MatlabFreshReferences | undefined,
  known: ReadonlySet<string> | null,
  queries: QueryBuilder,
  mayWin: (callerFile: string, copyFile: string) => boolean = () => true,
): UnanswerableMatlabFailures {
  const deleted = new Set<UnresolvedRef>();
  const dormant = new Set<UnresolvedRef>();
  const pending: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  const methodNames: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  const builtins: Array<{ ref: UnresolvedRef; keys: string[]; fresh: boolean }> = [];
  const bareMembers: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  const calledMembers: Array<{ ref: UnresolvedRef; keys: string[] }> = [];
  for (const ref of failures) {
    if (ref.language !== 'matlab') continue;
    const member = matlabMemberCall(ref);
    if (member) {
      // A computed name is kept (see the top of this file).
      if (matlabRefFacts(ref).computed) continue;
      if (member.bare) bareMembers.push({ ref, keys: matlabNameKeys(member.member) });
      else calledMembers.push({ ref, keys: matlabUnmatchableKeys(ref)! });
      continue;
    }
    if (isMatlabBuiltinCall(ref)) {
      builtins.push({ ref, keys: matlabNameKeys(ref.referenceName), fresh: isFreshReference(ref, fresh) });
    } else if (isMatlabMethodNameCall(ref)) {
      methodNames.push({ ref, keys: matlabNameKeys(ref.referenceName) });
    } else {
      const keys = matlabUnmatchableKeys(ref);
      if (keys) pending.push({ ref, keys });
    }
  }
  const dropUncarried = (list: Array<{ ref: UnresolvedRef; keys: string[] }>, filter: NodeFilter): void => {
    if (list.length === 0) return;
    const found = queries.getNodeNamesAmong(list.flatMap((p) => p.keys), filter);
    for (const { ref, keys } of list) if (!keys.some((k) => found.has(k))) dormant.add(ref);
  };
  dropUncarried(bareMembers, MATLAB_CALLABLE_NODES);
  dropUncarried(calledMembers, MATLAB_MEMBER_NODES);
  // A name MATLAB has only as a method: only a symbol that can answer a bare
  // MATLAB call keeps it live, as a built-in's (no property, nothing of
  // another language).
  dropUncarried(methodNames, MATLAB_CALLABLE_NODES);
  judgeMatlabBuiltinFailures(builtins, known, queries, { deleted, dormant }, mayWin);
  if (pending.length === 0) return { deleted, dormant };
  const carried = matlabCarriedKeys(pending.flatMap((p) => p.keys), known, queries);
  for (const { ref, keys } of pending) {
    if (keys.some(carried)) continue;
    const facts = matlabRefFacts(ref);
    if (isDottedMatlabName(ref.referenceName) || facts.form !== undefined || facts.runtime) dormant.add(ref);
  }
  return { deleted, dormant };
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
