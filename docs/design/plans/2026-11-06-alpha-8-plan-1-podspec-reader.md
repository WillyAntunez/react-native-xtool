# Release 0.1.0-alpha.8, plan 1: the podspec reader runs real Ruby — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read every podspec with the system `ruby` and a shim of CocoaPods and React Native's helpers, fail loudly
where the shim does not model something, keep the JavaScript evaluator as the visible no-Ruby fallback, and guard the
reader with a permanent sweep in CI and the docs with a bare-mention check.

**Architecture:** A new Ruby file, `read-podspec-shim.rb`, ships next to `read-podspec.js` in both copies of React
Native's scaffolder (`vendor/rn-spm/spm/` and the two 0.88 patches). `read-podspec.js` picks the reader once per
process (`podspecReader()`), runs the shim per podspec with a fixed environment, and hands its JSON (CocoaPods' JSON
form) to the existing consumer `flattenSubspecs`, which learns the `ios` merge. `pod ipc spec` is removed. Each read is
appended to a JSON-lines file that the `rn-spm` step turns into the one `⚠` line, and `doctor --report` into its
reader and `ENV` lines. A vitest sweep reads about 45 pinned library tarballs with both readers against reviewed
goldens.

**Tech Stack:** Ruby ≥ 2.7 (stdlib only), Node 22 (CommonJS for the vendored scripts, TypeScript ESM for `src/`),
vitest, GitHub Actions.

**Spec:** [`docs/design/specs/2026-11-06-alpha-8-fail-early-design.md`](../specs/2026-11-06-alpha-8-fail-early-design.md)
(decision A, rulings R1–R5, R10, R11, design A and F.1/F.3, failure-walk rows 1–29 and 104–108, 112–115). Index of all
groups: [`2026-11-06-alpha-8-fail-early.md`](2026-11-06-alpha-8-fail-early.md). Plans 2–4 cover groups B, C, D, E, G and
F2.

**Branch:** cut the execution branch with `git switch -c feature/alpha-8-podspec-reader --no-track <base the owner
names>`; never track `develop`/`main`; push only with `git push -u origin feature/alpha-8-podspec-reader`, then check
that `@{u}` is `origin/feature/alpha-8-podspec-reader`.

## Global Constraints

- Linux only, no Mac, no Xcode tools. `doctor --project` keeps working without Swift, xtool or a network.
- The scaffolder ships twice and stays byte-identical: `vendor/rn-spm/spm/` and `patches/react-native+0.88.{0,1}.patch`,
  regenerated from the vendored copy by the recipe in `docs/RELEASING.md` "Scaffolder changes" step 2, never edited as
  text. The shim is a new file in both.
- Revision rule: a change to what a scaffold writes bumps `RN_XTOOL_SCAFFOLD_REVISION`
  (`vendor/rn-spm/spm/scaffold-package-swift.js:139`) and `SCAFFOLD_REVISION` (`src/pipeline/patches.ts:362`) together,
  from 7 to 8, with a CHANGELOG "Upgrading" note.
- The podspec's environment: `RCT_NEW_ARCH_ENABLED='1'`, `RCT_HERMES_V1_ENABLED='1'` (`RN_POD_ENV`,
  `read-podspec.js:230`), every other variable unset; the child gets `PATH`, `HOME`, `LANG` and those two only.
- One Ruby process per podspec, working directory the podspec's folder, 30 s timeout.
- Amended 2026-11-09 (the spec's "Amendments (2026-11-09)" rules): the timeout is 120 s, as skia's podspec copies
  hundreds of MB while it is read; the probe prints the interpreter's absolute path (`RbConfig.ruby`) and every podspec
  runs with it; `min_ios_version_supported` and the folly config are constants in the shim, with a drift test over the
  cached React Native lines (`RN_LINES`); the heavy tier (skia's prebuilt packages) is optional and not fetched in CI;
  worklets' own stop text appears only with `react-native` installed beside it (otherwise `worklets_utils.rb:2` fails
  first).
- The escape is exactly `RN_XTOOL_PODSPEC_READER=reduced`; it prints a `⚠` line naming itself and `doctor --report`
  records it (R2).
- `ENV` names a podspec read go to the reads file and `doctor --report`, never to the terminal (R4).
- No fallback without a line naming it; no check that blocks a working app where it is not certain (anti-goals).
- Mechanisms over versions: every rule follows a content fact, never a library name or version.
- Downloads and builds on the owner's machine need the owner's approval first; device runs are the owner's (and go
  through a delegated session, never this one).
- Before every commit: `git add` the task's files, then `npm run scan:private` (must print `scan-private: clean`). No
  absolute home paths, Team ID, UDID, e-mail, IP or production-app name in any committed file; tests normalise temp
  roots to `<tmp>` or `<project>`. No bare `` `@word` `` outside code spans in any markdown (Task 14 enforces it).
- Commits: Conventional Commits, English, subject ≤ 50 characters, imperative, no body; one logical change each.
- Scaffolder tasks end with `npx vitest run tests/vendor-rn-spm.test.ts tests/patches.test.ts
  tests/patches-upstream.test.ts tests/rn-scaffolder.test.ts` green with none of the provenance, identical-patch,
  upstream dry-run or "the patched RN files carry the patch" tests skipped (`node scripts/fetch-test-tarballs.mjs`
  first).

## Review Focus

1. **A machine whose locale is `C` or unset** (`LANG=C`, CI containers): a package.json description with non-ASCII
   text read through `JSON.parse(File.read(...))` must come out in the model unchanged, not as an encoding error.
   Pinned in Task 2 (`it("writes UTF-8 values when LANG is C")`).
2. **A podspec or a script it runs that reads standard input** (a `gets`, a `node` script prompting): the read must end
   at once, not hang to the timeout on the user's terminal. Pinned in Task 3 (`it("gives the podspec an empty stdin")`).
3. **A library reached through a symlink** (pnpm, a monorepo link, a hoisted package): `__dir__`, `require_relative`
   and the installation root must follow the path autolinking gave, as CocoaPods does. Pinned in Task 3
   (`it("reads a library reached through a symlink")`).
