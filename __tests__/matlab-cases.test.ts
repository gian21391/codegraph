/**
 * The MATLAB edge-case catalog: every case under
 * __tests__/fixtures/matlab-cases/<area>/<case>/, run from one table.
 *
 * A case is a small project (`files/`), a `case.json` and a `snapshot.json`:
 *
 * - `truth` is hand-labelled: what MATLAB does, or the project's quality bar.
 *   It lists edges that must / must not exist (allEdges' format), and live and
 *   dormant unresolved rows that must / must not exist (unresolvedRows' and
 *   dormantRows' format). A truth failure is a bug. Nothing rewrites truth.
 * - `snapshot.json` is what the current code produces: every edge, live row and
 *   dormant row, for the files and after each step. A snapshot difference is a
 *   behaviour change, to be reviewed; `CODEGRAPH_UPDATE_MATLAB_CASES=1`
 *   rewrites the snapshots.
 * - `steps`, when present, is a sync sequence: each step's edit is applied and
 *   synced, every step must end exactly where a fresh index of the same files
 *   ends (the same edges, rows and dormant rows, counts included), and a
 *   step's own `truth` is checked after it, on both.
 * - `known` entries are documentation only and never silence an assertion.
 * - A truth that states a known bug is written as the right answer, with
 *   `"pendingBug": { "id": "<id>", "fails": ["<problem>", …] }` on the case:
 *   `fails` is the exact list of problems the case has today (the truth and
 *   sync problems, as this runner words them). One test checks that the list
 *   is still exactly that, so a fix, a half fix, a new problem or an exception
 *   each turn it red. `fails` is hand-maintained: the update mode leaves it.
 *
 * `case.json is well formed` also checks that every truth can fail: its keys
 * and types; that every negative entry names a file of the case and a name
 * some file writes or some node of a state holds (a pattern that can never
 * match is vacuous); that an exact negative names a source symbol that is a
 * node of its file, and a row line its file has; that no `to` is a dotted
 * name (edges name `pkg::f`, never `pkg.f`); that a negative with a `kind`
 * stands beside a positive of another kind between the same ends (else the
 * `kind` only makes it miss, and the negative should forbid any link); and
 * that the case states at least one positive entry that holds today (is not
 * among a pending bug's `fails`), so it proves its shape was indexed. A
 * folder with `files/` but no `case.json` fails too.
 *
 * After every state (the first index, each step's sync and fresh index), no
 * file may store an extraction exception: an exception the product caught
 * while extracting a file, stored as a severity-`error` `parse_error`. That
 * is a check of its own, not part of the snapshot.
 *
 * No two references the extraction writes share a place: the references of
 * each state's MATLAB files, extracted alone, and the rows and edges of the
 * first index and of each step's fresh index, by source, kind, line and
 * column (sharedMatlabPlaces). The store keeps one edge per source, target,
 * kind, line and column, so two references there would be one edge, which a
 * sync turns back into one row (step 14). There is no exception: the
 * functions one call may call (`feval(fn, …)` with `fn` one of several
 * names) are references of their own too, each at its own place.
 *
 * Patterns: a `noEdges` entry may be `{ "from": file, "to": name, "kind": k,
 * "at": file }` (each field optional, at least one given; `to` matches a
 * target's qualified name, its last `::` segment, or, for a file node such as
 * a script's, the file's stem: `s1` matches `tools/s1.m`); a `noRows` /
 * `noDormant` entry may be `{ "file": f, "kind": k, "name": n }`. A step's edit
 * maps a path to its new content, to `null` (delete it), or to
 * `{ "base64": "…" }` (exact bytes). `CODEGRAPH_MATLAB_CASES=area[/case],…`
 * runs only those cases.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EDGE_KINDS } from '../src/types';
import { detectLanguage, extractFromSource } from '../src/extraction';
import { indexThenSyncEachStep, useAllGrammars, type ProjectState, type StateFacts, type SyncedStep } from './matlab-helpers';

useAllGrammars();

const CASES_DIR = path.join(__dirname, 'fixtures', 'matlab-cases');
const UPDATE = process.env.CODEGRAPH_UPDATE_MATLAB_CASES === '1';
/** `CODEGRAPH_MATLAB_CASES=area[/case],…` runs only those. */
const ONLY = (process.env.CODEGRAPH_MATLAB_CASES ?? '').split(',').map((x) => x.trim()).filter(Boolean);

