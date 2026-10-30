# Changelog

All notable changes to react-native-xtool. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) with `alpha` prereleases.

## [Unreleased]

### Upgrading from 0.1.0-alpha.3
- Nothing to do for most projects: projects on the verified versions build as before. `rn-xtool doctor --project`
  shows the new lines (versions, rn-scripts, rn-artifacts, expo-plugin, expo-modules, podspecs) for your project.
- On Expo SDK 58, a package of another SDK's release line, for example expo-modules-core 59.x, got only a warning
  before; now G1 stops the build and names it. Follow G1's remedy to move it back to SDK 58's line (see Changed).

### Added
- Bare React Native accepts every patch release of a supported minor from its floor: 0.86.x from 0.86.2, 0.87.x from
  0.87.1 and 0.88.x from 0.88.0. A version that is not verified builds with "⚠ Newer than the React Native <minor>
  line this rn-xtool release was verified with: react-native <version>. ...", which names the verified versions and
  the one to move back to. A version below the floor, a prerelease or another minor stops with "React Native
  <version> is not supported; rn-xtool supports 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0 (bare).
  Pin react-native to one of them." Hybrid apps still need React Native 0.88.1.
- `rn-xtool doctor --project` checks only the project in the current folder, with no toolchain, login or device
  checks. After the version gates it prints what rn-xtool finds in the project: the line that covers the installed
  versions (or why none does), the SwiftPM scripts the build would use, whether React Native's prebuilt artifacts are
  cached, local (`rnArtifactsDir`) or published (HEAD requests, at most 10 s), whether expo ships its SwiftPM plugin,
  whether the Expo modules are precompiled, and which tracked podspec features the dependencies use. Plain `doctor`
  is unchanged and makes no new network request. See
  [troubleshooting.md](docs/troubleshooting.md#doctor---project).
- A daily drift watch (`.github/workflows/drift-watch.yml`): each supported line gets a fresh project at its newest
  patch release, and the version gates, a dry run of the bundled patches and the portable-manifest rewrite are checked
  on it. A broken line gets one GitHub issue labelled `drift`, which is updated while it stays broken and closed when
  it is green again. A weekly, report-only exploration writes the capabilities of Expo SDK 54–56 and bare React Native
  0.81–0.85 to the run summary. Nothing is compiled, so a green line can still fail G4 or the build. See
  [RELEASING.md](docs/RELEASING.md#drift-watch).

### Changed
- Expo SDK 57 is a floor, like SDK 58: expo 57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and
  expo-modules-jsi 57.1.3 or any newer release of SDK 57's line, with react-native exactly 0.86.3. A newer 57.x builds
  with "⚠ Newer than the Expo SDK 57 set this rn-xtool release was verified with: ...". G1 now reads "Expo SDK 57 needs
  react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and
  expo-modules-jsi 57.1.3; installed: ...", with SDK 58's remedy (remove the pins, `npx expo install --fix`, then
  `npx expo install react-native@0.86.3`). G2 (a nested expo-modules-jsi) gives SDK 58's text: remove the pin, then
  `npm update expo-modules-jsi`. SDK 56 and older read "Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo
  57.0.31 or newer 57.x) and SDK 58 or newer." A bundled SDK 57 patch that does not apply on a newer 57.x gives the
  npm `"overrides"` remedy with the 57 set.
- On Expo SDK 57 and 58, a package of another SDK's release line (expo-modules-jsi 58.0.19 on SDK 57,
  expo-modules-core 59.0.0 on SDK 58) stops at G1 instead of counting as newer than the floor.
- Bare and hybrid projects get the vendored or the installed SwiftPM scripts according to the installed scripts'
  layout, not their version number; a layout rn-xtool does not recognise falls back to the version's line. Every
  supported version gets the same scripts as before: 0.86.x and 0.87.x the vendored copy, 0.88.x the installed one.
- Bundled patches are selected by release line: the patch for the installed version, else the highest bundled patch
  of the same line (react-native 0.88.2 gets the 0.88.1 patch, a newer 57.x expo-modules-jsi the 57.1.3 patch). An
  SDK 57 project never gets another SDK's patch.

### Fixed
- A malformed `rn-xtool.config.json` is named in the error, in every command: "rn-xtool.config.json: <JSON error>".
- rn-xtool needs Node 22.12 or newer, the floor its own dependencies declare (commander 15, execa 10); it said Node 20
  before, which was never tested and is end of life. package.json `engines`, the README and `doctor`'s node check
  ("<version> (need 22.12.0 or newer)") now say so.

## [0.1.0-alpha.3] - 2026-10-28

