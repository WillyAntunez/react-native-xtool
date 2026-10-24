import { describe, expect, it, vi } from "vitest";
import { run as runCommand } from "../src/commands/run.js";
import {
  ipMismatchMessage,
  portMismatchMessage,
  start,
  startDecision,
  type StartDeps,
} from "../src/commands/start.js";

const REMEDY = "expo-xtool build && expo-xtool install";
const state = {
  version: 1 as const,
  metroPort: 8081,
  lanIp: "192.168.1.5",
  bundleIdentifier: "com.example.app",
  builtAt: "2026-01-01T00:00:00.000Z",
  depsFingerprint: "fp",
};

function makeDeps(over: Partial<StartDeps> = {}) {
  const exec = vi.fn(async () => {});
  const log = vi.fn();
  const deps: StartDeps = {
    readState: async () => state,
    loadConfig: async () => ({}) as never,
    isPortFree: async () => true,
    isMetroRunning: async () => false,
    findFreePort: async (p) => p,
    detectLanIp: async () => "192.168.1.5",
    depsFingerprint: async () => "fp",
    run: exec,
    log,
    ...over,
  };
  return { deps, exec, log };
}

describe("messages", () => {
  it("port message has both ports, install and the remedy", () => {
    const m = portMismatchMessage(8081, 8082);
    expect(m).toContain("8081");
    expect(m).toContain("8082");
    expect(m).toContain("install");
    expect(m).toContain(REMEDY);
  });
  it("ip message has both IPs, install and the remedy", () => {
    const m = ipMismatchMessage("192.168.1.5", "10.0.0.7");
    expect(m).toContain("192.168.1.5");
    expect(m).toContain("10.0.0.7");
    expect(m).toContain("install");
    expect(m).toContain(REMEDY);
  });
});

describe("startDecision", () => {
  const base = { portFree: true, metroRunning: false, builtIp: "a", currentIp: "a" };
  it("ok", () => {
    expect(startDecision(base)).toBe("ok");
  });
  it("metro-running when the port is held by Metro", () => {
    expect(startDecision({ ...base, portFree: false, metroRunning: true })).toBe("metro-running");
  });
  it("port-mismatch when the port is held by something else", () => {
    expect(startDecision({ ...base, portFree: false })).toBe("port-mismatch");
  });
  it("ip-mismatch", () => {
    expect(startDecision({ ...base, currentIp: "b" })).toBe("ip-mismatch");
  });
  it("ip-mismatch wins over metro-running and port-mismatch", () => {
    expect(startDecision({ ...base, portFree: false, metroRunning: true, currentIp: "b" })).toBe("ip-mismatch");
    expect(startDecision({ ...base, portFree: false, currentIp: "b" })).toBe("ip-mismatch");
  });
});

