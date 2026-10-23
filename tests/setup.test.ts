import { describe, expect, it, vi } from "vitest";
import { planSetup, preflightSdk, setup, swiftlyDownloadUrl, xtoolDownloadUrl } from "../src/commands/setup.js";

const all = { hasSwift: true, hasXtool: true, hasSdk: true, loggedIn: true };

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
    await setup({}, { probe: async () => all, log });
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
      setup({}, { probe: async () => ({ ...all, hasSwift: false, hasSdk: false }), log }),
    ).rejects.toThrow("--xcode-xip");
    expect(log).not.toHaveBeenCalled();
  });
});
