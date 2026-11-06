import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import { projectPaths } from "../paths.js";
import {
  compareVersions,
  expoPinPolicyFor,
  expoPinsFor,
  releaseLine,
  type ExpoPlugin,
  type RnScripts,
} from "../versions.js";
import { scaffoldedPods } from "../project/earlyChecks.js";
import type { PodSource, PodTable } from "../project/podTable.js";
import type { ProjectKind } from "../project/types.js";
import { packageRoot, toolEnv } from "../tools/exec.js";
import { outside, packagesWithManifest } from "./manifests.js";

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

/**
 * `floor`: the project is on a floor SDK (57, 58), where Expo published a newer version than the one this release
 * patches. Its expo-modules-* copies follow expo's own ranges, so a direct pin nests the copy expo uses (G2); npm
 * `overrides` hold every copy on the verified set instead (`overrides`: name → version), or the user waits for a release.
 * `direct`: the failing package is a direct dependency, whose own entry must equal its override (EOVERRIDE).
 */
export function patchFailureMessage(
  d: PatchFailureDetails,
  opts: { floor?: { overrides: Record<string, string>; direct: boolean } } = {},
): string {
  const tail = d.output.trimEnd().split("\n").slice(-40).join("\n");
  if (opts.floor !== undefined) {
    const block = `"overrides": { ${Object.entries(opts.floor.overrides)
      .map(([name, version]) => `"${name}": "${version}"`)
      .join(", ")} }`;
    const own = opts.floor.overrides[d.pkg];
    const direct =
      opts.floor.direct && own !== undefined
        ? ` (${d.pkg} is a direct dependency: set it to "${own}" in dependencies too)`
        : "";
    return [
      `rn-xtool could not patch ${d.pkg}@${d.installed} (patch file: ${d.patchFile}): the installed version differs from the one this release of rn-xtool patches (${d.patched}).`,
      "This is a known limitation of rn-xtool, not of your project.",
      `Options: add an "overrides" block with the set this release was verified with to package.json, ${block}, and run ` +
        `\`npm install\`${direct}; or wait for an rn-xtool release that supports the new version, and report it at ` +
        "https://github.com/WillyAntunez/react-native-xtool/issues.",
      "Do not pin expo-modules-* packages as direct dependencies: npm would nest the copy expo uses. Remove any that " +
        "package.json lists before you add the block (`npm uninstall <package>`): npm refuses an override that differs " +
        "from a direct dependency (EOVERRIDE). If `rn-xtool doctor` then says expo-modules-jsi resolves from a nested " +
        "copy, run `npm update expo-modules-jsi`.",
      "--- patch-package output ---",
      tail,
    ].join("\n");
  }
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

/**
 * Bundled patch files whose package is installed in the project (bare RN has no expo packages), sorted.
 * Each package gets the patch for its installed version when one is bundled, else the highest one of the installed
 * version's release line (react-native 0.88.2 gets the 0.88.1 patch). Packages other than react-native then fall back
 * to the highest version (which then fails to apply with the "pin" message); with `lineOnly` (the vendored SDK 57
 * plugin) that fallback is left out, so another SDK's patch is never staged. A react-native without a patch of its line
 * is not patched, and the caller decides whether that is fine (vendored scripts) or a stop (see rnPatchMismatch).
 */
export function selectBundledPatches(projectRoot: string, bundledDir: string, opts: { lineOnly?: boolean } = {}): string[] {
  const byPkg = new Map<string, { name: string; version: string }[]>();
  for (const name of readdirSync(bundledDir)) {
    const info = parsePatchFileName(name);
    if (info === undefined) continue;
    byPkg.set(info.pkg, [...(byPkg.get(info.pkg) ?? []), { name, version: info.version }]);
  }
  const highest = (list: { name: string; version: string }[]) =>
    list.reduce((hi, p) => (compareVersions(p.version, hi.version) > 0 ? p : hi));
  const selected: string[] = [];
  for (const [pkg, patches] of byPkg) {
    const installed = installedVersion(projectRoot, pkg);
    if (installed === undefined) continue;
    const exact = patches.find((p) => p.version === installed);
    if (exact !== undefined) {
      selected.push(exact.name);
      continue;
    }
    const sameLine = patches.filter((p) => releaseLine(p.version) === releaseLine(installed));
    if (sameLine.length > 0) selected.push(highest(sameLine).name);
    else if (!opts.lineOnly && pkg !== "react-native") selected.push(highest(patches).name);
  }
  return selected.sort();
}

/** Empties `dest` and symlinks the selected bundled patches into it; returns their names. */
export async function stageBundledPatches(
  projectRoot: string,
  dest: string,
  opts: { lineOnly?: boolean } = {},
): Promise<string[]> {
  const bundledDir = path.join(packageRoot(), "patches");
  const names = selectBundledPatches(projectRoot, bundledDir, opts);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const name of names) await symlink(path.join(bundledDir, name), path.join(dest, name));
  return names;
}

