/**
 * MATLAB argument flow: a function that calls what its caller passes
 * (`feval(basisf, S)`, `feval(varargin{:})`, `str2func(varargin{1})`,
 * `feval(cfg.taperfn, n)`, `fh(x)`, `eval(code)`) is linked to each function
 * a call of it passes there — a name looked up where the sink is, a handle
 * where it was written, code read as code run there — followed back through
 * callers that pass their own parameter on, three calls deep. Each case has
 * its silent counterpart: a value no call site settles is no edge.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import type { Edge } from '../src/types';
import { tempDir, unresolvedRows, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** `source -kind-> target @ file [param sink value registeredAt]` of every edge the argument synthesis made, sorted. */
function argumentEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const f of cg.getFiles()) {
    const ids = cg.getNodesInFile(f.path).map((n) => n.id);
    for (const e of cg.getOutgoingEdgesFrom(ids)) {
      const m = e.metadata as Record<string, unknown> | undefined;
      if (m?.synthesizedBy !== 'matlab-argument') continue;
      expect(e.provenance).toBe('heuristic');
      const t = cg.getNode(e.target)!;
      out.push(`${cg.getNode(e.source)!.qualifiedName} -${e.kind}-> ${t.qualifiedName} @ ${t.filePath} [${String(m.param)} ${String(m.sink)} ${String(m.value)} ${String(m.registeredAt)}]`);
    }
  }
  return out.sort();
}

/** `source -kind-> target :line args` of every edge that keeps a record of what its call passes, sorted. */
function argRecords(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const f of cg.getFiles()) {
    const ids = cg.getNodesInFile(f.path).map((n) => n.id);
    for (const e of cg.getOutgoingEdgesFrom(ids)) {
      const args = (e.metadata as Record<string, unknown> | undefined)?.args;
      if (args === undefined) continue;
      out.push(`${cg.getNode(e.source)!.qualifiedName} -${e.kind}-> ${cg.getNode(e.target)!.qualifiedName} :${e.line} ${JSON.stringify(args)}`);
    }
  }
  return out.sort();
}

