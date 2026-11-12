/**
 * MATLAB class-folder methods → their class, as `contains` edges.
 *
 * A MATLAB class kept in a class folder (`@SerialLink/`) declares itself in
 * `@SerialLink/SerialLink.m` (`classdef SerialLink …`), and each other file in
 * that folder holds one of its methods (`@SerialLink/fdyn.m` → the method
 * `SerialLink::fdyn`). Extraction sees one file at a time, so it can link a
 * method only to its own file, and the class node never contains the methods
 * kept beside it — `codegraph_node`'s member outline, the viewer, dead-code
 * and anything that walks a class's members saw only the classdef file's.
 *
 * MATLAB fixes the layout: a class folder holds exactly one class, named after
 * the folder, declared in the file of that name. So this is a structural link,
 * not a guess — the same kind as the Go cross-file method containment pass —
 * and it carries no provenance, only the `synthesizedBy` ownership tag a
 * synthesis refresh replaces it by. An old-style `@`-folder class, whose
 * `Cls.m` is a constructor function rather than a `classdef`, has the class
 * node the extractor makes for it there; a folder with no `Cls.m` (methods
 * added to a built-in type, `@double/`) has none, and gets no edge.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import { matlabFileNames, matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';

export const MATLAB_CLASS_FOLDER_CONTAINS = 'matlab-class-folder';

/** Whether a file sits directly in a MATLAB class folder (`…/@Cls/m.m`, or `m.M`) under a name MATLAB can call. */
export function isMatlabClassFolderFile(filePath: string): boolean {
  return matlabFileStem(filePath) !== null && matlabPathScope(filePath).classFolder !== undefined;
}

export async function matlabClassFolderContainsEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const classOf = new Map<string, Node | null>();
  let scanned = 0;
  for (const method of queries.iterateNodesByKindIn('method', ['matlab'])) {
    if ((++scanned & 63) === 0) await onYield();
    if (!isMatlabClassFolderFile(method.filePath)) continue;
    const dir = method.filePath.slice(0, method.filePath.lastIndexOf('/'));
    const className = matlabPathScope(method.filePath).classFolder!;
    let cls = classOf.get(dir);
    if (cls === undefined) {
      // The class file is `Cls.m`, or `Cls.M`.
      cls = matlabFileNames(className)
        .flatMap((fileName) => queries.getNodesByFileAndName(`${dir}/${fileName}`, className))
        .find((n) => n.language === 'matlab' && (n.kind === 'class' || n.kind === 'enum')) ?? null;
      classOf.set(dir, cls);
    }
    // The classdef file's own methods are contained by extraction.
    if (!cls || method.filePath === cls.filePath) continue;
    if (method.qualifiedName !== `${cls.qualifiedName}::${method.name}`) continue;
    edges.push({
      source: cls.id,
      target: method.id,
      kind: 'contains',
      line: method.startLine,
      metadata: { synthesizedBy: MATLAB_CLASS_FOLDER_CONTAINS },
    });
  }
  return edges;
}
