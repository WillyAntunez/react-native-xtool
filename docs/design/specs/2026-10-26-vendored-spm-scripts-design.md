# Bare React Native 0.86 and 0.87 through vendored SwiftPM scripts — design

Date: 2026-10-26. Status: draft for Willy's approval. Supersedes the parked
[0.87-only design](2026-10-26-rn-0-87-support-design.md) (branch `feature/rn-0-87`).
Evidence: [research/rn-086-vendored-spm-spike.md](../../research/rn-086-vendored-spm-spike.md) (RN 0.86.3 built,
installed over Wi‑Fi, bundle loaded and Fast Refresh confirmed on the iPhone on 2026-10-26) and
[research/rn-087-recon.md](../../research/rn-087-recon.md).

## Intent

The versions people actually run: in the week of 2026-10-26, RN 0.86 took 37.7 % of react-native downloads (0.86.3
alone 2.56 M/week, the `0.86-stable` tag), 0.88 13.8 %, 0.81 13.8 %, 0.87 3.4 %. RN 0.86 is what Expo SDK 57 ships
(47 % of expo downloads). rn-xtool supports only 0.88.0. This step makes bare RN 0.86.x and 0.87.1 projects build,
install and run with the same commands, and lays the version plumbing that Expo SDK 57 (later) will need.

## Goals

- `rn-xtool doctor | build | install | start | run` on bare projects created with `@react-native-community/cli init
  --version 0.86.3` and `--version 0.87.1`, same commands and same `ios-xtool/` output shape as 0.88; verified on a
  physical iPhone (build, install, Metro, Fast Refresh) for 0.86.3 and 0.87.1.
