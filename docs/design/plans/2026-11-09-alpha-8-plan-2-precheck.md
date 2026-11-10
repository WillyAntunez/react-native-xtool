# Release 0.1.0-alpha.8, plan 2: the app target fails in seconds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report every failure of the app target's own sources (F1–F5) before `xtool-build` starts: a static
resolution of the app's `#import`/`#include` in `doctor --project` and at the start of `build` (B1 pass 1), and a
`precheck` build step after `generate` that plans the package, resolves the includes again with the App target's full
include list (B1 pass 2) and compiles the app's own sources with the manifest's flags (B2), with
`rn-xtool build --skip-precheck` as the exit.

**Architecture:** B1 is TypeScript over files only: `src/project/includeScan.ts` reads a file's directives under a
small preprocessor, and `src/project/appIncludes.ts` resolves them against the app target as `generate` will copy it
(one layout function shared with `copyBareTarget`) and decides between error, `⚠` and `ℹ`. B2 lives in
`src/pipeline/`: `precheckGraph.ts` asks SwiftPM for the generated package's plan and its dependency graph's header
folders, `precheckCommands.ts` turns the flag lists `renderPackageSwift` renders (one flag source in `packageSwift.ts`)
into `clang`/`swiftc` command lines, and `precheck.ts` runs the hops and reports through `precheckReport.ts`. `build`
gains the step and the flag; the build state records whether the precheck ran, and `doctor --report` prints it. A
golden test compares the command lines with the response files Swift Build wrote for the reference apps (R12).

**Tech Stack:** TypeScript ESM (Node 22), vitest, the Swift toolchain's `clang` and `swiftc` (swiftly, on the PATH
`toolEnv()` builds), SwiftPM (`swift package describe`, `show-dependencies`, `dump-package`), the Darwin SDK bundle
`rn-xtool setup` installs.

