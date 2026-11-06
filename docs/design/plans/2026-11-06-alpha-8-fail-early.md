# Release 0.1.0-alpha.8, fail early: plan skeleton

Status: skeleton, 2026-11-06. The [alpha.8 design](../specs/2026-11-06-alpha-8-fail-early-design.md) is approved, with
its rulings R1–R13. This file lists the task groups and the failure-walk rows each group owns; every row 1–118 has
exactly one owner. The tasks, their tests and the execution order are written next.

Plans: [plan 1, the podspec reader](2026-11-06-alpha-8-plan-1-podspec-reader.md) covers group A (rows 1–28), F1 (rows
104–108), F3 (rows 112–115) and records row 29 as deferred.

Two gates come before the groups that depend on them:

- **The device spike** (R9) runs first of all: it decides the build stamp's carrier (`RNXtoolBuildStamp`, then
  `CFBundleGetInfoString`, then another free-text key `Lookup` returns), so group D2 is built on its result.
- **The response-file capture** (R12) runs before group B's golden test: reference builds on the owner's machine, one at
  a time (approved by the owner on 2026-11-06), whose App-target response files are normalised (home folders become
  `/home/me`) before they enter `tests/fixtures/`.

## A. The podspec reader runs real Ruby (design A, scaffolder fix 29)

Rows 1–28: the Ruby probe and its lines in `build`, `doctor` and `setup` (1, 2), the fixed environment (3), the loud
failures and `RN_XTOOL_PODSPEC_READER=reduced` (4–8, R2), `node` calls (9), shim failures propagating from the
autolinking callers (10, R3), `ENV` names in the log and `doctor --report` (11, R4), `spm_dependency` (12),
`pod ipc spec` removed from the reader (13, R1), Podfile globals (14), identity fields (15), project state (16), one
process per podspec (17), side effects (18), output (19), the `ios` merge in `flattenSubspecs` (20), build keys the
scaffold does not apply (21), subspecs (22), the reader in the scaffold marker and `scaffoldPatchWarnings` (23, R5),
cost (24), the revision bump to 8 (25), shipping in the vendored copy and both 0.88 patches (26), the reduced reader's
`⚠` (27), model fields (28).

## B. The app target fails in seconds (design B)

Rows 30–55: B1 pass 1 in `doctor --project` and at `build` start (30–32), conditions, text forms, `@import` and
generated headers (33–36), the shared include-list function and pass 2's certainty rule (37, R6), B1 without a
toolchain (38), B2's command lines, their golden against the captured response files, and `--skip-precheck` (39, R2,
R12), the false pass (40), toolchain and module cache (41, 42), Swift and clang modules and `App-Swift.h` (43–45), the
app target's shapes: the non-CocoaPods xcconfig `⚠`, the synchronized-folder refusal, per-file flags (46–48, R6), time,
error location, warnings, beyond syntax (49–52), the Expo bridging header (53), `swift package describe` in the
precheck (54, R6), the anti-goal run on every reference app (55).

## C. Scaffold fidelity (design C)

Rows 56–70: the glob comparison for fresh scaffolds and the `⚠` for persisted ones (56, 57, R7), the scaffolder's
exclusion list, glob semantics, headers, scope and the reduced reader (58–62), the class check per target object and the
`no-objc-classes:<target>` allow key (63–66, R7), at least one class per target in the packed app (67–69, R7), both in
`install` (70).

## D. Reliability: logs, build stamp, USB retry (design D)

Rows 71–79: logs on disk per command (open, clean, children, signals, `start`'s own lines only, concurrency, ten kept,
the redacted tail in `doctor --report`, no log outside a project; R8, R13).

Rows 81–92: the build stamp, on the device spike's carrier (81, 82, R9), the mismatch, the existing Lookup errors, the
`⚠` for an unverified USB install (86, R9), the stale `.ipa`, repeat installs, per-build changes, the visible key,
`run`, states from alpha.7.

Rows 93–98: the USB retry after the four Wi‑Fi tries; no automatic retry after an interrupted `Install` (96, R9).

## E. The guide (design E)

Rows 99–103: `AGENTS.md` in the package, `rn-xtool agent-guide`, the guide test, the user's files, the user doc pages
shipped and listed in RELEASING step 4 (103, R10).

## F. Guards on rn-xtool (design F)

Rows 104–108 and 29: the permanent reader sweep in CI over R11's set (the 30 most-downloaded React Native libraries with
an iOS podspec, the trial's failing versions, the Expo SDK 57 and 58 template podspecs, the reference apps' libraries),
with the TypeScript readers' disagreements listed (29, the fix deferred to alpha.9).

Rows 109–111: the Objective-C target in the daily drift watch.

Rows 112–115: the mention check (script, test, `pull_request` workflow, RELEASING steps; scoped names pass, R10) and
the fifteen user-form mentions fixed.

## G. Follow-ups (design G)

Row 80: the `-fmodules-cache-path` filter (built on group D's tee).

Row 116: doctor's "N to download".

Row 117: the `RCTDependencyProvider` include path on 0.85.

Row 118: the DevTools `chrome-sandbox` section in troubleshooting.
