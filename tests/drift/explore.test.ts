import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Run } from "../../src/drift/check.js";
import {
  exploreRowsFor,
  exploreTable,
  exploreTarget,
  readExploreRows,
  type ExploreRow,
} from "../../src/drift/explore.js";
import {
  createCommand,
  EXPLORE_CREATE_EXPO,
  EXPLORE_EXPO_SDKS,
  EXPLORE_RN_CLI,
  EXPLORE_RN_MINORS,
  exploreTargets,
  type WatchTarget,
} from "../../src/drift/targets.js";
import type { Capabilities, PodspecFeature } from "../../src/project/capabilities.js";
import { SUPPORTED_LINES } from "../../src/versions.js";

const RN_VERSIONS = [
  "0.81.5",
  "0.81.6",
  "0.82.0",
  "0.82.1",
  "0.83.9",
  "0.83.10",
  "0.84.0",
  "0.84.1",
  "0.85.2",
  "0.85.3",
  "0.85.4-rc.0",
  "0.86.3",
];

const NO_PODSPECS: Record<PodspecFeature, string[]> = {
  subspecs: [],
  compiler_flags: [],
  header_dir: [],
  header_mappings_dir: [],
  vendored_frameworks: [],
  resource_bundles: [],
};

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

async function appDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-explore-"));
  temps.push(dir);
  return path.join(dir, "app");
}

async function install(dir: string, pkg: string, version: string): Promise<void> {
  await mkdir(path.join(dir, "node_modules", pkg), { recursive: true });
  await writeFile(path.join(dir, "node_modules", pkg, "package.json"), JSON.stringify({ name: pkg, version }));
}

/** A Run that records each call; `answer` gets the 1-based call number. */
function fakeRun(answer: (n: number, cwd: string) => Promise<{ exitCode: number; output: string }>) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const run: Run = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return answer(calls.length, cwd);
  };
  return { run, calls };
}

const bare081 = (): WatchTarget => exploreTargets(RN_VERSIONS).find((t) => t.id === "bare-0.81")!;
const expo54 = (): WatchTarget => exploreTargets(RN_VERSIONS).find((t) => t.id === "expo-54/blank-typescript")!;