**Spec:** [`docs/design/specs/2026-11-06-alpha-8-fail-early-design.md`](../specs/2026-11-06-alpha-8-fail-early-design.md)
(decision B, rulings R2, R6, R12, "Design → B. The app target's checks", failure-walk rows 30–55, the anti-goals,
Verification's response-file capture and build-only proofs 1 and 3). Index of all groups:
[`2026-11-06-alpha-8-fail-early.md`](2026-11-06-alpha-8-fail-early.md). Format model, and the interfaces this plan
consumes: [plan 1](2026-11-06-alpha-8-plan-1-podspec-reader.md).

**Branch:** execution continues on `feature/alpha-8-precheck` (cut with `--no-track` from `origin/main` ebd1b83) unless
the owner names another; never track `develop`/`main`; push only with `git push -u origin feature/alpha-8-precheck`,
then check that `@{u}` is `origin/feature/alpha-8-precheck`.

## Global Constraints

- Linux only, no Mac, no Xcode tools. `doctor --project` keeps working without Swift, xtool or a network: B1 is pure
  file-system work (row 38); the compile (B2) runs only in `build`'s `precheck` step.
- The precheck's `clang`, `swiftc` and `swift` are the ones on `toolEnv()`'s PATH (swiftly's `bin` first), the PATH
  `xtool dev build` runs with (`devEnv`, `src/tools/xtool.ts:155`): the toolchain xtool uses. The iPhoneOS SDK is the
  one the Darwin SDK bundle names (`sdkBundle()/swift-sdk.json`, triple `arm64-apple-ios`, `sdkRootPath`).
- This plan does NOT touch `vendor/rn-spm/spm/` or `patches/react-native+0.88.{0,1}.patch`. If a task seems to need
  it, stop and add it to "Open questions for the owner"; plan around it.
- Exact texts (spec): `✖ <file>:<line> imports "AppDelegate.h", which is not in <folders searched>` (row 30; after the
  final review, `which is not among the files the app target lists next to <file>, in the app target's headers or in
  <paths>`);
  `ℹ precheck — <file> imports <module>, which SwiftPM builds: checked by xtool-build` (row 43);
  `⚠ <xcconfig> sets <settings> for the app target; rn-xtool does not read xcconfig files` (row 46);
  `✖ precheck — <file>:<line>: <clang's message>` with clang's include stack, the first ten errors and the log file's
  path (hop 4); `⚠ precheck skipped (--skip-precheck): errors in the app's own sources show in xtool-build` (hop 6).
  The flag is exactly `--skip-precheck`, on `build` (R2); it has no config twin and no `knownLimits.allow` key (the
  spec gives neither).
- Certainty (anti-goal, R6): an error only where the check is certain; a condition B1 cannot evaluate never makes an
  error (row 33); B1 never errors on `@import` (row 35) nor on a generated `-Swift.h` (row 36); pass 2 errors on an
  angle include only when its first path component names no target of the package graph (row 37); a Swift or clang
  module the precheck cannot place skips the file with `ℹ`, never an error (rows 43, 44).
- No fallback without a line naming it: a skipped file, a dropped module map, a stale-cache retry and a skipped
  precheck each print one line.
- Mechanisms over versions: every rule follows a content fact (a spelling, a folder, a module map, a `describe`
  field), never a library name or a React Native version.
- Downloads and builds on the owner's machine need the owner's approval first (the response-file capture is approved
  in principle, R12; still ask before each series); builds go through a delegated session, one at a time, on copies
  of the reference apps in a scratch folder, never the apps themselves; device runs are the owner's. The reference
  apps set `metroPort: 8082` in `rn-xtool.config.json`; the runs here are build-only, so the port plays no part.
- Before every commit: `git add` the task's files, then `npm run scan:private` (must print `scan-private: clean`; read
  its whole output). No absolute home path, Team ID, UDID, e-mail, IP or production-app name in any committed file;
  tests normalise temp roots to `<tmp>`/`<project>`, fixtures use `/home/me`. No bare `` `@word` `` outside code spans in
  any markdown (`tests/mentions.test.ts`): `@import`, `@main` and `@objc` go in code spans.
- Commits: Conventional Commits, English, subject ≤ 50 characters, imperative, no body; one logical change each.
- Every task ends with `npm test` and `npm run lint` green. Tests that need the Darwin SDK and the toolchain's `clang`
  skip with a reason naming `rn-xtool setup` when either is missing, as `tests/devSupport.test.ts:249-253` does.

## Review Focus

1. **A header whose name differs from the import only in case** (`#import "appdelegate.h"`, a project written on a
   Mac, whose file system ignores case): Linux is case-sensitive, so `xtool-build` fails too; the stop must say the
   file exists with other case, not only "not in". Pinned in Task 3 (`it("names a header that differs only in
   case")`).
2. **Files saved on Windows or by odd editors**: CRLF line ends, a UTF-8 BOM, `#  import` with spaces after `#`, a
   directive continued with a trailing backslash. Directives and line numbers must come out as clang sees them.
   Pinned in Task 1 (`it("reads CRLF, a BOM, spaced and continued directives")`).
3. **A project folder or a `HEADER_SEARCH_PATHS` entry with spaces** (`~/My Apps/x`, `"$(SRCROOT)/Vendor Kit"`): every
   path stays one argument (argv, never a shell string) and displays whole. Pinned in Task 8 (`it("keeps a folder
   with spaces one argument")`) and Task 3 (`it("lists a search path with spaces whole")`).
4. **A relative include that leaves the target folder** (`#import "../Shared/Theme.h"` from `ios/App/X.m`): the copy
   lays files out differently from `ios/`, so the include is resolved against the copy, as `xtool-build` sees it.
   Pinned in Task 2 (`it("resolves a relative include against the copy's layout")`).
5. **An app target with no Swift file, or with no C-family file** (the pre-0.77 Objective-C template has no Swift; the
   Swift template has no `.m`): an empty hop must not run its compiler (`swiftc` with no input fails: a false stop).
   Pinned in Task 10 (`it("runs no swiftc for a target without Swift files")`, `it("runs no clang for a Swift-only
   target")`).

## Interfaces later plans consume

- **`tests/fixtures/objc-app/`** (Task 3): an Objective-C app target written from React Native's pre-0.77 template
  (MIT). Plan F2's drift target overlays it on the CLI's project (rows 109–111).
- **`ios-xtool/.precheck/`** (Task 10): `precheck.log`, `inputs.json`, `swift-headers/`, `modulemaps/`,
  `ModuleCache/<key>/`. Plan D's per-command log replaces `precheck.log` as hop 4's "log file" when it lands;
  `build --clean` removes `.precheck/` with `ios-xtool/` on bare, and the step empties its module cache on Expo.
- **`PrecheckError`** (Tasks 7, 9): its message is the stop's summary; plan D appends its log line.
- **`BuildState.precheck`** (`"run" | "skipped"`) and `doctor --report`'s `precheck:` line, printed after plan 1's
  `podspec reader:` lines (Task 11).

---

### Task 1: The include scanner

**Files:**
- Create: `src/project/includeScan.ts`
- Test: `tests/includeScan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ScannedInclude { line: number; spelling: string; angle: boolean; certain: boolean }` — `line` 1-based
    in the original text; `certain` when every enclosing condition is definitely taken.
  - `interface ScanEnv { defines: ReadonlyMap<string, string>; hasInclude(spelling: string, angle: boolean): boolean |
    undefined }` — `undefined`: the pass cannot know.
  - `scanIncludes(text: string, env: ScanEnv): ScannedInclude[]` — `#include`, `#import` (and `#include_next`, always
    uncertain) in taken or unknown branches; `@import`, `#include MACRO` and anything in a false branch are not
    returned (rows 34, 35).
  - `B1_DEFINES: ReadonlyMap<string, string>` — the macros every App compile of Swift Build gets, `SWIFT_PACKAGE=1`
    and `DEBUG=1`, and the iOS values `TARGET_OS_MAC=1`, `TARGET_OS_IPHONE=1`, `TARGET_OS_IOS=1`, `TARGET_OS_OSX=0`,
    `TARGET_OS_MACCATALYST=0`, `TARGET_OS_TV=0`, `TARGET_OS_WATCH=0`, `TARGET_OS_VISION=0`, `TARGET_OS_SIMULATOR=0`;
    no `RCT_NEW_ARCH_ENABLED`, which the generated App target does not define (row 33b). A test keeps it equal to the
    macros `SWIFT_BUILD_DEFINES.clang` and `.importer` share.
  - `definesOf(targetDefines: readonly string[]): Map<string, string>` — `B1_DEFINES` overlaid with the target's
    `KEY`/`KEY=VALUE` (`KEY` alone is `1`).

- [ ] **Step 1: Write the failing tests** (`env` = `{ defines: definesOf([]), hasInclude: () => undefined }` unless
  stated):

  ```ts
  it("returns each include with its line and form", () => {
    expect(scanIncludes(`#import "A.h"\n#include <B/C.h>\n@import Foundation;\n`, env)).toEqual([
      { line: 1, spelling: "A.h", angle: false, certain: true },
      { line: 2, spelling: "B/C.h", angle: true, certain: true },
    ]);
  });
  it("drops includes in comments and under #if 0", () => { /* `// #import "X.h"`, a block comment over two lines with
     an #import inside, `#if 0` … `#endif` → []; the line numbers after the block stay right */ });
  it("follows #ifdef/#elif/#else with the known defines", () => { /* #if DEBUG → taken; #ifdef RCT_NEW_ARCH_ENABLED →
     uncertain (the generated App target does not define it); #if TARGET_OS_OSX
     → not returned; #ifdef DEBUG … #else #import "Rel.h" → only the DEBUG branch; target define FOO=2 and
     `#if FOO == 2` → taken */ });
  it("marks includes under a condition it cannot evaluate as uncertain", () => { /* #ifdef FB_SONARKIT_ENABLED,
     #if __has_include(<X/Y.h>) with hasInclude → undefined, #if SOME_MACRO(1) → certain: false; an #elif after an
     unknown branch → certain: false; `0 && UNKNOWN` → not returned; `1 || UNKNOWN` → certain: true */ });
  it("evaluates __has_include with the resolver", () => { /* codegen's RCTAppDependencyProvider.h shape:
     #if __has_include(<ReactCodegen/RCTModuleProviders.h>) / #import <ReactCodegen/RCTModuleProviders.h> / #elif
     __has_include("RCTModuleProviders.h") / #import "RCTModuleProviders.h" / #endif; hasInclude true for the first →
     only the first, certain; false for both → [] */ });
  it("treats an include guard as taken", () => { /* #ifndef APP_H / #define APP_H / #import "B.h" / #endif → certain;
     a #pragma once file → certain */ });
  it("does not report an include built from a macro", () => { /* #include MY_HEADER → [] */ });
  it("reads CRLF, a BOM, spaced and continued directives", () => { /* "﻿#import \"A.h\"\r\n#  import <B.h>\r\n#if
     defined(DEBUG) && \\\r\n    defined(SWIFT_PACKAGE)\r\n#import \"C.h\"\r\n#endif" → A.h line 1, B.h line 2,
     C.h line 5, all certain */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/includeScan.test.ts`. Expected: FAIL
  (module not found).

- [ ] **Step 3: Implement `src/project/includeScan.ts`.** Decisions the tests leave open: strip the BOM, join
  backslash-continued lines (keeping the first line's number), blank comments and string literals before reading
  directives; a three-valued evaluator (`true | false | undefined`) over integers, known identifiers, `defined X`,
  `defined(X)`, `__has_include(...)`, `! && || == != < > <= >=` and parentheses, where an unknown identifier or a
  function-like macro is `undefined`; a branch stack where an `#elif`/`#else` after an `undefined` branch is at best
  `undefined`. An include guard is the file's first directive `#ifndef X` directly followed by `#define X`.

- [ ] **Step 4: Run them to verify they pass.** Same command. Expected: PASS; `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/project/includeScan.ts tests/includeScan.test.ts
  npm run scan:private
  git commit -m "feat: scan the includes of app sources"
  ```

### Task 2: The copy's layout and the include resolver

**Files:**
- Modify: `src/generate/bareSources.ts` (`copyBareTarget` :46–163: the placement, the `include/` and same-destination
  refusals and the forwards move into `bareCopyLayout`; `copyBareTarget` copies and logs from it)
- Create: `src/project/appIncludes.ts` (the resolver; Task 3 adds pass 1)
- Test: `tests/appIncludes.test.ts`, `tests/generate.test.ts` (the existing copy tests pass unchanged)

**Interfaces:**
- Consumes: `scanIncludes`, `definesOf` (Task 1); `BareTargetContent`, `TargetFile`, `compiledName`.
- Produces:
  - `interface BareCopyLayout { files: { file: TargetFile; dest: string }[]; forwards: Map<string, string>;
    missingHeaders: TargetFile[]; swiftHeaderForward?: string }` — `dest` relative to `Sources/App`; `forwards` maps a
    header's base name to its `dest` (the first one wins, as today); `swiftHeaderForward` is
    `<ProductModuleName>-Swift.h` when `copyBareTarget` writes that forward.
  - `bareCopyLayout(bare: BareTargetContent, iosDir: string, iosTargetDir: string, exists?: (p: string) => boolean):
    BareCopyLayout` — throws the three errors `copyBareTarget` throws today (outside `ios/`, a file landing in
    `include/`, two files to one destination), with the same texts.
  - `CopiedBareTarget.origins: Record<string, string>` (new field): each copied code file's absolute copy path → its
    absolute source path.
  - `interface IncludeScope { files: { path: string; source: string; display: string }[]; exists: (p: string) =>
    boolean; includeDirs: string[]; defines: ReadonlyMap<string, string> }` — `path`: where the file sits in the copy;
    `source`: where its text is read; `display`: how messages name it.
  - `interface ResolvedInclude { file: string; line: number; spelling: string; angle: boolean; certain: boolean;
    found?: string; searched: string[]; generated: boolean }` — `file` is the `display` of the including file.
  - `resolveIncludes(scope: IncludeScope): ResolvedInclude[]` — quote: the including file's copy folder, then
    `includeDirs` in order; angle: `includeDirs` in order; a spelling whose last component ends in `-Swift.h` is
    `generated` and not looked up (row 36). `__has_include` asks the same lookup.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("finds an app header in another folder by name, through the forwards", () => { /* headers at the root of the
     group tree (ios/AppDelegate.h), ios/App/main.m importing "AppDelegate.h" → found at <sources>/include/AppDelegate.h
     (row 31) */ });
  it("finds a quote include next to the including file first", () => { /* ios/App/A.h and an include dir with another
     A.h → the neighbour */ });
  it("resolves a relative include against the copy's layout", () => { /* target folder ios/App; ios/App/X.m imports
     "../Shared/Theme.h"; ios/Shared/Theme.h is in the target, so the copy holds Sources/App/X.m and
     Sources/App/Shared/Theme.h: "../Shared/Theme.h" is not found, "Shared/Theme.h" is */ });
  it("never looks up a generated Swift header", () => { /* "App-Swift.h", "BareDemo-Swift.h", <Foo/Foo-Swift.h> →
     generated: true, no found, searched [] */ });
  it("answers __has_include with the same lookup", () => { /* #if __has_include("Found.h") → its branch taken */ });
  // tests/generate.test.ts
  it("records where each copied file came from", () => { /* copyBareTarget(...).origins maps <sources>/AppMain.m →
     <ios>/App/main.m */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/appIncludes.test.ts tests/generate.test.ts`.
  Expected: FAIL (`bareCopyLayout`, `resolveIncludes` and `origins` not defined).

- [ ] **Step 3: Implement** `bareCopyLayout` by moving the placement code out of `copyBareTarget` unchanged (`exists`
  defaults to `existsSync`; a missing referenced header goes to `missingHeaders`, and `copyBareTarget` logs its
  `ℹ Skipped …` line as today), then `resolveIncludes`, reading each `source` once.

- [ ] **Step 4: Run the tests to verify they pass.** Same command, then `npm test`. Expected: PASS; every existing
  `copyBareTarget` test unchanged.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/generate/bareSources.ts src/project/appIncludes.ts tests/appIncludes.test.ts tests/generate.test.ts
  npm run scan:private
  git commit -m "refactor: share the app copy layout with B1"
  ```

### Task 3: B1 pass 1 and the Objective-C fixture

**Files:**
- Modify: `src/project/appIncludes.ts`
- Create: `tests/fixtures/objc-app/` (`package.json`, `app.json`, `ios/ObjcApp.xcodeproj/project.pbxproj`,
  `ios/ObjcApp/{main.m,AppDelegate.h,AppDelegate.mm,Info.plist}`), `tests/fixtures/pbxproj/objc-root-group.pbxproj`,
  `tests/support/objcApp.ts`
- Test: `tests/appIncludes.test.ts`

**Interfaces:**
- Consumes: Task 2; `dependencyDirs`, `packageDir` (`src/project/podspecs.ts:30,68`).
- Produces:
  - `dependencyHeaderIndex(root: string): Map<string, string[]>` — base name → header paths (`.h`, `.hpp`) under the
    installed `react-native` and each `dependencyDirs(root)` entry, nested `node_modules` and dot folders skipped;
    built lazily, only when a certain quote include is missing.
  - `bareScope(bare: BareTargetContent, iosDir: string, iosTargetDir: string, sources: string, root: string):
    IncludeScope["files"]` — every C-family source, kept header and the bridging header, `path` at its copy place under
    `sources` (from `bareCopyLayout`), `display` relative to the project root (`ios/ObjcApp/main.m`).
  - `interface Pass1Input { root: string; files: IncludeScope["files"]; forwards: Map<string, string>; sources: string;
    headerSearchPaths: string[]; defines: string[]; binaryPods: boolean }`
  - `interface Pass1Result { missing: string[]; pending: number; checked: number }` — `missing` holds row-30 lines
    without `✖ `; `checked` counts the certain includes that resolved.
  - `appIncludesPass1(i: Pass1Input): Pass1Result` — include dirs `[<sources>/include (virtual: the forwards),
    ...headerSearchPaths]`; the copy is virtual (`exists` answers for the layout's places, the disk elsewhere). A
    certain miss: angle → pending; quote → pending when `dependencyHeaderIndex` holds a header whose path ends with
    the spelling or the project has binary pods, else missing. Uncertain misses count nowhere.
  - The row-30 line, the spec's frame with the plan's list: `<display>:<line> imports "<spelling>", which is not in
    <folders searched>`, where `<folders searched>` = the including file's source folder (relative to the project
    root), `the app target's headers`, then each `HEADER_SEARCH_PATHS` entry relative to the project root, joined as
    `a, b or c`; when a file matching the spelling but for case exists where it looked:
    `; <path> differs only in case (file names are case-sensitive on Linux)`.
  - `objcApp(layout: "template" | "root-group"): string` (`tests/support/objcApp.ts`) — copies the fixture into a temp
    project root with an empty `node_modules/react-native/package.json` (`0.88.1`); `root-group` swaps in
    `objc-root-group.pbxproj` and moves the three files next to the `.xcodeproj` (the trial's layout).

- [ ] **Step 1: Write the fixture.** From React Native's pre-0.77 Objective-C template (0.76, MIT; each file keeps the
  template's `This source code is licensed under the MIT license found in the LICENSE file in the root directory of
  this source tree.`): `AppDelegate.h` (`#import <RCTAppDelegate.h>`, `#import <UIKit/UIKit.h>`, `@interface
  AppDelegate : RCTAppDelegate`), `AppDelegate.mm` (`#import "AppDelegate.h"`, `#import
  <React/RCTBundleURLProvider.h>`, `moduleName` `ObjcApp`, `bundleURL` under `#if DEBUG`), `main.m` (`#import
  <UIKit/UIKit.h>`, `#import "AppDelegate.h"`, `UIApplicationMain(…, NSStringFromClass([AppDelegate class]))`). The
  pbxproj: one application target `ObjcApp`, Sources phase `main.m` and `AppDelegate.mm`, `AppDelegate.h` in the
  group, Debug `PRODUCT_BUNDLE_IDENTIFIER = com.example.objcapp`, `INFOPLIST_FILE = ObjcApp/Info.plist`,
  `CLANG_CXX_LANGUAGE_STANDARD = "c++20"`, and a `baseConfigurationReference` to `Pods-ObjcApp.debug.xcconfig`
  (CocoaPods' name, not on disk). `package.json` depends on `react-native` `0.88.1`.

- [ ] **Step 2: Write the failing tests:**

  ```ts
  it("passes the Objective-C template in both layouts", () => { /* objcApp("template"), objcApp("root-group") →
     missing []; pending counts the certain angle includes (<RCTAppDelegate.h>, <UIKit/UIKit.h>,
     <React/RCTBundleURLProvider.h>, per including file) */ });
  it("stops on an app-own quote include that resolves nowhere (F2)", () => { /* root-group layout, AppDelegate.h
     deleted from disk → missing has 'ios/main.m:<n> imports "AppDelegate.h", which is not in ios or the app
     target\'s headers' and the same for ios/AppDelegate.mm */ });
  it("leaves a quote include a dependency provides to the build", () => { /* "RNCAsyncStorage.h" missing in the app;
     node_modules/x/ios/RNCAsyncStorage.h present and x in package.json dependencies → missing [], pending + 1 */ });
  it("leaves quote misses to the build when the project has binary pods", () => { /* binaryPods true → pending */ });
  it("never errors on an uncertain include", () => { /* #ifdef FB_SONARKIT_ENABLED / #import "FlipperKit.h" → nothing */ });
  it("names a header that differs only in case", () => { /* "appdelegate.h" with AppDelegate.h on disk → the line ends
     '; ios/ObjcApp/AppDelegate.h differs only in case (file names are case-sensitive on Linux)' */ });
  it("lists a search path with spaces whole", () => { /* HEADER_SEARCH_PATHS "$(SRCROOT)/Vendor Kit" and a missing
     quote include → the folders list contains 'ios/Vendor Kit' */ });
  ```

- [ ] **Step 3: Run them to verify they fail.** Run: `npx vitest run tests/appIncludes.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** `dependencyHeaderIndex`, `bareScope`, `appIncludesPass1` and `objcApp`. The first test's
  pending number is what the rule above gives on the fixture: fix the number to the rule, never the rule to a number.

- [ ] **Step 5: Run them to verify they pass.** Same command. Expected: PASS; `npm run lint` clean.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/project/appIncludes.ts tests/appIncludes.test.ts tests/support/objcApp.ts tests/fixtures/objc-app \
    tests/fixtures/pbxproj/objc-root-group.pbxproj
  npm run scan:private
  git commit -m "feat: resolve the app's own includes (B1)"
  ```

### Task 4: The app target's shape: xcconfig and synchronized folders

**Files:**
- Modify: `src/project/pbxproj.ts` (`readTargetContent` :332; a new `appXcconfigWarnings`)
- Test: `tests/project/pbxproj.test.ts`

**Interfaces:**
- Consumes: `openPbxproj`, the group walk (`walkGroups` :270).
- Produces:
  - `XCCONFIG_READ_SETTINGS = ["HEADER_SEARCH_PATHS", "GCC_PREPROCESSOR_DEFINITIONS", "CLANG_CXX_LANGUAGE_STANDARD",
    "SWIFT_OBJC_BRIDGING_HEADER", "PRODUCT_MODULE_NAME", "CODE_SIGN_ENTITLEMENTS", "INFOPLIST_FILE"] as const` (the
    spec's list, in its order).
  - `appXcconfigWarnings(p: Pbxproj, root: string): string[]` — for the `baseConfigurationReference` of the app
    target's and the project's Debug configuration whose file name is not `Pods-*.xcconfig`: the settings of
    `XCCONFIG_READ_SETTINGS` it sets (`KEY =` or `KEY[cond] =`, following `#include`/`#include?` relative to the file,
    each file once) → `⚠ <xcconfig relative to root> sets <A, B> for the app target; rn-xtool does not read xcconfig
    files`; a file that cannot be read → `⚠ <xcconfig> (the app target's base configuration) could not be read;
    rn-xtool does not read xcconfig files` (plan's wording). No line for a file that sets none of them (R6).
  - `readTargetContent` throws `DetectError` when the app target has `fileSystemSynchronizedGroups` (row 47, plan's
    wording): `The app target <name> takes its files from the synchronized folder <path> (an Xcode 16 folder group);
    rn-xtool reads only the files a target lists. Convert the folder to a group (Xcode: Convert to Group) so the
    target lists its files`.

- [ ] **Step 1: Write the failing tests** (pbxproj text from `with-objc.pbxproj` and the Task 3 fixture, edited as
  strings in the test):

  ```ts
  it("warns about an xcconfig that sets a setting rn-xtool reads", () => { /* baseConfigurationReference →
     Config/App.xcconfig: "HEADER_SEARCH_PATHS = $(inherited) Vendor\nOTHER_LDFLAGS = -lz\n#include \"Base.xcconfig\"",
     Base.xcconfig: "GCC_PREPROCESSOR_DEFINITIONS[config=Debug] = X=1" → ["⚠ ios/Config/App.xcconfig sets
     HEADER_SEARCH_PATHS, GCC_PREPROCESSOR_DEFINITIONS for the app target; rn-xtool does not read xcconfig files"] */ });
  it("says nothing about CocoaPods' xcconfigs or one that sets nothing rn-xtool reads", () => { /* with-objc.pbxproj
     (Pods-HelloWorld.debug.xcconfig, not on disk) → []; an xcconfig with only OTHER_LDFLAGS → [] */ });
  it("names an xcconfig it cannot read", () => { /* App.xcconfig referenced, missing → the could-not-be-read line */ });
  it("refuses a synchronized folder in the app target", () => { /* a PBXFileSystemSynchronizedRootGroup (path =
     ObjcApp) listed in the target's fileSystemSynchronizedGroups → DetectError naming "ObjcApp" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/project/pbxproj.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The xcconfig's file reference is placed by the same group walk `readTargetContent` uses.

- [ ] **Step 4: Run them to verify they pass.** Same command, then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/project/pbxproj.ts tests/project/pbxproj.test.ts
  npm run scan:private
  git commit -m "feat: name xcconfigs and synchronized folders"
  ```

### Task 5: Pass 1 in `doctor --project` and at the start of `build`

**Files:**
- Modify: `src/project/appIncludes.ts` (`appTargetCheck`, `appTargetLines`); `src/generate/iosXtool.ts`
  (`expoBridgingHeader` :169: its path resolution moves into an exported `expoBridgingHeaderPath`)
- Modify: `src/project/capabilities.ts` (`Capabilities` :239, `detectCapabilities` :347), `src/commands/doctor.ts`
  (`capabilityChecks` :417)
- Modify: `src/commands/build.ts` (`BuildDeps` :150, `realDeps` :234, `build` :366: after `readProject` :407 on bare,
  after the entitlements read :464 on Expo, so after `prebuild`)
- Test: `tests/capabilities.test.ts`, `tests/doctor.test.ts`, `tests/build.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4; `binaryPodCandidates` (`src/project/earlyChecks.ts:728`).
- Produces:
  - `expoBridgingHeaderPath(iosDir: string): string | undefined` — the file `expoBridgingHeader` would copy (undefined
    in each case it returns undefined, the same throws); `expoBridgingHeader` calls it.
  - `interface AppTargetCheck { errors: string[]; warnings: string[]; pending: number; checked: number }`
  - `appTargetCheck(input: { root: string; project: Pick<ProjectInfo, "kind" | "bare" | "iosTargetDir">; binaryPods:
    boolean }): AppTargetCheck` — bare: pass 1 over `bareScope` plus `appXcconfigWarnings`; Expo: pass 1 over the
    bridging header alone (its copy at `Sources/App/<base name>`, no forwards, no search paths) plus
    `appXcconfigWarnings`; Expo without `ios/` → all empty.
  - `appTargetLines(root: string, kind: ProjectKind | undefined, opts: { binaryPods: boolean }): string[]` — for
    doctor: `✖ app-includes — <error>` per error; `⚠ app-target — <warning without "⚠ ">` per warning;
    `ℹ app-includes — <n> includes into React Native's or the libraries' headers: checked at build` when pending > 0
    (row 32, the spec's "checked at build" in the plan's sentence); `✔ app-includes — <checked> includes of the app's
    own sources resolve` without errors. A read that throws gives no line (the `project` line reports it).
  - `Capabilities.appTarget?: string[]` (`detectCapabilities` always sets it); `capabilityChecks` maps each line to a
    check named `app-includes` or `app-target` with the status of its mark, after `patches` and before `known-limits`.
  - `BuildDeps.appTargetCheck: typeof appTargetCheck`. `build` logs each warning, then each error as `✖ <error>`, and
    with errors throws `new Error("<n> include(s) of the app's own sources resolve nowhere (listed above): the build
    would stop compiling them")` (plan's wording). `--skip-precheck` does not skip it (hop 6). Superseded after the
    final review: with `--skip-precheck` the lines are `⚠` and the build goes on, and the stop ends with `; if
    xtool-build builds them, build with rn-xtool build --skip-precheck and report it with rn-xtool doctor --report`.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  // tests/doctor.test.ts
  it("--project reports the app's includes", async () => { /* capabilities.appTarget lines → checks
     { name: "app-includes", status: "fail", detail: 'ios/main.m:9 imports "AppDelegate.h", …' } and
     { name: "app-includes", status: "info", detail: "4 includes into React Native's or the libraries' headers: checked at build" } */ });
  // tests/capabilities.test.ts
  it("reads the app target's includes without a toolchain", async () => { /* objcApp("root-group") with PATH "" →
     appTarget holds the ✔ and ℹ lines; with a non-Pods xcconfig setting HEADER_SEARCH_PATHS → an "⚠ app-target — …" line */ });
  it("gives no app-target line when the project cannot be read", async () => { /* synchronized folder → appTarget [] */ });
  // tests/build.test.ts
  it("stops a bare build on an app-own include before any step", async () => { /* appTargetCheck → { errors: ["…"] } →
     rejects with "1 include(s) of the app's own sources resolve nowhere"; no step in calls; logs has "✖ …" */ });
  it("checks an Expo app's bridging header after prebuild", async () => { /* the check runs after "prebuild" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/doctor.test.ts tests/capabilities.test.ts
  tests/build.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block; the `setup()` fake in `tests/build.test.ts` gets
  `appTargetCheck: () => ({ errors: [], warnings: [], pending: 0, checked: 0 })`.

- [ ] **Step 4: Run them to verify they pass.** Same command, then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/project/appIncludes.ts src/generate/iosXtool.ts src/project/capabilities.ts src/commands/doctor.ts \
    src/commands/build.ts tests/capabilities.test.ts tests/doctor.test.ts tests/build.test.ts
  npm run scan:private
  git commit -m "feat: check the app's includes in doctor and build"
  ```

### Task 6: One flag source for the App target

**Files:**
- Modify: `src/generate/packageSwift.ts` (`expoSwiftSettings` :113, `appSwiftSettings` :130, `importerSwiftSettings`
  :137, `appClangSettings` :150)
- Modify: `src/generate/iosXtool.ts` (`writeIosXtool` :241 returns what it generated; `writeAppSources` :102 passes
  the origins on)
- Test: `tests/generate.test.ts`, `tests/build.test.ts` (its `writeIosXtool` fake)

**Interfaces:**
- Consumes: `CopiedBareTarget.origins` (Task 2).
- Produces:
  - `appIncludeDirs(app: AppTargetInputs, expo?: ExpoPackageInputs): string[]` —
    `[...app.headerSearchPaths, app.swiftHeadersDir, ...(expo?.clangImporter?.includeDirs ?? [])]`, the list
    `appClangSettings` renders. B1 pass 2 and B2 build on it (R6: one include-list function).
  - `appClangArgs(app: AppTargetInputs, expo: ExpoPackageInputs | undefined, cxx: boolean): string[]` — what the
    manifest's `cSettings` (`cxx` false) or `cxxSettings` (`cxx` true) give the compiler: `-D` per define, `-I` per
    `appIncludeDirs` entry, `-fmodule-map-file=` per importer module map, `-F <compileInterfacesDir>` with Expo, and the
    `-std=` of `cxxStandardFlag` for C++; `[]` when `!app.mixed`.
  - `appSwiftArgs(app: AppTargetInputs, expo: ExpoPackageInputs | undefined): string[]` — what `swiftSettings` give a
    Debug build: `-DDEBUG`, Expo's `-DEXPO_CONFIGURATION_DEBUG` and flags, the bridging header's
    `-import-objc-header`/`-Xcc` flags, the importer paths.
  - `renderPackageSwift` renders from these lists; its output is byte-identical to today's.
  - `interface GeneratedApp { pkg: PackageSwiftInput; origins: Record<string, string> }`;
    `writeIosXtool(ctx: GenerateContext): Promise<GeneratedApp>` — `pkg` is the object handed to
    `renderPackageSwift`; `origins` is the bare copy's map, or on Expo the copies of `AppDelegate.swift`,
    `SceneDelegate.swift`, the bridging header and the `ExpoModulesProvider.swift` link → their sources.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("gives the manifest's C and C++ flags as compiler arguments", () => { /* mixed app, defines ["FOO=1","BAR"],
     headerSearchPaths ["/p/include","/p/hsp"], cxxStandard "gnu++20" → appClangArgs(app, undefined, true) equals
     ["-DFOO=1","-DBAR","-I","/p/include","-I","/p/hsp","-I",app.swiftHeadersDir,"-std=gnu++20"]; cxx false → no -std */ });
  it("gives the Swift flags of a Debug build", () => { /* bridging header → contains "-import-objc-header", its path,
     "-Xcc", "-I/p/include"; with expo → "-DEXPO_CONFIGURATION_DEBUG", no RELEASE */ });
  it("returns the package input and the origins it generated", async () => { /* writeIosXtool on the bare fixture →
     result.pkg.app.headerSearchPaths[0] ends with Sources/App/include; origins maps the AppDelegate copy to its source */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/generate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block. `BuildDeps.writeIosXtool` stays `typeof writeIosXtool`; the
  `tests/build.test.ts` fake returns `{ pkg: {}, origins: {} } as never`.

- [ ] **Step 4: Run the tests to verify they pass.** `npm test`. Expected: PASS; the manifest expectations of
  `tests/generate.test.ts` and `tests/fixtures/expo-Package.swift` unchanged.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/generate/packageSwift.ts src/generate/iosXtool.ts tests/generate.test.ts tests/build.test.ts
  npm run scan:private
  git commit -m "refactor: one flag source for the App target"
  ```

### Task 7: The package's plan and its graph's headers

**Files:**
- Create: `src/pipeline/precheckGraph.ts`, `src/pipeline/precheckReport.ts` (only `PrecheckError` here; Task 9 fills it)
- Create: `tests/fixtures/precheck/graph/` (`describe-app.json`, `describe-executable.json`, `show-dependencies.json`,
  `dump-<package>.json` for: a root like the generated manifest, an xcframeworks package with a binary target, a
  generated-code package with a clang target without a module map, an autolinked package, one library with a custom
  `publicHeadersPath` and a Swift target, one package App does not reach), trimmed by hand to SwiftPM's output shape
- Test: `tests/precheckGraph.test.ts`

**Interfaces:**
- Consumes: `readXcframeworkSlices` (`src/pipeline/rnArtifacts.ts`), `devEnv` (`src/tools/xtool.ts:155`).
- Produces:
  - `class PrecheckError extends Error {}` (`src/pipeline/precheckReport.ts`).
  - `type SwiftRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ code: number;
    stdout: string; stderr: string }>` — `swift` from `toolEnv()`'s PATH; a non-zero exit resolves.
  - `planManifest(iosXtool: string, run: SwiftRunner): Promise<void>` — `swift package describe --type json` in
    `iosXtool` with `devEnv(iosXtool)` (row 54). Non-zero → `PrecheckError` `precheck — SwiftPM refused the generated
    package (ios-xtool/Package.swift):` and SwiftPM's `error:` lines; an `App` target of `type` `executable` →
    `PrecheckError` `precheck — SwiftPM plans the App target as an executable target (a file named main); xtool links
    the app's entry point from the App library` (plan's wording).
  - `interface DumpedPackage { name: string; path: string; products: { name: string; targets: string[] }[]; targets:
    { name: string; type: string; path?: string | null; publicHeadersPath?: string | null; dependencies: unknown[]
    }[] }`
  - `readPackageGraph(iosXtool: string, scratch: string, run: SwiftRunner): Promise<{ root: DumpedPackage; packages:
    DumpedPackage[] }>` — `swift package show-dependencies --format json`, then `swift package dump-package
    --package-path <p> --scratch-path <scratch>/<n>` for the root and each local package, at most
    `os.availableParallelism()` at a time, so nothing is written into a library's folder. A failure is a
    `PrecheckError` naming the package and SwiftPM's lines.
  - `interface PrecheckGraph { headerDirs: string[]; moduleMaps: string[]; synthesized: { module: string; text: string
    }[]; targets: string[]; modules: string[] }`
  - `graphHeaders(graph: { root: DumpedPackage; packages: DumpedPackage[] }): PrecheckGraph` — the targets reachable
    from the root's `App` target through product, target and by-name dependencies (a product's package is the one
    whose `name`, or whose lower-cased last path component, equals the reference), in dependency order. A clang target
    gives `<package>/<path ?? "Sources/" + name>/<publicHeadersPath ?? "include">` when that folder exists, with its
    `module.modulemap` there, else a synthesized one by SwiftPM's rule (row 44; the plan's call is synthesis, so the
    Swift template's `AppDelegate.swift` stays checked): `include/<c99name>/<c99name>.h`, else
    `include/<c99name>.h`, as `umbrella header`, else the folder as `umbrella`; text
    `module <c99name> {\n    umbrella header "<abs>"\n    export *\n}\n`. A binary target gives its device slice's
    `Headers` (the slice without a platform variant, as `reactNativeBareIncludeDirs` picks it). `targets` lists every
    target name of every package (row 37); `modules` every module the graph's module maps declare (`module X`,
    `framework module X`) and the synthesized ones.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("plans the package and refuses an executable App target", async () => { /* fake run: describe-executable.json →
     rejects PrecheckError "SwiftPM plans the App target as an executable target"; exit 1 with stderr "error: …" →
     "SwiftPM refused the generated package" and the error line; describe-app.json → resolves */ });
  it("collects the header folders reachable from App", () => { /* fixtures → headerDirs in dependency order with the
     binary slice's Headers; the unreachable package's folders absent */ });
  it("synthesizes a module map as SwiftPM does", () => { /* clang target without module.modulemap, with
     include/<T>/<T>.h → umbrella header text; a target with only include/*.h → `umbrella "<include>"` */ });
  it("lists the graph's targets and modules", () => { /* targets has "ReactCodegen" and "Autolinked"; modules has the
     binary slice's `module React` and the synthesized ones */ });
  it("runs dump-package with a scratch path outside the library", async () => { /* every recorded dump-package call has
     --scratch-path under <scratch> */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/precheckGraph.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `src/pipeline/precheckGraph.ts` and the `PrecheckError` class.

- [ ] **Step 4: Run them to verify they pass.** Same command. Expected: PASS; `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/precheckGraph.ts src/pipeline/precheckReport.ts tests/precheckGraph.test.ts \
    tests/fixtures/precheck/graph
  npm run scan:private
  git commit -m "feat: read the package graph for the precheck"
  ```

### Task 8: The toolchain and the command lines

**Files:**
- Create: `src/pipeline/precheckCommands.ts`
- Test: `tests/precheckCommands.test.ts`

**Interfaces:**
- Consumes: `appIncludeDirs`, `appClangArgs`, `appSwiftArgs`, `GeneratedApp` (Task 6); `PrecheckGraph`,
  `PrecheckError` (Task 7); `sdkBundle()` (`src/commands/setup.ts:158`); `onPath`, `toolEnv` (`src/tools/exec.ts`);
  `IOS_MIN` (`src/versions.ts:14`).
- Produces:
  - `interface PrecheckToolchain { clang: string; swiftc: string; sdk: string; swiftExtra: string[]; versions: string }`
  - `precheckToolchain(env?: NodeJS.ProcessEnv): Promise<PrecheckToolchain>` — `clang` and `swiftc` found on
    `toolEnv()`'s PATH, else `PrecheckError` `precheck — <tool> was not found on the Swift toolchain's PATH; run
    rn-xtool setup`; the SDK from `swift-sdk.json` (`targetTriples["arm64-apple-ios"].sdkRootPath`, under the bundle),
    missing → `PrecheckError` `precheck — the iPhoneOS SDK was not found in the Darwin SDK (<path>); run rn-xtool
    setup --xcode-xip <path>` (row 41, plan's wording); `swiftExtra` = `swiftCompiler.extraCLIOptions` of the toolsets
    `swift-sdk.json` names for that triple, `-use-ld=…` left out; `versions` = `clang --version`, `swiftc --version`
    and `darwin-sdk-version.txt`, joined.
  - `moduleCacheKey(rnVersion: string, versions: string): string` — `rn<rnVersion>-<first 12 hex of
    sha256(versions)>` (row 42).
  - `interface PrecheckInputs { app: GeneratedApp; graph: PrecheckGraph; toolchain: PrecheckToolchain; dir: string;
    moduleCache: string }` — `dir` is `ios-xtool/.precheck`; `moduleCache` is `<dir>/ModuleCache/<key>`.
  - `precheckIncludeDirs(i: PrecheckInputs): string[]` — `appIncludeDirs` with `app.swiftHeadersDir` replaced by
    `<dir>/swift-headers`, then `graph.headerDirs`: B1 pass 2's list and the compile's.
  - `clangArgs(i: PrecheckInputs, file: string): string[]` — `-fsyntax-only`, `-x` by extension (`.m` objective-c,
    `.mm` objective-c++, `.c` c, `.cc`/`.cpp`/`.cxx` c++, a header objective-c), `-target arm64-apple-ios<IOS_MIN>`,
    `-isysroot <sdk>`, `-fobjc-arc` (Objective-C, Objective-C++), `-fmodules`, `-fno-cxx-modules` (C++,
    Objective-C++), `-fmodules-cache-path=<moduleCache>`, `-DDEBUG=1`, `appClangArgs` (its C++ form for C++ and
    Objective-C++) with the swift-headers swap, `-I` per graph folder, `-fmodule-map-file=` per graph and synthesized
    map (written to `<dir>/modulemaps/<module>/module.modulemap`), then `file`. The bridging header of a target without
    C-family sources takes the `-Xcc` values of `appSwiftArgs` in place of `appClangArgs`.
  - `swiftcArgs(i: PrecheckInputs, files: string[]): string[]` — `-typecheck`, `-module-name App`, `-target
    arm64-apple-ios<IOS_MIN>`, `-sdk <sdk>`, `-swift-version 5`, `-module-cache-path <moduleCache>`,
    `-emit-objc-header-path <dir>/swift-headers/App-Swift.h`, `swiftExtra`, `appSwiftArgs`, `-I` and `-Xcc -I` per graph
    folder, `-Xcc -fmodule-map-file=` per graph and synthesized map, then `files`.
  - Every path is one argv element; nothing is joined into a shell string.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("compiles Objective-C++ as Swift Build does", () => { /* clangArgs(.mm) contains "-x","objective-c++",
     "-fobjc-arc","-fmodules","-fno-cxx-modules","-std=c++20","-target","arm64-apple-ios16.4"; clangArgs(.m) has no
     -std and no -fno-cxx-modules (F4, F5) */ });
  it("uses the precheck's Swift header folder", () => { /* "-I", "<dir>/swift-headers" present; app.swiftHeadersDir absent */ });
  it("typechecks Swift with the bridging header and writes App-Swift.h", () => { /* swiftcArgs has
     "-import-objc-header", "-emit-objc-header-path", "<dir>/swift-headers/App-Swift.h", "-module-name", "App" */ });
  it("keeps a folder with spaces one argument", () => { /* header search path "/p/My Apps/inc" is one element */ });
  it("names a missing compiler and a missing SDK", async () => { /* PATH "" → rejects
     "precheck — clang was not found on the Swift toolchain's PATH; run rn-xtool setup"; a temp bundle whose
     swift-sdk.json names a missing sdkRootPath → "the iPhoneOS SDK was not found" */ });
  it("keys the module cache by React Native and the toolchain", () => { /* same inputs → same key; other versions text
     → other key; starts with "rn0.88.1-" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/precheckCommands.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `src/pipeline/precheckCommands.ts`.

- [ ] **Step 4: Run them to verify they pass.** Same command. Expected: PASS; `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/precheckCommands.ts tests/precheckCommands.test.ts
  npm run scan:private
  git commit -m "feat: build the precheck's command lines"
  ```

### Task 9: Reading the compilers' errors

**Files:**
- Modify: `src/pipeline/precheckReport.ts`
- Test: `tests/precheckReport.test.ts`

**Interfaces:**
- Consumes: `PrecheckError` (Task 7).
- Produces:
  - `interface Diagnostic { file: string; line: number; message: string; stack: string[] }` — `stack`: the
    `In file included from <file>:<line>:` lines before it, in order.
  - `parseDiagnostics(output: string): Diagnostic[]` — clang's and swiftc's `<file>:<line>:<col>: error: <msg>` and
    `fatal error:`; warnings, notes and source excerpts dropped (row 51).
  - `precheckErrorLines(diags: Diagnostic[], display: (file: string) => string): string[]` — the first ten as
    `✖ precheck — <display(file)>:<line>: <message>`, each followed by its stack, indented two spaces, `display`
    applied (row 50); then `… and <n> more` when there are more.
  - `precheckStop(count: number, log: string): PrecheckError` — message `precheck: <count> error(s) in the app's own
    sources before xtool-build (the first ten are above; all of them in <log>). If xtool-build compiles these files,
    this is a false stop: build with rn-xtool build --skip-precheck and report it with rn-xtool doctor --report`
    (plan's wording; row 39's stop names `--skip-precheck`).
  - `STALE_MODULE_CACHE = /module file .* is out of date|has been modified since the module file|malformed or corrupted
    AST file/` (row 42).

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("keeps the include stack of an error in a library header (F4)", () => { /* "In file included from
     /p/ios-xtool/Sources/App/AppDelegate.mm:3:\nIn file included from /rn/RCTAppDelegate.h:9:\n
     /rn/react/utils/hash_combine.h:21:3: error: unknown type name 'requires'\n  21 | …\n" → one Diagnostic, stack of two */ });
  it("drops warnings and notes", () => { /* a warning, a note and an error → one */ });
  it("prints the first ten and counts the rest", () => { /* 12 errors → 10 "✖ precheck — " lines and "… and 2 more" */ });
  it("names the copy's source file", () => { /* display maps <sources>/AppMain.m → ios/ObjcApp/main.m */ });
  it("names --skip-precheck in the stop", () => {
    expect(precheckStop(3, "ios-xtool/.precheck/precheck.log").message).toContain("rn-xtool build --skip-precheck");
  });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/precheckReport.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `src/pipeline/precheckReport.ts`.

- [ ] **Step 4: Run them to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/precheckReport.ts tests/precheckReport.test.ts
  npm run scan:private
  git commit -m "feat: report the precheck's compile errors"
  ```

### Task 10: The precheck run: pass 2, Swift, then the C family

**Files:**
- Create: `src/pipeline/precheck.ts`
- Test: `tests/precheck.test.ts`; `tests/precheckToolchain.test.ts` (real `clang`/`swiftc` with the Darwin SDK,
  skipped without them)

**Interfaces:**
- Consumes: Tasks 1, 2, 6–9; `runArgv` (`src/tools/exec.ts:36`, `nice -n 15`).
- Produces:
  - `interface PrecheckOptions { root: string; rnVersion: string; clean: boolean; log: (s: string) => void }`
  - `interface PrecheckDeps { swift: SwiftRunner; compile: (cmd: string, args: string[], opts: { cwd: string; env:
    NodeJS.ProcessEnv }) => Promise<{ code: number; output: string }>; toolchain: () => Promise<PrecheckToolchain> }`
  - `runPrecheck(paths: ProjectPaths, app: GeneratedApp, opts: PrecheckOptions, deps?: Partial<PrecheckDeps>):
    Promise<void>` — in order:
    1. `clean` removes `<dir>/ModuleCache`; any `ModuleCache/<other key>` is removed; `toolchain()`.
    2. `planManifest` (hop 5, first), `readPackageGraph`, `graphHeaders`; the synthesized maps are written; the
       `PrecheckInputs` go to `<dir>/inputs.json`.
    3. B1 pass 2 over the copied code files (`origins`) with `precheckIncludeDirs` and `definesOf(app.pkg.app.defines)`:
       a certain miss of a quote include, or of an angle include whose first path component is not in
       `graph.targets`, is `✖ precheck — <file>:<line> imports <spelling>, which is in none of the App target's <n>
       include folders (listed in <log>)`, and these stop the step (`precheckStop`) before any compile; any other
       certain angle miss is `⚠ precheck — <file>:<line> imports <spelling>, which rn-xtool did not find; <first> is a
       target of the package, so the compile decides` (row 37, plan's wording).
    4. Swift (hop 2): the `import` lines of the copied `.swift` files (`@attr import`, `import struct X.Y` included);
       a module that is neither the SDK's (`<sdk>/System/Library/Frameworks/<M>.framework`,
       `<sdk>/usr/lib/swift/<M>.swiftmodule`) nor in `graph.modules` prints `ℹ precheck — <file> imports <module>,
       which SwiftPM builds: checked by xtool-build`, and the Swift hop is skipped (one module, row 43); otherwise one
       `swiftc` over all Swift files. No Swift file → no `swiftc`. The bridging header of a skipped or Swift-only target
       is compiled by `clang` alone (row 53).
    5. C family (hop 3): `clang` per `.m`/`.mm`/`.c`/`.cc`/`.cpp`/`.cxx`, `os.availableParallelism()` at a time, each
       under `nice`. A file that imports (itself or through the app headers it includes) a `-Swift.h` the precheck did
       not write is not compiled: one `ℹ precheck — <files> import <header>, which the Swift check did not write:
       checked by xtool-build` (row 45). A `-fmodule-map-file` naming a file that does not exist yet (Expo's importer
       maps in Swift Build's folder) is dropped, with one `ℹ precheck — <n> module maps Swift Build writes are not
       there yet: files that need them are checked by xtool-build` (plan's wording).
    6. Output matching `STALE_MODULE_CACHE` removes the cache and runs that hop once more, with `ℹ precheck — the
       module cache was stale (<clang's line>); checked again without it` (row 42).
    7. Errors → `precheckErrorLines` through `opts.log`, then `throw precheckStop(...)`. Every command line and all
       output go to `<dir>/precheck.log` (written anew each run); the terminal gets errors only (row 51).
  - `display`: a copied file is named by its source, relative to the project root; any other path relative to it.

- [ ] **Step 1: Write the failing tests** (`tests/precheck.test.ts`: fakes for `swift`, `compile` and `toolchain`; the
  Task 3 fixture generated into a temp root):

  ```ts
  it("plans, reads the graph, then compiles Swift before the C family", async () => { /* recorded order: describe,
     show-dependencies, dump-package…, swiftc, clang… */ });
  it("stops on F3 in pass 2 before compiling", async () => { /* <RCTAppDelegate.h> in no folder → logs
     "✖ precheck — ios/ObjcApp/AppDelegate.h:<n> imports RCTAppDelegate.h, which is in none of …", rejects
     PrecheckError, no compile call */ });
  it("leaves a miss under a graph target to the compile", async () => { /* <ReactCodegen/X.h> missing, ReactCodegen a
     target → the ⚠ line, the compiles run */ });
  it("skips Swift that imports a module SwiftPM builds", async () => { /* AppDelegate.swift `import Expo` → exactly
     "ℹ precheck — ios/App/AppDelegate.swift imports Expo, which SwiftPM builds: checked by xtool-build", no swiftc;
     an .m importing "App-Swift.h" → the row-45 ℹ line, no clang for it */ });
  it("runs no swiftc for a target without Swift files", async () => { /* Objective-C fixture → no swiftc call */ });
  it("runs no clang for a Swift-only target", async () => { /* Swift template, no bridging header → no clang call */ });
  it("retries once without a stale module cache", async () => { /* first clang output "module file '…' is out of
     date" → cache removed, second run passes, the ℹ line once */ });
  it("prints errors only and names the log", async () => { /* clang output with a warning and two errors → two
     "✖ precheck — " lines and no warning text on the terminal; precheck.log holds the warning */ });
  it("empties the module cache on --clean", async () => { /* clean true → <dir>/ModuleCache gone before toolchain() */ });
  ```

  `tests/precheckToolchain.test.ts`, `describe.skipIf(!HAS_IOS_TOOLS)` with the reason `(needs the Darwin SDK and the
  Swift toolchain's clang: rn-xtool setup)`, real compilers on a tiny target built from SDK headers only:

  ```ts
  it("F4: an Objective-C++ file that needs C++20 fails without the manifest's -std and passes with it", () => { /* a
     header with a `requires` clause, included from a .mm */ });
  it("F5: an @import in a header a .mm includes fails as in Swift Build", () => { /* header with `@import Foundation;`
     → clang's "use of '@import' when C++ modules are disabled" */ });
  it("writes App-Swift.h from swiftc -typecheck", () => { /* one Swift file with an @objc class → the header exists */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/precheck.test.ts
  tests/precheckToolchain.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/pipeline/precheck.ts`. Real deps: execa with `toolEnv()`, `extendEnv: false`,
  `reject: false`, `all: true`; `compile` runs through `runArgv(cmd, args, true)`.

- [ ] **Step 4: Run them to verify they pass.** Same command, then `npm test`. Expected: PASS (the toolchain file runs
  here once `rn-xtool setup` ran, and is listed as skipped in CI).

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/precheck.ts tests/precheck.test.ts tests/precheckToolchain.test.ts
  npm run scan:private
  git commit -m "feat: precheck the app sources before xtool"
  ```

### Task 11: The `precheck` step, `--skip-precheck` and the report line

**Files:**
- Modify: `src/commands/build.ts` (`BUILD_STEP_NAMES` :62, `BuildPlanInput` :73, `plainSteps` :109, `BuildDeps`,
  `realDeps`, `build` :366 and :578–593)
- Modify: `src/cli.ts` (the `build` command :67–75), `src/state.ts` (`BuildState` :6), `src/commands/report.ts`
  (`renderIssueReport` :262, `doctorReport` :315)
- Test: `tests/build.test.ts` (the step lists at :26–99 gain `precheck`), `tests/cli.test.ts`, `tests/report.test.ts`

**Interfaces:**
- Consumes: `runPrecheck`, `PrecheckOptions` (Task 10), `GeneratedApp` (Task 6).
- Produces:
  - `BUILD_STEP_NAMES` gains `"precheck"` between `"generate"` and `"xtool-build"`; `BuildPlanInput.precheck?:
    boolean` (`false` leaves the step out; absent means planned).
  - `build(root, opts: { clean?: boolean; skipPrecheck?: boolean }, overrides)`; `BuildDeps.precheck: (paths:
    ProjectPaths, app: GeneratedApp, opts: PrecheckOptions) => Promise<void>` (real: `runPrecheck`). With
    `skipPrecheck`, `build` logs `⚠ precheck skipped (--skip-precheck): errors in the app's own sources show in
    xtool-build` where the step would run; pass 1 (Task 5) still runs.
  - `rn-xtool build --skip-precheck` (`.option("--skip-precheck", "skip the check of the app's own sources before
    xtool-build")`); `run` calls `build` without it (the spec gives the flag to `build`).
  - `BuildState.precheck?: "run" | "skipped"`, in the state written at `generate`.
  - `precheckReportLine(state: BuildState | undefined): string` (`report.ts`) — `precheck: run (last build)`,
    `precheck: skipped with --skip-precheck (last build)` or `precheck: not recorded`; `renderIssueReport` prints it
    after the podspec lines, from `readState(projectPaths(root).iosXtool)` in a project (unreadable → `not
    recorded`), inside the redacted block (R2).

- [ ] **Step 1: Write the failing tests:**

  ```ts
  // tests/build.test.ts
  it("plans precheck between generate and xtool-build", () => { /* each list ends "generate","precheck","xtool-build";
     precheck: false → no "precheck" */ });
  it("runs the precheck with the generated app and stops before xtool-build", async () => { /* the precheck fake throws
     → calls end with "generate","precheck"; the state has no depsFingerprint and precheck "run" */ });
  it("skips the precheck with --skip-precheck and says so", async () => { /* skipPrecheck → no "precheck" call; logs
     contain exactly "⚠ precheck skipped (--skip-precheck): errors in the app's own sources show in xtool-build";
     state.precheck "skipped"; appTargetCheck still called */ });
  // tests/cli.test.ts
  it("offers --skip-precheck on build only", () => { /* buildProgram().commands: "build" has the option
     "--skip-precheck", "run" does not (the shape of the existing option tests at :39–55) */ });
  // tests/report.test.ts
  it("records whether the last build skipped the precheck", async () => { /* state precheck "skipped" → the report has
     "precheck: skipped with --skip-precheck (last build)" after the podspec reader line; no state → "precheck: not recorded" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/build.test.ts tests/cli.test.ts
  tests/report.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block; `setup()` in `tests/build.test.ts` gets `precheck: rec("precheck")`.

- [ ] **Step 4: Run them to verify they pass.** `npm test`. Expected: PASS; `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/commands/build.ts src/cli.ts src/state.ts src/commands/report.ts tests/build.test.ts tests/cli.test.ts \
    tests/report.test.ts
  npm run scan:private
  git commit -m "feat: add the precheck step and --skip-precheck"
  ```

### Task 12: The user docs and the CHANGELOG

**Files:**
- Modify: `docs/bare-react-native.md` ("Build steps" :192; "What is read from `project.pbxproj`" :202, whose
  "`.xcconfig` files are ignored" gains the `⚠` and the synchronized-folder refusal)
- Modify: `docs/how-it-works.md` ("The build, step by step" :33; "Reference timings" :609 once Task 15 measured)
- Modify: `docs/troubleshooting.md` (a new `### Precheck` under "Build and patches", before `### Podspec reader` :976;
  `app-includes` and `app-target` in "doctor --project" :1424)
- Modify: `CHANGELOG.md` (`## [Unreleased]`, :6)
- Test: `tests/docsLinks.test.ts`, `tests/mentions.test.ts`

**Interfaces:**
- Consumes: the texts of Tasks 3–11.
- Produces: present-tense user text; no code.

- [ ] **Step 1: Write the docs.** bare-react-native and how-it-works: the step list with `precheck`, what pass 1 and
  the precheck check, and that pass 1 runs in `doctor --project` without a toolchain. troubleshooting `### Precheck`:
  each stop and line of Tasks 3–11 with what to do: an app-own include (the file, the folders searched, case on
  Linux); a stop in a library header (the include stack starts at the app's file; the cause is usually the app's
  flags); a false stop (`rn-xtool build --skip-precheck`, after which `rn-xtool run` uses that build, and
  `rn-xtool doctor --report` to report it); the xcconfig line; the synchronized folder; the `ℹ` skips;
  `ios-xtool/.precheck/precheck.log`; `--clean` empties the module cache; the first precheck is slower while clang
  builds React Native's modules (row 49).

- [ ] **Step 2: Write the CHANGELOG entries** under `[Unreleased]`: `### Added` (pass 1 in `doctor --project` and at
  `build` start, the `precheck` step, `--skip-precheck`, the `doctor --report` line, the xcconfig `⚠`), `### Changed`
  (an app target with a synchronized folder is refused; `build` stops seconds after it starts on an app-own include
  that resolves nowhere).

- [ ] **Step 3: Verify.** Run: `npx vitest run tests/docsLinks.test.ts tests/mentions.test.ts`. Expected: PASS; every
  `@import` of the new text in a code span.

- [ ] **Step 4: Commit.**

  ```bash
  git add docs/bare-react-native.md docs/how-it-works.md docs/troubleshooting.md CHANGELOG.md
  npm run scan:private
  git commit -m "docs: describe the app target precheck"
  ```

### Task 13: The response-file capture (R12, the owner's approval first)

**Files:**
- Create: `tests/fixtures/precheck/golden/<ref>/inputs.json` and `tests/fixtures/precheck/golden/<ref>/responses/`,
  `<ref>` in `bare-085`, `bare-086`, `bare-087`, `bare-088`, `objc-088`, `expo-58-bridging`

**Interfaces:**
- Consumes: everything above, built (`npm run build`), run from the branch's `dist/`.
- Produces: what Task 14 reads: Swift Build's response files of the App target's compiles (each C-family file and the
  Swift compile) and the precheck's `inputs.json` of the same build, normalised.

- [ ] **Step 1: Ask the owner** for six builds (minutes and gigabytes each), one at a time, through a delegated
  session, on copies in a scratch folder of `../app-bare-085`, `../app-bare-086`, `../app-bare-087`, `../app-bare`
  (0.88.1), `../app-bare` with `tests/fixtures/objc-app/ios/` laid over its `ios/` (build-only: the JavaScript
  component name is not adjusted), and `../app` (Expo SDK 58) after `expo prebuild`, with `#import
  <React/RCTBridgeModule.h>` added to the prebuild's bridging header so it is passed. The reference apps stay
  untouched.

- [ ] **Step 2: Build each copy.** `rn-xtool build --clean`. A precheck stop on these references is a false stop (row
  55): record its text, then `rn-xtool build --skip-precheck` so Swift Build writes its response files. Copy
  `ios-xtool/.precheck/inputs.json` and the App target's response files (`find ios-xtool/.build -path '*App.build*'
  -name '*.resp'`) into the fixture folder.

- [ ] **Step 3: Normalise.** Home folder → `/home/me`; the copy's root → `/home/me/<ref>`; nothing else. Run
  `npm run scan:private` with the fixtures staged and read its whole output.

- [ ] **Step 4: Commit.**

  ```bash
  git add tests/fixtures/precheck/golden
  npm run scan:private
  git commit -m "test: capture Swift Build's App command lines"
  ```

### Task 14: The golden test of the command lines (row 39)

**Files:**
- Create: `tests/precheckGolden.test.ts`
- Modify: `src/pipeline/precheckCommands.ts`, `src/pipeline/precheckGraph.ts` (only where the golden shows a flag Swift
  Build gives and the precheck does not, or the reverse)

**Interfaces:**
- Consumes: Task 13's fixtures; `clangArgs`, `swiftcArgs`.
- Produces: `compareFlags(ours: string[], theirs: string[]): { missing: string[]; extra: string[] }` (in the test
  file), comparing after normalisation only these flag classes: `-D…`, `-U…`, `-I…`, `-iquote`, `-isystem`, `-F…`,
  `-fmodule-map-file=…`, `-std=…`, `-fobjc-arc`/`-fno-objc-arc`, `-fmodules`, `-fno-cxx-modules`/`-fcxx-modules`,
  `-fmodule-name=…`, `-include`, `-target`, `-isysroot`/`-sdk`, `-x`, `-import-objc-header`, `-Xcc …`,
  `-swift-version`, `-module-name`, `-enable-…` and `-Xfrontend` pairs; every other flag is ignored and listed in the
  test. Normalisation: Swift Build's `GeneratedModuleMaps-iphoneos` and the precheck's `swift-headers` →
  `<swift-headers>`; a module map under `.build` and the precheck's synthesized one → `<modulemap:<module>>`; module
  cache paths dropped.

- [ ] **Step 1: Write the test**: per `<ref>` and response file, `it("<ref>: <file> gets Swift Build's flags")` with
  `expect(compareFlags(ours, theirs)).toEqual({ missing: [], extra: [] })`.

- [ ] **Step 2: Run it.** Run: `npx vitest run tests/precheckGolden.test.ts`. Expected: FAIL wherever the builder
  differs; read each `missing` and `extra`.

- [ ] **Step 3: Fix the builder, not the golden.** Each difference is fixed in `precheckCommands.ts` or
  `precheckGraph.ts`; one that only normalisation explains joins the normalisation with a one-line comment naming the
  response file it came from. A flag that would need `vendor/rn-spm/spm/` changed goes to "Open questions".

- [ ] **Step 4: Run the tests to verify they pass.** `npm test`. Expected: PASS; the false stops Task 13 recorded do
  not happen with the fixed builder on the same `inputs.json`.

- [ ] **Step 5: Commit.**

  ```bash
  git add tests/precheckGolden.test.ts src/pipeline/precheckCommands.ts src/pipeline/precheckGraph.ts
  npm run scan:private
  git commit -m "test: compare the precheck with Swift Build"
  ```

### Task 15: Build-only proofs and the hand-off (the owner's approval first)

**Files:**
- None committed but `CHANGELOG.md` and `docs/how-it-works.md` ("Reference timings") when a result changes their
  text; results go to the task's report.

**Interfaces:**
- Consumes: everything above, built.
- Produces: the evidence the spec's Verification asks of group B (build-only proof 1, B's half of proof 3, row 55).

- [ ] **Step 1: Ask the owner** for the series below, run one build at a time through a delegated session, on scratch
  copies only.

- [ ] **Step 2: Seeded faults** on the Objective-C overlay of Task 13, one per build from a clean copy: F2,
  `AppDelegate.h` deleted → stopped at `build` start by pass 1 with the row-30 line, and the same line in
  `doctor --project`; F3, the bare include dirs dropped in the scratch install's built
  `dist/generate/iosXtool.js` only (`reactNativeBareIncludeDirs` returning `[]`) → stopped by pass 2 naming
  `RCTAppDelegate.h`; F4, `CLANG_CXX_LANGUAGE_STANDARD = "c++17"` → stopped by the precheck in a React Native C++
  header, the include stack starting at `AppDelegate.mm`; F5, `@import Foundation;` in `AppDelegate.h` → stopped by
  the precheck with clang's `@import` error. Record per fault the time from the `generate` line to the report (about
  30 s, Goal 1) and whether the module cache was cold (row 49).

- [ ] **Step 3: The references with no new stop** (row 55): bare 0.85, 0.86, 0.87 and 0.88 (Swift templates), the
  Objective-C overlay, Expo SDK 57 and 58: `rn-xtool build --clean`, then `rn-xtool doctor --project`. Expected: no
  `✖` from pass 1 or the precheck, no `⚠` but those this plan lists, the `precheck` step's time; Expo's
  `AppDelegate.swift` gives the row-43 `ℹ`.

- [ ] **Step 4: Hand the production app to the owner**: built with the branch's `npm pack`; expected: pass 1 and the
  precheck pass on its Objective-C app target with no hand fix, then `xtool-build` as before. He runs it himself and
  reports.

- [ ] **Step 5: Report** each result and time to the owner. No commit unless a text changed.

---

## Deferred

- **Rows 34 (macro includes), 36, 40, 48, 51, 52**: accepted by the spec; nothing to build beyond the lines of Tasks
  1, 2 and 9.
- **Row 49** (a slower first precheck): accepted; measured in Task 15.
- **Reading xcconfig settings and synchronized folders** into the generated project (rows 46, 47): a later block (the
  spec's non-goals); this plan only names them.
- **B1 pass 2's React Native half right after `rn-artifacts`** ("Left to the builder"): not built; pass 2 runs in the
  `precheck` step (the plan's call, minimal).
- **A precompile in `doctor`**: not built; the spec puts B2 in `build`, and `doctor` already fails on `swift` and
  `darwin-sdk` (row 41).
- **Drift watch on Swift Build's flags** (row 40b, after the final review): deferred to a named task in alpha.9, plan
  F2 / drift watch: after a successful `xtool-build`, read the App compile argv from the task store as Task 13 did and
  run `compareFlags` against the precheck's; `⚠` on drift. Rows 49b (memory on a cold cache) and 49c (a full disk) are
  accepted: both stop with a line naming `--skip-precheck`.

## Open questions for the owner

1. **Approvals**: the six capture builds of Task 13 and the proof series of Task 15 (each asked before it runs), and
   the production-app run (yours).
2. **Who creates the Objective-C fixture**: this plan creates `tests/fixtures/objc-app/` (group B's tests and golden
   need it first); plan F2 overlays it for the drift watch. Confirm.
3. **Pass 1's certainty for quote includes**: a missing quote include is an error only when no header of the installed
   `react-native` or of a dependency ends with that spelling and the project has no binary pods (Task 3); otherwise
   it waits for pass 2. The spec says "app-own" without a rule; this is the plan's. Superseded: the app-own rule
   (ledger line 57) and, after the final review, path-matching evidence for spellings with a folder.
4. **`run` has no `--skip-precheck`**: the spec gives it to `build`; after a false stop, `build --skip-precheck` then
   `run` uses that build. Add it to `run` too? Answered: `run` has it (Task 11).
5. **The release**: 0.1.0-alpha.8 shipped with group A; this plan's entries go to `[Unreleased]`. Which version
   carries group B?

## Self-review

- **Spec coverage** (rows 30–55): 30 T3, T5; 31 T2; 32 T3, T5; 33 T1; 34 T1 (comments, `#if 0`; macros Deferred); 35
  T1; 36 T2, Deferred; 37 T6 (one list), T7 (targets), T10; 38 T1–T5 (no toolchain; T5's capability test runs with an
  empty PATH); 39 T8, T9, T11, T13, T14; 40 Deferred; 41 T8; 42 T8, T9, T10; 43 T10; 44 T7, T10; 45 T10; 46 T4, T5;
  47 T4, T5; 48 Deferred; 49 Deferred, T15; 50 T9; 51 T9, T10; 52 Deferred; 53 T5 (pass 1), T10 (the bridging header
  through `clang`), T13 (the Expo 58 golden); 54 T7, T10; 55 T13, T15. R2 T11; R6 T4–T7, T10; R12 T13. The anti-goal:
  Global Constraints' certainty line, T14, T15 Step 3.
- **Spec contradictions planned around**: (a) hop 6 skips "hops 2–5" while hop 5 runs first and pass 2 lives in the
  step: `--skip-precheck` skips the whole `precheck` step; pass 1 still runs (T11). (b) Verification proof 1 seeds F4
  by removing `CLANG_CXX_LANGUAGE_STANDARD`, which today means C++20 and builds: T15 seeds `c++17`, by the trial's
  ruling that an older standard fails as in Xcode. (c) Hop 4 names "the log file's path" before group D's logs exist:
  the precheck keeps `ios-xtool/.precheck/precheck.log` until plan D replaces it. (d) B1's `@import` lookup has no
  effect once row 35 rules that B1 never errors on `@import`: B1 skips `@import`; B2 compiles it.
- **Type consistency**: `GeneratedApp` (T6), `PrecheckError` and `PrecheckGraph` (T7), `PrecheckInputs` (T8),
  `IncludeScope` (T2), `AppTargetCheck` (T5) and `PrecheckOptions` (T10) are each defined once and used under the same
  names in later tasks.
