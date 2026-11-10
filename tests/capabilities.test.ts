import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCapabilities,
  podspecFeatures,
  probeArtifacts,
  unsupportedReason,
  type HeadProbe,
} from "../src/project/capabilities.js";
import { fakeExpo57Modules } from "./support/expo57.js";
import { fakeExpo58Modules } from "./support/expo58.js";
import { makeFakeSlot088 } from "./support/fakeSlots.js";
import { fakeRnScripts } from "./support/rnScripts.js";
import { objcApp } from "./support/objcApp.js";
import { plistOf, withEntitlements } from "./support/entitlements.js";
import { useGitSpecCache } from "./support/podsCache.js";
import { troubleshootingUrl } from "../src/docs.js";
import { podShard } from "../src/pods/cdn.js";
import { allowedLimitText } from "../src/project/earlyChecks.js";
import { formatSize } from "../src/pods/format.js";
import { PODS_LOCK } from "../src/pods/lock.js";
import { podsCdnRoutes } from "./support/podFixtures.js";
import { closedPortBase, startPodsServer, type PodsServer } from "./support/podsServer.js";

// Unmapped pods read as git sources from a cache of their own, never the machine's.
useGitSpecCache();

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writePackage(dir: string, json: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(json));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

/** A root with react-native `version` installed (no scripts) and, with `hermes`, hermes-compiler at that version. */
async function rnRoot(version: string, hermes?: string): Promise<{ root: string; rnDir: string }> {
  const root = await tempDir("rn-xtool-caps-rn-");
  const rnDir = path.join(root, "node_modules", "react-native");
  await writePackage(rnDir, { name: "react-native", version });
  if (hermes !== undefined) await writePackage(path.join(root, "node_modules", "hermes-compiler"), { name: "hermes-compiler", version: hermes });
  return { root, rnDir };
}

/** A head that records each URL and answers `status(url)`. */
function recordingHead(status: (url: string) => number = () => 200): { head: HeadProbe; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    head: async (url) => {
      urls.push(url);
      return status(url);
    },
  };
}

const ok200: HeadProbe = async () => 200;
const noNetwork: HeadProbe = async () => {
  throw new Error("no network in this test");
};

/** The two release repositories the downloader tries, in its default order (no enterprise repo, mirror on). */
function defaultRepositories(): void {
  vi.stubEnv("ENTERPRISE_REPOSITORY", "");
  vi.stubEnv("RCT_REACT_NATIVE_MAVEN_MIRROR_ENABLED", "");
}

