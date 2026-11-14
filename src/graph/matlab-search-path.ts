/**
 * The MATLAB search path a project's startup code sets, as the index stores
 * it, and what it decides: which definitions of a name MATLAB can see, and
 * which of several it runs.
 *
 * A call `f(x)` runs the first `f` on the search path. A project that keeps
 * several copies of a name (an old and a new release of a toolbox, one
 * machine's folder per facility) picks one by the folders its startup code
 * puts on the path: `codegraph.json`'s `matlab.startup`, or a `startup.m` at
 * the root. The resolver computes that path once per resolution pass and
 * stores it (see resolution/matlab-path-record); the resolver's lookup, the
 * explore and node tools and `codegraph status` all read it from here, so
 * they cannot disagree about what is on it.
 *
 * Visible from the path is a file in a path folder, in a `+pkg` / `@Cls`
 * folder (nested packages included) directly under one, or in the current
 * folder. A `private/` folder is its parent's alone, whatever the path says.
 *
 * Light: read by `codegraph status` and the query tools, which never load the
 * engine.
 */

import type { Node } from '../types';
import { matlabPathScope } from '../extraction/languages/matlab-path';

/** The metadata key the record lives under. */
export const MATLAB_PATH_METADATA_KEY = 'matlab_search_path';

/**
 * The key of a record worked out by a sync or an index whose re-resolution
 * has not finished: resolution reads it before the stored one, and it
 * replaces the stored one once the references it moved are resolved again. A
 * run stopped in between leaves it, and the next sync re-resolves again.
 */
export const MATLAB_PATH_PENDING_METADATA_KEY = 'matlab_search_path_pending';

/** The `computer` values MATLAB returns, the ones a startup may test, with what `computer('arch')` gives for each. */
export const MATLAB_COMPUTERS: Readonly<Record<string, string>> = {
  GLNXA64: 'glnxa64',
  PCWIN64: 'win64',
  MACI64: 'maci64',
  MACA64: 'maca64',
  GLNX86: 'glnx86',
  PCWIN: 'win32',
  MACI: 'maci',
  SOL2: 'sol2',
  SOL64: 'sol64',
};

/** The stored record. `source` null: no path is in force, and resolution is as if there were no record. */
export interface MatlabPathRecord {
  v: 1;
  /** Where the startup code came from. */
  source: 'codegraph.json' | 'startup.m' | null;
  /** The startup code as written, for display. */
  startup?: string;
  /** A digest of the configuration (the `matlab` block and whether a root `startup.m` exists). */
  config: string;
  /**
   * The project root the path was worked out under, absolute: the startup
   * code may read it (`pwd`, `mfilename('fullpath')`), so a checkout that
   * moved works the path out again.
   */
  root?: string;
  /** The path, in order: project-relative folders ('' is the root). */
  folders?: string[];
  /** The current folder when the startup code ended, project-relative ('' is the root); null when it could not be known. */
  cwd?: string | null;
  /** What the evaluation could not know, or did not follow (the first 200). */
  notes?: string[];
  /** How many notes there were, `notes` holding the first of them. */
  noteCount?: number;
  /**
   * Every question the evaluation asked of the project, with the answer it
   * got (see resolution/matlab-path-access): a sync asks them again, and
   * works the path out again when one answers differently. Absent: the
   * record says nothing of its inputs, and a sync always works it out again.
   */
  answers?: Record<string, string>;
}

