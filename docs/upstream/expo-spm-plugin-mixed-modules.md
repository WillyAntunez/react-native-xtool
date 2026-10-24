# Expo SwiftPM plugin: build mixed, Objective-C-only and placeholder modules; skip meta pods; dev client

Target: `expo/expo`, `packages/expo/scripts/spm/` (`classify.js`, `podspec.js`, `plugin.js`, `manifests.js`,
`diagnostics.js`). Seen with expo 58.0.17. The full diff is `patches/expo+58.0.17.patch` (every hunk marked
`expo-xtool`).

## What the plugin refuses today

A module with no prebuilt XCFramework and no checked-in `Package.swift` is built from source only when it is
**pure Swift**: no `.m/.mm/.c/.cpp/.cc` file under `ios/` or `apple/`. Everything else stays uncovered and the
sync fails (`mixed-no-manifest`, or `prebuild-available` when it has an `spm.config.json`). From a survey of
35 modules (`docs/research/mixed-modules-survey.md`):

| Module (SDK 58) | Shape | Today | Why it matters |
|---|---|---|---|
| expo-application | Swift + one ObjC class (`EXProvisioningProfile`) the Swift uses | refused | expo-notifications depends on it |
| expo-json-utils, expo-structured-headers | pure Objective-C | refused (the pure-Swift rule wants zero C-family files) | expo-updates depends on them |
| expo-updates-interface | Swift + `noop-file.m` (a comment only) | refused | dev client chain |
| expo-dev-client | podspec with dependencies only, no `source_files` | an empty Swift package (SwiftPM rejects a target without sources) | dev client chain |
| expo-sqlite | Swift + SQLite amalgamation in `vendor/` that the podspec copies into `ios/` at `pod install` | taken for pure Swift and emitted without SQLite: fails late | silent breakage |

The `mixed-no-manifest` message says "Swift Package Manager compiles Swift and Objective-C in separate
targets". That was true until Swift 6.4.

## Why the plugin can accept them now

SwiftPM 6.4 builds a target that mixes Swift and C-family sources in experimental multi-language mode
(`// swift-tools-version: 6.4;(experimentalMultiLang)`); SE-0541 (accepted) makes it standard in
tools-version 6.5. One mixed target is what CocoaPods builds for a mixed pod (one framework), so the plugin
needs no knowledge of which language depends on which. It works in both directions:

- Swift → Objective-C of the same module: a CocoaPods framework's Swift sees the pod's umbrella header. The
  generated target gets the same through `-import-objc-header umbrella.h`, which lists Foundation, UIKit and the
  module's own headers (minus C++ ones Swift cannot import). Xcode refuses bridging headers in framework
  targets, so a mixed pod never brings its own.
- Objective-C → Swift (`#import "<Pod>-Swift.h"` / `<Pod/Pod-Swift.h>`): Swift Build writes `<Target>-Swift.h`
  into one directory of the root build (`.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos`). The
  manifest reads it from `RN_SPM_SWIFT_HEADERS_DIR` (the same variable React Native's scaffolder uses for mixed
  libraries; expo-xtool sets it) and passes `-I` to clang. A forwarder `pod-headers/<Pod>/<Pod>-Swift.h`
  covers the framework form (see "Dev client chain" below for the rest of `pod-headers`).

## Changes

1. **Classification** (`classify.js#scanAppleSources`) also reports `hasSwift`, `hasClang`, `hasCxx`,
   `placeholderFiles` (C-family files that are empty or comments only) and `vendorSources` (C-family files
   under `vendor/`). A placeholder does not make a module mixed, and is excluded from the pure-Swift target.
2. **Podspec facts** (`podspec.js#readPodspecFacts`) add `declaresSourceFiles` (any `*.source_files` line
   outside test specs) and `referencesVendor` (a `'vendor'` / `/vendor/` path in the podspec body). Text-only,
   like the rest of `podspec.js`.
