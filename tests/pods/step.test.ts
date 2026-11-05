import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tilde } from "../../src/commands/setup.js";
import { troubleshootingUrl } from "../../src/docs.js";
import type { ArRunner } from "../../src/pods/ar.js";
import { podShard } from "../../src/pods/cdn.js";
import { formatSize } from "../../src/pods/format.js";
import { PODS_LOCK, readPodsLock, recordedLine, renderPodsLock, writePodsLock } from "../../src/pods/lock.js";
import type { PodRoot } from "../../src/pods/resolve.js";
import { POD_APP_COPY_FACTOR, POD_DISK_FACTOR, podTerms, runPodsStep, type PodsStepDeps } from "../../src/pods/step.js";
import { mergedPodTable } from "../../src/project/podTable.js";
import { arArchive, machO } from "../support/macho.js";
import { tarGz, type ArchiveSpec } from "../support/archives.js";
import { fixtureSpec, podsCdnRoutes } from "../support/podFixtures.js";
import { closedPortBase, startPodsServer, type PodsServer } from "../support/podsServer.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
const LANGS = ["Chinese", "Devanagari", "Japanese", "Korean"];
const ROOTS: PodRoot[] = ["", ...LANGS].map((lang) => ({
  library: LIB,
  libraryVersion: "2.0.0",
  dependency: `GoogleMLKit/TextRecognition${lang}`,
  requirements: ["8.0.0"],
}));
const VERSIONS: Record<string, string> = {
  GoogleMLKit: "8.0.0",
  MLImage: "1.0.0-beta7",
  MLKitCommon: "13.0.0",
  MLKitTextRecognition: "6.0.0",
  ...Object.fromEntries(LANGS.map((l) => [`MLKitTextRecognition${l}`, "5.0.0"])),
  MLKitTextRecognitionCommon: "5.0.0",
  MLKitVision: "9.0.0",
};
const BINARY = Object.keys(VERSIONS).sort();
const INDEX: Record<string, string[]> = Object.fromEntries(Object.entries(VERSIONS).map(([p, v]) => [p, [v]]));
const HOST = "example.invalid";
const TERMS = { "https://example.invalid/ml-kit/guides": "https://example.invalid/ml-kit/terms" };
/** Bytes that do not compress, so the tarballs' sizes follow their payloads. */
const noise = (seed: string, n: number): Buffer => {
  const parts: Buffer[] = [];
  for (let i = 0; parts.length * 32 < n; i++) parts.push(createHash("sha256").update(`${seed}${i}`).digest());
  return Buffer.concat(parts).subarray(0, n);
};
/** Payload sizes: MLKitTextRecognitionCommon is the largest, MLKitCommon second. */
const PAYLOAD: Record<string, number> = { MLKitTextRecognitionCommon: 40_000, MLKitCommon: 20_000 };

/** A tarball in the pod's shape: its framework (a thin arm64 archive, headers, a module map) and its resource folders. */
function tarball(pod: string, version: string): Buffer {
  const spec = fixtureSpec(pod, version);
  const entries: ArchiveSpec[] = [{ type: "file", path: "NOTICES", body: "notices" }];
  if (pod === "GoogleMLKit") {
    entries.push(
      { type: "file", path: "MLKitCore/Sources/MLKit.h", body: "// MLKit" },
      { type: "file", path: "MLKitCore/Sources/module.modulemap", body: 'module MLKit {\n  umbrella header "MLKit.h"\n  export *\n}\n' },
      { type: "file", path: "MLKitCore/NOTICES", body: "notices" },
    );
  } else {
    const fw = `Frameworks/${pod}.framework`;
    const object = machO({ cpu: "arm64", build: { platform: 2, minos: "15.5" }, payload: noise(pod, PAYLOAD[pod] ?? 500).toString("latin1") });
    entries.push(
      { type: "file", path: `${fw}/${pod}`, body: arArchive([{ name: `${pod}.o`, data: object }]) },
      { type: "file", path: `${fw}/Headers/${pod}.h`, body: `// ${pod}` },
      {
        type: "file",
        path: `${fw}/Modules/module.modulemap`,
        body: `framework module ${pod} {\n  umbrella header "${pod}.h"\n  export *\n  module * { export * }\n}\n`,
      },
    );
    if (pod === "MLKitCommon") entries.push({ type: "file", path: `${fw}/PrivacyInfo.xcprivacy`, body: "<plist/>" });
  }
  for (const key of Object.keys((spec.resource_bundles as Record<string, unknown> | undefined) ?? {})) {
    entries.push({ type: "file", path: `Resources/${key}/model.bin`, body: noise(key, 300) });
  }
  return tarGz(entries);
}

