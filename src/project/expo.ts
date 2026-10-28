import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig, modifyConfigAsync } from "@expo/config";
import { IOSConfig } from "@expo/config-plugins";
import { createRequire } from "node:module";
import type { BuildVars } from "../plist.js";
import { expoPinPolicyFor, expoPinsFor, expoPluginFor, SUPPORTED_EXPO, type ExpoPinName } from "../versions.js";
import type { ProjectInfo, ReadProjectOptions } from "./types.js";

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

function versionAt(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  try {
    const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed version of each package the SDK pins, read where the build resolves it (undefined: not installed);
 * `{}` when the SDK pins nothing.
 */
export function readExpoPins(root: string, sdk: number): Partial<Record<ExpoPinName, string | undefined>> {
  const names = Object.keys(expoPinsFor(sdk) ?? {}) as ExpoPinName[];
  return Object.fromEntries(names.map((name) => [name, versionAt(expoPackageDir(root, name))]));
}

/** The error when rn-xtool's expo-modules-macros has no Linux binary for the host (an `--omit=optional` install or another arch). */
export function expoMacrosBinaryError(opts: { arch?: string; resolve?: (spec: string) => string } = {}): string | undefined {
  const arch = opts.arch ?? process.arch;
  const binaryPackage = `@expo/modules-macros-linux-${arch}`;
  const resolve =
    opts.resolve ??
    ((spec: string) => {
      const macrosDir = path.dirname(createRequire(import.meta.url).resolve("expo-modules-macros/package.json"));
      return createRequire(path.join(macrosDir, "package.json")).resolve(spec);
    });
  try {
    resolve(`${binaryPackage}/ExpoModulesMacros`);
    return undefined;
  } catch {
    return `expo-modules-macros 0.22.0 has no Linux binary for ${arch} (${binaryPackage}); reinstall react-native-xtool without --omit=optional.`;
  }
}

/** "a, b and c" */
function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The SDK's exact pins, each read where the build resolves it; then expo-modules-jsi must be the top-level copy. */
function checkExpoPins(root: string, sdk: number, pins: Readonly<Partial<Record<ExpoPinName, string>>>): void {
  const installed = readExpoPins(root, sdk);
  const names = Object.keys(pins) as ExpoPinName[];
  const off = names.filter((name) => installed[name] !== pins[name]);
  if (off.length > 0) {
    const wanted = andList(names.map((name) => `${name} ${pins[name]}`));
    const found = off.map((name) => `${name} ${installed[name] ?? "not installed"}`).join(", ");
    throw new Error(`Expo SDK ${sdk} needs exactly ${wanted}; installed: ${found}. Pin those versions in package.json and reinstall.`);
  }
  // patch-package patches only node_modules/expo-modules-jsi; a nested copy would be built unpatched.
  const jsiDir = expoPackageDir(root, "expo-modules-jsi")!;
  const topLevel = path.join(root, "node_modules", "expo-modules-jsi");
  if (!existsSync(topLevel) || realpathSync(topLevel) !== realpathSync(jsiDir)) {
    throw new Error(
      `expo-modules-jsi ${installed["expo-modules-jsi"]} resolves from ${path.relative(realpathSync(root), realpathSync(jsiDir))}, ` +
        `not from the project's top-level node_modules: rn-xtool patches and builds only the top-level copy. ` +
        `Pin expo-modules-jsi to ${pins["expo-modules-jsi"]} in package.json and reinstall (npm dedupe may also fix it).`,
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
      `Expo SDK ${sdkVersion} is not supported; rn-xtool supports SDK 57 (expo ${SUPPORTED_EXPO[57].pins.expo}) and SDK 58 or newer.`,
    );
  }
  // Only exact pins (SDK 57) stop the read here; the SDK 58 floor (checkPins) is not enforced by it.
  const pins = expoPinsFor(sdkVersion);
  if (pins && expoPinPolicyFor(sdkVersion) === "exact") checkExpoPins(root, sdkVersion, pins);
  if (expoPlugin === "vendored") {
    const macros = expoMacrosBinaryError();
    if (macros) throw new Error(macros);
  }
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
