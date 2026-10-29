# Version Floors and the Daily Drift Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every supported line accepts newer patch releases: Expo SDK 57 moves to a floor, and bare React Native gets one floor per minor. A capability detector, shown by `rn-xtool doctor --project`, chooses the bare SwiftPM scripts mode. A daily GitHub Actions drift watch opens one `drift` issue per broken line, and a weekly report-only exploration covers older lines.

**Architecture:** One table in `src/versions.ts` (`SUPPORTED_LINES`) describes every Expo and bare line. The gates, patch selection, doctor and the drift watch all read it through a few readers. `src/project/scriptsShape.ts` reads the installed React Native SwiftPM scripts as text and names their shape. `src/project/capabilities.ts` adds artifact, Expo plugin, Expo module and podspec facts. `doctor --project` shows those facts without the toolchain or device checks. The drift watch logic lives in `src/drift/*.ts`, behind a thin `scripts/drift-watch.mjs` entry that `.github/workflows/drift-watch.yml` calls.

**Tech Stack:** TypeScript (Node 20, ESM), vitest, `patch-package` 8, GNU `patch`, the vendored RN 0.88.0 scripts (`vendor/rn-spm`, whose `download-spm-artifacts.js` exports the Maven URL helpers), GitHub Actions on `ubuntu-latest` with `gh` and `GITHUB_TOKEN`.

**Spec:** `docs/design/specs/2026-10-29-version-floors-design.md` (approved). Its failure-walk rulings are binding.

## Global Constraints

- Linux, Node 20+, Swift 6.4, xtool 1.23.0 and `IOS_MIN` 16.4 stay unchanged. No new npm dependency. The workflow uses only `gh`, which is preinstalled on hosted runners.
- **One table.** `SUPPORTED_LINES` in `src/versions.ts` replaces `SUPPORTED_EXPO` and `SUPPORTED_RN`. The spec's `RN_LINES` are its bare rows. Code reads the table only through the readers defined in Tasks 1–3. Rows, verbatim:
  - `expo-57`: plugin `vendored`, scripts `vendored`, artifacts `adapted`, pins `expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16, expo-modules-jsi 57.1.3`, templates `["blank-typescript"]`.
  - `expo-58`: plugin `installed`, scripts `installed`, artifacts `published`, pins `expo 58.0.21, react-native 0.88.1, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking 58.0.16, expo-file-system 58.0.13, expo-font 58.0.11`, templates `["blank-typescript", "default"]`.
  - `bare-0.86`: floor `0.86.2`, verified `["0.86.2", "0.86.3"]`, scripts `vendored`, artifacts `adapted`.
  - `bare-0.87`: floor `0.87.1`, verified `["0.87.1"]`, scripts `vendored`, artifacts `published`.
  - `bare-0.88`: floor `0.88.0`, verified `["0.88.0", "0.88.1"]`, scripts `installed`, artifacts `published`.
- **Expo pins are a floor on both SDKs (from Task 2).** A package below its pin, or a missing one, is G1. A newer one gets the newer-than-floor warning and the build continues. react-native is exact under the floor (0.86.3 on 57, 0.88.1 on 58). The `exact` policy and its texts are removed. SDK 59 and newer pin nothing.
- **Bare floors (from Task 3).** A version is silent when it is in its line's `verified` list. It is accepted with the RN newer-than-verified warning when it is a release at or above the floor that is not in that list. Below the floor, a prerelease (today's rule, kept), or a minor without a row is refused with today's text shape.
- **Patch selection (from Task 3).** For each package: the exact-version patch; else the highest bundled patch of the same release line (`0.y` for `0.x.z`, else the major); else, on the installed Expo plugin and only for packages other than react-native, today's fallback (the highest bundled version). A staged patch that does not apply stops with the existing named errors: `pin "<pkg>" to <version>`, the floor `"overrides"` text, or the stale-copy text.
- **Scripts mode (from Task 4).** For bare and hybrid projects, the mode comes from the shape of the installed scripts. It must equal today's table for every supported version: 0.86.x and 0.87.x `vendored`, 0.88.x `installed`. An unknown shape is reported as "not recognised" and falls back to the line's `scripts`. Expo projects keep `rnScripts` tied to `expoPlugin`, because the vendored plugin needs the vendored scripts (edit E5); doctor still prints their shape. Shape detection reads files as text and never `require`s the installed scripts.
- **Unchanged:** Expo 58 gates, texts and patches; build steps, driver and `setup-apple-spm.js` argv and env for every verified version; the verified versions themselves; hybrid apps on react-native 0.88.1 only.
- **Network:** only `doctor --project`'s artifact probe (HEAD requests, ≤ 10 s in total) and the drift watch reach the network. Plain `doctor` and `build` make no new network call.
- **Workflow:** `.github/workflows/drift-watch.yml` runs on `ubuntu-latest` with no Swift and no Darwin SDK, and never compiles. It is triggered by `schedule` (daily `23 5 * * *`, weekly `47 5 * * 1`) and by `workflow_dispatch` (inputs `mode`: `daily|explore`, `drill`: a line id or empty). Permissions are `contents: read` everywhere, plus `issues: write` on the report job only. It uses `GITHUB_TOKEN` and no other secret. Inputs and JSON reach scripts through `env:`, never interpolated into `run:` text.
- **Failure-walk owners.** Row 1 (accept): Task 10, RELEASING. Row 2 (handle): Tasks 7–8. Row 3 (handle): Task 7. Row 4 (handle): Tasks 7–8. Row 5 (accept): Task 10. Row 6 (handle): Task 8. Row 7 (accept): Task 8 issue body and Task 10 README. Row 8 (accept): Task 3 warning text. Row 9 (handle): Task 4. Row 10 (accept): Task 9.
- Error, warning and doctor texts in this plan are verbatim.
- Every task ends with `npm test && npm run lint` green. Tasks that touch fixtures, docs, scripts or the workflow also run `npm run scan:private`. No absolute `/home` paths, Team ID or UDID in committed files.
- Commits use Conventional Commits in English, subject ≤ 50 characters, no body, one logical change each, and no scratch code. Task 11 is run by the controller with Willy; implementers never need the device or GitHub.

## Review Focus

