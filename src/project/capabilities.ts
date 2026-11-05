/**
 * What a project has, as patterns rather than versions: whether React Native's prebuilt artifacts exist for its
 * version, whether expo ships its SwiftPM plugin, whether Expo modules come precompiled, which podspec features the
 * dependencies use, and the SwiftPM scripts' shape. `doctor --project` and the drift watch's exploration read it.
 * Only `probeArtifacts` reaches the network (bounded HEAD requests), and only when the slots are not cached and it is
 * not run offline.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { configFileOf, loadConfig } from "../config.js";
import { podsCacheDir, projectPaths } from "../paths.js";
import { PodsNetworkError, type CdnOptions } from "../pods/cdn.js";
import { cachedArchive, headSize } from "../pods/fetch.js";
import { formatSize } from "../pods/format.js";
import { PODS_LOCK, lockedVersions, readPodsLock, unusedLockEntries, type PodsLock } from "../pods/lock.js";
import { SourcePodError, resolveBinaryPods } from "../pods/resolve.js";
import { rawSlotComplete, rnArtifactsCacheRoot, type Flavor } from "../pipeline/rnArtifactsStep.js";
import { orphanPatchLine, orphanPatches, scaffoldPinWarnings } from "../pipeline/patches.js";
import { resolveRnDir, vendoredScriptsRoot } from "../pipeline/rnSpm.js";
import { bareLines, compareVersions, expoPluginFor, releaseLine, rnLineStatus } from "../versions.js";
import { DetectError, detectProjectKind } from "./detect.js";
import {
  allowKnownLimits,
  allowedLimitText,
  binaryPodCandidates,
  earlyFailures,
  excludeLines,
  podPinWarnings,
  type EarlyFailure,
  type LibraryCheckOptions,
} from "./earlyChecks.js";
import { entitlementsCapability, type EntitlementsCapability } from "./entitlements.js";
import { mergedPodTable, type PodTable } from "./podTable.js";
import { attribute, dependencyDirs, podspecFiles, readJson } from "./podspecs.js";
import { andList, expoPackageDir, installedExpoMajor, installedExpoVersion } from "./expo.js";
import { scriptsCapability, type ScriptsCapability } from "./scriptsShape.js";
import type { ProjectKind } from "./types.js";

/** One HEAD request: the HTTP status of `url`. Rejects on a network error or when `signal` aborts. */
export type HeadProbe = (url: string, signal: AbortSignal) => Promise<number>;

export interface ProbeOptions {
  cacheRoot?: string;
  head?: HeadProbe;
  timeoutMs?: number;
  /** Read the cache only: no HEAD request is made, and no binary pod is probed. */
  offline?: boolean;
  /** The binary pods' cache; `podsCacheDir()` by default. */
  podsCache?: string;
  /** The CocoaPods CDN the binary-pod probe reads (a test seam). */
  podsCdnBase?: string;
  /** The fetch the binary-pod probe uses (a test seam). */
  podsFetch?: typeof fetch;
  /** Whether `unzip` is on PATH (a test seam). */
  hasUnzip?: () => boolean;
}

export interface ArtifactsCapability {
  /**
   * cached: both raw slots are complete; local: the config's rnArtifactsDir supplies them (detail: that folder), not
   * probed; published/missing: what the release repositories answered; unknown: not checked; offline: not cached, and
   * the caller asked for no network request (`doctor --report`).
   */
  status: "cached" | "local" | "published" | "missing" | "unknown" | "offline";
  version: string;
  /** "ReactNativeDependencies (release)": artifacts no release repository has. */
  missing: string[];
  detail?: string;
}

/** The downloader's URL helpers (vendor/rn-spm/spm/download-spm-artifacts.js), the URLs the build downloads from. */
interface Downloader {
  rnCoreReleaseUrls(version: string, flavor: Flavor): string[];
  rnDepsReleaseUrls(version: string, flavor: Flavor): string[];
  hermesReleaseUrls(version: string, flavor: Flavor): string[];
  resolveLocalHermesCompilerVersion(rnRoot: string): string | null;
}

