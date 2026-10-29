# Expo SDK 58 version drift: research

Date: 2026-10-28. Read-only on code. The packages were packed with `npm pack` into empty directories under `<scratch>/drift58/`
and deleted afterwards. The reference app `../app` (branch `feature/lib-expo-router`) was only read, never changed. Nothing was
built and nothing was launched. Symbol checks used `llvm-nm` from the Swift 6.4.1 toolchain (swiftly), the toolchain rn-xtool
already installs.

## Verdict

- **Today rn-xtool's SDK 58 support does not work for a new user.** The README quickstart
  (`create-expo-app --template default@sdk-58`) gets expo 58.0.21 and **react-native 0.88.1**. The `patches` step then stops with
  "pin react-native to 0.88.0".
- **Pinning `expo@58.0.19` is no longer enough.** It pulls expo-modules-core 58.0.28, which nests expo-modules-jsi 58.0.21, so the
  build fails at `rn-spm` (Task 15, run B).
- **Holding core at 58.0.26 builds, but the app crashes at launch.** expo-file-system 58.0.13 and expo-font 58.0.11 are precompiled
  against a newer core (Task 15 device).
- **The 58.0.21 set needs no new patch content.** All four bundled patches apply strictly (`-F0`). Their target files are
  byte-identical in the new versions. Only the version in each file name changes.
- **Expo publishes no "built against core X" field.** A coherence gate can still be exact by checking imported symbols against
  exported symbols. That check reproduces the launch crash offline in about 20 ms per binary (§2).
- **Not verified:** whether RN 0.88.1's changed SwiftPM scripts and jsi 58.0.21's new C++ sources build on Linux (§3, §7).

## 1. What a fresh SDK 58 project resolves to today

`npm view expo dist-tags`: `latest` = **58.0.21** (published 2026-10-28 15:36Z), `next` = 58.0.11. `expo-template-default` and
`expo-template-blank-typescript` `sdk-58` = 58.0.30 (2026-10-28). Both templates pin `expo ~58.0.21`, `react-native 0.88.1` and
`react 19.3.0`.

expo releases after 58.0.19 (`npm view expo time`): 58.0.19 on 10-23 23:27Z, 58.0.20 on 10-27 16:12Z, 58.0.21 on 10-28 15:36Z.
58.0.18 was never published. Cadence: 58.0.0 (09-29) to 58.0.21 is 21 releases in 29 days. react-native 0.88.1 was published on
10-27, 12 days after 0.88.0.

A lockfile resolved from the blank-typescript template (`npm install --package-lock-only --ignore-scripts`):

| Package | Resolved | Where | Declared by |
|---|---|---|---|
| expo | 58.0.21 | top level | template `~58.0.21` |
| react-native | 0.88.1 | top level | template `0.88.1`; expo 58.0.21 `bundledNativeModules.json` = `0.88.1` (58.0.19 and 58.0.20: `0.88.0`) |
| expo-modules-core | 58.0.28 | top level | expo `~58.0.28` (58.0.19: `~58.0.26`, 58.0.20: `~58.0.27`) |
| expo-modules-jsi | 58.0.21 | top level | core 58.0.28 `~58.0.21` (core 58.0.26: `~58.0.19`, 58.0.27: `~58.0.20`) |
| expo-modules-autolinking | 58.0.16 | top level | expo `~58.0.16` (58.0.19 and 58.0.20: `~58.0.15`) |
| expo-modules-macros | 0.27.1 (+ `@expo/modules-macros-linux-x64` 0.27.1) | top level | core 58.0.28, exact (26: 0.22.0, 27: 0.24.0) |
| expo-file-system | 58.0.13 | **`expo/node_modules/`** | expo `~58.0.13` |
| expo-font | 58.0.11 | **`expo/node_modules/`** | expo `~58.0.11` |
| expo-asset | 58.0.19 | `expo/node_modules/` | expo `~58.0.19` |
| expo-constants | 58.0.14 | `expo/node_modules/` | expo `~58.0.14` |
| expo-keep-awake | 58.0.3 | `expo/node_modules/` | expo `~58.0.3` |

