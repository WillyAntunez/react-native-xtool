# Library compatibility suite: proposal (research, 2026-10-27)

Read-only research. Nothing was built or run. The maintainer decides what goes in.

## Sources and method

- **Downloads**: `https://api.npmjs.org/downloads/point/last-week/<pkg>`, fetched 2026-10-27. The window is
  **2026-10-20 to 2026-10-26** for every row.
- **Version**: `npm view <pkg> version` (latest dist-tag), same day.
- **Linkage facts**: each package's npm tarball (`npm view <pkg> dist.tarball`, fetched with curl and unpacked under
  `<scratch>/suite/x/`).
  Nothing in the tarballs was run. I read `*.podspec`, `Package*.swift`, `spm.config.json`, `expo-module.config.json`,
  `nitro.json`, `package.json#codegenConfig` and the iOS source tree (file counts by extension, `-Swift.h` imports).
  I grepped the podspecs for `dependency`, `resource_bundles`, `resources`, `vendored_frameworks`, `script_phase(s)`,
  `prepare_command`, `pod_target_xcconfig`, `compiler_flags`, `static_framework`, `default_subspec` and `header_dir`. The
  script is at
  `<scratch>/suite/scripts/scan.py`.
  The results are in `.../scratchpad/suite/scan.jsonl` and `.../scratchpad/suite/meta.tsv`.
- **Upstream SwiftPM availability** of external pods: HTTP 200 on `raw.githubusercontent.com/<repo>/<branch>/Package.swift`,
  plus a grep for `binaryTarget`. I checked Tencent/MMKV, RevenueCat/purchases-hybrid-common, google/GoogleSignIn-iOS,
  SDWebImage, airbnb/lottie-spm, SwiftAudioEx, googlemaps/ios-maps-sdk, firebase-ios-sdk, sentry-cocoa,
  SPTPersistentCache and SDWebImagePhotosPlugin. All of them have a manifest.
