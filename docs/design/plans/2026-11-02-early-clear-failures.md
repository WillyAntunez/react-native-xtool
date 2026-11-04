# Early, Clear Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Known causes of failure stop early with a one-line reason: setups rn-xtool cannot build (in `doctor --project` and at the start of `build`), Apple sign-in failures that are upstream problems, and the free-account App ID limit. `doctor --report` prints a redacted block for issues, issue templates ask for it, CI runs on every PR from pinned npm tarballs instead of the private `../app`, and xtool moves to 1.24.0.

**Architecture:** `src/project/earlyChecks.ts` reads the project's files (and runs the vendored Expo plugin's own podspec and source-tree readers) and returns `EarlyFailure`s. `detectCapabilities` carries them into `doctor --project`; `build` checks them before it reads the project. `src/tools/xtoolErrors.ts` matches xtool's captured stderr against pinned texts; `auth` and `install` throw its messages and rethrow anything else unchanged. `src/commands/report.ts` wraps the doctor probes to record the private values they return, renders one block and redacts it. A tarball manifest (`tests/tarballs.json`) and `scripts/fetch-test-tarballs.mjs` feed the patch tests; `.github/workflows/ci.yml` runs them and lists skipped tests by name.

**Tech Stack:** TypeScript (Node 22, ESM), vitest 5 (its `json` reporter for the skipped list), execa 10 (`["inherit", "pipe"]` stdio), GNU `patch` and `tar`, `npm pack`, `gh release download`, GitHub Actions on `ubuntu-latest`, `yaml` 2 (tests only).

**Spec:** `docs/design/specs/2026-11-02-early-clear-failures-design.md` (approved). Its failure-walk rulings are binding.

## Global Constraints

- Linux, Node 22.12+, Swift 6.4 and `IOS_MIN` 16.4 stay unchanged. `XTOOL_VERSION` stays `1.23.0` until Task 11, which pins `1.24.0`. No new runtime dependency; one new devDependency, `yaml` `^2.9.1` (already in the tree through patch-package), for the template tests.
- **No new network call** in `doctor`, `doctor --project`, `doctor --report` or `build`. Early checks read files only. They never run or `require` code installed in the project, only rn-xtool's vendored `vendor/expo-spm/spm/podspec.js` and `classify.js`.
- **Docs links:** `troubleshootingUrl(anchor)` in `src/docs.ts` returns `https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#${anchor}`. The anchors are `libraries-with-prebuilt-binaries`, `libraries-that-build-vendored-c-sources`, `pnpm-and-yarn-pnp`, `packages-hoisted-to-a-parent-folder` and `app-id-limit`; Task 12 writes their headings.
- **Unknown xtool output passes through unchanged:** the same error object is rethrown, and the CLI prints it as today.
- **Redaction placeholders (Task 7):** home folder `~`, Apple ID `<apple-id>`, other e-mail `<email>`, Team ID `<team-id>`, UDID `<udid>`, device name `<device>`, IP `<ip>`, token `<token>`. A `XTL-<team>.` bundle prefix is removed.
- **Fixture values pass `scan:private`:** planted UDIDs have the shape `00008110-00000000XXXXXXXX` (eight zeros after the dash). The planted home is `/home/me`. Apple IDs use `example.com`. No real Apple ID, Team ID or UDID, and no absolute `/home` path, appears in committed files.
- **CI** (`.github/workflows/ci.yml`) is triggered by `pull_request` and by `push` to `main`. It runs on `ubuntu-latest` and Node 22 with `contents: read` only and checkouts with `persist-credentials: false`. It uses no secret and only `actions/checkout@v7` and `actions/setup-node@v7`. No `${{` appears inside `run:` text.
- **Failure-walk owners:**
  - Row 1 (handle): Tasks 4–6 tests (fixtures, Expo-module exclusion, the five reference apps) and Task 13 Step 2.
  - Row 2 (accept): plan notes in Tasks 4–5; Task 12 troubleshooting text.
  - Row 3 (accept): Task 2 plan note and its pass-through test; Task 12 text.
  - Row 4 (handle): Task 11 (hashes from the official assets) and Task 13 Step 1.
  - Row 5 (handle): Task 13 Steps 3–4; a regression reverts the pin.
  - Row 6 (handle): Task 7 planted-values test; Task 8 review text and checkbox.
  - Row 7 (accept): Task 9 retry and its test; Task 12 README text.
  - Row 8 (handle): Task 10 summary step and Task 9's `skippedTests` test.
- Error, hint, doctor and report texts in this plan are verbatim.
- Every task ends with `npm test && npm run lint` green. Every commit runs `npm run scan:private` after `git add`.
- Commits use Conventional Commits in English, subject ≤ 50 characters, no body, one logical change each, and no scratch code. Task 13 is run by the controller with Willy; implementers never need the device, the Apple ID or GitHub.

## Review Focus

1. After a failed build, rn-xtool's scaffolder has written `Package.swift` into the library's folder. That file must not hide the library from the binaries check. A manifest carrying the scaffolder or autolinker marker counts as none (Task 4 test `a Package.swift rn-xtool scaffolded still counts as none`).
2. Expo-SDK projects whose Expo modules declare `vendored_frameworks` (expo-router, expo-constants, expo-modules-jsi in the reference apps) never trip the binaries check. The drift watch's `doctor --project` gate must stay green on a fresh template (Task 4 test `never fires on Expo modules`).
3. A `pnpm-lock.yaml` or `.pnp.cjs` left in a parent folder, or a react-native symlinked into the project's own `node_modules`, is not a refused install (Task 5 tests `a stray lockfile without a .pnpm store does not fire` and `a symlinked react-native in node_modules is not hoisted`).
4. `auth login` must keep its prompts: stdin and stdout stay on the terminal, only stderr is teed. rn-xtool's SIGINT guard must be removed after the login, or a later Ctrl+C would no longer stop rn-xtool (Task 2 tests `tees only stderr` and `removes its SIGINT guard after login`; Task 13 Step 3 on the terminal).
5. A private value inside free text that no probe returned is still redacted by pattern: a home path, a token, an IPv6 address or an old 40-hex UDID in an error detail (Task 7 test `redacts planted values everywhere in the report`).
6. Before the final verdict, the reviewer answers without hints: "Name three ways this fails in production that no test covers." Any answer not in the spec's failure table goes to Willy as a decision, not to the implementer as a fix.

---

### Task 1: Name both FUSE packages

**Files:**
- Modify: `src/tools/xtool.ts` (`xtoolUnrunnableError`), `README.md` ("Before you start", the `libfuse2` bullet), `docs/how-it-works.md` ("What `setup` installs", line 14)
- Test: `tests/xtool.test.ts`

**Interfaces:**
- Produces: `xtoolUnrunnableError(exitCode: number | undefined, output: string): Error` (signature unchanged). Text: `` `xtool could not run (exit ${exitCode ?? "unknown"}): ${output.trim().slice(0, 300)}. On Ubuntu this usually means FUSE 2 is missing: sudo apt install libfuse2t64 on Ubuntu 24.04 and newer, sudo apt install libfuse2 on older releases` ``
- Docs:
  - README bullet: ``- FUSE 2 for the xtool AppImage (`sudo apt install libfuse2t64` on Ubuntu 24.04 and newer, `sudo apt install libfuse2` on older releases), `python3`, `iproute2`.`` The rest of the bullet stays.
  - how-it-works: `(needs FUSE 2: `libfuse2t64` on Ubuntu 24.04 and newer, `libfuse2` on older releases)`.

