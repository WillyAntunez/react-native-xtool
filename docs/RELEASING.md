# Releasing

rn-xtool ships alpha builds under the npm `alpha` dist-tag. Supported platform: Linux x86_64. WSL2 on x86_64 should
work as Linux but is untested so far. arm64 Linux is untested (the xtool checksum is pinned for it, but nothing else is verified).

## Before releasing

1. CI (`.github/workflows/ci.yml`) is green on the commit you release from `main`: do not release on a red or missing
   run. CI does not compile for iOS or touch a device, so the clean-machine check below still applies.
2. `npm ci && npm test && npm run lint` are green locally too (with `node scripts/fetch-test-tarballs.mjs` run first).
3. `CHANGELOG.md` has the release under a new version heading (move the `Unreleased` entries there, with the date).
4. `npm pack --dry-run` lists only `bin/`, `data/` (the shipped pod table, `data/pods.json`, and the vendors' terms
   URLs, `data/pod-terms.json`, both read at runtime),
   `dist/`, `patches/`, `scripts/`, `shims/`, `templates/` (the first-launch helper's sources, copied into the app),
   `vendor/` (the vendored SwiftPM scripts and Expo plugin, needed at runtime), `README.md`, `CHANGELOG.md`, `LICENSE`
   and `package.json`. No `tests/`, `docs/`, `src/` or `.superpowers/`. No Mach-O or `ar` file either: a vendor's
   binary is never shipped, and `tests/packageFiles.test.ts` (part of `npm test`) fails when the package would hold one.
5. On a clean machine (or a fresh WSL2 distro) install the packed tarball and run `rn-xtool doctor`:
   `npm pack && npm i -g ./react-native-xtool-<version>.tgz && rn-xtool doctor`.
6. On a device, a fresh install of a reference app without the dev client shows its icon on the home screen and
   loads after Allow without Reload.
7. Repo-public checklist:
   - `LICENSE` is present and `package.json` says `MIT`.
   - No private names or paths: `npm run scan:private` (scans tracked files via `scripts/scan-private.sh`) must
     report clean.
     The full check needs the maintainer's local, untracked `.scan-private.local` (private patterns, one per line); without it only generic patterns run.
8. When `XTOOL_VERSION` changes, update `XTOOL_SHA256` in `src/versions.ts` for both architectures from the official
   release assets (`gh release download <version> -R xtool-org/xtool -p 'xtool-*.AppImage'`, then `sha256sum`). Then
   re-read the entitlement table (`src/project/entitlementTable.ts`) against the new tag's source: the types xtool
   decodes (`EntitlementContainer.supportedTypes`), which capabilities it marks paid, and its identifier rewrite. Set
   `ENTITLEMENTS_CHECKED_WITH` to the new version once the table matches: `tests/entitlementTable.test.ts` ("the table
   was checked with the pinned xtool") fails until then.

## Release

```sh
npm login
npm version prerelease --preid alpha        # bumps package.json, commits, tags
npm publish --tag alpha --access public
git push --follow-tags
```

Then create a GitHub release from the tag with the notes (what changed, known limits, tested xtool/Swift/Expo
versions), from a checked file as below. Check the result: `npm view react-native-xtool dist-tags` and
`npx react-native-xtool@alpha doctor`.

**Pull requests and release notes.** A bare `@name` outside a code span notifies that GitHub user, and in release
notes lists them as a contributor. Write the text of a pull request and the release notes into files, check each one,
and give GitHub the checked file:

```sh
npm run check:mentions -- <file>    # names each bare mention and fails; put it in a code span or drop the @
gh pr create --body-file <file>
gh release create <tag> --notes-file <file>
```

Publish release notes from the checked file only, never typed or pasted into GitHub's release page. CI checks the
Markdown files in the repo (`tests/mentions.test.ts`), and the Mentions workflow
(`.github/workflows/mentions.yml`) checks a pull request's description again each time it is opened, edited or
pushed to.

## Scaffolder changes

React Native's scaffolder ships twice: as `patches/react-native+0.88.0.patch` and its byte-identical copy
`react-native+0.88.1.patch`, applied to an installed 0.88.x, and as `vendor/rn-spm/`, pristine 0.88.0 with that patch
and `vendor/rn-spm/rn-xtool-edits.patch` (E1–E6) applied, for 0.85–0.87 and Expo SDK 57. A change to the scaffolder:

1. Edits the vendored copy (`vendor/rn-spm/spm/*.js`), and documents the fix in
   [upstream/react-native-scaffolder.md](upstream/react-native-scaffolder.md) and the count in
   [vendor/rn-spm/README.md](../vendor/rn-spm/README.md).
2. Regenerates both 0.88 patches from it, never by editing them as text, so they stay identical. From the repo root:

   ```sh
   T=$(mktemp -d); mkdir -p "$T/x" "$T/a/node_modules/react-native" "$T/b/node_modules/react-native/scripts"
   tar -xzf tests/.cache/react-native-0.88.0.tgz -C "$T/x" package/scripts/setup-apple-spm.js package/scripts/spm \
     package/scripts/codegen/templates/Package.swift.spm-template
   cp -a "$T/x/package/scripts" "$T/a/node_modules/react-native/scripts"
   cp -a vendor/rn-spm/setup-apple-spm.js vendor/rn-spm/spm vendor/rn-spm/codegen \
     "$T/b/node_modules/react-native/scripts/"
   patch -R -p1 -F0 --no-backup-if-mismatch -d "$T/b/node_modules/react-native/scripts" \
     -i "$PWD/vendor/rn-spm/rn-xtool-edits.patch"
   (cd "$T" && git diff --no-index --no-color --src-prefix= --dst-prefix= \
      a/node_modules/react-native/scripts b/node_modules/react-native/scripts) \
     | sed -E 's#^diff --git [ab]/([^ ]+) [ab]/#diff --git a/\1 b/#' > "$T/rn.patch"
   cp "$T/rn.patch" patches/react-native+0.88.0.patch && cp "$T/rn.patch" patches/react-native+0.88.1.patch
   ```

   The `sed` gives a new file's header the `a/` side patch-package reads (`git diff --no-index` names both sides
   `b/`, and patch-package then refuses the whole patch).

   When the reverse `patch` fails, the change moved the context of an E-edit. That `b/` is half-reversed and holds
   `.rej` files, so a diff from it would drop the E-edit from `rn-xtool-edits.patch` and move it into the 0.88 patch.
   Copy the vendored files into a new `b/`, rerun the reverse without `-F0` (`patch -R -p1 --no-backup-if-mismatch`),
   and check that it leaves no `.rej` file (`find "$T/b" -name '*.rej'` prints nothing; if it does, update that hunk of
   `rn-xtool-edits.patch` by hand first). Regenerate `rn-xtool-edits.patch` as the diff from that `b/` tree to
   `vendor/rn-spm/` (`git diff --no-index --src-prefix=a/ --dst-prefix=b/`, paths relative to `scripts/`), delete
   `$T`, then run the steps again.
3. Bumps the scaffold revision when the change alters what a scaffold writes (a manifest, a shim, a marker):
   `RN_XTOOL_SCAFFOLD_REVISION` in `vendor/rn-spm/spm/scaffold-package-swift.js` and `SCAFFOLD_REVISION` in
   `src/pipeline/patches.ts`, together (a test keeps them equal). Users then get the "older rn-xtool scaffolder"
   warning for each persisted scaffold patch, so the CHANGELOG's "Upgrading" section says so. A change that alters no
   scaffold output keeps the revision.
4. Regenerates the goldens in `tests/fixtures/scaffold-golden/` when the reference app's manifests change (the golden
   test reads `RN_XTOOL_REF_APP`, else `../app`).

