/**
 * MATLAB calls named at runtime: what a function's code holds, followed
 * statement by statement, names what `feval`, `str2func`, `cellfun('f', …)`
 * and a call through a handle variable reach; code given as text — what
 * `eval`, `evalc` and `evalin` run, and GUI callbacks written as text — is
 * read as code; the names eval'd code and `load` make are variables. Each case
 * has its silent counterpart: a name the code does not settle is no edge.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser } from '../src/extraction/grammars';
import { MATLAB_BUILTINS } from '../src/extraction/languages/matlab-builtins';
import { interpretScope, type InterpHost } from '../src/extraction/languages/matlab-interp';
import { evaluate, HOLE } from '../src/extraction/languages/matlab-values';
import { allEdges, edgesOfProject, indexOfProject, tempDir, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** `line kind:name` of every ref a file emits but the built-ins' (dropped before they are stored), in source order; ` runtime` when it carries that fact. */
function refs(file: string, code: string): string[] {
  const r = extractFromSource(file, code, 'matlab');
  expect(r.errors).toEqual([]);
  return r.unresolvedReferences
    .filter((u) => !MATLAB_BUILTINS.has(u.referenceName))
    .map((u) => `${u.line} ${u.referenceKind}:${u.referenceName}${u.candidates?.includes('runtime') ? ' runtime' : ''}`);
}

/** The names `feval` / `fh(x)` calls reach in a function file (`refs` of calls only, names alone, sorted). */
function called(code: string, file = 'f.m'): string[] {
  return [...new Set(refs(file, code).filter((r) => / calls:/.test(r)).map((r) => r.split(' calls:')[1]!.replace(/ runtime$/, '')))].sort();
}

/** A function file `name.m` that does nothing. */
const fn = (name: string): string => `function ${name}(varargin)\nend\n`;

/** Edges out of `file` only. */
function from(edges: string[], file: string): string[] {
  return edges.filter((e) => e.startsWith(`${file} `));
}

describe('MATLAB feval', () => {
  it('calls each function the first argument can name where the call is, and nothing it cannot', async () => {
    const edges = await edgesOfProject({
      'tracker.m': `function tracker(elem, r, x, p)
feval('IdentityPass', elem, r);
m = 'DriftPass';
if x
    m = 'QuadPass';
end
r = feval(m, elem, r);
m = 'LaterPass';
feval(p, r);
E.PassMethod = 'EPass';
feval(E.PassMethod, E, r);
for c = {'CellA', 'CellB'}
    feval(c{1}, r);
end
fh = @solve;
feval(fh, r);
feval('pkg.scale', r);
end
`,
      ...Object.fromEntries(['IdentityPass', 'DriftPass', 'QuadPass', 'LaterPass', 'EPass', 'CellA', 'CellB', 'solve'].map((n) => [`${n}.m`, fn(n)])),
      '+pkg/scale.m': fn('scale'),
    });
    expect(from(edges, 'tracker.m')).toEqual([
      // A literal name; either branch's; a struct field's; each element a loop over a cell hands out.
      'tracker.m tracker -calls-> CellA @ CellA.m',
      'tracker.m tracker -calls-> CellB @ CellB.m',
      'tracker.m tracker -calls-> DriftPass @ DriftPass.m',
      'tracker.m tracker -calls-> EPass @ EPass.m',
      'tracker.m tracker -calls-> IdentityPass @ IdentityPass.m',
      'tracker.m tracker -calls-> QuadPass @ QuadPass.m',
      // A dotted name is a package function's.
      'tracker.m tracker -calls-> pkg::scale @ +pkg/scale.m',
      // A handle: called by feval, and referenced where `@solve` is written.
      'tracker.m tracker -calls-> solve @ solve.m',
      'tracker.m tracker -references-> solve @ solve.m',
      // Not LaterPass, assigned after the call; nothing for the parameter `p`.
    ]);
  });

  it('dispatches on the object passed next, as a call written with it would', async () => {
    const edges = await edgesOfProject({
      'Shape.m': `classdef Shape < handle
    methods
        function a = area(obj)
            a = 1;
        end
    end
end
`,
      'measure.m': `function measure(q)
s = Shape();
feval('area', s);
feval('area', q);
end
`,
    });
    // On `s`, a Shape, the class's method; on the parameter `q`, a function `area` there is none of.
    expect(from(edges, 'measure.m')).toEqual(['measure.m measure -calls-> Shape::area @ Shape.m', 'measure.m measure -instantiates-> Shape @ Shape.m']);
  });

  it('names nothing an eval of unknown code may have reassigned, nor a variable a nested function assigns', () => {
    const code = `function outer(code)
m = 'First';
eval(code);
feval(m);
k = 'Second';
inner(1);
feval(k);
n = 'Third';
feval(n);
    function inner(q)
        k = 'Other';
    end
end
`;
    expect(refs('outer.m', code)).toEqual(['6 calls:inner', '9 calls:Third']);
  });
});

