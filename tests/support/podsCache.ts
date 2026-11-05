/** A pods cache whose spec folder holds git-source specs: the early checks read such a pod as a source pod. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

/** Versions each cached pod has, so any requirement the tests write finds one. */
const VERSIONS = ["1.0.0", "2.2.4", "3.0.0", "4.5.0", "5.19.0", "8.0.0", "99.0.0"];

/** Writes `<cache>/specs/<pod>/<version>.podspec.json` with a git source for each pod and version. */
export function writeGitSpecs(cache: string, pods: readonly string[]): void {
  for (const pod of pods) {
    for (const version of VERSIONS) {
      const dir = path.join(cache, "specs", pod);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${version}.podspec.json`),
        JSON.stringify({
          name: pod,
          version,
          homepage: "https://example.invalid/pod",
          license: { type: "MIT" },
          authors: "Example",
          source: { git: `https://example.invalid/git/${pod}.git`, tag: version },
          platforms: { ios: "13.0" },
          source_files: "Sources/**/*.{h,m}",
        }),
      );
    }
  }
}

/**
 * An XDG cache folder (for `XDG_CACHE_HOME`) whose rn-xtool pods cache holds git-source specs of `pods`, so a test
 * never reads the machine's own cache.
 */
export function gitSpecXdgCache(pods: readonly string[]): string {
  const xdg = mkdtempSync(path.join(tmpdir(), "rn-xtool-xdg-"));
  writeGitSpecs(path.join(xdg, "rn-xtool", "pods"), pods);
  return xdg;
}

/** Every pod name the library tests depend on. */
export const TEST_POD_NAMES = [
  "AppAuth", "Commented", "DVAssetLoaderDelegate", "Firebase", "Folly", "GoogleAds-IMA-iOS-SDK", "GoogleAds-IMA-tvOS-SDK",
  "GoogleMLKit", "Lottie", "MMKV", "PeerA", "PeerB", "RNSibling", "RNWorklets", "SDWebImage", "SPTPersistentCache", "Self",
  "TVOnly", "TVOnlyPod", "Y",
];

/**
 * For the whole test file: XDG_CACHE_HOME points at a git-spec cache of `pods` (set on process.env directly, so a
 * test's vi.unstubAllEnvs does not drop it), restored afterwards.
 */
export function useGitSpecCache(pods: readonly string[] = TEST_POD_NAMES): void {
  let xdg: string;
  const saved = process.env.XDG_CACHE_HOME;
  beforeAll(() => {
    xdg = gitSpecXdgCache(pods);
    process.env.XDG_CACHE_HOME = xdg;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
    rmSync(xdg, { recursive: true, force: true });
  });
}
