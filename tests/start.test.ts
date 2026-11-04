import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run as runCommand } from "../src/commands/run.js";
import { depsFingerprint } from "../src/deps.js";
import { announceDevServer } from "../src/devServerAnnounce.js";
import {
  ipMismatchMessage,
  metroCommand,
  portMismatchMessage,
  start,
  startDecision,
  type StartDeps,
} from "../src/commands/start.js";

const REMEDY = "rn-xtool build && rn-xtool install";
const state = {
  version: 1 as const,
  metroPort: 8081,
  lanIp: "192.168.1.5",
  bundleIdentifier: "com.example.app",
  builtAt: "2026-01-01T00:00:00.000Z",
  depsFingerprint: "fp",
  installedFingerprint: "fp",
};

const nic = (address: string, internal = false) => ({
  address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: null,
});
/** The build's LAN IP on enp4s0, next to a Docker veth. */
const INTERFACES = { lo: [nic("127.0.0.1", true)], enp4s0: [nic("192.168.1.5")], veth23: [nic("172.17.0.1")] };

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
    announce: vi.fn(async () => async () => {}),
    networkInterfaces: () => INTERFACES,
    onExit: () => () => {},
    onSignal: () => () => {},
    exit: vi.fn(),
    env: {},
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
    await expect(start("/p", {}, deps)).rejects.toThrow("No build state found. Run `rn-xtool build` first.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("treats an unreadable build state like a missing one", async () => {
    const { deps, exec } = makeDeps({ readState: async () => { throw new Error("bad json"); } });
    await expect(start("/p", {}, deps)).rejects.toThrow("No build state found. Run `rn-xtool build` first.");
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

  it("start runs react-native start for a bare state", async () => {
    const { deps, exec } = makeDeps({ readState: async () => ({ ...state, kind: "bare" as const }) });
    await start("/p", {}, deps);
    expect(exec).toHaveBeenCalledWith("npx", ["react-native", "start", "--port", "8081"], { cwd: "/p" });
    expect(exec.mock.calls[0]?.[1]).not.toContain("expo");
  });

  it("resets the bare Metro cache when dependencies changed", async () => {
    const { deps, exec } = makeDeps({
      readState: async () => ({ ...state, kind: "bare" as const }),
      depsFingerprint: async () => "other",
    });
    await start("/p", {}, deps);
    expect(exec).toHaveBeenCalledWith("npx", ["react-native", "start", "--port", "8081", "--reset-cache"], { cwd: "/p" });
  });
});

