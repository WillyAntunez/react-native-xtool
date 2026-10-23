import { existsSync, readdirSync } from "node:fs";
import { execa } from "execa";
import { installedVersion, patchPackageScript } from "./patches.js";
import { createRequire } from "node:module";
import path from "node:path";
import type { ProjectPaths } from "../paths.js";
import { runArgv, toolEnv } from "../tools/exec.js";

export const AUTOLINKING_CONFIG_COMMAND = [
  "npx",
  "expo-modules-autolinking",
  "react-native-config",
  "--json",
  "--platform",
  "ios",
];

function resolveRnDir(paths: ProjectPaths): string {
  const require = createRequire(import.meta.url);
  return path.dirname(
    require.resolve("react-native/package.json", { paths: [paths.root] }),
  );
}

/** RN writes `.spm-injected.json` inside `ios/<App>.xcodeproj/`; the bare `ios/` location is accepted too. */
function hasSpmMarker(iosDir: string): boolean {
  if (existsSync(path.join(iosDir, ".spm-injected.json"))) return true;
  try {
    return readdirSync(iosDir).some(
      (name) =>
        name.endsWith(".xcodeproj") &&
        existsSync(path.join(iosDir, name, ".spm-injected.json")),
    );
  } catch {
    return false;
  }
}

export function rnSpmArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string },
  rnDir: string = resolveRnDir(paths),
): string[] {
  const mode = hasSpmMarker(paths.ios) ? "update" : "add";
  return [
    path.join(rnDir, "scripts", "setup-apple-spm.js"),
    mode,
    "--config-command",
    JSON.stringify(AUTOLINKING_CONFIG_COMMAND),
    // stdin is ignored by the runner, so prompts can never be answered: auto-accept them.
    "--yes",
    ...(opts.rnArtifactsDir
      ? ["--download", "skip", "--artifacts", opts.rnArtifactsDir]
      : []),
  ];
}

export interface RnRunResult {
  exitCode: number;
  output: string;
}

export type RnRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<RnRunResult>;

export interface RnSpmDeps {
  runner: RnRunner;
  log: (s: string) => void;
  rnDir?: string;
}

/** Runs a command with nice, streaming its output live while buffering it. */
export const streamingRunner: RnRunner = async (cmd, args, opts) => {
  const [bin, argv] = runArgv(cmd, args, true);
  const child = execa(bin, argv, {
    cwd: opts.cwd,
    env: toolEnv(),
    extendEnv: false,
    stdio: ["ignore", "pipe", "pipe"],
    reject: false,
    buffer: false,
  });
  let output = "";
  // setEncoding makes the stream decode with a stateful decoder, so a multibyte
  // character split across chunks is never corrupted.
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    output += c;
    process.stdout.write(c);
  });
  child.stderr?.on("data", (c: string) => {
    output += c;
    process.stderr.write(c);
  });
  const r = await child;
  if (r.exitCode === undefined)
    output += `\n${r.shortMessage ?? r.message ?? "process failed to spawn"}`;
  return { exitCode: r.exitCode ?? 1, output };
};

// RN's other variant (`..., and it ships no podspec so it cannot be scaffolded`) is not scaffoldable.
const MISSING_RE =
  /error: Package\.swift is missing for library "([^"]+)"(?!, and it ships no podspec)/;
const CREATED_RE = /Created file (patches\/\S+\.patch)/;

/** Scaffoldable libraries RN reports as lacking a Package.swift (has a podspec), deduped, in first-seen order. */
export function parseMissingPackageSwift(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const name = MISSING_RE.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Same argv as the add/update run (incl. offline artifact flags) with only the action swapped. */
export function scaffoldArgv(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string },
  rnDir: string = resolveRnDir(paths),
): string[] {
  const args = rnSpmArgs(paths, opts, rnDir);
  args[1] = "scaffold";
  return args;
}

/**
 * `--patch-dir patches` is relative to the project root: the user's patches, not expo-xtool's.
 * `--exclude` replaces patch-package's default (`package\.json$`): it also drops SwiftPM build
 * artifacts (`.build/.lock`, `CACHEDIR.TAG`, ...). package.json stays excluded on purpose:
 * `swiftpmConfig.name` falls back to the podspec name, so the scaffolded manifest does not need it.
 */
export const PERSIST_EXCLUDE = "(^|/)\\.build/|^package\\.json$";
export function persistScaffoldArgv(name: string): [string, string[]] {
  return [
    process.execPath,
    [patchPackageScript(), name, "--patch-dir", "patches", "--exclude", PERSIST_EXCLUDE],
  ];
}

/** patch-package prints `✔ Created file patches/<x>.patch`; prefer that over guessing the name. */
function createdPatchFile(output: string): string | undefined {
  return CREATED_RE.exec(output)?.[1];
}

function computedPatchFile(root: string, name: string): string {
  const version = installedVersion(root, name) ?? "unknown";
  return `patches/${name.replace("/", "+")}+${version}.patch`;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-40).join("\n");
}

export async function runRnSpm(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string },
  deps: Partial<RnSpmDeps> = {},
): Promise<void> {
  const runner = deps.runner ?? streamingRunner;
  const log = deps.log ?? ((s: string) => console.log(s));
  const rnDir = deps.rnDir ?? resolveRnDir(paths);
  const rnArgs = rnSpmArgs(paths, opts, rnDir);

  const first = await runner("node", rnArgs, { cwd: paths.ios });
  if (first.exitCode === 0) return;

  const names = parseMissingPackageSwift(first.output);
  if (names.length === 0)
    throw new Error(
      `React Native SwiftPM setup failed (exit ${first.exitCode}):\n${tail(first.output)}`,
    );

  log(`▸ scaffold — generating Package.swift for: ${names.join(", ")}`);
  const sc = await runner("node", scaffoldArgv(paths, opts, rnDir), {
    cwd: paths.ios,
  });
  if (sc.exitCode !== 0)
    throw new Error(
      `React Native spm scaffold failed (exit ${sc.exitCode}):\n${tail(sc.output)}`,
    );

  for (const name of names) {
    const [cmd, args] = persistScaffoldArgv(name);
    let failure: string | undefined;
    let persisted = "";
    try {
      const r = await runner(cmd, args, { cwd: paths.root });
      persisted = r.output;
      if (r.exitCode !== 0) failure = firstLine(r.output) || `exit ${r.exitCode}`;
    } catch (e) {
      failure = firstLine(e instanceof Error ? e.message : String(e)) || "spawn error";
    }
    if (failure !== undefined) {
      log(
        `⚠ Could not persist ${name}'s Package.swift to patches/ (${failure}). The build continues; it will be re-scaffolded on the next fresh install.`,
      );
      continue;
    }
    log(`✔ scaffold — persisted ${createdPatchFile(persisted) ?? computedPatchFile(paths.root, name)}`);
  }

  const second = await runner("node", rnArgs, { cwd: paths.ios });
  if (second.exitCode !== 0) {
    throw new Error(
      `React Native SwiftPM setup still failed after scaffolding ${names.join(", ")} (exit ${second.exitCode}):\n${tail(second.output)}`,
    );
  }
}
