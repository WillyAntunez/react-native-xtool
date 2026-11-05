# Library Compatibility Implementation Plan

> **For implementers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The work app's native libraries build with rn-xtool on a bare React Native 0.88.1 app:
- react-native-vision-camera, react-native-video, react-native-device-info and @react-native-community/netinfo build
  without hand fixes;
- react-native-app-auth builds through AppAuth-iOS's SwiftPM package;
- a library whose CocoaPods pod has no known SwiftPM package (ML Kit) is refused early and offline;
- a native module can be left out of a dev build;
- the app's entitlements reach xtool, and the user is told before the build which ones a free team drops.

Four rn-xtool bugs go away on the way:
- a scaffold run no longer rewrites other libraries' hand-edited scaffolds;
- a failed scaffold is reported first, with its own reason;
- a patch left after `npm uninstall` no longer stops the build;
- resources that do not reach the app are named.

**Architecture:**
- **Scaffolder (fixes 20–25).** The vendored copy (`vendor/rn-spm/spm/`) is the working copy. Every change is mirrored
  into `patches/react-native+0.88.0.patch`, and that file is copied byte for byte to `react-native+0.88.1.patch`.
  The copies are kept equal by the recipe in Global Constraints and checked by the byte tests.
- **Pipeline.**
  - `scripts/rn-spm-generate.js --scaffold` gains `--only <name>` (repeatable) and `--results <file>`, and no longer
    forces. Expo SDK 58 scaffolds through the same driver.
  - `runRnSpm` passes the names React Native reported, reads the per-library results, and stops on the first real
    failure.
  - `applyPatches` stages the project's patches without orphans when there are any.
- **Pods.**
  - The scaffolder exports `classifyPodDependency`. Its built-in pod map keeps one baseline entry (SwiftUIIntrospect),
    in the new shape.
  - rn-xtool ships `data/pods.json` (AppAuth). It merges that file and the config's `pods` over the baseline, and
    hands the result to the scaffolder as `ios/build/rn-xtool-pods.json`, named by `RN_SPM_POD_TABLE` in
    `rnSpmEnv`.
  - The early check `unmapped-pod` runs the same classifier, loaded from rn-xtool's vendored copy, on the podspec's
    unconditional lines.
- **Exclude.** `scripts/exclude-config-command.js` wraps the autolinking config command when `exclude` is set, and sets
  `platforms.ios` to `null` for each listed package.
