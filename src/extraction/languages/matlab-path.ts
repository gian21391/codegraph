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

/**
 * The name MATLAB calls a file by — `f` for `…/f.m` — or null when the file is
 * no `.m` file or its name is no identifier (`my-tool.m`, `2go.m`), which
 * MATLAB cannot call. The extension is matched in either case (`Foo.M`), and
 * either separator is accepted.
 */
export function matlabFileStem(filePath: string): string | null {
  const m = /(?:^|[\\/])([A-Za-z][A-Za-z0-9_]*)\.[mM]$/.exec(filePath);
  return m ? m[1]! : null;
}

/** The names a file node of the `.m` file `stem` may carry (`f.m`, `f.M`): what a lookup by the file's name asks for. */
export function matlabFileNames(stem: string): [string, string] {
  return [`${stem}.m`, `${stem}.M`];
}
