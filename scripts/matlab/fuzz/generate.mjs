/**
 * The MATLAB fuzzer's project generator: a seed becomes a small random
 * project, plain files on disk (path -> text, or a Buffer for exact bytes).
 *
 * It draws on the catalog's feature list (path roots in codegraph.json or a
 * startup.m, private/, +packages, @class folders, classdef, local and nested
 * functions, scripts, command syntax, dotted calls and field reads, variables
 * that shadow names, load/eval/global/persistent, handles and callbacks,
 * built-ins' names, Octave and binary files, parse errors, and the text
 * oddities: CRLF, a BOM, non-ASCII text, continuations, block comments, `!`
 * lines). Names come from small shared pools, so collisions, shadowing and
 * case variants are frequent.
 */

/**
 * The generator's version: bumped whenever a change to the generator or the
 * mutator changes what a seed draws, so that a reproduce line printed by an
 * older one is known not to replay (run.mjs warns). 1: the first campaign;
 * 2: the step 11 campaign; 3: the farther-copy motif and toggle (step 11 fix).
 */
export const GENERATOR_VERSION = 3;

export const NAMES = ['f', 'g', 'h', 'F', 'helper', 'run', 'util', 'Util', 'plot', 'size', 'disp', 'max', 'step', 'data', 'setup', 'widget'];
export const CLASSES = ['Widget', 'Base', 'Gadget', 'Mid', 'widget'];
export const METHODS = ['step', 'run', 'plot', 'size', 'g', 'update', 'disp', 'reset'];
export const PROPS = ['x', 'data', 'step', 'g', 'Value'];
export const PKGS = ['pkg', 'Pkg'];
export const SUBPKGS = ['sub'];

/** Folders a plain function or script may live in, by weight. */
const FOLDERS = { '': 5, lib: 2, 'lib/sub': 1, tools: 1.5, off: 1, private: 1, 'lib/private': 0.7, '+pkg': 1.5, '+pkg/+sub': 0.7, '+pkg/private': 0.3, '+Pkg': 0.3 };
/** Folders whose files a path entry can name. */
export const PATH_DIRS = ['lib', 'lib/sub', 'tools', 'off', 'tools/x'];

export const ERROR_LINE = 'zq = (1;';

const BUILTINS = ['disp', 'max', 'size', 'plot', 'numel', 'zeros', 'fprintf', 'isempty', 'class', 'error'];

/**
 * `rel` with each folder spelled as a path already in `files` spells it, when
 * one differs only in case: on a case-insensitive file system (macOS,
 * Windows) `+pkg/` and `+Pkg/` are one folder, so the map must not hold both.
 */
export function canonicalPath(files, rel) {
  const parts = rel.split('/');
  const existing = Object.keys(files).map((p) => p.split('/'));
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i).join('/').toLowerCase();
    const same = existing.find((q) => q.length > i + 1 && q.slice(0, i).join('/').toLowerCase() === prefix && q[i].toLowerCase() === parts[i].toLowerCase());
    if (same) parts[i] = same[i];
  }
  return parts.join('/');
}

/** Case-insensitive file systems hold one of `f.m` / `F.m`: adding one replaces the other. */
export function putFile(files, rel, content) {
  rel = canonicalPath(files, rel);
  const low = rel.toLowerCase();
  for (const k of Object.keys(files)) if (k !== rel && k.toLowerCase() === low) delete files[k];
  files[rel] = content;
}

/** A name for a call: mostly the pool, sometimes a built-in, sometimes a qualified package name. */
function callee(rng) {
  const r = rng.next();
  if (r < 0.62) return rng.pick(NAMES);
  if (r < 0.75) return rng.pick(BUILTINS);
  if (r < 0.88) return `${rng.pick(PKGS)}.${rng.pick(NAMES)}`;
  if (r < 0.94) return `pkg.${rng.pick(SUBPKGS)}.${rng.pick(NAMES)}`;
  return `${rng.pick(PKGS)}.${rng.pick(CLASSES)}`;
}

const arg = (rng) => rng.pick(['1', 'x', 'a', "'s'", '[1 2]', 'obj', '{}', 'x(1)', 'a.data']);

