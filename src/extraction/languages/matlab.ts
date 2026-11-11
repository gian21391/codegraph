import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * MATLAB extractor (vendored acristoffers/tree-sitter-matlab, ABI 15).
 *
 * Everything goes through the visitNode hook: the grammar spells a call and an
 * index read the same way (`f(x)` is a `function_call` whether `f` is a
 * function or a matrix), and a method, a nested function and a local function
 * are all one `function_definition`, so which is which is decided here from
 * the surrounding code rather than from node-type lists.
 *
 *   - functions:  a file's FIRST function is the one MATLAB calls by the file's
 *                 name (`isExported`); the ones after it, and nested ones, are
 *                 local to the file (`isExported: false` — the resolver keeps
 *                 another file's calls off them). In a class folder
 *                 (`@Account/deposit.m`) the first function is a method of
 *                 that class.
 *   - packages:   `+pkg/+sub/f.m` qualifies what the file defines as
 *                 `pkg::sub::f`, so `pkg.sub.f(x)` resolves by qualified name.
 *   - classdef:   class (an `enumeration` class with members is an enum);
 *                 `< Base & handle` → extends refs; properties → property
 *                 (Constant → constant); `methods (Static, Access = private)`
 *                 blocks set the static / visibility / abstract flags on their
 *                 methods; `get.Prop` / `set.Prop` keep their prefix.
 *   - calls:      `f(x)`, `f` as a value, `pkg.f(x)`, `Cls.staticM(x)`,
 *                 `obj.m(x)`, and command syntax (`setup_paths`, `hold on`).
 *                 A name the enclosing function assigns, takes as an argument
 *                 or declares global is a VARIABLE there — MATLAB decides that
 *                 per function, statically — so `x(3)` on one is an index read
 *                 and emits nothing. `obj.m()` and `m(obj, …)` on a method's
 *                 own object (its first parameter) are `Cls::m`; on a variable the
 *                 function assigns from a constructor (`c = pkg.Cls(…)`) it
 *                 is `pkg::Cls::m`; on any other variable `v.m`, which the
 *                 resolver links only to an unambiguous method (a struct
 *                 field indexed reads the same).
 *   - handles:    `@f` / `@pkg.f` / `@obj.m` are function references
 *                 (callbacks: `cellfun(@f, …)`, `'Callback', @onClick`).
 *   - imports:    `import pkg.*` / `import pkg.Cls` (command syntax).
 */

/** Built-in base classes: never a project symbol, so no extends edge to guess at. */
const BUILTIN_BASES = /^(?:handle|dynamicprops|hgsetget|matlab\..*|matlab)$/;

/** Parent node types under which a bare identifier is READ as a value (or called with no arguments). */
const VALUE_PARENTS = new Set([
  'binary_operator',
  'unary_operator',
  'comparison_operator',
  'boolean_operator',
  'not_operator',
  'postfix_operator',
  'parenthesis',
  'row',
  'range',
]);

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

/** Identifiers directly under a node (e.g. `function_output`, `multioutput_variable`, `global_operator`). */
function identifiersIn(node: SyntaxNode, source: string, into: Set<string>): void {
  for (const c of namedChildren(node)) {
    if (c.type === 'identifier') into.add(getNodeText(c, source));
    else if (c.type === 'multioutput_variable') identifiersIn(c, source, into);
  }
}

/** Attribute names (lowercased) of an `attributes` child, with their values: `Access = private` → access→private, `Static` → static→true. */
function attributesOf(node: SyntaxNode | null, source: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!node) return out;
  const attrs = namedChildren(node).find((c) => c.type === 'attributes');
  if (!attrs) return out;
  for (const attr of namedChildren(attrs)) {
    if (attr.type !== 'attribute') continue;
    const parts = namedChildren(attr);
    const key = parts[0] ? getNodeText(parts[0], source).toLowerCase() : '';
    if (!key) continue;
    const value = parts[1] ? getNodeText(parts[1], source).replace(/^['"]|['"]$/g, '').toLowerCase() : 'true';
    out.set(key, value);
  }
  return out;
}

function visibilityFrom(attrs: Map<string, string>): 'public' | 'private' | 'protected' | undefined {
  const access = attrs.get('access') ?? attrs.get('getaccess');
  if (access === 'private') return 'private';
  if (access === 'protected') return 'protected';
  if (access === 'public') return 'public';
  return undefined;
}

/** `%`-comment text of a function's or class's help block (the first comment child), markers stripped. */
function helpText(node: SyntaxNode, source: string): string | undefined {
  const comment = namedChildren(node).find((c) => c.type === 'comment');
  if (!comment) return undefined;
  const text = getNodeText(comment, source)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*%[{}]?\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Path-derived scope: +package folders and @Class folders
// ---------------------------------------------------------------------------

interface PathScope {
  /** `+a/+b/` → ['a', 'b'] */
  packages: string[];
  /** `@Cls/` → 'Cls' */
  classFolder?: string;
}

function pathScope(filePath: string): PathScope {
  const dirs = filePath.split(/[\\/]/).slice(0, -1);
  let classFolder: string | undefined;
  let end = dirs.length;
  if (end > 0 && dirs[end - 1]!.startsWith('@')) {
    classFolder = dirs[end - 1]!.slice(1);
    end--;
  }
  const packages: string[] = [];
  for (let i = end - 1; i >= 0 && dirs[i]!.startsWith('+'); i--) packages.unshift(dirs[i]!.slice(1));
  return { packages, classFolder };
}

/** Qualified name: package path + enclosing (non-file) scopes + name, `::`-joined. */
function qualify(ctx: ExtractorContext, name: string, extraScope: string[] = []): string {
  const parts = [...pathScope(ctx.filePath).packages, ...extraScope];
  for (const id of ctx.nodeStack) {
    const n = findNode(ctx, id);
    if (n && n.kind !== 'file') parts.push(n.name);
  }
  parts.push(name);
  return parts.join('::');
}

function findNode(ctx: ExtractorContext, id: string): Node | undefined {
  const nodes = ctx.nodes;
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i]!.id === id) return nodes[i];
  return undefined;
}

// ---------------------------------------------------------------------------
// Variables of a function — what makes `x(3)` an index read rather than a call
// ---------------------------------------------------------------------------

let localsSource: string | null = null;
let localsCache = new Map<number, Set<string>>();
let classHintCache = new Map<number, Map<string, string>>();

/**
 * The class a variable holds, where every constructor-shaped assignment to it
 * agrees: `c = Circle(2)` / `c = geom.Circle(2)` (MATLAB names classes in
 * UpperCamelCase; a capitalised callee that is no variable is read as a
 * constructor). `pkg::Cls` / `Cls`, as the resolver reads a qualified ref.
 */
function collectClassHints(scope: SyntaxNode, source: string, locals: Set<string>): Map<string, string> {
  const hints = new Map<string, string>();
  const conflicted = new Set<string>();
  const constructed = (rhs: SyntaxNode | null): string | null => {
    if (rhs?.type === 'function_call') {
      const name = getChildByField(rhs, 'name');
      const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
      return /^[A-Z]/.test(text) && !locals.has(text) ? text : null;
    }
    if (rhs?.type === 'field_expression') {
      const parts = namedChildren(rhs);
      const last = parts[parts.length - 1];
      if (parts.length < 2 || last?.type !== 'function_call') return null;
      const path: string[] = [];
      for (const p of parts.slice(0, -1)) {
        if (p.type !== 'identifier') return null;
        path.push(getNodeText(p, source));
      }
      if (locals.has(path[0]!)) return null;
      const name = getChildByField(last, 'name');
      const text = name?.type === 'identifier' ? getNodeText(name, source) : '';
      return /^[A-Z]/.test(text) ? [...path, text].join('::') : null;
    }
    return null;
  };
  const walk = (n: SyntaxNode): void => {
    for (const c of namedChildren(n)) {
      if (c.type === 'function_definition' || c.type === 'class_definition') continue;
      if (c.type === 'assignment') {
        const left = getChildByField(c, 'left');
        const cls = left?.type === 'identifier' ? constructed(getChildByField(c, 'right')) : null;
        if (cls) {
          const v = getNodeText(left!, source);
          if (hints.has(v) && hints.get(v) !== cls) conflicted.add(v);
          else hints.set(v, cls);
        }
      }
      walk(c);
    }
  };
  walk(scope);
  for (const v of conflicted) hints.delete(v);
  return hints;
}

/** The class `name` holds in the function around `node`, when its assignments say so. */
function classHintAt(node: SyntaxNode, name: string, source: string): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== 'function_definition' && p.type !== 'source_file') continue;
    let hints = classHintCache.get(p.startIndex);
    if (!hints) {
      hints = collectClassHints(p, source, localsFor(p, source));
      classHintCache.set(p.startIndex, hints);
    }
    return hints.get(name);
  }
  return undefined;
}

