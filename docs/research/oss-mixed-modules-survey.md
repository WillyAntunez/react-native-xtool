# OSS survey: mixed Swift + Objective-C modules for rn-xtool

Date: 2026-10-23. Toolchain: Swift 6.4.1 (swiftly), xtool 1.23.0 (+3 commits, local clone at `952a7ff`),
Darwin SDK iPhoneOS 27.1 at `~/.swiftpm/swift-sdks/darwin.artifactbundle`.
Scratch (clones + experiments): `<path>`
(`exp/` holds every experiment package and `exp/run.sh`).

Terms: **A** = Swift depends on ObjC (expo-application, dev-launcher/menu, updates). **B** = ObjC depends on Swift
(async-storage: `AsyncStorage.mm` imports `AsyncStorage-Swift.h`). **C** = vendored xcframeworks.

## TL;DR

1. **SwiftPM 6.4.1, which is already installed, can build a single mixed Swift + ObjC target.** You opt in with a
   tools-version suffix, `// swift-tools-version: 6.4;(experimentalMultiLang)`, and it only works with
   `--build-system swiftbuild`, which xtool 1.23 uses by default on Swift >= 6.4. The 6.4.x code does not wire the
   two language halves together, so two flags are needed: `-import-objc-header <umbrella>` (Swift sees the module's
   own ObjC) and `-I <GeneratedModuleMaps dir>` (ObjC finds `<Module>-Swift.h`). With them, a bidirectional (A+B)
   single target built and linked for `arm64-apple-ios16.4`.
2. **SE-0541 "Flexible Swift/C Interoperability for Packages" is Implemented (Swift Next).** It is on SwiftPM `main`
   with tools-version **6.5**: mixed targets, `publicHeadersPath` as the underlying Clang module,
   `.bridgingHeader(...)`, and `$(GENERATED_MODULEMAP_DIR)` added to the header search path. It is NOT in
   `release/6.4.x` or `release/6.4.2`. On `main` the `experimentalMultiLang` flag is **removed**, so a
   `6.4;(experimentalMultiLang)` manifest will fail on 6.5. Use version-specific manifests
   (`Package.swift` + `Package@swift-6.5.swift`).
3. **Direction B already works with two plain targets under swiftbuild.** SwiftPM's PIF builder gives *every* Swift
   target a `<Target>-Swift.h` plus a module map, and passes `-fmodule-map-file` on to the Clang targets that depend
   on it. `@import Mini;` from a `.m` file builds with no flags. `#import "Mini-Swift.h"` needs a header search path
   (an env-driven `-I`, or a forwarding shim plus `-fcxx-modules`). The claim in `async-storage-analysis.md` that
   "Clang -> Swift is not supported" does not hold for the swiftbuild backend.
4. The Swift Build engine supports mixed targets natively (Xcode semantics), and its `swbuild` CLI accepts a
   hand-written `.json`/`.pif` PIF. But `swbuild` is **not shipped** in the toolchain (Swift Build is linked into
   `swift-package`), and `.xcodeproj` input shells out to `/usr/bin/xcrun xcodebuild -dumpPIF`.

## Experiment results

Common driver `exp/run.sh <pkg> [args]`. It mirrors `scripts/build-expo-modules-jsi.sh` and xtool's
`PackLib/BuildSettings.swift`:

```sh
SDK=$HOME/.swiftpm/swift-sdks/darwin.artifactbundle
export PATH=$HOME/.local/share/swiftly/bin:$SDK/toolset/bin:$PATH
export XCODE_EXTRA_PLATFORM_FOLDERS=$SDK/Developer/Platforms
unset SDKROOT
swift build --configuration debug --build-system swiftbuild --triple arm64-apple-ios16.4 \
  --toolset $SDK/toolset-swb.json --package-path "$PKG" --scratch-path "$PKG/.build" "$@"
```

Verification: `llvm-nm` (toolchain `usr/bin/llvm-nm`) on the products in `.build/out/Products/Debug-iphoneos/`.