describe("probeArtifacts", () => {
  it("reports cached slots without the network", async () => {
    const { rnDir } = await rnRoot("0.88.1");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    for (const flavor of ["debug", "release"]) makeFakeSlot088(path.join(cacheRoot, "0.88.1", flavor));
    const head = vi.fn(noNetwork);
    expect(await probeArtifacts(rnDir, "0.88.1", { cacheRoot, head })).toEqual({ status: "cached", version: "0.88.1", missing: [] });
    expect(head).not.toHaveBeenCalled();
  });

  it("offline, reads the cache only and never probes", async () => {
    const { rnDir } = await rnRoot("0.88.1");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const head = vi.fn(ok200);
    expect(await probeArtifacts(rnDir, "0.88.1", { cacheRoot, head, offline: true })).toEqual({
      status: "offline",
      version: "0.88.1",
      missing: [],
    });
    for (const flavor of ["debug", "release"]) makeFakeSlot088(path.join(cacheRoot, "0.88.1", flavor));
    expect(await probeArtifacts(rnDir, "0.88.1", { cacheRoot, head, offline: true })).toEqual({
      status: "cached",
      version: "0.88.1",
      missing: [],
    });
    expect(head).not.toHaveBeenCalled();
  });

  it("probes when only one flavor is cached", async () => {
    const { rnDir } = await rnRoot("0.88.1");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    makeFakeSlot088(path.join(cacheRoot, "0.88.1", "debug"));
    const { head, urls } = recordingHead();
    expect((await probeArtifacts(rnDir, "0.88.1", { cacheRoot, head })).status).toBe("published");
    expect(urls.length).toBeGreaterThan(0);
  });

  it("checks the release URLs the downloader uses", async () => {
    defaultRepositories();
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const { head, urls } = recordingHead();
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head })).toEqual({ status: "published", version: "0.88.2", missing: [] });
    expect(urls).toContain(
      "https://repo.reactnative.dev/maven2/com/facebook/react/react-native-artifacts/0.88.2/react-native-artifacts-0.88.2-reactnative-core-debug.tar.gz",
    );
    expect(urls).toContain(
      "https://repo.reactnative.dev/maven2/com/facebook/hermes/hermes-ios/250829098.0.4/hermes-ios-250829098.0.4-hermes-ios-release.tar.gz",
    );
    // React, ReactNativeDependencies and Hermes, two flavors, two repositories each.
    expect(urls).toHaveLength(12);
  });

  it("names the artifacts nobody publishes", async () => {
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const { head } = recordingHead((url) => (url.includes("reactnative-dependencies") ? 404 : 200));
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head })).toEqual({
      status: "missing",
      version: "0.88.2",
      missing: ["ReactNativeDependencies (debug)", "ReactNativeDependencies (release)"],
    });
  });

  it("counts an artifact as published when any of its repositories has it", async () => {
    defaultRepositories();
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const head: HeadProbe = async (url) => {
      if (url.startsWith("https://repo.reactnative.dev/")) throw new Error("mirror down");
      return 200;
    };
    expect((await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head })).status).toBe("published");
  });

  it("reports artifacts as not checked when the probe fails or times out", async () => {
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");

    const rejecting: HeadProbe = async () => {
      throw new Error("getaddrinfo ENOTFOUND repo.reactnative.dev");
    };
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head: rejecting })).toEqual({
      status: "unknown",
      version: "0.88.2",
      missing: [],
      detail: "getaddrinfo ENOTFOUND repo.reactnative.dev",
    });

    const started = Date.now();
    const never: HeadProbe = () => new Promise(() => {});
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head: never, timeoutMs: 50 })).toEqual({
      status: "unknown",
      version: "0.88.2",
      missing: [],
      detail: "timed out after 0.05 s",
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never reports a failed probe as missing", async () => {
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    // Dependencies answer 404 on every repository; Hermes fails on every one: not all artifacts were checked.
    const head: HeadProbe = async (url) => {
      if (url.includes("reactnative-dependencies")) return 404;
      if (url.includes("hermes-ios")) throw new Error("connection reset");
      return 200;
    };
    const result = await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head });
    expect(result.status).toBe("unknown");
    expect(result.detail).toBe("connection reset");
  });

  it("skips Hermes without hermes-compiler", async () => {
    const { rnDir } = await rnRoot("0.88.2");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const { head, urls } = recordingHead();
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head })).toEqual({
      status: "published",
      version: "0.88.2",
      missing: [],
      detail: "Hermes not checked: hermes-compiler is not installed",
    });
    expect(urls.some((u) => u.includes("hermes"))).toBe(false);
  });

  it("keeps the Hermes note on a missing result", async () => {
    const { rnDir } = await rnRoot("0.81.5");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    expect(await probeArtifacts(rnDir, "0.81.5", { cacheRoot, head: async () => 404 })).toMatchObject({
      status: "missing",
      detail: "Hermes not checked: hermes-compiler is not installed",
    });
  });

  it.each([404, 410])("counts HTTP %i on every repository as missing", async (status) => {
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const result = await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head: async () => status });
    expect(result.status).toBe("missing");
    expect(result.missing).toHaveLength(6);
  });

  it.each([429, 503, 403, 302, 204])("counts HTTP %i as not checked, never as missing", async (status) => {
    defaultRepositories();
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head: async () => status })).toEqual({
      status: "unknown",
      version: "0.88.2",
      missing: [],
      detail: `HTTP ${status} from repo.reactnative.dev`,
    });
  });

  it("counts an error answer from one repository as not checked when the other has nothing", async () => {
    defaultRepositories();
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const head: HeadProbe = async (url) => (url.startsWith("https://repo.reactnative.dev/") ? 503 : 404);
    expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot, head })).toMatchObject({
      status: "unknown",
      detail: "HTTP 503 from repo.reactnative.dev",
    });
  });

  it("sends HEAD requests and names why fetch failed", async () => {
    const { rnDir } = await rnRoot("0.88.2", "250829098.0.4");
    const cacheRoot = await tempDir("rn-xtool-caps-cache-");
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("HEAD");
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND x") });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      expect(await probeArtifacts(rnDir, "0.88.2", { cacheRoot })).toMatchObject({
        status: "unknown",
        detail: "fetch failed: getaddrinfo ENOTFOUND x",
      });
      expect(fetchStub).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("podspecFeatures", () => {
  it("lists the podspec features of the dependencies", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, { name: "app", dependencies: { a: "1.0.0", b: "1.0.0", c: "1.0.0" }, devDependencies: { d: "1.0.0" } });
    const nm = path.join(root, "node_modules");
    await writePackage(path.join(nm, "a"), { name: "a", version: "1.0.0" }, {
      "a.podspec": "Pod::Spec.new do |s|\n  s.subspec 'x' do |ss|\n  end\n  s.compiler_flags = '-DX'\nend\n",
    });
    await writePackage(path.join(nm, "b"), { name: "b", version: "1.0.0" }, {
      "b.podspec": "Pod::Spec.new do |s|\n  s.header_mappings_dir = 'ios'\n  s.resource_bundles = {}\nend\n",
    });
    await writePackage(path.join(nm, "c"), { name: "c", version: "1.0.0" });
    await writePackage(path.join(nm, "d"), { name: "d", version: "1.0.0" }, {
      "d.podspec": "Pod::Spec.new do |s|\n  s.header_dir = 'd'\nend\n",
    });
    expect(podspecFeatures(root)).toEqual({
      subspecs: ["a"],
      compiler_flags: ["a"],
      header_dir: [],
      header_mappings_dir: ["b"],
      vendored_frameworks: [],
      resource_bundles: ["b"],
    });
  });

  it("leaves react-native out, and keeps expo", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, { name: "app", dependencies: { expo: "58.0.21", "react-native": "0.88.1" } });
    const spec = "s.subspec 'x'\ns.compiler_flags = '-DX'\ns.header_dir = 'x'\n";
    await writePackage(path.join(root, "node_modules", "expo"), { name: "expo", version: "58.0.21" }, { "Expo.podspec": spec });
    await writePackage(path.join(root, "node_modules", "react-native"), { name: "react-native", version: "0.88.1" }, {
      "React-Core.podspec": `${spec}s.header_mappings_dir = 'x'\ns.vendored_frameworks = 'x'\ns.resource_bundles = {}\n`,
    });
    expect(podspecFeatures(root)).toEqual({
      subspecs: ["expo"],
      compiler_flags: ["expo"],
      header_dir: ["expo"],
      header_mappings_dir: [],
      vendored_frameworks: [],
      resource_bundles: [],
    });
  });

  it("finds podspecs where autolinking does: the root, ios/ and expo-module.config.json", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, {
      name: "app",
      dependencies: { "expo-router": "58.0.28", "expo-apple": "1.0.0", "expo-ios-key": "1.0.0" },
    });
    const nm = path.join(root, "node_modules");
    await cp(path.join(fixtures, "podspec-features", "expo-router"), path.join(nm, "expo-router"), { recursive: true });
    // A podspec only the config names, under each of the two keys Expo reads (apple first, then ios).
    await writePackage(path.join(nm, "expo-apple"), { name: "expo-apple", version: "1.0.0" }, {
      "expo-module.config.json": JSON.stringify({ platforms: ["apple"], apple: { podspecPath: ["native/Apple.podspec"] } }),
      "native/Apple.podspec": "Pod::Spec.new do |s|\n  s.header_dir = 'Apple'\nend\n",
    });
    await writePackage(path.join(nm, "expo-ios-key"), { name: "expo-ios-key", version: "1.0.0" }, {
      "expo-module.config.json": JSON.stringify({ platforms: ["ios"], ios: { podspecPath: "spec/IosKey.podspec" } }),
      "spec/IosKey.podspec": "Pod::Spec.new do |spec|\n  spec.ios.vendored_framework = 'IosKey.xcframework'\nend\n",
    });
    expect(podspecFeatures(root)).toEqual({
      subspecs: [],
      compiler_flags: [],
      header_dir: ["expo-apple"],
      header_mappings_dir: [],
      vendored_frameworks: ["expo-ios-key", "expo-router"],
      resource_bundles: [],
    });
  });

  it("reads pod attributes, not Ruby variables or comments", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, { name: "app", dependencies: { local: "1.0.0", commented: "1.0.0", attrs: "1.0.0" } });
    const nm = path.join(root, "node_modules");
    await writePackage(path.join(nm, "local"), { name: "local", version: "1.0.0" }, {
      "Local.podspec":
        "compiler_flags = '-DX'\nheader_dir = 'x'\nvendored_frameworks = []\nPod::Spec.new do |s|\n  s.name = 'Local'\n" +
        "  if s.compiler_flags == '-DX' then end\nend\n",
    });
    await writePackage(path.join(nm, "commented"), { name: "commented", version: "1.0.0" }, {
      "Commented.podspec": "Pod::Spec.new do |s|\n  # s.vendored_frameworks = 'X.xcframework'\n  # s.subspec 'x'\nend\n",
    });
    await writePackage(path.join(nm, "attrs"), { name: "attrs", version: "1.0.0" }, {
      "Attrs.podspec": "Pod::Spec.new do |s|\n  s.subspec 'a' do |ss|\n    ss.compiler_flags = '-DY'\n  end\nend\n",
    });
    expect(podspecFeatures(root)).toEqual({
      subspecs: ["attrs"],
      compiler_flags: ["attrs"],
      header_dir: [],
      header_mappings_dir: [],
      vendored_frameworks: [],
      resource_bundles: [],
    });
  });

  it("leaves out the resource bundles rn-xtool builds, and keeps those it cannot read", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, { name: "app", dependencies: { built: "1.0.0", interpolated: "1.0.0", conditional: "1.0.0", mixed: "1.0.0" } });
    const nm = path.join(root, "node_modules");
    await writePackage(path.join(nm, "built"), { name: "built", version: "1.0.0" }, {
      "Built.podspec": "Pod::Spec.new do |s|\n  s.resource_bundles = { 'Built' => ['Res/*.png'] }\nend\n",
    });
    await writePackage(path.join(nm, "interpolated"), { name: "interpolated", version: "1.0.0" }, {
      "Interpolated.podspec": 'Pod::Spec.new do |s|\n  s.resource_bundles = { "I" => ["#{dir}/*.png"] }\nend\n',
    });
    await writePackage(path.join(nm, "conditional"), { name: "conditional", version: "1.0.0" }, {
      "Conditional.podspec": "Pod::Spec.new do |s|\n  if ENV['X']\n    s.resource_bundles = { 'C' => ['Res/*.png'] }\n  end\nend\n",
    });
    await writePackage(path.join(nm, "mixed"), { name: "mixed", version: "1.0.0" }, {
      "Mixed.podspec": "Pod::Spec.new do |s|\n  s.resource_bundles = { 'M' => ['Res/*.png'] }\n  s.resource_bundles = { 'N' => files }\nend\n",
    });
    expect(podspecFeatures(root).resource_bundles).toEqual(["conditional", "interpolated", "mixed"]);
  });

  it("skips dependencies that are not installed and reads a scoped package", async () => {
    const root = await tempDir("rn-xtool-caps-podspecs-");
    await writePackage(root, { name: "app", dependencies: { "@scope/lib": "1.0.0", gone: "1.0.0" } });
    await writePackage(path.join(root, "node_modules", "@scope", "lib"), { name: "@scope/lib", version: "1.0.0" }, {
      "Lib.podspec": "s.vendored_frameworks = 'Lib.xcframework'\ns.resource_bundle = { 'Lib' => ['x'] }\n",
    });
    expect(podspecFeatures(root)).toMatchObject({ vendored_frameworks: ["@scope/lib"], resource_bundles: ["@scope/lib"] });
  });
});

