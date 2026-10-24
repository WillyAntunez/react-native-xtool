# Mixed-module survey (Expo SDK 58 / RN 0.88, SwiftPM on Linux)

Method: fresh `npm install --ignore-scripts` of the candidate libs (Expo `~58.0.17`), inspect `ios/`/`apple/`, apply the
Expo SPM plugin's own rules (`plugin.js`, `classify.js`, `manifests.js`). File counts exclude `Tests/`; `.c` noted where present.

## How the plugin decides (what "works today" means)

1. PRECOMPILED: only if a flavored xcframework artifact exists (`prebuilds/output/{debug,release}` shipped in the npm package, or in the
   local build cache). The `spm.config.json` alone is NOT enough: it only makes the module *prebuildable* (reason `prebuild-available`,
   fix = `et prebuild`, which needs macOS/xcodebuild). In the installed SDK 58 packages only `expo-modules-core`, `expo-modules-jsi`
   (headers), `expo-file-system` and `expo-font` ship artifacts.
2. SOURCE-BUILT with a checked-in `Package.swift` (mirrored verbatim).
3. SOURCE-BUILT pure Swift (no `.m/.mm/.c/.cpp/.cc` under `ios/`, `apple/`, `common/`): one generated Swift target. Refused if the
   podspec declares linkage (`needs-manifest-for-linkage`).
4. Anything else -> unsupported: `mixed-no-manifest` (has sources), `no-apple-sources`, or `prebuild-available` (has spm.config.json).
   NOTE: pure ObjC *Expo* modules also land here (the pure-Swift rule requires zero non-Swift files).

Direction legend: A = Swift needs ObjC/C of the same module; B = ObjC needs `<Name>-Swift.h`; A+B = circular. C = vendored binary.

## Table