type EdgePattern = { from?: string; to?: string; kind?: string; at?: string };
type RowPattern = { file?: string; kind?: string; name?: string };
interface Truth {
  edges?: string[];
  noEdges?: Array<string | EdgePattern>;
  rows?: string[];
  noRows?: Array<string | RowPattern>;
  dormant?: string[];
  noDormant?: Array<string | RowPattern>;
}
type Edit = Record<string, string | null | { base64: string }>;
interface CaseFile {
  why: string;
  truth: Truth;
  known?: Array<{ what: string; why: string }>;
  steps?: Array<{ edit: Edit; truth?: Truth }>;
  pendingBug?: { id: string; fails: string[] };
}
interface Snapshot {
  index: ProjectState;
  steps?: ProjectState[];
}

const CASE_KEYS = ['why', 'truth', 'known', 'steps', 'pendingBug'];
const TRUTH_KEYS = ['edges', 'noEdges', 'rows', 'noRows', 'dormant', 'noDormant'];
const EDGE_PATTERN_KEYS = ['from', 'to', 'kind', 'at'];
const ROW_PATTERN_KEYS = ['file', 'kind', 'name'];
const KINDS: readonly string[] = [...EDGE_KINDS, 'function_ref'];
const EDGE_RE = /^(\S+) (.+) -(\w+)-> (.+) @ (.+)$/s;
const ROW_RE = /^(.+?):(\d+) (\w+):(.+)$/s;

/** Every case folder (one holding a case.json), as `area/case`, sorted. */
function caseIds(): string[] {
  if (!fs.existsSync(CASES_DIR)) return [];
  const out: string[] = [];
  for (const area of fs.readdirSync(CASES_DIR).sort()) {
    const areaDir = path.join(CASES_DIR, area);
    if (!fs.statSync(areaDir).isDirectory()) continue;
    for (const name of fs.readdirSync(areaDir).sort()) {
      const id = `${area}/${name}`;
      if (ONLY.length && !ONLY.some((o) => o === area || o === id)) continue;
      if (fs.existsSync(path.join(areaDir, name, 'case.json'))) out.push(id);
    }
  }
  return out;
}

/** Folders under the catalog that hold `files/` but no case.json: a case that would silently not run. */
function foldersWithoutCase(): string[] {
  if (!fs.existsSync(CASES_DIR)) return [];
  const out: string[] = [];
  const walk = (rel: string) => {
    const dir = path.join(CASES_DIR, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name === 'files') {
        if (!fs.existsSync(path.join(dir, 'case.json'))) out.push(rel);
        continue;
      }
      walk(r);
    }
  };
  walk('');
  return out.sort();
}

/** The files under `dir`, by their path relative to it (always with `/`), as exact bytes. */
function readFiles(dir: string, rel = ''): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readFiles(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r));
  }
  return out;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** The problems with a case.json's keys and types: an unknown key or a wrong type would otherwise be a truth nobody checks. */
