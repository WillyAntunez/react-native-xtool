# Bare React Native Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `expo-xtool build | install | start | run | doctor` work unchanged on a bare React Native 0.88 project (pure template and the hybrid shape with Expo modules), without touching the user's `ios/`.

**Architecture:** A `ProjectInfo` read by kind-specific readers (`expo` keeps today's code; `bare` reads the pbxproj with the `xcode` package) drives the existing `build` pipeline: Expo-only steps become conditional, the bare kind runs React Native's SwiftPM generation steps without the xcodeproj injection through a small driver script that `require()`s RN's own `scripts/spm/*` modules, and the generated `ios-xtool/Package.swift` gains a mixed Swift + Objective-C `App` target when the app target has C-family sources.

**Tech Stack:** TypeScript (Node 20, ESM), vitest, `xcode` 4.0.0 (pbxproj parser), `@expo/config`, patch-package, React Native 0.88 `scripts/spm/*`, xtool 1.23.0, Swift 6.4.

**Spec:** `docs/design/specs/2026-10-26-bare-react-native-design.md`

## Global Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0, React Native 0.88.x (`MIN_RN = 0.88`), Expo SDK 58 for the Expo kind. No Xcode tools, no CocoaPods, no Ruby.
- The user's `ios/` is never modified: no pbxproj edits, no `pod deintegrate`, no `.spm-injected.json`. Only `ios/build/` is written.
- Never run `setup-apple-spm.js add|update` on a bare project (its pbxproj is CocoaPods-integrated and the actions edit it). Bare runs RN's steps 1–5: autolinking config, codegen + `build/generated/autolinking/Package.swift` (`sync`), artifact download, `build/xcframeworks/Package.swift` + `flavored-frameworks.json` (`generate-spm-package.js`).
- Detection: `expo` iff `package.json` has `expo` in `dependencies` **and** (`app.config.{js,ts,mjs,cjs,json}` exists or `app.json` has a top-level `expo` key). Otherwise `bare` iff `ios/` holds exactly one `*.xcodeproj` with exactly one target of `productType == "com.apple.product-type.application"`. `projectKind: "expo" | "bare"` in `expo-xtool.config.json` overrides.
- Hybrid = `bare` with `expo-modules-core` resolvable from the project root; `expo` must then be resolvable too, else error: `expo-modules-core is installed without expo; run npx install-expo-modules (it installs both)`.
- Bundled patches are applied only for packages that are installed (patch-package fails on a patch whose package is absent).
- pbxproj values are read from the app target's **Debug** configuration, falling back to the project-level Debug configuration. Resolved references: `$(PRODUCT_NAME)`, `$(TARGET_NAME)`, `$(PROJECT_NAME)`, `$(inherited)` (→ project level), modifier `:rfc1034identifier` (every char not `[A-Za-z0-9-]` → `-`). Any other `$(…)` left → error naming the setting. `baseConfigurationReference` (`.xcconfig`) is ignored.
- Default bundle id of the template `org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)` must resolve without edits.
- App target files come from the pbxproj Sources and Resources build phases. `*.swift` and `*.m|*.mm|*.c|*.cc|*.cpp|*.h|*.hpp` are compiled in the `App` target; with any C-family file the manifest is `// swift-tools-version: 6.4;(experimentalMultiLang)` plus a `Package@swift-6.5.swift` twin (tools-version 6.5, no flag). Bridging header via `-import-objc-header`; mapped settings `GCC_PREPROCESSOR_DEFINITIONS`, `HEADER_SEARCH_PATHS` (relative to `ios/`), `CLANG_CXX_LANGUAGE_STANDARD`; `OTHER_CFLAGS`, `OTHER_LDFLAGS`, `OTHER_SWIFT_FLAGS` logged by name and ignored. Resources except `*.storyboard|*.xcassets|*.xib` are copied into the bundle; those three are skipped with one log line. Duplicate basenames among compiled sources → error.
- Metro: bare `npx react-native start --port <port>` (+ `--reset-cache` when clearing); Expo unchanged. "Metro URL for the dev launcher" printed only when `expo-dev-client` is installed.
- Commits: Conventional Commits in English, one logical change each, no body. Never use `--force` with git. No "WIP"/"temp"/"debug" words in commit messages.

## Review Focus

1. A bare project whose `app.json` has only `name`/`displayName` must be detected as bare (Task 1 test `treats the template app.json as no Expo config`).
2. A pbxproj with two application targets (e.g. app + watch companion) must fail with both names, not pick one silently (Task 2 test `rejects several application targets`).
3. A Swift file listed in the Sources phase that lives outside `ios/<target>/` (group path) must be found through the group tree, not a folder scan (Task 3 test `resolves files through nested groups`).
4. A hybrid project with `expo-modules-core` but a Podfile without `use_expo_modules!` builds without Expo modules (the plugin is inactive) and must say so instead of failing late (Task 4 test `warns when expo modules are installed but not set up in the Podfile`; doctor in Task 8).
5. `install` on a bare project must not print the dev-launcher URL, and `start` must not call `expo start` (Task 8 tests).

---

### Task 1: Project kinds, detection and the `ProjectInfo` type

**Files:**
- Create: `src/project/index.ts` (types + `readProject` dispatcher; the bare branch is wired in Task 4)
- Create: `src/project/detect.ts`
- Rename: `src/project.ts` → `src/project/expo.ts` (same exports; `readExpoProject` returns `ProjectInfo` with `kind: "expo"`)
- Modify: `src/config.ts` (`projectKind?: "expo" | "bare"`), every `../project.js` import → `../project/index.js`
- Test: `tests/project/detect.test.ts`, update `tests/project.test.ts` → `tests/project/expo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProjectKind = "expo" | "bare";
  export interface ProjectInfo {
    kind: ProjectKind; root: string; name: string; slug: string; version: string; buildNumber: string;
    bundleIdentifier: string; moduleName: string; iosTargetName: string; iosTargetDir: string;
    infoPlistPath: string;               // expo: ios/<target>/Info.plist; bare: from INFOPLIST_FILE (Task 4)
    rnVersion: string; sdkVersion?: number; hasExpoModules: boolean; hasExpoConstants: boolean;
    hasDevClient: boolean;
    bare?: BareTargetContent;            // declared in Task 3 (src/project/pbxproj.ts); Task 1 declares it as `unknown` and Task 3 tightens it
  }
  export type ExpoProject = ProjectInfo;  // alias kept for the migration
  export function detectProjectKind(root: string, override?: ProjectKind): ProjectKind;  // throws DetectError with the spec's messages
  export function isInstalled(root: string, pkg: string): boolean;  // require.resolve(`${pkg}/package.json`, { paths: [root] })
  export async function readProject(root: string, opts?: ReadProjectOptions): Promise<ProjectInfo>;
  ```
- `readExpoProject` fills `hasExpoModules: true`, `hasExpoConstants`/`hasDevClient` via `isInstalled`, `moduleName: "main"`, `rnVersion` from `react-native/package.json`.

- [ ] **Step 1: Write failing detection tests** in `tests/project/detect.test.ts`, each on a temp dir built from `tests/fixtures/project` (Expo) or a new `tests/fixtures/bare` (copied from the RN 0.88 template: `package.json`, `app.json`, `ios/HelloWorld.xcodeproj/project.pbxproj`, `ios/HelloWorld/{AppDelegate.swift,SceneDelegate.swift,Info.plist,PrivacyInfo.xcprivacy,LaunchScreen.storyboard}`, `ios/Podfile`; re-fetch with `npm pack @react-native-community/template@0.88.0`):
  - `detects an Expo project (expo dep + app.json with expo key)` → `"expo"`
  - `detects app.config.js as Expo` (expo dep, no app.json, `app.config.js`) → `"expo"`
  - `treats the template app.json as no Expo config` (bare fixture + `expo` added to dependencies) → `"bare"`
  - `detects the template as bare` → `"bare"`
  - `honours the projectKind override` → override `"expo"` on the bare fixture returns `"expo"`
  - `fails without ios and without expo config` → throws `/no ios\/ directory.*@react-native-community\/cli init/`
  - `fails with two xcodeproj` → throws naming both `.xcodeproj`
- [ ] **Step 2: Run** `npx vitest run tests/project/detect.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `detectProjectKind` in `src/project/detect.ts`; the config key in `src/config.ts`; move `src/project.ts` to `src/project/expo.ts` with `git mv`, make it return `ProjectInfo`, add `src/project/index.ts` exporting the types, `MissingBundleIdentifierError`, `defaultBundleIdentifier`, `isInstalled`, `readProject` (for now: `expo` → `readExpoProject`, `bare` → `throw new Error("bare projects: not wired yet")`). Update imports in `src/commands/*.ts`, `src/generate/iosXtool.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/project && npx tsc --noEmit -p . && npm run lint` → all PASS (existing `tests/project.test.ts` moved, still green).
- [ ] **Step 5: Commit** `git add -A src tests && git commit -m "feat: detect expo and bare project kinds"`

### Task 2: pbxproj reader — targets and build settings

**Files:**
- Create: `src/project/pbxproj.ts`
- Modify: `package.json` (`"xcode": "^4.0.0"` in dependencies; `npm i xcode@^4.0.0`)
- Test: `tests/project/pbxproj.test.ts`, fixtures `tests/fixtures/bare/ios/HelloWorld.xcodeproj/project.pbxproj` (from Task 1) and `tests/fixtures/pbxproj/two-apps.pbxproj` (the same file with the application target duplicated under a second name)

**Interfaces:**
- Produces:
  ```ts
  export interface PbxTarget { name: string; uuid: string; productType: string }
  export interface Pbxproj { path: string; projectName: string; appTarget: PbxTarget; targets: PbxTarget[]; project: any /* xcode.project */ }
  export function openPbxproj(iosDir: string): Pbxproj;            // finds the single *.xcodeproj; errors per spec
  export function buildSetting(p: Pbxproj, key: string, configuration?: string /* default "Debug" */): string | undefined; // target then project level, raw
  export function resolveSetting(p: Pbxproj, key: string, configuration?: string): string | undefined;  // resolved, see Global Constraints
  export function resolveBuildSettingValue(value: string, lookup: (key: string) => string | undefined): string; // pure resolver; throws on leftover $(
  ```
- Uses `xcode`: `xcode.project(file).parseSync()`, `pbxNativeTargetSection()`, `getBuildProperty(key, configuration, targetName)` for target level; project level through `pbxXCBuildConfigurationSection()` + the project's `buildConfigurationList`.

- [ ] **Step 1: Write failing tests** in `tests/project/pbxproj.test.ts`:
  - `finds the application target of the template` → `appTarget.name === "HelloWorld"`, `projectName === "HelloWorld"`
  - `reads raw target settings` → `buildSetting(p, "INFOPLIST_FILE") === "HelloWorld/Info.plist"`, `buildSetting(p, "IPHONEOS_DEPLOYMENT_TARGET") === "15.1"`
  - `resolves the template bundle id` → `resolveSetting(p, "PRODUCT_BUNDLE_IDENTIFIER") === "org.reactjs.native.example.HelloWorld"`
  - `resolves rfc1034identifier` → `resolveBuildSettingValue("x.$(PRODUCT_NAME:rfc1034identifier)", k => k === "PRODUCT_NAME" ? "My App_1" : undefined) === "x.My-App-1"`
  - `falls back to the project level` → a setting only in the project configuration is returned
  - `ignores xcconfig base configurations` → opening the template (which has `baseConfigurationReference` to Pods xcconfig files that do not exist) does not throw
  - `rejects an unknown variable` → `resolveBuildSettingValue("$(FOO)", () => undefined)` throws `/FOO/`
  - `rejects several application targets` → `openPbxproj` on `two-apps` fixture throws naming both target names
  - `rejects several xcodeproj` → dir with two `.xcodeproj` throws naming both
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/project/pbxproj.ts` (install `xcode`; add `declare module "xcode"` in `src/types/xcode.d.ts` if no types ship).
- [ ] **Step 4: Run** `npx vitest run tests/project/pbxproj.test.ts && npx tsc --noEmit -p . && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add package.json package-lock.json src/project/pbxproj.ts src/types tests/project/pbxproj.test.ts tests/fixtures && git commit -m "feat: read bundle settings from the pbxproj"`

