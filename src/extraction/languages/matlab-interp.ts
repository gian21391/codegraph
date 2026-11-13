import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import { MATLAB_BUILTINS, MATLAB_CALLBACK_OWNERS, MATLAB_CODE_RUNNERS, MATLAB_FUNCTION_TAKERS } from './matlab-builtins';
import {
  type EnvReader,
  type FieldUpdate,
  type Recorder,
  type Val,
  type ValueHost,
  OPEN,
  bracesIndex,
  callArgs,
  cellVal,
  childField,
  chainHead,
  commandItems,
  errorVariable,
  evaluate,
  firstBlock,
  hasForeign,
  isUnknown,
  join,
  literalIndex,
  namedChildren,
  sameVal,
  stringLiteral,
  besidesText,
  withCellElement,
  withCellPart,
  withElementPath,
  withOpen,
  withChildrenMemo,
  withPath,
  HOLE,
} from './matlab-values';

/**
 * A small flow-sensitive interpreter of one MATLAB scope (a function's body,
 * or a script's top level): it follows the code statement by statement with
 * what each variable can hold (see matlab-values.ts), so that what a call
 * built from text names is known where it is made:
 *
 *   m = 'DriftPass'; if x, m = 'QuadPass'; end
 *   r = feval(m, elem, r);          % DriftPass or QuadPass
 *   m = 'IdentityPass';             % … not this one
 *
 * Branches are followed from a fork of the workspace each and joined after;
 * a branch that leaves (`return`, `error(…)`, `break`, `continue`) joins
 * nothing after it — a `break` joins the loop's exit, a `continue` the next
 * round, an `error` the `catch` of the `try` around it. A loop is followed
 * until what it assigns settles (a few rounds at most, then what still
 * changes is left open). What the walk records is the value of each node a
 * dynamic call reads (see sinkInputs), joined over every time the walk
 * reaches it; the extractor reads those back as it walks the scope.
 *
 * What may change a variable without the code saying so makes it unknown:
 * code `eval` runs (what that code would change, followed the same way, or
 * every variable when the code is not known), `load` without a list of
 * names, `clear`, a statement that may run a script (`setup_vars`), and in a
 * script `evalin` / `assignin`. A global, and a variable a nested function
 * shares (it runs at any call), is never known. A struct the code did not
 * build itself may be an object, its fields changed by any call that may run
 * the project's code, or through another variable it was handed to: its
 * fields are forgotten then. A function called here that reaches back into
 * this workspace (`assignin('caller', …)`) is not followed.
 */

/** A scope's recorded values: node id → value. */
export type ScopeValues = ReadonlyMap<number, Val>;

export const NO_VALUES: ScopeValues = new Map();

/**
 * Words without which a scope has nothing to interpret: no call built from
 * text, no callback property, no named handle assigned to a variable (a
 * lambda's value is never known, and a handle passed on is referenced where
 * it is written).
 */
export const SINK_WORDS =
  /\b(?:feval|evalc?|evalin|str2func|run|cellfun|arrayfun|structfun|ode\w+|fzero|fmin\w+|fsolve|lsq\w+|quadgk|integral\d?)\b|[Ff][Cc][Nn]\b|[Cc]allback|=\s*@\s*[A-Za-z]/;

/** A GUI property whose value is a callback: `'Callback'`, `'ButtonDownFcn'`, `'TimerFcn'`, … */
export const CALLBACK_PROPERTY = /^(?:callback|\w*fcn)$/i;

/**
 * How a dynamic call reads an argument:
 *   - `feval` — a function to call, by name or handle;
 *   - `function` — a function named as text, taken as a handle (`str2func`, `cellfun('f', …)`);
 *   - `eval` — code run here (`eval`, `evalc`, and their catch code);
 *   - `evalin` — code run in another workspace;
 *   - `run` — a script (or function) to run;
 *   - `callback` — code a GUI object runs on an event (`'Callback', 'go'`).
 */
export type SinkKind = 'feval' | 'function' | 'eval' | 'evalin' | 'run' | 'callback';

export interface SinkInput {
  /** Index in the call's arguments (see callArgs). */
  index: number;
  kind: SinkKind;
}

/**
 * The arguments of `name(args)` a dynamic call reads, and how. The one rule
 * the interpreter (to record their values) and the extractor (to emit their
 * references) share; whether `name` is a function there (no variable) is the
 * extractor's to check. Callback properties are read from name/value pairs
 * of MATLAB's GUI constructors and setters only (MATLAB_CALLBACK_OWNERS),
 * in step: a value that spells `'Callback'` is no key.
 */