function shapeProblems(c: CaseFile): string[] {
  const out: string[] = [];
  const entries = (v: unknown, where: string, patternKeys: string[] | null) => {
    if (!Array.isArray(v)) return void out.push(`${where}: must be an array`);
    v.forEach((x, i) => {
      if (typeof x === 'string') return;
      if (!patternKeys || !isObject(x)) return void out.push(`${where}[${i}]: must be a string${patternKeys ? ' or a pattern object' : ''}`);
      const keys = Object.keys(x);
      if (!keys.length) out.push(`${where}[${i}]: a pattern must name at least one of ${patternKeys.join(', ')}`);
      for (const k of keys) {
        if (!patternKeys.includes(k)) out.push(`${where}[${i}]: unknown pattern key "${k}"`);
        else if (typeof x[k] !== 'string') out.push(`${where}[${i}].${k}: must be a string`);
      }
    });
  };
  const truth = (t: unknown, where: string) => {
    if (!isObject(t)) return void out.push(`${where}: must be an object`);
    for (const [k, v] of Object.entries(t)) {
      if (!TRUTH_KEYS.includes(k)) out.push(`${where}: unknown key "${k}"`);
      else entries(v, `${where}.${k}`, k === 'noEdges' ? EDGE_PATTERN_KEYS : k === 'noRows' || k === 'noDormant' ? ROW_PATTERN_KEYS : null);
    }
  };
  if (!isObject(c)) return ['case.json must be an object'];
  for (const k of Object.keys(c)) if (!CASE_KEYS.includes(k)) out.push(`unknown key "${k}"`);
  if (typeof c.why !== 'string' || !c.why.trim()) out.push('"why" must be a sentence');
  truth(c.truth, 'truth');
  if (c.known !== undefined) {
    if (!Array.isArray(c.known)) out.push('known: must be an array');
    else c.known.forEach((k, i) => {
      if (!isObject(k) || typeof k.what !== 'string' || typeof k.why !== 'string' || Object.keys(k).some((x) => x !== 'what' && x !== 'why')) out.push(`known[${i}]: must be { "what": "…", "why": "…" }`);
    });
  }
  if (c.pendingBug !== undefined) {
    const p = c.pendingBug as unknown;
    if (!isObject(p) || typeof p.id !== 'string' || !p.id || !Array.isArray(p.fails) || !p.fails.length || p.fails.some((x) => typeof x !== 'string') || Object.keys(p).some((x) => x !== 'id' && x !== 'fails')) {
      out.push('pendingBug: must be { "id": "…", "fails": ["<problem>", …] }, with at least one problem');
    }
  }
  if (c.steps !== undefined) {
    if (!Array.isArray(c.steps)) out.push('steps: must be an array');
    else c.steps.forEach((s, i) => {
      if (!isObject(s)) return void out.push(`steps[${i}]: must be an object`);
      for (const k of Object.keys(s)) if (k !== 'edit' && k !== 'truth') out.push(`steps[${i}]: unknown key "${k}"`);
      if (!isObject(s.edit) || !Object.keys(s.edit).length) out.push(`steps[${i}].edit: must be an object naming at least one path`);
      else for (const [p, v] of Object.entries(s.edit)) {
        if (v !== null && typeof v !== 'string' && !(isObject(v) && typeof v.base64 === 'string' && Object.keys(v).length === 1)) out.push(`steps[${i}].edit["${p}"]: must be text, null or { "base64": "…" }`);
      }
      if (s.truth !== undefined) truth(s.truth, `steps[${i}].truth`);
    });
  }
  return out;
}

const truths = (c: CaseFile): Array<[Truth, string]> => [
  [c.truth, 'truth'],
  ...(c.steps ?? []).flatMap((s, i): Array<[Truth, string]> => (s.truth ? [[s.truth, `steps[${i}].truth`]] : [])),
];

/** The positive entries of a case's truths, each with the problem line the runner writes when it fails in a state. */
function positives(c: CaseFile): Array<{ entry: string; misses: string[] }> {
  const out: Array<{ entry: string; misses: string[] }> = [];
  const wheres = (i: number | null) => (i === null ? ['index'] : [`step ${i + 1} (synced)`, `step ${i + 1} (fresh)`]);
  const add = (t: Truth, i: number | null) => {
    for (const [key, what] of [['edges', 'edge'], ['rows', 'row'], ['dormant', 'dormant row']] as const) {
      for (const w of t[key] ?? []) out.push({ entry: `${i === null ? 'truth' : `steps[${i}].truth`}.${key} ${w}`, misses: wheres(i).map((x) => `${x}: missing ${what} ${w}`) });
    }
  };
  add(c.truth, null);
  (c.steps ?? []).forEach((s, i) => s.truth && add(s.truth, i));
  return out;
}

/**
 * The problems that make a truth unable to fail: a case with no positive
 * entry that holds today (nothing proves its shape was indexed); a negative
 * entry that names a file the case never has, a name no file writes and no
 * state's node table holds, a dotted name, a kind no edge or row has, or (an
 * exact string) a source symbol that is no node of its file or a line its
 * file does not have; and a negative whose `kind` narrows it with no positive
 * of another kind between the same ends beside it. `problems` is the case's
 * problem list today (truth and sync), from which a positive that fails is
 * known.
 */
