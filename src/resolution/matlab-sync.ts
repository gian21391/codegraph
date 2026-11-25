/**
 * What a sync must re-open for MATLAB that the definition delta cannot see:
 * the answers that depend on more than which names a changed file defines.
 *
 *   - A script runs by its file's name, and its calls end at its file node,
 *     which a re-index keeps: a file that becomes a script, or stops being
 *     one, changes no name it defines (reopenMatlabScriptRuns). So does a
 *     stub, the help text of a MEX function, which a call of its name
 *     nothing else answers reaches (../graph/matlab-scripts). And a name
 *     the delta does hold moves the calls of its script's or stub's file
 *     node, and of its case variants, which are no edges of the name
 *     (reopenMatlabNamesakes).
 *   - A method call reaches an inherited method through the superclass lists
 *     of the classes between: a class whose list changes (`Mid < pkg.Base`
 *     → `Mid < handle`) changes no name either (MatlabSuperclassChange).
 *   - A call on an object a constructor's call made (`tidy(g)` after `g =
 *     gadget();`) dispatches to the class only while that call reaches it,
 *     which a definition, a script or a case variant of the constructor's
 *     name moves, though the call is looked up by another name
 *     (reopenMatlabHintedCalls).
 */

import type { Node, NodeKind, UnresolvedReference } from '../types';
import { DORMANT_REF_STATUS, type QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';
import { isMatlabPathScript, isMatlabPathStub, matlabAncestorClasses, matlabMethodHeldBy, matlabSuperclassNames } from './matlab-lookup';
import { matlabFileNames, matlabFileStem, matlabPathScope } from '../extraction/languages/matlab-path';
import { dirOf } from '../graph/matlab-search-path';
import { wakeMatlabBuiltinRows } from './matlab-builtin-carriers';
import { KEPT_BY, matlabRefFacts } from '../extraction/languages/matlab-ref-facts';
import { isMatlabKeptByName } from '../extraction/languages/matlab-builtins';

/** What a script runs before, or a stub comes after: a function file's function, or a class on the path. */
const NAMESAKE_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'enum']);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Whether `names` holds a name that equals `name` only when case is ignored. */
function hasCaseVariant(names: ReadonlySet<string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const n of names) if (n !== name && n.toLowerCase() === lower) return true;
  return false;
}

/**
 * The name a reference calls as a function: its last segment for a call on an
 * object of a class recorded as `Cls::m` (`m(obj)`, which MATLAB looks up as a
 * function first, as any `m(…)`), the name itself otherwise.
 */
function calledName(referenceName: string): string {
  const cut = referenceName.lastIndexOf('::');
  return cut < 0 ? referenceName : referenceName.slice(cut + 2);
}

/**
 * The files among a sync's `changedFilePaths` whose script verdict
 * reopenMatlabScriptRuns has to settle: the MATLAB files, and an Objective-C
 * `.m` that MATLAB code still calls into (one that was a MATLAB script before
 * this sync re-read it). One indexed read per `.m` path, so an Objective-C
 * project's sync does no more.
 */
export function matlabScriptCandidates(queries: QueryBuilder, changedFilePaths: readonly string[]): string[] {
  return changedFilePaths.filter((p) => {
    if (matlabFileStem(p) === null) return false;
    const language = queries.getFileByPath(p)?.language;
    if (language === 'matlab') return true;
    return language !== undefined && queries.hasCrossFileIncomingEdgeFromLanguage(`file:${p}`, p, 'matlab');
  });
}