- **What the tool does today**: docs/libraries.md, docs/how-it-works.md, docs/bare-react-native.md and docs/upstream/*.md.
  I also checked the vendored `vendor/rn-spm/spm/*.js` for keywords. `read-podspec`/`scaffold-package-swift` have no
  handling for `vendored_frameworks`, `resource_bundles`, `script_phase`, `spm_dependency` or `prepare_command`.
  `KNOWN_POD_SPM_PACKAGES` holds only SwiftUIIntrospect.
- Status legend: ✅ verified on device (docs/libraries.md) · ❌ known gap · ⏳ untested, and the mechanism it uses is
  already verified on another library · **unknown**: it would take a path nobody has exercised, or one that facts below
  say is a gap.

## Facts that change the picture (found during this research)

1. **Some verified libraries now link differently.** The latest versions ship their own `Package.swift`, so the
   scaffolder is skipped for them (they are "self-managed"):
   - `react-native-gesture-handler` 3.4.0 has `./Package.swift`. 3.3.0 was verified through the scaffolder.
   - `react-native-pager-view` 9.0.11 has `ios/Package.swift`. It uses two targets, `react-native-pager-view` and
     `RNCPagerViewSwift`, and depends on `.package(url: swiftui-introspect, from: "1.0.0")`. 9.0.7 was verified through
     the scaffolder with fixes 10 and 13.

   After an upgrade, the libraries.md rows for these two describe a mechanism that no longer applies. Fixes 10 and 13
   also lose their verified example.
2. **`react-native-worklets` 0.13.1 is the new latest, and its manifest still has `CFGetTypeID`.** The persisted patch
   is `patches/react-native-worklets+0.13.0.patch`. patch-package files are tied to a version, so a fresh install of
   0.13.1 needs that patch regenerated.
3. **Some other libraries ship their own `Package.swift` and bring binaries through it:**
   - `@sentry/react-native` 8.32.0: a URL `binaryTarget` for `Sentry.xcframework.zip`, sentry-cocoa 9.31.0 (80.5 MB).
   - `lottie-react-native` 7.5.0: depends on `airbnb/lottie-spm`. That package's `Lottie` is a URL `binaryTarget`
     (55.2 MB for 4.6.1). Its own comment says the framework must be embedded or the app "crash[es] when ran on a
     physical device".
   - `@shopify/react-native-skia` 2.14.0: `.package(path:)` to the npm package `react-native-skia-apple-ios` 154.0.1
     (218.6 MB unpacked). The manifest calls `fatalError` if that package is absent.

   rn-xtool stages frameworks only from `flavored-frameworks.json` (`src/frameworks.ts`). Nobody has verified whether a
   dynamic framework that a library package brings in is embedded and signed.
4. **Firebase ships a `Package.swift`, but only as a CI probe.** It is at `ios/RNFBFirebase/Package.swift`, which is
   neither `<root>/` nor `<root>/ios/`, so the scaffolder still treats the package as CocoaPods-only. The Firebase SDK is
   added by `firebase_dependency(...)`, a Ruby helper in `firebase_spm.rb` that calls React Native's `spm_dependency`.
   The scaffolder's regex reader cannot see it.
5. **`react-native-keychain` 10.0.0 is pure Objective-C** (`ios/RNKeychainManager/RNKeychainManager.m`), not Swift.
   **`react-native-permissions` 5.6.3** is ObjC++, with one Swift file in the Contacts handler. Neither is "Swift-only
   with Swift package deps". The real Swift-only case with a pod dependency is `react-native-track-player` (13 Swift
   files, `SwiftAudioEx` pod). `@react-native-documents/picker` (10 Swift + 2 ObjC++, two-way) and
   `react-native-camera-kit` are mixed Swift/ObjC++.
6. **`react-native-video`'s external pods are opt-in only.** `GoogleAds-IMA-iOS-SDK` sits behind `$RNVideoUseGoogleIMA`,
   and `SPTPersistentCache`/`DVAssetLoaderDelegate` behind `$RNVideoUseVideoCaching`, both Podfile globals. The default
   `Video` subspec has none. The regex reader merges subspec blocks and ignores Ruby conditions (see
   rn-libs-podspec-analysis.md on svg's `if/else`), so it may pick these dependencies up anyway.
7. **`expo-file-system` (10.0M/week), `expo-font` (9.8M) and `expo-constants` (11.0M) are not in the reference app.**
   SDK 58's core no longer pulls them in, so they are untested. `expo-file-system` is a mixed Swift + ObjC Expo module
   (23 `.swift`, 11 `.m`) with an `spm.config.json`. `expo-location` (49/7) and `expo-audio` (16/1) are mixed too.
8. **A pod can add its sources through Ruby, which the scaffolder cannot see.**
   - Nitro: `load 'nitrogen/generated/ios/<X>+autolinking.rb'; add_nitrogen_files(s)`.
   - Permissions: the Podfile's `setup_permissions([...])` rewrites `RNPermissions.podspec` `source_files` in
     `node_modules`.
   - Firebase: `firebase_dependency`.
   - quick-crypto: the podspec downloads OpenSSL with curl when it is evaluated.

## 1-2. Popularity and classification

Mechanism key:
- **EX-pkg**: Expo module with a checked-in Package.swift.
- **EX-swift**: Expo module built from source, pure Swift.
- **EX-mixed**: Expo module with mixed Swift and C-family sources, or ObjC only.
- **EX-meta**: Expo meta pod.
- **EX-spmpkg**: Expo module with `spmPackages` (remote SwiftPM deps).
- **EX-vendored**: Expo module built from vendored C (refused).
- **RN-pkg**: RN library that ships its own Package.swift.
- **SC-objc / SC-objcxx / SC-mixed**: CocoaPods-only, scaffolded. Plain ObjC / ObjC++ and C++ / mixed Swift and C-family.
- **SC-nitro**: scaffolded nitro module.
- **JS**: no native iOS code.

Risk flags:
- **POD**: external CocoaPods dependency (needs a pod→SwiftPM map entry).
- **RB**: `resource_bundles` (*priv* means only `PrivacyInfo.xcprivacy`, which matters for App Store builds but not for
  dev builds).
- **RES**: `s.resources`.
- **VB**: vendored binary (`vendored_frameworks`, a URL/path `binaryTarget`, or a download at podspec time).
- **CG**: C++ codegen (Fabric component or TurboModule with C++).
- **CGI**: `includesGeneratedCode: true` (the library ships its own codegen output).
- **SW**: Swift-only sources.
- **MX2**: two-way mixed (ObjC imports `-Swift.h`).
- **CXXI**: Swift↔C++ interop (`SWIFT_OBJC_INTEROP_MODE=objcxx`).
- **MTL**: Metal.
- **XC**: Xcode-only tool (asset catalog, `.metal` compile).
- **SP**: `script_phase(s)` or `prepare_command`.
- **RUBY**: sources or deps chosen by Ruby code or the Podfile.
- **LEG**: no `codegenConfig` (legacy bridge module through the interop layer).

| Library | DL/week | Latest | Mechanism | Risk flags (from tarball) | Status today |
|---|---:|---|---|---|---|
| expo-constants | 10,959,259 | 58.0.13 | EX-pkg | RB (`resource_bundles`), SP (`script_phase` writes app.config) | ⏳ (rn-xtool special-cases `EXConstants.bundle/app.config`) |
| expo-file-system | 10,010,749 | 58.0.12 | EX-mixed (23 swift / 11 m) + spm.config.json | RB priv | ⏳ |
| expo-font | 9,836,626 | 58.0.10 | EX-swift | — | ⏳ |
| react-native-safe-area-context | 9,762,808 | 5.10.1 | RN-pkg | CG | ✅ |
| react-native-screens | 9,080,437 | 4.30.0 | SC-objcxx | CG, subspec `header_dir` | ✅ (all 4 versions) |
| react-native-reanimated | 8,559,417 | 4.7.1 | RN-pkg | CG, heavy C++ | ✅ (with Linux manifest patch) |
| react-native-gesture-handler | 8,373,286 | 3.4.0 | **RN-pkg since 3.4.0** (3.3.0 was SC) | CG | ✅ 3.3.0 / ⏳ 3.4.0 |
| react-native-worklets | 8,056,498 | 0.13.1 | RN-pkg | C++, `CFGetTypeID` in manifest | ✅ 0.13.0 / ⏳ 0.13.1 (patch is version-pinned) |
| react-native-svg | 7,746,178 | 15.16.0 | SC-objcxx | CG, RB (`RNSVGFilters` metallib), MTL, XC (`.metal`) | ✅ (Metal filters unavailable) |
| expo-router | 6,974,632 | 58.0.27 | EX-swift (20 swift) | needs screens + safe-area | ⏳ |
| @react-native-async-storage/async-storage | 6,962,894 | 3.1.1 | SC-mixed | VB (`s.ios.vendored_frameworks` SharedAsyncStorage.xcframework, static), MX2, RB priv | ❌ |
| expo-secure-store | 6,452,455 | 58.0.2 | EX-swift | — | ✅ |
| expo-splash-screen | 6,352,518 | 58.0.11 | EX-swift | — | ⏳ |
| expo-notifications | 5,525,902 | 58.1.6 | EX-swift (+ expo-application EX-mixed) | RB priv | ✅ (local) |
| @expo/vector-icons | 5,152,684 | 15.1.1 | JS (fonts through expo-font) | — | ⏳ |
| expo-dev-client | 5,010,744 | 58.0.16 | EX-meta (+ mixed chain) | XC (`Assets.xcassets`) | ✅ (icons missing) |
| react-native-webview | 4,996,126 | 14.0.1 | SC-objcxx | CG | ✅ |
| expo-image-picker | 4,963,836 | 58.0.10 | EX-swift | — | ✅ |
| @react-navigation/native | 4,872,153 | 7.5.1 | JS | — | ⏳ |
| expo-haptics | 4,698,464 | 58.0.7 | EX-pkg | — | ✅ |
| expo-image | 4,539,240 | 58.0.17 | EX-spmpkg (SDWebImage 5.21.6, AVIFCoder, SVGCoder, WebPCoder, libavif) | POD (as SwiftPM URLs), C (libavif) | unknown |
| @react-navigation/native-stack | 3,598,935 | 7.21.0 | JS (→ screens) | — | ⏳ |
| expo-linear-gradient | 3,528,442 | 58.0.3 | EX-swift | — | ⏳ |
| @sentry/react-native | 3,381,092 | 8.32.0 | RN-pkg (also expo-module.config.json) | VB (URL binaryTarget Sentry.xcframework), split Swift/ObjC/C++ targets | unknown |
| expo-blur | 3,086,397 | 58.0.5 | EX-swift | — | ⏳ |
| @react-native-community/netinfo | 2,779,939 | 12.0.1 | SC-objc | CG (modules) | ⏳ |
| expo-camera | 2,569,855 | 58.0.13 | EX-swift, 2 pods (barcode product → ZXingObjC SwiftPM, gated by a Podfile property) | POD (as SwiftPM URL) | unknown |
| expo-location | 2,552,131 | 58.0.19 | EX-mixed (49/7) | — | ⏳ |
| @react-native-community/datetimepicker | 2,544,208 | 9.2.2 | SC-objcxx | CG | ✅ |
| @gorhom/bottom-sheet | 2,473,892 | 5.2.14 | JS | — | ✅ |
| expo-audio | 2,461,689 | 58.0.10 | EX-mixed (16/1) | — | ⏳ |
| expo-video | 2,239,537 | 58.0.12 | EX-swift (66) | — | ⏳ |
| @shopify/flash-list | 2,120,107 | 2.3.3 | JS (no podspec in 2.x) | — | ⏳ |
| react-native-nitro-modules | 2,045,665 | 0.37.1 | SC-nitro | CXXI, c++20, mixed Swift/C++/ObjC++ | unknown |
| expo-sqlite | 1,722,809 | 58.0.14 | EX-vendored | C sources in `vendor/` | ❌ |
| react-native-mmkv | 1,500,542 | 4.3.2 | SC-nitro | CXXI, RUBY (nitrogen), POD (`MMKVCore 2.4.0`), `-x objective-c++` | unknown |
| @shopify/react-native-skia | 1,498,937 | 2.14.0 | RN-pkg | VB (local 218 MB binary package), MTL (links MetalKit; no `.metal` files) | unknown |
| @react-native-firebase/app | 1,447,359 | 27.1.0 | SC-mixed | MX2 (14 files), RUBY (`firebase_dependency` → `spm_dependency`), CGI, `static_framework` toggle | unknown |
| lottie-react-native | 1,259,397 | 7.5.0 | RN-pkg | VB (lottie-spm URL binaryTarget, needs embedding) | unknown |
| react-native-device-info | 1,159,751 | 15.0.2 | SC-objc | RB priv, LEG | ⏳ |
| react-native-pager-view | 1,158,493 | 9.0.11 | **RN-pkg since 9.0.x** (9.0.7 was SC-mixed) | remote SwiftPM dep, mixed | ✅ 9.0.7 / ⏳ 9.0.11 |
| react-native-maps | 1,155,557 | 1.29.11 | SC-objcxx | SP (`script_phases` writes RNMapsDefines.h), CGI, subspecs + `default_subspec`, Google subspec: POD (GoogleMaps = binary), RB | unknown |
| @react-native-google-signin/google-signin | 1,038,072 | 16.1.5 | SC-objcxx, plus an Expo adapter podspec | POD (`GoogleSignIn ~> 9.0`, version from package.json) | unknown |
| @react-native-firebase/messaging | 856,190 | 27.1.0 | SC-mixed | MX2, RUBY, needs RNFBApp | unknown |
| react-native-purchases | 832,524 | 10.16.0 | SC-objc | POD (`PurchasesHybridCommon 19.17.0`, `@import RevenueCat`), LEG | unknown |
| react-native-edge-to-edge | 740,870 | 1.8.2 | JS on iOS (no podspec) | — | ⏳ |
| react-native-share | 645,846 | 12.3.1 | SC-objc | `weak_framework` | ⏳ |
| react-native-linear-gradient | 641,732 | 2.8.3 | SC-objc | LEG | ⏳ |
| react-native-permissions | 637,833 | 5.6.3 | SC-objcxx (+1 swift) | RUBY (Podfile `setup_permissions` rewrites podspec), RB priv | unknown (builds; handlers missing) |
| react-native-vision-camera | 572,722 | 5.2.3 | SC-nitro (353 swift, 118 cpp) | CXXI, RUBY, sibling `NitroImage` | unknown |
| react-native-vector-icons | 497,928 | 10.3.0 (deprecated → per-family) | SC-objcxx | RES (`Fonts/*.ttf`, 19 fonts) | unknown |
| react-native-localize | 492,359 | 3.7.2 | SC-objcxx | CG (modules) | ⏳ |
| react-native-video | 412,986 | 6.19.3 | SC-mixed (36 swift / 3 m) | subspecs, RUBY-gated optional POD, LEG | unknown |
| react-native-keychain | 406,735 | 10.0.0 | SC-objc (pure ObjC) | CG (modules) | ⏳ |
| react-native-fs | 398,442 | 2.20.0 (last publish 2025-02) | SC-objc | LEG | ⏳ |
| react-native-image-picker | 392,889 | 8.3.0 | SC-objcxx | RB priv, `-fmodules -fcxx-modules` | ⏳ |
| expo-av | 358,949 | 16.0.8 | EX-mixed + ReactCommon | precompiled-xcframework pattern | excluded (not in SDK 58) |
| @react-native-vector-icons/common (+ ionicons 155,970, material-design-icons 154,539) | 334,292 | 14.0.0 | JS + resource-only pods per family | RES (`fonts/*.ttf`), pod with no sources | unknown |
| @react-native-documents/picker | 314,222 | 12.0.3 | SC-mixed (10 swift / 2 mm) | MX2 | ⏳ |
| react-native-config | 279,281 | 1.7.2 | SC-objc | SP (`script_phase` runs `BuildDotenvConfig.rb` → `GeneratedDotEnv.m`), `default_subspec` | unknown |
| react-native-quick-crypto | 230,325 | 1.1.9 | SC-nitro (219 cpp) | VB (OpenSSL xcframework downloaded at podspec eval), SP (`prepare_command` for libsodium), CXXI | unknown |
| @react-native-community/blur | 182,390 | 4.4.1 | SC-objcxx | CG (component) | ⏳ |
| @d11/react-native-fast-image | 124,685 | 8.13.0 | SC-objcxx | POD ×6 (SDWebImage, WebP, AVIF, SVG coders, libavif subspecs) | unknown |
| react-native-fast-image | 101,798 | 10.9.9 | SC-objc | POD ×4 (SDWebImage, WebP, SVG, PhotosPlugin) | unknown |
| react-native-sound | 100,866 | 0.13.0 | SC-objcxx | CG | ⏳ |
| react-native-document-picker | 91,195 | 9.3.1 | renamed to @react-native-documents/picker | — | excluded |
| react-native-track-player | 52,653 | 4.1.2 | SC-mixed (13 swift / 1 m) | POD (`SwiftAudioEx 1.1.0`), LEG | unknown |
| react-native-camera-kit | 51,486 | 18.0.1 | SC-mixed | MX2, `CK_USE_FRAMEWORKS` header switch | ⏳ |
| react-native-mmkv-storage | 17,511 | 13.0.1 | SC-objcxx | POD (`MMKV ~> 2.2.3`) | unknown |

No library on the list needs `use_frameworks!` to compile. Firebase's podspec comment calls it "the default on Expo,
and required for the firebase-ios-sdk" under CocoaPods. Camera-kit switches a header import on `ENV['USE_FRAMEWORKS']`
(`CK_USE_FRAMEWORKS`). Its non-framework branch is the one the scaffolder would get.

## 3. Proposed suite (16 = 13 core + 3 known-gap)

Pin exact versions in the matrix apps and bump them on purpose. Item 1 above shows why: a minor bump changed the
mechanism of two libraries.

**Core: expected green, one app per version**

| # | Library (pin) | Mechanism | DL/week | Why |
|---|---|---|---:|---|
| 1 | react-native-safe-area-context 5.10.1 | RN-pkg | 9.76M | Most-downloaded RN native lib. Simplest self-managed manifest. Part of the navigation combo |
| 2 | react-native-screens 4.30.0 (+ @react-navigation/native 7.5.1 + native-stack 7.21.0) | SC-objcxx, CG | 9.08M (+3.60M) | Scaffold baseline. Fabric components with subspec `header_dir` (fixes 3-5). Navigation combo |
| 3 | react-native-reanimated 4.7.1 + react-native-worklets 0.13.x | RN-pkg, heavy C++ | 8.56M | Linux-host manifest patch and Babel plugin. Catches upstream manifest drift (0.13.1 still has `CFGetTypeID`) |
| 4 | react-native-gesture-handler 3.4.0 | RN-pkg (conditional sibling dep on RNWorklets) | 8.37M | Navigation combo. Now self-managed, so it needs re-verifying |
| 5 | react-native-svg 15.16.0 | SC-objcxx, CG, RB, MTL, XC | 7.75M | The scaffolded lib that exercises fixes 6/8/9, metal exclusion and the `resource_bundles` gap |
| 6 | react-native-webview 14.0.1 | SC-objcxx | 5.00M | Highest-download plain ObjC/ObjC++ scaffold. Cheap regression for the base scaffolder |
| 7 | expo-dev-client 58.0.16 | EX-meta + mixed chain | 5.01M | Required for dev builds anyway. Covers meta pods, circular mixed modules and dropped `.xcassets` |
| 8 | expo-file-system 58.0.12 | EX-mixed (+ spm.config.json) | 10.0M | Second most-downloaded package on the list, untested. Mixed Expo module beside expo-notifications' expo-application |
| 9 | expo-image 58.0.17 | EX-spmpkg (remote SwiftPM deps, C libavif) | 4.54M | Only Expo mechanism not covered yet: `spmPackages` fetched from GitHub |
| 10 | @sentry/react-native 8.32.0 | RN-pkg + URL binaryTarget | 3.38M | Highest-download library that brings a vendored binary through its own manifest. Tests binary artifacts on Linux |
| 11 | lottie-react-native 7.5.0 | RN-pkg → remote package → URL binaryTarget that must be embedded | 1.26M | Tests embedding and signing of a dynamic framework from a library package, which rn-xtool does not stage today |
| 12 | react-native-mmkv 4.3.2 (+ react-native-nitro-modules 0.37.1) | SC-nitro: CXXI, RUBY sources, POD MMKVCore | 1.50M (nitro 2.05M) | Represents the whole nitro family (vision-camera, quick-crypto, nitro-image). Exercises fix 10 with C++ interop and a pod-map entry |
| 13 | @react-native-firebase/app + messaging 27.1.0 | SC-mixed MX2, RUBY `spm_dependency`, CGI | 1.45M (+0.86M) | Two-way mixed scaffold (fix 10) at scale, Firebase SwiftPM graph, shipped codegen. Free Firebase project; push itself not testable on a free account |

Items 10-13 are expected to fail today or are unknown. They stay in the core list because each covers a mechanism or
risk flag nothing else covers. Until they pass, they need the same isolation as the known-gap list (see section 4).

**Known gaps: kept in the suite to track the day they start working**

| # | Library (pin) | Gap | DL/week | Why |
|---|---|---|---:|---|
| 14 | @react-native-async-storage/async-storage 3.1.1 | VB: `s.ios.vendored_frameworks` static xcframework (+ MX2, RB priv) | 6.96M | Seventh-highest non-Expo download on the list. The mixed part is solved (fix 10), so only `binaryTarget` emission is missing |
| 15 | expo-sqlite 58.0.14 | EX-vendored: C sources refused | 1.72M | The Expo plugin's only refusal. Also gates `expo-sqlite/kv-store` |
| 16 | @react-native-vector-icons/ionicons 14.0.0 (+ /common) | RES: resource-only pod; fonts must reach the app bundle root for `UIAppFonts` | 0.16M (+0.33M common; v10 0.50M) | The `s.resources` gap. Bare apps use it, Expo apps use @expo/vector-icons |

**Coverage check:**
- Mechanisms:
  - EX-pkg: expo-constants, present in every Expo app.
  - EX-swift: expo-image's own target, plus expo-notifications already ✅.
  - EX-mixed: 8. EX-meta: 7. EX-spmpkg: 9. EX-vendored: 15. RN-pkg: 1, 3, 4, 10, 11.
  - SC-objc / SC-objcxx: 2, 5, 6. SC-mixed: 13. SC-nitro: 12. JS: navigation.
- Risk flags:
  - POD: 12, 13. RB: 5, 14. RES: 16. VB: 10, 11, 14. CG: 2, 5. CGI: 13. SW: none (see exclusions). MX2: 13, 14.
  - CXXI: 12. MTL / XC: 5. RUBY: 12, 13. SP: expo-constants (handled by rn-xtool). LEG: none.
- Navigation combo: 1 + 2 + 3 + 4.

**Excluded, and why:**

| Candidate | Reason |
|---|---|
| expo-haptics, expo-secure-store, expo-image-picker, expo-notifications, datetimepicker, bottom-sheet | ✅ already. Mechanism duplicated by 7-9 and 2/6. Keep them as the existing per-lib smoke in libraries.md |
| react-native-pager-view | 9.0.11 is now RN-pkg with a remote SwiftPM dep, the same mechanism as 11. 9.0.7 ✅ |
| expo-font, expo-splash-screen, expo-blur, expo-linear-gradient, expo-video, expo-router | EX-swift, duplicates. expo-router is JS over 1+2 plus a pure-Swift module; add it if Expo-specific navigation matters |
| expo-camera, react-native-vision-camera, react-native-camera-kit | Need a camera for the device pass and can't coexist in one screen. expo-camera's ZXingObjC `spmPackages` is the same mechanism as 9. vision-camera is the nitro family (12). Candidates for a second app |
| expo-location, expo-audio | EX-mixed, duplicates 8 |
| @shopify/react-native-skia | 218 MB binary npm package and MTL. Mechanism close to 10/11. Listed as a hard case |
| react-native-maps | Default (Apple Maps) build hits `script_phases` + `default_subspec`. Google variant needs an API key. Hard case |
| google-signin, react-native-purchases | Each needs one pod-map entry, same mechanism as 12/13. Runtime needs an OAuth client / RevenueCat key + StoreKit. Hard cases |
| react-native-permissions, react-native-config | RUBY/SP gaps that fail at runtime more than at build. Hard cases |
| react-native-quick-crypto | Nitro (12) plus an OpenSSL download at podspec time. Hard case |
| react-native-fast-image / @d11 | Low downloads. SDWebImage already covered by 9. Would conflict with expo-image's SDWebImage pin if both were in one app |
| netinfo, device-info, share, linear-gradient, localize, keychain, fs, image-picker, blur, sound | Plain SC-objc/objcxx, duplicates of 6. device-info/linear-gradient/fs would add LEG (legacy bridge) coverage if wanted |
| react-native-track-player, @react-native-documents/picker | SW-ish / MX2, covered by 13. track-player adds POD SwiftAudioEx (one map entry) |
| expo-av | Not part of SDK 58 (16.x line). Superseded by expo-audio/expo-video |
| react-native-document-picker | Renamed (`npm view` deprecation notice) |
| react-native-mmkv-storage | 17.5k/week. Conflicts with react-native-mmkv (MMKV vs MMKVCore) |
| flash-list, edge-to-edge (iOS) | No iOS native code |
| react-native-vector-icons 10.x | Deprecated in favour of per-family packages (16) |

## Hard cases (ranked by downloads ÷ difficulty)

Difficulty is **my estimate** (1 = one data entry or verification, 2 = a generic tool feature of a few days,
3 = several generic features or a per-library fork). Score = lead package downloads/week ÷ difficulty. Each reason
quotes the podspec or manifest from the tarball.

| Rank | Library (DL/week) | Exact reason (tarball) | What the tool would have to do that it does not today | Tool fix (generic) or per-library | Diff. | Score |
|---:|---|---|---|---|---:|---:|
| 1 | @react-native-async-storage/async-storage 3.1.1 (6.96M) | `s.ios.vendored_frameworks = "apple-frameworks/SharedAsyncStorage.xcframework"` (static `ar`, slice `ios-arm64`). `AsyncStorage.mm` imports `AsyncStorage-Swift.h`. `resource_bundles` = PrivacyInfo | Read platform-scoped `vendored_frameworks` and emit `.binaryTarget(path:)` as a dependency of the mixed target. Mixed is already handled (fix 10). Optional: copy the privacy file | Generic (scaffolder) | 1.5 | 4.6M |
| 2 | @sentry/react-native 8.32.0 (3.38M) | Own `Package.swift`: `.binaryTarget(name: "Sentry", url: ".../9.31.0/Sentry.xcframework.zip", checksum:)`, separate `RNSentrySwift`/`RNSentryCpp`/ObjC targets, `swiftLanguageMode(.v5)`. The podspec path instead downloads the xcframework in Ruby and sets `user_target_xcconfig`/`other_cflags` | Nothing in the scaffolder (self-managed). Needs SwiftPM on Linux to download, unzip and parse a remote xcframework, and the app to link it (embed too if dynamic). Unverified | Generic (rn-xtool/xtool), if anything | 1 | 3.4M |
| 3 | react-native-nitro-modules 0.37.1 (2.05M), with react-native-mmkv 4.3.2 (1.50M), vision-camera 5.2.3 (0.57M), nitro-image (0.23M) | `pod_target_xcconfig` `"SWIFT_OBJC_INTEROP_MODE" => "objcxx"`, `"CLANG_CXX_LANGUAGE_STANDARD" => "c++20"`. Sources `cpp/**`, `ios/**/*.{swift,mm,cpp}`. In libraries: `load 'nitrogen/generated/ios/<X>+autolinking.rb'; add_nitrogen_files(s)` adds `nitrogen/generated/**` sources and the same xcconfig. mmkv: `s.dependency 'MMKVCore', '2.4.0'`, `s.compiler_flags = '-x objective-c++'` | (a) Detect `nitro.json` (or the `add_nitrogen_files` call) and add the nitrogen globs. (b) Map `SWIFT_OBJC_INTEROP_MODE=objcxx` to `-cxx-interoperability-mode=default` / `.interoperabilityMode(.Cxx)` in a mixed target. (c) Pod map: `MMKVCore` → `github.com/Tencent/MMKV` (product `MMKVCore` exists). (d) Siblings `NitroModules`/`NitroImage` via podToNpm. C++ interop inside an `experimentalMultiLang` target is untested | Generic (one nitro rule covers the ecosystem), plus one pod-map entry | 2 | 1.0M |
| 4 | @shopify/react-native-skia 2.14.0 (1.50M) | Own `Package.swift`: `.package(path: binariesPath)` → npm `react-native-skia-apple-ios` 154.0.1 (218.6 MB), found through `resolvingSymlinksInPath()`, `fatalError` if missing. `SK_METAL`/`SK_GANESH` defines, links MetalKit. Peer `react-native-worklets >=0.7.0` | Nothing in the scaffolder. Verify the local binary package resolves through the `libs/` symlink layout on Linux and that its frameworks link (and embed if dynamic). No `.metal` compile involved | Generic (binary staging), if anything | 1.5 | 1.0M |
| 5 | @react-native-google-signin/google-signin 16.1.5 (1.04M) | `s.dependency "GoogleSignIn", package["GoogleSignInPodVersion"]` (`"~> 9.0"`, read from package.json in Ruby). Also ships `expo/ios/ExpoAdapterGoogleSignIn.podspec` + `expo-module.config.json` | One `KNOWN_POD_SPM_PACKAGES` entry: `GoogleSignIn` → `google/GoogleSignIn-iOS` (its manifest pulls AppAuth, GTMAppAuth, gtm-session-fetcher, GoogleUtilities, app-check). The version comes from a Ruby expression the regex can't evaluate, so the map's exact pin decides. The Expo adapter goes through the Expo plugin | Generic (data entry) | 1 | 1.0M |
| 6 | lottie-react-native 7.5.0 (1.26M) | Own `Package.swift` → `.package(url: "https://github.com/airbnb/lottie-spm.git", exact: "4.6.0")`, whose `Lottie` is a URL `binaryTarget`. lottie-spm says without embedding "the app crash[es] when ran on a physical device" | Embed and sign dynamic frameworks that come from SwiftPM binary targets of library packages. rn-xtool only stages `flavored-frameworks.json` entries (`src/frameworks.ts`) | Generic (rn-xtool) | 1.5 | 0.84M |
| 7 | react-native-purchases 10.16.0 (0.83M) | `spec.dependency "PurchasesHybridCommon", '19.17.0'`. `RNPurchases.h`: `@import PurchasesHybridCommon; @import RevenueCat;`. `DEFINES_MODULE` | One pod-map entry: `PurchasesHybridCommon` → `RevenueCat/purchases-hybrid-common` (its main-branch manifest depends on `purchases-ios-spm`), pinned to the 19.17.0 tag | Generic (data entry) | 1 | 0.83M |
| 8 | @react-native-firebase/app + messaging 27.1.0 (1.45M + 0.86M) | `firebase_dependency(s, firebase_sdk_version, ['FirebaseCore','FirebaseInstallations'], 'Firebase/CoreOnly')` → `spm_dependency` inside `firebase_spm.rb` (1,600+ lines of Ruby). Version from `package.json sdkVersions.ios.firebase` (`13.1.x`). 14 ObjC files import `-Swift.h`. `includesGeneratedCode: true` with `exclude_files` for the RCT*Provider files. `static_framework = $RNFirebaseAsStaticFramework`. Messaging: `firebase_dependency(... FirebaseMessaging ...)` + `RNFBApp` | (a) Support literal `spm_dependency(s, url:, requirement:, products:)` in podspecs (React Native's own CocoaPods helper, so generic). (b) For RNFB the call is inside a helper, so a per-library map from pod name to firebase-ios-sdk products is still needed. (c) Respect `exclude_files` of shipped codegen. Runtime needs `GoogleService-Info.plist` in the app. Messaging push needs APNs (paid account) | Generic (`spm_dependency`) + per-library (RNFB map) | 2 | 0.72M |
| 9 | react-native-vector-icons (v10 0.50M; v14 per-family: common 0.33M, ionicons 0.16M, material-design-icons 0.15M) | v10: `s.resources = "Fonts/*.ttf"` (19 fonts), runtime `CTFontManagerRegisterGraphicsFont` in `loadFontWithFileName`. v14 family pod: `s.resources = 'fonts/*.ttf'` with **no `source_files`**. `UIAppFonts` is filled by the package's `updatePlist` script | Copy `s.resources` of a pod into the **app bundle root** (as bare Resources are copied into `xtool.yml`), not into a SwiftPM resource bundle. Skip emitting a target for a pod without sources, as the Expo patch does for meta pods | Generic (scaffolder + rn-xtool resources) | 1.5 | 0.55M |
| 10 | react-native-permissions 5.6.3 (0.64M) | `s.source_files = "ios/*.{h,mm}"`. Handlers live in `ios/<Permission>/`. The Podfile's `setup_permissions([...])` (`scripts/setup.rb`) **rewrites the podspec in node_modules** (`gsub` of `s.source_files` / `s.frameworks`). `ios/Contacts/*.swift` makes it mixed | rn-xtool ignores the Podfile, so the build passes with no handlers and every permission reports unavailable at runtime. Needs either an rn-xtool config key listing permissions that rewrites the podspec the same way (persisted as a patch), or documentation telling users to run `setup_permissions` themselves | Per-library | 1.5 | 0.43M |
| 11 | react-native-maps 1.29.11 (1.16M) | Subspecs `Generated` / `Maps` / `Google`, `s.default_subspec = 'Maps'`. `ss.script_phases` writes `ios/AirMaps/RNMapsDefines.h` (`HAVE_GOOGLE_MAPS`) at build time. The **published file says `#define HAVE_GOOGLE_MAPS 1`**, which compiles out the Fabric placeholders for an Apple-only build. `includesGeneratedCode: true` and two stray podspecs in `ios/generated/` (`ReactCodegen.podspec`, `ReactAppDependencyProvider.podspec`). `s.module_name = 'ReactNativeMaps'`. `header_mappings_dir './'`, `-std=c++20`. The Google subspec has `GoogleMaps` (SwiftPM = URL binaryTarget + resource bundle), `Google-Maps-iOS-Utils` and `resource_bundles` | (a) Honour `default_subspec` in the regex path (today only with `pod ipc`). Fix 4 merges every subspec, so the Google sources and pods would leak in. (b) Emulate the script phase: write `HAVE_GOOGLE_MAPS 0` for the default build. (c) Ignore nested podspecs under `ios/generated`. (d) `module_name` | (a)(c)(d) generic. (b) per-library | 3 | 0.39M |
| 12 | react-native-config 1.7.2 (0.28M) | `s.script_phase` (`execution_position: :before_compile`) runs `ios/ReactNativeConfig/BuildDotenvConfig.rb` to generate `GeneratedDotEnv.m` and `$BUILD_DIR/GeneratedInfoPlistDotEnv.h` from `.env`. `default_subspec = 'App'` | SwiftPM has no script phases. rn-xtool would need a pre-build hook that runs the Ruby generator (Ruby on the host), or reimplements it, before scaffolding | Per-library | 2 | 0.14M |

Also seen, not ranked:
- **react-native-quick-crypto 1.1.9** (0.23M, difficulty 3). The podspec downloads `QuickCryptoOpenSSL-3.6.2.zip` with
  curl and checks its sha256 **when it is evaluated**, then `s.vendored_frameworks = "ios/openssl/QuickCryptoOpenSSL.xcframework"`.
  With `SODIUM_ENABLED=1` it also runs a libsodium `prepare_command`. It needs the nitro rule (rank 3), a per-library
  pre-download step and `binaryTarget` emission (rank 1).
- **react-native-video 6.19.3**: the optional pods are gated by Podfile globals (fact 6). Needs a generic rule that
  treats `if defined?($Global)` / `ENV[...]` blocks as off.
- **react-native-fast-image**: four SDWebImage-family pods. Map entries only.

What would buy the most, in order (my reading of the scores):
1. `binaryTarget` emission from `vendored_frameworks`. This unlocks async-storage 3.x, and is a prerequisite for
   quick-crypto.
2. Verifying binary artifacts and dynamic-framework embedding (Sentry, Skia, Lottie).
3. Three pod-map entries (GoogleSignIn, PurchasesHybridCommon, MMKVCore).
4. The nitro rule.
5. `spm_dependency` support plus the RNFB map.

## 4. How to run it (sketch)

**Matrix apps.** There is one app per supported target, all generated from templates and checked into the
rn-xtool repo under a test-fixtures directory. Each pins exact library versions in `package.json`, so upgrades are
deliberate PRs.

| App | Base | Suite libraries |
|---|---|---|
| `matrix-expo58` | Expo SDK 58 / RN 0.88.0 | Core 1-13 |
| `matrix-bare088` | bare RN 0.88.0 | Hybrid with Expo modules (`install-expo-modules`), so 7-9 also run. Otherwise core 1-6 and 10-13 |
| `matrix-bare0871` | bare RN 0.87.1 | Core 1-6 and 10-13. Expo modules are impossible (SDK 58 needs 0.88.0) |
| `matrix-bare0863` | bare RN 0.86.3 | Same as 0.87.1. 0.86.2: build-only, as today |

Peer ranges allow all of these: reanimated/worklets `0.86 - 0.88`, lottie `>=0.84`, skia `>=0.78`, the rest `*` or
older.

- **Screens.** Each app has one screen per library. It exercises one native call or view and renders a pass/fail line
  (for example: haptics fires; SVG draws; WebView loads `about:blank`; MMKV set/get round-trips; Sentry
  `captureMessage` with a dummy DSN returns without crashing; Lottie plays a bundled JSON; Firebase `getApp()` returns
  the default app). The navigation combo is the app's own shell: a native-stack over the screens, inside
  `SafeAreaProvider` and `GestureHandlerRootView`, with one reanimated animation.
- **Known gaps (14-16) and not-yet-green core items (10-13).** A refused or failing native lib stops the whole app
  build (for example, an expo-sqlite refusal fails the sync). So known gaps never go into the matrix apps. Each gets
  its own **canary app**, or its own branch of `matrix-expo58`, built in a separate CI job marked "expected to fail".
  The job turns red the day the canary *starts building*, so the gap gets promoted on purpose. Items 10-13 begin as
  canaries too, and join the matrix app when green.
- **Libraries that cannot coexist in one app:**
  - Two camera libraries (expo-camera / vision-camera / camera-kit) all claim the capture session. If added, put each
    in its own app, or in screens that are never mounted together.
  - react-native-mmkv and react-native-mmkv-storage: MMKVCore vs MMKV pods, so duplicate symbols.
  - expo-image and react-native-fast-image both pull SDWebImage. SwiftPM resolves one version, so the pins must
    overlap: expo-image pins `exact 5.21.6`, and fast-image's podspec says `>= 5.21.5, < 6.0`.
  - Firebase and Google Sign-In both depend on `GoogleUtilities` and `app-check`, which must resolve to one version.
    Keep them in one app on purpose to catch exactly that.
  - async-storage 2.x and 3.x are the same package. A 2.x row means a separate app.
- **CI build-only pass**, on every PR that touches patches, `vendor/rn-spm` or the pipeline. For each matrix app:
  `rn-xtool doctor` then `rn-xtool build --clean`. Gate on a produced `App.app`, and on `otool`-style symbol checks
  that each library's module class is present (as libraries.md did for expo-application). The runner needs the
  Darwin SDK extracted from the maintainer's own `Xcode.xip` (about 12 GB, licence-bound). That means a self-hosted
  runner or a private cache, and it has to be an explicit decision. Remote SwiftPM packages (SwiftUIIntrospect, lottie-spm,
  Sentry.xcframework, SDWebImage, firebase-ios-sdk, MMKV) need network or a warmed `.build` cache.
- **Device pass before each release.** Install each matrix app on the physical iPhone (Wi-Fi or USB). Open every
  screen and record ✅/❌ and the date in libraries.md's per-version columns. A **free Apple account allows 3 apps at a
  time** (README). Either give all matrix apps one bundle identifier, so each install replaces the previous one, or
  run the versions one after another and remove apps between them. Firebase Messaging push, StoreKit and Google
  Sign-In need paid accounts or service keys, so they stay build-only or "init returns" checks.
