# Spike: Expo SDK 57 (React Native 0.86.3) through Expo 58's SwiftPM plugin and RN 0.88's SwiftPM scripts

Date: 2026-10-27, 13:00 to 13:40 local (about 1 h 45 min of the 4 h box, report included).
Throwaway. No commits. Nothing in the main checkout (`expo-xtool/`) or the Expo 58 reference app (`app/`) was edited:
`git status` in expo-xtool is clean (this file is under the gitignored `.superpowers/`), and the reference app shows only
its pre-existing `M App.tsx`. Nothing was installed on a device, and Metro was not started.

## Verdict

**Yes, it builds.** The SDK 57 blank-typescript template produced `ios-xtool/xtool/App.app` (95 MB). Its
`ExpoModulesCore.framework` is byte-identical to SDK 57's own npm prebuild, and its `React.framework` is RN 0.86.3's
(md5 matches the 0.86.3 slot). With expo-haptics, react-native-screens, expo-image-picker, expo-router and
safe-area-context added, the app also builds (131 MB), but that needed hand edits to generated manifests (X6 below).
SDK 57's own pins of reanimated and worklets did **not** build.
**Runtime is unverified.** Nothing was launched.

The blocker I feared, no precompiled ExpoModulesCore for 57, **does not exist**: SDK 57 ships ExpoModulesCore
(and ExpoModulesWorklets, ExpoFileSystem, ExpoFont) as Debug and Release xcframework tarballs inside the npm packages,
the same way SDK 58 does. The only artifact SDK 57 lacks is `ExpoModulesJSIHeaders.xcframework`. I synthesized it from a
Linux build of expo-modules-jsi 57.1.3, and Expo 58's plugin picked it up through its own `EXPO_PRECOMPILED_MODULES_PATH`
lookup, with no plugin edit.

## Paths (all throwaway)

Root `$SP` = `<scratch>/spike57`

