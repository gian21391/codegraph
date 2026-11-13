import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';

/**
 * What a MATLAB expression can hold, as far as the names a program spells out
 * at runtime go: `feval(m, …)` after `m = 'DriftPass'` or `m = 'QuadPass'`,
 * `eval([mfilename '(''sel'')'])`, `fh(x)` after `fh = @solve`. A value is a
 * bounded set of possibilities plus whether anything else is possible too:
 *
 *   - a string, which may hold HOLEs — parts nothing here knows
 *     (`['load ', fn]` is `load ␀`);
 *   - a function handle to a named function (`@solve`, `str2func('pkg.f')`);
 *   - a cell array: a value standing for any of its elements, and, for a
 *     row built where it is read (`{'a', 'b'}`), each element in its place;
 *   - a struct: a value per field any element has, and, for one built where
 *     it is read (`s = struct(…)`, `s(2).f = …`), each element's;
 *   - `open`: other values are possible (a parameter, what a call returns).
 *
 * Every possibility kept is a value the expression can have along some path
 * of the code (which branch is taken aside), so that each reference made of
 * one names something the code can really call. Past the bounds the first
 * possibilities are kept and the value is open; a text past MAX_TEXT keeps
 * its start and ends in a HOLE.
 */

/** A part of a string nothing here knows: any text, the empty one included. */
export const HOLE = '\u0000';

/** Possibilities (strings and handles together) one value keeps. */
const MAX_POSSIBILITIES = 16;
/** Elements a cell row or struct array is followed by, each in its place. */
const MAX_ITEMS = 16;
/** Cells and structs nested deeper than this are open. */
const MAX_DEPTH = 4;
/** Known text a string keeps: past it, a HOLE. Longer code given as text is not read either. */
export const MAX_TEXT = 20_000;
/** Expression nesting followed: deeper (a generated thousand-term sum) is unknown, never a stack overflow. */
const MAX_EVAL_DEPTH = 200;

/** A handle to a named function: the reference its `@name` makes (see handleRef), `variable` as there. */
export interface FnVal {
  readonly name: string;
  readonly variable?: string;
}

/** A struct element's fields: field → value. */
export type Fields = ReadonlyMap<string, Val>;

export interface Val {
  readonly strs: readonly string[];
  readonly fns: readonly FnVal[];
  /** A cell array: the value of any of its elements. */
  readonly cell: Val | null;
  /** A cell row's elements in order, when each is known (`{'a', 'b'}`). */
  readonly cellItems: readonly Val[] | null;
  /** A struct (or an object): the fields any of its elements has, each a value; one not listed is open. */
  readonly fields: Fields | null;
  /** A struct array's elements in order, when each is known (`struct('f', {'a', 'b'})`, `s(2).f = …`). */
  readonly records: readonly Fields[] | null;
  /** The array (cell or struct) is a row, 1-by-N, or empty: `for v = c` hands out one element at a time. */
  readonly row: boolean;
  /**
   * The struct is one the code built itself (`struct(…)`, `s.f = …` on a new
   * name): a plain value, which nothing but its own code changes — no handle
   * object that a call may change through another variable, no property's
   * set or get method. A field it does not list does not exist.
   */
  readonly built: boolean;
  /** A string possibility may be a string object (`"name"`), not a char vector. */
  readonly stringObject: boolean;
  readonly open: boolean;
  /** How deep cells and structs nest in it (0 for none). */
  readonly depth: number;
}

interface Parts {
  strs?: readonly string[];
  fns?: readonly FnVal[];
  cell?: Val | null;
  cellItems?: readonly Val[] | null;
  fields?: Fields | null;
  records?: readonly Fields[] | null;
  row?: boolean;
  built?: boolean;
  stringObject?: boolean;
  open?: boolean;
}

/** A value from its parts, within the bounds. */
function make(p: Parts): Val {
  let strs = p.strs ?? [];
  let fns = p.fns ?? [];
  let open = p.open ?? false;
  if (strs.length + fns.length > MAX_POSSIBILITIES) {
    strs = strs.slice(0, Math.max(0, MAX_POSSIBILITIES - fns.length));
    fns = fns.slice(0, MAX_POSSIBILITIES - strs.length);
    open = true;
  }
  const cell = p.cell ?? null;
  const fields = p.fields ?? null;
  // Items in place only for a value that is one kind of array.
  let cellItems = cell && !fields ? (p.cellItems ?? null) : null;
  let records = fields && !cell ? (p.records ?? null) : null;
  if (cellItems && cellItems.length > MAX_ITEMS) cellItems = null;
  if (records && records.length > MAX_ITEMS) records = null;
  // A cell's union and a struct's fields hold what its items and records do: their depth is theirs.
  let depth = 0;
  if (cell) depth = 1 + cell.depth;
  if (fields) for (const f of fields.values()) depth = Math.max(depth, 1 + f.depth);
  if (depth > MAX_DEPTH) return { strs, fns, cell: null, cellItems: null, fields: null, records: null, row: false, built: false, stringObject: strs.length > 0 && (p.stringObject ?? false), open: true, depth: 0 };
  return {
    strs,
    fns,
    cell,
    cellItems,
    fields,
    records,
    row: (cell !== null || fields !== null) && (p.row ?? false),
    built: fields !== null && (p.built ?? false),
    stringObject: strs.length > 0 && (p.stringObject ?? false),
    open,
    depth,
  };
}