export function sinkInputs(name: string, args: readonly SyntaxNode[], source: string): SinkInput[] {
  const out: SinkInput[] = [];
  const n = args.length;
  switch (name) {
    case 'feval':
      if (n > 0) out.push({ index: 0, kind: 'feval' });
      break;
    case 'str2func':
      if (n > 0) out.push({ index: 0, kind: 'function' });
      break;
    case 'eval':
    case 'evalc':
      for (let i = 0; i < Math.min(n, 2); i++) out.push({ index: i, kind: 'eval' });
      break;
    case 'evalin':
      for (let i = 1; i < Math.min(n, 3); i++) out.push({ index: i, kind: 'evalin' });
      break;
    case 'run':
      if (n === 1) out.push({ index: 0, kind: 'run' });
      break;
    default:
      if (n > 0 && MATLAB_FUNCTION_TAKERS.has(name)) out.push({ index: 0, kind: 'function' });
  }
  if (!MATLAB_CALLBACK_OWNERS.has(name)) return out;
  // Where the name/value pairs start: after `set`'s handle; after a constructor's parent or data
  // (`uicontrol(fig, …)`, `line(x, y, …)`), and `text(x, y, str, …)`'s string.
  let i = 0;
  if (name === 'set') i = 1;
  else {
    while (i < n && stringLiteral(args[i]!, source) === null) i++;
    if (name === 'text' && i >= 2) i++;
  }
  for (; i + 1 < n; i += 2) {
    const key = stringLiteral(args[i]!, source);
    if (key === null) break; // a name computed among the pairs: which is which is lost
    if (CALLBACK_PROPERTY.test(key)) out.push({ index: i + 1, kind: 'callback' });
  }
  return out;
}

/**
 * The variables `load` makes, from its arguments as text (null for one that
 * is not literal): every name after the file's (options aside). None when
 * the list says nothing for sure — a wildcard or `-regexp` — or there is no
 * list (then every variable the file holds).
 */
export function loadedNames(items: readonly (string | null)[]): string[] {
  if (items.some((s) => s !== null && (s.includes('*') || s.toLowerCase() === '-regexp'))) return [];
  const rest = items.filter((s) => s === null || !s.startsWith('-'));
  return rest.slice(1).filter((s): s is string => s !== null && /^[A-Za-z]\w*$/.test(s));
}

/** Code given as text, parsed, with a host that reads it. */
export interface ParsedCode {
  readonly root: SyntaxNode;
  readonly host: InterpHost;
}

/** What the interpreter asks of the extractor beyond evaluation. */
export interface InterpHost extends ValueHost {
  /** Whether the file defines a function of this name (outside a class): a statement naming it runs no script. */
  isFileFunction(name: string): boolean;
  /** Code given as text (no HOLE in it), parsed, with a host for it whose variables are this one's and the code's own; null when it does not parse cleanly. */
  code(text: string): ParsedCode | null;
}

/** How a scope is interpreted. */
export interface ScopeOptions {
  /** A function's body (else a script's top level, or code given as text). */
  readonly isFunction: boolean;
  /** Names that hold something on entry — parameters, a method's output — and are never a new struct. */
  readonly inputs: ReadonlySet<string>;
  /** Whether a name is a variable the scope shares with a function around it (it is a nested function's): never known. */
  readonly shared: (name: string) => boolean;
}

/** Thrown when a walk passes its budget: the scope falls back to literal evaluation. */
class TooMuchWork extends Error {}

/** Rounds a loop's body is followed for before what still changes is left open. */
const MAX_ROUNDS = 3;
/** How deep code given as text is followed for what it changes (`eval('eval(''…'')')`). */
const MAX_CODE_DEPTH = 2;

/** Whether an error is the parser's wasm heap failing, which must reach the worker (see TreeSitterExtractor.extract). */
export function isWasmMemoryError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('memory access out of bounds') || msg.includes('out of memory');
}

/**
 * The values `scope`'s dynamic calls read (see the top of this file), or
 * none when the walk would take too long or fails (the extractor then
 * evaluates each as written, which knows less, never more).
 */
export function interpretScope(scope: SyntaxNode, options: ScopeOptions, host: InterpHost): ScopeValues {
  try {
    return withChildrenMemo(() => {
      const it = new Interpreter(host, options, scope, 0);
      if (it.knowsNothing) return NO_VALUES;
      it.run(scope);
      return it.values;
    });
  } catch (e) {
    if (isWasmMemoryError(e)) throw e;
    return NO_VALUES;
  }
}

/** What code given as text changes when it runs: the names it may set, the globals it declares; null when it may set any. */
interface CodeEffect {
  names: ReadonlySet<string>;
  globals: ReadonlySet<string>;
}

type Effect = { clear: true } | { codes: readonly Val[] };

/** Where a loop's rounds leave from: its entry, and the workspaces at its `break`s and `continue`s. */
interface LoopExits {
  readonly entry: Env;
  readonly breaks: Env[];
  readonly continues: Env[];
}

/** A `try`'s entry, and the workspaces at the `error`s inside it, where its `catch` may start. */
interface TryExits {
  readonly entry: Env;
  readonly throws: Env[];
}

/** Statements that raise an error: `error(…)`, `rethrow(ME)`, `ME.throw()`. */
const RAISES = new Set(['error', 'throw', 'rethrow', 'throwAsCaller']);

/** One walk of one scope (see the top of this file); its `values` are what interpretScope returns. */
class Interpreter implements Recorder {
  readonly values = new Map<number, Val>();
  /** Some function nested in the scope may change any of its variables (it evals code, runs a script): nothing to follow. */
  readonly knowsNothing: boolean;
  private readonly untracked: Set<string>;
  private steps = 0;
  private readonly budget: number;
  private pending: Effect[] = [];
  private readonly loops: LoopExits[] = [];
  private readonly tries: TryExits[] = [];
  /** Variables that held a struct the code did not build (see Recorder.invalidate). */
  private readonly foreign = new Set<string>();
  /** What this walk changed, for code given as text (see codeEffect). */
  observed: Observer | null = null;

