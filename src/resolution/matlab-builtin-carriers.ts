/**
 * A MATLAB call that no project function answers is kept only while the
 * project could answer it (see ./matlab-failures), and a sync must end where
 * a fresh index ends when it changes what could.
 *
 * A call of a built-in's name (`disp(3)`, `@beep`) is kept only while the
 * project could answer it: its row is dropped at extraction unless a `.m`
 * file of that name exists (or the file imports, or defines the name
 * itself), and deleted at resolution unless a MATLAB symbol that could
 * answer a bare call carries the name (MATLAB_CALLABLE_NODES: no property,
 * constant, enumeration member or field, nothing of another language; see
 * ../extraction/languages/matlab-builtins). Those rows are written and
 * judged only when their own file is extracted. So a sync that gives a
 * built-in's name its first carrier — the first `.m` file of that name, or
 * the first such symbol of it anywhere (a property turned into a method of
 * the name counts) — writes again the calls of it in the MATLAB files that
 * name it, as their extraction does (a file that imports, or defines the
 * name, is extracted again in full: see addMatlabBuiltinRows in
 * ../extraction), and one
 * that takes the last carrier away, or the last `.m` file of the name,
 * deletes the rows a fresh index would not keep, dormant ones too. (A `.m`
 * file of Octave or binary text carries no name: one whose text turns to
 * MATLAB code, or from it, gives its name a carrier, or takes one, as one
 * added or removed does. An Objective-C `.m` carries none and reaches none:
 * see classifyMatlabBuiltins.) A project seldom names a file or a function
 * after a built-in, so this seldom runs.
 *
 * A built-in's call that only the path could give a copy of is a dormant
 * row (see ../resolution/matlab-failures), and is woken wherever a failed
 * one would be re-opened, to be resolved again: every one when the path
 * moves (see wakeMatlabBuiltinRows), those of a name whose MATLAB
 * definitions a sync changed (matlabDormancyFlips), of a case variant come
 * or gone and of a file turned into a script or a stub (see ./matlab-sync).
 * Resolved again and failing, it is judged as a fresh index judges it.
 *
 * A call on an object a lower-case callee made, under a built-in's name
 * (`disp(g)` after `g = gadget();`, recorded `gadget::disp`: see
 * matlabBuiltinDispatchKept in ./matlab-failures), is kept, dormant, while a
 * class of its callee's name exists (any package, any case) or while a plain
 * call of the built-in's name would be kept, and deleted otherwise. A sync
 * that gives the name its first class writes these calls again in the files
 * the index holds a call of a lower-case callee of the name from
 * (MatlabCarrierChange.classGained, matlabFilesConstructing), parsed and
 * written on their own as a gained built-in's are (addMatlabBuiltinRows in
 * ../extraction); one that takes the
 * last away, or the built-in's last carrier or reach, deletes the rows a
 * fresh index would not keep (uncarriedMatlabRowIds); one that gives the
 * built-in's name a carrier or a reach writes them again with its calls
 * (addMatlabBuiltinRows in ../extraction).
 *
 * Any other call whose row is kept only while a symbol carries its name — a
 * bare read (`c = color;`), a command (`setup_paths`), a name code run at
 * runtime makes, `T::datestr` dispatched under a built-in's name (see
 * matlabUnmatchableKeys in ./matlab-failures), and a member call (`v.f(x)`,
 * `m.Total`, `obj@Base(x)`; see matlabMemberCall), which only MATLAB's
 * symbols carry — only callable ones when written without arguments, and
 * only the ones a dotted call can reach (a method, a class, a package's
 * function, a `.m` file in a class or package folder) when written with —, is
 * never deleted: while nothing carries its name it is a dormant row, which
 * no reader counts, stored under its tail. Every name whose carriers a sync
 * may have changed — whose definition set changed in any language, whose
 * MATLAB, callable MATLAB or member-reachable MATLAB definitions did (a
 * property turned into a method of the same name, a local function turned
 * into a classdef method), the name of a `.m` file whose text turned to
 * MATLAB code or from it (MatlabCarrierChange.judged) — has its dormant and
 * failed rows judged again, by the resolver's own rule (see
 * matlabDormancyFlips): a dormant row the name now has a carrier for wakes,
 * and the sync's sweep links it or parks it failed; a failed one it has none
 * for any more goes dormant. That is three probes of the node names (which
 * of the names any node carries, which a callable MATLAB one does, and which
 * one a member call can reach does) and two lookups of rows by tail (the
 * dormant ones of the names some node carries, the failed ones of the names
 * no callable MATLAB symbol carries or whose MATLAB definitions changed),
 * however many files name the word, and no file is read for it. (An edge
 * to a carrier the sync removes goes back to a reference, which the sweep
 * resolves and, failing, keeps dormant, wherever it is.)
 *
 * And a name whose MATLAB definitions a sync changed at all
 * (MatlabCarrierChange.relinked) has its failed rows resolved again, every
 * one of them (no ceiling, as the sync's retry of failed rows has): which
 * function, class or method answers a row decides its edge, and a fresh
 * index links each by where the definitions are now. Their failed rows are
 * read by the second lookup, which takes these names too.
 *
 * The step is recorded before it changes anything (see MatlabCarrierStep):
 * a sync killed in it leaves the record, and the next sync finishes it
 * before it does anything else. What the step is worked out from is
 * recorded too, before the sync replaces or removes a file (see
 * MatlabCarrierInputs): a sync killed after it stored its files and before
 * its step leaves that, and the next sync, or a full index, works the step
 * out from it first (see replayedMatlabCarrierChanges). The replay judges
 * every name the recorded files had or have, which is more rows looked up
 * and resolved again than the killed sync would have, and never another
 * answer; but a built-in's name it classifies as the killed sync would
 * have, by the carriers and reach the record says it had before and the
 * ones it has now, so it reads only the files naming a built-in that sync
 * gave its first carrier or reach. Neither replay touches a file that
 * changed on disk since it was stored, or went: that file is the replaying
 * sync's own to extract or remove.
 *
 * An index built before dormant rows were kept has none: a sync of it wakes
 * nothing, and a bare read or a member call it dropped then stays dropped
 * until the project is indexed again.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DORMANT_REF_STATUS, type QueryBuilder } from '../db/queries';
import { MATLAB_BUILTINS, addMatlabReachableNames, isMatlabLowerConstructorName } from '../extraction/languages/matlab-builtins';
import { isJavaImport } from '../extraction/languages/matlab-java';
import { MATLAB_CALLABLE_NODES, MATLAB_MEMBER_NODES, isMatlabBuiltinCall, isMatlabBuiltinDispatchCall, matlabBuiltinDispatchKept, matlabDispatchClassKey, matlabNameKeys, unanswerableMatlabFailures } from './matlab-failures';

/** What a sync changed of the project's symbols and files, as the extraction step of a sync knows it. */
export interface MatlabCarrierInput {
  /** The names whose definition set the sync changed (added to or taken from a file), in any language. */
  deltaNames: ReadonlySet<string>;
  /** The files the sync extracted (their nodes are the new ones now). */
  extracted: ReadonlySet<string>;
  addedPaths: readonly string[];
  removedPaths: readonly string[];
  /**
   * `file\0name\0facts` of every MATLAB node (MATLAB_NODES) of the files
   * the sync replaced or removed, read before, with what another file's
   * resolution reads of the name's definitions there (see
   * QueryBuilder.getNodeFactPairsByFiles): a function file turned into a
   * script, or a method made static, changes a pair with no name.
   */
  matlabPairsBefore: ReadonlySet<string>;
  /** The same of the files the sync extracted, read after. */
  matlabPairsAfter: ReadonlySet<string>;
  /**
   * `file\0name` of every callable MATLAB node (MATLAB_CALLABLE_NODES) of
   * those files, read before: the carriers of a built-in's name among them.
   */
  callablePairsBefore: ReadonlySet<string>;
  /** The same of the files the sync extracted, read after. */
  callablePairsAfter: ReadonlySet<string>;
  /**
   * `file\0name` of every MATLAB node a member call written with arguments
   * can reach (MATLAB_MEMBER_NODES) of those files, read before: a local
   * function turned into a classdef method of the same name, in one file,
   * changes these alone.
   */
  memberPairsBefore: ReadonlySet<string>;
  /** The same of the files the sync extracted, read after. */
  memberPairsAfter: ReadonlySet<string>;
  /**
   * Of the files the sync replaced or removed, the ones whose text had been
   * read as no MATLAB code (Octave, a binary: see MATLAB_CARRIER_NODES in
   * ./matlab-failures), read before it did. None of their nodes carried a
   * name then, and no name is reached through them.
   */
  unreadBefore: ReadonlySet<string>;
  /**
   * Of the files the sync replaced or removed, the `.m` files of MATLAB code
   * (not an Objective-C `.m`, none of Octave or binary text), read before it
   * did: the ones whose names reached a built-in's call (see
   * classifyMatlabBuiltins).
   */
  reachingBefore: ReadonlySet<string>;
}

