/**
 * MATLAB resolution routing: the language gate that keeps other languages'
 * calls out of MATLAB symbols, `@` handles going through MATLAB's own lookup,
 * and class-folder methods contained by their class (across index and sync).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { createResolver } from '../src/resolution';
import { matchMatlabReference } from '../src/resolution/matlab-lookup';
import { extractFromSource } from '../src/extraction';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { ToolHandler } from '../src/mcp/tools';
import { isMatlabClassFolderFile } from '../src/resolution/matlab-class-folders';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** `source-file source-qn -kind-> target-qn @ target-file` of every non-`contains` edge in the project. */
function allEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const f of cg.getFiles()) {
    const ids = cg.getNodesInFile(f.path).map((n) => n.id);
    for (const e of cg.getOutgoingEdgesFrom(ids)) {
      if (e.kind === 'contains') continue;
      const s = cg.getNode(e.source)!;
      const t = cg.getNode(e.target)!;
      out.push(`${f.path} ${s.qualifiedName} -${e.kind}-> ${t.qualifiedName} @ ${t.filePath}`);
    }
  }
  return out.sort();
}

describe('MATLAB symbols are out of reach of other languages', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-gate-')));
    writeTree(root, {
      'matlab/compute_stats.m': 'function s = compute_stats(x)\n    s = normalize_rows(x);\nend\n',
      'matlab/normalize_rows.m': 'function out = normalize_rows(M)\n    out = M ./ sum(M, 2);\nend\n',
      'matlab/Color.m': 'classdef Color\n    enumeration\n        String, Red\n    end\nend\n',
      'py/run.py': 'def main():\n    a = normalize_rows([[1, 2]])\n    b = compute_stats(1)\n    return a, b\n',
      'js/app.js': 'function main() {\n  const a = normalize_rows([[1, 2]]);\n  return compute_stats(a);\n}\n',
      'c/mex.c': '#include <stdio.h>\nint main(void) {\n    normalize_rows(0);\n    compute_stats(1);\n    return 0;\n}\n',
      'objc/Thing.m': '#import <Foundation/Foundation.h>\n@implementation Thing\n- (void)go {\n    compute_stats(2);\n}\n@end\n',
      'java/Element.java': 'package x;\npublic class Element {\n    public Object make(byte[] b) {\n        return new String(b);\n    }\n}\n',
      // A Django + FastAPI project: their name lookups must not reach a MATLAB
      // classdef (`Robot`) or a MATLAB local function (`get_settings`, tool.m's second).
      'manage.py': 'import os\nimport sys\n\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "app.settings")\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n',
      'app/views.py': 'from django.http import HttpResponse\n\n\ndef index(request):\n    r = Robot()\n    s = get_settings()\n    return HttpResponse(str(r) + str(s))\n',
      'api/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef root():\n    return get_settings()\n',
      'matlab/Robot.m': 'classdef Robot < handle\n    methods\n        function obj = Robot()\n        end\n    end\nend\n',
      'matlab/tool.m': 'function tool()\n    get_settings();\nend\n\nfunction s = get_settings()\n    s = 1;\nend\n',
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links no Python, JavaScript, C, Objective-C or Java call to a name only a .m file defines', () => {
    // Java's `new String(b)` is java.lang.String, not the MATLAB enum member.
    expect(allEdges(cg)).toEqual([
      'api/main.py api/main.py::GET:/ -references-> root @ api/main.py',
      'matlab/compute_stats.m compute_stats -calls-> normalize_rows @ matlab/normalize_rows.m',
      'matlab/tool.m tool -calls-> get_settings @ matlab/tool.m',
    ]);
  });

  it('nor a Django view or a FastAPI handler, through the frameworks\' own name lookups', () => {
    // Both frameworks are live here: FastAPI's handler is a route.
    expect(cg.getNodesInFile('api/main.py').filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /']);
    expect(allEdges(cg).filter((e) => e.startsWith('app/') || e.startsWith('api/'))).toEqual([
      'api/main.py api/main.py::GET:/ -references-> root @ api/main.py',
    ]);
  });
});

describe('MATLAB functions are no overloads of a C++ function', () => {
  it('leaves a C++ project\'s edges as they are without its MATLAB files, whether the MATLAB function is a file\'s or a local one', async () => {
    // Called with two arguments, which only the MATLAB functions take: by its arguments alone,
    // the overload would be a MATLAB one.
    const cpp = {
      'src/main.cpp': 'int run() {\n  return helper(1, 2) + shared(2, 3);\n}\n',
      'src/a/lib.cpp': 'int helper(int x) { return x; }\nint helper(double x) { return 0; }\nint shared(int x) { return x; }\nint shared(double x) { return 0; }\n',
    };
    const edgesOf = async (files: Record<string, string>): Promise<string[]> => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-cpp-')));
      writeTree(root, files);
      const cg = await CodeGraph.init(root, { index: true });
      try {
        return allEdges(cg);
      } finally {
        cg.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    const without = await edgesOf(cpp);
    expect(without).toEqual(['src/main.cpp run -calls-> helper @ src/a/lib.cpp', 'src/main.cpp run -calls-> shared @ src/a/lib.cpp']);
    expect(await edgesOf({
      ...cpp,
      'src/helper.m': 'function y = helper(a, b)\ny = a + b;\nend\n',
      'src/tools.m': 'function tools()\nend\nfunction r = shared(a, b)\nr = a;\nend\n',
    })).toEqual(without);
  });
});

describe('MATLAB lookups keyed on the resolver\'s per-file node arrays', () => {
  it('get the same array for a file until the caches drop, and the same answers from a context that builds a new one per call', async () => {
    const files: Record<string, string> = {
      'main.m': 'function main(v)\n  helper(1);\n  inner();\n  s = Shape(2);\n  area(s);\n  v.go();\n  function inner()\n    helper(2);\n  end\nend\nfunction helper(x)\n  disp(x);\nend\n',
      'Shape.m': 'classdef Shape\n  methods\n    function obj = Shape(n)\n    end\n    function a = area(obj)\n      a = 1;\n    end\n    function go(obj)\n    end\n  end\nend\n',
    };
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-memo-')));
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const resolver = createResolver(root, new QueryBuilder(db.getDb()));
      const context = resolver.getResolutionContext();
      // The memo hits only while the array is the same one: the resolver's per-file cache entry.
      expect(context.getNodesInFile('main.m')).toBe(context.getNodesInFile('main.m'));
      const fresh = { ...context, getNodesInFile: (filePath: string) => [...context.getNodesInFile(filePath)] };
      const refs = Object.keys(files).flatMap((filePath) =>
        extractFromSource(filePath, files[filePath]!, 'matlab').unresolvedReferences.map((r) => ({ ...r, filePath, language: 'matlab' as const })));
      const answers = (ctx: typeof context) => refs.map((r) => `${r.referenceName} -> ${matchMatlabReference(r, ctx)?.targetNodeId ?? null}`);
      const cached = answers(context);
      expect(cached.filter((a) => !a.endsWith('null')).length).toBeGreaterThanOrEqual(5);
      expect(answers(fresh)).toEqual(cached);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB function handles', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-handles-')));
    writeTree(root, {
      'a.m': `function a()
  cellfun(@helperB, {1});
  f = @geom.Circle;
  g = @Robot;
  h = @NoCtor;
  k = @localA;
  p = @privhelp;
  q = @geom.area2;
  r = @pathfn;
  u = @Robot.build;
end

function localA(x)
  disp(x);
end
`,
      'b.m': 'function b()\n  x = 1;\nend\n\nfunction helperB(x)\n  disp(x);\nend\n',
      'pathfn.m': 'function pathfn(x)\n  disp(x);\nend\n',
      'NoCtor.m': 'classdef NoCtor\n  methods\n    function go(obj)\n      disp(obj);\n    end\n  end\nend\n',
      'Robot.m': `classdef Robot < handle
  methods
    function obj = Robot(n)
      obj.n = n;
    end
  end
  methods (Static)
    function r = build()
      r = 1;
    end
  end
end
`,
      '+geom/area2.m': 'function a = area2(r)\n  a = r * r;\nend\n',
      '+geom/Circle.m': `classdef Circle < handle
  methods
    function obj = Circle(r)
      obj.r = r;
    end
  end
end
`,
      'private/privhelp.m': 'function privhelp(x)\n  disp(x);\nend\n',
      'sub/other.m': 'function other()\n  t = @privhelp;\n  w = @Circle;\n  z = arrayfun(@(v) pathfn(v), 1:3);\nend\n',
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves handles by MATLAB lookup: constructors, the class when it has none, private and package functions', () => {
    // `@helperB` is b.m's local function, out of a.m's reach: no edge.
    expect(allEdges(cg).filter((e) => e.startsWith('a.m '))).toEqual([
      'a.m a -references-> NoCtor @ NoCtor.m',
      'a.m a -references-> Robot::Robot @ Robot.m',
      'a.m a -references-> Robot::build @ Robot.m',
      'a.m a -references-> geom::Circle::Circle @ +geom/Circle.m',
      'a.m a -references-> geom::area2 @ +geom/area2.m',
      'a.m a -references-> localA @ a.m',
      'a.m a -references-> pathfn @ pathfn.m',
      'a.m a -references-> privhelp @ private/privhelp.m',
    ]);
  });

  it('reaches no private function from outside its folder, and no package class without an import', () => {
    expect(allEdges(cg).filter((e) => e.startsWith('sub/other.m '))).toEqual([
      'sub/other.m other -calls-> pathfn @ pathfn.m',
    ]);
  });
});

