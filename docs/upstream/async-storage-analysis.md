# async-storage v3.1.1 under SwiftPM: analysis (Expo SDK 58 / RN 0.88)

Versions analysed: async-storage 3.1.1, expo-sqlite 58.0.13, expo-application 58.1.2, plus the latest react-native-screens, react-native-gesture-handler and react-native-safe-area-context (Expo SDK 58, RN 0.88).

## Q1. What makes it "mixed"; what is the xcframework
Podspec: `source_files = apple/**/*.{h,m,mm,cpp,swift}`, `swift_version 5.9.2`, `ios/osx.vendored_frameworks = apple-frameworks/SharedAsyncStorage.xcframework`, `resource_bundles AsyncStorage_resources => apple/PrivacyInfo.xcprivacy`, `install_modules_dependencies`.

| Lang | Files |
|---|---|
| ObjC++ | apple/AsyncStorage.mm (209 lines, the RN module `RNAsyncStorage`, RCT_EXPORT_METHOD x N) + AsyncStorage.h; apple/legacy_storage/RNCAsyncStorage.mm (822 lines, the old pure-ObjC file-based storage, CommonCrypto, used for migration) + .h |
| Swift | apple/storage/RNStorage.swift (125 l, `@objc public class RNStorage`, imports React + SharedAsyncStorage), apple/storage/StorageRegistry.swift (53 l) |

Both Swift files are wrapped in `#if !os(visionOS)`.
ObjC part is a thin RN bridge: `AsyncStorage.mm` only forwards each export to `[StorageRegistry.shared getRNStorageWithDbName:]` -> `RNStorage` (Swift) -> `SharedStorage` (xcframework). `RNCAsyncStorage.mm` is NOT thin (legacy storage, 800 lines, still compiled).
Coupling is ONE-WAY ObjC -> Swift: AsyncStorage.mm does `#import "AsyncStorage-Swift.h"` (or `<AsyncStorage/AsyncStorage-Swift.h>`). The Swift files import only `React` and `SharedAsyncStorage`, never an ObjC header of this lib.

Vendored xcframework: `apple-frameworks/SharedAsyncStorage.xcframework` = the Kotlin-Multiplatform "shared" storage core (Room/SQLite, the `next` storage v3 engine), Swift-facing API (`SharedStorage`, `Entry`). Slices: `ios-arm64`, `ios-arm64_x86_64-simulator`, `macos-arm64_x86_64`. Binary at ios-arm64 is `current ar archive` => STATIC framework (headers: SharedAsyncStorage.h, SharedAsyncStorage-Swift.h, Modules/). It is not optional: v3's only Swift code depends on it.

## Q2. The gate and what a generic emission needs
Gates (both fail closed, same predicate):
- `scaffold-package-swift.js:1198-1220` in `scaffoldPackageSwiftForDep`: `hasSwift = spec.sources.some(/\.swift$/)`, `hasClang = /\.(mm?|c|cc|cpp|cxx)$/`; both => remove stale scaffolded Package.swift, return `status: 'skipped-mixed-language'`.
- `generate-spm-autolinking.js:490` `hasMixedLanguageSources()` (filesystem walk) used at :1579 (`mixed: true` in missingManifests, error text at :565) and :1598 (spm.module wrapper path throws). Its comment states the rationale: bidirectional ObjC<->Swift can't be split (circular dep).

Generic two-target emission (what SwiftPM requires):
- A SwiftPM target is single-language. Emit `.target(name: "<Name>ObjC", path: <objc dir>, publicHeadersPath: "include")` (Clang) and `.target(name: "<Name>", dependencies: ["<Name>ObjC", React products...], path: <swift dir>)` (Swift) and ONE `.library(name: "<Name>", targets: [both])`. Sources must be physically separated by directory (SwiftPM `path:` + `sources:`/`exclude:`), so for a flat dir the scaffolder must use per-file `sources:` lists; public headers need an `include/` dir (existing shim logic can be reused per target).
- Direction matters. Supported: Swift -> Clang (Swift imports the Clang module; this is the pattern Expo uses: expo-constants Package.swift, expo-application spm.config.json: `ExpoApplication_ios_objc` (objc) <- `ExpoApplication` (swift)). NOT supported: Clang -> Swift. SwiftPM does not expose a Swift target's generated `<Module>-Swift.h` to a Clang target in the same package (no supported way; only hacks via `-emit-objc-header` unsafeFlags + `-I` on DerivedSources, fragile and unavailable to Xcode-built packages consistently).
- async-storage is Clang -> Swift (`AsyncStorage.mm` imports `AsyncStorage-Swift.h`, uses `RNStorage`/`StorageRegistry`). So a generic two-target emission does NOT unblock it. It would need a library patch: move the `RCT_EXPORT_MODULE` bridge into Swift (or a Swift `@objc` module + tiny ObjC++ that uses only `id`/runtime lookups via `NSClassFromString`), which is a fork, not scaffolding.
- Detectable generically: ObjC sources that `#import "*-Swift.h"` => direction Clang->Swift => keep skipping (clear message); otherwise split.

