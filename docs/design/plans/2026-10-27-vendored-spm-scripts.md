# Bare React Native 0.86 and 0.87 via Vendored SwiftPM Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `rn-xtool doctor | build | install | start | run` work on bare projects created with React Native 0.86.2, 0.86.3 and 0.87.1, with Expo projects and bare 0.88.0 unchanged.

**Architecture:** An exact list of supported React Native versions says, per version, whether the project's own `scripts/spm` (0.88.0) or a vendored copy of RN 0.88.0's SwiftPM scripts (with our scaffolder patch and four small edits) drives the existing `rn-spm` driver. For 0.86.x, whose Maven artifacts predate the headers-spec layout, a new `rn-artifacts` build step downloads the slot with the vendored downloader and adapts it into the 0.88 layout under `ios/build/rn-artifacts/`, which the driver then uses offline.

**Tech Stack:** TypeScript (Node 20, ESM), vitest, CommonJS driver `scripts/rn-spm-generate.js`, vendored RN 0.88.0 `setup-apple-spm.js` + `scripts/spm/*` (MIT, Meta), yargs 17.7.x, micromatch 4.0.x, `plist`, xtool 1.23.0, Swift 6.4.

**Spec:** `docs/design/specs/2026-10-26-vendored-spm-scripts-design.md` (evidence: `docs/research/rn-086-vendored-spm-spike.md`, `docs/research/rn-087-recon.md`).

## Global Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0 unchanged; CocoaPods never involved; `IOS_MIN` stays 16.4.
- Supported React Native, exact versions only: `SUPPORTED_RN = { "0.86.2": "vendored", "0.86.3": "vendored", "0.87.1": "vendored", "0.88.0": "installed" } as const` in `src/versions.ts`. `MIN_RN_MINOR` goes.
- Expo projects and bare 0.88.0 behave exactly as before: same four bundled patches staged, same golden manifests, same build steps (no `rn-artifacts`). Every task ends with the full `npm test` green.
- Vendored projects never get a patch applied to `node_modules/react-native`; the vendored copy is their only script source. The installed RN's codegen, `package.json` and `hermes-compiler` are still used.
- Inside the vendored copy the installed RN root comes only from `process.env.RN_SPM_RN_ROOT` (edits E2/E3; unset → error, never a `__dirname` fallback); E1 resolves the codegen template relative to the vendored copy.
- Adapter: no 0.88 slot is read at runtime; unknown layout → `ArtifactLayoutError` naming the file and the version, no fallback; output only under `ios/build/rn-artifacts/<version>/<flavor>/`; raw slots stay in RN's own `~/Library/Caches/ReactNative/spm-artifacts/<version>/<flavor>` (also on Linux). The user's `rnArtifactsDir` bypasses the step.
- The user's `ios/` is never modified. Only `ios/build/` and `ios-xtool/` are written.
- Error texts given in this plan are verbatim.
- Commits: Conventional Commits in English, no body, one logical change each; never `--force`; no scratch or debug code committed. Device steps (Tasks 10–13) are run by the controller with Willy; implementers never need the iPhone.

## Review Focus

1. An Expo project whose `react-native` drifted from 0.88.0 (e.g. 0.88.1 after `expo install --fix`) must still stop with the "pin react-native to 0.88.0" message, never build with unpatched scripts (Task 3 test `stops an installed-scripts project whose react-native differs from the patch`).
2. A raw slot left by an interrupted download (no `artifacts.json`, or an entry whose xcframework is gone) must be downloaded again, not adapted (Task 7 test `re-runs the downloader when the raw slot is incomplete`).
3. An adaptation interrupted mid-write (ENOSPC, Ctrl-C) must not leave a tree the next build treats as current (Task 6 test `a failed adaptation leaves no stamped tree`).
4. A project on another filesystem than `~/Library/Caches` (hard links fail with `EXDEV`) must still adapt, by copying (Task 6 test `falls back to copying when hard links fail`).
5. A library without a `Package.swift` on a vendored project: the scaffold run and its retry must use the same vendored scripts root and the same adapted artifacts as the first run (Task 4 test `the scaffold run keeps --scripts-root and --artifacts`).

---

### Task 1: Vendored RN 0.88.0 SwiftPM scripts with a provenance test