- npm nests expo's own modules under `expo/node_modules` even on a fresh install with no conflict. Any gate must resolve them from
  `expo`'s directory, as `isInstalled` already does.
- Every package in the table is the latest published version except `next`. The set moves whenever Expo publishes.
- In the `bundledNativeModules.json` diff from 58.0.19 to 58.0.21, 33 of 124 entries moved. Among them: core `~58.0.26` → `~58.0.28`,
  expo-file-system `~58.0.11` → `~58.0.13`, expo-font `~58.0.10` → `~58.0.11`, expo-router `~58.0.26` → `~58.0.28`, react-native
  `0.88.0` → `0.88.1`.

## 2. Precompiled modules: how versions are picked, and what ties them to core

**Lookup** (`expo/scripts/spm/README.md`, `flavored-frameworks.js` `precompiledBases`): for every resolved pod except
ExpoModulesJSI, the plugin tries three places:

1. `EXPO_PRECOMPILED_MODULES_PATH/<pkg>/output/<flavor>/xcframeworks`
2. the monorepo `.build`
3. `<installed package>/prebuilds/output/<flavor>/xcframeworks/<Framework>.tar.gz`

The **installed npm copy decides**. No other version input exists. A tarball is extracted into `ios/build/expo-xcframeworks/<id>/<flavor>`.
The extraction cache stamp `.source.json` is `{path, size, mtimeMs}` of the tarball, so stale extractions are refreshed. RN then
copies the result to `ios/build/xcframeworks/{debug,release}/plugins/<id>.xcframework` and lists it in `flavored-frameworks.json`.

In SDK 58 the packages that ship `prebuilds/` are expo-modules-core (ExpoModulesCore, ExpoModulesWorklets, ExpoModulesCoreHeaders),
expo-modules-jsi (headers only), expo-file-system and expo-font (seen in `../app`; the others have `spm.config.json` without
`publishPrebuilds`).

**What upstream checks, and what it does not:**
- `mixedSourcesReport` (plugin.js) compares only the *kind of place* each artifact comes from (env, monorepo or bundled). Its own `why`
  text admits the risk: "Precompiled Expo modules … are bound to the exact ExpoModulesCore build they were made with, so mixing … can
  crash the app at launch on a missing symbol."
- The headers stamp `expo-package.json` exists only in the headers xcframeworks (`{"name":"expo-modules-jsi","version":"58.0.21"}`,
  same for core). It names the package's own version, not what it was built against.
- `ExpoFileSystem.framework/Info.plist` has `CFBundleShortVersionString 1.0`. The package.json has no dependency on core: its peers
  are `expo *` and `react-native *`. `spm.config.json` names `expo-modules-core/ExpoModulesCore` without a version.
- **There is no machine-readable "built against core X" field.**
- Changelogs are not a reliable signal either. expo-file-system 58.0.12 says only "Fix Mac Catalyst builds", yet it needs core 58.0.27
  (table below). Other entries say it plainly: 58.0.10 has "Bump precompiled artifacts due to ABI breakage in expo-modules-core@58.0.23",
  and 58.0.13 has "Rebuild precompiled iOS binaries against React Native 0.88.1".

**Symbol evidence.** Command: `llvm-nm -m --undefined-only <module>`, keeping only the symbols marked `(from ExpoModulesCore)`, then
`comm -23` against `llvm-nm --defined-only --extern-only <core>`, with LC_ALL=C. The binaries are the `ios-arm64` debug slices. Each
cell is the number of imports missing from core:

| Precompiled module | core 58.0.26 | core 58.0.27 | core 58.0.28 |
|---|---|---|---|
| ExpoFileSystem 58.0.11 | 0 | 0 | 0 |
| ExpoFileSystem 58.0.12 | **2** | 0 | 0 |
| ExpoFileSystem 58.0.13 | **2** | 0 | 0 |
| ExpoFont 58.0.10 | 0 | 0 | 0 |
| ExpoFont 58.0.11 | **2** | 0 | 0 |

