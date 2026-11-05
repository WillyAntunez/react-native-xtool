# Binary CocoaPods Pods Implementation Plan

> **For implementers:** work task by task, in the order of "Execution order" below. Every task is test first: the
> failing test, then the code, then green. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a bare React Native 0.88.1 app with @react-native-ml-kit/text-recognition 2.0.0 builds with rn-xtool, on
Linux, without a hand fix:
- the library's `GoogleMLKit` pod is resolved from the CocoaPods CDN to ten binary pods, downloaded from the URLs in
  their specs, checked against a sha256 lock the project commits, and wrapped for SwiftPM in rn-xtool's cache;
- their source pods come from SwiftPM packages through block 2's pod table;
- the OCR models reach `App.app` as `<Key>.bundle`s, and so does react-native-svg's `RNSVGFilters.bundle`;
- before the first byte, the user is told what is downloaded, how much, from where and whose, and gets a clear stop
  when offline, short of disk, or when a file changed;
- no Google byte is ever shipped, committed or persisted by rn-xtool.

**Architecture:**
- **`src/pods/`** (new): the CDN spec client, the spec parser, a strict CocoaPods version matcher, the greedy resolver,
  the lock file, downloads and verification, listing-first extraction, the Mach-O reader, the `llvm-ar` wrap,
  headers-only xcframeworks, the generated `pod-binaries` package, the `pods` step and the post-pack checks.
- **Cache:** `<cacheDir()>/pods/` (`~/.cache/rn-xtool/pods`): `specs/`, `downloads/<sha256>.<ext>`,
  `extracted/<sha256>-<stamp hash>/`, `wrapped/<sha256>-<stamp hash>/` (review I-1: a tree is named by its archive and
  by its stamp, so two selections of one archive never share a folder). Every tree is assembled per pid, stamped, and
  swapped in whole.
- **Project:** `rn-xtool-pods.lock.json` at the root (committed by the user); `ios/build/pod-binaries/` (generated on
  every build, with its own `.gitignore` holding `*`); `ios-xtool/Resources/<Key>.bundle` (under `ios-xtool/.gitignore`).
- **Build:** a `pods` step after the early checks and before anything changes in the project; a `pod-binaries` staging
  step right before `rn-spm`; the scaffolder's `binary` route (fix 27); `-force_load` per archive on the App target of
  the regenerated root manifest; resource bundles written by `generate`; post-pack checks after `xtool-build`.
- **Scaffolder (fix 27).** The vendored copy is the working copy; both 0.88 patches are regenerated from it by the
  recipe in Global Constraints and stay byte-identical. No scaffold revision bump (preflight P15).

**Tech Stack:** TypeScript (Node 22.12+, ESM), vitest, `node:http` for the local test server, `node:zlib`, GNU `tar`
and `unzip` on the host, the toolchain's `llvm-ar` and `llvm-nm`, the `plist` package, `micromatch` (already a
dependency, loaded with `createRequire` as `podTable.ts` loads the scaffolder), SwiftPM 6.4 manifests, xtool 1.24.0.

**Spec:** `docs/design/specs/2026-11-04-binary-pods-design.md` (approved, commit cbd64c3). The owner's rulings on open
questions 1–9 are in `.superpowers/sdd/2026-11-05-binary-pods/progress.md` (git-ignored) and are restated below. The
research notes are kept outside the repo:
- `<scratchpad>/mlkit/mlkit-appauth-findings.md` (sections B–D; `scripts/resolve.py` is the CDN resolution this plan
  turns into code; `specs/` holds the JSON specs read on 2026-11-04);
- the survey "cocoapods_to_swiftpm.md" in the owner's research notes (CDN paths, SwiftPM's xcframework parsing,
  xtool's `ar`-magic check, d-date's pitfalls).

The spec's failure-walk rulings are binding. Block 2's spec and plan (`2026-11-04-library-compat*`, goal 3 and group C)
are the base this block extends.

## Rulings baked in (owner, 2026-11-05)

1. **OQ1, how a static binary reaches the link:** headers-only library-type xcframeworks (the ExpoModulesJSIHeaders
   shape, empty placeholder archive) for compiling, and the real thin `ar` archive linked once with `-force_load` on
   the App target. Fallbacks A (the real archive as the slice's `LibraryPath`, `-ObjC` only) and B (framework-type
   slices) are tried in the spike gate (Task G1) only if the proposed shape fails at link.
2. **OQ2, GoogleToolboxForMac:** the table pins 6.0.1 and marks the override as checked: a table field
   `outsideRequirement` turns block 2's ⚠ into one ℹ line with its text (Task D1).
3. **OQ3, scaffolded libraries' `resource_bundles`:** in scope, through the same builder (react-native-svg's
   `RNSVGFilters.bundle`; Tasks E1–E3).
4. **OQ4, other binary shapes** (dynamic frameworks, Swift binaries, `vendored_libraries`, compiled sources in an http
   pod, other source kinds): a clear stop naming the pod, the library and the file; follow-up block "binary pods: other
   shapes" (Tasks A2, A4, C4).
5. **OQ5, a library's own vendored binaries:** the async-storage 3.x `vendored-binaries` refusal stays. The wrap step
   takes a directory, not a download, so the follow-up block can feed it (Task C4's input).
6. **OQ6, doctor probes unresolved pods online,** within the 10 s budget the `rn-artifacts` line uses, with the same
   `not checked: <reason>` warning (Task F4).
7. **OQ7, the lock:** `rn-xtool-pods.lock.json` at the project root; unused entries kept and listed, never pruned
   (Tasks A5, F4).
8. **OQ8, download without asking:** yes, after the announcement line (vendor, count, MB, host, license, homepage,
   terms URL), with the committed lock as the record. No opt-in flag (Task F1).
9. **OQ9, Expo:** an Expo SDK 58 build-only proof if disk allows (Task G3); otherwise documented as build-unverified on
   Expo.

## Facts this plan rests on (checked in code at cbd64c3, 2026-11-05)

1. **The scaffolder ships twice. Both copies must stay equal** (block 2's Fact 1, unchanged).
   - `vendor/rn-spm/` is pristine React Native 0.88.0 plus `patches/react-native+0.88.0.patch` plus
     `vendor/rn-spm/rn-xtool-edits.patch` (E1–E5). The guards are `tests/vendor-rn-spm.test.ts`,
     `tests/patches.test.ts` "keeps the two react-native patches identical", `tests/patches-upstream.test.ts` and
     `tests/rn-scaffolder.test.ts` "the patched RN files carry the patch".
   - `tests/.cache` holds the 15 pinned tarballs of `tests/tarballs.json` in this worktree (react-native 0.85.0–0.88.1
     included), so the byte tests run, not skip.
   - Fixes 1–26 are taken (`docs/upstream/react-native-scaffolder.md` ends at 26), so the binary route is **fix 27**.
     `RN_XTOOL_SCAFFOLD_REVISION` and `SCAFFOLD_REVISION` are 4.
2. **The pod table** (block 2 group C).
   - `classifyPodDependency` (`vendor/rn-spm/spm/scaffold-package-swift.js:279-335`) returns `subspec`, `core`,
     `sibling`, `missing-sibling`, `expo`, `mapped` or `unmapped`.
   - `podTableEntry` (`:177-218`) throws for an entry without `url` and `exact`, so a `{ binary: … }` entry needs fix 27
     before the table file can carry one (preflight P3).
   - The marker is `// rn-xtool-pods: <pod>=<exact>, …` (`POD_PINS_MARKER`, `:173`; built at `:1843-1849`).
   - Scaffolds reach app files through `relFromManifest(…)`, relative to the `libs/<SwiftName>` symlink (`:2225-2250`,
     `localXcfwPackageDir: relFromManifest('build', 'xcframeworks')`).
   - rn-xtool's side: `mergedPodTable` and `writePodTable` (`src/project/podTable.ts`), `RN_SPM_POD_TABLE` in
     `rnSpmEnv`. `podRequirementSatisfied` (`podTable.ts:149-182`) treats a prerelease version or an unreadable
     requirement as met (it only feeds the pin ⚠), so the resolver needs a strict matcher (preflight P2).
   - The early checks' `Libraries.podDependencies` (`src/project/earlyChecks.ts:413-445`) yields each unconditional
     `s.dependency` of a library rn-xtool would scaffold, with its requirements and classification; `unmappedFailure`
     (`:497-512`) refuses `unmapped` ones; `scaffoldedPods` (`:615-634`) feeds the stale-pin check in
     `src/pipeline/patches.ts:364-473`.
3. **The xcframework helpers** (`src/pipeline/rnArtifacts.ts`).
   - `EMPTY_AR_ARCHIVE` (`:140`) is `!<arch>\n`. `headersXcframeworkInfoPlist(name, libs, {archive?})` (`:181-198`)
     writes `BinaryPath` = `LibraryPath` = `lib<name>-<slice>.a`, `HeadersPath: "Headers"`, the platform keys,
     `CFBundlePackageType XFWK` and `XCFrameworkFormatVersion 1.0`: the slice shape this block needs.
   - `readXcframeworkLibraries` (`:150-175`) returns the platform fields only, not `LibraryPath` or `HeadersPath`
     (preflight P8).
   - `swapIn(tmp, dest, old)` (`:459-474`) is the whole-tree swap. `writeJsiHeadersXcframework`
     (`src/pipeline/jsiHeaders.ts:75-145`) assembles per pid, deletes the stamp, swaps, writes the stamp last, and keeps
     the module map at `Headers/<Name>/module.modulemap` (`:123-127`).
4. **Downloads** (`src/tools/download.ts`, not `src/pipeline/`).
   - `downloadFile(url, dest, {minBytes?, mode?, sha256?})` streams to `<dest>.<pid>.part`, retries once, times out
     after 15 minutes, and rejects `size <= minBytes` with `minBytes ?? 1024 * 1024` (`:25`, `:35`).
   - It sends no custom header (no `User-Agent` option), does not compare with `Content-Length`, folds the network cause
     into its message (`Could not download <url>: fetch failed`), and its checksum text points at `src/versions.ts`
     (`:39`). Task B1 extends it; the pods code verifies hashes itself (preflight P7).
5. **Tools.**
   - `toolEnv()` (`src/tools/exec.ts:25-34`) puts `~/.local/share/swiftly/bin` first on PATH. That folder holds
     `llvm-ar` and `llvm-nm` (swiftly proxies; LLVM 21.0.0 in Swift 6.4.1), `llvm-ar --format=darwin` is supported, and
     the toolchain has no `llvm-lipo`.
   - `makeNmRunner` and `LLVM_NM_MISSING` (`src/pipeline/symbols.ts:15-33`) are the pattern for an `llvm-ar` runner;
     doctor's `llvm-nm` line is `src/commands/doctor.ts:540`.
   - The xtool Darwin SDK is `sdkBundle()` (`src/commands/setup.ts:142`) +
     `Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk`; frameworks are
     `System/Library/Frameworks/<X>.framework/<X>.tbd`, libraries `usr/lib/lib<x>.tbd`.
   - `checkSetupSpace`'s free-space probe and wording (`src/commands/setup.ts:66-109`) are reused for the disk gate.
6. **Resources today.**
   - `writeIosXtool` removes `ios-xtool/Resources` on every build (`src/generate/iosXtool.ts:192-197`), stages the bare
     app's resources there, and lists them as `Resources/<name>` after `Frameworks`, `ip.txt` and, with expo-constants,
     `EXConstants.bundle` (`:245-252`; `BASE_RESOURCES`/`DEFAULT_RESOURCES` in `src/generate/xtoolYml.ts:11-12`).
     `EXConstants.bundle` itself is written by the `app-config` step at `ios-xtool/EXConstants.bundle`
     (`src/pipeline/appConfig.ts:12`). `ios-xtool/.gitignore` is `*` (`iosXtool.ts:273`).
   - The bare copier refuses two resources with one destination (`src/generate/bareSources.ts:116-124`).
   - xtool copies each `resources:` entry to the app root with `FileManager.copyItem`, under its last path component
     (`packFileToRoot`, `Sources/PackLib/Packer.swift:135-141` in the local xtool checkout at 952a7ff). `copyItem` keeps a
     symlink a symlink and fails on an existing destination, so bundles hold regular files or hard links, and names must
     not collide (preflight P10).
   - Block 2's `unbundledResources` (`src/pipeline/scaffoldResources.ts:94-108`) reads names only, from
     `autolinking.json` after `rn-spm`.
7. **The build's order** (`src/commands/build.ts:233-426`): config → `excludeLines` → `installFailures` +
   `libraryFailures` (stop) → `podPinWarnings` → `readProject` → [`prebuild`] → entitlements check → [`clean`, bare] →
   `patches` (+ `fixLibraryManifests`) → `rn-artifacts` → [`jsi`, SDK 57] → `rn-spm` → the `ℹ Not copied` line → `jsi`
   → `app-config` → `frameworks` → Metro port and LAN IP → `depsFingerprint` → `generate` → `xtool-build` → state with
   the fingerprint. `buildSteps` (`:82-100`) plans the optional steps; `depsFingerprint` (`src/deps.ts:83-104`) does not
   read the lock (preflight P14).
8. **xtool's packer** (`Packer.swift:155-180` at 952a7ff, the same logic as the spec's 2af0b67): a binary target's
   `<name>.framework/<name>` is read from the build directory; missing → skipped; `!<arch>\n`/`!<thin>\n` → not
   embedded; anything else → `Frameworks/` and signed. A library-type slice never has that file (ExpoModulesJSIHeaders
   already builds this way).
9. **The ML Kit inputs on disk:** the npm package at
   `<scratchpad>/swt-check/x-react-native-ml-kit-text-recognition-2.0.0/package` (podspec as spec fact 1;
   `ios/TextRecognition.m:3-9` does seven `@import`s, the first of a submodule, `MLKitVision.MLKVisionImage`), and the
   F1 proof app `<scratchpad>/f1-proof/F1Proof` (bare 0.88.1 with block 2's five libraries, a scratch git history, and
   uncommitted F2 changes today).

## Global Constraints

- Linux, Node 22.12+, Swift 6.4, xtool 1.24.0 (`XTOOL_VERSION`) and `IOS_MIN` 16.4 stay unchanged. **No new npm
  dependency** (`micromatch` is already one).
- **Network.**
  - The early checks stay offline (spec goal 5.1): they read the lock and the spec cache, never the network.
  - The `pods` step is the only new network user in `build`. With the lock and a full cache it makes **no request**,
    unless a spec's URL differs from the lock's: spec goal 1.7 wins, so that file is downloaded once and checked
    against the locked sha256 (review M-5).
  - `doctor --project` probes unresolved pods within the existing 10 s budget (OQ6), never with `--offline` or
    `--report`.
  - **No test touches the network.** The CDN and the download host are a `node:http` server on `127.0.0.1:0` serving
    hand-written fixtures (`tests/support/podsServer.ts`). A closed port stands for "offline".
- **No Google byte in the repository.** Fixtures are synthetic: hand-made Mach-O objects, fat files and `ar` archives
  (`tests/support/macho.ts`), hand-made tar and zip files (`tests/support/archives.ts`), and hand-written JSON specs in
  ML Kit's shape (`tests/fixtures/pods/specs/`: names, versions, requirements, sources, attributes and the license
  object as in spec fact 2; no description text). Nothing from `<scratchpad>/mlkit/dl/` is copied. Task F6's test keeps
  the npm package free of Mach-O and `ar` files.
- **The two copies of the scaffolder.** Task D2 changes `vendor/rn-spm/spm/scaffold-package-swift.js` and ends with
  this sync before its commit. It is run by hand; nothing of it is committed.
  ```sh
  T=<scratchpad>/plan-binpods/rnpatch; rm -rf "$T"; mkdir -p "$T/x" "$T/a/node_modules/react-native" "$T/b/node_modules/react-native/scripts"
  tar -xzf tests/.cache/react-native-0.88.0.tgz -C "$T/x" package/scripts/setup-apple-spm.js package/scripts/spm \
    package/scripts/codegen/templates/Package.swift.spm-template
  cp -a "$T/x/package/scripts" "$T/a/node_modules/react-native/scripts"
  cp -a vendor/rn-spm/setup-apple-spm.js vendor/rn-spm/spm vendor/rn-spm/codegen "$T/b/node_modules/react-native/scripts/"
  patch -R -p1 -F0 -d "$T/b/node_modules/react-native/scripts" -i "$PWD/vendor/rn-spm/rn-xtool-edits.patch"
  (cd "$T" && git diff --no-index --no-color --src-prefix= --dst-prefix= \
     a/node_modules/react-native/scripts b/node_modules/react-native/scripts) > "$T/rn.patch"
  cp "$T/rn.patch" patches/react-native+0.88.0.patch && cp "$T/rn.patch" patches/react-native+0.88.1.patch
  ```
  - If the reverse patch fails, the change moved the context of an E-edit: follow `docs/RELEASING.md` "Scaffolder
    changes" step 2 (a fresh `b/`, the reverse without `-F0`, no `.rej` left, `rn-xtool-edits.patch` regenerated), then
    rerun the sync.
  - Then `npx vitest run tests/vendor-rn-spm.test.ts tests/patches.test.ts tests/patches-upstream.test.ts
    tests/rn-scaffolder.test.ts`. **None of the provenance, identical-patch, upstream or "carry the patch" tests may
    report as skipped**; check the vitest summary.
  - Fix 27 adds one hunk test to "the patched RN files carry the patch" (`tests/rn-scaffolder.test.ts`).