describe('MATLAB calls through a handle variable', () => {
  it('calls what the handle holds, and nothing through a parameter', async () => {
    const edges = await edgesOfProject({
      'handles.m': `function handles(x, fp)
fh = @solve;
y = fh(x);
z = fp(x);
g = str2func('helper');
g(1);
end
`,
      'solve.m': fn('solve'),
      'helper.m': fn('helper'),
      'fp.m': fn('fp'),
    });
    expect(from(edges, 'handles.m')).toEqual([
      'handles.m handles -calls-> helper @ helper.m',
      'handles.m handles -calls-> solve @ solve.m',
      'handles.m handles -references-> helper @ helper.m',
      'handles.m handles -references-> solve @ solve.m',
    ]);
  });
});

describe('MATLAB functions named as text', () => {
  it('references what str2func and cellfun & co. name, not their built-in names', async () => {
    const edges = await edgesOfProject({
      'texts.m': `function texts(c, x0)
h = str2func('myfun');
cellfun('myfun2', c);
cellfun('isempty', c);
cellfun('size', c);
fzero('froot', x0);
end
`,
      'myfun.m': fn('myfun'),
      'myfun2.m': fn('myfun2'),
      'froot.m': fn('froot'),
      'size.m': fn('size'),
    });
    // `cellfun('size', c)` is cellfun's own fast path, not the project's size.m.
    expect(from(edges, 'texts.m')).toEqual([
      'texts.m texts -references-> froot @ froot.m',
      'texts.m texts -references-> myfun @ myfun.m',
      'texts.m texts -references-> myfun2 @ myfun2.m',
    ]);
  });
});

