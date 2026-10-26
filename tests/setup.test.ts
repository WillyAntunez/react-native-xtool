import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loggedIn,
  packagesFromPostInstall,
  pendingSwiftPackages,
  planSetup,
  preflightSdk,
  setup,
  swiftlyDownloadUrl,
  swiftPostInstallMessage,
  xtoolDownloadUrl,
} from "../src/commands/setup.js";

const all = { hasSwift: true, hasXtool: true, hasSdk: true, loggedIn: true };
const noPending = async () => undefined;

describe("planSetup", () => {
  it("returns nothing when everything is present", () => {
    expect(planSetup(all)).toEqual([]);
  });
  it("plans only the missing SDK", () => {
    expect(planSetup({ ...all, hasSdk: false })).toEqual(["install-sdk"]);
  });
  it("plans everything in order", () => {
    expect(planSetup({ hasSwift: false, hasXtool: false, hasSdk: false, loggedIn: false })).toEqual([
      "install-swift",
      "download-xtool",
      "install-sdk",
      "login-hint",
    ]);
  });
});

describe("download urls", () => {
  it("builds xtool url without a v prefix", () => {
    expect(xtoolDownloadUrl("x86_64")).toBe(
      "https://github.com/xtool-org/xtool/releases/download/1.23.0/xtool-x86_64.AppImage",
    );
  });
  it("builds swiftly url", () => {
    expect(swiftlyDownloadUrl("aarch64")).toBe(
      "https://download.swift.org/swiftly/linux/swiftly-aarch64.tar.gz",
    );
  });
});

describe("setup", () => {
  it("does nothing when the probe reports a complete state", async () => {
    const log = vi.fn();
    await setup({}, { checkSwiftPackages: noPending, probe: async () => all, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Nothing to do"));
  });
});

describe("preflightSdk", () => {
  const ok = { exists: () => true, freeBytes: async () => 20 * 1024 ** 3 };
  it("requires an xip", async () => {
    await expect(preflightSdk(undefined, ok)).rejects.toThrow("--xcode-xip");
  });
  it("rejects a missing file", async () => {
    await expect(preflightSdk("/x.xip", { ...ok, exists: () => false })).rejects.toThrow("not found");
  });
  it("rejects low disk space", async () => {
    await expect(preflightSdk("/x.xip", { ...ok, freeBytes: async () => 1024 })).rejects.toThrow("10 GB");
  });
  it("passes with xip and space", async () => {
    await expect(preflightSdk("/x.xip", ok)).resolves.toBeUndefined();
  });
  it("setup fails before running any action when the xip is missing", async () => {
    const log = vi.fn();
    await expect(
      setup({}, { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSwift: false, hasSdk: false }), log }),
    ).rejects.toThrow("--xcode-xip");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("setup config handling", () => {
  it("probes and hints with the configured xtoolPath and skips the download", async () => {
    const probe = vi.fn(async () => ({ ...all, loggedIn: false }));
    const log = vi.fn();
    await setup({ xtoolPath: "/opt/xtool" }, { checkSwiftPackages: noPending, probe, log });
    expect(probe).toHaveBeenCalledWith("/opt/xtool");
    expect(log).toHaveBeenCalledWith("Run: /opt/xtool auth login");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("xtool 1.23.0"));
  });
  it("fails when the configured xtoolPath is not executable", async () => {
    const probe = async () => ({ ...all, hasXtool: false });
    await expect(setup({ xtoolPath: "/opt/xtool" }, { checkSwiftPackages: noPending, probe, log: vi.fn() })).rejects.toThrow("/opt/xtool");
  });
  it("uses the xip passed in opts for the preflight", async () => {
    const preflightProbes = { exists: () => false, freeBytes: async () => 20 * 1024 ** 3 };
    await expect(
      setup({ xcodeXip: "/cfg.xip" }, { checkSwiftPackages: noPending, probe: async () => ({ ...all, hasSdk: false }), preflightProbes, log: vi.fn() }),
    ).rejects.toThrow("Xcode xip not found: /cfg.xip");
  });
});

describe("login probe", () => {
  it("propagates an unrunnable xtool instead of reporting logged out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtool-setup-"));
    const bin = join(dir, "xtool");
    writeFileSync(bin, "#!/bin/sh\necho 'fuse: failed to open' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    try {
      await expect(loggedIn(bin)).rejects.toThrow("libfuse2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swiftPostInstallMessage", () => {
  it("returns nothing when swiftly wrote no post-install script", () => {
    expect(swiftPostInstallMessage(undefined)).toBeUndefined();
    expect(swiftPostInstallMessage("")).toBeUndefined();
    expect(swiftPostInstallMessage("#!/bin/sh\n\n# nothing\n")).toBeUndefined();
  });
  it("tells the user to run the script as root and re-run setup", () => {
    const script = "#!/bin/sh\napt-get -y install binutils libcurl4-openssl-dev\n";
    const msg = swiftPostInstallMessage(script)!;
    expect(msg).toContain("system packages");
    expect(msg).toContain("sudo apt-get -y install binutils libcurl4-openssl-dev");
    expect(msg).toContain("rn-xtool setup");
  });
});

describe("pending Swift system packages", () => {
  const script = "#!/bin/sh\napt-get -y install binutils libcurl4-openssl-dev\n";
  it("lists the packages named by the apt line", () => {
    expect(packagesFromPostInstall(script)).toEqual(["binutils", "libcurl4-openssl-dev"]);
    expect(packagesFromPostInstall("yum install foo")).toEqual(["foo"]);
    expect(packagesFromPostInstall("")).toEqual([]);
  });
  it("reports only the packages still missing", async () => {
    const isInstalled = async (pkg: string) => pkg === "binutils";
    await expect(pendingSwiftPackages(script, isInstalled)).resolves.toEqual(["libcurl4-openssl-dev"]);
  });
  it("setup repeats the instruction while packages are missing, even when the toolchain probe is complete", async () => {
    const log = vi.fn();
    await expect(
      setup({}, { probe: async () => all, log, checkSwiftPackages: async () => "Swift needs packages: run X" }),
    ).rejects.toThrow("Swift needs packages");
  });
  it("setup proceeds when nothing is pending", async () => {
    const log = vi.fn();
    await setup({}, { probe: async () => all, log, checkSwiftPackages: async () => undefined });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Nothing to do"));
  });
});