| Module | Version | Kind | swift/m/mm/h/cpp(+c) | Dir | Vendored binaries | Verdict |
|---|---|---|---|---|---|---|
| expo-modules-core | 58.0.24 | mixed, precompiled | 190/13/20/69/0 | A+B (handled, ships xcframework) | none | works-today (precompiled) |
| expo-modules-jsi | 58.0.17 | Swift+C++, has Package.swift + headers prebuild | 69/0/0/11/2 | n/a | none | works-today |
| expo-file-system | 58.0.10 | mixed, precompiled | 23/11/0/13/0 | A | none | works-today (precompiled artifacts shipped) |
| expo-font | 58.0.9 | pure Swift, precompiled | 8/0/0/0/0 | - | none | works-today |
| expo-constants | 58.0.13 | mixed, own Package.swift (2 targets) | 1/2/0/2/0 | A (split) | none | works-today |
| @expo/log-box | 58.0.13 | mixed, own Package.swift (Swift + Clang target) | 2/0/1/0/0 | B (ObjC->Swift only) | none | works-today |
| @sentry/react-native | 8.32.0 | mixed, own Package.swift (RNSentrySwift/RNSentryCpp/RNSentry) | 2/20/4/36/0 | B (via `@import RNSentrySwift`) | `.binaryTarget` Sentry (remote url+checksum) | works-today (own manifest does A/B/C by hand; needs network, hard-coded relative paths to the RN SPM layout) |
| expo-asset | 58.0.18 | pure Swift | 1/0/0/0/0 | - | none | works-today |
| expo-calendar | 58.0.6 | pure Swift | 29/0/0/0/0 | - | none | works-today |
| expo-clipboard | 58.0.4 | pure Swift | 8/0/0/0/0 | - | none | works-today |
| expo-crypto | 58.0.7 | pure Swift | 8/0/0/0/0 | - | none | works-today |
| expo-eas-client | 58.0.2 | pure Swift | 2/0/0/0/0 | - | none | works-today |
| expo-keep-awake | 58.0.3 | pure Swift | 1/0/0/0/0 | - | none | works-today |
| expo-linking | 58.0.14 | pure Swift | 3/0/0/0/0 | - | none | works-today |
| expo-localization | 58.0.5 | pure Swift | 1/0/0/0/0 | - | none | works-today |
| expo-manifests | 58.0.1 | pure Swift | 4/0/0/0/0 | - | none | works-today |
| expo-notifications | 58.1.6 | pure Swift | 20/0/0/0/0 | - | none | works-today |
| expo-updates-interface | 58.0.1 | Swift + placeholder `noop-file.m` | 2/1/0/0/0 | none (the `.m` is an empty placeholder) | none | NOT works-today: any `.m` fails the pure-Swift test (-> `prebuild-available`); needs a generic rule to ignore empty/noop ObjC files, or A |
| expo-web-browser | 58.0.6 | pure Swift | 5/0/0/0/0 | - | none | works-today |
| expo-dev-menu-interface | 58.0.1 | pure Swift | 5/0/0/0/0 | - | none | works-today |
| @expo/dom-webview | 58.0.2 | pure Swift | 8/0/0/0/0 | - | none | works-today |
| @react-native-community/netinfo | 12.0.1 | pure ObjC/ObjC++ | 0/2/1/3/0 | - | none (links NetworkExtension framework) | works-today (RN scaffolder; frameworks mapping needed) |
| @react-native-picker/picker | 2.11.4 | pure ObjC++ | 0/0/4/5/0 | - | none | works-today |
| @react-native-masked-view/masked-view | 0.3.2 | pure ObjC | 0/2/0/2/0 | - | none | works-today |
| @react-native-google-signin/google-signin | 16.1.5 | pure ObjC++ | 0/0/5/4/0 | - | none, but pod dep `GoogleSignIn` | works-today modulo external-pod -> SPM mapping (GoogleSignIn-iOS SPM) |
| expo-json-utils | 58.0.1 | pure ObjC (Expo module) | 0/1/0/1/0 | - | none | needs "pure-ObjC emit" in plugin (no A/B/C): today `prebuild-available` |
| expo-structured-headers | 58.0.1 | pure ObjC (Expo module) | 0/1/0/1/0 | - | none | same as above |
| expo-application | 58.1.2 | mixed (spm.config, no artifact) | 2/1/0/1/0 | A (`EXProvisioningProfile` used by Swift) | none | needs A |
| expo-sqlite | 58.0.13 | Swift + vendored C amalgamation in `vendor/sqlite3` (outside `ios/`) | 17/0/0/0/0 in ios; sqlite3.c in vendor | A-like (Swift -> C module `exsqlite3_*`, custom `-Xcc` flags) | none, but C source dir outside `ios/` | needs A (C target from `vendor/`, cflags); today it would classify as pure Swift and emit a broken package (silent) |
| expo-updates | 58.0.18 | mixed Swift + ObjC + `.c` BSPatch | 103/2/0/3/0 (+BSPatch .c) | A (`EXDeferredRCTRootView`, BSPatch); no ObjC->Swift | none real (`vendored_frameworks` only in the prebuilt branch); script phase + resource bundle | needs A + (EXStructuredHeaders ObjC module, ReachabilitySwift SPM dep, script phase, resource bundle) |
| react-native-pager-view | 9.0.9 | mixed (Swift + ObjC++ Fabric view) | 6/1/1/2/0 | B only (`.mm` imports `react_native_pager_view-Swift.h`; Swift never references the ObjC) | none; pod dep `SwiftUIIntrospect` | needs B (+ external SPM dep SwiftUIIntrospect) |
| @react-native-async-storage/async-storage | 3.1.1 | mixed (Swift + ObjC++) | 2/0/2/2/0 | B only (`AsyncStorage.mm` imports `AsyncStorage-Swift.h`) | `apple-frameworks/SharedAsyncStorage.xcframework` (Swift imports it) | needs B + C |
| expo-dev-menu | 58.0.11 | mixed | 42/2/0/3/0 | A+B circular (`EXDevMenuAppInfo.m` imports `EXDevMenu-Swift.h`; Swift uses `EXDevMenuAppInfo`, `RCTKeyCommands` category defined in-module) | none; resource bundle, `-DEX_DEV_MENU_ENABLED` defines, subspec, debugOnly | needs A+B (circular) |
| expo-dev-launcher | 58.0.14 | mixed | 53/5/0/6/0 | A+B circular (3 `.m` import `EXDevLauncher-Swift.h`; Swift uses `EXDevLauncherController` 7 files); its `.h` also imports other modules' `EXUpdatesInterface-Swift.h`, `EXManifests-Swift.h` | none; resource bundle, debugOnly | needs A+B (circular) + cross-module `-Swift.h` |
| expo-dev-client | 58.0.14 | podspec-only meta pod (deps only) | 0/0/0/0/0 | - | none | no-apple-sources: needs an "empty meta module" rule (not A/B/C) |

JS-only (no `ios/`): expo-auth-session.

## Verdict counts (35 native modules inspected)