/** Anything at all: nothing known. */
export const OPEN: Val = make({ open: true });
/** Nothing at all (the elements of `{}`). */
export const NONE: Val = make({});

/** `s` as text, its HOLEs merged and cut at MAX_TEXT; a string object when `object`. */
export function strVal(s: string, object = false): Val {
  return make({ strs: [normalText(s)], stringObject: object });
}

/** A text's HOLE runs as one, and past MAX_TEXT a HOLE. */
function normalText(s: string): string {
  let t = s.includes(HOLE + HOLE) ? s.replace(/\u0000+/g, HOLE) : s;
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT).replace(/\u0000$/, '') + HOLE;
  return t;
}

/** A handle to the function `f`. */
export function fnVal(f: FnVal): Val {
  return make({ fns: [f] });
}

/** A cell array any element of which is `element`, of a shape nothing here knows. */
export function cellVal(element: Val): Val {
  return make({ cell: element });
}

/** A cell row of these elements, in order. */
export function cellOfItems(items: readonly Val[]): Val {
  return make({ cell: items.reduce(join, NONE), cellItems: items, row: true });
}

/** A struct array of these elements (each one's fields), in order. */
export function structOfRecords(records: readonly Fields[], built: boolean): Val {
  return make({ fields: unionOfRecords(records), records, row: true, built });
}

/** The fields any of `records` has: every element of a struct array has every field (MATLAB fills a new one's with `[]`). */
function unionOfRecords(records: readonly Fields[]): Fields {
  if (records.length === 1) return records[0]!;
  const out = new Map<string, Val>();
  for (const r of records) for (const k of r.keys()) out.set(k, out.has(k) ? out.get(k)! : NONE);
  for (const k of out.keys()) out.set(k, records.map((r) => r.get(k) ?? OPEN).reduce(join, NONE));
  return out;
}

/** `v` with `open` set. */
export function withOpen(v: Val): Val {
  return v.open ? v : { ...v, open: true };
}

/** Whether `v` knows nothing: open, and no possibility. */
export function isUnknown(v: Val): boolean {
  return v.open && v.strs.length === 0 && v.fns.length === 0 && !v.cell && !v.fields;
}

/** Whether `v` may be something besides a cell. */
function besidesCell(v: Val): boolean {
  return v.open || v.strs.length > 0 || v.fns.length > 0 || v.fields !== null;
}

/** Whether `v` may be something besides a struct. */
function besidesStruct(v: Val): boolean {
  return v.open || v.strs.length > 0 || v.fns.length > 0 || v.cell !== null;
}

/** Whether `v` may be something besides text. */
export function besidesText(v: Val): boolean {
  return v.open || v.fns.length > 0 || v.cell !== null || v.fields !== null;
}

/**
 * Whether `v` holds a struct the code did not build itself (see `built`): an
 * object, maybe a handle one, whose fields a call may change through another
 * variable, and a property method may compute.
 */
export function hasForeign(v: Val): boolean {
  if (!v.cell && !v.fields) return false;
  if (v.fields && !v.built) return true;
  if (v.cell && hasForeign(v.cell)) return true;
  if (v.fields) for (const f of v.fields.values()) if (hasForeign(f)) return true;
  return false;
}

/** A handle's identity in a set: its name and its variable. */
const fnKey = (f: FnVal): string => `${f.name}\u0001${f.variable ?? ''}`;

/** Either value: every possibility of both. */
export function join(a: Val, b: Val): Val {
  if (a === b) return a;
  const strs = a.strs.length === 0 ? b.strs : b.strs.length === 0 ? a.strs : [...new Set([...a.strs, ...b.strs])];
  let fns = a.fns;
  if (b.fns.length > 0) {
    const seen = new Set(a.fns.map(fnKey));
    fns = [...a.fns, ...b.fns.filter((f) => !seen.has(fnKey(f)))];
  }
  const cell = a.cell && b.cell ? join(a.cell, b.cell) : (a.cell ?? b.cell);
  const cellItems = !a.cell ? b.cellItems : !b.cell ? a.cellItems : pairwise(a.cellItems, b.cellItems, join);
  let fields = a.fields ?? b.fields;
  let records = a.fields ? a.records : b.records;
  if (a.fields && b.fields) {
    // The fields of either element are the fields of the elements joined in place.
    records = pairwise(a.records, b.records, joinFields);
    fields = records ? unionOfRecords(records) : joinFields(a.fields, b.fields);
  }
  const arrays = (v: Val): boolean => v.cell !== null || v.fields !== null;
  return make({
    strs,
    fns,
    cell,
    cellItems,
    fields,
    records,
    row: (!arrays(a) || a.row) && (!arrays(b) || b.row),
    built: (!a.fields || a.built) && (!b.fields || b.built),
    stringObject: a.stringObject || b.stringObject,
    open: a.open || b.open,
  });
}

