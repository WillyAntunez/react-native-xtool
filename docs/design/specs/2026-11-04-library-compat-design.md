# Library compatibility: scaffolder fixes, third-party pods, AppAuth, module exclusion, entitlements (design)

Status: short design, 2026-11-04, draft for Willy's approval. This is the second work-app compatibility block; the
first is the [React Native 0.85 line](2026-11-04-rn-085-line-design.md). The research notes are kept outside the repo:
a library matrix of the work app's native libraries on a bare 0.88.1 app (build-only, no device), a study of
react-native-app-auth and ML Kit, and a survey of reusable tools. The facts this design rests on are restated here
with their sources.

## Intent

The work app uses about twenty native libraries. On a bare React Native 0.88.1 app, rn-xtool builds thirteen of them
as they are. Four do not build: react-native-vision-camera, react-native-device-info,
@react-native-community/netinfo and react-native-video. Each one fails on a generic gap in the scaffolder, not on
something peculiar to the library, and with four hand fixes the whole list builds together. Two more libraries,
react-native-app-auth and @react-native-ml-kit/text-recognition, depend on CocoaPods pods that the scaffolder cannot
provide. Today they pass every early check, a broken scaffold is saved into `patches/`, and the build fails minutes
later.

Building the list also showed four rn-xtool bugs that are not about any library. A scaffold run silently undoes the
user's hand fixes in every other library. A failed scaffold is reported as a misleading error. A patch left behind
after `npm uninstall` stops the build. Resource bundles never reach the app, and nothing says so. Finally, rn-xtool
passes no entitlements to xtool, so nothing tells the user which capabilities the app will lack on a free team.

This block turns each finding into a general mechanism:

1. four scaffolder fixes;
2. four pipeline fixes;
3. one resolver for third-party pods, with AppAuth as its first SwiftPM mapping;
4. a way to leave a native module out of a dev build;
5. entitlements passed to xtool and checked before the build.

Owner's rule, as before: mechanisms over versions. Each fix follows a content or layout fact (a podspec shape, a
header layout, an entitlement key), never a library name or a version number.

## Facts

### The four libraries that do not build

1. **The matrix.** It ran on 2026-11-04 with xtool 1.24.0, Swift 6.4.1, the iPhoneOS 27.1 SDK, and a copy of the bare
   0.88.1 reference app. `npm ci` was clean and `npm ls --all` exited 0. `doctor --project` was all ✔ and `known-limits`
   reported none.
   - These build as they are, together: @aws-amplify/react-native 1.3.3, async-storage 1.24.0, keychain 10.0.0,
     localize 3.7.2, linear-gradient 2.8.3, wifi-reborn 4.13.6, webview 13.17.0, svg 15.16.0, screens 4.30.1,
     safe-area-context 5.11.1, reanimated 4.7.1 + worklets 0.13.0, and @react-navigation 6 (JS only).
   - These do not: vision-camera 4.7.3, device-info 15.0.2, netinfo 11.5.2 and video 6.19.3.
   - With the four hand fixes below, every library builds together. The final build produced `App.app`, and
     `llvm-nm` shows each library's classes in the binary. No device was used.
2. **vision-camera: a conditional subspec depends on a package that is not installed.**
   - `VisionCamera.podspec` defines its `FrameProcessors` subspec (C++ sources, `fp.dependency
     "react-native-worklets-core"`) only `if enableFrameProcessors`. The podspec sets that to false when
     react-native-worklets-core does not resolve.
   - The regex podspec reader evaluates no condition and merges every subspec
     (`vendor/rn-spm/spm/read-podspec.js:652`, the "Subspecs detected" warning).
   - The dependency loop makes any `react-native-*` dependency a sibling (`vendor/rn-spm/spm/scaffold-package-swift.js`
     about 696–701). The emitter throws when that sibling is not autolinked (1418–1422): `no resolved Swift name for the
     sibling 'react-native-worklets-core'`. No manifest is written.
   - React Native then reports `"react-native-vision-camera" has mixed Swift + Objective-C/C++ sources`, which is
     misleading: the real cause is the throw.
   - Hand fix: a podspec copy without the subspec. It scaffolds, then fails on fact 3.
   - The podspec's `VISION_CAMERA_ENABLE_FRAME_PROCESSORS=#{enableFrameProcessors}` is an interpolated define, and the
     reader drops such tokens (`read-podspec.js:626-627`).
   - `SWIFT_ACTIVE_COMPILATION_CONDITIONS` is never carried into `swiftSettings`. vision-camera's
     `VISION_CAMERA_ENABLE_LOCATION` is a Ruby ternary in that setting, so location tagging is compiled out.
     CocoaPods enables it by default.
3. **video and vision-camera: Swift 6 language mode.**
   - Mixed-language scaffolds use `// swift-tools-version: 6.4;(experimentalMultiLang)` (`scaffold-package-swift.js:214-215`;
     the `Package@swift-6.5.swift` copy uses 6.5, line 220). Pure-Swift scaffolds use `6.0` (line 1479).
   - Every tools version from 6.0 up defaults to the Swift 6 language mode; the compile line shows `-swift-version 6`.
   - video fails with 7 strict-concurrency errors (`AudioSessionManager.swift:5:16: static property 'shared' is not
     concurrency-safe …`). vision-camera fails the same way (`GlobalReferenceHolder.swift:11:22`, `CameraView.swift:23:40`).
   - CocoaPods compiles a pod in Swift 5 unless its podspec declares `swift_version`/`swift_versions`.
   - rn-xtool's own App target already sets `swiftLanguageModes: [.v5]` (`src/generate/packageSwift.ts:195`).
   - The podspec reader does not read `swift_version` today.
   - Hand fix: `.swiftLanguageMode(.v5)` in the target's `swiftSettings`. Both build, with warnings only.
4. **device-info: an umbrella directory next to other directories.**
   - The scaffold gets `publicHeadersPath: "ios"`, and `ios/` holds `RNDeviceInfo/RNDeviceInfo.h` (SwiftPM's
     umbrella-directory layout) next to `RNDeviceInfo.xcodeproj/`.
   - SwiftPM refuses: `target 'RNDeviceInfo' has invalid header layout: umbrella header found at
     '…/ios/RNDeviceInfo/RNDeviceInfo.h', but more than one directory exists next to its parent directory`.
   - Scaffolder fix 2 (`umbrellaNextToSubdirs`, `scaffold-package-swift.js:913-915`) checks only
     `<publicHeadersPath>/<SwiftName>.h`. When it fires, it uses the generated `include/<SwiftName>/` shim.
   - Hand fix: `publicHeadersPath: "ios/RNDeviceInfo"` builds.
5. **netinfo: a bare include of its codegen header.**
   - `ios/RNCNetInfo.mm:12` does `#import "RNCNetInfoSpec.h"` under `RCT_NEW_ARCH_ENABLED`, which the scaffold defines.
   - Codegen writes `ios/build/generated/ios/ReactCodegen/RNCNetInfoSpec/RNCNetInfoSpec.h`. The `ReactAppHeaders`
     product exposes it only as `<RNCNetInfoSpec/RNCNetInfoSpec.h>`. localize and webview use that form and build;
     CocoaPods' header search paths make the bare form work too.
   - Hand fix: an absolute `-I …/ReactCodegen/RNCNetInfoSpec` builds. An absolute path cannot ship, though: "a
     persisted (patch-package) manifest holds no absolute path" (`scaffold-package-swift.js:210`). The scaffolder
     already computes its app paths relative to the `build/generated/autolinking/libs/<SwiftName>` symlink, because
     SwiftPM resolves a manifest's relative paths there (lines 1841–1870).
6. **Noise that is not a failure.** video's podspec names `GoogleAds-IMA-iOS-SDK`, `SPTPersistentCache` and
   `DVAssetLoaderDelegate` inside `if defined?($RNVideoUse…)` blocks, which are off by default. The scaffolder still
   warns about all three as pods without a SwiftPM equivalent.

### rn-xtool's own steps

