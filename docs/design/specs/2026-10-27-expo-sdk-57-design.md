# Expo SDK 57 through a vendored Expo SwiftPM plugin — design

Date: 2026-10-27. Status: draft for Willy's approval. Extends
[2026-10-26-vendored-spm-scripts-design.md](2026-10-26-vendored-spm-scripts-design.md) (vendored RN scripts, 0.86
artifact adapter). Evidence: [research/expo-57-vendored-plugin-spike.md](../../research/expo-57-vendored-plugin-spike.md)
(the SDK 57 template and five libraries built; afterwards the controller and Willy installed the spike app with
expo-router, screens and haptics on the iPhone over Wi‑Fi, the bundle loaded and Fast Refresh worked, 2026-10-27) and
[research/compat-suite-proposal.md](../../research/compat-suite-proposal.md) (library popularity and mechanisms).

## Intent

Expo SDK 57 is about half of expo downloads (47 % in the week of 2026-10-26) and ships React Native 0.86.3, the most
used RN version. rn-xtool builds SDK 58 only. SDK 57 has no `expo/scripts/spm`, no `spm.autolinkingPlugin`, an
autolinking CLI without `prebuilt-metadata`, a macOS-only macro plugin and no `ExpoModulesJSIHeaders.xcframework`. But
it does publish ExpoModulesCore (and ExpoModulesWorklets, ExpoFileSystem, ExpoFont) as Debug and Release xcframeworks
inside its npm packages. The spike showed that SDK 58's plugin, run by the vendored RN scripts on RN 0.86.3's adapted
artifacts, builds an SDK 57 app that runs. This step turns that route into a supported path.

## Goals

- `rn-xtool doctor | build | install | start | run` on a project created with `create-expo-app --template
  blank-typescript@sdk-57` (expo 57.0.31, react-native 0.86.3). Same commands and same `ios-xtool/` shape as SDK 58.
  Verified on the iPhone: build, install, Metro on a non-8081 port, Fast Refresh.
- App shells with and without a SceneDelegate (57's template is AppDelegate-only, 58's has both). Expo modules from
  source and precompiled.
- Libraries verified on the device on SDK 57: expo-haptics, expo-image-picker, expo-file-system,
  react-native-screens, react-native-safe-area-context, expo-router, react-native-reanimated + react-native-worklets,
  expo-dev-client. Each library builds and launches without credentials. A library that fails is fixed, never
  documented as broken without Willy's decision.
- The generic gaps the spike found are fixed generically, so SDK 58 and bare projects benefit too: Swift consumers of
  scaffolded mixed libraries (expo-router + screens), interpolated `-D` defines, and subspec header mappings.
- Expo 58 and bare 0.86.2/0.86.3/0.87.1/0.88.0 behave exactly as before: same commands, same patches staged, same build
  steps. Generated manifests change only where a generic fix adds what was missing (listed below and reviewed in the
  golden diffs).
- Any other Expo version gets one clear error that names what is supported.

## Non-goals

- Expo SDK 54–56. They come next, after a recon of their RN artifacts (0.81–0.85). SDK 52/53 are out.
- Hybrid bare RN 0.86 + Expo 57 modules (`install-expo-modules`). The bare gate keeps its message.
- Moving SDK 58 onto the vendored plugin or vendored scripts.
- Release-flavor builds. rn-xtool makes debug dev builds; only the Debug ExpoModulesCore is staged, as on 58.
- Building ExpoModulesCore 57 from source. SDK 57 publishes it.
- Libraries outside the matrix, such as the 13-item suite of compat-suite-proposal.md. That is a separate decision.

## Anti-goals

- Hand edits to generated files. The spike's X6 (hand-edited `swiftSettings`) becomes generator code, or it does not
  ship.
- Any edit by rn-xtool to the user's `ios/`. For Expo projects `ios/` comes only from `expo prebuild`. SDK 57 does no
  xcodeproj injection either (the driver path, as in bare).
- Patching SDK 57's packages to look like 58 (adding `scripts/spm` or `spm.autolinkingPlugin` to the installed
  `expo`). The vendored copy is the only route.
- Resolving the app's packages through a walk up from rn-xtool's own directory. The spike got `@expo/config-plugins`
  and `xcode` from the app only by accident. In rn-xtool the same walk would find rn-xtool's own 58 copies.
