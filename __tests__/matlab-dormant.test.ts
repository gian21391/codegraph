/**
 * MATLAB dormant rows: a call no symbol answers now (a bare read, a command,
 * a name made at runtime, `T::size` dispatched under a built-in's name, a
 * member call or read) is kept as a dormant row, which no reader counts, and
 * a sync that gives its name a carrier wakes it, wherever it is; one that
 * takes the last carrier away puts the failed rows to sleep. Every step of
 * every sequence here ends where a fresh index of the same files ends:
 * edges, live rows and dormant rows. Through one long-lived CodeGraph (the
 * watcher, the MCP server) and through one opened per sync (the CLI).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { buildFileCode } from '../src/ui-server/api/filecode';
import { buildNode } from '../src/ui-server/api/node';
import { buildSteps } from '../src/ui-server/api/steps';
import { ExtractionOrchestrator } from '../src/extraction';
import { ReferenceResolver } from '../src/resolution';
import { MATLAB_SCRIPT_MAX_BYTES, MATLAB_SCRIPT_RUN_DEPTH, MatlabScriptMemo, settleMatlabScriptWorkspaces } from '../src/resolution/matlab-script-workspace';
import { MATLAB_CARRIER_INPUTS_KEY, MATLAB_CARRIER_STEP_KEY } from '../src/resolution/matlab-builtin-carriers';
import {
  allEdges, dormantRows, indexOfProject, syncedAndFreshEachStep, tempDir, unresolvedRows, useAllGrammars, writeTree, type SyncedStep,
} from './matlab-helpers';

useAllGrammars();

type Files = Record<string, string | null>;

/** {@link syncedAndFreshEachStep} with a CodeGraph opened for each sync and closed after it, as the CLI's `codegraph sync` does. */
async function reopenedEachStep(initial: Record<string, string>, ...steps: Files[]): Promise<SyncedStep[]> {
  const root = tempDir('cg-matlab-dormant-cli-');
  const current: Files = { ...initial };
  try {
    writeTree(root, initial);
    (await CodeGraph.init(root, { index: true })).close();
    const out: SyncedStep[] = [];
    for (const step of steps) {
      writeTree(root, step);
      Object.assign(current, step);
      const cg = await CodeGraph.open(root);
      let synced: string[];
      try {
        await cg.sync();
        synced = allEdges(cg);
      } finally {
        cg.close();
      }
      const fresh = await indexOfProject(Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)) as Record<string, string>);
      out.push({
        synced, fresh: fresh.edges,
        syncedRows: unresolvedRows(root), freshRows: fresh.unresolved,
        syncedDormant: dormantRows(root), freshDormant: fresh.dormant,
      });
    }
    return out;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectEachStepFresh(run: SyncedStep[], steps: Files[]): void {
  run.forEach((step, i) => {
    const what = `step ${i} ${JSON.stringify(steps[i])}`.slice(0, 200);
    expect(step.synced, `${what}: edges`).toEqual(step.fresh);
    expect(step.syncedRows, `${what}: live rows`).toEqual(step.freshRows);
    expect(step.syncedDormant, `${what}: dormant rows`).toEqual(step.freshDormant);
  });
}

/** Both ways of syncing, each step against a fresh index. */
async function expectSyncsFresh(initial: Record<string, string>, steps: Files[]): Promise<SyncedStep[]> {
  const live = await syncedAndFreshEachStep(initial, ...steps);
  expectEachStepFresh(live, steps);
  const cli = await reopenedEachStep(initial, ...steps);
  expectEachStepFresh(cli, steps);
  return live;
}

const COLOR_BLOB = 'Z9QPK7731TRW2200QXV0011y\u0001\u0000\u0000KÊ^\nÆ}R';
const OCTAVE = '## Copyright (C) 2031 A. Author\n## -*- texinfo -*-\nfunction r = color()\n  r = 1;\nendfunction\n';
const cls = (name: string, body: string): string => `classdef ${name} < handle\n${body}end\n`;
const methods = (...names: string[]): string => `    methods\n${names.map((n) => `        function r = ${n}(obj, varargin)\n            r = 1;\n        end\n`).join('')}    end\n`;
const props = (...names: string[]): string => `    properties\n${names.map((n) => `        ${n}\n`).join('')}    end\n`;

/** One untouched caller of every class a dormant row is kept for. */
const USER = [
  'function user(a)',
  'c = color;', // bare read
  'setup_cfg', // command
  "load('data.mat', 'vv');",
  'q = vv(3);', // a name `load` made: runtime
  'k = Acc();',
  'n = size(k, 2);', // `Acc::size`, dispatched under a built-in's name
  'r = a.recalib(2);', // member call
  'mm = Model();',
  't = mm.Total;', // member read: only a callable symbol answers it
  'end',
  '',
].join('\n');
const BASE = {
  'user.m': USER,
  'Acc.m': cls('Acc', methods('go')),
  'Model.m': cls('Model', methods('reset')),
};

