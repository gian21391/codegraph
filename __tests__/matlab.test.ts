/**
 * MATLAB: `.m` detection (shared with Objective-C), extraction, and MATLAB's
 * own name lookup (local → private → path/import, packages, superclasses).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { extractFromSource, preloadLanguagesForFiles } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars, isLanguageSupported } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('MATLAB .m detection', () => {
  it('reads MATLAB-shaped .m files as MATLAB', () => {
    expect(detectLanguage('main.m', 'function r = main(n)\n  r = n;\nend\n')).toBe('matlab');
    expect(detectLanguage('+geom/Circle.m', 'classdef Circle < handle\nend\n')).toBe('matlab');
    expect(detectLanguage('run_all.m', '% Run everything\nx = 5;\ndisp(x)\n')).toBe('matlab');
    expect(detectLanguage('setup.m', 'clc; clear all; close all\nx = 1;\n')).toBe('matlab');
    expect(detectLanguage('bom.m', '\uFEFFfunction f()\r\nend\r\n')).toBe('matlab');
    // A script of bare statements, its comments only trailing.
    expect(detectLanguage('world3d.m', 'c_obs = zeros(100, 100, 100);\nc_obs(:,:,75:80) = 1;   % top floor\n')).toBe('matlab');
    expect(detectLanguage('make.m', "fprintf('** building\\n');\nmex frne.c ne.c vmath.c\n")).toBe('matlab');
    expect(isLanguageSupported('matlab')).toBe(true);
  });

  it('keeps Objective-C .m files Objective-C', () => {
    expect(detectLanguage('AppDelegate.m')).toBe('objc');
    expect(detectLanguage('AppDelegate.m', '#import "AppDelegate.h"\n@implementation AppDelegate\n@end\n')).toBe('objc');
    // A `%` format string or a C `end` variable never flips a file with an Objective-C shape.
    expect(detectLanguage('Log.m', '#include <stdio.h>\nvoid f(void) {\n  printf("%d", 1);\n}\n')).toBe('objc');
    expect(detectLanguage('Cat.m', '@interface Foo (Bar)\n- (void)baz;\n@end\n% not matlab\n')).toBe('objc');
    // Plain C with no directive at all, and an empty file: the extension's mapping stands.
    expect(detectLanguage('plain.m', 'int x = 1;\n')).toBe('objc');
    expect(detectLanguage('plain.m', 'NSInteger add(NSInteger a, NSInteger b) {\n  return a + b;\n}\n')).toBe('objc');
    expect(detectLanguage('empty.m', '')).toBe('objc');
    expect(detectLanguage('empty.m', '\n\n')).toBe('objc');
  });

  it('honours an explicit codegraph.json mapping for .m', () => {
    expect(detectLanguage('main.m', 'function r = main(n)\nend\n', { '.m': 'objc' })).toBe('objc');
  });

  it('preloads the MATLAB grammar whenever a .m file is present', () => {
    expect(preloadLanguagesForFiles(['src/Foo.m'])).toContain('matlab');
    expect(preloadLanguagesForFiles(['src/Foo.m'], { '.m': 'objc' })).not.toContain('matlab');
  });
});

describe('MATLAB extraction', () => {
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
      'imports:geom',
    ]));
    // Variables are indexed, not called.
    expect(refs).not.toContain('calls:data');
    expect(refs).not.toContain('calls:x');
    expect(refs).toContain('calls:s.items'); // left to the resolver, which wants an unambiguous method
    expect(result.nodes.find((n) => n.kind === 'import')?.name).toBe('geom.*');
  });
});

describe('MATLAB resolution', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-'));
    const files: Record<string, string> = {
      '+geom/Shape.m': `classdef (Abstract) Shape < handle
    methods
        function d = describe(obj)
            d = class(obj);
        end
    end
end
`,
      '+geom/Circle.m': `classdef Circle < geom.Shape
    properties
        R
    end
    methods
        function obj = Circle(r)
            obj.R = r;
        end
        function a = area(obj)
            obj.describe();
            a = pi * obj.R^2;
        end
    end
    methods (Static)
        function c = unit()
            c = geom.Circle(1);
        end
    end
end
`,
      '+geom/+util/scale.m': `function y = scale(x)
    y = clampIt(x * 2);
end

function v = clampIt(v)
    v = min(v, 10);
end
`,
      'main.m': `function main()
    c = geom.Circle(3);
    a = c.area();
    u = geom.Circle.unit();
    s = geom.util.scale(a);
    helper(s);
    secret(s);
    clampIt(s);
    arrayfun(@helper, 1:3);
end

function helper(x)
    disp(x);
end
`,
      '+geom/Logger.m': `classdef Logger < handle
    properties
        items
    end
    methods
        function error(obj, msg)
            disp(msg);
        end
    end
end
`,
      '+geom/Bag.m': `classdef Bag < handle
    methods
        function v = items(obj)
            v = 1;
        end
    end
end
`,
      'report.m': `function report(shape, s)
    shape.describe();
    s.items(1);
    error('bad');
end
`,
      '@Robot/Robot.m': `classdef Robot < handle
    properties
        Q
    end
    methods
        function r = Robot()
            r.Q = 0;
        end
    end
end
`,
      '@Robot/move.m': `function move(r, x)
    step(r, x);
    plot(x, x);
end
`,
      '@Robot/step.m': `function step(r, x)
    r.Q = r.Q + x;
end
`,
      '@Robot/plot.m': `function plot(r)
    disp(r.Q);
end
`,
      'private/secret.m': `function secret(x)
    disp(x);
end
`,
      'other.m': `function other()
    helper(1);
end

function helper(x)
    disp(x + 1);
end
`,
      'ObjC.m': `#import "ObjC.h"
@implementation ObjC
- (void)run {}
@end
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `kind target-qualified-name @ target-file` of every edge out of a file's symbols. */
  function edgesFrom(file: string, symbol?: string): string[] {
    const ids = cg.getNodesInFile(file).filter((n) => !symbol || n.name === symbol).map((n) => n.id);
    return cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind !== 'contains')
      .map((e) => {
        const t = cg.getNode(e.target)!;
        return `${e.kind} ${t.qualifiedName} @ ${t.filePath}`;
      })
      .sort();
  }

  it('indexes MATLAB and Objective-C .m files side by side', () => {
    const lang = (p: string) => cg.getFiles().find((f) => f.path === p)?.language;
    expect(lang('main.m')).toBe('matlab');
    expect(lang('ObjC.m')).toBe('objc');
  });

  it('follows MATLAB lookup: own file, private folder, packages, constructors and static methods', () => {
    expect(edgesFrom('main.m', 'main')).toEqual([
      'calls geom::Circle::area @ +geom/Circle.m',
      'calls geom::Circle::unit @ +geom/Circle.m',
      'calls geom::util::scale @ +geom/+util/scale.m',
      'calls helper @ main.m',
      'calls secret @ private/secret.m',
      'instantiates geom::Circle @ +geom/Circle.m',
      'references helper @ main.m', // @helper
    ]);
  });

  it('never reaches another file\'s local function', () => {
    // main.m calls clampIt, which only scale.m defines — as a local function.
    expect(edgesFrom('main.m').some((e) => e.includes('clampIt'))).toBe(false);
    expect(edgesFrom('+geom/+util/scale.m', 'scale')).toEqual(['calls geom::util::clampIt @ +geom/+util/scale.m']);
    // other.m's helper is its own, not main.m's.
    expect(edgesFrom('other.m', 'other')).toEqual(['calls helper @ other.m']);
  });

  it('links a method on an untyped variable only when it is unambiguous', () => {
    // describe: one class defines it. items: a property shares the name. error: a built-in.
    expect(edgesFrom('report.m', 'report')).toEqual(['calls geom::Shape::describe @ +geom/Shape.m']);
  });

  it('reads a class folder\'s files as its methods, called on the object', () => {
    // plot(x, x) is the built-in, though the class overloads plot.
    expect(edgesFrom('@Robot/move.m', 'move')).toEqual(['calls Robot::step @ @Robot/step.m']);
    expect(cg.getNodesInFile('@Robot/step.m').find((n) => n.name === 'step')?.kind).toBe('method');
  });

  it('codegraph_explore reaches a class folder\'s method files from "Class method" queries', async () => {
    // `step` is a bare lowercase word with nothing else named in step.m; the
    // query naming Robot is what corroborates it.
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Robot move step' });
    const text = res.content[0]!.text;
    const sourced = [...text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
    // Named methods take the named-first tier, ahead of the class file.
    expect(sourced.slice(0, 2).sort()).toEqual(['@Robot/move.m', '@Robot/step.m']);
  });

  it('resolves inherited methods and superclasses through the classdef', () => {
    expect(edgesFrom('+geom/Circle.m', 'Circle').filter((e) => e.startsWith('extends'))).toEqual([
      'extends geom::Shape @ +geom/Shape.m',
    ]);
    expect(edgesFrom('+geom/Circle.m', 'area')).toEqual(['calls geom::Shape::describe @ +geom/Shape.m']);
  });
});
