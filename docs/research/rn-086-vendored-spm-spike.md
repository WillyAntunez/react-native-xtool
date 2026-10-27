# Spike: bare React Native 0.86.3 on rn-xtool through RN 0.88.0's SwiftPM scripts

Date: 2026-10-26, about 20:52 to 21:10 local (the time box was barely used).
Throwaway. No commits anywhere. The main rn-xtool `dist/` was never edited (checksums below).

## Verdict

**Yes, it builds.** `spike-bare-086/ios-xtool/xtool/App.app` exists. It is 78 MB with only safe-area-context and 81-82 MB after adding react-native-screens. It embeds RN 0.86.3's own `React.framework` binary (md5 matches the 0.86.3 slot, not 0.88's), `ReactNativeDependencies.framework` and `hermesvm.framework` (hermes 250829098.0.17).
It has not been run on a device yet. Install, Metro and launch are still untested.

Most of the work was *not* in the scripts. It was in the **artifacts**. 0.86.3's Maven tarballs come before the "headers-spec" layout that 0.88's scripts require: there is no `ReactNativeHeaders.xcframework` and no `ReactNativeDependenciesHeaders.xcframework`. The React headers sit in per-pod dirs inside `React.framework/Headers` and are mapped by a clang VFS overlay (`React-VFS-template.yaml`). An adapter script (about 150 lines, `spike-bare-086/.spike/adapt-086-artifacts.js`) turns a 0.86.3 slot into a 0.88-shaped slot using **only 0.86.3's own headers**. After that, the 0.88 pipeline, rn-xtool's generator and xtool all ran without further changes.

## Paths (all throwaway)