/** Two lists of the same length joined element by element; null when either is not known or the lengths differ. */
function pairwise<T>(a: readonly T[] | null, b: readonly T[] | null, f: (x: T, y: T) => T): T[] | null {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((x, i) => f(x, b[i]!));
}

/** Either element's fields: a field only one has is open on the other side. */
function joinFields(a: Fields, b: Fields): Fields {
  if (a === b) return a;
  const both = new Map<string, Val>();
  for (const k of new Set([...a.keys(), ...b.keys()])) both.set(k, join(a.get(k) ?? OPEN, b.get(k) ?? OPEN));
  return both;
}

/** Whether two values hold the same possibilities, whatever order they came in. */
export function sameVal(a: Val | undefined, b: Val | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.open !== b.open || a.row !== b.row || a.built !== b.built || a.stringObject !== b.stringObject) return false;
  if (a.strs.length !== b.strs.length || a.fns.length !== b.fns.length) return false;
  if (a.strs.length > 0) {
    const strs = new Set(b.strs);
    if (a.strs.some((x) => !strs.has(x))) return false;
  }
  if (a.fns.length > 0) {
    const fns = new Set(b.fns.map(fnKey));
    if (a.fns.some((f) => !fns.has(fnKey(f)))) return false;
  }
  // A cell's union and a struct's fields follow from its items and records, when both sides know them.
  if (!a.cell !== !b.cell || !sameList(a.cellItems, b.cellItems, sameVal)) return false;
  if (a.cell && !a.cellItems && !sameVal(a.cell, b.cell!)) return false;
  if (!a.fields !== !b.fields || !sameList(a.records, b.records, sameFields)) return false;
  return !a.fields || !!a.records || sameFields(a.fields, b.fields!);
}

/** Whether two lists (or their absence) are the same, element by element. */
function sameList<T>(a: readonly T[] | null, b: readonly T[] | null, same: (x: T, y: T) => boolean): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((x, i) => same(x, b[i]!));
}

/** Whether two elements' fields are the same. */
function sameFields(a: Fields, b: Fields): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!sameVal(v, b.get(k))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reading arrays and fields
// ---------------------------------------------------------------------------

/** What `v{k}` reads: element k when `k` (a positive integer literal) is given and known, any element when no `k` is given. */
export function elementOf(v: Val | undefined, k: number | null): Val {
  if (!v?.cell) return OPEN;
  const got = k === null ? v.cell : (v.cellItems?.[k - 1] ?? OPEN);
  return besidesCell(v) ? withOpen(got) : got;
}

/**
 * What `v(k)` reads: for a cell, a part of it (element k alone, when `k` is
 * given and known); for a struct array, an element (any, with no `k`); else
 * unknown.
 */
export function partOf(v: Val | undefined, k: number | null): Val {
  if (!v || (v.cell && v.fields)) return OPEN;
  let got: Val;
  if (v.cell) {
    if (k === null) got = cellVal(v.cell);
    else {
      const item = v.cellItems?.[k - 1];
      got = item ? cellOfItems([item]) : OPEN;
    }
    return besidesCell(v) ? withOpen(got) : got;
  }
  if (v.fields) {
    if (k === null) got = make({ fields: v.fields, built: v.built });
    else {
      const r = v.records?.[k - 1];
      got = r ? structOfRecords([r], v.built) : OPEN;
    }
    return besidesStruct(v) ? withOpen(got) : got;
  }
  return OPEN;
}

/** What `v.f` reads: of a struct array, its first element's (where one value is read). */
export function fieldOf(v: Val | undefined, f: string): Val {
  if (!v?.fields) return OPEN;
  const from = v.records ? v.records[0] : v.fields;
  const got = from?.get(f) ?? OPEN;
  return besidesStruct(v) ? withOpen(got) : got;
}

/** Whether `v` is a struct with a field `f` written for it. */
export function hasField(v: Val | undefined, f: string): boolean {
  return v?.fields?.has(f) ?? false;
}

// ---------------------------------------------------------------------------
// Writing arrays and fields
// ---------------------------------------------------------------------------

/** Whether `v` is nothing yet a field or element write would keep: `[]`, `''`, `{}`. */
function isEmptyValue(v: Val): boolean {
  if (v.open || v.fns.length > 0 || v.fields) return false;
  if (v.cell) return v.cellItems?.length === 0 && v.strs.length === 0;
  return v.strs.length > 0 && v.strs.every((s) => s === '');
}

/** Whether a field write on `v` makes (or keeps) a struct the code built: `v` is new (`fresh`), empty, or such a struct already. */
function plainBase(v: Val | undefined, fresh: boolean): boolean {
  if (v === undefined) return fresh;
  return isEmptyValue(v) || (v.fields !== null && v.built && !besidesStruct(v));
}

/** How a field write sets the field's value, from what it held (undefined when it has none) and whether the field is new on a built struct. */
export type FieldUpdate = (old: Val | undefined, fresh: boolean) => Val;

/**
 * `v.f.g = …` (path [f, g]): `v` a scalar struct (MATLAB errors on any other),
 * with the last field's value from `update`. `fresh` says `v` is a new name;
 * then (or when `v` is empty or a built struct) it is a built struct.
 */
