import { describe, expect, it } from "vitest";
import {
  bareLineFor,
  checkPins,
  compareVersions,
  expoPinPolicyFor,
  expoPinsFor,
  expoPluginFor,
  lineId,
  releaseLine,
  rnScriptsFor,
  SUPPORTED_LINES,
  supportedRnList,
} from "../src/versions.js";
import { EXPO57_PINS } from "./support/expo57.js";
import { EXPO58_PINS } from "./support/expo58.js";

describe("supported lines", () => {
  it("holds every supported line in one table", () => {
    expect(SUPPORTED_LINES.map(lineId)).toEqual(["expo-57", "expo-58", "bare-0.86", "bare-0.87", "bare-0.88"]);
    expect(SUPPORTED_LINES).toEqual([
      {
        kind: "expo",
        sdk: 57,
        plugin: "vendored",
        policy: "floor",
        scripts: "vendored",
        artifacts: "adapted",
        pins: EXPO57_PINS,
        templates: ["blank-typescript"],
      },
      {
        kind: "expo",
        sdk: 58,
        plugin: "installed",
        policy: "floor",
        scripts: "installed",
        artifacts: "published",
        pins: EXPO58_PINS,
        templates: ["blank-typescript", "default"],
      },
      {
        kind: "bare",
        minor: "0.86",
        floor: "0.86.2",
        verified: ["0.86.2", "0.86.3"],
        scripts: "vendored",
        artifacts: "adapted",
      },
      {
        kind: "bare",
        minor: "0.87",
        floor: "0.87.1",
        verified: ["0.87.1"],
        scripts: "vendored",
        artifacts: "published",
      },
      {
        kind: "bare",
        minor: "0.88",
        floor: "0.88.0",
        verified: ["0.88.0", "0.88.1"],
        scripts: "installed",
        artifacts: "published",
      },
    ]);
    const pinsOf = (sdk: number) => SUPPORTED_LINES.find((l) => l.kind === "expo" && l.sdk === sdk);
    expect(Object.keys((pinsOf(57) as { pins: object }).pins)).toEqual(Object.keys(EXPO57_PINS));
    expect(Object.keys((pinsOf(58) as { pins: object }).pins)).toEqual(Object.keys(EXPO58_PINS));
  });

  it("reads today's answers from the table", () => {
    expect([56, 57, 58, 59].map(expoPluginFor)).toEqual([undefined, "vendored", "installed", "installed"]);
    expect([56, 57, 58, 59].map(expoPinPolicyFor)).toEqual([undefined, "floor", "floor", undefined]);
    expect(expoPinsFor(59)).toBeUndefined();
    expect(["0.86.2", "0.86.3", "0.87.1", "0.88.0", "0.88.1"].map(rnScriptsFor)).toEqual([
      "vendored",
      "vendored",
      "vendored",
      "installed",
      "installed",
    ]);
    expect(rnScriptsFor("0.88.2")).toBeUndefined();
    expect(supportedRnList()).toBe("0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1");
  });

  it("bareLineFor reads the minor", () => {
    const line088 = SUPPORTED_LINES.find((l) => lineId(l) === "bare-0.88");
    expect(line088).toBeDefined();
    expect(bareLineFor("0.88.2")).toBe(line088);
    expect(bareLineFor("0.88.0-rc.1")).toBe(line088);
    expect(["0.89.0", "0.8.1", "58.0.21"].map(bareLineFor)).toEqual([undefined, undefined, undefined]);
  });
});

describe("releaseLine", () => {
  it("is 0.y for a 0.x version and the major otherwise", () => {
    expect(["0.88.2", "57.1.4", "58.0.21-rc.1"].map(releaseLine)).toEqual(["0.88", "57", "58"]);
  });
});

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

describe("checkPins on the SDK 57 floor", () => {
  const statusOf = (sdk: number, name: string, installed: Record<string, string>) =>
    checkPins(sdk, installed)!.find((c) => c.name === name)!.status;

  it("a newer 57.x is newer than the floor", () => {
    expect(statusOf(57, "expo-modules-jsi", { ...EXPO57_PINS, "expo-modules-jsi": "57.1.4" })).toBe("newer");
  });

  it("react-native stays exact", () => {
    expect(statusOf(57, "react-native", { ...EXPO57_PINS, "react-native": "0.86.4" })).toBe("off");
  });
});

describe("checkPins across release lines", () => {
  it("a package of another major is off on SDK 57", () => {
    const checks = checkPins(57, { ...EXPO57_PINS, "expo-modules-jsi": "58.0.19" })!;
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok", "off"]);
  });

  it("a package of another major is off on SDK 58", () => {
    const checks = checkPins(58, { ...EXPO58_PINS, "expo-modules-core": "59.0.0", expo: "57.0.31" })!;
    expect(checks.map((c) => c.status)).toEqual(["off", "ok", "off", "ok", "ok", "ok", "ok"]);
  });
});
