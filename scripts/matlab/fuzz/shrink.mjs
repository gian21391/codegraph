/**
 * The MATLAB fuzzer's shrinker: delta-debugs a failure down to a minimal
 * reproducer — first the edit sequence, then the files (and the files each
 * edit touches), then each file's lines — keeping a candidate only when it
 * stays on the original bug:
 *
 * - `replay` (fuzz.mjs) still fails the same way (the same oracle, variant,
 *   or robust message);
 * - its difference shares at least one entry with the original failure's, on
 *   the same side (the same edge, row, node or file, lines and columns aside;
 *   a row keeps its source symbol and status: `loose` in harness.mjs), so
 *   that a candidate cannot drift to another bug of the same oracle;
 * - in a mutant hunt (`opts.baseLib`, run.mjs' --baseline-dist), the baseline
 *   build passes it, so that it cannot drift to a bug the baseline has too.
 *
 * Then it writes the reproducer as a catalog case (`files/`, `case.json` with
 * `steps`, a draft `truth` and `pendingBug`) for triage, with the original
 * difference beside it in repro.txt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyEdit } from './mutate.mjs';
import { needsSequence, replay } from './fuzz.mjs';
import { renderDiff, shortDiff } from './harness.mjs';
import { GENERATOR_VERSION } from './generate.mjs';

/**
 * Delta debugging (ddmin) of `items`: a smallest sublist `test` still accepts,
 * within `budget` ({ evals, deadline }). `test` gets a candidate list and
 * resolves true when it still fails.
 */
export async function ddmin(items, test, budget) {
  let list = items;
  if (list.length === 0) return list;
  if (budget.ok() && (await budget.run(() => test([])))) return [];
  let n = 2;
  while (list.length >= 2 && budget.ok()) {
    const chunk = Math.ceil(list.length / n);
    let reduced = false;
    for (let i = 0; i < n && budget.ok(); i++) {
      const candidate = [...list.slice(0, i * chunk), ...list.slice((i + 1) * chunk)];
      if (candidate.length === list.length) continue;
      if (await budget.run(() => test(candidate))) {
        list = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= list.length) break;
      n = Math.min(n * 2, list.length);
    }
  }
  return list;
}

export function makeBudget(maxEvals, maxMs) {
  const deadline = Date.now() + maxMs;
  const b = {
    evals: 0,
    ok: () => b.evals < maxEvals && Date.now() < deadline,
    run: async (fn) => {
      b.evals++;
      return fn();
    },
  };
  return b;
}

const isText = (c) => typeof c === 'string';
const lines = (t) => t.split('\n');

/** A failure's difference as `section side loose-entry` strings (null for a failure with no difference: a robust one). */
function looseSides(f) {
  if (!f?.diff || !f.a || !f.b) return null;
  const out = new Set();
  for (const [s, { onlyA, onlyB }] of Object.entries(f.diff)) {
    for (const [side, keys, dump] of [['A', onlyA, f.a], ['B', onlyB, f.b]]) {
      const loose = new Map((dump[s] ?? []).map((e) => [e.key, e.loose ?? e.key]));
      for (const k of keys) out.add(`${s} ${side} ${loose.get(k) ?? k}`);
    }
  }
  return out;
}

/** Whether `candidate`'s difference shares an entry, on the same side, with `original`'s (always, for a robust failure). */
export function sharesEntry(original, candidate) {
  const a = looseSides(original);
  if (!a) return true;
  const b = looseSides(candidate);
  if (!b) return false;
  for (const x of b) if (a.has(x)) return true;
  return false;
}

/**
 * Shrinks a failed case (`run`: runCase's result). Returns `{ files, edits,
 * failure, evals, ms, reproduced }`; `reproduced` false means the failure did
 * not recur on a replay (flaky), and nothing was shrunk.
 */
export async function shrinkFailure(lib, run, opts) {
  const t0 = Date.now();
  const budget = makeBudget(opts.shrinkEvals ?? 300, opts.shrinkMs ?? 15 * 60_000);
  const target = run.failure;
  let edits = run.edits.slice(0, target.step).map((e) => ({ desc: e.desc, edit: e.edit }));
  let files = run.files;
  let last = await replay(lib, files, edits, target, opts);
  if (!last) return { files, edits, failure: target, evals: 1, ms: Date.now() - t0, reproduced: false };
  if (!needsSequence(target)) {
    for (const e of edits) files = applyEdit(files, e.edit);
    edits = [];
  }
  const attempt = async (f, e) => {
    const got = await replay(lib, f, e, target, opts);
    if (!got || !sharesEntry(target, got)) return null;
    if (opts.baseLib && (await replay(opts.baseLib, f, e, target, { ...opts, any: true }))) return null;
    last = got;
    return got;
  };
  const truncate = (e) => (last && needsSequence(target) ? e.slice(0, last.step) : e);

  // 1. The edit sequence.
  if (edits.length) edits = truncate(await ddmin(edits, async (cand) => !!(await attempt(files, cand)), budget));
  // 2. The files.
  const keep = (keys) => Object.fromEntries(keys.map((k) => [k, files[k]]));
  files = keep(await ddmin(Object.keys(files), async (keys) => !!(await attempt(keep(keys), edits)), budget));
  // 2b. The files each edit touches.
  for (let i = 0; i < edits.length && budget.ok(); i++) {
    const e = edits[i];
    const pick = (keys) => edits.map((x, j) => (j === i ? { ...x, edit: Object.fromEntries(keys.map((k) => [k, e.edit[k]])) } : x));
    const keys = await ddmin(Object.keys(e.edit), async (ks) => ks.length > 0 && !!(await attempt(files, pick(ks))), budget);
    if (keys.length) edits = pick(keys);
  }
  // 3. Lines: the files first, then each edit's contents, the biggest first.
  const byLines = Object.keys(files).filter((k) => isText(files[k])).sort((a, b) => files[b].length - files[a].length);
  for (const k of byLines) {
    if (!budget.ok()) break;
    const with_ = (ls) => ({ ...files, [k]: ls.join('\n') });
    const kept = await ddmin(lines(files[k]), async (ls) => !!(await attempt(with_(ls), edits)), budget);
    files = with_(kept);
  }
  for (let i = 0; i < edits.length && budget.ok(); i++) {
    for (const k of Object.keys(edits[i].edit)) {
      const c = edits[i].edit[k];
      if (!isText(c) || !budget.ok()) continue;
      const with_ = (ls) => edits.map((x, j) => (j === i ? { ...x, edit: { ...x.edit, [k]: ls.join('\n') } } : x));
      edits = with_(await ddmin(lines(c), async (ls) => !!(await attempt(files, with_(ls))), budget));
    }
  }
  const final = (await replay(lib, files, edits, target, opts)) ?? last;
  return { files, edits, failure: final, evals: budget.evals + 2, ms: Date.now() - t0, reproduced: true };
}