export interface MatlabCarrierChange {
  /** The built-ins' names a MATLAB call's row is kept for now and was not before: their calls in the files naming them are written again. */
  gained: string[];
  /** The built-ins' names no symbol carries any more: every row of a call of the name goes. */
  lost: string[];
  /** The ones still carried that no `.m` file is named for any more: a row goes unless its file imports, or defines the name. */
  unreached: string[];
  /**
   * The names whose carriers the sync may have changed (see the top of this
   * file): their dormant and failed rows are judged again (see
   * matlabDormancyFlips). Built-ins' names among them too: a built-in's row
   * is never dormant, so the judge puts none of theirs to sleep, and only
   * reopens a failed one of a name in `relinked`; the fields above are
   * their own path.
   */
  judged: string[];
  /**
   * Of those, the names whose MATLAB definitions the sync changed (a
   * function, a method, a `.m` file, a property turned into a method of the
   * same name, a `.m` file whose text turned to MATLAB code or from it):
   * which symbol a failed row of one links to may have changed, so every
   * one is resolved again (no ceiling, as the sync's retry of failed rows
   * has). A MATLAB call resolves to MATLAB's symbols alone, so another
   * language's definition changes only whether a row sleeps.
   */
  relinked: string[];
  /**
   * The names, lowered, that a MATLAB class or enum now has and none had
   * before (in any package, any case: `gadget` for a `@gadget` constructor or
   * a `classdef Gadget` come): the calls on an object a lower-case callee of
   * the name made under a built-in's name (`disp(g)` after `g = gadget();`,
   * see matlabBuiltinDispatchKept in ./matlab-failures), which a fresh index
   * keeps while such a class exists, are written again in the MATLAB files
   * that hold a call of such a callee (matlabFilesConstructing), as their
   * extraction does.
   */
  classGained: string[];
  /** The names, lowered, that no MATLAB class or enum has any more: those calls of the files that keep them are judged again, and the ones a fresh index would not keep deleted. */
  classLost: string[];
}

