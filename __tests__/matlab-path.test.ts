/**
 * The MATLAB search path a project's startup code sets (codegraph.json's
 * `matlab.startup`, or a root `startup.m`): the evaluator that runs it, the
 * resolution that follows it, a sync that keeps it, and what `codegraph
 * status`, codegraph_explore and codegraph_node say of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { getParser } from '../src/extraction/grammars';
import { clearProjectConfigCache, loadMatlabConfig } from '../src/project-config';
import { defaultLogger, setLogger, type Logger } from '../src/errors';
import { evaluateMatlabPath, type MatlabPathSettings } from '../src/resolution/matlab-path-eval';
import { matlabPathEvaluations } from '../src/resolution/matlab-path-record';
import { MatlabPathRecorder, MatlabProjectView } from '../src/resolution/matlab-path-access';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { allEdges, edgesFrom, tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  clearProjectConfigCache();
});

function project(files: Record<string, string>): string {
  const root = tempDir('cg-matlab-path-');
  roots.push(root);
  writeTree(root, files);
  clearProjectConfigCache();
  return root;
}

function config(matlab: unknown): string {
  return JSON.stringify({ matlab });
}

/** Runs `code` over an in-memory project (`files`, project-relative) rooted at /proj. */
function evaluate(files: Record<string, string>, code: string, settings: Partial<MatlabPathSettings> = {}, root = '/proj') {
  const parser = getParser('matlab')!;
  const access = new MatlabPathRecorder(new MatlabProjectView(Object.keys(files), (rel) => files[rel] ?? null));
  return evaluateMatlabPath(
    { root, access, parse: (s) => parser.parse(s) },
    { code, cwd: '', env: {}, computer: 'GLNXA64', release: 'R2024b', ...settings },
  );
}

// ---------------------------------------------------------------------------
// 1. The evaluator, on MML in miniature
// ---------------------------------------------------------------------------

const MINI_MML: Record<string, string> = {
  'mml/setpathx.m': "function setpathx(varargin)\nLinkFlag = 'LabCA';\nsetpathcore('X', 'Ring', 'Ring', LinkFlag);\nend\n",
  // MML's getmmlroot: the folder above this file's, cut at the second-to-last separator.
  'mml/getroot.m': [
    'function ROOT = getroot()',
    "[ROOT, FileName, Ext] = fileparts(mfilename('fullpath'));",
    'ROOT = [ROOT, filesep];',
    'i = findstr(ROOT, filesep);',
    'if length(i) >= 2',
    '    ROOT = ROOT(1:i(end-1));',
    'end',
    '',
  ].join('\n'),
  'mml/setpathcore.m': [
    'function setpathcore(Machine, Sub, Type, LinkFlag)',
    'ROOT = getroot;',
    'switch upper(LinkFlag)',
    "    case 'MCA'",
    "        addpath(fullfile(ROOT, 'online', 'mca'), '-begin');",
    "    case {'LABCA', 'LABCA2'}",
    "        addpath(fullfile(ROOT, 'online', 'labca'), '-begin');",
    '    otherwise',
    "        addpath(fullfile(ROOT, 'online', 'sca'), '-begin');",
    'end',
    'switch computer',
    "    case 'PCWIN64'",
    "        addpath(fullfile(ROOT, 'online', 'win'), '-begin');",
    "    case 'GLNXA64'",
    "        addpath(fullfile(ROOT, 'online', 'linux'), '-begin');",
    'end',
    "d = fullfile(ROOT, 'apps', 'naff');",
    "if exist(d, 'dir')",
    "    addpath(d, '-begin');",
    'end',
    "d = fullfile(ROOT, 'apps', 'missing');",
    "if exist(d, 'dir')",
    "    addpath(d, '-begin');",
    'end',
    'if hardware_present()',
    "    addpath(fullfile(ROOT, 'apps', 'maybe'), '-end');",
    'end',
    'setpathsim;',
    "addpath(fullfile(ROOT, 'mml'), '-begin');",
    "addpath(fullfile(ROOT, 'machine', Machine, Sub), '-begin');",
    'aoinit(Sub);',
    '',
  ].join('\n'),
  // MML's setpathat: finds the simulators beside the folder `getpv` is in.
  'mml/setpathsim.m': [
    'function setpathsim',
    "[d, f, e] = fileparts(which('getpv'));",
    'i = findstr(d, filesep);',
    "simroot = [d(1:i(end)), 'sims', filesep];",
    "if verLessThan('matlab', '9.9')",
    "    simdir = [simroot, 'sim1'];",
    'else',
    "    simdir = [simroot, 'sim2'];",
    'end',
    'olddir = pwd;',
    'cd(simdir);',
    'atpath;',
    'cd(olddir);',
    '',
  ].join('\n'),
  'mml/getpv.m': 'function v = getpv(x)\nv = x;\n',
  // Two copies: the folder the code cds to decides which runs.
  'sims/sim1/atpath.m': "function atpath\naddpath(genpath(fileparts(mfilename('fullpath'))));\n",
  'sims/sim2/atpath.m': "function atpath\nROOT = fileparts(mfilename('fullpath'));\naddpath(genpath(ROOT));\n",
  'sims/sim2/core/track.m': 'function track\n',
  'sims/sim2/Alpha/a.m': 'function a\n',
  'sims/sim2/zeta/z.m': 'function z\n',
  'sims/sim2/@Elem/Elem.m': 'classdef Elem\nend\n',
  'sims/sim2/+pkg/f.m': 'function f\n',
  'sims/sim2/private/p.m': 'function p\n',
  'sims/sim2/resources/r.m': 'function r\n',
  'online/mca/x.m': 'function x\n',
  'online/labca/x.m': 'function x\n',
  'online/sca/x.m': 'function x\n',
  'online/win/x.m': 'function x\n',
  'online/linux/x.m': 'function x\n',
  'apps/naff/x.m': 'function x\n',
  'apps/maybe/x.m': 'function x\n',
  // Not path-affecting: called for no value, it is not followed.
  'machine/X/Ring/aoinit.m': "function aoinit(s)\nerror('not followed');\n",
};

const MINI_PATH = [
  'machine/X/Ring',
  'mml',
  'sims/sim2',
  'sims/sim2/Alpha',
  'sims/sim2/core',
  'sims/sim2/zeta',
  'apps/naff',
  'online/linux',
  'online/labca',
  'apps/maybe',
];

