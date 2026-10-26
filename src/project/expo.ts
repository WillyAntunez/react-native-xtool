import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig, modifyConfigAsync } from "@expo/config";
import { IOSConfig } from "@expo/config-plugins";
import { createRequire } from "node:module";
import type { BuildVars } from "../plist.js";
import { MIN_EXPO_SDK } from "../versions.js";
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
      `ios.bundleIdentifier is missing in ${configFile}. Add "ios": { "bundleIdentifier": "${suggestion}" } to the expo config, or run \`expo-xtool build\`, which writes that default into a static app.json.`,
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
      `ios.bundleIdentifier is missing in ${configFile} and expo-xtool could not write a default` +
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
  if (sdkVersion < MIN_EXPO_SDK) {
    throw new Error(
      `Expo SDK ${sdkVersion} is not supported; expo-xtool requires SDK ${MIN_EXPO_SDK} or newer`,
    );
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
