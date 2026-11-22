/**
 * Keeps the MATLAB sync fuzzer (scripts/matlab/fuzz/) from rotting: a fixed
 * seed's few cases and edits run clean with every oracle, a seed always makes
 * the same project, the shrinker's delta debugging finds a minimal list, and
 * the robust oracle sees the crashes the product swallows (a stored
 * extraction exception, a message reporting a caught exception, a result
 * that records one) without counting an ordinary parse error or warning.
 * The fuzzer itself drives the built library (dist/, which the suite's global
 * setup builds); its real runs are `node scripts/matlab/fuzz/run.mjs`, not
 * part of `npm test`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import { tempDir } from './matlab-helpers';

const out = tempDir('cg-matlab-fuzz-smoke-');
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

describe('MATLAB sync fuzzer (smoke)', () => {
  it('makes the same project and edits from the same seed, and another from another', async () => {
    const { caseSetup } = await import('../scripts/matlab/fuzz/fuzz.mjs');
    const { mutate } = await import('../scripts/matlab/fuzz/mutate.mjs');
    const draw = (seed: number) => {
      const s = caseSetup(seed, 3, { bigEvery: 0 });
      return JSON.stringify([s.files, mutate(s.mutRng, s.files)], (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('base64') : v));
    };
    expect(draw(11)).toBe(draw(11));
    expect(draw(11)).not.toBe(draw(12));
  });

  it('shrinks a list to the items a failure needs', async () => {
    const { ddmin, makeBudget } = await import('../scripts/matlab/fuzz/shrink.mjs');
    const items = Array.from({ length: 20 }, (_, i) => i);
    const kept = await ddmin(items, async (l: number[]) => l.includes(7) && l.includes(13), makeBudget(500, 10_000));
    expect(kept).toEqual([7, 13]);
  });

  it('counts a stored extraction exception as a robust failure, and an ordinary parse error not', async () => {
    const { checkStored } = await import('../scripts/matlab/fuzz/fuzz.mjs');
    const dump = (errors: unknown[]) => ({ files: [{ file: 'f.m', errors }], nodes: [], edges: [], rows: [], dormant: [] });
    const parseError = { code: 'parse_error', severity: 'warning', message: 'Syntax error at line 2' };
    expect(() => checkStored(dump([parseError]), 'a fresh index')).not.toThrow();
    let err: (Error & { stored?: boolean }) | undefined;
    try {
      checkStored(dump([parseError, { code: 'parse_error', severity: 'error', message: 'Parse error: boom' }]), 'a fresh index');
    } catch (e) {
      err = e as Error & { stored?: boolean };
    }
    expect(err?.stored).toBe(true);
    expect(err?.message).toBe('an extraction exception is stored: f.m: Parse error: boom');
  });

  it('counts a message reporting a caught exception, on any channel, and a result recording one, as robust failures', async () => {
    const { loadLibrary, logOf, timed } = await import('../scripts/matlab/fuzz/harness.mjs');
    const lib = await loadLibrary();
    const log = logOf(lib);
    const said = async (fn: () => void, opts: { configValid?: boolean; result?: unknown } = {}) => {
      log.configValid = opts.configValid ?? true;
      try {
        await timed('an operation', 0, async () => {
          fn();
          return { value: null, result: opts.result };
        }, lib, { hasResult: true });
        return null;
      } catch (e) {
        return String((e as Error).message);
      }
    };
    const logger = lib.getLogger();
    expect(await said(() => logger.warn('No MATLAB search path: evaluating the startup code failed: boom'))).toBe('an operation reported a caught exception (warn): No MATLAB search path: evaluating the startup code failed: boom');
    expect(await said(() => logger.debug('Parallel resolution failed; falling back to sequential', { error: 'x' }))).toMatch(/^an operation reported a caught exception \(debug\): Parallel resolution failed/);
    expect(await said(() => console.log('[worker] Retrying 1 files that failed due to WASM memory errors or timeouts...'))).toMatch(/^an operation reported a caught exception \(verbose\): \[worker\] Retrying 1 files/);
    expect(await said(() => undefined, { result: { success: true, errors: [], failedFilePaths: ['f.m'] } })).toBe("an operation's result records a problem: files not absorbed: f.m");
    // Not failures: an ordinary warning, the verbose log's own chatter, a parse warning in a result, and a startup-code
    // warning while the startup code is not the generator's own (its broken-config mode).
    expect(await said(() => logger.warn('Ignoring codegraph.json: not valid JSON', { file: 'x' }))).toBe(null);
    expect(await said(() => console.log('[worker] Parse worker pool: up to 3 worker(s)'))).toBe(null);
    expect(await said(() => undefined, { result: { success: true, errors: [{ code: 'parse_error', severity: 'warning', message: 'Syntax error' }] } })).toBe(null);
    expect(await said(() => logger.warn('No MATLAB search path: startup.m:1: the code does not parse: no path is set'), { configValid: false })).toBe(null);
    expect(await said(() => logger.warn('No MATLAB search path: startup.m:1: the code does not parse: no path is set'))).toMatch(/caught exception \(warn\)/);
    log.configValid = true;
  });

  it('runs a fixed seed clean with every oracle', async () => {
    const { parseArgs, runFuzz } = await import('../scripts/matlab/fuzz/run.mjs');
    const lines: string[] = [];
    const summary = await runFuzz(parseArgs(['--seed', '3', '--cases', '2', '--steps', '2', '--big-every', '0', '--no-shrink', '--out', out]), (l: string) => lines.push(l));
    expect(summary.failures, lines.join('\n')).toEqual([]);
    expect(summary.cases).toBe(2);
    expect(summary.edits).toBe(4);
  }, 120_000);
});
