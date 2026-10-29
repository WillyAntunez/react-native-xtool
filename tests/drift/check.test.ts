import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkTarget,
  classifyFailure,
  manifestCheck,
  patchDryRun,
  spawnRun,
  type Run,
} from "../../src/drift/check.js";
import type { WatchTarget } from "../../src/drift/targets.js";
import { unportableSymbols } from "../../src/pipeline/manifests.js";
import { fakeExpo57Modules } from "../support/expo57.js";
import { fakeExpo58Modules } from "../support/expo58.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifests = path.join(here, "..", "fixtures", "manifests");
const BROKEN = path.join(manifests, "react-native-worklets.Package.swift");
const PORTABLE = path.join(manifests, "react-native-worklets.portable.Package.swift");
const CLI = "/opt/rn-xtool/bin/rn-xtool.js";

const EXPO58: WatchTarget = {
  id: "expo-58/blank-typescript",
  slug: "expo-58-blank-typescript",
  line: "expo-58",
  title: "Drift: Expo SDK 58",
  kind: "expo",
  sdk: 58,
  template: "blank-typescript",
  createExpo: "5.1.5",
};
const EXPO57: WatchTarget = {
  ...EXPO58,
  id: "expo-57/blank-typescript",
  slug: "expo-57-blank-typescript",
  line: "expo-57",
  title: "Drift: Expo SDK 57",
  sdk: 57,
};

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-drift-"));
  temps.push(dir);
  return dir;
}

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** A Run that records each call and answers from `answer` (default: exit 0, no output). */
type Answer = { exitCode: number; output: string };

/** `n` counts the calls of the same command so far, this one included. */
function fakeRun(
  answer: (call: Call, n: number) => Answer | Promise<Answer> = () => ({ exitCode: 0, output: "" }),
): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (cmd, args, cwd, env) => {
    const call = { cmd, args, cwd, ...(env === undefined ? {} : { env }) };
    calls.push(call);
    return answer(call, calls.filter((c) => c.cmd === cmd).length);
  };
  return { run, calls };
}

const NPM_RESET = "npm error code ECONNRESET\nnpm error network aborted";
const NPM_ERESOLVE = "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree";

async function installWorklets(
  root: string,
  manifest: string | undefined,
  version = "0.13.0",
  versioned: Record<string, string> = {},
): Promise<void> {
  const dir = path.join(root, "node_modules", "react-native-worklets");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "react-native-worklets", version }));
  if (manifest !== undefined) await writeFile(path.join(dir, "Package.swift"), manifest);
  for (const [file, text] of Object.entries(versioned)) await writeFile(path.join(dir, file), text);
}

describe("classifyFailure", () => {
  it("classifies install failures", () => {
    for (const out of [
      "npm error code ECONNRESET",
      "npm error errno ETIMEDOUT",
      "getaddrinfo EAI_AGAIN registry.npmjs.org",
      "npm error code E503",
      "npm error code E429",
      "npm error code EIDLETIMEOUT",
      "npm error code ECONNECTIONTIMEOUT",
      "npm error code ERESPONSETIMEOUT",
      "npm error code ETRANSFERTIMEOUT",
      "npm error code ERR_SOCKET_TIMEOUT",
      "getaddrinfo EAI_FAIL registry.npmjs.org",
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "connect ECONNREFUSED 127.0.0.1:443",
      "connect EHOSTUNREACH 10.0.0.1:443",
      "Error: socket hang up",
    ]) {
      expect(classifyFailure(out), out).toBe("network");
    }
    for (const out of ["npm error code ERESOLVE", "Error: template not found", "npm error code E404"]) {
      expect(classifyFailure(out), out).toBe("drift");
    }
  });
});

