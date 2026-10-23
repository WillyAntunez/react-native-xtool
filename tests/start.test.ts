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
};

function makeDeps(over: Partial<StartDeps> = {}) {
  const exec = vi.fn(async () => {});
  const deps: StartDeps = {
    readState: async () => state,
    loadConfig: async () => ({}) as never,
    isPortFree: async () => true,
    findFreePort: async (p) => p,
    detectLanIp: async () => "192.168.1.5",
    run: exec,
    ...over,
  };
  return { deps, exec };
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
  it("ok", () => {
    expect(startDecision({ portFree: true, builtIp: "a", currentIp: "a" })).toBe("ok");
  });
  it("port-mismatch wins over ip-mismatch", () => {
    expect(startDecision({ portFree: false, builtIp: "a", currentIp: "b" })).toBe("port-mismatch");
  });
  it("ip-mismatch", () => {
    expect(startDecision({ portFree: true, builtIp: "a", currentIp: "b" })).toBe("ip-mismatch");
  });
});

describe("start", () => {
  it("throws when there is no build state", async () => {
    const { deps, exec } = makeDeps({ readState: async () => undefined });
    await expect(start("/p", deps)).rejects.toThrow("No build state found. Run `expo-xtool build` first.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects with the port message when the port is busy", async () => {
    const { deps, exec } = makeDeps({ isPortFree: async () => false, findFreePort: async () => 8082 });
    const msg = portMismatchMessage(8081, 8082);
    await expect(start("/p", deps)).rejects.toThrow(msg);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects with the ip message when the LAN IP changed", async () => {
    const { deps, exec } = makeDeps({ detectLanIp: async () => "10.0.0.7" });
    await expect(start("/p", deps)).rejects.toThrow(ipMismatchMessage("192.168.1.5", "10.0.0.7"));
    expect(exec).not.toHaveBeenCalled();
  });

  it("prefers config.lanIp over detection", async () => {
    const detect = vi.fn(async () => "10.0.0.7");
    const { deps, exec } = makeDeps({
      loadConfig: async () => ({ lanIp: "192.168.1.5" }) as never,
      detectLanIp: detect,
    });
    await start("/p", deps);
    expect(detect).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("runs expo start with the baked port when ok", async () => {
    const { deps, exec } = makeDeps();
    await start("/p", deps);
    expect(exec).toHaveBeenCalledWith("npx", ["expo", "start", "--lan", "--port", "8081"], { cwd: "/p" });
  });
});

describe("run", () => {
  it("runs build, install, start in order", async () => {
    const calls: string[] = [];
    await runCommand(
      "/p",
      { clean: true },
      {
        build: async (_r, o) => void calls.push(`build:${o.clean}`),
        install: async () => void calls.push("install"),
        start: async () => void calls.push("start"),
      },
    );
    expect(calls).toEqual(["build:true", "install", "start"]);
  });

  it("aborts when build rejects", async () => {
    const install = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    await expect(
      runCommand("/p", {}, { build: async () => { throw new Error("boom"); }, install, start }),
    ).rejects.toThrow("boom");
    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