function vacuityProblems(c: CaseFile, files: Record<string, Buffer>, states: ProjectState[], facts: StateFacts[], problems: string[]): string[] {
  const out: string[] = [];
  const all = truths(c);
  const pos = positives(c);
  if (!pos.length) {
    out.push('no positive entry (edges, rows or dormant) in the truth or a step\'s: nothing proves the case\'s shape was indexed');
  } else if (!pos.some((p) => p.misses.every((m) => !problems.includes(m)))) {
    out.push(`no positive entry holds today (each is among the problems): add an anchor about the case's shape that holds; positives: ${JSON.stringify(pos.map((p) => p.entry))}`);
  }
  const caseFiles = new Set(Object.keys(files));
  const texts = Object.values(files).map((b) => b.toString('utf8'));
  // The most lines each file of the case has, in any state.
  const lineCount = new Map<string, number>();
  const noteLines = (p: string, t: string) => lineCount.set(p, Math.max(lineCount.get(p) ?? 0, t.split('\n').length));
  for (const [p, b] of Object.entries(files)) noteLines(p, b.toString('utf8'));
  for (const s of c.steps ?? []) {
    for (const [p, v] of Object.entries(s.edit)) {
      caseFiles.add(p);
      const t = typeof v === 'string' ? v : v ? Buffer.from(v.base64, 'base64').toString('utf8') : null;
      if (t === null) continue;
      texts.push(t);
      noteLines(p, t);
    }
  }
  // Every node of every state, from the node table: by qualified name and its last `::` segment, and as `file qn`.
  const nodes = new Set<string>();
  const fileNodes = new Set<string>();
  for (const f of facts) {
    for (const n of f.nodes) {
      fileNodes.add(n);
      const q = n.slice(n.indexOf(' ') + 1);
      nodes.add(q);
      nodes.add(q.split('::').pop()!);
    }
  }
  for (const st of states) {
    for (const r of [...st.rows, ...st.dormant]) {
      const m = ROW_RE.exec(r);
      if (m) nodes.add(m[4]!);
    }
  }
  // Every positive edge and row the case states, for the kind rule.
  const posEdges = all.flatMap(([t]) => t.edges ?? []);
  const posRows = all.flatMap(([t]) => [...(t.rows ?? []), ...(t.dormant ?? [])]);
  // A name written as a word of its own; a digit may come before it, as the lexer splits `2qvk1` into 2 and `qvk1`.
  const written = (name: string) => {
    if (!/^[\w.]+$/.test(name)) return texts.some((t) => t.includes(name));
    const re = new RegExp(`(^|[^A-Za-z_])${name.replace(/\./g, '\\.')}($|[^\\w])`);
    return texts.some((t) => re.test(t));
  };
  const nameOccurs = (name: string) => {
    const stem = name.endsWith('.m') && caseFiles.has(name) ? name.slice(name.lastIndexOf('/') + 1, -2) : name;
    return nodes.has(name) || written(stem) || (name.includes('::') && name.split('::').every(written));
  };
  for (const [t, where] of all) {
    const check = (what: string, ok: boolean, entry: unknown, i: number, key: string, tail = 'the entry can never match') => {
      if (!ok) out.push(`${where}.${key}[${i}]: ${what} (${JSON.stringify(entry)}): ${tail}`);
    };
    (t.noEdges ?? []).forEach((p, i) => {
      const m = typeof p === 'string' ? EDGE_RE.exec(p) : null;
      if (typeof p === 'string' && !m) return check('not an edge', false, p, i, 'noEdges');
      const q = p as EdgePattern;
      const [from, to, kind, at]: Array<string | undefined> = m ? [m[1], m[4], m[3], m[5]] : [q.from, q.to, q.kind, q.at];
      if (from !== undefined) check(`"${from}" is no file of the case`, caseFiles.has(from), p, i, 'noEdges');
      if (at !== undefined) check(`"${at}" is no file of the case`, caseFiles.has(at), p, i, 'noEdges');
      if (kind !== undefined) check(`"${kind}" is no edge kind`, (EDGE_KINDS as readonly string[]).includes(kind), p, i, 'noEdges');
      if (to !== undefined) {
        // Edges name a package function `pkg::f` and a script by its path (`lib/s1.m`): a dotted `to` is neither.
        if (to.includes('.') && !caseFiles.has(to)) check(`"${to}" is a dotted name (edges name pkg::f, not pkg.f)`, false, p, i, 'noEdges');
        else check(`"${to}" is no name a file writes or a node of a state holds`, nameOccurs(to), p, i, 'noEdges');
      }
      if (m) check(`source symbol "${m[2]}" is no node of ${m[1]} in any state`, fileNodes.has(`${m[1]} ${m[2]}`), p, i, 'noEdges');
      else if (kind !== undefined) {
        // A kind narrows the negative: it may only be there beside a positive of another kind between the same ends.
        const ends = { ...q, kind: undefined };
        check(`its kind "${kind}" narrows it, but no positive edge of another kind between the same ends is stated`, posEdges.some((e) => EDGE_RE.exec(e)?.[3] !== kind && edgeMatches(e, ends)), p, i, 'noEdges', 'a link of another kind would pass it: drop the kind to forbid any link');
      }
    });
    for (const key of ['noRows', 'noDormant'] as const) {
      (t[key] ?? []).forEach((p, i) => {
        const m = typeof p === 'string' ? ROW_RE.exec(p) : null;
        if (typeof p === 'string' && !m) return check('not a row', false, p, i, key);
        const q = p as RowPattern;
        const [file, kind, name]: Array<string | undefined> = m ? [m[1], m[3], m[4]] : [q.file, q.kind, q.name];
        if (file !== undefined) check(`"${file}" is no file of the case`, caseFiles.has(file), p, i, key);
        if (kind !== undefined) check(`"${kind}" is no row kind`, KINDS.includes(kind), p, i, key);
        if (name !== undefined) check(`"${name}" is no name a file writes or a node of a state holds`, nameOccurs(name), p, i, key);
        if (m) check(`line ${m[2]} is no line of ${m[1]} (it has at most ${lineCount.get(m[1]!) ?? 0})`, Number(m[2]) >= 1 && Number(m[2]) <= (lineCount.get(m[1]!) ?? 0), p, i, key);
        else if (kind !== undefined) {
          const ends = { ...q, kind: undefined };
          check(`its kind "${kind}" narrows it, but no positive row of another kind of the same file and name is stated`, posRows.some((r) => ROW_RE.exec(r)?.[3] !== kind && rowMatches(r, ends)), p, i, key, 'a row of another kind would pass it: drop the kind to forbid any row');
        }
      });
    }
  }
  return out;
}