1. A prerelease of a supported minor (`0.88.2-rc.1`) is refused like today; it is not a "newer patch" (Task 3 test `refuses prereleases of a supported line`).
2. An SDK 57 project on a newer 57.x never stages another SDK's patch: expo 57.0.32 gets no `expo+58.0.21.patch`, and jsi 57.1.4 gets `expo-modules-jsi+57.1.3.patch` (Task 2 test `never stages another SDK's patch on SDK 57`).
3. A react-native installed through a symlink (workspaces, `npm link`) has the shape of the copy the build resolves. Detection never executes the installed scripts (Task 4 tests `reads the scripts of the react-native the build resolves` and `never runs the installed scripts`).
4. `doctor --project` offline or on a stalled network finishes in bounded time. The artifacts line says "not checked" and does not fail (Task 5 test `reports artifacts as not checked when the probe fails or times out`).
5. A drift run that could not create a project, or whose check job never wrote a result, never opens or closes an issue. An open issue for that line stays open (Task 8 tests `leaves issues alone when a line could not run` and `a target without a result could not run`).
6. Before the final verdict, the reviewer answers without hints: "Name three ways this fails in production that no test covers." Any answer not in the spec's failure table goes to Willy as a decision, not to the implementer as a fix.

---

### Task 1: One table of supported lines

A refactor with no change in behaviour.

**Files:**
- Modify: `src/versions.ts`, `src/project/expo.ts` (`SUPPORTED_EXPO[57].pins.expo` → `expoPinsFor(57)!.expo`), `src/project/bare.ts` (`SUPPORTED_EXPO[58].pins` → `expoPinsFor(58)!`)
- Test: `tests/versions.test.ts`

**Interfaces:**
- Produces (`src/versions.ts`):
  ```ts
  export type RnArtifacts = "adapted" | "published";   // adapted: pre-headers-spec slots rn-xtool rebuilds (0.86)
  export interface ExpoLine {
    kind: "expo"; sdk: number; plugin: ExpoPlugin; policy: ExpoPinPolicy; scripts: RnScripts; artifacts: RnArtifacts;
    pins: Readonly<Partial<Record<ExpoPinName, string>>>;   // gate order, as today
    templates: readonly string[];                            // create-expo-app templates the drift watch creates
  }
  export interface BareLine {
    kind: "bare"; minor: string; floor: string; verified: readonly string[]; scripts: RnScripts; artifacts: RnArtifacts;
  }
  export type SupportedLine = ExpoLine | BareLine;
  export const SUPPORTED_LINES: readonly SupportedLine[];   // Global Constraints rows, in that order; expo-57 policy "exact" until Task 2
  export function lineId(line: SupportedLine): string;      // "expo-57", "bare-0.88"
  export function expoLineFor(sdk: number): ExpoLine | undefined;    // 57 and 58 only
  export function bareLineFor(version: string): BareLine | undefined; // by "<major>.<minor>" of the version, prerelease included
  // Kept, now reading the table: expoPluginFor, expoPinsFor, expoPinPolicyFor, checkPins,
  // rnScriptsFor (a version in some row's `verified` → that row's scripts), supportedRnList (all verified versions).
  // Removed: SUPPORTED_EXPO, SUPPORTED_RN.
  ```

- [ ] **Step 1: Write failing tests** in `tests/versions.test.ts`:
  - `holds every supported line in one table`: `SUPPORTED_LINES.map(lineId)` equals `["expo-57", "expo-58", "bare-0.86", "bare-0.87", "bare-0.88"]`. Each row equals the Global Constraints values. The expo rows' `pins` equal `EXPO57_PINS` and `EXPO58_PINS` from `tests/support`, with the same key order.
  - `reads today's answers from the table`:
    - `[56, 57, 58, 59].map(expoPluginFor)` → `[undefined, "vendored", "installed", "installed"]`;
    - `expoPinPolicyFor` → `[undefined, "exact", "floor", undefined]`;
    - `expoPinsFor(59)` → `undefined`;
    - `rnScriptsFor` on 0.86.2, 0.86.3, 0.87.1, 0.88.0, 0.88.1 → `vendored, vendored, vendored, installed, installed`; on 0.88.2 → `undefined`;
    - `supportedRnList()` → `"0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1"`.
  - `bareLineFor reads the minor`: `"0.88.2"` and `"0.88.0-rc.1"` → the 0.88 row; `"0.89.0"`, `"0.8.1"` and `"58.0.21"` → `undefined`.
- [ ] **Step 2: Run** `npx vitest run tests/versions.test.ts` → FAIL (`SUPPORTED_LINES` is not exported).
- [ ] **Step 3: Implement** the table and readers, and switch the two `SUPPORTED_EXPO` uses.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS. No other test changes.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "refactor: describe supported lines in one table"`

### Task 2: Expo SDK 57 on a floor

**Files:**
- Modify:
  - `src/versions.ts`: the expo-57 `policy` becomes `"floor"`; `ExpoPinPolicy = "floor"`; `checkPins` loses its exact branch; add `releaseLine`.
  - `src/project/expo.ts`: remove the exact branches of `checkExpoPinVersions` and `checkTopLevelJsi`; change the unsupported-SDK text.
  - `src/pipeline/patches.ts`: `lineOnly` replaces `exactOnly`.
- Test: `tests/versions.test.ts`, `tests/project/expo.test.ts`, `tests/patches.test.ts`, `tests/doctor.test.ts` (`reads an Expo SDK 57 project with the vendored plugin` stays green)

**Interfaces:**
- Consumes: `SUPPORTED_LINES`, `expoPinPolicyFor` (Task 1).
- Produces:
  ```ts
  export function releaseLine(version: string): string;   // "0.88.2" → "0.88"; "57.1.4" → "57"; "58.0.21-rc.1" → "58"
  export function selectBundledPatches(projectRoot: string, bundledDir: string, opts?: { lineOnly?: boolean }): string[];
  //   per package: the exact patch; else the highest bundled version whose releaseLine equals the installed one's;
  //   else, unless lineOnly or pkg is react-native, the highest bundled version (today's fallback). react-native: exact
  //   only (Task 3 changes it). Sorted.
  export async function stageBundledPatches(projectRoot: string, dest: string, opts?: { lineOnly?: boolean }): Promise<string[]>;
  // applyPatches: lineOnly = opts.expoPlugin === "vendored"
  ```
- Texts:
  - Below SDK 57: `Expo SDK ${n} is not supported; rn-xtool supports SDK 57 (expo 57.0.31 or newer 57.x) and SDK 58 or newer.`
  - G1, G2, the newer-than-floor warning and the patch-failure "overrides" text on SDK 57 are SDK 58's existing floor texts, built from the 57 row.

- [ ] **Step 1: Write failing tests:**
  - versions.test: `expoPinPolicyFor` → `[undefined, "floor", "floor", undefined]`. `releaseLine` gives the three examples above. `checkPins(57, { …EXPO57_PINS, "expo-modules-jsi": "57.1.4" })` → jsi `newer`. react-native `0.86.4` → `off`.
  - expo.test, in the `Expo SDK 57` block (`PIN_ERROR`, `NEXT_PATCH` and the exact tests are replaced):
    - `accepts the SDK 57 floor set` → resolves with `rnScripts "vendored"` and `expoPlugin "vendored"`; nothing is logged.
    - `names each SDK 57 pin below the floor`, `it.each` over expo 57.0.30, core 57.0.23, autolinking 57.0.15 and jsi 57.1.2. Each message starts with `Expo SDK 57 needs react-native 0.86.3 and at least expo 57.0.31, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3; installed: <pkg> <version>. `. Full text for expo 57.0.30: ``…; installed: expo 57.0.30. Remove any pin or override on these packages from package.json, then run `npx expo install expo@~57.0.31` and `npx expo install --fix`; then run `npx expo install react-native@0.86.3`, since `--fix` alone can leave react-native on another version.``
    - `refuses react-native other than 0.86.3` → 0.86.4 → ``…; installed: react-native 0.86.4. Run `npx expo install react-native@0.86.3`. React Native 0.86.4 is newer than this rn-xtool release supports: pin react-native to 0.86.3, or update rn-xtool.``
    - `warns and continues on a newer 57.x` → expo 57.0.32 + jsi 57.1.4 resolves. `log` receives exactly: `⚠ Newer than the Expo SDK 57 set this rn-xtool release was verified with: expo 57.0.32, expo-modules-jsi 57.1.4. Verified: expo 57.0.31, react-native 0.86.3, expo-modules-core 57.0.24, expo-modules-autolinking 57.0.16 and expo-modules-jsi 57.1.3. The build continues; if it fails or the app crashes at launch, report it at https://github.com/WillyAntunez/react-native-xtool/issues.`
    - `refuses a nested expo-modules-jsi` (kept) → now SDK 58's floor G2 text: ``expo-modules-jsi 57.1.3 resolves from node_modules/expo-modules-core/node_modules/expo-modules-jsi, not from the project's top-level node_modules: rn-xtool patches and builds only the top-level copy. Remove any expo-modules-jsi pin or override from package.json (`npm uninstall expo-modules-jsi` removes a pin), then run `npm update expo-modules-jsi`: it moves the copy to the top level, which a reinstall does not do while package-lock.json keeps it nested.``
    - `rejects SDK 56, 55 and 54` → the new below-57 text.
    - `reads each pin where the build resolves it` keeps its layout cases. The nested core 57.0.25 case now warns instead of throwing; a nested core 57.0.23 names `expo-modules-core 57.0.23` in G1.
  - patches.test:
    - `stages only the jsi patch on an SDK 57 project` → `{ lineOnly: true }` → `["expo-modules-jsi+57.1.3.patch"]`.
    - `never stages another SDK's patch on SDK 57` (Review Focus 2) → expo 57.0.32, autolinking 57.0.17, jsi 57.1.4 and react-native 0.86.3 with `{ lineOnly: true }` → `["expo-modules-jsi+57.1.3.patch"]`.
    - `keeps today's fallback on the installed plugin` → expo 59.0.0 without `lineOnly` → contains `expo+58.0.21.patch`. The existing 58 goldens stay unchanged.
    - `names the SDK 57 overrides when its jsi patch fails on a newer 57.x` → expo 57.0.31 and jsi 57.1.4, with exec failing on `node_modules/expo-modules-jsi`. The message contains `"overrides": { "expo-modules-core": "57.0.24", "expo-modules-autolinking": "57.0.16", "expo-modules-jsi": "57.1.3" }`.
    - `applyPatches stages only line patches for the vendored Expo plugin` (renamed). `names only staged patches…` is unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/versions.test.ts tests/project/expo.test.ts tests/patches.test.ts` → FAIL.
- [ ] **Step 3: Implement** the policy flip, the removals, `releaseLine`, `lineOnly` and the SDK text.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: move Expo SDK 57 to a floor"`