describe('MATLAB code run by eval', () => {
  it('calls what the code calls, a script it names included, and nothing a part it does not know names', async () => {
    const edges = await edgesOfProject({
      'evals.m': `function evals(op, fn, sel)
if sel
    eval('helper(1)');
end
eval('s05_01');
eval([mfilename '(''sel'')']);
eval(['load ', fn]);
eval([op '(''set_proc'')']);
eval('broken(', 'onerr(1)');
eval('eval(''inner(1)'')');
x = evalc('quiet(2)');
end
`,
      ...Object.fromEntries(['helper', 'onerr', 'inner', 'quiet', 'broken', 'set_proc'].map((n) => [`${n}.m`, fn(n)])),
      's05_01.m': 'disp(1);\n',
    });
    expect(from(edges, 'evals.m')).toEqual([
      // `[mfilename '(''sel'')']`: this file's own function.
      'evals.m evals -calls-> evals @ evals.m',
      'evals.m evals -calls-> helper @ helper.m',
      'evals.m evals -calls-> inner @ inner.m',
      // The catch code runs when the code fails (here it does not parse).
      'evals.m evals -calls-> onerr @ onerr.m',
      'evals.m evals -calls-> quiet @ quiet.m',
      // A statement naming a script runs it.
      'evals.m evals -calls-> s05_01.m @ s05_01.m',
      // Not broken (no code), not set_proc (`op` unknown), nothing of `load <file>`.
    ]);
  });

  it('places every reference of the code on the line of the argument that gives it', () => {
    // The code is given over two lines, from line 3.
    expect(refs('f.m', "function f()\nx = 1;\neval(['a = helper(1);', ...\n      'b = other(a);']);\nend\n")).toEqual(['3 calls:helper', '3 calls:other']);
  });

  it('reads the code a variable holds there; a name the code assigns is still a call, made at runtime', () => {
    const code = `function f()
cmd = 'r = make_ring(2);';
eval(cmd);
r(3)
eval('x = 3;');
y = x(2);
z = w(1);
end
`;
    // MATLAB reads r and x as functions from f's own code: called, unless the eval ran — `runtime`.
    expect(refs('f.m', code)).toEqual(['3 calls:make_ring', '4 calls:r runtime', '6 calls:x runtime', '7 calls:w']);
  });

  it('keeps the call of a function a conditional eval may shadow, and leaves no row for one nothing answers', async () => {
    // fieldtrip's test_bug1306: the eval runs only when ft_read_header is missing.
    const { edges, unresolved } = await indexOfProject({
      'test_bug1306.m': `function test_bug1306(cfg)
if ~exist('ft_read_header') && exist('read_header')
  eval('ft_read_header = @read_header;');
end
hdr = ft_read_header(cfg.dataset);
eval('tmp = 3;');
v = tmp(2);
load(cfg.file, 'lat');
g = lat(1);
end
`,
      'ft_read_header.m': fn('ft_read_header'),
      'read_header.m': fn('read_header'),
    });
    expect(from(edges, 'test_bug1306.m')).toEqual([
      'test_bug1306.m test_bug1306 -calls-> ft_read_header @ ft_read_header.m',
      'test_bug1306.m test_bug1306 -references-> read_header @ read_header.m',
    ]);
    // tmp (eval'd) and lat (loaded) answer to nothing: no row is left for them.
    expect(unresolved.filter((r) => r.startsWith('test_bug1306.m'))).toEqual([]);
  });

  it('places a name code given as text calls by the way it is evaluated: for a value, no script runs', async () => {
    const edges = await edgesOfProject({
      'valuectx.m': `function valuectx()
x = eval('cfgscript');
y = evalc('cfgscript2');
eval('cfgscript3');
end
`,
      'cfgscript.m': 'a = 1;\n',
      'cfgscript2.m': 'a = 1;\n',
      'cfgscript3.m': 'a = 1;\n',
    });
    // `x = eval('cfgscript')` asks a script for a value, which MATLAB refuses; evalc runs its code as statements.
    expect(from(edges, 'valuectx.m')).toEqual(['valuectx.m valuectx -calls-> cfgscript2.m @ cfgscript2.m', 'valuectx.m valuectx -calls-> cfgscript3.m @ cfgscript3.m']);
  });
});

describe('MATLAB variables load makes', () => {
  it('reads the names after the file as names made at runtime, and a struct from S = load(…); a load without names changes nothing', () => {
    const code = `function f(file)
load(file, 'a', '-mat');
a(3)
load data.mat b c
b(1)
S = load(file);
S.k(2)
load(file);
d(1)
load(file, '-regexp', 'e.*');
e(1)
end
`;
    expect(refs('f.m', code)).toEqual(['3 calls:a runtime', '5 calls:b runtime', '9 calls:d', '11 calls:e']);
  });

  it('reads them through code eval runs too', () => {
    expect(refs('f.m', "function f()\neval('load cfg.mat lattice');\nlattice(2)\nend\n")).toEqual(['3 calls:lattice runtime']);
  });

  it('reads them as variables in a script, whose names are looked up as it runs', () => {
    expect(refs('s.m', "load cfg.mat lattice\nlattice(2)\neval('x = 3;');\nx(2)\n")).toEqual([]);
  });
});

describe('MATLAB callbacks given as text', () => {
  it('references what the code calls, in the base workspace: its own variables are none, the function\'s are not its', async () => {
    const edges = await edgesOfProject({
      'gui.m': `function gui(h, panel)
uicontrol('Style', 'pushbutton', 'Callback', 'corgui(''ShowResp'')');
uicontrol('ButtonDownFcn', [mfilename '(''sel'')']);
h.Callback = 'go';
set(h, 'KeyPressFcn', 'onkey');
uimenu('Callback', 'refresh_plots');
uicontrol('Callback', 'v = get(gcbo,''Value''); setv(v)');
uicontrol('Callback', 'show(panel)');
s = strrep(h, 'Callback', 'notacallback');
evalin('base', 'refresh_all');
params = evalin('base', 'SimParams');
end
`,
      ...Object.fromEntries(['corgui', 'go', 'onkey', 'setv', 'v', 'show', 'panel', 'refresh_all', 'notacallback', 'SimParams'].map((n) => [`${n}.m`, fn(n)])),
      'refresh_plots.m': 'plot(1);\n',
    });
    expect(from(edges, 'gui.m')).toEqual([
      // evalin runs the code now, in the base workspace.
      'gui.m gui -calls-> refresh_all @ refresh_all.m',
      'gui.m gui -references-> corgui @ corgui.m',
      'gui.m gui -references-> go @ go.m',
      'gui.m gui -references-> gui @ gui.m',
      'gui.m gui -references-> onkey @ onkey.m',
      // `panel` is gui's parameter, but the callback runs where no such variable is.
      'gui.m gui -references-> panel @ panel.m',
      // A callback naming a script runs it on the event.
      'gui.m gui -references-> refresh_plots.m @ refresh_plots.m',
      'gui.m gui -references-> setv @ setv.m',
      'gui.m gui -references-> show @ show.m',
      // Not v, the callback's own variable; not what strrep is given as text;
      // not SimParams, whose value evalin reads: most often a variable there.
    ]);
  });
});

