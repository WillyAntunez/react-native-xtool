import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityChecks, renderReport, type DoctorProbes, type ProjectProbe } from "../src/commands/doctor.js";
import { MissingBundleIdentifierError } from "../src/project/index.js";
import {
  doctorReport,
  realReportEnv,
  recordingProbes,
  redact,
  reportProbes,
  REVIEW_LINE,
  type ReportEnv,
  type SeenValues,
} from "../src/commands/report.js";
import type { Capabilities, PodspecFeature } from "../src/project/capabilities.js";
import { XTOOL_VERSION } from "../src/versions.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const noSeen = (): SeenValues => ({ appleIds: [], teamIds: [], udids: [], deviceNames: [], ips: [], bundleIds: [] });

const noPodspecs: Record<PodspecFeature, string[]> = {
  subspecs: [],
  compiler_flags: [],
  header_dir: [],
  header_mappings_dir: [],
  vendored_frameworks: [],
  resource_bundles: [],
};
const caps: Capabilities = {
  kind: "expo",
  rnVersion: "0.88.1",
  expoVersion: "58.0.21",
  sdk: 58,
  scripts: { shape: "0.88", missing: [], recognised: true, mode: "installed" },
  artifacts: { status: "cached", version: "0.88.1", missing: [] },
  expoPlugin: "ships",
  expoModules: "precompiled",
  expoModulesCoreVersion: "58.0.28",
  podspecs: { ...noPodspecs, compiler_flags: ["expo"] },
};
const expoProbe: ProjectProbe = {
  kind: "expo",
  rnVersion: "0.88.1",
  rnScripts: "installed",
  expoPlugin: "installed",
  sdkVersion: 58,
  bundleIdentifier: "com.example.app",
  hasExpoModules: true,
  warnings: [],
};
const probes: DoctorProbes = {
  nodeVersion: () => "24.15.0",
  swiftVersion: async () => "6.4",
  llvmNmVersion: async () => "21.0.0",
  llvmArVersion: async () => "21.0.0",
  hasBinaryPods: () => false,
  xtoolPath: () => "/cache/xtool.AppImage",
  xtoolInstalled: () => true,
  xtoolVersion: async () => `xtool ${XTOOL_VERSION}`,
  xtoolSha256: async () => undefined,
  sdkInstalled: () => true,
  authStatus: async () => ({ loggedIn: true, appleId: "me@example.com", teamId: "A1B2C3D4E5" }),
  devices: async () => [{ name: "Test Phone", udid: "00008110-000000000000AAAA", transport: "USB" }],
  ufwActive: async () => false,
  lanRoute: async () => ({ ip: "192.168.1.5", dev: "wlp2s0" }),
  configLanIp: () => undefined,
  project: async () => expoProbe,
  buildState: async () => ({ metroPort: 8081, lanIp: "192.168.1.5", depsFingerprint: "fp" }),
  depsFingerprint: async () => "fp",
  portFree: async () => true,
  wifi: async () => ({ usb: { udid: "00008110-000000000000AAAA", enabled: true } }),
  capabilities: async () => caps,
  podspecReader: () => ({ reader: "ruby", ruby: "3.3.8", forced: false, warning: null }),
};
const env: ReportEnv = { rnXtoolVersion: "9.9.9", os: "Ubuntu 24.04.1 LTS, Linux 6.8.0-45-generic", arch: "x64", home: "/home/me" };