/** What a full index of `root`'s files, copied elsewhere, makes: argument edges and records. */
async function fullIndexOf(root: string): Promise<{ edges: string[]; records: string[] }> {
  const copy = tempDir('cg-matlab-args-full-');
  try {
    fs.cpSync(root, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.codegraph`) });
    const cg = await CodeGraph.init(copy, { index: true });
    try {
      return { edges: argumentEdges(cg), records: argRecords(cg) };
    } finally {
      cg.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

/** Indexes a throwaway project: its argument edges and unresolved rows. */
async function project(files: Record<string, string>): Promise<{ edges: string[]; unresolved: string[] }> {
  const root = tempDir('cg-matlab-args-');
  try {
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      return { edges: argumentEdges(cg), unresolved: unresolvedRows(root) };
    } finally {
      cg.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A function file `name.m` that does nothing. */
const fn = (name: string): string => `function ${name}(varargin)\nend\n`;

/** The `args` fact a file's references carry, by `line name`. */
function argsFacts(file: string, code: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of extractFromSource(file, code, 'matlab').unresolvedReferences) {
    const tag = r.candidates?.find((c) => c.startsWith('args:'));
    if (tag) out[`${r.line} ${r.referenceName}`] = JSON.parse(tag.slice(5));
  }
  return out;
}

describe('MATLAB argument records', () => {
  it('records what a call passes where the code says, up to the first argument that may stand for several', () => {
    expect(argsFacts('caller.m', `function caller(a, b, varargin)
run2(a, b.c, varargin{:});
m = 'basis0';
if a, m = 'basis1'; end
cfg.taperfn = 'bellwin';
cfg.n = 3;
run1(m, @solve, cfg, 'helper(3)', 'not a name');
run3(varargin{:}, 'x');
run4(c{:}, 'x');
run5('x', q);
plot('x');
foo(1);
run6(a);
run7(a.f);
end
`)).toEqual({
      // `b.c` of a parameter may be a struct array's field, which passes several arguments: nothing from there on.
      '2 run2': { 0: 0 },
      '7 run1': { 0: ["'basis1", "'basis0"], 1: '@solve', 2: { o: { taperfn: "'bellwin" } }, 3: "'helper(3)" },
      '10 run5': { 0: "'x" },
      // After calls of the project's, `a` may be an object they changed: a field of it says nothing.
      '13 run6': { 0: { p: 0, s: 1 } },
    });
  });

  it('records a parameter passed on unchanged without a walk, and none a statement that may run a script can change', () => {
    expect(argsFacts('fwd.m', `function fwd(a, b, varargin)
helper(a, b, varargin{:});
end
`)).toEqual({ '2 helper': { 0: { p: 0, s: 1 }, 1: { p: 1, s: 1 }, 2: { r: 2, s: 1 } } });
    // Assigned on one path: the walk follows it, and it holds either.
    expect(argsFacts('fwd2.m', `function fwd2(a)
if isempty(a), a = 'x'; end
helper(a);
end
`)).toEqual({ '3 helper': { 0: ["'x", 0] } });
    expect(argsFacts('fwd3.m', `function fwd3(a)
setup_vars
helper(a);
end
`)).toEqual({});
  });
});

describe('MATLAB argument flow', () => {
  const FITMODEL = `function fmodel = fitmodel(S, Y, basisf, kernf)
F = feval(basisf, S);
end
`;

  it('links a feval of a parameter to each function the callers pass, a name looked up where the sink is, a handle where it was written', async () => {
    const { edges, unresolved } = await project({
      'fitmodel.m': FITMODEL,
      'basis0.m': fn('basis0'),
      'basis1.m': fn('basis1'),
      'use1.m': `function use1(S, Y)\nd = fitmodel(S, Y, 'basis0', 'kernexp');\nend\n`,
      // `@basis1` here names this file's own local function, not basis1.m.
      'use2.m': `function use2(S, Y)\nd = fitmodel(S, Y, @basis1, 'kernexp');\nend\nfunction f = basis1(S)\nf = 0;\nend\n`,
      // A value the caller cannot know adds nothing.
      'use3.m': `function use3(S, Y)\nr = pick();\nd = fitmodel(S, Y, r, 'kernexp');\nend\n`,
      'test/dacefit_test.m': `function dacefit_test()\nfitmodel(1, 2, 'basis0');\nend\n`,
    });
    expect(edges).toEqual([
      "fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]",
      'fitmodel -calls-> basis1 @ use2.m [basisf feval @basis1 use2.m:2]',
    ]);
    expect(unresolved).toEqual(['use3.m:2 calls:pick']);
  });

  it('prefers a production site to a test for where a value is passed', async () => {
    const { edges } = await project({
      'fitmodel.m': FITMODEL,
      'basis0.m': fn('basis0'),
      'a_test.m': `function a_test()\nfitmodel(1, 2, 'basis0');\nend\n`,
      'z.m': `function z()\nfitmodel(1, 2, 'basis0');\nend\n`,
    });
    expect(edges).toEqual(["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' z.m:2]"]);
  });

  it('follows a value back through callers that pass their own parameter on, three calls deep', async () => {
    const chain = (depth: number): Record<string, string> => {
      const files: Record<string, string> = { 'f.m': fn('f'), 'sink.m': 'function sink(x)\nfeval(x);\nend\n' };
      let callee = 'sink';
      for (let i = 1; i < depth; i++) {
        files[`hop${i}.m`] = `function hop${i}(y)\nfoo = 1;\n${callee}(y);\nend\n`;
        callee = `hop${i}`;
      }
      files['top.m'] = `function top()\n${callee}('f');\nend\n`;
      return files;
    };
    expect((await project(chain(3))).edges).toEqual(["sink -calls-> f @ f.m [x feval 'f' top.m:2]"]);
    expect((await project(chain(4))).edges).toEqual([]);
  });

  it('follows a field of a struct the caller built, and not one read after code that may change it', async () => {
    const { edges } = await project({
      // `struct(…)` builds a value and runs nothing: the field is still the caller's.
      'tk_density.m': `function tk_density(cfg, spike)
opts = struct('n', 10);
win = feval(cfg.taperfn, opts.n);
end
`,
      'zz_late.m': `function zz_late(cfg)
prepare(cfg);
win = feval(cfg.taperfn, 10);
end
`,
      'prepare.m': fn('prepare'),
      'bellwin.m': fn('bellwin'),
      'hanning.m': fn('hanning'),
      'caller.m': `function caller(spike)
cfg = [];
cfg.taperfn = 'bellwin';
tk_density(cfg, spike);
cfg.taperfn = 'hanning';
zz_late(cfg);
end
`,
    });
    expect(edges).toEqual(["tk_density -calls-> bellwin @ bellwin.m [cfg.taperfn feval 'bellwin' caller.m:4]"]);
  });

  it('links a switchyard to the local function a caller names, not a same-named one elsewhere', async () => {
    const { edges } = await project({
      'intgrid.m': `function varargout = intgrid(varargin)
[varargout{1:nargout}] = feval(varargin{:});
end
function LoadLattice(h)
end
`,
      'LoadLattice.m': fn('LoadLattice'),
      'gui.m': `function gui(h)\nintgrid('LoadLattice', h);\nend\n`,
    });
    expect(edges).toEqual(["intgrid -calls-> LoadLattice @ intgrid.m [varargin{1} feval 'LoadLattice' gui.m:2]"]);
  });

  it('links a GUIDE str2func of the first argument to the local callback a callback text names', async () => {
    const { edges } = await project({
      'mygui.m': `function varargout = mygui(varargin)
if nargin && ischar(varargin{1})
    gui_State.gui_Callback = str2func(varargin{1});
end
end
function pushbutton1_Callback(hObject, eventdata, handles)
end
`,
      'build.m': `function build()
uicontrol('Style', 'pushbutton', 'Callback', 'mygui(''pushbutton1_Callback'',gcbo,[],guidata(gcbo))');
end
`,
    });
    expect(edges).toEqual(["mygui -references-> pushbutton1_Callback @ mygui.m [varargin{1} str2func 'pushbutton1_Callback' build.m:2]"]);
  });

  it('completes a template of text around a parameter, and not one around two', async () => {
    const { edges } = await project({
      'tk_run.m': `function tk_run(method, toolbox, data)
feval(['tk_' method], data);
feval([toolbox '_' method], data);
end
`,
      'tk_foo.m': fn('tk_foo'),
      'tb_foo.m': fn('tb_foo'),
      'caller.m': `function caller(d)\ntk_run('foo', 'tb', d);\nend\n`,
    });
    expect(edges).toEqual(["tk_run -calls-> tk_foo @ tk_foo.m [method feval 'foo' caller.m:2]"]);
  });

  it('calls a handle a parameter holds, and indexes nothing for a text there', async () => {
    const { edges } = await project({
      'apply.m': `function y = apply(fh, x)
y = fh(x);
end
`,
      'g.m': fn('g'),
      'h.m': fn('h'),
      'a.m': `function a()\napply(@g, 1);\nend\n`,
      'b.m': `function b()\napply('h', 1);\nend\n`,
    });
    expect(edges).toEqual(['apply -calls-> g @ g.m [fh fh @g a.m:2]']);
  });

  it('reads code a caller passes to an eval of a parameter as code run there, and leaves no row for a name nothing answers', async () => {
    const { edges, unresolved } = await project({
      'run_code.m': `function run_code(code)
eval(code);
end
`,
      'helper.m': fn('helper'),
      'a.m': `function a()\nrun_code('helper(3)');\nrun_code('nothing_here(3)');\nend\n`,
    });
    expect(edges).toEqual(["run_code -calls-> helper @ helper.m [code eval 'helper(3)' a.m:2]"]);
    expect(unresolved).toEqual([]);
  });

  it('links nothing for a sink past the cap, a parameter assigned before it, or a nested function', async () => {
    const many: Record<string, string> = {
      'dispatch.m': 'function dispatch(name)\nfeval(name);\nend\n',
    };
    const calls: string[] = [];
    for (let i = 0; i < 41; i++) {
      many[`f${i}.m`] = fn(`f${i}`);
      calls.push(`dispatch('f${i}');`);
    }
    many['caller.m'] = `function caller()\n${calls.join('\n')}\nend\n`;
    expect((await project(many)).edges).toEqual([]);

    const { edges } = await project({
      'reassigned.m': `function reassigned(name)
name = 'fixed_one';
feval(name);
end
`,
      'outer.m': `function outer(name)
inner();
    function inner()
        feval(name);
    end
end
`,
      'nested.m': `function nested()
inner2('g');
    function inner2(n)
        feval(n);
    end
end
`,
      'g.m': fn('g'),
      'fixed_one.m': fn('fixed_one'),
      'caller.m': `function caller()\nreassigned('g');\nouter('g');\nend\n`,
    });
    expect(edges).toEqual([]);
  });

  it('follows a sync: a caller passing another name moves the edge, a deleted caller or sink takes it away', async () => {
    const root = tempDir('cg-matlab-args-sync-');
    try {
      writeTree(root, {
        'fitmodel.m': FITMODEL,
        'basis0.m': fn('basis0'),
        'basis1.m': fn('basis1'),
        'use1.m': `function use1(S, Y)\nd = fitmodel(S, Y, 'basis0');\nend\n`,
      });
      const cg = await CodeGraph.init(root, { index: true });
      try {
        expect(argumentEdges(cg)).toEqual(["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]"]);
        writeTree(root, { 'use1.m': `function use1(S, Y)\nd = fitmodel(S, Y, 'basis1');\nend\n` });
        await cg.sync();
        expect(argumentEdges(cg)).toEqual(["fitmodel -calls-> basis1 @ basis1.m [basisf feval 'basis1' use1.m:2]"]);
        writeTree(root, { 'use1.m': null });
        await cg.sync();
        expect(argumentEdges(cg)).toEqual([]);
        writeTree(root, { 'use1.m': `function use1(S, Y)\nd = fitmodel(S, Y, 'basis0');\nend\n` });
        await cg.sync();
        expect(argumentEdges(cg)).toEqual(["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]"]);
        // The callee edited: its target's id may change, the callers' records come back with their edges.
        writeTree(root, { 'fitmodel.m': `% help\n${FITMODEL}` });
        await cg.sync();
        expect(argumentEdges(cg)).toEqual(["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]"]);
        writeTree(root, { 'fitmodel.m': 'function fmodel = fitmodel(S, Y, basisf, kernf)\nF = basisf;\nend\n' });
        await cg.sync();
        expect(argumentEdges(cg)).toEqual([]);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB argument records: places nothing can count to', () => {
  it('records nothing at or after a field of a struct array, or of anything but one struct the caller built', () => {
    expect(argsFacts('top.m', `function top(p)
s(1).name = 'p1';
s(2).name = 'p2';
f(s.name, 'xq');
t = struct('name', {'q1', 'q2'});
f(t.name, 'xr');
u.name = 'one';
f(u.name, 'xs');
f(p.name, 'xt');
end
`)).toEqual({ '8 f': { 0: "'one", 1: "'xs" } });
  });

  it('records nothing at or after a part of callback text nothing knows, which may be any number of arguments', () => {
    expect(argsFacts('gui.m', `function gui(argtxt)
set(gcf, 'ButtonDownFcn', ['f(''a'', ' argtxt ', ''tgt'')']);
end
`)).toEqual({ '2 f': { 0: "'a" } });
  });
});

describe('MATLAB argument flow: what a function may change before it passes a parameter on', () => {
  const HELPER = 'function helper(x)\nfeval(x);\nend\n';

  it('passes nothing on after eval of code nothing knows, after run or evalc of a script, or when a nested function may write it', async () => {
    const { edges } = await project({
      'helper.m': HELPER,
      'aaa.m': fn('aaa'),
      'bbb.m': fn('bbb'),
      'ccc.m': fn('ccc'),
      'zzz.m': fn('zzz'),
      'setup5.m': "name = 'zzz';\n",
      'outer_eval.m': 'function outer_eval(name, code)\neval(code);\nhelper(name);\nend\n',
      'outer_run.m': "function outer_run(name)\nrun('setup5');\nhelper(name);\nend\n",
      'outer_evalc.m': "function outer_evalc(name)\nx = 1;\nevalc('setup5');\nhelper(name);\nend\n",
      'outer_nested.m': `function outer_nested(name)
x = inner(1);
helper(name);
    function r = inner(k)
        name = 'zzz';
        r = k;
    end
end
`,
      'top.m': "function top(c)\nouter_eval('aaa', c);\nouter_run('bbb');\nouter_evalc('ccc');\nouter_nested('aaa');\nend\n",
    });
    expect(edges).toEqual([]);
  });

  it('links nothing for a sink that reads one of two parameters by how many the caller passed, and keeps a default', async () => {
    const { edges } = await project({
      'f9.m': 'function f9(a, b)\nif nargin < 2\n    b = a;\nend\nfeval(b);\nend\n',
      'fitter.m': "function fitter(S, basisf)\nif nargin < 2, basisf = 'basis0'; end\nfeval(basisf, S);\nend\n",
      'xx.m': fn('xx'),
      'yy.m': fn('yy'),
      'basis0.m': fn('basis0'),
      'basis1.m': fn('basis1'),
      'top.m': "function top()\nf9('xx', 'yy');\nfitter(1, 'basis1');\nend\n",
    });
    expect(edges).toEqual(["fitter -calls-> basis1 @ basis1.m [basisf feval 'basis1' top.m:3]"]);
  });

  it('links nothing for a sink under a branch another parameter decides, and keeps one a test of its own value picks', async () => {
    const { edges } = await project({
      // Only callers passing 'FlipSheet' reach the eval; the join would take every caller's second argument.
      'fig.m': `function varargout = fig(varargin)
if nargin < 1, Verb = 'start'; else, Verb = varargin{1}; end
switch lower(Verb)
case 'flipsheet'
    move = varargin{2};
    eval(move);
case 'seekpane'
end
end
`,
      'tkelem.m': `function E = tkelem(ELEM, varargin)
switch lower(ELEM(1:4))
case 'tilt'
    E = feval(ELEM, varargin{:});
end
end
`,
      // The same choice made by an `if` that compares the other parameter with a text.
      'pane2.m': "function pane2(action, move)\nif strcmp(action, 'flipsheet')\n    eval(move);\nend\nend\n",
      // A test of what another parameter is decides too: only callers passing a non-empty `subs` get there.
      'assignx.m': 'function obj = assignx(obj, fun, subs)\nif ~isempty(subs)\n    obj = feval(fun, obj);\nend\nend\n',
      'helper.m': fn('helper'),
      'tilter.m': fn('tilter'),
      'dim.m': fn('dim'),
      'top.m': "function top()\nfig('SeekPane', 'helper');\nfig('FlipSheet', 'helper(1)');\ntkelem('tilter', 1);\npane2('seekpane', 'helper');\nassignx(1, @dim, 2);\nend\n",
    });
    expect(edges).toEqual(["tkelem -calls-> tilter @ tilter.m [ELEM feval 'tilter' top.m:4]"]);
  });

  /** Each function `f` is called by `top` twice: once with values that reach its sink, once with values that do not. */
  const GUARDED: Record<string, [string, string, string]> = {
    // A test of another parameter, in each shape a dispatcher writes it.
    ischar: ['function f(a, b)\nif ischar(a)\n  feval(b);\nend\nend\n', "f('x', 'aaa')", "f(3, 'bbb')"],
    ismember: ["function f(action, fname)\nif ismember(action, {'run', 'go'})\n  feval(fname);\nend\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    flag: ["function f(action, fname)\nisRun = strcmp(action, 'run');\nif isRun\n  feval(fname);\nend\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    return: ["function f(action, fname)\nif ~strcmp(action, 'run')\n  return;\nend\nfeval(fname);\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    error: ["function f(action, fname)\nswitch action\n  case 'run'\n  otherwise\n    error('no');\nend\nfeval(fname);\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    sibling: ["function f(cfg)\nswitch cfg.method\n  case 'a'\n    feval(cfg.fun);\nend\nend\n", "c.method = 'a';\nc.fun = 'aaa';\nf(c)", "d.method = 'b';\nd.fun = 'bbb';\nf(d)"],
    nargin: ['function f(a, b, c)\nif nargin == 3\n  feval(c);\nelse\n  feval(b);\nend\nend\n', "f('x', 'aaa')", "f('x', 'bbb', 'ccc')"],
    isempty: ['function f(a, fname)\nif isempty(a)\n  feval(fname);\nend\nend\n', "f([], 'aaa')", "f(1, 'bbb')"],
    varargin: ["function f(varargin)\nif strcmp(varargin{1}, 'a')\n  feval(varargin{2});\nelseif strcmp(varargin{1}, 'b')\n  x = 1;\nend\nend\n", "f('a', 'aaa')", "f('b', 'bbb')"],
    while: ['function f(n, fname)\nwhile n > 0\n  feval(fname);\n  n = n - 1;\nend\nend\n', "f(1, 'aaa')", "f(0, 'bbb')"],
    loop: ["function f(action, fname)\nfor k = 1:3\n  if strcmp(action, 'stop'), break; end\n  feval(fname);\nend\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    catch: ['function f(data, fname)\ntry\n  x = data.v;\ncatch\n  feval(fname);\nend\nend\n', "f(1, 'aaa')", "f(s, 'bbb')"],
    shortCircuit: ["function f(action, fname)\nok = strcmp(action, 'run') && feval(fname);\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
    // A parameter passed on under such a test: the function it reaches cannot tell its callers apart either.
    forwarded: ["function f(action, fname)\nif strcmp(action, 'run')\n  helper(fname);\nend\nend\n", "f('run', 'aaa')", "f('stop', 'bbb')"],
  };

  it.each(Object.entries(GUARDED))('links nothing for a sink a test of another value guards: %s', async (_shape, [f, reaches, not]) => {
    const { edges } = await project({
      'f.m': f,
      'helper.m': 'function helper(x)\nfeval(x);\nend\n',
      'aaa.m': fn('aaa'),
      'bbb.m': fn('bbb'),
      'ccc.m': fn('ccc'),
      'top.m': `function top()\ns = [];\n${reaches};\n${not};\nend\n`,
    });
    expect(edges).toEqual([]);
  });

  it('keeps the values a test of the very value the sink reads admits, and only those', async () => {
    const { edges } = await project({
      // A case-specific sink on the switch's own subject.
      'pick.m': "function pick(action)\nswitch action\n  case {'aaa', 'ccc'}\n    feval(action);\n  otherwise\n    disp(1);\nend\nend\n",
      // Whatever no case takes, as tkelem calls a function it does not know.
      'elem.m': "function E = elem(ELEM)\nswitch lower(ELEM(1:4))\n  case 'tilt'\n    E = 1;\n  case {'quad', 'bend'}\n    E = 2;\n  otherwise\n    E = feval(ELEM);\nend\nend\n",
      // An early exit on a test of the same value, through a copy, and combined tests.
      'run1.m': "function run1(varargin)\nname = varargin{1};\nif ~ismember(name, {'aaa', 'bbb'}), error('unknown'); end\nfeval(varargin{:});\nend\n",
      'run2.m': "function run2(m)\nif strcmpi(m, 'AAA') || strncmp(m, 'cc', 2)\n  feval(m);\nend\nend\n",
      // A handle is no text: strcmp is false for it, and a switch on it raises an error.
      'run3.m': "function run3(m)\nif ~strcmp(m, 'none')\n  feval(m);\nend\nend\n",
      // Errors that reject malformed input decide nothing between callers; the GUIDE test of varargin{1} admits a text.
      'fitter.m': "function fitter(S, basisf)\nif numel(S) ~= 2\n  error('two please');\nend\nif ~ischar(basisf) && ~isa(basisf, 'function_handle'), error('basisf'); end\nfeval(basisf, S);\nend\n",
      // A switchyard (as intgrid's above): a caller passing a text gets past the first test and into the second; it makes
      // the same call whether outputs are asked for or not, so nargout decides nothing.
      'yard.m': [
        'function varargout = yard(varargin)',
        'if numel(varargin) < 1 || isnumeric(varargin{1})',
        '  x = 1;',
        'elseif ischar(varargin{1})',
        '  try',
        '    if (nargout)',
        '      [varargout{1:nargout}] = feval(varargin{:});',
        '    else',
        '      feval(varargin{:}); % FEVAL switchyard',
        '    end',
        '  catch',
        '  end',
        'end',
        'end',
        'function Cb(h)',
        'end',
        '',
      ].join('\n'),
      // An error in a branch a caller passing the value never takes (it passes two arguments at least).
      'zoomer.m': "function zoomer(fig, method, varargin)\nif nargin < 2\n  if ~strcmp(get(fig, 'type'), 'figure')\n    error('figure please');\n  end\nelse\n  feval(method, varargin{:});\nend\nend\n",
      'gui.m': "function varargout = gui(varargin)\nif nargin && ischar(varargin{1})\n  cb = str2func(varargin{1});\nend\nend\nfunction aaa_Callback(h)\nend\n",
      'aaa.m': fn('aaa'),
      'bbb.m': fn('bbb'),
      'ccc.m': fn('ccc'),
      'tilter.m': fn('tilter'),
      'quadrupole.m': fn('quadrupole'),
      'mysolver.m': fn('mysolver'),
      'top.m': [
        'function top()',
        "pick('aaa');", "pick('bbb');",
        "elem('tilter');", "elem('quadrupole');", "elem('mysolver');",
        "run1('aaa', 1);", "run1('ccc', 1);",
        "run2('aaa');", "run2('ccc');", "run2('bbb');",
        "run3('none');", 'run3(@bbb);',
        "fitter(1, 'ccc');", 'fitter(1, @aaa);',
        "gui('aaa_Callback', 1);", 'gui(@bbb);',
        "yard('Cb', 1);",
        "zoomer(1, 'bbb');",
        'end', '',
      ].join('\n'),
    });
    expect(edges).toEqual([
      "elem -calls-> mysolver @ mysolver.m [ELEM feval 'mysolver' top.m:6]",
      'fitter -calls-> aaa @ aaa.m [basisf feval @aaa top.m:15]',
      "fitter -calls-> ccc @ ccc.m [basisf feval 'ccc' top.m:14]",
      "gui -references-> aaa_Callback @ gui.m [varargin{1} str2func 'aaa_Callback' top.m:16]",
      "pick -calls-> aaa @ aaa.m [action feval 'aaa' top.m:2]",
      "run1 -calls-> aaa @ aaa.m [varargin{1} feval 'aaa' top.m:7]",
      "run2 -calls-> aaa @ aaa.m [m feval 'aaa' top.m:9]",
      "run2 -calls-> ccc @ ccc.m [m feval 'ccc' top.m:10]",
      'run3 -calls-> bbb @ bbb.m [m feval @bbb top.m:13]',
      "yard -calls-> Cb @ yard.m [varargin{1} feval 'Cb' top.m:18]",
      "zoomer -calls-> bbb @ bbb.m [method feval 'bbb' top.m:19]",
    ]);
  });

  it('links nothing past a struct array field passed before the value, and links one struct\'s field', async () => {
    const { edges } = await project({
      'f.m': 'function f(a, b, c)\nfeval(b);\nend\n',
      'xq.m': fn('xq'),
      'xs.m': fn('xs'),
      'top.m': `function top()
s(1).name = 'p1';
s(2).name = 'p2';
f(s.name, 'xq');
u.name = 'one';
f(u.name, 'xs');
end
`,
    });
    expect(edges).toEqual(["f -calls-> xs @ xs.m [b feval 'xs' top.m:6]"]);
  });

  it('links nothing past a part of callback text nothing knows', async () => {
    const { edges } = await project({
      'f.m': 'function f(a, b, c)\nfeval(b);\nend\n',
      'tgt.m': fn('tgt'),
      'gui.m': "function gui(argtxt)\nset(gcf, 'ButtonDownFcn', ['f(' argtxt ', ''tgt'')']);\nend\n",
      'top.m': "function top()\ngui('1,2');\nend\n",
    });
    expect(edges).toEqual([]);
  });
});

describe('MATLAB argument flow: varargin, callbacks, function takers', () => {
  it('counts varargin on from the parameters before it, and through a function that passes varargin{:} on', async () => {
    const files: Record<string, string> = {
      'g1.m': 'function g1(a, varargin)\nfeval(varargin{1});\nend\n',
      'g2.m': 'function g2(a, varargin)\nfeval(varargin{:});\nend\n',
      'g3.m': 'function g3(a, b, varargin)\nr = cellfun(varargin{2}, {1, 2});\nend\n',
      'mid.m': "function mid(x, varargin)\nbottom('lead', varargin{:});\nend\n",
      'bottom.m': 'function bottom(a, fname, other)\nfeval(fname);\nfeval(other);\nend\n',
      'top.m': "function top()\ng1('n1', 'v1', 'v2');\ng2('n2', 'w1', 'w2');\ng3('n3', 'n4', 'x1', 'x2');\nmid('m0', 'm1', 'm2');\nend\n",
    };
    for (const name of ['n1', 'v1', 'v2', 'n2', 'w1', 'w2', 'n3', 'n4', 'x1', 'x2', 'm0', 'm1', 'm2', 'lead']) files[`${name}.m`] = fn(name);
    expect((await project(files)).edges).toEqual([
      "bottom -calls-> m1 @ m1.m [fname feval 'm1' top.m:5]",
      "bottom -calls-> m2 @ m2.m [other feval 'm2' top.m:5]",
      "g1 -calls-> v1 @ v1.m [varargin{1} feval 'v1' top.m:2]",
      "g2 -calls-> w1 @ w1.m [varargin{1} feval 'w1' top.m:3]",
      "g3 -references-> x2 @ x2.m [varargin{2} cellfun 'x2' top.m:4]",
    ]);
  });

  it('records nothing for a dot-syntax method call or a cell callback, whose places the receiver or MATLAB shifts', async () => {
    expect(argsFacts('c.m', `function c(r)
r.go('xfun', 'yfun');
uicontrol('Style', 'pushbutton', 'Callback', {@intgrid, 'LoadLattice'});
end
`)).toEqual({});
    const { edges } = await project({
      'Runner.m': 'classdef Runner\n    methods\n        function go(obj, a, b)\n            feval(a);\n        end\n    end\nend\n',
      'caller.m': "function caller()\nr = Runner();\nr.go('xfun', 'yfun');\nend\n",
      'xfun.m': fn('xfun'),
      'yfun.m': fn('yfun'),
      'intgrid.m': 'function varargout = intgrid(varargin)\n[varargout{1:nargout}] = feval(varargin{:});\nend\nfunction LoadLattice(h)\nend\n',
      'gui.m': "function gui()\nuicontrol('Style', 'pushbutton', 'Callback', {@intgrid, 'LoadLattice'});\nend\n",
    });
    expect(edges).toEqual([]);
  });

  it('follows a parameter a statement copies to another variable before the sink, as the switchyard idiom does', async () => {
    const { edges } = await project({
      'sw.m': 'function varargout = sw(varargin)\naction = varargin{1};\n[varargout{1:nargout}] = feval(action, varargin{2:end});\nend\nfunction LoadLattice(h)\nend\n',
      'sw2.m': 'function sw2(basisf)\nr = basisf;\nfeval(r);\nend\n',
      'basis0.m': fn('basis0'),
      'top.m': "function top(h)\nsw('LoadLattice', h);\nsw2('basis0');\nend\n",
    });
    expect(edges).toEqual([
      "sw -calls-> LoadLattice @ sw.m [varargin{1} feval 'LoadLattice' top.m:2]",
      "sw2 -calls-> basis0 @ basis0.m [basisf feval 'basis0' top.m:3]",
    ]);
  });

  it('reads code a caller passes to evalc as code run there', async () => {
    const { edges } = await project({
      'capture.m': 'function out = capture(code)\nout = evalc(code);\nend\n',
      'helper.m': fn('helper'),
      'a.m': "function a()\ncapture('helper(3)');\nend\n",
    });
    expect(edges).toEqual(["capture -calls-> helper @ helper.m [code evalc 'helper(3)' a.m:2]"]);
  });
});

describe('MATLAB argument hops, as explore and node word them', () => {
  const hop = (kind: Edge['kind'], metadata: Record<string, unknown>): string | undefined =>
    describeSynthesizedHop({ source: 'a', target: 'b', kind, provenance: 'heuristic', metadata: { synthesizedBy: 'matlab-argument', registeredAt: 'use1.m:2', ...metadata } })?.summary;

  it('says what the call goes through and the value given', () => {
    expect(hop('calls', { sink: 'feval', param: 'basisf', value: "'basis0'" })).toBe("calls through `feval(basisf)` given `'basis0'`");
    expect(hop('calls', { sink: 'fh', param: 'fh', value: '@g' })).toBe('calls `fh` given `@g`');
    expect(hop('references', { sink: 'str2func', param: 'varargin{1}', value: "'cb'" })).toBe("references through `str2func(varargin{1})` given `'cb'`");
  });
});

describe('MATLAB argument flow: a sync comes to what a full index does', () => {
  /**
   * Syncs `root` after each step — of every file, or of the `paths` given, as
   * the watcher does — and, unless `expected` is null (files on disk still
   * wait for their own sync), compares its argument edges and records with a
   * full index of the same files.
   */
  async function steps(files: Record<string, string>, changes: Array<[Record<string, string | null>, string[] | null, string[]?]>): Promise<void> {
    const root = tempDir('cg-matlab-args-steps-');
    try {
      writeTree(root, files);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        for (const [change, expected, paths] of changes) {
          writeTree(root, change);
          await cg.sync(paths ? { paths } : {});
          if (expected === null) continue;
          const full = await fullIndexOf(root);
          expect(argumentEdges(cg)).toEqual(expected);
          expect(full.edges).toEqual(expected);
          expect(argRecords(cg)).toEqual(full.records);
        }
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('keeps what a call passes whatever it reaches: a class that becomes a function with a sink, a caller deleted', async () => {
    await steps({
      'foo.m': 'classdef foo\n  methods\n    function obj = foo(x)\n    end\n  end\nend\n',
      'aaa.m': fn('aaa'),
      'top.m': "function top()\nfoo('aaa');\nend\n",
    }, [
      [{ 'foo.m': 'function foo(x)\nfeval(x);\nend\n' }, ["foo -calls-> aaa @ aaa.m [x feval 'aaa' top.m:2]"]],
      [{ 'top.m': null }, []],
    ]);
  });

  it('syncs one path at a time as the watcher does: a callee that gains a sink, then a caller edited at the same time', async () => {
    await steps({
      'fitmodel.m': 'function fitmodel(S, basisf)\ny = basisf;\nend\n',
      'hop.m': "function hop(x)\nz = x;\nfitmodel(1, 'aaa');\nend\n",
      'top.m': "function top()\nhop('bbb');\nend\n",
      'aaa.m': fn('aaa'),
      'bbb.m': fn('bbb'),
    }, [
      // Both edited on disk; the callee's sync comes first, the caller's after it.
      [{
        'fitmodel.m': 'function fitmodel(S, basisf)\nfeval(basisf);\nend\n',
        'hop.m': "function hop(x)\nfeval(x);\nfitmodel(1, 'aaa');\nend\n",
      }, null, ['fitmodel.m']],
      [{}, [
        "fitmodel -calls-> aaa @ aaa.m [basisf feval 'aaa' hop.m:3]",
        "hop -calls-> bbb @ bbb.m [x feval 'bbb' top.m:2]",
      ], ['hop.m']],
      // The callee loses its sink, synced alone.
      [{ 'fitmodel.m': 'function fitmodel(S, basisf)\ny = basisf;\nend\n' }, ["hop -calls-> bbb @ bbb.m [x feval 'bbb' top.m:2]"], ['fitmodel.m']],
      // The caller of hop goes, synced alone.
      [{ 'top.m': null }, [], ['top.m']],
    ]);
  });

  it('links the callers of a function an edit gives a sink, and unlinks them when it goes', async () => {
    await steps({
      'helper.m': 'function helper(x)\ny = x;\nend\n',
      'aaa.m': fn('aaa'),
      'top.m': "function top()\nhelper('aaa');\nend\n",
      'mid.m': "function mid(v)\nhelper(v);\nend\n",
      'upper.m': "function upper()\nmid('aaa');\nend\n",
    }, [
      [{ 'helper.m': 'function helper(x)\nfeval(x);\nend\n' }, [
        "helper -calls-> aaa @ aaa.m [x feval 'aaa' top.m:2]",
      ]],
      [{ 'helper.m': 'function helper(x)\ny = x;\nend\n' }, []],
      // Through a function that passes it on: mid forwards v, so its callers' records stay for it.
      [{ 'helper.m': 'function helper(x)\nfeval(x);\nend\n', 'top.m': 'function top()\nend\n' }, [
        "helper -calls-> aaa @ aaa.m [x feval 'aaa' upper.m:2]",
      ]],
    ]);
  });

  it('keeps the records a function that starts or stops passing a parameter on needs', async () => {
    await steps({
      'fitmodel.m': 'function fmodel = fitmodel(S, Y, basisf)\nF = feval(basisf, S);\nend\n',
      'basis0.m': fn('basis0'),
      'use1.m': "function use1(S)\nhop(S, 'basis0');\nend\n",
      'hop.m': 'function hop(S, r)\nq = r;\nfitmodel(S, 1, 2);\nend\n',
    }, [
      [{ 'hop.m': 'function hop(S, r)\nfitmodel(S, 1, r);\nend\n' }, ["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]"]],
      [{ 'hop.m': 'function hop(S, r)\nr = 3;\nfitmodel(S, 1, r);\nend\n' }, []],
      [{ 'hop.m': 'function hop(S, r)\nfitmodel(S, 1, r);\nend\n' }, ["fitmodel -calls-> basis0 @ basis0.m [basisf feval 'basis0' use1.m:2]"]],
    ]);
  });

  it('links a call that lands on another function after a sync, with what it passes', async () => {
    await steps({
      'd/a.m': "function a()\nfx('aaa', 1);\nend\n",
      'fx.m': 'function fx(name, n)\ny = n;\nend\n',
      'aaa.m': fn('aaa'),
    }, [
      // A private function beside the caller takes its call: it calls what it is passed.
      [{ 'd/private/fx.m': 'function fx(name, n)\nfeval(name);\nend\n' }, ["fx -calls-> aaa @ aaa.m [name feval 'aaa' d/a.m:2]"]],
      [{ 'd/private/fx.m': null }, []],
      // The function it called goes, and another that calls what it is passed takes the call.
      [{ 'd/private/fx.m': 'function fx(name, n)\nfeval(name);\nend\n', 'fx.m': null }, ["fx -calls-> aaa @ aaa.m [name feval 'aaa' d/a.m:2]"]],
    ]);
  });
});
