/**
 * MATLAB calls that reach the index only through MATLAB's own rules: a script
 * run by name (its file node), an old-style `@Cls` class (its constructor
 * function, under a class node), and a method on a variable whose class the
 * code says (`aa = Cls;`) or that a class hierarchy settles.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { buildSteps } from '../src/ui-server/api/steps';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function writeFiles(root: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) {
      fs.rmSync(path.join(root, rel), { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `source-file source-qn -kind-> target-qn @ target-file` of every non-`contains` edge, and `class > member @ file` of every class's contains edge. */
function edgesOf(cg: CodeGraph): { edges: string[]; members: string[] } {
  const edges: string[] = [];
  const members: string[] = [];
  for (const f of cg.getFiles()) {
    const nodes = cg.getNodesInFile(f.path);
    for (const e of cg.getOutgoingEdgesFrom(nodes.map((n) => n.id))) {
      const s = cg.getNode(e.source)!;
      const t = cg.getNode(e.target)!;
      if (e.kind !== 'contains') edges.push(`${f.path} ${s.qualifiedName} -${e.kind}-> ${t.qualifiedName} @ ${t.filePath}`);
      else if (s.kind === 'class') members.push(`${s.qualifiedName} > ${t.qualifiedName} @ ${t.filePath}`);
    }
  }
  return { edges: edges.sort(), members: members.sort() };
}

