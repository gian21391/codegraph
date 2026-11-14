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

/** A character after which a `'` is a transpose, not the start of a string. */
const BEFORE_TRANSPOSE = /[\w)\]}.'"]/;

/**
 * The source with its MATLAB comments blanked and its strings' contents
 * blanked (the quotes stay), every other character and every line break in
 * place, so an offset or line found in the result is the same in the source.
 * Comments are `%` to the end of the line, what follows a `...` continuation,
 * a `!` shell-escape line and `%{ … %}` blocks (see maskMatlabBlockComments).
 * A `'` right after a name, a number, `)`, `]`, `}`, `.` or a closing quote is
 * a transpose. Strings never span lines.
 */
export function blankMatlabCommentsAndStrings(source: string): string {
  const parts: string[] = [];
  let copied = 0;
  const blank = (start: number, end: number): void => {
    if (end <= start) return;
    parts.push(source.slice(copied, start), ' '.repeat(end - start));
    copied = end;
  };
  let depth = 0;
  for (let lineStart = 0; lineStart <= source.length; ) {
    const nl = source.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? source.length : nl;
    // The line's text, a `\r` before its break left alone.
    const end = lineEnd > lineStart && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = source.slice(lineStart, end);
    if (depth > 0 || BLOCK_OPEN.test(line)) {
      if (BLOCK_OPEN.test(line)) depth++;
      else if (BLOCK_CLOSE.test(line)) depth--;
      blank(lineStart, end);
    } else if (/^[ \t]*!/.test(line)) {
      blank(lineStart, end);
    } else {
      let quote: string | null = null;
      /** Where the open string's contents start. */
      let from = 0;
      for (let i = lineStart; i < end; i++) {
        const c = source[i]!;
        if (quote !== null) {
          if (c !== quote) continue;
          if (i + 1 < end && source[i + 1] === quote) i++; // a doubled quote is one quote of the text
          else {
            blank(from, i);
            quote = null;
          }
        } else if (c === '"' || (c === "'" && (i === lineStart || !BEFORE_TRANSPOSE.test(source[i - 1]!)))) {
          quote = c;
          from = i + 1;
        } else if (c === '%' || (c === '.' && source.startsWith('...', i))) {
          blank(i, end);
          break;
        }
      }
      if (quote !== null) blank(from, end);
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  parts.push(source.slice(copied));
  return parts.join('');
}

/** Whether the file has an Octave-only line outside a `%{ … %}` block comment (MATLAB strings never span lines). */
export function isOctave(source: string): boolean {
  if (!OCTAVE_HINT.test(source)) return false;
  return OCTAVE_LINE.test(maskMatlabBlockComments(source));
}
