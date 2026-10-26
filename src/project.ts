import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@expo/config";
import { IOSConfig } from "@expo/config-plugins";
import type { BuildVars } from "./plist.js";
import { MIN_EXPO_SDK } from "./versions.js";

export interface ExpoProject {
  root: string;
  name: string;
  slug: string;
  version: string;
  buildNumber: string;
  bundleIdentifier: string;
  sdkVersion: number;
  /** Sanitized name, as expo prebuild derives it. */
  iosTargetName: string;
  iosTargetDir: string;
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

export interface ReadProjectOptions {
  /** Write a default `ios.bundleIdentifier` into a static app.json when it is missing (default true). */
  writeDefaults?: boolean;
  log?: (line: string) => void;
}

async function resolveBundleIdentifier(
  root: string,
  exp: { slug: string; ios?: { bundleIdentifier?: string } },
  config: { staticConfigPath: string | null; dynamicConfigPath: string | null },
  opts: ReadProjectOptions,
): Promise<string> {
  if (exp.ios?.bundleIdentifier) return exp.ios.bundleIdentifier;
  const suggestion = defaultBundleIdentifier(exp.slug);
  const appJson = config.dynamicConfigPath === null ? config.staticConfigPath : null;
  if (opts.writeDefaults !== false && appJson && path.basename(appJson) === "app.json") {
    const app = JSON.parse(await readFile(appJson, "utf8")) as { expo?: Record<string, unknown> };
    const expo = (app.expo ??= {});
    expo.ios = { ...((expo.ios as Record<string, unknown> | undefined) ?? {}), bundleIdentifier: suggestion };
    await writeFile(appJson, `${JSON.stringify(app, null, 2)}\n`);
    (opts.log ?? console.log)(
      `ℹ ios.bundleIdentifier was missing: set it to "${suggestion}" in app.json (edit it there if you prefer another; the app must be rebuilt after a change)`,
    );
    return suggestion;
  }
  const file = path.basename(config.dynamicConfigPath ?? config.staticConfigPath ?? "app.json");
  throw new Error(
    `ios.bundleIdentifier is missing in ${file}. Add "ios": { "bundleIdentifier": "${suggestion}" } to the expo config and run again.`,
  );
}

export async function readExpoProject(root: string, opts: ReadProjectOptions = {}): Promise<ExpoProject> {
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
  const bundleIdentifier = await resolveBundleIdentifier(root, exp, config, opts);
  const iosTargetName = IOSConfig.XcodeUtils.sanitizedName(exp.name);
  return {
    root,
    name: exp.name,
    slug: exp.slug,
    version: String(exp.version ?? "1.0.0"),
    buildNumber: String(exp.ios?.buildNumber ?? "1"),
    bundleIdentifier,
    sdkVersion,
    iosTargetName,
    iosTargetDir: path.join(root, "ios", iosTargetName),
  };
}

export function buildVars(p: ExpoProject): BuildVars {
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