describe("doctorReport", () => {
  it("redacts planted values everywhere in the report", async () => {
    const planted =
      "cannot read /home/me/apps/demo: XTL-Q7X9K2M4P1.com.example.demo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 " +
      "fe80::1c2b:3a4d:5e6f:7a8b a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 mail ops@example.org " +
      "hw 0a:1b:2c:3d:4e:5f\nJane Doe's iPhone [Network]: 00008110-000000001A2B3C4D\nat /media/jane/USB/app";
    const out = await doctorReport("/home/me/apps/demo", {
      env,
      probes: {
        ...probes,
        authStatus: async () => ({ loggedIn: true, appleId: "jane.doe@example.com", teamId: "Q7X9K2M4P1" }),
        devices: async () => [{ name: "Jane Doe's iPhone", udid: "00008110-000000001A2B3C4D", transport: "USB" }],
        wifi: async () => ({ usb: { udid: "00008110-000000001A2B3C4D", enabled: true }, lastIp: "192.168.50.77", reachable: true }),
        lanRoute: async () => ({ ip: "192.168.50.23", dev: "enx00e04c680abc" }),
        buildState: async () => ({ metroPort: 8081, lanIp: "10.0.0.12", depsFingerprint: "fp" }),
        project: async () => ({ ...expoProbe, bundleIdentifier: "com.janedoe.groceries" }),
        capabilities: async () => {
          throw new Error(planted);
        },
      },
    });
    for (const secret of [
      "jane.doe@example.com",
      "Q7X9K2M4P1",
      "Jane Doe's iPhone",
      "00008110-000000001A2B3C4D",
      "192.168.50.77",
      "192.168.50.23",
      "10.0.0.12",
      "/home/me",
      "ghp_",
      "fe80::",
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "ops@example.org",
      "XTL-",
      "janedoe",
      "com.example.demo",
      "00e04c680abc",
      "0a:1b:2c:3d:4e:5f",
      "/media/jane",
    ]) {
      expect(out).not.toContain(secret);
    }
    for (const kept of ["~/apps/demo", "<bundle id>", "<apple-id>", "<team-id>", "<udid>", "<device>", "<ip>", "<token>", "<email>", "enx<mac>", "<mac>", "/media/<user>/USB/app"]) {
      expect(out).toContain(kept);
    }
  });

  it("renders one paste-ready block", async () => {
    const out = await doctorReport("/home/me/apps/demo", { env, probes });
    expect(out.split("\n")).toEqual([
      "```text",
      "rn-xtool doctor --report",
      "rn-xtool: 9.9.9",
      "node: 24.15.0",
      "swift: 6.4",
      `xtool: ${XTOOL_VERSION}`,
      "ruby: 3.3.8",
      "podspec reader: not recorded",
      "os: Ubuntu 24.04.1 LTS, Linux 6.8.0-45-generic, x64",
      "project: expo, Expo SDK 58, expo 58.0.21, react-native 0.88.1",
      "✔ node — 24.15.0",
      "✔ ruby — 3.3.8",
      "✔ swift — 6.4",
      "✔ llvm-nm — LLVM 21.0.0",
      "✔ llvm-ar — LLVM 21.0.0",
      `✔ xtool — ${XTOOL_VERSION}`,
      "✔ darwin-sdk — installed",
      "✔ apple-login — Apple ID <apple-id>, Team ID <team-id>",
      "ℹ device — not checked (report)",
      "ℹ wifi — not checked (report)",
      "✔ firewall — ufw not active",
      "✔ lan-ip — <ip> (wlp2s0)",
      "✔ project — expo SDK 58, React Native 0.88.1",
      "✔ project-config — bundle identifier <bundle id>",
      "✔ build-state — port 8081, ip <ip>",
      "✔ deps — unchanged since last build",
      "✔ metro-port — port 8081 is free",
      ...renderReport(capabilityChecks(caps)).split("\n"),
      "```",
      REVIEW_LINE,
    ]);
    expect(REVIEW_LINE).toBe(
      "Read the report before you post it: rn-xtool replaced your home folder, Apple ID, Team ID, bundle identifiers, " +
        "device names and UDIDs, IP and MAC addresses and tokens with placeholders. Remove anything else you consider private.",
    );
  });

  it("runs no live device or LAN probe", async () => {
    const wifi = vi.fn(async () => ({ usb: { udid: "00008110-000000001A2B3C4D", enabled: true }, lastIp: "192.168.50.77" }));
    const devices = vi.fn(async () => [{ name: "Jane Doe's iPhone", udid: "00008110-000000001A2B3C4D", transport: "Network" }]);
    for (const projectOnly of [false, true]) {
      const lines = (await doctorReport("/home/me/apps/demo", { env, probes: { ...probes, wifi, devices }, projectOnly })).split("\n");
      if (!projectOnly) {
        expect(lines).toContain("ℹ device — not checked (report)");
        expect(lines).toContain("ℹ wifi — not checked (report)");
      }
    }
    expect(wifi).not.toHaveBeenCalled();
    expect(devices).not.toHaveBeenCalled();
  });

  it("drops what the probes print while the report is built", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const out = await doctorReport("/home/me/apps/demo", {
        env,
        probes: {
          ...probes,
          project: async () => {
            console.log("app.config.js: HOME=/home/me token=abc");
            console.warn("warning for jane.doe@example.com");
            process.stderr.write("raw /home/me/x\n");
            return expoProbe;
          },
        },
      });
      expect(console.log).toBe(log);
      expect(process.stderr.write).toBe(write);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(out).not.toContain("app.config.js");
      expect(out).not.toContain("jane.doe");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      write.mockRestore();
    }
  });

  it("redacts the error when building the report throws", async () => {
    const planted = "boom at /home/me/apps/demo for jane.doe@example.com on 192.168.50.23 with com.janedoe.groceries";
    const failing = doctorReport("/home/me/apps/demo", {
      env,
      probes: {
        ...probes,
        authStatus: async () => ({ loggedIn: true, appleId: "jane.doe@example.com", teamId: "Q7X9K2M4P1" }),
        project: async () => ({ ...expoProbe, bundleIdentifier: "com.janedoe.groceries" }),
        nodeVersion: () => {
          throw new Error(planted);
        },
      },
    });
    await expect(failing).rejects.toThrow("boom at ~/apps/demo for <apple-id> on <ip> with <bundle id>");
  });

  it("reports without a project or a login", async () => {
    const capabilities = vi.fn(async () => caps);
    const out = await doctorReport(undefined, {
      env,
      probes: { ...probes, authStatus: async () => ({ loggedIn: false }), devices: async () => [], capabilities },
    });
    const lines = out.split("\n");
    expect(lines).toContain("project: none (run it in the project folder)");
    expect(lines).toContain("✖ apple-login — logged out — run rn-xtool auth login");
    expect(lines).toContain("ℹ device — not checked (report)");
    expect(lines.some((l) => l.startsWith("✔ versions"))).toBe(false);
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("says the toolchain was not checked with --project", async () => {
    const lines = (await doctorReport("/home/me/apps/demo", { env, probes, projectOnly: true })).split("\n");
    expect(lines.slice(4, 10)).toEqual([
      "swift: not checked (--project)",
      "xtool: not checked (--project)",
      "ruby: 3.3.8",
      "podspec reader: not recorded",
      "os: Ubuntu 24.04.1 LTS, Linux 6.8.0-45-generic, x64",
      "project: expo, Expo SDK 58, expo 58.0.21, react-native 0.88.1",
    ]);
    expect(lines.some((l) => l.startsWith("✔ apple-login"))).toBe(false);
  });

  it("records the last build's reader and ENV names", async () => {
    const root = await tempDir("rn-xtool-report-reads-");
    const reads = path.join(root, "ios", "build", "rn-xtool-podspec-reads.jsonl");
    await mkdir(path.dirname(reads), { recursive: true });
    const forced = (podspec: string, names: string[]) =>
      JSON.stringify({
        podspec: path.join(root, podspec),
        reader: "reduced",
        why: "RN_XTOOL_PODSPEC_READER=reduced is set",
        forced: true,
        env: names,
        helpers: [],
        ok: true,
      });
    await writeFile(
      reads,
      `${forced("node_modules/x/X.podspec", ["USE_FRAMEWORKS", "RCT_NEW_ARCH_ENABLED"])}\n` +
        `${forced("node_modules/y/Y.podspec", [])}\n`,
    );
    const lines = (await doctorReport(root, { env, probes })).split("\n");
    const at = lines.indexOf(`xtool: ${XTOOL_VERSION}`);
    expect(lines.slice(at + 1, at + 5)).toEqual([
      "ruby: 3.3.8",
      "podspec reader: reduced: RN_XTOOL_PODSPEC_READER=reduced is set (last rn-spm, 2 podspecs)",
      "podspec ENV:",
      "  node_modules/x/X.podspec: RCT_NEW_ARCH_ENABLED, USE_FRAMEWORKS",
    ]);
    expect(lines[at + 5]).toMatch(/^os: /);
    // Inside the block: the fence closes after them.
    expect(lines.indexOf("```")).toBeGreaterThan(at + 4);

    const rubyRead = { podspec: path.join(root, "a.podspec"), reader: "ruby", ruby: "3.3.8", forced: false, env: [], helpers: [], ok: true };
    await writeFile(reads, `${JSON.stringify(rubyRead)}\n`);
    const ruby = (await doctorReport(root, { env, probes })).split("\n");
    expect(ruby).toContain("podspec reader: ruby 3.3.8 (last rn-spm, 1 podspec)");
    expect(ruby.some((l) => l.startsWith("podspec ENV:"))).toBe(false);
  });

  it("records no reader without a project", async () => {
    const lines = (await doctorReport(undefined, { env, probes })).split("\n");
    expect(lines).toContain("podspec reader: not recorded");
  });

  it("names only the parts the project has", async () => {
    const bare: Capabilities = { kind: "bare", rnVersion: "0.88.1", podspecs: noPodspecs };
    const out = await doctorReport("/home/me/apps/demo", { env, probes: { ...probes, capabilities: async () => bare } });
    expect(out.split("\n")).toContain("project: bare, react-native 0.88.1");
  });
});