## Which libs a generic mixed emission (Swift -> Clang only) would unblock
Heuristic scan (podspec + >=1 Swift + >=1 .m/.mm/.c/.cpp, excl. android/example/tests) over a fresh install of the packages above, the reference app, and several other Expo apps' node_modules:
- Expo SDK 58 modules: expo, expo-constants, expo-application, expo-file-system, expo-modules-core, expo-modules-jsi, expo-sqlite (counts only because vendored C), @expo/log-box. These are NOT scaffolder cases in SDK 58: they ship Package.swift (expo, expo-constants, log-box) or `spm.config.json` consumed by Expo's own SPM autolinking plugin, with exactly this objc+swift split. So no gain for them.
- Non-Expo, in older installs: react-native-screens (older versions with 11 Swift files; latest has NO swift and no Package.swift, scaffoldable), react-native-compressor (20 swift + 1 oc), @stripe/stripe-react-native (44 swift + 27 oc; likely bidirectional, not verified), expo-dev-launcher/dev-menu/updates (Expo, own plugin).
- react-native-gesture-handler and react-native-safe-area-context latest ship their own Package.swift (self-managed).
Net: a generic mixed emitter would unblock essentially nothing in the current app set (async-storage is the wrong direction); at most react-native-compressor (unverified direction) and stripe (unverified).

## Q3. Vendored xcframework
- SwiftPM: `.binaryTarget(name: "SharedAsyncStorage", path: "apple-frameworks/SharedAsyncStorage.xcframework")` works for local xcframeworks, listed as a dependency of the Swift target. It has an `ios-arm64` device slice (also simulator and macOS), so device-only builds are fine.
- Embedding: not needed here. The binary is a static archive (`ar`), so it links into the app; no embed step. RN's flavored-frameworks (`flavored-frameworks.js`) is a different mechanism: it only handles DYNAMIC .framework XCFrameworks (`assertDynamicFramework`, line ~341, otool check), keyed by id with Debug/Release pairs: three BUILTIN_FRAMEWORKS (react, react-native-dependencies, hermes) plus entries a plugin writes to `build/generated/autolinking/.spm-plugin-flavored-frameworks.json` (generate-spm-autolinking.js:1859-1886; embed phase script in generate-spm-xcodeproj.js:451, :1407). The scaffolder has NO notion of per-library vendored frameworks (read-podspec ignores `vendored_frameworks`). A library-provided dynamic framework would have to come via that plugin manifest or be staged by expo-xtool into Frameworks/; a static one just needs the binaryTarget.

## Q4. Alternatives
- expo-sqlite 58.0.13 ships `expo-sqlite/kv-store` (kv-store.js re-exports build/Storage): `SQLiteStorage` class with AsyncStorage-compatible API (getItem/setItem/removeItem/getAllKeys/multiGet/... in the "react-native-async-storage compatible API" region), default export documented in its d.ts as "drop-in replacement for AsyncStorage"; its bundled SKILL.md has an "AsyncStorage-compatible storage" section and warns it does not migrate existing data. (I did not find docs.expo.dev text; verified from package contents only, so "Expo recommends it" is partly inferred.) Fresh apps: no migration issue.
- SPM-readiness of expo-sqlite: source, not a prebuilt xcframework. `spm.config.json` defines two targets: `ExpoSQLite_c` (cpp, vendor/sqlite3/**/*.{c,cpp}, SQLITE_ENABLE_* flags) and `ExpoSQLite` (swift, ios/**/*.swift minus Benchmarks, depends on ExpoSQLite_c + ExpoModulesCore). ios/ itself is pure Swift (17 files incl. Tests/Benchmarks); the C is vendored outside ios/. It is handled by Expo's SPM plugin, same as expo-constants-style modules. Caveats: iOS 16.4 platform floor; podspec-only options (SQLCipher, sqlite-vec xcframework) are not in the spm.config (default build only).
- expo-application 58.1.2: spm.config.json = objc target `ExpoApplication_ios_objc` (ios/ExpoApplication/EXProvisioningProfile.{h,m}) + swift target `ExpoApplication` (ApplicationModule.swift, ApplicationExceptions.swift). The single .m is `EXProvisioningProfile`: reads `embedded.mobileprovision` from the main bundle, parses the plist from the CMS blob, exposes `appReleaseType` (simulator/enterprise/dev/adhoc/appstore), `notificationServiceEnvironment`, `expirationDate`. Could be Swift (string search for `<?xml`...`</plist>` + PropertyListSerialization; no ObjC-only API). Upstream-PR candidate but low value since Expo already supports the split.

## Recommendation
Do NOT build generic mixed-target support for async-storage: its coupling is ObjC -> Swift (wrong direction for SwiftPM), Expo already ships split manifests for its own mixed modules, and the scan shows ~no other community lib it would unblock.

Current status:
1. `expo-sqlite/kv-store` is refused for now: expo-sqlite has vendored sources (the sqlite C target), which are not accepted in this setup.
2. Interim: pin `@react-native-async-storage/async-storage@2.x` (pure ObjC; scaffoldable by the patched scaffolder).
Optional small scaffolder improvement: change the skip message to detect `*-Swift.h` imports and say "ObjC->Swift coupling: unsupported; pin async-storage 2.x".

## Effort
- Generic Swift->Clang split emitter (per-file source partition, two targets, include shims, one product, tests): ~2-3 days, benefit currently ~0 libs.
- Plus `.binaryTarget` for static vendored xcframeworks from `vendored_frameworks` (platform-scoped parsing needed): +0.5-1 day.
- Making async-storage v3 itself build: needs a library fork (move bridge to Swift) or unsafeFlags hack; not recommended (>1 week with maintenance cost).
- kv-store swap in the app: not pursued (expo-sqlite refused, see Recommendation).

## Unblock list (generic mixed emission)
Realistically none of the current libs. Candidates only: react-native-compressor (Swift+1 oc, direction unverified), @stripe/stripe-react-native (probably bidirectional). async-storage v3: NOT unblocked (ObjC->Swift).
