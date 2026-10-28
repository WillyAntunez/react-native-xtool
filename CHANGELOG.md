# Changelog

All notable changes to react-native-xtool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) with `alpha` prereleases.

## [Unreleased]

### Added
- Expo SDK 57 projects, on exact versions only: expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24,
  expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3. They build through a vendored copy of Expo SDK 58's
  SwiftPM plugin (`vendor/expo-spm/`: expo 58.0.19's `scripts/spm/` with rn-xtool's Expo patch and five vendored-only
  edits), the vendored React Native scripts and the adapted 0.86.3 artifacts, with SDK 57's own precompiled
  ExpoModulesCore. The `jsi` step runs before `rn-spm` and also writes the `ExpoModulesJSIHeaders.xcframework` SDK 57
  does not ship. Nothing is injected into `ios/`. expo-modules-autolinking 58.0.15 and expo-modules-macros 0.22.0 are
  new exact dependencies of rn-xtool, and `patches/expo-modules-jsi+57.1.3.patch` is the only bundled patch an SDK 57
  project gets. `doctor` reports `(vendored Expo SwiftPM plugin and SwiftPM scripts)` for these projects.
- Generic fixes, on every SDK and on bare projects:
  - Expo's plugin (`patches/expo+58.0.19.patch`): headers that import the module's own `-Swift.h` stay out of its Swift
    umbrella; `add_dependency(s, "<Pod>")` counts as a pod dependency, and a generated package can depend on a React
    Native library with a `Package.swift` (expo-router on react-native-screens); a generated package that depends on a
    scaffolded mixed library gets that library's header search paths for Swift.
  - React Native's scaffolder (`patches/react-native+0.88.0.patch` and `vendor/rn-spm/`, fixes 14 to 17 in
    `docs/upstream/react-native-scaffolder.md`): no own `-Swift.h` in the Swift umbrella, `#{package['version']}` in
    flags and defines, subspec `header_mappings_dir` under `header_dir`, and the Swift importer paths recorded in
    each mixed manifest (found on react-native-reanimated 4.5, react-native-worklets 0.10 and react-native-screens
    4.26).
  - The App target gets the Swift importer paths of every autolinked scaffolded mixed library.
- The clean-machine harness takes `e2e.sh project --sdk <n>` (template `blank-typescript@sdk-<n>`).

### Changed
- An Expo SDK older than 57 now gets `Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58
  or newer.` An SDK 57 project stops in `doctor` and `build` when a pinned version differs, when the expo-modules-jsi
  the build uses is not the top-level copy, or when rn-xtool's expo-modules-macros has no Linux binary for the host.
- `SceneDelegate.swift` is optional on every SDK; it is required only when Info.plist's `UIApplicationSceneManifest`
  names a scene delegate.
- When several bundled patches name one package, the one for the installed version is staged, else the highest
  version (which keeps SDK 58's "pin" message).
- The scaffolder revision is now 2: scaffolded mixed manifests carry a `// rn-xtool-swift-importer-paths:` line, and
  the `patches` step warns about persisted scaffold patches written by revision 1 and says which file to delete.
  Generated manifests of SDK 58 and bare apps change only where one of the fixes above applies.

## [0.1.0-alpha.2] - 2026-10-27

### Added
- Bare React Native 0.86.2, 0.86.3 and 0.87.1, through vendored copies of React Native 0.88.0's SwiftPM scripts
  (`vendor/rn-spm/`), a `rn-artifacts` build step that downloads and, for 0.86, adapts the prebuilt artifacts, and an
  exact-version gate. 0.86.3 and 0.87.1 are verified on a physical iPhone (`doctor`, `build`, install over Wi‑Fi, Metro,
  Fast Refresh, and the library matrix in `docs/libraries.md`; reanimated/worklets only on 0.86.3); 0.86.2 is
  build-verified only.
- The `patches` step warns about persisted scaffold patches made for another React Native version (for example after
  moving from 0.86.3 to 0.87.1) and says which file to delete; it changes nothing on its own.

### Changed
- An Expo project whose `react-native` is not 0.88.0 now stops at the `patches` step with a message to pin
  `react-native` to 0.88.0 (before, a cleanly applying patch only warned).
- Persisted scaffold patches that still carry the old `expo-xtool-scaffold-revision` marker are re-scaffolded once (the
  marker became `rn-xtool-scaffold-revision` in 0.1.0-alpha.1); patches with the current marker are kept.
- A React Native version rn-xtool does not support now gets one error naming the supported list (0.86.2, 0.86.3,
  0.87.1 and 0.88.0); 0.88 prereleases and 0.88.x other than 0.88.0 are refused.
- README and docs mark WSL2 as "should work, not tested yet" instead of supported.

## [0.1.0-alpha.1] - 2026-10-26

First public release, as `react-native-xtool` (command `rn-xtool`).

### Added
- Expo SDK 58 projects: `setup`, `doctor`, `build`, `install`, `start`, `run` on Linux via xtool 1.23.0, Swift 6.4 and
  the Darwin SDK extracted from your own Xcode.xip; patches for Expo's SwiftPM plugin and React Native's `spm scaffold`.
- Bare React Native 0.88 projects and hybrids (bare + Expo modules): the Xcode project is read, never modified;
  Swift, Objective-C and C++ sources in the app target; `<Module>-Swift.h` forward for Objective-C.
- CocoaPods-only libraries: `Package.swift` generated automatically by React Native's `spm scaffold` with 13 generic
  fixes, persisted in the project's `patches/`.
- Wi‑Fi installs (`install --network`, `setup --wifi`) without the cable after a one-time USB pairing.
- Smart rebuilds: `run` rebuilds and reinstalls only when dependencies (or, for bare, native files) changed.
- `rn-xtool auth` to run xtool's login commands.
- Verified on a physical iPhone: Expo and bare templates, reanimated, worklets, gesture-handler, screens, svg, webview,
  datetimepicker, safe-area-context, expo-haptics, expo-secure-store, expo-image-picker, bottom-sheet, pager-view,
  expo-notifications (local), expo-dev-client.

### Known limits
- Expo SDK 57 and older, React Native 0.85 and older, 0.86.0, 0.87.0: not yet.
- No iOS simulator, no production builds, Linux x86_64 only (arm64 and WSL2 untested).
- No Xcode tools on Linux: asset catalogs, storyboards and Metal shaders are skipped; library resource bundles and
  vendored xcframeworks are not supported yet.

[Unreleased]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/WillyAntunez/react-native-xtool/releases/tag/v0.1.0-alpha.1
