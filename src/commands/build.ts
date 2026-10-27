import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { depsFingerprint } from "../deps.js";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { readFlavoredFrameworks, stageFrameworks, type RuntimeFramework } from "../frameworks.js";
import { writeIosXtool } from "../generate/iosXtool.js";
import { detectLanIp, detectLanRoute, findFreePort, isMetroRunning, isPortFree, suspiciousLanRoute, tunnelWarning, type LanRoute } from "../net.js";
import { projectPaths, type ProjectPaths } from "../paths.js";
import { generateAppConfig } from "../pipeline/appConfig.js";
import { buildExpoModulesJsi } from "../pipeline/jsi.js";
import { applyPatches } from "../pipeline/patches.js";
import { prepareRnArtifacts } from "../pipeline/rnArtifactsStep.js";
import type { ExpoPlugin, RnScripts } from "../versions.js";
import { runRnSpm } from "../pipeline/rnSpm.js";
import { readProject, RN_CLI_MISSING, type ProjectInfo, type ProjectKind, type ReadProjectOptions } from "../project/index.js";
import { readState, writeState, type BuildState } from "../state.js";
import { run } from "../tools/exec.js";
import { devBuild, xtoolBin } from "../tools/xtool.js";

export const BUILD_STEP_NAMES = [
  "patches",
  "rn-artifacts",
  "rn-spm",
  "jsi",
  "app-config",
  "frameworks",
  "generate",
  "xtool-build",
] as const;

export interface BuildPlanInput {
  kind: ProjectKind;
  hasIos: boolean;
  clean: boolean;
  hasExpoModules: boolean;
  hasExpoConstants: boolean;
  /** Vendored SwiftPM scripts without a user-supplied `rnArtifactsDir`: rn-xtool prepares the artifacts. */
  rnArtifacts: boolean;
}

/**
 * Expo: every step but rn-artifacts, with `expo prebuild` first when `ios/` is missing or on `--clean`.
 * Bare: never prebuild (`--clean` removes the build outputs instead), rn-artifacts only for the
 * vendored scripts, ExpoModulesJSI only with Expo modules set up, app-config only with expo-constants.
 */
export function buildSteps(state: BuildPlanInput): string[] {
  if (state.kind === "expo") {
    const steps: string[] = BUILD_STEP_NAMES.filter((s) => s !== "rn-artifacts");
    if (!state.hasIos || state.clean) steps.unshift(state.clean ? "prebuild --clean" : "prebuild");
    return steps;
  }
  return [
    ...(state.clean ? ["clean"] : []),
    ...BUILD_STEP_NAMES.filter(
      (s) =>
        (s !== "rn-artifacts" || state.rnArtifacts) &&
        (s !== "jsi" || state.hasExpoModules) &&
        (s !== "app-config" || state.hasExpoConstants),
    ),
  ];
}

export type MetroPortReason = "configured-free" | "configured-metro" | "previous-free" | "previous-metro" | "fallback";

export interface MetroPortInput {
  configured: number;
  previous?: number;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
}

/** Configured port, then the previous build's port (so a running Metro keeps matching the app), then the next free one. */
export async function chooseMetroPort(i: MetroPortInput): Promise<{ port: number; reason: MetroPortReason }> {
  if (await i.isPortFree(i.configured)) return { port: i.configured, reason: "configured-free" };
  if (await i.isMetroRunning(i.configured)) return { port: i.configured, reason: "configured-metro" };
  if (i.previous !== undefined && i.previous !== i.configured) {
    if (await i.isPortFree(i.previous)) return { port: i.previous, reason: "previous-free" };
    if (await i.isMetroRunning(i.previous)) return { port: i.previous, reason: "previous-metro" };
  }
  return { port: await i.findFreePort(i.configured + 1), reason: "fallback" };
}

export interface BuildDeps {
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  readProject: (root: string, opts?: ReadProjectOptions) => Promise<ProjectInfo>;
  exists: (path: string) => boolean;
  /** Deletes a directory tree (no error when it is missing). */
  remove: (path: string) => Promise<void>;
  prebuild: (root: string, clean: boolean) => Promise<void>;
  applyPatches: (root: string, sources: { rnScripts: RnScripts; expoPlugin: ExpoPlugin }) => Promise<void>;
  /** Downloads (and adapts when needed) RN's prebuilt artifacts; returns the root for `rn-spm --artifacts`. */
  prepareRnArtifacts: (paths: ProjectPaths, rnVersion: string) => Promise<string>;
  runRnSpm: (paths: ProjectPaths, opts: { rnArtifactsDir?: string; kind: ProjectKind; rnScripts: RnScripts }) => Promise<void>;
  buildJsi: (paths: ProjectPaths) => Promise<RuntimeFramework>;
  generateAppConfig: (paths: ProjectPaths) => Promise<void>;
  readFrameworks: (dir: string, flavor: "debug" | "release") => RuntimeFramework[];
  stageFrameworks: (fws: RuntimeFramework[], dest: string) => Promise<void>;
  writeIosXtool: typeof writeIosXtool;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
  detectLanIp: () => Promise<string>;
  detectLanRoute: () => Promise<LanRoute>;
  devBuild: (bin: string, iosXtoolDir: string) => Promise<void>;
  xtoolBin: (config: ExpoXtoolConfig) => string;
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  log: (s: string) => void;
}