describe("redact", () => {
  const ctx = { home: "/home/me", seen: noSeen() };

  it("keeps versions and hashes", () => {
    const text =
      "node 22.12.0, xtool 1.24.0, sha256 " +
      "0123456789abcdef".repeat(4) +
      " at 12:34 and 12:34:56, React Native 0.88.1, expo-modules-core 58.0.28, Ubuntu 24.04.1 LTS, Linux 6.8.0-45-generic" +
      ", /opt/Toolchains/SwiftToolchainForLinuxX86/usr/bin/SwiftCompilerDriverBinary" +
      ", ReactNativeDependencies (release), react-native-safe-area-context, port 8081, Package@swift-6.5.swift";
    expect(redact(text, ctx)).toBe(text);
    expect(redact("12:34", ctx)).toBe("12:34");
  });

  it("replaces the longest seen value first", () => {
    const seen = { ...noSeen(), deviceNames: ["iPhone", "Jane Doe's iPhone"] };
    expect(redact("on Jane Doe's iPhone", { home: "/home/me", seen })).toBe("on <device>");
    const ips = { ...noSeen(), ips: ["10.0.0.1"] };
    expect(redact("seen 10.0.0.1 and 10.0.0.12", { home: "/home/me", seen: ips })).toBe("seen <ip> and <ip>");
  });

  it("replaces an XTL bundle id whole, before the team id", () => {
    const seen = { ...noSeen(), teamIds: ["Q7X9K2M4P1"] };
    expect(redact("XTL-Q7X9K2M4P1.com.example.demo, team Q7X9K2M4P1", { home: "/home/me", seen })).toBe(
      "<bundle id>, team <team-id>",
    );
  });

  it("replaces bundle identifiers", () => {
    const seen = { ...noSeen(), bundleIds: ["com.janedoe.groceries"] };
    const cases: [string, string][] = [
      ["bundle identifier com.janedoe.groceries", "bundle identifier <bundle id>"],
      ["installed com.janedoe.groceries on it", "installed <bundle id> on it"],
      ['"ios": { "bundleIdentifier": "com.jd.app" }', '"ios": { "bundleIdentifier": "<bundle id>" }'],
      ["PRODUCT_BUNDLE_IDENTIFIER = org.jd.Demo;", "PRODUCT_BUNDLE_IDENTIFIER = <bundle id>;"],
      ["bundle identifier org.reactjs.native.example.JaneDemo", "bundle identifier <bundle id>"],
      ["shown once the bundle identifier is set (see project-config)", "shown once the bundle identifier is set (see project-config)"],
    ];
    for (const [input, output] of cases) expect(redact(input, { home: "/home/me", seen })).toBe(output);
  });

  it("redacts UDIDs, addresses and tokens by pattern", () => {
    const cases: [string, string][] = [
      ["00008110-000000001A2B3C4D", "<udid>"],
      ["00008110-000000001a2b3c4d", "<udid>"],
      ["A1B2C3D4E5F60718293A4B5C6D7E8F9012345678", "<udid>"],
      ["at 192.168.50.77:62078", "at <ip>:62078"],
      ["2001:db8:85a3:0:0:8a2e:370:7334", "<ip>"],
      ["[fe80::1%wlp2s0]:62078", "[<ip>]:62078"],
      ["::1 and ::ffff:10.0.0.1", "<ip> and <ip>"],
      ["::10.0.0.1, fe80::1.", "::<ip>, <ip>."],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl", "<token>"],
      ["Authorization: Bearer abc.DEF_123-xyz", "Authorization: Bearer <token>"],
      ["password=hunter2&secret=s3cr3t access_token=abc", "password=<token>&secret=<token> access_token=<token>"],
      ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "<token>"],
      ["key aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5", "key <token>"],
      ["mail ops@example.org", "mail <email>"],
    ];
    for (const [input, output] of cases) expect(redact(input, ctx)).toBe(output);
  });

  it("redacts the home folder and other users' folders", () => {
    expect(redact("/home/me/b/x", { home: "/home/me/a", seen: noSeen() })).toBe("~/x");
    expect(redact("/home/me/a/proj and /home/me/ab/y", { home: "/home/me/a", seen: noSeen() })).toBe("~/proj and ~/y");
    expect(redact("cd /home/me", ctx)).toBe("cd ~");
    expect(redact("/mnt/c/Users/Jane Doe/x and /mnt/d/Users/jd/y", ctx)).toBe("~/x and ~/y");
  });

  it("redacts homes under /var/home (Fedora Silverblue)", () => {
    expect(redact("cd /var/home/me/app", ctx)).toBe("cd ~/app");
    expect(redact("/var/home/me/app and /home/me/x", { home: "/var/home/me", seen: noSeen() })).toBe("~/app and ~/x");
    expect(redact("/var/home/me/a/x and /var/home/me/b/y", { home: "/var/home/me/a", seen: noSeen() })).toBe("~/x and ~/y");
  });

  it("covers WSL homes without a slash after the name", () => {
    expect(redact("in /mnt/c/Users/Jane Doe", ctx)).toBe("in ~");
    expect(redact("/mnt/c/Users/Jane Doe: not an Expo project", ctx)).toBe("~: not an Expo project");
    expect(redact("(/mnt/c/Users/Jane Doe)", ctx)).toBe("(~)");
    expect(redact("/mnt/c/Users/Jane and later /usr/bin", ctx)).toBe("~ and later /usr/bin");
    expect(redact("/mnt/c/Users/Jane Doe/x\n/mnt/c/Users/Jo", ctx)).toBe("~/x\n~");
  });

  it("redacts the user on external drives", () => {
    expect(redact("/media/jane/USB/app and /run/media/jane/x", ctx)).toBe("/media/<user>/USB/app and /run/media/<user>/x");
  });

  it("redacts MAC addresses and the interface names made from them", () => {
    const cases: [string, string][] = [
      ["lan-ip — <ip> (enx00e04c680abc)", "lan-ip — <ip> (enx<mac>)"],
      ["on wlx74DA38AABBCC", "on wlx<mac>"],
      ["wwx0011223344ff up", "wwx<mac> up"],
      ["hw 0a:1b:2c:3d:4e:5f and 0A-1B-2C-3D-4E-5F.", "hw <mac> and <mac>."],
    ];
    for (const [input, output] of cases) expect(redact(input, ctx)).toBe(output);
    expect(redact("enp4s0, wlp2s0, tailscale0, 12:34:56", ctx)).toBe("enp4s0, wlp2s0, tailscale0, 12:34:56");
  });

  it("redacts an IPv6 address right after a colon", () => {
    expect(redact("addr:fe80::1c2b:3a4d:5e6f:7a8b", ctx)).toBe("addr:<ip>");
    expect(redact("inet6 addr: 2001:db8::1/64", ctx)).toBe("inet6 addr: <ip>/64");
  });

  it("redacts private values by context when no probe recorded them", () => {
    const cases: [string, string][] = [
      ["- Team ID: Q7X9K2M4P1", "- Team ID: <team-id>"],
      ["team Q7X9K2M4P1 failed, Team ID Q7X9K2M4P1", "team Q7X9K2M4P1 failed, Team ID <team-id>"],
      ["- Apple ID: +15555550123", "- Apple ID: <apple-id>"],
      ["bundle identifier com.janedoe.groceries", "bundle identifier <bundle id>"],
      ["✔ device — Jane Doe's iPhone (USB)", "✔ device — <device> (USB)"],
      ["Jane Doe's iPhone [Network]: <udid>\nJD (2) [USB]: <udid>", "<device> [Network]: <udid>\n<device> [USB]: <udid>"],
      ["⚠ device — no USB device found — connect and unlock your iPhone", "⚠ device — no USB device found — connect and unlock your iPhone"],
      ["Team ID unknown", "Team ID unknown"],
    ];
    for (const [input, output] of cases) expect(redact(input, ctx)).toBe(output);
  });

  it("replaces only an Apple ID after 'Apple ID', not the words that follow it", () => {
    const cases: [string, string][] = [
      ["✖ apple-login — Apple ID not logged in", "✖ apple-login — Apple ID not logged in"],
      ["Apple ID is required, Apple ID unknown", "Apple ID is required, Apple ID unknown"],
      ["✔ apple-login — Apple ID jane.doe@example.com, Team ID Q7X9K2M4P1", "✔ apple-login — Apple ID <apple-id>, Team ID <team-id>"],
      ["Logged in. Apple ID: jane.doe@example.com", "Logged in. Apple ID: <apple-id>"],
    ];
    for (const [input, output] of cases) expect(redact(input, ctx)).toBe(output);
  });

  it("does not replace short device names everywhere", () => {
    const seen = { ...noSeen(), deviceNames: ["ip", "JD"] };
    expect(redact("lan <ip> device ip, JD", { home: "/home/me", seen })).toBe("lan <ip> device ip, JD");
  });
});

