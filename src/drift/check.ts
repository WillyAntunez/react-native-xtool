/**
 * The drift watch's check of one target: create a fresh project (or take an existing one), then run the project gates
 * (`rn-xtool doctor --project`), dry-run the bundled patches and check that the portable-manifest rewrite still
 * recognises the libraries that need it. Nothing is compiled. Every command goes through an injected `Run`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { makeManifestPortable, manifestFiles, unportableSymbols } from "../pipeline/manifests.js";
import { installedVersion, selectBundledPatches } from "../pipeline/patches.js";
import { installedExpoVersion, readExpoPins } from "../project/expo.js";
import { packageRoot } from "../tools/exec.js";
import { expoLineFor } from "../versions.js";
import { createCommand, type WatchTarget } from "./targets.js";

/**
 * Runs a command in `cwd`, with `env` added to the inherited environment, and resolves with its exit code and its
 * stdout and stderr together; never rejects.
 */
export type Run = (
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<{ exitCode: number; output: string }>;

/** Node's socket errors, npm's own agent timeouts (npm 10/11 `@npmcli/agent`), and registry 429 and 5xx answers. */
const NETWORK =
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|EIDLETIMEOUT|ECONNECTIONTIMEOUT|ERESPONSETIMEOUT|ETRANSFERTIMEOUT|ERR_SOCKET_TIMEOUT)\b|socket hang up|npm error code E(429|5\d\d)\b/;

/** A failed create or install: "network" (worth one retry; twice means the watch could not run) or "drift". */
export function classifyFailure(output: string): "network" | "drift" {
  return NETWORK.test(output) ? "network" : "drift";
}

export interface StepResult {
  step: "create" | "gates" | "patches" | "manifests" | "drill";
  ok: boolean;
  output: string;
}

export interface TargetResult {
  target: WatchTarget;
  /** green: every step ok; red: rn-xtool drifted from the line; unknown: the watch could not run (network). */
  status: "green" | "red" | "unknown";
  /** The installed versions of expo, react-native and the line's pins. */
  versions: Record<string, string>;
  steps: StepResult[];
}

/** How far from its place patch-package looks for a hunk, either way (patch-package 8 `applyPatch`). */
const PATCH_PACKAGE_WINDOW = 20;
/** patch's messages in English whatever the user's locale: the offset and "already applied" checks parse them. */
const PATCH_ENV = { LC_ALL: "C" };
const HUNK_OFFSET = /Hunk #(\d+) succeeded at \d+ (?:with fuzz \d+ )?\(offset (-?\d+) lines?\)/g;

/** The first hunk GNU patch placed further from its place than patch-package would look. */
function farHunk(output: string): { hunk: string; offset: string } | undefined {
  for (const m of output.matchAll(HUNK_OFFSET)) {
    if (Math.abs(Number(m[2])) > PATCH_PACKAGE_WINDOW) return { hunk: m[1]!, offset: m[2]! };
  }
  return undefined;
}

/**
 * Dry-runs each bundled patch the build would stage (`lineOnly`: the vendored SDK 57 plugin) against the project,
 * without context fuzz (`-F0`) and without prompting (`-f`). A patch that does not apply forward but reverses cleanly is
 * already applied (a project rn-xtool built before) and counts as ok. GNU patch finds a hunk at any offset, but
 * patch-package looks only 20 lines either way, so a hunk placed further away counts as not applying.
 */
