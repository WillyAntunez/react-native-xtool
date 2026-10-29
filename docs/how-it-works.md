# How it works

rn-xtool does not reimplement Xcode. It patches the official React Native 0.88 and Expo SDK 58 SwiftPM pipeline so it
runs on Linux (React Native 0.86 and 0.87 and Expo SDK 57, which ship none, run vendored copies of it), generates a
SwiftPM package for your app in `ios-xtool/`, and hands it to [xtool](https://github.com/xtool-org/xtool), which builds,
signs and installs it with the Darwin SDK extracted from your own `Xcode.xip`. This page is the overview (toolchain,
patches, build steps, Expo SDK 58 and 57, rebuild detection, scaffolded libraries); [recipe.md](recipe.md) has every
step with file locations.

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

1. Applies the bundled patches to `node_modules` with patch-package, on Expo projects and bare React Native 0.88.x
   projects (each patch only when its package is installed, so a bare project without Expo modules gets only the
   React Native one). Bare 0.86 and 0.87 projects get none: the fixes live in the vendored scripts. An Expo SDK 57
   project gets only the patches of its installed versions' release lines, which is `expo-modules-jsi+57.1.3.patch`
   (see [Expo SDK 57](#expo-sdk-57)). An Expo SDK 58 project gets four patches, named
   after the versions of the 58.0.21 set (a newer 58.x gets the same ones, see [Expo SDK 58](#expo-sdk-58)). Two are
   one-liners (the `@ExpoModule` scanner gate in `expo-modules-autolinking+58.0.16.patch`, a Swift 6.4 access-level
   error in `expo-modules-jsi+58.0.21.patch`). The other two are large:
   - **Expo** (`patches/expo+58.0.21.patch`, files under `expo/scripts/spm/`): finds the Swift macro plugin on Linux;
     gives pure-Swift modules the Foundation/UIKit imports CocoaPods' umbrella header provides
     ([upstream/expo-spm-plugin-umbrella.md](upstream/expo-spm-plugin-umbrella.md)); builds Expo modules that mix Swift
     and Objective-C or are Objective-C only, such as expo-application and the dev client chain; skips meta pods (no
     sources) and placeholder files; links generated packages to their podspec `dependency` and `add_dependency` pods,
     React Native libraries with a `Package.swift` included; leaves headers that import the module's own `-Swift.h`
     out of its Swift umbrella; gives Swift importers of a scaffolded mixed library its header search paths; excludes
     resources only Xcode's tools compile (asset catalogs, storyboards); refuses modules built from vendored C sources
     such as expo-sqlite ([upstream/expo-spm-plugin-mixed-modules.md](upstream/expo-spm-plugin-mixed-modules.md)).
   - **React Native** (`patches/react-native+0.88.1.patch`, and its identical copy `react-native+0.88.0.patch` for bare
     0.88.0; about 1.95k lines across 3 files under
     `react-native/scripts/spm/`: `read-podspec.js`, `scaffold-package-swift.js`, `spm-utils.js`): 17 generic fixes to
     the `spm scaffold` podspec reader and `Package.swift` generator, including mixed Swift + Objective-C/C++ targets,
     known CocoaPods dependencies mapped to SwiftPM packages and the Swift importer paths of mixed targets, plus one to
     the per-app header farm ([upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)).

   Then, in the same step, rn-xtool makes the libraries' own `Package.swift` files portable to Linux, because SwiftPM
   compiles them on the host. In each top-level and scoped package of the project's `node_modules`, it rewrites a known
   Darwin-only snippet by content, not by library version, and prints one `manifest —` line per library it fixed.
   Packages linked from outside the project are skipped, with a line saying so. Today the snippet is `CFGetTypeID`,
   checked in react-native-reanimated 4.7.1 and react-native-worklets 0.13.0 and 0.13.1
   ([upstream/reanimated-worklets-manifest.md](upstream/reanimated-worklets-manifest.md)).
2. Bare projects on the vendored SwiftPM scripts (React Native 0.86 or 0.87), and Expo SDK 57 projects, first run the
   `rn-artifacts` step (downloads
   and, for 0.86, adapts the prebuilt artifacts, see [bare-react-native.md](bare-react-native.md#older-artifacts-086)).
   Then runs React Native 0.88's SwiftPM pipeline (the vendored copy for 0.86 and 0.87, see
   [below](#vendored-swiftpm-scripts)) and Expo's SPM plugin (the vendored copy for SDK 57, see
   [Expo SDK 57](#expo-sdk-57)), with Linux shims for `plutil` and `otool`.
3. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks. On Expo SDK 57 the JSI build runs before
   step 2, because the vendored plugin needs its headers. Before staging, the `frameworks` step checks that the
   frameworks fit together ([G4](#precompiled-frameworks-g4)).
4. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable artifact; do
   not edit it by hand.
5. Gives CocoaPods-only libraries a `Package.swift` (see [below](#cocoapods-only-libraries)).
6. `xtool` builds, signs and installs the app; Metro serves JS to the phone over Wi‑Fi.

Bare React Native projects follow the same steps with a few differences (no `expo prebuild`, no injection into your
Xcode project, ExpoModulesJSI only with Expo modules): see [bare-react-native.md](bare-react-native.md).

## Vendored SwiftPM scripts

React Native 0.86 ships no SwiftPM scripts, and 0.87's lack exports and an option rn-xtool's driver calls. Rather
than patching those installs, rn-xtool bundles the 0.88.0 scripts in `vendor/rn-spm/` (the 17 scaffolder fixes
already applied; provenance and how it is checked in [vendor/rn-spm/README.md](../vendor/rn-spm/README.md)) and the
driver is given `--scripts-root` pointing at them. Expo SDK 57 (React Native 0.86.3) uses them too. The installed
React Native keeps its own codegen. Five edits to the vendored copy:

- **E1**: the codegen template (`Package.swift.spm-template`, missing from 0.86) is read from the vendored copy.
- **E2, E3**: the React Native root comes only from the `RN_SPM_RN_ROOT` environment variable (set by the driver to the
  installed `react-native`), never from the scripts' own location.
- **E4**: `download-spm-artifacts.js` accepts `--allow-pre-headers-spec`, so a 0.86 slot without the headers
  xcframeworks is downloaded instead of rejected (the `rn-artifacts` step then adapts it).
- **E5**: `spm/autolinking-plugins.js` takes the autolinking plugin of the dependency named `expo` from the
  `RN_SPM_EXPO_PLUGIN` environment variable (set by the driver's `--expo-plugin`) when `expo` declares none, which is
  the case on Expo SDK 57.

React Native 0.88.x keeps using its installed scripts and the bundled patch for its version, else the highest one of
its release line (`patches/react-native+0.88.0.patch` or `patches/react-native+0.88.1.patch`, the same content: a fix
edits both; 0.88.2 gets the 0.88.1 patch). If that patch does not apply, the build stops with
`pin "react-native" to 0.88.1`.

**Which scripts a bare project gets** is decided from the installed scripts' layout, not from the version number
(`scriptsCapability` in `src/project/scriptsShape.ts`). rn-xtool reads seven files of `react-native/scripts` as text
(it never loads them) and checks that each exists and has the exports and options rn-xtool calls. It recognises
three layouts:

- no scripts at all (0.86): the vendored copy, when rn-xtool bundles no react-native patch for the version's line;
- 0.87's, which lacks `setup-apple-spm.js`'s `resolveAppIosDeploymentTarget`, `spm/scaffold-package-swift.js`'s
  `refreshScaffoldedPlatformFloors` and `spm/sync-spm-autolinking.js`'s `--ios-deployment-target`: the vendored copy,
  on the same condition;
- 0.88's, with everything: the installed scripts, when rn-xtool bundles a react-native patch for the version's line.

Anything else, including a known layout without its matching patch condition, is "not recognised": `doctor --project`
says so and names what is missing, and the build falls back to the line's scripts mode in `SUPPORTED_LINES`
(`src/versions.ts`). For every supported version the result equals that table: 0.86.x and 0.87.x vendored, 0.88.x
installed. The scripts mode also plans the `rn-artifacts` step: with the vendored scripts rn-xtool downloads the
artifacts itself (unless `rnArtifactsDir` is set), and with the installed ones the build first checks that a bundled
react-native patch of the installed line exists. Expo projects do not use this detection: SDK 57 always takes the
vendored scripts, because the vendored Expo plugin needs them (E5), and SDK 58 the installed ones; `doctor --project`
still prints their layout.

## Expo SDK 58

Expo SDK 58 builds with its installed SwiftPM plugin and the four bundled patches above. Its verified set is a
floor, not an exact list: expo 58.0.21, react-native 0.88.1, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21,
expo-modules-autolinking 58.0.16, expo-file-system 58.0.13 and expo-font 58.0.11. Each is read where the build
resolves it (expo-file-system and expo-font under `expo`, where npm nests them). `doctor` and `build` check the set
before anything is built:

- **G1, the floor.** A package older than the floor, or missing, stops the build. react-native stays exact (0.88.1),
  because Expo's precompiled modules are built against it. A newer 58.x of the other packages prints a warning and
  the build continues. The remedy removes the expo-modules-* pins (`npm uninstall …`), moves `expo` when it is
  listed (`npx expo install expo@~58.0.21`), runs `npx expo install --fix`, and ends with an explicit
  `npx expo install react-native@0.88.1`, because `--fix` takes react-native's version from Expo's versions API,
  which lists 0.88.0 for SDK 58 (see `docs/troubleshooting.md`). A hybrid app is sent to the bare docs' React Native
  upgrade sequence instead of that last command. An expo-modules-core held back by a lockfile, next
  to newer precompiled modules, is what made the reference app crash at launch.
- **G2, one expo-modules-jsi.** The copy the build uses must be `node_modules/expo-modules-jsi`, the one patch-package
  patches. A pin on expo-modules-jsi is what nests a second copy under expo-modules-core. Once the pin is gone,
  package-lock.json can keep the remaining copy nested; `npm update expo-modules-jsi` moves it to the top level.
- **G3, the macro plugin.** The expo-modules-macros that expo-modules-core depends on must be installed with its Linux
  binary (`@expo/modules-macros-linux-<arch>`, at the version expo-modules-macros lists). A lockfile written on macOS
  can lack it; `npm install --include=optional` adds it.

The texts are in [troubleshooting.md](troubleshooting.md#expo-sdk-58). The 58.0.19 set of the previous release is no
longer accepted: npm no longer resolves it on its own (`expo@58.0.19` now pulls an expo-modules-core that nests a
second expo-modules-jsi). Hybrid apps (bare React Native with Expo modules) run the same checks; they need React
Native 0.88.1 and Expo SDK 58. SDK 59 and newer have no verified set yet: they are not checked against one, and G4
is their only check.

**Patches on a newer 58.x.** Every package gets the patch for its installed version, else the highest bundled patch of
its release line (packages other than react-native then fall back to the highest bundled one), so a newer 58.x gets the
floor's patch and patch-package's own version warning is let through. If that patch does not apply, the build stops with
"rn-xtool could not patch <package>". Its remedy is an npm `"overrides"` block that holds expo-modules-core,
expo-modules-jsi and expo-modules-autolinking (and the failing package) on the verified set, built from the same table
as G1, or waiting for an rn-xtool release. It says not to pin expo-modules-* packages as direct dependencies: such a pin
nests the copy expo uses, which G2 refuses, while an override applies to every copy (see
[troubleshooting.md](troubleshooting.md#build-and-patches)).

## Precompiled frameworks (G4)

Expo ships some modules precompiled (ExpoModulesCore, ExpoModulesWorklets, ExpoFileSystem, ExpoFont), and each was
linked against the versions of the modules it imports from that Expo built it with. A precompiled module next to an
older ExpoModulesCore builds, and then the app closes on the iPhone at launch, before any JS runs
(`dyld: Symbol not found`). The `frameworks` step therefore runs `llvm-nm` (from the Swift toolchain `setup`
installs) on every framework it is about to embed. Each symbol a framework imports from another embedded framework
must be exported by it; if one is not, the build stops naming both frameworks, their packages and one missing symbol
(mangled). Weak imports and system libraries are not checked. G4 runs on every project kind (Expo SDK 57 and 58,
bare, hybrid), has no bypass flag, and a missing `llvm-nm` is an error. On 2026-10-28 it passed, with no false
positive, on the default SDK 58 template, the SDK 58 reference app with expo-router, a bare React Native 0.88.1 app,
a hybrid app (expo 58.0.21, React Native 0.88.1), an Expo SDK 57 app and a bare React Native 0.86.3 app.

G4 compares the symbols each embedded framework imports with the ones the framework it imports from exports, the
check dyld runs at launch. It cannot see C++ or Swift layout changes that keep the same symbols, or lookups by name
at runtime (NSClassFromString, Swift _typeByName). rn-xtool pins react-native exactly (0.88.1 on SDK 58) because
Expo's precompiled modules are built against it.

## Expo SDK 57

Expo SDK 57 (expo 57.0.31, React Native 0.86.3) ships no SwiftPM plugin: no `expo/scripts/spm`, an autolinking CLI
without the commands the plugin calls, a macro plugin with no Linux binary, and no `ExpoModulesJSIHeaders.xcframework`.
It does ship ExpoModulesCore (and ExpoModulesWorklets, ExpoFileSystem, ExpoFont) precompiled inside its npm packages.
rn-xtool builds it with a vendored copy of Expo SDK 58's plugin, on the same driver path as bare projects:

- **A floor.** SDK 57 is checked like SDK 58 (G1–G3, with SDK 58's G1 and G2 texts), on the 57 set: at least expo
  57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3, each on SDK 57's
  line (57.x), and react-native exactly 0.86.3, because Expo's precompiled modules are built against it. Each is read
  where the build resolves it (expo-modules-core from `expo`, expo-modules-jsi from expo-modules-core). An older
  version, a missing one, or one of another SDK's line (expo-modules-jsi 58.x) stops the build; a newer 57.x prints a
  warning and the build continues. expo-modules-jsi must also be the top-level copy, the only one patch-package
  patches. The messages are in [troubleshooting.md](troubleshooting.md#expo-sdk-57). SDK 58 and newer keep their
  installed plugin; SDK 56 and older are refused.
- **Patches by release line.** An SDK 57 project gets, for each package, the bundled patch for its installed version,
  else the highest bundled patch of the same release line, and never another SDK's patch (`lineOnly`). Today that is
  `expo-modules-jsi+57.1.3.patch`, also on a newer 57.x jsi. When it does not apply, the build stops with
  "rn-xtool could not patch expo-modules-jsi@<version>" and the npm `"overrides"` block for the 57 set
  ([troubleshooting.md](troubleshooting.md#build-and-patches)).
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
