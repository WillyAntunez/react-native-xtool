# Bare React Native projects — design

Date: 2026-10-26. Decided with Willy: same repo and same CLI, auto-detected project kind; the package
name stays `expo-xtool` for now (a neutral name is a later, separate decision).

## Intent

`expo-xtool` builds, signs and installs Expo SDK 58 iOS dev builds from Linux. Plain React Native
projects (created with `@react-native-community/cli init`, no Expo) use the same React Native 0.88
SwiftPM pipeline underneath, so the same tool should build them with the same commands:
`setup` → `run`, Wi‑Fi installs, Fast Refresh. This is also the first step towards React Native
0.81–0.87 (and Expo SDK 54–57): the pre-0.88 problem is identical for bare and Expo projects, and it
sits in the layer this design isolates.

## Goals

- `expo-xtool build | install | start | run | doctor` work unchanged on a bare React Native 0.88
  project. The user never says which kind of project it is.
- Two bare shapes are supported:
  - **pure**: the official template as created (`AppDelegate.swift` + `SceneDelegate.swift` with
    `RCTReactNativeFactory`, `Info.plist`, `LaunchScreen.storyboard`, `<Name>.xcodeproj`, `Podfile`);
  - **hybrid**: a bare project that installed Expo modules with `npx install-expo-modules`
    (`expo`, `expo-modules-core`, possibly `expo-constants`) and uses Expo libraries such as
    `expo-haptics` without being an Expo project.
- The project's `ios/` is never modified: no pbxproj edits, no `pod deintegrate`, no `.spm-injected.json`.
  Only `ios/build/` (React Native's generated output, git-ignored by the template) is written.
- Project patches (`patches/*.patch` persisted by the scaffolder) keep working as they do for Expo.
- A bare reference app lives next to the Expo one and is exercised against the iPhone with a short
  library matrix.

## Non-goals

- React Native older than 0.88 (next project; see "What this prepares").
- Changing the package name, the cache directory (`~/.cache/expo-xtool`) or the config file name.
- Supporting `use_frameworks!`, Mac Catalyst, multiple app targets, app extensions, custom Xcode
  script phases, or arbitrary compiler flags from the pbxproj (the mapped settings are listed in
  "App target content"). One iOS application target per project.
- Compiling `LaunchScreen.storyboard`, asset catalogs or `.xcassets` (no Xcode tools on Linux): the
  launch screen keeps using the `UILaunchScreen` replacement we already apply; the app icon stays the
  generic one, as for Expo projects today.
- Android, Windows, macOS targets.

## Anti-goals

- A second CLI surface (`expo-xtool rn …`) or a separate repo: the user runs one command.
- Synthesizing an `app.json` and running `expo prebuild` on a bare project: that would rewrite the
  user's `ios/` and require `expo` to be installed.
- Per-library adaptations. Anything a library needs must be a generic fix in the scaffolder patch or
  the Expo plugin patch, as before.

## Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0, React Native 0.88.x (`MIN_RN = 0.88`), Expo SDK 58 for
  the Expo kind. No Xcode tools, no CocoaPods, no Ruby.
- The pbxproj must be read without Xcode. The `xcode` npm package (4.0.0) is already in the
  dependency tree through `@expo/config-plugins`; it is promoted to a direct dependency.
- The React Native SwiftPM pipeline discovers Expo's SPM autolinking plugin by itself: `expo`'s
  own `react-native.config.js` declares `spm.autolinkingPlugin: './scripts/spm/plugin.js'`, and RN reads
  each autolinked dependency's `react-native.config.js`. The declaration is conditional on Expo modules
  being set up for iOS (`use_expo_modules!` in `ios/Podfile`, which `npx install-expo-modules` adds;
  assumed true when there is no Podfile). So the hybrid shape needs no extra wiring for the plugin,
  only our Expo patches and the runtime pieces; `doctor` reports when `expo` is installed but the
  plugin would stay inactive.
- React Native's `setup-apple-spm.js add|update` refuses a CocoaPods-integrated pbxproj (the template's
  app target has `Pods-<Name>.*.xcconfig` as `baseConfigurationReference`) and its only fix,
  `add --deintegrate`, runs `pod deintegrate`, which needs CocoaPods. Both actions also edit the
  pbxproj in place (package references, build settings, a Sync build phase). expo-xtool never uses the
  xcodeproj, so for bare projects it runs the pipeline **without the injection step**: the script's
  `sync` action (autolinking config, codegen, `build/generated/autolinking/Package.swift`, header
  farm), its `download` action (both artifact flavors), and `scripts/spm/generate-spm-package.js`
  (`build/xcframeworks/Package.swift` + `flavored-frameworks.json`), which is exported for direct use.
  That is steps 1–5 of `add` with no pbxproj read or write. The Expo kind keeps `add|update` in this
  project (its prebuilt `ios/` has no CocoaPods layering and the path is proven); unifying both on
  the no-injection pipeline is a follow-up, and it is what React Native < 0.88 will need anyway.
