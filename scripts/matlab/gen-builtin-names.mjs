#!/usr/bin/env node
/**
 * Regenerate src/extraction/languages/matlab-builtin-names.ts from a MATLAB
 * install:
 *
 *   node scripts/matlab/gen-builtin-names.mjs <matlabroot>
 *
 * <matlabroot> is a MATLAB installation (`/Applications/MATLAB_R2026a.app`,
 * `/usr/local/MATLAB/R2026a`). The script reads only that install: base
 * MATLAB's documentation catalog (<matlabroot>/help/docCatalog/referenceapi/
 * matlab.json) and the default search path (<matlabroot>/toolbox/local/
 * pathdef.m), of which the folders under `toolbox/matlab/` (base MATLAB,
 * installed with every MATLAB), each read alone. It writes two lists:
 *
 *   MATLAB_BASE_NAMES — the functions and classes base MATLAB has, which a
 *   bare call of the name runs wherever MATLAB's own folders come first:
 *     - a function file (`.m`, `.p`, `.mlx`, `.mlapp`, MEX) or an `@Class`
 *       folder directly in a default-path folder under `toolbox/matlab/`;
 *     - a documented function, class or object with a plain page of its own
 *       (`ref/<name>.html`), in no package;
 *   but none of (each rule's count is printed):
 *     - removed:    an entry documented as "(Removed)" (its file may still
 *                   ship, to say so when called: `printopt`);
 *     - method:     only a method of a class: MATLAB's own (`parse` of
 *                   `inputParser`, `ref/inputparser.parse.html`), one
 *                   documented on a plain page (METHOD_PAGES: a System
 *                   object's `setup`, a HeatmapChart's `sortx`), or .NET's
 *                   (`Combine`, `BeginInvoke`): MATLAB runs it only on an
 *                   object of the class. A method of a plain type's class
 *                   (FUNDAMENTAL_CLASSES: `double.acosd`, `cospi`) runs on a
 *                   number, and counts as a function;
 *     - package:    only a member of a package (`matlab.mpm.PackageIdentifier`):
 *                   no bare name reaches it;
 *     - keyword:    a word of the language documented as a function
 *                   (`function`, `persistent`, `import`);
 *     - hook:       a method a class writes for MATLAB to call (`loadobj`,
 *                   `saveobj`, `subsindex`, `listLength`, `empty`), and a script MATLAB runs
 *                   only if the user writes it (`startup`, `finish`,
 *                   `matlabrc`);
 *     - example:    a documentation example's class, live script or callback
 *                   in `toolbox/matlab/demos/` (`AgeVerificationCallback`,
 *                   `SolarPanelEstimator`, `ageCheckCB`); its demo functions
 *                   (`humps`, `vdp1`) stay;
 *     - `Contents`, a folder's help file.
 *
 *   MATLAB_METHOD_NAMES — the names MATLAB has only as a method of one of its
 *   own classes (the "method" rule's drops, but .NET's): no function of base
 *   MATLAB, so not built-ins; a bare call of one that no project symbol
 *   answers runs MATLAB's method on MATLAB's object, or fails.
 *
 * Both are sorted (by code unit), without duplicates, of plain identifiers
 * alone, and disjoint; the module is written whole.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = path.join(ROOT, 'src', 'extraction', 'languages', 'matlab-builtin-names.ts');
const IDENTIFIER = /^[A-Za-z]\w*$/;

/** Words of the language that the catalog documents as functions. */
const KEYWORDS = new Set([
  'arguments', 'break', 'case', 'catch', 'classdef', 'continue', 'else', 'elseif', 'end', 'enumeration', 'events',
  'for', 'function', 'global', 'if', 'import', 'otherwise', 'parfor', 'persistent', 'return', 'spmd', 'switch', 'try',
  'while',
]);
/** Methods a class writes for MATLAB to call, and scripts MATLAB runs only if the user writes them. */
const HOOKS = new Set([
  'loadobj', 'saveobj', 'subsindex', 'numArgumentsFromSubscript', 'listLength', 'empty', 'startup', 'finish', 'matlabrc',
]);
/**
 * Methods the catalog documents on a plain page of their own, each of one
 * class's objects alone (its first input): a System object's `setup`, `step`,
 * `reset` and `isDone`, a HeatmapChart's `sortx` and `sorty`, a C++
 * enumeration object's `underlyingValue`. No field of the catalog tells them
 * from a function whose first input is an object (`figure`, `guidata`), so
 * they are listed.
 */