  constructor(
    private readonly host: InterpHost,
    private readonly options: ScopeOptions,
    scope: SyntaxNode,
    private readonly codeDepth: number,
  ) {
    // Linear in the scope's size: a pathological nest of loops is cut off, not followed.
    this.budget = 8 * (scope.endIndex - scope.startIndex) + 20_000;
    const nested = options.isFunction ? nestedFunctionWrites(scope, host) : null;
    this.untracked = nested?.names ?? new Set();
    this.knowsNothing = nested?.any ?? false;
  }

  /** Whether a name is never known here: a global, or what a nested function or a function around this one may set. */
  isUntracked(name: string): boolean {
    return this.untracked.has(name) || this.options.shared(name);
  }

  /** Counts `n` units of work; past the budget, the walk stops (see TooMuchWork). */
  step(n = 1): void {
    this.steps += n;
    if (this.steps > this.budget) throw new TooMuchWork();
  }

  /** Follows the scope from its start: a function's body block, or every statement of a script or code given as text. */
  run(scope: SyntaxNode): Env {
    let env = new Env(null, this.observed);
    if (this.observed) env = env.fork();
    for (const c of namedChildren(scope)) {
      if (!this.options.isFunction || this.codeDepth > 0) env = this.statement(c, env);
      else if (c.type === 'block') env = this.block(c, env);
    }
    return env;
  }

  /** Joins `v` into what `node` was recorded to hold. */
  private record(node: SyntaxNode, v: Val): void {
    const had = this.values.get(node.id);
    this.values.set(node.id, had ? join(had, v) : v);
  }

  /** Records what a dynamic call reads, and notes what the call may change (see Recorder.call). */
  call(callee: SyntaxNode, name: string, args: readonly SyntaxNode[], vals: readonly Val[], env: EnvReader): void {
    if (this.host.isLocal(name)) {
      const own = this.isUntracked(name) ? undefined : env.get(name);
      if (own && own.fns.length > 0) this.record(callee, own);
      // Through a handle, any code may run; an index into an array runs none.
      if (!own || own.open || own.fns.length > 0) this.invalidate(env);
      return;
    }
    for (const { index } of sinkInputs(name, args, this.host.source)) this.record(args[index]!, vals[index]!);
    if (name === 'eval' || name === 'evalc') this.pending.push({ codes: vals.slice(0, 2) });
    else if (!this.options.isFunction && (name === 'evalin' || name === 'assignin')) this.pending.push({ clear: true });
    if (mayRunCode(name)) this.invalidate(env);
  }

  /** Forgets every variable that holds a struct the code did not build (see Recorder.invalidate). */
  invalidate(env: EnvReader): void {
    if (this.foreign.size === 0) return;
    const e = env as Env;
    for (const name of this.foreign) {
      const v = e.get(name);
      if (v && hasForeign(v)) e.delete(name);
    }
  }

  /** `node`'s value in `env`, every call in it heard. */
  private expr(node: SyntaxNode | null | undefined, env: Env): Val {
    return node ? evaluate(node, env, this.host, this) : OPEN;
  }

  /** Follows a block's statements in turn, until one leaves it. */
  private block(node: SyntaxNode | null | undefined, env: Env): Env {
    if (!node) return env;
    for (const s of namedChildren(node)) {
      if (env.dead) break;
      env = this.statement(s, env);
    }
    return env;
  }

  /** Follows one statement, changing `env` in place (or marking it left); returns it. */
  private statement(s: SyntaxNode, env: Env): Env {
    this.step();
    switch (s.type) {
      case 'comment':
      case 'function_definition':
      case 'function_signature':
      case 'class_definition':
      case 'arguments_statement':
        return env;
      case 'return_statement':
        env.dead = true;
        return env;
      case 'break_statement':
      case 'continue_statement': {
        const loop = this.loops[this.loops.length - 1];
        if (loop) (s.type === 'break_statement' ? loop.breaks : loop.continues).push(snapshot(env, loop.entry));
        env.dead = true;
        return env;
      }
      case 'assignment':
        this.assignment(s, env);
        break;
      case 'if_statement':
        env = this.ifStatement(s, env);
        break;
      case 'switch_statement':
        env = this.switchStatement(s, env);
        break;
      case 'for_statement':
        env = this.forStatement(s, env);
        break;
      case 'while_statement': {
        const cond = childField(s, 'condition');
        const body = firstBlock(s);
        this.expr(cond, env);
        env = this.applyEffects(env);
        env = this.loop(env, (e) => this.block(body, e), (e) => {
          this.expr(cond, e);
          this.applyEffects(e);
        });
        break;
      }
      case 'try_statement':
        env = this.tryStatement(s, env);
        break;
      case 'global_operator':
      case 'persistent_operator':
        for (const c of namedChildren(s)) {
          if (c.type !== 'identifier') continue;
          const name = getNodeText(c, this.host.source);
          this.untracked.add(name);
          this.observed?.globals.add(name);
          env.delete(name);
        }
        return env;
      case 'command':
        this.command(s, env);
        break;
      case 'function_call':
        this.expr(s, env);
        this.callStatement(s, env);
        break;
      case 'identifier': {
        // `setup_vars`: maybe a script, which may set any variable.
        const name = getNodeText(s, this.host.source);
        if (this.mayBeScript(name)) env.clear();
        return env;
      }
      default:
        if (namedChildren(s).some((c) => c.type === 'block')) {
          // `spmd … end` and the like: its blocks run once, in order.
          for (const c of namedChildren(s)) env = c.type === 'block' ? this.block(c, env) : (this.expr(c, env), env);
        } else this.expr(s, env);
    }
    env = this.applyEffects(env);
    if (!env.dead && this.raises(s)) {
      const t = this.tries[this.tries.length - 1];
      if (t) t.throws.push(snapshot(env, t.entry));
      env.dead = true;
    }
    return env;
  }

