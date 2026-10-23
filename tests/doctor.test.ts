import { describe, expect, it } from "vitest";
import { doctorWithProbes, renderReport, type DoctorProbes } from "../src/commands/doctor.js";
import { XTOOL_VERSION } from "../src/versions.js";

const good: DoctorProbes = {
  nodeVersion: () => "20.11.0",
  swiftVersion: async () => "6.4",
  xtoolPath: () => "/cache/xtool.AppImage",
  xtoolInstalled: () => true,
  xtoolVersion: async () => `xtool ${XTOOL_VERSION}`,
  sdkInstalled: () => true,
  authStatus: async () => ({ loggedIn: true, appleId: "me@example.com", teamId: "TEAM123" }),
  devices: async () => [{ name: "iPhone", udid: "u1", transport: "USB" }],
  ufwActive: async () => false,
  expoProject: async () => undefined,
  buildState: async () => ({ metroPort: 8081, lanIp: "192.168.1.5" }),
  portFree: async () => true,
};

const statusOf = (r: { checks: { name: string; status: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name)?.status;

describe("renderReport", () => {
  it("marks ok, fail and warn with distinct symbols", () => {
    const out = renderReport([
      { name: "a", status: "ok", detail: "fine" },
      { name: "b", status: "fail", detail: "broken" },
      { name: "c", status: "warn", detail: "meh" },
    ]);
    expect(out.split("\n")).toEqual(["✔ a — fine", "✖ b — broken", "⚠ c — meh"]);
  });
});

describe("doctorWithProbes", () => {
  it("passes when every probe is healthy and skips project checks without a root", async () => {
    const r = await doctorWithProbes(good);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "node", "swift", "xtool", "darwin-sdk", "apple-login", "device", "firewall",
    ]);
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("fails on old node, missing swift, missing sdk and logged-out login", async () => {
    const r = await doctorWithProbes({
      ...good,
      nodeVersion: () => "18.19.0",
      swiftVersion: async () => undefined,
      sdkInstalled: () => false,
      authStatus: async () => ({ loggedIn: false }),
    });
    expect(r.ok).toBe(false);
    for (const n of ["node", "swift", "darwin-sdk", "apple-login"]) expect(statusOf(r, n)).toBe("fail");
    expect(r.checks.find((c) => c.name === "swift")?.detail).toContain("expo-xtool setup");
  });

  it("fails the xtool check when the binary cannot run", async () => {
    const r = await doctorWithProbes({
      ...good,
      xtoolVersion: async () => {
        throw new Error("xtool could not run (exit 1): fuse. libfuse2");
      },
      authStatus: async () => {
        throw new Error("xtool could not run (exit 1): fuse. libfuse2");
      },
    });
    expect(statusOf(r, "xtool")).toBe("fail");
    expect(statusOf(r, "apple-login")).toBe("fail");
    expect(r.checks.find((c) => c.name === "apple-login")?.detail).toContain("libfuse2");
    expect(r.ok).toBe(false);
  });

  it("prints the full binary path in the login hint", async () => {
    const r = await doctorWithProbes({ ...good, authStatus: async () => ({ loggedIn: false }) });
    expect(r.checks.find((c) => c.name === "apple-login")?.detail).toContain(
      "/cache/xtool.AppImage auth login",
    );
  });

  it("fails on swift older than required", async () => {
    const r = await doctorWithProbes({ ...good, swiftVersion: async () => "6.3" });
    expect(statusOf(r, "swift")).toBe("fail");
  });

  it("fails when xtool is missing and warns when its version differs", async () => {
    expect(statusOf(await doctorWithProbes({ ...good, xtoolInstalled: () => false }), "xtool")).toBe("fail");
    const r = await doctorWithProbes({ ...good, xtoolVersion: async () => "xtool 0.0.1" });
    expect(statusOf(r, "xtool")).toBe("warn");
    expect(r.ok).toBe(true);
  });

  it("includes Apple ID and Team ID in the login detail", async () => {
    const d = (await doctorWithProbes(good)).checks.find((c) => c.name === "apple-login")!.detail;
    expect(d).toContain("me@example.com");
    expect(d).toContain("TEAM123");
  });

  it("warns, without failing, on no device and active ufw", async () => {
    const r = await doctorWithProbes({ ...good, devices: async () => [], ufwActive: async () => true });
    expect(statusOf(r, "device")).toBe("warn");
    expect(statusOf(r, "firewall")).toBe("warn");
    expect(r.ok).toBe(true);
  });

  it("runs project checks when a root is given", async () => {
    const r = await doctorWithProbes(
      { ...good, expoProject: async () => undefined, portFree: async () => false },
      "/proj",
    );
    expect(statusOf(r, "expo-sdk")).toBe("ok");
    expect(statusOf(r, "build-state")).toBe("ok");
    expect(statusOf(r, "metro-port")).toBe("warn");
    expect(r.ok).toBe(true);
  });

  it("fails expo-sdk with the thrown message and warns on missing build state", async () => {
    const r = await doctorWithProbes(
      {
        ...good,
        expoProject: async () => {
          throw new Error("Expo SDK 57 is not supported");
        },
        buildState: async () => undefined,
      },
      "/proj",
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "expo-sdk")).toMatchObject({
      status: "fail",
      detail: "Expo SDK 57 is not supported",
    });
    expect(statusOf(r, "build-state")).toBe("warn");
    expect(r.checks.some((c) => c.name === "metro-port")).toBe(false);
  });

  it("turns a throwing probe into a failed check instead of crashing", async () => {
    const r = await doctorWithProbes({ ...good, authStatus: async () => { throw new Error("boom"); } });
    expect(statusOf(r, "apple-login")).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("never fails on a ufw query error", async () => {
    const r = await doctorWithProbes({
      ...good,
      ufwActive: async () => {
        throw new Error("spawn systemctl ENOENT");
      },
    });
    expect(statusOf(r, "firewall")).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("warns, not fails, when listing devices errors", async () => {
    const r = await doctorWithProbes({
      ...good,
      devices: async () => {
        throw new Error("usbmuxd down");
      },
    });
    expect(r.checks.find((c) => c.name === "device")).toMatchObject({ status: "warn", detail: "usbmuxd down" });
    expect(r.ok).toBe(true);
  });

  it("reports a timed-out probe as a failed check", async () => {
    const r = await doctorWithProbes({
      ...good,
      xtoolVersion: async () => {
        throw new Error("timed out");
      },
    });
    expect(r.checks.find((c) => c.name === "xtool")).toMatchObject({ status: "fail", detail: "timed out" });
  });

  it("uses the built Metro port in the ufw hint and keeps report order", async () => {
    const r = await doctorWithProbes({ ...good, ufwActive: async () => true, buildState: async () => ({ metroPort: 8099, lanIp: "1.2.3.4" }) }, "/p");
    expect(r.checks.find((c) => c.name === "firewall")?.detail).toContain("ufw allow 8099/tcp");
    expect(r.checks.map((c) => c.name)).toEqual([
      "node", "swift", "xtool", "darwin-sdk", "apple-login", "device", "firewall", "expo-sdk", "build-state", "metro-port",
    ]);
  });

  it("fails build-state when reading it throws", async () => {
    const r = await doctorWithProbes({ ...good, buildState: async () => { throw new Error("bad json"); } }, "/p");
    expect(r.checks.find((c) => c.name === "build-state")).toMatchObject({ status: "fail", detail: "bad json" });
    expect(r.checks.some((c) => c.name === "metro-port")).toBe(false);
  });
});
