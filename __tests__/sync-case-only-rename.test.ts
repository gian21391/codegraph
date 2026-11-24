/**
 * A case-only rename in a git repository, on a file system that ignores case
 * (macOS's APFS, Windows' NTFS). Git ignores case there too
 * (`core.ignorecase`): after a plain `mv lib/shift.m lib/Shift.m` it still
 * lists the old spelling and `git status` stays clean. Every way the index
 * learns of files must take the name on disk, so that a watcher's scoped
 * sync, a full sync and a fresh index end in one place, and the status that
 * `git status` drives sees the rename: a file, a TypeScript file, and a
 * folder renamed by case. Each test probes the temp dir and runs only where
 * names ignore case.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { allEdges, dormantRows, tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** Whether the file system of the temp dir ignores case in names. */
const caseInsensitive = ((): boolean => {
  const dir = tempDir('cg-case-probe-');
  try {
    fs.writeFileSync(path.join(dir, 'probe.txt'), '');
    return fs.existsSync(path.join(dir, 'PROBE.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A git repository of `files`, one commit, indexed. */
async function committedProject(prefix: string, files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = tempDir(prefix);
  writeTree(root, files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

/** `mv from to` through a temporary name, as a user renames by case alone. */
function renameByCase(root: string, from: string, to: string): void {
  fs.renameSync(path.join(root, from), path.join(root, `${from}.tmp`));
  fs.renameSync(path.join(root, `${from}.tmp`), path.join(root, to));
}

/** What the status sees, each list sorted. */
function changes(cg: CodeGraph): { added: string[]; modified: string[]; removed: string[] } {
  const c = cg.getChangedFiles();
  return { added: [...c.added].sort(), modified: [...c.modified].sort(), removed: [...c.removed].sort() };
}

/** What a sync must end with: the files, every edge, the rows. */
function state(cg: CodeGraph, root: string): { files: string[]; edges: string[]; rows: string[]; dormant: string[] } {
  return { files: cg.getFiles().map((f) => f.path).sort(), edges: allEdges(cg), rows: unresolvedRows(root), dormant: dormantRows(root) };
}

/** A fresh index of a copy of the tree as it is now, its `.git` included (which still lists the old spelling). */
async function freshState(root: string): Promise<ReturnType<typeof state>> {
  const copy = tempDir('cg-case-rename-fresh-');
  try {
    fs.cpSync(root, copy, { recursive: true });
    fs.rmSync(path.join(copy, '.codegraph'), { recursive: true, force: true });
    const fresh = await CodeGraph.init(copy, { index: true });
    try {
      return state(fresh, copy);
    } finally {
      fresh.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

describe('a case-only rename in a git repository', () => {
  it.runIf(caseInsensitive)('of a MATLAB file: a watcher sync, a full sync and a watcher sync again each end where a fresh index does, and the status sees it', async () => {
    // The call of `shift` in `lib/` fails once its folder holds `Shift.m`: a
    // file whose name differs only by case vetoes it (matlab-lookup.ts).
    const { root, cg } = await committedProject('cg-case-rename-m-', {
      'shift.m': 'function y = shift(x)\ny = x;\nend\n',
      'helper.m': 'function y = helper(x)\ny = x;\nend\n',
      'lib/shift.m': 'a = 1;\n',
      'lib/use.m': 'function use()\nv = shift(1);\nshift\nend\n',
      'lib/k.m': 'function k()\nz = helper(2);\nend\n',
    });
    try {
      expect(allEdges(cg)).toContain('lib/use.m use -calls-> lib/shift.m @ lib/shift.m');
      renameByCase(root, 'lib/shift.m', 'lib/Shift.m');
      expect(git(root, 'status', '--porcelain', '--', 'lib')).toBe('');
      expect(changes(cg)).toEqual({ added: ['lib/Shift.m'], modified: [], removed: ['lib/shift.m'] });
      const fresh = await freshState(root);
      expect(fresh.files).toContain('lib/Shift.m');
      expect(fresh.files).not.toContain('lib/shift.m');
      await cg.sync({ paths: ['lib/shift.m', 'lib/Shift.m'] });
      expect(state(cg, root), 'watcher sync').toEqual(fresh);
      await cg.sync();
      expect(state(cg, root), 'full sync').toEqual(fresh);
      await cg.sync({ paths: ['lib/shift.m', 'lib/Shift.m'] });
      expect(state(cg, root), 'watcher sync again').toEqual(fresh);
      expect(changes(cg)).toEqual({ added: [], modified: [], removed: [] });
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(caseInsensitive)('of a MATLAB file, synced in full first: it ends where a fresh index does', async () => {
    const { root, cg } = await committedProject('cg-case-rename-m-full-', {
      'shift.m': 'function y = shift(x)\ny = x;\nend\n',
      'lib/shift.m': 'a = 1;\n',
      'lib/use.m': 'function use()\nv = shift(1);\nshift\nend\n',
    });
    try {
      renameByCase(root, 'lib/shift.m', 'lib/Shift.m');
      const fresh = await freshState(root);
      await cg.sync();
      expect(state(cg, root)).toEqual(fresh);
      expect(state(cg, root).files).toContain('lib/Shift.m');
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(caseInsensitive)('of a TypeScript file: each sync ends where a fresh index does, and the status sees it', async () => {
    const { root, cg } = await committedProject('cg-case-rename-ts-', {
      'src/Foo.ts': 'export function foo() { return 1; }\n',
      'src/bar.ts': 'import { foo } from "./Foo";\nexport function bar() { return foo(); }\n',
    });
    try {
      renameByCase(root, 'src/Foo.ts', 'src/foo.ts');
      expect(changes(cg)).toEqual({ added: ['src/foo.ts'], modified: [], removed: ['src/Foo.ts'] });
      const fresh = await freshState(root);
      expect(fresh.files).toEqual(['src/bar.ts', 'src/foo.ts']);
      await cg.sync({ paths: ['src/Foo.ts', 'src/foo.ts'] });
      expect(state(cg, root), 'watcher sync').toEqual(fresh);
      await cg.sync();
      expect(state(cg, root), 'full sync').toEqual(fresh);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(caseInsensitive)('of a folder: a full sync and a watcher sync end where a fresh index does, and the status sees it', async () => {
    const { root, cg } = await committedProject('cg-case-rename-dir-', {
      'shift.m': 'function y = shift(x)\ny = x;\nend\n',
      'helper.m': 'function y = helper(x)\ny = x;\nend\n',
      'lib/shift.m': 'a = 1;\n',
      'lib/use.m': 'function use()\nv = shift(1);\nshift\nend\n',
      'lib/k.m': 'function k()\nz = helper(2);\nend\n',
    });
    try {
      renameByCase(root, 'lib', 'Lib');
      expect(changes(cg)).toEqual({
        added: ['Lib/k.m', 'Lib/shift.m', 'Lib/use.m'],
        modified: [],
        removed: ['lib/k.m', 'lib/shift.m', 'lib/use.m'],
      });
      const fresh = await freshState(root);
      expect(fresh.files).toEqual(['Lib/k.m', 'Lib/shift.m', 'Lib/use.m', 'helper.m', 'shift.m']);
      await cg.sync();
      expect(state(cg, root), 'full sync').toEqual(fresh);
      await cg.sync({ paths: ['lib/shift.m', 'Lib/shift.m', 'lib/use.m', 'Lib/use.m'] });
      expect(state(cg, root), 'watcher sync').toEqual(fresh);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the scans of a git repository', () => {
  // Framework detection with no list, the sparse-checkout diff and the
  // status's fallback read the sync scan, a fresh index and a full sync the
  // async one: both take the name on disk.
  it.runIf(caseInsensitive)('list a file renamed by case under its name on disk, the sync scan as the async one', async () => {
    const { root, cg } = await committedProject('cg-case-rename-scan-', {
      'lib/shift.m': 'a = 1;\n',
      'lib/use.m': 'function use()\nv = 1;\nend\n',
    });
    try {
      renameByCase(root, 'lib/shift.m', 'lib/Shift.m');
      expect(git(root, 'ls-files')).toContain('lib/shift.m');
      expect(scanDirectory(root).sort()).toEqual(['lib/Shift.m', 'lib/use.m']);
      expect((await scanDirectoryAsync(root)).sort()).toEqual(['lib/Shift.m', 'lib/use.m']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * An import whose path differs from the disk's only by case, on a file system
 * that ignores case: Node and a bundler load `./Src/a` from `src/a.ts` there,
 * so the import binds to that file, the one the index keys by its name on
 * disk, and never falls back to a same-named function elsewhere.
 */
describe('an import spelled with another case than the disk', () => {
  const TSIMP = {
    'main.ts': "import { a } from './Src/a';\nexport function main(): number { return a(); }\n",
    'other/a.ts': 'export function a(): number { return 2; }\n',
  };

  it.runIf(caseInsensitive)('in a git repository, after the folder is renamed by case: the call links the imported file, and a sync ends where a fresh index does', async () => {
    const { root, cg } = await committedProject('cg-case-import-git-', { ...TSIMP, 'Src/a.ts': 'export function a(): number { return 1; }\n' });
    try {
      expect(allEdges(cg)).toContain('main.ts main -calls-> a @ Src/a.ts');
      renameByCase(root, 'Src', 'src');
      expect(git(root, 'status', '--porcelain', '--', 'Src', 'src')).toBe('');
      const fresh = await freshState(root);
      expect(fresh.files).toEqual(['main.ts', 'other/a.ts', 'src/a.ts']);
      expect(fresh.edges).toContain('main.ts main -calls-> a @ src/a.ts');
      expect(fresh.edges).not.toContain('main.ts main -calls-> a @ other/a.ts');
      await cg.sync();
      expect(state(cg, root), 'full sync').toEqual(fresh);
      writeTree(root, { 'main.ts': `${TSIMP['main.ts']}// edited\n` });
      await cg.sync({ paths: ['main.ts'] });
      const fresh2 = await freshState(root);
      expect(fresh2.edges).toContain('main.ts main -calls-> a @ src/a.ts');
      expect(state(cg, root), 'watcher sync').toEqual(fresh2);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(caseInsensitive)('in a project with no git: the call links the imported file, and a sync ends where a fresh index does', async () => {
    const root = tempDir('cg-case-import-plain-');
    writeTree(root, { ...TSIMP, 'src/a.ts': 'export function a(): number { return 1; }\n' });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toContain('main.ts main -calls-> a @ src/a.ts');
      expect(allEdges(cg)).not.toContain('main.ts main -calls-> a @ other/a.ts');
      writeTree(root, { 'main.ts': `${TSIMP['main.ts']}// edited\n`, 'other/a.ts': 'export function a(): number { return 3; }\n' });
      await cg.sync();
      const fresh = await freshState(root);
      expect(fresh.edges).toContain('main.ts main -calls-> a @ src/a.ts');
      expect(state(cg, root)).toEqual(fresh);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a path a watcher or a caller reports', () => {
  it('is taken as the index names files, however it is spelled: `./`, `..`, a separator doubled', async () => {
    const root = tempDir('cg-scoped-path-forms-');
    writeTree(root, { 'lib/k.m': 'function k()\nz = helper(2);\nend\n', 'helper.m': 'function y = helper(x)\ny = x;\nend\n' });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      writeTree(root, { 'lib/k.m': 'function k()\nz = helper(3);\nw = helper(4);\nend\n' });
      const r = await cg.sync({ paths: ['./lib/k.m', 'lib/../lib/k.m', 'lib//k.m', '../outside.m'] });
      expect(r.changedFilePaths).toEqual(['lib/k.m']);
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['helper.m', 'lib/k.m']);
      expect(allEdges(cg).filter((e) => e.startsWith('lib/k.m '))).toEqual([
        'lib/k.m k -calls-> helper @ helper.m',
        'lib/k.m k -calls-> helper @ helper.m',
      ]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