**Files:**
- Create: `vendor/rn-spm/{setup-apple-spm.js, spm/*.js, codegen/templates/Package.swift.spm-template}` (RN 0.88.0 `scripts/` files, same relative layout), `vendor/rn-spm/package.json` (`{ "type": "commonjs" }`: rn-xtool is `"type": "module"`, as `scripts/package.json` already does), `vendor/rn-spm/LICENSE` (the tarball's `package/LICENSE`), `vendor/rn-spm/README.md` (origin react-native 0.88.0, MIT, Meta Platforms; modifications: the 13 fixes of `docs/upstream/react-native-scaffolder.md` via `patches/react-native+0.88.0.patch`, then E1–E4 via `rn-xtool-edits.patch`; it also says that the `__dirname` candidates in `spm/spm-utils.js` and `setup-apple-spm.js` `resolveReactNativeRoot` are untouched and unreachable, since the driver always passes `--react-native-root`), `vendor/rn-spm/rn-xtool-edits.patch`
- Modify: `package.json` (`"files"` adds `"vendor"`; dependencies `"yargs": "~17.7.2"`, `"micromatch": "~4.0.8"`), `.gitignore` (`tests/.cache/`)
- Test: `tests/vendor-rn-spm.test.ts`

**Interfaces:**
- Produces: `vendor/rn-spm/` is a valid `--scripts-root` (Task 4). Edits, applied after the 0.88 patch, nothing else changed:
  - E1 `spm/spm-utils.js` `installSpmCodegenTemplate`: template path `path.join(__dirname, '..', 'codegen', 'templates', 'Package.swift.spm-template')`.
  - E2 `spm/read-podspec.js` `readRnVersionMacros`: reads `path.join(process.env.RN_SPM_RN_ROOT, 'package.json')`; when the env is unset it throws, before its `try`, `RN_SPM_RN_ROOT is not set: rn-xtool's vendored SwiftPM scripts need the installed react-native directory`.
  - E3 `spm/download-spm-artifacts.js` `main`: `rnRoot` = `process.env.RN_SPM_RN_ROOT`, same error when unset.
  - E4 `spm/download-spm-artifacts.js`: yargs option `allow-pre-headers-spec` (boolean, default false); the companions loop moves into exported `addHeadersCompanions(artifactsJson: object, outputDir: string, allowPreHeadersSpec: boolean): void` (called where the loop was); with the flag a missing `ReactNativeHeaders`/`ReactNativeDependenciesHeaders` companion is skipped (one `log` line, no entry) and `artifacts.json` is still written with the entries present; without it RN's `die(...)` as before.
- `rn-xtool-edits.patch` is a unified diff with `a/spm/…`/`b/spm/…` paths, applied with `patch -p1 -F0` inside the vendored dir.
- Pristine source, pinned: `tests/.cache/react-native-0.88.0.tgz` from `npm pack react-native@0.88.0 --pack-destination tests/.cache`, integrity `sha512-v/wee0nYWcammMYBnSat/e3WY/5iaf9YQOMcBrfKT/wPApPPlHp94hgZovBtwhMuthR01yc/8cGn0FpFTE/C4A==`. The provenance tests skip (with that command in the skip reason) when the tarball, `tar` or `patch` is missing.

- [ ] **Step 1: Fetch the pristine tarball** `mkdir -p tests/.cache && npm pack react-native@0.88.0 --pack-destination tests/.cache` → `tests/.cache/react-native-0.88.0.tgz` exists; add `tests/.cache/` to `.gitignore`.
- [ ] **Step 2: Write failing tests** in `tests/vendor-rn-spm.test.ts`:
  - `the cached tarball is react-native 0.88.0` → `"sha512-" + sha512(file).base64 === INTEGRITY`.
  - `vendor/rn-spm is react-native 0.88.0 with our patch and rn-xtool-edits.patch applied` → extract `package/scripts/{setup-apple-spm.js,spm,codegen/templates/Package.swift.spm-template}` to a temp dir; `patch -p4 -F0 -d <tmp>/package/scripts -i patches/react-native+0.88.0.patch` exits 0; `patch -p1 -F0 -d <same> -i vendor/rn-spm/rn-xtool-edits.patch` exits 0; the recursive file list equals `vendor/rn-spm`'s minus `README.md`, `LICENSE`, `package.json`, `rn-xtool-edits.patch`; every file `Buffer.equals`.
  - `LICENSE is react-native 0.88.0's` → equals the tarball's `package/LICENSE`.
  - `the vendored scripts resolve yargs and micromatch from rn-xtool` → `createRequire(vendor/rn-spm/spm/download-spm-artifacts.js).resolve("yargs")` and `("micromatch")` start with `path.join(packageRoot(), "node_modules")`.
  - `E1 installs the codegen template from the vendored copy` → `installSpmCodegenTemplate(app, <temp dir with no scripts/>)` with `app/build/generated/ios/` present writes `Package.swift` equal to `vendor/rn-spm/codegen/templates/Package.swift.spm-template`.
  - `E2 reads the React Native version macros from RN_SPM_RN_ROOT` → env pointing at a temp dir whose `package.json` has `"version": "0.86.3"`; `readPodspecCached` on a podspec with `-DREACT_NATIVE_MINOR_VERSION=#{x}` gives define `REACT_NATIVE_MINOR_VERSION=86`; with the env deleted, a fresh podspec file throws `/RN_SPM_RN_ROOT is not set/`.
  - `E3 refuses to download without RN_SPM_RN_ROOT` → `main(["--version","0.86.3","--output",tmp])` rejects `/RN_SPM_RN_ROOT is not set/` (no network: it is the first statement).
  - `E4 keeps a pre-headers-spec slot only when asked` → `addHeadersCompanions({React:{…},ReactNativeDependencies:{…}}, emptySlot, true)` leaves the object without companion keys; with `false` it throws `/ReactNativeHeaders\.xcframework is missing from the artifact slot/` (reset `process.exitCode` afterwards).
- [ ] **Step 3: Run** `npx vitest run tests/vendor-rn-spm.test.ts` → FAIL (`vendor/rn-spm` missing).
- [ ] **Step 4: Build the vendored copy**: extract the three paths from the tarball into `vendor/rn-spm/` (dropping `package/scripts/`), apply `patches/react-native+0.88.0.patch` with `-p4`, snapshot it, make E1–E4, write `rn-xtool-edits.patch` from the snapshot (`diff -ruN a b` with the snapshot as `a`), add `package.json`, `LICENSE`, `README.md`; `npm i yargs@~17.7.2 micromatch@~4.0.8`; add `"vendor"` to `files`.
- [ ] **Step 5: Run** the test file → PASS (no skips on this machine); `npm pack --dry-run 2>&1 | grep vendor/rn-spm/spm/spm-utils.js` prints a line; `npm test`, `npm run lint`, `npm run scan:private` clean.
- [ ] **Step 6: Commit** `git add vendor package.json package-lock.json .gitignore tests/vendor-rn-spm.test.ts && git commit -m "feat: vendor React Native 0.88 SwiftPM scripts"`

### Task 2: Supported versions, the gate, `rnScripts` and doctor

**Files:**
- Modify: `src/versions.ts`, `src/project/types.ts`, `src/project/bare.ts` (`checkRnVersion`, order of the expo-modules check; delete `MIN_RN_MINOR` there and hardcode `react-native@0.88.0` in the "not installed" hint), `src/project/expo.ts` (`rnScripts: "installed"`), `src/commands/doctor.ts` (`ProjectProbe`, `readProjectProbe`, `projectSummary`)
- Create: `tests/fixtures/bare-086/` and `tests/fixtures/bare-087/` (`ios/**` + `package.json` at the fixture root, no `template/` dir, like `tests/fixtures/bare`; `tempBare` in bare.test takes a fixture name; from the `template/` dir of `npm pack @react-native-community/template@0.86.3` and `@0.87.2`, which pins react-native 0.87.1; `_xcode.env` and `Images.xcassets` included as shipped)
- Test: `tests/project/bare.test.ts`, `tests/project/expo.test.ts`, `tests/project/pbxproj.test.ts`, `tests/doctor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/versions.ts
  export const SUPPORTED_RN = { "0.86.2": "vendored", "0.86.3": "vendored", "0.87.1": "vendored", "0.88.0": "installed" } as const;
  export type RnScripts = "installed" | "vendored";
  export function rnScriptsFor(version: string): RnScripts | undefined;   // Object.hasOwn, exact match
  export function supportedRnList(): string;                             // "0.86.2, 0.86.3, 0.87.1 and 0.88.0"
  // ProjectInfo (src/project/types.ts) gains: rnScripts: RnScripts   (expo: always "installed")
  // ProjectProbe (src/commands/doctor.ts) gains: rnScripts: RnScripts
  ```
- Gate in `readBareProject` (expo-modules-core checked with `isInstalled` before the gate): version not in the list → `React Native ${v} is not supported; rn-xtool supports ${supportedRnList()} (bare). Pin react-native to one of them.`, plus ` Expo SDK 58 needs React Native 0.88.0.` when expo-modules-core is installed. A listed `vendored` version with expo-modules-core installed → `React Native ${v} with Expo modules is not supported. Expo SDK 58 needs React Native 0.88.0.` (also without `use_expo_modules!` in the Podfile, where 0.88.0 only warns; Task 9 documents it in `docs/bare-react-native.md`) The "react-native is not installed" message keeps suggesting `react-native@0.88.0`.
- doctor `project` for vendored: `bare React Native 0.86.3 (vendored SwiftPM scripts), target HelloWorld (HelloWorld.xcodeproj)`; installed-scripts texts unchanged.

- [ ] **Step 1: Write failing tests**:
  - bare.test `accepts each supported version` → 0.86.2, 0.86.3, 0.87.1 → `rnScripts "vendored"`; 0.88.0 → `"installed"`.
  - bare.test `rejects unsupported versions with the supported list` → for `0.86.0, 0.86.1, 0.87.0, 0.85.0, 0.89.0, 0.88.1, 0.88.0-rc.1` the exact message above (replaces `rejects react-native below 0.88` and `accepts a 0.88 prerelease`).
  - bare.test `adds the Expo SDK sentence for an unsupported version with Expo modules` → 0.87.0 + expo-modules-core + expo → message ends with `Expo SDK 58 needs React Native 0.88.0.`
  - bare.test `rejects Expo modules on a vendored version` → 0.86.3 + expo-modules-core + expo + `use_expo_modules!` → exact message above.
  - bare.test `reads the 0.86.3 template` / `reads the 0.87.1 template` → fixture `bare-086`/`bare-087` + RN version; `bare.swiftSources.map(f => f.relPath)` equals `["HelloWorld/AppDelegate.swift"]`, `bundleIdentifier "org.reactjs.native.example.HelloWorld"`, `rnScripts "vendored"`.
  - pbxproj.test `the 0.86 and 0.87 templates target iOS 15.1` → `buildSetting(openPbxproj(<fixture>/ios), "IPHONEOS_DEPLOYMENT_TARGET") === "15.1"` for both.
  - expo.test `an Expo project uses the installed scripts` → `rnScripts "installed"`.
  - doctor.test `describes a vendored bare project` → detail above; existing `bareProbe`/`expoProbe` get `rnScripts: "installed"` and keep their texts.
- [ ] **Step 2: Run** `npx vitest run tests/project tests/doctor.test.ts` → FAIL.
- [ ] **Step 3: Implement** the list, the gate, `rnScripts` in both readers and the probe, the doctor text; fetch the two fixtures with `npm pack` into a scratch dir.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: gate bare projects on exact React Native versions"`

### Task 3: The react-native patch only for the version it was made for

**Files:**
- Modify: `src/pipeline/patches.ts`, `src/commands/build.ts` (`BuildDeps.applyPatches`, the `patches` step)
- Test: `tests/patches.test.ts`, `tests/build.test.ts`

**Interfaces:**
- Consumes: `RnScripts`, `ProjectInfo.rnScripts` (Task 2).
- Produces:
  ```ts
  export function selectBundledPatches(projectRoot: string, bundledDir: string): string[];
  //   unchanged for every package except "react-native": its patch only when installed version === filename version
  export function rnPatchMismatch(projectRoot: string, bundledDir: string): Omit<PatchFailureDetails, "output"> | undefined;
  export async function applyPatches(projectRoot: string, exec?: PatchExec, opts?: { rnScripts: RnScripts } /* default "installed" */): Promise<void>;
  //   rnScripts "installed" + rnPatchMismatch → throw patchFailureMessage({ ...m, output: `patch-package was not run: react-native ${installed} is installed and the bundled patch is for ${patched}.` }) before any exec
  // BuildDeps.applyPatches: (root: string, rnScripts: RnScripts) => Promise<void>; build passes project.rnScripts;
  //   realDeps wraps it: (root, rnScripts) => applyPatches(root, undefined, { rnScripts }) (the exported signature stays)
  ```

- [ ] **Step 1: Write failing tests** in `tests/patches.test.ts` (existing tests that install react-native without a version now pass `"0.88.0"`):
  - `stages the react-native patch only for the version it was made for` → RN 0.86.3 → `[]`; RN 0.88.0 → `["react-native+0.88.0.patch"]`.
  - `keeps staging the expo patches whatever their installed version` → expo 58.0.20 → `["expo+58.0.19.patch"]`.
  - `stages exactly the four bundled patches for Expo 58 on React Native 0.88.0` → expo 58.0.19, expo-modules-autolinking 58.0.15, expo-modules-jsi 58.0.19, react-native 0.88.0 → all four names, sorted.
  - `runs no bundled patch for a vendored project` → RN 0.86.3 with the bundled patch dir: `applyPatches(root, exec, { rnScripts: "installed" })` rejects `/pin "react-native" to 0\.88\.0/`, while `{ rnScripts: "vendored" }` resolves and exec is never called.
  - `stops an installed-scripts project whose react-native differs from the patch` (Review Focus 1) → RN 0.88.1, `rnScripts "installed"` → rejects `/pin "react-native" to 0\.88\.0/`, exec never called.
  - build.test `passes the scripts source to the patches step` → `applyPatches` mock receives `(root, "vendored")` for a vendored project.
- [ ] **Step 2: Run** `npx vitest run tests/patches.test.ts tests/build.test.ts` → FAIL.
- [ ] **Step 3: Implement** the exact rule for `react-native`, `rnPatchMismatch`, the `applyPatches` option and the build wiring.
- [ ] **Step 4: Run** the same tests, `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: stage the react-native patch for its version only"`; PR note: an Expo project on React Native ≠ 0.88.0 stops with the pin message produced by `rnPatchMismatch`, not by patch-package output.

### Task 4: Driver `--scripts-root` and `RN_SPM_RN_ROOT`

**Files:**
- Modify: `scripts/rn-spm-generate.js`, `src/pipeline/rnSpm.ts`, `src/commands/build.ts` (`BuildDeps.runRnSpm` opts, the `rn-spm` call)
- Test: `tests/rn-spm-generate.test.ts`, `tests/rnSpm.test.ts`, `tests/build.test.ts`

**Interfaces:**
- Consumes: `vendor/rn-spm/` (Task 1), `RnScripts` (Task 2).
- Produces:
  - `node scripts/rn-spm-generate.js --rn-dir <abs> --app-root <abs> --scripts-root <abs> [--artifacts <root>] [--config-command <json>] [--scaffold]` (new `USAGE` text exactly this line prefixed by `Usage: `; `--scripts-root` required and absolute, else exit 1 with the usage). Every RN module is `require(path.join(scriptsRoot, rel))`; `process.env.RN_SPM_RN_ROOT = rnDir` is set before the first require. `--rn-dir` keeps feeding `determineVersion`, `--react-native-root` and the scaffold `reactNativeRoot`.
  - ```ts
    export function resolveRnDir(paths: ProjectPaths): string;           // now exported (Task 7 uses it)
    export function vendoredScriptsRoot(): string;                       // path.join(packageRoot(), "vendor", "rn-spm")
    export function rnSpmGenerateArgs(paths: ProjectPaths, opts: { rnArtifactsDir?: string; rnScripts: RnScripts }, rnDir?: string): string[];
    //   --scripts-root: vendored → vendoredScriptsRoot(); installed → path.join(rnDir, "scripts"); placed after --app-root
    export function rnSpmScaffoldArgs(paths: ProjectPaths, opts: { rnArtifactsDir?: string; rnScripts: RnScripts }, rnDir?: string): string[];
    export async function runRnSpm(paths: ProjectPaths, opts: { rnArtifactsDir?: string; kind: ProjectKind; rnScripts: RnScripts }, deps?: Partial<RnSpmDeps>): Promise<void>;
    //   kind "expo" with rnScripts "vendored" → throw `runRnSpm: Expo projects use React Native's installed SwiftPM scripts, got rnScripts "vendored"`
    // BuildDeps.runRnSpm opts gain rnScripts; build passes project.rnScripts
    ```

- [ ] **Step 1: Write failing tests**:
  - rn-spm-generate.test: extend the usage test with `["--rn-dir","/rn","--app-root","/app"]` (no `--scripts-root`) and a relative `--scripts-root` → exit 1 with the new `USAGE`; existing calls pass `--scripts-root <rnDir>/scripts`.
  - rnSpm.test: update the existing expectations: calls pass `rnScripts: "installed"` and the `rnSpmGenerateArgs` expectation gains `--scripts-root <rnDir>/scripts` after `--app-root`.
  - rn-spm-generate.test `loads RN's modules from --scripts-root` → the fake modules live in `<tmp>/vendored/` and `<rnDir>` has no `scripts/`; the recorded calls are the same sequence as the installed case and `determineVersion` receives `rnRoot === rnDir`.
  - rn-spm-generate.test `exports RN_SPM_RN_ROOT to the scripts` → the fake `determineVersion` records `process.env.RN_SPM_RN_ROOT`, equal to `rnDir`.
  - rnSpm.test `rnSpmGenerateArgs points at the installed scripts for 0.88.0 and the vendored copy otherwise` → `--scripts-root` values `path.join(rnDir, "scripts")` and `path.join(packageRoot(), "vendor", "rn-spm")`.
  - rnSpm.test `the scaffold run keeps --scripts-root and --artifacts` (Review Focus 5) → `runRnSpm(paths, { kind: "bare", rnScripts: "vendored", rnArtifactsDir: "/art" })` with a first run reporting a missing manifest: the generate, scaffold and retry argv all contain `--scripts-root <vendored>` and `--artifacts /art`.
  - rnSpm.test `refuses vendored scripts for an Expo project` → rejects with the message above, no runner call.
  - build.test `passes the scripts source to runRnSpm` → opts include `rnScripts`.
- [ ] **Step 2: Run** `npx vitest run tests/rn-spm-generate.test.ts tests/rnSpm.test.ts tests/build.test.ts` → FAIL.
- [ ] **Step 3: Implement** the flag, the env, the argv builders and the wiring.
- [ ] **Step 4: Run** the same tests, `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: run vendored SwiftPM scripts for older React Native"`

### Task 5: Adapter pieces — VFS tree, headers module map, empty archives, Info.plist

**Files:**
- Create: `src/pipeline/rnHeadersModules.ts` (the module table), `src/pipeline/rnArtifacts.ts` (pure pieces), `tests/support/fakeSlots.ts`
- Test: `tests/rnArtifacts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/pipeline/rnHeadersModules.ts — transcribed once from 0.88.0's ReactNativeHeaders.xcframework/ios-arm64/Headers/module.modulemap
  // (14 modules, CoreModules … yoga, in file order; ReactNativeHeaders_react lists react/… headers). Comment states the provenance.
  export const RN_HEADERS_MODULES: readonly { readonly name: string; readonly headers: readonly string[] }[];
  // src/pipeline/rnArtifacts.ts
  export interface VfsEntry { virtual: string /* "React/RCTBridge.h" */; external: string /* "${ROOT_PATH}/Headers/React_Core/React/RCTBridge.h" */ }
  export function parseVfsTemplate(text: string): VfsEntry[];
  export type LinkFn = (from: string, to: string) => Promise<void>;
  export async function materialiseVirtualTree(frameworkDir: string /* the React.xcframework directory: ${ROOT_PATH} of the template */, entries: VfsEntry[], outDir: string, link: LinkFn): Promise<{ missing: string[] }>;
  //   each entry: external (${ROOT_PATH} = frameworkDir) linked at outDir/virtual; then VFS fallthrough as in the spike:
  //   files under a physical top-level Headers/<dir> whose name (exact case) is also a virtual top-level name, not yet present, linked at outDir/<dir>/…
  export function renderHeadersModuleMap(headersDir: string): string;
  //   RN_HEADERS_MODULES filtered to headers that exist under headersDir; modules left empty omitted;
  //   format of 0.88's file: "module <name> {\n" + `  header "<path>"\n`… + "  export *\n}\n", modules joined by "\n"
  export const EMPTY_AR_ARCHIVE: Buffer;                                   // Buffer.from("!<arch>\n")
  export interface XcframeworkLibrary { LibraryIdentifier: string; SupportedPlatform: string; SupportedPlatformVariant?: string; SupportedArchitectures: string[] }
  export function readXcframeworkLibraries(xcframeworkDir: string): XcframeworkLibrary[];   // Info.plist via `plist`
  export function headersXcframeworkInfoPlist(name: string, libs: XcframeworkLibrary[]): string;
  //   per lib: BinaryPath = LibraryPath = `lib${name}-${LibraryIdentifier}.a`, HeadersPath "Headers", platform fields copied;
  //   CFBundlePackageType "XFWK", XCFrameworkFormatVersion "1.0"
  // tests/support/fakeSlots.ts
  export function makeFakeSlot086(dir: string): void;   // see Step 1
  export function makeFakeSlot088(dir: string): void;   // headers-spec: the 5 xcframeworks, hermes-headers/hermes, complete artifacts.json
  ```

- [ ] **Step 1: Write `tests/support/fakeSlots.ts`**: `makeFakeSlot086` mirrors the real layout (the physical headers and the umbrella also sit in a top-level `React.xcframework/Headers/`, which is what `${ROOT_PATH}/Headers` resolves to) and writes `React.xcframework/Info.plist` (slices `ios-arm64` platform ios arm64; `ios-arm64_x86_64-simulator` variant simulator), `React.xcframework/React-VFS-template.yaml` in RN's format with four mappings (`React/RCTBridge.h` ← `Headers/React_Core/React/RCTBridge.h`; `React_RCTAppDelegate/RCTReactNativeFactory.h` ← `Headers/React_RCTAppDelegate/React_RCTAppDelegate/RCTReactNativeFactory.h`; `yoga/Yoga.h` ← `Headers/Yoga/yoga/Yoga.h`; `ReactCommon/RCTPerformanceLoggerUtils.h` ← `Headers/React_NativeModulesApple/ReactCommon/RCTPerformanceLoggerUtils.h`), per slice `React.framework/{React ("bin-<slice>"), Info.plist, Headers/<those physical files>, Headers/React_Core/React_Core-umbrella.h ("#import \"RCTBridge.h\"\n"), Headers/ReactCommon/RCTTurboModuleWithJSIBindings.h}`, `ReactNativeDependencies.xcframework/{Info.plist (same two slices), Headers/folly/dynamic.h, <slice>/ReactNativeDependencies.framework/ReactNativeDependencies}`, `hermes-engine.xcframework/Info.plist`, `hermes-headers/hermes/hermes.h`, `artifacts.json` with `React`, `ReactNativeDependencies`, `hermes-engine` (absolute paths, fake urls).
- [ ] **Step 2: Write failing tests** in `tests/rnArtifacts.test.ts`:
  - `parses the VFS template into virtual and external paths` → the four pairs, in file order.
  - `materialises the virtual tree with VFS fallthrough` → `outDir` holds the four virtual files plus `ReactCommon/RCTTurboModuleWithJSIBindings.h`; nothing under `React_Core/`; `missing` is `[]`; an entry pointing at a deleted file is reported in `missing`.
  - `renders the headers module map in 0.88's form from the files present` → on the materialised tree (minus `React/`), exactly `"module ReactCommon {\n  header \"ReactCommon/RCTPerformanceLoggerUtils.h\"\n  header \"ReactCommon/RCTTurboModuleWithJSIBindings.h\"\n  export *\n}\n\nmodule React_RCTAppDelegate {\n  header \"React_RCTAppDelegate/RCTReactNativeFactory.h\"\n  export *\n}\n\nmodule yoga {\n  header \"yoga/Yoga.h\"\n  export *\n}\n"`.
  - `the empty archive is a valid ar archive` → `EMPTY_AR_ARCHIVE.toString() === "!<arch>\n"`; written to a temp file, `ar t` exits 0 with empty stdout (`it.skipIf` no `ar`).
  - `headers Info.plist names one library per slice` → `plist.parse(headersXcframeworkInfoPlist("ReactNativeHeaders", readXcframeworkLibraries(<fake React.xcframework>)))`: `AvailableLibraries` identifiers `["ios-arm64","ios-arm64_x86_64-simulator"]`, `LibraryPath` `libReactNativeHeaders-ios-arm64.a`, `HeadersPath "Headers"`, simulator entry keeps `SupportedPlatformVariant "simulator"`, `CFBundlePackageType "XFWK"`.
  - `the module table renders 0.88.0's own map` → `describe.skipIf` the 0.88.0 slot is absent (`RN_XTOOL_RN088_SLOT`, default `~/Library/Caches/ReactNative/spm-artifacts/0.88.0/debug`): `renderHeadersModuleMap(<slot>/ReactNativeHeaders.xcframework/ios-arm64/Headers)` equals that directory's `module.modulemap` byte for byte.
- [ ] **Step 3: Run** `npx vitest run tests/rnArtifacts.test.ts` → FAIL (module not found).
- [ ] **Step 4: Implement** `rnHeadersModules.ts` (transcribe the 0.88.0 map from the slot on this machine) and the pure functions.
- [ ] **Step 5: Run** the test file (the gated test must run, not skip, here) → PASS; `npm test && npm run lint`.
- [ ] **Step 6: Commit** `git add src/pipeline/rnHeadersModules.ts src/pipeline/rnArtifacts.ts tests/support tests/rnArtifacts.test.ts && git commit -m "feat: render headers-spec pieces for older RN artifacts"`

### Task 6: `adaptSlot` — assembling, stamping and guarding the adapted slot

**Files:**
- Modify: `src/pipeline/rnArtifacts.ts`
- Test: `tests/rnArtifacts.test.ts`

**Interfaces:**
- Consumes: Task 5's functions and `fakeSlots.ts`; `validateArtifactsCache` from `vendor/rn-spm/spm/download-spm-artifacts.js` (tests only).
- Produces:
  ```ts
  export const ADAPTER_VERSION = 1;
  export const ADAPTED_STAMP = ".rn-xtool-adapted.json";   // { adapterVersion, source, artifactsJsonSha256 }
  export class ArtifactLayoutError extends Error { constructor(version: string, slot: string, missing: string) }
  //   message: `React Native ${version} artifacts in ${slot} have a layout rn-xtool does not recognise: ${missing} is missing. Report it at https://github.com/WillyAntunez/react-native-xtool/issues with this message.`
  export function isHeadersSpecSlot(slot: string): boolean;                  // ReactNativeHeaders.xcframework exists
  export async function adaptedSlotIsCurrent(src: string, dest: string): Promise<boolean>;
  export async function adaptSlot(src: string, dest: string, version: string, opts?: { hardLink?: LinkFn /* default fs.link */ }): Promise<void>;
  ```
- `adaptSlot`, in a sibling temp dir `${dest}.tmp-${process.pid}` renamed over `dest` at the end (an existing `dest` is first renamed to `${dest}.old-${process.pid}` and removed after the rename; the sibling dir is removed on any error): checks `React.xcframework/{Info.plist,React-VFS-template.yaml}`, per slice `React.framework/Headers/React_Core/React_Core-umbrella.h`, `ReactNativeDependencies.xcframework/{Info.plist,Headers}`, `hermes-engine.xcframework`, `hermes-headers/hermes`, `artifacts.json`, and every VFS external → first absent one (path relative to `src`) throws `ArtifactLayoutError`. Then, per the spec: `React.xcframework` (per slice: everything of `React.framework` but `Headers/`, `Modules/`, `_CodeSignature/` linked; `Headers/` = virtual `React/`; `Headers/React-umbrella.h` = the 0.86 `React_Core-umbrella.h`; `Modules/module.modulemap` = `framework module React {\n  umbrella header "React-umbrella.h"\n  export *\n  module * { export * }\n}\n`; xcframework `Info.plist` linked); `ReactNativeHeaders.xcframework` (per React slice: virtual tree minus `React/` plus `hermes/` from `hermes-headers/hermes`, `module.modulemap` from `renderHeadersModuleMap`, `EMPTY_AR_ARCHIVE` as `libReactNativeHeaders-<id>.a`; `Info.plist` from `headersXcframeworkInfoPlist`); `ReactNativeDependenciesHeaders.xcframework` (per deps slice: `ReactNativeDependencies.xcframework/Headers` linked, empty archive, Info.plist; no module map); `ReactNativeDependencies.xcframework` and `hermes-engine.xcframework` as symlinks to the source; `hermes-headers/` linked; `artifacts.json` with the five `REQUIRED_ARTIFACTS` names, `xcframeworkPath` in `dest`, `url` from the source entry of the parent (React → ReactNativeHeaders, ReactNativeDependencies → its headers); the stamp written last.
- Linking: `hardLink`, and on `EXDEV`, `EPERM` or `EMLINK` a `copyFile`; any other error propagates.

- [ ] **Step 1: Write failing tests** on `makeFakeSlot086` copies:
  - `builds React.xcframework with flat React headers, the 0.86 umbrella and the React module map` → `ios-arm64/React.framework/Headers/RCTBridge.h` exists; `React-umbrella.h` equals the source umbrella; the module map equals the pinned string; `React` binary has the source's inode; no `Headers/React_Core`.
  - `builds ReactNativeHeaders.xcframework from the rest of the virtual tree plus hermes` → per slice `Headers/{React_RCTAppDelegate/RCTReactNativeFactory.h, yoga/Yoga.h, ReactCommon/RCTTurboModuleWithJSIBindings.h, hermes/hermes.h, module.modulemap}` exist, no `Headers/React`; `libReactNativeHeaders-ios-arm64.a` is `EMPTY_AR_ARCHIVE`.
  - `wraps the dependency headers` → `ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers/folly/dynamic.h` exists, no `module.modulemap`.
  - `RN's validateArtifactsCache accepts the adapted slot` → returns `null`; the dependencies and hermes xcframeworks are symlinks to the source.
  - `stops on an unknown layout naming the file and the version` → without `React-VFS-template.yaml`: rejects `ArtifactLayoutError` with `/0\.86\.3.*React\.xcframework\/React-VFS-template\.yaml is missing/`; same for the umbrella and for a VFS external deleted; `dest` absent afterwards.
  - `detects headers-spec slots` → `isHeadersSpecSlot` is false for `makeFakeSlot086` and true for `makeFakeSlot088`.
  - `stamps the adapted slot and reuses it until artifacts.json changes` → `adaptedSlotIsCurrent` false before, true after; false after editing the source `artifacts.json`; false with a stamp whose `adapterVersion` is 0.
  - `a failed adaptation leaves no stamped tree` (Review Focus 3) → `hardLink` throwing `ENOSPC` on its 3rd call: rejects; neither `dest` nor any `${dest}.tmp-*` exists; a later successful run makes `adaptedSlotIsCurrent` true.
  - `re-adapts over a stale adapted tree` → adapt, change the source `artifacts.json`, adapt again: resolves, `adaptedSlotIsCurrent` true, no `${dest}.old-*` left.
  - `falls back to copying when hard links fail` (Review Focus 4) → `hardLink` always throwing `EXDEV`: resolves; the `React` binary has the source's bytes and a different inode.
  - `adapts the real 0.86.3 slot to 0.88's module set` → `describe.skipIf` unless the 0.86.3 slot (`RN_XTOOL_RN086_SLOT`, default `~/Library/Caches/ReactNative/spm-artifacts/0.86.3/debug`) has `artifacts.json` and the 0.88.0 slot exists: adapted into a temp dir; module names of the generated `ios-arm64` map equal 0.88.0's 14; the generated map's text equals 0.88.0's `module.modulemap` with exactly four header lines removed, the four named in the test (taken from the spike's proven map); the deps headers have the same file list and bytes as 0.88.0's `ReactNativeDependenciesHeaders.xcframework/ios-arm64/Headers`.