export function withPath(v: Val | undefined, fresh: boolean, path: readonly string[], update: FieldUpdate): Val {
  const built = plainBase(v, fresh);
  const base: Fields = v?.fields && !isEmptyValue(v) ? (v.records?.length === 1 ? v.records[0]! : v.fields) : new Map();
  return structOfRecords([setIn(base, built, path, update)], built);
}

/** `record` with `path` set (see withPath); fields absent from a built record are new. */
function setIn(record: Fields, built: boolean, path: readonly string[], update: FieldUpdate): Fields {
  const [f, ...rest] = path;
  const old = record.get(f!);
  const childFresh = built && !record.has(f!);
  const value = rest.length > 0 ? withPath(old, childFresh, rest, update) : update(old, childFresh);
  return new Map(record).set(f!, value);
}

/**
 * `v(k).f.g = …`: element k's field set (`k` a positive integer literal), or,
 * with no `k`, any element's — after which a field read gives either what it
 * held or the new value. Elements a write past the end adds have every field
 * empty.
 */
export function withElementPath(v: Val | undefined, fresh: boolean, k: number | null, path: readonly string[], update: FieldUpdate): Val {
  const built = plainBase(v, fresh);
  const f = path[0]!;
  let records: Fields[] | null = null;
  if (v?.records && !besidesStruct(v)) records = [...v.records];
  else if (built) records = [];
  if (k !== null && records && k <= MAX_ITEMS) {
    const keys = new Set([...records.flatMap((r) => [...r.keys()]), f]);
    const empty = (): Fields => new Map([...keys].map((key) => [key, OPEN]));
    while (records.length < k) records.push(new Map([...keys].filter((key) => key !== f).map((key) => [key, OPEN])));
    records[k - 1] = setIn(records[k - 1]!, built, path, update);
    // Every element has every field.
    records = records.map((r) => (r.has(f) ? r : new Map([...empty(), ...r])));
    return structOfRecords(records, built);
  }
  const union = v?.fields ?? new Map<string, Val>();
  const old = union.get(f);
  const one = setIn(old === undefined ? new Map() : new Map([[f, old]]), built && old === undefined, path, update).get(f)!;
  const fields = new Map(union).set(f, join(old ?? OPEN, one));
  return make({ fields, built, open: v === undefined ? !fresh : besidesStruct(v) });
}

/**
 * `c{k} = to`: element k is now `to` (`k` a positive integer literal, the
 * index `linear`: one argument), or, with no `k`, any element may be. `fresh`
 * says `c` is a new name.
 */
export function withCellElement(v: Val | undefined, fresh: boolean, k: number | null, linear: boolean, to: Val): Val {
  const plain = v === undefined ? fresh : isEmptyValue(v);
  const cell = v?.cell && !besidesCell(v) ? v : null;
  const items = cell ? cell.cellItems : plain ? [] : null;
  // A linear index grows a row (or an empty array) as a row.
  const row = linear && (cell ? cell.row : plain);
  if (k !== null && items && k <= MAX_ITEMS) {
    const next = [...items];
    while (next.length < k) next.push(OPEN);
    next[k - 1] = to;
    return row ? cellOfItems(next) : make({ cell: next.reduce(join, NONE) });
  }
  const was = v?.cell ?? (plain ? NONE : OPEN);
  return make({ cell: join(was, to), row });
}

/** `x(k) = to` where `to` is a cell: x's element k (or, with no `k`, any element) may now be to's; any other indexed write leaves x unknown. */
export function withCellPart(v: Val | undefined, fresh: boolean, k: number | null, linear: boolean, to: Val): Val {
  if (!to.cell || besidesCell(to)) return OPEN;
  const plain = v === undefined ? fresh : isEmptyValue(v);
  if (!plain && (!v?.cell || besidesCell(v))) return OPEN;
  const only = to.cellItems?.length === 1 ? to.cellItems[0]! : null;
  if (only && k !== null) return withCellElement(v, fresh, k, linear, only);
  return make({ cell: join(v?.cell ?? NONE, to.cell), row: linear && (v?.cell ? v.row : plain) });
}

// ---------------------------------------------------------------------------
// Syntax helpers shared with the interpreter and the extractor
// ---------------------------------------------------------------------------

/**
 * Named children by node id, while an interpretation walks one tree (see
 * withChildrenMemo): its loops walk a body again each round, and each read
 * of a child list costs a copy out of the parser's memory.
 */
let childrenMemo: Map<number, SyntaxNode[]> | null = null;

/** A node's named children, none null. */
export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  if (!childrenMemo) return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
  let kids = childrenMemo.get(node.id);
  if (!kids) childrenMemo.set(node.id, (kids = node.namedChildren.filter((c): c is SyntaxNode => c !== null)));
  return kids;
}

/** A node's child by field name, by node id and field, beside childrenMemo. */
let fieldMemo: Map<number, Map<string, SyntaxNode | null>> | null = null;

/** A node's child in field `name` (`left`, `condition`, …), or null. */
export function childField(node: SyntaxNode, name: string): SyntaxNode | null {
  if (!fieldMemo) return getChildByField(node, name);
  let fields = fieldMemo.get(node.id);
  if (!fields) fieldMemo.set(node.id, (fields = new Map()));
  let child = fields.get(name);
  if (child === undefined) fields.set(name, (child = getChildByField(node, name)));
  return child;
}

