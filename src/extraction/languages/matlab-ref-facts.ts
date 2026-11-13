/**
 * What the MATLAB extractor knows of how a reference is written, from the
 * syntax tree, which the resolver needs and could not read back from the
 * name: carried in the reference's `candidates`, so that it survives the
 * `unresolved_refs` row (its `candidates` column) and the edge a resolved
 * reference becomes (`metadata.refCandidates`, read back when the edge is
 * dropped and resurrected as a reference). One tagged string per fact:
 *
 *   - `dispatch:<m>` — a function-syntax call on an object of a known class
 *     (`m(obj, …)`, `area(c)` after `c = Shape(…)`), recorded as `Cls::m`:
 *     the name as written, which MATLAB looks up as a function before the
 *     class's methods and after them on the path;
 *   - `variable:<v.m>` — a member call through a class only a bare name gave
 *     (`aa = Archive; aa.getData()` → `Archive::getData`): the variable's own
 *     dotted name, taken when that bare name is a function, not a class;
 *   - `bare` — a bare name written without an argument list: read as a value
 *     (`t = cfg;`, `if isReady`) or a command (`hold on`);
 *   - `statement` — a bare name that is a statement of its own
 *     (`setup_paths`, `if ok, setup_paths, end`, `catch⏎ cleanupAll`), or
 *     the script a `run` statement names (`run setup_paths`,
 *     `run('setup_paths.m')`): the only way a script runs. Bare as well.
 *
 * No form fact means written with arguments (`f(x)`, `f()`), or a name that
 * is no bare one (`pkg.f(x)`, `@f`): what the reader cannot tell apart from
 * a call is kept, never discarded.
 */

export interface MatlabRefFacts {
  dispatch?: string;
  variable?: string;
  form?: 'bare' | 'statement';
}

const DISPATCH = 'dispatch:';
const VARIABLE = 'variable:';

/** `facts` as a reference's `candidates`, or undefined when there are none. */
export function matlabRefCandidates(facts: MatlabRefFacts): string[] | undefined {
  const out: string[] = [];
  if (facts.dispatch) out.push(DISPATCH + facts.dispatch);
  if (facts.variable) out.push(VARIABLE + facts.variable);
  if (facts.form) out.push(facts.form);
  return out.length > 0 ? out : undefined;
}

/** The facts a MATLAB reference's `candidates` carry (see the top of this file); an unknown tag is passed over. */
export function matlabRefFacts(ref: { candidates?: readonly string[] }): MatlabRefFacts {
  const facts: MatlabRefFacts = {};
  for (const c of ref.candidates ?? []) {
    if (c.startsWith(DISPATCH)) facts.dispatch = c.slice(DISPATCH.length);
    else if (c.startsWith(VARIABLE)) facts.variable = c.slice(VARIABLE.length);
    else if (c === 'bare' || c === 'statement') facts.form = c;
  }
  return facts;
}