- [ ] **Step 2: Run** `npx vitest run tests/rnArtifacts.test.ts` → FAIL.
- [ ] **Step 3: Implement** `adaptSlot`, `adaptedSlotIsCurrent`, `isHeadersSpecSlot`, `ArtifactLayoutError`.
- [ ] **Step 4: Run** the test file → PASS (the real-slot test may skip until Task 7 step 5); `npm test && npm run lint`.
- [ ] **Step 5: Commit** `git commit -am "feat: adapt pre-headers-spec React Native artifacts"`

### Task 7: The `rn-artifacts` build step

**Files:**
- Create: `src/pipeline/rnArtifactsStep.ts`
- Modify: `src/paths.ts` (`rnArtifacts: join(iosBuild, "rn-artifacts")`), `src/commands/build.ts`, `src/state.ts` (`rnVersion?: string`)
- Test: `tests/rnArtifactsStep.test.ts`, `tests/build.test.ts`

**Interfaces:**
- Consumes: `adaptSlot`, `adaptedSlotIsCurrent`, `isHeadersSpecSlot`, `ArtifactLayoutError` (Task 6); `resolveRnDir`, `vendoredScriptsRoot`, `RnRunner`, `streamingRunner` (Task 4 / existing).
- Produces:
  ```ts
  export type Flavor = "debug" | "release";
  export function rnArtifactsCacheRoot(): string;   // join(homedir(), "Library", "Caches", "ReactNative", "spm-artifacts")
  export function rawSlotComplete(slot: string): boolean;
  //   artifacts.json parses; React, ReactNativeDependencies, hermes-engine entries (plus ReactNativeHeaders and ReactNativeDependenciesHeaders when ReactNativeHeaders.xcframework exists: RN's five REQUIRED_ARTIFACTS) whose xcframeworkPath exists; hermes-headers/hermes exists
  export function downloadArtifactsArgv(version: string, flavor: Flavor, slot: string): string[];
  //   [<vendored>/spm/download-spm-artifacts.js, "--version", v, "--flavor", f, "--output", slot, "--allow-pre-headers-spec"]
  export interface RnArtifactsDeps { runner: RnRunner; log: (s: string) => void; cacheRoot: string; rnDir: string; adapt: typeof adaptSlot }
  export async function prepareRnArtifacts(paths: ProjectPaths, rnVersion: string, deps?: Partial<RnArtifactsDeps>): Promise<string>;
  //   per flavor (debug, release): slot = <cacheRoot>/<v>/<flavor>; if !rawSlotComplete → runner("node", argv, { cwd: paths.ios, env: { RN_SPM_RN_ROOT: rnDir } }),
  //   non-zero → throw `Downloading React Native ${v} ${flavor} artifacts failed (exit ${code}):\n${last 40 lines}`;
  //   headers-spec → used as is; else adapt into <paths.rnArtifacts>/<v>/<flavor> unless current.
  //   Returns <cacheRoot>/<v> when both are headers-spec, <paths.rnArtifacts>/<v> when both were adapted; mixed → ArtifactLayoutError(v, <the slot without it>, "ReactNativeHeaders.xcframework")
  ```