7. **Every scaffold run regenerates every library.**
   - `scripts/rn-spm-generate.js:192` calls `scaffoldAll({... force: true})`. The vendored `setup-apple-spm.js:479-488`
     does the same, with the comment "Always force a re-render so re-running after editing a podspec picks up the new
     content".
   - In the matrix, rn-xtool announced `generating Package.swift for: react-native-vision-camera`, and the scaffolder
     printed `Scaffolded Package.swift for 14 dep(s)`. device-info's hand fix in `node_modules` was gone, and its build
     error came back.
   - `patches/` still held the fix, and the `patches` step reported ✔ for two reasons: patch-package accepts a
     new-file patch over an existing file, and `refreshStaleScaffolds` (`src/pipeline/patches.ts:410`) replaces only
     older revisions or slots.
   - Without `force`, the scaffolder's own skip rule (`scaffold-package-swift.js:1765-1792`) leaves a file alone when
     its revision and cache slot are current.
   - `scaffoldAll` takes a `skipDeps` list (2163–2172) but no list of the only deps to scaffold.
   - The marker every scaffold carries says the file is safe to edit and persist with patch-package. Force
     regeneration breaks that promise.
8. **A failed scaffold is reported as something else.**
   - `runRnSpm` (`src/pipeline/rnSpm.ts`) logs `▸ scaffold — generating …` (line 266).
   - The scaffolder prints its errors as `! <name>: <reason>`, the same prefix as its warnings
     (`rn-spm-generate.js:200-205`). The matrix run had about 40 such lines.
   - rn-xtool then tries to persist every name and prints `⚠ Could not persist react-native-vision-camera's
     Package.swift to patches/ (… no changes)` (line 290). It runs React Native again and stops with `React Native SwiftPM
     setup still failed after scaffolding …` and the last 40 lines, which hold the misleading "mixed" error
     (lines 225 and 300).
9. **A patch left after an uninstall stops the build.**
   - The project's `patches/` are applied with `--patch-dir patches --error-on-fail` (`patches.ts:287-289`).
   - After `npm uninstall react-native-device-info`, patch-package fails: `Error: Patch file found for package
     react-native-device-info which is not present at node_modules/react-native-device-info`.
   - rn-xtool adds its generic "Report this at …/issues" message (`genericPatchFailureMessage`, `patches.ts:272-279`).
10. **Resource bundles do not reach the app.**
    - SwiftPM builds `RNCAsyncStorage_RNCAsyncStorage.bundle` and `RNDeviceInfo_RNDeviceInfo.bundle` from a stray
      `PrivacyInfo.xcprivacy` under the scaffold's `path: "."`. Neither bundle is in `App.app`.
    - `build` says nothing about it. `doctor --project` lists `resource_bundles` as an ℹ podspec feature only
      (`src/project/capabilities.ts`, `PODSPEC_FEATURES`).
    - The app's own `PrivacyInfo.xcprivacy` is not in `App.app` either: the template does not list it in its
      Resources phase.
    - Privacy manifests are read at App Store submission, not when a development build runs.
11. **Rules a scaffolder change must keep.**
    - `RN_XTOOL_SCAFFOLD_REVISION = 3` (`scaffold-package-swift.js:125`). `SCAFFOLD_REVISION = 3` (`patches.ts:306`)
      mirrors it.
    - A persisted patch at an older revision gets a "delete it so rn-xtool regenerates it" warning
      (`scaffoldPatchWarnings`, `patches.ts:314`). An unpersisted copy is regenerated.
    - Scaffolder changes ship as numbered fixes (`docs/upstream/react-native-scaffolder.md`, now 1–19) inside
      `patches/react-native+0.88.{0,1}.patch`.
    - `vendor/rn-spm/` is re-derived from the pristine tarball plus those fixes and the E1–E5 edits, and
      `tests/vendor-rn-spm.test.ts` compares bytes.
    - The daily drift watch dry-runs the bundled patches with `-F0` against the newest 0.88.x (`docs/RELEASING.md`,
      "What it checks").

### Third-party pods

12. **What the scaffolder does with `s.dependency` today** (`scaffold-package-swift.js:685-731`):
    - a subspec of the same podspec is dropped;
    - React Native core is recognised by name (`React`, prefixes `React-`, `RCT`, `Yoga`, `hermes-engine`, … at
      lines 497–520);
    - `react-native-*` becomes a sibling, and so does a pod name that matches an autolinked package's podspec
      (`podToNpm`);
    - an Expo-looking name gets a warning;
    - anything else goes through `KNOWN_POD_SPM_PACKAGES` (lines 147–153, one entry: `SwiftUIIntrospect` →
      swiftui-introspect 1.5.0, product `SwiftUIIntrospect`). A pod the table does not know gets the warning `Dependency
      "<pod>" is a CocoaPods pod with no known SwiftPM equivalent; the scaffolded package may fail to build`.

    The reader keeps only the name, not the version requirement (`getDependencies`, `read-podspec.js:535-546`).
13. **What the early checks see.**
    - `libraryFailures` (`src/project/earlyChecks.ts:318`) refuses a library rn-xtool would scaffold when its own
      podspec declares `vendored_frameworks` or `vendored_libraries` on an unconditional line (`binariesFailure`,
      line 223; `unconditionalLines`, line 182).
    - It skips packages taken out of iOS autolinking (`iosExcluded`, line 284).
    - The checks read files only and make no network request (`docs/troubleshooting.md:169`).
    - rn-xtool's own `dist/project/earlyChecks.js` was run on copies of react-native-app-auth 8.5.1 and
      @react-native-ml-kit/text-recognition 2.0.0 and returned `[]`. A control package with `vendored_frameworks` was
      refused.
14. **What happens today with those two.**
    - The scaffold is written without the pod and persisted (`✔ scaffold — persisted …`), so the user commits a
      manifest that cannot build.
    - The build then fails at compile time. AppAuth fails with `ios/RNAppAuth.m:5: #import "AppAuth.h"` not found. ML
      Kit fails with `ios/TextRecognition.m:3: @import MLKitVision.MLKVisionImage;` module not found.
15. **AppAuth-iOS has SwiftPM packages.**
    - react-native-app-auth 8.5.1 declares `s.dependency 'AppAuth', '>= 1.7.6'`.
    - Tags 1.7.6, 2.0.0, 2.1.0 and 3.0.0 of openid/AppAuth-iOS all ship a `Package.swift`. 3.0.0 (2026-08-24) is
      tools 5.7 and iOS 15, and its release notes call it "required to support Xcode 27".
    - The products are `AppAuthCore`, `AppAuth` and `AppAuthTV`. The library needs `AppAuth`, which uses
      `OIDExternalUserAgentIOS`.
    - 3.0.0 made `resumeExternalUserAgentFlowWithURL:error:` required in `OIDExternalUserAgentSession`. The library
      only calls the deprecated one-argument form, so this is a warning, not an error.
    - rn-xtool's `IOS_MIN` is 16.4.
16. **AppAuth's umbrella header is outside its SwiftPM targets.**
    - `RNAppAuth.m` does `#if __has_include(<AppAuth/AppAuth.h>) … #else #import "AppAuth.h"`.
    - AppAuth's umbrella `Sources/AppAuth.h` sits outside every target, so `@import AppAuth;` works but neither
      include form resolves. CocoaPods copies the header into `Headers/Public/AppAuth/`.
    - A forwarding header at `AppAuth/AppAuth.h` on the target's header search path, holding `@import AppAuthCore;`
      and `@import AppAuth;`, makes the first branch true.
17. **AppAuth's resources.** The AppAuth and AppAuthCore targets each `.copy("Resources/PrivacyInfo.xcprivacy")`, so
    SwiftPM builds a bundle for each. xtool's Planner adds bundles for targets reached from the App product, and
    `Packer.swift:158` copies `<package>_<target>.bundle` into the app. This path is untested through rn-xtool, and
    fact 10 shows scaffolded libraries' bundles do not arrive.
