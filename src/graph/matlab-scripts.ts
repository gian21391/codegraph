/**
 * MATLAB scripts — one rule for "this `.m` file is a script MATLAB runs by
 * its name", read by the resolver (a statement `setup_paths` reaches the
 * script's file node), by `codegraph_explore` (a script's file is the symbol a
 * name of one asks for) and by the viewer's steps (a call into a script's file
 * is a step), so the three never disagree about what a script is.
 *
 * A script is a MATLAB file on the path — outside every package (`+pkg/`),
 * class folder (`@Cls/`) and `private/` folder, its name an identifier — that
 * defines no function, method or class, with code in it — or with nothing in
 * it at all: an empty file, or one of block comments only, is a script of
 * nothing (the user's rulings, step 11). A file of `%` help-text lines only
 * is the help text of a MEX function of that name (`chanPut.m` beside
 * `chanPut.mexa64`), which is what MATLAB runs, and an Octave file (whose
 * functions go unread) is no script either; nor is a binary (matlabUnreadReason),
 * MATLAB Compiler's encrypted `.m` files (`V1MCC4000MEC…`) in a deployed
 * runtime tree.
 *
 * That file of `%` help-text lines is a stub (isMatlabStubFile): the help text of a
 * function compiled as a MEX file, shipped as P-code or as a Java class, which
 * the index never reads. A call of its name that nothing else answers links to
 * it (../resolution/matlab-lookup), so the help is what the call reaches. One
 * rule for both, read once per file: the same text that makes a script makes
 * no stub, and a file that is neither is neither for every reader.
 */

import { readFileSync } from 'fs';
import type { Node } from '../types';
import { validatePathWithinRoot } from '../utils';
import { matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';
import { MATLAB_LINE_END, maskMatlabBlockComments, matlabUnreadReason } from '../extraction/languages/matlab-syntax';

/** What the rule reads: satisfied by the resolver's context, and by a `CodeGraph` plus the project's files. */
export interface MatlabScriptLookup {
  getNodesInFile(filePath: string): Node[];
  readFile(filePath: string): string | null;
}

/**
 * A lookup over an open index (`codegraph_explore`, the viewer): its nodes,
 * and the project's files read from disk. It keeps each file's nodes, so a
 * file's verdict is worked out once for the lookup — make one per request,
 * never one that outlives a sync.
 */
export function indexedMatlabScriptLookup(index: { getNodesInFile(filePath: string): Node[] }, projectRoot: string): MatlabScriptLookup {
  const nodesByFile = new Map<string, Node[]>();
  return {
    getNodesInFile: (filePath) => {
      let nodes = nodesByFile.get(filePath);
      if (!nodes) nodesByFile.set(filePath, (nodes = index.getNodesInFile(filePath)));
      return nodes;
    },
    readFile: (filePath) => {
      const abs = validatePathWithinRoot(projectRoot, filePath, { readOnly: true });
      if (!abs) return null;
      try {
        return readFileSync(abs, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

const DEFINING_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'class', 'enum']);

/**
 * What a MATLAB file's nodes and text make it, wherever it is: a `script`
 * (code, or nothing at all, and no function, method or class), a `stub` (no
 * code, and a `%` help-text line: every line a comment or blank, outside or
 * inside `%{ … %}` blocks), or `none` (it defines something, cannot be read,
 * or is no MATLAB text: matlabUnreadReason). See textVerdict.
 */
type MatlabFileVerdict = 'script' | 'stub' | 'none';

/**
 * Per file, keyed by the node array the lookup returns for it: the resolver's
 * per-file cache entry, which it replaces whenever it drops its caches, or an
 * indexed lookup's (one per request), so a verdict never outlives the nodes it
 * was read from.
 */
const VERDICTS = new WeakMap<Node[], MatlabFileVerdict>();

/**
 * The file's verdict when it is a MATLAB file on the path's plain folders —
 * outside every package (`+pkg/`) and class folder (`@Cls/`), its name an
 * identifier — or null when it is not. Its nodes and text are read once.
 */
function plainFileVerdict(file: Node, lookup: MatlabScriptLookup): MatlabFileVerdict | null {
  if (file.kind !== 'file' || file.language !== 'matlab' || matlabFileStem(file.filePath) === null) return null;
  const scope = matlabPathScope(file.filePath);
  if (scope.packages.length > 0 || scope.classFolder !== undefined) return null;
  const nodes = lookup.getNodesInFile(file.filePath);
  let verdict = VERDICTS.get(nodes);
  if (verdict === undefined) {
    verdict = nodes.some((n) => n.language === 'matlab' && DEFINING_KINDS.has(n.kind)) ? 'none' : textVerdict(lookup.readFile(file.filePath));
    VERDICTS.set(nodes, verdict);
  }
  return verdict;
}

/** Whether `file` is the file node of a script MATLAB runs by its name (see the top of this file). */
export function isMatlabScriptFile(file: Node, lookup: MatlabScriptLookup): boolean {
  return plainFileVerdict(file, lookup) === 'script' && !/(?:^|\/)private\//.test(file.filePath);
}

/**
 * Whether `file` is the file node of a stub: the help text of a MEX function
 * of its name (see the top of this file), a MATLAB file outside every package
 * and class folder that defines nothing and holds no statement. One in a
 * `private/` folder is one too, reached as a private function is.
 */
export function isMatlabStubFile(file: Node, lookup: MatlabScriptLookup): boolean {
  return plainFileVerdict(file, lookup) === 'stub';
}

/**
 * What MATLAB source holds: a statement (a line that is no comment, outside
 * every `%{ … %}` block) makes a script; with none, a `%` line outside every
 * block is help text, a stub's; with neither — an empty file, white space
 * only, block comments only, an unclosed `%{` — it is a script of nothing, as
 * MATLAB runs it (the user's rulings, step 11); no MATLAB text at all is none.
 */
function textVerdict(source: string | null): MatlabFileVerdict {
  if (source === null || matlabUnreadReason(source) !== null) return 'none';
  const lines = maskMatlabBlockComments(source).split(MATLAB_LINE_END);
  if (lines.some(isStatementLine)) return 'script';
  return lines.some((line) => /^\s*%/.test(line)) ? 'stub' : 'script';
}

/** A line of MATLAB source, block comments masked, that is a statement: neither blank nor a `%` comment. */
const isStatementLine = (line: string): boolean => !/^\s*(?:%.*)?$/.test(line);

/**
 * Whether MATLAB source holds a statement (a line that is no comment, outside
 * every `%{ … %}` block), as textVerdict reads it. Source without one — empty,
 * white space, a BOM, comments only — defines nothing and makes no name: a
 * stub or a script of nothing.
 */
export function matlabTextHoldsStatement(source: string): boolean {
  return maskMatlabBlockComments(source).split(MATLAB_LINE_END).some(isStatementLine);
}