/**
 * The mismatch when react-native is installed on a release line no bundled react-native patch was made for, naming the
 * highest bundled one (what the "pin" text suggests); undefined when react-native is not installed or a bundled patch
 * of its line exists (selectBundledPatches stages it).
 */
export function rnPatchMismatch(
  projectRoot: string,
  bundledDir: string,
): Omit<PatchFailureDetails, "output"> | undefined {
  const installed = installedVersion(projectRoot, "react-native");
  if (installed === undefined) return undefined;
  let highest: { patchFile: string; version: string } | undefined;
  for (const patchFile of readdirSync(bundledDir)) {
    const info = parsePatchFileName(patchFile);
    if (info?.pkg !== "react-native") continue;
    if (releaseLine(info.version) === releaseLine(installed)) return undefined;
    if (highest === undefined || compareVersions(info.version, highest.version) > 0) {
      highest = { patchFile, version: info.version };
    }
  }
  return highest && { pkg: "react-native", installed, patchFile: highest.patchFile, patched: highest.version };
}

/** "0.88.0 and 0.88.1": the versions `pkg` has a bundled patch for, ascending. */
function bundledVersionList(bundledDir: string, pkg: string): string {
  const versions = readdirSync(bundledDir)
    .map(parsePatchFileName)
    .filter((info) => info?.pkg === pkg)
    .map((info) => info!.version)
    .sort(compareVersions);
  return versions.length < 2 ? versions.join("") : `${versions.slice(0, -1).join(", ")} and ${versions[versions.length - 1]}`;
}

/**
 * The part of patch-package's output that reports failures: from its first error on. patch-package prints every
 * warning before the first error, and a version-mismatch warning names a package whose patch applied.
 */
function patchFailureOutput(output: string): string {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const first = /\*\*ERROR\*\*|^Error:/m.exec(plain);
  return first === null ? plain : plain.slice(first.index);
}

/**
 * Finds a bundled patch whose package is installed at a different version, preferring the one patch-package's
 * failure output names.
 */
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
  const failures = patchFailureOutput(output);
  const named = mismatches.find((m) => outputNamesPackage(failures, m.pkg));
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

/**
 * The staged bundled patch that failed although its package is installed at the patch's version: patch-package then
 * applied it neither forward nor in reverse, so the package's files are neither the original nor the patched ones.
 */
export function findStalePatchedPackage(
  projectRoot: string,
  patchDir: string,
  output: string,
): Omit<PatchFailureDetails, "output"> | undefined {
  if (!existsSync(patchDir)) return undefined;
  const failures = patchFailureOutput(output);
  for (const patchFile of readdirSync(patchDir).sort()) {
    const info = parsePatchFileName(patchFile);
    if (!info || !outputNamesPackage(failures, info.pkg)) continue;
    if (installedVersion(projectRoot, info.pkg) === info.version) {
      return { pkg: info.pkg, installed: info.version, patchFile, patched: info.version };
    }
  }
  return undefined;
}

