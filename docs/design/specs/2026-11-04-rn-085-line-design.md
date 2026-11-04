# Bare React Native 0.85 line (design)

Status: short design, 2026-11-04, draft for Willy's approval. The research notes (a hands-on check of the 0.85
artifacts with rn-xtool's own adapter, and a survey of public history) are kept outside the repo; the facts this
design rests on are restated here with their sources.

## Intent

A work app is on bare React Native 0.85.0 with `@react-native-community/cli` 20.0.0. rn-xtool refuses it: no row
covers 0.85. Moving the app to 0.88.1 is a three-minor React Native migration for the whole app, Android and JS
included, not only an iOS change.

To rn-xtool, 0.85 looks like 0.86: the same artifact layout, no SwiftPM scripts, the same codegen entry point and a
byte-identical iOS template. This block adds a `0.85` bare line as one `SUPPORTED_LINES` row plus its verification.
No new mechanism is needed.

The [vendored-scripts design](2026-10-26-vendored-spm-scripts-design.md) listed "RN 0.85 and older" as a non-goal for
two reasons: "no prebuilt React core by default, artifact layout unverified". Both are answered for 0.85 below
(facts 1–3). Older minors stay out (see Non-goals).

## Facts

1. **The artifacts are published.** 0.85.0, 0.85.1, 0.85.2 and 0.85.3 are on Maven Central and on
   `repo.reactnative.dev` (HEAD 200, the same size on both; probed 2026-11-04). They exist as
   `com.facebook.react:react-native-artifacts:<v>` with the classifiers `reactnative-core-{debug,release}` and
   `reactnative-dependencies-{debug,release}`. `reactnative-headers-debug` and
   `reactnative-dependencies-headers-debug` answer 404, as they do for 0.86.3: this is the pre-headers-spec layout.
   For 0.85.0 the sizes are: core 93.2 MB (debug) and 29.8 MB (release); dependencies 18.7 MB and 10.4 MB.
   Source: the Maven Central listing for `react-native-artifacts` and the per-version directories.
2. **The layout matches 0.86.** This was checked after downloading the 0.85.0 core (debug and release), the 0.85.3
   core (debug), the 0.85.0 dependencies (debug) and the Hermes debug tarball:
   - `React.xcframework` has `React-VFS-template.yaml` in the same format (`version: 0`, one root
     `'${ROOT_PATH}/Headers'`, single-quoted names). It has 1151 mappings in 0.85.0 and 1171 in 0.85.3, against 1178
     in 0.86.3.
   - Each slice has `Headers/React_Core/React_Core-umbrella.h`.
   - `ReactNativeDependencies.xcframework/Headers` has 0 differences from 0.86.3's.
   - The framework module map additionally has `module * { export * }`. This does not matter: the adapter writes its
     own map.
   - 0.85's umbrella imports `<React/RCTDefines.h>` at line 84; 0.86.3 moved that import to the top.
     `RCTBridgeConstants.h` imports `RCTDefines.h` itself, so this is a compile-time item to watch, not a blocker.
3. **The 0.86 adapter, unchanged, adapts 0.85.** rn-xtool's `adaptSlot()` (`src/pipeline/rnArtifacts.ts:334`), run
   from `dist/`, adapted debug slots of 0.85.0 and 0.85.3 assembled in the downloader's shape. 0.86.3 was the control.
   - Each output has 14 ReactNativeHeaders modules. 0.85.0's module map is byte-identical to 0.86.3's.
   - Flat React headers: 354 (0.85.0), 362 (0.85.3) and 362 (0.86.3).
   - 0.85.0 has 2 headers that 0.86.3 lacks (`jsinspector-modern/Base64.h`,
     `react/renderer/graphics/DoubleConversions.h`). 0.86.3 has about 29 that 0.85.0 lacks, all for newer features.
   - `inspectSource` (`src/pipeline/rnArtifacts.ts:267`) checks layout facts: the VFS template, the umbrella per
     slice, `artifacts.json` and `hermes-headers/hermes`. It never checks a version number.
   - Nothing in `rnArtifacts.ts` or `rnArtifactsStep.ts` branches on the version; only comments say "0.86.x". A
     row's `artifacts` field is descriptive only.
