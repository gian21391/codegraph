/**
 * The MATLAB sync fuzzer's core: one case is a seeded random project (see
 * generate.mjs) and a seeded random edit sequence (see mutate.mjs), and these
 * oracles are checked after the first index and after every edit:
 *
 * - sync: the synced index equals a fresh index of the same files (files,
 *   nodes, edges, live rows and dormant rows, with status);
 * - noop: a second sync with nothing changed changes nothing;
 * - determinism (two fresh indexes agree): a second fresh index of the same
 *   files, in a project root of another name two folders deeper, with the
 *   files written in the other order, is identical. The root's name and depth
 *   are what the product sees; the write order is not, on a file system that
 *   lists a folder sorted (APFS), so there this checks only that two fresh
 *   indexes in one process agree (a memo that leaks from one to the next);
 * - metamorphic: prepending comment lines to a file only moves that file's
 *   lines; CRLF line ends change nothing; an unrelated file of unique names,
 *   in a folder no path entry names (zz_offpath/), changes nothing but its
 *   own entries;
 * - robust: no operation throws or logs an error, or reports an exception
 *   the product caught and went on from (harness.mjs' CAUGHT_EXCEPTIONS, on
 *   the warn, debug and verbose channels: a resolution fallback, a startup
 *   code that crashed the evaluator, a parse worker that crashed even when
 *   the retry rescued the file); no index or sync result records an
 *   extraction exception, a partial index or files it could not absorb; no
 *   file's stored errors hold an exception the product caught while
 *   extracting it; and each operation ends within its time budget (big cases
 *   add a file of broken text or deep nesting, up to a few hundred KB).
 *   Startup-code warnings count only while the startup code is the
 *   generator's own (configStillValid).
 *
 * A case stops at its first failure. `replay` re-runs a recorded failure for
 * the shrinker (shrink.mjs).
 */
import { Rng, hash32 } from './rng.mjs';
import { generateProject } from './generate.mjs';
import { applyEdit, mutate } from './mutate.mjs';
import { LiveProject, diffDumps, extractionExceptions, freshDump, logOf } from './harness.mjs';

/**
 * Whether the project's startup code is still the generator's own, meant to
 * be valid, after edit `m` (`{ desc, edit }`), given whether it was before.
 * A path config the mutator writes as one (a new or edited config, or none)
 * is; its "break codegraph.json" is not, nor is any other edit that writes
 * startup.m or codegraph.json (a parse error, a rewritten line). The robust
 * oracle counts startup-code warnings only while it is (CAUGHT_EXCEPTIONS).
 */
export function configStillValid(valid, m) {
  if (/^(edit codegraph\.json|new path config|drop the path config)/.test(m.desc ?? '')) return true;
  if (Object.entries(m.edit).some(([p, c]) => (p === 'startup.m' || p === 'codegraph.json') && c !== null)) return false;
  return valid;
}

export const ORACLES = ['sync', 'noop', 'determinism', 'metamorphic', 'robust'];
export const VARIANTS = ['prepend', 'crlf', 'unrelated'];
export const UNRELATED_PATH = 'zz_offpath/zzunrelated.m';

const isText = (c) => typeof c === 'string';

/** The project and options a case's seed makes: deterministic in (seed, caseIndex). */
export function caseSetup(seed, caseIndex, { bigEvery = 0, profile = 'default' } = {}) {
  const rng = new Rng(hash32('case', seed, caseIndex));
  const bigMode = bigEvery > 0 && caseIndex % bigEvery === bigEvery - 1 ? rng.pick(['deep', 'broken']) : null;
  const kb = bigMode ? rng.range(40, 400) : 0;
  const files = generateProject(rng.fork('gen'), { big: bigMode, kb, profile });
  return { files, bigMode, kb, mutRng: rng.fork('mut'), variantRng: rng.fork('variant') };
}

