# MATLAB support — review and fix plan

Branch `feat/matlab-support`, commit `5664b3fe` ("feat(extraction): MATLAB language support"), reviewed 2026-11-11.

Three independent reviewers read the commit: MATLAB semantics, regression risk for other languages, and code quality/conventions. Every finding below was reproduced by running code against the commit unless marked otherwise. The three most serious findings (§3.1, §3.2, §3.3) were re-run independently afterwards and all reproduced.

**Status: fixed.** The fix plan in §8 is implemented: §3 and §4, except §4.7, which was dropped because MathWorks documents the current behaviour as correct. Octave is documented as unsupported. §3.4 was fixed with graph containment (§6.7). Still open: §6 except 6.5–6.7, and copying classdef attributes onto method-file nodes (§4.9, third bullet). The original findings are kept below for reference. §2 has the re-measured numbers.

---

## 1. What the commit does

### Grammar

`tree-sitter-wasms` has no MATLAB grammar, and upstream [acristoffers/tree-sitter-matlab](https://github.com/acristoffers/tree-sitter-matlab) publishes no wasm. The vendored `src/extraction/wasm/tree-sitter-matlab.wasm` was built from upstream v1.3.3 (commit `ff2f83d`, MIT). The build used upstream's checked-in ABI-15 `parser.c` (no `generate`) and tree-sitter-cli 0.25.10 `build --wasm`. It passes `scripts/add-lang/check-grammar.mjs`: 20/20 clean parses, a clean parse of a 1 MiB file, and a clean exit. Its provenance is recorded in a comment in `src/extraction/grammars.ts`, as for the Nix grammar.

### Files

| File | Change |
|---|---|
| `src/types.ts` | `'matlab'` added to `LANGUAGES` |
| `src/extraction/grammars.ts` | wasm map, vendored set, display name; `.m` detection by content (`looksLikeMatlab`, `OBJC_M_SIGNAL`, `MATLAB_SIGNAL`, `C_DECLARATION_SIGNAL`) |
| `src/extraction/index.ts` | `preloadLanguagesForFiles` adds `matlab` when any `.m` file is present |
| `src/extraction/languages/index.ts` | registers `matlabExtractor` |
| `src/extraction/languages/matlab.ts` | new extractor; everything goes through the `visitNode` hook |
| `src/resolution/matlab-lookup.ts` | new: MATLAB name lookup (local → `private/` → path/imports; packages; superclass methods) |
| `src/resolution/name-matcher.ts` | MATLAB early return in `matchReferenceInner`; `isVisibleAcrossFiles` rejects another file's local MATLAB function |
| `src/mcp/tools.ts` | `codegraph_explore` seeding: a bare lowercase token also seeds when the candidate is a member of a type the query names (`isMemberOfNamedType`) |
| `__tests__/matlab.test.ts` | 15 tests: detection, extraction, resolution, explore |
| `README.md`, `CHANGELOG.md` | language list, Supported Languages row, `[Unreleased]` bullet |
| `.claude/skills/agent-eval/corpus.json` | MATLAB block with three repos |

### What gets extracted

- **Functions:**
  - A file's first function is marked exported.
  - Local and nested functions are marked not exported.
  - In an `@Class` folder, the first function is a method of that class.
- **Classes:**
  - `classdef` → class; an enumeration class with members → enum, with enum members.
  - Superclasses → `extends` refs; built-in bases (`handle`, `matlab.*`, …) are skipped.
  - Properties → property, and Constant properties → constant.
  - `methods (Static, Access = …, Abstract)` block attributes set the flags on their methods.
  - `get.X` / `set.X` keep their prefix.
- **Packages:** `+pkg/+sub/f.m` gives the qualified name `pkg::sub::f`.
- **Calls:**
  - `f(x)` is not emitted when `f` is a variable of the enclosing function, since it is an index read.
  - A bare name read as a value is a zero-argument call.
  - Package calls: `pkg.f(x)` → `pkg::f`.
  - On the method's own object: `obj.m()` / `m(obj, …)` → `Cls::m`.
  - On a variable assigned from a constructor: `c.area()` after `c = pkg.Circle(…)` → `pkg::Circle::area`.
  - On any other variable, `v.m()` → `v.m`, which the resolver links only when it is unambiguous.
  - Command syntax: `setup_paths`, `hold on`.
- **Handles:** `@f`, `@pkg.f`, `@obj.m` → `function_ref`.
- **Imports:** `import pkg.*` / `import pkg.Cls`.

### `.m` detection (shared with Objective-C)

The rules, in order:
1. An Objective-C line shape keeps the file Objective-C: `#import`/`#include`/`#define`/`#if…`/`#pragma`/`#undef`, an `@interface`/`@implementation`/`@protocol`/`@end`/`@class`/`@property`/`@synthesize`/`@import` keyword, or a `- (type)name` method header.
2. Otherwise a MATLAB-only shape makes it MATLAB: a `function`/`classdef` header, a `%` comment, a bare `end`, a `...` continuation, or `clc`/`clear`/`close all`.
3. Otherwise any non-C content makes it MATLAB.
4. An empty file stays Objective-C.
5. An explicit `codegraph.json` mapping for `.m` always wins.

Measured: 0 of 496 Objective-C `.m` files were misdetected (Masonry, fmdb, SDWebImage, realm-swift, wikipedia-ios, AFNetworking). 8,744 of 8,746 MATLAB `.m` files were detected (DeepLearnToolbox, robotics-toolbox-matlab, PlatEMO, fieldtrip, PRMLT); the two misses are empty files.

---

## 2. Benchmark results (before the review)

| Repo | Tier | `.m` files | Symbols / edges | Notable edges |
|---|---|---|---|---|
| rasmusbergpalm/DeepLearnToolbox | Small | 66 | 136 / 211 | 141 calls |
| petercorke/robotics-toolbox-matlab | Medium | 466 | 3,079 / ~6,500 | 616 instantiates, 36 extends |
| BIMK/PlatEMO | Large | 2,701 | 12,357 / 20,713 | 1,047 extends, 0 parse errors |

`verify-extraction.mjs` reported PASS on all three.

With vs without codegraph: headless `claude -p`, Sonnet, `--effort high`, one run per arm, no CLI contamination in either arm.

| Repo | With codegraph | Without |
|---|---|---|
| DeepLearnToolbox | 2 explore calls, 0 reads, 19s, $0.164 | 1 shell call, 26s, $0.094 |
| robotics-toolbox (before the explore fix) | 1 explore + 2 shell calls, 29s, $0.141 | 3 shell calls, 33s, $0.095 |
| robotics-toolbox (after the explore fix) | 1 explore call, 0 reads, 11s, $0.059 | 2 shell calls, 18s, $0.035 |
| PlatEMO | 2 explore calls + 2 reads, 18s, $0.205 | 7 shell calls, 36s, $0.180 |

All six answers were correct. The robotics answer with codegraph cited lines and traced inside `rne`; the answer without it says the recursion was not checked.

The questions are recorded in `corpus.json`:
- **DeepLearnToolbox:** nntrain → nnff → nnbp → nnapplygrads.
- **robotics-toolbox:** SerialLink.fdyn → ode45 → fdyn2 → accel → rne.
- **PlatEMO:** an NSGA-II generation, from ALGORITHM.Solve to EnvironmentalSelection.

### Re-measured after the fixes (2026-11-11)

All three repos were fully re-indexed (`EXTRACTION_VERSION` 29). `verify-extraction.mjs` reported PASS on all three.

| Repo | Edges | Unresolved refs | DB size | Index time |
|---|---|---|---|---|
| DeepLearnToolbox | 211 → 211 | 245 | 643 KB → 452 KB | 1.5 s → 0.76 s |
| robotics-toolbox | 6,286 → 6,483 (616 → 639 instantiates) | 9,590 | 10.9 MB → 8.8 MB | ~4 s |
| PlatEMO | 20,569 → 20,763 | 74,678 → 9,633 | 53.6 MB → 27.3 MB | 25.2 s → 8.1 s |

These counts are compared with `bench.log` from before the review. It gives PlatEMO 20,569 edges, not the 20,713 in the table above.

The A/B setup was the same as before, except that the daemon was pre-warmed for each repo. There was no CLI contamination in any of the six arms.

| Repo | With codegraph | Without |
|---|---|---|
| DeepLearnToolbox | 2 explore calls, 0 reads, 17s, $0.163 | 1 shell call, 15s, $0.092 |
| robotics-toolbox | 1 explore call, 0 reads, 12s, $0.123 | 2 shell calls, 17s, $0.100 |
| PlatEMO | 2 explore calls + 2 reads + 1 grep, 29s, $0.218 | 5 shell calls, 32s, $0.169 |

All six answers were correct, checked against the source.
- **robotics-toolbox:** both arms cost 2–3× the earlier run with the same tool calls. That looks like cache variance.
- **PlatEMO still reads two files.** Per-algorithm copies of `MatingSelection` / `EnvironmentalSelection` fill the explore file slots. Calls on a parameter (`Problem.Evaluation`) and base-class dispatch (`obj.main`, §6.10) have no edges.
- **DeepLearnToolbox:** the second explore call is due to the smallest tier's 4-file cap. It is not specific to MATLAB.
- **Flow gap:** explore's Flow section does not follow the `@fdyn2` handle, which is a `references` edge, so the Flow never starts at `fdyn`. This is a possible follow-up.

---

## 3. Must fix before merge

### 3.1 Calls from other languages resolve into MATLAB symbols — HIGH (re-run: reproduced)

- **Where:** `src/resolution/name-matcher.ts` ~L196 (`CODE_FAMILY`).
- **Problem:** `matlab` has no entry, so `crossesCodeBoundary(x, 'matlab')` is always false and `gateLanguageMatch` never rejects a match that lands on a MATLAB node. The commit's early return covers only refs written *in* MATLAB.
- **Why it's new:** before this commit, MATLAB `.m` files were indexed as `objc`, and the gate kept JVM/Python/web refs away from them.
- **Fixture:**
  - `py/run.py`, `js/app.js` and `c/mex.c` each call `normalize_rows(...)` / `compute_stats(...)`, with no definition in their own language.
  - All six calls get edges to `matlab/*.m`.
- **Re-run:** a Python `compute_stats(1)` linked to `compute_stats.m`.
- **Real corpus (robotics-toolbox):**
  - Java `new String(...)` in `java/Element.java` (L117, 466, 482, 558) → `instantiates` a MATLAB enum member `String` in `interfaces/EV3/ByteCodes.m`.
  - C++ `dot(...)` in `mex/ne.cpp` → `Octave/@Quaternion/dot.m`.
  - C++ `exit(...)` in `interfaces/crustcrawler/VisualServoing.cpp` (L74, 674) → a method in `interfaces/EV3/hidapi.m`.
- **Fix:** add `matlab: 'matlab'` to `CODE_FAMILY`. Verified on a patched dist: zero cross-language edges.
- **Test:** a mixed fixture (Python/JS/C calling a name only a `.m` file defines) must produce no edge.

### 3.2 `@fn` handles never reach the MATLAB resolver — HIGH (re-run: reproduced)

- **Where:** the hook in `matchReferenceInner` (`name-matcher.ts`), and `src/resolution/index.ts` ~L1893–1925.
- **Problem:** the hook only runs at Strategy 3 of `resolveOne`. `function_ref` refs leave earlier, through `resolveViaImport` → `matchFunctionRef`, so the `function_ref` branch of `matlab-lookup.ts` (L242–249, including the `@Cls` → constructor mapping) is dead code. MATLAB `calls` and `extends` refs also pass through the framework and `resolveViaImport` stages first, so the "authoritative" claim in the file header is not true as written.
- **Observed:**
  - `@helperB` links to a local function inside another file (b.m), which MATLAB cannot reach (re-run: reproduced).
  - `@geom.Circle` → no edge.
  - `@Robot` resolved only by coincidence, through a unique method name.
- **Fix:** route `ref.language === 'matlab'` near the top of `resolveOne`, beside the other language-gated branches (cfml/php/ruby/rust): `return this.gateLanguage(matchMatlabReference(ref, this.context), ref)`. Remove the hook in `matchReferenceInner`.
- **Tests:** a handle to another file's local function gives no edge; `@Cls` and `@pkg.Cls` resolve to the constructor, or to the class when there is no explicit constructor (see §6).

### 3.3 Wrong "own object" in constructors and `~` callbacks — HIGH (re-run: reproduced)

- **Where:** `src/extraction/languages/matlab.ts` L333–350 (`selfAt`).
- **Problem:** the first `identifier` parameter is taken as the object for every non-static method.
  - A constructor `function obj = Sub(L, varargin)` has no object input, since its object is the output, yet `L` becomes self.
  - In `function onClick(~, src, evt)` the `~` is an `ignored_argument` node, so `src` becomes self.
- **Observed:**
  - `Sub::Sub → Sub::numel` from `numel(L)` (re-run: reproduced).
  - `Sub::Sub → Base::disp` from `disp(L)`.
  - `Sub::onClick → Base::disp` from `disp(src)`.
- **Impact:** nearly every constructor of a class that overloads `disp`/`size`/`numel`/`char`, and every `~`-style listener or GUI callback.
- **Fix:** skip constructors (method name equals class name, in a classdef or `@Cls/Cls.m`). If the first parameter is `ignored_argument`, there is no self.

### 3.4 The explore ranking change affects other languages — MEDIUM

- **Where:** `src/mcp/tools.ts` ~L4763, L4878 (`isMemberOfNamedType`).
- **Problem:**
  - `typeTokens` is any token that starts with a capital and has at least 4 characters, so a capitalised first word of a question counts ("Trace", "Debug", "Explain", "Show", "Test").
  - The check compares it against every `::` segment of a qualified name. Those include C++ namespaces (`trace::dispatch`), Ruby modules (`Trace::Span::dispatch`), C# single-segment namespaces (`Debug::Log::write`), Scala objects, and outer classes (Python `Outer::Inner::dispatch`).
  - Not affected: Java/Kotlin dotted packages, Go, Rust modules, TS namespaces, PHP.
- **Fixture (C++):** for the query `Trace how Router handle reaches dispatch`, the answer `src/net/router.cpp` ranked first before the change. After it, the unrelated `src/trace/trace.cpp` (`namespace trace { int dispatch(...) }`) jumps above it. On a large repo this can push the answer out of the render budget.
- **Coverage:** all 41 explore test files pass; nothing pins this case.
- **Fix:** match only the enclosing type (the last scope segment), and only for `matlab` nodes. Better still, do §6.7: link class-folder methods to their class in the graph, so the explore special case can be dropped.
- **Test:** the C++ fixture above.

### 3.5 Upgrades leave existing indexes half Objective-C — MEDIUM

- **Problem:** before this commit `.m` files were indexed as `objc`. Sync detects changes by content hash only (`extraction/index.ts` ~L3363, ~L4028), so after upgrading, untouched files stay `objc` and only edited ones flip to `matlab`. `matlab-lookup` keeps only `language === 'matlab'` nodes, so calls into the stale files silently disappear.
- **Verified by simulation:** index with a `.m → objc` override, remove the override, edit one file, sync. Only the edited file became `matlab`.
- **Fix:** bump `EXTRACTION_VERSION` (28 → 29); its doc comment says to bump it for a new extractor. Nix, Erlang and Terraform didn't need to, because their extensions had never been indexed before. Add a re-index note to the CHANGELOG.

### 3.6 Extraction time grows quadratically in big classdef `methods` blocks — MEDIUM (measured)

- **Where:** `matlab.ts:334`. `selfAt` → `attributesOf(p.parent)` → `namedChildren` over the whole `methods` block, once per call, field chain and handle. `extractFunction` also calls `attributesOf(block)` once per method.
- **Synthetic classdefs:**

| Lines | Time |
|---|---|
| 1,088 | 464 ms |
| 5,408 | 4.6 s |
| 10,808 | 11.7 s |

  74% of that time is in `selfAt` / `attributesOf` / `namedChildren`.
- **Real files are fine today:** SerialLink.m (1,183 lines) 33 ms; SnirfClass.m (1,553 lines) 45 ms. App Designer exports, though, have exactly this shape: one big `methods` block of callbacks.
- **Function files** are linear but not cheap: sopen.m (10.5k lines) takes ~0.7–0.95 s, ~30% of it in `localsAt` walking up the parent chain once per identifier.
- **Fix:** keep an extractor-owned frame stack, pushed and popped in `extractFunction`, holding `{ locals, classHints, self }`, computed once per function. That makes `localsAt` / `selfAt` / `classHintAt` O(1) and removes the module-level caches (§5.1). At minimum, have `attributesOf` read only the leading `attributes` child and cache it per block.

---

## 4. Wrong edges from MATLAB semantics — should fix

Verified with `extractFromSource` and full `CodeGraph.init` indexing of small throwaway projects. The scratch harness is under the session scratchpad (`review-semantics/`, `run.sh ex|idx`).

4.1. **`method@Super(obj)` resolves to the method itself.**
- **Where:** `matlab.ts` L591–607. The grammar parses `delete@Base(obj)` as a `function_call` named `delete` with a `superclass` child; the extractor ignores that child and the own-object rule rewrites the call to the class's own method.
- **Observed:** `Sub::delete → Sub::delete`. **Correct:** `Base::delete`.
- **Related, missing:** `obj = obj@Base(varargin{:})`, the superclass constructor call in every subclass constructor, gives no edge.

4.2. **Bare names inside a package resolve to package siblings.**
- **Where:** `matlab-lookup.ts` L75–81 adds the file's own package as a wildcard import, and `nearest()` (L103) ranks a same-folder package function first.
- **Why it's wrong:** MATLAB requires `pkg.f` even inside `+pkg`.
- **Snippet:** `util.m`, `+pkg/util.m`, `+pkg/onlyInPkg.m`, and `+pkg/caller.m` calling `util(); onlyInPkg();`.
- **Observed:** `pkg::util` and `pkg::onlyInPkg`. **Correct:** top-level `util.m`, then no edge ("Undefined function").
- **Impact:** a package defining `+io/load.m` or `+viz/plot.m` captures every bare call to the built-in inside that package.
- **Fix:** drop the own-package fallback.

4.3. **Struct fields holding a function link to class methods.**
- **Where:** `matlab.ts` L395–403, `matlab-lookup.ts` L222–229.
- **Snippet:** `s.predict = @(v) v*2; y = s.predict(x);` and `cfg = struct('predict', @sin); z = cfg.predict(x);`, with a `classdef Model` that defines `predict`.
- **Observed:** both → `Model::predict`. **Correct:** no edge.
- **Fix:** when the function proves the variable is a struct (`s.f = …` assignment, or `= struct(…)`), emit nothing for `v.m`.

4.4. **Import precedence and scope.**
- **Where:** `matlab-lookup.ts` L195–214, `importsOf` L64.
- **MATLAB's order:** variables → explicitly imported names → nested functions → local functions → wildcard imports → private functions → class methods → `@`-folder constructors → current folder → path.
- **Cases:**
  - `import imp.helper; helper()` with a local `helper` → local; should be `imp::helper`.
  - `import imp.*; helper()` with a `helper.m` in the caller's folder → `helper.m`; should be `imp::helper`.
  - An import applies only to the function containing it, but `importsOf` is file-wide: a call in `three()` links to `imp::onlyImp` when only `two()` imports `imp.*`. MATLAB says undefined.

4.5. **A nested function is reachable from other top-level functions in the file.**
- **Where:** `matlab-lookup.ts` L199–200.
- **Snippet:** `function gui(); … function cb() … end; end` and `function other(); cb(); end`, with `cb.m` on the path.
- **Observed:** `other → gui::cb`. **Correct:** `cb.m`. A nested function is visible only to its parent, its siblings and its own nested functions.

4.6. **The primary function is named by its declaration, not its file.**
- **Where:** `matlab.ts` L453.
- **Snippet:** `foo.m` containing `function bar()`.
- **Observed:** `bar()` resolves to `foo.m`, which is wrong; `foo()` resolves to nothing, which is a missing edge. MATLAB calls it by the file name.

4.7. **Variables shared with a nested function are read as calls.**
- **Where:** `matlab.ts` L233–240.
- **Snippet:** `function r = outer(x); compute(); r = total + x; function compute(); total = 42; end; end`.
- **Observed:** `calls:total` is emitted and links to any `total.m`.
- **Fix:** a parent's variables include those its nested functions assign.

4.8. **`catch` followed by a statement on the next line.**
- **Where:** `matlab.ts` L278–281.
- **Problem:** the grammar attaches a bare identifier on the line after `catch` to the `catch_clause`, and the extractor takes it as the error variable.
- **Effect:** the call inside the catch is lost, and the same name used as a call later in the function is suppressed too.
- **Fix:** accept the identifier only when it is on the same row as `catch`.

4.9. **Class-folder method declarations are marked abstract and win over the implementation.**
- **Where:** `matlab.ts:472`. A `function_signature` sets `isAbstract` even when its block has no `Abstract` attribute. In a class-folder classdef such a signature only declares a method implemented in a separate file.
- **Snippet:** `@Pt/Pt.m` declares `d = norm2(obj)` in a plain `methods` block and `p = origin()` in `methods (Static)`; the bodies are in `@Pt/norm2.m` and `@Pt/origin.m`.
- **Observed:** `q.norm2()` and `geo.Pt.origin()` both resolve to the declaration lines in `Pt.m`. Both nodes share a qualified name and `nearest` breaks ties by order (L103, 161, 228). The method file's node also never gets `isStatic` / `visibility`, and `dead-code.ts` reads `isAbstract`.
- **Fix:**
  - Mark `isAbstract` only in an `Abstract` block.
  - Prefer the node with a body when two share a qualified name.
  - Carry the declaration's attributes to the method file's node.

4.10. **A superclass list over several lines loses its later bases.**
- **Where:** `matlab-lookup.ts:144` (`superclassesOf`) regex-splits the stored signature on `&`.
- **Snippet:** `classdef Foo < Bar & ... comment⏎ Baz`. The extractor emits correct `extends` refs (`Bar`, `Baz`), but the signature reads `"classdef Foo < Bar & ... base two Baz"`.
- **Effect:** methods inherited from `Baz` are never found.
- **Fix:** write a normalised `classdef X < A & B` signature from the AST in `extractClass`, or have the resolver read the class's `extends` refs or edges.

### Octave

- **Problem:** the grammar does not know `#` comments or `endfunction` / `endif`.
- **Effects:**
  - `# compute the result first` parses as the command `compute` and links to `compute.m`.
  - A small Octave file produced `calls:Octave`, `calls:comment`, `calls:endif`, `calls:endfunction`, `calls:a`, `calls:b`, and the function's range was cut short.
  - `OBJC_M_SIGNAL` sends a MATLAB file with a `# define the grid` comment, or a matrix row like `-(b) c`, to Objective-C, so the whole file is lost.
- **Decide:** pre-parse Octave (strip `#` comment lines and map `end*` keywords to `end`, keeping byte offsets), or document Octave as unsupported and keep `#`-comment files out of MATLAB.

---

## 5. Code quality and conventions

5.1. **Module-level caches** (`matlab.ts` L163–165).
- **Mostly safe:** each worker has its own module instance; the caches reset when the source changes, and identical content gives an identical tree. There is precedent (`cppMaskMemo`).
- **Hazards:**
  - The key is `startIndex`, and `source_file` and a `function_definition` at byte 0 both have key 0.
  - Only `localsAt` resets the caches; `classHintAt` / `localsFor` would read stale data if ever called first.
  - The last file's source stays in memory in the long-lived server.
- **Fix:** the frame stack from §3.6 removes them entirely.

5.2. **Duplication.**
- `pathScope` (`matlab.ts:129`) and `ownPackage` (`matlab-lookup.ts:86`) encode the same `+pkg` / `@Cls` rule with different separator handling (`[\\/]` vs `/`). Share one helper.
- `importsOf`'s second `getNodesInFile(...).find(...)` only uses `own.filePath`.
- `fieldChainRef` (`matlab.ts:376`) and `handleRef` (`:411`) repeat the same receiver logic (self / local / class hint / package). Merge them.

5.3. **Field names the grammar doesn't have.** `bodyField: 'block'` and `paramsField: 'function_arguments'` (`matlab.ts:576–577`) are not fields in this grammar. Its fields are argument, arguments, condition, expression, field, left, name, object, operand and right. This is harmless only because core extraction is bypassed. Comment them or set them honestly.

5.4. **Resolver details.**
- `packageOf` returns the owner class in `resolveVariableMethod`; rename it.
- `new Set([...CALLABLE_KINDS, ...TYPE_KINDS])` is allocated per ref in two places; hoist it to a constant.
- `import pkg.*` emits an `imports` ref that can never resolve, since there is no package node.

5.5. **Unresolved built-ins.**
- **Measured on PlatEMO:** 74,678 unresolved refs against 20,569 edges. The top names are `size`, `repmat`, `sum`, `length`, `zeros`, `ones`, `max`, `min`, `find`, `pi`, `isempty`, `true`.
- **Disk:** `unresolved_refs` and its indexes take ~29 MB of the 53 MB database.
- **Fix:** skip a small set of the hottest MATLAB core names and constants at extraction (`pi`, `true`, `false`, `Inf`, `NaN`, `eps`, …), as Scala and Dart already do for built-in types. Keep the set small, because MATLAB lets a project shadow a built-in.

5.6. **Memo rule.** `matlab-lookup.ts` keeps no module state, so it complies today. If `importsOf` / `superclassesOf` are memoised later, they must hook into `clearNameMatcherMemos` by hand: `name-matcher-memo-clears.test.ts` only scans `name-matcher.ts`. Resolver cost is not a hotspot today: PlatEMO indexes in 7.5–8 s; qualified lookups take 330–680 µs.

5.7. **Tests** (`__tests__/matlab.test.ts`).
- **Conventions are fine:** mkdtemp with cleanup, real SQLite, `CodeGraph.init`. Exact-list edge assertions also prove absence.
- **Missing:**
  - handles across files and `@Cls`
  - `import pkg.*` / `import pkg.Cls` at resolution
  - nested functions sharing the parent's workspace
  - locals in script files
  - multi-line superclass lists
  - syncing an edited `.m` file
  - the new `isVisibleAcrossFiles` rule
  - plus one test per fix in §3 and §4

5.8. **CHANGELOG / README.**
- The MATLAB bullet is three sentences, but the rule is one sentence per bullet.
- The explore sentence describes a change that affects every language; it gets its own bullet, or goes once §3.4 makes it MATLAB-only.
- "`@` function handles follow MATLAB lookup" is not true until §3.2 is fixed.
- Add the re-index note (§3.5) and the PR number when the PR is opened.
- The README rows are fine.
- AGENTS.md requires A/B evidence for a new language: cite the re-measured results in the PR.

5.9. **Vendored wasm.** This follows the convention: a `grammars.ts` comment, like Nix and ArkTS; `docs/grammars/` only holds patched grammars. Optional: record the wasm's sha256, and note whether upstream's corpus tests pass, as the Nix entry does.

---

## 6. Missing edges — follow-ups, not blockers

6.1. **Dot-calls without parentheses.** `obj.reset;`, `x = obj.compute;`, `Cls.staticM`, `pkg.f` and `r.n` give no ref: a chain made only of identifiers emits nothing. This is common in MATLAB OOP code and is the biggest gap. It needs care, because `s.field` property reads look the same; the same receiver rules as `obj.m()` plus the property-name guard would apply.

6.2. **Function-syntax calls on a variable whose class is known.** After `c = C();`, `run(c)`, `fb(c)` and `fkine(s, 2)` produce nothing. The class hint is only used for dot syntax. In MATLAB, method dispatch on the argument also outranks path functions.

6.3. **Old-style `@Poly/Poly.m` constructor function.** `Poly([1 2])` gets no edge: the constructor is kind `method` and there is no class node. `@Poly` does resolve, so calls and handles are inconsistent.

6.4. **Scripts as call targets.** `setup_paths` (command syntax) and `run('setup_paths.m')` have no target, since a script has no function node. The file node would be a natural target.

6.5. **`@K` when `K` has no explicit constructor** gives no edge; it should fall back to the class.

6.6. **Lambda parameters leak into the function's variables.** `cellfun(@(helperB) …)` makes a later `helperB(3)` look like a variable read, so the call is dropped.

6.7. **Class-folder methods aren't contained by their class.** `SerialLink::accel` is contained only by its file `@SerialLink/accel.m`; the `SerialLink` class node contains only its 69 classdef-file members. Only `codegraph_explore` sees the link, through §3.4's ranking tweak. AGENTS.md says derivations belong in the graph, not in `ToolHandler`. A resolution or post-extract step that links the class to its folder methods would serve `codegraph_node`, callers, the viewer and dead-code, and would let §3.4 be dropped.

6.8. **Other gaps:**
- bare zero-argument calls in `if` / `switch` conditions (`if checkReady`)
- validator functions in `arguments` blocks (`{myValidator}`)
- class-typed `arguments` (`opts.Model Robot`)
- string dispatch (`feval('fn')`, `str2func`, `cellfun('isempty', …)`)
- a class hint inside a nested function only looks at the innermost function (seen in the code, not run)

6.9. **Explore with heavily overloaded names (PlatEMO).** PlatEMO has ~100 `EnvironmentalSelection.m` files, one per algorithm folder. The resolver links NSGA-II to its own folder's copy, but explore doesn't use the call graph to choose among overloads. An over-overloaded name keeps only the defs whose path or class matches a query type, and `NSGAII` doesn't match the folder `NSGA-II`, so the agent read 2 files. A general explore change: "prefer the def that a co-named symbol calls".

6.10. **Base-class dispatch.** `ALGORITHM.Solve → obj.main()` stops at the base `main`; there is no hop to subclass overrides such as `NSGAII::main`.

---

## 7. Lower-severity regression notes

- **`.m` misdetection edge cases.** None occur in the corpora. These signal-less Objective-C/C `.m` files flip to MATLAB:
  - only `//` or `/* */` comments
  - a C function with its `{` on the next line
  - only `FOUNDATION_EXPORT …` or `CGFloat const k = …;`
  - a lone `#elif` / `#warning` / `#error` (missing from `OBJC_M_SIGNAL`)
  - a `-⏎(void)foo` header split across lines
  - block variables `void (^h)(void) = …`
  - a line that is only `end;`
  - UTF-16 `.m` files
  - Mathematica `.m` packages (no regression; garbage before too)

  These files have almost no symbols either way. Cheap fixes: add `elif|warning|error` to `OBJC_M_SIGNAL`, and treat comment-only files as unchanged (Objective-C).
- **Retry path language mismatch.** `extraction/index.ts` ~L3065–3085: the last-resort retry parses the comment-stripped text, which can detect differently from `fullContent`, and stores the result under the language detected from `fullContent`. This only affects files that already crashed twice.
- **Grammar preload cost.** Every iOS/Objective-C project now loads the 450 KB MATLAB wasm in each worker. Possible fix: preload MATLAB only once a `.m` file actually detects as MATLAB, or load it lazily.

### Checked and found safe

- Detection on real code: every one of 36,530 `.m` files under `/Volumes/git-cs` that has real Objective-C tokens stayed `objc`.
- Every extraction / sync / worker / `extractFromSource` path passes the file's source to `detectLanguage`. The source-less callers are irrelevant:
  - `parameter-flow.ts:514` is Ruby-only.
  - `express.ts` / `nestjs.ts` have their own local `detectLanguage`.
  - `kernel-parity.mjs` skips `.m`.
- The viewer picks its grammar from the indexed language.
- No MATLAB-to-other-language edges.
- Path-based `.m` checks in the react-native / fabric / swift-objc / callback-synthesizer code are unchanged for Objective-C.
- Test suites, all green:
  - 22 Objective-C test files (260)
  - `extraction.test.ts` + 2 others (782)
  - 41 explore test files (447)
  - inventory / guard tests (61)
- `installer-targets.test.ts` has 30 failures on clean `main` in this environment; they predate the commit.

---

## 8. Fix plan

The order puts first what changes the graph for other languages, then what changes MATLAB edges, then cleanup.

1. **Cross-language gate:** `matlab` in `CODE_FAMILY` (§3.1), plus a mixed-language test.
2. **Route MATLAB refs to the MATLAB resolver** at the top of `resolveOne`, and remove the `matchReferenceInner` hook (§3.2). Tests: cross-file local handle, `@Cls`, `@pkg.Cls`, a class with no constructor (§6.5).
3. **Narrow the explore seeding** to `matlab` nodes and the enclosing type (§3.4), plus the C++ regression fixture. Then decide whether §6.7 (graph containment for class-folder methods) replaces it.
4. **Extractor frame stack** (§3.6 / §5.1). While restructuring it:
   - constructors and `~` have no self (§3.3)
   - `method@Super` (§4.1)
   - nested-function shared variables (§4.7)
   - same-row `catch` identifier (§4.8)
   - lambda parameters scoped to the lambda (§6.6)
   - merge `fieldChainRef` / `handleRef` (§5.2)
5. **Resolver semantics:**
   - drop the own-package fallback (§4.2)
   - import precedence and per-function scope (§4.4)
   - nested-function visibility (§4.5)
   - primary function named by its file (§4.6)
   - abstract only in `Abstract` blocks, and prefer the body over the declaration (§4.9)
   - superclasses from the AST, not the signature text (§4.10)
   - struct-proven receivers emit nothing (§4.3)
   - the shared path helper (§5.2)
   - hoisted constants and renames (§5.4)
6. **`EXTRACTION_VERSION` 28 → 29**, plus a CHANGELOG re-index note (§3.5).
7. **Octave decision** (§4, Octave), and the cheap `.m` detection hardening (§7).
8. **Built-in skip list** (§5.5).
9. **Tests** for every item above and the gaps in §5.7. Then the targeted suites: matlab, extraction, resolution, Objective-C, explore, inventory and guard tests.
10. **Rebuild, re-index the three corpus repos, and re-run the A/B.** Update §2 and the CHANGELOG bullets (§5.8).

Follow-ups after merge: §6.1–6.10.