4. **Hermes comes from the project, not from rn-xtool.**
   - The vendored downloader takes the Hermes version from the `hermes-compiler` package the project has installed
     (`resolveLocalHermesCompilerVersion` and `resolveHermesArtifact`,
     `vendor/rn-spm/spm/download-spm-artifacts.js:470-556`). It then fetches
     `com.facebook.hermes:hermes-ios:<version>`: first the mirror, then Central, then a Sonatype snapshot.
   - It falls back to the `latest-v1` dist-tag only when `hermes-compiler` does not resolve. When the package is
     installed but unreadable, it prints a warning first. `HERMES_VERSION` overrides all of this.
   - rn-xtool pins no Hermes version per line. 0.86.3 gets 250829098.0.17 from its own `hermes-compiler`.
   - `doctor --project` probes the Hermes URLs with the same version source. It skips Hermes when `hermes-compiler`
     does not resolve (`src/project/capabilities.ts`, `probeArtifacts`).
   - Every 0.85.x `react-native` depends on `hermes-compiler` 250829098.0.10 (its `package.json`; v0.85.0's
     `sdks/hermes-engine/version.properties` names the same V1 version). `hermes-ios` 250829098.0.10 answers 200 for
     debug (29.9 MB) and release (23.5 MB). Its tarball has the shape the downloader stages:
     `destroot/Library/Frameworks/universal/hermesvm.xcframework` and `destroot/include/hermes`. Two Hermes headers
     differ from 0.86.3's.
