/**
 * THE PROJECT IS REACHED ONLY THROUGH `MatlabProjectAccess` (./matlab-path-access):
 * no code in this file reads the index or the disk itself. Every question it
 * asks of the project goes through that one object, which records the
 * question and its answer, and a sync asks them all again (see
 * ./matlab-path-record). A new way of looking at the project goes there,
 * never here; __tests__/matlab-path.test.ts checks this file's imports.
 *
 * The MATLAB search path a project's startup code sets, found by running that
 * code concretely: `setpathals('StorageRing')` into `setpathmml`, `getmmlroot`,
 * `setpathat`, `atpath`, each `addpath(fullfile(MMLROOT, …), '-begin')` as it
 * comes, under the `switch` / `if` the pinned settings decide (the computer,
 * the release, the environment variables).
 *
 * This is not the extractor's abstract interpreter (extraction/languages/
 * matlab-interp.ts), which joins every branch to see every value a dynamic
 * call may read: this one knows the values, takes the branch they choose, and
 * runs both only where a condition is unknown (then-branch first, both
 * branches' path edits kept, a note recorded). The parse, and the small
 * helpers that read it (matlab-values.ts), are shared.
 *
 * Paths are MATLAB's own: absolute, under the project's root, so code that
 * counts separators from the start (`MMLROOT(1:i(end-1))`, `MMLROOT(1:end-6)`)
 * reads what it reads in MATLAB. What it reports is project-relative. A folder
 * is one the index knows: one holding an indexed file, or an ancestor of one.
 *
 * It follows a call into the project's own functions when the function is
 * path-affecting (its file's text, or a function it calls by name, edits the
 * path or the current folder: `addpath`, `rmpath`, `path(`, `cd`, `userpath`,
 * `genpath`, `run(`, `eval`), and runs any other only for the value the caller
 * uses (`MMLROOT = getmmlroot(…)`), on a budget of its own; a call whose value
 * is dropped (`aoinit(…)` were it not path-affecting, `setad(AD)`) is passed
 * over. Calls are looked up as MATLAB looks them up at that moment: the
 * caller's local functions, its `private/` folder, the current folder, the
 * path built so far, then the folder the startup code started in.
 *
 * Never throws: whatever goes wrong becomes a note, and the path built until
 * then is kept, except code it runs for its path effect that does not parse
 * cleanly: then no path is set (`failed`), since what error recovery leaves of
 * a setpath file is not the path MATLAB would build.
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { getNodeText } from '../extraction/tree-sitter-helpers';
import { bracesIndex, callArgs, childField, commandItems, errorVariable, namedChildren, stringLiteral } from '../extraction/languages/matlab-values';
import { MATLAB_BUILTINS } from '../extraction/languages/matlab-builtins';
import { blankMatlabCommentsAndStrings } from '../extraction/languages/matlab-syntax';
import { matlabFileStem } from '../extraction/languages/matlab-path';
import { MATLAB_COMPUTERS, dirOf } from '../graph/matlab-search-path';
import type { MatlabProjectAccess } from './matlab-path-access';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A MATLAB release: its version number and the date `version('-date')` gives (the release's general-availability date, to the day where known). */
interface Release {
  version: string;
  /** `Month d, yyyy` */
  date: string;
}

/** The releases from R2014a on. */
const MATLAB_RELEASES: Readonly<Record<string, Release>> = {
  R2014a: { version: '8.3', date: 'February 11, 2014' },
  R2014b: { version: '8.4', date: 'August 13, 2014' },
  R2015a: { version: '8.5', date: 'February 12, 2015' },
  R2015b: { version: '8.6', date: 'August 13, 2015' },
  R2016a: { version: '9.0', date: 'February 11, 2016' },
  R2016b: { version: '9.1', date: 'August 26, 2016' },
  R2017a: { version: '9.2', date: 'February 24, 2017' },
  R2017b: { version: '9.3', date: 'July 27, 2017' },
  R2018a: { version: '9.4', date: 'February 6, 2018' },
  R2018b: { version: '9.5', date: 'August 28, 2018' },
  R2019a: { version: '9.6', date: 'February 23, 2019' },
  R2019b: { version: '9.7', date: 'August 26, 2019' },
  R2020a: { version: '9.8', date: 'February 19, 2020' },
  R2020b: { version: '9.9', date: 'July 30, 2020' },
  R2021a: { version: '9.10', date: 'February 17, 2021' },
  R2021b: { version: '9.11', date: 'August 9, 2021' },
  R2022a: { version: '9.12', date: 'February 2, 2022' },
  R2022b: { version: '9.13', date: 'August 24, 2022' },
  R2023a: { version: '9.14', date: 'February 24, 2023' },
  R2023b: { version: '23.2', date: 'August 21, 2023' },
  R2024a: { version: '24.1', date: 'February 21, 2024' },
  R2024b: { version: '24.2', date: 'August 21, 2024' },
  R2025a: { version: '25.1', date: 'February 26, 2025' },
  R2025b: { version: '25.2', date: 'September 17, 2025' },
};

export const DEFAULT_MATLAB_RELEASE = 'R2024b';
export const DEFAULT_MATLAB_COMPUTER = 'GLNXA64';

/** The project as the evaluation sees it. */
interface MatlabPathProject {
  /** The project root, absolute (`/home/u/proj`, `C:/dev/proj`; either separator). */
  root: string;
  /** The one way to the project's folders, files and their text (see the top of this file). */
  access: MatlabProjectAccess;
  /** A parse of MATLAB code, or null when there is no parser. The caller deletes nothing: the evaluation deletes every tree it gets. */
  parse(source: string): Tree | null;
}

export interface MatlabPathSettings {
  /** The startup code. */
  code: string;
  /** The project file the code is (a root `startup.m`), for `mfilename`; absent for code from `codegraph.json`. */
  codeFile?: string;
  /** The current folder at the start, project-relative. */
  cwd: string;
  env: Readonly<Record<string, string>>;
  computer: string;
  release: string;
  /** Caps, for tests. */
  maxDepth?: number;
  maxSteps?: number;
}

interface MatlabPathResult {
  /** The path, in order, project-relative ('' is the root). */
  folders: string[];
  /** The current folder at the end, project-relative; null when it is not known or not in the project. */
  cwd: string | null;
  /** The first notes (see MAX_NOTES). */
  notes: string[];
  /** How many notes there were. */
  noteCount: number;
  /** Why no path can be set (code run for its path effect that does not parse), or null. */
  failed: string | null;
}

const MAX_DEPTH = 16;
const MAX_STEPS = 200_000;
/** A call followed only for its value (see the top of this file) stops at this many statements, and gives an unknown value. */
const VALUE_CALL_STEPS = 20_000;
const MAX_LOOP_ROUNDS = 10_000;
/** The most elements an array the evaluation builds may hold (`zeros`, `cell`, an indexed assignment): past it, its value is unknown. */
const MAX_ELEMENTS = 10_000;
const MAX_NOTES = 200;
/** The longest text the evaluation builds (`blanks`), and a tenth of the longest code it parses. */
const MAX_EVAL_TEXT = 100_000;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Val =
  | { t: 'char'; s: string }
  | { t: 'string'; s: string }
  | { t: 'num'; v: number[]; logical?: boolean; col?: boolean }
  | { t: 'cell'; v: Val[]; col?: boolean }
  | { t: 'struct'; v: Map<string, Val>[] }
  | { t: 'fn'; name: string }
  | { t: 'unk' };

const UNK: Val = { t: 'unk' };
const EMPTY: Val = { t: 'num', v: [] };
const ch = (s: string): Val => ({ t: 'char', s });
const num = (...v: number[]): Val => ({ t: 'num', v });
const bool = (b: boolean): Val => ({ t: 'num', v: [b ? 1 : 0], logical: true });
const bools = (v: boolean[]): Val => ({ t: 'num', v: v.map((b) => (b ? 1 : 0)), logical: true });

function isText(v: Val): v is { t: 'char' | 'string'; s: string } {
  return v.t === 'char' || v.t === 'string';
}

function textOf(v: Val | undefined): string | undefined {
  return v && isText(v) ? v.s : undefined;
}

function numel(v: Val): number | undefined {
  switch (v.t) {
    case 'char': return v.s.length;
    case 'string': return 1;
    case 'num': case 'cell': case 'struct': return v.v.length;
    case 'fn': return 1;
    default: return undefined;
  }
}

/** Whether a vector is a column (`[a; b]` of scalars): a value read as a row by default. */
function isColumn(v: Val): boolean {
  return (v.t === 'num' || v.t === 'cell') && v.col === true && v.v.length > 1;
}

/** A value's elements as numbers (a char's codes), or undefined. */
function numbersOf(v: Val): number[] | undefined {
  if (v.t === 'num') return v.v;
  if (v.t === 'char') return [...v.s].map((c) => c.charCodeAt(0));
  return undefined;
}

function scalarOf(v: Val | undefined): number | undefined {
  if (!v) return undefined;
  const n = numbersOf(v);
  return n && n.length === 1 ? n[0] : undefined;
}

function sameVal(a: Val, b: Val): boolean {
  if (a === b) return true;
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'char': case 'string': return a.s === (b as typeof a).s;
    case 'num': return a.v.length === (b as typeof a).v.length && a.v.every((x, i) => x === (b as typeof a).v[i]);
    case 'cell': return a.v.length === (b as typeof a).v.length && a.v.every((x, i) => sameVal(x, (b as typeof a).v[i]!));
    case 'struct': {
      const bv = (b as typeof a).v;
      return a.v.length === bv.length && a.v.every((r, i) => r.size === bv[i]!.size && [...r].every(([k, x]) => bv[i]!.has(k) && sameVal(x, bv[i]!.get(k)!)));
    }
    case 'fn': return a.name === (b as typeof a).name;
    default: return false;
  }
}

/** MATLAB's truth of a condition: nonempty and all nonzero. Undefined when it cannot be told. */
function truth(v: Val): boolean | undefined {
  if (v.t === 'num' || v.t === 'char') {
    const n = numbersOf(v)!;
    if (n.some((x) => Number.isNaN(x))) return undefined;
    return n.length > 0 && n.every((x) => x !== 0);
  }
  return undefined;
}

/** A MATLAB error the code may catch; `where` is the statement it was raised at. */
class MatlabError extends Error {
  where?: string;
}
/** A cap reached: the evaluation stops where it is. */
class Stop extends Error {}
/** A followed-for-its-value call passed its own budget. */
class ValueBudget extends Error {}
/** Code run for its path effect does not parse: no path is set. */
class NoPath extends Error {}

type Flow = 'normal' | 'return' | 'break' | 'continue';

/**
 * The current folder: the folders it may be, absolute, in the order they
 * came (one when it is known); null when it may be any folder at all. Each
 * branch has its own, and branches that end in different ones leave the set
 * of them, up to MAX_CWD_CANDIDATES.
 */
type Cwd = readonly string[] | null;
const MAX_CWD_CANDIDATES = 8;

/** Where code may be: the variables of the scope it runs in, and the current folder. */
interface World {
  vars: Map<string, Val>;
  cwd: Cwd;
  /** For a world an error left: its message, for the `catch`'s variable. */
  message?: string;
}

/**
 * Where an early exit lands: a `return` at the end of the function (or
 * script, or the startup code) it is in, a `break` after its loop and a
 * `continue` at its loop's next round, an error at the `catch` of the try it
 * is in. A world that leaves early while others go on waits here (`parked`)
 * and joins the ones that get there the ordinary way.
 */
interface Frame {
  kind: 'function' | 'loop' | 'try';
  sc: Scope;
  parked: { return: World[]; break: World[]; continue: World[]; error: World[] };
}

type Exit = 'return' | 'break' | 'continue' | 'error';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `a/./b`, `a/../b`, `a//b`, a trailing `/` read away: an absolute,
 * '/'-separated path. A drive (`C:/dev`, `c:\\dev`) is kept, upper-cased, as
 * its first part, and `..` never climbs above it.
 */