The byte tests need the pinned tarballs in `tests/.cache` (`node scripts/fetch-test-tarballs.mjs`); without them they
skip, and the vitest summary says so. Before committing a scaffolder change, run `npx vitest run
tests/vendor-rn-spm.test.ts tests/patches.test.ts tests/patches-upstream.test.ts tests/rn-scaffolder.test.ts` and check
that none of the provenance, identical-patch, upstream dry-run or "the patched RN files carry the patch" tests is
skipped. Each new fix adds one hunk test to "the patched RN files carry the patch".

A CocoaPods pod mapped to its SwiftPM package is data, not a scaffolder change: add it to `data/pods.json`, which
`tests/podTable.test.ts` checks with the config's `pods` rules. The scaffolder's own `KNOWN_POD_SPM_PACKAGES` keeps its
one baseline entry, so the 0.88 patches and the scaffold revision stay as they are. Pin `exact` to the newest tag the
library's podspec requirement accepts that builds, and check that the tag ships a `Package.swift`. Changing a shipped
pin makes every persisted scaffold of that library stale: users get the `⚠ patches/<file> pins <pod> <old>,
rn-xtool's table says <new>` line until they regenerate it, so name the change in the CHANGELOG.

## Binary pods

**The cache's versions.** The pods cache keeps extracted and wrapped trees across releases, named by their archive and
their stamp. When a change alters what `extractPod` (`src/pods/archive.ts`) or `wrapPod` (`src/pods/wrap.ts`) writes
into a tree, bump `EXTRACTOR_VERSION` (for `extractPod`) or `WRAPPER_VERSION` (for `wrapPod`) in the same commit.
Users' trees made by the old code are then rebuilt instead of reused; a wrapped tree's key holds `EXTRACTOR_VERSION`
too, so an extractor bump rebuilds both. A change that alters no tree content keeps the version. The old trees stay in
users' caches until they delete `~/.cache/rn-xtool/pods`, which the troubleshooting page says is safe.

