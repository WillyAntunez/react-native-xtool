import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { depsFingerprint } from "../deps.js";
import { configFileOf, loadConfig, type ExpoXtoolConfig, type PodEntry } from "../config.js";
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
import type { BundleSource } from "../pipeline/resourceBundles.js";
import {
  placeableBundles,
  scaffoldedResourceBundles,
  unbundledResources,
  unbundledResourcesLine,
  withUnbundled,
} from "../pipeline/scaffoldResources.js";
import { checkFrameworkSymbols, makeNmRunner } from "../pipeline/symbols.js";
import {
  allowedLimitText,
  allowKnownLimits,
  binaryPodCandidates,
  excludeLines,
  installFailures,
  libraryFailures,
  podPinWarnings,
  scaffoldedPods,
  unresolvedPodLines,
  UnsupportedSetupError,
  type EarlyFailure,
  type LibraryCheckOptions,
} from "../project/earlyChecks.js";
import { entitlementLines, readEntitlements, type AppEntitlements } from "../project/entitlements.js";
import { mergedPodTable, type PodBinary, type PodTable } from "../project/podTable.js";
import {
  detectProjectKind,
  readProject,
  RN_CLI_MISSING,
  type ProjectInfo,
  type ProjectKind,
  type ReadProjectOptions,
} from "../project/index.js";
import { appIconRecord } from "../generate/appIcon.js";
import { readState, writeState, type BuildState } from "../state.js";
import { run } from "../tools/exec.js";
import { devBuild, xtoolBin } from "../tools/xtool.js";
import { emptyTargetsOf } from "../pods/emptyTargets.js";
import type { PodRoot } from "../pods/resolve.js";
import { postPackChecks, postPackPods, type PostPackPods } from "../pods/postPack.js";
import { stagePodBinaries, type StagedPods } from "../pods/stage.js";
import { runPodsStep, type PodsStepDeps, type PodsStepResult } from "../pods/step.js";

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
  /** Binary CocoaPods pods to resolve: `pods` first, `pod-binaries` right before rn-spm. */
  pods?: boolean;
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
 * With binary pods, `pods` comes first (before anything changes in the project) and `pod-binaries` right before rn-spm.
 */
export function buildSteps(state: BuildPlanInput): string[] {
  const steps = plainSteps(state);
  if (!state.pods) return steps;
  return ["pods", ...steps.flatMap((s) => (s === "rn-spm" ? ["pod-binaries", s] : [s]))];
}

function plainSteps(state: BuildPlanInput): string[] {
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
    sources: { rnScripts: RnScripts; expoPlugin: ExpoPlugin; podTable?: PodTable; exclude?: readonly string[]; kind?: ProjectKind },
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
      binary?: Record<string, PodBinary>;
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
  /** The targets without sources of the table pods the scaffolded libraries link (written as empty objects, row 81). */
  emptyTargets: (root: string, opts: LibraryCheckOptions) => string[];
  /** After rn-spm: the resources scaffolded libraries declare that do not reach the app. */
  unbundledResources: (root: string) => { pkg: string; items: string[] }[];
  /** After rn-spm: the scaffolded libraries' `resource_bundles` generate builds into the app. */
  resourceBundles: (root: string) => BundleSource[];
  /** After the early checks: the `ℹ` line per unmapped pod the early checks cannot route offline. */
  unresolvedPodLines: (root: string, opts: LibraryCheckOptions) => string[];
  /** The binary CocoaPods pods the scaffolded libraries depend on (`unmapped` dependencies; excluded libraries skipped). */
  binaryPodCandidates: (root: string, opts: LibraryCheckOptions) => PodRoot[];
  /** The `pods` step: resolve, announce, download, verify, wrap, record the lock. */
  pods: (
    root: string,
    roots: PodRoot[],
    table: PodTable,
    opts: Pick<PodsStepDeps, "podsFile" | "allowed" | "warned" | "log">,
  ) => Promise<PodsStepResult>;
  /** The `pod-binaries` step: ios/build/pod-binaries, rebuilt on every build. */
  stagePods: (paths: ProjectPaths, result: PodsStepResult) => Promise<StagedPods>;
  /** After xtool-build, with binary pods: the packed app's bundles, frameworks and force-loaded classes (spec goal 7). */
  postPack: (appBundle: string, pods: PostPackPods) => Promise<void>;
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
  resourceBundles: scaffoldedResourceBundles,
  binaryPodCandidates: (root, opts) => binaryPodCandidates(root, opts),
  unresolvedPodLines: (root, opts) => unresolvedPodLines(root, opts),
  pods: (root, roots, table, opts) => runPodsStep(root, roots, table, opts),
  stagePods: (paths, result) => stagePodBinaries(paths, result),
  postPack: (appBundle, pods) => postPackChecks(appBundle, pods, makeNmRunner()),
  emptyTargets: (root, opts) => {
    const table = mergedPodTable(opts.pods);
    return emptyTargetsOf(table, [...scaffoldedPods(root, table, opts).values()].flat());
  },
  readEntitlements,
  log: (s) => console.log(s),
};