- App: `$SP/Spike57` (`rn-xtool.config.json`: `metroPort` 8083, `rnArtifactsDir` = `app-bare-086/ios/build/rn-artifacts/0.86.3`)
- Extracted npm tarballs (data only): `$SP/tarballs/x-*`, `$SP/tarballs/emc57-debug`, `emc58-debug`, `jsih58`
- Vendored copies: `$SP/Spike57/.spike/{expo-spm, rn-spm, rn-spm-generate.js, build-jsi.sh}`; pristine copies in `.spike/orig/`
- Vendored Expo 58 JS packages: `$SP/Spike57/.spike/node_modules/{expo-modules-autolinking, expo-modules-macros, @expo/platforms, @expo/require-utils, @expo/modules-macros-linux-x64}` (copied from `app/node_modules`)
- Synthesized JSI headers: `$SP/Spike57/.spike/precompiled/expo-modules-jsi/output/headers/xcframeworks/ExpoModulesJSIHeaders.xcframework` (made by `.spike/make-jsi-headers.sh`)
- Spike CLI copy: `$SP/Spike57/.spike/rnx` (`node_modules` symlinked to the main checkout's)
- Diffs: `$SP/vendored-edits.diff` (vendored scripts against pristine), `$SP/rnx-dist.diff` (CLI copy against the main `dist/`)
- Logs: `$SP/{create,prebuild,run1,run2,jsi1,jsi2,build1..6,build-haptics,build-screens{,2,3},build-rea{,2},build-picker,build-router{,2..6}}.log`

How to run the spike build:
`SPIKE_SCAFFOLD_SKIP=expo SPIKE_EXPO_SPM_PLUGIN=$S/expo-spm/plugin.js EXPO_PRECOMPILED_MODULES_PATH=$S/precompiled node $S/rnx/bin/rn-xtool.js build` (with `S=$SP/Spike57/.spike`).

## 1. Recon

### Versions (npm, `sdk-57` dist-tag = 57.0.31; `latest` = 58.0.20)

| Package | Latest 57.x | Exists | Note |
|---|---|---|---|
| expo | 57.0.31 | yes | |
| expo-modules-autolinking | 57.0.16 | yes | |
| expo-modules-core | 57.0.24 | yes | deps: `expo-modules-jsi ~57.1.3`, `@expo/expo-modules-macros-plugin 0.6.1`; peer `react-native-worklets ^0.7.4 \|\| … \|\| ^0.10.0` |
| expo-modules-jsi | 57.1.3 | **yes** | source plus `apple/Package.swift`; **no `prebuilds/`** |

### SwiftPM support in SDK 57

- `expo@57.0.31/scripts/` has `autolinking.rb, compose-source-maps.js, node-binary.sh, react-native-xcode.sh, resolveAppEntry.js, xcode`: there is **no `scripts/spm/`**.
- `expo/react-native.config.js` has **no `spm.autolinkingPlugin`** key (58 has `spm: { autolinkingPlugin: './scripts/spm/plugin.js' }`).
- expo-modules-autolinking 57 lacks `commands/prebuiltMetadataCommand.js`, `prebuiltMetadata.js` and `platforms/apple/moduleScanner.js` (the `@ExpoModule` scanner). Its `generate-modules-provider` has no `--target-platform` option. Expo 58's plugin calls both `prebuilt-metadata --json` and `generate-modules-provider --target-platform ios`.
- No checked-in `Package.swift` in `expo`, `expo-constants` or `expo-modules-core` (58 ships one in `expo` and `expo-constants`).
- `spm.config.json` (the prebuild product description) **is** present: in expo-modules-core (identical to 58's except that 58 adds `"headersXCFramework": true`, `"publishPrebuilds": true` and two `Benchmarks/**` excludes), in expo-modules-jsi, and in expo-haptics and other modules.
- `expo-modules-jsi@57.1.3/apple/Package.swift` exists. Against 58 it lacks the `EXPO_CUSTOM_BUILD_ROOT` support (it writes `.generated/module.modulemap` into the package) and the `-Werror` groups. Its `generate-modulemap.sh` uses `umbrella header "jsi.h"` (58 lists the headers one by one).

### Where SDK 58's plugin gets ExpoModulesCore precompiled

There is **no network download** in `expo/scripts/spm/*` or in the autolinking plugin; the only URLs are issue links. `plugin.js:1164` caches into `ios/build/expo-xcframeworks`. The lookup (from `expo/scripts/spm/README.md`, in `flavored-frameworks.js`) is:
1. `EXPO_PRECOMPILED_MODULES_PATH/<package>/output/<flavor>/xcframeworks`
2. `packages/precompile/.build/<package>/output/<flavor>/xcframeworks` (Expo monorepo)
3. `<installed-package>/prebuilds/output/<flavor>/xcframeworks` (published npm package)

The headers use the same lookup with `<flavor>` = `headers`. There is no version pinning beyond the installed package: the
`expo-package.json` stamp in a headers xcframework must equal the installed package version (`assertHeadersMatchSources`).

### Artifacts for 57 (shipped inside the npm tarballs)

| Artifact | SDK 57 | SDK 58 |
|---|---|---|
| `expo-modules-core/prebuilds/output/debug/xcframeworks/ExpoModulesCore.tar.gz` | **present**, 15.4 MB | present, 15.9 MB |
| `…/release/…/ExpoModulesCore.tar.gz` | **present**, 13.6 MB | present, 14.1 MB |
| `…/{debug,release}/…/ExpoModulesWorklets.tar.gz` | present | present |
| `expo-modules-core/prebuilds/output/headers/xcframeworks/ExpoModulesCoreHeaders.tar.gz` | **absent** | present (only "direct" modules need it; none in this app) |
| `expo-modules-jsi/prebuilds/output/headers/xcframeworks/ExpoModulesJSIHeaders.tar.gz` | **absent** (no `prebuilds/` at all) | present (**the plugin requires it**) |
| `expo-file-system`, `expo-font` `prebuilds/output/{debug,release}` | present (surprise) | n/a in the reference app |

`curl -sI` HTTP status: 200 for `registry.npmjs.org/expo-modules-core/-/expo-modules-core-57.0.24.tgz`, `…-58.0.26.tgz`,
`expo-modules-jsi-57.1.3.tgz`, `…-58.0.19.tgz` and `@expo/modules-macros-linux-x64-0.22.0.tgz`.

How the 57 and 58 ExpoModulesCore (debug, ios-arm64) compare:
- Both `.swiftinterface` files were produced by `Apple Swift version 6.3.1`, with `-enable-library-evolution -swift-version 6`.
- Both module maps are identical (`framework module ExpoModulesCore { use React … }`).
- Both link the same dylibs: `@rpath/{hermesvm,React,ReactNativeDependencies,ExpoModulesJSI}.framework`, plus system frameworks.
- The 57 interface has `@_exported import ExpoModulesJSI` and declares 6 macros. 58 adds `UnionMacro` and a second `JSMacro`.
- The **57 tarballs carry macOS AppleDouble entries** (`._*` files, plus `LIBARCHIVE.xattr.com.apple.provenance` pax headers): 1074 `._*` files were extracted under `ios/build/expo-xcframeworks`. They are harmless, but they cause tar warnings and `-Wincomplete-umbrella` warnings.

Macro plugin: core 57 uses `@expo/expo-modules-macros-plugin@0.6.1`, whose `apple/ExpoModulesMacros-tool` is a
**Mach-O universal binary with no Linux build**. 58 uses `expo-modules-macros@0.22.0` with optional
`@expo/modules-macros-{linux,win32}-{x64,arm64}`.

Building ExpoModulesCore from source was not needed. For the record, the 57 sources (`ios/` + `common/`) hold 183 `.swift`,
13 `.m`, 20 `.mm`, 86 `.h` and 13 `.cpp` files. They depend on React, ReactNativeDependencies, Hermes and ExpoModulesJSI,
and the build is split into the three targets `spm.config.json` describes (cpp, objc, swift).

## 2. Project

- `npx --yes create-expo-app@latest Spike57 --template blank-typescript@sdk-57`: exit 0 in 44 s. It installed expo 57.0.31, **react-native 0.86.3**, react 19.2.3, expo-status-bar 57.0.1, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16, expo-modules-jsi 57.1.3, `@expo/expo-modules-macros-plugin` 0.6.1, hermes-compiler 250829098.0.17 and `@react-native/codegen` 0.86.3. npm placed expo-constants under `node_modules/expo/node_modules/`.
- `app.json` has no `ios.bundleIdentifier`. I set `com.anonymous.spike57` (what rn-xtool would write) and then ran `CI=1 npx expo prebuild --platform ios --no-install`: exit 0.
- iOS template:
  - **AppDelegate.swift only, no SceneDelegate.** `class AppDelegate: ExpoAppDelegate` creates its own `UIWindow`, uses `ExpoReactNativeFactory` + `ExpoReactNativeFactoryDelegate`, and imports `internal import Expo`, `import React` and `import ReactAppDependencyProvider`. The 58 template has AppDelegate + SceneDelegate.
  - Also present: an empty `Spike57-Bridging-Header.h`, `Spike57.entitlements` and `SplashScreen.storyboard`.
  - `IPHONEOS_DEPLOYMENT_TARGET = 16.4`, `SWIFT_VERSION = 5.0`, `CLANG_CXX_LANGUAGE_STANDARD = c++20`.
  - The Podfile defaults to `EXPO_USE_PRECOMPILED_MODULES=1` (CocoaPods consumes the same npm prebuilds).

## 3. Vendor + run: every step

The setup:
- Expo 58's **patched** `app/node_modules/expo/scripts/spm/` (without `__tests__`) goes to `.spike/expo-spm/`.
- `expo-xtool/vendor/rn-spm/` goes to `.spike/rn-spm/`, and `scripts/rn-spm-generate.js` to `.spike/rn-spm-generate.js` (it already takes `--scripts-root` and sets `RN_SPM_RN_ROOT`).
- The driver runs from `ios/` with `--config-command '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]'` and `--artifacts <app-bare-086 adapted 0.86.3 root>`.
- Like the bare path, it does no xcodeproj injection. The Expo path's `setup-apple-spm.js add` is not used.

| # | Step | Outcome | Error, cause | Smallest workaround |
|---|---|---|---|---|
| a | Plugin discovery | FAIL (silent) | 57's `expo/react-native.config.js` declares no `spm.autolinkingPlugin`, so Expo modules would be autolinked as plain pods | **X1**: `autolinking-plugins.js` takes the plugin path for dep `expo` from `SPIKE_EXPO_SPM_PLUGIN` |
| b | Plugin → autolinking CLI | (avoided) | 57's CLI lacks `prebuilt-metadata` and `--target-platform` | Put expo-modules-autolinking **58.0.15 (rn-xtool-patched)** plus `@expo/platforms` and `@expo/require-utils` 58 in `.spike/node_modules`: the plugin's `require.resolve(..., {paths:[__dirname]})` finds it first. The generated `ExpoModulesProvider.swift` is **identical** to the one 57's own autolinking generates (diff: only the class name, which comes from the file name) |
| c | Macro plugin | (avoided) | `macroPluginTool` resolves `expo-modules-macros` from core 57, which depends on `@expo/expo-modules-macros-plugin` | **X2**: `paths: [coreModuleRoot, __dirname]`, plus vendored `expo-modules-macros` 0.22.0 and `@expo/modules-macros-linux-x64` 0.22.0. Source modules compile with `-load-plugin-executable …/modules-macros-linux-x64/ExpoModulesMacros#ExpoModulesMacros`. The 58 autolinking scanner (in the spike's rn-xtool-patched copy) prints `warning: Couldn't load expo-modules-macros from …/expo-modules-core, so only modules declared in expo-module.config.json will be linked` (the same as 57, which has no scanner). rn-xtool's own copy is unpatched: on Linux the scanner returns early, without that warning, with the same result |
| d | Codegen, autolinking.json, deployment target, version | OK | `iOS deployment target: 16.4`, `React Native version: 0.86.3`, 0.86.3's own codegen, "Installed SPM codegen template" | none |
| e | Expo plugin, run 1 | **FAIL** | `[expo-spm-plugin] ExpoModulesJSIHeaders.xcframework (or .tar.gz) was not found in …/precompile/.build/expo-modules-jsi/output/headers/xcframeworks, …/node_modules/expo-modules-jsi/prebuilds/output/headers/xcframeworks.` | Build JSI first, then synthesize the headers (rows f, g) |
| f | ExpoModulesJSI 57.1.3 build (`build-jsi.sh` = `scripts/build-expo-modules-jsi.sh` + **J1**: `REACT_HEADERS`/`DEPENDENCIES_HEADERS` overridable so that it runs from the adapted 0.86.3 slot before `ios/build/xcframeworks` exists) | 1st **FAIL**, then OK in 6 s | `JavaScriptError.swift:92:16: error: cannot use struct 'CppError' in an extension with public or '@usableFromInline' members; C++ types from imported module '__ObjC' do not support library evolution`: the same Swift 6.4 issue as in 58 | The same one-line fix (`public var message` → `var message`), kept as `rnx/patches/expo-modules-jsi+57.1.3.patch` |
| g | Synthesize `ExpoModulesJSIHeaders.xcframework` | OK | | `make-jsi-headers.sh` takes `ExpoModulesJSI.swiftinterface` (Swift 6.4.1, library evolution) and `ExpoModulesJSI-Swift.h` from the build's `Objects-normal/arm64`, `NativeState.h` from `Sources/ExpoModulesJSI-Cxx/include/Public`, `expo-package.json` = 57.1.3, and the module map, `Info.plist` and placeholder `.a` from 58's tarball (format-only). It is put at `EXPO_PRECOMPILED_MODULES_PATH/expo-modules-jsi/output/headers/xcframeworks` (lookup 1, no plugin edit) |
| h | Expo plugin, run 2 | **OK** | Classification: build phase: ExpoModulesJSI. Paired runtime frameworks: ExpoFileSystem, ExpoFont, ExpoModulesCore, ExpoModulesWorklets. Pure-Swift: ExpoDomWebView, ExpoAsset, ExpoKeepAwake. **Mixed: ExpoLogBox, Expo, EXConstants** (58 builds these from checked-in manifests). Not supported: none | |
| i | Artifacts (offline `--artifacts`, the adapted 0.86.3 slots) | OK | "Using debug/release artifacts (--download skip)" | none |
| j | generate-spm-package + finalize | OK | `build/xcframeworks/Package.swift`, `flavored-frameworks.json` | none |
| k | app-config (`getAppConfig.js` with `EXPO_CONSTANTS_ALLOW_NON_PODS=1`) | OK | `EXConstants.bundle/app.config` written | none |

## 4. ios-xtool + build

The global `rn-xtool build` stops with `✖ Expo SDK 57 is not supported; rn-xtool requires SDK 58 or newer`.

The spike CLI copy `.spike/rnx`: `dist`, `bin`, `shims`, `scripts` and `package.json` copied, `node_modules` symlinked,
`vendor/rn-spm` = the edited `.spike/rn-spm`, and `scripts/rn-spm-generate.js` = the spike driver. `patches/` holds
**only** `expo-modules-jsi+57.1.3.patch`: all four bundled 58/0.88 patches were removed, because they target other
versions. The edits to `dist/` (16 changed lines, `$SP/rnx-dist.diff`):
- **G1** `versions.js`: `MIN_EXPO_SDK = 57`.
- **G2** `project/expo.js`: `rnScripts: "vendored"`.
- **G3** `pipeline/rnSpm.js`: the guard against Expo with vendored scripts is disabled. Expo projects on vendored scripts run the bare driver (no injection) with `--config-command <expo autolinking>` on both the run and the scaffold argv.
- **G4** `generate/iosXtool.js`: SceneDelegate.swift is copied only when it exists.

| Run | Result | Error, cause | Fix |
|---|---|---|---|
| build1 | patches, rn-spm, jsi, app-config, frameworks OK; **generate FAIL** | `✖ Missing SceneDelegate.swift: …/ios/Spike57/SceneDelegate.swift`: the SDK 57 template is AppDelegate-only | G4 |
| build2 | xtool-build **FAIL** | `…/expo-source/Expo/pod-headers/Expo/Expo-Swift.h:1:9: error: 'Expo-Swift.h' file not found with <angled> include` via `umbrella.h:11` → `expo/ios/Swift.h:10`. The mixed route puts every public header in the Swift bridging umbrella, including 57's `expo/ios/Swift.h`, which imports the module's own `-Swift.h`, and that header does not exist while Swift compiles | **X3** (`manifests.js`): headers that import `<Pod>-Swift.h` stay out of the umbrella |
| build3 | same | my X3 regex used `product.name` (`product` is a string) | fixed |
| build4 | xtool-build **FAIL** | `EXConstantsService.m:8:9 'EXConstants/EXConstantsService.h' file not found`: 57's expo-constants keeps its headers flat in `ios/` and relies on CocoaPods' default header dir (= pod name) | **X4** (`manifests.js`): `headerDir: headerDir ?? product` for generated mixed/clang packages, so `pod-headers/EXConstants/*.h` forwarders are written |
| build5 | xtool-build **FAIL** | `EXLegacyAppDelegateWrapper.h:14:54: error: no type or protocol named 'UIApplicationDelegate'` (and 6 follow-ons): 57's header relies on CocoaPods' `<Pod>-prefix.pch` importing UIKit | **X5** (`manifests.js`): each generated mixed/clang package gets a `prefix.pch` (`#ifdef __OBJC__ #import <UIKit/UIKit.h> #endif`) passed with `-include` to C and C++ |
| **build6** | **OK**: patches 0.1 s, rn-spm 3.2 s, jsi 1.3 s (cached), frameworks 0.4 s, xtool-build 16.9 s | 606 warnings, 0 errors. Top warnings: nullability (92); `umbrella header for module 'ExpoModulesCore' does not include header '._…'` (from the AppleDouble files); `cannot find protocol definition for 'RCTHostDelegate'` ×9 (in Expo's Objective-C, worth watching at runtime) | |

What `App.app` contains (95 MB):
- Executable `App`, `Info.plist` (no unresolved `$(…)`, `RCTMetroPort` 8083), `ip.txt`, `EXConstants.bundle`, `EXConstants_EXConstants.bundle`.
- `Frameworks/`: ExpoFileSystem, ExpoFont, ExpoModulesCore, ExpoModulesJSI, ExpoModulesWorklets, React, ReactNativeDependencies, hermesvm.
- md5 `ExpoModulesCore` = `b4108d6e…` = the 57 npm prebuild. md5 `React` = `2e2e5156…` = the raw 0.86.3 slot. So **SDK 57's prebuilt ExpoModulesCore links against RN 0.86.3's React binary with no unresolved symbols.**

## 5. Libraries (each added with `npx expo install`, then `rnx build`)

| Library (installed version) | Result | Notes |
|---|---|---|
| expo-haptics 57.0.3 | **builds** (52 s) | pure-Swift source package |
| react-native-screens **4.26.2** (SDK 57's pin, not 4.30) | **builds** after D1 + S1 (xtool-build 62 s) | Try 1: rn-xtool's scaffold step ran `scaffoldAll` over every autolinked dep and **also wrote `node_modules/expo/Package.swift`** (57's expo has a podspec and no manifest). The Expo plugin then refused expo: `error: Expo module "expo" (pod Expo) ships a Package.swift the generated package cannot mirror, so it was skipped.` **D1** (driver): `scaffoldAll({..., skipDeps})` from `SPIKE_SCAFFOLD_SKIP=expo`. Try 2: `RNScreens-Swift.h file not found` through `umbrella.h:34 → ios/bridging/Swift-Bridging.h` (4.26 only; 4.30 dropped that file): the same class of bug as X3, but in RN's scaffolder. **S1** (`scaffold-package-swift.js`): headers that import `<Module>-Swift.h` stay out of the Swift umbrella |
| react-native-reanimated **4.5.1** + react-native-worklets **0.10.4** (SDK 57's pins) | **FAIL** (stopped) | Neither ships a Package.swift, so both are scaffolded. (1) `WorkletsVersion.cpp:19:22: use of undeclared identifier 'WORKLETS_VERSION_STRING'`: the podspec's `version_flag = "-DWORKLETS_VERSION=#{package['version']}"` inside `OTHER_CFLAGS` is not translated (reanimated has the same with `REANIMATED_VERSION`). After a hand-added define (L1): (2) `WorkletsModule.mm:6:9: fatal error: 'worklets/apple/AnimationFrameQueue.h' file not found`: a subspec `header_mappings_dir = "apple/worklets"` under `s.header_dir = "worklets"` is not mapped. These are scaffolder gaps that bare 0.86 + worklets 0.10 would hit too. Uninstalled before the next library |
| expo-image-picker 57.0.20 | **builds** (77 s) | pure-Swift |
| expo-router 57.0.29 + react-native-safe-area-context 5.7.0 | **builds with hand edits** (131 MB) | **Surprise**: expo-router 57 has hard *dependencies* on `@expo/ui` 57.0.26, `react-native-drawer-layout` (→ **react-native-reanimated 4.7.1**), `@react-native-masked-view/masked-view` 0.3.2 and `react-native-gesture-handler` `*` (3.4.0), and pulls **react-native-worklets 0.13.1**. npm flags it: `react-native-worklets@0.13.1 invalid: "^0.7.4 \|\| ^0.8.0 \|\| ^0.9.0 \|\| ^0.10.0" from node_modules/expo-modules-core`. These newer versions ship their own Package.swift. (1) `libs/RNReanimated/Package.swift:26:12: error: cannot find 'CFGetTypeID' in scope`: the known Linux-host manifest bug (`docs/upstream/reanimated-worklets-manifest.md`), fixed by applying the 58 app's `patches/react-native-reanimated+4.7.1.patch` and `react-native-worklets+0.13.0.patch` (L2; the latter applies cleanly to 0.13.1). (2) `RNScreens/rn-spm-swift/../ios/RNSFullWindowOverlay.h:6:9: fatal error: 'RNSReactBaseView.h' file not found` in `SwiftDriver ExpoRouter`, then the same in `SwiftDriver App`. ExpoRouter does `import RNScreens`, and Swift re-reads the scaffolded RNScreens bridging umbrella without RNScreens' private header search paths (`ios/bridging`, …). Also, the generated ExpoRouter package declares no RNScreens dependency: the podspec uses `add_dependency(s, "RNScreens")`, a Ruby helper, not `s.dependency`. **X6** (hand edit of the generated manifests, then `xtool dev build` run directly): add `-Xcc -I<screens>/<each headerSearchPath>` to ExpoRouter's and the App target's `swiftSettings`. Then **OK**. Every Expo source module classified fine (pure-Swift: ExpoGlassEffect, ExpoLinking, ExpoRouter, ExpoSymbols; mixed: ExpoUI). `ExpoModulesWorkletsAdapter` was left out with the plugin's warning ("links its pod ExpoModulesCore as a precompiled XCFramework, so its product … is left out"), the same behavior as on 58 |

A note on running xtool directly: when `RN_SPM_SWIFT_HEADERS_DIR` is not set, the generated mixed manifests fall back,
and `'Expo-Swift.h' file not found with <angled> include` appears. The CLI sets that variable (`src/tools/xtool.ts:155`);
it is not an SDK 57 issue.

## All edits to vendored copies (full diff: `$SP/vendored-edits.diff`)

- **X1** `rn-spm/spm/autolinking-plugins.js` (+5): when the dep named `expo` declares no plugin and `SPIKE_EXPO_SPM_PLUGIN` is set, that path is used.
- **S1** `rn-spm/spm/scaffold-package-swift.js` (+12): `umbrellaHeaders` drops headers that `#import` `<podModule|swiftName>-Swift.h`.
- **X2** `expo-spm/plugin.js` (+2): `macroPluginTool` resolves `expo-modules-macros` from `[coreModuleRoot, __dirname]`.
- **X3** `expo-spm/manifests.js` `emitGeneratedSourcePackage` (+6): umbrella headers that import `<product>-Swift.h` are dropped.
- **X4** `expo-spm/manifests.js` (+3): `headerDir: headerDir ?? product`.
- **X5** `expo-spm/manifests.js` `generatedSourceManifest` (+6): writes `prefix.pch` and adds `-include` to the C/C++ settings.
- **D1** `rn-spm-generate.js` (+3): `skipDeps` from `SPIKE_SCAFFOLD_SKIP`.
- **J1** `build-jsi.sh` (2 lines): `SPIKE_REACT_HEADERS` and `SPIKE_DEPS_HEADERS` overrides.
- New: `make-jsi-headers.sh` (about 30 lines). Vendored as-is: expo-modules-autolinking 58.0.15 (rn-xtool-patched), expo-modules-macros 0.22.0, `@expo/platforms`, `@expo/require-utils` 58.0.4 and `@expo/modules-macros-linux-x64` 0.22.0.
- Scratch `node_modules` (not vendored): the expo-modules-jsi 57.1.3 one-liner; L1 (abandoned, worklets/reanimated 4.5 defines); L2 (CF manifest patches); X6 (hand edits to generated manifests, overwritten on the next `rnx build`).

## What a real implementation would need

1. **Version plumbing**
   - An Expo SDK → RN table (57 ↔ 0.86.x, 58 ↔ 0.88.0) and an `MIN_EXPO_SDK` of 57; refuse other pairings.
   - For SDK 57: `rnScripts = "vendored"` and a new "expo plugin = vendored" mode.
   - `runRnSpm`: Expo projects on vendored scripts must use the driver (no xcodeproj injection) with the Expo `--config-command` (G3).
   - `buildSteps` must run `rn-artifacts` (the 0.86 adapter) for Expo projects too: it is excluded today.
   - Bundled-patch selection per version: `expo-modules-jsi+57.1.x`; skip the expo/autolinking 58 patches. The vendored copies carry those fixes instead.
2. **Vendored Expo 58 plugin.**
   - Ship the patched `expo/scripts/spm/` (14 JS files, about 5.9k lines) in rn-xtool, together with its JS runtime: expo-modules-autolinking 58 (`build/`), `@expo/platforms` and `@expo/require-utils` 58, and `expo-modules-macros` 0.22 with its per-arch Linux binaries as dependencies.
   - Pin and provenance-test them the way `vendor/rn-spm` is.
   - Replace the env hacks with real seams: plugin discovery (X1), macro resolution (X2), and resolution of `@expo/config-plugins`/`xcode` from the app (that works today by accident through node's upward walk).
3. **ExpoModulesJSIHeaders for 57**, a new step that runs before `rn-spm`:
   - Build JSI against the artifact slot (J1).
   - Synthesize the headers xcframework with self-generated `Info.plist`, module map and empty `ar` archives (no 58 template).
   - Stamp the version and expose it through `EXPO_PRECOMPILED_MODULES_PATH`.
   - Today's `jsi` step then reuses that build. ExpoModulesCore itself needs **no** source build: SDK 57 publishes it.
4. **Generic generator fixes** (they also harden 58), with unit tests:
   - X3 and S1: no own `-Swift.h` in Swift umbrellas.
   - X4: default header dir = pod name.
   - X5: a CocoaPods-style prefix header.
   - D1: the scaffold step must skip deps whose modules an SPM plugin provides.
   - Strip AppleDouble `._*` files when extracting Expo tarballs, or warn.
5. **App shell**: an AppDelegate-only Expo template (G4); an Info.plist without a scene manifest; the window created in AppDelegate. doctor and docs for SDK 57.
6. **Libraries**
   - Swift consumers of a scaffolded mixed library need that library's header search paths (X6). That is a generic rn-xtool gap; SDK 58 + expo-router would hit it too. Expo's podspec `add_dependency(s, …)` helper should also become a package dependency.
   - For SDK 57's own reanimated 4.5 / worklets 0.10 pins, two scaffolder gaps: Ruby-interpolated `-D` flags in `OTHER_CFLAGS`, and subspec `header_mappings_dir` under `header_dir`.
   - expo-router 57 pulls 58-era reanimated/worklets regardless: document it and keep the CF-manifest patches available.
7. **Risks**
   - Runtime is unverified: Expo boot, module registration, the `RCTHostDelegate` warnings, and dev-client/`expo-dev-launcher` on 57 were not tried.
   - Macro skew: source modules expand SDK 58's macros (0.22.0) against the 57 core interface. That compiled for 9 modules, but semantics are untested.
   - The JSI interface is produced by Linux Swift 6.4.1, while the core's comes from Xcode 6.3.1.
   - Only the debug flavor was built.
   - worklets 0.13.1 with core 57's peer range is formally invalid.
   - Each 57.0.x patch release can change prebuild contents, for example by adding or removing a precompiled module.

### Size estimate

Assumptions: one developer who knows this codebase; the 0.86 artifact adapter and vendored RN scripts already exist (they
do); the existing test patterns are reused; a device is available for one verification pass; no upstream changes are waited on.

| Work | Days |
|---|---|
| Version plumbing, gates, patch selection, Expo-on-vendored-scripts path, rn-artifacts for Expo | 1.5 |
| Vendoring the Expo 58 plugin, autolinking 58 and macros (packaging, provenance test, X1/X2 seams) | 1.5-2 |
| JSI headers synthesis step (no 58 template), ordering, cache stamp | 1 |
| X3/X4/X5/S1/D1 + AppleDouble stripping, with unit tests | 1-1.5 |
| App shell (AppDelegate-only), Info.plist, doctor/docs | 0.5-1 |
| Device verification of the template, haptics and image-picker, plus fixes for what it finds | 1-3 (most uncertain) |
| **Subtotal: SDK 57 template + Expo-module libraries** | **6.5-10** |
| X6 (propagating scaffolded mixed-library header paths to Swift consumers; generic) | 1-2 |
| Scaffolder fixes for reanimated 4.5 / worklets 0.10 (optional; expo-router brings 4.7/0.13 anyway) | 1-2 |
| **Total with expo-router and reanimated on 57** | **about 9-14** |
