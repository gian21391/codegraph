/**
 * How a synthesized hop reads — what bridged the call, and where it was wired.
 *
 * Static parsing cannot see a handler registered in one place and run in
 * another, so the resolver synthesizes the `calls` edge across it
 * (`provenance: 'heuristic'`, `metadata.synthesizedBy`, and usually a
 * `metadata.registeredAt` wiring site). Whatever prints that hop has to say what
 * bridged it, or the hop reads as a direct call — or as the wrong mechanism.
 *
 * Two surfaces print one. `codegraph_explore` (its Flow section and its
 * dynamic-dispatch links) and the `codegraph_node` trail tag the hop
 * `dynamic: callback via \`subscribe\` @src/store.ts:4`; ContextBuilder's
 * "## Call paths" (`buildContext`, `codegraph context`) writes it inside the
 * arrow, `→[callback via \`subscribe\` @src/store.ts:4]`. Each used to keep its
 * own list, and the shorter one called every synthesizer it did not know —
 * interface dispatch, a C++ override, a redux thunk — an "event". So the
 * wording lives here once, and each surface renders it.
 */

import type { Edge } from '../types';

export interface SynthesizedHop {
  /** What bridged the hop: "callback via `subscribe`", "interface → impl", "redux thunk". */
  summary: string;
  /**
   * What the call-paths rendering adds after the summary — the queue a job runs
   * on, a socket message's direction, what an HTTP hop is; '' when nothing.
   */
  detail: string;
  /** Where the hop was wired up (`file:line`), when the synthesizer recorded it. */
  registeredAt?: string;
}

/** `, 1 of N` for a hop that is one of N alternatives (see SynthesizedHopOptions.of), else nothing. */
function oneOf(of: number | undefined): string {
  return of !== undefined && of > 1 ? `, 1 of ${of}` : '';
}

export interface SynthesizedHopOptions {
  /**
   * The hop is one of this many of its kind leaving the same symbol, to a
   * target nobody asked for (see FlowStep.of in ./named-symbol-flow): said
   * in the summary, so one override of hundreds does not read as the one.
   */
  of?: number;
}

/**
 * Whether `edge` is a synthesized one (a synthesizer's, with its wiring
 * site): heuristic and named by a synthesizer. A resolved call its resolver
 * marked a guess (heuristic, no synthesizer) is not.
 */
export function isSynthesizedEdge(edge: Edge): boolean {
  return edge.provenance === 'heuristic' && typeof (edge.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'string';
}

/**
 * Describe a synthesized (dynamic-dispatch) edge; null for an ordinary static
 * one. A synthesizer not named below still reads as dynamic dispatch, by its own
 * name and with its wiring site — never as a bare call or a borrowed label.
 */
export function describeSynthesizedHop(edge: Edge | null | undefined, opts: SynthesizedHopOptions = {}): SynthesizedHop | null {
  const m = edge?.provenance === 'heuristic' ? (edge.metadata as Record<string, unknown> | undefined) : undefined;
  const by = m?.synthesizedBy;
  if (!m) return null;
  if (typeof by !== 'string') {
    // A resolution edge its resolver marked a guess: MATLAB's `Problem.Evaluation(x)`
    // on a parameter `Problem`, taken for the class `PROBLEM`.
    if (m.via === 'receiver-name') return { summary: 'receiver named after its class', detail: '' };
    return null;
  }
  const registeredAt = typeof m.registeredAt === 'string' ? m.registeredAt : undefined;
  const hop = (summary: string, detail = ''): SynthesizedHop => ({ summary, detail, registeredAt });
  const quoted = (value: unknown, otherwise: string): string => (value ? `\`${String(value)}\`` : otherwise);
  switch (by) {
    case 'callback':
      return hop(`callback via ${quoted(m.via, 'a registrar')}`);
    case 'http-client': {
      const request = `${String(m.method ?? 'GET')} ${String(m.href ?? '')}`.trim();
      return hop(`HTTP ${request}`, " — the client's call onto its own route");
    }
    case 'queue-job':
      return hop(`queue job ${quoted(m.event, 'a job')}`, m.queue ? ` on \`${String(m.queue)}\`` : '');
    case 'event-bus': {
      const what = m.channel === 'socket' ? 'socket message' : 'bus event';
      const direction = m.tier === 'client→server' ? ' → server' : m.tier === 'server→client' ? ' → client' : '';
      return hop(`${what} ${quoted(m.event, 'an event')}`, direction);
    }
    case 'event-emitter':
      return hop(`event ${quoted(m.event, 'an event')}`);
    case 'tauri-command':
      return hop(`Tauri command ${quoted(m.command, 'a command')}`, " — the frontend's invoke onto its Rust handler");
    case 'tauri-event': {
      const direction = m.tier === 'server→client' ? ' → frontend' : m.tier === 'client→server' ? ' → Rust' : '';
      return hop(`Tauri event ${quoted(m.event, 'an event')}`, direction);
    }
    case 'react-render':
      return hop('React re-render via setState');
    case 'jsx-render':
      return hop(`renders ${m.via ? `<${String(m.via)}>` : 'a child component'}`);
    case 'vue-handler':
      return hop(`Vue ${m.event ? `@${String(m.event)}` : 'a template event'} handler`);
    case 'interface-impl':
      // Go: the implementing struct gets the method from a type it embeds.
      if (typeof m.promotedInto === 'string') return hop(`interface → method promoted into ${m.promotedInto}`);
      return hop('interface → impl');
    case 'matlab-override':
      // MATLAB: a base class's method → a subclass's override of it — one of
      // `of` when the hop goes to an override the reader did not pick.
      return hop(`base → override${oneOf(opts.of)}`);
    case 'matlab-subclass-method':
      // MATLAB: a call on the own object of a method only its subclasses
      // define — one of `of` likewise.
      return hop(`self call → subclass method${oneOf(opts.of)}`);
    case 'closure-collection':
      return hop(`runs ${quoted(m.field, 'a collection')} handlers`);
    case 'fn-pointer-dispatch':
      return hop(`fn-pointer ${m.via ? String(m.via) : ''}`);
    case 'goframe-route':
      return hop(`GoFrame route ${m.route ? String(m.route) : ''}`);
    case 'next-proxy':
      return hop(m.matcher ? `Next proxy, matcher ${quoted(m.matcher, '')}` : 'Next proxy, on every request');
    case 'const-alias':
      return hop(`const alias of ${quoted(m.via, 'a function')}`);
    case 'go-func-field':
      // Go: a call through a struct field holding a function, `d.refreshf(ctx)`;
      // `via` is the field it was copied from, which the wiring site writes.
      return hop(`func field ${quoted(m.field, 'a func field')}${m.via ? ` (set from \`${String(m.via)}\`)` : ''}`);
    case 'matlab-argument': {
      // MATLAB: a call of what the caller passes, `feval(regr, S)` given `'regpoly0'`
      // (`value`) at the caller's call (`registeredAt`); a call of the parameter
      // itself (`fh(x)`) names it alone, and `str2func(varargin{1})` refers to the
      // function rather than calling it (a `references` edge).
      const sink = String(m.sink ?? 'feval');
      const param = m.param ? String(m.param) : '…';
      const site = sink === param ? `\`${param}\`` : `through \`${sink}(${param})\``;
      const given = m.value ? ` given \`${String(m.value)}\`` : '';
      return hop(`${edge!.kind === 'references' ? 'references' : 'calls'} ${site}${given}`);
    }
    default:
      // redux-thunk, cpp-override, gin-middleware-chain, flutter-build, …
      return hop(by.replace(/-/g, ' '));
  }
}