- **Scaffold revision:** stays 4. Fix 27 adds content only to libraries with binary pods, which every earlier release
  refused (block 2's P14 rule). A scaffold persisted under `knownLimits.allow` without the route gets Task D3's stale
  line instead (preflight P15).
- **Portable manifests.** No persisted manifest, forwarder or marker holds an absolute path or a binary pod's version.
  The scaffold's `.package(path:)` is relative to the `libs/<SwiftName>` symlink. The absolute `-force_load` paths live
  only in `ios-xtool/Package.swift`, regenerated on every build and never persisted. Tests assert both (D2, D5).
- **Writes.** This block writes nothing under `node_modules`. Cache trees: a temporary tree per pid
  (`<dest>.tmp-<pid>`), swapped in whole, stamp last; a destination that appears meanwhile with a valid stamp wins, and
  the temporary tree is removed (concurrent builds, row 62). The lock is written through `<file>.<pid>.tmp` + rename,
  only when the `pods` step succeeds.
- **Texts.**
  - User-facing texts in this plan are verbatim: `ℹ`/`⚠` lines, errors and stops. `${…}` marks a value. `${link}` is
    `troubleshootingUrl("cocoapods-binaries")` unless a task names another anchor. `${cache}` is the pods cache folder
    with the home folder shown as `~` (`tilde` from `setup.ts`, exported in Task A3). `${lib}` is the npm package name.
  - Sizes: decimal units, `30.3 MB` (one decimal) from 100 KB up, `7 KB` below, `size unknown` without a length
    (`formatSize` in `src/pods/format.ts`, Task A3).
  - A doctor line is the same text without its leading `ℹ `/`⚠ `, with status info/warn.
  - The first task that emits `${link}` (A3) adds a minimal `## CocoaPods binaries` section to
    `docs/troubleshooting.md` (one sentence), so `tests/docsLinks.test.ts` stays green; Task H fills it.
- **Privacy.** No absolute home path (a planted home is `/home/me`), Team ID, UDID, e-mail or real IP in committed
  files; `<scratchpad>` placeholders in docs and plans.
- **Proof runs** (G1–G3).
  - In `<scratchpad>/f1-proof/F1Proof` (kept; reset between steps to the Task 0 commit of its scratch history), with the
    worktree's CLI: `npm run build`, then `node <worktree>/bin/rn-xtool.js <cmd>`.
  - Delete `ios-xtool/.build` after each build, after recording its size. No reference app (`../app`, `../app-bare`, …)
    is modified.
  - Approved downloads: the ten ML Kit tarballs (40.3 MB) and SwiftPM's clones of gtm-session-fetcher,
    GoogleUtilities, GoogleDataTransport, google-toolbox-for-mac, nanopb and promises. Anything else (the Expo SDK 58
    template, the work-app libraries of G2 step 8) needs the owner's OK first.
  - Stop and report when the build disk has less than 8 GB free.
- **Commits.**
  - Every task ends with `npm test && npm run lint` green, then `git add <files>`, `npm run scan:private`, and the commit
    with the task's subject.
  - Conventional Commits in English, the subject given in the task (≤ 50 characters), no body, one logical change, no
    scratch code. The commit hook rejects `fixup!` subjects.
  - Never push, rebase, amend or stash. Tasks 0, G1–G3, I and J are run by the controller with the owner.
- **PR slicing (recommended: one PR).**
  - **PR 3 = A–F and H**, from `feature/binary-pods`, opened after G2 passes, once PR 2 (`feature/library-compat`) is
    merged and the owner has moved this branch onto `main`. G1's and G2's results go in the PR body. I can follow the
    merge, as block 2's device pass did.
  - Why one PR: A–C have no caller until F, so a PR of A–C alone ships unreachable code that cannot be checked end to
    end; the failure walk is one process from the CDN to the device, and the reviewer's three-ways question needs every
    hop in view; and two PRs stacked on an unmerged PR 2 double the moves onto `main`.
  - Possible split, if the owner prefers smaller reviews: **PR 3a = A–C** (library code with unit tests, plus C2's
    `llvm-ar` doctor line, the only user-visible change), with G1's spike result in its body; **PR 3b = D–H**. The split
    point is C4's commit: the controller runs `git branch --no-track feature/binary-pods-core <C4 sha>` without
    switching, and the owner pushes it with `git push -u origin feature/binary-pods-core` (`@{u}` must print
    `origin/feature/binary-pods-core`).

### Failure-walk owners (spec rows 1–92)

| # | Ruling | Owner |
|---|---|---|
| 1 | handle | Task F3 `passes a pod the lock records`, `passes a pod whose cached spec is binary`, `refuses a pod whose cached spec is a git source without a table entry`, `does not refuse a pod it cannot route offline, and prints the ℹ line` |
| 2 | handle | Task A3 `names the host, the reason and the cache when the CDN cannot be reached`; Task F2 `stops on an unreachable CDN before anything changes` (no prebuild, patches or rn-spm call) |
| 3 | handle | Task A3 `stops on a 404 naming the pod, the version, the URL and the library`, `stops when the version list does not name the pod` |
| 4 | handle | Task A3 `follows the redirect and sends rn-xtool's User-Agent` (the local server answers 403 without it), `names the HTTP status of any other answer` |
| 5 | accept | Task A3 plan note: a version's spec is cached and never fetched again; trunk freezes on 2026-12-02 |
| 6 | accept | Task A3 plan note; Task H troubleshooting: a machine without the cache needs the CDN once, and machines with the cache and the lock keep building |
| 7 | handle | Task A2 `names the pod and the key of a value it cannot read` (it.each per key), `ignores keys that do not change the build` |
| 8 | handle | Task A4 `lists each requirement and who imposed it when no version satisfies them all` |
| 9 | accept | Task A4 plan note (greedy, no backtracking, spec Non-goals); Task H troubleshooting shows `exclude` |
| 10 | handle | Task A1 `picks a prerelease only when a requirement names one`; Task A4 `resolves MLImage 1.0.0-beta7 for its exact requirement` |
| 11 | handle | Task A4 `keeps the locked version while it satisfies the requirements`, `resolves again when the locked version no longer satisfies them`; Task F1 `prints the re-resolved line and records the new version`; capabilities `does not report a locked version the library no longer accepts as ready` (E/F review M4) |
| 12 | handle | Task A4 `stops on a source pod without a table entry, with the chain`; resolve `drops a source pod every library that reaches it is allowed for …`, step `leaves it out with the allowed warning …`, `does not warn again for a pod the early checks already allowed`, build `hands knownLimits.allow to the pods step …`, capabilities `fails with the resolver's refusal, not a not-checked warning`, `warns once for a library knownLimits.allow names` (E/F review I1) |
| 13 | handle | Task D1 `marks the GoogleToolboxForMac override as checked: one ℹ line, no ⚠`, `warns about a pin outside a binary pod's requirement` |
| 14 | handle | Task D1 `maps every subspec ML Kit's graph reaches to a product` |
| 15 | accept | Task B2 `stops on a 404 or 410 naming the host, the URL and the pod` (the text says a machine with the cache keeps building); Task H troubleshooting |
| 16 | handle | Task B1 `retries a body shorter than Content-Length, then names both sizes`, `accepts a body equal to the expected size` |
| 17 | handle | Task B1 `accepts a 7 KB file when the expected size says so`; Task B2 `downloads MLImage's small archive` |
| 18 | handle | Task B2 `deletes a file whose sha256 differs from the lock and stops without a retry`; Task F1 `leaves the project and the lock as they were on a mismatch`; Task G2 step 4 |
| 19 | handle | Task B2 `updates the URL when the moved file has the locked sha256`, `treats a moved file with another sha256 as a mismatch`; Task F1 the ℹ moved line |
| 20 | accept | Task B2 `checks a spec's own sha256 or sha1 when it names one`; Task H troubleshooting (present tense: the first download is trusted on first use, over HTTPS, and the lock records it) |
| 21 | accept | Task B1 plan note: `downloadFile`'s 15-minute timeout and its message, unchanged |
| 22 | handle | Task B3 `refuses an absolute path, a .. segment, a device file and a link that leaves the tree` (crafted tar and zip, it.each) |
| 23 | handle | Task B4 `names the expected path and the archive's top-level entries when a vendored path is missing`, `strips the top-level folder of a flatten archive` |
| 24 | handle | Task B3 `names sudo apt install unzip for a zip without unzip`; Task F4 `adds the unzip line only when a lock entry is a zip` |
| 25 | handle | Task B4 `rebuilds a tree without its stamp`, `writes the stamp last` |
| 26 | handle | Task C1 `has no arm64 slice in an x86_64-only or arm64e-only file`; Task C4 `stops on a framework without an arm64 device slice` |
| 27 | handle | Task C1 `reports a simulator platform in an object and in an archive member`; Task C4 `stops on a simulator slice` |
| 28 | defer | to the follow-up block "binary pods: other shapes"; Task C4 `stops on a dynamic framework` (goal 2.6's text) |
| 29 | defer | to the same block; Task C4 `stops on a Swift framework` |
| 30 | handle | Task C3 `generates a module map from the umbrella header`, `stops without a module map and without an umbrella header` |
| 31 | handle | Task C3 `stops on a private module map or a framework submodule`; Task G1 (fallback B keeps Google's maps unchanged if the rewrite fails at compile) |
| 32 | handle | Task C4 `every staged archive starts with !<arch>` (invariant over fat, thin, `ar` and object inputs) |
| 33 | handle | Task C2 `names rn-xtool setup when llvm-ar is missing`, `names the pod and the object when llvm-ar fails`, doctor `prints the llvm-ar line after llvm-nm` |
| 34 | handle | Task C1 `accepts an object without a platform load command`; Task G1 (lld links it) |
| 35 | handle | Task C4 `warns about a minos newer than IOS_MIN`, `warns about a spec platform newer than IOS_MIN` (⚠, not a stop) |
| 36 | handle | staged files are copies (row 85), so no hard link crosses filesystems; Task D4's `linkOrCopy` is gone |
| 37 | handle | Task F2 `stages pod-binaries on every build before rn-spm`, `stops when staging fails`; build `restagePods (row 37)` (`stages pod-binaries again from the cache when it is gone`, `writes a pod's bundle again when ios-xtool/Resources lost it`, `stops when the binary pods changed since the build`), install `stages the pod binaries again if needed, then checks the app …` (final review, three-ways #2); Task H docs name rn-xtool as the only entry point |
| 38 | handle | Task D4 `stops on two binary pods that make one module`; Task E3 `stops on two bundles with one name`, `stops on a bundle named like an app resource` |
| 39 | handle | Task D2 `the binary route holds no absolute path` (the scaffolder's no-absolute-path test, extended) |
| 40 | handle | Task D6 `does not persist a patch with a GIT binary patch hunk, and says so`; nothing is written under node_modules (Global Constraints); `fails closed when it cannot read the patch it names`, `checks every patch file of the library that changed, whatever name it printed` (group D review M2) |
| 41 | accept | no revision bump in this block (preflight P15); Task D3's stale line covers a scaffold persisted before the route; Task H CHANGELOG "Upgrading" says to delete and rebuild it |
| 42 | handle | Task C3 `writes the Info.plist headersXcframeworkInfoPlist writes, and reads back`; Task D4 `names binary targets, folders and module maps from one source`; Tasks G1, G2 |
| 43 | handle | Task D4 `lists the binary targets in the product itself`; Tasks G1, G2 |
| 44 | handle | Task D5 `links each archive once, by -force_load only, and never -all_load`; Task G1; Task G2 step 8 |
| 45 | handle | Tasks G1, G2 (`_OBJC_CLASS_$_GTMLogger` in the binary); Task F5 check 3 |
| 46 | handle | Task F1 `stops before downloading when a framework or library is not in the SDK` |
| 47 | accept | Task G2 step 2 records it; Task H states the result in the present tense |
| 48 | accept | Task H troubleshooting: a clean `.build` needs GitHub once for the source packages (block 2's row 24) |
| 49 | accept | Task H troubleshooting: the pod table is the one place to align pins (block 2's row 25) |
| 50 | handle | Task F5 `stops on a binary target embedded under Frameworks/`; library-type slices (Task C3) |
| 51 | handle | Task F5 `stops on a missing bundle or a bundle without Info.plist` |
| 52 | handle | Task E1 `writes CocoaPods' Info.plist keys`; Task I (install and launch) |
| 53 | accept | Task G2 measures the growth; Task H `docs/libraries.md` states it in the present tense |
| 54 | handle | Task F5 check 1; Task I (the first `recognize()` shows no "Invalid model path.") |
| 55 | handle | Task D5 (`-force_load`); Task F5 check 3; Task I |
| 56 | handle | Task I decides; the slice is an archive (Task C4), so d-date's relink-as-dynamic cause does not apply |
| 57 | accept | Task C4 `records the privacy manifests inside frameworks`; Task F1 `names the privacy manifests left inside frameworks in one ℹ line` |
| 58 | accept | Task H docs (rn-xtool's minimum 16.4, ML Kit's 15.5); row 35 covers the general case |
| 59 | handle | Task F1 `stops before the first download when the cache's filesystem is short`, `counts 8 bytes of disk per downloaded byte …` (G2), `sizes the disk check from the lock when HEAD gives no length` (E/F review M3), `announces and checks the disk for a cached file that fails its re-hash …` (E/F review M2); step `with the project on another filesystem than the cache (row 59)` (`checks the project's filesystem for the per-app copies`, `checks the cache's filesystem for the downloads and their trees only, …`) (final review M5) |
| 60 | accept | Task H troubleshooting: deleting `~/.cache/rn-xtool/pods` is safe; later builds download again and verify against the lock; trees from an older `EXTRACTOR_VERSION` or `WRAPPER_VERSION` stay until then |
| 61 | accept | Task G2 measures `.build`; Task H states it |
| 62 | handle | Task B2 `two downloads of one file both end with one cached copy`; Task B4 `two extractions of one archive both succeed`; Task C4 `reuses a stamped tree` |
| 63 | handle | Task D4 `writes a .gitignore with * in pod-binaries`; Task E3 (the bundles sit under `ios-xtool/`, whose `.gitignore` is `*`) |
| 64 | accept | Task H docs: the cache holds the vendor's files and must not be published (no CI cache of it) |
| 65 | handle | Task F6 `npm pack ships no Mach-O or ar file`; `docs/RELEASING.md` item 4 |
| 66 | handle | Task F1 `announces vendor, count, size, host, license, homepage and terms before the first download`; Task H names the ML Kit Terms |
| 67 | handle | Task F2 `does no pods work for an excluded library`; Task F4 `lists the lock entries no library needs` |
| 68 | accept | Task F2 plan note (block 2's rule: a persisted scaffold of an excluded library stays applied and is harmless) |
| 69 | accept | Task A5 `names a lock with merge conflict markers` (keep either side); Task H troubleshooting |
| 70 | handle | Task A2 `routes each source shape: a framework with glue sources`, `… a framework with a vendored library` (review fix I3) |
| 71 | handle | Task A4 `reads the version index again on a pod's first resolution, and not for a locked pod` (review three-ways #2), `reads the version index again when a locked version no longer satisfies` |
| 72 | handle | Task B2 `refuses a redirect from https to plain http that the lock does not record`, `follows a redirect to plain http when the lock records the file, and checks it`; Task B1 `refuses a redirect from https to plain http when asked, without a retry` (review three-ways, group B) |
| 73 | handle | `src/pods/sweep.ts` `removes temporary files and trees older than 24 h, and keeps the cache's entries`, `keeps temporary files a running build may still use`; Task F1 calls `sweepStaleTemps` first (review three-ways, group B) |
| 74 | accept | Task B4 plan note: a build that reads `extracted/<sha256>-<stamp hash>` while another swaps the same tree in can miss it for two renames; building again passes (review three-ways, group B) |
| 75 | accept | Task H troubleshooting: Node's fetch ignores `HTTPS_PROXY`; `NODE_USE_ENV_PROXY=1` (Node 24) or a machine with the lock and a full cache (group B review, three-ways #1) |
| 76 | handle | Task B2 `downloads again a locked file whose cached bytes changed`, `syncs a download and its folder before it counts as cached`; Task A3 `syncs a cached spec and its folder`; Task B4 `rebuilds a stamped tree when a file lost its bytes`, `… when a file is missing`, `syncs the stamp and the tree's folder`; Task C4 `rebuilds a stamped tree whose files changed` (group B review, three-ways #2) |
| 77 | handle | Task C3 `stops on an umbrella directory ("Headers")`, `stops on a path relative to the framework (…)`; fallback B documented in Task H (group C three-ways #1) |
| 78 | handle | Task C4 `stops on two vendored frameworks with one name, naming both` (group C three-ways #2) |
| 79 | handle | Task C4 `rebuilds a tree stamped by another WRAPPER_VERSION`; `docs/RELEASING.md` "Binary pods" (group C three-ways #3); `keys the tree by the extractor's version too` (group C review M4) |
| 80 | handle | Task D5 `turns off relative method lists only when binary pods are linked` (G1 ruling 3); Task G2 step 2 |
| 81 | handle | Task D1 (`emptyTargets: ["GTMDefines"]`); Task D5 `writes <Target>.o where Swift Build links it, and keeps one that is there` (only its own object, row 84), `is byte for byte what clang writes for an empty C file`, build `hands the linked table pods' empty targets to generate` (G1 ruling 4); Task F2 adds the resolved source pods' entries; Task G2 step 2; podTable `does not carry the shipped outsideRequirement and emptyTargets over a config pin of another version`, `clears the shipped emptyTargets with a config's empty list`, config `reads pods` (final review M3) |
| 82 | handle | Task A2 `refuses a … path that leaves the pod's folder` (it.each per key); Task C4 `stops on a slice whose … leaves the xcframework` (group C review M2) |
| 83 | handle | Task C4 `stops when source_files match no header`, `stops on a source file the tree does not hold`, `stops on a module_map the tree does not hold` (group C review M3); `reads a source_files folder as the headers below it, as CocoaPods does`, extractPod `reads a kept folder written with a trailing slash as the folder` (group D review M6) |
| 84 | handle | emptyTargets `rewrites an object that is not the builder's (row 84)` (group D review M1) |
| 85 | handle | stage `writes the package, copies from the cache …` (an edit in the staged package never reaches the cache), resourceBundles `copies and never writes a symlink` (group D review M3) |
| 86 | handle | resourceBundles `keeps .lproj folders when a glob flattens`, `copies a folder a glob matches whole, under its name`; scaffoldResources `leaves a scaffolded bundle that would hold one name twice to the ℹ line …`; build `names a scaffolded bundle that would hold one file name twice in the ℹ line, and builds on without it` (E/F review I2) |
| 87 | handle | stage `keeps the cache's modification times on the staged copies …`, resourceBundles `keeps the source's modification time on the copies` (E/F review M1); stage `keeps the generated files' modification times when their content is unchanged (row 87)`, resourceBundles `keeps the Info.plist's modification time when its content is unchanged (row 87)` (owner ruling) |
| 88 | handle | postPack `removes the packed app and its .ipa when a check fails` (E/F review M6); build `runs the checks after xtool-build only with binary pods` (records them in the state); install `checks the app xtool builds before xtool dev run installs it`, `does not install over USB when the checks refuse the app`, `checks the app before xtool builds the ipa, and does not install a refused one over Wi-Fi` (owner ruling) |
| 89 | handle | cdn `reads once more after a reset or a 5xx answer`, `stops as before when the second read fails too, and reads a 4xx answer once`; fetch `downloads once more after a reset or a 5xx answer (row 89)`, `stops after a second reset with goal 5.4's text` (E/F review three-ways #3) |
| 90 | handle | install `writes the empty target objects the build recorded before xtool dev run (row 90)`, `… before xtool builds the ipa (row 90)`; build `hands the linked table pods' empty targets to generate …` (records them in the state) (G2 finding A) |
| 91 | handle | step `leaves out a pod the early checks allowed before any CDN read (row 91)`, `needs no CDN when the early checks allowed every pod` (final review I1) |
| 92 | accept | Task H troubleshooting: Node's fetch trusts its own CA list; `NODE_EXTRA_CA_CERTS=<file.pem>`, with the error text users see, next to the proxy bullet (final review, three-ways #1) |

## Review Focus

1. With the lock and a full cache, the `pods` step makes no request (Task F1 `makes no request with the lock and a full
   cache`; Task G2 step 3). The one exception is a spec URL that differs from the lock's (goal 1.7; Task B2 `downloads
   a locked, cached file from its spec's new URL and checks it against the lock`).
2. Nothing Google ships reaches the repository, `patches/`, `node_modules` or the npm package (Tasks D4, D6, F6; G2
   step 2's `git status`).
3. Every download is checked against the lock before use, and a mismatch is never retried or used (Task B2).
4. The early checks stay offline, and they still refuse what block 2 refused for a git-source pod without a table
   entry (Task F3).
5. The two copies of the scaffolder are equal, and a persisted scaffold holds no absolute path and no binary pod's
   version (Task D2).
6. Builds without binary pods are unchanged: the root `Package.swift`, `xtool.yml` and the step list are byte-identical
   (Tasks D5, E3, F2).
7. Each archive is linked once, by `-force_load` only (Task D5).
8. Before the final verdict, the reviewer answers without hints: "Name three ways this fails in production that no test
   covers." Any answer not in the spec's failure table goes to the owner as a decision, not to the implementer as a fix.

---

### Execution order

Task 0 → A1–A5 → B1–B4 → C1–C4 → **G1 (the spike gate)** → D1–D6 → E1–E3 → F1–F6 → G2 → G3 (optional) → H → I → J.

G1 runs right after C, before any of D is written. It proves the link shape with hand-staged files (or picks fallback A
or B), so D implements a shape already known to link and to keep its classes.

### Task 0: Preparation (controller with the owner)

No commit.

- [ ] **Step 1.** `ls tests/.cache` lists the 15 tarballs of `tests/tarballs.json`; `npx vitest run
  tests/vendor-rn-spm.test.ts tests/patches-upstream.test.ts` passes with no skipped test.
- [ ] **Step 2.** In `<scratchpad>/f1-proof/F1Proof`: `git add -A` and a scratch commit "f2 final" in the app's own
  history (never pushed). Record its sha. Every proof step resets to it with `git reset --hard <sha>` and `git clean -fdx
  -e node_modules`, then `npm ci` only when `package-lock.json` changed.
- [ ] **Step 3.** In `<scratchpad>/binpods/`: `npm pack <scratchpad>/swt-check/x-react-native-ml-kit-text-recognition-2.0.0/package`
  → `react-native-ml-kit-text-recognition-2.0.0.tgz` (a local folder: no network).
- [ ] **Step 4.** `df -h` on the build disk shows at least 8 GB free (12 GB on 2026-11-05); `~/.cache/rn-xtool/pods`
  does not exist yet.

---

## A. CDN spec client, versions and the lock

All code in `src/pods/`, tests in `tests/pods/`. The local server helper is written in A3 and used from then on:

```ts
// tests/support/podsServer.ts
// startPodsServer(routes: Record<string, Route>): Promise<{ base: string; requests: string[]; close(): Promise<void> }>
//   Route = { status?: number; body?: string | Buffer; headers?: Record<string, string>; redirect?: string;
//             needsUserAgent?: string }   // 403 when the request's User-Agent does not start with it
//   `requests` records "METHOD path" per request, so a test can assert that none was made.
```

### Task A1: CocoaPods versions with prereleases

**Files:** Create `src/pods/versions.ts`; modify `src/project/podTable.ts` (one doc sentence). Test:
`tests/pods/versions.test.ts`.

**Interfaces:**
```ts
export class RequirementError extends Error {}   // message: the requirement, quoted
/** Gem::Version order over the segments /[0-9]+|[A-Za-z]+/ of the trimmed text: a letter segment sorts before any
 *  number, so 1.0.0-beta7 < 1.0.0; a missing segment counts as 0. */
export function comparePodVersions(a: string, b: string): number;
export function isPrerelease(version: string): boolean;   // it has a letter segment
export interface Requirement { op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "~>"; version: string }
/** Items trimmed and split at commas; a bare version is "="; [] means any version. Throws RequirementError for an
 *  item it cannot read (an interpolation, an unknown operator). */
export function parseRequirements(items: readonly string[]): Requirement[];
/** `~> a.b.c` is >= a.b.c and < a.(b+1); `~> a.b` is >= a.b and < (a+1); `~> a` is >= a and < (a+1); prerelease
 *  segments are dropped from the upper bound, as Gem::Version#bump drops them. */
export function satisfiesAll(version: string, reqs: readonly Requirement[]): boolean;
/** The newest of `versions` that satisfies `reqs`; prereleases only when a requirement names one (CocoaPods). */
export function newestSatisfying(versions: readonly string[], reqs: readonly Requirement[]): string | undefined;
```
- Plan note: block 2's lenient `podRequirementSatisfied` stays as it is for the pin lines (it never warns about what
  it cannot read). Its doc comment gains one sentence naming `satisfiesAll` as the strict matcher the resolver uses.
- Plan note (group B review M-6, accept): the order is RubyGems' `Gem::Version` (a dash reads as `.pre.`, so
  `1.0.0-1 < 1.0.0`), not CocoaPods' `Pod::Version`, which orders `1.0.0-1` above `1.0.0`. Only a requirement that
  names a prerelease reaches the difference; prerelease detection matches CocoaPods.

- [ ] **Step 1: Write failing tests:**
  - `orders versions as Gem::Version does` (it.each: `1.0.0-beta6 < 1.0.0-beta7 < 1.0.0`, `13.0 = 13.0.0`,
    `2.30910.0 < 3.30910.0`, `9.0.0 > 8.10.0`);
  - `reads string and array requirements, trimmed` (`"~> 13.0"`, `[">= 3.3.2", " < 4.0"]`, `[" 1.0.0-beta7"]`, `[]`,
    `">= 1, < 2"`);
  - `applies ~> with one, two and three segments`;
  - `picks a prerelease only when a requirement names one` (row 10): versions `["0.9.0", "1.0.0-beta6",
    "1.0.0-beta7"]`; `>= 0.1` → `0.9.0`; `= 1.0.0-beta7` → `1.0.0-beta7`;
  - `throws RequirementError for an unreadable requirement` (`"#{v}"`, `"=> 1"`).
- [ ] **Step 2: Run** `npx vitest run tests/pods/versions.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: compare CocoaPods versions"`

### Task A2: Parse the CDN's JSON specs

**Files:** Create `src/pods/spec.ts`, and the fixtures `tests/fixtures/pods/specs/<Pod>/<version>.podspec.json` for the
pods of spec fact 2 (plus nanopb and PromisesObjC, which no test may request), hand-written in ML Kit's shape. Test:
`tests/pods/spec.test.ts`.

**Interfaces:**
```ts
export interface PodSource { http?: string; git?: string; tag?: string; type?: string; flatten?: boolean; sha256?: string; sha1?: string; other?: string }
export interface SpecLayer {
  dependencies: Record<string, string[]>;          // "GoogleMLKit/MLKitCore" → []; items trimmed
  vendoredFrameworks: string[]; vendoredLibraries: string[];
  sourceFiles: string[]; preservePaths: string[]; moduleMap?: string;
  resourceBundles: Record<string, string[]>; resources: string[];
  frameworks: string[]; weakFrameworks: string[]; libraries: string[];
}
export interface PodSpecNode { name: string; layer: SpecLayer; subspecs: PodSpecNode[]; defaultSubspecs?: string[] }
export interface PodSpec extends PodSpecNode {
  version: string; source: PodSource; license: { type?: string; text?: string }; homepage?: string;
  authors: string[]; moduleName?: string; iosMin?: string;
}
export class PodSpecError extends Error {}
export function parsePodSpec(json: unknown, where: { pod: string; version: string }): PodSpec;
//   Every attribute may be a string or a list (normalised to a list); `ios: {…}` is merged into its layer; osx, tvos,
//   watchos and visionos are ignored; keys rn-xtool does not use are ignored. `authors` is a string, a list or an
//   object (its keys).
export function selectedLayers(spec: PodSpec, subspecs: readonly string[]): { layers: SpecLayer[]; used: string[] };
//   The root layer, then each named subspec ("TextRecognition", "A/B") with its parents. Naming the root selects
//   default_subspecs, or every subspec when there is none (CocoaPods). Dependencies on "<Pod>/<sub>" of the same pod
//   are followed; `used` lists the subspec paths taken, sorted.
export type PodRoute = { kind: "binary"; headersOnly: boolean } | { kind: "source" } | { kind: "other"; what: string };
export function podRoute(spec: PodSpec, layers: readonly SpecLayer[]): PodRoute;
//   http source (type absent, "tgz" or "zip"; a URL ending in .tar.gz, .tgz or .zip): vendored_frameworks → binary;
//   else vendored_libraries → other; else a non-header source_files entry (.m .mm .c .cc .cpp .swift) → other; else
//   binary, headersOnly. A git source → source. Anything else → other.
```
- Texts:
  - `PodSpecError` (row 7): `The spec of ${pod} ${version} has a "${key}" value rn-xtool cannot read (${the value as JSON, first 80 characters}). See ${link}`
  - The `other` routes' `what`, used by goal 2.6's stop (Task A4): `ships vendored libraries (${file})`, `compiles
    sources (${file})`, `is a ${type} download (${url})`, `comes from a ${key} source, which rn-xtool cannot download`.

- [ ] **Step 1: Write failing tests:**
  - `reads string and array requirements and trims their items` (MLKitVision's fixture);
  - `selects default_subspecs when the root is named, and every subspec without them`;
  - `follows a subspec's dependency on another subspec of the same pod` (`GoogleMLKit/TextRecognition` → `MLKitCore`,
    whose layer holds `MLKitCore/Sources/MLKit.h`);
  - `merges ios-scoped attributes and ignores other platforms`;
  - `names the pod and the key of a value it cannot read` (row 7; it.each: `dependencies: 3`, `vendored_frameworks:
    {}`, `subspecs: "x"`, `source: []`);
  - `ignores keys that do not change the build` (`description`, `screenshots`, `pod_target_xcconfig`);
  - `routes each source shape` (it.each: an ML Kit framework → binary; GoogleMLKit with MLKitCore → binary
    headersOnly; a `vendored_libraries` spec, a `.m` in `source_files`, `type: "dmg"` and an `svn` source → other with
    their `what`; GTMSessionFetcher → source).
- [ ] **Step 2: Run** `npx vitest run tests/pods/spec.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: parse CocoaPods JSON specs"`

### Task A3: Read specs from the CocoaPods CDN, cached

**Files:** Create `src/pods/cdn.ts`, `src/pods/format.ts` (`formatSize`), `tests/support/podsServer.ts`; modify
`src/paths.ts` (`podsCacheDir()` = `join(cacheDir(), "pods")`), `src/commands/setup.ts` (export `tilde` and
`filesystemOf`), `docs/troubleshooting.md` (the minimal `## CocoaPods binaries` section). Test:
`tests/pods/cdn.test.ts`.

**Interfaces:**
```ts
export const CDN_BASE = "https://cdn.cocoapods.org";
export function podShard(pod: string): [string, string, string];        // the first three hex digits of md5(pod)
export function versionIndexUrl(base: string, pod: string): string;      // `${base}/all_pods_versions_${a}_${b}_${c}.txt`
export function specUrl(base: string, pod: string, version: string): string;
//   `${base}/Specs/${a}/${b}/${c}/${pod}/${version}/${pod}.podspec.json`
export function podsUserAgent(): string;                                 // `rn-xtool/${package.json version}`
export interface CdnOptions { base?: string; cache: string; fetch?: typeof fetch; neededBy: (pod: string) => string }
export class PodsNetworkError extends Error { host: string; reason: string; what: string; plural: boolean }
export async function podVersions(pod: string, opts: CdnOptions & { refresh?: boolean }): Promise<string[]>;
//   <cache>/specs/index/all_pods_versions_${a}_${b}_${c}.txt; fetched when missing or with refresh
export async function podSpec(pod: string, version: string, opts: CdnOptions): Promise<PodSpec>;
//   <cache>/specs/${pod}/${version}.podspec.json; fetched only when missing, never again
export function cachedSpecVersions(pod: string, cache: string): string[];   // read by the offline early check (Task F3)
export function networkReason(err: unknown): string;   // "getaddrinfo ENOTFOUND", "connect ECONNREFUSED", else the message
export function offlineText(e: PodsNetworkError, cache: string): string;
```
- Requests follow redirects and send `User-Agent: ${podsUserAgent()}`. Files are written to `<file>.<pid>.tmp`, then
  renamed.
- Texts:
  - offline (goal 5.4, the CDN form): `Cannot reach ${host} (${reason}) to read ${what}, which ${is|are} not in rn-xtool's cache (${cache}). Connect to the network and build again; once downloaded, builds use the cache.`
    (`what` is `the spec of GoogleMLKit 8.0.0` or, with "are", `the versions of GoogleMLKit`.)
  - 404 (row 3): `${pod} ${version} (needed by ${lib}) is not on the CocoaPods trunk: ${url} answered 404. rn-xtool reads pods from trunk only; map the pod to a SwiftPM package under "pods" in rn-xtool.config.json, or leave the library out with "exclude". See ${link}`
  - not in the index (row 3): `${pod} (needed by ${lib}) is not on the CocoaPods trunk: its version list ${url} does not name it. rn-xtool reads pods from trunk only; map the pod to a SwiftPM package under "pods" in rn-xtool.config.json, or leave the library out with "exclude". See ${link}`
  - another status (row 4): `${host} answered HTTP ${status} for ${url} (${what}). Build again later; if it keeps failing, see ${link}`
- Plan notes: row 5 (accept): a spec is cached per version and never fetched again. Row 6 (accept): no mirror; the docs
  say a fresh machine needs the CDN once (Task H). The version index is fetched again for a pod the lock does not
  record, or whose locked version no longer satisfies a requirement (once per resolution; row 71; Task A4; preflight
  P13).

- [ ] **Step 1: Write failing tests** (local server):
  - `computes the shard, the index URL and the spec URL` (the expected shard of `GoogleMLKit` from `md5` in the test);
  - `follows the redirect and sends rn-xtool's User-Agent` (row 4): `/Specs/…` answers 301 to `/cocoa/Specs/…`, which
    answers 403 unless the User-Agent starts with `rn-xtool/`;
  - `reads a cached spec without a request` (the second call adds nothing to `requests`);
  - `stops on a 404 naming the pod, the version, the URL and the library` (row 3);
  - `stops when the version list does not name the pod` (row 3);
  - `names the HTTP status of any other answer` (row 4; a 500);
  - `names the host, the reason and the cache when the CDN cannot be reached` (row 2): a closed port → the offline text
    with `connect ECONNREFUSED`; `networkReason` it.each over `{ cause: { syscall: "getaddrinfo", code: "ENOTFOUND" } }`
    and a plain error;
  - `formats sizes` (`40332871` → `40.3 MB`, `7000` → `7 KB`, `undefined` → `size unknown`).
- [ ] **Step 2: Run** `npx vitest run tests/pods/cdn.test.ts` → FAIL.
- [ ] **Step 3: Implement**, with the troubleshooting heading.
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS (`tests/docsLinks.test.ts` included).
- [ ] **Step 5: Commit** `git add src docs/troubleshooting.md tests && npm run scan:private && git commit -m "feat: read pod specs from the CocoaPods CDN"`

### Task A4: Resolve binary pod versions, greedily

**Files:** Create `src/pods/resolve.ts`. Test: `tests/pods/resolve.test.ts`.

**Interfaces:**
```ts
export interface PodRoot { library: string; libraryVersion: string; dependency: string; requirements: string[] }
//   one per unconditional `s.dependency` the early checks classify `unmapped` (Task F1 builds them)
export interface ResolvedBinaryPod {
  pod: string; version: string; subspecs: string[]; spec: PodSpec; layers: SpecLayer[]; headersOnly: boolean;
  neededBy: string[];      // the libraries that reach it, sorted
  roots: string[];         // the root pods (those a library names) that reach it, sorted
  chain: string[];         // the first path from a library, e.g. ["GoogleMLKit 8.0.0", "MLKitVision 9.0.0"]
}
export interface SourceDependency {
  pod: string; subspecs: string[]; entry: PodEntry;
  requiredBy: { from: string; requirements: string[] }[];   // from: "MLKitCommon"
}
export interface Resolution {
  binary: ResolvedBinaryPod[];                     // sorted by pod
  sources: SourceDependency[];                     // sorted by pod
  roots: { pod: string; libraries: string[] }[];   // one product of the generated package each
  changed: { pod: string; from: string; to: string; requirement: string; by: string }[];  // locked versions that moved
}
export async function resolveBinaryPods(
  roots: readonly PodRoot[],
  ctx: { table: PodTable; locked: Record<string, string>; cdn: CdnOptions },
): Promise<Resolution>;
```
- Algorithm (spec goal 1.5, the shape of `scripts/resolve.py`): rounds until nothing changes, at most 20.
  - Each round recomputes every binary pod's requirements and subspecs from the roots and from the selected layers of
    the current choices, so a requirement of a version no longer chosen drops out.
  - A pod keeps its locked version while `satisfiesAll` holds. Otherwise it gets `newestSatisfying` over the cached
    index, then over a refreshed index when the cached one has none. A locked version that no longer satisfies goes
    into `changed`.
  - A dependency with a table entry is a `SourceDependency` and is not walked (its manifest brings nanopb and
    PromisesObjC). One without an entry: its spec decides; `source` → the unmapped stop; `other` → goal 2.6's stop.
- Texts:
  - conflict (row 8): `No version of ${pod} satisfies every requirement: ${list}. rn-xtool resolves CocoaPods versions without backtracking; leave one of the libraries out with "exclude" in rn-xtool.config.json. See ${link}`
    where `${list}` reads `"~> 13.0.0" (GoogleMLKit 8.0.0, needed by @react-native-ml-kit/text-recognition), "~> 14.0" (MLKitFoo 1.0.0, needed by react-native-foo)`.
  - unmapped source pod, with the chain (row 12; block 2's text; `${link}` is `troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")`):
    `${lib} ${libVersion}: its podspec depends on the CocoaPods pod ${root}, and through it (${chain joined with " → "}) on the CocoaPods pod ${pod}, which has no SwiftPM package rn-xtool knows. Add one under "pods" in rn-xtool.config.json: { "pods": { "${pod}": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, or leave the library out with "exclude". See ${link}`
  - other shape (goal 2.6): `${pod} ${version} (needed by ${lib}) ${what}; rn-xtool links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See ${link}`
  - no settle: `Resolving the CocoaPods pods did not settle after 20 rounds (${pods}). See ${link}`
- Plan note (row 9, accept): greedy, without backtracking (spec Non-goals); the conflict text points at `exclude`.

- [ ] **Step 1: Write failing tests** (local server, the A2 fixtures, one index file per shard):
  - `resolves ML Kit's graph to ten binary pods and four source pods` (the versions of spec fact 2; GoogleMLKit is
    headersOnly with the subspecs `MLKitCore` and the five `TextRecognition…`; neededBy names the library);
  - `resolves MLImage 1.0.0-beta7 for its exact requirement` (row 10);
  - `never asks for nanopb or PromisesObjC` (the server's `requests`);
  - `keeps the locked version while it satisfies the requirements` (`~> 13.0.0`, 13.0.1 on the index, 13.0.0 locked →
    13.0.0);
  - `resolves again when the locked version no longer satisfies them` (row 11; `changed` names both versions);
  - `lists each requirement and who imposed it when no version satisfies them all` (row 8; two fixture libraries);
  - `stops on a source pod without a table entry, with the chain` (row 12; a table without GoogleToolboxForMac);
  - `stops on a pod in a shape rn-xtool does not cover` (a `vendored_libraries` fixture);
  - `refreshes the version index once when no cached version satisfies`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/resolve.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: resolve binary pod versions"`

### Task A5: The lock file

**Files:** Create `src/pods/lock.ts`. Test: `tests/pods/lock.test.ts`.

**Interfaces:**
```ts
export const PODS_LOCK = "rn-xtool-pods.lock.json";
export interface LockEntry { version: string; subspecs: string[]; url: string; size: number; sha256: string; neededBy: string[] }
export interface PodsLock { lockfileVersion: 1; pods: Record<string, LockEntry> }
export class LockError extends Error {}
export function readPodsLock(root: string): PodsLock;        // an empty lock when the file is missing
export function renderPodsLock(lock: PodsLock): string;      // keys sorted, two spaces, a trailing newline
export function writePodsLock(root: string, lock: PodsLock): void;   // <file>.<pid>.tmp + rename
export function lockedVersions(lock: PodsLock): Record<string, string>;
export function unusedLockEntries(lock: PodsLock, used: ReadonlySet<string>): string[];  // "MLKitFoo 1.0.0", sorted
```
- The lock holds URLs, sizes and hashes only. Unused entries stay (OQ7).
- Texts:
  - unreadable: `rn-xtool-pods.lock.json is not a lock rn-xtool can read (${reason}); fix it, or delete it to record the files again. See ${link}`
  - conflict markers (row 69): `rn-xtool-pods.lock.json has merge conflict markers; keep either side and build again: rn-xtool checks every file against the hashes it keeps. See ${link}`
  - recorded (spec goal 1.6; printed by Task F1): `ℹ pods — recorded the sha256 of ${n} download${s} in rn-xtool-pods.lock.json; commit it, so other machines check that they get the same files.`
  - re-resolved (row 11; Task F1): `ℹ pods — ${pod}: rn-xtool-pods.lock.json records ${from}, which no longer meets "${requirement}" (${by}); now ${to}, recorded in rn-xtool-pods.lock.json`
  - moved (row 19; Task F1): `ℹ pods — ${pod} ${version} moved to ${url}; same file (its sha256 matches rn-xtool-pods.lock.json), so the lock's URL is updated`

- [ ] **Step 1: Write failing tests:** `reads a missing lock as empty`; `renders sorted keys, stable across writes`;
  `writes through a temporary file`; `names a lock it cannot read` (bad JSON, a wrong shape); `names a lock with merge
  conflict markers` (row 69); `keeps unused entries and lists them`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/lock.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: record binary pods in a lock file"`

---

## B. Download, verify, extract

### Task B1: `downloadFile` takes headers and an expected size

**Files:** Modify `src/tools/download.ts`. Test: `tests/download.test.ts`.

**Interfaces:**
```ts
export async function downloadFile(url: string, dest: string, opts: {
  minBytes?: number; mode?: number; sha256?: string;
  headers?: Record<string, string>;
  /** A body of another size is retried once, then rejected: `downloaded ${size} bytes, expected ${n}`. */
  expectedBytes?: number;
  /** Without expectedBytes: compare with the response's Content-Length when it has no Content-Encoding. */
  checkLength?: boolean;
} = {}): Promise<void>;
// The final error keeps the last failure as its `cause` (new Error(…, { cause })), so a caller can read the network
// reason.
```
- Existing callers pass none of the new options and behave as today (`setup`'s swiftly and xtool downloads).
- Plan note (row 21, accept): the 15-minute timeout and its message stay.

- [ ] **Step 1: Write failing tests:** `accepts a 7 KB file when the expected size says so` (row 17; `minBytes: 0`,
  `expectedBytes: 7000`); `retries a body shorter than Content-Length, then names both sizes` (row 16);
  `accepts a body equal to the expected size`; `sends the given headers`; `keeps the network failure as the cause`.
- [ ] **Step 2: Run** `npx vitest run tests/download.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: check downloads against an expected size"`

### Task B2: Download and verify a binary pod

**Files:** Create `src/pods/fetch.ts`. Test: `tests/pods/fetch.test.ts`.

**Interfaces:**
```ts
export interface DownloadPlan {
  pod: string; version: string; neededBy: string; url: string; ext: "tar.gz" | "zip";
  locked?: LockEntry; specSha256?: string; specSha1?: string; expectedBytes?: number;
}
export async function headSize(url: string, opts?: { fetch?: typeof fetch }): Promise<number | undefined>;
//   HEAD with rn-xtool's User-Agent, redirects followed; Content-Length, or undefined
export function cachedArchive(cache: string, sha256: string, ext: string): string | undefined;
//   <cache>/downloads/<sha256>.<ext> when it exists
export async function fetchPodArchive(plan: DownloadPlan, cache: string): Promise<{ file: string; sha256: string; size: number; moved: boolean }>;
//   A locked entry whose file is cached: no request. Otherwise downloadFile into
//   <cache>/downloads/.<pod>-<version>.<pid>.<ext> (minBytes 0, expectedBytes from the plan, rn-xtool's User-Agent),
//   then the sha256 against the lock, then against the spec's sha256 or sha1, then a rename to <sha256>.<ext> (an
//   existing one wins, and the temporary file is removed).
```
- Texts:
  - mismatch (row 18, spec verbatim): `The file ${host} serves for ${pod} ${version} is not the one rn-xtool-pods.lock.json records (sha256 ${got} instead of ${want}). rn-xtool does not use it. If you trust the new file, delete the "${pod}" entry from rn-xtool-pods.lock.json and build again.`
  - the spec's own checksum: `The file ${host} serves for ${pod} ${version} does not match the ${algo} its spec names (${got} instead of ${want}). rn-xtool does not use it. See ${link}`
  - 404 or 410 (row 15): `${host} answered ${status} for ${pod} ${version} (needed by ${lib}): ${url}. The vendor no longer serves this file; a machine whose rn-xtool cache holds it keeps building. See ${link}`
  - another failure: `Could not download ${pod} ${version} from ${host}: ${reason}. Build again; the cache keeps what was complete.`
  - plain http (P16, row 72): `${pod} ${version} downloads over plain http from ${host}; rn-xtool downloads it only when rn-xtool-pods.lock.json already records its sha256. See ${link}`, for an `http://` URL and for a redirect from https to http (`${host}` is then the redirect's host). Redirects are followed one by one (`downloadFile`'s `refuseHttpRedirect`).
  - offline: a `PodsNetworkError` with `what` = `${pod} ${version} (${size})`; Task F1 prints goal 5.4's text:
    `Cannot reach ${host} (${reason}) to download ${pod} ${version} (${size}), which is not in rn-xtool's cache (${cache}). Connect to the network and build again; once downloaded, builds use the cache.`

- [ ] **Step 1: Write failing tests** (local server, synthetic archives):
  - `downloads MLImage's small archive` (row 17; 7,000 bytes);
  - `makes no request for a locked file already cached`;
  - `deletes a file whose sha256 differs from the lock and stops without a retry` (row 18: one request, nothing left in
    `downloads/`, the verbatim text);
  - `updates the URL when the moved file has the locked sha256` (`moved: true`); `treats a moved file with another
    sha256 as a mismatch` (row 19);
  - `checks a spec's own sha256 or sha1 when it names one` (row 20);
  - `stops on a 404 or 410 naming the host, the URL and the pod` (row 15);
  - `two downloads of one file both end with one cached copy` (row 62; `Promise.all`);
  - `reports an unreachable host as a PodsNetworkError`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/fetch.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: download and verify binary pods"`

### Task B3: List an archive before extracting it

**Files:** Create `src/pods/archive.ts`, `tests/support/archives.ts` (a ustar writer with gzip and a stored-zip writer,
both able to write a symlink, a hard link, a device entry, an absolute path and a `..` segment). Test:
`tests/pods/archive.test.ts`.

**Interfaces:**
```ts
export interface ArchiveEntry { path: string; type: "file" | "dir" | "symlink" | "hardlink" | "special"; target?: string }
export function parseTarListing(text: string): ArchiveEntry[];    // `LC_ALL=C tar -tvzf <file> --quoting-style=escape`
export function parseZipListing(longText: string): ArchiveEntry[]; // `unzip -Z <file>`, the type from the mode column;
//   a zip symlink's target is read with `unzip -p <file> <entry>`
export function unsafeEntry(entries: readonly ArchiveEntry[]): { entry: string; why: string } | undefined;
//   why: "has an absolute path" | "goes up with .." | "is a device or special file" | "is a link that points outside the archive"
export type ListRunner = (cmd: string, args: string[]) => Promise<string>;
export async function listArchive(file: string, ext: "tar.gz" | "zip", run?: ListRunner): Promise<ArchiveEntry[]>;
```
- Texts:
  - unsafe (row 22): `rn-xtool refuses to extract ${archiveName} (${pod} ${version}): its entry "${entry}" ${why}. Nothing was extracted. See ${link}`
  - no unzip (row 24): `${pod} ${version} is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.`

- [ ] **Step 1: Write failing tests:** `parses GNU tar's verbose listing` (files, folders, `->` links, `link to` hard
  links, names with spaces); `parses unzip's long listing`; `refuses an absolute path, a .. segment, a device file and a
  link that leaves the tree` (row 22; it.each over tar and zip archives from `tests/support/archives.ts`, listed with the
  host's `tar` and `unzip`); `accepts a link that stays inside`; `names sudo apt install unzip for a zip without unzip`
  (row 24; a runner that fails with ENOENT).
- [ ] **Step 2: Run** `npx vitest run tests/pods/archive.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: list pod archives before extracting"`

### Task B4: Extract what the spec needs into the cache

**Files:** Modify `src/pods/archive.ts`. Test: `tests/pods/archive.test.ts`.

**Interfaces:**
```ts
export interface ExtractRequest {
  archive: string; ext: "tar.gz" | "zip"; sha256: string; pod: string; version: string; flatten: boolean;
  keep: string[];      // spec paths and globs: vendored framework folders, resource_bundles globs, header
                       // source_files, and a module map beside them (preserve_paths)
  required: string[];  // the vendored framework paths, which must exist afterwards
}
export const EXTRACTOR_VERSION = 1;
export async function extractPod(req: ExtractRequest, cache: string): Promise<string>;  // <cache>/extracted/<sha256>
//   The listing and unsafeEntry first. flatten: every entry under one top-level folder, which is stripped
//   (--strip-components=1). The members matching `keep` (micromatch; folders by prefix) are extracted with
//   `tar -xzf … --no-same-owner --no-same-permissions -T <list>` or `unzip -q -o … -d` into <dest>.tmp-<pid>; `required`
//   is checked; swapIn; the stamp `.rn-xtool-extracted.json` { extractorVersion, sha256, keep } is written last. A tree
//   with the same stamp is reused.
```
- Text (row 23): `${pod} ${version}: its spec names ${path}, which the download does not hold. Its top-level entries: ${entries}. See ${link}`
- Plan note (row 74, accept): the swap is two renames; a build that reads `extracted/<sha256>` between them, while
  another build swaps in the same tree, can miss it once. Building again passes.

- [ ] **Step 1: Write failing tests:** `extracts only the paths the spec needs`; `strips the top-level folder of a
  flatten archive` (row 23); `names the expected path and the archive's top-level entries when a vendored path is
  missing` (row 23); `reuses a stamped tree`; `rebuilds a tree without its stamp` and `writes the stamp last` (row 25: a
  failure injected after the extraction leaves no stamp); `two extractions of one archive both succeed` (row 62).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: extract binary pods into the cache"`

---

## C. Mach-O, `ar` and headers-only xcframeworks

### Task C1: A Mach-O reader

**Files:** Create `src/pods/macho.ts`, `tests/support/macho.ts` (writes a 64-bit Mach-O header with a chosen filetype,
CPU type and subtype and an optional `LC_BUILD_VERSION` or `LC_VERSION_MIN_IPHONEOS`; a fat or fat64 wrapper; an `ar`
archive with BSD `#1/<n>` long names and a `__.SYMDEF` member). Test: `tests/pods/macho.test.ts`.

**Interfaces:**
```ts
export interface MachOInfo { kind: "object" | "dylib" | "execute" | "bundle" | "other"; cpu: string; platform?: number; minos?: string }
export type BinaryShape =
  | { shape: "fat"; arches: string[] }               // "arm64", "arm64e", "x86_64", …
  | { shape: "macho"; info: MachOInfo }
  | { shape: "ar"; members: { name: string; info?: MachOInfo }[] }   // __.SYMDEF* skipped
  | { shape: "unknown"; magic: string };
export function readBinary(buf: Buffer): BinaryShape;
export function arm64Slice(buf: Buffer): Buffer | { missing: true; arches: string[] };
//   fat (CAFEBABE or CAFEBABF): the slice with CPU_TYPE_ARM64 and subtype ALL (capability bits masked); arm64e is not
//   arm64. A thin arm64 file is returned as it is.
export const PLATFORM_IOS = 2;
export function platformProblem(slice: Buffer): { member?: string; platform: string } | undefined;
//   an object, or an archive member, whose LC_BUILD_VERSION platform is not iOS ("iOS simulator", "macOS",
//   "Mac Catalyst", …); no platform load command is accepted (MLKitTextRecognitionCommon)
export function highestMinIos(slice: Buffer): string | undefined;   // over LC_BUILD_VERSION and LC_VERSION_MIN_IPHONEOS
```

- [ ] **Step 1: Write failing tests:** `cuts the arm64 slice out of a fat and a fat64 file`; `keeps a thin arm64
  file`; `has no arm64 slice in an x86_64-only or arm64e-only file` (row 26); `tells an object, a dylib and an archive
  apart`; `reads archive members with BSD long names`; `reports a simulator platform in an object and in an archive
  member` (row 27); `accepts an object without a platform load command` (row 34); `reads the highest minos` (row 35);
  `calls a !<thin> archive unknown`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/macho.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: read Mach-O slices and archive members"`

### Task C2: Wrap an object with `llvm-ar`, and doctor's `llvm-ar` line

**Files:** Create `src/pods/ar.ts`; modify `src/commands/doctor.ts` (`DoctorProbes.llvmArVersion`, an `llvm-ar` line
right after `llvm-nm`). Test: `tests/pods/ar.test.ts`, `tests/doctor.test.ts` (the full doctor's names list gains
`llvm-ar`).

**Interfaces:**
```ts
export const LLVM_AR_MISSING =
  "llvm-ar was not found on the Swift toolchain's PATH; rn-xtool wraps CocoaPods binaries with it. " +
  `Run \`rn-xtool setup\` to install Swift ${SWIFT_VERSION} through swiftly.`;
export type ArRunner = (args: string[]) => Promise<string>;
export function makeArRunner(bin?: string, timeoutMs?: number): ArRunner;   // execa with toolEnv(); ENOENT → LLVM_AR_MISSING
export async function wrapObject(object: string, archive: string, run: ArRunner, label: { pod: string; version: string; rel: string }): Promise<void>;
//   `llvm-ar rcs --format=darwin <archive> <object>`; the result must start with `!<arch>\n`
```
- Texts: failure (row 33): `llvm-ar could not wrap ${pod} ${version}'s object (${rel}): ${the first line of stderr}`;
  doctor: `✔ llvm-ar — LLVM ${version}`, or `✖ llvm-ar — ${LLVM_AR_MISSING}`.

- [ ] **Step 1: Write failing tests:** `runs llvm-ar rcs --format=darwin`; `names rn-xtool setup when llvm-ar is
  missing`; `names the pod and the object when llvm-ar fails` (row 33); doctor `prints the llvm-ar line after llvm-nm`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/ar.test.ts tests/doctor.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: wrap object files with llvm-ar"`

### Task C3: Headers-only xcframeworks and the module-map rewrite

**Files:** Create `src/pods/xcframework.ts`. Test: `tests/pods/xcframework.test.ts`.

**Interfaces:**
```ts
export const POD_SLICE: XcframeworkLibrary = { LibraryIdentifier: "ios-arm64", SupportedPlatform: "ios", SupportedArchitectures: ["arm64"] };
export function rewriteFrameworkModuleMap(text: string, file: string, label: string): string;
//   drops the leading `framework` of the one `framework module <Name>`, and keeps everything else (umbrella, export,
//   `module *`, every `link` line). Throws when the text holds another `framework module` or an `explicit framework`.
export function generatedModuleMap(name: string): string;
//   `module ${name} {\n  umbrella header "${name}.h"\n  export *\n  module * { export * }\n}\n`
export async function writeHeadersXcframework(dir: string, name: string, headers: { from: string; files: string[] }, moduleMap: string): Promise<string>;
//   <dir>/<name>.xcframework/Info.plist = headersXcframeworkInfoPlist(name, [POD_SLICE]);
//   ios-arm64/lib<name>-ios-arm64.a = EMPTY_AR_ARCHIVE; ios-arm64/Headers/<name>/<files…> + module.modulemap
```
- Texts:
  - a map rn-xtool cannot rewrite (row 31): `${label}: ${rel} names the framework bundle (${what}), which rn-xtool cannot rewrite for SwiftPM. See ${link}` (`what`: `a module.private.modulemap`, `a framework submodule`)
  - no map and no umbrella header (row 30): `${label}: ${framework} has no Modules/module.modulemap and no Headers/${name}.h, so rn-xtool cannot make a module for it. See ${link}`

- [ ] **Step 1: Write failing tests:** `rewrites a framework module map and keeps its link lines` (MLKitVision's shape,
  with `module * { export * }`); `generates a module map from the umbrella header` (row 30); `stops without a module map
  and without an umbrella header` (row 30); `stops on a private module map or a framework submodule` (row 31); `writes
  the Info.plist headersXcframeworkInfoPlist writes, and reads back` (row 42; `readXcframeworkLibraries`); `keeps nested
  header folders`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: headers-only xcframeworks for pods"`

### Task C4: Wrap a binary pod for SwiftPM

**Files:** Create `src/pods/wrap.ts`; modify `src/pipeline/rnArtifacts.ts` (`readXcframeworkSlices`, which also returns
`LibraryPath` and `HeadersPath`; `readXcframeworkLibraries` is built on it and returns what it returns today). Test:
`tests/pods/wrap.test.ts`, `tests/rnArtifacts.test.ts`.

**Interfaces:**
```ts
export const WRAPPER_VERSION = 1;
export interface WrappedFramework { name: string; xcframework: string; archive?: string; privacy: string[] }
export interface WrappedPod { pod: string; version: string; sha256: string; dir: string; frameworks: WrappedFramework[]; warnings: string[] }
export async function wrapPod(i: {
  pod: string; version: string; sha256: string; neededBy: string;
  extracted: string;               // a folder: the cache's extracted tree (OQ5: the follow-up block can pass a package folder)
  spec: PodSpec; layers: SpecLayer[]; headersOnly: boolean;
}, cache: string, ar: ArRunner): Promise<WrappedPod>;
//   <cache>/wrapped/<sha256>/{xcframeworks/<Name>.xcframework, archives/lib<Name>.a, .rn-xtool-wrapped.json (last)}
```
- For each `vendored_frameworks` entry (globs expanded in the extracted tree):
  - `<X>.framework`: a `Modules/*.swiftmodule` stops. The binary `<X>` goes through `readBinary`: fat → `arm64Slice`;
    `dylib` → stop; `object` → `wrapObject`; `ar` → kept as the thin slice; `unknown` → stop. `platformProblem` stops.
    `highestMinIos` or the spec's `iosMin` above `IOS_MIN` adds a warning. Headers and the module map go through C3. A
    `PrivacyInfo.xcprivacy` inside the framework is recorded in `privacy`.
  - `<X>.xcframework`: `readXcframeworkSlices`, the `ios` slice without a variant that lists `arm64`; its `LibraryPath`
    (`.framework` or `.a`) goes through the same steps, and its headers come from its `HeadersPath`.
- Headers-only pods (GoogleMLKit with MLKitCore): one xcframework named `moduleName ?? pod`, holding the header
  `source_files`. Its module map is the `module.modulemap` beside them when the spec keeps one (in `preserve_paths`, as
  GoogleMLKit does), else `module ${name} {\n  header "${h}"\n  …\n  export *\n}\n`.
- Invariant: every archive written starts with `!<arch>\n`; otherwise an internal error names it (row 32).
- Texts:
  - no arm64 (row 26): `${pod} ${version} (needed by ${lib}) ships no arm64 device slice (it has ${arches}): ${rel}. rn-xtool builds for iPhones only. Leave the library out with "exclude" in rn-xtool.config.json. See ${link}`
  - simulator (row 27): `${pod} ${version} (needed by ${lib}) ships an arm64 slice built for the ${platform}, not for iPhones (${rel}${member ? `, member ${member}` : ""}). Leave the library out with "exclude" in rn-xtool.config.json. See ${link}`
  - goal 2.6 (rows 28, 29): `${pod} ${version} (needed by ${lib}) ships a ${dynamic framework | Swift framework} (${rel}); rn-xtool links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See ${link}`
  - an unknown binary: `${pod} ${version} (needed by ${lib}) ships a binary rn-xtool does not recognise (${rel}, which starts with ${magic}). See ${link}`
  - the minimum (row 35, spec verbatim): `⚠ ${pod} needs iOS ${version}; the app's minimum is ${IOS_MIN}; it fails to load on older iPhones`

- [ ] **Step 1: Write failing tests** (synthetic frameworks in a temporary tree; a fake `ArRunner` that writes
  `!<arch>\n` and the object):
  - `wraps a fat ar framework, a thin ar framework and an MH_OBJECT framework`;
  - `every staged archive starts with !<arch>` (row 32; it.each over the three);
  - `stops on a framework without an arm64 device slice` (row 26); `stops on a simulator slice` (row 27);
  - `stops on a dynamic framework` (row 28); `stops on a Swift framework` (row 29);
  - `warns about a minos newer than IOS_MIN`, `warns about a spec platform newer than IOS_MIN` (row 35);
  - `makes GoogleMLKit's headers-only module MLKit with its own module map`;
  - `reads the device slice of a vendored xcframework`;
  - `records the privacy manifests inside frameworks` (row 57);
  - `reuses a stamped tree` (row 62).
- [ ] **Step 2: Run** `npx vitest run tests/pods/wrap.test.ts tests/rnArtifacts.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: wrap vendored frameworks for SwiftPM"`

---

## G1. The spike gate (controller; right after C4)

### Task G1: Link ML Kit with hand-staged files

No commit. Nothing from the spike is kept in the repository. The spike driver lives in
`<scratchpad>/plan-binpods/spike/` and imports the worktree's `dist/pods/*.js`.

- [ ] **Step 1.** `npm run build`. In F1Proof (reset to the Task 0 commit): `npm install
  <scratchpad>/binpods/react-native-ml-kit-text-recognition-2.0.0.tgz`; `App.tsx` imports `TextRecognition` and calls
  `TextRecognition.recognize('https://example.com/page.jpg')` from a button handler (build only).
- [ ] **Step 2 (approved downloads).** The driver resolves the library's five `GoogleMLKit/…` roots with
  `resolveBinaryPods` (the real CDN, data/pods.json's table as it will be after Task D1, written into the driver),
  downloads with `fetchPodArchive`, extracts with `extractPod` and wraps with `wrapPod` into `~/.cache/rn-xtool/pods`.
  Record: each `HEAD` Content-Length from dl.google.com (preflight P24), the sha256 of the ten downloads (they must equal
  the findings' prefixes), the cache size after each phase (the disk factor of goal 5.5), and the time.
- [ ] **Step 3.** The driver writes `ios/build/pod-binaries/` by hand in goal 2.5's shape: `Package.swift` (the sample in
  Task D4), `xcframeworks/` and `archives/` hard-linked from the cache, `Sources/GoogleMLKitWrapper/wrapper.c`,
  `.gitignore`.
- [ ] **Step 4.** `rn-xtool build` with `"knownLimits": { "allow": ["@react-native-ml-kit/text-recognition"] }`: the
  library is scaffolded and persisted, and the build fails at `xtool-build` on `module 'MLKitVision' not found` (block
  2's record). Then, by hand:
  - the library's `node_modules/@react-native-ml-kit/text-recognition/Package.swift` gains
    `.package(path: "<relative path from libs/<SwiftName> to ios/build/pod-binaries>")` and
    `.product(name: "GoogleMLKit", package: "pod-binaries")`;
  - `ios-xtool/Package.swift`'s App target gains `-Xlinker -force_load -Xlinker <archive>` per archive in
    `ios/build/pod-binaries/archives/`, and `.linkedFramework`/`.linkedLibrary` for the specs' `frameworks` and
    `libraries` (Task D5's shape);
  - then `xtool dev build --configuration debug` in `ios-xtool/`, with `toolEnv`'s PATH and `RN_SPM_SWIFT_HEADERS_DIR`
    as `devEnv` sets them.
- [ ] **Step 5 (the gate).** Pass when:
  - the link succeeds without `duplicate symbol` (rows 34, 44);
  - `llvm-nm` on `App.app/App` finds `_OBJC_CLASS_$_MLKTextRecognizer`, `_OBJC_CLASS_$_MLKITx_SRLRegistry`,
    `_OBJC_CLASS_$_TextRecognition` and `_OBJC_CLASS_$_GTMLogger` (row 45);
  - `App.app/Frameworks/` holds no `MLKit*` or `MLImage` framework (row 50);
  - SwiftPM resolved the four source packages at 3.5.0, 8.1.5, 10.1.1 and 6.0.1 (preflight P22).
  Record the `.build` size, the link time, the App binary size and the App.app size, then delete `.build`.
- [ ] **Step 6 (only if step 5 fails at compile or link).**
  - Fallback A: each slice's `lib<Name>-ios-arm64.a` becomes the real archive (a hard link), and the `-force_load` lines
    go; rebuild and check step 5.
  - Fallback B: framework-type slices, `ios-arm64/<Name>.framework/{<Name> (the thin ar), Headers/, Modules/module.modulemap
    (Google's, unchanged)}` with `LibraryPath` `<Name>.framework` and no `HeadersPath`; `-force_load` of the framework
    binary; rebuild and check step 5.
  - The shape that passes is the one D implements; the D tasks name their deltas for A and B ("If G1 picked…"). The
    owner is told which shape passed before D1 starts.
  - **If none passes, stop:** the failure goes to the owner as a decision (the block may ship the clear stops only).
- [ ] **Step 7.** Reset F1Proof to the Task 0 commit (the persisted ML Kit patch goes with it). Keep the cache: G2 step
  4 deletes it on purpose.

---

## D. The generated package, the scaffold's binary route and the App target

**G1's rulings (owner, 2026-11-05), which amend the tasks below** (spec fact 27):
1. `pod-binaries`' platform is the app's deployment target, read as the scaffolder reads it (`appDeploymentTarget`),
   not `IOS_MIN`; row 35's ⚠ stays where Task C4 put it.
2. The wrapper C target gets `Sources/<Wrapper>/include/<Wrapper>.h`.
3. `-Xlinker -no_objc_relative_method_lists` on the App target only when binary pods are linked (row 80).
4. A table entry's `emptyTargets` (GoogleToolboxForMac: `GTMDefines`): an empty arm64 object at
   `ios-xtool/.build/out/Products/Debug-iphoneos/<Target>.o` before `xtool-build`, for each linked table pod (row 81).

### Task D1: ML Kit's source pods in the table, and checked overrides

**Files:** Modify `data/pods.json`, `src/config.ts` (`PodEntry.outsideRequirement`, `checkPodEntries`),
`src/project/earlyChecks.ts` (`podPinWarnings`), and create `src/pods/pins.ts`. Test: `tests/podTable.test.ts`,
`tests/config.test.ts`, `tests/earlyChecks.test.ts`, `tests/pods/pins.test.ts`.

**Interfaces:**
```jsonc
// data/pods.json gains (the versions are the newest tags the requirements accept that ship a Package.swift; spec goal 3.1)
"GTMSessionFetcher": { "url": "https://github.com/google/gtm-session-fetcher", "exact": "3.5.0",
  "products": ["GTMSessionFetcherCore"], "subspecs": { "Core": ["GTMSessionFetcherCore"] } },
"GoogleUtilities": { "url": "https://github.com/google/GoogleUtilities", "exact": "8.1.5",
  "products": ["GULLogger", "GULUserDefaults"], "subspecs": { "Logger": ["GULLogger"], "UserDefaults": ["GULUserDefaults"] } },
"GoogleDataTransport": { "url": "https://github.com/google/GoogleDataTransport", "exact": "10.1.1",
  "products": ["GoogleDataTransport"] },
"GoogleToolboxForMac": { "url": "https://github.com/google/google-toolbox-for-mac", "exact": "6.0.1",
  "products": ["GTMLogger", "GTMNSData_zlib"], "subspecs": { "Logger": ["GTMLogger"], "NSData+zlib": ["GTMNSData_zlib"] },
  "outsideRequirement": "4.x ships no Package.swift; 6.0.1 keeps the GTMLogger API ML Kit links against",
  "emptyTargets": ["GTMDefines"] }   // G1 ruling 4
```
```ts
// PodEntry gains outsideRequirement?: string; checkPodEntries:
//   `${file}: pods.${pod}.outsideRequirement must be a sentence saying why the pin is outside the requirement`
// podPinWarnings: an entry with outsideRequirement gives an ℹ line instead of the ⚠ (block 2's text, then the reason).
export function binaryPinLines(resolution: Resolution, table: PodTable): string[];
//   for each SourceDependency requirement its pin misses, one line per pod and requirement, naming the binary pods that
//   impose it ("MLKitCommon's", "MLKitCommon's and MLKitVision's")
```
- Texts:
  - ⚠ (row 13): `⚠ ${pod} ${exact} (${source}) is outside ${dependents} requirement "${requirement}"` (spec's example:
    `⚠ GoogleToolboxForMac 6.0.1 (rn-xtool table) is outside MLKitCommon's requirement ">= 4.2.1, < 5.0"`)
  - ℹ (OQ2): `ℹ ${pod} ${exact} (${source}) is outside ${dependents} requirement "${requirement}": ${outsideRequirement}`
- Plan note: `docs/RELEASING.md`'s rule for pod table entries (newest tag the requirement accepts that builds and ships
  a `Package.swift`) gains one sentence for `outsideRequirement` (Task H).

- [ ] **Step 1: Write failing tests:** `the shipped table passes the config's shape check` (existing, now with the four
  pods); `names an outsideRequirement that is not a string`; `marks the GoogleToolboxForMac override as checked: one ℹ
  line, no ⚠` (row 13; ML Kit's resolution from Task A4's fixtures, MLKitCommon and MLKitVision in one line); `warns
  about a pin outside a binary pod's requirement` (a config pin of GoogleUtilities 7.0.0); `maps every subspec ML Kit's
  graph reaches to a product` (row 14: every `(pod, subspec)` of the A4 resolution's `sources` has a non-empty product
  list); block 2's `podPinWarnings` `prints an ℹ line for a pin the entry marks as checked`.
- [ ] **Step 2: Run** `npx vitest run tests/podTable.test.ts tests/config.test.ts tests/earlyChecks.test.ts tests/pods/pins.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add data src tests && npm run scan:private && git commit -m "feat: map ML Kit's source pods to SwiftPM"`

### Task D2: Scaffolder fix 27, the `binary` route

**Files:** Modify `vendor/rn-spm/spm/scaffold-package-swift.js`, both 0.88 patches (by the sync recipe),
`docs/upstream/react-native-scaffolder.md` (fix 27), `vendor/rn-spm/README.md` (the fix count). Test:
`tests/rn-scaffolder.test.ts` (a new `describe("scaffolder fix 27 (vendor/rn-spm)")` that loads `VENDORED_RN_SPM`, and
the hunk test).

**Interfaces:**
```js
// podTableEntry(pod, raw): an entry `{ binary: { product: string } }` is read as a binary entry (other keys ignored);
//   a product that is not a non-empty string throws `pods.${pod}.binary.product is not a product name`.
// classifyPodDependency: an entry with `binary` → {kind: 'binary', pod, entry, products: [entry.binary.product]},
//   checked where 'mapped' is; PodDependencyKind gains 'binary'.
// The dependency loop collects binaryProducts (unique, in podspec order). emitScaffoldedPackageSwift takes
//   ctx.podBinariesPackageDir = relFromManifest('build', 'pod-binaries') and, when binaryProducts is not empty, emits
//   `.package(path: "${podBinariesPackageDir}")` once and `.product(name: "${product}", package: "pod-binaries")` per
//   product.
// The marker lists `${pod}=binary` with the pins, sorted by pod: `// rn-xtool-pods: GoogleMLKit=binary`.
```
- Plan note: no revision bump (Global Constraints). Fix 27's upstream entry: the repro (a podspec depending on a pod
  that ships prebuilt `.framework`s), the effect (`module 'MLKitVision' not found`), the fix, and the library
  (@react-native-ml-kit/text-recognition 2.0.0).
- If G1 picked fallback A or B, this task does not change: the route only names the package and the product.

- [ ] **Step 1: Write failing tests:**
  - `27: wires a binary pod to the pod-binaries package` (ML Kit's podspec shape with a table file holding
    `{ "GoogleMLKit": { "binary": { "product": "GoogleMLKit" } } }` → the two lines, once for five subspec lines);
  - `27: records GoogleMLKit=binary on the rn-xtool-pods line, without a version`;
  - `27: the binary route holds no absolute path` (row 39; the path starts with `../` and ends with
    `/build/pod-binaries`);
  - `27: a binary entry needs a product name`;
  - `27: without the binary entry, the pod is unmapped as before`;
  - `classifyPodDependency` it.each gains the `binary` kind;
  - the hunk test `scaffold-package-swift.js has the fix 27 hunk` (`podBinariesPackageDir`).
- [ ] **Step 2: Run** `npx vitest run tests/rn-scaffolder.test.ts` → FAIL.
- [ ] **Step 3: Implement**, sync the two copies (Global Constraints), write fix 27's entry. The goldens do not change.
- [ ] **Step 4: Run** the sync's test list without skips, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add vendor patches docs/upstream tests && npm run scan:private && git commit -m "feat: scaffold binary pods as a local package"`

### Task D3: Hand the binary pods to the scaffolder and the checks

**Files:** Modify `src/project/podTable.ts` (`PodTable.binary`, `mergedPodTable`, `writePodTable`),
`src/project/earlyChecks.ts` (`PodClassification.kind` gains `binary`; `LibraryCheckOptions.binary`;
`scaffoldedPods` also returns binary pods), `src/pipeline/patches.ts` (the stale check), `src/pipeline/rnSpm.ts`
(`runRnSpm` takes `binary`). Test: `tests/podTable.test.ts`, `tests/earlyChecks.test.ts`, `tests/patches.test.ts`,
`tests/rnSpm.test.ts`.

**Interfaces:**
```ts
export interface PodTable { pods: Record<string, PodEntry>; source: Record<string, PodSource>; binary: Record<string, { product: string }> }
export function mergedPodTable(configPods?: Record<string, PodEntry>, binary?: Record<string, { product: string }>): PodTable;
//   a pod the table maps is never binary: the table wins (spec goal 1.2)
// writePodTable: the file's `pods` holds the entries and `{ "binary": { "product": … } }` for each binary pod
// LibraryCheckOptions.binary?: Record<string, { product: string }>   // build: from the pods step; doctor: from the lock (Task F3)
```
- Stale scaffold (`scaffoldPatchFindings`): a persisted scaffold of a library whose podspec names a binary pod, without
  `${pod}=binary` on its marker:
  `⚠ patches/${name} does not link ${pod}'s CocoaPods binaries: it was scaffolded before rn-xtool resolved them; delete it so rn-xtool regenerates it ${tail}`
  (`${tail}` is block 2's `(also remove node_modules/<pkg> and reinstall: that copy still has the old Package.swift)`).
  A recorded `=binary` is never compared as a version.

- [ ] **Step 1: Write failing tests:** `writes the binary pods into the table file`; `a table entry wins over a binary
  pod`; earlyChecks `classifies a pod the binary map names as binary, never unmapped`; patches `warns about a persisted
  scaffold that does not link a binary pod`, `reads GoogleMLKit=binary as linked, not as a version`; rnSpm `passes the
  binary pods to the scaffolder in the table file`.
- [ ] **Step 2: Run** `npx vitest run tests/podTable.test.ts tests/earlyChecks.test.ts tests/patches.test.ts tests/rnSpm.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: hand binary pods to the scaffolder"`

### Task D4: Generate the `pod-binaries` package

**Files:** Create `src/pods/stage.ts`; modify `src/paths.ts` (`ProjectPaths.podBinaries` = `ios/build/pod-binaries`).
Test: `tests/pods/stage.test.ts`.

**Interfaces:**
```ts
export const POD_BINARIES_PACKAGE = "pod-binaries";
export interface PodsLinks { archives: string[]; frameworks: string[]; libraries: string[]; weakFrameworks: string[] }
export interface StagedPods { dir: string; links: PodsLinks; bundles: BundleSource[]; binaryTargets: string[]; products: string[] }
export interface PodBinariesInput {
  products: { name: string; binaryTargets: string[]; sourceProducts: { product: string; package: string }[] }[];
  sourcePackages: { url: string; exact: string }[];
  iosMin: string;
}
export function renderPodBinariesPackage(i: PodBinariesInput): string;
export async function stagePodBinaries(paths: ProjectPaths, result: PodsResult): Promise<StagedPods>;
//   removes and rebuilds ios/build/pod-binaries (assembled per pid, swapped in): Package.swift, .gitignore ("*\n"),
//   xcframeworks/<Name>.xcframework and archives/lib<Name>.a copied from the cache (row 85), and
//   Sources/<Product>Wrapper/wrapper.c. Throws if the folder would be under node_modules.
```
- The manifest, deterministic (everything sorted), relative paths only:
  ```swift
  // swift-tools-version: 6.0
  // Generated by rn-xtool from rn-xtool-pods.lock.json and its cache. Do not edit; rn-xtool build rewrites it.
  import PackageDescription

  let package = Package(
      name: "pod-binaries",
      platforms: [.iOS("15.1")],   // the app's deployment target (G1 ruling 1)
      products: [
          .library(name: "GoogleMLKit", targets: ["MLImage", "MLKit", "MLKitCommon", …, "GoogleMLKitWrapper"]),
      ],
      dependencies: [
          .package(url: "https://github.com/google/GoogleDataTransport", exact: "10.1.1"),
          …
      ],
      targets: [
          .binaryTarget(name: "MLImage", path: "xcframeworks/MLImage.xcframework"),
          …
          .target(
              name: "GoogleMLKitWrapper",
              dependencies: [
                  .product(name: "GTMSessionFetcherCore", package: "gtm-session-fetcher"),
                  …
              ],
              path: "Sources/GoogleMLKitWrapper"
          ),
      ]
  )
  ```
  `wrapper.c`: `// Generated by rn-xtool: GoogleMLKit's link to its source dependencies.\n#include "GoogleMLKitWrapper.h"\n\nvoid rn_xtool_GoogleMLKitWrapper(void) {}\n`,
  and `include/GoogleMLKitWrapper.h` declares that function (G1 ruling 2).
  A product lists every binary target its root reaches (row 43), so the headers reach the library without transitive
  propagation. The package identity of a source product is the URL's last path component, lowercased (as
  `spmPackageIdentity` does in the scaffolder).
- Texts:
  - one module from two pods (row 38): `Two CocoaPods binaries make the module ${name}: ${podA} ${versionA} and ${podB} ${versionB}. rn-xtool cannot link both. See ${link}`
  - a wrapper name taken: `The wrapper target ${name} would have the name of a binary target of ${pod}. See ${link}`
- If G1 picked fallback A: `archives/` is not written, each slice's `lib<Name>-ios-arm64.a` is the hard-linked real
  archive, and `links.archives` is empty. Fallback B: the slice holds `<Name>.framework/` with the thin archive as its
  binary, and `links.archives` lists those binaries.

- [ ] **Step 1: Write failing tests:** `renders the ML Kit package` (a golden string in the test); `lists the binary
  targets in the product itself` (row 43); `names binary targets, folders and module maps from one source` (row 42);
  `covers the union of subspecs two libraries name`; `stops on two binary pods that make one module` (row 38); `writes a
  .gitignore with * in pod-binaries` (row 63); `copies when a hard link crosses filesystems` (row 36); `rebuilds the
  folder on every call`; `refuses a folder under node_modules`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/stage.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: generate the pod-binaries package"`

### Task D5: Force-load the archives on the App target

**Files:** Modify `src/generate/packageSwift.ts` (`PackageSwiftInput.pods?: PodsLinks`), `src/generate/iosXtool.ts`
(`GenerateContext.pods?: PodsLinks`, passed through). Test: `tests/generate.test.ts`.

**Interfaces:**
```ts
// linkerFlags: ["-Xlinker", "-ObjC", ...-F paths, ...archives.flatMap(a => ["-Xlinker", "-force_load", "-Xlinker", a]),
//               ...weakFrameworks.flatMap(w => ["-Xlinker", "-weak_framework", "-Xlinker", w]),
//               ...(archives.length > 0 ? ["-Xlinker", "-no_objc_relative_method_lists"] : [])]   // G1 ruling 3, row 80
// GenerateContext.emptyTargets → writeEmptyTargetObjects (src/pods/emptyTargets.ts) before xtool-build (ruling 4, row 81)
// .linkedFramework(X) for each pods framework not already linked; .linkedLibrary(X) for each pods library but "c++"
//   (already there); both sorted.
```
- If G1 picked fallback A: `archives` is empty (SwiftPM links the slices), and the frameworks and libraries stay.

- [ ] **Step 1: Write failing tests:** `adds one -force_load per archive and the pods' frameworks and libraries`;
  `links each archive once, by -force_load only, and never -all_load` (row 44); `the manifest is byte-identical
  without pods` (the existing bare and Expo manifests); `keeps the absolute archive paths out of every persisted file`
  (only `ios-xtool/Package.swift` holds them).
- [ ] **Step 2: Run** `npx vitest run tests/generate.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: force-load binary pod archives"`

### Task D6: Never persist a binary file into `patches/`

**Files:** Modify `src/pipeline/rnSpm.ts` (the persist loop). Test: `tests/rnSpm.test.ts`.

**Interfaces:**
```ts
export function binaryInPatch(text: string): string | undefined;
//   the path of the first file with a `GIT binary patch` hunk, or an added file whose content starts with `!<arch>`,
//   `!<thin>` or a Mach-O magic; undefined otherwise
// The persist loop keeps the library's previous patch file (its content, or its absence) before patch-package runs, and
// puts it back when the new one fails binaryInPatch.
```
- Text (spec goal 6.3, verbatim): `⚠ Did not persist ${lib}'s scaffold: the patch would contain a binary file (${path})`

- [ ] **Step 1: Write failing tests:** `does not persist a patch with a GIT binary patch hunk, and says so` (row 40; a
  fake runner writes it, and the previous patch file comes back); `does not persist an added file with ar magic`;
  `persists a text-only patch as before`.
- [ ] **Step 2: Run** `npx vitest run tests/rnSpm.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: never persist binary files into patches"`

---

## E. Resource bundles

### Task E1: Build a podspec resource bundle

**Files:** Create `src/pipeline/resourceBundles.ts`. Test: `tests/resourceBundles.test.ts`.

**Interfaces:**
```ts
export interface BundleSource { key: string; baseDir: string; globs: string[]; owner: string }  // owner: "MLKitTextRecognition 6.0.0", "react-native-svg"
export interface BuiltBundle { name: string; owner: string; files: number }
export function bundleFiles(s: BundleSource): { dest: string; src: string }[];
//   the files under baseDir the globs match (micromatch, CocoaPods' glob syntax). A glob ending in `/**` keeps the layout
//   below its literal folder (Resources/LatinOCRResources/** → the bundle root); a folder any other glob matches is copied
//   whole under its name, and a file it matches goes to the bundle root under its basename, inside its nearest .lproj
//   folder (row 86; CocoaPods copies matched files flat, and NSBundle's URLForResource:withExtension: looks at the
//   root: react-native-svg's RNSVGCustomFilter.mm). Two files for one destination throw. Preflight P4.
export function resourceBundleInfoPlist(key: string): string;
//   CFBundleDevelopmentRegion en, CFBundleIdentifier org.cocoapods.<key> (characters other than A–Z a–z 0–9 . - become -),
//   CFBundleInfoDictionaryVersion 6.0, CFBundleName <key>, CFBundlePackageType BNDL
export async function writeResourceBundle(s: BundleSource, resourcesDir: string, log: (l: string) => void): Promise<BuiltBundle | undefined>;
//   Resources/<key>.bundle/ with the files copied (row 85) and Info.plist; never a symlink
```
- Texts:
  - compiled resources: `ℹ Left out of ${key}.bundle (${owner}), as they need Xcode's tools (asset catalogs, storyboards, xibs): ${files}`
  - no file: `⚠ ${key}.bundle (${owner}) matches no file (${globs}); it is not built`
  - one destination twice: `${key}.bundle (${owner}) would hold ${dest} twice: ${srcA} and ${srcB}. See ${link}`

- [ ] **Step 1: Write failing tests:** `puts ML Kit's model folder at the bundle root`; `flattens react-native-svg's
  metallib files to the bundle root`; `writes CocoaPods' Info.plist keys` (row 52); `leaves compiled resources out with
  an ℹ line`; `skips a bundle that matches no file, with a ⚠`; `stops on two files for one destination`; `hard-links
  and never writes a symlink`.
- [ ] **Step 2: Run** `npx vitest run tests/resourceBundles.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: build podspec resource bundles"`

### Task E2: Scaffolded libraries' `resource_bundles` become bundles

**Files:** Modify `src/pipeline/scaffoldResources.ts`. Test: `tests/scaffoldResources.test.ts`.

**Interfaces:**
```ts
export function scaffoldedResourceBundles(projectRoot: string): BundleSource[];
//   for the libraries unbundledResources reads: each unconditional s.resource_bundles / s.ios.resource_bundles entry
//   whose key is literal (or `#{s.name}`-style, resolved as today) and whose globs are literal strings; owner = the npm
//   name, baseDir = the package folder
// unbundledResources: what is still not copied: plain s.resources and bundles with a glob it cannot read (interpolated)
```
- With this, the F1 proof's `ℹ Not copied into the app: react-native-device-info (PrivacyInfo.xcprivacy)` line goes:
  the privacy bundle is built like any other (spec goal 4.2).

- [ ] **Step 1: Write failing tests:** `reads react-native-svg's RNSVGFilters bundle` (svg's podspec shape: the four
  platform lines, only `s.ios.` counts); `reads device-info's privacy bundle`; `leaves an interpolated glob to the ℹ
  line`; `no longer names a bundled library in the ℹ line`; the existing `unbundledResources` tests adapted.
- [ ] **Step 2: Run** `npx vitest run tests/scaffoldResources.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: bundle scaffolded libraries' resources"`

### Task E3: Copy the bundles into the app

**Files:** Modify `src/generate/iosXtool.ts` (`GenerateContext.resourceBundles?: BundleSource[]`). Test:
`tests/generate.test.ts`.

- After the app's resources are staged into `ios-xtool/Resources/`, each bundle is written there and listed in
  `xtool.yml` as `Resources/${key}.bundle`, after the app's own resources, sorted by name.
- Texts:
  - two bundles (row 38): `Two resource bundles would be copied to App.app/${key}.bundle: ${ownerA} and ${ownerB}. See ${link}`
  - a bundle named like an app resource (row 38): `The resource bundle ${key}.bundle (${owner}) would be copied over the app resource ${name} in App.app. See ${link}`
    (the app resources: `Frameworks`, `ip.txt`, `EXConstants.bundle` with expo-constants, and the bare app's staged
    resources)

- [ ] **Step 1: Write failing tests:** `lists the bundles in xtool.yml as Resources/<key>.bundle`; `stops on two
  bundles with one name`; `stops on a bundle named like an app resource` (row 38); `xtool.yml is byte-identical without
  bundles`.
- [ ] **Step 2: Run** `npx vitest run tests/generate.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: copy resource bundles into the app"`

---

## F. The `pods` step, the early checks, doctor and the checks after the build

### Task F1: The `pods` step

**Files:** Create `src/pods/step.ts`, `data/pod-terms.json`; modify `src/project/earlyChecks.ts`
(`binaryPodCandidates`), `package.json` `files` (already ships `data/`). Test: `tests/pods/step.test.ts`.

**Interfaces:**
```ts
export function binaryPodCandidates(projectRoot: string, opts: LibraryCheckOptions): PodRoot[];
//   each unconditional s.dependency the classifier calls `unmapped`, of each library rn-xtool would scaffold that the
//   project keeps on iOS (exclude, platforms.ios: null and expo.autolinking.exclude skip it, row 67)
export interface PodsResult {
  resolution: Resolution; wrapped: WrappedPod[]; binary: Record<string, { product: string }>;
  lock: PodsLock; bundles: BundleSource[];
}
export interface PodsStepDeps {
  cdnBase?: string; cache?: string; fetch?: typeof fetch; ar?: ArRunner;
  filesystemOf?: (dir: string) => Promise<{ dev: number; freeBytes: number }>; sdkDir?: string; log: (l: string) => void;
}
export async function runPodsStep(root: string, roots: readonly PodRoot[], table: PodTable, d: PodsStepDeps): Promise<PodsResult>;
```
- Order, all before anything changes in the project:
  0. `sweepStaleTemps(cache)` (row 73).
  1. `readPodsLock`; `resolveBinaryPods` with the locked versions.
  2. The SDK check (row 46): every `frameworks`/`weak_frameworks` name has `<sdk>/System/Library/Frameworks/<X>.framework/<X>.tbd`,
     every `libraries` name `<sdk>/usr/lib/lib<x>.tbd`.
  3. The downloads: a pod whose locked sha256 is cached needs none. For the others, `headSize` per URL.
  4. The disk gate (row 59): the downloads' bytes times `POD_DISK_FACTOR` (8, spec goal 5.5; G2 measured 7.5×) on the
     cache's filesystem.
  5. The announcement, only when something is downloaded (row 66).
  6. `fetchPodArchive` per download; `extractPod`; `wrapPod`.
  7. The lines: re-resolved, moved, minimum iOS (from `wrapPod`), privacy manifests, `binaryPinLines`, recorded.
  8. `writePodsLock` when anything changed: new entries, moved URLs, re-resolved versions; unused entries stay.
- `data/pod-terms.json`: `{ "terms": { "https://developers.google.com/ml-kit/guides": "https://developers.google.com/ml-kit/terms" } }`,
  keyed by a spec's `homepage` (a content fact, not a pod name; preflight P5). This file is the only place that holds
  Google's homepage: the fixtures use `https://example.invalid/…` homepages, and the terms test reads a fixture-only
  entry (review M7).
- Texts:
  - announcement (goal 5.3; preflight P5, P6):
    `ℹ pods — ${libs} need${s} ${n} CocoaPods binar${y|ies} that ${is|are} not in rn-xtool's cache, ${total} from ${hosts}: ${list}. From ${authors} ("${license text}"; ${homepage}${terms ? `; terms: ${terms}` : ""}). rn-xtool keeps them in ${cache} and does not copy them into the project.`
    `${list}` is `MLKitTextRecognitionCommon 5.0.0 (30.3 MB), MLKitCommon 13.0.0 (2.5 MB), …`, largest first; several
    vendors give one `From …` sentence each.
  - the privacy manifests (row 57): `ℹ pods — not copied into the app: the PrivacyInfo.xcprivacy inside ${frameworks}. Development builds run without them; privacy manifests are read only at App Store submission.`
  - the SDK (row 46): `${pod} ${version} (needed by ${lib}) links the ${framework|library} ${name}, which the iOS SDK rn-xtool builds with (${sdkName}) does not have. See ${link}`
  - disk (row 59, setup's wording): `Not enough free disk space for the CocoaPods binaries: the filesystem of ${cache} has ${free} free, and rn-xtool needs about ${need} there (${n} downloads ${total}, unpacked, wrapped and per-app copies ${rest}). Free some space, then build again.`
  - offline: Task A3's or Task B2's text, naming the first missing file and `(and ${k} more)` when there are more.

- [ ] **Step 1: Write failing tests** (the local server serves the A2 specs and synthetic tarballs whose frameworks come
  from `tests/support/macho.ts`; a fake `ArRunner`; a fake SDK folder of `.tbd` files):
  - `resolves, downloads, wraps and records ML Kit's shape` (the lock holds ten entries; the recorded line);
  - `announces vendor, count, size, host, license, homepage and terms before the first download` (row 66; the log
    order);
  - `makes no request with the lock and a full cache` (the server's `requests` is empty; no announcement, no recorded
    line);
  - `downloads again and verifies against the lock after the cache is deleted` (no recorded line);
  - `leaves the project and the lock as they were on a mismatch` (row 18; the lock's bytes are unchanged);
  - `prints the re-resolved line and records the new version` (row 11);
  - `stops before downloading when a framework or library is not in the SDK` (row 46);
  - `stops before the first download when the cache's filesystem is short` (row 59);
  - `names the host and the cache when offline, before anything is downloaded` (row 2);
  - `names the privacy manifests left inside frameworks in one ℹ line` (row 57);
  - `keeps lock entries no library needs`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/step.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add data src tests && npm run scan:private && git commit -m "feat: resolve and fetch binary pods"`

### Task F2: The `pods` and `pod-binaries` steps in `build`

**Files:** Modify `src/commands/build.ts` (`BuildDeps.pods`, `stagePods`; `buildSteps` gains `pods: boolean`),
`src/deps.ts` (`depsFingerprint` includes the lock's sha256; preflight P14). Test: `tests/build.test.ts`,
`tests/deps.test.ts`.

- Order:
  - `pods` right after `readProject` and before `prebuild`, planned when `binaryPodCandidates` is not empty;
  - `pod-binaries` right before `rn-spm` (after `prebuild`, `clean`, `patches`, `rn-artifacts` and SDK 57's `jsi`);
  - the merged table with `binary` goes to `applyPatches` and `runRnSpm`; `generate` gets `pods` links and
    `resourceBundles` (the staged pods' bundles, then `scaffoldedResourceBundles`).
- A project without candidates gets today's step list, byte for byte.
- Plan note (row 68, accept): an excluded library's persisted scaffold stays applied; SwiftPM never reads it.

- [ ] **Step 1: Write failing tests:** `runs pods before prebuild and pod-binaries before rn-spm`; `stops on an
  unreachable CDN before anything changes` (row 2: no prebuild, patches or rn-spm call); `stages pod-binaries on every
  build before rn-spm` and `stops when staging fails` (row 37); `does no pods work for an excluded library` (row 67);
  `plans today's steps for a project without binary pods`; `passes the binary pods to the patches and rn-spm steps`;
  `passes the links and the bundles to generate`; deps `the fingerprint changes with the lock`.
- [ ] **Step 2: Run** `npx vitest run tests/build.test.ts tests/deps.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: stage binary pods before rn-spm"`

### Task F3: The early checks let a binary pod through, offline

**Files:** Modify `src/project/earlyChecks.ts` (`unmappedFailure`, `offlinePodRoute`, `unresolvedPodLines`),
`src/project/capabilities.ts`, `src/commands/build.ts` (prints the lines after the early checks). Test:
`tests/earlyChecks.test.ts`, `tests/build.test.ts`.

**Interfaces:**
```ts
export function offlinePodRoute(pod: string, requirements: readonly string[], ctx: { lock: PodsLock; cache: string }): "binary" | "source" | "unknown";
//   in the lock → binary; else the newest cached spec version that satisfies the requirements: its route; else unknown
export function unresolvedPodLines(projectRoot: string, opts: LibraryCheckOptions & { cache?: string }): string[];
```
- `unmapped-pod` changes in one way (spec goal 5.1): an `unmapped` pod is refused only when `offlinePodRoute` says
  `source`. `binary` passes; `unknown` passes with the ℹ line.
- Text (spec verbatim): `ℹ pods — ${pod} (from ${lib}) is not resolved yet; rn-xtool build reads its spec from the CocoaPods CDN.`
- Plan note (preflight P12): `knownLimits.allow` lets an early refusal through as before; it does not apply to the
  `pods` step's stops, which are about files, not about what rn-xtool supports.

- [ ] **Step 1: Write failing tests** (row 1): `passes a pod the lock records`; `passes a pod whose cached spec is
  binary`; `refuses a pod whose cached spec is a git source without a table entry` (block 2's text); `does not refuse a
  pod it cannot route offline, and prints the ℹ line`; `makes no network request` (a `fetch` stub that throws);
  build `prints the not-resolved line after the early checks`.
- [ ] **Step 2: Run** `npx vitest run tests/earlyChecks.test.ts tests/build.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: let binary pods pass the early checks"`

### Task F4: The `pods` line in `doctor --project`

**Files:** Modify `src/project/capabilities.ts` (`Capabilities.binaryPods`), `src/commands/doctor.ts`. Test:
`tests/capabilities.test.ts`, `tests/doctor.test.ts`.

- From the lock and the cache; for unresolved pods (OQ6), the CDN specs and HEAD sizes, in parallel with the
  `rn-artifacts` probe and within the same 10 s deadline. `--offline`: no probe. `--report`: no probe.
- Lines (spec goal 5.2):
  - `✔ pods — ${n} CocoaPods binaries for ${libs}, in rn-xtool's cache and in rn-xtool-pods.lock.json`
  - `ℹ pods — ${n} CocoaPods binaries for ${libs}, ${k} to download from ${hosts} (${size})`
  - `⚠ pods — not checked: ${reason}`; `ℹ pods — not checked (offline)`; `ℹ pods — not checked (report)`
  - unused (OQ7, row 67): `ℹ pods — rn-xtool-pods.lock.json also records ${entries}, which no library needs now; rn-xtool keeps these entries`
  - a zip without unzip (row 24): `✖ pods — ${B3's text}`, only when a lock entry or a resolved pod is a zip
- Block 2's `pods` pin lines stay as they are, after these.

- [ ] **Step 1: Write failing tests:** `reports cached binaries`; `reports what is left to download, with its size`;
  `probes unresolved pods within the budget` and `warns not checked when the probe fails`; `does not probe with
  --offline`; `lists the lock entries no library needs` (row 67); `adds the unzip line only when a lock entry is a zip`
  (row 24); `prints no pods line for a project without binary pods` (the `--project` names list stays as it is).
- [ ] **Step 2: Run** `npx vitest run tests/capabilities.test.ts tests/doctor.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: report binary pods in doctor --project"`

### Task F5: Check the packed app

**Files:** Create `src/pods/postPack.ts`; modify `src/commands/build.ts` (after `xtool-build`, before the state with
the fingerprint, only with staged pods). Test: `tests/pods/postPack.test.ts`, `tests/build.test.ts`.

**Interfaces:**
```ts
export async function postPackChecks(appBundle: string, staged: StagedPods, nm: NmRunner): Promise<void>;
//   1. every resource_bundles key of a staged pod is App.app/<key>.bundle with an Info.plist;
//   2. App.app/Frameworks/ holds no framework named like a binary target;
//   3. every _OBJC_CLASS_$_ a force-loaded archive defines (llvm-nm --defined-only -j) is defined in the App binary
//      (CFBundleExecutable of App.app/Info.plist, else App).
```
- Text (rows 50, 51, 54, 55, 88): `The packed app is not what the CocoaPods binaries need, so rn-xtool removed it and does not install it:\n${items}\nSee ${link}`; App.app and the `.ipa` beside it are removed first (row 88). `build` records what the checks read in the state; `install` has xtool build the app first and runs them again before it installs
  with one item per problem:
  - `  - App.app/${key}.bundle is missing (${pod} ${version})`
  - `  - App.app/${key}.bundle has no Info.plist (${pod} ${version})`
  - `  - App.app/Frameworks/${name}.framework is there: xtool embedded a static binary as a dynamic framework`
  - `  - the App binary does not define ${symbol} (${pod} ${version}, force-loaded)` (the first five, then `and ${k} more`)
- A failed check leaves the state without the fingerprint, so the next `run` builds again.

- [ ] **Step 1: Write failing tests:** `passes a complete app`; `stops on a missing bundle or a bundle without
  Info.plist` (row 51); `stops on a binary target embedded under Frameworks/` (row 50); `stops on a class a
  force-loaded archive defines and the App binary does not` (row 55); build `runs the checks after xtool-build only with
  binary pods`.
- [ ] **Step 2: Run** `npx vitest run tests/pods/postPack.test.ts tests/build.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: check the packed app for binary pods"`

### Task F6: No binary in the npm package

**Files:** Create `tests/packageFiles.test.ts`; modify `docs/RELEASING.md` (item 4 names the test).

- The test runs `npm pack --dry-run --json --ignore-scripts` (no network, no build) and reads the first 8 bytes of each
  listed file: none may start with `!<arch>\n`, `!<thin>\n` or a Mach-O or fat magic (row 65). Today's package (133
  files) passes.

- [ ] **Step 1: Write failing tests:** `finds a planted ar file and a planted Mach-O file` (the magic check, exported
  from `tests/support/macho.ts` as `binaryMagic(file)`, on a temporary folder) and `npm pack ships no Mach-O or ar file`.
- [ ] **Step 2: Run** `npx vitest run tests/packageFiles.test.ts` → FAIL (no `binaryMagic` yet).
- [ ] **Step 3: Implement** `binaryMagic`, and write the RELEASING line.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add docs/RELEASING.md tests && npm run scan:private && git commit -m "test: keep binaries out of the npm package"`

---

## G. Proofs (controller)

### Task G2: Full build-only proof (spec "Verification")

No commit. In F1Proof reset to the Task 0 commit, after `npm run build`, with the ML Kit tarball installed as in G1
step 1. Delete `.build` between runs and record its size. Every failure goes back to its task as a red test, or to the
owner as a decision.

- [ ] **Step 1 (rows 1, 66).** `doctor --project` shows `ℹ pods — GoogleMLKit (from @react-native-ml-kit/text-recognition)
  is not resolved yet; …` (or, online, the "to download" line) and no refusal.
- [ ] **Step 2 (rows 42–47, 50–53).** `rn-xtool build`:
  - prints the announcement before any download, then the recorded line, then produces `App.app`;
  - `llvm-nm` finds `_OBJC_CLASS_$_MLKTextRecognizer`, `_OBJC_CLASS_$_MLKITx_SRLRegistry`, `_OBJC_CLASS_$_TextRecognition`
    and `_OBJC_CLASS_$_GTMLogger`;
  - `App.app/` holds the five `…OCRResources.bundle`s, each with an `Info.plist`; `App.app/Frameworks/` holds no ML Kit
    framework; the post-pack checks pass;
  - `git status` in the app shows only `rn-xtool-pods.lock.json`, the library's persisted patch and the app's own edits,
    and `grep -l "GIT binary patch" patches/*` prints nothing;
  - record whether the source packages' `.process` privacy resources built (row 47), the App.app growth (row 53), the
    `.build` size (row 61), and the cache's size against the downloads (the disk factor; if it is far from 6, the owner
    decides whether F1's `POD_DISK_FACTOR` changes in a `fix:` commit with its test).
- [ ] **Step 3 (Review Focus 1).** Build again with rn-xtool's network cut (`unshare -n` around the CLI, or the host
  offline), `.build` kept: the `pods` step makes no request, and `App.app` is produced again.
- [ ] **Step 4 (row 18).** Delete `~/.cache/rn-xtool/pods` and build with the lock: everything is downloaded again and
  verified, with no recorded line. Then edit one sha256 in the lock: row 18's stop, and `git status` shows nothing new.
  Restore the lock.
- [ ] **Step 5 (goal 5.4).** Delete `.build` and the cache, and build offline: goal 5.4's stop, naming the cache, before
  `prebuild` or `patches`.
- [ ] **Step 6 (OQ3).** Add react-native-svg 15.16.0 (from `tests/.cache/react-native-svg-15.16.0.tgz`, no network):
  `App.app/RNSVGFilters.bundle` holds the `.iphoneos.metallib` files at its root, and the `ℹ Not copied` line no longer
  names svg (nor device-info).
- [ ] **Step 7 (row 67).** `"exclude": ["@react-native-ml-kit/text-recognition"]`: no `pods` step, `doctor --project`
  lists the lock entries as unused, and the build succeeds.
- [ ] **Step 8 (row 44; needs the owner's OK: npm installs of the work app's other libraries).** The same app plus the
  libraries of block 2's work-app list (`<scratchpad>/libmatrix/libmatrix-findings.md`, "Result"): one build, no
  `duplicate symbol`, every library's classes in the binary.
- [ ] **Step 9.** Record versions, timings and sizes for the PR body.

### Task G3: Expo SDK 58 build-only proof (controller; OQ9, if disk allows)

No commit. It needs the owner's OK: a `create-expo-app` download and about 1 GB of disk with its build.

- [ ] **Step 1.** `npx --yes create-expo-app@<createExpo pin> <scratchpad>/binpods/expo58 --template
  blank-typescript@sdk-58`, then `npm install <scratchpad>/binpods/react-native-ml-kit-text-recognition-2.0.0.tgz`.
- [ ] **Step 2.** `rn-xtool build`: `pods` runs before `expo prebuild`, `pod-binaries` after it, and G2 step 2's
  checks pass.
- [ ] **Step 3.** Without G3, Task H documents ML Kit on Expo as build-unverified.

---

## H. Docs and CHANGELOG

### Task H: Document binary CocoaPods pods

**Files:**
- `docs/troubleshooting.md`:
  - `## CocoaPods binaries` (the section A3 opened): what the `pods` step does; every stop of goals 1, 2 and 5 and of
    Tasks A3–F5, quoted from the tasks; the lock (what it holds, commit it, how to trust a changed file, merge
    conflicts: keep either side, row 69); the cache path, that deleting it is safe (row 60) and that it must not be
    published (row 64); offline use (a fresh machine needs the CDN once, row 6; a clean `.build` needs GitHub once,
    row 48); the first download is trusted on first use over HTTPS and the lock records it (row 20); a vendor that
    removed a file (row 15); `exclude` for a conflict (row 9); the table as the one place to align pins (row 49);
    `rn-xtool build` as the only entry point (row 37); the shapes left for later (rows 28, 29).
  - `### Libraries that depend on CocoaPods pods`: the ML Kit sentence becomes present tense (binary pods are
    resolved; a git-source pod without a SwiftPM package is still refused).
- `docs/libraries.md`:
  - the @react-native-ml-kit/text-recognition row: Bare 0.88 build ✅ with the date and "device ⏳" until Task I (and
    the SDK 58 cell per G3);
  - the intro: binary pods from the CocoaPods CDN; only text recognition is verified; the app grows by about 66 MB
    (row 53, with G2's number); the files are Google's, under the ML Kit Terms
    (https://developers.google.com/ml-kit/terms); rn-xtool downloads them for the user's own build and does not accept
    terms on the user's behalf;
  - the resource-bundle sentence and the "Next generic scaffolder fix" paragraph (`docs/libraries.md:71-72`) become
    present-tense behaviour; the svg and device-info rows lose "not copied".
- `docs/how-it-works.md`: the `pods` and `pod-binaries` steps in "The build, step by step", and a "CocoaPods binaries"
  section (cache, lock, wrap, `-force_load`, bundles, post-pack checks).
- `docs/upstream/react-native-scaffolder.md`: fix 27 is written in Task D2; check it.
- `docs/RELEASING.md`: the `outsideRequirement` sentence (Task D1) and item 4 (Task F6).
- `CHANGELOG.md` `[Unreleased]`:
  - Added: binary CocoaPods pods (ML Kit text recognition, build-verified), the lock file, resource bundles for
    scaffolded libraries (react-native-svg's filters), the `llvm-ar` doctor line;
  - Upgrading: commit `rn-xtool-pods.lock.json`; deleting `~/.cache/rn-xtool/pods` is safe; a scaffold persisted under
    `knownLimits.allow` before this release gets Task D3's warning: delete it and rebuild (row 41).
- Test: `tests/docsLinks.test.ts` stays green.

- [ ] **Step 1: Write** the docs. Every quoted message is copied from Tasks A–F.
- [ ] **Step 2: Run** `grep -rn "Support for binary pods is planned\|do not work yet" docs README.md` → no hit about
  binary pods or resource bundles. Then `npm test && npm run lint` → PASS.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && npm run scan:private && git commit -m "docs: document binary CocoaPods pods"`

---

## I. The owner's device pass (free team)

### Task I: ML Kit and svg filters on the iPhone

No commit by the implementer. Until the owner confirms an item, the docs call it build-verified only.

**Run 2026-11-05 (the owner, iOS 26, install over Wi‑Fi): pass.** The G2 app (bare React Native 0.88.1 with ML Kit
text recognition 2.0.0, react-native-svg 15.16.0 and an entitlements file): install's re-run of the post-pack checks
passed silently, and the app installed and launched. Fast Refresh works. The item left unchecked below was not run.

- [x] The app from G2 installs and launches (row 52).
- [x] `TextRecognition.recognize()` on a photo of a printed page returns its blocks and lines, and the first call shows
  no "Invalid model path." (rows 54–56). (A photo of printed text; the text came back.)
- [ ] Optional: one Japanese or Chinese sample through the matching script option.
- [x] react-native-svg: an `<FeColorMatrix>` or another Metal filter renders (OQ3). (`FeComposite` xor.)
- [x] The results go into `docs/libraries.md`'s dates, in one `docs:` commit by the controller.

---

## J. Final review (controller)

### Task J: Review before the PR

- [ ] **Step 1.** `npm test && npm run lint && npm run scan:private` are green, with the tarball-backed tests run, not
  skipped.
- [ ] **Step 2.** A reviewer who did not write the code reads the whole diff against the spec, the rulings and this
  plan, with Review Focus 1–7.
- [ ] **Step 3.** Before the verdict, the reviewer answers, with no hints: **"Name three ways this fails in production
  that no test covers."** Each answer not in the spec's failure table goes to the owner as a decision, not to the
  implementer as a fix.
- [ ] **Step 4.** The verdict, then the PR body (versions, G1's shape, G2's results and sizes; no absolute paths).

---

## Preflight

### Spec references checked (code at cbd64c3)

Most of the spec's line numbers were read on `main`, before block 2's code: they point at the right code on `main`, and
have moved on this branch. Each is listed with where it is here.

| Spec reference | Here |
|---|---|
| `src/versions.ts:14` `IOS_MIN` 16.4 | ✔ |
| `src/generate/packageSwift.ts:147` `-Xlinker -ObjC`; `:146-151` `-F` and `.linkedFramework` | ✔ |
| `src/generate/xtoolYml.ts:9` the `Frameworks` resource | ✘ `:11` (`BASE_RESOURCES`) |
| `src/pipeline/rnArtifacts.ts:181-198` `headersXcframeworkInfoPlist`; `:416`, `:425-426`; `:140` `EMPTY_AR_ARCHIVE`; `:459` `swapIn` | ✔ |
| `src/pipeline/jsiHeaders.ts:134`, `:128`, `:123-127`, `:75-145` | ✔ |
| `src/generate/iosXtool.ts:124-127` Resources rebuilt | ✘ `:192-197` |
| `src/generate/iosXtool.ts:170-177` `Resources/<name>` in xtool.yml | ✘ `:245-252` |
| `src/generate/iosXtool.ts:197` `.gitignore` `*` | ✘ `:273` |
| `src/commands/doctor.ts:510` the `llvm-nm` line | ✘ `:540` |
| `src/commands/setup.ts:273` the system `tar` | ✔ |
| `src/paths.ts:68-71` `cacheDir()` | ✘ `:74-77` |
| `src/pipeline/rnArtifactsStep.ts:13-15`, `:25-39` | ✔ |
| `src/tools/download.ts:20-53`, lines 25 and 35 | ✔ |
| `src/project/earlyChecks.ts:1-5` (offline checks) | ✔ |
| `src/project/earlyChecks.ts:223-241` `binariesFailure` | ✘ `:231-249` |
| `docs/troubleshooting.md:169` | ✔ |
| `vendor/rn-spm/spm/scaffold-package-swift.js:187-236` `classifyPodDependency` "on the block-2 branch" | ✘ `:279-335` |
| `scaffold-package-swift.js:1845-1871` symlink-relative paths | ✘ `:2225-2250` (`symlinkDir`, `relFromManifest`) |
| `docs/libraries.md:50` async-storage | ✘ `:57` |
| `docs/libraries.md:58-59` "Next generic scaffolder fix" | ✘ `:71-72` |
| `src/pipeline/scaffoldResources.ts` `unbundledResources` | ✔ (`:94-108`) |
| `RNSVG.podspec:26` `s.ios.resource_bundles` (react-native-svg 15.16.0) | ✔ (`../app-bare-086`'s copy; four platform lines at 25–28) |
| `ios/TextRecognition.m:3-9` (the npm package) | ✔ |
| xtool `Packer.swift:142-148` `packFileToRoot`, `:166-180` the magic check, `Planner.swift:144-146` "at 2af0b67" | the local checkout is 952a7ff: `:135-141`, `:155-180`, `Planner.swift:144-145`; the same logic |
| Spec fact 22 "group C is not built" | outdated: group C is on this branch's base (7d4487f) |

### Tests that must change

- `tests/download.test.ts`: new options (B1); the existing tests stay.
- `tests/doctor.test.ts`: the full doctor's names list gains `llvm-ar` (C2); `doctor --project` gains the `pods` lines
  only for projects with binary pods (F4).
- `tests/rnArtifacts.test.ts`: `readXcframeworkSlices` (C4); `readXcframeworkLibraries` keeps its result.
- `tests/rn-scaffolder.test.ts`: the fix 27 describe, the `classifyPodDependency` it.each, the hunk test (D2).
- `tests/podTable.test.ts`, `tests/config.test.ts`: the four entries, `outsideRequirement`, `binary` (D1, D3).
- `tests/earlyChecks.test.ts`: the `binary` kind, the ℹ pin line, `binaryPodCandidates`, the offline routes (D1, D3,
  F1, F3).
- `tests/patches.test.ts`: the `=binary` stale line (D3).
- `tests/rnSpm.test.ts`: the table file with binary entries, the persist guard (D3, D6).
- `tests/generate.test.ts`: `-force_load`, bundles, byte-identical manifests without pods (D5, E3).
- `tests/scaffoldResources.test.ts`: bundled resources leave the ℹ line (E2).
- `tests/build.test.ts`: the two steps, the post-pack checks, the not-resolved line (F2, F3, F5).
- `tests/capabilities.test.ts`, `tests/deps.test.ts` (F2, F4).
- New: `tests/pods/*.test.ts`, `tests/resourceBundles.test.ts`, `tests/packageFiles.test.ts`, and the helpers
  `tests/support/{podsServer,archives,macho}.ts`, fixtures `tests/fixtures/pods/`.
- Unchanged and used as oracles: `tests/vendor-rn-spm.test.ts`, `tests/patches-upstream.test.ts`,
  `tests/docsLinks.test.ts`, the scaffold goldens.

### How the scaffolder's two copies are synced and tested

Only Task D2 touches them: the vendored copy is edited, both 0.88 patches are regenerated from it by the recipe in
Global Constraints (the same as `docs/RELEASING.md` "Scaffolder changes" step 2), and the byte tests run without skips.
The revision stays 4.

### Confirmed for the plan

- **The download floor.** `minBytes ?? 1024 * 1024`, rejecting `size <= minBytes` (`download.ts:25`, `:35`); four ML
  Kit tarballs are smaller (MLImage 7 KB, MLKitVision 351 KB, GoogleMLKit 463 KB, MLKitTextRecognition 812 KB). The
  pods code passes `minBytes: 0` and `expectedBytes` (B1, B2).
- **The xcframework helper is reused as it is.** `headersXcframeworkInfoPlist(name, [POD_SLICE])` gives the slice
  `lib<name>-ios-arm64.a` + `Headers`, the ExpoModulesJSIHeaders shape; `EMPTY_AR_ARCHIVE` is the placeholder. Only the
  vendored-xcframework input needs `readXcframeworkSlices` (P8).
- **`llvm-ar` is on the PATH rn-xtool uses.** `toolEnv()` puts `~/.local/share/swiftly/bin` first; it holds `llvm-ar`
  (LLVM 21.0.0, `--format=darwin` listed in `--help`) next to `llvm-nm`; there is no `llvm-lipo` in the toolchain.
- **How `xtool.yml` resources are copied today.** `EXConstants.bundle` is written by `app-config` at
  `ios-xtool/EXConstants.bundle` and listed bare; the app's resources are staged in `ios-xtool/Resources/` (removed and
  rebuilt by `generate`) and listed as `Resources/<name>`; xtool copies each to `App.app/<last component>` with
  `FileManager.copyItem`. Bundles therefore go into `Resources/` inside `generate` (E3), as regular files or hard links.
- **The order of steps in `build.ts`:** Fact 7. `pods` goes after `readProject` and before `prebuild`; `pod-binaries`
  right before `rn-spm`; the post-pack checks after `xtool-build` and before the fingerprinted state.
- **The npm package today** (`npm pack --dry-run --json --ignore-scripts`, 133 files) holds no Mach-O or `ar` file.

### Findings for the owner (the spec is not edited)

- **P1 (spec references).** The line numbers marked ✘ above were read on `main`; the plan uses this branch's.
- **P2 (goal 1.5, "using block 2's matcher").** `podRequirementSatisfied` treats a prerelease version and an unreadable
  requirement as met, which is right for a warning and wrong for choosing a version (`1.0.0-beta7` would satisfy
  anything). Planned: a strict matcher with Gem::Version ordering (Task A1); block 2's stays for the pin lines.
- **P3 (goal 2.7).** The scaffolder's `podTableEntry` refuses an entry without `url`/`exact`, so the table file cannot
  carry `{ "binary": { "product": … } }` before fix 27 reads it (Task D2). Fix 25 and 26 are taken: the route is fix 27.
- **P4 (changes goal 4.1's "relative layout kept").** react-native-svg loads its kernels with
  `[bundle URLForResource:name withExtension:@"iphoneos.metallib"]` (`apple/Filters/MetalCI/RNSVGCustomFilter.mm`),
  which looks at the bundle root; keeping `Filters/MetalCI/` would hide them. CocoaPods copies matched files flat.
  Planned: a glob ending in `/**` keeps the layout below its folder (ML Kit's `Resources/LatinOCRResources/**` lands at
  the root either way); any other match goes to the root by basename; two files for one name stop (Task E1).
- **P5 (goal 5.3 and OQ8's "terms URL").** No spec carries a terms URL: ML Kit's give the license text ("Copyright 2024
  Google LLC"), the homepage and `authors` ("Google, Inc."). Planned: `data/pod-terms.json` maps a spec's `homepage` to
  its terms URL (a content fact, the same for every ML Kit pod; no pod name or version), with ML Kit's one entry; the
  vendor in the line is the spec's `authors` (`From Google, Inc. (…)`), not the spec's "They are Google's". Owner:
  confirm the file and the wording.
- **P6 (goal 5.3's prefix).** The spec quotes the line as `▸ pods — …`. `▸ <name>` is the step header that `step()`
  prints; planned: the header `▸ pods` stays, and the announcement is an `ℹ pods — …` line under it.
- **P7 (fact 19).** `downloadFile` sends no `User-Agent`, never compares with `Content-Length`, loses the network cause
  (`getaddrinfo ENOTFOUND` lives in `err.cause`), and its checksum text points at `src/versions.ts`. Planned: options
  and `cause` in Task B1; the pods code checks hashes itself with its own texts (Task B2).
- **P8 (fact 14, goal 2.2).** `readXcframeworkLibraries` returns no `LibraryPath`/`HeadersPath`; a vendored
  `.xcframework` needs them. Planned: `readXcframeworkSlices` (Task C4).
- **P9 (goal 2.3).** GoogleMLKit keeps its `module.modulemap` in `preserve_paths`, not in a `module_map` key. Planned:
  a `module.modulemap` beside the selected headers is the pod's own map (Task C4).
- **P10 (fact 15).** xtool's `copyItem` keeps symlinks as symlinks and fails on an existing name: bundles hold regular
  files or hard links, and the collision stops of goal 4.3 also protect xtool's copy (Tasks E1, E3).
- **P11 (goal 4.1).** `ios-xtool/Resources` is removed by `generate` on every build, so bundles are written inside
  `generate`, not by the staging step (Task E3).
- **P12 (gap).** `knownLimits.allow` covers the early refusals only; the `pods` step's stops (mismatch, offline, disk,
  shapes) are not allowable. A project that had ML Kit under `knownLimits.allow` now gets its pods resolved and
  downloaded instead of failing at compile. Proposed accept, said in the CHANGELOG.
- **P13 (goal 1.3).** The spec caches "each file"; the version index keeps changing until 2026-12-02. Planned: the index
  is fetched again only when no cached version satisfies a requirement (Task A4).
- **P14 (gap).** `depsFingerprint` does not read the lock, so `rn-xtool run` would not rebuild after a pulled lock
  change. Planned: the lock's sha256 joins the fingerprint (Task F2).
- **P15 (row 41).** The spec expects a revision bump. Fix 27 adds content only to libraries every earlier release
  refused, so no bump (block 2's P14 rule); a scaffold persisted under `knownLimits.allow` without the route gets Task
  D3's line. Row 41 stays accept.
- **P16 (gap: http sources).** The spec does not say what to do with a plain `http://` source. Planned: allowed, as
  CocoaPods allows it; the lock's sha256 protects later runs. The owner may prefer a ⚠ or a stop.
- **P17 (gap: the disk factor).** 6× comes from fact 2 (40.3 MB downloaded, about 139 MB unpacked, 58 MB wrapped).
  The cache keeps the extracted tree for the bundles' hard links; G2 records the measured factor (Task G2 step 2).
- **P18 (gap: Wi-Fi installs).** `install` over Wi-Fi rebuilds the `.ipa` with `xtool dev build --sign --ipa` from the
  same `ios-xtool/`, without the post-pack checks. Proposed accept: the inputs are the ones `build` checked.
- **P19 (disk).** 12 GB free on the build disk on 2026-11-05 (the ledger says about 13); the proof's peak stays under
  1.5 GB.
- **P20 (proof app).** F1Proof holds block 2's uncommitted F2 changes (entitlements, app-auth); Task 0 commits them in
  its scratch history first, so G2 step 2's `git status` reads clean.
- **P21 (doctor, OQ6).** The probe shares the 10 s deadline with `rn-artifacts` by running in parallel with it; a slow
  CDN shows `not checked: <reason>` rather than a longer doctor.
- **P22 (source tags).** SwiftPM's `exact: "3.5.0"` and `exact: "6.0.1"` must match the `v3.5.0` and `v6.0.1` tags;
  SwiftPM accepts a leading `v`. G1 step 5 confirms it.
- **P23 (`c++`).** The App target already links `c++`; the pods' `libraries` skip it (Task D5).
- **P24 (sizes).** Whether dl.google.com sends `Content-Length` on HEAD was not checked offline; G1 step 2 records it,
  and the line says `size unknown` otherwise.
- **P25 (block 2's ℹ line).** With E2, device-info's `PrivacyInfo.xcprivacy` bundle is built, so block 2's F1 line
  `ℹ Not copied into the app: react-native-device-info (PrivacyInfo.xcprivacy)` goes; `docs/libraries.md`'s device-info
  and svg rows change (Task H).
- **P26 (the brief).** `downloadFile` lives in `src/tools/download.ts`, not `src/pipeline/download.ts`.
