/**
 * The variables a MATLAB script leaves in the workspace that runs it.
 *
 * A script has no workspace of its own: it runs in its caller's, a
 * function's or another script's, and every variable it assigns and every
 * `global` it declares is then one of the caller's. Code that starts with a
 * script of globals and indexes them is common:
 *
 *     function analorb(SectorList)
 *     alsglobe                      % a script: `global ... IDXgolden ...`
 *     Xerr = x - IDXgolden(IDBPMelem);
 *
 * Nothing in the project carries `IDXgolden`, and it is written with
 * arguments, so a resolution pass parks it as failed, a call leaving the
 * index (see ./matlab-failures). It is the script's variable. This pass keeps
 * such a row dormant instead, which no reader counts, by this rule:
 *
 *   - the row is a bare name's call (isMatlabPlainCall) whose name no node
 *     carries (matlabCarriedKeys): a row with a carrier resolves or fails as
 *     resolution decides, untouched here;
 *   - its scope (the node the row is from: a function, a method, `file:<p>`
 *     for a script's top level) has a call into a script's file node
 *     (isMatlabScriptFile) strictly before it, by line and then column. Text
 *     order is what counts: a run later in a loop does not, and the row
 *     stays failed. A nested function does not inherit its parent's runs;
 *   - and that script makes the name: it is in its top level's variables
 *     (matlabScriptMadeNames: assignments of any form, `for` and `catch`
 *     variables, `global`, a `load f a b` list; none a `clear` removes, and
 *     only those after the last `clear` that may remove more than it names),
 *     or made by a script it runs through its own calls into script file nodes,
 *     wherever they are in it, through at most MATLAB_SCRIPT_RUN_DEPTH
 *     scripts counting the first, cycles stopped.
 *
 * A run counts only in the workspace it runs in: a call whose reference
 * carried the `runtime` fact (`evalin('base', 's')`, which runs `s` in
 * another workspace) is no run of its scope; `eval('s')` runs `s` where it
 * is, and counts. A callback given as text is a reference, no call, and runs
 * later in the base workspace: never a run.
 *
 * What a script file is to the pass (a script or not, and the names its own
 * text makes) is kept in a MatlabScriptMemo by the file's path and stored
 * content hash, so a pass reads and parses only the scripts whose text it
 * has not seen. A script over MATLAB_SCRIPT_MAX_BYTES is not read: it makes
 * no name, and the scripts it runs are not followed. One that does not parse
 * cleanly, cannot be read, or whose text is no MATLAB code (Octave, a
 * binary) makes no name either: its callers' rows stay failed.
 *
 * The pass runs last in every full index and every sync, and sets every such
 * row's status from scratch, both ways: failed to dormant, and dormant back
 * to failed when the rule no longer holds (the script lost the name, the run
 * went, the file stopped being a script). Nothing else makes a row of this
 * shape dormant, so a row of it is dormant if and only if the rule holds,
 * and a sync ends with the statuses a fresh index of the same files has,
 * whatever an earlier build or an interrupted run left. Its dormant rows are
 * stored under their name (the tail of a bare name), the key the carrier step
 * (./matlab-builtin-carriers) wakes a dormant row by when the name gets a
 * carrier; a row woken and failed again is judged here again. No edge is
 * added or removed.
 */

