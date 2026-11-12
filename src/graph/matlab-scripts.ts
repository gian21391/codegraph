/**
 * MATLAB scripts — one rule for "this `.m` file is a script MATLAB runs by
 * its name", read by the resolver (a statement `setup_paths` reaches the
 * script's file node), by `codegraph_explore` (a script's file is the symbol a
 * name of one asks for) and by the viewer's steps (a call into a script's file
 * is a step), so the three never disagree about what a script is.
 *
 * A script is a MATLAB file on the path — outside every package (`+pkg/`),
 * class folder (`@Cls/`) and `private/` folder, its name an identifier — that
 * defines no function, method or class, with code in it: a file of comments
 * only is the help text of a MEX function of that name (`lcaPut.m` beside
 * `lcaPut.mexa64`), which is what MATLAB runs, and an Octave file (whose
 * functions go unread) is no script either; nor is a file of control bytes,
 * MATLAB Compiler's encrypted `.m` files (`V1MCC4000MEC…`) in a deployed
 * runtime tree.
 */

import { readFileSync } from 'fs';
import type { Node } from '../types';
import { validatePathWithinRoot } from '../utils';
import { matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';
import { isOctave, maskMatlabBlockComments } from '../extraction/languages/matlab-syntax';

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
 * Per file, keyed by the node array the lookup returns for it: the resolver's
 * per-file cache entry, which it replaces whenever it drops its caches, or an
 * indexed lookup's (one per request), so a verdict never outlives the nodes it
 * was read from.
 */
const VERDICTS = new WeakMap<Node[], boolean>();

/** Whether `file` is the file node of a script MATLAB runs by its name (see the top of this file). */
export function isMatlabScriptFile(file: Node, lookup: MatlabScriptLookup): boolean {
  if (file.kind !== 'file' || file.language !== 'matlab' || matlabFileStem(file.filePath) === null) return false;
  const scope = matlabPathScope(file.filePath);
  if (scope.packages.length > 0 || scope.classFolder !== undefined || /(?:^|\/)private\//.test(file.filePath)) return false;
  const nodes = lookup.getNodesInFile(file.filePath);
  let verdict = VERDICTS.get(nodes);
  if (verdict === undefined) {
    verdict = !nodes.some((n) => n.language === 'matlab' && DEFINING_KINDS.has(n.kind)) && runsCode(lookup.readFile(file.filePath));
    VERDICTS.set(nodes, verdict);
  }
  return verdict;
}

/** Whether MATLAB source holds a statement: a line that is no comment, outside every `%{ … %}` block. */
function runsCode(source: string | null): boolean {
  if (source === null || isOctave(source) || /[\x00-\x08\x0E-\x19\x1B-\x1F]/.test(source)) return false;
  return maskMatlabBlockComments(source).split(/\r?\n/).some((line) => !/^\s*(?:%.*)?$/.test(line));
}
