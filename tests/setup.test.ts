import { describe, expect, it, vi } from "vitest";
import { planSetup, setup, swiftlyDownloadUrl, xtoolDownloadUrl } from "../src/commands/setup.js";

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
