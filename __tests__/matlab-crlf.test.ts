/**
 * CRLF reads as LF: a MATLAB project indexed with CRLF line ends gives the same
 * nodes, edges and unresolved rows — lines, columns, statuses and candidates
 * included — as the same project with LF line ends (project rule: text form
 * changes nothing; MATLAB reads both alike). One project per shape the
 * grammar reads line ends in: continuation, block comments, command syntax,
 * strings holding `%`, transpose, `end` in indexing, a classdef with
 * properties and methods blocks.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';
import { tempDir, useAllGrammars, writeTree } from './matlab-helpers';

useAllGrammars();

/** Every stored fact of a project a reader sees, one sorted line each. */
interface Dump {
  nodes: string[];
  edges: string[];
  refs: string[];
}

function dumpOf(root: string): Dump {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    const q = (sql: string) => db.getDb().prepare(sql).all() as Array<Record<string, unknown>>;
    const line = (r: Record<string, unknown>) => JSON.stringify(r);
    return {
      nodes: q(
        `SELECT id, kind, name, qualified_name, file_path, language, start_line, start_column, end_line, end_column,
                docstring, signature, visibility, is_exported, is_static, is_abstract FROM nodes`,
      ).map(line).sort(),
      edges: q(
        `SELECT s.qualified_name AS source, s.file_path AS sourceFile, e.kind, t.qualified_name AS target, t.file_path AS targetFile,
                e.line, e.col, e.metadata, e.provenance
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind <> 'contains'`,
      ).map(line).sort(),
      refs: q(
        `SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail
         FROM unresolved_refs`,
      ).map(line).sort(),
    };
  } finally {
    db.close();
  }
}

async function indexed(files: Record<string, string>): Promise<Dump> {
  const root = tempDir('cg-matlab-crlf-');
  try {
    writeTree(root, files);
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
    return dumpOf(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const crlf = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [p, c.replace(/\n/g, '\r\n')]));

/** Each shape: its files with LF line ends, and what must be in the LF index (so that the comparison is never of two empty dumps). */
const SHAPES: Record<string, { files: Record<string, string>; edges: RegExp[]; refs: RegExp[] }> = {
  continuation: {
    files: {
      'spanOf.m': 'function [lo, hi] ...\n    = spanOf(v, ...\n    w)\n% a note ...\nlo = min(v);\nhi = helperC(w, ...\n    2) + ...\n    missingC(3);\nend\n',
      'helperC.m': 'function y = helperC(a, b)\ny = a + b;\nend\n',
      'main.m': 'function main()\n[a, b] = spanOf(1, ...\n    2);\nend\n',
    },
    edges: [/"target":"spanOf"/, /"target":"helperC"/],
    refs: [/"reference_name":"missingC".*"line":8/],
  },
  'block comments': {
    files: {
      'f.m': 'function f()\n%{\nhiddenA(1);\n  %{\n  hiddenB(2);\n  %}\nhiddenC(3);\n%}\nshownA(4);\nx = 1; %{\nshownB(5);\nmissingE(6);\n%{\nlost(7);\n',
      'shownA.m': 'function shownA(x)\nend\n',
      'shownB.m': 'function shownB(x)\nend\n',
    },
    edges: [/"target":"shownA"/, /"target":"shownB"/],
    refs: [/"reference_name":"missingE".*"line":12/],
  },
  'command syntax': {
    files: {
      'cmds.m': 'hold on\nformat long g\nrunTool alpha beta\nmissingCmd -quiet\nload data.mat\n',
      'runTool.m': 'function runTool(a, b)\nend\n',
    },
    edges: [/"target":"runTool"/],
    refs: [/"reference_name":"missingCmd"/],
  },
  'strings with %': {
    files: {
      's.m': "function s()\nfprintf('%d done\\n', 3);\nmsg = \"50% of it\"; helperS(msg);\nt = 'it''s 10%'; missingS(t); % trailing\nend\n",
      'helperS.m': 'function helperS(m)\nend\n',
    },
    edges: [/"target":"helperS"/],
    refs: [/"reference_name":"missingS".*"line":4/],
  },
  transpose: {
    files: {
      't.m': "function t(x, a, b)\ny = x';\nz = [a' b'];\nw = helperT(x)' * missingT(y').';\nend\n",
      'helperT.m': 'function y = helperT(x)\ny = x;\nend\n',
    },
    edges: [/"target":"helperT"/],
    refs: [/"reference_name":"missingT".*"line":4/],
  },
  'end in indexing': {
    files: {
      'e.m': 'function e(v, q)\na = v(end);\nb = v(2:end-1);\nc = q{end};\nd = helperE(v(end), 1);\nmissingX(a(end));\nend\n',
      'helperE.m': 'function y = helperE(a, b)\ny = a;\nend\n',
    },
    edges: [/"target":"helperE"/],
    refs: [/"reference_name":"missingX".*"line":6/],
  },
  classdef: {
    files: {
      'Shape.m':
        'classdef Shape < handle\n    % SHAPE  a shape\n    properties\n        Width = 1 % a width\n        Height (1,1) double = 2\n    end\n    properties (Constant)\n        Sides = 4\n    end\n    methods\n        function obj = Shape(w)\n            obj.Width = w;\n        end\n        function a = area(obj)\n            a = obj.Width * ...\n                obj.Height;\n            obj.grow(2);\n        end\n        function grow(obj, k)\n            missingG(k);\n        end\n    end\n    methods (Static)\n        function s = unit()\n            s = Shape(1);\n        end\n    end\nend\n',
      'useShape.m': 'function useShape()\ns = Shape(3);\na = s.area();\nu = Shape.unit();\nend\n',
    },
    edges: [/"target":"Shape::grow"/, /"target":"Shape::unit"/],
    refs: [/"reference_name":"missingG".*"line":20/],
  },
};

describe('MATLAB: CRLF reads as LF', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name}: the same nodes, edges and rows, lines and columns included`, async () => {
      const lf = await indexed(shape.files);
      for (const re of shape.edges) expect(lf.edges.some((e) => re.test(e)), `${name}: an edge matching ${re}`).toBe(true);
      for (const re of shape.refs) expect(lf.refs.some((r) => re.test(r)), `${name}: a row matching ${re}`).toBe(true);
      const cr = await indexed(crlf(shape.files));
      expect(cr).toEqual(lf);
    });
  }
});