### Upgrading from 0.1.0-alpha.2
- Expo SDK 58 apps move to the 58.0.21 set, in the order `doctor` gives and
  [troubleshooting.md](docs/troubleshooting.md#moving-to-the-58021-set) lists: remove the expo-modules-* pins
  0.1.0-alpha.2 asked for (`npm uninstall expo-modules-jsi expo-modules-autolinking`), then
  `npx expo install expo@~58.0.21`, `npx expo install --fix` and `npx expo install react-native@0.88.1`. Do not pin
  expo-modules-* packages again.
- Hybrid apps (bare + Expo modules) do the same, but move React Native to 0.88.1 as
  [Upgrading React Native](docs/bare-react-native.md#upgrading-react-native) describes. If `doctor` then says
  expo-modules-jsi resolves from `node_modules/expo-modules-core/node_modules/`, run `npm update expo-modules-jsi`.
- Bare React Native 0.88.0 apps keep working; 0.88.1 is also supported.
- The first build can stop at `patches` with "rn-xtool could not apply its patch to <package>". This release changed
  the bundled `react-native+0.88.0.patch` and the Expo patch, and `node_modules/<package>` still holds the
  0.1.0-alpha.2 version. Run `rm -rf node_modules/<package> && npm install`, then build again.
- After a move to React Native 0.88.1, the build warns about each scaffold patch in `patches/` made for 0.88.0: delete
  the patch it names (and reinstall the library, as it says), then build again, so rn-xtool regenerates and persists
  it. Teammates who pull the new patches need to do nothing: their older copy in `node_modules` is replaced. When a
  patch also holds your own fix to that library, the build says to reinstall it (`rm -rf node_modules/<package> &&
  npm install`) instead.
- On a team with Macs, if `doctor` says `@expo/modules-macros-linux-<arch>` is not installed, run
  `npm install --include=optional` and commit `package-lock.json`.

### Added
- Expo SDK 57 projects, on exact versions only: expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24,
  expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3. They build through a vendored copy of Expo SDK 58's
  SwiftPM plugin (`vendor/expo-spm/`: expo 58.0.19's `scripts/spm/` with rn-xtool's Expo patch and six vendored-only
  edits), the vendored React Native scripts and the adapted 0.86.3 artifacts, with SDK 57's own precompiled
  ExpoModulesCore. The `jsi` step runs before `rn-spm` and also writes the `ExpoModulesJSIHeaders.xcframework` SDK 57
  does not ship. Nothing is injected into `ios/`. expo-modules-autolinking 58.0.15 and expo-modules-macros 0.22.0 are
  new exact dependencies of rn-xtool, and `patches/expo-modules-jsi+57.1.3.patch` is the only bundled patch an SDK 57
  project gets. `doctor` reports `(vendored Expo SwiftPM plugin and SwiftPM scripts)` for these projects. Verified on
  a physical iPhone on 2026-10-28: the template with Fast Refresh, and the libraries in the `Expo 57` column of
  `docs/libraries.md` (expo-router, expo-dev-client, reanimated and worklets, gesture-handler, screens and
  safe-area-context, haptics, image-picker, file-system).
- Generic fixes, on every SDK and on bare projects:
  - Expo's plugin (`patches/expo+58.0.21.patch`): headers that import the module's own `-Swift.h` stay out of its Swift
    umbrella; `add_dependency(s, "<Pod>")` counts as a pod dependency, and a generated package can depend on a React
    Native library with a `Package.swift` (expo-router on react-native-screens); a generated package that depends on a
    scaffolded mixed library gets that library's header search paths for Swift.
  - React Native's scaffolder (`patches/react-native+0.88.0.patch`, `patches/react-native+0.88.1.patch` and
    `vendor/rn-spm/`, fixes 14 to 18 in `docs/upstream/react-native-scaffolder.md`): no own `-Swift.h` in the Swift
    umbrella, `#{package['version']}` in flags and defines, subspec `header_mappings_dir` under `header_dir`, and the
    Swift importer paths recorded in each mixed manifest, and in each clang-only manifest whose header search paths go
    beyond its public headers path (found on react-native-reanimated 4.5, react-native-worklets 0.10 and
    react-native-screens 4.26 and 4.30), and a
    clang-only target's module without the headers its podspec leaves out (react-native-screens 4.30's `ios/gamma`).
  - The App target gets the Swift importer paths of every autolinked scaffolded library that records them.
- The clean-machine harness takes `e2e.sh project --sdk <n>` (template `blank-typescript@sdk-<n>`).
- The `patches` step makes the libraries' own `Package.swift` files portable to Linux, which fixes the default SDK 58
  template's first build: react-native-reanimated 4.7.1 and react-native-worklets 0.13.0 use `CFGetTypeID`, which
  Linux hosts lack. It keys on the snippet, not the version, logs one `manifest —` line per library, and leaves
  existing project patches for the same fix working. It scans the project's top-level and scoped packages, never
  edits a package linked from outside the project (it logs a `manifest — skipped` line instead), and stops with a named
  error when `node_modules` is read-only.
- Bare React Native 0.88.1, with its own bundled `patches/react-native+0.88.1.patch` (the same content as the 0.88.0
  one; a test keeps the two identical). `doctor` and `build` accept 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1. Another
  react-native version gets one message naming both patches (`the bundled react-native patches are for 0.88.0 and
  0.88.1`).