3. **Layout** (`plugin.js#sourceLayout`) picks how a module without a manifest is built:

   ```js
   function sourceLayout({ sources, podspec }) {
     if (podspec.referencesVendor && sources.vendorSources.length > 0) return 'vendored'; // refused
     if (sources.hasSwift && sources.hasClang) return 'mixed';
     if (sources.hasClang) return 'clang';
     if (sources.hasSwift) return 'pure-swift';
     if (!podspec.declaresSourceFiles) return 'meta';   // nothing emitted, nothing refused
     return sources.hasSources ? 'pure-swift' : null;   // unchanged behaviour
   }
   ```

   `linkSourceModules` emits `mixed` and `clang` through the new `emitGeneratedSourcePackage`, marks a meta pod
   as linked (`linkedAs: 'meta'`, listed in the log, no package) and records a `vendored-sources` refusal
   with its own diagnostic. The partially-precompiled check applies to every generated layout. Pure-Swift
   modules keep `emitPureSwiftSourcePackage` unchanged (plus the placeholder excludes).
4. **Emitter** (`manifests.js#generatedSourceManifest` / `emitGeneratedSourcePackage`): the pure-Swift manifest
   shape (one target at `root/<ios|apple>`, test dirs excluded, privacy manifest copied, documented SPM
   packages) plus:

   ```swift
   // swift-tools-version: 6.4;(experimentalMultiLang)          // 'mixed' only; 'clang' keeps 6.0
   let rnSpmSwiftHeadersDir = Context.environment["RN_SPM_SWIFT_HEADERS_DIR"]
       ?? (Context.packageDirectory + "/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos")
   ...
   publicHeadersPath: ".",                                      // `<Pod/Header.h>` for ios/<Pod>/Header.h
   cSettings:   [.unsafeFlags(["-F", <interfaces>]), .define("RCT_NEW_ARCH_ENABLED", to: "1"),
                 .unsafeFlags(["-I", rnSpmSwiftHeadersDir]), .unsafeFlags(["-I", "<pkg>/pod-headers"])],
   cxxSettings: [... same ..., .unsafeFlags(["-std=c++20"])],  // only with .mm/.cpp: SwiftPM 6.4 ignores
                                                                // cxxLanguageStandard in a mixed target
   swiftSettings: [.unsafeFlags(["-F", <interfaces>, <macro plugin>, "-import-objc-header", "<pkg>/umbrella.h"])],
   ```

   A header is left out of the umbrella when, after dropping `#if(def) __cplusplus` branches and comments, it
   has C++ syntax (`namespace`, `template<`, `std::`, a class body) or includes a C++ standard header or the
   `react/`, `jsi/`, `folly/`, `ReactCommon/` trees. `umbrella.h` and the forwarder are rewritten only on change.

## Dev client chain (expo-dev-client 58.0.15)

expo-dev-client is a meta pod over expo-dev-launcher and expo-dev-menu (both circular mixed modules),
expo-dev-menu-interface, expo-manifests, expo-updates-interface and expo-json-utils. With the changes above
they were classified correctly, but the build failed in four places; each fix below is generic.

5. **Xcode-only resources** (`classify.js#scanAppleOnlyResources`, both emitters, `diagnostics.js#renderDroppedResourceWarning`).
   SwiftPM processes `*.xcassets`, `*.xib`, `*.storyboard`, Core Data models, `*.metal` and Core ML models on its
   own when they sit in a target's directory, with compilers only Xcode ships. On Linux the build stopped at
   planning: `actool is not an executable file`. They are now excluded from every generated target (pure Swift
   too) and listed in a warning. CocoaPods compiles expo-dev-launcher's and expo-dev-menu's `Assets.xcassets`
   into `EXDevLauncher.bundle` / `EXDevMenu.bundle`; without them the dev launcher's and dev menu's icons are
   missing (`getDevLauncherBundle()` falls back to the main bundle, no crash). Upstream, on macOS, the right
   fix is the opposite: read `resource_bundles` and emit the catalogs as resources (see Limits).
6. **CocoaPods module names** (`podspec.js` `headerDir` / `moduleName`, `plugin.js#generatedModuleName`). CocoaPods
   names a pod's module `module_name`, else `header_dir`, else the pod name (as a C99 identifier). The plugin
   named the generated target after the pod, so `expo-dev-menu` became module `expo_dev_menu` while its
   dependents and ExpoModulesProvider import `EXDevMenu` (`expo-dev-menu-interface` → `EXDevMenuInterface`).
   The generated package, product and target now carry the CocoaPods module name. Interpolated values
   (`"#{s.name}"`) are ignored.
