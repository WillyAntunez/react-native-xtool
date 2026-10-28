import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  doctorWithProbes,
  readProjectProbe,
  renderReport,
  wifiCheck,
  type DoctorProbes,
  type ProjectProbe,
} from "../src/commands/doctor.js";
import { MissingBundleIdentifierError } from "../src/project/index.js";
import { XTOOL_SHA256, XTOOL_VERSION } from "../src/versions.js";
import { fakeExpo57Modules } from "./support/expo57.js";
import { fakeExpo58Modules } from "./support/expo58.js";

const expoProbe: ProjectProbe = {
  kind: "expo",
  rnVersion: "0.88.0",
  rnScripts: "installed",
  expoPlugin: "installed",
  sdkVersion: 58,
  bundleIdentifier: "com.example.app",
  hasExpoModules: true,
  warnings: [],
};
const bareProbe: ProjectProbe = {
  kind: "bare",
  rnVersion: "0.88.0",
  rnScripts: "installed",
  expoPlugin: "installed",
  bundleIdentifier: "org.reactjs.native.example.HelloWorld",
  hasExpoModules: false,
  target: { name: "HelloWorld", xcodeproj: "HelloWorld.xcodeproj" },
  warnings: [],
};

const good: DoctorProbes = {
  nodeVersion: () => "20.11.0",
  swiftVersion: async () => "6.4",
  xtoolPath: () => "/cache/xtool.AppImage",
  xtoolInstalled: () => true,
  xtoolVersion: async () => `xtool ${XTOOL_VERSION}`,
  xtoolSha256: async () => undefined,
  sdkInstalled: () => true,
  authStatus: async () => ({ loggedIn: true, appleId: "me@example.com", teamId: "TEAM123" }),
  devices: async () => [{ name: "iPhone", udid: "u1", transport: "USB" }],
  ufwActive: async () => false,
  lanRoute: async () => ({ ip: "192.168.1.5", dev: "wlp2s0" }),
  configLanIp: () => undefined,
  project: async () => expoProbe,
  buildState: async () => ({ metroPort: 8081, lanIp: "192.168.1.5", depsFingerprint: "fp" }),
  depsFingerprint: async () => "fp",
  portFree: async () => true,
  wifi: async () => ({ usb: { udid: "u1", enabled: true } }),
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

describe("swift 6.5 manifests", () => {
  it("adds an info line (not a failure) on Swift 6.5+", async () => {
    const r = await doctorWithProbes({ ...good, swiftVersion: async () => "6.5.0" });
    expect(r.ok).toBe(true);
    const info = r.checks.find((c) => c.name === "swift-manifests");
    expect(info?.status).toBe("info");
    expect(info?.detail).toContain("Package@swift-6.5.swift");
    expect(renderReport([info!])).toMatch(/^ℹ swift-manifests — /);
  });
  it("says nothing on Swift 6.4", async () => {
    const r = await doctorWithProbes(good);
    expect(r.checks.some((c) => c.name === "swift-manifests")).toBe(false);
  });
});

describe("doctorWithProbes", () => {
  it("passes when every probe is healthy and skips project checks without a root", async () => {
    const r = await doctorWithProbes(good);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "node", "swift", "xtool", "darwin-sdk", "apple-login", "device", "wifi", "firewall", "lan-ip",
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
    expect(r.checks.find((c) => c.name === "swift")?.detail).toContain("rn-xtool setup");
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

  it("points the login hint at rn-xtool auth login", async () => {
    const r = await doctorWithProbes({ ...good, authStatus: async () => ({ loggedIn: false }) });
    expect(r.checks.find((c) => c.name === "apple-login")?.detail).toContain(
      "run rn-xtool auth login",
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

  it("warns when the xtool sha256 differs from the pin and stays ok when it matches", async () => {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const bad = await doctorWithProbes({ ...good, xtoolSha256: async () => "0".repeat(64) });
    expect(statusOf(bad, "xtool")).toBe("warn");
    const ok = await doctorWithProbes({ ...good, xtoolSha256: async () => XTOOL_SHA256[arch] });
    expect(statusOf(ok, "xtool")).toBe("ok");
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
      { ...good, portFree: async () => false },
      "/proj",
    );
    expect(statusOf(r, "project")).toBe("ok");
    expect(r.checks.find((c) => c.name === "project-config")).toMatchObject({
      status: "ok",
      detail: "bundle identifier com.example.app",
    });
    expect(statusOf(r, "build-state")).toBe("ok");
    expect(statusOf(r, "metro-port")).toBe("warn");
    expect(r.ok).toBe(true);
  });

  it("warns, not fails, when only the bundle identifier is missing", async () => {
    const r = await doctorWithProbes(
      {
        ...good,
        project: async () => {
          throw new MissingBundleIdentifierError("com.anonymous.demo", "app.json");
        },
      },
      "/p",
    );
    expect(r.checks.find((c) => c.name === "project-config")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining('build writes "com.anonymous.demo"'),
    });
    expect(statusOf(r, "project")).toBe("info");
    expect(r.ok).toBe(true);
  });

  it("tells dynamic-config users to add the bundle identifier themselves", async () => {
    const r = await doctorWithProbes(
      {
        ...good,
        project: async () => {
          throw new MissingBundleIdentifierError("com.anonymous.demo", "app.config.js");
        },
      },
      "/p",
    );
    expect(r.checks.find((c) => c.name === "project-config")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("add \"com.anonymous.demo\" (or your own) to it"),
    });
  });

  it("tells bare users to set PRODUCT_BUNDLE_IDENTIFIER themselves", async () => {
    const r = await doctorWithProbes(
      {
        ...good,
        project: async () => {
          throw new MissingBundleIdentifierError("com.anonymous.helloworld", "project.pbxproj");
        },
      },
      "/p",
    );
    expect(r.checks.find((c) => c.name === "project-config")).toMatchObject({
      status: "warn",
      detail:
        'PRODUCT_BUNDLE_IDENTIFIER is missing for the app target in project.pbxproj; add "com.anonymous.helloworld" (or your own) to it',
    });
  });

  it("fails project with the thrown message and warns on missing build state", async () => {
    const r = await doctorWithProbes(
      {
        ...good,
        project: async () => {
          throw new Error("Expo SDK 57 is not supported");
        },
        buildState: async () => undefined,
      },
      "/proj",
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "project")).toMatchObject({
      status: "fail",
      detail: "Expo SDK 57 is not supported",
    });
    expect(r.checks.filter((c) => c.status === "fail").map((c) => c.name)).toEqual(["project"]);
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
      "node", "swift", "xtool", "darwin-sdk", "apple-login", "device", "wifi", "firewall", "lan-ip", "project", "project-config", "build-state", "deps", "metro-port",
    ]);
  });

  describe("project check", () => {
    const detailOf = async (probe: ProjectProbe) =>
      (await doctorWithProbes({ ...good, project: async () => probe }, "/p")).checks.find((c) => c.name === "project");
    it("describes an expo project", async () => {
      expect(await detailOf(expoProbe)).toMatchObject({ status: "ok", detail: "expo SDK 58, React Native 0.88.0" });
    });
    it("describes an Expo SDK 57 project", async () => {
      expect(
        await detailOf({ ...expoProbe, sdkVersion: 57, rnVersion: "0.86.3", rnScripts: "vendored", expoPlugin: "vendored" }),
      ).toMatchObject({
        status: "ok",
        detail: "expo SDK 57, React Native 0.86.3 (vendored Expo SwiftPM plugin and SwiftPM scripts)",
      });
    });
    it("describes a bare project with its target and xcodeproj", async () => {
      expect(await detailOf(bareProbe)).toMatchObject({
        status: "ok",
        detail: "bare React Native 0.88.0, target HelloWorld (HelloWorld.xcodeproj)",
      });
    });
    it("describes a vendored bare project", async () => {
      expect(await detailOf({ ...bareProbe, rnVersion: "0.86.3", rnScripts: "vendored" })).toMatchObject({
        status: "ok",
        detail: "bare React Native 0.86.3 (vendored SwiftPM scripts), target HelloWorld (HelloWorld.xcodeproj)",
      });
    });
    it("describes a bare project with expo modules", async () => {
      expect(await detailOf({ ...bareProbe, hasExpoModules: true })).toMatchObject({
        status: "ok",
        detail: "bare + expo modules, React Native 0.88.0, target HelloWorld (HelloWorld.xcodeproj)",
      });
    });
    it("warns when expo modules are installed but the Podfile does not set them up", async () => {
      const warning = "expo-modules-core is installed but ios/Podfile has no use_expo_modules!: run npx install-expo-modules.";
      expect(await detailOf({ ...bareProbe, warnings: [warning] })).toMatchObject({
        status: "warn",
        detail: `bare React Native 0.88.0, target HelloWorld (HelloWorld.xcodeproj); ${warning}`,
      });
    });
    it("fails with the detect error", async () => {
      const r = await doctorWithProbes(
        { ...good, project: async () => { throw new Error("ios/ holds more than one .xcodeproj (A.xcodeproj, B.xcodeproj)"); } },
        "/p",
      );
      expect(r.checks.find((c) => c.name === "project")).toMatchObject({
        status: "fail",
        detail: "ios/ holds more than one .xcodeproj (A.xcodeproj, B.xcodeproj)",
      });
      expect(statusOf(r, "project-config")).toBe("info");
    });
  });

  it("warns on build-state when reading it throws", async () => {
    const r = await doctorWithProbes({ ...good, buildState: async () => { throw new Error("bad json"); } }, "/p");
    expect(r.checks.find((c) => c.name === "build-state")).toMatchObject({ status: "warn" });
    expect(r.checks.find((c) => c.name === "build-state")?.detail).toContain("bad json");
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.name === "metro-port")).toBe(false);
  });

  describe("lan-ip", () => {
    const lan = (over: Partial<DoctorProbes>) => doctorWithProbes({ ...good, ...over });
    const find = (r: Awaited<ReturnType<typeof lan>>) => r.checks.find((c) => c.name === "lan-ip");

    it("is ok with ip and interface", async () => {
      expect(find(await lan({}))).toMatchObject({ status: "ok", detail: "192.168.1.5 (wlp2s0)" });
    });
    it("warns on a tunnel interface", async () => {
      const c = find(await lan({ lanRoute: async () => ({ ip: "10.8.0.2", dev: "tun0" }) }));
      expect(c?.status).toBe("warn");
      expect(c?.detail).toContain("looks like a VPN/tunnel address");
    });
    it("warns on a public address", async () => {
      expect(find(await lan({ lanRoute: async () => ({ ip: "8.8.4.4", dev: "eth0" }) }))?.status).toBe("warn");
    });
    it("fails when nothing is detected and no lanIp is configured", async () => {
      expect(find(await lan({ lanRoute: async () => ({}) }))?.status).toBe("fail");
      expect(find(await lan({ lanRoute: async () => { throw new Error("no ip"); } }))?.status).toBe("fail");
    });
    it("is ok when lanIp is pinned in config, even if undetectable", async () => {
      const c = find(await lan({ lanRoute: async () => ({}), configLanIp: () => "192.168.0.9" }));
      expect(c).toMatchObject({ status: "ok", detail: "192.168.0.9 (from config)" });
    });
  });
});