- `build.ts`: `BUILD_STEP_NAMES` gains `"rn-artifacts"` between `"patches"` and `"rn-spm"`; `BuildPlanInput` gains `rnArtifacts: boolean` (= `project.rnScripts === "vendored" && !config.rnArtifactsDir`); `buildSteps` keeps `rn-artifacts` only when `state.rnArtifacts` (the Expo branch never); `BuildDeps.prepareRnArtifacts: (paths: ProjectPaths, rnVersion: string) => Promise<string>`; `runRnSpm` gets `rnArtifactsDir: <prepared root> ?? config.rnArtifactsDir`; `BuildState.rnVersion = project.rnVersion`. `--clean` already removes `ios/build`, which now holds the adapted slots.

- [ ] **Step 1: Write failing tests** in `tests/rnArtifactsStep.test.ts` (runner fake writes `makeFakeSlot086`/`088` into the `--output` dir; `cacheRoot` a temp dir):
  - `downloads each flavor with the vendored downloader and RN_SPM_RN_ROOT` → two runner calls, argv `downloadArtifactsArgv("0.86.3", f, <cacheRoot>/0.86.3/<f>)`, env `{ RN_SPM_RN_ROOT: rnDir }`, cwd `paths.ios`.
  - `adapts pre-headers-spec slots and returns the adapted root` → returns `join(paths.rnArtifacts, "0.86.3")`; `adapt` called for debug and release.
  - `passes headers-spec slots through` → 088 slots for `0.87.1`: returns `join(cacheRoot, "0.87.1")`, `adapt` never called.
  - `skips the download when the raw slot is complete` → no runner call.
  - `re-runs the downloader when the raw slot is incomplete` (Review Focus 2) → slot with `React.xcframework` but no `artifacts.json`, and one whose `artifacts.json` names a deleted `hermes-engine.xcframework`: runner called for that flavor.
  - `re-runs the downloader when a headers-spec slot lacks companion entries` → fake 088 slot whose `artifacts.json` drops `ReactNativeHeaders`: runner called for that flavor.
  - `reuses a current adapted slot` → second call: `adapt` not called.
  - `fails with the downloader's output` → runner exit 1 with output `boom` → rejects `/Downloading React Native 0\.86\.3 debug artifacts failed \(exit 1\):\nboom/`.
  - `stops when the flavors disagree on the layout` → debug 086, release 088 → `ArtifactLayoutError`.
  - `the adapted artifacts live under ios/build` → `projectPaths("/p").rnArtifacts === "/p/ios/build/rn-artifacts"`.
  - build.test `bare vendored: rn-artifacts between patches and rn-spm` → `["patches","rn-artifacts","rn-spm","frameworks","generate","xtool-build"]`; existing expo and bare lists unchanged with `rnArtifacts: false` added to `expoFlags`/`bareFlags`.
  - build.test `passes the prepared artifacts root to runRnSpm` → `prepareRnArtifacts` mock returns `/adapted/0.86.3`; `runRnSpm` opts `{ rnArtifactsDir: "/adapted/0.86.3", kind: "bare", rnScripts: "vendored" }`.
  - build.test `rnArtifactsDir bypasses rn-artifacts` → config `rnArtifactsDir: "/mine"`: prepare never called, `runRnSpm` gets `/mine`, no `▸ rn-artifacts` log.
  - build.test `records the React Native version in the state` → `rnVersion "0.86.3"`.