  /** Whether a statement raises an error whenever it runs: `error('…')`, `rethrow(ME)`, `ME.rethrow()`, `error msg`. */
  private raises(s: SyntaxNode): boolean {
    const source = this.host.source;
    let name: SyntaxNode | null | undefined;
    if (s.type === 'function_call') {
      name = childField(s, 'name');
      if (callArgs(s).length === 0) return false;
    } else if (s.type === 'command') name = namedChildren(s).find((c) => c.type === 'command_name');
    else if (s.type === 'field_expression') {
      const parts = namedChildren(s);
      const last = parts[parts.length - 1];
      name = parts.length === 2 && last?.type === 'function_call' ? childField(last, 'name') : null;
      return !!name && name.type === 'identifier' && RAISES.has(getNodeText(name, source)) && getNodeText(name, source) !== 'error';
    }
    if (!name) return false;
    const text = getNodeText(name, source);
    return RAISES.has(text) && !this.host.isLocal(text);
  }

  /** What the calls of the statement just followed may have done to the workspace (see the top of this file). */
  private applyEffects(env: Env): Env {
    if (this.pending.length === 0) return env;
    const effects = this.pending;
    this.pending = [];
    for (const e of effects) {
      if ('clear' in e) {
        env.clear();
        continue;
      }
      for (const code of e.codes) {
        if (besidesText(code) || code.strs.some((s) => s.includes(HOLE))) {
          env.clear();
          break;
        }
        for (const text of code.strs) {
          const effect = this.codeEffect(text);
          if (!effect) {
            env.clear();
            break;
          }
          for (const n of effect.names) env.delete(n);
          for (const g of effect.globals) this.untracked.add(g);
        }
      }
    }
    return env;
  }

  /**
   * What code given as text changes when `eval` runs it here: followed as a
   * script of its own would be (its `eval`s, its scripts, its `load`s), every
   * name it may set on any path. Null when that is any name, or the code is
   * nested too deep to follow.
   */
  private codeEffect(text: string): CodeEffect | null {
    if (this.codeDepth >= MAX_CODE_DEPTH) return null;
    // Another tree: its own memo of child lists.
    return withChildrenMemo(() => {
      const parsed = this.host.code(text);
      if (!parsed) return null;
      const options = { isFunction: this.options.isFunction, inputs: this.options.inputs, shared: (n: string) => this.isUntracked(n) };
      const sub = new Interpreter(parsed.host, options, parsed.root, this.codeDepth + 1);
      const observed: Observer = { names: new Set(), globals: new Set(), cleared: false };
      sub.observed = observed;
      try {
        sub.run(parsed.root);
      } catch (e) {
        if (isWasmMemoryError(e)) throw e;
        return null;
      }
      this.step(sub.steps);
      return observed.cleared ? null : observed;
    });
  }

  /** `x = e`, `s.f = e`, `c{k} = e`, `[a, b] = e`. */
  private assignment(s: SyntaxNode, env: Env): void {
    const left = childField(s, 'left');
    const right = childField(s, 'right');
    const rhs = this.expr(right, env);
    if (!left) return;
    const source = this.host.source;
    switch (left.type) {
      case 'identifier': {
        const name = getNodeText(left, source);
        if (!this.isUntracked(name)) this.put(env, name, rhs);
        return;
      }
      case 'field_expression': {
        const parts = namedChildren(left);
        const last = parts[parts.length - 1];
        // `h.Callback = 'go'`: callback code, read by the extractor.
        if (right && last?.type === 'identifier' && CALLBACK_PROPERTY.test(getNodeText(last, source))) this.record(right, rhs);
        this.fieldWrite(parts, rhs, env);
        return;
      }
      case 'function_call': {
        for (const a of callArgs(left)) this.expr(a, env);
        const callee = childField(left, 'name');
        if (callee?.type !== 'identifier') {
          this.forgetRoot(left, env);
          return;
        }
        const name = getNodeText(callee, source);
        if (this.isUntracked(name)) return;
        // `c{k} = e` / `x(k) = e`.
        const k = literalIndex(left, source);
        const linear = callArgs(left).length === 1;
        const fresh = this.isFresh(env, name);
        const was = env.get(name);
        this.put(env, name, bracesIndex(left) ? withCellElement(was, fresh, k, linear, rhs) : withCellPart(was, fresh, k, linear, rhs));
        return;
      }
      case 'multioutput_variable':
        // `[a, s.f, x(k)] = …`: each output unknown.
        for (const out of namedChildren(left)) {
          if (out.type === 'field_expression' || out.type === 'function_call') {
            for (const p of out.type === 'function_call' ? callArgs(out) : []) this.expr(p, env);
          }
          this.forgetRoot(out, env);
        }
        return;
    }
  }