- Spike app: `../spike-bare-086`
- Vendored 0.88.0 scripts (patched, from the Expo reference app): `spike-bare-086/.spm-vendored/scripts/{setup-apple-spm.js,spm/,codegen/templates/Package.swift.spm-template}`; pristine copy for diffing: `spike-bare-086/.spm-vendored.orig/`
- Spike driver: `spike-bare-086/.spike/rn-spm-generate.js`
- Artifact adapter: `spike-bare-086/.spike/adapt-086-artifacts.js`; adapted slots: `spike-bare-086/.spike/artifacts/{debug,release}`
- Spike copy of the rn-xtool CLI: `spike-bare-086/.spike/rnx/` (dist/bin/package.json/shims/scripts/patches copied, `node_modules` symlinked to the main checkout's)
- Raw 0.86.3 slots downloaded by the vendored downloader: `~/Library/Caches/ReactNative/spm-artifacts/0.86.3/{debug,release}` (1.3 GB; 0.88's scripts use `~/Library/Caches/ReactNative` on Linux too)
- Logs: the scratchpad (`init086.log`, `run1.log`, `run2.log`, `dl-release.log`, `build1.log`, `build2.log`) under `<scratch>/`

## Steps, commands, outcomes

### 1. Create the app: OK
`npx --yes @react-native-community/cli@latest init SpikeBare086 --version 0.86.3 --install-pods false --skip-git-init --directory spike-bare-086` exited 0. The template pins `react-native@0.86.3` itself (no manual pin needed), with `@react-native-community/cli` 20.1.0, React 19.2.3 and hermes-compiler 250829098.0.17. node_modules is 324 MB.
`rn-xtool.config.json`: `{ "metroPort": 8082 }`. For the build, `rnArtifactsDir` was added (step 4).

Template iOS shape:
- **AppDelegate.swift only**, no SceneDelegate. It imports `React`, **`React_RCTAppDelegate`** and `ReactAppDependencyProvider`, and uses `RCTReactNativeFactory` + `RCTDefaultReactNativeFactoryDelegate`. (0.88's template has AppDelegate + SceneDelegate and imports only React.)
- `IPHONEOS_DEPLOYMENT_TARGET = 15.1`, `SWIFT_VERSION = 5.0`, `CLANG_CXX_LANGUAGE_STANDARD = c++20`, bundle id `org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)`.
- Podfile present, not installed. LaunchScreen.storyboard and Images.xcassets: rn-xtool skips them, the same as for 0.88.
- The template already depends on `react-native-safe-area-context` ^5.5.2 (5.10.1 installed), which **ships its own Package.swift**.

### 2. Vendor + driver: OK
I copied `app/node_modules/react-native/scripts/setup-apple-spm.js`, `scripts/spm/` and `scripts/codegen/templates/Package.swift.spm-template` into `.spm-vendored/scripts/`.

The driver is a copy of `scripts/rn-spm-generate.js` with one change. `rn = rel => require(<VENDORED>/scripts/rel)` replaces `require(<rnDir>/scripts/rel)`, and `process.env.SPIKE_RN_ROOT = cli.rnDir` is set. `--rn-dir` stays the installed 0.86.3 package and is passed on unchanged as `--react-native-root`, so codegen, `determineVersion` and hermes resolution all see 0.86.3.

How the vendored scripts find RN, and what I decided for each:

| Lookup | Where | Resolves to | Decision |
|---|---|---|---|
| `determineVersion(args, rnRoot, appRoot)` | setup-apple-spm.js | `<--rn-dir>/package.json`, i.e. 0.86.3 | keep (correct) |
| codegen `node <rnRoot>/scripts/generate-codegen-artifacts.js -p <project> -t ios` | spm-utils.js `runCodegenAndInstallTemplate` | **0.86.3's codegen** (the entry point exists in 0.86 at the same path) | keep (the codegen must match the installed RN) |
| `<rnRoot>/scripts/codegen/templates/Package.swift.spm-template` | spm-utils.js `installSpmCodegenTemplate` | missing in 0.86.3 (warning: "SPM codegen template missing ... was NOT corrected") | **redirected to the vendored copy** (edit E1) |
| `__dirname/../../package.json` (`REACT_NATIVE_{MAJOR,MINOR,PATCH}_VERSION` macros for scaffolded manifests, our patch fix 8) | read-podspec.js `readRnVersionMacros` | `.spm-vendored/package.json` (absent, so the macros are silently dropped) | **redirected to 0.86.3 via `SPIKE_RN_ROOT`** (edit E2) |
| `__dirname/../..` (RN version fallback + `require.resolve('hermes-compiler', {paths:[rnRoot]})`) | download-spm-artifacts.js `main` | `.spm-vendored/` (only works by accident, through node's upward walk into the app's node_modules) | **redirected to 0.86.3 via `SPIKE_RN_ROOT`** (edit E3) |
| `resolveReactNativeRoot` default `__dirname/..` | setup-apple-spm.js | not used by the driver | n/a |
| `require('yargs')`, `require('micromatch')` | several | resolved upward from `.spm-vendored/` to the app's node_modules: yargs 17.7.3, micromatch 4.0.8 (same versions as in the 0.88 Expo app) | keep (works by accident; a real implementation must pin these) |
| codegen internals (`scripts/codegen/generate-artifacts-executor/*`) | only through the codegen subprocess | 0.86.3 | keep |

Edits to the vendored copy (the whole diff against `.spm-vendored.orig`):
- **E1** `spm/spm-utils.js` `installSpmCodegenTemplate`: `path.join(reactNativeRoot,'scripts','codegen','templates',...)` becomes `path.join(__dirname,'..','codegen','templates',...)`.
- **E2** `spm/read-podspec.js` `readRnVersionMacros`: `path.join(__dirname,'..','..','package.json')` becomes `path.join(process.env.SPIKE_RN_ROOT ?? <same>, 'package.json')`.
- **E3** `spm/download-spm-artifacts.js` `main`: `rnRoot = path.resolve(__dirname,'../..')` becomes `process.env.SPIKE_RN_ROOT ?? <same>`.

No other script edits were needed. All 13 rn-xtool scaffolder fixes stayed in place unchanged.

### 3. Pipeline steps
Command (from `ios/`, with `shims/` and swiftly on PATH and `RN_SPM_SWIFT_HEADERS_DIR` set the way rnSpm.ts sets it):
`node ../.spike/rn-spm-generate.js --rn-dir <app>/node_modules/react-native --app-root <app> [--artifacts <app>/.spike/artifacts]`

| Step | Outcome |
|---|---|
| a. autolinking config (`npx react-native config`, CLI 20.1.0; and `generateAutolinkingConfig`) | OK: `reactNativeVersion: "0.86"`, one dep (safe-area-context), `project.ios.xcodeProject = SpikeBare086.xcodeproj` |
| `resolveAppIosDeploymentTarget` | OK: 15.1 from the pbxproj |
| `determineVersion` | OK: 0.86.3 |
| b. sync: codegen | OK: **0.86.3 codegen** wrote `build/generated/ios/{ReactCodegen,ReactAppDependencyProvider}` + its own CocoaPods-era `Package.swift` |
| b. sync: SPM codegen template | Run 1: **FAIL (soft)**, the warning that the template is missing in 0.86.3, which leaves codegen's mis-rooted Package.swift in place. With E1: OK, "Installed SPM codegen template" |
| b. sync: autolinking Package.swift | OK: safe-area-context is "Self-managed (using its own Package.swift)"; `Autolinked` gets `.iOS("15.1")` |
| b. sync: per-app header farm | OK: "Built per-app header tree (42 headers)" (`ReactAppHeaders`) |
| c. artifacts, download mode (run 1, no `--artifacts`) | Downloads OK. URLs came from **repo.reactnative.dev** first (0.88's mirror-first logic; 0.86.3 is on the mirror), and Hermes 250829098.0.17 from the locally pinned hermes-compiler. Then **FAIL**: `ReactNativeHeaders.xcframework is missing from the artifact slot. The React core tarball predates the headers-spec layout — use a matching react-native version, or pass --headers-tarball / RN_HEADERS_TARBALL_PATH.` The log also says `ReactNativeDependenciesHeaders.xcframework not present in the rndeps tarball (pre-companion artifact)`. Cause: see "Artifact differences". No standalone headers tarballs exist for 0.86.3: `react-native-artifacts-0.86.3-reactnative-headers-debug.tar.gz` and `...-reactnative-dependencies-headers-debug.tar.gz` are 404 on both Central and repo.reactnative.dev (both are 200 for 0.88.0). The release slot was fetched separately with `node .spm-vendored/scripts/spm/download-spm-artifacts.js --version 0.86.3 --flavor release --output ~/Library/Caches/ReactNative/spm-artifacts/0.86.3/release`, which fails at the same point after extracting |
| c'. **workaround**: `node .spike/adapt-086-artifacts.js <0.86.3 slot> .spike/artifacts/<flavor> <0.88.0 slot>` for debug and release | OK (see below) |
| c. artifacts, offline (`--artifacts .spike/artifacts`, i.e. `downloadPolicy: 'skip'`) | OK: "Using debug/release artifacts (--download skip)" |
| d. generate-spm-package | OK: `build/xcframeworks/Package.swift`, `ReactHeadersTarget/include/React` (from the adapted flat React headers), `flavored-frameworks.json`, debug/release symlink dirs |
| e. finalizeArtifactPublication | OK. The whole driver run takes 2.2 s |

What the adapter does, per flavor. It uses only 0.86.3 content, except for format-only templates taken from the 0.88 slot:
1. It parses `React.xcframework/React-VFS-template.yaml` (1178 file mappings: virtual `Headers/<ns>/<file>` to physical `Headers/<Pod>/<ns>/<file>`) and materializes that virtual tree. VFS fallthrough is emulated by also copying real files under top-level dirs that are also virtual names.
2. **React.xcframework**: a copy where each slice's `React.framework` keeps its 0.86.3 binary/Info.plist (hard links). `Headers/` becomes the flat virtual `React/` dir (362 headers; 0.88 has 325). `React-umbrella.h` becomes 0.86.3's own `React_Core/React_Core-umbrella.h`. `Modules/module.modulemap` becomes `framework module React { umbrella header "React-umbrella.h" export * module * { export * } }`. The `_CodeSignature` is dropped; Linux SwiftPM did not care.
3. **ReactNativeHeaders.xcframework**: the virtual tree minus `React/`, plus `hermes/` from the 0.86.3 Hermes tarball (`hermes-headers/hermes`). Its `module.modulemap` is 0.88.0's map with the 4 header lines dropped (per slice) that 0.86.3 does not ship. The empty `libReactNativeHeaders-*.a` and `Info.plist` come from the 0.88 slot (512-byte placeholder archives, version-free). The result has 887 header files against 0.88's 842, with the same top-level namespaces except 0.88-only `RCTAnimatedModuleProvider`.
4. **ReactNativeDependenciesHeaders.xcframework**: 0.86.3's `ReactNativeDependencies.xcframework/Headers` (SocketRocket, boost, double-conversion, fast_float, fmt, folly, glog) wrapped in 0.88's empty-lib xcframework shell. `diff -rq` against 0.88's sidecar headers: **identical** (0 differences).
5. ReactNativeDependencies and hermes-engine are symlinked unchanged. `artifacts.json` is written for `validateArtifactsCache`.

### 4. ios-xtool + build: OK
`rn-xtool build` (global CLI) fails as expected with `✖ React Native 0.86.3 is not supported; rn-xtool requires 0.88 or newer`.

Bypass chosen: **neither** editing the main checkout's `dist/` **nor** a hand-written generator script. Instead I made a **spike copy of the CLI package** at `.spike/rnx/`. That was faster and safer: nothing to restore, and the whole real pipeline (patches, rn-spm with scaffold/persist, frameworks, generate, xtool-build) still runs. The copy differs from the checkout in only three places:
- `dist/project/bare.js`: `MIN_RN_MINOR = 88` changed to `86`.
- `scripts/rn-spm-generate.js` replaced by the spike driver.
- `patches/react-native+0.88.0.patch` removed. It would otherwise be selected because react-native is installed, and fail on 0.86.3; the vendored scripts already carry those fixes.

`rn-xtool.config.json`: `{ "metroPort": 8082, "rnArtifactsDir": "<app>/.spike/artifacts" }`. This existing config key makes rnSpm.ts pass `--artifacts`, so the driver runs offline on the adapted slots.

`node .spike/rnx/bin/rn-xtool.js build`: patches 0.0 s, rn-spm 2.3 s, frameworks 0.5 s, generate 0.0 s, xtool-build 16.5 s ("Build complete!", "Wrote to .../ios-xtool/xtool/App.app"). 341 warnings and no errors. The warnings are `-Wincomplete-umbrella` (0.86's React_Core umbrella does not list the Fabric/other-pod headers that now share the flat React dir), nullability, legacy-arch deprecations and unused `-fmodules-cache-path`. `import React_RCTAppDelegate` in the 0.86 AppDelegate resolved through the `React_RCTAppDelegate` module of the (0.88-shaped) ReactNativeHeaders map. The link against the 0.86.3 React binary succeeded, so every symbol the app, codegen and safe-area-context reference exists in 0.86.3.

### 5. Stop
I did not install anything and did not start Metro.

### 6. Optional: react-native-screens 4.30.0: OK
After `npm install react-native-screens@4.30.0` (it ships no Package.swift; peer deps `*`), the rerun of `node .spike/rnx/bin/rn-xtool.js build` went as follows:
- The autolinker reported `Package.swift is missing for library "react-native-screens"`.
- rn-xtool ran the scaffold through the vendored, patched scaffolder: SwiftPM name `RNScreens`, the usual 3 regex-parser warnings.
- It persisted `patches/react-native-screens+4.30.0.patch` and reran.
- frameworks 12.7 s, xtool-build 51.6 s, App.app 82 MB.

The scaffolded manifest matches the one app-bare (0.88) gets, line for line, except two lines: the slot label `0.86.3/dual-flavor` (0.88: `0.88.0/dual-flavor`) and `.iOS("15.1")` (0.88's app has 16.4). The 0.88 copy also still says `expo-xtool-scaffold-revision` where this one says `rn-xtool-scaffold-revision`. I did not import screens in JS (my sed on App.tsx did not match, so App.tsx is unchanged); the native module is compiled and linked.

## 0.86.3 vs 0.88.0 differences observed

**Artifacts**
- Same Maven coordinates for core/deps/hermes, and both are on repo.reactnative.dev.
- 0.86.3 core tarball: `React.xcframework` only, with per-pod `Headers/React_*/...`, `framework module React { umbrella header "React_Core/React_Core-umbrella.h" }` + `framework module React_RCTAppDelegate`, and a VFS overlay template. No `ReactNativeHeaders.xcframework`.
- 0.88 core tarball: React.framework with flat headers + `React-umbrella.h` + a separate `ReactNativeHeaders.xcframework`.
- 0.86.3 deps tarball: headers inside `ReactNativeDependencies.xcframework/Headers` (identical to 0.88's sidecar) and no `ReactNativeDependenciesHeaders.xcframework`.
- No `reactnative-headers-*` / `reactnative-dependencies-headers-*` classifiers exist for 0.86.3.
- Hermes: 250829098.0.17 (0.86.3) vs 260318099.0.4 (0.88.0).
- Slot sizes (debug): React 638 MB, deps 95 MB, hermes 83 MB.

**Codegen**
- Same entry point (`scripts/generate-codegen-artifacts.js`, byte-identical) and the same output dir layout (`ReactCodegen/`, `ReactAppDependencyProvider/`).
- Executor diffs, ignoring `node:` prefixes, are small: generateRCTThirdPartyComponents 22 lines, utils 10, index 4, generateSchemaInfos 4 (a `platform` param), and the podspec templates 2-4.
- 0.86 lacks `templates/Package.swift.spm-template`; that was the only codegen-side gap.
- `@react-native/codegen` 0.86.3 is used.

**Header farm**
- `buildPerAppHeaderTree` worked unchanged: 42 headers (codegen output + safe-area-context).
- React core headers are where the layouts really differ: per-pod + VFS (0.86) vs flat React + ReactNativeHeaders (0.88). The namespaces map one to one (0.88 adds `RCTAnimatedModuleProvider`; ReactNativeHeaders also folds in `hermes/`).

## What a real implementation would need

1. **A 0.86 artifact adapter**, the core piece. It turns a downloaded 0.86.x slot into the headers-spec layout (VFS materialization, flat React headers + umbrella + module map, ReactNativeHeaders with folded hermes and its own module map, deps-headers sidecar, empty-lib xcframework shells). It must not depend on a 0.88 slot being present: generate `Info.plist`, module maps and the placeholder `.a` files ourselves (the `.a` needs an empty `ar` archive per slice, which can be written in JS). It also needs a cache key/stamp that `flavored-frameworks.js` will accept for both flavors.
2. **The vendored RN 0.88 SwiftPM scripts shipped inside rn-xtool** (`setup-apple-spm.js` + `spm/` + `Package.swift.spm-template`) for RN versions without `scripts/spm`, with the 13 scaffolder fixes applied to the vendored copy (not via patch-package). Script edits: E1-E3, i.e. take an explicit RN root instead of `__dirname`-relative lookups. Pin `yargs`/`micromatch` as rn-xtool dependencies instead of resolving them by accident from the app.
3. **Version-aware pieces in rn-xtool**:
   - `MIN_RN_MINOR` / the version gate.
   - Bundled-patch selection must skip `react-native+0.88.0.patch` when RN is not 0.88.
   - The driver picks scripts by RN version: installed `scripts/spm` for ≥ 0.88, vendored for 0.86 (and probably 0.87, see `rn-087-recon.md`).
   - Artifact step: the adapter runs between download and `generate-spm-package`. Simplest is to always call the driver with an offline `--artifacts <adapted-root>` for 0.86, or to hook it inside `ensureArtifactFlavor`.
   - doctor/docs: the template differences (AppDelegate-only, `React_RCTAppDelegate` import, target 15.1).
4. **Codegen compatibility**: nothing beyond the template redirect (E1) for 0.86.3. Keep running the installed RN's codegen.

## Open risks

- **Runtime is unverified.** It builds and links, but nobody has launched it. The headers all come from 0.86.3, so header/binary ABI skew is unlikely. What is new is the module grouping (0.88's module map applied to 0.86 headers, plus a flat React dir that now also holds Fabric/other-pod headers outside the umbrella). That can bite libraries that `@import` submodules, or headers whose `#include` semantics change under modules. Device test pending.
- The `-Wincomplete-umbrella` set means some React headers are only textually includable. A library that relies on them through `@import React` could fail to compile. Screens and safe-area-context did not.
- The adapter depends on the exact 0.86 tarball layout (the VFS template format, `React_Core-umbrella.h`). Other 0.86.x patch releases need checking; 0.85 and earlier are untested and may differ (for example, no prebuilt core at all).
- Release flavor: both slots were adapted and validated by `flavored-frameworks`, but only debug was built.
- The vendored 0.88 scripts may emit manifest features that a 0.86 library ecosystem does not expect. Only safe-area-context (own manifest) and screens (scaffolded) were tried.
- The adapted React.framework that gets embedded still carries its Headers/Modules (size only). Its `_CodeSignature` was dropped, which is fine for Linux SwiftPM but would matter for Xcode.
- The 1.3 GB raw 0.86.3 slots live in `~/Library/Caches/ReactNative/spm-artifacts/0.86.3`, and the adapted copies (mostly hard links) are in `.spike/artifacts`.

## Integrity checks

- **The main rn-xtool `dist/` was never modified**: md5 of all `dist/` files was `9c3c87287b8548287298a63daae2922e` before and after. The gate bypass lived only in `.spike/rnx/dist`. `npm run build` was therefore not needed, and `git status` in expo-xtool is clean (`.superpowers/` is gitignored).
- **The Expo reference app is untouched**: md5 of all of `app/node_modules/react-native/scripts` is `9a94edca4af879eb3481a878b6daec42`, identical before and after. Its only git change, `M App.tsx`, was already there before this spike started.
- No commits were made.