describe('MATLAB dormant rows: a fresh index keeps one for each class nothing answers', () => {
  it('keeps the bare read, the command, the runtime name, the dispatched call and both member calls dormant, and counts none', async () => {
    const r = await indexOfProject(BASE);
    expect(r.dormant).toEqual([
      'user.m:10 calls:Model::Total',
      'user.m:2 calls:color',
      'user.m:3 calls:setup_cfg',
      'user.m:5 calls:vv',
      'user.m:7 calls:Acc::size',
      'user.m:8 calls:a.recalib',
    ]);
    expect(r.unresolved).toEqual([]);
  });

  it('stores each under its tail, the key a sync looks it up by', async () => {
    const root = tempDir('cg-matlab-dormant-tail-');
    try {
      writeTree(root, BASE);
      (await CodeGraph.init(root, { index: true })).close();
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        const rows = db.getDb().prepare("SELECT reference_name AS n, name_tail AS t FROM unresolved_refs WHERE status = 'dormant' ORDER BY line").all() as Array<{ n: string; t: string }>;
        expect(rows.map((x) => `${x.n}>${x.t}`)).toEqual(['color>color', 'setup_cfg>setup_cfg', 'vv>vv', 'Acc::size>size', 'a.recalib>recalib', 'Model::Total>Total']);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB dormant rows: a sync ends where a fresh index ends, for every class', () => {
  it('a bare read: its function added, deleted, restored, renamed, moved, turned to binary and Octave text and back', async () => {
    const COLOR = 'function c = color()\nc = [1 0 0];\nend\n';
    const steps: Files[] = [
      { 'lib/color.m': COLOR },
      { 'lib/color.m': null },
      { 'lib/color.m': COLOR },
      { 'lib/color.m': null, 'lib/colour.m': COLOR.replace('color()', 'colour()') }, // renamed: no carrier
      { 'lib/colour.m': null, 'lib/color.m': COLOR }, // and back
      { 'lib/color.m': null, 'other/color.m': COLOR }, // moved
      { 'other/color.m': COLOR_BLOB },
      { 'other/color.m': COLOR },
      { 'other/color.m': OCTAVE },
      { 'other/color.m': COLOR },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.synced.some((e) => e === 'user.m user -calls-> color @ lib/color.m' || e === 'user.m user -calls-> color @ other/color.m')))
      .toEqual([true, false, true, false, true, true, false, true, false, true]);
  }, 600_000);

  it('a bare read: a symbol of another kind or language carrying the name, added and removed', async () => {
    const steps: Files[] = [
      { 'Thing.m': cls('Thing', props('color') + methods('go')) }, // a MATLAB property
      { 'Thing.m': null },
      { 'tools/paint.py': 'def color():\n    return 1\n' }, // a Python function
      { 'tools/paint.py': null },
      { 'web/paint.js': 'export function color() { return 1; }\n' },
      { 'web/paint.js': 'export function hue() { return 1; }\n' },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    // Carried, the row is live (failed); not, it sleeps.
    expect(run.map((s) => s.syncedRows.includes('user.m:2 calls:color'))).toEqual([true, false, true, false, true, false]);
    expect(run.map((s) => s.syncedDormant.includes('user.m:2 calls:color'))).toEqual([false, true, false, true, false, true]);
  }, 600_000);

  it('a command: its script added, deleted, restored, renamed and turned to Octave text and back', async () => {
    const SCRIPT = '% SETUP_CFG\nx = 1;\n';
    const steps: Files[] = [
      { 'setup_cfg.m': SCRIPT },
      { 'setup_cfg.m': null },
      { 'setup_cfg.m': SCRIPT },
      { 'setup_cfg.m': null, 'setup_conf.m': SCRIPT },
      { 'setup_conf.m': null, 'setup_cfg.m': '## Copyright (C) 2031 A. Author\n## SETUP_CFG\n1;\n' },
      { 'setup_cfg.m': SCRIPT },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.synced.includes('user.m user -calls-> setup_cfg.m @ setup_cfg.m'))).toEqual([true, false, true, false, false, true]);
  }, 600_000);

  it('a name made at runtime: a function of the name added, deleted and restored', async () => {
    const VV = 'function y = vv(i)\ny = i;\nend\n';
    const steps: Files[] = [{ 'vv.m': VV }, { 'vv.m': null }, { 'vv.m': VV }, { 'vv.m': VV + '% edited\n' }];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.syncedDormant.includes('user.m:5 calls:vv'))).toEqual([false, true, false, false]);
  }, 600_000);

  it('a call dispatched under a built-in\'s name: another language\'s symbol of the name added, renamed and removed', async () => {
    const steps: Files[] = [
      { 'tools/shape.py': 'def size():\n    return 1\n' },
      { 'tools/shape.py': 'def area():\n    return 1\n' },
      { 'tools/shape.py': 'def size():\n    return 1\n' },
      { 'tools/shape.py': null },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.syncedDormant.includes('user.m:7 calls:Acc::size'))).toEqual([false, true, false, true]);
  }, 600_000);

  it('a member call: its method added, renamed, moved to another class file, and removed', async () => {
    const steps: Files[] = [
      { 'Model.m': cls('Model', methods('reset', 'recalib')) },
      { 'Model.m': cls('Model', methods('reset', 'recal')) },
      { 'Model.m': cls('Model', methods('reset', 'recalib')) },
      { 'Model.m': null, 'models/Model.m': cls('Model', methods('reset', 'recalib')) },
      { 'models/Model.m': cls('Model', methods('reset')) },
      // A property carries no member call written with arguments: `a.recalib(2)` indexes it.
      { 'models/Model.m': cls('Model', props('recalib') + methods('reset')) },
      { 'models/Model.m': null },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('user.m user -calls-> Model::recalib')))).toEqual([true, false, true, true, false, false, false]);
    expect(run.map((s) => s.syncedDormant.includes('user.m:8 calls:a.recalib'))).toEqual([false, true, false, false, true, true, true]);
  }, 600_000);

  it('a member read: a property of the name does not wake it, a method does, and a JavaScript function never', async () => {
    const steps: Files[] = [
      { 'Model.m': cls('Model', props('Total') + methods('reset')) },
      { 'Model.m': cls('Model', methods('reset', 'Total')) },
      { 'Model.m': cls('Model', props('Total') + methods('reset')) },
      { 'web/total.js': 'export function Total() { return 1; }\n' },
      { 'Model.m': cls('Model', methods('reset')) },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.syncedDormant.includes('user.m:10 calls:Model::Total'))).toEqual([true, false, true, true, true]);
  }, 600_000);

  it('several changes in one sync, of every class at once, and back', async () => {
    const steps: Files[] = [
      {
        'lib/color.m': 'function c = color()\nc = 1;\nend\n',
        'setup_cfg.m': 'x = 1;\n',
        'vv.m': 'function y = vv(i)\ny = i;\nend\n',
        'tools/shape.py': 'def size():\n    return 1\n',
        'Model.m': cls('Model', methods('reset', 'recalib', 'Total')),
      },
      { 'lib/color.m': null, 'setup_cfg.m': null, 'vv.m': null, 'tools/shape.py': null, 'Model.m': cls('Model', methods('reset')) },
      { 'lib/color.m': 'function c = color()\nc = 1;\nend\n', 'Model.m': cls('Model', props('Total') + methods('reset', 'recalib')) },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run[0]!.syncedDormant).toEqual([]);
    expect(run[1]!.syncedDormant.length).toBe(6);
  }, 600_000);

  it('an edge to a carrier a sync deletes goes dormant in the untouched file, and the carrier\'s return wakes it', async () => {
    const initial = { ...BASE, 'lib/color.m': 'function c = color()\nc = 1;\nend\n', 'Model.m': cls('Model', methods('reset', 'recalib')) };
    const steps: Files[] = [{ 'lib/color.m': null, 'Model.m': cls('Model', methods('reset')) }, { 'lib/color.m': 'function c = color()\nc = 1;\nend\n' }];
    const run = await expectSyncsFresh(initial, steps);
    expect(run[0]!.syncedDormant).toEqual(expect.arrayContaining(['user.m:2 calls:color', 'user.m:8 calls:a.recalib']));
    expect(run[1]!.synced).toContain('user.m user -calls-> color @ lib/color.m');
  }, 600_000);

  it('a carrier swapped between another language\'s symbol and a MATLAB function, for more failed rows than the retry takes (review P1)', async () => {
    // 510 reads: past the per-name ceiling (500) of the sync's retry of failed rows.
    const body = Array.from({ length: 255 }, (_, i) => `  a${i} = getcfg;\n`).join('');
    const GETCFG = 'function ao = getcfg()\n ao = 1;\nend\n';
    const initial = { 'getcfg.m': GETCFG, 'u1.m': `function u1()\n${body}end\n`, 'u2.m': `function u2()\n${body}end\n` };
    const steps: Files[] = [
      { 'getcfg.m': null, 'web/getcfg.js': 'export function getcfg() { return 2; }\n' }, // carried, unlinked: failed
      { 'getcfg.m': GETCFG, 'web/getcfg.js': null }, // linked again, every one
    ];
    const run = await expectSyncsFresh(initial, steps);
    expect(run.map((s) => s.syncedRows.length)).toEqual([510, 0]);
    expect(run[1]!.synced.filter((e) => e.endsWith('-calls-> getcfg @ getcfg.m')).length).toBe(510);
  }, 600_000);

  it('a .m file turned from Objective-C to MATLAB code, Octave text, binary and back: no edge into it outlives its language (review P2)', async () => {
    const OBJC = '#import <Foundation/Foundation.h>\n@interface Rec : NSObject\n- (void)recalib;\n@end\n@implementation Rec\n- (void)recalib { }\n@end\nvoid tint(void) {}\n';
    const MAT = cls('Rec', methods('recalib'));
    const CALLER = '#import <Foundation/Foundation.h>\n#import "Rec.h"\n@interface Caller : NSObject\n- (void)go;\n@end\n@implementation Caller\n- (void)go {\n  Rec *r = [[Rec alloc] init];\n  [r recalib];\n  tint();\n}\n@end\n';
    const initial = {
      'lib/Rec.m': OBJC,
      'app/Caller.m': CALLER,
      'user.m': 'function user(o)\n  o.recalib(2);\n  v = o.recalib;\n  t = tint;\n  r = Rec;\nend\n',
    };
    const steps: Files[] = [
      { 'lib/Rec.m': MAT },
      { 'lib/Rec.m': OBJC }, // back: the MATLAB callers' edges must not follow the names to the Objective-C nodes
      { 'lib/Rec.m': OCTAVE.replace(/color/g, 'Rec') },
      { 'lib/Rec.m': OBJC },
      { 'lib/Rec.m': COLOR_BLOB },
      { 'lib/Rec.m': MAT },
      { 'lib/Rec.m': null },
    ];
    const run = await expectSyncsFresh(initial, steps);
    // Only MATLAB code links the MATLAB caller; only Objective-C the Objective-C one.
    expect(run.map((s) => s.synced.some((e) => e.startsWith('user.m user -calls-> Rec::recalib')))).toEqual([true, false, false, false, false, true, false]);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('app/Caller.m Caller::go -calls-> Rec::recalib')))).toEqual([false, true, false, true, false, false, false]);
  }, 600_000);

  it('a .m file turned from MATLAB code to Objective-C beside another Objective-C class of its name: a caller links as a fresh index does (review P2)', async () => {
    // The two versions define the same names, so only the language change
    // tells the sync that the Objective-C `Rec` has a second definition now.
    const OBJC = '#import <Foundation/Foundation.h>\n@interface Rec : NSObject\n- (void)recalib;\n@end\n@implementation Rec\n- (void)recalib { }\n@end\n';
    const CALLER = '#import <Foundation/Foundation.h>\n@interface Caller : NSObject\n- (void)go;\n@end\n@implementation Caller\n- (void)go {\n  Rec *r = [[Rec alloc] init];\n  [r recalib];\n}\n@end\n';
    const MAT = cls('Rec', methods('recalib'));
    const initial = { 'lib/Rec.m': MAT, 'lib/Caller.m': CALLER, 'far/away/Rec.m': OBJC, 'user.m': 'function user(o)\n  o.recalib(2);\n  r = Rec;\nend\n' };
    const steps: Files[] = [{ 'lib/Rec.m': OBJC }, { 'lib/Rec.m': MAT }, { 'lib/Rec.m': OBJC }, { 'far/away/Rec.m': null }];
    const run = await expectSyncsFresh(initial, steps);
    expect(run[0]!.synced).toContain('lib/Caller.m Caller::go -references-> Rec @ lib/Rec.m');
  }, 600_000);

  it('a script named for a built-in turned to Objective-C, Octave text and back: the built-in\'s calls are kept as a fresh index keeps them (review 2, low 3)', async () => {
    // An Objective-C `beep.m` carries the name `beep.m`, as any language's
    // symbol carries its name, and reaches no call of `beep`.
    const OBJC = (n: string): string => `#import <Foundation/Foundation.h>\n@implementation ${n}\n- (void)go {\n}\n@end\n`;
    const OCT = '## Copyright (C) 2031 A. Author\n## -*- texinfo -*-\n1;\n';
    const initial = { 'main.m': 'function main()\nsetup_paths\nbeep\nx = beep;\nbeep(2);\nend\n', 'setup_paths.m': 'addpath(pwd);\n', 'beep.m': 'disp(1);\n' };
    const steps: Files[] = [
      { 'setup_paths.m': OBJC('Setup'), 'beep.m': OBJC('Beep') },
      { 'setup_paths.m': 'addpath(pwd);\n', 'beep.m': 'disp(1);\n' },
      { 'setup_paths.m': OCT, 'beep.m': OCT },
      { 'setup_paths.m': OBJC('Setup'), 'beep.m': OBJC('Beep') },
      { 'setup_paths.m': 'addpath(pwd);\n', 'beep.m': 'function beep(k)\nend\n' },
      { 'setup_paths.m': null, 'beep.m': null },
    ];
    const run = await expectSyncsFresh(initial, steps);
    expect(run[0]!.syncedRows.filter((r) => r.includes('calls:beep'))).toEqual([]);
    expect(run[4]!.synced.filter((e) => e.includes('-calls-> beep @ beep.m'))).toHaveLength(3);
  }, 600_000);

  it('an include turned from PHP to Pascal and back: the require of it links again, as a fresh index\'s does (review 2, M1)', async () => {
    const PHP = '<?php\nfunction helper_fn($a) { return $a + 1; }\nclass IncThing { public function go() { return helper_fn(1); } }\n';
    const PAS = '{$IFDEF FOO}\nprocedure HelperProc;\nbegin\nend;\n{$ENDIF}\n';
    const USE = "<?php\nrequire 'lib/defs.inc';\nfunction main_fn() { $t = new IncThing(); $t->go(); return helper_fn(2); }\n";
    const flip = await expectSyncsFresh({ 'lib/defs.inc': PHP, 'main.php': USE }, [{ 'lib/defs.inc': PAS }, { 'lib/defs.inc': PHP }]);
    expect(flip[1]!.synced).toContain('main.php main.php -imports-> lib/defs.inc @ lib/defs.inc');
    await expectSyncsFresh({ 'lib/defs.inc': PAS, 'main.php': USE }, [{ 'lib/defs.inc': PHP }]);
    // Control: deleted and added again, no language change.
    await expectSyncsFresh({ 'lib/defs.inc': PHP, 'main.php': USE }, [{ 'lib/defs.inc': null }, { 'lib/defs.inc': PHP }]);
  }, 600_000);

  it('the only carrier of a bare read and a command deleted: both go dormant, as a fresh index keeps them (the loss case)', async () => {
    const initial = { 'user.m': 'function user()\nc = color;\ncolor\nend\n', 'color.m': 'function c = color()\nc = 1;\nend\n' };
    const run = await expectSyncsFresh(initial, [{ 'color.m': null }]);
    expect(run[0]!.syncedRows).toEqual([]);
    expect(run[0]!.syncedDormant).toEqual(['user.m:2 calls:color', 'user.m:3 calls:color']);
  }, 120_000);
});