/** Message for a bundled patch over a package that is already patched differently (an upgrade from alpha.2). */
export function stalePatchedMessage(d: PatchFailureDetails): string {
  const tail = d.output.trimEnd().split("\n").slice(-40).join("\n");
  return [
    `rn-xtool could not apply its patch to ${d.pkg}@${d.installed} (patch file: ${d.patchFile}): node_modules/${d.pkg} is ` +
      "the version the patch is for, but its files match neither the original package nor the patched one.",
    "This usually means an earlier rn-xtool release (such as 0.1.0-alpha.2) patched it differently, or its files were " +
      "edited by hand.",
    `Reinstall the package, then build again: rm -rf node_modules/${d.pkg} && npm install`,
    "--- patch-package output ---",
    tail,
  ].join("\n");
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

/**
 * The package directory a patch file is for, read the way patch-package reads it: `<pkg>+<version>[+<seq>[+<name>]]`,
 * `.dev` before `.patch`, a scope as `@scope+name`, and a nested package as `<parent>++<child>`. `file` is relative to
 * `patches/`, and its folders are part of the name, as patch-package 8 parses the whole relative path:
 * `@scope/name+1.0.0.patch` is for `@scope/name`. Undefined for a name patch-package does not take as a patch (it warns
 * about those itself).
 */
function patchTarget(file: string): { pkg: string; dir: string } | undefined {
  const parts = file
    .split(path.sep)
    .join("/")
    .replace(/(\.dev)?\.patch$/, "")
    .split("++")
    .map((part) => {
      const tokens = part.split("+").map((t) => t.trim()).filter(Boolean);
      const at = tokens.findIndex((t) => /^\d+\.\d+\.\d+/.test(t));
      const names = at < 0 ? tokens.slice(0, 2) : tokens.slice(0, at);
      return { name: names.length === 1 || names.length === 2 ? names.join("/") : undefined, versioned: at >= 0 };
    });
  if (parts.some((p) => p.name === undefined) || parts.at(-1)?.versioned !== true) return undefined;
  const names = parts.map((p) => p.name!);
  return { pkg: names.join(" => "), dir: path.join("node_modules", names.join("/node_modules/")) };
}

/** The project's `patches/**\/*.patch`, relative to `patches/`, sorted (patch-package reads subfolders too). */
function projectPatchFiles(projectRoot: string): string[] {
  const dir = path.join(projectRoot, "patches");
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".patch"))
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The project's patches whose package has no `node_modules/<pkg>/package.json`, the condition patch-package fails on
 * (left after `npm uninstall`). `file` is relative to `patches/`. A package installed at another version is not one.
 */
export function orphanPatches(projectRoot: string): { file: string; pkg: string }[] {
  return projectPatchFiles(projectRoot).flatMap((file) => {
    const target = patchTarget(file);
    if (target === undefined || existsSync(path.join(projectRoot, target.dir, "package.json"))) return [];
    return [{ file, pkg: target.pkg }];
  });
}

export function orphanPatchLine(o: { file: string; pkg: string }): string {
  return `⚠ patches/${o.file} is for ${o.pkg}, which is not installed; skipped. Delete it if you removed the library.`;
}

/** rn-xtool's scaffold marker; `expo-xtool-scaffold-revision` is its name before the rename (pre-release apps). */
const SCAFFOLD_MARKER_RE = /(?:rn|expo)-xtool-scaffold-revision/;
const SLOT_LABEL_RE = /^\+\/\/ Cache slot: (\S+)\/dual-flavor\s*$/m;
const REVISION_RE = /^\+\/\/ (?:rn|expo)-xtool-scaffold-revision: (\d+)\s*$/m;

/** The scaffolder's RN_XTOOL_SCAFFOLD_REVISION (patches/react-native+0.88.{0,1}.patch and vendor/rn-spm). */
export const SCAFFOLD_REVISION = 8;

const PATCH_PODS_RE = /^\+\/\/ rn-xtool-pods: (.*?)\s*$/m;
const MANIFEST_PODS_RE = /^\/\/ rn-xtool-pods: (.*?)\s*$/m;

/** The `pod=exact` pairs of an rn-xtool-pods line; empty without one. */
function recordedPins(line: string | undefined): Map<string, string> {
  const pins = new Map<string, string>();
  for (const pair of (line ?? "").split(",")) {
    const [pod, exact] = pair.trim().split("=");
    if (pod && exact) pins.set(pod, exact);
  }
  return pins;
}

