/**
 * MATLAB through a sync: a sync that adds, edits or removes MATLAB files ends
 * with the edges and unresolved rows a fresh index of the same files has —
 * scripts that become functions, targets that go and come back, superclasses
 * that move or change, an equally near function added earlier in genpath
 * order or a target removed from under a call, an interrupted index, a
 * project that also holds Objective-C `.m` files. The calls a sync cannot
 * link by design (a row dropped before its target existed) are pinned with
 * the drop rules in matlab-resolution.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { ExtractionOrchestrator } from '../src/extraction';
import { allEdges, dormantRows, syncedAndFresh, syncedAndFreshEachStep, tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

describe('MATLAB sync converges on a fresh index', () => {
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
    // As help text it is a stub, which the statement reaches too; Octave answers nothing.
    expect(steps).toEqual([[SCRIPT_CALL], [SCRIPT_CALL], [SCRIPT_CALL], [], [SCRIPT_CALL]]);
    expect(synced).toEqual(fresh);
  });

  it('when a script with a farther copy becomes help text only, or Octave, and back: the call returns to the nearer copy', async () => {
    const FARTHER_CALL = 'main.m main -calls-> sub/setup_paths.m @ sub/setup_paths.m';
    const { steps, synced, fresh } = await syncedAndFresh(
      { 'main.m': MAIN, 'setup_paths.m': 'addpath(pwd);\n', 'sub/setup_paths.m': 'x = 1;\n' },
      { 'setup_paths.m': '% SETUP_PATHS  help for a MEX function\n' },
      { 'setup_paths.m': 'addpath(pwd);\n' },
      { 'setup_paths.m': '# Octave\naddpath(pwd);\n' },
      { 'setup_paths.m': 'addpath(pwd);\n' },
    );
    expect(steps).toEqual([[SCRIPT_CALL], [FARTHER_CALL], [SCRIPT_CALL], [FARTHER_CALL], [SCRIPT_CALL]]);
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
    const root = tempDir('cg-matlab-supers-');
    const files: Record<string, string | null> = { ...initial };
    writeTree(root, initial);
    const cg = await CodeGraph.init(root, { index: true });
    const out: Array<{ synced: string[]; fresh: string[] }> = [];
    try {
      for (const step of steps) {
        writeTree(root, step);
        Object.assign(files, step);
        await cg.sync();
        const freshRoot = tempDir('cg-matlab-supers-fresh-');
        writeTree(freshRoot, Object.fromEntries(Object.entries(files).filter(([, c]) => c !== null)));
        const fresh = await CodeGraph.init(freshRoot, { index: true });
        try {
          out.push({ synced: allEdges(cg), fresh: allEdges(fresh) });
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
    // Base's wave reaches Mid's override while Mid inherits from Base.
    const override = 'Base.m Base::wave -calls-> Mid::wave @ Mid.m';
    const all = [override, 'Mid.m Mid -extends-> Base @ Base.m', 'Sub2.m Sub2 -extends-> Mid @ Mid.m', ...greet,
      'main.m main -calls-> Base::wave @ Base.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'];
    expect(steps.map((s) => s.synced)).toEqual([
      all,
      ['Sub2.m Sub2 -extends-> Mid @ Mid.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'],
      all,
      [override, 'Mid.m Mid -extends-> Base @ Base.m', 'main.m main -calls-> Base::wave @ Base.m'],
      ['main.m main -calls-> Base::wave @ Base.m', 'main.m main -instantiates-> Sub2 @ Sub2.m'],
      all,
    ]);
    for (const { synced, fresh } of steps) expect(synced).toEqual(fresh);
  });
});

describe('MATLAB lookup order through a sync', () => {
  it('moves a call to an equally near function a sync adds earlier in genpath order, as a fresh index would', async () => {
    const root = tempDir('cg-matlab-genpath-sync-');
    writeTree(root, {
      'b/helper.m': 'function helper()\nend\n',
      'c/main.m': 'function main()\nhelper();\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toEqual(['c/main.m main -calls-> helper @ b/helper.m']);
      writeTree(root, { 'a/helper.m': 'function helper()\nend\n' });
      await cg.sync({ paths: ['a/helper.m'] });
      expect(allEdges(cg)).toEqual(['c/main.m main -calls-> helper @ a/helper.m']);
      fs.rmSync(path.join(root, 'a/helper.m'));
      await cg.sync({ paths: ['a/helper.m'] });
      const synced = allEdges(cg);
      expect(synced).toEqual(['c/main.m main -calls-> helper @ b/helper.m']);
      await cg.indexAll();
      expect(allEdges(cg)).toEqual(synced);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebinds a function-syntax call on the object when a sync removes its target, as a fresh index would', async () => {
    const root = tempDir('cg-matlab-order-sync-');
    writeTree(root, {
      'K.m': 'classdef K < handle\n    methods\n        function run(obj)\n            pathFn(obj, 2);\n            later(obj);\n        end\n    end\nend\n',
      'pathFn.m': 'function pathFn(k, n)\nend\n',
      'lib/pathFn.m': 'function pathFn(k, n)\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toEqual(['K.m K::run -calls-> pathFn @ pathFn.m']);
      fs.rmSync(path.join(root, 'pathFn.m'));
      writeTree(root, { 'later.m': 'function later(k)\nend\n' });
      await cg.sync({ paths: ['pathFn.m', 'later.m'] });
      const synced = allEdges(cg);
      expect(synced).toEqual([
        'K.m K::run -calls-> later @ later.m',
        'K.m K::run -calls-> pathFn @ lib/pathFn.m',
      ]);
      await cg.indexAll();
      expect(allEdges(cg)).toEqual(synced);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB files of Octave or binary text carry no built-in\'s name', () => {
  // physbase keeps Octave's `datestr.m` off the path and MATLAB Compiler's
  // encrypted `pause.m` in a deployed tree. Neither answers a call, so the
  // built-in calls of their names keep no row; the help text of a MEX
  // function (`input.m`, comments only) and a script (`now.m`) still do:
  // with no path, either may be what MATLAB runs first.
  const OCTAVE = '## Copyright (C) 2000 Paul Kienzle\nfunction s = datestr(t)\n  s = t;\nendfunction\n';
  const MATLAB = 'function s = datestr(t)\n  s = sprintf(\'%d\', t);\nend\n';
  const BLOB = 'V1MCC4000MEC1000MCR1000x\u0001\u0000\u0000\u0087 pause(1) encrypted\n';
  const USER = "function user()\n  s = datestr(1);\n  pause(1);\n  x = input('go');\n  t = now();\nend\n";
  const FILES = {
    'user.m': USER,
    'EPICS/datestr.m': OCTAVE,
    'deploy/pause.m': BLOB,
    'help/input.m': '% INPUT  help for a MEX function of that name\n',
    'scripts/now.m': 't = clock;\n',
  };
  const names = (rows: string[]): string[] => rows.map((r) => r.slice(r.indexOf(':', r.indexOf(' ')) + 1)).sort();

  it('a fresh index keeps no row for a call of an Octave or a binary file\'s name, and keeps the stub\'s and the script\'s', async () => {
    const root = tempDir('cg-matlab-unread-');
    try {
      writeTree(root, FILES);
      const cg = await CodeGraph.init(root, { index: true });
      cg.close();
      expect(names(unresolvedRows(root))).toEqual(['input', 'now']);
      expect(names(dormantRows(root))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a sync ends where a fresh index ends: Octave to MATLAB and back, a binary added and removed, a script and a stub turned and deleted', async () => {
    const sequences: Array<Array<Record<string, string | null>>> = [
      [{ 'EPICS/datestr.m': MATLAB }, { 'EPICS/datestr.m': OCTAVE }],
      [{ 'deploy/pause.m': null }, { 'deploy/pause.m': BLOB }],
      [{ 'scripts/now.m': '# Octave\nt = clock;\n' }, { 'scripts/now.m': 't = clock;\n' }, { 'scripts/now.m': null }],
      [{ 'help/input.m': null }, { 'help/input.m': BLOB }, { 'help/input.m': '% INPUT  help again\n' }],
    ];
    const runs = [];
    for (const steps of sequences) {
      const run = await syncedAndFreshEachStep(FILES, ...steps);
      run.forEach((step, i) => {
        expect(step.synced, `${JSON.stringify(steps[i])} edges`).toEqual(step.fresh);
        expect(step.syncedRows, `${JSON.stringify(steps[i])} rows`).toEqual(step.freshRows);
        expect(step.syncedDormant, `${JSON.stringify(steps[i])} dormant rows`).toEqual(step.freshDormant);
      });
      runs.push(run);
    }
    // The rule bites: MATLAB's datestr.m answers the call, Octave's does not.
    const [matlab, octave] = runs[0]!;
    expect(matlab!.synced).toContain('user.m user -calls-> datestr @ EPICS/datestr.m');
    expect(names(octave!.syncedRows)).toEqual(['input', 'now']);
  }, 180_000);

  // A bare read (`c = color;`) and a call dispatched under a built-in's name
  // (`datestr(d, …)` on what `EPICS2MatlabTime` returns, `T::datestr`) keep a
  // row only while a symbol carries the name: a file whose text turns to
  // MATLAB code or from it gives the name its only carrier, or takes it, as
  // adding or deleting it does, and the files a sync leaves alone follow.
  const CARRIED = {
    'EPICS2MatlabTime.m': 'function t = EPICS2MatlabTime(x)\n  t = x;\nend\n',
    'user.m': 'function user()\n  d = EPICS2MatlabTime(1);\n  s = datestr(d, "yyyy");\n  c = color;\nend\n',
  };
  const COLOR = 'function c = color()\n  c = [1 0 0];\nend\n';
  const COLOR_BLOB = 'V1MCC4000MEC1000MCR1000x\u0001\u0000\u0000K\u00ca^\n\u00c6}R';
  const expectEachStepFresh = (run: Awaited<ReturnType<typeof syncedAndFreshEachStep>>, steps: Array<Record<string, string | null>>): void => {
    run.forEach((step, i) => {
      expect(step.synced, `step ${i} ${JSON.stringify(Object.keys(steps[i]!))} edges`).toEqual(step.fresh);
      expect(step.syncedRows, `step ${i} ${JSON.stringify(Object.keys(steps[i]!))} rows`).toEqual(step.freshRows);
      expect(step.syncedDormant, `step ${i} ${JSON.stringify(Object.keys(steps[i]!))} dormant rows`).toEqual(step.freshDormant);
    });
  };

  it('a sync ends where a fresh index ends when the only carrier of a bare read or of a dispatched built-in\'s name turns to MATLAB code or from it', async () => {
    const steps: Array<Record<string, string | null>> = [
      { 'blob/color.m': COLOR },
      { 'blob/color.m': COLOR_BLOB },
      { 'EPICS/datestr.m': MATLAB },
      { 'EPICS/datestr.m': OCTAVE },
      { 'blob/color.m': null },
      { 'blob/color.m': COLOR_BLOB },
    ];
    const run = await syncedAndFreshEachStep({ ...CARRIED, 'EPICS/datestr.m': OCTAVE, 'blob/color.m': COLOR_BLOB }, ...steps);
    expectEachStepFresh(run, steps);
    // The rule bites: the function links the untouched caller's bare read,
    // and the Octave file keeps no row of the dispatched call.
    expect(run[0]!.synced).toContain('user.m user -calls-> color @ blob/color.m');
    expect(run[3]!.syncedRows).toEqual([]);
  }, 180_000);

  it('a sync ends where a fresh index ends when a script run by name turns to Octave or binary text and back', async () => {
    const SHADE = '% SHADE a script\ny = 1;\n';
    const steps: Array<Record<string, string | null>> = [
      { 'lib/shade.m': COLOR_BLOB },
      { 'lib/shade.m': SHADE },
      { 'lib/shade.m': '## Copyright (C) 2000 Paul Kienzle\n## SHADE\n1;\n' },
      { 'lib/shade.m': SHADE },
    ];
    const run = await syncedAndFreshEachStep({ 'user.m': 'function user()\n  shade\n  x = 2;\nend\n', 'lib/shade.m': SHADE }, ...steps);
    expectEachStepFresh(run, steps);
    // The rule bites: the script answers the call, the binary keeps no row of it.
    expect(run[1]!.synced).toEqual(['user.m user -calls-> lib/shade.m @ lib/shade.m']);
    expect(run[0]!.syncedRows).toEqual([]);
  }, 180_000);

  // Added or deleted, the same carrier is followed for a bare read and a
  // dispatched call: their rows sleep while nothing carries the name, and
  // wake when a sync gives it a carrier. A built-in's own call is followed
  // by extracting its files again.
  it('a sync ends where a fresh index ends when it adds or deletes the only carrier of a bare read or of a dispatched built-in\'s name', async () => {
    const steps: Array<Record<string, string | null>> = [
      { 'blob/color.m': COLOR },
      { 'blob/color.m': null },
      { 'EPICS/datestr.m': MATLAB },
      { 'EPICS/datestr.m': null },
    ];
    const run = await syncedAndFreshEachStep(CARRIED, ...steps);
    expectEachStepFresh(run, steps);
    // The untouched caller's bare read links to the function added, and
    // sleeps again when it goes; the dispatched call wakes while the `.m`
    // file carries its name, and sleeps again when it goes.
    expect(run[0]!.synced).toContain('user.m user -calls-> color @ blob/color.m');
    expect(run[1]!.syncedDormant).toEqual(['user.m:3 calls:EPICS2MatlabTime::datestr', 'user.m:4 calls:color']);
    expect(run[2]!.synced).toContain('user.m user -calls-> datestr @ EPICS/datestr.m');
    expect(run[2]!.syncedDormant).toEqual(['user.m:4 calls:color']);
    expect(run[3]!.syncedRows).toEqual([]);
    expect(run[3]!.syncedDormant).toContain('user.m:3 calls:EPICS2MatlabTime::datestr');
  }, 180_000);
});

describe('MATLAB sync converges on a fresh index for stubs, the help text of a MEX function', () => {
  // A call of a stub's name nothing else answers links to the stub's file:
  // each step of each sequence ends with the edges, live rows and dormant
  // rows a fresh index of the same files has.
  const HELP = '% MEXF  help for a MEX function\n%   v = mexf(pv)\n';
  const FUNCTION = 'function v = mexf(pv)\nv = pv;\nend\n';
  const OCTAVE = '## Copyright (C) 2000 Paul Kienzle\n## MEXF\n1;\n';
  const expectEachStepFresh = (run: Awaited<ReturnType<typeof syncedAndFreshEachStep>>, steps: Array<Record<string, string | null>>): void => {
    run.forEach((step, i) => {
      const what = `step ${i} ${JSON.stringify(steps[i])}`;
      expect(step.synced, `${what} edges`).toEqual(step.fresh);
      expect(step.syncedRows, `${what} rows`).toEqual(step.freshRows);
      expect(step.syncedDormant, `${what} dormant rows`).toEqual(step.freshDormant);
    });
  };
  const MAIN = 'function main(pv)\nv = mexf(pv);\nmexf\nend\n';
  const TO = (file: string): string[] => [`app/main.m main -calls-> ${file} @ ${file}`, `app/main.m main -calls-> ${file} @ ${file}`];

  it('when a function file becomes help text only, and back', async () => {
    const steps = [{ 'lib/mexf.m': HELP }, { 'lib/mexf.m': FUNCTION }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'lib/mexf.m': FUNCTION }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(TO('lib/mexf.m'));
    expect(run[1]!.synced).toEqual(['app/main.m main -calls-> mexf @ lib/mexf.m', 'app/main.m main -calls-> mexf @ lib/mexf.m']);
  }, 120_000);

  it('when a script becomes help text only, and back: the statement stays, the call with arguments comes and goes', async () => {
    const steps = [{ 'lib/mexf.m': HELP }, { 'lib/mexf.m': 'disp(1);\n' }, { 'lib/mexf.m': HELP }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'lib/mexf.m': 'disp(1);\n' }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(TO('lib/mexf.m'));
    expect(run[1]!.synced).toEqual(['app/main.m main -calls-> lib/mexf.m @ lib/mexf.m']);
  }, 120_000);

  it('when a stub that answered a statement before a farther function becomes a script, and back', async () => {
    // The script, nearer, runs the statement; as help text, the farther function answers both calls.
    const steps = [{ 'app/mexf.m': HELP }, { 'app/mexf.m': 'disp(1);\n' }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'app/mexf.m': 'disp(1);\n', 'lib/mexf.m': FUNCTION }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(['app/main.m main -calls-> mexf @ lib/mexf.m', 'app/main.m main -calls-> mexf @ lib/mexf.m']);
    expect(run[1]!.synced).toEqual(['app/main.m main -calls-> app/mexf.m @ app/mexf.m', 'app/main.m main -calls-> mexf @ lib/mexf.m']);
  }, 120_000);

  it('when a nearer function of the name is added and removed while a stub exists, and a farther one too', async () => {
    const steps = [{ 'app/mexf.m': FUNCTION }, { 'app/mexf.m': null }, { 'other/mexf.m': FUNCTION }, { 'other/mexf.m': null }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'lib/mexf.m': HELP }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(['app/main.m main -calls-> mexf @ app/mexf.m', 'app/main.m main -calls-> mexf @ app/mexf.m']);
    expect(run[1]!.synced).toEqual(TO('lib/mexf.m'));
    expect(run[2]!.synced).toEqual(['app/main.m main -calls-> mexf @ other/mexf.m', 'app/main.m main -calls-> mexf @ other/mexf.m']);
    expect(run[3]!.synced).toEqual(TO('lib/mexf.m'));
  }, 180_000);

  it('when a stub is deleted and added back', async () => {
    const steps = [{ 'lib/mexf.m': null }, { 'lib/mexf.m': HELP }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'lib/mexf.m': HELP }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual([]);
    expect(run[1]!.synced).toEqual(TO('lib/mexf.m'));
  }, 120_000);

  it('when a stub with a farther copy goes to Octave and back, and to a function and back, and from Octave to a function', async () => {
    const steps = [
      { 'app/mexf.m': OCTAVE }, { 'app/mexf.m': HELP }, { 'app/mexf.m': FUNCTION }, { 'app/mexf.m': HELP },
      { 'app/mexf.m': OCTAVE }, { 'app/mexf.m': FUNCTION }, { 'app/mexf.m': OCTAVE },
    ];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'app/mexf.m': HELP, 'lib/mexf.m': HELP }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(TO('lib/mexf.m'));
    expect(run[1]!.synced).toEqual(TO('app/mexf.m'));
    expect(run[3]!.synced).toEqual(TO('app/mexf.m'));
    // The nearer file turns from Octave into a function: it takes the calls the farther stub answered.
    expect(run[5]!.synced).toEqual(['app/main.m main -calls-> mexf @ app/mexf.m', 'app/main.m main -calls-> mexf @ app/mexf.m']);
    expect(run[6]!.synced).toEqual(TO('lib/mexf.m'));
  }, 240_000);

  it('when a nearer Octave file of the name becomes a function while a farther script answers the statement', async () => {
    const steps = [{ 'app/mexf.m': FUNCTION }, { 'app/mexf.m': OCTAVE }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'app/mexf.m': OCTAVE, 'lib/mexf.m': 'disp(1);\n' }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toEqual(['app/main.m main -calls-> mexf @ app/mexf.m', 'app/main.m main -calls-> mexf @ app/mexf.m']);
    expect(run[1]!.synced).toEqual(['app/main.m main -calls-> lib/mexf.m @ lib/mexf.m']);
  }, 120_000);

  it('when a class an object of is passed gains a method named like the stub, and loses it', async () => {
    const CLS = 'classdef Cls\n  methods\n    function obj = Cls()\n    end\n  end\nend\n';
    const WITH = 'classdef Cls\n  methods\n    function obj = Cls()\n    end\n    function r = mexf(obj, x)\n      r = x;\n    end\n  end\nend\n';
    const main = 'function main\nobj = Cls();\nv = mexf(obj, 1);\nend\n';
    const steps = [{ 'app/Cls.m': WITH }, { 'app/Cls.m': CLS }];
    const run = await syncedAndFreshEachStep({ 'app/main.m': main, 'app/Cls.m': CLS, 'lib/mexf.m': HELP }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced).toContain('app/main.m main -calls-> Cls::mexf @ app/Cls.m');
    expect(run[1]!.synced).toContain('app/main.m main -calls-> lib/mexf.m @ lib/mexf.m');
  }, 120_000);

  it('when a nearer file of the name in another case is added and removed: it vetoes a stub and a function alike', async () => {
    const steps = [{ 'app/Mexf.m': 'function v = Mexf(pv)\nv = pv;\nend\n' }, { 'app/Mexf.m': null }, { 'app/MEXF.m': HELP }, { 'app/MEXF.m': null }];
    for (const target of [HELP, FUNCTION]) {
      const run = await syncedAndFreshEachStep({ 'app/main.m': MAIN, 'lib/mexf.m': target }, ...steps);
      expectEachStepFresh(run, steps);
      const linked = target === HELP ? TO('lib/mexf.m') : ['app/main.m main -calls-> mexf @ lib/mexf.m', 'app/main.m main -calls-> mexf @ lib/mexf.m'];
      expect(run.map((step) => step.synced.filter((e) => e.startsWith('app/main.m')))).toEqual([[], linked, [], linked]);
    }
  }, 240_000);

  it('when a farther function with more than 500 statement calls loses one to a nearer help text that becomes a script', async () => {
    // 520 statements in lib/ take the function beside them; the one in app/ takes the nearer script.
    const gen: Record<string, string> = {};
    for (let i = 1; i <= 26; i++) gen[`lib/gen/g${i}.m`] = `function g${i}\n${'mexf\n'.repeat(20)}end\n`;
    const steps = [{ 'app/mexf.m': 'disp(2);\n' }, { 'app/mexf.m': HELP }];
    const run = await syncedAndFreshEachStep({ ...gen, 'app/main.m': 'function main\nmexf\nend\n', 'app/mexf.m': HELP, 'lib/mexf.m': FUNCTION }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run[0]!.synced.filter((e) => e.startsWith('app/main.m'))).toEqual(['app/main.m main -calls-> app/mexf.m @ app/mexf.m']);
    expect(run[0]!.synced.filter((e) => e.endsWith('@ lib/mexf.m'))).toHaveLength(520);
    expect(run[1]!.synced.filter((e) => e.startsWith('app/main.m'))).toEqual(['app/main.m main -calls-> mexf @ lib/mexf.m']);
  }, 180_000);

  it('when a nearer file of the name in another case vetoes more than 500 calls, and is removed', async () => {
    // 520 calls the variant vetoes go failed, and every one links again once it is gone.
    const gen: Record<string, string> = {};
    for (let i = 1; i <= 26; i++) gen[`app/gen/g${i}.m`] = `function g${i}\n${'v = mexf(1);\n'.repeat(20)}end\n`;
    const steps = [{ 'app/gen/Mexf.m': 'function v = Mexf(pv)\nv = pv;\nend\n' }, { 'app/gen/Mexf.m': null }];
    for (const target of [HELP, FUNCTION]) {
      const run = await syncedAndFreshEachStep({ ...gen, 'lib/mexf.m': target }, ...steps);
      expectEachStepFresh(run, steps);
      expect(run[0]!.synced.filter((e) => e.includes('lib/mexf.m'))).toHaveLength(0);
      expect(run[1]!.synced.filter((e) => e.includes('lib/mexf.m'))).toHaveLength(520);
    }
  }, 240_000);
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
    const freshRoot = tempDir('cg-matlab-recover-fresh-');
    const root = tempDir('cg-matlab-recover-');
    try {
      writeTree(freshRoot, files);
      (await CodeGraph.init(freshRoot, { index: true })).close();
      const fresh = rows(freshRoot);
      // A call written with arguments that resolves to nothing stays; the bare
      // reads and the member call nothing defines are kept dormant.
      expect(fresh).toEqual([
        'helper.m:2 nope_read dormant',
        'main.m:2 cfg dormant',
        'main.m:4 missing_fn failed',
        'main.m:5 a.field dormant',
      ]);

      writeTree(root, files);
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
    const root = tempDir('cg-matlab-objc-sync-');
    writeTree(root, {
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
      writeTree(root, { 'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n    [self stop];\n}\n- (void)stop {\n}\n@end\n' });
      await cg.sync();
      expect(calls).toEqual([]);
      writeTree(root, { 'setup_paths.m': 'addpath(pwd);\ndisp(1);\n', 'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n@end\n' });
      await cg.sync();
      expect(calls.map(([matlabFiles, changed]) => [matlabFiles, [...(changed as string[])].sort()])).toEqual([
        [['setup_paths.m'], ['objc/Thing.m', 'setup_paths.m']],
      ]);
      expect(allEdges(cg).filter((e) => e.startsWith('main.m '))).toEqual(['main.m main -calls-> setup_paths.m @ setup_paths.m']);
      // The script re-read as Objective-C: the MATLAB call into it still has
      // to go, though the file is no MATLAB file any more. A file stored in
      // another language takes every edge into it back to its reference when
      // it is stored, so none is left for the scripts pass to settle.
      calls.length = 0;
      writeTree(root, { 'setup_paths.m': '#import <Foundation/Foundation.h>\n@implementation Setup\n- (void)go {\n}\n@end\n' });
      await cg.sync();
      expect(cg.getFiles().find((f) => f.path === 'setup_paths.m')?.language).toBe('objc');
      expect(allEdges(cg).filter((e) => e.startsWith('main.m '))).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB sync follows a change in what a file defines, though its names stay', () => {
  const expectEachStepFresh = (run: Awaited<ReturnType<typeof syncedAndFreshEachStep>>, steps: Array<Record<string, string | null>>): void => {
    run.forEach((step, i) => {
      const what = `step ${i} ${JSON.stringify(Object.keys(steps[i]!))}`;
      expect(step.synced, `${what} edges`).toEqual(step.fresh);
      expect(step.syncedRows, `${what} rows`).toEqual(step.freshRows);
      expect(step.syncedDormant, `${what} dormant rows`).toEqual(step.freshDormant);
    });
  };

  it('when a function file with more than 500 callers becomes a script, and back, and is deleted and added back: every caller moves to the farther copy and returns', async () => {
    // 26 files of 21 calls each (546, past the rebind's per-name ceiling of 500)
    // reach app/drift.m; a statement put before its function line makes the
    // function local, out of every other file's reach, and the farther
    // lib/old/drift.m answers them (a script with local functions counts as no
    // script: step 2); taking the statement out brings every one back. So do
    // deleting the file and adding it back.
    const DRIFT = 'function y = drift(x)\ny = x;\nend\n';
    const gen: Record<string, string> = {};
    for (let i = 1; i <= 26; i++) gen[`app/gen/g${i}.m`] = `function g${i}\n${'v = drift(1);\n'.repeat(21)}end\n`;
    const steps = [{ 'app/drift.m': `x = 1;\n${DRIFT}` }, { 'app/drift.m': DRIFT }, { 'app/drift.m': null }, { 'app/drift.m': DRIFT }];
    const run = await syncedAndFreshEachStep({ ...gen, 'app/drift.m': DRIFT, 'lib/old/drift.m': 'function y = drift(x)\ny = 2 * x;\nend\n' }, ...steps);
    expectEachStepFresh(run, steps);
    const into = (step: { synced: string[] }, file: string) => step.synced.filter((e) => e.endsWith(`-calls-> drift @ ${file}`));
    expect(run.map((step) => [into(step, 'app/drift.m').length, into(step, 'lib/old/drift.m').length])).toEqual([[0, 546], [546, 0], [0, 546], [546, 0]]);
  }, 240_000);

  /** `n` files `dir/<stem><i>.m`, each a function of `calls` lines `line`. */
  const callers = (dir: string, stem: string, n: number, calls: number, line: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < n; i++) out[`${dir}/${stem}${i}.m`] = `function ${stem}${i}(p)\n${line.repeat(calls)}end\n`;
    return out;
  };
  /** How many synced calls end at `target` (`A::reset @ A.m`). */
  const into = (step: { synced: string[] }, target: string) => step.synced.filter((e) => e.endsWith(` -calls-> ${target}`)).length;

  it('when a method other classes also define turns static and back, more than 500 calls on a parameter link to the one class left and go again', async () => {
    // `p.reset()` on a parameter of no stated class links only when one class
    // defines a non-static `reset` (matlab-dispatch.test.ts, step 9): 600 such
    // calls are ambiguous while A and B both do, and link to A's while B's is static.
    const B = (attrs: string) => `classdef B\n    methods${attrs}\n        function r = reset(obj)\n            r = 2;\n        end\n    end\nend\n`;
    const steps = [{ 'B.m': B(' (Static)') }, { 'B.m': B('') }];
    const run = await syncedAndFreshEachStep({
      ...callers('app', 'u', 30, 20, 'p.reset();\n'),
      'A.m': 'classdef A\n    methods\n        function r = reset(obj)\n            r = 1;\n        end\n    end\nend\n',
      'B.m': B(''),
    }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => into(step, 'A::reset @ A.m'))).toEqual([600, 0]);
  }, 120_000);

  it('when a static method with more than 500 calls gains a second definition of its name in its class, and loses it, every call fails and links again', async () => {
    // Two methods of one name in a class leave its call failed, as for
    // fuzz/call-kept-into-duplicate-method (MATLAB rejects such a class).
    const UTIL = (extra: string) => `classdef Util\n    methods (Static)\n        function r = go(x)\n            r = x;\n        end\n${extra}    end\nend\n`;
    const steps = [{ 'Util.m': UTIL('        function r = go(x, y)\n            r = y;\n        end\n') }, { 'Util.m': UTIL('') }];
    const run = await syncedAndFreshEachStep({ ...callers('app', 'c', 30, 20, 'Util.go(1);\n'), 'Util.m': UTIL('') }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => into(step, 'Util::go @ Util.m'))).toEqual([0, 600]);
  }, 120_000);

  it('when a method turns into a property of the same name and back, more than 500 guessed calls of it on a parameter in another class go and return', async () => {
    // `A.reset()` on a capitalised parameter is taken for an A, with two
    // classes defining `reset`, unless a class has a property `reset` (step 9;
    // dispatch/receiver-guess-blocked-by-property-sync): C.m keeps its names,
    // only the kind of its `reset` changes, and the edges end in A.m.
    const cls = (name: string, body: string) => `classdef ${name}\n${body}end\n`;
    const METHOD = '    methods\n        function r = reset(obj)\n            r = 1;\n        end\n    end\n';
    const steps = [{ 'C.m': cls('C', '    properties\n        reset = 1;\n    end\n') }, { 'C.m': cls('C', METHOD) }];
    const gen: Record<string, string> = {};
    for (let i = 0; i < 30; i++) gen[`app/u${i}.m`] = `function u${i}(A)\n${'A.reset();\n'.repeat(20)}end\n`;
    const run = await syncedAndFreshEachStep({ ...gen, 'A.m': cls('A', METHOD), 'C.m': cls('C', METHOD) }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => into(step, 'A::reset @ A.m'))).toEqual([0, 600]);
  }, 120_000);

  it('when a class folder\'s classdef turns into an old-style constructor and back, more than 500 reads of the class\'s name on its objects go and return', async () => {
    // The resolver links `obj.widget` in a method of a classdef class to its
    // constructor, and an old-style object is a struct, whose member is a
    // field (class-folders/classdef-to-old-style-member-reads-sync): only the
    // classdef flag of `widget` changes, and the edges end at its own node.
    const CLASSDEF = 'classdef widget\n    methods\n        function obj = widget()\n        end\n    end\nend\n';
    const steps = [{ '@widget/widget.m': "function obj = widget()\nobj = class(struct(), 'widget');\nend\n" }, { '@widget/widget.m': CLASSDEF }];
    const gen: Record<string, string> = {};
    for (let i = 0; i < 30; i++) gen[`@widget/peek${i}.m`] = `function peek${i}(obj)\n${'v = obj.widget;\n'.repeat(20)}end\n`;
    const run = await syncedAndFreshEachStep({ ...gen, '@widget/widget.m': CLASSDEF }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => into(step, 'widget::widget @ @widget/widget.m'))).toEqual([0, 600]);
  }, 120_000);

  it('when a package function with more than 500 callers is made local, and back, every call goes and returns', async () => {
    // `pkg.tool(1)` reaches +pkg/tool.m's main function by its full name
    // (MATLAB doc 'Packages Create Namespaces'); behind a statement it is a
    // script's local function, which no other file reaches ('Local Functions').
    const TOOL = 'function r = tool(x)\nr = x;\nend\n';
    const steps = [{ '+pkg/tool.m': `x = 1;\n${TOOL}` }, { '+pkg/tool.m': TOOL }];
    const run = await syncedAndFreshEachStep({ ...callers('app', 'q', 30, 20, 'pkg.tool(1);\n'), '+pkg/tool.m': TOOL }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => into(step, 'pkg::tool @ +pkg/tool.m'))).toEqual([0, 600]);
  }, 120_000);

  it('when a function file with more than 500 callers is made local or broken, and back, with a farther script or stub of its name', async () => {
    // Made local (a statement before the function line) or unreadable (a stray
    // `end` there), app/ramp.m answers no other file. A farther script answers
    // the statements alone (`ramp;`: matlab-lookup.ts step 7), a call with
    // arguments never running a script; a farther stub, help text of a MEX
    // function, answers both forms (its step 8).
    const RAMP = 'function y = ramp(x)\ny = x;\nend\n';
    const gen = callers('app', 'g', 30, 10, 'ramp;\nv = ramp(1);\n');
    const toScript = [{ 'app/ramp.m': `x = 1;\n${RAMP}` }, { 'app/ramp.m': RAMP }, { 'app/ramp.m': `end\n${RAMP}` }, { 'app/ramp.m': RAMP }];
    const script = await syncedAndFreshEachStep({ ...gen, 'app/ramp.m': RAMP, 'lib/old/ramp.m': 'a = 1;\nb = 2;\n' }, ...toScript);
    expectEachStepFresh(script, toScript);
    expect(script.map((step) => [into(step, 'ramp @ app/ramp.m'), into(step, 'lib/old/ramp.m @ lib/old/ramp.m')])).toEqual([[0, 300], [600, 0], [0, 300], [600, 0]]);
    const toStub = [{ 'app/ramp.m': `x = 1;\n${RAMP}` }, { 'app/ramp.m': RAMP }];
    const stub = await syncedAndFreshEachStep({ ...gen, 'app/ramp.m': RAMP, 'lib/old/ramp.m': '% RAMP help text of a MEX function\n' }, ...toStub);
    expectEachStepFresh(stub, toStub);
    expect(stub.map((step) => [into(step, 'ramp @ app/ramp.m'), into(step, 'lib/old/ramp.m @ lib/old/ramp.m')])).toEqual([[0, 600], [600, 0]]);
  }, 120_000);

  it('a local function of a name more than 500 calls reach, each in its own file, added to one more file and removed: the rebind re-opens none of those calls', async () => {
    // A file's own local function comes before anything on the path and no
    // other file reaches it (MATLAB doc 'Function Precedence Order', 'Local
    // Functions'): a copy added or removed elsewhere moves none of those calls.
    const gen: Record<string, string> = {};
    for (let i = 0; i < 30; i++) gen[`app/w${i}.m`] = `function w${i}()\n${'common_helper(1);\n'.repeat(25)}end\nfunction common_helper(x)\nend\n`;
    const steps = [{ 'app/z.m': 'function z()\nend\nfunction common_helper(x)\nend\n' }, { 'app/z.m': 'function z()\nend\n' }];
    const rebind = vi.spyOn(ExtractionOrchestrator.prototype, 'resurrectStaleResolutionEdges');
    try {
      const run = await syncedAndFreshEachStep({ ...gen, 'app/z.m': 'function z()\nend\n' }, ...steps);
      expectEachStepFresh(run, steps);
      expect(run.map((step) => step.synced.filter((e) => / -calls-> common_helper @ /.test(e)).length)).toEqual([750, 750]);
      // Both syncs rebound `common_helper` (a definition of it came and went), and re-opened no edge.
      expect(rebind.mock.calls.map(([names, , , relinked]) => [names, relinked])).toEqual([[['common_helper'], ['common_helper']], [['common_helper'], ['common_helper']]]);
      expect(rebind.mock.results.map((r) => r.value)).toEqual([0, 0]);
    } finally {
      rebind.mockRestore();
    }
  }, 120_000);

  it('a local function more than 500 calls reach in a file that imports the name: a package function of it added and removed takes every call and gives it back', async () => {
    // An explicitly imported name comes before a local function (MATLAB doc
    // 'Function Precedence Order'): `import pkg.helper` hands `helper(1)` to
    // +pkg/helper.m once it exists, and back to the local function without it.
    const gen: Record<string, string> = {};
    for (let i = 0; i < 24; i++) gen[`app/m${i}.m`] = `function m${i}()\nimport pkg.helper\n${'helper(1);\n'.repeat(25)}end\nfunction helper(x)\nend\n`;
    const steps = [{ '+pkg/helper.m': 'function helper(x)\nend\n' }, { '+pkg/helper.m': null }];
    const run = await syncedAndFreshEachStep({ ...gen, 'app/other.m': 'function other()\nend\n' }, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((step) => [into(step, 'pkg::helper @ +pkg/helper.m'), step.synced.filter((e) => /^app\/(m\d+)\.m \1 -calls-> helper @ app\/\1\.m$/.test(e)).length])).toEqual([[600, 0], [0, 600]]);
  }, 120_000);

  it('a function file whose main function is renamed inside the file, or whose body changes, keeps an empty definition delta', async () => {
    const root = tempDir('cg-matlab-delta-');
    writeTree(root, {
      'tools/scale.m': 'function y = scale(x)\ny = 2 * x;\nend\nfunction z = helper(x)\nz = x;\nend\n',
      'user.m': 'function user()\ny = scale(2);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const edges = allEdges(cg);
      expect(edges).toContain('user.m user -calls-> scale @ tools/scale.m');
      // MATLAB goes by the file's name: the declared name is the signature's alone.
      writeTree(root, { 'tools/scale.m': 'function y = resize(x)\ny = 2 * x;\nend\nfunction z = helper(x)\nz = x;\nend\n' });
      const renamed = await cg.sync();
      expect(renamed.filesModified).toBe(1);
      expect(renamed.definitionDelta).toBeUndefined();
      expect(renamed.matlabRelinked).toBeUndefined();
      writeTree(root, { 'tools/scale.m': 'function y = resize(x)\n% scaled\nk = 3;\ny = k * x;\nend\nfunction z = helper(x)\nz = -x;\nend\n' });
      const body = await cg.sync();
      expect(body.filesModified).toBe(1);
      expect(body.definitionDelta).toBeUndefined();
      expect(body.matlabRelinked).toBeUndefined();
      expect(allEdges(cg)).toEqual(edges);
      // A statement before the function line: the same names, the function local now.
      writeTree(root, { 'tools/scale.m': 'k = 3;\nfunction y = scale(x)\ny = 2 * x;\nend\nfunction z = helper(x)\nz = x;\nend\n' });
      const script = await cg.sync();
      expect(script.definitionDelta).toEqual(['scale']);
      expect(script.matlabRelinked).toEqual(['scale']);
      expect(allEdges(cg).filter((e) => e.startsWith('user.m '))).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a sync of a project with no MATLAB file reads no MATLAB definition facts', async () => {
    const root = tempDir('cg-objc-delta-');
    writeTree(root, {
      'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n}\n@end\n',
      'objc/Thing.h': '#import <Foundation/Foundation.h>\n@interface Thing : NSObject\n- (void)go;\n@end\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const queries = (cg as unknown as { queries: { getNodeFactPairsByFiles: (...a: unknown[]) => Set<string> } }).queries;
      const calls: unknown[][] = [];
      const read = queries.getNodeFactPairsByFiles.bind(queries);
      queries.getNodeFactPairsByFiles = (...a: unknown[]) => {
        calls.push(a);
        return read(...a);
      };
      writeTree(root, { 'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n    [self stop];\n}\n- (void)stop {\n}\n@end\n' });
      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