- Libraries work as on 0.88 through the same auto-scaffolding: react-native-screens, react-native-gesture-handler,
  react-native-svg, react-native-webview and react-native-reanimated + worklets verified on the device on 0.86.3; the
  first four also on 0.87.1. A library that fails gets fixed, not documented as broken (Willy's ruling).
- Expo projects and bare 0.88.0 behave exactly as before: same bundled patches staged, same generated manifests
  (golden tests unchanged), same build steps.
- Unsupported RN versions get one clear error naming the supported list.

## Non-goals

- RN 0.85 and older (no prebuilt React core by default, artifact layout unverified), 0.86.1 (never published), RN 0.87.0.
- Expo SDK 57 (needs an Expo SwiftPM plugin equivalent; separate design, which will reuse this step's plumbing).
- Hybrid (bare 0.86/0.87 + Expo modules): Expo SDK 58 requires RN 0.88; the gate explains it.
- Moving Expo or bare 0.88 onto the vendored scripts (a possible later simplification; not now).
- Raising or lowering the App package floor (`IOS_MIN` 16.4 stays; library manifests follow the app's deployment target
  as 0.88's scripts already do).

## Anti-goals

- Patching RN's scripts in `node_modules` for versions that do not ship them; the vendored copy is the only route.
- Borrowing anything from a 0.88 artifact slot when adapting 0.86 artifacts (the spike did; the implementation
  generates module maps, Info.plist and placeholder archives itself).
- Fuzzy or best-effort artifact handling: an adapter that cannot recognise a layout stops with a message.
- Any change to the user's `ios/`.

## Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0 unchanged. CocoaPods never involved.
- RN 0.86.0/0.86.2/0.86.3 Maven artifacts exist (core and dependencies, debug and release, HTTP 200) in the
  **pre-headers-spec layout**: React headers per pod inside `React.xcframework/*/React.framework/Headers/<Pod>/…` with a
  clang VFS overlay template (`React-VFS-template.yaml`, 1178 mappings), umbrella `React_Core/React_Core-umbrella.h`,
  modules `React` and `React_RCTAppDelegate`; dependency headers inside `ReactNativeDependencies.xcframework/Headers`
  (byte-identical to 0.88's sidecar); no `ReactNativeHeaders.xcframework`, no `ReactNativeDependenciesHeaders.xcframework`,
  and no `reactnative-headers-*` / `reactnative-dependencies-headers-*` classifiers (404). Hermes: `hermes-compiler`
  250829098.0.17 (same for 0.87.1).
- RN 0.87.1 artifacts are already headers-spec (`reactnative-headers-debug` and `-dependencies-headers-debug` return
  200): no adapter needed.
- RN 0.86.x has no `scripts/spm/`, no `setup-apple-spm.js`, no `scripts/codegen/templates/Package.swift.spm-template`;
  its codegen entry point `scripts/generate-codegen-artifacts.js` is byte-identical to 0.88's and produces the same
  `build/generated/ios/{ReactCodegen,ReactAppDependencyProvider}` layout. RN 0.87.1 ships `scripts/spm/` but without
  `ios-deployment-target.js`/`swiftpm-config.js`, and our 0.88 patch does not apply to it.
- RN 0.88.0's `setup-apple-spm.js` + `scripts/spm/*` + the codegen template: 16.5 k lines, 652 KB, MIT (Meta Platforms).
  They `require('yargs')` and `require('micromatch')` (resolved today from the app's node_modules by accident).
- The 0.86 template: `AppDelegate.swift` only (imports `React`, `React_RCTAppDelegate`, `ReactAppDependencyProvider`),
  deployment target 15.1, depends on react-native-safe-area-context (own Package.swift). 0.87 template: same shape.
- `selectBundledPatches` stages a package's bundled patch whenever the package is installed, ignoring the filename
  version; `MIN_RN_MINOR = 88` rejects everything older.
- Spike timings on this machine: driver 2.2 s offline, xtool-build 16.5 s (template) / 51.6 s (with screens).

## Approaches considered

- **A. One bundled patch per RN version** (the parked 0.87 design): re-derive the 13 fixes against each version's
  scripts. Impossible for 0.86 (no scripts to patch); 40 % rewrite per version for 0.87. Rejected for older versions.
- **B. Vendor RN 0.88's SwiftPM scripts, with our fixes applied, inside rn-xtool and run them for RN versions that
  predate them (chosen).** One copy of the scaffolder fixes, no patch-package on RN for those versions, the installed
  RN's own codegen and artifacts. 0.86 additionally needs an artifact adapter. Proven by the spike end to end.
- **C. Vendored scripts for every kind and version, dropping the RN patch entirely.** Cleaner long-term; deferred: it
  would touch the Expo path (`setup-apple-spm.js add` with xcodeproj injection and the Expo plugin) for no user gain now.

Willy chose B after the spike (and 0.86.3 as the target over 0.87).

## Design

### Supported versions and the gate

- `src/versions.ts`: `SUPPORTED_RN = { "0.86.2": "vendored", "0.86.3": "vendored", "0.87.1": "vendored",
  "0.88.0": "installed" } as const` (exact versions; the value is the script source, see below). `MIN_RN_MINOR` goes.
- `checkRnVersion` (src/project/bare.ts) accepts exactly those; otherwise:
  `React Native <v> is not supported; rn-xtool supports 0.86.2, 0.86.3, 0.87.1 and 0.88.0 (bare). Pin react-native to
  one of them.` With Expo modules detected on anything but 0.88.0 it appends `Expo SDK 58 needs React Native 0.88.0.`
- `ProjectInfo` gains `rnVersion: string` and `rnScripts: "installed" | "vendored"`; `doctor`'s `project` check prints
  `… React Native 0.86.3 (vendored SwiftPM scripts) …`.
- 0.86.0 is excluded on purpose (same layout as 0.86.3 is likely but unverified; adding it later is one list entry plus
  a build check). Decision flagged for Willy below.

### Vendored scripts (`vendor/rn-spm/`)

- `vendor/rn-spm/README.md` (origin: react-native 0.88.0, MIT, the list of our modifications), `vendor/rn-spm/LICENSE`
  (Meta's MIT text), `vendor/rn-spm/setup-apple-spm.js`, `vendor/rn-spm/spm/*.js`, `vendor/rn-spm/codegen/templates/Package.swift.spm-template`.
  The copy is RN 0.88.0's files **with `patches/react-native+0.88.0.patch` applied** (the 13 scaffolder fixes, the
  `rn-xtool-scaffold-revision` marker, `RN_SPM_SWIFT_HEADERS_DIR`) plus the three root edits found by the spike:
  codegen template taken from the vendored copy (`spm-utils.js installSpmCodegenTemplate`), RN version macros read from
  the installed RN (`read-podspec.js readRnVersionMacros`), downloader RN root from the installed RN
  (`download-spm-artifacts.js main`). The RN root comes from one explicit env (`RN_SPM_RN_ROOT`) at the E2/E3 sites, never from
  `__dirname`; E1 resolves the template relative to the vendored copy. Our edits (E1–E4) are kept as one stored diff,
  `vendor/rn-spm/rn-xtool-edits.patch`, applied after the 0.88 patch.
- A test (`tests/vendor-rn-spm.test.ts`) proves provenance: taking the pristine `react-native@0.88.0` scripts (from the
  npm tarball cached for tests, or the reference app's pristine copy; skipped when neither is available) and applying
  `patches/react-native+0.88.0.patch` then `vendor/rn-spm/rn-xtool-edits.patch` yields files byte-identical to
  `vendor/rn-spm/`. This is how future script refreshes are checked.
- `yargs` and `micromatch` become rn-xtool dependencies at the versions RN 0.88.0 uses (17.7.x, 4.0.x).
- `package.json` `files` adds `vendor/`.

### Driver and script selection

- `scripts/rn-spm-generate.js` takes `--scripts-root <dir>`: the installed RN's `scripts/` for `installed`, the
  vendored dir for `vendored`. `--rn-dir` stays the installed RN (codegen, versions, hermes). Everything else unchanged.
- `src/pipeline/rnSpm.ts` passes the root according to `project.rnScripts`, and for vendored projects skips the
  bundled RN patch: `selectBundledPatches` applies an **exact-version rule to `react-native` only** (its patch is staged
  only when the installed version equals the filename's), so `react-native+0.88.0.patch` is never staged on 0.86/0.87.
  The Expo packages keep today's rule (staged whenever installed; a version mismatch still surfaces as the existing
  "could not patch … pin" error, which is better than silently building unpatched). Golden expectation: an Expo 58 /
  RN 0.88.0 project stages exactly the four patches it stages today.

### Artifact adapter for pre-headers-spec slots (`src/pipeline/rnArtifacts.ts`)

- **Download.** The `rn-artifacts` step calls the vendored `download-spm-artifacts.js` once per flavor with a new
  option `--allow-pre-headers-spec` (vendored edit E4): the downloader fetches and extracts core, dependencies and Hermes
  as today, and skips only its final "ReactNativeHeaders.xcframework is missing" validation, returning the slot path.
  Extraction errors (truncated tarball, checksum) still fail as before; rn-xtool never parses the downloader's output to
  tell the two apart. The slot is `~/Library/Caches/ReactNative/spm-artifacts/<v>/<flavor>` (RN's own location, also on
  Linux); the Hermes tarball lands inside that slot, so the adapter reads everything from one directory.
- **Adapt.** Runs for slots that lack `ReactNativeHeaders.xcframework` (detected, not hard-coded by version). Output:
  `ios/build/rn-artifacts/<v>/<flavor>/` in the headers-spec layout, mostly hard links:
  1. Materialise the VFS overlay (`React-VFS-template.yaml`) into the flat virtual header tree.
  2. `React.xcframework`: per slice, the 0.86 binary and Info.plist; `Headers/` = the virtual `React/` dir;
     `React-umbrella.h` = 0.86's `React_Core-umbrella.h`; `Modules/module.modulemap` = `framework module React { umbrella
     header "React-umbrella.h" export * module * { export * } }`.
  3. `ReactNativeHeaders.xcframework`: the virtual tree minus `React/` plus `hermes/` from the Hermes tarball. Module
     map generated, not copied: one entry per top-level directory of the virtual tree (plus `hermes`), named after the
     directory, in the exact form 0.88's map uses for each of its modules (umbrella directory, `export *`, submodules),
     which the implementer reads from the 0.88 map in the reference app and reproduces as a template. The module names
     are the pod `header_dir`s that libraries `@import` (`React_RCTAppDelegate`, `ReactCommon`, `jsi`, …): the 0.86
     AppDelegate's `import React_RCTAppDelegate` resolves through this. Acceptance: on the real 0.86.3 slot, the
     generated map's module set equals 0.88.0's minus `RCTAnimatedModuleProvider` (the only 0.88-only namespace, per the
     spike). Empty `libReactNativeHeaders-<slice>.a` written as a valid empty `ar` archive; `Info.plist` generated from
     the slices.
  4. `ReactNativeDependenciesHeaders.xcframework`: `ReactNativeDependencies.xcframework/Headers` wrapped the same way.
  5. `ReactNativeDependencies.xcframework` and the Hermes framework linked unchanged; `artifacts.json` written so RN's
     `validateArtifactsCache` and `flavored-frameworks.js` accept the slot.
- The driver then runs with `--artifacts <adapted root>` (RN's `downloadPolicy: 'skip'`), for both flavors. The user's
  `rnArtifactsDir` config, when set, bypasses the adapter (they already have a slot).
- Unknown layout (no VFS template, no umbrella, missing slice) → error naming the file and the version; no fallback.
- Unit tests build a miniature fake 0.86 slot (a handful of headers, a 3-line VFS template, fake binaries) and assert
  the output tree, module maps, archive validity (`ar t`), and the detection rule; a test asserts a headers-spec slot
  (fake 0.88 shape) is left untouched.

### Build steps and state

- New step `rn-artifacts` between `patches` and `rn-spm` for vendored projects with a pre-headers-spec slot (reported in
  `doctor` and `build` logs like the others); absent otherwise. The adapted slot is reused across builds (stamp file
  with the source slot's `artifacts.json` hash); `--clean` removes it with `ios/build`.
- `BuildState` records `rnVersion`; `start`/`run` fingerprints already include the react-native version through the
  dependency fingerprint.

### Reference apps, fixtures, tests

- `../app-bare-086` (sibling repo): `cli init --version 0.86.3 --install-pods false`, `rn-xtool.config.json`
  `{ "metroPort": 8082 }`, App.tsx title "Bare RN 0.86 on Linux"; branch `feature/lib-matrix` with screens,
  gesture-handler, svg, webview, reanimated + worklets (project patches as on 0.88). `../app-bare-087` the same for 0.87.1
  with the first four libraries. The throwaway `../spike-bare-086` is deleted once `app-bare-086` builds.
- Fixtures: `tests/fixtures/bare-086/` and `tests/fixtures/bare-087/`: pristine `ios/` of each template (pbxproj,
  AppDelegate.swift, Info.plist, PrivacyInfo, LaunchScreen.storyboard, Podfile) + `package.json`; reader tests assert
  the `BareTargetContent` shape (AppDelegate only, deployment target 15.1).
- Unit tests: gate (each supported version ok; 0.86.0, 0.86.1, 0.87.0, 0.85.0, 0.89.0 rejected with the exact message;
  Expo-modules sentence), patch selection by exact version, driver `--scripts-root` argument building for both sources,
  adapter (above), vendored provenance.
- Clean-machine harness: `e2e.sh project --bare [name] [--rn <version>]`; one clean run with `--rn 0.86.3` before the PR.
- Device matrix on 0.86.3 (template, five libraries, Fast Refresh, non-8081 Metro port) and 0.87.1 (template, four
  libraries). 0.86.2: build check only (no device), noted as such in docs.

### Docs

README "Which projects work" (`Bare React Native 0.86.2, 0.86.3, 0.87.1 and 0.88.0`; which were device-verified),
`docs/bare-react-native.md` (supported versions, template differences, vendored scripts, artifact adapter, cache
locations and sizes: a 0.86 slot is about 1.3 GB per flavor), `docs/how-it-works.md` (vendored scripts and why),
`docs/libraries.md` Bare column per version, `docs/upstream/react-native-scaffolder.md` (the fixes now live in two
places: the 0.88 patch and the vendored copy; the refresh procedure), CHANGELOG `Unreleased`.

## External interactions and failure modes

| Hop | Fails outright | Partial / late / duplicated | Who learns | Ruling |
|---|---|---|---|---|
| Maven download of 0.86.x / 0.87.1 core, deps, Hermes (RN's downloader, mirror then Central) | HTTP error, offline | truncated tarball → RN's extraction check fails | user, rn-spm log | accept (as 0.88 today); `rnArtifactsDir` is the offline path |
| Adapter on a slot whose layout differs (another 0.86.x, a future re-publish) | missing VFS template / umbrella → stop with file + version | a header moved → compile error later | user at `rn-artifacts` / at xtool-build | handle: strict detection + named error; version list limits exposure; test with fake slots |
| Adapter cache stale after RN's slot changes | — | old adapted tree reused | nobody | handle: stamp = hash of the slot's `artifacts.json` + adapter version; test |
| Disk: 1.3 GB raw + adapted (hard links) per flavor | ENOSPC mid-adapt | half-written tree | user | handle: write to a temp dir, rename at the end; `doctor` warns when `ios/build` + cache exceed free space? → defer (documented sizes only) |
| Vendored scripts vs installed RN codegen (0.86.x, 0.87.1) | codegen CLI change → sync fails | generated layout differs → manifest references missing dirs | user at rn-spm / xtool-build | handle: supported-version list is exact; a version outside it never reaches the scripts |
| Vendored scripts drift from RN 0.88.x releases (future) | — | fixes diverge between patch and vendored copy | maintainers | handle: provenance test ties the vendored copy to the 0.88.0 patch; documented refresh procedure |
| `yargs`/`micromatch` versions | module not found / API change | — | user | handle: declared dependencies at RN 0.88.0's versions |
| Device: libraries on 0.86 (`@import React` submodules under the generated module map) | compile/link error | runtime crash on a module | user / Willy on the matrix | handle: device matrix; every failure fixed before merge (adapter module map, vendored scripts or project patch); an unfixable cause goes to Willy as a decision |
| 0.86.2 and 0.87.1 build-only vs device | — | works in build, fails at runtime | user | accept for 0.86.2 (documented "build-verified"); 0.87.1 is device-verified |

## What this prepares

Exact-version support list and gate, scripts-source selection, vendored scaffolder with provenance test, artifact
adapter, `--rn` in the harness, two more reference apps: the pieces Expo SDK 57 (RN 0.86 + an Expo plugin equivalent)
will build on, and the route for 0.81 (SDK 54) if its artifacts allow.

## Decisions made while writing (controller's calls, flagged for review)

- Supported list is exact versions, device-verified or build-verified, not ranges: `0.86.2`, `0.86.3`, `0.87.1`,
  `0.88.0`. 0.86.0 (0.5 M downloads/week) is excluded until someone verifies it; one list entry to add.
- 0.87.1 goes through the vendored scripts too (no second patch file), since the vendored copy already carries the fixes
  and 0.87.1's artifacts are headers-spec. The parked 0.87 design is superseded. The 0.87.1 task is a verification
  task: if it needs more vendored edits of the E1–E4 kind (explicit roots, missing template), they are added; if it
  would need 0.87-specific logic branches, it goes back to Willy as a decision.
- The adapter generates module maps, `Info.plist` and placeholder archives itself: no dependency on a 0.88 slot.
- The adapted slot lives under `ios/build/rn-artifacts/` (per project, removed by `--clean`), not in the global cache.
- Device verification is the controller's with Willy; implementers never need the iPhone; device-gated tasks come
  last and the PR waits for them.

## Left to the builder

- Internal structure of the adapter module and its fake-slot fixtures; exact test names.
- How the driver receives the RN root for the vendored scripts (env vs flag), as long as it is explicit.
- Harness flag parsing; fixture construction details.
