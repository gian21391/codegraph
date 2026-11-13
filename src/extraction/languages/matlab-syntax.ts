/**
 * MATLAB text shapes that both `.m` detection (grammars.ts) and the MATLAB
 * extractor read, kept in one place so the two never disagree about what a
 * block comment hides or what makes a file Octave. Dependency-free: detection
 * runs on every `.m` file.
 */

/**
 * Octave's block keywords, which MATLAB does not have: MATLAB closes every
 * block with a bare `end`, and in MATLAB a line holding nothing but one of
 * these would be a command-syntax call to a function of that name. Includes
 * Octave's classdef keywords (`endclassdef`, `endmethods`, …).
 */
const OCTAVE_KEYWORDS: readonly string[] = [
  'endfunction',
  'endif',
  'endwhile',
  'endfor',
  'endparfor',
  'endswitch',
  'end_try_catch',
  'unwind_protect',
  'unwind_protect_cleanup',
  'end_unwind_protect',
  'endclassdef',
  'endmethods',
  'endproperties',
  'endevents',
  'endenumeration',
];

const KEYWORDS = OCTAVE_KEYWORDS.join('|');

/** A line holding an Octave keyword alone (a trailing `;` / `,` / comment aside). Multiline. */
export const OCTAVE_KEYWORD_LINE = new RegExp(`^[ \\t]*(?:${KEYWORDS})[ \\t]*(?:[;,%#].*)?$`, 'm');

/** A line only Octave writes: a `#` comment, or an Octave keyword alone on it. Multiline. */
const OCTAVE_LINE = new RegExp(`^[ \\t]*(?:#|(?:${KEYWORDS})[ \\t]*(?:[;,%#].*)?$)`, 'm');

/** Cheap pre-check for OCTAVE_LINE. */
const OCTAVE_HINT = new RegExp(`^[ \\t]*(?:#|(?:${KEYWORDS})\\b)`, 'm');

const BLOCK_OPEN = /^[ \t]*%\{[ \t]*$/;
const BLOCK_CLOSE = /^[ \t]*%\}[ \t]*$/;

/**
 * The source with every MATLAB `%{ … %}` block comment blanked out. The
 * markers count only alone on their lines, and blocks nest (`%{` inside a
 * block opens another), as MATLAB reads them. Each line keeps its place, so
 * line numbers survive.
 */
export function maskMatlabBlockComments(source: string): string {
  if (!source.includes('%{')) return source;
  const lines = source.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (BLOCK_OPEN.test(line)) {
      depth++;
      lines[i] = '';
    } else if (depth > 0) {
      if (BLOCK_CLOSE.test(line)) depth--;
      lines[i] = '';
    }
  }
  return lines.join('\n');
}

/** Whether the file has an Octave-only line outside a `%{ … %}` block comment (MATLAB strings never span lines). */
export function isOctave(source: string): boolean {
  if (!OCTAVE_HINT.test(source)) return false;
  return OCTAVE_LINE.test(maskMatlabBlockComments(source));
}
