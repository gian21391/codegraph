/**
 * The MATLAB search path as the index stores it (see
 * ../graph/matlab-search-path): worked out from the project's startup code by
 * ./matlab-path-eval, with every question that evaluation asked of the
 * project and the answer it got (./matlab-path-access). A sync asks those
 * questions again of the files as they are now, and works the path out again
 * when one answers differently, or when the configuration changed.
 *
 * The startup code is `codegraph.json`'s `matlab.startup`, else a `startup.m`
 * at the root (run from the root). With neither there is no path, and nothing
 * here runs. An evaluation that fails, or that puts no folder on the path,
 * leaves no path either: a warning, never an error. Such a record keeps its
 * questions like any other, so a fix to the startup code, or a folder that
 * comes, is seen by the next sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { loadMatlabConfig, type MatlabProjectConfig } from '../project-config';
import { logWarn } from '../errors';
import { dirOf, type MatlabPathRecord } from '../graph/matlab-search-path';
import { DEFAULT_MATLAB_COMPUTER, DEFAULT_MATLAB_RELEASE, evaluateMatlabPath, firstCalledName } from './matlab-path-eval';
import { MatlabPathRecorder, MatlabProjectView, digest, firstMovedAnswer } from './matlab-path-access';

/** Bumped when the evaluation's semantics change, so a sync after an upgrade works the path out again. */
const EVALUATOR_VERSION = 2;

/** The most notes a record keeps (`noteCount` says how many there were). */
const MAX_RECORD_NOTES = 200;

/** How many times the startup code was run (for tests: a sync that need not work the path out does not). */
export const matlabPathEvaluations = { count: 0 };

/** Where a root `startup.m` is, project-relative. */
const MATLAB_STARTUP_FILE = 'startup.m';

/** The digest of what the path is configured by: the `matlab` block, and whether a root `startup.m` is there when the block has no startup code. */
function matlabConfigDigest(config: MatlabProjectConfig | null, hasStartupFile: boolean): string {
  return digest(JSON.stringify({ v: EVALUATOR_VERSION, config, startupFile: config?.startup ? null : hasStartupFile }));
}

/** The digest of the configuration as the project has it now. */
export function currentMatlabConfigDigest(projectRoot: string, hasFile: (rel: string) => boolean): string {
  return matlabConfigDigest(loadMatlabConfig(projectRoot), hasFile(MATLAB_STARTUP_FILE));
}

/** The project as the index has it now: its files, read from the disk. */
function matlabProjectView(projectRoot: string, files: readonly string[]): MatlabProjectView {
  return new MatlabProjectView(files, (rel) => {
    try {
      return fs.readFileSync(path.join(projectRoot, rel), 'utf-8');
    } catch {
      return null;
    }
  });
}

/**
 * The path the project's startup code sets, worked out now. `files` are the
 * indexed files, project-relative. Never throws.
 */
export async function computeMatlabPathRecord(projectRoot: string, files: readonly string[]): Promise<MatlabPathRecord> {
  const config = loadMatlabConfig(projectRoot);
  const view = matlabProjectView(projectRoot, files);
  const hasStartupFile = view.fileExists(MATLAB_STARTUP_FILE);
  const configDigest = matlabConfigDigest(config, hasStartupFile);
  const fromConfig = config?.startup !== undefined;
  if (!fromConfig && !hasStartupFile) return { v: 1, source: null, config: configDigest, root: projectRoot, answers: {} };
  const source: 'codegraph.json' | 'startup.m' = fromConfig ? 'codegraph.json' : 'startup.m';
  const startupText = fromConfig ? config!.startup!.join('\n') : MATLAB_STARTUP_FILE;
  // Every question about the project goes through it, from here on.
  const access = new MatlabPathRecorder(view);
  const notes: string[] = [];
  let noteCount = 0;
  const addNotes = (list: readonly string[], total = list.length): void => {
    notes.push(...list);
    noteCount += total;
  };
  /** No path is in force: the record says why, and keeps the questions asked so far. */
  const none = (why: string, answers?: Record<string, string>): MatlabPathRecord => {
    logWarn(`No MATLAB search path: ${why}`);
    const all = [why, ...notes];
    return {
      v: 1,
      source: null,
      config: configDigest,
      root: projectRoot,
      notes: all.slice(0, MAX_RECORD_NOTES),
      noteCount: noteCount + 1,
      ...(answers ? { answers } : {}),
    };
  };
  try {
    await loadGrammarsForLanguages(['matlab']);
    const parser = getParser('matlab');
    // No answers: an environment that could not load the grammar asks again next time.
    if (!parser) return none('the MATLAB grammar could not be loaded');
    const parse = (text: string) => parser.parse(text);
    // The current folder at the start: as configured; else the folder of the
    // one file defining the function the code calls first; else the root.
    let cwd = '';
    if (config?.cwd !== undefined) {
      cwd = config.cwd.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '');
    } else if (fromConfig) {
      const tree = parse(startupText);
      if (tree) {
        try {
          const first = firstCalledName(tree.rootNode, startupText, (n) => access.filesDefining(n).length > 0);
          const defs = first ? access.filesDefining(first) : [];
          if (defs.length === 1) cwd = dirOf(defs[0]!);
          else if (first && defs.length > 1) addNotes([`${defs.length} files define ${first}: the startup code starts at the root (set matlab.cwd to choose)`]);
        } finally {
          tree.delete();
        }
      }
    }
    const config_ = config ?? {};
    matlabPathEvaluations.count++;
    const result = evaluateMatlabPath(
      { root: projectRoot, access, parse },
      {
        code: fromConfig ? startupText : '',
        ...(fromConfig ? {} : { codeFile: MATLAB_STARTUP_FILE }),
        cwd,
        env: config_.env ?? {},
        computer: config_.computer ?? DEFAULT_MATLAB_COMPUTER,
        release: config_.release ?? DEFAULT_MATLAB_RELEASE,
      },
    );
    addNotes(result.notes, result.noteCount);
    const answers = access.recorded();
    if (result.failed !== null) return none(result.failed, answers);
    if (result.folders.length === 0) return none('the startup code put no folder of the project on the path', answers);
    return {
      v: 1,
      source,
      startup: fromConfig ? startupText : MATLAB_STARTUP_FILE,
      config: configDigest,
      root: projectRoot,
      folders: result.folders,
      cwd: result.cwd,
      notes: notes.slice(0, MAX_RECORD_NOTES),
      noteCount,
      answers,
    };
  } catch (e) {
    // No answers: what went wrong is not one of them, so the next sync tries again.
    return none(`evaluating the startup code failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Whether the path `record` holds may have moved, its configuration aside
 * (the caller compares that): a question it asked of the project answers
 * differently now. `files` are the indexed files now. A record that kept no
 * questions always may.
 */
export function matlabPathInputsMoved(record: MatlabPathRecord, projectRoot: string, files: readonly string[]): boolean {
  if (!record.answers) return true;
  return firstMovedAnswer(record.answers, matlabProjectView(projectRoot, files)) !== null;
}

/** Whether two records set the same path: the same folders in order and the same current folder (or neither sets one). */
export function sameMatlabPath(a: MatlabPathRecord | null, b: MatlabPathRecord | null): boolean {
  const pa = a && a.source !== null ? a : null;
  const pb = b && b.source !== null ? b : null;
  if (!pa || !pb) return pa === pb;
  const fa = pa.folders ?? [];
  const fb = pb.folders ?? [];
  return (pa.cwd ?? null) === (pb.cwd ?? null) && fa.length === fb.length && fa.every((f, i) => f === fb[i]);
}