/** {@link edgesOf} of every non-`contains` edge plus the unresolved rows. */
async function indexOfProject(files: Record<string, string>): Promise<{ edges: string[]; members: string[]; unresolved: string[] }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-coverage-')));
  writeFiles(root, files);
  const cg = await CodeGraph.init(root, { index: true });
  try {
    const { edges, members } = edgesOf(cg);
    cg.close();
    const db = DatabaseConnection.open(getDatabasePath(root));
    let unresolved: string[];
    try {
      const rows = db.getDb().prepare('SELECT file_path AS file, line, reference_name AS name FROM unresolved_refs').all() as Array<{ file: string; line: number; name: string }>;
      unresolved = rows.map((r) => `${r.file}:${r.line} ${r.name}`);
    } finally {
      db.close();
    }
    return { edges, members, unresolved: unresolved.sort() };
  } finally {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('MATLAB scripts run by name', () => {
  it('links a statement naming a script, and `run` naming one, to the script\'s file — and nothing else', async () => {
    const { edges } = await indexOfProject({
      'setup_paths.m': '% adds the project\'s folders\naddpath(pwd);\n',
      'lib/config.m': 'cfg = 1;\n',
      // The help text of a MEX function of that name: MATLAB runs the MEX file.
      'doc_only.m': '% DOC_ONLY  help for a MEX function\n%   y = doc_only(x)\n',
      // Outside the path's plain folders.
      '+pkg/pkgscript.m': 'q = 1;\n',
      'private/privscript.m': 'q = 1;\n',
      // Octave's, which goes unread.
      'oct.m': '# an Octave script\nx = 1;\n',
      'main.m': [
        'function main()',
        'setup_paths', // command syntax
        'setup_paths;',
        'if true, config, end',
        'run config',
        "run('config.m')",
        'run("setup_paths")',
        'x = config;', // a value: a script returns none
        'f(config);', // an argument
        'foo(1, ...',
        '    config);', // a continued line
        'doc_only',
        'pkgscript',
        'privscript',
        'oct',
        "run('lib/config')", // a path: not read
        'h = @setup_paths;', // a handle runs no script
        'end',
        '',
      ].join('\n'),
      // A script's code runs another script.
      'runner.m': 'setup_paths\n',
    });
    expect(edges).toEqual([
      'main.m main -calls-> lib/config.m @ lib/config.m',
      'main.m main -calls-> lib/config.m @ lib/config.m',
      'main.m main -calls-> lib/config.m @ lib/config.m',
      'main.m main -calls-> setup_paths.m @ setup_paths.m',
      'main.m main -calls-> setup_paths.m @ setup_paths.m',
      'main.m main -calls-> setup_paths.m @ setup_paths.m',
      'runner.m runner.m -calls-> setup_paths.m @ setup_paths.m',
    ]);
  });

  it('takes the nearest file of the name, script or function, and only a function when called with arguments', async () => {
    const { edges } = await indexOfProject({
      'a/tool.m': 'function tool(n)\nend\n',
      'b/tool.m': 'disp(1);\n',
      'a/useA.m': 'function useA()\ntool\nend\n',
      'b/useB.m': 'function useB()\ntool\ntool(1)\nend\n',
    });
    expect(edges).toEqual([
      'a/useA.m useA -calls-> tool @ a/tool.m',
      'b/useB.m useB -calls-> b/tool.m @ b/tool.m',
      'b/useB.m useB -calls-> tool @ a/tool.m',
    ]);
  });
});

describe('MATLAB scripts in codegraph_explore', () => {
  it('shows the source of a script on the Flow, named or not', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-')));
    writeFiles(root, {
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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-scripts-')));
    writeFiles(root, {
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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-none-')));
    writeFiles(root, { 'src/app.ts': 'export function startApp(): number {\n  return 1;\n}\n' });
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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-steps-')));
    writeFiles(root, {
      'main.m': 'function main()\nsetup_paths\nhelper(1);\nsetup_paths\nend\n',
      'helper.m': 'function helper(x)\nsetup_paths\nend\n',
      'setup_paths.m': 'addpath(pwd);\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // Three calls reach the script, from two functions.
      expect(edgesOf(cg).edges).toEqual([
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

describe('MATLAB files with an upper-case `.M`', () => {
  it('are called by their name: a function file and a script', async () => {
    const { edges } = await indexOfProject({
      'main.m': 'function main()\nFoo(1);\nSetup\nend\n',
      'lib/Foo.M': 'function y = Foo(x)\ny = x;\nend\n',
      'Setup.M': 'addpath(pwd);\n',
    });
    expect(edges).toEqual([
      'main.m main -calls-> Foo @ lib/Foo.M',
      'main.m main -calls-> Setup.M @ Setup.M',
    ]);
  });
});

describe('MATLAB old-style classes', () => {
  it('makes `@Cls/Cls.m` a class that contains its constructor and the folder\'s methods; `Cls(…)` instantiates it and `@Cls` names the constructor', async () => {
    const { edges, members, unresolved } = await indexOfProject({
      '@Poly/Poly.m': "function p = Poly(c)\np.c = c;\np = class(p, 'Poly');\nend\n",
      '@Poly/value.m': 'function v = value(p, x)\nv = x;\nend\n',
      // `TPS.m` in `@tps` is a method of `tps`, not a constructor: no class.
      '@tps/TPS.m': 'function t = TPS(x)\nt = x;\nend\n',
      // Methods of a built-in type: no constructor, no class.
      '@double/twice.m': 'function y = twice(x)\ny = 2 * x;\nend\n',
      'use.m': 'function use()\np = Poly([1 2]);\nh = @Poly;\nv = value(p, 3);\nq = Poly;\nt = TPS(1);\nend\n',
    });
    expect(edges).toEqual([
      'use.m use -calls-> Poly::value @ @Poly/value.m',
      'use.m use -instantiates-> Poly @ @Poly/Poly.m',
      'use.m use -instantiates-> Poly @ @Poly/Poly.m',
      'use.m use -references-> Poly::Poly @ @Poly/Poly.m',
    ]);
    expect(members).toEqual([
      'Poly > Poly::Poly @ @Poly/Poly.m',
      'Poly > Poly::value @ @Poly/value.m',
    ]);
    expect(unresolved).toEqual(['use.m:6 TPS']);
  });
});

describe('MATLAB methods on a variable', () => {
  it('links `v.m()` to the method of the class every other definer inherits from, and to the class `v = Cls;` names — never a method found by its name alone', async () => {
    const method = (name: string) => `        function y = ${name}(obj, x)\n            y = x;\n        end\n`;
    const cls = (name: string, base: string, ...methods: string[]) =>
      `classdef ${name} < ${base}\n    methods\n${methods.map(method).join('')}    end\nend\n`;
    const { edges, unresolved } = await indexOfProject({
      'PROBLEM.m': cls('PROBLEM', 'handle', 'CalObj'),
      'ZDT1.m': cls('ZDT1', 'PROBLEM', 'CalObj'),
      'ZDT2.m': cls('ZDT2', 'ZDT1', 'CalObj'),
      // Two unrelated classes define Evaluate, and two getData.
      'Alg.m': cls('Alg', 'handle', 'Evaluate'),
      'Other.m': cls('Other', 'handle', 'Evaluate'),
      'Archive.m': cls('Archive', 'handle', 'getData'),
      'Archive2.m': cls('Archive2', 'handle', 'getData'),
      // The one class with a `simplify` method.
      'Expr.m': cls('Expr', 'handle', 'simplify'),
      'run_alg.m': [
        'function run_alg(Problem, A, e)',
        'y = Problem.CalObj(1);', // PROBLEM or a subclass: PROBLEM's
        'z = A.Evaluate(1);', // Alg's or Other's: none
        'aa = Archive;', // the constructor, without parentheses
        'd = aa.getData(2);',
        's = simplify(e);', // function syntax on a parameter: the toolbox's as likely as Expr's
        'end',
        '',
      ].join('\n'),
    });
    expect(edges).toEqual([
      'ZDT1.m ZDT1 -extends-> PROBLEM @ PROBLEM.m',
      'ZDT2.m ZDT2 -extends-> ZDT1 @ ZDT1.m',
      'run_alg.m run_alg -calls-> Archive::getData @ Archive.m',
      'run_alg.m run_alg -calls-> PROBLEM::CalObj @ PROBLEM.m',
      'run_alg.m run_alg -instantiates-> Archive @ Archive.m',
    ]);
    expect(unresolved).toEqual(['run_alg.m:3 A.Evaluate', 'run_alg.m:6 simplify']);
  });
});

describe('MATLAB names matched with their case', () => {
  it('links no call when a file of the name in another case is nearer than the nearest exact match', async () => {
    const cls = (name: string) => `classdef ${name} < handle\n    methods\n        function obj = ${name}(x)\n        end\n    end\nend\n`;
    const { edges } = await indexOfProject({
      // `TPS.m` in `@tps` is a method of `tps`; the class `TPS` is another toolbox's.
      'peace/@tps/TPS.m': 'function t = TPS(x)\nt = x;\nend\n',
      'peace/use.m': 'function use()\nt = TPS(1);\nend\n',
      'portmann/@TPS/TPS.m': cls('TPS'),
      'portmann/near.m': 'function near()\nt = TPS(1);\nend\n',
      // `FindCells.m` beside the caller; `findcells.m` in another copy.
      'at1/FindCells.m': 'function i = FindCells(r)\ni = r;\nend\n',
      'at1/ring.m': 'function ring(r)\ni = findcells(r);\nend\n',
      'at2/findcells.m': 'function i = findcells(r)\ni = r;\nend\n',
      // Exact nearer than the other case: linked.
      'at2/sub/lat.m': 'function lat(r)\ni = findcells(r);\nend\n',
      'at2/lat2.m': 'function lat2(r)\ni = findcells(r);\nend\n',
      // A script in another case beside the caller.
      'p/Setup.m': 'x = 1;\n',
      'p/go.m': 'function go()\nsetup\nend\n',
      'q/setup.m': 'y = 2;\n',
      'q/go2.m': 'function go2()\nsetup\nend\n',
      // The help text of a MEX function beside the caller's folder.
      'at0/RingPass.m': '% RINGPASS is a mex function built from RingPass.c\n',
      'at0/sub/track.m': 'function track(r)\nringpass(r);\nend\n',
      'at3/ringpass.m': 'function ringpass(r)\nend\n',
      // A method of `tps` calling `tps`: its folder's constructor-shaped file is `TPS.m`.
      'peace/@tps/vps.m': 'function v = vps(t)\nv = tps(1);\nend\n',
      'far/@tps/tps.m': "function t = tps(x)\nt = class(struct('x', x), 'tps');\nend\n",
    });
    expect(edges).toEqual([
      'at2/lat2.m lat2 -calls-> findcells @ at2/findcells.m',
      'at2/sub/lat.m lat -calls-> findcells @ at2/findcells.m',
      'portmann/near.m near -instantiates-> TPS @ portmann/@TPS/TPS.m',
      'q/go2.m go2 -calls-> q/setup.m @ q/setup.m',
    ]);
  });
});

describe('MATLAB methods on a variable, with copies of the classes', () => {
  const method = (name: string) => `        function y = ${name}(obj, x)\n            y = x;\n        end\n`;
  const cls = (name: string, base: string, ...methods: string[]) =>
    `classdef ${name} < ${base}\n    methods\n${methods.map(method).join('')}    end\nend\n`;

  it('takes the copy of the hierarchy nearest the caller, the nearest copy of a lone class, and nothing under multiple inheritance', async () => {
    const { edges } = await indexOfProject({
      'F1/Z.m': cls('Z', 'handle', 'zz'),
      'F1/Z1.m': cls('Z1', 'Z', 'zz'),
      'F1/user1.m': 'function user1(f)\nf.zz(1);\nend\n',
      'F2/Z.m': cls('Z', 'handle', 'zz'),
      'F2/Z1.m': cls('Z1', 'Z', 'zz'),
      'F2/user2.m': 'function user2(f)\nf.zz(1);\nend\n',
      // A lone class in two copies.
      'D/R.m': cls('R', 'handle', 'tick'),
      'E/R.m': cls('R', 'handle', 'tick'),
      'E/user3.m': 'function user3(b)\nb.tick(1);\nend\n',
      // Multiple inheritance: no class every other one inherits from.
      'C/P.m': cls('P', 'handle', 'go'),
      'C/Q.m': cls('Q', 'handle', 'go'),
      'C/M.m': cls('M', 'P & Q', 'go'),
      'C/user4.m': 'function user4(c)\nc.go(1);\nend\n',
    });
    expect(edges.filter((e) => !e.includes('-extends->'))).toEqual([
      'E/user3.m user3 -calls-> R::tick @ E/R.m',
      'F1/user1.m user1 -calls-> Z::zz @ F1/Z.m',
      'F2/user2.m user2 -calls-> Z::zz @ F2/Z.m',
    ]);
  });

  it('links an abstract root\'s declaration', async () => {
    const { edges } = await indexOfProject({
      'Base.m': 'classdef (Abstract) Base < handle\n    methods (Abstract)\n        y = calc(obj, x)\n    end\nend\n',
      'S1.m': cls('S1', 'Base', 'calc'),
      'S2.m': cls('S2', 'Base', 'calc'),
      'user.m': 'function user(b)\ny = b.calc(1);\nend\n',
    });
    expect(edges.filter((e) => !e.includes('-extends->'))).toEqual(['user.m user -calls-> Base::calc @ Base.m']);
  });

  it('reads `v = Name;` as a function\'s call when `Name` is a function of the project\'s: `v.m()` is then a call on a variable of no stated class', async () => {
    const { edges, unresolved } = await indexOfProject({
      'GetCfg.m': 'function c = GetCfg()\nc = Thing();\nend\n',
      'Thing.m': cls('Thing', 'handle', 'run'),
      'Archive.m': cls('Archive', 'handle', 'getData'),
      'Archive2.m': cls('Archive2', 'handle', 'getData'),
      'user.m': [
        'function user()',
        'G = GetCfg;', // a function: G holds what it returns
        'G.run(1);',
        'aa = Archive;', // a class: its constructor
        'aa.getData(2);',
        'H = Unknown;', // nothing of the project's: a class of a toolbox
        'H.run(3);',
        'G2 = GetCfg;',
        'G2.getData(4);', // two classes define it: none
        'end',
        '',
      ].join('\n'),
    });
    expect(edges).toEqual([
      'GetCfg.m GetCfg -instantiates-> Thing @ Thing.m',
      'user.m user -calls-> Archive::getData @ Archive.m',
      'user.m user -calls-> GetCfg @ GetCfg.m',
      'user.m user -calls-> GetCfg @ GetCfg.m',
      'user.m user -calls-> Thing::run @ Thing.m',
      'user.m user -instantiates-> Archive @ Archive.m',
    ]);
    expect(unresolved).toEqual(['user.m:7 Unknown::run', 'user.m:9 GetCfg::getData']);
  });
});

describe('MATLAB sync converges on a fresh index', () => {
  /** Index `initial`, apply each step with a sync, and return the synced edges and a fresh index's of the final files. */
  async function syncedAndFresh(initial: Record<string, string>, ...steps: Array<Record<string, string | null>>): Promise<{ steps: string[][]; synced: string[]; fresh: string[] }> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-sync-')));
    const freshRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-fresh-')));
    const final: Record<string, string | null> = { ...initial };
    writeFiles(root, initial);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const seen: string[][] = [edgesOf(cg).edges];
      for (const step of steps) {
        writeFiles(root, step);
        Object.assign(final, step);
        await cg.sync();
        seen.push(edgesOf(cg).edges);
      }
      writeFiles(freshRoot, Object.fromEntries(Object.entries(final).filter(([, c]) => c !== null)));
      const fresh = await CodeGraph.init(freshRoot, { index: true });
      try {
        return { steps: seen, synced: seen[seen.length - 1]!, fresh: edgesOf(fresh).edges };
      } finally {
        fresh.close();
      }
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  }

  const MAIN = 'function main()\nsetup_paths\nend\n';
  const SCRIPT_CALL = 'main.m main -calls-> setup_paths.m @ setup_paths.m';
  const FUNCTION_CALL = 'main.m main -calls-> setup_paths @ setup_paths.m';

  it('when a script becomes a function, and back', async () => {
    const { steps, synced, fresh } = await syncedAndFresh(
      { 'main.m': MAIN, 'setup_paths.m': 'addpath(pwd);\n' },
      { 'setup_paths.m': 'function setup_paths()\naddpath(pwd);\nend\n' },
      { 'setup_paths.m': 'addpath(pwd);\n' },
    );
    expect(steps).toEqual([[SCRIPT_CALL], [FUNCTION_CALL], [SCRIPT_CALL]]);
    expect(synced).toEqual(fresh);
  });

  it('when a script becomes help text only, or Octave, and back', async () => {
    const { steps, synced, fresh } = await syncedAndFresh(
      { 'main.m': MAIN, 'setup_paths.m': 'addpath(pwd);\n' },
      { 'setup_paths.m': '% SETUP_PATHS  help for a MEX function\n' },
      { 'setup_paths.m': 'addpath(pwd);\n' },
      { 'setup_paths.m': '# Octave\naddpath(pwd);\n' },
      { 'setup_paths.m': 'addpath(pwd);\n' },
    );
    expect(steps).toEqual([[SCRIPT_CALL], [], [SCRIPT_CALL], [], [SCRIPT_CALL]]);
    expect(synced).toEqual(fresh);
  });

  it('when the target of a call is deleted and added back: a function, a script, a class\'s method', async () => {
    const helper = 'function helper()\nend\n';
    const tool = 'disp(1);\n';
    const account = 'classdef Account < handle\n    methods\n        function deposit(obj, x)\n        end\n    end\nend\n';
    const initial = {
      'main.m': 'function main(a)\nhelper\nhelper(1);\ntool\na.deposit(2);\nend\n',
      'helper.m': helper,
      'tool.m': tool,
      'Account.m': account,
    };
    const linked = [
      'main.m main -calls-> Account::deposit @ Account.m',
      'main.m main -calls-> helper @ helper.m',
      'main.m main -calls-> helper @ helper.m',
      'main.m main -calls-> tool.m @ tool.m',
    ];
    const { steps, synced, fresh } = await syncedAndFresh(
      initial,
      { 'helper.m': null, 'tool.m': null, 'Account.m': null },
      { 'helper.m': helper, 'tool.m': tool, 'Account.m': account },
    );
    expect(steps).toEqual([linked, [], linked]);
    expect(synced).toEqual(fresh);
  });

  it('when the class a method is inherited from moves, goes and comes back', async () => {
    const base = 'classdef Base < handle\n    methods\n        function greet(obj)\n        end\n    end\nend\n';
    const inherited = 'main.m main -calls-> Base::greet @ Base.m';
    const { steps, synced, fresh } = await syncedAndFresh(
      {
        'main.m': 'function main()\ns = Sub();\ns.greet();\nend\n',
        'Sub.m': 'classdef Sub < Base\nend\n',
        'Base.m': base,
      },
      { 'Base.m': `% moved down\n\n${base}` },
      { 'Base.m': null },
      { 'Base.m': base },
      { 'Sub.m': '% moved down\nclassdef Sub < Base\nend\n' },
    );
    const made = 'main.m main -instantiates-> Sub @ Sub.m';
    const extendsEdge = 'Sub.m Sub -extends-> Base @ Base.m';
    expect(steps).toEqual([
      [extendsEdge, inherited, made],
      [extendsEdge, inherited, made],
      [made],
      [extendsEdge, inherited, made],
      [extendsEdge, inherited, made],
    ]);
    expect(synced).toEqual(fresh);
  });

  it('when the middle class of three moves folders in the sync that edits the caller, and moves back', async () => {
    const mid = 'classdef Mid < Base\nend\n';
    const { steps, synced, fresh } = await syncedAndFresh(
      {
        'main.m': 'function main()\ns = Sub();\ns.greet();\nend\n',
        'a/Sub.m': 'classdef Sub < Mid\nend\n',
        'm/Mid.m': mid,
        'b/Base.m': 'classdef Base < handle\n    methods\n        function greet(obj)\n        end\n    end\nend\n',
      },
      { 'm/Mid.m': null, 'n/Mid.m': mid, 'main.m': 'function main()\n\ns = Sub();\ns.greet();\nend\n' },
      { 'n/Mid.m': null, 'm/Mid.m': mid },
    );
    const at = (dir: string) => [
      `a/Sub.m Sub -extends-> Mid @ ${dir}/Mid.m`,
      'main.m main -calls-> Base::greet @ b/Base.m',
      'main.m main -instantiates-> Sub @ a/Sub.m',
      `${dir}/Mid.m Mid -extends-> Base @ b/Base.m`,
    ].sort();
    expect(steps).toEqual([at('m'), at('n'), at('m')]);
    expect(synced).toEqual(fresh);
  });

  it('when a nearer copy of the superclass is added in the sync that edits the caller, and removed', async () => {
    const base = 'classdef Base < handle\n    methods\n        function greet(obj)\n        end\n    end\nend\n';
    const { steps, synced, fresh } = await syncedAndFresh(
      {
        'main.m': 'function main()\ns = Sub();\ns.greet();\nend\n',
        'a/Sub.m': 'classdef Sub < Base\nend\n',
        'b/Base.m': base,
      },
      { 'a/Base.m': base, 'main.m': 'function main()\n\ns = Sub();\ns.greet();\nend\n' },
      { 'a/Base.m': null, 'main.m': 'function main()\ns = Sub();\ns.greet();\nend\n' },
    );
    const via = (dir: string) => [
      `a/Sub.m Sub -extends-> Base @ ${dir}/Base.m`,
      `main.m main -calls-> Base::greet @ ${dir}/Base.m`,
      'main.m main -instantiates-> Sub @ a/Sub.m',
    ];
    expect(steps).toEqual([via('b'), via('a'), via('b')]);
    expect(synced).toEqual(fresh);
  });
});

describe('MATLAB sync converges on a fresh index when a superclass list changes', () => {
  /** Index `initial`, apply each step with a sync, and return each step's synced edges with a fresh index's of the same files. */
  async function eachStep(initial: Record<string, string>, ...steps: Array<Record<string, string | null>>): Promise<Array<{ synced: string[]; fresh: string[] }>> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-supers-')));
    const files: Record<string, string | null> = { ...initial };
    writeFiles(root, initial);
    const cg = await CodeGraph.init(root, { index: true });
    const out: Array<{ synced: string[]; fresh: string[] }> = [];
    try {
      for (const step of steps) {
        writeFiles(root, step);
        Object.assign(files, step);
        await cg.sync();
        const freshRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-supers-fresh-')));
        writeFiles(freshRoot, Object.fromEntries(Object.entries(files).filter(([, c]) => c !== null)));
        const fresh = await CodeGraph.init(freshRoot, { index: true });
        try {
          out.push({ synced: edgesOf(cg).edges, fresh: edgesOf(fresh).edges });
        } finally {
          fresh.close();
          fs.rmSync(freshRoot, { recursive: true, force: true });
        }
      }
      return out;
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('drops the call through a superclass the middle class no longer extends, and links it again when it does', async () => {
    const base = 'classdef Base < handle\n    methods\n        function greet(obj)\n        end\n    end\nend\n';
    const steps = await eachStep(
      {
        'main.m': 'function main()\ns = Sub();\ns.greet();\nend\n',
        'a/Sub.m': 'classdef Sub < Mid\nend\n',
        'n/Mid.m': 'classdef Mid < pkg.Base\nend\n',
        '+pkg/Base.m': base,
      },
      { 'n/Mid.m': 'classdef Mid < handle\nend\n' },
      { 'n/Mid.m': 'classdef Mid < pkg.Base\nend\n' },
    );
    const sub = ['a/Sub.m Sub -extends-> Mid @ n/Mid.m', 'main.m main -instantiates-> Sub @ a/Sub.m'];
    expect(steps.map((s) => s.synced)).toEqual([
      sub,
      [sub[0]!, 'main.m main -calls-> pkg::Base::greet @ +pkg/Base.m', sub[1]!, 'n/Mid.m Mid -extends-> pkg::Base @ +pkg/Base.m'],
    ]);
    for (const { synced, fresh } of steps) expect(synced).toEqual(fresh);
  });

  it('for a dispatched call, a member call and a call on a variable, when a class is added, its superclass dropped and taken back, and it is removed', async () => {
    const mid = (base: string) => `classdef Mid < ${base}\n    methods\n        function wave(obj)\n        end\n    end\nend\n`;
    const steps = await eachStep(
      {
        // `v.wave()`: Base's, as long as Mid (which overrides it) inherits from Base.
        'main.m': 'function main(v)\ns = Sub2();\ns.greet();\ngreet(s);\nv.wave();\nend\n',
        'Base.m': 'classdef Base < handle\n    methods\n        function greet(obj)\n        end\n        function wave(obj)\n        end\n    end\nend\n',
        'Mid.m': mid('Base'),
      },
      { 'Sub2.m': 'classdef Sub2 < Mid\nend\n' },
      { 'Mid.m': mid('handle') },
      { 'Mid.m': mid('Base') },
      { 'Sub2.m': null },
      { 'Sub2.m': 'classdef Sub2 < Mid\nend\n', 'Mid.m': null },
      { 'Mid.m': mid('Base') },
    );
    const greet = ['main.m main -calls-> Base::greet @ Base.m', 'main.m main -calls-> Base::greet @ Base.m'];
    const all = ['Mid.m Mid -extends-> Base @ Base.m', 'Sub2.m Sub2 -extends-> Mid @ Mid.m', ...greet,
      'main.m main -calls-> Base::wave @ Base.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'];
    expect(steps.map((s) => s.synced)).toEqual([
      all,
      ['Sub2.m Sub2 -extends-> Mid @ Mid.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'],
      all,
      ['Mid.m Mid -extends-> Base @ Base.m', 'main.m main -calls-> Base::wave @ Base.m'],
      ['main.m main -calls-> Base::wave @ Base.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'],
      all,
    ]);
    for (const { synced, fresh } of steps) expect(synced).toEqual(fresh);
  });
});

describe('MATLAB recovery from an interrupted index', () => {
  it('leaves the unresolved rows a fresh index leaves', async () => {
    const files = {
      'main.m': 'function main(a)\nt = cfg;\nplot(t);\nmissing_fn(1);\na.field(2);\nhelper(t);\nend\n',
      'helper.m': 'function helper(x)\nnope_read;\nend\n',
    };
    const rows = (dir: string): string[] => {
      const db = DatabaseConnection.open(getDatabasePath(dir));
      try {
        return (db.getDb().prepare('SELECT file_path AS f, line, reference_name AS n, status AS s FROM unresolved_refs').all() as Array<{ f: string; line: number; n: string; s: string }>)
          .map((r) => `${r.f}:${r.line} ${r.n} ${r.s}`).sort();
      } finally {
        db.close();
      }
    };
    const freshRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-recover-fresh-')));
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-recover-')));
    try {
      writeFiles(freshRoot, files);
      (await CodeGraph.init(freshRoot, { index: true })).close();
      const fresh = rows(freshRoot);
      // A call written with arguments that resolves to nothing stays; the bare reads nothing defines go.
      expect(fresh).toEqual(['main.m:4 missing_fn failed']);

      writeFiles(root, files);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        // Interrupted after extraction: the files' references are back, pending, and never attempted.
        for (const f of Object.keys(files)) fs.appendFileSync(path.join(root, f), '% interrupted-run edit\n');
        await cg.indexFiles(Object.keys(files));
        expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);
        const recovered = await cg.sync();
        expect(recovered.filesAdded + recovered.filesModified + recovered.filesRemoved).toBe(0);
        expect(cg.getPendingReferenceCount()).toBe(0);
      } finally {
        cg.close();
      }
      expect(rows(root)).toEqual(fresh);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

describe('MATLAB sync in a project with Objective-C', () => {
  it('settles script verdicts for the MATLAB files a sync changes, never for an Objective-C `.m`', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-objc-sync-')));
    writeFiles(root, {
      'main.m': 'function main()\nsetup_paths\nend\n',
      'setup_paths.m': 'addpath(pwd);\n',
      'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n}\n@end\n',
      'objc/Thing.h': '#import <Foundation/Foundation.h>\n@interface Thing : NSObject\n- (void)go;\n@end\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const resolver = (cg as unknown as { resolver: { reopenMatlabScriptRuns: (...a: unknown[]) => number } }).resolver;
      const calls: unknown[][] = [];
      const reopen = resolver.reopenMatlabScriptRuns.bind(resolver);
      resolver.reopenMatlabScriptRuns = (...a: unknown[]) => {
        calls.push(a);
        return reopen(...a);
      };
      writeFiles(root, { 'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n    [self stop];\n}\n- (void)stop {\n}\n@end\n' });
      await cg.sync();
      expect(calls).toEqual([]);
      writeFiles(root, { 'setup_paths.m': 'addpath(pwd);\ndisp(1);\n', 'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n@end\n' });
      await cg.sync();
      expect(calls.map(([matlabFiles, changed]) => [matlabFiles, [...(changed as string[])].sort()])).toEqual([
        [['setup_paths.m'], ['objc/Thing.m', 'setup_paths.m']],
      ]);
      expect(edgesOf(cg).edges.filter((e) => e.startsWith('main.m '))).toEqual(['main.m main -calls-> setup_paths.m @ setup_paths.m']);
      // The script re-read as Objective-C: the MATLAB call into it still has
      // to go, though the file is no MATLAB file any more.
      calls.length = 0;
      writeFiles(root, { 'setup_paths.m': '#import <Foundation/Foundation.h>\n@implementation Setup\n- (void)go {\n}\n@end\n' });
      await cg.sync();
      expect(cg.getFiles().find((f) => f.path === 'setup_paths.m')?.language).toBe('objc');
      expect(edgesOf(cg).edges.filter((e) => e.startsWith('main.m '))).toEqual([]);
      expect(calls).toEqual([[['setup_paths.m'], ['setup_paths.m']]]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