const noChange = (): MatlabCarrierChange => ({ gained: [], lost: [], unreached: [], judged: [], relinked: [], classGained: [], classLost: [] });

/** The lowered names of the classes and enums among `file\0name\0facts` pairs (see MatlabCarrierInput.matlabPairsBefore). */
function classKeysOf(pairs: Iterable<string>, into: Set<string>): void {
  for (const pair of pairs) {
    const facts = pair.slice(pair.indexOf('\0', pair.indexOf('\0') + 1) + 1);
    if (facts.split(';').some((f) => f.startsWith('class|') || f.startsWith('enum|'))) into.add(nameOf(pair).toLowerCase());
  }
}

/**
 * Which of the lowered names `keys` a sync gave a first class or took the
 * last one from, into `change` (classGained, classLost): before, a class of
 * the name stood in a file the sync left alone, or in one it changed, by
 * that file's pairs (`before`); now, the index says. With no `before` (a
 * replay from a record, which keeps no kinds), every name with a class now
 * is called gained, and every other lost: more files written again and more
 * rows judged than the killed sync would have, and never another answer.
 */
function classifyMatlabClassKeys(queries: QueryBuilder, keys: ReadonlySet<string>, changed: ReadonlySet<string>, before: ReadonlySet<string> | null, change: MatlabCarrierChange): void {
  if (keys.size === 0) return;
  const now = queries.getMatlabClassFilesByLowerName(keys);
  for (const k of keys) {
    const files = now.get(k);
    const was = before === null ? files === undefined : before.has(k) || [...(files ?? [])].some((f) => !changed.has(f));
    if (!was && files !== undefined) change.classGained.push(k);
    else if (was && files === undefined) change.classLost.push(k);
  }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A `file\0name` pair's name (of a `file\0name\0facts` one too: see MatlabCarrierInput.matlabPairsBefore). */
const nameOf = (pair: string): string => {
  const start = pair.indexOf('\0') + 1;
  const end = pair.indexOf('\0', start);
  return end < 0 ? pair.slice(start) : pair.slice(start, end);
};

/** A symbol's or a `.m` file's name as the name a call is parked under (`f.m` → `f`), or null when no call can be. */
function stemOf(name: string): string | null {
  const stem = /^(.+)\.[mM]$/.exec(name)?.[1] ?? name;
  return IDENTIFIER.test(stem) ? stem : null;
}

const mPath = (p: string): boolean => p.toLowerCase().endsWith('.m');

/** The built-in's name a node's (or a script file's: `beep.m`) name is, or null. */
function builtinOf(name: string): string | null {
  if (MATLAB_BUILTINS.has(name)) return name;
  const stem = /^(.+)\.[mM]$/.exec(name)?.[1];
  return stem !== undefined && MATLAB_BUILTINS.has(stem) ? stem : null;
}

/** Which built-in, member and other carried names a sync gave a first carrier, or took the last one from, or may have (see the top of this file). */
export function matlabCarrierChanges(queries: QueryBuilder, input: MatlabCarrierInput): MatlabCarrierChange {
  const candidates = new Set<string>();
  // Every name a carrier of some class may have come or gone for: a name
  // whose definition set changed in any language, or whose MATLAB, callable
  // MATLAB or member-reachable MATLAB one did (a property turned into a
  // method keeps its names, a local function turned into a method its
  // callable ones), as a symbol's (`f`) and as a `.m` file's (`f.m`); and the
  // ones whose MATLAB definitions of any of the three changed (`relinked`).
  const judged = new Set<string>();
  const relinked = new Set<string>();
  const judge = (name: string): void => {
    const stem = stemOf(name);
    if (stem !== null) judged.add(stem);
  };
  const addChanged = (a: ReadonlySet<string>, b: ReadonlySet<string>, into: Set<string> | null, carriers = false): void => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      for (const pair of x) {
        if (y.has(pair)) continue;
        // A built-in's carrier come or gone (a property turned into a method
        // of its name changes no definition set): a candidate below.
        const builtin = carriers ? builtinOf(nameOf(pair)) : null;
        if (builtin !== null) candidates.add(builtin);
        const stem = stemOf(nameOf(pair));
        if (stem === null) continue;
        judged.add(stem);
        into?.add(stem);
      }
    }
  };
  addChanged(input.matlabPairsBefore, input.matlabPairsAfter, relinked);
  addChanged(input.callablePairsBefore, input.callablePairsAfter, relinked, true);
  addChanged(input.memberPairsBefore, input.memberPairsAfter, relinked);
  for (const name of input.deltaNames) {
    judge(name);
    const b = builtinOf(name);
    if (b !== null) candidates.add(b);
  }
  // A `.m` file whose text turned to MATLAB code, or from it (an Octave
  // `datestr.m` rewritten), carries its name, or stops: its name changes as
  // one added or removed does.
  const removed = new Set(input.removedPaths);
  const extractedM = [...input.extracted].filter((p) => mPath(p) && !removed.has(p));
  const unreadNow = extractedM.length > 0 ? queries.getUnreadMatlabFilePaths() : new Set<string>();
  const turned = extractedM.filter((p) => input.unreadBefore.has(p) !== unreadNow.has(p));
  for (const p of turned) {
    judge(path.basename(p));
    const stem = stemOf(path.basename(p));
    if (stem !== null) relinked.add(stem);
  }
  const reachedByChange = new Set<string>();
  addMatlabReachableNames([...input.addedPaths, ...input.removedPaths, ...turned].filter(mPath), reachedByChange);
  for (const name of reachedByChange) if (MATLAB_BUILTINS.has(name)) candidates.add(name);
  const classesBefore = new Set<string>();
  classKeysOf(input.matlabPairsBefore, classesBefore);
  const classKeys = new Set(classesBefore);
  classKeysOf(input.matlabPairsAfter, classKeys);
  if ((candidates.size === 0 && judged.size === 0 && classKeys.size === 0) || !queries.hasFilesOfLanguage('matlab')) return noChange();

  const change = noChange();
  change.judged = [...judged];
  change.relinked = [...relinked];
  const changed = new Set([...input.extracted, ...input.removedPaths]);
  classifyMatlabClassKeys(queries, classKeys, changed, classesBefore, change);
  if (candidates.size === 0) return change;
  // The callable pairs were read with MATLAB_CALLABLE_NODES before the sync
  // changed the files: none of a file whose text was read as no MATLAB code.
  const carriedBefore = new Set<string>();
  for (const pair of input.callablePairsBefore) carriedBefore.add(nameOf(pair));
  classifyMatlabBuiltins(queries, candidates, { changed, carriedBefore, reachingBefore: [...input.reachingBefore] }, change);
  return change;
}