  /** Whether `name` has never been set on the way here, in a function, and is no parameter: a write makes it anew. */
  private isFresh(env: Env, name: string): boolean {
    return this.options.isFunction && this.codeDepth === 0 && !this.options.inputs.has(name) && !this.isUntracked(name) && env.untouched(name);
  }

  /**
   * `v.f.g = e` (the field set), `v(k).f = e` (element k's field; with an
   * index that is no literal, any element's), `v.f{k} = e` / `v.f(k) = e`
   * (into the field's value). Anything else (`v.(name) = e`, `v.c{k}.f = e`)
   * leaves `v` unknown. A field a property method of the file may set or
   * compute is unknown on a struct the code did not build.
   */
  private fieldWrite(parts: readonly SyntaxNode[], rhs: Val, env: Env): void {
    const source = this.host.source;
    const head = parts[0];
    let root: string | null = null;
    let element: { k: number | null } | null = null;
    if (head?.type === 'identifier') root = getNodeText(head, source);
    else if (head?.type === 'function_call' && childField(head, 'name')?.type === 'identifier' && !bracesIndex(head)) {
      root = getNodeText(childField(head, 'name')!, source);
      for (const a of callArgs(head)) this.expr(a, env);
      element = { k: callArgs(head).length === 1 ? literalIndex(head, source) : null };
    }
    if (root === null) {
      // `c{k}.f = e`: an element of c changed.
      if (head) this.forgetRoot(head, env);
      return;
    }
    if (this.isUntracked(root)) return;
    const path: string[] = [];
    let into: { brace: boolean; k: number | null; linear: boolean } | null = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.type === 'identifier') {
        path.push(getNodeText(p, source));
        continue;
      }
      const name = p.type === 'function_call' ? childField(p, 'name') : null;
      if (name?.type !== 'identifier' || i !== parts.length - 1) {
        // `v.(name) = e`, `v.a(2).b = e`: not followed.
        for (const a of p.type === 'function_call' ? callArgs(p) : []) this.expr(a, env);
        env.delete(root);
        return;
      }
      for (const a of callArgs(p)) this.expr(a, env);
      path.push(getNodeText(name, source));
      into = { brace: bracesIndex(p), k: literalIndex(p, source), linear: callArgs(p).length === 1 };
    }
    if (path.length === 0) return;
    const was = env.get(root);
    const fresh = this.isFresh(env, root);
    const update: FieldUpdate = (old, freshField) => {
      if (!into) return rhs;
      return into.brace ? withCellElement(old, freshField, into.k, into.linear, rhs) : withCellPart(old, freshField, into.k, into.linear, rhs);
    };
    let next = element ? withElementPath(was, fresh, element.k, path, update) : withPath(was, fresh, path, update);
    // A property with a set or get method holds what the method makes of it.
    if (!next.built && accessorsOf(this.host.source).has(path[0]!)) next = OPEN;
    this.put(env, root, next);
  }

  /** `x`, `x(k)`, `s.f…` as an output nothing here knows the value of: x (s) unknown. */
  private forgetRoot(node: SyntaxNode, env: Env): void {
    const head = chainHead(node);
    if (head) env.delete(getNodeText(head, this.host.source));
  }

  /** Sets `name` to `v` (an unknown value: drops it), noting a struct the code did not build. */
  private put(env: Env, name: string, v: Val): void {
    if (isUnknown(v)) env.delete(name);
    else {
      env.set(name, v);
      if (hasForeign(v)) this.foreign.add(name);
    }
  }

  /** `load …` / `clear …` / `run …` / `setup_vars` / `hold on` as a command. */
  private command(s: SyntaxNode, env: Env): void {
    const cmd = namedChildren(s).find((c) => c.type === 'command_name');
    if (!cmd) return;
    const name = getNodeText(cmd, this.host.source);
    if (this.host.isLocal(name)) return;
    this.sideEffects(name, commandItems(s, this.host.source), env);
    if (mayRunCode(name)) this.invalidate(env);
  }

  /** `load(f, 'a')` / `clear('x')` / `run(f)` / `setup_vars()` as a statement. */
  private callStatement(s: SyntaxNode, env: Env): void {
    const callee = childField(s, 'name');
    if (callee?.type !== 'identifier') return;
    const name = getNodeText(callee, this.host.source);
    if (this.host.isLocal(name)) return;
    this.sideEffects(name, callArgs(s).map((a) => stringLiteral(a, this.host.source)), env);
  }

  /** Whether a statement naming `name` alone (`setup_vars`, `setup_vars()`) may run a script: no variable, no MATLAB function, no function of the file's. */
  private mayBeScript(name: string): boolean {
    return !this.host.isLocal(name) && !MATLAB_BUILTINS.has(name) && !this.host.isFileFunction(name);
  }

  /** What `load`, `clear`, `run` or a script (a statement with no arguments) does to the workspace, from its arguments as text. */
  private sideEffects(name: string, items: readonly (string | null)[], env: Env): void {
    if (name === 'load') {
      const names = loadedNames(items);
      if (names.length > 0) for (const n of names) env.delete(n);
      else env.clear();
    } else if (name === 'clear' || name === 'clearvars') {
      if (items.length === 0 || items.some((t) => t === null || t.startsWith('-') || /[*?]/.test(t) || /^(?:all|variables|global|functions|classes)$/i.test(t))) env.clear();
      else for (const t of items) env.delete(t!);
    } else if (name === 'run' || (items.length === 0 && this.mayBeScript(name))) {
      // A script runs in this workspace and may set any variable.
      env.clear();
    }
  }

  /** `if … elseif … else … end`: the conditions in turn, then each branch from a fork; after it, any branch's exit (or the entry, with no `else`). */
  private ifStatement(s: SyntaxNode, env: Env): Env {
    // Conditions run before their branch; what one may change holds for every branch after it (and, conservatively, for the ones before).
    this.expr(childField(s, 'condition'), env);
    env = this.applyEffects(env);
    const clauses = namedChildren(s).filter((c) => c.type === 'elseif_clause' || c.type === 'else_clause');
    for (const c of clauses) {
      if (c.type !== 'elseif_clause') continue;
      this.expr(childField(c, 'condition'), env);
      env = this.applyEffects(env);
    }
    const outs: Env[] = [this.block(firstBlock(s), env.fork())];
    for (const c of clauses) outs.push(this.block(firstBlock(c), env.fork()));
    if (!clauses.some((c) => c.type === 'else_clause')) outs.push(env);
    this.joinInto(env, env, outs);
    return env;
  }

  /** `switch … case … otherwise … end`, as an `if` (see ifStatement). */
  private switchStatement(s: SyntaxNode, env: Env): Env {
    this.expr(childField(s, 'condition'), env);
    env = this.applyEffects(env);
    const clauses = namedChildren(s).filter((c) => c.type === 'case_clause' || c.type === 'otherwise_clause');
    for (const c of clauses) if (c.type === 'case_clause') this.expr(childField(c, 'condition'), env);
    env = this.applyEffects(env);
    const outs = clauses.map((c) => this.block(firstBlock(c), env.fork()));
    if (!clauses.some((c) => c.type === 'otherwise_clause')) outs.push(env);
    this.joinInto(env, env, outs);
    return env;
  }

  /**
   * `for v = range`: `v` is a 1-by-1 cell of the range's elements when the
   * range is a cell row (`for c = {'a', 'b'}` → `c{1}` is `'a'` or `'b'`),
   * else unknown (a column of a matrix of cells, a number, …).
   */
  private forStatement(s: SyntaxNode, env: Env): Env {
    const iter = namedChildren(s).find((c) => c.type === 'iterator');
    const v = iter?.namedChild(0);
    const range = iter?.namedChild(1);
    const r = this.expr(range, env);
    env = this.applyEffects(env);
    let each = OPEN;
    if (r.cell && r.row) each = r.open || r.strs.length > 0 || r.fns.length > 0 || r.fields ? withOpen(oneByOne(r.cell)) : oneByOne(r.cell);
    const name = v?.type === 'identifier' ? getNodeText(v, this.host.source) : null;
    const body = firstBlock(s);
    return this.loop(env, (e) => {
      if (name && !this.isUntracked(name)) this.put(e, name, each);
      return this.block(body, e);
    });
  }

  /**
   * A loop: its body followed from the entry joined with what reaches the
   * loop's head again (the previous round's exit and its `continue`s, then
   * `tail`, a `while`'s condition), until that settles (MAX_ROUNDS at most;
   * then every variable it changed is open). After it: the entry (no round
   * run), the head, or a `break`.
   */
  private loop(entry: Env, body: (env: Env) => Env, tail?: (env: Env) => void): Env {
    let back: Env | null = null;
    let breaks: Env[] = [];
    let settled = false;
    for (let i = 0; i < MAX_ROUNDS && !settled; i++) {
      const start = entry.fork();
      if (back) this.joinInto(start, entry, [entry, back]);
      const exits: LoopExits = { entry, breaks: [], continues: [] };
      this.loops.push(exits);
      let out: Env;
      try {
        out = body(start);
      } finally {
        this.loops.pop();
      }
      const next = this.merged(entry, [out, ...exits.continues]);
      if (next && tail) tail(next);
      settled = !next || (back ? this.sameSince(entry, next, back) : this.sameSince(entry, next, entry));
      back = next;
      breaks = exits.breaks;
    }
    const sides = [entry, ...(back ? [back] : []), ...breaks];
    const after = new Map<string, Val | undefined>();
    for (const k of this.changedKeys(entry, sides)) {
      const was = entry.get(k);
      let j: Val | undefined = was;
      for (let i = 1; i < sides.length; i++) j = either(j, sides[i]!.get(k));
      after.set(k, !settled && j && !sameVal(j, was) ? withOpen(j) : j);
    }
    // What a round cleared is no longer new after the loop.
    if (sides.some((e) => e.changesSince(entry) === null)) entry.clear();
    for (const [k, v] of after) this.put(entry, k, v ?? OPEN);
    return entry;
  }

  /** The join of the workspaces of `sides` (forked from `base`) that go on, as a fork of `base`; null when none does. */
  private merged(base: Env, sides: readonly Env[]): Env | null {
    const live = sides.filter((s) => !s.dead);
    if (live.length === 0) return null;
    const out = base.fork();
    this.joinInto(out, base, live);
    return out;
  }

  /**
   * `try … catch ME … end`: the catch code starts from the entry, the try's
   * exit or an `error` inside it; after it, either exit (with no `catch`,
   * the entry and those too).
   */
  private tryStatement(s: SyntaxNode, env: Env): Env {
    const exits: TryExits = { entry: env, throws: [] };
    this.tries.push(exits);
    let tried: Env;
    try {
      tried = this.block(firstBlock(s), env.fork());
    } finally {
      this.tries.pop();
    }
    const clause = namedChildren(s).find((c) => c.type === 'catch_clause');
    if (!clause) {
      this.joinInto(env, env, [env, tried, ...exits.throws]);
      return env;
    }
    const start = env.fork();
    this.joinInto(start, env, [env, tried, ...exits.throws]);
    const ev = errorVariable(clause);
    if (ev) start.delete(getNodeText(ev, this.host.source));
    const caught = this.block(firstBlock(clause), start);
    this.joinInto(env, env, [tried, caught]);
    return env;
  }

  /** The variables any of `sides` (each `base` or an env forked from it) changed since `base`. */
  private changedKeys(base: Env, sides: readonly Env[]): Set<string> {
    const keys = new Set<string>();
    let all = false;
    for (const side of sides) {
      const changed = side.changesSince(base);
      if (changed) for (const k of changed) keys.add(k);
      else all = true;
    }
    // A side that dropped every variable (a clear) changed all of them.
    if (all) for (const e of [base, ...sides]) for (const k of e.visibleKeys()) keys.add(k);
    this.step(keys.size);
    return keys;
  }

  /**
   * Sets in `target` what the `sides` that go on (forked from `base`) hold
   * together, for every variable one of them changed; with none going on,
   * `target` goes on no more either.
   */
  private joinInto(target: Env, base: Env, sides: readonly Env[]): void {
    const live = sides.filter((s) => !s.dead);
    if (live.length === 0) {
      target.dead = true;
      return;
    }
    const joined = new Map<string, Val | undefined>();
    for (const k of this.changedKeys(base, live)) {
      let v: Val | undefined;
      for (let i = 0; i < live.length; i++) v = i === 0 ? live[0]!.get(k) : either(v, live[i]!.get(k));
      joined.set(k, v);
    }
    // What a branch cleared is no longer new on any path after it.
    if (live.some((s) => s.changesSince(base) === null)) target.clear();
    for (const [k, v] of joined) this.put(target, k, v ?? OPEN);
  }

  /** Whether `a` and `b`, both forked from `base`, hold the same for everything either changed since. */
  private sameSince(base: Env, a: Env, b: Env): boolean {
    for (const k of this.changedKeys(base, [a, b])) if (!sameVal(a.get(k), b.get(k))) return false;
    return true;
  }
}

