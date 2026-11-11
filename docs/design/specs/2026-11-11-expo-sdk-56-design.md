# Expo SDK 56 (design)

Status: short design, 2026-11-11, approved by the owner on 2026-11-11. The evidence is a throwaway spike of 2026-11-10 (a
fresh `default@sdk-56` template built through `xtool-build` with four local hacks, nothing committed) and a reading of
the code at 2856d0b. The spike's notes stay outside the repo; the facts this design rests on are restated here with
their sources.

## Intent

The owner has an app on Expo SDK 56 (expo 56.x, React Native 0.85.3). rn-xtool refuses it today: `Expo SDK 56 is not
supported; rn-xtool supports SDK 57 (expo 57.0.31 or newer 57.x) and SDK 58 or newer.` Moving that app to SDK 57 or 58
is an Expo upgrade of the whole app, JS and Android included, not an iOS build change.

To rn-xtool, SDK 56 looks like SDK 57 plus four gaps. It ships no SwiftPM plugin, an autolinking CLI without the
commands the plugin calls, a macOS-only macro plugin and no `ExpoModulesJSIHeaders.xcframework`, exactly as SDK 57
does. It also ships its modules precompiled inside the npm packages, as SDK 57 does. The spike built it on SDK 57's
path (the vendored Expo 58.0.19 plugin, the vendored React Native scripts, adapted artifacts, the `jsi` step before
`rn-spm`) once four gaps were closed by hand. This block adds SDK 56 as one `SUPPORTED_LINES` row, closes the four
gaps with mechanisms that hold for any version, and proves it on a device.

## Facts

1. **The installed set.** A fresh `create-expo-app --template default@sdk-56` plus `npx expo install expo-dev-client`
   installed (spike, 2026-11-10): expo 56.0.24, react-native 0.85.3, expo-modules-core 56.0.27,
   expo-modules-autolinking 56.0.24, expo-modules-jsi 56.0.14 (one copy), expo-file-system 56.0.11, expo-font 56.0.7,
   expo-image 56.0.13, expo-router 56.2.22, react-native-reanimated 4.3.1, react-native-worklets 0.8.3,
   react-native-screens 4.26.2. `expo` 56.0.24 lists expo-file-system `~56.0.11`, expo-font `~56.0.7`,
   expo-modules-core `~56.0.27` and expo-modules-autolinking `~56.0.24` as dependencies; npm placed file-system and
   font at the top level, not under `expo/node_modules` as on SDK 57. expo-modules-core 56.0.27 depends on
   `@expo/expo-modules-macros-plugin` 0.2.2 (a Mach-O binary) and expo-modules-jsi `~56.0.14`.
2. **What SDK 56 lacks is what SDK 57 lacks.** No `expo/scripts/spm`; the autolinking CLI lists the same commands as
   57 (no `prebuilt-metadata`); no Linux macro binary (the vendored plugin's P1 fallback to rn-xtool's
   expo-modules-macros 0.22.0 worked); no `prebuilds/` in expo-modules-jsi.
3. **The precompiled modules ship in npm.** `<pkg>/prebuilds/output/{debug,release}/xcframeworks/<Product>.tar.gz` for
   ExpoModulesCore and ExpoModulesWorklets (core), ExpoFileSystem, ExpoFont and ExpoImage. ExpoImage also ships
   `prebuilds/spm-deps/{SDWebImage,SDWebImageAVIFCoder,SDWebImageSVGCoder,SDWebImageWebPCoder,libavif}/{debug,release}`.
   The tarballs carry AppleDouble entries and xattr pax headers, which the vendored plugin's P5 strips. Their debug
   dSYMs reference React Native 0.85.3's React.xcframework and Hermes 250829098.0.10, the version react-native
   0.85.3's own `hermes-compiler` gives. The vendored plugin picked all five up unchanged. No network is needed: the
   remote route in `expo-modules-autolinking/scripts/ios/precompiled_modules.rb` is CocoaPods-only and opt-in.
4. **Blocker 1, the Swift 6.4 access-level error.** `JavaScriptError.swift:84: cannot use struct 'CppError' in an
   extension with public or '@usableFromInline' members`. It is the bug `patches/expo-modules-jsi+57.1.3.patch` fixes
   on 57; the same one-line change applies to 56.0.14 at line 85 (hunk `@@ -82,7 +82,7 @@`). `selectBundledPatches`
   with `lineOnly` (`src/pipeline/patches.ts:123-146`, used for the vendored plugin at `:790`) already refuses 57's
   patch for a 56 package.
5. **Blocker 2, the header layout.** `writeJsiHeadersXcframework` reads `NativeState.h` from
   `ExpoModulesJSI-Cxx/include/Public/` (`src/pipeline/jsiHeaders.ts:88`). jsi 57.1.3 has it there, with no quoted
   include. jsi 56.0.14 has it directly under `include/`, and it includes `"RetainedSwiftPointer.h"`, which sits next
   to it and includes only system headers. The only Package.swift difference between jsi 56.0.14 and 57.1.3, besides
   test targets, is 57's `.headerSearchPath("include/Public")`.