- works-today: 23 (4 precompiled/special, 3 own Package.swift, 13 pure Swift, 3 pure community ObjC) + 1 conditional (google-signin: external pod mapping)
- needs pure-ObjC emit (no A/B/C): 2 (expo-json-utils, expo-structured-headers)
- needs A (or noop-.m rule): 4 (expo-application, expo-sqlite, expo-updates, expo-updates-interface)
- needs B: 1 (react-native-pager-view)
- needs B + C: 1 (async-storage)
- needs A + B (circular): 2 (expo-dev-launcher, expo-dev-menu)
- needs meta-pod rule: 1 (expo-dev-client)

## Unblock lists per feature

A alone (Swift -> same-module ObjC/C; Clang target + Swift target depending on it):
- expo-application (also fixes expo-file-system if no artifact is available, i.e. if prebuilds are not trusted)
- expo-sqlite (needs the C target to live at `vendor/sqlite3`, plus cflags; also the plugin must NOT take it for pure Swift)
- expo-updates: A is necessary but not sufficient (EXStructuredHeaders, ReachabilitySwift as SPM package, script phase/resource bundle)

B alone:
- react-native-pager-view (+ SwiftUIIntrospect SPM package)
- Note: B is also solvable with the same two-target split (Clang target depends on Swift target, ObjC does `@import <SwiftTarget>`), as `@expo/log-box` and `@sentry/react-native` already do by hand. A pre-compile `-Swift.h` step is only required for the circular case.

B + C:
- @react-native-async-storage/async-storage (Swift `import SharedAsyncStorage` is the binary target; ObjC++ imports its Swift header)

A + C: no module in this set. (Closest: Sentry, already hand-written.)

Circular A+B (hardest; needs the pre-compile step, ObjC headers must not import the module's own `-Swift.h`):
- expo-dev-menu, expo-dev-launcher. Both put module-local ObjC types in Swift and Swift types in `.m`.

Not A/B/C but blocking:
- pure-ObjC Expo modules (expo-json-utils, expo-structured-headers): plugin refuses them (pure-Swift rule is zero non-Swift files). Needed by expo-updates (structured-headers). Route them to the RN scaffolder's pure-ObjC path.
- expo-dev-client: empty meta pod.
- External pod -> SPM mapping: GoogleSignIn, SwiftUIIntrospect, ReachabilitySwift (sqlite3 is a system lib).

## expo-dev-client chain

expo-dev-client (meta pod, deps only; `expo-dev-launcher`, `expo-dev-menu`, `EXManifests` are debug-only dependencies)
- expo-dev-launcher: A+B circular. Deps: expo-dev-menu-interface, EXManifests, EXUpdatesInterface, expo-dev-menu, ExpoModulesCore, React-RCTAppDelegate, ReactAppDependencyProvider, React-jsinspector. Resource bundle, debugOnly. Its `EXDevLauncherController.h` imports `EXUpdatesInterface-Swift.h` and `EXManifests-Swift.h` (other modules' Swift headers), so those Swift targets' generated headers must be reachable by a Clang target of another package.
- expo-dev-menu: A+B circular. Deps: EXManifests, expo-dev-menu-interface, React-Core, jsinspector. Resource bundle, Swift/ObjC defines `EX_DEV_MENU_ENABLED`, subspec `Main`. `RCTKeyCommands` is a category re-declared in-module.
- expo-dev-menu-interface: pure Swift, works today.
- EXManifests (expo-manifests): pure Swift, works today.
- EXUpdatesInterface (expo-updates-interface): blocked today by a placeholder `noop-file.m` (see note 1); trivial once such files are ignored or A exists.
Verdict: blocked by the two circular modules, the meta pod, and the noop `.m` in expo-updates-interface. Nothing in the chain needs C. expo-updates is NOT part of the dev-client chain (dev-client uses the interface package only).

## Notes

1. expo-updates-interface ships `ios/EXUpdatesInterface/noop-file.m` (a CocoaPods static-framework placeholder). `scanAppleSources` flags any `.m` as non-pure-Swift, so the module is refused. Same trick may exist elsewhere; grep before trusting a pure-Swift verdict (done for this set: only this one).
2. Verdict "works-today" for expo modules assumes Expo's SPM plugin and the standard autolinking; none of the pure-Swift Expo modules were built here (no Swift toolchain run), only classified.
3. `spm.config.json` is not sufficient for Linux: without shipped prebuilds those modules are only buildable from source, so (A) is what actually unblocks `expo-application`, not the config.
4. Counts exclude `Tests/`, `node_modules`, and build dirs, same as `walkSourceTree`.