- The bundled patches (`patches/expo+…`, `expo-modules-autolinking+…`, `expo-modules-jsi+…`) must not
  be applied to a project where those packages are absent: patch-package fails on a patch whose
  package is not installed.

## Approaches considered

- **A. Project adapter inside the existing pipeline (chosen).** One `ProjectAdapter` interface, two
  implementations, selected when the project is read. Steps of `build` become adapter-driven. One
  CLI, one test suite, automatic detection.
- **B. Separate subcommand reusing modules.** Less surgery, but two CLI surfaces and the user has to
  know what their project is. Rejected.
- **C. Treat bare as Expo via a synthetic `app.json` and `expo prebuild`.** Reuses everything, but
  rewrites the user's `ios/` and requires `expo`. Rejected.

## Design

### Project detection

`readProject(root)` decides the kind:

- `expo` when `package.json` has `expo` in `dependencies` **and** the project has an Expo config in
  Expo's own shape: an `app.config.{js,ts,mjs,cjs,json}` file, or an `app.json` whose top level has an
  `expo` key. (The React Native template ships `app.json` as `{"name","displayName"}`, which
  `@expo/config` would also accept as a flat config, so "any readable config" is not the test.)
- `bare` otherwise, when `ios/` holds exactly one `*.xcodeproj` with one iOS application target.
- `projectKind: "expo" | "bare"` in `expo-xtool.config.json` overrides the detection (for an Expo
  project with a flat `app.json`, or a bare project that keeps an `expo` key in `app.json`).