/** `walk()` with named children and field children remembered, for nodes of one tree only: node ids are per tree. */
export function withChildrenMemo<T>(walk: () => T): T {
  const was = [childrenMemo, fieldMemo] as const;
  childrenMemo = new Map();
  fieldMemo = new Map();
  try {
    return walk();
  } finally {
    [childrenMemo, fieldMemo] = was;
  }
}

/** Whether a node is no part of an expression list: a comment, a `...` line continuation. */
function isNoise(node: SyntaxNode): boolean {
  return node.type === 'comment' || node.type === 'line_continuation';
}

/** A call's (or an index's) arguments, comments and line continuations aside. */
export function callArgs(call: SyntaxNode): SyntaxNode[] {
  const args = namedChildren(call).find((c) => c.type === 'arguments');
  return args ? namedChildren(args).filter((c) => !isNoise(c)) : [];
}

/** Whether `f{…}` (a cell's contents), not `f(…)`. */
export function bracesIndex(call: SyntaxNode): boolean {
  for (let i = 0; i < call.childCount; i++) if (call.child(i)?.type === '{') return true;
  return false;
}

/** The index `x(3)` / `c{2}` gives as a positive integer literal, or null for any other index. */
export function literalIndex(call: SyntaxNode, source: string): number | null {
  const args = callArgs(call);
  if (args.length !== 1 || args[0]!.type !== 'number') return null;
  const text = getNodeText(args[0]!, source);
  return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : null;
}

/** The first block under a statement or clause (its body). */
export function firstBlock(node: SyntaxNode): SyntaxNode | undefined {
  return namedChildren(node).find((c) => c.type === 'block');
}

/** A `catch_clause`'s error variable: its identifier on the `catch` keyword's own row. */
export function errorVariable(clause: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < clause.namedChildCount; i++) {
    const c = clause.namedChild(i);
    if (!c || c.type === 'comment') continue;
    return c.type === 'identifier' && c.startPosition.row === clause.startPosition.row ? c : null;
  }
  return null;
}

/** The variable at the root of `x`, `x(k)`, `s.f…` (its leftmost identifier through calls and field chains), or null. */
export function chainHead(node: SyntaxNode | null | undefined): SyntaxNode | null {
  let n: SyntaxNode | null | undefined = node;
  while (n && n.type !== 'identifier') {
    n = n.type === 'field_expression' ? childField(n, 'object') : n.type === 'function_call' ? childField(n, 'name') : null;
  }
  return n ?? null;
}

/** A command's arguments as text (`load data.mat a 'b'` → data.mat, a, b): trimmed, a quoted one unquoted, empty ones dropped. */
export function commandItems(command: SyntaxNode, source: string): string[] {
  return namedChildren(command)
    .filter((c) => c.type === 'command_argument')
    .map((c) => getNodeText(c, source).trim().replace(/^'(.*)'$/, '$1'))
    .filter((t) => t !== '');
}

/**
 * The text a string literal holds: what is between its delimiters, a doubled
 * delimiter read as one (`'it''s'`, `"q""r"`). MATLAB char and string
 * literals have no backslash escapes. Null when `node` is no string literal.
 */
export function stringLiteral(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'string') return null;
  const raw = getNodeText(node, source);
  const q = raw[0];
  if ((q !== "'" && q !== '"') || raw.length < 2 || raw[raw.length - 1] !== q) return null;
  return raw.slice(1, -1).split(q + q).join(q);
}

/** Whether a string literal is a string object (`"…"`), not a char vector. */
function isStringObjectLiteral(node: SyntaxNode, source: string): boolean {
  return node.type === 'string' && source[node.startIndex] === '"';
}

/** A name MATLAB can call a function by: `f`, `pkg.f`. */
export const NAME_SHAPED = /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)*$/;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What evaluation asks of the code around the expression. */
export interface ValueHost {
  readonly source: string;
  /** The file's name, as `mfilename` returns it where it is no variable; null when unknown. */
  mfilename(): string | null;
  /** Whether a name is a variable where the expression is. */
  isLocal(name: string): boolean;
  /** The function a handle (`@f`, `@pkg.f`, `@obj.m`) names, or null. */
  handle(node: SyntaxNode): FnVal | null;
  /** The function a dotted name given as text names (`str2func('pkg.f')`), or null. */
  named(path: readonly string[]): FnVal | null;
}

/** Variable → its value. A variable it has no value for is unknown. */
export interface EnvReader {
  get(name: string): Val | undefined;
}

/** What the interpreter hears of an evaluation (see matlab-interp.ts). */
export interface Recorder {
  /** Whether a name's value is never known (a global, what a nested function assigns). */
  isUntracked(name: string): boolean;
  /** Counts work, and stops a walk that has done too much. */
  step(): void;
  /** Every `name(args)` with an identifier callee, its arguments' values evaluated. */
  call(callee: SyntaxNode, name: string, args: readonly SyntaxNode[], vals: readonly Val[], env: EnvReader): void;
  /**
   * Code may have run that changes an object some variable holds (a method
   * call, a property read through a get method), or such an object was
   * handed on: what the fields of an object hold is no longer known.
   */
  invalidate(env: EnvReader): void;
}

