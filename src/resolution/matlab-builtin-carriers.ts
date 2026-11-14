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
 */

import * as fs from 'fs';
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import { MATLAB_BUILTINS, addMatlabReachableNames } from '../extraction/languages/matlab-builtins';
import { matlabFileNames } from '../extraction/languages/matlab-path';
import { isJavaImport } from '../extraction/languages/matlab-java';

/** What a sync changed of the project's symbols and files, as the extraction step of a sync knows it. */
export interface MatlabCarrierInput {
  /** The names whose definition set the sync changed (added to or taken from a file). */
  deltaNames: ReadonlySet<string>;
  /** `file\0name` of every node of the files the sync replaced or removed, read before it did. */
  pairsBefore: ReadonlySet<string>;
  /** The files the sync extracted (their nodes are the new ones now). */
  extracted: ReadonlySet<string>;
  addedPaths: readonly string[];
  removedPaths: readonly string[];
}

export interface MatlabCarrierChange {
  /** The built-ins' names a MATLAB call of which a fresh index keeps now and did not before: the files naming them are extracted again. */
  gained: string[];
  /** The ones no symbol carries any more: every row of a call of the name goes. */
  lost: string[];
  /** The ones still carried that no `.m` file is named for any more: a row goes unless its file imports, or defines the name. */
  unreached: string[];
}

const NONE: MatlabCarrierChange = { gained: [], lost: [], unreached: [] };

/** The built-ins' names among a node's (or a script file's: `beep.m`) names. */
function builtinOf(name: string): string | null {
  if (MATLAB_BUILTINS.has(name)) return name;
  const stem = /^(.+)\.[mM]$/.exec(name)?.[1];
  return stem !== undefined && MATLAB_BUILTINS.has(stem) ? stem : null;
}

/** Which built-in names a sync gave a first carrier, or took the last one from (see the top of this file). */
export function matlabCarrierChanges(queries: QueryBuilder, input: MatlabCarrierInput): MatlabCarrierChange {
  const candidates = new Set<string>();
  for (const name of input.deltaNames) {
    const b = builtinOf(name);
    if (b !== null) candidates.add(b);
  }
  const mPath = (p: string): boolean => p.toLowerCase().endsWith('.m');
  const reachedByChange = new Set<string>();
  addMatlabReachableNames([...input.addedPaths, ...input.removedPaths].filter(mPath), reachedByChange);
  for (const name of reachedByChange) if (MATLAB_BUILTINS.has(name)) candidates.add(name);
  if (candidates.size === 0 || !queries.hasFilesOfLanguage('matlab')) return NONE;

  // Carried: some node is named for it (a function, a class, a script's `.m`).
  const keysOf = (b: string): string[] => [b, ...matlabFileNames(b)];
  const carriers = queries.getFilesCarryingNames([...candidates].flatMap(keysOf));
  const before = new Set<string>();
  for (const pair of input.pairsBefore) before.add(pair.slice(pair.indexOf('\0') + 1));
  const carriedNow = (b: string): boolean => keysOf(b).some((k) => carriers.has(k));
  const carriedBefore = (b: string): boolean =>
    keysOf(b).some((k) => before.has(k) || [...(carriers.get(k) ?? [])].some((f) => !input.extracted.has(f)));
  // Reached: a `.m` file is named for it, which keeps its calls at extraction.
  const now = queries.getAllFilePaths().filter(mPath);
  const added = new Set(input.addedPaths);
  const reachedNow = new Set<string>();
  addMatlabReachableNames(now, reachedNow);
  const reachedBefore = new Set<string>();
  addMatlabReachableNames([...now.filter((p) => !added.has(p)), ...input.removedPaths.filter(mPath)], reachedBefore);

  const change: MatlabCarrierChange = { gained: [], lost: [], unreached: [] };
  for (const b of candidates) {
    const cb = carriedBefore(b);
    const cn = carriedNow(b);
    const kb = cb && reachedBefore.has(b);
    const kn = cn && reachedNow.has(b);
    if ((!cb && cn) || (!kb && kn)) change.gained.push(b);
    else if (cb && !cn) change.lost.push(b);
    else if (kb && !kn) change.unreached.push(b);
  }
  return change;
}

/**
 * The project's MATLAB files, but `skip`, whose text names one of `names` as
 * a whole word: one read of each file, for all the names at once.
 */
export function matlabFilesNaming(queries: QueryBuilder, projectRoot: string, names: readonly string[], skip: ReadonlySet<string>): Array<{ filePath: string; content: string }> {
  if (names.length === 0) return [];
  const word = new RegExp(`\\b(?:${names.join('|')})\\b`);
  const out: Array<{ filePath: string; content: string }> = [];
  for (const filePath of queries.getFilePathsOfLanguage('matlab')) {
    if (skip.has(filePath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(projectRoot, filePath), 'utf-8');
    } catch {
      continue;
    }
    if (word.test(content)) out.push({ filePath, content });
  }
  return out;
}

/** Deletes the rows a fresh index would not keep (see MatlabCarrierChange); returns how many went. */
export function dropUncarriedMatlabRows(queries: QueryBuilder, change: MatlabCarrierChange): number {
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
  return queries.deleteReferencesByRowIds(ids);
}
