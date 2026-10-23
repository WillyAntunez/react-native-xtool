import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build, buildSteps, chooseMetroPort, type BuildDeps } from "../src/commands/build.js";
import { readState, writeState } from "../src/state.js";

describe("buildSteps", () => {
  it("starts with prebuild when ios/ is missing", () => {
    expect(buildSteps({ hasIos: false, clean: false })[0]).toBe("prebuild");
  });
  it("omits prebuild when ios/ exists", () => {
    expect(buildSteps({ hasIos: true, clean: false })).toEqual([
      "patches", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("uses prebuild --clean when clean", () => {
    const steps = buildSteps({ hasIos: true, clean: true });
    expect(steps[0]).toBe("prebuild --clean");
    expect(steps).not.toContain("prebuild");
  });
});

function setup(over: { isPortFree?: (p: number) => Promise<boolean>; isMetroRunning?: (p: number) => Promise<boolean>; hasIos?: boolean; cfg?: object; route?: { ip?: string; dev?: string } } = {}) {
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
    readProject: async () => ({ bundleIdentifier: "com.example.app" }) as never,
    exists: () => over.hasIos ?? false,
    prebuild: async (_r, clean) => {
      calls.push(clean ? "prebuild --clean" : "prebuild");
    },
    applyPatches: rec("patches"),
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
    log: (s) => logs.push(s),
  };
  return { root, calls, logs, deps, writeIosXtool };
}

describe("build", () => {
  it("runs steps in order, passes port/ip and writes state", async () => {
    const t = setup();
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ hasIos: false, clean: false }));
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
    expect(t.calls).toEqual(buildSteps({ hasIos: true, clean: false }));
    expect((await readState(join(t.root, "ios-xtool")))?.lanIp).toBe("1.2.3.4");
  });
  it("prebuilds with --clean", async () => {
    const t = setup({ hasIos: true });
    await build(t.root, { clean: true }, t.deps);
    expect(t.calls[0]).toBe("prebuild --clean");
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
      '⚠ Detected LAN IP 10.8.0.2 on tun0 looks like a VPN/tunnel address; the iPhone may not reach Metro. Set "lanIp" in expo-xtool.config.json to your Wi‑Fi address if it fails.',
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

describe("build corrupt state", () => {
  it("warns, ignores the unreadable state, continues and rewrites it", async () => {
    const t = setup();
    const dir = join(t.root, "ios-xtool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".expo-xtool-state.json"), "{not json");
    await build(t.root, {}, t.deps);
    expect(t.logs.some((l) => l.startsWith("⚠ Ignoring unreadable build state (") && l.endsWith("a fresh one will be written."))).toBe(true);
    expect(t.calls).toEqual(buildSteps({ hasIos: false, clean: false }));
    expect((await readState(dir))?.metroPort).toBe(8081);
  });
});