/** How deep evaluate is in an expression now (see MAX_EVAL_DEPTH). */
let evalDepth = 0;

/**
 * The value of `node` in `env` — or, with no env, of the expression as
 * written (its literals, `mfilename`, `@f`: what holds whatever the code did
 * before). Sub-expressions are evaluated too, so that a recorder hears every
 * call in them (not inside a lambda: its parameters hide the names around it,
 * and its body runs later). An object's value read whole (`t = obj`, `f(obj)`)
 * hands it on: then it is unknown, and so is every object's field (see
 * Recorder.invalidate).
 */
export function evaluate(node: SyntaxNode, env: EnvReader | null, host: ValueHost, rec: Recorder | null = null): Val {
  if (evalDepth >= MAX_EVAL_DEPTH) return OPEN;
  evalDepth++;
  try {
    rec?.step();
    const v = evaluateNode(node, env, host, rec);
    if (rec && env && hasForeign(v)) {
      rec.invalidate(env);
      return OPEN;
    }
    return v;
  } finally {
    evalDepth--;
  }
}

/** One node's value (see evaluate). */
function evaluateNode(node: SyntaxNode, env: EnvReader | null, host: ValueHost, rec: Recorder | null): Val {
  const source = host.source;
  switch (node.type) {
    case 'string': {
      const text = stringLiteral(node, source);
      return text === null ? OPEN : strVal(text, isStringObjectLiteral(node, source));
    }
    case 'identifier': {
      const name = getNodeText(node, source);
      const own = env && !rec?.isUntracked(name) ? env.get(name) : undefined;
      if (own) return own;
      if (name === 'mfilename' && !host.isLocal(name)) {
        const stem = host.mfilename();
        if (stem) return strVal(stem);
      }
      return OPEN;
    }
    case 'parenthesis': {
      const inner = namedChildren(node).filter((c) => !isNoise(c));
      return inner.length === 1 ? evaluate(inner[0]!, env, host, rec) : evaluateParts(inner, env, host, rec);
    }
    case 'matrix': {
      const rows = namedChildren(node).filter((c) => c.type === 'row');
      if (rows.length === 0) return strVal('');
      if (rows.length > 1) {
        for (const r of rows) evaluateParts(namedChildren(r).filter((c) => !isNoise(c)), env, host, rec);
        return OPEN;
      }
      const parts = namedChildren(rows[0]!).filter((c) => !isNoise(c));
      const vals = parts.map((c) => evaluate(c, env, host, rec));
      // `["a" "b"]` (or a string object among the parts) is a string array, not one text.
      if (vals.some((v) => v.stringObject)) return OPEN;
      return concat(vals);
    }
    case 'cell': {
      const rows = namedChildren(node).filter((c) => c.type === 'row');
      const items: Val[] = [];
      let element = NONE;
      for (const r of rows) {
        for (const c of namedChildren(r)) {
          if (isNoise(c)) continue;
          const v = evaluate(c, env, host, rec);
          items.push(v);
          element = join(element, v);
        }
      }
      // A row's elements are known in place; a column's or a matrix's only as any element.
      return rows.length <= 1 ? cellOfItems(items) : cellVal(element);
    }
    case 'handle_operator': {
      const f = host.handle(node);
      return f ? fnVal(f) : OPEN;
    }
    case 'lambda':
      return OPEN;
    case 'function_call':
      return evaluateCall(node, env, host, rec);
    case 'field_expression':
      return evaluateField(node, env, host, rec);
    default:
      return evaluateParts(namedChildren(node), env, host, rec);
  }
}

/** Evaluates each node for what it calls; the value is unknown. */
function evaluateParts(nodes: readonly SyntaxNode[], env: EnvReader | null, host: ValueHost, rec: Recorder | null): Val {
  if (rec) for (const n of nodes) evaluate(n, env, host, rec);
  return OPEN;
}

/**
 * `v.f.g`, `v(k).f`, `s.c{2}`: the field's value, when the chain is plain
 * names; else unknown. A name in the chain that is no field written for a
 * built struct may be a method of an object, or a property's get method,
 * which may run any code (see Recorder.invalidate).
 */
