# RN 0.87.x bare support: recon (read-only, facts only)

Scratch (extracted, never executed): <scratch>/older/
(rn0870, rn0871, rn0880, tpl087 = community template 0.87.2, tpl088 = 0.88.0, norm/* = copies with `node:` prefixes stripped for diffing, dry*/ = patch trial copies).

Versions: npm `react-native@0.87` latest = **0.87.1** (0.87.0 and 0.87.1 only; no 0.87.2 of RN). `@react-native-community/template` has 0.87.0, 0.87.1, 0.87.2 (0.87.x template pins react-native 0.87.1; 0.88.0 template pins 0.88.0; both pin CLI 20.2.0).
Compared: RN 0.87.0, 0.87.1, 0.88.0.

## 1. Script layout

Files in scripts/spm/ (0.87.1 vs 0.88.0): same set, except 0.88.0 ADDS `ios-deployment-target.js` (378 lines) and `swiftpm-config.js` (245 lines). 0.87.0 has an extra `__doc__/` dir (5 md files) that 0.87.1 and 0.88.0 do not. `setup-apple-spm.js`: 1267 lines (0.87.0), 1283 (0.87.1), 1361 (0.88.0).
Changed-line counts (after normalising `node:` require prefixes), 0.87.1 -> 0.88.0: setup-apple-spm 86, autolinking-plugins 13, download-spm-artifacts 137, expand-spm-dependencies 373, generate-spm-autolinking 231, generate-spm-xcodeproj 158, read-podspec 164, scaffold-package-swift 377, spm-pbxproj 57, spm-types 33, spm-utils 26, sync-spm-autolinking 13; generate-spm-package.js and generate-spm-autolinking-config.js, flavored-frameworks.js: identical (0.87.1 vs 0.88.0).
0.87.0 -> 0.87.1 also changed a lot (spm-types, generate-spm-xcodeproj 666 lines, expand-spm-dependencies 279, generate-spm-autolinking 197, spm-pbxproj 188, spm-utils 119, ...): 0.87.0 is not a safe stand-in for 0.87.1.

### Driver imports (scripts/rn-spm-generate.js, 190 lines) x exists in 0.87

| Import (module -> symbol) | 0.87.0 | 0.87.1 | 0.88.0 | Note |
|---|---|---|---|---|
| setup-apple-spm.js -> `resolveAppIosDeploymentTarget(args, appRoot)` | NO | NO | yes | whole concept new in 0.88 (uses ios-deployment-target.js). 0.87 hardcodes the platform floor |
| setup-apple-spm.js -> `determineVersion(args, rnRoot, appRoot)` | NOT EXPORTED (2-arg fn, no marker pin) | exported, 3-arg, same as 0.88 | yes | |
| setup-apple-spm.js -> `ensureBothArtifactFlavors(args, version)` | yes | yes | yes | same signature, `rawVersion = args.version ?? version` in 0.87.1+ |
| spm/generate-spm-autolinking-config.js -> `generateAutolinkingConfig`, `parseConfigCommandJson` | yes | yes | yes | file byte-identical 0.87.x vs 0.88 |
| spm/scaffold-package-swift.js -> `scaffoldAll` | yes | yes | yes | same name/shape; 0.88 adds iosDeploymentTarget/cacheSlotLabel handling (driver passes both; 0.87 ignores unknown opts, but see below) |
| spm/scaffold-package-swift.js -> `refreshScaffoldedPlatformFloors` | NO | NO | yes | 0.87 scaffold SCAFFOLDER_VERSION=19, 0.88 = 20 |
| spm/sync-spm-autolinking.js -> `main` (argv incl. `--ios-deployment-target`) | yes (no such option) | yes (no such option) | yes | yargs has no `.strict()` in 0.87.1 (grep found none), so the extra flag is likely ignored; untested |
| spm/generate-spm-package.js -> `main` (`--app-root --react-native-root --version --debug-artifacts-dir --release-artifacts-dir`) | yes | yes | yes | same options; 0.87.0 differs internally (hardcoded product list), identical output names |
| spm/flavored-frameworks.js -> `finalizeArtifactPublication(appRoot)` | yes | yes | yes | identical file |
| spm/download-spm-artifacts.js -> `resolveCacheSlotVersion(rawVersion)` | yes | yes | yes | same signature |
| (runtime) `resolveInjectionTarget` is used only inside 0.88's resolveAppIosDeploymentTarget | n/a | n/a | yes | |