- G4, in the `frameworks` step: before staging, `llvm-nm` (from the Swift toolchain) checks that every symbol an
  embedded framework imports from another embedded framework is exported by it. A gap stops the build naming both
  frameworks, their packages and a missing symbol, instead of an app that closes at launch with `dyld: Symbol not
  found`. It runs on every project kind, with no bypass; a missing `llvm-nm` is an error, which `doctor` reports on
  its `llvm-nm` line. It does not see C++ or Swift layout changes that keep the same symbols, or lookups by name at
  runtime (see `docs/troubleshooting.md`).

### Changed
- `install`'s first-run checklist explains the red screen "No script URL provided" that shows behind iOS's Local
  Network prompt on the first launch after an install: tap Allow, then Reload.
- Expo SDK 58 builds on the 58.0.21 set as a floor: react-native 0.88.1 exactly, and at least expo 58.0.21,
  expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and
  expo-font 58.0.11. An older or missing package stops `doctor` and `build`. The remedy removes the expo-modules-*
  pins in package.json (`npm uninstall …`), moves `expo` when it is listed (`npx expo install expo@~58.0.21`), runs
  `npx expo install --fix`, and ends with `npx expo install react-native@0.88.1` (Expo's versions API lists
  react-native 0.88.0 for SDK 58, so `--fix` alone leaves it there); a hybrid app is sent to the bare docs' React
  Native upgrade sequence instead of that last command. A newer 58.x prints a warning and the build continues with
  the floor's patches. The 58.0.19 set of 0.1.0-alpha.2 is no longer accepted: npm no longer resolves it on its own.
  A nested expo-modules-jsi now stops `doctor` and `build` with "Remove any expo-modules-jsi pin or override from
  package.json", then `npm update expo-modules-jsi` (a reinstall keeps the copy where package-lock.json put it),
  instead of failing at `rn-spm` with Expo's headers message. expo-modules-macros' Linux binary is checked where
  expo-modules-core resolves it; when it is missing, the message names its version and gives
  `npm install --include=optional` (a lockfile written on macOS can lack it). Hybrid apps (bare + Expo modules) get
  the same checks, and need React Native 0.88.1 and Expo SDK 58 or newer.
- The bundled SDK 58 patches are named after the 58.0.21 set (`expo+58.0.21.patch`, `expo-modules-jsi+58.0.21.patch`,
  `expo-modules-autolinking+58.0.16.patch`); their content is unchanged.
- An Expo SDK older than 57 now gets `Expo SDK <n> is not supported; rn-xtool supports SDK 57 (expo 57.0.31) and SDK 58
  or newer.` An SDK 57 project stops in `doctor` and `build` when a pinned version differs, when the expo-modules-jsi
  the build uses is not the top-level copy, or when the expo-modules-macros the vendored plugin uses (a copy
  expo-modules-core resolves, else rn-xtool's) has no Linux binary for the host.
- `SceneDelegate.swift` is optional on every SDK; it is required only when Info.plist's `UIApplicationSceneManifest`
  names a scene delegate.
- When several bundled patches name one package, the one for the installed version is staged, else the highest
  version (on a newer 58.x, the floor's patch). When the floor's patch does not apply, the message offers an npm
  `"overrides"` block with the verified expo-modules-core, expo-modules-jsi and expo-modules-autolinking versions (and
  the failing package), or waiting for an rn-xtool release, and says not to pin expo-modules-* packages as direct
  dependencies (a pin there nests the copy expo uses); SDK 57 and react-native keep the "pin <package>" message.
- The scaffolder revision is now 3: scaffolded mixed manifests, and clang-only ones whose header search paths go beyond
  their public headers path, carry a `// rn-xtool-swift-importer-paths:` line, and the `patches` step warns about
  persisted scaffold patches written by an older revision and says which file to delete.
  Generated manifests of SDK 58 and bare apps change only where one of the fixes above applies.

### Fixed
- Expo's plugin skips every `*Tests` folder of a module, as podspecs do (`ios/*Tests/**/*`), not only `Tests`: SDK 57's
  expo-dev-menu compiled its `UITests` XCTest helpers into the app, which then closed at launch.
- SDK 57's expo-dev-launcher `Unsafe` subspec now builds, with its own compiler flags (vendored edit P6).
- A bundled patch over a package an earlier rn-xtool release patched differently (same version, other content) now
  stops with a message that names the package and `rm -rf node_modules/<package> && npm install`, instead of
  patch-package's output and "Report this". rn-xtool does not reinstall it itself.
- A scaffolded `Package.swift` in `node_modules` older than its persisted patch (a teammate committed the regenerated
  patch) is now replaced with the persisted one, and an out-of-date one without a persisted patch is removed so the
  `rn-spm` step scaffolds it again; before, both were built as they were. A persisted patch that also changes the
  library's own files is not replaced: the build warns and names `rm -rf node_modules/<package> && npm install`. The
  scaffold warnings and this check also read the pre-rename `expo-xtool-scaffold-revision` marker.

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

[Unreleased]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/WillyAntunez/react-native-xtool/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/WillyAntunez/react-native-xtool/releases/tag/v0.1.0-alpha.1
