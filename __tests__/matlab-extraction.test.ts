/**
 * MATLAB extraction: reading a `.m` file as MATLAB, Objective-C or Octave, and
 * what the extractor makes of MATLAB code — its symbols, and the references it
 * leaves for the resolver: what a function's frame makes of a name (its
 * variables, its own object, what a variable holds), superclass calls,
 * `catch`, lambdas, `Name=Value` arguments, imports, calls of built-ins' names,
 * class signatures and attributes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { CodeGraph } from '../src';
import { extractFromSource, preloadLanguagesForFiles } from '../src/extraction';
import { detectLanguage, getParser, isLanguageSupported } from '../src/extraction/grammars';
import { matlabPathScope } from '../src/extraction/languages/matlab-path';
import { matlabParseText } from '../src/extraction/languages/matlab-syntax';
import { MATLAB_BUILTINS, MATLAB_METHOD_ONLY_NAMES, withoutUnanswerableMatlabBuiltins, addMatlabReachableNames } from '../src/extraction/languages/matlab-builtins';
import { MATLAB_BASE_NAMES, MATLAB_METHOD_NAMES } from '../src/extraction/languages/matlab-builtin-names';
import { allEdges, edgesFrom, indexOfProject, tempDir, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** `kind:name <- from-qualified-name` of every ref a file emits, in source order. */
function allRefs(file: string, code: string): string[] {
  const r = extractFromSource(file, code, 'matlab');
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  return r.unresolvedReferences.map((u) => `${u.referenceKind}:${u.referenceName} <- ${byId.get(u.fromNodeId)?.qualifiedName}`);
}

/**
 * The same, less the bare calls of a built-in's name (`calls:numel`), which
 * the extractor emits like any other and only the resolver tells apart: see
 * 'MATLAB built-ins'.
 */
function refs(file: string, code: string): string[] {
  return allRefs(file, code).filter((r) => !(r.startsWith('calls:') && MATLAB_BUILTINS.has(r.slice(6, r.indexOf(' <- ')))));
}

/**
 * Asserts `subject` extracts about as fast as `control`, a file of the same
 * size without the shape under test: within 2.5× (a cost per name × per scope
 * makes it ~6× at these sizes; linear, ~1×). The two run interleaved and the
 * fastest of each counts, so a loaded machine slows both alike.
 */
// The bound is a ratio to a control timed in the same run, so load slows both
// sides alike; only the eight extractions' total meets the test timeout, which
// the two callers raise for a loaded machine (as the other linear-time tests do).
function expectAsFastAs(file: string, subject: string, control: string): void {
  extractFromSource(file, subject, 'matlab'); // warm up
  extractFromSource(file, control, 'matlab');
  let s = Infinity;
  let c = Infinity;
  for (let i = 0; i < 3; i++) {
    let t = performance.now();
    extractFromSource(file, subject, 'matlab');
    s = Math.min(s, performance.now() - t);
    t = performance.now();
    extractFromSource(file, control, 'matlab');
    c = Math.min(c, performance.now() - t);
  }
  expect(s / c).toBeLessThan(2.5);
}

