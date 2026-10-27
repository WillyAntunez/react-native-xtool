# Releasing

rn-xtool ships alpha builds under the npm `alpha` dist-tag. Supported platform: Linux x86_64. WSL2 on x86_64 should
work as Linux but is untested so far. arm64 Linux is untested (the xtool checksum is pinned for it, but nothing else is verified).

## Before releasing

1. `npm ci && npm test && npm run lint` are green.
2. `npm pack --dry-run` lists only `bin/`, `dist/`, `patches/`, `scripts/`, `shims/`, `README.md`, `LICENSE` and
   `package.json`. No `tests/`, `docs/`, `src/` or `.superpowers/`.
3. On a clean machine (or a fresh WSL2 distro) install the packed tarball and run `rn-xtool doctor`:
   `npm pack && npm i -g ./react-native-xtool-<version>.tgz && rn-xtool doctor`.
4. Repo-public checklist:
   - `LICENSE` is present and `package.json` says `MIT`.
   - No private names or paths: `npm run scan:private` (scans tracked files via `scripts/scan-private.sh`) must
     report clean.
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