- Reading anything from a 58 tarball at build time to make SDK 57's missing JSI headers.
- Env-variable hacks named `SPIKE_*`. Every seam is an explicit driver flag or a documented variable set by rn-xtool.

## Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0 unchanged. No CocoaPods, no Mac.
- npm `sdk-57` = expo **57.0.31**, which installs react-native **0.86.3**, expo-modules-core **57.0.24**,
  expo-modules-autolinking **57.0.16**, expo-modules-jsi **57.1.3**, `@expo/expo-modules-macros-plugin` 0.6.1 (Mach-O
  only), hermes-compiler 250829098.0.17. npm may nest expo-constants under `expo/node_modules`.
- SDK 57 lacks `expo/scripts/spm/`, `spm.autolinkingPlugin` in `expo/react-native.config.js`, the autolinking commands
  `prebuilt-metadata` and `generate-modules-provider --target-platform`, a checked-in `Package.swift` in `expo` and
  `expo-constants`, and `expo-modules-jsi/prebuilds/`. It has `spm.config.json` in core, jsi and the modules.
- Expo 58's plugin (`expo@58.0.19` `scripts/spm/`, 14 JS files, about 5.9k lines, MIT 650 Industries) never
  downloads. It finds precompiled modules through `EXPO_PRECOMPILED_MODULES_PATH/<pkg>/output/<flavor>/xcframeworks`,
  then the Expo monorepo, then `<pkg>/prebuilds/output/<flavor>/xcframeworks`. A headers xcframework's
  `expo-package.json` must equal the installed package version (`assertHeadersMatchSources`).
- expo-modules-autolinking **58.0.15** (deps `@expo/platforms ^58.0.1`, `@expo/require-utils ^58.0.4`,
  `@expo/spawn-async`, `chalk ^4`, `commander ^7`). The `ExpoModulesProvider.swift` it generates for the 57 app equals
  57's own, apart from the class name. expo-modules-macros **0.22.0** has optional `@expo/modules-macros-linux-{x64,arm64}`
  0.22.0.
- expo-modules-jsi 57.1.3 builds with `scripts/build-expo-modules-jsi.sh` plus the one-line Swift 6.4 fix
  (`JavaScriptError.swift:92`, `public var message` → `var message`; same as 58). It emits `ExpoModulesJSI.swiftinterface`
  (Swift 6.4.1, library evolution) and `ExpoModulesJSI-Swift.h` in `Objects-normal/arm64`. ExpoModulesCore 57's
  interface was made by Xcode's Swift 6.3.1, and the two link and run together (device, 2026-10-27).
- The 57 prebuild tarballs carry macOS AppleDouble `._*` entries and `LIBARCHIVE.xattr.com.apple.provenance` pax
  headers: 1074 files in `ios/build/expo-xcframeworks`. They cause tar and `-Wincomplete-umbrella` warnings.
- 57 template: `AppDelegate.swift` only (`class AppDelegate: ExpoAppDelegate`, which creates its own `UIWindow`;
  imports `internal import Expo`, `React`, `ReactAppDependencyProvider`), Info.plist without
  `UIApplicationSceneManifest`, an empty `<App>-Bridging-Header.h`, deployment target 16.4, Swift 5.
- SDK 57's pins: react-native-screens 4.26.2, safe-area-context 5.7.0, reanimated 4.5.1 + worklets 0.10.4 (neither
  ships a Package.swift, so both are scaffolded), expo-router 57.0.29. expo-router lists reanimated and gesture-handler
  as `*` peers. When reanimated is not installed explicitly, npm auto-installs the latest (reanimated 4.7.1, worklets
  0.13.1, outside core 57's worklets peer range `^0.7.4 || … || ^0.10.0`).
- Spike timings: rn-spm 3.2 s, jsi 1.3 s cached (6 s cold), xtool-build 16.9 s (template) and 62–77 s with libraries.
  App.app 95 MB (template), 131 MB with router.

## Approaches considered

- **A. Patch SDK 57's own packages.** Nothing to patch: SDK 57 has no plugin, its autolinking lacks the commands, and
  its macro plugin has no Linux binary. Rejected.
- **B. Vendor Expo 58's plugin (with our patch) plus autolinking 58.0.15 and the Linux macros, and run it through the
  vendored RN scripts on the adapted 0.86.3 artifacts, with SDK 57's own precompiled ExpoModulesCore (chosen).** The
  spike proved it end to end and the device run confirmed it. The new piece is a JSI headers synthesis step.
- **C. Build ExpoModulesCore 57 and every Expo module from source.** 183 Swift and 86 header files in three targets,
  for an artifact Expo already publishes. Rejected.
- **D. Write our own Expo module linker for 57.** It would duplicate the plugin's classification and manifests, and
  diverge from 58. Rejected.

Willy chose B after the spike.

## Design

### Supported versions and the gate (`src/versions.ts`, `src/project/expo.ts`)

- `SUPPORTED_EXPO = { 57: { plugin: "vendored", pins: { expo: "57.0.31", "react-native": "0.86.3",
  "expo-modules-core": "57.0.24", "expo-modules-autolinking": "57.0.16", "expo-modules-jsi": "57.1.3" } }, 58: { plugin:
  "installed" } } as const`. SDK ≥ 58 keeps today's rule (installed plugin, pins enforced by the bundled patches'
  mismatch error). `MIN_EXPO_SDK` goes.
