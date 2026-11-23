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

/**
 * MATLAB's keywords (`iskeyword`). None is ever a name a program calls or
 * refers to: an overloaded `end` method is called through indexing, never by
 * name, and a keyword a parse error leaves where a name would be (a stray
 * `end` the grammar's recovery reads as a call) names nothing.
 */
const MATLAB_KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'classdef', 'continue', 'else', 'elseif', 'end', 'for', 'function', 'global', 'if',
  'otherwise', 'parfor', 'persistent', 'return', 'spmd', 'switch', 'try', 'while',
]);

/** Whether a reference's name (`f`, `pkg::f`, `v.m`) has a keyword for one of its parts, and so names nothing (see MATLAB_KEYWORDS). */
export function hasMatlabKeywordPart(name: string): boolean {
  return name.split(/::|\./).some((part) => MATLAB_KEYWORDS.has(part));
}

/**
 * A MATLAB line end: a `\n` and the run of `\r` before it (LF, CRLF, and the
 * `\r\r\n` an editor sometimes writes), which every MATLAB reader here splits
 * or drops lines by, so that all of them read a file's lines as the grammar is
 * given them (matlabParseText). A lone `\r` is no line end. Global, for
 * `replace`; `split` takes it as well.
 */
export const MATLAB_LINE_END = /\r*\n/g;

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
  const lines = source.split(MATLAB_LINE_END);
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

/** A `%{` ending a line that holds something before it (`x = 1; %{`): no block comment's start. Multiline. */
const OPENER_AFTER_TEXT = /^([ \t]*\S.*?%)\{([ \t]*)$/gm;

/**
 * A MATLAB file's text as the grammar is given it — by the extractor and by
 * every reader that parses a file again — so that the grammar reads what MATLAB
 * reads:
 *
 * - CRLF reads as LF: the `\r`s before each `\n` are dropped (MATLAB_LINE_END). The grammar reads
 *   a `\r` at a line end as text in places (`function [a, b] ...` continued
 *   onto `= f(x)` is no header then), and MATLAB reads none. Only the `\r`
 *   bytes go, so every line and column is the file's own; a lone `\r` stays.
 * - A `%{` with text before it on its line (`x = 1; %{`) is no block
 *   comment's start (MATLAB doc 'Add Comments to Code': the markers count
 *   only alone on their lines, as maskMatlabBlockComments reads them), but
 *   the grammar opens a block at any `%{` that ends a line. Its `{` becomes a
 *   space, so the `%` is a line comment's, in place: every offset, line and
 *   column stays. The grammar closes a block only at a `%}` alone on its
 *   line, and nests one at a `%{` alone, as the mask does, so the two agree.
 *
 * What a node's text reads is then the file's own, but for the dropped `\r`s
 * and those `{`s (inside a comment).
 */
export function matlabParseText(source: string): string {
  let text = source.includes('\r') ? source.replace(MATLAB_LINE_END, '\n') : source;
  if (text.includes('%{')) text = text.replace(OPENER_AFTER_TEXT, '$1 $2');
  return text;
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
    // The line's text, the run of `\r` before its break (MATLAB_LINE_END) or the file's end left alone.
    let end = lineEnd;
    while (end > lineStart && source[end - 1] === '\r') end--;
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

/**
 * Why a `.m` file read as MATLAB holds no MATLAB code to read, or null when it
 * may: Octave source (see isOctave), whose functions MATLAB does not run as
 * written, or no text at all — a NUL among its first 8000 characters, as git
 * tells a binary file: MATLAB Compiler's encrypted `.m` files
 * (`V1MCC4000MEC…`) in a deployed runtime tree, an archive saved as `.m`. (A
 * stray control byte further in, `'…FREQ\0'` in a string, is MATLAB's to
 * read past.) Nothing is read from such a file, and it answers no call: its
 * name carries no built-in's or member's (see ../../resolution/matlab-failures).
 */
export function matlabUnreadReason(source: string): 'octave' | 'binary' | null {
  const nul = source.indexOf('\0');
  if (nul >= 0 && nul < 8000) return 'binary';
  return isOctave(source) ? 'octave' : null;
}

/**
 * The code of the warning a MATLAB file matlabUnreadReason names is stored
 * with: what tells such a file in the index, at a sync after its text has
 * changed too (see ../../resolution/matlab-failures).
 */
export const MATLAB_UNREAD_CODE = 'source_not_read';

/**
 * The warning a MATLAB file's extraction records, or null: a file nothing is
 * read from (matlabUnreadReason), or a script — which has no symbol of its
 * own — whose parse has errors: what parses of it is still indexed.
 */
export function matlabFileWarning(filePath: string, source: string, hasError: boolean, symbolCount: number): { message: string; code: string } | null {
  const unread = matlabUnreadReason(source);
  if (unread !== null) {
    const what = unread === 'octave' ? 'Octave source, which is not read as MATLAB' : 'not MATLAB text (a binary or encrypted file)';
    return { message: `${filePath}: ${what} — the file is indexed, but none of its code is in the graph`, code: MATLAB_UNREAD_CODE };
  }
  if (!hasError || symbolCount > 0) return null;
  return { message: `${filePath}: parts of the file could not be parsed — they are left out of the graph, and the rest of it is indexed`, code: 'parse_error' };
}
