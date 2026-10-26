import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { RuntimeFramework } from "../frameworks.js";
import { swiftHeadersDir, type ProjectPaths } from "../paths.js";
import { transformInfoPlist } from "../plist.js";
import { buildVars, type ProjectInfo } from "../project/index.js";
import { IOS_MIN } from "../versions.js";
import { copyBareTarget } from "./bareSources.js";
import { expoClangImporterInputs } from "./expoImporter.js";
import { renderPackageSwift, type AppTargetInputs } from "./packageSwift.js";
import { BASE_RESOURCES, DEFAULT_RESOURCES, renderXtoolYml } from "./xtoolYml.js";

export interface GenerateContext {
  project: ProjectInfo;
  paths: ProjectPaths;
  frameworks: RuntimeFramework[];
  metroPort: number;
  lanIp: string;
  log?: (s: string) => void;
}

const MANIFEST_6_5 = "Package@swift-6.5.swift";

async function readRequired(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${label}: ${path}`);
    }
    throw e;
  }
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
  for (const file of ["AppDelegate.swift", "SceneDelegate.swift"]) {
    const text = await readRequired(join(project.iosTargetDir, file), file);
    await writeFile(join(paths.sources, file), text);
  }
  return { app: { mixed: false, defines: [], headerSearchPaths: [], swiftHeadersDir: headersDir }, resources: [] };
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
    transformInfoPlist(template, { vars: buildVars(project), metroPort: ctx.metroPort }),
  );
  // Bare RN reads only the packager host from ip.txt (RCTBundleURLProvider.guessPackagerHost) and
  // takes the port from the compile-time RCT_METRO_PORT, 8081 in the prebuilt React framework; a
  // host with a colon is used verbatim. The RCTMetroPort Info.plist key is read by Expo's dev launcher only.
  const packagerHost = project.kind === "bare" ? `${ctx.lanIp}:${ctx.metroPort}` : ctx.lanIp;
  await writeFile(join(paths.iosXtool, "ip.txt"), `${packagerHost}\n`);
  await writeFile(
    join(paths.iosXtool, "xtool.yml"),
    renderXtoolYml({
      bundleIdentifier: project.bundleIdentifier,
      resources: [
        ...(project.hasExpoConstants ? DEFAULT_RESOURCES : BASE_RESOURCES),
        ...resources.map((r) => `Resources/${r}`),
      ],
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
    app,
  });
  await writeFile(join(paths.iosXtool, "Package.swift"), manifest);
  if (manifest65 !== undefined) await writeFile(join(paths.iosXtool, MANIFEST_6_5), manifest65);
  else await rm(join(paths.iosXtool, MANIFEST_6_5), { force: true });
  await writeFile(join(paths.iosXtool, ".gitignore"), "*\n");
}
