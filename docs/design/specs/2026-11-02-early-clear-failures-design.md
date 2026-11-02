# Early, clear failures (design)

Status: short design, 2026-11-02. Week 1 of the stabilization plan agreed with Willy after the independent review in
`strategy/fable-review.md`. That plan defines "grow" as a stable tool anyone can use.

## Intent

A user must never meet a late or ambiguous failure for a cause rn-xtool already knows. Today several known causes
pass `doctor` and fail minutes later, or show raw upstream errors that look like the user's fault. A second problem is
that nothing outside the maintainer's machine verifies the tool: no CI runs the tests, and the tests of patched files
skip without the private reference app `../app`. This block fixes both.

## Goals

1. **Unsupported setups fail early, with a reason.** `doctor --project` and the start of `build` stop with a one-line
   reason and a docs link for:
   - a CocoaPods-only library that rn-xtool must scaffold and whose podspec declares `vendored_frameworks` or
     `vendored_libraries`. Expo modules served by the Expo plugin are excluded, because their precompiled frameworks
     work today (expo-router);
   - a CocoaPods-only library that compiles vendored C sources rn-xtool cannot scaffold (the expo-sqlite case);
   - a pnpm or Yarn PnP install (`pnpm-lock.yaml` with a `.pnpm` store, `.pnp.cjs`);
   - a project whose React Native or Expo packages are hoisted to a parent workspace folder.

   No reference app may trip a new check (no false positives).
2. **Apple sign-in failures are named as upstream problems.** xtool's auth output is matched for the known
   patterns:
   - HTTP 503 from GsService2;
   - an anisette server that is unreachable or hits its deadline;
   - a connect or TLS timeout to gsa.apple.com;
   - a 2FA code that never arrives.

   Each case gets a message that says it is Apple's or the anisette server's side, not the project. It gives the
   remedy (retry later; rn-xtool's pinned xtool version) and links the xtool issue. Unknown errors pass through
   unchanged.
3. **The free-account App ID limit is explained.** "maximum App ID limit has been reached … 10 App IDs every 7 days"
   becomes a message: a free Apple ID can register 10 App IDs per 7 days; reuse a bundle identifier already installed
   on the phone (set `ios.bundleIdentifier`), or wait.
4. **xtool 1.24.0.** Bump the pin from 1.23.0. Its release notes fix "another source of HTTP 503 errors when
   authenticating with an Apple ID". Update `XTOOL_VERSION` and `XTOOL_SHA256` for both architectures, taken from the
   official release assets.
5. **FUSE hint for Ubuntu 24.04.** The package is `libfuse2t64` on Ubuntu 24.04 and `libfuse2` on older releases.
   Update the README, how-it-works and `xtoolUnrunnableError` to name both.
6. **`rn-xtool doctor --report`.** It prints one paste-ready block for issues:
   - the rn-xtool, Node, Swift and xtool versions;
   - OS and architecture;
   - the project kind and versions;
   - the capability lines;
   - the result of every doctor check.

   It is redacted by construction:
   - the home folder becomes `~`;
   - no Apple ID or e-mail;
   - no Team ID, so bundle ids drop the `XTL-<team>.` prefix;
   - no device UDID;
   - no IP addresses;
   - no tokens.

   A test feeds it a fixture full of such values and asserts that none survives.
7. **Issue templates.** `.github/ISSUE_TEMPLATE/bug.yml` requires the `doctor --report` output, the command run, and
   expected and actual results. `library.yml` covers "my library does not build" and asks for the library, its version
   and the report. `config.yml` turns blank issues off.
8. **CI on every PR and on main.** `.github/workflows/ci.yml` runs `npm ci`, `npm run lint`, `npm test` and
   `npm run scan:private` (generic patterns only) on Node 22:
   - permissions are `contents: read`;
   - checkouts use `persist-credentials: false`;
   - no secrets are used.
9. **A public fixture instead of the private `../app`.** The tests that check the bundled patches against installed
   upstream files read from the pinned tarballs of the patched packages, in the cache `tests/.cache` used by the
   provenance tests. CI fetches those tarballs with `npm pack`. `../app` stops being needed for any test to run.
   Tests that still need a real app say so, and CI reports them as skipped by name, so a green run says what it
   verified.

## Non-goals

- Making the refused setups work. vendored_frameworks and binaryTarget support is week 4; pnpm and workspaces come
  later.
- Compiling or running a device in CI.
- Changing the floors policy.

## Failure walk

| # | Hop | Fails how | Who learns | Proposed ruling |
|---|-----|-----------|------------|-----------------|
| 1 | A new early check | a false positive blocks a project that would have built | user | handle: every check is tested on the five reference apps and on fixtures; a check never fires on Expo-plugin modules |
| 2 | A new early check | a false negative: a known-bad setup still passes | user, late | accept: the build fails as it does today; the check list grows from reports |
| 3 | Auth error mapping | xtool changes its wording, so a pattern stops matching | user sees the raw error, as today | accept: unknown text passes through unchanged; tests pin today's texts |
| 4 | xtool 1.24.0 download | checksum or asset missing for an architecture | `setup` fails with the existing checksum error | handle: hashes come from the official assets; device check before the PR |
| 5 | xtool 1.24.0 behaviour | a regression in build, sign or install | user | handle: full device run (SDK 57, SDK 58, bare) before the PR; revert the pin if anything breaks |
| 6 | `doctor --report` | a private value leaks into a public issue | everyone | handle: redaction by construction plus a test with planted values; the template tells the user to review before posting |
| 7 | CI | fetching tarballs fails (npm registry) | PR shows a red check | accept: re-run; the fetch is retried once |
| 8 | CI | tests that need a real app are skipped and CI is green | maintainer | handle: skipped tests are listed by name in the job summary |

## Verification

- Unit tests for each early check, each auth pattern, the App ID message, report redaction, and the template files
  (YAML parses, required fields).
- A CI run on the PR itself is green.
- `doctor --project` stays ok on the five reference apps.
- A device run with xtool 1.24.0: `auth`, `build` and `install` for SDK 57, SDK 58 and bare 0.88.1.

## Left to the builder

The exact message texts, which go in the plan, verbatim. Also the patterns for "hoisted to a parent folder" and the
CI job layout.