7. **Dependencies between generated packages** (`plugin.js#generatedPackageIndex`, `manifests.js`). A generated
   package depended only on React and ExpoModulesCore; `import EXManifests` in expo-dev-menu failed with
   `unable to resolve module dependency`. Before emitting, the plugin indexes every pod it will emit as a
   generated package (no manifest, no linkage, not precompiled, buildable layout); each podspec `dependency`
   (subspec ones included) that names one becomes `.package(name:, path:)` + `.product(...)`. Emission order no
   longer matters. Dependencies on packages with a checked-in manifest are not added (none needed here).
8. **`pod-headers/`** (`manifests.js#writePodHeaders`): the include paths CocoaPods gives a pod and its
   dependents, as forwarding headers beside the manifest:
   - `<Pod>/<Pod>-Swift.h` → `<Pod>-Swift.h`, now for every package with Swift (pure Swift too):
     expo-dev-launcher imports `<EXUpdatesInterface/EXUpdatesInterface-Swift.h>`;
   - `<Pod>/<Pod>-umbrella.h` → the generated `umbrella.h` (expo-dev-menu's `EXDevMenu.h` imports the
     CocoaPods-generated `<EXDevMenu/EXDevMenu-umbrella.h>`);
   - `<header_dir>/<Header>.h` → each header of the module wherever it sits: CocoaPods flattens headers under
     `header_dir`, so `<EXDevLauncher/EXDevLauncherController.h>` resolves although the file is
     `ios/EXDevLauncherController.h`.

   A mixed or `header_dir` package searches its own `pod-headers`; every generated package searches its
   dependencies' `pod-headers` and `rnSpmSwiftHeadersDir`, and gets
   `-fmodule-map-file=<rnSpmSwiftHeadersDir>/<Dep>.modulemap` for each Swift dependency:
   expo-dev-launcher's headers do `@import EXManifests;`, and Swift Build hands a Swift target's module map
   only to that target's own consumers' Swift compiles, not to another package's clang. A mixed target's Swift
   compile gets the same paths as `-Xcc` flags, because its umbrella (bridging header) includes those headers.

