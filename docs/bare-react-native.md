# Bare React Native projects

A project made with `npx @react-native-community/cli init` (React Native 0.88.0 or newer, needed for its SwiftPM
artifacts) builds with the same commands as an Expo app (`doctor`, `build`, `install`, `start`, `run`). Nothing in
`ios/` is modified: rn-xtool reads the Xcode project and generates its own `ios-xtool/` from it. CocoaPods is not
needed: the `Podfile` and any `pod install` result are ignored. This page covers how the project is detected, what is
read from it, and what is not carried over.

[Back to README](../README.md)

## Detection

A project is `expo` when `package.json` depends on `expo` and an Expo config exists (`app.config.*`, or an `app.json`
with an `expo` key). Otherwise it is `bare` when `ios/` holds exactly one `.xcodeproj`. A bare project that also has
Expo modules (`expo` and `expo-modules-core` installed and `use_expo_modules!` in the `Podfile`) is a hybrid and also
gets ExpoModulesJSI. Set `"projectKind": "expo"` or `"bare"` in `rn-xtool.config.json` to skip detection.

`doctor` prints the result in its `project` check, for example
`bare + expo modules, React Native 0.88.0, target BareDemo (BareDemo.xcodeproj)`; its `project-config` check reports a
missing bundle identifier.

## Build steps

`patches`, `rn-spm`, `jsi` (only with Expo modules), `app-config` (only when `expo-constants` is installed),
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
[libraries.md](libraries.md), whose `Bare` column records what was checked on a bare app. `react-native-reanimated`
needs `plugins: ['react-native-worklets/plugin']` in your `babel.config.js` (`babel-preset-expo` adds it for Expo apps)
and the two patches described there.

## Limits

- One application target and one `.xcodeproj` per project.
- `.xcconfig` files, entitlements, capabilities and script phases are not read; no asset catalogs or storyboards.
- React Native older than 0.88 is not supported.

Implementation notes: the "Bare React Native notes" section of [recipe.md](recipe.md#bare-react-native-notes) and the
design record [design/specs/2026-10-26-bare-react-native-design.md](design/specs/2026-10-26-bare-react-native-design.md).