const TARBALLS = Object.fromEntries(BINARY.map((p) => [p, tarball(p, VERSIONS[p]!)]));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const dlPath = (pod: string): string => `/dl/${pod}-${VERSIONS[pod]}.tar.gz`;

/** A fake llvm-ar that writes an archive holding the object. */
const fakeAr: ArRunner = async (args) => {
  writeFileSync(args[2]!, arArchive([{ name: path.basename(args[3]!), data: readFileSync(args[3]!) }]));
  return "";
};

/** Every framework and library the fixture specs link, as .tbd files in an SDK folder. */
function fakeSdk(dir: string, leaveOut: string[] = []): string {
  const sdk = path.join(dir, leaveOut.length === 0 ? "iPhoneOS.sdk" : `iPhoneOS-${leaveOut.join("-")}.sdk`);
  mkdirSync(path.join(sdk, "usr", "lib"), { recursive: true });
  writeFileSync(path.join(sdk, "SDKSettings.json"), JSON.stringify({ DisplayName: "iOS 27.1" }));
  const frameworks = new Set<string>();
  const libraries = new Set<string>();
  for (const pod of BINARY) {
    const spec = fixtureSpec(pod, VERSIONS[pod]!) as { frameworks?: string[]; weak_frameworks?: string[]; libraries?: string[] };
    for (const f of [...(spec.frameworks ?? []), ...(spec.weak_frameworks ?? [])]) frameworks.add(f);
    for (const l of spec.libraries ?? []) libraries.add(l);
  }
  for (const f of frameworks) {
    if (leaveOut.includes(f)) continue;
    mkdirSync(path.join(sdk, "System", "Library", "Frameworks", `${f}.framework`), { recursive: true });
    writeFileSync(path.join(sdk, "System", "Library", "Frameworks", `${f}.framework`, `${f}.tbd`), "--- !tapi-tbd\n");
  }
  for (const l of libraries) if (!leaveOut.includes(l)) writeFileSync(path.join(sdk, "usr", "lib", `lib${l}.tbd`), "--- !tapi-tbd\n");
  return sdk;
}

const realFetch = globalThis.fetch;
let work: string;
let root: string;
let cache: string;
let server: PodsServer;
let logs: string[];
/** The number of requests the server had seen when each line was logged. */
let seenAt: number[];

/** Sends requests for example.invalid to `base`, as the fixtures' URLs point there. */
function routeTo(base: string): void {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(u.hostname === HOST ? `${base}${u.pathname}${u.search}` : input, init);
  });
}

