import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bareLineFor,
  checkPins,
  compareVersions,
  expoPinPolicyFor,
  expoPinsFor,
  expoPluginFor,
  lineId,
  NODE_MIN,
  releaseLine,
  rnLineStatus,
  type BareLine,
  SUPPORTED_LINES,
  supportedExpoList,
  supportedRnList,
  XTOOL_SHA256,
  XTOOL_VERSION,
} from "../src/versions.js";
import { GSA_503_FIXED_IN_XTOOL } from "../src/tools/xtoolErrors.js";
import { EXPO56_PINS } from "./support/expo56.js";
import { EXPO57_PINS } from "./support/expo57.js";
import { EXPO58_PINS } from "./support/expo58.js";

describe("xtool pin", () => {
  it("pins xtool 1.24.0", () => {
    expect(XTOOL_VERSION).toBe("1.24.0");
    expect(XTOOL_SHA256.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(XTOOL_SHA256.aarch64).toMatch(/^[0-9a-f]{64}$/);
    expect(XTOOL_SHA256.x86_64).not.toBe("270fb6630baeede2cc7c516bfada2de81f99e11c00b5927f59c0cb5129bd56f7");
    expect(XTOOL_SHA256.aarch64).not.toBe("649e8bdc799c9273ca54be1a84e7093e4be970d4780b4b22409517935dc2053b");
  });

  it("is at least the release that fixed the Apple sign-in 503", () => {
    expect(compareVersions(XTOOL_VERSION, GSA_503_FIXED_IN_XTOOL)).toBeGreaterThanOrEqual(0);
  });
});

describe("supported lines", () => {
  it("holds every supported line in one table", () => {
    expect(SUPPORTED_LINES.map(lineId)).toEqual([
      "expo-56", "expo-57", "expo-58", "bare-0.85", "bare-0.86", "bare-0.87", "bare-0.88",
    ]);
    expect(SUPPORTED_LINES).toEqual([
      {
        kind: "expo",
        sdk: 56,
        plugin: "vendored",
        policy: "floor",
        scripts: "vendored",
        artifacts: "adapted",
        pins: EXPO56_PINS,
        templates: ["default"],
        createExpo: "5.1.5",
      },
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
        minor: "0.85",
        floor: "0.85.0",
        verified: ["0.85.0", "0.85.3"],
        scripts: "vendored",
        artifacts: "adapted",
        cli: "20.1.0",
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
    expect(Object.keys((pinsOf(56) as { pins: object }).pins)).toEqual(Object.keys(EXPO56_PINS));
    expect(Object.keys((pinsOf(57) as { pins: object }).pins)).toEqual(Object.keys(EXPO57_PINS));
    expect(Object.keys((pinsOf(58) as { pins: object }).pins)).toEqual(Object.keys(EXPO58_PINS));
  });

  /** What is wrong with a bare row's verified list: out of order, below the floor, or outside the row's minor. */
  const verifiedProblems = (line: BareLine): string[] =>
    line.verified.flatMap((v, i) => [
      ...(i > 0 && compareVersions(line.verified[i - 1]!, v) >= 0 ? [`${v} is not above ${line.verified[i - 1]}`] : []),
      ...(compareVersions(v, line.floor) < 0 ? [`${v} is below the floor ${line.floor}`] : []),
      ...(releaseLine(v) !== line.minor ? [`${v} is outside ${line.minor}`] : []),
    ]);
  const bareRows = SUPPORTED_LINES.filter((l): l is BareLine => l.kind === "bare");

  it("keeps each bare line's verified versions ascending, at or above its floor and inside its minor", () => {
    expect(bareRows.length).toBeGreaterThan(0);
    for (const line of bareRows) expect(verifiedProblems(line), line.minor).toEqual([]);
  });

  it("reports a bare row whose verified versions are out of order, below the floor or outside the minor", () => {
    const row: BareLine = { ...bareRows[0]!, minor: "0.85", floor: "0.85.1" };
    expect(verifiedProblems({ ...row, verified: ["0.85.3", "0.85.2"] })).toEqual(["0.85.2 is not above 0.85.3"]);
    expect(verifiedProblems({ ...row, verified: ["0.85.0", "0.85.3"] })).toEqual(["0.85.0 is below the floor 0.85.1"]);
    expect(verifiedProblems({ ...row, verified: ["0.85.3", "0.86.3"] })).toEqual(["0.86.3 is outside 0.85"]);
  });

  it("pins the CLI each bare line's template declares", () => {
    // @react-native-community/template@<last verified>'s template/package.json devDependencies (npm pack, 2026-10-29);
    // @react-native-community/template@0.85.0 and @0.85.3 declare 20.1.0 as well (2026-11-04).
    const cli = Object.fromEntries(SUPPORTED_LINES.flatMap((l) => (l.kind === "bare" ? [[l.minor, l.cli]] : [])));
    expect(cli).toStrictEqual({ "0.85": "20.1.0", "0.86": "20.1.0", "0.87": "20.2.0", "0.88": "20.2.0" });
  });

  it("pins the create-expo each Expo line's drift project is created with", () => {
    // create-expo-app@latest resolved to create-expo 5.1.5 on 2026-10-23 (local npx cache); create-expo-app 5.0.0 is
    // only `require('create-expo')` with the range ">=5.0.1", so the pin is on create-expo itself.
    const pins = Object.fromEntries(SUPPORTED_LINES.flatMap((l) => (l.kind === "expo" ? [[l.sdk, l.createExpo]] : [])));
    expect(pins).toStrictEqual({ 56: "5.1.5", 57: "5.1.5", 58: "5.1.5" });
  });

  it("reads today's answers from the table", () => {
    expect([55, 56, 57, 58, 59].map(expoPluginFor)).toEqual([undefined, "vendored", "vendored", "installed", "installed"]);
    expect([55, 56, 57, 58, 59].map(expoPinPolicyFor)).toEqual([undefined, "floor", "floor", "floor", undefined]);
    expect(expoPinsFor(59)).toBeUndefined();
    expect(supportedRnList()).toBe(
      "0.85.x from 0.85.0, 0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0",
    );
  });

  it("lists the supported Expo SDKs from the table", () => {
    expect(supportedExpoList()).toBe(
      "SDK 56 (expo 56.0.24 or newer 56.x), SDK 57 (expo 57.0.31 or newer 57.x) and SDK 58 or newer",
    );
  });

  it("bareLineFor reads the minor", () => {
    const line088 = SUPPORTED_LINES.find((l) => lineId(l) === "bare-0.88");
    expect(line088).toBeDefined();
    expect(bareLineFor("0.88.2")).toBe(line088);
    expect(bareLineFor("0.88.0-rc.1")).toBe(line088);
    const line085 = SUPPORTED_LINES.find((l) => lineId(l) === "bare-0.85");
    expect(line085).toBeDefined();
    expect(bareLineFor("0.85.0")).toBe(line085);
    expect(bareLineFor("0.85.4-rc.0")).toBe(line085);
    expect(["0.84.1", "0.89.0", "0.8.1", "58.0.21"].map(bareLineFor)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("classifies bare versions by line", () => {
    const status = (v: string) => rnLineStatus(v).status;
    const lineOf = (v: string) => rnLineStatus(v).line;
    for (const v of ["0.85.0", "0.85.3", "0.86.2", "0.86.3", "0.87.1", "0.88.0", "0.88.1"]) {
      expect(status(v), v).toBe("verified");
    }
    for (const v of ["0.85.1", "0.85.2", "0.85.4", "0.86.4", "0.87.2", "0.88.12"]) expect(status(v), v).toBe("newer");
    for (const v of ["0.86.1", "0.87.0"]) expect(status(v), v).toBe("below");
    for (const v of ["0.88.2-rc.1", "0.85.4-rc.0"]) expect(status(v), v).toBe("prerelease");
    for (const v of ["0.85.1", "0.85.4-rc.0", "0.86.3", "0.86.4", "0.87.0", "0.88.2-rc.1"]) {
      expect(lineOf(v), v).toBeDefined();
      expect(lineOf(v), v).toBe(bareLineFor(v));
    }
    for (const v of ["0.84.1", "0.89.0"]) expect(rnLineStatus(v), v).toEqual({ status: "unsupported" });
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

describe("NODE_MIN", () => {
  it("is package.json's engines floor and covers every runtime dependency's own floor", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(pkg.engines.node).toBe(`>=${NODE_MIN}`);
    for (const dep of Object.keys(pkg.dependencies)) {
      const own = JSON.parse(readFileSync(new URL(`../node_modules/${dep}/package.json`, import.meta.url), "utf8")) as {
        engines?: { node?: string };
      };
      const floor = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(own.engines?.node ?? ">=0")?.[1];
      expect(floor, `${dep} engines.node ${own.engines?.node}`).toBeDefined();
      expect(compareVersions(NODE_MIN, floor!), dep).toBeGreaterThanOrEqual(0);
    }
  });
});
