import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build, buildSteps, chooseMetroPort, type BuildDeps } from "../src/commands/build.js";
import { jsiRnHeaderDirs } from "../src/pipeline/jsi.js";
import { readState, writeState } from "../src/state.js";

const expoFlags = { kind: "expo" as const, hasExpoModules: true, hasExpoConstants: true, rnArtifacts: false, expoPlugin: "installed" as const };
const bareFlags = { kind: "bare" as const, hasExpoModules: false, hasExpoConstants: false, rnArtifacts: false, expoPlugin: "installed" as const };

describe("buildSteps", () => {
  it("starts with prebuild when ios/ is missing", () => {
    expect(buildSteps({ ...expoFlags, hasIos: false, clean: false })[0]).toBe("prebuild");
  });
  it("omits prebuild when ios/ exists", () => {
    expect(buildSteps({ ...expoFlags, hasIos: true, clean: false })).toEqual([
      "patches", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("uses prebuild --clean when clean", () => {
    const steps = buildSteps({ ...expoFlags, hasIos: true, clean: true });
    expect(steps[0]).toBe("prebuild --clean");
    expect(steps).not.toContain("prebuild");
  });
  it("keeps the expo steps whatever the module flags say", () => {
    expect(buildSteps({ ...expoFlags, hasExpoConstants: false, hasIos: true, clean: false })).toEqual(
      buildSteps({ ...expoFlags, hasIos: true, clean: false }),
    );
  });
  it("bare pure: no prebuild, jsi or app-config", () => {
    expect(buildSteps({ ...bareFlags, hasIos: false, clean: false })).toEqual([
      "patches", "rn-spm", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("bare --clean cleans instead of prebuilding", () => {
    const steps = buildSteps({ ...bareFlags, hasIos: true, clean: true });
    expect(steps).toEqual(["clean", "patches", "rn-spm", "frameworks", "generate", "xtool-build"]);
  });
  it("bare hybrid: jsi with expo modules, app-config only with expo-constants", () => {
    const hybrid = { ...bareFlags, hasExpoModules: true, hasIos: true, clean: false };
    expect(buildSteps(hybrid)).toEqual(["patches", "rn-spm", "jsi", "frameworks", "generate", "xtool-build"]);
    expect(buildSteps({ ...hybrid, hasExpoConstants: true })).toEqual([
      "patches", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("bare vendored: rn-artifacts between patches and rn-spm", () => {
    expect(buildSteps({ ...bareFlags, rnArtifacts: true, hasIos: true, clean: false })).toEqual([
      "patches", "rn-artifacts", "rn-spm", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("expo 58 (installed plugin) never gets rn-artifacts", () => {
    expect(buildSteps({ ...expoFlags, rnArtifacts: true, hasIos: true, clean: false })).not.toContain("rn-artifacts");
  });
  it("expo 57: jsi before rn-spm, with rn-artifacts", () => {
    const sdk57 = { ...expoFlags, expoPlugin: "vendored" as const, rnArtifacts: true, hasIos: true, clean: false };
    expect(buildSteps(sdk57)).toEqual([
      "patches", "rn-artifacts", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
    expect(buildSteps({ ...sdk57, rnArtifacts: false })).toEqual([
      "patches", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("expo 57 --clean re-creates artifacts and JSI headers before rn-spm", () => {
    expect(buildSteps({ ...expoFlags, expoPlugin: "vendored", rnArtifacts: true, hasIos: true, clean: true })).toEqual([
      "prebuild --clean", "patches", "rn-artifacts", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
});

type ProjectOver = { kind?: "expo" | "bare"; hasExpoModules?: boolean; hasExpoConstants?: boolean; hasDevClient?: boolean; hasRnCli?: boolean; rnVersion?: string };

function setup(over: { isPortFree?: (p: number) => Promise<boolean>; isMetroRunning?: (p: number) => Promise<boolean>; hasIos?: boolean; cfg?: object; route?: { ip?: string; dev?: string }; project?: ProjectOver & { rnScripts?: "installed" | "vendored"; expoPlugin?: "installed" | "vendored" }; applyPatches?: BuildDeps["applyPatches"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "build-"));
  const calls: string[] = [];
  const logs: string[] = [];
  const rec = (n: string) => async () => {
    calls.push(n);
  };
  const writeIosXtool = vi.fn(async () => {
    calls.push("generate");
  });
  const deps: BuildDeps = {
    loadConfig: async () => ({ metroPort: 8081, ...over.cfg }),
    readProject: async () =>
      ({
        kind: "expo",
        bundleIdentifier: "com.example.app",
        hasExpoModules: true,
        hasExpoConstants: true,
        hasDevClient: false,
        rnVersion: "0.88.0",
        rnScripts: "installed",
        expoPlugin: "installed",
        ...over.project,
      }) as never,
    exists: () => over.hasIos ?? false,
    remove: async (path) => {
      calls.push(`remove ${path}`);
    },
    prebuild: async (_r, clean) => {
      calls.push(clean ? "prebuild --clean" : "prebuild");
    },
    applyPatches: over.applyPatches ?? rec("patches"),
    prepareRnArtifacts: async (_paths, version) => {
      calls.push("rn-artifacts");
      return `/adapted/${version}`;
    },
    runRnSpm: rec("rn-spm"),
    buildJsi: async () => {
      calls.push("jsi");
      return { name: "ExpoModulesJSI" } as never;
    },
    generateAppConfig: rec("app-config"),
    readFrameworks: () => [{ name: "A" } as never],
    stageFrameworks: rec("frameworks"),
    writeIosXtool,
    isPortFree: over.isPortFree ?? (async () => true),
    isMetroRunning: over.isMetroRunning ?? (async () => false),
    findFreePort: async (s) => s,
    detectLanIp: async () => "10.0.0.7",
    detectLanRoute: async () => over.route ?? { ip: "10.0.0.7", dev: "eth0" },
    devBuild: rec("xtool-build"),
    xtoolBin: () => "/bin/xtool",
    readState,
    depsFingerprint: async () => "fp-test",
    log: (s) => logs.push(s),
  };
  return { root, calls, logs, deps, writeIosXtool };
}

describe("build", () => {
  it("leaves no fingerprint in the state when xtool-build fails", async () => {
    const t = setup();
    const devBuild = async () => {
      throw new Error("xtool failed");
    };
    await expect(build(t.root, {}, { ...t.deps, devBuild })).rejects.toThrow("xtool failed");
    const state = await readState(join(t.root, "ios-xtool"));
    expect(state?.metroPort).toBe(8081);
    expect(state?.depsFingerprint).toBeUndefined();
  });

  it("records the dependency fingerprint in the state", async () => {
    const t = setup();
    await build(t.root, {}, t.deps);
    expect((await readState(join(t.root, "ios-xtool")))?.depsFingerprint).toBe("fp-test");
  });

  it("runs steps in order, passes port/ip and writes state", async () => {
    const t = setup();
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { metroPort: number; lanIp: string; frameworks: unknown[] };
    expect(ctx.metroPort).toBe(8081);
    expect(ctx.lanIp).toBe("10.0.0.7");
    expect(ctx.frameworks).toHaveLength(2);
    const state = await readState(join(t.root, "ios-xtool"));
    expect(state).toMatchObject({ version: 1, metroPort: 8081, lanIp: "10.0.0.7", bundleIdentifier: "com.example.app" });
    expect(t.logs).toContain("▸ patches");
    expect(t.logs.some((l) => /^✔ patches \(\d+(\.\d+)?s\)$/.test(l))).toBe(true);
  });
  it("skips prebuild when ios exists and honors config lanIp", async () => {
    const t = setup({ hasIos: true, cfg: { lanIp: "1.2.3.4" } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: true, clean: false }));
    expect((await readState(join(t.root, "ios-xtool")))?.lanIp).toBe("1.2.3.4");
  });
  it("prebuilds with --clean", async () => {
    const t = setup({ hasIos: true });
    await build(t.root, { clean: true }, t.deps);
    expect(t.calls[0]).toBe("prebuild --clean");
  });
  it("passes the scripts and plugin sources to the patches step", async () => {
    const applyPatches = vi.fn(async () => {});
    const t = setup({ applyPatches, project: { kind: "bare", rnScripts: "vendored" } });
    await build(t.root, {}, t.deps);
    expect(applyPatches).toHaveBeenCalledWith(t.root, { rnScripts: "vendored", expoPlugin: "installed" });
    const sdk57 = vi.fn(async () => {});
    const t57 = setup({ applyPatches: sdk57, project: { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored", rnVersion: "0.86.3" } });
    await build(t57.root, {}, t57.deps);
    expect(sdk57).toHaveBeenCalledWith(t57.root, { rnScripts: "vendored", expoPlugin: "vendored" });
    const sdk58 = vi.fn(async () => {});
    const t58 = setup({ applyPatches: sdk58, project: { kind: "expo" } });
    await build(t58.root, {}, t58.deps);
    expect(sdk58).toHaveBeenCalledWith(t58.root, { rnScripts: "installed", expoPlugin: "installed" });
  });

  it("build passes the kind to runRnSpm and skips prebuild for bare", async () => {
    const t = setup({ project: { kind: "bare", hasExpoModules: false, hasExpoConstants: false } });
    const runRnSpm = vi.fn(async () => {
      t.calls.push("rn-spm");
    });
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(t.calls).toEqual(buildSteps({ ...bareFlags, hasIos: false, clean: false }));
    expect(runRnSpm).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), { rnArtifactsDir: undefined, kind: "bare", rnScripts: "installed", expoPlugin: "installed" });
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A"]);
  });
  it("passes the scripts source to runRnSpm", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored" } });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rnScripts: "vendored" }));
  });

  it("runs rn-artifacts for a bare project on vendored scripts", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3", hasExpoModules: false, hasExpoConstants: false } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(["patches", "rn-artifacts", "rn-spm", "frameworks", "generate", "xtool-build"]);
    expect(t.logs).toContain("▸ rn-artifacts");
  });
  it("passes the prepared artifacts root to runRnSpm", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, runRnSpm });
    expect(prepareRnArtifacts).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), "0.86.3");
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/adapted/0.86.3", kind: "bare", rnScripts: "vendored", expoPlugin: "installed" });
  });
  it("rnArtifactsDir bypasses rn-artifacts", async () => {
    const t = setup({ cfg: { rnArtifactsDir: "/mine" }, project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, runRnSpm });
    expect(prepareRnArtifacts).not.toHaveBeenCalled();
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/mine", kind: "bare", rnScripts: "vendored", expoPlugin: "installed" });
    expect(t.logs).not.toContain("▸ rn-artifacts");
  });
  it("never runs rn-artifacts for installed scripts", async () => {
    const prepareRnArtifacts = vi.fn(async () => "/adapted/x");
    const bare = setup({ project: { kind: "bare", rnScripts: "installed" } });
    await build(bare.root, {}, { ...bare.deps, prepareRnArtifacts });
    const expo = setup();
    await build(expo.root, {}, { ...expo.deps, prepareRnArtifacts });
    expect(prepareRnArtifacts).not.toHaveBeenCalled();
  });
  const sdk57 = { kind: "expo" as const, rnScripts: "vendored" as const, expoPlugin: "vendored" as const, rnVersion: "0.86.3" };
  it("expo 57 --clean re-creates artifacts and JSI headers before rn-spm", async () => {
    const t = setup({ hasIos: true, project: sdk57 });
    await build(t.root, { clean: true }, t.deps);
    const order = buildSteps({ ...expoFlags, expoPlugin: "vendored", rnArtifacts: true, hasIos: true, clean: true });
    expect(t.calls).toEqual(order);
    expect(t.logs.filter((l) => l.startsWith("▸ "))).toEqual(order.map((s) => `▸ ${s}`));
  });
  it("expo 57 builds JSI from the prepared artifacts", async () => {
    const t = setup({ hasIos: true, project: sdk57 });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const buildJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, buildJsi, runRnSpm });
    expect(buildJsi).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), {
      rnHeaders: jsiRnHeaderDirs("/adapted/0.86.3"),
      headersXcframework: true,
    });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/adapted/0.86.3", kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" });
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A", "ExpoModulesJSI"]);

    const u = setup({ hasIos: true, cfg: { rnArtifactsDir: "/mine" }, project: sdk57 });
    const prepare = vi.fn(async () => "/adapted/0.86.3");
    const jsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const spm = vi.fn(async () => {});
    await build(u.root, {}, { ...u.deps, prepareRnArtifacts: prepare, buildJsi: jsi, runRnSpm: spm });
    expect(prepare).not.toHaveBeenCalled();
    expect(jsi).toHaveBeenCalledWith(expect.anything(), { rnHeaders: jsiRnHeaderDirs("/mine"), headersXcframework: true });
    expect(spm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/mine", kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" });
  });
  it("expo 58 and bare plans are unchanged", async () => {
    const t = setup({ hasIos: true });
    const buildJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, buildJsi, runRnSpm });
    expect(buildJsi.mock.calls).toEqual([[expect.objectContaining({ root: t.root })]]);
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: undefined, kind: "expo", rnScripts: "installed", expoPlugin: "installed" });
    const b = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: false } });
    const bareJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    await build(b.root, {}, { ...b.deps, buildJsi: bareJsi });
    expect(bareJsi.mock.calls).toEqual([[expect.objectContaining({ root: b.root })]]);
  });
  it("records the React Native version in the state", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    await build(t.root, {}, t.deps);
    expect((await readState(join(t.root, "ios-xtool")))?.rnVersion).toBe("0.86.3");
  });

  it("passes the expo kind to runRnSpm", async () => {
    const t = setup({ hasIos: true });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: undefined, kind: "expo", rnScripts: "installed", expoPlugin: "installed" });
  });
  it("builds the JSI framework for a bare project with expo modules, app-config only with expo-constants", async () => {
    const t = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: false } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(["patches", "rn-spm", "jsi", "frameworks", "generate", "xtool-build"]);
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A", "ExpoModulesJSI"]);
    const u = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: true } });
    await build(u.root, {}, u.deps);
    expect(u.calls).toContain("app-config");
  });
  it("stops a bare build before any step when @react-native-community/cli is missing", async () => {
    const t = setup({ hasIos: true, project: { kind: "bare", hasRnCli: false } });
    await expect(build(t.root, { clean: true }, t.deps)).rejects.toThrow(
      /@react-native-community\/cli is not installed.*npm install --save-dev @react-native-community\/cli/s,
    );
    expect(t.calls).toEqual([]);
  });
  it("cleans ios/build and ios-xtool instead of prebuilding a bare project", async () => {
    const t = setup({ hasIos: true, project: { kind: "bare" } });
    await build(t.root, { clean: true }, t.deps);
    expect(t.calls.slice(0, 2)).toEqual([`remove ${join(t.root, "ios", "build")}`, `remove ${join(t.root, "ios-xtool")}`]);
    expect(t.calls.some((c) => c.startsWith("prebuild"))).toBe(false);
    expect(t.logs).toContain("▸ clean");
  });
  it("records the project kind and the dev client in the state", async () => {
    const t = setup({ project: { kind: "bare", hasDevClient: true } });
    await build(t.root, {}, t.deps);
    expect(await readState(join(t.root, "ios-xtool"))).toMatchObject({ kind: "bare", hasDevClient: true });
    const e = setup();
    await build(e.root, {}, e.deps);
    expect(await readState(join(e.root, "ios-xtool"))).toMatchObject({ kind: "expo", hasDevClient: false });
  });
  it("picks another port when the configured one is busy", async () => {
    const t = setup({ isPortFree: async () => false });
    t.deps.findFreePort = async (s) => s + 3;
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Port 8081 is busy; baking Metro port 8085 into the app.");
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { metroPort: number };
    expect(ctx.metroPort).toBe(8085);
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8085);
  });
  it("keeps the configured port when our own Metro holds it", async () => {
    const t = setup({ isPortFree: async () => false, isMetroRunning: async () => true });
    const find = vi.fn(async (s: number) => s + 1);
    t.deps.findFreePort = find;
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Metro is already running on port 8081; keeping it.");
    expect(find).not.toHaveBeenCalled();
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8081);
  });
  it("does not probe Metro when the port is free", async () => {
    const probe = vi.fn(async () => true);
    const t = setup({ isMetroRunning: probe });
    await build(t.root, {}, t.deps);
    expect(probe).not.toHaveBeenCalled();
  });
  const warning = (l: string) => l.includes("looks like a VPN/tunnel address");
  it("warns, without blocking, when the detected route is a tunnel", async () => {
    const t = setup({ route: { ip: "10.8.0.2", dev: "tun0" } });
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain(
      '⚠ Detected LAN IP 10.8.0.2 on tun0 looks like a VPN/tunnel address; the iPhone may not reach Metro. Set "lanIp" in rn-xtool.config.json to your Wi‑Fi address if it fails.',
    );
    expect(t.calls).toContain("xtool-build");
  });
  it("does not warn for a private Wi-Fi route or a pinned lanIp", async () => {
    const a = setup();
    await build(a.root, {}, a.deps);
    expect(a.logs.some(warning)).toBe(false);
    const b = setup({ cfg: { lanIp: "1.2.3.4" }, route: { ip: "10.8.0.2", dev: "tun0" } });
    await build(b.root, {}, b.deps);
    expect(b.logs.some(warning)).toBe(false);
  });
});

