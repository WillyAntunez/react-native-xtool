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
 * Where the build resolves a pinned Expo package: expo and react-native from the root; expo-modules-core,
 * expo-file-system and expo-font from expo (npm nests the last two under `expo/node_modules`); expo-modules-jsi from
 * core; expo-modules-autolinking from the root and else from expo (npx's order).
 * The one copy of this chain: the gate and the JSI build use it.
 */
export function expoPackageDir(root: string, pkg: ExpoPinName): string | undefined {
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
    case "expo-file-system":
    case "expo-font":
      return from("expo");
    case "expo-modules-jsi":
      return from("expo-modules-core");
  }
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

/**
 * The installed version of each package the SDK pins, read where the build resolves it (undefined: not installed);
 * `{}` when the SDK pins nothing.
 */
export function readExpoPins(root: string, sdk: number): Partial<Record<ExpoPinName, string | undefined>> {
  const names = Object.keys(expoPinsFor(sdk) ?? {}) as ExpoPinName[];
  return Object.fromEntries(names.map((name) => [name, versionAt(expoPackageDir(root, name))]));
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
 * resolves (`root`), which must be installed on SDK 58; with `pluginDir` (SDK 57's vendored plugin, whose core depends
 * on @expo/expo-modules-macros-plugin instead) the plugin falls back to the copy its own directory resolves,
 * rn-xtool's. Without `root`: rn-xtool's own copy. `resolve` replaces only the binary lookup.
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

/** G1: every pin installed, none below the floor or on another release line, and react-native exact. */
function checkExpoPinVersions(root: string, sdk: number, checks: PinCheck[], kind: ProjectKind): void {
  const failed = checks.filter((c) => c.status === "missing" || c.status === "off" || c.status === "below");
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
 * The gate on an SDK's pinned packages (no-op when the SDK pins nothing), each step throwing: G1 the pins, G2 one
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
  const checks = checkPins(sdk, readExpoPins(root, sdk));
  if (checks === undefined) return;
  checkExpoPinVersions(root, sdk, checks, opts.kind ?? "expo");
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

export async function readExpoProject(root: string, opts: ReadProjectOptions = {}): Promise<ProjectInfo> {
  const config = getConfig(root, { skipSDKVersionRequirement: true });
  const { exp } = config;
  const sdkVersion = majorOf(exp.sdkVersion) ?? majorOf(await declaredExpoRange(root));
  if (sdkVersion === undefined) {
    throw new Error("Could not determine Expo SDK version");
  }
  const expoPlugin = expoPluginFor(sdkVersion);
  if (expoPlugin === undefined) {
    throw new Error(
      `Expo SDK ${sdkVersion} is not supported; rn-xtool supports SDK 57 (expo ${expoPinsFor(57)!.expo} or newer 57.x) ` +
        "and SDK 58 or newer.",
    );
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
    // SDK 57's React Native (0.86.3) has no usable SwiftPM scripts: rn-xtool vendors them with the plugin.
    rnScripts: expoPlugin === "vendored" ? "vendored" : "installed",
    expoPlugin,
    hasExpoModules: true,
    hasExpoConstants: isInstalled(root, "expo-constants"),
    hasDevClient: isInstalled(root, "expo-dev-client"),
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
