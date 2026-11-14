/**
 * A MATLAB call of a built-in's name (`disp(3)`, `@beep`) that no project
 * function answers is kept only while the project could answer it: its row
 * is dropped at extraction unless a `.m` file of that name exists (or the
 * file imports, or defines the name itself), and dropped at resolution unless
 * a project symbol carries the name (see ../extraction/languages/
 * matlab-builtins, ./matlab-failures). Those rows are written and judged only
 * when their own file is extracted.
 *
 * So a sync that gives a built-in's name its first carrier — the first `.m`
 * file of that name, or the first symbol of it anywhere — leaves the calls a
 * fresh index would now keep in files the sync never touched: they were
 * dropped while nothing answered them. And a sync that takes the last carrier
 * away leaves rows a fresh index would not keep. Here is what such a sync
 * must do so as to end where a fresh index ends: extract again the MATLAB
 * files that name a built-in which gained a carrier, and delete the rows of
 * one that lost it. These are rare: a project rarely names a file or a
 * function after a built-in.
 *
 * A member call's row (`v.f(x)`, `m.Total`, `obj@Base(x)`; see
 * matlabMemberCall in ./matlab-failures) is kept while its member's name has
 * a carrier of the kind it needs among MATLAB's symbols: any symbol for a
 * call written with arguments, a callable one (no property, constant,
 * enumeration member or field) for one written without. The same two
 * transitions apply, per kind: a member's name that gains its first carrier
 * of a kind has the files writing it as a member (`.f`, `@f`, `f@`)
 * extracted again, in the same word scan as the built-ins'; one that loses
 * its last has the rows the rule no longer keeps deleted. A name a sync
 * turns from a property into a method in one file counts: its callable
 * carriers change, its names do not. And a member's name whose callable
 * carriers a sync changed at all has its kept rows resolved again, every one
 * of them (no ceiling, as the sync's retry of failed rows has): which class
 * has the method decides those rows' edges, and a fresh index links them by
 * where the methods are now. Only MATLAB's symbols and `.m` files are a
 * member's carriers, so only they start any of this: a JavaScript file's new
 * names do not.
 *
 * The step is recorded before it changes anything (see MatlabCarrierStep):
 * a sync killed in it leaves the record, and the next sync finishes it
 * before it does anything else.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import { MATLAB_BUILTINS, addMatlabReachableNames } from '../extraction/languages/matlab-builtins';
import { isJavaImport } from '../extraction/languages/matlab-java';
import { MATLAB_CALLABLE_NODES, MATLAB_NODES, matlabMemberCall, matlabNameKeys } from './matlab-failures';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';


/** What a sync changed of the project's symbols and files, as the extraction step of a sync knows it. */
export interface MatlabCarrierInput {
  /** The names whose definition set the sync changed (added to or taken from a file), in any language. */
  deltaNames: ReadonlySet<string>;
  /** `file\0name` of every node of the files the sync replaced or removed, read before it did. */
  pairsBefore: ReadonlySet<string>;
  /** The files the sync extracted (their nodes are the new ones now). */
  extracted: ReadonlySet<string>;
  addedPaths: readonly string[];
  removedPaths: readonly string[];
  /** `file\0name` of every MATLAB node (MATLAB_NODES) of the files the sync replaced or removed, read before. */
  matlabPairsBefore: ReadonlySet<string>;
  /** The same of the files the sync extracted, read after. */
  matlabPairsAfter: ReadonlySet<string>;
  /** `file\0name` of every callable MATLAB node (MATLAB_CALLABLE_NODES) of those files, read before. */
  callablePairsBefore: ReadonlySet<string>;
  /** The same of the files the sync extracted, read after. */
  callablePairsAfter: ReadonlySet<string>;
}

export interface MatlabCarrierChange {
  /** The built-ins' names a MATLAB call of which a fresh index keeps now and did not before: the files naming them are extracted again. */
  gained: string[];
  /** The ones no symbol carries any more: every row of a call of the name goes. */
  lost: string[];
  /** The ones still carried that no `.m` file is named for any more: a row goes unless its file imports, or defines the name. */
  unreached: string[];
  /** Members' names that gained their first carrier, or first callable one: the files writing them as a member are extracted again. */
  membersGained: string[];
  /** Members' names no symbol carries any more: every member call's row of the name goes. */
  membersLost: string[];
  /** Members' names still carried that no callable symbol carries any more: the rows of those written without arguments go. */
  membersUncallable: string[];
  /** Members' names whose callable carriers changed: their kept rows are resolved again. */
  membersRecalled: string[];
}

