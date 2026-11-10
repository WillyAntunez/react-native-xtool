# Bare React Native projects

A project made with `npx @react-native-community/cli init` (React Native 0.85.x from 0.85.0, 0.86.x from 0.86.2,
0.87.x from 0.87.1 or 0.88.x from 0.88.0, see [Supported React Native versions](#supported-react-native-versions))
builds with the same commands as an Expo app (`doctor`, `build`, `install`, `start`, `run`). Nothing in `ios/` is
modified: rn-xtool reads the Xcode project and generates its own `ios-xtool/` from it. CocoaPods is not needed: the
`Podfile` and any `pod install` result are ignored. This page covers how the project is detected, what is read from
it, and what is not carried over.

[Back to README](../README.md)

## Supported React Native versions

One floor per minor: each line accepts its floor and every newer patch release of the same minor.

| Line | Accepts | Verified | SwiftPM scripts |
| --- | --- | --- | --- |
| 0.88 | 0.88.0 or newer 0.88.x | 0.88.0 and 0.88.1, on a device | the installed copy (`node_modules/react-native/scripts`) |
| 0.87 | 0.87.1 or newer 0.87.x | 0.87.1, on a device | [vendored](#vendored-swiftpm-scripts-085-086-087) |
| 0.86 | 0.86.2 or newer 0.86.x | 0.86.3 on a device; 0.86.2 build-verified only (not run on a device) | [vendored](#vendored-swiftpm-scripts-085-086-087), [older artifacts](#older-artifacts-085-086) |
| 0.85 | 0.85.0 or newer 0.85.x | 0.85.0 on a device; 0.85.3 build-verified only (not run on a device) | [vendored](#vendored-swiftpm-scripts-085-086-087), [older artifacts](#older-artifacts-085-086) |

As of 2026-10-27, on a physical iPhone, 0.86.3 and 0.87.1 pass `doctor`, `build`, install over Wi‑Fi, Metro and Fast
Refresh, and the library matrix in [libraries.md](libraries.md) (reanimated/worklets only on 0.86.3). 0.86.2 is
build-verified only: a throwaway template app downloaded and adapted its artifacts and produced `App.app`. On
2026-10-28 the 0.88.0 library-matrix app, moved to 0.88.1 as in [Upgrading React Native](#upgrading-react-native),
launched on a physical iPhone with its libraries (react-native-screens included). On 2026-11-04, 0.85.0 and 0.85.3
were built: fresh template apps went through `doctor --project` and `build`, which downloaded and adapted their
artifacts, passed the precompiled framework check (G4) and produced `App.app`; the 0.85.0 app also built with
`@react-native-community/cli` 20.0.0 and with react-native-reanimated 4.3.4 and react-native-worklets 0.8.3 (see
[React Native 0.85](#react-native-085)). The same day, on a physical iPhone (iOS 26), that 0.85.0 app
(`@react-native-community/cli` 20.0.0, reanimated 4.3.4 and worklets 0.8.3) passed `build`, install over Wi‑Fi, the
first launch (tap Allow, and the app reloaded by itself), Hermes, reanimated animating and Fast Refresh. 0.85.3 has
not been run on a device. On 2026-11-06 a production 0.85.0 app with an Objective-C app target and 20 native libraries
built, installed over USB and launched on a physical iPhone (see [React Native 0.85](#react-native-085)).

On 0.86.3 the first build downloads about 1.3 GB of artifacts (about 3 minutes in our test; it depends on the
connection) and adapts them (about 2 s); later builds reuse the adapted slots (`rn-artifacts` 0.0 s). The library
matrix build took about 4 minutes with four auto-scaffolds.

A verified version builds silently. A newer patch of a line, for example 0.88.2, 0.86.4 or 0.85.4, builds with a
warning that names the verified versions and the one to move back to if the build or the app fails ("⚠ Newer than
the React Native <minor> line this rn-xtool release was verified with: ...", see
[troubleshooting.md](troubleshooting.md#newer-than-the-verified-versions)). 0.85.1 and 0.85.2, which sit between the
verified 0.85.0 and 0.85.3, build with the same warning worded "⚠ Not among the React Native 0.85 versions this
rn-xtool release was verified with: ...", which says to move to 0.85.3. Anything else stops `build` and `doctor`
with one error: a version below its line's floor (0.86.0, 0.86.1, 0.87.0), a prerelease of any line (0.88.2-rc.1),
or a minor without a line (0.84 and older, 0.89). It reads "React Native <version> is not supported; rn-xtool
supports 0.85.x from 0.85.0, 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0 (bare). Pin react-native
to one of them.", followed by
"Expo SDK 58 needs React Native 0.88.1." when expo-modules-core is installed. `rn-xtool doctor --project`
shows the line a project is on, and the reason when no line covers it
([troubleshooting.md](troubleshooting.md#doctor---project)).

Hybrids (bare + Expo modules) work on 0.88.1 only: Expo SDK 58 needs React Native 0.88.1, so 0.85, 0.86, 0.87 and any
other 0.88.x with Expo modules stop with an error saying so (see [Hybrid](#hybrid-bare--expo-modules)). rn-xtool
bundles its `react-native` patch twice, as `react-native+0.88.0.patch` and `react-native+0.88.1.patch` (the same
content). It applies the one for the installed version, else the highest one of the installed version's line, so
0.88.2 gets the 0.88.1 patch. If that patch does not apply to a newer 0.88.x, the build stops at `patches` with
`pin "react-native" to 0.88.1`. 0.85, 0.86 and 0.87 get no react-native patch: the vendored scripts already contain
its fixes.

Templates differ between versions. A 0.86 template (`@react-native-community/cli init --version 0.86.3`) has only
`AppDelegate.swift` (no `SceneDelegate.swift`), imports `React_RCTAppDelegate` next to `React` and
`ReactAppDependencyProvider`, and sets `IPHONEOS_DEPLOYMENT_TARGET = 15.1`. The 0.85 template's `ios/` is the same as
0.86's, byte for byte. The 0.88 template has an `AppDelegate` and
a `SceneDelegate` and imports only `React`. rn-xtool reads either as it is; the generated package still targets
iOS 16.4 (see [Limits](#limits)).

## Upgrading React Native

The template pins `react-native` and every `@react-native/*` package to one exact version, and
`@react-native/new-app-screen` declares `react-native` as an exact peer. On the 0.88.0 template app, a single
`npm install react-native@0.88.1`, or editing the pins and running `npm install`, stopped with
`ERESOLVE could not resolve … Conflicting peer dependency: react-native@0.88.1 (peer from
@react-native/new-app-screen@0.88.1)`. It does not always stop: in a hybrid app, `npx expo install react-native@0.88.1`
only printed `npm warn ERESOLVE overriding peer dependency`, installed react-native 0.88.1 and left every
`@react-native/*` package on 0.88.0, so `npm ls --all` exited 1. Either way, use this sequence, which moved both apps
to 0.88.1:

1. In `package.json`, set `react-native` and every `@react-native/*` package to the new version, exactly (no `^`).
   For 0.88.1 these are `react-native` and `@react-native/new-app-screen` in `dependencies`, and
   `@react-native/babel-preset`, `eslint-config`, `jest-preset`, `metro-config` and `typescript-config` in
   `devDependencies`, as in `@react-native-community/template@0.88.1`. Its `@react-native-community/cli` pins (20.2.0)
   are the same as 0.88.0's.
2. `npm uninstall @react-native/new-app-screen`. This also installs the new `react-native` and the new devDependencies.
   npm prints an `npm warn ERESOLVE overriding peer dependency … Conflicting peer dependency: react-native@0.88.0`
   block here and exits 0; that is expected and harmless.
3. `npm install --save-exact @react-native/new-app-screen@0.88.1`.
4. `npm ls --all` should exit 0. Then run `rn-xtool doctor`.

After the move, the next `build` prints a warning for each scaffold patch in `patches/` that was made for the old
version; do what it says ([troubleshooting.md](troubleshooting.md#build-and-patches)). For a hybrid app, remove the
expo-modules-* pins and move `expo` first, and React Native last, because `npx expo install --fix` can set
`react-native` back to 0.88.0. The full order, with the commands, is
[Moving to the 58.0.21 set](troubleshooting.md#moving-to-the-58021-set).

## Vendored SwiftPM scripts (0.85, 0.86, 0.87)

React Native 0.88 introduced the SwiftPM scripts (`scripts/setup-apple-spm.js`, `scripts/spm/`) that rn-xtool drives.
0.85 and 0.86 ship none, and 0.87's lack two exports and one option that rn-xtool needs. For these versions rn-xtool
uses the 0.88.0 scripts bundled in the package (`vendor/rn-spm/`, with the scaffolder fixes already applied) while
still running the installed React Native's own codegen and reading its version's artifacts.

rn-xtool decides this from the installed scripts' layout, not from the version number: it reads the files under
`node_modules/react-native/scripts` as text and checks for the exports and options it calls. No scripts, or 0.87's,
give the vendored copy on a line rn-xtool bundles no react-native patch for (0.85, 0.86, 0.87). Scripts with everything
rn-xtool needs (0.88's) are used as installed on a line it bundles that patch for (0.88). Anything else is reported by
`doctor --project` as "not recognised", and the build then takes the scripts mode of the version's line (vendored for
0.85, 0.86 and 0.87, installed for 0.88). Today every supported version gets the same mode
as before. The choice also decides whether the `rn-artifacts` step runs (see [Build steps](#build-steps)). How and
why: [How it works](how-it-works.md#vendored-swiftpm-scripts).

## Older artifacts (0.85, 0.86)

The prebuilt artifacts of 0.85.x and 0.86.x predate the layout the 0.88 scripts expect: there are no
`ReactNativeHeaders.xcframework` and `ReactNativeDependenciesHeaders.xcframework`. The `rn-artifacts` build step
downloads the 0.85 or 0.86 artifacts and adapts them using only the downloaded files (the adapter checks the slot's
layout, not its version, and adapts a 0.85 slot as it adapts a 0.86 one):

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
- With `rnArtifactsDir` in `rn-xtool.config.json` the step does not run: the directory (holding `debug/` and `release/`
  slots) is handed to the scripts as it is, so for 0.85 and 0.86 it must already hold slots in the adapted layout. To
  get them, build once without `rnArtifactsDir` and point it at that project's `ios/build/rn-artifacts/<version>`; use
  it where it is, since its `artifacts.json` holds absolute paths, and note that `build --clean` removes it. For 0.87.1
  a headers-spec version directory from React Native's cache works as it is, for example
  `~/Library/Caches/ReactNative/spm-artifacts/0.87.1`.

## React Native 0.85

0.85 takes the same route as 0.86. It ships no SwiftPM scripts, so it gets rn-xtool's
[vendored copy](#vendored-swiftpm-scripts-085-086-087), and its artifacts predate the headers spec, so they are
[adapted](#older-artifacts-085-086). Nothing in rn-xtool is specific to 0.85 beyond its line in the version table: the
scripts mode comes from the installed scripts' layout, and the adapter checks the slot's layout. 0.85.0 is verified on
a device (2026-11-04, see [Supported React Native versions](#supported-react-native-versions)); 0.85.3 is
build-verified only.

- **Hermes** is 250829098.0.10 for every 0.85.x. It comes from the project's own `hermes-compiler` package, which
  `react-native` depends on: the downloader fetches `hermes-ios` of that version (debug and release). rn-xtool pins no
  Hermes version; `HERMES_VERSION` in the environment overrides it.
- **Download and disk:** one 0.85 version downloads about 200 MB (196 MB measured for 0.85.0: React core, its
  dependencies and Hermes, debug and release) and takes about 1.2 GB in
  `~/Library/Caches/ReactNative/spm-artifacts/<version>` (debug about 0.9 GB, release about 0.3 GB). The adapted copy
  in `ios/build/rn-artifacts` is hard links, about 13 MB more, when the project is on the same filesystem. A 0.85.3
  project reuses the Hermes download of 0.85.0. Offline, use `rnArtifactsDir` as in
  [Older artifacts](#older-artifacts-085-086).
- **The CLI:** the 0.85 template pins `@react-native-community/cli` 20.1.0. A project on 20.0.0 builds the same: its
  autolinking output was byte-identical to 20.1.0's on the 0.85.0 template. The build checks only that the CLI is
  installed, not its version.
- **reanimated:** react-native-reanimated 4.3.4 with react-native-worklets 0.8.3 (the newest 4.3.x and 0.8.x) builds
  and runs on 0.85.0 (animating on a physical iPhone, 2026-11-04), with `plugins: ['react-native-worklets/plugin']`
  in `babel.config.js`. Both are scaffolded (they ship no `Package.swift`), and the scaffolded worklets target gets
  the `HERMES_V1_ENABLED` define that CocoaPods would give it ([scaffolder fix 19](upstream/react-native-scaffolder.md)).
  reanimated 4.5.1 with worklets 0.10.1 builds on 0.85.0 too (build only, not run on a device). See
  [libraries.md](libraries.md) for the per-version cells.
- **Newer patches:** a 0.85.x newer than 0.85.3 builds with the "Newer than" warning, and 0.85.1 and 0.85.2 with the
  "Not among" warning; both name 0.85.3 as the version to move to, which is build-verified only.
- **Expo modules:** 0.85 with expo-modules-core is refused ("React Native 0.85.0 with Expo modules is not supported.
  Expo SDK 58 needs React Native 0.88.1."), like 0.86 and 0.87.
- **A production app:** on 2026-11-06 a bare React Native 0.85.0 app with an Objective-C app target (`main.m`,
  `AppDelegate.h` and `AppDelegate.mm` next to the `.xcodeproj`, a bridging header and a Swift file) and 20 native
  libraries, from react-native-screens 4.24.0, react-native-reanimated 4.3.0 with react-native-worklets 0.8.1 and
  react-native-vision-camera 4.7 to @react-native-ml-kit/text-recognition and react-native-app-auth (the full list is in
  [libraries.md](libraries.md)), was built (`rn-spm` about 10 minutes, `xtool-build` about 4.5 minutes), installed
  over USB and launched on a physical iPhone (iOS 26): the JS bundle loaded from Metro and the app's own UI appeared.
  Its feature checks (the camera, text recognition, the AppAuth login, Fast Refresh) are not done yet.
- **What is proved:** the template app and the reanimated/worklets pair, on a device with 4.3.4 + 0.8.3 on 0.85.0,
  and the production app above, up to its launch. Other libraries are untested on 0.85 (⏳ in
  [libraries.md](libraries.md)).

## Detection

A project is `expo` when `package.json` depends on `expo` and an Expo config exists (`app.config.*`, or an `app.json`
with an `expo` key). Otherwise it is `bare` when `ios/` holds exactly one `.xcodeproj`. A bare project that also has
Expo modules (`expo` and `expo-modules-core` installed and `use_expo_modules!` in the `Podfile`) is a hybrid and also
gets ExpoModulesJSI. Set `"projectKind": "expo"` or `"bare"` in `rn-xtool.config.json` to skip detection.

`doctor` prints the result in its `project` check, for example
`bare + expo modules, React Native 0.88.1, target BareDemo (BareDemo.xcodeproj)`; its `project-config` check reports a
missing bundle identifier.

## Build steps

`patches`, `rn-artifacts` (with the vendored SwiftPM scripts, so 0.85, 0.86 and 0.87, unless `rnArtifactsDir` is set),
`rn-spm`, `jsi` (only with Expo modules), `app-config` (only when `expo-constants` is installed), `frameworks`,
`generate`, `precheck` and `xtool-build`. `expo prebuild` never runs, and the `rn-spm` step runs React Native's
SwiftPM generation steps without injecting anything into your Xcode project (it writes `ios/build/` only). Your
`Podfile` and any `pod install` result are ignored.

`build --clean` removes `ios/build` and `ios-xtool` and leaves the rest of `ios/` alone.

Before the first step, `build` resolves the `#import` and `#include` lines of the app target's C-family sources, headers
and bridging header as the generated App target compiles them, with file reads only (pass 1): a quote include of one of
the app's own headers that resolves nowhere stops the build seconds after it starts, naming the file, the folders
searched and, when `ios/` holds one, a file of that name that differs only in case or that the target does not list. In
a project with CocoaPods binaries it never stops: every miss is left to the `precheck` step. With `--skip-precheck` it
prints its misses as `⚠` lines and the build goes on, and `doctor --project` runs the same check as its `app-includes`
line. Includes into React Native's or the libraries' headers are left to the `precheck` step: SwiftPM plans the
generated package, the includes are resolved again with the App target's full include list, `swiftc -typecheck` checks
the Swift files and `clang -fsyntax-only` each C-family file with the generated manifest's flags, so an error in the
app's own sources stops the build before `xtool-build`. When a Swift file imports a module SwiftPM builds from Swift (a
Swift library, or one with Swift files next to its Objective-C), the Swift files are left to `xtool-build`, and so is a
C-family file that `@import`s such a module or one no module map declares. `build --skip-precheck` leaves that step out.
Each line and what to do:
[troubleshooting.md](troubleshooting.md#precheck).

## What is read from `project.pbxproj`

The single application target (several application targets or several `.xcodeproj` are an error naming them). A target
that takes its files from an Xcode 16 synchronized folder is refused, by `build` and `doctor --project`, with `The app
target <name> takes its files from the synchronized folder <folder> (an Xcode 16 folder group); rn-xtool reads only
the files a target lists. Convert the folder to a group (Xcode: Convert to Group) so the target lists its files`. From
its Debug configuration, then the project's:

- `PRODUCT_BUNDLE_IDENTIFIER` (required; bare projects are never written to, so add it in Xcode or the pbxproj if it is
  missing), `PRODUCT_NAME`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` and `INFOPLIST_FILE` (the `Info.plist`
  copied to `ios-xtool/`).
- `SWIFT_OBJC_BRIDGING_HEADER`, `GCC_PREPROCESSOR_DEFINITIONS` (valued defines such as `FOO=1` work),
  `HEADER_SEARCH_PATHS` and `CLANG_CXX_LANGUAGE_STANDARD`.
- Only `$(inherited)`, Xcode's `$(TARGET_NAME)`, `$(PROJECT_NAME)`, `$(SRCROOT)` and `$(PROJECT_DIR)` (both `ios/`)
  and `$(CONFIGURATION)` (`Debug`), the `:rfc1034identifier` and `:c99extidentifier` modifiers and settings defined in
  the pbxproj itself (for example `$(PRODUCT_NAME)`) are resolved. Any other `$(VAR)` stops the build with `Cannot
  resolve build setting` naming it. Relative paths in `HEADER_SEARCH_PATHS` and the bridging header are relative to
  `ios/`. `.xcconfig` files are not read: when the Debug configuration of the app target or of the project is based
  on one, other than CocoaPods' `Pods-*.xcconfig`, that sets (itself or through its `#include` lines)
  `HEADER_SEARCH_PATHS`, `GCC_PREPROCESSOR_DEFINITIONS`, `CLANG_CXX_LANGUAGE_STANDARD`, `SWIFT_OBJC_BRIDGING_HEADER`,
  `PRODUCT_MODULE_NAME`, `CODE_SIGN_ENTITLEMENTS` or `INFOPLIST_FILE`, `build` prints `⚠ <file> sets <settings> for the
  app target; rn-xtool does not read xcconfig files` and `doctor --project` the same line as `⚠ app-target — …`. Set
  those values in the target's build settings ([details](troubleshooting.md#precheck)).

Not carried over: `IPHONEOS_DEPLOYMENT_TARGET` (the generated package always targets iOS 16.4, in Swift 5 language
mode), capabilities and script phases. When `OTHER_CFLAGS`, `OTHER_LDFLAGS` or `OTHER_SWIFT_FLAGS` hold flags beyond
`-ObjC` and `-lc++`, `build` logs them by name as not carried over.

`CODE_SIGN_ENTITLEMENTS` of the Debug configuration is read: when its file has keys, they go to
`ios-xtool/App.entitlements`, which `xtool.yml` names, and xtool signs the app with them. Before compiling, `build`
prints a `⚠` line for each key a free team does not get, and it stops when the file is missing or is not a property
list dictionary ([troubleshooting.md](troubleshooting.md#entitlements)).

## Sources

The target's Sources phase is copied to `ios-xtool/Sources/App` keeping its layout: `.swift`, `.m`, `.mm`, `.c`,
`.cpp`/`.cc`/`.cxx` and headers, with `.lproj` variant groups. Any other source type (`.xcdatamodeld`,
`.intentdefinition`, `.s`, ...) stops the build with `unsupported source type in the app target`. Sources outside
`ios/` and two compiled files with the same name are errors.

Every header the Xcode project references under `ios/`, in any group and outside `Pods/`, `build/`, frameworks and the
Products group, is copied too, with a forward in `Sources/App/include`, so `#import "X.h"` resolves from any source of
the target as it does with Xcode's header map: an `AppDelegate.h` next to the `.xcodeproj` is found from
`<Target>/main.m`. When two headers share a name, a header of the Sources phase or of the app folder wins and the
build prints `ℹ Two app headers are named X.h (…)`. A referenced header that does not exist is skipped with `ℹ Skipped <path>: the Xcode
project references this header, but the file does not exist`. Headers outside `ios/` are not copied: move them into
`ios/`.

SwiftPM takes a target with a compiled file named `main.<ext>` (in any case) for an executable target, and xtool links
the app's entry point from the App library, so a C-family `main` file is copied under another name in its folder:
`main.m`, the entry point of the React Native templates before 0.77, is compiled as `AppMain.m` (`main.mm` as
`AppMain.mm`, and so on), and the build prints `ℹ <Target>/main.m is compiled as AppMain.m: …`. The file still defines
`main` and keeps its imports, so `UIApplicationMain(…, NSStringFromClass([AppDelegate class]))` starts the app as in
Xcode. An app file already named `AppMain.<ext>` is an error, as two files with the same name are. A `main.swift` is
refused, by `build` and `doctor --project`, because Swift allows top-level code only in a file named `main.swift`: mark
the app delegate class `@main`, as the template's `AppDelegate.swift` does, move any other top-level code into it, and
remove `main.swift` from the app target. Verified on a physical iPhone on 2026-11-06 with a React Native 0.85.0 app
whose `main.m`, `AppDelegate.h` and `AppDelegate.mm` sit next to the `.xcodeproj`
([React Native 0.85](#react-native-085)).

## Mixed Swift + Objective-C/C++ app target

If the target compiles any `.m`, `.mm`, `.c` or `.cpp` file, it is built as one mixed-language target, the same
mechanism as the scaffolded mixed libraries (the two manifests described in
[How it works](how-it-works.md#mixed-language-manifests)). The bridging header is passed with `-import-objc-header`
and your header search paths and defines are applied. The target's `.mm` and `.cpp` files compile with the project's
`CLANG_CXX_LANGUAGE_STANDARD` (C++20 when unset), passed to them as `-std=` because Swift Build does not apply the
package's `cxxLanguageStandard` to a mixed target. Verified on a device with an Objective-C module next to a Swift
module, and on 2026-11-06 with the Objective-C app target of a production React Native 0.85.0 app, whose
`AppDelegate.mm` imports `<RCTAppDelegate.h>` and `<AppAuth/AppAuth.h>` ([React Native 0.85](#react-native-085)).

Swift Build names the generated Swift header `App-Swift.h` (the SwiftPM target is `App`), so `build` also writes
`Sources/App/include/<Module>-Swift.h`, which imports it: Objective-C keeps `#import "<Module>-Swift.h"` as in Xcode,
where `<Module>` is `PRODUCT_MODULE_NAME`, or `PRODUCT_NAME` with characters other than letters, digits and `_` turned
into `_`.

React Native's public Objective-C headers are importable by their bare name (`#import <RCTAppDelegate.h>`) as well as by
module (`#import <React/RCTAppDelegate.h>`), as CocoaPods' per-pod header search paths allow, and so are the
`<Pod/Header.h>` spellings of the pod table's `forwardHeaders` (`#import <AppAuth/AppAuth.h>`, in `.m` and `.mm` files
alike: the forwarder `#import`s the pod's public headers, since Objective-C++ compiles without modules). The app's
Objective-C sources and its bridging header search the app's own headers and `HEADER_SEARCH_PATHS` first, then
`ios/build/xcframeworks/ReactHeadersTarget/include/React`, then each per-module directory of
`ReactNativeHeaders.xcframework` that its module map names (`React_RCTAppDelegate`, `RCTImage`, `yoga`, …), then each
autolinked library's `rn-spm-pod-headers`, so an app header with the same name wins. React Native's C++ headers keep
their path spelling (`<react/debug/flags.h>`, `<jsi/jsi.h>`).

## Resources

The Resources phase is copied to `ios-xtool/Resources` (by file name; `*.lproj/` and `*.bundle/` stay whole) and listed
in `xtool.yml`, so they land at the app bundle root. Storyboards, asset catalogs and `.xib` files need Xcode's tools, so
they are skipped with an `ℹ` line: no launch screen from a storyboard. The app icon is the exception: `build` takes one
PNG from `Images.xcassets/AppIcon.appiconset` (the template's set lists sizes without files, so add a 1024×1024 PNG;
see [troubleshooting.md](troubleshooting.md#app-icon-and-launch-screen)).

## Metro

`start` runs `npx react-native start --port <metroPort>` (`--clear` becomes `--reset-cache`). For bare, `ip.txt` holds
`<lanIp>:<metroPort>`: React Native reads only the host from `ip.txt` and takes the port from a compile-time constant
(8081 in the prebuilt framework), so a custom `metroPort` travels in the `ip.txt` value. The first open of a fresh dev
build shows the LogBox banner "Open debugger to view warnings" (warnings of the RN template; harmless).

## Hybrid (bare + Expo modules)

`npx install-expo-modules@latest` raises the deployment target, switches the Babel preset to `babel-preset-expo` and
the Metro config to `expo/metro-config`, but on an RN 0.88 template it leaves `AppDelegate.swift` not compiling and does
not touch `SceneDelegate.swift`. Rewrite them by hand as in the Expo 58 template: `AppDelegate` on `ExpoAppDelegate`
with `ExpoReactNativeFactory`, `SceneDelegate` on `ExpoAppSceneDelegate`. Run `npx expo install --fix`, so `expo` and
its modules are at least Expo SDK 58's verified set, and then move React Native to 0.88.1 as in
[Upgrading React Native](#upgrading-react-native) (`--fix` can leave or put it on 0.88.0). In a bare app `--fix` also
moves the template's `jest` from ^29.6.3 to ~30.5.2 and `@types/jest` to 30.0.0. Do not pin `expo-modules-jsi` or
`expo-modules-autolinking` (a jsi pin nests a second copy, which the build refuses). If your app has those pins
(rn-xtool 0.1.0-alpha.2's docs asked for them), remove them with
`npm uninstall expo-modules-jsi expo-modules-autolinking` before you move `expo`, in the order of
[Moving to the 58.0.21 set](troubleshooting.md#moving-to-the-58021-set). npm can keep expo-modules-core's
expo-modules-jsi nested after that (package-lock.json holds its place; neither a reinstall nor `npm dedupe` moves it),
and `doctor` then stops on it; `npm update expo-modules-jsi` moves it to the top level without changing other
packages. The SDK 58 checks of Expo apps apply to
hybrids too ([how-it-works.md](how-it-works.md#expo-sdk-58), messages in
[troubleshooting.md](troubleshooting.md#expo-sdk-58)), and an `expo` older than SDK 58 stops the build. Verified on a
physical iPhone on 2026-10-28: a hybrid app on expo 58.0.21 and React Native 0.88.1 launched, with expo-haptics and an
Objective-C module calling Swift working.
`expo-constants` gets its `EXConstants.bundle/app.config` as in Expo apps.

## Libraries

Libraries with a podspec work as in Expo apps (auto-scaffolded, patches persisted in `patches/`); see
[libraries.md](libraries.md), whose `Bare` columns record what was checked on a bare app. `react-native-reanimated`
needs `plugins: ['react-native-worklets/plugin']` in your `babel.config.js` (`babel-preset-expo` adds it for Expo apps);
its `Package.swift` fix for Linux needs no patch, rn-xtool applies it on every build.

## Limits

- One application target and one `.xcodeproj` per project.
- `.xcconfig` files, capabilities and script phases are not read; no asset catalogs or storyboards, except the app
  icon, which is taken from `AppIcon.appiconset`. Entitlements come from the Debug `CODE_SIGN_ENTITLEMENTS` file
  ([above](#what-is-read-from-projectpbxproj)).
- Only the React Native lines in [the table above](#supported-react-native-versions), from their floor, are supported.

Implementation notes: the "Bare React Native notes" section of [recipe.md](recipe.md#bare-react-native-notes) and the
design record [design/specs/2026-10-26-bare-react-native-design.md](design/specs/2026-10-26-bare-react-native-design.md).