/** A copy of the SDK 58 fixture on the 58 floor set, with expo's plugin config and core's prebuilds. */
async function expo58(): Promise<string> {
  const dir = await tempDir("rn-xtool-caps-expo58-");
  await cp(path.join(fixtures, "project"), dir, { recursive: true });
  await fakeExpo58Modules(dir);
  await writeFile(
    path.join(dir, "node_modules", "expo", "react-native.config.js"),
    "module.exports = {\n  dependency: {\n    platforms: { ios: {} },\n  },\n  autolinkingPlugin: './scripts/spm/plugin.js',\n};\n",
  );
  for (const flavor of ["debug", "release"]) {
    const xc = path.join(dir, "node_modules", "expo-modules-core", "prebuilds", "output", flavor, "xcframeworks");
    await mkdir(xc, { recursive: true });
    await writeFile(path.join(xc, "ExpoModulesCore.tar.gz"), "");
  }
  return dir;
}

async function expo57(): Promise<string> {
  const dir = await tempDir("rn-xtool-caps-expo57-");
  await cp(path.join(fixtures, "expo-57"), dir, { recursive: true });
  await fakeExpo57Modules(dir);
  return dir;
}

/** A copy of the SDK 58 fixture with expo `sdkVersion` and react-native `rn` (no SwiftPM scripts). */
async function expoOther(expo: string, rn: string): Promise<string> {
  const dir = await tempDir("rn-xtool-caps-expo-");
  await cp(path.join(fixtures, "project"), dir, { recursive: true });
  await writePackage(path.join(dir, "node_modules", "expo"), { name: "expo", version: expo }, {
    "react-native.config.js": "module.exports = { dependency: { platforms: { ios: {} } } };\n",
  });
  await writePackage(path.join(dir, "node_modules", "react-native"), { name: "react-native", version: rn });
  return dir;
}

/** A copy of the bare template with react-native `rn`, its scripts in `shape`; `rn: null` leaves react-native out. */
async function bare(rn: string | null, shape: "none" | "0.87" | "0.88" = "none"): Promise<string> {
  const dir = await tempDir("rn-xtool-caps-bare-");
  await cp(path.join(fixtures, "bare"), dir, { recursive: true });
  if (rn === null) return dir;
  const rnDir = path.join(dir, "node_modules", "react-native");
  await writePackage(rnDir, { name: "react-native", version: rn });
  await fakeRnScripts(rnDir, shape);
  return dir;
}