describe('MATLAB dormant rows: a sync killed in the carrier step', () => {
  it('is finished by the next sync, which wakes the rows and links them', async () => {
    const root = tempDir('cg-matlab-dormant-kill-');
    const COLOR = 'function c = color()\nc = 1;\nend\n';
    try {
      writeTree(root, BASE);
      let cg = await CodeGraph.init(root, { index: true });
      writeTree(root, { 'lib/color.m': COLOR, 'Model.m': cls('Model', methods('reset', 'recalib')) });
      const proto = QueryBuilder.prototype as unknown as { setMatlabDormancy: (wake: number[], sleep: number[]) => number };
      const orig = proto.setMatlabDormancy;
      proto.setMatlabDormancy = function () {
        throw new Error('simulated kill at the carrier dormancy');
      };
      try {
        await expect(cg.sync()).rejects.toThrow('simulated kill');
      } finally {
        proto.setMatlabDormancy = orig;
      }
      cg.close();
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        const record = JSON.parse(new QueryBuilder(db.getDb()).getMetadata(MATLAB_CARRIER_STEP_KEY)!);
        expect(record.wake.length).toBe(2);
      } finally {
        db.close();
      }
      cg = await CodeGraph.open(root);
      try {
        await cg.sync();
        expect(allEdges(cg)).toEqual(expect.arrayContaining(['user.m user -calls-> color @ lib/color.m', 'user.m user -calls-> Model::recalib @ Model.m']));
      } finally {
        cg.close();
      }
      const fresh = await indexOfProject({ ...BASE, 'lib/color.m': COLOR, 'Model.m': cls('Model', methods('reset', 'recalib')) });
      cg = await CodeGraph.open(root);
      try {
        expect(allEdges(cg)).toEqual(fresh.edges);
      } finally {
        cg.close();
      }
      expect(unresolvedRows(root)).toEqual(fresh.unresolved);
      expect(dormantRows(root)).toEqual(fresh.dormant);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB dormant rows: a sync killed after it stored its files, before its carrier step (review P3)', () => {
  /** Makes the next carrier step a sync works out throw: what a sync killed after storing its changed files leaves. */
  const killBeforeCarriers = (): (() => void) => {
    const proto = ExtractionOrchestrator.prototype as unknown as { matlabCarrierStepOf: (...a: unknown[]) => unknown };
    const orig = proto.matlabCarrierStepOf;
    proto.matlabCarrierStepOf = function () {
      throw new Error('simulated kill before the carrier step');
    };
    return () => {
      proto.matlabCarrierStepOf = orig;
    };
  };

  const record = (root: string, key: string): string | null => {
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      return new QueryBuilder(db.getDb()).getMetadata(key) || null;
    } finally {
      db.close();
    }
  };

  /**
   * Indexes `initial`; per step, syncs `kill` in a sync killed before its
   * carrier step, writes `then`, and recovers with a sync (or a full index
   * over the graph) of a CodeGraph opened anew: the edges and rows then, and
   * a fresh index's of the same files, and whether the record was left.
   */
  async function killedEachStep(
    initial: Record<string, string>,
    steps: Array<{ kill: Files; then?: Files }>,
    recover: 'sync' | 'indexAll' = 'sync',
  ): Promise<Array<SyncedStep & { left: boolean; after: string | null; extracted: string[] }>> {
    const root = tempDir('cg-matlab-dormant-killed-');
    const current: Files = { ...initial };
    try {
      writeTree(root, initial);
      (await CodeGraph.init(root, { index: true })).close();
      const out: Array<SyncedStep & { left: boolean; after: string | null; extracted: string[] }> = [];
      for (const { kill, then = {} } of steps) {
        writeTree(root, kill);
        Object.assign(current, kill);
        let cg = await CodeGraph.open(root);
        const restore = killBeforeCarriers();
        try {
          await expect(cg.sync()).rejects.toThrow('simulated kill');
        } finally {
          restore();
          cg.close();
        }
        const left = record(root, MATLAB_CARRIER_INPUTS_KEY) !== null;
        writeTree(root, then);
        Object.assign(current, then);
        cg = await CodeGraph.open(root);
        let synced: string[];
        const extracted: string[] = [];
        const proto = ExtractionOrchestrator.prototype as unknown as { indexFile: (filePath: string, ...a: unknown[]) => unknown };
        const indexFile = proto.indexFile;
        proto.indexFile = function (this: unknown, filePath: string, ...a: unknown[]) {
          extracted.push(filePath);
          return indexFile.call(this, filePath, ...a);
        };
        try {
          if (recover === 'sync') await cg.sync();
          else await cg.indexAll();
          synced = allEdges(cg);
        } finally {
          proto.indexFile = indexFile;
          cg.close();
        }
        const fresh = await indexOfProject(Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)) as Record<string, string>);
        out.push({
          synced, fresh: fresh.edges, syncedRows: unresolvedRows(root), freshRows: fresh.unresolved,
          syncedDormant: dormantRows(root), freshDormant: fresh.dormant, left, after: record(root, MATLAB_CARRIER_INPUTS_KEY),
          extracted: extracted.sort(),
        });
      }
      return out;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const COLOR = 'function c = color()\nc = 1;\nend\n';
  const U = (n: string): string => `function ${n}(o)\n  c = color;\n  o.recalib(2);\nend\n`;
  const KILLED = { 'u1.m': U('u1'), 'u2.m': U('u2'), 'leaf.m': 'function leaf()\nend\n' };

  it('the next sync works the step out from the record, even with nothing changed since', async () => {
    const steps = [
      { kill: { 'lib/color.m': COLOR, 'Model.m': cls('Model', methods('recalib')) } }, // wakes
      { kill: { 'lib/color.m': null, 'Model.m': null } }, // puts to sleep
    ];
    const run = await killedEachStep(KILLED, steps);
    expectEachStepFresh(run, steps.map((s) => s.kill));
    expect(run.map((s) => [s.left, s.after])).toEqual([[true, null], [true, null]]);
    expect(run[0]!.synced).toEqual(expect.arrayContaining(['u1.m u1 -calls-> color @ lib/color.m', 'u2.m u2 -calls-> Model::recalib @ Model.m']));
  }, 300_000);

  it('the next sync changes files too: the recorded step first, then its own', async () => {
    const steps = [
      { kill: { 'lib/color.m': COLOR, 'Model.m': cls('Model', methods('recalib')) }, then: { 'lib/color.m': null } },
      { kill: { 'lib/color.m': COLOR }, then: { 'leaf.m': 'function leaf()\nx = 1;\nend\n' } },
      { kill: { 'Model.m': cls('Model', methods('other')) }, then: { 'm2/Model2.m': cls('Model2', methods('recalib')) } },
    ];
    const run = await killedEachStep(KILLED, steps);
    expectEachStepFresh(run, steps.map((s) => ({ ...s.kill, ...s.then })));
    expect(run.every((s) => s.after === null)).toBe(true);
  }, 300_000);

  it('a built-in\'s name given its first carrier, and taken it, in the killed sync (review 2, R3)', async () => {
    const steps = [
      { kill: { 'tools/beep.m': 'function beep()\nend\n' } },
      { kill: { 'tools/beep.m': null } },
    ];
    const run = await killedEachStep({ 'buzzer.m': 'function buzzer()\nbeep\nend\n' }, steps);
    expectEachStepFresh(run, steps.map((s) => s.kill));
    expect(run[0]!.synced).toContain('buzzer.m buzzer -calls-> beep @ tools/beep.m');
  }, 300_000);

  it('a file changed after the kill is the next sync\'s to extract: the names it now defines are judged (review 2, H1)', async () => {
    // The killed sync gave `beep` its first carrier, so the replay extracts
    // again the files naming it: not u2.m and Model.m, edited since, whose
    // new `helperx` and `recal2` the sync must see as changed definitions.
    const initial = {
      'u1.m': 'function u1()\n beep;\nend\n',
      'u2.m': 'function u2()\n beep;\nend\n',
      'Model.m': 'classdef Model\n methods\n  function recalib(o, x)\n   beep;\n  end\n end\nend\n',
      'u3.m': 'function u3(o)\n o.recal2(1);\n y = helperx;\n z = o.recal2;\nend\n',
    };
    const steps = [{
      kill: { 'lib/beep.m': 'function beep()\nend\n' },
      then: {
        'u2.m': 'function u2()\n beep;\nend\nfunction r = helperx()\n r = 1;\nend\n',
        'Model.m': 'classdef Model\n methods\n  function recalib(o, x)\n   beep;\n  end\n  function recal2(o, x)\n  end\n end\nend\n',
      },
    }];
    const run = await killedEachStep(initial, steps);
    expectEachStepFresh(run, steps.map((s) => ({ ...s.kill, ...s.then })));
    expect(run[0]!.synced).toContain('u3.m u3 -calls-> Model::recal2 @ Model.m');
    expect(run[0]!.extracted).toEqual(['Model.m', 'u1.m', 'u2.m']);
    expect(run[0]!.after).toBeNull();
  }, 300_000);

  it('the next sync extracts no file for a built-in whose carriers and reach the killed sync left as they were (review 2, M2)', async () => {
    // leaf.m defines a local `split`, a built-in's name that tools/split.m
    // already carries and reaches: a comment edit of it changes neither, so
    // no file naming `split` is extracted again.
    const initial = {
      'tools/split.m': 'function s = split(x)\ns = x;\nend\n',
      'a.m': 'function a()\nsplit(1);\nend\n',
      'b.m': 'function b()\ny = split(2);\nend\n',
      'leaf.m': 'function leaf()\nsplit(3);\nend\nfunction split(x)\nend\n',
    };
    const steps = [
      { kill: { 'leaf.m': '% a note\nfunction leaf()\nsplit(3);\nend\nfunction split(x)\nend\n' } },
      { kill: { 'tools/split.m': null } }, // a carrier and reach lost: the rows a fresh index keeps stay
      { kill: { 'tools/split.m': 'function s = split(x)\ns = x;\nend\n' } }, // gained again: the files naming it are extracted again
    ];
    const run = await killedEachStep(initial, steps);
    expectEachStepFresh(run, steps.map((s) => s.kill));
    expect(run.map((s) => s.extracted)).toEqual([[], [], ['a.m', 'b.m', 'leaf.m']]);
  }, 300_000);

  it('records once for all the files a sync finds are no source any more (review 2, low 7)', async () => {
    // A transport stream named `.ts` (#1910): 188-byte packets opening with 0x47.
    const clip = (seed: number): Buffer => {
      const buf = Buffer.alloc(64 * 188);
      let x = seed >>> 0;
      for (let i = 0; i < buf.length; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        buf[i] = i % 188 === 0 ? 0x47 : x >>> 24;
      }
      buf[4] = 0;
      return buf;
    };
    const root = tempDir('cg-matlab-dormant-nonsource-');
    const files = { 'user.m': 'function user()\nc = color;\nend\n', 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n', 'c.ts': 'export const c = 3;\n' };
    const proto = QueryBuilder.prototype as unknown as { setMetadata: (key: string, value: string) => void };
    const setMetadata = proto.setMetadata;
    try {
      writeTree(root, files);
      (await CodeGraph.init(root, { index: true })).close();
      for (const [i, f] of ['a.ts', 'b.ts', 'c.ts'].entries()) fs.writeFileSync(`${root}/${f}`, clip(i + 1));
      const written: string[] = [];
      proto.setMetadata = function (this: unknown, key: string, value: string) {
        if (key === MATLAB_CARRIER_INPUTS_KEY && value !== '') written.push(value);
        return setMetadata.call(this, key, value);
      };
      const cg = await CodeGraph.open(root);
      try {
        await cg.sync();
        expect(cg.getFiles().map((f) => f.path)).toEqual(['user.m']);
      } finally {
        proto.setMetadata = setMetadata;
        cg.close();
      }
      expect(written.map((v) => (JSON.parse(v) as { files: string[] }).files.sort())).toEqual([['a.ts', 'b.ts', 'c.ts']]);
      expect(record(root, MATLAB_CARRIER_INPUTS_KEY)).toBeNull();
    } finally {
      proto.setMetadata = setMetadata;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('a full index over the graph works it out too, and clears the record', async () => {
    const steps = [{ kill: { 'lib/color.m': COLOR, 'Model.m': cls('Model', methods('recalib')) } }, { kill: { 'Model.m': null } }];
    const run = await killedEachStep(KILLED, steps, 'indexAll');
    expectEachStepFresh(run, steps.map((s) => s.kill));
    expect(run.map((s) => [s.left, s.after])).toEqual([[true, null], [true, null]]);
  }, 300_000);

  it('ignores a record it cannot read, and clears it', async () => {
    const root = tempDir('cg-matlab-dormant-bad-record-');
    try {
      writeTree(root, KILLED);
      (await CodeGraph.init(root, { index: true })).close();
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        new QueryBuilder(db.getDb()).setMetadata(MATLAB_CARRIER_INPUTS_KEY, JSON.stringify({ files: 'u1.m', names: [3] }));
      } finally {
        db.close();
      }
      const cg = await CodeGraph.open(root);
      try {
        await cg.sync();
      } finally {
        cg.close();
      }
      expect(record(root, MATLAB_CARRIER_INPUTS_KEY)).toBeNull();
      expect(dormantRows(root)).toEqual((await indexOfProject(KILLED)).dormant);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB dormant rows: an index built before they were kept', () => {
  it('syncs without error and makes no edge a fresh index lacks', async () => {
    const root = tempDir('cg-matlab-dormant-old-');
    try {
      writeTree(root, BASE);
      (await CodeGraph.init(root, { index: true })).close();
      // What an index built before this step holds: no dormant row.
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        db.getDb().prepare("DELETE FROM unresolved_refs WHERE status = 'dormant'").run();
      } finally {
        db.close();
      }
      const step = { 'lib/color.m': 'function c = color()\nc = 1;\nend\n', 'Model.m': cls('Model', methods('reset', 'recalib')) };
      writeTree(root, step);
      const cg = await CodeGraph.open(root);
      let synced: string[];
      try {
        await cg.sync();
        synced = allEdges(cg);
      } finally {
        cg.close();
      }
      const fresh = await indexOfProject({ ...BASE, ...step });
      expect(synced.filter((e) => !fresh.edges.includes(e))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB dormant rows: no reader counts them', () => {
  /** Drops what varies between two reads of the same index: timings. */
  const stable = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (key, v) => (/^(?:ms|tookMs|elapsedMs|durationMs|took|elapsed)$/.test(key) ? undefined : v)));

  it('dead code, the viewer\'s file, node and steps answers, and resolveReferences are the same with and without them', async () => {
    const root = tempDir('cg-matlab-dormant-readers-');
    try {
      writeTree(root, {
        ...BASE,
        // A JavaScript function named as the dormant member call: not a MATLAB carrier, and no caller.
        'web/recalib.js': 'function recalib() { return 1; }\nexport function main() { return 2; }\n',
        'web/app.js': "import { main } from './recalib.js';\nexport function start() { return main(); }\n",
        'web/index.js': "import { start } from './app.js';\nstart();\n",
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const read = async (): Promise<unknown> => {
          const user = cg.getNodesInFile('user.m').find((n) => n.name === 'user')!;
          return stable({
            dead: buildDeadCodeReport(cg, { readSource: null }),
            file: buildFileCode(cg, root, 'user.m'),
            node: await buildNode(cg, root, user.id),
            steps: await buildSteps(cg, root, new URLSearchParams({ anchor: user.id })),
            outside: cg.getUnresolvedReferencesFrom(user.id).map((r) => r.referenceName).sort(),
            inFile: cg.getUnresolvedReferencesInFile('user.m').map((r) => r.referenceName).sort(),
            names: [...cg.getUnresolvedNamesAmong(['recalib', 'color', 'vv', 'size', 'Total'])].sort(),
          });
        };
        expect(dormantRows(root).length).toBe(6);
        const withDormant = await read();
        const resolvedWith = cg.resolveReferences().stats;
        expect(dormantRows(root).length).toBe(6);
        const db = DatabaseConnection.open(getDatabasePath(root));
        try {
          db.getDb().prepare("DELETE FROM unresolved_refs WHERE status = 'dormant'").run();
        } finally {
          db.close();
        }
        const withoutDormant = await read();
        expect(withDormant).toEqual(withoutDormant);
        expect(resolvedWith).toEqual(cg.resolveReferences().stats);
        // The JavaScript function no call reaches is dead code: the dormant MATLAB row named for it counts for nothing.
        expect((withDormant as { dead: { items?: Array<{ name: string }> } }).dead).toBeDefined();
        expect(JSON.stringify((withDormant as { dead: unknown }).dead)).toContain('recalib');
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Every MATLAB row in `root`'s unresolved_refs, whole: `file:line:col kind:name status tail [candidates]`, sorted. */
function matlabRows(root: string): string[] {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const rows = db.getDb().prepare(
      "SELECT file_path AS f, line, col, reference_kind AS k, reference_name AS n, status AS s, name_tail AS t, candidates AS c FROM unresolved_refs WHERE language = 'matlab'"
    ).all() as Array<{ f: string; line: number; col: number; k: string; n: string; s: string; t: string; c: string | null }>;
    return rows.map((r) => `${r.f}:${r.line}:${r.col} ${r.k}:${r.n} ${r.s} ${r.t} ${r.c ?? ''}`).sort();
  } finally {
    db.close();
  }
}

/** `file:line name` of the MATLAB rows of `status`, sorted. */
function rowsOf(rows: readonly string[], status: string): string[] {
  return rows.filter((r) => r.split(' ')[2] === status).map((r) => {
    const [where, kindName] = r.split(' ');
    return `${where!.split(':').slice(0, 2).join(':')} ${kindName!.slice(kindName!.indexOf(':') + 1)}`;
  }).sort();
}

/** Runs `body` with the script-workspace pass made a no-op (`fail`: one that throws). */
async function withPass<T>(mode: 'off' | 'fail', body: () => Promise<T>): Promise<T> {
  const proto = ReferenceResolver.prototype as unknown as { settleMatlabScriptWorkspaces: () => Promise<unknown> };
  const orig = proto.settleMatlabScriptWorkspaces;
  proto.settleMatlabScriptWorkspaces = mode === 'off'
    ? async () => null
    : async () => { throw new Error('simulated kill before the script-workspace pass'); };
  try {
    return await body();
  } finally {
    proto.settleMatlabScriptWorkspaces = orig;
  }
}

/**
 * Indexes `files` with the script-workspace pass and without it: the edges
 * must be the same (the pass changes statuses only), and the rows the same
 * but for the statuses. The failed and dormant rows with it.
 */
async function judgedRows(files: Record<string, string>): Promise<{ failed: string[]; dormant: string[]; edges: string[] }> {
  const index = async (): Promise<{ edges: string[]; rows: string[] }> => {
    const root = tempDir('cg-matlab-scripts-');
    try {
      writeTree(root, files);
      const cg = await CodeGraph.init(root, { index: true });
      let edges: string[];
      try {
        edges = allEdges(cg);
      } finally {
        cg.close();
      }
      return { edges, rows: matlabRows(root) };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const on = await index();
  const off = await withPass('off', index);
  expect(on.edges).toEqual(off.edges);
  const strip = (rows: string[]): string[] => rows.map((r) => r.split(' ').filter((_, i) => i !== 2).join(' ')).sort();
  expect(strip(on.rows)).toEqual(strip(off.rows));
  return { failed: rowsOf(on.rows, 'failed'), dormant: rowsOf(on.rows, 'dormant'), edges: on.edges };
}

/** A function that runs `script` (when given) at its first line, then indexes `use`, each on a line of its own. */
const runner = (name: string, script: string | null, ...uses: string[]): string =>
  [`function ${name}()`, ...(script ? [script] : []), ...uses.map((u, i) => `x${i} = ${u};`), 'end', ''].join('\n');

describe('MATLAB script workspaces: a name a script its scope ran makes is a variable, kept dormant', () => {
  it('a global the script declares, indexed after the run', async () => {
    const r = await judgedRows({ 'f.m': runner('f', 'globs', 'G(3)'), 'globs.m': '% the globals\nglobal G\n' });
    expect(r.dormant).toEqual(['f.m:3 G']);
    expect(r.failed).toEqual([]);
    expect(r.edges).toEqual(['f.m f -calls-> globs.m @ globs.m']);
  });

  it('every form a script makes a name in: an assignment, several outputs, an indexed assignment, a loop, a load list', async () => {
    const forms = ['G = zeros(5);', '[G, H] = deal(1, 2);', 'G(2) = 1;', 'for G = 1:3\nend', 'load data.mat G'];
    for (const form of forms) {
      const r = await judgedRows({ 'f.m': runner('f', 'mk', 'G(3)'), 'mk.m': `${form}\n` });
      expect(r.dormant, form).toEqual(['f.m:3 G']);
      expect(r.failed, form).toEqual([]);
    }
    // Both outputs, and a catch variable. A `persistent` makes none: MATLAB refuses it outside a function.
    const both = await judgedRows({ 'f.m': runner('f', 'mk', 'G(3)', 'H(1)', 'E(1)', 'P(1)'), 'mk.m': '[G, H] = deal(1, 2);\ntry\n  x = 1;\ncatch E\nend\npersistent P\n' });
    expect(both.dormant).toEqual(['f.m:3 G', 'f.m:4 H', 'f.m:5 E']);
    expect(both.failed).toEqual(['f.m:6 P']);
  });

  it('through the scripts the script runs, transitively', async () => {
    const r = await judgedRows({
      'f.m': runner('f', 's1', 'G(3)', 'A(1)'),
      's1.m': 's2\nA = 1;\n',
      's2.m': 'global G\n',
    });
    expect(r.dormant).toEqual(['f.m:3 G', 'f.m:4 A']);
    expect(r.failed).toEqual([]);
  });

  it('a script\'s top level that runs another script, then uses the name', async () => {
    const r = await judgedRows({ 'top.m': 'globs\nk = G(1);\n', 'globs.m': 'global G\n' });
    expect(r.dormant).toEqual(['top.m:2 G']);
    expect(r.failed).toEqual([]);
  });

  it('a cycle of scripts ends, with the names of both', async () => {
    const r = await judgedRows({
      'f.m': runner('f', 's1', 'A(1)', 'B(1)', 'C(1)'),
      's1.m': 's2\nA = 1;\n',
      's2.m': 's1\nB = 1;\n',
    });
    expect(r.dormant).toEqual(['f.m:3 A', 'f.m:4 B']);
    expect(r.failed).toEqual(['f.m:5 C']);
  });

  it(`follows a chain of scripts to ${MATLAB_SCRIPT_RUN_DEPTH} deep, and no further`, async () => {
    const files: Record<string, string> = { 'f.m': runner('f', 's1', 'V1(1)', `V${MATLAB_SCRIPT_RUN_DEPTH}(1)`, `V${MATLAB_SCRIPT_RUN_DEPTH + 1}(1)`) };
    for (let i = 1; i <= MATLAB_SCRIPT_RUN_DEPTH + 1; i++) files[`s${i}.m`] = `V${i} = ${i};\n${i <= MATLAB_SCRIPT_RUN_DEPTH ? `s${i + 1}\n` : ''}`;
    const r = await judgedRows(files);
    expect(r.dormant).toEqual(['f.m:3 V1', `f.m:4 V${MATLAB_SCRIPT_RUN_DEPTH}`]);
    expect(r.failed).toEqual([`f.m:5 V${MATLAB_SCRIPT_RUN_DEPTH + 1}`]);
  });
});

describe('MATLAB script workspaces: when in doubt the call stays failed', () => {
  it('the script runs only after the use: a later line, or later on the same line', async () => {
    const r = await judgedRows({
      'f.m': 'function f()\nx = G(3);\nglobs\nend\n',
      'g.m': 'function g()\nx = G(3); globs\ny = G(4);\nend\n',
      'h.m': 'function h()\nglobs; x = G(3);\nend\n',
      'globs.m': 'global G\n',
    });
    expect(r.failed).toEqual(['f.m:2 G', 'g.m:2 G']);
    expect(r.dormant).toEqual(['g.m:3 G', 'h.m:2 G']);
  });

  it('no script run at all, and a script that makes another name', async () => {
    const r = await judgedRows({
      'f.m': runner('f', null, 'G(3)'),
      'g.m': runner('g', 'globs', 'G(3)', 'H(1)'),
      'globs.m': 'global H\n',
    });
    expect(r.failed).toEqual(['f.m:2 G', 'g.m:3 G']);
    expect(r.dormant).toEqual(['g.m:4 H']);
  });

  it('a nested function does not inherit its parent\'s runs', async () => {
    const r = await judgedRows({
      'f.m': 'function f()\nglobs\nx = G(1);\n  function inner()\n    y = G(2);\n  end\nend\n',
      'globs.m': 'global G\n',
    });
    expect(r.dormant).toEqual(['f.m:3 G']);
    expect(r.failed).toEqual(['f.m:5 G']);
  });

  it('a script whose text does not parse cleanly, or is Octave, makes no name', async () => {
    const r = await judgedRows({
      'f.m': runner('f', 'broken', 'G(3)'),
      'g.m': runner('g', 'octave', 'G(3)'),
      'broken.m': 'global G\nx = [1 2;\ny = )(;\n',
      'octave.m': '# an Octave comment\nglobal G\n',
    });
    expect(r.dormant.filter((d) => d.endsWith(' G'))).toEqual([]);
    expect(r.failed).toEqual(['f.m:3 G', 'g.m:3 G']);
  });

  it('a run in another workspace makes no name here: evalin into the base or the caller\'s, not eval', async () => {
    const r = await judgedRows({
      'f_base.m': "function f_base\nevalin('base', 'globs');\ny = G(3);\nend\n",
      'f_caller.m': "function f_caller\nevalin('caller', 'globs');\ny = G(3);\nend\n",
      'f_eval.m': "function f_eval\neval('globs');\ny = G(3);\nend\n",
      'globs.m': 'global G\n',
    });
    // evalin's run is still a call into the script: only its status reading changed.
    expect(r.edges.filter((e) => e.includes('-calls-> globs.m'))).toHaveLength(3);
    expect(r.failed).toEqual(['f_base.m:3 G', 'f_caller.m:3 G']);
    expect(r.dormant).toEqual(['f_eval.m:3 G']);
  });

  it('a name a `clear` removes is not made; a `clear` that may remove more leaves only what is made after it', async () => {
    const cases: Array<[string, 'failed' | 'dormant']> = [
      ['X = 1;\nclear X', 'failed'],
      ["X = 1;\nclear('X');", 'failed'],
      ['X = 1;\nclearvars X', 'failed'],
      ['clear\nX = 1;', 'dormant'],
      ['X = 1;\nclear', 'failed'],
      ['X = 1;\nclear all', 'failed'],
      ['X = 1;\nclear variables', 'failed'],
      ['global X\nclear global', 'failed'],
      ['X = 1;\nclear classes', 'failed'],
      ['X = 1;\nclearvars', 'failed'],
      ['X = 1;\nclearvars -except X', 'failed'],
      ['X = 1;\nclear -regexp ^Y', 'failed'],
      ['X = 1;\nclear(name)', 'failed'],
      ['X = 1;\nclear functions', 'dormant'],
      ['X = 1;\nclear mex', 'dormant'],
      ['X = 1;\nclear Y', 'dormant'],
      ['X = 1;\nclear all\nX = 2;', 'dormant'],
      ['X = 1;\nif k\n  clear\nend', 'failed'],
    ];
    const files: Record<string, string> = {};
    cases.forEach(([body], i) => {
      files[`f${i}.m`] = runner(`f${i}`, `s${i}`, 'X(3)');
      files[`s${i}.m`] = `${body}\n`;
    });
    const r = await judgedRows(files);
    cases.forEach(([body, want], i) => {
      expect(r[want], body).toContain(`f${i}.m:3 X`);
    });
    // A script run through another counts its own clears the same way.
    const t = await judgedRows({ 'f.m': runner('f', 's1', 'X(3)', 'Y(1)'), 's1.m': 's2\nY = 1;\n', 's2.m': 'X = 1;\nclear\n' });
    expect(t.failed).toEqual(['f.m:3 X']);
    expect(t.dormant).toEqual(['f.m:4 Y']);
  });

  it(`a script larger than ${MATLAB_SCRIPT_MAX_BYTES} bytes makes no name`, async () => {
    const fill = (bytes: number): string => {
      let out = '';
      for (let i = 0; out.length < bytes; i++) out += `L${i} = [${i} ${i + 1}];\n`;
      return out;
    };
    const small = `global G\n${fill(MATLAB_SCRIPT_MAX_BYTES - 1024)}`;
    const large = `global G\n${fill(MATLAB_SCRIPT_MAX_BYTES + 1)}`;
    expect(Buffer.byteLength(small)).toBeLessThanOrEqual(MATLAB_SCRIPT_MAX_BYTES);
    expect(Buffer.byteLength(large)).toBeGreaterThan(MATLAB_SCRIPT_MAX_BYTES);
    const r = await judgedRows({ 'f.m': runner('f', 'small', 'G(3)'), 'g.m': runner('g', 'large', 'G(3)'), 'small.m': small, 'large.m': large });
    expect(r.dormant).toEqual(['f.m:3 G']);
    expect(r.failed).toEqual(['g.m:3 G']);
  }, 60_000);

  it('a call with a carrier links as before, and is left alone', async () => {
    const r = await judgedRows({ 'f.m': runner('f', 'globs', 'G(3)'), 'globs.m': 'global G\n', 'G.m': 'function r = G(x)\nr = x;\nend\n' });
    expect(r.edges).toEqual(['f.m f -calls-> G @ G.m', 'f.m f -calls-> globs.m @ globs.m']);
    expect(r.failed).toEqual([]);
    expect(r.dormant).toEqual([]);
  });
});

describe('MATLAB script workspaces: a sync ends where a fresh index ends', () => {
  const START = { 'f.m': runner('f', 'globs', 'G(3)'), 'globs.m': 'global G\n' };
  const G_FN = 'function r = G(x)\nr = x;\nend\n';

  it('a carrier added wakes the row and links it; deleted, the row is dormant again', async () => {
    const steps = [{ 'G.m': G_FN }, { 'G.m': null }];
    const run = await expectSyncsFresh(START, steps);
    expect(run[0]!.synced).toContain('f.m f -calls-> G @ G.m');
    expect(run[0]!.syncedDormant).toEqual([]);
    expect(run[1]!.syncedDormant).toEqual(['f.m:3 calls:G']);
  }, 120_000);

  it('the global line removed and back, the run removed and back, the script turned to a function and back, renamed and deleted', async () => {
    const steps: Files[] = [
      { 'globs.m': '% nothing\nx = 1;\n' },
      { 'globs.m': 'global G\n' },
      { 'f.m': runner('f', null, 'G(3)') },
      { 'f.m': START['f.m'] },
      { 'globs.m': 'function globs()\nglobal G\nend\n' },
      { 'globs.m': 'global G\n' },
      { 'globs.m': null, 'globs2.m': 'global G\n' },
      { 'globs.m': 'global G\n', 'globs2.m': null },
      { 'globs.m': null },
    ];
    const run = await expectSyncsFresh(START, steps);
    expect(run.map((s) => s.syncedDormant.includes('f.m:3 calls:G'))).toEqual([false, true, false, true, false, true, false, true, false]);
  }, 240_000);

  it('a script deleted and added back with other text makes its new names, in one long-lived graph', async () => {
    const start = { 'f.m': runner('f', 'globs', 'G(3)', 'H(1)'), 'globs.m': 'global G\n' };
    const steps: Files[] = [{ 'globs.m': null }, { 'globs.m': 'global H\n' }, { 'globs.m': 'global G\n' }];
    const run = await expectSyncsFresh(start, steps);
    expect(run.map((s) => s.syncedDormant.filter((r) => / calls:[GH]$/.test(r)))).toEqual([[], ['f.m:4 calls:H'], ['f.m:3 calls:G']]);
  }, 120_000);

  it('a seeded random sequence of edits to functions and scripts', async () => {
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };
    const state = {
      s1Global: true, // s1 declares G1
      s1RunsS2: true,
      s1Function: false, // s1.m turned to a function file
      s1Name: 's1' as 's1' | 's1b', // renamed
      s2: true, // s2.m exists
      s2Assigns: true, // s2 assigns G2
      s2RunsS1: false, // a cycle
      fRun: 'before' as 'before' | 'after' | 'none',
      gRunsS2: true,
      carrier: false, // G1.m
    };
    const render = (): Record<string, string | null> => {
      const fRun = state.fRun === 'none' ? [] : ['s1'];
      const f = state.fRun === 'after'
        ? 'function f()\nx = G1(1);\ny = G2(2);\nz = H(3);\ns1\nend\n'
        : ['function f()', ...fRun, 'x = G1(1);', 'y = G2(2);', 'z = H(3);', 'end', ''].join('\n');
      const s1Body = [...(state.s1Global ? ['global G1'] : ['% no globals']), ...(state.s1RunsS2 ? ['s2'] : []), 'H = 1;'].join('\n') + '\n';
      const s1 = state.s1Function ? `function ${state.s1Name}()\n${s1Body}end\n` : s1Body;
      const files: Record<string, string | null> = {
        'f.m': f,
        'g.m': `function g()\n${state.gRunsS2 ? 's2\n' : ''}y = G2(1);\nq = G1(1);\nend\n`,
        's1.m': state.s1Name === 's1' ? s1 : null,
        's1b.m': state.s1Name === 's1b' ? s1 : null,
        's2.m': state.s2 ? `${state.s2RunsS1 ? 's1\n' : ''}${state.s2Assigns ? 'G2 = 2;' : 'k = 0;'}\n` : null,
        'G1.m': state.carrier ? G_FN.replace(/G\b/g, 'G1') : null,
      };
      return files;
    };
    const flips: Array<() => void> = [
      () => { state.s1Global = !state.s1Global; },
      () => { state.s1RunsS2 = !state.s1RunsS2; },
      () => { state.s1Function = !state.s1Function; },
      () => { state.s1Name = state.s1Name === 's1' ? 's1b' : 's1'; },
      () => { state.s2 = !state.s2; },
      () => { state.s2Assigns = !state.s2Assigns; },
      () => { state.s2RunsS1 = !state.s2RunsS1; },
      () => { state.fRun = (['before', 'after', 'none'] as const)[rand(3)]!; },
      () => { state.gRunsS2 = !state.gRunsS2; },
      () => { state.carrier = !state.carrier; },
    ];
    const initial = Object.fromEntries(Object.entries(render()).filter(([, c]) => c !== null)) as Record<string, string>;
    const root = tempDir('cg-matlab-scripts-random-');
    const current: Files = { ...initial };
    let slept = 0;
    let woke = 0;
    try {
      writeTree(root, initial);
      const cg = await CodeGraph.init(root, { index: true });
      let lastAsleep = new Set(rowsOf(matlabRows(root), 'dormant').filter((r) => / G[12]$/.test(r)));
      try {
        for (let i = 0; i < 32; i++) {
          flips[rand(flips.length)]!();
          const next = render();
          const step: Files = {};
          for (const [p, c] of Object.entries(next)) if ((current[p] ?? null) !== c) step[p] = c;
          writeTree(root, step);
          Object.assign(current, step);
          await cg.sync();
          const freshRoot = tempDir('cg-matlab-scripts-random-fresh-');
          try {
            writeTree(freshRoot, Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)) as Record<string, string>);
            const fresh = await CodeGraph.init(freshRoot, { index: true });
            try {
              expect(allEdges(cg), `step ${i} ${JSON.stringify(state)}: edges`).toEqual(allEdges(fresh));
            } finally {
              fresh.close();
            }
            const rows = matlabRows(root);
            expect(rows, `step ${i} ${JSON.stringify(state)}: rows`).toEqual(matlabRows(freshRoot));
            const asleep = new Set(rowsOf(rows, 'dormant').filter((r) => / G[12]$/.test(r)));
            for (const r of asleep) if (!lastAsleep.has(r)) slept++;
            for (const r of lastAsleep) if (!asleep.has(r)) woke++;
            lastAsleep = asleep;
          } finally {
            fs.rmSync(freshRoot, { recursive: true, force: true });
          }
        }
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    // The sequence put rows to sleep and woke them, both ways, several times.
    expect(slept).toBeGreaterThanOrEqual(3);
    expect(woke).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it('a sync killed after resolution, before the pass: the next plain sync ends where a fresh index ends', async () => {
    const root = tempDir('cg-matlab-scripts-kill-');
    try {
      writeTree(root, { ...START, 'globs.m': 'x = 1;\n' });
      let cg = await CodeGraph.init(root, { index: true });
      try {
        expect(rowsOf(matlabRows(root), 'failed')).toEqual(['f.m:3 G']);
        writeTree(root, { 'globs.m': 'global G\n' });
        await withPass('fail', () => expect(cg.sync()).rejects.toThrow('simulated kill'));
      } finally {
        cg.close();
      }
      // Killed: the row is still failed.
      expect(rowsOf(matlabRows(root), 'failed')).toEqual(['f.m:3 G']);
      cg = await CodeGraph.open(root);
      try {
        await cg.sync();
      } finally {
        cg.close();
      }
      const freshRoot = tempDir('cg-matlab-scripts-kill-fresh-');
      try {
        writeTree(freshRoot, START);
        (await CodeGraph.init(freshRoot, { index: true })).close();
        expect(matlabRows(root)).toEqual(matlabRows(freshRoot));
        expect(rowsOf(matlabRows(root), 'dormant')).toEqual(['f.m:3 G']);
      } finally {
        fs.rmSync(freshRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('an index an earlier build left, with these rows failed: the next sync, or the next full index, ends where a fresh one ends', async () => {
    for (const recover of ['sync', 'indexAll'] as const) {
      const root = tempDir('cg-matlab-scripts-upgrade-');
      const freshRoot = tempDir('cg-matlab-scripts-upgrade-fresh-');
      try {
        const files = { ...START, 'top.m': 'globs\nk = G(1);\n' };
        writeTree(freshRoot, files);
        (await CodeGraph.init(freshRoot, { index: true })).close();
        writeTree(root, files);
        (await CodeGraph.init(root, { index: true })).close();
        // What an index built before this pass holds: every such row failed.
        const db = DatabaseConnection.open(getDatabasePath(root));
        try {
          const flipped = db.getDb().prepare(
            `UPDATE unresolved_refs SET status = 'failed' WHERE status = 'dormant' AND language = 'matlab' AND reference_kind = 'calls'
               AND candidates IS NULL AND instr(reference_name, '.') = 0 AND instr(reference_name, ':') = 0`
          ).run().changes;
          expect(flipped).toBe(2);
        } finally {
          db.close();
        }
        const cg = await CodeGraph.open(root);
        try {
          if (recover === 'sync') await cg.sync();
          else await cg.indexAll();
        } finally {
          cg.close();
        }
        expect(matlabRows(root), recover).toEqual(matlabRows(freshRoot));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(freshRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);
});

describe('MATLAB script workspaces: what a pass keeps of the scripts it read', () => {
  it('a pass reads only the scripts it has not seen, and keeps only what it read off the indexed text', async () => {
    const root = tempDir('cg-matlab-scripts-memo-');
    try {
      writeTree(root, { 'f.m': runner('f', 'globs', 'G(3)'), 'g.m': runner('g', 'globs', 'G(4)'), 'globs.m': 'global G\n' });
      (await CodeGraph.init(root, { index: true })).close();
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        const queries = new QueryBuilder(db.getDb());
        const memo = new MatlabScriptMemo();
        const pass = async () => (await settleMatlabScriptWorkspaces(queries, root, () => undefined, memo))!;
        const asleep = () => rowsOf(matlabRows(root), 'dormant');
        // Edited since it was indexed: read and used by this pass, never kept.
        fs.writeFileSync(`${root}/globs.m`, 'x = 1;\n');
        expect(await pass()).toMatchObject({ scriptsRead: 1, parsed: 1, woken: 2 });
        expect(memo.size).toBe(0);
        expect(await pass()).toMatchObject({ scriptsRead: 1, parsed: 1, woken: 0 });
        // Gone: no read, nothing kept, and the rows stay awake.
        fs.rmSync(`${root}/globs.m`);
        expect(await pass()).toMatchObject({ scriptsRead: 0, parsed: 0, woken: 0, slept: 0 });
        expect(memo.size).toBe(0);
        // Back to the text the index holds: read once and kept.
        fs.writeFileSync(`${root}/globs.m`, 'global G\n');
        expect(await pass()).toMatchObject({ scriptsRead: 1, parsed: 1, slept: 2 });
        expect(memo.size).toBe(1);
        expect(asleep()).toEqual(['f.m:3 G', 'g.m:3 G']);
        // Then the memo answers, by the content hash the index holds: no read.
        expect(await pass()).toMatchObject({ scriptsRead: 0, parsed: 0, slept: 0, woken: 0 });
        fs.writeFileSync(`${root}/globs.m`, 'x = 1;\n');
        expect(await pass()).toMatchObject({ scriptsRead: 0, parsed: 0, slept: 0, woken: 0 });
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('holds at most its bound, the least recently asked for dropped first', () => {
    const memo = new MatlabScriptMemo(2);
    const entry = { script: true, names: new Set(['G']) };
    memo.set('a.m', 'h1', entry);
    memo.set('b.m', 'h1', entry);
    expect(memo.get('a.m', 'h1')).toBe(entry);
    memo.set('c.m', 'h1', entry);
    expect(memo.size).toBe(2);
    expect(memo.get('b.m', 'h1')).toBeUndefined();
    expect(memo.get('a.m', 'h1')).toBe(entry);
    expect(memo.get('a.m', 'h2')).toBeUndefined();
    expect(memo.get('c.m', 'h1')).toBe(entry);
  });

  it('keeps one entry per script, its latest text\'s, however often the script is edited', () => {
    const memo = new MatlabScriptMemo();
    const first = { script: true, names: new Set(['G']) };
    const later = { script: true, names: new Set(['H']) };
    for (let i = 0; i < 50; i++) memo.set('s.m', `h${i}`, first);
    memo.set('s.m', 'hz', later);
    expect(memo.size).toBe(1);
    expect(memo.get('s.m', 'hz')).toBe(later);
    expect(memo.get('s.m', 'h0')).toBeUndefined();
  });
});

describe('MATLAB dormant rows: the names a load that does not list them may make', () => {
  const HELPER = 'function y = helper(x)\ny = x;\nend\n';
  const LOADER = [
    'function quadv(FileName)',
    "eval(['load ', FileName]);",
    'x = DEVnum(3);', // read of the loaded data: dormant
    'plot(t0)', // a bare read: dormant, as before
    "sigtag('HaltFeed')", // passes a text: a call leaving the index
    'g(@h)', // passes a handle: a call leaving the index
    'y = helper(2);', // a carrier: linked
    'end',
    '',
  ].join('\n');

  it('a read after the load is dormant; a call passing a text or a handle stays live; a carrier still links', async () => {
    const r = await indexOfProject({ 'quadv.m': LOADER, 'helper.m': HELPER, 'gd_user.m': 'load gd\ng = gains(1);\ngains(2)\n' });
    expect(r.dormant).toEqual(['gd_user.m:2 calls:gains', 'quadv.m:3 calls:DEVnum', 'quadv.m:4 calls:t0']);
    // `gains(2)`, a statement of its own with arguments, reads as a call.
    expect(r.unresolved).toEqual(['gd_user.m:3 calls:gains', 'quadv.m:5 calls:sigtag', 'quadv.m:6 calls:g', 'quadv.m:6 function_ref:h']);
    expect(r.edges).toContain('quadv.m quadv -calls-> helper @ helper.m');
  });

  it('a read before the load, or in another local function, stays live', async () => {
    const code = ['function a(f)', 'x = Early(1);', 'load(f)', 'end', 'function b()', 'y = InB(1);', 'end', ''].join('\n');
    const r = await indexOfProject({ 'a.m': code });
    expect(r.unresolved).toEqual(['a.m:2 calls:Early', 'a.m:6 calls:InB']);
    expect(r.dormant).toEqual([]);
  });

  it('a read in a clause the load is not in, in a static workspace, after a clear, or after a call of the class\'s own load stays live', async () => {
    const r = await indexOfProject({
      // (Each statement in its own function: a load in the `if` reaches a read after the whole statement.)
      'branches.m': ['function branches(fname, useFile)', 'if useFile', '    load(fname)', 'else', '    a = makedefaults(1);', 'end', 'end', 'function tried(fname)', 'try', '    load(fname)', 'catch', '    b = report_failure(2);', 'end', 'end', 'function switched(fname, mode)', 'switch mode', '    case 1', '        load(fname)', '    case 2', '        c = fallbackcfg(3);', 'end', 'end', ''].join('\n'),
      'plotgui.m': ['function plotgui(fname)', 'load(fname)', 'y = smoothit(3);', '  function cb(src, evt)', '    z = rescaleit(2);', '  end', 'end', ''].join('\n'),
      'nestedload.m': ['function nestedload(fname)', 'w = 1;', '  function inner()', '    load(fname)', '    q = missingfn(w);', '  end', 'end', ''].join('\n'),
      'cleared.m': ['function cleared(fname)', 'load(fname)', 'clear all', 'd = afterclear(1);', ''].join('\n'),
      'Loader2.m': ['classdef Loader2', '  methods', '    function load(obj, f)', '      disp(f)', '    end', '    function run(obj, f)', '      load(obj, f)', '      r7 = afterclassmethod(1);', '    end', '  end', 'end', ''].join('\n'),
    });
    expect(r.dormant).toEqual([]);
    expect(r.unresolved).toEqual([
      'Loader2.m:8 calls:afterclassmethod',
      'branches.m:12 calls:report_failure', 'branches.m:20 calls:fallbackcfg', 'branches.m:5 calls:makedefaults',
      'cleared.m:4 calls:afterclear',
      'nestedload.m:5 calls:missingfn',
      'plotgui.m:3 calls:smoothit', 'plotgui.m:5 calls:rescaleit',
    ]);
    expect(r.edges).toContain('Loader2.m Loader2::run -calls-> Loader2::load @ Loader2.m');
  });

  it('a clear in the loop or in the load\'s own clause ends it, a load in parfor or spmd makes nothing, and a loop still carries it round', async () => {
    const r = await indexOfProject({
      'loops.m': [
        'function loops(fs)',
        'for k = 1:3',
        '  load(fs{k})',
        '  clear all',
        '  a = inloop(1);', // the clear runs every pass before it: a call
        'end',
        'end',
        'function wrap(fs)',
        'for k = 1:3',
        '  if k > 1, b = wrapped(1); end', // read on the next pass, after the load: data
        '  load(fs{k})',
        'end',
        'end',
        'function ownclause(f, x)',
        'if x',
        '  load(f)',
        '  clear all',
        'end',
        'c = afterclause(1);', // the load's own clause cleared what it made: a call
        'end',
        'function par(fs)',
        'parfor k = 1:3',
        '  load(fs{k})',
        '  d = inparfor(1);', // MATLAB refuses that load: a call
        'end',
        'spmd',
        '  load(fs{1})',
        '  e = inspmd(1);',
        'end',
        'end',
        '',
      ].join('\n'),
    });
    expect(r.dormant).toEqual(['loops.m:10 calls:wrapped']);
    expect(r.unresolved).toEqual(['loops.m:19 calls:afterclause', 'loops.m:24 calls:inparfor', 'loops.m:28 calls:inspmd', 'loops.m:5 calls:inloop']);
  });

  it('a script run after the load still runs in this workspace: the names it makes are variables', async () => {
    const r = await indexOfProject({ 'f.m': ['function f(fname)', 'load(fname)', 'globs', "x = G('a');", 'end', ''].join('\n'), 'globs.m': 'global G\n' });
    expect(r.edges).toContain('f.m f -calls-> globs.m @ globs.m');
    expect(r.dormant).toEqual(['f.m:4 calls:G']);
    expect(r.unresolved).toEqual([]);
  });

  it('a sync that adds the load, removes it, and adds then removes a carrier of the name ends where a fresh index ends', async () => {
    const plain = 'function user2(f)\nx = DEVnum(3);\nend\n';
    const loading = 'function user2(f)\nload(f)\nx = DEVnum(3);\nend\n';
    const BPM = 'function y = DEVnum(i)\ny = i;\nend\n';
    const steps: Files[] = [
      { 'user2.m': loading },
      { 'user2.m': plain },
      { 'user2.m': loading },
      { 'DEVnum.m': BPM },
      { 'DEVnum.m': null },
      { 'DEVnum.m': BPM, 'user2.m': plain },
      { 'DEVnum.m': null },
    ];
    const run = await expectSyncsFresh({ 'user2.m': plain }, steps);
    expect(run.map((s) => s.syncedDormant.some((r) => r.endsWith('calls:DEVnum')))).toEqual([true, false, true, false, true, false, false]);
    expect(run.map((s) => s.syncedRows.some((r) => r.endsWith('calls:DEVnum')))).toEqual([false, true, false, false, false, false, true]);
    expect(run.map((s) => s.synced.some((e) => e.includes('-calls-> DEVnum @ DEVnum.m')))).toEqual([false, false, false, true, false, true, false]);
  }, 600_000);
});

describe('MATLAB dormant rows: a member call written with arguments is kept only for what a dotted call can reach', () => {
  // `s.X(1)` on a parameter, `p.X(1)` on a package; `s.Y(1)` beside them,
  // which only a plain function `Y.m` carries: a field's or a property's
  // index, or Java, never a call of `Y`.
  const CALLER = ['function u(s)', 'a = s.X(1);', 'b = p.X(2);', 'c = s.Y(3);', 'end', ''].join('\n');
  const PLAIN_Y = { 'u.m': CALLER, 'lib/Y.m': 'function r = Y(v)\nr = v;\nend\n' };
  const localFn = (name: string): string => `function r = ${name}(v)\nr = v;\nend\n`;
  const classWithLocal = cls('C', methods('go')) + localFn('X');
  const classWithMethod = cls('C', methods('go', 'X'));
  const DORMANT_ALL = ['u.m:2 calls:s.X', 'u.m:3 calls:p::X', 'u.m:4 calls:s.Y'];

  it('a plain, local or nested function, a script or a property of the name carries none: each goes dormant', async () => {
    const carriers: Array<Record<string, string>> = [
      { 'lib/X.m': localFn('X') },
      { 'tools/helpers.m': 'function helpers()\nend\n' + localFn('X') },
      { 'tools/outer.m': 'function outer()\n  function r = X(v)\n    r = v;\n  end\nend\n' },
      { 'X.m': 'x = 1;\n' },
      { 'K.m': cls('K', props('X') + methods('go')) },
    ];
    for (const carrier of carriers) {
      const r = await indexOfProject({ ...PLAIN_Y, ...carrier });
      expect(r.dormant, JSON.stringify(carrier)).toEqual(DORMANT_ALL);
      expect(r.unresolved, JSON.stringify(carrier)).toEqual([]);
    }
  }, 600_000);

  it('a classdef method, a class-folder method, a package function, a class in a package and a MEX help file in one keep it, as before', async () => {
    const cases: Array<{ files: Record<string, string>; edges: string[]; live: string[]; dormant: string[] }> = [
      // The one method of the name: `s.X(1)` links to it, and `p.X(2)`, of a
      // package the project lacks, is kept: which class or package a head
      // names is other files' to say.
      { files: { 'M.m': classWithMethod.replace(/\bC\b/g, 'M') }, edges: ['u.m u -calls-> M::X @ M.m'], live: ['u.m:3 calls:p::X'], dormant: ['u.m:4 calls:s.Y'] },
      // Two unrelated classes' methods: no edge, the row live.
      { files: { 'M.m': cls('M', methods('X')), 'N.m': cls('N', methods('X')) }, edges: [], live: ['u.m:2 calls:s.X', 'u.m:3 calls:p::X'], dormant: ['u.m:4 calls:s.Y'] },
      { files: { '@C/C.m': cls('C', methods('go')), '@C/X.m': 'function r = X(obj, v)\nr = v;\nend\n' }, edges: ['u.m u -calls-> C::X @ @C/X.m'], live: ['u.m:3 calls:p::X'], dormant: ['u.m:4 calls:s.Y'] },
      { files: { '+p/X.m': localFn('X') }, edges: ['u.m u -calls-> p::X @ +p/X.m'], live: ['u.m:2 calls:s.X'], dormant: ['u.m:4 calls:s.Y'] },
      { files: { '+p/X.m': cls('X', methods('go')) }, edges: ['u.m u -instantiates-> p::X @ +p/X.m'], live: ['u.m:2 calls:s.X'], dormant: ['u.m:4 calls:s.Y'] },
      // The help text of a MEX function `p.X`: MATLAB runs the MEX file, which the index never reads.
      { files: { '+p/X.m': '% X  Help text of a MEX function.\n%   r = p.X(v)\n' }, edges: [], live: ['u.m:2 calls:s.X', 'u.m:3 calls:p::X'], dormant: ['u.m:4 calls:s.Y'] },
    ];
    for (const c of cases) {
      const r = await indexOfProject({ ...PLAIN_Y, ...c.files });
      const what = JSON.stringify(c.files).slice(0, 120);
      expect(r.edges.filter((e) => e.startsWith('u.m ')), what).toEqual(c.edges);
      expect(r.unresolved, what).toEqual(c.live);
      expect(r.dormant, what).toEqual(c.dormant);
    }
  }, 600_000);

  it('a sync ends where a fresh index ends: a method added beside a function of the name and deleted, a local function turned into a method and back', async () => {
    const initial = { ...PLAIN_Y, 'lib/X.m': localFn('X'), 'C.m': classWithLocal };
    const steps: Files[] = [
      { 'M.m': cls('M', methods('go', 'X')) },
      { 'M.m': null },
      { 'C.m': classWithMethod },
      { 'C.m': classWithLocal },
      { 'C.m': classWithMethod, 'lib/X.m': null },
      { 'C.m': classWithLocal },
    ];
    const run = await expectSyncsFresh(initial, steps);
    expect(run.map((s) => s.syncedDormant.includes('u.m:2 calls:s.X'))).toEqual([false, true, false, true, false, true]);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('u.m u -calls-> M::X')))).toEqual([true, false, false, false, false, false]);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('u.m u -calls-> C::X')))).toEqual([false, false, true, false, true, false]);
    expect(run.every((s) => s.syncedDormant.includes('u.m:4 calls:s.Y'))).toBe(true);
  }, 600_000);

  it('a sync ends where a fresh index ends: a property turned into a method and back, a package function and a MEX help file added and removed', async () => {
    const initial = { ...PLAIN_Y, 'K.m': cls('K', props('X') + methods('go')) };
    const steps: Files[] = [
      { 'K.m': cls('K', methods('go', 'X')) },
      { 'K.m': cls('K', props('X') + methods('go')) },
      { '+p/X.m': localFn('X') },
      { '+p/X.m': null },
      { '+p/X.m': '% X  Help text of a MEX function.\n' },
      { '+p/X.m': 'x = 1;\n' },
      { '+p/X.m': null, 'p/X.m': localFn('X') },
      { 'p/X.m': null },
    ];
    const run = await expectSyncsFresh(initial, steps);
    expect(run.map((s) => s.syncedDormant.includes('u.m:2 calls:s.X'))).toEqual([false, true, false, true, false, false, true, true]);
    expect(run.map((s) => s.syncedDormant.includes('u.m:3 calls:p::X'))).toEqual([false, true, false, true, false, false, true, true]);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('u.m u -calls-> p::X')))).toEqual([false, false, true, false, false, false, false, false]);
  }, 600_000);

  it('the last method of the name deleted beside a plain function of it puts every failed row to sleep, more than the retry takes', async () => {
    // Two classes' `X`: `s.X(1)` is ambiguous and stays failed while both
    // stand. The plain `X` answers every other class of call, so only the
    // member calls among its failed rows are judged again.
    const USERS = 510;
    const users: Record<string, string> = {};
    for (let i = 1; i <= USERS; i++) users[`users/u${i}.m`] = `function u${i}(s)\nr = s.X(1);\nend\n`;
    const initial = { ...users, 'lib/X.m': localFn('X'), 'M.m': cls('M', methods('X')), 'N.m': cls('N', methods('X')) };
    const steps: Files[] = [{ 'M.m': null, 'N.m': null }, { 'M.m': cls('M', methods('X')) }, { 'M.m': null }];
    const run = await syncedAndFreshEachStep(initial, ...steps);
    expectEachStepFresh(run, steps);
    expect(run.map((s) => s.syncedRows.length)).toEqual([0, 0, 0]);
    expect(run.map((s) => s.syncedDormant.length)).toEqual([USERS, 0, USERS]);
    expect(run[1]!.synced.filter((e) => e.includes(' -calls-> M::X @ M.m')).length).toBe(USERS);
  }, 600_000);
});

describe('MATLAB dormant rows: a built-in\'s call that only the path could give a project copy of', () => {
  // A startup's cfginit.m adds matlab/user1/commands with addpath(…, '-end'), so
  // MATLAB's own `sound` runs ahead of the project's copy there: no edge, and
  // the row is kept for a sync that moves the copy, but not counted.
  const SOUND = 'function sound(y)\nend\n';
  const startup = (where: string): string => `addpath('app');\naddpath('tools');\naddpath('lib');\naddpath('extra'${where});\n`;
  const FILES = {
    'startup.m': startup(", '-end'"),
    'app/play.m': 'function play(y)\nsound(y);\nend\n',
    'app/beepit.m': 'function beepit()\nsound\nend\n',
    'lib/tone.m': 'function tone()\nend\n',
    'tools/util.m': 'function util()\nend\n',
    'extra/sound.m': SOUND,
  };
  const DORMANT = ['app/beepit.m:2 calls:sound', 'app/play.m:2 calls:sound'];

  it('is dormant while the copy stands after MATLAB\'s own folders or off the path, and linked once it stands ahead of them', async () => {
    const after = await indexOfProject(FILES);
    expect(after.edges.filter((e) => e.startsWith('app/'))).toEqual([]);
    expect(after.unresolved).toEqual([]);
    expect(after.dormant).toEqual(DORMANT);
    const ahead = await indexOfProject({ ...FILES, 'startup.m': startup(", '-begin'") });
    expect(ahead.edges.filter((e) => e.startsWith('app/'))).toEqual([
      'app/beepit.m beepit -calls-> sound @ extra/sound.m',
      'app/play.m play -calls-> sound @ extra/sound.m',
    ]);
    expect([...ahead.unresolved, ...ahead.dormant]).toEqual([]);
    const off = await indexOfProject({ ...FILES, 'extra/sound.m': 'function other()\nend\n', 'old/sound.m': SOUND });
    expect([off.unresolved, off.dormant]).toEqual([[], DORMANT]);
  }, 120_000);

  it('stays live when a method carries the name, or when the copy is in the caller\'s own folder, which the current folder may put first', async () => {
    const r = await indexOfProject({
      ...FILES,
      // A method of the caller's own class: `sound(y)` there is MATLAB's, as resolution says, unless resolution missed an overload.
      'app/Spk.m': 'classdef Spk < handle\n    methods\n        function sound(obj)\n        end\n        function go(obj, y)\n            sound(y);\n        end\n    end\nend\n',
      // A caller beside the copy, in a folder the startup adds with '-end': run from that folder, MATLAB runs the copy.
      'extra/near.m': 'function near(y)\nsound(y);\nend\n',
      'extra/split.m': 'function split(s)\nend\n',
      'extra/cut.m': 'function cut(s)\nsplit(s);\nend\n',
      'app/cutter.m': 'function cutter(s)\nsplit(s);\nend\n',
    });
    expect(r.edges.filter((e) => / -calls-> (sound|split) /.test(e))).toEqual([]);
    // Spk's method carries `sound`: every call of it stays live.
    expect(r.unresolved).toEqual(['app/Spk.m:6 calls:sound', 'app/beepit.m:2 calls:sound', 'app/play.m:2 calls:sound', 'extra/cut.m:2 calls:split', 'extra/near.m:2 calls:sound']);
    // split: only a function file carries it; the caller in another folder is dormant, the one beside it live.
    expect(r.dormant).toEqual(['app/cutter.m:2 calls:split']);
  }, 120_000);

  it('a sync ends where a fresh index ends: the path flipped from -end to -begin and back, the copy moved onto and off the path, deleted, restored, behind a case variant, turned into a stub and a script', async () => {
    const steps: Files[] = [
      { 'startup.m': startup(", '-begin'") },
      { 'startup.m': startup(", '-end'") },
      { 'extra/sound.m': null, 'lib/sound.m': SOUND },
      { 'lib/sound.m': null, 'extra/sound.m': SOUND },
      { 'extra/sound.m': null, 'old/sound.m': SOUND },
      { 'old/sound.m': null },
      { 'extra/sound.m': SOUND },
      { 'startup.m': startup(", '-begin'") },
      // lib comes before tools on the path: its case variant vetoes the copy in tools, and stops when it goes.
      { 'extra/sound.m': null, 'tools/sound.m': SOUND },
      { 'lib/Sound.m': 'function Sound(y)\nend\n' },
      { 'lib/Sound.m': null },
      { 'tools/sound.m': null, 'extra/sound.m': SOUND },
      { 'extra/sound.m': '% SOUND  Help text of a MEX function.\n' },
      { 'extra/sound.m': 'y = 1;\n' },
      { 'extra/sound.m': SOUND },
    ];
    const run = await expectSyncsFresh(FILES, steps);
    const linked = run.map((s) => s.synced.filter((e) => e.startsWith('app/')).map((e) => e.slice(0, e.indexOf(' '))).join(','));
    const both = 'app/beepit.m,app/play.m';
    expect(linked).toEqual([both, '', both, '', '', '', '', both, both, '', both, both, '', 'app/beepit.m', both]);
    // Dormant only where MATLAB's own function wins: the copy after MATLAB's own folders, off the path or gone. A copy
    // ahead of them that the call still did not link (vetoed by a case variant, a stub of a MEX function, a script
    // called with arguments) leaves the row live.
    expect(run.map((s) => s.syncedDormant.length)).toEqual([0, 2, 0, 2, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(run.map((s) => s.syncedRows.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 1, 0]);
  }, 600_000);
});

describe('MATLAB dormant rows: a built-in\'s call stays live where a project copy, not MATLAB\'s own function, comes first', () => {
  it('a script ahead on the path called with arguments: MATLAB errors, and the row stays live', async () => {
    const r = await indexOfProject({
      'startup.m': "addpath(fullfile(pwd, 'app'));\naddpath(fullfile(pwd, 'lib'));\n",
      'app/p.m': 'function p()\nsound(1, 8192);\nend\n',
      'lib/sound.m': 'y = 1;\n',
    });
    expect([r.unresolved, r.dormant]).toEqual([['app/p.m:2 calls:sound'], []]);
  });

  it('a name MATLAB has only as a method, its only copy out of reach: no built-in, the row stays live', async () => {
    // tk_realign.m calls scale and translate on doubles; the copies are in private/ folders it cannot reach.
    const r = await indexOfProject({
      'compat/obsolete/tk_realign.m': 'function tk_realign(s)\nT = translate([1 2 3]);\nS = scale([2 2 2]);\nend\n',
      'utilities/private/scale.m': 'function S = scale(f)\nS = diag([f 1]);\nend\n',
      'private/translate.m': 'function T = translate(f)\nT = eye(4);\nend\n',
    });
    expect([r.unresolved, r.dormant]).toEqual([['compat/obsolete/tk_realign.m:2 calls:translate', 'compat/obsolete/tk_realign.m:3 calls:scale'], []]);
  });
});

describe('MATLAB dormant rows: a name MATLAB has only as a method of one of its classes', () => {
  // `p = inputParser; … parse(p, varargin{:})`; `keys(m)` on a containers.Map.
  const USER = { 'u.m': 'function u(varargin)\np = inputParser;\nparse(p, varargin{:});\nk = keys(varargin{1});\nnosuch_fn(k);\nend\n' };
  const PARSE = 'function r = parse(p, varargin)\nr = p;\nend\n';

  it('keeps a call of one no project symbol carries dormant, a call leaving the index for MATLAB\'s class', async () => {
    const r = await indexOfProject(USER);
    expect(r.edges.filter((e) => e.startsWith('u.m '))).toEqual([]);
    expect(r.unresolved).toEqual(['u.m:5 calls:nosuch_fn']);
    expect(r.dormant).toEqual(['u.m:3 calls:parse', 'u.m:4 calls:keys']);
  });

  it('keeps one dormant when only a MATLAB property, a Java method or a C++ method is named for it: none answers a bare MATLAB call', async () => {
    const files = {
      'app/uk.m': 'function uk(m, d)\nk = keys(m);\nv = values(m);\nr = read(d, 3, \'uint8\');\nend\n',
      'lib/K.m': cls('K', props('keys')),
      'tools/Store.java': 'public class Store {\n  public int values() { return 0; }\n}\n',
      'hwlink/dev.cpp': 'class Dev {\npublic:\n  int read(int n) { return n; }\n};\n',
    };
    const r = await indexOfProject(files);
    expect([r.unresolved, r.dormant]).toEqual([[], ['app/uk.m:2 calls:keys', 'app/uk.m:3 calls:values', 'app/uk.m:4 calls:read']]);
    // The property turned into a method carries `keys`: that row is live while it does.
    const steps: Files[] = [{ 'lib/K.m': cls('K', methods('keys')) }, { 'lib/K.m': cls('K', props('keys')) }, { 'lib/K.m': null }, { 'tools/Store.java': null }];
    const run = await expectSyncsFresh(files, steps);
    expect(run.map((s) => s.syncedRows)).toEqual([['app/uk.m:2 calls:keys'], [], [], []]);
  }, 300_000);

  it('a sync ends where a fresh index ends: a project parse.m added, then removed', async () => {
    const steps: Files[] = [{ 'lib/parse.m': PARSE }, { 'lib/parse.m': null }, { 'lib/parse.m': PARSE }];
    const run = await expectSyncsFresh(USER, steps);
    expect(run.map((s) => s.synced.includes('u.m u -calls-> parse @ lib/parse.m'))).toEqual([true, false, true]);
    expect(run.map((s) => s.syncedDormant)).toEqual([['u.m:4 calls:keys'], ['u.m:3 calls:parse', 'u.m:4 calls:keys'], ['u.m:4 calls:keys']]);
    expect(run.every((s) => s.syncedRows.length === 1)).toBe(true);
  }, 300_000);
});

describe('MATLAB dormant rows: only a MATLAB symbol that could answer a bare call keeps a built-in\'s call', () => {
  // A C++ method `error` (in a `.cpp` file) kept calls of
  // `error` live in files whose imports keep every bare call at extraction;
  // a toolbox's class: a property `grid` kept calls of `grid`. A MATLAB
  // call resolves to MATLAB alone, and a bare one never runs a property.
  const FILES = {
    'hwlink/Amp.cpp': 'class StreamClient {\npublic:\n  void error(const char* m) {}\n};\n',
    'brain/progress.m': "function progress()\nimport org.acme.icon.*;\nerror('x');\nend\n",
    'Plotter.m': cls('Plotter', props('grid') + '    methods\n        function draw(obj)\n            grid(\'on\');\n        end\n    end\n'),
    'useGrid.m': "function useGrid()\nimport org.foo.*;\ngrid('on');\nend\n",
  };
  const withMethod = cls('Plotter', '    methods\n        function grid(obj, v)\n        end\n        function draw(obj)\n            grid(\'on\');\n        end\n    end\n');

  it('keeps no row of a built-in\'s call that only a C++ method or a MATLAB property is named for', async () => {
    const r = await indexOfProject(FILES);
    expect([r.unresolved, r.dormant]).toEqual([[], []]);
    expect(r.edges.filter((e) => / -calls-> (error|grid) /.test(e))).toEqual([]);
  });

  it('a sync ends where a fresh index ends: a MATLAB function of the name added and removed, the property turned into a method and back', async () => {
    const steps: Files[] = [
      { 'lib/error.m': 'function error(m)\nend\n' },
      { 'lib/error.m': null },
      { 'lib/grid.m': 'function grid(v)\nend\n' },
      { 'lib/grid.m': null },
      { 'Plotter.m': withMethod },
      { 'Plotter.m': FILES['Plotter.m'] },
    ];
    const run = await expectSyncsFresh(FILES, steps);
    expect(run[0]!.synced).toContain('brain/progress.m progress -calls-> error @ lib/error.m');
    expect(run[2]!.synced).toEqual(expect.arrayContaining(['useGrid.m useGrid -calls-> grid @ lib/grid.m', 'Plotter.m Plotter::draw -calls-> grid @ lib/grid.m']));
    // The method carries `grid`: both calls stay live, the class's overload possibly missed.
    expect(run[4]!.syncedRows).toEqual(['Plotter.m:6 calls:grid', 'useGrid.m:3 calls:grid']);
    expect(run.filter((_, i) => i !== 4).every((s) => s.syncedRows.length === 0 && s.syncedDormant.length === 0)).toBe(true);
  }, 600_000);
});