- Otherwise a clear error: no `ios/` (for bare: "run `npx @react-native-community/cli init` or add
  the iOS project"; for Expo: prebuild runs as today), several `.xcodeproj`, several app targets.

The hybrid shape is `bare` with `hasExpoModules = true`, detected by `expo-modules-core` being
installed (resolvable from the project root); `expo` must be installed too (install-expo-modules adds
both), otherwise `build` stops with that instruction.

### The adapter

```ts
interface ProjectInfo {
  kind: "expo" | "bare";
  root: string;
  name: string;              // PRODUCT_NAME (bare) / expo.name (expo)
  slug: string;              // bare: name
  version: string;           // MARKETING_VERSION / expo.version
  buildNumber: string;       // CURRENT_PROJECT_VERSION / ios.buildNumber
  bundleIdentifier: string;
  moduleName: string;        // JS app registry name: bare = PRODUCT_NAME (template registers it in app.json "name"), expo = unused
  iosTargetName: string;     // Xcode target / folder under ios/
  iosTargetDir: string;      // ios/<target>
  rnVersion: string;
  sdkVersion?: number;       // expo only
  hasExpoModules: boolean;   // expo: true; bare: expo-modules-core installed
  hasExpoConstants: boolean; // expo-constants installed (EXConstants.bundle)
}

interface ProjectAdapter {
  read(root: string, opts: ReadProjectOptions): Promise<ProjectInfo>;
  prebuild?(root: string, clean: boolean): Promise<void>;        // expo only
  autolinkingConfigCommand(): string[] | undefined;              // expo: expo-modules-autolinking react-native-config; bare: undefined (RN resolves @react-native-community/cli config)
  appSources(info: ProjectInfo): string[];                       // files copied to ios-xtool/Sources/App
  metroCommand(port: number, clear: boolean): [string, string[]]; // expo: npx expo start --lan --port; bare: npx react-native start --port (+ --reset-cache)
}
```

The pipeline (`build.ts`) keeps its step list, but each step asks the adapter / `ProjectInfo`:

| Step | expo | bare pure | bare hybrid |
| --- | --- | --- | --- |
| prebuild | `expo prebuild` when `ios/` missing or `--clean` | never | never |
| patches | bundled RN + Expo patches, then project patches | bundled RN patch only, then project patches | bundled RN + Expo patches (for the installed ones), then project patches |
| rn-spm | `setup-apple-spm.js add\|update` with Expo's config command (unchanged) | `sync` + `download` + `generate-spm-package.js`, default config command, no xcodeproj injection | same as bare pure (the Expo plugin runs through RN's discovery) |
| expo-jsi | build ExpoModulesJSI | skipped | build ExpoModulesJSI |
| app-config | `EXConstants.bundle` | skipped | only when `expo-constants` is installed |
| generate | Sources: AppDelegate + SceneDelegate + ExpoModulesProvider link; compile-interfaces; clang importer | Sources and resources from the app target's build phases (below); no Expo inputs | like bare pure plus the Expo inputs |
| xtool-build | unchanged | unchanged | unchanged |

**Bundled patch selection.** `applyPatches` builds the list of bundled patch files whose package is
installed (`installedVersion` already exists) and applies only those. Because patch-package applies a
whole directory, the selected files are linked into `ios-xtool/.patches/` (regenerated on each build,
git-ignored with the rest of `ios-xtool/`) and that relative directory is passed as `--patch-dir`.
The version-mismatch message stays as it is.

### Reading the pbxproj (bare)

`src/project/pbxproj.ts`, built on the `xcode` package:

- Find `ios/*.xcodeproj/project.pbxproj`; parse; take the single native target with
  `productType == "com.apple.product-type.application"`.
- Read from that target's **Debug** build configuration, falling back to the project-level
  configuration: `PRODUCT_NAME`, `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`,
  `CURRENT_PROJECT_VERSION`, `INFOPLIST_FILE`, `IPHONEOS_DEPLOYMENT_TARGET` (informational).
- Resolve build-setting references in those values with a small resolver: `$(PRODUCT_NAME)`,
  `$(TARGET_NAME)`, `$(PROJECT_NAME)`, and the `:rfc1034identifier` modifier (letters, digits and
  hyphens; anything else becomes `-`). The template's default is
  `org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)`, so a fresh project needs no edit.
  Any other unresolved `$(…)` is an error naming the setting (same strictness as our Info.plist
  resolver).
- `Info.plist` comes from `INFOPLIST_FILE` (relative to `ios/`), default `ios/<target>/Info.plist`.
  It goes through the existing `transformInfoPlist` (variables, `UILaunchScreen`, Metro port,
  local-network keys). `$(PRODUCT_MODULE_NAME)` keeps resolving to `App`, as today.
- `baseConfigurationReference` (`.xcconfig`) entries are **ignored**, not errors: the template's are
  the CocoaPods `Pods-<Name>.*.xcconfig`, which do not exist on a machine without `pod install` and
  carry nothing we read. A documented limit: settings that only live in a user `.xcconfig` are not seen.
- JS module name: the template passes `withModuleName: "<Name>"` in `SceneDelegate.swift` and
  registers the same name in the project's root `app.json` (`"name"`); nothing to resolve, the
  Swift file is copied as is.

