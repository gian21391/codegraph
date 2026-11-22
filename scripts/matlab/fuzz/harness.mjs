/**
 * The MATLAB fuzzer's driver of the built library (dist/), in process: write a
 * project, index it, sync it, and dump what the index holds.
 *
 * The dump extends matlab-helpers.ts's shapes (allEdges' `file src -kind-> tgt
 * @ file`, unresolvedRows' `file:line kind:name`) with what a sync must also
 * get right: each edge's line, column, provenance and metadata (and the
 * `contains` edges), each row's column, status, source symbol, tail and
 * candidates, the node set, and each file's language and stored extraction
 * errors. Each entry keeps its helpers-format `short` form too, which the
 * catalog's truth uses, and a `loose` form without lines or columns (but with
 * a row's source symbol and status), which the shrinker uses to tell whether
 * a candidate still shows the same bug.
 *
 * The library's logger is not silenced: each library gets a logger that keeps
 * what it is told on every channel (logOf), and each timed operation reads
 * what it said meanwhile (see `timed`): an error, a message that reports an
 * exception the product caught and went on from (CAUGHT_EXCEPTIONS), and a
 * result that records one, are robust failures; other warnings reach a
 * failure's repro output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIST = path.resolve(HERE, '../../../dist');

const loaded = new Map();
const logs = new WeakMap();

/**
 * What a library's logger was told: `errors`, `warnings` and `debug` lines, and
 * the `verbose` lines a verbose index printed, as one-line strings, since the
 * last `clear()`. `configValid` says whether the project's startup code is
 * the generator's own, meant to be valid (see CAUGHT_EXCEPTIONS); the fuzzer
 * sets it before each operation.
 */
export function logOf(lib) {
  return logs.get(lib);
}

/**
 * Every message the product writes when it catches an exception and goes on
 * (a crash it swallows), found by reading every logWarn / logDebug call and
 * the verbose index log in src/. Each is a robust failure when it appears
 * during an operation. `startup: true` marks a startup-code warning: a
 * failure only while the project's startup code is the generator's own,
 * meant to be valid (the mutator's broken-config edits, and any edit of
 * startup.m or codegraph.json the mutator does not mean as a path config,
 * mark it otherwise). Messages the fuzzer's projects can never reach (the
 * file watcher, the context builder, tsconfig parsing) are listed for
 * completeness; caught file-system errors (a read, stat or listing that
 * fails: ENOENT on a folder a path entry names is normal) are not, and a
 * sync's unabsorbed files are read from its result instead.
 */
export const CAUGHT_EXCEPTIONS = [
  // src/resolution/matlab-path-record.ts, computeMatlabPathRecord's catch (none() logs it).
  { channel: 'warn', re: /^No MATLAB search path: evaluating the startup code failed: /, startup: true },
  // ... and the reasons that are not the startup code's own fault: the grammar, or the code not parsing.
  { channel: 'warn', re: /^No MATLAB search path: the MATLAB grammar could not be loaded/, startup: true },
  { channel: 'warn', re: /^No MATLAB search path: .*: the code does not parse: no path is set/, startup: true },
  // src/index.ts, the put-off synthesis pass.
  { channel: 'warn', re: /^Put-off synthesis failed/ },
  // src/sync/watcher.ts (never started by the fuzzer).
  { channel: 'warn', re: /^File watcher \S+ callback threw/ },
  { channel: 'warn', re: /^Watch sync failed/ },
  // src/resolution/index.ts: resolution's fallbacks after an exception.
  { channel: 'debug', re: /^Parallel resolution failed/ },
  { channel: 'debug', re: /^Worker connection recycle failed/ },
  { channel: 'debug', re: /^Framework '.*' (postExtract|crossFileNodes) failed/ },
  { channel: 'debug', re: /^Parameter flows failed/ },
  // src/context/index.ts (explore and context only: never run by the fuzzer).
  { channel: 'debug', re: /^(Exact symbol lookup failed|Text search failed|Failed to extract code from node)/ },
  // src/resolution/path-aliases.ts (a tsconfig: never written by the fuzzer).
  { channel: 'debug', re: /^path-aliases: failed to parse/ },
  // src/extraction/index.ts and parse-pool.ts, the verbose index log: a parse worker crashed or timed out, even when
  // the retry pass rescued the file (which then leaves no stored error and no result error).
  { channel: 'verbose', re: /^\[worker\] (Retrying \d+ files|Retry (\(stripped\) )?OK|\d+ files still failing|TIMEOUT|Late parse-result accepted)/ },
];

