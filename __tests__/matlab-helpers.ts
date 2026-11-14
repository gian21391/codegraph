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

/** Writes each file under `root`, creating its folders; a `null` content deletes the file. */
export function writeTree(root: string, files: Record<string, string | null>): void {
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

/** `file:line kind:name` of every row left in `root`'s unresolved_refs, sorted. */
export function unresolvedRows(root: string): string[] {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const rows = db.getDb().prepare('SELECT file_path AS file, line, reference_kind AS kind, reference_name AS name FROM unresolved_refs').all() as Array<{ file: string; line: number; kind: string; name: string }>;
    return rows.map((r) => `${r.file}:${r.line} ${r.kind}:${r.name}`).sort();
  } finally {
    db.close();
  }
}

/** Indexes a throwaway project holding `files`: its {@link allEdges}, {@link classMembers} and {@link unresolvedRows}. */
export async function indexOfProject(files: Record<string, string>): Promise<{ edges: string[]; members: string[]; unresolved: string[] }> {
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
    return { edges, members, unresolved: unresolvedRows(root) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** {@link allEdges} of a throwaway project holding `files`. */
export async function edgesOfProject(files: Record<string, string>): Promise<string[]> {
  return (await indexOfProject(files)).edges;
}

/** One step of {@link syncedAndFreshEachStep}: the synced and fresh edges and unresolved rows. */
export interface SyncedStep {
  synced: string[];
  fresh: string[];
  syncedRows: string[];
  freshRows: string[];
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
): Promise<{ steps: string[][]; synced: string[]; fresh: string[]; syncedRows: string[]; freshRows: string[] }> {
  const run = await syncSteps(initial, steps);
  const last = run.steps[run.steps.length - 1]!;
  return { steps: [run.initial, ...run.steps.map((s) => s.synced)], ...last };
}

async function syncSteps(initial: Record<string, string>, steps: Array<Record<string, string | null>>): Promise<{ initial: string[]; steps: SyncedStep[] }> {
  const root = tempDir('cg-matlab-sync-');
  const current: Record<string, string | null> = { ...initial };
  writeTree(root, initial);
  const cg = await CodeGraph.init(root, { index: true });
  const out: SyncedStep[] = [];
  try {
    const first = allEdges(cg);
    for (const step of steps) {
      writeTree(root, step);
      Object.assign(current, step);
      await cg.sync();
      const freshRoot = tempDir('cg-matlab-fresh-');
      try {
        writeTree(freshRoot, Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)));
        const fresh = await CodeGraph.init(freshRoot, { index: true });
        let freshEdges: string[];
        try {
          freshEdges = allEdges(fresh);
        } finally {
          fresh.close();
        }
        out.push({ synced: allEdges(cg), fresh: freshEdges, syncedRows: unresolvedRows(root), freshRows: unresolvedRows(freshRoot) });
      } finally {
        fs.rmSync(freshRoot, { recursive: true, force: true });
      }
    }
    return { initial: first, steps: out };
  } finally {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