/**
 * Files a comment can be prepended to: MATLAB text with code in it, no Octave
 * marks, no BOM (a BOM counts as a column of line 1, so code that leaves line
 * 1 moves a column too: true, but no finding of this oracle's).
 */
function prependable(files) {
  return Object.keys(files).filter((p) => p.endsWith('.m') && isText(files[p]) && !files[p].includes('@implementation') && !files[p].startsWith('\uFEFF')
    && !/^\s*#|endfunction/m.test(files[p]) && /^\s*[^%\s]/m.test(files[p].replace(/^﻿/, '')));
}

/** A metamorphic variant to check at this step: `{ kind, path?, k? }`. */
export function pickVariant(rng, files, step) {
  const kind = VARIANTS[(step + rng.int(VARIANTS.length)) % VARIANTS.length];
  if (kind === 'prepend') {
    const ps = prependable(files);
    if (!ps.length) return { kind: 'crlf' };
    return { kind, path: rng.pick(ps), k: rng.range(1, 3) };
  }
  return { kind };
}

/** `files` turned into the variant `spec` names (null when it cannot apply). */
export function variantFiles(files, spec) {
  if (spec.kind === 'prepend') {
    const t = files[spec.path];
    if (!isText(t)) return null;
    const bom = t.startsWith('﻿') ? '﻿' : '';
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    return { ...files, [spec.path]: bom + `% padding${eol}`.repeat(spec.k) + t.slice(bom.length) };
  }
  if (spec.kind === 'crlf') {
    return Object.fromEntries(Object.entries(files).map(([p, c]) => [p, isText(c) ? c.replace(/\r?\n/g, '\r\n') : c]));
  }
  if (files[UNRELATED_PATH] !== undefined) return null;
  return { ...files, [UNRELATED_PATH]: 'function zzunrelated()\n% Calls only names nothing else in the project has.\nzzothername(1);\ndisp(2);\nend\n' };
}

/** What the variant's fresh index must equal, from the base's: `base` (moved, for prepend) and the variant's dump filtered. */
function variantExpectation(spec, base, variant) {
  if (spec.kind === 'prepend') {
    const shifted = {};
    for (const [s, list] of Object.entries(base)) shifted[s] = list.map((e) => e.shift(spec.k, spec.path)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { expected: shifted, actual: variant };
  }
  if (spec.kind === 'unrelated') {
    const filtered = {};
    for (const [s, list] of Object.entries(variant)) filtered[s] = list.filter((e) => e.file !== UNRELATED_PATH);
    return { expected: base, actual: filtered };
  }
  return { expected: base, actual: variant };
}

function robustFailure(step, where, err) {
  const message = String(err?.message ?? err).split('\n')[0];
  return { step, oracle: 'robust', where, message, slow: !!err?.slow, stack: err?.stored ? '' : String(err?.stack ?? '').split('\n').slice(0, 8).join('\n') };
}

/** Throws, as a robust failure, when `dump` stores an exception the product caught while extracting a file. */
export function checkStored(dump, what) {
  const found = extractionExceptions(dump);
  if (!found.length) return dump;
  // The message leaves `what` out, so that a replay that meets the same exception in another index matches it.
  const err = new Error(`an extraction exception is stored: ${found[0]}${found.length > 1 ? ` (and ${found.length - 1} more)` : ''}`);
  err.stored = true;
  err.where = what;
  throw err;
}

/** The budget for one operation of a case, in ms. */
function budgetFor(opts, kb) {
  return (opts.budgetMs ?? 20_000) + (kb ?? 0) * (opts.msPerKb ?? 150);
}

/**
 * Checks `oracles` on one state: `live` (synced to `files`) at `step`
 * (0 = the first index, whose dump is itself a fresh one). The first
 * failure, or null. `spec` forces the metamorphic variant (a replay).
 */
async function checkStep(lib, live, files, step, oracles, ctx) {
  const { work, budgetMs } = ctx;
  let where = 'dump';
  try {
    const synced = live ? checkStored(live.dump(), step === 0 ? 'the first index' : 'the synced index') : null;
    let fresh = step === 0 && synced ? synced : null;
    const getFresh = async () => {
      where = 'a fresh index';
      fresh ??= checkStored(await freshDump(lib, files, { work, budgetMs }), 'a fresh index');
      return fresh;
    };
    if (step > 0 && oracles.has('sync')) {
      const d = diffDumps(synced, await getFresh());
      if (d) return { step, oracle: 'sync', diff: d, names: ['synced', 'fresh'], a: synced, b: fresh };
    }
    if (step > 0 && oracles.has('noop') && live) {
      where = 'a no-op sync';
      await live.noopSync();
      const again = live.dump();
      const d = diffDumps(synced, again);
      if (d) return { step, oracle: 'noop', diff: d, names: ['before', 'after the no-op sync'], a: synced, b: again };
    }
    if (oracles.has('determinism')) {
      const base = await getFresh();
      where = 'a fresh index (another root, reversed order)';
      const other = checkStored(await freshDump(lib, files, { work, budgetMs, order: Object.keys(files).reverse(), nest: 2 }), 'a fresh index');
      const d = diffDumps(base, other);
      if (d) return { step, oracle: 'determinism', diff: d, names: ['first', 'second (another root, reversed order)'], a: base, b: other };
    }
    if (oracles.has('metamorphic')) {
      const spec = ctx.spec ?? pickVariant(ctx.variantRng, files, step);
      const vf = variantFiles(files, spec);
      if (vf) {
        const base = await getFresh();
        where = `a fresh index (${spec.kind} variant)`;
        const vd = checkStored(await freshDump(lib, vf, { work, budgetMs }), 'a fresh index');
        const { expected, actual } = variantExpectation(spec, base, vd);
        const d = diffDumps(expected, actual);
        if (d) return { step, oracle: 'metamorphic', spec, diff: d, names: ['expected', spec.kind], a: expected, b: actual, variantFiles: vf };
      }
    }
    return null;
  } catch (err) {
    return robustFailure(step, err?.where ?? where, err);
  }
}

/**
 * Runs one case: its project, `steps` edits, the oracles after each. Returns
 * `{ seed, caseIndex, files, edits, failure, stats }`; `failure` is the first
 * one, or null.
 */
export async function runCase(lib, seed, caseIndex, opts) {
  const { files: files0, bigMode, kb, mutRng, variantRng } = caseSetup(seed, caseIndex, opts);
  logOf(lib)?.clear();
  const oracles = new Set(opts.oracles ?? ORACLES);
  const budgetMs = budgetFor(opts, kb);
  const ctx = { work: opts.work, budgetMs, variantRng };
  const edits = [];
  const stats = { steps: 0, files: Object.keys(files0).length, bigMode, kb, ms: 0 };
  const t0 = performance.now();
  let files = files0;
  const live = new LiveProject(lib, opts.work, budgetMs);
  const log = logOf(lib);
  if (log) log.configValid = true;
  const done = (failure) => {
    stats.ms = Math.round(performance.now() - t0);
    // The product's warnings during the case go with a failure, into its repro output only.
    if (failure) failure.warnings = [...new Set(logOf(lib)?.warnings ?? [])].slice(0, 40);
    return { seed, caseIndex, files: files0, edits, failure, stats };
  };
  try {
    try {
      await live.init(files);
    } catch (err) {
      return done(robustFailure(0, 'the first index', err));
    }
    for (let step = 0; step <= opts.steps; step++) {
      if (step > 0) {
        const m = mutate(mutRng, files, { profile: opts.profile });
        edits.push(m);
        files = applyEdit(files, m.edit);
        if (log) log.configValid = configStillValid(log.configValid, m);
        stats.steps++;
        try {
          await live.apply(m.edit);
        } catch (err) {
          return done(robustFailure(step, 'a sync', err));
        }
      }
      const failure = await checkStep(lib, live, files, step, oracles, ctx);
      if (failure) return done(failure);
    }
    return done(null);
  } finally {
    live.close();
  }
}

/** The kind of a failure, which a shrunk candidate must keep: the oracle, and for a robust one its message's shape. */
export function failureSignature(f) {
  if (!f) return null;
  if (f.oracle === 'robust') return `robust:${needsSequence(f) ? 'sync' : 'index'}:${f.slow ? 'slow' : f.message.replace(/\d+/g, 'N').slice(0, 80)}`;
  if (f.oracle === 'metamorphic') return `metamorphic:${f.spec.kind}`;
  return f.oracle;
}

/** Whether a failure needs the edit sequence (a sync's), or only the files at its step. */
export function needsSequence(f) {
  return f.oracle === 'sync' || f.oracle === 'noop' || (f.oracle === 'robust' && /sync/.test(f.where));
}

/** Whether two paths of `files` are one file on a case-insensitive file system (a shrunk edit can leave both). */
function caseCollides(files) {
  const seen = new Set();
  for (const p of Object.keys(files)) {
    const low = p.toLowerCase();
    if (seen.has(low)) return true;
    seen.add(low);
  }
  return false;
}

/**
 * Re-runs `files` + `edits` checking only the oracle of `target` (a failure
 * from runCase or an earlier replay). For a sequence failure the live project
 * is synced edit by edit and checked at each; otherwise only the files after
 * every edit are checked, with fresh indexes. The failure, if the same kind
 * recurs, else null; with `opts.any`, any failure at all (the shrinker's
 * check that a candidate passes on the baseline build).
 */
export async function replay(lib, files0, edits, target, opts) {
  const sig = failureSignature(target);
  // A candidate the shrinker made by dropping part of an edit may hold `f.m` and `F.m` at once: on a case-insensitive
  // file system (macOS, Windows) that is one file, and which bytes win depends on write order. No such candidate counts.
  let check = files0;
  if (caseCollides(check)) return null;
  for (const e of edits) {
    check = applyEdit(check, e.edit);
    if (caseCollides(check)) return null;
  }
  const oracles = new Set(target.oracle !== 'robust' ? [target.oracle] : needsSequence(target) ? ['sync', 'noop'] : ['determinism']);
  const kb = Math.max(0, ...[files0, ...edits.map((e) => e.edit)].flatMap((f) => Object.values(f)).filter((c) => c).map((c) => Math.round(Buffer.byteLength(c) / 1024)));
  const ctx = { work: opts.work, budgetMs: budgetFor(opts, kb), spec: target.spec };
  const same = (f) => (f && (opts.any || failureSignature(f) === sig) ? f : null);
  const log = logOf(lib);
  log?.clear();
  if (log) log.configValid = true;
  if (!needsSequence(target)) {
    let files = files0;
    for (const e of edits) {
      files = applyEdit(files, e.edit);
      if (log) log.configValid = configStillValid(log.configValid, e);
    }
    // A shrunk candidate keeps the variant's precondition: the file must still be one a comment can be prepended to.
    if (target.spec?.kind === 'prepend' && !prependable(files).includes(target.spec.path)) return null;
    return same(await checkStep(lib, null, files, 1, oracles, ctx));
  }
  const live = new LiveProject(lib, opts.work, ctx.budgetMs);
  try {
    try {
      await live.init(files0);
    } catch (err) {
      return same(robustFailure(0, 'the first index', err));
    }
    let files = files0;
    for (let i = 0; i < edits.length; i++) {
      files = applyEdit(files, edits[i].edit);
      if (log) log.configValid = configStillValid(log.configValid, edits[i]);
      try {
        await live.apply(edits[i].edit);
      } catch (err) {
        const f = same(robustFailure(i + 1, 'a sync', err));
        if (f) return f;
        return null;
      }
      const f = await checkStep(lib, live, files, i + 1, oracles, ctx);
      if (f) return same(f);
    }
    return null;
  } finally {
    live.close();
  }
}