describe('MATLAB class-folder methods are contained by their class', () => {
  let root = '';
  let cg: CodeGraph;

  const write = (rel: string, content: string): void => writeTree(root, { [rel]: content });

  /** `class-qn > member-qn @ member-file [synthesizedBy]` of every edge out of a class node into another file. */
  function crossFileContains(): string[] {
    const out: string[] = [];
    for (const f of cg.getFiles()) {
      for (const cls of cg.getNodesInFile(f.path).filter((n) => n.kind === 'class' || n.kind === 'enum')) {
        for (const e of cg.getOutgoingEdgesFrom([cls.id], ['contains'])) {
          const t = cg.getNode(e.target)!;
          if (t.filePath === cls.filePath) continue;
          out.push(`${cls.qualifiedName} > ${t.qualifiedName} @ ${t.filePath} [${e.metadata?.synthesizedBy}] ${e.provenance ?? 'structural'}`);
        }
      }
    }
    return out.sort();
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-folders-')));
    writeTree(root, {
      '@Robot/Robot.m': 'classdef Robot < handle\n    properties\n        Q\n    end\n    methods\n        function r = Robot()\n            r.Q = 0;\n        end\n    end\nend\n',
      '@Robot/move.m': 'function move(r, x)\n    step(r, aux(x));\nend\n\nfunction y = aux(x)\n    y = x;\nend\n',
      '@Robot/step.m': 'function step(r, x)\n    r.Q = r.Q + x;\nend\n',
      '+geo/@Shape/Shape.m': 'classdef Shape < handle\n    methods\n        function s = Shape()\n        end\n    end\nend\n',
      '+geo/@Shape/area.m': 'function a = area(s)\n    a = 1;\nend\n',
      // An old-style class folder: its constructor is a function, and no classdef declares the class —
      // the class node the extractor makes for it contains the folder's methods all the same.
      '@Legacy/Legacy.m': 'function obj = Legacy()\n    obj = class(struct(), \'Legacy\');\nend\n',
      '@Legacy/show.m': 'function show(obj)\n    disp(1);\nend\n',
      // An enumeration kept in a class folder.
      '@Color/Color.m': 'classdef Color\n    enumeration\n        Red, Green\n    end\nend\n',
      '@Color/describe.m': 'function s = describe(c)\n    s = char(c);\nend\n',
      // Upper-case `.M` files: the classdef and a method file.
      '@Gauge/Gauge.M': 'classdef Gauge < handle\n    properties\n        V\n    end\nend\n',
      '@Gauge/read.M': 'function v = read(g)\n    v = g.V;\nend\n',
      'main.m': 'function main()\n    r = Robot();\n    move(r, 1);\nend\n',
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links each method file of a class folder to the class, and nothing else', () => {
    // move.m's local `aux` is no method.
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'Robot > Robot::move @ @Robot/move.m [matlab-class-folder] structural',
      'Robot > Robot::step @ @Robot/step.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
  });

  it('lists class-folder methods in codegraph_node\'s outline by their own file', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_node', { symbol: 'Robot', includeCode: true });
    const text = res.content[0]!.text;
    const members = text.split('\n').filter((l) => l.startsWith('- '));
    expect(members).toEqual([
      '- Q (property):3 — `Q`',
      '- Robot (method):6 — `function r = Robot()`',
      '- move (method) in `@Robot/move.m:1` — `function move(r, x)`',
      '- step (method) in `@Robot/step.m:1` — `function step(r, x)`',
    ]);
    expect(text).not.toContain('Read `@Robot/Robot.m`');
  });

  it('reads a file directly in a class folder, `.m` or `.M`, as the class\'s (the pass and explore\'s pre-filter share the test)', () => {
    const files = ['@Gauge/read.M', '@Gauge/Gauge.M', '+geo/@Shape/area.m', 'read.M', '@Gauge/sub/read.m', '@Gauge/my-tool.m', '@Gauge/read.mm'];
    expect(files.filter(isMatlabClassFolderFile)).toEqual(['@Gauge/read.M', '@Gauge/Gauge.M', '+geo/@Shape/area.m']);
  });

  it('keeps one edge per method when a method file is edited', async () => {
    write('@Robot/step.m', 'function step(r, x)\n    % moved down a line\n    r.Q = r.Q + 2 * x;\nend\n');
    await cg.sync({ paths: ['@Robot/step.m'] });
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'Robot > Robot::move @ @Robot/move.m [matlab-class-folder] structural',
      'Robot > Robot::step @ @Robot/step.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
  });

  it('adds a method file a sync brings, and drops one it removes', async () => {
    write('@Robot/reset.m', 'function reset(r)\n    r.Q = 0;\nend\n');
    await cg.sync({ paths: ['@Robot/reset.m'] });
    fs.rmSync(path.join(root, '@Robot/move.m'));
    await cg.sync({ paths: ['@Robot/move.m'] });
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'Robot > Robot::reset @ @Robot/reset.m [matlab-class-folder] structural',
      'Robot > Robot::step @ @Robot/step.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
  });

  it('follows the classdef file through an edit, a removal and its return', async () => {
    const classdef = 'classdef Robot < handle\n    properties\n        Q\n        Name\n    end\nend\n';
    write('@Robot/Robot.m', classdef);
    await cg.sync({ paths: ['@Robot/Robot.m'] });
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'Robot > Robot::reset @ @Robot/reset.m [matlab-class-folder] structural',
      'Robot > Robot::step @ @Robot/step.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
    fs.rmSync(path.join(root, '@Robot/Robot.m'));
    await cg.sync({ paths: ['@Robot/Robot.m'] });
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
    write('@Robot/Robot.m', classdef);
    await cg.sync({ paths: ['@Robot/Robot.m'] });
    expect(crossFileContains()).toEqual([
      'Color > Color::describe @ @Color/describe.m [matlab-class-folder] structural',
      'Gauge > Gauge::read @ @Gauge/read.M [matlab-class-folder] structural',
      'Legacy > Legacy::show @ @Legacy/show.m [matlab-class-folder] structural',
      'Robot > Robot::reset @ @Robot/reset.m [matlab-class-folder] structural',
      'Robot > Robot::step @ @Robot/step.m [matlab-class-folder] structural',
      'geo::Shape > geo::Shape::area @ +geo/@Shape/area.m [matlab-class-folder] structural',
    ]);
  });

  it('matches a fresh index after the syncs', async () => {
    const synced = crossFileContains();
    await cg.indexAll();
    expect(crossFileContains()).toEqual(synced);
  });
});