const encode = (c) => (c === null ? null : isText(c) ? c : { base64: Buffer.from(c).toString('base64') });

/** The draft truth a failure implies: what the right side has that the wrong one lacks, and back. */
function draftTruth(failure) {
  if (!failure.a || !failure.b || failure.oracle === 'determinism') return {};
  // The draft right answer: for a sync failure the fresh index (b); for a no-op sync the state before it, and for a
  // metamorphic one the unvaried project's (a).
  const [right, wrong] = failure.oracle === 'sync' ? [failure.b, failure.a] : [failure.a, failure.b];
  const d = shortDiff(right, wrong);
  const t = {};
  if (d.edges.onlyA.length) t.edges = d.edges.onlyA;
  if (d.edges.onlyB.length) t.noEdges = d.edges.onlyB;
  if (d.rows.onlyA.length) t.rows = d.rows.onlyA;
  if (d.rows.onlyB.length) t.noRows = d.rows.onlyB;
  if (d.dormant.onlyA.length) t.dormant = d.dormant.onlyA;
  if (d.dormant.onlyB.length) t.noDormant = d.dormant.onlyB;
  return t;
}

/**
 * Writes a shrunk failure under `outDir/<id>/` as a catalog case: `files/`,
 * `case.json` (steps + draft truth + pendingBug), and `repro.txt` (the seed,
 * the command that reproduces it, and the full difference).
 */
export function writeFinding(outDir, id, run, shrunk, command) {
  const dir = path.join(outDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  const f = shrunk.failure;
  const caseFiles = f.oracle === 'metamorphic' && f.variantFiles ? f.variantFiles : shrunk.files;
  for (const [rel, c] of Object.entries(caseFiles)) {
    const p = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  const truth = draftTruth(f);
  const why = `Fuzz finding (${f.oracle}${f.spec ? `: ${f.spec.kind}` : ''}${f.where ? `: ${f.where}` : ''}); seed ${run.seed}, case ${run.caseIndex}, generator version ${GENERATOR_VERSION}; in the catalog, cite it as "found by the step 11 fuzzer". Draft truth from the ${f.oracle === 'metamorphic' ? 'unvaried project' : 'fresh index'}: review before it joins the catalog.`;
  const json = { why, truth: needsSequence(f) ? {} : truth };
  if (needsSequence(f)) json.steps = shrunk.edits.map((e, i) => (i === shrunk.edits.length - 1 ? { edit: mapEdit(e.edit), truth } : { edit: mapEdit(e.edit) }));
  // `fails` is the runner's list of problems for the case (matlab-cases.test.ts prints it when it differs): fill it
  // in once the truth is reviewed.
  json.pendingBug = { id, fails: [] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(json, null, 2) + '\n');
  const report = [
    `finding ${id}`,
    `oracle: ${f.oracle}${f.spec ? ` (${JSON.stringify(f.spec)})` : ''}${f.where ? ` in ${f.where}` : ''}`,
    `reproduce: ${command}`,
    `generator version: ${GENERATOR_VERSION} (a reproduce line replays only with the generator version it names)`,
    `original: ${Object.keys(run.files).length} files, failed at step ${run.failure.step} of ${run.edits.length}`,
    `shrunk: ${Object.keys(shrunk.files).length} files, ${shrunk.edits.length} edits, in ${shrunk.evals} replays and ${Math.round(shrunk.ms / 1000)} s${shrunk.reproduced ? '' : ' (DID NOT REPRODUCE: flaky?)'}`,
    '',
    ...shrunk.edits.map((e, i) => `step ${i + 1}: ${e.desc}`),
    '',
    f.message ? `${f.message}\n${f.stack ?? ''}` : renderDiff(f.diff, f.names?.[0] ?? 'a', f.names?.[1] ?? 'b', 40),
    '',
    `original difference (unshrunk, step ${run.failure.step}${run.failure.step ? `, after: ${run.edits[run.failure.step - 1]?.desc}` : ''}):`,
    run.failure.message ? run.failure.message : renderDiff(run.failure.diff, run.failure.names?.[0] ?? 'a', run.failure.names?.[1] ?? 'b', 40),
    '',
    ...(run.failure.warnings?.length ? ['the product\'s warnings during the original case:', ...run.failure.warnings.map((w) => `  ${w}`), ''] : []),
  ];
  fs.writeFileSync(path.join(dir, 'repro.txt'), report.join('\n'));
  return dir;
}

function mapEdit(edit) {
  return Object.fromEntries(Object.entries(edit).map(([p, c]) => [p, encode(c)]));
}