### App target content (bare)

The file list comes from the app target's **Sources** and **Resources** build phases in the pbxproj
(resolved through `PBXFileReference` / `PBXGroup` paths), not from a folder scan:

- `*.swift` → copied to `ios-xtool/Sources/App` (flat; a duplicate basename is an error).
- `*.m`, `*.mm`, `*.c`, `*.cpp`, `*.h` → supported from v1 (Willy's decision): local native modules
  written in Objective-C/C++ are common in bare apps. When the target has any of them, the generated
  `App` target becomes a mixed-language target using the mechanism already proven for scaffolded
  libraries: `// swift-tools-version: 6.4;(experimentalMultiLang)` in `ios-xtool/Package.swift`
  (plus `Package@swift-6.5.swift`, SE-0541 form), Swift and Objective-C sources side by side under
  `Sources/App`, headers under `Sources/App/include`. The pbxproj's `SWIFT_OBJC_BRIDGING_HEADER` is
  passed with `-import-objc-header`; Objective-C files reach Swift through `App-Swift.h` from the
  generated-module-maps directory (`RN_SPM_SWIFT_HEADERS_DIR`, already exposed). Build settings read
  for them: `GCC_PREPROCESSOR_DEFINITIONS` (→ `.define`), `HEADER_SEARCH_PATHS` (relative to `ios/`,
  → `-I`), `CLANG_CXX_LANGUAGE_STANDARD` (→ `cxxLanguageStandard`). `OTHER_CFLAGS`/`OTHER_LDFLAGS`
  and anything else are ignored with one log line naming them. Files are copied preserving their
  relative layout under the target folder, so `#import "Sub/Header.h"` keeps working; a duplicate
  basename across folders is still an error (SwiftPM object files are flat).
- Resources other than `*.storyboard`, `*.xcassets`, `*.xib` → copied into the app bundle via
  `Package.swift` resources (`PrivacyInfo.xcprivacy`, fonts in `UIAppFonts`, `.bundle` folders,
  `.json`/images). Storyboards, asset catalogs and xibs are skipped with one log line (no Xcode tools);
  the launch screen and app icon behave as for Expo projects today.

### Generated `ios-xtool/` for bare

Same layout as today. `Package.swift` gets the same `App` module (`Sources/App`), the staged
runtime frameworks from `flavored-frameworks.json`, and the autolinking package RN generated under
`ios/build/generated/autolinking/`. The Expo-only inputs (`compile-interfaces`, the clang importer
inputs, `ExpoModulesProvider.swift`, `EXConstants.bundle`, the JSI framework) are included only when
`hasExpoModules` / `hasExpoConstants` say so. `xtool.yml`, `ip.txt`, `.gitignore` unchanged.

### Metro

`start` runs the adapter's command: `npx react-native start --port <port>` (and `--reset-cache` when
the cache must be cleared) for bare, `npx expo start --lan --port …` for Expo. The port and LAN IP
rules, the `startDecision` logic and the fingerprint-based cache clearing do not change. The
"Metro URL for the dev launcher" line is printed only when `expo-dev-client` is installed.

### doctor

New check `project`: kind (`expo` / `bare` / `bare + expo modules`), React Native version, and for
bare the xcodeproj and target found. The `expo-sdk` check applies only to the Expo kind; bare
projects get a `react-native` check (`>= 0.88`).

### Tests and reference app

- Unit tests: detection (expo / bare / hybrid / override / errors), pbxproj reading on fixtures copied
  from the 0.88 template (default and edited bundle id, `$(…)` resolution, ignored xcconfig, two
  targets → error, mixed Swift + Objective-C target rendering with bridging header, defines and header
  search paths, build-phase file lists), patch selection, step planning
  per kind (the table above), the bare rn-spm argv (`sync`, `download`, generate-spm-package), Metro
  command per kind, Info.plist transform for the template plist.
