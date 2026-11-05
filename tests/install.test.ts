import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { firstRunChecklist, install } from "../src/commands/install.js";
import { projectPaths } from "../src/paths.js";
import { EMPTY_TARGETS_DIR, emptyArm64Object } from "../src/pods/emptyTargets.js";
import { IOS_MIN } from "../src/versions.js";

const APP_ID_LIMIT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xtool-errors", "app-id-limit.txt"),
  "utf8",
);
const DEVICE_NOT_REGISTERED = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xtool-errors", "device-not-registered.txt"),
  "utf8",
);
const APP_ID_LIMIT_MESSAGE = /^Apple refused to register another App ID: a free Apple ID can register 10 App IDs per 7 days, .*#app-id-limit$/;

const RELOADS_LINE =
  '  - On the first launch iOS asks for Local Network access, and the red screen "No script URL provided" may show behind it: tap Allow, and the app reloads by itself.';
const RELOAD_BY_HAND_LINE =
  '  - On the first launch iOS asks for Local Network access and "No script URL provided" shows behind it: tap Allow, then Reload.';
const DEV_CLIENT_LINE =
  "  - On the first launch the dev launcher asks for Local Network access: tap Allow, then open the link or QR code above, or enter the Metro URL above in the launcher.";

describe("firstRunChecklist", () => {
  it("mentions the 7-day expiry and the Apple ID", () => {
    const text = firstRunChecklist("me@example.com");
    expect(text).toContain("7 days");
    expect(text).toContain("Apple Development: me@example.com");
    expect(text).toContain("Developer Mode");
    expect(text).toContain("Local Network");
  });
  it("says the app reloads by itself after the first Local Network prompt", () => {
    const lines = firstRunChecklist(undefined, { autoReload: true }).split("\n");
    expect(lines).toContain(RELOADS_LINE);
    expect(lines).not.toContain(RELOAD_BY_HAND_LINE);
  });
  it("says to tap Reload when the app has no auto-reload helper", () => {
    for (const lines of [firstRunChecklist(undefined), firstRunChecklist(undefined, { devClient: false })]) {
      expect(lines.split("\n")).toContain(RELOAD_BY_HAND_LINE);
      expect(lines.split("\n")).not.toContain(RELOADS_LINE);
    }
  });
  it("tells a dev-client user to open the link after the prompt", () => {
    const lines = firstRunChecklist(undefined, { devClient: true }).split("\n");
    expect(lines).toContain(DEV_CLIENT_LINE);
    expect(lines).not.toContain(RELOADS_LINE);
  });
});

describe("install's first-launch checklist line", () => {
  const usb = (state: object) => {
    const logs: string[] = [];
    const run = install("/p", {
      xtool: {
        loadConfig: async () => ({}),
        bin: () => "/bin/xtool",
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", ...state }),
        devRun: async () => {},
        writeState: async () => {},
      },
      log: (s) => logs.push(s),
    });
    return run.then(() => logs.join("\n").split("\n"));
  };
  it("names the auto-reload when the build generated the helper", async () => {
    for (const state of [{ hasDevClient: false, devSupport: true }, { kind: "bare" as const, devSupport: true }]) {
      const lines = await usb(state);
      expect(lines).toContain(RELOADS_LINE);
      expect(lines).not.toContain(DEV_CLIENT_LINE);
    }
  });
  it("says to tap Reload for a build without the helper on record", async () => {
    for (const state of [{ hasDevClient: false }, { kind: "bare" as const }]) {
      const lines = await usb(state);
      expect(lines).toContain(RELOAD_BY_HAND_LINE);
      expect(lines).not.toContain(RELOADS_LINE);
    }
  });
  it("names the link with the dev client", async () => {
    const lines = await usb({ hasDevClient: true });
    expect(lines).toContain(DEV_CLIENT_LINE);
    expect(lines).not.toContain(RELOADS_LINE);
  });
});

