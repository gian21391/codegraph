/**
 * codegraph_explore — NL-stopword collision guard (named-symbol seeding).
 *
 * handleExplore's named-symbol seeding treats every identifier-shaped query
 * token as "a symbol the agent named" and grants its definition the
 * named-FIRST sort tier. But explore also takes natural-language questions,
 * whose ordinary English words collide with real callables: on this repo the
 * query "…check the latest version…" exact-matched the lone `check()` method
 * of an unrelated WAL-valve class, which then outranked (and, within the
 * per-repo file budget, fully displaced) the upgrade module the corroboration
 * ranking had correctly scored — so the agent fell back to Read/Grep.
 *
 * The guard: a shape-precise token (camelCase, PascalCase, snake_case,
 * qualified) seeds unconditionally — it is an unambiguous symbol reference.
 * A BARE lowercase word seeds only definitions whose file another query token
 * co-names (that other token is itself a symbol defined in the same file, the
 * "check drain fire" sibling-bag shape) — which an incidental English-word
 * collision never is.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Paths explore rendered as full-body ``**`<path>`** —`` source sections, in order. */
function sourcedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\* —/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

describe('codegraph_explore — NL-stopword collision guard', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stopword-'));

    // --- The collision file: an unrelated class whose methods are ordinary
    // English words ("check", "drain", "fire" — the only defs of those names).
    // Substantive bodies + an internal call mesh so it isn't skipped as a stub.
    const dbDir = path.join(testDir, 'src', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'valve.ts'),
      `export class Valve {\n` +
      `  private open = false;\n` +
      `  check(): void {\n` +
      `    if (this.open) {\n` +
      `      this.fire();\n` +
      `    }\n` +
      `  }\n` +
      `  fire(): void {\n` +
      `    this.drain();\n` +
      `    this.open = false;\n` +
      `  }\n` +
      `  drain(): void {\n` +
      `    this.open = true;\n` +
      `  }\n` +
      `}\n`);

    // --- The answer file: the upgrade module the query is actually about.
    // Its path and symbol names match the query's topic terms (upgrade,
    // latest, version), so the corroboration ranking scores it — the bug was
    // the collision file's named tier sorting ABOVE it anyway.
    const upDir = path.join(testDir, 'src', 'upgrade');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, 'updater.ts'),
      `export function normalizeVersion(v: string): string {\n` +
      `  return v.startsWith('v') ? v : 'v' + v;\n` +
      `}\n` +
      `export function resolveLatestVersion(): string {\n` +
      `  return normalizeVersion('9.9.9');\n` +
      `}\n` +
      `export function runUpgrade(): string {\n` +
      `  const latest = resolveLatestVersion();\n` +
      `  return latest;\n` +
      `}\n`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).toBeFalsy();
    return res.content[0]!.text;
  }

  it('a bare English word ("check") does not tier its namesake above the corroborated answer file', async () => {
    const text = await explore('how does the upgrade flow check the latest version');
    const files = sourcedFiles(text);
    const updater = files.findIndex((f) => f.endsWith('updater.ts'));
    const valve = files.findIndex((f) => f.endsWith('valve.ts'));
    // The upgrade module must render, and must rank above the collision file
    // (pre-guard, valve.ts held the named-FIRST tier and sorted on top).
    expect(updater).toBeGreaterThanOrEqual(0);
    if (valve !== -1) expect(updater).toBeLessThan(valve);
  });

  it('a sibling bag of bare words ("check drain fire") still tiers their shared file first', async () => {
    const text = await explore('check drain fire');
    const files = sourcedFiles(text);
    // Every token is co-named by the others in valve.ts — genuine bare-name
    // symbol bags must keep the named tier.
    expect(files[0]).toMatch(/valve\.ts$/);
  });

  it('a shape-precise token (camelCase) seeds unconditionally', async () => {
    const text = await explore('runUpgrade');
    const files = sourcedFiles(text);
    expect(files[0]).toMatch(/updater\.ts$/);
  });
});

describe('codegraph_explore — interface members never corroborate a bare word', () => {
  let testDir: string;
  let cg: CodeGraph;

  afterEach(() => {
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('an options interface\'s `host` does not seed the same file\'s `main()` above the answer', async () => {
    // vscode's agentHostServerMain.ts: `interface IServerOptions { readonly host… }`
    // beside `function main()`. Once interface members were indexed (#1638),
    // `host` in "extension host … main process" counted as a second query
    // token named in that file, so the English word "main" seeded `main()` into
    // the named-first tier and the file outranked the ones about the extension
    // host itself.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-iface-corroboration-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'serverMain.ts'),
      'interface IServerOptions {\n' +
      '  readonly port: number;\n' +
      '  readonly host: string | undefined;\n' +
      '}\n\n' +
      'export function main(options: IServerOptions): number {\n' +
      '  return options.port;\n' +
      '}\n');
    fs.writeFileSync(path.join(src, 'extensionHostProcess.ts'),
      'export class ExtensionHostConnection {\n' +
      '  constructor(private readonly send: (msg: string) => void) {}\n' +
      '  connectToMainProcess(): void {\n' +
      "    this.send('hello');\n" +
      '  }\n' +
      '}\n\n' +
      'export function startExtensionHostProcess(): ExtensionHostConnection {\n' +
      '  const connection = new ExtensionHostConnection((msg) => console.log(msg));\n' +
      '  connection.connectToMainProcess();\n' +
      '  return connection;\n' +
      '}\n');
    for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(src, `noise${i}.ts`), `export const n${i} = ${i};\n`);
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    const res = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'how does the extension host talk to the main process',
    });
    const files = sourcedFiles(res.content[0].text as string);
    expect(files[0]).toBe('src/extensionHostProcess.ts');
  });
});

/**
 * "Trace how Router handle reaches dispatch": `Trace` is the question's first
 * word, capitalised as a sentence is, not a type the agent named. A MATLAB
 * class the query names corroborates the bare-word methods its class folder
 * keeps in files of their own; these pin that no other cross-file tie does —
 * a C++ namespace, a Ruby module around a class, or a Go struct whose methods
 * another file declares.
 */
describe('codegraph_explore — a question\'s capitalised first word seeds no namespace, nested class or struct of that name', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-question-word-cpp-')));
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
    const rb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-question-word-rb-')));
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
    // Go's cross-file `contains` (Trace → dispatch in dispatch.go) is no MATLAB
    // class folder: a question's first word must not seed the struct's method.
    const go = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-question-word-go-')));
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