- [ ] **Step 2: Run** `npx vitest run tests/rnArtifactsStep.test.ts tests/build.test.ts` → FAIL.
- [ ] **Step 3: Implement** the step module, the path, the build wiring and the state field.
- [ ] **Step 4: Run** the same tests, `npm test && npm run lint` → PASS.
- [ ] **Step 5: Functional check (controller, heavy: confirm with Willy first; re-extracts the cached 0.86.3 tarballs, no download expected)**: `RN_SPM_RN_ROOT=../spike-bare-086/node_modules/react-native node vendor/rn-spm/spm/download-spm-artifacts.js --version 0.86.3 --flavor debug --output ~/Library/Caches/ReactNative/spm-artifacts/0.86.3/debug --allow-pre-headers-spec` → exit 0, `artifacts.json` with three entries; then `npx vitest run tests/rnArtifacts.test.ts` → the real-slot test runs and passes.
- [ ] **Step 6: Commit** `git add src tests && git commit -m "feat: add the rn-artifacts build step"`

### Task 8: Harness `--rn`

**Files:**
- Modify: `e2e/clean-machine/e2e.sh` (`cmd_project`, the usage comment: `e2e.sh project --bare [<name>] [--rn <version>]`, default 0.88.0)
- Test: `tests/e2e-harness.test.ts`

