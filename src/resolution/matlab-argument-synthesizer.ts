/**
 * MATLAB argument flow synthesis.
 *
 * A MATLAB function often calls what its caller names: the name, a handle or
 * code arrives as an argument, and only the call sites say what it is.
 *
 *   % dacefit.m — 55 call sites, each passing a literal: dacefit(S, Y, 'regpoly0', 'corrgauss', …)
 *   function [dmodel, perf] = dacefit(S, Y, regr, corr, theta0, lob, upb)
 *   F = feval(regr, S);
 *
 *   function varargout = intlat(varargin)                % a switchyard
 *   [varargout{1:nargout}] = feval(varargin{:});         % intlat('LoadLattice', h) → its local LoadLattice
 *
 * Extraction sees both halves and links neither. Its value interpreter (see
 * extraction/languages/matlab-interp.ts) gives a function's parameters what
 * the caller passed as a symbolic value, so a dynamic call that reads one is a
 * parameter sink — `feval(regr)`, `str2func(varargin{1})`, `feval(cfg.winfunc,
 * n)` (a field of one, two levels at most), `fh(x)` on a parameter,
 * `feval(['ft_' method])` (a template: the text around one parameter), code
 * `eval` runs. And every call of the project's records what its arguments
 * hold where the code says (the `args` fact, carried to the edge as
 * `metadata.args`): names, handles, short code, structs the caller built, or
 * the caller's own parameter — so a value can be followed back through a
 * caller that passes it on (`a('f')` → `b(x)` → `feval(x)`), three calls
 * deep at most.
 *
 * Every record is kept on its edge, whatever the target: what a record says
 * depends on its caller's file alone, so a sync keeps it as a full index
 * makes it.
 *
 * This pass joins the two. Extraction keeps no fact per node, so the sinks
 * are found again here. The functions some edge carrying `args` reaches are
 * listed first, without their records; a function's text is tested next
 * (sinkUses: a place a sink call names on its line, or a parameter it
 * calls, also through a statement that copies the parameter, `r = regr;
 * feval(r)`); only then are the records into the functions that pass read,
 * each function's on its own (and its callers' when a value is followed
 * back), and a function walked where one of those places is passed a text,
 * a handle or a struct (a handle, for a parameter it calls). The walk is the
 * extractor's own (matlabParamSinks: one parse per file, the same frames and
 * interpretation, only the functions asked for). A sink that reads a
 * parameter through anything else (`r = [regr]; feval(r)`) is passed over:
 * silent, as the spec allows. A sink whose running depends on what a caller
 * passes (a branch, or an exit before it, on a parameter: see
 * extraction/languages/matlab-guards.ts) takes only the values that reach
 * it, when the branch tests the very value it reads, and nothing otherwise.
 * Each sink then takes every
 * value its callers pass at its parameter's place, the template around it
 * applied, and makes the edge a literal written there would have made:
 *   • a name (`'regpoly0'`) is looked up where the sink is — its file's
 *     local functions first, its private folder, the path (matlab-lookup.ts):
 *     what `feval('regpoly0')` written in dacefit reaches;
 *   • a handle (`@regpoly1`) names what it named where it was written: it is
 *     looked up where the caller is;
 *   • code (`'helper(3)'`) is read as code `eval` runs in the function, its
 *     calls looked up there; a name nothing answers is dropped.
 * A built-in or a name that resolves to nothing adds nothing, and so does a
 * caller that passes what it cannot know: each edge holds along the call path
 * that passes its value.
 *
 * Edges: from the function holding the sink to what the value names, `calls`
 * (`feval`, `fh(x)`, a call in eval'd code) or `references` (`str2func`,
 * `cellfun` and the other function takers, a handle in eval'd code), at the
 * sink's place, `provenance: 'heuristic'`, `synthesizedBy:
 * 'matlab-argument'`, with `param` (`regr`, `varargin{1}`, `cfg.winfunc`),
 * `sink` (`feval`), `value` (`'regpoly0'`, `@regpoly1`) and `registeredAt` =
 * where that value is passed (`test/dacefit_test.m:12`) — its first
 * production site before a test's. A pair the graph already has is skipped.
 * A sink that takes more distinct values than the caller's cap links none of
 * them: so many names through one parameter is a dispatcher, not a flow.
 */