function normalizeAbs(p: string): string {
  const drive = /^([A-Za-z]):/.exec(p);
  const out: string[] = [];
  for (const seg of (drive ? p.slice(2) : p).split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return (drive ? `${drive[1]!.toUpperCase()}:` : '') + '/' + out.join('/');
}

/** Whether two current folders are the same (see Cwd). */
function sameCwd(a: Cwd, b: Cwd): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The line of the first syntax error in a parse (0-based), or null when it parses cleanly. */
function firstErrorRow(node: SyntaxNode): number | null {
  if (!node.hasError && !node.isMissing) return null;
  if (node.type === 'ERROR' || node.isMissing) return node.startPosition.row;
  for (let i = 0; i < node.childCount; i++) {
    const row = firstErrorRow(node.child(i)!);
    if (row !== null) return row;
  }
  return node.startPosition.row;
}

/**
 * Whether a file's only path words are `cd`s back to a folder it saved from
 * `pwd` first (`DirStart = pwd; … cd(DirStart)`): its own words leave the
 * current folder as they found it, so they do not make it path-affecting.
 * MATLAB code does this around every file it saves. What it calls on the way
 * is still looked at like any other file's calls (see isPathAffecting).
 */
function restoresFolder(code: string): boolean {
  const saved = new Set<string>();
  for (const m of code.matchAll(/\b([A-Za-z]\w*)\s*=\s*pwd\b/g)) saved.add(m[1]!);
  if (saved.size === 0) return false;
  const words = [...code.matchAll(new RegExp(PATH_WORDS.source, 'gm'))];
  return words.every((m) => {
    if (!/^\s*cd/.test(m[0]) && !/\bcd\s*\($/.test(m[0])) return false;
    const rest = code.slice(m.index! + m[0].length);
    const arg = /^\s*\(?\s*([A-Za-z]\w*)\s*\)?/.exec(rest)?.[1];
    return arg !== undefined && saved.has(arg);
  });
}

/**
 * The names a file's code may call: every word but its own functions', its
 * variables' (assigned, or a function's parameter or output) and a field's.
 */
function calledWords(code: string): Set<string> {
  const own = new Set<string>();
  for (const m of code.matchAll(/\bfunction\b[^\n=]*?=?\s*([A-Za-z]\w*)\s*(?:\(|$|\n|;|,)/g)) own.add(m[1]!);
  const variables = new Set<string>();
  for (const m of code.matchAll(/(?:^|[;,])\s*([A-Za-z]\w*)\s*(?:\([^)\n]*\)\s*)?=(?!=)/gm)) variables.add(m[1]!);
  for (const m of code.matchAll(/\[([^\]\n]*)\]\s*=(?!=)/g)) for (const w of m[1]!.matchAll(WORD)) variables.add(w[0]);
  for (const m of code.matchAll(/\bfunction\b([^\n]*)/g)) for (const w of m[1]!.matchAll(WORD)) variables.add(w[0]);
  const words = new Set<string>();
  for (const m of code.matchAll(WORD)) {
    const w = m[0];
    if (m.index! > 0 && code[m.index! - 1] === '.') continue;
    if (!own.has(w) && !variables.has(w)) words.add(w);
  }
  return words;
}

/** Words that make a file's own text path-affecting (see the top of this file). */
const PATH_WORDS = /\b(?:addpath|rmpath|userpath|genpath|eval|restoredefaultpath)\b|\b(?:path|cd|run)\s*\(|^[ \t]*(?:cd|run)[ \t]+\S/m;
const WORD = /\b[A-Za-z]\w*\b/g;

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

interface ParsedFile {
  root: SyntaxNode;
  source: string;
  /** The line of its first syntax error (0-based), or null when it parses cleanly. */
  errorRow: number | null;
  /** Its functions by name, local and nested ones included (the first of a name). */
  functions: Map<string, SyntaxNode>;
  /** The first function's, when the file is a function file; null for a script (or a class). */
  main: SyntaxNode | null;
  isClass: boolean;
}

interface Scope {
  vars: Map<string, Val>;
  /** The file the running code is in, project-relative; null for the startup code from codegraph.json. */
  file: string | null;
  parsed: ParsedFile;
  /** Values `end` stands for, innermost last. */
  ends: number[];
}

export function evaluateMatlabPath(project: MatlabPathProject, settings: MatlabPathSettings): MatlabPathResult {
  return new PathEvaluation(project, settings).run();
}

class PathEvaluation {
  private readonly root: string;
  private readonly access: MatlabProjectAccess;
  private readonly trees: Tree[] = [];
  private readonly parsed = new Map<string, ParsedFile | null>();
  private readonly affecting = new Map<string, boolean>();
  private readonly notes: string[] = [];
  private noteCount = 0;
  private readonly noted = new Set<string>();
  /** Files read, by project-relative path (each is read once). */
  private readonly texts = new Map<string, string | null>();
  /** Why no path can be set, once known. */
  private failed: string | null = null;
  private readonly env: Map<string, string>;
  private readonly pc: boolean;
  private readonly release: string;
  private readonly maxDepth: number;
  private readonly maxSteps: number;

  /** The path, absolute folders in order. */
  private path: string[] = [];
  /** The current folder (see Cwd). */
  private cwd: Cwd;
  /** Where the code running now would land, were it to leave early (see Frame), innermost last. */
  private readonly frames: Frame[] = [];
  /** Worlds an error no `try` catches ended: they end the startup code. */
  private readonly uncaught: World[] = [];
  /** The folder the startup code started in, absolute. */
  private readonly entry: string;
  private steps = 0;
  private depth = 0;
  /** While a call is followed only for its value: the step count it must stop at. */
  private valueLimit = Infinity;

  constructor(private readonly project: MatlabPathProject, private readonly settings: MatlabPathSettings) {
    this.root = normalizeAbs(project.root.replace(/\\/g, '/'));
    this.access = project.access;
    this.env = new Map(Object.entries(settings.env));
    this.pc = settings.computer.startsWith('PC');
    this.release = MATLAB_RELEASES[settings.release] ? settings.release : DEFAULT_MATLAB_RELEASE;
    this.maxDepth = settings.maxDepth ?? MAX_DEPTH;
    this.maxSteps = settings.maxSteps ?? MAX_STEPS;
    this.entry = this.abs(settings.cwd);
    this.cwd = [this.entry];
  }

  run(): MatlabPathResult {
    try {
      if (!MATLAB_RELEASES[this.settings.release]) this.note(null, `release ${this.settings.release} is not known: ${DEFAULT_MATLAB_RELEASE} is used`);
      const start = this.rel(this.entry);
      if (start === null || !this.access.folderExists(start)) {
        this.note(null, `the starting folder ${this.settings.cwd} is not a folder of the project: the root is used`);
        this.cwd = [this.root];
      }
      const file = this.settings.codeFile ?? null;
      const parsed = file !== null ? this.parseFile(file) : this.parseText(this.settings.code);
      if (!parsed) {
        this.note(file, 'the startup code does not parse');
      } else {
        const scope: Scope = { vars: new Map(), file, parsed, ends: [] };
        const frame = this.pushFrame('function', scope);
        try {
          this.mustParse(file, parsed);
          this.execBlock(namedChildren(parsed.root), scope);
        } catch (e) {
          if (e instanceof MatlabError) this.note(null, `the startup code stopped on an error${e.where ? ` at ${e.where}` : ''}: ${e.message}`);
          else if (e instanceof Stop) this.note(null, e.message);
          else if (e instanceof NoPath) this.failed = e.message;
          else throw e;
        } finally {
          this.popFrame(frame);
        }
        // Every way the startup code ends: where it got to, a `return` out of
        // it, an error nothing caught.
        this.cwd = this.joinCwd([this.cwd, ...frame.parked.return.map((w) => w.cwd), ...this.uncaught.map((w) => w.cwd)]);
      }
    } catch (e) {
      this.note(null, `the evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const t of this.trees) {
        try { t.delete(); } catch { /* already gone */ }
      }
    }
    const folders: string[] = [];
    for (const a of this.path) {
      const r = this.rel(a);
      if (r !== null) folders.push(r);
    }
    return {
      folders: this.failed === null ? folders : [],
      cwd: this.here === null ? null : this.rel(this.here),
      notes: this.notes,
      noteCount: this.noteCount,
      failed: this.failed,
    };
  }

  /** Stops the evaluation, with no path, when code run for its path effect does not parse cleanly. */
  private mustParse(file: string | null, parsed: ParsedFile): void {
    if (parsed.errorRow === null) return;
    throw new NoPath(`${file ?? 'startup'}:${parsed.errorRow + 1}: the code does not parse: no path is set`);
  }

  // -- notes and positions ---------------------------------------------------

  private note(file: string | null, message: string, node?: SyntaxNode): void {
    const where = node ? `${file ?? 'startup'}:${node.startPosition.row + 1}: ` : file ? `${file}: ` : '';
    const text = where + message;
    if (this.noted.has(text)) return;
    this.noted.add(text);
    this.noteCount++;
    if (this.notes.length < MAX_NOTES) this.notes.push(text);
  }

  // -- paths -----------------------------------------------------------------

  /** A project-relative folder as MATLAB's absolute one. */
  private abs(rel: string): string {
    return rel === '' ? this.root : normalizeAbs(`${this.root}/${rel}`);
  }

  /** An absolute path as project-relative, or null outside the project. */
  private rel(abs: string): string | null {
    if (abs === this.root) return '';
    const prefix = this.root.endsWith('/') ? this.root : `${this.root}/`;
    return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
  }

  /** A path as the code would see it: the computer's separator. */
  private out(abs: string): string {
    return this.pc ? abs.replace(/\//g, '\\') : abs;
  }

  /**
   * Text the code gives as a path, as an absolute one: relative to the
   * current folder. Null when it is relative and the folders the current one
   * may be give different ones, or it may be any.
   */
  private toAbs(text: string): string | null {
    const p = text.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(p)) return normalizeAbs(p);
    // On a drive, `/x` is that drive's.
    if (p.startsWith('/')) return normalizeAbs(/^[A-Z]:/.test(this.root) ? this.root.slice(0, 2) + p : p);
    if (this.cwd === null) return null;
    const all = new Set(this.cwd.map((c) => normalizeAbs(`${c}/${p}`)));
    return all.size === 1 ? [...all][0]! : null;
  }

  /** The current folder when it is known (one folder), else null. */
  private get here(): string | null {
    return this.cwd !== null && this.cwd.length === 1 ? this.cwd[0]! : null;
  }

  /** The folders worlds may be in, together (see Cwd). */
  private joinCwd(list: readonly Cwd[]): Cwd {
    if (list.some((c) => c === null)) return null;
    const all = [...new Set(list.flatMap((c) => c!))];
    return all.length > MAX_CWD_CANDIDATES ? null : all;
  }

  /**
   * `ask`'s answer from each folder the current one may be, when they all
   * give the same (`same`); undefined when they do not. With any folder
   * possible, `ask` is asked once with none: a relative path then has no
   * answer, which `ask` gives as unknown.
   */
  private agree<T>(ask: () => T, same: (a: T, b: T) => boolean): { value: T } | undefined {
    const saved = this.cwd;
    if (saved === null || saved.length === 1) return { value: ask() };
    try {
      let first: { value: T } | undefined;
      for (const c of saved) {
        this.cwd = [c];
        const v = ask();
        if (!first) first = { value: v };
        else if (!same(first.value, v)) return undefined;
      }
      return first;
    } finally {
      this.cwd = saved;
    }
  }

  private isFolder(abs: string): boolean {
    const r = this.rel(abs);
    return r !== null && this.access.folderExists(r);
  }

  private get filesep(): string {
    return this.pc ? '\\' : '/';
  }

  private get pathsep(): string {
    return this.pc ? ';' : ':';
  }

  // -- files -----------------------------------------------------------------

  private readText(rel: string): string | null {
    if (this.texts.has(rel)) return this.texts.get(rel)!;
    const text = this.access.readFile(rel);
    this.texts.set(rel, text);
    return text;
  }

  private parseText(source: string): ParsedFile | null {
    if (source.length > MAX_EVAL_TEXT * 10) return null;
    let tree: Tree | null = null;
    try {
      tree = this.project.parse(source);
    } catch {
      tree = null;
    }
    if (!tree) return null;
    this.trees.push(tree);
    const root = tree.rootNode;
    const functions = new Map<string, SyntaxNode>();
    let main: SyntaxNode | null = null;
    let isClass = false;
    let first = true;
    const collect = (n: SyntaxNode): void => {
      for (const c of namedChildren(n)) {
        if (c.type === 'function_definition') {
          const name = childField(c, 'name');
          if (name) {
            const text = getNodeText(name, source);
            if (!functions.has(text)) functions.set(text, c);
          }
          for (const b of namedChildren(c)) if (b.type === 'block') collect(b);
        }
      }
    };
    for (const c of namedChildren(root)) {
      if (c.type === 'comment' || c.type === 'line_continuation') continue;
      if (first) {
        if (c.type === 'function_definition') main = c;
        if (c.type === 'class_definition') isClass = true;
        first = false;
      }
    }
    collect(root);
    return { root, source, errorRow: firstErrorRow(root), functions, main, isClass };
  }

  private parseFile(rel: string): ParsedFile | null {
    if (this.parsed.has(rel)) return this.parsed.get(rel)!;
    const text = this.readText(rel);
    const parsed = text === null ? null : this.parseText(text);
    this.parsed.set(rel, parsed);
    return parsed;
  }

  /**
   * The project files MATLAB may run for `name` called from `fromFile`, as
   * things stand: the caller's `private/` folder, the current folder, the
   * path, then the folder the startup code started in; null for none (a
   * built-in). One for each folder the current one may be; when it may be
   * any, the path's answer and every file that defines the name (the current
   * folder may be any one's).
   */
  private lookupAll(name: string, fromFile: string | null): Set<string | null> {
    const candidates = new Set(this.access.filesDefining(name));
    if (candidates.size === 0) return new Set([null]);
    const has = (folderAbs: string): string | null => {
      const r = this.rel(folderAbs);
      if (r === null) return null;
      const f = r === '' ? `${name}.m` : `${r}/${name}.m`;
      return candidates.has(f) ? f : candidates.has(f.slice(0, -1) + 'M') ? f.slice(0, -1) + 'M' : null;
    };
    if (fromFile !== null) {
      const d = dirOf(fromFile);
      const priv = /(?:^|\/)private$/.test(d) ? d : d === '' ? 'private' : `${d}/private`;
      const hit = has(this.abs(priv));
      if (hit) return new Set([hit]);
    }
    const from = (cwd: string | null): string | null => {
      for (const folder of [...(cwd !== null ? [cwd] : []), ...this.path, this.entry]) {
        const hit = has(folder);
        if (hit) return hit;
      }
      return null;
    };
    if (this.cwd === null) return new Set([from(null), ...candidates]);
    return new Set(this.cwd.map(from));
  }

  /** The project file MATLAB runs for `name` (see lookupAll): null for none, undefined when it depends on a current folder not known. */
  private lookup(name: string, fromFile: string | null): string | null | undefined {
    const all = this.lookupAll(name, fromFile);
    return all.size === 1 ? [...all][0]! : undefined;
  }

  /** The first `name.m` on the current folder and the path (`which`): null for none, undefined when it depends on a current folder not known (see lookupAll). */
  private which(name: string): string | null | undefined {
    const candidates = new Set(this.access.filesDefining(name).filter((f) => f.endsWith('.m')));
    if (candidates.size === 0) return null;
    const from = (cwd: string | null): string | null => {
      for (const folder of [...(cwd !== null ? [cwd] : []), ...this.path]) {
        const r = this.rel(folder);
        if (r === null) continue;
        const f = r === '' ? `${name}.m` : `${r}/${name}.m`;
        if (candidates.has(f)) return f;
      }
      return null;
    };
    const all = this.cwd === null ? new Set([from(null), ...candidates]) : new Set(this.cwd.map(from));
    return all.size === 1 ? [...all][0]! : undefined;
  }

  /**
   * Whether a file's code edits the path or the current folder, itself or
   * through a function it calls by name (looked up from it as things stand):
   * whether the files its calls reach hold a path word (see PATH_WORDS,
   * restoresFolder). Read by text, never parsed. A file's answer is kept:
   * true as soon as one is found, false once every file it reaches was read.
   */
  private isPathAffecting(rel: string): boolean {
    const known = this.affecting.get(rel);
    if (known !== undefined) return known;
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const reaches = (file: string): boolean => {
      const k = this.affecting.get(file);
      if (k !== undefined) return k;
      if (visited.has(file)) return false;
      visited.add(file);
      onStack.add(file);
      let result = false;
      const text = this.readText(file);
      if (text !== null) {
        const code = blankMatlabCommentsAndStrings(text);
        // A file's own path words, unless they only put the current folder
        // back; else what it calls (every word is looked up, so a file that
        // comes to define one is a question the record asks again).
        if (PATH_WORDS.test(code) && !restoresFolder(code)) result = true;
        else {
          words: for (const w of calledWords(code)) {
            for (const target of this.lookupAll(w, file)) {
              if (target !== null && target !== file && !onStack.has(target) && reaches(target)) {
                result = true;
                break words;
              }
            }
          }
        }
      }
      onStack.delete(file);
      if (result) this.affecting.set(file, true);
      return result;
    };
    const result = reaches(rel);
    // Nothing the file reaches edits the path: nor does anything on the way.
    if (!result) for (const f of visited) if (!this.affecting.has(f)) this.affecting.set(f, false);
    return result;
  }

  // -- statements ------------------------------------------------------------

  private tick(): void {
    if (++this.steps > this.maxSteps) throw new Stop(`the statement budget (${this.maxSteps}) was reached: evaluation stopped, the path so far kept`);
    if (this.steps > this.valueLimit) throw new ValueBudget();
  }

  private execBlock(statements: readonly SyntaxNode[], sc: Scope): Flow {
    for (const s of statements) {
      const flow = this.exec(s, sc);
      if (flow !== 'normal') return flow;
    }
    return 'normal';
  }

  private body(node: SyntaxNode): SyntaxNode[] {
    const block = namedChildren(node).find((c) => c.type === 'block');
    return block ? namedChildren(block) : [];
  }

  private exec(node: SyntaxNode, sc: Scope): Flow {
    switch (node.type) {
      case 'comment':
      case 'line_continuation':
      case 'function_definition':
      case 'class_definition':
        return 'normal';
    }
    this.tick();
    try {
      return this.execStatement(node, sc);
    } catch (e) {
      if (e instanceof MatlabError && e.where === undefined) e.where = `${sc.file ?? 'startup'}:${node.startPosition.row + 1}`;
      throw e;
    }
  }

  private execStatement(node: SyntaxNode, sc: Scope): Flow {
    switch (node.type) {
      case 'assignment':
        this.assign(node, sc);
        return 'normal';
      case 'function_call':
        this.evalCall(node, sc, 0);
        return 'normal';
      case 'identifier': {
        const name = this.text(node, sc);
        if (!sc.vars.has(name)) this.callNamed(name, [], 0, sc, node);
        return 'normal';
      }
      case 'command':
        this.command(node, sc);
        return 'normal';
      case 'if_statement':
        return this.ifStatement(node, sc);
      case 'switch_statement':
        return this.switchStatement(node, sc);
      case 'for_statement':
        return this.forStatement(node, sc);
      case 'while_statement':
        return this.whileStatement(node, sc);
      case 'try_statement':
        return this.tryStatement(node, sc);
      case 'return_statement':
        return 'return';
      case 'break_statement':
        return 'break';
      case 'continue_statement':
        return 'continue';
      case 'global_operator':
      case 'persistent_operator':
        for (const c of namedChildren(node)) if (c.type === 'identifier') sc.vars.set(this.text(c, sc), UNK);
        return 'normal';
      case 'block':
        return this.execBlock(namedChildren(node), sc);
      default:
        this.ev(node, sc);
        return 'normal';
    }
  }

  private text(node: SyntaxNode, sc: Scope): string {
    return getNodeText(node, sc.parsed.source);
  }

  // -- worlds that leave early (see Frame) -----------------------------------

  private pushFrame(kind: Frame['kind'], sc: Scope): Frame {
    const frame: Frame = { kind, sc, parked: { return: [], break: [], continue: [], error: [] } };
    this.frames.push(frame);
    return frame;
  }

  private popFrame(frame: Frame): void {
    const i = this.frames.lastIndexOf(frame);
    if (i >= 0) this.frames.splice(i, 1);
  }

  /** The world code in `sc` is in now. */
  private world(sc: Scope, message?: string): World {
    return { vars: sc.vars, cwd: this.cwd, ...(message !== undefined ? { message } : {}) };
  }

  /**
   * Leaves `w` where its exit lands: a `return` at the innermost function, a
   * `break` or `continue` at the innermost loop (in a function with none, at
   * the function's end), an error at the innermost `try`, or, with none, as
   * an end of the startup code. An error's world holds the variables of the
   * scope it lands in, as they are when it leaves.
   */
  private park(exit: Exit, w: World, sc: Scope): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (exit === 'error') {
        if (f.kind !== 'try') continue;
        f.parked.error.push({ ...w, vars: f.sc === sc ? new Map(w.vars) : new Map(f.sc.vars) });
        return;
      }
      if (exit === 'return' ? f.kind === 'function' : f.kind === 'loop' || f.kind === 'function') {
        f.parked[f.kind === 'function' ? 'return' : exit].push({ ...w, vars: new Map(w.vars) });
        return;
      }
    }
    if (exit === 'error') this.uncaught.push({ ...w, vars: new Map() });
  }

  /**
   * The worlds together: a variable they hold alike keeps its value, any
   * other is unknown; the current folder is the set of theirs. Noted when
   * they end in different folders.
   */
  private join(worlds: readonly World[], sc: Scope, node: SyntaxNode | undefined, why: string): World {
    if (worlds.length === 1) return { vars: new Map(worlds[0]!.vars), cwd: worlds[0]!.cwd, ...(worlds[0]!.message !== undefined ? { message: worlds[0]!.message } : {}) };
    const vars = new Map<string, Val>();
    const names = new Set(worlds.flatMap((w) => [...w.vars.keys()]));
    for (const name of names) {
      const first = worlds[0]!.vars.get(name);
      vars.set(name, first !== undefined && worlds.every((w) => { const v = w.vars.get(name); return v !== undefined && sameVal(v, first); }) ? first : UNK);
    }
    const cwd = this.joinCwd(worlds.map((w) => w.cwd));
    if (worlds.some((w) => !sameCwd(w.cwd, worlds[0]!.cwd))) this.note(sc.file, `${why}: the current folder is not known from here on`, node);
    const message = worlds.every((w) => w.message === worlds[0]!.message) ? worlds[0]!.message : undefined;
    return { vars, cwd, ...(message !== undefined ? { message } : {}) };
  }

  /** Makes `w` the world code in `sc` is in. */
  private enter(w: World, sc: Scope): void {
    sc.vars = w.vars;
    this.cwd = w.cwd;
  }

  /**
   * Runs one of several branches when the values choose it; all of them,
   * each from the same variables and the same current folder, when they do
   * not. The path's edits are every branch's; a variable, or the current
   * folder, that the branches leave differently is unknown after them. A
   * branch that leaves early (`return`, `break`, `continue`, an error) is
   * left where it lands (see Frame), while the others go on.
   */
  private branches(candidates: ReadonlyArray<readonly SyntaxNode[] | null>, sc: Scope, node?: SyntaxNode): Flow {
    if (candidates.length === 1) return candidates[0] ? this.execBlock(candidates[0], sc) : 'normal';
    const base = sc.vars;
    const baseCwd = this.cwd;
    const outcomes: Array<{ world: World; flow: Flow | 'error'; error?: MatlabError }> = [];
    for (const c of candidates) {
      sc.vars = new Map(base);
      this.cwd = baseCwd;
      try {
        const flow = c ? this.execBlock(c, sc) : 'normal';
        outcomes.push({ world: this.world(sc), flow });
      } catch (e) {
        if (!(e instanceof MatlabError)) {
          sc.vars = base;
          throw e;
        }
        outcomes.push({ world: this.world(sc, e.message), flow: 'error', error: e });
      }
    }
    return this.settle(outcomes, sc, node, 'the branches end in different current folders');
  }

  /**
   * Where several worlds go on: the ones that carry on together, joined; the
   * ones that leave early, each left where it lands (see park). When none
   * carries on, the first goes on leaving (its exit, or its error thrown).
   */
  private settle(outcomes: ReadonlyArray<{ world: World; flow: Flow | 'error'; error?: MatlabError }>, sc: Scope, node: SyntaxNode | undefined, why: string): Flow {
    const going = outcomes.filter((o) => o.flow === 'normal');
    for (const o of outcomes) if (o.flow !== 'normal') this.park(o.flow, o.world, sc);
    if (going.length > 0) {
      this.enter(this.join(going.map((o) => o.world), sc, node, why), sc);
      return 'normal';
    }
    const first = outcomes[0]!;
    this.enter({ vars: new Map(first.world.vars), cwd: first.world.cwd }, sc);
    if (first.flow === 'error') throw first.error!;
    return first.flow;
  }

  private ifStatement(node: SyntaxNode, sc: Scope): Flow {
    const candidates: Array<readonly SyntaxNode[] | null> = [];
    let decided = false;
    const clauses: Array<{ cond: SyntaxNode | null; body: SyntaxNode[] }> = [{ cond: childField(node, 'condition'), body: this.body(node) }];
    for (const c of namedChildren(node)) {
      if (c.type === 'elseif_clause') clauses.push({ cond: childField(c, 'condition'), body: this.body(c) });
      else if (c.type === 'else_clause') clauses.push({ cond: null, body: this.body(c) });
    }
    for (const clause of clauses) {
      if (clause.cond === null) {
        candidates.push(clause.body);
        decided = true;
        break;
      }
      const t = truth(this.ev(clause.cond, sc));
      if (t === false) continue;
      candidates.push(clause.body);
      if (t === true) {
        decided = true;
        break;
      }
      this.note(sc.file, 'a condition is not known: every branch it may take is run', clause.cond);
    }
    if (!decided) candidates.push(null);
    if (candidates.length === 1 && candidates[0] === null) return 'normal';
    return this.branches(candidates, sc, node);
  }

  private switchStatement(node: SyntaxNode, sc: Scope): Flow {
    const subjectNode = childField(node, 'condition');
    const subject = subjectNode ? this.ev(subjectNode, sc) : UNK;
    const candidates: Array<readonly SyntaxNode[] | null> = [];
    let decided = false;
    let unknown = false;
    for (const c of namedChildren(node)) {
      if (c.type === 'case_clause') {
        const condNode = childField(c, 'condition');
        const m = condNode ? this.caseMatches(subject, this.ev(condNode, sc)) : undefined;
        if (m === false) continue;
        candidates.push(this.body(c));
        if (m === true) {
          decided = true;
          break;
        }
        unknown = true;
      } else if (c.type === 'otherwise_clause') {
        candidates.push(this.body(c));
        decided = true;
        break;
      }
    }
    if (unknown) this.note(sc.file, 'a switch is not known: every case it may take is run', node);
    if (!decided) candidates.push(null);
    if (candidates.length === 1 && candidates[0] === null) return 'normal';
    return this.branches(candidates, sc, node);
  }

  private caseMatches(subject: Val, value: Val): boolean | undefined {
    if (value.t === 'cell') {
      let unknown = false;
      for (const v of value.v) {
        const m = this.caseMatches(subject, v);
        if (m === true) return true;
        if (m === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    if (subject.t === 'unk' || value.t === 'unk') return undefined;
    if (isText(subject) || isText(value)) return isText(subject) && isText(value) ? subject.s === value.s : false;
    const a = scalarOf(subject);
    const b = scalarOf(value);
    if (a === undefined || b === undefined) return undefined;
    return a === b;
  }

  private forStatement(node: SyntaxNode, sc: Scope): Flow {
    const iterator = namedChildren(node).find((c) => c.type === 'iterator' || c.type === 'parfor_options');
    const kids = iterator ? namedChildren(iterator) : [];
    const varNode = kids.find((c) => c.type === 'identifier');
    const rangeNode = kids.length > 1 ? kids[kids.length - 1] : undefined;
    const body = this.body(node);
    if (!varNode || !rangeNode) return 'normal';
    const name = this.text(varNode, sc);
    const range = this.ev(rangeNode, sc);
    let items: Val[] | undefined;
    switch (range.t) {
      case 'num': items = range.v.map((x) => ({ t: 'num', v: [x], logical: range.logical }) as Val); break;
      case 'char': items = [...range.s].map((c) => ch(c)); break;
      case 'cell': items = range.v.map((x) => ({ t: 'cell', v: [x] }) as Val); break;
      case 'struct': items = range.v.map((r) => ({ t: 'struct', v: [r] }) as Val); break;
      case 'string': items = [range]; break;
      default: items = undefined;
    }
    if (items === undefined) {
      this.note(sc.file, 'what a loop runs over is not known: its body is run once, or not at all', node);
      sc.vars.set(name, UNK);
      return this.loop(sc, node, (round) => (round === 0 ? 'last' : 'stop'), () => this.branches([body, null], sc, node));
    }
    const rounds = items.slice(0, MAX_LOOP_ROUNDS);
    return this.loop(sc, node, (round) => {
      if (round >= rounds.length) return 'stop';
      sc.vars.set(name, rounds[round]!);
      return 'go';
    }, () => this.execBlock(body, sc));
  }

  private whileStatement(node: SyntaxNode, sc: Scope): Flow {
    const cond = childField(node, 'condition');
    const body = this.body(node);
    if (!cond) return 'normal';
    let unknown = false;
    const flow = this.loop(sc, node, (round) => {
      if (round >= MAX_LOOP_ROUNDS) {
        this.note(sc.file, `a loop ran ${MAX_LOOP_ROUNDS} rounds: left there`, node);
        return 'stop';
      }
      const t = truth(this.ev(cond, sc));
      if (t === false) return 'stop';
      if (t === undefined) {
        this.note(sc.file, 'a loop condition is not known: its body is run once more, or not', cond);
        unknown = true;
        return 'last';
      }
      return 'go';
    }, () => (unknown ? this.branches([body, null], sc, node) : this.execBlock(body, sc)));
    return flow;
  }

  /**
   * A loop's rounds, in a frame of its own: `next(round)` readies a round
   * ('go'), its last one ('last': what follows it is after the loop, a
   * `continue` too) or says the loop is over ('stop'); `round()` runs one.
   * A world that leaves a round by `continue` joins the next round's, one
   * that leaves by `break` joins what comes after the loop, and one that
   * returns or errors goes on out while others go on round.
   */
  private loop(sc: Scope, node: SyntaxNode, next: (round: number) => 'go' | 'last' | 'stop', round: () => Flow): Flow {
    const frame = this.pushFrame('loop', sc);
    try {
      let alive = true;
      for (let k = 0; ; k++) {
        const step = next(k);
        if (step === 'stop') break;
        let flow: Flow | 'gone';
        try {
          flow = round();
        } catch (e) {
          if (!(e instanceof MatlabError) || (frame.parked.break.length === 0 && frame.parked.continue.length === 0)) throw e;
          // This world leaves for its `catch`; the ones left here go on.
          this.park('error', this.world(sc, e.message), sc);
          flow = 'gone';
        }
        if (flow === 'return') {
          if (frame.parked.break.length === 0 && frame.parked.continue.length === 0) return 'return';
          this.park('return', this.world(sc), sc);
          flow = 'gone';
        }
        if (flow === 'break') {
          frame.parked.break.push({ ...this.world(sc), vars: new Map(sc.vars) });
          flow = 'gone';
        }
        const on = [...(flow !== 'gone' ? [this.world(sc)] : []), ...frame.parked.continue];
        frame.parked.continue = [];
        if (step === 'last') {
          frame.parked.break.push(...on);
          alive = false;
          break;
        }
        if (on.length === 0) {
          alive = false;
          break;
        }
        this.enter(this.join(on, sc, node, 'a loop round leaves early in a different current folder'), sc);
      }
      const after = [...(alive ? [this.world(sc)] : []), ...frame.parked.break];
      if (after.length > 0) this.enter(this.join(after, sc, node, 'a loop is left in different current folders'), sc);
      return 'normal';
    } finally {
      this.popFrame(frame);
    }
  }

  private tryStatement(node: SyntaxNode, sc: Scope): Flow {
    const catchClause = namedChildren(node).find((c) => c.type === 'catch_clause');
    const frame = this.pushFrame('try', sc);
    let flow: Flow | 'error';
    let thrown: World | null = null;
    try {
      flow = this.execBlock(this.body(node), sc);
    } catch (e) {
      if (!(e instanceof MatlabError)) throw e;
      flow = 'error';
      thrown = this.world(sc, e.message);
    } finally {
      this.popFrame(frame);
    }
    // Every world an error left in the try body starts the catch.
    const errors = [...(thrown ? [thrown] : []), ...frame.parked.error];
    if (errors.length === 0) return flow as Flow;
    const tried = flow === 'error' ? null : { world: this.world(sc), flow };
    this.enter(this.join(errors, sc, node, 'errors leave the try in different current folders'), sc);
    let caught: { world: World; flow: Flow | 'error'; error?: MatlabError };
    if (!catchClause) caught = { world: this.world(sc), flow: 'normal' };
    else {
      const errVar = errorVariable(catchClause);
      const message = errors.every((w) => w.message === errors[0]!.message) ? errors[0]!.message : undefined;
      if (errVar) sc.vars.set(this.text(errVar, sc), { t: 'struct', v: [new Map<string, Val>([['message', message !== undefined ? ch(message) : UNK], ['identifier', ch('')], ['stack', UNK]])] });
      if (!tried) return this.execBlock(this.body(catchClause), sc);
      try {
        caught = { world: this.world(sc), flow: this.execBlock(this.body(catchClause), sc) };
        caught.world = this.world(sc);
      } catch (e) {
        if (!(e instanceof MatlabError)) throw e;
        caught = { world: this.world(sc, e.message), flow: 'error', error: e };
      }
    }
    if (!tried) {
      this.enter(caught.world, sc);
      return caught.flow as Flow;
    }
    return this.settle([tried, caught], sc, node, 'a try and its catch end in different current folders');
  }

  private command(node: SyntaxNode, sc: Scope): void {
    const nameNode = namedChildren(node).find((c) => c.type === 'command_name');
    if (!nameNode) return;
    const name = this.text(nameNode, sc).trim();
    const items = commandItems(node, sc.parsed.source);
    if (sc.vars.has(name)) return;
    this.callNamed(name, items.map((s) => ch(s)), 0, sc, node);
  }

  // -- assignment ------------------------------------------------------------

  private assign(node: SyntaxNode, sc: Scope): void {
    const left = childField(node, 'left');
    const right = childField(node, 'right');
    if (!left || !right) return;
    if (left.type === 'multioutput_variable') {
      const targets = namedChildren(left).filter((c) => c.type === 'identifier' || c.type === 'ignored_argument' || c.type === 'function_call' || c.type === 'field_expression');
      const values = this.evMulti(right, sc, targets.length);
      targets.forEach((t, i) => {
        if (t.type === 'ignored_argument') return;
        this.store(t, values[i] ?? UNK, sc, false);
      });
      return;
    }
    const deletion = right.type === 'matrix' && namedChildren(right).length === 0;
    this.store(left, this.ev(right, sc), sc, deletion);
  }

  /** Stores `value` where `target` (an identifier, an index, a field) says; anything it cannot follow leaves its variable unknown. */
  private store(target: SyntaxNode, value: Val, sc: Scope, deletion: boolean): void {
    if (target.type === 'identifier') {
      sc.vars.set(this.text(target, sc), value);
      return;
    }
    const steps = this.accessPath(target, sc);
    if (!steps) {
      const head = this.headName(target, sc);
      if (head) sc.vars.set(head, UNK);
      return;
    }
    const [rootName, ...rest] = steps as [string, ...Access[]];
    try {
      sc.vars.set(rootName, this.setAt(sc.vars.get(rootName), rest, value, deletion));
    } catch (e) {
      if (e instanceof MatlabError) throw e;
      sc.vars.set(rootName, UNK);
    }
  }

  private headName(node: SyntaxNode, sc: Scope): string | null {
    let n: SyntaxNode | null = node;
    while (n && n.type !== 'identifier') n = n.type === 'field_expression' ? childField(n, 'object') : n.type === 'function_call' ? childField(n, 'name') : null;
    return n ? this.text(n, sc) : null;
  }

  /** `s.f(2).g` as its root name and its steps, each index already evaluated; null for a shape not followed. */
  private accessPath(node: SyntaxNode, sc: Scope): [string, ...Access[]] | null {
    if (node.type === 'identifier') return [this.text(node, sc)];
    if (node.type === 'function_call') {
      const name = childField(node, 'name');
      if (!name) return null;
      const inner = this.accessPath(name, sc);
      if (!inner) return null;
      const base = this.readPath(inner, sc);
      return [...inner, { index: this.indexValues(node, base, sc), braces: bracesIndex(node) }];
    }
    if (node.type === 'field_expression') {
      const object = childField(node, 'object');
      if (!object) return null;
      let path = this.accessPath(object, sc);
      if (!path) return null;
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) !== 'field') continue;
        const f = node.child(i)!;
        if (f.type === 'identifier') path = [...path, { field: this.text(f, sc) }] as [string, ...Access[]];
        else if (f.type === 'function_call') {
          const fname = childField(f, 'name');
          if (!fname || fname.type !== 'identifier') return null;
          path = [...path, { field: this.text(fname, sc) }] as [string, ...Access[]];
          const base = this.readPath(path, sc);
          path = [...path, { index: this.indexValues(f, base, sc), braces: bracesIndex(f) }] as [string, ...Access[]];
        } else if (f.type === 'indirect_access') {
          const inner = namedChildren(f)[0];
          const name = inner ? textOf(this.ev(inner, sc)) : undefined;
          if (name === undefined) return null;
          path = [...path, { field: name }] as [string, ...Access[]];
        } else return null;
      }
      return path;
    }
    return null;
  }

  private readPath(path: readonly [string, ...Access[]], sc: Scope): Val {
    let v: Val | undefined = sc.vars.get(path[0]);
    for (const step of path.slice(1) as Access[]) {
      if (!v) return UNK;
      v = 'field' in step ? this.field(v, step.field) : step.index ? this.indexGet(v, step.index, step.braces) : UNK;
    }
    return v ?? UNK;
  }

  private setAt(base: Val | undefined, steps: Access[], value: Val, deletion: boolean): Val {
    if (steps.length === 0) return value;
    const [step, ...rest] = steps as [Access, ...Access[]];
    if ('field' in step) {
      if (base === undefined || (base.t === 'num' && base.v.length === 0)) base = { t: 'struct', v: [new Map()] };
      if (base.t !== 'struct' || base.v.length !== 1) return UNK;
      const record = new Map(base.v[0]!);
      record.set(step.field, this.setAt(record.get(step.field), rest, value, deletion && rest.length === 0 ? false : deletion));
      return { t: 'struct', v: [record] };
    }
    const index = step.index;
    if (!index) return UNK;
    if (rest.length > 0) {
      const pos = index.length === 1 && index[0]!.length === 1 ? index[0]![0]! : undefined;
      if (pos === undefined || pos > MAX_ELEMENTS) return UNK;
      if (step.braces) {
        const cells = base === undefined ? [] : base.t === 'cell' ? [...base.v] : null;
        if (!cells) return UNK;
        while (cells.length < pos) cells.push(EMPTY);
        cells[pos - 1] = this.setAt(cells[pos - 1], rest, value, deletion);
        return { t: 'cell', v: cells };
      }
      const records = base === undefined ? [] : base.t === 'struct' ? [...base.v] : null;
      if (!records) return UNK;
      while (records.length < pos) records.push(new Map());
      const inner = this.setAt({ t: 'struct', v: [records[pos - 1]!] }, rest, value, deletion);
      if (inner.t !== 'struct' || inner.v.length !== 1) return UNK;
      records[pos - 1] = inner.v[0]!;
      return { t: 'struct', v: records };
    }
    return this.indexSet(base, index, step.braces, value, deletion);
  }

  // -- indexing --------------------------------------------------------------

  /** The positions each index argument of `call` gives, `end` read against `base`; null for one not known. */
  private indexValues(call: SyntaxNode, base: Val, sc: Scope): number[][] | null {
    const args = callArgs(call);
    const n = numel(base);
    const out: number[][] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const col = isColumn(base);
      const endValue = n === undefined ? undefined : args.length === 1 ? n : (i === 0) === col ? n : n > 0 ? 1 : 0;
      if (a.type === 'spread_operator') {
        if (endValue === undefined) return null;
        out.push(Array.from({ length: endValue }, (_, k) => k + 1));
        continue;
      }
      sc.ends.push(endValue ?? NaN);
      let v: Val;
      try {
        v = this.ev(a, sc);
      } finally {
        sc.ends.pop();
      }
      if (v.t !== 'num') return null;
      if (v.logical) out.push(v.v.flatMap((x, k) => (x ? [k + 1] : [])));
      else {
        if (v.v.some((x) => !Number.isInteger(x) || x < 1)) {
          if (v.v.some((x) => Number.isNaN(x))) return null;
          throw new MatlabError('Index must be a positive integer');
        }
        out.push(v.v);
      }
    }
    return out;
  }

  /** The linear positions an index gives (`x(k)`, `x(1, k)` of a row), or null. */
  private linear(index: number[][], base?: Val): number[] | null {
    if (index.length === 1) return index[0]!;
    const col = base !== undefined && isColumn(base);
    if (index.length === 2 && index[col ? 1 : 0]!.every((r) => r === 1)) return index[col ? 0 : 1]!;
    return null;
  }

  private indexGet(base: Val, index: number[][] | null, braces: boolean): Val {
    if (!index) return UNK;
    if (base.t === 'fn' || base.t === 'unk') return UNK;
    const pos = this.linear(index, base);
    if (!pos) return UNK;
    const n = numel(base)!;
    if (pos.some((p) => p > n)) throw new MatlabError(`Index exceeds the number of array elements (${n})`);
    switch (base.t) {
      case 'char': return braces ? UNK : ch(pos.map((p) => base.s[p - 1]).join(''));
      case 'string': return braces ? UNK : base;
      case 'num': return braces ? UNK : { t: 'num', v: pos.map((p) => base.v[p - 1]!), logical: base.logical };
      case 'cell': return braces ? (pos.length === 1 ? base.v[pos[0]! - 1]! : UNK) : { t: 'cell', v: pos.map((p) => base.v[p - 1]!) };
      case 'struct': return braces ? UNK : { t: 'struct', v: pos.map((p) => base.v[p - 1]!) };
    }
  }

  private indexSet(base: Val | undefined, index: number[][], braces: boolean, value: Val, deletion: boolean): Val {
    const pos = this.linear(index, base);
    if (!pos) return UNK;
    // Past the size cap the value is not followed, and nothing is allocated.
    if (!deletion && pos.some((p) => p > MAX_ELEMENTS)) return UNK;
    if (deletion && !braces) {
      if (!base) return UNK;
      const drop = new Set(pos);
      switch (base.t) {
        case 'char': return ch([...base.s].filter((_, k) => !drop.has(k + 1)).join(''));
        case 'num': return { t: 'num', v: base.v.filter((_, k) => !drop.has(k + 1)), logical: base.logical };
        case 'cell': return { t: 'cell', v: base.v.filter((_, k) => !drop.has(k + 1)) };
        case 'struct': return { t: 'struct', v: base.v.filter((_, k) => !drop.has(k + 1)) };
        default: return UNK;
      }
    }
    if (braces) {
      const cells = base === undefined || (base.t === 'num' && base.v.length === 0) ? [] : base.t === 'cell' ? [...base.v] : null;
      if (!cells || pos.length !== 1) return UNK;
      while (cells.length < pos[0]!) cells.push(EMPTY);
      cells[pos[0]! - 1] = value;
      return { t: 'cell', v: cells };
    }
    if (base?.t === 'cell' || (base === undefined && value.t === 'cell')) {
      const cells = base?.t === 'cell' ? [...base.v] : [];
      const items = value.t === 'cell' ? value.v : null;
      if (!items || (items.length !== 1 && items.length !== pos.length)) return UNK;
      pos.forEach((p, k) => {
        while (cells.length < p) cells.push(EMPTY);
        cells[p - 1] = items[items.length === 1 ? 0 : k]!;
      });
      return { t: 'cell', v: cells };
    }
    if ((base === undefined || base.t === 'char') && value.t === 'char') {
      const chars = base?.t === 'char' ? [...base.s] : [];
      if (value.s.length !== 1 && value.s.length !== pos.length) return UNK;
      pos.forEach((p, k) => {
        while (chars.length < p) chars.push('\0');
        chars[p - 1] = value.s[value.s.length === 1 ? 0 : k]!;
      });
      return ch(chars.join(''));
    }
    if ((base === undefined || base.t === 'num') && value.t === 'num') {
      const nums = base?.t === 'num' ? [...base.v] : [];
      if (value.v.length !== 1 && value.v.length !== pos.length) return UNK;
      pos.forEach((p, k) => {
        while (nums.length < p) nums.push(0);
        nums[p - 1] = value.v[value.v.length === 1 ? 0 : k]!;
      });
      return { t: 'num', v: nums, logical: base ? base.logical && value.logical : value.logical };
    }
    if ((base === undefined || base.t === 'struct') && value.t === 'struct' && value.v.length === 1 && pos.length === 1) {
      const records = base?.t === 'struct' ? [...base.v] : [];
      while (records.length < pos[0]!) records.push(new Map());
      records[pos[0]! - 1] = value.v[0]!;
      return { t: 'struct', v: records };
    }
    return UNK;
  }

  private field(v: Val, name: string): Val {
    if (v.t === 'struct') {
      if (v.v.length !== 1) return UNK;
      const f = v.v[0]!.get(name);
      if (f === undefined) throw new MatlabError(`Unrecognized field name "${name}"`);
      return f;
    }
    return UNK;
  }

  // -- expressions -----------------------------------------------------------

  private ev(node: SyntaxNode, sc: Scope): Val {
    return this.evList(node, sc, 1)[0] ?? UNK;
  }

  /** A function call's first `n` outputs; any other expression's value, then unknowns. */
  private evMulti(node: SyntaxNode, sc: Scope, n: number): Val[] {
    if (node.type === 'function_call') {
      const out = this.evalCall(node, sc, n);
      return Array.from({ length: n }, (_, i) => out[i] ?? UNK);
    }
    if (node.type === 'identifier' && !sc.vars.has(this.text(node, sc))) {
      const out = this.callNamed(this.text(node, sc), [], n, sc, node);
      return Array.from({ length: n }, (_, i) => out[i] ?? UNK);
    }
    const first = this.ev(node, sc);
    return [first, ...Array.from({ length: n - 1 }, () => UNK)];
  }

  /** What an expression gives as a list: `c{:}` the cell's elements, anything else one value. */
  private evList(node: SyntaxNode, sc: Scope, nargout = 1): Val[] {
    switch (node.type) {
      case 'number': {
        const t = this.text(node, sc);
        const n = Number(t);
        return [Number.isNaN(n) ? UNK : num(n)];
      }
      case 'string': {
        const s = stringLiteral(node, sc.parsed.source);
        if (s === null) return [UNK];
        return [sc.parsed.source[node.startIndex] === '"' ? { t: 'string', s } : ch(s)];
      }
      case 'identifier': {
        const name = this.text(node, sc);
        const v = sc.vars.get(name);
        if (v !== undefined) return [v];
        return [this.callNamed(name, [], Math.max(nargout, 1), sc, node)[0] ?? UNK];
      }
      case 'end_keyword': {
        const e = sc.ends[sc.ends.length - 1];
        return [e === undefined || Number.isNaN(e) ? UNK : num(e)];
      }
      case 'parenthesis': {
        const inner = namedChildren(node)[0];
        return [inner ? this.ev(inner, sc) : UNK];
      }
      case 'function_call': {
        if (bracesIndex(node)) {
          const nameNode = childField(node, 'name');
          if (nameNode?.type === 'identifier' && sc.vars.has(this.text(nameNode, sc))) {
            const base = sc.vars.get(this.text(nameNode, sc))!;
            if (base.t === 'cell') {
              const index = this.indexValues(node, base, sc);
              const pos = index ? this.linear(index, base) : null;
              if (!pos) return [UNK];
              if (pos.some((p) => p > base.v.length)) throw new MatlabError('Index exceeds the number of array elements');
              return pos.map((p) => base.v[p - 1]!);
            }
          }
        }
        return [this.evalCall(node, sc, Math.max(nargout, 1))[0] ?? UNK];
      }
      case 'field_expression': {
        // `pkg.f(x)`, `obj.m(x)` on what is no variable: not followed.
        const head = this.headName(node, sc);
        if (head === null || !sc.vars.has(head)) return [UNK];
        const path = this.accessPath(node, sc);
        return [path ? this.readPath(path, sc) : UNK];
      }
      case 'matrix':
        return [this.concat(node, sc)];
      case 'cell': {
        const rows: Val[][] = [];
        for (const row of namedChildren(node)) {
          if (row.type !== 'row') continue;
          const items: Val[] = [];
          for (const e of namedChildren(row)) if (e.type !== 'comment' && e.type !== 'line_continuation') items.push(...this.evList(e, sc));
          if (items.length > 0) rows.push(items);
        }
        if (rows.length <= 1) return [{ t: 'cell', v: rows[0] ?? [] }];
        // `{a; b}` is a column; `{a, b; c, d}` a 2-D cell, not followed.
        return [rows.every((r) => r.length === 1) ? { t: 'cell', v: rows.map((r) => r[0]!), col: true } : UNK];
      }
      case 'range':
        return [this.range(node, sc)];
      case 'unary_operator': {
        const operand = childField(node, 'operand') ?? namedChildren(node)[0];
        const v = operand ? numbersOf(this.ev(operand, sc)) : undefined;
        const op = node.child(0)?.type;
        if (!v) return [UNK];
        return [num(...(op === '-' ? v.map((x) => -x) : v))];
      }
      case 'not_operator': {
        const inner = namedChildren(node)[0];
        const v = inner ? this.ev(inner, sc) : UNK;
        const n = numbersOf(v);
        return [n ? bools(n.map((x) => x === 0)) : UNK];
      }
      case 'postfix_operator': {
        const operand = childField(node, 'operand') ?? namedChildren(node)[0];
        const v = operand ? this.ev(operand, sc) : UNK;
        const op = node.child(node.childCount - 1)?.type;
        if (op !== "'" && op !== ".'") return [UNK];
        if ((v.t === 'num' || v.t === 'cell') && !isColumn(v) && v.v.length > 1) return [{ ...v, col: true }];
        if (isColumn(v)) return [{ ...(v as { t: 'num'; v: number[] }), col: false }];
        return [(v.t === 'num' || v.t === 'cell') && v.v.length <= 1 ? v : v.t === 'char' && v.s.length <= 1 ? v : v.t === 'string' ? v : UNK];
      }
      case 'boolean_operator':
        return [this.logical(node, sc)];
      case 'binary_operator':
      case 'comparison_operator':
        return [this.binary(node, sc)];
      case 'handle_operator': {
        const id = namedChildren(node).find((c) => c.type === 'identifier');
        return [id ? { t: 'fn', name: this.text(id, sc) } : UNK];
      }
      default:
        return [UNK];
    }
  }

  private operatorOf(node: SyntaxNode): string {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (!c.isNamed) return c.type;
    }
    return '';
  }

  private logical(node: SyntaxNode, sc: Scope): Val {
    const op = this.operatorOf(node);
    const kids = namedChildren(node);
    const left = childField(node, 'left') ?? kids[0];
    const right = childField(node, 'right') ?? kids[1];
    if (!left || !right) return UNK;
    const a = truth(this.ev(left, sc));
    if (op === '&&') {
      if (a === false) return bool(false);
      const b = truth(this.ev(right, sc));
      if (b === false) return bool(false);
      return a === true && b === true ? bool(true) : UNK;
    }
    if (op === '||') {
      if (a === true) return bool(true);
      const b = truth(this.ev(right, sc));
      if (b === true) return bool(true);
      return a === false && b === false ? bool(false) : UNK;
    }
    return UNK;
  }

  private binary(node: SyntaxNode, sc: Scope): Val {
    const kids = namedChildren(node).filter((c) => c.type !== 'comment' && c.type !== 'line_continuation');
    const left = childField(node, 'left') ?? kids[0];
    const right = childField(node, 'right') ?? kids[1];
    const op = this.operatorOf(node);
    if (!left || !right) return UNK;
    const a = this.ev(left, sc);
    const b = this.ev(right, sc);
    if (a.t === 'unk' || b.t === 'unk') return UNK;
    // String objects compare and add as texts.
    if (a.t === 'string' || b.t === 'string') {
      if (!isText(a) || !isText(b)) return UNK;
      if (op === '+') return { t: 'string', s: a.s + b.s };
      if (op === '==') return bool(a.s === b.s);
      if (op === '~=' || op === '!=') return bool(a.s !== b.s);
      return UNK;
    }
    const x = numbersOf(a);
    const y = numbersOf(b);
    if (!x || !y) return UNK;
    // Shapes are kept only so far (a row, a column): anything else is not followed.
    if ((x.length !== y.length && x.length !== 1 && y.length !== 1) || (x.length > 1 && y.length > 1 && isColumn(a) !== isColumn(b))) return UNK;
    const len = x.length === 1 ? y.length : x.length;
    const at = (v: number[], i: number): number => v[v.length === 1 ? 0 : i]!;
    const col = isColumn(a) || isColumn(b);
    const each = (f: (p: number, q: number) => number, logical = false): Val => {
      const out: number[] = [];
      for (let i = 0; i < len; i++) out.push(f(at(x, i), at(y, i)));
      return { t: 'num', v: out, logical, ...(col ? { col } : {}) };
    };
    switch (op) {
      case '+': return each((p, q) => p + q);
      case '-': return each((p, q) => p - q);
      case '.*': return each((p, q) => p * q);
      case './': return each((p, q) => p / q);
      case '.^': return each((p, q) => p ** q);
      case '*': return x.length === 1 || y.length === 1 ? each((p, q) => p * q) : UNK;
      case '/': return y.length === 1 ? each((p, q) => p / q) : UNK;
      case '^': return x.length === 1 && y.length === 1 ? num(x[0]! ** y[0]!) : UNK;
      case '==': return each((p, q) => (p === q ? 1 : 0), true);
      case '~=': case '!=': return each((p, q) => (p !== q ? 1 : 0), true);
      case '<': return each((p, q) => (p < q ? 1 : 0), true);
      case '>': return each((p, q) => (p > q ? 1 : 0), true);
      case '<=': return each((p, q) => (p <= q ? 1 : 0), true);
      case '>=': return each((p, q) => (p >= q ? 1 : 0), true);
      case '&': return each((p, q) => (p !== 0 && q !== 0 ? 1 : 0), true);
      case '|': return each((p, q) => (p !== 0 || q !== 0 ? 1 : 0), true);
      default: return UNK;
    }
  }

  private range(node: SyntaxNode, sc: Scope): Val {
    const parts = namedChildren(node).filter((c) => c.type !== 'comment');
    const vals = parts.map((p) => scalarOf(this.ev(p, sc)));
    if (vals.some((v) => v === undefined)) return UNK;
    const [start, step, stop] = vals.length === 3 ? [vals[0]!, vals[1]!, vals[2]!] : [vals[0]!, 1, vals[1]!];
    if (step === 0 || !Number.isFinite(start) || !Number.isFinite(stop)) return EMPTY;
    const out: number[] = [];
    for (let v = start, k = 0; step > 0 ? v <= stop + 1e-10 : v >= stop - 1e-10; v = start + ++k * step) {
      out.push(v);
      if (out.length > MAX_LOOP_ROUNDS) return UNK;
    }
    return { t: 'num', v: out };
  }

  /** `[a, b; c]`: texts, numbers or cells side by side; several rows only when one holds anything. */
  private concat(node: SyntaxNode, sc: Scope): Val {
    const rows: Val[][] = [];
    for (const row of namedChildren(node)) {
      if (row.type !== 'row') continue;
      const items: Val[] = [];
      for (const e of namedChildren(row)) if (e.type !== 'comment' && e.type !== 'line_continuation') items.push(...this.evList(e, sc));
      rows.push(items);
    }
    const filled = rows.filter((r) => r.some((v) => numel(v) !== 0));
    if (filled.length === 0) return rows.some((r) => r.some((v) => v.t === 'char')) ? ch('') : EMPTY;
    if (filled.length > 1) {
      // A column of scalars (or of columns) is a column; a matrix, or a column of texts (a char matrix), is not followed.
      const rowsJoined = filled.map((r) => {
        const items = r.filter((v) => numel(v) !== 0 || v.t === 'unk');
        return items.length === 1 ? items[0]! : UNK;
      });
      const isColPiece = (v: Val): boolean => (v.t === 'num' || v.t === 'cell') && (v.v.length === 1 || isColumn(v));
      if (rowsJoined.every((v) => v.t === 'num' && isColPiece(v))) {
        return { t: 'num', v: rowsJoined.flatMap((v) => (v as { v: number[] }).v), col: true, logical: rowsJoined.every((v) => (v as { logical?: boolean }).logical) };
      }
      if (rowsJoined.every((v) => v.t === 'cell' && isColPiece(v))) return { t: 'cell', v: rowsJoined.flatMap((v) => (v as { v: Val[] }).v), col: true };
      return UNK;
    }
    const items = filled[0]!.filter((v) => numel(v) !== 0 || v.t === 'unk');
    if (items.some((v) => v.t === 'unk')) return UNK;
    if (items.length === 1) return items[0]!;
    // A row of columns is a matrix: not followed.
    if (items.some(isColumn)) return UNK;
    if (items.some((v) => v.t === 'cell')) return items.every((v) => v.t === 'cell') ? { t: 'cell', v: items.flatMap((v) => (v as { v: Val[] }).v) } : UNK;
    if (items.some((v) => v.t === 'string')) return UNK;
    if (items.some((v) => v.t === 'struct')) return items.every((v) => v.t === 'struct') ? { t: 'struct', v: items.flatMap((v) => (v as { v: Map<string, Val>[] }).v) } : UNK;
    if (items.some((v) => v.t === 'fn')) return UNK;
    if (items.some((v) => v.t === 'char')) return ch(items.map((v) => (v.t === 'char' ? v.s : String.fromCharCode(...(v as { v: number[] }).v))).join(''));
    return { t: 'num', v: items.flatMap((v) => (v as { v: number[] }).v), logical: items.every((v) => (v as { logical?: boolean }).logical) };
  }

  // -- calls -----------------------------------------------------------------

  /** A `name(args)` expression: an index of a variable, else a call. */
  private evalCall(node: SyntaxNode, sc: Scope, nargout: number): Val[] {
    const nameNode = childField(node, 'name');
    if (!nameNode) return [UNK];
    if (nameNode.type !== 'identifier') {
      // `s.f(2)` written as a call of a field, `x{1}(2)`.
      const head = this.headName(node, sc);
      if (head === null || !sc.vars.has(head)) return [UNK];
      const path = this.accessPath(node, sc);
      if (path && sc.vars.has(path[0])) {
        const v = this.readPath(path, sc);
        return [v];
      }
      return [UNK];
    }
    const name = this.text(nameNode, sc);
    const v = sc.vars.get(name);
    if (v !== undefined) {
      if (v.t === 'fn') return this.callNamed(v.name, this.args(node, sc), nargout, sc, node);
      return [this.indexGet(v, this.indexValues(node, v, sc), bracesIndex(node))];
    }
    return this.callNamed(name, this.args(node, sc), nargout, sc, node);
  }

  private args(call: SyntaxNode, sc: Scope): Val[] {
    return callArgs(call).flatMap((a) => (a.type === 'spread_operator' ? [ch(':')] : this.evList(a, sc)));
  }

  /** Calls `name`: a local function of the running file, a path-affecting project function, a built-in. */
  private callNamed(name: string, args: Val[], nargout: number, sc: Scope, node: SyntaxNode): Val[] {
    const local = sc.parsed.functions.get(name);
    if (local) return this.runFunction(local, sc.file, sc.parsed, args, nargout, node, sc);
    const file = this.lookup(name, sc.file);
    if (file === undefined) {
      this.note(sc.file, `${name}: the current folder is not known, and what it runs depends on it: not followed`, node);
      return Array.from({ length: Math.max(1, nargout) }, () => UNK);
    }
    if (file !== null) return this.callFile(file, name, args, nargout, sc, node);
    return this.builtin(name, args, nargout, sc, node);
  }

  private callFile(file: string, name: string, args: Val[], nargout: number, sc: Scope, node: SyntaxNode): Val[] {
    const affecting = this.isPathAffecting(file);
    if (!affecting && nargout === 0) return [];
    const parsed = this.parseFile(file);
    if (!parsed || parsed.isClass) return [UNK];
    // Run for its path effect, it must parse cleanly; followed for its value
    // alone, a value it may not give is unknown.
    if (affecting) this.mustParse(file, parsed);
    else if (parsed.errorRow !== null) return [UNK];
    if (!parsed.main) {
      // A script runs in the caller's workspace.
      if (args.length > 0 || !affecting) return [UNK];
      this.runScript(file, parsed, sc);
      return [];
    }
    if (affecting) return this.runFunction(parsed.main, file, parsed, args, nargout, node, sc);
    // Followed for its value alone, on a budget of its own.
    const outer = this.valueLimit;
    this.valueLimit = Math.min(outer, this.steps + VALUE_CALL_STEPS);
    try {
      return this.runFunction(parsed.main, file, parsed, args, nargout, node, sc);
    } catch (e) {
      if (e instanceof ValueBudget && outer === Infinity) {
        this.note(sc.file, `${name} was followed for its value and took too long: its value is not known`, node);
        return [UNK];
      }
      throw e;
    } finally {
      this.valueLimit = outer;
    }
  }

  private runScript(file: string, parsed: ParsedFile, sc: Scope): void {
    if (this.depth >= this.maxDepth) {
      this.note(sc.file, `the call depth cap (${this.maxDepth}) was reached running ${file}: not followed`);
      return;
    }
    this.depth++;
    const saved = { file: sc.file, parsed: sc.parsed };
    sc.file = file;
    sc.parsed = parsed;
    try {
      this.runFrame(sc, parsed.root, () => this.execBlock(namedChildren(parsed.root), sc));
    } finally {
      sc.file = saved.file;
      sc.parsed = saved.parsed;
      this.depth--;
    }
  }

  /**
   * Runs a function's body (or a script's) in a frame of its own: a world
   * that returns early joins the one that gets to the end, and is what the
   * caller sees after the call. One that errors goes on out to its `catch`
   * while others return.
   */
  private runFrame(sc: Scope, node: SyntaxNode, body: () => Flow): void {
    const frame = this.pushFrame('function', sc);
    let error: MatlabError | null = null;
    try {
      body();
    } catch (e) {
      if (!(e instanceof MatlabError) || frame.parked.return.length === 0) throw e;
      error = e;
    } finally {
      this.popFrame(frame);
    }
    if (error) {
      this.park('error', this.world(sc, error.message), sc);
      this.enter(this.join(frame.parked.return, sc, node, 'code that returns early ends in different current folders'), sc);
    } else if (frame.parked.return.length > 0) {
      this.enter(this.join([this.world(sc), ...frame.parked.return], sc, node, 'code that returns early ends in a different current folder'), sc);
    }
  }

  private runFunction(def: SyntaxNode, file: string | null, parsed: ParsedFile, args: Val[], nargout: number, node: SyntaxNode, caller: Scope): Val[] {
    // Past the cap a call gives unknown values and changes nothing: a
    // recursion whose end an unknown value hides would otherwise run to the
    // cap on every branch, and stopping there would drop every path edit
    // after it.
    if (this.depth >= this.maxDepth) {
      this.note(caller.file, `the call depth cap (${this.maxDepth}) was reached calling ${file ?? 'a local function'}: not followed, its values not known`, node);
      return Array.from({ length: Math.max(1, nargout) }, () => UNK);
    }
    const source = parsed.source;
    const params: string[] = [];
    const paramsNode = namedChildren(def).find((c) => c.type === 'function_arguments');
    if (paramsNode) for (const p of namedChildren(paramsNode)) params.push(p.type === 'identifier' ? getNodeText(p, source) : '~');
    const outputs: string[] = [];
    const outNode = namedChildren(def).find((c) => c.type === 'function_output');
    if (outNode) {
      for (const o of namedChildren(outNode)) {
        if (o.type === 'identifier') outputs.push(getNodeText(o, source));
        else if (o.type === 'multioutput_variable') for (const x of namedChildren(o)) if (x.type === 'identifier') outputs.push(getNodeText(x, source));
      }
    }
    const vars = new Map<string, Val>();
    const variadic = params[params.length - 1] === 'varargin';
    const fixed = variadic ? params.slice(0, -1) : params;
    fixed.forEach((p, i) => {
      if (p !== '~' && i < args.length) vars.set(p, args[i]!);
    });
    if (variadic) vars.set('varargin', { t: 'cell', v: args.slice(fixed.length) });
    else if (args.length > params.length) throw new MatlabError('Too many input arguments');
    vars.set('nargin', num(args.length));
    vars.set('nargout', num(nargout));
    const sc: Scope = { vars, file, parsed, ends: [] };
    this.depth++;
    try {
      this.runFrame(sc, def, () => this.execBlock(this.body(def), sc));
    } finally {
      this.depth--;
    }
    const out: Val[] = [];
    for (const o of outputs) {
      if (o === 'varargout') {
        const vo = sc.vars.get('varargout');
        if (vo?.t === 'cell') out.push(...vo.v);
        else out.push(UNK);
      } else out.push(sc.vars.get(o) ?? UNK);
    }
    return out;
  }

  // -- built-ins -------------------------------------------------------------

  private builtin(name: string, args: Val[], nargout: number, sc: Scope, node: SyntaxNode): Val[] {
    const a = (i: number): Val => args[i] ?? UNK;
    const t = (i: number): string | undefined => textOf(args[i]);
    const unknownArgs = args.some((v) => v.t === 'unk');
    switch (name) {
      // ---- the path
      case 'addpath': return this.addpath(args, sc, node);
      case 'rmpath': {
        for (const folder of this.pathArgs(args, sc, node, 'rmpath')) {
          const i = this.path.indexOf(folder);
          if (i >= 0) this.path.splice(i, 1);
        }
        return [];
      }
      case 'path': {
        const current = ch(this.path.map((p) => this.out(p)).join(this.pathsep));
        if (args.length === 0) return [current];
        const folders = this.pathArgs(args, sc, node, 'path');
        if (args.some((v) => !isText(v))) return [current];
        this.path = [...new Set(folders)];
        return [current];
      }
      case 'restoredefaultpath':
        this.path = [];
        return [];
      case 'savepath': case 'pathtool': case 'rehash':
        return [];
      case 'genpath': {
        const d = t(0);
        if (d === undefined) return [UNK];
        const abs = this.toAbs(d);
        if (abs === null) return [UNK];
        const r = this.rel(abs);
        if (r === null) return [ch('')];
        // The folder and its subfolders, depth-first in `dir` order, less
        // class, package, private and resources folders: one listing asked
        // of the project per folder.
        const list: string[] = [];
        if (this.access.folderExists(r)) {
          const walk = (f: string): void => {
            list.push(f);
            for (const c of this.access.subfolders(f)) {
              if (c.startsWith('@') || c.startsWith('+') || c === 'private' || c === 'resources') continue;
              walk(f === '' ? c : `${f}/${c}`);
            }
          };
          walk(r);
        }
        return [ch(list.map((f) => this.out(this.abs(f))).join(this.pathsep))];
      }
      case 'userpath': case 'matlabroot': case 'tempdir': case 'prefdir':
        return [UNK];
      case 'pwd':
        return [this.here === null ? UNK : ch(this.out(this.here))];
      case 'cd': {
        const before = this.here === null ? UNK : ch(this.out(this.here));
        if (args.length === 0) return [before];
        const d = t(0);
        if (d === undefined) {
          this.note(sc.file, 'cd to a folder not known: the current folder is not known from here on', node);
          this.cwd = null;
          return [before];
        }
        const p = d.replace(/\\/g, '/');
        const absolute = /^[A-Za-z]:/.test(p) || p.startsWith('/');
        if (!absolute && this.cwd === null) {
          this.note(sc.file, `cd ${d}: the current folder is not known, not followed`, node);
          return [before];
        }
        // From each folder the current one may be, its own (one, for a
        // folder given in full).
        const targets = absolute ? [this.toAbs(d)!] : [...new Set(this.cwd!.map((c) => normalizeAbs(`${c}/${p}`)))];
        // A folder outside the project is MATLAB's to find: the current
        // folder becomes it, and what is added from there is outside too.
        const reached = targets.filter((abs) => this.rel(abs) === null || this.isFolder(abs));
        if (reached.length === 0) throw new MatlabError(`Cannot CD to ${d} (Name is nonexistent or not a directory).`);
        if (reached.length < targets.length) {
          // From some of them it is no folder: those stop on an error here.
          this.note(sc.file, `cd ${d}: not a folder from every folder the current one may be: the current folder is not known from here on`, node);
          this.cwd = null;
          return [before];
        }
        this.cwd = reached.length > MAX_CWD_CANDIDATES ? null : reached;
        return [before];
      }
      case 'run': {
        const s = t(0);
        if (s === undefined) {
          this.note(sc.file, 'run of a script not known: not followed', node);
          return [];
        }
        let file: string | null = null;
        if (/[\\/]/.test(s) || /\.[mM]$/.test(s)) {
          const abs = this.toAbs(/\.[mM]$/.test(s) ? s : `${s}.m`);
          if (abs === null) {
            this.note(sc.file, `run ${s}: the current folder is not known, not followed`, node);
            return [];
          }
          const r = this.rel(abs);
          file = r !== null && this.access.fileExists(r) ? r : null;
        } else {
          const found = this.which(s);
          if (found === undefined) {
            this.note(sc.file, `run ${s}: the current folder is not known, and what it runs depends on it: not followed`, node);
            return [];
          }
          file = found;
        }
        if (file === null) throw new MatlabError(`RUN cannot execute the file '${s}'.`);
        const parsed = this.parseFile(file);
        if (!parsed) return [];
        this.mustParse(file, parsed);
        const before = this.cwd;
        const there: Cwd = [this.abs(dirOf(file))];
        this.cwd = there;
        try {
          if (parsed.main) this.runFunction(parsed.main, file, parsed, [], 0, node, sc);
          else this.runScript(file, parsed, sc);
        } finally {
          if (sameCwd(this.cwd, there)) this.cwd = before;
        }
        return [];
      }
      case 'eval': {
        const code = t(0);
        if (code === undefined) {
          this.note(sc.file, 'eval of text not known: not followed', node);
          return [UNK];
        }
        const parsed = this.parseText(code);
        if (!parsed || parsed.root.hasError) {
          this.note(sc.file, 'eval of text that does not parse: not followed', node);
          return [UNK];
        }
        const saved = sc.parsed;
        const evalScope: Scope = { vars: sc.vars, file: sc.file, parsed: { ...parsed, functions: saved.functions, main: saved.main }, ends: [] };
        try {
          this.execBlock(namedChildren(parsed.root), evalScope);
        } catch (e) {
          if (e instanceof MatlabError && args.length > 1 && t(1) !== undefined) {
            const fallback = this.parseText(t(1)!);
            if (fallback && !fallback.root.hasError) this.execBlock(namedChildren(fallback.root), { ...evalScope, parsed: { ...fallback, functions: saved.functions, main: saved.main } });
          } else throw e;
        } finally {
          sc.vars = evalScope.vars;
        }
        return [];
      }
      case 'evalin': case 'assignin': case 'evalc':
        return [UNK];
      case 'feval': {
        const f = a(0);
        const fname = f.t === 'fn' ? f.name : textOf(f);
        if (fname === undefined || !/^[A-Za-z]\w*$/.test(fname)) return [UNK];
        return this.callNamed(fname, args.slice(1), nargout, sc, node);
      }
      case 'str2func': {
        const s = t(0);
        return [s !== undefined && /^@?[A-Za-z]\w*$/.test(s) ? { t: 'fn', name: s.replace(/^@/, '') } : UNK];
      }
      case 'func2str':
        return [a(0).t === 'fn' ? ch((a(0) as { name: string }).name) : UNK];
      // ---- path text and lookup
      case 'fullfile': {
        if (args.length === 0) return [ch('')];
        if (unknownArgs || !args.every(isText)) return [UNK];
        const parts = args.map((v) => (v as { s: string }).s).filter((s) => s !== '');
        if (parts.length === 0) return [ch('')];
        const sep = this.filesep;
        let out = parts[0]!;
        for (const p of parts.slice(1)) {
          const left = out.replace(/[\\/]+$/, '');
          const right = p.replace(/^[\\/]+/, '');
          out = `${left}${sep}${right}`;
        }
        if (this.pc) out = out.replace(/\//g, '\\');
        return [ch(out.replace(this.pc ? /\\{2,}/g : /\/{2,}/g, sep))];
      }
      case 'fileparts': {
        const p = t(0);
        if (p === undefined) return [UNK, UNK, UNK];
        const cut = this.pc ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : p.lastIndexOf('/');
        let dir = cut < 0 ? '' : p.slice(0, cut);
        if (cut === 0) dir = p[0]!;
        const fileName = p.slice(cut + 1);
        const dot = fileName.lastIndexOf('.');
        const base = dot < 0 ? fileName : fileName.slice(0, dot);
        const ext = dot < 0 ? '' : fileName.slice(dot);
        return [ch(dir), ch(base), ch(ext)];
      }
      case 'filesep': return [ch(this.filesep)];
      case 'pathsep': return [ch(this.pathsep)];
      case 'mfilename': {
        const mode = t(0);
        if (sc.file === null) return [ch('')];
        const stem = matlabFileStem(sc.file) ?? sc.file.replace(/^.*\//, '').replace(/\.[mM]$/, '');
        if (mode === 'fullpath') return [ch(this.out(this.abs(sc.file.replace(/\.[mM]$/, ''))))];
        if (mode === 'class') return [ch('')];
        return [ch(stem)];
      }
      case 'which': {
        const s = t(0);
        if (s === undefined || args.length > 1) return [UNK];
        if (!/^[A-Za-z]\w*(\.m)?$/.test(s)) return [UNK];
        const stem = s.replace(/\.m$/, '');
        const hit = this.which(stem);
        if (hit === undefined) return [UNK];
        if (hit !== null) return [ch(this.out(this.abs(hit)))];
        return [MATLAB_BUILTINS.has(stem) ? UNK : ch('')];
      }
      case 'exist': return [this.exist(args, sc)];
      case 'isfolder': case 'isdir': {
        const s = t(0);
        if (s === undefined) return [UNK];
        return [this.agreed(() => {
          const abs = this.toAbs(s);
          return abs === null ? UNK : bool(this.isFolder(abs));
        })];
      }
      case 'isfile': {
        const s = t(0);
        if (s === undefined) return [UNK];
        return [this.agreed(() => {
          const abs = this.toAbs(s);
          const r = abs === null ? null : this.rel(abs);
          if (r === null) return UNK;
          if (this.access.fileExists(r)) return bool(true);
          return /\.[mM]$/.test(r) ? bool(false) : UNK;
        })];
      }
      // ---- environment
      case 'getenv': {
        const s = t(0);
        return [s === undefined ? UNK : ch(this.env.get(s) ?? '')];
      }
      case 'setenv': {
        const k = t(0);
        if (k !== undefined) {
          const v = args.length > 1 ? t(1) : '';
          if (v === undefined) this.env.delete(k);
          else this.env.set(k, v);
        }
        return [];
      }
      case 'computer': {
        if (t(0) === 'arch') return [ch(MATLAB_COMPUTERS[this.settings.computer] ?? '')];
        if (args.length > 0) return [UNK];
        return [ch(this.settings.computer), UNK, UNK];
      }
      case 'ispc': return [bool(this.pc)];
      case 'isunix': return [bool(!this.pc)];
      case 'ismac': return [bool(this.settings.computer.startsWith('MAC'))];
      case 'isdeployed': case 'isstudent': return [bool(false)];
      case 'version': {
        const rel = MATLAB_RELEASES[this.release]!;
        const mode = t(0);
        if (args.length === 0) return [ch(`${rel.version}.0.0 (${this.release})`), ch(rel.date)];
        if (mode === '-date') return [ch(rel.date)];
        if (mode === '-release') return [ch(this.release.slice(1))];
        if (mode === '-description') return [ch('')];
        return [UNK];
      }
      case 'ver': {
        const product = t(0);
        if (product === undefined || product.toLowerCase() !== 'matlab') return [UNK];
        const rel = MATLAB_RELEASES[this.release]!;
        const date = new Date(Date.parse(rel.date + ' UTC'));
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dd = `${String(date.getUTCDate()).padStart(2, '0')}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
        return [{ t: 'struct', v: [new Map<string, Val>([['Name', ch('MATLAB')], ['Version', ch(rel.version)], ['Release', ch(`(${this.release})`)], ['Date', ch(dd)]])] }];
      }
      case 'verLessThan': {
        const product = t(0);
        const v = t(1);
        if (product?.toLowerCase() !== 'matlab' || v === undefined) return [UNK];
        return [bool(compareVersions(MATLAB_RELEASES[this.release]!.version, v) < 0)];
      }
      case 'isMATLABReleaseOlderThan': {
        const r = t(0);
        if (r === undefined || !/^R\d{4}[ab]$/.test(r)) return [UNK];
        return [bool(this.release < r)];
      }
      case 'datenum': return [this.datenum(args)];
      // ---- output and things passed over
      case 'fprintf': case 'disp': case 'display': case 'warning': case 'drawnow': case 'setad': case 'clc':
      case 'close': case 'format': case 'more': case 'beep': case 'pause': case 'hold': case 'figure': case 'diary':
      case 'narginchk': case 'nargoutchk': case 'nargchk': case 'dbstop': case 'keyboard':
        return [];
      case 'clear': case 'clearvars': {
        const names = args.map(textOf);
        if (names.some((n) => n === undefined)) return [];
        const vars = names.filter((n) => n !== undefined && !n.startsWith('-') && n !== 'all' && n !== 'variables' && n !== 'functions' && n !== 'global' && n !== 'classes' && n !== 'java') as string[];
        if (vars.length === 0) {
          if (names.length === 0 || names.some((n) => n === 'all' || n === 'variables' || n === '-all')) sc.vars.clear();
        } else for (const n of vars) sc.vars.delete(n);
        return [];
      }
      case 'error': {
        if (args.length === 1 && isText(a(0)) && (a(0) as { s: string }).s === '') return [];
        const first = a(0);
        if (args.length === 1 && first.t === 'struct' && first.v.length === 0) return [];
        throw new MatlabError(textOf(args.length > 1 && textOf(a(0))?.includes(':') && !textOf(a(0))?.includes(' ') ? a(1) : a(0)) ?? 'error');
      }
      case 'rethrow': case 'throw': case 'throwAsCaller': {
        const e = a(0);
        const msg = e.t === 'struct' && e.v.length === 1 ? textOf(e.v[0]!.get('message')) : undefined;
        throw new MatlabError(msg ?? 'error');
      }
      case 'assert': {
        const c = truth(a(0));
        if (c === false) throw new MatlabError(t(1) ?? 'Assertion failed.');
        return [];
      }
      // ---- text
      case 'strcmp': case 'strcmpi': case 'strncmp': case 'strncmpi': {
        const n = name.startsWith('strn') ? scalarOf(a(2)) : undefined;
        if (name.startsWith('strn') && n === undefined) return [UNK];
        const ci = name.endsWith('i');
        const eq = (x: Val, y: Val): boolean | undefined => {
          if (x.t === 'unk' || y.t === 'unk') return undefined;
          if (!isText(x) || !isText(y)) return false;
          let p = x.s;
          let q = y.s;
          if (ci) {
            p = p.toLowerCase();
            q = q.toLowerCase();
          }
          if (n !== undefined) return p.length >= n && q.length >= n && p.slice(0, n) === q.slice(0, n);
          return p === q;
        };
        const x = a(0);
        const y = a(1);
        if (x.t === 'cell' || y.t === 'cell') {
          const cells = x.t === 'cell' ? x : (y as { v: Val[] });
          const other = x.t === 'cell' ? y : x;
          if (other.t === 'cell') {
            if (other.v.length !== cells.v.length) return [UNK];
            const r = cells.v.map((c, i) => eq(c, other.v[i]!));
            return [r.some((b) => b === undefined) ? UNK : bools(r as boolean[])];
          }
          const r = cells.v.map((c) => eq(c, other));
          return [r.some((b) => b === undefined) ? UNK : bools(r as boolean[])];
        }
        const r = eq(x, y);
        return [r === undefined ? UNK : bool(r)];
      }
      case 'isequal': {
        if (args.length < 2 || unknownArgs) return [UNK];
        const first = args[0]!;
        return [bool(args.slice(1).every((v) => (isText(v) && isText(first) ? v.s === first.s : sameVal(v, first))))];
      }
      case 'lower': case 'upper': case 'strtrim': case 'deblank': {
        const f = (s: string): string =>
          name === 'lower' ? s.toLowerCase() : name === 'upper' ? s.toUpperCase() : name === 'strtrim' ? s.replace(/^[\s\0]+|[\s\0]+$/g, '') : s.replace(/[\s\0]+$/g, '');
        const v = a(0);
        if (v.t === 'char') return [ch(f(v.s))];
        if (v.t === 'string') return [{ t: 'string', s: f(v.s) }];
        if (v.t === 'cell' && v.v.every(isText)) return [{ t: 'cell', v: v.v.map((x) => ({ ...(x as { t: 'char'; s: string }), s: f((x as { s: string }).s) })) }];
        return [UNK];
      }
      case 'strcat': {
        if (unknownArgs || !args.every((v) => v.t === 'char')) return [UNK];
        return [ch(args.map((v) => (v as { s: string }).s.replace(/[ \t\n\0]+$/, '')).join(''))];
      }
      case 'sprintf': {
        const fmt = t(0);
        if (fmt === undefined) return [UNK];
        const r = sprintf(fmt, args.slice(1));
        return [r === undefined ? UNK : ch(r)];
      }
      case 'num2str': case 'int2str': {
        const v = a(0);
        if (v.t === 'char') return [v];
        const n = scalarOf(v);
        if (n === undefined || v.t !== 'num') return [UNK];
        if (name === 'int2str') return [ch(String(Math.round(n)))];
        return [ch(Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(5))))];
      }
      case 'str2num': {
        const s = t(0);
        if (s === undefined) return [UNK, bool(false)];
        const r = parseNumbers(s);
        return r === undefined ? [UNK, UNK] : [r, bool(true)];
      }
      case 'str2double': {
        const s = t(0);
        if (s === undefined) return [UNK];
        const x = s.trim() === '' ? NaN : Number(s.trim());
        return [num(Number.isNaN(x) ? NaN : x)];
      }
      case 'strrep': {
        const [s, from, to] = [t(0), t(1), t(2)];
        if (s === undefined || from === undefined || to === undefined) return [UNK];
        return [ch(from === '' ? s : s.split(from).join(to))];
      }
      case 'strfind': case 'findstr': {
        let [s, p] = [t(0), t(1)];
        if (s === undefined || p === undefined) return [UNK];
        if (name === 'findstr' && p.length > s.length) [s, p] = [p, s];
        const out: number[] = [];
        if (p !== '') for (let i = s.indexOf(p); i >= 0; i = s.indexOf(p, i + 1)) out.push(i + 1);
        return [{ t: 'num', v: out }];
      }
      case 'strsplit': {
        const s = t(0);
        if (s === undefined) return [UNK];
        const d = args.length > 1 ? (a(1).t === 'cell' ? undefined : t(1)) : undefined;
        if (args.length > 1 && d === undefined) return [UNK];
        const parts = d === undefined ? s.split(/\s+/) : s.split(d.replace(/\\t/g, '\t').replace(/\\n/g, '\n'));
        return [{ t: 'cell', v: parts.map((x) => ch(x)) }];
      }
      case 'strjoin': {
        const c = a(0);
        const d = args.length > 1 ? t(1) : ' ';
        if (c.t !== 'cell' || d === undefined || !c.v.every(isText)) return [UNK];
        return [ch(c.v.map((x) => (x as { s: string }).s).join(d))];
      }
      case 'regexprep': {
        const [s, pat, rep] = [t(0), t(1), t(2)];
        if (s === undefined || pat === undefined || rep === undefined) return [UNK];
        const opts = args.slice(3).map(textOf);
        if (opts.some((o) => o === undefined || !['ignorecase', 'once'].includes(o.toLowerCase()))) return [UNK];
        if (/\(\?[<!=]|\\[<>]|\(\?@/.test(pat)) return [UNK];
        try {
          const flags = (opts.some((o) => o!.toLowerCase() === 'once') ? '' : 'g') + (opts.some((o) => o!.toLowerCase() === 'ignorecase') ? 'i' : '');
          return [ch(s.replace(new RegExp(pat, flags), rep))];
        } catch {
          return [UNK];
        }
      }
      case 'contains': case 'startsWith': case 'endsWith': {
        const s = a(0);
        const p = a(1);
        const ci = args.length >= 4 && textOf(a(2))?.toLowerCase() === 'ignorecase' ? truth(a(3)) : false;
        if (ci === undefined || !isText(s)) return [UNK];
        const pats = p.t === 'cell' ? p.v : [p];
        if (!pats.every(isText)) return [UNK];
        const norm = (x: string): string => (ci ? x.toLowerCase() : x);
        const hay = norm(s.s);
        const hit = pats.some((q) => {
          const needle = norm((q as { s: string }).s);
          return name === 'contains' ? hay.includes(needle) : name === 'startsWith' ? hay.startsWith(needle) : hay.endsWith(needle);
        });
        return [bool(hit)];
      }
      case 'strtok': {
        const s = t(0);
        if (s === undefined) return [UNK, UNK];
        const delims = args.length > 1 ? t(1) : ' \t\n\v\f\r\0';
        if (delims === undefined) return [UNK, UNK];
        let i = 0;
        while (i < s.length && delims.includes(s[i]!)) i++;
        let j = i;
        while (j < s.length && !delims.includes(s[j]!)) j++;
        return [ch(s.slice(i, j)), ch(s.slice(j))];
      }
      case 'blanks': {
        const n = scalarOf(a(0));
        return [n === undefined || n < 0 || n > MAX_EVAL_TEXT ? UNK : ch(' '.repeat(n))];
      }
      case 'char': {
        const v = a(0);
        if (v.t === 'char') return [v];
        if (v.t === 'string') return [ch(v.s)];
        if (v.t === 'num' && args.length === 1) return [ch(String.fromCharCode(...v.v))];
        if (v.t === 'cell' && v.v.length === 1 && isText(v.v[0]!)) return [ch((v.v[0] as { s: string }).s)];
        return [UNK];
      }
      case 'string': {
        const v = a(0);
        return [isText(v) ? { t: 'string', s: v.s } : UNK];
      }
      case 'double': {
        const v = a(0);
        const n = numbersOf(v);
        return [n ? num(...n) : v.t === 'string' ? num(Number(v.s)) : UNK];
      }
      case 'logical': {
        const n = numbersOf(a(0));
        return [n ? bools(n.map((x) => x !== 0)) : UNK];
      }
      case 'true': case 'false': {
        if (args.length > 0) return [UNK];
        return [bool(name === 'true')];
      }
      case 'pi': return [num(Math.PI)];
      case 'Inf': case 'inf': return [num(Infinity)];
      case 'NaN': case 'nan': return [num(NaN)];
      case 'eps': return [num(Number.EPSILON)];
      case 'fliplr': {
        const v = a(0);
        if (v.t === 'char') return [ch([...v.s].reverse().join(''))];
        if (v.t === 'num') return [{ ...v, v: [...v.v].reverse() }];
        if (v.t === 'cell') return [{ t: 'cell', v: [...v.v].reverse() }];
        return [UNK];
      }
      // ---- arrays and logic
      case 'isempty': {
        const n = numel(a(0));
        return [n === undefined ? UNK : bool(n === 0)];
      }
      case 'ischar': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'char')];
      case 'isstring': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'string')];
      case 'isnumeric': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'num' && !(a(0) as { logical?: boolean }).logical)];
      case 'islogical': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'num' && !!(a(0) as { logical?: boolean }).logical)];
      case 'iscell': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'cell')];
      case 'iscellstr': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'cell' && (a(0) as { v: Val[] }).v.every((x) => x.t === 'char'))];
      case 'isstruct': return [a(0).t === 'unk' ? UNK : bool(a(0).t === 'struct')];
      case 'isa': {
        const cls = t(1);
        const v = a(0);
        if (v.t === 'unk' || cls === undefined) return [UNK];
        const kinds: Record<string, string> = { char: 'char', string: 'string', cell: 'cell', struct: 'struct', fn: 'function_handle' };
        if (v.t === 'num') return [cls === 'numeric' || cls === 'float' || cls === 'double' ? bool(!v.logical) : cls === 'logical' ? bool(!!v.logical) : bool(false)];
        return [bool(kinds[v.t] === cls)];
      }
      case 'isfield': {
        const s = a(0);
        const f = a(1);
        if (s.t === 'unk' || f.t === 'unk') return [UNK];
        if (s.t !== 'struct') return [bool(false)];
        const has = (x: Val): boolean => isText(x) && s.v.length > 0 && s.v[0]!.has(x.s);
        return [f.t === 'cell' ? bools(f.v.map(has)) : bool(has(f))];
      }
      case 'fieldnames': {
        const s = a(0);
        return [s.t === 'struct' && s.v.length > 0 ? { t: 'cell', v: [...s.v[0]!.keys()].map((k) => ch(k)) } : UNK];
      }
      case 'struct': {
        if (args.length % 2 !== 0 || unknownArgs) return [UNK];
        const record = new Map<string, Val>();
        for (let i = 0; i < args.length; i += 2) {
          const k = t(i);
          let v = a(i + 1);
          if (k === undefined) return [UNK];
          if (v.t === 'cell') {
            if (v.v.length !== 1) return [UNK];
            v = v.v[0]!;
          }
          record.set(k, v);
        }
        return [{ t: 'struct', v: [record] }];
      }
      case 'class': {
        const v = a(0);
        const names: Record<string, string> = { char: 'char', string: 'string', cell: 'cell', struct: 'struct', fn: 'function_handle' };
        if (v.t === 'num') return [ch(v.logical ? 'logical' : 'double')];
        return [v.t === 'unk' ? UNK : ch(names[v.t]!)];
      }
      case 'deal': {
        if (args.length === 1) return Array.from({ length: Math.max(1, nargout) }, () => args[0]!);
        return args;
      }
      case 'length': case 'numel': {
        const v = a(0);
        const n = numel(v);
        return [n === undefined ? UNK : num(n)];
      }
      case 'size': {
        const n = numel(a(0));
        if (n === undefined) return [UNK, UNK];
        const dims = isColumn(a(0)) ? [n, 1] : [n === 0 ? 0 : 1, n];
        if (args.length > 1) {
          const d = scalarOf(a(1));
          return [d === undefined ? UNK : num(d === 1 ? dims[0]! : d === 2 ? dims[1]! : 1)];
        }
        return nargout > 1 ? [num(dims[0]!), num(dims[1]!)] : [num(...dims)];
      }
      case 'any': case 'all': {
        const n = numbersOf(a(0));
        if (!n || args.length > 1) return [UNK];
        return [bool(name === 'any' ? n.some((x) => x !== 0 && !Number.isNaN(x)) : n.every((x) => x !== 0))];
      }
      case 'find': {
        const n = numbersOf(a(0));
        if (!n) return [UNK];
        let out = n.flatMap((x, i) => (x !== 0 ? [i + 1] : []));
        const k = args.length > 1 ? scalarOf(a(1)) : undefined;
        if (args.length > 1 && k === undefined) return [UNK];
        if (k !== undefined) out = textOf(a(2)) === 'last' ? out.slice(-k) : out.slice(0, k);
        return [{ t: 'num', v: out }];
      }
      case 'ismember': {
        const x = a(0);
        const set = a(1);
        if (x.t === 'unk' || set.t === 'unk') return [UNK];
        if (isText(x) && set.t === 'cell') return [bool(set.v.some((v) => isText(v) && v.s === x.s))];
        if (x.t === 'cell' && set.t === 'cell') return [bools(x.v.map((e) => isText(e) && set.v.some((v) => isText(v) && v.s === e.s)))];
        const p = numbersOf(x);
        const q = numbersOf(set);
        if (!p || !q || x.t === 'char' || set.t === 'char') return [UNK];
        return [bools(p.map((e) => q.includes(e)))];
      }
      case 'max': case 'min': {
        const p = numbersOf(a(0));
        if (!p) return [UNK];
        const f = name === 'max' ? Math.max : Math.min;
        if (args.length === 1) {
          if (p.length === 0) return [EMPTY];
          const best = f(...p);
          return [num(best), num(p.indexOf(best) + 1)];
        }
        const q = numbersOf(a(1));
        if (!q || (p.length !== q.length && p.length !== 1 && q.length !== 1)) return [UNK];
        const len = Math.max(p.length, q.length);
        return [{ t: 'num', v: Array.from({ length: len }, (_, i) => f(p[p.length === 1 ? 0 : i]!, q[q.length === 1 ? 0 : i]!)) }];
      }
      case 'floor': case 'ceil': case 'round': case 'abs': case 'fix': {
        const p = numbersOf(a(0));
        if (!p) return [UNK];
        const f = { floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs, fix: Math.trunc }[name]!;
        return [{ t: 'num', v: p.map(f) }];
      }
      case 'mod': case 'rem': {
        const x = scalarOf(a(0));
        const y = scalarOf(a(1));
        if (x === undefined || y === undefined) return [UNK];
        if (y === 0) return [num(name === 'mod' ? x : NaN)];
        return [num(name === 'mod' ? x - Math.floor(x / y) * y : x - Math.trunc(x / y) * y)];
      }
      case 'sum': {
        const p = numbersOf(a(0));
        return [p && args.length === 1 ? num(p.reduce((s, x) => s + x, 0)) : UNK];
      }
      case 'xor': {
        const x = truth(a(0));
        const y = truth(a(1));
        return [x === undefined || y === undefined ? UNK : bool(x !== y)];
      }
      case 'not': {
        const p = numbersOf(a(0));
        return [p ? bools(p.map((x) => x === 0)) : UNK];
      }
      case 'zeros': case 'ones': {
        if (args.length === 0) return [num(name === 'ones' ? 1 : 0)];
        const dims = args.map(scalarOf);
        if (dims.some((d) => d === undefined) || dims.length > 2 || (dims.length === 2 && dims[0] !== 1)) return [UNK];
        const n = dims.length === 1 ? (dims[0] === 0 ? 0 : dims[0]! === 1 ? 1 : NaN) : dims[1]!;
        if (Number.isNaN(n) || n > MAX_ELEMENTS) return [UNK];
        return [{ t: 'num', v: Array.from({ length: n }, () => (name === 'ones' ? 1 : 0)) }];
      }
      case 'cell': {
        const dims = args.map(scalarOf);
        if (dims.length === 0) return [{ t: 'cell', v: [] }];
        if (dims.some((d) => d === undefined)) return [UNK];
        const n = dims.length === 1 ? (dims[0] === 0 ? 0 : dims[0] === 1 ? 1 : NaN) : dims[0] === 1 ? dims[1]! : dims[1] === 1 ? dims[0]! : NaN;
        if (Number.isNaN(n) || n > MAX_ELEMENTS) return [UNK];
        return [{ t: 'cell', v: Array.from({ length: n }, () => EMPTY) }];
      }
      case 'isspace': {
        const s = t(0);
        return [s === undefined ? UNK : bools([...s].map((c) => /\s/.test(c)))];
      }
      default:
        return Array.from({ length: Math.max(1, nargout) }, () => UNK);
    }
  }

  private pathArgs(args: Val[], sc: Scope, node: SyntaxNode, what: string): string[] {
    const out: string[] = [];
    for (const v of args) {
      if (v.t === 'unk' || !isText(v)) {
        this.note(sc.file, `${what} of a folder not known: passed over`, node);
        continue;
      }
      if (v.s.startsWith('-') && !v.s.includes(this.pathsep)) continue;
      for (const part of v.s.split(this.pathsep)) {
        if (part.trim() === '') continue;
        const abs = this.toAbs(part.trim());
        if (abs === null) {
          this.note(sc.file, `${what} ${part}: the current folder is not known, passed over`, node);
          continue;
        }
        const r = this.rel(abs);
        if (r === null) {
          this.note(sc.file, `${what} ${abs}: outside the project, passed over`, node);
          continue;
        }
        if (!this.access.folderExists(r)) {
          this.note(sc.file, `${what} ${r || '.'}: no indexed file there, passed over`, node);
          continue;
        }
        out.push(abs);
      }
    }
    return out;
  }

  private addpath(args: Val[], sc: Scope, node: SyntaxNode): Val[] {
    const before = ch(this.path.map((p) => this.out(p)).join(this.pathsep));
    let atEnd = false;
    const folders: Val[] = [];
    for (const v of args) {
      const s = textOf(v);
      if (s !== undefined && /^-(?:end|begin|frozen|BEGIN|END)$/i.test(s) && !s.includes(this.pathsep)) {
        if (s.toLowerCase() === '-end') atEnd = true;
        if (s.toLowerCase() === '-begin') atEnd = false;
        continue;
      }
      if (v.t === 'num' && v.v.length === 1) {
        atEnd = v.v[0] === 1;
        continue;
      }
      folders.push(v);
    }
    const added = [...new Set(this.pathArgs(folders, sc, node, 'addpath'))];
    const rest = this.path.filter((p) => !added.includes(p));
    this.path = atEnd ? [...rest, ...added] : [...added, ...rest];
    return [before];
  }

  /** `exist(…)`, asked from each folder the current one may be: its answer when they agree, else unknown. */
  private exist(args: Val[], sc: Scope): Val {
    return this.agreed(() => this.existHere(args, sc));
  }

  /** A value `ask` gives alike from each folder the current one may be (see agree); unknown when they differ. */
  private agreed(ask: () => Val): Val {
    return this.agree(ask, sameVal)?.value ?? UNK;
  }

  private existHere(args: Val[], sc: Scope): Val {
    const nameVal = args[0];
    const s = textOf(nameVal);
    const kind = args.length > 1 ? textOf(args[1]) : '';
    if (s === undefined || kind === undefined) return UNK;
    if (kind === 'var') return num(sc.vars.has(s) ? 1 : 0);
    if (kind === 'builtin') return s === 'OCTAVE_VERSION' ? num(0) : UNK;
    if (s === 'OCTAVE_VERSION') return num(0);
    if (kind === '' && sc.vars.has(s)) return num(1);
    const pathLike = /[\\/]/.test(s) || /\.\w+$/.test(s);
    if (kind === 'dir' || pathLike) {
      const abs = this.toAbs(s);
      if (abs === null) return UNK;
      const r = this.rel(abs);
      if (r !== null && this.access.folderExists(r)) return num(7);
      if (kind === 'dir') return num(0);
      if (r !== null && this.access.fileExists(r)) return num(2);
      // A file the index does not hold may still be there (a .mat, a .txt): only an absent `.m` is known absent.
      if (r !== null && /\.[mM]$/.test(r)) return num(0);
      if (kind === 'file' || kind === '') {
        if (!/\.\w+$/.test(s)) return num(0);
        return UNK;
      }
      return UNK;
    }
    if (kind === 'file' || kind === '') {
      const hit = this.which(s);
      if (hit === undefined) return UNK;
      if (hit !== null) return num(2);
      // A folder of that name in the current one: not known where that is.
      if (this.here === null) return UNK;
      if (this.isFolder(normalizeAbs(`${this.here}/${s}`))) return num(7);
      return MATLAB_BUILTINS.has(s) ? UNK : num(0);
    }
    if (kind === 'class') return UNK;
    return UNK;
  }

  private datenum(args: Val[]): Val {
    if (args.length >= 3 && args.every((v) => scalarOf(v) !== undefined)) {
      const [y, m, d] = args.map((v) => scalarOf(v)!);
      return num(daysFromCivil(y!, m!, d!));
    }
    const s = textOf(args[0]);
    if (s === undefined || args.length > 2) return UNK;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    let m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s*$/.exec(s);
    if (m) {
      const month = months.indexOf(m[2]!.toLowerCase());
      if (month >= 0) return num(daysFromCivil(Number(m[3]), month + 1, Number(m[1])));
    }
    m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(s);
    if (m) {
      const month = months.indexOf(m[1]!.slice(0, 3).toLowerCase());
      if (month >= 0) return num(daysFromCivil(Number(m[3]), month + 1, Number(m[2])));
    }
    return UNK;
  }
}