describe("detectCapabilities", () => {
  async function detect(root: string, head: HeadProbe = ok200) {
    return detectCapabilities(root, { cacheRoot: await tempDir("rn-xtool-caps-cache-"), head });
  }

  it("names the project's patches for packages that are not installed", async () => {
    const dir = await bare("0.88.1", "0.88");
    expect((await detect(dir)).orphanPatches).toEqual([]);
    await writePackage(path.join(dir, "node_modules", "a"), { name: "a", version: "1.0.0" }, {});
    await mkdir(path.join(dir, "patches"), { recursive: true });
    await writeFile(path.join(dir, "patches", "a+1.0.0.patch"), "");
    await writeFile(path.join(dir, "patches", "react-native-device-info+15.0.2.patch"), "");
    expect((await detect(dir)).orphanPatches).toEqual([
      "⚠ patches/react-native-device-info+15.0.2.patch is for react-native-device-info, which is not installed; skipped. " +
        "Delete it if you removed the library.",
    ]);
  });

  it("detects an Expo SDK 58 project", async () => {
    const c = await detect(await expo58());
    expect(c).toMatchObject({
      kind: "expo",
      sdk: 58,
      expoVersion: "58.0.21",
      rnVersion: "0.88.1",
      expoPlugin: "ships",
      expoModules: "precompiled",
      expoModulesCoreVersion: "58.0.28",
      scripts: { shape: "0.88", recognised: true, mode: "installed" },
      artifacts: { status: "published", version: "0.88.1" },
    });
    expect(unsupportedReason(c)).toBeUndefined();
  });

  it("detects an Expo SDK 57 project", async () => {
    const c = await detect(await expo57());
    expect(c).toMatchObject({
      kind: "expo",
      sdk: 57,
      expoVersion: "57.0.31",
      rnVersion: "0.86.3",
      expoPlugin: "none",
      expoModules: "source",
      expoModulesCoreVersion: "57.0.24",
      scripts: { shape: "none", mode: "vendored" },
    });
  });

  it("finds expo's plugin in package.json swiftpmConfig, as the build does", async () => {
    const dir = await expoOther("59.0.0", "0.88.1");
    const expoDir = path.join(dir, "node_modules", "expo");
    await writePackage(expoDir, { name: "expo", version: "59.0.0", swiftpmConfig: { autolinkingPlugin: "./scripts/spm/plugin.js" } });
    expect((await detect(dir)).expoPlugin).toBe("ships");
  });

  it("does not take a commented-out plugin line for a plugin", async () => {
    const dir = await expoOther("59.0.0", "0.88.1");
    await writeFile(
      path.join(dir, "node_modules", "expo", "react-native.config.js"),
      "module.exports = {\n  // spm: { autolinkingPlugin: './scripts/spm/plugin.js' },\n  /* autolinkingPlugin: 'x' */\n};\n",
    );
    expect((await detect(dir)).expoPlugin).toBe("none");
  });

  it("reads Expo modules as precompiled only with prebuilds for both flavors", async () => {
    const dir = await expo58();
    await rm(path.join(dir, "node_modules", "expo-modules-core", "prebuilds", "output", "release"), { recursive: true });
    expect((await detect(dir)).expoModules).toBe("source");
  });

  it("detects a bare project", async () => {
    const c = await detect(await bare("0.88.1", "0.88"));
    expect(c).toMatchObject({ kind: "bare", rnVersion: "0.88.1", scripts: { shape: "0.88", mode: "installed" } });
    expect(c.expoVersion).toBeUndefined();
    expect(c.sdk).toBeUndefined();
    expect(c.expoPlugin).toBeUndefined();
    expect(c.expoModules).toBeUndefined();
    expect(c.expoModulesCoreVersion).toBeUndefined();
  });

  it("takes the project kind from rn-xtool.config.json", async () => {
    // A flat app.json and no ios/: detection alone cannot tell the kind.
    const dir = await expoOther("58.0.21", "0.88.1");
    const app = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    await writeFile(path.join(dir, "app.json"), JSON.stringify(app.expo));
    expect((await detect(dir)).kind).toBeUndefined();
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ projectKind: "expo" }));
    expect((await detect(dir)).kind).toBe("expo");
  });

  it("reports rnArtifactsDir from rn-xtool.config.json instead of probing", async () => {
    const dir = await bare("0.88.1", "0.88");
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ rnArtifactsDir: "../rn-artifacts" }));
    expect((await detect(dir, noNetwork)).artifacts).toEqual({
      status: "local",
      version: "0.88.1",
      missing: [],
      detail: "../rn-artifacts",
    });
  });

  it("carries the early failures", async () => {
    const dir = await expo58();
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    expect((await detect(dir)).limits).toEqual([]);
    const name = "@react-native-async-storage/async-storage";
    pkg.dependencies[name] = "3.1.1";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await writePackage(path.join(dir, "node_modules", name), { name, version: "3.1.1" }, {
      "AsyncStorage.podspec": 'Pod::Spec.new do |s|\n  s.ios.vendored_frameworks = "apple-frameworks/SharedAsyncStorage.xcframework"\nend\n',
    });
    const limits = (await detect(dir)).limits;
    expect(limits?.map((l) => l.id)).toEqual(["vendored-binaries"]);
    expect(limits?.[0]?.allowed).toBeUndefined();
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ knownLimits: { allow: [name] } }));
    expect((await detect(dir)).limits?.map((l) => l.allowed)).toEqual([true]);
    expect(limits?.[0]?.reason).toMatch(/^@react-native-async-storage\/async-storage 3\.1\.1: its podspec \(AsyncStorage\.podspec\)/);
  });

  it("checks the pods with the config's table", async () => {
    const dir = await expo58();
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.dependencies["react-native-mmkv-lib"] = "1.0.0";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await writePackage(path.join(dir, "node_modules", "react-native-mmkv-lib"), { name: "react-native-mmkv-lib", version: "1.0.0" }, {
      "MmkvLib.podspec": "Pod::Spec.new do |s|\n  s.dependency 'React-Core'\n  s.dependency 'MMKV', '~> 2.0'\nend\n",
    });
    expect((await detect(dir)).limits?.map((l) => [l.id, l.allowKey])).toEqual([["unmapped-pod", "react-native-mmkv-lib"]]);
    const pods = { MMKV: { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] } };
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ pods }));
    expect((await detect(dir)).limits).toEqual([]);
  });

  it("carries the pod pin warnings", async () => {
    const dir = await expo58();
    expect((await detect(dir)).podPins).toEqual([]);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.dependencies["react-native-app-auth"] = "8.5.1";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await writePackage(path.join(dir, "node_modules", "react-native-app-auth"), { name: "react-native-app-auth", version: "8.5.1" }, {
      "react-native-app-auth.podspec": "Pod::Spec.new do |s|\n  s.dependency 'AppAuth', '>= 1.7.6'\nend\n",
    });
    expect((await detect(dir)).podPins).toEqual([]);
    const pods = { AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "1.7.5", products: ["AppAuth"] } };
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ pods }));
    expect((await detect(dir)).podPins).toEqual([
      '⚠ AppAuth 1.7.5 (rn-xtool.config.json) is outside react-native-app-auth\'s requirement ">= 1.7.6"',
    ]);
    // From rn-xtool.config.js, the line names that file.
    await writeFile(path.join(dir, "rn-xtool.config.js"), `export default ${JSON.stringify({ pods })};\n`);
    expect((await detect(dir)).podPins).toEqual([
      '⚠ AppAuth 1.7.5 (rn-xtool.config.js) is outside react-native-app-auth\'s requirement ">= 1.7.6"',
    ]);
  });

  it("carries the stale pod pins of the project's scaffold patches", async () => {
    const dir = await expo58();
    expect((await detect(dir)).scaffoldPins).toEqual([]);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.dependencies["react-native-app-auth"] = "8.5.1";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await writePackage(path.join(dir, "node_modules", "react-native-app-auth"), { name: "react-native-app-auth", version: "8.5.1" }, {
      "react-native-app-auth.podspec": "Pod::Spec.new do |s|\n  s.dependency 'AppAuth', '>= 1.7.6'\nend\n",
    });
    const lines = [
      "// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.",
      "// rn-xtool-scaffold-revision: 8",
      "// rn-xtool-pods: AppAuth=3.0.0",
      "// Cache slot: 0.88.1/dual-flavor",
    ];
    const target = "node_modules/react-native-app-auth/Package.swift";
    await mkdir(path.join(dir, "patches"), { recursive: true });
    await writeFile(
      path.join(dir, "patches", "react-native-app-auth+8.5.1.patch"),
      `diff --git a/${target} b/${target}\nnew file mode 100644\n--- /dev/null\n+++ b/${target}\n@@ -0,0 +1,4 @@\n` +
        `${lines.map((l) => `+${l}`).join("\n")}\n`,
    );
    expect((await detect(dir)).scaffoldPins).toEqual([]);
    const pods = { AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "3.1.0", products: ["AppAuth"] } };
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ pods }));
    expect((await detect(dir)).scaffoldPins).toEqual([
      "⚠ patches/react-native-app-auth+8.5.1.patch pins AppAuth 3.0.0, the config says 3.1.0; delete it so rn-xtool " +
        "regenerates it (also remove node_modules/react-native-app-auth and reinstall: that copy still has the old Package.swift)",
    ]);
  });

  it("carries the exclude lines and skips the excluded libraries", async () => {
    const dir = await expo58();
    expect((await detect(dir)).excluded).toEqual([]);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.dependencies["react-native-mmkv-lib"] = "1.0.0";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
    await writePackage(path.join(dir, "node_modules", "react-native-mmkv-lib"), { name: "react-native-mmkv-lib", version: "1.0.0" }, {
      "MmkvLib.podspec": "Pod::Spec.new do |s|\n  s.dependency 'MMKV', '~> 2.0'\nend\n",
    });
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude: ["react-native-mmkv-lib", "nope"] }));
    const c = await detect(dir);
    expect(c.limits).toEqual([]);
    expect(c.excluded).toEqual([
      expect.stringMatching(/^ℹ exclude — left out of this iOS build: react-native-mmkv-lib \(rn-xtool\.config\.json\)\./),
      "⚠ exclude names nope, which is not a native iOS dependency of this project; ignored",
    ]);
    // From rn-xtool.config.js, the line names that file.
    await writeFile(path.join(dir, "rn-xtool.config.js"), "export default { exclude: ['react-native-mmkv-lib'] };\n");
    expect((await detect(dir)).excluded).toEqual([
      expect.stringMatching(/^ℹ exclude — left out of this iOS build: react-native-mmkv-lib \(rn-xtool\.config\.js\)\./),
    ]);
  });

  it("reads the entitlements", async () => {
    // Expo without ios/: read after expo prebuild.
    expect((await detect(await expo58())).entitlements).toEqual({ pending: true });
    const dir = await bare("0.88.1", "0.88");
    expect((await detect(dir)).entitlements).toBeUndefined();
    const pbxproj = path.join(dir, "ios", "HelloWorld.xcodeproj", "project.pbxproj");
    await writeFile(pbxproj, withEntitlements(await readFile(pbxproj, "utf8"), "HelloWorld/HelloWorld.entitlements"));
    expect((await detect(dir)).entitlements).toEqual({
      error:
        "CODE_SIGN_ENTITLEMENTS names ios/HelloWorld/HelloWorld.entitlements, which does not exist; xtool cannot sign the " +
        "app without it. Fix the setting or create the file.",
    });
    // A file without keys is not passed to xtool (row 52): no line, as without the setting.
    await writeFile(path.join(dir, "ios", "HelloWorld", "HelloWorld.entitlements"), plistOf("<dict/>"));
    expect((await detect(dir)).entitlements).toBeUndefined();
    await writeFile(
      path.join(dir, "ios", "HelloWorld", "HelloWorld.entitlements"),
      plistOf(
        "<dict>\n<key>keychain-access-groups</key>\n<array>\n<string>$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n" +
          "</array>\n<key>aps-environment</key>\n<string>development</string>\n</dict>",
      ),
    );
    expect((await detect(dir)).entitlements).toEqual({
      rel: "ios/HelloWorld/HelloWorld.entitlements",
      lines: ["⚠ aps-environment is not available on a free team; the build continues without it; push notifications fail at runtime."],
    });
  });

  it("reads the app target's includes without a toolchain", async () => {
    // No swift, clang or xtool: pass 1 reads files only.
    vi.stubEnv("PATH", "");
    const root = objcApp("root-group");
    const pending = "ℹ app-includes — 4 includes into React Native's or the libraries' headers: checked at build";
    const resolved = "✔ app-includes — 2 includes of the app's own sources resolve";
    expect((await detect(root)).appTarget).toEqual([pending, resolved]);
    // ios/Config/App.xcconfig, in the main group, as the target's Debug base.
    const pbxproj = path.join(root, "ios", "ObjcApp.xcodeproj", "project.pbxproj");
    const ref = "C50000000000000000000A01";
    let src = await readFile(pbxproj, "utf8");
    for (const [from, to] of [
      ["/* End PBXFileReference section */", `\t\t${ref} = {isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Config/App.xcconfig; sourceTree = "<group>"; };\n$&`],
      ["83CBB9F61A601CBA00E9B192 = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n", `$&\t\t\t\t${ref},\n`],
      ["baseConfigurationReference = 3B4392A12AC88292D35C810B /* Pods-ObjcApp.debug.xcconfig */;", `baseConfigurationReference = ${ref};`],
    ] as const) {
      expect(src).toContain(from);
      src = src.replace(from, to);
    }
    await writeFile(pbxproj, src);
    await mkdir(path.join(root, "ios", "Config"));
    await writeFile(path.join(root, "ios", "Config", "App.xcconfig"), "HEADER_SEARCH_PATHS = $(inherited) Vendor\n");
    expect((await detect(root)).appTarget).toEqual([
      "⚠ app-target — ios/Config/App.xcconfig sets HEADER_SEARCH_PATHS for the app target; rn-xtool does not read xcconfig files",
      pending,
      resolved,
    ]);
  });

  it("gives no app-target line when the project cannot be read", async () => {
    // The app target takes its files from a synchronized folder: the project line names it.
    const root = objcApp("template");
    const pbxproj = path.join(root, "ios", "ObjcApp.xcodeproj", "project.pbxproj");
    const synced = "C60000000000000000000A01";
    const src = (await readFile(pbxproj, "utf8"))
      .replace(
        "/* Begin PBXGroup section */",
        "/* Begin PBXFileSystemSynchronizedRootGroup section */\n" +
          `\t\t${synced} /* ObjcApp */ = {isa = PBXFileSystemSynchronizedRootGroup; path = ObjcApp; sourceTree = "<group>"; };\n` +
          "/* End PBXFileSystemSynchronizedRootGroup section */\n\n/* Begin PBXGroup section */",
      )
      .replace("\t\t\t\t13B07FAE1A68108700A75B9A /* ObjcApp */,\n\t\t\t\t83CBBA001A601CBA00E9B192", `\t\t\t\t${synced} /* ObjcApp */,\n\t\t\t\t83CBBA001A601CBA00E9B192`)
      .replace("\t\t\tdependencies = (\n\t\t\t);\n", `$&\t\t\tfileSystemSynchronizedGroups = (\n\t\t\t\t${synced} /* ObjcApp */,\n\t\t\t);\n`);
    expect(src.match(new RegExp(synced, "g"))).toHaveLength(3);
    await writeFile(pbxproj, src);
    expect((await detect(root)).appTarget).toEqual([]);
  });

  it("reads an Expo app's bridging header once expo prebuild wrote it", async () => {
    const dir = await expo58();
    expect((await detect(dir)).appTarget).toEqual([]);
    await mkdir(path.join(dir, "ios", "LibApp.xcodeproj"), { recursive: true });
    await cp(path.join(fixtures, "pbxproj", "expo-libapp.pbxproj"), path.join(dir, "ios", "LibApp.xcodeproj", "project.pbxproj"));
    await mkdir(path.join(dir, "ios", "LibApp"));
    // A config plugin's imports: the library's header and React Native's, both left to the build.
    await writeFile(
      path.join(dir, "ios", "LibApp", "LibApp-Bridging-Header.h"),
      '#import <React/RCTBridgeModule.h>\n#import "RNAppAuthAuthorizationFlowManager.h"\n',
    );
    expect((await detect(dir)).appTarget).toEqual([
      "ℹ app-includes — 2 includes into React Native's or the libraries' headers: checked at build",
    ]);
    // A header next to it in ios/ is not copied: the build stops, and the line says why.
    await writeFile(path.join(dir, "ios", "LibApp", "LibApp-Shared.h"), "// shared\n");
    await writeFile(
      path.join(dir, "ios", "LibApp", "LibApp-Bridging-Header.h"),
      '#import <React/RCTBridgeModule.h>\n#import "LibApp-Shared.h"\n',
    );
    expect((await detect(dir)).appTarget).toEqual([
      '✖ app-includes — ios/LibApp/LibApp-Bridging-Header.h:2 imports "LibApp-Shared.h", which is not among the files ' +
        "rn-xtool copies next to ios/LibApp/LibApp-Bridging-Header.h or in the app target's headers; " +
        "ios/LibApp/LibApp-Shared.h exists, but rn-xtool copies only the bridging header of an Expo app",
      "ℹ app-includes — 1 includes into React Native's or the libraries' headers: checked at build",
    ]);
    // A setting naming a missing file stops the build's check too: an error line, not silence.
    await rm(path.join(dir, "ios", "LibApp", "LibApp-Bridging-Header.h"));
    expect((await detect(dir)).appTarget).toEqual([
      "✖ app-includes — SWIFT_OBJC_BRIDGING_HEADER in ios/LibApp.xcodeproj names LibApp/LibApp-Bridging-Header.h, which " +
        "does not exist. Run rn-xtool build --clean to run expo prebuild again.",
    ]);
  });

  it("leaves the React Native fields out without react-native", async () => {
    const c = await detect(await bare(null), noNetwork);
    expect(c.rnVersion).toBeUndefined();
    expect(c.scripts).toBeUndefined();
    expect(c.artifacts).toBeUndefined();
    expect(c.podspecs).toEqual({
      subspecs: [],
      compiler_flags: [],
      header_dir: [],
      header_mappings_dir: [],
      vendored_frameworks: [],
      resource_bundles: [],
    });
  });
});