| # | Package (in `exp/`) | Shape | Result |
|---|---|---|---|
| A | `A` | Clang `MiniObjC` (include/MiniGreeter.h, .m) <- Swift `Mini` (`import MiniObjC`), `.dynamic` product | **Works.** 3.7 s. Without `-Xlinker -all_load` the dylib is empty (known `ld64.lld -r` -> `llvm-lib` trampoline). With it, `libMini.dylib` exports `_OBJC_CLASS_$_MiniGreeter` and `_OBJC_CLASS_$__TtC4Mini9MiniSwift`. |
| A2 | `A2` | Same, but the Swift source has **no** `import MiniObjC` (like a CocoaPods pod's implicit umbrella); `swiftSettings: .unsafeFlags(["-Xfrontend","-import-module","-Xfrontend","MiniObjC"])` | **Works.** An implicit import with no source change. |
| B | `B` | Swift `Mini` <- ObjC++ `MiniBridge` (`#import "Mini-Swift.h"`) | **Fails:** `'Mini-Swift.h' file not found`. The clang response file has `-fmodule-map-file=.../GeneratedModuleMaps-iphoneos/Mini.modulemap`, but that directory is not on `-I`. |
| B2 | `B2` | B + `cSettings/cxxSettings: .unsafeFlags(["-I<abs>/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos"])` | **Compiles and links** (dylib has both classes). The `.dynamic` product then fails at `GenerateTAPI ... unable to spawn process 'tapi'` (Swift Build eager-linking TBD step; there is no `tapi` on Linux). Not hit with a static/automatic product. `.unsafeFlags(["-I$(GENERATED_MODULEMAP_DIR)"])` is rejected by the manifest: "contains invalid component(s)". |
| B3 | `B3` | Two targets, pure ObjC `.m` with `@import Mini;` (no flags) | **Works.** |
| B5 | `B5` | B with `cxxSettings: .unsafeFlags(["-I" + (Context.environment["MINI_SWIFT_HEADERS"] ?? "/nonexistent")])`, env set at build time | **Works.** Portable: no absolute path in the committed manifest. |
| T3 | `T3` | rules_swift-style 3 targets: `MiniCore` (headers only + stub.c) <- Swift `Mini` <- ObjC++ `MiniImpl` (implements `MiniGreeter`, calls Swift). Forwarding shim `shim/Mini-Swift.h` = `@import Mini;`, `cxxSettings: [.headerSearchPath("shim"), .unsafeFlags(["-fcxx-modules"])]` | **Works, bidirectional.** `MiniImpl.o` defines `MiniGreeter` and references `_TtC4Mini9MiniSwift`. Without `-fcxx-modules` (T4, `#pragma clang module import`) it fails: "module 'Mini' is needed". |
| M | `M` | **One target**, `// swift-tools-version: 6.4;(experimentalMultiLang)`: MiniGreeter.h/.m + Mini.swift (uses MiniGreeter) + MiniBridge.m (`#import "Mini-Swift.h"`, calls Swift) | Bare: **fails** (`MiniGreeter.h` not found in .m; `Mini-Swift.h` not found). With `cSettings: [.headerSearchPath("include"), .unsafeFlags(["-I<GeneratedModuleMaps>"])]` and `swiftSettings: .unsafeFlags(["-import-objc-header", "<abs>/include/MiniGreeter.h"])`: **works**, 2.7 s. Clean-rebuilt 3 times, same result each time. `Mini.o` has `MiniBridgeHello`, `MiniGreeter`, `_TtC4Mini9MiniSwift`. |
| manual | `manual/` | (ii) two-phase swiftc then clang | **Works** (commands below). |

Manual two-phase (direction B):

```sh
T=~/.local/share/swiftly/toolchains/6.4.1/usr/bin
S=~/.swiftpm/swift-sdks/darwin.artifactbundle
SDK=$S/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.1.sdk
RES=$S/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift
# 1) Swift: objects + module + ObjC header (-emit-library -static fails: driver wants `libtool`)
$T/swiftc -target arm64-apple-ios16.4 -sdk $SDK -resource-dir $RES -module-name Mini -parse-as-library -wmo \
  -emit-objc-header-path gen/Mini-Swift.h -emit-module-path gen/Mini.swiftmodule -c -o Mini.swift.o Storage.swift
# 2) ObjC++ against it
$T/clang -target arm64-apple-ios16.4 -isysroot $SDK -fobjc-arc -fmodules -fcxx-modules -Igen -Iinclude -c MiniBridge.mm -o MiniBridge.o
# 3) archive + link (lld warns "does not support linking for platform iOS"; harmless here)
$T/llvm-ar rcs libMini.a Mini.swift.o MiniBridge.o
$S/toolset/bin/orig/ld64.lld -arch arm64 -platform_version ios 16.4 27.1 -dylib -syslibroot $SDK \
  -L$RES/iphoneos -L$SDK/usr/lib/swift -all_load libMini.a -framework Foundation -lobjc -lc++ -lSystem -o libMini.dylib
```

The first link failed on `___gxx_personality_v0` until `-lc++` was added. The clang Swift Build uses is the host
toolchain's `usr/bin/clang` with `-isysroot <iPhoneOS27.1.sdk>` and `-resource-dir` pointing to the SDK's
`XcodeDefault.xctoolchain/usr/lib/swift/clang` (seen in the response files).

Not done (needs your OK first: heavy): building `swbuild` from swift-build source, and installing a `main-snapshot`
toolchain (`swiftly list-available main-snapshot` lists `main-snapshot-2026-10-17`) to test SE-0541 for real.

## Per project

### 1. Swift Build (swiftlang/swift-build), Apache-2.0
- **What:** the Xcode build engine, open source; used by SwiftPM's `swiftbuild` backend. It has full Xcode
  mixed-target machinery: `SWIFT_OBJC_INTERFACE_HEADER_NAME` (default `$(SWIFT_MODULE_NAME)-Swift.h`),
  `SWIFT_INSTALL_OBJC_HEADER`, the underlying module and the bridging header. The installed spec is
  `~/.local/share/swiftly/toolchains/6.4.1/usr/share/pm/SwiftBuild_SWBUniversalPlatform.bundle/Swift.xcspec:263-282`.
- **PIF docs:** `SwiftBuild.docc/Core/project-interchange-format.md` (JSON list of `workspace`/`project`/`target`
  objects keyed by signature, incremental exchange protocol).
- **`swbuild`:** a product in the repo (`Package.swift:83`, `Sources/swbuild/SWBuildMain.swift` -> `SwiftBuild.main()`).
  It has the console commands `build [--target|--allTargets] [--configuration] [--derivedDataPath] [--buildParametersFile] [--buildRequestFile] <container>`
  (`Sources/SwiftBuild/ConsoleCommands/SWBServiceConsoleBuildCommand.swift`). Container loading is in
  `Sources/SWBBuildService/Messages.swift:242-272`: `.json`/`.pif` is read directly; `.xcodeproj`/`.xcworkspace`
  runs `/usr/bin/xcrun xcodebuild -dumpPIF` (macOS only).
- **Installed toolchain:** `ls usr/bin | grep -i build` gives `swift-build`, `swift-build-sdk-interfaces`, and
  `swift-build-tool` only. No `swbuild` and no `libSwiftBuild*.so`: `swift-build -> swift-package` embeds the engine,
  plus resource bundles in `usr/share/pm/SwiftBuild_*.bundle`. `swift build --help` shows the default is
  `swiftbuild` (`native` is deprecated). `swift package dump-pif` (hidden) works: on package A it printed a
  10-object PIF (`exp/A.pif.json`).
- **Hand-written PIF:** feasible in principle: `swift package dump-pif` -> edit -> `swbuild build x.pif --target ...`.
  I did not run it because `swbuild` would have to be built from source. No public example of feeding a hand-written
  PIF to `swbuild` on Linux was found.
- **Xcodebuild-replacement ambitions:** the README only claims SwiftPM, Xcode and Playgrounds as clients. The
  ecosystem is filling the gap instead (below: viraptor/xcbuild `-dumpPIF`, xtool xcodeproj support, Apple's
  `apple/xcode-project-format`, Apache-2.0).
- **SE-0541 engine pieces:** swift-build #1537 (extend explicit modulemap with the generated header), #1546
  (bridging header settings in the PIF API), swift #90774 (quoted includes in generated headers). All merged in
  July 2026.
- **Reusability:** direct dependency today *through SwiftPM*. Driving `swbuild` directly is a borrow-technique /
  rabbit-hole option.

### 1b. SwiftPM (swiftlang/swift-package-manager), Apache-2.0: the decisive finding
- **6.4.1** (`swift-6.4.1-RELEASE`): `ToolsVersion.ExperimentalFeature.experimentalMultiLang` (requires >= 6.4),
  parsed from `// swift-tools-version: 6.4;(experimentalMultiLang)` (`ToolsVersionParser.swift:361`). PR #9894
  ("Move the check for multi-lang to Native build system", merged 2026-04-09) leaves the error only in the native
  backend. A mixed target becomes a `SwiftModule` with all sources. The swiftbuild PIF gives it
  `SWIFT_OBJC_INTERFACE_HEADER_DIR=$(GENERATED_MODULEMAP_DIR)` and a module map `module X { header "X-Swift.h" }`,
  and passes `-fmodule-map-file` on to C clients (`PackagePIFProjectBuilder+Modules.swift:407-421` at the 6.4.1 tag).
  Missing: `-I` to that directory, and any way for Swift to see the target's own C headers.
- **main** (`80c1fcb`, 2026-10-23): PR #10292 "SE-0541: Implementation" (merged 2026-09-01) plus docs
  `Sources/PackageManagerDocs/Documentation.docc/CreatingMixedLanguageTargets.md`. The gate is
  `toolsVersion < .v6_5` (`TargetSourcesBuilder.swift:224`). `experimentalMultiLang` is gone from `ToolsVersion.swift`,
  and the parser ignores unknown features silently. `publicHeadersPath` becomes the underlying module
  (`-import-underlying-module`, `SWIFT_EXTEND_MODULEMAP_FILE_CONTENTS`), `swiftSettings: .bridgingHeader(path, visibility: .internal)`,
  and `HEADER_SEARCH_PATHS += $(GENERATED_MODULEMAP_DIR)` for mixed modules (`PackagePIFProjectBuilder+Modules.swift:258-330, 704-708`).
- **SE-0403** (2023, Nick Cooke) is "Returned for Revision"; SE-0541 (Owen Voorhees) superseded it:
  https://github.com/swiftlang/swift-evolution/blob/main/proposals/0541-flexible-swift-c-interoperability-for-packages.md
- **unsafeFlags policy:** `fileSystem` (path) dependencies and root packages may use them
  (`Workspace+Manifests.swift:146-172`). RN/Expo autolinked packages are path deps, so this is OK.
  `$(...)` macros inside `unsafeFlags` are rejected.
- **`cxxInteroperabilityMode` / `interoperabilityMode`:** about Swift<->C++ import, not `-Swift.h` generation, so it
  is no escape hatch for this. SE-0541 reuses it to interpret bridging headers.

### 2. xtool (xtool-org/xtool), MIT
- `Sources/PackLib/BuildSettings.swift`: `BuildSystem.default()` = `.swiftBuild` when Swift >= 6.4
  (`SwiftVersion.supportsSwiftBuild`). It passes `--triple`, `--toolset <sdk>/toolset-swb.json`, the env
  `XCODE_EXTRA_PLATFORM_FOLDERS`, `PATH=<sdk>/toolset/bin:...`, and `SDKROOT=nil`. Env is **inherited**
  (`.inherit.updating(sdkEnvironment)`), so rn-xtool can pass variables such as the generated-header directory.
  `DevCommand.swift:57` builds `BuildSettings(..., options: [])`: there is **no CLI hook** for extra `swift build`
  flags or extra targets. Injection has to go through the root `Package.swift` (which rn-xtool already generates)
  and the libraries' manifests.
- `Packer.swift`: writes `xtool/.xtool-tmp/Package.swift` (tools 6.0, `.executableTarget` per product depending on
  `RootPackage` by path) and builds with `--scratch-path .build`. In the reference app the generated headers land in
  `ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos`.
- **Doc nit in our `docs/recipe.md` section 1:** it says xtool uses `--build-system native` on cross hosts. The 1.23
  code uses `swiftbuild` (with the env/toolset workarounds). Worth correcting, because mixed targets only work on
  swiftbuild.
- **Issues/PRs:** #364 (open, 2026-10-17) "Explore feasibility for building Expo / React Native iOS apps on Linux"
  has no comments. #146: the maintainer says "Objective-C is fully supported... create a SwiftPM target with
  .m/.mm". #144 "Ability to build Xcode Projects": the maintainer said on 2026-09-10 that it is planned via
  SwiftBuild/PIF, and on 2026-10-11 that he has an "MVP implementation". **PR #388 (2026-10-23, today)**
  "xcode: track paths on XcodeProject... used in future PRs to build various Xcode projects". #229 (merged
  2026-09-20) adds SwiftBuild support. #292 (open) links embedded dynamic libraries into the app (relevant to C).
  #369 (open) adds `prepare` commands and links `libclang_rt.ios.a`, needed by **Kotlin/Native xcframeworks**
  (`___isPlatformVersionAtLeast`). async-storage's `SharedAsyncStorage.xcframework` is KMP, so expect this.
  Nothing on `-Swift.h`, mixed targets, or CocoaPods specifically.
