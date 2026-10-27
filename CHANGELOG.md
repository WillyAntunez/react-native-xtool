# Changelog

All notable changes to react-native-xtool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) with `alpha` prereleases.

## [Unreleased]

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

[Unreleased]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/WillyAntunez/react-native-xtool/releases/tag/v0.1.0-alpha.1
