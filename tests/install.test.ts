import { describe, expect, it, vi } from "vitest";
import { firstRunChecklist, install } from "../src/commands/install.js";

describe("firstRunChecklist", () => {
  it("mentions the 7-day expiry and the Apple ID", () => {
    const text = firstRunChecklist("me@example.com");
    expect(text).toContain("7 days");
    expect(text).toContain("Apple Development: me@example.com");
    expect(text).toContain("Developer Mode");
    expect(text).toContain("Local Network");
  });
});

describe("install", () => {
  const base = { loadConfig: async () => ({}), bin: () => "/bin/xtool" };
  it("fails when not logged in without touching devices", async () => {
    const listDevices = vi.fn();
    await expect(
      install("/p", { xtool: { ...base, authStatus: async () => ({ loggedIn: false }), listDevices } }),
    ).rejects.toThrow("Not logged in to Apple Developer Services. Run: /bin/xtool auth login");
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
    ).rejects.toThrow("No build found. Run `expo-xtool build` first.");
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
    ).rejects.toThrow("No build found. Run `expo-xtool build` first.");
    expect(devRun).not.toHaveBeenCalled();
  });
  it("runs, then logs bundle id and checklist", async () => {
    const logs: string[] = [];
    const devRun = vi.fn(async () => {});
    await install("/p", {
      xtool: {
        ...base,
        authStatus: async () => ({ loggedIn: true, teamId: "TEAM", appleId: "a@b.c" }),
        listDevices: async () => [{ name: "Phone", udid: "u", transport: "usb" }],
        readState: async () => ({ bundleIdentifier: "com.a.b", metroPort: 8082, lanIp: "192.168.1.20" }),
        devRun,
      },
      log: (s) => logs.push(s),
    });
    expect(devRun).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("Installed XTL-TEAM.com.a.b on Phone");
    // Right after the installed-bundle line: what a dev-client user types in the launcher.
    expect(logs[1]).toBe("Metro URL for the dev launcher: http://192.168.1.20:8082");
    expect(logs.join("\n")).toContain("7 days");
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
    expect(writeState).toHaveBeenCalledWith(expect.stringContaining("ios-xtool"), { ...st, installedFingerprint: "fp" });
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
});