- **The missing pair** is `_$s15ExpoModulesCore9AnyModulePAAE11_classTypesSayAA12SharedObjectCmGvgZ` and its `Tq` descriptor. That is
  the exact dyld crash symbol, added in core 58.0.27 ("Build the JavaScript classes of `@SharedObject` classes … from their type").
- **Older modules run on a newer core** (0 missing). So far core changes have been additive.
- **Same check on `../app`'s staged `ios/build/xcframeworks/debug/plugins/*`:** ExpoFileSystem 2 missing, ExpoFont 2 missing,
  ExpoModulesWorklets 0. The gate would have stopped the build that crashed.
- **The same mismatch exists one level down, against ExpoModulesJSI.** The check here uses the JSI that rn-xtool built in `../app`
  from expo-modules-jsi 58.0.19 (`ios-xtool/Frameworks/ExpoModulesJSI.framework`). ExpoFileSystem 58.0.13 misses 2 imports
  (`JavaScriptEncodable.encode(_:into:in:)`), as does ExpoFont 58.0.11. Core 58.0.28 misses 6 (`JavaScriptValue.Slot`, …).
  ExpoFileSystem 58.0.11 and 58.0.12 and core 58.0.26 miss 0.
- **Against RN:** core 58.0.26 and 58.0.28 import 102 symbols from `React` and 31 from `hermesvm`. All of them resolve in `../app`'s
  RN **0.88.0** artifacts, so 0.88.0 against 0.88.1 shows no gap at the symbol level. C++ layout changes are invisible to this check:
  0.88.1 changes `jsi/decorator.h` (64 lines), `jsi.cpp`, and Hermes `260318099.0.4` → `.0.5`.

**How a coherence gate can tell:**
- **(i) Exact, any version: symbol closure.** For every framework the app embeds (`flavored-frameworks.json` plugin and RN entries, plus
  the built `ExpoModulesJSI.framework`), each non-weak undefined symbol whose two-level-namespace library is another embedded framework
  must be exported by that framework. This is dyld's check, run on Linux.
  - Cost: one `llvm-nm` per binary, about 20 ms.
  - Limits: it runs only at build time, after `rn-spm` and `jsi`, and it does not see C++/ABI layout changes.
- **(ii) Cheap, needs a table: a version set.** Every precompiled-module package and core must be at the verified versions. It runs at
  `doctor`/project-read time. It knows nothing about versions outside the table.
- **Rejected: version ranges.** `expo@58.0.19` declares `expo-file-system ~58.0.11`, and 58.0.13 satisfies that range, so a range
  check passes the crashing install.

## 3. Diffs 58.0.19 → 58.0.21 and the bundled patches

All diffs below compare packed copies with `diff -rq`. The dry-runs use `patch -p3 -F0 --dry-run -d <pkg>/package`, which is strict
like patch-package (no fuzz).

