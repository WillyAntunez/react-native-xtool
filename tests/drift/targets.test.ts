import { describe, expect, it } from "vitest";
import { createCommand, newestOfMinor, watchTargets, type WatchTarget } from "../../src/drift/targets.js";

/** A fixed `npm view react-native versions` answer: prereleases and other minors mixed in. */
const RN_VERSIONS = [
  "0.85.3",
  "0.86.2",
  "0.86.3",
  "0.86.4",
  "0.87.0-rc.1",
  "0.87.1",
  "0.87.2",
  "0.87.3-rc.0",
  "0.88.0",
  "0.88.1",
  "0.88.2",
  "0.89.0-rc.1",
];

describe("newestOfMinor", () => {
  it("picks the newest stable release of the minor", () => {
    const versions = ["0.88.0", "0.88.1", "0.88.2-rc.1", "0.89.0", "0.88.10"];
    expect(newestOfMinor(versions, "0.88")).toBe("0.88.10");
    expect(newestOfMinor(versions, "0.85")).toBeUndefined();
    expect(newestOfMinor(["0.8.9", "0.88.1"], "0.8")).toBe("0.8.9");
  });
});

describe("watchTargets", () => {
  it("one target per template and bare line", () => {
    const targets = watchTargets(RN_VERSIONS);
    expect(targets.map((t) => t.id)).toEqual([
      "expo-57/blank-typescript",
      "expo-58/blank-typescript",
      "expo-58/default",
      "bare-0.86",
      "bare-0.87",
      "bare-0.88",
    ]);
    expect(targets).toEqual([
      {
        id: "expo-57/blank-typescript",
        slug: "expo-57-blank-typescript",
        line: "expo-57",
        title: "Drift: Expo SDK 57",
        kind: "expo",
        sdk: 57,
        template: "blank-typescript",
        createExpo: "5.1.5",
      },
      {
        id: "expo-58/blank-typescript",
        slug: "expo-58-blank-typescript",
        line: "expo-58",
        title: "Drift: Expo SDK 58",
        kind: "expo",
        sdk: 58,
        template: "blank-typescript",
        createExpo: "5.1.5",
      },
      {
        id: "expo-58/default",
        slug: "expo-58-default",
        line: "expo-58",
        title: "Drift: Expo SDK 58",
        kind: "expo",
        sdk: 58,
        template: "default",
        createExpo: "5.1.5",
      },
      {
        id: "bare-0.86",
        slug: "bare-0.86",
        line: "bare-0.86",
        title: "Drift: React Native 0.86 (bare)",
        kind: "bare",
        minor: "0.86",
        version: "0.86.4",
        cli: "20.1.0",
      },
      {
        id: "bare-0.87",
        slug: "bare-0.87",
        line: "bare-0.87",
        title: "Drift: React Native 0.87 (bare)",
        kind: "bare",
        minor: "0.87",
        version: "0.87.2",
        cli: "20.2.0",
      },
      {
        id: "bare-0.88",
        slug: "bare-0.88",
        line: "bare-0.88",
        title: "Drift: React Native 0.88 (bare)",
        kind: "bare",
        minor: "0.88",
        version: "0.88.2",
        cli: "20.2.0",
      },
    ]);
  });

  it("falls back to the last verified version when npm lists none of the minor", () => {
    const bare = watchTargets(["0.88.2"]).filter((t) => t.kind === "bare");
    expect(bare.map((t) => t.version)).toEqual(["0.86.3", "0.87.1", "0.88.2"]);
  });
});

describe("createCommand", () => {
  it("creates projects the way the e2e harness does", () => {
    const byId = (id: string) => watchTargets(RN_VERSIONS).find((t) => t.id === id)!;
    expect(createCommand(byId("expo-58/blank-typescript"), "/w/app")).toEqual([
      "npx",
      ["--yes", "create-expo@5.1.5", "/w/app", "--template", "blank-typescript@sdk-58"],
    ]);
    expect(createCommand(byId("bare-0.88"), "/w/app")).toEqual([
      "npx",
      [
        "--yes",
        "@react-native-community/cli@20.2.0",
        "init",
        "DriftApp",
        "--directory",
        "/w/app",
        "--version",
        "0.88.2",
        "--install-pods",
        "false",
        "--skip-git-init",
      ],
    ]);
  });

  it("never falls back to the latest create-expo", () => {
    const t: WatchTarget = { ...watchTargets(RN_VERSIONS)[0]!, createExpo: undefined };
    expect(() => createCommand(t, "/w/app")).toThrow("expo-57/blank-typescript has no create-expo version");
  });

  it("never falls back to the latest CLI", () => {
    const t: WatchTarget = {
      id: "bare-0.85",
      slug: "bare-0.85",
      line: "bare-0.85",
      title: "Drift: React Native 0.85 (bare)",
      kind: "bare",
      minor: "0.85",
      version: "0.85.3",
    };
    expect(() => createCommand(t, "/w/app")).toThrow("bare-0.85 has no @react-native-community/cli version");
  });
});
