# Version floors and the daily drift watch (design)

Status: short design, 2026-10-29. Comes before the "own translator" project (a separate, full design).

## Intent

React Native and Expo patch releases must not break rn-xtool. Expo SDK 58 already uses a floor model since
0.1.0-alpha.3. SDK 57 and bare React Native still accept exact versions only. Expo shipped 57.0.30 on 2026-10-15 and
57.0.31 on 2026-10-21, so a 57.0.32 would break every SDK 57 user, the same way 58.0.21 broke alpha.2.

This block does two things, so users do not wait for us after every upstream patch:

1. Every supported line moves to a floor.
2. A daily job warns us before users notice.

Willy's rule (2026-10-29): a patch release must never need an rn-xtool update. "Supporting a version" means
"verified with it". The resilient fix is the own translator (next project). This block is the safety net until then.

## Goals

- **Expo SDK 57 becomes a floor**, like 58:
  - expo 57.0.31 and the other SDK 57 pins are the minimum;
  - a newer 57.x builds with the warning SDK 58 already prints;
  - an older one is an error;
  - react-native stays exact (0.86.3), because Expo's precompiled modules are built against it.
- **Bare React Native gets a floor per minor:**
  - 0.86.x accepts 0.86.2 or newer;
  - 0.87.x accepts 0.87.1 or newer;
  - 0.88.x accepts 0.88.0 or newer.

  A newer patch builds with a warning, as long as its prebuilt artifacts can be downloaded and G4 passes. The scripts
  mode (vendored or installed) is taken from the minor. Patch selection follows the SDK 58 rule: the exact patch,
  else the highest bundled patch of the same minor, which must apply (or the existing named error).
- **A daily drift watch on GitHub Actions** (hosted Ubuntu runner, no Swift, no Darwin SDK):
  - for each supported line, take the newest published version: `create-expo-app blank-typescript@sdk-57`,
    `@sdk-58`, `default@sdk-58`, and the newest bare 0.86.x, 0.87.x and 0.88.x;
  - install it and run the project gates (G1–G3);
  - check that the bundled patches apply (`patch -F0 --dry-run`) and that the portable-manifest rewrite still
    recognises reanimated/worklets.
- **Reporting:** one GitHub issue per broken line, labelled `drift`. The workflow updates it while the line stays
  broken and closes it when the line is green again. This is a proposal, not Willy's decision; he can switch it to
  email-only.

- **Patterns over versions (Willy, 2026-10-29).** Over time rn-xtool should recognise "this pattern, this
  architecture, this method" rather than "this version". A version becomes a "verified" label; what the project has
  decides. This block starts that shift:
  - **Capability detector.** `detectCapabilities(projectRoot)` returns facts about the project, not its version:
    - whether React Native ships its SwiftPM scripts, and their shape (which entry points and flags they have);
    - whether its prebuilt artifacts (React core, ReactNativeDependencies, Hermes) can be downloaded for the
      installed version;
    - whether Expo ships its SwiftPM plugin;
    - whether the Expo modules are precompiled or source;
    - which podspec features the autolinked libraries use (subspecs, `compiler_flags`, `header_dir`,
      `header_mappings_dir`, vendored frameworks, resource bundles).
  - **`doctor --project` prints the capabilities.** It shows what is recognised, what is not, and the verified
    version next to the installed one. An unsupported version gets a reason instead of a bare refusal, for example
    "React Native 0.81: no SwiftPM scripts; support comes with the translator".
  - **One decision moves from version to capability, with tests.** The scripts mode (rn-xtool's vendored scripts vs
    the installed ones) is chosen by whether the installed scripts have the shape rn-xtool needs. Today it comes
    from the version table. Later decisions move the same way, one at a time.
  - **Versions as data.** One table describes every supported line: the line, its floor, its verified version, the
    source of its scripts and the source of its artifacts. One piece of code reads it. Adding a line is one row plus
    its verification.
- **Weekly exploration of older lines (report only).** Once a week, the watch runs the capability detector on the
  newest Expo SDK 54, 55 and 56 templates and on fresh bare React Native 0.81 to 0.85 projects. It writes a table
  to the workflow summary and opens no issues. This is the evidence the translator project needs about how far back
  it can go.

## Non-goals

- No compile or device run in CI. That needs a self-hosted runner with the Darwin SDK, which is the compat-suite
  block.
- No G4 in CI. Precompiled Expo frameworks are downloaded only during a build; this could move to CI later.
- No new React Native minors (0.89) or older SDKs. Majors stay a deliberate, verified step.

## Approach

- **Gates:** `src/versions.ts` gets a `policy: "floor"` for SDK 57 and an `RN_LINES` table (minor → floor, scripts
  mode) in place of the exact `SUPPORTED_RN` list. The SDK 58 floor code (`checkExpoPackages`, patch selection,
  remedies) is reused, not copied.
- **Project-only check:** the drift watch needs to run the gates without Swift or xtool. It uses a project-only mode,
  for example `rn-xtool doctor --project`, that skips the toolchain and device checks. The flag is also useful to
  users.
- **Workflow:** `.github/workflows/drift-watch.yml`, with `schedule` (daily) and `workflow_dispatch`. It uses
  `GITHUB_TOKEN` with `issues: write` only.

## Failure walk

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | GitHub cron fires | skipped or late (GitHub disables schedules after 60 days without repo activity) | nobody | accept: the watch is best-effort; a monthly manual `workflow_dispatch` re-arms it; documented |
| 2 | npm registry / `create-expo-app` | network error or rate limit | workflow fails | handle: retry once; a network failure is reported as "watch could not run", not as drift |
| 3 | `npm install` of the fresh project | ERESOLVE upstream (like react-dom 19.3.1) | issue | handle: reported as drift with the npm output; often upstream, still useful to know |
| 4 | gates / patch dry-run | new patch release breaks a patch or a gate | issue | handle: the main purpose |
| 5 | issue API | token or permission error | workflow fails (email to Willy) | accept: GitHub's failure email is the fallback |
| 6 | duplicate issues | two runs open two issues for one line | — | handle: search for an open `drift` issue with the line's title before opening a new one |
| 7 | false green | the gates pass but the build would fail (G4 or compile) | users | accept for this block: written in the issue template and README as the watch's limit; the compat-suite CI closes it |
| 8 | floor accepts a newer patch that breaks at runtime | the app crashes on the device | users | accept: the build warning names the verified version; G4 catches symbol gaps; the remedy is to pin back |
| 9 | capability detector misreads a project (a new script shape it does not know) | wrong scripts mode chosen | build fails with the old error, or a wrong one | handle: an unknown shape is reported as "not recognised" and falls back to the version table; tests pin each known shape |
| 10 | weekly exploration of older lines (template download, artifact URL probes) | network failure or a template that no longer installs | workflow summary | accept: report only; a failed probe shows as "unknown" in the table |

## Verification

- **Unit tests:** floor policy for SDK 57 and RN lines (older → error, newer → warning, exact → silent), patch
  selection within a minor, the project-only doctor mode, the capability detector on fixture projects (one per
  known script shape, plus an unknown shape), and the scripts mode chosen by capability. The scripts mode must give
  the same result as today's version table for every supported version.
- **The workflow** is run once by hand (`workflow_dispatch`) and must be green on today's versions. One forced red
  run is also needed, for example a fake floor above the published version, to prove an issue gets opened and later
  closed.
- **Device:** no new device run. The verified versions do not change, and the device matrix from alpha.3 stands.

## Left to the builder

The exact workflow layout, the issue text, and how the bare apps are created in CI (`@react-native-community/cli
init` for the newest patch of each minor).