import type { Edge, Node, UnresolvedReference } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext, UnresolvedRef } from './types';
import type { MaybeYield } from './cooperative-yield';
import { MATLAB_ARG_PLACES, argItemsOf, spreadItem, type MatlabArgItem, type MatlabCallArgs } from '../extraction/languages/matlab-ref-facts';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { CALLEE, matlabParamSinks, matlabParameterNames, type MatlabParamSink } from '../extraction/languages/matlab';
import { PARAM_SINK_CALLS } from '../extraction/languages/matlab-interp';
import { admits } from '../extraction/languages/matlab-guards';
import { MATLAB_CELLFUN_NAMES } from '../extraction/languages/matlab-builtins';
import { NAME_SHAPED } from '../extraction/languages/matlab-values';
import { matchMatlabReference } from './matlab-lookup';
import { isMatlabClassFolderFile } from './matlab-class-folders';
import { isTestPath } from '../search/query-utils';
import { escapeRegExp } from '../utils';

/** The `synthesizedBy` of this pass's edges. */
export const MATLAB_ARGUMENT = 'matlab-argument';

/** Calls a value is followed back through: the sink's caller, its caller, and one more. */
const MAX_DEPTH = 3;
/** Fields a value is followed into (`cfg.a.b`), as extraction records them. */
const MAX_FIELDS = 2;

/** Reads code a caller passes to an `eval` sink as code run there (see matlabParamSinks). */
type CodeRefsOf = (sink: MatlabParamSink, code: string) => UnresolvedReference[];

/** An edge whose call records what it passes. */
interface ArgEdge {
  source: string;
  line: number | null;
  /** The record as JSON text, read when a sink asks for it (see argsOf). */
  raw: string;
}

/** A value a sink's callers pass, and where. */
interface Passed {
  /** A text (`'name`, or code) or a handle (`@name`), as MatlabArgItem writes it. */
  item: string;
  /** The function whose call writes it: a handle is looked up there. */
  writer: string;
  /** `file:line` of that call. */
  site: string;
  test: boolean;
}

/** What a sink makes of one value: the reference to look up, and the edge its target is reached by (a call, or a function named as a handle). */
interface Use {
  ref: UnresolvedRef;
  edge: 'calls' | 'function_ref';
}

/**
 * The `calls` / `references` edges from each MATLAB function that calls what
 * its callers pass to it (see the top of this file), at most `maxPerSink`
 * values per sink.
 */