describe('MATLAB paths that leave', () => {
  it('joins nothing of a branch that returns or raises an error; a break joins the loop exit, a continue the next round, an error the catch', () => {
    const code = `function g(c, x, n)
m = 'fn_default';
if c
  m = 'fn_only_before_return';
  return;
end
feval(m, x);
k = 'fn_k_default';
if isempty(x)
  k = 'fn_k_err'; error('empty x');
end
feval(k, x);
p = 'fn_p_start';
for i = 1:n
  p = 'fn_p_break';
  if x(i), break; end
  p = 'fn_p_next';
  if c, continue; end
  p = 'fn_p_end';
end
feval(p);
q = 'fn_q_a';
try
  q = 'fn_q_b';
  error('stop');
catch
end
feval(q);
end
`;
    // Not fn_only_before_return nor fn_k_err: no path that set them reaches the feval.
    expect(called(code)).toEqual(['fn_default', 'fn_k_default', 'fn_p_break', 'fn_p_end', 'fn_p_next', 'fn_p_start', 'fn_q_a', 'fn_q_b']);
  });
});

describe('MATLAB arrays read at a literal index', () => {
  it('reads the element at its place in a cell row or struct array built where it is read, and nothing it cannot place', () => {
    const code = `function ci(x)
steps = {'fn_load_data', 'fn_plot_all'};
feval(steps{1}, x);
s = struct('f', 'fn_s1');
s(2).f = 'fn_s2';
feval(s(1).f);
t = struct('g', {'fn_t1', 'fn_t2'});
feval(t(2).g);
eval(["fn_helper" "(1)"]);
col = {'fn_col1'; 'fn_col2'};
for c = col
  feval(c{2});
end
u = {};
u{end+1} = 'fn_u1';
u{end+1} = 'fn_u2';
for c = u
  feval(c{1});
end
feval(u{3});
end
`;
    // `["fn_helper" "(1)"]` is a string array, not code; a loop over a column hands out the whole
    // column, and u{3} has no known place: nothing for them.
    expect(called(code)).toEqual(['fn_load_data', 'fn_s1', 'fn_t2', 'fn_u1', 'fn_u2']);
  });
});

describe('MATLAB fields of objects', () => {
  it('forgets what an object field holds across a call that may change it, an alias, or a property method', () => {
    const code = `classdef Elem < handle
  properties
    PassMethod = 'DriftPass'
    Mode
  end
  methods
    function track(self)
      self.PassMethod = 'fn_identity';
      self.update();
      feval(self.PassMethod);
    end
    function direct(self)
      self.PassMethod = 'fn_direct';
      feval(self.PassMethod);
    end
    function moded(self)
      self.Mode = 'fn_mode';
      feval(self.Mode);
    end
    function set.Mode(self, v)
      self.Mode = upper(v);
    end
    function update(self)
      self.PassMethod = 'fn_quad';
    end
  end
end
`;
    expect(called(code, 'Elem.m')).toEqual(['Elem::update', 'fn_direct']);
  });

  it('keeps a struct the function built across calls, and an object field only up to the next call', () => {
    const code = `function al(x)
s = Holder();
s.method = 'fn_alpha';
t = s;
t.method = 'fn_beta';
feval(s.method);
E.PassMethod = 'fn_epass';
consume(E);
feval(E.PassMethod, E);
x.fn = 'fn_param';
feval(x.fn);
x.fn = 'fn_param2';
helper(1);
feval(x.fn);
end
`;
    // s may be a handle that t aliases; x a handle helper changes.
    expect(called(code, 'al.m')).toEqual(['Holder', 'consume', 'fn_epass', 'fn_param', 'helper']);
  });
});