const noChange = (): MatlabCarrierChange => ({ gained: [], lost: [], unreached: [], membersGained: [], membersLost: [], membersUncallable: [], membersRecalled: [] });

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The built-ins' names among a node's (or a script file's: `beep.m`) names. */
function builtinOf(name: string): string | null {
  if (MATLAB_BUILTINS.has(name)) return name;
  const stem = /^(.+)\.[mM]$/.exec(name)?.[1];
  return stem !== undefined && MATLAB_BUILTINS.has(stem) ? stem : null;
}

/** Which built-in and member names a sync gave a first carrier, or took the last one from (see the top of this file). */
export function matlabCarrierChanges(queries: QueryBuilder, input: MatlabCarrierInput): MatlabCarrierChange {
  const candidates = new Set<string>();
  const nameOf = (pair: string): string => pair.slice(pair.indexOf('\0') + 1);
  // A member's name, as a MATLAB symbol's (`f`) or a `.m` file's (`f.m`):
  // every name whose MATLAB definition set changed, and every one whose
  // callable set did (`recalled`).
  const members = new Set<string>();
  const recalled = new Set<string>();
  const stemOf = (name: string): string | null => {
    const stem = /^(.+)\.[mM]$/.exec(name)?.[1] ?? name;
    return IDENTIFIER.test(stem) ? stem : null;
  };
  const addChanged = (a: ReadonlySet<string>, b: ReadonlySet<string>, into: Set<string>[]): void => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      for (const pair of x) {
        if (y.has(pair)) continue;
        const stem = stemOf(nameOf(pair));
        if (stem !== null) for (const set of into) set.add(stem);
      }
    }
  };
  addChanged(input.matlabPairsBefore, input.matlabPairsAfter, [members]);
  addChanged(input.callablePairsBefore, input.callablePairsAfter, [members, recalled]);
  for (const name of input.deltaNames) {
    const b = builtinOf(name);
    if (b !== null) candidates.add(b);
  }
  const mPath = (p: string): boolean => p.toLowerCase().endsWith('.m');
  const reachedByChange = new Set<string>();
  addMatlabReachableNames([...input.addedPaths, ...input.removedPaths].filter(mPath), reachedByChange);
  for (const name of reachedByChange) if (MATLAB_BUILTINS.has(name)) candidates.add(name);
  if ((candidates.size === 0 && members.size === 0) || !queries.hasFilesOfLanguage('matlab')) return noChange();

  const change = noChange();
  change.membersRecalled = [...recalled];
  const namesOf = (pairs: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>();
    for (const pair of pairs) out.add(nameOf(pair));
    return out;
  };
  // Carried before: a node of the name in a file the sync replaced or removed,
  // read before it did, or in one it left alone.
  const carriedBefore = (keys: string[], beforeNames: ReadonlySet<string>, carriers: Map<string, Set<string>>): boolean =>
    keys.some((k) => beforeNames.has(k) || [...(carriers.get(k) ?? [])].some((f) => !input.extracted.has(f)));
  const carriedNow = (keys: string[], carriers: Map<string, Set<string>>): boolean => keys.some((k) => carriers.has(k));

  if (members.size > 0) {
    const keys = [...members].flatMap(matlabNameKeys);
    const any = queries.getFilesCarryingNames(keys, MATLAB_NODES);
    const callable = queries.getFilesCarryingNames(keys, MATLAB_CALLABLE_NODES);
    const anyBefore = namesOf(input.matlabPairsBefore);
    const callableBefore = namesOf(input.callablePairsBefore);
    for (const m of members) {
      const k = matlabNameKeys(m);
      const ab = carriedBefore(k, anyBefore, any);
      const an = carriedNow(k, any);
      const cb = carriedBefore(k, callableBefore, callable);
      const cn = carriedNow(k, callable);
      if ((!ab && an) || (!cb && cn)) change.membersGained.push(m);
      if (ab && !an) change.membersLost.push(m);
      else if (cb && !cn) change.membersUncallable.push(m);
    }
  }

  if (candidates.size === 0) return change;
  // Carried: some node is named for it (a function, a class, a script's `.m`).
  const before = namesOf(input.pairsBefore);
  const carriers = queries.getFilesCarryingNames([...candidates].flatMap(matlabNameKeys));
  // Reached: a `.m` file is named for it, which keeps its calls at extraction.
  const now = queries.getAllFilePaths().filter(mPath);
  const added = new Set(input.addedPaths);
  const reachedNow = new Set<string>();
  addMatlabReachableNames(now, reachedNow);
  const reachedBefore = new Set<string>();
  addMatlabReachableNames([...now.filter((p) => !added.has(p)), ...input.removedPaths.filter(mPath)], reachedBefore);

  for (const b of candidates) {
    const cb = carriedBefore(matlabNameKeys(b), before, carriers);
    const cn = carriedNow(matlabNameKeys(b), carriers);
    const kb = cb && reachedBefore.has(b);
    const kn = cn && reachedNow.has(b);
    if ((!cb && cn) || (!kb && kn)) change.gained.push(b);
    else if (cb && !cn) change.lost.push(b);
    else if (kb && !kn) change.unreached.push(b);
  }
  return change;
}

