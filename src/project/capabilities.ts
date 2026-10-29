/**
 * What a project has, as patterns rather than versions: whether React Native's prebuilt artifacts exist for its
 * version, whether expo ships its SwiftPM plugin, whether Expo modules come precompiled, which podspec features the
 * dependencies use, and the SwiftPM scripts' shape. `doctor --project` and the drift watch's exploration read it.
 * Only `probeArtifacts` reaches the network (bounded HEAD requests), and only when the slots are not cached.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadConfig } from "../config.js";
import { projectPaths } from "../paths.js";
import { rawSlotComplete, rnArtifactsCacheRoot, type Flavor } from "../pipeline/rnArtifactsStep.js";
import { resolveRnDir, vendoredScriptsRoot } from "../pipeline/rnSpm.js";
import { bareLines, compareVersions, expoPluginFor, releaseLine, rnLineStatus } from "../versions.js";
import { DetectError, detectProjectKind } from "./detect.js";
import { andList, expoPackageDir, installedExpoMajor, installedExpoVersion } from "./expo.js";
import { scriptsCapability, type ScriptsCapability } from "./scriptsShape.js";
import type { ProjectKind } from "./types.js";

/** One HEAD request: the HTTP status of `url`. Rejects on a network error or when `signal` aborts. */
export type HeadProbe = (url: string, signal: AbortSignal) => Promise<number>;

export interface ArtifactsCapability {
  /** cached: both raw slots are complete; published/missing: what the release repositories answered; unknown: not checked. */
  status: "cached" | "published" | "missing" | "unknown";
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
 * timeout leaves the result unknown: a failed probe never reads as missing.
 */
export async function probeArtifacts(
  rnDir: string,
  version: string,
  opts: { cacheRoot?: string; head?: HeadProbe; timeoutMs?: number } = {},
): Promise<ArtifactsCapability> {
  const cacheRoot = opts.cacheRoot ?? rnArtifactsCacheRoot();
  if (FLAVORS.every((flavor) => rawSlotComplete(path.join(cacheRoot, version, flavor)))) {
    return { status: "cached", version, missing: [] };
  }
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

/** `<spec>.<name> =` or `<spec>.ios.<name> =`: a pod attribute being set, not a Ruby variable or a `==` test. */
const attribute = (name: string): RegExp => new RegExp(`\\b[A-Za-z_]\\w*\\.(?:ios\\.)?${name}\\s*=(?!=)`);

/** Each feature as it reads in a podspec's text (comment lines dropped); singular aliases count too. */
const PODSPEC_FEATURES: readonly [PodspecFeature, RegExp][] = [
  ["subspecs", /\.subspec\b/],
  ["compiler_flags", attribute("compiler_flags?")],
  ["header_dir", attribute("header_dir")],
  ["header_mappings_dir", attribute("header_mappings_dir")],
  ["vendored_frameworks", attribute("vendored_frameworks?")],
  ["resource_bundles", attribute("resource_bundles?")],
];

function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory `pkg` resolves to from `root`, along Node's node_modules lookup paths (a package whose `exports`
 * hides package.json still counts).
 */
function packageDir(root: string, pkg: string): string | undefined {
  const lookup = createRequire(path.join(root, "package.json")).resolve.paths(pkg) ?? [];
  return lookup.map((dir) => path.join(dir, pkg)).find((dir) => existsSync(path.join(dir, "package.json")));
}

/** The `*.podspec` files directly in `dir`. */
function podspecsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".podspec"))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * The podspecs of the package at `dir`, where autolinking looks: the package root (React Native's CLI), `ios/` (Expo
 * modules) and the `podspecPath` an `expo-module.config.json` declares under `apple`, else `ios`. Comment lines are
 * dropped from each text.
 */
function podspecTexts(dir: string): string[] {
  const config = readJson(path.join(dir, "expo-module.config.json"));
  const declared: unknown = (config?.apple ?? config?.ios)?.podspecPath;
  const declaredFiles = (Array.isArray(declared) ? declared : [declared])
    .filter((p): p is string => typeof p === "string")
    .map((p) => path.join(dir, p));
  const files = new Set([...podspecsIn(dir), ...podspecsIn(path.join(dir, "ios")), ...declaredFiles]);
  return [...files].flatMap((file) => {
    try {
      return [readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "")];
    } catch {
      return [];
    }
  });
}

/** Not autolinked: react-native's own podspecs describe the core, whose artifacts are reported on their own. */
const NOT_AUTOLINKED = new Set(["react-native"]);

/**
 * For each tracked feature, the package.json `dependencies` (sorted by name, react-native left out) that resolve from
 * `root` and whose package directory has a podspec using it. The podspecs are read as text, never evaluated.
 */
export function podspecFeatures(root: string): Record<PodspecFeature, string[]> {
  const result = Object.fromEntries(PODSPEC_FEATURES.map(([f]) => [f, [] as string[]])) as Record<PodspecFeature, string[]>;
  const deps = readJson(path.join(root, "package.json"))?.dependencies;
  const names = deps !== null && typeof deps === "object" ? Object.keys(deps).filter((n) => !NOT_AUTOLINKED.has(n)).sort() : [];
  for (const name of names) {
    const dir = packageDir(root, name);
    if (dir === undefined) continue;
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
async function kindOf(root: string): Promise<ProjectKind | undefined> {
  try {
    return detectProjectKind(root, (await loadConfig(root)).projectKind);
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
 * skipped when both of the version's raw slots are in the cache.
 */
export async function detectCapabilities(
  projectRoot: string,
  opts: { cacheRoot?: string; head?: HeadProbe; timeoutMs?: number } = {},
): Promise<Capabilities> {
  const root = path.resolve(projectRoot);
  const kind = await kindOf(root);
  const rn = installedRn(root);
  const expoVersion = installedExpoVersion(root);
  const caps: Capabilities = { podspecs: podspecFeatures(root) };
  if (kind !== undefined) caps.kind = kind;
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
    caps.artifacts = await probeArtifacts(rn.rnDir, rn.version, opts);
  }
  return caps;
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