describe("deps check", () => {
  const find = (r: { checks: { name: string; status: string; detail: string }[] }) => r.checks.find((c) => c.name === "deps");
  it("is ok when the fingerprint matches", async () => {
    expect(find(await doctorWithProbes(good, "/p"))?.status).toBe("ok");
  });
  it("warns when dependencies changed", async () => {
    const r = await doctorWithProbes({ ...good, depsFingerprint: async () => "other" }, "/p");
    expect(find(r)?.status).toBe("warn");
    expect(find(r)?.detail).toContain("rn-xtool build && rn-xtool install");
  });
  it("names native edits for a bare build", async () => {
    const r = await doctorWithProbes(
      { ...good, depsFingerprint: async () => "other", buildState: async () => ({ metroPort: 8081, lanIp: "1.2.3.4", depsFingerprint: "fp", kind: "bare" as const }) },
      "/p",
    );
    expect(find(r)?.status).toBe("warn");
    expect(find(r)?.detail).toMatch(/^native project or dependencies changed since last build — run rn-xtool build && rn-xtool install$/);
  });
  it("warns when the state has no fingerprint", async () => {
    const r = await doctorWithProbes({ ...good, buildState: async () => ({ metroPort: 8081, lanIp: "1.2.3.4" }) }, "/p");
    expect(find(r)?.status).toBe("warn");
    expect(find(r)?.detail).toContain("No dependency fingerprint recorded");
  });
  it("is skipped without a build state", async () => {
    expect(find(await doctorWithProbes({ ...good, buildState: async () => undefined }, "/p"))).toBeUndefined();
  });
});