/** Loaded with `require`: its `require.main` guard keeps `main` from running. */
function downloader(): Downloader {
  return createRequire(import.meta.url)(path.join(vendoredScriptsRoot(), "spm", "download-spm-artifacts.js")) as Downloader;
}

const defaultHead: HeadProbe = async (url, signal) => {
  try {
    return (await fetch(url, { method: "HEAD", signal })).status;
  } catch (e) {
    // fetch says only "fetch failed"; the reason (DNS, TLS, reset) is in its cause.
    const cause = (e as { cause?: { message?: unknown } }).cause?.message;
    if (!signal.aborted && typeof cause === "string" && cause !== "") throw new Error(`${(e as Error).message}: ${cause}`);
    throw e;
  }
};

/** `p`, or a rejection with the signal's reason once it aborts (a probe that never settles still ends). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const FLAVORS: readonly Flavor[] = ["debug", "release"];

/** Answers that say the repository does not have the object. */
const ABSENT = new Set([404, 410]);

/** Why one URL's answer says nothing about the artifact (undefined: 200, 404 or 410). */
function answerFailure(url: string, answer: PromiseSettledResult<number>): string | undefined {
  if (answer.status === "rejected") {
    const reason: unknown = answer.reason;
    return reason instanceof Error ? reason.message : String(reason);
  }
  if (answer.value === 200 || ABSENT.has(answer.value)) return undefined;
  return `HTTP ${answer.value} from ${new URL(url).host}`;
}

/**
 * Whether React Native `version`'s artifacts can be had. Both raw slots complete under `<cacheRoot>/<version>` →
 * cached, without the network. Otherwise React, ReactNativeDependencies (`version`) and Hermes (the hermes-compiler
 * `rnDir` resolves) are each probed per flavor on every release URL the downloader tries, all at once and within
 * `timeoutMs` in total. An artifact is published when one of its URLs answers 200 (the downloader's own test), and
 * missing when every URL answers 404 or 410. Any other answer (403, 429, 5xx, a redirect left over), a rejection or the
 * timeout leaves the result unknown: a failed probe never reads as missing. `offline` reads the cache only: without
 * both slots the result is offline, and nothing is probed.
 */
export async function probeArtifacts(
  rnDir: string,
  version: string,
  opts: ProbeOptions = {},
): Promise<ArtifactsCapability> {
  const cacheRoot = opts.cacheRoot ?? rnArtifactsCacheRoot();
  if (FLAVORS.every((flavor) => rawSlotComplete(path.join(cacheRoot, version, flavor)))) {
    return { status: "cached", version, missing: [] };
  }
  if (opts.offline) return { status: "offline", version, missing: [] };
  const head = opts.head ?? defaultHead;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const dl = downloader();
  const hermes = dl.resolveLocalHermesCompilerVersion(rnDir);
  const artifacts: { name: string; urls: (flavor: Flavor) => string[] }[] = [
    { name: "React", urls: (f) => dl.rnCoreReleaseUrls(version, f) },
    { name: "ReactNativeDependencies", urls: (f) => dl.rnDepsReleaseUrls(version, f) },
    ...(hermes === null ? [] : [{ name: "Hermes", urls: (f: Flavor) => dl.hermesReleaseUrls(hermes, f) }]),
  ];
  const signal = AbortSignal.timeout(timeoutMs);
  const checks = artifacts.flatMap(({ name, urls }) =>
    FLAVORS.map(async (flavor) => {
      const answers = await Promise.allSettled(
        urls(flavor).map((url) => untilAborted(Promise.resolve().then(() => head(url, signal)), signal)),
      );
      const published = answers.some((a) => a.status === "fulfilled" && a.value === 200);
      const failure = urls(flavor)
        .map((url, i) => answerFailure(url, answers[i]!))
        .find((f) => f !== undefined);
      return { label: `${name} (${flavor})`, published, failure: published ? undefined : failure };
    }),
  );
  const results = await Promise.all(checks);
  const failed = results.find((r) => r.failure !== undefined);
  if (failed !== undefined) {
    const detail = signal.aborted ? `timed out after ${timeoutMs / 1000} s` : failed.failure!;
    return { status: "unknown", version, missing: [], detail };
  }
  const missing = results.filter((r) => !r.published).map((r) => r.label);
  return {
    status: missing.length > 0 ? "missing" : "published",
    version,
    missing,
    ...(hermes === null ? { detail: "Hermes not checked: hermes-compiler is not installed" } : {}),
  };
}

