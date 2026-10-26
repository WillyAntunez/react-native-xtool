import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { projectPaths } from "../paths.js";
import { packageRoot, toolEnv } from "../tools/exec.js";

/** The patch-package pinned in this CLI's own dependencies, not whatever npx would fetch. */
export function patchPackageScript(): string {
  const pkgJson = createRequire(import.meta.url).resolve("patch-package/package.json");
  return path.join(path.dirname(pkgJson), "index.js");
}

/** patch-package rejects absolute --patch-dir, so pass it relative to the project. */
export function applyPatchesArgv(projectRoot: string, patchDir: string): [string, string[]] {
  const rel = path.relative(path.resolve(projectRoot), patchDir);
  return [process.execPath, [patchPackageScript(), "--patch-dir", rel, "--error-on-fail"]];
}

export interface PatchFileInfo {
  /** Package name, e.g. "expo" or "@expo/config". */
  pkg: string;
  /** Version the patch was made against. */
  version: string;
}

/** Parses patch-package's `<pkg>+<version>.patch` (scoped: `@scope+pkg+<version>.patch`). */
export function parsePatchFileName(name: string): PatchFileInfo | undefined {
  const m = /^(.+)\+(\d+\.\d+\.\d+[^+]*)\.patch$/.exec(name);
  if (!m) return undefined;
  return { pkg: m[1]!.replace("+", "/"), version: m[2]! };
}

export interface PatchFailureDetails {
  pkg: string;
  installed: string;
  patchFile: string;
  patched: string;
  output: string;
}

export function patchFailureMessage(d: PatchFailureDetails): string {
  const tail = d.output.trimEnd().split("\n").slice(-40).join("\n");
  return [
    `rn-xtool could not patch ${d.pkg}@${d.installed} (patch file: ${d.patchFile}): the installed version differs from the one this release of rn-xtool patches (${d.patched}).`,
    "This is a known limitation of rn-xtool, not of your project.",
    `Options: pin "${d.pkg}" to ${d.patched} in package.json, or report the new version at https://github.com/WillyAntunez/react-native-xtool/issues so the patch can be refreshed.`,
    "--- patch-package output ---",
    tail,
  ].join("\n");
}

function readVersion(pkgDir: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Installed version of a package, looking at the top level and nested under expo. */
export function installedVersion(projectRoot: string, pkg: string): string | undefined {
  const modules = path.join(projectRoot, "node_modules");
  return readVersion(path.join(modules, pkg)) ?? readVersion(path.join(modules, "expo", "node_modules", pkg));
}

/** Bundled patch files whose package is installed in the project (bare RN has no expo packages). */
export function selectBundledPatches(projectRoot: string, bundledDir: string): string[] {
  return readdirSync(bundledDir)
    .filter((name) => {
      const info = parsePatchFileName(name);
      return info !== undefined && installedVersion(projectRoot, info.pkg) !== undefined;
    })
    .sort();
}

/** Empties `dest` and symlinks the selected bundled patches into it; returns their names. */
export async function stageBundledPatches(projectRoot: string, dest: string): Promise<string[]> {
  const bundledDir = path.join(packageRoot(), "patches");
  const names = selectBundledPatches(projectRoot, bundledDir);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of names) await symlink(path.join(bundledDir, name), path.join(dest, name));
  return names;
}

/** Finds a bundled patch whose package is installed at a different version. */
export function findPatchMismatch(
  projectRoot: string,
  patchDir: string,
  output = "",
): Omit<PatchFailureDetails, "output"> | undefined {
  if (!existsSync(patchDir)) return undefined;
  const mismatches: Omit<PatchFailureDetails, "output">[] = [];
  for (const patchFile of readdirSync(patchDir).sort()) {
    const info = parsePatchFileName(patchFile);
    if (!info) continue;
    const installed = installedVersion(projectRoot, info.pkg);
    if (installed !== undefined && installed !== info.version) {
      mismatches.push({ pkg: info.pkg, installed, patchFile, patched: info.version });
    }
  }
  const named = mismatches.find((m) => outputNamesPackage(output, m.pkg));
  return named ?? mismatches[0];
}