**Interfaces:**
- `cmd_project` takes `--bare`, `--rn <version>` and an optional name in any order; `--rn` without `--bare` → stderr `--rn needs --bare`, exit 1; `--rn` without a value → stderr `--rn needs a version`, exit 1; init command `… init '<name>' --version <version> --install-pods false --skip-git-init`.

- [ ] **Step 1: Write failing tests**: run `bash e2e/clean-machine/e2e.sh project …` with a temp `HOME` (holding `.cache/`) and a fake `docker` first on `PATH` that appends its argv to `$DOCKER_LOG`:
  - `project --bare defaults to React Native 0.88.0` → log contains `init 'demo' --version 0.88.0`.
  - `project --bare --rn 0.86.3 initialises that version` → for `--bare app --rn 0.86.3` and `--bare --rn 0.86.3 app`: `init 'app' --version 0.86.3`.
  - `project --rn without --bare is refused` and `--rn needs a version` → exit 1 with the messages above, no docker call.
- [ ] **Step 2: Run** `npx vitest run tests/e2e-harness.test.ts` → FAIL.
- [ ] **Step 3: Implement** the flag parsing.
- [ ] **Step 4: Run** the test, `bash -n e2e/clean-machine/e2e.sh`, `npm test`, `npm run scan:private` → PASS.
- [ ] **Step 5: Commit** `git add e2e tests/e2e-harness.test.ts && git commit -m "chore: pick the React Native version in the e2e harness"`