/**
 * One statement (one or more lines) of a body. `ctx`: { fn: inside a function,
 * cls: the enclosing class's name, obj: the own object's name, depth }.
 */
export function statement(rng, ctx = {}) {
  const depth = ctx.depth ?? 0;
  const n = () => rng.pick(NAMES);
  const kinds = {
    call: 6, assignCall: 5, bare: 2, command: 2, assign: 3, dotted: 3, field: 2, ctor: 2, fnSyntax: 2,
    pkg: 2, importStmt: 1, handle: 2, callback: 1.5, strCallback: 1, feval: 1, eval: 1, evalin: 0.7, assignin: 0.7,
    load: 1.5, global: 1, persistent: ctx.fn ? 1 : 0, nest: depth < 3 ? 2.5 : 0, cont: 1, block: 0.8, shell: 0.4,
    unicode: 0.6, comment: 1, indexAssign: 1, cellfun: 0.8, self: ctx.obj ? 3 : 0, superCall: ctx.cls ? 0.8 : 0,
    error: 0.25, wordPiece: 0.2,
  };
  switch (rng.weighted(kinds)) {
    case 'call': return [`${callee(rng)}(${arg(rng)});`];
    case 'assignCall': return [`${rng.pick(['y', 'x', 'r', n()])} = ${callee(rng)}(${arg(rng)});`];
    case 'bare': return [`${n()}`];
    case 'command': return [`${n()} ${rng.pick(['on', 'off', 'all', '-v', 'data.mat'])}`];
    case 'assign': return [`${n()} = ${rng.pick(['1', '[]', "'t'", 'zeros(2)', 'x'])};`];
    case 'dotted': return [`${rng.pick(['y = ', ''])}${rng.pick(['obj', 'a', 's', 'w'])}.${rng.pick(METHODS)}(${arg(rng)});`];
    case 'field': return [`y = ${rng.pick(['obj', 'a', 's'])}.${rng.pick([...PROPS, ...METHODS])};`];
    case 'ctor': return [`${rng.pick(['w', 'obj', 'a'])} = ${rng.pick(CLASSES)}(${rng.pick(['', '1', 'x'])});`];
    case 'fnSyntax': return [`${rng.pick(METHODS)}(${rng.pick(['w', 'obj', 'a', 'x'])}${rng.chance(0.5) ? ', 1' : ''});`];
    case 'pkg': return [`y = ${rng.pick(PKGS)}.${rng.chance(0.3) ? `${rng.pick(SUBPKGS)}.` : ''}${rng.chance(0.25) ? rng.pick(CLASSES) : n()}(${arg(rng)});`];
    case 'importStmt': return [`import ${rng.pick(PKGS)}.${rng.chance(0.5) ? '*' : n()}`, `${n()}(1);`];
    case 'handle': { const v = rng.pick(['hf', 'cb']); return [`${v} = @${rng.chance(0.2) ? `${rng.pick(PKGS)}.` : ''}${n()};`, `${v}(${arg(rng)});`]; }
    case 'callback': return [`set(gcf, '${rng.pick(['Callback', 'ButtonDownFcn', 'CloseRequestFcn'])}', @${n()});`];
    case 'strCallback': return [`uicontrol('Style', 'pushbutton', 'Callback', '${n()}(1)');`];
    case 'feval': return [`feval(${rng.chance(0.7) ? `'${n()}'` : `@${n()}`}, ${arg(rng)});`];
    case 'eval': return [`eval('${n()}(1);');`];
    case 'evalin': return [`evalin('${rng.pick(['base', 'caller'])}', '${n()}');`];
    case 'assignin': return [`assignin('${rng.pick(['base', 'caller'])}', '${n()}', 1);`];
    case 'load': {
      const r = rng.int(4);
      if (r === 0) return ["load('data.mat');"];
      if (r === 1) return [`load('data.mat', '${n()}');`];
      if (r === 2) return [`load data.mat ${n()}`];
      return ['S = load(\'data.mat\');', `y = S.${n()};`];
    }
    case 'global': return [`global ${n()}`];
    case 'persistent': return [`persistent ${n()}`];
    case 'nest': {
      const inner = { ...ctx, depth: depth + 1 };
      const body = () => statement(rng, inner).map((l) => `    ${l}`);
      const r = rng.int(5);
      if (r === 0) return [`if ${arg(rng)} > 0`, ...body(), ...(rng.chance(0.4) ? ['else', ...body()] : []), 'end'];
      if (r === 1) return ['for k = 1:3', ...body(), 'end'];
      if (r === 2) return ['while false', ...body(), 'end'];
      if (r === 3) return ['try', ...body(), 'catch err', ...body(), 'end'];
      return [`switch ${arg(rng)}`, "    case 'a'", ...body(), '    otherwise', ...body(), 'end'];
    }
    case 'cont': return [`y = ${callee(rng)}(1, ...`, `    ${arg(rng)});`];
    case 'block': return ['%{', `${n()}(1);`, '%}'];
    case 'shell': return [`!echo ${n()}`];
    case 'unicode': return [`disp('${rng.pick(['héllo', 'Größe', 'µm', '日本', 'naïve'])}'); % ${rng.pick(['café', 'ü'])}`];
    case 'comment': return [`% ${n()}(1) is ${rng.pick(['called', 'not called'])} here`];
    case 'indexAssign': return [`${n()}(2) = 3;`];
    case 'cellfun': return [`c = ${rng.pick(['cellfun', 'arrayfun'])}(@${n()}, {1, 2});`];
    case 'self': return [rng.pick([`${ctx.obj}.${rng.pick(METHODS)}(1);`, `${rng.pick(METHODS)}(${ctx.obj});`, `y = ${ctx.obj}.${rng.pick(PROPS)};`, `${ctx.obj}.${rng.pick(PROPS)} = ${n()}(1);`])];
    case 'superCall': return [`${rng.pick(METHODS)}@${rng.pick(CLASSES)}(${ctx.obj ?? 'obj'});`];
    case 'error': return [ERROR_LINE];
    case 'wordPiece': return [rng.pick(['x = 1 2abc3 = ;', 'y = a..b(1);', 'w = [1 2 3 ...', 'disp("unterminated);', 'q = @;'])];
  }
  return ['x = 1;'];
}