/** The last file accessorsOf read, and what it found. */
let accessorCache: { source: string; names: ReadonlySet<string> } | null = null;

/** The properties the file has a set or get method for (`set.Mode`, `get.Mode`): what such a property holds is the method's to say. */
function accessorsOf(source: string): ReadonlySet<string> {
  if (accessorCache?.source !== source) {
    const names = new Set<string>();
    if (source.includes('set.') || source.includes('get.')) for (const m of source.matchAll(/\b[sg]et\.([A-Za-z]\w*)/g)) names.add(m[1]!);
    accessorCache = { source, names };
  }
  return accessorCache.names;
}

/** A 1-by-1 cell holding `element` (`for c = {'a', 'b'}` hands out `{'a'}`, then `{'b'}`). */
function oneByOne(element: Val): Val {
  return { ...cellVal(element), cellItems: [element], row: true };
}

/** Whether a call of `name` (no variable) may run the project's code: a function of the project's, or a MATLAB function that runs what it is given. */
function mayRunCode(name: string): boolean {
  return !MATLAB_BUILTINS.has(name) || MATLAB_CODE_RUNNERS.has(name);
}

/** Either value; a variable known on one side only is open, with that side's possibilities. */
function either(a: Val | undefined, b: Val | undefined): Val | undefined {
  if (a && b) return join(a, b);
  const one = a ?? b;
  return one ? withOpen(one) : undefined;
}