describe("checkTarget", () => {
  it("retries a network failure once, then could not run", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run, calls } = fakeRun(() => ({ exitCode: 1, output: NPM_RESET }));
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(r.status).toBe("unknown");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.cmd === "npx")).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["create"]);
    expect(r.steps[0]!.ok).toBe(false);
    expect(r.steps[0]!.output).toContain("ECONNRESET");
  });

  it("continues when the retry succeeds", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run, calls } = fakeRun(async (call, n) => {
      if (call.cmd === "npx" && n === 1) return { exitCode: 1, output: NPM_RESET };
      if (call.cmd === "npx") await fakeExpo58Modules(dir);
      return { exitCode: 0, output: "" };
    });
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(calls.filter((c) => c.cmd === "npx")).toHaveLength(2);
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["create", true],
      ["gates", true],
      ["patches", true],
      ["manifests", true],
    ]);
    expect(r.status).toBe("green");
  });

  it("treats a create that exits 0 without installing as failed", async () => {
    // create-expo catches a failed npm install, says "Continuing to create the app." and exits 0.
    const dir = path.join(await tempDir(), "app");
    const reset = fakeRun(() => ({ exitCode: 0, output: `${NPM_RESET}\nContinuing to create the app.` }));
    const r = await checkTarget(EXPO58, dir, { run: reset.run, cli: CLI });
    expect(r.status).toBe("unknown");
    expect(reset.calls).toHaveLength(2);
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([["create", false]]);

    const dir2 = path.join(await tempDir(), "app");
    const eresolve = fakeRun(() => ({ exitCode: 0, output: `${NPM_ERESOLVE}\nContinuing to create the app.` }));
    const r2 = await checkTarget(EXPO58, dir2, { run: eresolve.run, cli: CLI });
    expect(r2.status).toBe("red");
    expect(eresolve.calls).toHaveLength(1);
    expect(r2.steps).toHaveLength(1);
    expect(r2.steps[0]!.ok).toBe(false);
    expect(r2.steps[0]!.output).toContain(NPM_ERESOLVE);
    expect(r2.steps[0]!.output).toContain("expo and react-native are not installed after the create");
  });

  it("an Expo create needs expo installed, not only react-native", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run } = fakeRun(async (call) => {
      if (call.cmd === "npx") await fakeExpo58Modules(dir, { expo: null });
      return { exitCode: 0, output: "" };
    });
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(r.status).toBe("red");
    expect(r.steps[0]).toEqual({ step: "create", ok: false, output: "expo is not installed after the create" });
  });

  it("retries in an empty directory", async () => {
    const dir = path.join(await tempDir(), "app");
    const seen: boolean[] = [];
    const { run } = fakeRun(async (call, n) => {
      if (call.cmd !== "npx") return { exitCode: 0, output: "" };
      seen.push(existsSync(dir));
      if (n === 1) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), "{}");
        return { exitCode: 1, output: NPM_RESET };
      }
      await fakeExpo58Modules(dir);
      return { exitCode: 0, output: "" };
    });
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(seen).toEqual([false, false]);
    expect(r.status).toBe("green");
  });

  it("is drift when the retry fails for another reason", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run, calls } = fakeRun((_call, n) => ({ exitCode: 1, output: n === 1 ? NPM_RESET : NPM_ERESOLVE }));
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(calls).toHaveLength(2);
    expect(r.status).toBe("red");
    expect(r.steps[0]!.output).toContain(NPM_ERESOLVE);
  });

  it("creates the project from the target's command, next to its directory", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run, calls } = fakeRun(async (call) => {
      if (call.cmd === "npx") await fakeExpo58Modules(dir);
      return { exitCode: 0, output: "" };
    });
    await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(calls[0]).toEqual({
      cmd: "npx",
      args: ["--yes", "create-expo@5.1.5", dir, "--template", "blank-typescript@sdk-58"],
      cwd: path.dirname(dir),
    });
    expect(calls[1]).toEqual({ cmd: "node", args: [CLI, "doctor", "--project"], cwd: dir });
  });

  it("an ERESOLVE install is drift", async () => {
    const dir = path.join(await tempDir(), "app");
    const { run, calls } = fakeRun(() => ({ exitCode: 1, output: NPM_ERESOLVE }));
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI });
    expect(r.status).toBe("red");
    expect(calls).toHaveLength(1);
    expect(r.steps).toEqual([{ step: "create", ok: false, output: NPM_ERESOLVE }]);
  });

  it("runs every check and reports each failure", async () => {
    const dir = await tempDir();
    await fakeExpo58Modules(dir);
    await installWorklets(dir, "let x = 1\nguard CFGetTypeID(v) == CFBooleanGetTypeID() else {\n}\n");
    const { run, calls } = fakeRun((call) =>
      call.cmd === "node" ? { exitCode: 1, output: "✖ versions — refused\n✖ doctor found problems" } : { exitCode: 0, output: "" },
    );
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI, existing: true });
    expect(r.status).toBe("red");
    expect(calls.some((c) => c.cmd === "npx")).toBe(false);
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ["gates", false],
      ["patches", true],
      ["manifests", false],
    ]);
    expect(r.steps[0]!.output).toContain("✖ versions — refused");
    expect(calls.filter((c) => c.cmd === "patch")).toHaveLength(4);
  });

  it("keeps the line green when the artifact probe could not reach the network", async () => {
    const dir = await tempDir();
    await fakeExpo58Modules(dir);
    const doctor = "✔ versions — Expo SDK 58\n⚠ rn-artifacts — not checked: fetch failed\n✔ doctor: all good";
    const { run } = fakeRun((call) => (call.cmd === "node" ? { exitCode: 0, output: doctor } : { exitCode: 0, output: "" }));
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI, existing: true });
    expect(r.status).toBe("green");
    const gates = r.steps.find((s) => s.step === "gates")!;
    expect(gates.ok).toBe(true);
    expect(gates.output).toContain(doctor);
    expect(gates.output).toContain(
      "note: the React Native artifacts were not checked (network); they are checked again on the next run",
    );
  });

  it("records the installed versions of the line's packages", async () => {
    const dir = await tempDir();
    await fakeExpo58Modules(dir, { expo: "58.0.22" });
    const { run } = fakeRun();
    const r = await checkTarget(EXPO58, dir, { run, cli: CLI, existing: true });
    expect(r.versions).toEqual({
      expo: "58.0.22",
      "react-native": "0.88.1",
      "expo-modules-core": "58.0.28",
      "expo-modules-jsi": "58.0.21",
      "expo-modules-autolinking": "58.0.16",
      "expo-file-system": "58.0.13",
      "expo-font": "58.0.11",
    });
    const bare = await tempDir();
    await mkdir(path.join(bare, "node_modules", "react-native"), { recursive: true });
    await writeFile(path.join(bare, "node_modules", "react-native", "package.json"), JSON.stringify({ version: "0.88.2" }));
    const target: WatchTarget = {
      id: "bare-0.88",
      slug: "bare-0.88",
      line: "bare-0.88",
      title: "Drift: React Native 0.88 (bare)",
      kind: "bare",
      minor: "0.88",
      version: "0.88.2",
      cli: "20.2.0",
    };
    const r2 = await checkTarget(target, bare, { run, cli: CLI, existing: true });
    expect(r2.versions).toEqual({ "react-native": "0.88.2" });
  });

  it("stages the line's patches for the dry run", async () => {
    const sdk57 = await tempDir();
    await fakeExpo57Modules(sdk57, { "expo-modules-jsi": "57.1.4" });
    const a = fakeRun();
    await checkTarget(EXPO57, sdk57, { run: a.run, cli: CLI, existing: true });
    const patches57 = a.calls.filter((c) => c.cmd === "patch");
    expect(patches57).toHaveLength(1);
    expect(patches57[0]!.args.at(-1)!.endsWith("expo-modules-jsi+57.1.3.patch")).toBe(true);

    const sdk58 = await tempDir();
    await fakeExpo58Modules(sdk58);
    const b = fakeRun();
    await checkTarget(EXPO58, sdk58, { run: b.run, cli: CLI, existing: true });
    expect(b.calls.filter((c) => c.cmd === "patch").map((c) => path.basename(c.args.at(-1)!))).toEqual([
      "expo+58.0.21.patch",
      "expo-modules-autolinking+58.0.16.patch",
      "expo-modules-jsi+58.0.21.patch",
      "react-native+0.88.1.patch",
    ]);
  });
});