export type PodspecFeature =
  | "subspecs"
  | "compiler_flags"
  | "header_dir"
  | "header_mappings_dir"
  | "vendored_frameworks"
  | "resource_bundles";

/** Each feature as it reads in a podspec's text (comment lines dropped); singular aliases count too. */
const PODSPEC_FEATURES: readonly [PodspecFeature, RegExp][] = [
  ["subspecs", /\.subspec\b/],
  ["compiler_flags", attribute("compiler_flags?")],
  ["header_dir", attribute("header_dir")],
  ["header_mappings_dir", attribute("header_mappings_dir")],
  ["vendored_frameworks", attribute("vendored_frameworks?")],
  ["resource_bundles", attribute("resource_bundles?")],
];

/** The text of each readable podspec of the package at `dir` (`podspecFiles`), comment lines dropped. */
function podspecTexts(dir: string): string[] {
  return podspecFiles(dir).flatMap((file) => {
    try {
      return [readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "")];
    } catch {
      return [];
    }
  });
}

/** Kept here too: callers read the dependencies the way the podspec features do. */
export { dependencyDirs, podspecFiles } from "./podspecs.js";

/**
 * For each tracked feature, the package.json `dependencies` (sorted by name, react-native left out) that resolve from
 * `root` and whose package directory has a podspec using it. The podspecs are read as text, never evaluated.
 */
export function podspecFeatures(root: string): Record<PodspecFeature, string[]> {
  const result = Object.fromEntries(PODSPEC_FEATURES.map(([f]) => [f, [] as string[]])) as Record<PodspecFeature, string[]>;
  for (const { name, dir } of dependencyDirs(root)) {
    const texts = podspecTexts(dir);
    for (const [feature, re] of PODSPEC_FEATURES) if (texts.some((t) => re.test(t))) result[feature].push(name);
  }
  return result;
}

export interface Capabilities {
  /** undefined when the project is neither Expo nor bare (no Expo config and no single ios/*.xcodeproj). */
  kind?: ProjectKind;
  rnVersion?: string;
  expoVersion?: string;
  sdk?: number;
  /** undefined without react-native, like `artifacts`. */
  scripts?: ScriptsCapability;
  artifacts?: ArtifactsCapability;
  /** Whether expo declares a SwiftPM autolinking plugin (package.json or react-native.config.js); undefined without expo. */
  expoPlugin?: "ships" | "none";
  /** Whether expo-modules-core ships ExpoModulesCore prebuilds for both flavors; undefined without expo-modules-core. */
  expoModules?: "precompiled" | "source";
  /** The version of that expo-modules-core; undefined without it. */
  expoModulesCoreVersion?: string;
  podspecs: Record<PodspecFeature, string[]>;
  /** The `ℹ`/`⚠` lines for the config's `exclude` (`excludeLines`); detectCapabilities always sets it. */
  excluded?: string[];
  /**
   * The setups rn-xtool refuses before a build (`earlyFailures`), those the config's `knownLimits.allow` names marked
   * allowed; detectCapabilities always sets it.
   */
  limits?: EarlyFailure[];
  /** The `⚠` line for each of the project's patches whose package is not installed; detectCapabilities always sets it. */
  orphanPatches?: string[];
  /** The `⚠` line for each pod pin that misses a library's podspec requirement; detectCapabilities always sets it. */
  podPins?: string[];
  /**
   * The `⚠` line for each pod a persisted scaffold patch pins at another version than the pod table, or does not pin;
   * detectCapabilities always sets it.
   */
  scaffoldPins?: string[];
  /** The app's entitlements (`entitlementsCapability`); undefined when CODE_SIGN_ENTITLEMENTS is unset. */
  entitlements?: EntitlementsCapability;
  /**
   * The binary CocoaPods pods' lines (`✔`/`ℹ`/`⚠`/`✖ pods — …`): what the lock and the cache hold, or what the probe
   * found, the lock entries no library needs, and unzip; [] without binary pods. detectCapabilities always sets it.
   */
  binaryPods?: string[];
}

