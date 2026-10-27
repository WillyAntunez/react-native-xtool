# Changelog

All notable changes to react-native-xtool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) with `alpha` prereleases.

## [Unreleased]

### Changed
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
- Expo SDK 57 and older, React Native 0.87 and older: not yet.
- No iOS simulator, no production builds, Linux x86_64 only (arm64 and WSL2 untested).
- No Xcode tools on Linux: asset catalogs, storyboards and Metal shaders are skipped; library resource bundles and
  vendored xcframeworks are not supported yet.

[Unreleased]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/WillyAntunez/react-native-xtool/releases/tag/v0.1.0-alpha.1
