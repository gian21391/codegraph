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
import { allEdges, indexOfProject, edgesOfProject, syncedAndFresh, syncedAndFreshEachStep, tempDir, unresolvedRows, useAllGrammars, writeTree, type SyncedStep } from './matlab-helpers';

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
      'NSGAII.m': cls('NSGAII', 'ALGORITHM', method('main(Algorithm, Problem)', '            disp(1);\n')),
      // More overrides than a name keeps unfiltered: the one the query names is the one kept.
      ...Object.fromEntries(['MOEAD', 'SPEA2', 'IBEA'].map((a) => [`${a}.m`, cls(a, 'ALGORITHM', method('main(Algorithm, Problem)', '            disp(2);\n'))])),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'Solve NSGAII main' })).content[0]!.text;
      const flow = text.slice(text.indexOf('Flow'), text.indexOf('Flow') + 600);
      expect(flow).toMatch(/1\. Solve \(ALGORITHM\.m:3\)\n.*calls\n2\. main \(ALGORITHM\.m:6\)\n.*dynamic: base → override @NSGAII\.m:3\n3\. main \(NSGAII\.m:3\)/);
      expect(text).not.toMatch(/use Read|Read the/);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB self call of a method only subclasses define', () => {
  const VEHICLE = cls('Vehicle', 'handle', method('run(veh, u)', '            [t, y] = ode45(@(t, y) veh.deriv(t, y, u), [0 1], 0);\n'));
  const SUBS = {
    'Bicycle.m': cls('Bicycle', 'Vehicle', method('d = deriv(veh, t, y, u)', '            d = 1;\n')),
    'Unicycle.m': cls('Unicycle', 'Vehicle', method('d = deriv(veh, t, y, u)', '            d = 2;\n')),
  };

  it('links the call to each subclass\'s definition, nearest down each line (RTB Vehicle::deriv)', async () => {
    expect(await synthesized({
      'Vehicle.m': VEHICLE,
      ...SUBS,
      // Below Bicycle, its own override takes over.
      'Racer.m': cls('Racer', 'Bicycle', method('d = deriv(veh, t, y, u)', '            d = 3;\n')),
    })).toEqual([
      'Bicycle::deriv -> Racer::deriv @ Racer.m (matlab-override)',
      'Vehicle::run -> Bicycle::deriv @ Bicycle.m (matlab-subclass-method)',
      'Vehicle::run -> Unicycle::deriv @ Unicycle.m (matlab-subclass-method)',
    ]);
  });

  it('links nothing for a call on a variable of no stated class, and nothing extra when the class defines the method', async () => {
    expect(await synthesized({
      'drive.m': 'function drive(veh)\nveh.deriv(0, 0, 0);\nend\n',
      'Vehicle.m': cls('Vehicle', 'handle', method('stop(veh)')),
      ...SUBS,
    })).toEqual([]);
    expect(await synthesized({
      'Vehicle.m': cls('Vehicle', 'handle', method('run(veh, u)', '            veh.deriv(0, 0, u);\n') + method('d = deriv(veh, t, y, u)', '            d = 0;\n')),
      ...SUBS,
    })).toEqual([
      'Vehicle::deriv -> Bicycle::deriv @ Bicycle.m (matlab-override)',
      'Vehicle::deriv -> Unicycle::deriv @ Unicycle.m (matlab-override)',
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
      'Gen.m': cls('Gen', 'handle', method('all(CGen)', '            [t, allT] = CGen.genfkine;\n            if CGen.verbose\n            end\n            g = CGen.Gain;\n') + method('[t, a] = genfkine(CGen)', '            t = 1; a = 2;\n')).replace('    methods\n', '    properties\n        Gain\n        verbose\n    end\n    methods\n'),
    });
    expect(edges).toEqual(['Gen.m Gen::all -calls-> Gen::genfkine @ Gen.m']);
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

  it('links nothing on a variable of no stated class, even with one method of the name: a struct read (fieldtrip data.fsample, physbase par.plot)', async () => {
    const { edges, unresolved } = await indexOfProject({
      'meeg.m': cls('meeg', 'handle', method('f = fsample(obj)', '            f = 1;\n')),
      'AccObj.m': cls('AccObj', 'handle', method('plot(obj)')),
      'ft_remove.m': 'function ft_remove(data)\nfs = data.fsample;\nend\n',
      'monitor.m': 'function monitor(par)\nif par.plot\n  disp(1);\nend\nend\n',
    });
    expect(edges.filter((e) => /^(ft_remove|monitor)\.m /.test(e))).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('emits no reference for a command\'s argument, a deeper chain, an assignment target or an untyped local', () => {
    const code = [
      'function f(obj, p)',
      'delete hs_err_pid30205.log',
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
    const listing = '-rw-rw-r--   1 alsoper2 controls  110630 Aug 21 14:33 hs_err_pid30205.log\n';
    const r = extractFromSource('notes.m', listing, 'matlab');
    expect(r.unresolvedReferences.filter((u) => u.referenceName.includes('hs_err'))).toEqual([]);
  });

  it('tags the reference bare, and on the own object self', () => {
    const code = cls('Gen', 'handle', method('all(CGen)', '            CGen.genfkine;\n            m = Model();\n            x = m.compute;\n            y = Model.make;\n'));
    expect(refs('Gen.m', code).filter((r) => / calls:/.test(r))).toEqual([
      '4 calls:Gen::genfkine [bare,self]',
      '5 calls:Model',
      '6 calls:Model::compute [bare]',
      '7 calls:Model::make [bare]',
    ]);
  });

  it('refuses a bare member on a variable of no stated class in the resolver too (a second fence)', async () => {
    const root = tempDir('cg-matlab-dispatch-fence-');
    writeTree(root, {
      'meeg.m': cls('meeg', 'handle', method('f = fsample(obj)', '            f = 1;\n')),
      'user.m': 'function user(data)\nfs = data.fsample(1);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const context = new ReferenceResolver(root, (cg as unknown as { queries: Queries }).queries).getResolutionContext();
      const user = cg.getNodesInFile('user.m').find((n) => n.kind === 'function')!;
      const ref = { fromNodeId: user.id, referenceName: 'data.fsample', referenceKind: 'calls' as const, line: 2, column: 5, filePath: 'user.m', language: 'matlab' as const };
      // Written with an argument list, the one class that defines it answers (as today).
      expect(matchMatlabReference(ref, context)?.targetNodeId).toBe(cg.getNodesInFile('meeg.m').find((n) => n.name === 'fsample')!.id);
      expect(matchMatlabReference({ ...ref, candidates: ['bare'] }, context)).toBeNull();
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('links no member of an old-style @Cls class: its object is a struct, and `this.path` a field (fieldtrip @meeg)', async () => {
    const { edges, unresolved } = await indexOfProject({
      '@meeg/meeg.m': "function D = meeg(varargin)\nD = class(struct('path', '.'), 'meeg');\nend\n",
      '@meeg/path.m': 'function p = path(this)\np = this.path;\nend\n',
      '@meeg/clone.m': 'function c = clone(this)\npth = this.path;\nc = pth;\nend\n',
    });
    expect(edges.filter((e) => e.includes('meeg::path'))).toEqual([]);
    // A method carries the name: the rows stay, edgeless (a classdef rewrite would make them calls).
    expect(unresolved).toEqual(['@meeg/clone.m:2 calls:meeg::path', '@meeg/path.m:2 calls:meeg::path']);
  });

  it('links no member that is both a method and a property of the class (RTB `n`)', async () => {
    const { edges, unresolved } = await indexOfProject({
      'SerialLink.m': cls('SerialLink', 'handle', method('go(robot)', '            k = robot.n;\n')).replace('    methods\n', '    properties\n        n\n    end\n    methods\n'),
      'ETS3.m': cls('ETS3', 'handle', method('k = n(obj)', '            k = 1;\n')),
    });
    expect(edges.filter((e) => e.startsWith('SerialLink.m SerialLink::go'))).toEqual([]);
    expect(unresolved).toEqual(['SerialLink.m:7 calls:SerialLink::n']);
  });
});

describe('MATLAB method on a variable of no stated class', () => {
  it('never takes a constructor for its method (RTB `g.Astar(…)` on a PGraph)', async () => {
    const edges = await edgesOfProject({
      'Astar.m': cls('Astar', 'handle', method('obj = Astar(varargin)')),
      'plan.m': 'function plan(g)\np = g.Astar(1, 2);\nend\n',
    });
    expect(edges.filter((e) => e.startsWith('plan.m '))).toEqual([]);
  });
});

describe('MATLAB parameter named after its class (G3)', () => {
  const PROBLEMS = {
    'PROBLEM.m': cls('PROBLEM', 'handle', method('P = Evaluation(obj, X)', '            P = obj.CalObj(X);\n') + method('Y = CalObj(obj, X)', '            Y = X;\n')),
    'DTLZ2.m': cls('DTLZ2', 'PROBLEM', method('Y = CalObj(obj, X)', '            Y = 2 * X;\n')),
    'MFDE.m': cls('MFDE', 'handle', method('P = Evaluation(obj, X)', '            P = X;\n')),
  };

  it('takes the root class the parameter is named after, ignoring case, and the edge says so', async () => {
    const root = tempDir('cg-matlab-dispatch-g3-');
    writeTree(root, { ...PROBLEMS, 'NSGAII.m': cls('NSGAII', 'handle', method('main(Algorithm, Problem)', '            P = Problem.Evaluation(1);\n')) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const main = cg.getNodesInFile('NSGAII.m').find((n) => n.name === 'main')!;
      const out = cg.getOutgoingEdgesFrom([main.id]).filter((e) => e.kind === 'calls');
      expect(out.map((e) => `${cg.getNode(e.target)!.qualifiedName} ${(e.metadata as Record<string, unknown>).via}`)).toEqual(['PROBLEM::Evaluation receiver-name']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
    // With G2: algorithm → Evaluation → the problem's CalObj.
    expect(await synthesized({ ...PROBLEMS })).toEqual(['PROBLEM::CalObj -> DTLZ2::CalObj @ DTLZ2.m (matlab-override)']);
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
    writeTree(root, { ...PROBLEMS, 'NSGAII.m': cls('NSGAII', 'handle', method('main(Algorithm, Problem)', '            P = Problem.Evaluation(1);\n')) });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const main = cg.getNodesInFile('NSGAII.m').find((n) => n.name === 'main')!;
      const edge = cg.getOutgoingEdgesFrom([main.id]).find((e) => e.kind === 'calls')!;
      expect(edge.provenance).toBe('heuristic');
      expect(describeSynthesizedHop(edge)?.summary).toBe('receiver named after its class');
      const text = (await new ToolHandler(cg).execute('codegraph_explore', { query: 'NSGAII main PROBLEM Evaluation CalObj' })).content.map((c) => (c as { text: string }).text).join('\n');
      expect(text).toMatch(/1\. main \(NSGAII\.m:3\)\n\s*↓ dynamic: receiver named after its class\n2\. Evaluation \(PROBLEM\.m:3\)/);
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
      ['alg.m alg -calls-> MFDE::Evaluation @ MFDE.m'],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
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
      'MOEA.m': alg('MOEA'),
      'SPEA.m': alg('SPEA'),
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
  });

  it('when a classdef line\'s superclass changes', async () => {
    const r = await syncedAndFresh(
      { 'A.m': A, 'B.m': B, 'C.m': cls('C', 'handle', method('step(obj)')) },
      { 'B.m': cls('B', 'C', method('step(obj)')) },
    );
    expect(r.synced.filter((e) => e.includes('-> B::step'))).toEqual(['C.m C::step -calls-> B::step @ B.m']);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('when the base method comes later: the self call reaches the subclasses, then the base and its override', async () => {
    const vehicle = (extra: string): string => cls('Vehicle', 'handle', method('run(veh)', '            veh.deriv(1);\n') + extra);
    const r = await syncedAndFresh(
      { 'Vehicle.m': vehicle(''), 'Bicycle.m': cls('Bicycle', 'Vehicle', method('deriv(veh, t)')) },
      { 'Vehicle.m': vehicle(method('deriv(veh, t)')) },
    );
    expect(r.steps).toEqual([
      ['Bicycle.m Bicycle -extends-> Vehicle @ Vehicle.m', 'Vehicle.m Vehicle::run -calls-> Bicycle::deriv @ Bicycle.m'],
      ['Bicycle.m Bicycle -extends-> Vehicle @ Vehicle.m', 'Vehicle.m Vehicle::deriv -calls-> Bicycle::deriv @ Bicycle.m', 'Vehicle.m Vehicle::run -calls-> Vehicle::deriv @ Vehicle.m'],
    ]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('when the class a parameter is named after is added, or renamed', async () => {
    const problem = (name: string): string => cls(name, 'handle', method('P = Evaluation(obj, X)', '            P = X;\n'));
    const r = await syncedAndFresh(
      { 'alg.m': 'function alg(Algorithm, Problem)\nProblem.Evaluation(1);\nend\n', 'MFDE.m': problem('MFDE') },
      { 'PROBLEM.m': problem('PROBLEM') },
      { 'PROBLEM.m': null, 'PROB.m': problem('PROB') },
      { 'PROB.m': null, 'PROBLEM.m': problem('PROBLEM') },
    );
    expect(r.steps.map((s) => s.filter((e) => e.startsWith('alg.m ')))).toEqual([
      // One class defines it: that class's, whatever the parameter's name (as before).
      ['alg.m alg -calls-> MFDE::Evaluation @ MFDE.m'],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
      [],
      ['alg.m alg -calls-> PROBLEM::Evaluation @ PROBLEM.m'],
    ]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  });

  it('when a property is added with the name of a member read without an argument list', async () => {
    const r = await syncedAndFresh(
      { 'Model.m': cls('Model', 'handle', method('reset(obj)')), 'user.m': 'function user()\nm = Model();\nt = m.Total;\nend\n' },
      { 'Model.m': cls('Model', 'handle', method('reset(obj)')).replace('    methods\n', '    properties\n        Total\n    end\n    methods\n') },
    );
    expect(r.synced.filter((e) => e.includes('Total'))).toEqual([]);
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
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
  });
});

describe('MATLAB member call rows: kept while the member has a carrier, and a sync keeps that true', () => {
  const withProps = (code: string, props: string): string => code.replace('    methods\n', `    properties\n${props}    end\n    methods\n`);
  const expectEveryStepFresh = (steps: Array<{ synced: string[]; fresh: string[]; syncedRows: string[]; freshRows: string[] }>): void => {
    for (const step of steps) {
      expect(step.synced).toEqual(step.fresh);
      expect(step.syncedRows).toEqual(step.freshRows);
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
      { 'Vehicle.m': cls('Vehicle', 'handle', method('path(veh, t, y, u)', '            veh.deriv(t, y, u);\n')) },
      { 'Bicycle.m': cls('Bicycle', 'Vehicle', method('d = deriv(veh, t, y, u)', '            d = 1;\n')) },
    );
    expect(steps[0]!.synced).toContain('Vehicle.m Vehicle::path -calls-> Bicycle::deriv @ Bicycle.m');
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

  it('deletes a member call\'s row only when no symbol could answer it: none at all, or for a read, no callable one', async () => {
    const { unresolved } = await indexOfProject({
      'Other.m': withProps(cls('Other', 'handle', method('r = run(obj)', '            r = 1;\n')), '        limit\n'),
      'Model.m': cls('Model', 'handle', method('go(obj)', '            a = obj.limit;\n            b = obj.run;\n            c = obj.nothing;\n            obj.limit(1);\n            obj.nothing(1);\n')),
    });
    expect(unresolved).toEqual(['Model.m:5 calls:Model::run', 'Model.m:7 calls:Model::limit']);
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
  const CALLER2 = "function caller2(r)\neval(['x = Model.' 'make(r);']);\nh = str2func(sprintf('%s.%s', 'pkg', 'scale'));\nh(r);\nend\n";
  const MODEL = 'classdef Model\n    methods (Static)\n        function o = make(k)\n            o = k;\n        end\n    end\nend\n';
  const SCALE = 'function y = scale(x)\ny = 2*x;\nend\n';
  const SHIFT = 'function y = shift(x)\ny = x+1;\nend\n';

  it('tags a dotted name the interpreter built `computed`, and not one a literal at the call spells', () => {
    expect(refs('caller.m', CALLER).filter((r) => r.includes('pkg::'))).toEqual(['2 calls:pkg::scale [computed]', '4 calls:pkg::shift [computed]']);
    expect(refs('caller2.m', CALLER2).filter((r) => /Model::|pkg::/.test(r))).toEqual([
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
      { 'caller.m': CALLER, 'caller2.m': CALLER2, 'Model.m': MODEL, '+pkg/scale.m': SCALE, '+pkg/shift.m': SHIFT },
      { '+pkg/scale.m': null, '+pkg/shift.m': null, 'Model.m': null },
      { '+pkg/scale.m': SCALE, '+pkg/shift.m': SHIFT, 'Model.m': MODEL },
    );
    expect(steps[0]!.syncedRows).toEqual([
      'caller.m:2 calls:pkg::scale',
      'caller.m:4 calls:pkg::shift',
      'caller2.m:2 calls:Model::make',
      'caller2.m:3 function_ref:pkg::scale',
      'caller2.m:4 calls:pkg::scale',
    ]);
    expect(steps[1]!.synced.filter((e) => e.startsWith('caller') && e.includes('-calls->'))).toEqual([
      'caller.m caller -calls-> pkg::scale @ +pkg/scale.m',
      'caller.m caller -calls-> pkg::shift @ +pkg/shift.m',
      'caller2.m caller2 -calls-> Model::make @ Model.m',
      'caller2.m caller2 -calls-> pkg::scale @ +pkg/scale.m',
    ]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
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
      { 'Other.m': OTHER_PROPS },
      { 'Other.m': null },
    );
    expect(steps.map((st) => st.syncedRows.length)).toEqual([USERS, 0]);
    expectEveryStepFresh(steps);
  }, 600_000);
});

describe('MATLAB member scan: linear in the text, and started by MATLAB names only', () => {
  it('finds a member written `.f`, `. f`, `@f` or `f@`, and a word whole', () => {
    const hit = matlabNameScan(new Set(['beep']), new Set(['recalib']));
    expect(['a.recalib(2)', 'a. recalib(2)', 'a .\n  recalib', 'obj@recalib(x)', 'recalib @Base(obj)', 'beep;', 'x = beep'].filter((t) => !hit(t))).toEqual([]);
    expect(['recalib(2)', 'a.recalib2(1)', 'a.xrecalib', 'beeper', 'my_beep', '1recalib', 'recalib = 3'].filter(hit)).toEqual([]);
    // Past the pattern's size, every word is looked up: the same answers.
    const many = new Set(['beep', ...Array.from({ length: 40 }, (_, i) => `zz${i}`)]);
    const wide = matlabNameScan(many, new Set(['recalib']));
    expect(['beep;', 'x = beep', 'zz7(1)'].filter((t) => !wide(t))).toEqual([]);
    expect(['beeper', 'my_beep', 'zz77'].filter(wide)).toEqual([]);
  });

  it('starts no member scan for a JavaScript file\'s new names, and a sync still ends where a fresh index does', async () => {
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
    // The JavaScript step starts nothing; the MATLAB method does.
    expect(carrierLines.filter((l) => /members [^;]*\bWeight\b/.test(l))).toEqual([]);
    expect(carrierLines.filter((l) => /members [^;]*\bTotal\b/.test(l)).length).toBe(1);
    expect(steps.map((st) => st.synced.filter((e) => e.startsWith('user.m ') && e.includes('-calls->')))).toEqual([[], ['user.m user -calls-> Model::Total @ Model.m']]);
    for (const st of steps) {
      expect(st.synced).toEqual(st.fresh);
      expect(st.syncedRows).toEqual(st.freshRows);
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
  ): Promise<{ synced: string[]; fresh: string[]; syncedRows: string[]; freshRows: string[]; record: string | null; afterIndexAll: string | null }> {
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
      writeTree(freshRoot, Object.fromEntries(Object.entries(current).filter(([, c]) => c !== null)));
      const fresh = await CodeGraph.init(freshRoot, { index: true });
      let freshEdges: string[];
      try {
        freshEdges = allEdges(fresh);
      } finally {
        fresh.close();
      }
      return { synced, fresh: freshEdges, syncedRows, freshRows: unresolvedRows(freshRoot), record, afterIndexAll: null };
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

  /** Makes the first re-extraction of the carrier step throw: a sync killed after its rows are dropped. */
  const killAtReextract = (): (() => void) => {
    const proto = ExtractionOrchestrator.prototype as unknown as { indexFile: (p: string, again?: boolean) => Promise<unknown> };
    const orig = proto.indexFile;
    proto.indexFile = function (this: unknown, p: string, again?: boolean) {
      if (again === true) throw new Error('simulated kill at the carrier re-extraction');
      return orig.call(this, p, again);
    };
    return () => {
      proto.indexFile = orig;
    };
  };

  /** Makes the carrier step's first row deletion throw: a sync killed after the step is recorded, before it changed anything. */
  const killAtDrop = (): (() => void) => {
    const proto = QueryBuilder.prototype as unknown as { deleteReferencesByRowIds: (ids: number[]) => number };
    const orig = proto.deleteReferencesByRowIds;
    proto.deleteReferencesByRowIds = function () {
      throw new Error('simulated kill at the carrier drop');
    };
    return () => {
      proto.deleteReferencesByRowIds = orig;
    };
  };

  const expectFresh = (r: { synced: string[]; fresh: string[]; syncedRows: string[]; freshRows: string[] }): void => {
    expect(r.synced).toEqual(r.fresh);
    expect(r.syncedRows).toEqual(r.freshRows);
  };

  it('re-extracts the files of a member that gained its carrier, killed at the first of them (case 2)', async () => {
    const r = await killedThenSynced({ 'Model.m': MODEL_WITH, 'user.m': USER }, [{ 'Model.m': MODEL_WITHOUT }, { 'Model.m': MODEL_WITH }], killAtReextract);
    expect(r.synced).toContain('user.m user -calls-> Model::recalib @ Model.m');
    expectFresh(r);
    expect(JSON.parse(r.record!).files).toEqual(['user.m']);
  }, 120_000);

  it('drops the rows of a member that lost its carrier, killed before the drop', async () => {
    const r = await killedThenSynced({ 'Model.m': MODEL_WITH, 'Other.m': OTHER, 'rater.m': RATER }, [{ 'Other.m': null }], killAtDrop);
    expect(r.syncedRows).toEqual([]);
    expectFresh(r);
    expect(JSON.parse(r.record!).drop.length).toBe(1);
  }, 120_000);

  it('finishes a step that drops and re-extracts, killed between the two', async () => {
    const r = await killedThenSynced(
      { 'Model.m': MODEL_WITH, 'Other.m': OTHER, 'rater.m': RATER, 'user.m': USER },
      [{ 'Model.m': MODEL_WITHOUT }, { 'Model.m': MODEL_WITH, 'Other.m': null }],
      killAtReextract,
    );
    expect(r.synced).toContain('user.m user -calls-> Model::recalib @ Model.m');
    expectFresh(r);
    expect(JSON.parse(r.record!)).toMatchObject({ files: ['user.m'] });
  }, 120_000);

  it('is cleared by a full index, which finishes it', async () => {
    const root = tempDir('cg-matlab-killed-index-');
    const freshRoot = tempDir('cg-matlab-killed-index-fresh-');
    try {
      writeTree(root, { 'Model.m': MODEL_WITH, 'user.m': USER });
      let cg = await CodeGraph.init(root, { index: true });
      writeTree(root, { 'Model.m': MODEL_WITHOUT });
      await cg.sync();
      writeTree(root, { 'Model.m': MODEL_WITH });
      const restore = killAtReextract();
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
      writeTree(freshRoot, { 'Model.m': MODEL_WITH, 'user.m': USER });
      expect(unresolvedRows(root)).toEqual((await indexOfProject({ 'Model.m': MODEL_WITH, 'user.m': USER })).unresolved);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
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
