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

  it("detects an Expo SDK 58 project", async () => {
    const c = await detect(await expo58());
    expect(c).toMatchObject({
      kind: "expo",
      sdk: 58,
      expoVersion: "58.0.21",
      rnVersion: "0.88.1",
      expoPlugin: "ships",
      expoModules: "precompiled",
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
      "React Native 0.89: newer than the lines this release supports (0.86, 0.87 and 0.88); a new minor is added once it is verified on a device",
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
    expect(await reason(await expo57())).toBeUndefined();
    expect(await reason(await expo58())).toBeUndefined();
    const sdk59 = await tempDir("rn-xtool-caps-expo59-");
    await cp(path.join(fixtures, "project"), sdk59, { recursive: true });
    await fakeExpo58Modules(sdk59, { expo: "59.0.0" });
    expect(await reason(sdk59)).toBeUndefined();
  });
});
