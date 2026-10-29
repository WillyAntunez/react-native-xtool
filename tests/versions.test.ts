import { describe, expect, it } from "vitest";
import { checkPins, compareVersions } from "../src/versions.js";

describe("compareVersions", () => {
  it("compares x.y.z numerically", () => {
    expect(compareVersions("58.0.10", "58.0.9")).toBeGreaterThan(0);
    expect(compareVersions("0.88.0", "0.88.1")).toBeLessThan(0);
    expect(compareVersions("58.0.21", "58.0.21")).toBe(0);
  });

  it("orders a prerelease below its release, as semver does", () => {
    expect(compareVersions("58.0.28-rc.1", "58.0.28")).toBeLessThan(0);
    expect(compareVersions("58.0.28", "58.0.28-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("58.0.29-canary", "58.0.28")).toBeGreaterThan(0);
    expect(compareVersions("58.0.0-canary-20261001-abc", "58.0.21")).toBeLessThan(0);
  });

  it("orders prereleases of one version by their identifiers", () => {
    expect(compareVersions("58.0.28-rc.2", "58.0.28-rc.10")).toBeLessThan(0);
    expect(compareVersions("58.0.28-alpha", "58.0.28-beta")).toBeLessThan(0);
    expect(compareVersions("58.0.28-rc", "58.0.28-rc.1")).toBeLessThan(0);
    expect(compareVersions("58.0.28-1", "58.0.28-rc")).toBeLessThan(0);
    expect(compareVersions("58.0.28-rc.1", "58.0.28-rc.1")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("58.0.28+abc", "58.0.28")).toBe(0);
    expect(compareVersions("58.0.28-rc.1+abc", "58.0.28-rc.1")).toBe(0);
  });
});

describe("checkPins on a floor", () => {
  const FLOOR = {
    expo: "58.0.21",
    "react-native": "0.88.1",
    "expo-modules-core": "58.0.28",
    "expo-modules-jsi": "58.0.21",
    "expo-modules-autolinking": "58.0.16",
    "expo-file-system": "58.0.13",
    "expo-font": "58.0.11",
  };
  const statusOf = (core: string) => checkPins(58, { ...FLOOR, "expo-modules-core": core })![2]!.status;

  it("a prerelease of the floor's version is below the floor", () => {
    expect(statusOf("58.0.28-rc.1")).toBe("below");
  });

  it("a prerelease of a later version is newer than the floor", () => {
    expect(statusOf("58.0.29-canary")).toBe("newer");
  });

  it("react-native stays exact: its prerelease is off", () => {
    expect(checkPins(58, { ...FLOOR, "react-native": "0.88.1-rc.1" })![1]!.status).toBe("off");
  });
});
