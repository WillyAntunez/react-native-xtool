# Binary CocoaPods pods: Google ML Kit text recognition (design)

Status: short design, 2026-11-04, draft for Willy's approval. This is the third work-app compatibility block, after
the [React Native 0.85 line](2026-11-04-rn-085-line-design.md) and
[library compatibility](2026-11-04-library-compat-design.md). It fills the `binary` route that block 2's pod resolver
leaves room for, so it builds on block 2's group C (the classifier, the pod table and the `unmapped-pod` refusal).
The research notes are kept outside the repo: a study of the ML Kit pod graph read from the CocoaPods CDN, with the
ten Google tarballs downloaded and inspected (nothing from them was run), and a survey of tools that turn pods into
SwiftPM packages. The facts this design rests on are restated here with their sources.

## Intent

The work app uses @react-native-ml-kit/text-recognition 2.0.0. Its podspec depends on `GoogleMLKit/TextRecognition`
and four language subspecs at 8.0.0. Behind that name sit ten pods that Google ships as `.tar.gz` downloads of static
`.framework` binaries, plus five open-source pods. With block 2, rn-xtool refuses the library early and offline, and
`exclude` is the only way through.

No public tool consumes binary pods through SwiftPM on Linux. The pieces it takes do exist, though:
- the CocoaPods CDN serves every trunk podspec as JSON, and it stops changing on 2026-12-02;
- SwiftPM reads an xcframework as a directory with an `Info.plist`, which rn-xtool already writes on Linux;
- xtool copies the files listed in `xtool.yml` `resources:` to the app root, where ML Kit looks for its models.

This block turns them into general mechanisms, not ML-Kit-only code:

1. a resolver for binary pods over the CDN JSON specs, with a cache and a sha256 lock file the project commits;
2. a wrap step that makes each static vendored framework usable by SwiftPM on Linux, in a generated package under
   `ios/build`;
3. the binary pods' source dependencies, through block 2's pod table;
4. podspec `resource_bundles` built as `<Name>.bundle` at the app root, for binary pods and for scaffolded libraries;
5. clear lines before anything is downloaded, and a clear stop when offline;
6. Google's binaries never shipped, committed or persisted.

Owner's rule, as before: mechanisms over versions. Each step follows a content fact (a spec key, a Mach-O header, an
archive magic, a module map), never a pod name or a version number.

## Facts

### The library and its pod graph

1. **The library.**
   - `RNMLKitTextRecognition.podspec` (2.0.0) depends on `React` and on `GoogleMLKit/TextRecognition`,
     `…/TextRecognitionChinese`, `…/TextRecognitionDevanagari`, `…/TextRecognitionJapanese` and
     `…/TextRecognitionKorean`, each `'8.0.0'`. It sets `s.platforms = { :ios => "15.5" }`.
   - `ios/TextRecognition.m:3-9` does `@import MLKitVision.MLKVisionImage;`, then `@import` of MLKitTextRecognition,
     MLKitTextRecognitionCommon and the four language modules. It is an old-architecture module (`RCTBridgeModule`)
     without `codegenConfig`.
   - rn-xtool's `IOS_MIN` is 16.4 (`src/versions.ts:14`).
