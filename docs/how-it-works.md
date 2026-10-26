# How it works

rn-xtool does not reimplement Xcode. It patches the official React Native 0.88 and Expo SDK 58 SwiftPM pipeline so it
runs on Linux, generates a SwiftPM package for your app in `ios-xtool/`, and hands it to
[xtool](https://github.com/xtool-org/xtool), which builds, signs and installs it with the Darwin SDK extracted from your
own `Xcode.xip`. This page is the overview; [recipe.md](recipe.md) has every step with file locations.

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

1. Applies four patches to `node_modules` with patch-package. Two are one-liners (the `@ExpoModule` scanner gate in
   expo-modules-autolinking, a Swift 6.4 access-level error in expo-modules-jsi). The other two are large:
   - **Expo** (`patches/expo+58.0.19.patch`, files under `expo/scripts/spm/`): finds the Swift macro plugin on Linux;
     gives pure-Swift modules the Foundation/UIKit imports CocoaPods' umbrella header provides
     ([upstream/expo-spm-plugin-umbrella.md](upstream/expo-spm-plugin-umbrella.md)); builds Expo modules that mix Swift
     and Objective-C or are Objective-C only, such as expo-application and the dev client chain; skips meta pods (no
     sources) and placeholder files; links generated packages to their podspec `dependency` pods; excludes resources
     only Xcode's tools compile (asset catalogs, storyboards); refuses modules built from vendored C sources such as
     expo-sqlite ([upstream/expo-spm-plugin-mixed-modules.md](upstream/expo-spm-plugin-mixed-modules.md)).
   - **React Native** (`patches/react-native+0.88.0.patch`, about 1.75k lines across 3 files under
     `react-native/scripts/spm/`: `read-podspec.js`, `scaffold-package-swift.js`, `spm-utils.js`): 12 generic fixes to
     the `spm scaffold` podspec reader and `Package.swift` generator, including mixed Swift + Objective-C/C++ targets
     and known CocoaPods dependencies mapped to SwiftPM packages, plus one to the per-app header farm
     ([upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md)).
2. Runs React Native 0.88's SwiftPM pipeline and Expo's SPM plugin, with Linux shims for `plutil` and `otool`.
3. Builds ExpoModulesJSI with the Darwin SDK and stages the runtime frameworks.
4. Generates `ios-xtool/` (Package.swift, xtool.yml, Info.plist, ip.txt, app config). It is a regenerable artifact; do
   not edit it by hand.
5. Gives CocoaPods-only libraries a `Package.swift` (see [below](#cocoapods-only-libraries)).
6. `xtool` builds, signs and installs the app; Metro serves JS to the phone over Wi‑Fi.

Bare React Native projects follow the same steps with a few differences (no `expo prebuild`, no injection into your
Xcode project, ExpoModulesJSI only with Expo modules): see [bare-react-native.md](bare-react-native.md).

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

Which libraries are verified: [libraries.md](libraries.md).

## Reference timings

On a warm cache: patches 3.6 s, RN SwiftPM 11.1 s, ExpoModulesJSI 12.7 s, xtool build 24.5 s. The resulting `App.app`
is about 99 MB with 8 embedded frameworks.

## Further reading

- [recipe.md](recipe.md): the full technical recipe, with file locations.
- [design/specs/2026-10-23-expo-xtool-design.md](design/specs/2026-10-23-expo-xtool-design.md): the original design
  (in Spanish); the other design records are listed in the [docs index](README.md#design-records).