describe('MATLAB .m detection', () => {
  it('reads MATLAB-shaped .m files as MATLAB', () => {
    expect(detectLanguage('main.m', 'function r = main(n)\n  r = n;\nend\n')).toBe('matlab');
    expect(detectLanguage('+geom/Circle.m', 'classdef Circle < handle\nend\n')).toBe('matlab');
    expect(detectLanguage('run_all.m', '% Run everything\nx = 5;\ndisp(x)\n')).toBe('matlab');
    expect(detectLanguage('setup.m', 'clc; clear all; close all\nx = 1;\n')).toBe('matlab');
    expect(detectLanguage('bom.m', '\uFEFFfunction f()\r\nend\r\n')).toBe('matlab');
    // A script of bare statements, its comments only trailing.
    expect(detectLanguage('cube7.m', 'cellsq = ones(40, 40, 40);\ncellsq(:,:,12:15) = 0;   % hollow layer\n')).toBe('matlab');
    expect(detectLanguage('make.m', "fprintf('-- compiling\\n');\nmex qsolve.c qlutx.c\n")).toBe('matlab');
    expect(isLanguageSupported('matlab')).toBe(true);
  });

  it('keeps Objective-C .m files Objective-C', () => {
    expect(detectLanguage('AppDelegate.m')).toBe('objc');
    expect(detectLanguage('AppDelegate.m', '#import "AppDelegate.h"\n@implementation AppDelegate\n@end\n')).toBe('objc');
    // A `%` format string or a C `end` variable never flips a file with an Objective-C shape.
    expect(detectLanguage('Log.m', '#include <stdio.h>\nvoid f(void) {\n  printf("%d", 1);\n}\n')).toBe('objc');
    expect(detectLanguage('Cat.m', '@interface Foo (Bar)\n- (void)baz;\n@end\n% not matlab\n')).toBe('objc');
    // Plain C with no directive at all: the extension's mapping stands.
    expect(detectLanguage('plain.m', 'int x = 1;\n')).toBe('objc');
    expect(detectLanguage('plain.m', 'NSInteger add(NSInteger a, NSInteger b) {\n  return a + b;\n}\n')).toBe('objc');
  });

  it('reads an empty .m, and one of MATLAB comments only, as MATLAB (the rulings of step 11)', () => {
    // An empty MATLAB script: empty, white space only, a BOM only.
    for (const code of ['', '\n\n', ' \t\r\n', '\uFEFF', '\uFEFF\r\n']) expect(detectLanguage('empty.m', code), JSON.stringify(code)).toBe('matlab');
    // A MATLAB script of comments: `%` lines, block comments (nested, CRLF), an unclosed `%{`.
    for (const code of [
      '% help text\n',
      '%{\nfunction y = f(x)\ny = x;\nend\n%}\n',
      '%{\r\nold code\r\n%}\r\n',
      '  %{\n%{\ninner\n%}\nouter\n%}\n',
      '%{\n#include <stdio.h>\nint x;\n',
    ]) expect(detectLanguage('notes.m', code), JSON.stringify(code)).toBe('matlab');
    // No content given: the extension's mapping stands.
    expect(detectLanguage('notes.m')).toBe('objc');
  });

  it('indexes an Objective-C project with an empty .m in it as before, and warns of nothing', async () => {
    const objc = {
      'AppDelegate.h': '#import <Foundation/Foundation.h>\n@interface AppDelegate : NSObject\n- (void)start;\n@end\n',
      'AppDelegate.m': '#import "AppDelegate.h"\n#import "Util.h"\n@implementation AppDelegate\n- (void)start {\n  utilRun(1);\n}\n@end\n',
      'Util.h': 'void utilRun(int n);\n',
      'Util.m': '#include "Util.h"\nvoid utilRun(int n) {\n  (void)n;\n}\n',
    };
    const indexOf = async (files: Record<string, string>) => {
      const root = tempDir('cg-objc-control-');
      const logged: string[] = [];
      const spies = (['warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
      try {
        writeTree(root, files);
        const cg = await CodeGraph.init(root, { index: true });
        try {
          const files_ = cg.getFiles().map((f) => `${f.path} ${f.language} ${JSON.stringify(f.errors ?? [])}`).sort();
          const nodes = cg.getFiles().flatMap((f) => cg.getNodesInFile(f.path).map((n) => `${n.filePath} ${n.kind} ${n.qualifiedName} ${n.startLine}:${n.startColumn}-${n.endLine}:${n.endColumn}`)).sort();
          return { files: files_, nodes, edges: allEdges(cg), logged };
        } finally {
          cg.close();
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    const before = await indexOf(objc);
    const after = await indexOf({ ...objc, 'Placeholder.m': '' });
    expect(before.edges.length).toBeGreaterThan(0);
    expect(after.files).toEqual([...before.files, 'Placeholder.m matlab []'].sort());
    expect(after.nodes.filter((n) => !n.startsWith('Placeholder.m '))).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
    expect(after.logged).toEqual(before.logged);
    expect(after.logged.filter((l) => /matlab|\.m\b/i.test(l))).toEqual([]);
  });

  it('honours an explicit codegraph.json mapping for .m', () => {
    expect(detectLanguage('main.m', 'function r = main(n)\nend\n', { '.m': 'objc' })).toBe('objc');
  });

  it('preloads the MATLAB grammar whenever a .m file is present', () => {
    expect(preloadLanguagesForFiles(['src/Foo.m'])).toContain('matlab');
    expect(preloadLanguagesForFiles(['src/Foo.m'], { '.m': 'objc' })).not.toContain('matlab');
  });

  it('keeps directive-only, comment-only and plain-C files Objective-C', () => {
    for (const code of [
      '#elif X\n',
      '#warning fix me\n',
      '#error nope\n',
      '#else\n',
      '#endif\n',
      '#line 10 "x.m"\n',
      '#  ifndef FOO_H\n#  define FOO_H 1\n#  endif\n',
      '# define N 10\nint x = N;\n',
      '// just a comment\n// with an ellipsis...\n',
      '/* header\n * text\n */\n',
      'int x;\n// wait...\n',
      'static int y;\n%d\n',
      'void f(void);\nend;\n',
      'struct point {\n  int x;\n};\n',
      '% x\nstruct point *p;\n',
      '#endif\n// done...\n',
    ]) {
      expect(detectLanguage('a.m', code), JSON.stringify(code)).toBe('objc');
    }
  });

  it('reads MATLAB with C-looking lines as MATLAB', () => {
    for (const code of [
      // An Octave-style comment that begins with a directive word.
      'x = linspace(0, 1, 10);\n# define the grid\ny = x.^2;\n',
      // A matrix row the old method-header rule read as `- (type)name`.
      'function m = matrow(b, c)\nm = [1 2\n-(b) c];\nend\n',
      'm = [1 2\n-(b) c];\n',
      // A directive inside a block comment is comment text.
      'function blk()\n%{\n# Heading\n#define not really\n%}\nx = 1;\nend\n',
      // Octave comments that begin like a conditional's directives (unsupported, but never Objective-C).
      'function r = f(a)\n#line up the data\nr = a;\nend\n',
      'function r = f(a)\n#else use the default\n#error out early\n#warning: slow\nr = a;\nend\n',
      'x = 1;\nif x\n#endif of the setup\n  y = 2;\nendif\n',
      'x = 1;\n#error handling below\ny = f(x);\n',
      '#warning: slow\nx = 1;\n',
      // `struct s` alone on its line is command syntax.
      '% doc\nstruct s\n',
    ]) {
      expect(detectLanguage('a.m', code), JSON.stringify(code)).toBe('matlab');
    }
  });
});

describe('Octave files (unsupported)', () => {
  const octave = {
    'hash comment': 'function r = f(a, b)\n  # compute the result first\n  r = compute(a);\nend\n',
    'endfunction': 'function r = f(a)\n  r = a;\nendfunction\n',
    'endif': 'x = 1;\nif x\n  y = g(x);\nendif\n',
    'unwind_protect': 'function f()\n  unwind_protect\n    g();\n  unwind_protect_cleanup\n    h();\n  end_unwind_protect\nend\n',
  };

  it('detect as MATLAB and give their file node only', () => {
    for (const code of Object.values(octave)) {
      expect(detectLanguage('f.m', code)).toBe('matlab');
      const r = extractFromSource('f.m', code, 'matlab');
      expect(r.nodes.map((n) => n.kind)).toEqual(['file']);
      expect(r.unresolvedReferences).toEqual([]);
    }
  });

  it('give their file node only when the parse fails at the root', () => {
    // A licence header like the usual GPL one: `if not, write to …` reads as an unclosed `if`.
    const code = [
      '## Copyright (C) 2031 A. Author',
      '##',
      '## Share and change this file freely; keep this notice with',
      '## any copy you hand on.',
      '##',
      '## It comes with no promise of any kind; if not, write to the author',
      '## for a copy of these terms.',
      '',
      '## -*- texinfo -*-',
      '## @deftypefn {Function File} {} stamp',
      '## Returns the time stamp.',
      '## @end deftypefn',
      '',
      'function t = stamp',
      '  ## days since the start',
      '  t = floor(time / 86400);',
      'endfunction',
      '',
    ].join('\n');
    expect(getParser('matlab')!.parse(code)!.rootNode.type).toBe('ERROR');
    expect(detectLanguage('stamp.m', code)).toBe('matlab');
    const r = extractFromSource('stamp.m', code, 'matlab');
    expect(r.nodes.map((n) => n.kind)).toEqual(['file']);
    expect(r.unresolvedReferences).toEqual([]);
  });

  it('leave a MATLAB file whose parse fails at the root to its frames', () => {
    // An unclosed `while`: the root is ERROR, but the file's variables still hold.
    const code = 'for k = 1:3;\n  q = Quaternion(k);\n  q.inv();\n  while readsig(k)<0.1\n';
    expect(getParser('matlab')!.parse(code)!.rootNode.type).toBe('ERROR');
    expect(refs('f.m', code)).toEqual(['calls:Quaternion <- f.m', 'calls:Quaternion::inv <- f.m', 'calls:readsig <- f.m']);
  });

  it('are known by every Octave block keyword, classdef ones included — never by a MATLAB classdef', () => {
    for (const code of [
      'function f(xs)\n  parfor i = 1:3\n    g(i);\n  endparfor\nend\n',
      'classdef Foo\n  properties\n    x\n  endproperties\n  methods\n    function r = get(obj)\n      r = obj.x;\n    endfunction\n  endmethods\nendclassdef\n',
      'classdef Col\n  enumeration\n    Red\n  endenumeration\n  events\n    Changed\n  endevents\nend\n',
    ]) {
      const r = extractFromSource('f.m', code, 'matlab');
      expect(r.nodes.map((n) => n.kind), code).toEqual(['file']);
    }
    const matlab = 'classdef Foo < handle\n  properties\n    x\n  end % properties\n  events\n    Changed\n  end\n  methods\n    function r = get(obj)\n      r = helper(obj.x);\n    end % get\n  end % methods\nend % classdef\n';
    expect(extractFromSource('Foo.m', matlab, 'matlab').nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(['file:Foo.m', 'class:Foo', 'property:x', 'method:get']);
  });

  it('are not confused with MATLAB that only mentions their syntax', () => {
    // `#` and `endfunction` inside a block comment, a `#` inside a string.
    const code = "function f()\n%{\n# heading\nendfunction\n%}\nfprintf('#%d\\n', g());\nend\n";
    expect(refs('f.m', code)).toEqual(['calls:g <- f']);
    // Block comments nest, for the extractor as for detection.
    const nested = 'function f()\n%{\n%{\n%}\n#define not really\nendif\n%}\ng();\nend\n';
    expect(detectLanguage('f.m', nested)).toBe('matlab');
    expect(refs('f.m', nested)).toEqual(['calls:g <- f']);
  });
});

describe('MATLAB text as the grammar is given it', () => {
  it('reads CRLF as LF, and a `%{` after code as a line comment in place', () => {
    // The `\r` before each `\n` goes (a run of them too); a lone `\r` stays.
    expect(matlabParseText('a = 1;\r\nb = 2;\r\r\nc\rd\n')).toBe('a = 1;\nb = 2;\nc\rd\n');
    // A `%{` with text before it ends no block: its `{` is a space, every offset kept.
    const code = 'x = 1; %{\nf(2);\n  y %{  \n%{\ng(3);\n%}\n%{ text\n';
    const read = matlabParseText(code);
    expect(read).toBe('x = 1; % \nf(2);\n  y %   \n%{\ng(3);\n%}\n%{ text\n');
    expect(read.length).toBe(code.length);
    // Text with neither is handed over as it is.
    const plain = 'function f()\n%{\nold\n%}\nend\n';
    expect(matlabParseText(plain)).toBe(plain);
  });
});

describe('MATLAB text the parser cannot read', () => {
  // Shapes of text saved as `.m`: a data table (`3170 Q7X  64.25 …` reads as the
  // number 3170, a comma the parser put in, and the command `Q7X`), a
  // readme, and a logbook line (`7) @9:15, pump off`).
  const TABLE = '     1 BEGIN         0.00     0.00    12.40\n  3170 Q7X          64.25     0.03    12.43\n  3171 Q7X          64.27     0.03    12.43\n  3172 K9           64.29     0.02    12.43\n';
  const README = 'QSOLVE  -  A front end to KNFIT for Matlab users.\n=======\n\nIt fits any model, either written as a .m(.sce) script file or as\na shared library, assuming that it yields a real vector and it needs only\ninputs as listed (see the demos).\n';
  const LOGBOOK = "pulse07-3mV-00.png, pulse07-3mV-b-00.png\n7) @9:15, pump off\nwritesig('VCX', 1);\ndrawnow\n";

  it('reads no command or bare name from a line that does not parse: a data table\'s, a readme\'s, a logbook\'s', () => {
    expect(allRefs('datatab.m', TABLE)).toEqual([]);
    // The readme's first lines hold the error (`It` breaks the parse); the
    // ones after it parse whole, as commands (`a shared library, assuming
    // that …`), and read as any command does.
    expect(allRefs('readme.m', README)).toEqual(['calls:a <- readme.m', 'calls:assuming <- readme.m', 'calls:inputs <- readme.m']);
    // The lines that parse whole keep their calls.
    expect(allRefs('logbook.m', LOGBOOK)).toEqual(['calls:writesig <- logbook.m', 'calls:drawnow <- logbook.m']);
  });

  it('keeps the calls written with arguments, the handles and the dotted calls of a broken function file', () => {
    const code = "function plotview(x)\n  figure(1);\n  7) @9:15, pump off\n  writesig('VCX', x);\n  h = @readsig;\n  Lattice.refresh(2);\n  drawnow\n  y = [1 2 3\nend\n";
    expect(allRefs('plotview.m', code)).toEqual([
      'calls:figure <- plotview',
      'calls:writesig <- plotview',
      'function_ref:readsig <- plotview',
      'calls:Lattice::refresh <- plotview',
      'calls:drawnow <- plotview',
    ]);
    // In an ERROR node (an unclosed `while` makes the root one), a call
    // written with its arguments stays, a dotted call too, and so does a
    // command on a line that parses whole.
    const swallowed = 'for k = 1:3;\n  q = Quaternion(k);\n  q.inv();\n  cleanupAll\n  while readsig(k)<0.1\n';
    expect(getParser('matlab')!.parse(swallowed)!.rootNode.type).toBe('ERROR');
    expect(allRefs('f.m', swallowed)).toEqual(['calls:Quaternion <- f.m', 'calls:Quaternion::inv <- f.m', 'calls:cleanupAll <- f.m', 'calls:readsig <- f.m']);
    // A bare name read in a condition the parser could not close goes: the
    // `if` its line starts with is a token of the error's own.
    expect(allRefs('g.m', 'function r = g(x)\n  y = (x +;\n  if isReady && readsig(x) > 1\n    q = [1 2\n  end\nend\n')).toEqual(['calls:readsig <- g.m']);
  });

  it('keeps a command or a bare read on a line that parses whole, under an error an unclosed bracket runs to the end of the file', () => {
    // `x = [1 2` never closes: the parser reads the rest of the file, the
    // next function too, as rows of that matrix inside one `ERROR`. A line
    // that parses whole in it is code (`soundchime;`); one with a token of the
    // error's own is not (`t1 = getclock;`, its `=` an error of the matrix's;
    // `soundchime;` after `end`, split into `s` and `oundchime`). The `end` the
    // error reads as a call on line 8 is a keyword, never a name (step 12).
    const code = 'function plotview(v)\ncheckforcfg;\nt0 = getclock;\nif v\n  x = [1 2\nend\nsoundchime;\nend\nfunction other()\nsoundchime;\nt1 = getclock;\nend\n';
    const refs = extractFromSource('plotview.m', code, 'matlab').unresolvedReferences.map((u) => `${u.line} ${u.referenceName}`);
    expect(refs).toEqual(['2 checkforcfg', '3 getclock', '10 soundchime']);
  });

  it('warns in terms that are true for MATLAB, and as before for other languages', () => {
    const warnings = (file: string, code: string, language: Parameters<typeof extractFromSource>[2] = 'matlab') =>
      extractFromSource(file, code, language).errors.map((e) => `${e.code} ${e.message}`);
    // A script has no symbol of its own: what parses of it is indexed.
    expect(warnings('logbook.m', LOGBOOK)).toEqual([
      'parse_error logbook.m: parts of the file could not be parsed — they are left out of the graph, and the rest of it is indexed',
    ]);
    // A function file with an error and its symbols, as before: no warning.
    expect(warnings('f.m', 'function r = f(x)\n r = g(x;\nend\n')).toEqual([]);
    expect(warnings('stamp.m', '## Copyright (C) 2000 A. Author\nfunction t = stamp\n  t = 1;\nendfunction\n')).toEqual([
      'source_not_read stamp.m: Octave source, which is not read as MATLAB — the file is indexed, but none of its code is in the graph',
    ]);
    expect(warnings('pause.m', 'Z9QPK7731TRW2200QXV0011y\u0001\u0000\u0000\u0087 pause(1)\n')).toEqual([
      'source_not_read pause.m: not MATLAB text (a binary or encrypted file) — the file is indexed, but none of its code is in the graph',
    ]);
    expect(warnings('broken.py', 'def (:\n', 'python')[0]).toContain('parse produced no symbols (tree has errors)');
  });
});

describe('MATLAB names the parser cut out of a word', () => {
  /** `type:text` of every identifier in `code`'s parse with a word character right before or after it: the pieces. */
  const pieces = (code: string): string[] => {
    const tree = getParser('matlab')!.parse(code)!;
    const out: string[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'identifier' && (/\w/.test(code[n.startIndex - 1] ?? '') || /\w/.test(code[n.endIndex] ?? ''))) out.push(`${n.parent?.type}:${code.slice(n.startIndex, n.endIndex)}`);
      for (let i = 0; i < n.childCount; i++) walk(n.child(i)!);
    };
    walk(tree.rootNode);
    tree.delete();
    return out;
  };
  /** The names of `rows` (`file:line kind:name`). */
  const names = (rows: string[]): string[] => rows.map((r) => r.slice(r.lastIndexOf(':') + 1));
  const fn = (name: string): string => `function y = ${name}(x)\ny = x;\nend\n`;

  // After bare channel names on lines of their own the
  // rest of the file is one `ERROR`, whose recovery skips a character or two
  // of each word and reads the rest as a name.
  const PVS = ['LN07Q:IX3:GAP_SET:RBV', 'LN07Q:IX3:GAP_LOW:RBV', 'LN07Q:IX3:GAP_TOP:RBV', 'LN07Q:IX3:GAP_DIP:RBV'];
  const CALLS = ["logview('LN07Q:IX3:GAP_SET:RBV');", "logview('LN07Q:IX3:GAP_TOP:RBV');  % Constant", 'figure(1);', 'clf reset', "logread('x');", "logview('y');", 'subplot(2,1,1);'];
  const BROKEN = [...PVS, ...CALLS, ''].join('\n');
  const FIXED = [...PVS.map((l) => `% ${l}`), ...CALLS, ''].join('\n');

  it('links nothing to a piece of a word and leaves no row of one, and keeps every call of the same code where it parses', async () => {
    // The shape is what the grammar makes of it: `figure` is `f` and a call of `igure`, `clf` is `cl` and `f`.
    expect(pieces(BROKEN)).toEqual(['function_call:ogview', 'function_call:igure', 'ERROR:f', 'function_call:ogread', 'function_call:ogview', 'function_call:ubplot']);
    expect(pieces(FIXED)).toEqual([]);
    const r = await indexOfProject({
      'logview_x.m': BROKEN,
      'logview_ok.m': FIXED,
      ...Object.fromEntries(['ogread', 'ogview', 'igure', 'f', 'ubplot', 'logread', 'logview'].map((n) => [`${n}.m`, fn(n)])),
    });
    // The broken file's calls of the project's functions are its own pieces: none links. The same calls that parse do.
    expect(r.edges.filter((e) => e.startsWith('logview_'))).toEqual([
      'logview_ok.m logview_ok.m -calls-> logread @ logread.m',
      ...Array<string>(3).fill('logview_ok.m logview_ok.m -calls-> logview @ logview.m'),
    ]);
    const cut = new Set(['igure', 'ogread', 'ogview', 'f', 'ubplot']);
    expect(names([...r.unresolved, ...r.dormant]).filter((n) => cut.has(n))).toEqual([]);
  });

  it('links nothing to a piece of a word in prose saved as `.m`', async () => {
    // `3kex4` lexes as the number 3 and the name `kex4`, `2_5mix` as 2 and `_5mix`, outside any `ERROR` of their own.
    const README = 'notes on 3kex4 and 2.5mix\nkexdata(Moon) => 3kex4   (drift was low)\nlog8.mat  => 2_5mix.str\n';
    expect(pieces(README)).toEqual(['function_call:kex4', 'field_expression:_5mix']);
    const r = await indexOfProject({ 'readme.m': README, 'kex4.m': fn('kex4'), '_5mix.m': fn('x5mix') });
    expect(r.edges.filter((e) => e.startsWith('readme.m'))).toEqual([]);
    expect(names([...r.unresolved, ...r.dormant]).filter((n) => n === 'kex4' || n === '_5mix')).toEqual([]);
  });

  it('takes no assignment from a piece of a word: the name it would write is still called, before it and after it', async () => {
    // `ax = 1` after a run of `*` lines: an `ERROR` holding `a`, then `x = 1`.
    const SCRIPT = '*****\n*****\nax = 1\nx(1)\n';
    // In a function an assignment makes a name its variable everywhere in it, before the assignment too.
    const FUNCTION = 'function r = notes2(v)\nx(v);\n*****\n*****\nax = 1\nr = 1;\nend\n';
    expect(pieces(SCRIPT)).toEqual(['assignment:x']);
    expect(pieces(FUNCTION)).toEqual(['assignment:x']);
    const r = await indexOfProject({ 'notes.m': SCRIPT, 'notes2.m': FUNCTION, 'x.m': fn('x') });
    expect(r.edges.filter((e) => e.startsWith('notes'))).toEqual(['notes.m notes.m -calls-> x @ x.m', 'notes2.m notes2 -calls-> x @ x.m']);
  });

  it('takes no command from a piece of a word: a `load` cut out of `qload` makes no variable of the name it lists', async () => {
    // `qload data.mat x` after a run of `*` lines: an `ERROR` holding `a`, then a command `load data.mat x`.
    const r = await indexOfProject({ 'notes3.m': '*****\n*****\nqload data.mat x\nx(1)\n', 'x.m': fn('x') });
    expect(r.edges.filter((e) => e.startsWith('notes3'))).toEqual(['notes3.m notes3.m -calls-> x @ x.m']);
  });
});

describe('MATLAB symbols and references', () => {
  it('extracts a function file: primary, local and nested functions with signatures and help', () => {
    const code = `function [out, n] = process(data, opts)
%PROCESS Clean and count the data.
%   [out, n] = process(data, opts)
    out = cleanup(data);
    n = numel(out);
    function inner()
        disp(n);
    end
end

function d = cleanup(d)
    d(isnan(d)) = [];
end
`;
    const result = extractFromSource('process.m', code, 'matlab');
    const fns = result.nodes.filter((n) => n.kind === 'function');
    const byName = Object.fromEntries(fns.map((n) => [n.name, n]));
    expect(Object.keys(byName).sort()).toEqual(['cleanup', 'inner', 'process']);
    expect(byName.process!.isExported).toBe(true);
    expect(byName.cleanup!.isExported).toBe(false);
    expect(byName.inner!.qualifiedName).toBe('process::inner');
    expect(byName.process!.signature).toBe('function [out, n] = process(data, opts)');
    expect(byName.process!.docstring).toContain('PROCESS Clean and count the data.');
  });

  it('extracts classdef: superclasses, properties, constants, method attributes, accessors', () => {
    const code = `classdef (Abstract) Account < bank.Base & handle
    properties (Access = private)
        Balance double = 0
    end
    properties (Constant)
        Fee = 1.5
    end
    methods
        function obj = Account(b)
            obj.Balance = b;
        end
        function v = get.Balance(obj)
            v = obj.Balance;
        end
        function deposit(obj, x)
            obj.validate(x);
            addlistener(obj, 'Changed', @obj.onChange);
            s = char(obj);
            t = char(s, 'line');
        end
    end
    methods (Static, Access = protected)
        function a = create()
            a = Account(0);
        end
    end
    methods (Abstract)
        r = report(obj)
    end
end
`;
    const result = extractFromSource('+bank/Account.m', code, 'matlab');
    const node = (name: string) => result.nodes.find((n) => n.name === name)!;
    expect(node('Account').kind).toBe('class');
    expect(node('Account').qualifiedName).toBe('bank::Account');
    expect(node('Account').isAbstract).toBe(true);
    expect(node('Balance').kind).toBe('property');
    expect(node('Balance').visibility).toBe('private');
    expect(node('Fee').kind).toBe('constant');
    expect(node('deposit').kind).toBe('method');
    expect(node('deposit').qualifiedName).toBe('bank::Account::deposit');
    expect(node('get.Balance').kind).toBe('method');
    expect(node('create').isStatic).toBe(true);
    expect(node('create').visibility).toBe('protected');
    expect(node('report').isAbstract).toBe(true);

    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toContain('extends:bank::Base');
    expect(refs).not.toContain('extends:handle');
    expect(refs).toContain('calls:bank::Account::validate'); // obj.validate() on the method's own object
    expect(refs).toContain('calls:bank::Account::char'); // char(obj): the class's own overload
    expect(refs).toContain('calls:char'); // char(s, 'line'): the built-in, whatever the class overloads
    expect(refs).toContain('function_ref:bank::Account::onChange'); // @obj.onChange
  });

  it('extracts enumeration classes with their members', () => {
    const result = extractFromSource('Color.m', 'classdef Color\n    enumeration\n        Red, Green\n    end\nend\n', 'matlab');
    expect(result.nodes.find((n) => n.name === 'Color')?.kind).toBe('enum');
    expect(result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name)).toEqual(['Red', 'Green']);
  });

  it('tells calls from index reads, and records handles, commands and imports', () => {
    const code = `function r = run(x)
    import geom.*
    data = loadData;
    r = data(3) + helper(x);
    [a, b] = split(x);
    c = geom.Circle(2);
    c.area();
    s = struct();
    s.items(1);
    x.items(1);
    cellfun(@transform, {a, b});
    setup_paths
end
`;
    const result = extractFromSource('run.m', code, 'matlab');
    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toEqual(expect.arrayContaining([
      'calls:loadData', // a bare name read as a value is a zero-argument call
      'calls:helper',
      'calls:split',
      'calls:geom::Circle',
      'calls:geom::Circle::area', // the variable holds what geom.Circle(…) made
      'function_ref:transform',
      'calls:setup_paths',
    ]));
    // `import geom.*` names a package, which no node stands for.
    expect(refs.filter((r) => r.startsWith('imports:'))).toEqual([]);
    // Variables are indexed, not called.
    expect(refs).not.toContain('calls:data');
    expect(refs).not.toContain('calls:x');
    expect(refs).toContain('calls:x.items'); // left to the resolver, which wants an unambiguous method
    expect(refs).not.toContain('calls:s.items'); // s = struct(): a field's value
    expect(result.nodes.find((n) => n.kind === 'import')?.name).toBe('geom.*');
  });
});

describe('MATLAB frames: each scope reads its own variables', () => {
  it('keeps a function at byte 0 and the file\'s top level apart', () => {
    // Both start at offset 0 / sit in one file: `y` is a variable of f only.
    const code = 'function f()\n    y = 1;\n    y(2);\nend\ny(2);\n';
    expect(refs('f.m', code)).toEqual(['calls:y <- f.m']);
  });

  it('extracts a big single-`methods`-block classdef in linear time', () => {
    const body = (i: number, indent: string): string[] =>
      [
        `function r = m${i}(obj, x)`,
        `    y = helper${i % 50}(x);`,
        `    obj.m${i + 1}(y);`,
        `    c = Thing(2);`,
        `    c.go(y);`,
        `    addlistener(obj, 'E', @obj.onE);`,
        `    r = y;`,
        `end`,
      ].map((l) => indent + l);
    const methods: string[] = [];
    const functions: string[] = [];
    for (let i = 0; i < 1000; i++) {
      methods.push(...body(i, '        '));
      functions.push(...body(i, ''));
    }
    const code = `classdef Big < handle\n    methods\n${methods.join('\n')}\n    end\nend\n`;
    // Quadratic in the block (a parent walk per name), these 8k lines took ~20 s.
    expectAsFastAs('Big.m', code, functions.join('\n') + '\n');
    expect(extractFromSource('Big.m', code, 'matlab').nodes.filter((n) => n.kind === 'method')).toHaveLength(1000);
  }, 120_000);

  it('extracts a function with many variables and many lambdas in linear time', () => {
    // Each lambda's frame looks its enclosing variables up, never copies them.
    const lines = (lambda: boolean): string => {
      const out = ['function big(a)'];
      for (let i = 0; i < 8000; i++) out.push(`  v${i} = cellfun(${lambda ? `@(q${i}) ` : ''}q${i} + w${i % 7}, a);`);
      return [...out, 'end', ''].join('\n');
    };
    expectAsFastAs('big.m', lines(true), lines(false));
  }, 120_000);
});

describe('MATLAB own object (self)', () => {
  const sub = `classdef Sub < Base
    methods
        function obj = Sub(L, varargin)
            render(L);
            L.helper();
            render(obj);
            obj.helper();
        end
        function onClick(~, src, evt)
            render(src);
            src.helper();
        end
        function onKey(this, evt)
            render(this);
        end
    end
    methods (Static)
        function s = make(a)
            render(a);
        end
    end
end
`;

  it('is a constructor\'s output, a method\'s first parameter, and nothing after `~` or in a static method', () => {
    expect(refs('Sub.m', sub)).toEqual([
      'extends:Base <- Sub',
      'calls:render <- Sub::Sub', // render(L): L is an argument, not the object
      'calls:L.helper <- Sub::Sub',
      'calls:Sub::render <- Sub::Sub',
      'calls:Sub::helper <- Sub::Sub',
      'calls:render <- Sub::onClick', // `~` ignores the object; src is the event source
      'calls:src.helper <- Sub::onClick',
      'calls:Sub::render <- Sub::onKey',
      'calls:render <- Sub::make',
    ]);
  });

  it('reads class-folder files the same way', () => {
    expect(refs('@Fold/cb.m', 'function cb(~, src)\n    render(src);\nend\n')).toEqual(['calls:render <- Fold::cb']);
    expect(refs('@Fold/run.m', 'function run(f, x)\n    render(f);\nend\n')).toEqual(['calls:Fold::render <- Fold::run']);
    // An old-style constructor function: its output is the object.
    expect(refs('@Poly/Poly.m', 'function p = Poly(c)\n    p.c = c;\n    show(p);\n    show(c);\nend\n')).toEqual([
      'calls:Poly::show <- Poly::Poly',
      'calls:show <- Poly::Poly',
    ]);
  });

  describe('indexed', () => {
    let root = '';
    let cg: CodeGraph;
    beforeAll(async () => {
      root = tempDir('cg-matlab-self-');
      writeTree(root, {
        'Base.m': 'classdef Base < handle\n    methods\n        function render(obj)\n        end\n        function helper(obj)\n        end\n    end\nend\n',
        // A second `helper` keeps `L.helper()` (an untyped variable) ambiguous.
        'Other.m': 'classdef Other < handle\n    methods\n        function helper(obj)\n        end\n    end\nend\n',
        'Sub.m': sub,
      });
      cg = await CodeGraph.init(root, { index: true });
    });
    afterAll(() => {
      cg?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('links the object\'s calls to the class hierarchy, and nothing else', () => {
      expect(edgesFrom(cg, 'Sub.m')).toEqual([
        'Sub -extends-> Base @ Base.m',
        'Sub::Sub -calls-> Base::helper @ Base.m',
        'Sub::Sub -calls-> Base::render @ Base.m',
        'Sub::onKey -calls-> Base::render @ Base.m',
      ]);
    });
  });
});

describe('MATLAB superclass calls', () => {
  const sub = `classdef Sub < Base & pkg.Other
    methods
        function obj = Sub(varargin)
            obj = obj@Base(varargin{:});
            obj = obj@pkg.Other();
        end
        function delete(obj)
            delete@Base(obj);
            show@pkg.Other(obj, 1);
        end
    end
end
`;

  it('reads `m@Super(obj)` as Super\'s method and `obj@Super(…)` as its constructor', () => {
    expect(refs('Sub.m', sub)).toEqual([
      'extends:Base <- Sub',
      'extends:pkg::Other <- Sub',
      'calls:Base::Base <- Sub::Sub',
      'calls:pkg::Other::Other <- Sub::Sub',
      'calls:Base::delete <- Sub::delete',
      'calls:pkg::Other::show <- Sub::delete',
    ]);
  });

  describe('indexed', () => {
    let root = '';
    let cg: CodeGraph;
    beforeAll(async () => {
      root = tempDir('cg-matlab-super-');
      writeTree(root, {
        'Base.m': 'classdef Base < handle\n    methods\n        function obj = Base(varargin)\n        end\n        function delete(obj)\n        end\n    end\nend\n',
        // No explicit constructor: MATLAB's default one is the class itself.
        '+pkg/Other.m': 'classdef Other < handle\n    methods\n        function show(obj, n)\n        end\n    end\nend\n',
        'Sub.m': sub,
      });
      cg = await CodeGraph.init(root, { index: true });
    });
    afterAll(() => {
      cg?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('reaches the superclass, never the calling method itself', () => {
      expect(edgesFrom(cg, 'Sub.m')).toEqual([
        'Sub -extends-> Base @ Base.m',
        'Sub -extends-> pkg::Other @ +pkg/Other.m',
        'Sub::Sub -calls-> Base::Base @ Base.m',
        'Sub::Sub -instantiates-> pkg::Other @ +pkg/Other.m',
        'Sub::delete -calls-> Base::delete @ Base.m',
        'Sub::delete -calls-> pkg::Other::show @ +pkg/Other.m',
      ]);
    });
  });
});

describe('MATLAB statements the grammar folds into another node', () => {
  it('takes a `catch` error variable only from the `catch` line', () => {
    const code = `function f()
    try
        risky();
    catch
        cleanupAll
    end
    try
        risky();
    catch % recover
        cleanupAll
    end
    try
        risky();
    catch ME
        report(ME);
    end
    cleanupAll();
    ME(1);
end
`;
    expect(refs('f.m', code)).toEqual([
      'calls:risky <- f',
      'calls:cleanupAll <- f', // the statement after a bare `catch`, command syntax
      'calls:risky <- f',
      'calls:cleanupAll <- f',
      'calls:risky <- f',
      'calls:report <- f',
      'calls:cleanupAll <- f', // not taken for a variable by the catches above
    ]);
  });

  it('scopes a lambda\'s parameters to the lambda', () => {
    const code = 'function f(xs)\n    ys = arrayfun(@(helperB) helperB + offset, xs);\n    helperB(3);\nend\n';
    expect(refs('f.m', code)).toEqual(['calls:offset <- f', 'calls:helperB <- f']);
  });

  it('lets a lambda parameter hide the own object, a variable\'s class and a struct of the same name', () => {
    const code = `classdef K < handle
    methods
        function run(obj, xs)
            arrayfun(@(obj) obj.update(), xs);
            arrayfun(@(obj) numel(obj), xs);
            c = Shape(2);
            cellfun(@(c) c.perimeter(), xs);
            s.area = 1;
            cellfun(@(s) s.area(), xs);
            cellfun(@(q) obj.update() + c.perimeter() + s.area(), xs);
        end
    end
end
`;
    expect(refs('K.m', code)).toEqual([
      'calls:obj.update <- K::run', // the lambda's obj, not run's own object
      'calls:Shape <- K::run',
      'calls:c.perimeter <- K::run',
      'calls:s.area <- K::run',
      // Names the lambda does not take keep what the method says of them.
      'calls:K::update <- K::run',
      'calls:Shape::perimeter <- K::run',
    ]);
  });

  it('reads `Name=Value` arguments as names, their values as reads', () => {
    expect(refs('f.m', 'function f(x)\n    go(x, Solver=1, Tol=tolerance);\nend\n')).toEqual([
      'calls:go <- f',
      'calls:tolerance <- f',
    ]);
  });

  it('reads a bare name as a condition or a `for` range as a zero-argument call, and a variable there as nothing', () => {
    const code = `function r = f(x)
    items = 3;
    if isReady
        r = 1;
    elseif isOther
        r = 2;
    end
    while keepGoing
        r = 3;
    end
    switch pickMode
        case 1
            r = 4;
        case caseName
            r = 5;
        case {caseCell, 3}
            r = 6;
        case items
            r = 7;
    end
    for k = getRange
        r = k;
    end
    parfor j = getChunks
        r = j;
    end
    for k = 1:upper_bound
    end
    if x
    end
    while r
    end
    for k = items
    end
end
`;
    expect(refs('f.m', code)).toEqual([
      'calls:isReady <- f',
      'calls:isOther <- f',
      'calls:keepGoing <- f',
      'calls:pickMode <- f',
      'calls:caseName <- f',
      'calls:caseCell <- f',
      'calls:getRange <- f',
      'calls:getChunks <- f',
      'calls:upper_bound <- f',
    ]);
    // In a script, the same: the loop variable is assigned, the range is read.
    expect(refs('s.m', 'if isReady\nend\nfor k = getRange\ndisp(k);\nend\n')).toEqual(['calls:isReady <- s.m', 'calls:getRange <- s.m']);
  });
});

describe('MATLAB method calls on variables', () => {
  it('emits nothing for a field the function fills in or a struct it builds, and keeps an object\'s method', () => {
    const code = `function f(p)
    s.predict = @(v) v * 2;
    y = s.predict(3);
    cfg = struct('predict', @sin);
    z = cfg.predict(3);
    r = makeRobot();
    r.gain = 2;
    r.step();
    p.predict(1);
end
`;
    expect(refs('f.m', code)).toEqual([
      'function_ref:sin <- f',
      'calls:makeRobot <- f',
      'calls:r.step <- f', // setting r.gain says nothing about r.step
      'calls:p.predict <- f',
    ]);
  });

  it('counts an indexed field assignment and a multi-output field as fields the function fills in', () => {
    const code = `function f(p)
    p.data(3) = 1;
    p.data(1);
    [s.a, s.b] = deal(1, 2);
    s.a(1);
    s.c(1);
end
`;
    expect(refs('f.m', code)).toEqual([
      // s is a variable (no `s::a` package path); only its unfilled field is left to the resolver.
      'calls:s.c <- f',
    ]);
  });
});

describe('MATLAB imports', () => {
  it('records `import pkg.*` as an import node only, and `import pkg.Cls` as a ref too', () => {
    const code = 'function f()\n    import geom.*\n    import geom.Circle\nend\n';
    const r = extractFromSource('f.m', code, 'matlab');
    expect(r.nodes.filter((n) => n.kind === 'import').map((n) => n.name)).toEqual(['geom.*', 'geom.Circle']);
    expect(refs('f.m', code)).toEqual(['imports:geom::Circle <- f']);
  });
});

describe('MATLAB built-ins', () => {
  it('records a bare call of a built-in\'s name like any other call, and one on an object of a known class as that class\'s', () => {
    const code = `classdef K < handle
    methods
        function r = go(obj, x)
            n = numel(x) + pi;
            k = numel(obj);
            h = @size;
            figure; hold on
            set(gca, 'XLim', [0 1]);
            set(obj, 'x', 1);
        end
    end
end
`;
    // Whether a project function of the name is what one reaches is the resolver's to say.
    expect(allRefs('K.m', code)).toEqual([
      'calls:numel <- K::go',
      'calls:pi <- K::go',
      'calls:K::numel <- K::go',
      'function_ref:size <- K::go',
      'calls:figure <- K::go',
      'calls:hold <- K::go',
      'calls:set <- K::go',
      'calls:gca <- K::go',
      'calls:K::set <- K::go',
    ]);
  });

  it('keeps a built-in call whose first argument holds a known class, as a call on that class (its overload may be the target)', () => {
    const code = 'function f(x)\n    c = Shape(2);\n    disp(c);\n    numel(c);\n    area(c);\n    disp(x);\n    numel(x, 2);\nend\n';
    const r = extractFromSource('f.m', code, 'matlab');
    // The written name rides along: MATLAB looks it up as a function when the class has no such method.
    expect(r.unresolvedReferences.map((u) => `${u.referenceName} ${JSON.stringify(u.candidates ?? null)}`)).toEqual([
      'Shape null',
      'Shape::disp ["dispatch:disp"]',
      'Shape::numel ["dispatch:numel"]',
      'Shape::area ["dispatch:area"]',
      'disp null',
      'numel null',
    ]);
  });

  it('takes no class from a built-in constructor\'s call, with arguments or without', () => {
    const code = 'function f(n)\n    x = NaN(n, 1);\n    x.fill();\n    y = Inf;\n    y.fill();\n    e = MException(\'a:b\', \'m\');\n    e.report();\n    throw(e);\n    c = Shape(2);\n    c.fill();\nend\n';
    expect(allRefs('f.m', code)).toEqual([
      'calls:NaN <- f',
      'calls:x.fill <- f',
      'calls:Inf <- f',
      'calls:y.fill <- f',
      'calls:MException <- f',
      'calls:e.report <- f',
      'calls:throw <- f',
      'calls:Shape <- f',
      'calls:Shape::fill <- f',
    ]);
  });

  it('leaves unwritten only the built-in calls no project file or function of the file could answer', () => {
    const reachable = new Set<string>();
    // A path function, a private one, a class folder's class and method file, a package member.
    addMatlabReachableNames(['stats/normpdf.m', 'lib/private/strsplit.m', '@AcmeObj/plot.m', '@AcmeObj/AcmeObj.m', '+uix/set.m', 'notes.txt'], reachable);
    expect([...reachable].sort()).toEqual(['AcmeObj', 'normpdf', 'strsplit']);
    const kept = (file: string, code: string): string[] => {
      const r = extractFromSource(file, code, 'matlab');
      return withoutUnanswerableMatlabBuiltins(r.unresolvedReferences, r.nodes, reachable).map((u) => `${u.referenceKind}:${u.referenceName}`);
    };
    // plot is a method of AcmeObj only, set a package's: no bare call reaches either; grid is the file's own.
    // A handle to a built-in goes the way its call does.
    expect(kept('a.m', 'function a(x)\nnormpdf(x); strsplit(x); plot(x); set(x); grid(x); mine(x); h = @plot;\ng = @grid; k = @normpdf; m = @isempty; o = @mine;\nend\nfunction grid(x)\nend\n')).toEqual([
      'calls:normpdf', 'calls:strsplit', 'calls:grid', 'calls:mine', 'function_ref:grid', 'function_ref:normpdf', 'function_ref:mine',
    ]);
    // An import may reach a package's function or a class's method by its bare name: all are kept.
    expect(kept('b.m', 'function b(x)\nimport uix.*\nset(x);\nplot(x);\nend\n')).toEqual(['calls:set', 'calls:plot']);
    // Java's reaches none.
    expect(kept('c.m', 'function c(x)\nimport java.util.*\nimport javax.swing.JFrame\nplot(x);\nmine(x);\nend\n')).toEqual(['calls:mine']);
    // An import keeps the handles too.
    expect(kept('d.m', 'function d(x)\nimport uix.*\nh = @set;\nend\n')).toEqual(['function_ref:set']);
    // Core and toolbox names: a timer's start, strings, signal processing, Simulink.
    expect(kept('e.m', 'function e(x)\nstart(x); strlength(x); pwelch(x); firpm(x); get_param(x); mine(x);\nend\n')).toEqual(['calls:mine']);
  });

  it('records how each bare name is written: with arguments, bare, or as a statement of its own', () => {
    const code = [
      't = f(x);', 't = g (x);', 't = h();', 't = cfg;', 'setup_paths', 'hold on', 'if ok, init_a, end',
      'try', '  a = 1;', 'catch', '  cleanupAll', 'end', 'run setup_b', "run('setup_c.m');", "z = run('setup_d');",
      'y = [p (q)];', 'k = Shape(2); area(k);', 'w = Archive; w.getData();', 'init_e ;',
    ].join('\n');
    const r = extractFromSource('s.m', `${code}\n`, 'matlab');
    expect(r.unresolvedReferences.map((u) => `${u.line} ${u.referenceName} ${JSON.stringify(u.candidates ?? null)}`)).toEqual([
      '1 f null', '1 x ["bare"]', '2 g null', '2 x ["bare"]', '3 h null', '4 cfg ["bare"]', '5 setup_paths ["statement"]', '6 hold ["bare"]',
      '7 ok ["bare"]', '7 init_a ["statement"]', '11 cleanupAll ["statement"]',
      '13 run ["bare"]', '13 setup_b ["statement"]', '14 run null', '14 setup_c ["statement"]', '15 run null', '15 setup_d ["bare"]',
      '16 p ["bare"]', '16 q ["bare"]',
      '17 Shape null', '17 Shape::area ["dispatch:area"]',
      '18 Archive ["bare"]', '18 Archive::getData ["variable:w.getData"]', '19 init_e ["statement"]',
    ]);
    // A notes file read as MATLAB: the parse recovers with something between the name and the list.
    const notes = extractFromSource('readme.m', 'b. test probes/correctors data rates (pollrates);\n', 'matlab');
    expect(notes.unresolvedReferences.filter((u) => u.referenceName === 'correctors').map((u) => JSON.stringify(u.candidates ?? null))).toEqual(['["bare"]']);
  });
});

describe('MATLAB built-ins: base MATLAB\'s names, generated from a MATLAB install', () => {
  const plainIdentifiersSortedOnce = (names: readonly string[]): void => {
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => !/^[A-Za-z]\w*$/.test(n))).toEqual([]);
  };

  it('are two lists, each sorted, holding each name once, and only plain identifiers, with no name in both', () => {
    plainIdentifiersSortedOnce(MATLAB_BASE_NAMES);
    plainIdentifiersSortedOnce(MATLAB_METHOD_NAMES);
    const base = new Set(MATLAB_BASE_NAMES);
    expect(MATLAB_METHOD_NAMES.filter((n) => base.has(n))).toEqual([]);
  });

  it('list as functions MATLAB has its functions and demos, never a method, a keyword, a hook, a user\'s script, a removed function or Contents', () => {
    for (const name of ['humps', 'sound', 'num2str', 'rms', 'vdp1']) expect(MATLAB_BASE_NAMES, name).toContain(name);
    for (const name of ['parse', 'add', 'startup', 'function', 'loadobj', 'printopt', 'Contents', 'SolarPanelEstimator', 'Combine']) {
      expect(MATLAB_BASE_NAMES, name).not.toContain(name);
    }
  });

  it('count a plain type\'s documented methods as functions, never a method a plain page documents for one class\'s objects', () => {
    // `double.acosd`, `cospi`, `isequaln`: they run on a number. `table.varfun`, `timetable.retime`: on their objects alone.
    for (const name of ['acosd', 'cospi', 'cummax', 'isequaln', 'pow2', 'uplus']) expect(MATLAB_BASE_NAMES, name).toContain(name);
    for (const name of ['varfun', 'retime', 'innerjoin', 'between']) expect(MATLAB_METHOD_NAMES, name).toContain(name);
    // A System object's, a HeatmapChart's and a C++ enumeration object's methods, and a class's indexing hook.
    for (const name of ['isDone', 'sortx', 'sorty', 'underlyingValue', 'listLength']) expect(MATLAB_BASE_NAMES, name).not.toContain(name);
    for (const name of ['isDone', 'sortx', 'sorty', 'underlyingValue']) expect(MATLAB_METHOD_NAMES, name).toContain(name);
  });

  it('list apart the names MATLAB has only as a method of one of its classes, which are no built-ins', () => {
    for (const name of ['parse', 'isKey', 'numedges', 'add', 'setup', 'update']) {
      expect(MATLAB_METHOD_NAMES, name).toContain(name);
      expect(MATLAB_BUILTINS.has(name), name).toBe(false);
      expect(MATLAB_METHOD_ONLY_NAMES.has(name), name).toBe(true);
    }
  });

  it('make MATLAB_BUILTINS with the names written by hand: toolboxes\' and ones MATLAB has removed', () => {
    for (const name of MATLAB_BASE_NAMES) expect(MATLAB_BUILTINS.has(name), name).toBe(true);
    for (const name of ['normpdf', 'wavread', 'fmins', 'finite', 'get_param']) {
      expect(MATLAB_BASE_NAMES, name).not.toContain(name);
      expect(MATLAB_BUILTINS.has(name), name).toBe(true);
    }
    // A hand-written name that is also only a method somewhere stays a built-in.
    expect(MATLAB_METHOD_ONLY_NAMES.has('reset')).toBe(false);
  });
});

describe('MATLAB indexing written like a call', () => {
  it('emits nothing for `x(:, k)`, `a(end)`, `b(2:end)` or `c{k}`, and keeps the calls an `end` in their arguments may not be the own of', () => {
    const code = `function f(k)
    y = x(:, 2);
    z = a(end);
    v = b(2:end, [1 end]);
    u = c{k};
    w = outer(inner(end));
    pick = pop(select(2, end));
    n = sized(end + 1 - k);
    r = runIt(@(q) q(end), k);
    p = plain(1:3, k);
    s = spread(cs{:});
    o = k.data(end);
    o = k.items{2};
    o = k.getData();
end
`;
    expect(refs('f.m', code)).toEqual([
      // An `end` in a call's arguments is the innermost array's: inner's when inner is one, else
      // outer's. Which is which nothing here says, so both are calls; so are pop and select.
      'calls:outer <- f',
      'calls:inner <- f',
      'calls:pop <- f',
      'calls:select <- f',
      'calls:runIt <- f', // q's `end` is the lambda's
      'calls:plain <- f',
      'calls:spread <- f', // `cs{:}` spreads a cell into spread's arguments
      'calls:k.getData <- f',
    ]);
  });
});

describe('MATLAB names a function indexes as only an array can be', () => {
  it('in a function, makes `c{k}` and an own `end` a variable for the whole function, and a bare `:` only its own site', () => {
    const code = `function f(t)
    plot(t, a(1,:) - a(1,1));
    n = a(end, 1);
end
function g(t)
    plot(t, b(1,1));
    v = b{2};
    w = b;
end
function h(t)
    plot(t, a(1,:) - a(1,1));
end
function k(s)
    v = s.c{2};
    w = c(1);
    x = outer(d(end));
    y = d(1);
end
`;
    expect(refs('f.m', code)).toEqual([
      // \`:\` can be what a function is passed (\`a(':')\`): a(1,:) is indexing, a(1,1) still a call.
      'calls:a <- h',
      // s.c{2} is a field's, which says nothing of c; d's \`end\` may be outer's.
      'calls:c <- k',
      'calls:outer <- k',
      'calls:d <- k',
      'calls:d <- k',
    ]);
  });

  it('in a script, at its own site only: a script\'s workspace is its caller\'s', () => {
    const code = 'plot(t, a(1,1));\nv = a{2};\nw = a;\nz = b(end);\nq = b(1);\n';
    expect(refs('s.m', code)).toEqual(['calls:t <- s.m', 'calls:a <- s.m', 'calls:a <- s.m', 'calls:b <- s.m']);
  });
});

describe('MATLAB assignment targets', () => {
  it('emits nothing for the chain an assignment writes, dynamic fields and multiple outputs included, and keeps its index reads', () => {
    const code = `function f(CF, iTeam, ii, c, y)
    CF.(iTeam).Monitor.RawToUnitParams{1}(ii, :) = c;
    CF.Q2.Level.UnitToRawParams{1}(6, :) = c;
    CF{ii}.Level.RawToUnitParams{2}(ii, :) = c;
    [st.a.b(1), m(2), q.r{3}] = deal(c);
    x(pick(y)) = 1;
    CF.(name(y)).Monitor = c;
    t = Root.Q2.Level.Params{1}(6, ii);
end
`;
    expect(refs('f.m', code)).toEqual([
      'calls:pick <- f', // an index is read
      'calls:name <- f', // so is a dynamic field's name
      // A chain read: Q2 is a field of Root, not a package of its own; Root.Q2… is indexed, nothing to call.
    ]);
  });
});

describe('MATLAB Java', () => {
  it('emits nothing for Java\'s classes, called, as a handle or imported', () => {
    const code = `function f()
    import java.util.ArrayList
    import javax.swing.*
    import geom.Circle
    s = java.lang.String('x');
    fr = javax.swing.JFrame();
    t = java.lang.System.currentTimeMillis;
    h = @java.lang.System.exit;
    l = ArrayList();
end
`;
    const r = extractFromSource('f.m', code, 'matlab');
    expect(r.nodes.filter((n) => n.kind === 'import').map((n) => n.name)).toEqual(['java.util.ArrayList', 'javax.swing.*', 'geom.Circle']);
    expect(refs('f.m', code)).toEqual(['imports:geom::Circle <- f']);
  });

  it('calls nothing of the project\'s on a Java object, nor on a class the file imports from Java', () => {
    const code = `function f(x)
    import java.util.ArrayList
    m = javax.swing.table.DefaultTableModel();
    m.setRowCount(0);
    getValueAt(m, 1, 2);
    al = ArrayList();
    al.add(x);
    n = ArrayList.valueOf(x);
    s = Shape();
    s.area();
end
function g()
    q = ArrayList;
end
`;
    expect(refs('f.m', code)).toEqual([
      // The function as written, on a Java object: no class of the project's.
      'calls:getValueAt <- f',
      'calls:Shape <- f',
      'calls:Shape::area <- f',
    ]);
    // Without the import, ArrayList is a name like any other.
    expect(refs('g.m', 'function g()\nq = ArrayList();\nend\n')).toEqual(['calls:ArrayList <- g']);
  });
});

describe('MATLAB function files', () => {
  it('names a file\'s primary function by the file, keeping the declared name in its signature', () => {
    const r = extractFromSource('lib/foo.m', 'function y = bar(x)\ny = baz(x);\nend\nfunction z = baz(x)\nz = x;\nend\n', 'matlab');
    expect(r.nodes.filter((n) => n.kind === 'function').map((n) => `${n.qualifiedName} ${n.isExported} ${n.signature}`)).toEqual([
      'foo true function y = bar(x)',
      'baz false function z = baz(x)',
    ]);
    // The extension in either case.
    for (const file of ['lib/foo.M', 'lib\\foo.m']) {
      const fn = extractFromSource(file, 'function y = bar(x)\ny = x;\nend\n', 'matlab').nodes.find((n) => n.kind === 'function');
      expect(`${fn?.qualifiedName} ${fn?.isExported}`).toBe('foo true');
    }
    const reachable = new Set<string>();
    addMatlabReachableNames(['lib/Foo.M', 'lib\\Bar.m', 'lib/baz.mm', 'lib/qux.txt'], reachable);
    expect([...reachable].sort()).toEqual(['Bar', 'Foo']);
    // A file name MATLAB cannot call keeps the declared name, and nothing outside the file reaches it.
    for (const file of ['my-tool.m', '2go.m', 'lib/go.now.m']) {
      const fn = extractFromSource(file, 'function mytool()\nend\n', 'matlab').nodes.find((n) => n.kind === 'function');
      expect(`${fn?.qualifiedName} ${fn?.isExported}`).toBe('mytool false');
    }
  });
});

describe('MATLAB classdef', () => {
  it('writes a one-line signature from a superclass list over several lines, and skips built-in bases', () => {
    const code = 'classdef (Sealed) Foo < Bar & ... first base\n        pkg.Baz & handle\nend\n';
    const r = extractFromSource('Foo.m', code, 'matlab');
    expect(r.nodes.find((n) => n.name === 'Foo')?.signature).toBe('classdef (Sealed) Foo < Bar & pkg.Baz & handle');
    expect(refs('Foo.m', code)).toEqual(['extends:Bar <- Foo', 'extends:pkg::Baz <- Foo']);
    for (const base of ['uint8', 'int32', 'double', 'single', 'logical', 'char', 'event.EventData', 'sym']) {
      expect(refs('C.m', `classdef C < ${base}\nend\n`)).toEqual([]);
    }
  });

  it('marks a method abstract only in a `methods (Abstract)` block', () => {
    const code = `classdef Pt
    methods
        d = magsq(obj)
    end
    methods (Static)
        p = origin()
    end
    methods (Abstract)
        a = area(obj)
    end
end
`;
    const nodes = extractFromSource('@Pt/Pt.m', code, 'matlab').nodes;
    const flags = (name: string) => {
      const n = nodes.find((x) => x.name === name)!;
      return { abstract: n.isAbstract === true, static: n.isStatic === true };
    };
    expect(flags('magsq')).toEqual({ abstract: false, static: false });
    expect(flags('origin')).toEqual({ abstract: false, static: true });
    expect(flags('area')).toEqual({ abstract: true, static: false });
  });

  describe('indexed', () => {
    let root = '';
    let cg: CodeGraph;
    beforeAll(async () => {
      root = tempDir('cg-matlab-bases-');
      writeTree(root, {
        'Bar.m': 'classdef Bar < handle\n    methods\n        function fromBar(obj)\n        end\n    end\nend\n',
        'Baz.m': 'classdef Baz < handle\n    methods\n        function fromBaz(obj)\n        end\n    end\nend\n',
        'Foo.m': `classdef Foo < Bar & ... base one
        Baz
    methods
        function go(obj)
            obj.fromBar();
            obj.fromBaz();
        end
    end
end
`,
      });
      cg = await CodeGraph.init(root, { index: true });
    });
    afterAll(() => {
      cg?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('finds methods inherited from every base of a multi-line list', () => {
      expect(edgesFrom(cg, 'Foo.m')).toEqual([
        'Foo -extends-> Bar @ Bar.m',
        'Foo -extends-> Baz @ Baz.m',
        'Foo::go -calls-> Bar::fromBar @ Bar.m',
        'Foo::go -calls-> Baz::fromBaz @ Baz.m',
      ]);
    });
  });
});

describe('MATLAB path scope', () => {
  it('reads packages and class folders with either separator', () => {
    expect(matlabPathScope('+a/+b/@C/m.m')).toEqual({ packages: ['a', 'b'], classFolder: 'C' });
    expect(matlabPathScope('src\\+a\\+b\\f.m')).toEqual({ packages: ['a', 'b'], classFolder: undefined });
    expect(matlabPathScope('lib/+a/x/f.m')).toEqual({ packages: [], classFolder: undefined });
  });

  it('qualifies a class-folder method\'s nested function under the method', () => {
    const r = extractFromSource('+geo/@Robot/move.m', 'function move(r)\n    inner();\n    function inner()\n    end\nend\n', 'matlab');
    expect(r.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual([
      'method geo::Robot::move',
      'function geo::Robot::move::inner',
    ]);
  });
});

describe('MATLAB nested-function workspaces (pinned: MathWorks semantics)', () => {
  it('reads a name the parent never assigns as a call, though a nested function assigns it', () => {
    // A parent's workspace holds the variables the PARENT assigns; `total`
    // here is the nested function's own, so `total` in the parent is a call.
    const outer = 'function r = outer(x)\ncompute();\nr = total + x;\n    function compute()\n        total = 42;\n    end\nend\n';
    expect(refs('outer.m', outer)).toEqual(['calls:compute <- outer', 'calls:total <- outer']);
    // Assigned in the parent: shared, a variable in both.
    const main2 = 'function r = main2(x)\nnest();\ntotal = total + x;\nr = total;\n    function nest()\n        total = 5;\n    end\nend\n';
    expect(refs('main2.m', main2)).toEqual(['calls:nest <- main2']);
    // Sibling nested functions are separate workspaces.
    const sibs = 'function sibs()\n    function A()\n        total = 1;\n    end\n    function B()\n        y = total;\n    end\nend\n';
    expect(refs('sibs.m', sibs)).toEqual(['calls:total <- sibs::B']);
  });

  it('reads a condition the parent never assigns as a call, though a nested callback sets it, and one it initializes as its variable', () => {
    // Since R2019b a nested function shares a name with its parent only when
    // the parent declares it a variable; else the parent's name is a function
    // (called when one is on the path, an error otherwise). The GUI idiom
    // initializes the flag in the parent first.
    const callback = '    function onClick(src, evt)\n        done = true;\n    end\n';
    const bare = `function wait1()\nwhile done\n    pause(1);\nend\nwhile ~done\n    pause(1);\nend\n${callback}end\n`;
    expect(refs('wait1.m', bare)).toEqual(['calls:done <- wait1', 'calls:done <- wait1']);
    const initialized = `function wait2()\ndone = false;\nwhile done\n    pause(1);\nend\nwhile ~done\n    pause(1);\nend\n${callback}end\n`;
    expect(refs('wait2.m', initialized)).toEqual([]);
  });
});