describe('MATLAB code eval runs, followed for what it changes', () => {
  it('forgets what the code may set: through a script, a load, a nested eval, a run; and what an eval in a condition sets on every path', () => {
    const code = `function ev(c)
m = 'fn_alpha'; eval('setup_vars'); feval(m);
n = 'fn_beta'; eval('load cfg.mat'); feval(n);
k = 'fn_gamma'; eval('eval(''k = ''''fn_delta'''';'')'); feval(k);
j = 'fn_eps'; eval('run(''setup'')'); feval(j);
q = 'fn_keep'; eval('y = 1;'); feval(q);
w = 'fn_w'; eval('w = 1;'); feval(w);
a = 'fn_a';
if isempty(evalc('a = ''fn_b'';')), disp(1); end
feval(a);
b = 'fn_b1';
switch evalc('b = 2;'), case 'x', disp(1); end
feval(b);
d = 'fn_d1';
while numel(evalc('d = 3;')) > c, c = c + 1; end
feval(d);
end
`;
    // Only q survives: the code given as text sets y alone.
    expect(called(code, 'ev.m')).toEqual(['fn_keep', 'setup', 'setup_vars']);
  });
});

describe('MATLAB variables nested functions share', () => {
  it('knows none a nested function may set, from a sibling or through eval; a nested function\'s own are followed', () => {
    const code = `function ne(f)
m = 'fn_alpha';
reload(f);
feval(m);
mode = [];
a();
  function reload(f)
    eval('m = ''fn_beta'';');
  end
  function a()
    mode = 'fn_m1';
    b(1);
    feval(mode);
    own = 'fn_own';
    feval(own);
  end
  function b(~)
    mode = 'fn_m2';
  end
end
`;
    expect(called(code, 'ne.m')).toEqual(['a', 'b', 'fn_own', 'reload']);
  });
});