describe("binary pods", () => {
  const LIB = "@react-native-ml-kit/text-recognition";
  const NAME = "rn-xtool-pods.lock.json";
  const VERSIONS: Record<string, string> = {
    GoogleMLKit: "8.0.0",
    MLImage: "1.0.0-beta7",
    MLKitCommon: "13.0.0",
    MLKitTextRecognition: "6.0.0",
    MLKitTextRecognitionChinese: "5.0.0",
    MLKitTextRecognitionDevanagari: "5.0.0",
    MLKitTextRecognitionJapanese: "5.0.0",
    MLKitTextRecognitionKorean: "5.0.0",
    MLKitTextRecognitionCommon: "5.0.0",
    MLKitVision: "9.0.0",
  };
  const entry = (pod: string, sha: string, o: { size?: number; ext?: string; neededBy?: string[] } = {}) => ({
    version: VERSIONS[pod] ?? "1.0.0",
    subspecs: [],
    url: `https://example.invalid/dl/${pod}.${o.ext ?? "tar.gz"}`,
    size: o.size ?? 7000,
    sha256: sha.repeat(64),
    neededBy: o.neededBy ?? [LIB],
  });
  let server: PodsServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** A project with the ML Kit library, `lock` as its lock, and an empty pods cache. */
  async function mlKitProject(lock?: Record<string, unknown>, o: { exclude?: string[] } = {}) {
    const dir = await tempDir("rn-xtool-caps-pods-");
    await writePackage(dir, { name: "app", dependencies: { [LIB]: "2.0.0" } });
    await writePackage(path.join(dir, "node_modules", LIB), { name: LIB, version: "2.0.0" }, {
      "RNMLKitTextRecognition.podspec": "Pod::Spec.new do |s|\n  s.dependency 'React'\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\nend\n",
    });
    if (lock !== undefined) await writeFile(path.join(dir, PODS_LOCK), JSON.stringify({ lockfileVersion: 1, pods: lock }));
    if (o.exclude !== undefined) await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude: o.exclude }));
    const podsCache = await tempDir("rn-xtool-caps-podcache-");
    return { dir, podsCache };
  }
  const cacheFile = async (podsCache: string, sha: string, ext = "tar.gz") => {
    await mkdir(path.join(podsCache, "downloads"), { recursive: true });
    await writeFile(path.join(podsCache, "downloads", `${sha.repeat(64)}.${ext}`), "x");
  };
  const noFetch = (() => {
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;

  it("reports cached binaries", async () => {
    const { dir, podsCache } = await mlKitProject({ GoogleMLKit: entry("GoogleMLKit", "a"), MLKitCommon: entry("MLKitCommon", "b") });
    await cacheFile(podsCache, "a");
    await cacheFile(podsCache, "b");
    const caps = await detectCapabilities(dir, { podsCache, podsFetch: noFetch });
    expect(caps.binaryPods).toEqual([`✔ pods — 2 CocoaPods binaries for ${LIB}, in rn-xtool's cache and in ${NAME}`]);
  });

  it("does not report a locked version the library no longer accepts as ready", async () => {
    const { dir, podsCache } = await mlKitProject({ GoogleMLKit: entry("GoogleMLKit", "a"), MLKitCommon: entry("MLKitCommon", "b") });
    await cacheFile(podsCache, "a");
    await cacheFile(podsCache, "b");
    // The library moved to GoogleMLKit 9.0.0.
    await writeFile(
      path.join(dir, "node_modules", LIB, "RNMLKitTextRecognition.podspec"),
      "Pod::Spec.new do |s|\n  s.dependency 'GoogleMLKit/TextRecognition', '9.0.0'\nend\n",
    );
    const caps = await detectCapabilities(dir, { podsCache, podsFetch: noFetch, offline: true });
    expect(caps.binaryPods).toEqual([
      `⚠ pods — GoogleMLKit: ${NAME} records 8.0.0, which no longer meets "9.0.0" (${LIB} 2.0.0); rn-xtool build resolves it again and records the new version`,
      "ℹ pods — not checked (offline)",
    ]);
  });

  it("reports what is left to download, with its size", async () => {
    const { dir, podsCache } = await mlKitProject({ GoogleMLKit: entry("GoogleMLKit", "a"), MLKitCommon: entry("MLKitCommon", "b", { size: 2_500_000 }) });
    await cacheFile(podsCache, "a");
    const caps = await detectCapabilities(dir, { podsCache, podsFetch: noFetch });
    expect(caps.binaryPods).toEqual([`ℹ pods — 2 CocoaPods binaries for ${LIB}, 1 to download from example.invalid (2.5 MB)`]);
  });

  it("probes unresolved pods within the budget", async () => {
    const { dir, podsCache } = await mlKitProject();
    server = await startPodsServer(podsCdnRoutes(Object.fromEntries(Object.entries(VERSIONS).map(([p, v]) => [p, [v]])), podShard));
    for (const pod of Object.keys(VERSIONS)) server.routes[`/dl/${pod}-${VERSIONS[pod]}.tar.gz`] = { body: Buffer.alloc(1000) };
    const base = server.base;
    const podsFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetch(u.hostname === "example.invalid" ? `${base}${u.pathname}` : input, init);
    }) as typeof fetch;
    const caps = await detectCapabilities(dir, { podsCache, podsCdnBase: base, podsFetch });
    // TextRecognition (Latin) alone: GoogleMLKit, MLImage, MLKitCommon, MLKitTextRecognition(Common) and MLKitVision.
    expect(caps.binaryPods).toEqual([`ℹ pods — 6 CocoaPods binaries for ${LIB}, 6 to download from example.invalid (${formatSize(6000)})`]);
    expect(server.requests.filter((r) => r.startsWith("GET /dl/"))).toEqual([]);
    expect(server.requests.filter((r) => r.startsWith("HEAD /dl/"))).toHaveLength(6);
  });

  it("warns not checked when the probe fails", async () => {
    const { dir, podsCache } = await mlKitProject();
    const closed = await closedPortBase();
    const caps = await detectCapabilities(dir, { podsCache, podsCdnBase: closed });
    expect(caps.binaryPods).toEqual([
      `⚠ pods — not checked: Cannot reach ${new URL(closed).host} (connect ECONNREFUSED) to read the versions of GoogleMLKit`,
    ]);
    server = await startPodsServer({});
    server.routes[`/all_pods_versions_${podShard("GoogleMLKit").join("_")}.txt`] = { hang: true };
    const slow = await detectCapabilities(dir, { podsCache, podsCdnBase: server.base, timeoutMs: 300 });
    expect(slow.binaryPods).toEqual(["⚠ pods — not checked: timed out after 0.3 s"]);
  });

  describe("a git-source pod without a table entry", () => {
    const GIT_LIB = "react-native-git";
    const refusal =
      `${GIT_LIB} 1.0.0: its podspec depends on the CocoaPods pod GitPod, which has no SwiftPM package rn-xtool knows. ` +
      `Add one under "pods" in rn-xtool.config.json: { "pods": { "GitPod": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, ` +
      `or leave the library out with "exclude". See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")}`;
    async function gitProject(allow?: string[]) {
      const dir = await tempDir("rn-xtool-caps-gitpod-");
      await writePackage(dir, { name: "app", dependencies: { [GIT_LIB]: "1.0.0" } });
      await writePackage(path.join(dir, "node_modules", GIT_LIB), { name: GIT_LIB, version: "1.0.0" }, {
        "RNGit.podspec": "Pod::Spec.new do |s|\n  s.dependency 'GitPod'\nend\n",
      });
      if (allow !== undefined) await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ knownLimits: { allow } }));
      server = await startPodsServer({
        [`/all_pods_versions_${podShard("GitPod").join("_")}.txt`]: { body: "GitPod/1.0.0\n" },
        [`/Specs/${podShard("GitPod").join("/")}/GitPod/1.0.0/GitPod.podspec.json`]: {
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
        },
      });
      return { dir, podsCache: await tempDir("rn-xtool-caps-podcache-") };
    }

    it("fails with the resolver's refusal, not a not-checked warning", async () => {
      const { dir, podsCache } = await gitProject();
      const caps = await detectCapabilities(dir, { podsCache, podsCdnBase: server!.base });
      expect(caps.binaryPods).toEqual([`✖ pods — ${refusal}`]);
      // The spec is cached now: the early checks refuse it, and the pods line does not repeat it.
      const again = await detectCapabilities(dir, { podsCache, podsCdnBase: server!.base });
      expect(again.limits?.map((f) => [f.allowed, f.reason])).toEqual([[undefined, refusal]]);
      expect(again.binaryPods).toEqual([]);
    });

    it("warns once for a library knownLimits.allow names", async () => {
      const { dir, podsCache } = await gitProject([GIT_LIB]);
      const allowed = `${refusal} (allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)`;
      const first = await detectCapabilities(dir, { podsCache, podsCdnBase: server!.base });
      expect(first.binaryPods).toEqual([`⚠ pods — ${allowed}`]);
      // The spec is cached now: the early checks' allowed line says it, and the pods line does not repeat it.
      const again = await detectCapabilities(dir, { podsCache, podsCdnBase: server!.base });
      expect(again.limits?.map((f) => (f.allowed ? allowedLimitText(f) : f.reason))).toEqual([allowed]);
      expect(again.binaryPods).toEqual([]);
    });
  });

  it("does not probe with --offline", async () => {
    const { dir, podsCache } = await mlKitProject();
    const caps = await detectCapabilities(dir, { podsCache, podsFetch: noFetch, offline: true });
    expect(caps.binaryPods).toEqual(["ℹ pods — not checked (offline)"]);
  });

  it("lists the lock entries no library needs", async () => {
    const lock = {
      GoogleMLKit: entry("GoogleMLKit", "a"),
      MLKitFoo: entry("MLKitFoo", "c", { neededBy: ["other-lib"] }),
      MLKitBar: entry("MLKitBar", "d", { neededBy: ["other-lib"] }),
    };
    const { dir, podsCache } = await mlKitProject(lock);
    await cacheFile(podsCache, "a");
    const caps = await detectCapabilities(dir, { podsCache, podsFetch: noFetch });
    expect(caps.binaryPods).toEqual([
      `✔ pods — 1 CocoaPods binary for ${LIB}, in rn-xtool's cache and in ${NAME}`,
      `ℹ pods — ${NAME} also records MLKitBar 1.0.0 and MLKitFoo 1.0.0, which no library needs now; rn-xtool keeps these entries`,
    ]);
    const excluded = await mlKitProject(lock, { exclude: [LIB] });
    expect((await detectCapabilities(excluded.dir, { podsCache: excluded.podsCache, podsFetch: noFetch })).binaryPods).toEqual([
      `ℹ pods — ${NAME} also records GoogleMLKit 8.0.0, MLKitBar 1.0.0 and MLKitFoo 1.0.0, which no library needs now; rn-xtool keeps these entries`,
    ]);
  });

  it("adds the unzip line only when a lock entry is a zip", async () => {
    const lock = { GoogleMLKit: entry("GoogleMLKit", "a"), MLKitFoo: entry("MLKitFoo", "c", { ext: "zip" }) };
    const { dir, podsCache } = await mlKitProject(lock);
    await cacheFile(podsCache, "a");
    await cacheFile(podsCache, "c", "zip");
    const unzip = "✖ pods — MLKitFoo 1.0.0 is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.";
    expect((await detectCapabilities(dir, { podsCache, podsFetch: noFetch, hasUnzip: () => false })).binaryPods).toContain(unzip);
    expect((await detectCapabilities(dir, { podsCache, podsFetch: noFetch, hasUnzip: () => true })).binaryPods).not.toContain(unzip);
    const tars = await mlKitProject({ GoogleMLKit: entry("GoogleMLKit", "a") });
    const lines = (await detectCapabilities(tars.dir, { podsCache: tars.podsCache, podsFetch: noFetch, hasUnzip: () => false })).binaryPods;
    expect(lines?.some((l) => l.includes("unzip"))).toBe(false);
  });

  it("prints no pods line for a project without binary pods", async () => {
    const dir = await tempDir("rn-xtool-caps-nopods-");
    await writePackage(dir, { name: "app", dependencies: {} });
    expect((await detectCapabilities(dir, { podsFetch: noFetch })).binaryPods).toEqual([]);
  });
});