/** Names assigned / passed in / declared in `scope` (a function_definition or the script's source_file), its nested functions excluded. */
function collectLocals(scope: SyntaxNode, source: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    for (const c of namedChildren(n)) {
      switch (c.type) {
        case 'function_definition':
        case 'class_definition':
          continue; // its own workspace (a nested function sees ours, not vice versa)
        case 'function_output':
          identifiersIn(c, source, out);
          continue;
        case 'function_arguments':
          identifiersIn(c, source, out);
          continue;
        case 'assignment': {
          const left = getChildByField(c, 'left');
          if (left?.type === 'identifier') out.add(getNodeText(left, source));
          else if (left?.type === 'multioutput_variable') identifiersIn(left, source, out);
          else if (left?.type === 'function_call') {
            const name = getChildByField(left, 'name');
            if (name) out.add(getNodeText(name, source)); // `x(k) = …` makes x a variable
          } else if (left?.type === 'field_expression') {
            const obj = getChildByField(left, 'object');
            if (obj?.type === 'identifier') out.add(getNodeText(obj, source));
            else if (obj?.type === 'function_call') {
              const name = getChildByField(obj, 'name');
              if (name) out.add(getNodeText(name, source)); // `s(k).f = …`
            }
          }
          break;
        }
        case 'iterator': {
          const v = c.namedChild(0);
          if (v?.type === 'identifier') out.add(getNodeText(v, source));
          break;
        }
        case 'global_operator':
        case 'persistent_operator':
          identifiersIn(c, source, out);
          continue;
        case 'lambda': {
          const args = namedChildren(c).find((a) => a.type === 'arguments');
          if (args) identifiersIn(args, source, out);
          break;
        }
        case 'catch_clause': {
          const v = namedChildren(c).find((a) => a.type === 'identifier');
          if (v) out.add(getNodeText(v, source));
          break;
        }
      }
      walk(c);
    }
  };
  walk(scope);
  return out;
}