### Task 3: Floors per bare React Native minor

**Files:**
- Modify:
  - `src/versions.ts`: add `rnLineStatus`; `supportedRnList` gets its new text; `rnScriptsFor` is removed.
  - `src/project/bare.ts`: `checkRnVersion` and the newer-than-verified warning.
  - `src/pipeline/patches.ts`: react-native gets the same-line fallback; `rnPatchMismatch` reads the line.
- Test: `tests/versions.test.ts`, `tests/project/bare.test.ts`, `tests/patches.test.ts`

**Interfaces:**
- Consumes: `bareLineFor`, `releaseLine` (Tasks 1–2), `RN_UPGRADE_DOCS`.
- Produces:
  ```ts
  export type RnLineStatus = "verified" | "newer" | "below" | "prerelease" | "unsupported";
  export function rnLineStatus(version: string): { status: RnLineStatus; line?: BareLine };  // line set unless "unsupported"
  export function supportedRnList(): string;   // "0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0"
  // src/project/bare.ts: checkRnVersion(version: string, hasExpoModulesCore: boolean): BareLine   (throws DetectError)
  // patches: react-native → exact, else the highest bundled react-native patch of its releaseLine, else none.
  // rnPatchMismatch: undefined when react-native is not installed or a same-line bundled patch exists.
  ```
- Texts:
  - Refusal (below the floor, prerelease, other minors), with today's suffix: `React Native ${v} is not supported; rn-xtool supports 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0 (bare). Pin react-native to one of them.` and, with expo-modules-core, ` Expo SDK 58 needs React Native 0.88.1.`
  - Warning (through `opts.log`, at the end of `readBareProject`, after the hybrid gates pass): `⚠ Newer than the React Native ${minor} line this rn-xtool release was verified with: react-native ${v}. Verified: ${andList(verified)}. The build continues; if it fails or the app crashes at launch, move react-native back to ${last verified} as ${RN_UPGRADE_DOCS} describes, and report it at https://github.com/WillyAntunez/react-native-xtool/issues.`

- [ ] **Step 1: Write failing tests:**
  - versions.test `classifies bare versions by line`:
    - 0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1 → `verified`;
    - 0.86.4, 0.87.2 and 0.88.12 → `newer`;
    - 0.86.1 and 0.87.0 → `below`;
    - 0.88.2-rc.1 → `prerelease`;
    - 0.85.3 and 0.89.0 → `unsupported` with no `line`.
  - bare.test:
    - `rejects unsupported versions with the supported list` → for 0.86.0, 0.86.1, 0.87.0, 0.85.0, 0.89.0, 0.88.0-rc.1 and 0.88.1-rc.1, the new refusal text. The Expo-sentence test keeps 0.87.0 with the new list.
    - `refuses prereleases of a supported line` (Review Focus 1) → 0.88.2-rc.1 and 0.86.4-rc.0 → refusal text.
    - `accepts a newer patch of each line with a warning` → 0.86.4 → `rnScripts "vendored"`, and `log` receives exactly the warning: `… react-native 0.86.4. Verified: 0.86.2 and 0.86.3. … move react-native back to 0.86.3 as https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native describes, …`. 0.87.3 → vendored; 0.88.2 → installed. Each gets one warning.
    - `stays silent on verified versions` → the five verified versions log nothing.
    - `a hybrid on a newer 0.88.x stops at G1` → 0.88.2 with `use_expo_modules!` and `fakeExpo58Modules(dir, { "react-native": "0.88.2" })` → the SDK 58 G1 text with the `React Native 0.88.2 is newer…` tail. No RN warning is logged.
  - patches.test:
    - `bare 0.88.x gets the highest react-native patch of its line` → 0.88.2 → `["react-native+0.88.1.patch"]`; 0.86.4 → `[]`.
    - `flags react-native only when no bundled patch matches its line` → 0.88.2 → `undefined`; 0.89.0 → `{ pkg: "react-native", installed: "0.89.0", patchFile: "react-native+0.88.1.patch", patched: "0.88.1" }`.
    - `a newer react-native patch that does not apply names the pin` → 0.88.2 with exec failing on `node_modules/react-native` → message starts `rn-xtool could not patch react-native@0.88.2 (patch file: react-native+0.88.1.patch)` and contains `pin "react-native" to 0.88.1`.
- [ ] **Step 2: Run** `npx vitest run tests/versions.test.ts tests/project/bare.test.ts tests/patches.test.ts` → FAIL.
- [ ] **Step 3: Implement** `rnLineStatus`, the gate, the warning (the scripts mode is still `line.scripts`), and the react-native selection.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: accept newer patches of bare RN lines"`

### Task 4: Scripts mode from the shape of the installed scripts

**Files:**
- Create:
  - `src/project/scriptsShape.ts`;
  - `tests/fixtures/rn-scripts/0.87/` and `tests/fixtures/rn-scripts/0.88/`: scripts roots holding only the seven files of `SCRIPTS_REQUIREMENTS`. Each stub keeps only the `module.exports = {…}` block and the `.option('…'` lines, copied from the RN 0.87.1 and 0.88.1 installs (`../app-bare-087`, `../app-bare`);
  - `tests/support/rnScripts.ts`.
- Modify: `src/project/bare.ts` (`rnScripts` from the capability). Test fakes that read bare or hybrid 0.87/0.88 projects get stub scripts: `tests/project/bare.test.ts` (`tempBare`), `tests/support/expo58.ts` (react-native gets the 0.88 stub) and `tests/doctor.test.ts` (the two bare probes on real dirs).
- Test: `tests/scriptsShape.test.ts`, `tests/project/bare.test.ts`

**Interfaces:**
- Consumes: `bareLineFor`, `releaseLine`, `parsePatchFileName`, `packageRoot()`.
- Produces:
  ```ts
  export type ScriptsShape = "none" | "0.87" | "0.88" | "unknown";
  export const SCRIPTS_REQUIREMENTS: readonly { file: string; exports: readonly string[]; options: readonly string[] }[];
  export function readScriptsShape(scriptsRoot: string): { shape: ScriptsShape; missing: string[] };
  export interface ScriptsCapability { shape: ScriptsShape; missing: string[]; recognised: boolean; mode: RnScripts | undefined }
  export function scriptsCapability(rnDir: string, rnVersion: string, bundledDir?: string): ScriptsCapability;
  // tests/support/rnScripts.ts
  export async function fakeRnScripts(rnDir: string, shape: "none" | "0.87" | "0.88"): Promise<void>;  // copies the fixture to <rnDir>/scripts
  export function shapeForVersion(version: string): "none" | "0.87" | "0.88";   // 0.86 → none, 0.87 → 0.87, else 0.88
  ```
