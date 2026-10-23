import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { packageRoot, toolEnv } from "../tools/exec.js";

/** The patch-package pinned in this CLI's own dependencies, not whatever npx would fetch. */
function patchPackageScript(): string {
  const pkgJson = createRequire(import.meta.url).resolve("patch-package/package.json");
  return path.join(path.dirname(pkgJson), "index.js");
}

/** patch-package rejects absolute --patch-dir, so pass it relative to the project. */
export function applyPatchesArgv(projectRoot: string): [string, string[]] {
  const patchDir = path.relative(path.resolve(projectRoot), path.join(packageRoot(), "patches"));
  return ["node", [patchPackageScript(), "--patch-dir", patchDir]];
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
    `expo-xtool could not patch ${d.pkg}@${d.installed} (patch file: ${d.patchFile}): the installed version differs from the one this release of expo-xtool patches (${d.patched}).`,
    "This is a known limitation of expo-xtool, not of your project.",
    `Options: pin "${d.pkg}" to ${d.patched} in package.json, or report the new version at https://github.com/WillyAntunez/expo-xtool/issues so the patch can be refreshed.`,
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
  // "expo" is a substring of "expo-modules-autolinking": try the longest names first.
  const named = [...mismatches].sort((a, b) => b.pkg.length - a.pkg.length).find((m) => output.includes(m.pkg));
  return named ?? mismatches[0];
}

/** patch-package is idempotent for already-applied patches and exits non-zero on failure. */
export async function applyPatches(projectRoot: string): Promise<void> {
  const [cmd, args] = applyPatchesArgv(projectRoot);
  const r = await execa(cmd, args, {
    cwd: projectRoot,
    env: toolEnv(),
    extendEnv: false,
    all: true,
    reject: false,
  });
  if (r.exitCode === 0 && !r.failed) return;
  const output = r.all ?? `${r.stdout}\n${r.stderr}`;
  const mismatch = findPatchMismatch(projectRoot, path.join(packageRoot(), "patches"), output);
  if (mismatch) throw new Error(patchFailureMessage({ ...mismatch, output }));
  const tail = output.trimEnd().split("\n").slice(-40).join("\n");
  throw new Error(`patch-package failed (exit ${r.exitCode ?? "unknown"}):\n${tail}`);
}