6. **Blocker 3, the iOS floor.** The vendored plugin gives each generated Expo package
   `raiseFloor(<its spm.config.json floor>, <core's spm.config.json floor>)` (`vendor/expo-spm/spm/manifests.js:1018`,
   `plugin.js:150`, `:957`). It never reads a podspec's platform. Core 56's `spm.config.json` says `iOS(.v16)`;
   expo-router has no `spm.config.json`, so ExpoRouter got `.iOS("16.0")` and failed against the scaffolded
   RNScreens package (16.4). All 28 `s.platforms` declarations in the spike app's Expo podspecs say `:ios => '16.4'`,
   ExpoModulesCore's included (`s.platforms = { :ios => '16.4', :osx => '13.4', :tvos => '16.4' }`, written over
   several lines in most of them). On a Mac, CocoaPods raises every Expo pod to core's podspec target, so a Mac build of SDK 56 compiles
   every Expo module at 16.4. Core 57's and 58's `spm.config.json` already say 16.4, which hid the gap.
7. **Blocker 4, an unreadable interface.** The `ExpoModulesJSI.swiftinterface` Swift 6.4.1 wrote for jsi 56.0.14 holds
   four stubs with an empty conformance list, each next to a correct `Swift::Copyable` stub:
   `@available(*, unavailable)` then `extension Swift::Optional :  where Wrapped : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}`
   (also `Swift::Array`, `Swift::Dictionary`, `ExpoModulesJSI::JavaScriptRef`). Every module that imports
   ExpoModulesJSI then fails at `xtool-build` with `expected type` (ExpoUI, ExpoWebBrowser, ExpoSymbols, ExpoSystemUI,
   ExpoSplashScreen). The interface's `swift-module-flags-ignorable` line holds `-no-verify-emitted-module-interface`,
   which is why the `jsi` step itself passed. The cause is in jsi 56's source (plan Task 4, Step 1): the four
   extensions conform generic types to the internal `~Copyable` protocol `JSIRepresentable`, and Swift 6.4 prints such
   a conformance into the public interface as a placeholder. jsi 57.1.3 marks exactly these four `@_spi(Internal)`,
   with a comment that says why, and a fresh SDK 57 interface built on Swift 6.4.1 has no such line; the module flags
   of the two interfaces are identical. Only Swift 6.4.1 is
   installed on this machine; `rn-xtool setup` runs `swiftly install 6.4` (`src/commands/setup.ts:295`), which takes
   the newest 6.4.x. Whether the SDK 57 verification of 2026-10-28 ran on 6.4.0 is not recorded.
8. **The synthesised headers tree is the vendored plugin's alone.** `build` passes `headersXcframework: true` only when
   the Expo plugin is vendored (`src/commands/build.ts:534-541`). SDK 58 reads the headers xcframework Expo publishes;
   its `jsi` step builds only the ExpoModulesJSI binary. A change to `JSI_HEADERS_GENERATOR_VERSION` therefore rewrites
   SDK 56 and 57 trees, not SDK 58's. A change to `scripts/build-expo-modules-jsi.sh` reaches SDK 58's binary too.
9. **The spike's green build.** After the four hacks: `patches`, `rn-artifacts`, `jsi`, `rn-spm`, `app-config`,
   `frameworks` (G4 passed), `generate`, `precheck` (8.9 s), `xtool-build` (226.9 s), exit 0. App.app is 140 MB. A
   manual `llvm-nm` check found no import of ExpoModulesCore, ExpoModulesWorklets, ExpoFileSystem, ExpoFont or
   ExpoImage missing from the embedded frameworks; ExpoModulesCore imports 153 ExpoModulesJSI symbols, none from the
   jsi patch. The compile was spread over three runs, so no from-zero time exists. Disk went from 9.2 GB to 4.8 GB free
   (app, node_modules and `.build`).
10. **Warnings the template prints**, all of a known kind: dev-launcher and dev-menu resources only Xcode compiles are
    left out; `Expo module "expo-modules-core" links its pod ExpoModulesCore as a precompiled XCFramework, so its
    product "ExpoModulesWorkletsAdapter" is left out of the app`; `ℹ No app icon: assets/expo.icon is an Icon Composer
    icon …` (the template's `ios.icon` is `./assets/expo.icon`); the scaffolder persisted patches for masked-view,
    gesture-handler 2.31.2, reanimated 4.3.1, safe-area-context 5.7.0, screens 4.26.2 and worklets 0.8.3.
11. **The table drives the rest.** The gate (`checkExpoPackages`, `src/project/expo.ts:254`), the patch selection and
    its overrides remedy (`floorRemedy`, `src/pipeline/patches.ts:584`), `doctor`'s versions, expo-plugin and
    expo-modules lines (`src/commands/doctor.ts:292-371`), `unsupportedReason`, the daily drift targets
    (`watchTargets`, `src/drift/targets.ts`) and the drill ids all read `SUPPORTED_LINES`. Only the refusal text names
    SDK 57 by hand (`src/project/expo.ts:380`). The weekly exploration lists SDK 56 (`EXPLORE_EXPO_SDKS`,
    `src/drift/targets.ts:74`). The hybrid gate refuses any SDK below 58 in a bare app (`src/project/bare.ts:118`).
12. **rn-xtool's App target is always iOS 16.4** (`IOS_MIN`, `src/generate/iosXtool.ts:340`). A dependency that asks
    for more fails in SwiftPM, as `pod install` fails on a Mac.

## Goals

1. **An SDK 56 row**, first in `SUPPORTED_LINES`: plugin `vendored`, policy `floor`, scripts `vendored`, artifacts
   `adapted`, templates `["default"]`, createExpo `5.1.5`, pins expo 56.0.24, react-native 0.85.3 (exact),
   expo-modules-core 56.0.27, expo-modules-jsi 56.0.14, expo-modules-autolinking 56.0.24, expo-file-system 56.0.11 and
   expo-font 56.0.7. G1–G3, `doctor`, the overrides remedy, the drift targets and drill ids follow from the row. The
   refusal names SDK 55 and older and is built from the table.
2. **The jsi 56 patch.** `patches/expo-modules-jsi+56.0.14.patch`, the same one-line change as 57.1.3's, staged only
   on a 56 line (`lineOnly`, unchanged), with its own test.
3. **The JSI headers in either layout.** `NativeState.h` from `include/Public/` (57 and newer) or `include/` (56),
   plus every header it includes with quotes, found next to it. The `jsi` errors name no React Native version.
4. **A readable ExpoModulesJSI interface**, through one of two exits picked by evidence (Approaches, B1/B2), and in
   both a guard that stops the `jsi` step with a named error when the interface still holds a line no compiler can
   parse.
5. **Each Expo package at its podspec's iOS floor** (vendored edit P7): the floor is the highest of the module's
   `spm.config.json`, its podspec, and core's floor (core's own `spm.config.json` and podspec). No version literal.
