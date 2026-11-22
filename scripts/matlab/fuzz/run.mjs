#!/usr/bin/env node
/**
 * The MATLAB sync fuzzer's CLI. It drives the built library (dist/), in
 * process; build first (`npm run build`). Not part of `npm test`
 * (__tests__/matlab-fuzz-smoke.test.ts runs a few fixed cases of it).
 *
 *   node scripts/matlab/fuzz/run.mjs --seed N --cases K --steps M [--oracle sync,noop,…] [--out dir]
 *
 * Options:
 *   --seed N            the run's seed (default 1); case k's project and edits come from (N, k) alone
 *   --cases K           cases to run (default 10), from --first-case (default 0)
 *   --case k            run case k only (what a failure's reproduce line says)
 *   --steps M           edits per case (default 10)
 *   --oracle list       sync, noop, determinism, metamorphic, robust (default: all)
 *   --out dir           findings and the summary go here (default: matlab-fuzz-out in the OS temp folder); scratch projects in <out>/work
 *   --big-every B       every B-th case adds a big file of broken text or deep nesting (default 10; 0: none)
 *   --budget-ms ms      the time budget of one index or sync (default 20000, plus 150 ms per KB of the big file)
 *   --time-limit-min T  start no case after T minutes;  --max-steps S: start no case after S edits in all
 *   --stop-after F      stop after F failures (a mutant hunt: --stop-after 1)
 *   --no-shrink         report failures unshrunk;  --shrink-evals E / --shrink-min T bound the shrinker (300 / 15)
 *   --dist dir          the built library to drive (default: this checkout's dist/)
 *   --baseline-dist dir a mutant hunt: a failure the case also has on this build is the baseline's, logged and passed over,
 *                       and the shrinker keeps only candidates this build passes
 *   --profile p         default, or classes: every project gets a class-folder guess motif, and edits favour class files
 *   --generator-version V  the generator version a reproduce line was printed by: a warning when it is not this one's
 *                       (the seed then draws another case)
 *
 * Every failure prints the line that reproduces it from its seed, and (shrunk)
 * is written as a ready catalog case under <out>/findings/<id>/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORACLES, runCase } from './fuzz.mjs';
import { DEFAULT_DIST, loadLibrary, renderDiff } from './harness.mjs';
import { GENERATOR_VERSION } from './generate.mjs';
import { shrinkFailure, writeFinding } from './shrink.mjs';

export function parseArgs(argv) {
  const o = { seed: 1, cases: 10, firstCase: 0, steps: 10, oracles: [...ORACLES], out: path.join(os.tmpdir(), 'matlab-fuzz-out'), bigEvery: 10, budgetMs: 20_000, shrink: true, shrinkEvals: 300, shrinkMin: 15, dist: DEFAULT_DIST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--seed') o.seed = Number(v());
    else if (a === '--cases') o.cases = Number(v());
    else if (a === '--first-case') o.firstCase = Number(v());
    else if (a === '--case') { o.firstCase = Number(v()); o.cases = 1; o.only = true; }
    else if (a === '--steps') o.steps = Number(v());
    else if (a === '--oracle') o.oracles = v().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--out') o.out = v();
    else if (a === '--big-every') o.bigEvery = Number(v());
    else if (a === '--budget-ms') o.budgetMs = Number(v());
    else if (a === '--time-limit-min') o.timeLimitMin = Number(v());
    else if (a === '--max-steps') o.maxSteps = Number(v());
    else if (a === '--stop-after') o.stopAfter = Number(v());
    else if (a === '--no-shrink') o.shrink = false;
    else if (a === '--shrink-evals') o.shrinkEvals = Number(v());
    else if (a === '--shrink-min') o.shrinkMin = Number(v());
    else if (a === '--dist') o.dist = path.resolve(v());
    else if (a === '--baseline-dist') o.baselineDist = path.resolve(v());
    else if (a === '--profile') o.profile = v();
    else if (a === '--generator-version') o.generatorVersion = Number(v());
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.profile && !['default', 'classes'].includes(o.profile)) throw new Error(`unknown profile ${o.profile} (known: default, classes)`);
  for (const x of o.oracles) if (!ORACLES.includes(x)) throw new Error(`unknown oracle ${x} (known: ${ORACLES.join(', ')})`);
  return o;
}

/** A difference with at most `n` entries per side of a section (the summary's copy; repro.txt has the rest). */
function capDiff(diff, n = 100) {
  if (!diff) return undefined;
  return Object.fromEntries(Object.entries(diff).map(([s, { onlyA, onlyB }]) => [s, { onlyA: onlyA.slice(0, n), onlyB: onlyB.slice(0, n), ...(onlyA.length > n || onlyB.length > n ? { counts: [onlyA.length, onlyB.length] } : {}) }]));
}

/** The command line that reproduces case `k` of a run with options `o`. */
export function reproduceCommand(o, k) {
  const oracle = o.oracles.length === ORACLES.length ? '' : ` --oracle ${o.oracles.join(',')}`;
  const dist = path.resolve(o.dist) === path.resolve(DEFAULT_DIST) ? '' : ` --dist ${o.dist}`;
  const prof = o.profile && o.profile !== 'default' ? ` --profile ${o.profile}` : '';
  return `node scripts/matlab/fuzz/run.mjs --generator-version ${GENERATOR_VERSION} --seed ${o.seed} --case ${k} --steps ${o.steps} --big-every ${o.bigEvery}${prof}${oracle}${o.budgetMs !== 20_000 ? ` --budget-ms ${o.budgetMs}` : ''}${dist}`;
}

