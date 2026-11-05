import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { depsFingerprint } from "../deps.js";
import { loadConfig, type ExpoXtoolConfig, type PodEntry } from "../config.js";
import { readFlavoredFrameworks, stageFrameworks, type RuntimeFramework } from "../frameworks.js";
import { hasDevSupport, writeIosXtool } from "../generate/iosXtool.js";
import { detectLanIp, detectLanRoute, findFreePort, isMetroRunning, isPortFree, suspiciousLanRoute, tunnelWarning, type LanRoute } from "../net.js";
import { projectPaths, type ProjectPaths } from "../paths.js";
import { generateAppConfig } from "../pipeline/appConfig.js";
import { buildExpoModulesJsi, jsiRnHeaderDirs, type JsiRnHeaders } from "../pipeline/jsi.js";
import { fixLibraryManifests } from "../pipeline/manifests.js";
import { applyPatches } from "../pipeline/patches.js";
import { prepareRnArtifacts } from "../pipeline/rnArtifactsStep.js";
import type { ExpoPlugin, RnScripts } from "../versions.js";
import { runRnSpm } from "../pipeline/rnSpm.js";
import { unbundledResources, unbundledResourcesLine } from "../pipeline/scaffoldResources.js";
import { checkFrameworkSymbols } from "../pipeline/symbols.js";
import {
  allowedLimitText,
  allowKnownLimits,
  excludeLines,
  installFailures,
  libraryFailures,
  podPinWarnings,
  UnsupportedSetupError,
  type EarlyFailure,
  type LibraryCheckOptions,
} from "../project/earlyChecks.js";
import { entitlementLines, readEntitlements, type AppEntitlements } from "../project/entitlements.js";
import { mergedPodTable, type PodTable } from "../project/podTable.js";
import { readProject, RN_CLI_MISSING, type ProjectInfo, type ProjectKind, type ReadProjectOptions } from "../project/index.js";
import { appIconRecord } from "../generate/appIcon.js";
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
  /**
   * Vendored SwiftPM scripts (bare) or the vendored Expo plugin (SDK 57), without a user-supplied `rnArtifactsDir`:
   * rn-xtool prepares the artifacts.
   */
  rnArtifacts: boolean;
  expoPlugin: ExpoPlugin;
}

