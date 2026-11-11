import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig, modifyConfigAsync } from "@expo/config";
import { IOSConfig } from "@expo/config-plugins";
import { createRequire } from "node:module";
import type { BuildVars } from "../plist.js";
import { vendoredExpoPlugin } from "../pipeline/rnSpm.js";
import {
  checkPins,
  compareVersions,
  expoPinsFor,
  expoPluginFor,
  supportedExpoList,
  type ExpoPinName,
  type PinCheck,
} from "../versions.js";
import { VersionGateError } from "./detect.js";
import type { ProjectInfo, ProjectKind, ReadProjectOptions } from "./types.js";

/** The working sequence for moving a template app's React Native (one `npm install react-native@…` hits ERESOLVE). */
export const RN_UPGRADE_DOCS =
  "https://github.com/WillyAntunez/react-native-xtool/blob/main/docs/bare-react-native.md#upgrading-react-native";

/** True when `pkg` resolves from the project root (Node's lookup: root/node_modules, then the parents'). */
export function resolvesFromRoot(root: string, pkg: string): boolean {
  try {
    createRequire(path.join(root, "noop.js")).resolve(`${pkg}/package.json`, { paths: [root] });
    return true;
  } catch {
    return false;
  }
}

/** True when `pkg` resolves from the project root or from the `expo` package directory (npm may nest it there). */
export function isInstalled(root: string, pkg: string): boolean {
  if (resolvesFromRoot(root, pkg)) return true;
  const req = createRequire(path.join(root, "noop.js"));
  try {
    const expoDir = path.dirname(req.resolve("expo/package.json", { paths: [root] }));
    req.resolve(`${pkg}/package.json`, { paths: [expoDir] });
    return true;
  } catch {
    return false;
  }
}

/** The directory `pkg` resolves to from `from`, through `createRequire(<from>/package.json)` (symlinks resolved). */
function packageDirFrom(from: string, pkg: string): string | undefined {
  try {
    return path.dirname(createRequire(path.join(from, "package.json")).resolve(`${pkg}/package.json`));
  } catch {
    return undefined;
  }
}

/**
 * Where the build resolves a pinned Expo package: expo and react-native from the root; expo-modules-core from expo;
 * expo-file-system and expo-font where autolinking links them (`autolinked`, the answer of `autolinkedModuleDirs`;
 * without one, `linkedExpoDependencyDir`'s rule); expo-modules-jsi from core; expo-modules-autolinking from the root
 * and else from expo (npx's order).
 * The one copy of this chain: the gate and the JSI build use it.
 */
export function expoPackageDir(
  root: string,
  pkg: ExpoPinName,
  autolinked?: ReadonlyMap<string, string>,
): string | undefined {
  const from = (parent: ExpoPinName): string | undefined => {
    const dir = expoPackageDir(root, parent);
    return dir === undefined ? undefined : packageDirFrom(dir, pkg);
  };
  switch (pkg) {
    case "expo":
    case "react-native":
      return packageDirFrom(root, pkg);
    case "expo-modules-autolinking":
      return packageDirFrom(root, pkg) ?? from("expo");
    case "expo-modules-core":
      return from("expo");
    case "expo-file-system":
    case "expo-font":
      return autolinked !== undefined ? autolinked.get(pkg) : linkedExpoDependencyDir(root, pkg, from("expo"));
    case "expo-modules-jsi":
      return from("expo-modules-core");
  }
}

/** The pins whose copy is the one expo-modules-autolinking links, not one Node resolves. */
const AUTOLINKED_PINS: readonly ExpoPinName[] = ["expo-file-system", "expo-font"];

/**
 * The expo-modules-autolinking CLI the build's Expo plugin runs (its cli.js resolves it from its own folder): for the
 * vendored plugin (SDK 56, 57) rn-xtool's copy; for the installed one the copy expo's `scripts/spm` (where expo's
 * react-native.config.js declares the plugin) resolves. Undefined when it cannot be found.
 */
function autolinkingCli(root: string, sdk: number): string | undefined {
  const expoDir = expoPluginFor(sdk) === "vendored" ? undefined : expoPackageDir(root, "expo");
  const pluginDir =
    expoPluginFor(sdk) === "vendored" ? path.dirname(vendoredExpoPlugin()) : expoDir && path.join(expoDir, "scripts", "spm");
  if (pluginDir === undefined) return undefined;
  try {
    return createRequire(path.join(pluginDir, "noop.js")).resolve("expo-modules-autolinking/bin/expo-modules-autolinking.js", {
      paths: [pluginDir],
    });
  } catch {
    return undefined;
  }
}

