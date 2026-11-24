/**
 * MATLAB object dispatch: a base class's method reaches the subclasses that
 * override it, a call on a method's own object of a method only subclasses
 * define reaches theirs, a member written without an argument list is a call
 * when the head says whose member it is (and a read of a property otherwise
 * leaves nothing behind), and a parameter named like one of the classes that
 * define a method is taken for that class's object. Each case has its silent
 * counterpart, and a sync of each ends where a fresh index does.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { ExtractionOrchestrator, extractFromSource } from '../src/extraction';
import { PARKED_MATLAB_MEMBER_READ_SQL, QueryBuilder } from '../src/db/queries';
import { isParkedMatlabMemberRow } from '../src/resolution/matlab-failures';
import { MATLAB_CARRIER_STEP_KEY, matlabNameScan } from '../src/resolution/matlab-builtin-carriers';
import { ReferenceResolver } from '../src/resolution';
import { matchMatlabReference } from '../src/resolution/matlab-lookup';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import { ToolHandler } from '../src/mcp/tools';
import { allEdges, dormantRows, indexOfProject, edgesOfProject, syncedAndFresh, syncedAndFreshEachStep, tempDir, unresolvedRows, useAllGrammars, writeTree, type SyncedStep } from './matlab-helpers';

useAllGrammars();

type Queries = ConstructorParameters<typeof ReferenceResolver>[1];

/** `line kind:name [facts]` of every reference a MATLAB file emits. */
function refs(file: string, code: string): string[] {
  const r = extractFromSource(file, code, 'matlab');
  expect(r.errors).toEqual([]);
  return r.unresolvedReferences.map((u) => `${u.line} ${u.referenceKind}:${u.referenceName}${u.candidates?.length ? ` [${u.candidates.join(',')}]` : ''}`);
}

