/**
 * The MATLAB fuzzer's mutator: from a project's current files, a seeded random
 * edit — `{ desc, edit }`, where `edit` maps a path to its new content (text or
 * a Buffer) or to `null` (delete it). Edits are concrete, so a recorded
 * sequence replays (and shrinks) without the random source.
 *
 * Kinds: add, remove, rename, move or copy a file (into or out of private/,
 * @C/, +pkg/, on or off the path; a copy is a shadow ahead of the file or one
 * behind it, a class copy often with another superclass list); turn a class
 * folder's file into a method, help text, Octave, a script or nothing; turn a
 * file with a farther copy into a script, help text, Octave or a function;
 * change codegraph.json or startup.m; rewrite a
 * line (a call into an assignment or back, another name, a new or deleted
 * line); make a parse error appear or disappear; change a superclass list or
 * a class's methods; toggle the case of a name; and the text oddities.
 */
import { CLASSES, ERROR_LINE, METHODS, NAMES, PATH_DIRS, binaryBytes, canonicalPath, functionFile, octaveFile, pathConfig, randomFile, render, scriptFile, statement, superList } from './generate.mjs';

const isText = (c) => typeof c === 'string';
const matlabText = (files) => Object.keys(files).filter((p) => p.endsWith('.m') && isText(files[p]) && !files[p].includes('@implementation'));
const nl = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const splitLines = (text) => text.split(/\r?\n/);

/** Every case variant of `rel` but itself is gone, and `rel` holds `content`: one edit, deletes first. */
function put(files, rel, content, extra = {}) {
  // Folders spelled as the files that stay spell them (the moved file's own old path aside).
  const rest = Object.fromEntries(Object.entries(files).filter(([k]) => !(k in extra)));
  rel = canonicalPath(rest, rel);
  const edit = {};
  for (const k of Object.keys(files)) if (k !== rel && k.toLowerCase() === rel.toLowerCase()) edit[k] = null;
  return Object.assign(edit, extra, { [rel]: content });
}

const toggleCase = (s) => (s[0] === s[0].toUpperCase() ? s[0].toLowerCase() : s[0].toUpperCase()) + s.slice(1);

/** Folders a file may move to. */
const MOVE_DIRS = ['', 'lib', 'lib/sub', 'tools', 'tools/x', 'off', 'private', 'lib/private', '+pkg', '+pkg/+sub', '+pkg/private', '@Widget', '@Base', '+pkg/@Gadget', 'lib/@Mid'];

function withLines(files, rel, f) {
  const text = files[rel];
  const eol = nl(text);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = splitLines(bom ? text.slice(1) : text);
  const out = f(lines);
  return out === null ? null : bom + out.join(eol);
}

/**
 * The file a mutation acts on: any, evenly, in the default profile; in the
 * 'classes' profile a class's file (a classdef, or one in an @-folder) weighs
 * five times as much, where the sync's class bookkeeping lives.
 */
let profile = 'default';
function pickFile(rng, paths, files) {
  if (profile !== 'classes') return rng.pick(paths);
  const isClass = (q) => /(^|\/)@/.test(q) || (typeof files[q] === 'string' && /^classdef\b/m.test(files[q]));
  return rng.weighted(Object.fromEntries(paths.map((q) => [q, isClass(q) ? 5 : 1])));
}

