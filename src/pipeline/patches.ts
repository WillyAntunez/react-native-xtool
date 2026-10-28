import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { projectPaths } from "../paths.js";
import type { ExpoPlugin, RnScripts } from "../versions.js";
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

/** Numeric x.y.z comparison (anything after the patch number is ignored). */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * Bundled patch files whose package is installed in the project (bare RN has no expo packages).
 * The react-native patch is only for the exact version it was made against: other versions are
 * not patched, and the caller decides whether that is fine (vendored scripts) or a stop (see rnPatchMismatch).
 * Other packages get the patch for their installed version when one is bundled, else the highest version
 * (which then fails to apply with the "pin" message). With `exactOnly` every package needs an exact match.
 */
export function selectBundledPatches(projectRoot: string, bundledDir: string, opts: { exactOnly?: boolean } = {}): string[] {
  const byPkg = new Map<string, { name: string; version: string }[]>();
  for (const name of readdirSync(bundledDir)) {
    const info = parsePatchFileName(name);
    if (info === undefined) continue;
    byPkg.set(info.pkg, [...(byPkg.get(info.pkg) ?? []), { name, version: info.version }]);
  }
  const selected: string[] = [];
  for (const [pkg, patches] of byPkg) {
    const installed = installedVersion(projectRoot, pkg);
    if (installed === undefined) continue;
    const exact = patches.find((p) => p.version === installed);
    if (exact !== undefined) selected.push(exact.name);
    else if (!opts.exactOnly && pkg !== "react-native") {
      selected.push(patches.reduce((hi, p) => (compareVersions(p.version, hi.version) > 0 ? p : hi)).name);
    }
  }
  return selected.sort();
}

/** Empties `dest` and symlinks the selected bundled patches into it; returns their names. */
export async function stageBundledPatches(
  projectRoot: string,
  dest: string,
  opts: { exactOnly?: boolean } = {},
): Promise<string[]> {
  const bundledDir = path.join(packageRoot(), "patches");
  const names = selectBundledPatches(projectRoot, bundledDir, opts);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of names) await symlink(path.join(bundledDir, name), path.join(dest, name));
  return names;
}

/** The bundled react-native patch when react-native is installed at another version. */
export function rnPatchMismatch(
  projectRoot: string,
  bundledDir: string,
): Omit<PatchFailureDetails, "output"> | undefined {
  for (const patchFile of readdirSync(bundledDir).sort()) {
    const info = parsePatchFileName(patchFile);
    if (info?.pkg !== "react-native") continue;
    const installed = installedVersion(projectRoot, info.pkg);
    if (installed !== undefined && installed !== info.version) {
      return { pkg: info.pkg, installed, patchFile, patched: info.version };
    }
  }
  return undefined;
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

/** rn-xtool's scaffold marker; `expo-xtool-scaffold-revision` is its name before the rename (pre-release apps). */
const SCAFFOLD_MARKER_RE = /(?:rn|expo)-xtool-scaffold-revision/;
const SLOT_LABEL_RE = /^\+\/\/ Cache slot: (\S+)\/dual-flavor\s*$/m;
const REVISION_RE = /^\+\/\/ (?:rn|expo)-xtool-scaffold-revision: (\d+)\s*$/m;

/** The scaffolder's RN_XTOOL_SCAFFOLD_REVISION (patches/react-native+0.88.0.patch and vendor/rn-spm). */
export const SCAFFOLD_REVISION = 3;

/**
 * Warnings for the project's persisted scaffold patches (`patches/*.patch` with rn-xtool's scaffold marker): their
 * Package.swift is only regenerated when the manifest is missing, so one is stale when its cache-slot label names
 * another React Native version than the installed one, or when an older scaffolder revision wrote it. One line per
 * patch; the slot warning wins when both apply.
 */
export function scaffoldPatchWarnings(projectRoot: string): string[] {
  const installed = installedVersion(projectRoot, "react-native");
  const dir = path.join(projectRoot, "patches");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".patch")).sort();
  } catch {
    return [];
  }
  const warnings: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!SCAFFOLD_MARKER_RE.test(text)) continue;
    const pkg = parsePatchFileName(name)?.pkg;
    const reinstall = pkg === undefined ? "the library" : `node_modules/${pkg}`;
    const tail = `(also remove ${reinstall} and reinstall: that copy still has the old Package.swift)`;
    const slot = SLOT_LABEL_RE.exec(text)?.[1];
    if (installed !== undefined && slot !== undefined && slot !== installed) {
      warnings.push(
        `⚠ patches/${name} was scaffolded for React Native ${slot}; delete it so rn-xtool regenerates it for ${installed} ${tail}`,
      );
      continue;
    }
    const revision = REVISION_RE.exec(text)?.[1];
    if (revision !== undefined && Number(revision) < SCAFFOLD_REVISION) {
      warnings.push(
        `⚠ patches/${name} was written by an older rn-xtool scaffolder (revision ${revision}, now ${SCAFFOLD_REVISION}); ` +
          `delete it so rn-xtool regenerates it ${tail}`,
      );
    }
  }
  return warnings;
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
 * With the vendored Expo plugin (SDK 57) only exact-version bundled patches are staged.
 * The order does not matter: the project's patches only hold library Package.swift files.
 */
export async function applyPatches(
  projectRoot: string,
  exec: PatchExec = execPatchPackage,
  opts: { rnScripts: RnScripts; expoPlugin?: ExpoPlugin; log?: (line: string) => void } = { rnScripts: "installed" },
): Promise<void> {
  if (opts.rnScripts === "installed") {
    const m = rnPatchMismatch(projectRoot, path.join(packageRoot(), "patches"));
    if (m) {
      const output = `patch-package was not run: react-native ${m.installed} is installed and the bundled patch is for ${m.patched}.`;
      throw new Error(patchFailureMessage({ ...m, output }));
    }
  }
  const patchesDir = projectPaths(projectRoot).patchesDir;
  const staged = await stageBundledPatches(projectRoot, patchesDir, { exactOnly: opts.expoPlugin === "vendored" });
  if (staged.length > 0) {
    const [cmd, args] = applyPatchesArgv(projectRoot, patchesDir);
    const r = await exec(cmd, args, projectRoot);
    const output = r.all ?? `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0 || r.failed || patchPackageOutputFailed(output)) {
      // Only what was staged: a bundled patch that was left out is not the one that failed.
      const mismatch = findPatchMismatch(projectRoot, patchesDir, output);
      if (mismatch) throw new Error(patchFailureMessage({ ...mismatch, output }));
      throw new Error(genericPatchFailureMessage(r, output));
    }
  }
  if (!hasProjectPatches(projectRoot)) return;
  const log = opts.log ?? ((line: string) => console.log(line));
  for (const warning of scaffoldPatchWarnings(projectRoot)) log(warning);
  const [pcmd, pargs] = projectPatchesArgv();
  const pr = await exec(pcmd, pargs, projectRoot);
  const poutput = pr.all ?? `${pr.stdout}\n${pr.stderr}`;
  if (pr.exitCode === 0 && !pr.failed && !patchPackageOutputFailed(poutput)) return;
  throw new Error(`Applying the project's patches/ failed.\n${genericPatchFailureMessage(pr, poutput)}`);
}