function evaluateField(node: SyntaxNode, env: EnvReader | null, host: ValueHost, rec: Recorder | null): Val {
  const parts = namedChildren(node);
  const head = parts[0];
  if (!head) return OPEN;
  const source = host.source;
  const read = (name: string): Val | undefined => (env && !rec?.isUntracked(name) ? env.get(name) : undefined);
  let v: Val | undefined;
  if (head.type === 'identifier') {
    rec?.step();
    v = read(getNodeText(head, source));
  } else if (head.type === 'function_call' && childField(head, 'name')?.type === 'identifier' && !bracesIndex(head) && (env?.get(getNodeText(childField(head, 'name')!, source)) || host.isLocal(getNodeText(childField(head, 'name')!, source)))) {
    // `s(k).f`: the struct array's element k (any, when k is no literal).
    for (const a of callArgs(head)) evaluate(a, env, host, rec);
    v = partOf(read(getNodeText(childField(head, 'name')!, source)), literalIndex(head, source));
  } else {
    evaluate(head, env, host, rec);
    v = undefined;
  }
  const mayRunCode = (name: string): void => {
    if (rec && env && !(v?.built && !v.open) && !hasField(v, name)) rec.invalidate(env);
  };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.type === 'identifier') {
      const name = getNodeText(p, source);
      mayRunCode(name);
      v = fieldOf(v, name);
      continue;
    }
    const name = p.type === 'function_call' ? childField(p, 'name') : null;
    if (name?.type !== 'identifier') {
      if (rec && env && !(v?.built && !v.open)) rec.invalidate(env);
      for (let j = i; j < parts.length; j++) evaluate(parts[j]!, env, host, rec);
      return OPEN;
    }
    for (const a of callArgs(p)) evaluate(a, env, host, rec);
    const field = getNodeText(name, source);
    mayRunCode(field);
    const k = literalIndex(p, source);
    v = bracesIndex(p) ? elementOf(fieldOf(v, field), k) : partOf(fieldOf(v, field), k);
  }
  return v ?? OPEN;
}

/** `name(args)`: an index into a variable, a function that computes text (`strcat`, `sprintf`, …) or `struct(…)`; else unknown. */
function evaluateCall(node: SyntaxNode, env: EnvReader | null, host: ValueHost, rec: Recorder | null): Val {
  const callee = childField(node, 'name');
  const args = callArgs(node);
  const vals = args.map((a) => evaluate(a, env, host, rec));
  if (callee?.type !== 'identifier') {
    if (callee) evaluate(callee, env, host, rec);
    return OPEN;
  }
  const source = host.source;
  const name = getNodeText(callee, source);
  if (rec && env) rec.call(callee, name, args, vals, env);
  const own = env && !rec?.isUntracked(name) ? env.get(name) : undefined;
  if (own || host.isLocal(name)) {
    const k = literalIndex(node, source);
    return bracesIndex(node) ? elementOf(own, k) : partOf(own, k);
  }
  const one = vals.length === 1 ? vals[0]! : null;
  switch (name) {
    case 'strcat':
      return strcat(args, vals, source);
    case 'upper':
    case 'lower':
      return one ? mapStrings(one, (s) => (name === 'upper' ? s.toUpperCase() : s.toLowerCase())) : OPEN;
    case 'strtrim':
      return one ? mapStrings(one, (s) => trimEnd(trimStart(s))) : OPEN;
    case 'deblank':
      return one ? mapStrings(one, trimEnd) : OPEN;
    case 'char':
      return one ? { ...mapStrings(one, (s) => s), stringObject: false } : OPEN;
    case 'sprintf':
      return sprintf(vals);
    case 'func2str': {
      if (!one) return OPEN;
      const names = one.fns.filter((f) => /^[A-Za-z]\w*$/.test(f.name)).map((f) => f.name);
      return make({ strs: names, open: one.open || one.strs.length > 0 || names.length < one.fns.length || one.cell !== null || one.fields !== null });
    }
    case 'str2func': {
      if (!one) return OPEN;
      const fns: FnVal[] = [];
      let open = besidesText(one) && (one.open || one.cell !== null || one.fields !== null || one.fns.length > 0);
      for (const text of one.strs) {
        const f = NAME_SHAPED.test(text) ? host.named(text.split('.')) : null;
        if (f) fns.push(f);
        else open = true;
      }
      return make({ fns, open });
    }
    case 'struct':
      return structLiteral(args, vals, source);
  }
  return OPEN;
}

/**
 * `struct('f', 'a', 'g', {'x', 'y'})` with literal field names: a struct the
 * code built; a cell value makes a struct array, one element per cell element
 * (a 1-by-1 cell's element goes to every element). Anything else unknown.
 */
function structLiteral(args: readonly SyntaxNode[], vals: readonly Val[], source: string): Val {
  if (args.length === 0 || args.length % 2 !== 0) return OPEN;
  const keys: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = stringLiteral(args[i]!, source);
    if (key === null || !/^[A-Za-z]\w*$/.test(key)) return OPEN;
    keys.push(key);
  }
  const values = keys.map((_, j) => vals[2 * j + 1]!);
  const isCell = (v: Val): boolean => v.cell !== null && !besidesCell(v);
  const lengths = values.filter(isCell).map((v) => v.cellItems?.length ?? -1);
  const n = lengths.find((l) => l !== 1) ?? 1;
  if (lengths.some((l) => l !== 1 && l !== n)) return OPEN; // MATLAB errors on cells of other sizes
  if (n < 0) {
    // A cell of a size nothing here knows: a struct array, any element of which holds any element of each.
    const fields = new Map(keys.map((k, j) => [k, isCell(values[j]!) ? values[j]!.cell! : values[j]!]));
    return make({ fields, built: true });
  }
  const records: Fields[] = [];
  for (let e = 0; e < n; e++) {
    records.push(new Map(keys.map((k, j) => {
      const v = values[j]!;
      return [k, isCell(v) ? v.cellItems![v.cellItems!.length === 1 ? 0 : e]! : v];
    })));
  }
  return structOfRecords(records, true);
}