/**
 * True when patch-package output points at the package: its patch file prefix (`<pkg>+`, scoped
 * `@scope+pkg+`) or its `node_modules/<pkg>` path. A bare substring would blame "expo" for
 * "expo-modules-jsi".
 */
export function outputNamesPackage(output: string, pkg: string): boolean {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = new RegExp(`(?<![\\w@./-])${esc(pkg.replace("/", "+"))}\\+`);
  const modulePath = new RegExp(`node_modules/${esc(pkg)}(?![\\w.-])`);
  return prefix.test(output) || modulePath.test(output);
}

/** Message for a patch-package failure that matches no known version mismatch. */
export function genericPatchFailureMessage(
  r: { exitCode?: number | undefined; shortMessage?: string | undefined; message?: string | undefined },
  output: string,
): string {
  const tail = output.trimEnd().split("\n").slice(-40).join("\n");
  const spawnFailure = r.exitCode === undefined ? `\n${r.shortMessage ?? r.message ?? "process failed to spawn"}` : "";
  return `patch-package failed (exit ${r.exitCode ?? "unknown"}):${spawnFailure}\n${tail}\nReport this at https://github.com/WillyAntunez/react-native-xtool/issues with the output above.`;
}

/** patch-package 8 can exit 0 after printing a failure; detect that from its output. */
export function patchPackageOutputFailed(output: string): boolean {
  return /patch-package finished with \d+ error\(s\)/.test(output) || output.includes("**ERROR**");
}

/** The project's own patches (e.g. persisted library Package.swift files), applied from its root. */
export function projectPatchesArgv(): [string, string[]] {
  return [process.execPath, [patchPackageScript(), "--patch-dir", "patches", "--error-on-fail"]];
}

/** True when `<project>/patches` exists and holds at least one entry. */
export function hasProjectPatches(projectRoot: string): boolean {
  try {
    return readdirSync(path.join(projectRoot, "patches")).length > 0;
  } catch {
    return false;
  }
}

type PatchExec = (cmd: string, args: string[], cwd: string) => Promise<ExecaResultLike>;
interface ExecaResultLike {
  exitCode?: number | undefined;
  failed?: boolean | undefined;
  all?: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  shortMessage?: string | undefined;
  message?: string | undefined;
}

const execPatchPackage: PatchExec = (cmd, args, cwd) =>
  execa(cmd, args, { cwd, env: toolEnv(), extendEnv: false, all: true, reject: false });

/**
 * patch-package is idempotent for already-applied patches and exits non-zero on failure.
 * Applies rn-xtool's bundled patches first, then the project's own `patches/` when present.
 * The order does not matter: the project's patches only hold library Package.swift files.
 */
export async function applyPatches(projectRoot: string, exec: PatchExec = execPatchPackage): Promise<void> {
  const patchesDir = projectPaths(projectRoot).patchesDir;
  const staged = await stageBundledPatches(projectRoot, patchesDir);
  if (staged.length > 0) {
    const [cmd, args] = applyPatchesArgv(projectRoot, patchesDir);
    const r = await exec(cmd, args, projectRoot);
    const output = r.all ?? `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0 || r.failed || patchPackageOutputFailed(output)) {
      const mismatch = findPatchMismatch(projectRoot, path.join(packageRoot(), "patches"), output);
      if (mismatch) throw new Error(patchFailureMessage({ ...mismatch, output }));
      throw new Error(genericPatchFailureMessage(r, output));
    }
  }
  if (!hasProjectPatches(projectRoot)) return;
  const [pcmd, pargs] = projectPatchesArgv();
  const pr = await exec(pcmd, pargs, projectRoot);
  const poutput = pr.all ?? `${pr.stdout}\n${pr.stderr}`;
  if (pr.exitCode === 0 && !pr.failed && !patchPackageOutputFailed(poutput)) return;
  throw new Error(`Applying the project's patches/ failed.\n${genericPatchFailureMessage(pr, poutput)}`);
}