interface PinChange {
  pod: string;
  /** A binary pod the scaffold does not record as `<pod>=binary`. */
  binary?: true;
  /** A pod the scaffold records as `<pod>=binary` that the table maps to a SwiftPM package now. */
  mapped?: true;
  /** The version the scaffold pins; undefined when it does not pin the pod. */
  pinned?: string;
  now: string;
  source: PodSource;
}

/**
 * How a scaffold's recorded pins differ from `table`: a recorded pod the table pins at another version, then each pod
 * the library's podspec maps (`expected`) that the scaffold does not pin. Pods the table no longer names are left out.
 * Compared per pod, so the line's order does not matter.
 */
function pinChanges(recorded: Map<string, string>, expected: readonly string[], table: PodTable): PinChange[] {
  const changes: PinChange[] = [];
  for (const [pod, pinned] of recorded) {
    // `<pod>=binary` records a binary pod, whose versions live in the lock: never a version. One the table maps now
    // links a pod-binaries package that is no longer staged.
    if (pinned === BINARY_PIN) {
      const entry = table.pods[pod];
      if (table.binary?.[pod] === undefined && entry !== undefined) {
        changes.push({ pod, mapped: true, pinned, now: entry.exact, source: table.source[pod]! });
      }
      continue;
    }
    const now = table.pods[pod]?.exact;
    if (now !== undefined && now !== pinned) changes.push({ pod, pinned, now, source: table.source[pod]! });
  }
  for (const pod of expected) {
    const now = table.pods[pod]?.exact;
    if (now !== undefined && !recorded.has(pod)) changes.push({ pod, now, source: table.source[pod]! });
    if (table.binary?.[pod] !== undefined && recorded.get(pod) !== BINARY_PIN) {
      changes.push({ pod, binary: true, now: BINARY_PIN, source: "rn-xtool" });
    }
  }
  return changes;
}

/** What the rn-xtool-pods line records for a binary pod (scaffolder fix 27). */
const BINARY_PIN = "binary";
/** Why a scaffold does not link a binary pod, after `patches/<name> ` or `node_modules/<pkg>/Package.swift `. */
const notLinked = (pod: string): string => `does not link ${pod}'s CocoaPods binaries`;

/** Why a binary-route scaffold is stale: `links GoogleMLKit's CocoaPods binaries, but the config maps …`. */
const mappedNow = (c: PinChange): string =>
  `links ${c.pod}'s CocoaPods binaries, but ${c.source === "config" ? "the config" : "rn-xtool's table"} maps ${c.pod} to a SwiftPM package now`;

/** "the config says 3.1.0", "rn-xtool's table says 3.0.0" */
const says = (c: PinChange): string => `${c.source === "config" ? "the config" : "rn-xtool's table"} says ${c.now}`;

type ScaffoldPatchFinding = { kind: "slot" | "revision" | "pins"; line: string };

