# Bare React Native projects

A project made with `npx @react-native-community/cli init` (React Native 0.86.2, 0.86.3, 0.87.1 or 0.88.0, see
[Supported React Native versions](#supported-react-native-versions)) builds with the same commands as an Expo app
(`doctor`, `build`, `install`, `start`, `run`). Nothing in
`ios/` is modified: rn-xtool reads the Xcode project and generates its own `ios-xtool/` from it. CocoaPods is not
needed: the `Podfile` and any `pod install` result are ignored. This page covers how the project is detected, what is
read from it, and what is not carried over.

[Back to README](../README.md)

## Supported React Native versions

Exactly these versions, and nothing in between:

| React Native | SwiftPM scripts | Status |
| --- | --- | --- |
| 0.88.0 | the installed copy (`node_modules/react-native/scripts`) | verified on a device |
| 0.87.1 | [vendored](#vendored-swiftpm-scripts-086-087) | verified on a device |
| 0.86.3 | [vendored](#vendored-swiftpm-scripts-086-087), [older artifacts](#older-artifacts-086) | verified on a device |
| 0.86.2 | [vendored](#vendored-swiftpm-scripts-086-087), [older artifacts](#older-artifacts-086) | build-verified only (not run on a device) |

As of 2026-10-27, on a physical iPhone, 0.86.3 and 0.87.1 pass `doctor`, `build`, install over Wi‑Fi, Metro and Fast
Refresh, and the library matrix in [libraries.md](libraries.md) (reanimated/worklets only on 0.86.3). 0.86.2 is
build-verified only: a throwaway template app downloaded and adapted its artifacts and produced `App.app`.

On 0.86.3 the first build downloads about 1.3 GB of artifacts (about 3 minutes in our test; it depends on the
connection) and adapts them (about 2 s); later builds reuse the adapted slots (`rn-artifacts` 0.0 s). The library
matrix build took about 4 minutes with four auto-scaffolds.

Any other version (0.85 and older, 0.86.0, 0.86.1, 0.87.0, 0.88 prereleases, 0.88.x other than 0.88.0) stops `build`
and `doctor` with one error naming this list and asking you to pin `react-native` to one of them. Hybrids (bare +
Expo modules) work on 0.88.0 only: Expo SDK 58 needs React Native 0.88.0, so 0.86 and 0.87 with Expo modules stop
with an error saying so. The `react-native` patch of rn-xtool is for 0.88.0 exactly and is not applied to other
versions (the vendored scripts already contain its fixes).

Templates differ between versions. A 0.86 template (`@react-native-community/cli init --version 0.86.3`) has only
`AppDelegate.swift` (no `SceneDelegate.swift`), imports `React_RCTAppDelegate` next to `React` and
`ReactAppDependencyProvider`, and sets `IPHONEOS_DEPLOYMENT_TARGET = 15.1`. The 0.88 template has an `AppDelegate` and
a `SceneDelegate` and imports only `React`. rn-xtool reads either as it is; the generated package still targets
iOS 16.4 (see [Limits](#limits)).

## Vendored SwiftPM scripts (0.86, 0.87)

React Native 0.88 introduced the SwiftPM scripts (`scripts/setup-apple-spm.js`, `scripts/spm/`) that rn-xtool drives;
0.86 and 0.87 do not ship them. For these versions rn-xtool uses the 0.88.0 scripts bundled in the package
(`vendor/rn-spm/`, with the scaffolder fixes already applied) while still running the installed React Native's own
codegen and reading its version's artifacts. How and why: [How it works](how-it-works.md#vendored-swiftpm-scripts).

## Older artifacts (0.86)

The prebuilt artifacts of 0.86.x predate the layout the 0.88 scripts expect: there are no
`ReactNativeHeaders.xcframework` and `ReactNativeDependenciesHeaders.xcframework`. The `rn-artifacts` build step
downloads the 0.86 artifacts and adapts them using only the downloaded files:

- Raw downloads stay where React Native's downloader puts them: `~/Library/Caches/ReactNative/spm-artifacts/<version>/{debug,release}`
  (on Linux too). Both flavors are downloaded: about 1.3 GB in total for a 0.86 slot (debug about 1 GB, release about
  0.3 GB).
- The adapted copies go to `ios/build/rn-artifacts/<version>/{debug,release}` and are mostly hard links into the raw
  slot. When the project is on the same filesystem as `~/Library/Caches` the hard links add little disk; a project on
  another filesystem (a second partition, a mounted drive) gets full copies instead (about 1.1 GB for 0.86.3). They are
  rebuilt when the adapter changes, the raw slot's `artifacts.json` changes or the project moves; an incomplete raw slot
  is downloaded again.
- 0.87.1 slots already have the new layout: they are used straight from the cache, nothing is
  adapted.
- A slot layout the adapter does not recognise stops the build with an error rather than being worked around.
- With `rnArtifactsDir` in `rn-xtool.config.json` the step does not run: the directory (holding `debug/` and
  `release/` slots) is handed to the scripts as it is, so for 0.86 it must already hold slots in the adapted layout.
  To get them, build once without `rnArtifactsDir` and point it at that project's `ios/build/rn-artifacts/<version>`;
  use it where it is, since its `artifacts.json` holds absolute paths, and note that `build --clean` removes it. For
  0.87.1 a headers-spec version directory from React Native's cache works as it is, for example
  `~/Library/Caches/ReactNative/spm-artifacts/0.87.1`.

## Detection

A project is `expo` when `package.json` depends on `expo` and an Expo config exists (`app.config.*`, or an `app.json`
with an `expo` key). Otherwise it is `bare` when `ios/` holds exactly one `.xcodeproj`. A bare project that also has
Expo modules (`expo` and `expo-modules-core` installed and `use_expo_modules!` in the `Podfile`) is a hybrid and also
gets ExpoModulesJSI. Set `"projectKind": "expo"` or `"bare"` in `rn-xtool.config.json` to skip detection.

`doctor` prints the result in its `project` check, for example
`bare + expo modules, React Native 0.88.0, target BareDemo (BareDemo.xcodeproj)`; its `project-config` check reports a
missing bundle identifier.

## Build steps

`patches`, `rn-artifacts` (0.86 and 0.87, unless `rnArtifactsDir` is set), `rn-spm`, `jsi` (only with Expo modules),
`app-config` (only when `expo-constants` is installed),
`frameworks`, `generate` and `xtool-build`. `expo prebuild` never runs, and the `rn-spm` step runs React Native's
SwiftPM generation steps without injecting anything into your Xcode project (it writes `ios/build/` only). Your
`Podfile` and any `pod install` result are ignored.

`build --clean` removes `ios/build` and `ios-xtool` and leaves the rest of `ios/` alone.

## What is read from `project.pbxproj`

The single application target (several application targets or several `.xcodeproj` are an error naming them). From its
Debug configuration, then the project's:

- `PRODUCT_BUNDLE_IDENTIFIER` (required; bare projects are never written to, so add it in Xcode or the pbxproj if it is
  missing), `PRODUCT_NAME`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` and `INFOPLIST_FILE` (the `Info.plist`
  copied to `ios-xtool/`).
- `SWIFT_OBJC_BRIDGING_HEADER`, `GCC_PREPROCESSOR_DEFINITIONS` (valued defines such as `FOO=1` work),
  `HEADER_SEARCH_PATHS` and `CLANG_CXX_LANGUAGE_STANDARD`.
- Only `$(inherited)`, `$(TARGET_NAME)`, `$(PROJECT_NAME)`, the `:rfc1034identifier` and `:c99extidentifier` modifiers
  and settings defined in the pbxproj itself (for example `$(PRODUCT_NAME)`) are resolved. Any other `$(VAR)`,
  `$(SRCROOT)` and `$(PROJECT_DIR)` included, stops the build with `Cannot resolve build setting` naming it. Write
  paths in `HEADER_SEARCH_PATHS` and the bridging header relative to `ios/` (not `$(SRCROOT)/...`). `.xcconfig` files
  are ignored.

Not carried over: `IPHONEOS_DEPLOYMENT_TARGET` (the generated package always targets iOS 16.4, in Swift 5 language
mode), entitlements, capabilities and script phases. When `OTHER_CFLAGS`, `OTHER_LDFLAGS` or `OTHER_SWIFT_FLAGS` hold
flags beyond `-ObjC` and `-lc++`, `build` logs them by name as not carried over.

## Sources

The target's Sources phase is copied to `ios-xtool/Sources/App` keeping its layout: `.swift`, `.m`, `.mm`, `.c`,
`.cpp`/`.cc`/`.cxx` and headers (every header in the app folder too), with `.lproj` variant groups. Any other source
type (`.xcdatamodeld`, `.intentdefinition`, `.s`, ...) stops the build with `unsupported source type in the app target`.
Sources outside `ios/` and two compiled files with the same name are errors.

## Mixed Swift + Objective-C/C++ app target

If the target compiles any `.m`, `.mm`, `.c` or `.cpp` file, it is built as one mixed-language target, the same
mechanism as the scaffolded mixed libraries (the two manifests described in
[How it works](how-it-works.md#mixed-language-manifests)). The bridging header is passed with `-import-objc-header`
and your header search paths and defines are applied. Verified on a device with an Objective-C module next to a Swift
module.

Swift Build names the generated Swift header `App-Swift.h` (the SwiftPM target is `App`), so `build` also writes
`Sources/App/include/<Module>-Swift.h`, which imports it: Objective-C keeps `#import "<Module>-Swift.h"` as in Xcode,
where `<Module>` is `PRODUCT_MODULE_NAME`, or `PRODUCT_NAME` with characters other than letters, digits and `_` turned
into `_`.

## Resources

The Resources phase is copied to `ios-xtool/Resources` (by file name; `*.lproj/` and `*.bundle/` stay whole) and listed
in `xtool.yml`, so they land at the app bundle root. Storyboards, asset catalogs and `.xib` files need Xcode's tools, so
they are skipped with an `ℹ` line: no launch screen from a storyboard and no app icon from `Images.xcassets`.

## Metro

`start` runs `npx react-native start --port <metroPort>` (`--clear` becomes `--reset-cache`). For bare, `ip.txt` holds
`<lanIp>:<metroPort>`: React Native reads only the host from `ip.txt` and takes the port from a compile-time constant
(8081 in the prebuilt framework), so a custom `metroPort` travels in the `ip.txt` value. The first open of a fresh dev
build shows the LogBox banner "Open debugger to view warnings" (warnings of the RN template; harmless).

## Hybrid (bare + Expo modules)

`npx install-expo-modules@latest` raises the deployment target, switches the Babel preset to `babel-preset-expo` and
the Metro config to `expo/metro-config`, but on an RN 0.88 template it leaves `AppDelegate.swift` not compiling and does
not touch `SceneDelegate.swift`. Rewrite them by hand as in the Expo 58 template: `AppDelegate` on `ExpoAppDelegate`
with `ExpoReactNativeFactory`, `SceneDelegate` on `ExpoAppSceneDelegate`. Pin `expo` to 58.0.19,
`expo-modules-autolinking` to 58.0.15 and `expo-modules-jsi` to 58.0.19, the versions the bundled patches target.
`expo-constants` gets its `EXConstants.bundle/app.config` as in Expo apps.

## Libraries

Libraries with a podspec work as in Expo apps (auto-scaffolded, patches persisted in `patches/`); see
[libraries.md](libraries.md), whose `Bare` columns record what was checked on a bare app. `react-native-reanimated`
needs `plugins: ['react-native-worklets/plugin']` in your `babel.config.js` (`babel-preset-expo` adds it for Expo apps)
and the two patches described there.

## Limits

- One application target and one `.xcodeproj` per project.
- `.xcconfig` files, entitlements, capabilities and script phases are not read; no asset catalogs or storyboards.
- Only the React Native versions in [the table above](#supported-react-native-versions) are supported.

Implementation notes: the "Bare React Native notes" section of [recipe.md](recipe.md#bare-react-native-notes) and the
design record [design/specs/2026-10-26-bare-react-native-design.md](design/specs/2026-10-26-bare-react-native-design.md).