4. **Ruby older than the one CI runs** (Ubuntu 22.04's 3.0; the floor 2.7): the shim must parse and run there, or the
   reader is unusable for those users with only a crash text. Pinned in Task 1 (the `shim-ruby-floor` CI job runs
   `tests/podspecShim.test.ts` on the floor Ruby).
5. **A mistyped escape** (`RN_XTOOL_PODSPEC_READER=REDUCED`, `=1`, `=ruby`): it must not silently do nothing. Pinned in
   Task 3 (`it("names an unknown RN_XTOOL_PODSPEC_READER value")`) and printed in Task 10.

## Interfaces later plans consume

- **The shim's model** (Task 1) and `PodspecModel.reader`, `.spmDependencies` (Tasks 4, 5): plan C's glob comparison
  reads `source_files`/`exclude_files` of the selected layers from it and adds a `--glob` mode to the shim's command
  line next to `--probe`.
- **`podspecReader()`** (Task 3, `read-podspec.js`) and **`podspecReaderHere()`** (Task 8, `src/tools/podspecReader.ts`):
  plan C uses them to pick Ruby's `Dir.glob` or the JavaScript expansion.
- **The marker line** `// rn-xtool-podspec-reader: ruby|reduced` (Task 7) and `scaffoldReaderOf(patchText)` (Task 9).
- **The reads file** `ios/build/rn-xtool-podspec-reads.jsonl`, `readPodspecReads()` and `podspecEnvLines()` (Task 10):
  plan D's log writes `podspecEnvLines()` to the build log only.
- **`doctor --report`'s `podspec reader:` line** (Task 10): plan B adds its `precheck:` line (`--skip-precheck`) beside it.

---

### Task 1: The shim's DSL and command line

**Files:**
- Create: `vendor/rn-spm/spm/read-podspec-shim.rb`
- Create: `tests/podspecShim.test.ts`, `tests/support/ruby.ts`
- Modify: `patches/react-native+0.88.0.patch`, `patches/react-native+0.88.1.patch` (regenerated)
- Modify: `tests/rn-scaffolder.test.ts` ("the patched RN files carry the patch", after the fix 28 hunk test at :213),
  `tests/packageFiles.test.ts`
- Modify: `.github/workflows/ci.yml` (a `ruby --version` step before Test; a `shim-ruby-floor` job)

**Interfaces:**
- Consumes: nothing.
- Produces: the command line
  - `ruby <shim> --probe` → stdout `{"ruby":"<RUBY_VERSION>","floor":"2.7.0","usable":true}` or
    `{"ruby":"2.6.10","floor":"2.7.0","usable":false,"why":"ruby 2.6.10 is older than 2.7.0"}`, exit 0. The floor check
    is the shim's first statement and prints without the `json` library; `require 'json'` follows.
  - `ruby <shim> <podspec> <out.json> <installation-root>`, run by Task 3 in the podspec's folder → exit 0 with the
    model in `<out.json>`, or exit 1 with `{"error":{"kind":K,"message":M}}` in `<out.json>`. Nothing of the shim's own
    goes to stdout; the podspec's prints do.
  - The model, CocoaPods' JSON form (what `pod ipc spec` printed, so `flattenSubspecs`, `read-podspec.js:2011`, reads
    it unchanged):

    ```text
    { "name": String,                        // a subspec's base name ("common"), never "Pod/common"
      <attribute>: value as the podspec gave it; Symbol → String, Hash keys → String, Pathname → String,
      "platforms": { "<platform>": String|null },
      "dependencies": { "<pod>[/<subspec>]": [ "<requirement>", … ] },
      "default_subspecs": [ String, … ] | "none",
      "subspecs":  [ <same shape> ], "testspecs": [ <same shape> ], "appspecs": [ <same shape> ],
      "ios"|"osx"|"tvos"|"visionos"|"watchos": { <attribute>: value, "dependencies": {…} },
      "__rn_xtool__": { "env": [String], "helpers": [String], "ui": [String],      // root only, sorted, unique
                        "spm_dependencies": [ { "url", "requirement", "products" } ] } }
    ```

    A singular alias is stored under its plural key (`framework` → `frameworks`, `author` → `authors`,
    `swift_version` → `swift_versions`, `script_phase` → `script_phases`, `resource_bundle` → `resource_bundles`, …).
  - Error kinds and their exact messages (`<where>` is `<podspec>:<line>` for a frame in the podspec, else
    `<podspec> (<file relative to the podspec's folder>:<line>)` for the first frame in another of the library's files):
    `method` → `<where>: the podspec calls <name>(…), which rn-xtool's podspec reader does not model`;
    `constant` → `<where>: the podspec uses <Name>, which rn-xtool's podspec reader does not model`;
    `attribute` → `<where>: the podspec sets <recv>.<name>, which CocoaPods does not define`;
    `require` → `<podspec>: cannot load such file -- <name>; rn-xtool's podspec reader stubs only colored2`;
    `raised` → `<where>: <the exception's message>` (also `abort`, `exit` and syntax errors);
    `not-a-spec` → `<podspec>: the podspec does not evaluate to a Pod::Spec`.

- [ ] **Step 1: Write the failing tests** in `tests/podspecShim.test.ts`, with `tests/support/ruby.ts` exporting
  `SHIM` (the vendored path), `needsRuby` (`""` or `" (needs ruby)"`; on CI, where `process.env.CI === "true"`, a
  missing Ruby fails the file instead) and `runShim(body: string, opts?: { files?: Record<string,string>; env?:
  Record<string,string>; root?: string }): { status: number; json: any; stdout: string; podspec: string }` (writes `Foo.podspec` and
  `files` into a temp folder, runs the shim there with `env: { PATH, HOME, LANG, RCT_NEW_ARCH_ENABLED: "1",
  RCT_HERMES_V1_ENABLED: "1", ...env }`).

  ```ts
  it("--probe prints the Ruby version and the floor", () => {
    expect(JSON.parse(tool("ruby", [SHIM, "--probe"]).stdout)).toEqual({ ruby: expect.stringMatching(/^\d+\.\d+\.\d+/), floor: "2.7.0", usable: true });
  });
  it("writes the spec in CocoaPods' JSON form", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = "Foo"\n s.version = "1.2.3"\n s.source_files = "ios/**/*.{h,m}"\n s.dependency "React-Core"\n s.dependency "Bar", "~> 1.0"\n s.pod_target_xcconfig = { "OTHER_CFLAGS" => "-DX=1" }\n s.ios.deployment_target = "15.1"\n s.source = { :git => "x", :tag => "v#{s.version}" }\nend`);
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ name: "Foo", version: "1.2.3", source_files: "ios/**/*.{h,m}", dependencies: { "React-Core": [], Bar: ["~> 1.0"] },
      pod_target_xcconfig: { OTHER_CFLAGS: "-DX=1" }, platforms: { ios: "15.1" }, source: { git: "x", tag: "v1.2.3" },
      __rn_xtool__: { env: [], helpers: [], ui: [], spm_dependencies: [] } });
  });
  it("nests subspecs under their base name and keeps test specs apart", () => { /* subspec "core" with ss.name read
     into ss.summary → subspecs[0] = { name: "core", summary: "Foo/core", … }; s.default_subspec = "core" →
     default_subspecs: ["core"]; s.default_subspecs = :none → "none"; s.test_spec "Tests" → testspecs[0].name "Tests",
     no "Tests" in subspecs */ });
  it("stores platform-scoped attributes under their platform", () => { /* s.ios.exclude_files = "a", s.osx.exclude_files
     = "b", ss.ios.dependency "X" → ios: { exclude_files: "a" }, osx: { exclude_files: "b" }, subspecs[0].ios.dependencies
     { X: [] }; s.platform = :ios, "12.0" → platforms { ios: "12.0" }; s.respond_to?(:visionos) is true */ });
  it("stores a singular alias under the plural key", () => { /* s.framework = "UIKit" → frameworks: "UIKit"; s.author = "a" → authors: "a" */ });
  it("refuses an attribute CocoaPods does not define", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = "Foo"\n s.not_an_attribute = 1\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "attribute"]);
    expect(r.json.error.message).toBe(`${r.podspec}:3: the podspec sets s.not_an_attribute, which CocoaPods does not define`);
  });
  it("names an unmodeled method with its line", () => { /* line 2 `sources_for("ios")` → kind "method", message
     `<podspec>:2: the podspec calls sources_for(…), which rn-xtool's podspec reader does not model` */ });
  it("names an unmodeled constant", () => { /* `Foo::Bar.baz` → kind "constant", message names Foo */ });
  it("names the library file a failure comes from", () => { /* require_relative "scripts/x" whose line 4 calls
     nope() → message starts `<podspec> (scripts/x.rb:4): the podspec calls nope(…)` */ });
  it("passes the podspec's own raise on with its line", () => { /* line 2 `raise "boom"` → kind "raised", message `<podspec>:2: boom` */ });
  it("refuses a file that is not a spec", () => { /* body `42` → kind "not-a-spec" */ });
  it("keeps the model out of the podspec's prints", () => { /* puts "{ not json }" before Pod::Spec.new → status 0, json.name "Foo", stdout contains "{ not json }" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecShim.test.ts`. Expected: FAIL (the
  shim file does not exist).

- [ ] **Step 3: Write `vendor/rn-spm/spm/read-podspec-shim.rb`.** Header: the MIT notice React Native's scripts carry
  without a copyright line (`# This source code is licensed under the MIT license found in the LICENSE file in the
  root directory of this source tree.`). Ruby ≤ 2.7 syntax only. Decisions the tests do not fix:
  - Evaluation as CocoaPods-core does it: `module Pod; def self._eval_podspec(string, path) eval(string, nil, path)
    end; end`, so `self` is `Pod`, a podspec's top-level `def` lands on `Pod` (`Pod.respond_to?(:reactNativeWorkletsPath)`
    works) and `Spec`, `Config`, `UI` resolve inside `Pod`. The source is read as UTF-8. The result must be a
    `Pod::Specification` (`not-a-spec` otherwise). `Pod::Spec = Pod::Specification`.
  - `Pod::Specification.new(parent = nil, name = nil) { |s| }` with the attribute table of CocoaPods 1.16's DSL, each
    a setter and a getter (the getter returns what was set, `nil` otherwise): `name version swift_versions
    cocoapods_version authors social_media_url license homepage readme changelog source summary description
    screenshots documentation_url prepare_command static_framework deprecated deprecated_in_favor_of platforms
    requires_arc frameworks weak_frameworks libraries compiler_flags pod_target_xcconfig user_target_xcconfig xcconfig
    prefix_header_contents prefix_header_file module_name header_dir header_mappings_dir script_phases
    on_demand_resources info_plist source_files public_header_files project_header_files private_header_files
    vendored_frameworks vendored_libraries resource_bundles resources exclude_files preserve_paths module_map
    default_subspecs requires_app_host app_host_name scheme test_type`, the singular aliases of the plural ones, and
    the methods `dependency(name, *requirements)`, `platform=(value)`, `subspec`, `test_spec`, `app_spec`, and the
    proxies `ios osx macos tvos visionos watchos` (each with `deployment_target=` and every non-root attribute; `macos`
    stores under `osx`). Anything else through `method_missing` → `attribute`. `name` of a subspec reads `Parent/base`.
  - `to_model` writes the shape of the Interfaces block; `__rn_xtool__` is filled by Task 2 and written as empty lists
    here.
  - Failures: rescue `NoMethodError`/`NameError` whose receiver is `Pod`, the main object or a shim object as
    `method` (`e.name`; a capitalised name of a `NameError` as `constant`), any other `NoMethodError` (a `nil`
    receiver) as `raised` with Ruby's message; `ScriptError`, `StandardError`, `SystemExit` as `raised`; then write the
    error file and `exit 1`.

- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/podspecShim.test.ts`. Expected: PASS.

- [ ] **Step 5: Add the fix 29 hunk test** to "the patched RN files carry the patch":
  `it("the scaffolder has the fix 29 shim", () => expect(existsSync(path.join(SPM, "read-podspec-shim.rb"))).toBe(true))`,
  and to `tests/packageFiles.test.ts` ("the npm package", :29) `it("ships the podspec reader's shim")` asserting the
  pack list holds `vendor/rn-spm/spm/read-podspec-shim.rb` (row 26).

- [ ] **Step 6: Add the CI guards** to `.github/workflows/ci.yml`: a step `ruby --version` named "Ruby (the podspec
  reader needs it)" before Test, and a job `shim-ruby-floor` on `ubuntu-22.04` (`actions/checkout@v7`,
  `actions/setup-node@v7` node 22, `ruby/setup-ruby@v1` with `ruby-version: "2.7"`, `npm ci`, `npx vitest run
  tests/podspecShim.test.ts`). When `setup-ruby` has no 2.7 for that runner, use the oldest it has and set the shim's
  floor to it in the same commit: the floor is what CI proves.

- [ ] **Step 7: Regenerate both 0.88 patches** with `docs/RELEASING.md` "Scaffolder changes" step 2, from the repo root.
  `git diff --stat patches/` shows both files changed by the same amount and `cmp patches/react-native+0.88.0.patch
  patches/react-native+0.88.1.patch` prints nothing.

- [ ] **Step 8: Run the byte tests.** Run: `npx vitest run tests/vendor-rn-spm.test.ts tests/patches.test.ts
  tests/patches-upstream.test.ts tests/rn-scaffolder.test.ts`. Expected: PASS, none of the provenance, identical-patch,
  upstream dry-run or "carry the patch" tests skipped.

- [ ] **Step 9: Commit.**

  ```bash
  git add vendor/rn-spm/spm/read-podspec-shim.rb patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch \
    tests/podspecShim.test.ts tests/support/ruby.ts tests/rn-scaffolder.test.ts tests/packageFiles.test.ts .github/workflows/ci.yml
  npm run scan:private
  git commit -m "feat: add the podspec reader's Ruby shim"
  ```

### Task 2: The shim's CocoaPods and React Native environment

**Files:**
- Modify: `vendor/rn-spm/spm/read-podspec-shim.rb`
- Modify: `tests/podspecShim.test.ts`
- Modify: both 0.88 patches (regenerated)

**Interfaces:**
- Consumes: Task 1's command line, model and error kinds.
- Produces: `__rn_xtool__` filled: `env` (every `ENV` name read), `helpers` (`install_modules_dependencies`,
  `add_dependency`, `get_folly_config`, `min_ios_version_supported`, `spm_dependency`, as called), `ui` (each
  `Pod::UI` line), `spm_dependencies`.

The surface, verified by a static scan (Ruby's `Ripper`, nothing evaluated) of 31 distinct podspecs of the reference
apps and the Expo SDK 57/58 references, 15 of the one-off sweep of 2026-11-06, the 7 fixtures in
`tests/fixtures/podspecs/`, and the 7 `scripts/*.rb` files they `require_relative`:

| Call | Where | Shim |
|---|---|---|
| `Pod::Spec.new`, attributes, `subspec`, `test_spec`, `s.ios/osx/tvos/visionos.*`, `dependency`, `s.respond_to?(:visionos)`, getters `s.name`/`s.version`/`s.summary` | all | Task 1 |
| `install_modules_dependencies` (28), `respond_to?(:install_modules_dependencies, true)` (4), `defined?(install_modules_dependencies…)` (4) | podspecs | recorded; a private method on `Object` |
| `add_dependency` (5) | gesture-handler, Expo | `spec.dependency(subspec ? "#{pod}/#{subspec}" : pod, *[version].compact)`, recorded |
| `get_folly_config` (4) | Expo | fresh `{ version: "2024.11.18.00", git: "https://github.com/facebook/folly.git", compiler_flags: "-DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32" }` per call (callers mutate it), recorded |
| `min_ios_version_supported` | spec A.3 | `"15.1"`, recorded |
| `spm_dependency(spec, url:, requirement:, products:)` | spec A.3, row 12 | recorded with its arguments |
| `use_expo_modules!` under `defined?` (2) | `Expo.podspec` | not defined: `defined?` answers `nil` |
| `Expo::PackagesConfig.instance.coreFeatures` (under `defined?`) and `.try_link_with_prebuilt_xcframework(s)` (unconditional) | `ExpoModulesCore.podspec` | singleton: `coreFeatures` → `[]`, `try_link_with_prebuilt_xcframework` → `false` (a source build), as expo-modules-autolinking's `packages_config.rb` answers without prebuilt modules |
| `Pod::UI.puts` (6); `Pod::UI.warn`/`.info` (spec A.3) | vision-camera, video, screens | captured into `ui`, not printed |
| `Pod::Config.instance` (13): `installation_root` (9), `project_root` (4), `project_pods_root` (6), `instance_variable_defined?(:@podfile)` | Expo, worklets, reanimated, svg, gesture-handler scripts | `Pathname`s from the fourth argument; `project_pods_root` = root + `Pods`; no `@podfile` |
| `Pod::VERSION` with `Gem::Version` (5) | Expo modules | `"1.16.2"`; RubyGems stays enabled (no `--disable-gems`: `Gem::Version` is needed) |
| `require 'json'` (all), `require 'rubygems'`, `require 'colored2'` (2), `require_relative` (10), `Pathname` (6) | all | a name on Ruby's own `$LOAD_PATH` (captured at start, before any gem activates) loads; `colored2` loads a stub whose `String` colour methods return the string; any other name → `require` |
| backticks (13) and `system` (5) running `node`, `abort` (2), `raise` (7) | worklets, reanimated, Expo, vision-camera | real Ruby |
| `ENV[…]`, `ENV.fetch`, `ENV.key?`/`include?`: 13 names in podspecs, 2 more in scripts | — | names recorded into `env` |
| globals `$VCEnable*`, `$RNVideoUse*` (under `defined?`), `$ExpoUseSources&.`, `$expo_warned_about_missing_autolinking` | — | plain Ruby: unset |

React Native's other helpers of fact 8 (`folly_flags`, `resolve_use_frameworks`, `create_header_search_path_for_frameworks`,
`podspec_sources`, `get_*_config` other than folly, `set_*_config`, `rct_cxx_language_standard`, `rncore_pod`,
`mark_as_react_native_build`, `use_react_native!`) are called by none of the scanned podspecs: they stay undefined
and a call fails as `method`. Task 13 adds one when the sweep meets it.

- [ ] **Step 1: Write the failing tests** in `tests/podspecShim.test.ts`, `describe("the environment")`:

  ```ts
  it("captures Pod::UI and does not print it", () => { /* Pod::UI.puts "hi"; Pod::UI.warn "w" → ui ["hi", "w"], stdout "" */ });
  it("answers Pod::Config with the installation root", () => { /* s.summary = [installation_root, project_root,
     project_pods_root].map(&:to_s).join("|") with root "/r/ios" → "/r/ios|/r/ios|/r/ios/Pods";
     instance_variable_defined?(:@podfile) false */ });
  it("is CocoaPods 1.16.2 to Gem::Version checks", () => { /* s.summary = (Gem::Version.new(Pod::VERSION) >= Gem::Version.new("1.13.0")).to_s → "true" */ });
  it("records React Native's helpers", () => { /* install_modules_dependencies(s); add_dependency(s, "React-Codegen",
     subspec: "x"); f = get_folly_config()[:compiler_flags]; f << " -DMORE"; s.compiler_flags = get_folly_config()[:compiler_flags];
     s.ios.deployment_target = min_ios_version_supported; spm_dependency(s, url: "u", requirement: {kind: "exact"}, products: ["P"])
     → dependencies has "React-Codegen/x"; compiler_flags equals the folly string without " -DMORE"; platforms.ios "15.1";
     helpers sorted; spm_dependencies [{url:"u", requirement:{kind:"exact"}, products:["P"]}]; no React-Core added */ });
  it("answers defined? and respond_to? as React Native's Podfile does", () => { /* defined?(install_modules_dependencies()) → "method";
     respond_to?(:install_modules_dependencies, true) → true; defined?(use_expo_modules!) → nil; folly_flags() → kind "method" */ });
  it("answers Expo's PackagesConfig for a source build", () => { /* coreFeatures → []; try_link_with_prebuilt_xcframework(s) → false */ });
  it("stubs colored2 and refuses other gems", () => { /* require 'colored2'; s.summary = "x".yellow → "x";
     require 'xcodeproj' → kind "require", message `<podspec>: cannot load such file -- xcodeproj; rn-xtool's podspec reader stubs only colored2` */ });
  it("records the ENV names a podspec reads", () => { /* ENV['A']; ENV.fetch('B', nil); ENV.key?('C');
     s.summary = ENV['RCT_NEW_ARCH_ENABLED'] → env ["A","B","C","RCT_NEW_ARCH_ENABLED"], summary "1" */ });
  it("runs node from the installation root", () => { /* root has node_modules/react-native/package.json {version "0.88.1"};
     s.version = `cd "#{Pod::Config.instance.installation_root}" && node --print "require('react-native/package.json').version"`.strip;
     s.summary = system("node -e 'process.exit(0)'").to_s → version "0.88.1", summary "true" */ });
  it("passes worklets 0.8.3's own stop on", () => { /* the fixture tests/fixtures/podspecs/RNWorklets-0.8.3 copied into a
     project without react-native → kind "raised", message starts `<podspec> (scripts/worklets_utils.rb:31): [Worklets] Unable to recognize your` (row 7) */ });
  it("writes UTF-8 values when LANG is C", () => { /* package.json description "Ünïcødé ❤️", env LANG=C,
     s.summary = JSON.parse(File.read(File.join(__dir__, "package.json")))["description"] → summary "Ünïcødé ❤️" */ });
  it.skipIf(...)("holds the folly flags and iOS floor every supported line defines", () => { /* for each cached
     react-native@0.85.0, 0.86.3, 0.87.1, 0.88.0, 0.88.1: package/scripts/cocoapods/helpers.rb contains the shim's
     compiler_flags string, `return '15.1'` in min_ios_version_supported; skip with needsTarball's text */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecShim.test.ts`. Expected: FAIL (the
  helpers, `Pod::UI`, `Pod::Config`, `Pod::VERSION` and the stubs are undefined).

- [ ] **Step 3: Implement the table above in the shim.** `Encoding.default_external = Encoding::UTF_8` before anything
  reads a file. `ENV` recording prepends a module to `ENV.singleton_class` for `[] fetch key? has_key? include?
  member? values_at`.

- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/podspecShim.test.ts`. Expected: PASS.

- [ ] **Step 5: Regenerate both 0.88 patches** (RELEASING step 2) and **run the byte tests** (Global Constraints).
  Expected: PASS, nothing skipped.

- [ ] **Step 6: Commit.**

  ```bash
  git add vendor/rn-spm/spm/read-podspec-shim.rb patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch tests/podspecShim.test.ts
  npm run scan:private
  git commit -m "feat: model CocoaPods and React Native helpers"
  ```

### Task 3: Choosing the reader and running the shim

**Files:**
- Modify: `vendor/rn-spm/spm/read-podspec.js` (new section after the requires, before "Regex fallback" at :165)
- Create: `tests/podspecReader.test.ts`
- Modify: both 0.88 patches (regenerated)

**Interfaces:**
- Consumes: Task 1's command line, probe output and error file.
- Produces (exported from `read-podspec.js`):
  - `podspecReader(opts?: {env?: {[string]: ?string}, shim?: string}): PodspecReaderChoice`, where
    `PodspecReaderChoice = {reader: 'ruby', ruby: string, forced: false, warning: ?string} | {reader: 'reduced', why:
    string, forced: boolean, warning: ?string}`. `why` is one of `Ruby was not found`, `ruby <v> is older than <floor>`,
    `ruby cannot load json`, `ruby could not run the podspec reader (<first stderr line>)`, `the podspec reader's Ruby
    shim is missing from <path>`, `RN_XTOOL_PODSPEC_READER=reduced is set` (`forced: true`). Any other value of the
    variable sets `warning` to `RN_XTOOL_PODSPEC_READER=<value> is not a reader rn-xtool knows (only reduced); reading
    podspecs with Ruby` and is otherwise ignored. The probe (`ruby <shim> --probe`, 10 s) is memoised per `PATH`; the
    variable is read on every call.
  - `runPodspecShim(podspecPath: string, opts?: {timeoutMs?: number, installationRoot?: string}): {raw: RawSpec,
    output: string}` — throws `PodspecReadError`.
  - `class PodspecReadError extends Error` with `code = 'RN_SPM_PODSPEC_READ'`, `kind`, and `isPodspecReadError(e:
    mixed): boolean`.
  - `installationRootFor(podspecPath: string): string` — `process.env.RN_SPM_APP_IOS_DIR` when set, else the path as
    given (not resolved through symlinks) cut before its first `/node_modules/` segment plus `/ios`, else the podspec's
    folder.

- [ ] **Step 1: Write the failing tests** in `tests/podspecReader.test.ts` (loads the vendored `read-podspec.js`; fake
  `ruby` scripts are shell files in a temp `bin` put first on a stubbed `PATH`):

  ```ts
  it("reads with the reduced reader when Ruby is not found", () => expect(podspecReader({ env: { PATH: emptyBin } })).toEqual({ reader: "reduced", why: "Ruby was not found", forced: false, warning: null }));
  it("says why a Ruby is unusable", () => { /* fake ruby printing {"ruby":"2.5.1","floor":"2.7.0","usable":false,"why":"ruby 2.5.1 is older than 2.7.0"}
     → why "ruby 2.5.1 is older than 2.7.0"; fake ruby `echo "cannot load such file -- json" >&2; exit 1` → "ruby cannot load json";
     fake ruby `echo "syntax error, unexpected" >&2; exit 1` → "ruby could not run the podspec reader (syntax error, unexpected)" */ });
  it("is forced to the reduced reader by RN_XTOOL_PODSPEC_READER=reduced", () => { /* → { reader: "reduced", why: "RN_XTOOL_PODSPEC_READER=reduced is set", forced: true } */ });
  it("names an unknown RN_XTOOL_PODSPEC_READER value", () => { /* "REDUCED" → reader "ruby", warning "RN_XTOOL_PODSPEC_READER=REDUCED is not a reader rn-xtool knows (only reduced); reading podspecs with Ruby" */ });
  it("says when the shim is missing", () => { /* shim: "<tmp>/none.rb" → why "the podspec reader's Ruby shim is missing from <tmp>/none.rb" */ });
  it("probes Ruby once per PATH", () => { /* fake ruby appending to a counter file; three calls → one line */ });
  it("runs the podspec with a fixed environment", () => { /* parent env RUBYOPT=-rnonexistent, BUNDLE_GEMFILE=/x, GEM_HOME=/y,
     RCT_NEW_ARCH_ENABLED=0 → read succeeds; s.summary = [ENV['RUBYOPT'], ENV['GEM_HOME'], ENV['RCT_NEW_ARCH_ENABLED']].inspect → '[nil, nil, "1"]' */ });
  it("runs the podspec in its folder", () => { /* podspec reads File.read("./flags.json") → its value */ });
  it("gives the podspec an empty stdin", () => { /* s.summary = $stdin.read.to_s.length.to_s → "0", in under 5 s */ });
  it("stops a podspec that does not finish", () => { /* sleep 5 with timeoutMs 1000 → PodspecReadError "<podspec> did not finish in 1 s. Set RN_XTOOL_PODSPEC_READER=reduced …" */ });
  it("ends a shim gap with how to go on", () => { /* sources_for("ios") → message === `${shimMessage} Set RN_XTOOL_PODSPEC_READER=reduced to read it with the reduced reader for one run, and report it with rn-xtool doctor --report.` and kind "method"; a podspec's own raise keeps the shim's message alone */ });
  it("finds the installation root", () => { /* RN_SPM_APP_IOS_DIR=/a/ios → "/a/ios"; unset: "/p/node_modules/@s/x/X.podspec" → "/p/ios";
     "/p/node_modules/expo/node_modules/y/ios/Y.podspec" → "/p/ios"; "/q/X.podspec" → "/q" */ });
  it("reads a library reached through a symlink", () => { /* <proj>/node_modules/lib → symlink to <elsewhere>/lib whose podspec
     require_relative's scripts/v.rb and reads __dir__/package.json; read through the link path → status ok, version from
     package.json, installation root "<proj>/ios" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecReader.test.ts`. Expected: FAIL
  (`podspecReader` is not exported).

- [ ] **Step 3: Implement the four exports in `read-podspec.js`.** `runPodspecShim` spawns `spawnSync('ruby', [shim,
  podspec, out, root], {cwd: dirname(podspec), env: {PATH, HOME, LANG, ...RN_POD_ENV}, stdio: ['ignore', 'pipe',
  'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 8 MiB})` with `out` in a fresh `fs.mkdtempSync(os.tmpdir())`
  folder removed afterwards; no out file → `PodspecReadError` `<podspec>: ruby exited with <code or signal>: <last
  stderr line>`. The shim path is `path.join(__dirname, 'read-podspec-shim.rb')`. A timeout says `did not finish in
  <timeoutMs / 1000> s`. Gap kinds (`method`, `constant`, `attribute`, `require`, `not-a-spec`) and the timeout get the
  remedy sentence; `raised` keeps the shim's message.

- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/podspecReader.test.ts`. Expected: PASS.

- [ ] **Step 5: Regenerate both 0.88 patches and run the byte tests** (Global Constraints). Expected: PASS, nothing
  skipped.

- [ ] **Step 6: Commit.**

  ```bash
  git add vendor/rn-spm/spm/read-podspec.js patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch tests/podspecReader.test.ts
  npm run scan:private
  git commit -m "feat: pick the podspec reader and run the shim"
  ```

### Task 4: `readPodspec` reads with the shim, never `pod ipc spec`

**Files:**
- Modify: `vendor/rn-spm/spm/read-podspec.js` (remove `patchPodspecForPodIpc` :57–84, `runPodIpcSpec` :86–156,
  `cleanupPatchedPodspec` :158–167 and the export at :2660; rewrite `readPodspec` :2512–2535, `readPodspecCached`
  :2572–2588, the advice in `unresolvedSourcesReason` :2478–2499; the file comment :15–28)
- Modify: `vendor/rn-spm/spm/spm-types.js` (`PodspecModel`, :423–478)
- Modify: `tests/podspecReader.test.ts`, `tests/rn-scaffolder.test.ts` (:155–160, :1518–1537, `podspecCopy`'s comment
  :70–80), `tests/vendor-rn-spm.test.ts` (E2 test :96–118)
- Modify: both 0.88 patches (regenerated)

**Interfaces:**
- Consumes: `podspecReader`, `runPodspecShim`, `PodspecReadError` (Task 3).
- Produces:
  - `readPodspec(path, opts)`: with `reader === 'ruby'`, `flattenSubspecs(runPodspecShim(path).raw, opts)` and no
    fallback (a `PodspecReadError` propagates); else `regexPodspec` as today. On both paths `name`, `moduleName` and
    `version` are `regexPodspec(path)`'s literal readings (`IDENTITY_FIELDS`, :299; row 15).
  - `PodspecModel` gains `reader: 'ruby' | 'reduced'`; `partial` is true only for the reduced reader;
    `usesInstallModulesDependencies` is `__rn_xtool__.helpers.includes('install_modules_dependencies')` on the Ruby
    path and today's source regex on the reduced one.
  - `readPodspecCached` keys on path, the sorted `dropSubspecs` and the reader.
  - Each read that is not a cache hit appends one JSON line to `process.env.RN_SPM_PODSPEC_READS` when set:
    `{"podspec": <absolute path>, "reader", "why"?, "forced", "ruby"?, "warning"?, "env": [], "helpers": [], "ok":
    boolean, "error"?: <message>}`. Consumed by Task 10.
  - `unresolvedSourcesReason`'s last sentence: `Install Ruby (sudo apt install ruby) so rn-xtool reads the podspec as
    CocoaPods does, or give the library a Package.swift of its own.`

- [ ] **Step 1: Write the failing tests** in `tests/podspecReader.test.ts`, `describe("readPodspec")`:

  ```ts
  it("reads with Ruby and says so", () => { /* model.reader "ruby", partial false */ });
  it("never falls back after a shim failure", () => { /* sources_for("ios") podspec → readPodspec throws PodspecReadError (kind "method") */ });
  it("reads with the reduced reader when forced", () => { /* stubEnv RN_XTOOL_PODSPEC_READER=reduced → reader "reduced", partial true */ });
  it("keeps the literal identity fields", () => { /* s.name = package['name'], s.version = package['version'], package.json
     name "react-native-foo" → name "" and version "" under both readers; s.module_name = "Foo" → "Foo" under both */ });
  it("marks React core from the helper actually called", () => { /* `install_modules_dependencies(s) if false` → false with Ruby, true reduced */ });
  it("caches per reader", () => { /* readPodspecCached twice, forced reduced in between → two models, readers ruby then reduced */ });
  it("never runs pod", () => { /* a `pod` stub on PATH that touches a marker file → no marker; "runPodIpcSpec" not exported */ });
  it("appends each read to RN_SPM_PODSPEC_READS", () => { /* one ok line {reader:"ruby", env:[…], helpers:[…], ok:true}; a failing
     podspec adds {ok:false, error:<message>}; a cache hit adds none */ });
  it("tells a refused glob to install Ruby", () => { /* forced reduced, s.source_files = sources_for("ios") → unresolvedSourcesReason ends with the sentence above */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecReader.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the Interfaces block** and update the file comment (:15–28) and `PodspecModel`'s comments on
  `dependencies`, `partial` and `usesInstallModulesDependencies` to the shim. Keep `RN_POD_ENV` (the evaluator and the
  shim's environment use it) and `findPodspecs`' skip of `.spm-scaffold-*` leftovers.

- [ ] **Step 4: Pin the reduced reader where a test asserts its behaviour.** Run `npm test` with Ruby on `PATH`. A
  failing test whose assertion is the reduced reader's (a `! … Left out of` warning, fix 28's refusal text, `partial`,
  `__unresolved__`, an inline podspec that is not valid Ruby) gets `vi.stubEnv("RN_XTOOL_PODSPEC_READER", "reduced")`
  in its `describe`'s `beforeEach` (in `tests/rn-scaffolder.test.ts` the fixes 1–28 blocks, in
  `tests/vendor-rn-spm.test.ts` the E2 test). Replace the fix 14–19 hunk assertion `toContain("env: {...process.env,
  ...RN_POD_ENV}")` (:158) with `toContain("...RN_POD_ENV")` (the shim's environment, Task 3), and the fix 19 test (:1518) with
  `it("19: the shim reads both variables as 1, whatever the environment says")` (stub both to `0`, `""`, `true`;
  `s.summary = ENV['RCT_NEW_ARCH_ENABLED'] + ENV['RCT_HERMES_V1_ENABLED']` → `"11"`). Any other failure is a
  difference between the readers: list it in the task's report, do not pin it.

- [ ] **Step 5: Run the tests to verify they pass.** Run: `npm test`. Expected: PASS (skips only those that skipped
  before).

- [ ] **Step 6: Regenerate both 0.88 patches and run the byte tests.** Expected: PASS, nothing skipped.

- [ ] **Step 7: Commit.**

  ```bash
  git add vendor/rn-spm/spm/read-podspec.js vendor/rn-spm/spm/spm-types.js patches/react-native+0.88.0.patch \
    patches/react-native+0.88.1.patch tests/podspecReader.test.ts tests/rn-scaffolder.test.ts tests/vendor-rn-spm.test.ts
  npm run scan:private
  git commit -m "feat: read podspecs with Ruby, drop pod ipc spec"
  ```

### Task 5: The consumer: the `ios` merge, unapplied keys, `spm_dependency`

**Files:**
- Modify: `vendor/rn-spm/spm/read-podspec.js` (`flattenSubspecs`, :2011–2470; a new `spmDependencyReason` beside
  `unresolvedSourcesReason`)
- Modify: `vendor/rn-spm/spm/scaffold-package-swift.js` (after the unresolved check at :2294)
- Modify: `vendor/rn-spm/spm/spm-types.js`, `tests/podspecReader.test.ts`, both 0.88 patches

**Interfaces:**
- Consumes: the model (Task 1), `readPodspec` (Task 4).
- Produces:
  - `flattenSubspecs` merges each layer's `ios` object over the layer as CocoaPods' consumer does for an iOS target:
    arrays (or a string read as a one-element array) concatenated, root first; hashes merged key by key with two
    string values joined by one space; anything else the platform's value. `osx`, `tvos`, `visionos`, `watchos` are
    never read. `dropSubspecs` applies unchanged.
  - A warning per key a CocoaPods build applies and the scaffold does not, in any selected layer or its `ios`:
    `script_phases`, `prepare_command`, `info_plist`, `module_map` → `The podspec sets <key>, which a CocoaPods build
    applies and rn-xtool's scaffold does not.` (printed by the driver as `  ! <library>: …`).
  - `PodspecModel.spmDependencies: Array<{url: string, products: Array<string>}>` from `__rn_xtool__`.
  - `spmDependencyReason(podspecPath, model): ?string` → `<podspec>: uses spm_dependency(url: <url>, products:
    <a, b>), which rn-xtool does not map yet`; the scaffold returns `status: 'error'` with it (row 12).

- [ ] **Step 1: Write the failing tests** (`describe("flattenSubspecs on the shim's model")`; the JSON ones need no Ruby):

  ```ts
  it("merges ios attributes over each layer", () => {
    const m = flattenSubspecs({ name: "Foo", source_files: "a/**/*.m", exclude_files: "x", ios: { exclude_files: "**/*.macos.m" },
      osx: { exclude_files: "**/*.ios.m" }, pod_target_xcconfig: { OTHER_CFLAGS: "-DA" }, subspecs: [{ name: "c", ios: { pod_target_xcconfig: { OTHER_CFLAGS: "-DB" } } }] });
    expect(m.excludeFiles).toEqual(["x", "**/*.macos.m"]);
    expect(m.preprocessorDefines.map((d) => d.name)).toEqual(["A", "B"]);
  });
  it("warns about keys the scaffold does not apply", () => { /* script_phases on the root, info_plist in ios → two warnings with the text above */ });
  it("refuses a library that declares a SwiftPM dependency", () => { /* __rn_xtool__.spm_dependencies [{url:"https://x/y", products:["Y"]}]
     → scaffoldPackageSwiftForDep status "error", reason "<podspec>: uses spm_dependency(url: https://x/y, products: Y), which rn-xtool does not map yet" */ });
  it("reads react-native-svg 15.16.0's iOS excludes with Ruby", () => { /* tarball podspec: excludeFiles contains "**/*.macos.{h,m,mm}",
     not "**/*.ios.{h,m,mm}", not "apple/Utils/RNSVGFabricConversions.h" */ });
  it("reads react-native-screens 4.24.0's locals with Ruby", () => { /* fixture: sourceFiles contains "ios/**/*.{h,m,mm,cpp,swift}",
     excludeFiles ["ios/gamma/**/*.{h,m,mm,cpp,swift}"], and the common subspec's globs */ });
  it("selects gesture-handler 2.32.0's subspecs with Ruby as with the reduced reader", () => { /* fixture: sourceFiles and dependencies equal under both readers */ });
  it("drops a subspec on Ruby's model as on the reduced one", () => { /* a vision-camera-shaped podspec: subspec "FrameProcessors"
     under `if enableFrameProcessors` with `ss.dependency "react-native-worklets-core"`, $VCEnableFrameProcessors under defined?,
     Pod::UI.puts lines → dropSubspecs ["FrameProcessors"] leaves its sources and dependency out under both readers */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecReader.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the Interfaces block.** The merge happens once per layer before every reader in
  `flattenSubspecs` uses `layers` (:2045).

- [ ] **Step 4: Run the tests to verify they pass.** Run: `npx vitest run tests/podspecReader.test.ts
  tests/rn-scaffolder.test.ts`. Expected: PASS.

- [ ] **Step 5: Regenerate both 0.88 patches and run the byte tests.** Expected: PASS, nothing skipped.

- [ ] **Step 6: Commit.**

  ```bash
  git add vendor/rn-spm/spm/read-podspec.js vendor/rn-spm/spm/scaffold-package-swift.js vendor/rn-spm/spm/spm-types.js \
    patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch tests/podspecReader.test.ts
  npm run scan:private
  git commit -m "feat: merge ios attributes of the shim's model"
  ```

### Task 6: Reader failures propagate from autolinking and name reads

**Files:**
- Modify: `vendor/rn-spm/spm/generate-spm-autolinking.js` (`extractPodspecHeaderSearchPaths`, :827–849)
- Modify: `vendor/rn-spm/spm/expand-spm-dependencies.js` (`podspecFor`, :305–314; `defaultReadPodspec`, :470–486)
- Modify: `tests/podspecReader.test.ts`, both 0.88 patches

**Interfaces:**
- Consumes: `isPodspecReadError` (Task 3).
- Produces: the three catches rethrow when `isPodspecReadError(e)`; any other error keeps today's result (`[]`,
  `null`). The driver prints the message as `rn-spm-generate: <message>` and exits 1, so `rn-spm` stops with it in its
  tail (R3, row 10).

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("stops autolinking on a shim failure", () => { /* autolinkingDepToSpmTarget (generate-spm-autolinking.js:872) for a dep whose
     podspec calls sources_for → throws a PodspecReadError naming the podspec */ });
  it("stops name resolution on a shim failure", () => { /* defaultReadPodspec(root, podspec) with s.name = compute_name() (no literal) → throws */ });
  it("keeps the old answer for an unreadable file", () => { /* podspec path that does not exist → defaultReadPodspec null, header paths [] */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecReader.test.ts`. Expected: FAIL (the
  catches return `[]`/`null`).

- [ ] **Step 3: Rethrow in the three catches.**

- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Regenerate both 0.88 patches and run the byte tests.** Expected: PASS, nothing skipped.

- [ ] **Step 6: Commit.**

  ```bash
  git add vendor/rn-spm/spm/generate-spm-autolinking.js vendor/rn-spm/spm/expand-spm-dependencies.js \
    patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch tests/podspecReader.test.ts
  npm run scan:private
  git commit -m "fix: stop rn-spm on a podspec reader failure"
  ```

### Task 7: The reader in the scaffold marker, revision 8, fix 29

**Files:**
- Modify: `vendor/rn-spm/spm/scaffold-package-swift.js` (revision :121–139; marker emission :1944–1947; the result of
  `scaffoldPackageSwiftForDep` at :2503)
- Modify: `src/pipeline/patches.ts:362` (`SCAFFOLD_REVISION = 8`)
- Modify: `scripts/rn-spm-generate.js` (`writeResults`, :225–243: copies `reader`)
- Modify: `tests/rn-scaffolder.test.ts` (revision literals :160, :1112, :1125, :1132, :1217, :1320, :1335, :2154,
  :2166; the golden test :1202–1221), `tests/capabilities.test.ts:608`, `tests/support/rnScaffold.ts`,
  `tests/fixtures/scaffold-golden/**` (regenerated)
- Modify: `docs/upstream/react-native-scaffolder.md` (a "29." section before "Known limitation", :876; the Tests
  paragraph :886), `vendor/rn-spm/README.md:9` ("The 29 fixes"), both 0.88 patches

**Interfaces:**
- Consumes: `PodspecModel.reader` (Task 4).
- Produces: each scaffolded manifest's marker block ends with `// rn-xtool-podspec-reader: <ruby|reduced>`, after the
  slot comment (`slotComment`, :1662), so the existing adjacency of the revision, importer-paths, pods and slot lines
  is unchanged; the scaffold result and the driver's results file carry `reader`. Consumed by Task 9 and plan C.

- [ ] **Step 1: Write the failing tests** in `tests/rn-scaffolder.test.ts`:

  ```ts
  it("29: records the podspec reader in the marker", () => { /* scaffold a fixture with Ruby → manifest matches
     /^\/\/ Cache slot: .+\n\/\/ rn-xtool-podspec-reader: ruby$/m; forced reduced → "reduced"; result.reader equals it */ });
  ```

  and change every `revision: 7` literal listed above to 8 and `RN_XTOOL_SCAFFOLD_REVISION = 7` (:160) to 8.

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/rn-scaffolder.test.ts
  tests/capabilities.test.ts tests/patches.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the marker line and the revision.** `RN_XTOOL_SCAFFOLD_REVISION = 8`, with the comment
  "Revision 8 (fix 29): podspecs read by real Ruby through read-podspec-shim.rb, `ios` attributes merged, and the
  reader recorded in the marker." `SCAFFOLD_REVISION = 8` in `src/pipeline/patches.ts`.

- [ ] **Step 4: Make the golden run under Ruby.** `scaffoldLibraries` (`tests/support/rnScaffold.ts:81`) writes
  `<base>/app/package.json` (`{"name":"app","version":"1.0.0"}`) and `<base>/node_modules/react-native/package.json`
  (version 0.86.3, as `withRnRoot`) and sets `RN_SPM_APP_IOS_DIR` to `<base>/app/ios` for the run. The golden test
  skips without Ruby (`needsRuby` in its title) and, with `RN_XTOOL_WRITE_GOLDEN=1`, writes `statuses.json` and the
  files instead of comparing (a `writeGolden()` beside `readGolden()`).

- [ ] **Step 5: Run the tests to verify they pass, then regenerate the scaffold goldens.** Run: `npx vitest run
  tests/rn-scaffolder.test.ts tests/capabilities.test.ts tests/patches.test.ts` (PASS), then
  `RN_XTOOL_WRITE_GOLDEN=1 npx vitest run tests/rn-scaffolder.test.ts -t golden` with the reference app at `../app`
  (or `RN_XTOOL_REF_APP`), then once more without the variable (PASS). Read `git diff tests/fixtures/scaffold-golden`:
  every change is the revision line, the reader line, or a difference the shim explains (the `ios` merge, values fix 28
  left out). List each non-marker change in the task's report.

- [ ] **Step 6: Document fix 29** in `docs/upstream/react-native-scaffolder.md`: what failed (fact 6's ignored `ios`
  keys on the `pod` path, fact 4's stripped helpers, fix 28's partial reads), the shim's surface (Task 2's table in
  prose), the failure kinds, the reads file, and the marker line; the Tests paragraph names `tests/podspecShim.test.ts`,
  `tests/podspecReader.test.ts` and the sweep. `vendor/rn-spm/README.md`: "The 29 fixes".

- [ ] **Step 7: Regenerate both 0.88 patches and run the byte tests.** Expected: PASS, nothing skipped.

- [ ] **Step 8: Commit.**

  ```bash
  git add vendor/rn-spm/spm/scaffold-package-swift.js src/pipeline/patches.ts scripts/rn-spm-generate.js tests/rn-scaffolder.test.ts \
    tests/capabilities.test.ts tests/support/rnScaffold.ts tests/fixtures/scaffold-golden docs/upstream/react-native-scaffolder.md \
    vendor/rn-spm/README.md patches/react-native+0.88.0.patch patches/react-native+0.88.1.patch
  npm run scan:private
  git commit -m "feat: record the podspec reader, revision 8"
  ```

### Task 8: `ruby` in `doctor` and `setup`

**Files:**
- Create: `src/tools/podspecReader.ts`
- Modify: `src/commands/doctor.ts` (`DoctorProbes` :60–95, `realProbes` :171–225, a `ruby` check after `node` at
  :535–540, for both the full run and `projectOnly` :541–547)
- Modify: `src/commands/setup.ts` (`SetupDeps` :19–31; a line before the "Nothing to do" return :333–336 and on every
  other path)
- Modify: `tests/doctor.test.ts` (`good` :69), `tests/report.test.ts` (`probes` :70), `tests/setup.test.ts`,
  `tests/podspecReader.test.ts`

**Interfaces:**
- Consumes: `podspecReader()` (Task 3) through `createRequire` of `vendor/rn-spm/spm/read-podspec.js`, as
  `earlyChecks.ts:89–100` loads the vendored Expo readers.
- Produces:
  - `podspecReaderHere(env?: NodeJS.ProcessEnv): PodspecReaderChoice` and the TS type `PodspecReaderChoice` (same
    shape as Task 3's). Consumed by Tasks 9, 10 and plan C.
  - `rubyCheck(c: PodspecReaderChoice): Omit<DoctorCheck, "name">`: `ok` `3.3.8`; Ruby with `warning` → `warn`
    `3.3.8; <warning>`; forced → `warn` `RN_XTOOL_PODSPEC_READER=reduced is set — podspecs are read with the reduced
    reader`; otherwise `warn` `<why, "Ruby was not found" as "not found"> — podspecs are read with the reduced reader;
    sudo apt install ruby`.
  - `DoctorProbes.podspecReader: () => PodspecReaderChoice`; `SetupDeps.podspecReader`.
  - `setup` prints `✔ ruby <v>` or `⚠ <why>: rn-xtool reads podspecs with its reduced reader; install Ruby with: sudo
    apt install ruby`, and installs nothing.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  // tests/doctor.test.ts
  it("reports Ruby", async () => { /* podspecReader → {reader:"ruby", ruby:"3.3.8"} → check { name: "ruby", status: "ok", detail: "3.3.8" } right after node */ });
  it("warns without Ruby, also under --project", async () => { /* {reader:"reduced", why:"Ruby was not found"} with projectOnly
     → { name: "ruby", status: "warn", detail: "not found — podspecs are read with the reduced reader; sudo apt install ruby" }, report.ok true */ });
  it("names the forced reduced reader", async () => { /* forced → detail "RN_XTOOL_PODSPEC_READER=reduced is set — podspecs are read with the reduced reader" */ });
  // tests/setup.test.ts
  it("says whether Ruby is there and installs nothing", async () => { /* nothing to do + no Ruby → log contains the ⚠ line above; with Ruby "✔ ruby 3.3.8" */ });
  // tests/podspecReader.test.ts
  it("doctor and the scaffolder pick the same reader", () => { /* podspecReaderHere({ ...process.env, RN_XTOOL_PODSPEC_READER: "reduced" }) equals the JS podspecReader's answer */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/doctor.test.ts tests/setup.test.ts
  tests/report.test.ts tests/podspecReader.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the Interfaces block**; add `podspecReader` to the `good` and `probes` fixtures.

- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS. Then `npm run lint`: clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/tools/podspecReader.ts src/commands/doctor.ts src/commands/setup.ts tests/doctor.test.ts tests/report.test.ts \
    tests/setup.test.ts tests/podspecReader.test.ts
  npm run scan:private
  git commit -m "feat: report Ruby in doctor and setup"
  ```

### Task 9: Persisted scaffolds name their reader

**Files:**
- Modify: `src/pipeline/patches.ts` (`scaffoldPatchFindings` :433–503, `scaffoldPatchWarnings` :513–520)
- Modify: `tests/patches.test.ts` (the scaffold patch helper :874)

**Interfaces:**
- Consumes: the marker line (Task 7), `podspecReaderHere` (Task 8).
- Produces: `scaffoldReaderOf(patchText: string): "ruby" | "reduced" | undefined` (regex `^\+\/\/
  rn-xtool-podspec-reader: (ruby|reduced)\s*$`); a finding kind `"reader"` checked after `slot` and `revision` and
  before `pins`, using `podspecReaderHere()` computed once per call, only when a patch has the line (an injectable
  `reader?: PodspecReaderChoice` last parameter for tests):
  - patch `reduced`, here Ruby: `⚠ patches/<name> was written by the reduced podspec reader; Ruby is available here:
    delete it so rn-xtool regenerates it <tail>` (`tail` as today, :467);
  - patch `ruby`, here reduced: `⚠ patches/<name> was written by the Ruby podspec reader, and this machine reads
    podspecs with the reduced one (<why>): keep the patch, and install Ruby (sudo apt install ruby) before you
    regenerate it`.

- [ ] **Step 1: Write the failing tests:**

  ```ts
  it("warns when a reduced-reader scaffold meets Ruby", () => { /* patch with reader reduced, reader {ruby} → the first line above */ });
  it("warns when a Ruby scaffold meets the reduced reader", () => { /* reader ruby, here {reduced, why:"Ruby was not found"} → the second line */ });
  it("says nothing when the readers agree or the patch is older", () => { /* same reader → no line; revision 7 without the line → the revision line only */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/patches.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the Interfaces block.**

- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS; `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/patches.ts tests/patches.test.ts
  npm run scan:private
  git commit -m "feat: warn when a scaffold's reader differs"
  ```

### Task 10: `rn-spm` records the reads; the `⚠` line; `doctor --report`

**Files:**
- Create: `src/pipeline/podspecReads.ts`
- Modify: `src/paths.ts` (:22, :50: `podspecReads: join(iosBuild, "rn-xtool-podspec-reads.jsonl")`)
- Modify: `src/pipeline/rnSpm.ts` (`rnSpmEnv` :231–237; `runRnSpm` :484–640)
- Modify: `src/commands/report.ts` (`renderIssueReport` :257–280, `doctorReport` :315–345)
- Modify: `docs/troubleshooting.md` (a new `### Podspec reader` under "Build and patches", before "Scaffolded
  libraries" :974)
- Modify: `tests/rnSpm.test.ts` (:213, :256), `tests/report.test.ts`, `tests/podspecReads.test.ts` (create)

**Interfaces:**
- Consumes: the JSON lines of Task 4, `troubleshootingUrl` (`src/docs.ts`).
- Produces:
  - `rnSpmEnv` adds `RN_SPM_PODSPEC_READS: paths.podspecReads` and `RN_SPM_APP_IOS_DIR: paths.ios`.
  - `interface PodspecRead { podspec: string; reader: "ruby" | "reduced"; why?: string; forced: boolean; ruby?:
    string; warning?: string; env: string[]; helpers: string[]; ok: boolean; error?: string }`;
    `readPodspecReads(file: string): PodspecRead[]` (`[]` without the file; an unparsable line skipped);
    `readerLines(reads: PodspecRead[]): string[]` — at most two lines: the first read's `warning` as `⚠ <warning>`,
    and, when any read used the reduced reader, `⚠ <why>, so rn-xtool read the podspecs with its reduced reader, which
    evaluates a subset of Ruby; install Ruby (sudo apt install ruby) to read them as CocoaPods does. See
    <troubleshootingUrl("podspec-reader")>`, or when forced `⚠ RN_XTOOL_PODSPEC_READER=reduced is set, so rn-xtool
    read the podspecs with its reduced reader, which evaluates a subset of Ruby; unset it to read them as CocoaPods
    does. See <…>`; `podspecEnvLines(reads: PodspecRead[], root: string): string[]` — `ℹ podspec ENV — <podspec
    relative to root>: A, B` per read with names, sorted (consumed by plan D's log).
  - `runRnSpm` removes `paths.podspecReads` before its first run and, in a `finally`, logs `readerLines(...)` once.
  - `doctor --report` adds `ruby: <the ruby check's detail>` after `xtool:`, then `podspec reader: <ruby 3.3.8 |
    reduced: <why>> (last rn-spm, <n> podspecs)` or `podspec reader: not recorded`, then `podspec ENV:` and one
    indented `<podspec>: A, B` line per read with names; all inside the redacted block (R2, R4).

- [ ] **Step 1: Write the failing tests:**

  ```ts
  // tests/podspecReads.test.ts
  it("prints the reduced reader once per run", () => { /* two reduced reads → readerLines one line starting "⚠ Ruby was not found, so rn-xtool read the podspecs"
     and ending "See https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/troubleshooting.md#podspec-reader" */ });
  it("names the forced reader", () => { /* forced → "⚠ RN_XTOOL_PODSPEC_READER=reduced is set, so rn-xtool read …" */ });
  it("says nothing when Ruby read every podspec", () => expect(readerLines([rubyRead])).toEqual([]));
  it("lists the ENV names per podspec", () => { /* → ["ℹ podspec ENV — node_modules/x/X.podspec: RCT_NEW_ARCH_ENABLED, USE_FRAMEWORKS"] */ });
  // tests/rnSpm.test.ts
  it("hands the scaffolder the reads file and the iOS folder", () => { /* rnSpmEnv(...) includes RN_SPM_PODSPEC_READS and RN_SPM_APP_IOS_DIR */ });
  it("prints the reader line after rn-spm, also when it fails", async () => { /* fake runner writes two reduced lines then exits 1 → log has the ⚠ line once, then the error */ });
  // tests/report.test.ts
  it("records the last build's reader and ENV names", async () => { /* reads file with a forced read → report has "podspec reader: reduced: RN_XTOOL_PODSPEC_READER=reduced is set (last rn-spm, 2 podspecs)" for two forced reads and "podspec ENV:" */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/podspecReads.test.ts tests/rnSpm.test.ts
  tests/report.test.ts tests/docsLinks.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the Interfaces block**, and write `### Podspec reader` in troubleshooting: the two `⚠` lines
  and what to do; that rn-xtool reads podspecs with only `RCT_NEW_ARCH_ENABLED` and `RCT_HERMES_V1_ENABLED` set (`1`)
  and the names a podspec read are in `doctor --report` (row 11); the stop texts of Task 1 and the escape for one run;
  how to report (`rn-xtool doctor --report`).

- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS (`docsLinks` finds the anchor);
  `npm run lint` clean.

- [ ] **Step 5: Commit.**

  ```bash
  git add src/pipeline/podspecReads.ts src/paths.ts src/pipeline/rnSpm.ts src/commands/report.ts docs/troubleshooting.md \
    tests/podspecReads.test.ts tests/rnSpm.test.ts tests/report.test.ts
  npm run scan:private
  git commit -m "feat: say which podspec reader rn-spm used"
  ```

### Task 11: The user docs and the CHANGELOG

**Files:**
- Modify: `docs/how-it-works.md` ("CocoaPods-only libraries", the reader bullet that starts at :355)
- Modify: `docs/troubleshooting.md` (`### Podspec reader`, Task 10)
- Modify: `CHANGELOG.md` (`## [Unreleased]`, :6)

**Interfaces:**
- Consumes: the texts of Tasks 1–10.
- Produces: present-tense user text; no new code.

- [ ] **Step 1: Rewrite the reader bullet in how-it-works**: rn-xtool reads a podspec with the system Ruby and a shim
  of CocoaPods and React Native's helpers, the way CocoaPods runs it on a Mac and with the same trust as installing
  the library (its Ruby and `node` scripts run, row 18); it never runs `pod ipc spec`, so a machine with CocoaPods
  reads a podspec as any machine with Ruby (row 13); without Ruby the reduced reader (the subset the old bullet lists)
  reads it, with the `⚠` line; the reads file; the marker line.

- [ ] **Step 2: Complete troubleshooting's section**: podspecs read as with a Podfile that sets no globals
  (vision-camera's location APIs on, frame processors only when react-native-worklets-core is installed, row 14);
  delete a library's patch after changing its feature flags or installing an optional sibling (row 16); a persisted
  scaffold's reader warning (Task 9).

- [ ] **Step 3: Write the CHANGELOG entries** under `[Unreleased]`: an `### Upgrading` note (revision 8: every
  persisted scaffold patch gets the "older rn-xtool scaffolder (revision 7, now 8)" warning; delete each and rebuild;
  install Ruby, `sudo apt install ruby`, to read podspecs as CocoaPods does), `### Changed` (the Ruby reader, `pod ipc
  spec` no longer run, the `ios` merge, autolinking stops on a reader failure, `spm_dependency` refused by name, the
  `!` lines for unapplied keys), `### Added` (`ruby` in doctor and setup, `RN_XTOOL_PODSPEC_READER=reduced`, the
  report lines, the reader sweep and the mention check in CI).

- [ ] **Step 4: Verify.** Run: `npx vitest run tests/docsLinks.test.ts`. Expected: PASS. Every `@` in the new text sits
  in a code span (Task 14's test checks it from then on).

- [ ] **Step 5: Commit.**

  ```bash
  git add docs/how-it-works.md docs/troubleshooting.md CHANGELOG.md
  npm run scan:private
  git commit -m "docs: describe the Ruby podspec reader"
  ```

### Task 12: The reader sweep

**Files:**
- Create: `tests/podspecReaderSweep.test.ts`, `tests/support/podspecSweep.ts`, `tests/podspec-sweep.json`,
  `tests/fixtures/podspec-sweep/**` (goldens)
- Modify: `src/pipeline/scaffoldResources.ts` (export `podspecResources`, :100)

**Interfaces:**
- Consumes: `readPodspec`, `readPodspecNames`, `defaultReadPodspec` (vendored), `podspecFiles`, `podspecLines`,
  `unconditionalLineIndexes`, `podDependencies` (`src/project/podspecs.ts`), `podspecResources`, `tarballPath`,
  `packageFromTarball`, `needsTarball` (`tests/support/tarballs.ts`), `needsRuby` (Task 1).
- Produces:
  - `tests/podspec-sweep.json`: `[{ "spec": "<name>@<version>", "rn": "react-native@<x.y.z>", "with"?: ["<spec>", …]
    }]`; every `spec`, `rn` and `with` entry is pinned in `tests/tarballs.json`.
  - `sweepProject(entry): { root: string; podspecs: string[] }`: a temp `<root>/package.json`, `<root>/ios/`,
    `<root>/node_modules/<name>` and each `with` package extracted, and `<root>/node_modules/react-native` holding the
    `rn` tarball's `package.json` and `scripts/`; `podspecs` are `podspecFiles(<library>)` that exist.
  - The golden per podspec, `tests/fixtures/podspec-sweep/<spec with "/" as "+">/<podspec path with "/" as "__">.json`,
    with the temp root written as `<project>`:

    ```text
    { "shim": <PodspecModel> | { "error": String },
      "reduced": { "differs": { <field>: <reduced value>, … } } | { "error": String } | { "refused": String },
      "names": { "shim": {name, moduleName, headerDir} | null, "reduced": {…} | null },
      "env": [String], "helpers": [String],
      "tsReaders": { "dependencies": { "onlyTs": [], "onlyShim": [] }, "resourceBundles": { "onlyTs": [], "onlyShim": [] } } }
    ```

    `tsReaders` lists where the early checks' dependency lines and the resource reader disagree with the shim (row 29,
    fixed in alpha.9).
  - `RN_XTOOL_SWEEP_WRITE=1` writes the goldens instead of comparing.

- [ ] **Step 1: Write the failing test file** with the entries already cached (`react-native-screens@4.30.0`,
  `react-native-svg@15.16.0`, `react-native-gesture-handler@3.4.0`, `rn` `react-native@0.88.1`):

  ```ts
  for (const entry of SWEEP) for (const podspec of podspecsOf(entry))
    it.skipIf(skip(entry))(`reads ${entry.spec} ${podspec} as its golden${skipReason(entry)}`, () => {
      expect(record(entry, podspec)).toEqual(golden(entry, podspec));
    });
  it("keeps every library's names under both readers", () => expect(nameDifferences()).toEqual([]));
  it("has a golden for every podspec and no other", () => expect(orphanGoldens()).toEqual([]));
  it.runIf(process.env.CI === "true")("runs with Ruby on CI", () => expect(podspecReaderHere().reader).toBe("ruby"));
  ```

  `skip` is `needsTarball` for the entry's tarballs, and `needsRuby` off CI only (on CI a missing Ruby fails the last
  test, and a missing tarball fails, since CI fetched them).

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run tests/podspecReaderSweep.test.ts`. Expected: FAIL
  (no golden).

- [ ] **Step 3: Implement `tests/support/podspecSweep.ts`** (`sweepProject`, `record`, `golden`, `podspecsOf`,
  `nameDifferences`, `orphanGoldens`), with `RN_SPM_RN_ROOT` and `RN_SPM_APP_IOS_DIR` set per project and the reduced
  read under `vi.stubEnv("RN_XTOOL_PODSPEC_READER", "reduced")`.

- [ ] **Step 4: Write and read the goldens.** Run: `RN_XTOOL_SWEEP_WRITE=1 npx vitest run
  tests/podspecReaderSweep.test.ts`, then without the variable. Expected: PASS. Read each golden: a `shim.error` that
  is a shim gap is fixed in the shim first (Task 2's rule, with a `podspecShim` test), never written as the golden.

- [ ] **Step 5: Commit.**

  ```bash
  git add tests/podspecReaderSweep.test.ts tests/support/podspecSweep.ts tests/podspec-sweep.json tests/fixtures/podspec-sweep \
    src/pipeline/scaffoldResources.ts
  npm run scan:private
  git commit -m "test: sweep the podspec readers over libraries"
  ```

### Task 13: The sweep's set (network, with the owner's approval)

**Files:**
- Modify: `tests/tarballs.json`, `tests/podspec-sweep.json`, `tests/fixtures/podspec-sweep/**`
- Modify: `vendor/rn-spm/spm/read-podspec-shim.rb`, `tests/podspecShim.test.ts`, both 0.88 patches (only for a gap
  the sweep finds)
- Modify: `.github/workflows/ci.yml` (cache `tests/.cache`; `timeout-minutes`)

**Interfaces:**
- Consumes: Task 12's harness.
- Produces: R11's set pinned and swept.

- [ ] **Step 1: Ask the owner before downloading.** Show the list below (about 45 new tarballs, a few hundred MB, into
  `tests/.cache`) and wait for approval. The list, deduplicated against what `tests/tarballs.json` already pins:
  - R11's 30 (spec F.1, verbatim): `react-native-safe-area-context@5.11.1`, `react-native-screens@4.30.1`,
    `react-native-reanimated@4.7.1`, `react-native-gesture-handler@3.5.0`, `react-native-worklets@0.13.1`,
    `react-native-svg@15.16.1`, `@react-native-async-storage/async-storage@3.1.1`,
    `@react-native-masked-view/masked-view@0.3.2`, `react-native-webview@14.0.1`, `@sentry/react-native@8.34.0`,
    `@react-native-community/netinfo@12.0.1`, `react-native-keyboard-controller@1.23.0`,
    `@react-native-community/datetimepicker@9.3.0`, `react-native-get-random-values@2.1.0`,
    `react-native-nitro-modules@0.37.2`, `react-native-mmkv@4.3.2`, `@react-native-firebase/app@27.1.0`,
    `@shopify/react-native-skia@2.14.0`, `lottie-react-native@7.5.0`, `react-native-view-shot@6.2.1`,
    `@react-native-community/slider@5.2.2`, `react-native-pager-view@10.0.0`, `react-native-maps@1.29.11`,
    `react-native-device-info@15.0.2`, `@react-native-google-signin/google-signin@17.0.0`,
    `react-native-blob-util@0.25.1`, `react-native-purchases@11.0.1`, `@react-native-picker/picker@2.11.4`,
    `@react-native-clipboard/clipboard@1.16.3`, `react-native-permissions@5.6.3`; `rn` `react-native@0.88.1`;
  - the trial's: `react-native-screens@4.24.0`, `react-native-worklets@0.8.1`, `react-native-worklets@0.8.3`, `rn`
    `react-native@0.85.0`; and `react-native-vision-camera@4.7.3` (row 22's subspec case);
  - the reference apps' libraries at the versions installed in `../app-bare`, `../app-bare-086`, `../app-bare-087`
    (read each `node_modules/<pkg>/package.json`; `rn` the app's React Native);
  - the Expo SDK 57 and 58 template packages that ship a podspec where autolinking looks (`podspecFiles`), at the
    versions installed in `../app-expo-57` (SDK 57, `rn` 0.86.3) and `../app` (SDK 58 default template, `rn` 0.88.1).
  A podspec that raises without a sibling by design (`ExpoModulesWorkletsAdapter.podspec` without
  react-native-worklets) gets the sibling in `with`.

- [ ] **Step 2: Pin and fetch (network step, after approval).** For each new spec: `npm pack <spec>
  --pack-destination tests/.cache --json`, and append `{spec, file, integrity}` from its output to
  `tests/tarballs.json`. Then `node scripts/fetch-test-tarballs.mjs`: every line says `cached`. Record the total size
  of the new files (`du -ch` over them).

- [ ] **Step 3: Write the goldens and close the gaps.** Run: `RN_XTOOL_SWEEP_WRITE=1 npx vitest run
  tests/podspecReaderSweep.test.ts`. For each `shim.error`: a CocoaPods DSL name or a helper of fact 8 → model it in
  the shim with a `tests/podspecShim.test.ts` test, regenerate both 0.88 patches, run the byte tests, write again; a
  sibling the podspec needs → `with`; anything else → stop and bring it to the owner as a decision. Then run without
  the variable: PASS, and `nameDifferences()` empty (a difference goes to the owner as a decision, row 15).

- [ ] **Step 4: The owner reviews the goldens once** (spec Verification): give him, per library, the reduced reader's
  differing fields, the `env` names and the `tsReaders` lists, and wait for his approval before committing.

- [ ] **Step 5: CI.** In `.github/workflows/ci.yml`, an `actions/cache` step for `tests/.cache` keyed on
  `hashFiles('tests/tarballs.json')` before "Fetch the test tarballs"; set `timeout-minutes` to twice a measured local
  `node scripts/fetch-test-tarballs.mjs` from empty plus `npm test`, at least 15.

- [ ] **Step 6: Run everything.** Run: `npm test && npm run lint`. Expected: PASS, clean.

- [ ] **Step 7: Commit** (the shim's gaps, if any, first as their own `feat:` commit with the patches).

  ```bash
  git add tests/tarballs.json tests/podspec-sweep.json tests/fixtures/podspec-sweep .github/workflows/ci.yml
  npm run scan:private
  git commit -m "test: sweep R11's library set in CI"
  ```

### Task 14: The mention check

**Files:**
- Create: `scripts/check-mentions.mjs`, `tests/mentions.test.ts`, `.github/workflows/mentions.yml`
- Modify: `package.json` (`"check:mentions": "node scripts/check-mentions.mjs"`)
- Modify: `docs/RELEASING.md` ("Release", :34–44: a "Pull requests and release notes" paragraph)
- Modify: `CHANGELOG.md:47`, `docs/troubleshooting.md:292`, `:918`, `docs/upstream/react-native-scaffolder.md:498`,
  `docs/design/specs/2026-11-04-library-compat-design.md:44`, `docs/research/compat-suite-proposal.md:264`,
  `docs/research/rn-087-recon.md:41`, `:42`, `:46` (the fifteen of fact 32)

**Interfaces:**
- Consumes: nothing.
- Produces: `mentions(text: string): { line: number; word: string }[]` — outside fenced blocks (` ``` `, `~~~`) and
  code spans (a backtick run closed by a run of the same length), a `@` not preceded by a letter, digit, `_`, `` ` ``,
  `/`, `.`, `-` or `@`, followed by a GitHub login (`[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}`) not followed by `/` or a
  login character; a scoped `@scope/name` passes (R10). A code span that crosses a line break counts as one span.
  `node scripts/check-mentions.mjs [file…]` checks the files (no file: every `git ls-files '*.md'`), prints
  `<file>:<line>: @<word> notifies a GitHub user; put it in a code span or drop the @` per hit and exits 1, else
  prints nothing and exits 0. Not shipped (`package.json` `files` lists scripts by name).

- [ ] **Step 1: Write the failing tests** in `tests/mentions.test.ts`:

  ```ts
  it("finds a bare user mention", () => expect(mentions("use @import here\n")).toEqual([{ line: 1, word: "import" }]));
  it("passes code spans, fences, scoped names and e-mail addresses", () =>
    expect(mentions("`@import` and ``a `@x` b``\n```\n@y\n```\n@scope/name a@b.c\n")).toEqual([]));
  it("refuses hunk numbers written as mentions", () => expect(mentions("at @54 and @d11")).toEqual([{ line: 1, word: "54" }, { line: 1, word: "d11" }]));
  it("finds none in the tracked markdown or the local PR and notes files", () => { /* git ls-files '*.md' plus .superpowers/*.md when the folder exists → [] */ });
  ```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run tests/mentions.test.ts`. Expected: FAIL (no
  script; then fifteen hits).

- [ ] **Step 3: Write the script** and fix the fifteen mentions: `` `@import` `` in code spans; `` `@react-navigation` ``
  and `` `@d11` `` in code spans; the hunk numbers as "line 54", "line 113", "line 170", "line 844", "line 1099".

- [ ] **Step 4: Write the workflow** `.github/workflows/mentions.yml`: `on: pull_request: types: [opened, edited,
  reopened, synchronize]`, `permissions: contents: read`, one job that checks out, writes the body through an env
  variable (`BODY: ${{ github.event.pull_request.body }}`, then `printf '%s' "$BODY" > "$RUNNER_TEMP/body.md"`, never
  the expression inline in the script) and runs `node scripts/check-mentions.mjs "$RUNNER_TEMP/body.md"`.

- [ ] **Step 5: RELEASING.** Under "Release": write the PR text and the release notes into files, run `npm run
  check:mentions -- <file>` on each before `gh pr create --body-file <file>` and `gh release create <tag>
  --notes-file <file>`, and publish release notes from the checked file only, never typed into GitHub's page (rows
  113, 114).

- [ ] **Step 6: Run the tests to verify they pass.** Run: `npx vitest run tests/mentions.test.ts tests/packageFiles.test.ts
  tests/docsLinks.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit.**

  ```bash
  git add scripts/check-mentions.mjs tests/mentions.test.ts .github/workflows/mentions.yml package.json docs/RELEASING.md \
    CHANGELOG.md docs/troubleshooting.md docs/upstream/react-native-scaffolder.md docs/design/specs/2026-11-04-library-compat-design.md \
    docs/research/compat-suite-proposal.md docs/research/rn-087-recon.md
  npm run scan:private
  git commit -m "feat: refuse bare mentions in markdown"
  ```

### Task 15: Build-only proof on the reference apps (the owner's approval first)

**Files:**
- None committed but `CHANGELOG.md` if a result changes its text; results go to the task's report.

**Interfaces:**
- Consumes: everything above, built (`npm run build`).
- Produces: the evidence spec Verification asks for group A.

- [ ] **Step 1: Ask the owner** for the builds (each is minutes and gigabytes of SwiftPM output). Runs go through a
  delegated session, one build at a time, on copies of the reference apps, never the apps themselves.

- [ ] **Step 2: Bare 0.86, 0.87, 0.88 and Expo SDK 57, 58 with Ruby.** Per copy: delete `patches/*` scaffold patches,
  `rn-xtool build --clean`. Expected: the build finishes, no new stop, no `⚠` but the revision-8 lines; each
  scaffold's marker says `ruby`; each scaffolded library's `Package.swift` matches the sweep's golden model (same
  sources and defines). Record `rn-spm`'s time (row 24). A bare 0.85 reference, when the owner approves creating one
  with the drift watch's pinned CLI; otherwise recorded as not run.

- [ ] **Step 3: The same bare 0.88 copy with `RN_XTOOL_PODSPEC_READER=reduced`.** Expected: one `⚠
  RN_XTOOL_PODSPEC_READER=reduced is set …` line at `rn-spm`, markers say `reduced`, `doctor --report` shows the
  `podspec reader: reduced: …` and `podspec ENV:` lines; `rn-spm`'s time recorded.

- [ ] **Step 4: Without Ruby on `PATH`** (`PATH` stripped of Ruby's folder for one `doctor` and one `doctor
  --project`): `⚠ ruby — not found — podspecs are read with the reduced reader; sudo apt install ruby`.

- [ ] **Step 5: Hand the production app to the owner**: build it with the branch's `npm pack`; expected: scaffolds
  regenerated at revision 8 by Ruby, no new stop, react-native-screens' sources under `ios/` in its manifest. He runs
  it himself and reports.

- [ ] **Step 6: Report** each result, the times, and any difference from the goldens, to the owner. No commit unless
  a text changed.

---

## Deferred

- **Row 29** (the TypeScript readers in `src/project/earlyChecks.ts` and `src/pipeline/scaffoldResources.ts` keep
  their line readers): deferred to alpha.9, "one podspec model for every reader" (R5). Meanwhile Task 12's goldens list
  their disagreements with the shim per library (`tsReaders`).
- **Row 17** (one process per podspec), **row 24** (cost, measured in Task 15), **row 27** (the reduced reader's
  limits): accepted by the spec; nothing to build.
