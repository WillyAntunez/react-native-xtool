import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DetectError } from "./detect.js";
import {
  checkExpoPackages,
  defaultBundleIdentifier,
  installedExpoMajor,
  installedExpoVersion,
  installedRnVersion,
  isInstalled,
  MissingBundleIdentifierError,
  resolvesFromRoot,
  RN_UPGRADE_DOCS,
} from "./expo.js";
import { buildSetting, openPbxproj, readTargetContent, resolveSetting } from "./pbxproj.js";
import { expoPinsFor, rnScriptsFor, supportedRnList, type RnScripts } from "../versions.js";
import type { ProjectInfo, ReadProjectOptions } from "./types.js";

/** Shown by doctor (warn) and build (error) when a bare project lacks the React Native CLI. */
export const RN_CLI_MISSING =
  "@react-native-community/cli is not installed: React Native reads the native modules (autolinking) and runs Metro " +
  "through it. Install it with `npm install --save-dev @react-native-community/cli` (the React Native template has it " +
  "as a devDependency; `npm ci --omit=dev` leaves it out)";

const EXPO_NEEDS_088 = "Expo SDK 58 needs React Native 0.88.1.";

function checkRnVersion(version: string, hasExpoModulesCore: boolean): RnScripts {
  const scripts = rnScriptsFor(version);
  if (scripts === undefined) {
    throw new DetectError(
      `React Native ${version} is not supported; rn-xtool supports ${supportedRnList()} (bare). Pin react-native to one of them.` +
        (hasExpoModulesCore ? ` ${EXPO_NEEDS_088}` : ""),
    );
  }
  if (scripts === "vendored" && hasExpoModulesCore) {
    throw new DetectError(`React Native ${version} with Expo modules is not supported. ${EXPO_NEEDS_088}`);
  }
  return scripts;
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
      `react-native is not installed in ${root}: run \`npm install\` (a fresh clone has no node_modules yet). To add it, ` +
        `or to move to another React Native version, follow ${RN_UPGRADE_DOCS} (a single ` +
        "`npm install react-native@<version>` can fail with ERESOLVE on the template's exact @react-native/* peers).",
    );
  }
  const rnVersion = await installedRnVersion(root);
  const rnScripts = checkRnVersion(rnVersion, isInstalled(root, "expo-modules-core"));

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
  if (hasExpoModules) {
    // Active Expo modules are the installed expo's precompiled ones, built by its own SwiftPM plugin: SDK 58 or newer,
    // on that SDK's set (G1–G3).
    const sdk = installedExpoMajor(root);
    if (sdk !== undefined && sdk < 58) {
      const { expo, "react-native": rn } = expoPinsFor(58)!;
      throw new DetectError(
        `Expo SDK ${sdk} (expo ${installedExpoVersion(root)}) with Expo modules is not supported in a bare app. Expo modules ` +
          `in a bare app need Expo SDK 58 or newer: install expo ~${expo} and run \`npx expo install --fix\`, then move ` +
          `react-native to ${rn} as ${RN_UPGRADE_DOCS} describes.`,
      );
    }
    if (sdk !== undefined) checkExpoPackages(root, sdk, opts.log, { kind: "bare" });
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
    rnScripts,
    expoPlugin: "installed",
    hasExpoModules,
    hasExpoConstants: isInstalled(root, "expo-constants"),
    hasDevClient: isInstalled(root, "expo-dev-client"),
    hasRnCli: resolvesFromRoot(root, "@react-native-community/cli"),
    bare: readTargetContent(pbx, iosDir),
  };
}