describe('MATLAB values of text functions, joins and loops', () => {
  it('follows strcat, sprintf, upper, lower, func2str, str2func, strtrim, a computed run and a cell in a field', async () => {
    const edges = await edgesOfProject({
      'sf.m': `function sf(x)
a = strcat('fn_', 'cat ');
feval(a);
b = sprintf('%s_%s', 'fn', 'spr');
feval(b);
c = upper('fn_up');
feval(c);
d = lower('FN_LOW');
feval(d);
fh = @fn_handle;
e = func2str(fh);
feval(e);
g = str2func('pkg.fn_pkg');
g(1);
eval(strtrim(['  fn_trim' '(1)  ']));
r = 'fn_run';
run(r);
s.f = {'fn_cell_a'};
s.f{2} = 'fn_cell_b';
feval(s.f{2});
end
`,
      ...Object.fromEntries(['fn_cat', 'fn_spr', 'FN_UP', 'fn_low', 'fn_handle', 'fn_trim', 'fn_cell_a', 'fn_cell_b'].map((n) => [`${n}.m`, fn(n)])),
      '+pkg/fn_pkg.m': fn('fn_pkg'),
      'fn_run.m': 'disp(1);\n',
    });
    expect(from(edges, 'sf.m')).toEqual([
      'sf.m sf -calls-> FN_UP @ FN_UP.m',
      'sf.m sf -calls-> fn_cat @ fn_cat.m',
      'sf.m sf -calls-> fn_cell_b @ fn_cell_b.m',
      'sf.m sf -calls-> fn_handle @ fn_handle.m',
      'sf.m sf -calls-> fn_low @ fn_low.m',
      'sf.m sf -calls-> fn_run.m @ fn_run.m',
      'sf.m sf -calls-> fn_spr @ fn_spr.m',
      'sf.m sf -calls-> fn_trim @ fn_trim.m',
      'sf.m sf -calls-> pkg::fn_pkg @ +pkg/fn_pkg.m',
      'sf.m sf -references-> fn_handle @ fn_handle.m',
      'sf.m sf -references-> pkg::fn_pkg @ +pkg/fn_pkg.m',
    ]);
  });

  it('trims only the ends of text with a part nothing here knows, a blank beside that part going with it', () => {
    const value = (expr: string): string[] => {
      const code = `y = ${expr};`;
      const tree = getParser('matlab')!.parse(code)!;
      try {
        const rhs = tree.rootNode.namedChildren[0]!.childForFieldName('right')!;
        const host = { source: code, mfilename: () => null, isLocal: () => false, handle: () => null, named: () => null };
        return evaluate(rhs, null, host).strs.map((t) => t.split(HOLE).join('<?>'));
      } finally {
        tree.delete();
      }
    };
    expect(value("strtrim(['foo ' x ' bar'])")).toEqual(['foo <?> bar']);
    expect(value("strtrim([' ' x ' foo '])")).toEqual(['<?>foo']);
    expect(value("deblank(['a ' x ' '])")).toEqual(['a<?>']);
    expect(value("strtrim('  f(1)  ')")).toEqual(['f(1)']);
  });

  it('joins switch cases, while and try exits, widens a loop that does not settle, and forgets cleared and global names', () => {
    const code = `function jw(x, n)
m = 'fn_m0';
switch x
  case 1
    m = 'fn_m1';
  case 2
    m = 'fn_m2';
end
feval(m);
w = 'fn_w0';
while x > n
  w = 'fn_w1';
end
feval(w);
t = 'fn_t0';
try
  t = 'fn_t1';
  risky(1);
catch
  t = 'fn_tc';
end
feval(t);
g = 'fn_g';
for k = 1:n
  g = [g 'x'];
end
feval(g);
c = 'fn_c';
clear c
feval(c);
v = 'fn_v';
global v
feval(v);
end
`;
    expect(called(code, 'jw.m')).toEqual(['fn_g', 'fn_gx', 'fn_gxx', 'fn_gxxx', 'fn_m0', 'fn_m1', 'fn_m2', 'fn_t1', 'fn_tc', 'fn_w0', 'fn_w1', 'risky']);
  });

  it('follows a script, where a script it runs, evalin and assignin may set anything', () => {
    const code = `m = 'fn_alpha';
feval(m);
setup_vars;
feval(m);
n = 'fn_beta';
evalin('base', 'y = 1;');
feval(n);
p = 'fn_p';
assignin('base', 'z', 1);
feval(p);
fh = @fn_gamma;
fh(1);
eval('x = 3;');
x(2)
`;
    expect(refs('run_me.m', code)).toEqual(['2 calls:fn_alpha', '3 calls:setup_vars', '11 function_ref:fn_gamma', '12 calls:fn_gamma']);
  });

  it('calls through a handle on the object passed first, as a call written with it would', async () => {
    const edges = await edgesOfProject({
      'Shape.m': 'classdef Shape < handle\n    methods\n        function a = area(obj)\n            a = 1;\n        end\n    end\nend\n',
      'measure.m': 'function measure()\ns = Shape();\nfh = @area;\nfh(s);\nend\n',
    });
    expect(from(edges, 'measure.m')).toEqual(['measure.m measure -calls-> Shape::area @ Shape.m', 'measure.m measure -instantiates-> Shape @ Shape.m']);
  });

  it('reads code in code two levels deep, and no deeper; a computed run name; a path is no name', () => {
    expect(refs('depth.m', "function depth()\neval('eval(''eval(''''deep(1)'''')'')');\neval('eval(''mid(1)'')');\nend\n")).toEqual(['3 calls:mid']);
    expect(refs('rc.m', "function rc(p)\nname = 'setup_a';\nrun(name);\nrun([p '/setup_b']);\nend\n")).toEqual(['3 calls:setup_a']);
  });
});