**The source pods in `data/pods.json`.** A binary pod's git-source dependencies (ML Kit's GTMSessionFetcher,
GoogleUtilities, GoogleDataTransport and GoogleToolboxForMac) are pod table entries like any other, pinned to the
newest tag the binary pods' requirements accept that ships a `Package.swift`. When no such tag exists
(GoogleToolboxForMac 4.x has none), pin the nearest one that does only after a build proves the binaries link against
it (the post-pack checks pass and the symbols the binaries need are in the App binary), and give the entry an
`outsideRequirement` sentence saying why: the pin check then prints that one `ℹ` line instead of the `⚠`. A target
the package declares without sources, which Swift Build lists at link anyway (`GTMDefines`), goes in the entry's
`emptyTargets`. A changed pin is a changed table entry, so the scaffolder section's CHANGELOG note applies.

**`data/pod-terms.json`** maps a spec's `homepage` to the vendor's terms page, which the line before the first
download names (`terms: …`). Both are https URLs (the `podTerms` test in `tests/pods/step.test.ts` checks the
shape). When rn-xtool links binary pods of a new vendor, check the terms page and add its entry; a homepage the file
does not list gets no `terms:` part, and the line still names the vendor, the licenses and the homepage from the
spec.

**CocoaPods trunk is read-only from 2026-12-02.** No version is added or changed after that date, so the specs
rn-xtool caches per version stay valid, and a pin or a fixture taken from the CDN does not move. The CDN stays up as
long as GitHub and jsDelivr do; a machine with the cache and the lock keeps building if it goes away.

## Drift watch

`.github/workflows/drift-watch.yml` checks every day that rn-xtool still works with the newest patch release of each
line it supports, so a breaking upstream patch is found before users report it. It runs on a GitHub-hosted Ubuntu
runner with no Swift and no Darwin SDK, uses only `GITHUB_TOKEN`, and never compiles.

### What it checks

Daily (cron `23 5 * * *`, UTC), for each row of `SUPPORTED_LINES` in `src/versions.ts`, it creates a fresh project
with the newest published version of the line: `create-expo` 5.1.5 with `blank-typescript@sdk-57`,
`blank-typescript@sdk-58` and `default@sdk-58`, and `@react-native-community/cli init` (the CLI pinned per line) with
the newest 0.85.x, 0.86.x, 0.87.x and 0.88.x. On each project it runs three checks:

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
- `-f drill=<line id>` (`expo-57`, `expo-58`, `bare-0.85`, `bare-0.86`, `bare-0.87` or `bare-0.88`) marks that line
  red for one daily run, with a `drill` step, to test the issue path end to end: the run opens or updates that line's
  issue, and the next run without `drill` closes it. Any other value stops the report before it touches an issue.
  `drill` is ignored with `mode=explore`.
- `-f mode=explore` runs the weekly exploration.
- Locally, after `npm run build`: `node scripts/drift-watch.mjs` prints its subcommands. `check --existing` checks a
  project you already have instead of creating one, and `report --dry-run` prints the issue actions without calling
  `gh`.

### Weekly exploration

Weekly (cron `47 5 * * 1`, Mondays, UTC), report only: the newest Expo SDK 54, 55 and 56 `blank-typescript` templates
and fresh bare React Native 0.81 to 0.84 projects (the newest patch of each, the CLI pinned per minor) go through
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