function edgeMatches(edge: string, p: string | EdgePattern): boolean {
  if (typeof p === 'string') return edge === p;
  const m = EDGE_RE.exec(edge);
  if (!m) return false;
  const [, from, , kind, to, at] = m;
  const tail = to!.split('::').pop();
  // A file node (a script's) is named by its path; its stem names it too.
  const stem = to === at && to!.endsWith('.m') ? to!.slice(to!.lastIndexOf('/') + 1, -2) : undefined;
  return (p.from === undefined || p.from === from)
    && (p.kind === undefined || p.kind === kind)
    && (p.at === undefined || p.at === at)
    && (p.to === undefined || p.to === to || p.to === tail || p.to === stem);
}

function rowMatches(row: string, p: string | RowPattern): boolean {
  if (typeof p === 'string') return row === p;
  const m = ROW_RE.exec(row);
  if (!m) return false;
  const [, file, , kind, name] = m;
  return (p.file === undefined || p.file === file) && (p.kind === undefined || p.kind === kind) && (p.name === undefined || p.name === name);
}

/** What `state` breaks of `truth`, each problem a line naming `where`. */
function truthProblems(truth: Truth | undefined, state: ProjectState, where: string): string[] {
  if (!truth) return [];
  const out: string[] = [];
  const must = (want: string[] | undefined, have: string[], what: string) => {
    for (const w of want ?? []) if (!have.includes(w)) out.push(`${where}: missing ${what} ${w}`);
  };
  const mustNot = <P>(bad: Array<string | P> | undefined, have: string[], match: (x: string, p: string | P) => boolean, what: string) => {
    for (const b of bad ?? []) for (const h of have) if (match(h, b)) out.push(`${where}: unwanted ${what} ${h}${typeof b === 'string' ? '' : ` (matches ${JSON.stringify(b)})`}`);
  };
  must(truth.edges, state.edges, 'edge');
  mustNot(truth.noEdges, state.edges, edgeMatches, 'edge');
  must(truth.rows, state.rows, 'row');
  mustNot(truth.noRows, state.rows, rowMatches, 'row');
  must(truth.dormant, state.dormant, 'dormant row');
  mustNot(truth.noDormant, state.dormant, rowMatches, 'dormant row');
  return out;
}