- [ ] **Step 1: Write the failing test** `names the FUSE package of each Ubuntu release` → `xtoolUnrunnableError(1, "fuse: failed to open /dev/fuse\n").message` equals the text above with `exit 1` and `fuse: failed to open /dev/fuse`. The existing `/…libfuse2/s` test stays.
- [ ] **Step 2: Run** `npx vitest run tests/xtool.test.ts` → FAIL (the text names only libfuse2).
- [ ] **Step 3: Implement** the text and the two doc lines.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests README.md docs/how-it-works.md && npm run scan:private && git commit -m "fix: name libfuse2t64 in the FUSE hint"`

### Task 2: Name upstream sign-in failures

Plan note (row 3, accept): xtool may reword an error, and then that error passes through unchanged, as today. The fixtures pin today's texts.

**Files:**
- Create: `src/tools/xtoolErrors.ts`; fixtures `tests/fixtures/xtool-errors/{gsa-503,anisette-deadline,connect-timeout}.txt`
- Modify: `src/tools/exec.ts` (`runKeepingStderr`), `src/commands/auth.ts`
- Test: `tests/xtoolErrors.test.ts`, `tests/auth.test.ts`, `tests/exec.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/tools/exec.ts — stdin and stdout on the terminal, stderr shown live and kept; rejects with execa's error (.stderr set)
  export async function runKeepingStderr(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; nice?: boolean }): Promise<void>;
  // src/tools/xtoolErrors.ts
  export type XtoolFailureId = "gsa-503" | "anisette-deadline" | "connect-timeout" | "login-interrupted";   // Task 3 adds "app-id-limit"
  export function explainXtoolOutput(output: string): { id: XtoolFailureId; message: string } | undefined;
  //   gsa-503: /GsService2\S*\s+failed:\s+HTTP 503\b/; anisette-deadline: /HTTPClientError\.deadlineExceeded\b/;
  //   connect-timeout: /HTTPClientError\.connectTimeout\b/. The first match in that order wins.
  export function explainXtoolError(e: unknown, opts?: { login?: boolean }): Error | undefined;
  //   reads `${e.stderr}\n${e.stdout}` (strings only); with login, signal "SIGINT" or exitCode 130 → login-interrupted
  export async function explainingXtool<T>(fn: () => Promise<T>, opts?: { login?: boolean }): Promise<T>;
  //   rethrows explainXtoolError's Error, else the original error object
  // src/commands/auth.ts: AuthDeps.runner defaults to runKeepingStderr. For `auth login`, a no-op SIGINT listener is
  //   installed while the runner runs (Ctrl+C reaches xtool, not rn-xtool) and removed in `finally`.
  ```
- Fixtures (verbatim from xtool issues #404, #401 and #414):
  - `gsa-503.txt`: `Logging in...` then `Error: POST https://gsa.apple.com/grandslam/GsService2 failed: HTTP 503. Details:` and the seven-line nginx page from #404 (`<html>` … `</html>`, with `<hr><center>Apple</center>`).
  - `anisette-deadline.txt`: `Logging in...` / `Error: HTTPClientError.deadlineExceeded`.
  - `connect-timeout.txt`: `Logging in...` / `Code: ******` / `Error: HTTPClientError.connectTimeout`.
- Messages (verbatim):
  - gsa-503: ``Apple's sign-in service answered HTTP 503 (Service Temporarily Unavailable): Apple refused the request before it checked your Apple ID, so this is on Apple's side, not your project or your password. xtool 1.24.0 fixed one cause of it: `rn-xtool doctor` shows whether your xtool is the version rn-xtool pins, and `rn-xtool setup` installs it. Then try again later. Details: https://github.com/xtool-org/xtool/issues/404``
  - anisette-deadline: `The anisette server xtool signs in through did not answer in time (HTTPClientError.deadlineExceeded). This is on the anisette server's side, not your project or your Apple ID; it has been down before and came back on its own. Try again later. Details: https://github.com/xtool-org/xtool/issues/401`
  - connect-timeout: `A connection xtool needs to sign in timed out (HTTPClientError.connectTimeout): Apple's sign-in server (gsa.apple.com) stalls now and then on some networks, and an unreachable anisette server fails the same way. Neither is your project or your Apple ID. Run the command again; a sign-in may need a new verification code. Details: https://github.com/xtool-org/xtool/issues/414 and https://github.com/xtool-org/xtool/issues/401`
  - login-interrupted: ``Sign-in was interrupted. If the verification code never arrived on your trusted devices, that is a known problem between xtool and Apple's sign-in, not your project. It went away for others after they turned off Advanced Data Protection for the Apple ID (on the iPhone: Settings → your name → iCloud → Advanced Data Protection). Then run `rn-xtool auth login` again. Details: https://github.com/xtool-org/xtool/issues/407``

- [ ] **Step 1: Write the fixtures and failing tests:**
  - xtoolErrors.test `names each pinned sign-in failure` → `it.each` over the three fixtures → `id` and the exact `message`.
  - `passes unknown output through unchanged` → `Error: something new`, and `failed: HTTP 503` from `developerservices2.apple.com` → `undefined`. `explainingXtool` rejects with the same error object (`toBe`).
  - `an interrupted login gets the verification-code hint` → `{ signal: "SIGINT" }` and `{ exitCode: 130 }` with `login: true` → login-interrupted. Without `login` → `undefined`.
  - exec.test `tees only stderr` → a script `echo out; echo 'Error: x' >&2; exit 1` → `runKeepingStderr` rejects, `.stderr` contains `Error: x` and `.stdout` is `undefined`.
  - auth.test `explains a known failure` → a runner rejecting with `{ stderr: <gsa-503 fixture>, exitCode: 1 }` → `auth` rejects with the gsa-503 message. `rethrows an unknown failure as is` → same object.
  - auth.test `removes its SIGINT guard after login` → inside the runner, `process.listenerCount("SIGINT")` is one more than before. After `auth` settles (resolved and rejected), it is back. For `["status"]`, no listener is added.
- [ ] **Step 2: Run** `npx vitest run tests/xtoolErrors.test.ts tests/auth.test.ts tests/exec.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `runKeepingStderr` (`stdin: "inherit"`, `stdout: "inherit"`, `stderr: ["inherit", "pipe"]`), the module and the auth wiring.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: explain known Apple sign-in failures"`

### Task 3: Explain the free App ID limit