### Task 9: Docs and changelog

**Files:**
- Modify: `README.md` ("Which projects work": `Bare React Native 0.86.2, 0.86.3, 0.87.1 and 0.88.0`, with a "device-verified: …; build-verified: 0.86.2" note filled from Tasks 10–12; the "not yet" row becomes `Expo SDK 57 and older, React Native 0.85 and older, 0.86.0, 0.87.0`), `docs/bare-react-native.md` (new sections "Supported React Native versions", "Vendored SwiftPM scripts (0.86, 0.87)", "Older artifacts (0.86)": the template differences — AppDelegate only, `import React_RCTAppDelegate`, target 15.1 —, the adapter, cache locations, about 1.3 GB per flavor for a 0.86 slot plus mostly hard-linked adapted copies under `ios/build/rn-artifacts/`, `rnArtifactsDir` bypass; "Build steps" gains `rn-artifacts`), `docs/how-it-works.md` ("The build, step by step" gains `rn-artifacts`; a "Vendored SwiftPM scripts" section: why, what E1–E4 do, `RN_SPM_RN_ROOT`), `docs/libraries.md` (Bare column split per version; cells filled by Tasks 11–12), `docs/upstream/react-native-scaffolder.md` (the fixes live in the 0.88 patch and in `vendor/rn-spm`; refresh procedure: new RN 0.88.x → refresh the patch, regenerate `vendor/rn-spm` from the tarball + patch + `rn-xtool-edits.patch`, update the pinned tarball and integrity in `tests/vendor-rn-spm.test.ts`), `CHANGELOG.md` (`Unreleased` → Added: bare RN 0.86.2/0.86.3/0.87.1; Changed: unsupported versions now get one error naming the list, 0.88 prereleases and 0.88.x other than 0.88.0 are refused).
- Test: `npm run lint`, `npm run scan:private`.

