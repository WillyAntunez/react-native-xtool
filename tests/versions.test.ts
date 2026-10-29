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
  rnLineStatus,
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
        createExpo: "5.1.5",
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
        createExpo: "5.1.5",
      },
      {
        kind: "bare",
        minor: "0.86",
        floor: "0.86.2",
        verified: ["0.86.2", "0.86.3"],
        scripts: "vendored",
        artifacts: "adapted",
        cli: "20.1.0",
      },
      {
        kind: "bare",
        minor: "0.87",
        floor: "0.87.1",
        verified: ["0.87.1"],
        scripts: "vendored",
        artifacts: "published",
        cli: "20.2.0",
      },
      {
        kind: "bare",
        minor: "0.88",
        floor: "0.88.0",
        verified: ["0.88.0", "0.88.1"],
        scripts: "installed",
        artifacts: "published",
        cli: "20.2.0",
      },
    ]);
    const pinsOf = (sdk: number) => SUPPORTED_LINES.find((l) => l.kind === "expo" && l.sdk === sdk);
    expect(Object.keys((pinsOf(57) as { pins: object }).pins)).toEqual(Object.keys(EXPO57_PINS));
    expect(Object.keys((pinsOf(58) as { pins: object }).pins)).toEqual(Object.keys(EXPO58_PINS));
  });

  it("pins the CLI each bare line's template declares", () => {
    // @react-native-community/template@<last verified>'s template/package.json devDependencies (npm pack, 2026-10-29).
    const cli = Object.fromEntries(SUPPORTED_LINES.flatMap((l) => (l.kind === "bare" ? [[l.minor, l.cli]] : [])));
    expect(cli).toStrictEqual({ "0.86": "20.1.0", "0.87": "20.2.0", "0.88": "20.2.0" });
  });

  it("pins the create-expo each Expo line's drift project is created with", () => {
    // create-expo-app@latest resolved to create-expo 5.1.5 on 2026-10-23 (local npx cache); create-expo-app 5.0.0 is
    // only `require('create-expo')` with the range ">=5.0.1", so the pin is on create-expo itself.
    const pins = Object.fromEntries(SUPPORTED_LINES.flatMap((l) => (l.kind === "expo" ? [[l.sdk, l.createExpo]] : [])));
    expect(pins).toStrictEqual({ 57: "5.1.5", 58: "5.1.5" });
  });

  it("reads today's answers from the table", () => {
    expect([56, 57, 58, 59].map(expoPluginFor)).toEqual([undefined, "vendored", "installed", "installed"]);
    expect([56, 57, 58, 59].map(expoPinPolicyFor)).toEqual([undefined, "floor", "floor", undefined]);
    expect(expoPinsFor(59)).toBeUndefined();
    expect(supportedRnList()).toBe("0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0");
  });

  it("bareLineFor reads the minor", () => {
    const line088 = SUPPORTED_LINES.find((l) => lineId(l) === "bare-0.88");
    expect(line088).toBeDefined();
    expect(bareLineFor("0.88.2")).toBe(line088);
    expect(bareLineFor("0.88.0-rc.1")).toBe(line088);
    expect(["0.89.0", "0.8.1", "58.0.21"].map(bareLineFor)).toEqual([undefined, undefined, undefined]);
  });

  it("classifies bare versions by line", () => {
    const status = (v: string) => rnLineStatus(v).status;
    const lineOf = (v: string) => rnLineStatus(v).line;
    for (const v of ["0.86.2", "0.86.3", "0.87.1", "0.88.0", "0.88.1"]) expect(status(v), v).toBe("verified");
    for (const v of ["0.86.4", "0.87.2", "0.88.12"]) expect(status(v), v).toBe("newer");
    for (const v of ["0.86.1", "0.87.0"]) expect(status(v), v).toBe("below");
    expect(status("0.88.2-rc.1")).toBe("prerelease");
    for (const v of ["0.86.3", "0.86.4", "0.87.0", "0.88.2-rc.1"]) {
      expect(lineOf(v), v).toBeDefined();
      expect(lineOf(v), v).toBe(bareLineFor(v));
    }
    for (const v of ["0.85.3", "0.89.0"]) expect(rnLineStatus(v), v).toEqual({ status: "unsupported" });
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
