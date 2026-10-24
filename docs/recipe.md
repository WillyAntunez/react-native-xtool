# Recipe: Expo SDK 58 iOS dev build from Linux

The technical recipe behind `expo-xtool`, migrated from the original research notes (2026-10-23). The CLI
automates exactly these steps. Paths are relative to this repo.

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
framework is named `hermesvm.framework`.

## 3. Expo SPM plugin and patches

Expo 58 builds ExpoModulesCore as a Debug/Release dynamic pair; source modules compile against an "interface tree" of
headers, modulemaps and `.swiftinterface` files. ExpoModulesCore's interface was produced by Xcode's Swift 6.3.1 and
imports fine with Swift 6.4.1.

`src/pipeline/patches.ts` applies four patch-package patches from `patches/`, then the project's own `patches/` (persisted library `Package.swift` files) when present:

| Patch | Effect |
| --- | --- |
| `patches/expo-modules-autolinking+58.0.14.patch` | Removes the `process.platform !== 'darwin'` gate in the `@ExpoModule` scanner (the Linux macros binary `@expo/modules-macros-linux-x64` works). |
| `patches/expo+58.0.17.patch` | Expo's SPM plugin (`expo/scripts/spm/`): resolves the macro plugin binary per platform; adds the umbrella Foundation/UIKit imports to pure-Swift modules; builds mixed Swift + Objective-C and Objective-C-only modules; skips meta pods and placeholder files; links generated packages to their podspec dependencies; excludes Xcode-only resources; refuses vendored-C modules (expo-sqlite). See `docs/upstream/expo-spm-plugin-umbrella.md` and `docs/upstream/expo-spm-plugin-mixed-modules.md`. |
| `patches/expo-modules-jsi+58.0.17.patch` | Swift 6.4 rejects a `public` member in an extension of a C++ type under library evolution (`CppError.message`); made internal. |
| `patches/react-native+0.88.0.patch` | About 1.6k lines across `read-podspec.js`, `scaffold-package-swift.js` and `spm-utils.js`: 11 generic fixes to RN's `spm scaffold` (Ruby bare lists and locals, subspecs, `header_dir`, platform-scoped fields, defines, mixed Swift + Objective-C/C++ targets, ...) and a header-less module map for the per-app header farm. See `docs/upstream/react-native-scaffolder.md`. |

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

## 6. Framework staging

`src/frameworks.ts` reads `ios/build/xcframeworks/flavored-frameworks.json` (debug flavor, slice `ios-arm64`) to list
the runtime frameworks: React, ReactNativeDependencies, hermesvm, ExpoModulesCore, ExpoModulesWorklets and any other
dynamic ones, plus the freshly built ExpoModulesJSI. `stageFrameworks` in `src/frameworks.ts` copies them
(dereferencing symlinks) into `ios-xtool/Frameworks`, which `xtool.yml` embeds as a resource. `scripts/stage-frameworks.sh`
is kept only as a reference of the original manual recipe; the CLI does not call it.

## 7. Generated `ios-xtool/`

Written by `src/generate/iosXtool.ts`:

- `Package.swift` (`src/generate/packageSwift.ts`): target `App` (AppDelegate, SceneDelegate, a symlink to the
  autolinked `ExpoModulesProvider.swift`) depending on ReactNative, React-GeneratedCode, Autolinked and
  ExpoModulesJSIHeaders. `-F compile-interfaces`, `-Xlinker -ObjC`, `-lc++`, `-F <ios-arm64 slice>` plus a
  `.linkedFramework` per runtime framework, `swiftLanguageModes: [.v5]` (the Expo template is Swift 5).
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
`build` keeps the port and `start` reports it and does nothing (expo-xtool cannot tell which project that Metro belongs
to; if it is another project's Metro, stop it). Only a non-Metro program on the port forces a different port. VPN warning:
the LAN IP comes from the default route, so a VPN tunnel can bake an address the phone cannot reach ("No script URL");
`build` and `doctor lan-ip` warn, and `lanIp` in the config pins it. The phone fetches the
bundle over Wi-Fi (`iOS Bundled 289ms` on a warm cache). Pitfalls seen: Docker holding 8081, ufw blocking the port, and
the iOS Local Network permission.

## Open risks

- ExpoModulesCore `.swiftinterface` compatibility depends on Xcode's Swift vs the Linux Swift version.
- Free account: 7-day signature, 3 apps, no push or entitlements.