/** Whether a char code is a word character (`\w`: a letter, a digit or `_`). */
function isWordChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

/** Whether a char code is white space (`\s`). */
function isSpaceChar(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Past this many built-ins' names, the whole-word half of a scan reads every word of the text instead of one pattern of them all. */
const WORD_PATTERN_NAMES = 32;

/**
 * A test of MATLAB text for one of `words` as a whole word, or one of
 * `members` as a member (`.f`, and `@f` / `f@` for a superclass call,
 * `obj@f(x)`, `f@Base(obj)`; space allowed around the `.` or `@`). A member
 * is looked for only where one can stand: each word after a `.` or an `@`,
 * and the word before each `@`, looked up in the set. Its cost is the
 * text's, however many members there are (a sync adding a class of a
 * thousand methods scans as fast as one adding one). The built-ins' names,
 * few, are one pattern; past WORD_PATTERN_NAMES, every word is looked up.
 */
export function matlabNameScan(words: ReadonlySet<string>, members: ReadonlySet<string>): (text: string) => boolean {
  const pattern = words.size > 0 && words.size <= WORD_PATTERN_NAMES ? new RegExp(`\\b(?:${[...words].join('|')})\\b`) : null;
  return (text) => {
    if (pattern) {
      if (pattern.test(text)) return true;
    } else if (words.size > 0) {
      const word = /\w+/g;
      for (let m = word.exec(text); m !== null; m = word.exec(text)) if (words.has(m[0])) return true;
    }
    if (members.size === 0) return false;
    const after = /[.@]\s*(\w+)/g;
    for (let m = after.exec(text); m !== null; m = after.exec(text)) if (members.has(m[1]!)) return true;
    for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
      let e = at - 1;
      while (e >= 0 && isSpaceChar(text.charCodeAt(e))) e--;
      let b = e;
      while (b >= 0 && isWordChar(text.charCodeAt(b))) b--;
      if (e > b && members.has(text.slice(b + 1, e + 1))) return true;
    }
    return false;
  };
}

/**
 * The project's MATLAB files, but `skip`, whose text names one of `names` as
 * a whole word, or one of `members` as a member (see matlabNameScan): one
 * read of each file, for all the names at once.
 */
export function matlabFilesNaming(
  queries: QueryBuilder,
  projectRoot: string,
  names: readonly string[],
  skip: ReadonlySet<string>,
  members: readonly string[],
): Array<{ filePath: string; content: string }> {
  if (names.length === 0 && members.length === 0) return [];
  const scan = matlabNameScan(new Set(names), new Set(members));
  const out: Array<{ filePath: string; content: string }> = [];
  for (const filePath of queries.getFilePathsOfLanguage('matlab')) {
    if (skip.has(filePath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(projectRoot, filePath), 'utf-8');
    } catch {
      continue;
    }
    if (scan(content)) out.push({ filePath, content });
  }
  return out;
}