export async function matlabArgumentEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield, maxPerSink: number): Promise<Edge[]> {
  const targets = queries.getMatlabArgumentTargets();
  if (targets.length === 0) return [];

  const nodeMemo = new Map<string, Node | null>();
  const nodeOf = (id: string): Node | null => {
    let n = nodeMemo.get(id);
    if (n === undefined) nodeMemo.set(id, (n = queries.getNodeById(id)));
    return n;
  };
  // The records into a function, read when a function that passes the text test, or a value followed back, asks.
  const recordsMemo = new Map<string, ArgEdge[]>();
  const recordsInto = (id: string): ArgEdge[] => {
    let list = recordsMemo.get(id);
    if (!list) recordsMemo.set(id, (list = queries.getMatlabArgumentEdgesInto(id).map((r) => ({ source: r.source, line: r.line, raw: r.args }))));
    return list;
  };
  const parsed = new WeakMap<ArgEdge, MatlabCallArgs | null>();
  const argsOf = (e: ArgEdge): MatlabCallArgs | null => {
    let a = parsed.get(e);
    if (a === undefined) {
      try {
        a = JSON.parse(e.raw) as MatlabCallArgs;
      } catch {
        a = null;
      }
      parsed.set(e, a);
    }
    return a;
  };

  // The functions some call passes a value to, by file.
  const byFile = new Map<string, Node[]>();
  let scanned = 0;
  for (const id of targets) {
    if ((++scanned & 255) === 0) await onYield();
    const fn = nodeOf(id);
    if (!fn || fn.language !== 'matlab' || (fn.kind !== 'function' && fn.kind !== 'method')) continue;
    const list = byFile.get(fn.filePath);
    if (list) list.push(fn);
    else byFile.set(fn.filePath, [fn]);
  }

  /**
   * Every value the callers of function `id` pass at `position` (and down
   * `path`), followed back through a caller that passes its own parameter on
   * to MAX_DEPTH calls; `seen` keeps a cycle from coming round again.
   */
  const passedAt = (id: string, position: number, path: readonly string[], depth: number, seen: Map<string, number>, out: Passed[]): void => {
    const key = `${id}\0${position}\0${path.join('.')}`;
    // Reached before as near or nearer: nothing more to find.
    if (depth > MAX_DEPTH || (seen.get(key) ?? Infinity) <= depth) return;
    seen.set(key, depth);
    for (const e of recordsInto(id)) {
      const args = argsOf(e);
      const items = args ? argumentAt(args, position) : undefined;
      if (!items) continue;
      const caller = nodeOf(e.source);
      if (!caller) continue;
      for (const item of items) follow(item, path, e, caller, depth, seen, out);
    }
  };
  const follow = (item: MatlabArgItem, path: readonly string[], e: ArgEdge, caller: Node, depth: number, seen: Map<string, number>, out: Passed[]): void => {
    if (typeof item === 'string') {
      if (path.length > 0) return; // a text or a handle has no field
      out.push({ item, writer: caller.id, site: `${caller.filePath}:${e.line ?? caller.startLine}`, test: isTestPath(caller.filePath) });
      return;
    }
    if (typeof item === 'number') item = { p: item };
    if ('o' in item) {
      const [field, ...rest] = path;
      const value = field === undefined ? undefined : item.o[field];
      if (value !== undefined) for (const one of argItemsOf(value)) follow(one, rest, e, caller, depth, seen, out);
      return;
    }
    if ('r' in item) return; // argumentAt turns a list into its parameters
    // The caller's own parameter: what its callers pass, unless a field is read off one that may have changed since.
    if (item.s && path.length > 0) return;
    const full = [...(item.f ? item.f.split('.') : []), ...path];
    if (full.length > MAX_FIELDS) return;
    passedAt(caller.id, item.p, full, depth + 1, seen, out);
  };

  /**
   * What the callers of function `id` may pass at `position`, as far as a
   * sink cares (see maySink): a text, a handle, a struct — following a
   * caller's own parameter on `left` more calls, whatever field of it (a
   * cheap superset of what passedAt finds).
   */
  const shapesMemo = new Map<string, Shapes>();
  const shapesAt = (id: string, position: number, left = MAX_DEPTH - 1): Shapes => {
    const key = `${id}\0${position}\0${left}`;
    const known = shapesMemo.get(key);
    if (known) return known;
    let out: Shapes = { text: false, handle: false, struct: false };
    shapesMemo.set(key, out); // a cycle back here adds nothing
    for (const e of recordsInto(id)) {
      const args = argsOf(e);
      for (const item of (args ? argumentAt(args, position) : undefined) ?? []) {
        if (typeof item === 'string') out = eitherShape(out, { text: !item.startsWith('@'), handle: item.startsWith('@'), struct: false });
        else if (typeof item === 'object' && 'o' in item) out = eitherShape(out, { text: false, handle: false, struct: true });
        else if (left > 0 && !(typeof item === 'object' && 'r' in item)) out = eitherShape(out, shapesAt(e.source, typeof item === 'number' ? item : item.p, left - 1));
      }
    }
    shapesMemo.set(key, out);
    return out;
  };

  await loadGrammarsForLanguages(['matlab']);
  const parser = getParser('matlab');
  if (!parser) return [];

  const edges: Edge[] = [];
  let filesRead = 0;
  for (const [file, fns] of byFile) {
    if ((++filesRead & 15) === 0) await onYield();
    const fileFunctions = ctx.getNodesInFile(file).filter((n) => n.kind === 'function');
    const qualified = new Set(fileFunctions.map((n) => n.qualifiedName));
    // Not a nested function: its parameters are variables of the workspace it shares, which nothing here follows.
    const own = fns.filter((fn) => !qualified.has(fn.qualifiedName.slice(0, Math.max(0, fn.qualifiedName.lastIndexOf('::')))));
    if (own.length === 0) continue;
    const content = ctx.readFile(file);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    const sites = new Set<string>();
    const bySite = new Map<string, Node>();
    for (const fn of own) {
      const uses = sinkUses(lines.slice(fn.startLine - 1, fn.endLine).join('\n'), matlabParameterNames(fn.signature));
      if ((uses.sink | uses.handle) === 0) continue;
      // Only now what its callers pass: a place it may sink is passed a text, a handle or a struct.
      const reach = Array.from({ length: MATLAB_ARG_PLACES }, (_, k) => ((uses.sink | uses.handle) >> k) & 1 ? shapesAt(fn.id, k) : NO_SHAPES);
      if (!maySink(uses, reach)) continue;
      const site = `${fn.startLine}:${fn.startColumn}`;
      sites.add(site);
      bySite.set(site, fn);
    }
    if (sites.size === 0) continue;
    // A file's own functions, outside a class, need none of the rest of it: the other lines are left blank, in place.
    const slice = !isMatlabClassFolderFile(file) && [...bySite.values()].every((fn) => fn.kind === 'function');
    const text = slice ? keptLines(lines, [...bySite.values()]) : content;
    let tree;
    try {
      tree = parser.parse(text);
    } catch {
      continue;
    }
    if (!tree) continue;
    try {
      matlabParamSinks(tree.rootNode, text, file, sites, new Set(fileFunctions.map((n) => n.name)), (sinks, codeRefsOf) => {
        for (const sink of sinks) {
          const fn = bySite.get(sink.fn);
          if (fn) edges.push(...sinkEdges(fn, sink, codeRefsOf));
        }
      });
    } finally {
      tree.delete();
    }
  }
  return edges;

  /** The edges one sink of `fn` makes of what its callers pass (see the top of this file). */
  function sinkEdges(fn: Node, sink: MatlabParamSink, codeRefsOf: CodeRefsOf): Edge[] {
    const passed: Passed[] = [];
    passedAt(fn.id, sink.position, sink.path, 1, new Map(), passed);
    // Each value once, at the first site that passes it: production code before a test.
    passed.sort((a, b) => Number(a.test) - Number(b.test) || compareSites(a.site, b.site));
    const values = new Map<string, Passed>();
    for (const p of passed) {
      // Under a test of this value, only what it admits (see extraction/languages/matlab-guards.ts).
      if (!admits(sink.guards, p.item)) continue;
      const value = valueFor(sink, p.item);
      if (value !== null && !values.has(value)) values.set(value, p);
    }
    if (values.size === 0 || values.size > maxPerSink) return [];
    // The pairs the graph already has as a plain edge (not one a synthesis made, which this run makes again).
    const have = new Set(queries.getOutgoingEdges(fn.id, ['calls', 'references', 'instantiates']).filter((e) => e.metadata?.synthesizedBy === undefined).map((e) => e.target));
    const out: Edge[] = [];
    for (const [value, p] of values) {
      for (const { ref, edge } of usesOf(fn, sink, value, p, codeRefsOf)) {
        const found = matchMatlabReference(ref, ctx);
        if (!found || have.has(found.targetNodeId)) continue;
        const target = nodeOf(found.targetNodeId);
        if (!target) continue;
        have.add(target.id);
        out.push({
          source: fn.id,
          target: target.id,
          kind: edge === 'function_ref' ? 'references' : target.kind === 'class' || target.kind === 'enum' ? 'instantiates' : 'calls',
          line: sink.line,
          column: sink.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: MATLAB_ARGUMENT,
            param: sink.param,
            sink: sink.sink,
            value: p.item.startsWith("'") ? `'${p.item.slice(1)}'` : p.item,
            registeredAt: p.site,
          },
        });
      }
    }
    return out;
  }

  /**
   * What `sink` makes of `value` (see valueFor), which `p` passes: the
   * reference a literal written at the sink would be, the references of code
   * read there, or, for a handle, its `@name` where it was written.
   */
  function usesOf(fn: Node, sink: MatlabParamSink, value: string, p: Passed, codeRefsOf: CodeRefsOf): Use[] {
    const edge = sink.edge === 'function_ref' ? 'function_ref' : 'calls';
    if (value.startsWith('@')) {
      const writer = nodeOf(p.writer);
      if (!writer) return [];
      const line = Number(p.site.slice(p.site.lastIndexOf(':') + 1));
      return [{ ref: { fromNodeId: writer.id, referenceName: value.slice(1), referenceKind: 'function_ref', line, column: 0, filePath: writer.filePath, language: 'matlab' }, edge }];
    }
    const text = value.slice(1);
    if (sink.edge === 'code') {
      return codeRefsOf(sink, text).flatMap((r) => r.fromNodeId !== CALLEE || (r.referenceKind !== 'calls' && r.referenceKind !== 'function_ref') ? [] : [{
        ref: { ...r, fromNodeId: fn.id, filePath: fn.filePath, language: 'matlab' as const },
        edge: r.referenceKind,
      }]);
    }
    return [{ ref: { fromNodeId: fn.id, referenceName: text.split('.').join('::'), referenceKind: edge, line: sink.line, column: sink.column, filePath: fn.filePath, language: 'matlab' }, edge }];
  }
}

