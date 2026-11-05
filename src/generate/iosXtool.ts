import { readdirSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as plist from "plist";
import type { RuntimeFramework } from "../frameworks.js";
import { swiftHeadersDir, type ProjectPaths } from "../paths.js";
import { transformInfoPlist } from "../plist.js";
import { buildVars, type ProjectInfo } from "../project/index.js";
import { readEntitlements } from "../project/entitlements.js";
import { openPbxproj, resolveSetting } from "../project/pbxproj.js";
import { packageRoot } from "../tools/exec.js";
import { IOS_MIN } from "../versions.js";
import { APP_ICON_FILE, findAppIcon, type IconRecord } from "./appIcon.js";
import { copyBareTarget } from "./bareSources.js";
import { expoClangImporterInputs } from "./expoImporter.js";
import { DEV_SUPPORT_TARGET, renderPackageSwift, type AppTargetInputs } from "./packageSwift.js";
import { scaffoldedImporterPaths } from "./scaffoldImporter.js";
import { BASE_RESOURCES, DEFAULT_RESOURCES, renderXtoolYml } from "./xtoolYml.js";

export interface GenerateContext {
  project: ProjectInfo;
  paths: ProjectPaths;
  frameworks: RuntimeFramework[];
  metroPort: number;
  lanIp: string;
  log?: (s: string) => void;
  /** The app config icon `build` recorded when it last ran expo prebuild (findAppIcon's stale-icon check). */
  prebuildIcon?: IconRecord;
}

const MANIFEST_6_5 = "Package@swift-6.5.swift";
/** The app's entitlements in ios-xtool, which xtool.yml's `entitlementsPath` names. */
export const ENTITLEMENTS_FILE = "App.entitlements";

/** The app gets the auto-reload helper target: apps without expo-dev-client only. */
export function hasDevSupport(project: Pick<ProjectInfo, "hasDevClient">): boolean {
  return !project.hasDevClient;
}

/** The auto-reload helper's sources, copied byte for byte into ios-xtool/Sources/RNXtoolDevSupport. */
export function devSupportTemplatesDir(): string {
  return join(packageRoot(), "templates", "dev-support");
}

/** The file's text, or undefined when it does not exist. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function readRequired(path: string, label: string): Promise<string> {
  const text = await readOptional(path);
  if (text === undefined) throw new Error(`Missing ${label}: ${path}`);
  return text;
}

type PlistDict = { [key: string]: plist.PlistValue };

function isDict(value: unknown): value is PlistDict {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !ArrayBuffer.isView(value);
}

/** Every `UISceneDelegateClassName` under `UIApplicationSceneManifest.UISceneConfigurations`, in order. */
export function sceneDelegateClassNames(infoPlistText: string): string[] {
  const info = plist.parse(infoPlistText);
  const manifest = isDict(info) ? info.UIApplicationSceneManifest : undefined;
  const configurations = isDict(manifest) ? manifest.UISceneConfigurations : undefined;
  if (!isDict(configurations)) return [];
  const names: string[] = [];
  for (const role of Object.values(configurations)) {
    if (!Array.isArray(role)) continue;
    for (const scene of role) {
      const name = isDict(scene) ? scene.UISceneDelegateClassName : undefined;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

interface AppSources {
  app: AppTargetInputs;
  /** Top-level entries staged in ios-xtool/Resources. */
  resources: string[];
}

/** Copies the app's sources into Sources/App (resources into ios-xtool/Resources) and says what the App target compiles. */
async function writeAppSources(ctx: GenerateContext, headersDir: string, resourcesDir: string): Promise<AppSources> {
  const { project, paths } = ctx;
  if (project.kind === "bare") {
    if (!project.bare) throw new Error(`Bare project ${project.root} has no app target content`);
    const copied = await copyBareTarget(
      project.bare, paths.ios, project.iosTargetDir, paths.sources, resourcesDir, ctx.log ?? console.log,
    );
    const app: AppTargetInputs = {
      mixed: project.bare.mixed,
      bridgingHeader: copied.bridgingHeader,
      defines: project.bare.defines,
      headerSearchPaths: copied.headerSearchPaths,
      cxxStandard: project.bare.cxxStandard,
      swiftHeadersDir: headersDir,
    };
    return { app, resources: copied.resources };
  }
  const appDelegate = await readRequired(join(project.iosTargetDir, "AppDelegate.swift"), "AppDelegate.swift");
  await writeFile(join(paths.sources, "AppDelegate.swift"), appDelegate);
  // SDK 58's template adds a SceneDelegate; SDK 57's is AppDelegate-only. It is required only when Info.plist names one.
  const sceneDelegatePath = join(project.iosTargetDir, "SceneDelegate.swift");
  const sceneDelegate = await readOptional(sceneDelegatePath);
  if (sceneDelegate !== undefined) {
    await writeFile(join(paths.sources, "SceneDelegate.swift"), sceneDelegate);
  } else {
    const names = sceneDelegateClassNames(await readRequired(project.infoPlistPath, "Info.plist"));
    if (names.length > 0) {
      throw new Error(
        `Missing SceneDelegate.swift: ${sceneDelegatePath} (Info.plist's UIApplicationSceneManifest names ${names[0]})`,
      );
    }
  }
  const bridgingHeader = await expoBridgingHeader(paths.ios, paths.sources);
  return {
    app: {
      mixed: false,
      ...(bridgingHeader && { bridgingHeader }),
      defines: [],
      headerSearchPaths: [],
      swiftHeadersDir: headersDir,
    },
    resources: [],
  };
}

/** Whether a header holds anything besides comments and blank lines. */
function hasDeclarations(text: string): boolean {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim() !== "";
}

/**
 * The Expo prebuild's bridging header (`SWIFT_OBJC_BRIDGING_HEADER` of the app target, Debug, relative to ios/),
 * copied into Sources/App for Swift when it holds more than comments: a config plugin adds imports to it
 * (react-native-app-auth's `RNAppAuthAuthorizationFlowManager.h`). The prebuild's default holds only a comment and is
 * not passed, so such an app's manifest stays as it was. Undefined without an Xcode project or the setting; a setting
 * naming a missing file throws.
 */
async function expoBridgingHeader(iosDir: string, sourcesDir: string): Promise<string | undefined> {
  let projects: string[];
  try {
    projects = readdirSync(iosDir).filter((n) => n.endsWith(".xcodeproj"));
  } catch {
    return undefined;
  }
  if (projects.length === 0) return undefined;
  const p = openPbxproj(iosDir);
  const rel = resolveSetting(p, "SWIFT_OBJC_BRIDGING_HEADER")?.trim();
  if (!rel) return undefined;
  const text = await readOptional(resolve(iosDir, rel));
  if (text === undefined) {
    throw new Error(
      `SWIFT_OBJC_BRIDGING_HEADER in ios/${p.projectName}.xcodeproj names ${rel}, which does not exist. ` +
        "Run rn-xtool build --clean to run expo prebuild again.",
    );
  }
  if (!hasDeclarations(text)) return undefined;
  const copy = join(sourcesDir, basename(rel));
  await writeFile(copy, text);
  return copy;
}

export async function writeIosXtool(ctx: GenerateContext): Promise<void> {
  const { project, paths } = ctx;
  const headersDir = swiftHeadersDir(paths.iosXtool);
  const resourcesDir = join(paths.iosXtool, "Resources");
  // Regenerated from the project each time: a file dropped from the target must not linger.
  await rm(paths.sources, { recursive: true, force: true });
  await rm(resourcesDir, { recursive: true, force: true });
  await mkdir(paths.sources, { recursive: true });
  const { app, resources } = await writeAppSources(ctx, headersDir, resourcesDir);
  // The icon from the app's AppIcon.appiconset; a missing or unusable one is reported and the build goes on.
  const icon = await findAppIcon(project, { bundleRootNames: resources, prebuildIcon: ctx.prebuildIcon });
  for (const line of icon.lines) (ctx.log ?? console.log)(line);
  const iconFile = join(paths.iosXtool, APP_ICON_FILE);
  if (icon.source !== undefined) await copyFile(icon.source, iconFile);
  else await rm(iconFile, { force: true });
  // The auto-reload helper, for apps without expo-dev-client only; removed when a project gains the dev client.
  const devSupportDir = join(paths.iosXtool, "Sources", DEV_SUPPORT_TARGET);
  await rm(devSupportDir, { recursive: true, force: true });
  const devSupport = hasDevSupport(project);
  if (devSupport) await cp(devSupportTemplatesDir(), devSupportDir, { recursive: true });

  if (project.hasExpoModules) {
    const linkPath = join(paths.sources, "ExpoModulesProvider.swift");
    const target = relative(
      dirname(linkPath),
      join(paths.expoDir, "ExpoModulesProvider.swift"),
    );
    await rm(linkPath, { force: true });
    await symlink(target, linkPath);
  }

  const template = await readRequired(project.infoPlistPath, "Info.plist");
  await writeFile(
    join(paths.iosXtool, "Info.plist"),
    transformInfoPlist(template, {
      vars: buildVars(project),
      metroPort: ctx.metroPort,
      devClientUrl: project.hasDevClient ? `http://${ctx.lanIp}:${ctx.metroPort}` : undefined,
    }),
  );
  // React Native reads the packager host from ip.txt (RCTBundleURLProvider.guessPackagerHost) and uses a host with a
  // colon verbatim; otherwise it adds the compile-time RCT_METRO_PORT, 8081 in the prebuilt React framework. Bare: ip.txt
  // holds host:port. Expo: ip.txt holds the host only, and in Debug without the dev launcher Expo's
  // ExpoReactNativeFactory (adoptInfoPlistMetroPort) sets RCTBundleURLProvider's jsLocation to <ip.txt>:<RCTMetroPort>.
  // The RNXtoolDevSupport helper reads the same pair. expo-dev-launcher reads neither: it finds Metro over Bonjour, from
  // DEV_CLIENT_DEFAULT_LAUNCHER_URL or from a deep link.
  const packagerHost = project.kind === "bare" ? `${ctx.lanIp}:${ctx.metroPort}` : ctx.lanIp;
  await writeFile(join(paths.iosXtool, "ip.txt"), `${packagerHost}\n`);
  // CODE_SIGN_ENTITLEMENTS (Debug; on Expo, the prebuild's pbxproj): removed when the setting goes.
  const entitlements = readEntitlements(project, paths.ios);
  const entitlementsFile = join(paths.iosXtool, ENTITLEMENTS_FILE);
  if (entitlements !== undefined) await writeFile(entitlementsFile, plist.build(entitlements.dict as plist.PlistValue));
  else await rm(entitlementsFile, { force: true });
  await writeFile(
    join(paths.iosXtool, "xtool.yml"),
    renderXtoolYml({
      bundleIdentifier: project.bundleIdentifier,
      resources: [
        ...(project.hasExpoConstants ? DEFAULT_RESOURCES : BASE_RESOURCES),
        ...resources.map((r) => `Resources/${r}`),
      ],
      iconPath: icon.source !== undefined ? APP_ICON_FILE : undefined,
      entitlementsPath: entitlements !== undefined ? ENTITLEMENTS_FILE : undefined,
    }),
  );
  const { manifest, manifest65 } = renderPackageSwift({
    iosDir: paths.ios,
    frameworks: ctx.frameworks,
    iosMin: IOS_MIN,
    expo: project.hasExpoModules
      ? {
          compileInterfacesDir: join(paths.expoDir, "compile-interfaces"),
          clangImporter: await expoClangImporterInputs(dirname(paths.expoDir), headersDir),
          jsiHeaders: true,
        }
      : undefined,
    app: { ...app, importerPaths: await scaffoldedImporterPaths(paths.autolinking) },
    devSupport,
  });
  await writeFile(join(paths.iosXtool, "Package.swift"), manifest);
  if (manifest65 !== undefined) await writeFile(join(paths.iosXtool, MANIFEST_6_5), manifest65);
  else await rm(join(paths.iosXtool, MANIFEST_6_5), { force: true });
  await writeFile(join(paths.iosXtool, ".gitignore"), "*\n");
}