describe("wifi check", () => {
  it("is an optional note when Wi‑Fi installs were never set up", () => {
    expect(wifiCheck({})).toEqual({ status: "info", detail: "not set up (optional) — see `rn-xtool setup --wifi`" });
  });
  it("warns when the setting is off on the USB iPhone", () => {
    const c = wifiCheck({ usb: { udid: "U", enabled: false } });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("setup --wifi --yes");
  });
  it("is ok when the last known IP answers on 62078", () => {
    expect(wifiCheck({ usb: { udid: "U", enabled: true }, lastIp: "192.168.1.10", reachable: true })).toEqual({
      status: "ok",
      detail: "enabled on U; iPhone answers at 192.168.1.10:62078",
    });
  });
  it("warns, with the likely causes, when the last known IP does not answer", () => {
    const c = wifiCheck({ lastIp: "192.168.1.10", reachable: false });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("asleep");
    expect(c.detail).toContain("install --network");
  });
  it("mentions a USB read failure without failing", () => {
    const c = wifiCheck({ usbError: "pairing removed", lastIp: "1.2.3.4", reachable: true });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("pairing removed");
  });
  it("never fails doctor, even when the probe throws", async () => {
    const r = await doctorWithProbes({ ...good, wifi: async () => { throw new Error("boom"); } });
    expect(statusOf(r, "wifi")).toBe("warn");
    expect(r.ok).toBe(true);
  });
});