const MUTATIONS = {
  add(rng, files) {
    const [p, c] = randomFile(rng, files);
    return { desc: `add ${p}`, edit: put(files, p, c) };
  },
  remove(rng, files) {
    const paths = Object.keys(files);
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    return { desc: `remove ${p}`, edit: { [p]: null } };
  },
  rename(rng, files) {
    const paths = Object.keys(files).filter((p) => p.endsWith('.m'));
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    const oldName = p.slice(dir.length, -2);
    const name = rng.chance(0.3) ? toggleCase(oldName) : rng.pick([...NAMES, ...CLASSES, ...METHODS]);
    const to = `${dir}${name}.m`;
    if (to === p) return null;
    let content = files[p];
    // Mostly the function line follows the file; sometimes it keeps the old name (MATLAB goes by the file name).
    if (isText(content) && rng.chance(0.7)) content = content.replace(new RegExp(`\\b${oldName}\\b`, 'g'), name);
    return { desc: `rename ${p} -> ${to}`, edit: put(files, to, content, { [p]: null }) };
  },
  move(rng, files) {
    const paths = Object.keys(files).filter((p) => p.endsWith('.m'));
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const base = p.slice(p.lastIndexOf('/') + 1);
    const dir = rng.pick(MOVE_DIRS);
    const to = dir ? `${dir}/${base}` : base;
    if (to === p) return null;
    return { desc: `move ${p} -> ${to}`, edit: put(files, to, files[p], { [p]: null }) };
  },
  config(rng, files) {
    const r = rng.next();
    if (r < 0.2 && (files['codegraph.json'] !== undefined || files['startup.m'] !== undefined)) {
      return { desc: 'drop the path config', edit: { 'codegraph.json': null, 'startup.m': null } };
    }
    if (r < 0.45 && isText(files['codegraph.json'])) {
      // One entry more or less, or an exclude toggled.
      let cfg;
      try { cfg = JSON.parse(files['codegraph.json']); } catch { cfg = null; }
      if (cfg && cfg.matlab && Array.isArray(cfg.matlab.startup)) {
        const s = cfg.matlab.startup;
        if (s.length && rng.chance(0.5)) s.splice(rng.int(s.length), 1);
        else { const d = rng.pick(PATH_DIRS); s.splice(rng.int(s.length + 1), 0, rng.chance(0.3) ? `addpath(genpath('${d}'));` : `addpath('${d}');`); }
        if (rng.chance(0.2)) { if (cfg.exclude) delete cfg.exclude; else cfg.exclude = [rng.pick(['off/**', 'lib/sub/**', 'tools/**'])]; }
        return { desc: 'edit codegraph.json', edit: { 'codegraph.json': JSON.stringify(cfg, null, 2) + '\n' } };
      }
    }
    if (r < 0.55) return { desc: 'break codegraph.json', edit: { 'codegraph.json': '{ "matlab": { "startup": [ "addpath(\'lib\')" ' } };
    const next = pathConfig(rng);
    const edit = { 'codegraph.json': null, 'startup.m': null, ...next };
    return { desc: `new path config (${Object.keys(next).join(', ') || 'none'})`, edit };
  },
  rewriteLine(rng, files) {
    const paths = matlabText(files);
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    let desc = '';
    const content = withLines(files, p, (lines) => {
      const i = rng.int(lines.length);
      const line = lines[i];
      const indent = /^\s*/.exec(line)[0];
      const t = line.trim();
      const call = /^(\w+)\((.*)\);?$/.exec(t);
      const asg = /^(\w+)\s*=\s*(.+?);?$/.exec(t);
      const r = rng.next();
      if (call && r < 0.5) { desc = `line ${i + 1}: call -> assignment`; lines[i] = `${indent}${call[1]} = ${call[2] || '1'};`; return lines; }
      if (asg && r < 0.5 && !/^(function|classdef|properties|methods|end|if|for|while)\b/.test(t)) { desc = `line ${i + 1}: assignment -> call`; lines[i] = `${indent}${asg[1]}(${asg[2].replace(/;$/, '')});`; return lines; }
      if (r < 0.65) {
        const words = [...t.matchAll(/\b[A-Za-z]\w*\b/g)].map((m) => m[0]).filter((w) => NAMES.includes(w) || CLASSES.includes(w) || METHODS.includes(w));
        if (words.length) {
          const w = rng.pick(words);
          const to = rng.chance(0.4) ? toggleCase(w) : rng.pick([...NAMES, ...METHODS]);
          desc = `line ${i + 1}: ${w} -> ${to}`;
          lines[i] = line.replace(new RegExp(`\\b${w}\\b`), to);
          return lines;
        }
      }
      if (r < 0.85 || lines.length < 3) {
        desc = `line ${i + 1}: insert a statement`;
        lines.splice(i, 0, ...statement(rng, { fn: true }).map((l) => `${indent}${l}`));
        return lines;
      }
      desc = `line ${i + 1}: delete`;
      lines.splice(i, 1);
      return lines;
    });
    return { desc: `${p} ${desc}`, edit: { [p]: content } };
  },
  parseError(rng, files) {
    const paths = matlabText(files);
    if (!paths.length) return null;
    const withError = paths.filter((p) => files[p].includes(ERROR_LINE));
    if (withError.length && rng.chance(0.5)) {
      const p = rng.pick(withError);
      return { desc: `${p}: parse error disappears`, edit: { [p]: files[p].replace(new RegExp(`[ \\t]*${ERROR_LINE.replace(/[()]/g, '\\$&')}\\r?\\n?`), '') } };
    }
    const p = pickFile(rng, paths, files);
    const r = rng.int(3);
    const content = withLines(files, p, (lines) => {
      const i = rng.int(lines.length);
      if (r === 0) lines.splice(i, 0, ERROR_LINE);
      else if (r === 1) { const e = lines.findIndex((l) => l.trim() === 'end'); if (e >= 0) lines.splice(e, 1); else lines.splice(i, 0, 'end'); }
      else lines.splice(i, 0, rng.pick(["disp('open", 'x = [1 2', 'if', 'y = f(1))', '@@']));
      return lines;
    });
    return { desc: `${p}: parse error (${['error line', 'an end', 'broken text'][r]})`, edit: { [p]: content } };
  },
  superclass(rng, files) {
    const paths = matlabText(files).filter((p) => /^classdef\b/m.test(files[p]));
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const text = files[p];
    const m = /^classdef\s*(\([^)]*\)\s*)?(\w+)[^\r\n]*/m.exec(text);
    if (!m) return null;
    if (rng.chance(0.5)) {
      const supers = superList(rng, m[2]);
      return { desc: `${p}: superclasses -> '${supers}'`, edit: { [p]: text.replace(m[0], `classdef ${m[1] ?? ''}${m[2]}${supers ? ` < ${supers}` : ''}`) } };
    }
    // Add or remove a method.
    const fns = [...text.matchAll(/^( +)function (?:\w+ = )?(\w+)\(obj[^\r\n]*\r?\n[\s\S]*?^\1end\r?\n/gm)];
    if (fns.length && rng.chance(0.5)) {
      const f = rng.pick(fns);
      return { desc: `${p}: remove method ${f[2]}`, edit: { [p]: text.replace(f[0], '') } };
    }
    const eol = nl(text);
    const mi = text.search(/^ *methods\s*\r?$/m);
    if (mi < 0) return null;
    const at = text.indexOf('\n', mi) + 1;
    const name = rng.pick(METHODS);
    const method = [`        function r = ${name}(obj)`, ...statement(rng, { fn: true, obj: 'obj', cls: m[2] }).map((l) => `            ${l}`), '        end', ''].join(eol);
    return { desc: `${p}: add method ${name}`, edit: { [p]: text.slice(0, at) + method + text.slice(at) } };
  },
  toggleCase(rng, files) {
    const paths = Object.keys(files).filter((p) => p.endsWith('.m'));
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const parts = p.split('/');
    const i = rng.int(parts.length);
    const seg = parts[i];
    const lead = /^[@+]/.test(seg) ? seg[0] : '';
    const rest = seg.slice(lead.length);
    if (!/^[A-Za-z]/.test(rest)) return null;
    parts[i] = lead + toggleCase(rest);
    const to = parts.join('/');
    // A folder's case changes for every file in it.
    const prefix = p.split('/').slice(0, i + 1).join('/');
    if (i < p.split('/').length - 1) {
      const edit = {};
      for (const q of Object.keys(files)) if (q.startsWith(prefix + '/')) edit[q] = null;
      for (const q of Object.keys(files)) if (q.startsWith(prefix + '/')) edit[parts.slice(0, i + 1).join('/') + q.slice(prefix.length)] = files[q];
      return { desc: `folder case ${prefix} -> ${parts.slice(0, i + 1).join('/')}`, edit };
    }
    return { desc: `file case ${p} -> ${to}`, edit: put(files, to, files[p], { [p]: null }) };
  },
  text(rng, files) {
    const paths = matlabText(files);
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const t = files[p];
    const r = rng.int(5);
    if (r === 0) return { desc: `${p}: ${t.includes('\r\n') ? 'CRLF -> LF' : 'LF -> CRLF'}`, edit: { [p]: t.includes('\r\n') ? t.replace(/\r\n/g, '\n') : t.replace(/\n/g, '\r\n') } };
    if (r === 1) return { desc: `${p}: BOM ${t.startsWith('\uFEFF') ? 'removed' : 'added'}`, edit: { [p]: t.startsWith('\uFEFF') ? t.slice(1) : '\uFEFF' + t } };
    if (r === 2) return { desc: `${p}: becomes binary`, edit: { [p]: binaryBytes(rng, rng.range(16, 120)) } };
    if (r === 3) return { desc: `${p}: becomes Octave`, edit: { [p]: '## Octave\n' + t.replace(/^end\s*$/m, 'endfunction') } };
    return { desc: `${p}: wrapped in a block comment`, edit: { [p]: `%{\n${t}%}\n` } };
  },
  copy(rng, files) {
    // A second copy of a file elsewhere: a shadow ahead of it, or one behind; a class copy often with another superclass list.
    const paths = matlabText(files);
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const base = p.slice(p.lastIndexOf('/') + 1);
    const dir = rng.pick(['', 'lib', 'tools', 'off', 'lib/sub', 'private', '+pkg']);
    const to = dir ? `${dir}/${base}` : base;
    if (to.toLowerCase() === p.toLowerCase()) return null;
    let content = files[p];
    const m = /^classdef\s*(\([^)]*\)\s*)?(\w+)[^\r\n]*/m.exec(content);
    if (m && rng.chance(0.6)) {
      const supers = superList(rng, m[2]);
      content = content.replace(m[0], `classdef ${m[1] ?? ''}${m[2]}${supers ? ` < ${supers}` : ''}`);
    }
    return { desc: `copy ${p} -> ${to}`, edit: put(files, to, content) };
  },
  classFolderFile(rng, files) {
    // A class folder's file turned into a method, help text, Octave, a script or nothing (and back, by chance).
    // In the 'classes' profile it may instead be a new file named after a call the folder's code makes, which then
    // stands in front of whatever answered that call.
    const paths = Object.keys(files).filter((p) => /(^|\/)@[^/]+\/[^/]+\.m$/.test(p) && !/@([^/]+)\/\1\.m$/.test(p));
    let p;
    if (profile === 'classes' && rng.chance(0.4)) {
      const dirs = [...new Set(Object.keys(files).filter((q) => /(^|\/)@[^/]+\/[^/]+\.m$/.test(q)).map((q) => q.slice(0, q.lastIndexOf('/'))))];
      if (!dirs.length) return null;
      const dir = rng.pick(dirs);
      const called = new Set();
      for (const q of Object.keys(files)) {
        if (!q.startsWith(dir + '/') || typeof files[q] !== 'string') continue;
        for (const c of files[q].matchAll(/\b([a-z]\w*)\(/g)) if (!['function', 'if', 'while', 'for', 'getappdata', 'end'].includes(c[1])) called.add(c[1]);
      }
      const fresh = [...called].filter((c) => !Object.keys(files).some((q) => q.toLowerCase() === `${dir}/${c}.m`.toLowerCase()));
      if (!fresh.length) return null;
      p = `${dir}/${rng.pick(fresh)}.m`;
    } else {
      if (!paths.length) return null;
      p = pickFile(rng, paths, files);
    }
    const m = p.slice(p.lastIndexOf('/') + 1, -2);
    const r = rng.int(5);
    const content = r === 0 ? render(rng, functionFile(rng, m, { params: rng.pick(['obj', 'obj, x']) }))
      : r === 1 ? `% ${m.toUpperCase()}  help text only\n`
      : r === 2 ? render(rng, octaveFile(rng, m))
      : r === 3 ? render(rng, scriptFile(rng))
      : '';
    return { desc: `${p}: becomes ${['a method', 'help text', 'Octave', 'a script', 'empty'][r]}`, edit: { [p]: content } };
  },
  farCopyToggle(rng, files) {
    // A file with a farther copy of its name (another folder) turned into a script, help text, Octave or a function:
    // the farther copy answers while the nearer one is no MATLAB, and the calls must come back when it is again.
    const base = (q) => q.slice(q.lastIndexOf('/') + 1);
    const paths = matlabText(files).filter((p) => !/(^|\/)[@+]|private\//.test(p) && Object.keys(files).some((q) => q !== p && base(q) === base(p)));
    if (!paths.length) return null;
    const p = rng.pick(paths);
    const name = base(p).slice(0, -2);
    const r = rng.int(4);
    const content = r === 0 ? render(rng, scriptFile(rng))
      : r === 1 ? `% ${name.toUpperCase()}  help text only\n`
      : r === 2 ? `## Octave\n${render(rng, scriptFile(rng))}`
      : render(rng, [`function ${name}(x)`, '    y = 1;', 'end']);
    return { desc: `${p}: becomes ${['a script', 'help text', 'Octave', 'a function'][r]} (a farther copy exists)`, edit: { [p]: content } };
  },
  rewriteFile(rng, files) {
    const paths = matlabText(files);
    if (!paths.length) return null;
    const p = pickFile(rng, paths, files);
    const [, c] = randomFile(rng, files);
    return { desc: `${p}: rewritten`, edit: { [p]: isText(c) ? c : render(rng, ['x = 1;']) } };
  },
};

export const MUTATION_KINDS = Object.keys(MUTATIONS);
const WEIGHTS = { add: 3, remove: 2, rename: 2, move: 2.5, copy: 1.5, config: 1.5, rewriteLine: 5, parseError: 1.5, superclass: 2, classFolderFile: 1.2, farCopyToggle: 1.2, toggleCase: 1.5, text: 1, rewriteFile: 1 };

/** One random edit of `files` (never a no-op). `opts.profile`: 'default', or 'classes' (see pickFile). */
export function mutate(rng, files, opts = {}) {
  profile = opts.profile ?? 'default';
  for (let tries = 0; tries < 40; tries++) {
    const kind = rng.weighted(WEIGHTS);
    const out = MUTATIONS[kind](rng, files);
    if (!out) continue;
    const changes = Object.entries(out.edit).filter(([p, c]) => !sameContent(files[p], c));
    if (!changes.length) continue;
    return { kind, desc: out.desc, edit: Object.fromEntries(changes) };
  }
  return { kind: 'add', desc: 'add zz_extra.m', edit: { 'zz_extra.m': 'function zz_extra()\nend\n' } };
}

function sameContent(a, b) {
  if (a === undefined || a === null) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Buffer.from(a).equals(Buffer.from(b));
}

/** `files` with `edit` applied (a new object). */
export function applyEdit(files, edit) {
  const out = { ...files };
  for (const [p, c] of Object.entries(edit)) {
    if (c === null) delete out[p];
    else out[p] = c;
  }
  return out;
}
