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
import { allEdges, tempDir, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

describe('MATLAB sync converges on a fresh index', () => {
  /** Index `initial`, apply each step with a sync, and return the synced edges and a fresh index's of the final files. */
  async function syncedAndFresh(initial: Record<string, string>, ...steps: Array<Record<string, string | null>>): Promise<{ steps: string[][]; synced: string[]; fresh: string[] }> {
    const root = tempDir('cg-matlab-sync-');
    const freshRoot = tempDir('cg-matlab-fresh-');
    const final: Record<string, string | null> = { ...initial };
    writeTree(root, initial);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const seen: string[][] = [allEdges(cg)];
      for (const step of steps) {
        writeTree(root, step);
        Object.assign(final, step);
        await cg.sync();
        seen.push(allEdges(cg));
      }
      writeTree(freshRoot, Object.fromEntries(Object.entries(final).filter(([, c]) => c !== null)));
      const fresh = await CodeGraph.init(freshRoot, { index: true });
      try {
        return { steps: seen, synced: seen[seen.length - 1]!, fresh: allEdges(fresh) };
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
      // A call written with arguments that resolves to nothing stays; the bare reads nothing defines go.
      expect(fresh).toEqual(['main.m:4 missing_fn failed']);

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
      // to go, though the file is no MATLAB file any more.
      calls.length = 0;
      writeTree(root, { 'setup_paths.m': '#import <Foundation/Foundation.h>\n@implementation Setup\n- (void)go {\n}\n@end\n' });
      await cg.sync();
      expect(cg.getFiles().find((f) => f.path === 'setup_paths.m')?.language).toBe('objc');
      expect(allEdges(cg).filter((e) => e.startsWith('main.m '))).toEqual([]);
      expect(calls).toEqual([[['setup_paths.m'], ['setup_paths.m']]]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