function scaffoldPatchFindings(
  projectRoot: string,
  table: PodTable | undefined,
  exclude: readonly string[],
  kind: ProjectKind | undefined,
): ScaffoldPatchFinding[] {
  const installed = installedVersion(projectRoot, "react-native");
  const dir = path.join(projectRoot, "patches");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".patch")).sort();
  } catch {
    return [];
  }
  // An orphan gets orphanPatchLine instead: it is not applied at all.
  const orphans = new Set(orphanPatches(projectRoot).map((o) => o.file));
  names = names.filter((n) => !orphans.has(n));
  let expected: Map<string, string[]> | undefined;
  const findings: ScaffoldPatchFinding[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!SCAFFOLD_MARKER_RE.test(text)) continue;
    const pkg = parsePatchFileName(name)?.pkg;
    // The config leaves it out: rn-xtool never scaffolds it again, and the patch that stays applied is harmless.
    if (pkg !== undefined && exclude.includes(pkg)) continue;
    const reinstall = pkg === undefined ? "the library" : `node_modules/${pkg}`;
    const tail = `(also remove ${reinstall} and reinstall: that copy still has the old Package.swift)`;
    const slot = SLOT_LABEL_RE.exec(text)?.[1];
    if (installed !== undefined && slot !== undefined && slot !== installed) {
      findings.push({
        kind: "slot",
        line: `⚠ patches/${name} was scaffolded for React Native ${slot}; delete it so rn-xtool regenerates it for ${installed} ${tail}`,
      });
      continue;
    }
    const revision = REVISION_RE.exec(text)?.[1];
    if (revision !== undefined && Number(revision) < SCAFFOLD_REVISION) {
      findings.push({
        kind: "revision",
        line:
          `⚠ patches/${name} was written by an older rn-xtool scaffolder (revision ${revision}, now ${SCAFFOLD_REVISION}); ` +
          `delete it so rn-xtool regenerates it ${tail}`,
      });
      continue;
    }
    if (table === undefined) continue;
    expected ??= scaffoldedPods(projectRoot, table, { exclude, ...(kind !== undefined ? { kind } : {}) });
    const wanted = pkg === undefined ? [] : (expected.get(pkg) ?? []);
    for (const c of pinChanges(recordedPins(PATCH_PODS_RE.exec(text)?.[1]), wanted, table)) {
      findings.push({
        kind: "pins",
        line: c.mapped
          ? `⚠ patches/${name} ${mappedNow(c)}; delete it so rn-xtool regenerates it ${tail}`
          : c.binary
            ? `⚠ patches/${name} ${notLinked(c.pod)}: it was scaffolded before rn-xtool resolved them; delete it so rn-xtool ` +
              `regenerates it ${tail}`
            : c.pinned !== undefined
              ? `⚠ patches/${name} pins ${c.pod} ${c.pinned}, ${says(c)}; delete it so rn-xtool regenerates it ${tail}`
              : `⚠ patches/${name} does not pin ${c.pod}, ${says(c)}: it was scaffolded without rn-xtool's pod table (not ` +
                `through rn-xtool build); delete it so rn-xtool regenerates it ${tail}`,
      });
    }
  }
  return findings;
}

/**
 * Warnings for the project's persisted scaffold patches (`patches/*.patch` with rn-xtool's scaffold marker): their
 * Package.swift is only regenerated when the manifest is missing, so one is stale when its cache-slot label names
 * another React Native version than the installed one, when an older scaffolder revision wrote it, or (with `table`)
 * when its `rn-xtool-pods` line pins a pod at another version than the table, or leaves out a pod the library's
 * podspec maps. One line per patch for the slot (which wins) or the revision, else one per pod. Patches of the
 * packages the config's `exclude` lists get none: rn-xtool does not scaffold them again. `kind` decides which packages
 * autolinking links, as in the early checks (`scaffoldedPods`).
 */
export function scaffoldPatchWarnings(
  projectRoot: string,
  table?: PodTable,
  exclude: readonly string[] = [],
  kind?: ProjectKind,
): string[] {
  return scaffoldPatchFindings(projectRoot, table, exclude, kind).map((f) => f.line);
}

/** `scaffoldPatchWarnings`' pin lines alone, for `doctor --project`. */
export function scaffoldPinWarnings(
  projectRoot: string,
  table: PodTable,
  exclude: readonly string[] = [],
  kind?: ProjectKind,
): string[] {
  return scaffoldPatchFindings(projectRoot, table, exclude, kind)
    .filter((f) => f.kind === "pins")
    .map((f) => f.line);
}

/**
 * The "overrides" remedy when `pkg` is an Expo package of a project on a floor SDK (57, 58): the SDK's verified
 * expo-modules-* versions, plus `pkg` at its floor (else at the patch's version) when it is not one of them, and
 * whether the project lists `pkg` directly. Undefined for react-native and for other SDKs.
 */
function floorRemedy(projectRoot: string, pkg: string, patched: string): { overrides: Record<string, string>; direct: boolean } | undefined {
  if (pkg === "react-native") return undefined;
  const sdk = Number(/^(\d+)\./.exec(installedVersion(projectRoot, "expo") ?? "")?.[1]);
  const pins = expoPinsFor(sdk);
  if (expoPinPolicyFor(sdk) !== "floor" || pins === undefined) return undefined;
  const overrides: Record<string, string> = Object.fromEntries(
    Object.entries(pins).filter(([name]) => name.startsWith("expo-modules-")),
  );
  overrides[pkg] ??= (pins as Record<string, string | undefined>)[pkg] ?? patched;
  let declared: Record<string, unknown> = {};
  try {
    const app = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    declared = { ...app?.dependencies, ...app?.devDependencies };
  } catch {
    // no readable package.json: the note about a direct dependency is left out
  }
  return { overrides, direct: Object.hasOwn(declared, pkg) };
}