- Reference app `../app-bare` (sibling of `app/`): `npx @react-native-community/cli init BareDemo
  --version 0.88.0`, committed as its own git repo like `app/`, with a demo screen. Library matrix on
  the iPhone: react-native-screens, react-native-gesture-handler, react-native-reanimated +
  worklets, react-native-svg, react-native-webview, @react-native-community/datetimepicker; a **local
  Objective-C native module** in the app target (an `RCT_EXPORT_MODULE` module plus a Swift caller,
  the mixed-target case); then the hybrid shape with `npx install-expo-modules` + expo-haptics. Each library gets a branch like in
  `app/` and a row in `docs/libraries.md` (new "bare" column).
- The clean-machine harness (`e2e/clean-machine/e2e.sh project`) gains `--bare` to create the RN
  template instead of `create-expo-app`.

### Docs

README: "Works with Expo SDK 58+ and React Native 0.88+ (bare)" in the intro and requirements;
a "Bare React Native projects" section (what is read from the pbxproj, what is not supported, the
hybrid shape); `docs/libraries.md` bare column; `docs/recipe.md` bare notes.

## External interactions and failure modes

| Hop | Failure | Decision |
| --- | --- | --- |
| Reading the pbxproj | several app targets / several `.xcodeproj` | handle: error naming them; one target per project is a stated limit |
| Reading the pbxproj | setting uses an unknown `$(VAR)` | handle: error naming the setting; `.xcconfig` files are ignored in v1 (documented) |
| App target | Objective-C/C++ sources use a build setting we do not map (`OTHER_CFLAGS`, custom script phases) | handle: log the ignored settings by name; documented limit |
| App target | Objective-C needs `App-Swift.h` before Swift has compiled (mixed target ordering) | handle: same mechanism as the scaffolded mixed libraries, which already build this way; covered by the reference app's local module |
| rn-spm (bare) | the template's pbxproj is CocoaPods-integrated | handle: never run `add`/`update` on bare; `sync` + `download` + `generate-spm-package.js` need no xcodeproj |
| `setup-apple-spm.js` on bare | default config command needs `@react-native-community/cli` | handle: `doctor`/`build` check it resolves; message to install it (the template has it) |
| Detection | hybrid project whose `app.json` has only `name`/`displayName` | handle: not an Expo config (no `expo` key, no `app.config.*`) → bare; `projectKind` override exists |
| Detection | Expo project with a flat `app.json` (no `expo` key) | handle: detected as bare → fails on the missing xcodeproj with a message pointing at `projectKind: "expo"` |
| Hybrid | `expo-modules-core` present, `expo` absent | handle: error: install-expo-modules adds both; ask the user to install `expo` |
| patches | bundled Expo patch for an installed-but-different version | handle: existing mismatch message, unchanged |
| Metro | `react-native start` not on PATH / CLI missing | handle: same guidance as the config command |
| Template drift | a future 0.88.x template renames files or changes `SceneDelegate` | accept: `appSources` copies every `*.swift` under the target folder, so renames are harmless; structural changes are a new version's problem |

## What this prepares

The adapter and the pbxproj reader are exactly what React Native 0.81–0.87 needs: those projects
have no `setup-apple-spm.js`, so the next project vendors the 0.88 SPM scripts (with our patch) into
expo-xtool and runs them against the older prebuilt artifacts. The bare pipeline already runs the generation steps without the xcodeproj injection, which is
the form the vendored scripts will take. Nothing in this design assumes the scripts come from
`node_modules/react-native`, except `rnSpm.ts`'s path resolution, which becomes an adapter concern then.

## Left to the builder

- Exact shape of `ProjectInfo` fields beyond the ones named; whether `ExpoProject` is kept as a
  type alias during the migration.
- How `build.ts` steps are expressed (predicates on `ProjectInfo` vs. an adapter method returning
  the step list), as long as the table above is what runs and is unit-tested.
- Fixture format for the pbxproj tests (copy of the template's file vs. a trimmed version).