**Files:**
- Create: `src/docs.ts`; fixture `tests/fixtures/xtool-errors/app-id-limit.txt`
- Modify: `src/tools/xtoolErrors.ts`, `src/tools/xtool.ts` (`devRun`'s default runner → `runKeepingStderr`), `src/commands/install.ts`
- Test: `tests/xtoolErrors.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Consumes: `explainingXtool`, `runKeepingStderr` (Task 2).
- Produces:
  ```ts
  // src/docs.ts
  export const TROUBLESHOOTING_URL = "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md";
  export function troubleshootingUrl(anchor: string): string;   // `${TROUBLESHOOTING_URL}#${anchor}`
  // xtoolErrors: XtoolFailureId gains "app-id-limit", matched first: /maximum App ID limit has been reached/i.
  //   n and days come from /up to (\d+) App IDs every (\d+) days/i, else 10 and 7.
  // install: the devRun call (USB) and the devBuildIpa call (--network) run inside explainingXtool.
  ```
- Fixture: a real dump, with its request id replaced by zeros. One line: `Error: Unexpected response, expected status code: created, response: conflict(DeveloperAPI.Operations.BundleIdsCreateInstance.Output.Conflict(body: DeveloperAPI.Operations.BundleIdsCreateInstance.Output.Conflict.Body.json(DeveloperAPI.Components.Schemas.ErrorResponse(errors: Optional([DeveloperAPI.Components.Schemas.ErrorResponse.ErrorsPayloadPayload(id: Optional("00000000-0000-0000-0000-000000000000"), status: "409", code: "ENTITY_ERROR", title: "There is a problem with the request entity", detail: "Your maximum App ID limit has been reached. You may create up to 10 App IDs every 7 days.", source: nil, links: nil, meta: nil)])))))`
- Message (verbatim): ``Apple refused to register another App ID: a free Apple ID can register ${n} App IDs per ${days} days, and each new bundle identifier takes one. Reuse a bundle identifier that is already installed on your iPhone, without the XTL-<Team ID>. prefix xtool adds: set it as ios.bundleIdentifier in the Expo app config, or as PRODUCT_BUNDLE_IDENTIFIER of the app target in a bare project, then run `rn-xtool build` and `rn-xtool install` again. Or wait until the oldest of those App IDs is ${days} days old. See ${troubleshootingUrl("app-id-limit")}``

- [ ] **Step 1: Write the fixture and failing tests:**
  - xtoolErrors.test `explains the free App ID limit` → the fixture gives `app-id-limit` and the message with 10 and 7. A copy reading `up to 12 App IDs every 5 days` gives 12 and 5. `maximum App ID limit has been reached.` alone gives 10 and 7.
  - install.test `explains the App ID limit from xtool dev run` → `devRun` rejects with `{ stderr: <fixture>, exitCode: 1 }` → install rejects with the message; `writeState` is not called.
  - install.test `explains it over Wi‑Fi too` → `devBuildIpa` rejects with `{ stdout: <fixture> }` → the same message.
  - install.test `rethrows an unknown xtool failure as is` → same object.
- [ ] **Step 2: Run** `npx vitest run tests/xtoolErrors.test.ts tests/install.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/docs.ts`, the pattern and the install wiring.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: explain the free App ID limit"`

### Task 4: Libraries rn-xtool cannot scaffold

Plan note (row 2, accept): a library with some other unsupported shape still passes the check and fails in the build, as today. The list grows from reports.

**Files:**
- Create: `src/project/earlyChecks.ts`
- Modify: `src/project/capabilities.ts` (export `dependencyDirs` and `podspecFiles`; `podspecFeatures` reads through them, unchanged in behaviour)
- Test: `tests/earlyChecks.test.ts`

**Interfaces:**
- Consumes: `troubleshootingUrl` (Task 3); vendored `podspec.js` `sourceFacts(text).referencesVendor` and `classify.js` `walkSourceTree(dir).files`, loaded with `createRequire` from `vendor/expo-spm/spm/` (the rule the plugin's `sourceLayout` refuses with `vendored-sources`).
- Produces:
  ```ts
  // src/project/capabilities.ts
  export function dependencyDirs(root: string): { name: string; dir: string }[];   // package.json dependencies, react-native left out, resolved as today, sorted
  export function podspecFiles(dir: string): string[];   // root, ios/ and expo-module.config.json's podspecPath, as podspecTexts reads them
  // src/project/earlyChecks.ts
  export type EarlyCheckId = "vendored-binaries" | "vendored-sources" | "pnpm" | "yarn-pnp" | "hoisted";
  export interface EarlyFailure { id: EarlyCheckId; reason: string }
  export function libraryFailures(root: string): EarlyFailure[];   // never throws; [] without a readable package.json
  ```
- Rules, for each `dependencyDirs` entry with at least one podspec:
  - **Own manifest:** `<dir>/Package.swift` or `<dir>/ios/Package.swift` whose text contains neither `AUTO-SCAFFOLDED by react-native spm scaffold` nor `AUTO-GENERATED by scripts/generate-spm-autolinking.js`.
  - **Expo module:** `<dir>/expo-module.config.json` whose `platforms` include `apple` or `ios`.
  - **vendored-binaries:** not an Expo module, no own manifest, and `swiftpmConfig.scaffold` in package.json is not `false`. Fires when a podspec (comment lines dropped) sets `vendored_frameworks?` or `vendored_librar(y|ies)` as an attribute (the `attribute()` regex of capabilities.ts).
  - **vendored-sources:** an Expo module without `<dir>/Package.swift`, without `prebuilds/output/{debug,release}/xcframeworks/*.tar.gz`, with a podspec whose `sourceFacts(text).referencesVendor` is true, and with C-family files (`/\.(m|mm|c|cpp|cc)$/`) in `walkSourceTree(<dir>/vendor)`.
- Reasons (verbatim). `${version}` is the package.json version or `unknown`. `${podspec}` is relative to `<dir>`. `${attrs}` is `vendored_frameworks`, `vendored_libraries` or `vendored_frameworks and vendored_libraries`. `${files}` lists the sorted `vendor/…` paths, the first three joined with `, `, plus ` and ${k} more`.
  - vendored-binaries: `${name} ${version}: its podspec (${podspec}) declares ${attrs} and the package ships no Package.swift, so rn-xtool would have to scaffold it, and it cannot link prebuilt binaries yet. See ${troubleshootingUrl("libraries-with-prebuilt-binaries")}`
  - vendored-sources: `${name} ${version}: its podspec (${podspec}) builds C sources from vendor/ (${files}) and the package ships no Package.swift; rn-xtool cannot build vendored C sources yet. See ${troubleshootingUrl("libraries-that-build-vendored-c-sources")}`

- [ ] **Step 1: Write failing tests** in `tests/earlyChecks.test.ts`, on temp projects built by a local helper `project(deps: Record<string, Record<string, string>>)` (files per package under `node_modules/<name>`):
  - `refuses a CocoaPods-only library with prebuilt binaries` → `@react-native-async-storage/async-storage` 3.1.1 with `AsyncStorage.podspec` holding `s.ios.vendored_frameworks = "apple-frameworks/SharedAsyncStorage.xcframework"` → one failure, reason exactly `@react-native-async-storage/async-storage 3.1.1: its podspec (AsyncStorage.podspec) declares vendored_frameworks and the package ships no Package.swift, so rn-xtool would have to scaffold it, and it cannot link prebuilt binaries yet. See https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#libraries-with-prebuilt-binaries`.
  - `names vendored libraries too` → `s.vendored_libraries = "libfoo.a"` plus `s.vendored_frameworks = "Foo.xcframework"` → `declares vendored_frameworks and vendored_libraries`.
  - `never fires on Expo modules` (Review Focus 2) → an expo-router-shaped module (`expo-module.config.json` with `"platforms": ["apple", "android"]`, `ios/ExpoRouter.podspec` with `s.vendored_frameworks = …`) → `[]`.
  - `skips libraries that manage themselves` → a root `Package.swift`; an `ios/Package.swift` without markers; `"swiftpmConfig": { "scaffold": false }`; a commented `# s.vendored_frameworks`; a devDependency; a listed but missing package → each `[]`.
  - `a Package.swift rn-xtool scaffolded still counts as none` (Review Focus 1) → a root `Package.swift` starting `// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.` → the failure is reported.
  - `refuses an Expo module that builds vendored C sources` → expo-sqlite 58.0.14: `expo-module.config.json` with `"platforms": ["apple", "android", "devtools"]`, `ios/ExpoSQLite.podspec` holding `source = File.join(__dir__, '..', 'vendor', vendor_src, file)` and `s.source_files = "**/*.{c,h,m,swift}"`, plus `vendor/sqlite3/sqlite3.c`, `vendor/sqlcipher/sqlite3.c` and their `.h` files → reason exactly `expo-sqlite 58.0.14: its podspec (ios/ExpoSQLite.podspec) builds C sources from vendor/ (vendor/sqlcipher/sqlite3.c, vendor/sqlite3/sqlite3.c) and the package ships no Package.swift; rn-xtool cannot build vendored C sources yet. See https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#libraries-that-build-vendored-c-sources`. Five `.c` files → `…, vendor/c.c and 2 more`.
  - `lets a precompiled or self-managed vendored-C module through` → the same with `prebuilds/output/{debug,release}/xcframeworks/ExpoSQLite.tar.gz`, or with a root `Package.swift` → `[]`.
  - `never throws on a broken project` → no package.json, invalid JSON, an unreadable podspec → `[]`.
- [ ] **Step 2: Run** `npx vitest run tests/earlyChecks.test.ts tests/capabilities.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the two exports in capabilities.ts and `libraryFailures`.
- [ ] **Step 4: Run** the same tests, then `npm test && npm run lint` → PASS (`podspecFeatures` tests unchanged).
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: detect libraries rn-xtool cannot scaffold"`

### Task 5: Installs rn-xtool cannot read

Plan note (row 2, accept): an install layout not listed here passes and fails later, as today.

**Files:**
- Modify: `src/project/earlyChecks.ts`
- Test: `tests/earlyChecks.test.ts`

**Interfaces:**
- Consumes: `EarlyFailure`, `libraryFailures` (Task 4).
- Produces:
  ```ts
  export function installFailures(root: string): EarlyFailure[];   // pnpm, yarn-pnp, hoisted, in that order; never throws
  export function earlyFailures(root: string): EarlyFailure[];     // [...installFailures(root), ...libraryFailures(root)]
  ```
- Rules (`up` means the root, then each parent folder up to `/`):
  - **pnpm:** the nearest `pnpm-lock.yaml` up from the root, and a `node_modules/.pnpm` directory in the root or next to that lockfile.
  - **yarn-pnp:** the nearest `.pnp.cjs` or `.pnp.js` up from the root, and no `<root>/node_modules/react-native/package.json`.
  - **hoisted:** for `react-native` and `expo`, when listed in the root package.json `dependencies` or `devDependencies`, take the first folder of `createRequire(<root>/package.json).resolve.paths(pkg)` that holds `<pkg>/package.json`. The check fires when that folder is not `<root>/node_modules`. Symlinks are not followed. A package found nowhere is left to the existing errors.
- Reasons (verbatim; `${lock}`, `${pnp}` and `${rel}` are relative to the root, e.g. `pnpm-lock.yaml`, `../../node_modules/react-native`):
  - pnpm: `This project was installed with pnpm (${lock} and a node_modules/.pnpm store); rn-xtool needs the flat node_modules that npm or Yarn classic installs. Remove node_modules and install with npm. See ${troubleshootingUrl("pnpm-and-yarn-pnp")}`
  - yarn-pnp: `This project uses Yarn Plug'n'Play (${pnp}); rn-xtool needs a node_modules folder. Add nodeLinker: node-modules to .yarnrc.yml and run yarn install. See ${troubleshootingUrl("pnpm-and-yarn-pnp")}`
  - hoisted: `${pkg} is installed in ${rel}, outside this project: a workspace hoisted it to a parent folder, and rn-xtool patches and builds only the project's own node_modules/${pkg}. Install the app outside the workspace, or keep ${pkg} in the app's node_modules (for example with nohoist). See ${troubleshootingUrl("packages-hoisted-to-a-parent-folder")}`

- [ ] **Step 1: Write failing tests:**
  - `refuses a pnpm install` → `pnpm-lock.yaml` and `node_modules/.pnpm/` in the root → the pnpm reason with `pnpm-lock.yaml`. A workspace with the lockfile and store two folders up → `../../pnpm-lock.yaml`.
  - `a stray lockfile without a .pnpm store does not fire` (Review Focus 3) → `pnpm-lock.yaml` in a parent and an npm `node_modules` in the root → `[]`.
  - `refuses Yarn PnP` → `.pnp.cjs` without node_modules → the yarn-pnp reason with `.pnp.cjs`. A parent `.pnp.cjs` with the root's own `node_modules/react-native` → `[]`.
  - `refuses react-native hoisted to a parent folder` → `<ws>/node_modules/react-native/package.json`, app at `<ws>/apps/demo` listing react-native, no local copy → reason with `../../node_modules/react-native`. Same for `expo` from devDependencies.
  - `a symlinked react-native in node_modules is not hoisted` (Review Focus 3) → `<root>/node_modules/react-native` links to a folder outside → `[]`.
  - `orders install failures before library failures` → pnpm plus an async-storage fixture → ids `["pnpm", "vendored-binaries"]`.
  - `fires on none of the reference apps (needs ../app-expo-57, ../app, ../app-bare, ../app-bare-086 and ../app-bare-087)` (row 1) → `describe.skipIf` unless all five exist next to the repo → `earlyFailures(app)` is `[]` for each.
- [ ] **Step 2: Run** `npx vitest run tests/earlyChecks.test.ts` → FAIL.
- [ ] **Step 3: Implement** `installFailures` and `earlyFailures`.
- [ ] **Step 4: Run** the test file (the reference-app block runs on this machine), then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: detect pnpm, Yarn PnP and hoisted installs"`

### Task 6: Stop early in `doctor --project` and `build`

**Files:**
- Modify: `src/project/earlyChecks.ts`, `src/project/capabilities.ts` (`limits`), `src/commands/doctor.ts` (`capabilityChecks`), `src/commands/build.ts`
- Test: `tests/doctor.test.ts`, `tests/build.test.ts`, `tests/capabilities.test.ts`

**Interfaces:**
- Consumes: `earlyFailures`, `EarlyFailure` (Task 5).
- Produces:
  ```ts
  export class UnsupportedSetupError extends Error { readonly failures: readonly EarlyFailure[] }   // name "UnsupportedSetupError"
  //   message: one failure → its reason; several → "rn-xtool cannot build this project yet:\n" + failures.map((f) => `- ${f.reason}`).join("\n")
  // Capabilities gains `limits?: EarlyFailure[]`; detectCapabilities always sets it (earlyFailures(root)).
  // capabilityChecks: when c.limits is defined, after podspecs, one `known-limits` line:
  //   [] → ok: "none of the setups rn-xtool refuses early (CocoaPods-only libraries with prebuilt binaries or vendored C sources, pnpm, Yarn PnP, hoisted packages)"
  //   else one `known-limits` fail line per failure, detail = its reason
  // BuildDeps gains earlyFailures: (root: string) => EarlyFailure[] (realDeps: earlyFailures). build calls it right after
  //   loadConfig and throws UnsupportedSetupError before readProject when it returns any.
  ```

- [ ] **Step 1: Write failing tests:**
  - capabilities.test `carries the early failures` → an async-storage fixture → `limits` has one `vendored-binaries`; a clean SDK 58 fixture → `limits: []`.
  - doctor.test `--project names each known limit` → capabilities with two limits → two `known-limits` fail lines, each with its reason; `ok` false. With `limits: []` → one ok line with the text above. Without `limits` → no `known-limits` line (the existing `skips the toolchain…` name list stays as it is).
  - build.test `stops before reading the project on a known unsupported setup` → `earlyFailures` returns one failure → rejects with an `UnsupportedSetupError` whose message is exactly the reason. `readProject`, `prebuild` and `applyPatches` are not called, and no `▸` line is logged. Two failures → the message is exactly `rn-xtool cannot build this project yet:\n- <r1>\n- <r2>`.
  - build.test `builds as before without known limits` → `earlyFailures: () => []` → the existing steps.
  - Real-dir doctor tests that list `--project` names get `known-limits` last.
- [ ] **Step 2: Run** `npx vitest run tests/doctor.test.ts tests/build.test.ts tests/capabilities.test.ts` → FAIL.
- [ ] **Step 3: Implement** the error, `limits`, the doctor line and the build check.
- [ ] **Step 4: Run** `npm test && npm run lint` (the drift tests included: their gates step runs `doctor --project`) → PASS. Then `npm run build && (cd ../app-bare && node ../expo-xtool-w1/bin/rn-xtool.js doctor --project)` prints `✔ known-limits — none of the setups …` and exits 0 (read only).
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: stop early on known unsupported setups"`

### Task 7: `doctor --report`

**Files:**
- Create: `src/commands/report.ts`
- Modify: `src/commands/doctor.ts` (`withCapabilities`, `DoctorReport.capabilities`), `src/cli.ts`
- Test: `tests/report.test.ts`, `tests/doctor.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `doctorWithProbes`, `realProbes`, `renderReport`, `DoctorProbes`, `Capabilities`, `packageRoot`.
- Produces:
  ```ts
  // src/commands/doctor.ts
  //   DoctorReport gains capabilities?: Capabilities (set whenever the probe ran);
  //   doctorWithProbes opts gains withCapabilities?: boolean — full mode with a root appends capabilityChecks after the last check.
  // src/commands/report.ts
  export interface SeenValues { appleIds: string[]; teamIds: string[]; udids: string[]; deviceNames: string[]; ips: string[] }
  export function recordingProbes(p: DoctorProbes, seen: SeenValues): DoctorProbes;
  //   records authStatus (appleId, teamId), devices (udid, name), wifi (usb.udid, lastIp), lanRoute (ip), configLanIp,
  //   buildState (lanIp); results pass through unchanged
  export function redact(text: string, ctx: { home: string; seen: SeenValues }): string;
  //   1. seen values, longest first, to their placeholders (apple IDs <apple-id>, team IDs <team-id>, udids <udid>,
  //      device names <device>, ips <ip>); 2. /\bXTL-[A-Z0-9]{10}\./ removed; 3. e-mail → <email>;
  //   4. UDIDs ([0-9A-F]{8}-[0-9A-F]{16}, 40 hex) → <udid>; 5. IPv4 and IPv6 → <ip>; 6. tokens (gh[pousr]_…, JWTs,
  //      Bearer …, token=/password=/secret= values, base64 runs of 32+ with upper and lower case) → <token>;
  //   7. ctx.home, then any other user folder directly under the home root → ~
  export interface ReportEnv { rnXtoolVersion: string; os: string; arch: string; home: string }
  export function realReportEnv(): ReportEnv;   // os: PRETTY_NAME of /etc/os-release (else "Linux") + `, Linux ${os.release()}`
  export function renderIssueReport(r: DoctorReport, env: ReportEnv, opts: { projectOnly: boolean; nodeVersion: string; inProject: boolean }): string;
  export const REVIEW_LINE: string;   // verbatim below
  export async function doctorReport(root: string | undefined, opts?: { projectOnly?: boolean; probes?: DoctorProbes; env?: ReportEnv }): Promise<string>;
  //   runs doctorWithProbes(recordingProbes(probes ?? realProbes(config), seen), root, { projectOnly, withCapabilities: true }),
  //   config loaded as doctor() does; returns redact(renderIssueReport(...)) + "\n" + REVIEW_LINE
  // cli: doctor gains .option("--report", "print a redacted report to paste into a GitHub issue"); with --report it
  //   prints doctorReport(root, { projectOnly }) and exits 0 whatever the checks say. Root as today.
  ```
- Block (verbatim, one line each, inside a ```` ```text ```` fence):
  - `rn-xtool doctor --report`
  - `rn-xtool: ${env.rnXtoolVersion}` and `node: ${nodeVersion}`
  - `swift: <swift detail>` and `xtool: <xtool detail>`, or `not checked (--project)`
  - `os: ${env.os}, ${env.arch}`
  - `project: ` + `[kind, "Expo SDK <sdk>", "expo <v>", "react-native <v>"]` present parts joined with `, `. Without a root: `none (run it in the project folder)`.
  - then `renderReport(r.checks)`.
- `REVIEW_LINE`: `Read the report before you post it: rn-xtool replaced your home folder, Apple ID, Team ID, bundle identifiers, device names and UDIDs, IP and MAC addresses and tokens with placeholders. Remove anything else you consider private.`

- [ ] **Step 1: Write failing tests** in `tests/report.test.ts`:
  - `redacts planted values everywhere in the report` (row 6, Review Focus 5). Probes return:
    - Apple ID `jane.doe@example.com` and Team ID `Q7X9K2M4P1`;
    - device `Jane Doe's iPhone`, UDID `00008110-000000001A2B3C4D`;
    - wifi `lastIp` `192.168.50.77`, lanRoute `192.168.50.23`, buildState lanIp `10.0.0.12`;
    - a `project` rejection: `cannot read /home/me/apps/demo: XTL-Q7X9K2M4P1.com.example.demo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 fe80::1c2b:3a4d:5e6f:7a8b a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 mail ops@example.org`.

    `env.home` is `/home/me`. None of these survives: `jane.doe@example.com`, `Q7X9K2M4P1`, `Jane Doe's iPhone`, `00008110-000000001A2B3C4D`, the three IPs, `/home/me`, `ghp_`, `fe80::`, the 40-hex string, `ops@example.org`. The output contains `~/apps/demo`, `com.example.demo`, `<apple-id>`, `<team-id>`, `<udid>`, `<device>`, `<ip>` and `<token>`.
  - `keeps versions and hashes` → `redact("node 22.12.0, xtool 1.24.0, sha256 " + 64 lowercase hex, …)` is unchanged; `12:34` is unchanged.
  - `renders one paste-ready block` → fixed probes and env → the exact lines above in order, with the fence and the REVIEW_LINE last.
  - `reports without a project or a login` → root undefined, logged out, no device → `project: none (run it in the project folder)`; nothing throws.
  - doctor.test `withCapabilities appends the capability lines` → full mode with a root → the plain names, then `versions` … `podspecs`; `r.capabilities` is set.
  - cli.test `doctor has --report` → the option list is `[--project …, ["--report", "print a redacted report to paste into a GitHub issue"]]`. `--report prints the report and exits 0` → mocked `doctorReport` called with `(undefined, { projectOnly: false })`; `process.exitCode` not 1.
- [ ] **Step 2: Run** `npx vitest run tests/report.test.ts tests/doctor.test.ts tests/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module, the doctor options and the flag.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS. `npm run build && (cd ../app && node ../expo-xtool-w1/bin/rn-xtool.js doctor --report --project)` prints one block (read only).
- [ ] **Step 5: Commit** `git add src tests && npm run scan:private && git commit -m "feat: add doctor --report with redaction"`

### Task 8: Issue templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/library.yml`, `.github/ISSUE_TEMPLATE/config.yml`
- Modify: `package.json`, `package-lock.json` (`npm install --save-dev yaml@^2.9.1`)
- Test: `tests/issueTemplates.test.ts`

**Interfaces:**
- Consumes: `REVIEW_LINE` wording (Task 7).
- Template content (verbatim values):
  - `bug.yml`: `name: Bug report`, `description: rn-xtool fails or does something unexpected`, `labels: ["bug"]`. Body:
    1. markdown: ``Run `rn-xtool doctor --report` in your project folder and paste its whole output below. rn-xtool replaces your home folder, Apple ID, Team ID, bundle identifiers, device names and UDIDs, IP and MAC addresses and tokens with placeholders. Read it before you post: remove anything else you consider private.``
    2. textarea `report`, label `Output of rn-xtool doctor --report`, required.
    3. input `command`, label `Command you ran`, placeholder `rn-xtool build`, required.
    4. textarea `expected`, label `What you expected`, required.
    5. textarea `actual`, label `What happened instead`, description `The error and the last lines of output. Remove anything private.`, required.
    6. checkboxes `reviewed`, label `Privacy`, one required option `I read the report and the output above and removed anything private.`
  - `library.yml`: `name: My library does not build`, `description: A React Native or Expo library fails to build or run with rn-xtool`, `labels: ["library"]`. Body: the same markdown, then:
    - input `library`, label `Library (npm name)`, placeholder `@react-native-async-storage/async-storage`, required;
    - input `version`, label `Library version`, placeholder `3.1.1`, required;
    - textarea `report`, required;
    - textarea `actual`, label `What happens`, description `The error and the last lines of output. Remove anything private.`, required;
    - checkboxes `reviewed`, as in bug.yml.
  - `config.yml`: `blank_issues_enabled: false`.

- [ ] **Step 1: Write the failing test** `tests/issueTemplates.test.ts`, parsing with `yaml`'s `parse`:
  - `every template parses and has a name, a description and a body`;
  - `the bug template requires the report, the command and both results` → required ids are exactly `["report", "command", "expected", "actual", "reviewed"]`;
  - `the library template requires the library, its version and the report` → required ids `["library", "version", "report", "actual", "reviewed"]`;
  - `both tell the user to review the report` → the markdown contains `rn-xtool doctor --report` and `Read it before you post`;
  - `blank issues are off` → `config.blank_issues_enabled === false`.
- [ ] **Step 2: Run** `npx vitest run tests/issueTemplates.test.ts` → FAIL (files missing).
- [ ] **Step 3: Write** the three files and add the devDependency.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add .github package.json package-lock.json tests && npm run scan:private && git commit -m "chore: add issue templates"`

### Task 9: Pinned tarballs instead of the private app

Plan note (row 7, accept): a registry failure is retried once, then the fetch exits 1 and the PR check is red until it is re-run.

**Files:**
- Create:
  - `tests/tarballs.json`;
  - `scripts/fetch-test-tarballs.mjs` (exports its functions; runs only as main);
  - `scripts/ci-skipped.mjs` (same);
  - `tests/support/tarballs.ts`;
  - `tests/patches-upstream.test.ts`, `tests/tarballs.test.ts`, `tests/ciSkipped.test.ts`.
- Modify:
  - `tests/expo-plugin.test.ts`: the `committed Expo patch` block is removed; `SPM` becomes `patchedSpm("expo@58.0.21")`; the ExpoImagePicker e2e keeps `../app`.
  - `tests/rn-scaffolder.test.ts`: `SPM` becomes `patchedSpm("react-native@0.88.1")`; the reverse-apply tests are removed; the RNGH, Screens and SVG podspecs come from `packageFromTarball`.
  - `tests/vendor-rn-spm.test.ts` and `tests/support/expoSpm.ts`: the fetch hint becomes `node scripts/fetch-test-tarballs.mjs`.
  - These titles end with what they need: the reference-app block of `tests/scriptsShape.test.ts` (`(needs ../app-bare-086, ../app-bare-087 and ../app-bare)`), `autolinking 58.0.15 on SDK 57 (needs ../app-expo-57)`, the ExpoImagePicker e2e (`(needs ../app and RN_XTOOL_E2E=1)`) and `scaffolds the reference app's libraries as the golden (needs ../app)`.

**Interfaces:**
- Produces:
  ```ts
  // tests/tarballs.json: [{ "spec": "<name>@<version>", "file": "<npm pack file name>", "integrity": "sha512-…" }], entries below
  // scripts/fetch-test-tarballs.mjs
  export function integrityOf(bytes: Uint8Array): string;   // "sha512-" + base64
  export async function fetchAll(entries, deps: { dir: string; pack: (spec: string, dir: string) => Promise<void>; log: (s: string) => void }): Promise<void>;
  //   present with the right integrity → skipped; otherwise pack, once more on failure, then verify; throws
  //   `npm pack ${spec} failed twice: ${message}` or `${file}: integrity ${actual}, expected ${integrity}`
  //   main: dir tests/.cache, pack = `npm pack <spec> --pack-destination <dir>`; exit 1 with the message
  // scripts/ci-skipped.mjs
  export function skippedTests(report: unknown, root: string): string[];   // "tests/x.test.ts › describe › title" for every
  //   assertion whose status is skipped, pending or todo, in file then report order
  export function skippedSummary(names: string[] | undefined): string;
  //   [] → "### Skipped tests\n\nNone: every test ran.\n"; n → `### Skipped tests (${n})\n\nThese did not run here; each title says what it needs.\n\n` + "- `<name>`\n" per test;
  //   undefined (no report) → "### Skipped tests\n\nNo test report: the test step did not finish.\n"
  //   main: `node scripts/ci-skipped.mjs <report.json>` prints the summary and exits 0
  // tests/support/tarballs.ts
  export const FETCH_HINT = "run: node scripts/fetch-test-tarballs.mjs";
  export function tarballPath(spec: string): string | undefined;   // the cached file when present with the manifest's integrity
  export function packageFromTarball(spec: string): string | undefined;   // extracted once per run into <tmp>/node_modules/<name>; returns that dir
  export function patchedSpm(spec: "expo@58.0.21" | "react-native@0.88.1"): string | undefined;
  //   packageFromTarball, then patches/<name>+<version>.patch applied with patch -p1 -F0 at <tmp>; returns <pkg>/scripts/spm.
  //   expo gets a node_modules symlink to rn-xtool's, as shared58Spm does
  ```
- `tests/tarballs.json` entries (integrity from `npm view <spec> dist.integrity`, verbatim):
  - `expo@58.0.19` `sha512-+MHH9Bu7OFWsAl8Ox44KgqbVIe72xbxzAi3vLPtVf14o5zHE39iCD//uw/4nyBlqZii6cFUZsvtJDbeRo5OhMA==`
  - `expo@58.0.21` `sha512-2Q8jp0fKLrDMou4aKWZ5V2cCVfcwOScuV8GBMkogiXIv7bCwwN4CIkUIq5QsX7DHXJxbruXLTXEgrp6J+iF4YA==`
  - `react-native@0.88.0` `sha512-v/wee0nYWcammMYBnSat/e3WY/5iaf9YQOMcBrfKT/wPApPPlHp94hgZovBtwhMuthR01yc/8cGn0FpFTE/C4A==`
  - `react-native@0.88.1` `sha512-wajWcLZ93GCN7k4Uwh4CS4L2Ah8ohcvkOXnvIYmh4Yvuqho5j3APZ9qozK+nQrHWSgauq4h8D3HN5DKK84SrHA==`
  - `expo-modules-autolinking@58.0.16` `sha512-YglXoBBc3QwqqFfFQD1XVfpxXdF9RkuZOVxWTn5uHPiyvXSMFiVO16GnV+VSd+njKld1EJt7vQucCsDiLp4xVA==`
  - `expo-modules-jsi@57.1.3` `sha512-pwVO1gvObX2tpIjfJzGn86yBOmOBhMLxAD81n2SHnfZk6lvbbqQhag64MHEeh29E/8vg23/Dzmf3JTmJSwbQYQ==`
  - `expo-modules-jsi@58.0.21` `sha512-6FG3jKt89s+qolbalas+OE5gQjDYu/sfV7HVAFEw3JVtkS1+MVfCvQLxp3RAm85bVNO0vgfnbn5z6A8WSDWalA==`
  - `react-native-gesture-handler@3.4.0` `sha512-jBg4ZWDvegeaZ4OHq9oxVOS/Qa6pV+LhtsUExothyhWxqzG0Lkg7kl2ztemPj/pnJxkq9j/+6wAw3jZGwdssww==`
  - `react-native-screens@4.30.0` `sha512-FrZG/Q5gqoDu0SgP4d2Ly0qdio5DR1KdGPEYImhkz7tmrhpML4C39m6RYLGd5TVLHZwcCh8NPvW9rylevjD0uQ==`
  - `react-native-svg@15.16.0` `sha512-uh8yktufYeRU3W9Omi8+SPyLF9BVN4JmLflSgc9oOcKkSKk/S5JUmmTjKZq/L8GHfQUtCvcu/W6X4xhEfBBAjQ==`
- Every `require` of a patched copy happens inside a test or `beforeAll`, never while the file is collected. Without the cache the blocks skip with `FETCH_HINT` in their title; without `../app` nothing fails at import (today `expo-plugin.test.ts` and `rn-scaffolder.test.ts` crash).

- [ ] **Step 1: Write failing tests:**
  - patches-upstream.test `every bundled patch has a pinned tarball` → each `patches/*.patch` maps (`parsePatchFileName`) to a manifest spec.
  - patches-upstream.test `<file> applies to its pristine package` → one `it` per bundled patch: `patch -p1 -F0 --dry-run -d <tmp> -i <patch>` exits 0 on `packageFromTarball`'s tree.
  - tarballs.test `retries a failed pack once` → pack fails once, then writes the file → resolves and `pack` was called twice. Fails twice → rejects `npm pack expo@58.0.21 failed twice: …`. A wrong file → rejects with the integrity text. A good file present → `pack` not called.
  - tarballs.test `matches the provenance tests` → the 58.0.19 and 0.88.0 integrity values equal `EXPO_INTEGRITY` and vendor-rn-spm's `INTEGRITY`.
  - ciSkipped.test `lists skipped tests by name` → a vitest JSON fixture with one passed, two skipped and one todo test → three names, in file order, with relative paths. `skippedSummary` gives the three exact texts above.
- [ ] **Step 2: Run** `npx vitest run tests/patches-upstream.test.ts tests/tarballs.test.ts tests/ciSkipped.test.ts` → FAIL.
- [ ] **Step 3: Implement** the manifest, both scripts and the support module. Switch the two test files as listed under Files.
- [ ] **Step 4: Run** these checks:
  - `node scripts/fetch-test-tarballs.mjs` → fetches ten files; a second run fetches none;
  - `RN_XTOOL_REF_APP=/nonexistent RN_XTOOL_EXPO57_APP=/nonexistent npm test` → no failure; `vendor-*` provenance, `shared 58 copy`, `patched Expo SwiftPM plugin`, `patched RN SwiftPM scaffolder` and the three real-podspec tests run. If an SVG podspec test that never ran before now fails, stop and report it; do not change its expectation;
  - `t=$(mktemp -d) && mv tests/.cache "$t/" && npm test; mv "$t/.cache" tests/` → green with skips and no collection error;
  - `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add scripts tests && npm run scan:private && git commit -m "test: read patched upstream files from tarballs"`

### Task 10: CI on every PR

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore` (`test-results.json`)
- Test: `tests/ci/workflow.test.ts`

**Interfaces:**
- Consumes: `scripts/fetch-test-tarballs.mjs`, `scripts/ci-skipped.mjs` (Task 9).
- Workflow layout (one job `test`, `timeout-minutes: 20`):
  - Header comment: what it runs, and that tests needing a real app or device are skipped and listed in the summary.
  - `on: pull_request` and `push: branches: [main]`; top-level `permissions: contents: read`; no job-level permissions.
  - `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
  - Steps:
    1. `actions/checkout@v7` with `persist-credentials: false`;
    2. `actions/setup-node@v7` with `node-version: 22`, `cache: npm`;
    3. `npm ci`;
    4. `node scripts/fetch-test-tarballs.mjs`;
    5. `npm run lint`;
    6. `npm test -- --reporter=default --reporter=json --outputFile=test-results.json`;
    7. `List skipped tests` with `if: ${{ !cancelled() }}`, run `node scripts/ci-skipped.mjs test-results.json >> "$GITHUB_STEP_SUMMARY"`;
    8. `npm run scan:private` (generic patterns: CI has no `.scan-private.local`).

- [ ] **Step 1: Write the failing test** `tests/ci/workflow.test.ts`, reading the file as text and with `yaml`, in the style of `tests/drift/workflow.test.ts`:
  - `runs on PRs and on main` → triggers exactly `pull_request` and `push` with `branches: ["main"]`; no `schedule`, no `pull_request_target`.
  - `reads the repository only` → top-level `permissions` is `{ contents: "read" }`; no job has `permissions`.
  - `keeps credentials and secrets out` → every checkout has `persist-credentials: false`; no `secrets.`; no `GH_TOKEN`; no `${{` inside a `run:`.
  - `uses Node 22 and two actions` → `uses:` values ⊆ `actions/checkout@v7`, `actions/setup-node@v7`; `node-version: 22`; `runs-on: ubuntu-latest`.
  - `runs the steps in order` → the `run:` texts contain, in this order, `npm ci`, `node scripts/fetch-test-tarballs.mjs`, `npm run lint`, `npm test`, `node scripts/ci-skipped.mjs test-results.json`, `npm run scan:private`. The skipped step has `if: ${{ !cancelled() }}` and appends to `$GITHUB_STEP_SUMMARY`.
  - `never compiles or touches a device` → no `setup-swift`, `swiftly`, `rn-xtool setup`, `RN_XTOOL_E2E`.
- [ ] **Step 2: Run** `npx vitest run tests/ci/workflow.test.ts` → FAIL (file missing).
- [ ] **Step 3: Write** the workflow.
- [ ] **Step 4: Run** `npm test && npm run lint` → PASS. Then run steps 4–8 locally in order and check that `node scripts/ci-skipped.mjs test-results.json` lists the reference-app and device tests by name.
- [ ] **Step 5: Commit** `git add .github .gitignore tests && npm run scan:private && git commit -m "chore: run tests in CI on every PR"`

### Task 11: Pin xtool 1.24.0

**Files:**
- Modify: `src/versions.ts` (`XTOOL_VERSION`, `XTOOL_SHA256`, provenance comment), `README.md` (Quick start comment), `docs/how-it-works.md` (line 14), `docs/recipe.md` (line 12)
- Test: `tests/versions.test.ts`, `tests/setup.test.ts` (lines 40 and 88)

**Interfaces:**
- Produces: `XTOOL_VERSION = "1.24.0"`. `XTOOL_SHA256` holds the `sha256sum` of the official assets `xtool-x86_64.AppImage` (54135288 bytes) and `xtool-aarch64.AppImage` (52525576 bytes). Provenance comment: `Provenance: release 1.24.0 of xtool-org/xtool, assets xtool-x86_64.AppImage and xtool-aarch64.AppImage, downloaded <date> via \`gh release download\` and hashed with \`sha256sum\` (GitHub publishes no checksum).`

- [ ] **Step 1: Write failing tests:**
  - versions.test `pins xtool 1.24.0` → `XTOOL_VERSION === "1.24.0"`; both hashes match `/^[0-9a-f]{64}$/`; neither equals the 1.23.0 values (`270fb663…`, `649e8bdc…`).
  - setup.test → the URL `https://github.com/xtool-org/xtool/releases/download/1.24.0/xtool-x86_64.AppImage`, and `xtool 1.24.0` in the log assertion.
- [ ] **Step 2: Run** `npx vitest run tests/versions.test.ts tests/setup.test.ts` → FAIL.
- [ ] **Step 3: Get the hashes** from the official assets, in a new empty scratch directory outside the repo:
  ```bash
  d=$(mktemp -d)
  gh release download 1.24.0 -R xtool-org/xtool -p 'xtool-x86_64.AppImage' -p 'xtool-aarch64.AppImage' -D "$d"
  stat -c '%s %n' "$d"/*.AppImage   # 54135288 and 52525576, as `gh release view 1.24.0 --json assets` lists
  sha256sum "$d"/*.AppImage
  ```
  Copy the two hashes as printed. Never type or guess one. Delete `$d` afterwards.
- [ ] **Step 4: Implement** the constants, the comment and the three doc lines.
- [ ] **Step 5: Run** `npm test && npm run lint` → PASS.
- [ ] **Step 6: Commit** `git add src tests README.md docs && npm run scan:private && git commit -m "chore: pin xtool 1.24.0"`

### Task 12: Docs and changelog

**Files:**
- Modify:
  - `docs/troubleshooting.md`:
    - a new `## Unsupported setups` section: what `doctor --project` and `build` stop on early, and that other setups rn-xtool cannot build still fail during the build (row 2). Its subsections are `### Libraries with prebuilt binaries` (async-storage 3.x; Expo modules are not affected), `### Libraries that build vendored C sources` (expo-sqlite), `### pnpm and Yarn PnP` and `### Packages hoisted to a parent folder`, each with the reason's remedy;
    - under `## Device and signing`: `### Apple sign-in errors` (the four cases, their xtool issues, and that other errors are shown as xtool prints them, row 3) and `### App ID limit`;
    - `## Reporting a problem`: `rn-xtool doctor --report`, what it replaces, and to read it before posting.
  - `README.md`:
    - Commands: ``doctor [--project] [--report]`` and one sentence on `--report`;
    - Limits: the early refusals;
    - Contributing: tests read patched upstream files from pinned tarballs (`node scripts/fetch-test-tarballs.mjs`). A failed fetch is retried once and then stops (row 7). Tests that need a reference app or a device say so in their titles and skip; CI lists them by name. The `../app` paragraph goes.
  - `docs/how-it-works.md` "CocoaPods-only libraries": the early check.
  - `docs/libraries.md`: the async-storage 3.x row says `doctor --project` and `build` refuse it early.
  - `docs/RELEASING.md`: CI must be green before a release.
  - `CHANGELOG.md` `[Unreleased]`:
    - Added: early refusals, sign-in and App ID messages, `doctor --report`, issue templates, CI;
    - Changed: xtool 1.24.0, the FUSE hint;
    - Upgrading: run `rn-xtool setup` once to download xtool 1.24.0 (`doctor` reports xtool as not found until then).
- Test: `tests/docsLinks.test.ts`

- [ ] **Step 1: Write the failing test** `every troubleshooting link in src has a heading` → collects `troubleshootingUrl("<a>")` calls and `blob/main/docs/<file>.md#<a>` URLs in `src/**/*.ts`. Each anchor must equal the GitHub slug of a heading in that file: lowercase, characters other than letters, digits, spaces, `-` and `_` dropped, spaces turned into `-`.
- [ ] **Step 2: Run** `npx vitest run tests/docsLinks.test.ts` → FAIL (the five anchors are missing).
- [ ] **Step 3: Write** the docs. Every quoted message is copied from Tasks 1–7, and no "pending" note remains.
- [ ] **Step 4: Run** `grep -n "1\.23\.0\|sudo apt install libfuse2\b\|\.\./app\b" README.md docs/*.md` → no hit outside CHANGELOG's released sections. Then `npm test && npm run lint` → PASS.
- [ ] **Step 5: Commit** `git add README.md CHANGELOG.md docs tests && npm run scan:private && git commit -m "docs: document early failures and CI"`

### Task 13: Device, sign-in and CI check (controller with Willy)

CLI: `npm run build` in the worktree, then `node ../expo-xtool-w1/bin/rn-xtool.js <cmd>` in each app. The apps are build-only inputs: nothing in them is committed. Record versions, timings and run links in the PR body.

- [ ] **Step 1 (xtool 1.24.0, row 4):** `rn-xtool setup` downloads `xtool-1.24.0.AppImage` and passes its checksum. `rn-xtool doctor` shows `✔ xtool — 1.24.0`.
- [ ] **Step 2 (no false positives, row 1):** `doctor --project` in `../app-expo-57`, `../app`, `../app-bare`, `../app-bare-086` and `../app-bare-087` → each ends `✔ known-limits — none of the setups …` and exits 0.
- [ ] **Step 3 (sign-in, Willy at the terminal):** `rn-xtool auth login` shows its prompts and the password stays hidden. The code prompt appears, and the login succeeds on 1.24.0; `rn-xtool auth status` shows logged in. Then one more `auth login`, interrupted with Ctrl+C at the code prompt, prints the login-interrupted text, and the shell gets its prompt back.
- [ ] **Step 4 (device, row 5):** `build` exits 0, `install` installs and Willy launches once, for `../app-expo-57` (SDK 57), `../app` (SDK 58) and `../app-bare` (bare 0.88.1). If anything fails on 1.24.0 that works on 1.23.0, revert Task 11's commit and take it to Willy.
- [ ] **Step 5 (report, row 6):** `doctor --report` in `../app`. Willy reads it: no Apple ID, Team ID, UDID, device name, IP or home path appears.
- [ ] **Step 6 (GitHub, with Willy's go-ahead):**
  - Push with `git push -u origin feature/early-clear-failures`, and check that `git rev-parse --abbrev-ref @{u}` prints `origin/feature/early-clear-failures`.
  - Open the PR. Its CI run is green, and its summary lists the skipped tests by name (row 8).
  - If the repo has no `library` label, give Willy `gh label create library --description "A library does not build"`.
  - After the merge, the issue form at `/issues/new/choose` shows the two templates and no blank issue.
- [ ] **Step 7:** Fixes go through the owning task's files with a red/green test, one `fix:` commit each. A gap that needs a new decision goes to Willy.

## Open questions for the user

1. **A verification code that never arrives prints nothing.** xtool waits at `Code:` with no error (#407), and stdout stays on the terminal, so there is no text to match. The plan maps an interrupted `auth login` (Ctrl+C, SIGINT or exit 130) to the login-interrupted hint. Is that the behaviour you want?
2. **`HTTPClientError.connectTimeout` has two causes.** #414 shows it for a stalled gsa.apple.com, and #401 shows it for an unreachable anisette server. The text cannot tell them apart, so the plan gives one message that names both. `deadlineExceeded` gets the anisette message.
3. **The App ID fixture is rebuilt.** No public dump exists, so only Apple's sentence is verbatim, and the match keys on that sentence. If one of your install logs holds the real dump, it should replace the fixture.
4. **Device names are redacted too** (`<device>`), although the spec does not list them, because a name like "Jane's iPhone" carries the owner's name.
5. **One devDependency, `yaml` ^2.9.1,** so the template tests really parse the YAML. It is already installed through patch-package.