- **Reusability:** direct dependency (already). Watch #144/#388: xcodeproj->PIF in xtool would make Path 3 below
  realistic.

### 3. Bazel rules_swift / rules_apple, Apache-2.0
- `rules_swift` 4.2.x ships `mixed_language/mixed_language_library.bzl` (the docstring says it will be deprecated once
  `swift_library` supports mixed). It is a **three-target split**: (1) `objc_library <name>_headers` (public
  headers + umbrella + module map, via `swift_interop_hint`), (2) `swift_library <name>_swift` with
  `-import-underlying-module`, `generates_header = True`, `generated_header_name = <Module>-Swift.h`, depending
  on the headers lib, (3) `objc_library <name>_clang` with the `.m/.mm` sources and
  `implementation_deps = [<name>_swift]`. Separating declarations from implementations breaks the A<->B cycle.
- It is reproducible with plain invocations or SwiftPM: experiment T3 is exactly this pattern in SwiftPM, and it
  works.
- **Linux host:** `apple-cross-toolchain/rules_applecross` (Apache-2.0, pushed 2026-10-23) is a Bazel Apple toolchain
  for x86_64/arm64 Linux built from an Xcode archive, with patched rules_apple/apple_support. Adopting Bazel for RN
  pods is far too heavy for us.
- **Reusability:** borrow technique (the 3-target split); reference only for Bazel itself.