describe("start", () => {
  it("throws when there is no build state", async () => {
    const { deps, exec } = makeDeps({ readState: async () => undefined });
    await expect(start("/p", {}, deps)).rejects.toThrow("No build state found. Run `expo-xtool build` first.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("treats an unreadable build state like a missing one", async () => {
    const { deps, exec } = makeDeps({ readState: async () => { throw new Error("bad json"); } });
    await expect(start("/p", {}, deps)).rejects.toThrow("No build state found. Run `expo-xtool build` first.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects with the port message when the port is busy", async () => {
    const { deps, exec } = makeDeps({ isPortFree: async () => false, findFreePort: async () => 8082 });
    const msg = portMismatchMessage(8081, 8082);
    await expect(start("/p", {}, deps)).rejects.toThrow(msg);
    expect(exec).not.toHaveBeenCalled();
  });

  it("logs and does not start when Metro already serves the baked port", async () => {
    const { deps, exec, log } = makeDeps({ isPortFree: async () => false, isMetroRunning: async () => true });
    await expect(start("/p", {}, deps)).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "Metro is already running on port 8081 (http://192.168.1.5:8081). Nothing to start — open the app on your iPhone.",
    );
  });

  it("still rejects on a LAN IP change when Metro is running", async () => {
    const { deps, exec } = makeDeps({
      isPortFree: async () => false,
      isMetroRunning: async () => true,
      detectLanIp: async () => "10.0.0.7",
    });
    await expect(start("/p", {}, deps)).rejects.toThrow(ipMismatchMessage("192.168.1.5", "10.0.0.7"));
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects with the ip message when the LAN IP changed", async () => {
    const { deps, exec } = makeDeps({ detectLanIp: async () => "10.0.0.7" });
    await expect(start("/p", {}, deps)).rejects.toThrow(ipMismatchMessage("192.168.1.5", "10.0.0.7"));
    expect(exec).not.toHaveBeenCalled();
  });

  it("prefers config.lanIp over detection", async () => {
    const detect = vi.fn(async () => "10.0.0.7");
    const { deps, exec } = makeDeps({
      loadConfig: async () => ({ lanIp: "192.168.1.5" }) as never,
      detectLanIp: detect,
    });
    await start("/p", {}, deps);
    expect(detect).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("runs expo start with the baked port when ok", async () => {
    const { deps, exec } = makeDeps();
    await start("/p", {}, deps);
    expect(exec).toHaveBeenCalledWith("npx", ["expo", "start", "--lan", "--port", "8081"], { cwd: "/p" });
  });
});

describe("start and dependency changes", () => {
  it("warns and passes --clear when the fingerprint differs", async () => {
    const { deps, exec, log } = makeDeps({ depsFingerprint: async () => "other" });
    await start("/p", {}, deps);
    expect(exec).toHaveBeenCalledWith("npx", ["expo", "start", "--lan", "--port", "8081", "--clear"], { cwd: "/p" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Dependencies changed since the last build"));
  });
  it("warns and clears when the state has no fingerprint", async () => {
    const { depsFingerprint: _omit, ...old } = state;
    const { deps, exec, log } = makeDeps({ readState: async () => old });
    await start("/p", {}, deps);
    expect(exec.mock.calls[0]?.[1]).toContain("--clear");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Dependencies changed"));
  });
  it("does not clear or warn when equal", async () => {
    const { deps, exec, log } = makeDeps();
    await start("/p", {}, deps);
    expect(exec.mock.calls[0]?.[1]).not.toContain("--clear");
    expect(log).not.toHaveBeenCalled();
  });
  it("--clear forces the flag without a warning", async () => {
    const { deps, exec, log } = makeDeps();
    await start("/p", { clear: true }, deps);
    expect(exec.mock.calls[0]?.[1]).toContain("--clear");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("run", () => {
  const fresh = (over: Partial<Parameters<typeof runCommand>[2]> & object = {}) => {
    const calls: string[] = [];
    const log = vi.fn();
    const overrides = {
      build: async (_r: string, o: { clean?: boolean }) => void calls.push(`build:${o.clean}`),
      install: async () => void calls.push("install"),
      start: async () => void calls.push("start"),
      readState: async () => state,
      depsFingerprint: async () => "fp",
      exists: () => true,
      log,
      ...over,
    };
    return { calls, log, overrides };
  };

  it("runs build, install, start in order", async () => {
    const { calls, overrides } = fresh({ readState: async () => undefined });
    await runCommand("/p", { clean: true }, overrides);
    expect(calls).toEqual(["build:true", "install", "start"]);
  });

  it("starts Metro with --clear after a rebuild, not after a skip", async () => {
    const built = fresh({ readState: async () => undefined });
    const start = vi.fn(async () => {});
    await runCommand("/p", {}, { ...built.overrides, start });
    expect(start).toHaveBeenLastCalledWith("/p", { clear: true });
    const skipped = fresh();
    const start2 = vi.fn(async () => {});
    await runCommand("/p", {}, { ...skipped.overrides, start: start2 });
    expect(start2).toHaveBeenLastCalledWith("/p", {});
  });

  it("skips build and install when up to date", async () => {
    const { calls, log, overrides } = fresh();
    await runCommand("/p", {}, overrides);
    expect(calls).toEqual(["start"]);
    expect(log).toHaveBeenCalledWith("Native app is up to date (no dependency changes); skipping build and install.");
  });

  it.each([
    ["fingerprints differ", { depsFingerprint: async () => "other" }, {}],
    ["App.app is missing", { exists: () => false }, {}],
    ["no state exists", { readState: async () => undefined }, {}],
    ["state has no fingerprint", { readState: async () => ({ ...state, depsFingerprint: undefined }) }, {}],
    ["--force", {}, { force: true }],
    ["--clean", {}, { clean: true }],
  ])("builds and installs when %s", async (_n, over, opts) => {
    const { calls, overrides } = fresh(over);
    await runCommand("/p", opts, overrides);
    expect(calls.slice(1)).toEqual(["install", "start"]);
    expect(calls[0]).toMatch(/^build/);
  });

  it("aborts when build rejects", async () => {
    const install = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const { overrides } = fresh({ build: async () => { throw new Error("boom"); }, install, start, readState: async () => undefined });
    await expect(runCommand("/p", {}, overrides)).rejects.toThrow("boom");
    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