/** The CAUGHT_EXCEPTIONS entry `line` (said on `channel`) matches, or null; startup-code warnings only count while `configValid`. */
export function caughtException(channel, line, configValid = true) {
  const hit = CAUGHT_EXCEPTIONS.find((c) => c.channel === channel && c.re.test(line));
  if (!hit || (hit.startup && !configValid)) return null;
  return hit;
}

/**
 * The problems an index's or a sync's result records: an error-severity
 * error (an extraction exception, an abort), an index the product calls
 * partial or salvaged, a run that did not succeed, and files a sync could
 * not absorb. Ordinary parse warnings are no problem.
 */
export function resultProblems(result) {
  if (!result || typeof result !== 'object') return [];
  const out = [];
  if (result.success === false) out.push('the result says it did not succeed');
  for (const e of result.errors ?? []) {
    if (e?.severity === 'error' || isExtractionException(e) || e?.code === 'index_partial' || e?.code === 'salvaged_stripped') out.push(`${e.filePath ? `${e.filePath}: ` : ''}${String(e.message ?? '').split('\n')[0].slice(0, 300)}`);
  }
  if (result.failedFilePaths?.length) out.push(`files not absorbed: ${result.failedFilePaths.join(', ')}`);
  return out;
}

const logLine = (message, context) => `${message}${context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : ''}`.split('\n')[0].slice(0, 400);

/**
 * The library at `distDir` (default: this checkout's dist/), with every
 * grammar loaded and its logger capturing (logOf). Two builds (a mutant's and
 * the baseline's) load side by side: each is its own module tree.
 */
export async function loadLibrary(distDir = DEFAULT_DIST) {
  const dir = path.resolve(distDir);
  if (loaded.has(dir)) return loaded.get(dir);
  const require = createRequire(import.meta.url);
  const lib = require(path.join(dir, 'index.js'));
  const log = { errors: [], warnings: [], debug: [], verbose: [], configValid: true, clear() { log.errors = []; log.warnings = []; log.debug = []; log.verbose = []; } };
  logs.set(lib, log);
  lib.setLogger({ debug: (m, c) => void log.debug.push(logLine(m, c)), warn: (m, c) => void log.warnings.push(logLine(m, c)), error: (m, c) => void log.errors.push(logLine(m, c)) });
  await lib.initGrammars();
  await lib.loadAllGrammars();
  loaded.set(dir, lib);
  return lib;
}