function body(rng, ctx, min = 1, max = 5) {
  const out = [];
  for (let i = rng.range(min, max); i > 0; i--) out.push(...statement(rng, ctx).map((l) => `    ${l}`));
  return out;
}

export function functionFile(rng, name, opts = {}) {
  const params = opts.params ?? rng.pick(['', 'x', 'a, b', 'obj, x', 'varargin']);
  const out = rng.pick(['', 'y = ', '[y, z] = ', 'varargout = ']);
  const ends = rng.chance(0.85);
  const lines = [];
  if (rng.chance(0.3)) lines.push(`% ${name.toUpperCase()}  help text`);
  lines.push(`function ${out}${name}(${params})`);
  lines.push(...body(rng, { fn: true, obj: params.startsWith('obj') ? 'obj' : undefined }, 1, 5));
  if (ends && rng.chance(0.2)) {
    const inner = rng.pick(NAMES);
    lines.push(`    function ${inner}()`, ...body(rng, { fn: true }, 1, 2).map((l) => `    ${l}`), '    end');
  }
  if (ends) lines.push('end');
  for (let i = rng.chance(0.4) ? rng.range(1, 2) : 0; i > 0; i--) {
    lines.push('', `function ${rng.pick(['r = ', ''])}${rng.pick(NAMES)}(${rng.pick(['', 'x'])})`, ...body(rng, { fn: true }, 1, 3));
    if (ends) lines.push('end');
  }
  return lines;
}

export function scriptFile(rng) {
  const lines = [];
  for (let i = rng.range(1, 6); i > 0; i--) lines.push(...statement(rng, {}));
  return lines;
}

