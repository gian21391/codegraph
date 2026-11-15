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
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { allEdges, syncedAndFresh, syncedAndFreshEachStep, tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

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
  // function (`input.m`, comments only) and a script (`now.m`) still do.
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