18. **Expo, AppAuth's config plugin and the bridging header.**
    - With the plugin (Expo 53 and later), the app's bridging header imports `"RNAppAuthAuthorizationFlowManager.h"`,
      and `AppDelegate.swift` conforms to `RNAppAuthAuthorizationFlowManager`.
    - rn-xtool's Expo branch copies only `AppDelegate.swift` and `SceneDelegate.swift`, with `mixed: false` and no
      bridging header (`src/generate/iosXtool.ts:103-118`). Swift would report "cannot find type".
    - The bare branch already passes `SWIFT_OBJC_BRIDGING_HEADER` (`src/project/pbxproj.ts:359`), and
      `appSwiftSettings` turns it into `-import-objc-header` (`packageSwift.ts:113-117`).
    - Expo's prebuild writes `SWIFT_OBJC_BRIDGING_HEADER = "<app>/<app>-Bridging-Header.h"` and `CODE_SIGN_ENTITLEMENTS =
      <app>/<app>.entitlements`, as seen in the SDK 57 and SDK 58 reference apps' pbxproj. By default the entitlements
      file is an empty dictionary and the bridging header holds only a comment.
19. **ML Kit is a binary-pod problem** (it belongs to the next block).
    - `RNMLKitTextRecognition.podspec` depends on `GoogleMLKit/TextRecognition` and its four language subspecs at
      8.0.0.
    - The graph resolves to static `.framework` binaries downloaded from dl.google.com, plus open-source pods that all
      have official SwiftPM packages except GoogleToolboxForMac 4.x.
    - There is no official ML Kit SwiftPM package.
    - The only things that concern this block: the resolver must refuse it early, offline, and its shape must leave
      room for a binary route.
20. **The CocoaPods CDN, for the next block.**
    - Any trunk pod's spec is plain JSON at
      `https://cdn.cocoapods.org/Specs/<md5[0]>/<md5[1]>/<md5[2]>/<Pod>/<version>/<Pod>.podspec.json` (301 to
      jsDelivr), with version lists in `all_pods_versions_<a>_<b>_<c>.txt`. No Ruby is needed.
    - A dependency requirement is a string or an array whose items may carry leading spaces.
    - Trunk becomes read-only on 2026-12-02. The Specs repo and the CDN stay up "as long as GitHub and jsDelivr do"
      (CocoaPods blog, "CocoaPods Specs Repo").
    - This block does not use it: the refusal needs no network.

### Entitlements

21. **rn-xtool passes none.**
    - `src/generate/xtoolYml.ts` writes `version`, `bundleID`, `product`, `infoPath`, `iconPath`, `skipLSP` and
      `resources`, and no `entitlementsPath`. Nothing in `src/` reads `CODE_SIGN_ENTITLEMENTS`, and
      `docs/bare-react-native.md:233` says entitlements are not read.
    - Info.plist keys do arrive: the target's `INFOPLIST_FILE` is copied.
22. **xtool takes an entitlements file.**
    - The `entitlementsPath` key exists in `xtool.yml`, also per extension (`Sources/PackLib/PackSchema.swift:18`).
    - `xtool dev` signs the packed app ad hoc with that file ("Applying entitlements...",
      `Sources/XToolSupport/DevCommand.swift:80-100`).
    - rn-xtool runs `xtool dev build`, `dev run` and `dev build --sign --ipa` (`src/tools/xtool.ts:163-194`), and pins
      xtool 1.24.0 (`src/versions.ts:1`).
23. **What xtool does with the entitlements at signing.** Read from xtool's source on `main` at 2af0b67 (2026-11-02),
    the local checkout, which is newer than 1.24.0:
    - `DeveloperServicesAddAppOperation.swift:179-198` reads the entitlements from the signed executable. It decodes
      only `EntitlementContainer.supportedTypes` (`EntitlementTypes.swift:15-33`): application-identifier,
      team-identifier, keychain-access-groups, get-task-allow, aps-environment, application-groups, multipath, VPN
      configuration, Siri, inter-app audio, wireless accessory configuration, Wi-Fi Aware, HomeKit, HealthKit and
      Sign in with Apple. Associated domains and network extension are commented out. A data-protection type exists
      but is not listed.
    - **On a free team**, it keeps only the decoded entitlements whose capability is not marked paid
      (`filter { $0.anyCapability?.isFree != false }`). Unknown keys and paid capabilities are dropped, and nothing
      is printed.
    - More than one App Group on a free team throws `tooManyAppGroups` (line 192): this is the only refusal found.
    - Then `update(teamID:bundleID:)` rewrites application-identifier, team-identifier and keychain-access-groups to
      `<Team ID>.<App ID>` (`EntitlementWithTeamOrBundleID.swift:15-31`). The App ID is the one xtool registers,
      `XTL-<Team ID>.<bundle id>` (`ProvisioningIdentifiers.identifier(fromSanitized:)`,
      `DeveloperServicesAddAppOperation.swift:46` and `:190-196` in 1.24.0), so the only keychain group in the signature
      is `<Team ID>.XTL-<Team ID>.<bundle id>`. A shared keychain group is replaced by the app's own.
    - xtool's free/paid flags (`DeveloperServicesCapability.swift`):
      - free: App Groups, HealthKit, HomeKit, inter-app audio, wireless accessory;
      - paid: Sign in with Apple, associated domains, multipath, network extension, VPN, push, Siri, Wi-Fi Aware.
    - On a paid team, unknown keys stay in the signature but no capability is enabled on the App ID: xtool issue #352,
      open. Mistyped `xtool.yml` keys are ignored silently: issue #353.
24. **Apple's free column** ("Supported capabilities (iOS)", read 2026-11-04):
    - free: App Groups, Background Modes, Data Protection, HealthKit, HomeKit, Inter-App Audio, Keychain Sharing, Maps,
      Wireless Accessory Configuration;
    - not free, among others: Access Wi-Fi Information, Hotspot, Push Notifications, Associated Domains, Sign in with
      Apple, iCloud, NFC, Network Extensions, Personal VPN, Multipath, Siri;
    - Xcode's wording for the refusal is "Personal development teams … do not support the X capability".
25. **What the work app's libraries need** (matrix):
    - wifi-reborn needs Access Wi-Fi Information (`com.apple.developer.networking.wifi-info`) for the SSID and
      Hotspot Configuration (`…networking.HotspotConfiguration`) to join networks;
    - netinfo needs Access Wi-Fi Information for the SSID only;
    - keychain's `accessGroup` option needs `keychain-access-groups`;
    - device-info needs the restricted `com.apple.developer.device-information.user-assigned-device-name` for the
      real device name;
    - Amplify push needs `aps-environment`;
    - the rest need Info.plist keys only.

### Leaving a module out

26. **What exists today.**
    - The React Native CLI drops a library from iOS autolinking when the app's `react-native.config.js` sets its
      `platforms.ios` to `null`. React Native's own mixed-language error even suggests it:
      `module.exports = { dependencies: { 'react-native-vision-camera': { platforms: { ios: null } } } }`.
    - Expo has `expo.autolinking.exclude`. rn-xtool's early checks honour both (`iosExcluded`).
    - The SwiftPM steps get the autolinking JSON from a config command: `AUTOLINKING_CONFIG_COMMAND` in `rnSpm.ts`,
      and `--config-command` on the driver and on `setup-apple-spm.js`.
    - The work app's `react-native.config.js` is shared with its Xcode/CocoaPods build and with Android.

**Disk.** The build disk had about 20 GB free on 2026-11-04. The matrix app took 537 MB without its build outputs,
which were deleted to save space.

## Goals

### 1. Scaffolder: four fixes, plus one carried along

All five are generic, go into `docs/upstream/react-native-scaffolder.md` as fixes 20–24, and ship in
`patches/react-native+0.88.{0,1}.patch` and the re-derived `vendor/rn-spm/` (fact 11).