/**
 * The value `item` makes at `sink`, as `'text` (a name, or code) or `@name`:
 * the template around it applied; null for one the sink does not take — a
 * handle where a text is read, a text where a handle is called, a name that
 * is no name, `cellfun`'s legacy names (`'isempty'`), which are no function.
 */
function valueFor(sink: MatlabParamSink, item: string): string | null {
  if (item.startsWith('@')) return sink.takes === 'text' || sink.edge === 'code' ? null : item;
  if (sink.takes === 'handle') return null;
  const text = sink.prefix + item.slice(1) + sink.suffix;
  if (sink.edge === 'code') return `'${text}`;
  if (!NAME_SHAPED.test(text) || (sink.sink === 'cellfun' && MATLAB_CELLFUN_NAMES.has(text))) return null;
  return `'${text}`;
}

/** `lines` with only the lines of `fns` kept, every other one blank: the same places, a fraction of the text. */
function keptLines(lines: readonly string[], fns: readonly Node[]): string {
  const keep = new Uint8Array(lines.length);
  for (const fn of fns) keep.fill(1, fn.startLine - 1, Math.min(lines.length, fn.endLine));
  return lines.map((l, i) => (keep[i] ? l : '')).join('\n');
}

/** The values a call's record gives the parameter at `position`: its own argument's, or the caller's parameter a trailing `varargin{:}` puts there. */
function argumentAt(args: MatlabCallArgs, position: number): MatlabArgItem[] | undefined {
  const own = args[position];
  if (own !== undefined) {
    const spread = spreadItem(own);
    return spread ? [{ p: spread.r, ...(spread.s ? { s: spread.s } : {}) }] : argItemsOf(own);
  }
  let from = -1;
  for (const k of Object.keys(args)) {
    const i = Number(k);
    if (i < position && i > from) from = i;
  }
  if (from < 0) return undefined;
  const last = spreadItem(args[from]!);
  return last ? [{ p: last.r + position - from, ...(last.s ? { s: last.s } : {}) }] : undefined;
}