/** The nearest folder at or above `dir` that holds a package.json (the plugin's findModuleRoot); `dir` when none. */
function moduleRootOf(dir: string): string {
  for (let at = dir; path.dirname(at) !== at; at = path.dirname(at)) {
    if (existsSync(path.join(at, "package.json"))) return at;
  }
  return dir;
}

/**
 * The package folder of each Expo module the build links for Apple, asked of the build's own autolinking: the plugin's
 * `resolve --platform apple --json` (vendor/expo-spm/spm/cli.js), run the same way (from the root, no options:
 * autolinking reads searchPaths, nativeModulesDir and exclude from the app's package.json itself). A module's folder is
 * the one above its podspec that holds a package.json, as the plugin finds it. Undefined when the CLI cannot run (not
 * found, a non-zero exit, no answer within a minute, output that is not its JSON): the caller then falls back to
 * `linkedExpoDependencyDir`'s rule, and the build's own autolinking step reports the failure.
 */
function autolinkedModuleDirs(root: string, sdk: number): ReadonlyMap<string, string> | undefined {
  const cli = autolinkingCli(root, sdk);
  if (cli === undefined) return undefined;
  const run = spawnSync(process.execPath, [cli, "resolve", "--platform", "apple", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (run.error !== undefined || run.status !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
  // Older CLIs print the bare module list.
  const modules: unknown = Array.isArray(parsed) ? parsed : (parsed as { modules?: unknown } | null)?.modules;
  if (!Array.isArray(modules)) return undefined;
  const dirs = new Map<string, string>();
  for (const module of modules as { packageName?: unknown; pods?: { podspecDir?: unknown }[] }[]) {
    const podspecDir = module?.pods?.[0]?.podspecDir;
    if (typeof module?.packageName === "string" && typeof podspecDir === "string") {
      dirs.set(module.packageName, moduleRootOf(podspecDir));
    }
  }
  return dirs;
}

/** The names a package.json makes autolinking follow: dependencies, non-optional peers, and at the root devDependencies. */
function followedDependencies(pkg: Record<string, any> | undefined, isRoot: boolean): string[] {
  const peers = Object.keys(pkg?.peerDependencies ?? {}).filter((name) => pkg?.peerDependenciesMeta?.[name]?.optional !== true);
  return [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...(isRoot ? Object.keys(pkg?.devDependencies ?? {}) : []),
    ...peers,
  ];
}

/**
 * The fallback rule for the copy of `pkg` (a dependency of expo) autolinking links, used when its CLI cannot run.
 * Autolinking keeps the copy it reaches shallowest in the dependency tree and, on a tie, the one with fewer
 * `node_modules` in its path; the rule weighs two copies only. Expo's copy (`viaExpo`) is reached at depth 1. The copy
 * the root resolves wins over it when it differs and the app lists `pkg` itself (depth 0), or a package the app lists
 * depends on `pkg` and resolves that same copy (depth 1, shorter path). Other copies (a local library's own, one
 * nested under another dependency, one searchPaths scans) and autolinking's default exclusions are not modelled.
 */
function linkedExpoDependencyDir(root: string, pkg: ExpoPinName, viaExpo: string | undefined): string | undefined {
  const top = packageDirFrom(root, pkg);
  if (top === undefined || top === viaExpo) return viaExpo;
  const appDeps = followedDependencies(packageJsonAt(root), true);
  if (appDeps.includes(pkg)) return top;
  const reached = appDeps.some((name) => {
    const dir = packageDirFrom(root, name);
    return dir !== undefined && followedDependencies(packageJsonAt(dir), false).includes(pkg) && packageDirFrom(dir, pkg) === top;
  });
  return reached ? top : viaExpo;
}

function packageJsonAt(dir: string | undefined): Record<string, any> | undefined {
  if (dir === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

function versionAt(dir: string | undefined): string | undefined {
  const version = packageJsonAt(dir)?.version;
  return typeof version === "string" ? version : undefined;
}

const isObject = (x: unknown): x is Record<string, unknown> => x != null && typeof x === "object";

/**
 * The package names the app's package.json tells expo-modules-autolinking to leave out for Apple, read as autolinking
 * reads them (`parsePackageJsonOptions` in its commands/autolinkingOptions.js, the same in 56.0.24, 58.0.15 and
 * 58.0.16): `expo.autolinking.apple`, else `expo.autolinking.ios`, when it is an object, is spread over
 * `expo.autolinking`, so its `exclude` replaces the top-level one; the strings of the resulting `exclude` list.
 * The package.json is the first one at or above `root`, as the CLI run from the root finds it.
 */
function autolinkingExclusions(root: string): ReadonlySet<string> {
  let pkg: Record<string, any> | undefined;
  for (let dir = root; pkg === undefined && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) pkg = packageJsonAt(dir) ?? {};
  }
  const autolinking = isObject(pkg?.expo) && isObject(pkg.expo.autolinking) ? pkg.expo.autolinking : null;
  const platform = isObject(autolinking?.apple) ? autolinking.apple : isObject(autolinking?.ios) ? autolinking.ios : null;
  const exclude: unknown = { ...autolinking, ...platform }.exclude;
  return new Set(Array.isArray(exclude) ? exclude.filter((x): x is string => typeof x === "string") : []);
}

/**
 * The installed version of each package the SDK pins, read where the build resolves it (undefined: not installed, or
 * for expo-file-system and expo-font not linked by autolinking); `{}` when the SDK pins nothing. Of the autolinked
 * pins autolinking's CLI left out of its answer although a copy is installed (by `linkedExpoDependencyDir`'s rule):
 * `unlinked`, those the app excludes (`autolinkingExclusions`), which the build does not link, so their precompiled
 * framework is never embedded and the gate has nothing to check; `notLinked`, the others, with their copy's folder:
 * autolinking leaves them out for another reason (no expo-module.config.json, or one that names no Apple platform),
 * and the app would build and then fail at launch.
 */
function readPins(
  root: string,
  sdk: number,
): {
  pins: Partial<Record<ExpoPinName, string | undefined>>;
  unlinked: ReadonlySet<ExpoPinName>;
  notLinked: ReadonlyMap<ExpoPinName, string>;
} {
  const names = Object.keys(expoPinsFor(sdk) ?? {}) as ExpoPinName[];
  const autolinked = names.some((name) => AUTOLINKED_PINS.includes(name)) ? autolinkedModuleDirs(root, sdk) : undefined;
  const pins = Object.fromEntries(names.map((name) => [name, versionAt(expoPackageDir(root, name, autolinked))]));
  const unlinked = new Set<ExpoPinName>();
  const notLinked = new Map<ExpoPinName, string>();
  if (autolinked !== undefined) {
    const expoDir = expoPackageDir(root, "expo");
    const excluded = autolinkingExclusions(root);
    for (const name of names.filter((n) => AUTOLINKED_PINS.includes(n) && !autolinked.has(n))) {
      const viaExpo = expoDir === undefined ? undefined : packageDirFrom(expoDir, name);
      const copy = linkedExpoDependencyDir(root, name, viaExpo);
      if (versionAt(copy) === undefined) continue;
      if (excluded.has(name)) unlinked.add(name);
      else notLinked.set(name, copy!);
    }
  }
  return { pins, unlinked, notLinked };
}

/** An installed pin autolinking does not link although the app does not exclude it: the app would fail at launch. */
function checkLinkedPins(root: string, notLinked: ReadonlyMap<ExpoPinName, string>): void {
  const [first] = notLinked;
  if (first === undefined) return;
  const [name, copy] = first;
  const where = path.relative(realpathSync(root), realpathSync(copy));
  throw new Error(
    `${name} is installed (${where}) but Expo's autolinking does not link it for iOS, and the app does not exclude it: ` +
      'the build would succeed and the app would fail at launch with "Cannot find native module". Autolinking leaves ' +
      "out a module without an expo-module.config.json or whose config names no Apple platform: reinstall it " +
      `(\`rm -rf ${where} && npm install\`), or, if the app does not use it, list it in expo.autolinking.exclude in package.json.`,
  );
}

/** {@link readPins}' versions: what the gate and the drift watch read. */
export function readExpoPins(root: string, sdk: number): Partial<Record<ExpoPinName, string | undefined>> {
  return readPins(root, sdk).pins;
}

/** The version of the expo installed at the root; undefined when expo is not installed. */
export function installedExpoVersion(root: string): string | undefined {
  return versionAt(expoPackageDir(root, "expo"));
}

/** The major version of the expo installed at the root (a hybrid app's SDK); undefined when expo is not installed. */
export function installedExpoMajor(root: string): number | undefined {
  return majorOf(installedExpoVersion(root));
}

/**
 * The error when expo-modules-macros has no Linux binary for the host (an `--omit=optional` install or another arch).
 * The copy is the one the Expo plugin uses (macroPluginTool in its plugin.js): the one the project's expo-modules-core
 * resolves (`root`), which must be installed on SDK 58; with `pluginDir` (the vendored plugin of SDK 56 and 57, whose
 * core depends on @expo/expo-modules-macros-plugin instead) the plugin falls back to the copy its own directory
 * resolves, rn-xtool's. Without `root`: rn-xtool's own copy. `resolve` replaces only the binary lookup.
 */
export function expoMacrosBinaryError(
  opts: { arch?: string; resolve?: (spec: string) => string; root?: string; pluginDir?: string } = {},
): string | undefined {
  const arch = opts.arch ?? process.arch;
  const binaryPackage = `@expo/modules-macros-linux-${arch}`;
  const binary = `${binaryPackage}/ExpoModulesMacros`;
  const resolvesFrom = (macrosDir: string) => (spec: string) => createRequire(path.join(macrosDir, "package.json")).resolve(spec);
  const coreDir = opts.root === undefined ? undefined : expoPackageDir(opts.root, "expo-modules-core");
  const macrosDir = coreDir === undefined ? undefined : packageDirFrom(coreDir, "expo-modules-macros");
  if (opts.root === undefined || (macrosDir === undefined && opts.pluginDir !== undefined)) {
    try {
      const ownDir =
        opts.pluginDir === undefined
          ? path.dirname(createRequire(import.meta.url).resolve("expo-modules-macros/package.json"))
          : packageDirFrom(opts.pluginDir, "expo-modules-macros");
      if (opts.resolve === undefined && ownDir === undefined) throw new Error("expo-modules-macros is not installed");
      (opts.resolve ?? resolvesFrom(ownDir!))(binary);
      return undefined;
    } catch {
      return `expo-modules-macros 0.22.0 has no Linux binary for ${arch} (${binaryPackage}); reinstall react-native-xtool without --omit=optional.`;
    }
  }
  const coreVersion = versionAt(coreDir) ?? "(not installed)";
  if (macrosDir === undefined) {
    return `expo-modules-macros is not installed next to expo-modules-core ${coreVersion}, which depends on it; run \`npx expo install --fix\` and reinstall.`;
  }
  try {
    (opts.resolve ?? resolvesFrom(macrosDir))(binary);
    return undefined;
  } catch {
    const macros = packageJsonAt(macrosDir);
    const prefix = `expo-modules-macros ${versionAt(macrosDir) ?? "unknown"} (from expo-modules-core ${coreVersion})`;
    const wanted = macros?.optionalDependencies?.[binaryPackage];
    if (typeof wanted !== "string") {
      return `${prefix} ships no Linux binary for ${arch} (it lists no ${binaryPackage}); Expo publishes one for x64 and arm64.`;
    }
    // `npm install` adds an optional package the lockfile lacks; `npm ci` installs only what the lockfile lists.
    return (
      `${prefix} has no Linux binary for ${arch}: ${binaryPackage} ${wanted} is not installed. Run ` +
      "`npm install --include=optional` and commit package-lock.json: `npm ci` installs only what the lockfile lists, and " +
      "a lockfile written on macOS can leave this package out (so does --omit=optional)."
    );
  }
}

/** "a, b and c" */
export function andList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const listOf = (checks: PinCheck[]): string => checks.map((c) => `${c.name} ${c.installed ?? "not installed"}`).join(", ");

/** expo-modules-* packages an app lists itself: a pin there makes npm nest the copy expo uses. */
const EXPO_MODULES_PINS = ["expo-modules-core", "expo-modules-jsi", "expo-modules-autolinking"] as const;

function declaredPins(root: string): string[] {
  const pkg = packageJsonAt(root);
  const declared = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return EXPO_MODULES_PINS.filter((name) => Object.hasOwn(declared, name));
}

/**
 * G1's floor remedy, in the order docs/bare-react-native.md gives: the pins out, expo, `--fix`, then react-native
 * (a hybrid moves it with the template's @react-native/* packages, as the docs describe).
 */
function floorRemedy(root: string, kind: ProjectKind, checks: PinCheck[], failed: PinCheck[]): string {
  const rn = checks.find((c) => c.name === "react-native")!;
  const expo = checks.find((c) => c.name === "expo")!;
  // `expo install --fix` takes react-native's version from Expo's versions API, which can differ from the version
  // expo itself bundles (SDK 58: 0.88.0 against 0.88.1), so react-native is always named with an explicit command.
  const rnStep =
    kind === "bare"
      ? `move react-native to ${rn.wanted} as ${RN_UPGRADE_DOCS} describes (\`npx expo install react-native@${rn.wanted}\` ` +
        "alone leaves the template's @react-native/* packages on the old version)"
      : `run \`npx expo install react-native@${rn.wanted}\``;
  if (failed.every((c) => c === rn)) return `${rnStep[0]!.toUpperCase()}${rnStep.slice(1)}.`;
  const pins = declaredPins(root);
  const unpin =
    pins.length > 0
      ? `Remove the ${andList(pins)} pin${pins.length > 1 ? "s" : ""} (\`npm uninstall ${pins.join(" ")}\`)`
      : "Remove any pin or override on these packages from package.json";
  const fix = failed.includes(expo)
    ? `\`npx expo install expo@~${expo.wanted}\` and \`npx expo install --fix\``
    : "`npx expo install --fix`";
  const why = kind === "bare" ? "" : ", since `--fix` alone can leave react-native on another version";
  return `${unpin}, then run ${fix}; then ${rnStep}${why}.`;
}

/**
 * G1: every pin installed, none below the floor or on another release line, and react-native exact. A pin in `unlinked`
 * (installed, not linked) is not checked.
 */
function checkExpoPinVersions(
  root: string,
  sdk: number,
  checks: PinCheck[],
  kind: ProjectKind,
  unlinked: ReadonlySet<ExpoPinName>,
): void {
  const failed = checks.filter(
    (c) => !unlinked.has(c.name) && (c.status === "missing" || c.status === "off" || c.status === "below"),
  );
  if (failed.length === 0) return;
  const rn = checks.find((c) => c.name === "react-native")!;
  const floors = andList(checks.filter((c) => c !== rn).map((c) => `${c.name} ${c.wanted}`));
  const newerRn =
    rn.installed !== undefined && compareVersions(rn.installed, rn.wanted) > 0
      ? ` React Native ${rn.installed} is newer than this rn-xtool release supports: pin react-native to ${rn.wanted}, or update rn-xtool.`
      : "";
  const remedy = floorRemedy(root, kind, checks, failed);
  throw new VersionGateError(
    `Expo SDK ${sdk} needs react-native ${rn.wanted} and at least ${floors}; installed: ${listOf(failed)}. ${remedy}${newerRn}`,
  );
}

/** G2: patch-package patches only node_modules/expo-modules-jsi; a nested copy would be built unpatched. */
function checkTopLevelJsi(root: string, checks: PinCheck[]): void {
  const jsiDir = expoPackageDir(root, "expo-modules-jsi")!;
  const topLevel = path.join(root, "node_modules", "expo-modules-jsi");
  if (existsSync(topLevel) && realpathSync(topLevel) === realpathSync(jsiDir)) return;
  const jsi = checks.find((c) => c.name === "expo-modules-jsi")!;
  const where =
    `expo-modules-jsi ${jsi.installed} resolves from ${path.relative(realpathSync(root), realpathSync(jsiDir))}, ` +
    "not from the project's top-level node_modules: rn-xtool patches and builds only the top-level copy.";
  // On the floor the user's own jsi pin is what nests the copy: core's range is what npm would install.
  const coreDir = expoPackageDir(root, "expo-modules-core");
  const range = packageJsonAt(coreDir)?.dependencies?.["expo-modules-jsi"];
  const needs = typeof range === "string" ? ` (expo-modules-core ${versionAt(coreDir)} needs ${range})` : "";
  // After the pin is gone npm keeps the one copy where package-lock.json put it (a reinstall, even without node_modules,
  // and `npm dedupe` leave it nested); `npm update` re-places it at the top level and changes nothing else.
  throw new Error(
    `${where} Remove any expo-modules-jsi pin or override from package.json${needs} (\`npm uninstall expo-modules-jsi\` ` +
      "removes a pin), then run `npm update expo-modules-jsi`: it moves the copy to the top level, which a reinstall does " +
      "not do while package-lock.json keeps it nested.",
  );
}

/**
 * The gate on an SDK's pinned packages (no-op when the SDK pins nothing), each step throwing: an installed
 * expo-file-system or expo-font that autolinking does not link and the app does not exclude; G1 the pins (but
 * expo-file-system or expo-font when installed and excluded, see {@link readPins}), G2 one
 * expo-modules-jsi (the top-level copy), G3 the macros Linux binary (of the copy the Expo plugin uses: core's, else,
 * for the vendored plugin, rn-xtool's). Then the packages newer than the verified set are reported through `log`.
 * `kind` "bare" (a hybrid app) changes only G1's react-native remedy.
 */
export function checkExpoPackages(
  root: string,
  sdk: number,
  log?: (line: string) => void,
  opts: { kind?: ProjectKind } = {},
): void {
  const { pins, unlinked, notLinked } = readPins(root, sdk);
  const checks = checkPins(sdk, pins);
  if (checks === undefined) return;
  checkLinkedPins(root, notLinked);
  checkExpoPinVersions(root, sdk, checks, opts.kind ?? "expo", unlinked);
  checkTopLevelJsi(root, checks);
  const pluginDir = expoPluginFor(sdk) === "vendored" ? path.dirname(vendoredExpoPlugin()) : undefined;
  const macros = expoMacrosBinaryError({ root, pluginDir });
  if (macros) throw new Error(macros);
  const newer = checks.filter((c) => c.status === "newer");
  if (newer.length > 0) {
    log?.(
      `⚠ Newer than the Expo SDK ${sdk} set this rn-xtool release was verified with: ${listOf(newer)}. ` +
        `Verified: ${andList(checks.map((c) => `${c.name} ${c.wanted}`))}. The build continues; if it fails or the app ` +
        "crashes at launch, report it at https://github.com/WillyAntunez/react-native-xtool/issues.",
    );
  }
}

export async function installedRnVersion(root: string): Promise<string> {
  try {
    const file = createRequire(path.join(root, "noop.js")).resolve("react-native/package.json", { paths: [root] });
    return JSON.parse(await readFile(file, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function majorOf(version: string | undefined): number | undefined {
  const match = version?.replace(/^npm:[^@]*@/, "").match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

async function declaredExpoRange(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return pkg?.dependencies?.expo ?? pkg?.devDependencies?.expo;
  } catch {
    return undefined;
  }
}

/** The id `expo prebuild` would suggest: reverse-DNS, from the slug, only letters, digits and hyphens. */
export function defaultBundleIdentifier(slug: string): string {
  const name = slug
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `com.anonymous.${name || "app"}`;
}

/** Thrown in read-only mode (doctor) when the config has no `ios.bundleIdentifier`; `build` would write `suggestion`. */
export class MissingBundleIdentifierError extends Error {
  constructor(
    readonly suggestion: string,
    readonly configFile: string,
  ) {
    super(
      configFile === "project.pbxproj"
        ? // Bare projects have no expo config and are never written to.
          `PRODUCT_BUNDLE_IDENTIFIER is missing for the app target in the Xcode project (${configFile}). Set PRODUCT_BUNDLE_IDENTIFIER in the Xcode project, for example to "${suggestion}".`
        : `ios.bundleIdentifier is missing in ${configFile}. Add "ios": { "bundleIdentifier": "${suggestion}" } to the expo config, or run \`rn-xtool build\`, which writes that default into a static app.json.`,
    );
    this.name = "MissingBundleIdentifierError";
  }
}

/**
 * Resolves the bundle identifier, writing a default into a static `app.json` when it is missing.
 * The write goes through Expo's own `modifyConfigAsync`, so flat and `{ "expo": … }` layouts, JSON5
 * syntax and dynamic configs are handled the way `expo prebuild` does (a dynamic config is not written).
 */
async function resolveBundleIdentifier(
  root: string,
  config: ReturnType<typeof getConfig>,
  opts: ReadProjectOptions,
): Promise<string> {
  const { exp } = config;
  if (exp.ios?.bundleIdentifier) return exp.ios.bundleIdentifier;
  const suggestion = defaultBundleIdentifier(exp.slug);
  const configFile = path.basename(config.dynamicConfigPath ?? config.staticConfigPath ?? "app.json");
  if (opts.writeDefaults === false) throw new MissingBundleIdentifierError(suggestion, configFile);
  // Expo deep-merges the modification into the existing config (arrays are appended), so send only the new key.
  const result = await modifyConfigAsync(root, { ios: { bundleIdentifier: suggestion } }, { skipSDKVersionRequirement: true });
  if (result.type !== "success") {
    throw new Error(
      `ios.bundleIdentifier is missing in ${configFile} and rn-xtool could not write a default` +
        `${result.message ? ` (${result.message})` : ""}. Add "ios": { "bundleIdentifier": "${suggestion}" } to the expo config and run again.`,
    );
  }
  (opts.log ?? console.log)(
    `ℹ ios.bundleIdentifier was missing: set it to "${suggestion}" in ${configFile} (edit it there if you prefer another; the app must be rebuilt after a change)`,
  );
  return suggestion;
}

/** Expo's getIcons (prebuild-config withIosIcons.js:100-133, 150): a non-empty string ios.icon; else an ios.icon
 *  object's light || dark || tinted; else icon. Resolved against root. Undefined for none or an http(s) URL. */
export function expoIconPath(exp: { icon?: unknown; ios?: { icon?: unknown } }, root: string): string | undefined {
  const ios = exp.ios?.icon;
  let icon: unknown = exp.icon;
  if (typeof ios === "string" && ios !== "") icon = ios;
  else if (ios !== null && typeof ios === "object") {
    const { light, dark, tinted } = ios as { light?: unknown; dark?: unknown; tinted?: unknown };
    icon = light || dark || tinted || exp.icon;
  }
  if (typeof icon !== "string" || icon === "" || /^https?:\/\//i.test(icon)) return undefined;
  return path.resolve(root, icon);
}

export async function readExpoProject(root: string, opts: ReadProjectOptions = {}): Promise<ProjectInfo> {
  const config = getConfig(root, { skipSDKVersionRequirement: true });
  const { exp } = config;
  const sdkVersion = majorOf(exp.sdkVersion) ?? majorOf(await declaredExpoRange(root));
  if (sdkVersion === undefined) {
    throw new Error("Could not determine Expo SDK version");
  }
  const expoPlugin = expoPluginFor(sdkVersion);
  if (expoPlugin === undefined) {
    throw new Error(`Expo SDK ${sdkVersion} is not supported; rn-xtool supports ${supportedExpoList()}.`);
  }
  checkExpoPackages(root, sdkVersion, opts.log);
  const bundleIdentifier = await resolveBundleIdentifier(root, config, opts);
  const iosTargetName = IOSConfig.XcodeUtils.sanitizedName(exp.name);
  return {
    kind: "expo",
    root,
    name: exp.name,
    slug: exp.slug,
    version: String(exp.version ?? "1.0.0"),
    buildNumber: String(exp.ios?.buildNumber ?? "1"),
    bundleIdentifier,
    sdkVersion,
    iosTargetName,
    iosTargetDir: path.join(root, "ios", iosTargetName),
    infoPlistPath: path.join(root, "ios", iosTargetName, "Info.plist"),
    moduleName: "main",
    rnVersion: await installedRnVersion(root),
    // The React Native of the vendored plugin's SDKs (56, 57) has no usable SwiftPM scripts: rn-xtool vendors them too.
    rnScripts: expoPlugin === "vendored" ? "vendored" : "installed",
    expoPlugin,
    hasExpoModules: true,
    hasExpoConstants: isInstalled(root, "expo-constants"),
    hasDevClient: isInstalled(root, "expo-dev-client"),
    appIconSource: expoIconPath(exp, root),
  };
}

export function buildVars(p: ProjectInfo): BuildVars {
  return {
    PRODUCT_NAME: p.name,
    PRODUCT_BUNDLE_IDENTIFIER: p.bundleIdentifier,
    MARKETING_VERSION: p.version,
    CURRENT_PROJECT_VERSION: p.buildNumber,
    PRODUCT_MODULE_NAME: "App",
    EXECUTABLE_NAME: "App",
    DEVELOPMENT_LANGUAGE: "en",
    PRODUCT_BUNDLE_PACKAGE_TYPE: "APPL",
  };
}