- `SCRIPTS_REQUIREMENTS` (paths relative to `<rnDir>/scripts`, in this order):
  1. `setup-apple-spm.js`: exports `main`, `determineVersion`, `ensureBothArtifactFlavors`, `resolveAppIosDeploymentTarget`; options `yes`, `artifacts`, `download`, `config-command`
  2. `spm/generate-spm-autolinking-config.js`: `generateAutolinkingConfig`, `parseConfigCommandJson`
  3. `spm/scaffold-package-swift.js`: `scaffoldAll`, `refreshScaffoldedPlatformFloors`
  4. `spm/sync-spm-autolinking.js`: `main`; option `ios-deployment-target`
  5. `spm/generate-spm-package.js`: `main`
  6. `spm/flavored-frameworks.js`: `finalizeArtifactPublication`
  7. `spm/download-spm-artifacts.js`: `resolveCacheSlotVersion`
- Reading rules:
  - an export is an identifier (or the key of a `key: value` entry) between the file's last `module.exports = {` and the next `}`;
  - an option is a `.option('<name>'` or `.option("<name>"` in the text.
  - `missing` entries look like `setup-apple-spm.js export resolveAppIosDeploymentTarget`, `spm/sync-spm-autolinking.js option --ios-deployment-target` or `spm/generate-spm-package.js file`.
  - Shapes:
    - `none`: neither `setup-apple-spm.js` nor `spm/` exists;
    - `0.88`: nothing is missing;
    - `0.87`: `missing` is exactly `["setup-apple-spm.js export resolveAppIosDeploymentTarget", "spm/scaffold-package-swift.js export refreshScaffoldedPlatformFloors", "spm/sync-spm-autolinking.js option --ios-deployment-target"]`;
    - otherwise `unknown`.
- `scriptsCapability`:
  - `none` and `0.87` → `mode "vendored"`, recognised;
  - `0.88` → `mode "installed"`, recognised, when `bundledDir` (default `<packageRoot>/patches`) holds a react-native patch of `releaseLine(rnVersion)`; otherwise it counts as unknown, with `missing` `["no bundled react-native patch for <line>"]`;
  - unknown → `recognised false`, `mode bareLineFor(rnVersion)?.scripts`.
- `readBareProject`: the rnDir is resolved from the root as `resolveRnDir` does. `rnScripts = scriptsCapability(rnDir, rnVersion).mode ?? line.scripts`. The hybrid "with Expo modules" refusal still checks `rnScripts === "vendored"`.

- [ ] **Step 1: Write the fixtures and failing tests** in `tests/scriptsShape.test.ts`:
  - `the vendored copy has the 0.88 shape` → `readScriptsShape(vendoredScriptsRoot())` → `{ shape: "0.88", missing: [] }`.
  - `pins each known shape` → an empty dir gives `none`; the 0.87 fixture gives `0.87` with the three missing entries; the 0.88 fixture gives `0.88`.
  - `anything else is unknown` → the 0.88 fixture without `spm/generate-spm-package.js` → `unknown`, missing `["spm/generate-spm-package.js file"]`. The 0.87 fixture with `determineVersion` also removed → `unknown`. Only `spm/` present → `unknown`.
  - `matches today's table for every supported version` → for 0.86.2, 0.86.3, 0.86.4, 0.87.1, 0.87.2, 0.88.0, 0.88.1 and 0.88.2, with `fakeRnScripts(rnDir, shapeForVersion(v))`: `scriptsCapability(rnDir, v).mode === bareLineFor(v)!.scripts`, and `recognised` is true.
  - `falls back to the version table for an unknown shape` → the 0.88 fixture minus one export, on 0.88.1 → `{ recognised: false, mode: "installed" }`; on 0.85.0 → `mode undefined`.
  - `a complete shape without a bundled patch of its line is unknown` → the 0.88 fixture on 0.87.2 → `{ recognised: false, mode: "vendored", missing: ["no bundled react-native patch for 0.87"] }`.
  - `never runs the installed scripts` (Review Focus 3) → the 0.88 fixture whose `setup-apple-spm.js` begins with `throw new Error("executed")` → still `0.88`.
  - `reads the scripts of the react-native the build resolves` (Review Focus 3) → `node_modules/react-native` is a symlink to a dir outside the project holding the 0.88 fixture and `package.json` 0.88.1. `readBareProject` gives `rnScripts "installed"`.
  - `detects the installed shapes of the reference apps` → `describe.skipIf` unless `../app-bare-086`, `../app-bare-087` and `../app-bare` exist (relative to the repo root) → `none`, `0.87`, `0.88`.
  - bare.test `accepts each supported version` keeps its expectations, with `tempBare` writing `shapeForVersion(rn)` scripts.
- [ ] **Step 2: Run** `npx vitest run tests/scriptsShape.test.ts tests/project/bare.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module and the `readBareProject` switch, then update the test fakes listed under Files.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint && npm run scan:private` → PASS.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: pick SwiftPM scripts by their shape"`

### Task 5: Capability detector

**Files:**
- Create: `src/project/capabilities.ts`
- Test: `tests/capabilities.test.ts`

**Interfaces:**
- Consumes:
  - `scriptsCapability` (Task 4); `rnLineStatus`, `expoLineFor`, `bareLineFor` (Tasks 1–3);
  - `expoPackageDir`, `installedExpoVersion` (`src/project/expo.ts`); `detectProjectKind`;
  - `rawSlotComplete`, `rnArtifactsCacheRoot` (`rnArtifactsStep.ts`);
  - the vendored downloader's exports `rnCoreReleaseUrls`, `rnDepsReleaseUrls`, `hermesReleaseUrls`, `resolveLocalHermesCompilerVersion`, loaded with `createRequire` from `vendor/rn-spm/spm/download-spm-artifacts.js` (its `require.main` guard keeps `main` from running).
- Produces:
  ```ts
  export type HeadProbe = (url: string, signal: AbortSignal) => Promise<number>;   // HTTP status; default fetch HEAD
  export interface ArtifactsCapability { status: "cached" | "published" | "missing" | "unknown"; version: string; missing: string[]; detail?: string }
  export async function probeArtifacts(rnDir: string, version: string, opts?: { cacheRoot?: string; head?: HeadProbe; timeoutMs?: number }): Promise<ArtifactsCapability>;
  //   cached: both raw slots <cacheRoot>/<version>/{debug,release} complete, no network. Else React, ReactNativeDependencies
  //   (version) and Hermes (local hermes-compiler version) × debug, release, all in parallel under one
  //   AbortSignal.timeout(timeoutMs = 10_000). Each is published when any of its release URLs answers 200.
  //   missing: names like "ReactNativeDependencies (release)". A rejection or the timeout → unknown, with detail = the
  //   error message or `timed out after ${timeoutMs / 1000} s`. Without hermes-compiler, Hermes is skipped and
  //   detail = "Hermes not checked: hermes-compiler is not installed".
  export type PodspecFeature = "subspecs" | "compiler_flags" | "header_dir" | "header_mappings_dir" | "vendored_frameworks" | "resource_bundles";
  export function podspecFeatures(root: string): Record<PodspecFeature, string[]>;
  //   package.json `dependencies` that resolve from the root and have a *.podspec in their package dir. Read as text:
  //   /\.subspec\b/, /\bcompiler_flags\s*=/, /\bheader_dir\s*=/, /\bheader_mappings_dir\s*=/, /\bvendored_frameworks\s*=/,
  //   /\bresource_bundles?\s*=/. Values are package names, sorted.
  export interface Capabilities {
    kind?: ProjectKind; rnVersion?: string; expoVersion?: string; sdk?: number;
    scripts?: ScriptsCapability; artifacts?: ArtifactsCapability;   // undefined without react-native
    expoPlugin?: "ships" | "none";        // expo's react-native.config.js has /autolinkingPlugin\s*:/; undefined without expo
    expoModules?: "precompiled" | "source";   // core's prebuilds/output/{debug,release}/xcframeworks/ExpoModulesCore.tar.gz
    podspecs: Record<PodspecFeature, string[]>;
  }
  export async function detectCapabilities(projectRoot: string, opts?: { cacheRoot?: string; head?: HeadProbe; timeoutMs?: number }): Promise<Capabilities>;
  export function unsupportedReason(c: Capabilities): string | undefined;   // undefined when a line (or SDK ≥ 58) covers it
  ```
