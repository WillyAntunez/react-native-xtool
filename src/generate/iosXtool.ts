import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { RuntimeFramework } from "../frameworks.js";
import type { ProjectPaths } from "../paths.js";
import { transformInfoPlist } from "../plist.js";
import { buildVars, type ExpoProject } from "../project.js";
import { IOS_MIN } from "../versions.js";
import { renderPackageSwift } from "./packageSwift.js";
import { renderXtoolYml } from "./xtoolYml.js";

export interface GenerateContext {
  project: ExpoProject;
  paths: ProjectPaths;
  frameworks: RuntimeFramework[];
  metroPort: number;
  lanIp: string;
}

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

export async function writeIosXtool(ctx: GenerateContext): Promise<void> {
  const { project, paths } = ctx;
  await mkdir(paths.sources, { recursive: true });

  for (const file of ["AppDelegate.swift", "SceneDelegate.swift"]) {
    const src = join(project.iosTargetDir, file);
    const text = await readRequired(src, file);
    await writeFile(join(paths.sources, file), text);
  }

  const linkPath = join(paths.sources, "ExpoModulesProvider.swift");
  const target = relative(
    dirname(linkPath),
    join(paths.expoDir, "ExpoModulesProvider.swift"),
  );
  await rm(linkPath, { force: true });
  await symlink(target, linkPath);

  const template = await readRequired(
    join(project.iosTargetDir, "Info.plist"),
    "Info.plist",
  );
  await writeFile(
    join(paths.iosXtool, "Info.plist"),
    transformInfoPlist(template, { vars: buildVars(project), metroPort: ctx.metroPort }),
  );
  await writeFile(join(paths.iosXtool, "ip.txt"), `${ctx.lanIp}\n`);
  await writeFile(
    join(paths.iosXtool, "xtool.yml"),
    renderXtoolYml({ bundleIdentifier: project.bundleIdentifier }),
  );
  await writeFile(
    join(paths.iosXtool, "Package.swift"),
    renderPackageSwift({
      iosDir: paths.ios,
      compileInterfacesDir: join(paths.expoDir, "compile-interfaces"),
      frameworks: ctx.frameworks,
      iosMin: IOS_MIN,
    }),
  );
  await writeFile(join(paths.iosXtool, ".gitignore"), "*\n");
}
