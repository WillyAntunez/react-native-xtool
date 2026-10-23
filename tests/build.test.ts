import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build, buildSteps, type BuildDeps } from "../src/commands/build.js";
import { readState } from "../src/state.js";

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

function setup(over: { isPortFree?: (p: number) => Promise<boolean>; isMetroRunning?: (p: number) => Promise<boolean>; hasIos?: boolean; cfg?: object } = {}) {
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
    devBuild: rec("xtool-build"),
    xtoolBin: () => "/bin/xtool",
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
});