/** The failed prebuild's error, after removing the ios/ it left half-written, saying so. */
async function prebuildFailure(e: unknown, removeIos: () => Promise<void>): Promise<Error> {
  const reason = e instanceof Error ? e.message : String(e);
  let tail: string;
  try {
    await removeIos();
    tail = "The failed prebuild left ios/ half-written, so rn-xtool removed it; the next build runs expo prebuild again.";
  } catch (r) {
    tail =
      `The failed prebuild left ios/ half-written, and rn-xtool could not remove it (${r instanceof Error ? r.message : String(r)}); ` +
      "delete ios/ before the next build, or run rn-xtool build --clean.";
  }
  return new Error(`${reason}\n${tail}`, { cause: e });
}

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
  const allowedPods = new Set<string>();
  const stopOnKnownLimits = (failures: EarlyFailure[]): void => {
    const marked = allowKnownLimits(failures, config.knownLimits?.allow ?? []);
    for (const f of marked) if (f.allowed) d.log(`⚠ known-limits — ${allowedLimitText(f)}`);
    // The pods step does not warn again for these (row 12).
    for (const f of marked) if (f.allowed) for (const pod of f.pods ?? []) allowedPods.add(`${f.allowKey}\0${pod}`);
    const refused = marked.filter((f) => !f.allowed);
    if (refused.length > 0) throw new UnsupportedSetupError(refused);
  };
  // Before reading the project or writing anything (prebuild, --clean, patches): these setups would otherwise fail
  // minutes into rn-spm or SwiftPM. A Package.swift the project's patches/ create counts already, as in doctor.
  // The kind as readProject will detect it; undetectable here, the checks run without it and readProject says why.
  let kind: ProjectKind | undefined;
  try {
    kind = detectProjectKind(root, config.projectKind);
  } catch {
    kind = undefined;
  }
  const podsFile = configFileOf(config, "pods");
  const libraryChecks: LibraryCheckOptions = {
    ...(config.pods !== undefined ? { pods: config.pods } : {}),
    ...(podsFile !== undefined ? { podsFile } : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  // What the config leaves out comes first: a refusal below may point at "exclude".
  for (const line of excludeLines(root, config.exclude ?? [], { kind, file: configFileOf(config, "exclude") })) d.log(line);
  stopOnKnownLimits([...d.installFailures(root), ...d.libraryFailures(root, libraryChecks)]);
  for (const line of d.podPinWarnings(root, libraryChecks)) d.log(line);
  for (const line of d.unresolvedPodLines(root, libraryChecks)) d.log(line);
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
  const podRoots = d.binaryPodCandidates(root, libraryChecks);
  const steps = buildSteps({
    kind: project.kind,
    hasIos: d.exists(paths.ios),
    clean,
    hasExpoModules: project.hasExpoModules,
    hasExpoConstants: project.hasExpoConstants,
    rnArtifacts: (project.rnScripts === "vendored" || vendoredExpo) && !config.rnArtifactsDir,
    expoPlugin: project.expoPlugin,
    pods: podRoots.length > 0,
  });
  const planned = (name: string): boolean => steps.includes(name);

  // Before anything changes in the project: an unreachable host, a changed file or a short disk stops here.
  const table = mergedPodTable(config.pods);
  const pods = planned("pods")
    ? await step("pods", () =>
        d.pods(paths.root, podRoots, table, {
          ...(podsFile !== undefined ? { podsFile } : {}),
          allowed: config.knownLimits?.allow ?? [],
          warned: (library, pod) => allowedPods.has(`${library}\0${pod}`),
          log: d.log,
        }),
      )
    : undefined;
  const binary = pods !== undefined && Object.keys(pods.binary).length > 0 ? pods.binary : undefined;

  const prebuilds = planned("prebuild") || planned("prebuild --clean");
  if (prebuilds) {
    await step(clean ? "prebuild --clean" : "prebuild", async () => {
      try {
        await d.prebuild(paths.root, clean);
      } catch (e) {
        // rn-xtool prebuilds only without ios/ or on --clean, so this ios/ is the failed run's own: the next build
        // would otherwise skip prebuild and build the half state. A prebuild that failed before writing ios/ (a
        // config that throws) leaves nothing to remove, and its error stays as it is.
        if (!d.exists(paths.ios)) throw e;
        throw await prebuildFailure(e, () => d.remove(paths.ios));
      }
    });
  }
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
      podTable: mergedPodTable(config.pods, binary),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
      kind: project.kind,
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
  // On every build: the scaffolds link ../pod-binaries, and generate force-loads its archives.
  const staged = pods !== undefined && planned("pod-binaries") ? await step("pod-binaries", () => d.stagePods(paths, pods)) : undefined;
  await step("rn-spm", () =>
    d.runRnSpm(paths, {
      rnArtifactsDir: artifactsRoot,
      kind: project.kind,
      rnScripts: project.rnScripts,
      expoPlugin: project.expoPlugin,
      ...(config.pods !== undefined ? { pods: config.pods } : {}),
      ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
      ...(binary !== undefined ? { binary } : {}),
    }),
  );
  // A scaffolded bundle that would hold one file name twice is left out and named, as block 2 did (row 86).
  const scaffolded = placeableBundles(d.resourceBundles(paths.root));
  const resources = unbundledResourcesLine(withUnbundled(d.unbundledResources(paths.root), scaffolded.left));
  if (resources !== undefined) d.log(resources);
  const resourceBundles = [...(pods?.bundles ?? []), ...scaffolded.bundles];
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
  const emptyTargets = [...new Set([...d.emptyTargets(root, libraryChecks), ...(staged?.links.emptyTargets ?? [])])].sort();
  const postPack = pods !== undefined && staged !== undefined ? postPackPods(staged, pods) : undefined;
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
    ...(emptyTargets.length > 0 && { emptyTargets }),
    ...(postPack !== undefined && { postPack }),
  };
  await step("generate", async () => {
    await d.writeIosXtool({
      project,
      paths,
      frameworks,
      metroPort,
      lanIp,
      log: d.log,
      prebuildIcon,
      ...(staged !== undefined ? { pods: staged.links } : {}),
      ...(emptyTargets.length > 0 ? { emptyTargets } : {}),
      ...(resourceBundles.length > 0 ? { resourceBundles } : {}),
    });
    await writeState(paths.iosXtool, state);
  });
  await step("xtool-build", () => d.devBuild(d.xtoolBin(config), paths.iosXtool));
  // A failure leaves the state without the fingerprint, so the next run builds again.
  if (postPack !== undefined) await d.postPack(paths.appBundle, postPack);
  await writeState(paths.iosXtool, { ...state, depsFingerprint });
}
