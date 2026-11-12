/**
 * Members a type keeps in another file than its declaration: a Go method
 * beside its struct's file, a MATLAB class-folder method (`@Shape/describe.m`).
 * Each is contained twice — by its own file, at extraction, and by its type,
 * through an edge a later pass synthesizes. The dead-code report takes the
 * type as the member's container whichever edge comes first (what its
 * override and hook rules read), and `codegraph_node`'s outline of the type
 * lists such a member after its own ones, with its own file and line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { containersOf } from '../src/graph/dead-code';
import { ToolHandler } from '../src/mcp/tools';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

const GO = {
  'go.mod': 'module example.com/w\n\ngo 1.21\n',
  'runner.go': 'package w\n\ntype runner interface {\n\trun() int\n}\n\nfunc drive(r runner) int {\n\treturn r.run()\n}\n\nfunc Main() int {\n\treturn drive(&worker{})\n}\n',
  'worker.go': 'package w\n\ntype worker struct {\n\tn int\n}\n\nfunc (w *worker) size() int {\n\treturn w.n\n}\n',
  'worker_run.go': 'package w\n\nfunc (w *worker) run() int {\n\treturn w.n + 1\n}\n\nfunc (w *worker) stop() {}\n',
};

const MATLAB = {
  'Base.m': 'classdef Base < handle\n    methods\n        function describe(obj)\n            disp(obj);\n        end\n    end\nend\n',
  '@Shape/Shape.m': 'classdef Shape < Base\n    methods\n        function a = area(obj)\n            a = 0;\n        end\n    end\nend\n',
  '@Shape/describe.m': 'function describe(obj)\n    disp(class(obj));\nend\n',
  '@Shape/scale.m': 'function scale(obj, k)\n    disp(k);\nend\n',
  'main.m': 'function main()\ns = Shape();\nshow(s);\nend\n\nfunction show(b)\nb.describe();\nend\n',
};

describe.each([
  {
    language: 'Go',
    files: GO,
    type: 'worker',
    containers: ['worker::run @ worker_run.go -> worker', 'worker::size @ worker.go -> worker', 'worker::stop @ worker_run.go -> worker'],
    outline: [
      '**Members (3):**',
      '',
      '- size (method):7 — `() int`',
      '- run (method) in `worker_run.go:3` — `() int`',
      '- stop (method) in `worker_run.go:7` — `()`',
    ],
  },
  {
    language: 'MATLAB',
    files: MATLAB,
    type: 'Shape',
    containers: ['Shape::area @ @Shape/Shape.m -> Shape', 'Shape::describe @ @Shape/describe.m -> Shape', 'Shape::scale @ @Shape/scale.m -> Shape'],
    outline: [
      '**Members (3):**',
      '',
      '- area (method):3 — `function a = area(obj)`',
      '- describe (method) in `@Shape/describe.m:1` — `function describe(obj)`',
      '- scale (method) in `@Shape/scale.m:1` — `function scale(obj, k)`',
    ],
  },
])('$language members kept in another file than their type', ({ files, type, containers, outline }) => {
  let root = '';
  let cg: CodeGraph;
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cross-file-members-')));
    writeTree(root, files);
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('are the type\'s members for the dead-code report, not their file\'s', () => {
    const owner = cg.getNodesByName(type).find((n) => n.kind !== 'file')!;
    const members = cg.getChildren(owner.id).filter((n) => n.kind === 'method');
    // Contained by their file as well, first: the type wins whichever edge comes first.
    const elsewhere = members.filter((m) => m.filePath !== owner.filePath);
    expect(elsewhere.length).toBe(2);
    for (const m of elsewhere) {
      expect(cg.getIncomingEdgesTo([m.id], ['contains']).map((e) => cg.getNode(e.source)!.kind)).toEqual(['file', owner.kind]);
    }
    const found = containersOf(cg, members);
    expect(members.map((m) => `${m.qualifiedName} @ ${m.filePath} -> ${found.get(m.id)?.qualifiedName}`).sort()).toEqual(containers);
  });

  it('are listed in the type\'s outline with their own file and line', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_node', { symbol: type, includeCode: true });
    const text = res.content[0]!.text;
    const start = text.indexOf('**Members (');
    expect(text.slice(start).split('\n').slice(0, outline.length)).toEqual(outline);
    expect(text).toContain('> Structural outline only. A member listed with a file lives in that file');
  });
});
