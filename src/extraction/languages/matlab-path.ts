/**
 * Where a MATLAB file sits on the path decides what its definitions are
 * called, and both the extractor (to qualify what a file defines) and the
 * resolver (to read a node's package back) need the one rule:
 *
 *   - `+a/+b/f.m` is in the package `a.b` — its definitions are `a::b::…`;
 *   - `@Cls/m.m` (directly in a class folder, itself possibly in packages) is
 *     a file of the class `Cls` — its primary function is the method `Cls::m`.
 *
 * Either separator is accepted, so a Windows-style path reads the same as a
 * POSIX one.
 */

export interface MatlabPathScope {
  /** `+a/+b/` → ['a', 'b'] */
  packages: string[];
  /** `@Cls/` → 'Cls' */
  classFolder?: string;
}

export function matlabPathScope(filePath: string): MatlabPathScope {
  const dirs = filePath.split(/[\\/]/).slice(0, -1);
  let classFolder: string | undefined;
  let end = dirs.length;
  if (end > 0 && dirs[end - 1]!.startsWith('@')) {
    classFolder = dirs[end - 1]!.slice(1);
    end--;
  }
  const packages: string[] = [];
  for (let i = end - 1; i >= 0 && dirs[i]!.startsWith('+'); i--) packages.unshift(dirs[i]!.slice(1));
  return { packages, classFolder };
}