beforeEach(async () => {
  work = mkdtempSync(path.join(tmpdir(), "pods-step-"));
  root = path.join(work, "app");
  cache = path.join(work, "cache");
  mkdirSync(root);
  server = await startPodsServer(podsCdnRoutes(INDEX, podShard));
  for (const pod of BINARY) server.routes[dlPath(pod)] = { body: TARBALLS[pod]! };
  routeTo(server.base);
  logs = [];
  seenAt = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

const deps = (over: Partial<PodsStepDeps> = {}): PodsStepDeps => ({
  cdnBase: server.base,
  cache,
  ar: fakeAr,
  sdkDir: over.sdkDir ?? fakeSdk(work),
  filesystemOf: async () => ({ dev: 1, freeBytes: 1e12 }),
  terms: TERMS,
  log: (l) => {
    logs.push(l);
    seenAt.push(server.requests.length);
  },
  ...over,
});
const table = () => mergedPodTable();
const downloads = (): string[] => server.requests.filter((r) => r.startsWith("GET /dl/"));
const total = BINARY.reduce((sum, p) => sum + TARBALLS[p]!.length, 0);

describe("runPodsStep", () => {
  it("resolves, downloads, wraps and records ML Kit's shape", async () => {
    const result = await runPodsStep(root, ROOTS, table(), deps());
    expect(result.resolution.binary.map((b) => b.pod)).toEqual(BINARY);
    expect(result.wrapped.map((w) => w.pod)).toEqual(BINARY);
    expect(result.binary).toEqual({ GoogleMLKit: { product: "GoogleMLKit" } });
    const lock = readPodsLock(root);
    expect(Object.keys(lock.pods).sort()).toEqual(BINARY);
    expect(lock.pods.MLKitCommon).toEqual({
      version: "13.0.0",
      subspecs: expect.any(Array),
      url: `https://${HOST}${dlPath("MLKitCommon")}`,
      size: TARBALLS.MLKitCommon!.length,
      sha256: sha(TARBALLS.MLKitCommon!),
      neededBy: [LIB],
    });
    expect(result.lock).toEqual(lock);
    expect(result.bundles.map((b) => b.key).sort()).toEqual(
      ["Chinese", "Devanagari", "Japanese", "Korean", "Latin"].map((l) => `${l}OCRResources`),
    );
    expect(result.bundles.find((b) => b.key === "LatinOCRResources")).toMatchObject({
      globs: ["Resources/LatinOCRResources/**"],
      owner: "MLKitTextRecognition 6.0.0",
    });
    const latin = result.bundles.find((b) => b.key === "LatinOCRResources")!;
    expect(existsSync(path.join(latin.baseDir, "Resources", "LatinOCRResources", "model.bin"))).toBe(true);
    expect(logs.at(-1)).toBe(recordedLine(10));
    expect(downloads()).toHaveLength(10);
  });

  it("announces vendor, count, size, host, license, homepage and terms before the first download", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const at = logs.findIndex((l) => l.startsWith("ℹ pods — ") && l.includes("CocoaPods binaries that are not in"));
    expect(at).toBeGreaterThanOrEqual(0);
    const firstGet = server.requests.findIndex((r) => r.startsWith("GET /dl/"));
    expect(seenAt[at]).toBeLessThanOrEqual(firstGet);
    const sizes = BINARY.map((p) => ({ p, n: TARBALLS[p]!.length })).sort((a, b) => b.n - a.n || (a.p < b.p ? -1 : 1));
    expect(sizes[0]!.p).toBe("MLKitTextRecognitionCommon");
    const list = sizes.map(({ p, n }) => `${p} ${VERSIONS[p]} (${formatSize(n)})`).join(", ");
    expect(logs[at]).toBe(
      `ℹ pods — ${LIB} needs 10 CocoaPods binaries that are not in rn-xtool's cache, ${formatSize(total)} from ${HOST}: ${list}. ` +
        `From Google, Inc. ("Copyright 2024 Google LLC", "Copyright 2025 Google LLC"; https://example.invalid/ml-kit/guides; ` +
        `terms: https://example.invalid/ml-kit/terms). rn-xtool keeps them in ${tilde(cache)} and does not copy them into the project.`,
    );
  });

  it("says it, not them, in the announcement of one binary", async () => {
    const one: PodRoot = { library: LIB, libraryVersion: "2.0.0", dependency: "MLImage", requirements: ["1.0.0-beta7"] };
    await runPodsStep(root, [one], table(), deps());
    const line = logs.find((l) => l.includes("not in rn-xtool's cache"));
    expect(line).toContain(`${LIB} needs 1 CocoaPods binary that is not in rn-xtool's cache`);
    expect(line).toMatch(/ rn-xtool keeps it in \S+ and does not copy it into the project\.$/);
  });

  it("makes no request with the lock and a full cache", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const lockBytes = readFileSync(path.join(root, PODS_LOCK), "utf8");
    server.requests.length = 0;
    logs = [];
    const again = await runPodsStep(root, ROOTS, table(), deps());
    expect(server.requests).toEqual([]);
    expect(logs.some((l) => l.includes("not in rn-xtool's cache"))).toBe(false);
    expect(logs.some((l) => l.startsWith("ℹ pods — recorded"))).toBe(false);
    expect(readFileSync(path.join(root, PODS_LOCK), "utf8")).toBe(lockBytes);
    expect(again.wrapped.map((w) => w.pod)).toEqual(BINARY);
  });

  it("downloads again and verifies against the lock after the cache is deleted", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const lockBytes = readFileSync(path.join(root, PODS_LOCK), "utf8");
    rmSync(cache, { recursive: true, force: true });
    server.requests.length = 0;
    logs = [];
    await runPodsStep(root, ROOTS, table(), deps());
    expect(downloads()).toHaveLength(10);
    expect(logs.some((l) => l.startsWith("ℹ pods — recorded"))).toBe(false);
    expect(readFileSync(path.join(root, PODS_LOCK), "utf8")).toBe(lockBytes);
  });

  it("announces and checks the disk for a cached file that fails its re-hash before downloading it again", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const damaged = path.join(cache, "downloads", `${sha(TARBALLS.MLImage!)}.tar.gz`);
    writeFileSync(damaged, "lost bytes");
    server.requests.length = 0;
    logs = [];
    seenAt = [];
    await expect(runPodsStep(root, ROOTS, table(), deps({ filesystemOf: async () => ({ dev: 1, freeBytes: 1 }) }))).rejects.toThrow(
      "Not enough free disk space for the CocoaPods binaries",
    );
    expect(downloads()).toEqual([]);
    await runPodsStep(root, ROOTS, table(), deps());
    const at = logs.findIndex((l) => l.includes("needs 1 CocoaPods binary that is not in rn-xtool's cache"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(logs[at]).toContain(`MLImage 1.0.0-beta7 (${formatSize(TARBALLS.MLImage!.length)})`);
    const get = server.requests.indexOf(`GET ${dlPath("MLImage")}`);
    expect(seenAt[at]).toBeLessThanOrEqual(get);
    expect(downloads()).toEqual([`GET ${dlPath("MLImage")}`]);
    expect(readFileSync(damaged)).toEqual(TARBALLS.MLImage!);
  });

  it("leaves the project and the lock as they were on a mismatch", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const lockBytes = readFileSync(path.join(root, PODS_LOCK), "utf8");
    rmSync(cache, { recursive: true, force: true });
    const changed = Buffer.concat([TARBALLS.MLImage!, Buffer.from("x")]);
    server.routes[dlPath("MLImage")] = { body: changed };
    await expect(runPodsStep(root, ROOTS, table(), deps())).rejects.toThrow(
      `The file ${HOST} serves for MLImage 1.0.0-beta7 is not the one ${PODS_LOCK} records (sha256 ${sha(changed)} instead of ${sha(TARBALLS.MLImage!)}).`,
    );
    expect(readFileSync(path.join(root, PODS_LOCK), "utf8")).toBe(lockBytes);
  });

  it("prints the re-resolved line and records the new version", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const lock = readPodsLock(root);
    // A lock from an older resolution: MLKitCommon 12.0.0, which no longer meets "~> 13.0".
    writePodsLock(root, { ...lock, pods: { ...lock.pods, MLKitCommon: { ...lock.pods.MLKitCommon!, version: "12.0.0", sha256: "0".repeat(64) } } });
    logs = [];
    await runPodsStep(root, ROOTS, table(), deps());
    expect(logs.find((l) => l.includes("MLKitCommon: "))).toMatch(
      /^ℹ pods — MLKitCommon: rn-xtool-pods\.lock\.json records 12\.0\.0, which no longer meets "~> 13\.0(\.0)?" \(.+\); now 13\.0\.0, recorded in rn-xtool-pods\.lock\.json$/,
    );
    expect(readPodsLock(root).pods.MLKitCommon).toMatchObject({ version: "13.0.0", sha256: sha(TARBALLS.MLKitCommon!) });
    expect(logs.at(-1)).toBe(recordedLine(1));
  });

  it("prints the moved line and updates the lock's URL", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    const lock = readPodsLock(root);
    const old = "https://example.invalid/old/MLImage-1.0.0-beta7.tar.gz";
    writePodsLock(root, { ...lock, pods: { ...lock.pods, MLImage: { ...lock.pods.MLImage!, url: old } } });
    logs = [];
    await runPodsStep(root, ROOTS, table(), deps());
    expect(logs).toContain(
      `ℹ pods — MLImage 1.0.0-beta7 moved to https://${HOST}${dlPath("MLImage")}; same file (its sha256 matches ${PODS_LOCK}), so the lock's URL is updated`,
    );
    expect(readPodsLock(root).pods.MLImage!.url).toBe(`https://${HOST}${dlPath("MLImage")}`);
    expect(logs.some((l) => l.startsWith("ℹ pods — recorded"))).toBe(false);
  });

  it("stops before downloading when a framework or library is not in the SDK", async () => {
    await expect(runPodsStep(root, ROOTS, table(), deps({ sdkDir: fakeSdk(work, ["CoreLocation"]) }))).rejects.toThrow(
      `MLKitTextRecognitionCommon 5.0.0 (needed by ${LIB}) links the framework CoreLocation, which the iOS SDK rn-xtool builds with (iOS 27.1) does not have. See ${LINK}`,
    );
    await expect(runPodsStep(root, ROOTS, table(), deps({ sdkDir: fakeSdk(work, ["sqlite3"]) }))).rejects.toThrow(
      `MLKitCommon 13.0.0 (needed by ${LIB}) links the library sqlite3, which the iOS SDK rn-xtool builds with (iOS 27.1) does not have. See ${LINK}`,
    );
    expect(downloads()).toEqual([]);
    expect(existsSync(path.join(root, PODS_LOCK))).toBe(false);
  });

  it("counts 8 bytes of disk per downloaded byte, as measured with the per-app copies (row 59)", () => {
    expect(POD_DISK_FACTOR).toBe(8);
  });

  it("stops before the first download when the cache's filesystem is short", async () => {
    const run = runPodsStep(root, ROOTS, table(), deps({ filesystemOf: async () => ({ dev: 1, freeBytes: 1000 }) }));
    await expect(run).rejects.toThrow(
      `Not enough free disk space for the CocoaPods binaries: the filesystem of ${tilde(cache)} has 1 KB free, and rn-xtool needs about ` +
        `${formatSize(total * POD_DISK_FACTOR)} there (10 downloads ${formatSize(total)}, unpacked, wrapped and per-app copies ` +
        `${formatSize(total * (POD_DISK_FACTOR - 1))}). Free some space, then build again.`,
    );
    expect(downloads()).toEqual([]);
    expect(existsSync(path.join(root, PODS_LOCK))).toBe(false);
  });

  describe("with the project on another filesystem than the cache (row 59)", () => {
    const app = POD_DISK_FACTOR - POD_APP_COPY_FACTOR;
    const split = (free: { cache: number; project: number }) => async (dir: string) =>
      dir === cache ? { dev: 1, freeBytes: free.cache } : { dev: 2, freeBytes: free.project };

    it("checks the project's filesystem for the per-app copies", async () => {
      const probed: string[] = [];
      const filesystemOf = split({ cache: 1e12, project: 1000 });
      const run = runPodsStep(root, ROOTS, table(), deps({ filesystemOf: (dir) => (probed.push(dir), filesystemOf(dir)) }));
      await expect(run).rejects.toThrow(
        `Not enough free disk space for the CocoaPods binaries: the filesystem of ${tilde(root)} has 1 KB free, and rn-xtool needs about ` +
          `${formatSize(total * POD_APP_COPY_FACTOR)} there (the per-app copies in ios/build/pod-binaries and ios-xtool/Resources). ` +
          "Free some space, then build again.",
      );
      expect(probed.sort()).toEqual([cache, root].sort());
      expect(downloads()).toEqual([]);
    });

    it("checks the cache's filesystem for the downloads and their trees only, and names both when both are short", async () => {
      const cacheText =
        `the filesystem of ${tilde(cache)} has 1 KB free, and rn-xtool needs about ${formatSize(total * app)} there ` +
        `(10 downloads ${formatSize(total)}, unpacked and wrapped copies ${formatSize(total * (app - 1))})`;
      await expect(runPodsStep(root, ROOTS, table(), deps({ filesystemOf: split({ cache: 1000, project: 1e12 }) }))).rejects.toThrow(
        `Not enough free disk space for the CocoaPods binaries: ${cacheText}. Free some space, then build again.`,
      );
      await expect(runPodsStep(root, ROOTS, table(), deps({ filesystemOf: split({ cache: 1000, project: 1000 }) }))).rejects.toThrow(
        `Not enough free disk space for the CocoaPods binaries: ${cacheText}; the filesystem of ${tilde(root)} has 1 KB free`,
      );
      await runPodsStep(root, ROOTS, table(), deps({ filesystemOf: split({ cache: total * app, project: total * POD_APP_COPY_FACTOR }) }));
      expect(downloads()).toHaveLength(10);
    });
  });

  it("sizes the disk check from the lock when HEAD gives no length", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    rmSync(cache, { recursive: true, force: true });
    server.requests.length = 0;
    const silentHead = ((input: string | URL | Request, init?: RequestInit) =>
      init?.method === "HEAD" ? Promise.resolve(new Response(null, { status: 405 })) : globalThis.fetch(input, init)) as typeof fetch;
    const run = runPodsStep(root, ROOTS, table(), deps({ fetch: silentHead, filesystemOf: async () => ({ dev: 1, freeBytes: 1000 }) }));
    await expect(run).rejects.toThrow(
      `and rn-xtool needs about ${formatSize(total * POD_DISK_FACTOR)} there (10 downloads ${formatSize(total)}, unpacked, wrapped and per-app copies`,
    );
    expect(downloads()).toEqual([]);
  });

  it("names the host and the cache when offline, before anything is downloaded", async () => {
    const base = await closedPortBase();
    const host = new URL(base).host;
    await expect(runPodsStep(root, ROOTS, table(), deps({ cdnBase: base }))).rejects.toThrow(
      `Cannot reach ${host} (connect ECONNREFUSED) to read the versions of GoogleMLKit, which are not in rn-xtool's cache (${tilde(cache)}). ` +
        "Connect to the network and build again; once downloaded, builds use the cache.",
    );
    expect(existsSync(path.join(root, PODS_LOCK))).toBe(false);
  });

  it("names the first missing download and how many more when the host is offline", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    rmSync(path.join(cache, "downloads"), { recursive: true, force: true });
    rmSync(path.join(cache, "extracted"), { recursive: true, force: true });
    rmSync(path.join(cache, "wrapped"), { recursive: true, force: true });
    vi.unstubAllGlobals();
    routeTo(await closedPortBase());
    await expect(runPodsStep(root, ROOTS, table(), deps())).rejects.toThrow(
      `Cannot reach ${HOST} (connect ECONNREFUSED) to download GoogleMLKit 8.0.0 (size unknown) (and 9 more), which are not in rn-xtool's cache (${tilde(cache)}).`,
    );
  });

  it("names the privacy manifests left inside frameworks in one ℹ line", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    expect(logs.filter((l) => l.includes("PrivacyInfo.xcprivacy"))).toEqual([
      "ℹ pods — not copied into the app: the PrivacyInfo.xcprivacy inside MLKitCommon.framework. Development builds run without them; " +
        "privacy manifests are read only at App Store submission.",
    ]);
  });

  it("prints the table's pin lines for the binary pods' source pods", async () => {
    await runPodsStep(root, ROOTS, table(), deps());
    expect(logs.some((l) => l.startsWith("ℹ GoogleToolboxForMac 6.0.1 (rn-xtool table) is outside"))).toBe(true);
  });

  describe("a git-source pod of a library knownLimits.allow names", () => {
    const GIT_ROOT: PodRoot = { library: "react-native-git", libraryVersion: "1.0.0", dependency: "GitPod", requirements: [] };
    const allowedLine =
      `⚠ known-limits — react-native-git 1.0.0: its podspec depends on the CocoaPods pod GitPod, which has no SwiftPM package rn-xtool knows. ` +
      `Add one under "pods" in rn-xtool.config.json: { "pods": { "GitPod": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, ` +
      `or leave the library out with "exclude". See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")} ` +
      "(allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)";
    beforeEach(() => {
      server.routes[`/all_pods_versions_${podShard("GitPod").join("_")}.txt`] = { body: "GitPod/1.0.0\n" };
      server.routes[`/Specs/${podShard("GitPod").join("/")}/GitPod/1.0.0/GitPod.podspec.json`] = {
        body: JSON.stringify({
          name: "GitPod",
          version: "1.0.0",
          homepage: "https://example.invalid/pod",
          license: "MIT",
          authors: "Example",
          source: { git: "https://example.invalid/git/pod.git", tag: "1.0.0" },
          platforms: { ios: "15.5" },
          source_files: "Sources/**/*.m",
        }),
      };
    });

    it("leaves it out with the allowed warning, and takes the other pods", async () => {
      const result = await runPodsStep(root, [...ROOTS, GIT_ROOT], table(), deps({ allowed: ["react-native-git"] }));
      expect(logs).toContain(allowedLine);
      expect(result.wrapped.map((w) => w.pod)).toEqual(BINARY);
      expect(result.binary).toEqual({ GoogleMLKit: { product: "GoogleMLKit" } });
      expect(Object.keys(readPodsLock(root).pods)).not.toContain("GitPod");
    });

    it("does not warn again for a pod the early checks already allowed", async () => {
      await runPodsStep(root, [GIT_ROOT], table(), deps({ allowed: ["react-native-git"], warned: (l, p) => l === "react-native-git" && p === "GitPod" }));
      expect(logs.filter((l) => l.startsWith("⚠ "))).toEqual([]);
      expect(existsSync(path.join(root, PODS_LOCK))).toBe(false);
    });

    it("leaves out a pod the early checks allowed before any CDN read (row 91)", async () => {
      const early = { allowed: ["react-native-git"], warned: (l: string, p: string) => l === "react-native-git" && p === "GitPod" };
      await runPodsStep(root, [...ROOTS, GIT_ROOT], table(), deps(early));
      expect(server.requests.some((r) => r.includes("GitPod"))).toBe(false);
      // Offline, with the lock and a full cache: no request, and the other pods come from the cache.
      server.requests.length = 0;
      logs = [];
      vi.unstubAllGlobals();
      routeTo(await closedPortBase());
      const again = await runPodsStep(root, [...ROOTS, GIT_ROOT], table(), deps({ ...early, cdnBase: await closedPortBase() }));
      expect(server.requests).toEqual([]);
      expect(again.wrapped.map((w) => w.pod)).toEqual(BINARY);
      expect(logs.filter((l) => l.startsWith("⚠ "))).toEqual([]);
    });

    it("needs no CDN when the early checks allowed every pod", async () => {
      const result = await runPodsStep(
        root,
        [GIT_ROOT],
        table(),
        deps({ cdnBase: await closedPortBase(), allowed: ["react-native-git"], warned: (l, p) => l === "react-native-git" && p === "GitPod" }),
      );
      expect(result.wrapped).toEqual([]);
      expect(server.requests).toEqual([]);
    });

    it("stops with block 2's text when the library is not allowed", async () => {
      await expect(runPodsStep(root, [GIT_ROOT], table(), deps())).rejects.toThrow(allowedLine.slice("⚠ known-limits — ".length, allowedLine.indexOf(" (allowed")));
    });
  });

  it("keeps lock entries no library needs", async () => {
    const extra = {
      version: "1.0.0",
      subspecs: [],
      url: "https://example.invalid/dl/MLKitFoo-1.0.0.zip",
      size: 10,
      sha256: "a".repeat(64),
      neededBy: ["some-lib"],
    };
    writePodsLock(root, { lockfileVersion: 1, pods: { MLKitFoo: extra } });
    await runPodsStep(root, ROOTS, table(), deps());
    const lock = readPodsLock(root);
    expect(lock.pods.MLKitFoo).toEqual(extra);
    expect(Object.keys(lock.pods)).toHaveLength(11);
    expect(renderPodsLock(lock)).toBe(readFileSync(path.join(root, PODS_LOCK), "utf8"));
  });
});

describe("podTerms", () => {
  // data/pod-terms.json is the one place that names a vendor's terms URL: the test checks its shape, not its URLs.
  it("maps https homepages to https terms URLs", () => {
    const terms = Object.entries(podTerms());
    expect(terms.length).toBeGreaterThan(0);
    for (const [homepage, url] of terms) {
      expect(new URL(homepage).protocol).toBe("https:");
      expect(new URL(url).protocol).toBe("https:");
    }
  });
});