6. **Proof.** A fresh SDK 56 default template built from zero (timed), G4 passing; the SDK 57 and SDK 58 reference
   apps and a bare 0.85 app rebuilt without regression; then the owner's device pass (dev client, expo-router
   navigation, reanimated, expo-image, Fast Refresh) and the owner's own SDK 56 app, both run by the owner.
7. **Docs, changelog and the drift watch.** An "Expo SDK 56" section in `docs/how-it-works.md` and
   `docs/troubleshooting.md`, the README support table, `docs/RELEASING.md`, the workflow comment, `CHANGELOG.md`.
   SDK 56 leaves the weekly exploration; the daily watch checks `expo-56/default`. Two notes stated as behaviour: the
   default template's Icon Composer icon gives no app icon, and ExpoModulesWorkletsAdapter is left out next to the
   precompiled core.

## Non-goals

- **Expo SDK 55 and older.** Each needs its own look at its plugin route and precompiled modules (SDK 55 fetched its
  modules differently). The weekly exploration keeps watching 54 and 55.
- **React Native 0.84 and older**, in any form.
- **Release builds.** As for every line, rn-xtool builds debug apps; release is EAS's.
- **The remote precompiled-modules URL route** (`EXPO_USE_PRECOMPILED_MODULES`, `EXPO_PRECOMPILED_MODULES_BASE_URL`).
  It serves CocoaPods only, and SDK 56 does not need it.
- **Generating Podfile.lock.** Parked, as before.
- **Hybrid apps on SDK 56** (bare React Native 0.85 with Expo 56 modules). They stay refused: Expo modules in a bare
  app need SDK 58.
- **The owner's app's other libraries beyond what the template and its own run show.** Gaps found there become
  decisions, not part of this block's scope by default.

## Anti-goals

Things this block must not do, even where it would be quicker:

- No `56` literal in `src/` outside the row, and no branch on the SDK number: every behaviour follows a layout fact or
  a table field (`grep -rnE '\b56\.' src` lists only the row).
- No hard-coded iOS floor (the spike's `'16.4'` in `manifests.js` is not shipped).
- No interface cleanup that can silently match nothing: whatever exit is chosen, an unreadable line left in the
  interface stops the `jsi` step by name.
- No change to SDK 58's installed plugin: P7 is vendored-only, `patches/expo+58.0.21.patch` is untouched.
- No edit to `node_modules` outside patch-package, no edit to the user's `ios/`, no new network call in `build` or
  `doctor`.
- No doc calls SDK 56 verified on a device before the owner's pass.

## Constraints

- Linux, Node 22.12+, Swift 6.4 (6.4.1 on this machine), xtool 1.24.0, `IOS_MIN` 16.4.
- `vendor/expo-spm` stays expo 58.0.19 plus the shared patch plus vendored-only edits; its provenance test re-derives
  it byte for byte (`tests/vendor-expo-spm.test.ts`).
- The machine has under 9 GB free (7.2 GB on 2026-11-11). A from-zero SDK 56 build took about 4.4 GB in the spike.
  Builds and downloads happen only in the investigation of goal 4 and in the proof, each with the owner's go-ahead,
  and each deletes only the outputs it created, by literal path.
- Privacy: no absolute home paths, Team ID, UDID, Apple ID, e-mail or real IP in committed files; the owner's work
  app is "the owner's SDK 56 app" and nothing more.

## Approaches

### For the line as a whole

**A. Reuse SDK 57's path with a 56 row (recommended).** One row, one bundled patch, two generic fixes (header layout,
podspec floor) and one interface fix. Everything else (vendored plugin, vendored RN scripts, adapted artifacts, `jsi`
before `rn-spm`, precompiled modules from npm, G1–G4, drift) is reused unchanged. Proven by the spike: green
`xtool-build`, G4 passing, with four hacks that map one to one onto goals 2–5. Cost: small. Risk: the SDK 57 path now
carries two lines, so a change for 56 must be proved on 57 too (the proof does).