/** Every file the scaffolder generates carries this (SCAFFOLDER_BANNER in vendor/rn-spm/spm/scaffold-package-swift.js). */
const SCAFFOLDER_BANNER = "AUTO-SCAFFOLDED by react-native spm scaffold";
const MANIFEST_REVISION_RE = /^\/\/ (?:rn|expo)-xtool-scaffold-revision: (\d+)\s*$/m;
const MANIFEST_SLOT_RE = /^\/\/ Cache slot: (\S+)\/dual-flavor\s*$/m;

/** A patch's file entries: the path it writes (`b/…`), whether it creates the file, and whether the file is generated. */
function patchEntries(text: string): { rel: string; created: boolean; scaffolded: boolean }[] {
  return text
    .split(/^(?=diff --git )/m)
    .filter((entry) => entry.startsWith("diff --git "))
    .map((entry) => ({
      rel: /^diff --git a\/\S+ b\/(\S+)/.exec(entry)?.[1] ?? "",
      created: /\nnew file mode /.test(entry),
      scaffolded: entry.includes(SCAFFOLDER_BANNER),
    }));
}

/** `revision 1 for React Native 0.88.0` */
const marks = (revision: number, slot: string | undefined) =>
  `revision ${revision}${slot === undefined ? "" : ` for React Native ${slot}`}`;

/**
 * Before the project's patches apply: rn-xtool owns the scaffolded `node_modules/<pkg>/Package.swift`, and RN only
 * scaffolds a missing one, so an older copy would build as is. With a current persisted patch (no warning for it) and
 * an older copy (lower revision, the pre-rename marker, or another cache slot), the patch's new files are removed so
 * patch-package writes them again (it passes a new-file patch over an existing file). That happens only when every
 * entry of the patch is a new scaffolded file: a patch that also changes the library's own files (`patch-package
 * <name>` folds the user's fix in) would then apply neither way, so the copy is kept and a `⚠` line names the
 * reinstall. Without any persisted patch, a copy rn-xtool's scaffolder wrote at an older revision or for another
 * React Native, or (with `table`) one whose `rn-xtool-pods` line differs from the table's pins for the library's mapped
 * pods, is removed, so the rn-spm step scaffolds and persists it again. Copies without rn-xtool's marker,
 * packages linked from outside the project, and packages whose persisted patch is stale (warned about) are left alone.
 * Returns the `ℹ` lines for the replaced copies, which the caller logs once patch-package has written them.
 */