describe('codegraph_explore ranking stays language-neutral', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-')));
    writeTree(root, {
      'src/net/router.h': '#pragma once\n#include <string>\nclass Router {\npublic:\n  int handle(const std::string& path);\nprivate:\n  int dispatch(const std::string& path);\n};\n',
      'src/net/router.cpp': '#include "router.h"\nint Router::handle(const std::string& path) {\n  if (path.empty()) return 0;\n  return dispatch(path);\n}\nint Router::dispatch(const std::string& path) {\n  int n = 0;\n  for (char c : path) n += c;\n  return n;\n}\n',
      'src/trace/trace.cpp': '#include <vector>\nnamespace trace {\nstruct Event { int id; };\nstatic std::vector<Event> g_events;\nint dispatch(const Event& e) {\n  g_events.push_back(e);\n  int total = 0;\n  for (auto& x : g_events) total += x.id;\n  if (total > 100) g_events.clear();\n  total *= 2;\n  total += 1;\n  return total;\n}\nint flush() { return dispatch(Event{1}); }\nint record(int id) { return dispatch(Event{id}); }\nint sample(int id) { return dispatch(Event{id * 2}); }\n}\n',
      'src/util/main.cpp': '#include "../net/router.h"\nint main() { Router r; return r.handle("/x"); }\n',
    });
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a capitalised first word of a question does not seed a C++ namespace of that name', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Trace how Router handle reaches dispatch' });
    const sourced = [...res.content[0]!.text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
    expect(sourced[0]).toBe('src/net/router.cpp');
  });

  it('nor a Ruby class nested in a module of that name', async () => {
    // `Trace::Span::dispatch`: its class is Span, which the query does not name.
    const rb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-rb-')));
    writeTree(rb, {
      'app/router.rb': 'class Router\n  def handle(path)\n    return 0 if path.empty?\n    dispatch(path)\n  end\n\n  def dispatch(path)\n    path.sum\n  end\nend\n',
      'lib/span.rb': 'class Trace::Span\n  def dispatch(event)\n    @events << event\n    total = 0\n    @events.each { |x| total += x }\n    @events.clear if total > 100\n    total *= 2\n    total += 1\n    total\n  end\n\n  def flush\n    dispatch(1)\n  end\n\n  def record(id)\n    dispatch(id)\n  end\n\n  def sample(id)\n    dispatch(id * 2)\n  end\nend\n',
      'app/main.rb': 'Router.new.handle("/x")\n',
    });
    const rcg = await CodeGraph.init(rb, { index: true });
    try {
      const res = await new ToolHandler(rcg).execute('codegraph_explore', { query: 'Trace how Router handle reaches dispatch' });
      const sourced = [...res.content[0]!.text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
      expect(sourced[0]).toBe('app/router.rb');
    } finally {
      rcg.close();
      fs.rmSync(rb, { recursive: true, force: true });
    }
  });

  it('nor a Go struct whose methods another file of its package declares', async () => {
    // Go's cross-file `contains` (Trace → dispatch in dispatch.go) is no class
    // folder: a question's first word must not seed the struct's method.
    const go = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-explore-go-')));
    writeTree(go, {
      'go.mod': 'module example.com/app\n\ngo 1.21\n',
      'net/router.go': 'package net\n\ntype Router struct{}\n\nfunc (r *Router) handle(path string) int {\n\tif path == "" {\n\t\treturn 0\n\t}\n\treturn r.dispatch(path)\n}\n\nfunc (r *Router) dispatch(path string) int {\n\tn := 0\n\tfor _, c := range path {\n\t\tn += int(c)\n\t}\n\treturn n\n}\n',
      'trace/trace.go': 'package trace\n\ntype Trace struct {\n\tevents []int\n}\n',
      'trace/dispatch.go': 'package trace\n\nfunc (t *Trace) dispatch(e int) int {\n\tt.events = append(t.events, e)\n\ttotal := 0\n\tfor _, x := range t.events {\n\t\ttotal += x\n\t}\n\tif total > 100 {\n\t\tt.events = nil\n\t}\n\ttotal *= 2\n\ttotal++\n\treturn total\n}\n\nfunc (t *Trace) flush() int { return t.dispatch(1) }\nfunc (t *Trace) record(id int) int { return t.dispatch(id) }\nfunc (t *Trace) sample(id int) int { return t.dispatch(id * 2) }\n',
      'main.go': 'package main\n\nimport "example.com/app/net"\n\nfunc main() {\n\tvar r net.Router\n\t_ = r\n}\n',
    });
    const gcg = await CodeGraph.init(go, { index: true });
    try {
      const res = await new ToolHandler(gcg).execute('codegraph_explore', { query: 'Trace how Router handle reaches dispatch' });
      const sourced = [...res.content[0]!.text.matchAll(/^\*\*`(.+?)`\*\* —/gm)].map((m) => m[1]);
      expect(sourced[0]).toBe('net/router.go');
    } finally {
      gcg.close();
      fs.rmSync(go, { recursive: true, force: true });
    }
  });
});