/** The variables visible where `node` sits: its function's, plus every enclosing function's (nested functions share their parent's workspace). */
function localsAt(node: SyntaxNode, source: string): Set<string> {
  if (localsSource !== source) {
    localsSource = source;
    localsCache = new Map();
    classHintCache = new Map();
  }
  const scopes: SyntaxNode[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'function_definition') scopes.push(p);
    else if (p.type === 'class_definition') break;
    else if (p.type === 'source_file') {
      if (scopes.length === 0) scopes.push(p); // script code
      break;
    }
  }
  if (scopes.length === 1) return localsFor(scopes[0]!, source);
  const all = new Set<string>();
  for (const s of scopes) for (const v of localsFor(s, source)) all.add(v);
  return all;
}

function localsFor(scope: SyntaxNode, source: string): Set<string> {
  let set = localsCache.get(scope.startIndex);
  if (!set) {
    set = collectLocals(scope, source);
    localsCache.set(scope.startIndex, set);
  }
  return set;
}

/**
 * The method's own object — its first parameter — and its class, when `node`
 * sits in a non-static method: one in a classdef `methods` block, or a class
 * folder's method file (`@Cls/m.m`, the constructor `@Cls/Cls.m` aside).
 * Nested functions see their method's object; local functions do not.
 */
function selfAt(node: SyntaxNode, ctx: ExtractorContext): { name: string; cls: string } | null {
  const source = ctx.source;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== 'function_definition') continue;
    let cls: string | null = null;
    if (p.parent?.type === 'methods') {
      if (attributesOf(p.parent, source).get('static') === 'true') return null;
      const def = p.parent.parent;
      const name = def?.type === 'class_definition' ? getChildByField(def, 'name') : null;
      if (name) cls = [...pathScope(ctx.filePath).packages, getNodeText(name, source)].join('::');
    } else if (isPrimaryFunction(p)) {
      const scope = pathScope(ctx.filePath);
      const fnName = getChildByField(p, 'name');
      if (scope.classFolder && fnName && getNodeText(fnName, source) !== scope.classFolder) {
        cls = [...scope.packages, scope.classFolder].join('::');
      }
    } else if (p.parent?.type !== 'source_file') {
      continue; // a nested function: its method's object is in scope
    }
    if (!cls) return null;
    const args = namedChildren(p).find((c) => c.type === 'function_arguments');
    const first = args ? namedChildren(args).find((c) => c.type === 'identifier') : undefined;
    return first ? { name: getNodeText(first, source), cls } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function addRef(ctx: ExtractorContext, name: string, kind: 'calls' | 'function_ref' | 'extends' | 'imports', at: SyntaxNode): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId || !name) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