- **Entitlements.**
  - `CODE_SIGN_ENTITLEMENTS` (Debug; on Expo, from the prebuild's pbxproj) is copied to `ios-xtool/App.entitlements`,
    and `xtool.yml` gets `entitlementsPath`.
  - A table checked against xtool 1.24.0's tag source gives the `⚠` lines.

**Tech Stack:** TypeScript (Node 22.12+, ESM), vitest, the vendored React Native 0.88.0 SwiftPM scripts (CommonJS),
`patch-package` 8, GNU `patch` and `git diff --no-index` (patch regeneration only), the `plist` package `src/plist.ts`
already uses, SwiftPM 6.4 manifests, xtool 1.24.0.

**Spec:** `docs/design/specs/2026-11-04-library-compat-design.md` (approved, commit 8676e47). The owner's rulings on
open questions 1–9 are in `.superpowers/sdd/2026-11-04-library-compat/progress.md` (git-ignored) and are restated
below. The research notes are kept outside the repo:
- `<scratchpad>/libmatrix/libmatrix-findings.md`, with the four hand fixes and the exact build errors in
  `<scratchpad>/libmatrix/saved/handfix/`;
- `<scratchpad>/mlkit/mlkit-appauth-findings.md`.

The spec's failure-walk rulings are binding.

## Rulings baked in (owner, 2026-11-04)

1. **OQ1, missing sibling:** drop the subspec that declares it, with its sources, headers, settings and dependencies (Task A1).
2. **OQ2, codegen `-I` anchor:** the proof decides. `Context.packageDirectory` comes first; the fallback is a flat
   `X.h` at the root of the per-app header tree. Task A4 Step 0 decides, before any code.
3. **OQ3, `exclude` and Expo modules:** a `⚠` naming `expo.autolinking.exclude`. Expo's autolinking is not changed (Task D3).
4. **OQ4, team kind:** the conditional wording "on a free team". xtool's login state is not read (Task E4).
5. **OQ5, xtool source:** the entitlement table is read from the 1.24.0 tag's source (Task E1), not from `main`.
6. **OQ6, pin outside the requirement:** a warning, not a refusal (Task C6).
7. **OQ7, fix 24:** in this block (Task A5).
8. **OQ8, Expo proof:** an Expo SDK 58 build-only proof with react-native-app-auth's config plugin, if disk allows (Task F3).
9. **OQ9, shipped pod table:** a JSON file in rn-xtool (`data/pods.json`), merged over the scaffolder's baseline map,
   and passed to the scaffolder in the same file as the config's `pods` (Tasks C1, C4).

## Facts this plan rests on (checked in code, 2026-11-04)

1. **The scaffolder ships twice. Both copies must stay equal.**
   - `vendor/rn-spm/` is pristine React Native 0.88.0 (`tests/.cache/react-native-0.88.0.tgz`) plus
     `patches/react-native+0.88.0.patch` (`patch -p4` in `scripts/`) plus `vendor/rn-spm/rn-xtool-edits.patch` (E1–E5,
     `patch -p1`).
   - `tests/vendor-rn-spm.test.ts` ("vendor/rn-spm is react-native 0.88.0 with our patch and rn-xtool-edits.patch
     applied") re-derives the directory and compares bytes.
   - `tests/patches.test.ts` "keeps the two react-native patches identical" compares `+0.88.0` and `+0.88.1` byte for
     byte.
   - `tests/patches-upstream.test.ts` dry-runs each bundled patch with `-F0` against its pristine tarball.
   - `tests/rn-scaffolder.test.ts` "the patched RN files carry the patch" checks each fix's hunk in pristine 0.88.1
     plus the patch.
   - The daily drift watch dry-runs the same patches against the newest 0.88.x (`docs/RELEASING.md`, "What it checks").
   - The patch touches three files today: `read-podspec.js`, `scaffold-package-swift.js` and `spm-utils.js`. It does
     not touch `setup-apple-spm.js`.
   - **`tests/.cache` is absent in this worktree, so all of these byte tests skip today** (Task 0 fetches the
     tarballs).
2. **How a value reaches the vendored scaffolder:** through the environment of the process that runs it.
   - Precedents: `RN_SPM_RN_ROOT` (E2, set by the driver), `RN_SPM_EXPO_PLUGIN` (E5), and `RN_SPM_SWIFT_HEADERS_DIR`
     (`rnSpmEnv`, `src/pipeline/rnSpm.ts:114`).
   - `rnSpmEnv` is passed to every React Native run (`runRnSpm`), driver and `setup-apple-spm.js` alike. The pod table
     file follows the same path.
3. **The config schema** is `ExpoXtoolConfig` in `src/config.ts`.
   - There is no JSON schema file.
   - `loadConfig` merges `rn-xtool.config.json`, then `rn-xtool.config.js`.
   - Shape errors are `ConfigError`s that name the file and the key (`checkKnownLimits`).
   - `doctor --project` reads the config through `detectCapabilities` (`src/project/capabilities.ts`). `build` reads
     it at its start, before the early checks.
4. **Scaffold call sites.**
   - Bare apps and Expo SDK 57 scaffold through `scripts/rn-spm-generate.js --scaffold`, which runs
     `scaffoldAll({... force: true})` (line 192).
   - Expo SDK 58 runs React Native's own `setup-apple-spm.js scaffold` (`scaffoldArgv`), whose `runScaffold` also
     forces (line 487) and then falls through into `add`.
5. **xtool source.**
   - The local checkout (`../xtool`) is at 952a7ff (2026-10-22, "entitlements: support Sign in with Apple") and has
     no tags. The spec's 2af0b67 is not in it.
   - At 952a7ff, `AppGroupEntitlement` is `isFree: false` (with a `FIXME: Enable app groups on free accounts`) and
     `tooManyAppGroups` does not exist.
   - Which of the two 1.24.0 has is unknown until Task E1.
6. **Goldens.**
   - `tests/rn-scaffolder.test.ts` "scaffolds the reference app's libraries as the golden" reads `../app` (relative
     to the repo; it exists in this layout) and compares with `tests/fixtures/scaffold-golden/`.
   - Every task that changes manifest output for those libraries regenerates the goldens in the same commit.

## Global Constraints

- Linux, Node 22.12+, Swift 6.4, xtool 1.24.0 (`XTOOL_VERSION`) and `IOS_MIN` 16.4 stay unchanged. No new npm
  dependency.
- **No new network call** in `doctor`, `doctor --project` or `build`. The early checks read files only and load no
  project code: the classifier comes from `vendor/rn-spm`, as the Expo plugin readers already do. SwiftPM's fetch of a
  mapped pod's package (AppAuth-iOS) happens inside `xtool dev build`, as for SwiftUIIntrospect today.
- **The two copies of the scaffolder** (Fact 1). Every task that changes `vendor/rn-spm/spm/*.js` (A1–A5, B1, C1, C2)
  ends with this sync before its commit. It is run by hand; nothing of it is committed.
  ```sh
  T=<scratchpad>/rnpatch; rm -rf "$T"; mkdir -p "$T/x" "$T/a/node_modules/react-native" "$T/b/node_modules/react-native"
  tar -xzf tests/.cache/react-native-0.88.0.tgz -C "$T/x" package/scripts/setup-apple-spm.js package/scripts/spm \
    package/scripts/codegen/templates/Package.swift.spm-template
  cp -a "$T/x/package/scripts" "$T/a/node_modules/react-native/scripts"
  mkdir -p "$T/b/node_modules/react-native/scripts"
  cp -a vendor/rn-spm/setup-apple-spm.js vendor/rn-spm/spm vendor/rn-spm/codegen "$T/b/node_modules/react-native/scripts/"
  patch -R -p1 -F0 -d "$T/b/node_modules/react-native/scripts" -i "$PWD/vendor/rn-spm/rn-xtool-edits.patch"
  (cd "$T" && git diff --no-index --no-color --src-prefix= --dst-prefix= \
     a/node_modules/react-native/scripts b/node_modules/react-native/scripts) > "$T/rn.patch"
  cp "$T/rn.patch" patches/react-native+0.88.0.patch && cp "$T/rn.patch" patches/react-native+0.88.1.patch
  ```
  - If the reverse patch fails, the change moved the context of an E-edit (E2 touches `read-podspec.js` and
    `spm-utils.js`).
    - Regenerate `vendor/rn-spm/rn-xtool-edits.patch` as the diff from the `b/` tree (with the fix, without the
      edits) to `vendor/rn-spm/`.
    - Use the same `git diff --no-index` with `--src-prefix=a/ --dst-prefix=b/`, and paths relative to `scripts/`.
    - Then rerun the sync.
  - Then run `npx vitest run tests/vendor-rn-spm.test.ts tests/patches.test.ts tests/patches-upstream.test.ts
    tests/rn-scaffolder.test.ts`.
    - **None of the provenance, identical-patch, upstream or "carry the patch" tests may report as skipped.** Check
      the vitest summary.
    - A skip means `tests/.cache` is missing (Task 0).
  - Each new fix adds one hunk test to "the patched RN files carry the patch" (`tests/rn-scaffolder.test.ts:82`).
- **Scaffold revision.**
  - `RN_XTOOL_SCAFFOLD_REVISION` and `SCAFFOLD_REVISION` go from 3 to 4 once, in Task A6.
    `tests/patches.test.ts` "keeps SCAFFOLD_REVISION in step with the scaffolder's RN_XTOOL_SCAFFOLD_REVISION" guards
    that they match.
  - The later scaffolder changes (C1, C2) add content only to libraries with mapped pods, and do not bump again
    (preflight finding P14).
- **Portable manifests.**
  - No emitted manifest, forwarder or marker holds an absolute path or a path that leaves the package. The only
    exceptions are app paths relative to the `build/generated/autolinking/libs/<SwiftName>` symlink and
    `Context.packageDirectory` expressions.
  - A test asserts this for each new kind of content (A4, C2).
- **Texts.**
  - User-facing texts in this plan are verbatim: `ℹ`/`⚠` lines, errors, refusals and scaffolder warnings. `${…}`
    marks a value.
  - A doctor line is the same text without its leading `ℹ `/`⚠ `, with status info/warn.
- **Fixtures.**
  - Podspec fixtures are written in each library's shape, not copied from the libraries.
  - No absolute home-folder path (a planted home is `/home/me`), Team ID, UDID, e-mail or real IP appears in committed
    files. Team IDs in fixtures are `TEAMID0000`, and bundle ids use `com.example.app`.
- **Proof runs.**
  - They happen only in `<scratchpad>/libcompat-proof/`, with the worktree's CLI: `npm run build`, then
    `node <worktree>/bin/rn-xtool.js <cmd>`.
  - Delete `ios-xtool/.build` after each build, and record its size before deleting it.
  - No reference app (`../app`, `../app-bare`, …) is modified.
  - Downloads beyond the approved ones need the owner's OK first. Approved: npm installs of vision-camera 4.7.3,
    device-info 15.0.2, netinfo 11.5.2, video 6.19.3 and react-native-app-auth 8.5.1, and SwiftPM's fetch of
    AppAuth-iOS 3.0.0.
  - Stop and report when the build disk has less than 8 GB free.
- **Commits.**
  - Every task ends with `npm test && npm run lint` green.
  - Every commit runs `npm run scan:private` after `git add`.
  - Conventional Commits in English, with the subject given in the task (≤ 50 characters), no body, one logical
    change each, and no scratch code.
  - Never push, rebase, amend or stash. Tasks 0, E1, F1–F3, H and I are run by the controller with the owner.
- **PR slicing.**
  - **PR 1** = A1–A6, B1–B5 and G1, opened only after the F1 proof passes. It is recommended: it unblocks the four
    libraries in the work app without waiting for pods, `exclude` and entitlements.
    - The controller creates `feature/scaffold-fixes` at G1's commit without switching to it:
      `git branch --no-track feature/scaffold-fixes <G1 sha>`.
    - Then the owner pushes it with `git push -u origin feature/scaffold-fixes`, and `@{u}` must print
      `origin/feature/scaffold-fixes`.
    - Work continues on `feature/library-compat`.
  - **PR 2** = C, D, E, F2–F3 and G2, from `feature/library-compat` after PR 1 is merged.
  - If F1 fails on a library, PR 1 waits, and the failure goes to the owner as a decision.

### Failure-walk owners (spec rows 1–51)

| # | Ruling | Owner |
|---|---|---|
| 1 | handle | Task C3 `names a pods entry of the wrong shape` (it.each, every key); Task D1 `names an exclude of the wrong shape` |
| 2 | accept | Task C3 plan note (checking a product or URL needs the network); Task G2 troubleshooting entry quotes SwiftPM's resolve error |
| 3 | handle | Task C6 `warns when the pinned version misses the podspec's requirement` (doctor and build start), matcher it.each |
| 4 | accept | Task C1 plan note (the core prefixes are kept as they are; a core name wins over `pods`, which cannot map it); Task G2: the troubleshooting entry for the "file not found" points to `exclude` or an issue |
| 5 | handle | Task C5 `refuses AppAuth's shape without a table entry`, `refuses ML Kit's shape, naming GoogleMLKit once`; Task F2 step 5 |
| 6 | handle | Task C5 `ignores pods under a Ruby condition (react-native-video's shape)` |
| 7 | accept | Task C5 test `knownLimits.allow turns it into a warning`; plan note: the build may then fail at compile time, as the allowed-limit text says |
| 8 | handle | Task A1 tests (both warning texts); Task B3 `prints the failed library's warnings after its error`; Task F1 step 2 (vision-camera's warning names `FrameProcessors`) |
| 9 | handle | Task A1 `drops the subspec that declares a missing sibling, with its sources, headers and settings`; Task F1 step 2 (`CameraView` in the binary) |
| 10 | accept | Task A2 plan note: CocoaPods compiles such a pod in Swift 6 too |
| 11 | handle | Task A2 `an interpolated or computed swift_version counts as absent` |
| 12 | accept | Task A3 plan note (fix 2's rule, unchanged); existing test `keeps one header and warns on a basename collision` |
| 13 | handle | Task A4 Step 0 (anchor spike on netinfo) and its tests; Task F1 step 2 (`RNCNetInfo` in the binary) |
| 14 | accept | Task A4 plan note: a search path to a missing folder is ignored |
| 15 | accept | Task B2 plan note: existing behaviour (`refreshStaleScaffolds`, `scaffoldPatchWarnings`); existing patches tests |
| 16 | accept | Task G1 troubleshooting text: delete the library's `Package.swift` and its patch to regenerate it |
| 17 | handle | Task B3 `stops on a library the scaffolder could not scaffold, with its reason first`; `counts a library whose scaffold threw as failed, even with a bannered Package.swift` |
| 18 | handle | Task B3 `a library without a scaffolded Package.swift afterwards failed too` |
| 19 | accept | Task A6 (existing warning, new numbers); Task G1 CHANGELOG "Upgrading" says to delete and rebuild |
| 20 | accept | Task B3 test `persists nothing for a failed library and never runs React Native again` (the persist warning no longer follows a failed scaffold) |
| 21 | handle | Task B4 tests; Task F1 step 4 |
| 22 | accept | Task B4 plan note: an installed package at another version is not an orphan; patch-package's own warning stays |
| 23 | handle | Task C7 tests (persisted and unpersisted copies) |
| 24 | accept | Task G2 docs: a clean `.build` needs the network for mapped pods; SwiftPM's error names the URL |
| 25 | accept | Task G2 docs: the pod table is the one place to align pins |
| 26 | accept | Task F2 step 2 records whether `AppAuth_AppAuth.bundle` and `AppAuth_AppAuthCore.bundle` reach `App.app`; Task G2 states the result in the present tense |
| 27 | handle | Task C8 unit tests; Task F3 (Expo SDK 58 with the plugin). Without F3: documented as build-unverified (OQ8) |
| 28 | handle | Task D3 `warns about a name that is not a native iOS dependency`; `fix: judge exclude names against the linked set` (D/E review M3), tests `judges each name against the packages autolinking links (row 28)`, `names the config file the exclude comes from` |
| 29 | accept | Task A1 (the "not installed (or not linked for iOS)" warning names the dependency, and excluded packages count as not linked); Task G2 docs: exclude the dependents too |
| 30 | handle | Task D2 Step 0 (spike: netinfo excluded in the proof app); Task F2 step 6 |
| 31 | accept | Task D3 `ℹ exclude` line at every `doctor --project` and `build`; Task G2 present-tense docs with the guard |
| 32 | handle | Task D3 `warns that an Expo module needs expo.autolinking.exclude` |
| 33 | handle | Task E3 `refuses a missing entitlements file` and `refuses a file that is not a dictionary` |
| 34 | accept | Task E3 reads Debug only (test `reads the Debug configuration's file`); Task G2 docs say so |
| 35 | handle + accept | Task E4 line tests; Apple's policy is recorded in Task G2 |
| 36 | accept | Task E4 text says xtool does not enable it on a paid team; spec Non-goals |
| 37 | handle (pending E1) | Task E4 `several App Groups` line and Task E5 mapping, **only if 1.24.0 has `tooManyAppGroups`**; otherwise App Groups get the generic paid line (owner decision, preflight P1) |
| 38 | handle + accept | Task E4 `keychain-access-groups` line test; the app's own group in its `$(TeamIdentifierPrefix)` and `$(CFBundleIdentifier)` forms gets no line (final review PR 2 m3), tests `resolves $(CFBundleIdentifier) as the bundle id, and both own-group forms get no line (row 38)`, `counts $(TeamIdentifierPrefix)<bundle id> as the app's own keychain group (row 38)`; xtool's rewrite recorded in Task G2 |
| 39 | handle | Task E2 `the table was checked with the pinned xtool` |
| 40 | handle | Task E1 (1.24.0 tag source read before Task E2) |
| 41 | handle | Task H (owner's device pass); Task G1/G2 docs call the libraries build-verified until then |
| 42 | handle | Task A4 (fix 23's forwarder guard) `no forwarder when a library's own header has the name, with a warning` |
| 43 | handle | Task B4 `does not call a scoped patch in a subfolder an orphan, as patch-package reads the path under patches/` |
| 44 | handle | Task B5 `leaves out a value over several lines whose closing line carries a modifier, and reads on after it` |
| 45 | accept | Task G1 troubleshooting text: the dropped-subspec entry says the subspec stays left out until the library is re-scaffolded after the install |
| 46 | handle | Task B5 `says privacy manifests are read only at App Store submission only when every resource is one` |
| 47 | handle | `fix: merge pod overrides field by field` (C1–C4 review M1), test `merges a config entry over the shipped one field by field` |
| 48 | handle | Task C7 (C1–C4 review M2) `warns when a persisted scaffold of a library with mapped pods pins nothing`, `regenerates an unpersisted copy whose pins differ` |
| 49 | handle | `fix: index every installed podspec package` (C5–C8 review I1), test `on Expo, does not refuse a sibling installed as a peer, outside package.json (reanimated 4.3.4 and worklets 0.8.3)`; `feat: refuse a pod sibling missing from package.json` (D/E review M2, bare only), tests `on bare, refuses a pod sibling installed but not listed in package.json (row 49)`, `names several unlisted siblings in one refusal`, build `passes the project kind to the library checks (row 49: bare refuses an unlisted pod sibling)` |
| 50 | handle | `fix: treat all React Native core pods as core` (C5–C8 review I2), tests `<name> is core` and the drift test `classifies every podspec name in react-native@<version> as core` |
| 51 | handle | `fix: expect pod pins only for kept subspecs` (C5–C8 review M1), test `leaves out the pods of a subspec the scaffolder drops for a missing sibling`; `fix: read parenthesised pod dependencies` (fix 26), tests `26: reads `s.dependency('Pod', …)` as CocoaPods does`, `26: pins a mapped pod named in parentheses` |
| 52 | handle | `fix: pass entitlements only when the file has keys` (D/E review M1), tests `passes no entitlements for the prebuild's empty file: xtool.yml stays byte-identical (row 52)` and `reads the entitlements` (no doctor line for a file without keys) |
| 53 | handle | `fix: clear ios/ when rn-xtool's prebuild fails` (F3 proof), tests `removes the ios/ a failed prebuild left and says so (row 53)`, `rethrows the error unchanged when the failed prebuild wrote no ios/`, `says so when the half-written ios/ cannot be removed` |
| 54 | accept | Task H: a bare app with an entitlements file installs and launches on the device (xtool's ad-hoc pass at build leaves `App` and the framework binaries without the exec bit until `install` re-signs; F2, F3) |
| 55 | accept | final review PR 2, three ways #2: one present-tense sentence in troubleshooting's "Libraries that depend on CocoaPods pods" (rn-xtool reads the top level of `node_modules`; a nested copy is read as an unmapped pod: `npm dedupe`, or add the package to package.json) |

## Review Focus

1. Persisted, hand-edited scaffolds of libraries React Native did not name are never rewritten. Tests: Task B2
   `scaffolds only the libraries RN names`, Task B1's `onlyDeps` tests and Task F1 step 3.
2. A named library whose scaffold failed stops the run with the scaffolder's own reason. It is not persisted, and
   React Native does not run a second time. The other libraries are persisted (Task B3).
3. The two copies of the scaffolder are equal: the provenance, identical-patch and upstream tests ran without skips
   in every scaffolder task (Fact 1).
4. No emitted manifest, forwarder or marker holds an absolute path (Tasks A4 and C2).
5. The early checks stay offline and load only rn-xtool's vendored scripts, never a project file as code (Task C5
   `loads only rn-xtool's vendored scaffolder`).
6. An Expo app whose bridging header holds only comments gets a byte-identical `Package.swift` (Task C8).
7. `exclude` never edits `react-native.config.js`, and without `exclude` every argv stays as it is today (Task D2).
8. The entitlement table is tied to `XTOOL_VERSION` (Task E2).
9. Before the final verdict, the reviewer answers without hints: "Name three ways this fails in production that no
   test covers." Any answer not in the spec's failure table goes to the owner as a decision, not to the implementer
   as a fix.

---

### Task 0: Preparation (controller with the owner)

No commit.

- [ ] **Step 1 (needs the owner's OK: a download of 14 pinned tarballs, about 150 MB).** Run
  `node scripts/fetch-test-tarballs.mjs`. Then
  `npx vitest run tests/vendor-rn-spm.test.ts tests/patches-upstream.test.ts` passes with no skipped test.
- [ ] **Step 2 (needs the owner's OK: the template's npm install).** Create the proof app:
  - `npx --yes @react-native-community/cli@<the bare-0.88 row's cli pin in src/versions.ts> init LibCompat --version
    0.88.1 --directory <scratchpad>/libcompat-proof/app --install-pods false --skip-git-init`;
  - then, approved: `npm install react-native-vision-camera@4.7.3 react-native-video@6.19.3
    react-native-device-info@15.0.2 @react-native-community/netinfo@11.5.2`;
  - then `git init && git add -A && git commit -m base` inside the app. This is the app's own scratch history, used to
    reset between proof steps; it is never pushed.
- [ ] **Step 3 (baseline, optional; it costs one build).** With the worktree's current CLI, run `doctor --project` and
  `build`. Record the four failures, the same as `<scratchpad>/libmatrix/libmatrix-findings.md`:
  - vision-camera's `no resolved Swift name for the sibling 'react-native-worklets-core'`;
  - after a hand opt-out of it, device-info's invalid header layout, netinfo's `'RNCNetInfoSpec.h' file not found`
    and video's strict-concurrency errors.

  Record the `.build` size, delete `.build` and reset the app.

---

## A. Scaffolder fixes 20–24 and revision 4 (PR 1)

Each task: write the fixture test in `tests/rn-scaffolder.test.ts`, in a new `describe("scaffolder fixes 20–25
(vendor/rn-spm)")` that loads `VENDORED_RN_SPM` (like fixes 14–19, so it never skips). Add the hunk test, sync the two
copies, regenerate the goldens when their output changes, and write the fix's entry in
`docs/upstream/react-native-scaffolder.md`.

Each entry follows the shape of 1–19: the repro, the effect, the fix, and the library it was found on.

### Task A1: Fix 20, a dependency on a package that is not installed is left out

**Files:**
- Modify:
  - `vendor/rn-spm/spm/read-podspec.js`: per-subspec dependencies, and a drop option;
  - `vendor/rn-spm/spm/scaffold-package-swift.js`: `classifyPodDependency`, the iOS-unlinked index and the subspec
    drop;
  - both 0.88 patches, `docs/upstream/react-native-scaffolder.md` (fix 20).
- Test: `tests/rn-scaffolder.test.ts`

**Interfaces:**
```js
// read-podspec.js
// PodspecModel gains subspecDependencies: {[subspec: string]: Array<string>}: the selected subspecs only. The regex path
//   reads each layer with getDependencies; flattenSubspecs reads subspecs[].dependencies keys.
// readPodspecCached(podspecPath, opts?: {dropSubspecs?: Array<string>}): PodspecModel
//   The named subspecs' layers are left out: sources, exclude, public headers, header_dir, header_mappings_dir,
//   frameworks, libraries, xcconfig defines and dependencies. Refs "<Pod>/<name>" to them are dropped. The cache key
//   is the resolved path plus the sorted drop list. regexPodspec(path, opts?) and flattenSubspecs(raw, opts?) take the
//   same option.
// scaffold-package-swift.js
// classifyPodDependency(depName, ctx: {selfPodName: string, ownNpm: string, podToNpm: Map<string, string>,
//   linkedNpm: Set<string>, table: {[pod: string]: Object}}) =>
//   {kind: 'subspec' | 'core' | 'expo' | 'sibling' | 'missing-sibling' | 'mapped' | 'unmapped', pod: string,
//    npm?: string, entry?: Object}
//   'missing-sibling': a react-native-* name whose package is not in linkedNpm, or a pod name that podToNpm maps to an
//   npm package not in linkedNpm. 'mapped'/'unmapped' as today (KNOWN_POD_SPM_PACKAGES). The order of the checks is
//   today's loop at lines 685–731.
//   The union leaves room for a 'binary' kind (next block) without changing callers.
// collectAutolinkedDeps: onSkipped(name, root). scaffoldAll indexes the podspecs of the deps autolinking lists without
//   iOS into podToNpm too, so a pod-style dependency on an excluded package is 'missing-sibling', not 'unmapped'.
// translatePodspecToSpmTarget: linkedNpm = the keys of swiftNameByNpm (every iOS-autolinked dep has a resolved name).
// scaffoldPackageSwiftForDep: reads the model. When a missing sibling is declared only in subspec layers, it reads the
// model again with dropSubspecs set to those subspecs, then translates.
// module.exports gains classifyPodDependency.
```
- Texts (scaffolder warnings):
  - main spec: `Dependency "react-native-worklets-core" is not installed (or not linked for iOS); left out, as CocoaPods leaves it out.`
  - subspec: `Dependency "react-native-worklets-core" is not installed (or not linked for iOS); left out with the subspec "FrameProcessors" that declares it (its sources, headers, settings and dependencies), as CocoaPods leaves it out.`

- [ ] **Step 1: Write failing tests.** They use the `lib()` and `scaffoldLibraries` helpers.
  - `20: drops the subspec that declares a missing sibling, with its sources, headers and settings`:
    - in vision-camera's shape: main `s.source_files = "ios/**/*.{h,m,mm,swift}"`, a `Core` subspec, a `React`
      subspec with `core.dependency "React-Core"` and, inside `if enableFrameProcessors`, `core.dependency
      "VisionCamera/FrameProcessors"`;
    - and, inside `if enableFrameProcessors`, `s.subspec 'FrameProcessors'` with
      `fp.source_files = ["ios/FrameProcessors/**/*.{h,m,mm}"]`, `fp.pod_target_xcconfig =
      {"CLANG_CXX_LANGUAGE_STANDARD" => "c++17"}` and `fp.dependency "react-native-worklets-core"`;
    - react-native-worklets-core is not autolinked.
    - Expect: status `written`, no `react-native-worklets-core` in the manifest, no `ios/FrameProcessors/` source,
      and the subspec warning verbatim.
  - `20: drops a main-spec dependency alone and keeps its sources` → `s.dependency "react-native-missing"` in the main
    spec → the main-spec warning verbatim; every source stays.
  - `20: a pod-style dependency on a package autolinking lists without iOS is a missing sibling` →
    - two libs, where `b`'s podspec is `RNB.podspec`, autolinking.json gives `b` `platforms.ios: null`, and `a` has
      `s.dependency "RNB"`;
    - expect the main-spec warning naming `RNB`, and no "no known SwiftPM equivalent" warning.
  - `20: an autolinked sibling is still wired` → `react-native-b` autolinked → `.package(name: "B", path: "../B")`
    as today.
  - `classifyPodDependency` it.each over the seven kinds, with today's examples: `Foo/Sub`, `React-Core`,
    `ExpoModulesCore`, a linked and an unlinked `react-native-x`, `SwiftUIIntrospect`, `MMKV`.
  - The hunk test `scaffold-package-swift.js has the fix 20 hunk` (`classifyPodDependency`), and
    `read-podspec.js has the fix 20 hunk` (`dropSubspecs`).
- [ ] **Step 2: Run** `npx vitest run tests/rn-scaffolder.test.ts` → FAIL.
- [ ] **Step 3: Implement**, sync the two copies (Global Constraints), and write fix 20's upstream entry. The goldens
  do not change (no golden library has a missing sibling).
- [ ] **Step 4: Run** the sync's test list without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "fix: leave out deps that are not installed"`

### Task A2: Fix 21, Swift 5 language mode unless the podspec asks for 6

**Files:** `vendor/rn-spm/spm/read-podspec.js` (`swiftVersions`), `scaffold-package-swift.js` (emitter), both 0.88
patches, the goldens (react-native-pager-view's two manifests), `docs/upstream/react-native-scaffolder.md` (fix 21).
Test: `tests/rn-scaffolder.test.ts`.

**Interfaces:**
```js
// PodspecModel gains swiftVersions: Array<string>. It holds literal `swift_version` / `swift_versions` (string or
// array), `s.ios.` too, from every layer; flattenSubspecs reads `swift_versions` / `swift_version`. A value with `#{`
// or an unresolved identifier is left out.
// The emitter adds `    swiftLanguageModes: [.v5],\n` right before `    cxxLanguageStandard:` when the target has
// Swift sources (mixed or pure Swift) and the highest major in swiftVersions is below 6, or there is none. With 6 or
// higher, nothing is added. Package@swift-6.5.swift gets the same line (it is derived from the same content).
```
- Plan note (row 10, accept): a library that declares Swift 6 but is not Swift 6 clean fails as it would under
  CocoaPods.

- [ ] **Step 1: Write failing tests:**
  - `21: puts a mixed target in the Swift 5 language mode (react-native-video's shape)` → a mixed lib without
    `swift_version` → both manifests have `swiftLanguageModes: [.v5],` on the line before
    `cxxLanguageStandard: .cxx20`;
  - `21: a pure-Swift target too` → tools-version stays `6.0`, and the line is present;
  - `21: keeps Swift 6 when the podspec asks for it` → it.each over `s.swift_version = '6.0'`,
    `s.swift_versions = ['5.9', '6.0']` and `s.ios.swift_version = '6.0'` → no line;
  - `21: reads 5.x as Swift 5` → `s.swift_versions = ['5.0', '5.9']` → line;
  - `21: an interpolated or computed swift_version counts as absent` (row 11) → `s.swift_version = "#{v}"` and
    `s.swift_version = SWIFT_VERSION` (unresolved) → line;
  - `21: no language mode for a target without Swift`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, sync, then regenerate the goldens with a throwaway script, not committed: it writes
  `scaffoldLibraries(VENDORED_RN_SPM, …)` for `GOLDEN_LIBS` from `../app`. Review the diff: only pager-view's
  `swiftLanguageModes` lines change.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "fix: compile scaffolded Swift in Swift 5 mode"`

### Task A3: Fix 22, the umbrella-directory layout

**Files:** `vendor/rn-spm/spm/scaffold-package-swift.js` (`umbrellaNextToSubdirs`, line 913), both 0.88 patches,
`docs/upstream/react-native-scaffolder.md` (fix 22). Test: `tests/rn-scaffolder.test.ts`.

- Rule: the `include/<SwiftName>/` shim of fix 2 is also used when `<publicHeadersPath>/<SwiftName>/<SwiftName>.h`
  exists and the public headers directory holds any other directory. A lone `<SwiftName>/` directory is left as it is.
  The shim is fed and the collision warning is the same as for fix 2.
- Plan note (row 12, accept): fix 2's basename rule is unchanged.

- [ ] **Step 1: Write failing tests:**
  - `22: shims <ph>/<Name>/<Name>.h next to another directory (react-native-device-info's layout)` → files
    `ios/RNDeviceInfo/RNDeviceInfo.h`, `ios/RNDeviceInfo/RNDeviceInfo.m`, `ios/RNDeviceInfo/DeviceUID.h`,
    `ios/RNDeviceInfo.xcodeproj/project.pbxproj`, and `s.source_files = "ios/**/*.{h,m}"` → `publicHeadersPath:
    "include"`, and `include/RNDeviceInfo/` forwards both headers;
  - `22: leaves a lone <Name>/ directory as it is` → without the `.xcodeproj` → `publicHeadersPath: "ios"`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and sync. The goldens do not change; confirm.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "fix: shim the umbrella-directory header layout"`

### Task A4: Fix 23, the codegen header path

**Files:** `vendor/rn-spm/spm/scaffold-package-swift.js` (or, on the fallback, `spm-utils.js`
`buildPerAppHeaderTree`), both 0.88 patches, the goldens (every golden library with `codegenConfig`),
`docs/upstream/react-native-scaffolder.md` (fix 23). Test: `tests/rn-scaffolder.test.ts`.

- [ ] **Step 0 (spike, OQ2; nothing committed).** In the proof app (Task 0), with the worktree's current CLI, let
  `build` scaffold netinfo. Then edit `node_modules/@react-native-community/netinfo/Package.swift` by hand:
  - add `let rnSpmCodegenHeaders = Context.packageDirectory + "/../../../ios/ReactCodegen/RNCNetInfoSpec"` after
    `import PackageDescription`;
  - add `.unsafeFlags(["-I", rnSpmCodegenHeaders])` to `cSettings` and `cxxSettings`;
  - build again.
  - If `RNCNetInfo.mm` compiles, the anchor wins. Otherwise, try the fallback by hand: a `RNCNetInfoSpec.h` that does
    `#import <RNCNetInfoSpec/RNCNetInfoSpec.h>` at the root of the per-app header tree (`ReactAppHeaders`).
  - Record which one compiled, delete `.build` and reset the app.
  - If neither compiles, stop: the owner decides.
- **Interfaces (anchor):**
  ```js
  // For a dep whose package.json has codegenConfig.name X: rel = relFromManifest('build', 'generated', 'ios',
  // 'ReactCodegen', X) (from the libs/<SwiftName> symlink, like codegenPackageDir). The manifest gets
  //   let rnSpmCodegenHeaders = Context.packageDirectory + "/<rel>"
  // in its lets block, and `.unsafeFlags(["-I", rnSpmCodegenHeaders])` in cSettings and cxxSettings.
  ```
  - **Fallback interfaces:** `buildPerAppHeaderTree` writes `<X>.h` at the tree root for each codegen library X, with
    the scaffolder banner and `#import <X/X.h>`. The manifest is unchanged.
- Plan note (row 14, accept): a search path to a missing folder is ignored by clang.

- [ ] **Step 1: Write failing tests** (anchor; on the fallback, the equivalent `spm-utils` tests):
  - `23: puts the library's codegen directory on its C and C++ search paths (netinfo's shape)` → a lib whose
    `package.json` has `codegenConfig.name: "RNCNetInfoSpec"`, scaffolded through `scaffoldLibraries`. The manifest
    holds `let rnSpmCodegenHeaders = Context.packageDirectory + "/../../../ios/ReactCodegen/RNCNetInfoSpec"`, and
    both settings hold the flag;
  - `23: the manifest holds no absolute path` → no string literal in the manifest starts with `/` or contains the
    temp root, and no `"..` path leaves the package except the `rnSpmCodegenHeaders`, `codegenPackageDir` and
    `localXcfwPackageDir` values;
  - `23: nothing without codegenConfig.name`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, sync and regenerate the goldens. Review: only the codegen lines change.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "fix: add the codegen header dir to scaffolds"`

### Task A5: Fix 24, Swift compilation conditions

**Files:** `vendor/rn-spm/spm/read-podspec.js` (`swiftConditions`), `scaffold-package-swift.js` (`swiftSettings` for
mixed and pure-Swift targets), both 0.88 patches, `docs/upstream/react-native-scaffolder.md` (fix 24, which says
vision-camera's location tagging stays off: its switch is a Ruby ternary). Test: `tests/rn-scaffolder.test.ts`.

**Interfaces:**
```js
// PodspecModel gains swiftConditions: Array<string>: the tokens of literal
// 'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '…' entries in any xcconfig hash, from every layer. `$(inherited)` and
// tokens holding `#{` or `$(` are left out, the same rule as for the C defines.
// The emitter adds `.define("<X>")` to swiftSettings for each token: after the bridging-header flag on a mixed target,
// and in a new `swiftSettings:` line on a pure-Swift target. A clang-only target gets nothing.
```

- [ ] **Step 1: Write failing tests:**
  - `24: carries literal Swift compilation conditions into swiftSettings` → `"SWIFT_ACTIVE_COMPILATION_CONDITIONS" =>
    "$(inherited) FOO BAR"` on a mixed and a pure-Swift lib → `.define("FOO")`, `.define("BAR")`;
  - `24: drops interpolated and ternary tokens (vision-camera's shape)` → `"$(inherited) #{enableLocation ?
    "VISION_CAMERA_ENABLE_LOCATION" : ""}"` → no define;
  - `24: none for a clang-only target`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and sync. The goldens do not change; confirm.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "fix: carry Swift compilation conditions"`

### Task A6: Scaffold revision 4

**Files:**
- Modify: `vendor/rn-spm/spm/scaffold-package-swift.js` (`RN_XTOOL_SCAFFOLD_REVISION = 4`, with a comment naming
  fixes 20–24), both 0.88 patches, `src/pipeline/patches.ts` (`SCAFFOLD_REVISION = 4`), the goldens (every
  manifest's revision line), `docs/upstream/react-native-scaffolder.md` (fixes 20–24 "ship with
  `RN_XTOOL_SCAFFOLD_REVISION` 4").
- Test:
  - `tests/rn-scaffolder.test.ts`: line 130 `RN_XTOOL_SCAFFOLD_REVISION = 4`; the revision regexes at 1029, 1042,
    1133, 1234 and 1249 read `4`;
  - `tests/patches.test.ts`: the "now 3" texts at 775–799 read "now 4", and the fixtures that stand for "current" at
    886–967 move from revision 3 to 4. A new case keeps a revision 3 patch as "older".
- Plan note (row 19, accept): every persisted scaffold patch gets the existing warning once; the CHANGELOG says to
  delete and rebuild (Task G1).

- [ ] **Step 1: Write failing tests:**
  - change the expectations above;
  - add `warns about a revision 3 scaffold patch after the bump` → `(revision 3, now 4)`.
- [ ] **Step 2: Run** `npx vitest run tests/rn-scaffolder.test.ts tests/patches.test.ts` → FAIL.
- [ ] **Step 3: Implement**, sync and regenerate the goldens.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches src docs/upstream tests && npm run scan:private && git commit -m "chore: bump the scaffold revision to 4"`

---

## B. Pipeline fixes (PR 1)

### Task B1: The scaffolder takes only the named deps (fix 25)

**Files:** `vendor/rn-spm/spm/scaffold-package-swift.js` (`scaffoldAll`), both 0.88 patches,
`docs/upstream/react-native-scaffolder.md` (fix 25: "scaffoldAll cannot scaffold only the deps the autolinker
reported"; preflight P3). Test: `tests/rn-scaffolder.test.ts`.

**Interfaces:**
```js
// ScaffoldAllOptions gains onlyDeps?: ReadonlyArray<string>, the dual of skipDeps. When set, only those npm names are
// scaffolded (direct or transitive); the others get no result entry and are not touched. skipDeps still wins over it.
```

- [ ] **Step 1: Write failing tests:**
  - `25: onlyDeps scaffolds only the named deps` → two libs without manifests, `onlyDeps: ["a"]`, no `force` →
    results only for `a`; `b` has no `Package.swift`;
  - `25: onlyDeps leaves a named dep's current scaffold alone without force` → `a` with a current scaffold
    (revision, slot) plus a hand comment → status `skipped-scaffolder-marker`, and the comment stays;
  - `25: without onlyDeps every dep, as before`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and sync.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "feat: let the scaffolder take only named deps"`

### Task B2: Scaffold only the libraries React Native names

**Files:**
- Modify:
  - `scripts/rn-spm-generate.js`: `--only` (repeatable), passed as `onlyDeps`, and no `force`;
  - `src/pipeline/rnSpm.ts`: `rnSpmScaffoldArgs` takes the names; Expo SDK 58 scaffolds through the driver with
    `--config-command` set to `AUTOLINKING_CONFIG_COMMAND`. `scaffoldArgv` is removed, since nothing calls RN's
    `setup-apple-spm.js scaffold` any more.
- Test:
  - `tests/rn-spm-generate.test.ts`: line 295's expected `scaffoldAll` options lose `force` and gain `onlyDeps`;
  - `tests/rnSpm.test.ts`:
    - "keeps setup-apple-spm scaffold for the expo kind" is replaced;
    - "scaffolds, persists each lib, then retries" (its `args[1]` check) is updated;
    - the `scaffoldArgv` tests and "passes --yes to add/update and scaffold" are removed.

**Interfaces:**
```ts
export function rnSpmScaffoldArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string; rnScripts: RnScripts; expoPlugin?: ExpoPlugin; kind: ProjectKind },
  names: readonly string[],
  rnDir?: string,
): string[];   // [...generate args, "--scaffold", ...names.flatMap((n) => ["--only", n])]; with kind "expo" and the
               // installed plugin, the generate args carry "--config-command", JSON.stringify(AUTOLINKING_CONFIG_COMMAND)
// rn-spm-generate.js usage line gains `[--only <name>]...`
```
- Plan note (row 15, accept): a library outside the list keeps today's stale handling. Its persisted patch gets
  `scaffoldPatchWarnings`, and an unpersisted copy is removed by `refreshStaleScaffolds`, so React Native names it.
- Plan note (fact 4): the vendored `setup-apple-spm.js:487` keeps `force: true`. rn-xtool no longer calls its
  `scaffold` action, so the 0.88 patches do not need to touch that file.

- [ ] **Step 1: Write failing tests:**
  - rn-spm-generate.test `--scaffold passes --only as onlyDeps and never forces` → `--only lib-a --only lib-b` → the
    `scaffoldAll` options include `onlyDeps: ["lib-a", "lib-b"]` and no `force`;
  - rnSpm.test:
    - `scaffolds only the libraries RN names` → bare, first run reports lib-a and lib-b → the scaffold argv ends with
      `--scaffold --only lib-a --only lib-b`;
    - `scaffolds Expo 58 through the driver with the Expo config command` → kind expo, installed scripts and plugin →
      the scaffold call is `node <pkg>/scripts/rn-spm-generate.js … --scripts-root <rnDir>/scripts --config-command
      ["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"] --scaffold --only lib-a`.
      The first and last runs keep `setup-apple-spm.js add|update`.
- [ ] **Step 2: Run** `npx vitest run tests/rn-spm-generate.test.ts tests/rnSpm.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add scripts src tests && npm run scan:private && git commit -m "fix: scaffold only the libraries RN names"`

### Task B3: The real failure comes first

**Files:** `scripts/rn-spm-generate.js` (`--results <abs>`), `src/pipeline/rnSpm.ts`, `src/paths.ts`
(`scaffoldResults: ios/build/rn-xtool-scaffold-results.json`). Test: `tests/rn-spm-generate.test.ts`,
`tests/rnSpm.test.ts`.

**Interfaces:**
```ts
// The driver writes, whenever scaffoldAll returned:
//   {"results":[{"depName":string,"status":string,"reason"?:string,"warnings"?:string[],"root"?:string}]}
//   (root from autolinking.json). If scaffoldAll throws, no file is written and the exit code is 1, as today.
export interface ScaffoldOutcome { scaffolded: string[]; failed: { name: string; reason: string; warnings: string[] }[] }
export function scaffoldOutcome(paths: ProjectPaths, names: readonly string[]): ScaffoldOutcome | undefined;
//   undefined without a readable results file. A named library counts as scaffolded when <root>/Package.swift exists
//   and carries the scaffolder banner (root from the results, else node_modules/<name>). Otherwise it failed. The
//   reason is the result's `reason`, else "no Package.swift was written".
```
- Text (the error `runRnSpm` throws once the scaffolded libraries are persisted). One block per failed library, blocks
  separated by a blank line:
  ```
  Scaffolding ${name} failed: ${reason}
    ! ${warning}
  ```
  - Without a results file, today's `React Native spm scaffold failed (exit ${code})` text is kept.
- Behaviour: persist only `scaffolded`, then throw when `failed` is not empty. React Native does not run a second
  time.

- [ ] **Step 1: Write failing tests:**
  - rn-spm-generate.test `--scaffold writes the results file` → the file holds lib-a `written` with its warnings,
    lib-b `error` with its reason, and each `root`;
  - rnSpm.test:
    - `stops on a library the scaffolder could not scaffold, with its reason first` (row 17) → a results file with
      lib-a `error` ("react-native spm scaffold: no resolved Swift name for the sibling 'x'. …") and lib-b written
      (with a banner manifest in a temp root) → persist is called for lib-b only, and there is no second React
      Native run. The message starts `Scaffolding lib-a failed: react-native spm scaffold: no resolved Swift name`;
    - `prints the failed library's warnings after its error` (row 8) → `  ! ` lines follow;
    - `a library without a scaffolded Package.swift afterwards failed too` (row 18) → status `written` but no file,
      and status `skipped-self-managed` → reasons `no Package.swift was written` and the scaffolder's reason;
    - `persists nothing for a failed library and never runs React Native again` (row 20);
    - `keeps today's message without a results file`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add scripts src tests && npm run scan:private && git commit -m "fix: report a failed scaffold first"`

### Task B4: Patches for packages that are not installed are skipped

**Files:**
- Modify:
  - `src/pipeline/patches.ts`: `orphanPatches`, staging into `ios-xtool/.project-patches/` only when there is an
    orphan, and `scaffoldPatchWarnings` skips orphans;
  - `src/paths.ts` (`projectPatchesDir`);
  - `src/project/capabilities.ts` (`orphanPatches`);
  - `src/commands/doctor.ts` (a `patches` line per orphan).
- Test: `tests/patches.test.ts`, `tests/doctor.test.ts`, `tests/capabilities.test.ts`

**Interfaces:**
```ts
export function orphanPatches(projectRoot: string): { file: string; pkg: string }[];
//   patches/*.patch whose parsePatchFileName pkg has no node_modules/<pkg>/package.json (the condition patch-package fails on)
export function orphanPatchLine(o: { file: string; pkg: string }): string;
// applyPatches: with orphans, copies the other patches/*.patch to projectPatchesDir, logs one line per orphan, and runs
//   patch-package with `--patch-dir ios-xtool/.project-patches --error-on-fail`; without orphans, argv as today.
// Capabilities gains orphanPatches: string[] (the lines).
```
- Text: `⚠ patches/react-native-device-info+15.0.2.patch is for react-native-device-info, which is not installed; skipped. Delete it if you removed the library.`
- Plan note (row 22, accept): a package installed at another version is not an orphan; patch-package's own warning
  and the slot warning are unchanged.

- [ ] **Step 1: Write failing tests:**
  - patches.test:
    - `skips a patch whose package is not installed, with one warning` → patches for an installed `a` and a missing
      `react-native-device-info` → exec gets `--patch-dir ios-xtool/.project-patches`, the staged dir holds only
      `a`'s patch, and the log holds the exact line;
    - `stages nothing when no patch is orphaned` → argv as today;
    - `reads a scoped package's orphan` → `@scope+pkg+1.0.0.patch`;
    - `gives an orphan scaffold patch the orphan line only` → no revision warning for it;
  - doctor.test `--project names orphan patches` → `{ name: "patches", status: "warn", detail: "patches/… skipped.
    Delete it if you removed the library." }`;
  - capabilities.test: the field.
- [ ] **Step 2: Run** `npx vitest run tests/patches.test.ts tests/doctor.test.ts tests/capabilities.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "fix: skip patches of uninstalled packages"`

### Task B5: Resources that do not reach the app are named

**Files:**
- Create: `src/pipeline/scaffoldResources.ts`.
- Modify:
  - `src/project/podspecs.ts`: `unconditionalLines` moves here from `earlyChecks.ts`, exported, so the leaf module
    stays cycle-free;
  - `src/commands/build.ts`: one `ℹ` line after `rn-spm`.
- Test: `tests/scaffoldResources.test.ts`, `tests/build.test.ts`, `tests/earlyChecks.test.ts` ("module layout" stays
  green).

**Interfaces:**
```ts
export function unbundledResources(projectRoot: string): { pkg: string; items: string[] }[];
//   For each dep in ios/build/generated/autolinking/autolinking.json with an ios platform, whose Package.swift carries
//   the scaffolder banner, sorted by name: the podspec's unconditional `s.resource_bundles` / `s.ios.resource_bundles`
//   (osx/tvos/visionos ignored) and `s.resources`. A bundle whose globs all end in .xcprivacy is named by the file
//   basename; any other bundle is named "<key>.bundle", and a plain resource by its basename.
export function unbundledResourcesLine(list: { pkg: string; items: string[] }[]): string | undefined;
```
- Text: `ℹ Not copied into the app: @react-native-async-storage/async-storage (PrivacyInfo.xcprivacy), react-native-svg (RNSVGFilters.bundle). Development builds run without them; privacy manifests are read only at App Store submission.`

- [ ] **Step 1: Write failing tests:**
  - `names each scaffolded library's resources not copied into the app` → async-storage's shape
    (`s.resource_bundles = { "RNCAsyncStorage_resources" => "ios/PrivacyInfo.xcprivacy" }`) and svg's
    (`s.osx.resource_bundles` and `s.ios.resource_bundles = {'RNSVGFilters' => ['apple/**/*.iphoneos.metallib']}`),
    both with banner manifests → the exact line;
  - `leaves out libraries with their own Package.swift and resources under a Ruby condition`;
  - build.test `prints the resource line once, after rn-spm`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: name resources not copied into the app"`

---

### Task F1: Build-only proof for PR 1 (controller)

No commit. In `<scratchpad>/libcompat-proof/app`, reset to `base` (Task 0), after `npm run build` in the worktree.

**Run 2026-11-04, build-only: pass.**
- F1, on a fresh React Native 0.88.1 app with the four libraries: every step passed. Step 3 re-scaffolded netinfo
  instead of installing react-native-linear-gradient.
- F1b, the Expo SDK 58 driver route (expo 58.0.23, React Native 0.88.1) with react-native-device-info 15.0.2: pass.
  Only device-info was scaffolded, and `App.app` was built.

- [x] **Step 1.** `doctor --project` shows no refusal.
- [x] **Step 2 (rows 8, 9, 13).** `build` produces `ios-xtool/xtool/App.app`.
  - `llvm-nm` on the app binary finds `CameraView`, `RCTVideo`, `RNDeviceInfo` and `RNCNetInfo`.
  - vision-camera's warning names the `FrameProcessors` subspec.
  - The `ℹ Not copied into the app:` line appears and names device-info.
  - Record `.build`'s size, then delete it.
- [x] **Step 3 (fact 7's regression; row 15).**
  - Add a comment line to `node_modules/react-native-device-info/Package.swift`, and persist it with the project's
    patch-package (`npx patch-package react-native-device-info --patch-dir patches --exclude
    '(^|/)\.build/|^package\.json$'`).
  - Install react-native-linear-gradient. **This needs the owner's OK: it is not in the approved list.**
  - Build. rn-xtool announces `generating Package.swift for: react-native-linear-gradient`, and the driver prints
    `Scaffolded Package.swift for 1 dep(s)`.
  - The comment is still in device-info's `Package.swift`. Delete `.build`.
- [x] **Step 4 (row 21).** `npm uninstall react-native-device-info`, then build. The orphan line appears, and the
  build succeeds. Delete `.build` and reset the app.
- [x] **Step 5.** Record versions, timings and `.build` sizes for the PR 1 body. A failure goes to the owner as a
  decision, and PR 1 waits.

### Task G1: Docs and CHANGELOG for PR 1

**Files:**
- `docs/troubleshooting.md`, `## Build and patches`:
  - the scaffold-failure message (Task B3) quoted, with "the first line is the real cause";
  - the orphan-patch line (Task B4);
  - "a scaffold run regenerates only the libraries React Native reports; to re-render a library after editing its
    podspec, delete its `Package.swift` and its `patches/` file, then build" (row 16);
  - the `ℹ Not copied into the app` line in the present tense.
- `docs/libraries.md`:
  - rows for vision-camera 4.7.3, video 6.19.3, device-info 15.0.2 and netinfo 11.5.2. The Bare 0.88 column reads
    "✅ build only, 2026-11-xx (React Native 0.88.1)" until Task H;
  - the notes say what is left out: frame processors without react-native-worklets-core, and vision-camera's
    location tagging (fix 24, a Ruby ternary);
  - the svg row's resource-bundle sentence becomes present-tense behaviour.
- `docs/how-it-works.md`: the scaffold step scaffolds only what React Native names, and stops on the first failed
  library.
- `docs/RELEASING.md` gains a "Scaffolder changes" item:
  - a change to scaffold output bumps `RN_XTOOL_SCAFFOLD_REVISION` and `SCAFFOLD_REVISION` together;
  - both 0.88 patches stay byte-identical, and `vendor/rn-spm` is re-derived from them;
  - the tarball-backed tests must run, not skip (preflight P11).
- `CHANGELOG.md` `[Unreleased]`:
  - Fixed: the four libraries; a scaffold run no longer rewrites other libraries; the real scaffold failure first;
    orphan patches.
  - Added: the resources line.
  - Upgrading: persisted scaffold patches from revision 3 get a warning; delete them and build (row 19).
- Test: `tests/docsLinks.test.ts` (unchanged, stays green).

- [ ] **Step 1: Write** the docs. Every quoted message is copied from Tasks A1–B5.
- [ ] **Step 2: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && npm run scan:private && git commit -m "docs: document the scaffolder and patch fixes"`

**PR 1 cut** (controller with the owner; see Global Constraints, "PR slicing").

---

## C. Third-party pods (PR 2)

### Task C1: The scaffolder reads its pod table from a file

**Files:** `vendor/rn-spm/spm/scaffold-package-swift.js`, both 0.88 patches, the goldens (pager-view gets the
`rn-xtool-pods` line), `docs/upstream/react-native-scaffolder.md` (fix 13's entry gains the shape and the file).
Test: `tests/rn-scaffolder.test.ts` (the SwiftUIIntrospect test at 986 expects `products`).

**Interfaces:**
```js
// KNOWN_POD_SPM_PACKAGES (the baseline; SwiftUIIntrospect only), in the new shape:
//   {url: string, exact: string, products: Array<string>, subspecs?: {[name: string]: Array<string>},
//    forwardHeaders?: {[header: string]: Array<string>}}; `product: string` is still read as products [product].
// loadPodTable(): the baseline, with the `pods` object of the JSON file named by process.env.RN_SPM_POD_TABLE merged
//   over it (per pod, the file's entry wins). Without the variable: the baseline. An unreadable file or a bad shape
//   throws `react-native spm scaffold: cannot read the pod table ${file}: ${reason}`, which becomes that library's
//   error result.
// classifyPodDependency(..., table) → 'mapped' with products = entry.subspecs?.[sub] ?? entry.products.
// externalPackages: {pod, url, exact, products, package}; one `.product(name:package:)` per product.
// Marker, only when the manifest pins at least one pod, on the line after the importer-paths line (or after the
// revision line when there is none):
//   // rn-xtool-pods: AppAuth=3.0.0, SwiftUIIntrospect=1.5.0      (sorted by pod)
// module.exports gains KNOWN_POD_SPM_PACKAGES and loadPodTable.
```
- Plan note (row 4, accept): the core prefixes (`RCT`, `React-`, …) stay as they are.

- [ ] **Step 1: Write failing tests:**
  - `13: reads the pod table file named by RN_SPM_POD_TABLE over the built-in one` → a file with `AppAuth` →
    `.package(url: "https://github.com/openid/AppAuth-iOS", exact: "3.0.0")` and
    `.product(name: "AppAuth", package: "appauth-ios")`;
  - `13: maps a pod subspec to its products` → `GoogleUtilities/Logger` with `subspecs: { Logger: ["GULLogger"] }`;
  - `13: still reads an entry with one product` (the existing SwiftUIIntrospect test, adapted);
  - `13: records the pinned pods on the rn-xtool-pods line`;
  - `13: an unreadable pod table is the library's error, naming the file`;
  - `13: without the variable, the built-in table`;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, sync and regenerate the goldens (pager-view's marker line).
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "feat: read the pod table from a file"`

### Task C2: Forward a pod's umbrella header

**Files:** `vendor/rn-spm/spm/scaffold-package-swift.js`, both 0.88 patches, `tests/support/rnScaffold.ts`
(`SCAFFOLD_OUTPUTS` gains `rn-spm-pod-headers`), `docs/upstream/react-native-scaffolder.md`. Test:
`tests/rn-scaffolder.test.ts`, `tests/patches.test.ts`.

**Interfaces:**
```js
// For each forwardHeaders entry of a mapped pod, the scaffolder writes <dep>/rn-spm-pod-headers/<header>:
//   // AUTO-SCAFFOLDED by react-native spm scaffold — forwards <AppAuth/AppAuth.h> to the SwiftPM modules of the pod AppAuth.
//   @import AppAuthCore;
//   @import AppAuth;
// and adds .headerSearchPath("rn-spm-pod-headers") to cSettings and cxxSettings. A header key must be relative, end in
// .h and hold no `..` segment; otherwise that library gets an error result naming the key. A scaffold without
// forwarders removes a stale rn-spm-pod-headers/ of its own (banner check).
```
- The banner on the first line keeps `refreshStaleScaffolds`' "every entry is a new scaffolded file" rule true for a
  patch that holds forwarders.

- [ ] **Step 1: Write failing tests:**
  - `13: writes a forwarding header for each forwardHeaders entry (AppAuth's shape)` → `s.dependency 'AppAuth', '>=
    1.7.6'` and a table with `forwardHeaders: { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] }` → the file's text
    as above, and both settings hold the search path;
  - `13: the forwarder holds no absolute path`;
  - `13: removes its stale rn-spm-pod-headers on a scaffold without forwarders`;
  - `13: refuses a header key that leaves the folder` → `../x.h` and `/abs.h`;
  - patches.test `replaces a stale copy whose patch also holds a forwarder` → the patch's entries are a
    `Package.swift` and `rn-spm-pod-headers/AppAuth/AppAuth.h`, both new and both with the banner → the copy is
    replaced, as for a manifest-only patch;
  - the hunk test.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and sync. The goldens do not change.
- [ ] **Step 4: Run** the sync's tests without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "feat: forward pod umbrella headers"`

### Task C3: `pods` in rn-xtool.config.json

**Files:** `src/config.ts` (`PodEntry`, `pods`, `checkPods` for the JSON and JS configs). Test: `tests/config.test.ts`.

**Interfaces:**
```ts
export interface PodEntry {
  url: string; exact: string; products?: string[]; product?: string;
  subspecs?: Record<string, string[]>; forwardHeaders?: Record<string, string[]>;
}
// ExpoXtoolConfig gains pods?: Record<string, PodEntry>
export function checkPodEntries(file: string, pods: unknown): void;   // also used on data/pods.json (Task C4)
```
- Texts (`ConfigError`, `${file}` is `rn-xtool.config.json` or `rn-xtool.config.js`):
  - `${file}: pods must be an object of CocoaPods pod names`
  - `${file}: pods.${pod} must be a CocoaPods pod name (no "/", spaces or quotes)` (`pods.""` for an empty name)
  - `${file}: pods.${pod}.url must be a git URL (https://…)`
  - `${file}: pods.${pod}.exact must be a version such as 3.0.0`
  - `${file}: pods.${pod}.products must be a list of product names` (also when neither `products` nor `product` is set)
  - `${file}: pods.${pod}.subspecs must be an object of subspec names`
  - `${file}: pods.${pod}.subspecs.${name} must be a list of product names`
  - `${file}: pods.${pod}.forwardHeaders must be an object of header paths`
  - `${file}: pods.${pod}.forwardHeaders.${header} must be a list of module names, under a relative path ending in .h`
- Plan note (row 2, accept): a well-formed but wrong URL or product is caught by SwiftPM at `xtool-build`, and its
  message names it.

- [ ] **Step 1: Write failing tests:** `reads pods`, and `names a pods entry of the wrong shape` (it.each over each
  text above, row 1).
- [ ] **Step 2: Run** `npx vitest run tests/config.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: read pods from rn-xtool.config.json"`

### Task C4: Ship AppAuth and hand the merged table to the scaffolder

**Files:**
- Create:
  - `data/pods.json`: `{ "pods": { "AppAuth": { "url": "https://github.com/openid/AppAuth-iOS", "exact": "3.0.0",
    "products": ["AppAuth"], "forwardHeaders": { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] } } } }`;
  - `src/project/podTable.ts`.
- Modify:
  - `package.json` (`files` gains `data`);
  - `src/pipeline/rnSpm.ts` (`rnSpmEnv` gains the table; `runRnSpm` writes the file and takes `pods`);
  - `src/commands/build.ts` (passes `config.pods`);
  - `docs/RELEASING.md` item 4 lists `data/`.
- Test: `tests/podTable.test.ts`, `tests/rnSpm.test.ts` (the env assertions at 288–290 and 334–347 gain
  `RN_SPM_POD_TABLE`), `tests/build.test.ts`.

**Interfaces:**
```ts
export type PodSource = "scaffolder" | "rn-xtool" | "config";
export interface PodTable { pods: Record<string, PodEntry>; source: Record<string, PodSource> }
export function mergedPodTable(configPods?: Record<string, PodEntry>): PodTable;
//   the vendored scaffolder's KNOWN_POD_SPM_PACKAGES, then data/pods.json, then the config; per pod, the later wins
export function writePodTable(paths: ProjectPaths, table: PodTable): string;   // ios/build/rn-xtool-pods.json; returns the path
export const POD_TABLE_ENV = "RN_SPM_POD_TABLE";
// rnSpmEnv(paths, expoPlugin, podTableFile?: string): adds { RN_SPM_POD_TABLE: podTableFile } when given
```

- [ ] **Step 1: Write failing tests:**
  - `the shipped table passes the config's shape check`;
  - `merges the config over rn-xtool's table over the scaffolder's` (sources recorded);
  - rnSpm `passes the pod table file to every React Native run`;
  - `package.json ships data/`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add data package.json src docs/RELEASING.md tests && npm run scan:private && git commit -m "feat: pass the pod table to the scaffolder"`

### Task C5: Refuse an unmapped pod early, offline

**Files:**
- Modify:
  - `src/project/podspecs.ts`: `podDependencies` reads name and requirement from the unconditional lines;
  - `src/project/earlyChecks.ts`: `"unmapped-pod"`, options, and the classifier from
    `vendor/rn-spm/spm/scaffold-package-swift.js`;
  - `src/project/capabilities.ts` and `src/commands/build.ts`: pass `{ pods, exclude }`;
  - `docs/troubleshooting.md`: a minimal `### Libraries that depend on CocoaPods pods` heading under
    `## Unsupported setups`, filled in Task G2, so `tests/docsLinks.test.ts` stays green.
- Test: `tests/earlyChecks.test.ts`, `tests/build.test.ts`, `tests/capabilities.test.ts`

**Interfaces:**
```ts
export function podDependencies(lines: readonly string[]): { name: string; requirements: string[] }[];
//   `<recv>.(ios.)?dependency 'Name'[, 'req'...]` on the given (unconditional) lines; items trimmed
export type EarlyCheckId = … | "unmapped-pod";
export interface LibraryCheckOptions { pods?: Record<string, PodEntry>; exclude?: readonly string[]; table?: PodTable }
export function libraryFailures(projectRoot: string, opts?: LibraryCheckOptions): EarlyFailure[];
export function earlyFailures(root: string, opts?: LookupOptions & LibraryCheckOptions): EarlyFailure[];
//   For a library rn-xtool would scaffold (the binaries check's filter), each dependency goes through
//   classifyPodDependency with:
//   - podToNpm built from every direct dependency's podspec basenames;
//   - linkedNpm = the direct dependencies with a podspec or a Package.swift, minus the iOS-excluded ones (Task D3
//     adds the config's exclude);
//   - the table from mergedPodTable(opts.pods).
//   'unmapped' pods (root names, first-seen order) make one failure per library, allowKey the package name.
```
- Text, one unmapped pod (verbatim; the docs link is `troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")`):
  `react-native-app-auth 8.5.1: its podspec depends on the CocoaPods pod AppAuth, which has no SwiftPM package rn-xtool knows. Add one under "pods" in rn-xtool.config.json: { "pods": { "AppAuth": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, or leave the library out with "exclude". See ${link}`
  - Several: `… depends on the CocoaPods pods GoogleMLKit and GoogleToolboxForMac, which have no SwiftPM package
    rn-xtool knows. Add them under "pods" …`. The snippet names the first one.
  - Then the usual `knownLimitHint` line.
- Plan note (row 7, accept): with `knownLimits.allow`, the build goes on and fails at compile time as today. The
  allowed-limit text already says so.

- [ ] **Step 1: Write failing tests** (`describe("unmapped pods")`):
  - `refuses AppAuth's shape without a table entry` → `s.dependency 'AppAuth', '>= 1.7.6'`, checked against a table
    without AppAuth (the test seam `opts.table?: PodTable`, which replaces `mergedPodTable(opts.pods)`) → the exact
    text (row 5);
  - `lets AppAuth through with rn-xtool's table`;
  - `refuses ML Kit's shape, naming GoogleMLKit once` → `s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'` and
    four `GoogleMLKit/TextRecognition<Lang>` lines (row 5);
  - `names several unmapped pods`;
  - `ignores pods under a Ruby condition (react-native-video's shape)` → `if defined?($RNVideoUseGoogleIMA)` around
    `ss.ios.dependency 'GoogleAds-IMA-iOS-SDK', '~> 3.22.1'` (row 6);
  - `does not refuse siblings, core, Expo or subspec dependencies` → `react-native-missing`, `RNWorklets` of an
    installed but iOS-excluded package, `React-Core`, `ExpoModulesCore` and `Self/Sub`;
  - `knownLimits.allow turns it into a warning` (row 7);
  - `skips libraries with their own Package.swift or swiftpmConfig.scaffold false`;
  - `loads only rn-xtool's vendored scaffolder` → a spy on `Module._load` sees no path under the project;
  - build.test `stops on an unmapped pod before anything changes` → no prebuild, patches or rn-spm call.
- [ ] **Step 2: Run** `npx vitest run tests/earlyChecks.test.ts tests/build.test.ts tests/capabilities.test.ts` → FAIL.
- [ ] **Step 3: Implement**, with the troubleshooting heading.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src docs/troubleshooting.md tests && npm run scan:private && git commit -m "feat: refuse unmapped CocoaPods pods early"`

### Task C6: Warn when a pin misses the podspec's requirement

**Files:** `src/project/podTable.ts` (`podRequirementSatisfied`, `podPinWarnings`), `src/project/capabilities.ts`,
`src/commands/doctor.ts` (a `pods` line), `src/commands/build.ts` (lines after the early checks). Test:
`tests/podTable.test.ts`, `tests/doctor.test.ts`, `tests/build.test.ts`.

**Interfaces:**
```ts
export function podRequirementSatisfied(version: string, requirements: readonly string[]): boolean;
//   `= x`, a bare `x`, `>`, `>=`, `<`, `<=`, and `~> a.b` (>= a.b, < (a+1)) or `~> a.b.c` (>= a.b.c, < a.(b+1)); all
//   must hold. Segments compare numerically, a missing segment counts as 0.
export function podPinWarnings(projectRoot: string, table: PodTable, opts?: LibraryCheckOptions): string[];
```
- Text: `⚠ AppAuth 3.0.0 (rn-xtool table) is outside react-native-app-auth's requirement ">= 4.0"`. The source reads
  `rn-xtool.config.json` when the config pins it. Several requirements are joined with `, `.

- [ ] **Step 1: Write failing tests:**
  - matcher it.each (`3.0.0` against `>= 1.7.6` true, `~> 1.0` false, `~> 1.5.0` / `1.5.9` true / `1.6.0` false,
    `= 3.0.0`, `> 3`, `< 3`, `<= 3.0`, `>= 1.0, < 2.0` with spaces);
  - `warns when the pinned version misses the podspec's requirement` (row 3) → doctor
    `{ name: "pods", status: "warn" }` and the build log, each with the exact text;
  - `prints nothing when the requirement holds or the library is excluded`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: warn when a pod pin misses its range"`

### Task C7: Stale pins in persisted scaffolds

**Files:** `src/pipeline/patches.ts` (`scaffoldPatchWarnings(root, table?)`, `refreshStaleScaffolds`, and
`applyPatches` options gain `podTable`), `src/commands/build.ts`. Test: `tests/patches.test.ts`.

- Text: `⚠ patches/${name} pins ${pod} ${pinned}, the ${config | rn-xtool table} says ${now}; delete it so rn-xtool regenerates it (also remove node_modules/${pkg} and reinstall: that copy still has the old Package.swift)`.
  - `config` reads `the config says`, and the shipped table reads `rn-xtool's table says`.
- An unpersisted copy whose `// rn-xtool-pods:` line differs from the table is removed with the existing `ℹ … rn-xtool
  removed it so the rn-spm step scaffolds it again` line, the same rule as an older revision (preflight P10).
- A manifest without the line (pins nothing recorded) whose library's podspec maps a pod gets the "does not pin" warning
  (row 48, C1–C4 review M2); a library whose podspec maps no pod gets none. The expected pins skip a subspec the
  scaffolder drops for a missing sibling (row 51).

- [ ] **Step 1: Write failing tests:**
  - `warns when a persisted scaffold pins another version than the table` (row 23);
  - `names the config when the config pins it`;
  - `stays quiet when the pins match or the patch pins nothing`;
  - `regenerates an unpersisted copy whose pins differ`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: warn about stale pod pins in patches"`

### Task C8: The Expo bridging header reaches Swift

**Files:** `src/generate/iosXtool.ts` (the Expo branch of `writeAppSources`), with `openPbxproj` and `resolveSetting`
from `src/project/pbxproj.ts`. Test: `tests/generate.test.ts`, with an Expo pbxproj fixture holding
`SWIFT_OBJC_BRIDGING_HEADER = "LibApp/LibApp-Bridging-Header.h"`.

- Rule:
  - The Expo branch reads `SWIFT_OBJC_BRIDGING_HEADER` from `ios/` (Debug) and resolves it against `ios/`.
  - When the header holds anything besides comments and blank lines, it is copied to `Sources/App/<basename>`, and
    `app.bridgingHeader` is set to the copy.
  - A comment-only header (the prebuild default) is not passed, so the manifest is unchanged (preflight P7).
- Text: `SWIFT_OBJC_BRIDGING_HEADER in ios/${xcodeproj} names ${rel}, which does not exist. Run rn-xtool build --clean to run expo prebuild again.`

- [ ] **Step 1: Write failing tests:**
  - `passes the Expo prebuild's bridging header to Swift` → a header with `#import
    "RNAppAuthAuthorizationFlowManager.h"` → it is copied, and the manifest has `-import-objc-header` with the copy
    (row 27, unit part);
  - `keeps the manifest byte-identical for a comment-only header`;
  - `names a missing bridging header`.
- [ ] **Step 2: Run** `npx vitest run tests/generate.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: pass the Expo bridging header to Swift"`

---

## D. Leaving a native module out

### Task D1: `exclude` in rn-xtool.config.json

**Files:** `src/config.ts`. Test: `tests/config.test.ts`.
- `ExpoXtoolConfig.exclude?: string[]`.
- Text: `${file}: exclude must be a list of package names`.

- [ ] **Step 1: Write failing tests:** `reads exclude`, and `names an exclude of the wrong shape` (it.each:
  string, number list, empty string; row 1).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: read exclude from rn-xtool.config.json"`

### Task D2: The config-command filter

**Files:**
- Create: `scripts/exclude-config-command.js` (CommonJS; `scripts/package.json` already sets the type).
- Modify:
  - `package.json` `files`;
  - `src/pipeline/rnSpm.ts`: `configCommandFor`, used by the driver on bare (a new `--config-command`) and on Expo
    SDK 57, and by Expo SDK 58's `add|update` and scaffold argv;
  - `src/commands/build.ts`: passes `config.exclude`.
- Test: `tests/excludeConfigCommand.test.ts`, `tests/rnSpm.test.ts`

**Interfaces:**
```ts
// node scripts/exclude-config-command.js --exclude '<json array>' -- <cmd> [args...]
//   Runs the command (cwd inherited). A non-zero exit passes its stderr and exit code through. Otherwise it parses
//   stdout as JSON, sets dependencies[<name>].platforms.ios = null for each excluded name present, and prints the
//   JSON.
export function configCommandFor(
  root: string, kind: ProjectKind, exclude: readonly string[],
): string[] | undefined;
//   inner: AUTOLINKING_CONFIG_COMMAND for expo, else the vendored resolveDefaultConfigCommand(root). With exclude
//   empty: inner for expo, undefined for bare (today's argv). Otherwise:
//   [process.execPath, <pkg>/scripts/exclude-config-command.js, "--exclude", JSON.stringify(exclude), "--", ...inner].
```
- Plan note: on Expo SDK 58, `setup-apple-spm.js add` records the explicit command in `ios/<app>.xcodeproj/
  .spm-injected.json`. rn-xtool always passes it explicitly, so the record is never used by rn-xtool (preflight P16).

- [ ] **Step 0 (spike, row 30; nothing committed).** In the proof app, set `platforms: { ios: null }` for netinfo
  in a scratch `react-native.config.js`, which is what the filter produces. Keep netinfo's guarded import in
  `App.tsx` and build.
  - If codegen still generates `RNCNetInfoSpec` and the build fails on it, stop and report to the controller. Row 30's
    other branch (the filter also feeds codegen's exclusion) then becomes a decision with its own task.
  - Record the result, delete `.build` and reset the app.
- [ ] **Step 1: Write failing tests:**
  - `sets platforms.ios to null for each excluded package` (inner: `node -e` printing a fixture JSON);
  - `leaves other packages and unknown names alone`;
  - `passes the inner command's failure through`;
  - rnSpm `wraps the config command when exclude is set, on bare and Expo` (all four argv sites);
  - `leaves every argv unchanged without exclude`;
  - `package.json ships the filter`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add scripts package.json src tests && npm run scan:private && git commit -m "feat: leave excluded modules out of autolinking"`

### Task D3: Report excluded modules, and let the checks skip them

**Files:**
- Modify:
  - `src/project/earlyChecks.ts`: `iosExcluded` also honours the config's `exclude`, so the binaries, vendored-C and
    unmapped-pod checks skip those packages;
  - `src/project/capabilities.ts`;
  - `src/commands/doctor.ts`: an `exclude` line per entry;
  - `src/commands/build.ts`: the lines at the start;
  - `docs/troubleshooting.md`: a minimal `### Leaving a module out` heading, filled in Task G2.
- Test: `tests/earlyChecks.test.ts`, `tests/doctor.test.ts`, `tests/build.test.ts`

**Interfaces:**
```ts
export function excludeLines(projectRoot: string, exclude: readonly string[], opts?: { kind?: ProjectKind; file?: string }): string[];
//   A name is a native iOS dependency when autolinking links it (bare: package.json's dependencies, devDependencies and
//   peerDependencies; Expo: every installed package too; D/E review M3) and it has a podspec or a Package.swift (in the
//   package root or ios/), and no expo-module.config.json naming apple/ios. An Expo module gets the Expo warning; other
//   names get the "not a native iOS dependency" warning; the rest are joined into the ℹ line, which names the config
//   file `exclude` was read from (`file`: rn-xtool.config.json or rn-xtool.config.js).
```
- Texts:
  - `ℹ exclude — left out of this iOS build: react-native-vision-camera (rn-xtool.config.json). JavaScript that uses it must check that it is there; see ${troubleshootingUrl("leaving-a-module-out")}`
  - `⚠ exclude names ${x}, which is not a native iOS dependency of this project; ignored`
  - `⚠ exclude names ${x}, an Expo module: Expo's autolinking links it anyway; list it in expo.autolinking.exclude in package.json to leave it out` (OQ3)

- [ ] **Step 1: Write failing tests:**
  - `prints the ℹ line for an excluded native dependency` (row 31);
  - `warns about a name that is not a native iOS dependency` (row 28);
  - `warns that an Expo module needs expo.autolinking.exclude` (row 32);
  - `an excluded library is not refused` (binaries and unmapped-pod);
  - doctor and build tests for the lines.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src docs/troubleshooting.md tests && npm run scan:private && git commit -m "feat: report excluded modules"`

---

## E. Entitlements

### Task E1: Read xtool 1.24.0's entitlement source (controller)

No commit. The local checkout `../xtool` (952a7ff, no tags) is not modified. Fetch the tag's files read-only, a few
KB, into `<scratchpad>/xtool-1.24.0/`:
```sh
B=https://raw.githubusercontent.com/xtool-org/xtool/1.24.0
for f in Sources/XKit/Model/Entitlements/EntitlementTypes.swift \
  "Sources/XKit/DeveloperServices/App%20IDs/Entitlements/DeveloperServicesCapability.swift" \
  "Sources/XKit/DeveloperServices/App%20IDs/DeveloperServicesAddAppOperation.swift" \
  "Sources/XKit/DeveloperServices/App%20IDs/Entitlements/EntitlementWithTeamOrBundleID.swift" \
  Sources/PackLib/PackSchema.swift Sources/XToolSupport/DevCommand.swift; do
  curl -fsSL "$B/$f" -o "<scratchpad>/xtool-1.24.0/$(basename "${f//%20/ }")"; done
```
- [ ] **Step 1.** Record:
  - `EntitlementContainer.supportedTypes`, with each type's key;
  - each capability's `isFree`;
  - the free-team filter;
  - whether `tooManyAppGroups` exists, and its message;
  - the identifier rewrite;
  - `entitlementsPath` in `PackSchema`;
  - "Applying entitlements..." in `DevCommand`.
- [ ] **Step 2.** If App Groups is paid there, or `tooManyAppGroups` is missing:
  - Task E5 and the several-groups line are dropped;
  - App Groups get the generic paid line;
  - the owner is told that row 37 changes (preflight P1).

  Otherwise Tasks E4 and E5 run as written.

### Task E2: The entitlement table

**Files:** Create `src/project/entitlementTable.ts`. Test: `tests/entitlementTable.test.ts`.

**Interfaces:**
```ts
export const ENTITLEMENTS_CHECKED_WITH = "1.24.0";
export interface EntitlementInfo {
  xtool: "free" | "paid" | "unknown";   // from E1: in supportedTypes, and its capability's isFree; absent: "unknown"
  appleFree: boolean;                    // Apple's "Supported capabilities (iOS)" free column (spec fact 24)
  phrase?: string;                       // "push notifications fail at runtime"
}
export const ENTITLEMENT_TABLE: Readonly<Record<string, EntitlementInfo>>;
export const GENERIC_PHRASE = "the feature that needs it does not work at runtime";
```
- Contents:
  - every key E1 lists, with its flag;
  - at least the keys of spec fact 25: `com.apple.developer.networking.wifi-info`,
    `com.apple.developer.networking.HotspotConfiguration`, `keychain-access-groups`,
    `com.apple.developer.device-information.user-assigned-device-name` and `aps-environment`;
  - plus `com.apple.developer.associated-domains`, `com.apple.developer.default-data-protection`,
    `com.apple.developer.nfc.readersession.formats`, `com.apple.developer.icloud-services` and
    `com.apple.developer.networking.networkextension`.
- The phrases are the builder's wording (spec, "Left to the builder").

- [ ] **Step 1: Write failing tests:**
  - `the table was checked with the pinned xtool` (row 39) → `expect(ENTITLEMENTS_CHECKED_WITH, "xtool changed:
    re-read supportedTypes, isFree and the free filter at the new tag (plan Task E1)").toBe(XTOOL_VERSION)`;
  - `holds every type xtool 1.24.0 decodes, with its flag` (the list from E1, verbatim);
  - `holds the work app's keys`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: add the entitlement table for xtool 1.24.0"`

### Task E3: Read the app's entitlements and pass them to xtool

**Files:**
- Create: `src/project/entitlements.ts`.
- Modify:
  - `src/generate/xtoolYml.ts`: `entitlementsPath`, after `infoPath`;
  - `src/generate/iosXtool.ts`: writes `ios-xtool/App.entitlements`, and removes a stale one when the setting is
    gone.
- Test: `tests/entitlements.test.ts`, `tests/generate.test.ts`

**Interfaces:**
```ts
export class EntitlementsError extends Error {}
export interface AppEntitlements { file: string; rel: string; dict: Record<string, unknown> }
export function readEntitlements(project: ProjectInfo, iosDir: string): AppEntitlements | undefined;
//   CODE_SIGN_ENTITLEMENTS of the app target's Debug configuration (resolveSetting; on Expo, the prebuild's pbxproj
//   in ios/). The path resolves against ios/. Plist values `$(PRODUCT_BUNDLE_IDENTIFIER)` and other build settings
//   are resolved from the pbxproj; `$(AppIdentifierPrefix)` and `$(TeamIdentifierPrefix)` are kept, since xtool
//   rewrites them. Unset: undefined.
// XtoolYmlInput gains entitlementsPath?: string; rendered as `entitlementsPath: App.entitlements`.
```
- Texts (`EntitlementsError`; refusals, not `knownLimits`):
  - `CODE_SIGN_ENTITLEMENTS names ${rel}, which does not exist; xtool cannot sign the app without it. Fix the setting or create the file.`
  - `${rel} (CODE_SIGN_ENTITLEMENTS) is not a property list dictionary; xtool cannot sign the app with it.`
- Plan note (row 34, accept): only the Debug file is read; rn-xtool builds Debug.

- [ ] **Step 1: Write failing tests:**
  - `pins xtool.yml with entitlementsPath` (the exact line; xtool #353);
  - `writes App.entitlements from CODE_SIGN_ENTITLEMENTS (bare)`;
  - `reads the Debug configuration's file` (row 34);
  - `reads the Expo prebuild's entitlements`;
  - `resolves $(PRODUCT_BUNDLE_IDENTIFIER) and keeps $(AppIdentifierPrefix)`;
  - `without the setting: no file and no key, and a stale file goes`;
  - `refuses a missing entitlements file` and `refuses a file that is not a dictionary` (row 33).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: pass the app's entitlements to xtool"`

### Task E4: Check the entitlements before the build

**Files:**
- Modify:
  - `src/project/entitlements.ts` (`entitlementLines`);
  - `src/project/capabilities.ts`;
  - `src/commands/doctor.ts`: an `entitlements` line;
  - `src/commands/build.ts`: lines and refusal after the early checks on bare, and right after `prebuild` on Expo;
  - `docs/troubleshooting.md`: a minimal `## Entitlements` heading.
- Test: `tests/entitlements.test.ts`, `tests/doctor.test.ts`, `tests/build.test.ts`

**Interfaces:**
```ts
export function entitlementLines(e: AppEntitlements, bundleId: string): string[];   // in key order
// doctor: one warn line per entitlementLines entry. With a file and no line: ok `${rel}: passed to xtool; every key is
//   one xtool signs on a free team`. On Expo without ios/: info `read after expo prebuild, at build` (preflight P8).
//   Unset: no line.
```
- Lines (verbatim; `${phrase}` from the table, else `GENERIC_PHRASE`):
  - known to xtool and paid: `⚠ aps-environment is not available on a free team; the build continues without it; push notifications fail at runtime.`
  - unknown to xtool, not free for Apple: `⚠ com.apple.developer.networking.wifi-info is not available on a free team, and xtool does not enable it on a paid one; the build continues without it; reading the Wi-Fi network name returns nothing at runtime.`
  - free for Apple, unknown to xtool: `⚠ com.apple.developer.default-data-protection is not enabled by xtool; the build continues without it; files keep the default protection.`
  - shared keychain groups (an entry other than `$(AppIdentifierPrefix)${bundleId}`): `⚠ keychain-access-groups lists other groups; xtool signs the app with its own group only (<Team ID>.XTL-<Team ID>.${bundleId}); the build continues; sharing keychain items with other apps fails at runtime.`
  - several App Groups (only if E1 confirms `tooManyAppGroups` and free App Groups): `⚠ com.apple.security.application-groups lists ${n} groups; a free team allows one, and xtool stops at signing with more than one.`
  - known to xtool and free: nothing.

- [ ] **Step 1: Write failing tests:**
  - it.each over each line above (rows 35, 36, 38, and 37 per E1);
  - `prints nothing for keys xtool signs on a free team`;
  - `uses the generic phrase for a key without one`;
  - doctor `entitlements` lines;
  - build `prints the entitlement lines before compiling and stops on a missing file`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src docs/troubleshooting.md tests && npm run scan:private && git commit -m "feat: check entitlements before the build"`

### Task E5: Explain xtool's App Group limit (only if Task E1 finds `tooManyAppGroups`)

**Files:** `src/tools/xtoolErrors.ts` (`XtoolFailureId` gains `"too-many-app-groups"`, matched on the error name E1
records). Test: `tests/xtoolErrors.test.ts`, with a fixture in `tests/fixtures/xtool-errors/`.
- Text: `com.apple.security.application-groups lists more than one group; a free team allows one, and xtool stops at signing with more than one. Keep one group in ${rel}, or sign with a paid team.`

- [ ] **Step 1: Write the failing test** `explains tooManyAppGroups` (row 37).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: explain xtool's app group limit"`

---

### Task F2: Full build-only proof (controller)

No commit. In the proof app reset to `base`, after `npm run build`. Delete `.build` between runs and record its size.

- [ ] **Step 1.** Install react-native-app-auth 8.5.1 (approved). `doctor --project` shows no refusal; the `pods`
  line is silent (3.0.0 meets `>= 1.7.6`).
- [ ] **Step 2 (rows 26, 27).** `build` produces `App.app`.
  - `llvm-nm` finds `CameraView`, `RCTVideo`, `RNDeviceInfo`, `RNCNetInfo`, `RNAppAuth` and `OIDAuthState`.
  - vision-camera's warning names `FrameProcessors`, and the `ℹ` resources line appears.
  - Record whether `AppAuth_AppAuth.bundle` and `AppAuth_AppAuthCore.bundle` are in `App.app` (row 26).
- [ ] **Step 3.** Repeat F1 step 3 (the regression), now with the full pipeline.
- [ ] **Step 4.** Repeat F1 step 4 (orphan).
- [ ] **Step 5 (row 5).** Install @react-native-ml-kit/text-recognition 2.0.0. Use the tarball in `<scratchpad>/mlkit/`
  if present; otherwise this is a download that needs the owner's OK.
  - `doctor --project` and `build` refuse it, naming `GoogleMLKit`, before anything changes. No ML Kit download
    happens.
  - Uninstall it.
- [ ] **Step 6 (row 30).** Set `"exclude": ["@react-native-community/netinfo"]`, with a guarded `require` in `App.tsx`
  as in spec goal 4.4.
  - The build succeeds, and the `ℹ exclude` line appears.
  - `llvm-nm` finds no `RNCNetInfo`.
- [ ] **Step 7 (rows 33–38).** Add an entitlements file with `com.apple.developer.networking.wifi-info`,
  `aps-environment`, one App Group and a shared keychain group, set as the app target's `CODE_SIGN_ENTITLEMENTS`.
  - `doctor --project` prints the four lines.
  - `ios-xtool/xtool.yml` holds `entitlementsPath: App.entitlements`.
  - The build log shows `Applying entitlements...`.
- [ ] **Step 8.** Record versions, timings and sizes for the PR 2 body. A failure goes back to its task as a red
  test, or to the owner as a decision.

### Task F3: Expo SDK 58 proof with react-native-app-auth's plugin (controller; OQ8, if disk allows)

No commit. It needs the owner's OK: a `create-expo-app` download, about 1 GB of disk with its build.

- [ ] **Step 1.** Create the app: `npx --yes create-expo-app@<createExpo pin> <scratchpad>/libcompat-proof/expo58
  --template blank-typescript@sdk-58`. Then `npx expo install react-native-app-auth`, and add the plugin to
  `app.json`.
- [ ] **Step 2 (row 27).** `build`:
  - the driver scaffolds `react-native-app-auth` (Task B2's Expo path);
  - the bridging header is copied into `ios-xtool/Sources/App`;
  - `App.app` is produced, and `llvm-nm` finds `RNAppAuth` and `OIDAuthState`.
- [ ] **Step 3.** Without F3, Task G2 documents the Expo bridging-header passthrough as build-unverified (OQ8).
  Preflight P4 asks whether the SDK 58 scaffold path also needs F3.

### Task G2: Docs and CHANGELOG for PR 2

**Files:**
- `docs/troubleshooting.md`:
  - `### Libraries that depend on CocoaPods pods`: the refusal text; how to add a `pods` entry, with AppAuth as the
    example; that ML Kit and other binary pods need a later rn-xtool, and `exclude` is the way through today;
    SwiftPM's resolve error for a wrong URL or product (row 2); a clean `.build` needs the network for mapped pods
    (row 24); one pin per pod across the app (row 25); a "file not found" for a pod named like React Native core
    (`RCT…`) means adding it under `pods` (row 4).
  - `### Leaving a module out`:
    - when to use `exclude` and when `platforms.ios: null` in `react-native.config.js`;
    - the JavaScript guard of spec goal 4.4, and that a module looked up at import throws there (row 31);
    - excluding a library's native dependents too (row 29);
    - Expo modules go in `expo.autolinking.exclude`.
  - `## Entitlements`:
    - every line of Task E4;
    - that Debug's file is read (row 34);
    - what xtool drops on a free team, and its identifier rewrite (rows 35, 38);
    - the paid-team gap, xtool #352 (row 36);
    - App Groups per E1.
- `docs/libraries.md`:
  - the react-native-app-auth row (Bare 0.88, build only);
  - the entitlement/Info.plist column for the tested libraries (spec fact 25);
  - "pods with a SwiftPM package" in the intro;
  - AppAuth's resource bundles per F2 step 2 (row 26).
- `docs/bare-react-native.md:232-233` and `README.md`: entitlements are read (Debug `CODE_SIGN_ENTITLEMENTS`).
- `docs/how-it-works.md`: the resolver, the pod table file, `exclude`'s filter, and entitlements in `xtool.yml`.
- `CHANGELOG.md` `[Unreleased]`, Added: pods and the AppAuth mapping, the unmapped-pod refusal, `exclude`,
  entitlements and their check, and the Expo bridging header.
- Test: `tests/docsLinks.test.ts` (stays green).

- [ ] **Step 1: Write** the docs. Every quoted message is copied from Tasks C–E.
- [ ] **Step 2: Run** `grep -rn "entitlements, capabilities" docs README.md` → no hit. Then `npm test && npm run lint`
  → PASS.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && npm run scan:private && git commit -m "docs: document pods, exclude and entitlements"`

### Task H: The owner's device pass (free team)

No commit. It runs after F1 for the four libraries, and after F2 for the rest. Until the owner confirms an item, the
docs call that library build-verified only (row 41).

**Run 2026-11-05 (the owner, iOS 26, install over Wi‑Fi): pass.** The bare React Native 0.88.1 proof app with the
five libraries and an entitlements file (keychain groups, `aps-environment`, `wifi-info`, `HotspotConfiguration`, an
App Group): the five ⚠ lines printed, and the app, signed at build with its binaries left without the exec bit,
installed and launched normally (row 54). Fast Refresh works. The items left unchecked below were not run.

- [x] react-native-video plays a remote MP4 with its controls.
- [x] The vision-camera preview shows after the permission prompt (`NSCameraUsageDescription` in Info.plist).
- [x] device-info returns plausible values: model, system version and unique id. The name is the generic one. (Model
  and iOS version checked.)
- [x] netinfo reports the connection type and follows Wi‑Fi on and off. The SSID is empty, as the entitlement line
  says. (Type `wifi`, connected `true` checked; Wi‑Fi off and on not run.)
- [x] The app installs with the entitlements file of F2 step 7, and nothing on the iPhone refuses it.
- [ ] With netinfo excluded and its import guarded, the app launches without a red screen.
- [ ] Optional: the AppAuth login opens the system browser sheet and returns through the redirect. This needs a test
  OpenID provider and the redirect scheme in Info.plist. (react-native-app-auth is linked: `authorize` is present.)
- [x] Results go into `docs/libraries.md` dates, with one `docs:` commit by the controller.

### Task I: Final review (controller)

- [ ] **Step 1.** `npm test && npm run lint && npm run scan:private` are green, with the tarball-backed tests run, not
  skipped.
- [ ] **Step 2.** A reviewer who did not write the code reads the whole diff against the spec, the rulings and this
  plan.
- [ ] **Step 3.** Before the verdict, the reviewer answers, with no hints: **"Name three ways this fails in
  production that no test covers."** Each answer that is not in the spec's failure table goes to the owner as a
  decision, not to the implementer as a fix.
- [ ] **Step 4.** The verdict, then the PR bodies (versions, proof results and sizes; no absolute paths).

---

## Preflight

### Spec references checked

| Spec reference | In the code (2026-11-04, branch at 8676e47) |
|---|---|
| `read-podspec.js:652` "Subspecs detected" | ✔ |
| `read-podspec.js:626-627` (interpolated tokens dropped) | ✔ the comment above `getDefineXcconfig` |
| `read-podspec.js:535-546` `getDependencies` | ✔ name only |
| `scaffold-package-swift.js:125` revision 3; `:147-153` pod map; `:210` portable note; `:214-215`, `:220` tools lines | ✔ |
| `scaffold-package-swift.js:497-520` core names; `:685-731` dependency loop; `:696-701` `react-native-*` sibling | ✔ |
| `scaffold-package-swift.js:913-915` `umbrellaNextToSubdirs` | ✔ |
| `scaffold-package-swift.js:1418-1422` sibling throw; `:1479` 6.0 tools line | ✔ |
| `scaffold-package-swift.js:1765-1792` skip rule; `:1841-1870` symlink-relative paths; `:2163-2172` `skipDeps` | ✔ |
| `scripts/rn-spm-generate.js:192` `force: true`; `:200-205` `!` lines | ✔ |
| `vendor/rn-spm/setup-apple-spm.js:479-488` | ✔ (`force: true` at 487) |
| `src/pipeline/rnSpm.ts:266`, `:290`, `:225`, `:300` | ✔ |
| `src/pipeline/patches.ts:272-279`, `:287-289`, `:306`, `:314`, `:410` | ✔ |
| `src/project/earlyChecks.ts:182`, `:223`, `:284`, `:318` | ✔ |
| `src/project/capabilities.ts` `PODSPEC_FEATURES` | ✔ |
| `src/generate/iosXtool.ts:103-118`; `src/project/pbxproj.ts:359`; `src/generate/packageSwift.ts:113-117`, `:195` | ✔ |
| `src/generate/xtoolYml.ts` keys | ✔ no `entitlementsPath` |
| `src/tools/xtool.ts:163-194`; `src/versions.ts:1` (1.24.0) | ✔ |
| `docs/troubleshooting.md:169`; `docs/bare-react-native.md:233` | ✔ (167–169; 232–233) |
| `docs/upstream/react-native-scaffolder.md` fixes 1–18 | ✔ |
| xtool `PackSchema.swift:18`, `DevCommand.swift:80-100`, `EntitlementTypes.swift:15-33`, `Packer.swift:158` | ✔ at 952a7ff (DevCommand 78–100, types 14–32) |
| xtool "main at 2af0b67, the local checkout" | ✘ the checkout is 952a7ff (2026-10-22), with no tags (P1) |
| xtool `DeveloperServicesAddAppOperation.swift:179-198`, `tooManyAppGroups` at 192 | ✘ at 952a7ff the filter is at 179–185, and there is no `tooManyAppGroups` (P1) |
| xtool free/paid: App Groups free | ✘ at 952a7ff `AppGroupEntitlement` is `isFree: false` (P1) |

### Tests that must change

- `tests/rn-scaffolder.test.ts`:
  - the revision-3 expectations at 130, 1029, 1042, 1133, 1234 and 1249 (A6);
  - the SwiftUIIntrospect `externalPackages` shape at 986–1000 (C1);
  - new hunk tests in "the patched RN files carry the patch" (A1–A5, B1, C1, C2);
  - a new describe for fixes 20–25.
- `tests/fixtures/scaffold-golden/**`, regenerated in A2 (pager-view language mode), A4 (codegen lines), A6 (revision
  line) and C1 (pager-view pods marker).
- `tests/support/rnScaffold.ts`: `SCAFFOLD_OUTPUTS` gains `rn-spm-pod-headers` (C2).
- `tests/patches.test.ts`: the "now 3" texts at 775–799 and the revision-3 "current" fixtures at 886–967 (A6); new
  orphan and stale-pin tests (B4, C7).
- `tests/rnSpm.test.ts`:
  - "keeps setup-apple-spm scaffold for the expo kind" is replaced, and "scaffolds, persists each lib, then retries"
    and "scaffolds bare libraries through the driver" are updated (B2);
  - the `scaffoldArgv` tests and "passes --yes to add/update and scaffold" are removed (B2);
  - the env assertions gain `RN_SPM_POD_TABLE` (C4).
- `tests/rn-spm-generate.test.ts`: the `scaffoldAll` options at 295–320 (B2), and the results file (B3).
- `tests/earlyChecks.test.ts`: the options and the "unmapped pods" describe (C5); "module layout" stays green after
  `unconditionalLines` moves (B5).
- `tests/config.test.ts`: `pods`, `exclude` (C3, D1).
- `tests/doctor.test.ts`: new conditional lines `patches`, `pods`, `exclude` and `entitlements`. The `--project`
  names list stays as it is for a project without them.
- `tests/capabilities.test.ts`, `tests/build.test.ts` (`libraryFailures` gets options; resources, pin, exclude and
  entitlement lines), `tests/generate.test.ts` (Expo bridging header, `entitlementsPath`), `tests/xtoolErrors.test.ts`
  (E5).
- New test files: `tests/scaffoldResources.test.ts`, `tests/podTable.test.ts`, `tests/excludeConfigCommand.test.ts`,
  `tests/entitlementTable.test.ts` and `tests/entitlements.test.ts`.
- Unchanged and used as oracles: `tests/vendor-rn-spm.test.ts`, `tests/patches-upstream.test.ts` and
  `tests/docsLinks.test.ts`.

### How the scaffolder's two copies are synced and tested

See Fact 1 and the recipe in Global Constraints.
- The vendored copy is edited.
- `patches/react-native+0.88.0.patch` is regenerated from pristine 0.88.0 to "the vendored copy minus
  `rn-xtool-edits.patch`", and copied to `+0.88.1.patch`.
- The byte test is `tests/vendor-rn-spm.test.ts`, which applies the patch and the edits to pristine 0.88.0 and
  compares every file. It is backed by:
  - `tests/patches.test.ts` "keeps the two react-native patches identical";
  - `tests/patches-upstream.test.ts` (`-F0` on both pristine tarballs);
  - the daily drift watch.

### Config schema and how a file reaches the vendored scaffolder

- The schema is `ExpoXtoolConfig` in `src/config.ts`, with `ConfigError` shape checks per key (`checkKnownLimits` is
  the pattern). There is no JSON schema.
- A file reaches the scaffolder through an environment variable on the React Native run, like `RN_SPM_RN_ROOT`,
  `RN_SPM_EXPO_PLUGIN` and `RN_SPM_SWIFT_HEADERS_DIR`. rn-xtool writes `ios/build/rn-xtool-pods.json` and sets
  `RN_SPM_POD_TABLE` in `rnSpmEnv`.
- The scaffolder, running inside the driver process, reads `process.env.RN_SPM_POD_TABLE` and falls back to its
  baseline map.

### Findings (spec errors or gaps, with a proposed fix; the spec is not edited)

- **P1 (changes the spec: fact 23, goal 5.3, row 37).**
  - The local xtool checkout is 952a7ff, not 2af0b67. At 952a7ff App Groups are paid (`isFree: false`, a FIXME), and
    `tooManyAppGroups` does not exist.
  - Proposed: Task E1 reads the 1.24.0 tag. If 1.24.0 matches 952a7ff:
    - App Groups get the generic "not available on a free team" line;
    - the several-groups line and the `xtoolErrors.ts` mapping (Task E5) are dropped;
    - row 37 becomes "handle (the paid line) and accept (xtool drops the groups silently)".
  - Owner decision once E1 is read.
- **P2 (ruling OQ9 vs goal 3.2).**
  - Goal 3.2 put the shipped entries in the scaffolder. The ruling puts them in a JSON file in rn-xtool.
  - The plan uses `data/pods.json`, a new top-level folder added to `package.json` `files` and to RELEASING item 4.
  - Owner: confirm the location (`templates/` is the alternative, but its README role is "copied into the app").
- **P3 (changes the spec's fix list).**
  - `onlyDeps` changes the patched scaffolder, but it is not among fixes 20–24.
  - Proposed: document it as fix 25 in `docs/upstream/react-native-scaffolder.md`. It changes no manifest content,
    so there is no revision bump.
- **P4 (left to the builder; affects a verified line).**
  - Expo SDK 58 now scaffolds through the driver (installed scripts plus Expo's config command), not
    `setup-apple-spm.js scaffold`. Today that step forces and then runs `add`; the driver's step does neither, and the
    following `add|update` is unchanged.
  - Benefit: `setup-apple-spm.js` stays out of the 0.88 patches.
  - Risk: SDK 58's scaffold path is only unit-tested unless F3 runs.
  - Proposed: make F3's step 2 required for PR 2 (owner decision on disk), or keep SDK 58 on RN's `scaffold` action
    and give up `--only` there.
- **P5 (goal 3.3).**
  - The scaffolder never uses a pod's version requirement. The early check already reads the podspec's unconditional
    lines, which row 6 needs.
  - Proposed: requirements are parsed on rn-xtool's side (`podDependencies`), and `read-podspec.js`
    `getDependencies` stays name-only. This keeps the 0.88 patch smaller.
- **P6 (goal 4.2).**
  - "the entitlement check skip[s] excluded packages": the entitlement check reads only the app's own file, so there
    is nothing per package to skip.
  - Proposed: drop the clause.
- **P7 (goal 3.6).**
  - Passing every Expo bridging header would add `-import-objc-header` to every Expo build, the default comment-only
    one included.
  - Proposed and planned: pass it only when it holds more than comments and blank lines. Expo apps without the plugin
    keep a byte-identical manifest.
- **P8 (gap).**
  - An Expo project without `ios/` (CNG) has no pbxproj until `build` runs `expo prebuild`, so `doctor --project`
    cannot read its entitlements.
  - Proposed: an info line, `read after expo prebuild, at build`. The build checks them right after prebuild.
- **P9 (gap in fix 20).**
  - The scaffolder's pod-name index (`podToNpm`) covers only iOS-linked deps. A pod-style dependency (`RNWorklets`)
    on an excluded package would read as an unmapped pod.
  - Planned: index the podspecs of deps that autolinking lists without iOS too.
  - Remaining, proposed accept: a pod-style name of an npm package that is not installed at all cannot be told from a
    CocoaPods pod, and is refused as unmapped. CocoaPods fails on it too.
- **P10 (row 23 covers persisted patches only).**
  - Planned: an unpersisted copy whose `rn-xtool-pods` line differs from the table is regenerated, the same rule as
    an older revision.
- **P11 (RELEASING).**
  - `docs/RELEASING.md` has no rule on the scaffold revision or on the two copies; the rule lives in
    `docs/upstream/react-native-scaffolder.md` and the tests.
  - Planned in G1: a "Scaffolder changes" item.
  - Also: without `tests/.cache` every byte test skips silently. This worktree has none, so Task 0 fetches the
    tarballs with the owner's OK.
- **P12 (goal 2.4's example).**
  - The spec names async-storage's resource by its file and svg's by its bundle.
  - Planned rule: a bundle made only of privacy manifests is named by the file; any other bundle by `<name>.bundle`;
    a plain resource by its basename.
- **P13 (unmapped text).**
  - The spec gives the one-pod text.
  - Planned: several pods are listed, and the config snippet names the first.
- **P14 (sequencing).**
  - PR 1 ships revision 4 without the `rn-xtool-pods` line. PR 2 adds the line for libraries with mapped pods and
    does not bump again.
  - Only a pager-view patch persisted between the two PRs (the owner's work app) lacks the line. Under row 48 it gets
    the "does not pin SwiftUIIntrospect" warning once (an unpersisted copy is regenerated), until the patch is deleted
    and the library re-scaffolded.
  - Proposed accept, since no release happens in between. The alternative is revision 5 in C1.
- **P15 (downloads).**
  - The approved list covers the five libraries and AppAuth-iOS. These need the owner's OK first:
    - the test tarballs (Task 0, about 150 MB);
    - the 0.88.1 template (Task 0);
    - react-native-linear-gradient (F1 step 3);
    - @react-native-ml-kit/text-recognition, unless its tarball in `<scratchpad>/mlkit/` is used (F2 step 5);
    - the SDK 58 template (F3).
- **P16 (Expo SDK 58 with `exclude`).**
  - `setup-apple-spm.js add` records the explicit config command, with rn-xtool's absolute script path, in
    `ios/<app>.xcodeproj/.spm-injected.json` inside the prebuild output.
  - rn-xtool always passes the command explicitly and never reads that record. Proposed accept.
- **P17 (keychain line).**
  - The spec's example shows `TEAMID0000`. rn-xtool does not know the Team ID at build time.
  - Planned: `<Team ID>.XTL-<Team ID>.${bundleId}`. xtool registers the app as `XTL-<Team ID>.<bundle id>` and
    rewrites the keychain group with that id (fact 23), in the README's `XTL-` notation.
- **P18 (xtool's entitlement decoding, unverified).**
  - `xtool dev build` decodes the file with `PropertyListDecoder` into `Entitlements`. A value type it cannot decode
    would fail the build after compiling.
  - F2 step 7 covers the work app's keys. Any other failure is a new row for the owner.