- `unsupportedReason` texts (verbatim). `<scripts>` is `no SwiftPM scripts` (none), `SwiftPM scripts without the entry points rn-xtool needs` (0.87), `SwiftPM scripts rn-xtool could use, not verified on this line` (0.88) or `SwiftPM scripts rn-xtool does not recognise` (unknown). `, no prebuilt artifacts for ${v}` is appended to `<scripts>` when artifacts are `missing`.
  - Bare, minor below 0.86: `React Native ${minor}: <scripts>; support comes with the translator`
  - Bare, minor above 0.88: `React Native ${minor}: newer than the lines this release supports (0.86, 0.87 and 0.88); a new minor is added once it is verified on a device`
  - Bare, below the floor: `React Native ${v}: below the ${minor} floor (${floor}); move react-native to ${floor} or newer`
  - Bare, prerelease: `React Native ${v}: a prerelease; rn-xtool supports releases of the ${minor} line from ${floor}`
  - Expo SDK < 57: `Expo SDK ${sdk}: expo ships ${expoPlugin === "ships" ? "its" : "no"} SwiftPM plugin; React Native ${rnMinor}: <scripts>; support comes with the translator`
  - react-native not installed: `react-native is not installed: run npm install`

- [ ] **Step 1: Write failing tests** in `tests/capabilities.test.ts`:
  - `reports cached slots without the network` → `makeFakeSlot088` into `<cache>/0.88.1/{debug,release}`; a `head` that throws → `cached`.
  - `checks the release URLs the downloader uses` → 0.88.2 with `node_modules/hermes-compiler/package.json` 250829098.0.4 resolvable from rnDir. A recording `head` answers 200 → `published`. The recorded URLs include `https://repo.reactnative.dev/maven2/com/facebook/react/react-native-artifacts/0.88.2/react-native-artifacts-0.88.2-reactnative-core-debug.tar.gz` and `https://repo.reactnative.dev/maven2/com/facebook/hermes/hermes-ios/250829098.0.4/hermes-ios-250829098.0.4-hermes-ios-release.tar.gz`.
  - `names the artifacts nobody publishes` → 404 on every `reactnative-dependencies` URL → `missing` `["ReactNativeDependencies (debug)", "ReactNativeDependencies (release)"]`.
  - `reports artifacts as not checked when the probe fails or times out` (Review Focus 4) → a rejecting `head` → `unknown` with the rejection message. A `head` that never settles, with `timeoutMs: 50` → `unknown`, detail `timed out after 0.05 s`, done in under 1 s.
  - `skips Hermes without hermes-compiler` → `published`, detail `Hermes not checked: hermes-compiler is not installed`.
  - `lists the podspec features of the dependencies` → deps `a` (`s.subspec 'x'`, `s.compiler_flags = '-DX'`) and `b` (`s.header_mappings_dir = 'ios'`, `s.resource_bundles = {}`), `c` without a podspec, and a devDependency `d` with `header_dir` → `{ subspecs: ["a"], compiler_flags: ["a"], header_dir: [], header_mappings_dir: ["b"], vendored_frameworks: [], resource_bundles: ["b"] }`.
  - `detects an Expo SDK 58 project` → a `head` answering 200, the 58 fixture, `fakeExpo58Modules`, expo `react-native.config.js` with `autolinkingPlugin: './scripts/spm/plugin.js'`, core prebuild tarballs → `kind "expo"`, `sdk 58`, `expoVersion "58.0.21"`, `rnVersion "0.88.1"`, `expoPlugin "ships"`, `expoModules "precompiled"`, `scripts.shape "0.88"`.
  - `detects an Expo SDK 57 project` → `expoPlugin "none"`, `scripts.shape "none"`, `scripts.mode "vendored"`.
  - `gives unsupported versions a reason` → each text above, from bare 0.81.5 (no scripts, then also 404s), 0.89.0 (0.88 stub), 0.86.1, 0.88.0-rc.1, Expo SDK 56 (expo 56.0.4, no plugin, react-native 0.85.2 without scripts) and no react-native. Bare 0.88.2, Expo 57, 58 and 59 → `undefined`.
- [ ] **Step 2: Run** `npx vitest run tests/capabilities.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/project/capabilities.ts`.
- [ ] **Step 4: Run** the test file, then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: detect project capabilities"`

### Task 6: `doctor --project`

**Files:**
- Modify: `src/commands/doctor.ts`, `src/cli.ts`
- Test: `tests/doctor.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Capabilities`, `detectCapabilities`, `unsupportedReason` (Task 5); `expoLineFor`, `rnLineStatus`.
- Produces:
  ```ts
  // DoctorProbes gains: capabilities: (root: string) => Promise<Capabilities>   (realProbes: detectCapabilities)
  export function capabilityChecks(c: Capabilities): DoctorCheck[];
  //   names, in order: versions, rn-scripts, rn-artifacts, expo-plugin, expo-modules, podspecs; the three Expo/RN lines
  //   are left out when their field is undefined
  export async function doctorWithProbes(p: DoctorProbes, root?: string, opts?: { projectOnly?: boolean }): Promise<DoctorReport>;
  //   projectOnly: node, project, project-config, then capabilityChecks. The project check no longer waits on build
  //   state there. Without projectOnly: today's checks, unchanged.
  export async function doctor(root?: string, probes?: DoctorProbes, opts?: { projectOnly?: boolean }): Promise<DoctorReport>;
  // cli: doctor gains .option("--project", "check only the project (version gates and capabilities): no toolchain, login or device checks");
  //   with --project the root is always the cwd.
  ```
- Detail texts (verbatim; status in brackets):
  - versions:
    - Expo 57/58 [ok]: `Expo SDK ${sdk}: expo ${expoVersion} (verified ${pins.expo}), react-native ${rn} (verified ${pins["react-native"]})`
    - Expo ≥ 59 [info]: `Expo SDK ${sdk}: no verified set in this release; the installed plugin builds it, gated by G4 only`
    - bare in a line [ok]: `React Native ${v}: the ${minor} line (${floor} or newer), verified ${andList(verified)}`
    - otherwise [fail]: `unsupportedReason(c)`
  - rn-scripts:
    - 0.88 [ok]: `react-native's own SwiftPM scripts (0.88 shape)`
    - none [ok]: `react-native ships no SwiftPM scripts: rn-xtool's vendored copy (React Native 0.88.0)`
    - 0.87 [ok]: `react-native's SwiftPM scripts lack ${missing.join("; ")} (0.87 shape): rn-xtool's vendored copy (React Native 0.88.0)`
    - unknown [warn]: `not recognised (missing: ${missing.join("; ")}); ${mode ? `the version table picks the ${mode} scripts` : "no supported line"}`
  - rn-artifacts:
    - cached [ok]: `React Native ${v} artifacts are in the cache`
    - published [ok]: `published for React Native ${v}` plus ` (${detail})` when set
    - missing [warn]: `not published for React Native ${v}: ${missing.join(", ")}`
    - unknown [info]: `not checked: ${detail}`
  - expo-plugin:
    - ships [ok]: `expo ships its SwiftPM plugin`
    - none on SDK 57 [ok]: `expo ships no SwiftPM plugin: rn-xtool's vendored copy (Expo 58.0.19)`
    - none otherwise [info]: `expo ships no SwiftPM plugin`
  - expo-modules: [ok] `precompiled (expo-modules-core ${v})`; [info] `built from source (expo-modules-core ${v} ships no prebuilds)`
  - podspecs [info]: `${feature}: ${names.join(", ")}` for each non-empty feature, joined with `; `, or `no tracked podspec features in the dependencies`