### Task 3: pbxproj reader — app target content from build phases

**Files:**
- Modify: `src/project/pbxproj.ts`
- Test: `tests/project/pbxproj.test.ts`, fixture `tests/fixtures/pbxproj/with-objc.pbxproj` (template + `NativeModule.m`, `NativeModule.h` in a nested group `Native/`, a `Fonts/Inter.ttf` resource, `SWIFT_OBJC_BRIDGING_HEADER = HelloWorld/HelloWorld-Bridging-Header.h`, `GCC_PREPROCESSOR_DEFINITIONS = "$(inherited) FOO=1"`, `HEADER_SEARCH_PATHS = "$(inherited) Vendor/include"`, `OTHER_CFLAGS = -Wall`)

**Interfaces:**
- Produces:
  ```ts
  export interface TargetFile { absPath: string; relPath: string /* relative to ios/ */ }
  export interface BareTargetContent {
    swiftSources: TargetFile[]; cSources: TargetFile[]; headers: TargetFile[];
    resources: TargetFile[]; skippedResources: TargetFile[];      // storyboard/xcassets/xib
    bridgingHeader?: TargetFile; defines: string[]; headerSearchPaths: string[] /* absolute */;
    cxxStandard?: string; ignoredSettings: string[];               // names of set-but-unmapped settings
    mixed: boolean;                                               // cSources.length > 0
  }
  export function readTargetContent(p: Pbxproj, iosDir: string): BareTargetContent;  // throws on duplicate compiled basenames
  ```
