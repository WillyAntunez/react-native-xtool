# expo-xtool CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hand-built recipe in `expo-ios-linux/app/ios-xtool/` into an npm CLI (`expo-xtool`) that builds, signs, installs and serves an Expo SDK 58+ iOS dev build from Linux.

**Architecture:** A TypeScript CLI orchestrates three layers: (1) the official RN/Expo SwiftPM pipeline (`setup-apple-spm.js`, Expo's SPM plugin) run with Linux shims and patches; (2) a generator that writes a regenerable `ios-xtool/` directory (Package.swift, xtool.yml, Info.plist, sources, staged frameworks); (3) thin wrappers around the pinned xtool AppImage and `expo start`. Pure functions (plist resolution, manifest parsing, template rendering, port/IP selection) are unit-tested; the end-to-end run is verified manually on the iPhone.

**Tech Stack:** Node 20+, TypeScript (strict), `commander`, `vitest`, `plist` (npm), `@expo/config`, `patch-package`, `execa`. Bash scripts already in `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-23-expo-xtool-design.md`

## Global Constraints

- Expo SDK ≥ 58 / React Native ≥ 0.88 only; fail fast with a clear message otherwise.
- xtool pinned to `1.23.0`; Swift `6.4` via swiftly; iOS deployment target `16.4`; triple `arm64-apple-ios`.
- xtool is consumed as the official AppImage, never patched. Nothing from Apple is redistributed.
- Generated `ios-xtool/` is an artifact: regenerated on every `build`, never hand-edited, git-ignored by the host project.
- The SwiftPM app target/module/executable is always named `App`; display name, bundle ID and versions come from `app.json`.
- The installed bundle ID is `XTL-<TEAM_ID>.<bundleIdentifier>` (xtool behaviour); the CLI must print it.
- Free Apple ID limits (7-day signing, 3 apps, no push/entitlements) are surfaced, never hidden.
- Repo rules: `feature/<slug>` branches, Conventional Commits in English, one logical change per commit, PR to `main`, push as the repo owner.
- All messages to the user in English (CLI is for everyone); docs in English.

## Review Focus

1. Info.plist with an unresolved `$(VAR)` after substitution (e.g. a new Expo template key) → `build` must fail with the key name, never ship a black-screen app. (Task 4 test `throws on unresolved variable`.)
2. Metro port change between `build` and `start` → the app has `RCTMetroPort` baked in; `start` must refuse to silently use another port and tell the user to rebuild+reinstall. (Task 12 test `portMismatchMessage`.)
3. LAN IP change (DHCP) after install → `ip.txt` is baked in; `start` must detect the mismatch and say reinstall is needed. (Task 12 test `ipMismatchMessage`.)
4. No iPhone connected → `xtool devices` hangs forever; `install` and `doctor` must time out (30 s) with a clear message. (Task 10 test `listDevices times out`.)
5. Project on SDK < 58 or `ios/` generated with CocoaPods only → fail fast before running the pipeline. (Task 5 test `rejects sdk below 58`.)

## Failure walk (external hops)

| # | Hop | Fails outright | Partial / late / duplicate | Who learns | Ruling (proposed; Willy confirms) |
|---|-----|----------------|----------------------------|-----------|-----------------------------------|
| 1 | `setup` downloads xtool AppImage from GitHub releases | network / 404 | truncated file | user via error | **handle**: size+exec check, retry once, print manual URL (Task 9) |
| 2 | `setup` installs swiftly/Swift | network | partial toolchain | user | **handle**: delegate to swiftly's own retry; `doctor` verifies `swift --version` (Task 9, 13) |
| 3 | `setup` installs Darwin SDK from Xcode.xip | bad path / disk full (7 GB) | — | user | **handle**: pre-check path exists and ≥ 10 GB free (Task 9) |
| 4 | RN pipeline downloads prebuilts from Maven | network | corrupt tarball | user | **handle**: surface RN's error; `--artifacts <dir>` offline option (Task 8) |
| 5 | `xtool auth` token expired | Apple rejects | — | user | **handle**: `doctor`/`install` check `auth status` first and tell user to `xtool auth login` (Task 10) |
| 6 | USB install | no device / untrusted / Developer Mode off | install OK but app won't open | user | **handle** timeout + first-run checklist printed after install (Task 10) |
| 7 | Metro reachable from phone | firewall / different WiFi / port taken | — | user sees RN red screen | **handle** port selection + mismatch checks; **accept** firewall (cannot sudo): `doctor` warns if ufw active (Task 12, 13) |
| 8 | 7-day certificate expiry | app stops launching | — | user | **accept**: documented in README; `doctor` prints days left if xtool exposes it, else static reminder (Task 14) |
| 9 | Metro port already held | the port is Metro from an earlier run, so rebuilding would bake a different port | late: Metro stops between the probe and `start` | user sees a port mismatch | **handle**: `isMetroRunning` probes `/status`; a Metro already serving `packager-status:running` on that port keeps it (expo-xtool cannot tell which project it belongs to; if it is another project's Metro, stop it), and `start` reuses it instead of failing (Tasks 3, 11) |
| 10 | LAN IP detection behind a VPN | default route is a tunnel / non-private address the phone cannot reach | — | user sees "No script URL" | **handle**: `build` and `doctor lan-ip` warn and point to `lanIp`; never blocks (Tasks 3, 11, 13) |
| 11 | `patch-package` applies Expo patches | installed Expo package version differs from the patched one | patch applies with fuzz or leaves rejects | user | **handle**: capture output, name package and versions, offer pin or issue report (Tasks 8, 11) |

---

## File structure

```
expo-xtool/
  package.json  tsconfig.json  vitest.config.ts  .gitignore  README.md
  bin/expo-xtool.js                 # node shim → dist/cli.js
  src/cli.ts                        # commander program, wires commands
  src/versions.ts                   # XTOOL_VERSION, SWIFT_VERSION, IOS_MIN, MIN_EXPO_SDK
  src/config.ts                     # loadConfig(projectRoot): ExpoXtoolConfig (defaults + file)
  src/paths.ts                      # ProjectPaths from root; cacheDir()
  src/project.ts                    # readExpoProject(root): ExpoProject; buildVars(project)
  src/plist.ts                      # resolveBuildVars, transformInfoPlist
  src/frameworks.ts                 # readFlavoredFrameworks, stageFrameworks
  src/net.ts                        # detectLanIp, findFreePort
  src/generate/packageSwift.ts      # renderPackageSwift
  src/generate/xtoolYml.ts          # renderXtoolYml
  src/generate/iosXtool.ts          # writeIosXtool(ctx): sources, plist, yml, Package.swift, ip.txt
  src/tools/exec.ts                 # run(), toolEnv()
  src/tools/xtool.ts                # xtoolBin, xtool(), authStatus, listDevices, installedBundleId
  src/pipeline/patches.ts           # applyPatches
  src/pipeline/rnSpm.ts             # runRnSpm (setup-apple-spm add/update)
  src/pipeline/jsi.ts               # buildExpoModulesJsi (wraps scripts/build-expo-modules-jsi.sh)
  src/pipeline/appConfig.ts         # generateAppConfig (expo-constants getAppConfig.js)
  src/commands/{setup,doctor,build,install,start,run}.ts
  patches/*.patch                   # patch-package format (converted from current .diff)
  scripts/, shims/                  # existing
  tests/**                          # vitest, mirrors src/
  tests/fixtures/                   # Info.plist from Expo 58 template, flavored-frameworks.json, app.json
```

---

### Task 1: Package scaffold and CLI entry

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `bin/expo-xtool.js`, `src/cli.ts`, `src/versions.ts`, `tests/cli.test.ts`. Modify `.gitignore` (add `dist/`, `coverage/`).

**Interfaces:** Produces `src/versions.ts` exports `XTOOL_VERSION = "1.23.0"`, `SWIFT_VERSION = "6.4"`, `IOS_MIN = "16.4"`, `MIN_EXPO_SDK = 58`, `HERMES_TRIPLE = "arm64-apple-ios"`. `src/cli.ts` exports `buildProgram(): Command` (commands registered in later tasks; stub with `--version`).

- [ ] **Step 1:** `git checkout -b feature/cli-scaffold`.
- [ ] **Step 2:** Write `tests/cli.test.ts`: `buildProgram().helpInformation()` contains `expo-xtool` and `buildProgram().version()` equals package.json version.
- [ ] **Step 3:** Run `npx vitest run` → FAIL (module not found).
- [ ] **Step 4:** Add `package.json` (`name: expo-xtool`, `type: module`, `bin: {"expo-xtool": "bin/expo-xtool.js"}`, `engines.node >=20`, scripts `build: tsc -p .`, `test: vitest run`, `lint: tsc --noEmit`), deps `commander execa plist @expo/config patch-package`, dev deps `typescript vitest @types/node @types/plist`. `npm install`.
- [ ] **Step 5:** Implement `src/versions.ts`, `src/cli.ts` (`buildProgram` with name/description/version), `bin/expo-xtool.js` (`#!/usr/bin/env node`, imports `../dist/cli.js`, calls `buildProgram().parseAsync()`).
- [ ] **Step 6:** `npx vitest run` → PASS; `npm run build` → `dist/cli.js` exists.
- [ ] **Step 7:** Commit `chore: scaffold TypeScript CLI with commander and vitest`.

### Task 2: Config and project paths

**Files:** Create `src/config.ts`, `src/paths.ts`, `tests/config.test.ts`.

**Interfaces:** Produces
```ts
export interface ExpoXtoolConfig { xcodeXipPath?: string; metroPort: number; lanIp?: string; rnArtifactsDir?: string; xtoolPath?: string }
export async function loadConfig(projectRoot: string): Promise<ExpoXtoolConfig>   // defaults {metroPort: 8081}, merged with expo-xtool.config.json then .js (default export)
export interface ProjectPaths { root: string; ios: string; iosBuild: string; xcframeworks: string; autolinking: string; expoDir: string; generatedIos: string; iosXtool: string; sources: string; frameworks: string; jsiOut: string; appBundle: string }
export function projectPaths(root: string): ProjectPaths            // iosXtool = <root>/ios-xtool, appBundle = <iosXtool>/xtool/App.app
export function cacheDir(): string                                  // $XDG_CACHE_HOME/expo-xtool or ~/.cache/expo-xtool
```

- [ ] **Step 1:** Tests: `loadConfig` on empty temp dir returns `{metroPort: 8081}`; with `expo-xtool.config.json` `{"metroPort": 8082}` returns 8082; `projectPaths("/p").iosXtool === "/p/ios-xtool"`; `cacheDir()` honours `XDG_CACHE_HOME`.
- [ ] **Step 2:** Run → FAIL.  **Step 3:** Implement.  **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add config loading and project path helpers`.

### Task 3: Network helpers

**Files:** Create `src/net.ts`, `tests/net.test.ts`.

**Interfaces:** Produces
```ts
export function parseLanIp(ipRouteOutput: string): string | undefined   // from `ip -4 route get 1.1.1.1` → value after "src"
export async function detectLanIp(runner = defaultRunner): Promise<string>  // throws Error("Could not detect LAN IP; set lanIp in expo-xtool.config.json")
export async function isPortFree(port: number, host = "0.0.0.0"): Promise<boolean>
export async function findFreePort(start: number, maxTries = 10): Promise<number>  // first free in [start, start+maxTries)
```

- [ ] **Step 1:** Tests: `parseLanIp("1.1.1.1 via 192.168.1.1 dev enp4s0 src 192.168.1.100 uid 1000")` → `"192.168.1.100"`; `parseLanIp("")` → `undefined`; `findFreePort` skips a port held open by a test server; `isPortFree` false on that port.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (`net.createServer` probe). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add LAN IP detection and free port lookup`.

### Task 4: Info.plist resolution

**Files:** Create `src/plist.ts`, `tests/plist.test.ts`, `tests/fixtures/Info.template.plist` (copy of `expo-ios-linux/app/ios/app/Info.plist`).

**Interfaces:** Produces
```ts
export type BuildVars = Record<string, string>
export function resolveBuildVars(xml: string, vars: BuildVars): string     // replaces every $(NAME) / ${NAME}; throws Error(`Unresolved build variable(s): NAME1, NAME2`) if any remain
export interface InfoPlistOptions { vars: BuildVars; metroPort: number }
export function transformInfoPlist(xml: string, opts: InfoPlistOptions): string
```
`transformInfoPlist`: resolve vars → parse → delete `UILaunchStoryboardName` → set `UILaunchScreen = {}`, `RCTMetroPort = String(metroPort)`, `NSLocalNetworkUsageDescription = "Connects to the Metro development server on your local network."`, `NSBonjourServices = ["_http._tcp"]` (merge, no duplicates) → serialize.

- [ ] **Step 1:** Tests: resolves `$(PRODUCT_MODULE_NAME).SceneDelegate` → `App.SceneDelegate`; `throws on unresolved variable` naming `PRODUCT_MODULE_NAME`; output has no `UILaunchStoryboardName`, has `UILaunchScreen`, `RCTMetroPort == "8082"`, `NSBonjourServices` contains `_http._tcp` exactly once when run twice (idempotent).
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `plist` npm. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: resolve and transform Info.plist for xtool builds`.

### Task 5: Expo project model and build variables

**Files:** Create `src/project.ts`, `tests/project.test.ts`, `tests/fixtures/app.json` (from `expo-ios-linux/app/app.json`), fixture `package.json` with `expo: "~58.0.17"`.

**Interfaces:** Produces
```ts
export interface ExpoProject { root: string; name: string; slug: string; version: string; buildNumber: string; bundleIdentifier: string; sdkVersion: number; iosTargetName: string /* sanitized name as expo prebuild does */; iosTargetDir: string }
export async function readExpoProject(root: string): Promise<ExpoProject>   // via @expo/config getConfig; throws if sdk < MIN_EXPO_SDK or ios.bundleIdentifier missing
export function buildVars(p: ExpoProject): BuildVars   // PRODUCT_NAME=p.name, PRODUCT_BUNDLE_IDENTIFIER, MARKETING_VERSION=p.version, CURRENT_PROJECT_VERSION=p.buildNumber, PRODUCT_MODULE_NAME="App", EXECUTABLE_NAME="App", DEVELOPMENT_LANGUAGE="en", PRODUCT_BUNDLE_PACKAGE_TYPE="APPL"
```
Target dir: `<root>/ios/<iosTargetName>`; use `@expo/config-plugins` `IOSConfig.XcodeUtils.sanitizedName` for `iosTargetName` (verify export at implementation; fallback: regex `[^a-zA-Z0-9]` → "").

- [ ] **Step 1:** Tests: fixture → `bundleIdentifier === "com.example.app"`, `iosTargetName === "app"`, `buildVars().PRODUCT_MODULE_NAME === "App"`; `rejects sdk below 58` (fixture with `expo: "~57.0.0"`) error mentions `58`; missing bundleIdentifier throws.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: read Expo project config and derive build variables`.

### Task 6: Runtime frameworks manifest and staging

**Files:** Create `src/frameworks.ts`, `tests/frameworks.test.ts`, `tests/fixtures/flavored-frameworks.json` (copy from `app/ios/build/xcframeworks/`).

**Interfaces:** Produces
```ts
export interface RuntimeFramework { id: string; name: string /* frameworkName */; executable: string; searchPath: string /* abs dir containing <name>.framework */; frameworkDir: string }
export function readFlavoredFrameworks(xcframeworksDir: string, flavor: "debug" | "release", slice = "ios-arm64"): RuntimeFramework[]
  // searchPath = `${xcframeworksDir}/${flavor}/${artifactRelativePath}/${slice}` for linkage === "dynamic"
export function jsiFramework(jsiOutDir: string): RuntimeFramework      // { id: "expo-modules-jsi", name: "ExpoModulesJSI", executable: "ExpoModulesJSI", searchPath: jsiOutDir, ... }
export async function stageFrameworks(frameworks: RuntimeFramework[], destDir: string): Promise<void>   // rm -rf dest; fs.cp(frameworkDir, dest/<name>.framework, {recursive, dereference: true})
```

- [ ] **Step 1:** Tests: fixture yields 7 frameworks, names `["React","ReactNativeDependencies","hermesvm","ExpoFileSystem","ExpoFont","ExpoModulesCore","ExpoModulesWorklets"]`, hermes `searchPath` ends with `debug/hermes-engine.xcframework/ios-arm64`; `stageFrameworks` on a temp fake `.framework` (with a symlinked file) produces a real file copy.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: read runtime frameworks manifest and stage frameworks`.

### Task 7: Generators (Package.swift, xtool.yml, ios-xtool writer)

**Files:** Create `src/generate/packageSwift.ts`, `src/generate/xtoolYml.ts`, `src/generate/iosXtool.ts`, tests for each.

**Interfaces:** Produces
```ts
export interface PackageSwiftInput { iosDir: string; compileInterfacesDir: string; frameworks: RuntimeFramework[]; iosMin: string }
export function renderPackageSwift(i: PackageSwiftInput): string
export interface XtoolYmlInput { bundleIdentifier: string; resources: string[] }   // resources default ["Frameworks", "ip.txt", "EXConstants.bundle"]
export function renderXtoolYml(i: XtoolYmlInput): string
export interface GenerateContext { project: ExpoProject; paths: ProjectPaths; frameworks: RuntimeFramework[]; metroPort: number; lanIp: string }
export async function writeIosXtool(ctx: GenerateContext): Promise<void>
```
`renderPackageSwift` reproduces `expo-ios-linux/app/ios-xtool/Package.swift` with paths parametrised: dependencies `ReactNative` (`<ios>/build/xcframeworks`), `React-GeneratedCode` (`<ios>/build/generated/ios`), `Autolinked` (`<ios>/build/generated/autolinking`), `ExpoModulesJSIHeaders` (`<ios>/build/generated/autolinking/expo/ExpoModulesJSIHeaders`); swiftSettings `DEBUG` define + `-F compileInterfacesDir`; linker `c++`, `-Xlinker -ObjC`, `-F` per unique `searchPath`, `.linkedFramework(name)` per framework; `swiftLanguageModes: [.v5]`, `cxxLanguageStandard: .cxx20`, `platforms: [.iOS("<iosMin>")]`.
`writeIosXtool`: mkdir `ios-xtool/Sources/App`; copy `AppDelegate.swift`, `SceneDelegate.swift` from `project.iosTargetDir`; symlink `ExpoModulesProvider.swift` → `<ios>/build/generated/autolinking/expo/ExpoModulesProvider.swift`; write `Info.plist` via `transformInfoPlist(read(<iosTargetDir>/Info.plist), {vars: buildVars(project), metroPort})`; write `ip.txt` = `lanIp + "\n"`; write `xtool.yml`, `Package.swift`; write `.gitignore` with `*`.

- [ ] **Step 1:** Tests: Package.swift contains `.linkedFramework("hermesvm")`, `"-F", "<searchPath>"` once per unique path, `swiftLanguageModes: [.v5]`; xtool.yml parses (`yaml` dev dep or string checks) to `bundleID` and the 3 resources; `writeIosXtool` on a temp project fixture creates the 6 expected entries and `Info.plist` contains `App.SceneDelegate`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: generate ios-xtool package from Expo project`.

### Task 8: Tool execution env and RN SwiftPM pipeline

**Files:** Create `src/tools/exec.ts`, `src/pipeline/patches.ts`, `src/pipeline/rnSpm.ts`, `tests/exec.test.ts`, `tests/patches.test.ts`; convert `patches/*.diff` → patch-package files `patches/expo-modules-autolinking+<ver>.patch`, `patches/expo+<ver>.patch`, `patches/expo-modules-jsi+<ver>.patch` (versions from `app/node_modules/*/package.json`).

**Interfaces:** Produces
```ts
export function toolEnv(extra?: Record<string,string>): NodeJS.ProcessEnv   // PATH = <pkg>/shims : ~/.local/share/swiftly/bin : process PATH; unsets SDKROOT
export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; nice?: boolean }): Promise<void>  // execa, stdio inherit; nice → prefix `nice -n 15`
export async function applyPatches(projectRoot: string): Promise<void>   // `npx patch-package --patch-dir <pkg>/patches` with cwd projectRoot; tolerate "already applied"
export const AUTOLINKING_CONFIG_COMMAND = ["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]
export async function runRnSpm(paths: ProjectPaths, opts: { rnArtifactsDir?: string }): Promise<void>
  // mode = exists(<ios>/.spm-injected.json) ? "update" : "add"
  // node <rn>/scripts/setup-apple-spm.js <mode> --config-command JSON(AUTOLINKING_CONFIG_COMMAND) [--download skip --artifacts <dir>] , cwd = paths.ios, env = toolEnv()
```

- [ ] **Step 1:** Tests: `toolEnv().PATH` starts with the shims dir and contains swiftly bin; `SDKROOT` absent; `runRnSpm` argv builder (`rnSpmArgs(paths, opts)` exported) yields `add` when no `.spm-injected.json`, `update` otherwise, and includes `--download skip` only with `rnArtifactsDir`; each `patches/*.patch` file name matches `/^[^+]+\+\d+\.\d+\.\d+\.patch$/`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; regenerate patches with `npx patch-package <pkg>` from `expo-ios-linux/app` (already-patched node_modules). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: run RN SwiftPM pipeline with Linux shims and patches`.

### Task 9: ExpoModulesJSI, app.config and setup command

**Files:** Create `src/pipeline/jsi.ts`, `src/pipeline/appConfig.ts`, `src/commands/setup.ts`, `tests/appConfig.test.ts`.

**Interfaces:** Produces
```ts
export async function buildExpoModulesJsi(paths: ProjectPaths): Promise<RuntimeFramework>   // bash <pkg>/scripts/build-expo-modules-jsi.sh <root> <paths.jsiOut>; returns jsiFramework(paths.jsiOut)
export function appConfigArgs(expoConstantsDir: string, root: string, dest: string): string[]
  // [ `${expoConstantsDir}/scripts/getAppConfig.js`, root, dest, "ios", "true", "development" ]
export async function generateAppConfig(paths: ProjectPaths): Promise<void>   // dest = <iosXtool>/EXConstants.bundle (mkdir -p); resolve expo-constants from `expo` package dir
export async function setup(opts: { xcodeXip?: string }): Promise<void>
```
`setup`: ensure swiftly (`curl -O https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz` → `swiftly init --assume-yes`) and `swiftly install <SWIFT_VERSION> --use --assume-yes` if `swift --version` missing/older; download AppImage `https://github.com/xtool-org/xtool/releases/download/v<XTOOL_VERSION>/xtool-x86_64.AppImage` to `cacheDir()/xtool-<ver>.AppImage` (skip if present and executable; verify size > 1 MB, retry once); `xtool sdk install <xip>` if `~/.swiftpm/swift-sdks/darwin.artifactbundle` missing (pre-check xip exists and `df` ≥ 10 GB; **ask the user before this step** – it is heavy); if `xtool auth status` prints `Logged out`, print instructions to run `xtool auth login` interactively. Each step prints `✔`/`✖`.

- [ ] **Step 1:** Test `appConfigArgs` ordering/values; test `setup` step list via exported `planSetup(state)` returning the actions needed for a given probe state (`{hasSwift, hasXtool, hasSdk, loggedIn}`) → e.g. all true → `[]`, `hasSdk:false` → `["install-sdk"]`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add ExpoModulesJSI build, app.config generation and setup command`.

### Task 10: xtool wrapper and install command

**Files:** Create `src/tools/xtool.ts`, `src/commands/install.ts`, `tests/xtool.test.ts`.

**Interfaces:** Produces
```ts
export function xtoolBin(config: ExpoXtoolConfig): string              // config.xtoolPath ?? cacheDir()/xtool-<ver>.AppImage; throws "Run `expo-xtool setup`" if missing
export async function authStatus(bin: string): Promise<{ loggedIn: boolean; teamId?: string; appleId?: string }>   // parse "Logged in." / "Team ID: X"
export async function listDevices(bin: string, timeoutMs = 30000): Promise<{ name: string; udid: string; transport: string }[]>   // kill on timeout → []
export function installedBundleId(teamId: string, bundleIdentifier: string): string   // `XTL-${teamId}.${bundleIdentifier}`
export async function devBuild(bin: string, iosXtoolDir: string): Promise<void>       // xtool dev build --configuration debug (cwd iosXtoolDir, env toolEnv(), nice)
export async function devRun(bin: string, iosXtoolDir: string): Promise<void>         // xtool dev run --configuration debug --usb
export async function install(root: string): Promise<void>
```
`install`: config → bin → `authStatus` (fail: "Not logged in. Run: <bin> auth login") → `listDevices` (empty: "No iPhone found over USB. Connect it, tap Trust, and enable Developer Mode.") → `devRun` → print installed bundle ID and first-run checklist (Developer Mode, trust certificate under Settings → General → VPN & Device Management, local-network permission, 7-day expiry for free accounts).

- [ ] **Step 1:** Tests: `authStatus` parser on the two real outputs (`Logged out` / `Logged in.\n- Apple ID: x\n- Team ID: <TEAM_ID>`); `installedBundleId("<TEAM_ID>","com.a.b") === "XTL-<TEAM_ID>.com.a.b"`; `listDevices times out` using a fake bin (`sleep 60`) with `timeoutMs: 200` → `[]` within 1 s; parser on `Test iPhone [usb]: 00008030-000000000000000E`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: wrap xtool and add install command`.

### Task 11: build command

**Files:** Create `src/commands/build.ts`, `tests/build.test.ts`.

**Interfaces:** Produces `export async function build(root: string, opts: { clean?: boolean }): Promise<void>` and `export function buildSteps(state): string[]`.

Order: `readExpoProject` → if `!exists(<ios>)` or `opts.clean` → `npx expo prebuild --platform ios --no-install [--clean]` (cwd root) → `applyPatches` → `runRnSpm` → `buildExpoModulesJsi` → `generateAppConfig` → frameworks = `readFlavoredFrameworks(<ios>/build/xcframeworks, "debug") + jsi` → `stageFrameworks(frameworks, <iosXtool>/Frameworks)` → `writeIosXtool({..., metroPort: config.metroPort, lanIp: config.lanIp ?? detectLanIp()})` → `devBuild`. Print each step with elapsed time. Record `{metroPort, lanIp, bundleIdentifier}` to `<iosXtool>/.expo-xtool-state.json` for `start`.

- [ ] **Step 1:** Test `buildSteps({hasIos:false, clean:false})` starts with `"prebuild"`; `{hasIos:true}` omits it; `{clean:true}` includes `"prebuild --clean"`; state file schema test (`writeState`/`readState` round-trip).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add build command orchestrating the SwiftPM pipeline and xtool`.

### Task 12: start and run commands

**Files:** Create `src/commands/start.ts`, `src/commands/run.ts`, `tests/start.test.ts`.

**Interfaces:** Produces
```ts
export function portMismatchMessage(built: number, wanted: number): string   // "App was built for Metro port X but Y is wanted. Run `expo-xtool build && expo-xtool install`, or free port X."
export function ipMismatchMessage(built: string, current: string): string
export async function start(root: string): Promise<void>
export async function run(root: string, opts: { clean?: boolean }): Promise<void>   // build → install → start
```
`start`: read state → if `!isPortFree(state.metroPort)` → print `portMismatchMessage(state.metroPort, await findFreePort(state.metroPort+1))` and exit 1 → if `detectLanIp() !== state.lanIp` → print `ipMismatchMessage` and exit 1 → `npx expo start --lan --port <port>` (inherit stdio). `build` (Task 11) picks `config.metroPort` if free else `findFreePort(config.metroPort)` and tells the user which port it baked in.

- [ ] **Step 1:** Tests: both message functions contain both numbers / both IPs and the word `install`; `start` decision helper `startDecision({portFree, builtIp, currentIp})` → `"ok" | "port-mismatch" | "ip-mismatch"`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; register all commands in `src/cli.ts`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add start and run commands with Metro port and IP checks`.

### Task 13: doctor command

**Files:** Create `src/commands/doctor.ts`, `tests/doctor.test.ts`.

**Interfaces:** `export async function doctor(root?: string): Promise<DoctorReport>`; `export interface DoctorCheck { name: string; ok: boolean; detail: string }`; `export function renderReport(r: DoctorCheck[]): string`.
Checks: node ≥ 20; `swift --version` ≥ 6.4; xtool AppImage present and `--version` = pinned; Darwin SDK dir exists; `authStatus`; `listDevices` (warn only); `systemctl is-active ufw` → warn "ufw active: allow Metro port"; if `root`: Expo SDK ≥ 58, `ios-xtool/.expo-xtool-state.json` present, Metro port free.

- [ ] **Step 1:** Test `renderReport` marks `✔`/`✖`/`⚠` and `doctor` uses injected probes (`doctorWithProbes(probes)`) so no real tools run in tests.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: add doctor command`.

### Task 14: End-to-end verification on the reference app and docs

**Files:** Modify `README.md` (usage, requirements, limits, first-run checklist, troubleshooting: port/IP/firewall/Developer Mode/7-day cert). Create `docs/recipe.md` (migrate `expo-ios-linux/notes/RESEARCH.md` findings, English).

- [ ] **Step 1:** `npm run build && npm link`; in `expo-ios-linux/app`: `rm -rf ios-xtool && expo-xtool doctor` → all ✔ except device if unplugged.
- [ ] **Step 2:** `expo-xtool build` → prints steps, ends with `Build complete`; `diff <(sort ios-xtool/Package.swift) <(sort ../app/ios-xtool.bak/Package.swift)` differs only in the JSI path; `grep -c '\$(' ios-xtool/Info.plist` → 0. (Ask Willy before: ~3 min CPU.)
- [ ] **Step 3:** iPhone on USB: `expo-xtool install` → ends with installed bundle ID `XTL-<TEAM_ID>.com.example.app` and checklist.
- [ ] **Step 4:** `expo-xtool start` → Metro on the baked port; open the app → Metro logs `iOS Bundled`; edit `App.tsx` → Fast Refresh. Willy confirms visually.
- [ ] **Step 5:** Write README/docs; commit `docs: document usage, requirements and troubleshooting`.
- [ ] **Step 6:** Open PR `feature/cli-scaffold` → `main` (gh as the repo owner), summary of tasks; merge after review.

### Task 15: Library validation matrix (spike, after Task 14)

Not TDD; exploratory, each library on its own `feature/lib-<name>` branch of the reference app, result recorded in `docs/libraries.md` as a table (library, version, result, notes). Order: expo-haptics, react-native-safe-area-context, react-native-screens, react-native-gesture-handler, react-native-reanimated (+worklets), expo-router, react-native-svg, react-native-webview, expo-notifications (local), expo-secure-store, expo-image-picker, @gorhom/bottom-sheet, async-storage, datetimepicker. For each: `npx expo install <lib>` → `expo-xtool run` → smoke-use in `App.tsx`. Failures feed the `catalog/` design (separate plan).

---

## Self-review notes

- Spec coverage: setup/doctor/build/install/start/run (T9–T13), ios-xtool generation with all vars resolved (T4, T7), patches via patch-package (T8), framework staging from the manifest (T6), library groups A/B measured before automating catalog (T15), failure walk table present, free-account limits surfaced (T10, T14).
- Not in this plan (by spec): catalog/ for CocoaPods-only libraries → separate plan after T15; config plugin sugar; SDK ≤ 57.
- Type names used consistently: `ExpoProject`, `ProjectPaths`, `RuntimeFramework`, `BuildVars`, `ExpoXtoolConfig`, `GenerateContext`.