/** What a walk of code given as text changed (see Interpreter.codeEffect). */
interface Observer {
  names: Set<string>;
  globals: Set<string>;
  cleared: boolean;
}

/**
 * A workspace: variable → value, a variable not in it unknown. Forked at a
 * branch for O(1) — a fork holds what its branch changes and reads the rest
 * from the env it was forked from, which is not changed while the fork is in
 * use — so that a branch costs what it changes, not the workspace's size.
 */
class Env implements EnvReader {
  /** Variable → value here, or null for one dropped here. */
  private readonly own = new Map<string, Val | null>();
  /** Every variable dropped here: nothing is read from the env forked from. */
  private cleared = false;
  /** The path that reached this workspace left (`return`, `error`, `break`): it joins nothing after it. */
  dead = false;

  constructor(
    private readonly parent: Env | null,
    private readonly observer: Observer | null,
  ) {}

  /** The variable's value, or undefined when it is unknown. */
  get(name: string): Val | undefined {
    for (let e: Env | null = this; e; e = e.parent) {
      const v = e.own.get(name);
      if (v !== undefined) return v ?? undefined;
      if (e.cleared) return undefined;
    }
    return undefined;
  }

  /** Whether nothing has set, dropped or cleared the variable on the way to this workspace. */
  untouched(name: string): boolean {
    for (let e: Env | null = this; e; e = e.parent) {
      if (e.own.has(name) || e.cleared) return false;
    }
    return true;
  }