**B. Build ExpoModulesCore and the other modules from source** through core's `spm.config.json`, instead of the
precompiled tarballs. It would remove the skew between the tarballs and the installed core or RN (spike §8.1). But it
is a new route: core's Swift and C++ through the macro plugin on Linux, untested; a much longer first build; and it
leaves the route Expo's own SwiftPM plugin takes when the tarballs are there, so the result drifts from a Mac build.
Rejected for this block.

**C. Backport a 56-specific plugin** (a second vendored tree patched for 56's quirks). It duplicates `vendor/expo-spm`,
doubles the provenance and drift work, and puts version branches where layout checks suffice. The spike found no 56
quirk that a generic fix does not cover. Rejected.

### For the interface (goal 4)

**B1. Build-side fix.** A compiler flag in `scripts/build-expo-modules-jsi.sh`, or, if the cause is jsi 56's source,
a hunk in `patches/expo-modules-jsi+56.0.14.patch`, so that Swift writes no unreadable line. Pro: the interface is the
compiler's own, nothing is rewritten after the fact. Con: a flag reaches SDK 58's `jsi` build too (fact 8); a hidden
frontend flag may change meaning in a later toolchain; a source hunk binds the fix to one jsi version.

**B2. Narrow interface cleanup.** `writeJsiHeadersXcframework` removes exactly the pairs `@available(*, unavailable)`
+ `extension <T> :  where <…> : _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}` and nothing else, with a fixture
test on the real 56.0.14 excerpt, and `JSI_HEADERS_GENERATOR_VERSION` goes to 2. Pro: touches only the vendored-plugin
lines (56, 57), never 58; independent of the toolchain's flags. Con: rewrites compiler output; must be re-proved on 57;
can go stale with a new printer shape (the guard makes that loud).

The investigation (plan Task 4) decides between them on evidence: B1 when a build-side change yields an interface with
no unreadable line on jsi 56.0.14, differs from today's only in the module-flags line and the removed stubs, leaves
ExpoModulesJSI's exported symbol set unchanged, is a public `swiftc` option or a jsi source hunk (not a hidden
`-Xfrontend` option), and needs no version branch. B2 otherwise. The guard ships with either.

**Outcome: B1, the source hunk.** `patches/expo-modules-jsi+56.0.14.patch` adds jsi 57.1.3's four `@_spi(Internal)`
marks and its comment. Built on Swift 6.4.1, jsi 56.0.14's interface then differs from the unpatched one only by the
eight stub lines and the placeholder protocol, its `swift-module-flags` lines are unchanged, and `llvm-nm` lists the
same defined, exported and undefined symbols. The template app then gets through `xtool-build`, ExpoUI,
ExpoWebBrowser, ExpoSymbols, ExpoSystemUI and ExpoSplashScreen included (with core's floor raised by hand, which
P7 does). The hunk binds the fix to jsi 56.0.14, as the patch already is; SDK 57 and 58 are not touched.

### For the iOS floor (goal 5)

**P7, vendored-only (recommended).** `podspec.js` reads the literal iOS platform a podspec declares; `plugin.js` takes
it into the module's floor. Only the vendored plugin (SDK 56 and 57) runs it. **A hunk in `expo+58.0.21.patch`** would
reach SDK 58's installed plugin as well, where core already declares 16.4; it would change the patch every SDK 58 user
gets for no gain. **A hard-coded 16.4** (the spike's hack) is a version literal and wrong for a module that asks for
more. Rejected.

## Decisions

1. **The floor covers expo-file-system and expo-font, as SDK 58's does.** Both are dependencies of `expo` 56.0.24
   (`~56.0.11`, `~56.0.7`), so every SDK 56 app has them and the floor never refuses an app for lacking one. Both ship
   precompiled binaries built against a core of their SDK, so a lockfile that holds them below the set is the crash
   class G4 found on SDK 58 (precompiled ExpoFileSystem against a held core); G1 then names it with the remedy before
   G4 does. `expoPackageDir` resolves both from `expo` (`src/project/expo.ts:73-76`), which finds the top-level copies
   SDK 56 has. expo-image is not pinned: it is not a dependency of `expo`, a pin would refuse every app without it
   ("missing"), and G4 covers its symbols.
2. **Pin order is SDK 58's**: expo, react-native, expo-modules-core, expo-modules-jsi, expo-modules-autolinking,
   expo-file-system, expo-font. The G1 text, the warning and the overrides block follow it.
3. **The refusal is built from the table** by a new `supportedExpoList()` in `src/versions.ts` (as `supportedRnList()`
   is): every Expo row but the last as `SDK <n> (expo <pin> or newer <n>.x)`, then `SDK <last> or newer`.
4. **templates `["default"]`, createExpo `5.1.5`.** The default template is what the owner's app resembles (expo-router,
   reanimated, expo-image) and exercises far more than `blank-typescript`; the create-expo pin is the Expo rows'.
5. **Header lookup**: `include/Public/NativeState.h` wins when present, else `include/NativeState.h`; quoted includes
   are followed transitively within that directory; one that is not there is an error, not a skip.
6. **The `jsi` error drops "0.86.3"**: `rnArtifactsDir must hold the adapted slots of the project's React Native
   version, as rn-xtool's rn-artifacts step writes them.` The internal error in `build.ts:537` says "the vendored-plugin
   jsi step" instead of "the SDK 57 jsi step".
7. **The guard runs on both exits** and before anything is written: a line `extension <…> :<spaces>where` (an empty
   conformance list) left in the interface throws, naming up to three lines and the interface's compiler version.
