# Releasing

rn-xtool ships alpha builds under the npm `alpha` dist-tag. Supported platform: Linux x86_64. WSL2 on x86_64 should
work as Linux but is untested so far. arm64 Linux is untested (the xtool checksum is pinned for it, but nothing else is verified).

## Before releasing

1. `npm ci && npm test && npm run lint` are green.
1. `CHANGELOG.md` has the release under a new version heading (move the `Unreleased` entries there, with the date).
2. `npm pack --dry-run` lists only `bin/`, `dist/`, `patches/`, `scripts/`, `shims/`, `vendor/` (the vendored
   SwiftPM scripts and Expo plugin, needed at runtime), `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`. No
   `tests/`, `docs/`, `src/` or `.superpowers/`.
3. On a clean machine (or a fresh WSL2 distro) install the packed tarball and run `rn-xtool doctor`:
   `npm pack && npm i -g ./react-native-xtool-<version>.tgz && rn-xtool doctor`.
4. Repo-public checklist:
   - `LICENSE` is present and `package.json` says `MIT`.
   - No private names or paths: `npm run scan:private` (scans tracked files via `scripts/scan-private.sh`) must
     report clean.
     The full check needs the maintainer's local, untracked `.scan-private.local` (private patterns, one per line); without it only generic patterns run.
5. When `XTOOL_VERSION` changes, update `XTOOL_SHA256` in `src/versions.ts` for both architectures from the official
   release assets (`gh release download <version> -R xtool-org/xtool -p 'xtool-*.AppImage'`, then `sha256sum`).

## Release

```sh
npm login
npm version prerelease --preid alpha        # bumps package.json, commits, tags
npm publish --tag alpha --access public
git push --follow-tags
```

Then create a GitHub release from the tag with the notes (what changed, known limits, tested xtool/Swift/Expo
versions). Check the result: `npm view react-native-xtool dist-tags` and `npx react-native-xtool@alpha doctor`.

## Drift watch

`.github/workflows/drift-watch.yml` checks every day that rn-xtool still works with the newest patch release of each
line it supports, so a breaking upstream patch is found before users report it. It runs on a GitHub-hosted Ubuntu
runner with no Swift and no Darwin SDK, uses only `GITHUB_TOKEN`, and never compiles.

### What it checks

Daily (cron `23 5 * * *`, UTC), for each row of `SUPPORTED_LINES` in `src/versions.ts`, it creates a fresh project
with the newest published version of the line: `create-expo` 5.1.5 with `blank-typescript@sdk-57`,
`blank-typescript@sdk-58` and `default@sdk-58`, and `@react-native-community/cli init` (the CLI pinned per line) with
the newest 0.86.x, 0.87.x and 0.88.x. On each project it runs three checks:

- **gates**: `rn-xtool doctor --project`, whose exit code decides: the version gates (G1–G3, the bare floors), the
  scripts the build would pick, and whether the React Native artifacts are published;
- **patches**: a dry run of the bundled patches the build would stage (`patch -p1 -F0 --dry-run`; a patch already
  applied counts as applying, and a hunk more than 20 lines from its place does not, as in patch-package);
- **manifests**: the portable-manifest rewrite still recognises react-native-reanimated and react-native-worklets.

A create or install that fails for another reason than the network (ERESOLVE, for example) makes the line red. A
network failure is retried once, in an emptied folder; if the retry fails on the network too, the line reads
`unknown (could not run)`. Each line's status and failing steps go into the run summary.

### The `drift` issues

The report job keeps one GitHub issue per broken line, labelled `drift` and titled `Drift: Expo SDK 58` or
`Drift: React Native 0.88 (bare)`:

- A red line without an issue opens one. The body has the date the line was found broken, each target's versions
  and the last 60 lines of each failing step, the watch's limit (no compile, no G4) and a link to the run.
- While the line stays red, each run updates the body and keeps the first-broken date. When the cause changes (another
  failing target or step, or other error lines in a failing step), the run also adds a comment, so subscribers are
  notified.