export async function patchDryRun(
  root: string,
  opts: { lineOnly: boolean; run: Run; bundledDir?: string },
): Promise<StepResult> {
  const bundledDir = opts.bundledDir ?? path.join(packageRoot(), "patches");
  const names = selectBundledPatches(root, bundledDir, { lineOnly: opts.lineOnly });
  if (names.length === 0) return { step: "patches", ok: true, output: "no bundled patch applies" };
  const lines: string[] = [];
  let ok = true;
  for (const name of names) {
    const file = path.join(bundledDir, name);
    const forward = await opts.run("patch", ["-p1", "-F0", "-f", "--dry-run", "-d", root, "-i", file], root, PATCH_ENV);
    if (forward.exitCode === 0) {
      const far = farHunk(forward.output);
      if (far === undefined) {
        lines.push(`${name}: ok`);
        continue;
      }
      ok = false;
      lines.push(
        `${name}: hunk #${far.hunk} applies only ${far.offset} lines away from where the patch puts it; ` +
          `patch-package looks ${PATCH_PACKAGE_WINDOW} lines either way, so the build would not apply it\n` +
          forward.output.trimEnd(),
      );
      continue;
    }
    const reverse = await opts.run("patch", ["-R", "-p1", "-F0", "-f", "--dry-run", "-d", root, "-i", file], root, PATCH_ENV);
    if (reverse.exitCode === 0 && farHunk(reverse.output) === undefined) {
      lines.push(`${name}: already applied`);
      continue;
    }
    ok = false;
    lines.push(`${name}: ${forward.output.trimEnd()}`);
  }
  return { step: "patches", ok, output: lines.join("\n") };
}

/** The libraries whose own Package.swift needs the portable-manifest rewrite (docs/upstream/reanimated-worklets-manifest.md). */
const MANIFEST_PACKAGES = ["react-native-reanimated", "react-native-worklets"] as const;

/**
 * Checks that the rewrite still leaves no non-portable API in each installed library's manifests (Package.swift and any
 * Package@swift-*.swift, the files the build rewrites): "rewritten" (the rewrite recognised it), "portable" (nothing to
 * rewrite), or "not recognised" (a form the rewrite does not know: drift). A versioned manifest is named in its line.
 */
export async function manifestCheck(root: string): Promise<StepResult> {
  const lines: string[] = [];
  let ok = true;
  for (const pkg of MANIFEST_PACKAGES) {
    const dir = path.join(root, "node_modules", pkg);
    const version = await readFile(path.join(dir, "package.json"), "utf8").then(
      (t) => (JSON.parse(t) as { version?: string }).version ?? "(no version)",
      () => undefined,
    );
    if (version === undefined) {
      lines.push(`${pkg}: not installed`);
      continue;
    }
    for (const file of await manifestFiles(dir)) {
      const label = file === "Package.swift" ? `${pkg} ${version}` : `${pkg} ${version} (${file})`;
      const manifest = path.join(dir, file);
      if (!existsSync(manifest)) {
        lines.push(`${label}: no ${file}`);
        continue;
      }
      const r = makeManifestPortable(await readFile(manifest, "utf8"));
      if (unportableSymbols(r.text).length > 0) {
        ok = false;
        lines.push(`${label}: not recognised`);
      } else {
        lines.push(`${label}: ${r.fixes.length > 0 ? "rewritten" : "portable"}`);
      }
    }
  }
  return { step: "manifests", ok, output: lines.join("\n") };
}

const ARTIFACTS_NOT_CHECKED = /rn-artifacts — not checked/;
const ARTIFACTS_NOTE = "note: the React Native artifacts were not checked (network); they are checked again on the next run";

/** The project gates: `rn-xtool doctor --project` in the project; its exit code decides. */
async function gates(dir: string, run: Run, cli: string): Promise<StepResult> {
  const r = await run("node", [cli, "doctor", "--project"], dir);
  const note = ARTIFACTS_NOT_CHECKED.test(r.output) ? `\n${ARTIFACTS_NOTE}` : "";
  return { step: "gates", ok: r.exitCode === 0, output: `${r.output.trimEnd()}${note}` };
}

/**
 * One create attempt. It failed when the command did, or when the project's packages are missing afterwards:
 * create-expo catches a failed npm install and exits 0 ("Continuing to create the app.").
 */
