/**
 * MATLAB extraction semantics: what a function's frame makes of a name (its
 * variables, its own object, what a variable holds), superclass calls,
 * `catch`, lambdas, `Name=Value` arguments, imports, the built-ins left out,
 * class signatures and attributes, Octave files, and `.m` detection against
 * Objective-C.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, getParser, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { matlabPathScope } from '../src/extraction/languages/matlab-path';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** `kind:name <- from-qualified-name` of every ref a file emits, in source order. */
function refs(file: string, code: string): string[] {
  const r = extractFromSource(file, code, 'matlab');
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  return r.unresolvedReferences.map((u) => `${u.referenceKind}:${u.referenceName} <- ${byId.get(u.fromNodeId)?.qualifiedName}`);
}

/**
 * Asserts `subject` extracts about as fast as `control`, a file of the same
 * size without the shape under test: within 2.5× (a cost per name × per scope
 * makes it ~6× at these sizes; linear, ~1×). The two run interleaved and the
 * fastest of each counts, so a loaded machine slows both alike.
 */
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

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `source-qn -kind-> target-qn @ target-file` of every non-`contains` edge out of a file. */
function edgesFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains')
    .map((e) => `${cg.getNode(e.source)!.qualifiedName} -${e.kind}-> ${cg.getNode(e.target)!.qualifiedName} @ ${cg.getNode(e.target)!.filePath}`)
    .sort();
}

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
  });

  it('extracts a function with many variables and many lambdas in linear time', () => {
    // Each lambda's frame looks its enclosing variables up, never copies them.
    const lines = (lambda: boolean): string => {
      const out = ['function big(a)'];
      for (let i = 0; i < 8000; i++) out.push(`  v${i} = cellfun(${lambda ? `@(q${i}) ` : ''}q${i} + w${i % 7}, a);`);
      return [...out, 'end', ''].join('\n');
    };
    expectAsFastAs('big.m', lines(true), lines(false));
  });
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
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-self-')));
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
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-super-')));
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
  it('leaves out bare calls to the hottest built-ins, never a class\'s own overload or a handle', () => {
    const code = `classdef K < handle
    methods
        function r = go(obj, x)
            n = numel(x) + size(x, 1) + pi;
            r = zeros(n, 1);
            k = numel(obj);
            disp(obj);
            h = @size;
            if isempty(x), error('empty'); end
            mine(x);
        end
    end
end
`;
    expect(refs('K.m', code)).toEqual([
      'calls:K::numel <- K::go',
      'calls:K::disp <- K::go',
      'function_ref:size <- K::go',
      'calls:mine <- K::go',
    ]);
  });

  it('keeps a built-in call whose first argument holds a known class, as a call on that class (its overload may be the target)', () => {
    const code = 'function f(x)\n    c = Shape(2);\n    disp(c);\n    numel(c);\n    area(c);\n    disp(x);\n    numel(x, 2);\nend\n';
    const r = extractFromSource('f.m', code, 'matlab');
    // The written name rides along: MATLAB looks it up as a function when the class has no such method.
    expect(r.unresolvedReferences.map((u) => `${u.referenceName} ${JSON.stringify(u.candidates ?? null)}`)).toEqual([
      'Shape null',
      'Shape::disp ["disp"]',
      'Shape::numel ["numel"]',
      'Shape::area ["area"]',
    ]);
  });
});

describe('MATLAB function files', () => {
  it('names a file\'s primary function by the file, keeping the declared name in its signature', () => {
    const r = extractFromSource('lib/foo.m', 'function y = bar(x)\ny = baz(x);\nend\nfunction z = baz(x)\nz = x;\nend\n', 'matlab');
    expect(r.nodes.filter((n) => n.kind === 'function').map((n) => `${n.qualifiedName} ${n.isExported} ${n.signature}`)).toEqual([
      'foo true function y = bar(x)',
      'baz false function z = baz(x)',
    ]);
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
    for (const base of ['uint8', 'int32', 'double', 'single', 'logical', 'char']) {
      expect(refs('C.m', `classdef C < ${base}\nend\n`)).toEqual([]);
    }
  });

  it('marks a method abstract only in a `methods (Abstract)` block', () => {
    const code = `classdef Pt
    methods
        d = norm2(obj)
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
    expect(flags('norm2')).toEqual({ abstract: false, static: false });
    expect(flags('origin')).toEqual({ abstract: false, static: true });
    expect(flags('area')).toEqual({ abstract: true, static: false });
  });

  describe('indexed', () => {
    let root = '';
    let cg: CodeGraph;
    beforeAll(async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-bases-')));
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
    // The usual GPL header: `if not, write to …` reads as an unclosed `if`.
    const code = [
      '## Copyright (C) 2000 A. Author',
      '##',
      '## This program is free software; you can redistribute it and/or modify',
      '## it under the terms of the GNU General Public License as published by',
      '## the Free Software Foundation; either version 2 of the License, or',
      '## (at your option) any later version.',
      '##',
      '## You should have received a copy of the GNU General Public License',
      '## along with this program; if not, write to the Free Software',
      '## Foundation, Inc.',
      '',
      '## -*- texinfo -*-',
      '## @deftypefn {Function File} {} stamp',
      '## Returns the time stamp.',
      '## @end deftypefn',
      '',
      'function t = stamp',
      '  ## seconds since the epoch',
      '  t = (time - mktime(gmtime(0)))/86400;',
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
    const code = 'for k = 1:3;\n  q = Quaternion(k);\n  q.inv();\n  while getpv(k)<0.1\n';
    expect(getParser('matlab')!.parse(code)!.rootNode.type).toBe('ERROR');
    expect(refs('f.m', code)).toEqual(['calls:Quaternion <- f.m', 'calls:Quaternion::inv <- f.m', 'calls:getpv <- f.m']);
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

describe('.m detection hardening', () => {
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
