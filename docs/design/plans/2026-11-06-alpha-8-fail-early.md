# Release 0.1.0-alpha.8, fail early: plan skeleton

Status: skeleton, 2026-11-06. It lists the task groups of the
[alpha.8 design](../specs/2026-11-06-alpha-8-fail-early-design.md) and the failure-walk rows each group owns. The
tasks, their tests and the execution order are written after the owner approves the design and rules on its open
questions; the owner's calls among these rows may move a row to another group or to alpha.9.

## A. The podspec reader runs real Ruby (design A, scaffolder fix 29)

Rows 1–28: the Ruby probe and its lines in `build`, `doctor` and `setup` (1, 2), the fixed environment (3), the loud
failures and the escape (4–8), `node` calls (9), the autolinking callers (10), `ENV` names (11), `spm_dependency` (12),
the `pod` path (13), Podfile globals (14), identity fields (15), project state (16), one process per podspec (17),
side effects (18), output (19), the `ios` merge in `flattenSubspecs` (20), build keys the scaffold does not apply (21),
subspecs (22), the reader in the scaffold marker (23), cost (24), the revision bump to 8 (25), shipping in the vendored
copy and both 0.88 patches (26), the reduced reader's `⚠` (27), model fields (28).

## B. The app target fails in seconds (design B)

Rows 30–55: B1 pass 1 in `doctor --project` and at `build` start (30–32), conditions, text forms, `@import` and
generated headers (33–36), pass 2's certainty rule (37), B1 without a toolchain (38), B2's command lines and their
golden against Swift Build's response files (39, 40), toolchain and module cache (41, 42), Swift and clang modules and
`App-Swift.h` (43–45), the app target's shapes: xcconfig, synchronized folders, per-file flags (46–48), time, error
location, warnings, beyond syntax (49–52), the Expo bridging header (53), manifest planning (54), the anti-goal run on
every reference app (55).

## C. Scaffold fidelity (design C)

Rows 56–70: the glob comparison for fresh and persisted scaffolds, the scaffolder's exclusion list, glob semantics,
headers, scope and the reduced reader (56–62), the class check per target object (63–66), the class check in the packed
app (67–69), both in `install` (70).

## D. Reliability: logs, build stamp, USB retry (design D)

Rows 71–79: logs on disk per command (open, clean, children, signals, `start`, concurrency, rotation, privacy, commands
outside a project).

Rows 81–92: the build stamp (packing and `Lookup`, gated by the device spike first; mismatch; existing Lookup errors;
the USB Lookup; the stale `.ipa`; repeat installs; per-build changes; the visible key; `run`; states from alpha.7).

Rows 93–98: the USB retry after the four Wi‑Fi tries.

## E. The guide (design E)

Rows 99–103: `AGENTS.md` in the package, `rn-xtool agent-guide`, the guide test, the user's files, the user docs
shipped in the package.

## F. Guards on rn-xtool (design F)

Rows 104–108 and 29: the permanent reader sweep in CI, with the TypeScript readers' disagreements listed (29, deferred
to alpha.9 for the fix).

Rows 109–111: the Objective-C target in the daily drift watch.

Rows 112–115: the mention check (script, test, `pull_request` workflow, RELEASING steps) and the fifteen user-form
mentions fixed.

## G. Follow-ups (design G)

Row 80: the `-fmodules-cache-path` filter (built on group D's tee).

Row 116: doctor's "N to download".

Row 117: the `RCTDependencyProvider` include path on 0.85.

Row 118: the DevTools `chrome-sandbox` section in troubleshooting.