Net: of 11 driver-touched symbols, 2 are missing in 0.87.x (`resolveAppIosDeploymentTarget`, `refreshScaffoldedPlatformFloors`), 1 more is missing in 0.87.0 only (`determineVersion` export). The driver as written throws `TypeError: setup.resolveAppIosDeploymentTarget is not a function` on 0.87.x (untested by running; derived from exports).
Also: 0.87 manifests use `platforms: [.iOS(.v15)]` hardcoded (scaffold-package-swift.js:769, generate-spm-autolinking.js:1072/1220); 0.88 emits `.iOS("<target>")` from `--ios-deployment-target`. Template deployment target is 15.1 in both templates; CLI IOS_MIN is 16.4.

## 2. Does patches/react-native+0.88.0.patch apply to 0.87.x?

Patch: 1806 lines, 3 files (read-podspec.js 19 hunks, +530/-74; scaffold-package-swift.js 23 hunks, +683/-43; spm-utils.js 1 hunk, +10).
Control: 0.88.0 -> `patch --dry-run` and `git apply --check` both clean.

| Tool | 0.87.1 | 0.87.0 |
|---|---|---|
| GNU `patch --dry-run -p1` | read-podspec 7/19 FAILED (#1 @170, #7, #8, #11, #17, #18, #19), scaffold 1/23 FAILED (#1 @54, imports), spm-utils OK (offset) | read-podspec 7/19 FAILED (same), scaffold 5/23 FAILED (#1,#5,#10,#11,#21), spm-utils OK |
| `git apply --check` (strict, what patch-package uses; fuzz not allowed) | read-podspec FAILS 8 hunks (@170, 332, 354, 482, 677, 693, 746, 794); scaffold FAILS 5 hunks (@54, 113, 768, 844, 1099); spm-utils OK. Rejected = 532 + 178 lines of .rej | read-podspec 8 hunks; scaffold 9 hunks (@54,113,248,518,526,768,844,1014,1099); spm-utils OK |

Why the hunks fail (0.87.1): the patch is built against a 0.88.0 file that contains 0.88-only code the hunks use as context or extend:
- read-podspec.js: 0.88 `readPodspecSource` (comment-line stripping), `SHADOWING_SUBSPEC_RE`/`hasShadowingSubspec`, `getSpecStringField`/`getIdentityField`/`shadowedIdentity`, `specStringField`, `module_name`/`moduleName` field, `podspecModels`/`readPodspecCached`, `readPodspecNames`, `findPodspecs` all exist only in 0.88. 0.87 read-podspec.js is 0.87.0 == 0.87.1 (unchanged between them).
- scaffold-package-swift.js: context anchored on `require('./swiftpm-config')` (@54), `warn` logger and `SCAFFOLDER_VERSION = 20` (@113), the `reportSwiftName` function (@844), `readPodspecCached`/`findPodspecs` call sites and `refreshScaffoldedPlatformFloors` (@1099); 0.87 has `readPodspec` only, SCAFFOLDER_VERSION 19, no swiftpm-config.
- spm-utils.js hunk (header-farm, patch #12) applies cleanly to 0.87.0 and 0.87.1 (offsets only; `buildPerAppHeaderTree` is the same shape).
- The patch also references `swiftpmConfig`/`readSwiftpmConfig/writeSwiftpmName`, `findPodspecs`, `model.moduleName` in its added code (patch lines ~841, 1384-1398), i.e. even the hunks that apply with fuzz contain code calling 0.88-only helpers: applying with fuzz would leave `require('./swiftpm-config')` (file absent in 0.87) -> module-not-found.
Patch numbers by doc (docs/upstream/react-native-scaffolder.md): fixes 1 (bare lists), 3 (Ruby locals), 4 (subspec blocks), 6 (platform fields), 8 (REACT_NATIVE_*_VERSION defines) live in read-podspec.js; 2, 5, 7, 9, 10, 11, 13 in scaffold-package-swift.js; 12 in spm-utils.js. Not checked: which of the 13 fixes the unpatched 0.87 code already contains.

## 3. Artifacts (download-spm-artifacts.js / generate-spm-package.js)

URL scheme (same coordinates 0.87.1 vs 0.88):
- React core: `<repo>/com/facebook/react/react-native-artifacts/<v>/react-native-artifacts-<v>-reactnative-core-<flavor>.tar.gz`
- ReactNativeDependencies: same dir, `...-reactnative-dependencies-<flavor>.tar.gz`
- Hermes: `<repo>/com/facebook/hermes/hermes-ios/<hermesV>/hermes-ios-<hermesV>-hermes-ios-<flavor>.tar.gz` (hermesV = installed `hermes-compiler` npm version, NOT the RN version; falls back to npm dist-tag `latest-v1`). 0.87.1 pins hermes-compiler 250829098.0.17; 0.88.0 pins 260318099.0.4.
Difference: 0.87.0/0.87.1 use only Maven Central (or `ENTERPRISE_REPOSITORY`) via `rnCoreReleaseUrl` (singular); 0.88 tries `https://repo.reactnative.dev/maven2` first then Central (`rnCoreReleaseUrls`, `mavenRepositoryUrls`, `firstExistingUrl`; `RCT_REACT_NATIVE_MAVEN_MIRROR_ENABLED`). Exports renamed: `rnCoreReleaseUrl/rnDepsReleaseUrl/hermesReleaseUrl` -> plural versions. The driver does not import these.
generate-spm-package.js: 0.87.0 hardcodes products (ReactHeaders, ReactNativeHeaders, ReactNativeDependenciesHeaders, ReactHeadersTarget dir); 0.87.1 == 0.88 (constants from spm-utils). Output names identical.

Probe (HTTP status after following redirects, `curl -sIL`; Central answers 301 -> 200):
| Artifact | Central 0.87.0 | 0.87.1 | 0.87.2 | 0.88.0 | repo.reactnative.dev 0.87.0 | 0.87.1 | 0.88.0 |
|---|---|---|---|---|---|---|---|
| reactnative-core debug | 200 | 200 | 404 | 200 | 200 | 200 | 200 |
| reactnative-core release | 200 | 200 | 404 | 200 | 200 | 200 | 200 |
| reactnative-dependencies debug | 200 | 200 | 404 | 200 | 200 | 200 | 200 |
| reactnative-dependencies release | 200 | 200 | 404 | 200 | 200 | 200 | 200 |
hermes-ios (debug) on Central: 250829098.0.17 -> 200, 260318099.0.4 -> 200 (hermes-ios/<RN version> -> 404, as expected, not used). Mirror has no hermes-ios (404) for any tried version.
(0.87.2 is not a published RN version; 404 expected.)

## 4. Codegen / autolinking differences (0.87.1 -> 0.88) affecting the generated Package.swift

Same: package/product names (ReactNative; ReactHeaders, ReactNativeHeaders, ReactNativeDependenciesHeaders; React-GeneratedCode; Autolinked; ReactAppHeaders; ReactCodegen; ReactAppDependencyProvider), `ReactHeadersTarget` dir, header-farm builder `buildPerAppHeaderTree` (spm-utils.js, only 26 changed lines: added `toC99Name`, `swiftNameKey`, `isValidSwiftName` exports), generate-spm-autolinking-config.js, flavored-frameworks.js, generate-spm-package.js. Our src/generate/packageSwift.ts references ReactNative / ReactHeaders / ReactNativeHeaders / ReactNativeDependenciesHeaders / React-GeneratedCode / Autolinked: all present in 0.87.1.
Different in 0.87 (would change generated manifests / behaviour):
- Platform floor: `.iOS(.v15)` hardcoded in the Autolinked and per-lib manifests (generate-spm-autolinking.js:1072, 1220; scaffold:769); 0.88 uses the app deployment target (`--ios-deployment-target`, ios-deployment-target.js).
- App-level SwiftPM settings: 0.87 reads `react-native.config.js` -> `spm.modules` / `spm.denyPlugins` / `spm.autolinkingPlugin` / `spm.dependencies` / `spm.name`; 0.88 reads `package.json` `swiftpmConfig` (`modules`, `denyPlugins`, `dependencies`, `name`, `autolinkingPlugin`) via swiftpm-config.js, with react-native.config.js as the legacy home. Our src does not reference `swiftpmConfig`/`spm.*` anywhere except a comment in src/pipeline/rnSpm.ts:168 (`swiftpmConfig.name` falls back to podspec name) and PERSIST_EXCLUDE (`^package\.json$`).
- Swift target naming (expand-spm-dependencies.js, 373 changed lines): 0.88 resolves a target name from podspec `header_dir`/`module_name`/`name` (+ `readPodspecNames`, c99 collision keys); 0.87 uses `spm.name` config / npm-name derivation with scope disambiguation and lowercase collision keys. Libraries whose podspec header_dir differs from the npm name can therefore get different target names under 0.87.
- Autolinker: 0.88 keeps lib-alias dirs (inode-stable, `wantedLibAliases`); 0.87 `rmSync(libsDir)` every run.
- Mixed-language: 0.87 reports `skipped-mixed-language` and fails with "has mixed Swift + Objective-C/C++ sources ... SwiftPM cannot compile" (generate-spm-autolinking.js:535-537 area); 0.88 text differs in the same area but upstream scaffolder still does not emit mixed targets. `experimentalMultiLang` is NOT present in any RN 0.87/0.88 script (grep: only "mixed" strings); it is emitted by our own patch (#10) and by src/generate/packageSwift.ts (MIXED_TOOLS_VERSION), so it is independent of the RN version except through the patch.
- Scaffold output: SCAFFOLDER_VERSION 19 (0.87) vs 20 (0.88); persisted `patches/<lib>+x.patch` Package.swift files carry the version line and (our patch) a `rn-xtool-scaffold-revision` line.

## 5. Template (@react-native-community/template 0.87.2 vs 0.88.0, template/ios)

| Item | 0.87.2 | 0.88.0 |
|---|---|---|
| Files | AppDelegate.swift, Info.plist, Images.xcassets, LaunchScreen.storyboard, PrivacyInfo.xcprivacy, Podfile, _xcode.env | same + **SceneDelegate.swift** |
| AppDelegate.swift | `@main`-style app delegate that owns `window`, `reactNativeDelegate`, `reactNativeFactory`; `ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate` class in the same file; `startReactNative(withModuleName:in:launchOptions:)`; imports React, React_RCTAppDelegate, ReactAppDependencyProvider | trimmed to a plain UIApplicationDelegate (`return true`); no React imports |
| SceneDelegate.swift | absent | `SceneDelegate: RCTDefaultReactNativeFactoryDelegate, UIWindowSceneDelegate`; creates `RCTReactNativeFactory`, starts RN with `connectionOptions`, `RCTDevMenuConfiguration` in DEBUG, `RCTLinkingManager` URL handlers |
| Info.plist | no scene manifest | adds `RCTNewArchEnabled`=true and `UIApplicationSceneManifest` (UISceneDelegateClassName `$(PRODUCT_MODULE_NAME).SceneDelegate`, multiple scenes false) |
| project.pbxproj | no SceneDelegate refs | +4 lines: PBXBuildFile, PBXFileReference, group child, Sources entry for SceneDelegate.swift |
| IPHONEOS_DEPLOYMENT_TARGET | 15.1 (4 configs) | 15.1 (4 configs) |
| Podfile | identical (`platform :ios, min_ios_version_supported`; RN 0.87/0.88 helpers return '15.1') | |
| PrivacyInfo.xcprivacy | identical | |
Relevant to our code: src/generate/iosXtool.ts hardcodes `["AppDelegate.swift","SceneDelegate.swift"]` only for the non-bare (Expo) branch (line ~59); the bare branch uses `copyBareTarget` driven by the pbxproj target (generic), so a 0.87 template (AppDelegate only, no scene manifest) needs no SceneDelegate. Not tested end to end; no code run.

## 6. Other facts

- src/project/bare.ts: `MIN_RN_MINOR = 88`; `checkRnVersion` rejects `0.<88` with "requires 0.88 or newer"; error text suggests `react-native@0.88.0`. `installedRnVersion` is in src/project/expo.ts:33 (reads node_modules/react-native/package.json `version`, "unknown" on failure). src/versions.ts has no RN version constant (only XTOOL, SWIFT 6.4, IOS_MIN 16.4, MIN_EXPO_SDK 58).
- src/pipeline/patches.ts: `selectBundledPatches` picks a bundled patch when the package `<pkg>` is INSTALLED at any version (filename version ignored); `findPatchMismatch` compares `installed !== info.version` only after patch-package fails (error message tells user to pin to the patched version). Consequence: today 0.87.x would stage `react-native+0.88.0.patch`, patch-package would fail, and the failure message would say to pin react-native to 0.88.0. Two files `react-native+0.87.1.patch` and `react-native+0.88.0.patch` would both be selected (both match name `react-native`) and both staged into the same patch dir; selection by version does not exist in code.
- src/paths.ts:55 `SWIFT_HEADERS_DIR_ENV = RN_SPM_SWIFT_HEADERS_DIR` is read by the patched scaffolder (patch #10); unpatched 0.87 ignores it.
- patch-package filename convention: `react-native+0.88.0.patch`; parsePatchFileName accepts any `\d+.\d+.\d+` suffix.

## What versioning would need

1. Single driver with conditionals: possible for the driver file itself. The driver differences are only (a) `resolveAppIosDeploymentTarget` and `refreshScaffoldedPlatformFloors` missing in 0.87 (guard with `typeof ... === 'function'`; floor then stays RN's hardcoded `.v15`, i.e. below our IOS_MIN 16.4/template 15.1 usage), (b) `determineVersion` not exported in 0.87.0 only (0.87.1 is fine; a 0.87.0 fallback would read package.json), (c) `--ios-deployment-target` passed to sync main which 0.87 does not define (non-strict yargs; unverified). `scaffoldAll` options are compatible in name. Everything else (`generateAutolinkingConfig`, `ensureBothArtifactFlavors`, `main` of sync/generate-package, `finalizeArtifactPublication`, `resolveCacheSlotVersion`) has the same signatures. Not run against a real 0.87 project, so this is by source comparison only.
2. Second patch file: yes, `react-native+0.88.0.patch` cannot be reused. Strict `git apply` (patch-package) fails 8/19 hunks in read-podspec.js and 5/23 in scaffold-package-swift.js on 0.87.1 (9/23 on 0.87.0); only the 10-line spm-utils.js hunk applies cleanly. The patch also calls 0.88-only helpers (`swiftpm-config`, `findPodspecs`, `readPodspecCached`, `model.moduleName`), so a fuzzed apply would produce a broken scaffolder. A 0.87 patch would need re-deriving the 13 fixes on 0.87's read-podspec.js (no subspec/shadow/identity machinery, no names/cached readers) and scaffold-package-swift.js (SCAFFOLDER_VERSION 19, `readPodspec` not cached, `.v15` floor, no swiftpm-config); sizes: the 0.88 patch is +1223 added lines (read-podspec +530, scaffold +683, spm-utils +10); roughly 710 lines of its hunk text (532 + 178 .rej lines) do not apply to 0.87.1, i.e. about 40% of the patch body must be rewritten, the rest ports with offsets. 0.87.0 and 0.87.1 scaffold files differ (89 changed lines), so a patch for 0.87.1 does not apply to 0.87.0 either (and 0.87.0 lacks `determineVersion` export): exact-version patch files per patch release (0.87.0, 0.87.1) or a minimum of 0.87.1 would be needed given patch-package's per-file strictness.
3. Patch selection code: `selectBundledPatches`/`findPatchMismatch` ignore the filename version when choosing, so two `react-native+*.patch` files would both be staged; a version filter would be needed (code change, not a blocker).
4. Blockers found: none at the artifact level (all 0.87.0 and 0.87.1 Maven artifacts return 200 on Central and the RN mirror; Hermes tarball for hermes-compiler 250829098.0.17 returns 200). Open unknowns (not tested, would need a real 0.87 bare app and Linux/xtool build): behaviour of Hermes 250829098.0.17 with our build; whether unpatched 0.87 scaffold output for gesture-handler etc. builds once the 0.87 patch is written; platform floor `.v15` vs our IOS_MIN 16.4 in generated manifests; `bare.ts` MIN_RN_MINOR gate (88) and its messages currently hard-reject 0.87.
