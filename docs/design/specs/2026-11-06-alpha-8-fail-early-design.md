# Release 0.1.0-alpha.8: fail early, never silently (design)

Status: design, approved by the owner on 2026-11-06, with the rulings below. It follows the real-app trial of
2026-11-05/06: a production bare React Native 0.85.0 app with an Objective-C app target and 20 libraries, built,
installed and launched with 0.1.0-alpha.7 after seven fixes. The decisions below were taken with the owner on
2026-11-06, and the rulings on the questions the draft left open were taken the same day; both are recorded, not
reopened. The trial's ledger is kept outside the repo's tracked files; what this design rests on is restated here with
its sources. Nothing that identifies the app is part of this document.

## Intent

The trial found seven failures. Each one was fixed, and the app now runs on the iPhone. How they showed up is the
problem this release addresses:

| # | Failure | How it showed | What would have caught it |
|---|---|---|---|
| F1 | SwiftPM refused the App library: the Objective-C `main.m` (the pre-0.77 template) makes the App target an executable target | `xtool-build` stopped in SwiftPM's planning, after `rn-spm` and `frameworks` | fixed in alpha.7 (`main.<ext>` compiled as `AppMain.<ext>`, `main.swift` refused early); B2's manifest sub-step generalises it (row 54) |
| F2 | `'AppDelegate.h' file not found` compiling `AppMain.m`: the app's headers sit at the root of the Xcode group tree | compile error inside `xtool-build` | B1, in `doctor --project` and seconds after `build` starts |
| F3 | `'RCTAppDelegate.h' file not found`: the App target saw only the root of React Native's header tree | compile error inside `xtool-build` | B1 pass 2 and B2, before `xtool-build` |
| F4 | C++20 errors in React Native's `hash_combine.h`: the app's Objective-C++ compiled without `-std=` | compile error inside `xtool-build` | B2 |
| F5 | "use of `@import` when modules are disabled" in a pod-header forwarder included by the app's `.mm` | compile error inside `xtool-build` | B2 (it compiles `.mm` with `-fmodules -fno-cxx-modules`, as Swift Build does) |
| F6 | react-native-screens 4.24.0 built without any of `ios/`: the podspec reader read its Ruby locals in part | **a green build**; the app aborted at start (`+[RCTThirdPartyComponentsProvider thirdPartyFabricComponents]`, a nil class) | A (real Ruby reads the podspec as CocoaPods does), C, and alpha.7's codegen class guard |
| F7 | after `install --network`, the iPhone still ran the previous binary | **a green install** (as far as the trial can tell); the old app crashed as before | D2 (a per-build stamp checked on the iPhone) and D3 |

Five failures (F1–F5) were in the app target itself: its manifest, its include paths, its flags. Each fix needed a whole
new build (`rn-spm`, `frameworks`, then `xtool-build` through the libraries) to reach the next error, while every one of
them could have been reported seconds after its inputs existed. Two failures (F6, F7) were silent: a build and an
install that reported success with a broken app. The same day the podspec reader's JavaScript evaluator, written to fix
F6, dropped react-native-worklets' defines (fixed before a device ran it, scaffold revision 7), and a one-off sweep of
the old reader against the new one found two more differences to fix. That is two silent reader bugs in one day, and a
third caught only because someone thought to compare.

This release turns that into one rule, "fail early, never silently", and four mechanisms:

1. **A. A podspec reader that runs real Ruby** with a small shim of CocoaPods and React Native's helpers, so a podspec
   reads as CocoaPods reads it; anything the shim does not model stops loudly.
2. **B. Failing in seconds:** a static resolution of the app target's own `#import`/`#include`, and a compile of the app
   target's own sources with the manifest's flags right before `xtool-build`.
3. **C. Scaffold fidelity:** the files a podspec's globs match against the files the manifest lists, Objective-C classes
   per compiled target, and per target in the packed app.
4. **D. Three reliability pieces:** logs on disk per command, a build stamp verified on the iPhone after every
   install, and a USB retry when Wi‑Fi does not reach the iPhone.

Plus **E**, a one-page guide for automated tools working in a user's project (`AGENTS.md`, `rn-xtool agent-guide`),
**F**, guards on rn-xtool itself (a permanent reader sweep, an Objective-C reference in the drift watch, a mention
check), and **G**, four small follow-ups from the trial.

Owner's rule, as before: mechanisms over versions. Every check follows a content fact (a glob, an include, a symbol, a
plist key), never a library name or a version number.

## Decisions (owner, 2026-11-06)

Release 0.1.0-alpha.8, theme "fail early, never silently". Recorded as decided:

- **A. Podspec reader: real Ruby, shimmed CocoaPods.** The system `ruby` runs each podspec with a shim of rn-xtool's
  (a Ruby file of roughly a hundred lines): `Pod::Spec.new`/`Pod::Specification`, subspecs, platform-scoped attributes,
  `Pod::UI`, `ENV` as a controlled environment (`RCT_NEW_ARCH_ENABLED='1'`, `RCT_HERMES_V1_ENABLED='1'`, every other
  variable unset), and React Native's helpers as no-ops that record what matters. It dumps the evaluated spec as JSON in
  `pod ipc spec`'s model, so the existing consumer is reused. Anything the shim does not model fails loudly with the
  method and the podspec. The JavaScript evaluator stays as the fallback without Ruby, with a fixed `⚠` line. The shim
  is the reader whenever `ruby` exists: rn-xtool no longer runs `pod ipc spec` (ruling R1). `doctor` and `setup`
  report Ruby. A `podspecEnv` config is a possible
  later mechanism, not built now.
- **B. Fail in seconds, both halves.** (1) Static `#import`/`#include` resolution of the app target's own sources
  (Objective-C/C++ and the bridging header; `<X/Y.h>`, `<X.h>` and `"X.h"`; with the include paths the manifest will
  give the App target) in `doctor --project` and at the start of `build`. (2) A `build` step right before
  `xtool-build` that compiles the app target's sources with the generated manifest's flags (`clang -fsyntax-only`,
  `swiftc -typecheck` with the bridging header).
- **C. Scaffold fidelity, "A complete plus weak B".** After scaffolding: podspec globs on disk against the manifest's
  files (a mismatch is an error naming the files). After compiling: a target whose manifest lists `.m`/`.mm` sources
  defines at least one Objective-C class in its object; in the packed app, every target with Objective-C sources
  contributes at least one class to the App binary (an `ℹ` line for a target that legitimately has none).
- **D. Reliability:** logs under `ios-xtool/logs/<command>-<timestamp>.log` (full output, the N most recent kept); a
  per-build stamp in the generated Info.plist, verified by the post-install Lookup (a mismatch is a failure naming both
  stamps); an automatic USB retry, announced in one line, when the Wi‑Fi install does not reach the iPhone after the
  existing four tries.
- **E. The guide:** `AGENTS.md` shipped in the npm package and printed by `rn-xtool agent-guide`, one page; ship
  `docs/` too, or say why not.
- **F. Guards on the project:** the old-vs-new reader sweep as a permanent test over a fixed set of about 30 popular
  React Native library podspecs, their tarballs cached under `tests/.cache`, run in CI; an Objective-C-template
  reference app in the daily drift watch; a markdown, PR-body and release-notes check refusing a bare `@word` outside
  code spans, and the bare `@import`s left in the docs fixed.