Outside the plugin, two more pieces were needed (both in expo-xtool's `patches/` or generator):

- React Native's per-app header farm (`ReactAppHeaders`) was an umbrella module of C++ headers, so
  `EXDevLauncherController.m` (Objective-C) importing `<ReactAppDependencyProvider/RCTAppDependencyProvider.h>`
  failed; see `docs/upstream/react-native-scaffolder.md` #12.
- A Swift module compiled with a bridging header carries it: every module importing `EXDevLauncher` re-reads
  `umbrella.h`, so the app's Swift (ExpoModulesProvider.swift) needs the same header search paths and module
  maps. expo-xtool adds them to the app target (`src/generate/expoImporter.ts`), from the Expo packages the
  autolinking manifest references, only when one of them is mixed. CocoaPods does the same through
  `user_target_xcconfig` / the Pods' public header search paths. ExpoModulesProvider also registers
  debug-only modules under `#if EXPO_CONFIGURATION_DEBUG`, which CocoaPods defines for the app; expo-xtool's
  app target now defines `EXPO_CONFIGURATION_DEBUG` / `EXPO_CONFIGURATION_RELEASE` per configuration.

## Verified

- Unit tests (`tests/expo-plugin.test.ts`): fixtures for mixed (with ObjC++, a guarded header, a C++ header,
  `Tests/`), pure ObjC, a comment-only `.m` and a blank `.c`, a meta pod, a podspec that declares sources but
  ships none, and an expo-sqlite-shaped `vendor/`.
- Real build (Swift 6.4.1, swiftbuild, Darwin SDK on Linux): an Expo SDK 58 app with expo-notifications
  builds and links; expo-application is emitted as one mixed target, `_OBJC_CLASS_$_EXProvisioningProfile` and
  `ExpoApplication.ApplicationModule` are in the app binary.
- Real build of the dev client (expo-dev-client 58.0.15): `expo-xtool build` exits 0; the app binary holds
  `_OBJC_CLASS_$_EXDevLauncherController`, `EXDevLauncher.DevLauncherModule`,
  `ExpoDevLauncherAppDelegateSubscriber`, `EXDevMenu.DevMenuModule`; ExpoModulesProvider.o references the
  dev-launcher and dev-menu module types (registered in Debug).
- The emitted packages built standalone: expo-json-utils 58.0.1 (Clang target) and a circular fixture (Swift
  uses an ObjC class; a `.m` imports `<MixMod/MixMod-Swift.h>`; a `.mm` imports `"MixMod-Swift.h"` and uses
  C++20 concepts).

## Alternative: split targets

Expo's own manifests split a mixed module into a Swift and an Objective-C target: expo-constants
(`EXConstants` + `EXConstantsObjC`), @expo/log-box (Swift + Clang target), and the prebuild configs
(`spm.config.json`, e.g. expo-application's `ExpoApplication_ios_objc` + `ExpoApplication`). That works on any
SwiftPM, but the plugin would have to know the direction of every dependency, and a circular module
(expo-dev-menu, expo-dev-launcher) needs a pre-compile `-Swift.h` step. One mixed target needs neither; the cost
is Swift ≥ 6.4. A plugin that must support older toolchains could fall back to the split for modules whose
Swift does not reference their own Objective-C, or keep refusing.

## Limits

- **Swift 6.5**: SE-0541 drops the `experimentalMultiLang` suffix. The manifest should then be emitted with
  `// swift-tools-version: 6.5` (or a `Package@swift-6.5.swift` beside it). Not done: no 6.5 toolchain here.
- **Swift header path**: outside expo-xtool, `RN_SPM_SWIFT_HEADERS_DIR` is unset and the fallback points into
  the generated package's own `.build`, which is wrong for an app build; an Objective-C file importing
  `<Pod>-Swift.h` then fails with "file not found". Upstream, the plugin could pass the path the build will use.
- **Public headers** are the whole source directory. `<Pod/Header.h>` resolves only when headers live in
  `ios/<Pod>/` (Expo's layout); a header directly in `ios/` is reachable only by its bare name.
- **Podspec settings are not read**: `xcconfig` / `pod_target_xcconfig` flags and defines, `compiler_flags`,
  `resource_bundles` other than the privacy manifest (`header_dir` / `module_name` are read since the dev
  client). For the dev client this drops `EX_DEV_LAUNCHER_VERSION` (the launcher reports no version string),
  `USE_HERMES` (`EXDevMenuAppInfo` reports the engine as JSC), `EX_DEV_CLIENT_NETWORK_INSPECTOR` (the network
  inspector is compiled out), `REACT_NATIVE_TARGET_VERSION` and `EX_DEV_MENU_ENABLED` (unused in the sources).
  Linkage (`frameworks`) still refuses the module, as before.
- **Asset catalogs** and other Xcode-only resources are dropped on every host (fix 5). On macOS the plugin
  could instead emit them (`resources: [.process("Assets.xcassets")]`), but the bundle SwiftPM builds is
  named `<Package>_<Target>.bundle`, while pods look theirs up by the CocoaPods name (`EXDevLauncher.bundle`):
  supporting `resource_bundles` needs that name, not just the files.
- **Pod dependencies on manifest packages** (e.g. a generated module depending on expo-constants) are not
  wired; only generated-to-generated dependencies are.
- **expo-sqlite** is refused (`vendored-sources`), not built: it needs a C target over
  `vendor/sqlite3/sqlite3.c` with the podspec's `-DSQLITE_*` cflags (and the same `-Xcc` flags for Swift), and
  the `vendor/sqlcipher` copy left out. Because it ships an `spm.config.json`, the report shows the
  higher-priority `prebuild-available` reason first.
- **Meta pod rule**: a podspec without `source_files` and no sources on disk. A podspec that builds its file
  list dynamically without a `*.source_files` line would be taken for one.
- **Cross-module Swift headers** (expo-dev-launcher imports `EXUpdatesInterface-Swift.h` and
  `EXManifests-Swift.h`): reachable through `RN_SPM_SWIFT_HEADERS_DIR` and the dependencies' `pod-headers`;
  built in the real app. The app-side flags (bridging header re-read by importers) are expo-xtool's; another
  SwiftPM host needs the equivalent.