describe('MATLAB callbacks given as text, read from GUI functions only', () => {
  it('reads callback pairs in step, of MATLAB\'s GUI functions and struct, whatever their case; leaves no row for a base-workspace variable', async () => {
    const { edges, unresolved } = await indexOfProject({
      'gui2.m': `function gui2(h, k, fn)
uimenu('Label', 'Callback', 'Callback', 'go_menu');
s = struct('name', 'Callback', 'value', 'go_two');
t = struct('Callback', 'go_three');
cb = 'go_lower';
set(h, 'callback', cb);
myfun('Callback', 'go_not');
q = quad('QF', 0.34, 1.8157, 'QuadLinearPass');
cback = ['rload(''GenFig'', COR(1).name, COR(1).status);'];
uimenu(h, 'Callback', cback);
uicontrol('Callback', ['go_hole(' num2str(k) ')']);
uicontrol('Callback', [fn '(1)']);
h(2).Callback = 'go_indexed';
evalin('base', 'base_fn(1)', 'base_catch(2)');
set(h, fn, 'Callback', 'go_lost');
text(0.5, 0.5, 'Callback', 'ButtonDownFcn', 'go_text');
uicontrol('Parent', h, ...
    'Callback', ['go_cont' ...
    '(1)']);
end
`,
      ...Object.fromEntries(
        ['go_menu', 'go_two', 'go_three', 'go_lower', 'go_not', 'go_lost', 'go_text', 'go_cont', 'myfun', 'quad', 'QF', 'QuadLinearPass', 'rload', 'go_hole', 'go_indexed', 'base_fn', 'base_catch'].map((n) => [`${n}.m`, fn(n)]),
      ),
    });
    expect(from(edges, 'gui2.m')).toEqual([
      // evalin's code and its catch code run now, in the base workspace.
      'gui2.m gui2 -calls-> base_catch @ base_catch.m',
      'gui2.m gui2 -calls-> base_fn @ base_fn.m',
      // An accelerator lattice's own quad, not MATLAB's integrator: 'QF' names a magnet.
      'gui2.m gui2 -calls-> myfun @ myfun.m',
      'gui2.m gui2 -calls-> quad @ quad.m',
      // Pairs and text continued over lines (`...`).
      'gui2.m gui2 -references-> go_cont @ go_cont.m',
      'gui2.m gui2 -references-> go_hole @ go_hole.m',
      'gui2.m gui2 -references-> go_indexed @ go_indexed.m',
      'gui2.m gui2 -references-> go_lower @ go_lower.m',
      'gui2.m gui2 -references-> go_menu @ go_menu.m',
      // text's own string spells 'Callback': the pairs start after it.
      'gui2.m gui2 -references-> go_text @ go_text.m',
      'gui2.m gui2 -references-> go_three @ go_three.m',
      'gui2.m gui2 -references-> rload @ rload.m',
      // Not go_two (a value), go_not (myfun takes text), QF, go_lost ('Callback' may be the value of
      // the property fn names).
    ]);
    // COR is a base-workspace variable the callback reads: no row.
    expect(unresolved.filter((r) => r.startsWith('gui2.m'))).toEqual([]);
  });
});

describe('MATLAB interpretation robustness', () => {
  it('keeps a file whose text doubles past any size, or whose expression nests a thousand deep', () => {
    const doubling = ['function doubling()', "s = 'abcdefgh';", ...Array.from({ length: 28 }, () => 's = [s s];'), "feval('ok_target');", 'end', ''].join('\n');
    expect(refs('doubling.m', doubling)).toEqual(['31 calls:ok_target']);
    // Generated code (a symbolic toolbox's) nests a sum a thousand deep: what the walk reads without
    // a dynamic call, it reads with one.
    for (const n of [600, 1000, 1400]) {
      const sum = Array.from({ length: n }, (_, i) => `a${i % 10}`).join(' + ');
      const head = 'function deep(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9)';
      const plain = extractFromSource('deep.m', `${head}\nx = ${sum};\ndisp(x);\nend\n`, 'matlab');
      if (plain.errors.length > 0) continue;
      expect(refs('deep.m', `${head}\nx = ${sum};\nfeval('target_fn', x);\nend\n`)).toEqual(['3 calls:target_fn']);
    }
  });

  it('falls back to what is written when a loop nest is too deep to follow', () => {
    const lines = ['function nest(n)', "m = 'fn_a';"];
    for (let d = 0; d < 12; d++) lines.push(`for k${d} = 1:n`, "m = [m 'x'];");
    for (let d = 0; d < 12; d++) lines.push('end');
    lines.push('feval(m);', "feval('lit_fn');", 'end', '');
    expect(called(lines.join('\n'), 'nest.m')).toEqual(['lit_fn']);
  });

  it('grows text built a line at a time no faster than the code', () => {
    const time = (n: number): number => {
      const lines = ['function grow()', "s = '';"];
      for (let i = 0; i < n; i++) lines.push("s = [s 'some generated text of about forty chars'];");
      lines.push('eval(s);', 'end', '');
      const src = lines.join('\n');
      extractFromSource('grow.m', src, 'matlab');
      const t = performance.now();
      extractFromSource('grow.m', src, 'matlab');
      return performance.now() - t;
    };
    const small = time(1500);
    const large = time(6000);
    // Four times the code: linear is about four times the time; the quadratic growth this guards against was over ten.
    expect(large).toBeLessThan(7 * small + 100);
  }, 60_000);
});