const synced = (s: SyncedStep): ProjectState => ({ edges: s.synced, rows: s.syncedRows, dormant: s.syncedDormant });
const fresh = (s: SyncedStep): ProjectState => ({ edges: s.fresh, rows: s.freshRows, dormant: s.freshDormant });

/** The entries of `a` not matched one for one in `b` (a multiset difference: counts count). */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out.sort();
}

/**
 * Each step's state where a sync and a fresh index of the same files
 * disagree: the sorted lists must be equal, counts included (two refs on one
 * line are two identical entries).
 */
function syncProblems(steps: SyncedStep[], c: CaseFile): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    for (const [what, a, b] of [['edges', s.synced, s.fresh], ['rows', s.syncedRows, s.freshRows], ['dormant rows', s.syncedDormant, s.freshDormant]] as const) {
      if (JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())) continue;
      out.push(`step ${i + 1} (${Object.keys(c.steps![i]!.edit).join(', ')}): ${what} differ; only synced: ${JSON.stringify(minus(a, b))}; only fresh: ${JSON.stringify(minus(b, a))}`);
    }
  });
  return out;
}

function editFiles(edit: Edit): Record<string, string | Buffer | null> {
  return Object.fromEntries(Object.entries(edit).map(([p, v]) => [p, v !== null && typeof v === 'object' ? Buffer.from(v.base64, 'base64') : v]));
}

/** A case's files in each of its states: the first index's, then each step's, its edit applied. */
function fileStates(files: Record<string, Buffer>, c: CaseFile): Array<Record<string, Buffer>> {
  const out = [files];
  let now: Record<string, Buffer> = { ...files };
  for (const step of Array.isArray(c.steps) ? c.steps : []) {
    now = { ...now };
    for (const [p, v] of Object.entries(editFiles(step.edit))) {
      if (v === null) delete now[p];
      else now[p] = Buffer.isBuffer(v) ? v : Buffer.from(v);
    }
    out.push(now);
  }
  return out;
}

/** The places two references of one source and kind share in a state's MATLAB files, each extracted alone as an index extracts it, as `file:line:column kind: names`. */
function extractedSharedPlaces(state: Record<string, Buffer>): string[] {
  const out = new Set<string>();
  for (const [rel, bytes] of Object.entries(state)) {
    const text = bytes.toString('utf8');
    if (detectLanguage(rel, text) !== 'matlab') continue;
    const at = new Map<string, string[]>();
    for (const r of extractFromSource(rel, text, 'matlab').unresolvedReferences) {
      const k = `${rel}:${r.line}:${r.column} ${r.referenceKind}\0${r.fromNodeId}`;
      (at.get(k) ?? at.set(k, []).get(k)!).push(r.referenceName);
    }
    for (const [k, names] of at) if (names.length > 1) out.add(`${k.split('\0')[0]}: ${names.sort().join(' | ')}`);
  }
  return [...out].sort();
}

const ids = caseIds();

