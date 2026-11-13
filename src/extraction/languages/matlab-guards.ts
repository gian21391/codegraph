import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import { bracesIndex, callArgs, chainHead, firstBlock, literalIndex, namedChildren, stringLiteral } from './matlab-values';

/**
 * Whether what a caller passes decides that a parameter sink runs.
 *
 * The argument synthesis joins every value a function's callers pass at a
 * place (see resolution/matlab-argument-synthesizer.ts). That is true of a
 * sink every call reaches, and wrong of one only some calls reach:
 *
 *   function f(action, fname)
 *   if ~strcmp(action, 'run'), return; end
 *   feval(fname);                  % f('stop', 'bbb') never gets here
 *
 * So a sink is **guarded** when whether it runs depends on a condition that
 * reads what the caller passed: an `if` / `elseif` / `else`, a `switch`
 * case, a `while`, a `catch` (the `try` before it) or the left of `&&` /
 * `||` around it, or an exit on the way to it (`return`, and `break` /
 * `continue` in its loop) under such a condition. An error raised on the way
 * (`error(…)`, `rethrow`) counts only under a condition that compares what a
 * caller passed with a text (`otherwise, error('unknown action')`): an error
 * under any other (`if numel(x) ~= n, error(…)`) rejects malformed input,
 * which no caller in the project is taken to send.
 * A condition reads what the caller passed when it names a parameter,
 * `varargin`, `nargin` / `nargout`, `exist(…)` of a variable, `inputname`,
 * `evalin`, or a variable an assignment computed from any of these, in any
 * way, anywhere in the function (no order kept: more is guarded, never less).
 *
 * A guarded sink gives nothing, unless every such condition tests the very
 * value it reads — the same parameter and field path, as written or through
 * a variable assigned once from it — against texts written there:
 * `switch v` / `switch lower(v)` / `switch v(1:4)`, `strcmp` / `strcmpi` /
 * `strncmp` / `strncmpi` / `isequal` with a text, `ismember` / `any(strcmp(…))`
 * with a cell of texts, combined by `~`, `&&` and `||`. Then the sink keeps
 * those tests (MatlabGuard), and the synthesis takes only the values they
 * admit (see admits). A condition that reads nothing a caller passed decides
 * nothing between callers: it admits every value.
 *
 * The record of what a call passes (see matlab.ts callArgsFact) keeps a
 * parameter passed on only where the call is not guarded: the sink it may
 * reach in the callee cannot tell which callers got there.
 *
 * A text that is a string object (`"drift"`) is read as the char vector it
 * spells: the records say texts, not which kind (`"drift"(1:4)` is an error
 * MATLAB raises, which no record can tell).
 */

/**
 * A test of the value a sink reads, as a caller's text, to admit it (see
 * admits):
 *   - `{ any }` — a condition no caller's value decides: either way;
 *   - `{ in, at?, fold?, ci?, n?, strict? }` — the value (its characters
 *     `at`, 1-based and inclusive; lower- or upper-cased by `fold`) is one of
 *     `in` (both sides lower-cased with `ci`, as `strcmpi` compares), or,
 *     with `n`, has the same first n characters as one (`strncmp`).
 *     `strict`: a value that is no text raises an error (`switch`,
 *     `ismember`); else it is just not equal (`strcmp`);
 *   - `{ is }` — what the value is: a text (`ischar`), a handle
 *     (`isa(v, 'function_handle')`), or neither (`isempty`, `iscell`, …: no
 *     text a record holds is empty);
 *   - `{ not }`, `{ and }`, `{ or }` — as MATLAB's `~`, `&&`, `||`, left to
 *     right (an empty `and` is true, an empty `or` false).
 */
export type MatlabGuard =
  | { any: 1 }
  | { in: string[]; at?: [number, number]; fold?: 'l' | 'u'; ci?: 1; n?: number; strict?: 1 }
  | { is: 'char' | 'handle' | 'other' }
  | { not: MatlabGuard }
  | { and: MatlabGuard[] }
  | { or: MatlabGuard[] };

const ANY: MatlabGuard = { any: 1 };
/** A condition true (or false) for every caller that passes the value: `nargin` when it is passed, `isempty(varargin)`. */
const TRUE: MatlabGuard = { and: [] };
const FALSE: MatlabGuard = { or: [] };

/** A guard's outcome for one value: true, false, either (a condition no caller decides), or an error raised. */
type Outcome = 'T' | 'F' | 'E' | 'X';

