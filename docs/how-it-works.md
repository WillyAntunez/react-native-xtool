# How it works

rn-xtool does not reimplement Xcode. It patches the official React Native 0.88 and Expo SDK 58 SwiftPM pipeline so it
runs on Linux (React Native 0.86 and 0.87 and Expo SDK 57, which ship none, run vendored copies of it), generates a
SwiftPM package for your app in `ios-xtool/`, and hands it to [xtool](https://github.com/xtool-org/xtool), which builds,
signs and installs it with the Darwin SDK extracted from your own `Xcode.xip`. This page is the overview (toolchain,
patches, build steps, Expo SDK 57, rebuild detection, scaffolded libraries); [recipe.md](recipe.md) has every step with
file locations.

[Back to README](../README.md)

## What `setup` installs

- Swift 6.4 via swiftly, the xtool 1.23.0 AppImage (needs `libfuse2`: `sudo apt install libfuse2` on Ubuntu) and the
  Darwin SDK extracted from your `Xcode.xip` (Xcode 27.x). About 15 GB of free disk: Xcode.xip is about 12 GB, the
  extracted SDK about 7 GB. `setup` is idempotent.
- Swift's system packages are not installed for you: when some are missing, `setup` prints the exact
  `sudo apt-get update && sudo apt-get -y install ...` line to run before running `setup` again. On Ubuntu 24.04:
  `binutils zip gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libgcc-13-dev libpython3-dev libstdc++-13-dev libxml2-dev
  libncurses-dev libz3-dev pkg-config zlib1g-dev`.
- Also needed on the host: `python3` (used by the `plutil` / `otool` shims) and `iproute2` (the `ip` command, to detect
  the LAN IP).
- Package manager: npm or Yarn classic. patch-package needs a flat `node_modules`; pnpm and Yarn PnP are not supported.

## The build, step by step

1. Applies the bundled patches to `node_modules` with patch-package, on Expo projects and bare React Native 0.88.0
   projects (each patch only when its package is installed, so a bare project without Expo modules gets only the React
   Native one). Bare 0.86 and 0.87 projects get none: the fixes live in the vendored scripts. An Expo SDK 57 project
   gets only the patches made for its exact installed versions, which is `expo-modules-jsi+57.1.3.patch` (see
   [Expo SDK 57](#expo-sdk-57)). An Expo SDK 58 project gets four patches. Two are one-liners (the `@ExpoModule`
   scanner gate in expo-modules-autolinking, a Swift 6.4 access-level error in expo-modules-jsi). The other two are
   large:
   - **Expo** (`patches/expo+58.0.19.patch`, files under `expo/scripts/spm/`): finds the Swift macro plugin on Linux;
     gives pure-Swift modules the Foundation/UIKit imports CocoaPods' umbrella header provides
     ([upstream/expo-spm-plugin-umbrella.md](upstream/expo-spm-plugin-umbrella.md)); builds Expo modules that mix Swift
     and Objective-C or are Objective-C only, such as expo-application and the dev client chain; skips meta pods (no
     sources) and placeholder files; links generated packages to their podspec `dependency` and `add_dependency` pods,
     React Native libraries with a `Package.swift` included; leaves headers that import the module's own `-Swift.h`
     out of its Swift umbrella; gives Swift importers of a scaffolded mixed library its header search paths; excludes
     resources only Xcode's tools compile (asset catalogs, storyboards); refuses modules built from vendored C sources
     such as expo-sqlite ([upstream/expo-spm-plugin-mixed-modules.md](upstream/expo-spm-plugin-mixed-modules.md)).
   - **React Native** (`patches/react-native+0.88.0.patch`, about 1.95k lines across 3 files under
     `react-native/scripts/spm/`: `read-podspec.js`, `scaffold-package-swift.js`, `spm-utils.js`): 16 generic fixes to
     the `spm scaffold` podspec reader and `Package.swift` generator, including mixed Swift + Objective-C/C++ targets,
     known CocoaPods dependencies mapped to SwiftPM packages and the Swift importer paths of mixed targets, plus one to
     the per-app header farm ([upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)).

   Then, in the same step, rn-xtool makes the libraries' own `Package.swift` files portable to Linux, because SwiftPM
   compiles them on the host. In each top-level and scoped package of the project's `node_modules`, it rewrites a known
   Darwin-only snippet by content, not by library version, and prints one `manifest —` line per library it fixed.
   Packages linked from outside the project are skipped, with a line saying so. Today the snippet is `CFGetTypeID`,
   checked in react-native-reanimated 4.7.1 and react-native-worklets 0.13.0 and 0.13.1
   ([upstream/reanimated-worklets-manifest.md](upstream/reanimated-worklets-manifest.md)).
2. Bare projects on React Native 0.86 or 0.87, and Expo SDK 57 projects, first run the `rn-artifacts` step (downloads
   and, for 0.86, adapts the prebuilt artifacts, see [bare-react-native.md](bare-react-native.md#older-artifacts-086)).
   Then runs React Native 0.88's SwiftPM pipeline (the vendored copy for 0.86 and 0.87, see
   [below](#vendored-swiftpm-scripts)) and Expo's SPM plugin (the vendored copy for SDK 57, see
   [Expo SDK 57](#expo-sdk-57)), with Linux shims for `plutil` and `otool`.
3. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks. On Expo SDK 57 the JSI build runs before
   step 2, because the vendored plugin needs its headers.
4. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable artifact; do
   not edit it by hand.
5. Gives CocoaPods-only libraries a `Package.swift` (see [below](#cocoapods-only-libraries)).
6. `xtool` builds, signs and installs the app; Metro serves JS to the phone over Wi‑Fi.

Bare React Native projects follow the same steps with a few differences (no `expo prebuild`, no injection into your
Xcode project, ExpoModulesJSI only with Expo modules): see [bare-react-native.md](bare-react-native.md).

## Vendored SwiftPM scripts

React Native 0.86 and 0.87 ship no `scripts/spm`. Rather than patching those installs, rn-xtool bundles the 0.88.0
scripts in `vendor/rn-spm/` (the 17 scaffolder fixes already applied; provenance and how it is checked in
[vendor/rn-spm/README.md](../vendor/rn-spm/README.md)) and the driver is given `--scripts-root` pointing at them. Expo
SDK 57 (React Native 0.86.3) uses them too. The installed React Native keeps its own codegen. Five edits to the vendored
copy:

- **E1**: the codegen template (`Package.swift.spm-template`, missing from 0.86) is read from the vendored copy.
- **E2, E3**: the React Native root comes only from the `RN_SPM_RN_ROOT` environment variable (set by the driver to the
  installed `react-native`), never from the scripts' own location.
- **E4**: `download-spm-artifacts.js` accepts `--allow-pre-headers-spec`, so a 0.86 slot without the headers
  xcframeworks is downloaded instead of rejected (the `rn-artifacts` step then adapts it).
- **E5**: `spm/autolinking-plugins.js` takes the autolinking plugin of the dependency named `expo` from the
  `RN_SPM_EXPO_PLUGIN` environment variable (set by the driver's `--expo-plugin`) when `expo` declares none, which is
  the case on Expo SDK 57.

React Native 0.88.0 keeps using its installed scripts and the `patches/react-native+0.88.0.patch` patch.

## Expo SDK 57

Expo SDK 57 (expo 57.0.31, React Native 0.86.3) ships no SwiftPM plugin: no `expo/scripts/spm`, an autolinking CLI
without the commands the plugin calls, a macro plugin with no Linux binary, and no `ExpoModulesJSIHeaders.xcframework`.
It does ship ExpoModulesCore (and ExpoModulesWorklets, ExpoFileSystem, ExpoFont) precompiled inside its npm packages.
rn-xtool builds it with a vendored copy of Expo SDK 58's plugin, on the same driver path as bare projects:

- **Exact versions.** SDK 57 builds only with expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24,
  expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3, each read where the build resolves it
  (expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core). expo-modules-jsi must also be the top-level
  copy, the only one patch-package patches. `doctor` and `build` stop otherwise, with the messages in
  [troubleshooting.md](troubleshooting.md#expo-sdk-57). SDK 58 and newer keep their installed plugin; SDK 56 and older
  are refused.
- **The vendored plugin.** `vendor/expo-spm/` is expo 58.0.19's `scripts/spm/` with rn-xtool's Expo patch applied and
  six vendored-only edits (P1–P6: the macro lookup, app packages resolved from the app root, CocoaPods' default header
  dir and prefix header, tarballs extracted without macOS AppleDouble entries, a subspec's own compiler flags as a
  target of its own); provenance and the edits in
  [vendor/expo-spm/README.md](../vendor/expo-spm/README.md). expo-modules-autolinking 58.0.15 and expo-modules-macros
  0.22.0 (with the host's `@expo/modules-macros-linux-<arch>` binary) are exact dependencies of rn-xtool, which the
  plugin finds in rn-xtool's `node_modules`; every package of the app is resolved from the app.
- **The driver.** `rn-spm` runs `scripts/rn-spm-generate.js` on the vendored React Native scripts and the adapted 0.86.3
  artifacts, as for bare 0.86 (never `setup-apple-spm.js add|update`, so nothing is injected into `ios/`). It passes
  Expo's autolinking as the config command and `--expo-plugin` with the vendored plugin, which E5 loads as `expo`'s.
  When libraries need scaffolding, the scaffold step leaves `expo` to the plugin.
- **ExpoModulesJSI and its headers.** The `jsi` step moves before `rn-spm`. It builds ExpoModulesJSI against the headers
  of the adapted artifacts (`ios/build/xcframeworks` does not exist yet), then writes
  `ExpoModulesJSIHeaders.xcframework` in SDK 58's published layout under `ios/build/expo-precompiled`, which the plugin
  reads through `EXPO_PRECOMPILED_MODULES_PATH`. A stamp (jsi version, interface hash) skips the rewrite when nothing
  changed.
- **The app shell.** SDK 57's template has `AppDelegate.swift` and no `SceneDelegate.swift`. On every SDK rn-xtool
  copies `SceneDelegate.swift` only when it exists, and stops when Info.plist's `UIApplicationSceneManifest` names a
  scene delegate that is missing.
- **Autolinked modules.** rn-xtool's expo-modules-autolinking 58.0.15 is not patched: on Linux its `@ExpoModule`
  scanner returns early, without a warning, so only modules declared in `expo-module.config.json` are linked, the same
  set SDK 57's own autolinking links.

The build steps for SDK 57: `prebuild` (when `ios/` is missing, or with `--clean`), `patches`, `rn-artifacts` (skipped
with `rnArtifactsDir`, which must then hold adapted 0.86.3 slots), `jsi`, `rn-spm`, `app-config`, `frameworks`,
`generate`, `xtool-build`. Disk use is that of a bare 0.86.3 project (the artifact slots, see
[bare-react-native.md](bare-react-native.md#older-artifacts-086)) plus SDK 57's precompiled modules, which the plugin
extracts to `ios/build/expo-xcframeworks`.

## Rebuild detection

`rn-xtool run` fingerprints your installed dependencies (every `dependencies`/`devDependencies` entry at its installed
version, plus `patches/*.patch`) and compares that with the fingerprints stored by the last successful `build` and
`install`:

- **Unchanged** (built and installed for the current dependencies, and the baked Metro port and LAN IP still work): it
  prints `Native app is up to date`, skips build and install and starts Metro without clearing its cache.
- **Changed** (for example after `npx expo install <native lib>`), or never installed, or the port or LAN IP no longer
  match: it rebuilds, reinstalls and starts Metro with `--clear` (every rebuild clears the cache), so a new native
  module and new Babel plugins are picked up. Without this you get `TurboModuleRegistry.getEnforcing(...) could not be
  found` (app not rebuilt) or `Metro has encountered an error while trying to resolve module` (stale cache).

There is no native/JS distinction: any dependency change rebuilds. JS-only changes also need a Metro cache reset, and
telling native dependencies apart reliably needs the autolinking pass. The cable is needed only when `run` reinstalls,
or never with [Wi‑Fi installs](wifi-install.md) (`install --network`).

- `rn-xtool start` warns and adds `--clear` itself when dependencies changed since the last build;
  `rn-xtool start --clear` forces a cache reset.
- `rn-xtool run --force` always rebuilds and reinstalls (`--clean` does too).
- `rn-xtool doctor` reports a `deps` warning when the app is out of date.

## Mixed-language manifests

Mixed Swift + Objective-C packages (scaffolded libraries, generated Expo modules, and a bare app target with C-family
sources) get two manifests: `Package.swift` (`swift-tools-version: 6.4;(experimentalMultiLang)`, what Swift 6.4 builds)
and `Package@swift-6.5.swift` (the same with tools-version 6.5 and no flag, SE-0541), which SwiftPM 6.5+ picks instead.
`doctor` notes it when your Swift is 6.5 or newer. The 6.5 form is untested until a 6.5 toolchain is available.

## CocoaPods-only libraries

Libraries with no `Package.swift` get one generated automatically by React Native's `spm scaffold`. The React Native
patch above is what makes that scaffolder work for real-world podspecs.

- rn-xtool persists the generated file in your project's `patches/` with patch-package: commit those files.
- On every build the `patches` step applies rn-xtool's own patches and then your project's `patches/` (when present),
  so a fresh `node_modules` gets those Package.swift files back. To also restore them on a plain `npm install`, add
  `"postinstall": "patch-package"` to your `package.json` scripts and `patch-package` to your devDependencies.
- If persisting a scaffolded package fails (no lockfile, no network, ...), rn-xtool prints a warning and keeps
  building; the package is simply re-scaffolded after the next fresh install.
- Mapped external dependencies (for example SwiftUIIntrospect, pinned to an exact version) are fetched from GitHub on
  the first clean build; offline builds with `rnArtifactsDir` need them already cached in `ios-xtool/.build`.
- Swift code that imports a scaffolded library (the App, or an Expo module such as expo-router importing RNScreens)
  builds that library's module from its headers, so it needs the library's header search paths. The scaffolder records
  them in the manifest of every mixed library, and of a clang-only one whose search paths go beyond its public
  headers (`// rn-xtool-swift-importer-paths: [...]`), and rn-xtool passes them as `-Xcc -I...` to the App target and
  to the Expo packages that depend on the library.
- A persisted patch written by an older scaffolder revision (or for another React Native version) gets a warning at the
  `patches` step naming the file to delete and the library to reinstall; rn-xtool then regenerates it.

Which libraries are verified: [libraries.md](libraries.md).

## Reference timings

On a warm cache: patches 3.6 s, RN SwiftPM 11.1 s, ExpoModulesJSI 12.7 s, xtool build 24.5 s. The resulting `App.app`
is about 99 MB with 8 embedded frameworks.

## Further reading

- [recipe.md](recipe.md): the full technical recipe, with file locations.
- [design/specs/2026-10-23-expo-xtool-design.md](design/specs/2026-10-23-expo-xtool-design.md): the original design
  (in Spanish); the other design records are listed in the [docs index](README.md#design-records).