- [ ] **Step 1: Write** the docs (statements about device results only once Tasks 10–12 confirm them; until then the README note says which checks are pending).
- [ ] **Step 2: Run** `npm test && npm run lint && npm run scan:private` → clean.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && git commit -m "docs: document React Native 0.86 and 0.87 support"`

### Task 10: `app-bare-086` reference app on the iPhone (controller with Willy)

**Files:**
- Create: `../app-bare-086` (own git repo, sibling of `app/`): `npx --yes @react-native-community/cli@latest init BareDemo086 --version 0.86.3 --install-pods false --directory app-bare-086`, `rn-xtool.config.json` `{ "metroPort": 8082 }`, `App.tsx` title "Bare RN 0.86 on Linux". Commit `chore: bare React Native 0.86 reference app`.
- Uses the worktree CLI: `npm run build` in the worktree, then `node ../expo-xtool-rn086/bin/rn-xtool.js <cmd>` from `app-bare-086/`.

- [ ] **Step 1:** `doctor` → `project` reads `bare React Native 0.86.3 (vendored SwiftPM scripts), target BareDemo086 (BareDemo086.xcodeproj)`.
- [ ] **Step 2:** `build` → steps `patches, rn-artifacts, rn-spm, frameworks, generate, xtool-build`, exit 0, `ios-xtool/xtool/App.app` exists, `git diff --quiet -- ios`, and the `md5sum` of every file under `node_modules/react-native/scripts` is the same before and after (no RN patch applied). If the link step rejects the empty `ar` archives, stop: that is a decision for Willy (the spec pins them).
- [ ] **Step 3:** second `build` → `rn-artifacts` reuses both adapted slots (no download, no adaptation in the log).
- [ ] **Step 4:** `install --network 192.168.1.10` → installed; `start` → Metro on 8082; Willy opens the app, sees the title, edits `App.tsx` → Fast Refresh. Record timings in the ledger.
- [ ] **Step 5:** Fixes go through the owning task's files with a red/green test, one `fix:` commit each.
- [ ] **Step 6:** With Willy's go-ahead, delete `../spike-bare-086` (the raw slots in `~/Library/Caches/ReactNative` stay).
- [ ] **Step 7 (build-only, ask Willy first: about 2.6 GB more of slots):** scratch app with `--version 0.86.2` under the scratchpad, `build` → exit 0; delete the scratch app; note "0.86.2 build-verified" for Task 9's docs.

### Task 11: Library matrix on 0.86.3 (controller with Willy)

**Files:**
- `app-bare-086` branch `feature/lib-matrix`: react-native-screens, react-native-gesture-handler, react-native-svg, react-native-webview, react-native-reanimated + react-native-worklets (the newest versions whose peer ranges accept react-native 0.86.3), `App.tsx` exercising each (same demos as `../app-bare` branch `feature/lib-matrix`); scaffolded manifests persisted to `app-bare-086/patches/` and committed.
- Modify: `docs/libraries.md` (Bare 0.86.3 column), README note.

- [ ] **Step 1:** per library: `npm i <lib>`, `run --network`, Willy confirms the demo on the iPhone; note build time.
- [ ] **Step 2:** A failure is fixed, not documented as broken: a scaffolder fix goes into `patches/react-native+0.88.0.patch` and `vendor/rn-spm` is regenerated (Task 1's provenance test stays green); a vendored-only root/template fix becomes another E-edit in `rn-xtool-edits.patch`; a module-map fix goes into the adapter (Task 5/6 tests first). A fix needing 0.86-specific logic branches, or none found, goes to Willy as a decision.
- [ ] **Step 3: Commit** `docs: React Native 0.86.3 results in the library matrix`.

### Task 12: `app-bare-087` on 0.87.1 (controller with Willy)

**Files:**
- Create: `../app-bare-087` like Task 10 with `--version 0.87.1`, `BareDemo087`, title "Bare RN 0.87 on Linux"; branch `feature/lib-matrix` with screens, gesture-handler, svg, webview.
- Modify: `docs/libraries.md` (Bare 0.87.1 column), README note.

- [ ] **Step 1:** `doctor` → `bare React Native 0.87.1 (vendored SwiftPM scripts), …`; `build` → `rn-artifacts` logs headers-spec slots used as is, no adapted dir under `ios/build/rn-artifacts`; exit 0.
- [ ] **Step 2:** `install --network` + `start`; Willy confirms the title and Fast Refresh.
- [ ] **Step 3:** the four libraries as in Task 11, step 1. More vendored edits of the E1–E4 kind are fine; anything needing 0.87-specific branches goes to Willy.
- [ ] **Step 4: Commit** `docs: React Native 0.87.1 results in the library matrix`.

### Task 13: Clean-machine run on 0.86.3 (controller with Willy)

- [ ] **Step 1:** Confirm disk with Willy (Darwin SDK plus about 2.6 GB of 0.86.3 slots in the container). With `E2E_NAME=rn-xtool-e2e-086`: `up`, `install <npm pack tgz of the worktree>`, `setup`, `auth`, `project --bare demo --rn 0.86.3`, `sh "rn-xtool run --network 192.168.1.10"`; Willy confirms the app on the iPhone; `down`.
- [ ] **Step 2:** Record the result in the PR body; fixes go through the owning tasks.