describe("patchDryRun", () => {
  it("dry-runs each patch without context fuzz and without prompting", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const { run, calls } = fakeRun();
    const step = await patchDryRun(root, { lineOnly: true, run });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.cmd).toBe("patch");
    expect(call!.args.slice(0, -1)).toEqual(["-p1", "-F0", "-f", "--dry-run", "-d", root, "-i"]);
    expect(path.basename(call!.args.at(-1)!)).toBe("expo-modules-jsi+57.1.3.patch");
    expect(step).toEqual({ step: "patches", ok: true, output: "expo-modules-jsi+57.1.3.patch: ok" });
  });

  it("counts a patch that is already applied as ok", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const { run, calls } = fakeRun((call) =>
      call.args[0] === "-R"
        ? { exitCode: 0, output: "" }
        : { exitCode: 1, output: "Reversed (or previously applied) patch detected!  Skipping patch." },
    );
    const step = await patchDryRun(root, { lineOnly: true, run });
    expect(calls.map((c) => c.args.slice(0, 5))).toEqual([
      ["-p1", "-F0", "-f", "--dry-run", "-d"],
      ["-R", "-p1", "-F0", "-f", "--dry-run"],
    ]);
    expect(step).toEqual({ step: "patches", ok: true, output: "expo-modules-jsi+57.1.3.patch: already applied" });
  });

  it("runs patch in the C locale both ways, so its messages parse on a translated desktop", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const { run, calls } = fakeRun((call) =>
      call.args[0] === "-R" ? { exitCode: 0, output: "" } : { exitCode: 1, output: "" },
    );
    await patchDryRun(root, { lineOnly: true, run });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.env).toEqual({ LC_ALL: "C" });
  });

  it("fails with the forward output when the patch applies neither way", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const { run } = fakeRun((call) =>
      call.args[0] === "-R"
        ? { exitCode: 1, output: "reverse failed" }
        : { exitCode: 1, output: "Hunk #1 FAILED at 90." },
    );
    const step = await patchDryRun(root, { lineOnly: true, run });
    expect(step).toEqual({ step: "patches", ok: false, output: "expo-modules-jsi+57.1.3.patch: Hunk #1 FAILED at 90." });
  });

  it("fails a patch that applies only further away than patch-package looks", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const answer = (output: string) => fakeRun((call) => (call.args[0] === "-R" ? { exitCode: 1, output: "" } : { exitCode: 0, output }));
    const at20 = "checking file a.swift\nHunk #1 succeeded at 110 (offset 20 lines).\nHunk #2 succeeded at 200 (offset -20 lines).";
    expect(await patchDryRun(root, { lineOnly: true, run: answer(at20).run })).toEqual({
      step: "patches",
      ok: true,
      output: "expo-modules-jsi+57.1.3.patch: ok",
    });
    for (const [line, offset] of [
      ["Hunk #2 succeeded at 111 (offset 21 lines).", "21"],
      ["Hunk #2 succeeded at 69 (offset -21 lines).", "-21"],
    ] as const) {
      const out = `checking file a.swift\nHunk #1 succeeded at 90.\n${line}`;
      const step = await patchDryRun(root, { lineOnly: true, run: answer(out).run });
      expect(step.ok, line).toBe(false);
      expect(step.output).toBe(
        `expo-modules-jsi+57.1.3.patch: hunk #2 applies only ${offset} lines away from where the patch puts it; ` +
          `patch-package looks 20 lines either way, so the build would not apply it\n${out}`,
      );
    }
  });

  it("does not count a far reverse match as already applied", async () => {
    const root = await tempDir();
    await fakeExpo57Modules(root);
    const { run } = fakeRun((call) =>
      call.args[0] === "-R"
        ? { exitCode: 0, output: "Hunk #1 succeeded at 140 (offset 50 lines)." }
        : { exitCode: 1, output: "Hunk #1 FAILED at 90." },
    );
    expect(await patchDryRun(root, { lineOnly: true, run })).toEqual({
      step: "patches",
      ok: false,
      output: "expo-modules-jsi+57.1.3.patch: Hunk #1 FAILED at 90.",
    });
  });

  it("is ok with nothing to patch", async () => {
    const root = await tempDir();
    const { run, calls } = fakeRun();
    expect(await patchDryRun(root, { lineOnly: false, run })).toEqual({ step: "patches", ok: true, output: "no bundled patch applies" });
    expect(calls).toHaveLength(0);
  });
});