describe('MATLAB path: the evaluator on MML in miniature', () => {
  it('runs setpathx → setpathcore → getroot / setpathsim → atpath to the exact path, current folder and notes', async () => {
    const root = project({ ...MINI_MML, 'codegraph.json': config({ startup: "setpathx('StorageRing')" }) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const record = cg.getMatlabPathRecord()!;
      expect(record.source).toBe('codegraph.json');
      expect(record.folders).toEqual(MINI_PATH);
      // The default current folder: the one file defining setpathx is in mml/; setpathsim cds back.
      expect(record.cwd).toBe('mml');
      expect(record.notes).toEqual(['mml/setpathcore.m:25: a condition is not known: every branch it may take is run']);
      // What a sync asks again: the files read, the folders genpath listed, the names and folders asked about.
      expect(Object.keys(record.answers!)).toEqual(expect.arrayContaining([
        'f:mml/setpathx.m', 'f:mml/setpathcore.m', 'f:mml/getroot.m', 'f:mml/setpathsim.m', 'f:sims/sim2/atpath.m',
        'l:sims/sim2', 'l:sims/sim2/core', 'n:getpv', 'n:atpath', 'n:setpathcore', 'n:hardware_present',
        'd:apps/naff', 'd:apps/missing', 'd:sims/sim2', 'd:mml',
      ]));
      expect(record.answers!['d:apps/missing']).toBe('0');
      expect(record.answers!['n:hardware_present']).toBe('');
    } finally {
      cg.close();
    }
  });

  it('an older release takes the other branch, and so the other atpath', async () => {
    const root = project({ ...MINI_MML, 'codegraph.json': config({ startup: "setpathx('StorageRing')", release: 'R2019b', computer: 'PCWIN64' }) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(cg.getMatlabPathRecord()!.folders).toEqual(['machine/X/Ring', 'mml', 'sims/sim1', 'apps/naff', 'online/win', 'online/labca', 'apps/maybe']);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Built-ins
// ---------------------------------------------------------------------------

describe('MATLAB path: built-ins', () => {
  const FOLDERS = { 'a/x.m': '', 'b/x.m': '', 'c/x.m': '', 'd/x.m': '', 'a/b/y.m': '' };

  it('addpath puts folders first by default, last with -end, and splits a pathsep-joined text', () => {
    expect(evaluate(FOLDERS, "addpath('a'); addpath('b', '-end'); addpath(['c', pathsep, 'd'])").folders).toEqual(['c', 'd', 'a', 'b']);
    expect(evaluate(FOLDERS, "addpath('a', 'b', '-begin')").folders).toEqual(['a', 'b']);
  });

  it('a folder already on the path moves; ./ .. and a trailing separator are read away', () => {
    expect(evaluate(FOLDERS, "addpath('a'); addpath('b'); addpath('a/./b/../')").folders).toEqual(['a', 'b']);
  });

  it('rmpath takes a folder off', () => {
    expect(evaluate(FOLDERS, "addpath('a', 'b'); rmpath('a')").folders).toEqual(['b']);
  });

  it('path(p1, p2) sets the path; p = path reads it', () => {
    expect(evaluate(FOLDERS, "addpath('c'); p = path; path(p, fullfile(pwd, 'd'))").folders).toEqual(['c', 'd']);
  });

  it('genpath leaves out class, package, private and resources folders, and walks in ASCII order', () => {
    const files = { 'lib/t.m': '', 'lib/sub/s.m': '', 'lib/Zed/z.m': '', 'lib/@C/C.m': '', 'lib/+p/f.m': '', 'lib/private/q.m': '', 'lib/resources/r.m': '', 'lib/sub/deep/d.m': '' };
    expect(evaluate(files, "addpath(genpath('lib'))").folders).toEqual(['lib', 'lib/Zed', 'lib/sub', 'lib/sub/deep']);
  });

  it('a folder outside the project, or with no indexed file, is passed over with a note', () => {
    const r = evaluate(FOLDERS, "addpath('/elsewhere/tools'); addpath('nope'); addpath('a')");
    expect(r.folders).toEqual(['a']);
    expect(r.notes).toEqual([
      'startup:1: addpath /elsewhere/tools: outside the project, passed over',
      'startup:1: addpath nope: no indexed file there, passed over',
    ]);
  });

  it('cd .. moves up, and pwd follows', () => {
    const r = evaluate(FOLDERS, 'cd ..\naddpath(pwd)', { cwd: 'a/b' });
    expect(r.folders).toEqual(['a']);
    expect(r.cwd).toBe('a');
  });

  it('a project function that is not path-affecting is not run for its effects; one whose value is used gives it', () => {
    const files = {
      ...FOLDERS,
      'name.m': "function n = name()\nn = 'b';\n",
      'setup_x.m': "x = 'a';\n",
      'loop.m': 'function n = loop()\nwhile true\n  n = 1;\n  n = 2;\n  n = 3;\nend\n',
    };
    const r = evaluate(files, "setup_x;\naddpath(name());\nv = loop();\nif v, addpath('c'); end");
    expect(r.folders).toEqual(['c', 'b']);
    expect(r.notes).toEqual([
      'startup:3: loop was followed for its value and took too long: its value is not known',
      'startup:4: a condition is not known: every branch it may take is run',
    ]);
  });

  it('the call depth cap leaves the deep call unknown and goes on', () => {
    const files = { ...FOLDERS, 'deep.m': "function deep(n)\naddpath('a');\ndeep(n + 1);\n" };
    const r = evaluate(files, "deep(1);\naddpath('b');", { maxDepth: 4 });
    expect(r.folders).toEqual(['b', 'a']);
    expect(r.notes).toEqual(['deep.m:3: the call depth cap (4) was reached calling deep.m: not followed, its values not known']);
  });

  it('the statement budget stops the evaluation and keeps the path so far', () => {
    const r = evaluate(FOLDERS, "addpath('a');\nk = 0;\nwhile true\n  k = k + 1;\nend\naddpath('b');", { maxSteps: 500 });
    expect(r.folders).toEqual(['a']);
    expect(r.notes).toEqual(['the statement budget (500) was reached: evaluation stopped, the path so far kept']);
  });

  it('an error in a try goes to its catch; one outside stops with the path so far', () => {
    expect(evaluate(FOLDERS, "try\n  cd('nope');\n  addpath('a');\ncatch\n  addpath('b');\nend").folders).toEqual(['b']);
    const r = evaluate(FOLDERS, "addpath('a');\nerror('stop here');\naddpath('b');");
    expect(r.folders).toEqual(['a']);
    expect(r.notes).toEqual(['the startup code stopped on an error at startup:2: stop here']);
  });

  it('getenv, computer, version and the release tests read the settings', () => {
    const code = [
      "if strcmp(getenv('SITE'), 'als'), addpath('a'); end",
      "if ispc, addpath('b'); end",
      "if verLessThan('matlab', '9.0'), addpath('c'); end",
      "if datenum(version('-date')) > datenum('01-Oct-2020'), addpath('d'); end",
      "if isMATLABReleaseOlderThan('R2020a'), addpath('a/b'); end",
    ].join('\n');
    expect(evaluate(FOLDERS, code, { env: { SITE: 'als' } }).folders).toEqual(['d', 'a']);
    expect(evaluate(FOLDERS, code, { computer: 'PCWIN64', release: 'R2015b' }).folders).toEqual(['a/b', 'c', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 3. Resolution with the path
// ---------------------------------------------------------------------------

describe('MATLAB path: resolution', () => {
  const FILES: Record<string, string> = {
    'codegraph.json': config({ startup: "addpath('lib2');\naddpath('lib1');" }),
    'lib1/util.m': 'function util(x)\nend\n',
    'lib2/util.m': 'function util(x)\nend\n',
    'old/onlyoff.m': 'function onlyoff(x)\nend\n',
    'lib2/caller.m': [
      'function caller()',
      'util(1);',
      'onlyoff(1);',
      'h = @util;',
      's = Shape(1);',
      's.area();',
      'r = Robot();',
      'setup_x',
      'p(1);',
      'end',
      '',
    ].join('\n'),
    'app/main.m': 'function main()\nutil(1);\nhelper(1);\nonlyoff(1);\ntool(1);\nend\n',
    // A case variant nearer the caller than the path's copy, off the path: it vetoes nothing.
    'lib1/tool.m': 'function tool(x)\nend\n',
    'app/sub/Tool.m': 'function Tool(x)\nend\n',
    'app/helper.m': 'function helper(x)\nend\n',
    'lib1/helper.m': 'function helper(x)\nend\n',
    'lib1/@Shape/Shape.m': 'classdef Shape\n    methods\n        function s = Shape(x)\n        end\n    end\nend\n',
    'lib1/@Shape/area.m': 'function a = area(s)\na = 1;\nend\n',
    'old/@Shape/Shape.m': 'classdef Shape\n    methods\n        function s = Shape(x)\n        end\n    end\nend\n',
    'old/@Shape/area.m': 'function a = area(s)\na = 2;\nend\n',
    'old/Robot.m': 'classdef Robot\nend\n',
    'lib2/Robot.m': 'classdef Robot\nend\n',
    'old/Base.m': 'classdef Base < handle\nend\n',
    'lib1/Base.m': 'classdef Base < handle\nend\n',
    'lib2/Arm.m': 'classdef Arm < Base\nend\n',
    'old/setup_x.m': 'disp(1);\n',
    'lib2/setup_x.m': 'disp(2);\n',
    'lib1/private/p.m': 'function p(x)\nend\n',
    'lib1/usep.m': 'function usep()\np(1);\nend\n',
  };

  it('an on-path caller takes the path\'s copy in path order, even with a nearer one, and nothing off the path', async () => {
    const root = project(FILES);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(cg.getMatlabPathRecord()!.folders).toEqual(['lib1', 'lib2']);
      expect(edgesFrom(cg, 'lib2/caller.m', 'caller')).toEqual([
        'caller -calls-> Shape::area @ lib1/@Shape/area.m',
        'caller -calls-> lib2/setup_x.m @ lib2/setup_x.m',
        'caller -calls-> util @ lib1/util.m',
        'caller -instantiates-> Robot @ lib2/Robot.m',
        'caller -instantiates-> Shape @ lib1/@Shape/Shape.m',
        'caller -references-> util @ lib1/util.m',
      ]);
      // onlyoff is only off the path; p is lib1's private function, and caller is in lib2.
      expect(unresolvedRows(root).filter((r) => r.startsWith('lib2/caller.m'))).toEqual(expect.arrayContaining([
        'lib2/caller.m:3 calls:onlyoff',
        'lib2/caller.m:9 calls:p',
      ]));
      // Superclass lookup sees the path too, and private/ stays its parent's.
      expect(edgesFrom(cg, 'lib2/Arm.m', 'Arm')).toEqual(['Arm -extends-> Base @ lib1/Base.m']);
      expect(edgesFrom(cg, 'lib1/usep.m', 'usep')).toEqual(['usep -calls-> p @ lib1/private/p.m']);
    } finally {
      cg.close();
    }
  });

  it('an off-path caller takes its own folder\'s copy, then the path\'s, then the nearest', async () => {
    const root = project(FILES);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'app/main.m', 'main')).toEqual([
        'main -calls-> helper @ app/helper.m',
        'main -calls-> onlyoff @ old/onlyoff.m',
        'main -calls-> tool @ lib1/tool.m',
        'main -calls-> util @ lib1/util.m',
      ]);
    } finally {
      cg.close();
    }
  });

  it('with no path, resolution is as before: nearest, then genpath order', async () => {
    const files = { ...FILES };
    delete files['codegraph.json'];
    const root = project(files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(cg.getMatlabPathRecord()?.source ?? null).toBeNull();
      expect(edgesFrom(cg, 'lib2/caller.m', 'caller')).toEqual(expect.arrayContaining([
        'caller -calls-> util @ lib2/util.m',
        'caller -calls-> onlyoff @ old/onlyoff.m',
      ]));
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Zero-config: a root startup.m
// ---------------------------------------------------------------------------

describe('MATLAB path: a root startup.m', () => {
  const FILES = {
    'alib/f.m': 'function f()\nend\n',
    'zlib/f.m': 'function f()\nend\n',
    'app/main.m': 'function main()\nf();\nend\n',
  };

  it('is the startup code when codegraph.json has none, and changes resolution', async () => {
    const root = project({ ...FILES, 'startup.m': "addpath(genpath('zlib'));\n" });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const record = cg.getMatlabPathRecord()!;
      expect(record.source).toBe('startup.m');
      expect(record.folders).toEqual(['zlib']);
      expect(record.cwd).toBe('');
      expect(edgesFrom(cg, 'app/main.m', 'main')).toEqual(['main -calls-> f @ zlib/f.m']);
    } finally {
      cg.close();
    }
  });

  it('without it, the edges are those of no path at all', async () => {
    const root = project(FILES);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(cg.getMatlabPathRecord()?.source ?? null).toBeNull();
      expect(edgesFrom(cg, 'app/main.m', 'main')).toEqual(['main -calls-> f @ alib/f.m']);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. A sync ends where a fresh index ends
// ---------------------------------------------------------------------------

describe('MATLAB path: sync converges on a fresh index', () => {
  /** Index `initial`, apply each step with a sync, and return the synced edges and rows and a fresh index's of the final files. */
  async function syncedAndFresh(initial: Record<string, string>, ...steps: Array<Record<string, string | null>>) {
    const root = project(initial);
    const freshRoot = tempDir('cg-matlab-path-fresh-');
    roots.push(freshRoot);
    const final: Record<string, string | null> = { ...initial };
    const cg = await CodeGraph.init(root, { index: true });
    const seen: string[][] = [allEdges(cg)];
    try {
      for (const step of steps) {
        writeTree(root, step);
        clearProjectConfigCache();
        Object.assign(final, step);
        await cg.sync();
        seen.push(allEdges(cg));
      }
    } finally {
      cg.close();
    }
    writeTree(freshRoot, Object.fromEntries(Object.entries(final).filter(([, c]) => c !== null)) as Record<string, string>);
    clearProjectConfigCache();
    const fresh = await CodeGraph.init(freshRoot, { index: true });
    try {
      return { steps: seen, synced: seen[seen.length - 1]!, fresh: allEdges(fresh), syncedRows: unresolvedRows(root), freshRows: unresolvedRows(freshRoot) };
    } finally {
      fresh.close();
    }
  }

  const BASE = {
    'lib1/util.m': 'function util()\nend\n',
    'lib2/util.m': 'function util()\nend\n',
    'lib2/only.m': 'function only()\nend\n',
    'lib1/caller.m': 'function caller()\nutil();\nonly();\nplot();\nend\n',
    // A project `plot`, off any path: the built-in's name, kept while a path is in force.
    'extra/plot.m': 'function plot()\nend\n',
    'app/main.m': 'function main()\nutil();\nend\n',
  };
  const TO_LIB1 = 'lib1/caller.m caller -calls-> util @ lib1/util.m';
  const TO_LIB2 = 'lib1/caller.m caller -calls-> util @ lib2/util.m';

  it('after an edit of codegraph.json\'s startup', async () => {
    const r = await syncedAndFresh(
      { ...BASE, 'codegraph.json': config({ startup: "addpath('lib1')" }) },
      { 'codegraph.json': config({ startup: "addpath('lib2'); addpath('lib1', '-end')" }) },
      { 'codegraph.json': config({ startup: "addpath('lib1')" }) },
    );
    expect(r.steps.map((s) => s.filter((e) => e.startsWith('lib1/caller.m caller -calls-> util')))).toEqual([[TO_LIB1], [TO_LIB2], [TO_LIB1]]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('after an edit of a setpath file that flips a branch', async () => {
    // The edit changes the file's size too: a sync tells an edit by it within one clock tick.
    const setp = (v: number) => `function setp()\nv = ${v};${' '.repeat(v)}\nif v == 1\n  addpath('lib1');\nelse\n  addpath('lib2', 'lib1');\nend\n`;
    const r = await syncedAndFresh(
      // From the root: the folders the code adds are the root's.
      { ...BASE, 'setup/setp.m': setp(1), 'codegraph.json': config({ startup: "addpath('setup'); setp", cwd: '' }) },
      { 'setup/setp.m': setp(2) },
    );
    expect(r.steps.map((s) => s.filter((e) => e.startsWith('lib1/caller.m caller -calls-> util')))).toEqual([[TO_LIB1], [TO_LIB2]]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('after a folder is added under a genpath root, and removed', async () => {
    const initial = { ...BASE, 'codegraph.json': config({ startup: "addpath(genpath('lib1'))" }) };
    const r = await syncedAndFresh(
      initial,
      { 'lib1/sub/only.m': 'function only()\nend\n' },
      { 'lib1/sub/only.m': null },
    );
    expect(r.steps.map((s) => s.filter((e) => e.includes('-calls-> only')))).toEqual([[], ['lib1/caller.m caller -calls-> only @ lib1/sub/only.m'], []]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('after startup.m is deleted, and added', async () => {
    const withStartup = { ...BASE, 'startup.m': "addpath('lib2');\naddpath('lib1', '-end');\n" };
    const removed = await syncedAndFresh(withStartup, { 'startup.m': null });
    expect(removed.steps.map((s) => s.filter((e) => e.startsWith('lib1/caller.m caller -calls-> util')))).toEqual([[TO_LIB2], [TO_LIB1]]);
    expect(removed.synced).toEqual(removed.fresh);
    expect(removed.syncedRows).toEqual(removed.freshRows);
    const added = await syncedAndFresh(BASE, { 'startup.m': "addpath('lib2');\naddpath('lib1', '-end');\n" });
    expect(added.steps.map((s) => s.filter((e) => e.startsWith('lib1/caller.m caller -calls-> util')))).toEqual([[TO_LIB1], [TO_LIB2]]);
    expect(added.synced).toEqual(added.fresh);
    expect(added.syncedRows).toEqual(added.freshRows);
  });

  it('an edit of an unrelated .m file works nothing out again', async () => {
    const root = project({ ...BASE, 'setup/setp.m': "function setp()\naddpath('lib2');\n", 'codegraph.json': config({ startup: "addpath('setup'); setp", cwd: '' }) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const before = allEdges(cg);
      const record = JSON.stringify(cg.getMatlabPathRecord());
      const runs = matlabPathEvaluations.count;
      writeTree(root, { 'app/main.m': 'function main()\nutil();\nutil();\nend\n' });
      await cg.sync();
      expect(matlabPathEvaluations.count).toBe(runs);
      expect(JSON.stringify(cg.getMatlabPathRecord())).toBe(record);
      expect(allEdges(cg).filter((e) => !e.startsWith('app/'))).toEqual(before.filter((e) => !e.startsWith('app/')));
      // A file the startup code read is no unrelated file.
      writeTree(root, { 'setup/setp.m': "function setp()\naddpath('lib1', 'lib2');\n" });
      await cg.sync();
      expect(matlabPathEvaluations.count).toBe(runs + 1);
    } finally {
      cg.close();
    }
  });

  it('an index from before paths re-resolves once on its first sync when the project sets one, and not otherwise', async () => {
    const root = project({ ...BASE, 'startup.m': "addpath('lib2');\n" });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const withPath = allEdges(cg);
      // What an older engine left: no record, edges resolved without a path.
      (cg as unknown as { queries: { deleteMetadata?: (k: string) => void; setMetadata: (k: string, v: string) => void } }).queries.setMetadata('matlab_search_path', '');
      expect(cg.getMatlabPathRecord()).toBeNull();
      await cg.sync();
      expect(cg.getMatlabPathRecord()!.source).toBe('startup.m');
      expect(allEdges(cg)).toEqual(withPath);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Configuration
// ---------------------------------------------------------------------------

describe('MATLAB path: configuration', () => {
  it('bad values are warned about and skipped, and indexing completes', async () => {
    const warnings: string[] = [];
    const logger: Logger = { debug: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    setLogger(logger);
    try {
      const root = project({
        'codegraph.json': JSON.stringify({ matlab: { startup: 5, cwd: '../x', env: { A: 1, B: 'b' }, computer: 'VAX', release: 'R1999', extra: true } }),
        'lib/f.m': 'function f()\nend\n',
        'main.m': 'function main()\nf();\nend\n',
      });
      expect(loadMatlabConfig(root)).toEqual({ env: { B: 'b' } });
      expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('"matlab.startup"'), expect.stringContaining('"matlab.release"')]));
      expect(warnings.filter((w) => w.includes('"matlab.')).length).toBe(6);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        expect(cg.getMatlabSearchPath()).toBeNull();
        expect(edgesFrom(cg, 'main.m', 'main')).toEqual(['main -calls-> f @ lib/f.m']);
      } finally {
        cg.close();
      }
      // Not an object at all.
      const other = project({ 'codegraph.json': JSON.stringify({ matlab: 'setpath' }) });
      expect(loadMatlabConfig(other)).toBeNull();
      expect(warnings.some((w) => w.includes('"matlab": it must be an object'))).toBe(true);
    } finally {
      setLogger(defaultLogger);
    }
  });

  it('startup code that sets no folder sets no path, and says why', async () => {
    const root = project({ 'codegraph.json': config({ startup: "addpath('nowhere')" }), 'lib/f.m': 'function f()\nend\n' });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const record = cg.getMatlabPathRecord()!;
      expect(record.source).toBeNull();
      expect(record.notes).toEqual(['the startup code put no folder of the project on the path', 'startup:1: addpath nowhere: no indexed file there, passed over']);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. What status, explore and node say
// ---------------------------------------------------------------------------

describe('MATLAB path: status, explore and node', () => {
  const COPIES = {
    'startup.m': "addpath('cur');\n",
    'cur/getpvx.m': 'function v = getpvx(name)\n% the copy on the path\nv = name;\nend\n',
    'old1/getpvx.m': 'function v = getpvx(name)\nv = 1;\nend\n',
    'old2/getpvx.m': 'function v = getpvx(name)\nv = 2;\nend\n',
    'old3/getpvx.m': 'function v = getpvx(name)\nv = 3;\nend\n',
    'old4/getpvx.m': 'function v = getpvx(name)\nv = 4;\nend\n',
    'cur/readall.m': 'function readall()\ngetpvx(1);\nend\n',
  };

  it('codegraph status --json includes the path', async () => {
    const root = project(COPIES);
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
    const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
    const out = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, bin, 'status', '--json', root], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(JSON.parse(out).matlabPath).toEqual({ inForce: true, source: 'startup.m', startup: 'startup.m', folders: ['cur'], cwd: '', notes: [], noteCount: 0 });
    const text = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, bin, 'status', root], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(text).toContain('MATLAB path: 1 folder from startup.m');
  });

  it('codegraph_node renders the on-path body and one line for the four copies off it', async () => {
    const root = project(COPIES);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const res = await new ToolHandler(cg).execute('codegraph_node', { symbol: 'getpvx', includeCode: true });
      const text = res.content[0]!.text;
      expect(text).toContain('the copy on the path');
      expect(text).not.toContain('old1/getpvx.m');
      expect(text).toContain('+4 more definitions of getpvx off the MATLAB path');
      // Pinned to a file, the copy asked for is what comes back.
      const pinned = (await new ToolHandler(cg).execute('codegraph_node', { symbol: 'getpvx', file: 'old2/getpvx.m', includeCode: true })).content[0]!.text;
      expect(pinned).toContain('v = 2;');
    } finally {
      cg.close();
    }
  });

  it('codegraph_explore renders the on-path body and one line for the copies off it', async () => {
    const root = project(COPIES);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'readall getpvx' });
      const text = res.content[0]!.text;
      const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
      expect(sourced).toContain('cur/getpvx.m');
      expect(sourced.filter((f) => f!.startsWith('old'))).toEqual([]);
      expect(text.match(/off the MATLAB path/g)).toHaveLength(1);
      expect(text).toContain('+4 more definitions of getpvx off the MATLAB path');
    } finally {
      cg.close();
    }
  });

  it('with no path, explore and node are as before', async () => {
    const files: Record<string, string> = { ...COPIES };
    delete files['startup.m'];
    const root = project(files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const node = (await new ToolHandler(cg).execute('codegraph_node', { symbol: 'getpvx', includeCode: true })).content[0]!.text;
      expect(node).toContain('5 definitions named "getpvx"');
      expect(node).not.toContain('off the MATLAB path');
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Review round 1: each finding's fixture (S/review/cases/<n>)
// ---------------------------------------------------------------------------

describe('MATLAB path: a sync ends where a fresh index of the same files ends (review cases)', () => {
  /** The path record as a test compares it: where it came from, the folders and the current folder. */
  function pathOf(cg: CodeGraph): string {
    const r = cg.getMatlabPathRecord();
    return JSON.stringify(r ? { source: r.source, folders: r.folders ?? null, cwd: r.cwd ?? null } : null);
  }

  /** Index `initial`, apply `step` (and `between`, run after the files are written and before the sync), sync, and compare with a fresh index of the result. */
  async function syncVsFresh(initial: Record<string, string>, step: Record<string, string | null>, between?: (cg: CodeGraph) => Promise<void>) {
    const root = project(initial);
    const freshRoot = tempDir('cg-matlab-path-fresh-');
    roots.push(freshRoot);
    const cg = await CodeGraph.init(root, { index: true });
    let synced: { edges: string[]; path: string };
    try {
      writeTree(root, step);
      clearProjectConfigCache();
      if (between) await between(cg);
      await cg.sync();
      synced = { edges: allEdges(cg), path: pathOf(cg) };
    } finally {
      cg.close();
    }
    const final = Object.fromEntries(Object.entries({ ...initial, ...step }).filter(([, c]) => c !== null)) as Record<string, string>;
    writeTree(freshRoot, final);
    clearProjectConfigCache();
    const fresh = await CodeGraph.init(freshRoot, { index: true });
    try {
      return { synced, fresh: { edges: allEdges(fresh), path: pathOf(fresh) }, syncedRows: unresolvedRows(root), freshRows: unresolvedRows(freshRoot) };
    } finally {
      fresh.close();
    }
  }

  function expectSame(r: Awaited<ReturnType<typeof syncVsFresh>>): void {
    expect(r.synced.path).toBe(r.fresh.path);
    expect(r.synced.edges).toEqual(r.fresh.edges);
    expect(r.syncedRows).toEqual(r.freshRows);
  }

  const MAIN = 'function main()\nz = foo(3);\nend\n';
  const FOO1 = 'function y = foo(x)\ny = x + 1;\nend\n';
  const FOO2 = 'function y = foo(x)\ny = x + 2;\nend\n';

  it('case 1: a file comes to define a name a followed file calls (H3)', async () => {
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'lib2/foo.m': FOO2, 'myinit.m': 'function myinit()\nhelper_paths();\nend\n', 'startup.m': "addpath('app');\naddpath('lib1');\nmyinit();\n" },
      { 'helper_paths.m': "function helper_paths()\naddpath('lib2', '-begin');\nend\n" },
    );
    expect(r.fresh.path).toContain('"folders":["lib2","lib1","app"]');
    expectSame(r);
  });

  it('case 3: a startup.m that set no path is fixed (H1)', async () => {
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'lib2/foo.m': FOO2, 'startup.m': "addpath('lib_2');\n" },
      { 'startup.m': "addpath('lib2');\n" },
    );
    expect(r.fresh.path).toContain('"folders":["lib2"]');
    expectSame(r);
  });

  it('case 4: a file comes to a folder a startup that set no path asked for (H1)', async () => {
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'startup.m': "addpath('lib2');\n" },
      { 'lib2/foo.m': FOO2 },
    );
    expect(r.fresh.path).toContain('"folders":["lib2"]');
    expectSame(r);
  });

  it('case 5: a sync stopped between storing the path and re-resolving is finished by the next one (H6)', async () => {
    const { ExtractionOrchestrator } = await import('../src/extraction');
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'lib2/foo.m': FOO2, 'startup.m': "addpath('app');\naddpath('lib1');\n" },
      { 'startup.m': "addpath('app');\naddpath('lib2');\n" },
      async (cg) => {
        const original = ExtractionOrchestrator.prototype.resurrectResolutionEdgesForLanguage;
        ExtractionOrchestrator.prototype.resurrectResolutionEdgesForLanguage = function (language) {
          if (language === 'matlab') throw new Error('killed');
          return original.call(this, language);
        };
        try {
          await expect(cg.sync()).rejects.toThrow('killed');
        } finally {
          ExtractionOrchestrator.prototype.resurrectResolutionEdgesForLanguage = original;
        }
      },
    );
    expect(r.fresh.edges).toContain('app/main.m main -calls-> foo @ lib2/foo.m');
    expectSame(r);
  });

  it('case 8: a file comes to a folder addpath passed over (H2)', async () => {
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'startup.m': "addpath('app');\naddpath('lib1');\naddpath('lib2', '-begin');\n" },
      { 'lib2/foo.m': FOO2 },
    );
    expect(r.fresh.path).toContain('"folders":["lib2","lib1","app"]');
    expectSame(r);
  });

  it('case 9: a built-in-named call that failed with no path links once a path arrives (H5)', async () => {
    const r = await syncVsFresh(
      { 'app/Disp.m': 'function Disp(x)\nfprintf("%g\\n", x);\nend\n', 'app/main.m': 'function main()\ndisp(3);\nend\n', 'lib1/disp.m': 'function disp(x)\nfprintf("%g\\n", x);\nend\n' },
      { 'startup.m': "addpath('app');\naddpath('lib1');\n" },
    );
    expect(r.fresh.edges).toContain('app/main.m main -calls-> disp @ lib1/disp.m');
    expectSame(r);
  });

  it('case 16: a file comes to the configured starting folder (H2)', async () => {
    const r = await syncVsFresh(
      {
        'app/main.m': MAIN,
        'codegraph.json': config({ startup: 'addpath(genpath("app")); addpath("lib1")', cwd: 'work' }),
        'lib1/foo.m': 'function y = foo(x)\ny = 1;\nend\n',
        'work/lib1/readme.txt': 'keep\n',
      },
      { 'work/lib1/foo.m': 'function y = foo(x)\ny = 2;\nend\n' },
    );
    expect(r.fresh.path).toContain('"cwd":"work"');
    expectSame(r);
  });

  it('a file comes to a folder only genpath listed', async () => {
    const r = await syncVsFresh(
      { 'app/main.m': MAIN, 'lib1/foo.m': FOO1, 'lib1/sub/keep.m': 'function keep()\nend\n', 'startup.m': "addpath('app');\naddpath(genpath('lib1'));\n" },
      { 'lib1/sub/foo.m': FOO2 },
    );
    expect(r.fresh.path).toContain('"folders":["lib1","lib1/sub","app"]');
    expectSame(r);
  });

  it('a same-named file comes earlier on the path than the setpath function the startup runs', async () => {
    const r = await syncVsFresh(
      {
        'app/main.m': MAIN,
        'lib1/foo.m': FOO1,
        'lib2/foo.m': FOO2,
        'tools1/setp.m': "function setp()\naddpath('lib1');\nend\n",
        'tools1/keep.m': 'function keep()\nend\n',
        'tools2/keep.m': 'function keep()\nend\n',
        'startup.m': "addpath('app');\naddpath('tools1');\naddpath('tools2');\nsetp;\n",
      },
      { 'tools2/setp.m': "function setp()\naddpath('lib2');\nend\n" },
    );
    expect(r.fresh.edges).toContain('app/main.m main -calls-> foo @ lib2/foo.m');
    expectSame(r);
  });
});

describe('MATLAB path: the evaluator (review cases)', () => {
  it('case 2: a function that saves pwd and cds back is still followed into what it calls (H4)', () => {
    const files = {
      'app/main.m': 'function main()\nz = foo(3);\nend\n',
      'init_all.m': 'function init_all()\nolddir = pwd;\nsetlibs();\ncd(olddir);\nend\n',
      'lib1/foo.m': 'function y = foo(x)\ny = 1;\nend\n',
      'lib2/foo.m': 'function y = foo(x)\ny = 2;\nend\n',
      'setlibs.m': "function setlibs()\naddpath('lib2', '-begin');\nend\n",
      'startup.m': "addpath('app');\naddpath('lib1');\ninit_all();\n",
    };
    expect(evaluate(files, '', { codeFile: 'startup.m' }).folders).toEqual(['lib2', 'lib1', 'app']);
  });

  it('case 6: an indexed assignment past the size cap makes the value unknown, and allocates nothing (L1)', () => {
    const r = evaluate({ 'a/x.m': '', 'b/x.m': '' }, "addpath('a');\nbuf(20000) = 0;\nc{30000} = 'x';\ns(40000) = 'a';\nif numel(buf) == 20000, addpath('b'); end");
    expect(r.notes).toEqual(['startup:5: a condition is not known: every branch it may take is run']);
    // Far past the cap: nothing is allocated, so it is over at once.
    const t0 = Date.now();
    expect(evaluate({ 'a/x.m': '' }, "big(1e9) = 0;\nc{1e9} = 'x';\ns(4e8) = 'a';\naddpath('a');").folders).toEqual(['a']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('case 7: a Windows project root (C:/…) gives the same path as a POSIX one (M3)', () => {
    const files = { 'startup.m': "addpath('app');\naddpath(genpath('lib1'));\n", 'lib1/foo.m': 'function foo\nend\n', 'lib1/sub/bar.m': 'function bar\nend\n', 'app/main.m': 'function main\nfoo;\nend\n' };
    const posix = evaluate(files, '', { codeFile: 'startup.m', computer: 'PCWIN64' }, '/home/u/proj');
    const win = evaluate(files, '', { codeFile: 'startup.m', computer: 'PCWIN64' }, 'C:/dev/proj');
    expect(posix.folders).toEqual(['lib1', 'lib1/sub', 'app']);
    expect(win.folders).toEqual(posix.folders);
    expect(win.cwd).toBe('');
    // A backslashed drive root, and code that spells the drive out.
    expect(evaluate(files, "addpath('C:\\dev\\proj\\lib1\\sub')", { computer: 'PCWIN64' }, 'C:\\dev\\proj').folders).toEqual(['lib1/sub']);
  });

  it('case 12: the current folder belongs to each branch, and is unknown after branches that disagree (M1)', () => {
    const files = { 'a/x/foo.m': '', 'x/foo.m': '', 'app/main.m': '' };
    const r = evaluate(files, "addpath('app');\nif rand > 0.5\n    cd('a');\n    addpath('x');\nelse\n    addpath('x');\nend\naddpath('y');\ncd('app')");
    expect(r.folders).toEqual(['x', 'a/x', 'app']);
    expect(r.cwd).toBeNull();
    expect(r.notes).toEqual(expect.arrayContaining([
      'startup:2: a condition is not known: every branch it may take is run',
      'startup:2: the branches end in different current folders: the current folder is not known from here on',
      'startup:8: addpath y: the current folder is not known, passed over',
      'startup:9: cd app: not a folder from every folder the current one may be: the current folder is not known from here on',
    ]));
  });

  it('case 15: cd out of the project and back in (M4)', () => {
    const files = { 'app/main.m': '', 'lib1/foo.m': '' };
    const r = evaluate(files, "addpath('app');\ncd('..');\naddpath('lib9');\ncd(fullfile(pwd, 'proj'));\naddpath('lib1');", {}, '/x/proj');
    expect(r.folders).toEqual(['lib1', 'app']);
    expect(r.cwd).toBe('');
    expect(r.notes).toEqual(['startup:3: addpath /x/lib9: outside the project, passed over']);
    // Ending outside: no current folder for resolution to rank.
    expect(evaluate(files, "addpath('app');\ncd('..');", {}, '/x/proj').cwd).toBeNull();
  });
});

describe('MATLAB path: what the index keeps (review cases)', () => {
  it('case 10: a class folder\'s private helper on the path counts as on the path (L2)', async () => {
    const root = project({
      'lib1/@Pt/private/helper.m': 'function y = helper(x)\ny = onlyold(x);\nend\n',
      'lib1/@Pt/Pt.m': "function p = Pt(x)\np.x = x;\np = class(p, 'Pt');\nend\n",
      'lib1/+pk/private/phelp.m': 'function y = phelp(x)\ny = onlyold(x);\nend\n',
      'lib1/private/phelper.m': 'function y = phelper(x)\ny = onlyold(x);\nend\n',
      'old/onlyold.m': 'function y = onlyold(x)\ny = x;\nend\n',
      'startup.m': "addpath('lib1');\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg).filter((e) => e.includes('onlyold @'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('case 11: the note count is the true one, past the capped list (L4)', async () => {
    const lines = ["addpath('lib1');", ...Array.from({ length: 250 }, (_, i) => `if rand > 0.5, x = ${i + 1}; end`)];
    const root = project({ 'lib1/foo.m': 'function y = foo(x)\ny = x;\nend\n', 'startup.m': lines.join('\n') + '\n' });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const record = cg.getMatlabPathRecord()!;
      expect(record.noteCount).toBe(250);
      expect(record.notes!.length).toBeLessThanOrEqual(200);
    } finally {
      cg.close();
    }
    const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
    const text = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, bin, 'status', root], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(text).toContain('(250 notes)');
  });

  it('case 14: an import of a package only off the path links nothing from a caller on the path (L3, kept)', async () => {
    const root = project({
      'app/main.m': 'function main()\nimport pq.*\na = qg(1);\nimport pq.qg\nb = qg(2);\nend\n',
      'old/+pq/qg.m': 'function y = qg(x)\ny = x;\nend\n',
      'startup.m': "addpath('app');\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFrom(cg, 'app/main.m', 'main')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('case 18: a startup.m that does not parse cleanly sets no path, and says where (D6)', async () => {
    const root = project({
      'app/main.m': 'function main()\nz = foo(3);\nend\n',
      'lib1/foo.m': 'function y = foo(x)\ny = x;\nend\n',
      'lib2/foo.m': 'function y = foo(x)\ny = x;\nend\n',
      'startup.m': "addpath('app');\nif true\n  addpath('lib1')\nx = [1 2;\naddpath('lib2');\n",
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const record = cg.getMatlabPathRecord()!;
      expect(record.source).toBeNull();
      expect(record.notes![0]).toMatch(/^startup\.m:\d+: the code does not parse/);
    } finally {
      cg.close();
    }
  });

  it('a followed setpath file that does not parse sets no path; one followed for its value gives unknown', () => {
    const files = {
      'a/x.m': '', 'b/x.m': '',
      'setp.m': "function setp()\naddpath('a');\nif true\n  x = [1 2;\nend\n",
      'name.m': "function n = name()\nn = 'b';\nx = [1 2;\n",
    };
    const broken = evaluate(files, "addpath('b');\nsetp;");
    expect(broken.failed).toMatch(/^setp\.m:\d+: the code does not parse/);
    const value = evaluate(files, "addpath('a');\nif strcmp(name(), 'b'), addpath('b'); end");
    expect(value.failed).toBeNull();
    expect(value.notes).toEqual(expect.arrayContaining(['startup:2: a condition is not known: every branch it may take is run']));
  });

  it('the evaluator reaches the project only through the recorder', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'resolution', 'matlab-path-eval.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      '../extraction/languages/matlab-builtins',
      '../extraction/languages/matlab-path',
      '../extraction/languages/matlab-syntax',
      '../extraction/languages/matlab-values',
      '../extraction/tree-sitter-helpers',
      '../graph/matlab-search-path',
      './matlab-path-access',
      'web-tree-sitter',
    ]);
    expect(source).not.toMatch(/\brequire\(|readFileSync|getAllFilePaths|queries\./);
  });
});

describe('MATLAB path: explore names the copies it collapses (review case 17)', () => {
  it('collapses a named symbol\'s case-variant copies off the path, and gives no line for a name it only gathered', async () => {
    const files: Record<string, string> = {
      'startup.m': "addpath('cur');\n",
      'cur/findm44.m': 'function m = findm44(r)\n% the copy on the path\nm = stepper(r);\nend\n',
      'old1/FindM44.m': 'function m = FindM44(r)\n% an old case variant\nm = 1;\nend\n',
      'old2/findm44.m': 'function m = findm44(r)\nm = 2;\nend\n',
      'cur/stepper.m': 'function s = stepper(r)\ns = r;\nend\n',
      'old3/stepper.m': 'function s = stepper(r)\ns = 3;\nend\n',
      'cur/ringtrack.m': 'function ringtrack()\nfindm44(1);\nend\n',
    };
    const root = project(files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'ringtrack findm44' })).content[0]!.text;
      const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
      expect(sourced.filter((f) => f!.startsWith('old'))).toEqual([]);
      expect(text).toContain('+1 more definition of findm44 off the MATLAB path, 1 more spelled differently');
      // stepper is only gathered: a line for it only when its on-path copy is rendered.
      if (!sourced.includes('cur/stepper.m')) expect(text).not.toContain('of stepper off the MATLAB path');
      expect(text.split('\n').filter((l) => l.includes('off the MATLAB path') && /\bRead\b/.test(l))).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Review round 2: each finding's fixture (S/review2/cases/<n>)
// ---------------------------------------------------------------------------

describe('MATLAB path: review round 2', () => {
  /** What a sync and a fresh index are compared on: the path, every edge, and every unresolved row with its status. */
  function stateOf(cg: CodeGraph, root: string): { path: string; edges: string[]; rows: string[] } {
    const r = cg.getMatlabPathRecord();
    const db = DatabaseConnection.open(getDatabasePath(root));
    let rows: string[];
    try {
      rows = (db.getDb().prepare('SELECT file_path AS f, line AS l, reference_kind AS k, reference_name AS n, status AS s FROM unresolved_refs').all() as Array<{ f: string; l: number; k: string; n: string; s: string }>)
        .map((x) => `${x.f}:${x.l} ${x.k}:${x.n} ${x.s}`).sort();
    } finally {
      db.close();
    }
    return { path: JSON.stringify(r ? { source: r.source, folders: r.folders ?? null, cwd: r.cwd ?? null } : null), edges: allEdges(cg), rows };
  }

  /**
   * Index `initial`, then apply each step and sync; after every step, a fresh
   * index of the same files. Returns each step's synced and fresh state.
   */
  async function stepsVsFresh(initial: Record<string, string>, steps: Array<Record<string, string | null> | ((root: string) => void)>) {
    const root = project(initial);
    const files: Record<string, string | null> = { ...initial };
    const out: Array<{ synced: ReturnType<typeof stateOf>; fresh: ReturnType<typeof stateOf> }> = [];
    const cg = await CodeGraph.init(root, { index: true });
    try {
      for (const step of steps) {
        if (typeof step === 'function') step(root);
        else {
          writeTree(root, step);
          Object.assign(files, step);
        }
        clearProjectConfigCache();
        await cg.sync();
        const synced = stateOf(cg, root);
        const freshRoot = tempDir('cg-matlab-path-fresh-');
        roots.push(freshRoot);
        fs.cpSync(root, freshRoot, { recursive: true, filter: (src) => path.basename(src) !== '.codegraph' });
        clearProjectConfigCache();
        const fresh = await CodeGraph.init(freshRoot, { index: true });
        try {
          out.push({ synced, fresh: stateOf(fresh, freshRoot) });
        } finally {
          fresh.close();
        }
      }
    } finally {
      cg.close();
    }
    return out;
  }

  function expectEverySame(steps: Awaited<ReturnType<typeof stepsVsFresh>>): void {
    steps.forEach((s, i) => expect({ step: i + 1, ...s.synced }).toEqual({ step: i + 1, ...s.fresh }));
  }

  const MAIN_DISP = 'function main()\ndisp(3);\nfoo();\nend\n';
  const FOO = 'function foo()\nend\n';
  const DISP = 'function disp(x)\nend\n';

  describe('E1: a built-in name that gains or loses its first project carrier', () => {
    it('case 1: a disp.m arrives off the path, then the path takes it in', async () => {
      const steps = await stepsVsFresh(
        { 'app/main.m': MAIN_DISP, 'lib1/foo.m': FOO, 'startup.m': "addpath('app');\naddpath('lib1');\n" },
        [{ 'old/disp.m': DISP }, { 'startup.m': "addpath('app');\naddpath('lib1');\naddpath('old');\n" }],
      );
      expect(steps[1]!.fresh.edges).toContain('app/main.m main -calls-> disp @ old/disp.m');
      expectEverySame(steps);
    });

    it('a disp.m arrives on the path', async () => {
      const steps = await stepsVsFresh(
        { 'app/main.m': MAIN_DISP, 'lib1/foo.m': FOO, 'startup.m': "addpath('app');\naddpath('lib1');\n" },
        [{ 'lib1/disp.m': DISP }],
      );
      expect(steps[0]!.fresh.edges).toContain('app/main.m main -calls-> disp @ lib1/disp.m');
      expectEverySame(steps);
    });

    it('a disp.m arrives, with no path', async () => {
      const steps = await stepsVsFresh({ 'app/main.m': MAIN_DISP, 'lib1/foo.m': FOO }, [{ 'lib1/disp.m': DISP }]);
      expect(steps[0]!.fresh.edges).toContain('app/main.m main -calls-> disp @ lib1/disp.m');
      expectEverySame(steps);
    });

    it('the 7-step sequence that ends with a private addpath.m', async () => {
      const steps = await stepsVsFresh(
        {
          'app/main.m': 'function main()\nfoo();\nend\n',
          'lib1/foo.m': FOO,
          'lib2/foo.m': FOO,
          'startup.m': "addpath('app');\naddpath('tools');\nsetlibs;\n",
          'tools/setlibs.m': "function setlibs\naddpath('lib1');\nend\n",
        },
        [
          { 'tools/setlibs.m': "function setlibs\naddpath('lib2');\nend\n" },
          {},
          { 'tools/setlibs.m': "function setlibs\n% a comment\naddpath('lib2');\nend\n" },
          { 'tools/setlibs.m': "function setlibs\naddpath('lib1');\nend\n", 'app/main.m': 'function main()\nfoo();\nfoo();\nend\n' },
          { 'tools/private/addpath.m': 'function addpath(x)\nend\n' },
          (root) => fs.rmSync(path.join(root, 'lib1'), { recursive: true, force: true }),
          { 'lib1/foo.m': FOO },
        ],
      );
      expect(steps[4]!.fresh.edges).toContain('tools/setlibs.m setlibs -calls-> addpath @ tools/private/addpath.m');
      expectEverySame(steps);
    });

    it('L1 (case 2): the only project disp goes, and its failed calls go with it', async () => {
      const steps = await stepsVsFresh(
        { 'app/main.m': MAIN_DISP, 'lib1/foo.m': FOO, 'old/disp.m': DISP, 'startup.m': "addpath('app');\naddpath('lib1');\n" },
        [{ 'old/disp.m': null }],
      );
      expect(steps[0]!.fresh.rows.filter((r) => r.includes('calls:disp'))).toEqual([]);
      expectEverySame(steps);
    });

    it('a script carries the name too (beep.m), and going back to no carrier drops the rows again', async () => {
      const steps = await stepsVsFresh(
        { 'app/main.m': 'function main()\nbeep;\nbeep(1);\nend\n', 'tools/other.m': 'function other()\nx = beep();\nend\n' },
        [{ 'lib/beep.m': 'disp(1);\n' }, { 'lib/beep.m': null }],
      );
      expect([...steps[0]!.fresh.edges, ...steps[0]!.fresh.rows].filter((x) => x.includes('beep')).length).toBeGreaterThan(1);
      expect(steps[1]!.fresh.rows.filter((x) => x.includes('beep'))).toEqual([]);
      expectEverySame(steps);
    });
  });

  describe('E2: an unknown current folder is a set of candidates', () => {
    it('case 4: a call the candidate folders answer differently is not followed, and links nothing past them', async () => {
      const root = project({
        'app/main.m': 'function main()\nfoo();\nend\n',
        'libA/foo.m': FOO, 'libB/foo.m': FOO, 'libT/foo.m': FOO,
        'siteA/setpaths.m': "function setpaths\naddpath(fullfile(fileparts(mfilename('fullpath')), '..', 'libA'));\nend\n",
        'siteB/setpaths.m': "function setpaths\naddpath(fullfile(fileparts(mfilename('fullpath')), '..', 'libB'));\nend\n",
        'tools/setpaths.m': "function setpaths\naddpath(fullfile(fileparts(mfilename('fullpath')), '..', 'libT'));\nend\n",
        'startup.m': "addpath('app');\naddpath('tools');\nif exist('/etc/site_a.txt', 'file')\n  cd('siteA');\nelse\n  cd('siteB');\nend\nsetpaths;\n",
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const record = cg.getMatlabPathRecord()!;
        expect(record.folders).toEqual(['tools', 'app']);
        expect(record.cwd).toBeNull();
        expect(allEdges(cg).filter((e) => e.includes('libT/'))).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('a lookup, which, exist and a relative add are known when every candidate folder agrees, and not when they differ', () => {
      const up = (lib: string) => `addpath(fullfile(fileparts(mfilename('fullpath')), '..', '${lib}'));`;
      const files = {
        'a/x/f.m': '', 'b/x/f.m': '', 'libz/z.m': '', 'lib2a/q.m': '', 'lib2b/q.m': '', 'top/k.m': '',
        'lib/only1.m': `function only1\n${up('libz')}\nend\n`,
        'a/two.m': `function two\n${up('lib2a')}\nend\n`,
        'b/two.m': `function two\n${up('lib2b')}\nend\n`,
      };
      const code = [
        "addpath('lib');",
        "if rand > 0.5, cd('a'); else, cd('b'); end",
        'only1;', // one copy, on the path: the same from either folder
        'two;', // a's and b's copies differ
        "if exist('x', 'dir'), addpath('/proj/top'); end", // both folders hold an x/
        "w = which('only1');",
        "if strcmp(w, '/proj/lib/only1.m'), addpath('/proj/lib2b'); end",
        "v = which('two');",
        "if isempty(v), addpath('/proj/lib2a'); end",
        "addpath('x');", // a/x or b/x
        "cd('..');", // the root from either
        "addpath('top');",
      ].join('\n');
      const r = evaluate(files, code);
      expect(r.folders).toEqual(['top', 'lib2a', 'lib2b', 'libz', 'lib']);
      expect(r.cwd).toBe('');
      expect(r.notes).toEqual(expect.arrayContaining([
        'startup:4: two: the current folder is not known, and what it runs depends on it: not followed',
        'startup:9: a condition is not known: every branch it may take is run',
        'startup:10: addpath x: the current folder is not known, passed over',
      ]));
      expect(r.notes.filter((n) => /^startup:[57]:/.test(n))).toEqual([]);
    });

    it('past 8 candidate folders, or after a cd to a folder not known, the current folder may be any: only a name no folder off the path defines is looked up', () => {
      const dirs = Array.from({ length: 9 }, (_, i) => `d${i}`);
      const files: Record<string, string> = {
        'lib/setl.m': "function setl\naddpath(fullfile(fileparts(mfilename('fullpath')), '..', 'libz'));\nend\n", 'libz/z.m': '',
        'lib/dup.m': "function dup\naddpath('/proj/liby');\nend\n", 'old/dup.m': '', 'liby/y.m': '',
      };
      for (const d of dirs) files[`${d}/k.m`] = '';
      const branches = dirs.map((d, i) => `${i === 0 ? 'if' : 'elseif'} rand > ${i / 10}, cd('${d}');`).join('\n');
      const r = evaluate(files, `addpath('lib');\n${branches}\nend\nsetl;\ndup;\naddpath('lib');\n`);
      expect(r.folders).toEqual(['libz', 'lib']);
      expect(r.cwd).toBeNull();
      expect(r.notes).toEqual(expect.arrayContaining([expect.stringMatching(/dup: the current folder is not known/)]));
      const any = evaluate(files, "addpath('lib');\ncd(userpath);\nsetl;\ndup;\naddpath('top');\n");
      expect([any.folders, any.cwd]).toEqual([['libz', 'lib'], null]);
    });
  });

  describe('E3: early exits join where they land', () => {
    const FILES = { 'a/lib1/foo.m': FOO, 'lib1/foo.m': FOO, 'app/main.m': 'function main()\nfoo();\nend\n' };

    it('case 3: a function that cds and returns in one branch leaves the folder unknown to its caller', async () => {
      const root = project({
        ...FILES,
        'startup.m': "addpath('app');\naddpath('tools');\ngotowork('');\naddpath('lib1');\n",
        'tools/gotowork.m': "function gotowork(home)\nif exist('/etc/site_matlab.txt', 'file')\n  cd('a');\n  return\nend\ndisp('staying');\nend\n",
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const record = cg.getMatlabPathRecord()!;
        expect(record.folders).toEqual(['tools', 'app']);
        expect(record.cwd).toBeNull();
        expect(allEdges(cg).filter((e) => e.startsWith('app/main.m'))).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('break, a caught error, while + break, and a value function\'s early return', () => {
      const files = { 'a/lib1/foo.m': FOO, 'lib1/foo.m': FOO, 'app/main.m': '', 'app/setroot.m': "function r = setroot()\nr = '.';\nif exist('/etc/site_matlab.txt', 'file'), r = 'a'; return; end\nend\n" };
      const brk = evaluate(files, "addpath('app');\nfor k = 1:3\n  if exist('/etc/site_matlab.txt', 'file')\n    cd('a'); break\n  end\nend\naddpath('lib1');\n");
      expect([brk.folders, brk.cwd]).toEqual([['app'], null]);
      const caught = evaluate(files, "addpath('app');\ntry\n  if exist('/etc/site_matlab.txt', 'file')\n    cd('a'); error('stop');\n  end\ncatch\n  addpath('lib1');\nend\n");
      expect([caught.folders, caught.cwd]).toEqual([['a/lib1', 'app'], null]);
      const whileBreak = evaluate(files, "addpath('app');\nwhile exist('/etc/site_matlab.txt', 'file')\n  cd('a'); break;\nend\naddpath('lib1');\n");
      expect([whileBreak.folders, whileBreak.cwd]).toEqual([['app'], null]);
      const value = evaluate(files, "addpath('app');\nx = setroot();\naddpath(fullfile(x,'lib1'));\n");
      expect(value.folders).toEqual(['app']);
      // continue lands at the next round: the folder it left in is the next round's.
      const cont = evaluate(files, "addpath('app');\nfor k = 1:2\n  if k == 2, addpath('lib1'); end\n  if exist('/etc/site_matlab.txt', 'file'), cd('a'); continue; end\nend\n");
      expect(cont.folders).toEqual(['app']);
      expect(cont.cwd).toBeNull();
    });
  });

  describe('E4: explore and node render a name\'s copies from one derivation', () => {
    it('case 5: a case variant on the path never hides the named function\'s copies', async () => {
      const root = project({
        'app/main.m': 'function main()\nhelper(1);\nend\n',
        'lib1/Helper.m': 'function Helper(x)\n% the on-path case variant\ny = x + 1;\nend\n',
        'old/helper.m': 'function helper(x)\n% old copy\ny = x * 2;\nend\n',
        'old2/helper.m': 'function helper(x)\n% old2 copy\ny = x * 3;\nend\n',
        'startup.m': "addpath('app');\naddpath('lib1');\n",
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const explore = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'helper' })).content[0]!.text;
        const sourced = [...explore.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
        expect(sourced).toContain('old/helper.m');
        expect(sourced).not.toContain('lib1/Helper.m');
        expect(explore).toMatch(/\*\*`old\/helper\.m`\*\* — .*not on the MATLAB path/);
        expect(explore).toContain('+1 more definition of helper off the MATLAB path, 1 more spelled differently');
        const node = (await new ToolHandler(cg).execute('codegraph_node', { symbol: 'helper', includeCode: true })).content[0]!.text;
        expect(node).toContain('old copy');
        expect(node).toContain('old2 copy');
        expect(node).toContain('+1 more definition of helper spelled differently');
      } finally {
        cg.close();
      }
    });

    it('case 7: explore and node count the same copies', async () => {
      const root = project({
        'app/main.m': 'function main()\nfindm44(1);\nend\n',
        'lib1/findm44.m': 'function findm44(x)\nend\n',
        'old/findm44.m': 'function findm44(x)\nend\n',
        'old2/FindM44.m': 'function FindM44(x)\nend\n',
        'startup.m': "addpath('app');\naddpath('lib1');\n",
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const line = '+1 more definition of findm44 off the MATLAB path, 1 more spelled differently';
        const explore = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'findm44' })).content[0]!.text;
        const node = (await new ToolHandler(cg).execute('codegraph_node', { symbol: 'findm44', includeCode: true })).content[0]!.text;
        expect(explore.split('\n').filter((l) => l.includes('off the MATLAB path'))).toEqual([line]);
        expect(node.split('\n').filter((l) => l.includes('off the MATLAB path'))).toEqual([line]);
      } finally {
        cg.close();
      }
    });
  });

  it('E5 (case 6): a sync from a moved checkout works the path out again', async () => {
    const parent = tempDir('cg-matlab-path-move-');
    roots.push(parent);
    const files = {
      'app/main.m': 'function main()\nfoo();\nend\n', 'dev/foo.m': FOO, 'lib1/foo.m': FOO,
      'startup.m': "addpath('app');\nif contains(pwd, '-dev')\n  addpath('dev');\nelse\n  addpath('lib1');\nend\n",
    };
    writeTree(path.join(parent, 'proj'), files);
    (await CodeGraph.init(path.join(parent, 'proj'), { index: true })).close();
    fs.renameSync(path.join(parent, 'proj'), path.join(parent, 'proj-dev'));
    const moved = path.join(parent, 'proj-dev');
    const cg = await CodeGraph.open(moved);
    let synced: ReturnType<typeof stateOf>;
    try {
      await cg.sync();
      synced = stateOf(cg, moved);
    } finally {
      cg.close();
    }
    writeTree(path.join(parent, 'fresh', 'proj-dev'), files);
    const fresh = await CodeGraph.init(path.join(parent, 'fresh', 'proj-dev'), { index: true });
    try {
      const want = stateOf(fresh, path.join(parent, 'fresh', 'proj-dev'));
      expect(want.path).toContain('"folders":["dev","app"]');
      expect(synced).toEqual(want);
    } finally {
      fresh.close();
    }
  });
});