- `readExpoProject`:
  - SDK below 57: `Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58 or newer.`
  - SDK 57 with any pin off (each read where the build resolves it: core from `expo`, jsi from core):
    `Expo SDK 57 needs exactly expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking
    57.0.16 and expo-modules-jsi 57.1.3; installed: expo-modules-core 57.0.25. Pin those versions in package.json and
    reinstall.` (The installed list names only the mismatches.)
- `ProjectInfo` gains `expoPlugin: "installed" | "vendored"`. SDK 57 gives `rnScripts: "vendored"` and
  `expoPlugin: "vendored"`. Bare projects get `"installed"` (unused).
- doctor `project`: `expo SDK 57, React Native 0.86.3 (vendored Expo SwiftPM plugin and SwiftPM scripts)`. 58 lines are
  unchanged.
- With the vendored plugin, the `project` check (and `build`) also fails when the macro binary for the host is missing:
  `expo-modules-macros 0.22.0 has no Linux binary for <arch> (@expo/modules-macros-linux-<arch>); reinstall
  react-native-xtool without --omit=optional.`

### Vendored Expo plugin (`vendor/expo-spm/`)

- `vendor/expo-spm/spm/*.js`: `expo@58.0.19` `scripts/spm/` without `__tests__` and `jest.config.js`, **with
  `patches/expo+58.0.19.patch` applied**, then `vendor/expo-spm/rn-xtool-edits.patch` (vendored-only edits, below).
  Also `README.md` (origin, MIT, list of edits), `LICENSE` (expo 58.0.19's, 650 Industries) and `package.json`
  (`{ "type": "commonjs" }`).
- Vendored-only edits (SDK 58 never runs them):
  - **P1** (spike X2): `plugin.js` `macroPluginTool` resolves `expo-modules-macros` from `[coreModuleRoot, __dirname]`.
    Core 57 has no `expo-modules-macros`, so rn-xtool's 0.22.0 is used.
  - **P2**: packages of the app (`expo`, `expo-modules-core`, the modules, `@expo/config-plugins`, `xcode`) resolve
    from the app root, given explicitly by the driver, never by walking up from the plugin.
  - **P3** (X4): generated mixed and clang packages default `headerDir` to the pod name. 57's expo-constants keeps flat
    headers and imports `EXConstants/EXConstantsService.h`.
  - **P4** (X5): each generated mixed and clang package gets a CocoaPods-style `prefix.pch` (`#ifdef __OBJC__ #import
    <UIKit/UIKit.h> #endif`), passed with `-include` to C and C++. 57's `EXLegacyAppDelegateWrapper.h` relies on it.
  - **P5**: precompiled tarballs are extracted without `._*` entries and pax xattrs.
- Autolinking and macros: `expo-modules-autolinking` **58.0.15** and `expo-modules-macros` **0.22.0** become exact
  dependencies of rn-xtool. npm installs the host's `@expo/modules-macros-linux-<arch>`, so x64 and arm64 are both
  covered. The vendored plugin finds both through rn-xtool's `node_modules`, as RN's vendored scripts find `yargs`.
  rn-xtool's autolinking copy is **not** patched. The `@ExpoModule` scanner it gates needs `expo-modules-macros` inside
  core, which 57 lacks: the scanner prints its "Couldn't load expo-modules-macros" warning and only
  `expo-module.config.json` modules link, the same set as 57's own autolinking (see the decisions below).
- `tests/vendor-expo-spm.test.ts`:
  - Provenance, the way `vendor-rn-spm.test.ts` does it. The pristine `tests/.cache/expo-58.0.19.tgz` (sha512 pinned
    from the registry, skipped when absent) plus the Expo patch plus `rn-xtool-edits.patch` must equal
    `vendor/expo-spm/` byte for byte. `LICENSE` must equal the tarball's.
  - Every non-relative `require` in `vendor/expo-spm/spm` is classified: a Node builtin, a declared rn-xtool
    dependency at its exact version, or an app package resolved through P2. An unclassified require fails the test.
  - Unit tests for P1, P3, P4 and P5.
- `package.json` `files` already has `vendor/`.

### Expo projects on the driver (`src/pipeline/rnSpm.ts`, `scripts/rn-spm-generate.js`)

- `runRnSpm` drops its guard against Expo with vendored scripts. For `expoPlugin: "vendored"` it runs
  `rn-spm-generate.js` (no `setup-apple-spm.js add`, no xcodeproj injection) with:
  - `--scripts-root vendor/rn-spm`;
  - `--config-command` = today's `AUTOLINKING_CONFIG_COMMAND`, which resolves the app's autolinking 57.0.16 for the
    module list;
  - `--artifacts <rn-artifacts root>`;
  - `--expo-plugin vendor/expo-spm/spm/plugin.js`;
  - env `EXPO_PRECOMPILED_MODULES_PATH=ios/build/expo-precompiled`, next to the existing `RN_SPM_SWIFT_HEADERS_DIR`.

  The scaffold, persist and rerun flow is the bare one. Expo 58 keeps `setup-apple-spm.js add|update`, byte for byte
  the same argv.
- **E5** in `vendor/rn-spm/rn-xtool-edits.patch` (spike X1): `spm/autolinking-plugins.js` takes the plugin path for
  the dependency named `expo` from `RN_SPM_EXPO_PLUGIN` (set by the driver from `--expo-plugin`), only when `expo`
  declares no `spm.autolinkingPlugin`.
- **D1** (driver): the scaffold step passes `skipDeps` = the dependencies an SPM autolinking plugin provides (`expo`
  here). Otherwise RN's scaffolder writes `node_modules/expo/Package.swift` and the plugin then refuses `expo`
  (`Expo module "expo" (pod Expo) ships a Package.swift the generated package cannot mirror`).

### Build steps for SDK 57 (`src/commands/build.ts`)

- Expo with `expoPlugin: "vendored"`: `prebuild` (when `ios/` is missing or `--clean`), `patches`, `rn-artifacts`
  (skipped with `rnArtifactsDir`), **`jsi`**, `rn-spm`, `app-config`, `frameworks`, `generate`, `xtool-build`. `jsi`
  moves before `rn-spm` because the plugin requires the JSI headers. Expo 58 and bare plans are unchanged (golden
  tests).
- `patches` (`selectBundledPatches`):
  - With the vendored plugin, every bundled patch is exact-version. On a 57 project only the new
    `patches/expo-modules-jsi+57.1.3.patch` is staged.
  - Otherwise today's rule holds, except that when several bundled patches name one package, the exact version wins,
    and with no exact match the highest version is staged. That keeps 58's "pin" error.
  - Golden: an Expo 58 project stages exactly its four patches today, and a bare 0.88 hybrid is unchanged.
- `rn-artifacts`: the existing step and adapter, for the 0.86.3 slot. The adapted slot is shared in layout with bare
  0.86.3 but lives per project under `ios/build/rn-artifacts/`, as today.

### ExpoModulesJSI and its headers for 57 (`src/pipeline/jsi.ts`, new `src/pipeline/jsiHeaders.ts`)

- `scripts/build-expo-modules-jsi.sh` (spike J1) accepts the React and dependencies header dirs as overrides.
  rn-xtool passes the `ios-arm64` `Headers` of the debug slot's `ReactNativeHeaders` and
  `ReactNativeDependenciesHeaders` (from the adapted slot, or `rnArtifactsDir`), because `ios/build/xcframeworks` does
  not exist yet. 58 calls it without the overrides, as today.
- After the build, `jsiHeaders.ts` writes
  `ios/build/expo-precompiled/expo-modules-jsi/output/headers/xcframeworks/ExpoModulesJSIHeaders.xcframework`, in 58's
  tarball layout:
  - two slices, `ios-arm64` and `ios-arm64_x86_64-simulator`. Each has
    `Headers/ExpoModulesJSI/{ExpoModulesJSI-Swift.h, NativeState.h, module.modulemap}` and a placeholder
    `libExpoModulesJSIHeaders.a` (an empty `ar` archive, as the RN adapter writes);
  - `ios-arm64/ExpoModulesJSI.swiftmodule/arm64-apple-ios.swiftinterface` from the build;
  - `Info.plist` generated from the slices;
  - `expo-package.json` `{"name":"expo-modules-jsi","version":"<installed>"}`.

  The module map is a committed template, the same text 58 ships (`module ExpoModulesJSI { header
  "ExpoModulesJSI-Swift.h" export * explicit module Cxx { requires cplusplus header "NativeState.h" export * } }`,
  MIT data). `NativeState.h` comes from `expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/Public`.
- Write to a temp dir and rename. A stamp (jsi version, interface hash, generator version) skips the rewrite on
  unchanged builds. A missing input stops the step: `The ExpoModulesJSI build produced no <file> (expected in <dir>);
  cannot make ExpoModulesJSIHeaders.xcframework for expo-modules-jsi 57.1.3.`
- The `frameworks` step stages `ExpoModulesJSI.framework` from `jsi-out` as on 58. ExpoModulesCore, Worklets,
  FileSystem and Font come from `flavored-frameworks.json`.

### App shell with or without SceneDelegate (`src/generate/iosXtool.ts`)

- `AppDelegate.swift` is required. `SceneDelegate.swift` is copied when present. When Info.plist's
  `UIApplicationSceneManifest` names a delegate class but the file is missing, the step stops: `Missing
  SceneDelegate.swift: <path> (Info.plist's UIApplicationSceneManifest names $(PRODUCT_MODULE_NAME).SceneDelegate)`.
  This rule applies on every SDK. 58's output is unchanged.
- The empty `<App>-Bridging-Header.h` is ignored, as on 58.

### Generic fixes (shared patches, so 58 and bare benefit)

The vendored copies are re-derived from the shared patches. Their provenance tests prove it.

- `patches/expo+58.0.19.patch` (Expo plugin):
  - **X3**: a generated package's Swift umbrella leaves out headers that import the package's own `<Product>-Swift.h`.
    Before, those builds failed: `'Expo-Swift.h' file not found` via 57's `expo/ios/Swift.h`.
  - **X6b**: the podspec reader also treats `add_dependency(s, "<Pod>")`, Expo's Ruby helper, as a dependency, so
    ExpoRouter depends on RNScreens.
  - **X6c**: a generated package that depends on a scaffolded mixed library adds that library's importer paths
    (below) to its `swiftSettings` as `-Xcc -I…`.
- `patches/react-native+0.88.0.patch` (scaffolder; fixes 14–17 in `docs/upstream/react-native-scaffolder.md`):
  - **14 (S1)**: the Swift umbrella of a scaffolded mixed target leaves out headers that import
    `<Module|swiftName>-Swift.h`. screens 4.26's `ios/bridging/Swift-Bridging.h` failed with `RNScreens-Swift.h file
    not found`.
  - **15**: Ruby interpolation `#{package['version']}` (and the `"version"` spelling) in `OTHER_CFLAGS`, compiler
    flags and defines is evaluated from the library's `package.json`. Before, `-DWORKLETS_VERSION=…` and
    `-DREANIMATED_VERSION=…` were dropped (`WorkletsVersion.cpp:19:22: use of undeclared identifier
    'WORKLETS_VERSION_STRING'`).
  - **16**: a subspec's `header_mappings_dir` under the spec's `header_dir` maps headers as
    `<header_dir>/<path relative to header_mappings_dir>`, as CocoaPods does (`'worklets/apple/AnimationFrameQueue.h'
    file not found`).
  - **17 (X6a)**: each scaffolded mixed manifest records the header search paths a Swift importer of its umbrella
    needs, as one marker comment (`// rn-xtool-swift-importer-paths: …`). `RN_XTOOL_SCAFFOLD_REVISION` goes to 2.
- rn-xtool:
  - **X6d**: `packageSwift.ts` adds `-Xcc -I<path>` to the App target's `swiftSettings` for every autolinked scaffolded
    mixed library's importer paths, on Expo, bare and hybrid apps. This is where `SwiftDriver App` failed on
    `RNSReactBaseView.h`.
  - `scaffoldPatchWarnings` also warns about a persisted scaffold patch with an older revision:
    `⚠ patches/<name> was written by an older rn-xtool scaffolder (revision 1, now 2); delete it so rn-xtool
    regenerates it (also remove node_modules/<pkg> and reinstall: that copy still has the old Package.swift)`.
- Expected golden changes, reviewed in the PR:
  - SDK 58 and bare apps with a scaffolded mixed library (screens) gain the App importer flags;
  - packages scaffolded by revision 2 gain the marker;
  - nothing else changes.

  Expo 58's generated mixed packages (expo-application, the dev-client chain) do not change, because P3 and P4 are
  vendored-only.

### Reference app, fixtures, tests

- `../app-expo-57` (sibling repo): `create-expo-app --template blank-typescript@sdk-57`, `rn-xtool.config.json`
  `{ "metroPort": 8083 }`, App.tsx title "Expo SDK 57 on Linux". Branch `feature/lib-matrix` has the eight libraries,
  installed with `npx expo install` (SDK 57's pins, reanimated 4.5.1 + worklets 0.10.4 explicit). It has one screen per
  library: haptics fires; the picker opens and cancels; file-system writes and reads back a file; expo-router
  navigates between two routes on native-stack with safe-area insets; a reanimated shared value animates on the UI
  thread; dev-client's launcher connects to Metro. The throwaway `<scratch>/spike57` is deleted once this app builds.
- Fixtures: `tests/fixtures/expo-57/` holds the pristine prebuild output (`ios/<App>/AppDelegate.swift`, `Info.plist`
  without a scene manifest), `app.json` and `package.json` with the pins. There are also fake JSI build outputs for
  `jsiHeaders`, and podspec excerpts of worklets 0.10.4, reanimated 4.5.1 and screens 4.26.2 for fixes 14–17.
- Unit tests:
  - gate: 57 exact ok; each pin off; SDK 56, 55 and 54 rejected with the exact text; 58 and 59 unchanged;
  - patch selection: 57 stages only jsi 57.1.3; 58 stages its four; jsi 58.0.20 on 58 still gives the pin error;
  - build plans for Expo 57 (with and without `rnArtifactsDir`), Expo 58 and bare;
  - `runRnSpm` argv and env for Expo 57, and 58's argv unchanged;
  - J1 overrides, the headers synthesis (tree, module map, `ar t`, version stamp, reuse, missing input);
  - SceneDelegate cases: absent and no manifest, present, absent with manifest → error;
  - driver D1, E5, P1–P5, X3, X6b and X6c (in `expo-plugin.test.ts`), fixes 14–17 (in `rn-scaffolder.test.ts`), X6d
    (packageSwift golden);
  - the revision warning, the doctor line and the macros-binary check;
  - both provenance tests.
- Clean-machine harness: `e2e.sh project --sdk 57 [name]` runs `npx create-expo-app@latest <name> --template
  blank-typescript@sdk-57`. `--sdk` is refused with `--bare`. Before the PR: one clean run, `setup`, `build`,
  `install`, launch.
- Device matrix:
  - SDK 57: template (Fast Refresh, port 8083) and the eight libraries on `feature/lib-matrix`;
  - SDK 58 regression: template launch, plus expo-router + screens on the 58 reference app (the X6 proof; expo-router
    on 58 was ⏳);
  - bare: `app-bare` (0.88.0) and `app-bare-086` rebuilt on their lib-matrix branches and launched once with screens
    (X6d changed their App manifest).
  - Device checks are the controller's with Willy, last, and the PR waits for them.

### Docs

- README "Which projects work": Expo SDK 57 (expo 57.0.31 exact) and 58.
- `docs/how-it-works.md` and `docs/recipe.md`: the vendored Expo plugin, the JSI headers step, step order for 57.
- `docs/libraries.md`: an Expo 57 column.
- `docs/upstream/react-native-scaffolder.md`: fixes 14–17.
- `docs/upstream/expo-spm-plugin-mixed-modules.md`: X3, X6b, X6c.
- `vendor/expo-spm/README.md`, `docs/troubleshooting.md` (the gate texts) and the `docs/README.md` index (the two
  research docs, this record).
- CHANGELOG `Unreleased`.

## External interactions and failure modes

| Hop | Fails outright | Partial / late / duplicated | Who learns | Ruling |
|---|---|---|---|---|
| `npm i -g react-native-xtool` pulls `expo-modules-macros` 0.22.0's optional Linux binary | `--omit=optional` or an unsupported arch: no binary | — | user at doctor / build | handle: the macros-binary check with the named error; test |
| Maven download of RN 0.86.3 core, deps and Hermes | HTTP error, offline | truncated tarball → RN's extraction check | user, rn-artifacts log | accept (as bare 0.86); `rnArtifactsDir` is the offline path |
| Disk: the 0.86.3 slot is about 1.3 GB per flavor, plus the 57 prebuilds, plus `expo-precompiled` | ENOSPC | half-written tree | user | handle for the JSI headers (temp dir + rename); the rest accept as bare 0.86 (documented sizes) |
| Expo's precompiled tarballs inside the npm packages (core, worklets, file-system, font) | missing tarball after a 57.0.x change | `._*` files and xattrs extracted | user / nobody | handle: exact pins in the gate; P5 strips AppleDouble entries; test |
| ExpoModulesJSI build with the Darwin SDK (Swift 6.4) | compile error (as `CppError` was) | — | user at `jsi` | handle: bundled `expo-modules-jsi+57.1.3.patch`; exact jsi pin |
| JSI headers synthesis vs the plugin's `assertHeadersMatchSources` | version stamp ≠ installed → plugin error | stale headers after a jsi or Swift change | user at rn-spm / nobody | handle: stamp from the installed version, rewrite keyed on the interface hash; test |
| Linux Swift 6.4.1 JSI interface against the Xcode 6.3.1 core interface | — | ABI/semantic skew at runtime | user at runtime | accept: device-verified on 2026-10-27; re-checked on the matrix |
| Macro skew (0.22.0 macros expanding against core 57) | — | wrong expansion at runtime | user at runtime | accept with evidence: Expo source modules in the device matrix (haptics, picker, router, ExpoUI) |
| Autolinking 58.0.15 run on a 57 tree (module list from 57.0.16) | — | a module missing from `ExpoModulesProvider.swift` | user at runtime (`Cannot find native module`) | handle: test comparing the provider with 57's own `generate-modules-provider` output on the fixture tree |
| Vendored plugin resolving packages | rn-xtool's 58 `@expo/config-plugins` used instead of the app's | silently different behavior | nobody | handle: P2 + require-classification test |
| Expo 57.0.x / core / jsi patch releases | gate refuses | — | user | handle: exact gate text; adding a version is one entry plus a build check |
| expo-router's peer auto-install (reanimated 4.7.1, worklets 0.13.1) when reanimated is not installed explicitly | CF manifest bug on Linux | worklets outside core 57's peer range → ExpoModulesWorklets mismatch at runtime | user | handle: the matrix installs SDK 57's pins explicitly and docs say to; the 4.7.1/0.13.1 combo gets one build-and-launch check with the documented project patches (as on 58); a runtime failure goes to Willy as a decision |
| Scaffolder fixes 14–16 on reanimated 4.5.1 / worklets 0.10.4 | further compile errors beyond the two seen (the spike stopped there) | — | implementer | handle: fixed generically before merge; a library-specific fork goes to Willy as a decision |
| Persisted scaffold patches from revision 1 (no importer marker) | expo-router compile error on `RNSReactBaseView.h` | — | user at xtool-build | handle: revision warning with the fix; test |
| Shared-patch changes (X3, X6, fixes 14–17) on SDK 58 and bare | regression build error | changed manifests on working apps | maintainers | handle: golden diffs limited to the listed changes; regression builds and device launches above |
| Expo SDK 54–56 projects | gate refuses | — | user | defer: to the SDK 54–56 block (after the RN 0.81–0.85 artifact recon) |
| Release flavor / ExpoModulesCore Release | — | never built | — | accept: dev builds are debug only (as 58) |

## What this prepares

An Expo version table with a plugin source, a vendored Expo plugin with provenance, Expo projects on the driver path,
JSI headers synthesis, and the `--sdk` harness flag. These are the pieces SDK 54–56 will need if their cores also ship
prebuilds and their RN artifacts can be adapted. It also brings generic scaffolder fixes for the scaffolded reanimated
and worklets lines, and the importer-path mechanism every Swift consumer of a scaffolded mixed library needs (on any
SDK).

## Decisions made while writing (flagged for review)

- **Autolinking 58.0.15 and expo-modules-macros 0.22.0 are exact npm dependencies, not copied files.** npm picks the
  right `linux-{x64,arm64}` binary (a copied binary would cover only one arch), and a nested `node_modules` in the
  published tarball is fragile under npm's packing rules. The darwin-gate patch is not applied to rn-xtool's copy because it is moot on 57: core 57 has no
  `expo-modules-macros`, so the scanner never runs. Only the plugin is vendored as files with provenance. If Willy
  wants all three as files, `bundleDependencies` is the route, x64 only.
- **Where the fixes live.**
  - X3, X6b and X6c go in the shared Expo patch, and fixes 14–17 in the shared RN patch.
  - P1–P5 (macro lookup, app-root resolution, header-dir default, prefix header, AppleDouble) are vendored-only, so
    SDK 58's generated mixed packages stay byte-identical. X4 and X5 are CocoaPods-fidelity fixes that 58 does not
    need today. Moving them to the shared patch later is one diff, plus a 58 dev-client device recheck.
- **X6 lands here, generically.** That covers the App target in rn-xtool, Expo-generated consumers in the Expo patch,
  and the marker in the scaffolder. It is proven on the device on 58 with expo-router, which was untested on 58 until
  now.
- **SDK ≥ 58 keeps today's open-ended rule.** Only 57 is an exact pin set. The "too old" message names both.
- **`jsi` is one step that moves before `rn-spm` on 57.** It is not a new step name. It builds the framework and
  writes the headers.
- **SceneDelegate is optional on every SDK.** It is required only when Info.plist's scene manifest names it.
- **The matrix uses SDK 57's own pins in one app** (reanimated 4.5.1 + worklets 0.10.4 scaffolded). The 4.7.1/0.13.1
  pair that npm auto-installs when reanimated is missing gets only a build-and-launch check.
- **Reference app `../app-expo-57` uses Metro port 8083.** Device checks come last and are the controller's with Willy.

## Left to the builder

- The exact `SUPPORTED_EXPO` field names, the driver flag and env names (`--expo-plugin`, `RN_SPM_EXPO_PLUGIN`, the
  P2 app-root variable), and the importer marker's syntax, as long as each is explicit and tested.
- The `patch` strip level for the Expo provenance test, and the fixture construction.
- Whether a stale revision-1 manifest in `node_modules` is re-scaffolded automatically when the scaffold step runs.
  The warning is required either way.

## Amendments from the builder check (2026-10-27, controller's rulings)

- **Matrix versions on SDK 57 = what `npx expo install` gives**, taken from `expo@57.0.31/bundledNativeModules.json`: react-native-worklets 0.10.1 (not 0.10.4), react-native-reanimated as pinned there, react-native-gesture-handler ~2.32 (CocoaPods-only → scaffolded; joins the matrix and the scaffolder work), screens and safe-area-context as pinned there. The reference app passes `npx expo install --check`. The podspec fixtures for scaffolder fixes 14–17 are taken from those exact versions. Separately, one build-and-launch check of expo-router with npm's default peers (reanimated 4.7.1 + worklets 0.13.1 + gesture-handler 3.4.0).
- **Reanimated/worklets on 57 stay a merge blocker, with a checkpoint**: generic scaffolder gaps are fixed as found; after two working days on this stream, or a third distinct gap after the two known ones, the controller reports to Willy with the evidence and a proposal (continue, or ship the rest first). Never documented as broken without his decision.
- **Kept as designed**: X6 (expo-router header paths) lands generically here and is proven with expo-router + screens on the SDK 58 reference app; the scaffold revision bump to 2 (persisted patches get the existing "scaffolded for another version / re-scaffold" path); the SceneDelegate rule applies on every SDK; SDK 58 and newer keep today's rule. Cost accepted: three extra device sessions (SDK 58 app, bare 0.86.3 and 0.88 lib-matrix rebuilds) before the merge.
- Settled earlier by the controller: autolinking 58.0.15 and macros 0.22.0 as exact npm dependencies; X4/X5/P3/P4 stay vendored-only (57); the default-peer router pair gets build-and-launch only.