/** A stored record, or null for none (an index built before paths, or a value this engine cannot read). */
export function parseMatlabPathRecord(stored: string | null | undefined): MatlabPathRecord | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as MatlabPathRecord;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || typeof parsed.config !== 'string') return null;
    if (parsed.source !== null && !Array.isArray(parsed.folders)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The folder of a '/'-separated path ('' for one at the root). */
export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * The folder a file is found from when MATLAB looks it up by name: its own,
 * less a class folder (`@Cls`) and the package folders (`+a/+b`) around it
 * (see matlabPathScope). A file in `private/` has none: it is its parent
 * folder's alone.
 */
export function matlabLookupFolder(filePath: string): string | null {
  const dir = dirOf(filePath);
  if (dir === '') return '';
  const dirs = dir.split('/');
  const { packages, classFolder } = matlabPathScope(filePath);
  const end = dirs.length - packages.length - (classFolder === undefined ? 0 : 1);
  if (end === dirs.length && dirs[end - 1] === 'private') return null;
  return dirs.slice(0, end).join('/');
}

/** The folder a `private/` folder's files run from (its parent, less a class or package folder); null for a file in no `private/` folder. */
function privateOwnerFolder(filePath: string): string | null {
  const dir = dirOf(filePath);
  if (!/(?:^|\/)private$/.test(dir)) return null;
  const owner = dirOf(dir);
  return matlabLookupFolder(owner === '' ? 'x.m' : `${owner}/x.m`);
}

/** The path in force: the record's folders and current folder, with what visibility asks of them. */
export class MatlabSearchPath {
  readonly folders: readonly string[];
  readonly cwd: string | null;
  readonly notes: readonly string[];
  readonly source: 'codegraph.json' | 'startup.m';
  readonly startup: string;
  private readonly rank = new Map<string, number>();

  constructor(record: MatlabPathRecord) {
    this.folders = record.folders ?? [];
    this.cwd = record.cwd ?? null;
    this.notes = record.notes ?? [];
    this.source = record.source ?? 'startup.m';
    this.startup = record.startup ?? '';
    // The current folder comes before the path.
    if (this.cwd !== null) this.rank.set(this.cwd, 0);
    this.folders.forEach((f, i) => {
      if (!this.rank.has(f)) this.rank.set(f, i + 1);
    });
  }

  /** The path of a record, or null when it sets none. */
  static of(record: MatlabPathRecord | null): MatlabSearchPath | null {
    return record && record.source !== null ? new MatlabSearchPath(record) : null;
  }

  /**
   * Where a file stands on the path: 0 in the current folder, then 1, 2, … in
   * path order; undefined when MATLAB cannot see it by name.
   */
  rankOf(filePath: string): number | undefined {
    const folder = matlabLookupFolder(filePath);
    return folder === null ? undefined : this.rank.get(folder);
  }

  /** Whether a file is visible from the path (see rankOf). */
  isVisible(filePath: string): boolean {
    return this.rankOf(filePath) !== undefined;
  }

  /**
   * Whether code in `filePath` runs from the path: its file is visible, or it
   * sits in the `private/` folder of a folder that is, a class or package
   * folder's (`lib/@Cls/private/`, `lib/+pkg/private/`) included.
   */
  isCallerOnPath(filePath: string): boolean {
    if (this.isVisible(filePath)) return true;
    const owner = privateOwnerFolder(filePath);
    return owner !== null && this.rank.has(owner);
  }

  /** `nodes` that are visible, in path order (a stable sort: equally placed ones keep their order). */
  visibleInOrder<T extends Pick<Node, 'filePath'>>(nodes: readonly T[]): T[] {
    const ranked: Array<{ n: T; r: number; i: number }> = [];
    nodes.forEach((n, i) => {
      const r = this.rankOf(n.filePath);
      if (r !== undefined) ranked.push({ n, r, i });
    });
    return ranked.sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.n);
  }
}

/** The kinds a MATLAB name is defined as on the path, which the path chooses among. */
const DEFINITION_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'enum', 'file']);

type Definition = Pick<Node, 'id' | 'filePath' | 'name' | 'kind' | 'language' | 'qualifiedName' | 'isExported'>;

/**
 * The name the path finds a node by, when it is a definition the path
 * decides between: a function file's function, a class, a script — not a
 * file's local function, a package's member or a `private/` function. Null
 * for any other node.
 */