/**
 * What the project held before a change, of the files it changed, for
 * classifyMatlabBuiltins: the names their callable MATLAB nodes carried
 * (MATLAB_CALLABLE_NODES: none of a file whose text was read as no MATLAB
 * code), and the ones of them that were `.m` files of MATLAB code. The index
 * holds the rest as they were.
 */
interface MatlabBuiltinsBefore {
  changed: ReadonlySet<string>;
  carriedBefore: ReadonlySet<string>;
  reachingBefore: readonly string[];
}

/**
 * Which of the built-ins' names `candidates` a change gave a first carrier
 * or reach, or took them from, into `change` (gained, lost, unreached), by
 * the rules a fresh index keeps a built-in's call by, before and now:
 * carried, some callable MATLAB node is named for it (the resolver's,
 * MATLAB_CALLABLE_NODES: a function, a method, a class, a script's `.m`;
 * no property, nothing of another language, none of a file whose text is no
 * MATLAB code); reached, a `.m` file of MATLAB code is
 * named for it (the extraction's, see MatlabInsertFilter: an Objective-C
 * `.m` reaches none), which keeps its calls at extraction. A candidate
 * whose carriers and reach did not change is none of the three.
 */
function classifyMatlabBuiltins(queries: QueryBuilder, candidates: ReadonlySet<string>, before: MatlabBuiltinsBefore, change: MatlabCarrierChange): void {
  const carriers = queries.getFilesCarryingNames([...candidates].flatMap(matlabNameKeys), MATLAB_CALLABLE_NODES);
  const carriedBefore = (keys: string[]): boolean =>
    keys.some((k) => before.carriedBefore.has(k) || [...(carriers.get(k) ?? [])].some((f) => !before.changed.has(f)));
  const carriedNow = (keys: string[]): boolean => keys.some((k) => carriers.has(k));
  const unread = queries.getUnreadMatlabFilePaths();
  const reachingNow = queries.getFilePathsOfLanguage('matlab').filter((p) => mPath(p) && !unread.has(p));
  const reachedNow = new Set<string>();
  addMatlabReachableNames(reachingNow, reachedNow);
  const reachedBefore = new Set<string>();
  addMatlabReachableNames([...reachingNow.filter((p) => !before.changed.has(p)), ...before.reachingBefore], reachedBefore);
  for (const b of candidates) {
    const cb = carriedBefore(matlabNameKeys(b));
    const cn = carriedNow(matlabNameKeys(b));
    const kb = cb && reachedBefore.has(b);
    const kn = cn && reachedNow.has(b);
    if ((!cb && cn) || (!kb && kn)) change.gained.push(b);
    else if (cb && !cn) change.lost.push(b);
    else if (kb && !kn) change.unreached.push(b);
  }
}