8. **B1 includes the source-hunk variant**: when the cause is a source difference between jsi 56 and 57, the fix is a
   hunk in the bundled jsi 56 patch, judged by the same evidence as a flag.
9. **P7's floor** = the highest of the module's `spm.config.json` floor, its podspec's literal iOS platform, and core's
   floor (which itself takes core's podspec). Only the top-level spec's receiver counts (`s.platforms`,
   `s.ios.deployment_target`, `s.platform = :ios, '<v>'`), never a `subspec` or `test_spec` block; non-literal values
   are ignored. A floor is never lowered.
10. **The re-proof of SDK 57 and 58 that goal 4 owns runs once**, inside the proof (plan Task 6 Step 3), after P7 has
    landed, so each reference app is built once on a disk with under 9 GB free.
11. **ExpoModulesWorkletsAdapter stays left out**, as the plugin already does next to a precompiled core. The device
    pass checks reanimated and the router; a runtime gap there goes to the owner.
12. **`docs/libraries.md` gets an `Expo 56` column**, ⏳ everywhere except what the device pass checked.

## Failure walk

The process, end to end:

1. npm installs the SDK 56 set (create-expo, `npx expo install`, the user's lockfile).
2. `doctor`/`build` read the set: G1 (floors, react-native exact), G2 (one top-level expo-modules-jsi), G3 (the macro
   binary rn-xtool brings).
3. `patches`: patch-package applies the staged line patches (`expo-modules-jsi+56.0.14.patch`).
4. `rn-artifacts`: the React Native 0.85.3 slots, downloaded once into the shared cache and adapted.
5. `jsi`: `swift build` of ExpoModulesJSI 56 against the adapted headers.
6. Header generation: `ExpoModulesJSIHeaders.xcframework` from the build and the package's headers.
7. Interface fix: the readable interface, and the guard.
8. `rn-spm`: the vendored RN scripts with the vendored Expo plugin; scaffolding of CocoaPods-only libraries; P7.
9. Tarball extraction: the five precompiled modules, ExpoImage's `prebuilds/spm-deps` included.
10. `frameworks`: the embedded set and G4.
11. `generate`, `precheck`, `xtool-build`.
12. `install`, launch, Metro, the dev client.
13. Over time: new 56.x packages, a new Swift 6.4.x, the drift watch.

The owner confirmed the rulings of rows 1–40 on 2026-11-11; rows 41–44 carry a ruling awaiting the owner's confirmation.

| # | Hop | Fails how | Who learns | Ruling |
|---|-----|-----------|------------|-----------------|
| 1 | npm install | outright: ERESOLVE or network while creating the app or adding a package | user, in npm's output, before rn-xtool runs | accept: outside rn-xtool; the spike's template installed cleanly; `docs/troubleshooting.md` gets an SDK 56 entry only if the proof hits one |
| 2 | npm install | partial: `--omit=optional` or a macOS lockfile leaves out `@expo/modules-macros-linux-<arch>` | user at `doctor`/`build`: G3, `expo-modules-macros 0.22.0 has no Linux binary for <arch> …` (core 56 depends on the macOS-only `@expo/expo-modules-macros-plugin`, so the vendored plugin uses rn-xtool's copy, as on SDK 57) | handle: existing G3; plan Task 1 test `checks the expo-modules-macros copy the vendored plugin finds on SDK 56` |
| 3 | npm install | late (spike §8.1): a lockfile holds expo-modules-core, expo-file-system or expo-font below the set while other precompiled modules move on | user at `doctor`/`build`: G1 names each package below the floor, with the remedy | handle: the floor covers all three (Decision 1); Task 1 tests `names each SDK 56 pin below the floor` and `reads expo-file-system and expo-font where autolinking links them on SDK 56` |
| 4 | npm install | late (spike §8.1): expo-image, which is not pinned, on a 56.x built against another core | user at `frameworks`: G4 names ExpoImage, one missing symbol and the remedy | handle: G4 unchanged; Task 6 Step 2 runs G4 with ExpoImage embedded. Same-symbol layout changes: row 26 |
| 5 | npm install | duplicated: a second expo-modules-jsi nested under expo-modules-core (an app pin) | user: G2 names the nested copy and `npm update expo-modules-jsi` | handle: existing G2; Task 1 test `refuses a nested expo-modules-jsi on SDK 56` |
| 6 | Floors gate | react-native other than 0.85.3 (an older or newer 0.85.x, or a move by `npx expo install --fix`); spike §8.1, the tarballs are built against 0.85.3 and Hermes 250829098.0.10 | user: G1 `Expo SDK 56 needs react-native 0.85.3 …`, with the newer-than tail above 0.85.3 | handle: Task 1 test `refuses react-native other than 0.85.3`; Hermes follows react-native 0.85.3's own `hermes-compiler` |
| 7 | Floors gate | a newer 56.x of a pinned package | user: `⚠ Newer than the Expo SDK 56 set …`; the build continues | accept: the floor policy of SDK 57 and 58 (troubleshooting "Newer than the verified versions"); the daily watch creates the newest 56.x set; Task 1 test `warns and continues on a newer 56.x` |
| 8 | Floors gate | a package of another SDK's line in a 56 app (expo-modules-jsi 57.x) | user: G1 lists it ("off") | handle: Task 1 test `refuses a package of another SDK's line on SDK 56` |
| 9 | Floors gate | SDK 55 or older | user: `Expo SDK 55 is not supported; rn-xtool supports SDK 56 (…), SDK 57 (…) and SDK 58 or newer.` | handle: Task 1 tests `rejects SDK %i` (55, 54) and `lists the supported Expo SDKs from the table` |
| 10 | Floors gate | a bare 0.85 app with SDK 56 Expo modules (hybrid) | user: the existing hybrid refusal | handle: existing bare.test `refuses a hybrid app on Expo SDK %s` (its 56 case), unchanged; a non-goal |
| 11 | Patch apply | the 56.0.14 jsi patch does not apply to a newer 56.x jsi (spike §8.9) | user at `patches`: `rn-xtool could not patch expo-modules-jsi@56.0.x …` with the SDK 56 `"overrides"` block; maintainers: the daily patch dry-run opens `Drift: Expo SDK 56` | handle: Task 2 test `names the SDK 56 overrides when its jsi patch fails on a newer 56.x`; Task 1 targets.test (`expo-56/default` target) |
| 12 | Patch apply | another SDK's patch (jsi 57.1.3, the 58 set) staged on a 56 project | nobody until a confusing failure | handle: `lineOnly`, unchanged; Task 2 test `never stages another SDK's patch on SDK 56` |
| 13 | Patch apply | late (spike §8.2): the patch makes `CppError.message` internal, and a later core 56.x imports it | user at `frameworks`: G4 names ExpoModulesCore and ExpoModulesJSI (built by rn-xtool) | accept: loud at build time; core 56.0.27 imports none of it. `docs/troubleshooting.md` (Task 7) states that such a core needs the verified set through the `"overrides"` block |
| 14 | `rn-artifacts` | network (spike §8.5): the first build downloads the 0.85.3 slots; offline or a partial download | user at `rn-artifacts`: the downloader's error and last 40 lines; an incomplete slot is fetched again | accept: as ruled for bare 0.85 (rn-085 design rows 4–5); the Expo precompiled modules need no network |
| 15 | `jsi` build | `swift build` of jsi 56 fails: a header missing from the adapted 0.85.3 slot, or a stricter Swift 6.4.x | user at `jsi`: the compiler's output | handle for this set: Task 6 Step 1 builds it from zero. accept for a later toolchain: the compiler output is the message (owner's ruling 1) |
| 16 | `jsi` build | `rnArtifactsDir` points at raw or missing slots | user: the named error, with no React Native version in it | handle: Task 3 jsi.test `stops when the React Native headers are missing` (new text) |
| 17 | Header generation | `NativeState.h` in neither layout, or a quoted include not next to the header that includes it or pointing outside the folder (a 56.x that reorganises its headers) | user at `jsi`: a named error that names the header holding the include; nothing written | handle: quoted includes (`#include "x.h"`, `#import "x.h"`) are followed transitively, each resolved next to the header that includes it, and fail closed: one that is not there, or points outside the folder (`../x.h`, an absolute path), stops the step; they are read as text, so one inside a comment or an `#if 0` block is followed too; an angle-bracket include of a package-local header is not copied, and the compiler reports it at `xtool-build`. Task 3 tests `names a local include that is not next to NativeState.h`, `names the header that holds an include that is not there`, `names a nested header's include that is not next to it`, `refuses an include that points outside the folder: %s`, `resolves an include next to the header that holds it, in a nested folder`, `follows #import as #include` and `a failed synthesis leaves no stamped xcframework` |
| 18 | Header generation | partial or stale: an interrupted write, or a tree stamped by an older generator reused | nobody: a stale tree compiles or fails later | handle: existing swap-and-stamp tests; under B1 (taken) the patched source changes the interface and its sha256, so the stamp rewrites the tree (`rewrites when the interface changes`), and the guard runs before the stamp check, so a stamped tree with an unreadable interface stops the step too (`refuses an unreadable interface even when the stamp says the tree is current`) |
| 19 | Interface fix | the unreadable lines come back in a shape the fix does not know (a newer jsi 56.x or Swift 6.4.x; spike §8.3), or B1's flag stops working | today: users at `xtool-build`, eight `expected type` errors in other modules. With this block: user at `jsi`, a named error | handle: the guard on both exits; Task 4 test `stops on a broken line it does not know` |
| 20 | Interface fix | B2 removes more than the stubs (a conformance consumers need) | user at `xtool-build`: "does not conform" | not reached: Task 4 took B1, which removes nothing from the interface; B2's test would have owned it |
| 21 | Interface fix | the fix changes SDK 57's build, or, under B1, SDK 58's | users of a line that worked | handle: Task 6 Step 3, which is Task 4's re-proof: the SDK 57 and SDK 58 reference apps build through G4 |
| 22 | `rn-spm`, vendored plugin | an Expo module's podspec asks for more iOS than its `spm.config.json` and core's (expo-router 16.4; spike blocker 3, §8.4) | user at `xtool-build`: `requires minimum platform version 16.4 … supports 16.0` | handle: P7; Task 5 tests `P7 reads the iOS deployment target a podspec declares` and `P7 raises a module to its podspec's iOS floor` |
| 23 | `rn-spm` | a podspec asks for more than the App target's 16.4 (17.0) | user at `rn-spm`: one `⚠` line per such module, once per build: its podspec asks for iOS 17.0, rn-xtool builds the app for iOS 16.4, the module is compiled for 16.4, and its code that needs 17.0 must be behind an availability check (on a Mac, the app's deployment target would be raised); a call that is not behind one fails at `xtool-build` | handle: P7 caps the floor it takes from a podspec at the App's deployment target, which `rn-spm` passes from `IOS_MIN` (`RN_XTOOL_APP_IOS_DEPLOYMENT_TARGET`), and writes the warning to the notes file `rn-spm` prints once after its runs (`RN_XTOOL_PLUGIN_NOTES`); a floor from a module's own `spm.config.json` is not capped, as before P7; the plugin run without the target takes the podspec's floor uncapped and says nothing. vendor-expo-spm.test `P7 caps a podspec's floor at the app's deployment target and warns once`, `P7 leaves a module's own spm.config.json floor as it was`, `P7 takes a podspec's floor uncapped and silent without the app's deployment target`, `P7 writes its warnings to the notes file rn-xtool prints, else to stderr` and `P7 takes core's podspec floor into a sibling's generated manifest`; rnSpm.test `prints the Expo plugin's warnings once after rn-spm, however many times it ran`; rn-spm-generate.test `clears inherited Expo plugin variables when --expo-plugin is absent`; `docs/troubleshooting.md` entry for the warning (Task 7) (awaiting the owner's confirmation) |
| 24 | `rn-spm` | a podspec declares its platform in a form P7 does not read (a variable, interpolation, a method call), or one P7 reads differently from Ruby: a declaration inside an `if`, which counts as unconditional; several assignments, of which Ruby keeps the last and P7 the highest; a heredoc whose terminator never comes, which hides the rest of the podspec | the module keeps core's floor (16.4 on SDK 56); one that needs more fails to compile at `xtool-build`. A misread floor is never above the App's target (row 23's cap), so a misreading can only give a spurious row 23 warning | accept: P7's limits are listed in `vendor/expo-spm/README.md`; Task 5 test asserts `null` for those forms; `P7 reads only what Ruby runs, and versions SwiftPM takes` (heredocs, `=begin`, `'17'`, `16.10`, nested specs that reuse the receiver's name) (awaiting the owner's confirmation) |
| 25 | `rn-spm` | P7 changes SDK 57's generated packages (spike §8.4: the hard-coded floor would have) | users of SDK 57 | handle: P7 never lowers a floor (Task 5 test); Task 6 Step 3 checks the `platforms:` lines of the SDK 57 reference app's generated packages |
| 26 | `frameworks` + G4 | late (spike §8.1): the source-built ExpoModulesJSI and the precompiled ExpoModulesCore disagree on a C++ layout with the same symbols (NativeState, CppError are not library-evolution safe), e.g. on a newer jsi 56.x | user: a crash or misbehaviour on the device after a green build | accept: G4's documented limit; the newer-than warning asks for a report; owner's ruling 2 (floor or exact jsi) |
| 27 | `rn-spm` | ExpoModulesWorkletsAdapter left out while reanimated and worklets are installed (spike §8.6) | user: the plugin's warning; a runtime gap would show only on the device | handle: Task 6 Step 4 checks reanimated and the router on the device; Task 7 states the behaviour; a gap goes to the owner |
| 28 | `rn-spm` | persisted scaffold patches of six template libraries go stale on upgrade (spike §8.8); Xcode-only resources of dev-launcher and dev-menu left out | user: the existing slot warning, and the resources warning | accept: existing behaviour (troubleshooting "Build and patches"), as on SDK 57 and 58 |
| 29 | Tarball extraction | AppleDouble entries and xattr pax headers in all five tarballs | GNU tar warnings and stray files | handle: P5, existing test `P5 extracts without AppleDouble entries or xattr warnings` |
| 30 | Tarball extraction | a damaged tarball (an interrupted npm install) | user at `rn-spm`: tar's error | accept: reinstall the package, as on SDK 57 |
| 31 | Tarball extraction | ExpoImage's `spm-deps` (SDWebImage, its coders, libavif) not linked or not embedded | user: a link error, or dyld at launch | handle: Task 6 Steps 1–2 (the `Frameworks/` list, G4) and Step 4 (an image renders on the device) |
| 32 | `frameworks` + G4 | a G4 false positive on SDK 56 (ExpoImage and the spm-deps, ExpoModulesWorklets) | user: a working app refused | handle: Task 6 Steps 1–2 record G4 passing on the template |
| 33 | `generate` | the default template's `ios.icon` is an Icon Composer `.icon` (spike §8.7) | user: `ℹ No app icon: assets/expo.icon is an Icon Composer icon …`; the app has no icon | accept: present-tense note in how-it-works' SDK 56 section and troubleshooting's "App icon and launch screen" (Task 7) |
| 34 | `precheck`, `xtool-build` | a module fails for a reason the spike never saw (its compile was spread over three runs) | user | handle: Task 6 Step 1 builds from zero in one run and records every step |
| 35 | Install, launch | dyld at launch, Hermes, the dev-client link (`expo-development-client/?url=…` is checked only on 57 and 58), router, reanimated, expo-image, Fast Refresh | user, on the device | handle: Task 6 Step 4, the owner's device pass; the row merges only after it |
| 36 | Install, launch | the owner's SDK 56 app uses libraries the template lacks | the owner | handle: Task 6 Step 5, run by the owner; each failure goes to the owner as a decision |
| 37 | Over time | a newer 56.x set (jsi, core) is published (spike §8.9) | maintainers: the daily watch (gates, patch dry-run, manifests) opens `Drift: Expo SDK 56`; no compile, no interface, no G4 | handle for gates and patches: Task 1 targets.test. accept for compile, interface and G4: RELEASING "No compile, no device, no G4"; row 19's guard makes the interface case loud for users |
| 38 | Over time | swiftly installs a newer Swift 6.4.x that prints or compiles differently | users at `jsi` (the guard) or `xtool-build` | accept: `setup` takes the newest 6.4.x by design; owner's ruling 1 |
| 39 | Over time | SDK 56 leaves the weekly exploration | nobody | accept: the daily watch covers it with more checks (Task 7 explore.test) |
| 40 | Disk | ENOSPC during a first SDK 56 build (about 4.4 GB with node_modules; App.app 140 MB) | user | accept: sizes stated in how-it-works' SDK 56 section (Task 7), as for SDK 57 |
| 41 | npm install | duplicated: two copies of expo-file-system or expo-font, one at the top level and one nested under `expo`, with different versions | user at `doctor`/`build`: G1 names the copy the build links when it is below the floor | handle: G1 reads the copy expo-modules-autolinking links, as the CLI the Expo plugin runs answers (`resolve --platform apple --json` from the project root: rn-xtool's autolinking on SDK 56, the one the installed plugin resolves on SDK 58), on SDK 56 and 58, so autolinking's own choice decides: the app's or a dependency's copy, a `file:`-linked local library's own copy, a copy nested under another dependency, a copy `expo.autolinking.searchPaths` or `nativeModulesDir` scans, and the default exclusions it skips (jest-expo, `@babel/*`…); a package it does not link is skipped when a copy is installed (an `expo.autolinking.exclude` entry for it: the build never embeds its precompiled framework, and expo's own native code does not import it on SDK 56 or 58), and counts as missing (`not installed`) when none is. Task 1 tests `reads expo-file-system and expo-font where autolinking links them on SDK 56`, `gates the %s copy the app lists on SDK 56`, `names expo-font not installed when autolinking links no copy on SDK 56`, `skips the %s pin expo.autolinking.exclude leaves unlinked on SDK 56` and `… on SDK 58`, the `reads the expo-font copy autolinking's own CLI links` group (D, A, B, C), the `through the app's autolinking CLI` group on SDK 58 and `gates the library's copy the app's autolinking links on SDK 58` (awaiting the owner's confirmation) |
| 42 | npm install | pnpm, Yarn PnP or another layout without a flat `node_modules` | user at `build` and `doctor --project`: the early refusal, before anything is built | accept: existing behaviour; `build` refuses these setups early (`knownLimits.allow` lets them through, and the build may then fail later), and README's "Before you start" lists npm or Yarn classic as the requirement (troubleshooting "pnpm and Yarn PnP") (awaiting the owner's confirmation) |
| 43 | `xtool-build` | the SDK 56 modules compiled from source get their macros expanded by rn-xtool's expo-modules-macros 0.22.0, not by the plugin core 56 depends on; a later 56.x module that uses a macro the two expand differently fails after a green gate | user at `xtool-build`: the compiler's error | accept: a loud compiler failure; Task 6 Step 1 covers this set, and the vendored plugin's README states the limit (Task 7) (awaiting the owner's confirmation) |
| 44 | `doctor`/`build`: the gate | the autolinking CLI cannot run at gate time: not found, a non-zero exit, no answer within a minute, or output that is not its JSON | user at the build's autolinking step, which runs the same CLI and stops there | handle: the gate falls back to the two-copy rule (the top-level copy when the app, or a package the app lists, depends on it; else expo's) and never stops on the CLI's failure itself; Task 1 tests `falls back to the two-copy rule when the CLI %s` and the `through the fallback rule` group on SDK 58 (awaiting the owner's confirmation) |