describe("manifestCheck", () => {
  it("checks the portable-manifest rewrite", async () => {
    const broken = await tempDir();
    await installWorklets(broken, await readFile(BROKEN, "utf8"));
    expect(await manifestCheck(broken)).toEqual({
      step: "manifests",
      ok: true,
      output: "react-native-reanimated: not installed\nreact-native-worklets 0.13.0: rewritten",
    });

    const portable = await tempDir();
    await installWorklets(portable, await readFile(PORTABLE, "utf8"));
    const p = await manifestCheck(portable);
    expect(p.ok).toBe(true);
    expect(p.output).toContain("react-native-worklets 0.13.0: portable");

    const unknown = await tempDir();
    await installWorklets(unknown, "let x = 1\nguard CFGetTypeID(v) == CFBooleanGetTypeID() else {\n  return\n}\n");
    const u = await manifestCheck(unknown);
    expect(u.ok).toBe(false);
    expect(u.output).toContain("react-native-worklets 0.13.0: not recognised");

    const none = await tempDir();
    expect((await manifestCheck(none)).ok).toBe(true);
    const noManifest = await tempDir();
    await installWorklets(noManifest, undefined);
    expect(await manifestCheck(noManifest)).toEqual({
      step: "manifests",
      ok: true,
      output: "react-native-reanimated: not installed\nreact-native-worklets 0.13.0: no Package.swift",
    });
  });

  it("checks the versioned manifests the build rewrites too", async () => {
    const root = await tempDir();
    await installWorklets(root, await readFile(PORTABLE, "utf8"), "0.14.0", {
      "Package@swift-6.0.swift": "let x = 1\nguard CFGetTypeID(v) == CFBooleanGetTypeID() else {\n  return\n}\n",
      "Package@swift-5.9.swift": await readFile(BROKEN, "utf8"),
    });
    expect(await manifestCheck(root)).toEqual({
      step: "manifests",
      ok: false,
      output: [
        "react-native-reanimated: not installed",
        "react-native-worklets 0.14.0: portable",
        "react-native-worklets 0.14.0 (Package@swift-5.9.swift): rewritten",
        "react-native-worklets 0.14.0 (Package@swift-6.0.swift): not recognised",
      ].join("\n"),
    });
  });

  it("unportableSymbols", async () => {
    expect(unportableSymbols(await readFile(BROKEN, "utf8"))).toEqual(["CFGetTypeID"]);
    expect(unportableSymbols(await readFile(PORTABLE, "utf8"))).toEqual([]);
  });
});

describe("spawnRun", () => {
  it("runs without a shell and keeps stdout and stderr together", async () => {
    const r = await spawnRun(process.execPath, ["-e", "console.log('out'); console.error('err $HOME'); process.exit(3)"], tmpdir());
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("out\n");
    expect(r.output).toContain("err $HOME\n");
  });

  it("adds the given variables to the inherited environment", async () => {
    const script = "console.log(process.env.LC_ALL + ' ' + (process.env.PATH ? 'path' : 'no path'))";
    const r = await spawnRun(process.execPath, ["-e", script], tmpdir(), { LC_ALL: "C" });
    expect(r).toEqual({ exitCode: 0, output: "C path\n" });
  });

  it("resolves when the command cannot start", async () => {
    const r = await spawnRun("rn-xtool-no-such-command", [], tmpdir());
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain("ENOENT");
  });
});