/**
 * Put back in the pending set the MATLAB calls a sync's `.m` files may now
 * answer differently because one became a script MATLAB runs by its name or
 * a stub (the help text of a MEX function), or stopped being one (a function
 * went in, its code went out leaving only help text, it turned to Octave),
 * for the sync's resolution sweep. The calls into a changed file's node go
 * back as the references they were, whatever it is now: a script that became
 * a stub answers calls with arguments too, and the statements it answered may
 * be a farther function's now (a stub comes last), and the reverse. The calls
 * linked to another copy of the file's name, and those parked as failed under
 * the name of one that is a script or a stub (`setup_paths` for
 * `setup_paths.m`), or kept dormant as a built-in's call only the path gave a
 * copy of (`sound` for `sound.m`), go back too: it may answer them now; for a script, so do
 * the calls linked to a farther function or class of its name (a statement runs the script, and a
 * call of another form that finds it first fails). (The failed calls of the name of a script that
 * stopped being one are retried with the delta: its file node `n.m` is a delta name, whose
 * namesakes reopenMatlabNamesakes reads.) Calls in
 * `changedFilePaths` are left alone: the sync resolved them already.
 * `matlabFilePaths` are the ones matlabScriptCandidates picks out of them.
 * Returns the number of references put back, and the rows of the ones that
 * were calls into a changed file: the sync judges those as a fresh index
 * judges its rows (see MatlabFreshReferences), since such a file can be one
 * whose text turned to Octave or binary, which carries no name (a fresh index
 * keeps no row of a call of it).
 */
