/**
 * Shared setup for the MATLAB test files (matlab-extraction, matlab-resolution,
 * matlab-sync, matlab-explore). Not a test file itself: vitest only runs
 * `*.test.ts`.
 */
import { beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

/** Loads every grammar before the file's tests run. Call at a test file's top level. */
export function useAllGrammars(): void {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });
}

/** A new empty directory under the OS temp dir, by its real path (macOS's `/var` is `/private/var`). */
export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Writes each file under `root`, creating its folders; a `null` content deletes the file. A Buffer is written byte for byte. */
export function writeTree(root: string, files: Record<string, string | Buffer | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) {
      fs.rmSync(path.join(root, rel), { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `source-file source-qn -kind-> target-qn @ target-file` of every non-`contains` edge in the project, sorted. */
export function allEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const f of cg.getFiles()) {
    const ids = cg.getNodesInFile(f.path).map((n) => n.id);
    for (const e of cg.getOutgoingEdgesFrom(ids)) {
      if (e.kind === 'contains') continue;
      const s = cg.getNode(e.source)!;
      const t = cg.getNode(e.target)!;
      out.push(`${f.path} ${s.qualifiedName} -${e.kind}-> ${t.qualifiedName} @ ${t.filePath}`);
    }
  }
  return out.sort();
}

/** `class-qn > member-qn @ member-file` of every `contains` edge out of a class node, sorted. */
export function classMembers(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const f of cg.getFiles()) {
    const nodes = cg.getNodesInFile(f.path);
    for (const e of cg.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['contains'])) {
      const s = cg.getNode(e.source)!;
      if (s.kind !== 'class') continue;
      const t = cg.getNode(e.target)!;
      out.push(`${s.qualifiedName} > ${t.qualifiedName} @ ${t.filePath}`);
    }
  }
  return out.sort();
}