describe("readProjectProbe", () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  it("reads an Expo SDK 57 project with the vendored plugin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "doctor-expo57-"));
    try {
      await cp(path.join(fixtures, "expo-57"), dir, { recursive: true });
      await fakeExpo57Modules(dir);
      expect(await readProjectProbe(dir)).toMatchObject({
        kind: "expo", sdkVersion: 57, rnVersion: "0.86.3", rnScripts: "vendored", expoPlugin: "vendored", warnings: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("shows the newer-than-floor warning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "doctor-expo58-"));
    try {
      await cp(path.join(fixtures, "project"), dir, { recursive: true });
      await fakeExpo58Modules(dir, { expo: "58.0.22" });
      const probe = await readProjectProbe(dir);
      expect(probe).toMatchObject({ kind: "expo", sdkVersion: 58, rnVersion: "0.88.1", expoPlugin: "installed" });
      expect(probe.warnings).toEqual([
        "Newer than the Expo SDK 58 set this rn-xtool release was verified with: expo 58.0.22. Verified: expo 58.0.21, " +
          "react-native 0.88.1, expo-modules-core 58.0.28, expo-modules-jsi 58.0.21, expo-modules-autolinking 58.0.16, " +
          "expo-file-system 58.0.13 and expo-font 58.0.11. The build continues; if it fails or the app crashes at launch, " +
          "report it at https://github.com/WillyAntunez/react-native-xtool/issues.",
      ]);
      const project = (await doctorWithProbes({ ...good, project: async () => probe }, "/p")).checks.find((c) => c.name === "project");
      expect(project?.status).toBe("warn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("warns that @react-native-community/cli is missing from a bare project", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "doctor-bare-"));
    try {
      await cp(path.join(fixtures, "bare"), dir, { recursive: true });
      await mkdir(path.join(dir, "node_modules", "react-native"), { recursive: true });
      await writeFile(path.join(dir, "node_modules", "react-native", "package.json"), JSON.stringify({ version: "0.88.0" }));
      const probe = await readProjectProbe(dir);
      expect(probe.warnings).toEqual([expect.stringMatching(/^@react-native-community\/cli is not installed.*npm install --save-dev/)]);
      const project = (await doctorWithProbes({ ...good, project: async () => probe }, "/p")).checks.find((c) => c.name === "project");
      expect(project?.status).toBe("warn");
      expect(project?.detail).toContain("@react-native-community/cli is not installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reads a bare project read-only and reports the Podfile warning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "doctor-bare-"));
    try {
      await cp(path.join(fixtures, "bare"), dir, { recursive: true });
      for (const [name, version] of [
        ["react-native", "0.88.0"], ["expo-modules-core", "1.0.0"], ["expo", "58.0.0"], ["@react-native-community/cli", "20.2.0"],
      ]) {
        await mkdir(path.join(dir, "node_modules", name!), { recursive: true });
        await writeFile(path.join(dir, "node_modules", name!, "package.json"), JSON.stringify({ name, version }));
      }
      const probe = await readProjectProbe(dir);
      expect(probe).toMatchObject({
        kind: "bare",
        rnVersion: "0.88.0",
        expoPlugin: "installed",
        bundleIdentifier: "org.reactjs.native.example.HelloWorld",
        hasExpoModules: false,
        target: { name: "HelloWorld", xcodeproj: "HelloWorld.xcodeproj" },
      });
      expect(probe.warnings).toHaveLength(1);
      expect(probe.warnings[0]).toMatch(/^expo-modules-core is installed but ios\/Podfile has no use_expo_modules!/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