- File paths resolve through the PBXGroup tree: a file's path is the concatenation of its ancestor groups' `path` values (relative to `ios/` unless `sourceTree` is absolute); the `xcode` package exposes `hash.project.objects.PBXGroup`, `PBXFileReference`, `PBXBuildFile`, `PBXSourcesBuildPhase`, `PBXResourcesBuildPhase`.

- [ ] **Step 1: Write failing tests**:
  - `lists the template sources and resources` → swift `["HelloWorld/AppDelegate.swift","HelloWorld/SceneDelegate.swift"]`, `cSources: []`, `resources` contains `HelloWorld/PrivacyInfo.xcprivacy`, `skippedResources` contains `HelloWorld/LaunchScreen.storyboard` and `HelloWorld/Images.xcassets`, `mixed === false`
  - `resolves files through nested groups` → `with-objc`: `cSources` has `HelloWorld/Native/NativeModule.m`, `headers` has `HelloWorld/Native/NativeModule.h`, `mixed === true`
  - `maps the mixed-target settings` → `bridgingHeader.relPath === "HelloWorld/HelloWorld-Bridging-Header.h"`, `defines` equals `["FOO=1"]`, `headerSearchPaths` equals `[<ios>/Vendor/include]`, `ignoredSettings` equals `["OTHER_CFLAGS"]`
  - `rejects duplicate compiled basenames` → fixture variant with `A/Foo.swift` and `B/Foo.swift` throws `/Foo\.swift/`
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `readTargetContent`.
- [ ] **Step 4: Run** tests, tsc, lint → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: read app target sources and resources from the pbxproj"`

