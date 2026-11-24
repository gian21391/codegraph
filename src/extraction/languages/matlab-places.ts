/**
 * Where a MATLAB reference sits on its line, and the column a reader is shown
 * for it. Light on purpose (no imports): the output layers (the JSON context,
 * the CLI's JSON, the viewer's API) read it as well as the extractor.
 */

/**
 * Where a reference no text written in the file places goes (see
 * placeTextRefs in ./matlab): a column no line reaches, `MATLAB_ANCHORED_BASE +
 * anchor × MATLAB_ANCHORED_STRIDE + k`, for the k-th such reference (from 0,
 * in the order the walk wrote them) whose anchor is that column of its line.
 * The encoding is internal: the store, the edge-to-row paths and the order rule
 * read it as it is, and every output shows {@link matlabShownColumn} instead.
 */
export const MATLAB_ANCHORED_BASE = 1_000_000_000;
export const MATLAB_ANCHORED_STRIDE = 1_000_000;

/**
 * A reference's place in the order code runs, as [line, column, rank]: an
 * anchored reference (see placeTextRefs) at its anchor, ranked by k, before
 * the file's own code that starts there; any other at its line and column.
 * Compared element by element.
 */
export function matlabPlaceOrder(line: number, column: number): [number, number, number] {
  if (column < MATLAB_ANCHORED_BASE) return [line, column, MATLAB_ANCHORED_STRIDE];
  const at = column - MATLAB_ANCHORED_BASE;
  return [line, Math.floor(at / MATLAB_ANCHORED_STRIDE), at % MATLAB_ANCHORED_STRIDE];
}

/**
 * The column a reader is shown for a stored one: an anchored place (see
 * MATLAB_ANCHORED_BASE) as its anchor, the column of the line where the code
 * that gives the reference runs; any other column as it is. No language but
 * MATLAB writes a column that high, and no line reaches one.
 */
export function matlabShownColumn(column: number): number;
export function matlabShownColumn(column: number | undefined): number | undefined;
export function matlabShownColumn(column: number | null | undefined): number | null | undefined;
export function matlabShownColumn(column: number | null | undefined): number | null | undefined {
  if (typeof column !== 'number' || column < MATLAB_ANCHORED_BASE) return column;
  return Math.floor((column - MATLAB_ANCHORED_BASE) / MATLAB_ANCHORED_STRIDE);
}

/** `edge` as a reader is shown it: its column through {@link matlabShownColumn}, the rest as it is. */
export function withShownColumn<T extends { column?: number }>(edge: T): T {
  return typeof edge.column === 'number' && edge.column >= MATLAB_ANCHORED_BASE ? { ...edge, column: matlabShownColumn(edge.column) } : edge;
}