describe('MATLAB sync of a file whose eval\'d code changes', () => {
  it('ends where a fresh index of the same files does', async () => {
    const root = tempDir('cg-matlab-dyn-sync-');
    const freshRoot = tempDir('cg-matlab-dyn-fresh-');
    const initial = {
      'main.m': "function main()\neval('helper(1)');\nend\n",
      'helper.m': fn('helper'),
      'other.m': fn('other'),
      'setup_vars.m': 'x = 1;\n',
    };
    const steps: Array<Record<string, string | null>> = [
      { 'main.m': "function main()\neval('other(1)');\nuicontrol('Callback', 'setup_vars');\nend\n" },
      { 'other.m': null },
      { 'other.m': fn('other'), 'main.m': "function main()\nm = 'helper';\nfeval(m);\nend\n" },
    ];
    const final: Record<string, string | null> = { ...initial };
    writeTree(root, initial);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const seen = [allEdges(cg)];
      for (const step of steps) {
        writeTree(root, step);
        Object.assign(final, step);
        await cg.sync();
        seen.push(allEdges(cg));
      }
      expect(seen).toEqual([
        ['main.m main -calls-> helper @ helper.m'],
        ['main.m main -calls-> other @ other.m', 'main.m main -references-> setup_vars.m @ setup_vars.m'],
        ['main.m main -references-> setup_vars.m @ setup_vars.m'],
        ['main.m main -calls-> helper @ helper.m'],
      ]);
      writeTree(freshRoot, Object.fromEntries(Object.entries(final).filter(([, c]) => c !== null)) as Record<string, string>);
      const fresh = await CodeGraph.init(freshRoot, { index: true });
      try {
        expect(seen[seen.length - 1]).toEqual(allEdges(fresh));
      } finally {
        fresh.close();
      }
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});

describe('MATLAB interpretation cost', () => {
  it('follows a function of thousands of statements, branches and loops in well under a second, in time linear in its size', () => {
    const source = (n: number): string => {
      const lines = ['function big(x, n)'];
      for (let i = 0; i < n; i++) {
        lines.push(`m${i % 40} = 'Pass${i % 40}';`);
        lines.push(`if x > ${i}`);
        lines.push(`    for k = 1:n`);
        lines.push(`        if k == ${i % 7}, m${i % 40} = [m${i % 40} '_k']; end`);
        lines.push(`        s.f${i % 9} = {m${i % 40}, 'Other${i % 5}'};`);
        lines.push(`    end`);
        lines.push(`else`);
        lines.push(`    t${i} = sprintf('%s_%d', m${i % 40}, k);`);
        lines.push(`end`);
      }
      lines.push(`m0 = 'Last';`, `feval(m0, x);`, 'end', '');
      return lines.join('\n');
    };
    const host = (code: string): InterpHost => ({
      source: code,
      mfilename: () => null,
      isLocal: () => false,
      handle: () => null,
      named: () => null,
      isFileFunction: () => false,
      code: () => null,
    });
    const options = { isFunction: true, inputs: new Set<string>(), shared: () => false };
    const run = (n: number): { ms: number; reachedEnd: boolean } => {
      const code = source(n);
      const tree = getParser('matlab')!.parse(code)!;
      try {
        const fnNode = tree.rootNode.namedChildren.find((c) => c?.type === 'function_definition')!;
        interpretScope(fnNode, options, host(code)); // warm up
        const t = performance.now();
        const values = interpretScope(fnNode, options, host(code));
        // The walk got to the end (it was not cut off): the last feval's name is known.
        return { ms: performance.now() - t, reachedEnd: [...values.values()].some((v) => v.strs.includes('Last')) };
      } finally {
        tree.delete();
      }
    };
    const small = run(150);
    const large = run(600);
    expect(small.reachedEnd && large.reachedEnd).toBe(true);
    expect(large.ms).toBeLessThan(1000);
    // Four times the statements: about four times the time, not sixteen.
    expect(large.ms).toBeLessThan(7 * small.ms + 50);
  }, 60_000);
});