/** Whether `installed` is xtool's signed form of `bundleIdentifier`: XTL-<one segment>.<bundleIdentifier>, exactly. */
function signedIdOf(installed: string, bundleIdentifier: string): boolean {
  const escaped = bundleIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^XTL-[^.]+\\.${escaped}$`).test(installed);
}

/**
 * Expo: every step but rn-artifacts, with `expo prebuild` first when `ios/` is missing or on `--clean`.
 * Expo on the vendored plugin (SDK 57) also gets rn-artifacts (when planned), and jsi moves before rn-spm
 * because the plugin needs the JSI headers.
 * Bare: never prebuild (`--clean` removes the build outputs instead), rn-artifacts only for the
 * vendored scripts, ExpoModulesJSI only with Expo modules set up, app-config only with expo-constants.
 */
export function buildSteps(state: BuildPlanInput): string[] {
  if (state.kind === "expo") {
    const vendored = state.expoPlugin === "vendored";
    const steps: string[] = BUILD_STEP_NAMES.filter(
      (s) => (s !== "rn-artifacts" || (vendored && state.rnArtifacts)) && (s !== "jsi" || !vendored),
    ).flatMap((s) => (vendored && s === "rn-spm" ? ["jsi", "rn-spm"] : [s]));
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
  /** The install layouts rn-xtool refuses before reading the project (pnpm, Yarn PnP, hoisted packages). */
  installFailures: (root: string) => EarlyFailure[];
  /**
   * The libraries rn-xtool refuses (a Package.swift the project's patches/ create counts, the config's pods map pods),
   * checked with the installs.
   */
  libraryFailures: (root: string, opts: LibraryCheckOptions) => EarlyFailure[];
  /** After the early checks: the `⚠` lines for pod pins that miss a library's podspec requirement. */
  podPinWarnings: (root: string, opts: LibraryCheckOptions) => string[];
  readProject: (root: string, opts?: ReadProjectOptions) => Promise<ProjectInfo>;
  exists: (path: string) => boolean;
  /** Deletes a directory tree (no error when it is missing). */
  remove: (path: string) => Promise<void>;
  prebuild: (root: string, clean: boolean) => Promise<void>;
  /** `podTable`: the merged pod table, for the stale-pin checks of scaffolds. */
  applyPatches: (
    root: string,
    sources: { rnScripts: RnScripts; expoPlugin: ExpoPlugin; podTable?: PodTable; exclude?: readonly string[] },
  ) => Promise<void>;
  /** After patch-package, before rn-spm: rewrites known non-portable snippets in the libraries' own manifests. */
  fixLibraryManifests: (root: string, log: (s: string) => void) => Promise<void>;
  /** Downloads (and adapts when needed) RN's prebuilt artifacts; returns the root for `rn-spm --artifacts`. */
  prepareRnArtifacts: (paths: ProjectPaths, rnVersion: string) => Promise<string>;
  runRnSpm: (
    paths: ProjectPaths,
    opts: {
      rnArtifactsDir?: string;
      kind: ProjectKind;
      rnScripts: RnScripts;
      expoPlugin: ExpoPlugin;
      pods?: Record<string, PodEntry>;
      exclude?: readonly string[];
    },
  ) => Promise<void>;
  buildJsi: (paths: ProjectPaths, opts?: { rnHeaders?: JsiRnHeaders; headersXcframework?: boolean }) => Promise<RuntimeFramework>;
  generateAppConfig: (paths: ProjectPaths) => Promise<void>;
  readFrameworks: (dir: string, flavor: "debug" | "release") => RuntimeFramework[];
  /** G4: throws when an embedded framework imports a symbol another embedded framework does not export. */
  checkFrameworkSymbols: (root: string, fws: RuntimeFramework[]) => Promise<void>;
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
  /** After rn-spm: the resources scaffolded libraries declare that do not reach the app. */
  unbundledResources: (root: string) => { pkg: string; items: string[] }[];
  /** The app's CODE_SIGN_ENTITLEMENTS file (Debug); throws an EntitlementsError when xtool could not sign with it. */
  readEntitlements: (project: ProjectInfo, iosDir: string) => AppEntitlements | undefined;
  log: (s: string) => void;
}

const realDeps: BuildDeps = {
  loadConfig,
  installFailures: (root) => installFailures(root),
  libraryFailures: (root, opts) => libraryFailures(root, opts),
  podPinWarnings: (root, opts) => podPinWarnings(root, mergedPodTable(opts.pods), opts),
  readProject,
  exists: existsSync,
  remove: (path) => rm(path, { recursive: true, force: true }),
  prebuild: (root, clean) =>
    run("npx", ["expo", "prebuild", "--platform", "ios", "--no-install", ...(clean ? ["--clean"] : [])], {
      cwd: root,
    }),
  applyPatches: (root, sources) => applyPatches(root, undefined, sources),
  fixLibraryManifests,
  prepareRnArtifacts: (paths, rnVersion) => prepareRnArtifacts(paths, rnVersion),
  runRnSpm,
  buildJsi: buildExpoModulesJsi,
  generateAppConfig,
  readFrameworks: readFlavoredFrameworks,
  checkFrameworkSymbols: (root, fws) => checkFrameworkSymbols(root, fws),
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
  unbundledResources,
  readEntitlements,
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
  // Known limits the config allows are warnings; the others stop the build.
  const stopOnKnownLimits = (failures: EarlyFailure[]): void => {
    const marked = allowKnownLimits(failures, config.knownLimits?.allow ?? []);
    for (const f of marked) if (f.allowed) d.log(`⚠ known-limits — ${allowedLimitText(f)}`);
    const refused = marked.filter((f) => !f.allowed);
    if (refused.length > 0) throw new UnsupportedSetupError(refused);
  };
  // Before reading the project or writing anything (prebuild, --clean, patches): these setups would otherwise fail
  // minutes into rn-spm or SwiftPM. A Package.swift the project's patches/ create counts already, as in doctor.
  const libraryChecks: LibraryCheckOptions = {
    ...(config.pods !== undefined ? { pods: config.pods } : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
  };
  // What the config leaves out comes first: a refusal below may point at "exclude".
  for (const line of excludeLines(root, config.exclude ?? [])) d.log(line);
  stopOnKnownLimits([...d.installFailures(root), ...d.libraryFailures(root, libraryChecks)]);
  for (const line of d.podPinWarnings(root, libraryChecks)) d.log(line);
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

  // SDK 57: the vendored Expo plugin builds against RN's prebuilt artifacts and needs the JSI headers first.
  const vendoredExpo = project.kind === "expo" && project.expoPlugin === "vendored";
  const steps = buildSteps({
    kind: project.kind,
    hasIos: d.exists(paths.ios),
    clean,
    hasExpoModules: project.hasExpoModules,
    hasExpoConstants: project.hasExpoConstants,
    rnArtifacts: (project.rnScripts === "vendored" || vendoredExpo) && !config.rnArtifactsDir,
    expoPlugin: project.expoPlugin,
  });
  const planned = (name: string): boolean => steps.includes(name);

  const prebuilds = planned("prebuild") || planned("prebuild --clean");
  if (prebuilds) await step(clean ? "prebuild --clean" : "prebuild", () => d.prebuild(paths.root, clean));
  // Before anything else changes (on Expo, once prebuild wrote the pbxproj): what xtool drops when it signs, or why it
  // cannot sign at all.
  const entitlements = d.readEntitlements(project, paths.ios);
  if (entitlements !== undefined) for (const line of entitlementLines(entitlements, project.bundleIdentifier)) d.log(line);
  // The app config icon this prebuild turned into the icon set; without a prebuild, the last one's record stays.
  // With no record (the user ran expo prebuild, or the state predates it), the current icon is recorded silently,
  // so a later change warns.
  const prebuildIcon =
    prebuilds || (previousState?.prebuildIcon === undefined && project.kind === "expo")
      ? await appIconRecord(project)
      : previousState?.prebuildIcon;
  if (planned("clean")) {
    // Bare: the user's ios/ is theirs; only what the pipeline generated goes.
    await step("clean", async () => {
      await d.remove(paths.iosBuild);
      await d.remove(paths.iosXtool);
    });
  }
  // Library manifests last: idempotent, so a project's persisted patch-package fix of the same snippet applies first.
  await step("patches", async () => {
    await d.applyPatches(paths.root, {
      rnScripts: project.rnScripts,
      expoPlugin: project.expoPlugin,
      podTable: mergedPodTable(config.pods),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
    });
    await d.fixLibraryManifests(paths.root, d.log);
  });
  const preparedArtifacts = planned("rn-artifacts")
    ? await step("rn-artifacts", () => d.prepareRnArtifacts(paths, project.rnVersion))
    : undefined;
  const artifactsRoot = preparedArtifacts ?? config.rnArtifactsDir;
  const buildJsi = (): Promise<RuntimeFramework> => {
    if (!vendoredExpo) return d.buildJsi(paths);
    if (artifactsRoot === undefined) {
      throw new Error("internal error: the SDK 57 jsi step has no React Native artifacts (rn-artifacts was not planned and rnArtifactsDir is unset)");
    }
    return d.buildJsi(paths, { rnHeaders: jsiRnHeaderDirs(artifactsRoot), headersXcframework: true });
  };
  let jsi = vendoredExpo && planned("jsi") ? await step("jsi", buildJsi) : undefined;
  await step("rn-spm", () =>
    d.runRnSpm(paths, {
      rnArtifactsDir: artifactsRoot,
      kind: project.kind,
      rnScripts: project.rnScripts,
      expoPlugin: project.expoPlugin,
      ...(config.pods !== undefined ? { pods: config.pods } : {}),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
    }),
  );
  const resources = unbundledResourcesLine(d.unbundledResources(paths.root));
  if (resources !== undefined) d.log(resources);
  // Expo 58 and bare: jsi after rn-spm, as before.
  if (!vendoredExpo && planned("jsi")) jsi = await step("jsi", buildJsi);
  if (planned("app-config")) await step("app-config", () => d.generateAppConfig(paths));
  const frameworks = await step("frameworks", async () => {
    const fws = [...d.readFrameworks(paths.xcframeworks, "debug"), ...(jsi ? [jsi] : [])];
    // Before staging: a precompiled module built against another core would crash the app at launch.
    await d.checkFrameworkSymbols(paths.root, fws);
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
    ...(hasDevSupport(project) && { devSupport: true }),
    rnVersion: project.rnVersion,
    name: project.name,
    slug: project.slug,
    ...(prebuildIcon && { prebuildIcon }),
    ...(previousState?.deviceIp && { deviceIp: previousState.deviceIp }),
    ...(previousState?.deviceUdid && { deviceUdid: previousState.deviceUdid }),
    // The app on the iPhone keeps its id until the next install; a changed bundle id makes it another app.
    ...(previousState?.installedBundleId !== undefined &&
      signedIdOf(previousState.installedBundleId, project.bundleIdentifier) && {
        installedBundleId: previousState.installedBundleId,
      }),
  };
  await step("generate", async () => {
    await d.writeIosXtool({ project, paths, frameworks, metroPort, lanIp, log: d.log, prebuildIcon });
    await writeState(paths.iosXtool, state);
  });
  await step("xtool-build", () => d.devBuild(d.xtoolBin(config), paths.iosXtool));
  await writeState(paths.iosXtool, { ...state, depsFingerprint });
}