/**
 * What a sync's carrier step is worked out from, recorded before the sync
 * replaces or removes a file (see MATLAB_CARRIER_INPUTS_KEY): the files it
 * changes; the names their nodes carried (none of a file whose text was
 * read as no MATLAB code), and the ones of them their callable MATLAB nodes
 * carried (`callable`, see MatlabBuiltinsBefore); and the ones of them that
 * were `.m` files of MATLAB code (`reaching`). A sync killed after it stored
 * the files and before its carrier step leaves it, and the next sync (or a
 * full index) works the step out from it (see replayedMatlabCarrierChanges).
 */
export interface MatlabCarrierInputs {
  files: string[];
  names: string[];
  callable: string[];
  reaching: string[];
}

/** The project metadata key of the MatlabCarrierInputs of a sync whose carrier step is not worked out yet. */
export const MATLAB_CARRIER_INPUTS_KEY = 'matlab_carrier_inputs_pending';

/**
 * The recorded inputs, or null when none are. A record that is not one
 * (of a format this build does not read) reads as empty: it calls for no
 * step, and the caller clears it. One with no `reaching` (written by an
 * earlier build of this record) reads as one none of whose files reached a
 * name before: a built-in carried and reached now may then be called
 * gained, and the files naming it extracted again, which is more work and
 * never another answer. One with no `callable` (written by a build that
 * counted every node a carrier) reads its `names` for it, as that build
 * would have.
 */
export function readMatlabCarrierInputs(queries: QueryBuilder): MatlabCarrierInputs | null {
  const text = queries.getMetadata(MATLAB_CARRIER_INPUTS_KEY);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<MatlabCarrierInputs>;
    const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every((f) => typeof f === 'string');
    const reaching = v.reaching ?? [];
    const callable = v.callable ?? v.names;
    if (strs(v.files) && strs(v.names) && strs(callable) && strs(reaching)) return { files: v.files, names: v.names, callable, reaching };
  } catch {
    // Not JSON: as empty.
  }
  return { files: [], names: [], callable: [], reaching: [] };
}