1. **A dependency on a package that is not installed is left out (fix 20).**
   - A dependency that names an npm package (`react-native-*`), or a pod-style name that would map to a sibling, is
     dropped when that package is not autolinked for iOS. The warning reads: `Dependency "react-native-worklets-core"
     is not installed (or not linked for iOS); left out, as CocoaPods leaves it out.`
   - When the dependency is declared inside a subspec, that subspec goes with it: its sources, public headers,
     settings and dependencies, plus the main spec's references to it (`VisionCamera/FrameProcessors`). The warning
     names the subspec.
   - The reader keeps per-layer dependencies for this: the regex path already reads main and subspecs as layers, and
     `flattenSubspecs` handles `pod ipc`.
   - A main-spec dependency is dropped alone, and its sources stay. Whether to drop the whole subspec is open
     question 1.
2. **Swift 5 language mode unless the podspec asks for 6 (fix 21).**
   - The reader reads `swift_version` / `swift_versions`: literal strings or arrays, `ios`-scoped too, on both paths.
   - Every scaffold with Swift sources gets `swiftLanguageModes: [.v5]` at package level, unless the highest declared
     version is 6 or higher. This covers mixed and pure-Swift scaffolds, and the 6.5 manifest too.
   - An absent or unreadable value means Swift 5, as in CocoaPods.
3. **The umbrella-directory layout (fix 22).** When `<publicHeadersPath>/<SwiftName>/<SwiftName>.h` exists and the
   public headers directory holds any other directory, the scaffold uses the same `include/<SwiftName>/` shim as
   fix 2. The shim is fed with every header among the sources, and its basename-collision warning is unchanged. A
   lone `<SwiftName>/` directory is left as it is, because SwiftPM accepts it.
4. **The codegen header path (fix 23).**
   - A library whose `package.json` has `codegenConfig.name` X gets `build/generated/ios/ReactCodegen/X` on its C and
     C++ header search path.
   - The path is relative to the `libs/<SwiftName>` symlink, like the codegen package path the scaffolder already
     computes. The manifest therefore holds no absolute path, and a test asserts it.
   - How the flag is anchored is open question 2.
5. **Swift compilation conditions (fix 24, carried along under "fix, don't file").** Literal
   `SWIFT_ACTIVE_COMPILATION_CONDITIONS` from `pod_target_xcconfig` become `.define("X")` in `swiftSettings`.
   Interpolated tokens are dropped, as for C defines. vision-camera's location condition is a Ruby ternary, so it stays
   off, and the docs say so. Open question 7 asks whether this belongs here.
6. **Revision 4.**
   - `RN_XTOOL_SCAFFOLD_REVISION` and `SCAFFOLD_REVISION` go to 4.
   - Persisted scaffold patches then get the existing "older revision" warning, and unpersisted copies are
     regenerated.
   - The daily `-F0` dry run keeps the 0.88 patches honest, and `tests/vendor-rn-spm.test.ts` keeps the vendored copy
     equal to pristine + fixes + E1–E5.
   - All new manifest content (the `-I`, the forwarders of goal 3, the language mode) is portable: no absolute path,
     nothing outside the package except through the symlink-relative app paths.

### 2. rn-xtool's pipeline

1. **Scaffold only what React Native reports.**
   - `runRnSpm` passes the names it parsed (`parseMissingPackageSwift`) to the scaffold step: `--only <name>…` on
     `rn-spm-generate.js --scaffold`, and the same list on Expo SDK 58's path.
   - `scaffoldAll` gains an `onlyDeps` option (the dual of `skipDeps`), and rn-xtool's calls drop `force: true`.
   - Every other library's manifest, hand-edited and persisted, is left alone. The skip rule still regenerates a named
     library whose copy has a stale revision or slot.
   - The summary lists exactly the libraries written.
2. **The real failure comes first.**
   - The scaffold step reports a status per library, for example as a JSON results file the driver writes.
   - When a named library has no scaffolded `Package.swift` afterwards, rn-xtool stops there with `Scaffolding
     react-native-vision-camera failed: <the scaffolder's reason>`, followed by that library's own warnings.
   - It does not persist that library and does not run React Native a second time.
   - Libraries that did scaffold are persisted as today.
   - Warnings stay, grouped per library, after the error.
3. **A patch for a package that is not installed is skipped.**
   - Before applying the project's `patches/`, rn-xtool reads each patch name. A patch whose package has no
     `node_modules/<pkg>/package.json` (the condition patch-package itself fails on) is left out of the run.
   - The warning reads: `⚠ patches/react-native-device-info+15.0.2.patch is for react-native-device-info, which is
     not installed; skipped. Delete it if you removed the library.`
   - `doctor --project` prints the same line.
   - The other patches apply as today.
4. **Resource bundles: said, not copied** (accept for dev builds).
   - `build` prints one ℹ line per run for the libraries rn-xtool scaffolded whose resources do not reach the app:
     `ℹ Not copied into the app: @react-native-async-storage/async-storage (PrivacyInfo.xcprivacy), react-native-svg
     (RNSVGFilters.bundle). Code that loads them at run time does not find them.`
   - When every resource named is a privacy manifest, the line ends `Development builds run without them; privacy
     manifests are read only at App Store submission.` instead.
   - `docs/libraries.md` and `docs/troubleshooting.md` state the same in the present tense.
   - Copying bundles is not in this block.

### 3. Third-party pod resolution

1. **One resolver.**
   - Each `s.dependency` (name and requirement) on an unconditional line of a library rn-xtool would scaffold is
     classified once, as one of:
     - a subspec of the same podspec → skipped;
     - React Native core or Expo → skipped, as today;
     - an autolinked sibling → wired;
     - a sibling that is not installed → left out (goal 1.1);
     - a pod in the table → `.package(url:exact:)` plus its products;
     - anything else → **unmapped**.
   - The classifier is exported from the vendored scaffolder, so it stays one function and an upstream candidate.
   - The early check loads it from rn-xtool's own vendored copy, the way it loads the Expo plugin's readers today. It
     uses the regex reader only, never `pod ipc`, which would evaluate the podspec.
   - The result has room for a `binary` route (next block) without changing its callers.
2. **The table.**
   - Shipped entries (SwiftUIIntrospect, AppAuth) are merged with a `pods` object in `rn-xtool.config.json`; the
     config wins.
   - Shape: `{ "url": string, "exact": string, "products": string[], "subspecs"?: { "<name>": string[] },
     "forwardHeaders"?: { "<Dir/Header.h>": string[] } }`. `product` is still accepted for the existing entry.
   - A wrong shape is a `ConfigError` naming the key, like `knownLimits`.
   - rn-xtool hands the merged table to the scaffolder as a file under `ios/build/` named by an environment variable
     in `rnSpmEnv`. The scaffolder falls back to its built-in table without it.
   - Each manifest records the pods it pinned on a marker line (`// rn-xtool-pods: AppAuth=3.0.0`). A later config
     change then makes the persisted patch stale, and `scaffoldPatchWarnings` warns, as for the slot.
3. **The requirement is checked, not resolved.**
   - The reader keeps the requirement. The pinned `exact` is compared with it: `=`, `>`, `>=`, `<`, `<=`, `~>`,
     several requirements, and the array form with trimmed items.
   - A mismatch is a ⚠ at `doctor --project` and at build start, naming both. It is not a refusal (open question 6).
4. **An unmapped pod is refused early, offline.**
   - New `EarlyCheckId` `"unmapped-pod"`, with the package name as the `allowKey`.
   - Text: `react-native-app-auth 8.5.1: its podspec depends on the CocoaPods pod AppAuth, which has no SwiftPM package
     rn-xtool knows. Add one under "pods" in rn-xtool.config.json: { "pods": { "AppAuth": { "url": "<git URL>",
     "exact": "<version>", "products": ["<product>"] } } }, or leave the library out with "exclude". See
     <troubleshooting#libraries-that-depend-on-cocoapods-pods>`, then the usual `knownLimits.allow` line.
   - `doctor --project` and `build` stop on it before anything changes, like the other refusals. ML Kit is refused by
     the same rule. Its troubleshooting entry says that pods shipped as binaries need a later rn-xtool, and that
     `exclude` is the way through today.
