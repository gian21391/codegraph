/**
 * A sync records only indexed files as synthesis inputs (#2565).
 *
 * A lazy value that loads a workspace package, `dynamic(() =>
 * import('icons').then((m) => m.EdgeFunctions))`, names the package's
 * directory as the module it reads. Synthesis recorded that directory as an
 * input, and `synthesis_inputs.file_path` references `files(path)`, so the
 * commit failed with "FOREIGN KEY constraint failed" and the whole sync rolled
 * back. Every later sync failed the same way. A full index of the same tree
 * succeeded.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { SynthesisStage } from '../src/db/synthesis-stage';
import { SYNTH_PASSES, hasSynthesisPattern, synthesisInputs } from '../src/resolution/callback-synthesizer';
import type { ResolutionContext } from '../src/resolution/types';

type Files = Record<string, string>;

/** A pnpm workspace whose app lazy-loads a component from a workspace package (supabase studio's shape). */
const WORKSPACE: Files = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'package.json': JSON.stringify({ name: 'app', private: true, workspaces: ['packages/*'], dependencies: { react: '^18.0.0', next: '^14.0.0' } }),
  'packages/icons/package.json': JSON.stringify({ name: 'icons', main: './src/icons/index.ts' }),
  'packages/icons/src/icons/index.ts': 'export function EdgeFunctions() {\n  return null;\n}\n',
  'src/App.tsx':
    "import dynamic from 'next/dynamic';\n" +
    "const Chart = dynamic(() => import('icons').then((mod) => mod.EdgeFunctions));\n" +
    'export function App() {\n  return <Chart />;\n}\n',
};

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function write(root: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

async function indexed(files: Files): Promise<{ root: string; graph: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-synth-inputs-'));
  roots.push(root);
  write(root, files);
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return { root, graph };
}

/** Every edge, by its ends' natural keys. */
function edgesOf(graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  return graph.getOutgoingEdgesFrom([...keys.keys()])
    .map((e) => `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`)
    .sort();
}

describe('a sync whose lazy value loads a workspace package', () => {
  it('commits instead of failing on the package directory, and matches a fresh index', async () => {
    const { root, graph } = await indexed(WORKSPACE);
    const appended = { 'src/App.tsx': `${WORKSPACE['src/App.tsx']}// touched\n` };
    write(root, appended);
    const result = await graph.sync();
    expect(result.filesModified).toBe(1);

    // A second sync after another edit still works: nothing was left half-done.
    write(root, { 'src/App.tsx': `${appended['src/App.tsx']}// touched again\n` });
    expect((await graph.sync()).filesModified).toBe(1);

    const fresh = await indexed({ ...WORKSPACE, 'src/App.tsx': `${appended['src/App.tsx']}// touched again\n` });
    expect(edgesOf(graph)).toEqual(edgesOf(fresh.graph));
  }, 120_000);
});

describe('recording synthesis inputs', () => {
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  /** A fresh database holding one indexed file, `src/App.tsx`. */
  function freshDb(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-inputs-db-'));
    roots.push(dir);
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.upsertFile({ path: 'src/App.tsx', contentHash: 'h', language: 'tsx', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0, errors: [], generated: false } as never);
  }
  const recorded = (): string[] =>
    (connection.getDb().prepare('SELECT file_path FROM synthesis_inputs ORDER BY file_path').all() as Array<{ file_path: string }>).map((r) => r.file_path);

  afterEach(() => connection?.close());

  it('keeps only indexed files when written straight to the index', () => {
    freshDb();
    queries.replaceSynthesisInputs(['packages/icons', 'src/App.tsx', 'src/deleted.ts']);
    expect(recorded()).toEqual(['src/App.tsx']);
  });

  it('keeps only indexed files when a stage publishes them, whatever the stage was handed', async () => {
    freshDb();
    const stage = new SynthesisStage(connection.getPath());
    try {
      // A file that leaves the index while the passes run reaches the stage's
      // own list unchecked; publishing must still only keep indexed files.
      stage.db.exec("INSERT INTO temp.synthesis_inputs (file_path) VALUES ('packages/icons'), ('src/App.tsx'), ('src/deleted.ts')");
      await stage.publish();
    } finally { stage.close(); }
    expect(recorded()).toEqual(['src/App.tsx']);
  });
});

describe('what every synthesis reads, and which passes it runs', () => {
  const BUS: Files = {
    'package.json': JSON.stringify({ name: 'app' }),
    'src/bus.js': "const { EventEmitter } = require('events');\nconst bus = new EventEmitter();\nmodule.exports = { bus };\n",
    'src/handlers.js': "const { bus } = require('./bus');\nfunction onSaved(doc) { return doc; }\nbus.on('saved', onSaved);\nmodule.exports = { onSaved };\n",
    'src/service.js': "const { bus } = require('./bus');\nfunction save(doc) { bus.emit('saved', doc); return doc; }\nmodule.exports = { save };\n",
  };

  // MATLAB code that reads like an emitter's (`bus.emit('saved')`,
  // `bus.on('saved', onSaved)`): in MATLAB a bare name passed to a call is a
  // call of it, so a pairing made from it would be a wrong edge.
  const MATLAB_BUS: Files = {
    'tools/notify_all.m': "function notify_all(bus)\n  bus.emit('saved');\nend\n",
    'tools/listen.m': "function listen(bus)\n  bus.on('saved', onSaved);\nend\n",
    'tools/onSaved.m': 'function onSaved(doc)\n  disp(doc);\nend\n',
  };

  /** What the emitter pass reads of `tree`, indexed, and the pairs it makes. */
  async function emitterRun(tree: Files): Promise<{ reads: string[]; pairs: string[] }> {
    const { root, graph } = await indexed(tree);
    graph.close();
    graphs = graphs.filter((g) => g !== graph);
    const connection = DatabaseConnection.open(path.join(root, '.codegraph', 'codegraph.db'));
    try {
      const queries = new QueryBuilder(connection.getDb());
      const files = queries.getAllFilePaths();
      const reads: string[] = [];
      const ctx = {
        getAllFiles: () => files,
        readFile: (file: string) => {
          reads.push(file);
          return fs.readFileSync(path.join(root, file), 'utf-8');
        },
        getNodesInFile: (file: string) => queries.getNodesByFiles([file]),
        getNodesByName: (name: string) => queries.getNodesByName(name),
      } as unknown as ResolutionContext;
      const edges = await SYNTH_PASSES.find((p) => p.name === 'emitterEdges')!.run(queries, ctx, async () => {});
      const name = (id: string) => queries.getNodeById(id)!.name;
      return { reads, pairs: edges.map((e) => `${name(e.source)}->${name(e.target)}`) };
    } finally {
      connection.close();
    }
  }

  it('pairs an emitter\'s event with its handler in JavaScript, and reads no file of a MATLAB-only project', async () => {
    const { graph } = await indexed(BUS);
    const save = graph.getNodesByName('save').find((n) => n.kind === 'function')!;
    const synthesized = graph.getOutgoingEdges(save.id).filter((e) => e.metadata?.synthesizedBy === 'event-emitter');
    expect(synthesized.map((e) => graph.getNode(e.target)!.name)).toEqual(['onSaved']);

    expect(await emitterRun(MATLAB_BUS)).toEqual({ reads: [], pairs: [] });
  }, 120_000);

  it('reads no MATLAB file for emitters in a project of MATLAB and JavaScript, and still pairs the JavaScript', async () => {
    const { reads, pairs } = await emitterRun({ ...BUS, ...MATLAB_BUS });
    expect(reads.filter((f) => f.endsWith('.m'))).toEqual([]);
    expect(pairs).toEqual(['save->onSaved']);
  }, 120_000);

  it('takes a stored MATLAB file for an input without reading it, but not one of Octave or binary text, and reads every other file', async () => {
    const OCTAVE = '## Copyright (C) 2000 A. Author\nfunction t = stamp\n  t = 1;\nendfunction\n';
    const BLOB = 'Z9QPK7731TRW2200QXV0011y\u0001\u0000\u0000\u0087 pause(1)\n';
    const { root, graph } = await indexed({
      'run_all.m': 'x = 1;\n',
      'lib/solve.m': 'function y = solve(x)\n  y = x;\nend\n',
      'notes.m': '% help text only\n',
      'octave/stamp.m': OCTAVE,
      'deploy/pause.m': BLOB,
      'src/app.ts': 'export function render() { return 1; }\n',
      'src/plain.ts': 'export const answer = 42;\n',
    });
    graph.close();
    graphs = graphs.filter((g) => g !== graph);
    const connection = DatabaseConnection.open(path.join(root, '.codegraph', 'codegraph.db'));
    try {
      const queries = new QueryBuilder(connection.getDb());
      const files = queries.getAllFilePaths();
      const reads: string[] = [];
      const ctx = {
        getAllFiles: () => files,
        readFile: (file: string) => {
          reads.push(file);
          return fs.readFileSync(path.join(root, file), 'utf-8');
        },
      } as unknown as ResolutionContext;
      const inputs = await synthesisInputs(queries, ctx, async () => {});
      expect(reads.sort()).toEqual(['src/app.ts', 'src/plain.ts']);
      expect(inputs.sort()).toEqual(['lib/solve.m', 'notes.m', 'run_all.m', 'src/app.ts']);
      // An edit that leaves such a file Octave or binary text feeds no pass either.
      expect(hasSynthesisPattern('octave/stamp.m', OCTAVE)).toBe(false);
      expect(hasSynthesisPattern('deploy/pause.m', BLOB)).toBe(false);
      expect(hasSynthesisPattern('lib/solve.m', 'function y = solve(x)\n  y = x;\nend\n')).toBe(true);
      // The pass's node count, without counting edges.
      expect(queries.getNodeCount()).toBe(queries.getNodeAndEdgeCount().nodes);
    } finally {
      connection.close();
    }
  }, 120_000);
});