/** Records `inputs` (see MatlabCarrierInputs), or clears the record when given null. */
export function writeMatlabCarrierInputs(queries: QueryBuilder, inputs: MatlabCarrierInputs | null): void {
  queries.setMetadata(MATLAB_CARRIER_INPUTS_KEY, inputs ? JSON.stringify(inputs) : '');
}

/**
 * The carrier step of a sync that was killed before it worked it out (see
 * MatlabCarrierInputs), from the record and what the index holds now. The
 * names judged are every one the recorded files' nodes had or have, and
 * their `.m` names, all of them relinked: judging a name whose carriers did
 * not change, and resolving its failed rows again, changes nothing a fresh
 * index would not have. A built-in's name among them is classified as the
 * killed sync would have (classifyMatlabBuiltins), by its carriers (the
 * record's `callable`) and reach before, from the record, and now: gained
 * only if it had no carrier, or
 * no carrier and reach together, before and has now; lost only if it had
 * a carrier and has none.
 */
export function replayedMatlabCarrierChanges(queries: QueryBuilder, inputs: MatlabCarrierInputs): MatlabCarrierChange {
  if (!queries.hasFilesOfLanguage('matlab')) return noChange();
  const names = new Set(inputs.names);
  for (const pair of queries.getNodeNamePairsByFiles(inputs.files)) names.add(nameOf(pair));
  const files = inputs.files.filter(mPath);
  for (const p of files) names.add(path.basename(p));
  const judged = new Set<string>();
  const candidates = new Set<string>();
  for (const name of names) {
    const stem = stemOf(name);
    if (stem !== null) judged.add(stem);
    const b = builtinOf(name);
    if (b !== null) candidates.add(b);
  }
  const reachedByChange = new Set<string>();
  addMatlabReachableNames(files, reachedByChange);
  for (const name of reachedByChange) if (MATLAB_BUILTINS.has(name)) candidates.add(name);
  const change = noChange();
  change.judged = [...judged];
  change.relinked = [...judged];
  classifyMatlabClassKeys(queries, new Set([...names].flatMap((n) => {
    const stem = stemOf(n);
    return stem === null ? [] : [stem.toLowerCase()];
  })), new Set(inputs.files), null, change);
  if (candidates.size === 0) return change;
  classifyMatlabBuiltins(queries, candidates, {
    changed: new Set(inputs.files), carriedBefore: new Set(inputs.callable), reachingBefore: inputs.reaching,
  }, change);
  return change;
}

/** Past this many built-ins' names, a scan reads every word of the text instead of one pattern of them all. */
const WORD_PATTERN_NAMES = 32;

/**
 * A test of MATLAB text for one of `words` as a whole word. The built-ins'
 * names, few, are one pattern; past WORD_PATTERN_NAMES, every word is
 * looked up.
 */
export function matlabNameScan(words: ReadonlySet<string>): (text: string) => boolean {
  const pattern = words.size > 0 && words.size <= WORD_PATTERN_NAMES ? new RegExp(`\\b(?:${[...words].join('|')})\\b`) : null;
  return (text) => {
    if (pattern) return pattern.test(text);
    if (words.size === 0) return false;
    const word = /\w+/g;
    for (let m = word.exec(text); m !== null; m = word.exec(text)) if (words.has(m[0])) return true;
    return false;
  };
}

/**
 * The project's MATLAB files, but `skip`, whose text names one of `names` as
 * a whole word (see matlabNameScan): one read of each file, for all the
 * names at once.
 */