## Verification

- **Unit tests** as the plan lists them; `npm test` and `npm run lint` green; `npm run scan:private` clean.
- **Investigation (goal 4)**: needs the owner's go-ahead; jsi-only builds into a scratch folder, deleted after.
- **Build-only proof**: the fresh template from zero (create, install, first and second build timed), G4, the
  `platforms:` of the generated ExpoRouter package, the interface free of unreadable lines; the SDK 57 and SDK 58
  reference apps and the bare 0.85 app rebuilt.
- **Device pass** by the owner, then the owner's SDK 56 app, run by the owner. No doc says "on a device" before it.
- **Drift**: one daily run after merge with `expo-56/default` in it, and one explore run without SDK 56.

## Owner's rulings on the open questions (2026-11-11)

1. **Swift 6.4.x drift.** The investigation checks a fresh SDK 57 interface on Swift 6.4.1 first. If it has the same
   unreadable stubs, the fix for SDK 57 ships first in its own PR, and `setup` pins an exact Swift patch release.
2. **expo-modules-jsi on SDK 56 is a floor** with the warning, as on SDK 57 (row 26 stays accepted).
3. **The template's device pass gates the merge.** The owner's own SDK 56 app is reported separately and its failures
   become decisions.
4. **The drift templates are `["default"]` only.**

## Left to the builder

The comment wording in `src/versions.ts` and the vendored files; the exact regular expressions of P7 and of the guard
(the tests fix their behaviour); whether `tests/support/expo56.ts` reuses `tests/support/expo57.ts` through a shared
helper; the fixture app's name; the wording of the new doc sections around the verbatim texts.