export async function refreshStaleScaffolds(
  projectRoot: string,
  log: (line: string) => void,
  table?: PodTable,
  exclude: readonly string[] = [],
  kind?: ProjectKind,
): Promise<string[]> {
  const installedRn = installedVersion(projectRoot, "react-native");
  const patchesDir = path.join(projectRoot, "patches");
  let patchNames: string[] = [];
  try {
    patchNames = readdirSync(patchesDir).filter((n) => n.endsWith(".patch")).sort();
  } catch {
    // no patches/
  }
  const persisted = new Map<string, { name: string; text: string }[]>();
  for (const name of patchNames) {
    const pkg = parsePatchFileName(name)?.pkg;
    if (pkg === undefined) continue;
    let text = "";
    try {
      text = readFileSync(path.join(patchesDir, name), "utf8");
    } catch {
      // unreadable: patch-package reports it
    }
    persisted.set(pkg, [...(persisted.get(pkg) ?? []), { name, text }]);
  }
  const replaced: string[] = [];
  let expected: Map<string, string[]> | undefined;
  const found = await packagesWithManifest(projectRoot);
  if (found.length === 0) return replaced;
  const realModules = await realpath(path.join(projectRoot, "node_modules"));
  for (const { pkg, dir } of found) {
    // The config leaves it out: the rn-spm step would not scaffold it again.
    if (exclude.includes(pkg)) continue;
    if (outside(realModules, await realpath(dir))) continue;
    const manifest = await readFile(path.join(dir, "Package.swift"), "utf8").catch(() => "");
    if (!manifest.includes(SCAFFOLDER_BANNER)) continue;
    const revisionLine = MANIFEST_REVISION_RE.exec(manifest)?.[1];
    const revision = Number(revisionLine ?? 0);
    const slot = MANIFEST_SLOT_RE.exec(manifest)?.[1];
    const patches = persisted.get(pkg);
    const shown = `node_modules/${pkg}/Package.swift`;
    if (patches === undefined) {
      // Only what rn-xtool's scaffolder provably wrote: a library may ship the upstream scaffolder's output itself.
      if (revisionLine === undefined) continue;
      let why: string | undefined;
      if (installedRn !== undefined && slot !== undefined && slot !== installedRn) {
        why = `was scaffolded for React Native ${slot}, not ${installedRn}`;
      } else if (revision < SCAFFOLD_REVISION) {
        why = `was scaffolded by an older rn-xtool scaffolder (revision ${revision}, now ${SCAFFOLD_REVISION})`;
      } else if (table !== undefined) {
        expected ??= scaffoldedPods(projectRoot, table, { exclude, ...(kind !== undefined ? { kind } : {}) });
        const [c] = pinChanges(recordedPins(MANIFEST_PODS_RE.exec(manifest)?.[1]), expected.get(pkg) ?? [], table);
        if (c !== undefined) {
          why = c.mapped
            ? mappedNow(c)
            : c.binary
              ? notLinked(c.pod)
              : c.pinned !== undefined
                ? `pins ${c.pod} ${c.pinned}, not ${c.now}`
                : `does not pin ${c.pod}, ${says(c)}`;
        }
      }
      if (why === undefined) continue;
      await rm(path.join(dir, "Package.swift"), { force: true });
      log(`ℹ ${shown} ${why}: rn-xtool removed it so the rn-spm step scaffolds it again`);
      continue;
    }
    // The patch that writes this Package.swift, when it is current (a stale one gets scaffoldPatchWarnings' line).
    const patch = patches.find((p) => p.text.includes(`+++ b/node_modules/${pkg}/Package.swift`));
    if (patch === undefined || !SCAFFOLD_MARKER_RE.test(patch.text)) continue;
    const patchRevision = Number(REVISION_RE.exec(patch.text)?.[1] ?? 0);
    const patchSlot = SLOT_LABEL_RE.exec(patch.text)?.[1];
    if (patchRevision < SCAFFOLD_REVISION || (installedRn !== undefined && patchSlot !== undefined && patchSlot !== installedRn)) {
      continue;
    }
    if (revision >= patchRevision && (patchSlot === undefined || slot === patchSlot)) continue;
    const older =
      `${shown} was scaffolded with ${marks(revision, slot)}, older than patches/${patch.name} ` +
      `(revision ${patchRevision}${patchSlot === undefined ? "" : `, React Native ${patchSlot}`})`;
    const prefix = `node_modules/${pkg}/`;
    const entries = patchEntries(patch.text);
    const onlyScaffold = entries.every(
      (e) => e.created && e.scaffolded && e.rel.startsWith(prefix) && !e.rel.split("/").includes(".."),
    );
    if (!onlyScaffold) {
      log(
        `⚠ ${older}, and that patch also changes the library's own files, so rn-xtool does not replace it: ` +
          `run rm -rf node_modules/${pkg} && npm install, then build again`,
      );
      continue;
    }
    let removed = 0;
    for (const { rel } of entries) {
      const file = path.join(projectRoot, rel);
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (!text?.includes(SCAFFOLDER_BANNER)) continue;
      await rm(file, { force: true });
      removed++;
    }
    if (removed > 0) replaced.push(`ℹ ${older}: rn-xtool replaced it with the persisted one`);
  }
  return replaced;
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
 * With the vendored Expo plugin (SDK 57) only bundled patches of the installed release line are staged.
 * The order does not matter: the project's patches only hold library Package.swift files.
 */
export async function applyPatches(
  projectRoot: string,
  exec: PatchExec = execPatchPackage,
  opts: {
    rnScripts: RnScripts;
    expoPlugin?: ExpoPlugin;
    podTable?: PodTable;
    /** The config's exclude: their scaffolds are neither regenerated nor warned about. */
    exclude?: readonly string[];
    /** The project kind: which packages autolinking links when the expected pod pins are read. */
    kind?: ProjectKind;
    log?: (line: string) => void;
  } = {
    rnScripts: "installed",
  },
): Promise<void> {
  if (opts.rnScripts === "installed") {
    const bundledDir = path.join(packageRoot(), "patches");
    const m = rnPatchMismatch(projectRoot, bundledDir);
    if (m) {
      const output =
        `patch-package was not run: react-native ${m.installed} is installed and the bundled react-native patches are ` +
        `for ${bundledVersionList(bundledDir, "react-native")}.`;
      throw new Error(patchFailureMessage({ ...m, output }));
    }
  }
  const patchesDir = projectPaths(projectRoot).patchesDir;
  const staged = await stageBundledPatches(projectRoot, patchesDir, { lineOnly: opts.expoPlugin === "vendored" });
  if (staged.length > 0) {
    const [cmd, args] = applyPatchesArgv(projectRoot, patchesDir);
    const r = await exec(cmd, args, projectRoot);
    const output = r.all ?? `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0 || r.failed || patchPackageOutputFailed(output)) {
      // Only what was staged: a bundled patch that was left out is not the one that failed. A failed package at the
      // patch's own version comes first: another package at a newer version may have taken its patch fine.
      const stale = findStalePatchedPackage(projectRoot, patchesDir, output);
      if (stale) throw new Error(stalePatchedMessage({ ...stale, output }));
      const mismatch = findPatchMismatch(projectRoot, patchesDir, output);
      if (mismatch) {
        throw new Error(patchFailureMessage({ ...mismatch, output }, { floor: floorRemedy(projectRoot, mismatch.pkg, mismatch.patched) }));
      }
      throw new Error(genericPatchFailureMessage(r, output));
    }
  }
  const log = opts.log ?? ((line: string) => console.log(line));
  const replaced = await refreshStaleScaffolds(projectRoot, log, opts.podTable, opts.exclude, opts.kind);
  if (!hasProjectPatches(projectRoot)) return;
  const orphans = orphanPatches(projectRoot);
  for (const orphan of orphans) log(orphanPatchLine(orphan));
  for (const warning of scaffoldPatchWarnings(projectRoot, opts.podTable, opts.exclude, opts.kind)) log(warning);
  let [pcmd, pargs] = projectPatchesArgv();
  const staging = projectPaths(projectRoot).projectPatchesDir;
  await rm(staging, { recursive: true, force: true });
  if (orphans.length > 0) {
    // patch-package stops on a patch whose package is missing: it gets the others, staged without the orphans.
    const left = new Set(orphans.map((o) => o.file));
    const kept = projectPatchFiles(projectRoot).filter((file) => !left.has(file));
    if (kept.length === 0) {
      for (const line of replaced) log(line);
      return;
    }
    for (const file of kept) {
      await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await copyFile(path.join(projectRoot, "patches", file), path.join(staging, file));
    }
    [pcmd, pargs] = applyPatchesArgv(projectRoot, staging);
  }
  const pr = await exec(pcmd, pargs, projectRoot);
  let poutput = pr.all ?? `${pr.stdout}\n${pr.stderr}`;
  if (pr.exitCode === 0 && !pr.failed && !patchPackageOutputFailed(poutput)) {
    for (const line of replaced) log(line);
    return;
  }
  if (orphans.length > 0) {
    // The staged copy is rebuilt on every run: name the patch the user keeps, under patches/.
    poutput = poutput
      .split(`${staging}${path.sep}`)
      .join(`${path.join(projectRoot, "patches")}${path.sep}`)
      .split(`${path.relative(projectRoot, staging)}${path.sep}`)
      .join(`patches${path.sep}`);
  }
  throw new Error(`Applying the project's patches/ failed.\n${genericPatchFailureMessage(pr, poutput)}`);
}