5. **No SwiftPM scripts.** `react-native@0.85.0` has no `scripts/spm/`, no `scripts/setup-apple-spm.js` and no
   `scripts/codegen/templates/Package.swift.spm-template`; its `scripts/` file list is the same as 0.86.3's.
   - `readScriptsShape` (`src/project/scriptsShape.ts:72`) therefore reads `none`. `scriptsCapability` (line 124)
     then picks `vendored`, because rn-xtool bundles no react-native patch for 0.85.
   - 0.85 does ship `scripts/swiftpm/`, Meta's header-preparation helper (present since 0.83). The detector looks only
     for `setup-apple-spm.js` and `spm/`, so the helper does not change the result.
   - The upstream generator, `scripts/spm`, first appears in a release tag at v0.87.0 (facebook/react-native PR
     #57332, merged 2026-07-15).
6. **Codegen takes the same options.** 0.85's `scripts/generate-codegen-artifacts.js` accepts the `-p/-t/-o` options
   that `vendor/rn-spm/spm/spm-utils.js:691-711` passes. 0.86 only added an optional `-f/--forceOutputPath`, which
   the vendored scripts do not pass. The output layout (`build/generated/ios/{ReactCodegen,ReactAppDependencyProvider}`)
   is the same.
7. **The template is 0.86's.** In `@react-native-community/template@0.85.0`, `template/ios` is byte-identical to
   0.86.3's: `AppDelegate.swift` only, `import React_RCTAppDelegate`, `IPHONEOS_DEPLOYMENT_TARGET = 15.1`, C++20. Its
   `package.json` pins `@react-native-community/cli` 20.1.0 (in 0.85.0 and 0.85.3 alike) and react 19.2.3.
8. **The CLI pin is not a gate.**
   - A bare row's `cli` is the CLI version the drift watch creates the line's project with (`src/versions.ts:57-61`,
     `src/drift/targets.ts:67` and `:143`). The rule is the test "pins the CLI each bare line's template declares"
     (`tests/versions.test.ts:96`): the pin is the CLI the template of the last verified release declares. The type
     makes the field required, so `npm run lint` fails without it (`docs/RELEASING.md`, "Adding a line").
   - The build checks only that `@react-native-community/cli` resolves (`src/commands/build.ts:208-209`,
     `RN_CLI_MISSING` in `src/project/bare.ts:25`). For autolinking it runs the project's own CLI
     (`npx --no-install @react-native-community/cli config`).
   - 20.0.0 and 20.1.0 differ on the `config` path only in `chalk` → `picocolors` and source-map paths
     (`cli-config`, `cli-config-apple`, `cli-platform-ios`, `cli-platform-apple`). The weekly exploration already
     creates 0.81–0.83 projects with 20.0.0.
9. **The version gate reads the table.**
   - `checkRnVersion` (`src/project/bare.ts:36`) uses `rnLineStatus` (`src/versions.ts:222`). It refuses a minor
     without a row. On a row's minor, a verified version builds silently, a newer release builds with a warning, and
     a version below the floor or a prerelease is refused.
   - `supportedRnList()`, the gate message, `doctor`'s `versions` line and `unsupportedReason` all read the table.
   - A vendored-scripts project with expo-modules-core is refused with "React Native <v> with Expo modules is not
     supported. Expo SDK 58 needs React Native 0.88.1."
   - The drill ids come from the table (`src/drift/issues.ts:80`).
   - Today's tests assert that 0.85 is refused: `tests/versions.test.ts:135` and `tests/project/bare.test.ts:90`. The
     exploration lists name 0.85 in `src/drift/targets.ts:76-88` and `tests/drift/explore.test.ts:79-123`.
     `tests/drift/targets.test.ts:140-150` uses `bare-0.85` as an example of a target without a CLI pin.
10. **The weekly exploration already sees 0.85 as buildable.** In Drift watch run 41456608323 (2026-11-02), the row
    reads `bare-0.85 | react-native 0.85.3 | scripts none | artifacts published`, with the reason "React Native 0.85:
    no SwiftPM scripts; support comes with the translator". 0.81.6, 0.83.10 and 0.84.1 also read "published". 0.82.1
    reads "missing: Hermes (debug), Hermes (release)".
11. **Public history.**
    - Prebuilt dependencies are on Maven from 0.79. Prebuilt React core is there from 0.81 (`reactnative-core-*`) and
      is the CocoaPods default from 0.84.
    - React Native 0.85's own `scripts/ios-prebuild` README lists "Integrating with Swift Package Manager projects
      expecting modular headers" as a known issue.
    - No public tool builds a 0.85 app with SwiftPM. Expo SDK 56 (React Native 0.85) builds its own modules into
      xcframeworks with SwiftPM manifests on a Mac; that work is module-scoped and does not integrate an app.
    - Sources: the RN 0.81 and 0.84 release blog posts, Maven Central, and the GitHub tags v0.79.0 to v0.88.0.
12. **Releases.** 0.85.0 was published on 2026-04-07 and 0.85.3, the newest 0.85, on 2026-05-05. npm has no
    `0.85-stable` dist-tag. 0.86, 0.87 and 0.88 have shipped since.
13. **The work app's animation libraries.**
    - It uses react-native-reanimated 4.3.x and react-native-worklets 0.8.x. Both have a podspec and no `Package.swift`,
      and both declare peers for react-native 0.81–0.85.
    - rn-xtool has never scaffolded these versions. Their podspecs pass `-DREACT_NATIVE_MINOR_VERSION=#{...}`, which
      scaffolder fix 8 resolves from the installed React Native (`docs/upstream/react-native-scaffolder.md` #8,
      `readRnVersionMacros` in `vendor/rn-spm/spm/read-podspec.js`).
    - reanimated 4.5.x + worklets 0.10.x declare peers for 0.83–0.86. rn-xtool ran 4.5.1 + worklets 0.10.1 on an
      iPhone on React Native 0.86.3 (Expo SDK 57; `docs/libraries.md`, Expo 57 column, 2026-10-28).
14. **What a failing library shows today.**
    - `React Native spm scaffold failed (exit <n>)`, or
      `React Native SwiftPM setup still failed after scaffolding <names> (exit <n>)`, each followed by the last 40
      output lines (`src/pipeline/rnSpm.ts:272-302`);
    - or a compiler error at `xtool-build`;
    - or a G4 symbol error at `frameworks`.

    None of these names versions that are known to work.
15. **Adding a line** takes "one `SUPPORTED_LINES` row plus its verification on a device", and the minor leaves
    `EXPLORE_RN_MINORS` and `EXPLORE_RN_CLI` (`docs/RELEASING.md`, "Adding a line"). 0.86.2 is build-verified only, but
    as the second version of a line whose 0.86.3 was verified on a device.
16. **Download size and integrity.**
    - One 0.85 version downloads about 205 MB compressed (core, dependencies and Hermes, debug and release). It takes
      about 1.2 GB on disk once extracted.
    - The vendored downloader checks no checksum: a damaged tarball fails at extraction.
    - An incomplete raw slot is downloaded again (`rawSlotComplete`, `src/pipeline/rnArtifactsStep.ts`). A complete
      one is reused as it is.
    - Maven Central does not let a released version be replaced. The mirror `repo.reactnative.dev`, which is tried
      first, is Meta's own.

## Goals

1. **A `0.85` bare row:** `{ kind: "bare", minor: "0.85", floor: "0.85.0", verified: [...], scripts: "vendored",
   artifacts: "adapted", cli: "20.1.0" }`, first among the bare rows. The `verified` list is open question 2.
   - The gate message, `supportedRnList()`, `doctor`'s `versions` line and `doctor --project` follow from the row:
     `0.85.x from 0.85.0, 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0`.
   - A verified 0.85 version builds silently. 0.85.1, 0.85.2 and any newer 0.85.x build with the floor warning.
     Prereleases are refused.
   - 0.85 is the first line with unverified releases between verified ones: 0.85.1 and 0.85.2 are above the floor
     but below 0.85.3. For such a version the floor warning reads `⚠ Not among the React Native 0.85 versions this
     rn-xtool release was verified with: react-native 0.85.1. Verified: 0.85.0 and 0.85.3. …` and says "move
     react-native to 0.85.3", instead of "Newer than …" and "move react-native back to". The change is generic: it
     applies to every line whose last verified version is above the installed one, and names no version.
   - 0.85 with Expo modules is refused with the existing message.
2. **The scripts are vendored.** 0.85 uses the same `vendor/rn-spm/` copy that 0.86, 0.87 and Expo SDK 57 use:
   - no new vendored edits;
   - no react-native patch for 0.85;
   - a vendored edit, if one turns out to be needed, is of the generic E1–E5 kind. Anything that needs a 0.85-specific
     branch goes back to Willy as a decision, as the vendored-scripts design ruled for 0.87.1.
3. **The artifacts are adapted** by the 0.86 adapter, unchanged:
   - `ADAPTER_VERSION` stays 1;
   - comments say "pre-headers-spec slots (0.85.x, 0.86.x)" instead of "0.86.x";
   - a unit test adds a fake slot in the 0.85 shape (the extra `module * { export * }`, the umbrella with
     `RCTDefines.h` in the middle) and expects the same output as the 0.86 shape;
   - if the build-only proof needs an adapter change, the change follows a layout fact, never the version.
4. **Hermes needs no rn-xtool pin.** The downloader's `hermes-compiler` rule gives `hermes-ios` 250829098.0.10 for
   every 0.85.x, as it gives 250829098.0.17 for 0.86.3. Nothing in the adapter is Hermes-version-specific: it links
   `hermes-engine.xcframework` and `hermes-headers/hermes` as they are. `docs/bare-react-native.md` states the Hermes
   version and where it comes from.
5. **The CLI pin is 20.1.0**, which `@react-native-community/template@0.85.0` (and 0.85.3) declares:
   - it means only that the drift watch creates `bare-0.85` with CLI 20.1.0;
   - the build does not gate on the CLI version: a project on 20.0.0, like the work app, is not refused and is not
     warned about;
   - the build-only proof also runs with 20.0.0 (Verification);
   - the docs say both.
6. **The drift watch:**
   - `"0.85"` leaves `EXPLORE_RN_MINORS` and `EXPLORE_RN_CLI`, so the weekly exploration covers 0.81–0.84;
   - the daily watch picks up `bare-0.85` from the row: the newest 0.85.x, created with CLI 20.1.0, and the gates,
     patches and manifests checks;
   - `drill=bare-0.85` works without a change;
   - the workflow's header comment and `docs/RELEASING.md` say 0.81–0.84 and list `bare-0.85` among the drill ids
     and the daily targets.
7. **reanimated 4.3 + worklets 0.8 (a goal with a fallback, not a promise).** A 0.85.0 template app with the work
   app's reanimated 4.3.x and worklets 0.8.x (plus `react-native-worklets/plugin` in `babel.config.js`) scaffolds and
   builds; then, on the device, it animates.
   - If it fails and the cause is generic, the cause is fixed in the vendored scaffolder in this block.
   - If it cannot be fixed here, the documented way to keep the app on React Native 0.85 is reanimated 4.5.x +
     worklets 0.10.x. That pair is built on 0.85.0 in this block, and the failure message names it (row 15; the form
     is open question 3).
   - Only when the old pair cannot be fixed here: a compile error of a scaffolded library shows at `xtool-build`, not
     in `rn-spm`. The hint (open question 3, (c)) is therefore also appended to the `xtool-build` failure when its
     output names `node_modules/react-native-reanimated/` or `node_modules/react-native-worklets/` on a 0.85 project
     with the old pair.
8. **Docs:**
   - `docs/bare-react-native.md`: the table row; the intro and error text; a "0.85" section (the same route as 0.86,
     the Hermes version, the download sizes, CLI 20.0.0 or 20.1.0, the reanimated result); and "Older artifacts
     (0.85, 0.86)".
   - `README.md`: the support table and the versions sentence. The "not yet" row becomes "Expo SDK 54–56, React
     Native 0.84 and older, …".
   - `docs/libraries.md`: a `Bare 0.85.0` column, ⏳ everywhere until tested; filled from this block's checks.
   - `docs/how-it-works.md`: the vendored-scripts and artifact paragraphs (0.85, 0.86 and 0.87).
   - `docs/troubleshooting.md`: the `doctor --project` examples, plus an entry only if a 0.85-specific message
     appears (for example row 15's).
   - `docs/RELEASING.md`: the drill ids, the daily targets and the exploration range.
   - `CHANGELOG.md`: an `Added` entry under Unreleased.
9. **Tests:**
   - `tests/versions.test.ts`: the table, the CLI pins, `supportedRnList`, and the line classes (0.85.0 verified;
     0.85.1, 0.85.2 and 0.85.4 newer; 0.85.4-rc.0 a prerelease; 0.84.1 unsupported).
   - `tests/project/bare.test.ts`: the refusal list uses 0.84.1 instead of 0.85.0; 0.85.0 with expo-modules-core
     gets the Expo-modules refusal; a newer 0.85.x gets the warning.
   - `tests/drift/explore.test.ts` and `tests/drift/targets.test.ts`: the lists without 0.85, and `bare-0.85` among
     the daily targets. The missing-CLI example moves to 0.84.
   - `tests/drift/issues.test.ts`: `checkDrill("bare-0.85")` is accepted.
   - `tests/doctor.test.ts`: the `versions` line for 0.85.

## Non-goals

- **0.84 and older.** Prebuilt core is published from 0.81, and the exploration reads 0.81.6, 0.83.10 and 0.84.1 as
  "published". Still, each minor needs its own check: its layout, its template, its codegen options, and its Hermes
  (0.82.1 has no Hermes artifact). That is one row and one verification each, later. The weekly exploration keeps
  covering 0.81–0.84 and is the evidence for that work.
- **Expo SDK 56 (React Native 0.85).** Expo projects go through Expo's own SwiftPM plugin path: the vendored Expo 58
  plugin for SDK 57, the installed plugin for SDK 58. They also have their own version gates (G1–G3, the SDK rows'
  pins). `expoPluginFor(56)` is undefined. SDK 56 would need its own plugin route and pins, and a check of its
  modules built against React Native 0.85. That is a separate design, like SDK 57's. A bare 0.85 line does not open
  SDK 56. A hybrid (bare 0.85 + Expo modules) stays refused, because Expo modules in a bare app need SDK 58.
- **The work app's other libraries.** Third-party pod resolution, binary pods (ML Kit) and AppAuth are separate
  blocks. This block proves the line on the template and the reanimated/worklets pair only.
- **Moving the work app to 0.88.1.** That is the app's own decision; this block keeps it on 0.85.
- **A Hermes pin, a CLI gate or any 0.85-specific code path.** The line is data. Behaviour follows layout and
  capability, as for 0.86.

## Failure walk

The process, end to end: version gate → scripts shape → Maven downloads (core, dependencies, Hermes) → adapter →
vendored scripts and 0.85's codegen → scaffolder for the app's libraries → link → G4 → device. The daily watch runs
the gates and the artifact probe on the newest 0.85.x every day.

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | Version gate | a 0.85.x prerelease, or 0.85 with expo-modules-core | user: the existing refusal ("not supported; rn-xtool supports 0.85.x from 0.85.0, …", or "with Expo modules is not supported") | handle: the existing gate; tests add the 0.85 cases |
| 2 | Version gate | a 0.85.x patch newer than 0.85.3 (0.85.4) | user: `⚠ Newer than the React Native 0.85 line this rn-xtool release was verified with: react-native 0.85.4. Verified: …`; maintainers: the daily watch creates the newest 0.85.x and runs the gates and the artifact probe | accept: the floor rule (version-floors design, Goals and row 8); its artifacts still pass the adapter's strict check (row 9). No 0.85 release since 2026-05-05 |
| 3 | Scripts shape | a 0.85.x patch ships scripts in a shape rn-xtool does not know | `doctor --project` "not recognised"; the build takes the row's `vendored` | handle: already ruled (version-floors row 9) |
| 4 | Maven download, core and dependencies (mirror, then Central) | fails outright: HTTP error, offline, slot removed | user at `rn-artifacts`: `Downloading React Native 0.85.0 debug artifacts failed (exit <n>)` and the last 40 lines; maintainers: the daily probe reads "missing" and the line goes red | accept, as ruled for 0.86 (vendored-scripts design, "Maven download" row): `rnArtifactsDir` is the offline path |
| 5 | Maven download | partial: truncated or damaged tarball (no checksum is checked) | user: an extraction error at `rn-artifacts`; the incomplete slot is downloaded again on the next build | accept, the same row; `rawSlotComplete` already re-downloads an incomplete slot |
| 6 | Maven download | duplicated: a slot re-published under the same version with other content | new users get the new content; existing users keep their cached slot. A layout change gives the named error (row 9). A header change shows as a compile or G4 error; a binary change only on the device (row 19) | accept for content, handle for layout, as ruled for 0.86 (vendored-scripts design, "Adapter on a slot whose layout differs"); Central does not allow a re-publish, and the mirror tried first is Meta's |
| 7 | Hermes download | `hermes-ios` 250829098.0.10 missing from both repositories | user: the downloader tries a Sonatype snapshot, then fails with row 4's error; maintainers: the daily probe reads "missing: Hermes (debug), Hermes (release)", as the exploration showed for 0.82.1 | accept: covered by row 4's handling and the daily watch; no rn-xtool pin to update |
| 8 | Hermes version | `hermes-compiler` does not resolve from react-native, so the downloader takes `latest-v1` (another Hermes) | user: the downloader's own warning when the package is unreadable; otherwise a compile error against other Hermes headers, or a crash at launch | accept: `hermes-compiler` is a dependency of react-native 0.85, so npm installs it; pnpm and Yarn PnP are refused early (early-clear-failures design) |
| 9 | Adapter input checks | an unexpected layout: a file missing, an unreadable VFS template, a slice without its umbrella, flavors with different layouts | user at `rn-artifacts`: `React Native 0.85.x artifacts in <slot> have a layout rn-xtool does not recognise: <file> is missing. Report it at https://github.com/WillyAntunez/react-native-xtool/issues with this message.` Nothing is half-written: the tree is built in a temporary directory and renamed at the end | handle, as ruled for 0.86 (vendored-scripts design, the same row): strict detection, named error, no fallback; a unit test with the 0.85-shaped fake slot |
| 10 | Adapter output | a header 0.85 code includes is missing from the adapted tree or the 0.88-derived module table, or the umbrella's import order matters | user: a compile error at `xtool-build` | handle: the build-only proof compiles the template and the reanimated pair; a failure is fixed by a layout-driven adapter change (with an `ADAPTER_VERSION` bump), never by a version branch |
| 11 | Adapter cache | the raw slot changes and an old adapted tree is reused | nobody | handle: already ruled (vendored-scripts design, "Adapter cache stale": the stamp) |
| 12 | Disk | about 1.2 GB per 0.85 version plus the adapted links; ENOSPC during download or adapting | user | accept, as ruled for 0.86 (vendored-scripts design, "Disk" row: temporary directory and rename; free-space check deferred); the 0.85 section gives the sizes |
| 13 | Vendored scripts and 0.85's codegen | a codegen option or output change, so the sync fails (`React Native SwiftPM setup failed (exit <n>)`) or the manifests point at missing directories | user at `rn-spm` or `xtool-build` | handle: the options were checked (fact 6) and the build-only proof runs them; already ruled for 0.86 (vendored-scripts design, "Vendored scripts vs installed RN codegen"); a newer 0.85.x that changes them goes through row 2 |
| 14 | Autolinking with the app's CLI 20.0.0 | its `config` output differs from 20.1.0's: the parse fails (`React Native SwiftPM setup failed`), or a library is left out (a link or G4 error, or "not linked" at runtime) | user at `rn-spm`, `frameworks` or on the device | handle: the build-only proof runs once with 20.0.0, and the two `config` outputs are compared (paths aside). A field the vendored scripts read that differs is fixed generically in their parser before merge |
| 15 | Scaffolder: reanimated 4.3 + worklets 0.8 | the scaffold fails, the setup fails after scaffolding, or a compile or G4 error | today the user sees `React Native spm scaffold failed (exit <n>)` or `… still failed after scaffolding react-native-reanimated, react-native-worklets (exit <n>)` with 40 lines, or a compiler error; nothing names versions that work. Wanted: the message names reanimated 4.5.x + worklets 0.10.x as the way to stay on React Native 0.85 | handle: fix a generic cause in the vendored scaffolder in this block. If the cause cannot be fixed here, the fallback pair is built on 0.85.0, and the docs (`bare-react-native.md`, `libraries.md`, `troubleshooting.md` under the message) and the build's message name it; the message's form is open question 3 |
| 16 | Scaffolder: the work app's other libraries | pod resolution, binary pods (ML Kit), AppAuth | user | defer: to those blocks (Non-goals) |
| 17 | Persisted scaffold patches | a library scaffolded on 0.85 and the app later moved to 0.86 or newer | user: the existing "scaffolded for React Native 0.85.0; delete it so rn-xtool regenerates it" warning | accept: existing behaviour (troubleshooting.md, "Build and patches") |
| 18 | Link and G4 | a symbol that the 0.88-shaped headers expect is missing from the 0.85 binaries | user at `frameworks`: G4 names the missing symbols | handle: the build-only proof runs G4 on the template and on the reanimated pair |
| 19 | Device | a runtime failure that build-only cannot catch: Hermes 250829098.0.10 with these headers, a module map that compiles but registers the wrong thing, reanimated's runtime | user: a crash at launch, a red screen, or a library that does nothing | handle: the device pass (Verification) comes before any doc calls 0.85 device-verified; whether the row may ship without it is open question 1 |
| 20 | Daily watch on `bare-0.85` | the create or install fails (ERESOLVE upstream, the network) | a `Drift: React Native 0.85 (bare)` issue, or "could not run" | handle: already ruled (version-floors rows 2–3) |
| 21 | Daily watch | false green: no compile, no G4 | users | accept: already ruled (version-floors row 7) |
| 22 | Weekly exploration | 0.85 leaves it | nobody | accept: the daily watch covers 0.85 with more checks (patches, manifests, issues) |
| 23 | First-launch reload helper | `templates/dev-support/RNXAutoReload.m` uses notification names and `RCTTriggerReloadCommandListeners`, which are checked only against 0.86.3, 0.87.1 and 0.88.1 (`tests/devSupport.test.ts`); on 0.85 a missing name makes the helper a no-op, with no build error | user: after tapping Allow on the first launch, the red screen stays until a manual reload, as before the helper | handle: the pinned-tarball test adds react-native 0.85.0 (a test-only download of about 20 MB), and the device pass checks the reload after Allow |
| 24 | Scaffolder fix 19 on the other lines | fresh scaffolds of react-native-worklets on Expo SDK 57 / React Native 0.86.3 and 0.87.1 now carry `HERMES_V1_ENABLED` through fix 19, where the device-verified runs before this block had none; the define compiles but could select a Hermes path that misbehaves at runtime | user on the device: a crash at launch, or worklets that do nothing | handle: a device check on 2026-11-04 (an SDK 57 app with reanimated 4.5.1 + worklets 0.10.1 freshly scaffolded, installed over Wi‑Fi: Hermes, the animation running, Fast Refresh), plus the existing fix-19 tests |

## Verification

- **Unit tests:** those listed in Goals, item 9, and the 0.85-shaped adapter test. `npm test` and `npm run lint` are
  green; `npm run scan:private` is clean.
- **Downloads need the owner's approval first.** One 0.85 version takes about 205 MB compressed and about 1.2 GB on
  disk; 0.85.0 and 0.85.3 together take about 410 MB and 2.4 GB. The npm installs come on top. The archives the
  research downloaded are not reused: the proof has to go through the download hop.
- **Build-only proof (no device).** It shows that headers, codegen, scaffolding, linking and G4 work:
  1. `npx @react-native-community/cli@20.1.0 init App085 --version 0.85.0 --install-pods false --skip-git-init`.
  2. `rn-xtool build` from this branch goes through `patches` → `rn-artifacts` (download, then adapt) → `rn-spm` →
     `frameworks` (G4) → `generate` → `xtool-build`, and produces `App.app`. `doctor --project` reads the 0.85 line
     and the vendored scripts.
  3. The same app with `@react-native-community/cli` 20.0.0 installed: it builds, and its `config` output matches
     20.1.0's except for paths (row 14).
  4. The same app with reanimated 4.3.x + worklets 0.8.x (the work app's versions) and the worklets Babel plugin:
     they scaffold and build. If not, row 15 applies, and reanimated 4.5.x + worklets 0.10.x are built instead.
  5. A fresh 0.85.3 template builds to `App.app` (a second download).
- **Device pass.** 0.85.0 launches on an iPhone with Hermes and loads its bundle from Metro. Fast Refresh works, and
  the reanimated pair animates. That is 4.3 + 0.8 if row 15 did not trigger, otherwise 4.5 + 0.10. Only then do the
  docs list 0.85.0 as verified on a device. Without the pass, 0.85.0 is documented as build-verified, like 0.86.2;
  whether the row ships that way is open question 1. The pass ran on 2026-11-04 (iOS 26).
- **Fix 19 on the other lines (row 24).** On 2026-11-04 (iOS 26), an Expo SDK 57 app with reanimated 4.5.1 + worklets
  0.10.1 freshly scaffolded, so with `HERMES_V1_ENABLED`, was installed over Wi‑Fi: Hermes, the animation running,
  Fast Refresh.
- **Drift:** one manual daily run (`workflow_dispatch`, mode `daily`) is green with `bare-0.85` in it, and one
  explore run lists 0.81–0.84 only. No drill run is needed: the issue path is unchanged, and a unit test covers
  `bare-0.85` as a drill id.

## Open questions

1. **May the row ship without a device pass?** `docs/RELEASING.md` asks for a device verification to add a line. The
   0.86.2 precedent was a second version inside a line that was already verified on a device. Proposed: the row ships
   only after the device pass; until then the branch waits, with the build-only proof as its evidence.
   Alternative: ship 0.85.0 as build-verified and amend "Adding a line" to allow it.
2. **What goes in `verified`?** Proposed: `["0.85.0", "0.85.3"]`, with 0.85.0 verified on the device and 0.85.3
   build-verified (as 0.86.2 is), so the version the daily watch creates builds silently. Alternative: `["0.85.0"]`
   only, so that 0.85.1–0.85.3 build with the floor warning.
3. **If reanimated 4.3 + worklets 0.8 cannot be fixed in this block, how does the message name the fallback?**
   - (a) Docs only: the troubleshooting entry is keyed on the failure text.
   - (b) A version-scoped early check (`knownLimits`, allow key = the package name) that refuses 4.3/0.8 on 0.85
     before the build and names 4.5.x + 0.10.x.
   - (c) A hint appended to `rn-spm`'s failure when a failing package is react-native-reanimated or
     react-native-worklets below 4.5/0.10 on a 0.85 project.

   (b) and (c) are exceptions to "mechanisms over versions". Proposed: (c), which never refuses a setup that might
   build and speaks only when the build actually fails, with (a) alongside it.
4. **The work app itself.** Is building the work app part of this block, given that its other libraries are
   deferred? Proposed: no. This block proves the line on the template and the animation pair; the work app's build
   follows the pod-resolution blocks.

## Left to the builder

Exact test names; whether to add a `tests/fixtures/bare-085` (its `ios/` equals `bare-086`'s, so the gate tests can
use a version argument instead); the comment wording in the adapter; the wording of the 0.85 section in
`docs/bare-react-native.md`.