import { DORMANT_REF_STATUS, type QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { matlabScriptMadeNames } from '../extraction/languages/matlab';
import { matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { indexedMatlabScriptLookup, isMatlabScriptFile } from '../graph/matlab-scripts';
import { hashContent, readSourceText } from '../file-limits';
import { validatePathWithinRoot } from '../utils';
import { isMatlabPlainCall, matlabCarriedKeys, matlabNameKeys } from './matlab-failures';

/**
 * How many scripts deep the names a run makes are followed, the one the
 * scope runs counting as the first: a scope runs `s1`, `s1` runs `s2`, and
 * so on to the eighth. A name only a script further down makes is not
 * seen, and its rows stay failed.
 */
export const MATLAB_SCRIPT_RUN_DEPTH = 8;

/**
 * The largest script, in bytes, whose names are read: a larger one makes
 * none (its callers' rows stay failed), which bounds the one stretch the pass
 * cannot yield in, a script's parse and scan. About three times the largest
 * script physbase runs (41 KB).
 */
export const MATLAB_SCRIPT_MAX_BYTES = 128 * 1024;

/** How many script files a MatlabScriptMemo keeps; past it, the one least recently asked for goes. */
export const MATLAB_SCRIPT_MEMO_ENTRIES = 10_000;

/** Rows changed per write, with a yield between. */
const WRITE_CHUNK = 500;

/** What a script file is to the pass: whether it is a script MATLAB runs by its name (isMatlabScriptFile), and the names its own text makes. */
export interface MatlabScriptEntry {
  readonly script: boolean;
  readonly names: ReadonlySet<string>;
}

const NO_NAMES: ReadonlySet<string> = new Set();
const NOT_A_SCRIPT: MatlabScriptEntry = { script: false, names: NO_NAMES };

/**
 * Script files as passes found them, by path and the content hash the files
 * table stores for it: both the verdict and the names are read off that text
 * and the nodes extraction made of it, so an entry cannot go stale — an edit
 * is a new hash, and a file deleted and added back with other text is
 * another key. One entry per path, its latest text's: an edit replaces the
 * file's entry, so a server that sees a script edited many times keeps one.
 * It outlives a pass (the resolver keeps one for its life, past
 * clearCaches), and holds at most `limit` entries, least recently asked for
 * dropped first. Only what was read off text that hashes to the stored hash
 * goes in: never a failed read, nor a file edited since it was indexed.
 */
export class MatlabScriptMemo {
  /** By path: the content hash the entry was read off, and the entry. */
  private readonly entries = new Map<string, { hash: string; entry: MatlabScriptEntry }>();

  constructor(private readonly limit = MATLAB_SCRIPT_MEMO_ENTRIES) {}

  get size(): number {
    return this.entries.size;
  }

  get(filePath: string, contentHash: string): MatlabScriptEntry | undefined {
    const held = this.entries.get(filePath);
    if (!held || held.hash !== contentHash) return undefined;
    this.entries.delete(filePath);
    this.entries.set(filePath, held);
    return held.entry;
  }

  set(filePath: string, contentHash: string, entry: MatlabScriptEntry): void {
    this.entries.delete(filePath);
    while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(filePath, { hash: contentHash, entry });
  }
}

/** What one pass did, for timings and tests. */
export interface MatlabScriptWorkspaceStats {
  /** Script runs read (calls into MATLAB file nodes), those run in another workspace left out. */
  runs: number;
  /** Rows read: the dormant ones of the shape, and the failed ones of bare names in scopes that run a file. */
  read: number;
  /** Of those, the rows of the shape judged (isMatlabPlainCall, no carrier). */
  rows: number;
  /** Script files read from disk (none the memo had), and of them, those parsed. */
  scriptsRead: number;
  parsed: number;
  /** Rows put to sleep (failed → dormant) and woken (dormant → failed). */
  slept: number;
  woken: number;
  ms: number;
}

interface Run {
  target: string;
  targetPath: string;
  targetHash: string | null;
  line: number;
  col: number;
}

/** Whether (line, col) a is strictly before b. */
const before = (a: { line: number; col: number }, b: { line: number; column: number }): boolean =>
  a.line < b.line || (a.line === b.line && a.col < b.column);

/**
 * The pass (see the top of this file). A project with no MATLAB file costs
 * one indexed probe. Null when it did nothing.
 */
export async function settleMatlabScriptWorkspaces(
  queries: QueryBuilder,
  projectRoot: string,
  maybeYield: MaybeYield,
  memo: MatlabScriptMemo,
): Promise<MatlabScriptWorkspaceStats | null> {
  if (!queries.hasFilesOfLanguage('matlab')) return null;
  const t0 = Date.now();
  const runsBy = new Map<string, Run[]>();
  let runCount = 0;
  for (const e of queries.getMatlabFileCallEdges()) {
    // Run in another workspace (`evalin('base', 's')`): makes no name here.
    if (matlabRefFacts(e).runtime) continue;
    runCount++;
    let list = runsBy.get(e.source);
    if (!list) runsBy.set(e.source, (list = []));
    list.push({ target: e.target, targetPath: e.targetPath, targetHash: e.targetHash, line: e.line, col: e.col });
  }
  const dormant = queries.getMatlabBareNameCallRows(DORMANT_REF_STATUS, null);
  const failed = runsBy.size > 0 ? queries.getMatlabBareNameCallRows('failed', [...runsBy.keys()]) : [];
  const stats: MatlabScriptWorkspaceStats = { runs: runCount, read: dormant.length + failed.length, rows: 0, scriptsRead: 0, parsed: 0, slept: 0, woken: 0, ms: 0 };
  const shaped = [...dormant, ...failed].filter(isMatlabPlainCall);
  if (shaped.length === 0) {
    stats.ms = Date.now() - t0;
    return stats;
  }
  const carried = matlabCarriedKeys(shaped.flatMap((r) => matlabNameKeys(r.referenceName)), null, queries);
  const rows = shaped.filter((r) => !matlabNameKeys(r.referenceName).some(carried));
  stats.rows = rows.length;
  for (const list of runsBy.values()) list.sort((a, b) => a.line - b.line || a.col - b.col);

  const lookup = indexedMatlabScriptLookup({ getNodesInFile: (filePath) => queries.getNodesByFile(filePath) }, projectRoot);
  let parser: ReturnType<typeof getParser> | undefined;
  /**
   * A script file read from disk: what it is, and whether that may go in the
   * memo. A read that fails (an editor's save caught mid-rename, EMFILE) makes
   * the file no script for this pass only: its rows may wake for one sync, and
   * the next pass, reading it again, puts them back.
   */
  const readScript = async (run: Run): Promise<{ entry: MatlabScriptEntry; keep: boolean }> => {
    const abs = validatePathWithinRoot(projectRoot, run.targetPath, { readOnly: true });
    if (!abs) return { entry: NOT_A_SCRIPT, keep: false };
    let text: string | null;
    try {
      text = readSourceText(abs, 'utf-8', MATLAB_SCRIPT_MAX_BYTES);
    } catch {
      return { entry: NOT_A_SCRIPT, keep: false };
    }
    // Over the size bound (or no regular file): not read, so never kept.
    if (text === null) return { entry: NOT_A_SCRIPT, keep: false };
    stats.scriptsRead++;
    const read = text;
    const keep = run.targetHash !== null && hashContent(read) === run.targetHash;
    const file = lookup.getNodesInFile(run.targetPath).find((n) => n.id === run.target);
    if (!file) return { entry: NOT_A_SCRIPT, keep: false };
    const asRead = { getNodesInFile: lookup.getNodesInFile, readFile: (filePath: string) => (filePath === run.targetPath ? read : lookup.readFile(filePath)) };
    if (!isMatlabScriptFile(file, asRead)) return { entry: NOT_A_SCRIPT, keep };
    if (parser === undefined) {
      try {
        await loadGrammarsForLanguages(['matlab']);
        parser = getParser('matlab');
      } catch {
        parser = null;
      }
    }
    if (!parser) return { entry: { script: true, names: NO_NAMES }, keep: false };
    stats.parsed++;
    let tree: ReturnType<NonNullable<typeof parser>['parse']> = null;
    let out: { entry: MatlabScriptEntry; keep: boolean };
    try {
      tree = parser.parse(read);
      // A parse that did not finish is no verdict on the text; one with errors is.
      if (!tree) out = { entry: { script: true, names: NO_NAMES }, keep: false };
      else out = { entry: { script: true, names: tree.rootNode.hasError ? NO_NAMES : matlabScriptMadeNames(tree.rootNode, read, run.targetPath) }, keep };
    } catch {
      out = { entry: { script: true, names: NO_NAMES }, keep: false };
    } finally {
      tree?.delete();
    }
    await maybeYield();
    return out;
  };
  // Each script file once per pass: from the memo, or read.
  const seenThisPass = new Map<string, MatlabScriptEntry>();
  const entryOf = async (run: Run): Promise<MatlabScriptEntry> => {
    let entry = seenThisPass.get(run.target) ?? (run.targetHash !== null ? memo.get(run.targetPath, run.targetHash) : undefined);
    if (!entry) {
      const found = await readScript(run);
      entry = found.entry;
      if (found.keep) memo.set(run.targetPath, run.targetHash!, entry);
    }
    seenThisPass.set(run.target, entry);
    return entry;
  };

  // The names each script makes with the scripts it runs, to the depth
  // bound, breadth first from it: the same set whichever scope runs it.
  const reached = new Map<string, ReadonlySet<string>>();
  const reachedNames = async (run: Run): Promise<ReadonlySet<string>> => {
    let names = reached.get(run.target);
    if (names) return names;
    const out = new Set<string>();
    const seen = new Set<string>([run.target]);
    let level: Run[] = [run];
    for (let depth = 1; depth <= MATLAB_SCRIPT_RUN_DEPTH && level.length > 0; depth++) {
      const next: Run[] = [];
      for (const s of level) {
        for (const n of (await entryOf(s)).names) out.add(n);
        if (depth === MATLAB_SCRIPT_RUN_DEPTH) continue;
        for (const r of runsBy.get(s.target) ?? []) {
          if (seen.has(r.target) || !(await entryOf(r)).script) continue;
          seen.add(r.target);
          next.push(r);
        }
      }
      level = next;
    }
    reached.set(run.target, out);
    return out;
  };

  const wasDormant = new Set(dormant);
  const sleep: typeof rows = [];
  const wake: typeof rows = [];
  for (const row of rows) {
    let made = false;
    for (const run of runsBy.get(row.fromNodeId) ?? []) {
      if (!before(run, row)) break;
      if (!(await entryOf(run)).script) continue;
      if ((await reachedNames(run)).has(row.referenceName)) {
        made = true;
        break;
      }
    }
    if (made && !wasDormant.has(row)) sleep.push(row);
    else if (!made && wasDormant.has(row)) wake.push(row);
  }
  const asWrite = (r: (typeof rows)[number]) => ({ rowId: r.rowId, referenceName: r.referenceName, referenceKind: r.referenceKind, nameTail: r.referenceName });
  for (let i = 0; i < sleep.length; i += WRITE_CHUNK) {
    stats.slept += queries.markReferencesDormantByRowIds(sleep.slice(i, i + WRITE_CHUNK).map(asWrite));
    await maybeYield();
  }
  for (let i = 0; i < wake.length; i += WRITE_CHUNK) {
    stats.woken += queries.markReferencesFailedByRowIds(wake.slice(i, i + WRITE_CHUNK).map(asWrite));
    await maybeYield();
  }
  stats.ms = Date.now() - t0;
  return stats;
}