- [ ] **Step 1: Write failing tests:**
  - doctor.test `--project skips the toolchain, login and device checks` → `good` plus `capabilities`, where `swiftVersion`, `xtoolInstalled`, `authStatus`, `devices`, `wifi`, `ufwActive`, `lanRoute`, `buildState` and `llvmNmVersion` throw if called. The check names equal `["node", "project", "project-config", "versions", "rn-scripts", "rn-artifacts", "expo-plugin", "expo-modules", "podspecs"]` and `ok` is true.
  - doctor.test `prints each capability line` → `it.each` over one `Capabilities` value per text above → `{ status, detail }` equal.
  - doctor.test `an unsupported version gets a reason` → capabilities for bare 0.81.5 without scripts, and `project` rejecting with the bare refusal → `versions` is `fail` with `React Native 0.81: no SwiftPM scripts; support comes with the translator`, and `ok` is false.
  - doctor.test `plain doctor prints no capability lines` → today's names, and `capabilities` is never called.
  - cli.test `doctor has --project` → the `doctor` command lists the `--project` option with the text above.
- [ ] **Step 2: Run** `npx vitest run tests/doctor.test.ts tests/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** the probe, the mode, the checks and the flag.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS. Then `npm run build && (cd ../app-bare && node ../expo-xtool-floors/bin/rn-xtool.js doctor --project)` prints the nine lines and exits 0 (read only; the app is not modified).
- [ ] **Step 5: Commit** `git add src tests && git commit -m "feat: add doctor --project"`

### Task 7: Drift watch, checking one line

**Files:**
- Create: `src/drift/targets.ts`, `src/drift/check.ts`, `scripts/drift-watch.mjs` (subcommands `targets`, `check`; imports `../dist/drift/*.js`; not in `package.json` `files`)
- Modify: `src/pipeline/manifests.ts` (export `unportableSymbols`)
- Test: `tests/drift/targets.test.ts`, `tests/drift/check.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_LINES`, `lineId`, `expoLineFor`, `releaseLine`; `selectBundledPatches` (Task 2); `makeManifestPortable`, `MANIFEST_FIXES`; `installedExpoVersion`, `readExpoPins`.
- Produces:
  ```ts
  // src/drift/targets.ts
  export interface WatchTarget { id: string; slug: string; line: string; title: string; kind: "expo" | "bare"; sdk?: number; template?: string; minor?: string; version?: string }
  //   id "expo-58/default" | "bare-0.88"; slug = id with "/" → "-"; line = lineId; title "Drift: Expo SDK 58" | "Drift: React Native 0.88 (bare)"
  export function newestOfMinor(versions: readonly string[], minor: string): string | undefined;   // stable releases only
  export function watchTargets(rnVersions: readonly string[]): WatchTarget[];   // one per expo template, one per bare row
  export function createCommand(t: WatchTarget, dir: string): [string, string[]];
  //   expo: ["npx", ["--yes", "create-expo-app@latest", dir, "--template", `${template}@sdk-${sdk}`]]
  //   bare: ["npx", ["--yes", `@react-native-community/cli@${cli}`, "init", "DriftApp", "--directory", dir, "--version", version,
  //          "--install-pods", "false", "--skip-git-init"]]
  // src/drift/check.ts
  export type Run = (cmd: string, args: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;
  export function classifyFailure(output: string): "network" | "drift";
  //   network: /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\b|socket hang up|npm error code E(429|5\d\d)\b/;
  //   everything else, ERESOLVE included, is drift
  export interface StepResult { step: "create" | "gates" | "patches" | "manifests" | "drill"; ok: boolean; output: string }
  export interface TargetResult { target: WatchTarget; status: "green" | "red" | "unknown"; versions: Record<string, string>; steps: StepResult[] }
  export async function patchDryRun(root: string, opts: { lineOnly: boolean; run: Run; bundledDir?: string }): Promise<StepResult>;
  //   each selected patch: ["patch", ["-p1", "-F0", "--dry-run", "-d", root, "-i", <bundled patch>]]; output lists "<name>: ok|<output>"
  export async function manifestCheck(root: string): Promise<StepResult>;
  //   react-native-reanimated and react-native-worklets, when installed with a Package.swift: not ok when
  //   unportableSymbols(makeManifestPortable(text).text) is non-empty; output names "<pkg> <version>: rewritten|portable|not recognised"
  export async function checkTarget(t: WatchTarget, dir: string, deps: { run: Run; cli: string; existing?: boolean }): Promise<TargetResult>;
  //   create (skipped with existing): one retry on "network"; network twice → unknown, stop; drift → red, stop.
  //   Then gates (`node <cli> doctor --project` in dir), patches (lineOnly = expoLineFor(sdk)?.plugin === "vendored")
  //   and manifests, all run; any not ok → red. versions: expo, react-native and the line's pins as installed.
  // src/pipeline/manifests.ts
  export function unportableSymbols(text: string): string[];   // MANIFEST_FIXES names whose symbol occurs in Linux code
  ```
- `scripts/drift-watch.mjs`:
  - `targets <daily|explore>` → `npm view react-native versions --json`, with one retry, then prints `matrix=<json>` (`{"include":[{"target":…,"slug":…}]}`) for `$GITHUB_OUTPUT`. `explore` is filled in by Task 9.
  - `check --target <json> --dir <dir> --out <file> [--existing]` → writes the `TargetResult` and exits 0, red or not.

- [ ] **Step 1: Write failing tests:**
  - targets.test `newestOfMinor` → `["0.88.0", "0.88.1", "0.88.2-rc.1", "0.89.0", "0.88.10"]` gives `0.88.10` for `0.88` and `undefined` for `0.85`.
  - targets.test `one target per template and bare line` → ids `["expo-57/blank-typescript", "expo-58/blank-typescript", "expo-58/default", "bare-0.86", "bare-0.87", "bare-0.88"]`, with titles and the newest versions from a fixed list.
  - targets.test `creates projects the way the e2e harness does` → both `createCommand` argv arrays above.
  - check.test `classifies install failures` → `npm error code ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `npm error code E503` and `npm error code E429` are network. `npm error code ERESOLVE` and `Error: template not found` are drift (row 3).
  - check.test `retries a network failure once, then could not run` → create fails twice with ECONNRESET → `unknown`; `run` was called twice; no gates. Network once, then ok → continues.
  - check.test `an ERESOLVE install is drift` → `red` with the npm output in `steps[0]`.
  - check.test `runs every check and reports each failure` → gates exit 1 → `red`, and patches and manifests still ran.
  - check.test `stages the line's patches for the dry run` → an SDK 57 fake (expo 57.0.31, jsi 57.1.4) → one `patch` call ending `expo-modules-jsi+57.1.3.patch`. An SDK 58 fake → the three 58 patches.
  - check.test `checks the portable-manifest rewrite` → `tests/fixtures/manifests/react-native-worklets.Package.swift` → ok, `rewritten`. The portable fixture → ok, `portable`. A manifest whose only use is `guard CFGetTypeID(v) == CFBooleanGetTypeID() else {` → not ok, `react-native-worklets 0.13.0: not recognised`. Not installed → ok.
  - check.test `unportableSymbols` → `["CFGetTypeID"]` for the broken fixture, `[]` for the portable one.
- [ ] **Step 2: Run** `npx vitest run tests/drift` → FAIL.
- [ ] **Step 3: Implement** the two modules, the export and the two subcommands.
- [ ] **Step 4: Run** `npx vitest run tests/drift`, then `npm test && npm run lint && npm run scan:private` → PASS. `npm run build && node scripts/drift-watch.mjs targets daily` prints one `matrix=` line with six targets.
- [ ] **Step 5: Commit** `git add src scripts tests && git commit -m "feat: check supported lines for drift"`

### Task 8: Drift issues, one per broken line

**Files:**
- Create: `src/drift/issues.ts`
- Modify: `scripts/drift-watch.mjs` (subcommand `report`)
- Test: `tests/drift/issues.test.ts`

**Interfaces:**
- Consumes: `WatchTarget`, `TargetResult` (Task 7).
- Produces:
  ```ts
  export interface LineResult { line: string; title: string; status: "green" | "red" | "unknown"; targets: TargetResult[] }
  export function resultsFor(targets: WatchTarget[], results: TargetResult[]): TargetResult[];
  //   a target without a result → unknown, one step { step: "create", ok: false, output: "no result: the check job did not finish" }
  export function groupByLine(results: TargetResult[]): LineResult[];   // red if any red; else unknown if any unknown; else green
  export function applyDrill(lines: LineResult[], drill: string): LineResult[];
  //   "" → unchanged; a line id → red, with a step { step: "drill", ok: false, output: "forced red by the workflow_dispatch input drill" };
  //   unknown id → throw `unknown drift line "${drill}"; lines: expo-57, expo-58, bare-0.86, bare-0.87, bare-0.88`
  export interface OpenIssue { number: number; title: string }
  export type IssueAction =
    | { type: "create"; title: string; body: string }
    | { type: "update"; number: number; body: string }
    | { type: "close"; number: number; comment: string };
  export function planIssueActions(lines: LineResult[], open: OpenIssue[], ctx: { runUrl: string; date: string }): IssueAction[];
  //   red: update the lowest-numbered open issue with the line's exact title, else create. green: close each open issue
  //   with that title, comment `Green again on ${date}: ${runUrl}`. unknown: nothing.
  export function issueBody(line: LineResult, ctx: { runUrl: string; date: string }): string;
  export function summaryMarkdown(lines: LineResult[]): string;   // one row per line: title, status, failing steps
  export function reportExitCode(lines: LineResult[]): number;    // 1 when any line is unknown ("watch could not run"), else 0
  ```
- Issue body (verbatim parts, in order):
  - `rn-xtool's drift watch found this line broken on ${date}.`
  - for each target: `### ${id}`, its versions as `name version` pairs, and each failing step's last 60 output lines in a fenced block;
  - `The drift watch checks the project gates (G1–G3), the bundled patches (patch -F0 --dry-run) and the portable library manifests. It does not compile or run the app: a green line can still fail G4 or the build. The compat-suite CI closes that gap.`
  - `Last run: ${runUrl}`.
- `report --results <dir> --targets <matrix json> [--drill <id>] [--dry-run]`:
  - reads `*.json` results;
  - without `--dry-run`: `gh label create drift --color B60205 --description "rn-xtool drift watch" --force`, then `gh issue list --label drift --state open --json number,title --limit 100`, then each action through `gh issue create --label drift`, `gh issue edit --body-file` or `gh issue close --comment`;
  - `--dry-run` prints the actions as JSON lines and calls no `gh`;
  - appends `summaryMarkdown` to `$GITHUB_STEP_SUMMARY` when it is set, and exits with `reportExitCode`;
  - `runUrl` = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`.

- [ ] **Step 1: Write failing tests** in `tests/drift/issues.test.ts`:
  - `rolls targets up into lines` → expo-58 red + green → red; unknown + green → unknown; green + green → green.
  - `a target without a result could not run` (Review Focus 5) → `resultsFor` with one result missing → that target is `unknown` with the exact output.
  - `opens an issue for a newly broken line` → red, no open → one `create`, title `Drift: React Native 0.88 (bare)`.
  - `updates the open issue instead of opening another` (row 6) → open #7 and #12 with the same title → one `update` of #7, no `create`.
  - `closes the issue when the line is green again` → `close` #7 with `Green again on 2026-10-30: https://github.com/o/r/actions/runs/1`.
  - `leaves issues alone when a line could not run` (Review Focus 5) → unknown with #7 open → `[]`; `reportExitCode` → 1.
  - `never touches another line's issue` → open #3 `Drift: Expo SDK 58` and #9 `Something else`; every line green except bare-0.88 red → exactly `[close #3, create "Drift: React Native 0.88 (bare)"]`, and #9 is untouched.
  - `drills a line red` → `applyDrill(lines, "bare-0.88")` → red with the drill step; `"x"` → the exact throw.
  - `writes the watch's limit into every issue` → `issueBody` contains the limit paragraph verbatim, `### bare-0.88`, `react-native 0.88.2`, the last 60 lines of a 100-line output (not line 40), and `Last run: …`.
- [ ] **Step 2: Run** `npx vitest run tests/drift/issues.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module and the subcommand.
- [ ] **Step 4: Run** the test file, then `npm test && npm run lint && npm run scan:private` → PASS. `npm run build`, then `report --dry-run` on a temp dir holding one hand-written red result prints one `create` line.
- [ ] **Step 5: Commit** `git add src scripts tests && git commit -m "feat: report drift as GitHub issues"`

### Task 9: Weekly exploration and the workflow

**Files:**
- Create: `src/drift/explore.ts`, `.github/workflows/drift-watch.yml`
- Modify: `src/drift/targets.ts` (`exploreTargets`), `scripts/drift-watch.mjs` (`targets explore`, `explore`, `explore-summary`)
- Test: `tests/drift/explore.test.ts`, `tests/drift/workflow.test.ts`

**Interfaces:**
- Consumes: `createCommand`, `classifyFailure`, `Run` (Task 7); `detectCapabilities`, `unsupportedReason` (Task 5).
- Produces:
  ```ts
  // src/drift/targets.ts
  export const EXPLORE_EXPO_SDKS: readonly number[];   // [54, 55, 56], template blank-typescript
  export const EXPLORE_RN_MINORS: readonly string[];   // ["0.81", "0.82", "0.83", "0.84", "0.85"], newest stable patch
  export function exploreTargets(rnVersions: readonly string[]): WatchTarget[];
  // src/drift/explore.ts
  export interface ExploreRow { id: string; installed: string; scripts: string; artifacts: string; expoPlugin: string; expoModules: string; podspecs: string; reason: string }
  export async function exploreTarget(t: WatchTarget, dir: string, deps: { run: Run; capabilities?: typeof detectCapabilities }): Promise<ExploreRow>;
  //   create with one network retry; a failure → every cell "unknown", reason `could not create: ${first output line}` (row 10)
  export function exploreTable(rows: ExploreRow[]): string;
  //   "| Target | Installed | SwiftPM scripts | Artifacts | Expo plugin | Expo modules | Podspec features | Reason |" + one row each
  ```
- Workflow layout:
  - `targets` job: mode = `explore` on the weekly cron or `inputs.mode == 'explore'`, else `daily`. Outputs `mode` and `matrix`.
  - `check` job (daily): matrix, `fail-fast: false`, `timeout-minutes: 30`. Steps: checkout, `actions/setup-node` 20 with the npm cache, `npm ci`, `npm run build`, `check`, then `actions/upload-artifact` `drift-${slug}`.
  - `report` job: `needs: [targets, check]`, `if: always() && needs.targets.outputs.mode == 'daily'`, permissions `contents: read` and `issues: write`. It runs `actions/download-artifact` (pattern `drift-*`, merged), then `report` with `GH_TOKEN: ${{ github.token }}` and `DRILL: ${{ inputs.drill }}` in `env:`.
  - `explore` (matrix) and `explore-summary` (weekly): upload `explore-${slug}` artifacts, then write `exploreTable` to `$GITHUB_STEP_SUMMARY`. They open no issue.
  - A header comment states row 1: GitHub disables schedules after 60 days without repository activity, and a monthly manual `workflow_dispatch` re-arms the watch.

- [ ] **Step 1: Write failing tests:**
  - explore.test `explores Expo SDK 54–56 and bare 0.81–0.85` → ids `["expo-54/blank-typescript", "expo-55/blank-typescript", "expo-56/blank-typescript", "bare-0.81", "bare-0.82", "bare-0.83", "bare-0.84", "bare-0.85"]`.
  - explore.test `turns capabilities into a row` → stub capabilities for bare 0.81.5 (shape none, artifacts published) → `scripts "none"`, `artifacts "published"`, `reason "React Native 0.81: no SwiftPM scripts; support comes with the translator"`.
  - explore.test `a failed probe shows as unknown` (row 10) → create fails with a drift error → every cell `unknown`, reason starts `could not create: `. Two network failures → the same.
  - explore.test `exploreTable` → the header line exactly, one row per target, in target order.
  - workflow.test, reading `.github/workflows/drift-watch.yml` as text:
    - exactly two `cron:` values, `23 5 * * *` and `47 5 * * 1`;
    - `workflow_dispatch` with inputs `mode` (options `daily`, `explore`) and `drill`;
    - every permission line is `contents: read` or `issues: write`, and `issues: write` appears once, under `report`;
    - no `secrets.` reference; `GH_TOKEN: ${{ github.token }}` present;
    - every `runs-on:` is `ubuntu-latest`;
    - no `setup-swift`, `swiftly` or `rn-xtool setup`;
    - no `${{ inputs.` inside a `run:` block;
    - every `node scripts/drift-watch.mjs <sub>` names a subcommand the script handles (its `case "<sub>"` labels).
- [ ] **Step 2: Run** `npx vitest run tests/drift` → FAIL.
- [ ] **Step 3: Implement** the module, the subcommands and the workflow.
- [ ] **Step 4: Run** `npx vitest run tests/drift`, then `npm test && npm run lint && npm run scan:private` → PASS. `npm run build && node scripts/drift-watch.mjs targets explore` prints eight targets.
- [ ] **Step 5: Commit** `git add src scripts tests .github && git commit -m "feat: add drift watch workflow and exploration"`

### Task 10: Docs and changelog

**Files:**
- Modify:
  - `README.md`, "Which projects work":
    - `Expo SDK 57 (expo 57.0.31 or newer 57.x, react-native 0.86.3)`;
    - bare rows `0.86.x from 0.86.2, 0.87.x from 0.87.1, 0.88.x from 0.88.0`, keeping the verified notes (0.86.2 build-only);
    - the bare-versions paragraph: a newer patch builds with a warning, older ones stop with one error;
    - a line on `rn-xtool doctor --project`.
    - "Limits" gets the watch's limit (row 7).
  - `docs/troubleshooting.md`:
    - a new `## Newer than the verified versions` section with the SDK 57/58 and bare warnings, the pin-back remedy (row 8), and a patch that fails on a newer patch;
    - a new `## doctor --project` section explaining each line, "not recognised" and the unsupported reasons;
    - the `## Expo SDK 57` section's G1/G2 texts become the floor texts.
  - `docs/bare-react-native.md` "Supported React Native versions" and "Vendored SwiftPM scripts": the floors, and the scripts mode chosen by shape.
  - `docs/how-it-works.md` "Expo SDK 57": the floor and patch selection by release line.
  - `docs/RELEASING.md`: a `## Drift watch` section covering what it checks, the `drift` issues, the `drill` input, a monthly manual dispatch (row 1), and GitHub's failure email as the fallback when `gh` fails (row 5). It also says that adding a line takes one `SUPPORTED_LINES` row plus its verification, and that the line then leaves the weekly exploration list.
  - `CHANGELOG.md` `[Unreleased]`:
    - Added: bare floors per minor, `doctor --project` with capabilities, the drift watch.
    - Changed: SDK 57 is a floor (new G1/G2 texts), the scripts mode is chosen by shape, and patches are selected by release line.
    - An upgrade note: nothing to do; `doctor --project` shows the new lines.
- Test: `npm test && npm run lint && npm run scan:private`.

- [ ] **Step 1: Write** the docs. Every quoted error or warning is copied from Tasks 2–6, with no "pending" notes.
- [ ] **Step 2: Run** these checks:
  - `grep -n "exactly 0.86.2\|57.0.31 exact\|needs exactly" README.md docs/*.md` → no hit outside CHANGELOG's released sections;
  - then the three commands → clean.
- [ ] **Step 3: Commit** `git add README.md CHANGELOG.md docs && git commit -m "docs: document version floors and drift watch"`

### Task 11: Watch run and device check (controller with Willy)

CLI: `npm run build` in the worktree, then `node ../expo-xtool-floors/bin/rn-xtool.js <cmd>` in each app. The apps are build-only inputs: nothing in them is committed. Record the versions, capability lines and timings in the PR body.

- [ ] **Step 1 (local watch on the reference apps, no downloads):** run `node scripts/drift-watch.mjs check --existing` with the matching target on:
  - `../app-expo-57` (expo-57/blank-typescript);
  - `../app` (expo-58/default);
  - `../app-bare-086`, `../app-bare-087` and `../app-bare` (bare 0.86/0.87/0.88).

  Each result is `green`. `report --dry-run` on those results prints no action; with `--drill bare-0.88` it prints one `create`.
- [ ] **Step 2 (`doctor --project`):** in each of the five apps the report is ok. The shapes are `none`, `0.88`, `none`, `0.87` and `0.88`. Artifacts are `cached` where a build ran before, and no `versions` line fails.
- [ ] **Step 3 (device):** `../app-expo-57` (SDK 57 floor, verified set unchanged): `doctor` logs no newer-than-floor warning; `build` exits 0; `install`; Willy launches it once. Then `../app-bare-086`, `../app-bare-087` and `../app-bare` (one per minor): `build` exits 0 with the same steps as alpha.3, then `install` and launch once each.
- [ ] **Step 4:** Fixes go through the owning task's files with a red/green test, one `fix:` commit each. A gap that needs a new rn-xtool step goes to Willy as a decision.
- [ ] **Step 5 (on GitHub, after Willy merges the PR):** `gh workflow run drift-watch.yml -f mode=daily` is green and opens no issue. `-f drill=bare-0.88` opens `Drift: React Native 0.88 (bare)` labelled `drift`. A rerun without `drill` closes it with the "Green again" comment. `-f mode=explore` writes the eight-row table. Record the run links.

## Resolved questions (Willy, 2026-10-29)

1. **Workflow proof before merge.** Merge on the local proof (Task 11 Step 1). The real GitHub runs, the hand-run and the forced-red `drill`, happen right after the merge (Task 11 Step 5). A failure there is fixed in a small follow-up PR. No temporary `pull_request` trigger.
2. **Bare drift projects pin their CLI per line.** Each bare row gets a `cli` field: the `@react-native-community/cli` version that the matching `@react-native-community/template` declares in its `devDependencies` for that minor's verified version (`npm view @react-native-community/template@<verified> devDependencies`). Task 7 resolves and writes the values. A test pins them. `createCommand` uses `@react-native-community/cli@${cli}` instead of `@latest`. Dropping `@latest` keeps a CLI release that drops an old minor from turning a line red when rn-xtool has not drifted.
