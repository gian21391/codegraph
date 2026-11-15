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

const COLOR_BLOB = 'V1MCC4000MEC1000MCR1000x\u0001\u0000\u0000KÊ^\nÆ}R';
const OCTAVE = '## Copyright (C) 2000 Paul Kienzle\n## -*- texinfo -*-\nfunction r = color()\n  r = 1;\nendfunction\n';
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
      { 'setup_conf.m': null, 'setup_cfg.m': '## Copyright (C) 2000 Paul Kienzle\n## SETUP_CFG\n1;\n' },
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
      // A property carries a member call written with arguments.
      { 'models/Model.m': cls('Model', props('recalib') + methods('reset')) },
      { 'models/Model.m': null },
    ];
    const run = await expectSyncsFresh(BASE, steps);
    expect(run.map((s) => s.synced.some((e) => e.startsWith('user.m user -calls-> Model::recalib')))).toEqual([true, false, true, true, false, false, false]);
    expect(run.map((s) => s.syncedDormant.includes('user.m:8 calls:a.recalib'))).toEqual([false, true, false, false, true, false, true]);
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
    const body = Array.from({ length: 255 }, (_, i) => `  a${i} = getao;\n`).join('');
    const GETAO = 'function ao = getao()\n ao = 1;\nend\n';
    const initial = { 'getao.m': GETAO, 'u1.m': `function u1()\n${body}end\n`, 'u2.m': `function u2()\n${body}end\n` };
    const steps: Files[] = [
      { 'getao.m': null, 'web/getao.js': 'export function getao() { return 2; }\n' }, // carried, unlinked: failed
      { 'getao.m': GETAO, 'web/getao.js': null }, // linked again, every one
    ];
    const run = await expectSyncsFresh(initial, steps);
    expect(run.map((s) => s.syncedRows.length)).toEqual([510, 0]);
    expect(run[1]!.synced.filter((e) => e.endsWith('-calls-> getao @ getao.m')).length).toBe(510);
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
    const OCT = '## Copyright (C) 2000 Paul Kienzle\n## -*- texinfo -*-\n1;\n';
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
    const run = await killedEachStep({ 'beeper.m': 'function beeper()\nbeep\nend\n' }, steps);
    expectEachStepFresh(run, steps.map((s) => s.kill));
    expect(run[0]!.synced).toContain('beeper.m beeper -calls-> beep @ tools/beep.m');
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