describe("unsupportedReason", () => {
  const notFound: HeadProbe = async () => 404;
  async function reason(root: string, head: HeadProbe = ok200): Promise<string | undefined> {
    return unsupportedReason(await detectCapabilities(root, { cacheRoot: await tempDir("rn-xtool-caps-cache-"), head }));
  }

  it("gives unsupported versions a reason", async () => {
    const rn081 = await bare("0.81.5", "none");
    expect(await reason(rn081)).toBe("React Native 0.81: no SwiftPM scripts; support comes with the translator");
    expect(await reason(rn081, notFound)).toBe(
      "React Native 0.81: no SwiftPM scripts, no prebuilt artifacts for 0.81.5; support comes with the translator",
    );
    expect(await reason(await bare("0.89.0", "0.88"))).toBe(
      "React Native 0.89: newer than the lines this release supports (0.85, 0.86, 0.87 and 0.88); a new minor is added once it is verified on a device",
    );
    expect(await reason(await bare("0.86.1", "none"))).toBe(
      "React Native 0.86.1: below the 0.86 floor (0.86.2); move react-native to 0.86.2 or newer",
    );
    expect(await reason(await bare("0.88.0-rc.1", "0.88"))).toBe(
      "React Native 0.88.0-rc.1: a prerelease; rn-xtool supports releases of the 0.88 line from 0.88.0",
    );
    expect(await reason(await expoOther("56.0.4", "0.85.2"))).toBe(
      "Expo SDK 56: expo ships no SwiftPM plugin; React Native 0.85: no SwiftPM scripts; support comes with the translator",
    );
    expect(await reason(await bare(null), noNetwork)).toBe("react-native is not installed: run npm install");
  });

  it("names each scripts shape", async () => {
    const minor084 = async (shape: "0.87" | "0.88") => reason(await bare("0.84.0", shape));
    expect(await minor084("0.87")).toBe("React Native 0.84: SwiftPM scripts without the entry points rn-xtool needs; support comes with the translator");
    expect(await minor084("0.88")).toBe("React Native 0.84: SwiftPM scripts rn-xtool could use, not verified on this line; support comes with the translator");
    const unknown = await bare("0.84.0", "0.88");
    await rm(path.join(unknown, "node_modules", "react-native", "scripts", "spm", "flavored-frameworks.js"));
    expect(await reason(unknown)).toBe("React Native 0.84: SwiftPM scripts rn-xtool does not recognise; support comes with the translator");
  });

  it("says expo is not installed in an Expo project without it", async () => {
    const dir = await expoOther("58.0.21", "0.88.1");
    await rm(path.join(dir, "node_modules", "expo"), { recursive: true });
    const c = await detectCapabilities(dir, { cacheRoot: await tempDir("rn-xtool-caps-cache-"), head: ok200 });
    expect(c).toMatchObject({ kind: "expo", rnVersion: "0.88.1" });
    expect(c.sdk).toBeUndefined();
    expect(unsupportedReason(c)).toBe("expo is not installed: run npm install");
  });

  it("says when an Expo SDK below 57 ships the plugin", async () => {
    const dir = await expoOther("56.0.4", "0.85.2");
    await writeFile(path.join(dir, "node_modules", "expo", "react-native.config.js"), "module.exports = { autolinkingPlugin: './p.js' };\n");
    expect(await reason(dir)).toBe(
      "Expo SDK 56: expo ships its SwiftPM plugin; React Native 0.85: no SwiftPM scripts; support comes with the translator",
    );
  });

  it("has no reason for the lines it supports", async () => {
    expect(await reason(await bare("0.88.2", "0.88"))).toBeUndefined();
    expect(await reason(await bare("0.85.0", "none"))).toBeUndefined();
    expect(await reason(await bare("0.85.4", "none"))).toBeUndefined();
    expect(await reason(await expo57())).toBeUndefined();
    expect(await reason(await expo58())).toBeUndefined();
    const sdk59 = await tempDir("rn-xtool-caps-expo59-");
    await cp(path.join(fixtures, "project"), sdk59, { recursive: true });
    await fakeExpo58Modules(sdk59, { expo: "59.0.0" });
    expect(await reason(sdk59)).toBeUndefined();
  });
});