### 4. theos (theos/theos), GPL-3.0 (makefiles; projects built with it are not derivative)
- `makefiles/instance/rules.mk:20-95`: when an instance has both Swift and ObjC files it emits
  `-emit-objc-header-path $(THEOS_OBJ_DIR)/generated/<Instance>-Swift.h`, adds `-I` to that directory for C/ObjC, and
  uses `-import-objc-header <Instance>-Bridging-Header.h` for Swift->ObjC. Swift is built first ("swift-support"
  stamp), then ObjC. That is the manual two-phase recipe, in make.
- SDKs: `theos/sdks` holds patched SDKs with private-framework TBDs (last pushed 2024-11). Our Xcode-extracted SDK is
  newer and complete, so nothing to take.
- **Reusability:** reference / technique only (GPL; we would not copy makefile code anyway). It confirms that
  "bridging header + -I to the generated header directory" is the standard non-Xcode recipe.

### 5. Other projects
| Project | License | Status | Relevance | Use |
|---|---|---|---|---|
| **Expo `scripts/spm/*.js`** (app `node_modules/expo/scripts/spm`) | MIT | SDK 58 | `spm.config.json` declares per-language targets (`objc`/`swift`/`cpp`), e.g. expo-modules-core: `ExpoModulesCore_common_cpp` -> `ExpoModulesCore_ios_objc` -> `ExpoModulesCore` (swift). `ExpoModulesWorklets_ios_objc` sets `moduleName: "ExpoModulesWorklets"` (same module name as the Swift target: an underlying-module trick in the prebuild pipeline). `diagnostics.js:217-223` tells mixed modules to add `spm.config.json` (prebuild "compiles mixed-language targets, so no source split is needed") or a split Package.swift (expo-constants: `EXConstants` + `EXConstantsObjC`). Expo broke ObjC->Swift cycles in core with protocols/forward declarations (`ios/Protocols/EXAppContextProtocol.h:17`). Expo PRs #47648/#47649/#49820/#49821/#47650 "Restructure for SwiftPM mixed-language split". Our Expo patch already uses `-import-objc-header umbrella.h` (`manifests.js:~901-912`). | Prior art for A (split by directory); technique for an implicit umbrella |
| **React Native 0.88 `scripts/spm`** (now `react/react-native`) | MIT | 0.88 | `scaffold-package-swift.js` returns `skipped-mixed-language`; `generate-spm-autolinking.js:483-570` says SwiftPM "cannot compile mixed-language sources in a single target" and suggests opting out or using an xcframework. No issue/PR mentions `experimentalMultiLang` or SE-0541 (searched). Active SwiftPM work (#59361, #59365, #59348, #58515), none on mixed targets. | Upstream target |
| **viraptor/xcbuild** (fork of archived facebookarchive/xcbuild) | BSD-style "other" | pushed 2026-07-12 | Adds an open-source `xcodebuild -dumpPIF` that "matches host xcodebuild's PIF signatures and object GUIDs" and splices SwiftPM PIF (`swift package dump-pif`). Cited by the xtool maintainer in #144. Upstream xcbuild (archived 2020) cannot build modern Swift. | Reference; possible piece of Path 3 |
| **kxbuild/kxbuild** | none (docs-only repo, closed binary) | created 2026-10-08 | Claims a drop-in `xcodebuild`/`xcrun`/`codesign` on Windows/Linux, building .xcodeproj/.xcworkspace including **mixed ObjC/Swift, CocoaPods, React Native, Expo** (`doc/en/objective-c.md`, `cocoapods.md`, `expo.md`). Unverified. | Reference only (not reusable) |
| **rodriguesabner/ios-anywhere** | MIT | experimental, 2026-10 | Expo on Linux the CocoaPods way: runs `pod install` on Linux, dumps `Pods.xcodeproj` with the `xcodeproj` gem (`export-project.rb`), then compiles directly: `compile-swift.py` (`-emit-objc-header-path <Module>-Swift.h`, `-import-objc-header` from `SWIFT_OBJC_BRIDGING_HEADER`, writes `module X.Swift` modulemaps), and `compile-pods.py` symlinks `*-Swift.h` into `headers/common`. | Prior art for a "manual driver"; borrow ideas only |
| **arxdeus/xcross** | AGPL-3.0 | active | Flutter/CMP on Linux/Windows; direct `clang`/`ld64.lld` pipeline; "plugins that only ship a CocoaPods podspec are skipped". RN support is only an idea (issue #21). | Reference |
| **joshuaswarren/omarchy-apple-dev** | none stated | active | SwiftUI/Flutter via xtool + open PRs; `tools/xcodeproj2xtool.py` adapter; ObjC plugins supported for Flutter. No RN, no mixed-module handling. | Reference |
| **Stephy020/skydrop** | none | 2026-10 | Expo/RN: builds on GitHub's free macOS runner with `xcodebuild`, then signs and installs on Linux with xtool. | Not relevant (uses a Mac) |
| **Darling** | GPL-3.0 | release v0.1.20260608 | Docs: CLI tools "known working", Xcode GUI non-functional. `xcodebuild` crashes or fails (issues #488 segfault, #1228 2025: `dyld: Library not loaded: Combine.framework`, #1414). | Not viable |
| **osxcross / cctools-port** | GPL-2.0 / APSL-ish (no SPDX) | active | Real `ld64` + `libtool` on Linux. Our pipeline uses `ld64.lld` (it warns "does not support linking for platform iOS") and an `ld -r` -> `llvm-lib` trampoline. cctools would remove the `-all_load` hack and give the swiftc driver a `libtool` for `-static`, but is unrelated to mixed modules. | Optional fallback for link quirks |
| **Tuist / XcodeGen / tuist/XcodeProj** | MIT | active | Only generate or parse projects; useless without an xcodebuild-equivalent. XcodeProj (Swift) could feed an xcodeproj->PIF converter. Apple's `apple/xcode-project-format` (Apache-2.0) models Xcode 27.2's JSON `project.xcproj`. | Reference (Path 3 inputs) |
| **xcbuild (facebookarchive)** | BSD | archived 2020 | Ran on Linux, but no modern Swift, no Swift Build parity. | Dead |

## Recommendation: implementation paths

Ranked. "Unblocks" uses A/B/C.

### Path 1 (recommended): single mixed target, version-specific manifests
Emit what CocoaPods does: one target holding all of the pod's Swift + ObjC sources.
- `Package.swift`: `// swift-tools-version: 6.4;(experimentalMultiLang)`, one `.target` with all sources, plus:
  - `swiftSettings: .unsafeFlags(["-import-objc-header", "<generated umbrella.h>"])`: an umbrella of the pod's
    public ObjC headers (the same technique `patches/expo+58.0.17.patch` already uses). This gives A.
  - `cSettings`/`cxxSettings: .unsafeFlags(["-I" + (Context.environment["RN_XTOOL_SWIFT_HEADERS"] ?? ...)])`, with
    rn-xtool exporting `<ios-xtool>/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos` before `xtool dev
    build` (xtool inherits env). This gives B. The committed patch holds no absolute path.
  - `.headerSearchPath` for the pod's own header directories (the scaffolder already computes them).
- `Package@swift-6.5.swift`: the clean SE-0541 form (tools 6.5, `publicHeadersPath`, `.bridgingHeader(..., visibility: .internal)`, no unsafe flags).
- **Unblocks:** A, B and bidirectional (async-storage's `AsyncStorage.mm` -> `AsyncStorage-Swift.h`, dev-launcher-style
  modules) with **no source partitioning**. C is separate (below).
- **Effort:** about 2-3 days in our RN scaffolder patch (drop the `skipped-mixed-language` gate, umbrella generation,
  env flag, second manifest), plus a doctor check (swiftbuild + Swift >= 6.4).
- **Risks:** experimental 6.4 feature (removed on main; covered by the `@swift-6.5` manifest, but it must be tested on
  a snapshot). It is only proven on a toy. A real lib may hit: an umbrella header that pulls C++ into Swift (needs
  `interoperabilityMode(.Cxx)` or a filtered umbrella); `#import <Lib/Lib-Swift.h>` spelling (needs a shim
  directory `Lib/Lib-Swift.h`); ordering in larger targets; the eager-linking `tapi` step if a product is
  `.dynamic` (B2). SwiftPM manifest caching with `Context.environment`. Next step: build async-storage 3.x this way
  inside the reference app.

### Path 2: rules_swift-style split (headers / Swift / impl), stable SwiftPM
- Emit `<Lib>Headers` (Clang, public headers + stub.c), `<Lib>` (Swift, implicit `-Xfrontend -import-module <Lib>Headers`, which
  makes the Swift module name equal the `-Swift.h` name), `<Lib>Impl` (Clang ObjC/ObjC++ sources, depends on both,
  forwarding shim `<Lib>-Swift.h` = `@import <Lib>;` + `-fcxx-modules`, or the env `-I` from Path 1). One `.library`
  with all three. Pure A (expo-application style) degenerates to two targets with no shim (experiment A2).
- **Unblocks:** A, B, bidirectional, on any Swift 6.x with swiftbuild, without experimental features.
- **Effort:** about 3-5 days. Partitioning sources per language, header vs implementation, private headers used by
  Swift, a stub file, and duplicate-symbol care all make it more complex.
- **Risks:** `-fcxx-modules` with React's C++ headers (untested). ObjC categories or private headers that Swift
  needs. More moving parts to persist in patches. Use it as the fallback if Path 1 fails on real libraries, or if the
  experimental flag misbehaves.

### Path 3 (watch, do not build now): Xcode-project semantics on Linux
- `pod install` on Linux (ios-anywhere shows it works) -> `Pods.xcodeproj`/workspace -> PIF (viraptor/xcbuild
  `-dumpPIF`, or xtool's upcoming xcodeproj->PIF: #144 MVP, #388) -> Swift Build. You get Xcode's real handling of
  mixed targets, vendored xcframeworks and script phases, which covers A, B and C at once.
- **Effort/risk:** large and dependent on upstream. Revisit when xtool ships xcodeproj builds.

Rejected: a hand-rolled swiftc/clang driver (manual experiment / theos / ios-anywhere style). It works, but it
re-implements a build system; keep it to one-offs like the existing ExpoModulesJSI script. Driving `swbuild` with
hand-written PIF: needs a source build of swift-build and a PIF generator, with no gain over Path 1.

### C (vendored xcframeworks), for any path
- Static (SharedAsyncStorage `ios-arm64` is an `ar` archive): `.binaryTarget(path:)` in the scaffolded package (the
  recipe notes that SwiftPM 6.3+ resolves local xcframeworks). For KMP frameworks also link
  `libclang_rt.ios.a` from the SDK, or wait for xtool #369.
- Dynamic (Sentry-Dynamic, etc.): stage them in `ios-xtool/Frameworks` plus `.linkedFramework`, as is already done
  for RN runtime frameworks (and xtool #292 upstream).
- The scaffolder must start reading `vendored_frameworks` (platform-scoped). About 0.5-1 day.

## What to upstream where
- **react/react-native** (scaffolder): replace `skipped-mixed-language` with a mixed single-target emission using
  tools 6.5 / SE-0541 (and the 6.4 experimental form behind a flag). Update the error text in
  `generate-spm-autolinking.js:565` ("SwiftPM cannot compile mixed...") now that SE-0541 is accepted. Add
  `vendored_frameworks` -> `.binaryTarget`.
- **swiftlang/swift-package-manager:** ask for a 6.4.x cherry-pick of the small part of #10292 that adds
  `HEADER_SEARCH_PATHS += $(GENERATED_MODULEMAP_DIR)` and the underlying module for `experimentalMultiLang`
  targets (low odds, small diff). Report that `experimentalMultiLang` is silently ignored on main (unknown features
  are dropped without a diagnostic).
- **swiftlang/swift-build:** eager linking schedules `tapi stubify` for a `.dynamic` product on Linux, where no
  `tapi` exists (B2). Ask it to gate on tool availability.
- **xtool-org/xtool:** a passthrough for extra `swift build` options/env from `xtool.yml`; and comment on #364 with
  this RN/Expo status.
- **expo/expo:** its diagnostics could point to SE-0541 single targets as an alternative to source splits.
- **Our docs:** fix `docs/recipe.md` section 1 (xtool uses swiftbuild, not native). Correct
  `.superpowers/async-storage-analysis.md` (B is achievable).

## Open risks (no test covers these yet)
1. Behaviour on real RN libs (C++ headers in the umbrella, `<Lib/Lib-Swift.h>` spelling, `RCT_EXPORT_MODULE` load
   order in a mixed target): only toy modules were proven.
2. A Swift toolchain upgrade to 6.5 silently changes which manifest is used (`Package@swift-6.5.swift`), so
   persisted patches need both variants tested.
3. `Context.environment` in a persisted manifest: if rn-xtool forgets the variable (or SwiftPM caches a stale
   manifest), ObjC fails with "-Swift.h not found" far from the cause. `doctor` or the build step should assert it.