export function reopenMatlabScriptRuns(
  queries: QueryBuilder,
  context: ResolutionContext,
  matlabFilePaths: readonly string[],
  changedFilePaths: readonly string[],
): { count: number; fromEdges: number[] } {
  const fresh = new Set(changedFilePaths);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const copyEdges = new Set<number>();
  const copyRefs: UnresolvedReference[] = [];
  const stems = new Set<string>();
  // A copy that is one of these files has its own edges put back below, once.
  const changed = new Set(matlabFilePaths);
  for (const filePath of matlabFilePaths) {
    const stem = matlabFileStem(filePath);
    if (!stem) continue;
    // Only the edges into the file node: a script's or a stub's calls end there.
    for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(`file:${filePath}`, filePath, 'matlab')) {
      if (fresh.has(edge.sourceFilePath)) continue;
      const ref = resurrectRefFromDroppedEdge(edge);
      if (!ref) continue;
      edgeIds.push(edge.edgeId);
      refs.push(ref);
    }
    // A class folder's file `m.m` that holds no method `m` (Octave, help
    // text, nothing) is what a call of `m` on an object of the class runs:
    // the calls in the folder's other files that a guess took for an
    // inherited method `m` (classMethodGuess in ./matlab-lookup) go back,
    // though no definition of `m` came or went. One that holds the method
    // again is the delta's.
    if (matlabPathScope(filePath).classFolder !== undefined && !queries.getNodesByFileOfKinds(filePath, ['method'], 'matlab').some((n) => n.name === stem)) {
      const dir = dirOf(filePath);
      for (const method of queries.getNodesByName(stem)) {
        if (method.language !== 'matlab' || method.kind !== 'method') continue;
        for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(method.id, method.filePath, 'matlab')) {
          if (fresh.has(edge.sourceFilePath) || dirOf(edge.sourceFilePath) !== dir || copyEdges.has(edge.edgeId)) continue;
          const ref = resurrectRefFromDroppedEdge(edge);
          if (!ref) continue;
          copyEdges.add(edge.edgeId);
          copyRefs.push(ref);
        }
      }
    }
    const script = isMatlabPathScript(filePath, context);
    if (script || isMatlabPathStub(filePath, context)) {
      stems.add(stem);
      // A script comes before a farther function or class of its name, which
      // answered the name while this file was help text, Octave or nothing:
      // it runs a statement, and a call of any other form that finds it
      // first is an error (see resolveBare in ./matlab-lookup). The delta's
      // rebind for the name, which no definition here changed (a stub comes
      // after them all, and takes nothing from them). Every call is read
      // through the namesakes themselves, so no name is too common for it
      // (`getlvl`, thousands of calls of its functions). A class's
      // constructor is one (`hf = @widget`, `widget(1)` on a classdef
      // `widget`: the method `widget::widget` a call or a handle links to).
      if (script) {
        for (const namesake of queries.getNodesByName(stem)) {
          if (namesake.language !== 'matlab') continue;
          if (!NAMESAKE_KINDS.has(namesake.kind) && !(namesake.kind === 'method' && namesake.qualifiedName === `${stem}::${stem}`)) continue;
          for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(namesake.id, namesake.filePath, 'matlab')) {
            if (fresh.has(edge.sourceFilePath) || copyEdges.has(edge.edgeId)) continue;
            const ref = resurrectRefFromDroppedEdge(edge);
            if (!ref) continue;
            copyEdges.add(edge.edgeId);
            copyRefs.push(ref);
          }
        }
      }
      // A script or a stub that was a function, help text or Octave a sync
      // ago left its calls linked to a farther copy of its file, which kept
      // its file node and so its name: no definition changed, and a nearer
      // one answers them now. They go back as the references they were, as
      // an added file's do.
      const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
      for (const copy of queries.getNodesByName(fileName)) {
        if (copy.kind !== 'file' || changed.has(copy.filePath) || copy.language !== 'matlab') continue;
        for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(copy.id, copy.filePath, 'matlab')) {
          if (fresh.has(edge.sourceFilePath) || copyEdges.has(edge.edgeId)) continue;
          const ref = resurrectRefFromDroppedEdge(edge);
          if (!ref) continue;
          copyEdges.add(edge.edgeId);
          copyRefs.push(ref);
        }
      }
    }
  }
  const fromEdges = edgeIds.length > 0 ? queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs) : [];
  if (copyEdges.size > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds([...copyEdges], copyRefs);
  // By the name a call is looked up by as a function: a call on an object recorded under its class (`Box::tidy`
  // for `tidy(b)`, whose class may have no method of it) finds the script first as a plain `tidy(…)` does.
  const rowIds = stems.size === 0 ? [] : queries.getRetryableFailedReferences([...stems]).flatMap((ref) =>
    ref.language === 'matlab' && stems.has(calledName(ref.referenceName)) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  const woken = stems.size === 0 ? 0 : wakeMatlabBuiltinRows(queries, stems, fresh);
  // A script or a stub of a constructor's name is what a call of it reaches, or no longer reaches (see reopenMatlabHintedCalls).
  const hinted = stems.size === 0 ? 0 : reopenMatlabHintedCalls(queries, stems, changedFilePaths);
  return { count: refs.length + copyRefs.length + queries.reopenFailedReferences(rowIds) + woken + hinted, fromEdges };
}

/**
 * Put back in the pending set the MATLAB calls a sync's definition delta
 * moves that its rebind (the edges into a node of a delta name) cannot see,
 * for the sync's resolution sweep, in files the sync left alone:
 *
 *   - the calls linked to a file node `n.m` (or `n.M`) of a name `n` a
 *     function, class or method of came or went: a script or a stub
 *     answered them, which a new definition of the name may take (a stub
 *     comes last; a statement runs the nearer of a script and a function),
 *     though the file node kept its name (an Octave `n.m` turned into a
 *     function, `n` added as a method of a class an object of is passed);
 *   - the calls linked to a node whose name equals a delta name only when
 *     case is ignored (`foo`, `foo.m` for a `Foo.m` or `FOO.m` added or
 *     removed): a nearer case variant vetoes them (nearerInexactMatch in
 *     ./matlab-lookup), and they are no edge of the delta's names; and the
 *     failed calls of those names, which a case variant that went no longer
 *     vetoes, and the dormant ones of a built-in's (`sound` for a `Sound.m`
 *     gone: see wakeMatlabBuiltinRows). Nodes of the delta's exact names are
 *     the rebind's.
 *
 * Read through the file nodes and the nodes of each name, not by target name,
 * so no name is too common to be reopened (a script with six copies). The
 * calls into a changed file's node are reopenMatlabScriptRuns's. Returns the
 * number of references put back.
 */
export function reopenMatlabNamesakes(
  queries: QueryBuilder,
  definitionDelta: readonly string[],
  changedFilePaths: readonly string[],
): number {
  if (definitionDelta.length === 0 || !queries.hasFilesOfLanguage('matlab')) return 0;
  const fresh = new Set(changedFilePaths);
  const delta = new Set(definitionDelta);
  // `n` for a name `n` and for a file name `n.m`, the case of each kept.
  const stems = new Set<string>();
  for (const name of delta) {
    const stem = IDENTIFIER.test(name) ? name : matlabFileStem(name);
    if (stem !== null) stems.add(stem);
  }
  if (stems.size === 0) return 0;
  // A definition's own file nodes: the exact `n.m` / `n.M` of each delta name.
  const exactFiles = new Set<string>();
  for (const name of delta) if (IDENTIFIER.test(name)) for (const f of matlabFileNames(name)) exactFiles.add(f);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const seenEdges = new Set<number>();
  const seenNodes = new Set<string>();
  // The names of the case variants found, whose failed calls a variant that
  // went no longer vetoes: the delta's own are retried by the sync already.
  const variants = new Set<string>();
  const keys = new Set([...stems].flatMap((stem) => [stem.toLowerCase(), `${stem.toLowerCase()}.m`]));
  for (const key of keys) {
    for (const node of queries.getNodesByLowerName(key)) {
      if (node.language !== 'matlab' || seenNodes.has(node.id)) continue;
      seenNodes.add(node.id);
      const called = node.kind === 'file' ? matlabFileStem(node.name) : node.name;
      if (called !== null && !delta.has(called)) variants.add(called);
      if (node.kind === 'file' && fresh.has(node.filePath)) continue;
      // The rebind's, unless a definition's own file (it may hold more calls than the rebind takes of one name).
      // Nor a symbol named like a file the delta holds alone (`foo` for `foo.m` gone or come): a stub comes after
      // it, an Octave or encrypted file blocks nothing, and the calls a new script (an empty file too) takes or
      // blocks are reopened with the script runs. Neither when the delta also holds a case variant of it (`Foo.m` come,
      // `foo.m` gone: a case-only rename), which vetoes or stops vetoing a call of any form, however many.
      if ((delta.has(node.name) || (node.kind !== 'file' && stems.has(node.name))) && !exactFiles.has(node.name) &&
        !(called !== null && hasCaseVariant(stems, called))) continue;
      for (const edge of queries.getCrossFileIncomingEdgesFromLanguage(node.id, node.filePath, 'matlab')) {
        if (fresh.has(edge.sourceFilePath) || seenEdges.has(edge.edgeId)) continue;
        seenEdges.add(edge.edgeId);
        const ref = resurrectRefFromDroppedEdge(edge);
        if (!ref) continue;
        edgeIds.push(edge.edgeId);
        refs.push(ref);
      }
    }
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs);
  // No per-name ceiling: the veto of every row of these names just changed, however many there are.
  const rowIds = variants.size === 0 ? [] : queries.getRetryableFailedReferences([...variants], Number.MAX_SAFE_INTEGER).flatMap((ref) =>
    ref.language === 'matlab' && variants.has(calledName(ref.referenceName)) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  const woken = variants.size === 0 ? 0 : wakeMatlabBuiltinRows(queries, variants, fresh);
  // What a call of a constructor's name reaches moved with its definitions and case variants (see reopenMatlabHintedCalls).
  const hinted = reopenMatlabHintedCalls(queries, [...stems, ...variants], changedFilePaths);
  // And whether a class has a method of a delta name, which a call on its object read through a write may need (see reopenMatlabKeptByCalls).
  const kept = reopenMatlabKeptByCalls(queries, stems);
  return refs.length + queries.reopenFailedReferences(rowIds) + woken + hinted + kept;
}

/**
 * Put back in the pending set the MATLAB calls on an object read through a
 * write that passed it to a MATLAB function of one of `names` (the keptBy
 * fact: `tidy(x)` after `x = numel(x)`, `numel`), linked or
 * failed: the call takes the class's method only while the class has a
 * method of each such name (resolveBare in ./matlab-lookup), which a
 * definition of the name coming or going in the class, in a class it
 * inherits from, or a superclass list changing moves (the definition delta
 * holds these names, a class hierarchy's too: see MatlabSuperclassChange),
 * though no name the call is looked up by changed. Every one, no ceiling,
 * read by the calls' own names: those a class holds a method under
 * (getMatlabClassMemberNames), not a scan of every row's and edge's facts.
 * Only a name a `keptBy` fact can carry is asked about (isMatlabKeptByName:
 * one of MATLAB's), so a delta of the project's own names reads nothing.
 * (A dormant one is not woken: its called name has no carrier, which a
 * method of a `keptBy` name does not give it; one that does comes with the
 * delta's own names. One in a file the sync changed is pending already.)
 * Returns the number put back.
 */
export function reopenMatlabKeptByCalls(queries: QueryBuilder, names: Iterable<string>): number {
  const wanted = new Set([...names].filter(isMatlabKeptByName));
  if (wanted.size === 0) return 0;
  const asks = (candidates: readonly string[] | undefined): boolean => (matlabRefFacts({ candidates }).keptBy ?? []).some((f) => wanted.has(f));
  // Only a call of a name some class holds a method under can take one: the class's method of the call's own name,
  // whose coming or going puts that name in the delta (and its calls back through the namesakes above).
  const { rows, edges } = queries.getMatlabCallsWithCandidateNamed(KEPT_BY, queries.getMatlabClassMemberNames());
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  for (const edge of edges) {
    const ref = resurrectRefFromDroppedEdge(edge);
    if (!ref || !asks(ref.candidates)) continue;
    edgeIds.push(edge.edgeId);
    refs.push(ref);
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs);
  const failed = rows.filter((row) => asks(row.candidates)).map((row) => row.rowId);
  return refs.length + queries.reopenFailedReferences(failed);
}

/**
 * Put back in the pending set the MATLAB calls on an object the extractor
 * took from a constructor's call whose name is one of `names`, in files the
 * sync left alone, linked or failed: `tidy(g)` after `g = gadget();` (the
 * argClass fact), `area(c)` after `c = Shape(…)` and `disp(g)` (`Shape::area`,
 * `gadget::disp`: the dispatch fact). Such a call takes the class's method
 * only while a call of the constructor's name reaches the class from the
 * caller (constructedClass in ./matlab-lookup), which a function, a class, a
 * script or a stub of the name, or a case variant of it, coming, going or
 * changing kind moves, though no name the call itself is looked up by
 * changed: a private `gadget.m` that comes makes `g` a struct. Read through
 * the methods of the classes of those names (by qualified name, a package's
 * class too), whatever they answer: the edges into a MATLAB node of a
 * method's name, the call's own or a farther function's, and the failed
 * rows under it, each kept only when its fact names one of those classes.
 * No ceiling: each one's answer turns on the name just changed. Returns the
 * number put back.
 */
export function reopenMatlabHintedCalls(queries: QueryBuilder, names: Iterable<string>, changedFilePaths: readonly string[]): number {
  const owners = new Set<string>();
  for (const name of names) {
    if (!IDENTIFIER.test(name) || owners.has(name)) continue;
    owners.add(name);
    for (const c of queries.getNodesByName(name)) if (c.language === 'matlab' && CLASS_KINDS.includes(c.kind)) owners.add(c.qualifiedName);
  }
  /** Method name → the classes of `names` that have a method of it. */
  const members = new Map<string, Set<string>>();
  for (const qn of owners) {
    for (const m of queries.getMatlabMethodsOfClass(qn)) {
      const list = members.get(m.name);
      if (list) list.add(qn);
      else members.set(m.name, new Set([qn]));
    }
  }
  if (members.size === 0) return 0;
  const hinted = (ref: UnresolvedReference): boolean => {
    if (ref.language !== 'matlab') return false;
    const member = calledName(ref.referenceName);
    const classes = members.get(member);
    if (!classes) return false;
    const facts = matlabRefFacts(ref);
    if (ref.referenceName === member) return facts.argClass !== undefined && classes.has(facts.argClass);
    return facts.dispatch !== undefined && classes.has(ref.referenceName.slice(0, -(member.length + 2)));
  };
  const fresh = new Set(changedFilePaths);
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const targets = [...members.keys()].flatMap((m) => [m, ...matlabFileNames(m)]);
  for (const edge of queries.getMatlabRebindEdgesByTargetName(targets)) {
    if (fresh.has(edge.sourceFilePath)) continue;
    const ref = resurrectRefFromDroppedEdge(edge);
    if (!ref || !hinted(ref)) continue;
    edgeIds.push(edge.edgeId);
    refs.push(ref);
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefIds(edgeIds, refs);
  const rowIds = queries.getRetryableFailedReferences([...members.keys()], Number.MAX_SAFE_INTEGER).flatMap((ref) =>
    hinted(ref) && !fresh.has(ref.filePath ?? '') && ref.rowId !== undefined ? [ref.rowId] : []);
  // And the dormant ones: a call under a built-in's name the class's method did not answer (`gadget::disp`).
  const asleep = queries.getMatlabCallRefsByTail(members.keys(), DORMANT_REF_STATUS).flatMap((ref) => (hinted(ref) && !fresh.has(ref.filePath) ? [ref.rowId] : []));
  return refs.length + queries.reopenFailedReferences(rowIds) + (asleep.length > 0 ? queries.setMatlabDormancy(asleep, []) : 0);
}

/**
 * Put back in the pending set the failed MATLAB calls on an object of a class
 * (`Widget::update`, `pkg::Base::run`) under a method name a changed class
 * hierarchy reaches (see MatlabSuperclassChange), in files the sync left
 * alone, however many: the chain may answer them now. The rebind's retry
 * takes the name's failures under its ceiling. Returns the number put back.
 */
export function reopenMatlabInheritedFailures(queries: QueryBuilder, names: readonly string[], changedFilePaths: readonly string[]): number {
  if (names.length === 0) return 0;
  const fresh = new Set(changedFilePaths);
  const wanted = new Set(names);
  const rowIds = queries.getRetryableFailedReferences([...wanted], Number.MAX_SAFE_INTEGER).flatMap((ref) => {
    if (ref.language !== 'matlab' || ref.rowId === undefined || fresh.has(ref.filePath ?? '')) return [];
    return ref.referenceName.includes('::') && wanted.has(calledName(ref.referenceName)) ? [ref.rowId] : [];
  });
  return queries.reopenFailedReferences(rowIds);
}

const CLASS_KINDS: readonly NodeKind[] = ['class', 'enum'];

/** A file in a class folder (`…/@Cls/x.m`). */
const CLASS_FOLDER_FILE = /(?:^|\/)@[^/]+\/[^/]+$/;

/** A class as a sync compares it: its superclass list as written, and whether it is a classdef (not an old-style class). */
interface ClassShape {
  bases: string[];
  filePath: string;
  classdef: boolean;
}

/**
 * A file's MATLAB classes, by qualified name, each with its superclass list as
 * written and its standing as a classdef. Reads only the file's MATLAB class
 * and enum rows, so an Objective-C `.m`, or a MATLAB file of functions, costs
 * one empty index seek.
 */
function classesIn(queries: QueryBuilder, file: string): Map<string, ClassShape> {
  const out = new Map<string, ClassShape>();
  for (const n of queries.getNodesByFileOfKinds(file, CLASS_KINDS, 'matlab')) {
    out.set(n.qualifiedName, { bases: matlabSuperclassNames(n), filePath: n.filePath, classdef: (n.signature ?? '').startsWith('classdef') });
  }
  return out;
}

/**
 * The MATLAB classes whose superclass lists a sync changes, and the names
 * that reach: a call that reached a method through the old list (`s.greet()`
 * on a `Sub < Mid`, `Mid < pkg.Base` → `pkg::Base::greet`) must go back to a
 * reference when the list loses it, and one that failed must be retried when
 * the list gains it. Both wait under the method's name, so the names of the
 * methods of every class the old and the new lists reach, with their
 * ancestors, are what the sync's rebind re-opens (edges into a node of the
 * name, failures under it), as if a definition of that name had come or gone.
 * A class's methods are those the definition its name resolves to holds, as
 * the resolver's methodOnHierarchy takes them (./matlab-lookup): a call on a
 * `Widget < Mid` answers from the copy of `Mid` the list resolves to, never
 * from another copy.
 * A class that comes or goes counts as a list changed from or to nothing, and
 * re-opens every name its ancestors' methods have, edges included, not only
 * the names it defines (the definition delta has those): it can be the link
 * another class's chain was missing (`Sub < Mid`, `Mid.m` new) or a nearer
 * copy of a class, and either changes what an inherited call or a `v.m`
 * common root already answers. So does a class that turns from a classdef
 * into an old-style class, or back (`@widget/widget.m` made `obj =
 * class(s, 'widget')`): its objects stop or start being classdef objects,
 * whose member written without parentheses calls a method (see
 * isOldStyleClass in ./matlab-lookup). So it re-opens, too, the names of the
 * methods its class folder holds (a call of one may hang on the class
 * standing: see classMethodGuess in ./matlab-lookup; its classdef's own are
 * the delta's), and the lists of the other copies of its qualified name
 * that stand after the sync, with their ancestors and their own methods: a
 * superclass written `Mid` resolves to the first copy of `Mid` on the path,
 * so a copy that comes ahead of another (`lib/Mid.m < handle` put before
 * `app/Mid.m < Node`), or goes, moves every class written `< Mid` from one
 * copy's chain to the other's, with no list changed that reaches either.
 *
 * The names go into the definition delta, under its per-name ceiling, and
 * the sync's rebind also takes, past the ceiling, every edge into a MATLAB
 * node of them whose reference names a class (`Widget::update`, however
 * many): a call on an object, which is what a chain answers.
 *
 * `before` is told each file the sync is about to change or remove, while its
 * rows are there to read (as the parameter-flow pass is); `changedNames` is
 * asked once the sync has stored what it re-extracted.
 */
export class MatlabSuperclassChange {
  private readonly classesBefore = new Map<string, Map<string, ClassShape>>();

  constructor(private readonly queries: QueryBuilder) {}

  before(file: string): void {
    if (matlabFileStem(file) === null || this.classesBefore.has(file)) return;
    this.classesBefore.set(file, classesIn(this.queries, file));
  }

  changedNames(context: ResolutionContext): string[] {
    const reached: { bases: string[]; filePath: string }[] = [];
    const names = new Set<string>();
    /** The qualified names that gained or lost a copy, or a copy's standing as a classdef. */
    const moved = new Set<string>();
    let matlabFiles: string[] | undefined;
    for (const [file, before] of this.classesBefore) {
      const after = classesIn(this.queries, file);
      for (const qn of new Set([...before.keys(), ...after.keys()])) {
        const was = before.get(qn);
        const now = after.get(qn);
        const sameStanding = was !== undefined && now !== undefined && was.classdef === now.classdef;
        if (sameStanding && was.bases.join('&') === now.bases.join('&')) continue;
        for (const c of [was, now]) if (c !== undefined && c.bases.length > 0) reached.push(c);
        if (sameStanding) continue;
        moved.add(qn);
        // A class folder's methods, which the folder's files are named after: its `contains` edges come later, from synthesis.
        if (CLASS_FOLDER_FILE.test(file)) {
          const dir = dirOf(file);
          matlabFiles ??= this.queries.getFilePathsOfLanguage('matlab');
          for (const f of matlabFiles) {
            const stem = dirOf(f) === dir ? matlabFileStem(f) : null;
            if (stem !== null) names.add(stem);
          }
        }
      }
    }
    for (const qn of moved) {
      // Every copy's methods, and those of a class folder no copy holds: which copy is the class, or whether any
      // is (a built-in type's class folder's methods answer only then: see qualifiedMethod), is what moved.
      for (const m of this.queries.getMatlabMethodsOfClass(qn)) names.add(m.name);
      for (const copy of context.getNodesByQualifiedName(qn)) {
        if (copy.language !== 'matlab' || !CLASS_KINDS.includes(copy.kind)) continue;
        reached.push({ bases: matlabSuperclassNames(copy), filePath: copy.filePath });
        for (const n of this.methodsOf(copy)) names.add(n);
      }
    }
    for (const { bases, filePath } of reached) {
      for (const cls of matlabAncestorClasses(bases, filePath, context)) {
        for (const n of this.methodsOf(cls)) names.add(n);
      }
    }
    return [...names];
  }

  /**
   * The names of a class's methods: those the class definition `cls` holds
   * (its file, its class folder), as the resolver's heldMethods takes them
   * (./matlab-lookup), and those the class folder's pass made it contain.
   * (An old-style class's other `@Cls` folders' methods are no ancestor's:
   * a classdef cannot list an old-style class as a superclass, see
   * superclassNamed; for a class whose copies moved, changedNames takes
   * every method of its qualified name already.)
   */
  private methodsOf(cls: Node): Set<string> {
    const names = new Set<string>();
    for (const m of this.queries.getMatlabMethodsOfClass(cls.qualifiedName)) if (matlabMethodHeldBy(cls, m)) names.add(m.name);
    const contained = this.queries.getOutgoingEdges(cls.id, ['contains']).map((e) => e.target);
    for (const n of this.queries.getNodesByIds(contained).values()) if (n.kind === 'method') names.add(n.name);
    return names;
  }
}