describe("exploreTargets", () => {
  it("explores Expo SDK 54–56 and bare 0.81–0.85", () => {
    expect(EXPLORE_EXPO_SDKS).toEqual([54, 55, 56]);
    expect(EXPLORE_RN_MINORS).toEqual(["0.81", "0.82", "0.83", "0.84", "0.85"]);
    const targets = exploreTargets(RN_VERSIONS);
    expect(targets.map((t) => t.id)).toEqual([
      "expo-54/blank-typescript",
      "expo-55/blank-typescript",
      "expo-56/blank-typescript",
      "bare-0.81",
      "bare-0.82",
      "bare-0.83",
      "bare-0.84",
      "bare-0.85",
    ]);
    expect(targets[0]).toEqual({
      id: "expo-54/blank-typescript",
      slug: "expo-54-blank-typescript",
      line: "expo-54",
      title: "Explore: Expo SDK 54",
      kind: "expo",
      sdk: 54,
      template: "blank-typescript",
      createExpo: "5.1.5",
    });
    expect(targets.filter((t) => t.kind === "bare").map((t) => [t.slug, t.version, t.cli])).toEqual([
      ["bare-0.81", "0.81.6", "20.0.0"],
      ["bare-0.82", "0.82.1", "20.0.0"],
      ["bare-0.83", "0.83.10", "20.0.0"],
      ["bare-0.84", "0.84.1", "20.1.0"],
      ["bare-0.85", "0.85.3", "20.1.0"],
    ]);
    expect(targets[3]!.title).toBe("Explore: React Native 0.81 (bare)");
    // Every target can be created: pinned tools, never @latest.
    for (const t of targets) expect(createCommand(t, "/w/app")[1].join(" ")).not.toContain("latest");
  });

  it("pins the CLI each minor's template declares", () => {
    // From package/template/package.json of @react-native-community/template at each minor's newest patch
    // (0.81.6, 0.82.1, 0.83.10, 0.84.1, 0.85.3), the same method as the bare rows' `cli`.
    expect(EXPLORE_RN_CLI).toStrictEqual({
      "0.81": "20.0.0",
      "0.82": "20.0.0",
      "0.83": "20.0.0",
      "0.84": "20.1.0",
      "0.85": "20.1.0",
    });
  });

  it("creates the Expo projects with the create-expo the Expo lines pin", () => {
    for (const line of SUPPORTED_LINES) if (line.kind === "expo") expect(line.createExpo).toBe(EXPLORE_CREATE_EXPO);
    expect(createCommand(expo54(), "/w/app")).toEqual([
      "npx",
      ["--yes", "create-expo@5.1.5", "/w/app", "--template", "blank-typescript@sdk-54"],
    ]);
  });

  it("leaves a minor npm does not list without a version", () => {
    const bare = exploreTargets([]).filter((t) => t.kind === "bare");
    expect(bare.map((t) => t.version)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("exploreTarget", () => {
  it("turns capabilities into a row", async () => {
    const dir = await appDir();
    const { run, calls } = fakeRun(async () => {
      await install(dir, "react-native", "0.81.5");
      return { exitCode: 0, output: "" };
    });
    const seen: string[] = [];
    const capabilities = async (root: string): Promise<Capabilities> => {
      seen.push(root);
      return {
        kind: "bare",
        rnVersion: "0.81.5",
        scripts: { shape: "none", missing: [], recognised: true, mode: "vendored" },
        artifacts: { status: "published", version: "0.81.5", missing: [] },
        podspecs: NO_PODSPECS,
      };
    };
    const row = await exploreTarget(bare081(), dir, { run, capabilities });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([createCommand(bare081(), dir).flat()]);
    expect(seen).toEqual([dir]);
    expect(row).toEqual({
      id: "bare-0.81",
      installed: "react-native 0.81.5",
      scripts: "none",
      artifacts: "published",
      expoPlugin: "—",
      expoModules: "—",
      podspecs: "none",
      reason: "React Native 0.81: no SwiftPM scripts; support comes with the translator",
    });
  });

  it("describes an Expo project", async () => {
    const dir = await appDir();
    const { run } = fakeRun(async () => {
      await install(dir, "react-native", "0.81.5");
      await install(dir, "expo", "54.0.33");
      return { exitCode: 0, output: "" };
    });
    const row = await exploreTarget(expo54(), dir, {
      run,
      capabilities: async () => ({
        kind: "expo",
        rnVersion: "0.81.5",
        expoVersion: "54.0.33",
        sdk: 54,
        scripts: { shape: "none", missing: [], recognised: true, mode: "vendored" },
        artifacts: {
          status: "missing",
          version: "0.81.5",
          missing: ["ReactNativeDependencies (debug)", "ReactNativeDependencies (release)"],
        },
        expoPlugin: "none",
        expoModules: "source",
        podspecs: { ...NO_PODSPECS, subspecs: ["a"], compiler_flags: ["a", "b"] },
      }),
    });
    expect(row).toEqual({
      id: "expo-54/blank-typescript",
      installed: "expo 54.0.33, react-native 0.81.5",
      scripts: "none",
      artifacts: "missing: ReactNativeDependencies (debug), ReactNativeDependencies (release)",
      expoPlugin: "none",
      expoModules: "source",
      podspecs: "subspecs: a; compiler_flags: a, b",
      reason:
        "Expo SDK 54: expo ships no SwiftPM plugin; React Native 0.81: no SwiftPM scripts, no prebuilt artifacts for " +
        "0.81.5; support comes with the translator",
    });
  });

  it("shows an artifact probe that could not answer as unknown", async () => {
    const dir = await appDir();
    const { run } = fakeRun(async () => {
      await install(dir, "react-native", "0.85.3");
      return { exitCode: 0, output: "" };
    });
    const row = await exploreTarget(bare081(), dir, {
      run,
      capabilities: async () => ({
        kind: "bare",
        rnVersion: "0.85.3",
        scripts: { shape: "0.87", missing: [], recognised: true, mode: "vendored" },
        artifacts: { status: "unknown", version: "0.85.3", missing: [], detail: "timed out after 10 s" },
        podspecs: NO_PODSPECS,
      }),
    });
    expect(row.artifacts).toBe("unknown (timed out after 10 s)");
    expect(row.scripts).toBe("0.87");
  });

  it("a failed probe shows as unknown", async () => {
    const unknownCells = (row: ExploreRow) =>
      Object.entries(row)
        .filter(([k]) => k !== "id" && k !== "reason")
        .map(([, v]) => v);
    const never = async (): Promise<Capabilities> => {
      throw new Error("must not detect a project that was not created");
    };

    // A create that fails with drift (no retry).
    const output = [
      "npm warn exec The following package was not found and will be installed: create-expo@5.1.5",
      "npm error code ETARGET",
      "npm error notarget No matching version found for expo-template-blank-typescript@sdk-54.",
    ].join("\n");
    const drift = fakeRun(async () => ({ exitCode: 1, output }));
    const red = await exploreTarget(expo54(), await appDir(), { run: drift.run, capabilities: never });
    expect(drift.calls).toHaveLength(1);
    expect(red.id).toBe("expo-54/blank-typescript");
    expect(unknownCells(red)).toEqual(Array(6).fill("unknown"));
    expect(red.reason).toBe("could not create: npm error code ETARGET");

    // Two network failures.
    const net = fakeRun(async () => ({ exitCode: 1, output: "npm error code ECONNRESET\nnpm error network aborted" }));
    const unknown = await exploreTarget(bare081(), await appDir(), { run: net.run, capabilities: never });
    expect(net.calls).toHaveLength(2);
    expect(unknownCells(unknown)).toEqual(Array(6).fill("unknown"));
    expect(unknown.reason).toMatch(/^could not create: /);
    expect(unknown.reason).toBe("could not create: npm error code ECONNRESET");
  });

  it("names the last line when the create output has no error line", async () => {
    const output = "Creating an Expo project\nContinuing to create the app.";
    const { run } = fakeRun(async () => ({ exitCode: 0, output }));
    const row = await exploreTarget(expo54(), await appDir(), { run });
    expect(row.reason).toBe("could not create: expo and react-native are not installed after the create");
  });

  it("a target that cannot be created at all shows as unknown", async () => {
    const { run, calls } = fakeRun(async () => ({ exitCode: 0, output: "" }));
    const row = await exploreTarget({ ...bare081(), version: undefined }, await appDir(), { run });
    expect(calls).toHaveLength(0);
    expect(row.reason).toBe("could not create: bare-0.81 has no react-native version to create it with");
    expect(row.scripts).toBe("unknown");
  });

  it("a detector that throws shows as unknown", async () => {
    const dir = await appDir();
    const { run } = fakeRun(async () => {
      await install(dir, "react-native", "0.81.6");
      return { exitCode: 0, output: "" };
    });
    const row = await exploreTarget(bare081(), dir, {
      run,
      capabilities: async () => {
        throw new Error("rn-xtool.config.json: Unexpected token\nat line 2");
      },
    });
    expect(row.reason).toBe("could not detect: rn-xtool.config.json: Unexpected token");
    expect(row.artifacts).toBe("unknown");
  });

  it("explores an existing project without creating it", async () => {
    const dir = await appDir();
    const { run, calls } = fakeRun(async () => ({ exitCode: 1, output: "" }));
    const row = await exploreTarget(bare081(), dir, {
      run,
      existing: true,
      capabilities: async () => ({ podspecs: NO_PODSPECS }),
    });
    expect(calls).toHaveLength(0);
    expect(row.installed).toBe("nothing installed");
    expect(row.reason).toBe("react-native is not installed: run npm install");
  });
});

describe("exploreTable", () => {
  const row = (id: string, reason = "r"): ExploreRow => ({
    id,
    installed: "react-native 0.81.6",
    scripts: "none",
    artifacts: "published",
    expoPlugin: "—",
    expoModules: "—",
    podspecs: "none",
    reason,
  });

  it("one row per target, in target order", () => {
    const table = exploreTable([row("bare-0.81"), row("bare-0.82", "a | b\nc")]);
    expect(table.split("\n")).toEqual([
      "| Target | Installed | SwiftPM scripts | Artifacts | Expo plugin | Expo modules | Podspec features | Reason |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| bare-0.81 | react-native 0.81.6 | none | published | — | — | none | r |",
      "| bare-0.82 | react-native 0.81.6 | none | published | — | — | none | a \\| b c |",
      "",
    ]);
  });

  it("orders the rows by target and fills a missing one as unknown", () => {
    const targets = exploreTargets(RN_VERSIONS).slice(3, 6);
    const rows = exploreRowsFor(targets, [row("bare-0.83"), row("bare-0.81"), row("expo-99/x")]);
    expect(rows.map((r) => r.id)).toEqual(["bare-0.81", "bare-0.82", "bare-0.83"]);
    expect(rows[0]).toEqual(row("bare-0.81"));
    expect(rows[1]).toEqual({
      id: "bare-0.82",
      installed: "unknown",
      scripts: "unknown",
      artifacts: "unknown",
      expoPlugin: "unknown",
      expoModules: "unknown",
      podspecs: "unknown",
      reason: "could not explore: the explore job did not finish",
    });
  });

  it("reads the rows the explore jobs wrote", async () => {
    const dir = path.dirname(await appDir());
    await mkdir(path.join(dir, "explore-bare-0.81"), { recursive: true });
    await writeFile(path.join(dir, "explore-bare-0.81", "bare-0.81.json"), JSON.stringify(row("bare-0.81")));
    await writeFile(path.join(dir, "bare-0.82.json"), JSON.stringify(row("bare-0.82")));
    await writeFile(path.join(dir, "broken.json"), "{");
    await writeFile(path.join(dir, "other.json"), JSON.stringify({ id: 1 }));
    const { rows, errors } = await readExploreRows(dir);
    expect(rows.map((r) => r.id).sort()).toEqual(["bare-0.81", "bare-0.82"]);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("other.json: not an exploration row");
    expect(await readExploreRows(path.join(dir, "absent"))).toEqual({ rows: [], errors: [] });
  });
});