describe("start and the dev launcher announcement", () => {
  const ID = "XTL-TEAMID0000.com.example.app";
  const NO_ID =
    "ℹ No installed bundle id recorded: run `rn-xtool install` once so `start` can announce Metro under the app's real id (Expo SDK 58's dev launcher hides other servers).";
  const devState = (over: object = {}) => ({ ...state, hasDevClient: true, installedBundleId: ID, name: "My App", slug: "my-app", ...over });
  const announcing = (over: Partial<StartDeps> & { st?: object } = {}) => {
    const order: string[] = [];
    const stop = vi.fn(async () => void order.push("stop"));
    const announce = vi.fn(async (_i: Parameters<StartDeps["announce"]>[0]) => {
      order.push("announce");
      return stop;
    });
    const made = makeDeps({
      readState: async () => devState(over.st),
      announce,
      run: vi.fn(async () => void order.push("run")),
      ...over,
    });
    return { ...made, announce, stop, order };
  };
  const envOf = (exec: { mock: { calls: unknown[][] } }) => (exec.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env;

  it("announces the installed id", async () => {
    const { deps, announce, stop, order, log } = announcing();
    await start("/p", {}, deps);
    expect(announce).toHaveBeenCalledOnce();
    expect(announce.mock.calls[0]![0]).toMatchObject({
      root: "/p",
      name: "My App",
      slug: "my-app",
      port: 8081,
      iosBundleIdentifier: ID,
    });
    expect(order).toEqual(["announce", "run", "stop"]);
    expect(log).toHaveBeenCalledWith(`ℹ Announcing Metro to the dev launcher as ${ID}.`);
    const run = deps.run as unknown as { mock: { calls: unknown[][] } };
    expect(run.mock.calls[0]?.[2]).toMatchObject({ cwd: "/p" });
    expect(envOf(run)?.EXPO_UNSTABLE_BONJOUR).toBe("0");
    expect(stop).toHaveBeenCalledOnce();

    const failing = announcing({ run: vi.fn(async () => { throw new Error("metro died"); }) });
    await expect(start("/p", {}, failing.deps)).rejects.toThrow("metro died");
    expect(failing.stop).toHaveBeenCalledOnce();
  });

  it("keeps Metro's result when stop returns no promise or throws", async () => {
    const stops = [
      () => undefined,
      () => {
        throw new Error("socket closed");
      },
    ];
    for (const stop of stops) {
      const announce = vi.fn(async () => stop as unknown as () => Promise<void>);
      await expect(start("/p", {}, announcing({ announce }).deps)).resolves.toBeUndefined();
      const failing = announcing({ announce, run: vi.fn(async () => { throw new Error("metro died"); }) });
      await expect(start("/p", {}, failing.deps)).rejects.toThrow("metro died");
    }
  });

  describe("stopping the announcement", () => {
    afterEach(() => void vi.useRealTimers());
    const never = () => new Promise<void>(() => {});
    /** Whether `p` settled after the fake clock moved `ms` ahead. */
    const settledAfter = async (p: Promise<unknown>, ms: number) => {
      let settled = false;
      p.then(() => (settled = true), () => (settled = true));
      await vi.advanceTimersByTimeAsync(ms);
      return settled;
    };

    it("waits at most a second for a stop that never settles", async () => {
      vi.useFakeTimers();
      const stop = vi.fn(never);
      const announce = vi.fn(async () => stop);
      const ended = start("/p", {}, announcing({ announce }).deps);
      expect(await settledAfter(ended, 999)).toBe(false);
      expect(await settledAfter(ended, 1)).toBe(true);
      await expect(ended).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledOnce();

      const failing = start("/p", {}, announcing({ announce, run: vi.fn(async () => { throw new Error("metro died"); }) }).deps);
      failing.catch(() => {});
      expect(await settledAfter(failing, 1000)).toBe(true);
      await expect(failing).rejects.toThrow("metro died");
    });

    it("does not wait for a stop that settles", async () => {
      vi.useFakeTimers();
      const { deps, stop } = announcing();
      expect(await settledAfter(start("/p", {}, deps), 0)).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
    });

    /** A start whose Metro never ends on its own (the signal went to rn-xtool only). */
    const signalled = (stop: () => Promise<void>) => {
      let onSignal: ((s: "SIGINT" | "SIGTERM") => void) | undefined;
      const removeSignal = vi.fn();
      const exit = vi.fn();
      const made = announcing({
        announce: vi.fn(async () => stop),
        run: vi.fn(never),
        onSignal: (fn) => {
          onSignal = fn;
          return removeSignal;
        },
        exit,
      });
      void start("/p", {}, made.deps);
      return { exit, removeSignal, signal: (s: "SIGINT" | "SIGTERM") => onSignal!(s) };
    };

    it("sends the goodbye on Ctrl+C or a kill, then exits with the signal's status", async () => {
      vi.useFakeTimers();
      let goodbye: () => void = () => {};
      const stop = vi.fn(() => new Promise<void>((r) => (goodbye = r)));
      const s = signalled(stop);
      await vi.advanceTimersByTimeAsync(0);
      s.signal("SIGINT");
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledOnce();
      expect(s.exit).not.toHaveBeenCalled();
      goodbye();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.exit).toHaveBeenCalledWith(130);

      const t = signalled(vi.fn(never));
      await vi.advanceTimersByTimeAsync(0);
      t.signal("SIGTERM");
      await vi.advanceTimersByTimeAsync(999);
      expect(t.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.exit).toHaveBeenCalledWith(143);
    });

    it("listens for signals and process exit only while Metro runs", async () => {
      const order: string[] = [];
      let exitHook: (() => void) | undefined;
      const stop = vi.fn(async () => void order.push("stop"));
      const { deps } = announcing({
        announce: vi.fn(async () => stop),
        run: vi.fn(async () => {
          order.push("run");
          exitHook!();
        }),
        onExit: (fn) => {
          order.push("onExit");
          exitHook = fn;
          return () => void order.push("removeExit");
        },
        onSignal: () => {
          order.push("onSignal");
          return () => void order.push("removeSignal");
        },
      });
      await start("/p", {}, deps);
      expect(order).toEqual(["onExit", "onSignal", "run", "stop", "removeSignal", "removeExit"]);
      expect(stop).toHaveBeenCalledOnce();

      const plain = announcing({ st: { hasDevClient: false }, onExit: vi.fn(), onSignal: vi.fn() });
      await start("/p", {}, plain.deps);
      expect(plain.deps.onExit).not.toHaveBeenCalled();
      expect(plain.deps.onSignal).not.toHaveBeenCalled();
    });
  });

  it("names the app after its slug, then app, when the state has no name", async () => {
    const { deps, announce } = announcing({ st: { name: undefined } });
    await start("/p", {}, deps);
    expect(announce.mock.calls[0]![0]).toMatchObject({ name: "my-app", slug: "my-app" });
    const none = announcing({ st: { name: undefined, slug: undefined } });
    await start("/p", {}, none.deps);
    expect(none.announce.mock.calls[0]![0]).toMatchObject({ name: "app", slug: "app" });
  });

  it("keeps Expo's announcement when ours cannot start", async () => {
    const failures = [
      vi.fn(() => {
        throw new Error("dnssd-advertise is not installed");
      }),
      vi.fn(async () => {
        throw new Error("dnssd-advertise is not installed");
      }),
    ];
    for (const announce of failures) {
      const { deps, log } = announcing({ announce });
      await start("/p", {}, deps);
      expect(log).toHaveBeenCalledWith(
        'ℹ Could not announce Metro for the dev launcher (dnssd-advertise is not installed); Expo announces it under the app config\'s bundle id, which Expo SDK 58\'s dev launcher hides unless "Match bundle identifier" is off in its Settings.',
      );
      const run = deps.run as unknown as { mock: { calls: unknown[][] } };
      expect(run.mock.calls[0]?.[2]).toEqual({ cwd: "/p" });
    }
  });

  it("keeps Expo's announcement when the project's dnssd-advertise has another API", async () => {
    const root = mkdtempSync(join(tmpdir(), "start-dnssd-"));
    const lib = join(root, "node_modules", "dnssd-advertise");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "dnssd-advertise", version: "2.0.0", main: "index.js" }));
    writeFileSync(join(lib, "index.js"), "exports.advertise = async () => async () => {};");
    const { deps, log } = announcing({ announce: announceDevServer });
    await start(root, {}, deps);
    expect(log).toHaveBeenCalledWith(
      `ℹ Could not announce Metro for the dev launcher (dnssd-advertise's advertise() did not return a stop function); Expo announces it under the app config's bundle id, which Expo SDK 58's dev launcher hides unless "Match bundle identifier" is off in its Settings.`,
    );
    const run = deps.run as unknown as { mock: { calls: unknown[][] } };
    expect(run.mock.calls[0]?.[2]).toEqual({ cwd: root });
    rmSync(root, { recursive: true, force: true });
  });

  it("announces nothing when the user turned Bonjour off, and says which variable did", async () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ EXPO_UNSTABLE_BONJOUR: "0" }, "EXPO_UNSTABLE_BONJOUR=0"],
      [{ EXPO_UNSTABLE_BONJOUR: "false" }, "EXPO_UNSTABLE_BONJOUR=false"],
      [{ CI: "true" }, "CI=true"],
      [{ CI: "1" }, "CI=1"],
    ];
    for (const [env, named] of cases) {
      for (const st of [{}, { kind: "bare" }, { installedBundleId: undefined }]) {
        const { deps, announce, log } = announcing({ st, env });
        await start("/p", {}, deps);
        expect(announce, JSON.stringify(env)).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalledWith(NO_ID);
        expect(log.mock.calls.filter(([l]) => String(l).startsWith("ℹ"))).toEqual([
          [
            `ℹ Metro is not announced to the dev launcher: ${named} in the environment turns Bonjour off, as in Expo CLI. Open the app with the link \`rn-xtool install\` printed.`,
          ],
        ]);
        const run = deps.run as unknown as { mock: { calls: unknown[][] } };
        expect(run.mock.calls[0]?.[2]).toEqual({ cwd: "/p" });
      }
    }
  });

  it("says so when a bare app's Metro is not announced", async () => {
    const announce = vi.fn(async () => {
      throw new Error("dnssd-advertise is not installed in the project");
    });
    const { deps, log } = announcing({ st: { kind: "bare" }, announce });
    await start("/p", {}, deps);
    expect(log).toHaveBeenCalledWith(
      "ℹ Could not announce Metro for the dev launcher (dnssd-advertise is not installed in the project); `react-native start` does not announce it, so the launcher will not list it. Open the app with the link `rn-xtool install` printed.",
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain("Expo announces it");
  });

  /** An announce whose dnssd-advertise reports `now` while announcing and `later` once Metro runs. */
  const reporting = (now: Error[], later: Error[] = []) => {
    let onError: ((e: unknown) => void) | undefined;
    const stop = vi.fn(async () => {});
    const announce = vi.fn(async (i: Parameters<StartDeps["announce"]>[0]) => {
      onError = i.onError;
      for (const e of now) i.onError?.(e);
      return stop;
    });
    const run = vi.fn(async () => {
      for (const e of later) onError?.(e);
    });
    return { announce, run, stop };
  };
  const setup = (name: string) => new Error(`mDNS interface "${name}" failed initial setup after 2 attempts`);
  const warningsOf = (log: { mock: { calls: unknown[][] } }) =>
    log.mock.calls.map((c) => c[0] as string).filter((l) => l.startsWith("⚠"));
  const LATER =
    '⚠ The Metro announcement for the dev launcher failed (mDNS interface "enp4s0" failed initial setup after 2 attempts). Open the app with the link `rn-xtool install` printed, or turn off "Match bundle identifier" in the launcher\'s Settings.';

  it("ignores errors on other network interfaces (a Docker veth)", async () => {
    const r = reporting([setup("veth23")], [setup("veth23")]);
    const { deps, log } = announcing({ announce: r.announce, run: r.run });
    await start("/p", {}, deps);
    expect(warningsOf(log)).toEqual([]);
    expect(log).toHaveBeenCalledWith(`ℹ Announcing Metro to the dev launcher as ${ID}.`);
    expect(envOf(r.run)?.EXPO_UNSTABLE_BONJOUR).toBe("0");
  });

  it("keeps ours and warns once when the LAN interface fails while announcing", async () => {
    const r = reporting([setup("enp4s0"), setup("enp4s0")], [setup("enp4s0")]);
    const { deps, log } = announcing({ announce: r.announce, run: r.run });
    await start("/p", {}, deps);
    expect(warningsOf(log)).toEqual([LATER]);
    expect(log).toHaveBeenCalledWith(`ℹ Announcing Metro to the dev launcher as ${ID}.`);
    expect(envOf(r.run)?.EXPO_UNSTABLE_BONJOUR).toBe("0");
    expect(r.stop).toHaveBeenCalledOnce();
  });

  it("ignores errors that name no interface (a Docker bridge's send errors)", async () => {
    const send = () => Object.assign(new Error("send EHOSTUNREACH 224.0.0.251:5353"), { address: "224.0.0.251" });
    const r = reporting([send()], [send(), send(), send()]);
    const { deps, log } = announcing({ announce: r.announce, run: r.run });
    await start("/p", {}, deps);
    expect(warningsOf(log)).toEqual([]);
  });

  it("warns once when the announcement fails on the LAN interface later", async () => {
    const r = reporting([], [setup("veth23"), setup("enp4s0"), setup("enp4s0")]);
    const { deps, log } = announcing({ announce: r.announce, run: r.run });
    await start("/p", {}, deps);
    expect(warningsOf(log)).toEqual([LATER]);
  });

  it("without an installed id, keeps Expo's announcement", async () => {
    const { deps, announce, log } = announcing({ st: { installedBundleId: undefined } });
    await start("/p", {}, deps);
    expect(log).toHaveBeenCalledWith(NO_ID);
    expect(announce).not.toHaveBeenCalled();
    const run = deps.run as unknown as { mock: { calls: unknown[][] } };
    expect(run.mock.calls[0]?.[2]).toEqual({ cwd: "/p" });
  });

  it("no announcement without the dev client", async () => {
    for (const st of [{ hasDevClient: false }, { hasDevClient: undefined }]) {
      const { deps, announce, log } = announcing({ st, env: { CI: "1" } });
      await start("/p", {}, deps);
      expect(announce).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalledWith(NO_ID);
      expect(log.mock.calls.flat().join("\n")).not.toContain("is not announced");
      const run = deps.run as unknown as { mock: { calls: unknown[][] } };
      expect(run.mock.calls[0]?.[2]).toEqual({ cwd: "/p" });
    }
    const running = announcing({ isPortFree: async () => false, isMetroRunning: async () => true });
    await start("/p", {}, running.deps);
    expect(running.announce).not.toHaveBeenCalled();
  });

  it("a bare dev-client app gets the announcement without the env var", async () => {
    const { deps, announce, stop } = announcing({ st: { kind: "bare" } });
    await start("/p", {}, deps);
    expect(announce).toHaveBeenCalledOnce();
    const run = deps.run as unknown as { mock: { calls: unknown[][] } };
    expect(run.mock.calls[0]?.[2]).toEqual({ cwd: "/p" });
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("metroCommand", () => {
  it("runs expo start on the LAN for expo", () => {
    expect(metroCommand("expo", 8082, false)).toEqual(["npx", ["expo", "start", "--lan", "--port", "8082"]]);
    expect(metroCommand("expo", 8082, true)).toEqual(["npx", ["expo", "start", "--lan", "--port", "8082", "--clear"]]);
  });
  it("runs react-native start for bare, with --reset-cache to clear", () => {
    expect(metroCommand("bare", 8082, false)).toEqual(["npx", ["react-native", "start", "--port", "8082"]]);
    expect(metroCommand("bare", 8082, true)).toEqual(["npx", ["react-native", "start", "--port", "8082", "--reset-cache"]]);
  });
});

describe("start and dependency changes", () => {
  it("warns and passes --clear when the fingerprint differs", async () => {
    const { deps, exec, log } = makeDeps({ depsFingerprint: async () => "other" });
    await start("/p", {}, deps);
    expect(exec).toHaveBeenCalledWith("npx", ["expo", "start", "--lan", "--port", "8081", "--clear"], { cwd: "/p" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Dependencies changed since the last build"));
  });
  it("names native edits when a bare project's fingerprint differs", async () => {
    const { deps, log } = makeDeps({ depsFingerprint: async () => "other", readState: async () => ({ ...state, kind: "bare" as const }) });
    await start("/p", {}, deps);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Native project or dependencies changed since the last build"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Dependencies changed"));
  });
  it("warns and clears when the state has no fingerprint", async () => {
    const { depsFingerprint: _omit, ...old } = state;
    const { deps, exec, log } = makeDeps({ readState: async () => old });
    await start("/p", {}, deps);
    expect(exec.mock.calls[0]?.[1]).toContain("--clear");
    expect(log).toHaveBeenCalledWith("⚠ No dependency fingerprint recorded; run rn-xtool build to enable change detection.");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Dependencies changed"));
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
      loadConfig: async () => ({}) as never,
      isPortFree: async () => true,
      isMetroRunning: async () => false,
      detectLanIp: async () => "192.168.1.5",
      usbUdids: async () => [],
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

  it("reinstalls when a different iPhone is connected over USB", async () => {
    const { calls, overrides } = fresh({
      readState: async () => ({ ...state, installedUdid: "00008030-0000000000000001" }),
      usbUdids: async () => ["00008030-0000000000000002"],
    });
    await runCommand("/p", {}, overrides);
    expect(calls).toContain("install");
  });

  it("skips when the connected iPhone is the one installed on", async () => {
    const { calls, overrides } = fresh({
      readState: async () => ({ ...state, installedUdid: "00008030-0000000000000001" }),
      usbUdids: async () => ["000080300000000000000001"], // dashless, as usbmuxd may report it
    });
    await runCommand("/p", {}, overrides);
    expect(calls).toEqual(["start"]);
  });

  it("over Wi‑Fi, reinstalls when the remembered iPhone is not the one installed on", async () => {
    const { calls, overrides } = fresh({
      readState: async () => ({ ...state, installedUdid: "00008030-0000000000000001", deviceUdid: "00008030-0000000000000002" }),
    });
    await runCommand("/p", { network: true }, overrides);
    expect(calls).toContain("install");
    const same = fresh({
      readState: async () => ({ ...state, installedUdid: "00008030-0000000000000002", deviceUdid: "00008030-0000000000000002" }),
    });
    await runCommand("/p", { network: true }, same.overrides);
    expect(same.calls).toEqual(["start"]);
  });

  it("passes --network and its options through to install", async () => {
    const install = vi.fn(async () => {});
    const { overrides } = fresh({ readState: async () => undefined, install });
    await runCommand("/p", { network: "192.168.1.10", udid: "U", pairRecord: "/r.plist" }, overrides);
    expect(install).toHaveBeenCalledWith("/p", { network: "192.168.1.10", udid: "U", pairRecord: "/r.plist" });
    await runCommand("/p", {}, overrides);
    expect(install).toHaveBeenLastCalledWith("/p", { network: undefined, udid: undefined, pairRecord: undefined });
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

  it("rebuilds a bare project after an edit to its native code", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-bare-"));
    cpSync(fileURLToPath(new URL("./fixtures/bare", import.meta.url)), root, { recursive: true });
    const fp = await depsFingerprint(root);
    const built = { ...state, depsFingerprint: fp, installedFingerprint: fp };
    const before = fresh({ readState: async () => built, depsFingerprint });
    await runCommand(root, {}, before.overrides);
    expect(before.calls).toEqual(["start"]);
    mkdirSync(join(root, "ios", "HelloWorld"), { recursive: true });
    writeFileSync(join(root, "ios", "HelloWorld", "AppDelegate.swift"), "// edited\n");
    const after = fresh({ readState: async () => built, depsFingerprint });
    await runCommand(root, {}, after.overrides);
    expect(after.calls).toEqual(["build:undefined", "install", "start"]);
  });

  it("skips build and install when up to date", async () => {
    const { calls, log, overrides } = fresh();
    await runCommand("/p", {}, overrides);
    expect(calls).toEqual(["start"]);
    expect(log).toHaveBeenCalledWith("Native app is up to date (nothing changed since the last build); skipping build and install.");
  });

  it.each([
    ["fingerprints differ", { depsFingerprint: async () => "other" }, {}],
    ["App.app is missing", { exists: () => false }, {}],
    ["no state exists", { readState: async () => undefined }, {}],
    ["state has no fingerprint", { readState: async () => ({ ...state, depsFingerprint: undefined }) }, {}],
    ["the installed fingerprint differs", { readState: async () => ({ ...state, installedFingerprint: "old" }) }, {}],
    ["nothing was installed yet", { readState: async () => ({ ...state, installedFingerprint: undefined }) }, {}],
    ["the LAN IP changed", { detectLanIp: async () => "10.0.0.7" }, {}],
    ["the baked port is taken by something else", { isPortFree: async () => false }, {}],
    ["--force", {}, { force: true }],
    ["--clean", {}, { clean: true }],
  ])("builds and installs when %s", async (_n, over, opts) => {
    const { calls, overrides } = fresh(over);
    await runCommand("/p", opts, overrides);
    expect(calls.slice(1)).toEqual(["install", "start"]);
    expect(calls[0]).toMatch(/^build/);
  });

  it("skips when the baked port is held by Metro", async () => {
    const { calls, overrides } = fresh({ isPortFree: async () => false, isMetroRunning: async () => true });
    await runCommand("/p", {}, overrides);
    expect(calls).toEqual(["start"]);
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