describe("install", () => {
  const base = { loadConfig: async () => ({}), bin: () => "/bin/xtool" };
  it("fails when not logged in without touching devices", async () => {
    const listDevices = vi.fn();
    await expect(
      install("/p", { xtool: { ...base, authStatus: async () => ({ loggedIn: false }), listDevices } }),
    ).rejects.toThrow("Not logged in to Apple Developer Services. Run: rn-xtool auth login");
    expect(listDevices).not.toHaveBeenCalled();
  });
  it("fails when login succeeded but the team id is missing", async () => {
    const devRun = vi.fn();
    await expect(
      install("/p", {
        xtool: { ...base, authStatus: async () => ({ loggedIn: true, teamId: undefined }), devRun },
      }),
    ).rejects.toThrow("Could not determine the Apple Team ID");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("ignores non-USB devices", async () => {
    const devRun = vi.fn();
    await expect(
      install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "T" }),
          listDevices: async () => [{ name: "Wifi", udid: "u", transport: "network" }],
          devRun,
        },
      }),
    ).rejects.toThrow("No iPhone found over USB");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("fails when no device is connected", async () => {
    const devRun = vi.fn();
    await expect(
      install("/p", {
        xtool: { ...base, authStatus: async () => ({ loggedIn: true, teamId: "T" }), listDevices: async () => [], devRun },
      }),
    ).rejects.toThrow("No iPhone found over USB");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("fails with a build hint when there is no build state", async () => {
    const devRun = vi.fn();
    await expect(
      install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "T" }),
          listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
          readState: async () => undefined,
          devRun,
        },
      }),
    ).rejects.toThrow("No build found. Run `rn-xtool build` first.");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("treats an unreadable build state like a missing one", async () => {
    const devRun = vi.fn();
    await expect(
      install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "T" }),
          listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
          readState: async () => { throw new Error("bad json"); },
          devRun,
        },
      }),
    ).rejects.toThrow("No build found. Run `rn-xtool build` first.");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("install does not print the dev launcher URL without the dev client", async () => {
    for (const st of [{ hasDevClient: false }, { kind: "expo" as const }, { kind: "bare" as const }]) {
      const logs: string[] = [];
      await install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
          listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
          readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", ...st }),
          devRun: async () => {},
          writeState: async () => {},
        },
        log: (s) => logs.push(s),
      });
      expect(logs.join("\n")).toContain("Installed XTL-TEAM.com.a.b on Phone");
      expect(logs.join("\n")).not.toContain("dev launcher");
      expect(logs.join("\n")).toContain("First-run checklist");
    }
  });
  it("install prints the dev launcher URL for a state written before bare support (no kind, no hasDevClient)", async () => {
    const logs: string[] = [];
    await install("/p", {
      xtool: {
        ...base,
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20" }),
        devRun: async () => {},
        writeState: async () => {},
      },
      log: (s) => logs.push(s),
    });
    expect(logs).toContain("Metro URL for the dev launcher: http://192.168.1.20:8082");
  });
  it("runs, then logs bundle id and checklist", async () => {
    const logs: string[] = [];
    const devRun = vi.fn(async () => {});
    await install("/p", {
      xtool: {
        ...base,
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", hasDevClient: true }),
        devRun,
        writeState: async () => {},
      },
      log: (s) => logs.push(s),
    });
    expect(devRun).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("Installed XTL-TEAM.com.a.b on Phone");
    // Right after the installed-bundle line: what a dev-client user types in the launcher.
    expect(logs[1]).toBe("Metro URL for the dev launcher: http://192.168.1.20:8082");
    expect(logs.join("\n")).toContain("7 days");
  });
  it("prints the dev-client link after the Metro URL", async () => {
    const run = async (st: object, devClientLink = vi.fn(async () => [
      "Metro URL for the dev launcher: http://192.168.1.20:8082",
      "Open this link…",
    ])) => {
      const logs: string[] = [];
      await install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
          listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
          readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", ...st }),
          devRun: async () => {},
          writeState: async () => {},
        },
        devClientLink,
        log: (s) => logs.push(s),
      });
      return { logs, devClientLink };
    };
    const dev = await run({ hasDevClient: true });
    expect(dev.logs[0]).toBe("Installed XTL-TEAM.com.a.b on Phone");
    expect(dev.logs.slice(1, 3)).toEqual(["Metro URL for the dev launcher: http://192.168.1.20:8082", "Open this link…"]);
    expect(dev.devClientLink).toHaveBeenCalledWith("/p", expect.objectContaining({ lanIp: "192.168.1.20", metroPort: 8082 }));
    const old = await run({});
    expect(old.logs[1]).toBe("Metro URL for the dev launcher: http://192.168.1.20:8082");
    expect(old.logs[2]).toMatch(/^First-run checklist/);
    expect(old.devClientLink).not.toHaveBeenCalled();
  });

  it("prints the dev-client link over Wi‑Fi too", async () => {
    const logs: string[] = [];
    const devClientLink = vi.fn(async () => ["Metro URL for the dev launcher: http://192.168.1.20:8082", "Open this link…"]);
    const app = { CFBundleIdentifier: "XTL-TEAM.com.a.b" };
    await install(
      "/p",
      {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
          readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", hasDevClient: true }),
          devBuildIpa: async () => "/p/ios-xtool/xtool/App.ipa",
        },
        wifi: {
          lanRoute: async () => ({ ip: "192.168.1.20", dev: "wlp2s0" }),
          locate: async () => ({ ip: "192.168.1.10", udid: "u", scanned: false }),
          loadPairRecord: async () => ({ record: {} as never, source: "cache" as never }),
          installOverWifi: async () => ({ app, bytes: 1, uploadMs: 1, installMs: 1 }),
          rememberDevice: async () => {},
        },
        devClientLink,
        log: (s) => logs.push(s),
      },
      { network: true },
    );
    const at = logs.findIndex((l) => l.startsWith("Installed XTL-TEAM.com.a.b"));
    expect(logs.slice(at + 1, at + 3)).toEqual(["Metro URL for the dev launcher: http://192.168.1.20:8082", "Open this link…"]);
  });

  it("records installedFingerprint after devRun succeeds", async () => {
    const writeState = vi.fn(async () => {});
    const st = { version: 1, bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "1.2.3.4", builtAt: "t", depsFingerprint: "fp" };
    await install("/p", {
      xtool: {
        ...base,
        authStatus: async () => ({ loggedIn: true, teamId: "T" }),
        listDevices: async () => [{ name: "P", udid: "u", transport: "usb" }],
        readState: async () => st,
        devRun: async () => {},
        writeState,
      },
      log: () => {},
    });
    expect(writeState).toHaveBeenCalledWith(expect.stringContaining("ios-xtool"), {
      ...st,
      installedUdid: "u",
      installedFingerprint: "fp",
      installedBundleId: "XTL-T.com.a.b",
    });
  });
  it("records the installed id", async () => {
    const writeState = vi.fn(async () => {});
    const st = { version: 1, bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", builtAt: "t" };
    await install("/p", {
      xtool: {
        ...base,
        authStatus: async () => ({ loggedIn: true, teamId: "TEAMID0000" }),
        listDevices: async () => [{ name: "P", udid: "u", transport: "usb" }],
        readState: async () => st,
        devRun: async () => {},
        writeState,
      },
      log: () => {},
    });
    expect(writeState).toHaveBeenCalledWith(
      expect.stringContaining("ios-xtool"),
      expect.objectContaining({ installedBundleId: "XTL-TEAMID0000.com.a.b" }),
    );
  });
  it("does not record it when devRun fails", async () => {
    const writeState = vi.fn(async () => {});
    await expect(
      install("/p", {
        xtool: {
          ...base,
          authStatus: async () => ({ loggedIn: true, teamId: "T" }),
          listDevices: async () => [{ name: "P", udid: "u", transport: "usb" }],
          readState: async () => ({ bundleIdentifier: "a", metroPort: 1, lanIp: "x", depsFingerprint: "fp" }),
          devRun: async () => { throw new Error("nope"); },
          writeState,
        },
        log: () => {},
      }),
    ).rejects.toThrow("nope");
    expect(writeState).not.toHaveBeenCalled();
  });
  const usbDeps = (devRun: () => Promise<void>, writeState = vi.fn(async () => {})) => ({
    xtool: {
      ...base,
      authStatus: async () => ({ loggedIn: true, teamId: "T" }),
      listDevices: async () => [{ name: "P", udid: "u", transport: "usb" }],
      readState: async () => ({ bundleIdentifier: "a", metroPort: 1, lanIp: "x" }),
      devRun,
      writeState,
    },
    log: () => {},
  });
  it("explains the App ID limit from xtool dev run", async () => {
    // `xtool dev run` prints install errors on stdout.
    const writeState = vi.fn(async () => {});
    const devRun = async () => {
      throw Object.assign(new Error("Command failed with exit code 1"), {
        stdout: `Installing...\n${APP_ID_LIMIT}`,
        stderr: "",
        exitCode: 1,
      });
    };
    await expect(install("/p", usbDeps(devRun, writeState))).rejects.toThrow(APP_ID_LIMIT_MESSAGE);
    expect(writeState).not.toHaveBeenCalled();
  });
  it("rethrows an unknown xtool failure as is", async () => {
    const unknown = Object.assign(new Error("Command failed with exit code 1"), { stderr: "Error: something new\n" });
    const devRun = async () => {
      throw unknown;
    };
    await expect(install("/p", usbDeps(devRun))).rejects.toBe(unknown);
  });
  it("does not call an install's connect timeout a sign-in failure", async () => {
    const timeout = Object.assign(new Error("Command failed with exit code 1"), {
      stdout: "\nError: HTTPClientError.connectTimeout\n",
      exitCode: 1,
    });
    const devRun = async () => {
      throw timeout;
    };
    await expect(install("/p", usbDeps(devRun))).rejects.toBe(timeout);
  });
});