/** One step into a value: a field, or an index (null when not known). */
type Access = { field: string } | { index: number[][] | null; braces: boolean };

/** MATLAB's `datenum` of a day: days from year 0 (`datenum(1970,1,1)` is 719529). */
function daysFromCivil(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000) + 719_529;
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** `str2num` of a plain number or a row of them (`'7.4'`, `'[1 2]'`, `'true'`). */
function parseNumbers(s: string): Val | undefined {
  const text = s.trim().replace(/^\[(.*)\]$/, '$1').trim();
  if (text === 'true' || text === 'false') return bool(text === 'true');
  if (text === '') return EMPTY;
  const parts = text.split(/[\s,]+/);
  const nums = parts.map((p) => (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return undefined;
  return { t: 'num', v: nums };
}

/** `sprintf` for `%s`, `%d` / `%i`, `%g` / `%f` and `%%`, the escapes `\n` and `\t`; undefined for anything else. */
function sprintf(rawFmt: string, args: Val[]): string | undefined {
  const fmt = rawFmt.replace(/\\(\\|n|t)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
  const values: Array<string | number> = [];
  for (const v of args) {
    if (v.t === 'char' || v.t === 'string') values.push(v.s);
    else if (v.t === 'num') values.push(...v.v);
    else if (v.t === 'cell' && v.v.every(isText)) values.push(...v.v.map((x) => (x as { s: string }).s));
    else return undefined;
  }
  const specs = fmt.match(/%(?:%|[-+ 0#]*\d*(?:\.\d+)?[sdigfcu])/g) ?? [];
  const consuming = specs.filter((s) => s !== '%%').length;
  let k = 0;
  let out = '';
  let failed = false;
  const once = (): string =>
    fmt.replace(/%(%|[-+ 0#]*(\d*)(?:\.(\d+))?([sdigfcu]))/g, (_m, body: string, width: string, prec: string | undefined, conv: string) => {
      if (body === '%') return '%';
      if (k >= values.length) return '';
      const v = values[k++]!;
      let s: string;
      if (conv === 's') s = typeof v === 'string' ? v : String(v);
      else if (conv === 'c') s = typeof v === 'string' ? v : String.fromCharCode(v);
      else if (typeof v === 'string') {
        s = v;
      } else if (conv === 'd' || conv === 'i' || conv === 'u') s = Number.isInteger(v) ? String(v) : String(v);
      else if (conv === 'f') s = v.toFixed(prec === undefined ? 6 : Number(prec));
      else if (conv === 'g') s = String(Number(v.toPrecision(prec === undefined ? 6 : Math.max(1, Number(prec)))));
      else {
        failed = true;
        s = '';
      }
      return width ? s.padStart(Number(width)) : s;
    });
  do {
    out += once();
  } while (consuming > 0 && k < values.length);
  if (failed) return undefined;
  return out;
}

/**
 * The function the startup code calls first, when it names one of the
 * project's (`setpathals` in `setpathals('StorageRing')`): the default
 * current folder is that function's file's, when one file alone defines it.
 */
export function firstCalledName(root: SyntaxNode, source: string, isProjectName: (name: string) => boolean): string | null {
  let found: string | null = null;
  const visit = (n: SyntaxNode): void => {
    if (found !== null) return;
    if (n.type === 'function_call') {
      const name = childField(n, 'name');
      if (name?.type === 'identifier') {
        // Arguments are evaluated before the call.
        for (const a of callArgs(n)) visit(a);
        if (found !== null) return;
        const text = getNodeText(name, source);
        if (isProjectName(text)) found = text;
        return;
      }
    }
    if (n.type === 'command') {
      const name = namedChildren(n).find((c) => c.type === 'command_name');
      const text = name ? getNodeText(name, source).trim() : '';
      if (isProjectName(text)) found = text;
      return;
    }
    if (n.type === 'identifier') {
      const text = getNodeText(n, source);
      if (isProjectName(text)) found = text;
      return;
    }
    for (const c of namedChildren(n)) visit(c);
  };
  visit(root);
  return found;
}

