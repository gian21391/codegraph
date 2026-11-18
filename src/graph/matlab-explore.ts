/**
 * What `codegraph_explore` asks of a MATLAB project, beyond what it asks of
 * every language: two shapes the symbol-by-name seeding cannot see.
 *
 *   - A script has no symbol but its file (`setup_paths.m`): the file is what
 *     a name of one asks for, the file's code its body, and a script on a
 *     flow is a hop the gather (symbols, not files) never reaches. So is a
 *     stub's (`lcaGet.m`, the help text of a MEX function): its help is all
 *     the project holds of the function.
 *   - A class folder keeps each method in a file of its own (`@SerialLink/
 *     fdyn.m`), and a script is a file of its own, where no other query token
 *     is named beside it: the graph corroborates a bare word instead — the
 *     class the query also names contains the method (the class-folder pass's
 *     edge, "SerialLink fdyn accel rne"), or a function the query also names
 *     runs the script ("BeamLine globals").
 *
 * Made once per explore call, and only for an index that holds MATLAB: one
 * that holds none asks nothing more of it.
 */

import type CodeGraph from '../index';
import type { Node } from '../types';
import { MATLAB_CLASS_FOLDER_CONTAINS, isMatlabClassFolderFile } from '../resolution/matlab-class-folders';
import { indexedMatlabScriptLookup, isMatlabScriptFile, isMatlabStubFile, type MatlabScriptLookup } from './matlab-scripts';
import { matlabFileNames } from '../extraction/languages/matlab-path';

export interface MatlabExplore {
  /**
   * The file nodes of the scripts and stubs named `name` (`setup_paths.m` for
   * `setup_paths`), by the resolver's own rules: the copy the most MATLAB
   * calls link to first, then by path.
   */
  scriptsNamed(name: string): Node[];
  /**
   * The ids of `nodes` (defs of the bare word `token` no co-named file
   * corroborates) that the graph corroborates: a class-folder method of a
   * class among `typeTokens`, or a script a function named by another of
   * `tokens` runs. Both lowercased.
   */
  corroborated(nodes: readonly Node[], token: string, typeTokens: ReadonlySet<string>, tokens: ReadonlySet<string>): Set<string>;
  /** The scripts among the nodes `ids` names: a flow's hops, which the gather never reached. */
  scriptHops(ids: readonly string[]): Node[];
}

/** The probes for one explore call, or null when the index holds no MATLAB (or cannot say). */
export function matlabExploreFor(index: CodeGraph, projectRoot: string): MatlabExplore | null {
  try {
    if (!index.hasFilesOfLanguage('matlab')) return null;
  } catch {
    return null; // no probe, no MATLAB answers
  }
  // It keeps the nodes it read, so each file's script verdict is worked out once.
  const lookup = indexedMatlabScriptLookup(index, projectRoot);
  return {
    scriptsNamed: (name) => scriptsNamed(index, name, lookup),
    corroborated: (nodes, token, typeTokens, tokens) => {
      const out = classFolderMethodsOfNamedTypes(index, nodes, typeTokens);
      for (const id of scriptsRunByNamed(index, nodes, token, tokens)) out.add(id);
      return out;
    },
    scriptHops: (ids) => {
      if (ids.length === 0) return [];
      const found = index.getNodesByIds([...ids]);
      return ids.flatMap((id) => {
        const n = found.get(id);
        return n && isMatlabScriptFile(n, lookup) ? [n] : [];
      });
    },
  };
}

/**
 * The copies first that the most MATLAB calls link to, then by path: the copy
 * the project's code reaches (13 copies of `lcaGet.m` across labCA's versions
 * and platform folders), with no path model at query time. Explore shows the
 * first of many.
 */
function scriptsNamed(index: CodeGraph, name: string, lookup: MatlabScriptLookup): Node[] {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return [];
  try {
    const files = matlabFileNames(name).flatMap((fileName) =>
      index.getNodesByName(fileName).filter((n) => isMatlabScriptFile(n, lookup) || isMatlabStubFile(n, lookup)));
    if (files.length < 2) return files;
    const calls = new Map<string, number>();
    const edges = index.getIncomingEdgesTo(files.map((n) => n.id), ['calls']);
    const callers = index.getNodesByIds([...new Set(edges.map((e) => e.source))]);
    for (const e of edges) {
      if (callers.get(e.source)?.language === 'matlab') calls.set(e.target, (calls.get(e.target) ?? 0) + 1);
    }
    const byPath = (a: Node, b: Node): number => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
    return files.sort((a, b) => (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0) || byPath(a, b));
  } catch {
    return [];
  }
}

/** The class-folder methods among `nodes` whose class `typeTokens` names: one batched edge read and one node read. */
function classFolderMethodsOfNamedTypes(index: CodeGraph, nodes: readonly Node[], typeTokens: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (typeTokens.size === 0) return out;
  const methods = nodes.filter((n) => n.language === 'matlab' && n.kind === 'method' && isMatlabClassFolderFile(n.filePath));
  if (methods.length === 0) return out;
  try {
    const edges = index
      .getIncomingEdgesTo(methods.map((n) => n.id), ['contains'])
      .filter((e) => e.metadata?.synthesizedBy === MATLAB_CLASS_FOLDER_CONTAINS);
    if (edges.length === 0) return out;
    const owners = index.getNodesByIds([...new Set(edges.map((e) => e.source))]);
    for (const e of edges) {
      const owner = owners.get(e.source);
      if (owner && typeTokens.has(owner.name.toLowerCase())) out.add(e.target);
    }
  } catch { /* a probe failure corroborates nothing */ }
  return out;
}

/** The scripts among `nodes` a function named by another of `tokens` runs: one batched edge read and one node read. */
function scriptsRunByNamed(index: CodeGraph, nodes: readonly Node[], token: string, tokens: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const scripts = nodes.filter((n) => n.kind === 'file' && n.language === 'matlab');
  if (scripts.length === 0) return out;
  try {
    const edges = index.getIncomingEdgesTo(scripts.map((n) => n.id), ['calls']);
    if (edges.length === 0) return out;
    const callers = index.getNodesByIds([...new Set(edges.map((e) => e.source))]);
    const self = token.toLowerCase();
    for (const e of edges) {
      const caller = callers.get(e.source);
      const name = caller?.name.toLowerCase();
      if (name !== undefined && name !== self && tokens.has(name)) out.add(e.target);
    }
  } catch { /* a probe failure corroborates nothing */ }
  return out;
}