export function matlabFilesNaming(
  queries: QueryBuilder,
  projectRoot: string,
  names: readonly string[],
  skip: ReadonlySet<string>,
): Array<{ filePath: string; content: string }> {
  if (names.length === 0) return [];
  const scan = matlabNameScan(new Set(names));
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

/**
 * The project's MATLAB files, but `skip`, that may hold a call on an object
 * a lower-case callee of one of `keys` (lowered names) made, under a
 * built-in's name (`disp(g)` after `g = gadget();`: see
 * MatlabCarrierChange.classGained): the ones the index holds a call of such
 * a callee from, a row of it of any status or an edge. The construction is
 * a call itself, which the extraction stores wherever it reads the hint (see
 * lowerConstructions in ../extraction/languages/matlab): written `gadget`,
 * `gAdget` or `Cls::gadget` (`g = gadget(obj)`), in no case a built-in's
 * name. No file is read.
 */
export function matlabFilesConstructing(queries: QueryBuilder, keys: readonly string[], skip: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  for (const { filePath, name } of queries.getMatlabCallsOfLowerNames(keys)) {
    if (skip.has(filePath) || out.has(filePath)) continue;
    const tail = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
    if (isMatlabLowerConstructorName(/^(.+)\.[mM]$/.exec(tail)?.[1] ?? tail)) out.add(filePath);
  }
  return out;
}

/**
 * The built-ins' rows a fresh index would not keep (see MatlabCarrierChange),
 * dormant ones too, by id. With them, the failed and dormant calls on an
 * object a lower-case callee made under a built-in's name (`gadget::disp`)
 * whose callee's name lost its last class, or whose built-in's name lost its
 * last carrier or reach, that a fresh index would not keep (see
 * matlabBuiltinDispatchKept in ./matlab-failures).
 */
export function uncarriedMatlabRowIds(queries: QueryBuilder, change: MatlabCarrierChange): number[] {
  const ids: number[] = [];
  const tails = new Set([...change.lost, ...change.unreached]);
  const keys = new Set(change.classLost);
  if (tails.size > 0 || keys.size > 0) {
    const rows = queries.getMatlabArgClassDispatchRows().filter((ref) =>
      isMatlabBuiltinDispatchCall(ref) && (keys.has(matlabDispatchClassKey(ref)) || tails.has(ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2))));
    const kept = matlabBuiltinDispatchKept(rows, queries);
    for (const ref of rows) if (!kept.has(ref)) ids.push(ref.rowId);
  }
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
  return [...new Set(ids)];
}

/**
 * The rows whose names a sync may have given a carrier or taken one from
 * (MatlabCarrierChange.judged), judged again by the resolver's own rule (see
 * unanswerableMatlabFailures in ./matlab-failures), as a fresh index judges
 * them: a dormant one a symbol now answers to wake, back to pending for the
 * sync's sweep, which links it or parks it failed; a failed one no symbol
 * answers now to sleep, dormant. And a failed one of a name whose MATLAB
 * definitions changed (MatlabCarrierChange.relinked) that stays answered to
 * reopen, to pending as well, every one: the symbol it links to may be
 * another now. A built-in's call is no such judge's: whether it sleeps asks
 * where its copies stand, which only resolving it tells, so its dormant and
 * failed rows of a relinked name are woken and reopened, every one, and
 * judged once the sweep has failed them again (a carrier gone is the
 * classification's: see uncarriedMatlabRowIds). A pending one is the sync's
 * own passes' to judge. By id.
 */
export function matlabDormancyFlips(queries: QueryBuilder, change: MatlabCarrierChange): { wake: number[]; sleep: number[]; reopen: number[] } {
  if (change.judged.length === 0) return { wake: [], sleep: [], reopen: [] };
  // Only a name some node carries now can wake a row (every class's
  // carriers are nodes of that name), and none a MATLAB symbol a member call
  // can reach carries can put one to sleep (it is a carrier of every class:
  // such a node is a callable one, and a callable one a node). A callable
  // one no member call reaches (a plain function `X`) answers every class
  // but a member call written with arguments (`v.X(1)`): a failed one of
  // those is judged too. Its failed rows are read only when the name is
  // relinked, though, as they were before: a member call's carriers are
  // MATLAB nodes, whose every change relinks the name (see
  // matlabCarrierChanges), so one judged only for another language's
  // definitions keeps its member calls as they were. The dormant rows of
  // the others are not read, and the failed ones only to reopen.
  const keys = change.judged.flatMap(matlabNameKeys);
  const named = queries.getNodeNamesAmong(keys);
  const callable = queries.getNodeNamesAmong(keys.filter((k) => named.has(k)), MATLAB_CALLABLE_NODES);
  const member = queries.getNodeNamesAmong(keys.filter((k) => callable.has(k)), MATLAB_MEMBER_NODES);
  const carried = (tail: string, by: ReadonlySet<string>): boolean => matlabNameKeys(tail).some((k) => by.has(k));
  const answersAll = (tail: string): boolean => carried(tail, member);
  const relinked = new Set(change.relinked);
  const asleep = queries.getMatlabCallRefsByTail(change.judged.filter((t) => carried(t, named)), DORMANT_REF_STATUS);
  const failed = queries.getMatlabCallRefsByTail(change.judged.filter((t) => relinked.has(t) || !carried(t, callable)), 'failed');
  if (asleep.length === 0 && failed.length === 0) return { wake: [], sleep: [], reopen: [] };
  // A call on an object under a built-in's name (`gadget::disp`) is judged as a built-in's call is: by resolving it.
  const builtin = (ref: (typeof asleep)[number]): boolean => isMatlabBuiltinCall(ref) || isMatlabBuiltinDispatchCall(ref);
  const judgeable = failed.filter((ref) => !builtin(ref) && !answersAll(ref.nameTail));
  const { dormant } = unanswerableMatlabFailures([...asleep.filter((ref) => !builtin(ref)), ...judgeable], undefined, null, queries);
  return {
    wake: asleep.filter((ref) => (builtin(ref) ? relinked.has(ref.nameTail) : !dormant.has(ref))).map((ref) => ref.rowId),
    sleep: judgeable.filter((ref) => dormant.has(ref)).map((ref) => ref.rowId),
    reopen: failed.filter((ref) => relinked.has(ref.nameTail) && !dormant.has(ref)).map((ref) => ref.rowId),
  };
}