function outcome(g: MatlabGuard, item: string): Outcome {
  if ('any' in g) return 'E';
  if ('not' in g) {
    const r = outcome(g.not, item);
    return r === 'T' ? 'F' : r === 'F' ? 'T' : r;
  }
  if ('and' in g || 'or' in g) {
    const and = 'and' in g;
    let either = false;
    for (const part of and ? (g as { and: MatlabGuard[] }).and : (g as { or: MatlabGuard[] }).or) {
      const r = outcome(part, item);
      if (r === 'X') return 'X';
      if (r === 'E') either = true;
      else if (r === (and ? 'F' : 'T')) return either ? 'E' : r;
    }
    return either ? 'E' : and ? 'T' : 'F';
  }
  const isText = item.startsWith("'");
  if ('is' in g) return (g.is === 'char' && isText) || (g.is === 'handle' && !isText) ? 'T' : 'F';
  // A handle (`@name`): no text to compare.
  if (!isText) return g.strict ? 'X' : 'F';
  let text = item.slice(1);
  if (g.at) {
    if (text.length < g.at[1]) return 'X'; // index past the end
    text = text.slice(g.at[0] - 1, g.at[1]);
  }
  if (g.fold) text = g.fold === 'l' ? text.toLowerCase() : text.toUpperCase();
  const same = (s: string): string => (g.ci ? s.toLowerCase() : s);
  text = same(text);
  const n = g.n;
  const hit = g.in.some((lit) => (n === undefined ? same(lit) === text : text.length >= n && lit.length >= n && same(lit).slice(0, n) === text.slice(0, n)));
  return hit ? 'T' : 'F';
}

/** Whether a sink with `guards` runs for a caller passing `item` (`'text` or `@name`, as MatlabArgItem writes them). */
export function admits(guards: readonly MatlabGuard[] | undefined, item: string): boolean {
  if (!guards) return true;
  return guards.every((g) => {
    const r = outcome(g, item);
    return r === 'T' || r === 'E';
  });
}

/** One condition on the way to a node (see GuardScope.conditions). */
type Condition =
  /** An `if` / `elseif` / `while` condition, or the left of `&&` / `||`, that must be true (or, `neg`, false). */
  | { kind: 'test'; node: SyntaxNode; neg: boolean }
  /** A `switch` whose subject must match `labels` (the case's) and none of `before` (the cases above it; for `otherwise`, every case). */
  | { kind: 'case'; subject: SyntaxNode; labels: SyntaxNode | null; before: SyntaxNode[] }
  /** Code whose running decides it, which no test reads (a `try` before its `catch`). */
  | { kind: 'opaque'; node: SyntaxNode };

/** The value a sink reads, as a test can name it: its parameter's place and field path. */
interface SinkValue {
  readonly position: number;
  readonly path: readonly string[];
}

/** How a test reads that value: some of its characters, case-folded. */
interface ValueRead {
  at?: [number, number];
  fold?: 'l' | 'u';
}

/** Calls whose result says what the caller passed (how many, or a variable of its workspace). */
const CALLER_CALLS = /^(?:nargin|nargout|inputname|evalin|narginchk|nargoutchk|nargchk)$/;
/** Statements that end a function by raising an error. */
const RAISES = new Set(['error', 'throw', 'rethrow', 'throwAsCaller']);
const LOOPS = new Set(['for_statement', 'while_statement', 'parfor_statement']);
/** Statements that run code under a condition of their own. */
const BRANCHES = new Set(['if_statement', 'switch_statement', 'while_statement', 'for_statement', 'parfor_statement', 'try_statement', 'function_definition', 'lambda']);
/** The exits that are no error. */
const EXITS = new Set(['return_statement', 'break_statement', 'continue_statement']);
/** Calls that compare a value with a text (see GuardScope.dispatches). */
const TEXT_TESTS = /^(?:strcmpi?|strncmpi?|isequal|ismember|any|contains|startsWith|endsWith|regexpi?|validatestring)$/;
/** Nested assignments a variable is followed through for what it copies (`a = b; c = a`). */
const MAX_COPIES = 4;

/**
 * One function's guards (see the top of this file): what its variables are
 * computed from, and its exits, read once from its definition.
 */
export class GuardScope {
  /** The names whose value depends on what the caller passed. */
  private readonly tainted: Set<string>;
  /** Every write of each name (assignment, loop, `catch`, `global`), by head. */
  private readonly writes = new Map<string, number>();
  /** The right side of each plain `x = …`, by name. */
  private readonly plain = new Map<string, SyntaxNode[]>();
  private readonly exits: SyntaxNode[] = [];
  private readonly readsMemo = new Map<number, boolean>();