- A line that turns green closes its issue with `Green again on <date>: <run>`.
- A line that breaks again reopens its most recent closed issue with `Broken again on <date>.` instead of opening a
  new one.
- A line that could not run touches no issue. Issues are matched by their exact title only: an issue renamed by hand
  is no longer touched, and the next red run opens a new one.

### Running it by hand

- `gh workflow run drift-watch.yml -f mode=daily` (or "Run workflow" in the Actions tab) runs the daily check.
- `-f drill=<line id>` (`expo-57`, `expo-58`, `bare-0.86`, `bare-0.87` or `bare-0.88`) marks that line red for one
  daily run, with a `drill` step, to test the issue path end to end: the run opens or updates that line's issue, and
  the next run without `drill` closes it. Any other value stops the report before it touches an issue. `drill` is
  ignored with `mode=explore`.
- `-f mode=explore` runs the weekly exploration.
- Locally, after `npm run build`: `node scripts/drift-watch.mjs` prints its subcommands. `check --existing` checks a
  project you already have instead of creating one, and `report --dry-run` prints the issue actions without calling
  `gh`.

### Weekly exploration

Weekly (cron `47 5 * * 1`, Mondays, UTC), report only: the newest Expo SDK 54, 55 and 56 `blank-typescript` templates
and fresh bare React Native 0.81 to 0.85 projects (the newest patch of each, the CLI pinned per minor) go through
the capability detector. The run summary gets an "Older lines (exploration, report only)" table: installed versions,
scripts, artifacts, Expo plugin, Expo modules, podspec features, and the reason rn-xtool does not support the line.
It opens no issue and never fails the run. A project that cannot be created, or a job that does not finish, shows as
`unknown` with `could not create: …` or `could not explore: the explore job did not finish`; only someone reading the
summary sees it.

### Adding a line

Adding a line takes one `SUPPORTED_LINES` row plus its verification on a device. An Expo row needs its
`createExpo` pin and a bare row its `cli` pin; `npm run lint` fails without them. The watch checks the new row from
its next run. The line then leaves the weekly exploration list: remove its SDK from `EXPLORE_EXPO_SDKS`, or its minor
from `EXPLORE_RN_MINORS` and `EXPLORE_RN_CLI`, in `src/drift/targets.ts`.

### Who learns, and the limits

- **Re-arm it monthly.** GitHub disables scheduled workflows after 60 days without repository activity, and nobody is
  told. Run `gh workflow run drift-watch.yml -f mode=daily` once a month.
- **A failed run emails the owner.** The run fails, and GitHub sends its failed-run email, when any target could not
  run (a network failure after the retry, a check that crashed or left no result) and when a `gh` call fails (a token
  or permission error, an issue list that cannot be read). That email is the only fallback when `gh` fails: nothing
  else reports it. Days with a network failure therefore send an email even when no line broke.
- **No compile, no device, no G4.** A green line can still fail G4 or the build, or crash on the device. The issue
  body and the README say so; a compat-suite CI with a self-hosted runner would close the gap.
- **Artifacts "unknown" stays green.** When `doctor --project` cannot check the React Native artifacts (network), the
  gates step stays green with `note: the React Native artifacts were not checked (network); they are checked again on
  the next run`. A line whose artifacts stay unchecked for days stays green meanwhile.
- **Third-party code can forge a green result.** Each check runs `create-expo` or the React Native CLI and
  `npm install`, so the packages' own install scripts run in the job that writes the result. A malicious or broken
  package could write a green result and close a drift issue. The check jobs have a read-only token and no issue
  permission; the impact is one wrongly closed issue.
- **The 20-line rule is approximated.** GNU patch reports a hunk's offset against its header line, while patch-package
  does not count the earlier hunks of the same file. On a patch with several hunks in one file, a hunk near 20 lines
  away can be judged differently by the two.
- **Overlapping runs.** The report job runs in the `drift-watch-report` concurrency group, so two runs never update
  issues at once. A third run that starts while one report waits cancels the waiting report, without an email; the
  next daily run reports the same lines.