/**
 * `a.b.f(x)` / `obj.m(x)` / `Cls.m(x)`: the reference for the first call in a
 * field chain whose receiver is a plain dotted name. Later calls in a chain
 * (`obj.get().run()`) act on a returned value with no static type — silent.
 */
function fieldChainRef(node: SyntaxNode, ctx: ExtractorContext): { name: string; at: SyntaxNode } | null {
  const object = getChildByField(node, 'object');
  if (object?.type !== 'identifier') return null;
  const path = [getNodeText(object, ctx.source)];
  for (const f of namedChildren(node).slice(1)) {
    if (f.type === 'identifier') {
      path.push(getNodeText(f, ctx.source));
      continue;
    }
    if (f.type !== 'function_call') return null;
    const callee = getChildByField(f, 'name');
    if (callee?.type !== 'identifier') return null;
    const method = getNodeText(callee, ctx.source);
    const head = path[0]!;
    const self = selfAt(node, ctx);
    if (self && head === self.name) {
      if (path.length !== 1) return null; // obj.Prop.m() — a property's value
      return { name: `${self.cls}::${method}`, at: f };
    }
    if (localsAt(node, ctx.source).has(head)) {
      // A variable's method (`c.area()`): through its class when the function
      // says what the variable holds, else `v.m`, which the resolver links only
      // to a method no property shares a name with (`opts.tol(1)` on a struct
      // reads the same). Deeper (`s.field.m()`) is a field's value.
      if (path.length !== 1) return null;
      const cls = classHintAt(node, head, ctx.source);
      return { name: cls ? `${cls}::${method}` : `${head}.${method}`, at: f };
    }
    // Not a variable: a package path or a class (`pkg.sub.f`, `Cls.staticM`, `pkg.Cls`).
    return { name: [...path, method].join('::'), at: f };
  }
  return null;
}

