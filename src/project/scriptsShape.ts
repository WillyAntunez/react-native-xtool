/**
 * The shape of the React Native SwiftPM scripts a project has installed, read as text (never loaded or run). The shape
 * picks the scripts mode: rn-xtool's vendored copy (vendor/rn-spm) or the installed scripts. An unknown shape falls
 * back to the version table.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parsePatchFileName } from "../pipeline/patches.js";
import { packageRoot } from "../tools/exec.js";
import { bareLineFor, releaseLine, type RnScripts } from "../versions.js";

export type ScriptsShape = "none" | "0.87" | "0.88" | "unknown";

/**
 * What the vendored driver and the rn-artifacts step call in the scripts, per file (relative to `<rnDir>/scripts`):
 * the names each file exports and the command-line options it declares.
 */
export const SCRIPTS_REQUIREMENTS: readonly { file: string; exports: readonly string[]; options: readonly string[] }[] = [
  {
    file: "setup-apple-spm.js",
    exports: ["main", "determineVersion", "ensureBothArtifactFlavors", "resolveAppIosDeploymentTarget"],
    options: ["yes", "artifacts", "download", "config-command"],
  },
  {
    file: "spm/generate-spm-autolinking-config.js",
    exports: ["generateAutolinkingConfig", "parseConfigCommandJson"],
    options: [],
  },
  { file: "spm/scaffold-package-swift.js", exports: ["scaffoldAll", "refreshScaffoldedPlatformFloors"], options: [] },
  { file: "spm/sync-spm-autolinking.js", exports: ["main"], options: ["ios-deployment-target"] },
  { file: "spm/generate-spm-package.js", exports: ["main"], options: [] },
  { file: "spm/flavored-frameworks.js", exports: ["finalizeArtifactPublication"], options: [] },
  { file: "spm/download-spm-artifacts.js", exports: ["resolveCacheSlotVersion"], options: [] },
];

/** What React Native 0.87 lacks against the 0.88 shape (RN 0.87.1 as installed), in requirement order. */
const MISSING_087 = [
  "setup-apple-spm.js export resolveAppIosDeploymentTarget",
  "spm/scaffold-package-swift.js export refreshScaffoldedPlatformFloors",
  "spm/sync-spm-autolinking.js option --ios-deployment-target",
];

const EXPORTS_START = "module.exports = {";

/**
 * The names between the file's last `module.exports = {` and the next `}`: shorthand identifiers and the keys of
 * `key: value` entries. Comments inside the block are skipped.
 */
function exportedNames(text: string): Set<string> {
  const start = text.lastIndexOf(EXPORTS_START);
  if (start < 0) return new Set();
  const rest = text.slice(start + EXPORTS_START.length);
  const end = rest.indexOf("}");
  if (end < 0) return new Set();
  const body = rest
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const names = new Set<string>();
  for (const entry of body.split(",")) {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(entry)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function declaresOption(text: string, name: string): boolean {
  return text.includes(`.option('${name}'`) || text.includes(`.option("${name}"`);
}

/** Reads the scripts under `scriptsRoot` (`<rnDir>/scripts`) as text and names their shape. */
export function readScriptsShape(scriptsRoot: string): { shape: ScriptsShape; missing: string[] } {
  if (!existsSync(path.join(scriptsRoot, "setup-apple-spm.js")) && !existsSync(path.join(scriptsRoot, "spm"))) {
    return { shape: "none", missing: [] };
  }
  const missing: string[] = [];
  for (const { file, exports, options } of SCRIPTS_REQUIREMENTS) {
    let text: string;
    try {
      text = readFileSync(path.join(scriptsRoot, file), "utf8");
    } catch (e) {
      missing.push((e as NodeJS.ErrnoException).code === "ENOENT" ? `${file} file` : `${file} unreadable`);
      continue;
    }
    const names = exportedNames(text);
    for (const name of exports) if (!names.has(name)) missing.push(`${file} export ${name}`);
    for (const name of options) if (!declaresOption(text, name)) missing.push(`${file} option --${name}`);
  }
  if (missing.length === 0) return { shape: "0.88", missing };
  const is087 = missing.length === MISSING_087.length && missing.every((m, i) => m === MISSING_087[i]);
  return { shape: is087 ? "0.87" : "unknown", missing };
}

export interface ScriptsCapability {
  shape: ScriptsShape;
  /** What the shape lacks (unknown shapes), or why a known shape does not pair with the bundled patches of its line. */
  missing: string[];
  /** False when `mode` comes from the version table instead of the shape. */
  recognised: boolean;
  /** The scripts the build runs; undefined when the shape is unknown and the version has no row. */
  mode: RnScripts | undefined;
}

function hasBundledRnPatch(bundledDir: string, line: string): boolean {
  let names: string[];
  try {
    names = readdirSync(bundledDir);
  } catch {
    return false;
  }
  return names.some((name) => {
    const info = parsePatchFileName(name);
    return info?.pkg === "react-native" && releaseLine(info.version) === line;
  });
}

/**
 * The scripts mode for react-native `rnVersion` at `rnDir`, from the shape of its scripts and whether rn-xtool bundles
 * a react-native patch of the version's release line (that patch edits the installed 0.88-shaped scripts):
 * - none and 0.87 → vendored, when the line has no bundled patch;
 * - 0.88 → installed, when it has one.
 * Anything else is not recognised and takes the line's `scripts` from the version table.
 */
export function scriptsCapability(
  rnDir: string,
  rnVersion: string,
  bundledDir: string = path.join(packageRoot(), "patches"),
): ScriptsCapability {
  const { shape, missing } = readScriptsShape(path.join(rnDir, "scripts"));
  const fallback = (why: string[]): ScriptsCapability => ({
    shape,
    missing: why,
    recognised: false,
    mode: bareLineFor(rnVersion)?.scripts,
  });
  if (shape === "unknown") return fallback(missing);
  const line = releaseLine(rnVersion);
  const patched = hasBundledRnPatch(bundledDir, line);
  if (shape === "0.88") {
    if (!patched) return fallback([`no bundled react-native patch for ${line}`]);
    return { shape, missing, recognised: true, mode: "installed" };
  }
  if (patched) return fallback([`react-native ${line}'s own SwiftPM scripts, which rn-xtool's ${line} patch expects`]);
  return { shape, missing, recognised: true, mode: "vendored" };
}