/** `file:line` sites in file order, then line order. */
function compareSites(a: string, b: string): number {
  const i = a.lastIndexOf(':');
  const j = b.lastIndexOf(':');
  const fa = a.slice(0, i);
  const fb = b.slice(0, j);
  return fa < fb ? -1 : fa > fb ? 1 : Number(a.slice(i + 1)) - Number(b.slice(j + 1));
}

/** What callers may pass at one place, as far as a sink cares (see maySink). */
interface Shapes {
  text: boolean;
  handle: boolean;
  struct: boolean;
}

const NO_SHAPES: Shapes = { text: false, handle: false, struct: false };

/** What either place may be passed. */
function eitherShape(a: Shapes, b: Shapes): Shapes {
  return { text: a.text || b.text, handle: a.handle || b.handle, struct: a.struct || b.struct };
}

/**
 * Whether a function may hold a parameter sink its callers pass something to
 * — a cheap test before its file is parsed: a place a sink call names (see
 * sinkUses) where some call passes a text, a handle or a struct, or a place
 * it calls where some call passes a handle. `reach` is what callers pass at
 * each place.
 */
function maySink(uses: { sink: number; handle: number }, reach: readonly Shapes[]): boolean {
  return reach.some((r, k) => ((uses.sink >> k) & 1 && (r.text || r.handle || r.struct)) || ((uses.handle >> k) & 1 && r.handle));
}