5. **AppAuth is the first entry.**
   `AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "3.0.0", products: ["AppAuth"], forwardHeaders:
   { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] } }`.
   - 3.0.0 is the newest tag `>= 1.7.6` accepts, the map's convention.
   - The scaffolder writes `rn-spm-pod-headers/AppAuth/AppAuth.h` (`@import AppAuthCore;` and `@import AppAuth;`)
     into the library and adds `.headerSearchPath("rn-spm-pod-headers")` to its C and C++ settings.
   - The forwarder is a text file inside the package, persisted with the scaffold.
6. **Expo passes its bridging header through.**
   - The Expo branch of `writeAppSources` reads `SWIFT_OBJC_BRIDGING_HEADER` from the prebuild's pbxproj with the
     existing reader, copies the header into `Sources/App` and sets `app.bridgingHeader`.
   - A setting that names a missing file is an error that names it.
   - An Expo app with the default comment-only header compiles as before.

### 4. Leaving a native module out of a dev build

1. **Config.** `"exclude": ["react-native-vision-camera"]` in `rn-xtool.config.json`. A wrong shape is a
   `ConfigError`.
2. **Mechanism.**
   - rn-xtool wraps the autolinking config command, on the bare and Expo paths alike, with a small filter. The filter
     sets `platforms.ios` to `null` for each listed package in the JSON: exactly what `platforms.ios: null` in
     `react-native.config.js` produces.
   - The difference is scope. The exclusion lives in rn-xtool's config, so the project's `react-native.config.js`
     stays as it is for Xcode, CocoaPods and Android. Both ways work, and the docs say when to use which.
   - The early checks, the resolver and the entitlement check skip excluded packages.
   - A persisted scaffold patch of an excluded library stays applied; it is harmless.
3. **What the user sees.** `doctor --project` and `build` print: `ℹ exclude — left out of this iOS build:
   react-native-vision-camera (rn-xtool.config.json). JavaScript that uses it must check that it is there; see
   <docs>`. A name that is not an iOS-native dependency of the project prints `⚠ exclude names <x>, which is not a
   native iOS dependency of this project; ignored`.
4. **Docs: how the JavaScript guards it.**
   - The JavaScript is still bundled. A module looked up at import (`TurboModuleRegistry.getEnforcing`) throws at
     import, and one looked up later throws on first use.
   - The documented guard wraps the import and its use:

     ```js
     let NetInfo;
     try {
       NetInfo = require('@react-native-community/netinfo').default;
     } catch {
       NetInfo = undefined; // left out of this iOS build
     }
     ```

   - A native view is not rendered when its module is absent.
   - Expo modules: open question 3.

### 5. Entitlements

1. **Source.**
   - Bare: `CODE_SIGN_ENTITLEMENTS` of the app target's Debug configuration (`resolveSetting`).
   - Expo: the same key in the prebuild's pbxproj, so config plugins' and `ios.entitlements` additions are included.
   - When the key is unset, nothing changes and nothing is printed.