function classdefFile(rng, name, opts = {}) {
  const supers = opts.supers ?? superList(rng, name);
  const lines = [`classdef ${rng.chance(0.15) ? '(Abstract) ' : ''}${name}${supers ? ` < ${supers}` : ''}`];
  if (rng.chance(0.7)) {
    lines.push('    properties');
    for (const p of new Set(Array.from({ length: rng.range(1, 3) }, () => rng.pick(PROPS)))) lines.push(`        ${p}${rng.chance(0.3) ? ' = 1;' : ''}`);
    lines.push('    end');
  }
  const ctx = { fn: true, cls: name, obj: 'obj' };
  const methods = opts.methods ?? [...new Set(Array.from({ length: rng.range(0, 3) }, () => rng.pick(METHODS)))];
  if (methods.length || rng.chance(0.5)) {
    lines.push('    methods');
    if (rng.chance(0.6)) {
      lines.push(`        function obj = ${name}(x)`);
      if (supers && rng.chance(0.5)) lines.push(`            obj@${supers.split(' & ')[0].trim()}(x);`);
      lines.push(...body(rng, ctx, 0, 2).map((l) => `        ${l}`), '        end');
    }
    for (const m of methods) lines.push(`        function r = ${m}(obj${rng.chance(0.5) ? ', x' : ''})`, ...body(rng, ctx, 1, 3).map((l) => `        ${l}`), '        end');
    lines.push('    end');
  }
  if (rng.chance(0.3)) {
    lines.push('    methods (Static)', `        function r = ${rng.pick(METHODS)}(x)`, ...body(rng, { fn: true }, 1, 2).map((l) => `        ${l}`), '        end', '    end');
  }
  if (rng.chance(0.15)) lines.push('    methods (Abstract)', `        r = ${rng.pick(METHODS)}(obj)`, '    end');
  lines.push('end');
  return lines;
}

export function superList(rng, self) {
  const r = rng.next();
  if (r < 0.3) return '';
  if (r < 0.55) return 'handle';
  const others = CLASSES.filter((c) => c !== self);
  const one = rng.chance(0.2) ? `pkg.${rng.pick(CLASSES)}` : rng.pick(others);
  return rng.chance(0.2) ? `${one} & ${rng.pick(['handle', ...others])}` : one;
}

function oldStyleCtor(rng, name) {
  const parent = rng.chance(0.3) ? rng.pick(CLASSES.filter((c) => c !== name)) : null;
  return [
    `function obj = ${name}(a)`,
    '    s.x = a;',
    parent ? `    p = ${parent}(a);` : null,
    `    obj = class(s, '${name}'${parent ? ', p' : ''});`,
    'end',
  ].filter((l) => l !== null);
}

export function octaveFile(rng, name) {
  return ['## Copyright (C) 2020 Someone', `## ${name}`, `function y = ${name}(x)`, '  y = x;', `  ${rng.pick(NAMES)}(1);`, 'endfunction'];
}

export function binaryBytes(rng, size = 64) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = rng.chance(0.2) ? 0 : rng.int(256);
  return b;
}

function objcFile(name) {
  return [`#import "${name}.h"`, `@implementation ${name}`, '- (void)run {}', '@end'];
}

/** The path config: codegraph.json `matlab.startup`, a root startup.m, or neither. Returns the files to put. */
export function pathConfig(rng) {
  const lines = [];
  for (const d of PATH_DIRS) {
    if (!rng.chance(0.4)) continue;
    const r = rng.int(4);
    if (r === 0) lines.push(`addpath(genpath('${d}'));`);
    else if (r === 1) lines.push(`addpath('${d}', '-end');`);
    else if (r === 2) lines.push(`addpath(fullfile(pwd, '${d}'));`);
    else lines.push(`addpath('${d}');`);
  }
  if (rng.chance(0.15)) lines.push("rmpath('lib/sub');");
  const r = rng.next();
  if (r < 0.3) return {};
  const exclude = rng.chance(0.25) ? [rng.pick(['off/**', 'tools/x/**', 'lib/sub/**'])] : undefined;
  if (r < 0.8) {
    const cfg = { matlab: { startup: lines } };
    if (exclude) cfg.exclude = exclude;
    if (rng.chance(0.1)) cfg.matlab.cwd = rng.pick(['lib', 'tools']);
    return { 'codegraph.json': JSON.stringify(cfg, null, 2) + '\n' };
  }
  return { 'startup.m': lines.join('\n') + '\n' };
}

/** Applies the text oddities to one file's lines: CRLF, a BOM, trailing whitespace. */
export function render(rng, lines) {
  let text = lines.join('\n') + '\n';
  if (rng.chance(0.08)) text = text.replace(/\n/g, '\r\n');
  if (rng.chance(0.05)) text = '﻿' + text;
  return text;
}