describe("recordingProbes", () => {
  it("records the private values the probes return and passes them through", async () => {
    const seen = noSeen();
    const auth = { loggedIn: true, appleId: "jane.doe@example.com", teamId: "Q7X9K2M4P1" };
    const devices = [{ name: "Jane Doe's iPhone", udid: "00008110-000000001A2B3C4D", transport: "USB" }];
    const wifi = { usb: { udid: "00008110-000000001A2B3C4E", enabled: true }, lastIp: "192.168.50.77" };
    const route = { ip: "192.168.50.23", dev: "wlp2s0" };
    const state = { metroPort: 8081, lanIp: "10.0.0.12" };
    const p = recordingProbes(
      {
        ...probes,
        authStatus: async () => auth,
        devices: async () => devices,
        wifi: async () => wifi,
        lanRoute: async () => route,
        configLanIp: () => "10.0.0.13",
        buildState: async () => state,
        project: async () => ({ ...expoProbe, bundleIdentifier: "com.janedoe.groceries" }),
      },
      seen,
    );
    await p.project("/proj");
    expect(await p.authStatus()).toBe(auth);
    expect(await p.devices()).toBe(devices);
    expect(await p.wifi("/proj")).toBe(wifi);
    expect(await p.lanRoute()).toBe(route);
    expect(p.configLanIp()).toBe("10.0.0.13");
    expect(await p.buildState("/proj")).toBe(state);
    expect(seen).toEqual({
      appleIds: ["jane.doe@example.com"],
      teamIds: ["Q7X9K2M4P1"],
      udids: ["00008110-000000001A2B3C4D", "00008110-000000001A2B3C4E"],
      deviceNames: ["Jane Doe's iPhone"],
      ips: ["192.168.50.77", "192.168.50.23", "10.0.0.13", "10.0.0.12"],
      bundleIds: ["com.janedoe.groceries"],
    });
  });

  it("records the bundle id a missing-identifier error suggests, and rethrows it", async () => {
    const seen = noSeen();
    const err = new MissingBundleIdentifierError("com.janedoe.groceries", "app.json");
    const p = recordingProbes(
      {
        ...probes,
        project: async () => {
          throw err;
        },
      },
      seen,
    );
    await expect(p.project("/proj")).rejects.toBe(err);
    expect(seen.bundleIds).toEqual(["com.janedoe.groceries"]);
  });
});