### Task 4: Bare project reader and the dispatcher

**Files:**
- Create: `src/project/bare.ts`
- Modify: `src/project/index.ts` (wire `bare`)
- Test: `tests/project/bare.test.ts`

**Interfaces:**
- Produces: `export async function readBareProject(root: string, opts?: ReadProjectOptions): Promise<ProjectInfo>`:
  - `name = PRODUCT_NAME` (fallback: target name); `slug = name`; `moduleName`: the `name` field of the root `app.json` when present, else `name`; `version = MARKETING_VERSION ?? "1.0"`; `buildNumber = CURRENT_PROJECT_VERSION ?? "1"`; `bundleIdentifier = resolveSetting("PRODUCT_BUNDLE_IDENTIFIER")` (missing → `MissingBundleIdentifierError(defaultBundleIdentifier(name), "project.pbxproj")`, never written); `iosTargetName = appTarget.name`; `iosTargetDir = ios/<INFOPLIST_FILE dirname>`; `rnVersion` from `react-native/package.json`, `< 0.88` → error `React Native ${v} is not supported; expo-xtool requires 0.88 or newer`; `hasExpoModules = isInstalled("expo-modules-core")` (then `expo` required, see Global Constraints); `hasExpoConstants`, `hasDevClient` via `isInstalled`; `bare = readTargetContent(...)`.
  - When `hasExpoModules` and `ios/Podfile` exists without `use_expo_modules!` → `opts.log?.("⚠ expo-modules-core is installed but ios/Podfile has no use_expo_modules!: Expo's SwiftPM plugin stays inactive, so Expo modules are not built. Run npx install-expo-modules.")` and set `hasExpoModules = false`.
  - `infoPlistPath: string` added to `ProjectInfo` (expo: `ios/<target>/Info.plist`, bare: from `INFOPLIST_FILE`).