  constructor(
    private readonly def: SyntaxNode,
    private readonly params: readonly (string | null)[],
    private readonly source: string,
  ) {
    const deps = new Map<string, SyntaxNode[]>();
    const wrote = (head: SyntaxNode | null, from: SyntaxNode | null): void => {
      if (head?.type !== 'identifier') return;
      const name = getNodeText(head, source);
      this.writes.set(name, (this.writes.get(name) ?? 0) + 1);
      if (from) (deps.get(name) ?? deps.set(name, []).get(name)!).push(from);
    };
    const walk = (n: SyntaxNode, nested: boolean): void => {
      for (const c of namedChildren(n)) {
        switch (c.type) {
          case 'function_definition':
            // A nested function writes the variables it shares: followed for those, not for its exits.
            walk(c, true);
            continue;
          case 'assignment': {
            const left = getChildByField(c, 'left');
            const right = getChildByField(c, 'right');
            if (left?.type === 'multioutput_variable') for (const out of namedChildren(left)) wrote(chainHead(out), c);
            else wrote(chainHead(left), c);
            if (left?.type === 'identifier' && right) {
              const name = getNodeText(left, source);
              (this.plain.get(name) ?? this.plain.set(name, []).get(name)!).push(right);
            }
            break;
          }
          case 'iterator':
            wrote(c.namedChild(0), c);
            break;
          case 'catch_clause': {
            const v = c.namedChild(0);
            if (v?.type === 'identifier' && v.startPosition.row === c.startPosition.row) wrote(v, c.parent);
            break;
          }
          case 'global_operator':
          case 'persistent_operator':
            for (const v of namedChildren(c)) if (v.type === 'identifier') wrote(v, c);
            break;
          case 'return_statement':
          case 'break_statement':
          case 'continue_statement':
            if (!nested) this.exits.push(c);
            break;
          default:
            if (!nested && this.raises(c)) this.exits.push(c);
        }
        walk(c, nested);
      }
    };
    walk(def, false);

    this.tainted = new Set(['varargin', 'nargin', 'nargout']);
    for (const p of params) if (p) this.tainted.add(p);
    // Every name computed from a tainted one, whatever the order: to a fixed point.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, from] of deps) {
        if (this.tainted.has(name)) continue;
        if (from.some((n) => this.readsCaller(n, false))) {
          this.tainted.add(name);
          changed = true;
        }
      }
    }
  }

  /** Whether a statement raises an error whenever it runs: `error('…')`, `error msg`, `rethrow(ME)`, `ME.rethrow()`. */
  private raises(s: SyntaxNode): boolean {
    let name: SyntaxNode | null | undefined;
    if (s.type === 'function_call') {
      if (callArgs(s).length === 0) return false;
      name = getChildByField(s, 'name');
    } else if (s.type === 'command') name = namedChildren(s).find((c) => c.type === 'command_name');
    else if (s.type === 'field_expression') {
      const parts = namedChildren(s);
      const last = parts[parts.length - 1];
      name = parts.length === 2 && last?.type === 'function_call' ? getChildByField(last, 'name') : null;
      return !!name && name.type === 'identifier' && getNodeText(name, this.source) !== 'error' && RAISES.has(getNodeText(name, this.source));
    }
    return !!name && RAISES.has(getNodeText(name, this.source)) && (s.parent?.type === 'block' || s.parent?.type === 'source_file');
  }

  /** Whether `node` reads what the caller passed (see the top of this file); `memo` once the tainted names are final. */
  private readsCaller(node: SyntaxNode, memo = true): boolean {
    if (memo) {
      const known = this.readsMemo.get(node.id);
      if (known !== undefined) return known;
    }
    const source = this.source;
    const visit = (n: SyntaxNode): boolean => {
      if (n.type === 'identifier') return this.tainted.has(getNodeText(n, source));
      if (n.type === 'function_call') {
        const name = getChildByField(n, 'name');
        const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
        if (CALLER_CALLS.test(text)) return true;
        // `exist(x)`, `exist('x', 'var')`: whether the caller passed it.
        if (text === 'exist') {
          const args = callArgs(n);
          if (args.length === 1 || args.some((a) => stringLiteral(a, source) === 'var')) return true;
        }
      }
      if (n.type === 'command') {
        const name = namedChildren(n).find((c) => c.type === 'command_name');
        return !!name && CALLER_CALLS.test(getNodeText(name, source));
      }
      const parts = namedChildren(n);
      // A field's name is no variable: only what the chain starts from, and its indices.
      return parts.some((c, i) => !(n.type === 'field_expression' && i > 0 && c.type === 'identifier') && visit(c));
    };
    const out = visit(node);
    if (memo) this.readsMemo.set(node.id, out);
    return out;
  }

  /**
   * The conditions on the way from `stop` (an ancestor) down to `node`,
   * innermost first. With `call` (the call a sink or a passed parameter is
   * in), not those of an `if` or `switch` each of whose branches makes the
   * same call (`if nargout, [varargout{1:nargout}] = feval(varargin{:});
   * else, feval(varargin{:}); end`): the call runs whichever is taken.
   */
  private conditions(node: SyntaxNode, stop: SyntaxNode, call?: SyntaxNode): Condition[] {
    const out: Condition[] = [];
    const key = call ? compact(getNodeText(call, this.source)) : null;
    for (let child = node, a = node.parent; a && a.id !== stop.id; child = a, a = a.parent) {
      const branching = a.type === 'if_statement' || a.type === 'elseif_clause' || a.type === 'else_clause' || a.type === 'case_clause' || a.type === 'otherwise_clause';
      if (key && branching && this.everyBranchCalls(a.type === 'if_statement' ? a : a.parent, key)) continue;
      switch (a.type) {
        case 'if_statement':
          if (child.type === 'block') {
            const cond = getChildByField(a, 'condition');
            if (cond) out.push({ kind: 'test', node: cond, neg: false });
          }
          break;
        case 'elseif_clause':
        case 'else_clause': {
          const ifs = a.parent;
          if (!ifs) break;
          const inCondition = a.type === 'elseif_clause' && child.type !== 'block';
          // Every condition above it is false; its own is true.
          const first = getChildByField(ifs, 'condition');
          if (first) out.push({ kind: 'test', node: first, neg: true });
          for (const c of namedChildren(ifs)) {
            if (c.id === a.id) break;
            const cond = c.type === 'elseif_clause' ? getChildByField(c, 'condition') : null;
            if (cond) out.push({ kind: 'test', node: cond, neg: true });
          }
          const own = a.type === 'elseif_clause' && !inCondition ? getChildByField(a, 'condition') : null;
          if (own) out.push({ kind: 'test', node: own, neg: false });
          break;
        }
        case 'case_clause':
        case 'otherwise_clause': {
          const sw = a.parent;
          const subject = sw ? getChildByField(sw, 'condition') : null;
          if (!sw || !subject) break;
          const before: SyntaxNode[] = [];
          for (const c of namedChildren(sw)) {
            if (c.id === a.id) break;
            const labels = c.type === 'case_clause' ? getChildByField(c, 'condition') : null;
            if (labels) before.push(labels);
          }
          if (a.type === 'otherwise_clause') out.push({ kind: 'case', subject, labels: null, before });
          else if (child.type === 'block') out.push({ kind: 'case', subject, labels: getChildByField(a, 'condition'), before });
          else if (before.length > 0) out.push({ kind: 'case', subject, labels: null, before }); // its labels: read when no case above matched
          break;
        }
        case 'while_statement':
          if (child.type === 'block') {
            const cond = getChildByField(a, 'condition');
            if (cond) out.push({ kind: 'test', node: cond, neg: false });
          }
          break;
        case 'catch_clause': {
          const body = a.parent ? firstBlock(a.parent) : undefined;
          if (body) out.push({ kind: 'opaque', node: body });
          break;
        }
        case 'boolean_operator': {
          const left = getChildByField(a, 'left');
          if (left && child.id !== left.id) out.push({ kind: 'test', node: left, neg: this.operator(a) === '||' });
          break;
        }
      }
    }
    return out;
  }

  /** Whether every branch of an `if` (with an `else`) or a `switch` (with an `otherwise`) makes the call `key` (see compact), not under a condition of its own. */
  private everyBranchCalls(s: SyntaxNode | null, key: string): boolean {
    if (!s || (s.type !== 'if_statement' && s.type !== 'switch_statement')) return false;
    const blocks: SyntaxNode[] = [];
    let last = false;
    if (s.type === 'if_statement') {
      const own = firstBlock(s);
      if (own) blocks.push(own);
    }
    for (const c of namedChildren(s)) {
      if (c.type === 'elseif_clause' || c.type === 'else_clause' || c.type === 'case_clause' || c.type === 'otherwise_clause') {
        const b = firstBlock(c);
        if (!b) return false;
        blocks.push(b);
        if (c.type === 'else_clause' || c.type === 'otherwise_clause') last = true;
      }
    }
    const source = this.source;
    const calls = (n: SyntaxNode): boolean => {
      if (n.type === 'function_call' && compact(getNodeText(n, source)) === key) return true;
      return !BRANCHES.has(n.type) && namedChildren(n).some(calls);
    };
    return last && blocks.length > 1 && blocks.every(calls);
  }

  /** A binary node's operator token. */
  private operator(n: SyntaxNode): string {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c && !c.isNamed) return c.type;
    }
    return '';
  }

  /** The exits that may end the function, or the loop around `node`, before `node` runs: each with the conditions it is under, apart from `node`'s own. */
  private exitConditions(node: SyntaxNode): Condition[][] {
    const above = new Set<number>();
    for (let a: SyntaxNode | null = node.parent; a && a.id !== this.def.id; a = a.parent) above.add(a.id);
    const out: Condition[][] = [];
    for (const exit of this.exits) {
      let loop: SyntaxNode | null = null;
      let shared: SyntaxNode | null = null;
      let common: SyntaxNode = this.def;
      for (let a = exit.parent; a && a.id !== this.def.id; a = a.parent) {
        if (!loop && LOOPS.has(a.type)) loop = a;
        if (common.id === this.def.id && above.has(a.id)) common = a;
      }
      for (let a: SyntaxNode | null = common; a && a.id !== this.def.id; a = a.parent) {
        if (LOOPS.has(a.type)) {
          shared = a;
          break;
        }
      }
      if (exit.type === 'break_statement' || exit.type === 'continue_statement') {
        // It leaves its own loop: what is in that loop.
        if (!loop || !above.has(loop.id)) continue;
      } else if (exit.startIndex >= node.startIndex && !shared) continue;
      // In another branch of the same `if` / `switch`: never on the way, but round a loop around both.
      const apart = common.type === 'if_statement' || common.type === 'switch_statement';
      if (apart && !shared) continue;
      const conds = this.conditions(exit, apart ? common.parent ?? common : common);
      // Unconditional on the way: `node` after it never runs, or runs before it.
      if (conds.length === 0) continue;
      // An error rejects a call. One that tells callers' actions apart (`otherwise, error('unknown action')`) is
      // part of a dispatch; any other (`if numel(x) ~= n, error(…)`) rejects malformed input, which no
      // caller of the project is taken to send.
      if (!EXITS.has(exit.type) && !conds.some((c) => this.dispatches(c))) continue;
      out.push(conds);
    }
    return out;
  }

  /** Whether a condition compares what a caller passed with a text: a `switch` with text labels, `strcmp(action, 'run')`, `ismember(m, {…})`. */
  private dispatches(c: Condition): boolean {
    if (c.kind === 'opaque') return false;
    if (c.kind === 'case') return this.caseReadsCaller(c) && [c.labels, ...c.before].some((l) => l !== null && hasText(l));
    const source = this.source;
    const visit = (n: SyntaxNode): boolean => {
      if (n.type === 'function_call') {
        const name = getChildByField(n, 'name');
        if (name?.type === 'identifier' && TEXT_TESTS.test(getNodeText(name, source)) && callArgs(n).some(hasText) && this.readsCaller(n)) return true;
      } else if (n.type === 'comparison_operator' && namedChildren(n).some((x) => x.type === 'string') && this.readsCaller(n)) return true;
      return namedChildren(n).some(visit);
    };
    return visit(c.node);
  }

  /** Whether some condition on the way to the call `node` (see conditions, exitConditions) reads what the caller passed. */
  guarded(node: SyntaxNode): boolean {
    const all = [...this.conditions(node, this.def, node), ...this.exitConditions(node).flat()];
    return all.some((c) => (c.kind === 'case' ? this.caseReadsCaller(c) : this.readsCaller(c.node)));
  }

  private caseReadsCaller(c: Extract<Condition, { kind: 'case' }>): boolean {
    return this.readsCaller(c.subject) || (c.labels !== null && this.readsCaller(c.labels)) || c.before.some((b) => this.readsCaller(b));
  }

  /**
   * The tests a sink at `node` that reads `value` runs under (see
   * MatlabGuard): [] for none that a caller decides, null when one is
   * decided by something else than that value as a test can read it.
   */
  sinkGuards(node: SyntaxNode, value: SinkValue): MatlabGuard[] | null {
    const out: MatlabGuard[] = [];
    const push = (g: MatlabGuard | null): boolean => {
      if (!g) return false;
      if (!('any' in g) && !('and' in g && g.and.length === 0)) out.push(g);
      return true;
    };
    for (const c of this.conditions(node, this.def, callOf(node))) if (!push(this.guardOf(c, value))) return null;
    for (const conds of this.exitConditions(node)) {
      const found = conds.map((c) => this.guardOf(c, value));
      // A condition on the way to it that is false for every caller passing the value (`if nargin < 2` where the
      // value is the second): that exit is never taken, whatever its other conditions are.
      if (found.some((g) => g !== null && 'or' in g && g.or.length === 0)) continue;
      if (found.some((g) => g === null)) return null;
      const parts = found as MatlabGuard[];
      // The exit is taken when all of its conditions hold: the sink runs when one does not.
      if (!push(parts.every((p) => 'any' in p) ? ANY : { not: parts.length === 1 ? parts[0]! : { and: parts } })) return null;
    }
    return out;
  }

  private guardOf(c: Condition, value: SinkValue): MatlabGuard | null {
    if (c.kind === 'opaque') return this.readsCaller(c.node) ? null : ANY;
    if (c.kind === 'test') {
      const g = this.test(c.node, value);
      return !g || 'any' in g || !c.neg ? g : { not: g };
    }
    if (!this.caseReadsCaller(c)) return ANY;
    const read = this.valueRead(c.subject, value, 0);
    if (!read) return null;
    const labelsOf = (n: SyntaxNode): string[] | null => {
      if (n.type === 'string') {
        const s = stringLiteral(n, this.source);
        return s === null ? null : [s];
      }
      return this.cellOfTexts(n);
    };
    const above: string[] = [];
    for (const b of c.before) {
      const l = labelsOf(b);
      if (!l) return null;
      above.push(...l);
    }
    const match = (labels: string[]): MatlabGuard => ({ in: labels, ...read, strict: 1 });
    const notAbove: MatlabGuard[] = above.length > 0 ? [{ not: match(above) }] : [];
    if (c.labels === null) return notAbove.length > 0 ? notAbove[0]! : ANY;
    const own = labelsOf(c.labels);
    if (!own) return null;
    return notAbove.length > 0 ? { and: [...notAbove, match(own)] } : match(own);
  }

  /** A condition as a test of the sink's value (see MatlabGuard), ANY when it reads nothing a caller passed, null when it is no such test. */
  private test(n: SyntaxNode, value: SinkValue): MatlabGuard | null {
    if (!this.readsCaller(n)) return ANY;
    const source = this.source;
    switch (n.type) {
      case 'identifier':
        // `nargin`: a caller that passes the value passes one argument at least.
        return getNodeText(n, source) === 'nargin' ? TRUE : null;
      case 'comparison_operator':
        return this.comparison(n, value);
      case 'parenthesis': {
        const inner = namedChildren(n)[0];
        return inner ? this.test(inner, value) : null;
      }
      case 'not_operator': {
        const inner = namedChildren(n)[0];
        const g = inner ? this.test(inner, value) : null;
        return g && !('any' in g) ? { not: g } : g;
      }
      case 'boolean_operator':
      case 'binary_operator': {
        const op = this.operator(n);
        const and = op === '&&' || op === '&';
        if (!and && op !== '||' && op !== '|') return null;
        const left = getChildByField(n, 'left');
        const right = getChildByField(n, 'right');
        return combine(and, left ? this.test(left, value) : null, right ? this.test(right, value) : null);
      }
      case 'function_call': {
        const nameNode = getChildByField(n, 'name');
        const name = nameNode?.type === 'identifier' ? getNodeText(nameNode, source) : '';
        const args = callArgs(n);
        if (name === 'not' && args.length === 1) {
          const g = this.test(args[0]!, value);
          return g && !('any' in g) ? { not: g } : g;
        }
        if (name === 'any' && args.length === 1 && args[0]!.type === 'function_call') {
          const inner = args[0]!;
          const innerName = getNodeText(getChildByField(inner, 'name') ?? inner, source);
          const innerArgs = callArgs(inner);
          if ((innerName === 'strcmp' || innerName === 'strcmpi') && innerArgs.length === 2) {
            return this.compared(innerArgs[0]!, innerArgs[1]!, value, innerName === 'strcmpi', true);
          }
          return null;
        }
        if (args.length === 1 && TYPE_TESTS.has(name)) {
          // `isempty(varargin)` with the value among the variadic arguments: false.
          if (name === 'isempty' && args[0]!.type === 'identifier' && getNodeText(args[0]!, source) === 'varargin' && this.variadicFrom() !== null && value.position >= this.variadicFrom()!) return FALSE;
          return this.valueRead(args[0]!, value, 0) ? { is: TYPE_TESTS.get(name)! } : null;
        }
        if (name === 'isa' && args.length === 2) {
          const cls = stringLiteral(args[1]!, source);
          const is = cls === 'char' ? 'char' : cls === 'function_handle' ? 'handle' : null;
          return is && this.valueRead(args[0]!, value, 0) ? { is } : null;
        }
        if (name === 'ismember' && args.length === 2) {
          const read = this.valueRead(args[0]!, value, 0);
          const labels = this.cellOfTexts(args[1]!);
          return read && labels ? { in: labels, ...read, strict: 1 } : null;
        }
        if ((name === 'strcmp' || name === 'strcmpi' || name === 'isequal') && args.length === 2) {
          return this.compared(args[0]!, args[1]!, value, name === 'strcmpi', false) ?? this.compared(args[1]!, args[0]!, value, name === 'strcmpi', false);
        }
        if ((name === 'strncmp' || name === 'strncmpi') && args.length === 3) {
          const k = literalCount(args[2]!, source);
          if (k === null) return null;
          const g = this.compared(args[0]!, args[1]!, value, name === 'strncmpi', false) ?? this.compared(args[1]!, args[0]!, value, name === 'strncmpi', false);
          return g && 'in' in g ? { ...g, n: k } : null;
        }
        return null;
      }
    }
    return null;
  }

  /** The position of the first variadic argument (`varargin`'s), or null when the function takes none. */
  private variadicFrom(): number | null {
    const last = this.params.length - 1;
    return this.params[last] === 'varargin' ? last : null;
  }

  /**
   * `nargin > 1`, `numel(varargin) >= 2`: a count of the arguments against a
   * number, decided when the value's own place says it — a caller passing it
   * passes at least that many — and null otherwise (`nargin == 3`).
   */
  private comparison(n: SyntaxNode, value: SinkValue): MatlabGuard | null {
    const parts = namedChildren(n);
    if (parts.length !== 2) return null;
    const [left, right] = parts as [SyntaxNode, SyntaxNode];
    // The grammar reads `nargin < 1 | x` as `nargin < (1 | x)`; MATLAB, as `(nargin < 1) | x`.
    const logical = right.type === 'binary_operator' || right.type === 'boolean_operator' ? this.operator(right) : '';
    if (/^(?:\|\|?|&&?)$/.test(logical)) {
      const inner = getChildByField(right, 'left');
      const rest = getChildByField(right, 'right');
      return combine(logical.startsWith('&'), inner ? this.countTest(left, this.operator(n), inner, value) : null, rest ? this.test(rest, value) : null);
    }
    return this.countTest(left, this.operator(n), right, value);
  }

  private countTest(left: SyntaxNode, op: string, right: SyntaxNode, value: SinkValue): MatlabGuard | null {
    if (!this.readsCaller(left) && !this.readsCaller(right)) return ANY;
    if (left.type === 'number') {
      [left, right] = [right, left];
      op = ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' } as Record<string, string>)[op] ?? op;
    }
    const k = right.type === 'number' && /^\d{1,6}$/.test(getNodeText(right, this.source)) ? Number(getNodeText(right, this.source)) : null;
    if (k === null) return null;
    let least: number | null = null;
    const text = getNodeText(left, this.source);
    if (left.type === 'identifier' && text === 'nargin') least = value.position + 1;
    else if (left.type === 'function_call' && /^(?:numel|length)\(\s*varargin\s*\)$/.test(text)) {
      const from = this.variadicFrom();
      least = from !== null && value.position >= from ? value.position - from + 1 : null;
    }
    if (least === null) return null;
    // What `count op k` is for every count from `least` on, when that is the same.
    switch (op) {
      case '>': return least > k ? TRUE : null;
      case '>=': return least >= k ? TRUE : null;
      case '<': return least >= k ? FALSE : null;
      case '<=': return least > k ? FALSE : null;
      case '==': return least > k ? FALSE : null;
      case '~=':
      case '!=': return least > k ? TRUE : null;
    }
    return null;
  }

  /** `strcmp(x, 'lit')`: x the sink's value, lit a text (or, `cell`, a cell of texts). */
  private compared(x: SyntaxNode, lit: SyntaxNode, value: SinkValue, insensitive: boolean, cell: boolean): MatlabGuard | null {
    const read = this.valueRead(x, value, 0);
    if (!read) return null;
    const one = cell ? null : stringLiteral(lit, this.source);
    const labels = cell ? this.cellOfTexts(lit) : one === null ? null : [one];
    if (!labels) return null;
    // `strcmpi`: both sides lower-cased, after what the read already did.
    return { in: labels, ...read, ...(insensitive ? { ci: 1 as const } : {}) };
  }

  /** `{'a', 'b'}` as its texts, or null for anything else. */
  private cellOfTexts(n: SyntaxNode): string[] | null {
    if (n.type !== 'cell') return null;
    const out: string[] = [];
    for (const row of namedChildren(n)) {
      if (row.type !== 'row') return null;
      for (const item of namedChildren(row)) {
        const s = stringLiteral(item, this.source);
        if (s === null) return null;
        out.push(s);
      }
    }
    return out.length > 0 ? out : null;
  }

  /**
   * How `n` reads the sink's value (see ValueRead), or null when it reads
   * anything else: the parameter (or `varargin{k}`, or a field path of one)
   * never assigned in the function, through `lower` / `upper`, characters
   * `x(a:b)`, and variables assigned once from such a read.
   */
  private valueRead(n: SyntaxNode, value: SinkValue, depth: number): ValueRead | null {
    const source = this.source;
    const params = this.params;
    const last = params.length - 1;
    const untouched = (name: string): boolean => !this.writes.has(name);
    switch (n.type) {
      case 'parenthesis': {
        const inner = namedChildren(n)[0];
        return inner ? this.valueRead(inner, value, depth) : null;
      }
      case 'identifier': {
        const name = getNodeText(n, source);
        const k = params.indexOf(name);
        if (k >= 0) {
          const variadic = name === 'varargin' && k === last;
          return !variadic && k === value.position && value.path.length === 0 && untouched(name) ? {} : null;
        }
        // A copy, assigned once.
        const from = this.plain.get(name);
        if (depth >= MAX_COPIES || this.writes.get(name) !== 1 || from?.length !== 1) return null;
        return this.valueRead(from[0]!, value, depth + 1);
      }
      case 'field_expression': {
        const parts = namedChildren(n);
        if (parts.some((p) => p.type !== 'identifier')) return null;
        const [head, ...fields] = parts.map((p) => getNodeText(p, source));
        const k = params.indexOf(head!);
        const same = k === value.position && fields.length === value.path.length && fields.every((f, i) => f === value.path[i]);
        return k >= 0 && same && head !== 'varargin' && untouched(head!) ? {} : null;
      }
      case 'function_call': {
        const nameNode = getChildByField(n, 'name');
        if (nameNode?.type !== 'identifier') return null;
        const name = getNodeText(nameNode, source);
        const args = callArgs(n);
        if (bracesIndex(n)) {
          // `varargin{k}`
          const index = literalIndex(n, source);
          return name === 'varargin' && params[last] === 'varargin' && index !== null && last + index - 1 === value.position && value.path.length === 0 && untouched(name) ? {} : null;
        }
        if ((name === 'lower' || name === 'upper') && args.length === 1) {
          const inner = this.valueRead(args[0]!, value, depth);
          return inner ? { ...inner, fold: name === 'lower' ? 'l' : 'u' } : null;
        }
        // `x(a:b)`: some of its characters.
        if (args.length === 1 && args[0]!.type === 'range') {
          const ends = namedChildren(args[0]!);
          const a = ends.length === 2 ? literalCount(ends[0]!, source) : null;
          const b = ends.length === 2 ? literalCount(ends[1]!, source) : null;
          if (a === null || b === null || a > b) return null;
          const inner = this.valueRead(nameNode, value, depth);
          // (Characters of a case-folded text are those of the text, folded.)
          return inner && !inner.at ? { ...inner, at: [a, b] } : null;
        }
        return null;
      }
    }
    return null;
  }
}