/** `source-qn -kind-> target-qn @ target-file` of every non-`contains` edge out of a file's symbols (only those named `symbol`, when given), sorted. */
export function edgesFrom(cg: CodeGraph, file: string, symbol?: string): string[] {
  const ids = cg.getNodesInFile(file).filter((n) => !symbol || n.name === symbol).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${cg.getNode(e.source)!.qualifiedName} -${e.kind}-> ${t.qualifiedName} @ ${t.filePath}`;
    })
    .sort();
}

/**
 * `file:line kind:name` of every live row left in `root`'s unresolved_refs
 * (pending or failed: not a dormant one, which no reader counts), sorted.
 */
export function unresolvedRows(root: string): string[] {
  return refRows(root, "status <> 'dormant'");
}

/** `file:line kind:name` of every dormant row in `root`'s unresolved_refs (a MATLAB call no symbol answers now), sorted. */
export function dormantRows(root: string): string[] {
  return refRows(root, "status = 'dormant'");
}

function refRows(root: string, where: string): string[] {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const rows = db.getDb().prepare(`SELECT file_path AS file, line, reference_kind AS kind, reference_name AS name FROM unresolved_refs WHERE ${where}`).all() as Array<{ file: string; line: number; kind: string; name: string }>;
    return rows.map((r) => `${r.file}:${r.line} ${r.kind}:${r.name}`).sort();
  } finally {
    db.close();
  }
}

/** Indexes a throwaway project holding `files`: its {@link allEdges}, {@link classMembers}, {@link unresolvedRows} and {@link dormantRows}. */
export async function indexOfProject(files: Record<string, string>): Promise<{ edges: string[]; members: string[]; unresolved: string[]; dormant: string[] }> {
  const root = tempDir('cg-matlab-project-');
  try {
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    let edges: string[];
    let members: string[];
    try {
      edges = allEdges(cg);
      members = classMembers(cg);
    } finally {
      cg.close();
    }
    return { edges, members, unresolved: unresolvedRows(root), dormant: dormantRows(root) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** {@link allEdges} of a throwaway project holding `files`. */
export async function edgesOfProject(files: Record<string, string>): Promise<string[]> {
  return (await indexOfProject(files)).edges;
}

/** One step of {@link syncedAndFreshEachStep}: the synced and fresh edges, live unresolved rows and dormant rows. */
export interface SyncedStep {
  synced: string[];
  fresh: string[];
  syncedRows: string[];
  freshRows: string[];
  syncedDormant: string[];
  freshDormant: string[];
}

/**
 * Indexes `initial`, applies each step with a sync, and indexes each step's
 * files afresh beside it: per step, the synced and fresh edges and unresolved
 * rows, for a test that every step of a sequence ends where a fresh index
 * does.
 */
export async function syncedAndFreshEachStep(
  initial: Record<string, string>,
  ...steps: Array<Record<string, string | null>>
): Promise<SyncedStep[]> {
  return (await syncSteps(initial, steps)).steps;
}

/**
 * {@link syncedAndFreshEachStep}, read at the end: the edges after the first
 * index and after each step, and the synced and fresh edges and unresolved
 * rows of the last step.
 */
export async function syncedAndFresh(
  initial: Record<string, string>,
  ...steps: Array<Record<string, string | null>>
): Promise<{ steps: string[][] } & SyncedStep> {
  const run = await syncSteps(initial, steps);
  const last = run.steps[run.steps.length - 1]!;
  return { steps: [run.initial, ...run.steps.map((s) => s.synced)], ...last };
}

/** A project's edges, live unresolved rows and dormant rows, as {@link allEdges}, {@link unresolvedRows} and {@link dormantRows} read them. */
export interface ProjectState {
  edges: string[];
  rows: string[];
  dormant: string[];
}

/**
 * What the catalog checks of a state beside its edges and rows (never part of
 * its snapshot): `nodes`, every node as `file qualified-name`;
 * `exceptions`, every stored extraction error that comes from an exception
 * the product caught while extracting a file, as `file: message`; and
 * `sharedPlaces`, every place two or more MATLAB rows and edges share (see
 * sharedMatlabPlaces).
 */
export interface StateFacts {
  nodes: string[];
  exceptions: string[];
  sharedPlaces: string[];
  /**
   * Every MATLAB row and every edge out of a MATLAB node (`contains` too)
   * with what it stores beside its place, one entry each (a multiset: two
   * of one place count twice): a row as `file:line:col kind:name from
   * status candidates name_tail` (`from` its source node's qualified name),
   * an edge as `file:line:col source -kind-> target @ file metadata
   * provenance`. A sync must store these as a fresh index does, facts and
   * their order included (step 15: the `ctor` fact).
   */
  stored: string[];
}

/**
 * The places of a MATLAB index that two or more of its stored references
 * share, each as `file:line:column kind: what is there | …`: its live,
 * failed and dormant rows and its edges (none a synthesis made, which writes
 * an edge per value at one site on purpose), by source, kind, line and
 * column, a row's kind with the edge kinds it resolves to (`calls` with
 * `instantiates`, `function_ref` with `references`). The store keeps one edge
 * per source, target, kind, line and column, so references of one place
 * resolving to one target are one edge, and a sync, which turns an edge back
 * into one row, ends with fewer than a fresh index: every reference the
 * extraction writes has its own place (step 14).
 */
export function sharedMatlabPlaces(d: ReturnType<DatabaseConnection['getDb']>): string[] {
  const family = (k: string) => (k === 'instantiates' ? 'calls' : k === 'references' ? 'function_ref' : k);
  const at = new Map<string, string[]>();
  const add = (key: string, what: string) => (at.get(key) ?? at.set(key, []).get(key)!).push(what);
  for (const r of d.prepare(`SELECT file_path AS f, from_node_id AS s, reference_kind AS k, line AS l, col AS c, reference_name AS n, status AS st FROM unresolved_refs WHERE language = 'matlab'`).all() as Array<{ f: string; s: string; k: string; l: number; c: number; n: string; st: string }>) {
    add(`${r.f}:${r.l}:${r.c} ${family(r.k)}\0${r.s}`, `row ${r.k}:${r.n} ${r.st}`);
  }
  for (const e of d.prepare(`SELECT s.file_path AS f, e.source AS s, e.kind AS k, e.line AS l, e.col AS c, t.qualified_name AS t, e.metadata AS m FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind <> 'contains' AND s.language = 'matlab'`).all() as Array<{ f: string; s: string; k: string; l: number | null; c: number | null; t: string; m: string | null }>) {
    if (e.m && (JSON.parse(e.m) as { synthesizedBy?: unknown }).synthesizedBy !== undefined) continue;
    add(`${e.f}:${e.l}:${e.c} ${family(e.k)}\0${e.s}`, `edge ${e.k} ${e.t}`);
  }
  return [...at].filter(([, v]) => v.length > 1).map(([k, v]) => `${k.split('\0')[0]}: ${v.sort().join(' | ')}`).sort();
}

/**
 * Whether a stored extraction error comes from an exception, not from the
 * text: the product stores an exception thrown while a file is extracted
 * (the extractor's catch, the parse worker's, recordParseFailure in
 * src/extraction/index.ts) as a `parse_error` of severity `error`, and a file
 * that merely fails to parse as a `parse_error` of severity `warning`.
 * scripts/matlab/fuzz/harness.mjs applies the same test.
 */
export function isExtractionException(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as { code?: unknown; severity?: unknown; message?: unknown };
  if (x.code !== 'parse_error') return false;
  if (x.severity === 'error') return true;
  return x.severity === undefined && /^(Parse error|Parse worker error): /.test(String(x.message ?? ''));
}

/** {@link StateFacts} of the index at `root`. */
export function stateFacts(root: string): StateFacts {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const d = db.getDb();
    const nodes = (d.prepare('SELECT file_path AS f, qualified_name AS q FROM nodes').all() as Array<{ f: string; q: string }>).map((n) => `${n.f} ${n.q}`).sort();
    const exceptions: string[] = [];
    for (const f of d.prepare('SELECT path AS p, errors AS e FROM files').all() as Array<{ p: string; e: string | null }>) {
      if (!f.e) continue;
      let list: unknown;
      try { list = JSON.parse(f.e); } catch { list = [{ code: 'parse_error', message: String(f.e) }]; }
      for (const e of Array.isArray(list) ? list : [list]) if (isExtractionException(e)) exceptions.push(`${f.p}: ${String((e as { message?: unknown }).message ?? '')}`);
    }
    const rows = (d.prepare(`SELECT r.file_path AS f, r.line AS l, r.col AS c, r.reference_kind AS k, r.reference_name AS n, n.qualified_name AS q, r.status AS s, r.candidates AS cs, r.name_tail AS t
      FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.from_node_id WHERE r.language = 'matlab'`).all() as Array<Record<string, string | number | null>>)
      .map((r) => `${r.f}:${r.l}:${r.c} ${r.k}:${r.n} from=${r.q ?? ''} ${r.s} ${r.cs ?? ''} ${r.t}`);
    const edges = (d.prepare(`SELECT s.file_path AS f, e.line AS l, e.col AS c, s.qualified_name AS sq, e.kind AS k, t.qualified_name AS tq, t.file_path AS tf, e.metadata AS m, e.provenance AS p
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE s.language = 'matlab'`).all() as Array<Record<string, string | number | null>>)
      .map((e) => `${e.f}:${e.l}:${e.c} ${e.sq} -${e.k}-> ${e.tq} @ ${e.tf} ${e.m ?? ''} ${e.p ?? ''}`);
    return { nodes, exceptions: exceptions.sort(), sharedPlaces: sharedMatlabPlaces(d), stored: [...rows, ...edges].sort() };
  } finally {
    db.close();
  }
}

/**
 * {@link syncedAndFreshEachStep}, with the first index's state too: the
 * edges and rows `initial` indexes to, then each step's synced and fresh
 * state. With no steps it is one fresh index. The MATLAB case catalog
 * (matlab-cases.test.ts) reads every case through it. Files may be Buffers,
 * for a case that needs exact bytes. `facts` holds each state's
 * {@link StateFacts}: the first index's, then each step's synced and fresh.
 */
export async function indexThenSyncEachStep(
  initial: Record<string, string | Buffer>,
  ...steps: Array<Record<string, string | Buffer | null>>
): Promise<{ initial: ProjectState; steps: SyncedStep[]; facts: { initial: StateFacts; steps: Array<{ synced: StateFacts; fresh: StateFacts }> } }> {
  const run = await syncSteps(initial, steps);
  return { initial: { edges: run.initial, rows: run.initialRows, dormant: run.initialDormant }, steps: run.steps, facts: run.facts };
}

async function syncSteps(
  initial: Record<string, string | Buffer>,
  steps: Array<Record<string, string | Buffer | null>>,
): Promise<{ initial: string[]; initialRows: string[]; initialDormant: string[]; steps: SyncedStep[]; facts: { initial: StateFacts; steps: Array<{ synced: StateFacts; fresh: StateFacts }> } }> {
  const root = tempDir('cg-matlab-sync-');
  const current: Record<string, string | Buffer | null> = { ...initial };
  writeTree(root, initial);
  const cg = await CodeGraph.init(root, { index: true });
  const out: SyncedStep[] = [];
  try {
    const first = allEdges(cg);
    const initialRows = unresolvedRows(root);
    const initialDormant = dormantRows(root);
    const facts = { initial: stateFacts(root), steps: [] as Array<{ synced: StateFacts; fresh: StateFacts }> };
    for (const step of steps) {
      writeTree(root, step);
      Object.assign(current, step);
      await cg.sync();
      const freshRoot = tempDir('cg-matlab-fresh-');
      try {
        writeTree(freshRoot, Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)) as Record<string, string | Buffer>);
        const fresh = await CodeGraph.init(freshRoot, { index: true });
        let freshEdges: string[];
        try {
          freshEdges = allEdges(fresh);
        } finally {
          fresh.close();
        }
        out.push({
          synced: allEdges(cg), fresh: freshEdges,
          syncedRows: unresolvedRows(root), freshRows: unresolvedRows(freshRoot),
          syncedDormant: dormantRows(root), freshDormant: dormantRows(freshRoot),
        });
        facts.steps.push({ synced: stateFacts(root), fresh: stateFacts(freshRoot) });
      } finally {
        fs.rmSync(freshRoot, { recursive: true, force: true });
      }
    }
    return { initial: first, initialRows, initialDormant, steps: out, facts };
  } finally {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