async function attempt(t: WatchTarget, dir: string, run: Run): Promise<{ ok: boolean; output: string }> {
  const [cmd, args] = createCommand(t, dir);
  const r = await run(cmd, args, path.dirname(dir));
  if (r.exitCode !== 0) return { ok: false, output: r.output };
  const missing = [
    ...(t.kind === "expo" && installedExpoVersion(dir) === undefined ? ["expo"] : []),
    ...(installedVersion(dir, "react-native") === undefined ? ["react-native"] : []),
  ];
  if (missing.length === 0) return { ok: true, output: r.output };
  const verb = missing.length === 1 ? "is" : "are";
  const why = `${missing.join(" and ")} ${verb} not installed after the create`;
  return { ok: false, output: r.output.trim() === "" ? why : `${r.output.trimEnd()}\n${why}` };
}

/**
 * Creates the project. A network failure is retried once, in an emptied directory: neither create tool cleans up after
 * a failed install, and both refuse a non-empty directory.
 */
async function create(t: WatchTarget, dir: string, run: Run): Promise<{ step: StepResult; kind?: "network" | "drift" }> {
  await mkdir(path.dirname(dir), { recursive: true });
  const first = await attempt(t, dir, run);
  if (first.ok) return { step: { step: "create", ok: true, output: first.output } };
  if (classifyFailure(first.output) === "drift") {
    return { step: { step: "create", ok: false, output: first.output }, kind: "drift" };
  }
  await rm(dir, { recursive: true, force: true });
  const second = await attempt(t, dir, run);
  const output = `${first.output.trimEnd()}\n--- retry after a network failure ---\n${second.output}`;
  if (second.ok) return { step: { step: "create", ok: true, output } };
  return { step: { step: "create", ok: false, output }, kind: classifyFailure(second.output) };
}

/** The installed versions of expo, react-native and, on an Expo line, the line's pins. */
function installedVersions(t: WatchTarget, dir: string): Record<string, string> {
  const found: Record<string, string | undefined> = {
    expo: installedExpoVersion(dir),
    "react-native": installedVersion(dir, "react-native"),
    ...(t.sdk === undefined ? {} : readExpoPins(dir, t.sdk)),
  };
  return Object.fromEntries(Object.entries(found).filter((e): e is [string, string] => e[1] !== undefined));
}

/**
 * Checks one target in `dir`. The project is created first (skipped with `existing`): a network failure is retried
 * once, and a second one means the watch could not run ("unknown"); any other failure is drift ("red"). Both stop.
 * Then the gates, the patch dry-run and the manifest check all run, and any failure is drift. `cli` is rn-xtool's bin.
 */
export async function checkTarget(
  t: WatchTarget,
  dir: string,
  deps: { run: Run; cli: string; existing?: boolean },
): Promise<TargetResult> {
  const steps: StepResult[] = [];
  if (!deps.existing) {
    const created = await create(t, dir, deps.run);
    steps.push(created.step);
    if (created.kind !== undefined) {
      const status = created.kind === "network" ? "unknown" : "red";
      return { target: t, status, versions: installedVersions(t, dir), steps };
    }
  }
  const lineOnly = t.sdk !== undefined && expoLineFor(t.sdk)?.plugin === "vendored";
  steps.push(await gates(dir, deps.run, deps.cli));
  steps.push(await patchDryRun(dir, { lineOnly, run: deps.run }));
  steps.push(await manifestCheck(dir));
  const status = steps.every((s) => s.ok) ? "green" : "red";
  return { target: t, status, versions: installedVersions(t, dir), steps };
}

/** The real `Run`: spawns without a shell; a command that cannot start resolves with exit code 127 and the error. */
export const spawnRun: Run = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (e) => resolve({ exitCode: 127, output: `${Buffer.concat(chunks).toString("utf8")}${e.message}` }));
    child.on("close", (code, signal) =>
      resolve({
        exitCode: code ?? 128,
        output: `${Buffer.concat(chunks).toString("utf8")}${signal === null ? "" : `\nkilled by ${signal}`}`,
      }),
    );
  });