/**
 * Wakes the dormant rows of a built-in's call (see ../resolution/matlab-failures)
 * named one of `names`, or every one when `names` is null, outside the files
 * in `skip`: back to pending, for the sync's sweep to resolve again where a
 * failed one is re-opened (a path that moved, a case variant come or gone, a
 * file turned into a script or a stub: see ./matlab-sync). Only such a row
 * asks where a project copy stands; the other dormant classes go by
 * carriers alone. Returns the rows woken.
 */
export function wakeMatlabBuiltinRows(queries: QueryBuilder, names: Iterable<string> | null, skip?: ReadonlySet<string>): number {
  const tails = names === null ? [...MATLAB_BUILTINS] : [...names].filter((n) => MATLAB_BUILTINS.has(n));
  if (tails.length === 0) return 0;
  // A call on an object under a built-in's name (`Widget::plot`) too: its plain call's answer moves with these.
  const ids = queries.getMatlabCallRefsByTail(tails, DORMANT_REF_STATUS)
    .filter((ref) => (isMatlabBuiltinCall(ref) || isMatlabBuiltinDispatchCall(ref)) && !skip?.has(ref.filePath))
    .map((ref) => ref.rowId);
  return ids.length > 0 ? queries.setMatlabDormancy(ids, []) : 0;
}

/**
 * The carrier step of a sync, as recorded before it changes anything: the
 * rows it deletes, the failed rows it puts back to pending (resolved by the
 * sync's sweep of pending rows), the dormant rows it wakes (to pending, as
 * well) and the failed ones it puts to sleep (see matlabDormancyFlips), and
 * the files it extracts again. Stored under MATLAB_CARRIER_STEP_KEY until
 * the step is done; a sync that finds it (one killed in the step went
 * before) finishes it first, and a full index clears it. A record written
 * before dormant rows were kept has no `wake` or `sleep`: none.
 */
export interface MatlabCarrierStep {
  drop: number[];
  reopen: number[];
  wake: number[];
  sleep: number[];
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
    const wake = v.wake ?? [];
    const sleep = v.sleep ?? [];
    return ints(v.drop) && ints(v.reopen) && ints(wake) && ints(sleep) && strs(v.files)
      ? { drop: v.drop, reopen: v.reopen, wake, sleep, files: v.files }
      : null;
  } catch {
    return null;
  }
}

/** Records `step` (see MatlabCarrierStep), or clears the record when given null. */
export function writeMatlabCarrierStep(queries: QueryBuilder, step: MatlabCarrierStep | null): void {
  queries.setMetadata(MATLAB_CARRIER_STEP_KEY, step ? JSON.stringify(step) : '');
}

/** The row half of a step: deletes its rows, puts its failed ones back to pending, and wakes and puts to sleep its dormant and failed ones. Each change is a no-op done again. */
export function applyMatlabCarrierRows(queries: QueryBuilder, step: MatlabCarrierStep): void {
  if (step.drop.length > 0) queries.deleteReferencesByRowIds(step.drop);
  if (step.reopen.length > 0) queries.reopenFailedReferences(step.reopen);
  if (step.wake.length > 0 || step.sleep.length > 0) queries.setMatlabDormancy(step.wake, step.sleep);
}