/** Removes the folders under `root` that `rel`'s deletion left empty (so a case-only rename makes a new folder). */
function pruneEmpty(root, rel) {
  let dir = path.dirname(rel);
  while (dir && dir !== '.') {
    const full = path.join(root, dir);
    try {
      if (fs.readdirSync(full).length) return;
      fs.rmdirSync(full);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Applies `edit` (path -> content, or null to delete) under `root`: every
 * deletion first, then every write, in `order` (default: the edit's own).
 * `clock`, when given, stamps each written file with a fresh mtime: a sync
 * goes by size and mtime, and an edit that keeps both within one millisecond
 * is the blind spot every mtime-based tool accepts, not a finding.
 */
export function writeEdit(root, edit, { order, clock } = {}) {
  const keys = order ?? Object.keys(edit);
  for (const rel of keys) {
    if (edit[rel] !== null) continue;
    fs.rmSync(path.join(root, rel), { force: true });
    pruneEmpty(root, rel);
  }
  for (const rel of keys) {
    const content = edit[rel];
    if (content === null || content === undefined) continue;
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (clock) {
      const t = clock.tick();
      fs.utimesSync(full, t, t);
    }
  }
}

/** A clock of strictly increasing mtimes (seconds), two seconds apart. */
export function makeClock(start = 1_700_000_000) {
  let t = start;
  return { tick: () => (t += 2) };
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** `v` with every object's keys sorted, at every depth. */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/**
 * A JSON column in one canonical form: keys sorted at every depth, and a
 * top-level array (a row's candidates) sorted too. Sorting the candidates is
 * deliberate: a sync and a fresh index may list a row's candidates in another
 * order (a known, accepted gap), and the order changes no answer.
 */
function sortedJson(text) {
  if (text === null || text === undefined) return '';
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
    return JSON.stringify(sortKeys(v));
  } catch {
    return String(text);
  }
}

/**
 * Whether a stored extraction error comes from an exception, not from the text:
 * the product stores an exception thrown while a file is extracted (the
 * extractor's own catch, the parse worker's, and recordParseFailure in
 * src/extraction/index.ts) as a `parse_error` of severity `error`, while a
 * file that merely fails to parse gets a `parse_error` of severity `warning`.
 * The messages' prefixes are checked too, for a stored error without a
 * severity.
 */
export function isExtractionException(e) {
  if (!e || typeof e !== 'object' || e.code !== 'parse_error') return false;
  if (e.severity === 'error') return true;
  return e.severity === undefined && /^(Parse error|Parse worker error): /.test(String(e.message ?? ''));
}

/**
 * An entry of a dump: its key and short form, and `shift(d, p)`, the same
 * entry with every line it holds that is a line of file `p` moved by `d`.
 * `make(at)` builds the entry with `at(file, line)` mapping each line.
 */
function entry(file, make, loose) {
  const same = (_f, l) => l;
  return { file, loose, ...make(same), shift: (d, p) => ({ file, loose, ...make((f, l) => (f === p && l !== null && l !== undefined ? l + d : l)) }) };
}

/**
 * What the index at `root` holds: `files`, `nodes`, `edges`, `rows` (live:
 * pending or failed) and `dormant`, each a sorted list of `{ key, short, file,
 * shift }`. `key` is the full entry; `short` is matlab-helpers.ts's form (null
 * for a file, a node or a `contains` edge); `file` is where it sits (an edge's
 * source file), and `shift(d)` moves its lines, for the prepended-comment
 * check.
 */
export function dumpIndex(lib, root) {
  const db = lib.DatabaseConnection.open(lib.getDatabasePath(root));
  try {
    const d = db.getDb();
    const nodes = d.prepare('SELECT file_path f, kind k, qualified_name q, start_line sl, start_column sc, end_line el, end_column ec, language lang FROM nodes').all()
      // A file node spans the whole file: it starts at line 1 whatever comes first.
      .map((n) => entry(n.f, (at) => ({ key: `${n.f} ${n.lang} ${n.k} ${n.q} ${n.k === 'file' ? n.sl : at(n.f, n.sl)}:${n.sc}-${at(n.f, n.el)}:${n.ec}`, short: null }), `node ${n.f} ${n.lang} ${n.k} ${n.q}`));
    const edges = d.prepare(`SELECT s.file_path sf, s.qualified_name sq, e.kind k, t.qualified_name tq, t.file_path tf, e.line l, e.col c, e.provenance p, e.metadata m
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`).all()
      .map((e) => entry(e.sf, (at) => {
        const short = `${e.sf} ${e.sq} -${e.k}-> ${e.tq} @ ${e.tf}`;
        // An edge's line is a line of its source file, but a class folder's `contains` edge sits at the method's line
        // in its own file; `registeredAt` names its file.
        const meta = parseJson(e.m);
        const lineFile = meta?.synthesizedBy === 'matlab-class-folder' ? e.tf : e.sf;
        if (meta && typeof meta.registeredAt === 'string') {
          const m = /^(.*):(\d+)$/.exec(meta.registeredAt);
          if (m) meta.registeredAt = `${m[1]}:${at(m[1], Number(m[2]))}`;
        }
        return { key: `${short} :${e.l ?? ''}:${e.c ?? ''} ${e.p ?? ''} ${sortedJson(meta === null ? e.m : JSON.stringify(meta))}`.replace(/^(.* :)(\d*)(:.*)$/s, (all, a, l, b) => (l === '' ? all : `${a}${at(lineFile, Number(l))}${b}`)), short: e.k === 'contains' ? null : short };
      }, `edge ${e.sf} ${e.sq} -${e.k}-> ${e.tq} @ ${e.tf}`));
    const refs = d.prepare(`SELECT r.file_path f, r.line l, r.col c, r.reference_kind k, r.reference_name n, r.status s, r.name_tail t, r.candidates cand, n.qualified_name fromq
      FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.from_node_id`).all()
      .map((r) => ({ ...entry(r.f, (at) => ({ key: `${r.f}:${at(r.f, r.l)}:${r.c} ${r.k}:${r.n} ${r.s} from=${r.fromq ?? '?'} tail=${r.t} cand=${sortedJson(r.cand)}`, short: `${r.f}:${at(r.f, r.l)} ${r.k}:${r.n}` }), `row ${r.f} ${r.k}:${r.n} from=${r.fromq ?? '?'} ${r.s}`), status: r.s }));
    // A file's stored extraction errors are part of what it holds: a sync, a fresh index and their variants must agree
    // on them too, and an exception among them is a robust failure (isExtractionException). The root's path, should a
    // message name it, is taken out, since every index lives in another folder.
    const files = d.prepare('SELECT path p, language lang, errors err FROM files').all().map((f) => {
      let errors = [];
      try { errors = f.err ? JSON.parse(f.err) : []; } catch { errors = [{ message: String(f.err) }]; }
      if (!Array.isArray(errors)) errors = [errors];
      const shown = errors.map((e) => sortKeys({ ...e, message: String(e?.message ?? '').split(root).join('<root>') }));
      return { ...entry(f.p, () => ({ key: `${f.p} ${f.lang}${shown.length ? ` errors=${JSON.stringify(shown)}` : ''}`, short: null }), `file ${f.p} ${f.lang}`), errors };
    });
    const by = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return {
      files: files.sort(by),
      nodes: nodes.sort(by),
      edges: edges.sort(by),
      rows: refs.filter((r) => r.status !== 'dormant').sort(by),
      dormant: refs.filter((r) => r.status === 'dormant').sort(by),
    };
  } finally {
    db.close();
  }
}

export const SECTIONS = ['files', 'nodes', 'edges', 'rows', 'dormant'];

/** The entries of each section in only one of two dumps (as multisets); empty when they agree. */
export function diffDumps(a, b) {
  const out = {};
  for (const s of SECTIONS) {
    const count = new Map();
    for (const e of a[s]) count.set(e.key, (count.get(e.key) ?? 0) + 1);
    for (const e of b[s]) count.set(e.key, (count.get(e.key) ?? 0) - 1);
    const onlyA = [];
    const onlyB = [];
    for (const [k, n] of count) {
      for (let i = 0; i < n; i++) onlyA.push(k);
      for (let i = 0; i < -n; i++) onlyB.push(k);
    }
    if (onlyA.length || onlyB.length) out[s] = { onlyA: onlyA.sort(), onlyB: onlyB.sort() };
  }
  return Object.keys(out).length ? out : null;
}

/** The helpers-format entries (edges, rows, dormant) in only one of two dumps. */
export function shortDiff(a, b) {
  const out = {};
  for (const s of ['edges', 'rows', 'dormant']) {
    const sa = a[s].map((e) => e.short).filter(Boolean);
    const sb = b[s].map((e) => e.short).filter(Boolean);
    out[s] = { onlyA: [...new Set(sa.filter((x) => !sb.includes(x)))].sort(), onlyB: [...new Set(sb.filter((x) => !sa.includes(x)))].sort() };
  }
  return out;
}

/** A one-screen rendering of a {@link diffDumps} result, `a` / `b` named. */
export function renderDiff(diff, nameA, nameB, limit = 12) {
  if (!diff) return '(no difference)';
  const lines = [];
  for (const [s, { onlyA, onlyB }] of Object.entries(diff)) {
    lines.push(`  ${s}:`);
    for (const k of onlyA.slice(0, limit)) lines.push(`    only ${nameA}: ${k}`);
    if (onlyA.length > limit) lines.push(`    … ${onlyA.length - limit} more only ${nameA}`);
    for (const k of onlyB.slice(0, limit)) lines.push(`    only ${nameB}: ${k}`);
    if (onlyB.length > limit) lines.push(`    … ${onlyB.length - limit} more only ${nameB}`);
  }
  return lines.join('\n');
}

/** The stored extraction exceptions of a dump (isExtractionException), as `file: message` lines. */
export function extractionExceptions(dump) {
  return dump.files.flatMap((f) => (f.errors ?? []).filter(isExtractionException).map((e) => `${f.file}: ${e.message}`));
}

/**
 * Times `fn`, and fails it (as a robustness failure) past `budgetMs`; when
 * the product logged an error meanwhile, or a message that reports a caught
 * exception (CAUGHT_EXCEPTIONS, on the warn, debug or verbose channel); or
 * when `fn`'s value is an index or sync result that records a problem
 * (resultProblems: an extraction exception, a partial index, files a sync
 * could not absorb). While `fn` runs, the verbose index log (console.log
 * lines `[worker] …` and `[wal-valve] …`) is kept in logOf's `verbose`, not
 * printed. `fn` resolves to `{ value, result? }` when it has a result to
 * check, or to its value.
 */
export async function timed(what, budgetMs, fn, lib, { hasResult = false } = {}) {
  const log = lib ? logOf(lib) : null;
  const at = log ? { errors: log.errors.length, warn: log.warnings.length, debug: log.debug.length, verbose: log.verbose.length } : null;
  const t0 = performance.now();
  const print = console.log;
  if (log) console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (/^\[(worker|wal-valve)\] /.test(line)) log.verbose.push(line.split('\n')[0].slice(0, 400));
    else print(...args);
  };
  let out;
  try {
    out = await fn();
  } finally {
    console.log = print;
  }
  const ms = performance.now() - t0;
  const value = hasResult ? out.value : out;
  if (log && log.errors.length > at.errors) {
    const err = new Error(`${what} logged an error: ${log.errors[at.errors]}`);
    err.logged = true;
    throw err;
  }
  if (log) {
    for (const [channel, list, from] of [['warn', log.warnings, at.warn], ['debug', log.debug, at.debug], ['verbose', log.verbose, at.verbose]]) {
      for (const line of list.slice(from)) {
        if (!caughtException(channel, line, log.configValid)) continue;
        const err = new Error(`${what} reported a caught exception (${channel}): ${line.replace(/\d+ ?ms\b/g, 'N ms')}`);
        err.logged = true;
        throw err;
      }
    }
  }
  const problems = hasResult ? resultProblems(out.result) : [];
  if (problems.length) {
    const err = new Error(`${what}'s result records a problem: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
    err.logged = true;
    throw err;
  }
  if (budgetMs && ms > budgetMs) {
    const err = new Error(`${what} took ${Math.round(ms)} ms, over the ${budgetMs} ms budget`);
    err.slow = true;
    err.ms = ms;
    throw err;
  }
  return { value, ms };
}

let dirCounter = 0;
/** A new empty folder under `work`. */
export function newDir(work, prefix) {
  fs.mkdirSync(work, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(work, `${prefix}${process.pid}-${dirCounter++}-`)));
}

/**
 * A fresh index of `files` in a throwaway folder (written in `order`): its
 * dump. `nest`, when given, puts the project root that many folders deeper,
 * under another name (`nest-1/…/Other Root`), which the product does see.
 */
export async function freshDump(lib, files, { work, order, budgetMs, nest = 0 }) {
  const top = newDir(work, 'fresh-');
  let root = top;
  if (nest > 0) {
    root = path.join(top, ...Array.from({ length: nest - 1 }, (_, i) => `nest-${i + 1}`), 'Other Root');
    fs.mkdirSync(root, { recursive: true });
  }
  try {
    writeEdit(root, files, { order });
    const { value: cg } = await timed('a fresh index', budgetMs, () => indexed(lib, root), lib, { hasResult: true });
    cg.close();
    return dumpIndex(lib, root);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}

/**
 * `CodeGraph.init(root, { index: true })`, spelled out so that the index's
 * result is kept and its verbose log (a worker crash a retry rescued) is
 * written: `{ value: cg, result }`.
 */
export async function indexed(lib, root) {
  const cg = await lib.CodeGraph.init(root);
  try {
    const result = await cg.indexAll({ verbose: true });
    return { value: cg, result };
  } catch (err) {
    cg.close();
    throw err;
  }
}

/** A live project: indexed once, then synced edit by edit. */
export class LiveProject {
  constructor(lib, work, budgetMs) {
    this.lib = lib;
    this.root = newDir(work, 'live-');
    this.budgetMs = budgetMs;
    this.clock = makeClock();
    this.cg = null;
  }

  async init(files) {
    writeEdit(this.root, files, { clock: this.clock });
    const { value } = await timed('the first index', this.budgetMs, () => indexed(this.lib, this.root), this.lib, { hasResult: true });
    this.cg = value;
  }

  async apply(edit) {
    writeEdit(this.root, edit, { clock: this.clock });
    await timed('a sync', this.budgetMs, async () => ({ value: null, result: await this.cg.sync({ verbose: true }) }), this.lib, { hasResult: true });
  }

  async noopSync() {
    await timed('a no-op sync', this.budgetMs, async () => ({ value: null, result: await this.cg.sync({ verbose: true }) }), this.lib, { hasResult: true });
  }

  dump() {
    return dumpIndex(this.lib, this.root);
  }

  close() {
    try { this.cg?.close(); } catch { /* already closed */ }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