/** One random MATLAB-ish file (path and content) to add to `files`. */
export function randomFile(rng, files) {
  const kind = rng.weighted({ fn: 8, script: 3, classdef: 3, classFolder: 2, octave: 0.4, binary: 0.3, stub: 0.5, objc: 0.3, empty: 0.2 });
  const folder = rng.weighted(FOLDERS);
  const at = (name) => (folder ? `${folder}/${name}.m` : `${name}.m`);
  switch (kind) {
    case 'fn': {
      const name = rng.pick(NAMES);
      return [at(name), render(rng, functionFile(rng, rng.chance(0.93) ? name : rng.pick(NAMES)))];
    }
    case 'script': return [at(rng.pick(NAMES)), render(rng, scriptFile(rng))];
    case 'classdef': {
      const name = rng.pick(CLASSES);
      const dir = rng.weighted({ '': 4, lib: 1, '+pkg': 1.5, tools: 0.5 });
      return [dir ? `${dir}/${name}.m` : `${name}.m`, render(rng, classdefFile(rng, name))];
    }
    case 'classFolder': {
      const cls = rng.pick(CLASSES);
      const base = `${rng.weighted({ '': 4, lib: 1, '+pkg/': 1 }).replace(/^lib$/, 'lib/')}@${cls}`;
      const existing = Object.keys(files).some((p) => p.startsWith(`${base}/${cls}.m`));
      if (!existing && rng.chance(0.6)) return [`${base}/${cls}.m`, render(rng, rng.chance(0.5) ? oldStyleCtor(rng, cls) : classdefFile(rng, cls, { supers: rng.chance(0.5) ? '' : 'handle' }))];
      const m = rng.pick(METHODS);
      if (rng.chance(0.15)) return [`${base}/${m}.m`, render(rng, scriptFile(rng))]; // a method-less file
      if (rng.chance(0.1)) return [`${base}/private/${rng.pick(NAMES)}.m`, render(rng, functionFile(rng, rng.pick(NAMES)))];
      return [`${base}/${m}.m`, render(rng, functionFile(rng, m, { params: rng.pick(['obj', 'obj, x', 'x, obj']) }))];
    }
    case 'octave': { const name = rng.pick(NAMES); return [at(name), render(rng, octaveFile(rng, name))]; }
    case 'binary': return [at(rng.pick(NAMES)), binaryBytes(rng, rng.range(16, 200))];
    case 'stub': { const name = rng.pick(NAMES); return [at(name), `% ${name.toUpperCase()}  help for a MEX function\n%   y = ${name}(x)\n`]; }
    case 'objc': { const name = rng.pick(CLASSES); return [`${name}.m`, render(rng, objcFile(name))]; }
    default: return [at(rng.pick(NAMES)), ''];
  }
}

