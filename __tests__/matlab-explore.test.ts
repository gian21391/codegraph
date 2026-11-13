/**
 * MATLAB in what agents and the viewer read: codegraph_explore on class
 * folders and scripts (and on a project with no MATLAB file), codegraph_node's
 * outline of a class folder, the viewer's steps through a script, and the
 * dead-code check's use of the unresolved rows MATLAB keeps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { buildSteps } from '../src/ui-server/api/steps';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { allEdges, tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

describe('MATLAB class folders in codegraph_explore', () => {
  it('codegraph_explore reaches a class folder\'s method files from "Class method" queries', async () => {
    // The class folder of matlab-resolution's 'MATLAB lookup across a project', with
    // plot.m: a method file the query does not name.
    const project = tempDir('cg-matlab-explore-robot-');
    writeTree(project, {
      '@Robot/Robot.m': 'classdef Robot < handle\n    properties\n        Q\n    end\n    methods\n        function r = Robot()\n            r.Q = 0;\n        end\n    end\nend\n',
      '@Robot/move.m': 'function move(r, x)\n    step(r, x);\n    plot(x, x);\nend\n',
      '@Robot/step.m': 'function step(r, x)\n    r.Q = r.Q + x;\nend\n',
      '@Robot/plot.m': 'function plot(r)\n    disp(r.Q);\nend\n',
    });
    const robot = await CodeGraph.init(project, { index: true });
    try {
      // `step` is a bare lowercase word with nothing else named in step.m; the
      // query naming Robot is what corroborates it.
      const res = await new ToolHandler(robot).execute('codegraph_explore', { query: 'Robot move step' });
      const text = res.content[0]!.text;
      const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
      // Named methods take the named-first tier, ahead of the class file.
      expect(sourced.slice(0, 2).sort()).toEqual(['@Robot/move.m', '@Robot/step.m']);
    } finally {
      robot.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('MATLAB class folders in codegraph_node', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = tempDir('cg-matlab-explore-folders-');
    writeTree(root, {
      '@Robot/Robot.m': 'classdef Robot < handle\n    properties\n        Q\n    end\n    methods\n        function r = Robot()\n            r.Q = 0;\n        end\n    end\nend\n',
      '@Robot/move.m': 'function move(r, x)\n    step(r, aux(x));\nend\n\nfunction y = aux(x)\n    y = x;\nend\n',
      '@Robot/step.m': 'function step(r, x)\n    r.Q = r.Q + x;\nend\n',
      // Another class folder: its method stays out of Robot's outline.
      '+geo/@Shape/Shape.m': 'classdef Shape < handle\n    methods\n        function s = Shape()\n        end\n    end\nend\n',
      '+geo/@Shape/area.m': 'function a = area(s)\n    a = 1;\nend\n',
      'main.m': 'function main()\n    r = Robot();\n    move(r, 1);\nend\n',
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists class-folder methods in codegraph_node\'s outline by their own file', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_node', { symbol: 'Robot', includeCode: true });
    const text = res.content[0]!.text;
    const members = text.split('\n').filter((l) => l.startsWith('- '));
    expect(members).toEqual([
      '- Q (property):3 — `Q`',
      '- Robot (method):6 — `function r = Robot()`',
      '- move (method) in `@Robot/move.m:1` — `function move(r, x)`',
      '- step (method) in `@Robot/step.m:1` — `function step(r, x)`',
    ]);
    expect(text).not.toContain('Read `@Robot/Robot.m`');
  });
});

describe('MATLAB scripts in codegraph_explore', () => {
  it('shows the source of a script on the Flow, named or not', async () => {
    const root = tempDir('cg-matlab-explore-');
    writeTree(root, {
      'main.m': 'function main()\nsetup_paths\nrun_analysis(2);\nend\n',
      'setup_paths.m': '% adds the paths\naddpath(pwd);\nhelper_fn(1);\n',
      'helper_fn.m': 'function helper_fn(x)\ndisp(x);\nend\n',
      'run_analysis.m': 'function run_analysis(n)\ndisp(n);\nend\n',
      // A plain word for a name, which only the function running it corroborates.
      'BeamLine.m': 'function BL = BeamLine(c)\nglobals\nBL = c;\nend\n',
      'globals.m': 'global ELEM\nELEM = {};\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const query of ['main setup_paths helper_fn', 'main helper_fn']) {
        const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
        const text = res.content[0]!.text;
        expect(text).toContain('2. setup_paths.m (setup_paths.m:1)');
        expect(text).toContain('**`setup_paths.m`**');
        expect(text).toContain('3\thelper_fn(1);');
      }
      // A script only passed through is rendered, but after the files the query names.
      const passing = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'main helper_fn' })).content[0]!.text;
      expect([...passing.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1])).toEqual(['helper_fn.m', 'main.m', 'setup_paths.m']);
      const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'BeamLine globals' });
      expect(res.content[0]!.text).toContain('**`globals.m`**');
      expect(res.content[0]!.text).toContain('2\tELEM = {};');
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB scripts in codegraph_explore are the resolver\'s scripts', () => {
  it('shows a script named alone, and no Octave file, help text or package file of the name', async () => {
    const root = tempDir('cg-matlab-explore-scripts-');
    writeTree(root, {
      'real_script.m': 'z = 3;\n',
      'oct_script.m': '# an Octave comment\nx = 1;\n',
      'mex_help.m': '% MEX_HELP  help text of a MEX function\n',
      '+pkg/pkg_script.m': 'y = 2;\n',
      'helper_fn.m': 'function helper_fn(x)\ndisp(x);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      /** The file nodes explore shows the source of for `helper_fn <name>`. */
      const shown = async (name: string): Promise<string[]> => {
        const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: `helper_fn ${name}` })).content[0]!.text;
        return [...text.matchAll(/^\*\*`([^`]+)`\*\* — \S+\(file\)$/gm)].map((m) => m[1]!);
      };
      expect(await shown('real_script')).toEqual(['real_script.m']);
      for (const name of ['oct_script', 'mex_help', 'pkg_script']) expect(await shown(name)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('asks nothing of a project with no MATLAB file', async () => {
    const root = tempDir('cg-matlab-explore-none-');
    writeTree(root, { 'src/app.ts': 'export function startApp(): number {\n  return 1;\n}\n' });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const names: string[] = [];
      const byName = cg.getNodesByName.bind(cg);
      cg.getNodesByName = (name: string) => {
        names.push(name);
        return byName(name);
      };
      await new ToolHandler(cg).execute('codegraph_explore', { query: 'startApp setup_paths' });
      expect(names.filter((n) => /\.m$/i.test(n))).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB scripts in the viewer\'s steps', () => {
  it('judges a script the walk reaches once per request, and again in the next', async () => {
    const root = tempDir('cg-matlab-steps-');
    writeTree(root, {
      'main.m': 'function main()\nsetup_paths\nhelper(1);\nsetup_paths\nend\n',
      'helper.m': 'function helper(x)\nsetup_paths\nend\n',
      'setup_paths.m': 'addpath(pwd);\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // Three calls reach the script, from two functions.
      expect(allEdges(cg)).toEqual([
        'helper.m helper -calls-> setup_paths.m @ setup_paths.m',
        'main.m main -calls-> helper @ helper.m',
        'main.m main -calls-> setup_paths.m @ setup_paths.m',
        'main.m main -calls-> setup_paths.m @ setup_paths.m',
      ]);
      let reads = 0;
      const getNodesInFile = cg.getNodesInFile.bind(cg);
      cg.getNodesInFile = (filePath: string) => {
        if (filePath === 'setup_paths.m') reads++;
        return getNodesInFile(filePath);
      };
      const main = cg.getNodesInFile('main.m').find((n) => n.name === 'main')!;
      const payload = await buildSteps(cg, root, new URLSearchParams({ anchor: main.id }));
      expect(payload.steps.map((st) => [st.label, st.kind])).toEqual([['main', 'anchor']]);
      expect(reads).toBe(1);
      await buildSteps(cg, root, new URLSearchParams({ anchor: main.id }));
      expect(reads).toBe(2);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB and the dead-code check', () => {
  it('keeps `size(obj, …)` on a class with no size when another class defines one, so that method is not called dead', async () => {
    const root = tempDir('cg-matlab-dead-code-size-');
    writeTree(root, {
      'Acc.m': 'classdef Acc\n    methods\n        function n = size(obj)\n            n = 1;\n        end\n    end\nend\n',
      'Cls.m': 'classdef Cls\n    methods\n        function n = count(obj)\n            n = size(obj, 2);\n        end\n    end\nend\n',
      // What makes Acc.m reachable, so that its methods are candidates at all.
      'main.m': 'function main()\na = Acc();\nc = Cls();\ncount(c);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // Cls::size is no method of Cls's, and Acc's size is another class's: no edge to it.
      expect(allEdges(cg)).toEqual([
        'main.m main -calls-> Cls::count @ Cls.m',
        'main.m main -instantiates-> Acc @ Acc.m',
        'main.m main -instantiates-> Cls @ Cls.m',
      ]);
      expect(unresolvedRows(root)).toEqual(['Cls.m:4 calls:Cls::size']);
      expect([...cg.getUnresolvedNamesAmong(['size'])]).toEqual(['size']);
      // The kept row is what holds Acc's size back from being called dead.
      const report = buildDeadCodeReport(cg, { kinds: ['method'], includeExported: true });
      expect(report.entries.map((e) => e.node.qualifiedName)).not.toContain('Acc::size');
      expect(report.excluded.unresolvedName).toBe(1);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