/** The rows a fresh index would not keep (see MatlabCarrierChange), by id. */
export function uncarriedMatlabRowIds(queries: QueryBuilder, change: MatlabCarrierChange): number[] {
  const ids: number[] = [];
  if (change.lost.length > 0) for (const row of queries.getMatlabCallRowsNamed(change.lost)) ids.push(row.id);
  if (change.unreached.length > 0) {
    const rows = queries.getMatlabCallRowsNamed(change.unreached);
    const keeps = new Map<string, (name: string) => boolean>();
    for (const file of new Set(rows.map((r) => r.filePath))) {
      const nodes = queries.getNodesByFiles([file]);
      const imports = nodes.some((n) => n.kind === 'import' && !isJavaImport(n.name));
      const own = new Set(nodes.map((n) => n.name));
      keeps.set(file, (name) => imports || own.has(name));
    }
    for (const row of rows) if (!keeps.get(row.filePath)!(row.name)) ids.push(row.id);
  }
  // A member call's failed row: every one of a name nothing carries now, and
  // those written without arguments of one no callable symbol does; never
  // one whose name the interpreter built (see ./matlab-failures). (A pending
  // one is resolved and judged by this sync's own passes.)
  const lost = new Set(change.membersLost);
  const uncallable = new Set(change.membersUncallable);
  if (lost.size > 0 || uncallable.size > 0) {
    for (const row of queries.getFailedMatlabCallsByTail([...lost, ...uncallable])) {
      const ref = { ...row, referenceKind: 'calls', language: 'matlab' };
      const call = matlabMemberCall(ref);
      if (call && !matlabRefFacts(ref).computed && (lost.has(call.member) || (call.bare && uncallable.has(call.member)))) ids.push(row.id);
    }
  }
  return ids;
}

/** The failed member-call rows of the members whose callable carriers changed (MatlabCarrierChange.membersRecalled), but `except`, by id. */
export function recalledMatlabRowIds(queries: QueryBuilder, change: MatlabCarrierChange, except: ReadonlySet<number>): number[] {
  if (change.membersRecalled.length === 0) return [];
  const recalled = new Set(change.membersRecalled);
  const ids: number[] = [];
  for (const row of queries.getFailedMatlabCallsByTail(recalled)) {
    if (except.has(row.id)) continue;
    const call = matlabMemberCall({ ...row, referenceKind: 'calls', language: 'matlab' });
    if (call && recalled.has(call.member)) ids.push(row.id);
  }
  return ids;
}

/**
 * The carrier step of a sync, as recorded before it changes anything: the
 * rows it deletes, the failed rows it puts back to pending (resolved by the
 * sync's sweep of pending rows), and the files it extracts again. Stored
 * under MATLAB_CARRIER_STEP_KEY until the step is done; a sync that finds it
 * (one killed in the step went before) finishes it first, and a full index
 * clears it.
 */
export interface MatlabCarrierStep {
  drop: number[];
  reopen: number[];
  files: string[];
}

/** The project metadata key of a MatlabCarrierStep not finished yet. */
export const MATLAB_CARRIER_STEP_KEY = 'matlab_carrier_step_pending';

/** The recorded step, or null when none is (or its record is not one). */
export function readMatlabCarrierStep(queries: QueryBuilder): MatlabCarrierStep | null {
  const text = queries.getMetadata(MATLAB_CARRIER_STEP_KEY);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<MatlabCarrierStep>;
    const ints = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => Number.isInteger(n));
    const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every((f) => typeof f === 'string');
    return ints(v.drop) && ints(v.reopen) && strs(v.files) ? { drop: v.drop, reopen: v.reopen, files: v.files } : null;
  } catch {
    return null;
  }
}

/** Records `step` (see MatlabCarrierStep), or clears the record when given null. */
export function writeMatlabCarrierStep(queries: QueryBuilder, step: MatlabCarrierStep | null): void {
  queries.setMetadata(MATLAB_CARRIER_STEP_KEY, step ? JSON.stringify(step) : '');
}

/** The row half of a step: deletes its rows, and puts its failed ones back to pending. */
export function applyMatlabCarrierRows(queries: QueryBuilder, step: MatlabCarrierStep): void {
  if (step.drop.length > 0) queries.deleteReferencesByRowIds(step.drop);
  if (step.reopen.length > 0) queries.reopenFailedReferences(step.reopen);
}