| Package | Versions | What changed | Bundled patch | Strict dry-run |
|---|---|---|---|---|
| expo | 58.0.19 → 58.0.21 (and 58.0.20) | android, `build/winter/fetch`, `bundledNativeModules.json`, `package.json`, `template.tgz`. **`scripts/spm/` byte-identical** | `expo+58.0.19.patch` (5 files under `scripts/spm`) | applies to 58.0.19, 58.0.20, 58.0.21 |
| expo-modules-jsi | 58.0.19 → 58.0.21 | substantial Swift and C++ changes: new `HermesRuntime.cpp` (includes `<hermes/hermes.h>`, as 58.0.19's `JSIUtils.cpp` already did), `Microtasks.cpp`, `JavaScriptValue+Slot.swift`; `JSIUtils.cpp` removed; `apple/Package.swift` identical; **`JavaScriptError.swift` byte-identical**; no new `extension expo.<C++ type>` | `expo-modules-jsi+58.0.19.patch` | applies |
| expo-modules-autolinking | 58.0.15 → 58.0.16 (expo 58.0.21 wants `~58.0.16`) | only `CHANGELOG.md` and `package.json` | `expo-modules-autolinking+58.0.15.patch` | applies |
| react-native | 0.88.0 → 0.88.1 (expo 58.0.21 wants exactly 0.88.1) | 43 files. **Patch targets byte-identical** (`read-podspec.js`, `scaffold-package-swift.js`, `spm-utils.js`). Changed SwiftPM code: `generate-spm-xcodeproj.js` (1083 changed lines: React build settings move to a generated committed `.xcconfig`; new `PluginFrameworkMismatchError`, a set-membership check, not a version check), `generate-spm-autolinking.js` (130), `sync-spm-autolinking.js` (80), `ios-deployment-target.js` (79), `setup-apple-spm.js` (15), `spm-types.js` (podspec `headerSearchPaths` removed), new `xcconfig-files.js`, and the codegen `Package.swift.spm-template` (`.unsafeFlags(["-O2"])` for Release) | `react-native+0.88.0.patch` | applies |
| expo-modules-macros | 0.22.0 → 0.27.1 (core's exact dependency) | `build/index.js` adds `expandMacros`. The Linux binary package still has `ExpoModulesMacros` at its root, so the patch's `require.resolve('@expo/modules-macros-linux-<arch>/ExpoModulesMacros')` keeps working | n/a | n/a |

RN 0.88.1 artifacts exist on Maven Central (`curl -sIL`): `react-native-artifacts-0.88.1-reactnative-core-debug.tar.gz` (200, 101 MB),
`hermes-ios-260318099.0.5-hermes-ios-debug.tar.gz` (200, 32 MB).

**Does the current release (alpha.2) build the 58.0.21 set?**
- With RN 0.88.1, no: `rnPatchMismatch` stops before patch-package runs.
- With RN forced back to 0.88.0, `selectBundledPatches` would stage the highest patches. They would apply, and patch-package would only
  warn about the version mismatch.
- That combination runs precompiled modules built against RN 0.88.1 on 0.88.0. It is untested, so it is not a supported path.

## 4. The vendored SDK 57 plugin

`vendor/expo-spm` is expo 58.0.19's `scripts/spm` plus the shared patch and P1-P6. **Keep it at 58.0.19.**
- 58.0.20 and 58.0.21 have a byte-identical `scripts/spm`, so moving it would change nothing but the provenance tarball and its
  sha512 pin (`tests/support/expoSpm.ts`).
- SDK 57 uses rn-xtool's own expo-modules-autolinking 58.0.15 and expo-modules-macros 0.22.0. Neither depends on the app's SDK 58
  drift. autolinking 58.0.16 differs only in its changelog.
- If the shared patch is renamed (§5), only `EXPO_SHARED_PATCH` and the README's file name change. The provenance test still derives
  `vendor/expo-spm` from `expo-58.0.19.tgz` plus the same patch content.

## 5. Proposed support model

**(a) Move to the 58.0.21 set and drop 58.0.19.**
- (b) would mean supporting a set that npm no longer resolves on its own: `expo@58.0.19` now pulls core 58.0.28. A user would need
  hand holds on core, file-system and font, the last two nested under `expo`.
- Two sets would also need two RN patches and two device verifications, for no user benefit. `create-expo-app` and
  `expo install --check` both point at 58.0.21.

**Pins (the verified set):**

| Package | Version | Read where |
|---|---|---|
| expo | 58.0.21 | root |
| react-native | 0.88.1 | root |
| expo-modules-core | 58.0.28 | from `expo` |
| expo-modules-jsi | 58.0.21 | from core; must be the top-level copy |
| expo-modules-autolinking | 58.0.16 | root, else `expo` |
| expo-file-system / expo-font | 58.0.13 / 58.0.11 | from `expo` (nested) |
| expo-modules-macros | 0.27.1 | from core (informational: core pins it exactly) |

**Patches:**
- `git mv` the four files: `expo+58.0.21.patch`, `expo-modules-jsi+58.0.21.patch`, `expo-modules-autolinking+58.0.16.patch` and
  `react-native+0.88.1.patch`. Content is unchanged.
- Keep `react-native+0.88.0.patch` only if bare 0.88.0 stays supported (open question 2).
- If both RN patches stay, `rnPatchMismatch` must flag a mismatch only when *no* react-native patch matches. Today it returns the first
  file that differs.

**Gate checks** (extend the SDK 57 model: `SUPPORTED_EXPO[58].pins`, `expoPinsFor(58)`, and `readExpoPins` iterating the SDK's own pin
names):

1. **G1 SDK 58 pins** (`doctor` and `build`). The text follows SDK 57's: "Expo SDK 58 needs expo 58.0.21, react-native 0.88.1, …;
   installed: …".
   - Older than the set: error. Remedy: "Run `npx expo install --fix`, remove any pin or lockfile hold on these packages, and
     reinstall."
   - Newer than the set: see the policy below.
2. **G2 one JSI** (`doctor` and `build`): the jsi that core resolves must be the top-level copy, as on SDK 57. The SDK 58 remedy
   differs from 57's: "remove the `expo-modules-jsi` pin from package.json (expo-modules-core <v> needs <its range>) and reinstall". On
   SDK 58 the user's own jsi pin is what causes the nesting, and `docs/bare-react-native.md` currently tells users to add it. This
   check runs before the plugin's misleading `et prebuild` remedy can.
3. **G3 macros binary** (`doctor` and `build`): extend `expoMacrosBinaryError` to SDK 58, resolving
   `@expo/modules-macros-linux-<arch>` from **core's** expo-modules-macros. An `--omit=optional` app install loses it as well.
4. **G4 precompiled coherence** (`build` only, in the `frameworks` step, after `rn-spm` and `jsi` and before `xtool-build`): the
   symbol closure from §2 (i), applied to every embedded framework and the built ExpoModulesJSI, on the device `ios-arm64` slice.
   - Error text: "ExpoFileSystem.framework (expo-file-system 58.0.13, from node_modules/expo/node_modules/expo-file-system) needs 2
     symbols that ExpoModulesCore.framework (expo-modules-core 58.0.26) does not export, for example `AnyModule._classTypes`. The app
     would crash at launch (dyld: Symbol not found). Its precompiled binary was built against another expo-modules-core. Run
     `npx expo install --fix`, remove any pin or lockfile hold on expo-modules-core, reinstall, and build again."
   - When the missing side is ExpoModulesJSI, the text names the expo-modules-jsi version it was built from and the range core
     declares.
   - G4 is version-agnostic, so it also covers `EXPO_PRECOMPILED_MODULES_PATH` and modules missing from the table.

**Plan notes:**
- Generalise `ExpoPinName`.
- Update `EXPO_NEEDS_088` and the hybrid bare + Expo text and docs.
- Update `docs/bare-react-native.md` lines 153-154 (they tell users to pin jsi 58.0.19).
- Add a troubleshooting SDK 58 section with G1-G4.
- Update README badges and quickstart.
- Move the reference app to the 58.0.21 set, dropping the core 58.0.26 hold.

**Drift policy (the cheapest sustainable one).** Data: 21 expo patch releases in 29 days. Core went from 58.0.20 to 58.0.28 in 12
days. Two precompiled ABI breaks happened in two weeks (core 58.0.23 and 58.0.27). RN 0.88.x had one patch release in 12 days.

- **P1, exact set as a hard error (the SDK 57 model).** Safe, but the quickstart breaks within days of every rn-xtool release. A
  user must pin 6+ packages, some nested under `expo`, which needs `overrides`. Every Expo patch release costs a tool release.
- **P2, the verified set as a floor plus coherence (recommended).**
  - Hard errors for:
    - anything older than the set;
    - RN outside the exact supported list (RN's SwiftPM scripts change a lot per patch release);
    - a bundled patch that does not apply (today's "pin" message);
    - G2, G3 or G4 failing.
  - Newer expo, core, jsi, autolinking or modules within 58.x give a **warning** ("not verified with rn-xtool <ver>; verified set: …").
  - A tool release is needed only when a patch stops applying, RN ships a patch release, or G4 starts failing on a fresh template.
    Today none of those happen for 58.0.20 → 58.0.21 except RN.
  - G4 turns the dangerous class of drift, a launch crash, into a build error, with or without a table.
- **P3, drift watch (defer to a named task).** A scheduled CI job runs `npm view` on the set, a `patch -F0` dry-run, and the G4 matrix
  on a template lockfile, and opens an issue when something moves. It is cheap, and it turns surprise into a ticket.

## 6. Failure walk

| # | Hop | Fails how | Who learns, how | Proposed ruling |
|---|---|---|---|---|
| 1 | npm resolution (`create-expo-app`, `npm install`, `npx expo install <lib>`) | Lockfile or pin holds core below the modules (`../app` case); a jsi pin nests a second jsi; template moves to new RN; Expo publishes after an rn-xtool release | Nobody: every range is satisfied and npm is silent | **handle** via hops 2 and 5 (G1, G2, G4); **defer** upstream-release detection to P3 drift watch |
| 2 | Gate (`doctor`, project read in `build`) | Pins off; nested jsi; macros binary missing; nested modules under `expo/node_modules` read from the wrong place | User, by a G1, G2 or G3 message naming versions and the remedy | **handle**: G1-G3 with tests (exact texts, nested and top-level resolution, older or newer than the set) |
| 3 | Patches (patch-package) | Upstream changed a patched file, so the patch does not apply. Partial: earlier patches were applied before the failure (Task 15 run A). The patch applies but upstream semantics changed | User, by today's "pin" message; semantic drift shows up later as a loud build error | **handle** non-apply (existing message, renamed files, `rnPatchMismatch` fix + test); **accept** partial application (reinstall clears it; written in troubleshooting); **accept** semantic drift (caught at hop 4 or 6, loudly) |
| 4 | `rn-spm` (`setup-apple-spm.js add\|update` + Expo plugin) | JSI headers stamp ≠ installed jsi (plugin error with the wrong remedy); RN 0.88.1 script changes (xcconfig injection, `generate-spm-xcodeproj` rewrite, podspec `headerSearchPaths` dropped) break our flow; new `PluginFrameworkMismatchError` | User, by the plugin or RN error text | **handle** the stamp case by G2 preempting it; **handle** 0.88.1 by a real build of the template and `../app` as a plan task (unverified here); **accept** `PluginFrameworkMismatchError` (RN's own text) |
| 5 | Precompiled fetch (tarball → `expo-xcframeworks` → `xcframeworks/*/plugins`) | Missing or damaged tarball; mixed sources (env var); **version incoherence** (not detected upstream) | Upstream error for the first two; nobody for the third | **accept** the first two (upstream messages are clear); **handle** incoherence by G4 + test (fixture binaries or a synthetic Mach-O pair) |
| 6 | Link (`xtool-build`: SwiftPM compile + link) | Source modules against precompiled core fail to link (loud); precompiled ↔ precompiled mismatches are **not** seen by the linker (embedded, never relinked) | User, by a linker error; nobody for precompiled pairs | **accept** source-module link errors; precompiled pairs are **handled** by G4 |
| 7 | Launch (dyld on the device) | `Symbol not found` (`../app` crash); C++ layout drift (RN 0.88.0 vs 0.88.1 `jsi/decorator.h`) or behaviour changes not visible to symbols | User, by a crash with no rn-xtool message | **handle** symbol class through G4; **accept** layout drift for the verified set by pinning RN 0.88.1 exactly (the version Expo built against); device launch of the template and `../app` before release is a manual check, not a test |

## 7. Not covered here

- **No build of the 58.0.21 set ran.** Two things are open:
  - RN 0.88.1's SwiftPM script changes, against rn-xtool's `add|update` flow and `flavored-frameworks.json` v1 reader;
  - jsi 58.0.21's new `HermesRuntime.cpp` and `Microtasks.cpp` in rn-xtool's Linux `jsi` step.

  The patches apply, but a clean apply does not show that the result builds.
- **G4 sees only bound imports.** It misses runtime lookups by name (`NSClassFromString`, Swift `_typeByName`) and changes to C++ or
  Swift layouts that keep the same symbols.
- **Precompiled modules besides file-system and font** were not surveyed across all 124 `bundledNativeModules.json` entries. G4 does not need that list,
  but G1 does.