2. **The graph**, read from the CDN JSON specs on 2026-11-04 (newest version that satisfies every requirement, subspecs
   followed):

   | Pod | Version | Requirement(s) | Kind | Download (tar.gz) |
   |---|---|---|---|---|
   | GoogleMLKit (subspecs TextRecognition…, MLKitCore) | 8.0.0 | `8.0.0` | http; MLKitCore holds only `MLKit.h` and a `module MLKit` map | 463 KB |
   | MLKitTextRecognition | 6.0.0 | `~> 6.0.0` | http, vendored framework, resource bundle `LatinOCRResources` | 812 KB |
   | MLKitTextRecognitionChinese / Devanagari / Japanese / Korean | 5.0.0 each | `~> 5.0.0` | http, vendored framework, one `…OCRResources` bundle each | 1.66 / 1.28 / 1.55 / 1.48 MB |
   | MLKitTextRecognitionCommon | 5.0.0 | `5.0.0` | http, vendored framework | 30.3 MB |
   | MLKitVision | 9.0.0 | `~> 9.0` | http, vendored framework | 351 KB |
   | MLKitCommon | 13.0.0 | `~> 13.0.0`, `~> 13.0` | http, vendored framework | 2.47 MB |
   | MLImage | 1.0.0-beta7 | `" 1.0.0-beta7"` | http, vendored framework | 7 KB |
   | GTMSessionFetcher (Core) | 3.5.0 | `>= 3.3.2, < 4.0` | git source | — |
   | GoogleToolboxForMac (Logger, NSData+zlib) | 4.2.1 | `>= 4.2.1, < 5.0` | git source, MRC | — |
   | GoogleUtilities (Logger, UserDefaults) | 8.1.5 | `~> 8.0` | git source | — |
   | GoogleDataTransport | 10.1.1 | `~> 10.0` | git source; depends on nanopb and PromisesObjC | — |

   - The ten http tarballs total 40,332,871 bytes (about 40.3 MB, measured). Unpacked they take about 139 MB, and the
     arm64 slices of the binaries about 58 MB.
   - Every URL is `https://dl.google.com/dl/cpdc/<id>/<Pod>-<version>.tar.gz`. No http source carries a checksum.
   - The tarballs have no top-level folder: `./Frameworks/<X>.framework/…` and `./Resources/<Key>/…` sit at the root.
   - The spec license is `{"type": "Copyright", "text": "Copyright 2024 Google LLC"}` (MLImage: 2025), and the
     homepage is `https://developers.google.com/ml-kit/guides`. Use is governed by the ML Kit Terms
     (https://developers.google.com/ml-kit/terms).
3. **GoogleMLKit itself is almost empty.**
   - It has an http source but no `vendored_frameworks`. Its `MLKitCore` subspec declares
     `source_files: ["MLKitCore/Sources/MLKit.h"]`, keeps `MLKitCore/Sources/module.modulemap`
     (`module MLKit { export * header "MLKit.h" }`), and depends on `MLKitCommon ~> 13.0.0`.
   - `MLKit.h` imports `<MLKitCommon/MLKitCommon.h>` and, under `__has_include`, the umbrella header of each ML Kit
     feature. The library does not import it.
   - Its `default_subspecs` is `Common`; the library names subspecs, so the default does not apply.
4. **The binaries.** Checked with `file` and `llvm-lipo -info`:
   - Every framework is static and fat, x86_64 (simulator) plus arm64 (device). There is no arm64-simulator slice
     (the specs set `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64`).
   - The arm64 slice of MLKitTextRecognitionCommon is a single prelinked `MH_OBJECT` (53.1 MB) with no
     `LC_BUILD_VERSION` and an `LC_LINKER_OPTIMIZATION_HINT`. The other slices are `ar` archives: MLKitCommon
     (313 members, `platform ios`, `sdk 18.0`, `minos 15.5`, 4.7 MB) and the small ones (4 KB to 214 KB).
   - No binary has Swift symbols. No framework carries an `Info.plist`. MLKitCommon and MLKitTextRecognitionCommon
     carry a `PrivacyInfo.xcprivacy` inside the `.framework`.
   - d-date/google-mlkit-swiftpm records the same shapes: some ML Kit binaries are bare `MH_OBJECT`s, which Xcode
     relinks as dynamic and dead-strips, losing the OCR model ("Invalid model path."); its fix is to wrap them in an
     `ar` archive (`scripts/postprocess_xcframeworks.rb`).
5. **Headers and module maps.**
   - Each framework has `Headers/` and `Modules/module.modulemap`:
     `framework module X { umbrella header "X.h" export * module * { export * } link "c++" … link framework "Metal"
     … }`. MLKitTextRecognitionCommon's map links c++, dl, m, pthread and z, and 16 frameworks including Metal,
     OSLog and OpenGLES.
   - Headers include each other framework-style: `<MLKitVision/MLKVisionPoint.h>`, `<MLImage/GMLImage.h>`,
     `<MLKitTextRecognitionCommon/MLKTextRecognizer.h>`.
   - Every framework and library the maps and specs name exists as a `.tbd` in the xtool Darwin SDK (iPhoneOS27.1).
     The compiler-rt symbols the binaries use (`___chkstk_darwin`, `___floattidf`, `___udivti3`) are in
     `libSystem.B.tbd`.
   - The objects carry no `LC_LINKER_OPTION`, so system libraries come from module-map autolinking in the importing
     objects, or from explicit link settings.
   - The specs' `frameworks` and `libraries` lists add LocalAuthentication, Accelerate, CoreImage, CoreLocation and
     sqlite3 to what the maps name.
6. **What the binaries need from the source pods** (`llvm-nm -u` against the defined symbols): `GULOSLogBasic`,
   `GULOSLogError`, `GULUserDefaults` (GoogleUtilities); `GDTCORTransport` (GoogleDataTransport); `GTMLogger`, which is
   subclassed, and `GTMLogMininumLevelFilter` (GoogleToolboxForMac); `GTMSessionFetcher`,
   `GTMSessionFetcherService`, `GTMSessionCookieStorage` and `kGTMSessionFetcherStatusDomain` (GTMSessionFetcher);
   `GMLImage` (MLImage).
7. **Registration at load time.**
   - MLKitCommon defines `+load` methods (`+[MLKITx_SRLRegistry load]`, `+[MLKCustomModelManager load]`,
     `+[MLKAnalyticsLogger load]`) and has `__objc_catlist` in 13 members.
   - CocoaPods links apps with `-ObjC`. rn-xtool's App target already passes `-Xlinker -ObjC`
     (`src/generate/packageSwift.ts:147`).
   - d-date's README asks for `-ObjC` and `-all_load`: "ML Kit ships as static archives that register classes and
     models through Objective-C categories and static initialisers."
8. **The models.**
   - `resource_bundles` are `LatinOCRResources` (772 KB), `ChineseOCRResources` (2.0 MB), `DevanagariOCRResources`
     (1.5 MB), `JapaneseOCRResources` (1.9 MB) and `KoreanOCRResources` (1.8 MB). Each is a glob over the tarball
     (`Resources/LatinOCRResources/**`), not a prebuilt `.bundle`. CocoaPods makes the `.bundle` and its `Info.plist`
     at build time.
   - The binaries find them by name (`strings` shows `LatinOCRResources.bundle` with `bundleForClass:` and
     `mainBundle`). For a static link that is the main bundle, so each must be `App.app/<Key>.bundle`.
   - A missing bundle shows only at the first recognition: `MLKTextRecognizerInternalErrorCreationFailure`, "Invalid
     model path." (d-date README).
9. **The source pods have SwiftPM packages**, checked by reading `Package.swift` at the tag:

   | Pod | Package | Tag | Products needed |
   |---|---|---|---|
   | GTMSessionFetcher 3.5.0 | https://github.com/google/gtm-session-fetcher | `v3.5.0` (tools 5.3) | `GTMSessionFetcherCore` |
   | GoogleUtilities 8.1.5 | https://github.com/google/GoogleUtilities | `8.1.5` (tools 5.9) | `GULLogger`, `GULUserDefaults` |
   | GoogleDataTransport 10.1.1 | https://github.com/google/GoogleDataTransport | `10.1.1` (tools 5.9) | `GoogleDataTransport` |
   | GoogleToolboxForMac 4.2.1 | https://github.com/google/google-toolbox-for-mac | none at v4.2.1 or v5.0.0 (HTTP 404); first at v6.0.0, tools 6.0 | v6: `GTMLogger`, `GTMNSData_zlib` |

   - GoogleDataTransport's manifest pins nanopb `2.30910.0..<2.30911.0` and promises `2.4.0..<3.0.0` itself. Firebase
     renumbered nanopb 3.x to 2.x for SwiftPM.
   - GoogleToolboxForMac v5.0.0 had "no actual code changes", and v6.0.0 changed the layout and moved some code to
     ARC. The ObjC symbols ML Kit uses (`GTMLogger`, `GTMLogMininumLevelFilter`) are in v6.0.1.
   - The packages' privacy manifests are `.process("Resources/PrivacyInfo.xcprivacy")` resources.
10. **No official ML Kit SwiftPM package.** A maintainer said ML Kit is available only through CocoaPods
    (googlesamples/mlkit #26), and the SwiftPM request (#763) is "not a top priority". d-date/google-mlkit-swiftpm
    (Apache-2.0) repackages ML Kit 9 into xcframeworks hosted as its own GitHub release assets, which redistributes
    Google's binaries. Its README says the resource bundles must be added to the app by hand.

### The CocoaPods CDN

11. **Reading it needs no Ruby.**
    - Spec: `https://cdn.cocoapods.org/Specs/<a>/<b>/<c>/<Pod>/<version>/<Pod>.podspec.json`, where a, b, c are the
      first three hex digits of `md5(<Pod>)`. It answers 301 to `cdn.jsdelivr.net/cocoa/Specs/…`, which needs a
      `User-Agent` header.
    - Versions: `https://cdn.cocoapods.org/all_pods_versions_<a>_<b>_<c>.txt`, one `Pod/ver1/ver2/…` line per pod.
    - A requirement is a string (`"~> 13.0"`) or an array whose items may carry leading spaces
      (`[">= 3.3.2", " < 4.0"]`, `[" 1.0.0-beta7"]`).
    - An http source may also carry `type`, `flatten`, `sha1` and `sha256` (CocoaPods podspec reference,
      https://guides.cocoapods.org/syntax/podspec.html#source). ML Kit's carry none of them.
12. **It freezes.** Trunk becomes read-only on 2026-12-02. The Specs repo and the CDN stay up "as long as GitHub and
    jsDelivr do" (CocoaPods blog, "CocoaPods Specs Repo"). After that date no version is added or changed.

### SwiftPM and xtool

13. **An xcframework is a directory.**
    - SwiftPM reads only `AvailableLibraries[]` from `<x>.xcframework/Info.plist` (`LibraryIdentifier`,
      `LibraryPath`, `HeadersPath`, `SupportedPlatform`, `SupportedArchitectures`, `SupportedPlatformVariant`;
      `XCFrameworkMetadata.swift`). It picks the first slice that matches platform, variant and arch
      (`BinaryTarget+Extensions.swift`).
    - A `LibraryPath` ending in `.framework` is linked with `-framework`. Any other is linked by path
      (`BuildPlan+Product.swift`).
    - The Linux gate (`--experimental-xcframeworks-on-linux`) applies only when the build targets Linux. xtool builds
      for `arm64-apple-ios`, so xcframeworks are processed (`BuildPlan.swift`).
    - `binaryTarget(path:)` needs no checksum (SE-0272). Unsafe flags are allowed in root and local packages, and
      the check is off from tools 6.2 (`PackageBuilder.swift`).
14. **rn-xtool already writes xcframeworks on Linux.**
    - `headersXcframeworkInfoPlist` (`src/pipeline/rnArtifacts.ts:181-198`) writes `BinaryPath`, `HeadersPath`,
      `LibraryIdentifier`, `LibraryPath` and the platform keys, plus `CFBundlePackageType XFWK`.
    - `adaptSlot` uses it for ReactNativeHeaders and ReactNativeDependenciesHeaders (`rnArtifacts.ts:416, 425-426`),
      and `writeJsiHeadersXcframework` uses it for ExpoModulesJSIHeaders (`src/pipeline/jsiHeaders.ts:134`).
    - Their slices hold an empty `ar` placeholder (`EMPTY_AR_ARCHIVE`, `rnArtifacts.ts:140`; `jsiHeaders.ts:128`)
      and `Headers/<Name>/` with a module map (`jsiHeaders.ts:123-127`).
    - So library-type xcframeworks with headers and module maps already build through rn-xtool. **No slice holding
      real code has been linked through rn-xtool yet.**
    - React and Hermes are dynamic frameworks. They are linked with `-F` and `.linkedFramework` on the App target
      (`packageSwift.ts:146-151`) and copied through the `Frameworks` resource (`src/generate/xtoolYml.ts:9`).
15. **What xtool packs** (source at 2af0b67, newer than the pinned 1.24.0):
    - For each binary target in the App product's graph (`Sources/PackLib/Planner.swift:144-146`), the Packer reads
      `<name>.framework/<name>` from the build directory. A missing file is skipped ("it might be a static framework
      … we don't need to pack it anyway"). A file that starts with `!<arch>\n` or `!<thin>\n` is not embedded. Any
      other is copied to `Frameworks/` and signed as a dynamic framework (`Packer.swift:166-180`).
    - Open issue #130: xtool looks for `<xcframework name>.framework`, and a fat static framework (`CAFEBABE`) is
      treated as dynamic.
    - `xtool.yml` `resources:` entries are copied to the app root under their last path component (`packFileToRoot`,
      `Packer.swift:142-148`).
16. **rn-xtool's app resources.**
    - `writeIosXtool` removes and rebuilds `ios-xtool/Resources` on every build (`src/generate/iosXtool.ts:124-127`)
      and lists each entry as `Resources/<name>` in `xtool.yml` (`iosXtool.ts:170-177`).
    - `ios-xtool/.gitignore` holds `*` (`iosXtool.ts:197`).
    - The bare 0.88 template's `.gitignore` lists `build/`.
17. **The tools at hand.** The Swift 6.4.1 toolchain `setup` installs ships `llvm-ar`, `llvm-ranlib`, `llvm-objdump`,
    `llvm-nm`, `llvm-objcopy` and `ld64.lld`, but **no `llvm-lipo`** (its `usr/bin`, listed 2026-11-04). rn-xtool
    already needs `llvm-nm` (doctor's `llvm-nm` line, `src/commands/doctor.ts:510`) and runs the system `tar`
    (`src/commands/setup.ts:273`).

### rn-xtool's downloads and cache

18. **Where things live.**
    - `cacheDir()` is `$XDG_CACHE_HOME/rn-xtool`, or `~/.cache/rn-xtool` (`src/paths.ts:68-71`). Today it holds the
      xtool AppImages and pair records.
    - React Native's artifacts go to `~/Library/Caches/ReactNative/spm-artifacts` (`src/pipeline/rnArtifactsStep.ts:13-15`)
      and are fetched by React Native's own script, with no checksum. A slot counts as complete when `artifacts.json`
      points at existing xcframeworks (`rnArtifactsStep.ts:25-39`).
19. **`downloadFile`** (`src/tools/download.ts:20-53`):
    - it streams to `<dest>.<pid>.part`, renames on success, retries once, and times out after 15 minutes;
    - it rejects a file of `minBytes` or less, 1 MiB by default (lines 25 and 35). Four ML Kit tarballs are smaller:
      MLImage (7 KB), MLKitVision (351 KB), GoogleMLKit (463 KB) and MLKitTextRecognition (812 KB);
    - a sha256 mismatch is not retried, and its message points at `src/versions.ts`.
20. **Writing a tree safely.** `writeJsiHeadersXcframework` assembles beside the destination, swaps the tree in whole
    (`swapIn`, `rnArtifacts.ts:459`) and writes its stamp last (`jsiHeaders.ts:75-145`).
21. **Network in the checks.**
    - The early checks read files only and make no network request (`src/project/earlyChecks.ts:1-5`;
      `docs/troubleshooting.md:169`).
    - `doctor --project`'s `rn-artifacts` line sends HEAD requests with a 10 s budget in total, and a failed probe is
      a warning, `not checked: <reason>` (`docs/troubleshooting.md`, "doctor --project").

### What block 2 leaves for this block

22. **The resolver and its table** (block 2 spec goal 3; plan group C):
    - `classifyPodDependency` (`vendor/rn-spm/spm/scaffold-package-swift.js:187-236` on the block-2 branch) returns
      `subspec`, `core`, `sibling`, `missing-sibling`, `expo`, `mapped` or `unmapped`. Its result "has room for a
      `binary` route without changing its callers".
    - rn-xtool ships `data/pods.json`, merges it with the config's `pods` over the scaffolder's baseline, and hands the
      result to the scaffolder as `ios/build/rn-xtool-pods.json`, named by `RN_SPM_POD_TABLE`. An entry is
      `{ url, exact, products, subspecs?, forwardHeaders? }`.
    - `unmapped-pod` refuses offline a library whose podspec depends on a pod with no table entry. ML Kit is refused
      by it, naming `GoogleMLKit` once.
    - A pin outside the podspec's requirement is a ⚠, not a refusal (block 2's ruling on its open question 6).
    - Each scaffold records its pins on a `// rn-xtool-pods:` line, and a later change makes a persisted patch stale.
    - At the time of writing, block 2's first PR is built on its branch and group C is not.
23. **How a scaffold reaches files outside its package.** Paths are relative to the `libs/<SwiftName>` symlink, for
    example `build/xcframeworks` (`scaffold-package-swift.js:1845-1871`), so a persisted manifest holds no absolute
    path. `persistScaffoldArgv` runs patch-package on `node_modules/<lib>`, so anything written there ends up in the
    user's `patches/`.
24. **Resources today.**
    - Block 2's `unbundledResources` (`src/pipeline/scaffoldResources.ts`) reads each scaffolded library's
      unconditional `s.resource_bundles` / `s.ios.resource_bundles` and `s.resources`, and prints one ℹ line. The F1
      proof printed `ℹ Not copied into the app: react-native-device-info (PrivacyInfo.xcprivacy). …`.
    - react-native-svg 15.16.0 declares `s.ios.resource_bundles = {'RNSVGFilters' => ['apple/**/*.iphoneos.metallib']}`
      (`RNSVG.podspec:26`). The `.metallib` files ship prebuilt in the npm package, under `apple/Filters/MetalCI/`.
    - `docs/libraries.md:58-59` names "`resource_bundles` support … emit the bundle as a SwiftPM resource" as the next
      scaffolder fix. A SwiftPM resource becomes `<package>_<target>.bundle` (fact 15), not the name the code looks up.
25. **A library's own binaries.** `binariesFailure` (`earlyChecks.ts:223-241`) refuses a library whose own podspec
    declares `vendored_frameworks` or `vendored_libraries`. @react-native-async-storage/async-storage 3.x is refused
    that way (`docs/libraries.md:50`). That is a different input: the binary sits in the npm package and nothing is
    downloaded.
26. **Baseline and disk.**
    - Block 2's F1 build-only proof (bare 0.88.1 and four libraries): the build took 77 s, `.build` was 574 MB, App.app
      84 MB and its binary 3.99 MB.
    - The build disk had 13 GB free on 2026-11-04.

### What the spike gate proved (G1, 2026-11-05)

27. **The proposed link shape links** (open question 1; fallbacks A and B not needed). ML Kit, wrapped by rn-xtool's
    own code and staged by hand, links into the F1 app: 477 classes from the nine archives reach the App binary, no
    ML Kit framework is embedded, and the model bundles land at `App.app/<Key>.bundle`. Four things it needed:
    1. **The package's platform is the app's deployment target**, not rn-xtool's 16.4. SwiftPM refuses a product
       whose minimum is above its dependent's: `The package product 'GoogleMLKit-product' requires minimum platform
       version 16.4 for the iOS platform, but this target supports 15.1`. The scaffolds use the app's deployment
       target (15.1 for a bare 0.88 app).
    2. **The wrapper C target needs its `include/` folder**: `public headers ("include") directory path for
       'GoogleMLKitWrapper' is invalid or not contained in the target`.
    3. **`-Xlinker -no_objc_relative_method_lists` on the App target.** Without it, xtool's `ld64.lld` 21.1.6 crashes
       in `ObjCMethListSection::setUp()` on MLKitTextRecognitionCommon's object, even when that object is linked alone
       into a dylib (an upstream lld bug; the archive wrap and the link shape are not the cause).
    4. **A target without sources is listed at link anyway.** GoogleToolboxForMac 6.0.1's header-only `GTMDefines`
       gets no `GTMDefines.o`, but Swift Build lists it: `Build input file cannot be found:
       '…/Products/Debug-iphoneos/GTMDefines.o'`. An empty arm64 object at that path, the one clang writes for an
       empty C file, lets the link pass.
    - Measured: resolution 3.2 s, 40.3 MB downloaded (every sha256 as expected), wrap 2.1 s; the pods cache 237 MB,
      `.build` 1.1 GB, App.app 141 MB (+57 MB), the App binary 50 MB.

## Goals

### 1. The binary-pod resolver

1. **Where it runs.**
   - A new `pods` step, right after the early checks and before anything changes in the project (no `expo prebuild`,
     no patches).
   - It writes only into rn-xtool's cache, plus the lock file when the step succeeds.
   - Staging into `ios/build` is a separate step, after `expo prebuild` and the patches and before `rn-spm`
     (goal 2.5).
2. **What it starts from.**
   - Each library rn-xtool would scaffold: the unconditional `s.dependency` lines and their requirements, which block
     2's reader already returns.
   - Only pods that block 2's classifier calls `unmapped` go on; a table entry always wins.
   - Packages left out through `exclude`, `platforms.ios: null` or `expo.autolinking.exclude` are skipped.
3. **The specs.**
   - It reads the version index and the spec JSON from the CDN, following redirects, with `User-Agent:
     rn-xtool/<version>`.
   - Each file is cached under `<cache>/pods/specs/`. A spec is never fetched again: a version's spec does not change,
     and trunk freezes on 2026-12-02 (fact 12). The version index is read again for a pod the lock does not record
     (once per resolution), and for a pod whose locked version no longer satisfies a requirement (row 71).
   - The parser normalises requirements (string or array, items trimmed) and reads `subspecs`, `default_subspecs`
     (used when a dependency names the root pod), and `ios`-scoped attributes.
4. **Routes.** For each pod, from its spec:
   - http source with `vendored_frameworks`, and no `vendored_libraries` or compiled `source_files` → **binary**;
   - http source whose selected subspecs hold only headers in `source_files` (GoogleMLKit/MLKitCore) → **binary**,
     headers only (goal 2.3);
   - a git source → the block-2 table. A pod with no entry gets block 2's `unmapped-pod` text, with the chain that
     reached it (`MLKitCommon 13.0.0, needed by @react-native-ml-kit/text-recognition, depends on …`);
   - anything else: a shape this block does not cover (goal 2.6).
5. **Versions.**
   - Requirements are collected from every dependent: libraries and binary pods. Each pod gets the newest listed
     version that satisfies all of them, using block 2's matcher (`podRequirementSatisfied`).
   - A prerelease (`1.0.0-beta7`) is chosen only when a requirement names a prerelease, as in CocoaPods.
   - Resolution is greedy, without backtracking. When no version satisfies every requirement, the step stops and
     lists each requirement with who imposed it.
   - Dependencies are walked through binary pods only. A pod mapped to a SwiftPM package brings its own dependencies
     through its manifest, so nanopb and PromisesObjC are never resolved here (fact 9).
6. **The lock file.**
   - `rn-xtool-pods.lock.json` sits at the project root, next to `rn-xtool.config.json`, and the project commits it.
   - Per binary pod it records the version, the subspecs used, the source URL, the download's size and sha256, and
     the libraries that need it. It holds hashes and URLs only, never file contents.
   - **First run records, later runs verify.** A pod missing from the lock is downloaded, and its hash is recorded
     when the whole step succeeds: `ℹ pods — recorded the sha256 of 10 downloads in rn-xtool-pods.lock.json; commit
     it, so other machines check that they get the same files.`
   - Later runs use the locked version while it still satisfies the requirements, so `~> 13.0.0` does not move to a
     newer MLKitCommon by itself. A locked version that no longer satisfies them (after a library upgrade) is
     resolved again and recorded again, with an ℹ line naming the old and new versions.
   - A spec's own `source.sha256` (or `sha1`) is checked too, when it has one.
   - Entries no longer used (a library removed or excluded) stay in the lock and are listed by `doctor --project`.
     They are never pruned automatically, so toggling `exclude` keeps the recorded hashes (open question 7).
7. **The downloads.**
   - They go into `<cache>/pods/downloads/`, through `downloadFile` with `minBytes` set from the expected size, not
     the 1 MiB default (fact 19), and with the size checked against `Content-Length`.
   - A file whose sha256 differs from the lock is deleted, and the step stops. It is not retried (row 18).
   - A spec URL that differs from the lock's is downloaded and checked against the locked sha256. When the hash
     matches, the lock's URL is updated with an ℹ line; otherwise row 18 applies.
   - The cache is keyed by sha256, so two projects share one copy, and a file whose hash matches is never downloaded
     again.
8. **Extraction.**
   - Before extracting, rn-xtool lists the archive (`tar -tzvf`, or `unzip -Z1` for `.zip`). An absolute path, a `..`
     segment, a device file, or a link that points outside the tree refuses it.
   - Only what the spec needs is extracted: the vendored framework directories, the `resource_bundles` globs, and
     header `source_files`. `flatten` is honoured.
   - It works in a fresh temporary directory per pid and swaps the result in. A stamp is written last, as
     `writeJsiHeadersXcframework` does (fact 20).

### 2. Wrapping static binaries for SwiftPM

1. **Inspect, then thin.** A small Node Mach-O reader replaces `llvm-lipo`, which the toolchain does not ship
   (fact 17):
   - fat (`CAFEBABE` or `CAFEBABF`): the arm64 slice is cut out (CPU type arm64, subtype ALL; arm64e is not
     accepted as arm64);
   - thin arm64: kept as it is;
   - no arm64 slice: the step stops (row 26).
   - A slice, or any member of an archive slice, whose `LC_BUILD_VERSION` names the iOS simulator stops the step. A
     member with no platform load command is accepted, as found in MLKitTextRecognitionCommon.
2. **Every binary becomes a thin arm64 `ar` archive.**
   - An `ar` slice is kept as it is. An `MH_OBJECT` slice is wrapped with the toolchain's `llvm-ar`
     (`rcs --format=darwin`), so it gets a Darwin symbol index.
   - An `MH_DYLIB` slice, or a framework with a `Modules/*.swiftmodule`, is a shape this block does not cover
     (goal 2.6).
   - A vendored `.xcframework` is read with `readXcframeworkLibraries` (fact 14). Its `ios-arm64` device slice goes
     through the same steps.
3. **Headers and module maps** come from the framework.
   - Proposed layout (open question 1): one library-type xcframework per framework,
     `<Name>.xcframework/ios-arm64/Headers/<Name>/`, with the framework's headers and its module map. That is the
     shape of ExpoModulesJSIHeaders, which already builds.
   - The module map is rewritten by content: the leading `framework` keyword goes, and everything else stays,
     including the `link` lines, so autolinking still works. A map with anything else that names the framework
     bundle (`module.private.modulemap`, a `framework` submodule) stops the step and names the file.
   - A framework without `Modules/module.modulemap` gets `module <Name> { umbrella header "<Name>.h" export * module * {
     export * } }`, when `Headers/<Name>.h` exists. Otherwise the step stops and names the framework.
   - A headers-only http subspec (GoogleMLKit/MLKitCore) becomes a headers-only xcframework named by the pod's
     `module_name` (`MLKit`), with the pod's own module map when it keeps one.
   - `Info.plist` comes from `headersXcframeworkInfoPlist`, with a single `ios-arm64` entry and no variant.
4. **Linking: the real archive once, by `-force_load`.**
   - Proposed (open question 1): each slice's `LibraryPath` holds the empty placeholder archive, as in today's
     headers xcframeworks. The real archive lives beside the xcframework, as
     `ios/build/pod-binaries/archives/lib<Name>.a`.
   - rn-xtool's root `ios-xtool/Package.swift` (App target) adds `-Xlinker -force_load -Xlinker <archive>` per
     binary-pod archive. These are absolute paths in a manifest regenerated on every build, never persisted.
   - There is no global `-all_load`, which would also pull every member of React Native's and other libraries'
     archives.
   - The archive is linked exactly once. SwiftPM and Swift Build never see it, so nothing copies it to another path
     or links it a second time (row 44).
   - The spec's `frameworks` and `libraries` become `.linkedFramework` and `.linkedLibrary` on the App target too.
     `weak_frameworks` becomes `-weak_framework`.
   - With binary pods linked, and only then, the App target also gets `-Xlinker -no_objc_relative_method_lists`
     (fact 27.3, row 80).
   - A table entry's `emptyTargets` (GoogleToolboxForMac: `GTMDefines`) get an empty arm64 object at
     `ios-xtool/.build/out/Products/Debug-iphoneos/<Target>.o` before `xtool-build`, unless one is there (fact 27.4,
     row 81).
   - These archives contain the `+load` classes of fact 7, so `-force_load` keeps them whatever `-ObjC` does.
5. **The generated package**, under `ios/build/pod-binaries/`:
   - `Package.swift` (tools 6.0, the app's deployment target as the scaffolds read it, fact 27.1) with one
     `.binaryTarget(name:path:)` per wrapped framework, and one product per root pod a library names (`GoogleMLKit`).
   - Each product lists its binary targets and a wrapper C target. The wrapper holds one generated `.c` file and its
     `include/<Wrapper>.h` (fact 27.2), and depends on the source products (goal 3). Listing the binary targets in the product puts their headers on the
     dependent library directly, without relying on transitive propagation.
   - When two libraries name subspecs of the same pod, the product covers the union of them, as CocoaPods installs
     one pod with all requested subspecs.
   - `xcframeworks/` and `archives/` are copies of the cache, never hard links (row 85: an edit there never reaches the
     cache). A `.gitignore` holds `*`.
   - The tree is rebuilt from the lock and the cache on every build, so `expo prebuild --clean` wiping `ios/` costs
     nothing.
   - Never inside `node_modules`: patch-package only captures what is there (fact 23).
6. **Shapes this block does not cover**, each a clear stop that names the pod, the library that needs it and the
   file: dynamic frameworks, Swift binaries, `vendored_libraries`, compiled sources in an http pod, and non-trunk
   sources. Text: `MLKitFoo 1.0.0 (needed by <lib>) ships a dynamic framework (Frameworks/Foo.framework); rn-xtool
   links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See
   <troubleshooting#cocoapods-binaries>`. They are deferred to a follow-up block, "binary pods: other shapes"
   (open question 4).
7. **The scaffold.**
   - Block 2's table, as written to `ios/build/rn-xtool-pods.json`, gains entries `{ "binary": { "product":
     "GoogleMLKit" } }` for the pods the `pods` step resolved.
   - `classifyPodDependency` returns `binary` for them. The scaffolder emits `.package(path: <rel>/build/pod-binaries)`
     (relative to the symlink, like `build/xcframeworks`) and `.product(name: "GoogleMLKit", package:
     "pod-binaries")`.
   - The marker line records `GoogleMLKit=binary`, without versions, which live in the lock. A version change
     therefore does not make the persisted patch stale.
   - This is scaffolder fix 27 in `docs/upstream/react-native-scaffolder.md`, without a scaffold revision bump (the
     plan's preflight P15).

### 3. Source dependencies through the block-2 table

1. `data/pods.json` gains entries for the source pods binary pods reach, with products per subspec. The version is the
   newest tag the requirements accept, the table's convention:
   - `GTMSessionFetcher`: gtm-session-fetcher `3.5.0`, `subspecs: { Core: ["GTMSessionFetcherCore"] }`;
   - `GoogleUtilities`: `8.1.5`, `subspecs: { Logger: ["GULLogger"], UserDefaults: ["GULUserDefaults"] }`;
   - `GoogleDataTransport`: `10.1.1`, `products: ["GoogleDataTransport"]`;
   - `GoogleToolboxForMac`: per open question 2.
2. The wrapper target depends on `.product(name:package:)` for each. The generated package declares `.package(url:exact:)`
   for them.
3. Block 2's pin check runs on binary pods' requirements too: `⚠ GoogleToolboxForMac 6.0.1 (rn-xtool table) is
   outside MLKitCommon's requirement ">= 4.2.1, < 5.0"`. Open question 2 has the proposed table field that turns a
   deliberate, checked override into one ℹ line.
4. A binary pod's source dependency that the table does not know stops the `pods` step with block 2's
   `unmapped-pod` text and the chain (goal 1.4).

### 4. Resource bundles

1. **Binary pods.**
   - Each `resource_bundles` key `K` becomes `ios-xtool/Resources/K.bundle/`, holding the files its globs match in the
     extracted tree (relative layout kept) and a minimal `Info.plist`: `CFBundleIdentifier` (`org.cocoapods.K`, as
     CocoaPods writes it), `CFBundleName`, `CFBundlePackageType BNDL`, `CFBundleInfoDictionaryVersion 6.0` and
     `CFBundleDevelopmentRegion en`.
   - Bundles are listed in `xtool.yml` `resources:` as `Resources/K.bundle`, and xtool copies them to `App.app/K.bundle`
     (fact 15).
   - Files are copied from the cache, never hard-linked (row 85), with their modification times (row 87).
     `ios-xtool/` is already git-ignored.
   - A glob ending in `/**` keeps the layout below its folder. A folder any other glob matches is copied whole under
     its name, and a file it matches goes to the bundle root under its basename, inside its nearest `.lproj` folder
     when it has one (row 86).
2. **Scaffolded libraries: in scope** (open question 3).
   - The same builder runs on what block 2's `unbundledResources` already reads: the unconditional `resource_bundles` /
     `ios.resource_bundles` of each library rn-xtool scaffolded, with literal globs relative to the package.
   - For react-native-svg that is `App.app/RNSVGFilters.bundle` with the `.iphoneos.metallib` files, which the filters
     load by name. Privacy-manifest bundles are built the same way.
   - Block 2's ℹ line then names only what still does not arrive: plain `s.resources`, a glob the reader cannot read
     (interpolated), and SwiftPM's own `<pkg>_<target>.bundle`s.
   - `docs/libraries.md` loses "resource_bundles … do not work yet" for this case, and its "next scaffolder fix"
     sentence is replaced by present-tense behaviour.
3. **Collisions and compiled resources.**
   - Two bundles with the same name, or a bundle named like an app resource, stop the generate step and name both
     sources.
   - Files that need Xcode tools (`.xcassets`, `.storyboard`, `.xib`) are left out of a bundle with an ℹ line naming
     them, as for app resources.

### 5. What the user sees

1. **Early checks stay offline.** Block 2's `unmapped-pod` check changes in one way:
   - a pod in the lock, or whose cached spec says binary, passes;
   - a pod whose cached spec says git source and that has no table entry is refused, as in block 2;
   - a pod with neither is not refused. The early check cannot know its route without the network, and the `pods`
     step decides, still before anything changes in the project. The ℹ line reads:
     `ℹ pods — GoogleMLKit (from @react-native-ml-kit/text-recognition) is not resolved yet; rn-xtool build reads its
     spec from the CocoaPods CDN.`
2. **`doctor --project`** gets a `pods` line from the lock and the cache:
   `✔ pods — 10 CocoaPods binaries for @react-native-ml-kit/text-recognition, in rn-xtool's cache and in
   rn-xtool-pods.lock.json`, or `… 3 to download from dl.google.com (32.1 MB)`. Unused lock entries are listed. With
   open question 6, unresolved pods are probed too (the CDN spec, plus HEAD for the sizes), within the 10 s budget the
   `rn-artifacts` line already uses.
3. **Before downloading, `build` says what, how much, from where, and whose:**
   `▸ pods — @react-native-ml-kit/text-recognition needs 10 CocoaPods binaries, 40.3 MB from dl.google.com:
   MLKitTextRecognitionCommon 5.0.0 (30.3 MB), MLKitCommon 13.0.0 (2.5 MB), … They are Google's ("Copyright 2024 Google
   LLC"; https://developers.google.com/ml-kit/guides). rn-xtool keeps them in ~/.cache/rn-xtool/pods and does not copy
   them into the project.`
   - Sizes come from HEAD `Content-Length`. A host that does not send it shows `size unknown`.
   - The license text and homepage come from each spec, so the line is the same for any vendor.
4. **Offline: a clear stop that names the cache.** When a needed spec or file is not cached and the host cannot be
   reached:
   `Cannot reach dl.google.com (getaddrinfo ENOTFOUND) to download MLKitCommon 13.0.0 (2.5 MB), which is not in
   rn-xtool's cache (~/.cache/rn-xtool/pods). Connect to the network and build again; once downloaded, builds use the
   cache.`
   The same wording names `cdn.cocoapods.org` for specs. With the lock and a full cache, the `pods` step makes no
   request at all.
5. **Disk.** Before the first download, the step adds up what it needs: the downloads times a factor for unpacking,
   the arm64 copies and the app's copies, measured in the build-only proof (7.5× for ML Kit; the factor is 8). It stops when the cache's filesystem is
   short, with the same wording `setup` uses for its own check. When the project is on another filesystem, the
   per-app copies' share of the factor (2) is checked there and the rest (6) on the cache's.

### 6. Licensing

1. Google's binaries and models are downloaded from the URL in each spec, on the user's machine, at build time, as
   CocoaPods does. They are never part of rn-xtool's npm package or repository, and never mirrored.
2. **What holds Google's bytes, and why none of it is committed:**
   - the cache, outside the project;
   - `ios/build/pod-binaries/`, which has its own `.gitignore` with `*`;
   - `ios-xtool/Resources/*.bundle` and `ios-xtool/.build`, under `ios-xtool/.gitignore`;
   - `App.app`.
   The lock holds URLs, sizes and hashes only.
3. **`patches/` never holds them.** Nothing is written under `node_modules`. As a guard, the persist step refuses a
   patch that contains a `GIT binary patch` hunk or a file starting with Mach-O or `ar` magic. It warns and does not
   persist: `⚠ Did not persist <lib>'s scaffold: the patch would contain a binary file (<path>)`.
4. Test fixtures are synthetic: tiny hand-made Mach-O, fat and `ar` files, and hand-written specs in ML Kit's shape.
   No Google byte enters the repository. A release check fails when `npm pack` would include a Mach-O or `ar` file.
5. `docs/libraries.md` and `docs/troubleshooting.md` say, in the present tense: the files are the vendor's, under the
   vendor's terms (ML Kit: the ML Kit Terms); rn-xtool downloads them for the user's own build and does not accept
   terms on the user's behalf; and the cache must not be published (row 64).

### 7. Checks after the build

The ML Kit failures that matter show only at runtime (facts 7 and 8). These checks run on the packed `App.app`, with
`llvm-nm` and file reads, before install:
1. every `resource_bundles` key of a staged pod is `App.app/<K>.bundle`, with its `Info.plist`;
2. `App.app/Frameworks/` holds no framework named like a binary target (xtool #130, fact 15);
3. every `_OBJC_CLASS_$_` that a force-loaded archive defines is defined in the App binary (this is how a dropped
   `+load` class shows).

A failure stops the build with the list. It does not try to repair anything.

### 8. Docs and tests

- **Docs.**
  - `docs/libraries.md`: an ML Kit text recognition row (Bare 0.88 column), the intro sentence on binaries, and the
    resource-bundle sentence.
  - `docs/troubleshooting.md`: a new "CocoaPods binaries" section with every stop of goals 1, 2 and 5, the lock, the
    cache path, offline use, and how to trust a changed file. The ML Kit line in "Libraries that depend on CocoaPods
    pods" changes.
  - `docs/how-it-works.md`: the `pods` and staging steps.
  - `docs/upstream/react-native-scaffolder.md`: the binary route fix.
  - `CHANGELOG.md`.
- **Tests**, one red→green unit test per mechanism:
  - the requirement and prerelease matcher, greedy resolution and its conflict text;
  - spec parsing (string and array requirements, subspecs, `default_subspecs`, `ios` keys);
  - the lock: record, verify, moved URL, mismatch, re-resolve after a requirement change;
  - downloads (small files, `Content-Length`, the offline text), against a local HTTP server;
  - extraction safety (crafted tar and zip);
  - the Mach-O reader (fat, thin, `ar`, `MH_OBJECT`, `MH_DYLIB`, simulator platform);
  - the module-map rewrite and the Info.plist;
  - the generated `Package.swift` and the App target's flags;
  - the scaffold's `binary` emission, with no absolute path;
  - the bundle builder and `xtool.yml`;
  - the `.gitignore` files, the persist guard, `exclude`, and the post-pack checks.
  - No test touches the network.

## Non-goals

- **Firebase**, Firebase ML, and GoogleMLKit's `LinkFirebase` subspec.
- **Simulator slices.** rn-xtool builds for devices.
- **App Store distribution of these builds:** privacy manifests inside the frameworks, signing requirements for
  third-party SDKs, ITMS-91065.
- **The splash screen and asset catalogs.**
- **Mirroring or redistributing any binary**, including a CI cache of rn-xtool's cache.
- **A full CocoaPods resolver** with backtracking, and pods from spec repos other than trunk.
- **Source pods without a SwiftPM package**, built from their spec (a scaffold from the JSON spec). This block uses
  block 2's table only.
- **The other binary shapes** of goal 2.6, and a library's own vendored binaries (fact 25). See open questions 4
  and 5.
- **Other ML Kit features.** The mechanism is generic, but only text recognition is verified. The docs say so.

## Failure walk

The process, end to end:

1. early checks (offline): classify pods with the table, the lock and the spec cache;
2. `pods`: fetch the version index and the specs from the CDN (jsDelivr);
3. resolve versions;
4. download the tarballs from the URLs in the specs (dl.google.com);
5. verify them against the lock, or record them;
6. extract;
7. inspect and wrap: thin, `ar`-wrap, headers, module maps, Info.plist, into the cache;
8. write the lock;
9. `expo prebuild`, then patches (unchanged);
10. stage `ios/build/pod-binaries` and the bundles;
11. `rn-spm`: the scaffolder emits the binary route, then persists into `patches/`;
12. `generate`: the App target's `-force_load` and link settings, and `xtool.yml` resources;
13. SwiftPM: resolve the source packages from GitHub, and the local package;
14. compile and link (Swift Build, `ld64.lld`);
15. xtool packs and signs;
16. post-pack checks;
17. on the device: the first recognition.

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | Early checks | a pod's route is unknown offline (no lock, no cached spec) | user: the ℹ "not resolved yet" line; the `pods` step decides minutes earlier than any compile | handle: goal 5.1; unit tests for the three cases |
| 2 | CDN | unreachable (offline, DNS, proxy) on a first resolution | user: `Cannot reach cdn.cocoapods.org …`, naming the cache, before anything changes | handle: goal 5.4 |
| 3 | CDN | 404: the pod or version is not on trunk (private spec repo, deleted version) | user: a stop naming the pod, the version, the URL and the library; it suggests a `pods` entry or `exclude` | handle |
| 4 | CDN | the 301 to jsDelivr is not followed, or jsDelivr refuses a request without `User-Agent` | user: a stop naming the HTTP status | handle: explicit `User-Agent`, redirects followed; local-server test |
| 5 | CDN | a version's spec changes on trunk after rn-xtool cached it | nobody: the cached spec is used | accept: specs are cached per version and trunk freezes on 2026-12-02 (fact 12) |
| 6 | CDN | jsDelivr or the CDN goes away | user on a machine without the cache: row 2's stop; machines with a cache and the lock keep building | accept: no mirror (licensing); the docs say a fresh machine needs the CDN once |
| 7 | CDN | a spec shape the parser does not expect (a new key, a requirement form) | user: a stop naming the pod and the key | handle: parser tests on hand-written specs in ML Kit's shape; unknown keys that do not change the build are ignored |
| 8 | Versions | no version satisfies every requirement | user: a stop listing each requirement and who imposed it | handle |
| 9 | Versions | two libraries constrain a pod incompatibly, or greedy resolution misses a solution CocoaPods would find | user: row 8's text, naming both libraries | accept: no backtracking (Non-goals); the docs show `exclude` |
| 10 | Versions | a prerelease is picked for an open requirement | nobody, if unhandled | handle: prereleases only when a requirement names one; unit test with `" 1.0.0-beta7"` |
| 11 | Versions | the lock's version no longer satisfies a library's new requirement | user: ℹ naming the old and new versions; the new download is recorded | handle: goal 1.6; `doctor --project` gives a ⚠ naming the locked version and the requirement instead of ✔ (E/F review M4) |
| 12 | Versions | a binary pod depends on a source pod the table does not know | user: block 2's `unmapped-pod` text with the chain | handle: goal 3.4. A source pod that only libraries in `knownLimits.allow` reach is left out by the `pods` step with block 2's ⚠ "allowed … the build may fail later" line (printed once, not again after the early checks'), and the build goes on; `doctor --project` shows the resolver's refusal as ✖, and `⚠ pods — not checked` only for an unreachable host or the 10 s budget (E/F review I1) |
| 13 | Versions | a table pin is outside a binary pod's requirement (GoogleToolboxForMac 6.0.1 against `< 5.0`) | user: block 2's ⚠, or one ℹ when the entry marks the override as checked | handle: per open question 2 |
| 14 | Versions | a subspec reached in the graph has no product in its table entry | user: SwiftPM's missing-product error, or a link error | handle: the entry's `products` is the fallback (block 2); a unit test checks that every subspec in ML Kit's graph maps |
| 15 | Download | 404 or 410: the vendor removed the file | user: a stop naming the host, the URL and the pod | accept: nothing else can serve it; the cache keeps working where it exists |
| 16 | Download | partial or truncated | nobody: the size check against `Content-Length`, then one retry, then a stop | handle: goal 1.7 |
| 17 | Download | a small file rejected by `downloadFile`'s 1 MiB floor (MLImage is 7 KB) | user: "downloaded file too small" | handle: `minBytes` from the expected size; unit test (fact 19) |
| 18 | Download | the sha256 differs from the lock (the vendor re-uploaded the same version, or the file was tampered with) | user: `The file dl.google.com serves for MLKitCommon 13.0.0 is not the one rn-xtool-pods.lock.json records (sha256 … instead of …). rn-xtool does not use it. If you trust the new file, delete the "MLKitCommon" entry from rn-xtool-pods.lock.json and build again.` | handle: no retry, the file is deleted; unit test |
| 19 | Download | the spec's URL differs from the lock's (the vendor moved it) | user: ℹ "same file, new URL", when the hash matches; otherwise row 18 | handle: goal 1.7 |
| 20 | Download | the first download cannot be checked against anything (no checksum in the spec) | nobody: it is trusted on first use, over HTTPS | accept: the docs say so in the present tense; a spec's `sha256`/`sha1` is checked when present |
| 21 | Download | a hung connection | user: the 15-minute timeout message | accept: `downloadFile`'s existing behaviour |
| 22 | Extraction | an entry with an absolute path, a `..` segment, a device file, or a link that leaves the tree | user: a stop naming the archive and the entry; nothing is extracted | handle: listing first; crafted tar and zip tests |
| 23 | Extraction | an unexpected layout: the vendored path is not where the spec says (`flatten`, an extra folder) | user: a stop naming the expected path and the archive's top-level entries | handle |
| 24 | Extraction | a `.zip` and no `unzip` on the host | user: a stop naming `sudo apt install unzip` | handle; `doctor` gets the same line only when a lock entry is a zip |
| 25 | Extraction | interrupted (Ctrl-C, full disk) | nobody: the temporary tree is not stamped and is rebuilt next time | handle: stamp written last (fact 20) |
| 26 | Wrap | no arm64 device slice | user: `MLKitFoo 1.0.0 (needed by <lib>) ships no arm64 device slice (it has x86_64)` | handle |
| 27 | Wrap | the arm64 slice is built for the simulator | user: a stop naming the pod and the platform | handle: the `LC_BUILD_VERSION` check (goal 2.1) |
| 28 | Wrap | a dynamic framework (`MH_DYLIB`) instead of a static one | user: goal 2.6's stop | defer: to the follow-up block "binary pods: other shapes" |
| 29 | Wrap | a framework with Swift (`Modules/*.swiftmodule`) | user: goal 2.6's stop | defer: same block |
| 30 | Wrap | a missing module map | nobody: one is generated from `Headers/<Name>.h`; without that header, a stop naming the framework | handle: goal 2.3 |
| 31 | Wrap | a module map the rewrite does not recognise (private map, `framework` submodule) | user: a stop naming the file | handle: open question 1's alternative avoids the rewrite |
| 32 | Wrap | a fat archive (`CAFEBABE` around `!<arch>`) | nobody: it is thinned to a thin `ar`, which also avoids xtool #130's misclassification | handle: invariant test, every staged archive starts with `!<arch>\n` |
| 33 | Wrap | `llvm-ar` is missing, or wrapping the `MH_OBJECT` fails | user: a stop naming the tool; `doctor` gets an `llvm-ar` line like `llvm-nm`'s | handle |
| 34 | Wrap | an object without a platform load command (MLKitTextRecognitionCommon) | user, if lld refuses it: a link error at hop 14 | handle: the build-only proof decides; the inspection accepts it (goal 2.1) |
| 35 | Wrap | a pod's `platforms.ios`, or an object's `minos`, is newer than `IOS_MIN` 16.4 | user: `⚠ MLKitFoo needs iOS 17.0; the app's minimum is 16.4; it fails to load on older iPhones` | handle: ⚠, not a refusal; ML Kit's 15.5 passes |
| 36 | Stage | the cache and the project are on different filesystems | nobody: staged files are copies (row 85) | handle |
| 37 | Stage | a persisted scaffold references `build/pod-binaries`, but staging did not run (the user runs SwiftPM by hand, or the step failed) | user: SwiftPM's "package manifest cannot be accessed" | handle: staging runs on every build before `rn-spm`, and a failed staging stops the build; `install` (and so `run`) stages pod-binaries and the pods' bundles in `ios-xtool/Resources` again from the lock and the cache when they are gone since the build (`npx expo prebuild --clean` or `rm -rf ios/build` by hand), and stops when the binary pods changed since the build (final review, three-ways #2); the docs name rn-xtool as the only entry point |
| 38 | Stage | two pods give the same module or bundle name, or a bundle is named like an app resource | user: a stop naming both sources | handle: goal 4.3 |
| 39 | Scaffold | the binary route writes an absolute path into a persisted manifest | other machines: a broken patch | handle: the scaffolder's existing no-absolute-path test, extended |
| 40 | Scaffold | Google's files reach `patches/` | user: the persist guard's ⚠, and nothing is persisted | handle: goal 6.3; nothing is written in `node_modules`; the guard checks every patch file of the library that changed and fails closed: a patch it cannot read is not persisted, with a ⚠ naming it (group D review M2) |
| 41 | Scaffold | the scaffold revision bump warns about every persisted scaffold | user: the existing "older revision" warning, once per patch | accept: block 2's rule; the CHANGELOG says to delete and rebuild |
| 42 | SwiftPM | a `binaryTarget` is rejected (Info.plist key, a name that is not the xcframework's, a path outside the package) | user: SwiftPM's error at `xtool-build` | handle: Info.plist from the proven helper, names from one source, files inside the package; build-only proof |
| 43 | SwiftPM | the headers do not reach the library (a binary target's headers are not propagated through the wrapper) | user: `module 'MLKitVision' not found` | handle: the product lists the binary targets directly (goal 2.5); build-only proof |
| 44 | Link | duplicate symbols: the archive is loaded twice, or `-force_load` brings in a member another library also defines (protobuf, TFLite, GTM copies) | user: `ld64.lld: duplicate symbol` naming both files | handle: the archive is linked only through `-force_load` (goal 2.4); the build-only proof with the work app's libraries; open question 1 has the `-ObjC`-only fallback |
| 45 | Link | undefined symbols: a source product is missing or has changed (GTMLogger in GoogleToolboxForMac 6) | user: `undefined symbol` naming it | handle: build-only proof; post-pack check 3 |
| 46 | Link | a framework or library the spec names is not in the xtool SDK | user: `framework not found X` | handle: the `pods` step checks each name against the SDK's `.tbd` files and stops early, naming it |
| 47 | Link | a source package's `.process` resource needs a tool Linux does not have | user: a Swift Build error naming the file | accept: the build-only proof records it; AppAuth's `.copy` builds (block 2) |
| 48 | SwiftPM fetch | GitHub offline, rate-limited, or a tag moved, for the source packages | user: SwiftPM's resolve error naming the URL | accept: block 2's row 24; first fetch only; the docs say a clean `.build` needs the network |
| 49 | SwiftPM fetch | another package pins GoogleUtilities, GTMSessionFetcher or GoogleDataTransport at another exact version (Firebase, GoogleSignIn) | user: SwiftPM's version conflict naming both | accept: block 2's row 25; the docs name the table as the one place to align pins |
| 50 | xtool | a binary target is embedded as a dynamic framework (#130) | user: post-pack check 2 stops the build before install | handle: library-type slices never match `<name>.framework/<name>`; post-pack check |
| 51 | xtool | a bundle is not copied, or lands under another name | user: post-pack check 1 | handle |
| 52 | xtool | a bundle's `Info.plist` is refused at signing or install | user: xtool's or the iPhone's error | handle: CocoaPods' keys (goal 4.1); the owner's device pass (2026-11-05: installed) |
| 53 | xtool | the app grows by about 53 MB (G2), so installs over Wi-Fi take longer; the per-app copies in `ios/build/pod-binaries` and `ios-xtool/Resources` take about 66 MB more on disk (58 MB of xcframeworks and archives, 8 MB of models) | user: a slower install | accept: present tense in `docs/libraries.md` |
| 54 | Runtime | the model bundle is not found: "Invalid model path." at the first recognition, not at launch | user on the device | handle: post-pack check 1, and the device pass (checked 2026-11-05) |
| 55 | Runtime | a `+load` registration is missing: the recognizer is nil, or `process` fails | user on the device | handle: `-force_load`, post-pack check 3, and the device pass (checked 2026-11-05) |
| 56 | Runtime | dead stripping removes data that is found only by name | user on the device: "Invalid model path." with the bundle present | handle: the device pass decides (checked 2026-11-05); the slice is an archive, so d-date's relink-as-dynamic cause does not apply (fact 4) |
| 57 | Runtime | the privacy manifests inside the frameworks are not in the app | nobody for a development build | accept: they are read at App Store submission (Non-goals); the ℹ line names them |
| 58 | Runtime | the iPhone's iOS is older than a pod's minimum | user: a launch crash | accept: rn-xtool's minimum is 16.4, ML Kit's 15.5; row 35 covers the general case |
| 59 | Disk | not enough space for the downloads, their unpacked and wrapped copies and the per-app copies | user: a stop before the first download, with what is needed and where | handle: goal 5.5; the factor is 8 (G2 measured 7.5× with the per-app copies of row 85); with the project on another filesystem than the cache (row 36), the project's filesystem gets its share of the factor, 2 for the per-app copies, and the cache's the other 6 (final review M5); a file HEAD gives no length counts with the size the lock records (E/F review M3), and a cached file that fails its re-hash is announced and counted like a missing one (E/F review M2) |
| 60 | Disk | the cache grows with every version | nobody | accept: the docs say deleting `~/.cache/rn-xtool/pods` is safe; later builds download again and verify against the lock. Trees unpacked or wrapped by an older `EXTRACTOR_VERSION` or `WRAPPER_VERSION` stay until then |
| 61 | Disk | `.build` grows (Swift Build copies headers; the code is linked into the app) | nobody | accept: measured in the build-only proof |
| 62 | Concurrency | two builds share the cache | nobody | handle: temporary files per pid, atomic renames, entries keyed by sha256 |
| 63 | Licensing | the user commits `ios/build/pod-binaries` or the bundles | nobody | handle: the generated `.gitignore` files (goal 6.2) |
| 64 | Licensing | the user publishes the cache (a CI cache, a shared drive) | nobody that rn-xtool can see | accept: the docs say the cache holds the vendor's files and must not be published |
| 65 | Licensing | rn-xtool's npm package or repository carries a binary | the maintainer: the release check | handle: synthetic fixtures; the `npm pack` check (goal 6.4) |
| 66 | Licensing | the user does not know the files are Google's | user: the line before the first download, with the license and homepage | handle: goal 5.3; the docs name the ML Kit Terms |
| 67 | Exclude | a library is listed in `exclude` for dev builds | user: its pods are not resolved, downloaded or staged; its lock entries stay, listed as unused | handle: goal 1.2; unit test |
| 68 | Exclude | an excluded library's persisted scaffold still names `pod-binaries` | nobody: the library is not autolinked, so SwiftPM never reads it | accept: block 2 says a persisted scaffold of an excluded library stays applied and is harmless |
| 69 | Lock | two branches record different entries, and the lock has merge conflicts | user: git | accept: the docs say to keep either side and build; the hashes are checked again |
| 70 | Versions | an http pod ships vendored frameworks together with vendored libraries or compiled sources (glue `.m`, a `.a`) | user, if unhandled: `undefined symbol` at link, or a nil class on the device | handle: vendored libraries and compiled sources are checked before vendored frameworks, so the pod gets goal 2.6's stop |
| 71 | CDN | a machine whose cached version index predates the latest releases resolves an unlocked pod (first run, or a pod newly in the graph), or a locked pod whose version no longer satisfies, to an older version than a fresh machine, and the lock records it | nobody, if unhandled | handle: such a pod reads the index again once per resolution; a locked pod whose version still satisfies keeps it without a request |
| 72 | Download | an https URL redirects to plain http | nobody, if unhandled: the file travels unencrypted and nothing pins it | handle: redirects are followed one by one, and a step from https to http (or any scheme other than https, as for the spec's own URL) is refused with the plain-http stop unless the lock records the file's sha256 (then it is checked anyway) |
| 73 | Cache | a killed build leaves temporary downloads and trees in the cache | nobody, if unhandled: the cache grows | handle: the `pods` step removes the cache's temporary files and trees older than 24 h when it starts |
| 74 | Concurrency | a build reads `extracted/<sha256>-<stamp hash>` while another build swaps the same tree in | user, rarely: a missing-file error in that build; building again passes | accept: the window is two renames long, and both trees are identical (each selection of an archive has its own tree) |
| 75 | Network | the network needs an HTTPS proxy: Node's built-in fetch ignores `HTTPS_PROXY` and `HTTP_PROXY`, as rn-xtool's other downloads do | user: goal 5.4's "Cannot reach" stop, while `curl` and `git` work | accept: the troubleshooting section names `NODE_USE_ENV_PROXY=1` (Node 24) and the cache: with the lock and a full cache, no request is made |
| 76 | Cache | a crash or power loss right after a rename leaves a cached file or tree without its bytes | nobody, if unhandled: every later build stops until the cache is deleted | handle: files are synced before their rename and folders after; a cached download is hashed again before reuse; a tree's stamp records its file count and bytes, checked before reuse (a mismatch rebuilds it) |
| 77 | Wrap | a framework's module map names an umbrella directory, or a header path that is absolute or goes up with `..` | user, if unhandled: a compile error after the headers move to `Headers/<Name>/` | handle: the rewrite stops and names the map; open question 1's fallback B (Google's maps unchanged) is the way out |
| 78 | Wrap | one pod vendors two frameworks with the same name (`X.framework` and `X.xcframework`) | user, if unhandled: one silently replaces the other | handle: a stop naming both |
| 79 | Cache | the wrap logic changes, and users' stamped trees were made by the old one | nobody, if unhandled: stale trees are reused | handle: `WRAPPER_VERSION` (and `EXTRACTOR_VERSION`) in the stamps and in the trees' names; `docs/RELEASING.md` says to bump them; a wrapped tree's key holds `EXTRACTOR_VERSION` too (group C review M4) |
| 80 | Link | xtool's `ld64.lld` crashes while it builds Objective-C relative method lists from a binary pod's object (fact 27.3) | user: a linker segfault naming no pod | handle: `-Xlinker -no_objc_relative_method_lists` on the App target when binary pods are linked, never otherwise (builds without binary pods unchanged); the upstream lld bug is reported by the owner |
| 81 | Link | a source package's target has no sources, so Swift Build writes no object but lists one at link (fact 27.4) | user: `Build input file cannot be found: …/GTMDefines.o` | handle: data-driven `emptyTargets` on the table entry; an empty arm64 object (clang's for an empty C file) is written before `xtool-build` for each one of a linked table pod (row 84: rewritten unless the file there is that object); like `outsideRequirement`, a config pin of another `exact` or `url` drops the shipped list, and `"emptyTargets": []` clears it (final review M3) |
| 82 | Wrap | a spec path (`vendored_frameworks`, `source_files`, `module_map`, …) or an xcframework slice's `LibraryIdentifier`, `LibraryPath` or `HeadersPath` is absolute or goes up with `..` | user, if unhandled: files from outside the pod's tree are wrapped and linked | handle: a stop naming the pod and the key (group C review M2) |
| 83 | Wrap | a headers-only pod's `source_files` match no file, name a file the tree does not hold, or its `module_map` is missing | user, if unhandled: an empty module, then "unknown type" errors at compile | handle: row 23's stop, naming the path (group C review M3); a `source_files` folder stands for the headers below it, as in CocoaPods (group D review M6) |
| 84 | Link | the empty object of row 81 is there but broken: a write cut short, a full disk, a foreign file, or one written for another minimum | user, if unhandled: lld fails on `GTMDefines.o` on every build until `.build` is deleted | handle: the file is kept only when it is byte for byte the object rn-xtool writes; otherwise it is rewritten through a temporary file and a rename (group D review M1) |
| 85 | Stage | a file of `ios/build/pod-binaries` or of an app bundle is edited in place (by hand or by a tool) | user, if unhandled: with hard links, the edit reaches rn-xtool's cache and every other app on the machine, and survives `expo prebuild --clean`; the reuse check sees only file counts and sizes | handle: staged xcframeworks, archives and bundle files are copies, never hard links (about 56 MB more per app for ML Kit) (group D review M3) |
| 86 | Bundle | a bundle's globs match localized files (`Res/**/*.strings` over `en.lproj/` and `fr.lproj/`) or a folder (`Res/*.lproj`, `Res/*`) | user, if unhandled: a late stop at `generate` ("would hold Localizable.strings twice"), or the strings left out without a line and raw keys at run time | handle: a flattened file keeps its nearest `.lproj` folder; a folder a glob matches is copied whole under its name, as CocoaPods adds it; a duplicate name in a scaffolded library's bundle leaves that bundle out with block 2's ℹ "Not copied" line (a binary pod's keeps the stop) (E/F review I2) |
| 87 | Stage | the staged copies of row 85 get new modification times on every build | user, if unhandled: Swift Build processes the xcframeworks again and relinks the app on a no-change build | handle: copies into `ios/build/pod-binaries` and `ios-xtool/Resources` keep the source's modification time (E/F review M1); the files rn-xtool generates there (each bundle's `Info.plist`, pod-binaries' `Package.swift`, `.gitignore`, `wrapper.c` and its header) are compared with the last build's and keep its time when unchanged (owner ruling) |
| 88 | Post-pack | a post-pack check refuses the packed app | user: the stop lists what is wrong | handle: the check removes `ios-xtool/xtool/App.app` and the `.ipa` beside it, so `run` does not take it as built; `build` records what the checks read in the build state, and `install` (USB and Wi-Fi, and so `run`) has xtool build the app from `.build` first and runs the checks on it before anything installs (E/F review M6; owner ruling) |
| 89 | Network | a reset connection (`ECONNRESET`, `ETIMEDOUT`, a reused socket the host closed) or a 5xx answer on a working network, for a spec, a version list or a download | user, if unhandled: goal 5.4's "Cannot reach …" or the HTTP stop, and building again works | handle: one more try for CDN reads (a 4xx, a refused connection and rn-xtool's own timeout are not retried) and for downloads (`downloadFile` retries any failure once); the second failure stops as before (E/F review three-ways #3) |
| 90 | Link | `install` (USB or Wi-Fi) or `run` builds with xtool after `.build` was deleted, without rn-xtool's generate step | user, if unhandled: `Build input file cannot be found: …/GTMDefines.o` at link | handle: `build` records the empty targets in the build state, and `install` writes their objects (row 81) before xtool builds (G2 finding A) |
| 91 | Network | offline, a library in `knownLimits.allow` with a git-source pod the lock never records | user, if unhandled: goal 5.4's "Cannot reach … to read the versions of <pod>" on every offline build, although its other pods are locked and cached | handle: the early checks route the pod from its cached spec, and the `pods` step leaves the pods they allowed out before any CDN read; a machine that never read the spec needs the CDN once (final review I1) |
| 92 | Network | a network that inspects TLS with its own root certificate: Node's `fetch` trusts its own CA list, not the system's | user: goal 5.4's "Cannot reach cdn.cocoapods.org (UNABLE_TO_GET_ISSUER_CERT_LOCALLY) …" stop, while `curl` and `git` work | accept: the troubleshooting section names `NODE_EXTRA_CA_CERTS=<file.pem>` next to the proxy bullet (row 75); with the lock and a full cache, no request is made (final review, three-ways #1) |

## Verification

- **Unit tests:** those of goal 8, each written red first. `npm test`, `npm run lint` and `npm run scan:private` are
  green and clean. No test touches the network: the CDN and dl.google.com are served by a local HTTP server from
  hand-written fixtures.
- **Downloads and disk need the owner's approval first.**
  - About 13 to 14 GB are free on the build disk. The React Native 0.88.1 artifacts are already cached.
  - The proof downloads the ten ML Kit tarballs, 40.3 MB (confirmed from the specs and their measured sizes), and
    SwiftPM's clones of four Google repositories (tens of MB). The npm tarball of @react-native-ml-kit/text-recognition
    2.0.0 is already on disk.
  - Expected peak use is under 1.5 GB: about 140 MB unpacked, 58 MB wrapped, `.build` from 574 MB up, and App.app
    84 MB plus about 53 MB, with 66 MB of per-app copies (G2's measures). `.build` is deleted between runs, and the measured numbers are reported.
- **Spike gate (G1, passed on 2026-11-05):** ML Kit wrapped by rn-xtool's code and staged by hand linked with the
  proposed shape, given the four changes of fact 27; the `-no_objc_relative_method_lists` crash is kept as a
  reproduction for the upstream lld report.
- **Build-only proof (no device)**, on a fresh bare 0.88.1 app like block 2's F1 proof, without any hand fix:
  1. Install @react-native-ml-kit/text-recognition 2.0.0. `App.tsx` calls `TextRecognition.recognize()` on a bundled
     image. `doctor --project` shows the ℹ "not resolved yet" line and no refusal.
  2. `rn-xtool build` prints the download line (goal 5.3) before any download, then records the lock, then produces
     `App.app`. Checks:
     - `llvm-nm` finds `_OBJC_CLASS_$_MLKTextRecognizer`, `_OBJC_CLASS_$_MLKITx_SRLRegistry`, the library's module
       class and `_OBJC_CLASS_$_GTMLogger`;
     - `App.app/` holds the five `…OCRResources.bundle`s, each with an `Info.plist`;
     - `App.app/Frameworks/` holds no ML Kit framework;
     - `ios/build/pod-binaries/Package.swift` names the app's deployment target, and `ios-xtool/Package.swift` has
       `-no_objc_relative_method_lists` and one `-force_load` per archive (rows 80, 44);
     - `ios-xtool/.build/out/Products/Debug-iphoneos/GTMDefines.o` is rn-xtool's empty object (row 81);
     - the three post-pack checks pass;
     - `git status` in the app shows only `rn-xtool-pods.lock.json`, and no file under `patches/` contains binary
       content.
  3. Build again with the network cut off for rn-xtool, with `.build` kept: no request, and the same `App.app`.
  4. Delete `~/.cache/rn-xtool/pods` and build with the lock: everything is downloaded again and verified, with no
     "recorded" line. Then edit one hash in the lock: row 18's stop, with nothing changed in the project.
  5. Delete `.build` and the cache, and build offline: goal 5.4's stop, naming the cache.
  6. Add react-native-svg 15.16.0 (already in the work app's list): `App.app/RNSVGFilters.bundle` holds its
     `.iphoneos.metallib` files, and block 2's ℹ line no longer names svg.
  7. `exclude: ["@react-native-ml-kit/text-recognition"]`: no `pods` work, the lock entries are listed as unused, and
     the build succeeds.
  8. Optional, if disk allows: the same app plus the work app's other libraries (block 2's list), for row 44.
  Any failure goes back to the owner as a decision.
- **Device checks for the owner** (free team, after the build-only proof):
  - the app launches;
  - `TextRecognition.recognize()` on a photo of a printed page returns its text (blocks and lines), and the first
    call shows no "Invalid model path.";
  - optional: one Japanese or Chinese sample through the matching script option.

  Until the owner confirms these, the docs call ML Kit text recognition build-verified only.
- **Device pass, run 2026-11-05** (the owner, iOS 26), on the G2 app (bare React Native 0.88.1 with
  @react-native-ml-kit/text-recognition 2.0.0, react-native-svg 15.16.0 and an entitlements file):
  - installed over Wi‑Fi: the re-run of the post-pack checks before the install (row 88) passed silently, and the app
    installed and launched (row 52);
  - `TextRecognition.recognize()` on a photo of printed text returned the text, with no "Invalid model path." (rows
    54–56 checked);
  - react-native-svg: a Metal filter shape (`FeComposite` xor) rendered from `RNSVGFilters.bundle` (OQ3);
  - Fast Refresh works.

  Not part of this pass: the optional Japanese or Chinese sample.

## Open questions

1. **How a static binary reaches the link.**
   - Proposed: headers-only library-type xcframeworks (the proven ExpoModulesJSIHeaders shape, empty placeholder
     archive) for compiling, and the real thin `ar` archive linked once with `-force_load` on the App target. One
     load, no copy, nothing for xtool to embed. It needs the content-based module-map rewrite (row 31).
   - Alternative A: the real archive as the slice's `LibraryPath`, linked by SwiftPM, with only the `-ObjC` the App
     target already passes. That is CocoaPods parity, but it drops archive members that hold no ObjC (C++ static
     initialisers), which d-date reports as a cause of failures.
   - Alternative B: framework-type slices (`<Name>.framework` with the thin `ar` as its binary). That keeps Google's
     module maps unchanged, but it relies on how Swift Build copies static frameworks and on xtool's magic check.
   - The build-only proof can try A or B as fallbacks if the proposed shape fails at link.
2. **GoogleToolboxForMac 4.x has no SwiftPM package.**
   - Proposed: the table pins 6.0.1 (`GTMLogger`, `GTMNSData_zlib`) and marks the override as checked with a field
     such as `"outsideRequirement": "4.x ships no Package.swift; 6.0.1 keeps the GTMLogger API ML Kit links against"`.
     Block 2's ⚠ then becomes one ℹ line with that text. The build-only proof and post-pack check 3 verify the
     symbols.
   - Alternative: rn-xtool generates a small MRC package from the v4.2.1 sources (`GTMDefines.h`,
     `Foundation/GTMLogger.{h,m}`, `Foundation/GTMNSData+zlib.{h,m}`, `-fno-objc-arc`). That is faithful to the
     requirement, but it is version-specific code, and it is a step toward the "source pod without SwiftPM" route
     this block leaves out.
3. **Scaffolded libraries' resource bundles (react-native-svg's `RNSVGFilters.bundle`) in this block?** Proposed: yes.
   It is the same builder fed by block 2's reader, it closes a documented gap, and the owner's rule is "fix, don't
   file". Plain `s.resources` stay as block 2 reports them.
4. **The other binary shapes** (dynamic frameworks, Swift binaries, `vendored_libraries`, compiled sources in an http
   pod). Proposed: a clear stop in this block, and a follow-up block, "binary pods: other shapes". None is in the work
   app.
5. **A library's own vendored binaries** (async-storage 3.x, the `vendored-binaries` refusal). Proposed: the refusal
   stays, and the wrap step takes a directory, not a download, so the follow-up block can feed it. Alternative: lift
   the refusal for static frameworks in this block. No library in the work app needs it.
6. **Should `doctor --project` probe unresolved pods online?** Proposed: yes, within the 10 s budget the
   `rn-artifacts` line uses, with the same `not checked: <reason>` warning. Without it, doctor can only say "not
   resolved yet" before the first build.
7. **The lock's name, place and pruning.** Proposed: `rn-xtool-pods.lock.json` at the project root, unused entries
   kept and listed. Alternative: prune unused entries on every build, which resets trust when a library is excluded
   and then included again.
8. **Download without asking?** Proposed: yes, after goal 5.3's line, as `pod install` and React Native's artifacts
   do. Alternative: the first download of a vendor's binaries needs a config opt-in (for example `"pods":
   { "allowBinaryDownloads": true }`), so the vendor's terms are an explicit choice in the repository.
9. **Is an Expo build part of the proof?** The `pods` step runs before `expo prebuild` and staging after it, so Expo
   differs only in order. Proposed: build-only on an SDK 58 template after the bare proof, if disk allows. Otherwise
   it ships with unit tests and is documented as build-unverified on Expo.

## Left to the builder

- Exact names: the `pods` and staging steps, the lock's keys, the cache's folders, the table field of open question
  2, the generated package's name (its identity is the folder name, `pod-binaries`).
- Whether the Mach-O and `ar` readers are Node code or `llvm-objdump` output (the toolchain has `llvm-objdump` but no
  `llvm-lipo`).
- The disk factor's value, from the proof's measurements.
- The wording of the docs sections and of the stops not quoted above.