/** The SwiftPM settings reader the build's plugin discovery uses (vendor/rn-spm/spm/swiftpm-config.js). */
interface SwiftpmConfigReader {
  /** `swiftpmConfig` from `<root>/package.json` over the deprecated `spm` block of the loaded react-native.config.js. */
  readSwiftpmConfig(root: string, rnConfig: null): { autolinkingPlugin?: unknown } | null;
}

function swiftpmConfigReader(): SwiftpmConfigReader {
  return createRequire(import.meta.url)(path.join(vendoredScriptsRoot(), "spm", "swiftpm-config.js")) as SwiftpmConfigReader;
}

/**
 * Whether expo declares a SwiftPM autolinking plugin where the build looks: `swiftpmConfig.autolinkingPlugin` in its
 * package.json (through the build's own reader), else the deprecated `spm` block of its react-native.config.js. The
 * config is read as text (never loaded), comments dropped.
 */
function expoPluginOf(root: string): "ships" | "none" | undefined {
  const expoDir = expoPackageDir(root, "expo");
  if (expoDir === undefined) return undefined;
  const declared = swiftpmConfigReader().readSwiftpmConfig(expoDir, null)?.autolinkingPlugin;
  if (typeof declared === "string" && declared !== "") return "ships";
  let text = "";
  try {
    text = readFileSync(path.join(expoDir, "react-native.config.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  } catch {
    // No config file: no plugin.
  }
  return /autolinkingPlugin\s*:/.test(text) ? "ships" : "none";
}

function expoModulesOf(root: string): { expoModules: "precompiled" | "source"; version?: string } | undefined {
  const coreDir = expoPackageDir(root, "expo-modules-core");
  if (coreDir === undefined) return undefined;
  const prebuilt = FLAVORS.every((flavor) =>
    existsSync(path.join(coreDir, "prebuilds", "output", flavor, "xcframeworks", "ExpoModulesCore.tar.gz")),
  );
  const version = readJson(path.join(coreDir, "package.json"))?.version;
  return { expoModules: prebuilt ? "precompiled" : "source", ...(typeof version === "string" && { version }) };
}

/** The project kind as `readProject` sees it (the config's `projectKind` first); undefined when detection fails. */
function kindOf(root: string, projectKind: ProjectKind | undefined): ProjectKind | undefined {
  try {
    return detectProjectKind(root, projectKind);
  } catch (e) {
    if (e instanceof DetectError) return undefined;
    throw e;
  }
}

/** Where react-native resolves from `root`, and its version; undefined when it is not installed. */
function installedRn(root: string): { rnDir: string; version: string } | undefined {
  let rnDir: string;
  try {
    rnDir = resolveRnDir(projectPaths(root));
  } catch {
    return undefined;
  }
  const version = readJson(path.join(rnDir, "package.json"))?.version;
  return typeof version === "string" ? { rnDir, version } : undefined;
}

/**
 * What the project at `projectRoot` has. Reads files only; the artifact probe is the one network call, and it is
 * skipped when both of the version's raw slots are in the cache, or with `offline`.
 */
export async function detectCapabilities(projectRoot: string, opts: ProbeOptions = {}): Promise<Capabilities> {
  const root = path.resolve(projectRoot);
  const config = await loadConfig(root);
  const kind = kindOf(root, config.projectKind);
  const rn = installedRn(root);
  const expoVersion = installedExpoVersion(root);
  const podsFile = configFileOf(config, "pods");
  const libraryChecks: LibraryCheckOptions = {
    ...(config.pods !== undefined ? { pods: config.pods } : {}),
    ...(podsFile !== undefined ? { podsFile } : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  if (opts.podsCache !== undefined) libraryChecks.podsCache = opts.podsCache;
  const podTable = mergedPodTable(config.pods);
  const allowed = config.knownLimits?.allow ?? [];
  const limits = allowKnownLimits(earlyFailures(root, libraryChecks), allowed);
  // Started now, so its probe runs alongside the rn-artifacts probe, within the same budget.
  const binaryPods = binaryPodsLines(root, libraryChecks, podTable, opts, { allowed, limits });
  const caps: Capabilities = {
    podspecs: podspecFeatures(root),
    excluded: excludeLines(root, config.exclude ?? [], { kind, file: configFileOf(config, "exclude") }),
    limits,
    podPins: podPinWarnings(root, podTable, libraryChecks),
    orphanPatches: orphanPatches(root).map(orphanPatchLine),
    scaffoldPins: scaffoldPinWarnings(root, podTable, config.exclude, kind),
  };
  if (kind !== undefined) caps.kind = kind;
  const entitlements = entitlementsCapability(root, kind);
  if (entitlements !== undefined) caps.entitlements = entitlements;
  if (expoVersion !== undefined) {
    caps.expoVersion = expoVersion;
    const sdk = installedExpoMajor(root);
    if (sdk !== undefined) caps.sdk = sdk;
    caps.expoPlugin = expoPluginOf(root);
  }
  const core = expoModulesOf(root);
  if (core !== undefined) {
    caps.expoModules = core.expoModules;
    if (core.version !== undefined) caps.expoModulesCoreVersion = core.version;
  }
  if (rn !== undefined) {
    caps.rnVersion = rn.version;
    caps.scripts = scriptsCapability(rn.rnDir, rn.version);
    // The build takes a configured rnArtifactsDir as it is (`--download skip`): nothing is downloaded to probe for.
    caps.artifacts = config.rnArtifactsDir
      ? { status: "local", version: rn.version, missing: [], detail: config.rnArtifactsDir }
      : await probeArtifacts(rn.rnDir, rn.version, opts);
  }
  caps.binaryPods = await binaryPods;
  return caps;
}

/** Whether an executable `unzip` is on PATH. */
function unzipOnPath(): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    if (dir === "") return false;
    try {
      accessSync(path.join(dir, "unzip"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const zipUrl = (url: string): boolean => {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".zip");
  } catch {
    return false;
  }
};

/** "a", "a and b", "a, b and c" */
const listOf = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** One pod the libraries need now: its version, URL, whether it is cached, and its size when known. */
interface NeededPod {
  pod: string;
  version: string;
  url: string;
  cached: boolean;
  size?: number;
}

/** `✔ … in rn-xtool's cache and in the lock`, or `ℹ … ${k} to download from ${hosts} (${size})`. */
function neededLine(pods: readonly NeededPod[], libs: readonly string[]): string {
  const n = pods.length;
  const what = `${n} CocoaPods binar${n === 1 ? "y" : "ies"} for ${listOf(libs)}`;
  const missing = pods.filter((p) => !p.cached);
  if (missing.length === 0) return `✔ pods — ${what}, in rn-xtool's cache and in ${PODS_LOCK}`;
  const hosts = [...new Set(missing.map((p) => new URL(p.url).host))].sort();
  const sizes = missing.map((p) => p.size);
  const size = sizes.some((s) => s === undefined) ? formatSize(undefined) : formatSize(sizes.reduce<number>((a, s) => a + s!, 0));
  return `ℹ pods — ${what}, ${missing.length} to download from ${listOf(hosts)} (${size})`;
}

/**
 * Spec goal 5.2, `doctor --project`'s binary pods: from the lock and the cache when the lock names every pod the
 * libraries depend on; otherwise (open question 6) the CDN's specs and HEAD sizes, within `timeoutMs` (10 s), never
 * with `offline`. A refusal of the resolver fails; an unreachable host or the budget gives `not checked`. A source pod
 * only libraries `knownLimits.allow` names reach is a warning, unless an allowed early refusal names it already (row
 * 12). Then the lock entries no library needs (row 67), and unzip when a pod is a zip (row 24). Never throws.
 */
async function binaryPodsLines(
  root: string,
  checks: LibraryCheckOptions,
  table: PodTable,
  opts: ProbeOptions,
  known: { allowed: readonly string[]; limits: readonly EarlyFailure[] },
): Promise<string[]> {
  const roots = binaryPodCandidates(root, checks);
  let lock: PodsLock;
  try {
    lock = readPodsLock(root);
  } catch (e) {
    return [`⚠ pods — not checked: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (roots.length === 0 && Object.keys(lock.pods).length === 0) return [];
  const cache = opts.podsCache ?? podsCacheDir();
  const libs = [...new Set(roots.map((r) => r.library))].sort();
  const lines: string[] = [];
  const fromLock = (): NeededPod[] =>
    Object.entries(lock.pods)
      .filter(([, e]) => e.neededBy.some((l) => libs.includes(l)))
      .map(([pod, e]) => ({
        pod,
        version: e.version,
        url: e.url,
        cached: cachedArchive(cache, e.sha256, zipUrl(e.url) ? "zip" : "tar.gz") !== undefined,
        size: e.size,
      }));
  let needed: NeededPod[] = [];
  if (roots.length > 0) {
    const podOf = (dependency: string): string => dependency.split("/")[0]!;
    if (roots.every((r) => lock.pods[podOf(r.dependency)] !== undefined)) {
      needed = fromLock();
      lines.push(neededLine(needed, libs));
    } else if (opts.offline) {
      needed = fromLock();
      lines.push("ℹ pods — not checked (offline)");
    } else {
      const timeoutMs = opts.timeoutMs ?? 10_000;
      const signal = AbortSignal.timeout(timeoutMs);
      const base = opts.podsFetch ?? fetch;
      const bounded = ((input: string | URL | Request, init?: RequestInit) =>
        base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch;
      const cdn: CdnOptions = {
        ...(opts.podsCdnBase !== undefined ? { base: opts.podsCdnBase } : {}),
        cache,
        fetch: bounded,
        timeoutMs,
        neededBy: (pod) => (roots.find((r) => podOf(r.dependency) === pod) ?? roots[0]!).library,
      };
      // Whether an early refusal of the library (allowed or not) names the pod already: the line would say it again.
      const early = (library: string, pod: string): boolean =>
        known.limits.some((f) => f.id === "unmapped-pod" && f.allowKey === library && (f.pods ?? []).includes(pod));
      const droppedLines: string[] = [];
      let neededLibs = libs;
      try {
        const probe = async (): Promise<NeededPod[]> => {
          const resolution = await resolveBinaryPods(roots, {
            table,
            locked: lockedVersions(lock),
            cdn,
            ...(known.allowed.length > 0 ? { allowed: (library: string) => known.allowed.includes(library) } : {}),
          });
          for (const dropped of resolution.dropped ?? []) {
            if (!dropped.libraries.every((library) => early(library, dropped.pod))) droppedLines.push(`⚠ pods — ${allowedLimitText(dropped)}`);
          }
          neededLibs = [...new Set(resolution.binary.flatMap((b) => b.neededBy))].sort();
          return Promise.all(
            resolution.binary.map(async (b) => {
              const url = b.spec.source.http ?? "";
              const locked = lock.pods[b.pod];
              const zip = b.spec.source.type === "zip" || (b.spec.source.type === undefined && zipUrl(url));
              const cached =
                locked !== undefined && locked.version === b.version && cachedArchive(cache, locked.sha256, zip ? "zip" : "tar.gz") !== undefined;
              const size = cached ? locked.size : await headSize(url, { fetch: bounded });
              return { pod: b.pod, version: b.version, url, cached, ...(size !== undefined ? { size } : {}) };
            }),
          );
        };
        needed = await untilAborted(probe(), signal);
        lines.push(...droppedLines);
        if (needed.length > 0) lines.push(neededLine(needed, neededLibs));
      } catch (e) {
        // What the build would stop on fails here; only a host the probe could not reach, or the budget, is unknown.
        if (signal.aborted) lines.push(`⚠ pods — not checked: timed out after ${timeoutMs / 1000} s`);
        else if (e instanceof PodsNetworkError) lines.push(`⚠ pods — not checked: ${e.message}`);
        else if (e instanceof SourcePodError && e.libraries.every((library) => early(library, e.pod))) {
          // known-limits fails with the same refusal.
        } else lines.push(`✖ pods — ${e instanceof Error ? e.message : String(e)}`);
        needed = fromLock();
      }
    }
  }
  const unused = unusedLockEntries(lock, new Set(needed.map((p) => p.pod)));
  if (unused.length > 0) {
    lines.push(`ℹ pods — ${PODS_LOCK} also records ${listOf(unused)}, which no library needs now; rn-xtool keeps these entries`);
  }
  const zipped = [
    ...needed.filter((p) => zipUrl(p.url)).map((p) => `${p.pod} ${p.version}`),
    ...Object.entries(lock.pods)
      .filter(([, e]) => zipUrl(e.url))
      .map(([pod, e]) => `${pod} ${e.version}`),
  ];
  if (zipped.length > 0 && !(opts.hasUnzip ?? unzipOnPath)()) {
    lines.push(`✖ pods — ${zipped[0]} is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.`);
  }
  return lines;
}

const SCRIPTS_TEXT: Record<ScriptsCapability["shape"], string> = {
  none: "no SwiftPM scripts",
  "0.87": "SwiftPM scripts without the entry points rn-xtool needs",
  "0.88": "SwiftPM scripts rn-xtool could use, not verified on this line",
  unknown: "SwiftPM scripts rn-xtool does not recognise",
};

/** "no SwiftPM scripts, no prebuilt artifacts for 0.81.5" */
function scriptsText(c: Capabilities, rnVersion: string): string {
  const scripts = c.scripts === undefined ? SCRIPTS_TEXT.none : SCRIPTS_TEXT[c.scripts.shape];
  return c.artifacts?.status === "missing" ? `${scripts}, no prebuilt artifacts for ${rnVersion}` : scripts;
}

/**
 * Why rn-xtool cannot build the project's versions, in words for doctor and the exploration table; undefined when a
 * line covers them (a verified or newer release of a bare row, Expo SDK 57, 58 or newer).
 */
export function unsupportedReason(c: Capabilities): string | undefined {
  const v = c.rnVersion;
  if (v === undefined) return "react-native is not installed: run npm install";
  const minor = releaseLine(v);
  const translator = `${scriptsText(c, v)}; support comes with the translator`;
  if (c.kind === "expo") {
    if (c.sdk === undefined) return "expo is not installed: run npm install";
    if (expoPluginFor(c.sdk) !== undefined) return undefined;
    return `Expo SDK ${c.sdk}: expo ships ${c.expoPlugin === "ships" ? "its" : "no"} SwiftPM plugin; React Native ${minor}: ${translator}`;
  }
  const { status, line } = rnLineStatus(v);
  if (status === "verified" || status === "newer") return undefined;
  if (status === "below") return `React Native ${v}: below the ${line!.minor} floor (${line!.floor}); move react-native to ${line!.floor} or newer`;
  if (status === "prerelease") return `React Native ${v}: a prerelease; rn-xtool supports releases of the ${line!.minor} line from ${line!.floor}`;
  const minors = bareLines().map((l) => l.minor);
  const newest = minors.at(-1);
  if (newest !== undefined && compareVersions(`${minor}.0`, `${newest}.0`) > 0) {
    return (
      `React Native ${minor}: newer than the lines this release supports (${andList(minors)}); a new minor is added ` +
      "once it is verified on a device"
    );
  }
  return `React Native ${minor}: ${translator}`;
}