/** The synthesized edges of a project: `source -> target (synthesizedBy)`, sorted. */
async function synthesized(files: Record<string, string>): Promise<string[]> {
  const root = tempDir('cg-matlab-dispatch-');
  try {
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const out: string[] = [];
      for (const f of cg.getFiles()) {
        for (const e of cg.getOutgoingEdgesFrom(cg.getNodesInFile(f.path).map((n) => n.id))) {
          const by = (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy;
          if (e.provenance !== 'heuristic' || typeof by !== 'string' || !by.startsWith('matlab-') || by === 'matlab-argument') continue;
          out.push(`${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName} @ ${cg.getNode(e.target)!.filePath} (${by})`);
        }
      }
      return out.sort();
    } finally {
      cg.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** explore's "Dynamic-dispatch links" section of `text`, '' when it has none. */
function dispatchLinks(text: string): string {
  const at = text.indexOf('**Dynamic-dispatch links');
  if (at < 0) return '';
  const end = text.indexOf('\n**', at + 2);
  return text.slice(at, end < 0 ? undefined : end);
}

const cls = (name: string, sup: string, body = ''): string => `classdef ${name}${sup ? ` < ${sup}` : ''}\n    methods\n${body}    end\nend\n`;
const method = (sig: string, body = ''): string => `        function ${sig}\n${body}        end\n`;

// The gapfix project's classes (S2/gapfix): Base.m / Sub.m, Model.m, +pkg/pf.m.
const BASE = 'classdef Base < handle\n    events\n        Changed\n    end\n    methods\n        function run(obj)\n            obj.step();\n        end\n        function step(obj)\n        end\n    end\nend\n';
const SUB = 'classdef Sub < Base\n    methods\n        function step(obj)\n            helperSub();\n        end\n    end\nend\n';
const MODEL = [
  'classdef Model < handle',
  '    properties',
  '        Gain',
  '    end',
  '    properties (Dependent)',
  '        Total',
  '    end',
  '    methods',
  '        function y = predict(obj, x)',
  '            y = x * obj.Gain;',
  '        end',
  '        function reset(obj)',
  '        end',
  '        function v = compute(obj)',
  '            v = 1;',
  '        end',
  '        function v = get.Total(obj)',
  '            v = depHelper();',
  '        end',
  '        function r = plus(a, b)',
  '            r = Model();',
  '        end',
  '    end',
  '    methods (Static)',
  '        function s = make()',
  '            s = Model();',
  '        end',
  '    end',
  'end',
  '',
].join('\n');
const GAPFIX = {
  'Base.m': BASE,
  'Sub.m': SUB,
  'helperSub.m': 'function helperSub()\nend\n',
  'depHelper.m': 'function v = depHelper()\nv = 1;\nend\n',
  'Model.m': MODEL,
  '+pkg/pf.m': 'function v = pf()\nv = 1;\nend\n',
};

describe('MATLAB base → override (G2)', () => {
  it('links a base method to the override, from the base class\'s self call on (gapfix Base.m / Sub.m)', async () => {
    const edges = await edgesOfProject(GAPFIX);
    expect(edges.filter((e) => /^(Base|Sub)\.m /.test(e))).toEqual([
      'Base.m Base::run -calls-> Base::step @ Base.m',
      'Base.m Base::step -calls-> Sub::step @ Sub.m',
      'Sub.m Sub -extends-> Base @ Base.m',
      'Sub.m Sub::step -calls-> helperSub @ helperSub.m',
    ]);
    expect(await synthesized(GAPFIX)).toEqual(['Base::step -> Sub::step @ Sub.m (matlab-override)']);
  });

  it('links from every superclass that defines the method, and from an abstract declaration', async () => {
    const out = await synthesized({
      'A.m': 'classdef A < handle\n    methods (Abstract)\n        y = area(obj)\n    end\nend\n',
      'B.m': cls('B', 'handle', method('area(obj)')),
      'C.m': cls('C', 'A & B', method('y = area(obj)', '            y = 1;\n')),
    });
    expect(out).toEqual(['A::area -> C::area @ C.m (matlab-override)', 'B::area -> C::area @ C.m (matlab-override)']);
  });

  it('links direct supers only, so a chain composes, and through a class between that does not define it', async () => {
    expect(await synthesized({
      'A.m': cls('A', 'handle', method('step(obj)')),
      'B.m': cls('B', 'A', method('step(obj)')),
      'C.m': cls('C', 'B', method('step(obj)')),
    })).toEqual(['A::step -> B::step @ B.m (matlab-override)', 'B::step -> C::step @ C.m (matlab-override)']);
    // A < handle declares step, B < A does not, C < B does: from the nearest one up.
    expect(await synthesized({
      'A.m': 'classdef A < handle\n    methods (Abstract)\n        step(obj)\n    end\nend\n',
      'B.m': cls('B', 'A', method('other(obj)')),
      'C.m': cls('C', 'B', method('step(obj)')),
    })).toEqual(['A::step -> C::step @ C.m (matlab-override)']);
  });

  it('links no constructor, accessor, static or private method', async () => {
    expect(await synthesized({
      'A.m': [
        'classdef A < handle',
        '    properties',
        '        X',
        '    end',
        '    methods',
        '        function obj = A()',
        '        end',
        '        function v = get.X(obj)',
        '            v = 1;',
        '        end',
        '        function set.X(obj, v)',
        '        end',
        '    end',
        '    methods (Static)',
        '        function s = make()',
        '            s = 1;',
        '        end',
        '    end',
        '    methods (Access = private)',
        '        function hidden(obj)',
        '        end',
        '    end',
        '    methods (Hidden)',
        '        function tucked(obj)',
        '        end',
        '    end',
        'end',
        '',
      ].join('\n'),
      'B.m': [
        'classdef B < A',
        '    properties',
        '        X',
        '    end',
        '    methods',
        '        function obj = B()',
        '            obj@A();',
        '        end',
        '        function v = get.X(obj)',
        '            v = 2;',
        '        end',
        '        function set.X(obj, v)',
        '        end',
        '        function hidden(obj)',
        '        end',
        '        function tucked(obj)',
        '        end',
        '    end',
        '    methods (Static)',
        '        function s = make()',
        '            s = 2;',
        '        end',
        '    end',
        'end',
        '',
      ].join('\n'),
    })).toEqual(['A::tucked -> B::tucked @ B.m (matlab-override)']);
  });

  it('links class-folder methods by their own files, and a classdef method overridden in a class folder', async () => {
    expect(await synthesized({
      '@Shape/Shape.m': 'classdef Shape < handle\n    methods\n        a = area(obj)\n        function d = describe(obj)\n            d = obj.area();\n        end\n    end\nend\n',
      '@Shape/area.m': 'function a = area(obj)\na = 0;\nend\n',
      '@Circle/Circle.m': 'classdef Circle < Shape\nend\n',
      '@Circle/area.m': 'function a = area(obj)\na = 1;\nend\n',
      '@Circle/describe.m': 'function d = describe(obj)\nd = 2;\nend\n',
    })).toEqual([
      'Shape::area -> Circle::area @ @Circle/area.m (matlab-override)',
      'Shape::describe -> Circle::describe @ @Circle/describe.m (matlab-override)',
    ]);
  });

  it('gives an old-style @Cls class no override edge: it has no superclass the index reads', async () => {
    expect(await synthesized({
      '@Animal/Animal.m': "function a = Animal()\na = class(struct(), 'Animal');\nend\n",
      '@Animal/speak.m': 'function speak(a)\nend\n',
      '@Dog/Dog.m': "function d = Dog()\nd = class(struct(), 'Dog', Animal());\nend\n",
      '@Dog/speak.m': 'function speak(d)\nend\n',
    })).toEqual([]);
  });

  it('labels the hop in synthesized-hop', () => {
    const at = { source: 'a', target: 'b', kind: 'calls' as const, provenance: 'heuristic' as const };
    expect(describeSynthesizedHop({ ...at, metadata: { synthesizedBy: 'matlab-override', registeredAt: 'Sub.m:3' } })).toEqual({ summary: 'base → override', detail: '', registeredAt: 'Sub.m:3' });
    expect(describeSynthesizedHop({ ...at, metadata: { synthesizedBy: 'matlab-subclass-method' } })?.summary).toBe('self call → subclass method');
  });

  it('shows the hop in codegraph_explore\'s Flow: Solve → main → the subclass\'s main', async () => {
    const root = tempDir('cg-matlab-dispatch-flow-');
    writeTree(root, {
      'ALGORITHM.m': cls('ALGORITHM', 'handle', method('Solve(obj, Problem)', '            obj.main(Problem);\n') + method('main(obj, Problem)')),
      'EvoA.m': cls('EvoA', 'ALGORITHM', method('main(Algorithm, Problem)', '            disp(1);\n')),
      // More overrides than a name keeps unfiltered: the one the query names is the one kept.
      ...Object.fromEntries(['EvoC', 'EvoD', 'EvoB'].map((a) => [`${a}.m`, cls(a, 'ALGORITHM', method('main(Algorithm, Problem)', '            disp(2);\n'))])),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'Solve EvoA main' })).content[0]!.text;
      const flow = text.slice(text.indexOf('Flow'), text.indexOf('Flow') + 600);
      expect(flow).toMatch(/1\. Solve \(ALGORITHM\.m:3\)\n.*calls\n2\. main \(ALGORITHM\.m:6\)\n.*dynamic: base → override @EvoA\.m:3\n3\. main \(EvoA\.m:3\)/);
      expect(text).not.toMatch(/use Read|Read the/);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB self call of a method only subclasses define', () => {
  const VEHICLE = cls('Vehicle', 'handle', method('run(veh, u)', '            [t, y] = ode45(@(t, y) veh.dxstate(t, y, u), [0 1], 0);\n'));
  const SUBS = {
    'Tandem.m': cls('Tandem', 'Vehicle', method('d = dxstate(veh, t, y, u)', '            d = 1;\n')),
    'Trike.m': cls('Trike', 'Vehicle', method('d = dxstate(veh, t, y, u)', '            d = 2;\n')),
  };

  it('links the call to each subclass\'s definition, nearest down each line (Vehicle::dxstate)', async () => {
    expect(await synthesized({
      'Vehicle.m': VEHICLE,
      ...SUBS,
      // Below Tandem, its own override takes over.
      'Racer.m': cls('Racer', 'Tandem', method('d = dxstate(veh, t, y, u)', '            d = 3;\n')),
    })).toEqual([
      'Tandem::dxstate -> Racer::dxstate @ Racer.m (matlab-override)',
      'Vehicle::run -> Tandem::dxstate @ Tandem.m (matlab-subclass-method)',
      'Vehicle::run -> Trike::dxstate @ Trike.m (matlab-subclass-method)',
    ]);
  });

  it('links nothing for a call on a variable of no stated class, and nothing extra when the class defines the method', async () => {
    expect(await synthesized({
      'drive.m': 'function drive(veh)\nveh.dxstate(0, 0, 0);\nend\n',
      'Vehicle.m': cls('Vehicle', 'handle', method('stop(veh)')),
      ...SUBS,
    })).toEqual([]);
    expect(await synthesized({
      'Vehicle.m': cls('Vehicle', 'handle', method('run(veh, u)', '            veh.dxstate(0, 0, u);\n') + method('d = dxstate(veh, t, y, u)', '            d = 0;\n')),
      ...SUBS,
    })).toEqual([
      'Vehicle::dxstate -> Tandem::dxstate @ Tandem.m (matlab-override)',
      'Vehicle::dxstate -> Trike::dxstate @ Trike.m (matlab-override)',
    ]);
  });
});

describe('MATLAB member written without an argument list (G1)', () => {
  it('links a method on a variable the function constructs, a static method and a package function (gapfix g01, g02)', async () => {
    const edges = await edgesOfProject({
      ...GAPFIX,
      'g01_dotcall_noparens.m': 'function g01_dotcall_noparens()\nm = Model();\nm.reset;\nx = m.compute;\nend\n',
      'g02_static_noparens.m': 'function g02_static_noparens()\ns = Model.make;\nv = pkg.pf;\nend\n',
    });
    expect(edges.filter((e) => e.startsWith('g0'))).toEqual([
      'g01_dotcall_noparens.m g01_dotcall_noparens -calls-> Model::compute @ Model.m',
      'g01_dotcall_noparens.m g01_dotcall_noparens -calls-> Model::reset @ Model.m',
      'g01_dotcall_noparens.m g01_dotcall_noparens -instantiates-> Model @ Model.m',
      'g02_static_noparens.m g02_static_noparens -calls-> Model::make @ Model.m',
      'g02_static_noparens.m g02_static_noparens -calls-> pkg::pf @ +pkg/pf.m',
    ]);
  });

  it('links a method on the method\'s own object, and leaves a read of its property no edge and no row', async () => {
    const { edges, unresolved } = await indexOfProject({
      'Gen.m': cls('Gen', 'handle', method('all(GQbld)', '            [t, allTq] = GQbld.mkpose;\n            if GQbld.verbose\n            end\n            g = GQbld.Gain;\n') + method('[t, a] = mkpose(GQbld)', '            t = 1; a = 2;\n')).replace('    methods\n', '    properties\n        Gain\n        verbose\n    end\n    methods\n'),
    });
    expect(edges).toEqual(['Gen.m Gen::all -calls-> Gen::mkpose @ Gen.m']);
    expect(unresolved).toEqual([]);
  });

  it('keeps a Dependent property read unlinked, with no row (gapfix g10)', async () => {
    const { edges, unresolved } = await indexOfProject({ ...GAPFIX, 'g10_dependent.m': 'function g10_dependent()\nm = Model();\nt = m.Total;\nend\n' });
    expect(edges.filter((e) => e.startsWith('g10'))).toEqual(['g10_dependent.m g10_dependent -instantiates-> Model @ Model.m']);
    expect(unresolved.filter((r) => r.startsWith('g10'))).toEqual([]);
  });

  it('reads a constant, an enumeration member and an inherited property: no edge, and a row only where a method elsewhere has the name', async () => {
    const { edges, unresolved } = await indexOfProject({
      'Limits.m': 'classdef Limits\n    properties (Constant)\n        MAX = 3\n    end\nend\n',
      'Color.m': 'classdef Color\n    enumeration\n        Red, Green\n    end\nend\n',
      'Base.m': 'classdef Base < handle\n    properties\n        Rate\n    end\nend\n',
      'Sub.m': cls('Sub', 'Base', method('go(obj)', '            r = obj.Rate;\n            m = Limits.MAX;\n            c = Color.Red;\n')),
      // A method of another class shares the property's name: still a read,
      // whose row is kept for a sync that makes it a call (see matlab-failures).
      'Other.m': cls('Other', 'handle', method('r = Rate(obj)', '            r = 1;\n')),
    });
    expect(edges.filter((e) => e.startsWith('Sub.m Sub::go'))).toEqual([]);
    expect(unresolved).toEqual(['Sub.m:4 calls:Sub::Rate']);
  });

  it('links nothing on a variable of no stated class, even with one method of the name: a struct read (data.smprate, par.plot)', async () => {
    const { edges, unresolved } = await indexOfProject({
      'sigbox.m': cls('sigbox', 'handle', method('f = smprate(obj)', '            f = 1;\n')),
      'AcmeObj.m': cls('AcmeObj', 'handle', method('plot(obj)')),
      'tk_remove.m': 'function tk_remove(data)\nfs = data.smprate;\nend\n',
      'monitor.m': 'function monitor(par)\nif par.plot\n  disp(1);\nend\nend\n',
    });
    expect(edges.filter((e) => /^(tk_remove|monitor)\.m /.test(e))).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('emits no reference for a command\'s argument, a deeper chain, an assignment target or an untyped local', () => {
    const code = [
      'function f(obj, p)',
      'delete core_dump_77413.log',
      'm = Model();',
      'x = m.p.q;',
      'm.reset = 1;',
      's = struct();',
      'y = s.field;',
      'z = p.field;',
      'w = gcf.Position;',
      'end',
      '',
    ].join('\n');
    expect(refs('f.m', code).filter((r) => !/:(delete|Model|struct)\b/.test(r))).toEqual([]);
  });

  it('emits no reference in a statement the parser could not read whole (a file listing in a .m file)', () => {
    const listing = '-rw-r--r--   1 someone staff  52817 Mar 3 09:12 core_dump_77413.log\n';
    const r = extractFromSource('notes.m', listing, 'matlab');
    expect(r.unresolvedReferences.filter((u) => u.referenceName.includes('core_dump'))).toEqual([]);
  });

  it('tags the reference bare, and on the own object self', () => {
    const code = cls('Gen', 'handle', method('all(GQbld)', '            GQbld.mkpose;\n            m = Model();\n            x = m.compute;\n            y = Model.make;\n'));
    expect(refs('Gen.m', code).filter((r) => / calls:/.test(r))).toEqual([
      '4 calls:Gen::mkpose [bare,self]',
      '5 calls:Model',
      '6 calls:Model::compute [bare]',
      '7 calls:Model::make [bare]',
    ]);
  });

  it('refuses a bare member on a variable of no stated class in the resolver too (a second fence)', async () => {
    const root = tempDir('cg-matlab-dispatch-fence-');
    writeTree(root, {
      'sigbox.m': cls('sigbox', 'handle', method('f = smprate(obj)', '            f = 1;\n')),
      'user.m': 'function user(data)\nfs = data.smprate(1);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const context = new ReferenceResolver(root, (cg as unknown as { queries: Queries }).queries).getResolutionContext();
      const user = cg.getNodesInFile('user.m').find((n) => n.kind === 'function')!;
      const ref = { fromNodeId: user.id, referenceName: 'data.smprate', referenceKind: 'calls' as const, line: 2, column: 5, filePath: 'user.m', language: 'matlab' as const };
      // Written with an argument list, the one class that defines it answers (as today).
      expect(matchMatlabReference(ref, context)?.targetNodeId).toBe(cg.getNodesInFile('sigbox.m').find((n) => n.name === 'smprate')!.id);
      expect(matchMatlabReference({ ...ref, candidates: ['bare'] }, context)).toBeNull();
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('links no member of an old-style @Cls class: its object is a struct, and `this.path` a field (an old-style @sigbox)', async () => {
    const { edges, unresolved } = await indexOfProject({
      '@sigbox/sigbox.m': "function D = sigbox(varargin)\nD = class(struct('path', '.'), 'sigbox');\nend\n",
      '@sigbox/path.m': 'function p = path(this)\np = this.path;\nend\n',
      '@sigbox/clone.m': 'function c = clone(this)\npth = this.path;\nc = pth;\nend\n',
    });
    expect(edges.filter((e) => e.includes('sigbox::path'))).toEqual([]);
    // A method carries the name: the rows stay, edgeless (a classdef rewrite would make them calls).
    expect(unresolved).toEqual(['@sigbox/clone.m:2 calls:sigbox::path', '@sigbox/path.m:2 calls:sigbox::path']);
  });

  it('links no member that is both a method and a property of the class (`n`)', async () => {
    const { edges, unresolved } = await indexOfProject({
      'ChainLink.m': cls('ChainLink', 'handle', method('go(robot)', '            k = robot.n;\n')).replace('    methods\n', '    properties\n        n\n    end\n    methods\n'),
      'Chain3.m': cls('Chain3', 'handle', method('k = n(obj)', '            k = 1;\n')),
    });
    expect(edges.filter((e) => e.startsWith('ChainLink.m ChainLink::go'))).toEqual([]);
    expect(unresolved).toEqual(['ChainLink.m:7 calls:ChainLink::n']);
  });
});

describe('MATLAB method on a variable of no stated class', () => {
  it('never takes a constructor for its method (`g.PathA(…)` on a LinkMesh)', async () => {
    const edges = await edgesOfProject({
      'PathA.m': cls('PathA', 'handle', method('obj = PathA(varargin)')),
      'plan.m': 'function plan(g)\np = g.PathA(1, 2);\nend\n',
    });
    expect(edges.filter((e) => e.startsWith('plan.m '))).toEqual([]);
  });
});

describe('MATLAB parameter named after its class (G3)', () => {
  const PROBLEMS = {
    'PROBLEM.m': cls('PROBLEM', 'handle', method('P = Evaluation(obj, X)', '            P = obj.ScoreAll(X);\n') + method('Y = ScoreAll(obj, X)', '            Y = X;\n')),
    'PRB3.m': cls('PRB3', 'PROBLEM', method('Y = ScoreAll(obj, X)', '            Y = 2 * X;\n')),
    'EvoE.m': cls('EvoE', 'handle', method('P = Evaluation(obj, X)', '            P = X;\n')),
  };

  it('takes the root class the parameter is named after, ignoring case, and the edge says so', async () => {
    const root = tempDir('cg-matlab-dispatch-g3-');
    writeTree(root, { ...PROBLEMS, 'EvoA.m': cls('EvoA', 'handle', method('main(Algorithm, Problem)', '            P = Problem.Evaluation(1);\n')) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const main = cg.getNodesInFile('EvoA.m').find((n) => n.name === 'main')!;
      const out = cg.getOutgoingEdgesFrom([main.id]).filter((e) => e.kind === 'calls');
      expect(out.map((e) => `${cg.getNode(e.target)!.qualifiedName} ${(e.metadata as Record<string, unknown>).via}`)).toEqual(['PROBLEM::Evaluation receiver-name']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
    // With G2: algorithm → Evaluation → the problem's ScoreAll.
    expect(await synthesized({ ...PROBLEMS })).toEqual(['PROBLEM::ScoreAll -> PRB3::ScoreAll @ PRB3.m (matlab-override)']);
  });

  it('takes no class for a local, a parameter the function fills a field of or reassigns, two matching roots or none', async () => {
    const calls = (body: string, extra: Record<string, string> = {}): Promise<string[]> =>
      edgesOfProject({ ...PROBLEMS, ...extra, 'alg.m': `function alg(Algorithm, Problem)\n${body}end\n` }).then((e) => e.filter((x) => x.startsWith('alg.m ') && x.includes('Evaluation')));
    expect(await calls('Problem.Evaluation(1);\n')).toEqual(['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m']);
    expect(await calls('problem = Algorithm;\nproblem.Evaluation(1);\n')).toEqual([]);
    expect(await calls('Problem.x = 1;\nProblem.Evaluation(1);\n')).toEqual([]);
    expect(await calls('Problem = Problem(2);\nProblem.Evaluation(1);\n')).toEqual([]);
    expect(await calls('Algorithm.Evaluation(1);\n')).toEqual([]);
    expect(await calls('Problem.Evaluation(1);\n', { '+two/Problem.m': cls('Problem', 'handle', method('P = Evaluation(obj, X)', '            P = X;\n')) })).toEqual([]);
  });

  it('takes no class for a lower-case parameter: a struct beside a class of its name (review case 5)', async () => {
    const edges = await edgesOfProject({
      'Model.m': cls('Model', 'handle', method('y = predict(obj, x)', '            y = x;\n')),
      'Tree.m': cls('Tree', 'handle', method('y = predict(obj, x)', '            y = 2 * x;\n')),
      'evalModel.m': 'function e = evalModel(model, X, t)\ne = model.predict(X) - t;\nend\n',
      'runit2.m': "function runit2()\ns.predict = @(x) 2 * x;\nevalModel(s, 1, 2);\nend\n",
    });
    expect(edges.filter((e) => e.startsWith('evalModel.m '))).toEqual([]);
    // Capitalised, it is taken (as `Problem` for `PROBLEM`).
    const upper = await edgesOfProject({
      'Model.m': cls('Model', 'handle', method('y = predict(obj, x)', '            y = x;\n')),
      'Tree.m': cls('Tree', 'handle', method('y = predict(obj, x)', '            y = 2 * x;\n')),
      'evalModel.m': 'function e = evalModel(Model, X, t)\ne = Model.predict(X) - t;\nend\n',
    });
    expect(upper.filter((e) => e.startsWith('evalModel.m '))).toEqual(['evalModel.m evalModel -calls-> Model::predict @ Model.m']);
  });

  it('marks the edge a guess (heuristic), labelled in the Flow, and a sync rebinds it like any resolved call', async () => {
    const root = tempDir('cg-matlab-dispatch-g3-mark-');
    writeTree(root, { ...PROBLEMS, 'EvoA.m': cls('EvoA', 'handle', method('main(Algorithm, Problem)', '            P = Problem.Evaluation(1);\n')) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const main = cg.getNodesInFile('EvoA.m').find((n) => n.name === 'main')!;
      const edge = cg.getOutgoingEdgesFrom([main.id]).find((e) => e.kind === 'calls')!;
      expect(edge.provenance).toBe('heuristic');
      expect(describeSynthesizedHop(edge)?.summary).toBe('receiver named after its class');
      const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'EvoA main PROBLEM Evaluation ScoreAll' })).content.map((c) => (c as { text: string }).text).join('\n');
      expect(text).toMatch(/1\. main \(EvoA\.m:3\)\n\s*↓ dynamic: receiver named after its class\n2\. Evaluation \(PROBLEM\.m:3\)/);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
    // A second class of the parameter's name, ignoring case, comes and goes: the edge goes and comes back.
    const steps = await syncedAndFreshEachStep(
      { ...PROBLEMS, 'alg.m': 'function alg(Algorithm, Problem)\nProblem.Evaluation(1);\nend\n' },
      { '+two/Problem.m': cls('Problem', 'handle', method('P = Evaluation(obj, X)', '            P = X;\n')) },
      { '+two/Problem.m': null },
      { 'PROBLEM.m': null },
      { 'PROBLEM.m': PROBLEMS['PROBLEM.m'] },
    );
    expect(steps.map((st) => st.synced.filter((e) => e.startsWith('alg.m ')))).toEqual([
      [],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
      ['alg.m alg -calls-> EvoE::Evaluation @ EvoE.m'],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
  }, 120_000);

  it('lists the edge as the resolved call it is, not among the synthesized dynamic-dispatch links (review 2, case 4)', async () => {
    const alg = (name: string): string => cls(name, 'ALG', method('main(obj, Problem)', '            P = Problem.Initialization();\n            Problem.Evaluation(P);\n'));
    const problem = (name: string, v: number): string =>
      cls(name, 'handle', method('P = Initialization(obj)', `            P = ${v};\n`) + method('P = Evaluation(obj, x)', '            P = x;\n'));
    const root = tempDir('cg-matlab-dispatch-g3-links-');
    writeTree(root, {
      'ALG.m': cls('ALG', 'handle', method('Solve(obj, Problem)', '            obj.main(Problem);\n') + method('main(obj, Problem)')),
      'NSG.m': alg('NSG'),
      'EVOB.m': alg('EVOB'),
      'EVOZ.m': alg('EVOZ'),
      'PROBLEM.m': problem('PROBLEM', 1),
      'Sampler.m': problem('Sampler', 2),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = ((await new ToolHandler(cg).execute('codegraph_explore', { query: 'Solve main Evaluation' })).content as Array<{ text: string }>).map((c) => c.text).join('\n');
      expect(text).toContain('PROBLEM.m');
      expect(dispatchLinks(text)).not.toMatch(/receiver named after its class|main → Evaluation/);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('takes no class for a problem.x = 1 struct', async () => {
    const edges = await edgesOfProject({ ...PROBLEMS, 'mk.m': 'function mk(problem)\nproblem.x = 1;\nproblem.Evaluation();\nend\n' });
    expect(edges.filter((e) => e.startsWith('mk.m '))).toEqual([]);
  });
});

describe('MATLAB dispatch through a sync ends where a fresh index does', () => {
  const A = cls('A', 'handle', method('run(obj)', '            obj.step();\n') + method('step(obj)'));
  const B = cls('B', 'A', method('step(obj)'));

  it('when a subclass that overrides is added, and the override removed', async () => {
    const r = await syncedAndFresh(
      { 'A.m': A },
      { 'B.m': B },
      { 'B.m': cls('B', 'A', method('other(obj)')) },
    );
    expect(r.steps.map((s) => s.filter((e) => e.includes('A::step -calls-> B::step')).length)).toEqual([0, 1, 0]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when a classdef line\'s superclass changes', async () => {
    const r = await syncedAndFresh(
      { 'A.m': A, 'B.m': B, 'C.m': cls('C', 'handle', method('step(obj)')) },
      { 'B.m': cls('B', 'C', method('step(obj)')) },
    );
    expect(r.synced.filter((e) => e.includes('-> B::step'))).toEqual(['C.m C::step -calls-> B::step @ B.m']);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when the base method comes later: the self call reaches the subclasses, then the base and its override', async () => {
    const vehicle = (extra: string): string => cls('Vehicle', 'handle', method('run(veh)', '            veh.dxstate(1);\n') + extra);
    const r = await syncedAndFresh(
      { 'Vehicle.m': vehicle(''), 'Tandem.m': cls('Tandem', 'Vehicle', method('dxstate(veh, t)')) },
      { 'Vehicle.m': vehicle(method('dxstate(veh, t)')) },
    );
    expect(r.steps).toEqual([
      ['Tandem.m Tandem -extends-> Vehicle @ Vehicle.m', 'Vehicle.m Vehicle::run -calls-> Tandem::dxstate @ Tandem.m'],
      ['Tandem.m Tandem -extends-> Vehicle @ Vehicle.m', 'Vehicle.m Vehicle::dxstate -calls-> Tandem::dxstate @ Tandem.m', 'Vehicle.m Vehicle::run -calls-> Vehicle::dxstate @ Vehicle.m'],
    ]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when the class a parameter is named after is added, or renamed', async () => {
    const problem = (name: string): string => cls(name, 'handle', method('P = Evaluation(obj, X)', '            P = X;\n'));
    const r = await syncedAndFresh(
      { 'alg.m': 'function alg(Algorithm, Problem)\nProblem.Evaluation(1);\nend\n', 'EvoE.m': problem('EvoE') },
      { 'PROBLEM.m': problem('PROBLEM') },
      { 'PROBLEM.m': null, 'PROB.m': problem('PROB') },
      { 'PROB.m': null, 'PROBLEM.m': problem('PROBLEM') },
    );
    expect(r.steps.map((s) => s.filter((e) => e.startsWith('alg.m ')))).toEqual([
      // One class defines it: that class's, whatever the parameter's name (as before).
      ['alg.m alg -calls-> EvoE::Evaluation @ EvoE.m'],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
      [],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
    ]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when a property is added with the name of a member read without an argument list', async () => {
    const r = await syncedAndFresh(
      { 'Model.m': cls('Model', 'handle', method('reset(obj)')), 'user.m': 'function user()\nm = Model();\nt = m.Total;\nend\n' },
      { 'Model.m': cls('Model', 'handle', method('reset(obj)')).replace('    methods\n', '    properties\n        Total\n    end\n    methods\n') },
    );
    expect(r.synced.filter((e) => e.includes('Total'))).toEqual([]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when a property is added with the name of a member read without an argument list that another class has a method of', async () => {
    const r = await syncedAndFresh(
      {
        'Model.m': cls('Model', 'handle', method('reset(obj)')),
        'Other.m': cls('Other', 'handle', method('t = Total(obj)', '            t = 1;\n')),
        'user.m': 'function user()\nm = Model();\nt = m.Total;\nend\n',
      },
      { 'Model.m': cls('Model', 'handle', method('reset(obj)')).replace('    methods\n', '    properties\n        Total\n    end\n    methods\n') },
    );
    // The row in user.m, which the sync left alone, goes as a fresh index's does.
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });

  it('when a method file is added under a class folder', async () => {
    const r = await syncedAndFresh(
      {
        '@Shape/Shape.m': cls('Shape', 'handle', method('d = describe(obj)', '            d = obj.area();\n') + method('a = area(obj)', '            a = 0;\n')),
        '@Circle/Circle.m': 'classdef Circle < Shape\nend\n',
      },
      { '@Circle/area.m': 'function a = area(obj)\na = 1;\nend\n' },
    );
    expect(r.synced.filter((e) => e.includes('-> Circle::area'))).toEqual(['@Shape/Shape.m Shape::area -calls-> Circle::area @ @Circle/area.m']);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  });
});

describe('MATLAB member call rows: kept while the member has a carrier, and a sync keeps that true', () => {
  const withProps = (code: string, props: string): string => code.replace('    methods\n', `    properties\n${props}    end\n    methods\n`);
  const expectEveryStepFresh = (steps: SyncedStep[]): void => {
    for (const step of steps) {
      expect(step.synced).toEqual(step.fresh);
      expect(step.syncedRows).toEqual(step.freshRows);
      expect(step.syncedDormant).toEqual(step.freshDormant);
    }
  };

  it('relinks a member read in a file the sync leaves alone when its property becomes a method (review case 1)', async () => {
    const user = 'function user()\nm = Model();\nt = m.Total;\ndisp(t);\nend\n';
    const steps = await syncedAndFreshEachStep(
      { 'Model.m': withProps(cls('Model', 'handle', method('reset(obj)')), '        Total\n'), 'user.m': user },
      { 'Model.m': cls('Model', 'handle', method('reset(obj)') + method('v = Total(obj)', '            v = 1;\n')) },
    );
    expect(steps[0]!.synced).toContain('user.m user -calls-> Model::Total @ Model.m');
    expectEveryStepFresh(steps);
  });

  it('relinks it too when another class already had a method of the name: the row was kept, edgeless', async () => {
    const user = 'function user()\nm = Model();\nt = m.Total;\ndisp(t);\nend\n';
    const other = cls('Other', 'handle', method('t = Total(obj)', '            t = 2;\n'));
    const steps = await syncedAndFreshEachStep(
      { 'Model.m': withProps(cls('Model', 'handle', method('reset(obj)')), '        Total\n'), 'Other.m': other, 'user.m': user },
      { 'Model.m': cls('Model', 'handle', method('reset(obj)') + method('v = Total(obj)', '            v = 1;\n')) },
      // And back: the property again, then the other class's method gone too.
      { 'Model.m': withProps(cls('Model', 'handle', method('reset(obj)')), '        Total\n') },
      { 'Other.m': null },
    );
    expect(steps.map((s) => s.synced.filter((e) => e.includes('Total')))).toEqual([['user.m user -calls-> Model::Total @ Model.m'], [], []]);
    expect(steps.map((s) => s.syncedRows)).toEqual([[], ['user.m:3 calls:Model::Total'], []]);
    expectEveryStepFresh(steps);
  });

  it('links a class\'s static method read without parentheses when the class comes, and drops the row when it goes (review case 3 and its reverse)', async () => {
    const cfg = 'classdef Cfg\n    methods (Static)\n        function v = limit()\n            v = 1;\n        end\n    end\nend\n';
    const steps = await syncedAndFreshEachStep(
      { 'Other.m': withProps(cls('Other', 'handle'), '        limit = 3\n'), 'user.m': 'function user()\nv = Cfg.limit;\ndisp(v);\nend\n' },
      { 'Cfg.m': cfg },
      { 'Cfg.m': null },
    );
    expect(steps.map((s) => s.synced.filter((e) => e.startsWith('user.m ')))).toEqual([['user.m user -calls-> Cfg::limit @ Cfg.m'], []]);
    expect(steps[1]!.syncedRows).toEqual([]);
    expectEveryStepFresh(steps);
  });

  it('relinks a self call when the first subclass defining the method is added (review case 2)', async () => {
    const steps = await syncedAndFreshEachStep(
      { 'Vehicle.m': cls('Vehicle', 'handle', method('path(veh, t, y, u)', '            veh.dxstate(t, y, u);\n')) },
      { 'Tandem.m': cls('Tandem', 'Vehicle', method('d = dxstate(veh, t, y, u)', '            d = 1;\n')) },
    );
    expect(steps[0]!.synced).toContain('Vehicle.m Vehicle::path -calls-> Tandem::dxstate @ Tandem.m');
    expectEveryStepFresh(steps);
  });

  it('relinks a bare static call and a superclass constructor call when their class file is removed and restored (review cases 4 and 10)', async () => {
    const model = 'classdef Model < handle\n    methods (Static)\n        function m = make()\n            m = 1;\n        end\n    end\nend\n';
    const base = 'classdef Base < handle\n    methods\n        function obj = Base(x)\n        end\n    end\nend\n';
    const steps = await syncedAndFreshEachStep(
      {
        'Model.m': model,
        'user.m': 'function user()\ns = Model.make;\ndisp(s);\nend\n',
        'Base.m': base,
        'Sub.m': 'classdef Sub < Base\n    methods\n        function obj = Sub(x)\n            obj = obj@Base(x);\n        end\n    end\nend\n',
      },
      { 'Model.m': null, 'Base.m': null },
      { 'Model.m': model, 'Base.m': base },
    );
    expect(steps[1]!.synced).toEqual(expect.arrayContaining(['user.m user -calls-> Model::make @ Model.m', 'Sub.m Sub::Sub -calls-> Base::Base @ Base.m']));
    expectEveryStepFresh(steps);
  });

  it('lists a kept member read nowhere as a reference leaving the index (the viewer\'s lists, the dead-code check)', async () => {
    const root = tempDir('cg-matlab-dispatch-parked-');
    writeTree(root, {
      'Model.m': withProps(cls('Model', 'handle', method('reset(obj)')), '        Total\n'),
      'Other.m': cls('Other', 'handle', method('t = Total(obj)', '            t = 2;\n')),
      'user.m': 'function user()\nm = Model();\nt = m.Total;\nr = m.Total(1);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(unresolvedRows(root)).toEqual(['user.m:3 calls:Model::Total', 'user.m:4 calls:Model::Total']);
      const user = cg.getNodesInFile('user.m').find((n) => n.kind === 'function')!;
      // The call written with arguments is one; the read is not.
      expect(cg.getUnresolvedReferencesFrom(user.id).map((r) => r.line)).toEqual([4]);
      expect(cg.getUnresolvedReferencesInFile('user.m').map((r) => r.line)).toEqual([4]);
      expect([...cg.getUnresolvedNamesAmong(['Total'])]).toEqual(['Total']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
    // Read alone, the name counts against no symbol.
    const only = tempDir('cg-matlab-dispatch-parked-');
    writeTree(only, {
      'Model.m': withProps(cls('Model', 'handle', method('reset(obj)')), '        Total\n'),
      'Other.m': cls('Other', 'handle', method('t = Total(obj)', '            t = 2;\n')),
      'user.m': 'function user()\nm = Model();\nt = m.Total;\nend\n',
    });
    const cg2 = await CodeGraph.init(only, { index: true });
    try {
      expect(unresolvedRows(only)).toEqual(['user.m:3 calls:Model::Total']);
      expect([...cg2.getUnresolvedNamesAmong(['Total'])]).toEqual([]);
      expect(cg2.getUnresolvedReferencesInFile('user.m')).toEqual([]);
    } finally {
      cg2.close();
      fs.rmSync(only, { recursive: true, force: true });
    }
  });

  it('records a superclass call as written with arguments, not bare', () => {
    const code = 'classdef Sub < Base\n    methods\n        function obj = Sub(x)\n            obj = obj@Base(x);\n        end\n        function show(obj)\n            show@Base(obj);\n        end\n    end\nend\n';
    // What it passes rides along (`args`), as for any call written with arguments.
    expect(refs('Sub.m', code).filter((r) => r.includes('Base::')).map((r) => r.replace(/ \[args:[^\]]*\]$/, ''))).toEqual(['4 calls:Base::Base', '7 calls:Base::show']);
  });

  it('keeps a member call\'s row live only when a symbol could answer it: for a call, one a dotted call reaches (not a property), for a read, a callable one', async () => {
    const { unresolved } = await indexOfProject({
      'Other.m': withProps(cls('Other', 'handle', method('r = run(obj)', '            r = 1;\n')), '        limit\n'),
      'Model.m': cls('Model', 'handle', method('go(obj)', '            a = obj.limit;\n            b = obj.run;\n            c = obj.nothing;\n            obj.limit(1);\n            obj.nothing(1);\n')),
    });
    // `obj.limit(1)` indexes a property, which no call reaches: dormant.
    expect(unresolved).toEqual(['Model.m:5 calls:Model::run']);
  });
});

describe('MATLAB dispatch in explore: an override fan-out says its size', () => {
  it('counts the links past the cap, and marks a Flow hop to an override nobody named as one of many', async () => {
    const subs: Record<string, string> = {};
    for (let i = 1; i <= 9; i++) subs[`Sub${i}.m`] = cls(`Sub${i}`, 'Base', method('step(obj)', '            helperStep();\n'));
    const root = tempDir('cg-matlab-dispatch-fanout-');
    writeTree(root, {
      ...subs,
      'Base.m': cls('Base', 'handle', method('run(obj)', '            obj.step();\n') + method('step(obj)')),
      'helperStep.m': 'function helperStep()\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const handler = new ToolHandler(cg);
      const text = async (query: string): Promise<string> => {
        const r = await handler.execute('codegraph_explore', { query });
        return (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      };
      const links = await text('Base step');
      expect(links).toContain('- … +3 more (9 links in all)');
      const flow = await text('Base run step helperStep');
      expect(flow).toMatch(/↓ dynamic: base → override, 1 of 9 @Sub\d\.m:3/);
      const named = await text('Base run step Sub4 helperStep');
      expect(named).toContain('↓ dynamic: base → override @Sub4.m:3');
      expect(named).not.toContain('1 of 9');
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codegraph_node on a base method with many overrides', () => {
  it('stays within its budget and collapses the callee list', async () => {
    const files: Record<string, string> = {
      'ALGORITHM.m': cls('ALGORITHM', 'handle', method('Solve(obj)', '            obj.main();\n') + method('main(obj)')),
    };
    for (let i = 0; i < 120; i++) files[`A${i}.m`] = cls(`A${i}`, 'ALGORITHM', method('main(obj)', '            disp(1);\n'));
    const root = tempDir('cg-matlab-dispatch-node-');
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = (await new ToolHandler(cg).execute('codegraph_node', { symbol: 'ALGORITHM.main' })).content[0]!.text;
      expect(text.length).toBeLessThan(20000);
      expect(text).toContain('+108 more');
      expect(text).not.toMatch(/use Read|Read the/);
      expect(unresolvedRows(root)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB member call whose name the value interpreter built (review 2, case 1)', () => {
  const CALLER = "function caller(r)\nfeval(strcat('pkg.', 'scale'), r);\na = lower('PKG.SHIFT');\nfeval(a, r);\nend\n";
  const CALLERB = "function callerb(r)\neval(['x = Model.' 'make(r);']);\nh = str2func(sprintf('%s.%s', 'pkg', 'scale'));\nh(r);\nend\n";
  const MODEL = 'classdef Model\n    methods (Static)\n        function o = make(k)\n            o = k;\n        end\n    end\nend\n';
  const SCALE = 'function y = scale(x)\ny = 2*x;\nend\n';
  const SHIFT = 'function y = shift(x)\ny = x+1;\nend\n';

  it('tags a dotted name the interpreter built `computed`, and not one a literal at the call spells', () => {
    expect(refs('caller.m', CALLER).filter((r) => r.includes('pkg::'))).toEqual(['2 calls:pkg::scale [computed]', '4 calls:pkg::shift [computed]']);
    expect(refs('callerb.m', CALLERB).filter((r) => /Model::|pkg::/.test(r))).toEqual([
      '2 calls:Model::make [computed]',
      '3 function_ref:pkg::scale [computed]',
      '4 calls:pkg::scale [computed]',
    ]);
    // Spelled where it is given: no fact, the word scan finds it.
    expect(refs('lit.m', "function lit(r)\nfeval('pkg.scale', r);\neval('x = Model.make(r);');\nfeval(@pkg.shift, r);\nend\n").filter((r) => /Model::|pkg::/.test(r))).toEqual([
      '2 calls:pkg::scale',
      '3 calls:Model::make',
      '4 calls:pkg::shift',
      '4 function_ref:pkg::shift',
    ]);
  });

  it('keeps its row while the target is gone, hidden from the lists of calls leaving the index, and relinks it when the target comes back', async () => {
    const steps = await syncedAndFreshEachStep(
      { 'caller.m': CALLER, 'callerb.m': CALLERB, 'Model.m': MODEL, '+pkg/scale.m': SCALE, '+pkg/shift.m': SHIFT },
      { '+pkg/scale.m': null, '+pkg/shift.m': null, 'Model.m': null },
      { '+pkg/scale.m': SCALE, '+pkg/shift.m': SHIFT, 'Model.m': MODEL },
    );
    expect(steps[0]!.syncedRows).toEqual([
      'caller.m:2 calls:pkg::scale',
      'caller.m:4 calls:pkg::shift',
      'callerb.m:2 calls:Model::make',
      'callerb.m:3 function_ref:pkg::scale',
      'callerb.m:4 calls:pkg::scale',
    ]);
    expect(steps[1]!.synced.filter((e) => e.startsWith('caller') && e.includes('-calls->'))).toEqual([
      'caller.m caller -calls-> pkg::scale @ +pkg/scale.m',
      'caller.m caller -calls-> pkg::shift @ +pkg/shift.m',
      'callerb.m callerb -calls-> Model::make @ Model.m',
      'callerb.m callerb -calls-> pkg::scale @ +pkg/scale.m',
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
    const root = tempDir('cg-matlab-dispatch-computed-');
    writeTree(root, { 'caller.m': CALLER });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(unresolvedRows(root)).toEqual(['caller.m:2 calls:pkg::scale', 'caller.m:4 calls:pkg::shift']);
      const caller = cg.getNodesInFile('caller.m').find((n) => n.kind === 'function')!;
      expect(cg.getUnresolvedReferencesFrom(caller.id)).toEqual([]);
      expect(cg.getUnresolvedReferencesInFile('caller.m')).toEqual([]);
      expect([...cg.getUnresolvedNamesAmong(['scale', 'shift'])]).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB parked member rows: the SQL and the TypeScript rule agree', () => {
  it('picks the same rows with PARKED_MATLAB_MEMBER_READ_SQL as with isParkedMatlabMemberRow', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY, language TEXT, reference_kind TEXT, reference_name TEXT, candidates TEXT)');
    const rows: Array<{ language: string; referenceKind: string; referenceName: string; candidates?: string[] }> = [];
    const names = ['Model::Total', 'm.Total', 'pkg::f', 'Total', 'obj.a.b', 'Base::Base'];
    const facts: Array<string[] | undefined> = [
      undefined, ['bare'], ['statement'], ['computed'], ['bare', 'self'], ['dispatch:size'], ['dispatch:size', 'bare'], ['variable:aa.getData'],
      ['variable:aa.bare'], ['args:{"0":"\'bare"}'], ['runtime'], ['computed', 'runtime'], ['param'], ['self'],
    ];
    for (const language of ['matlab', 'typescript']) {
      for (const referenceKind of ['calls', 'function_ref']) {
        for (const referenceName of names) for (const candidates of facts) rows.push({ language, referenceKind, referenceName, ...(candidates ? { candidates } : {}) });
      }
    }
    // And every row a MATLAB project of each written form stores.
    const root = tempDir('cg-matlab-dispatch-parked-sql-');
    writeTree(root, {
      'Model.m': cls('Model', 'handle', method('go(obj)', "            a = obj.limit;\n            obj.limit(1);\n            feval(strcat('pkg.', 'g'), 1);\n            size(obj, 1);\n")),
      'Other.m': cls('Other', 'handle', method('r = limit(obj)', '            r = 1;\n') + method('r = g(obj)', '            r = 1;\n')),
      'user.m': 'function user()\nm = Model();\nt = m.limit;\nm.limit(2);\nsetup_paths\nv = cfg;\nend\n',
      'setup_paths.m': 'x = 1;\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
    const stored = DatabaseConnection.open(getDatabasePath(root));
    try {
      const all = stored.getDb().prepare('SELECT language, reference_kind, reference_name, candidates FROM unresolved_refs').all() as Array<{ language: string; reference_kind: string; reference_name: string; candidates: string | null }>;
      expect(all.length).toBeGreaterThan(0);
      for (const r of all) rows.push({ language: r.language, referenceKind: r.reference_kind, referenceName: r.reference_name, ...(r.candidates ? { candidates: JSON.parse(r.candidates) as string[] } : {}) });
    } finally {
      stored.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
    const insert = db.prepare('INSERT INTO unresolved_refs (id, language, reference_kind, reference_name, candidates) VALUES (?, ?, ?, ?, ?)');
    rows.forEach((r, i) => insert.run(i, r.language, r.referenceKind, r.referenceName, r.candidates ? JSON.stringify(r.candidates) : null));
    const bySql = new Set((db.prepare(`SELECT id FROM unresolved_refs WHERE ${PARKED_MATLAB_MEMBER_READ_SQL}`).all() as Array<{ id: number }>).map((r) => r.id));
    const byTs = new Set(rows.flatMap((r, i) => (isParkedMatlabMemberRow(r) ? [i] : [])));
    expect(byTs.size).toBeGreaterThan(5);
    expect([...bySql].sort((a, b) => a - b)).toEqual([...byTs].sort((a, b) => a - b));
    db.close();
  }, 120_000);
});

describe('MATLAB kept member rows past the retry ceiling (review 2, cases 6 and 8)', () => {
  const USERS = 510;
  const users = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 1; i <= USERS; i++) out[`u${i}.m`] = `function u${i}()\nm = Model();\nt = m.Total;\nr = m.Rate(1);\nend\n`;
    return out;
  };
  const MODEL_PROPS = 'classdef Model < handle\n    properties\n        Total\n        Rate\n    end\n    methods\n        function obj = Model()\n        end\n    end\nend\n';
  const MODEL_METHODS = 'classdef Model < handle\n    methods\n        function obj = Model()\n        end\n        function t = Total(obj)\n            t = 1;\n        end\n        function t = Rate(obj, k)\n            t = k;\n        end\n    end\nend\n';
  const OTHER_METHODS = 'classdef Other < handle\n    methods\n        function t = Total(obj)\n            t = 2;\n        end\n        function t = Rate(obj, k)\n            t = k;\n        end\n    end\nend\n';
  const OTHER_PROPS = 'classdef Other < handle\n    properties\n        Total\n        Rate\n    end\nend\n';
  const expectEveryStepFresh = (steps: SyncedStep[]): void => {
    for (const st of steps) {
      expect(st.synced.length).toBe(st.fresh.length);
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows.length).toBe(st.freshRows.length);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
  };

  it('relinks every kept row when the class at hand turns its properties into methods (case 8)', async () => {
    const steps = await syncedAndFreshEachStep({ ...users(), 'Model.m': MODEL_PROPS, 'Other.m': OTHER_METHODS }, { 'Model.m': MODEL_METHODS });
    expect(steps[0]!.synced.filter((e) => / -calls-> Model::(Total|Rate) /.test(e)).length).toBe(2 * USERS);
    expect(steps[0]!.syncedRows).toEqual([]);
    expectEveryStepFresh(steps);
  }, 600_000);

  it('drops the kept rows when the last carrier of the kind they need goes (case 6)', async () => {
    const steps = await syncedAndFreshEachStep(
      { ...users(), 'Model.m': MODEL_PROPS.replace('        Total\n        Rate\n', '        Gain\n'), 'Other.m': OTHER_METHODS },
      { 'Other.m': null, 'lib/Total.m': 'function t = Total(varargin)\nt = 1;\nend\n', 'lib/Rate.m': 'function t = Rate(varargin)\nt = 1;\nend\n' },
      { 'lib/Total.m': null, 'lib/Rate.m': null, 'Other.m': OTHER_PROPS },
      { 'Other.m': null },
    );
    // Plain functions in place of the methods carry the reads (`m.Total`, a
    // callable's name) but not the calls (`m.Rate(1)`, which only a dotted
    // call's target answers): the rows of one name split, past the ceiling.
    // Then properties carry neither (`m.Rate(1)` indexes one): every row sleeps.
    expect(steps.map((st) => st.syncedRows.length)).toEqual([USERS, 0, 0]);
    expect(steps.map((st) => st.syncedDormant.length)).toEqual([USERS, 2 * USERS, 2 * USERS]);
    expectEveryStepFresh(steps);
  }, 600_000);
});

describe('MATLAB carrier step: a word scan for the built-ins, and member rows woken by MATLAB names only', () => {
  it('finds a word whole', () => {
    const hit = matlabNameScan(new Set(['beep']));
    expect(['beep;', 'x = beep', 'a.beep(2)'].filter((t) => !hit(t))).toEqual([]);
    expect(['buzzer', 'my_beep', '1beep'].filter(hit)).toEqual([]);
    // Past the pattern's size, every word is looked up: the same answers.
    const many = new Set(['beep', ...Array.from({ length: 40 }, (_, i) => `zz${i}`)]);
    const wide = matlabNameScan(many);
    expect(['beep;', 'x = beep', 'zz7(1)'].filter((t) => !wide(t))).toEqual([]);
    expect(['buzzer', 'my_beep', 'zz77'].filter(wide)).toEqual([]);
  });

  it('wakes no member row for a JavaScript file\'s new names, and a sync still ends where a fresh index does', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const prior = process.env.CODEGRAPH_SYNTH_TIMINGS;
    process.env.CODEGRAPH_SYNTH_TIMINGS = '1';
    let steps: SyncedStep[];
    try {
      steps = await syncedAndFreshEachStep(
        {
          'Model.m': cls('Model', 'handle', method('reset(obj)')),
          'user.m': 'function user()\nm = Model();\nr = m.Total(1);\nq = m.Weight;\nend\n',
          'web/app.js': 'export function main() { return 1; }\n',
        },
        { 'web/app.js': 'export function main() { return Total() + Weight(); }\nexport function Total() { return 1; }\nexport function Weight() { return 2; }\n' },
        { 'Model.m': cls('Model', 'handle', method('reset(obj)') + method('t = Total(obj, k)', '            t = k;\n')) },
      );
    } finally {
      spy.mockRestore();
      if (prior === undefined) delete process.env.CODEGRAPH_SYNTH_TIMINGS;
      else process.env.CODEGRAPH_SYNTH_TIMINGS = prior;
    }
    const carrierLines = lines.filter((l) => l.includes('sync-matlab-builtin-carriers'));
    // The JavaScript step wakes nothing (its names are no MATLAB member's
    // carriers), and re-extracts nothing; the MATLAB method wakes one row.
    expect(carrierLines.length).toBe(2);
    expect(carrierLines[0]).toMatch(/: 0 rows woken, 0 put to sleep, 0 resolved again; word scan 0ms; 0 files extracted again/);
    expect(carrierLines[1]).toMatch(/: 1 rows woken, 0 put to sleep, 0 resolved again; word scan 0ms; 0 files extracted again/);
    expect(steps.map((st) => st.synced.filter((e) => e.startsWith('user.m ') && e.includes('-calls->')))).toEqual([[], ['user.m user -calls-> Model::Total @ Model.m']]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
  }, 120_000);
});

describe('MATLAB carrier step killed half way: the next sync finishes it (review 2, case 2)', () => {
  const MODEL_WITH = 'classdef Model\n    methods\n        function r = recalib(obj, k)\n            r = k;\n        end\n    end\nend\n';
  const MODEL_WITHOUT = 'classdef Model\n    methods\n        function r = other(obj, k)\n            r = k;\n        end\n    end\nend\n';
  const USER = 'function r = user()\na = Model();\nr = a.recalib(2);\nend\n';
  const OTHER = cls('Other', 'handle', method('t = Rate(obj, k)', '            t = k;\n'));
  const RATER = 'function r = rater()\nm = Model();\nr = m.Rate(1);\nend\n';

  /**
   * Indexes `initial`, applies each step with a sync, the last one killed
   * where `kill` throws, then syncs again with nothing changed: the edges
   * and rows then, and a fresh index's of the same files.
   */
  async function killedThenSynced(
    initial: Record<string, string>,
    steps: Array<Record<string, string | null>>,
    kill: () => () => void,
  ): Promise<SyncedStep & { record: string | null; afterIndexAll: string | null }> {
    const root = tempDir('cg-matlab-killed-');
    const freshRoot = tempDir('cg-matlab-killed-fresh-');
    const current: Record<string, string | null> = { ...initial };
    writeTree(root, initial);
    let cg = await CodeGraph.init(root, { index: true });
    try {
      for (let i = 0; i < steps.length; i++) {
        writeTree(root, steps[i]!);
        Object.assign(current, steps[i]!);
        if (i < steps.length - 1) {
          await cg.sync();
          continue;
        }
        const restore = kill();
        try {
          await expect(cg.sync()).rejects.toThrow('simulated kill');
        } finally {
          restore();
        }
      }
      cg.close();
      cg = await CodeGraph.open(root);
      const record = carrierRecord(root);
      await cg.sync();
      const synced = allEdges(cg);
      const syncedRows = unresolvedRows(root);
      const syncedDormant = dormantRows(root);
      writeTree(freshRoot, Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)));
      const fresh = await CodeGraph.init(freshRoot, { index: true });
      let freshEdges: string[];
      try {
        freshEdges = allEdges(fresh);
      } finally {
        fresh.close();
      }
      return { synced, fresh: freshEdges, syncedRows, freshRows: unresolvedRows(freshRoot), syncedDormant, freshDormant: dormantRows(freshRoot), record, afterIndexAll: null };
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  }

  function carrierRecord(root: string): string | null {
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const row = db.getDb().prepare('SELECT value FROM project_metadata WHERE key = ?').get(MATLAB_CARRIER_STEP_KEY) as { value: string } | undefined;
      return row?.value ? row.value : null;
    } finally {
      db.close();
    }
  }

  /**
   * Makes the carrier step's first file throw, extracted again or its calls
   * of a gained name written again (addMatlabBuiltinRows): a sync killed
   * after its rows are dropped, woken or put to sleep.
   */
  const killAtReextract = (): (() => void) => {
    const proto = ExtractionOrchestrator.prototype as unknown as {
      indexFile: (p: string, again?: boolean) => Promise<unknown>;
      addMatlabBuiltinRows: (...args: unknown[]) => unknown;
    };
    const orig = proto.indexFile;
    const origRows = proto.addMatlabBuiltinRows;
    proto.indexFile = function (this: unknown, p: string, again?: boolean) {
      if (again === true) throw new Error('simulated kill at the carrier re-extraction');
      return orig.call(this, p, again);
    };
    proto.addMatlabBuiltinRows = function () {
      throw new Error('simulated kill at the carrier re-extraction');
    };
    return () => {
      proto.indexFile = orig;
      proto.addMatlabBuiltinRows = origRows;
    };
  };

  /** Makes the carrier step's first full re-extraction (`indexFile(…, true)`) throw, and nothing else: a sync killed there. */
  const killAtFullReextract = (): (() => void) => {
    const proto = ExtractionOrchestrator.prototype as unknown as { indexFile: (p: string, again?: boolean) => Promise<unknown> };
    const orig = proto.indexFile;
    proto.indexFile = function (this: unknown, p: string, again?: boolean) {
      if (again === true) throw new Error('simulated kill at the carrier full re-extraction');
      return orig.call(this, p, again);
    };
    return () => {
      proto.indexFile = orig;
    };
  };

  /** Makes the carrier step's first wake or sleep throw: a sync killed after the step is recorded, before its dormant rows changed. */
  const killAtDormancy = (): (() => void) => {
    const proto = QueryBuilder.prototype as unknown as { setMatlabDormancy: (wake: number[], sleep: number[]) => number };
    const orig = proto.setMatlabDormancy;
    proto.setMatlabDormancy = function () {
      throw new Error('simulated kill at the carrier dormancy');
    };
    return () => {
      proto.setMatlabDormancy = orig;
    };
  };

  const expectFresh = (r: SyncedStep): void => {
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
    expect(r.syncedDormant).toEqual(r.freshDormant);
  };

  it('wakes the rows of a member that gained its carrier, killed before the wake (case 2)', async () => {
    const r = await killedThenSynced({ 'Model.m': MODEL_WITH, 'user.m': USER }, [{ 'Model.m': MODEL_WITHOUT }, { 'Model.m': MODEL_WITH }], killAtDormancy);
    expect(r.synced).toContain('user.m user -calls-> Model::recalib @ Model.m');
    expectFresh(r);
    expect(JSON.parse(r.record!)).toMatchObject({ wake: [expect.any(Number)], sleep: [], files: [] });
  }, 120_000);

  it('puts to sleep the rows of a member that lost its carrier, killed before', async () => {
    const r = await killedThenSynced({ 'Model.m': MODEL_WITH, 'Other.m': OTHER, 'rater.m': RATER }, [{ 'Other.m': null }], killAtDormancy);
    expect(r.syncedRows).toEqual([]);
    expect(r.syncedDormant).toEqual(['rater.m:3 calls:Model::Rate']);
    expectFresh(r);
    expect(JSON.parse(r.record!)).toMatchObject({ wake: [], sleep: [expect.any(Number)] });
  }, 120_000);

  it('finishes a step that wakes and re-extracts, killed between the two', async () => {
    const BUZZER = 'function buzzer()\nbeep\nend\n';
    const r = await killedThenSynced(
      { 'Model.m': MODEL_WITH, 'user.m': USER, 'buzzer.m': BUZZER },
      [{ 'Model.m': MODEL_WITHOUT }, { 'Model.m': MODEL_WITH, 'tools/beep.m': 'function beep()\nend\n' }],
      killAtReextract,
    );
    expect(r.synced).toContain('user.m user -calls-> Model::recalib @ Model.m');
    expect(r.synced).toContain('buzzer.m buzzer -calls-> beep @ tools/beep.m');
    expectFresh(r);
    expect(JSON.parse(r.record!)).toMatchObject({ wake: [expect.any(Number)], files: ['buzzer.m'] });
  }, 120_000);

  it('finishes a step that wakes and extracts a file again in full, killed between the two', async () => {
    // A file that imports a name is extracted again in full when a built-in's
    // name it calls gains its first reach (matlabBuiltinRowsPlan): the kill
    // fires inside that re-extraction, after the wake was recorded.
    const BUZZER = 'function buzzer()\nimport pkg.*\nbeep\nend\n';
    const r = await killedThenSynced(
      { 'Model.m': MODEL_WITH, 'user.m': USER, 'buzzer.m': BUZZER },
      [{ 'Model.m': MODEL_WITHOUT }, { 'Model.m': MODEL_WITH, 'tools/beep.m': 'function beep()\nend\n' }],
      killAtFullReextract,
    );
    expect(r.synced).toContain('user.m user -calls-> Model::recalib @ Model.m');
    expect(r.synced).toContain('buzzer.m buzzer -calls-> beep @ tools/beep.m');
    expectFresh(r);
    expect(JSON.parse(r.record!)).toMatchObject({ wake: [expect.any(Number)], files: ['buzzer.m'] });
  }, 120_000);

  it('accepts a record written before dormant rows were kept (no wake, no sleep)', async () => {
    const root = tempDir('cg-matlab-killed-old-record-');
    try {
      writeTree(root, { 'Model.m': MODEL_WITH, 'user.m': USER });
      const cg = await CodeGraph.init(root, { index: true });
      cg.close();
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        new QueryBuilder(db.getDb()).setMetadata(MATLAB_CARRIER_STEP_KEY, JSON.stringify({ drop: [], reopen: [], files: ['user.m'] }));
      } finally {
        db.close();
      }
      const again = await CodeGraph.open(root);
      try {
        await again.sync();
        expect(allEdges(again)).toContain('user.m user -calls-> Model::recalib @ Model.m');
      } finally {
        again.close();
      }
      expect(carrierRecord(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('is cleared by a full index, which finishes it', async () => {
    const root = tempDir('cg-matlab-killed-index-');
    try {
      writeTree(root, { 'Model.m': MODEL_WITH, 'user.m': USER });
      let cg = await CodeGraph.init(root, { index: true });
      writeTree(root, { 'Model.m': MODEL_WITHOUT });
      await cg.sync();
      writeTree(root, { 'Model.m': MODEL_WITH });
      const restore = killAtDormancy();
      try {
        await expect(cg.sync()).rejects.toThrow('simulated kill');
      } finally {
        restore();
      }
      cg.close();
      expect(carrierRecord(root)).not.toBeNull();
      cg = await CodeGraph.open(root);
      try {
        await cg.indexAll();
        expect(allEdges(cg)).toContain('user.m user -calls-> Model::recalib @ Model.m');
      } finally {
        cg.close();
      }
      expect(carrierRecord(root)).toBeNull();
      const fresh = await indexOfProject({ 'Model.m': MODEL_WITH, 'user.m': USER });
      expect(unresolvedRows(root)).toEqual(fresh.unresolved);
      expect(dormantRows(root)).toEqual(fresh.dormant);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB self call into the subclasses in explore: the hop says its fan-out (review 2, case 5)', () => {
  it('reads "self call → subclass method, 1 of 3" to a subclass nobody named, and no count to a named one', async () => {
    const sub = (name: string): string => `classdef ${name} < Base\n  methods\n    function step(obj)\n      shared_helper(1);\n    end\n  end\nend\n`;
    const root = tempDir('cg-matlab-dispatch-selffan-');
    writeTree(root, {
      'Base.m': 'classdef Base < handle\n  methods\n    function run(obj)\n      obj.step();\n      obj.tick();\n    end\n    function tick(obj)\n    end\n  end\nend\n',
      'Alpha.m': sub('Alpha'),
      'Beta.m': sub('Beta'),
      'Gamma.m': sub('Gamma'),
      'shared_helper.m': 'function shared_helper(k)\ndisp(k);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = async (query: string): Promise<string> =>
        ((await new ToolHandler(cg).execute('codegraph_explore', { query })).content as Array<{ text: string }>).map((c) => c.text).join('\n');
      expect(await text('Base.run shared_helper')).toMatch(/↓ dynamic: self call → subclass method, 1 of 3 @(Alpha|Beta|Gamma)\.m:3/);
      const named = await text('Base.run Beta.step shared_helper');
      expect(named).toContain('↓ dynamic: self call → subclass method @Beta.m:3');
      expect(named).not.toContain('1 of 3');
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('MATLAB call in function syntax on an object the code does not type (step 9)', () => {
  /** `file:line source -> target [via]` of every `calls` edge out of `file` (provenance `heuristic` marked `guess`). */
  async function callsOut(files: Record<string, string>, file: string): Promise<string[]> {
    const root = tempDir('cg-matlab-fnsyntax-');
    try {
      writeTree(root, files);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const ids = cg.getNodesInFile(file).map((n) => n.id);
        return cg.getOutgoingEdgesFrom(ids)
          .filter((e) => e.kind === 'calls')
          .map((e) => {
            const via = (e.metadata as Record<string, unknown> | undefined)?.via;
            return `${file}:${e.line} ${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName}${e.provenance === 'heuristic' ? ` [guess ${String(via)}]` : ''}`;
          })
          .sort();
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // `e = ets(i); if isfixed(e)`, `for x = ets`, `swapToY(ets(k))`.
  const SEG = [
    'classdef Seg < handle',
    '    methods',
    '        function b = anyJoint(ets)',
    '            b = false;',
    '            for i = 1:numel(ets)',
    '                e = ets(i);',
    '                if isfixed(e), b = true; end',
    '            end',
    '            for x = ets',
    '                b = b || isfixed(x);',
    '            end',
    '            b = b || isfixed(ets(1)) || scaled(2, ets) > 0;',
    '            n = ets(1);',
    '            n = 3;',
    '            isfixed(n);',
    '            numel(ets(1));',
    '        end',
    '        function t = isfixed(e)',
    '            t = true;',
    '        end',
    '        function v = scaled(f, e)',
    '            v = f;',
    '        end',
    '    end',
    'end',
    '',
  ].join('\n');

  it('dispatches on an element or a copy of the method\'s own object, and on it after a number (E1): exact edges', async () => {
    expect(refs('Seg.m', SEG).filter((r) => /isfixed|scaled|numel/.test(r))).toEqual([
      // On the method's own object as it is: dispatched before this step too.
      '5 calls:Seg::numel [dispatch:numel]',
      '7 calls:Seg::isfixed [dispatch:isfixed]',
      '10 calls:Seg::isfixed [dispatch:isfixed]',
      '12 calls:Seg::isfixed [dispatch:isfixed]',
      '12 calls:Seg::scaled [dispatch:scaled]',
      // A copy written twice, once a number: nothing said of it, and no object either.
      '15 calls:isfixed',
      // A built-in's name stays the built-in's call.
      '16 calls:numel',
    ]);
    expect(await callsOut({ 'Seg.m': SEG }, 'Seg.m')).toEqual([
      'Seg.m:10 Seg::anyJoint -> Seg::isfixed',
      'Seg.m:12 Seg::anyJoint -> Seg::isfixed',
      'Seg.m:12 Seg::anyJoint -> Seg::scaled',
      'Seg.m:7 Seg::anyJoint -> Seg::isfixed',
    ]);
  });

  // `@gmap/BKZ07.m`: `q` holds what a method returns, so its class is not stated.
  const GMAP_FILES = {
    '@gmap/gmap.m': "function t = gmap(x)\nt = class(struct('v', x), 'gmap');\nend\n",
    '@gmap/GmapToStepByFlow.m': 'function v = GmapToStepByFlow(t)\nv = t;\nend\n',
    '@gmap/JoinGmapByStep.m': 'function r = JoinGmapByStep(t, v, n)\nr = t;\nend\n',
    '@gmap/BKZ07.m': [
      'function r = BKZ07(x, y)',
      'p = GmapToStepByFlow(x);',
      'q = GmapToStepByFlow(y);',
      'for i = 1:length(q)',
      '    t(i) = JoinGmapByStep(q(i), p, 1);',
      'end',
      'r = t;',
      "s = 'abc';",
      'JoinGmapByStep(s, p, 1);',
      'JoinGmapByStep(x.v, p, 1);',
      'JoinGmapByStep(p * 2, p, 1);',
      'end',
      '',
    ].join('\n'),
  };

  it("takes a call in an old-style class folder's code on a variable for the class's method (E2), marked a guess", async () => {
    const facts = refs('@gmap/BKZ07.m', GMAP_FILES['@gmap/BKZ07.m']).filter((r) => r.includes('JoinGmapByStep'));
    expect(facts.map((r) => `${r.split(' ')[0]} ${r.includes('objectArg')}`)).toEqual(['5 true', '9 false', '10 false', '11 false']);
    // On a text, a field's value or an expression: no edge. `GmapToStepByFlow(x)` on the method's own object is exact.
    expect(await callsOut(GMAP_FILES, '@gmap/BKZ07.m')).toEqual([
      '@gmap/BKZ07.m:2 gmap::BKZ07 -> gmap::GmapToStepByFlow',
      '@gmap/BKZ07.m:3 gmap::BKZ07 -> gmap::GmapToStepByFlow [guess caller-class]',
      '@gmap/BKZ07.m:5 gmap::BKZ07 -> gmap::JoinGmapByStep [guess caller-class]',
    ]);
  });

  it("takes `children(tree, uid)` in a local function of `@doctree/editor.m` for doctree's method", async () => {
    const files = {
      '@doctree/doctree.m': "function tree = doctree(f)\ntree = class(struct('t', f), 'doctree');\nend\n",
      '@doctree/children.m': 'function c = children(tree, uid)\nc = uid;\nend\n',
      '@doctree/editor.m': [
        'function editor(tree)',
        'h = figure;',
        "setappdata(h, 'tree', tree);",
        'onTweak([], [], h);',
        '',
        'function onTweak(fig, evd, h)',
        "tree = getappdata(h, 'tree');",
        'uid = 1;',
        'contents = children(tree, uid);',
        '',
      ].join('\n'),
      // Outside the class: no guess.
      'outside.m': "function outside(h)\ntree = getappdata(h, 'tree');\nchildren(tree, 1);\nend\n",
    };
    expect((await callsOut(files, '@doctree/editor.m')).filter((e) => e.includes('children'))).toEqual(['@doctree/editor.m:9 onTweak -> doctree::children [guess caller-class]']);
    expect(await callsOut(files, 'outside.m')).toEqual([]);
  });

  it('keeps no edge for the shapes the review found wrong: a field\'s value, an expression, a name MATLAB has, a call outside the class', async () => {
    const files = {
      // @kvdict: `keys(obj.data)` is containers.Map's.
      'kvdict.m': cls('kvdict', 'handle', method('k = keys(obj)', '            k = 1;\n') + method('v = list(obj)', '            m = obj.data;\n            v = keys(obj.data);\n            v = keys(m);\n')),
      // `draw_oval(P * …)` on a matrix.
      'EKF.m': cls('EKF', 'handle', method('draw_oval(ekf, varargin)', '            h = ekf.history(1);\n            draw_oval(h.P * 2, 1);\n            P = h.P;\n            draw_oval(P * 2);\n')),
      // `forward(obj.critic_copy, …)` on a dlnetwork; `simplify(P^3 + Q)` on a sym.
      'Agent.m': cls('Agent', 'handle', method('y = forward(obj, x)', '            y = x;\n') + method('y = act(obj, x)', '            y = forward(obj.critic_copy, x);\n')),
      'Expr.m': cls('Expr', 'handle', method('e = simplify(obj)', '            e = obj;\n') + method('e = solve(obj, A, B)', '            e = simplify(B^3 + A);\n')),
      'useit.m': 'function useit(net, x, expr)\ny = forward(net, x);\ne = simplify(expr);\nend\n',
    };
    for (const f of ['kvdict.m', 'EKF.m', 'Agent.m', 'Expr.m', 'useit.m']) {
      expect((await callsOut(files, f)).filter((e) => /keys|draw_oval|forward|simplify/.test(e.split(' -> ')[1]!))).toEqual([]);
    }
    // A classdef file's code: no guess (`render(L)`, `render(src)`: an argument, an event's source), nor a callback's `cb(~, src)` in a class folder.
    expect(await callsOut({ 'Seg.m': cls('Seg', 'handle', method('t = isfixed(e)', '            t = 1;\n') + method('b = test(obj, L)', '            b = isfixed(L);\n')) }, 'Seg.m')).toEqual([]);
    expect(await callsOut({ '@Fold/Fold.m': "function f = Fold()\nf = class(struct(), 'Fold');\nend\n", '@Fold/render.m': 'function render(f)\nend\n', '@Fold/cb.m': 'function cb(~, src)\nrender(src);\nend\n' }, '@Fold/cb.m')).toEqual([]);
    // The positive beside them, so that the test says something on the base: `v = list(obj)` reading its own keys through a copy.
    expect(await callsOut({ ...files, 'kvdict.m': cls('kvdict', 'handle', method('k = keyroll(obj)', '            k = 1;\n') + method('v = list(obj)', '            o = obj;\n            v = keyroll(o);\n')) }, 'kvdict.m')).toEqual([
      'kvdict.m:8 kvdict::list -> kvdict::keyroll',
    ]);
  });

  // The review's fxC: `Link` and `ChainLink` both define `friction`.
  const ROBOT = {
    '@Robot/Robot.m': "function r = Robot()\nr = class(struct('links', {{}}), 'Robot');\nend\n",
    '@Robot/friction.m': 'function f = friction(robot, qd)\nf = 0;\nend\n',
    '@Robot/getlink.m': 'function L = getlink(robot, j)\nL = Link();\nend\n',
    '@Robot/getlinks.m': 'function L = getlinks(robot)\nL = [Link(), Link()];\nend\n',
    '@Robot/total.m': [
      'function t = total(robot, qd)',
      't = 0;',
      'for j = 1:numel(qd)',
      '    t = t + one(getlink(robot, j), qd(j));',
      'end',
      'L2 = getlink(robot, 1);',
      't = t + friction(L2, 0);',
      'end',
      'function f = one(L, q)',
      'f = friction(L, q);',
      'end',
      '',
    ].join('\n'),
  };
  const LINK = { 'Link.m': cls('Link', 'handle', method('f = friction(L, qd)', '            f = 1;\n')) };
  /** callsOut's edges into a method `name`. */
  const into = (edges: string[], name: string): string[] => edges.filter((e) => new RegExp(`::${name}(?: \\[|$)`).test(e));

  it("makes no guess when a class outside the caller's hierarchy defines the method too, a copy of the class in another case aside", async () => {
    // `friction(L2, 0)` on what `getlink` returns, `friction(L, q)` on a local function's parameter: a Link's.
    expect(into(await callsOut({ ...ROBOT, ...LINK }, '@Robot/total.m'), 'friction')).toEqual([]);
    // Without the Link class, both are taken for Robot's (so the line above says something on the build without the rule).
    expect(into(await callsOut(ROBOT, '@Robot/total.m'), 'friction')).toEqual([
      '@Robot/total.m:10 one -> Robot::friction [guess caller-class]',
      '@Robot/total.m:7 Robot::total -> Robot::friction [guess caller-class]',
    ]);
    // `@gmap` beside a copy `@GMAP` that defines the method too keeps its guess, to its own class's method.
    const gmapCopies = {
      ...GMAP_FILES,
      'old/@GMAP/GMAP.m': "function t = GMAP(x)\nt = class(struct('v', x), 'GMAP');\nend\n",
      'old/@GMAP/JoinGmapByStep.m': 'function r = JoinGmapByStep(t, v, n)\nr = t;\nend\n',
    };
    expect(into(await callsOut(gmapCopies, '@gmap/BKZ07.m'), 'JoinGmapByStep')).toEqual(['@gmap/BKZ07.m:5 gmap::BKZ07 -> gmap::JoinGmapByStep [guess caller-class]']);
    // A class of the hierarchy does not stop it: a subclass of the caller's class (Leaf < Node) defining it, nor its superclass (Base).
    const hierarchy = (other: string): Record<string, string> => ({
      'lib/Base.m': cls('Base', 'handle', method('c = children(obj, uid)', '            c = uid;\n')),
      'app/@Node/Node.m': 'classdef Node < Base\n    methods\n        show(obj, h)\n    end\nend\n',
      'app/@Node/show.m': "function show(obj, h)\nt = getappdata(h, 'tree');\nc = children(t, 1);\nend\n",
      'lib/Other.m': cls('Other', other, method('c = children(obj, uid)', '            c = 2;\n')),
    });
    expect(into(await callsOut(hierarchy('Node'), 'app/@Node/show.m'), 'children')).toEqual(['app/@Node/show.m:3 Node::show -> Base::children [guess caller-class]']);
    expect(into(await callsOut(hierarchy('handle'), 'app/@Node/show.m'), 'children')).toEqual([]);
  });

  it("makes no guess on a lambda's parameter: what arrayfun or cellfun passes it may be of any class", async () => {
    const lam = 'function f = lam(robot)\nf = arrayfun(@(L) friction(L, 0), getlinks(robot));\ng = cellfun(@(c) friction(c, 0), {Robot(), Robot()});\nend\n';
    expect(refs('@Robot/lam.m', lam).filter((r) => r.includes('friction') && r.includes('objectArg'))).toEqual([]);
    expect(into(await callsOut({ ...ROBOT, '@Robot/lam.m': lam }, '@Robot/lam.m'), 'friction')).toEqual([]);
  });

  it("makes no guess for a method base MATLAB documents: `copy(o)` may be matlab.mixin.Copyable's", async () => {
    const files = {
      '@Net/Net.m': "function obj = Net()\nobj = class(struct('w', 1), 'Net');\nend\n",
      '@Net/copy.m': 'function c = copy(obj)\nc = obj;\nend\n',
      '@Net/fitnet.m': 'function obj = fitnet(obj, X)\no = makeThing();\nc = copy(o);\nend\n',
      'makeThing.m': 'function o = makeThing()\no = Thing();\nend\n',
      'Thing.m': 'classdef Thing < matlab.mixin.Copyable\n    properties\n        v\n    end\nend\n',
    };
    expect(into(await callsOut(files, '@Net/fitnet.m'), 'copy')).toEqual([]);
  });

  it("makes no guess in a classdef file inside its class folder, whose rows carry no objectArg; a function file there keeps it", async () => {
    // The review's fxA: a constructor's argument, a callback's event source, a static method's argument.
    const shape = [
      'classdef Shape < handle',
      '    methods',
      '        function obj = Shape(L)',
      '            render(L);',
      '        end',
      '        function onClick(obj, src, evt)',
      '            render(src);',
      '        end',
      '    end',
      '    methods (Static)',
      '        function s = make(a)',
      '            render(a);',
      '            s = 1;',
      '        end',
      '    end',
      'end',
      '',
    ].join('\n');
    const files = {
      '@Shape/Shape.m': shape,
      '@Shape/render.m': 'function render(obj)\ndisp(1);\nend\n',
      '@Shape/draw.m': 'function draw(obj, L)\nrender(L);\nend\n',
    };
    expect(refs('@Shape/Shape.m', shape).filter((r) => r.includes('objectArg'))).toEqual([]);
    expect(into(await callsOut(files, '@Shape/Shape.m'), 'render')).toEqual([]);
    expect(into(await callsOut(files, '@Shape/draw.m'), 'render')).toEqual(['@Shape/draw.m:2 Shape::draw -> Shape::render [guess caller-class]']);
  });

  it('dispatches on a copy or an element of the own object only when every write of it is seen, and not where the class indexes itself', async () => {
    // The review's fxA Seg2.m and fxC Arr.m, with the functions MATLAB runs on what they pass on the path.
    const seg2 = [
      'classdef Seg2',
      '    methods',
      '        function r = viaNested(ets)',
      '            e = ets(1);',
      '            function bump()',
      '                e = 7;',
      '            end',
      '            bump();',
      '            r = isj(e);',
      '        end',
      '        function r = viaEval(ets)',
      '            e = ets(1);',
      "            eval('e = 7;');",
      '            r = isj(e);',
      '        end',
      '        function r = viaLoad(ets, f)',
      '            e = ets(1);',
      '            load(f);',
      '            r = isj(e);',
      '        end',
      '        function r = viaSelf(ets)',
      '            ets = double(ets);',
      '            r = isj(ets(1));',
      '        end',
      '        function r = control(ets)',
      '            e = ets(1);',
      '            r = isj(e);',
      '        end',
      '        function t = isj(e)',
      '            t = true;',
      '        end',
      '    end',
      'end',
      '',
    ].join('\n');
    const arr = [
      'classdef Arr < matlab.mixin.indexing.RedefinesParen',
      '    properties',
      '        data',
      '    end',
      '    methods',
      '        function r = go(obj)',
      '            r = magsq(obj(1));',
      '            c = obj;',
      '            r = magsq(c, 2);',
      '        end',
      '        function r = magsq(obj, varargin)',
      '            r = 0;',
      '        end',
      '    end',
      '    methods (Access = protected)',
      '        function varargout = parenReference(obj, op)',
      '            varargout{1} = obj.data(op(1).Indices{:});',
      '        end',
      '    end',
      'end',
      '',
    ].join('\n');
    const files = {
      'codegraph.json': JSON.stringify({ matlab: { startup: "addpath('lib');" } }),
      'lib/Seg2.m': seg2,
      'lib/isj.m': 'function t = isj(x)\nt = false;\nend\n',
      'lib/Arr.m': arr,
      'lib/magsq.m': 'function r = magsq(x, varargin)\nr = sqrt(sum(x.^2));\nend\n',
    };
    // Only `control` takes `e` for a Seg2.
    expect(into(await callsOut(files, 'lib/Seg2.m'), 'isj')).toEqual(['lib/Seg2.m:27 Seg2::control -> Seg2::isj']);
    // `obj(1)` runs Arr's own parenReference; a whole copy of the object is still one.
    expect(into(await callsOut(files, 'lib/Arr.m'), 'magsq')).toEqual(['lib/Arr.m:9 Arr::go -> Arr::magsq']);
  });

  it('ends a sync where a fresh index ends: a second class gains the method and loses it, a function of the name comes and goes, the class and its superclass leave the path, the superclass changes, the method goes', async () => {
    const base = (withChildren: boolean): string =>
      cls('Base', 'handle', withChildren ? method('c = children(obj, uid)', '            c = uid;\n') : method('c = other(obj)', '            c = 1;\n'));
    const other = (withChildren: boolean): string =>
      cls('Other', 'handle', withChildren ? method('c = children(obj, uid)', '            c = 2;\n') : method('c = other(obj)', '            c = 2;\n'));
    // A classdef in a class folder, its method in a file of its own (the call is in a class folder's function file).
    const node = (sup: string): string => `classdef Node < ${sup}\n    methods\n        show(obj, h)\n    end\nend\n`;
    const show = "function show(obj, h)\nt = getappdata(h, 'tree');\nc = children(t, 1);\nend\n";
    const steps = await syncedAndFreshEachStep(
      {
        'codegraph.json': JSON.stringify({ matlab: { startup: "addpath('app');\naddpath('lib');" } }),
        'lib/Base.m': base(true),
        'lib/keep.m': 'function keep()\nend\n',
        'app/@Node/Node.m': node('Base'),
        'app/@Node/show.m': show,
      },
      // Another class, on the path, gains the method, then loses it.
      { 'lib/Other.m': other(true) },
      { 'lib/Other.m': other(false) },
      { 'app/children.m': 'function c = children(t, uid)\nc = 3;\nend\n' },
      { 'app/children.m': null },
      { 'lib/Base.m': null, 'old/Base.m': base(true) },
      { 'old/Base.m': null, 'lib/Base.m': base(true) },
      // The class folder itself leaves the path, then comes back.
      { 'app/@Node/Node.m': null, 'app/@Node/show.m': null, 'off/@Node/Node.m': node('Base'), 'off/@Node/show.m': show },
      { 'off/@Node/Node.m': null, 'off/@Node/show.m': null, 'app/@Node/Node.m': node('Base'), 'app/@Node/show.m': show },
      { 'app/@Node/Node.m': node('handle') },
      { 'app/@Node/Node.m': node('Base') },
      { 'lib/Base.m': base(false) },
    );
    const linked = (at: string): string => `${at}/@Node/show.m Node::show -calls-> Base::children @ lib/Base.m`;
    expect(steps.map((st) => st.synced.filter((e) => /^(?:app|off)\/@Node\/show\.m /.test(e) && e.includes('children')))).toEqual([
      [],
      [linked('app')],
      ['app/@Node/show.m Node::show -calls-> children @ app/children.m'],
      [linked('app')],
      [],
      [linked('app')],
      [linked('off')],
      [linked('app')],
      [],
      [linked('app')],
      [],
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
  }, 240_000);

  // The second review's fixtures: `Node < Base`, Base defines `kids`, `app/@Node/show.m` calls `kids(t, 1)`; `lib` comes first on the path.
  const KIDS = {
    'codegraph.json': JSON.stringify({ matlab: { startup: "addpath('app');\naddpath('lib');" } }),
    'lib/Base.m': cls('Base', 'handle', method('c = kids(obj, uid)', '            c = uid;\n')),
    'lib/keep.m': 'function keep()\nend\n',
    'app/@Node/Node.m': 'classdef Node < Base\n    methods\n        show(obj, h)\n    end\nend\n',
    'app/@Node/show.m': "function show(obj, h)\nt = getappdata(h, 'tree');\nc = kids(t, 1);\nend\n",
  };
  const otherKids = (sup: string): string => cls('Other', sup, method('c = kids(obj, uid)', '            c = 2;\n'));

  it("ends a sync where a fresh index ends when a copy of a class comes ahead of another or goes, and when an Octave file of the method's name comes into the caller's folder or goes", async () => {
    const midHandle = 'classdef Mid < handle\nend\n';
    const octave = 'function c = kids(obj, uid)\nc = 3;\nendfunction\n';
    const steps = await syncedAndFreshEachStep(
      {
        ...KIDS,
        // Other < Mid < Node: a descendant of Node, which stops no guess; until `lib/Mid.m < handle` comes ahead of `app/Mid.m`.
        'app/Mid.m': 'classdef Mid < Node\nend\n',
        'lib/Other.m': otherKids('Mid'),
        // The dotted form's guess reads the same chains.
        'app/useit2.m': 'function useit2(t)\nc = t.kids(1);\nend\n',
      },
      { 'lib/Mid.m': midHandle },
      { 'lib/Mid.m': null },
      { 'lib/Mid.m': midHandle },
      { 'lib/Mid.m': null },
      // An Octave `kids.m` beside show.m is what runs, which no method node stands for.
      { 'app/@Node/kids.m': octave },
      { 'app/@Node/kids.m': null },
      { 'app/@Node/kids.m': octave },
      { 'app/@Node/kids.m': 'function c = kids(obj, uid)\nc = 3;\nend\n' },
      { 'app/@Node/kids.m': octave },
      // The caller's copy of Node goes, and comes back: with none, Other blocks.
      { 'app/@Node/kids.m': 'function c = kids(obj, uid)\nc = 3;\nend\n' },
      { 'app/@Node/Node.m': null },
      { 'app/@Node/Node.m': KIDS['app/@Node/Node.m'] },
    );
    const inherited = 'app/@Node/show.m Node::show -calls-> Base::kids @ lib/Base.m';
    const own = 'app/@Node/show.m Node::show -calls-> Node::kids @ app/@Node/kids.m';
    expect(steps.map((st) => st.synced.filter((e) => e.startsWith('app/@Node/show.m ') && e.includes('kids')))).toEqual([
      [],
      [inherited],
      [],
      [inherited],
      [],
      [inherited],
      [],
      [own],
      [],
      [own],
      [],
      [own],
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
      expect(st.syncedDormant).toEqual(st.freshDormant);
    }
  }, 240_000);

  it("lets a class lift the block only when every copy of it that defines the method is of the caller's own copy's hierarchy", async () => {
    // The review's fxU0–fxU2, with `old/` off the path.
    const blocked = { ...KIDS, 'lib/Other.m': otherKids('handle') };
    expect(into(await callsOut(blocked, 'app/@Node/show.m'), 'kids')).toEqual([]);
    // A stale copy off the path that descends from Node, or a copy of Node that inherits from Other: the on-path Other still blocks.
    expect(into(await callsOut({ ...blocked, 'old/Other.m': 'classdef Other < Node\nend\n' }, 'app/@Node/show.m'), 'kids')).toEqual([]);
    expect(into(await callsOut({ ...blocked, 'old/Node.m': 'classdef Node < Other\nend\n' }, 'app/@Node/show.m'), 'kids')).toEqual([]);
    // Other descending from the caller's Node stops nothing.
    expect(into(await callsOut({ ...KIDS, 'lib/Other.m': otherKids('Node') }, 'app/@Node/show.m'), 'kids')).toEqual([
      'app/@Node/show.m:3 Node::show -> Base::kids [guess caller-class]',
    ]);
  });

  it("links a guess only to the method of the caller's own copy of the class or one it inherits, and none when its folder has a file of the name with no method", async () => {
    // `Octave/@ChainLink/rne.m` is Octave code, `@ChainLink/rne.m` another implementation's.
    const robot = (dir: string, rne: string): Record<string, string> => ({
      [`${dir}/@Robot/Robot.m`]: "function r = Robot()\nr = class(struct(), 'Robot');\nend\n",
      [`${dir}/@Robot/rne.m`]: rne,
    });
    const files = {
      ...robot('Octave', 'function tau = rne(robot, q)\ntau = 0;\nendfunction\n'),
      ...robot('main', 'function tau = rne(robot, q)\ntau = 1;\nend\n'),
      'Octave/@Robot/crossterm.m': "function c = crossterm(robot, h)\nmech2 = getappdata(h, 'r');\nc = rne(mech2, 1);\nend\n",
    };
    expect(into(await callsOut(files, 'Octave/@Robot/crossterm.m'), 'rne')).toEqual([]);
    // Nor to another copy's method when the caller's copy has no file of the name.
    const noFile = Object.fromEntries(Object.entries(files).filter(([f]) => f !== 'Octave/@Robot/rne.m'));
    expect(into(await callsOut(noFile, 'Octave/@Robot/crossterm.m'), 'rne')).toEqual([]);
    // A classdef whose folder has an Octave `kids.m`: that runs, not Base's inherited one.
    expect(into(await callsOut({ ...KIDS, 'app/@Node/kids.m': 'function c = kids(obj, uid)\nc = 3;\nendfunction\n' }, 'app/@Node/show.m'), 'kids')).toEqual([]);
    expect(into(await callsOut(KIDS, 'app/@Node/show.m'), 'kids')).toEqual(['app/@Node/show.m:3 Node::show -> Base::kids [guess caller-class]']);
  });

  const ISJ_PATH = {
    'codegraph.json': JSON.stringify({ matlab: { startup: "addpath('lib');" } }),
    'lib/isj.m': 'function t = isj(x, varargin)\nt = false;\nend\n',
  };

  it('dispatches on no copy that a `global` or `persistent` declaration writes', async () => {
    // The review's fxE Pqr5.m.
    const pqr5 = cls('Pqr5', '', [
      method('r = viaGlobal(ets)', '            e = ets(1);\n            global e\n            r = isj(e);\n'),
      method('r = viaPersistent(ets)', '            persistent e\n            r = isj(e);\n            e = ets(1);\n'),
      method('r = viaMultiCopy(ets)', '            e = ets(1);\n            [e, n] = deal(5, 1);\n            r = isj(e);\n'),
      method('r = control(ets)', '            e = ets(1);\n            r = isj(e);\n'),
      method('t = isj(e, varargin)', '            t = true;\n'),
    ].join(''));
    expect(into(await callsOut({ ...ISJ_PATH, 'lib/Pqr5.m': pqr5 }, 'lib/Pqr5.m'), 'isj')).toEqual(['lib/Pqr5.m:20 Pqr5::control -> Pqr5::isj']);
  });

  it("dispatches on no element or copy of an operator method's first parameter, which may be a number (`2 + c` calls `plus(2, c)`)", async () => {
    const num = cls('Num', '', [
      method('r = plus(a, b)', '            r = isj(a(1));\n            e = a(2);\n            r = isj(e);\n            r = isj(2, a);\n            r = isj(a);\n'),
      method('r = scale(a, b)', '            r = isj(a(1));\n'),
      method('t = isj(e, varargin)', '            t = true;\n'),
    ].join(''));
    // Only today's direct rule, `isj(a)`, stays; a method that is no operator keeps its element's dispatch.
    expect(into(await callsOut({ ...ISJ_PATH, 'lib/Num.m': num }, 'lib/Num.m'), 'isj')).toEqual([
      'lib/Num.m:11 Num::scale -> Num::isj',
      'lib/Num.m:8 Num::plus -> Num::isj',
    ]);
  });

  it('labels the guess in synthesized-hop', () => {
    expect(describeSynthesizedHop({ source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic', metadata: { via: 'caller-class' } })).toEqual({ summary: "argument taken for the caller's class", detail: '' });
  });
});