const METHOD_PAGES = new Set(['setup', 'step', 'reset', 'isDone', 'sortx', 'sorty', 'underlyingValue']);
/**
 * The classes every MATLAB value of a plain type is an object of: their
 * documented methods (`ref/double.acosd.html`, `cospi`, `isequaln`) run on a
 * number, a character or a cell, as functions do, and count as functions.
 * Any other class's (`table.varfun`, `datetime.between`) runs only on its own
 * objects.
 */
const FUNDAMENTAL_CLASSES = new Set([
  'double', 'single', 'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'logical', 'char',
  'string', 'cell',
]);
/** A .NET class's method, documented on a plain page (a delegate's `Combine`, an enumeration's `bitnot`). */
const DOTNET_METHOD = /\.NET\b.*\b(?:method|delegate)\b|\bdelegate\b.*\.NET\b/i;

const root = process.argv[2];
const catalogFile = root && path.join(root, 'help', 'docCatalog', 'referenceapi', 'matlab.json');
const pathdefFile = root && path.join(root, 'toolbox', 'local', 'pathdef.m');
if (!root || !fs.existsSync(catalogFile) || !fs.existsSync(pathdefFile)) {
  console.error('usage: gen-builtin-names.mjs <matlabroot>  (a MATLAB install, with help/docCatalog and toolbox/local/pathdef.m)');
  process.exit(2);
}

const versionInfo = fs.existsSync(path.join(root, 'VersionInfo.xml')) ? fs.readFileSync(path.join(root, 'VersionInfo.xml'), 'utf8') : '';
const release = /<release>([^<]+)<\/release>/.exec(versionInfo)?.[1] ?? path.basename(root).replace(/\.app$/, '');

// The catalog's entries of each name: whether a plain page of its own documents
// it, and what kinds of entry it has otherwise.
const entries = new Map();
const entryOf = (name) => {
  let e = entries.get(name);
  if (!e) entries.set(name, (e = { plain: false, removed: false, method: false, dotnet: false, packaged: false }));
  return e;
};
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
for (const item of catalog.refItems ?? []) {
  const purpose = String(item.refpurpose ?? '');
  const page = /^ref\/([^/]+)\.html$/.exec(String(item.href ?? ''))?.[1] ?? '';
  for (const entity of item.refentity ?? []) {
    if (!['function', 'class', 'object', 'method'].includes(entity.type)) continue;
    for (const name of String(entity.name).split(/,\s*/)) {
      if (!IDENTIFIER.test(name)) continue;
      const e = entryOf(name);
      const isMethod = entity.type === 'method' || entity.fcntype === 'instancemethod' || entity.fcntype === 'staticmethod';
      const ofFundamental = page.includes('.') && FUNDAMENTAL_CLASSES.has(page.slice(0, page.indexOf('.')));
      if (purpose.startsWith('(Removed)')) e.removed = true;
      else if (DOTNET_METHOD.test(purpose)) e.dotnet = true;
      else if (ofFundamental && !item.packagename) e.plain = true;
      else if (isMethod || METHOD_PAGES.has(name)) e.method = true;
      else if (item.packagename) e.packaged = true;
      else if (page.includes('.')) e.method = true;
      else e.plain = true;
    }
  }
}

