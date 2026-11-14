/**
 * Everything the MATLAB path evaluator (./matlab-path-eval) learns of the
 * project, it learns here: one object answers its five questions, and
 * records each question with the answer it gave.
 *
 *   - does this folder exist (`addpath` / `rmpath` arguments, the starting
 *     folder, `cd`, `exist(d, 'dir')`, `isfolder`);
 *   - what does this folder hold: its subfolders (a `genpath` walk, one
 *     folder at a time);
 *   - which files define this name (a call looked up, `which`, `exist`, and
 *     the word scan that finds the path-affecting functions);
 *   - what does this file contain (every file read, parsed or only scanned
 *     for path words), recorded by digest;
 *   - does this file exist (`isfile`, `exist(f, 'file')`, `run`).
 *
 * The record is the sync gate (see ./matlab-path-record): a sync asks every
 * recorded question again of the files as they are now, and works the path
 * out again only when an answer differs. So whatever the evaluator could have
 * learned is covered by construction, and no list of inputs is kept by hand.
 *
 * A folder is one the index knows: one holding an indexed file, or an
 * ancestor of one. A file is an indexed file, project-relative, '/'-separated.
 */

import { createHash } from 'crypto';
import { matlabFileStem } from '../extraction/languages/matlab-path';
import { dirOf } from '../graph/matlab-search-path';

/** The questions the evaluator may ask of the project. */
export interface MatlabProjectAccess {
  /** Whether the project-relative folder exists ('' is the root). */
  folderExists(rel: string): boolean;
  /** The names of the folder's subfolders, in `dir` (ASCII) order. */
  subfolders(rel: string): readonly string[];
  /** The project's files named `name.m` (or `.M`), in any folder. */
  filesDefining(name: string): readonly string[];
  /** Whether the project-relative file exists. */
  fileExists(rel: string): boolean;
  /** The file's text, or null when it cannot be read. */
  readFile(rel: string): string | null;
}

/** A short digest of a text: how a recorded answer stands for a file's content or a list (and the record for its configuration). */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The project's indexed files, and a way to read one: the answers to the evaluator's questions, as things are now. */
export class MatlabProjectView implements MatlabProjectAccess {
  private readonly fileSet: ReadonlySet<string>;
  private folderSet: Set<string> | null = null;
  private children: Map<string, string[]> | null = null;
  private stems: Map<string, string[]> | null = null;

  constructor(private readonly files: readonly string[], private readonly reader: (rel: string) => string | null) {
    this.fileSet = new Set(files);
  }

  private folders(): Set<string> {
    if (this.folderSet) return this.folderSet;
    const folders = new Set<string>(['']);
    for (const f of this.files) {
      for (let d = dirOf(f); !folders.has(d); d = dirOf(d)) folders.add(d);
    }
    this.folderSet = folders;
    return folders;
  }

  folderExists(rel: string): boolean {
    return this.folders().has(rel);
  }

  subfolders(rel: string): readonly string[] {
    if (!this.children) {
      const children = new Map<string, string[]>();
      for (const d of this.folders()) {
        if (d === '') continue;
        const parent = dirOf(d);
        const name = d.slice(parent === '' ? 0 : parent.length + 1);
        const list = children.get(parent);
        if (list) list.push(name);
        else children.set(parent, [name]);
      }
      for (const list of children.values()) list.sort();
      this.children = children;
    }
    return this.children.get(rel) ?? [];
  }

  filesDefining(name: string): readonly string[] {
    if (!this.stems) {
      const stems = new Map<string, string[]>();
      for (const f of this.files) {
        const stem = matlabFileStem(f);
        if (stem === null) continue;
        const list = stems.get(stem);
        if (list) list.push(f);
        else stems.set(stem, [f]);
      }
      for (const list of stems.values()) list.sort();
      this.stems = stems;
    }
    return this.stems.get(name) ?? [];
  }

  fileExists(rel: string): boolean {
    return this.fileSet.has(rel);
  }

  readFile(rel: string): string | null {
    return this.reader(rel);
  }

  /** The answer to a recorded question (see MatlabPathRecorder), asked again. */
  answer(question: string): string {
    const kind = question[0];
    const subject = question.slice(2);
    switch (kind) {
      case 'd': return this.folderExists(subject) ? '1' : '0';
      case 'l': return listAnswer(this.subfolders(subject));
      case 'n': return listAnswer(this.filesDefining(subject));
      case 'e': return this.fileExists(subject) ? '1' : '0';
      case 'f': {
        const text = this.readFile(subject);
        return text === null ? '' : digest(text);
      }
      default: return '\0';
    }
  }
}

/** A list as a recorded answer: empty for none, else a digest. */
function listAnswer(list: readonly string[]): string {
  return list.length === 0 ? '' : digest(list.join('\n'));
}

/**
 * The one way the evaluator reaches the project: each question goes to the
 * view, and is recorded with its answer (`answers`, keyed `<kind>:<subject>`:
 * `d` folder exists, `l` subfolders, `n` files defining a name, `e` file
 * exists, `f` file content).
 */
export class MatlabPathRecorder implements MatlabProjectAccess {
  readonly answers = new Map<string, string>();

  constructor(private readonly view: MatlabProjectView) {}

  folderExists(rel: string): boolean {
    const a = this.view.folderExists(rel);
    this.answers.set(`d:${rel}`, a ? '1' : '0');
    return a;
  }

  subfolders(rel: string): readonly string[] {
    const a = this.view.subfolders(rel);
    this.answers.set(`l:${rel}`, listAnswer(a));
    return a;
  }

  filesDefining(name: string): readonly string[] {
    const a = this.view.filesDefining(name);
    this.answers.set(`n:${name}`, listAnswer(a));
    return a;
  }

  fileExists(rel: string): boolean {
    const a = this.view.fileExists(rel);
    this.answers.set(`e:${rel}`, a ? '1' : '0');
    return a;
  }

  readFile(rel: string): string | null {
    const text = this.view.readFile(rel);
    this.answers.set(`f:${rel}`, text === null ? '' : digest(text));
    return text;
  }

  /** The questions and answers, sorted by question: what the record stores. */
  recorded(): Record<string, string> {
    return Object.fromEntries([...this.answers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** The first recorded question `view` answers differently now; null when none does. */
export function firstMovedAnswer(answers: Readonly<Record<string, string>>, view: MatlabProjectView): string | null {
  for (const [question, answer] of Object.entries(answers)) {
    if (view.answer(question) !== answer) return question;
  }
  return null;
}
