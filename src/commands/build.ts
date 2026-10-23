import { existsSync } from "node:fs";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { readFlavoredFrameworks, stageFrameworks, type RuntimeFramework } from "../frameworks.js";
import { writeIosXtool } from "../generate/iosXtool.js";
import { detectLanIp, findFreePort, isMetroRunning, isPortFree } from "../net.js";
import { projectPaths, type ProjectPaths } from "../paths.js";
import { generateAppConfig } from "../pipeline/appConfig.js";
import { buildExpoModulesJsi } from "../pipeline/jsi.js";
import { applyPatches } from "../pipeline/patches.js";
import { runRnSpm } from "../pipeline/rnSpm.js";
import { readExpoProject, type ExpoProject } from "../project.js";
import { writeState } from "../state.js";
import { run } from "../tools/exec.js";
import { devBuild, xtoolBin } from "../tools/xtool.js";

export const BUILD_STEP_NAMES = [
  "patches",
  "rn-spm",
  "jsi",
  "app-config",
  "frameworks",
  "generate",
  "xtool-build",
] as const;

export function buildSteps(state: { hasIos: boolean; clean: boolean }): string[] {
  const steps: string[] = [...BUILD_STEP_NAMES];
  if (!state.hasIos || state.clean) {
    steps.unshift(state.clean ? "prebuild --clean" : "prebuild");
  }
  return steps;
}

export interface BuildDeps {
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  readProject: (root: string) => Promise<ExpoProject>;
  exists: (path: string) => boolean;
  prebuild: (root: string, clean: boolean) => Promise<void>;
  applyPatches: (root: string) => Promise<void>;
  runRnSpm: (paths: ProjectPaths, opts: { rnArtifactsDir?: string }) => Promise<void>;
  buildJsi: (paths: ProjectPaths) => Promise<RuntimeFramework>;
  generateAppConfig: (paths: ProjectPaths) => Promise<void>;
  readFrameworks: (dir: string, flavor: "debug" | "release") => RuntimeFramework[];
  stageFrameworks: (fws: RuntimeFramework[], dest: string) => Promise<void>;
  writeIosXtool: typeof writeIosXtool;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
  detectLanIp: () => Promise<string>;
  devBuild: (bin: string, iosXtoolDir: string) => Promise<void>;
  xtoolBin: (config: ExpoXtoolConfig) => string;
  log: (s: string) => void;
}

const realDeps: BuildDeps = {
  loadConfig,
  readProject: readExpoProject,
  exists: existsSync,
  prebuild: (root, clean) =>
    run("npx", ["expo", "prebuild", "--platform", "ios", "--no-install", ...(clean ? ["--clean"] : [])], {
      cwd: root,
    }),
  applyPatches,
  runRnSpm,
  buildJsi: buildExpoModulesJsi,
  generateAppConfig,
  readFrameworks: readFlavoredFrameworks,
  stageFrameworks,
  writeIosXtool,
  isPortFree: (p) => isPortFree(p),
  isMetroRunning: (p) => isMetroRunning(p),
  findFreePort: (s) => findFreePort(s),
  detectLanIp: () => detectLanIp(),
  devBuild,
  xtoolBin,
  log: (s) => console.log(s),
};

export async function build(
  root: string,
  opts: { clean?: boolean },
  overrides: Partial<BuildDeps> = {},
): Promise<void> {
  const d: BuildDeps = { ...realDeps, ...overrides };
  const clean = opts.clean === true;
  const paths = projectPaths(root);
  const config = await d.loadConfig(root);
  const project = await d.readProject(root);

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    d.log(`▸ ${name}`);
    const t0 = Date.now();
    const result = await fn();
    d.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return result;
  };

  if (!d.exists(paths.ios) || clean) {
    await step(clean ? "prebuild --clean" : "prebuild", () => d.prebuild(paths.root, clean));
  }
  await step("patches", () => d.applyPatches(paths.root));
  await step("rn-spm", () => d.runRnSpm(paths, { rnArtifactsDir: config.rnArtifactsDir }));
  const jsi = await step("jsi", () => d.buildJsi(paths));
  await step("app-config", () => d.generateAppConfig(paths));
  const frameworks = await step("frameworks", async () => {
    const fws = [...d.readFrameworks(paths.xcframeworks, "debug"), jsi];
    await d.stageFrameworks(fws, paths.frameworks);
    return fws;
  });

  let metroPort = config.metroPort;
  if (!(await d.isPortFree(metroPort))) {
    if (await d.isMetroRunning(metroPort)) {
      d.log(`Metro is already running on port ${metroPort}; keeping it.`);
    } else {
      metroPort = await d.findFreePort(metroPort + 1);
      d.log(`Port ${config.metroPort} is busy; baking Metro port ${metroPort} into the app.`);
    }
  }
  const lanIp = config.lanIp ?? (await d.detectLanIp());

  await step("generate", async () => {
    await d.writeIosXtool({ project, paths, frameworks, metroPort, lanIp });
    await writeState(paths.iosXtool, {
      version: 1,
      metroPort,
      lanIp,
      bundleIdentifier: project.bundleIdentifier,
      builtAt: new Date().toISOString(),
    });
  });
  await step("xtool-build", () => d.devBuild(d.xtoolBin(config), paths.iosXtool));
}