- [ ] **Step 1: Write failing tests** on temp copies of `tests/fixtures/bare` (add `node_modules/react-native/package.json` with `"version": "0.88.0"` to the fixture; a variant with `0.87.0`; a hybrid variant adding `node_modules/expo-modules-core/package.json` + `node_modules/expo/package.json` and a Podfile with/without `use_expo_modules!`):
  - `reads the template` → `kind "bare"`, `name "HelloWorld"`, `bundleIdentifier "org.reactjs.native.example.HelloWorld"`, `moduleName "HelloWorld"`, `version "1.0"`, `buildNumber "1"`, `infoPlistPath` ends with `ios/HelloWorld/Info.plist`, `hasExpoModules false`, `bare.swiftSources.length === 2`
  - `rejects react-native below 0.88` → throws `/0\.87\.0.*0\.88/`
  - `detects the hybrid shape` → `hasExpoModules true` when Podfile has `use_expo_modules!`
  - `warns when expo modules are installed but not set up in the Podfile` → `hasExpoModules false`, log called with `/use_expo_modules!/`
  - `requires expo next to expo-modules-core` → throws `/install-expo-modules/`
  - `readProject dispatches on kind` → Expo fixture → `kind "expo"`, bare fixture → `kind "bare"`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** tests, tsc, lint → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: read bare React Native projects"`

### Task 5: Bundled patch selection by installed package

**Files:**
- Modify: `src/pipeline/patches.ts`, `src/paths.ts` (`patchesDir: join(iosXtool, ".patches")`)
- Test: `tests/patches.test.ts`

**Interfaces:**
- Produces: `export function selectBundledPatches(projectRoot: string, bundledDir: string): string[]` (file names whose `parsePatchFileName(...).pkg` has `installedVersion(projectRoot, pkg) !== undefined`); `export async function stageBundledPatches(projectRoot: string, dest: string): Promise<string[]>` (empties `dest`, symlinks the selected files, returns them); `applyPatchesArgv(projectRoot, patchDir)` takes the staged dir (relative to the project) instead of the package's `patches/`. `applyPatches` stages first; when no bundled patch applies it skips patch-package for the bundled set and goes straight to the project's patches.

- [ ] **Step 1: Write failing tests**: `selects only patches whose package is installed` (temp project with `node_modules/react-native/package.json` only → `["react-native+0.88.0.patch"]`); `stages the selection as symlinks`; `applyPatches skips bundled patches when none apply` (exec mock never called with the bundled dir); existing mismatch-message tests still pass.
- [ ] **Step 2–4:** red → implement → `npx vitest run tests/patches.test.ts`, tsc, lint green.
- [ ] **Step 5: Commit** `git commit -m "feat: apply bundled patches only for installed packages"`

### Task 6: Bare React Native SwiftPM pipeline without the xcodeproj