  /** Sets the variable here. */
  set(name: string, v: Val): void {
    this.own.set(name, v);
    this.observer?.names.add(name);
  }

  /** Makes the variable unknown here. */
  delete(name: string): void {
    this.own.set(name, null);
    this.observer?.names.add(name);
  }

  /** Makes every variable unknown here. */
  clear(): void {
    this.own.clear();
    this.cleared = true;
    if (this.observer) this.observer.cleared = true;
  }

  /** A workspace that starts as this one and changes on its own. */
  fork(): Env {
    return new Env(this, this.observer);
  }

  /** The variables set or dropped since `base` (an env this one was forked from, or itself); null when one dropped them all. */
  changesSince(base: Env): Set<string> | null {
    const keys = new Set<string>();
    for (let e: Env | null = this; e && e !== base; e = e.parent) {
      if (e.cleared) return null;
      for (const k of e.own.keys()) keys.add(k);
    }
    return keys;
  }

  /** Every variable with a value here. */
  visibleKeys(): Set<string> {
    const seen = new Set<string>();
    const keys = new Set<string>();
    for (let e: Env | null = this; e; e = e.parent) {
      for (const [k, v] of e.own) {
        if (seen.has(k)) continue;
        seen.add(k);
        if (v) keys.add(k);
      }
      if (e.cleared) break;
    }
    return keys;
  }
}

/**
 * `env` (forked from `base`, and changing on) as it is now, a fork of `base`
 * no later change of `env` or of the envs between reaches: where a `break`,
 * a `continue` or an `error` leaves to.
 */
function snapshot(env: Env, base: Env): Env {
  const out = base.fork();
  const changed = env.changesSince(base);
  if (changed === null) {
    out.clear();
    for (const k of env.visibleKeys()) out.set(k, env.get(k)!);
  } else {
    for (const k of changed) {
      const v = env.get(k);
      if (v) out.set(k, v);
      else out.delete(k);
    }
  }
  return out;
}

/**
 * What the functions nested in `fn` (at any depth) may change of the
 * variables they share with it — they run whenever they are called, so what
 * such a name holds is never known in `fn` itself: the names they assign, or
 * (`any`) every variable, when one of them may set names its code does not
 * spell (`eval`, `load`, a script, `clear`). Null when `fn` has no nested
 * function.
 */
function nestedFunctionWrites(fn: SyntaxNode, host: InterpHost): { names: Set<string>; any: boolean } | null {
  const source = host.source;
  // Nested functions are statements of the function's body (MATLAB allows them nowhere else).
  const body = firstBlock(fn);
  const nestedFns = body ? namedChildren(body).filter((c) => c.type === 'function_definition') : [];
  if (nestedFns.length === 0) return null;
  const names = new Set<string>();
  let any = false;
  const add = (n: SyntaxNode | null): void => {
    const head = chainHead(n);
    if (head) names.add(getNodeText(head, source));
  };
  const statementName = (c: SyntaxNode): string | null => {
    if (c.type === 'identifier') return getNodeText(c, source);
    if (c.type === 'command') {
      const cmd = namedChildren(c).find((a) => a.type === 'command_name');
      return cmd ? getNodeText(cmd, source) : null;
    }
    if (c.type === 'function_call') {
      const callee = childField(c, 'name');
      return callee?.type === 'identifier' && callArgs(c).length === 0 ? getNodeText(callee, source) : null;
    }
    return null;
  };
  const walk = (n: SyntaxNode): void => {
    for (const c of namedChildren(n)) {
      if (c.type === 'lambda') continue;
      if (c.type === 'assignment') {
        const left = childField(c, 'left');
        if (left?.type === 'multioutput_variable') for (const o of namedChildren(left)) add(o);
        else add(left);
      } else if (c.type === 'iterator') add(c.namedChild(0));
      else if (c.type === 'global_operator') for (const g of namedChildren(c)) add(g);
      else if (c.type === 'function_call' || c.type === 'command') {
        const callee = c.type === 'command' ? namedChildren(c).find((a) => a.type === 'command_name') : childField(c, 'name');
        const name = callee?.type === 'identifier' || callee?.type === 'command_name' ? getNodeText(callee, source) : '';
        if (/^(?:eval|evalc|evalin|assignin|load|run|clear|clearvars)$/.test(name)) any = true;
      }
      // A statement of its own with no arguments may run a script, in the nested function's workspace.
      const stmt = n.type === 'block' ? statementName(c) : null;
      if (stmt && !MATLAB_BUILTINS.has(stmt) && !host.isFileFunction(stmt)) any = true;
      walk(c);
    }
  };
  for (const f of nestedFns) walk(f);
  return { names, any };
}