/** `v`'s strings through `f` (a HOLE kept as one); its other possibilities unknown. */
function mapStrings(v: Val, f: (s: string) => string): Val {
  return make({ strs: v.strs.map((s) => normalText(f(s))), stringObject: v.stringObject, open: besidesText(v) });
}

/** Whether a character is whitespace as `strtrim` reads it. */
const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';

/**
 * Leading whitespace off. A HOLE among it (which may be whitespace, or text)
 * takes the whitespace around it: what is left starts with the HOLE.
 */
function trimStart(s: string): string {
  let i = 0;
  let hole = false;
  for (; i < s.length && (isBlank(s[i]!) || s[i] === HOLE); i++) if (s[i] === HOLE) hole = true;
  return (hole ? HOLE : '') + s.slice(i);
}

/** Trailing whitespace off, a HOLE among it taking the whitespace around it (see trimStart). */
function trimEnd(s: string): string {
  let i = s.length;
  let hole = false;
  for (; i > 0 && (isBlank(s[i - 1]!) || s[i - 1] === HOLE); i--) if (s[i - 1] === HOLE) hole = true;
  return s.slice(0, i) + (hole ? HOLE : '');
}

/**
 * `[a b c]`: each part's strings in turn. A part that may be anything else —
 * unknown, a number, a handle — is a HOLE there. Cut at the bounds.
 */
export function concat(parts: readonly Val[]): Val {
  let out = [''];
  let open = false;
  for (const p of parts) {
    const options = [...p.strs];
    if (besidesText(p) || options.length === 0) options.push(HOLE);
    const next: string[] = [];
    for (const a of out) {
      for (const b of options) {
        if (next.length >= MAX_POSSIBILITIES) {
          open = true;
          break;
        }
        next.push(append(a, b));
      }
    }
    out = [...new Set(next)];
  }
  return make({ strs: out, open });
}

/** `a` then `b`, a HOLE where they meet merged; a text already cut at MAX_TEXT takes nothing more. */
function append(a: string, b: string): string {
  if (a.length > MAX_TEXT) return a;
  const joined = a.endsWith(HOLE) && b.startsWith(HOLE) ? a + b.slice(1) : a + b;
  return joined.length > MAX_TEXT ? normalText(joined) : joined;
}

/**
 * `strcat(a, b, …)`: concatenation, a char argument's trailing whitespace
 * dropped (a string object's kept). A literal says which it is; for a computed
 * part ending in whitespace that is not the last, the whitespace may or may
 * not go, so it is a HOLE.
 */
function strcat(args: readonly SyntaxNode[], vals: readonly Val[], source: string): Val {
  if (vals.length === 0) return OPEN;
  let object = false;
  const parts = vals.map((v, i) => {
    if (v.cell) return OPEN;
    if (v.strs.length === 0) return v;
    const arg = args[i]!;
    const literal = arg.type === 'string' ? source[arg.startIndex] : null;
    const last = i === vals.length - 1;
    object ||= literal === '"' || v.stringObject;
    const strs = v.strs.map((s) => {
      if (literal === '"') return s;
      if (literal === "'" || (last && !v.stringObject)) return trimEnd(s);
      return /[ \t\n\r\f\v]$/.test(s) ? trimEnd(s) + HOLE : s;
    });
    return make({ strs, open: besidesText(v) });
  });
  const out = concat(parts);
  return object ? { ...out, stringObject: out.strs.length > 0 } : out;
}

/**
 * `sprintf(fmt, …)` for a format of `%s`, `%d`, `%i`, `%%`, `\n`, `\t`, `\\`
 * and literal text, with no argument left over (which would repeat the
 * format): `%s` takes its argument's strings, `%d` / `%i` a HOLE. Anything
 * else is unknown.
 */
function sprintf(vals: readonly Val[]): Val {
  const fmt = vals[0];
  if (!fmt || fmt.strs.length === 0) return OPEN;
  let out = NONE;
  for (const f of fmt.strs) {
    if (f.includes(HOLE)) return OPEN;
    const parts: Val[] = [];
    let arg = 1;
    let text = '';
    for (let i = 0; i < f.length; i++) {
      const ch = f[i]!;
      if (ch === '\\') {
        const e = f[++i];
        if (e === 'n') text += '\n';
        else if (e === 't') text += '\t';
        else if (e === '\\') text += '\\';
        else return OPEN;
      } else if (ch === '%') {
        const spec = f[++i];
        if (spec === '%') text += '%';
        else if (spec === 's' || spec === 'd' || spec === 'i') {
          parts.push(strVal(text));
          text = '';
          const v = vals[arg++];
          if (!v) break; // MATLAB stops at the first specifier with no argument left
          parts.push(spec === 's' ? v : OPEN);
        } else return OPEN;
      } else text += ch;
    }
    if (arg < vals.length) return OPEN;
    parts.push(strVal(text));
    out = join(out, concat(parts.map((p) => (p.stringObject ? { ...p, stringObject: false } : p))));
  }
  out = fmt.stringObject ? { ...out, stringObject: out.strs.length > 0 } : out;
  return besidesText(fmt) ? withOpen(out) : out;
}