- **G. Follow-ups:** silence the per-file `clang: warning: argument unused during compilation:
  '-fmodules-cache-path=…'`; `doctor`'s "N to download" for pods the cache already holds; the `duplicate protocol
  definition of 'RCTDependencyProvider'` warning; a docs line on React Native DevTools' `chrome-sandbox`.
- **Out of scope, deferred to alpha.9:** a scaffold cache in `~/.cache`, parallel scaffolding.

## Rulings (2026-11-06)

The draft left these questions open; they were ruled the same day, and the design and the failure walk below are
written with them.

- **R1. The shim is the only Ruby reader; `pod ipc spec` is dropped** (changes decision A and row 13). The `pod` path
  strips React Native's helpers before it runs (fact 4), so `defined?(install_modules_dependencies())` and
  `respond_to?(:install_modules_dependencies, true)` are false there, and react-native-webview, async-storage, keychain
  and video take their old-architecture branch. The shim models the helpers and gives one result on every machine with
  Ruby. The JavaScript evaluator stays as the fallback without Ruby.
- **R2. An exit for each new stop that can block a working app** (rows 5 and 39). `RN_XTOOL_PODSPEC_READER=reduced`
  forces the reduced reader for one run, and `rn-xtool build --skip-precheck` skips the precheck; each prints a `⚠`
  line naming itself, and `doctor --report` records that it was used. A blocked user with no way out abandons the tool
  before reporting; the report turns each use into a signal for the maintainers.
- **R3. A shim failure is never swallowed** (row 10): it stops `rn-spm` with the shim's text, also when an autolinking
  read hits it. The reader sweep covers every podspec of the Expo SDK 57 and 58 templates and of the reference apps,
  so Expo modules are proven before release.
- **R4. The `ENV` names a podspec read** (row 11) are listed per library in the log and in `doctor --report`, not on the
  terminal; troubleshooting states which two variables are set.
- **R5. Readers recorded and compared** (rows 23 and 29). The scaffold marker records the reader that wrote it, and
  `scaffoldPatchWarnings` warns when a persisted scaffold was written by the other one. One podspec model for every
  rn-xtool reader (the TypeScript early checks and resource reader included) is deferred to alpha.9; the sweep lists
  their disagreements meanwhile.
- **R6. The app target's checks** (rows 37, 46, 47, 54). B1 pass 2 and B2 share one include-list function; a missing
  angle include is an error only when its first path component names no target of the package graph, otherwise a `⚠`
  that leaves the verdict to B2. An xcconfig that is not CocoaPods' generated `Pods-*.xcconfig` and sets a setting
  rn-xtool reads gives a `⚠`; a synchronized folder group in the app target is refused, naming the group.
  `swift package describe --type json` runs in the precheck.
- **R7. Fidelity checks** (rows 57 and 65). A difference in a scaffold applied from `patches/` is a `⚠`, since a hand
  edit is legitimate. A `knownLimits.allow` entry `no-objc-classes:<target>` turns the "no Objective-C class" error
  into a `⚠`. The packed-app check asks for at least one class per target with Objective-C sources, not for each class
  (decision C's weak B).
- **R8. Logs** (rows 75, 78, 79): `start` logs rn-xtool's own lines only; logs are never committed, and `doctor
  --report` adds the last 60 lines of the newest build log through `redact`; no log is written outside a project.
- **R9. The stamp and the install** (rows 82, 86, 96). The device spike runs first and decides the stamp's carrier
  (below). An unverified USB install is a `⚠`. An interrupted `Install` is not retried automatically.
- **R10. What ships, and the mention rule** (rows 103 and 112). The user doc pages ship (listed in E) and RELEASING
  step 4 lists them; `docs/design/`, `docs/research/` and `docs/upstream/` do not. A scoped `@scope/name` passes the
  mention check; the bare user form is refused.
- **R11. The sweep's set** (F1): the 30 most-downloaded React Native libraries with an iOS podspec at their current
  versions, plus the versions that failed in the trial (react-native-screens 4.24.0, react-native-worklets 0.8.1 and
  0.8.3), plus every podspec of the Expo SDK 57 and 58 templates and the reference apps' libraries.
- **R12. Swift Build's response files** for the precheck's golden test (row 39) do not exist as fixtures. They are
  captured from reference builds on the owner's machine, one build at a time (approved by the owner on 2026-11-06),
  and normalised (home folders become `/home/me`) before they enter `tests/fixtures/`.
- **R13. Log retention:** the ten most recent logs per command are kept.

## Goals

1. Every failure the trial met in the app target (F1–F5) is reported before `xtool-build` starts compiling libraries:
   app-own includes in `doctor --project` and seconds after `build` starts; the rest within about 30 s of `generate`.
2. A podspec is read as CocoaPods reads it whenever Ruby is present, and a construct rn-xtool cannot read stops the
   library with the podspec, the line and the name, never a partial read.
3. A build whose libraries lost their sources (F6) stops before install, by the glob comparison and the class checks,
   not only by the codegen guard.
4. An install that did not replace the app on the iPhone (F7) fails, naming the stamp the iPhone has and the one built.
5. Every command leaves its full output on disk, so a failure can be read after the terminal is gone.
6. rn-xtool's own regressions of these kinds are caught in CI (reader sweep), daily (Objective-C drift target) or before
   publishing (mention check).

## Non-goals

- A scaffold cache in `~/.cache` and parallel scaffolding (alpha.9).
- The `podspecEnv` config. ENV variables other than the two stay unset; the design records which ones a podspec read.
- Installing the `cocoapods` gem, or any gem, through `setup`.
- Replacing rn-xtool's TypeScript-side podspec line readers (the early checks in `src/project/earlyChecks.ts`, the
  resource reader in `src/pipeline/scaffoldResources.ts`) with the Ruby reader (row 29: alpha.9).
- Compiling libraries in the precheck. B2 compiles only the app target's own sources.
- Reading xcconfig-based build settings or Xcode 16 synchronized folders into the generated project. This block only
  makes them visible (rows 46 and 47).
- Upstreaming the shim to React Native.

## Anti-goals

- **A check that blocks a working app.** Each new stop is an error only where the check is certain; where it is not,
  it is a `⚠` or an `ℹ`. Every check runs on every reference app and on the production app before release
  (Verification).
- **Silent degradation.** No reader, check or install path falls back without a line that names the fallback.

## Constraints

- Linux only (x86_64 verified; arm64 untested), no Mac anywhere in the loop, no Xcode tools.
- An alpha with real users starting: every behaviour change is named in the CHANGELOG, an "Upgrading" note when a
  user must act (the scaffold revision moves, row 25).
- The scaffolder ships twice and stays byte-identical: `vendor/rn-spm/spm/` and `patches/react-native+0.88.{0,1}.patch`,
  regenerated from the vendored copy by the recipe in `docs/RELEASING.md` ("Scaffolder changes"), never edited as
  text. A new shim file is a new file in both.
- RELEASING's revision rule: a change to what a scaffold writes bumps `RN_XTOOL_SCAFFOLD_REVISION` and
  `SCAFFOLD_REVISION` together (now 7, `vendor/rn-spm/spm/scaffold-package-swift.js:139`,
  `src/pipeline/patches.ts:362`).
- `npm run scan:private` is clean on every commit; no fixture holds a path, name or identifier of the production app.
- `doctor --project` keeps working without Swift, xtool or a network (the drift watch runs it on a runner without
  Swift).
- Downloads and builds on the owner's machine need the owner's approval first; device runs are the owner's.

## Facts

### The trial

1. **The failures and their fixes** are F1–F7 above. F1 is PR #33, F2 PR #34, F3–F6 PR #35 (fixes 27 and 28 of the
   scaffolder, scaffold revisions 5 to 7), all merged into 0.1.0-alpha.7. F7 is open: the install's output was not
   kept, so whether it reported success cannot be checked any more; the old image had the same size and offsets as the
   previous day's crash, the new `.ipa` was 3.8 MB larger, and a USB `rn-xtool install` replaced it.
2. **Timings of the green build** (owner's machine, 2026-11-06): `rn-spm` 578 s with 20 scaffolds, `frameworks` 35 s,
   `xtool-build` 273 s. F2–F5 each stopped inside `xtool-build`; each fix was followed by a full build to reach the next
   error.
3. **Rulings already taken in the trial** that this design keeps: a referenced header missing on disk is skipped with
   `ℹ` (as Xcode); per-file `COMPILER_FLAGS` of the app target are not read; a project whose
   `CLANG_CXX_LANGUAGE_STANDARD` is older than React Native's headers need fails as in Xcode; unknown `ENV` variables
   read as unset; the pod-header forwarder list is pinned per pod version.

### The podspec reader

4. **Its strategy** (`vendor/rn-spm/spm/read-podspec.js`): `readPodspec` (line 2512) tries `runPodIpcSpec` (line 86),
   which writes a copy of the podspec next to it with `install_modules_dependencies(…)` and `use_react_native!(…)`
   commented out (`patchPodspecForPodIpc`, lines 57–84), runs `pod ipc spec` with `RN_POD_ENV` over the process
   environment (line 110; `RN_POD_ENV` at line 230) and parses the line-anchored JSON. On any failure it returns null
   and `regexPodspec` reads the file, after `evaluateRubyLocals` (line 995) ran the Ruby subset of fix 28.
5. **What the JavaScript evaluator refuses and leaves out.** `source_files` and `exclude_files` (`STRICT_FIELDS`, line
   294) and `compiler_flags`, `header_dir`, `header_mappings_dir`, `frameworks`, `libraries` (`WHOLE_FIELDS`, line 305)
   with an unevaluable part are refused (`unresolvedSourcesReason`, line 2478, whose text tells the user to install
   CocoaPods). An unevaluable part of `OTHER_CFLAGS`, `GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS` and
   `SWIFT_ACTIVE_COMPILATION_CONDITIONS` is left out with a `!` warning (lines 321–328); the trial lists
   react-native-worklets' and react-native-vision-camera's values among them. `name`, `module_name` and `version` are
   read as literals only (line 299).
6. **The consumer of the JSON model.** `flattenSubspecs` (line 2011) reads `subspecs`, `default_subspecs`, the
   `dropSubspecs` option (fix 20) and the attributes of each selected layer. It reads no `ios` key. In CocoaPods' JSON
   form an attribute set through `s.ios.` lives under `"ios"`, as in the CDN specs rn-xtool already parses
   (`src/pods/spec.ts:171`). So on the `pod ipc spec` path, react-native-svg's `s.ios.exclude_files` is not applied
   today; the regex path merges `s.ios.*` (fix 6). This was read in code only: there is no CocoaPods on the build
   machine to run `pod ipc spec`.
7. **Who calls the reader.** The scaffolder (`scaffold-package-swift.js:2263` and `:2283`, refusal at `:2294`); the
   autolinking's header search paths for every autolinked library (`generate-spm-autolinking.js:835`, which returns
   `[]` on any throw); name facts (`expand-spm-dependencies.js:310` and `:482`, null on a throw, `readPodspecNames`'
   regex first). `usesInstallModulesDependencies` comes from a regex over the podspec source (`read-podspec.js`, in
   `readPodspec`). Today `readPodspec` throws only for a missing file, so these catches never hid a reader failure; a
   Ruby reader that throws would be hidden by them.
8. **React Native's helpers** are defined in `scripts/react_native_pods.rb` of 0.85.0 and 0.88.1 (read from the cached
   tarballs): `min_ios_version_supported`, `folly_flags`, `resolve_use_frameworks`, `add_dependency`,
   `create_header_search_path_for_frameworks`, `install_modules_dependencies`, `podspec_sources`, `spm_dependency`,
   `get_folly_config` and the other `get_*_config`/`set_*_config`, `rct_cxx_language_standard`; 0.88.1 adds
   `rncore_pod` and `mark_as_react_native_build`. `install_modules_dependencies` appends compiler flags and
   `pod_target_xcconfig` entries and about twenty `s.dependency` lines (`NewArchitectureHelper`,
   `scripts/cocoapods/new_architecture.rb:75`).
9. **What real podspecs call.** A static scan (Ruby's `Ripper`, nothing evaluated) of 35 podspecs: 15 libraries at the
   versions the one-off reader sweep of 2026-11-06 read (among them react-native-vision-camera 4.7.3,
   react-native-video 6.19.3, react-native-worklets 0.8.3, react-native-reanimated 4.3.4), the bare 0.88 reference app's
   libraries, the Expo SDK 57 reference's Expo
   modules and the podspec fixtures in `tests/fixtures/podspecs/`:
   - helpers: `install_modules_dependencies` (16 files), `add_dependency` (react-native-gesture-handler,
     expo-modules-core), `get_folly_config` (Expo's two), `respond_to?(:install_modules_dependencies, true)` (4),
     `defined?(install_modules_dependencies())` (react-native-webview, gesture-handler 2.32.0), `use_expo_modules!`
     under `defined?` (`Expo.podspec`). None of them calls `use_react_native!`, `folly_flags`, `use_frameworks?` or
     `spm_dependency`; `folly_compiler_flags` is a local everywhere;
   - CocoaPods: `Pod::Spec.new`, `Pod::UI.puts`, `Pod::Config.instance.installation_root`, `.project_pods_root` and
     `.project_root`, `instance_variable_get(:@podfile)` (expo-modules-core's worklets adapter);
   - Ruby beyond attributes: `require 'json'`, `require 'colored2'` (`Expo.podspec`, a CocoaPods dependency gem),
     `require_relative` of the library's own `scripts/*.rb` (gesture-handler, react-native-reanimated, svg,
     worklets), `File.read`/`File.join`/`File.exist?`, `Pathname`, `raise`, backticks and `system` running `node`
     (worklets, reanimated, vision-camera, Expo);
   - globals the Podfile may set: `$VCEnableLocation`, `$VCEnableFrameProcessors`, `$RNVideoUseGoogleIMA`,
     `$RNVideoUseVideoCaching`, under `defined?`;
   - `ENV` names: `RCT_NEW_ARCH_ENABLED`, `RCT_HERMES_V1_ENABLED`, `USE_HERMES`, `USE_FRAMEWORKS`, `RNS_GAMMA_ENABLED`,
     `RNS_DEBUG_LOGGING`, `RNS_USE_CXXBRIDGE`, `REACT_NATIVE_PATH`, `IS_WORKLETS_PROFILING`, `IS_REANIMATED_PROFILING`,
     `PROJECT_ROOT`, and `REACT_NATIVE_NODE_MODULES_DIR` in the libraries' scripts;
   - attributes: the usual ones, and `s.ios.exclude_files`, `s.ios.resource_bundles`, `ss.ios.dependency`,
     `s.respond_to?(:visionos)`, `test_spec`, `script_phase`, `prepare_command`, `static_framework`,
     `project_header_files`.
10. **What a library's own Ruby does.** react-native-worklets 0.8.3's `scripts/worklets_utils.rb` finds React Native
    with `` `cd "#{Pod::Config.instance.installation_root}" && node --print "require.resolve(…)"` `` and raises when it
    cannot; it runs `system("node …/validate-react-native-version.js …")`; it reads
    `./src/featureFlags/staticFlags.json` relative to the working directory, which CocoaPods sets to the podspec's
    folder. reanimated's reads the app's `package.json` through `installation_root/..`. These are the values fix 28
    leaves out with `!`.
11. **Ruby on the machine.** The build machine has Ruby 3.3.8. Neither `doctor` nor `setup` mentions Ruby today
    (`src/commands/doctor.ts`, `src/commands/setup.ts`).
12. **The scaffolder's copies** (fact 11 of the [library compatibility design](2026-11-04-library-compat-design.md),
    unchanged): `vendor/rn-spm/` is pristine 0.88.0 plus the 0.88 patch plus `vendor/rn-spm/rn-xtool-edits.patch`;
    `tests/vendor-rn-spm.test.ts`, `tests/patches.test.ts`, `tests/patches-upstream.test.ts` and
    `tests/rn-scaffolder.test.ts` keep them equal. Fixes 1–28 are taken (`docs/upstream/react-native-scaffolder.md`), so
    the reader change is fix 29.

### The app target

13. **What rn-xtool reads from a bare app's Xcode project** (`readTargetContent`, `src/project/pbxproj.ts:332`): the
    Sources phase (Swift, C-family, headers; anything else refused), every header the group tree places under `ios/`
    outside `Pods/`, `build/`, `DerivedData/`, frameworks and Products, the bridging header,
    `GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS`, `CLANG_CXX_LANGUAGE_STANDARD`, `PRODUCT_MODULE_NAME`, and the
    names of `OTHER_CFLAGS`/`OTHER_LDFLAGS`/`OTHER_SWIFT_FLAGS` when set (an `ℹ` line). Settings are read from the
    target's and the project's configurations only: nothing in `src/project/` reads a `baseConfigurationReference`
    (xcconfig) or a synchronized folder group.
14. **How the sources are copied** (`copyBareTarget`, `src/generate/bareSources.ts`): into `ios-xtool/Sources/App`,
    with one forwarding header per app header in `Sources/App/include/` (Xcode's header map), `main.<ext>` as
    `AppMain.<ext>`, and a `<ProductModuleName>-Swift.h` forward to `App-Swift.h` in a mixed target.
15. **The App target's include paths** (`src/generate/iosXtool.ts:108-115`): the copy's `include/` and the project's
    `HEADER_SEARCH_PATHS`, then `reactNativeBareIncludeDirs(ios/build/xcframeworks)` (ReactHeadersTarget's flat
    `include/React`, then each module folder of the device slice of `ReactNativeHeaders.xcframework`) and
    `podHeaderForwardDirs` (each autolinked library's `rn-spm-pod-headers`). The last two exist only after `rn-spm`.
16. **The App target's flags** (`src/generate/packageSwift.ts`): for a mixed target, `cSettings` and `cxxSettings` with
    the defines, `-I` for each include path, the Swift headers dir and Expo's importer paths, and `-std=` for C++ only;
    for Swift, `-import-objc-header` with the same paths as `-Xcc -I`. SwiftPM adds the header directories and module
    maps of the products the App depends on (`ReactHeaders`, `ReactNativeHeaders`, `ReactNativeDependenciesHeaders`,
    `ReactCodegen`, `ReactAppDependencyProvider`, `Autolinked`, `ExpoModulesJSIHeaders`) itself. The trial's response
    files show Swift Build compiling `.mm` with `-fmodules -fno-cxx-modules`, as Xcode does.
17. **Build order** (`src/commands/build.ts:62`): `patches`, `rn-artifacts`, `rn-spm`, `jsi`, `app-config`,
    `frameworks`, `generate`, `xtool-build`; after it the binary-pod post-pack checks and the codegen class guard
    (lines 595–596). `App-Swift.h` exists only once Swift Build ran (`swiftHeadersDir`, `src/paths.ts:59-67`).
18. **`doctor --project`** runs the `node` check, the project read and the capability probe only, so it needs no
    toolchain (`src/commands/doctor.ts:521-551`).

### Checks after the build

19. **The codegen class guard** (`src/pipeline/codegenClasses.ts`, alpha.7) reads the classes
    `RCTThirdPartyComponentsProvider.mm` and `RCTModuleProviders.mm` name and requires each in the App binary or an
    embedded framework (`llvm-nm --defined-only`); a stripped binary gives an `ℹ` line; a missing class removes the
    packed app and its `.ipa`. `install` runs it again on the app xtool builds before installing (`checkedApp`,
    `src/commands/install.ts`).
20. **Where a target's object is.** Swift Build writes and links
    `ios-xtool/.build/out/Products/Debug-iphoneos/<Target>.o` (`EMPTY_TARGETS_DIR`, `src/pods/emptyTargets.ts`). In the
    trial, `RNScreens.o` defined no Objective-C class.
21. **How a scaffold lists its sources** (`scaffold-package-swift.js:1110-1170`, emitted at `:1847-1856`): the podspec's
    `source_files` globs expanded on disk (`expandSpmSourceGlobs`), `exclude_files` applied with `micromatch`, then the
    scaffold's own files filtered out (`Package.swift`, `Package@swift-*.swift`, the prefix header, `include/`, the
    mixed-support and React-headers folders), and `.metal` files excluded off Darwin. The manifest lists the result as
    explicit `sources:` paths.

### Installing

22. **Over Wi‑Fi** (`src/device/wifiInstall.ts`): lockdown session, AFC upload to `/PublicStaging`, installd `Install`,
    then `Lookup` with four `ReturnAttributes` (`CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`,
    `SignerIdentity`, `src/device/installproxy.ts:54`). The result is checked only for the bundle id's presence; the
    version and build are printed, not compared (`src/commands/install.ts`, end of `installNetwork`).
23. **Retries.** `retryWhileUnreachable` makes four tries ten seconds apart and ends with "connect it by USB and run
    `rn-xtool install`" (`src/device/discover.ts:264-283`). An interrupted upload is retried once; an interrupted
    `Install` never (`InstallInterruptedError`).
24. **Over USB**, `install` runs `xtool dev run --usb` (`src/tools/xtool.ts:174`) and does no Lookup of its own.
    `usbmuxConnector` and `LockdownClient` exist and `doctor`'s Wi‑Fi probe already opens a lockdown session over USB
    with them.
25. **The state** (`src/state.ts`) records the fingerprints, the UDIDs and the signed bundle id; `run` skips build and
    install when `depsFingerprint`, `installedFingerprint` and `installedUdid` match (`src/commands/run.ts:61-80`).
26. **Info.plist** is regenerated at every `generate` from the project's template (`transformInfoPlist`,
    `src/plist.ts:78`; `src/generate/iosXtool.ts:276-284`), and xtool packs it (`infoPath: Info.plist` in `xtool.yml`).

### Output

27. **No log file exists.** `devBuild` runs `xtool dev build` with `stdio: "inherit"` (`src/tools/exec.ts:47`), so the
    longest output of a build never passes through rn-xtool; `rn-spm` streams through `streamingRunner`
    (`src/pipeline/rnSpm.ts`). `ios-xtool/.gitignore` holds `*` (`src/generate/iosXtool.ts:327`). `build --clean`
    removes `ios-xtool/` on bare (`src/commands/build.ts:477`).
28. **The noise.** Swift Build passes `-fmodules-cache-path=<ios-xtool>/.build/out/ModuleCache.noindex` to clang on
    compile and link steps where it is not used; earlier build logs of the reference apps hold the warning 209, 106 and
    9 times.
29. **Redaction exists**: `doctor --report` redacts Apple IDs, Team IDs, UDIDs, device names, IPs and home folders
    (`redact`, `src/commands/report.ts`).

### rn-xtool's own guards

30. **The drift watch** never compiles: per supported line it creates a project (`create-expo` or the React Native
    CLI's template, which is Swift since 0.77) and runs `doctor --project`, a dry run of the bundled patches and the
    manifest-rewrite check (`docs/RELEASING.md`, `src/drift/targets.ts`, `src/drift/check.ts`).
31. **CI** (`.github/workflows/ci.yml`) runs on `ubuntu-latest`: `npm ci`, `node scripts/fetch-test-tarballs.mjs`
    (the 15 tarballs of `tests/tarballs.json`, 23.6 MB, into `tests/.cache`), lint, `scan:private`, tests, and the list
    of skipped tests.
32. **Bare mentions in the tracked markdown** (outside fenced blocks and code spans): four `@import` in user form, not
    three: `CHANGELOG.md:47`, `docs/troubleshooting.md:292` and `:918`, and
    `docs/upstream/react-native-scaffolder.md:498`; eleven more user-form ones in
    `docs/design/specs/2026-11-04-library-compat-design.md:44` and `docs/research/` (`@react-navigation`, `@d11`, and
    hunk line numbers written `@54`, `@113`, `@170`, `@844`, `@1099`); and 122 scoped package names (`@scope/name`).
33. **What ships.** `package.json` `files` holds no `docs/` (RELEASING step 4 says so); error texts link to
    `docs/troubleshooting.md` on GitHub (`src/docs.ts`). `docs/` is 1.7 MB, 1.1 MB of it `docs/design/`.

### The follow-ups

34. **doctor's pods line** counts a pod as cached only when the project's lock records it at the resolved version and
    the cache holds `downloads/<sha256>.<ext>` (`src/project/capabilities.ts:471-479` and `:536-537`). Before a
    project's first build there is no lock entry, so the line says "N to download" whatever the cache holds. Whether
    the trial's build then downloaded the ten files again is not recorded.
35. **`RCTDependencyProvider`.** On 0.88.1 the flat `ReactHeadersTarget/include/React/RCTDependencyProvider.h` is a
    redirect to `<React_RCTAppDelegate/RCTDependencyProvider.h>` written by headers-compose (seen in the bare 0.88
    reference app); on 0.86.3 the flat folder holds no such file. The trial's warning came from 0.85.0, whose second
    path was not identified (the ledger names `ReactAppHeaders`/`ReactAppDependencyProvider` and
    `React_RCTAppDelegate`).

## Approaches

Each decision with the alternatives that were weighed. The owner's choice is marked; the others are recorded so they
are not proposed again without new facts.

### A. Reading a podspec

1. **Real Ruby, shimmed CocoaPods (owner's choice).** The system `ruby` evaluates the podspec as CocoaPods does: every
   local, condition, interpolation, `require_relative` helper and `node` call runs for real. The shim models only the
   DSL and React Native's helpers, which are small and stable (facts 8 and 9). Ruby is one `apt install` away on
   Ubuntu; a machine without it keeps today's reader with a `⚠` line. With Ruby, the shim is the only reader:
   `pod ipc spec` is dropped (R1), so a machine with CocoaPods reads a podspec as one without it.
2. *Install the `cocoapods` gem through `setup`.* Rejected: native extensions (`ffi`, the `xcodeproj` gem's
   dependencies) build differently across distros and Ruby versions, `gem install` needs write access to a gem home,
   and `pod ipc spec` still lacks React Native's helpers (fact 4 strips them), which sends four of the libraries
   scanned into their old-architecture branch (R1).
3. *Keep improving the JavaScript evaluator.* Rejected: two silent bugs in one day (F6 and the worklets defines), and
   every new podspec idiom is another subset to write. It stays as the fallback only.

### B. Failing in seconds

1. **Both halves: a static include resolution and a precompile of the app's own sources (owner's choice).** The static
   half runs without a toolchain, so it works in `doctor --project` and in the drift watch, and catches F2 before
   anything changes. The precompile uses the real compiler with the manifest's flags, so it catches what only a
   compiler sees: F4 (the C++ standard) and F5 (`@import` with modules off in Objective-C++).
2. *Only the static half.* Rejected: F4 and F5 are not include problems.
3. *Only the precompile.* Rejected: it needs the toolchain and the generated project, so it cannot run in
   `doctor --project`, and it starts only after `rn-spm`.

### C. Scaffold fidelity

1. **"A complete plus weak B" (owner's choice):** the glob-against-manifest comparison for every file (A complete),
   and a class check per target and per packed app that asks only for "at least one class" (weak B).
2. *Require every `@interface` of a library's public headers in the binary.* Rejected: declarations under `#if`
   (platform, architecture, feature flags) would stop working apps.
3. *Only the codegen class guard of alpha.7.* Rejected: it covers libraries with codegen components and modules only;
   an old-architecture module that lost its sources is not named there.

### D. Reliability

1. **Logs on disk per command, a build stamp verified on the iPhone, and a USB retry (owner's choice).**
2. *Compare `CFBundleShortVersionString`/`CFBundleVersion` after install.* Rejected: the trial's app keeps its version
   and build across builds (they come from the Xcode project), so they cannot tell a new binary from an old one.
3. *Keep the terminal as the only record.* Rejected: F7's output was lost.

### E. The guide

1. **One page, `AGENTS.md`, shipped and printed by a command (owner's choice).** A tool working in a user's project
   reads what rn-xtool generates, what belongs to the user and how to diagnose, without the repository.
2. *Point at the README on GitHub.* Rejected: it describes installing and using rn-xtool, not what may be deleted or
   regenerated in a project, and it is not on the user's disk.

### F. Guards on rn-xtool

1. **A permanent reader sweep in CI, an Objective-C drift target, a mention check (owner's choice).**
2. *Sweep once per release by hand.* Rejected: the one-off sweep of 2026-11-06 found two reader bugs; a permanent one
   finds the next one on the commit that causes it.

## Design

### A. The podspec reader

**Hop by hop, for one podspec:**

1. **Choose the path.** `readPodspec` reads with the shim when a usable `ruby` runs, else with the JavaScript evaluator.
   `pod ipc spec` is no longer run (R1, row 13): `runPodIpcSpec` and `patchPodspecForPodIpc` leave the vendored
   reader, and `unresolvedSourcesReason`'s advice becomes "install Ruby". `RN_XTOOL_PODSPEC_READER=reduced` forces the
   JavaScript evaluator for one run (R2, row 5). "Usable" is decided once per run:
   `ruby` on `PATH`, a version the shim supports (the builder sets the floor from the shim's needs; Ubuntu 22.04's
   archive has 3.0), and `require 'json'` working.
2. **Run Ruby.** One process per podspec: `ruby <shim> <podspec> <out.json>`, with
   - the working directory set to the podspec's folder (CocoaPods evaluates a podspec there; worklets reads
     `./src/featureFlags/staticFlags.json`, fact 10);
   - an environment of `PATH`, `HOME`, `LANG` and the two React Native variables, nothing else: no `RUBYOPT`,
     `BUNDLE_*` or `GEM_*` from the shell, so a project's `Gemfile` or a `bundle exec` shell cannot change the run;
   - a 30 s timeout per podspec, as `pod ipc spec` had.
3. **What the shim models.**
   - `Pod::Spec.new`/`Pod::Specification` with every attribute CocoaPods 1.16 defines (unknown names fail), subspecs
     (nested), `default_subspec(s)`, `test_spec`/`app_spec` (recorded, never merged), platform proxies `s.ios`,
     `s.osx`, `s.tvos`, `s.visionos`, `s.watchos`, and `s.respond_to?` answering as CocoaPods does;
   - `Pod::UI.puts`/`.warn`/`.info` (captured, not printed), `Pod::Config.instance` with `installation_root` and
     `project_root` (the app's `ios/`) and `project_pods_root` (`ios/Pods`, which need not exist), `Pod::Executable`
     only if the sweep finds a caller;
   - React Native's helpers of fact 8 as recorders: `install_modules_dependencies` records the call (the scaffolder's
     React-core marker, today a regex), `add_dependency` records the dependency, `get_folly_config` returns the
     installed React Native's folly values (read from its `scripts/cocoapods/helpers.rb` when that file loads alone,
     else the values the supported lines share), `min_ios_version_supported` returns the value the installed React
     Native defines, and `spm_dependency` records its arguments so the scaffold can refuse the library by name (row 12);
   - `require` of the gems CocoaPods brings and podspecs load (`colored2`) as stubs; `require_relative` of the
     library's own files runs them;
   - `ENV` as podspecs see it: the two variables, every other name unset; each name read is recorded.
   - Everything else is Ruby: `defined?`, backticks, `system`, `File`, `JSON` behave as under CocoaPods. A
     `defined?(name)` of something the shim does not define answers nil, as under CocoaPods without that Podfile.
4. **Fail loudly.** A call to a method or constant the shim does not define, an attribute CocoaPods does not know, a
   `require` that does not load, an exception the podspec raises itself, or the timeout ends the run with a result
   naming the podspec, the line and the name: `<podspec>:<line>: the podspec calls foo(…), which rn-xtool's podspec
   reader does not model`. No fallback to the JavaScript evaluator follows (rows 4–8); only
   `RN_XTOOL_PODSPEC_READER=reduced` selects it, visibly (R2).
5. **Write the model.** The shim writes the spec as CocoaPods' JSON form to `<out.json>`, not to stdout (a podspec's
   own `puts` cannot corrupt it), plus three rn-xtool keys: the `ENV` names read, the helpers called, and whatever
   `Pod::UI` printed.
6. **Consume it.** `flattenSubspecs` reads it as it read `pod ipc spec`'s JSON, with one fix: each layer's `ios`
   attributes are merged over its own (and `osx`, `tvos`, `visionos`, `watchos` are ignored), as CocoaPods does for an
   iOS target (fact 6). `dropSubspecs` (fix 20) applies unchanged. `name`, `module_name` and `version` keep today's
   resolution: `readPodspecNames`' literals first (row 15).
7. **Tell the caller.** Every caller of the reader learns which path read the podspec and why a run failed. The scaffold
   turns a failure into its `status: 'error'` with the reason, as for fix 28's refusals. The autolinking callers
   (fact 7) no longer swallow a reader failure: it stops `rn-spm` with the same text (R3, row 10). The results file
   records the path per library.
8. **Say which reader ran.** When the JavaScript evaluator read any podspec, `build` prints one fixed line at the
   `rn-spm` step: `⚠ Ruby was not found (or <reason>), so rn-xtool read the podspecs with its reduced reader, which
   evaluates a subset of Ruby; install Ruby (sudo apt install ruby) to read them as CocoaPods does. See …`. `doctor`
   prints a `ruby` line (`✔ ruby 3.3.8`, or `⚠ not found — podspecs are read with the reduced reader; sudo apt install
   ruby`), and so does `doctor --project` (it needs no toolchain). `setup` checks Ruby and prints the install command;
   it installs nothing. When `RN_XTOOL_PODSPEC_READER=reduced` is set, the `⚠` line names the variable instead, and
   `doctor --report` says the last build used it. The `ENV` names each podspec read go to the log and to
   `doctor --report` (R4, row 11).
9. **Ship it.** The shim is `scripts/spm/read-podspec-shim.rb` in React Native's tree: a new file in
   `vendor/rn-spm/spm/` and in both 0.88 patches. Scaffolder fix 29 documents it. The scaffolds' output changes
   (fact 6's `ios` merge, the values fix 28 left out), so the scaffold revision moves from 7 to 8, and each scaffold's
   marker records the reader that wrote it; `scaffoldPatchWarnings` warns when a persisted scaffold's reader differs
   from the one this machine uses (R5, row 23).

### B. The app target's checks

**B1, the include resolution.** It reads the app target as `generate` will copy it (fact 13): every C-family source,
every header the copy keeps, and the bridging header. For each file it strips comments, follows `#if`/`#ifdef`/
`#elif`/`#else` with the defines the compile gets: the target's own, the ones Swift Build gives every App compile
(`SWIFT_PACKAGE` and `DEBUG=1`, which a C-family file and the bridging header both get) and the iOS values of
`TARGET_OS_*` that clang predefines; it evaluates `__has_include` with the resolver itself. The App target as rn-xtool
generates it does not define `RCT_NEW_ARCH_ENABLED`, so a condition on it is one B1 cannot evaluate, as is a condition
on any other macro outside that list. Each `#import`/`#include`:

- `"X.h"`: the including file's folder, then the app's headers by name (the forwards of fact 14), then the include
  paths in order;
- `<X/Y.h>` and `<X.h>`: the include paths in order, then the dependency products' header folders (fact 16);
- `@import M;`: a module map on the paths or a target of the package graph named `M`;
- generated names (`App-Swift.h`, `<ProductModuleName>-Swift.h`, any `<M/M-Swift.h>`): not checked; the build makes
  them.

An include is **missing** when it is unconditional (outside every `#if` group except include guards) and resolves
nowhere; one under a condition B1 cannot evaluate is never an error. B1 runs twice:

1. **Pass 1, before anything changes**: in `doctor --project` and at the start of `build`, next to the early checks.
   It knows the app's own files and `HEADER_SEARCH_PATHS`. An app-own quote include that is missing (F2) is an error
   with the file, the line, the header and where rn-xtool looked. An angle include into React Native's or a library's
   headers is "not checked yet" while `ios/build/xcframeworks` and the scaffolds are not staged: one `ℹ` line with the
   count, in doctor only. The same pass checks the app target's shape (R6, rows 46 and 47): an xcconfig the target or
   the project names (`baseConfigurationReference`) that is not CocoaPods' generated `Pods-*.xcconfig` and sets a
   setting rn-xtool reads (`HEADER_SEARCH_PATHS`, `GCC_PREPROCESSOR_DEFINITIONS`, `CLANG_CXX_LANGUAGE_STANDARD`,
   `SWIFT_OBJC_BRIDGING_HEADER`, `PRODUCT_MODULE_NAME`, `CODE_SIGN_ENTITLEMENTS`, `INFOPLIST_FILE`) gives
   `⚠ <xcconfig> sets <settings> for the app target; rn-xtool does not read xcconfig files`; a synchronized folder group
   in the app target is refused, naming the group.
2. **Pass 2, in the precheck step** (below): the include list the manifest has just been given, plus the dependency
   products' header folders, from the one include-list function B2 uses. A missing include is an error (F3) when it is
   a quote include or its first path component names no target of the package graph; otherwise it is a `⚠` and B2
   decides (R6, row 37).

**B2, the precheck.** A new `build` step, `precheck`, after `generate` and before `xtool-build`:

1. **The command lines.** One function builds them from the same inputs `renderPackageSwift` used: the App target's
   defines and `-I` list, `-std=` for C++ and Objective-C++, the dependency products' header folders and the module
   maps already on disk, and what Swift Build passes every App compile (`-target arm64-apple-ios<IOS_MIN>`, the
   iPhoneOS SDK of xtool's Swift SDK bundle, `-fobjc-arc`, `-fmodules`, `-fno-cxx-modules` for C++ and Objective-C++,
   `-DDEBUG=1`, a module cache in `ios-xtool/.precheck/ModuleCache`). A test compares the result with the response
   files Swift Build wrote for the reference apps' App target (row 39). Those files are not fixtures yet: they are
   captured from reference builds on the owner's machine, one build at a time, and normalised (home folders become
   `/home/me`) before they enter `tests/fixtures/` (R12).
2. **Swift first.** `swiftc -typecheck` on the App's Swift files with `-import-objc-header` and the same `-Xcc` paths,
   writing `App-Swift.h` into `ios-xtool/.precheck/` (`-emit-objc-header-path`) for the next hop. When a Swift file
   imports a module SwiftPM builds from Swift (Expo, `ExpoModulesCore`, any Swift library target), the Swift part is
   not checked: one `ℹ` line names the file and the module (row 43).
3. **C-family next.** `clang -fsyntax-only` on each `.m`, `.mm`, `.c`, `.cc`, `.cpp` of the App, in parallel, with
   `nice`. A file that imports `App-Swift.h` is checked only when hop 2 wrote it.
4. **Report.** An error stops the build before `xtool-build`: `✖ precheck — <file>:<line>: <clang's message>` with
   clang's include stack (F4's error is in a React Native header; the cause is the app's flags), the first ten errors,
   and the log file's path. Warnings are not printed: `xtool-build` prints them once.
5. **Manifest planning** (R6, row 54): `swift package describe --type json` in `ios-xtool/`, which plans the package
   without compiling, runs first and reports F1-like refusals (an executable App target, an invalid header layout).
6. **The exit** (R2, row 39): `rn-xtool build --skip-precheck` skips hops 2–5 with
   `⚠ precheck skipped (--skip-precheck): errors in the app's own sources show in xtool-build`, and `doctor --report`
   says the last build skipped it. B1 pass 1 still runs.

Both B1 and B2 run on bare projects and on an Expo project's bridging header ([library
compatibility](2026-11-04-library-compat-design.md), goal 3.6); an Expo project's `AppDelegate.swift` imports `Expo`
and is therefore not prechecked.

### C. Scaffold fidelity

1. **Globs against the manifest**, in `rn-spm` after the scaffold step, for every library whose `Package.swift`
   carries the scaffolder's banner (just scaffolded or applied from `patches/`). The expected set is the podspec's
   selected layers' `source_files` minus `exclude_files`, expanded by Ruby's `Dir.glob` with CocoaPods' flags when Ruby
   is present (the JavaScript expansion otherwise), minus the scaffolder's own exclusions of fact 21, which the
   scaffolder exports as one list. Only compiled extensions are compared (`.m`, `.mm`, `.c`, `.cc`, `.cpp`, `.cxx`,
   `.swift`); headers move into shims and are not. A file the globs match that no target lists, or a listed file the
   globs do not match, is a difference: for a manifest written by this run it is an error naming the library and the
   files; for one applied from `patches/` it is a `⚠` naming the patch (row 57).
2. **Classes per target**, after `xtool-build`: for each scaffolded target whose manifest lists `.m` or `.mm` sources,
   `llvm-nm --defined-only` on `<Target>.o` (fact 20). No `_OBJC_CLASS_$_` symbol while the sources hold a
   non-category `@implementation` is an error naming the target and the files that declare one; no class and no such
   `@implementation` (categories or C functions only) is an `ℹ` line. A `knownLimits.allow` entry
   `no-objc-classes:<target>` turns the error into a `⚠` for a target whose implementations are all under platform
   guards false on iOS (R7, row 65).
3. **Classes per target in the packed app** (weak B, R7): every target with Objective-C sources whose object defines
   classes must contribute at least one of them to the App binary or an embedded framework. A target that contributes
   none is an error (it was not linked); a target hop 2 noted with `ℹ` gets no line here. The failure removes the packed
   app and its `.ipa`, as the codegen guard does. `install` runs hops 2 and 3 again on the app xtool builds before
   installing (`checkedApp`).

### D. Reliability

**D1, logs.** Every project command (`build`, `install`, `run`, `start`, `doctor --project`, `doctor --report`) opens
`ios-xtool/logs/<command>-<UTC timestamp>-<pid>.log` before its first line and writes everything the terminal shows,
without color codes, including every child's output: `xtool dev build` and `xtool dev run` move from inherited stdio to
the tee runner rn-xtool already has (fact 27). The file ends with the exit status, or the signal. The ten most recent
logs per command are kept. `build --clean` keeps `ios-xtool/logs/`. A failure's last line names its log. A log that
cannot be opened gives one `⚠` line and the command goes on. `start` logs rn-xtool's own lines, not Metro's stream
(row 75). Logs are never committed; `doctor --report` adds the last 60 lines of the newest build log through `redact`
(row 78). Commands that run outside a project (`setup`, `auth`, `doctor` without a project) write no log (row 79).

**G1, the noise**, is filtered in the same tee: the exact `clang: warning: argument unused during compilation:
'-fmodules-cache-path=…' [-Wunused-command-line-argument]` line is not shown, still written to the log, and counted in
one line at the end of `xtool-build`.

**D2, the build stamp.**

1. `generate` writes `RNXtoolBuildStamp` (the build's UTC time and 8 random hex characters) into the generated
   Info.plist and `buildStamp` into the state.
2. After `xtool-build`, the packed `App.app/Info.plist` must hold it; after `xtool dev build --ipa`, so must the
   `.ipa`'s, before anything is uploaded (row 87).
3. After the install, a `Lookup` asks for `RNXtoolBuildStamp` too: over Wi‑Fi in the existing session; over USB through
   a new lockdown session over usbmux, after `xtool dev run`.
4. The same stamp: `Installed <id> (build <stamp>) on …`, and `installedStamp` in the state. Another stamp, or none:
   `✖ The iPhone kept the app built at <old stamp>; this build is <new stamp>. installd reported the install as
   complete. Install over USB: rn-xtool install`. A state without `buildStamp` (built by alpha.7) gives `ℹ` and no
   check.
5. `run` counts the app as installed only when `installedStamp` equals `buildStamp` (row 91).

**The device spike comes first** (R9, rows 81 and 82). Before anything else of D2 is built, a bare 0.88.1 build checks
on the iPhone, over Wi‑Fi and over USB, which carrier survives xtool's packing and comes back in `Lookup`, and lists
every attribute `Lookup` returns for a development app. The candidates it tries, in order:

1. `RNXtoolBuildStamp`, rn-xtool's own key (the design above);
2. `CFBundleGetInfoString`, a free-text bundle key iOS does not display;
3. another free-text key from the spike's list of what `Lookup` returns.

rn-xtool writes a candidate other than its own only when the project's Info.plist does not set it, and never touches
`CFBundleVersion` or `CFBundleShortVersionString` (the app's own version checks read them). The first candidate that
survives both hops is the carrier; the D2 rows hold whichever it is.

**D3, the USB retry.** When the four Wi‑Fi tries fail as unreachable (fact 23), `install --network` looks for the same
iPhone (UDID) on USB. Found: `iPhone did not respond over Wi‑Fi after 4 tries; installing over USB instead (it is
connected by USB)`, then the USB install with D2's check. Another iPhone on USB: the Wi‑Fi error, plus a sentence
naming both UDIDs; nothing is installed. None: the Wi‑Fi error as today, plus "and no iPhone is connected by USB".
Any other failure (an interrupted `Install`, a refused pair record, several iPhones) keeps today's handling.

### E. The guide

`AGENTS.md` at the package root, in `files`, printed by `rn-xtool agent-guide` (also `--path` to print where it is).
One page:

- what each step of `build` does and writes (`patches`, `rn-artifacts`, `rn-spm`, `jsi`, `app-config`, `frameworks`,
  `generate`, `precheck`, `xtool-build`, the post-build checks), and what `install`, `run` and `start` do;
- what is regenerable and may be deleted (`ios-xtool/`, `ios/build/`, `~/.cache/rn-xtool/`), what belongs to the user
  and is never deleted or regenerated by a tool (`patches/`, `rn-xtool.config.json`, `rn-xtool-pods.lock.json`, the
  Xcode project), and what is never committed (`ios-xtool/`, `ios/build/`, the logs);
- how to diagnose: `rn-xtool doctor --project`, `rn-xtool doctor --report` (redacted, for an issue), the logs;
- what the marks mean: `✔` done, `⚠` works with a limit the line names, `!` a scaffolder note about one library, `ℹ`
  information, `✖` stopped;
- where the troubleshooting page is.

A test keeps the guide's step list equal to `BUILD_STEP_NAMES` plus `precheck`, and its folder lists equal to the paths
rn-xtool writes. `docs/` ships in part (row 103): the user pages (`docs/README.md`, `troubleshooting.md`,
`how-it-works.md`, `bare-react-native.md`, `libraries.md`, `recipe.md`, `wifi-install.md`), so the guide's links work
offline; not `docs/design/`, `docs/research/` or `docs/upstream/` (1.4 MB of history and upstream proposals). RELEASING
step 4 lists the shipped pages (R10).

### F. Guards on rn-xtool

1. **The reader sweep**, `tests/podspecReaderSweep.test.ts`, over a fixed set pinned in `tests/tarballs.json` (R11):
   - the 30 most-downloaded React Native libraries that ship an iOS podspec, at their current versions. Source: npm's
     downloads API (`api.npmjs.org/downloads/point`), 2026-10-07 to 2026-11-05, read on 2026-11-06; the podspec checked
     in each current tarball's file list (jsDelivr). By downloads: react-native-safe-area-context 5.11.1,
     react-native-screens 4.30.1, react-native-reanimated 4.7.1, react-native-gesture-handler 3.5.0,
     react-native-worklets 0.13.1, react-native-svg 15.16.1, `@react-native-async-storage/async-storage` 3.1.1,
     `@react-native-masked-view/masked-view` 0.3.2, react-native-webview 14.0.1, `@sentry/react-native` 8.34.0,
     `@react-native-community/netinfo` 12.0.1, react-native-keyboard-controller 1.23.0,
     `@react-native-community/datetimepicker` 9.3.0, react-native-get-random-values 2.1.0, react-native-nitro-modules
     0.37.2, react-native-mmkv 4.3.2, `@react-native-firebase/app` 27.1.0, `@shopify/react-native-skia` 2.14.0,
     lottie-react-native 7.5.0, react-native-view-shot 6.2.1, `@react-native-community/slider` 5.2.2,
     react-native-pager-view 10.0.0, react-native-maps 1.29.11, react-native-device-info 15.0.2,
     `@react-native-google-signin/google-signin` 17.0.0, react-native-blob-util 0.25.1, react-native-purchases 11.0.1,
     `@react-native-picker/picker` 2.11.4, `@react-native-clipboard/clipboard` 1.16.3, react-native-permissions 5.6.3.
     `@shopify/flash-list` 2.3.3 and react-native-edge-to-edge 1.8.2 rank among them and ship no podspec, so they are
     not in the set;
   - the versions that failed in the trial: react-native-screens 4.24.0, react-native-worklets 0.8.1 and 0.8.3;
   - every podspec of the Expo SDK 57 and 58 templates (R3), and the reference apps' libraries at the versions they pin
     (the bare 0.85–0.88 and Expo references, and the bare 0.88.1 reference of the library-compatibility proof).

   Each library is unpacked into a temporary project next to a cached `react-native` (their podspecs run `node` against
   it), read by both readers, and compared with a reviewed golden per library: the shim's model, and the fields where
   the reduced reader differs. A change in either reader's output fails until the golden is updated in the same commit.
   The test also lists, per library, where rn-xtool's TypeScript readers disagree with the shim (row 29). On CI the
   Ruby half must run: a missing Ruby fails the job, not skips it; locally it skips with the test's name saying it
   needs Ruby.
2. **The Objective-C drift target**, `bare-0.88/objc` (and per bare line): the CLI's fresh project with its Swift
   app delegate replaced by an Objective-C one in the pre-0.77 layout (`main.m`, `AppDelegate.h`, `AppDelegate.mm` at
   the root of the group tree), from a fixture written for rn-xtool. The watch runs `doctor --project` on it (B1 pass
   1), downloads React Native's headers artifact for the line's newest patch, builds the bare include list
   (`reactNativeBareIncludeDirs`) and runs B1 pass 2 against it. A header the Objective-C template imports that no
   longer resolves makes the line red.
3. **The mention check**, `scripts/check-mentions.mjs <file>…` and a test over every tracked markdown file: outside
   fenced blocks and code spans, a `@` followed by a GitHub user name (`@import`, `@word`) is refused with the file and
   line; a scoped package name (`@scope/name`) passes (row 112). RELEASING runs it on the release notes' file before
   `gh release create --notes-file`, and the PR text is checked before `gh pr create --body-file`; a workflow on
   `pull_request` (`opened`, `edited`, `reopened`, `synchronize`) checks the PR body and fails the run when a mention is
   left. The fifteen user-form mentions of fact 32 become code spans or plain words in the same task.

### G. Follow-ups

1. **The `-fmodules-cache-path` noise**: D1's filter (above).
2. **doctor's "to download"**: a pod counts as cached when the cache holds an archive with the sha256 the lock records
   or, without a lock entry, the sha256 the spec declares, or one a previous resolution of the same URL recorded in the
   cache. The builder first checks whether the build itself downloads again in the same state; if it does, the fix is
   in the `pods` step too.
3. **`duplicate protocol definition of 'RCTDependencyProvider'`**: the builder finds the second path on 0.85.0 (`clang
   -H` on `AppDelegate.mm` of a fresh bare 0.85 project with the Objective-C fixture) and makes the App's include list
   reach the header by one file only, without changing 0.86–0.88's resolution (tests on all four lines' header trees).
4. **DevTools on Linux**: troubleshooting gets a section: React Native DevTools (the `j` key) runs Chromium's
   `chrome-sandbox`, which must be owned by root with mode 4755 on Linux (`sudo chown root:root …/chrome-sandbox &&
   sudo chmod 4755 …/chrome-sandbox`), or DevTools does not open; the rest of Metro works without it.

## Failure walk

The process, end to end. Each piece talks to something outside rn-xtool's own code: a Ruby interpreter running
third-party Ruby and `node`, the compiler and the SDK, Swift Build's object files, the iPhone's installd over Wi‑Fi and
USB, the disk, GitHub's mention parser, npm and the drift watch's runners.

1. **A, reading a podspec:** probe `ruby` once per run; pick the shim or the reduced reader; spawn Ruby in the
   podspec's folder with a fixed environment; the podspec runs (its `require`s, React Native's helpers, `node` calls,
   `ENV`, `Pod::Config`); the shim writes the JSON model; `flattenSubspecs` consumes it; the scaffold and the
   autolinking act on it; `build` says which reader ran; the shim ships in the vendored copy and both 0.88 patches.
2. **B, the app target:** B1 pass 1 in `doctor --project` and at `build` start; `generate`; B1 pass 2 and B2 in the
   `precheck` step (command lines, `swiftc -typecheck`, `clang -fsyntax-only`, report); `xtool-build`.
3. **C, fidelity:** the glob comparison in `rn-spm`; the class check per target object after `xtool-build`; the class
   check per target in the packed app; both again in `install`.
4. **D1 and G1, logs:** open the log; tee every line and every child; filter the `-fmodules-cache-path` noise; close
   with the status; rotate.
5. **D2, the stamp:** `generate` writes it; the packed app and the `.ipa` hold it; installd installs; `Lookup` returns
   it; rn-xtool compares and records; `run` reads it.
6. **D3, the USB retry:** four Wi‑Fi tries fail; usbmux lists the iPhones; the USB install runs with D2's check.
7. **E, the guide:** packed into the npm package; printed by `agent-guide`; read by a tool in a user's project.
8. **F, guards:** the sweep in CI (npm, Ruby, `node`); the drift watch's Objective-C target (the CLI template, the
   fixture, React Native's headers artifact); the mention check (locally, in tests, in a `pull_request` workflow).
9. **G, follow-ups:** doctor's pods line; the include list for `RCTDependencyProvider`; the DevTools docs line.

| # | Hop | Fails how | Who learns | Ruling |
|---|-----|-----------|------------|-----------------|
| 1 | A, Ruby probe | no `ruby` on `PATH` | user: the fixed `⚠` line at `rn-spm` (once per build), doctor's `⚠ ruby — not found …` line, and `setup`'s install command | handle: A.1, A.8; tests with a `PATH` without Ruby |
| 2 | A, Ruby probe | Ruby runs but is unusable: older than the shim's floor, `require 'json'` fails (some distros package it apart), the interpreter crashes | user: the same `⚠` line with the reason (`ruby 2.5.1 is older than <floor>`, `ruby cannot load json`); doctor says the same | handle: the probe runs a one-line script through the shim's own loader; tests with a fake `ruby` per case |
| 3 | A, spawn | the shell's `RUBYOPT`, `BUNDLE_GEMFILE`, `GEM_HOME` (a `bundle exec` shell, the project's `Gemfile` with `cocoapods`) would load other code or fail the start | nobody: the run gets a fixed environment (A.2) | handle: test with `RUBYOPT=-rnonexistent` in the parent environment |
| 4 | A, shim | the podspec calls a method or constant the shim does not define, or sets an attribute CocoaPods does not know | user at `rn-spm`: `<podspec>:<line>: the podspec calls foo(…), which rn-xtool's podspec reader does not model`; a scaffolded library is refused, an autolinking read stops `rn-spm` (row 10) | handle: one test per kind (method, constant, attribute) |
| 5 | A, shim × a working app | the library built with the reduced reader before, and a shim gap now stops it (anti-goal) | user: row 4's stop, whose text says how to report it and how to force the reduced reader | handle (R2): `RN_XTOOL_PODSPEC_READER=reduced` forces the reduced reader for one run; the `⚠` line names the variable and `doctor --report` records that it was used; the sweep (F1) covers the set of R11 before release |
| 6 | A, `require` | a gem the shim does not stub (a CocoaPods plugin, `xcodeproj`) | user: `<podspec>: cannot load such file -- <gem>; rn-xtool's podspec reader stubs only colored2` | handle: `colored2` stubbed (Expo's podspec); test with an unknown gem |
| 7 | A, the podspec raises | worklets and reanimated raise when React Native is not found, when its version check fails, or with the New Architecture off | user: the podspec's own message, prefixed with the podspec's path, as `pod install` shows it | handle: test with worklets 0.8.3's podspec and no `react-native` |
| 8 | A, timeout | a backtick or `system` call hangs (a `node` script waiting, a network call) | user: `<podspec> did not finish in 30 s`; the library is refused | handle: test with a podspec that sleeps |
| 9 | A, `node` calls | the child's `PATH` lacks `node`, or `require.resolve` from `ios/` fails | user: the podspec's raise (row 7) | handle: the child environment keeps `PATH` and `HOME`; test with worklets' utils in a fixture project |
| 10 | A, callers | the autolinking callers catch every throw (fact 7), so a shim failure there would leave a library without its header search paths, silently | user: `rn-spm` stops with the shim's text, also on an Expo module's podspec (`Expo.podspec` requires `colored2`, tests `use_expo_modules!`, calls `get_folly_config`) | handle (R3): the failure propagates; the sweep covers every podspec of the Expo SDK 57 and 58 templates and of the reference apps |
| 11 | A, `ENV` | a podspec reads a variable other than the two (`USE_FRAMEWORKS`, `RNS_GAMMA_ENABLED`, `USE_HERMES`) | nobody at build: unset, as the trial ruled | accept (R4): the names read are listed per library in the log and in `doctor --report`; troubleshooting says, present tense, that rn-xtool reads podspecs with only `RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED` set |
| 12 | A, `spm_dependency` | a podspec declares a SwiftPM dependency through React Native's helper | user: the scaffold refuses the library: `uses spm_dependency(url: …, products: …), which rn-xtool does not map yet` | handle (the refusal); support is deferred to the block whose library needs it |
| 13 | A, `pod` no longer used | a machine with CocoaPods got `pod ipc spec`'s model until alpha.7 (React Native's helpers stripped, so react-native-webview, async-storage, keychain and video took their old-architecture branch); from alpha.8 the shim reads it as on every machine with Ruby | user with CocoaPods: those libraries' scaffolds change, with the revision 8 warning (row 25) | accept (R1): one reader per machine state (Ruby: the shim; no Ruby: the reduced reader with its `⚠`); how-it-works says so in the present tense |
| 14 | A, Podfile globals | `$VCEnableLocation`, `$VCEnableFrameProcessors`, `$RNVideoUse…` are undefined | nobody: the podspec takes its default branch | accept: troubleshooting says, present tense, that podspecs read as with a Podfile that sets no globals (vision-camera's location APIs on, frame processors only when react-native-worklets-core is installed) |
| 15 | A, identity | Ruby evaluates `s.name = package['name']`, so the model's name differs from today's literal reading and targets would be renamed (fix 28 notes react-native-app-auth and react-native-webview) | user: persisted patches and codegen names no longer match | handle: `name`, `module_name`, `version` keep `readPodspecNames`' literals first (A.6); the sweep asserts every target name is unchanged |
| 16 | A, project state | a podspec reads the app's state (reanimated's static feature flags in the app's `package.json`, vision-camera's check for react-native-worklets-core), so a persisted scaffold keeps the state of the day it was written | nobody until the feature misbehaves | accept: troubleshooting says to delete the library's patch after changing its feature flags or installing an optional sibling (as library compatibility row 45) |
| 17 | A, one process per podspec | CocoaPods evaluates every podspec in one process; a podspec that relies on a global another one set reads it unset | nobody | accept: none of the 35 scanned podspecs does (fact 9); the sweep would show a new one |
| 18 | A, side effects | the shim runs a library's Ruby and `node` scripts on the user's machine at scaffold time | nobody | accept: how-it-works says, present tense, that rn-xtool runs a library's podspec as CocoaPods runs it on a Mac, with the same trust as installing the library |
| 19 | A, output | a podspec prints (vision-camera's thanks, `Pod::UI.puts`) | nobody: the model goes to a file; the prints go to the log | handle: test with a podspec that prints braces |
| 20 | A, consume, platforms | `ios`-scoped attributes were ignored on the `pod` path (fact 6), and `osx`/`tvos` ones must stay out | user: react-native-svg's macOS files in sources, or its iOS excludes missing | handle: A.6's merge, tested with svg 15.16.0's podspec on the shim and on the reduced reader |
| 21 | A, consume, keys | a key that changes a CocoaPods build but not the scaffold (`script_phases`, `prepare_command`, `info_plist`, `module_map`) | user: a `!` warning naming the key and the library | handle: the scaffold's warnings list such keys; metadata keys are ignored as today |
| 22 | A, subspecs | nested subspecs, `default_subspecs = :none`, a subspec depending on a sibling subspec, fix 20's dropped subspecs | user: a wrong source set (caught by C1 only against the same model) | handle: tests with the gesture-handler, screens and vision-camera fixtures on the shim |
| 23 | A, two readers in a team | one developer without Ruby persists a scaffold; another, with Ruby, builds with it | the second developer: `⚠ patches/<x> was written by the reduced podspec reader; Ruby is available here: delete it so rn-xtool regenerates it` | handle (R5): the marker records the reader (A.9) and `scaffoldPatchWarnings` warns when the readers differ |
| 24 | A, cost | one Ruby process per podspec, plus the `node` calls some make | user: seconds added to `rn-spm` | accept: the model is memoized per run (`readPodspecCached`); the proof records the time |
| 25 | A, revision | revision 7 → 8: every persisted scaffold gets the "older rn-xtool scaffolder" warning | user: one `⚠` per persisted patch until regenerated | accept: RELEASING's rule; the CHANGELOG's Upgrading section says to delete and rebuild |
| 26 | A, shipping | the shim is missing from an installed React Native 0.88 (patch not applied), or the copies drift apart | user: `⚠ the podspec reader's Ruby shim is missing from <path>; using the reduced reader`; maintainers: the byte tests | handle: the patch adds the file; the "patched RN files carry the patch" test gets fix 29's hunk |
| 27 | A, reduced reader in use | the JavaScript evaluator's known limits remain on a machine without Ruby | user: the fixed `⚠` line on every build | accept: the line is the decision; C and the class checks run whatever the reader |
| 28 | A, model fields | the regex path's internal fields (`__unresolved__`, `__header_dir_scopes__`) are absent from the shim's JSON | nobody: the consumer derives them from the layers | handle: the sweep compares the two models field by field |
| 29 | A, rn-xtool's other readers | the early checks and the resource reader keep their TypeScript line readers, which may disagree with the shim (a dependency under a Ruby condition) | user: an early refusal for a pod the scaffold does not use, or none for one it does | defer to alpha.9, "one podspec model for every reader" (R5); the sweep lists the disagreements meanwhile |
| 30 | B1 pass 1 | an app-own quote include resolves nowhere (F2) | user in `doctor --project` and seconds after `build` starts: `✖ <file>:<line> imports "AppDelegate.h", which is not in <folders searched>` | handle: fixture of the root-group layout |
| 31 | B1, header map | a quote include of an app header that lives in another folder | nobody: resolved by name, as Xcode's header map and the forwards do | handle: test with headers at the root of the group tree and in the app folder |
| 32 | B1 pass 1, before staging | an angle include into React Native's or a library's headers cannot be checked yet | user in doctor: one `ℹ` with the count, "checked at build" | handle |
| 33 | B1, conditions | `__has_include` chains (codegen's `RCTAppDependencyProvider.h` shape), `#ifdef RCT_NEW_ARCH_ENABLED`, `#if TARGET_OS_OSX` | nobody for a branch not taken; a condition B1 cannot evaluate never makes an error | handle: tests per form |
| 33b | B1, defines | a condition on a macro the generated App target does not define (`RCT_NEW_ARCH_ENABLED`) | nobody; the include is uncertain and the compile decides | handle: B1 assumes only the compile's defines (this wave) |
| 34 | B1, text forms | an include in a comment or under `#if 0`; an include built from a macro | nobody | handle (comments, `#if 0`); accept (macro includes are not checked; B2 compiles them) |
| 35 | B1, `@import` | a module B1 cannot place | nobody in B1; B2 compiles it | handle: B1 never errors on `@import` |
| 36 | B1, generated headers | `App-Swift.h`, `<Module>-Swift.h` | nobody | accept: the build generates them; B2's hop 2 writes the App's |
| 37 | B1 pass 2, certainty | an angle include resolves in Swift Build through a folder B1's list lacks (a dependency target's header folder SwiftPM adds), so B1 would stop a working app | user: a `⚠`, and B2's verdict | handle (R6): pass 2 and B2 share one include-list function, tested against Swift Build's response files (row 39); a miss is an error only when its first path component names no target of the package graph, else a `⚠` that leaves the verdict to B2 |
| 38 | B1, where it runs | `doctor --project` and the drift watch have no toolchain | nobody | handle: B1 is TypeScript over files only (fact 18) |
| 39 | B2, command lines | rn-xtool's flags differ from Swift Build's and the precheck stops a file that `xtool-build` compiles | user: a false stop, whose text names `--skip-precheck` | handle: a golden test against the App target's response files of the bare 0.85–0.88 references, the Objective-C fixture and an Expo 58 app with a bridging header, captured on the owner's machine one build at a time and normalised (home folders become `/home/me`) before they enter `tests/fixtures/` (R12); `rn-xtool build --skip-precheck` skips it, printed with `⚠` and recorded in `doctor --report` (R2) |
| 40 | B2, false pass | the flags differ the other way | user at `xtool-build`, as today | accept |
| 41 | B2, toolchain | `clang`, `swiftc` or the iPhoneOS SDK cannot be found | user: a stop naming the tool and `rn-xtool setup` | handle; doctor already fails on `swift` and `darwin-sdk` |
| 42 | B2, module cache | a stale cache after a React Native or toolchain change ("module file out of date") | user: a stop, or nothing after the retry | handle: the cache is keyed by React Native version and toolchain; one retry without it; `--clean` removes it |
| 43 | B2, Swift modules | a Swift file imports a module SwiftPM builds from Swift (Expo, `ExpoModulesCore`) | user: `ℹ precheck — <file> imports <module>, which SwiftPM builds: checked by xtool-build` | accept: an Expo app's `AppDelegate.swift` is never prechecked; handle the line |
| 44 | B2, clang modules | Swift imports a clang target without a module map on disk (`ReactAppDependencyProvider`, `ReactCodegen`; SwiftPM synthesises theirs at build) | nobody: synthesised by SwiftPM's rule into `.precheck/`, or the file skipped with `ℹ` | handle: never an error; the builder picks synthesis or skip |
| 45 | B2, `App-Swift.h` | an Objective-C file imports the App's Swift header and hop 2 did not write it | user: one `ℹ` naming the files not checked | handle |
| 46 | B, target shape: xcconfig | `HEADER_SEARCH_PATHS`, defines, the C++ standard or another setting rn-xtool reads come from an xcconfig (`baseConfigurationReference`); the manifest lacks them, and B mirrors the manifest, so the errors look like rn-xtool's | user: `⚠ <xcconfig> sets HEADER_SEARCH_PATHS, … for the app target; rn-xtool does not read xcconfig files` at doctor and build start | handle (R6): the `⚠` only, and only for an xcconfig that is not CocoaPods' generated `Pods-*.xcconfig` and sets a setting rn-xtool reads; reading xcconfigs is a later block |
| 47 | B, target shape: synchronized folders | an Xcode 16 synchronized folder group holds the app's sources; nothing is in the Sources phase | user: a refusal at doctor and build start naming the group | handle (R6): the refusal; reading such groups is a later block |
| 48 | B, per-file flags | the app target's per-file `COMPILER_FLAGS` (`-fno-objc-arc`) are not read | user at precheck or `xtool-build`, the same way | accept: the trial's ruling; B2 uses the manifest's flags |
| 49 | B2, time | the first precheck builds React Native's clang modules into its cache | user: a slower first build | accept: measured in the proof; parallel and `nice` |
| 50 | B2, location | the error is in a library header (F4: `hash_combine.h`) while the cause is the app's flags | user: clang's include stack, starting at the app's file | handle |
| 51 | B2, warnings | the app's warnings | user at `xtool-build`, once | accept: the precheck prints errors only |
| 52 | B2, beyond syntax | a file passes `-fsyntax-only` and fails at code generation or link | user at `xtool-build`, as today | accept |
| 53 | B, Expo bridging header | the prebuild's bridging header imports something its paths do not reach | user: B1 pass 2 or B2, after prebuild | handle: the Expo 58 bridging-header fixture |
| 54 | B2, manifest planning | the generated manifest is refused by SwiftPM's planning (an executable App target as in F1, an invalid header layout) | user: the precheck's first hop, in seconds | handle (R6): `swift package describe --type json` runs in the precheck |
| 55 | B, anti-goal | a check stops a project that builds today | user: a false stop | handle: Verification runs B on every reference app and on the production app with no stop before release |
| 56 | C1, fresh scaffold | the globs match a compiled file no target lists, or a target lists a file the globs do not match | user at `rn-spm`: `✖ <library>: its podspec's source_files match <files>, which its Package.swift does not compile` (and the converse) | handle |
| 57 | C1, persisted scaffold | a manifest applied from `patches/` differs from the globs: stale, or a deliberate hand edit (a promised feature) | user: `⚠ patches/<x>: <files> …` | handle (R7): a `⚠`, since a hand edit is legitimate |
| 58 | C1, scaffolder exclusions | `.metal` off Darwin, the scaffold's own files, `include/` | nobody: the scaffolder exports the list, and C1 subtracts it | handle: tests with a `.metal` file and a library with real sources under `include/` |
| 59 | C1, glob semantics | `Dir.glob` and `micromatch` differ (`**`, braces, dotfiles, case, symlinks) | user: a false difference, or a missed one | handle: the expected set uses Ruby's `Dir.glob` with CocoaPods' flags when Ruby runs; tests on each form |
| 60 | C1, headers | a header the globs match is not in the manifest | nobody | accept: headers are relocated by design; the compile reports a missing one |
| 61 | C1, scope | self-managed `Package.swift` and Expo modules are not compared | nobody | accept |
| 62 | C1, reduced reader | the expected set comes from the same reduced model, so a reader error like F6's is invisible to C1 | nobody at C1 | accept: row 27's `⚠` says the reduced reader ran; C2, C3 and the codegen guard still run |
| 63 | C2, object | `<Target>.o` is missing or unreadable | user: `ℹ classes of <target> not checked: <reason>` | handle |
| 64 | C2, no class | a target lists `.m`/`.mm` sources with a non-category `@implementation` and its object defines no class | user: `✖ <target> compiled <n> Objective-C files and defines no class: <files>`; the app is removed | handle |
| 65 | C2, legitimate none | every `@implementation` sits under a platform guard false on iOS (macOS-only code), so the error of row 64 would stop a working app | user: the error, naming the target and the `knownLimits.allow` key | handle (R7): `knownLimits.allow` entry `no-objc-classes:<target>` turns the error into a `⚠` |
| 66 | C2, Swift | a mixed target's classes are Swift (`_TtC…`, `@objc` names) | nobody: they count | handle |
| 67 | C3, not linked | a target with Objective-C sources defines classes in its object and none of them reaches the App binary or a framework | user: `✖ <target>'s classes are not in the app: it was not linked`; app and `.ipa` removed | handle: at least one class per target (weak B, R7) |
| 68 | C3, frameworks | a self-managed dynamic product holds the classes | nobody: `Frameworks/*` count | handle |
| 69 | C3, symbols | a stripped binary, or `llvm-nm` missing | user: `ℹ` (as the codegen guard), or doctor's `llvm-nm` failure | accept |
| 70 | C, install | `install` rebuilds from `.build` | user: the same checks before installing | handle: `checkedApp` runs C2 and C3 |
| 71 | D1, open | `ios-xtool/logs/` cannot be written (permissions, disk full) | user: one `⚠ Could not write the log (<reason>); the command goes on` | handle |
| 72 | D1, clean | `build --clean` removes `ios-xtool/`, the running log with it | nobody | handle: `logs/` is kept; test |
| 73 | D1, children | a child with inherited stdio (`xtool dev build`, `xtool dev run`) bypasses the log; with a pipe, xtool loses its terminal | user: an incomplete log | handle: every runner tees (test over the runners); accept that xtool's output is no longer colored |
| 74 | D1, crash or Ctrl-C | the log ends mid-line | nobody | handle: lines are written synchronously; the signal is written last |
| 75 | D1, `start` | Metro runs for hours | nobody: no large file | handle (R8): `start` logs rn-xtool's own lines only, not Metro's stream |
| 76 | D1, concurrency | `build` and `start` at once | nobody: one file each (pid in the name) | handle |
| 77 | D1, rotation | the ten most recent per command are kept | user: an older log is gone | accept: present tense in troubleshooting; the owner may change N |
| 78 | D1, privacy | logs hold the Apple ID, UDIDs, IPs, paths | user, if they paste one | accept (R8): the logs are never committed (`ios-xtool/.gitignore`); the guide and troubleshooting say to share `doctor --report`, which adds the last 60 lines of the newest build log through `redact` |
| 79 | D1, commands outside a project | `setup`, `auth`, `doctor` without a project | nobody: no log | accept (R8): troubleshooting says, present tense, that only project commands write logs |
| 80 | G1, the filter | it hides a line that matters | nobody on the terminal; the log holds it | handle: only the exact text; one count line at the end of `xtool-build` |
| 81 | D2, packing | xtool drops or rewrites the carrier key | rn-xtool: the packed-app check fails every build | handle (R9): the device spike runs first and picks a carrier that survives packing; test on the packed app |
| 82 | D2, Lookup | installd does not return the carrier key in `Lookup` | rn-xtool: no install could be verified | handle (R9): the spike tries `RNXtoolBuildStamp`, then `CFBundleGetInfoString`, then another free-text key from its list of what `Lookup` returns, and the first that survives packing and `Lookup` is the carrier |
| 83 | D2, mismatch | installd reports Complete and the iPhone keeps the old build (F7) | user: `✖ The iPhone kept the app built at <old>; this build is <new> …` | handle: tests with a fake installd |
| 84 | D2, Lookup fails | the Lookup itself fails | user: today's `VerifyFailedError` | accept |
| 85 | D2, not installed | the bundle id is not on the iPhone after Complete | user: today's error | accept |
| 86 | D2, USB Lookup | usbmuxd or the pair record cannot be read after `xtool dev run` | user: `⚠ installed over USB, not verified: <reason>` | handle (R9): a `⚠`, since xtool reported success |
| 87 | D2, stale `.ipa` | `xtool dev build --ipa` reports a path to an older `.ipa` | user: a stop before the upload, naming both stamps | handle |
| 88 | D2, same build again | `install` twice | nobody: the same stamp passes | accept |
| 89 | D2, every build differs | the Info.plist changes on every `generate`, so xtool repacks and re-signs | nobody | accept: no source is recompiled for it |
| 90 | D2, visible key | the app's code can read `RNXtoolBuildStamp` | nobody | accept: namespaced, harmless |
| 91 | D2, `run` | `run` skips the install on fingerprints alone | user: an old app after `run` | handle: `installedStamp` must equal `buildStamp` |
| 92 | D2, old state | the state was written by alpha.7 (no `buildStamp`) | user: `ℹ built by an older rn-xtool: rebuild to verify the install` | handle |
| 93 | D3, same iPhone on USB | the four Wi‑Fi tries fail and the iPhone is on USB | user: the one announce line, then the USB install with D2's check | handle |
| 94 | D3, another iPhone | another iPhone is on USB | user: the Wi‑Fi error and both UDIDs; nothing installed | handle |
| 95 | D3, none | no iPhone on USB | user: today's error, "and no iPhone is connected by USB" | handle |
| 96 | D3, interrupted `Install` | the link died after `Install` was sent | user: today's `InstallInterruptedError` | accept (R9): no automatic retry; the message already says to check the iPhone and install again |
| 97 | D3, other errors | a refused pair record, several iPhones, the scan refused | user: today's messages | accept: not "does not reach" |
| 98 | D3, `xtool dev run` | it rebuilds what is out of date and launches the app | user: the app opens | accept |
| 99 | E, packing | `AGENTS.md` is not in the package | maintainers: `tests/packageFiles.test.ts` | handle |
| 100 | E, command | `agent-guide` cannot find the file (a checkout without a build) | user: an error naming the path | handle |
| 101 | E, drift | the guide names steps or folders that changed | maintainers: the guide test | handle |
| 102 | E, user files | a tool deletes `patches/`, the config or the lock after reading the guide | user: their fixes gone | handle: the guide names them as the user's and never to be deleted; a test checks the list |
| 103 | E, `docs/` | the guide's links point at files not in the package | user offline: dead links | handle (R10): the user pages ship (E); `docs/design/`, `docs/research/`, `docs/upstream/` do not; RELEASING step 4 lists them; `tests/packageFiles.test.ts` checks both |
| 104 | F1, tarballs | about 45 more tarballs to fetch (R11's set) | CI: time and the existing fetch rules (two tries, integrity) | handle: `tests/tarballs.json`; the proof records the size |
| 105 | F1, third-party code | the sweep runs the libraries' Ruby and `node` scripts in CI | nobody | accept: the CI job has a read-only token and no secrets |
| 106 | F1, no Ruby | the runner has no Ruby | CI: a failure, not a skip | handle |
| 107 | F1, goldens | a deliberate reader change updates many goldens | maintainers | accept: reviewed in the same commit |
| 108 | F1, coverage | a library outside the set hits a shim gap | user: row 4's stop | accept: the report adds it to the set |
| 109 | F2, fixture | a CLI template change breaks the Objective-C overlay | the drift issue for that line | handle |
| 110 | F2, network | React Native's headers artifact cannot be downloaded | the line reads `unknown (could not run)` | accept: the drift watch's existing rule |
| 111 | F2, no compile | the drift watch never runs B2 | nobody | accept: the drift watch's documented limit |
| 112 | F3, scope | scoped package names (`@scope/name`, 122 in the docs) | maintainers | handle (R10): they pass and the bare user form is refused (the alpha.7 release listed only the user-form `@import` as a contributor) |
| 113 | F3, timing | GitHub notifies when the PR or release is published, before CI runs | the person mentioned | accept: RELEASING runs the check on the body and notes files before `gh pr create` and `gh release create`; CI flags what is left |
| 114 | F3, UI text | release notes typed in GitHub's page | nobody | accept: RELEASING says to publish notes from the checked file only |
| 115 | F3, existing text | the fifteen user-form mentions of fact 32 | maintainers: the new test | handle: fixed in the same task |
| 116 | G2, doctor's count | "N to download" while the cache holds the files | user: a wrong line | handle: G.2, after the builder checks whether the build downloads again |
| 117 | G3, include order | the fix for 0.85 changes another line's resolution | user: a compile error on 0.86–0.88 | handle: tests on the four lines' header trees |
| 118 | G4, DevTools | `j` fails on Linux | user | accept: the troubleshooting section |

## Verification

- **Unit tests**, each written red first, own the `handle` rows (the plan names them). `npm test`, `npm run lint`,
  `npm run scan:private` and the new mention check are green and clean; the byte tests of the scaffolder run, not skip.
- **The reader sweep** (F1) passes in CI with Ruby over R11's set, and its goldens are reviewed by the owner once,
  with the differences between the two readers listed per library.
- **Downloads and builds need the owner's approval first.** The sweep's tarballs (tens of MB), React Native's headers
  artifact for the drift target, and the builds below.
- **Spike gate (device, before group D2 is built):** a bare 0.88.1 build with each carrier candidate of D2 added by
  hand to its Info.plist; check each in the packed `App.app` and in `Lookup`'s answer over Wi‑Fi and over USB, and list
  every attribute `Lookup` returns (R9).
- **Response-file capture (before group B's golden test):** reference builds on the owner's machine, one at a time
  (approved by the owner on 2026-11-06), keep Swift Build's response files of the App target's compiles; they are
  normalised (home folders become `/home/me`) and checked by `scan:private` before they enter `tests/fixtures/` (R12).
- **Build-only proofs**, on copies of the reference apps:
  1. The Objective-C fixture app with seeded faults, one per build: a missing app header (F2), the bare include dirs
     removed (F3), `CLANG_CXX_LANGUAGE_STANDARD` removed (F4), an `@import` in a header its `.mm` includes (F5). Each is
     reported by B1 or B2 before `xtool-build`, and the time from `generate` to the report is recorded (target: about
     30 s).
  2. react-native-screens 4.24.0 with the reduced reader forced and a podspec idiom it cannot read added: C1, C2 or the
     codegen guard stops the build before install.
  3. The bare 0.85, 0.86, 0.87 and 0.88 references (Swift templates) and the Expo SDK 57 and 58 references build with
     no new stop and no new `⚠` except the ones this design lists; their scaffolds under the shim match the sweep's
     goldens.
- **Device pass for the owner** (free team):
  - the production bare React Native 0.85.0 app with an Objective-C app target and 20 libraries builds with alpha.8
    (no hand fix, scaffolds regenerated at revision 8), installs over Wi‑Fi with `Installed … (build <stamp>)`, installs
    over USB with the stamp verified, and runs: it opens past its start screen, react-native-screens' screens show,
    and Fast Refresh works;
  - with Wi‑Fi off on the iPhone and the cable in, `install --network` prints the USB announce line, installs over USB
    and verifies the stamp;
  - `ios-xtool/logs/` holds one log per command run, each ending with its status;
  - a clean Expo SDK 58 template and the bare React Native 0.88.1 reference build, install with the stamp verified, and
    launch with Fast Refresh, as in alpha.7.

  Until the owner confirms these, the CHANGELOG calls the stamp and the USB retry build-verified only.

## The questions the draft left open

All are ruled (see Rulings): the stamp's carrier is decided by the device spike (R9), the failure walk's open rows by
R1–R8 and R10, the sweep's set by R11 (source and date in F1), and log retention by R13 (ten per command).

## Left to the builder

- Exact names: the shim's file and its JSON keys, the `precheck` step's name, the state fields, the log file pattern
  beyond the decided folder. `RN_XTOOL_PODSPEC_READER=reduced`, `--skip-precheck` and `no-objc-classes:<target>` are
  decided (R2, R7).
- The Ruby floor the shim supports, from what it uses.
- Whether `get_folly_config` loads React Native's `helpers.rb` or holds the shared values.
- Whether B2 synthesises module maps for clang targets or skips the Swift file (row 44).
- How B2 finds the iPhoneOS SDK inside xtool's Swift SDK bundle.
- Whether B1 pass 2's React Native half can run right after `rn-artifacts` instead of after `generate`.
- The Objective-C fixture's contents (written for rn-xtool from React Native's pre-0.77 template, MIT) and how the drift
  watch overlays it on the CLI's project.
- The wording of the stops and lines not quoted above, and of the docs sections.

## Amendments (2026-11-09)

Recorded after the final review of plan 1. The sections above keep their text; where they differ, these rule.

- **A.2, the timeout: 30 s → 120 s.** rn-xtool gives each podspec 120 s. `@shopify/react-native-skia`'s podspec
  copies its prebuilt frameworks (hundreds of MB) into the library while it is read: on a slow disk, 30 s can stop a
  working app (an anti-goal), while a podspec that hangs costs 120 s once. Row 8's stop reads `did not finish in
  120 s`.
- **A.2, the interpreter.** `ruby <shim> --probe` also prints the absolute path of the interpreter that ran it
  (`RbConfig.ruby`), and every podspec runs with that path, not with `ruby` from `PATH`: a version manager's `ruby`
  shim (rbenv, asdf, mise) cannot pick another Ruby from a `.ruby-version` in a library's folder.
- **A.3, React Native's values.** `min_ios_version_supported` and `get_folly_config` answer constants held in the
  shim; the shim does not load the installed React Native's `helpers.rb`. A drift test in `tests/podspecShim.test.ts`
  checks the constants against `scripts/cocoapods` of every cached React Native line (`RN_LINES`: 0.85.0, 0.86.3,
  0.87.1, 0.88.0 and 0.88.1).
- **F.1 and R11, the heavy tier.** skia's three prebuilt packages (about 530 MB) are an optional heavy tier of
  `tests/tarballs.json`: `node scripts/fetch-test-tarballs.mjs` skips them unless asked (`--heavy` or
  `RN_XTOOL_FETCH_HEAVY=1`), and the sweep skips skia with a named reason when they are missing. CI does not fetch
  them (the owner's decision), so skia's golden is checked where the tier is fetched.
- **Rows 7 and 9, worklets' stop.** Worklets' own message (`[Worklets] Unable to recognize your react-native
  version…`) appears only when a `react-native` package is installed beside it. Without one, its
  `scripts/worklets_utils.rb:2` fails first, with Ruby's `no implicit conversion of nil into String`; either way the
  read stops as `raised`, with the podspec's path.