**Files:**
- Create: `scripts/rn-spm-generate.js` (CommonJS, Node 20; `require()`s the project's React Native `scripts/spm/*` modules)
- Modify: `src/pipeline/rnSpm.ts`
- Test: `tests/rnSpm.test.ts`, `tests/rn-spm-generate.test.ts`

**Interfaces:**
- `node scripts/rn-spm-generate.js --rn-dir <abs> --app-root <abs> [--artifacts <root>] [--config-command <json>]` performs, mirroring `setup-apple-spm.js` `main` for `add` without `setupXcodeproj` (read `node_modules/react-native/scripts/setup-apple-spm.js` lines ~1130–1320 for the exact calls and argument shapes): (1) autolinking config via `generate-spm-autolinking-config.js`, (2) `sync-spm-autolinking.js` `main([...])` (codegen, autolinking `Package.swift`, header farm), (3) `ensureBothArtifactFlavors` equivalent: `download-spm-artifacts.js` for `debug` and `release` into `spm-utils.defaultCacheDir(version, flavor)` unless `--artifacts` gives `{debug,release}`, (4) `generate-spm-package.js` `main([... '--debug-artifacts-dir', ..., '--release-artifacts-dir', ...])`. Exit codes: 0 ok; 2 when the autolinker reported missing manifests (RN's `MissingManifestError`), so `runRnSpm`'s existing scaffold detection keeps working from the output.
- Produces in `rnSpm.ts`: `export function rnSpmGenerateArgs(paths, opts: { rnArtifactsDir?: string }, rnDir: string): string[]`; `runRnSpm(paths, opts, deps)` gains `opts.kind: ProjectKind` and runs `rnSpmGenerateArgs` for `bare` (the scaffold fallback uses `scaffoldArgv` as today: `scaffold` needs no xcodeproj).

- [ ] **Step 1: Write failing tests**: `rnSpmGenerateArgs points at the driver with the artifacts flags` (contains `scripts/rn-spm-generate.js`, `--rn-dir`, `--app-root`, and `--artifacts <dir>` only when `rnArtifactsDir` is set); `runRnSpm uses the generate driver for bare and setup-apple-spm for expo` (runner mock records argv); `the driver script parses its arguments` (spawn with `--help`-like bad args → exit 1 with usage).
- [ ] **Step 2–4:** red → implement → green (`npx vitest run tests/rnSpm.test.ts tests/rn-spm-generate.test.ts`).
- [ ] **Step 5:** Functional check against a real bare project (heavy, run once): create `/tmp`-free scratch `BareProbe` with `npx @react-native-community/cli init BareProbe --version 0.88.0 --skip-install` then `npm install`, run `node <repo>/scripts/rn-spm-generate.js --rn-dir <app>/node_modules/react-native --app-root <app>` from `<app>/ios`; expected: `ios/build/generated/autolinking/Package.swift`, `ios/build/xcframeworks/flavored-frameworks.json` exist, `git status` of the app shows only `ios/build/` (ignored) changed, and `ios/HelloWorld.xcodeproj/project.pbxproj` is byte-identical.
- [ ] **Step 6: Commit** `git add scripts/rn-spm-generate.js src/pipeline/rnSpm.ts tests && git commit -m "feat: run the RN SwiftPM pipeline without the xcodeproj"`

### Task 7: Generating `ios-xtool/` for bare projects (mixed App target)

**Files:**
- Modify: `src/generate/packageSwift.ts`, `src/generate/iosXtool.ts`, `src/generate/xtoolYml.ts`
- Test: `tests/generate.test.ts`

**Interfaces:**
- `PackageSwiftInput` gains: `expo?: { compileInterfacesDir: string; clangImporter?: ClangImporterInputs; jsiHeaders: boolean }` (replaces the always-on Expo pieces: the `ExpoModulesJSIHeaders` package/product, `-F compileInterfaces`, the `EXPO_CONFIGURATION_*` defines are emitted only when `expo` is set) and `app: { mixed: boolean; bridgingHeader?: string /* abs */; defines: string[]; headerSearchPaths: string[]; cxxStandard?: string; resources: string[] /* paths relative to Sources/App, e.g. "Resources/PrivacyInfo.xcprivacy" */ }`.
- `renderPackageSwift(i)` returns `{ manifest: string; manifest65?: string }`: when `app.mixed`, `manifest` starts with `// swift-tools-version: 6.4;(experimentalMultiLang)` and `manifest65` is the same text with `// swift-tools-version: 6.5` and the App target unchanged (SE-0541); `swiftSettings` adds `.unsafeFlags(["-import-objc-header", <bridgingHeader>])` when set, `.define(...)` per entry of `defines` (`KEY=VALUE` → `.define("KEY", to: "VALUE")`), `cSettings`/`cxxSettings` with `.headerSearchPath` for each search path and `.unsafeFlags(["-I", <RN_SPM swift headers dir>])` so Objective-C can `#import "App-Swift.h"`; `cxxLanguageStandard` from `cxxStandard` (`gnu++20` → `.gnucxx20`, default `.cxx20`); `resources: [.copy("Resources")]` when resources exist. Not mixed → `// swift-tools-version: 6.0` as today.
- `writeIosXtool(ctx)`: for `bare`, copies `bare.swiftSources`, `cSources`, `headers` into `Sources/App/<relPath under iosTargetDir>` (headers also under `Sources/App/include/`), resources into `Sources/App/Resources/`, logs one line for `skippedResources` and one for `ignoredSettings`; Expo pieces (ExpoModulesProvider link, compile-interfaces, importer, JSI headers) only when `project.hasExpoModules`; `Info.plist` read from `project.infoPlistPath`; `renderXtoolYml` resources: `["Frameworks","ip.txt"]` + `"EXConstants.bundle"` only when `project.hasExpoConstants`.

- [ ] **Step 1: Write failing tests** in `tests/generate.test.ts`: `renders the Swift-only bare manifest` (no `ExpoModulesJSIHeaders`, no `EXPO_CONFIGURATION`, tools-version 6.0, no `manifest65`); `renders the mixed manifest pair` (6.4 flag header, `-import-objc-header`, `.define("FOO", to: "1")`, `.headerSearchPath`, `manifest65` has `swift-tools-version: 6.5` and no `experimentalMultiLang`); `keeps the Expo manifest unchanged` (snapshot equality with the current output for an expo input); `writeIosXtool copies bare sources and resources` (temp project from the `with-objc` fixture layout: files land under `Sources/App/...`, `Sources/App/Resources/Fonts/Inter.ttf`, `Package@swift-6.5.swift` written, no `ExpoModulesProvider.swift`, `xtool.yml` without `EXConstants.bundle`, log mentions `LaunchScreen.storyboard`).
- [ ] **Step 2–4:** red → implement → green (`npx vitest run tests/generate.test.ts`, tsc, lint).
- [ ] **Step 5: Commit** `git commit -m "feat: generate ios-xtool for bare projects with a mixed App target"`

### Task 8: Wiring build, start, install, doctor by project kind

**Files:**
- Modify: `src/commands/build.ts`, `src/commands/start.ts`, `src/commands/install.ts`, `src/commands/doctor.ts`, `src/commands/run.ts` (passes kind through if needed)
- Test: `tests/build.test.ts`, `tests/start.test.ts`, `tests/install.test.ts`, `tests/doctor.test.ts`

**Interfaces:**
- `build.ts`: `buildSteps(state: { kind: ProjectKind; hasIos: boolean; clean: boolean; hasExpoModules: boolean; hasExpoConstants: boolean }): string[]` → expo: as today; bare: never `prebuild`; `jsi` only when `hasExpoModules`; `app-config` only when `hasExpoConstants`. `readProject` dep becomes `readProject` from `src/project/index.js`; `runRnSpm(paths, { rnArtifactsDir, kind })`; frameworks list includes the JSI framework only when `jsi` ran; `--clean` on bare removes `ios/build` and `ios-xtool` instead of prebuild.
- `start.ts`: `export function metroCommand(kind: ProjectKind, port: number, clear: boolean): [string, string[]]` → bare `["npx", ["react-native", "start", "--port", String(port), ...(clear ? ["--reset-cache"] : [])]]`; expo as today. `BuildState` gains `kind?: ProjectKind` (written by `build`, read by `start`/`install`; missing → `"expo"`).
- `install.ts`: the dev-launcher line only when `state.hasDevClient === true` (new optional `BuildState.hasDevClient`, written by `build` from `project.hasDevClient`).
- `doctor.ts`: new `project` check (`ok`: `bare React Native 0.88.0, target HelloWorld (HelloWorld.xcodeproj)` / `expo SDK 58, React Native 0.88.0` / `bare + expo modules`; `warn` for the Podfile-without-`use_expo_modules!` case; `fail` with the detect/read error message); `expo-sdk` check renamed to `project-config` and run for both kinds (bundle id warning stays).

- [ ] **Step 1: Write failing tests**: `buildSteps` table (`bare` pure → no prebuild/jsi/app-config; hybrid → jsi, app-config only with constants; expo unchanged); `build passes the kind to runRnSpm and skips prebuild for bare` (deps mocks); `metroCommand` for both kinds incl. `--reset-cache`; `start runs react-native start for a bare state`; `install does not print the dev launcher URL when hasDevClient is false` and prints it when true; doctor `project` check texts for the three shapes.
- [ ] **Step 2–4:** red → implement → `npm test` green, tsc, lint.
- [ ] **Step 5: Commit** `git commit -m "feat: drive build, start, install and doctor by project kind"`

### Task 9: Bare reference app on the iPhone (pure template)

**Files:**
- Create: `../app-bare` (own git repo, like `app/`): `npx @react-native-community/cli init BareDemo --version 0.88.0 --skip-install --directory app-bare`, `npm install`, `expo-xtool.config.json` with `{ "metroPort": 8082 }` (8081 is held by Docker on this machine), `App.tsx` showing a "Bare RN on Linux" title. Commit `chore: bare React Native 0.88 reference app`.
- Uses the worktree CLI: `node ../expo-xtool-bare/bin/expo-xtool.js <cmd>` from `app-bare/` (after `npm run build` in the worktree).

- [ ] **Step 1:** `doctor` → `project` check reports `bare React Native 0.88.0, target BareDemo`.
- [ ] **Step 2:** `build` → exit 0; `ios-xtool/xtool/App.app` exists; `git -C app-bare status --short` shows only `ios-xtool/` (ignored) and `expo-xtool.config.json`/`App.tsx`; `ios/BareDemo.xcodeproj/project.pbxproj` unchanged (`git diff --quiet -- ios`).
- [ ] **Step 3:** `install --network 192.168.1.10` (iPhone unlocked, same Wi‑Fi) → `Installed XTL-….org.reactjs.native.example.BareDemo` and **no** dev-launcher line.
- [ ] **Step 4:** `start` → `react-native start --port 8082`; Willy opens the app: the title renders; edit `App.tsx` → Fast Refresh. Record timings in the ledger.
- [ ] **Step 5:** Fix anything found through the normal red/green loop in the owning task's files; commit each fix separately (`fix: …`).

### Task 10: Local Objective-C native module in the bare app (mixed App target)

**Files:**
- In `app-bare` (branch `feature/local-objc-module`): `ios/BareDemo/Native/HelloModule.h|.m` (`RCT_EXPORT_MODULE()` with `RCT_EXPORT_METHOD(greet:(NSString *)name resolver:… rejecter:…)` returning `"Hello, <name> (ObjC)"`), `ios/BareDemo/BareDemo-Bridging-Header.h` importing `Native/HelloModule.h`, `ios/BareDemo/Greeter.swift` (`@objc(Greeter) class` with `RCT_EXPORT_MODULE` via `@objc static func moduleName()`, returning `"Hello from Swift"`), both added to the pbxproj Sources phase and `SWIFT_OBJC_BRIDGING_HEADER` set (edit the pbxproj by hand or with the `xcode` package in a one-off script; commit the result). `App.tsx` calls both through `NativeModules` and shows the strings.

- [ ] **Step 1:** `build` → the generated `ios-xtool/Package.swift` starts with `// swift-tools-version: 6.4;(experimentalMultiLang)`, `Package@swift-6.5.swift` exists, build exit 0.
- [ ] **Step 2:** `install --network` + `start`; Willy confirms both greetings render.
- [ ] **Step 3:** Fixes as in Task 9, step 5.

### Task 11: Library matrix on the bare app

**Files:**
- `app-bare` branches `feature/lib-<name>` stacked like `app/`: react-native-screens, react-native-gesture-handler, react-native-reanimated + react-native-worklets, react-native-svg, react-native-webview, @react-native-community/datetimepicker; `App.tsx` exercises each (same demos as `app/App.tsx`). Scaffolded `Package.swift` patches persist to `app-bare/patches/` as with Expo; commit them.
- Modify: `docs/libraries.md` (new `bare` column with the result per library).

- [ ] **Step 1:** per library: `npm i <lib>`, `run --network` (rebuild + reinstall + Metro with `--reset-cache`), Willy confirms the demo on the iPhone; note build time.
- [ ] **Step 2:** Any failure is a generic fix in `patches/react-native+0.88.0.patch` (scaffolder) through the usual red/green loop in the worktree, never a per-library branch in the tool.
- [ ] **Step 3: Commit** `docs: bare results in the library matrix`.

### Task 12: Hybrid shape (Expo modules in a bare app)

**Files:**
- `app-bare` branch `feature/hybrid-expo-modules`: `npx install-expo-modules@latest` (adds `expo`, `expo-modules-core`, `use_expo_modules!` to the Podfile and `ExpoModulesProvider` wiring), `npx expo install expo-haptics`; `App.tsx` adds a haptics button.

- [ ] **Step 1:** `doctor` → `project` says `bare + expo modules`; `build` runs `jsi` and (if `expo-constants` is present) `app-config`; the autolinking manifest references `expo-source` packages (the plugin ran); exit 0.
- [ ] **Step 2:** `install --network` + `start`; Willy confirms the haptic feedback.
- [ ] **Step 3:** Fixes through the owning tasks' files; commit separately.

### Task 13: Docs and the clean-machine harness

**Files:**
- Modify: `README.md` (intro: "Expo SDK 58+ and bare React Native 0.88+"; Requirements; new section "Bare React Native projects": detection, what is read from the pbxproj, mapped/ignored settings, mixed App target, resources, hybrid shape, limits; Metro command), `docs/recipe.md` (bare notes), `docs/libraries.md` (done in Task 11), `e2e/clean-machine/e2e.sh` (`project --bare [name]` → `npx @react-native-community/cli init <name> --version 0.88.0`), `package.json` description/keywords (`react-native`).
- Test: `npm run lint`, `npm run scan:private`, `bash -n e2e/clean-machine/e2e.sh`.

- [ ] **Step 1:** Write the docs and the harness change.
- [ ] **Step 2:** Run lint, scan, `bash -n` → clean.
- [ ] **Step 3: Commit** `docs: document bare React Native support` and `chore: bare project option in the e2e harness`.

### Task 14: Clean-machine run for bare

- [ ] **Step 1:** With the harness (`E2E_NAME=expo-xtool-e2e-bare`): `up`, `install <packed tgz of the worktree>`, `setup`, `auth`, `project --bare demo`, then `sh "expo-xtool run --network 192.168.1.10"`; Willy confirms the app on the iPhone; `down` afterwards (disk).
- [ ] **Step 2:** Record the result in the PR body; fixes go through the owning tasks.