/** `@f` / `@pkg.f` / `@obj.m` */
function handleRef(node: SyntaxNode, ctx: ExtractorContext): string | null {
  const ids = namedChildren(node);
  if (ids.length === 0 || ids.some((c) => c.type !== 'identifier')) return null; // `@(x) …` is a lambda node, not this
  const names = ids.map((c) => getNodeText(c, ctx.source));
  if (names.length === 1) return names[0]!;
  // `@obj.onClick` names a method as `obj.onClick()` would call it.
  const head = names[0]!;
  const self = selfAt(node, ctx);
  if (self && head === self.name) return names.length === 2 ? `${self.cls}::${names[1]}` : null;
  if (localsAt(node, ctx.source).has(head)) {
    if (names.length !== 2) return null;
    const cls = classHintAt(node, head, ctx.source);
    return cls ? `${cls}::${names[1]}` : `${head}.${names[1]}`;
  }
  return names.join('::');
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function functionSignature(node: SyntaxNode, source: string): string {
  const args = namedChildren(node).find((c) => c.type === 'function_arguments');
  const name = getChildByField(node, 'name');
  const end = args?.endIndex ?? name?.endIndex ?? node.endIndex;
  const text = source.slice(node.startIndex, end).replace(/\s+/g, ' ').trim();
  return node.type === 'function_signature' && !text.startsWith('function') ? `function ${text}` : text;
}

/** Whether this top-level function is the file's own (the first thing in a function file). */
function isPrimaryFunction(node: SyntaxNode): boolean {
  if (node.parent?.type !== 'source_file') return false;
  for (let s = node.previousNamedSibling; s; s = s.previousNamedSibling) {
    if (s.type !== 'comment') return false;
  }
  return true;
}

function extractFunction(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  let name = getNodeText(nameNode, source);
  const accessor = source.slice(Math.max(0, nameNode.startIndex - 4), nameNode.startIndex);
  if (accessor === 'get.' || accessor === 'set.') name = accessor + name;

  const block = node.parent?.type === 'methods' ? node.parent : null;
  const blockAttrs = attributesOf(block, source);
  const primary = isPrimaryFunction(node);
  const classFolder = primary ? pathScope(ctx.filePath).classFolder : undefined;
  const kind: NodeKind = block || classFolder ? 'method' : 'function';

  const extra: Partial<Node> = {
    qualifiedName: qualify(ctx, name, classFolder ? [classFolder] : []),
    signature: functionSignature(node, source),
    docstring: helpText(node, source),
  };
  if (block) {
    const vis = visibilityFrom(blockAttrs);
    if (vis) extra.visibility = vis;
    if (blockAttrs.get('static') === 'true') extra.isStatic = true;
    if (blockAttrs.get('abstract') === 'true' || node.type === 'function_signature') extra.isAbstract = true;
  } else if (kind === 'function') {
    extra.isExported = primary;
  }

  const fn = ctx.createNode(kind, name, node, extra);
  if (!fn) return;
  ctx.pushScope(fn.id);
  for (const c of namedChildren(node)) {
    if (c.type === 'block' || c.type === 'arguments_statement' || c.type === 'function_definition') ctx.visitNode(c);
  }
  ctx.popScope();
}

function extractClass(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, source);
  const children = namedChildren(node);
  const isEnum = children.some((c) => c.type === 'enumeration' && namedChildren(c).some((e) => e.type === 'enum'));
  const attrs = attributesOf(node, source);

  const supers = children.find((c) => c.type === 'superclasses');
  const bases = supers
    ? namedChildren(supers)
        .filter((c) => c.type === 'property_name')
        .map((c) => namedChildren(c).map((i) => getNodeText(i, source)).join('.'))
    : [];

  const cls = ctx.createNode(isEnum ? 'enum' : 'class', name, node, {
    qualifiedName: qualify(ctx, name),
    docstring: helpText(node, source),
    signature: source.slice(node.startIndex, (supers ?? nameNode).endIndex).replace(/\s+/g, ' ').trim(),
    ...(attrs.get('abstract') === 'true' ? { isAbstract: true } : {}),
  });
  if (!cls) return;

  ctx.pushScope(cls.id);
  for (const base of bases) {
    if (!BUILTIN_BASES.test(base)) addRef(ctx, base.replace(/\./g, '::'), 'extends', supers!);
  }
  for (const section of children) {
    if (section.type === 'properties') {
      const sectionAttrs = attributesOf(section, source);
      const constant = sectionAttrs.get('constant') === 'true';
      const vis = visibilityFrom(sectionAttrs);
      for (const prop of namedChildren(section)) {
        if (prop.type !== 'property') continue;
        const propName = getChildByField(prop, 'name');
        if (!propName) continue;
        const pname = getNodeText(propName, source);
        ctx.createNode(constant ? 'constant' : 'property', pname, prop, {
          qualifiedName: qualify(ctx, pname),
          signature: getNodeText(prop, source).replace(/\s+/g, ' ').trim(),
          ...(vis ? { visibility: vis } : {}),
        });
        const dflt = namedChildren(prop).find((c) => c.type === 'default_value');
        if (dflt) ctx.visitNode(dflt);
      }
    } else if (section.type === 'enumeration') {
      for (const member of namedChildren(section)) {
        if (member.type !== 'enum') continue;
        const id = namedChildren(member).find((c) => c.type === 'identifier');
        if (id) {
          const mname = getNodeText(id, source);
          ctx.createNode('enum_member', mname, member, { qualifiedName: qualify(ctx, mname) });
        }
      }
    } else if (section.type === 'methods') {
      for (const m of namedChildren(section)) {
        if (m.type === 'function_definition' || m.type === 'function_signature') extractFunction(m, ctx);
      }
    }
  }
  ctx.popScope();
}