describe("install over USB with empty targets", () => {
  it("writes the empty target objects the build recorded before xtool dev run (row 90)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-empty-usb-"));
    const object = path.join(projectPaths(root).iosXtool, ...EMPTY_TARGETS_DIR, "GTMDefines.o");
    const seen: boolean[] = [];
    await install(root, {
      xtool: {
        loadConfig: async () => ({}),
        bin: () => "/bin/xtool",
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", emptyTargets: ["GTMDefines"] }),
        devRun: async () => void seen.push(existsSync(object)),
        writeState: async () => {},
      },
      log: () => {},
    });
    expect(seen).toEqual([true]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("install --network", () => {
  const UD = "00008030-0000000012345678";
  const record = { HostID: "H", SystemBUID: "B", HostCertificate: Buffer.from("c"), HostPrivateKey: Buffer.from("k") };
  const app = { CFBundleIdentifier: "XTL-TEAM.com.a.b", CFBundleShortVersionString: "1.0.0", CFBundleVersion: "1" };
  const result = { app, bytes: 10, uploadMs: 1500, installMs: 2500 };
  const deps = (over: { wifi?: NonNullable<Parameters<typeof install>[1]>["wifi"]; state?: object } = {}) => {
    const logs: string[] = [];
    const calls = {
      devRun: vi.fn(),
      listDevices: vi.fn(async () => []),
      devBuildIpa: vi.fn(async () => "/p/ios-xtool/xtool/App.ipa"),
      locate: vi.fn(async () => ({ ip: "192.168.1.10", udid: UD, scanned: false })),
      installOverWifi: vi.fn(async () => result),
      rememberDevice: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
    };
    const d = {
      xtool: {
        loadConfig: async () => ({}),
        bin: () => "/bin/xtool",
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: calls.listDevices,
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20", ...over.state }),
        devRun: calls.devRun,
        devBuildIpa: calls.devBuildIpa,
      },
      wifi: {
        lanRoute: async () => ({ ip: "192.168.1.20", dev: "wlp2s0" }),
        locate: calls.locate,
        loadPairRecord: async () => ({ record, source: "cache" }),
        installOverWifi: calls.installOverWifi,
        rememberDevice: calls.rememberDevice,
        sleep: calls.sleep,
        ...over.wifi,
      },
      log: (s: string) => logs.push(s),
    };
    return { d, logs, calls };
  };

  it("writes the empty target objects the build recorded before xtool builds the ipa (row 90)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-empty-net-"));
    const object = path.join(projectPaths(root).iosXtool, ...EMPTY_TARGETS_DIR, "GTMDefines.o");
    const { d, calls } = deps({ state: { emptyTargets: ["GTMDefines"] } });
    calls.devBuildIpa.mockImplementation(async () => {
      expect(readFileSync(object)).toEqual(emptyArm64Object(IOS_MIN));
      return "/p/ios-xtool/xtool/App.ipa";
    });
    await install(root, d, { network: true });
    expect(calls.devBuildIpa).toHaveBeenCalledTimes(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("builds a signed ipa, installs it over Wi‑Fi without USB and remembers the iPhone", async () => {
    const { d, logs, calls } = deps({ state: { deviceIp: "192.168.1.9", deviceUdid: UD, hasDevClient: true } });
    await install("/p", d, { network: true });
    expect(calls.listDevices).not.toHaveBeenCalled();
    expect(calls.devRun).not.toHaveBeenCalled();
    expect(calls.devBuildIpa).toHaveBeenCalledWith("/bin/xtool", expect.stringMatching(/ios-xtool$/));
    expect(calls.locate.mock.calls[0]![0]).toMatchObject({ lastIp: "192.168.1.9", preferredUdid: UD, lanIp: "192.168.1.20" });
    expect(calls.locate.mock.calls[0]![0].udid).toBeUndefined();
    expect(calls.installOverWifi.mock.calls[0]![0]).toMatchObject({
      ip: "192.168.1.10",
      udid: UD,
      ipaPath: "/p/ios-xtool/xtool/App.ipa",
      bundleId: "XTL-TEAM.com.a.b",
      pairRecord: record,
    });
    expect(calls.rememberDevice).toHaveBeenCalledWith(expect.stringMatching(/ios-xtool$/), {
      deviceIp: "192.168.1.10",
      deviceUdid: UD,
      installedUdid: UD,
      installedBundleId: "XTL-TEAM.com.a.b",
    });
    const text = logs.join("\n");
    expect(text).toContain("Installed XTL-TEAM.com.a.b 1.0.0 1 on iPhone 00008030-0000000012345678 over Wi‑Fi (192.168.1.10)");
    expect(text).toContain("Metro URL for the dev launcher: http://192.168.1.20:8082");
    expect(text).toContain("First-run checklist");
  });

  it("does not print the dev launcher URL over Wi‑Fi without the dev client", async () => {
    const { d, logs } = deps({ state: { hasDevClient: false } });
    await install("/p", d, { network: true });
    expect(logs.join("\n")).toContain("over Wi‑Fi");
    expect(logs.join("\n")).not.toContain("dev launcher");
  });

  it("prints the first-launch checklist line for the build's kind over Wi‑Fi", async () => {
    const cases = [
      [{ hasDevClient: false, devSupport: true }, RELOADS_LINE],
      [{ hasDevClient: false }, RELOAD_BY_HAND_LINE],
      [{ hasDevClient: true }, DEV_CLIENT_LINE],
    ] as const;
    for (const [state, line] of cases) {
      const { d, logs } = deps({ state });
      await install("/p", d, { network: true });
      expect(logs.join("\n").split("\n")).toContain(line);
    }
  });

  it("records the installed build's fingerprint together with the iPhone's address", async () => {
    const { d, calls } = deps({ state: { depsFingerprint: "F1" } });
    await install("/p", d, { network: true });
    expect(calls.rememberDevice).toHaveBeenCalledWith(expect.stringMatching(/ios-xtool$/), {
      deviceIp: "192.168.1.10",
      deviceUdid: UD,
      installedUdid: UD,
      installedFingerprint: "F1",
      installedBundleId: "XTL-TEAM.com.a.b",
    });
  });

  it("records the installed id", async () => {
    // The id the install reports for the uploaded app: the real signed id, whatever the login kind.
    const { d, calls } = deps({
      wifi: { installOverWifi: vi.fn(async () => ({ ...result, app: { ...app, CFBundleIdentifier: "XTL-ISSUER00.com.a.b" } })) },
    });
    await install("/p", d, { network: true });
    expect(calls.rememberDevice).toHaveBeenCalledWith(
      expect.stringMatching(/ios-xtool$/),
      expect.objectContaining({ installedBundleId: "XTL-ISSUER00.com.a.b" }),
    );
  });

  it("scans the private LAN of the default route", async () => {
    const { d, calls } = deps();
    await install("/p", d, { network: true });
    expect(calls.locate.mock.calls[0]![0]).toMatchObject({ lanIp: "192.168.1.20" });
    expect(calls.locate.mock.calls[0]![0].scan).toBeUndefined();
  });

  it("prefers the configured lanIp for the scan", async () => {
    const { d, calls } = deps();
    d.xtool.loadConfig = async () => ({ lanIp: "10.0.0.4" });
    await install("/p", d, { network: true });
    expect(calls.locate.mock.calls[0]![0]).toMatchObject({ lanIp: "10.0.0.4" });
  });

  for (const [why, route] of [
    ["a VPN/tunnel route", { ip: "10.8.0.2", dev: "tun0" }],
    ["a non-private address", { ip: "203.0.113.5", dev: "eth0" }],
    ["an unknown route", {}],
  ] as const) {
    it(`refuses to scan from ${why} and asks for the IP (not retried)`, async () => {
      const { locateDevice } = await import("../src/device/discover.js");
      // The real locator, with no remembered IP, goes straight to the (refused) scan.
      const locate = vi.fn((o: Parameters<typeof locateDevice>[0]) =>
        locateDevice({ ...o, identify: async () => { throw new Error("unused"); }, paired: async () => true }),
      );
      const { d, calls } = deps({ wifi: { locate, lanRoute: async () => route } });
      await expect(install("/p", d, { network: true })).rejects.toThrow("Not scanning the network for the iPhone");
      await expect(install("/p", d, { network: true })).rejects.toThrow("--network <ip>");
      expect(calls.sleep).not.toHaveBeenCalled();
    });
  }

  it("does not need a scan for an explicit IP from a VPN route", async () => {
    const { d, calls } = deps({ wifi: { lanRoute: async () => ({ ip: "10.8.0.2", dev: "tun0" }) } });
    await install("/p", d, { network: "192.168.1.10" });
    expect(calls.installOverWifi).toHaveBeenCalledOnce();
  });

  it("passes an explicit IP and does not force the remembered UDID on it", async () => {
    const { d, calls } = deps({ state: { deviceUdid: UD } });
    await install("/p", d, { network: "10.0.0.5" });
    expect(calls.locate.mock.calls[0]![0]).toMatchObject({ explicitIp: "10.0.0.5", udid: undefined, preferredUdid: undefined });
  });

  it("retries 3 × 10 s while the iPhone does not respond, with the wake-up message", async () => {
    const { DeviceUnreachableError } = await import("../src/device/errors.js");
    const locate = vi.fn(async () => {
      throw new DeviceUnreachableError("192.168.1.10", 62078, "timeout");
    });
    const { d, logs, calls } = deps({ wifi: { locate } });
    await expect(install("/p", d, { network: true })).rejects.toThrow("did not respond over Wi‑Fi after 4 tries");
    expect(locate).toHaveBeenCalledTimes(4);
    expect(calls.sleep.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
    expect(logs.filter((l) => l === "iPhone did not respond over Wi‑Fi — unlock it and keep it awake, retrying…")).toHaveLength(3);
    expect(calls.installOverWifi).not.toHaveBeenCalled();
  });

  it("does not retry when other paired iPhones answer instead", async () => {
    const { OtherIPhonesError } = await import("../src/device/discover.js");
    const locate = vi.fn(async () => {
      throw new OtherIPhonesError([{ ip: "10.0.0.7", udid: "A" }, { ip: "10.0.0.8", udid: "B" }]);
    });
    const { d, calls } = deps({ wifi: { locate } });
    await expect(install("/p", d, { network: true })).rejects.toThrow("paired iPhone A at 10.0.0.7");
    expect(locate).toHaveBeenCalledOnce();
    expect(calls.sleep).not.toHaveBeenCalled();
  });

  it("retries an interrupted upload exactly once", async () => {
    const { UploadInterruptedError } = await import("../src/device/wifiInstall.js");
    const installOverWifi = vi.fn(async () => {
      throw new UploadInterruptedError(new Error("EOF"));
    });
    const { d, logs } = deps({ wifi: { installOverWifi } });
    await expect(install("/p", d, { network: true })).rejects.toThrow("upload to the iPhone was interrupted");
    expect(installOverWifi).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.endsWith("retrying once…"))).toBe(true);
  });

  it("does not retry once installd's Install has started", async () => {
    const { InstallInterruptedError } = await import("../src/device/wifiInstall.js");
    const { DeviceTimeoutError } = await import("../src/device/errors.js");
    const installOverWifi = vi.fn(async () => {
      throw new InstallInterruptedError(new DeviceTimeoutError("installation_proxy", 600_000));
    });
    const { d, calls } = deps({ wifi: { installOverWifi } });
    await expect(install("/p", d, { network: true })).rejects.toThrow("while it was installing the app");
    expect(installOverWifi).toHaveBeenCalledOnce();
    expect(calls.sleep).not.toHaveBeenCalled();
  });

  it("does not retry installd refusals", async () => {
    const { InstallProxyError } = await import("../src/device/installproxy.js");
    const installOverWifi = vi.fn(async () => {
      throw new InstallProxyError("ApplicationVerificationFailed");
    });
    const { d } = deps({ wifi: { installOverWifi } });
    await expect(install("/p", d, { network: true })).rejects.toThrow("Re-run `rn-xtool install --network`");
    expect(installOverWifi).toHaveBeenCalledOnce();
  });

  it("needs a build first", async () => {
    const { d, calls } = deps();
    d.xtool.readState = async () => undefined as never;
    await expect(install("/p", d, { network: true })).rejects.toThrow("No build found");
    expect(calls.devBuildIpa).not.toHaveBeenCalled();
  });
  it("explains it over Wi‑Fi too", async () => {
    const { d, calls } = deps();
    calls.devBuildIpa.mockRejectedValueOnce(
      Object.assign(new Error("Command failed with exit code 1"), { stdout: APP_ID_LIMIT, stderr: "", exitCode: 1 }),
    );
    await expect(install("/p", d, { network: true })).rejects.toThrow(APP_ID_LIMIT_MESSAGE);
    expect(calls.installOverWifi).not.toHaveBeenCalled();
  });
  it("says to install over USB once when the team has no registered iPhone", async () => {
    const { d, calls } = deps();
    calls.devBuildIpa.mockRejectedValueOnce(
      Object.assign(new Error("Command failed with exit code 1"), {
        stdout: DEVICE_NOT_REGISTERED,
        stderr: "",
        exitCode: 1,
      }),
    );
    await expect(install("/p", d, { network: true })).rejects.toThrow(/^Apple has no iPhone registered .*#iphone-not-registered$/);
    expect(calls.installOverWifi).not.toHaveBeenCalled();
  });
  it("rethrows an unknown xtool failure over Wi‑Fi as is", async () => {
    const { d, calls } = deps();
    const unknown = Object.assign(new Error("Command failed with exit code 1"), { stdout: "Error: something new\n" });
    calls.devBuildIpa.mockRejectedValueOnce(unknown);
    await expect(install("/p", d, { network: true })).rejects.toBe(unknown);
  });
});

describe("progressLoggers", () => {
  it("logs upload every 10% and installd status changes", async () => {
    const { progressLoggers } = await import("../src/commands/install.js");
    const logs: string[] = [];
    const p = progressLoggers((s) => logs.push(s));
    for (let sent = 0; sent <= 100; sent += 5) p.onUpload!(sent * 1024 * 1024, 100 * 1024 * 1024);
    p.onInstall!(5, "CreatingStagingDirectory");
    p.onInstall!(6, "CreatingStagingDirectory");
    p.onInstall!(40, "VerifyingApplication");
    expect(logs.filter((l) => l.includes("upload"))).toHaveLength(11);
    expect(logs).toContain("  upload 50% of 100 MB");
    expect(logs.slice(-2)).toEqual(["  installing: CreatingStagingDirectory (5%)", "  installing: VerifyingApplication (40%)"]);
  });
});

describe("install --network against a fake iPhone", () => {
  it("retries once after the heartbeat is lost mid-upload, then installs", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FakeDevice, pairRecord, UDID } = await import("./device/fakeDevice.js");
    const { tcpConnector } = await import("../src/device/lockdown.js");
    const { installOverWifi } = await import("../src/device/wifiInstall.js");
    const dir = await mkdtemp(join(tmpdir(), "rn-xtool-net-"));
    const ipa = join(dir, "App.ipa");
    await writeFile(ipa, Buffer.alloc(10 * 1024 * 1024, 3));
    const dev = await FakeDevice.start({ requireHeartbeat: true, bundleId: "XTL-TEAM.com.a.b", heartbeatDropOnWrite: 1 });
    const logs: string[] = [];
    const attempts = vi.fn();
    try {
      await install(
        "/p",
        {
          xtool: {
            loadConfig: async () => ({}),
            bin: () => "/bin/xtool",
            authStatus: async () => ({ loggedIn: true, teamId: "TEAM" }),
            readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20" }),
            devBuildIpa: async () => ipa,
          },
          wifi: {
            lanRoute: async () => ({ ip: "192.168.1.20", dev: "wlp2s0" }),
            locate: async () => ({ ip: "127.0.0.1", udid: UDID, scanned: false }),
            loadPairRecord: async () => ({ record: pairRecord(), source: "test" }),
            installOverWifi: (o) => {
              attempts();
              return installOverWifi({ ...o, connect: tcpConnector("127.0.0.1", 1000), lockdownPort: dev.lockdownPort });
            },
            rememberDevice: async () => {},
            sleep: async () => {},
          },
          log: (s) => logs.push(s),
        },
        { network: true },
      );
    } finally {
      await dev.close();
      await rm(dir, { recursive: true, force: true });
    }
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("Lost the Wi‑Fi heartbeat") && l.endsWith("retrying once…"))).toBe(true);
    expect(dev.installs).toHaveLength(1);
    expect(logs.join("\n")).toContain("Installed XTL-TEAM.com.a.b");
  });
});