describe("chooseMetroPort", () => {
  const mk = (free: number[], metro: number[], previous?: number) => ({
    configured: 8081,
    previous,
    isPortFree: async (p: number) => free.includes(p),
    isMetroRunning: async (p: number) => metro.includes(p),
    findFreePort: async (s: number) => s,
  });
  it("configured-free", async () => {
    expect(await chooseMetroPort(mk([8081], [], 8082))).toEqual({ port: 8081, reason: "configured-free" });
  });
  it("configured-metro", async () => {
    expect(await chooseMetroPort(mk([], [8081, 8082], 8082))).toEqual({ port: 8081, reason: "configured-metro" });
  });
  it("previous-free", async () => {
    expect(await chooseMetroPort(mk([8082], [], 8082))).toEqual({ port: 8082, reason: "previous-free" });
  });
  it("previous-metro (the Docker-on-8081 regression)", async () => {
    expect(await chooseMetroPort(mk([], [8082], 8082))).toEqual({ port: 8082, reason: "previous-metro" });
  });
  it("fallback when previous is busy and not Metro", async () => {
    expect(await chooseMetroPort(mk([], [], 8082))).toEqual({ port: 8082, reason: "fallback" });
  });
  it("fallback without previous", async () => {
    expect(await chooseMetroPort(mk([], []))).toEqual({ port: 8082, reason: "fallback" });
  });
  it("ignores previous when equal to configured", async () => {
    const probe = vi.fn(async () => false);
    const r = await chooseMetroPort({ ...mk([], [], 8081), isPortFree: probe });
    expect(r.reason).toBe("fallback");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("build previous port", () => {
  it("keeps the previous build's Metro port when the configured one is busy", async () => {
    const t = setup({ isPortFree: async () => false, isMetroRunning: async (p) => p === 8082 });
    await writeState(join(t.root, "ios-xtool"), { version: 1, metroPort: 8082, lanIp: "x", bundleIdentifier: "b", builtAt: "t" });
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Port 8081 is busy (not a Metro bundler); keeping the previous build's port 8082 where Metro is running.");
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8082);
  });
});

describe("build keeps the Wi‑Fi device", () => {
  it("carries deviceIp and deviceUdid over from the previous state", async () => {
    const t = setup();
    const dir = join(t.root, "ios-xtool");
    await writeState(dir, { version: 1, metroPort: 8081, lanIp: "x", bundleIdentifier: "b", builtAt: "t", deviceIp: "192.168.1.10", deviceUdid: "U" });
    await build(t.root, {}, t.deps);
    const s = await readState(dir);
    expect([s?.deviceIp, s?.deviceUdid]).toEqual(["192.168.1.10", "U"]);
  });
});

describe("build corrupt state", () => {
  it("warns, ignores the unreadable state, continues and rewrites it", async () => {
    const t = setup();
    const dir = join(t.root, "ios-xtool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".rn-xtool-state.json"), "{not json");
    await build(t.root, {}, t.deps);
    expect(t.logs.some((l) => l.startsWith("⚠ Ignoring unreadable build state (") && l.endsWith("a fresh one will be written."))).toBe(true);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
    expect((await readState(dir))?.metroPort).toBe(8081);
  });
});