function extractImport(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const arg of namedChildren(node)) {
    if (arg.type !== 'command_argument') continue;
    const target = getNodeText(arg, ctx.source).trim();
    if (!/^[A-Za-z_][\w.]*(?:\.\*)?$/.test(target)) continue;
    ctx.createNode('import', target, node, { signature: getNodeText(node, ctx.source).trim().slice(0, 100) });
    addRef(ctx, target.replace(/\.\*$/, '').replace(/\./g, '::'), 'imports', arg);
  }
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export const matlabExtractor: LanguageExtractor = {
  functionTypes: [], // function_definition is a function, method, nested or local function — decided in visitNode
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [], // `f(x)` is a call or an index read — decided in visitNode
  variableTypes: [],
  nameField: 'name',
  bodyField: 'block',
  paramsField: 'function_arguments',

  visitNode: (node, ctx) => {
    const source = ctx.source;
    switch (node.type) {
      case 'class_definition':
        extractClass(node, ctx);
        return true;

      case 'function_definition':
      case 'function_signature':
        extractFunction(node, ctx);
        return true;

      case 'function_call': {
        const parent = node.parent;
        // A field of a chain (`pkg.f(x)`, `obj.m()`): the field_expression owns it.
        if (parent?.type === 'field_expression' && getChildByField(parent, 'object')?.id !== node.id) return false;
        // `x(k) = …` assigns into x.
        if (parent?.type === 'assignment' && getChildByField(parent, 'left')?.id === node.id) return false;
        const callee = getChildByField(node, 'name');
        if (callee?.type !== 'identifier') return false;
        const name = getNodeText(callee, source);
        if (localsAt(node, source).has(name)) return false; // an index read
        // `m(obj, …)` on the method's own object dispatches to the class's
        // method (`char(obj)`, `rne(robot, …)`); any other call is a function
        // call, even of a name the class overloads (`char(s, '…')`).
        const self = selfAt(node, ctx);
        const firstArg = self ? namedChildren(node).find((c) => c.type === 'arguments')?.namedChild(0) : null;
        const onSelf = firstArg?.type === 'identifier' && getNodeText(firstArg, source) === self!.name;
        addRef(ctx, onSelf ? `${self!.cls}::${name}` : name, 'calls', node);
        return false; // arguments still walked
      }

      case 'field_expression': {
        if (node.parent?.type === 'assignment' && getChildByField(node.parent, 'left')?.id === node.id) return false;
        const ref = fieldChainRef(node, ctx);
        if (ref) addRef(ctx, ref.name, 'calls', ref.at);
        return false;
      }

      case 'identifier': {
        // A bare name read as a value is a zero-argument call when it is no variable: `t = loadConfig;`.
        const parent = node.parent;
        if (!parent) return false;
        const asValue =
          VALUE_PARENTS.has(parent.type) ||
          (parent.type === 'assignment' && getChildByField(parent, 'right')?.id === node.id) ||
          (parent.type === 'arguments' && parent.parent?.type === 'function_call');
        if (!asValue) return false;
        const name = getNodeText(node, source);
        if (!localsAt(node, source).has(name)) addRef(ctx, name, 'calls', node);
        return false;
      }

      case 'command': {
        const cmd = namedChildren(node).find((c) => c.type === 'command_name');
        if (!cmd) return true;
        const name = getNodeText(cmd, source);
        if (name === 'import') extractImport(node, ctx);
        else if (!localsAt(node, source).has(name)) addRef(ctx, name, 'calls', node);
        return true;
      }

      case 'handle_operator': {
        const target = handleRef(node, ctx);
        if (target) addRef(ctx, target, 'function_ref', node);
        return true;
      }
    }
    return false;
  },
};