/** A big file for the robustness modes: broken text or deep nesting, to `kb` kilobytes. */
export function bigFile(rng, mode, kb) {
  const lines = [];
  const target = kb * 1024;
  let size = 0;
  const push = (l) => { lines.push(l); size += l.length + 1; };
  if (mode === 'deep') {
    const depth = rng.range(60, 400);
    push('function deep(x)');
    for (let i = 0; i < depth; i++) push(`${' '.repeat(i % 40)}${rng.pick(['if x > 0', 'for k = 1:2', 'while x', 'try'])}`);
    push(`y = ${'('.repeat(rng.range(50, 300))}x${')'.repeat(rng.range(50, 300))};`);
    push(`z = ${'[{'.repeat(80)}1${'}]'.repeat(80)};`);
    for (let i = 0; i < depth; i++) push('end');
    while (size < target) for (const l of statement(rng, { fn: true })) push(l);
    push('end');
  } else {
    while (size < target) {
      const r = rng.next();
      if (r < 0.5) for (const l of statement(rng, { fn: true })) push(l);
      else if (r < 0.7) push(rng.pick([ERROR_LINE, 'end', 'function', 'classdef', 'methods', "'", '"', '%{', '...', '@', '[', ')', '}']));
      else if (r < 0.85) push(Array.from({ length: rng.range(1, 40) }, () => String.fromCharCode(rng.range(32, 126))).join(''));
      else push(`${rng.pick(NAMES)}${'.'.repeat(rng.range(1, 3))}${rng.pick(NAMES)}${rng.pick(['(', '{', '@', ' ', ''])}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * A motif: a few files wired together so that an interaction a sync must
 * track is likely (random files alone rarely line them up): a class chain
 * with two copies of its middle class, a class folder whose method calls
 * another of its methods in function syntax (with a base class that has it
 * too), a function called under two cases of its name, or a script or stub
 * with a farther copy behind an `-end` path entry (which answers once the
 * nearer copy is no MATLAB, and gives the calls back when it is again). The
 * mutator then moves, removes and rewrites them like any file.
 */
export function motif(rng, files) {
  const kind = rng.pick(['chain', 'classFolder', 'caseVariant', 'farCopy']);
  if (kind === 'farCopy') {
    const name = rng.pick(['helper', 'setup', 'util', 'data']);
    const near = rng.pick(['', 'app/']);
    const script = () => render(rng, [`${rng.pick(NAMES)} = ${rng.pick(['1', "'t'"])};`]);
    const stub = () => `% ${name.toUpperCase()}  help for a MEX function\n%   y = ${name}(x)\n`;
    putFile(files, `${near}${name}.m`, rng.chance(0.5) ? script() : stub());
    putFile(files, `lib/${name}.m`, rng.chance(0.5) ? script() : stub());
    delete files['startup.m'];
    putFile(files, 'codegraph.json', JSON.stringify({ matlab: { startup: [...(near ? ["addpath('app');"] : []), "addpath('lib', '-end');"] } }, null, 2) + '\n');
    const caller = rng.pick(['main', 'run_all']);
    putFile(files, `${near}${caller}.m`, render(rng, [`function ${caller}(x)`, `    ${name}`, `    y = ${name}(x);`, 'end']));
    return kind;
  }
  const m = rng.pick(METHODS);
  if (kind === 'chain') {
    const [a, b] = rng.chance(0.5) ? ['', 'lib/'] : ['lib/', 'tools/'];
    putFile(files, 'Base.m', render(rng, classdefFile(rng, 'Base', { supers: 'handle', methods: [m] })));
    // Either copy may be the one that reaches Base: the nearer one decides.
    const first = rng.pick(['Base', 'handle']);
    putFile(files, `${a}Mid.m`, render(rng, classdefFile(rng, 'Mid', { supers: first })));
    if (rng.chance(0.6)) putFile(files, `${b}Mid.m`, render(rng, classdefFile(rng, 'Mid', { supers: first === 'Base' ? rng.pick(['handle', 'Gadget']) : 'Base' })));
    putFile(files, 'Widget.m', render(rng, classdefFile(rng, 'Widget', { supers: 'Mid' })));
    putFile(files, `${rng.pick(NAMES)}.m`, render(rng, [`w = Widget(${rng.pick(['', '1'])});`, `w.${m}(1);`, `${m}(w);`]));
    return kind;
  }
  if (kind === 'classFolder') {
    const cls = rng.pick(['Widget', 'Gadget']);
    const dir = `${rng.pick(['', 'lib/'])}@${cls}`;
    putFile(files, `${dir}/${cls}.m`, render(rng, rng.chance(0.5)
      ? [`classdef ${cls} < Base`, '    methods', `        function obj = ${cls}()`, '        end', '    end', 'end']
      : oldStyleCtor(rng, cls)));
    putFile(files, `${dir}/walk.m`, render(rng, ['function walk(obj)', `    ${m}(obj);`, '    y = obj;', `    ${m}(y);`, 'end']));
    const r = rng.int(4);
    putFile(files, `${dir}/${m}.m`, r === 0 ? render(rng, [`function r = ${m}(obj)`, '    r = 1;', 'end']) : r === 1 ? `% ${m.toUpperCase()}  help text only
` : r === 2 ? render(rng, octaveFile(rng, m)) : render(rng, ['x = 1;']));
    putFile(files, 'Base.m', render(rng, classdefFile(rng, 'Base', { supers: 'handle', methods: [m] })));
    return kind;
  }
  const name = rng.pick(['helper', 'util', 'step']);
  putFile(files, `${rng.pick(['', 'lib/'])}${name}.m`, render(rng, [`function y = ${name}(x)`, '    y = x;', 'end']));
  const upper = name[0].toUpperCase() + name.slice(1);
  putFile(files, `${rng.pick(NAMES)}.m`, render(rng, [`${upper}(1);`, `${name}(1);`, `${upper}`]));
  if (rng.chance(0.4)) putFile(files, `tools/${upper}.m`, render(rng, [`function y = ${upper}(x)`, '    y = 2;', 'end']));
  return kind;
}

/**
 * The 'classes' profile's motif: a class folder's code calling a method in
 * function syntax on an object of no stated class (step 9's marked guess:
 * `kids(t, 1)` in `@Node/show.m`), the base class that has the method, and
 * by chance the class folder's own file of the method's name (a method, help
 * text, Octave, or nothing) and a class chain below `Node` with a copy of its
 * middle class ahead on the path. The path puts `app/` and `lib/` on it, `lib/`
 * ahead.
 */
export function guessMotif(rng, files) {
  const m = rng.pick(['kids', 'nodes', 'grow', 'leaves']); // no built-in's name: the guess skips those
  delete files['startup.m'];
  putFile(files, 'codegraph.json', JSON.stringify({ matlab: { startup: ["addpath('app');", "addpath('lib');"] } }, null, 2) + '\n');
  putFile(files, 'lib/Base.m', render(rng, ['classdef Base < handle', '    methods', `        function c = ${m}(obj, uid)`, '            c = uid;', '        end', '    end', 'end']));
  putFile(files, 'app/@Node/Node.m', render(rng, ['classdef Node < Base', '    methods', '        show(obj, h)', '    end', 'end']));
  putFile(files, 'app/@Node/show.m', render(rng, ['function show(obj, h)', "    t = getappdata(h, 'tree');", `    c = ${m}(t, 1);`, 'end']));
  const own = rng.int(7); // 4–6: no own file (the guess answers; an edit may add one in front of it)
  if (own === 0) putFile(files, `app/@Node/${m}.m`, render(rng, [`function c = ${m}(obj, uid)`, '    c = 3;', 'end']));
  else if (own === 1) putFile(files, `app/@Node/${m}.m`, `% ${m.toUpperCase()}  help text only\n`);
  else if (own === 2) putFile(files, `app/@Node/${m}.m`, render(rng, [`function c = ${m}(obj, uid)`, '    c = 3;', 'endfunction']));
  else if (own === 3) putFile(files, `app/@Node/${m}.m`, '');
  if (rng.chance(0.6)) {
    putFile(files, 'app/Mid.m', render(rng, ['classdef Mid < Node', 'end']));
    putFile(files, 'lib/Other.m', render(rng, ['classdef Other < Mid', '    methods', `        function c = ${m}(obj, uid)`, '            c = 2;', '        end', '    end', 'end']));
    if (rng.chance(0.5)) putFile(files, 'lib/Mid.m', render(rng, [`classdef Mid < ${rng.pick(['handle', 'Gadget'])}`, 'end']));
  }
}

/**
 * A random project of about 3–30 files. `opts.big`: also one big file
 * ('deep' nesting or 'broken' text) of `opts.kb` kilobytes. `opts.profile`
 * 'classes' adds guessMotif (the default profile's draws are unchanged by it).
 */
export function generateProject(rng, opts = {}) {
  const files = {};
  for (const [p, c] of Object.entries(pathConfig(rng))) putFile(files, p, c);
  const count = rng.range(opts.minFiles ?? 3, opts.maxFiles ?? 30);
  for (let i = 0; Object.keys(files).length < count && i < count * 3; i++) {
    const [p, c] = randomFile(rng, files);
    if (p === 'codegraph.json' || p === 'startup.m') continue;
    putFile(files, p, c);
  }
  if (opts.motifs !== false && rng.chance(0.4)) motif(rng, files);
  if (opts.profile === 'classes') guessMotif(rng, files);
  if (opts.big) putFile(files, `${rng.pick(['', 'lib/'])}big_${opts.big}.m`, bigFile(rng, opts.big, opts.kb ?? 200));
  return files;
}