2. **Passing it.**
   - rn-xtool parses the file with its plist module and writes `ios-xtool/App.entitlements`.
   - `xtool.yml` gets `entitlementsPath: App.entitlements`; a test pins the exact key (xtool issue #353).
   - `$(…)` references are resolved from the pbxproj where possible. xtool rewrites the identifiers anyway (fact 23).
3. **The check, before compiling** (a new `entitlements` line in `doctor --project`; the same lines at build start).
   Each key is looked up in a table rn-xtool ships: xtool 1.24.0's known types with their free/paid flag, Apple's free
   column, and a short phrase for the feature. Lines, in the present tense:
   - known to xtool and paid: `⚠ aps-environment is not available on a free team; the build continues without it;
     push notifications fail at runtime.`
   - unknown to xtool: `⚠ com.apple.developer.networking.wifi-info is not available on a free team, and xtool does
     not enable it on a paid one; the build continues without it; reading the Wi-Fi network name returns nothing at
     runtime.`
   - free for Apple but unknown to xtool: `⚠ com.apple.developer.default-data-protection is not enabled by xtool; the
     build continues without it; files keep the default protection.`
   - shared keychain groups: `⚠ keychain-access-groups lists other groups; xtool signs the app with its own group
     only (<Team ID>.XTL-<Team ID>.com.example.app); the build continues; sharing keychain items with other apps fails
     at runtime.`
   - App Groups: xtool 1.24.0 marks them paid (`isFree: false`, "FIXME: Enable app groups on free accounts") and has
     no `tooManyAppGroups`, so they get the paid line: `⚠ com.apple.security.application-groups is not available on a
     free team; the build continues without it; sharing data with other apps and extensions through the group fails
     at runtime.` There is no line for several groups and no `xtoolErrors.ts` mapping (Task E1).
   - known to xtool and free: nothing.
4. **Refusals.**
   - The only refusals: the file named by `CODE_SIGN_ENTITLEMENTS` is missing, or it is not a plist dictionary.
     xtool cannot sign with either.
   - Every other content is signed by xtool on some team, so it is not refused. rn-xtool does not know the team at
     build time (open question 4).
5. **Mechanism, not memory.** The table records "checked with xtool 1.24.0". A unit test fails when `XTOOL_VERSION`
   changes and the table's version does not, so every xtool bump re-reads `supportedTypes` and the free filter. A key
   missing from the phrase table gets a generic phrase ("the feature that needs it").
6. **Docs.**
   - `docs/libraries.md` lists each tested library's Info.plist keys and entitlements (fact 25).
   - `docs/troubleshooting.md` gets an "Entitlements" section.
   - `docs/bare-react-native.md` and `README.md` no longer say entitlements are not read.

### 6. Docs and tests

- **Docs.**
  - `docs/libraries.md`: rows for the four libraries and react-native-app-auth in the Bare 0.88 column, the
    entitlement/Info.plist column, and "pods with a SwiftPM package" in the intro. The `resource_bundles` sentence
    becomes present-tense behaviour.
  - `docs/troubleshooting.md`: "Libraries that depend on CocoaPods pods", "Leaving a module out", "Entitlements", the
    orphan-patch line, and the scaffold-failure message.
  - `docs/upstream/react-native-scaffolder.md`: fixes 20–24.
  - `docs/how-it-works.md`: the resolver and the scaffold step.
  - `CHANGELOG.md`: Added and Fixed entries under Unreleased.
- **Tests.** One red→green unit test per fix:
  - the scaffolder fixes 20–24, on fixture podspecs in each library's shape;
  - `onlyDeps` and no force;
  - scaffold failure reporting;
  - orphan patches;
  - resolver classes, requirement matching, refusal text and `knownLimits.allow`;
  - config shapes (`pods`, `exclude`);
  - the forwarder;
  - the Expo bridging header;
  - the config-command filter;
  - entitlements reading, xtool.yml rendering, the check's lines and the `XTOOL_VERSION` guard;
  - no absolute path in any emitted manifest.

## Non-goals

- **ML Kit and binary pods.** This includes reading the CocoaPods CDN, downloading and thinning binaries, and the
  model bundles. That is the next block. This block only refuses them early and shapes the resolver for them.
- **Copying resource bundles into the app** (goal 2.4 only states what happens), and Xcode-only resources:
  splash screen, storyboards, asset catalogs.
- **The React Native 0.85 line.** It has its own block.
- **The work app's build itself.** It follows the 0.85 line and the ML Kit block.
- **Paid-team behaviour of unknown entitlements**, beyond the line that names it (xtool #352). There is no paid
  account to verify it with.
- **Inferring entitlements from libraries.** rn-xtool reads what the app declares, and the docs list what each
  library needs.
- **Location tagging in vision-camera.** Its switch is a Ruby ternary the reader cannot evaluate.
- **Expo-module scaffolding**, which goes through Expo's plugin.

## Failure walk

The process, end to end:

1. read the config (`pods`, `exclude`);
2. early checks: classify each library's pods, read the entitlements;
3. `patches`: bundled, then the project's, without orphans;
4. `rn-spm`: autolinking through the exclude filter, codegen, React Native reports missing manifests;
5. scaffold the named libraries: resolver, subspec drop, language mode, umbrella, codegen path, forwarders;
6. persist into `patches/`;
7. `rn-spm` again;
8. `generate`: App sources, Expo bridging header, `App.entitlements` and `xtool.yml`;
9. `xtool dev build`: SwiftPM fetches mapped packages from GitHub, compiles and links, and the app is signed ad hoc
   with the entitlements;
10. signing for the device: xtool filters entitlements per team and registers capabilities;
11. on the device: runtime.

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | Config | `pods`, `exclude` or an entry of the wrong shape | user, in every command: `rn-xtool.config.json: pods.AppAuth.products must be a list of product names` | handle: shape checks like `knownLimits`, unit tests |
| 2 | Config `pods` | a product name or URL that is wrong but well formed | user at `xtool-build`: SwiftPM's resolve error names the product or the package | accept: checking it needs the network; the troubleshooting entry shows SwiftPM's message |
| 3 | Resolver, requirement | the pinned version is outside the podspec's requirement | user: `⚠ AppAuth 3.0.0 (rn-xtool table) is outside react-native-app-auth's requirement ">= 4.0"` at doctor and build start | handle: warning, not refusal (open question 6) |
| 4 | Resolver, classification | a third-party pod named like React Native core (an `RCT…` prefix) is skipped as core | user: a compile error naming its header | accept: the existing prefixes are kept, and a core name wins over `pods`, which cannot map it; the troubleshooting entry for "file not found" points to `exclude` or an issue |
| 5 | Resolver, unmapped | a pod with no mapping (AppAuth before the table, ML Kit) | user at `doctor --project` and build start, before anything changes: the refusal with the config snippet | handle: new early check, offline, fixture tests for both libraries' shapes |
| 6 | Resolver, unmapped | the pod sits under a Ruby condition (video's `$RNVideoUse…` pods) | nobody: it is not refused, and the scaffolder only warns, as CocoaPods would not install it | handle: the check reads `unconditionalLines`; a test with video's podspec shape |
| 7 | Resolver, unmapped, allowed | the user lists the library in `knownLimits.allow` | user: the allowed-limit warning; the build fails at compile time as today, and the scaffold is persisted for the user to edit | accept: the allow is the user's choice; the warning says the build may fail later |
| 8 | Scaffold, missing sibling | the dependency is not optional: sources that stay still include its headers | user: `⚠ Dependency "<pkg>" is not installed …; left out` in rn-xtool's summary, then a compile error naming the header | handle: the warning is printed with the library's result, before any compile error; the build-only proof covers vision-camera |
| 9 | Scaffold, missing sibling | dropping the subspec removes sources that other code needs | user: a compile or link error | handle: the build-only proof (vision-camera builds with frame processors left out, as CocoaPods would); open question 1 |
| 10 | Scaffold, language mode | a library declares `swift_version` 6 but is not Swift 6 clean | user: compile errors | accept: CocoaPods compiles it in Swift 6 too |
| 11 | Scaffold, language mode | `swift_version` is interpolated or computed | nobody: read as absent, so Swift 5 | handle: CocoaPods' default; unit test |
| 12 | Scaffold, umbrella | the shim collects two headers with the same basename | user: the existing collision warning; a compile error only if the skipped one is needed | accept: fix 2's rule, unchanged |
| 13 | Scaffold, codegen path | the `-I` anchor resolves to the wrong place (the symlink compared with the real directory) | user: `'RNCNetInfoSpec.h' file not found`, as today | handle: the build-only proof; open question 2 has the fallback |
| 14 | Scaffold, codegen path | the codegen folder for the name does not exist | nobody: a search path to a missing folder is ignored | accept |
| 15 | Scaffold, only named | a library outside the list has a stale scaffold (revision or slot) | user: the existing "older revision / other React Native" warning for its persisted patch; an unpersisted copy is regenerated by `refreshStaleScaffolds` | accept: existing behaviour (fact 11) |
| 16 | Scaffold, only named | after a podspec edit, the user expects a re-render, which force used to give | user: the edit has no effect | accept: documented: delete the library's `Package.swift` (and its patch) to regenerate |
| 17 | Scaffold failure | the scaffolder throws for one library | user: `Scaffolding <lib> failed: <reason>` first; no persist and no second run; the other libraries are persisted | handle: goal 2.2, unit test with a throwing fixture |
| 18 | Scaffold failure | it does not throw but writes nothing | user: the same message, with "no Package.swift was written" as the reason | handle: the check is "a scaffolded Package.swift exists", not the exit code |
| 19 | Revision 4 | every app with persisted scaffold patches gets a warning per patch after upgrading | user: `⚠ patches/<x> was written by an older rn-xtool scaffolder (revision 3, now 4); delete it …` | accept: the existing rule; the CHANGELOG says to delete and rebuild |
| 20 | Persist | patch-package fails | user: the existing `⚠ Could not persist …; the build continues` | accept: existing behaviour; it no longer appears after a failed scaffold (row 17) |
| 21 | Patches, orphan | a patch for an uninstalled package | user: `⚠ patches/<x> is for <pkg>, which is not installed; skipped …` in build and doctor | handle: goal 2.3, unit test with a fake patch |
| 22 | Patches, orphan | the package is installed at another version | user: patch-package's own version warning, or the existing slot warning | accept: unchanged |
| 23 | Patches, persisted pins | the config's pin changes after the scaffold was persisted | user: `⚠ patches/<x> pins AppAuth 3.0.0, the config says 3.1.0; delete it …` | handle: the `rn-xtool-pods` marker line plus `scaffoldPatchWarnings` |
| 24 | SwiftPM fetch (GitHub) | offline, rate-limited, or the tag is gone | user at `xtool-build`: SwiftPM's resolve error naming the URL | accept: as for SwiftUIIntrospect today; first fetch only; the docs say a clean `.build` needs the network for mapped pods |
| 25 | SwiftPM fetch | duplicated: the same package pinned at another version by a self-managed library or the app | user at `xtool-build`: SwiftPM's version conflict naming both | accept: documented; the table is one place to align pins |
| 26 | AppAuth link | AppAuth's resource bundles do not reach the app (fact 10) | nobody at launch; they hold privacy manifests only | accept: goal 2.4's ℹ line names them; the build-only proof records whether they arrive |
| 27 | Expo bridging header | the header imports something its search paths do not reach (`RNAppAuthAuthorizationFlowManager.h`) | user at `xtool-build`: file not found | handle: the Expo build-only check (open question 8); unit test for the passthrough |
| 28 | Exclude | the name is not a native dependency, or is misspelled | user: `⚠ exclude names <x> … ignored` | handle: goal 4.3 |
| 29 | Exclude | another library depends natively on the excluded one | user: the scaffolder's "not installed or not linked for iOS; left out" warning, then a compile error if it is required | accept: the warning names it; the docs say to exclude the dependents too |
| 30 | Exclude | codegen still generates the excluded library's code (codegen reads `react-native.config.js`, not the config command), and something references it | user: a link or G4 error | handle: the build-only proof excludes netinfo; if it fails, the filter also feeds codegen's exclusion |
| 31 | Exclude, runtime | the JavaScript imports the module without a guard | user on the device: a red screen at import or first use | accept: present-tense docs plus the ℹ line at every build |
| 32 | Exclude, Expo module | an Expo module is listed; Expo's plugin links it anyway | user: the module is still in the app | handle per open question 3 (proposed: a ⚠ naming `expo.autolinking.exclude`) |
| 33 | Entitlements, read | `CODE_SIGN_ENTITLEMENTS` names a missing file, or a file that is not a plist dictionary | user at doctor and build start: a refusal naming the file | handle: goal 5.4 |
| 34 | Entitlements, read | Debug and Release name different files | nobody: rn-xtool builds Debug | accept: the Debug one is read, and the docs say so |
| 35 | Entitlements, free team | a paid or unknown key is dropped by xtool | user: the ⚠ line before the build; on the device the feature does not work | handle (the line) and accept (Apple's policy) |
| 36 | Entitlements, paid team | an unknown key stays in the signature without a capability on the App ID | user: the ⚠ line; possibly an install error from the iPhone | accept: unverified without a paid account (Non-goals); the line says xtool does not enable it |
| 37 | Entitlements, App Groups | App Groups on a free team (xtool 1.24.0 marks them paid and has no `tooManyAppGroups`) | user: the paid ⚠ line for `com.apple.security.application-groups`; on the device, sharing through the group fails | handle: the paid line from the entitlement table (Task E1: no several-groups line, no `xtoolErrors.ts` mapping) |
| 38 | Entitlements, keychain | a shared group is replaced by the app's own | user: the ⚠ line; on the device, shared items are not found | handle (the line) and accept (xtool's rewrite); the app's own group, written `$(AppIdentifierPrefix)` or `$(TeamIdentifierPrefix)` followed by the bundle id, `$(PRODUCT_BUNDLE_IDENTIFIER)` or `$(CFBundleIdentifier)`, gets no line (tests `resolves $(CFBundleIdentifier) as the bundle id, and both own-group forms get no line (row 38)`, `counts $(TeamIdentifierPrefix)<bundle id> as the app's own keychain group (row 38)`) |
| 39 | Entitlements, table drift | a newer xtool knows more types or changes the free filter | maintainer: the `XTOOL_VERSION` guard test fails on the bump | handle: goal 5.5 |
| 40 | Entitlements, xtool 1.24.0 | the pinned release differs from the `main` source that was read | user: lines that are wrong about what xtool drops | handle: the builder reads the 1.24.0 tag's source before coding the table (open question 5) |
| 41 | Device | a scaffold compiles but registers nothing (vision-camera without frame processors, device-info through the shim) | user: the library does nothing, or "not linked" at runtime | handle: the owner's device pass (Verification) before any doc calls these device-verified |
| 42 | Scaffold, codegen header forwarder | the bare `X.h` forwarder at the root of the per-app header tree shadows a library's own header of the same name | user: a compile error, or the wrong declarations, in a library that includes its own `X.h` | handle: no forwarder when a library's `<SwiftName>/X.h` is in the tree, with the scaffolder warning (test `no forwarder when a library's own header has the name, with a warning`); a same-named header outside the tree (a self-managed package, an Expo module, the app's sources) is not covered |
| 43 | Patches, orphan | a patch in a scoped subfolder (`patches/@scope/name+1.0.0.patch`) is read as an orphan | user: a false `⚠ … is not installed; skipped` line, and the patch is not applied | handle: the path relative to `patches/` is read as patch-package 8 reads it (test `does not call a scoped patch in a subfolder an orphan`) |
| 44 | Build, resource line | a resource value over several lines whose closing line carries an `if`/`unless` modifier runs on to the end of the podspec | user: the `ℹ` line names source globs and dependencies as resources | handle: the value is read from the raw lines, and such an assignment is left out (test `leaves out a value over several lines whose closing line carries a modifier`) |
| 45 | Scaffold, only named × missing sibling | the user installs a dependency the scaffolder left out (row 8) after the library's scaffold was persisted; React Native names only the new package, and the persisted scaffold is current, so the subspec stays left out with no warning | user: on the device, when the left-out feature (vision-camera's frame processors) fails at run time | accept: troubleshooting's dropped-subspec entry says the subspec stays out until the library is re-scaffolded, next to the re-scaffold steps |
| 46 | Build, resource line | the `ℹ` line says development builds run without resources that code loads at run time (fonts, images, svg's `RNSVGFilters.bundle`) | user: blank icons or a missing feature on the device, after a line that said nothing was needed | handle: the second sentence depends on the kinds: the privacy sentence only when every item is a `.xcprivacy`, else `Code that loads them at run time does not find them.` (test `says privacy manifests are read only at App Store submission only when every resource is one`) |
| 47 | Config `pods`, override | a config entry pins a shipped pod to another version with the `{url, exact, products}` shape the refusal teaches, and so drops the shipped `forwardHeaders` | user at `xtool-build`: `"AppAuth.h" file not found` | handle: per pod, a config entry overrides only the fields it names; an empty `forwardHeaders` removes them (test `merges a config entry over the shipped one field by field`) |
| 48 | Patches, persisted pins | a library with mapped pods was re-scaffolded without the pod table (a bare `npx react-native spm scaffold`, or before the `rn-xtool-pods` line existed), so its manifest pins nothing and the forwarder is gone | user: `⚠ patches/<x> does not pin AppAuth, rn-xtool's table says 3.0.0: it was scaffolded without rn-xtool's pod table (not through rn-xtool build); delete it …` in build and doctor; an unpersisted copy is regenerated | handle: the expected pins come from the podspec's mapped dependencies, not only from the line (tests `warns when a persisted scaffold of a library with mapped pods pins nothing`, `regenerates an unpersisted copy whose pins differ`) |
| 49 | Early checks, pod index | a library's podspec names a sibling by its pod name (reanimated's `RNWorklets`), and the sibling is installed as a peer or a transitive dependency, not listed in package.json. Expo's autolinking links it (it scans dependencies recursively); on bare the community CLI links only the app's `dependencies`, `devDependencies` and `peerDependencies`, so the scaffolder reads the name as a CocoaPods pod it cannot map | user at doctor and build start: a refusal telling them to map `RNWorklets` to a SwiftPM package; on bare without one, the scaffold's unmapped warning and a compile error minutes later | handle: the pod-name index covers every package installed at the top of node_modules (and `@scope/*`). On Expo the name reads as a sibling (test `on Expo, does not refuse a sibling installed as a peer, outside package.json`). On bare the build and doctor refuse early: `<lib> <version>: its podspec depends on <npm>, which is installed but not listed in package.json, so React Native does not link it; add it to dependencies (npm i <npm>). See …` and the `knownLimits.allow` line, which turns it into a warning (tests `on bare, refuses a pod sibling installed but not listed in package.json (row 49)`, `names several unlisted siblings in one refusal`, `passes the project kind to the library checks`) |
| 50 | Early checks, core pods | a podspec names a pod React Native itself ships or generates outside the scaffolder's core prefixes (`ReactNativeDependencies`, `FBLazyVector`, `fast_float`, `ReactCodegen`, `SocketRocket`) | user at doctor and build start: a refusal asking for a SwiftPM package for a React Native pod | handle: those names are core in the scaffolder (fix 13), and a drift test reads every podspec name in the cached react-native tarballs and expects `core` (tests `<name> is core`, `classifies every podspec name in react-native@<version> as core`) |
| 51 | Early checks and stale pins, what the scaffold reads | a mapped or unmapped pod sits in a subspec the scaffolder drops for a missing sibling (fix 20), or is written as a call, `s.dependency('Pod', …)` | user: a refusal for a pod the scaffold never uses, or a `does not pin` ⚠ on every build (an unpersisted copy removed and rewritten each time) | handle: the early checks drop the same subspecs with their dependencies, so their pods are neither expected nor refused (test `leaves out the pods of a subspec the scaffolder drops for a missing sibling`); a dependency written as a call, `s.dependency('Pod', …)`, which the early checks read and the scaffolder did not, is read by the scaffolder too (fix 26, tests `26: reads `s.dependency('Pod', …)` as CocoaPods does`, `26: pins a mapped pod named in parentheses`) |
| 52 | Entitlements, Expo default | every Expo prebuild sets `CODE_SIGN_ENTITLEMENTS` to a file holding only `<dict/>`; passed on, it makes xtool run an ad-hoc signing pass ("Applying entitlements...") that no Expo build ran before | user: if that pass fails on some host, every Expo build fails after compiling, entitlements or not | handle: a file without keys is not passed: no `ios-xtool/App.entitlements`, no `entitlementsPath`, so `xtool.yml` stays byte-identical, and doctor prints no entitlements line, as without the setting (tests `passes no entitlements for the prebuild's empty file: xtool.yml stays byte-identical (row 52)`, `reads the entitlements`) |
| 53 | Expo prebuild | rn-xtool's own `npx expo prebuild` exits non-zero (a config plugin throws, as react-native-app-auth 9.0.0's does on SDK 58) and leaves a half-written `ios/`; rn-xtool prebuilds only without `ios/` or on `--clean`, so the next plain build would skip prebuild and build that half state (an unpatched AppDelegate, a bridging header that imports a missing class) | user: the prebuild's error at `▸ prebuild`; then, from the next build, a compile error or an app without the plugin's changes | handle: rn-xtool removes the `ios/` its failed prebuild left and adds `The failed prebuild left ios/ half-written, so rn-xtool removed it; the next build runs expo prebuild again.` to the error; a prebuild that failed before writing `ios/` (an `app.config.js` that throws) keeps its error as it is; when the removal fails, the error says to delete `ios/` or run `rn-xtool build --clean` (tests `removes the ios/ a failed prebuild left and says so (row 53)`, `rethrows the error unchanged when the failed prebuild wrote no ios/`, `says so when the half-written ios/ cannot be removed`) |
| 54 | Entitlements, ad-hoc signing | with an entitlements file passed (`entitlementsPath`), xtool 1.24.0 signs the packed app ad hoc at build ("Applying entitlements..."), and `App` and every `Frameworks/*` binary in `App.app` lose the exec bit until `install` signs them again (seen in F2 and F3) | user on the device: the app would not launch if installing did not restore them | accept: xtool's behaviour; Task H checks on the device that a bare app with an entitlements file installs and launches |
| 55 | Early checks, where packages are read | the pod index and the linked set read the top level of `node_modules` (and `node_modules/@scope/*`); npm nests a sibling under its dependent on a version conflict (`node_modules/<library>/node_modules/react-native-worklets`) | user at doctor and build start: the sibling's pod name (`RNWorklets`) is read as an unmapped CocoaPods pod, and the refusal's fix ("Add one under "pods"") is the wrong one | accept: rn-xtool reads the top level only; troubleshooting's "Libraries that depend on CocoaPods pods" says so in the present tense and gives the fix: `npm dedupe`, or add the package to package.json |

## Verification

- **Unit tests:** those of goal 6, each written red first. `npm test`, `npm run lint` and `npm run scan:private` are
  green and clean.
- **Downloads and disk need the owner's approval first.**
  - About 20 GB are free on the build disk. The React Native 0.88.1 artifacts are already cached.
  - The proof needs a fresh 0.88.1 template, an npm install of the four libraries and react-native-app-auth 8.5.1
    (tens of MB), and SwiftPM's fetch of AppAuth-iOS 3.0.0 (a few MB).
  - The first build's `.build` size is measured and reported, and `ios-xtool/.build` is deleted between runs.
- **Build-only proof (no device), on a fresh bare 0.88.1 template**, without any hand fix or saved patch:
  1. Install vision-camera 4.7.3, device-info 15.0.2, netinfo 11.5.2, video 6.19.3 and react-native-app-auth 8.5.1.
     `doctor --project` shows no refusal.
  2. `rn-xtool build` produces `App.app`. `llvm-nm` finds `CameraView`, `RCTVideo`, `RNDeviceInfo`, `RNCNetInfo`,
     `RNAppAuth` and `OIDAuthState`. vision-camera's warning names the frame-processor subspec. The ℹ resource line
     appears.
  3. Add a comment to one persisted scaffold, add react-native-linear-gradient, and build. Only linear-gradient is
     scaffolded, and the comment survives. This is fact 7's regression.
  4. `npm uninstall react-native-device-info`, then build: the orphan warning appears, and the build succeeds.
  5. Install @react-native-ml-kit/text-recognition 2.0.0: `doctor --project` and `build` refuse it, naming
     `GoogleMLKit`, before anything changes. No ML Kit download happens. Uninstall it.
  6. `exclude: ["@react-native-community/netinfo"]`, with a guarded import in `App.tsx`: the build succeeds, the ℹ
     line appears, and netinfo's classes are not in the binary (row 30).
  7. An entitlements file with wifi-info, aps-environment, one App Group and a shared keychain group, set as
     `CODE_SIGN_ENTITLEMENTS`: `doctor --project` prints the four lines, `xtool.yml` holds `entitlementsPath`, and
     the build log shows "Applying entitlements...".
- **Device checks for the owner** (free team, after the build-only proof):
  - video plays a remote MP4 with its controls;
  - the camera preview shows after the permission prompt;
  - device-info returns plausible values (model, system version, unique id; the name is the generic one);
  - netinfo reports the connection type and follows Wi-Fi on and off (the SSID is empty, as the entitlement line
    says);
  - the app installs with the entitlements file of step 7;
  - optional: the AppAuth login opens the system browser sheet and returns through the redirect, which needs a test
    OpenID provider and the redirect scheme in Info.plist.

  Until the owner confirms these, the docs call the libraries build-verified only.

## Open questions

1. **Missing sibling: drop the subspec, or only the dependency?** Proposed: the subspec that declares it, with its
   sources, headers and settings, because CocoaPods would not have defined it, and vision-camera needs it.
   Alternative: drop the dependency only, and let the user exclude the sources with a patch.
2. **How the codegen `-I` is anchored.** Proposed: `.unsafeFlags(["-I", Context.packageDirectory + "/<rel>"])`,
   like `rnSpmBridgingHeader`, if `Context.packageDirectory` is the `libs/<SwiftName>` symlink (as for
   `.package(path:)`). Fallback, with no per-library path: `buildPerAppHeaderTree` also exposes `X.h` at the root of
   `ReactAppHeaders`. The build-only proof decides.
3. **`exclude` and Expo modules.** Expo modules are linked by Expo's plugin, not by the config command. Proposed: a
   ⚠ line naming `expo.autolinking.exclude`, and no change to Expo's autolinking. Alternative: rn-xtool passes the
   list to Expo's autolinking too.
4. **The team kind for the entitlement lines.** rn-xtool does not know at build time whether the login is a free or
   a paid team, so the lines say "on a free team". Proposed: keep the conditional wording and do not read xtool's
   login state. Alternative: read it and print only what applies.
5. **xtool 1.24.0 or `main`.** The local source is `main` at 2af0b67, and the matrix notes cite checkout 952a7ff.
   Proposed: the builder reads `supportedTypes`, the free filter and `tooManyAppGroups` at the 1.24.0 tag (reading
   source only, no build) and records that in the table.
6. **A pin outside the podspec's requirement: warn or refuse?** Proposed: warn. The pin may be deliberate (an
   override), and SwiftPM or the compiler gives the real verdict.
7. **Swift compilation conditions (fix 24) in this block?** Proposed: yes. It is small and generic, and the owner's
   rule is "fix, don't file". It does not turn on vision-camera's location tagging (a Ruby ternary).
8. **Is an Expo build part of the proof?** The bridging-header passthrough is proven only on an Expo app with
   react-native-app-auth's config plugin. Proposed: yes, build-only on an SDK 58 template after the bare proof, if
   disk allows. Otherwise it ships with unit tests and is documented as build-unverified.
9. **Where the shipped pod table lives.** Proposed: in the vendored scaffolder, which is the upstream candidate and
   already holds fix 13's map, extended to the new shape. rn-xtool merges the config on top and passes the merged
   table through the environment. The early check reads the same export. Alternative: a JSON file in rn-xtool that
   the scaffolder reads, which keeps the table out of the 0.88 patches.

## Left to the builder

- Exact names: `--only`, the results file, the environment variable, and the marker line.
- Whether Expo SDK 58's scaffold goes through the driver's `--scaffold` or through the patched `setup-apple-spm.js`.
- How the project's patches are applied without the orphans: a staged copy of `patches/` or an explicit list.
- The wording of the phrase table and of the docs sections.
- Fixture layout for the podspec shapes.
