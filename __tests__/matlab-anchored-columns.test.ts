/**
 * A MATLAB reference no text written in the file places (a name a variable
 * gives `eval` or `feval`) is stored at an anchored place, a column no line
 * reaches (MATLAB_ANCHORED_BASE, src/extraction/languages/matlab-places.ts).
 * The library's edges keep that encoding, which the sync paths read; every
 * output shows the anchor's column instead, where the code that gives the
 * reference runs.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { CodeGraph } from '../src';
import { tempDir, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** MATLAB_ANCHORED_BASE, written out: the test reads the stored encoding as a user would never see it. */
const MATLAB_ANCHORED_BASE = 1_000_000_000;

describe('an anchored reference', () => {
  it('is shown at its anchor in the JSON context, and kept anchored in the library', async () => {
    const root = tempDir('cg-anchored-column-');
    writeTree(root, {
      'runall.m': "function runall()\ns = 'f(1)'; fn = 'g';\neval(s); feval(fn, 2);\nend\n",
      'f.m': 'function y = f(x)\ny = x;\nend\n',
      'g.m': 'function y = g(x)\ny = x;\nend\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const runall = cg.getNodesInFile('runall.m').find((n) => n.kind === 'function')!;
      const stored = new Map(cg.getOutgoingEdgesFrom([runall.id]).filter((e) => e.kind === 'calls')
        .map((e) => [cg.getNode(e.target)!.name, e.column!]));
      // `eval(s)` runs `f(1)` at the end of `s` (column 6), `feval(fn, 2)` calls `g` at the end of `fn` (column 17).
      expect(stored.get('f')).toBe(MATLAB_ANCHORED_BASE + 6 * 1_000_000);
      expect(stored.get('g')).toBe(MATLAB_ANCHORED_BASE + 17 * 1_000_000);

      const json = JSON.parse(await cg.buildContext('runall calls f and g', { format: 'json', includeCode: false }) as string) as {
        nodes: Array<{ id: string; name: string }>;
        edges: Array<{ source: string; target: string; kind: string; line?: number; column?: number }>;
      };
      const name = new Map(json.nodes.map((n) => [n.id, n.name]));
      const shown = new Map(json.edges.filter((e) => e.source === runall.id && e.kind === 'calls').map((e) => [name.get(e.target), e]));
      expect(shown.get('f')).toMatchObject({ line: 3, column: 6 });
      expect(shown.get('g')).toMatchObject({ line: 3, column: 17 });
      expect(json.edges.every((e) => e.column === undefined || e.column < MATLAB_ANCHORED_BASE)).toBe(true);
    } finally {
      cg.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
