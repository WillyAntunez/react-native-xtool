# Recipe: Expo SDK 57 and 58 iOS dev builds from Linux

The technical recipe behind `rn-xtool`, migrated from the original research notes (2026-10-23). The CLI
automates exactly these steps. Paths are relative to this repo. Sections 1 to 9 describe Expo SDK 58; the differences
for [Expo SDK 57](#expo-sdk-57-notes) and [bare React Native](#bare-react-native-notes) follow them.

## 1. Toolchain

- **Swift 6.4** via swiftly (`~/.local/share/swiftly`). SwiftPM older than 6.4 does not resolve xcframeworks on Linux
  (SwiftPM PR #9301, in 6.3, fixed binary-target `artifactPath` with `--build-system swiftbuild`; xtool PR #369 shipped
  a static xcframework built on Linux). `parseXCFrameworks` picks the `ios` slice regardless of host.
- **xtool 1.23.0** AppImage, used unmodified (pinned in `src/versions.ts`).
- **Darwin SDK** (iPhoneOS 27.1) extracted from the user's `Xcode.xip` into
  `~/.swiftpm/swift-sdks/darwin.artifactbundle` (about 7 GB). Sanity check: `xtool dev build` on
  `Examples/DemoSimple` builds in about 6.5 s.
- Install logic: `src/commands/setup.ts`; downloads in `src/tools/download.ts`; xtool wrapper in `src/tools/xtool.ts`.
- xtool uses `--build-system native` for cross hosts because swiftbuild 6.4 fails with "unable to find platform for
  iphoneos"; it works around this with `XCODE_EXTRA_PLATFORM_FOLDERS` and `toolset-swb.json`.

## 2. React Native 0.88 SwiftPM pipeline

RN runtime binaries (React, ReactNativeDependencies, hermes) never enter the SwiftPM graph; Xcode links and embeds them
through build settings. SwiftPM only sees headers: `build/xcframeworks/Package.swift` (`ReactHeaders` clang target plus
header-only binary targets `ReactNativeHeaders` and `ReactNativeDependenciesHeaders`), `build/generated/autolinking/Package.swift`
(aggregate `Autolinked`) and codegen `React-GeneratedCode` in `build/generated/ios`.

Pipeline: config, codegen, autolinking, download, package, inject. Only the last step needs an `.xcodeproj`.
macOS-only tools it calls: `plutil`, `otool` (in `flavored-frameworks.js`) and `pod ipc spec`.

`src/pipeline/rnSpm.ts` runs, from `ios/`:

```
node node_modules/react-native/scripts/setup-apple-spm.js add|update \
  --config-command '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]' \
  [--download skip --artifacts <rnArtifactsDir>]
```

`add` the first time, `update` once the marker `ios/<App>.xcodeproj/.spm-injected.json` exists. The `--config-command` makes Expo's autolinking
supply the module list (needed for Expo modules). Artifacts come from Maven (`repo.reactnative.dev/maven2`, falling back
to `repo1.maven.org/maven2`): `react-native-artifacts-<v>-reactnative-{core,dependencies}-{debug,release}.tar.gz` and
`hermes-ios-<hv>-hermes-ios-<flavor>.tar.gz`, cached in `~/Library/Caches/ReactNative/spm-artifacts/<v>/<flavor>`.
`rnArtifactsDir` (config) skips the download for offline use; release resolves to a symlink to debug. The Hermes
framework is named `hermesvm.framework`. Expo SDK 57 never runs `setup-apple-spm.js`: it uses the driver of the bare
path ([Expo SDK 57 notes](#expo-sdk-57-notes)).

## 3. Expo SPM plugin and patches

Expo 58 builds ExpoModulesCore as a Debug/Release dynamic pair; source modules compile against an "interface tree" of
headers, modulemaps and `.swiftinterface` files. ExpoModulesCore's interface was produced by Xcode's Swift 6.3.1 and
imports fine with Swift 6.4.1.

`src/pipeline/patches.ts` (`selectBundledPatches`) stages the bundled patch-package patches from `patches/` whose
package is installed: per package the patch for the installed version, else the highest version (react-native: only
its exact version). On a newer 58.x than the floor, the highest is the floor's patch: patch-package applies it with
its version warning, or, when it does not apply, the build stops with "rn-xtool could not patch <package>", whose SDK
58 remedy is an npm `"overrides"` block with the verified set, or waiting for an rn-xtool release. With the vendored
Expo plugin (SDK 57) only exact versions are staged. It applies them, then the project's own `patches/` (persisted
library `Package.swift` files) when present. Before that, the project read checks SDK 58's floor set (G1–G3,
`checkExpoPackages` in `src/project/expo.ts`, texts in [troubleshooting.md](troubleshooting.md#expo-sdk-58)). An Expo
SDK 58 project gets these four:

| Patch | Effect |
| --- | --- |
| `patches/expo-modules-autolinking+58.0.16.patch` | Removes the `process.platform !== 'darwin'` gate in the `@ExpoModule` scanner (the Linux macros binary `@expo/modules-macros-linux-x64` works). |
| `patches/expo+58.0.21.patch` | Expo's SPM plugin (`expo/scripts/spm/`): resolves the macro plugin binary per platform; adds the umbrella Foundation/UIKit imports to pure-Swift modules; builds mixed Swift + Objective-C and Objective-C-only modules; skips meta pods and placeholder files; links generated packages to their podspec dependencies (`s.dependency` and `add_dependency(s, "<Pod>")`, React Native libraries with a Package.swift included); leaves headers that import the module's own `<Product>-Swift.h` out of the Swift umbrella (X3); adds a scaffolded mixed dependency's importer paths to `swiftSettings` (X6c); excludes Xcode-only resources; refuses vendored-C modules (expo-sqlite). See `docs/upstream/expo-spm-plugin-umbrella.md` and `docs/upstream/expo-spm-plugin-mixed-modules.md`. |
| `patches/expo-modules-jsi+58.0.21.patch` | Swift 6.4 rejects a `public` member in an extension of a C++ type under library evolution (`CppError.message`); made internal. |
| `patches/react-native+0.88.1.patch` | About 1.95k lines across `read-podspec.js`, `scaffold-package-swift.js` and `spm-utils.js`: 16 generic fixes to RN's `spm scaffold` (Ruby bare lists and locals, subspecs, `header_dir`, platform-scoped fields, defines, mixed Swift + Objective-C/C++ targets, known CocoaPods dependencies mapped to SwiftPM packages, Swift umbrellas without the module's own `-Swift.h`, `#{package['version']}` in flags and defines, subspec `header_mappings_dir`, the `// rn-xtool-swift-importer-paths:` marker, ...) and a header-less module map for the per-app header farm. Scaffold revision 3. See `docs/upstream/react-native-scaffolder.md`. |

Two more are bundled. `patches/react-native+0.88.0.patch` is a byte-identical copy of the react-native patch for bare
React Native 0.88.0 (a test keeps the two identical, so a fix edits both). `patches/expo-modules-jsi+57.1.3.patch` is
the same `CppError.message` fix for expo-modules-jsi 57.1.3, and the only one an Expo SDK 57 project gets.

`expo-dev-client` builds through the Expo patch (dev-launcher and dev-menu as mixed targets, json-utils as an Objective-C target); its asset catalogs are dropped (no `actool` on Linux), so launcher and menu icons are missing.

## 4. Linux shims

`shims/plutil` and `shims/otool` are minimal replacements put first on `PATH` (with `swift`) by `toolEnv()` in
`src/tools/exec.ts`. They answer what the RN scripts ask (both flavors resolve to debug). Steps that Xcode does with
`xcodebuild` are replaced by `scripts/build-expo-modules-jsi.sh` and, for framework staging, `stageFrameworks` in
`src/frameworks.ts` (see section 6).

## 5. ExpoModulesJSI

`scripts/build-expo-modules-jsi.sh <project> <out>` (called from `src/pipeline/jsi.ts`) replaces Expo's `xcodebuild` phase:

1. Stage headers Pods-style and run `generate-modulemap.sh`.
2. `swift build --build-system swiftbuild --triple arm64-apple-ios16.4 --toolset $SDK/toolset-swb.json`.
3. `-I <toolchain>/usr/include` is required so `swift/bridging` is found.
4. `-Xlinker -all_load` is required: xtool's `ld64.lld -r` then `libtool` trampoline turns the `.o` files into `ar`
   archives, and without all_load the dylib comes out empty.
5. The product is wrapped as `ExpoModulesJSI.framework` under `ios-xtool/jsi-out`.

`RN_XTOOL_REACT_HEADERS` and `RN_XTOOL_DEPS_HEADERS` replace the `ios-arm64` `Headers` dirs of `ReactNativeHeaders`
and `ReactNativeDependenciesHeaders` (default: under `ios/build/xcframeworks`). Only SDK 57 sets them; for every other
build `src/pipeline/jsi.ts` removes them from the environment.

## 6. Framework staging

`src/frameworks.ts` reads `ios/build/xcframeworks/flavored-frameworks.json` (debug flavor, slice `ios-arm64`) to list
the runtime frameworks: React, ReactNativeDependencies, hermesvm, ExpoModulesCore, ExpoModulesWorklets and any other
dynamic ones, plus the freshly built ExpoModulesJSI. `stageFrameworks` in `src/frameworks.ts` copies them
(dereferencing symlinks) into `ios-xtool/Frameworks`, which `xtool.yml` embeds as a resource. `scripts/stage-frameworks.sh`
is kept only as a reference of the original manual recipe; the CLI does not call it.

Before staging, `checkFrameworkSymbols` in `src/pipeline/symbols.ts` (G4) runs, for each of those frameworks,
`llvm-nm --arch=arm64 -m --undefined-only` and `llvm-nm --arch=arm64 --defined-only --extern-only -j` on
`<framework>/<executable>`. Every non-weak import `(from <Lib>)` whose `<Lib>` is the executable of another framework
in the set must be among that framework's exports; otherwise the step throws one line per gap, naming the packages
where the build resolves them. `llvm-nm` comes from the Swift toolchain on `toolEnv()`'s `PATH`. What it cannot
detect: [troubleshooting.md](troubleshooting.md#expo-sdk-58).

## 7. Generated `ios-xtool/`

Written by `src/generate/iosXtool.ts`:

- `Package.swift` (`src/generate/packageSwift.ts`): target `App` (AppDelegate, SceneDelegate when the project has one,
  a symlink to the autolinked `ExpoModulesProvider.swift`) depending on ReactNative, React-GeneratedCode, Autolinked and
  ExpoModulesJSIHeaders. `-F compile-interfaces`, `-Xlinker -ObjC`, `-lc++`, `-F <ios-arm64 slice>` plus a
  `.linkedFramework` per runtime framework, `swiftLanguageModes: [.v5]` (the Expo template is Swift 5). For every
  autolinked scaffolded library (`ios/build/generated/autolinking/libs/<name>`) whose manifest carries the
  `// rn-xtool-swift-importer-paths: [...]` marker, the App's `swiftSettings` get `-Xcc -I<library dir>/<path>`
  (`src/generate/scaffoldImporter.ts`), on Expo, bare and hybrid apps.
- `SceneDelegate.swift` is optional on every SDK (SDK 57's template has only `AppDelegate.swift`). When it is missing
  and Info.plist's `UIApplicationSceneManifest` names a scene delegate class, `generate` stops with
  `Missing SceneDelegate.swift: <path> (Info.plist's UIApplicationSceneManifest names <class>)`.
- `xtool.yml` (`src/generate/xtoolYml.ts`): `bundleID`, `product: App`, `infoPath: Info.plist`, resources
  `Frameworks`, `ip.txt`, `EXConstants.bundle`.
- `ip.txt`: the LAN IP; the app reads it and queries `http://<ip>:<port>/status`.
- `Info.plist`: copied from `ios/<app>/Info.plist` by `src/plist.ts` with every `$(VAR)` resolved from the project
  (`src/project.ts`, `buildVars`) and `RCTMetroPort` set. An unresolved `$(PRODUCT_MODULE_NAME).SceneDelegate` makes the
  scene class lookup fail and the app shows a black screen; it must be `App.SceneDelegate`.
- `EXConstants.bundle`: app config produced by `expo-constants/scripts/getAppConfig.js` (`src/pipeline/appConfig.ts`,
  with `EXPO_CONSTANTS_ALLOW_NON_PODS=1`).

## 8. Signing and install

`xtool dev run --configuration debug --usb` (`src/commands/install.ts`) signs with the Apple ID team and installs.
xtool renames the bundle ID to `XTL-<TEAM>.<bundleIdentifier>`. A free account has one certificate (xtool asks before
revoking an old one). The device needs Developer Mode on. `xtool launch` fails with `DebugserverClient.Error.unknown`
on current iOS, so the app is opened by hand.

## 9. Metro connectivity

`build` (`src/commands/build.ts`) picks the LAN IP (default-route interface; `src/net.ts`) and the Metro port, bakes both
into the app and records them in the build state (`src/state.ts`). `start` (`src/commands/start.ts`) only verifies: it
checks the LAN IP is unchanged and the baked port is usable, refuses to start on a mismatch (rebuild and reinstall),
and runs `expo start --lan`. Keep-Metro rule: if the port is held by a Metro already serving `packager-status:running`,
`build` keeps the port and `start` reports it and does nothing (rn-xtool cannot tell which project that Metro belongs
to; if it is another project's Metro, stop it). Only a non-Metro program on the port forces a different port. VPN warning:
the LAN IP comes from the default route, so a VPN tunnel can bake an address the phone cannot reach ("No script URL");
`build` and `doctor lan-ip` warn, and `lanIp` in the config pins it. The phone fetches the
bundle over Wi-Fi (`iOS Bundled 289ms` on a warm cache). Pitfalls seen: Docker holding 8081, ufw blocking the port, and
the iOS Local Network permission.

## Bare React Native notes

Bare projects (no `expo`, or `expo` plus Expo modules as a hybrid) follow the same recipe with these differences:

- **Detection and reading**: `src/project/detect.ts` (`expo` iff `expo` is a dependency and an Expo config exists, else
  `bare` iff `ios/` holds one `.xcodeproj`; the `projectKind` config key overrides) and `src/project/bare.ts` /
  `pbxproj.ts` (the `xcode` package parses the pbxproj; Debug settings resolve only `$(inherited)`, `$(TARGET_NAME)`,
  `$(PROJECT_NAME)`, the `:rfc1034identifier` modifier and settings defined in the pbxproj; any other `$(VAR)`, such as
  `$(SRCROOT)`, is an error naming the setting; paths are relative to `ios/`). The Sources and Resources phases of the single application target
  become the content of the App target (`BareTargetContent`).
- **Section 2**: `rn-spm` does not run `setup-apple-spm.js add|update` (no injection into the xcodeproj, which `add` refuses
  on a CocoaPods-integrated project). `scripts/rn-spm-generate.js` runs RN's steps 1-5 and writes only `ios/build/`.
  `--scaffold` runs the scaffold step alone.
- **Section 5**: ExpoModulesJSI is built only with Expo modules; `app-config` runs only when `expo-constants` is installed.
- **Section 7**: `src/generate/bareSources.ts` copies the app sources to `ios-xtool/Sources/App` (header forwards in
  `include/`) and the resources to `ios-xtool/Resources`. `Package.swift` (`src/generate/packageSwift.ts`) compiles those
  copies instead of the Expo template's AppDelegate/SceneDelegate, passes the bridging header (`-import-objc-header`),
  header search paths and defines, and takes the mixed-language form (with `Package@swift-6.5.swift`) when the target has
  C-family sources. The deployment target is fixed at 16.4 (`IOS_MIN`), Swift 5 mode.
- **Section 9**: `ip.txt` holds `<lanIp>:<metroPort>` (RN takes only the host from `ip.txt`; the port is compiled into the
  framework as 8081); `start` runs `npx react-native start`.
- `build --clean` removes `ios/build` and `ios-xtool` only; the user's `ios/` is never modified.

## Expo SDK 57 notes

Expo SDK 57 projects (`expoPlugin: "vendored"`, `rnScripts: "vendored"` in `ProjectInfo`) follow the recipe with these
differences:

- **Gate** (`SUPPORTED_EXPO` in `src/versions.ts`, `readExpoProject` in `src/project/expo.ts`): SDK 57 needs exactly
  expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and expo-modules-jsi
  57.1.3, each read where the build resolves it (`expoPackageDir`: expo and react-native from the root,
  expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core, expo-modules-autolinking from the root, else
  from `expo`). That expo-modules-jsi must be `node_modules/expo-modules-jsi`, the copy patch-package patches.
  rn-xtool's `@expo/modules-macros-linux-<arch>` must resolve (`expoMacrosBinaryError`). SDK 58 and newer use the
  installed plugin, and older SDKs are refused. The texts are in [troubleshooting.md](troubleshooting.md#expo-sdk-57).
  `doctor` reports `expo SDK 57, React Native 0.86.3 (vendored Expo SwiftPM plugin and SwiftPM scripts)`.
- **Steps** (`buildSteps` in `src/commands/build.ts`): `prebuild` (when `ios/` is missing, or `--clean`), `patches`,
  `rn-artifacts` (unless `rnArtifactsDir` is set), `jsi`, `rn-spm`, `app-config`, `frameworks`, `generate`,
  `xtool-build`. `rn-artifacts` is the bare 0.86 step (download and adapt the 0.86.3 slot into
  `ios/build/rn-artifacts/0.86.3`); an `rnArtifactsDir` must hold adapted 0.86.3 slots.
- **Section 2** (`src/pipeline/rnSpm.ts`): no `setup-apple-spm.js`, no injection. From `ios/`:

  ```
  node <rn-xtool>/scripts/rn-spm-generate.js --rn-dir <react-native> --app-root <project> \
    --scripts-root <rn-xtool>/vendor/rn-spm \
    --config-command '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]' \
    --expo-plugin <rn-xtool>/vendor/expo-spm/spm/plugin.js [--artifacts <root>]
  ```

  with `EXPO_PRECOMPILED_MODULES_PATH=ios/build/expo-precompiled` next to `RN_SPM_SWIFT_HEADERS_DIR`. The driver sets
  `RN_SPM_EXPO_PLUGIN` (edit E5 of `vendor/rn-spm` loads it as `expo`'s autolinking plugin, since SDK 57's `expo`
  declares none) and `RN_XTOOL_PROJECT_ROOT` (P2: the plugin resolves `@expo/config-plugins` through the app's `expo`,
  and `xcode` next to it, never from rn-xtool's own copies). The scaffold rerun adds `--scaffold` and skips `expo`
  (D1): the plugin provides it, and refuses an `expo` with a scaffolded `Package.swift`.
- **Section 3**: `selectBundledPatches` with `exactOnly` stages only `expo-modules-jsi+57.1.3.patch`. Expo's plugin is
  the vendored `vendor/expo-spm/spm/plugin.js`: expo 58.0.19's `scripts/spm/`, plus `patches/expo+58.0.21.patch`, plus
  the vendored-only edits P1–P6 of `vendor/expo-spm/rn-xtool-edits.patch` (see
  [vendor/expo-spm/README.md](../vendor/expo-spm/README.md)). It calls expo-modules-autolinking 58.0.15 and loads the
  macro plugin of expo-modules-macros 0.22.0, both exact dependencies of rn-xtool, so Expo source modules compile with
  `-load-plugin-executable` pointing at `@expo/modules-macros-linux-<arch>/ExpoModulesMacros`. rn-xtool's
  autolinking copy is not patched: on Linux its `@ExpoModule` scanner returns early without a warning, and the modules
  linked are those declared in `expo-module.config.json`, as with SDK 57's own autolinking. The precompiled
  ExpoModulesCore, ExpoModulesWorklets, ExpoFileSystem and ExpoFont come from the tarballs in SDK 57's npm packages
  (`<pkg>/prebuilds/output/<flavor>/xcframeworks`), extracted to `ios/build/expo-xcframeworks` without `._*` entries
  (P5).
- **Section 5** (`src/pipeline/jsi.ts`, before `rn-spm`): the build compiles against
  `<artifacts>/debug/ReactNativeHeaders.xcframework/ios-arm64/Headers` and
  `<artifacts>/debug/ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers` (`RN_XTOOL_REACT_HEADERS`,
  `RN_XTOOL_DEPS_HEADERS`), checked first: `ExpoModulesJSI needs React Native's headers at <dir>, which does not exist.
  rnArtifactsDir must hold adapted 0.86.3 slots, as rn-xtool's rn-artifacts step writes them.` Then
  `src/pipeline/jsiHeaders.ts` writes
  `ios/build/expo-precompiled/expo-modules-jsi/output/headers/xcframeworks/ExpoModulesJSIHeaders.xcframework`, the
  layout of SDK 58's published tarball:
  - slices `ios-arm64` and `ios-arm64_x86_64-simulator`, each with `Headers/ExpoModulesJSI/{ExpoModulesJSI-Swift.h,
    NativeState.h, module.modulemap}` and an empty `ar` archive `libExpoModulesJSIHeaders.a`;
  - `ios-arm64/ExpoModulesJSI.swiftmodule/arm64-apple-ios.swiftinterface`;
  - `Info.plist` for the two slices, and `expo-package.json` with the installed expo-modules-jsi version (the plugin's
    `assertHeadersMatchSources` compares it with the package).

  The Swift header and interface come from the build's `Objects-normal/arm64`, `NativeState.h` from
  `expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/Public`, and the module map is SDK 58's text. The tree is
  assembled beside the destination and swapped in whole; the stamp `.rn-xtool-jsi-headers.json` (generator version,
  jsi version, sha256 of the interface) is written last and skips the rewrite when it matches. A missing input stops the
  step: `The ExpoModulesJSI build produced no <file> (expected in <dir>); cannot make ExpoModulesJSIHeaders.xcframework
  for expo-modules-jsi 57.1.3.`
- **Section 7**: no SceneDelegate in the template (above). The rest of `ios-xtool/` is generated as for SDK 58.

## Open risks

- ExpoModulesCore `.swiftinterface` compatibility depends on Xcode's Swift vs the Linux Swift version.
- Free account: 7-day signature, 3 apps, no push or entitlements.
