# How it works

rn-xtool does not reimplement Xcode. It patches the official React Native 0.88 and Expo SDK 58 SwiftPM pipeline so it
runs on Linux (React Native 0.85, 0.86 and 0.87 and Expo SDK 57, which ship none, run vendored copies of it), generates
a SwiftPM package for your app in `ios-xtool/`, and hands it to [xtool](https://github.com/xtool-org/xtool), which
builds, signs and installs it with the Darwin SDK extracted from your own `Xcode.xip`. This page is the overview
(toolchain, patches, build steps, Expo SDK 58 and 57, rebuild detection, the first launch, dev-client discovery,
scaffolded libraries, CocoaPods binaries); [recipe.md](recipe.md) has every step with file locations.

[Back to README](../README.md)

## What `setup` installs

- Swift 6.4 via swiftly, the xtool 1.24.0 AppImage (needs FUSE 2: `libfuse2t64` on Ubuntu 24.04 and newer, `libfuse2`
  on older releases) and the Darwin SDK extracted from your `Xcode.xip` (Xcode 27.x). `setup` is idempotent: a second
  run skips what is installed and downloads nothing.
- Free disk: before the first download, `setup` adds up what it still has to install, per filesystem, and stops with
  `Not enough free disk space for setup: …` when one is short. The figures: Swift toolchain 5 GB
  (`~/.local/share/swiftly`), xtool 0.2 GB (next to the AppImage), Darwin SDK 15 GB (`~/.swiftpm/swift-sdks`, or
  `$XDG_CONFIG_HOME/swiftpm/swift-sdks` when `XDG_CONFIG_HOME` is set, where xtool puts it: xtool unpacks the whole
  Xcode there before it trims it to the SDK, about 7 GB) and the first build 4 GB (React Native artifacts in
  `~/Library/Caches/ReactNative`, about 1.3 GB per React Native version, then the app's `ios-xtool/.build`). About
  25 GB on a fresh machine, plus the Xcode.xip (about 12 GB), which is not counted. A half-written
  `darwin.artifactbundle.tmp` left by an interrupted SDK install is removed before the check.
- Swift's system packages are not installed for you: when some are missing, `setup` prints the exact
  `sudo apt-get update && sudo apt-get -y install ...` line to run before running `setup` again. On Ubuntu 24.04:
  `binutils zip gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libgcc-13-dev libpython3-dev libstdc++-13-dev libxml2-dev
  libncurses-dev libz3-dev pkg-config zlib1g-dev`.
- Also needed on the host: `python3` (used by the `plutil` / `otool` shims) and `iproute2` (the `ip` command, to detect
  the LAN IP).
- Package manager: npm or Yarn classic. patch-package needs a flat `node_modules`; pnpm and Yarn PnP are not supported.

## The build, step by step

1. When a library depends on CocoaPods pods that ship prebuilt binaries (Google's ML Kit), the `pods` step comes
   first, before `expo prebuild` and anything else that changes the project: it reads the pods' specs from the
   CocoaPods CDN, downloads the files and checks them against `rn-xtool-pods.lock.json`, and wraps them for SwiftPM
   in rn-xtool's cache ([CocoaPods binaries](#cocoapods-binaries)). Then, on Expo, `expo prebuild` when `ios/` is
   missing.
2. Applies the bundled patches to `node_modules` with patch-package, on Expo projects and bare React Native 0.88.x
   projects (each patch only when its package is installed, so a bare project without Expo modules gets only the
   React Native one). Bare 0.85, 0.86 and 0.87 projects get none: the fixes live in the vendored scripts. An Expo SDK 57
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
     0.88.0; about 5.7k lines across 6 files under `react-native/scripts/spm/`: `read-podspec.js` and its Ruby shim
     `read-podspec-shim.rb`, `scaffold-package-swift.js`, `spm-utils.js`, `expand-spm-dependencies.js`,
     `spm-types.js`): 29 generic fixes to the `spm scaffold` podspec reader, the `Package.swift` generator and (two)
     the per-app header farm, including reading podspecs in Ruby, mixed Swift + Objective-C/C++ targets, CocoaPods
     dependencies mapped to SwiftPM packages through a pod table file (or to the local package of CocoaPods binaries),
     the Swift importer paths of mixed targets, dependencies on packages that are not installed left out, the Swift 5
     language mode and Swift compilation conditions
     ([upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)).

   Then, in the same step, rn-xtool makes the libraries' own `Package.swift` files portable to Linux, because SwiftPM
   compiles them on the host. In each top-level and scoped package of the project's `node_modules`, it rewrites a known
   Darwin-only snippet by content, not by library version, and prints one `manifest —` line per library it fixed.
   Packages linked from outside the project are skipped, with a line saying so. Today the snippet is `CFGetTypeID`,
   checked in react-native-reanimated 4.7.1 and react-native-worklets 0.13.0 and 0.13.1
   ([upstream/reanimated-worklets-manifest.md](upstream/reanimated-worklets-manifest.md)).
3. Bare projects on the vendored SwiftPM scripts (React Native 0.85, 0.86 or 0.87), and Expo SDK 57 projects, first run
   the `rn-artifacts` step (downloads
   and, for 0.85 and 0.86, adapts the prebuilt artifacts, see
   [bare-react-native.md](bare-react-native.md#older-artifacts-085-086)).
   Then runs React Native 0.88's SwiftPM pipeline (the vendored copy for 0.85, 0.86 and 0.87, see
   [below](#vendored-swiftpm-scripts)) and Expo's SPM plugin (the vendored copy for SDK 57, see
   [Expo SDK 57](#expo-sdk-57)), with Linux shims for `plutil` and `otool`. With CocoaPods binaries, the
   `pod-binaries` step writes the local package the scaffolds link, `ios/build/pod-binaries`, right before.
4. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks. On Expo SDK 57 the JSI build runs before
   step 3, because the vendored plugin needs its headers. Before staging, the `frameworks` step checks that the
   frameworks fit together ([G4](#precompiled-frameworks-g4)).
5. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable artifact; do
   not edit it by hand. It also gets:
   - the app's entitlements, as `App.entitlements`, when the file `CODE_SIGN_ENTITLEMENTS` names has keys
     ([Entitlements](#entitlements));
   - on Expo, the bridging header the prebuild's Xcode project names (`SWIFT_OBJC_BRIDGING_HEADER`), copied to
     `Sources/App` and passed to Swift with `-import-objc-header`, unless it holds only comments, as Expo's default
     does (a config plugin such as react-native-app-auth's adds imports to it);
   - for apps without `expo-dev-client`, the `RNXtoolDevSupport` target, which reloads the app once Metro is reachable
     ([First launch](#first-launch));
   - `AppIcon.png`, the app icon taken from `Images.xcassets/AppIcon.appiconset`, named by `iconPath` in `xtool.yml`
     ([details](troubleshooting.md#app-icon-and-launch-screen));
   - for apps with `expo-dev-client`, `DEV_CLIENT_DEFAULT_LAUNCHER_URL = http://<lanIp>:<metroPort>` and `_expo._tcp`
     in `NSBonjourServices` in Info.plist ([Dev-client discovery](#dev-client-discovery));
   - the resource bundles of the CocoaPods binaries and of scaffolded libraries, under `Resources/`, and, with
     CocoaPods binaries, their link flags on the App target ([CocoaPods binaries](#cocoapods-binaries)).
6. Gives CocoaPods-only libraries a `Package.swift` (see [below](#cocoapods-only-libraries)).
7. The `precheck` step checks the app's own sources before `xtool-build` compiles them. SwiftPM plans the generated
   package (`swift package describe`), and rn-xtool reads the header folders and module maps of its dependency graph;
   the app's includes are resolved again with the App target's full include list; `swiftc -typecheck` checks the Swift
   files, and `clang -fsyntax-only` each C-family file with the generated manifest's flags, as many at a time as the
   machine has cores. When a Swift file imports a module SwiftPM builds from Swift (a Swift module such as `Expo`, or
   a library target that holds Swift files next to its Objective-C), the Swift files are left to `xtool-build`, and so
   is a C-family file that `@import`s such a module or one no module map declares: on Expo the app's Swift files import such a module (`Expo`, or `ExpoModulesCore` in the
   generated `ExpoModulesProvider.swift`), so they are always checked there. On errors it prints each include that
   resolves nowhere and the compilers' first ten errors, with their include stacks, and stops the build; every command
   line and all compiler output go to `ios-xtool/.precheck/precheck.log`. clang's module cache stays under
   `ios-xtool/.precheck/` between builds; the first precheck, and the first after `--clean` empties the cache, is slower
   while clang builds React Native's modules. `--skip-precheck` on `build` and `run` leaves the step out
   ([troubleshooting.md](troubleshooting.md#precheck)).
8. `xtool` builds, signs and installs the app; Metro serves JS to the phone over Wi‑Fi. With CocoaPods binaries,
   rn-xtool checks the packed `App.app` before anything installs it.

The app's own includes are also checked earlier, with file reads only, and no flag skips that check (pass 1): before
the `patches` step (on Expo, once `expo prebuild` has written `ios/`), rn-xtool resolves the `#import` and `#include`
lines of the app target's own files as the generated App target compiles them, and a quote include of one of the
app's own headers that resolves nowhere stops the build seconds after it starts. It reads `#if` and `#ifdef` with the
macros the App compile defines: `SWIFT_PACKAGE`, `DEBUG=1`, the target's own `GCC_PREPROCESSOR_DEFINITIONS` and the
iOS values of `TARGET_OS_*`. The generated App target does not define `RCT_NEW_ARCH_ENABLED`, so an include under a
condition on it, or on any other macro, is left to the compile. In a project with CocoaPods binaries,
whose headers pass 1 cannot see, it never stops: every miss is left to the `precheck` step. On Expo the one app file it
reads is the bridging header. `doctor --project` runs the same check as its `app-includes` line, on a machine without
a toolchain too. Includes into React Native's or the libraries' headers are left to the `precheck` step.

Bare React Native projects follow the same steps with a few differences (no `expo prebuild`, no injection into your
Xcode project, ExpoModulesJSI only with Expo modules): see [bare-react-native.md](bare-react-native.md).

## Vendored SwiftPM scripts

React Native 0.85 and 0.86 ship no SwiftPM scripts, and 0.87's lack exports and an option rn-xtool's driver calls.
Rather than patching those installs, rn-xtool bundles the 0.88.0 scripts in `vendor/rn-spm/` (the 29 scaffolder fixes
already applied; provenance and how it is checked in [vendor/rn-spm/README.md](../vendor/rn-spm/README.md)) and the
driver is given `--scripts-root` pointing at them. Expo SDK 57 (React Native 0.86.3) uses them too. The installed React
Native keeps its own codegen. Six edits to the vendored copy:

- **E1**: the codegen template (`Package.swift.spm-template`, missing from 0.85 and 0.86) is read from the vendored
  copy.
- **E2, E3**: the React Native root comes only from the `RN_SPM_RN_ROOT` environment variable (set by the driver to the
  installed `react-native`), never from the scripts' own location.
- **E4**: `download-spm-artifacts.js` accepts `--allow-pre-headers-spec`, so a 0.85 or 0.86 slot without the
  headers xcframeworks is downloaded instead of rejected (the `rn-artifacts` step then adapts it).
- **E5**: `spm/autolinking-plugins.js` takes the autolinking plugin of the dependency named `expo` from the
  `RN_SPM_EXPO_PLUGIN` environment variable (set by the driver's `--expo-plugin`) when `expo` declares none, which is
  the case on Expo SDK 57.
- **E6**: `spm/generate-spm-autolinking.js` rethrows a podspec reader failure from its header search path read instead
  of returning no paths, so autolinking stops with the reader's message (React Native 0.88.1 has no such read, so the
  0.88 patches cannot carry it).

React Native 0.88.x keeps using its installed scripts and the bundled patch for its version, else the highest one of
its release line (`patches/react-native+0.88.0.patch` or `patches/react-native+0.88.1.patch`, the same content: a fix
edits both; 0.88.2 gets the 0.88.1 patch). If that patch does not apply, the build stops with
`pin "react-native" to 0.88.1`.

**Which scripts a bare project gets** is decided from the installed scripts' layout, not from the version number
(`scriptsCapability` in `src/project/scriptsShape.ts`). rn-xtool reads seven files of `react-native/scripts` as text
(it never loads them) and checks that each exists and has the exports and options rn-xtool calls. It recognises
three layouts:

- no scripts at all (0.85, 0.86): the vendored copy, when rn-xtool bundles no react-native patch for the version's line;
- 0.87's, which lacks `setup-apple-spm.js`'s `resolveAppIosDeploymentTarget`, `spm/scaffold-package-swift.js`'s
  `refreshScaffoldedPlatformFloors` and `spm/sync-spm-autolinking.js`'s `--ios-deployment-target`: the vendored copy,
  on the same condition;
- 0.88's, with everything: the installed scripts, when rn-xtool bundles a react-native patch for the version's line.

Anything else, including a known layout without its matching patch condition, is "not recognised": `doctor --project`
says so and names what is missing, and the build falls back to the line's scripts mode in `SUPPORTED_LINES`
(`src/versions.ts`). For every supported version the result equals that table: 0.85.x, 0.86.x and 0.87.x vendored,
0.88.x installed. The scripts mode also plans the `rn-artifacts` step: with the vendored scripts rn-xtool downloads the
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

**Scaffolding.** A CocoaPods-only library goes through rn-xtool's driver, as on bare apps
([CocoaPods-only libraries](#cocoapods-only-libraries)): `scripts/rn-spm-generate.js --scaffold` runs on the installed,
patched React Native scripts, with Expo's autolinking command (`npx expo-modules-autolinking react-native-config --json
--platform ios`) as its config command, and scaffolds only the libraries React Native named. Expo's own modules are
left to its plugin. `setup-apple-spm.js add` (or `update`) then runs again. React Native's own `setup-apple-spm.js
scaffold` is not used.

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
[bare-react-native.md](bare-react-native.md#older-artifacts-085-086)) plus SDK 57's precompiled modules, which the
plugin extracts to `ios/build/expo-xcframeworks`.

## Rebuild detection

`rn-xtool run` fingerprints your installed dependencies (every `dependencies`/`devDependencies` entry at its installed
version, plus `patches/*.patch`, plus rn-xtool's own version) and compares that with the fingerprints stored by the
last successful `build` and `install`:

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

## First launch

On the first launch of a debug build, React Native checks whether Metro runs with a request to the baked host before
it loads the bundle. That request is the app's first local-network connection: iOS shows the Local Network prompt and,
while it is open, denies the request at once (Apple TN3179). React Native then finds no bundle and shows the red screen
"No script URL provided". The same happens on a Mac for an Expo app without a dev client.

For apps without `expo-dev-client` (Expo and bare), `build` adds a small target, `RNXtoolDevSupport`, to the debug
build: a C policy with no I/O and an Objective-C file that connects it to React Native's notifications, UIKit's app
state and Network.framework. Its sources are in `templates/dev-support/`, copied as they are into
`ios-xtool/Sources/RNXtoolDevSupport/`. Dev-client apps do not get it: their launcher does not run this check and asks
for Local Network access itself.

- When React Native reports that the bundle failed to load (`RCTJavaScriptDidFailToLoadNotification`), the helper
  opens a connection to Metro's host and port. iOS retries it by itself once the user taps Allow. When it connects, the
  helper reloads the app (`RCTTriggerReloadCommandListeners`).
- It reloads at most once per failure, and never once a bundle has loaded, so a bundling error with Metro up never
  reloads in a loop. If Metro was reachable at once, the failure has another cause and it does not reload.
- It runs only while the app is in the foreground. It gives up 5 minutes after the first failure. So an app opened
  before `rn-xtool start` also recovers once Metro starts, within those 5 minutes.
- When the connection keeps waiting because Local Network access is denied (Don't Allow), the app shows one alert,
  "Local Network access is off", with an Open Settings button: at most once per launch, only while the app is active
  (not while the system prompt is up), and only after 3 seconds of denial.
- It reads Metro's host and port where React Native does: `ip.txt` in the app bundle (bare apps carry `<ip>:<port>`
  there), and the port from Info.plist `RCTMetroPort` (Expo apps), else 8081.
- It names React Native's notification and reload function as strings and looks the function up at run time
  (`dlsym`), and it imports no React header. If a React Native release renames them, the helper does nothing and the
  app behaves as before; the build never breaks on it.

## Dev-client discovery

expo-dev-launcher finds Metro servers only through Bonjour (`_expo._tcp`) announcements. Expo CLI announces Metro under
the app config's bundle id, but xtool installs the app as `XTL-<Team ID>.<bundle id>`, and Expo SDK 58's launcher hides
servers whose announced id differs from the app's own.

- `rn-xtool install` records the bundle id of the app it installed in the build state (`installedBundleId` in
  `ios-xtool/.rn-xtool-state.json`), without asking the iPhone anything more: over Wi‑Fi, the id the install reports;
  over USB, the `XTL-<Team ID>.<bundle id>` it logs. `build` keeps that id while the bundle id stays the same.
- `rn-xtool start` announces Metro with the project's own `dnssd-advertise` (Expo CLI's announcer, never an rn-xtool
  dependency), as Expo CLI does, but with that id. For Expo apps, only once it started does `start` run `expo start`
  with `EXPO_UNSTABLE_BONJOUR=0`, which turns Expo's own off. If it cannot announce, Expo's announcement stays, with an
  `ℹ` line. When `start` ends, it sends the goodbye (waiting at most a second).
- A user's off switch (`CI`, `EXPO_UNSTABLE_BONJOUR=0`) is respected, read from the environment `start` runs in.
- The messages and what to do with them: [troubleshooting.md](troubleshooting.md#dev-client).

## Mixed-language manifests

Mixed Swift + Objective-C packages (scaffolded libraries, generated Expo modules, and a bare app target with C-family
sources) get two manifests: `Package.swift` (`swift-tools-version: 6.4;(experimentalMultiLang)`, what Swift 6.4 builds)
and `Package@swift-6.5.swift` (the same with tools-version 6.5 and no flag, SE-0541), which SwiftPM 6.5+ picks instead.
`doctor` notes it when your Swift is 6.5 or newer. The 6.5 form is untested until a 6.5 toolchain is available.

## CocoaPods-only libraries

Libraries with no `Package.swift` get one generated automatically by React Native's `spm scaffold`. The React Native
patch above is what makes that scaffolder work for real-world podspecs.

- The scaffold step runs inside `rn-spm` when React Native reports libraries without a `Package.swift`
  (`▸ scaffold — generating Package.swift for: <libraries>`), and it scaffolds only those: rn-xtool's driver
  (`scripts/rn-spm-generate.js --scaffold`) passes each name as `--only <name>`, and nothing is forced. Every other
  library's `Package.swift`, persisted in `patches/` or edited by hand, stays as it is. A library is scaffolded again
  only once its `Package.swift` is gone ([troubleshooting.md](troubleshooting.md#scaffolded-libraries)). Bare apps,
  Expo SDK 57 and Expo SDK 58 all go through this driver; on SDK 58 it uses Expo's autolinking command
  ([Expo SDK 58](#expo-sdk-58)).
- The driver writes what it did for each library to `ios/build/rn-xtool-scaffold-results.json`
  (`{"results": [{"depName", "status", "reason", "warnings", "root"}]}`; `reason`, `warnings` and `root` when there are
  any). rn-xtool deletes the file before each scaffold run, so it never reads an older run's results.
- A named library counts as scaffolded when its `Package.swift` exists and carries the scaffolder's banner. rn-xtool
  persists the libraries that scaffolded; then, if any named library did not, the build stops with
  `Scaffolding <library> failed: <reason>`, followed by that library's own warnings, one block per failed library.
  Nothing is persisted for a failed library, and React Native does not run a second time
  ([troubleshooting.md](troubleshooting.md#scaffolded-libraries)).
- The scaffolder reads each podspec with the system `ruby` (2.7 or later) through a shim of CocoaPods' DSL and React
  Native's podspec helpers, in the podspec's folder, the way CocoaPods runs it on a Mac: the podspec's own Ruby, and
  the scripts and `node` calls it makes, run on your machine, with the same trust as installing the library. rn-xtool
  never runs `pod ipc spec` or any other CocoaPods command, so a machine with CocoaPods reads a podspec exactly as any
  machine with Ruby. The podspec runs with your `PATH`, `HOME` and `LANG`, and with `RCT_NEW_ARCH_ENABLED` and
  `RCT_HERMES_V1_ENABLED` set to `1`; every other variable and every Podfile global is unset. Its `ios` attributes are
  merged as CocoaPods merges them for an iOS target. A podspec Ruby cannot read stops the build with the podspec and
  the reason ([troubleshooting.md](troubleshooting.md#podspec-reader)). Each read is recorded in
  `ios/build/rn-xtool-podspec-reads.jsonl` (the reader, the Ruby, the `ENV` names the podspec read), which
  `doctor --report` sums up, and each scaffolded manifest names its reader on a marker line,
  `// rn-xtool-podspec-reader: ruby` or `// rn-xtool-podspec-reader: reduced`
  ([fix 29](upstream/react-native-scaffolder.md#29-scriptsspmread-podspecjs-podspecs-are-read-without-react-natives-helpers-or-in-part)).
- Without a usable Ruby, or with `RN_XTOOL_PODSPEC_READER=reduced`, the reduced reader reads the podspecs instead, and
  `rn-spm` says so in one `⚠` line after its runs. It runs the podspec's statements over the subset of Ruby podspecs
  use for their fields: locals (`name = …`, `+=`,
  `||=`; the last assignment that runs wins), single- and double-quoted strings with `#{…}` interpolation, arrays and
  `%w[…]`, `ENV['…']` and `ENV.fetch` (`RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED` are `1`, as React Native's
  CocoaPods setup sets them, and every other variable is unset, whatever the shell says), `==`, `!=`, `!`, `&&`,
  `||`, ternaries, `+` on strings and arrays, `join`, `if`/`elsif`/`else`/`unless` blocks and `if`/`unless`
  modifiers, and `push`, `<<` and `concat` on a local array. A branch its condition rules out is left out, as
  CocoaPods leaves it out; both branches of a condition it cannot evaluate (a method call such as
  `respond_to?(:install_modules_dependencies, true)`) are read. It also reads the library's own `package.json`
  (`JSON.parse(File.read(File.join(__dir__, "package.json")))`) and hashes. A `source_files`, `exclude_files`,
  `compiler_flags`, `header_dir`, `header_mappings_dir`, `frameworks` or `libraries` value that uses anything else (a
  method call, a local it could not evaluate) fails that library's scaffold, with a reason that names the podspec,
  the field and the expression, since a target built from the part it could read would lack some of the library's
  files or settings; an xcconfig value it cannot evaluate in part is left out with a `Left out of …` warning that
  names it
  ([fix 28](upstream/react-native-scaffolder.md#28-scriptsspmread-podspecjs-source-globs-built-from-ruby-locals-and-conditions-are-read-in-part)).
- After `xtool-build`, `build` checks that every class React Native's codegen providers name
  (`ios/build/generated/ios/ReactCodegen/RCTThirdPartyComponentsProvider.mm` and `RCTModuleProviders.mm`) is defined
  in the App binary or an embedded framework; `install` checks the app xtool builds again before it installs it. A
  missing component class would crash the app at start in `+[RCTThirdPartyComponentsProvider
  thirdPartyFabricComponents]`, so rn-xtool removes the packed app and stops, naming the class, the component or
  module and the library ([troubleshooting.md](troubleshooting.md#rctthirdpartycomponentsprovider-thirdpartyfabriccomponents)).
- The scaffolded `Package.swift` holds no resources. rn-xtool builds the library's unconditional `resource_bundles`
  whose names and globs are plain strings as `<name>.bundle` at the root of `App.app` (react-native-svg's
  `RNSVGFilters.bundle`, react-native-device-info's privacy bundle; [CocoaPods binaries](#cocoapods-binaries)). After
  `rn-spm`, `build` prints one `ℹ Not copied into the app: …` line naming what still does not arrive: plain
  `resources`, and bundles whose name or files are Ruby code.

- rn-xtool persists the generated file in your project's `patches/` with patch-package: commit those files. A
  persisted patch holds the files the scaffold wrote (the scaffold step lists them) and the files the library's
  existing patch already held, so a fix of your own in that patch stays, and build outputs under the package (Gradle's
  `android/build` and `.cxx`) never enter it. When rn-xtool cannot read which files the existing patch holds (or the
  list would not fit in one argument), it diffs the whole package, as patch-package does by itself, and says so in an
  `ℹ` line.
- On every build the `patches` step applies rn-xtool's own patches and then your project's `patches/` (when present),
  so a fresh `node_modules` gets those Package.swift files back. A patch whose package is not installed is left out
  with a `⚠` line, and the others apply
  ([troubleshooting.md](troubleshooting.md#build-and-patches)). To also restore them on a plain `npm install`, add
  `"postinstall": "patch-package"` to your `package.json` scripts and `patch-package` to your devDependencies.
- If persisting a scaffolded package fails (no lockfile, no network, ...), rn-xtool prints a warning and keeps
  building; the package is simply re-scaffolded after the next fresh install.
- A podspec's dependencies on CocoaPods pods are resolved through a pod table ([Third-party pods](#third-party-pods)).
- Swift code that imports a scaffolded library (the App, or an Expo module such as expo-router importing RNScreens)
  builds that library's module from its headers, so it needs the library's header search paths. The scaffolder records
  them in the manifest of every mixed library, and of a clang-only one whose search paths go beyond its public
  headers (`// rn-xtool-swift-importer-paths: [...]`), and rn-xtool passes them as `-Xcc -I...` to the App target and
  to the Expo packages that depend on the library.
- A persisted patch written by an older scaffolder revision (or for another React Native version) gets a warning at the
  `patches` step naming the file to delete and the library to reinstall; rn-xtool then regenerates it. So does a patch
  the reduced reader wrote, on a machine where Ruby reads podspecs
  ([troubleshooting.md](troubleshooting.md#podspec-reader)).
- Before anything is scaffolded, `doctor --project` and `build` check every dependency's podspec. A CocoaPods-only
  library whose podspec declares prebuilt binaries (`vendored_frameworks`, `vendored_libraries`) cannot be scaffolded
  yet: the generated `Package.swift` cannot link them. Neither can one that depends on a git-source pod the pod table
  does not map ([Third-party pods](#third-party-pods)); a pod of prebuilt binaries is downloaded and linked instead
  ([CocoaPods binaries](#cocoapods-binaries)). `build` stops on it before it changes anything, with the reason
  and a link, instead of failing minutes later in the build. Expo modules are left to Expo's plugin, which
  links their binaries; an Expo module that builds C sources from its `vendor/` folder (expo-sqlite) is refused the
  same way. A `Package.swift` the library ships or your `patches/` create counts, and `knownLimits.allow` in
  `rn-xtool.config.json` builds a refused library anyway
  ([troubleshooting.md](troubleshooting.md#unsupported-setups)).

Which libraries are verified: [libraries.md](libraries.md).

## Third-party pods

The scaffolder classifies each `s.dependency` on an unconditional line of a podspec (lines under a Ruby `if` or
`unless` are not read), once, as one of:

- a subspec of the same podspec: skipped;
- a React Native core pod (`React-…`, `RCT…`, `Yoga`, `ReactNativeDependencies`, …): skipped, since the prebuilt
  runtime provides it;
- an Expo module's pod: not wired, with a warning;
- an autolinked sibling, named `react-native-*` or by the pod name of an installed package's podspec (reanimated's
  `RNWorklets`): wired to that package;
- a sibling autolinking does not link: left out, with the subspec that declares it;
- a pod in the pod table: a `.package(url:exact:)` dependency plus its products;
- a pod of prebuilt binaries the `pods` step resolved: `.package(path:)` to `build/pod-binaries` plus its product
  ([CocoaPods binaries](#cocoapods-binaries));
- anything else: unmapped, with a warning.

**The pod table** is merged per pod, field by field, in this order, the later winning: the scaffolder's own baseline
(SwiftUIIntrospect), rn-xtool's `data/pods.json` (AppAuth, and the source pods ML Kit reaches), then the `pods` of
`rn-xtool.config.json`. rn-xtool writes the merged table to `ios/build/rn-xtool-pods.json`, with the binary pods the
`pods` step resolved, and names it in `RN_SPM_POD_TABLE` for every React Native run of the `rn-spm` step; without it the
scaffolder falls back to its baseline. A mapped pod's `forwardHeaders` become `rn-spm-pod-headers/<Dir/Header.h>` files
in the library, each holding one `#import <header>` per public header the pod's umbrella includes, on the library's
header search path: AppAuth's umbrella header is outside its SwiftPM targets, and react-native-app-auth imports it as
`<AppAuth/AppAuth.h>`. The forwarder is textual because Objective-C++ compiles without C++ modules
(`-fmodules -fno-cxx-modules`, Xcode's default), where `@import` is an error. Each manifest records the pods it pins
on a marker line, `// rn-xtool-pods: AppAuth=3.0.0`.

**Before the build.** `doctor --project` and `build` run the same classifier, loaded from rn-xtool's vendored copy of
the scaffolder, never the project's. They read podspecs as text, with no `pod ipc` and no network. The linked
packages are those autolinking links: on bare, what package.json lists in `dependencies`, `devDependencies` and
`peerDependencies`; on Expo, every installed package too. A library rn-xtool would scaffold is refused when it
depends on an unmapped pod whose spec in rn-xtool's cache is a git source (the `pods` step decides for one it has
not read yet), and on bare when it depends by pod name on a package that is installed but not listed in
package.json ([troubleshooting.md](troubleshooting.md#libraries-that-depend-on-cocoapods-pods)). A pin whose version
misses the podspec's requirement (`=`, `>`, `>=`, `<`, `<=`, `~>`, several of them) gets a `⚠` line, not a refusal.

**After a pin changes.** The `patches` step compares each scaffold's marker line with the table and the library's
podspec: a persisted patch that pins another version, or none, gets a `⚠` line naming it, and a scaffold without a
persisted patch is removed so the `rn-spm` step scaffolds it again.

SwiftPM fetches a mapped pod's package from GitHub during `xtool dev build`, as for any package dependency: the first
clean build needs the network, and offline builds with `rnArtifactsDir` need it already in `ios-xtool/.build`.

## CocoaPods binaries

A pod that ships prebuilt static binaries, such as Google's ML Kit, has no SwiftPM package for the pod table to map.
rn-xtool builds one from the vendor's files, in two steps of `build`. The messages, and what to do about each, are in
[troubleshooting.md](troubleshooting.md#cocoapods-binaries).

**`pods`** runs first, before `expo prebuild` and the patches, so a stop leaves the project as it was:

1. **Roots.** Each unconditional `s.dependency` of a library rn-xtool would scaffold that the classifier finds unmapped
   (a table entry always wins), unless the library is left out (`exclude`, `platforms.ios: null`,
   `expo.autolinking.exclude`).
2. **Specs, without Ruby.** The CocoaPods CDN serves every trunk spec as JSON
   (`https://cdn.cocoapods.org/Specs/<a>/<b>/<c>/<Pod>/<version>/<Pod>.podspec.json`, where `<a>`, `<b>` and `<c>`
   are the first three hex digits of the pod name's md5; it redirects to jsDelivr), and one version list per shard
   (`all_pods_versions_<a>_<b>_<c>.txt`). rn-xtool reads them with Node's `fetch` and its own `User-Agent`. A spec is
   cached per version under `~/.cache/rn-xtool/pods/specs` and never read again: CocoaPods trunk is read-only from
   2026-12-02. A reset connection or a 5xx answer is read once more.
3. **The resolver.** Requirements come from the libraries and from the binary pods themselves (a string or a list;
   `=`, `>`, `>=`, `<`, `<=`, `~>`). Each pod gets the newest listed version that meets all of them, greedily, without
   backtracking, and a prerelease only when a requirement names one; the version `rn-xtool-pods.lock.json` records is
   kept while it meets them. Dependencies are walked through binary pods only: a pod the table maps brings its own
   through its `Package.swift`. Each pod's route comes from its spec: an http archive with static
   `vendored_frameworks` is binary, one whose selected subspecs hold only headers is binary and headers-only, a git
   source goes to the table (or is refused), and any other shape stops.
4. **Download and verify.** Before the first download, one `ℹ` line names the libraries, the files and their sizes
   (HEAD requests), the hosts, and each vendor's authors, license texts, homepage and terms page (from
   `data/pod-terms.json`), and the free space is checked: 8 times the downloads on the cache's filesystem, or, when
   the project is on another one, 6 times there and 2 times (the per-app copies) on the project's. Each file
   goes to `downloads/<sha256>.<ext>` through a temporary file per process, with its size checked against
   `Content-Length`, one retry, then its sha256 against the lock (and the spec's own `sha256` or `sha1`, when it names
   one). A cached file is hashed again before reuse. A URL that is not https, or a redirect to plain http, is refused
   unless the lock records the file.
5. **Extract.** The archive is listed first (`tar -tzvf`, or `unzip -Z` for a `.zip`), and an absolute path, a `..`
   segment, a device file or a link out of the tree refuses it. Only what the spec needs is unpacked (the vendored
   frameworks, the resource-bundle globs, header `source_files`, `preserve_paths`, the module map), with the source's
   `flatten` honoured, into `extracted/<sha256>-<stamp hash>`. The tree is assembled beside it, swapped in whole, and
   stamped last.
6. **Wrap.** A small Mach-O reader stands in for `llvm-lipo`, which the toolchain does not ship. It cuts the arm64
   slice out of a fat binary; a simulator slice, a missing arm64 slice, a dynamic framework or a Swift framework stops.
   An `ar` slice is kept as it is, and an `MH_OBJECT` slice (MLKitTextRecognitionCommon's) is wrapped into an archive
   with `llvm-ar rcs --format=darwin`. Each framework becomes a **headers-only xcframework**: one `ios-arm64` library
   slice with an empty placeholder archive and `Headers/<Name>/`, holding the framework's headers and its module map.
   The map is rewritten by content (the leading `framework` keyword goes, the `link` lines stay, so autolinking still
   works), or generated from `Headers/<Name>.h`. The real thin archive sits beside it, as `archives/lib<Name>.a`, in
   `wrapped/<sha256>-<stamp hash>`. The privacy manifests inside the frameworks are named in one `ℹ` line.
7. **The lock** is written when the step succeeds and its content changed, through a temporary file and a rename.

A cache tree's stamp records the `EXTRACTOR_VERSION` (extraction) or `WRAPPER_VERSION` (wrapping) that made it, and
its file count and size; a tree another version made, or whose files changed, is built again. With the lock and every
file in the cache, the step makes no request. Temporary files older than 24 hours are removed when it starts.

**`pod-binaries`** runs right before `rn-spm`, on every build:

- `ios/build/pod-binaries` is the local package `pod-binaries`: a `Package.swift` (tools 6.0, the app's deployment
  target, as the scaffolds read it) with one `.binaryTarget(name:path:)` per xcframework, and one product per root
  pod (`GoogleMLKit`). The product lists its binary targets, which puts their headers on the library directly, and a
  small wrapper C target (`wrapper.c` and `include/<Wrapper>.h`) that depends on the source pods' products, declared
  as `.package(url:exact:)` from the pod table. When two libraries name subspecs of one pod, the product covers them
  all, as CocoaPods installs one pod with every subspec requested.
- `xcframeworks/` and `archives/` are copies of the cache, never links, so an edit there never reaches the cache. They
  keep the cache's modification times, and the generated files are rewritten only when their content changes, so a
  build with nothing changed processes nothing again. `.gitignore` holds `*`. Nothing is written under
  `node_modules`, so `patches/` never holds the vendor's files.
- The scaffolder (fix 27 in [upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)) emits
  `.package(path:)` to `build/pod-binaries`, relative to the `libs/<SwiftName>` symlink, and `.product(name:
  "GoogleMLKit", package: "pod-binaries")`. The marker records `GoogleMLKit=binary` without a version (the lock holds
  the versions), so a persisted scaffold stays portable and a version change does not make it stale.

**`generate`** links the archives on the App target in `ios-xtool/Package.swift`, regenerated on every build and never
persisted: one `-Xlinker -force_load -Xlinker <archive>` per archive (no `-all_load`, which would also pull in every
member of React Native's archives), the specs' `frameworks`, `libraries` and `weak_frameworks`, and, with binary pods
only, `-Xlinker -no_objc_relative_method_lists`, without which xtool's `ld64.lld` crashes on
MLKitTextRecognitionCommon's object. SwiftPM never sees the real archive, so nothing links it twice, and `-force_load`
keeps the archives' `+load` classes, which register ML Kit's components. For a table entry's `emptyTargets`
(GoogleToolboxForMac's `GTMDefines`, a target without sources that Swift Build lists at link anyway), rn-xtool writes
the empty arm64 object clang writes for an empty C file at `ios-xtool/.build/out/Products/Debug-iphoneos/<Target>.o`
before `xtool-build`, and `install` writes it again before xtool builds.

**Resource bundles.** The pods' `resource_bundles`, and the unconditional ones of scaffolded libraries whose names and
globs are plain strings, become `ios-xtool/Resources/<Key>.bundle`, each with an `Info.plist` holding CocoaPods' keys,
listed under `resources:` in `xtool.yml`. xtool copies each to `App.app/<Key>.bundle`, where the code finds it by name
in the main bundle (ML Kit's five OCR models, react-native-svg's filters). The files are copies with their
modification times. Two bundles of one name, or one named like an app resource, stop `generate`.

**After `xtool-build`**, the post-pack checks read `App.app` with `llvm-nm` and file reads: every pod's bundle with its
`Info.plist`; no binary target embedded under `Frameworks/` (xtool embeds a framework binary that is not an `ar`
archive as a dynamic one, xtool issue #130); and every `_OBJC_CLASS_$_` a force-loaded archive defines is in the App
binary, which is how a dropped `+load` class shows. A failure removes `App.app` and stops. `build` records what the
checks read, with the empty targets, in the build state, and `install` (so `run` too) has xtool build the app, runs the
same checks on it, and installs only an app that passes. Before that, `install` stages `ios/build/pod-binaries` and
the pods' bundles again from the lock and the cache when they are gone since the build.

**Data.** `data/pods.json` maps the source pods ML Kit reaches (GTMSessionFetcher, GoogleUtilities, GoogleDataTransport,
GoogleToolboxForMac), with GoogleToolboxForMac's checked `outsideRequirement` and its `emptyTargets`.
`data/pod-terms.json` maps a spec homepage to its vendor's terms page, for the line before the first download.

**ML Kit text recognition**, in the build-only proof on bare React Native 0.88.1 (2026-11-05; the same app then
recognized printed text on a physical iPhone):
ten binary pods and four source pods; 40.3 MB downloaded from dl.google.com; the `pods` step took 7.5 s on the first
build and 0.1 s offline later; nine `-force_load`s; the cache took 237 MB and the app's copies 66 MB; `App.app` grew by
53 MB (the App binary by 40.3 MB); `ios-xtool/.build` took about 0.84 GB.

## Leaving a module out

With `exclude` in `rn-xtool.config.json`, rn-xtool wraps the autolinking config command every SwiftPM step runs (on
bare, the one React Native would run; on Expo, `npx expo-modules-autolinking react-native-config --json --platform
ios`) with `scripts/exclude-config-command.js`. It runs the command and prints its JSON with each listed package's
`platforms.ios` set to `null`, which is what `platforms: { ios: null }` in `react-native.config.js` produces.
Autolinking, the scaffolder and codegen (which reads the `autolinking.json` written from that output) then leave the
package out, and the early checks skip it. Your `react-native.config.js` is not touched. Expo modules are linked by
Expo's own autolinking, which the command does not feed: they go in `expo.autolinking.exclude`
([troubleshooting.md](troubleshooting.md#leaving-a-module-out)).

## Entitlements

Before the `patches` step (on Expo, once `expo prebuild` wrote the Xcode project), `build` reads the file
`CODE_SIGN_ENTITLEMENTS` names in the app target's Debug configuration, resolving `$(PRODUCT_BUNDLE_IDENTIFIER)`,
`$(CFBundleIdentifier)` and the project's other settings and keeping `$(AppIdentifierPrefix)` and
`$(TeamIdentifierPrefix)`. It looks each key up in a table read from the source of the xtool release rn-xtool pins
(1.24.0): which types xtool decodes, which it marks paid, and Apple's free column. It prints a `⚠` line for each key xtool drops or does not enable, and it stops when the
file is missing or is not a property list dictionary. When the file has keys, the `generate` step writes them to
`ios-xtool/App.entitlements` and adds `entitlementsPath: App.entitlements` to `xtool.yml`; `xtool dev build` then signs
the app with them ad hoc. A file without keys (every Expo prebuild writes one) is not passed, so `xtool.yml` stays as
without the setting. At install, xtool registers the App ID on your team, keeps the entitlements it knows (on a free
team, those of free capabilities), and rewrites the identifiers: `application-identifier` and the only keychain group
become `<Team ID>.XTL-<Team ID>.<bundle id>` ([troubleshooting.md](troubleshooting.md#entitlements)).

The `XTL-<Team ID>` segment, here and in the installed bundle id, is what xtool builds from the signed-in account's
identity, not from the team itself; on every device run so far it matched the Team ID.

## Reference timings

On a warm cache: patches 3.6 s, RN SwiftPM 11.1 s, ExpoModulesJSI 12.7 s, xtool build 24.5 s. The resulting `App.app`
is about 99 MB with 8 embedded frameworks.

A bare React Native 0.85.0 app with 20 native libraries, its scaffolds made again (2026-11-06): `rn-spm` 578 s,
`frameworks` 35 s, `xtool-build` 273 s.

The `precheck` step (2026-11-10), with the module cache cold (`build --clean`) and then warm (the next `build`): a bare
React Native 0.88.1 app 11.1 s and 2.9 s, the Expo SDK 58 app 7.7 s and 3.3 s (its Swift files are left to
`xtool-build`).

## Further reading

- [recipe.md](recipe.md): the full technical recipe, with file locations.
- [design/specs/2026-10-23-expo-xtool-design.md](design/specs/2026-10-23-expo-xtool-design.md): the original design
  (in Spanish); the other design records are listed in the [docs index](README.md#design-records).