const realDeps: BuildDeps = {
  loadConfig,
  readProject,
  exists: existsSync,
  remove: (path) => rm(path, { recursive: true, force: true }),
  prebuild: (root, clean) =>
    run("npx", ["expo", "prebuild", "--platform", "ios", "--no-install", ...(clean ? ["--clean"] : [])], {
      cwd: root,
    }),
  applyPatches: (root, sources) => applyPatches(root, undefined, sources),
  prepareRnArtifacts: (paths, rnVersion) => prepareRnArtifacts(paths, rnVersion),
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
  detectLanRoute: () => detectLanRoute(),
  devBuild,
  xtoolBin,
  readState,
  depsFingerprint: depsFingerprint,
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
  let previousState: BuildState | undefined;
  try {
    previousState = await d.readState(paths.iosXtool);
  } catch (e) {
    d.log(`⚠ Ignoring unreadable build state (${e instanceof Error ? e.message : String(e)}); a fresh one will be written.`);
  }
  const config = await d.loadConfig(root);
  const project = await d.readProject(root, { log: d.log });
  // Bare rn-spm runs RN's default autolinking config command, `npx --no-install @react-native-community/cli config`.
  if (project.kind === "bare" && project.hasRnCli === false) throw new Error(RN_CLI_MISSING);

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    d.log(`▸ ${name}`);
    const t0 = Date.now();
    const result = await fn();
    d.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return result;
  };

  const steps = buildSteps({
    kind: project.kind,
    hasIos: d.exists(paths.ios),
    clean,
    hasExpoModules: project.hasExpoModules,
    hasExpoConstants: project.hasExpoConstants,
    rnArtifacts: project.rnScripts === "vendored" && !config.rnArtifactsDir,
  });
  const planned = (name: string): boolean => steps.includes(name);

  if (planned("prebuild") || planned("prebuild --clean")) {
    await step(clean ? "prebuild --clean" : "prebuild", () => d.prebuild(paths.root, clean));
  }
  if (planned("clean")) {
    // Bare: the user's ios/ is theirs; only what the pipeline generated goes.
    await step("clean", async () => {
      await d.remove(paths.iosBuild);
      await d.remove(paths.iosXtool);
    });
  }
  await step("patches", () =>
    d.applyPatches(paths.root, { rnScripts: project.rnScripts, expoPlugin: project.expoPlugin }),
  );
  const preparedArtifacts = planned("rn-artifacts")
    ? await step("rn-artifacts", () => d.prepareRnArtifacts(paths, project.rnVersion))
    : undefined;
  await step("rn-spm", () =>
    d.runRnSpm(paths, {
      rnArtifactsDir: preparedArtifacts ?? config.rnArtifactsDir,
      kind: project.kind,
      rnScripts: project.rnScripts,
    }),
  );
  const jsi = planned("jsi") ? await step("jsi", () => d.buildJsi(paths)) : undefined;
  if (planned("app-config")) await step("app-config", () => d.generateAppConfig(paths));
  const frameworks = await step("frameworks", async () => {
    const fws = [...d.readFrameworks(paths.xcframeworks, "debug"), ...(jsi ? [jsi] : [])];
    await d.stageFrameworks(fws, paths.frameworks);
    return fws;
  });

  const previous = previousState?.metroPort;
  const { port: metroPort, reason } = await chooseMetroPort({
    configured: config.metroPort,
    previous,
    isPortFree: d.isPortFree,
    isMetroRunning: d.isMetroRunning,
    findFreePort: d.findFreePort,
  });
  const busy = `Port ${config.metroPort} is busy (not a Metro bundler)`;
  if (reason === "configured-metro") d.log(`Metro is already running on port ${metroPort}; keeping it.`);
  else if (reason === "previous-free") d.log(`${busy}; reusing the previous build's port ${metroPort}.`);
  else if (reason === "previous-metro") d.log(`${busy}; keeping the previous build's port ${metroPort} where Metro is running.`);
  else if (reason === "fallback") d.log(`Port ${config.metroPort} is busy; baking Metro port ${metroPort} into the app.`);
  const lanIp = config.lanIp ?? (await d.detectLanIp());
  if (config.lanIp === undefined) {
    const route = await d.detectLanRoute().catch((): LanRoute => ({}));
    if (suspiciousLanRoute(route)) d.log(tunnelWarning(route));
  }

  const depsFingerprint = await d.depsFingerprint(paths.root);
  // Written without the fingerprint first: a failed xtool-build must not look up to date.
  const state: BuildState = {
    version: 1,
    metroPort,
    lanIp,
    bundleIdentifier: project.bundleIdentifier,
    builtAt: new Date().toISOString(),
    kind: project.kind,
    hasDevClient: project.hasDevClient,
    rnVersion: project.rnVersion,
    ...(previousState?.deviceIp && { deviceIp: previousState.deviceIp }),
    ...(previousState?.deviceUdid && { deviceUdid: previousState.deviceUdid }),
  };
  await step("generate", async () => {
    await d.writeIosXtool({ project, paths, frameworks, metroPort, lanIp, log: d.log });
    await writeState(paths.iosXtool, state);
  });
  await step("xtool-build", () => d.devBuild(d.xtoolBin(config), paths.iosXtool));
  await writeState(paths.iosXtool, { ...state, depsFingerprint });
}
