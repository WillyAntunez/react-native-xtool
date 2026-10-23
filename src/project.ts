import { readFile } from "node:fs/promises";
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
  const match = version?.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

async function installedExpoRange(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return pkg?.dependencies?.expo ?? pkg?.devDependencies?.expo;
  } catch {
    return undefined;
  }
}

export async function readExpoProject(root: string): Promise<ExpoProject> {
  const { exp } = getConfig(root, { skipSDKVersionRequirement: true });
  const sdkVersion = majorOf(exp.sdkVersion) ?? majorOf(await installedExpoRange(root));
  if (sdkVersion === undefined) {
    throw new Error("Could not determine Expo SDK version");
  }
  if (sdkVersion < MIN_EXPO_SDK) {
    throw new Error(
      `Expo SDK ${sdkVersion} is not supported; expo-xtool requires SDK ${MIN_EXPO_SDK} or newer`,
    );
  }
  const bundleIdentifier = exp.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error("ios.bundleIdentifier is missing in app.json");
  }
  const iosTargetName = IOSConfig.XcodeUtils.sanitizedName(exp.name);
  return {
    root,
    name: exp.name,
    slug: exp.slug,
    version: exp.version ?? "1.0.0",
    buildNumber: exp.ios?.buildNumber ?? "1",
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