describe("reportProbes", () => {
  /** A bare project with react-native `version`, under a fresh HOME so no artifact cache is found. */
  async function bareProject(version: string): Promise<string> {
    vi.stubEnv("HOME", await tempDir("rn-xtool-report-home-"));
    const dir = await tempDir("rn-xtool-report-");
    await cp(path.join(fixtures, "bare"), dir, { recursive: true });
    const rnDir = path.join(dir, "node_modules", "react-native");
    await mkdir(rnDir, { recursive: true });
    await writeFile(path.join(rnDir, "package.json"), JSON.stringify({ name: "react-native", version }));
    return dir;
  }

  it("makes no network request for the artifacts", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const dir = await bareProject("0.88.1");
    const c = await (await reportProbes(dir, true)).capabilities(dir);
    expect(c.artifacts).toEqual({ status: "offline", version: "0.88.1", missing: [] });
    expect(fetchStub).not.toHaveBeenCalled();
    const out = await doctorReport(dir, { env: { ...env, home: os.homedir() }, projectOnly: true });
    expect(out).toContain("rn-artifacts — not checked (offline)");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reads the config as doctor does, and its defaults when the config cannot be read", async () => {
    const dir = await bareProject("0.88.1");
    await writeFile(path.join(dir, "rn-xtool.config.json"), JSON.stringify({ lanIp: "10.1.2.3" }));
    expect((await reportProbes(dir, false)).configLanIp()).toBe("10.1.2.3");
    expect((await reportProbes(dir, true)).configLanIp()).toBeUndefined();
    await writeFile(path.join(dir, "rn-xtool.config.json"), "{ not json");
    expect((await reportProbes(dir, false)).configLanIp()).toBeUndefined();
  });
});

describe("realReportEnv", () => {
  it("names this rn-xtool, the OS, the architecture and the home folder", () => {
    const e = realReportEnv();
    expect(e.rnXtoolVersion).toBe(pkg.version);
    expect(e.os.endsWith(`, Linux ${os.release()}`)).toBe(true);
    expect(e.arch).toBe(process.arch);
    expect(e.home).toBe(os.homedir());
  });
});