/** `file kind:name` of every row left in `root`'s unresolved_refs, sorted. */
function unresolvedRows(root: string): string[] {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const rows = db.getDb().prepare('SELECT file_path AS file, reference_kind AS kind, reference_name AS name FROM unresolved_refs').all() as Array<{ file: string; kind: string; name: string }>;
    return rows.map((r) => `${r.file} ${r.kind}:${r.name}`).sort();
  } finally {
    db.close();
  }
}

/** Every non-`contains` edge of a throwaway project holding `files` (see allEdges), and its unresolved rows. */
async function indexOfProject(files: Record<string, string>): Promise<{ edges: string[]; unresolved: string[] }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-order-')));
  writeTree(root, files);
  const cg = await CodeGraph.init(root, { index: true });
  try {
    const edges = allEdges(cg);
    cg.close();
    return { edges, unresolved: unresolvedRows(root) };
  } finally {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function edgesOfProject(files: Record<string, string>): Promise<string[]> {
  return (await indexOfProject(files)).edges;
}

describe('MATLAB function precedence', () => {
  it('reaches a package member by its full name only, even from inside the package', async () => {
    expect(await edgesOfProject({
      'util.m': 'function util()\nend\n',
      '+pkg/util.m': 'function util()\nend\n',
      '+pkg/onlyInPkg.m': 'function onlyInPkg()\nend\n',
      '+pkg/caller.m': 'function caller()\nutil();\nonlyInPkg();\npkg.onlyInPkg();\nend\n',
      // A package's `load` does not capture the built-in inside the package.
      '+io/load.m': 'function s = load(f)\ns = 1;\nend\n',
      '+io/reader.m': 'function d = reader(f)\nd = load(f);\nend\n',
      // Nor does a sibling class: a superclass and a class name are written in full.
      '+geom/Circle.m': 'classdef Circle\n    methods (Static)\n        function c = unit()\n            c = 1;\n        end\n    end\nend\n',
      '+geom/Sq.m': 'classdef Sq < Circle\n    methods\n        function r = go(obj)\n            r = Circle.unit();\n        end\n    end\nend\n',
    })).toEqual([
      '+pkg/caller.m pkg::caller -calls-> pkg::onlyInPkg @ +pkg/onlyInPkg.m',
      '+pkg/caller.m pkg::caller -calls-> util @ util.m',
    ]);
  });

  it('takes an explicit import before a local function, a wildcard import before the current folder, and an import only where it is made', async () => {
    expect(await edgesOfProject({
      '+imp/helper.m': 'function helper()\nend\n',
      '+imp/onlyImp.m': 'function onlyImp()\nend\n',
      '+imp/shared.m': 'function shared()\nend\n',
      'useimp.m': 'function useimp()\nimport imp.helper\nhelper();\nend\nfunction helper()\nend\n',
      'w/helper.m': 'function helper()\nend\n',
      'w/wild.m': 'function wild()\nimport imp.*\nhelper();\nend\n',
      // `three` is a local function of two.m: two's import is not its own.
      'two.m': 'function two()\nimport imp.*\nonlyImp();\nend\nfunction three()\nonlyImp();\nend\n',
      // A nested function inherits its parent's imports; a local function before a wildcard import.
      'nestimp.m': 'function nestimp()\nimport imp.*\n    function inner()\n        onlyImp();\n        shared();\n    end\nend\nfunction shared()\nend\n',
    })).toEqual([
      'nestimp.m nestimp::inner -calls-> imp::onlyImp @ +imp/onlyImp.m',
      'nestimp.m nestimp::inner -calls-> shared @ nestimp.m',
      'two.m two -calls-> imp::onlyImp @ +imp/onlyImp.m',
      'useimp.m useimp -calls-> imp::helper @ +imp/helper.m',
      'useimp.m useimp -imports-> imp::helper @ +imp/helper.m',
      'w/wild.m wild -calls-> imp::helper @ +imp/helper.m',
    ]);
  });

  it('sees a nested function from its parent, its siblings and what it nests only', async () => {
    expect(await edgesOfProject({
      'cb.m': 'function cb()\nend\n',
      'inner.m': 'function inner()\nend\n',
      'gui.m': 'function gui()\ncb();\n    function cb()\n        inner();\n        function inner()\n        end\n    end\n    function sib()\n        cb();\n    end\nend\nfunction other()\ncb();\ninner();\nend\n',
    })).toEqual([
      'gui.m gui -calls-> gui::cb @ gui.m',
      'gui.m gui::cb -calls-> gui::cb::inner @ gui.m',
      'gui.m gui::sib -calls-> gui::cb @ gui.m',
      'gui.m other -calls-> cb @ cb.m',
      'gui.m other -calls-> inner @ inner.m',
    ]);
  });

  it('calls a function file by its file name, not the name its first line declares', async () => {
    expect(await edgesOfProject({
      'foo.m': 'function bar()\nend\n',
      // A file name that is no identifier: MATLAB cannot call it by any name; its own file still can.
      'my-tool.m': 'function mytool(n)\nif n > 0, mytool(n - 1); end\nend\n',
      '2go.m': 'function go2()\nend\n',
      'caller.m': 'function caller()\nbar();\nfoo();\nmytool(1);\ngo2();\nend\n',
    })).toEqual([
      'caller.m caller -calls-> foo @ foo.m',
      'my-tool.m mytool -calls-> mytool @ my-tool.m',
    ]);
  });

  it('calls a class-folder method file by its file name too', async () => {
    // `@K/declx.m` declaring `other` is K's method declx.
    expect(await edgesOfProject({
      '@K/K.m': 'classdef K\nend\n',
      '@K/declx.m': 'function other(q)\nend\n',
      'cf.m': 'function cf()\nq = K();\ndeclx(q);\nother(q);\nend\n',
    })).toEqual([
      'cf.m cf -calls-> K::declx @ @K/declx.m',
      'cf.m cf -instantiates-> K @ @K/K.m',
    ]);
  });

  it('links a class-folder method to its method file, not the classdef\'s declaration of it', async () => {
    // `p.origin()` on a parameter: origin is Static (on the declaration), so no object calls it.
    expect(await edgesOfProject({
      '+geo/@Pt/Pt.m': 'classdef Pt\n    properties\n        x\n    end\n    methods\n        function obj = Pt(x)\n            obj.x = x;\n        end\n        d = norm2(obj)\n    end\n    methods (Static)\n        p = origin()\n    end\nend\n',
      '+geo/@Pt/norm2.m': 'function d = norm2(obj)\nd = obj.x;\nend\n',
      '+geo/@Pt/origin.m': 'function p = origin()\np = geo.Pt(0);\nend\n',
      'user.m': 'function user(p)\nq = geo.Pt(1);\nq.norm2();\ngeo.Pt.origin();\np.norm2();\np.origin();\nend\n',
    })).toEqual([
      '+geo/@Pt/origin.m geo::Pt::origin -instantiates-> geo::Pt @ +geo/@Pt/Pt.m',
      'user.m user -calls-> geo::Pt::norm2 @ +geo/@Pt/norm2.m',
      'user.m user -calls-> geo::Pt::norm2 @ +geo/@Pt/norm2.m',
      'user.m user -calls-> geo::Pt::origin @ +geo/@Pt/origin.m',
      'user.m user -instantiates-> geo::Pt @ +geo/@Pt/Pt.m',
    ]);
  });

  it('passes a method\'s own object to a local or path function when its class has no such method', async () => {
    expect(await edgesOfProject({
      'K.m': 'classdef K < handle\n    properties\n        data\n    end\n    methods\n        function run(obj)\n            helperLocal(obj);\n            pathFn(obj, 2);\n            disp(obj);\n            y = obj.data(3);\n            other(obj.data);\n            step(obj);\n        end\n        function step(obj)\n        end\n    end\nend\nfunction helperLocal(k)\nend\n',
      'other.m': 'function other(d)\nend\n',
      'pathFn.m': 'function pathFn(k, n)\nend\n',
      'step.m': 'function step(x)\nend\n',
      // An old-style class constructor: `class(r, 'Old')` is the built-in.
      '@Old/Old.m': 'function r = Old()\nr = struct();\nr = class(r, \'Old\');\nend\n',
    })).toEqual([
      'K.m K::run -calls-> K::step @ K.m',
      'K.m K::run -calls-> helperLocal @ K.m',
      'K.m K::run -calls-> other @ other.m',
      'K.m K::run -calls-> pathFn @ pathFn.m',
    ]);
  });

  it('takes the first of equally near functions in genpath order: folders by ASCII segment, a folder before its subfolders', async () => {
    expect(await edgesOfProject({
      // `a b` sorts after `a` as a folder name, though `a b/…` sorts first as a path.
      'a b/helper.m': 'function helper()\nend\n',
      'a/x/helper.m': 'function helper()\nend\n',
      // `lib` before its own `lib/a`, though `lib/a/…` sorts first as a path.
      'lib/a/tool.m': 'function tool()\nend\n',
      'lib/tool.m': 'function tool()\nend\n',
      // Upper case before lower case.
      'apps/util.m': 'function util()\nend\n',
      'Utility functions/util.m': 'function util()\nend\n',
      'c/main.m': 'function main()\nhelper();\ntool();\nutil();\nend\n',
      'a b/near.m': 'function near()\nhelper();\nend\n',
    })).toEqual([
      'a b/near.m near -calls-> helper @ a b/helper.m',
      'c/main.m main -calls-> helper @ a/x/helper.m',
      'c/main.m main -calls-> tool @ lib/tool.m',
      'c/main.m main -calls-> util @ Utility functions/util.m',
    ]);
  });

  it('takes the nearer of two functions over the first in genpath order', async () => {
    expect(await edgesOfProject({
      'a/helper.m': 'function helper()\nend\n',
      'z/helper.m': 'function helper()\nend\n',
      'z/sub/main.m': 'function main()\nhelper();\nend\n',
    })).toEqual(['z/sub/main.m main -calls-> helper @ z/helper.m']);
  });

  it('moves a call to an equally near function a sync adds earlier in genpath order, as a fresh index would', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-genpath-sync-')));
    writeTree(root, {
      'b/helper.m': 'function helper()\nend\n',
      'c/main.m': 'function main()\nhelper();\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toEqual(['c/main.m main -calls-> helper @ b/helper.m']);
      writeTree(root, { 'a/helper.m': 'function helper()\nend\n' });
      await cg.sync({ paths: ['a/helper.m'] });
      expect(allEdges(cg)).toEqual(['c/main.m main -calls-> helper @ a/helper.m']);
      fs.rmSync(path.join(root, 'a/helper.m'));
      await cg.sync({ paths: ['a/helper.m'] });
      const synced = allEdges(cg);
      expect(synced).toEqual(['c/main.m main -calls-> helper @ b/helper.m']);
      await cg.indexAll();
      expect(allEdges(cg)).toEqual(synced);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes a class-folder class before a function of the current folder', async () => {
    expect(await edgesOfProject({
      '@Thing/Thing.m': 'classdef Thing\nend\n',
      'lib/Thing.m': 'function t = Thing()\nt = 1;\nend\n',
      'lib/use.m': 'function use()\nThing();\nend\n',
    })).toEqual(['lib/use.m use -instantiates-> Thing @ @Thing/Thing.m']);
  });

  it('dispatches a call on a variable of a known class to the class\'s method, ahead of a path function', async () => {
    expect(await edgesOfProject({
      'area.m': 'function a = area(x)\na = 1;\nend\n',
      'Shape.m': 'classdef Shape\n    methods\n        function a = area(obj)\n            a = 0;\n        end\n        function disp(obj)\n        end\n    end\nend\n',
      'Tri.m': 'classdef Tri\nend\n',
      // A local function still comes before the class's method.
      // `Shape(c)` is the class's constructor, as any `Shape(…)` is: no method of it.
      'useShape.m': 'function useShape()\nc = Shape();\na = area(c);\nb = c.area();\ndisp(c);\nnumel(c);\nt = Tri();\narea(t);\ndisp(t);\nd = Shape(c);\nend\n',
      'useLocal.m': 'function useLocal()\nc = Shape();\narea(c);\nend\nfunction a = area(x)\na = 2;\nend\n',
    })).toEqual([
      'useLocal.m useLocal -calls-> area @ useLocal.m',
      'useLocal.m useLocal -instantiates-> Shape @ Shape.m',
      'useShape.m useShape -calls-> Shape::area @ Shape.m',
      'useShape.m useShape -calls-> Shape::area @ Shape.m',
      'useShape.m useShape -calls-> Shape::disp @ Shape.m',
      'useShape.m useShape -calls-> area @ area.m',
      'useShape.m useShape -instantiates-> Shape @ Shape.m',
      'useShape.m useShape -instantiates-> Shape @ Shape.m',
      'useShape.m useShape -instantiates-> Tri @ Tri.m',
    ]);
  });

  it('dispatches set/get on an object of a class-folder class to its method files, and keeps no row for another call of a built-in', async () => {
    const { edges, unresolved } = await indexOfProject({
      '@AccObj/AccObj.m': 'function obj = AccObj(v)\nobj.v = v;\nobj = class(obj, \'AccObj\');\nend\n',
      '@AccObj/set.m': 'function obj = set(obj, name, v)\nend\n',
      '@AccObj/get.m': 'function v = get(obj, name)\nv = 1;\nend\n',
      // On its own object, inside a method file.
      '@AccObj/bump.m': 'function obj = bump(obj)\nobj = set(obj, \'v\', 2);\nend\n',
      // `set(h, …)` on a parameter, `plot`, `uicontrol`, `strtrim`, `fclose`: the built-ins, which leave no row.
      'useAcc.m': 'function useAcc(h, fid)\na = AccObj(1);\na = set(a, \'v\', 2);\nv = get(a, \'v\');\nset(h, \'Visible\', \'off\');\nplot(1:3);\nuicontrol(\'Style\', \'text\');\ns = strtrim(\' x \');\nfclose(fid);\nmissing(h);\nend\n',
    });
    expect(edges.filter((e) => e.includes(' -calls-> '))).toEqual([
      '@AccObj/bump.m AccObj::bump -calls-> AccObj::set @ @AccObj/set.m',
      'useAcc.m useAcc -calls-> AccObj::get @ @AccObj/get.m',
      'useAcc.m useAcc -calls-> AccObj::set @ @AccObj/set.m',
    ]);
    // `AccObj(1)` instantiates the old-style class. What resolves to nothing and is no call of a
    // built-in's name is kept, for a later sync to retry. `class(obj, …)` on the method's own object
    // is `AccObj::class`, which AccObj does not define and no symbol is named: the built-in's, no row either.
    expect(edges.filter((e) => e.includes(' -instantiates-> '))).toEqual(['useAcc.m useAcc -instantiates-> AccObj @ @AccObj/AccObj.m']);
    expect(unresolved).toEqual(['useAcc.m calls:missing']);
  });

  it('reaches a project function named like a built-in — on the path, in private/, local to the file — and keeps no row for one it does not define', async () => {
    const { edges, unresolved } = await indexOfProject({
      // Stand-ins for toolbox functions and a compat shim, on the path.
      'normpdf.m': 'function p = normpdf(x)\np = x;\nend\n',
      'strsplit.m': 'function c = strsplit(s)\nc = {s};\nend\n',
      'prctile.m': 'function y = prctile(x, p)\ny = x;\nend\n',
      'useStats.m': 'function useStats(x)\np = normpdf(x);\nc = strsplit(\'a b\');\ny = prctile(x, 50);\nplot(x);\nend\n',
      // A private function shadows the path one, from beside it only.
      'lib/private/normpdf.m': 'function p = normpdf(x)\np = 0;\nend\n',
      'lib/useP.m': 'function useP(x)\np = normpdf(x);\nend\n',
      // The file's own `grid`, and `pause.m` shipped as a project's own (a deployed toolbox's copy).
      'useGrid.m': 'function useGrid()\ng = grid(3);\nhold on\nend\nfunction g = grid(n)\ng = n;\nend\n',
      'pause.m': 'function pause(t)\nend\n',
      'usePause.m': 'function usePause()\npause(1);\nend\n',
    });
    expect(edges).toEqual([
      'lib/useP.m useP -calls-> normpdf @ lib/private/normpdf.m',
      'useGrid.m useGrid -calls-> grid @ useGrid.m',
      'usePause.m usePause -calls-> pause @ pause.m',
      'useStats.m useStats -calls-> normpdf @ normpdf.m',
      'useStats.m useStats -calls-> prctile @ prctile.m',
      'useStats.m useStats -calls-> strsplit @ strsplit.m',
    ]);
    expect(unresolved).toEqual([]);
  });

  it('takes a classdef file\'s local function before the method of the same name, and a script\'s local function before the built-in', async () => {
    expect(await edgesOfProject({
      // MATLAB order: a local function comes before the method of the first argument's class.
      'Viz.m': 'classdef Viz\n    methods\n        function plot(obj)\n        end\n        function draw(obj, x)\n            plot(x);\n            plot(obj);\n        end\n    end\nend\nfunction plot(x)\nend\n',
      'Bare.m': 'classdef Bare\n    methods\n        function plot(obj)\n        end\n        function draw(obj, x)\n            plot(x);\n            plot(obj);\n        end\n    end\nend\n',
      'runIt.m': 'x = 1:3;\nplot(x);\nfunction plot(x)\nend\n',
    })).toEqual([
      // Bare's plot(obj) is its method; its plot(x) is the built-in.
      'Bare.m Bare::draw -calls-> Bare::plot @ Bare.m',
      'Viz.m Viz::draw -calls-> plot @ Viz.m',
      'Viz.m Viz::draw -calls-> plot @ Viz.m',
      'runIt.m runIt.m -calls-> plot @ runIt.m',
    ]);
  });

  it('never resolves a bare call in a package file to the package function itself, only to the file\'s local functions', async () => {
    const { edges, unresolved } = await indexOfProject({
      '+util/size.m': 'function n = size(x)\nn = size(x, 1) + helper(x);\nend\nfunction h = helper(x)\nh = 0;\nend\n',
      '+util/plot.m': 'function plot(x)\nplot(x);\nend\n',
      'useUtil.m': 'function useUtil(x)\nn = util.size(x);\nutil.plot(x);\nend\n',
    });
    expect(edges).toEqual([
      '+util/size.m util::size -calls-> util::helper @ +util/size.m',
      'useUtil.m useUtil -calls-> util::plot @ +util/plot.m',
      'useUtil.m useUtil -calls-> util::size @ +util/size.m',
    ]);
    // The built-ins those are: no row.
    expect(unresolved).toEqual([]);
  });

  it('on a sync, links a call of a built-in\'s name to a function added beside it only in the files it re-indexes (a full index links them all)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-sync-')));
    const caller = (name: string) => `function ${name}(x)\np = normpdf(x);\nend\n`;
    writeTree(root, { 'untouched.m': caller('untouched'), 'edited.m': caller('edited') });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toEqual([]);
      expect(unresolvedRows(root)).toEqual([]);
      // The project gains its own normpdf, and one caller is edited in the same sync.
      writeTree(root, { 'normpdf.m': 'function p = normpdf(x)\np = x;\nend\n', 'edited.m': caller('edited') + '% edited\n', 'added.m': caller('added') });
      await cg.sync();
      // untouched.m's call was discarded as the built-in's when it was indexed, and no row is left to retry.
      expect(allEdges(cg)).toEqual([
        'added.m added -calls-> normpdf @ normpdf.m',
        'edited.m edited -calls-> normpdf @ normpdf.m',
      ]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds a script\'s import in the script\'s code, not in its local functions', async () => {
    expect(await edgesOfProject({
      '+imp/onlyImp.m': 'function onlyImp()\nend\n',
      's.m': 'import imp.*\nonlyImp();\nfunction loc()\nonlyImp();\nend\n',
    })).toEqual(['s.m s.m -calls-> imp::onlyImp @ +imp/onlyImp.m']);
  });

  it('sees a nested function of a class-folder method from the method only', async () => {
    expect(await edgesOfProject({
      '@K/K.m': 'classdef K\nend\n',
      '@K/m.m': 'function m(obj)\ninner();\n    function inner()\n    end\nend\nfunction loc()\ninner();\nend\n',
      'inner.m': 'function inner()\nend\n',
    })).toEqual([
      '@K/m.m K::m -calls-> K::m::inner @ @K/m.m',
      '@K/m.m loc -calls-> inner @ inner.m',
    ]);
  });

  it('reaches a class folder\'s private/ from its methods, and not the private/ beside the class folder', async () => {
    expect(await edgesOfProject({
      '@K/K.m': 'classdef K\nend\n',
      '@K/m2.m': 'function m2(obj)\nph();\ntop();\nend\n',
      '@K/private/ph.m': 'function ph()\nend\n',
      'private/top.m': 'function top()\nend\n',
      'r.m': 'function r()\ntop();\nph();\nend\n',
    })).toEqual([
      '@K/m2.m K::m2 -calls-> ph @ @K/private/ph.m',
      'r.m r -calls-> top @ private/top.m',
    ]);
  });

  it('dispatches to a method only a superclass defines, in its classdef or its class folder\'s method file', async () => {
    expect(await edgesOfProject({
      'area.m': 'function a = area(x)\na = 1;\nend\n',
      'vol.m': 'function v = vol(x)\nv = 1;\nend\n',
      'Base.m': 'classdef Base\n    methods\n        function a = area(obj)\n            a = 0;\n        end\n    end\nend\n',
      'Sub.m': 'classdef Sub < Base\nend\n',
      '@B2/B2.m': 'classdef B2\n    methods\n        v = vol(obj)\n    end\nend\n',
      '@B2/vol.m': 'function v = vol(obj)\nv = 0;\nend\n',
      'S2.m': 'classdef S2 < B2\nend\n',
      'u.m': 'function u()\ns = Sub();\narea(s);\nt = S2();\nvol(t);\nend\n',
    })).toEqual([
      'S2.m S2 -extends-> B2 @ @B2/B2.m',
      'Sub.m Sub -extends-> Base @ Base.m',
      'u.m u -calls-> B2::vol @ @B2/vol.m',
      'u.m u -calls-> Base::area @ Base.m',
      'u.m u -instantiates-> S2 @ S2.m',
      'u.m u -instantiates-> Sub @ Sub.m',
    ]);
  });

  it('dispatches on a package class reached through `import g.*` or written in full', async () => {
    expect(await edgesOfProject({
      'area.m': 'function a = area(x)\na = 1;\nend\n',
      '+g/Cir.m': 'classdef Cir\n    methods\n        function a = area(obj)\n            a = 0;\n        end\n    end\nend\n',
      'ui.m': 'function ui()\nimport g.*\nc = Cir();\narea(c);\nend\n',
      'uq.m': 'function uq()\nc = g.Cir();\narea(c);\nend\n',
    })).toEqual([
      'ui.m ui -calls-> g::Cir::area @ +g/Cir.m',
      'ui.m ui -instantiates-> g::Cir @ +g/Cir.m',
      'uq.m uq -calls-> g::Cir::area @ +g/Cir.m',
      'uq.m uq -instantiates-> g::Cir @ +g/Cir.m',
    ]);
  });

  it('takes a private/ function before the method a call on an object dispatches to', async () => {
    expect(await edgesOfProject({
      'Shape.m': 'classdef Shape\n    methods\n        function a = area(obj)\n            a = 0;\n        end\n    end\nend\n',
      'private/area.m': 'function a = area(x)\na = 1;\nend\n',
      'w.m': 'function w()\nc = Shape();\narea(c);\nend\n',
    })).toEqual([
      'w.m w -calls-> area @ private/area.m',
      'w.m w -instantiates-> Shape @ Shape.m',
    ]);
  });

  it('rebinds a function-syntax call on the object when a sync removes its target, as a fresh index would', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-order-sync-')));
    writeTree(root, {
      'K.m': 'classdef K < handle\n    methods\n        function run(obj)\n            pathFn(obj, 2);\n            later(obj);\n        end\n    end\nend\n',
      'pathFn.m': 'function pathFn(k, n)\nend\n',
      'lib/pathFn.m': 'function pathFn(k, n)\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg)).toEqual(['K.m K::run -calls-> pathFn @ pathFn.m']);
      fs.rmSync(path.join(root, 'pathFn.m'));
      writeTree(root, { 'later.m': 'function later(k)\nend\n' });
      await cg.sync({ paths: ['pathFn.m', 'later.m'] });
      const synced = allEdges(cg);
      expect(synced).toEqual([
        'K.m K::run -calls-> later @ later.m',
        'K.m K::run -calls-> pathFn @ lib/pathFn.m',
      ]);
      await cg.indexAll();
      expect(allEdges(cg)).toEqual(synced);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MATLAB unresolved rows', () => {
  it('keeps a failed call only when written with arguments or named like a project symbol, and drops indexing and the toolboxes\' calls', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-')));
    writeTree(root, {
      // getData is two classes' method: `aa.getData()` cannot pick one, and fails.
      'Acc.m': 'classdef Acc\n    properties\n        gain\n    end\n    methods\n        function d = getData(obj)\n            d = 1;\n        end\n    end\nend\n',
      'Bcc.m': 'classdef Bcc\n    methods\n        function d = getData(obj)\n            d = 2;\n        end\n    end\nend\n',
      'setup_paths.m': 'p = 1;\n', // a script: its file is the only node of the name
      'tools.py': 'def pyhelper():\n    pass\n', // another language's symbol counts too
      // A function named like a variable the caller indexes.
      'x.m': 'function y = x(a)\ny = a;\nend\n',
      'user.m': [
        'function user(aa, temp)',
        'd = aa.getData();', // a member a project method carries: kept
        'v = temp.value(1);', // a member nothing carries: none
        'w = cfgval;', // a bare read nothing defines: none
        'g = gain;', // one a property carries: kept
        'h = pyhelper;',
        'q = tango_read_attribute(aa);', // an outside call: kept
        'pkg.missing(1);', // a package path nothing defines: none
        'setup_paths', // the script: linked to its file
        'other_cmd on', // a command nothing defines: none
        's = tf2sos(aa);', // the Signal Processing Toolbox's: none
        'y = x(:, 2);', // indexing: no call, no edge
        'z = x(end);',
        'c = Acc();',
        'n = size(c, 2);', // Acc has no size: the built-in's, none
        'rescale_obj(c);', // nor a rescale_obj: an outside call, kept
        'end',
        'function other()',
        'z = x(1);', // the function: linked
        'end',
        '',
      ].join('\n'),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg).filter((e) => e.startsWith('user.m '))).toEqual([
        'user.m other -calls-> x @ x.m',
        'user.m user -calls-> setup_paths.m @ setup_paths.m',
        'user.m user -instantiates-> Acc @ Acc.m',
      ]);
      expect(unresolvedRows(root)).toEqual([
        'user.m calls:Acc::rescale_obj',
        'user.m calls:aa.getData',
        'user.m calls:gain',
        'user.m calls:pyhelper',
        'user.m calls:tango_read_attribute',
      ]);
      // What the dead-code check sees: every name a symbol carries still has its rows.
      expect([...cg.getUnresolvedNamesAmong(['getData', 'gain', 'value', 'cfgval', 'missing'])].sort()).toEqual(['gain', 'getData']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a handle to a built-in that resolves to nothing, as its call, and links one the project answers', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-handles-')));
    writeTree(root, {
      // The import keeps every built-in's name at insert: what fails is dropped when it fails.
      'user.m': 'function user(xs)\nimport util.*\na = cellfun(@isempty, xs);\nb = cellfun(@numel, xs);\nc = arrayfun(@size, xs);\nd = cellfun(@mystery, xs);\ne = cellfun(@normpdf, xs);\nend\n',
      '+util/numel.m': 'function n = numel(x)\nn = 1;\nend\n',
      'stats/normpdf.m': 'function p = normpdf(x)\np = x;\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(allEdges(cg).filter((e) => e.startsWith('user.m '))).toEqual([
        'user.m user -references-> normpdf @ stats/normpdf.m',
        'user.m user -references-> util::numel @ +util/numel.m',
      ]);
      expect(unresolvedRows(root)).toEqual(['user.m function_ref:mystery']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('on a sync, links a call written with arguments to a function added later everywhere, and a bare read of it only in the files it re-indexes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-sync-')));
    const caller = (name: string) => `function ${name}()\nt = later;\nlater(1);\nend\n`;
    writeTree(root, { 'untouched.m': caller('untouched'), 'edited.m': caller('edited') });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(unresolvedRows(root)).toEqual(['edited.m calls:later', 'untouched.m calls:later']);
      writeTree(root, { 'later.m': 'function later(n)\nend\n', 'edited.m': caller('edited') + '% edited\n' });
      await cg.sync();
      // untouched.m's bare read was dropped when nothing defined `later`, and no row is left to retry.
      expect(allEdges(cg)).toEqual([
        'edited.m edited -calls-> later @ later.m',
        'edited.m edited -calls-> later @ later.m',
        'untouched.m untouched -calls-> later @ later.m',
      ]);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('on a sync that adds a method to a class, links a member call written with arguments only in the files it re-indexes (accepted)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-member-')));
    const caller = (name: string) => `function ${name}(a)\nr = a.recalib(2);\nend\n`;
    writeTree(root, { 'untouched.m': caller('untouched'), 'edited.m': caller('edited') });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // No symbol is named recalib: a member nothing carries, no row.
      expect(unresolvedRows(root)).toEqual([]);
      writeTree(root, {
        'Cal.m': 'classdef Cal\n    methods\n        function r = recalib(obj, n)\n            r = n;\n        end\n    end\nend\n',
        'edited.m': caller('edited') + '% edited\n',
      });
      await cg.sync();
      // The limitation: untouched.m's row went before Cal.m came, and nothing is left to retry.
      expect(allEdges(cg)).toEqual(['edited.m edited -calls-> Cal::recalib @ Cal.m']);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps `size(obj, …)` on a class with no size when another class defines one, so that method is not called dead', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-size-')));
    writeTree(root, {
      'Acc.m': 'classdef Acc\n    methods\n        function n = size(obj)\n            n = 1;\n        end\n    end\nend\n',
      'Cls.m': 'classdef Cls\n    methods\n        function n = count(obj)\n            n = size(obj, 2);\n        end\n    end\nend\n',
      // What makes Acc.m reachable, so that its methods are candidates at all.
      'main.m': 'function main()\na = Acc();\nc = Cls();\ncount(c);\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // Cls::size is no method of Cls's, and Acc's size is another class's: no edge to it.
      expect(allEdges(cg)).toEqual([
        'main.m main -calls-> Cls::count @ Cls.m',
        'main.m main -instantiates-> Acc @ Acc.m',
        'main.m main -instantiates-> Cls @ Cls.m',
      ]);
      expect(unresolvedRows(root)).toEqual(['Cls.m calls:Cls::size']);
      expect([...cg.getUnresolvedNamesAmong(['size'])]).toEqual(['size']);
      // The kept row is what holds Acc's size back from being called dead.
      const report = buildDeadCodeReport(cg, { kinds: ['method'], includeExported: true });
      expect(report.entries.map((e) => e.node.qualifiedName)).not.toContain('Acc::size');
      expect(report.excluded.unresolvedName).toBe(1);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a call\'s column on its line past multi-byte characters, tabs and CRLF line ends', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-col-')));
    writeTree(root, {
      'u.m': [
        'function u()',
        "\tmsg = 'héllo wörld ✓ 日本'; r = undefined_fn(1);",
        "\tlbl = 'ünïcode ✓ 𝛼'; t = undefined_fn;",
        'end',
        '',
      ].join('\r\n'),
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const db = DatabaseConnection.open(getDatabasePath(root));
      try {
        const rows = db.getDb().prepare('SELECT reference_name AS name, line FROM unresolved_refs').all() as Array<{ name: string; line: number }>;
        // `undefined_fn(1)` is kept, the bare read of it dropped.
        expect(rows.map((r) => `${r.name}:${r.line}`)).toEqual(['undefined_fn:2']);
      } finally {
        db.close();
      }
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes a hand-built ref (no row id) by its key only when no failure of that key is kept', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-matlab-rows-key-')));
    const db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    try {
      const q = new QueryBuilder(db.getDb());
      fs.writeFileSync(path.join(root, 'k.m'), 'function k()\nt = nowhere;\nnowhere(1);\nend\nfunction j()\nt = gone;\nend\n');
      const fn = (id: string, name: string, line: number) => ({
        id, kind: 'function' as const, name, qualifiedName: name, filePath: 'k.m', language: 'matlab' as const,
        startLine: line, endLine: line + 2, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      });
      q.insertNode(fn('fn:k', 'k', 1));
      q.insertNode(fn('fn:j', 'j', 5));
      const ref = (from: string, name: string, line: number, column: number, candidates?: string[]) => ({
        fromNodeId: from, referenceName: name, referenceKind: 'calls' as const, line, column, filePath: 'k.m', language: 'matlab' as const,
        ...(candidates ? { candidates } : {}),
      });
      // `t = nowhere;` is a bare read nothing defines (discarded); `nowhere(1)`, of the same key, is kept.
      const refs = [ref('fn:k', 'nowhere', 2, 4, ['bare']), ref('fn:k', 'nowhere', 3, 0), ref('fn:j', 'gone', 6, 4, ['bare'])];
      q.insertUnresolvedRefsBatch(refs);
      createResolver(root, q).resolveAndPersist(refs.map((r) => ({ ...r })));
      const rows = db.getDb().prepare('SELECT reference_name AS name, line, status FROM unresolved_refs ORDER BY line').all() as Array<{ name: string; line: number; status: string }>;
      // The key delete would have taken `nowhere(1)`'s row too: both stay, parked as failed. `gone` goes.
      expect(rows.map((r) => `${r.name}:${r.line}:${r.status}`)).toEqual(['nowhere:2:failed', 'nowhere:3:failed']);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('in a function, links no call to `a.m` where `a` is indexed as only an array can be, and in a script at that site only', async () => {
    const { edges } = await indexOfProject({
      'a.m': 'function y = a(i, j)\ny = i + j;\nend\n',
      'byEnd.m': 'function byEnd(t)\nplot(t, a(1,:) - a(1,1));\nn = a(end, 1);\nend\n',
      'byBrace.m': 'function byBrace(t)\nplot(t, a(1,1));\nv = a{2};\nend\n',
      'byColon.m': 'function byColon(t)\nplot(t, a(1,:) - a(1,1));\nend\n',
      'script.m': 'plot(t, a(1,:) - a(1,1));\nv = a{2};\nn = a(end, 1);\n',
    });
    expect(edges).toEqual([
      // A bare `:` is this site's evidence only: MATLAB passes a function `':'` too.
      'byColon.m byColon -calls-> a @ a.m',
      'script.m script.m -calls-> a @ a.m',
    ]);
  });
});