/**
 * Runs the fuzzer with options `o` (parseArgs' shape). `log` gets each
 * progress line. Resolves to the summary it also writes to <out>/summary.json.
 */
export async function runFuzz(o, log = (s) => console.log(s)) {
  if (o.generatorVersion !== undefined && o.generatorVersion !== GENERATOR_VERSION) {
    log(`warning: this line was printed by generator version ${o.generatorVersion}, and this is version ${GENERATOR_VERSION}: the seed draws another case, so it does not reproduce what was printed`);
  }
  const lib = await loadLibrary(o.dist);
  const baseLib = o.baselineDist ? await loadLibrary(o.baselineDist) : null;
  const out = path.resolve(o.out);
  const work = path.join(out, 'work');
  fs.mkdirSync(work, { recursive: true });
  const opts = { steps: o.steps, oracles: o.oracles, work, bigEvery: o.bigEvery, profile: o.profile, budgetMs: o.budgetMs, shrinkEvals: o.shrinkEvals, shrinkMs: o.shrinkMin * 60_000, baseLib };
  const t0 = Date.now();
  const summary = { generatorVersion: GENERATOR_VERSION, seed: o.seed, steps: o.steps, oracles: o.oracles, dist: o.dist, cases: 0, edits: 0, failures: [], baselineFailures: [], ms: 0 };
  // Shrinking and baseline replays, left out of when a failure was found.
  let overheadMs = 0;
  for (let k = o.firstCase; k < o.firstCase + o.cases; k++) {
    if (o.timeLimitMin && Date.now() - t0 > o.timeLimitMin * 60_000) break;
    if (o.maxSteps && summary.edits >= o.maxSteps) break;
    if (o.stopAfter && summary.failures.length >= o.stopAfter) break;
    const run = await runCase(lib, o.seed, k, opts);
    summary.cases++;
    summary.edits += run.stats.steps;
    const f = run.failure;
    const head = `case ${k}: ${run.stats.files} files${run.stats.bigMode ? ` + big ${run.stats.bigMode} ${run.stats.kb} KB` : ''}, ${run.stats.steps} edits, ${run.stats.ms} ms`;
    if (!f) {
      log(`${head}: ok`);
      continue;
    }
    if (baseLib) {
      const tb = Date.now();
      const base = await runCase(baseLib, o.seed, k, opts);
      overheadMs += Date.now() - tb;
      if (base.failure && base.failure.step <= f.step) {
        summary.baselineFailures.push({ case: k, oracle: base.failure.oracle, step: base.failure.step });
        log(`${head}: fails at step ${f.step} (${f.oracle}), and so does the baseline at step ${base.failure.step} (${base.failure.oracle}): passed over`);
        continue;
      }
    }
    const id = `s${o.seed}-c${k}-${f.oracle}`;
    const command = reproduceCommand(o, k);
    log(`${head}: FAIL ${f.oracle}${f.spec ? ` (${f.spec.kind})` : ''} at step ${f.step}${f.where && f.oracle === 'robust' ? ` in ${f.where}: ${f.message}` : ''}`);
    log(`  reproduce: ${command}`);
    if (f.step > 0) log(`  last edit: ${run.edits[f.step - 1]?.desc}`);
    if (f.diff) log(renderDiff(f.diff, f.names[0], f.names[1], 6));
    // When it was found: the run's time and edits so far (shrinking excluded), and this case's.
    // The original difference, kept whole in the summary: a finding is triaged by it, not by its shrunk shape.
    const entry = { id, case: k, oracle: f.oracle, variant: f.spec?.kind, step: f.step, where: f.where, message: f.message, command, lastEdit: f.step > 0 ? run.edits[f.step - 1]?.desc : undefined, diff: capDiff(f.diff), warnings: f.warnings, atRunMs: Date.now() - t0 - overheadMs, atRunEdits: summary.edits, caseMs: run.stats.ms };
    if (o.shrink) {
      const shrunk = await shrinkFailure(lib, run, opts);
      const dir = writeFinding(path.join(out, 'findings'), id, run, shrunk, command);
      overheadMs += shrunk.ms;
      Object.assign(entry, { finding: dir, shrunkFiles: Object.keys(shrunk.files).length, shrunkEdits: shrunk.edits.length, reproduced: shrunk.reproduced, shrinkMs: shrunk.ms });
      log(`  shrunk to ${entry.shrunkFiles} files and ${entry.shrunkEdits} edits in ${Math.round(shrunk.ms / 1000)} s${shrunk.reproduced ? '' : ' (did not reproduce)'}: ${dir}`);
    }
    summary.failures.push(entry);
  }
  summary.ms = Date.now() - t0;
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.rmSync(work, { recursive: true, force: true });
  log(`done: ${summary.cases} cases, ${summary.edits} edits, ${summary.failures.length} failures, ${Math.round(summary.ms / 1000)} s`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  if (o.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    console.log(/\/\*\*([\s\S]*?)\*\//.exec(src)[1].replace(/^ \* ?/gm, ''));
    process.exit(0);
  }
  runFuzz(o).then((s) => process.exit(s.failures.length ? 1 : 0), (err) => {
    console.error(err?.stack ?? err);
    process.exit(3);
  });
}