describe('MATLAB edge-case catalog', () => {
  it('has cases', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it('every folder with files/ has a case.json', () => {
    expect(foldersWithoutCase()).toEqual([]);
  });

  for (const id of ids) {
    const dir = path.join(CASES_DIR, id);
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')) as CaseFile;
    const snapshotPath = path.join(dir, 'snapshot.json');
    const files = readFiles(path.join(dir, 'files'));

    describe(id, () => {
      let run: Awaited<ReturnType<typeof indexThenSyncEachStep>>;
      beforeAll(async () => {
        run = await indexThenSyncEachStep(files, ...(Array.isArray(c.steps) ? c.steps : []).map((s) => editFiles(s.edit)));
      }, 120_000);

      const truthAll = () => [
        ...truthProblems(c.truth, run.initial, 'index'),
        ...run.steps.flatMap((s, i) => [
          ...truthProblems(c.steps![i]!.truth, synced(s), `step ${i + 1} (synced)`),
          ...truthProblems(c.steps![i]!.truth, fresh(s), `step ${i + 1} (fresh)`),
        ]),
      ];

      it('case.json is well formed', () => {
        const shape = shapeProblems(c);
        expect(shape).toEqual([]);
        const states = [run.initial, ...run.steps.flatMap((s) => [synced(s), fresh(s)])];
        const facts = [run.facts.initial, ...run.facts.steps.flatMap((s) => [s.synced, s.fresh])];
        expect(vacuityProblems(c, files, states, facts, truthAll())).toEqual([]);
      });

      it('no state stores an extraction exception', () => {
        const stored = [
          ...run.facts.initial.exceptions.map((x) => `index: ${x}`),
          ...run.facts.steps.flatMap((s, i) => [...s.synced.exceptions.map((x) => `step ${i + 1} (synced): ${x}`), ...s.fresh.exceptions.map((x) => `step ${i + 1} (fresh): ${x}`)]),
        ];
        expect(stored, 'the product caught an exception while extracting a file and stored it: a crash it swallows').toEqual([]);
      });

      it('no two references of one source and kind share a place', () => {
        const states = ['index', ...run.steps.map((_, i) => `step ${i + 1}`)];
        const shared = [
          ...fileStates(files, c).flatMap((s, i) => extractedSharedPlaces(s).map((p) => `${states[i]} (extracted): ${p}`)),
          ...[run.facts.initial, ...run.facts.steps.map((s) => s.fresh)].flatMap((f, i) => f.sharedPlaces.map((p) => `${states[i]} (fresh index): ${p}`)),
        ];
        expect(shared).toEqual([]);
      });

      if (c.pendingBug !== undefined) {
        // A known bug: the truth is the right answer, and the case fails exactly as `fails` records. A fix, a half fix,
        // a new problem or an exception changes the list, and turns this red.
        const pending = isObject(c.pendingBug) ? (c.pendingBug as { id: string; fails: string[] }) : { id: String(c.pendingBug), fails: [] as string[] };
        it(`pending bug ${pending.id} still fails exactly as recorded`, () => {
          const problems = [...truthAll(), ...syncProblems(run.steps, c)];
          expect(problems, `pending bug ${pending.id} no longer fails exactly as its "fails" records: if it is fixed, remove "pendingBug"; otherwise update "fails" by hand`).toEqual(pending.fails);
        });
      } else {
        it('truth', () => {
          expect(truthAll()).toEqual([]);
        });
        if (c.steps?.length) {
          it('every step: a sync ends where a fresh index ends', () => {
            expect(syncProblems(run.steps, c)).toEqual([]);
          });
        }
      }

      if (c.steps?.length && c.pendingBug === undefined) {
        // What the snapshot leaves out: each row's and edge's facts, which a sync must store as a fresh index does.
        it('every step: a sync stores the facts a fresh index stores', () => {
          // As multisets: an entry stored twice on one side and once on the other differs.
          const counts = (list: readonly string[]): Map<string, number> => {
            const m = new Map<string, number>();
            for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
            return m;
          };
          const differ = run.facts.steps.flatMap((s, i) => {
            const a = counts(s.synced.stored);
            const b = counts(s.fresh.stored);
            const out: string[] = [];
            for (const [x, n] of a) if (n > (b.get(x) ?? 0)) out.push(`step ${i + 1} only synced (${n - (b.get(x) ?? 0)}): ${x}`);
            for (const [x, n] of b) if (n > (a.get(x) ?? 0)) out.push(`step ${i + 1} only fresh (${n - (a.get(x) ?? 0)}): ${x}`);
            return out;
          });
          expect(differ).toEqual([]);
        });
      }

      it('snapshot', () => {
        const now: Snapshot = { index: run.initial, ...(run.steps.length ? { steps: run.steps.map(synced) } : {}) };
        if (UPDATE) {
          fs.writeFileSync(snapshotPath, JSON.stringify(now, null, 2) + '\n');
          return;
        }
        expect(fs.existsSync(snapshotPath), `${id}: no snapshot.json; run with CODEGRAPH_UPDATE_MATLAB_CASES=1 and review it`).toBe(true);
        expect(now).toEqual(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Snapshot);
      });
    });
  }
});