/**
 * `a && b` / `a || b` of two tests, null when one cannot be told — unless
 * the other decides it alone: false for `&&`, true for `||`.
 */
function combine(and: boolean, a: MatlabGuard | null, b: MatlabGuard | null): MatlabGuard | null {
  const decides = (g: MatlabGuard | null): boolean => g !== null && (and ? 'or' in g && g.or.length === 0 : 'and' in g && g.and.length === 0);
  if (decides(a)) return a;
  if (decides(b)) return b;
  if (!a || !b) return null;
  return and ? { and: [a, b] } : { or: [a, b] };
}

/** Tests of what a value is (see MatlabGuard): a text, a handle, or neither, which no recorded value is. */
const TYPE_TESTS = new Map<string, 'char' | 'handle' | 'other'>([
  ['ischar', 'char'],
  ['isempty', 'other'],
  ['iscell', 'other'],
  ['iscellstr', 'other'],
  ['isstruct', 'other'],
  ['isnumeric', 'other'],
  ['islogical', 'other'],
  ['isfloat', 'other'],
  ['isinteger', 'other'],
  ['isobject', 'other'],
]);

/** A call's text without blanks, comments or continuations: the same call written twice is the same. */
function compact(text: string): string {
  return text.replace(/\.\.\.[^\n]*\n/g, '').replace(/%[^\n]*/g, '').replace(/\s+/g, '');
}

/** The call `node` is, or is an argument of. */
function callOf(node: SyntaxNode): SyntaxNode {
  const p = node.parent;
  return p?.type === 'arguments' && p.parent?.type === 'function_call' ? p.parent : node;
}

/** Whether `n` is a text literal, or a cell holding one. */
function hasText(n: SyntaxNode): boolean {
  return n.type === 'string' || (n.type === 'cell' && namedChildren(n).some((row) => namedChildren(row).some((x) => x.type === 'string')));
}

/** A positive integer literal's value, or null. */
function literalCount(n: SyntaxNode, source: string): number | null {
  if (n.type !== 'number') return null;
  const text = getNodeText(n, source);
  return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : null;
}