function pathName(n: Definition): string | null {
  if (n.language !== 'matlab' || !DEFINITION_KINDS.has(n.kind) || matlabLookupFolder(n.filePath) === null) return null;
  if (n.kind === 'file') return n.name.replace(/\.[mM]$/, '');
  if (n.qualifiedName !== n.name || (n.kind === 'function' && n.isExported === false)) return null;
  return n.name;
}

/** A name's MATLAB definitions, as the search path sees them (see matlabCopiesOf). */
export interface MatlabCopies<T> {
  name: string;
  /** The ones named exactly so that are visible from the path, in path order: the first is the copy MATLAB runs. */
  onPath: T[];
  /** The ones named exactly so that MATLAB cannot see, in the order given. */
  offPath: T[];
  /** The ones whose name differs only in case (`FindM44` for `findm44`): another function to MATLAB, so counted, never shown in the name's place. */
  otherCase: T[];
}

/**
 * The copies of `name` among `nodes` (the nodes named `name` but for case,
 * any kind, in the order a surface lists them): the one derivation that
 * codegraph_explore and codegraph_node both render a name's copies from, so
 * they cannot count them differently. Nodes the path does not decide between
 * (see pathName) are in none of the lists.
 */
export function matlabCopiesOf<T extends Definition>(searchPath: MatlabSearchPath, name: string, nodes: readonly T[]): MatlabCopies<T> {
  const exact: T[] = [];
  const otherCase: T[] = [];
  const lower = name.toLowerCase();
  for (const n of nodes) {
    const key = pathName(n);
    if (key === name) exact.push(n);
    else if (key !== null && key.toLowerCase() === lower) otherCase.push(n);
  }
  const onPath = searchPath.visibleInOrder(exact);
  const visible = new Set(onPath);
  return { name, onPath, offPath: exact.filter((n) => !visible.has(n)), otherCase };
}

/**
 * `nodes` as a surface shows a name's copies (`copies`): with a copy on the
 * path, every copy on it, in path order in the slots they held, and none off
 * it; with none, the first `offPathShown` copies off it. Never a case
 * variant. Every other node keeps its place.
 */
export function keepMatlabCopies<T extends { id: string }>(nodes: readonly T[], copies: MatlabCopies<{ id: string }>, offPathShown: number): T[] {
  const hidden = new Set([...copies.otherCase, ...(copies.onPath.length > 0 ? copies.offPath : copies.offPath.slice(offPathShown))].map((n) => n.id));
  const kept = nodes.filter((n) => !hidden.has(n.id));
  const order = new Map(copies.onPath.map((n, i) => [n.id, i] as const));
  const slots = kept.flatMap((n, i) => (order.has(n.id) ? [i] : []));
  const inOrder = slots.map((i) => kept[i]!).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  slots.forEach((pos, j) => (kept[pos] = inOrder[j]!));
  return kept;
}

/**
 * The line that stands for the copies of a name a surface does not show:
 * `+10 more definitions of findm44 off the MATLAB path, 1 more spelled
 * differently`. `offPathShown` copies off the path were shown (none when one
 * on it is). Null when every copy is shown.
 */
export function matlabCopiesLine(copies: MatlabCopies<unknown>, offPathShown: number): string | null {
  const hidden = copies.onPath.length > 0 ? copies.offPath.length : Math.max(0, copies.offPath.length - offPathShown);
  const variants = copies.otherCase.length;
  const plural = (k: number): string => (k === 1 ? '' : 's');
  if (hidden > 0 && variants > 0) return `+${hidden} more definition${plural(hidden)} of ${copies.name} off the MATLAB path, ${variants} more spelled differently`;
  if (hidden > 0) return `+${hidden} more definition${plural(hidden)} of ${copies.name} off the MATLAB path`;
  if (variants > 0) return `+${variants} more definition${plural(variants)} of ${copies.name} spelled differently`;
  return null;
}