/** Every argument place a record covers (see MATLAB_ARG_PLACES), as a bit mask. */
const ALL_PLACES = (1 << MATLAB_ARG_PLACES) - 1;

/** A call that may be a sink, and the rest of its line, where its argument is. */
const SINK_CALL = new RegExp(`\\b(?:${PARAM_SINK_CALLS.map(escapeRegExp).join('|')})\\s*\\(([^\\n]*)`, 'g');

/** `x = p`, `x = p{1}`, `x = p.f` as a statement: x, and p's name. */
const COPY = /(?:^|[;,\n])[ \t]*([A-Za-z]\w*)[ \t]*=(?!=)[ \t]*([A-Za-z]\w*)[ \t]*(?:[{.(][^;\n]*)?(?=[;,\n]|$)/g;

/** The places parameter k stands for: its own, or for `varargin` (last) every one from k on. */
function placesOf(params: readonly string[], k: number): number {
  if (k >= MATLAB_ARG_PLACES) return 0;
  return params[k] === 'varargin' && k === params.length - 1 ? ALL_PLACES & ~((1 << k) - 1) : 1 << k;
}

/**
 * The argument places, as bit masks, whose parameter a function's text names
 * on a sink call's line (`sink`), and those whose parameter it calls
 * (`handle`), each also through a variable a statement copies the parameter
 * to (`action = varargin{1}; feval(action, …)`, `r = regr; feval(r)`): every
 * place a sink may read when its parameters cannot be read (null). A line
 * continued with `...` is read with the next. The test is on text, before
 * the function is parsed: a superset of the sinks the walk finds, apart from
 * one reading a parameter through anything else (`r = [regr]`).
 */
function sinkUses(text: string, params: readonly string[] | null): { sink: number; handle: number } {
  if (params === null) return { sink: ALL_PLACES, handle: 0 };
  const placesBy = new Map<string, number>();
  params.forEach((p, k) => {
    if (p !== '~' && !placesBy.has(p)) placesBy.set(p, placesOf(params, k));
  });
  if (placesBy.size === 0) return { sink: 0, handle: 0 };
  const logical = text.replace(/\.\.\.[^\n]*\n/g, ' ');
  for (const m of logical.matchAll(COPY)) {
    const from = placesBy.get(m[2]!);
    if (from !== undefined && !params.includes(m[1]!)) placesBy.set(m[1]!, (placesBy.get(m[1]!) ?? 0) | from);
  }
  const names = [...placesBy.keys()].join('|');
  let sink = 0;
  let handle = 0;
  const named = new RegExp(`\\b(${names})\\b`, 'g');
  for (const m of logical.matchAll(SINK_CALL)) {
    for (const n of m[1]!.matchAll(named)) sink |= placesBy.get(n[1]!)!;
  }
  for (const n of logical.matchAll(new RegExp(`\\b(${names})\\s*\\(`, 'g'))) handle |= placesBy.get(n[1]!)!;
  return { sink, handle };
}
