import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DetectError } from "./detect.js";
import { defaultBundleIdentifier, installedRnVersion, isInstalled, MissingBundleIdentifierError, resolvesFromRoot } from "./expo.js";
import { buildSetting, openPbxproj, readTargetContent, resolveSetting } from "./pbxproj.js";
import type { ProjectInfo, ReadProjectOptions } from "./types.js";

const MIN_RN_MINOR = 88;

/** Shown by doctor (warn) and build (error) when a bare project lacks the React Native CLI. */
export const RN_CLI_MISSING =
  "@react-native-community/cli is not installed: React Native reads the native modules (autolinking) and runs Metro " +
  "through it. Install it with `npm install --save-dev @react-native-community/cli` (the React Native template has it " +
  "as a devDependency; `npm ci --omit=dev` leaves it out)";

function checkRnVersion(version: string): void {
  const match = version.match(/^(\d+)\.(\d+)/);
  const supported = match !== null && (Number(match[1]) > 0 || Number(match[2]) >= MIN_RN_MINOR);
  if (!supported) {
    throw new DetectError(`React Native ${version} is not supported; rn-xtool requires 0.${MIN_RN_MINOR} or newer`);
  }
}

async function appJsonName(root: string): Promise<string | undefined> {
  try {
    const name = JSON.parse(await readFile(path.join(root, "app.json"), "utf8"))?.name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

export async function readBareProject(root: string, opts: ReadProjectOptions = {}): Promise<ProjectInfo> {
  const iosDir = path.join(root, "ios");
  if (!resolvesFromRoot(root, "react-native")) {
    throw new DetectError(
      `react-native is not installed in ${root}: run \`npm install\` (a fresh clone has no node_modules yet), or add it ` +
        `with \`npm install react-native@0.${MIN_RN_MINOR}.0\``,
    );
  }
  const rnVersion = await installedRnVersion(root);
  checkRnVersion(rnVersion);

  const pbx = openPbxproj(iosDir);
  const name = resolveSetting(pbx, "PRODUCT_NAME") || pbx.appTarget.name;
  const bundleIdentifier = resolveSetting(pbx, "PRODUCT_BUNDLE_IDENTIFIER");
  if (!bundleIdentifier) throw new MissingBundleIdentifierError(defaultBundleIdentifier(name), "project.pbxproj");

  const infoPlist = resolveSetting(pbx, "INFOPLIST_FILE");
  if (!infoPlist) throw new DetectError(`target ${pbx.appTarget.name} has no INFOPLIST_FILE`);
  const infoPlistPath = path.resolve(iosDir, infoPlist);

  let hasExpoModules = isInstalled(root, "expo-modules-core");
  if (hasExpoModules) {
    if (!isInstalled(root, "expo")) {
      throw new DetectError("expo-modules-core is installed without expo; run npx install-expo-modules (it installs both)");
    }
    const podfile = path.join(iosDir, "Podfile");
    if (existsSync(podfile) && !(await readFile(podfile, "utf8")).includes("use_expo_modules!")) {
      opts.log?.(
        "⚠ expo-modules-core is installed but ios/Podfile has no use_expo_modules!: Expo's SwiftPM plugin stays inactive, so Expo modules are not built. Run npx install-expo-modules.",
      );
      hasExpoModules = false;
    }
  }

  return {
    kind: "bare",
    root,
    name,
    slug: name,
    version: buildSetting(pbx, "MARKETING_VERSION") ?? "1.0",
    buildNumber: buildSetting(pbx, "CURRENT_PROJECT_VERSION") ?? "1",
    bundleIdentifier,
    moduleName: (await appJsonName(root)) ?? name,
    iosTargetName: pbx.appTarget.name,
    iosTargetDir: path.dirname(infoPlistPath),
    infoPlistPath,
    rnVersion,
    hasExpoModules,
    hasExpoConstants: isInstalled(root, "expo-constants"),
    hasDevClient: isInstalled(root, "expo-dev-client"),
    hasRnCli: resolvesFromRoot(root, "@react-native-community/cli"),
    bare: readTargetContent(pbx, iosDir),
  };
}