// The default path's folders under toolbox/matlab/, each read alone (pathdef lists every folder it adds).
const pathdef = fs.readFileSync(pathdefFile, 'utf8');
const folders = new Set([...pathdef.matchAll(/'(\/toolbox\/matlab\/[^':]*)[:']/g)].map((m) => m[1]));
const files = new Map();
let read = 0;
for (const folder of folders) {
  let list;
  try {
    list = fs.readdirSync(path.join(root, folder), { withFileTypes: true });
  } catch {
    continue;
  }
  read++;
  for (const e of list) {
    let name = null;
    if (e.isDirectory() && e.name.startsWith('@')) name = e.name.slice(1);
    else if (e.isFile()) name = /^([A-Za-z]\w*)\.(?:m|p|mlx|mlapp|mex\w+)$/.exec(e.name)?.[1] ?? null;
    if (name === null || !IDENTIFIER.test(name)) continue;
    if (!files.has(name)) files.set(name, []);
    files.get(name).push(path.join(root, folder, e.name));
  }
}

/** A documentation example in demos/: a class, a live script or app, or a callback (`function cb(src, event)`). */
function isExample(file) {
  if (!/\/toolbox\/matlab\/demos\//.test(file)) return false;
  if (path.basename(file).startsWith('@') || /\.(?:mlx|mlapp)$/.test(file)) return true;
  if (!file.endsWith('.m')) return false;
  const text = fs.readFileSync(file, 'utf8').replace(/^\s*%.*$/gm, '');
  if (/^\s*classdef\b/m.test(text)) return true;
  const sig = /^\s*function\b[^(\n]*\(\s*(\w+)\s*,\s*(\w+)/m.exec(text);
  return sig !== null && /^(?:src|source|hObject|h|obj|object|hSrc)$/i.test(sig[1]) && /^(?:event|eventdata|evt|eventData|e|ed)$/i.test(sig[2]);
}

const drops = { removed: 0, method: 0, package: 0, keyword: 0, hook: 0, example: 0, Contents: 0 };
const base = [];
const methods = [];
for (const name of new Set([...entries.keys(), ...files.keys()])) {
  const e = entries.get(name) ?? { plain: false, removed: false, method: false, dotnet: false, packaged: false };
  const shipped = (files.get(name) ?? []).filter((f) => !isExample(f));
  let drop = null;
  if (name === 'Contents') drop = 'Contents';
  else if (KEYWORDS.has(name)) drop = 'keyword';
  else if (HOOKS.has(name)) drop = 'hook';
  // Removed: its file may still ship, to say so when called (`printopt`).
  else if (e.removed && !e.plain) drop = 'removed';
  else if (shipped.length === 0 && files.has(name) && !e.plain) drop = 'example';
  else if (shipped.length > 0 || e.plain) drop = null;
  else if (e.method || e.dotnet) drop = 'method';
  else drop = 'package';
  if (drop === null) base.push(name);
  else {
    drops[drop]++;
    if (drop === 'method' && e.method) methods.push(name);
  }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
base.sort(byCodeUnit);
methods.sort(byCodeUnit);

const lines = (names) => {
  const out = [];
  let line = '';
  for (const n of names) {
    const item = `'${n}',`;
    if (line.length > 0 && line.length + 1 + item.length > 118) {
      out.push(line);
      line = '';
    }
    line = line.length > 0 ? `${line} ${item}` : item;
  }
  if (line.length > 0) out.push(line);
  return out.map((l) => `  ${l}`).join('\n');
};

const text = `/**
 * GENERATED by scripts/matlab/gen-builtin-names.mjs from MATLAB ${release}:
 * do not edit by hand, run the script on a MATLAB install instead (its
 * header states every rule).
 *
 * From help/docCatalog/referenceapi/matlab.json (base MATLAB's documented
 * functions, classes and methods) and the default-path folders under
 * toolbox/matlab/ in toolbox/local/pathdef.m (their function files and
 * \`@Class\` folders). Sorted, no duplicates, the two lists disjoint.
 */

/**
 * The functions and classes base MATLAB has: a function file or \`@Class\`
 * folder on its default path, or a documented one with a plain page of its
 * own; no method, package member, removed entry, keyword, hook a class or a
 * user writes (\`loadobj\`, \`startup\`), documentation example or \`Contents\`.
 * MATLAB_BUILTINS (./matlab-builtins) is this list and the hand-written names
 * together.
 */
export const MATLAB_BASE_NAMES: readonly string[] = [
${lines(base)}
];

/**
 * The names base MATLAB has only as a method of one of its own classes
 * (\`parse\` of \`inputParser\`, \`keys\` of \`containers.Map\`, \`numedges\` of
 * \`graph\`, a System object's \`setup\`): no built-ins, as MATLAB runs no
 * function of the name. See ../../resolution/matlab-failures.
 */
export const MATLAB_METHOD_NAMES: readonly string[] = [
${lines(methods)}
];
`;
fs.writeFileSync(MODULE, text);
console.log(`${release}: ${base.length} base names, ${methods.length} method names (${read} of ${folders.size} path folders read) -> ${path.relative(ROOT, MODULE)}`);
console.log(`dropped from the base names: ${Object.entries(drops).map(([k, v]) => `${k} ${v}`).join(', ')}`);
