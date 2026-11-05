import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ExpoXtoolConfig {
  xcodeXipPath?: string;
  metroPort: number;
  lanIp?: string;
  rnArtifactsDir?: string;
  xtoolPath?: string;
  projectKind?: "expo" | "bare";
  /**
   * Refusals of `doctor --project` and `build` to let through, as warnings: a package name allows that library's,
   * "pnpm", "pnp" or "hoisted" that install-level refusal. The build may then fail later.
   */
  knownLimits?: { allow: string[] };
  /**
   * CocoaPods pods a library's podspec depends on, mapped to their SwiftPM packages: merged over rn-xtool's own table
   * (`data/pods.json`) and handed to the scaffolder. Per pod, the config's entry overrides the fields it names and
   * keeps the shipped entry's others (an empty `forwardHeaders` or `subspecs` removes them).
   */
  pods?: Record<string, PodEntry>;
  /**
   * npm packages to leave out of rn-xtool's iOS builds: the autolinking JSON rn-xtool reads gets `platforms.ios: null`
   * for each, as `react-native.config.js` would set it, without changing that file for Xcode, CocoaPods or Android.
   */
  exclude?: string[];
}

/** A CocoaPods pod's SwiftPM package, pinned to one version. `product` is read as `products: [product]`. */
export interface PodEntry {
  url: string;
  exact: string;
  products?: string[];
  product?: string;
  /** `<pod>/<subspec>` dependency → its products. */
  subspecs?: Record<string, string[]>;
  /** A header the package leaves outside its targets (`AppAuth/AppAuth.h`) → the modules a forwarder `@import`s. */
  forwardHeaders?: Record<string, string[]>;
  /**
   * Why a pin outside a podspec's requirement was checked and is meant: the pin check prints an ℹ line with it instead
   * of the ⚠. It holds for the entry's own url and exact only (a config pin of another version drops it).
   */
  outsideRequirement?: string;
  /**
   * The package's targets without sources (GoogleToolboxForMac's `GTMDefines`): Swift Build never writes their object
   * but lists it at link, so rn-xtool writes an empty one in their place before xtool-build. An empty list clears a
   * shipped entry's; a pin to another `exact` or `url` drops it.
   */
  emptyTargets?: string[];
}

/** A config file whose content has the wrong shape; the message names the file and the key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Throws a ConfigError naming `file` when its `knownLimits` is not `{ allow: string[] }`. */
function checkKnownLimits(file: string, config: Partial<ExpoXtoolConfig> | undefined): void {
  if (config === null || typeof config !== "object" || !("knownLimits" in config)) return;
  const knownLimits: unknown = config.knownLimits;
  if (knownLimits === null || typeof knownLimits !== "object" || Array.isArray(knownLimits)) {
    throw new ConfigError(`${file}: knownLimits must be an object with an allow list`);
  }
  const allow: unknown = (knownLimits as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string" && entry !== "")) {
    throw new ConfigError(`${file}: knownLimits.allow must be a list of package names or "pnpm", "pnp", "hoisted"`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Text that goes into a Swift string literal as it is: no whitespace, quote or backslash. */
const PLAIN = /^[^\s"\\]+$/;
const GIT_URL = /^https:\/\/[^\s"\\]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A clang module name, as `@import` takes it (`AppAuth`, `Foo.Bar`). */
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const isNames = (v: unknown, name: RegExp = PLAIN): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && name.test(x));
/** A SwiftPM target name that is safe as a file name. */
const TARGET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A relative path ending in .h, without empty, `.` or `..` segments. */
const isHeaderKey = (h: string): boolean =>
  h.endsWith(".h") && !h.includes("\\") && h.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/**
 * Throws a ConfigError naming `file` and the key when `pods` is not an object of pod names, each mapped to
 * `{ url, exact, products | product, subspecs?, forwardHeaders?, outsideRequirement?, emptyTargets? }`. Used on the configs and on rn-xtool's own table.
 * Only the shape is checked, offline: a well-formed URL or product that does not exist is SwiftPM's to name at the
 * xtool-build step.
 */
export function checkPodEntries(file: string, pods: unknown): void {
  const fail = (key: string, what: string): never => {
    throw new ConfigError(`${file}: ${key} must be ${what}`);
  };
  if (!isRecord(pods)) fail("pods", "an object of CocoaPods pod names");
  for (const [pod, entry] of Object.entries(pods as Record<string, unknown>)) {
    if (!PLAIN.test(pod) || pod.includes("/")) {
      fail(`pods.${pod === "" ? '""' : pod}`, 'a CocoaPods pod name (no "/", spaces or quotes)');
    }
    const e = isRecord(entry) ? entry : {};
    if (typeof e.url !== "string" || !GIT_URL.test(e.url)) fail(`pods.${pod}.url`, "a git URL (https://…)");
    if (typeof e.exact !== "string" || !VERSION.test(e.exact)) fail(`pods.${pod}.exact`, "a version such as 3.0.0");
    const products = e.products === undefined && typeof e.product === "string" ? [e.product] : e.products;
    if (!isNames(products)) fail(`pods.${pod}.products`, "a list of product names");
    if (e.subspecs !== undefined) {
      if (!isRecord(e.subspecs)) fail(`pods.${pod}.subspecs`, "an object of subspec names");
      for (const [name, list] of Object.entries(e.subspecs as Record<string, unknown>)) {
        if (!isNames(list)) fail(`pods.${pod}.subspecs.${name}`, "a list of product names");
      }
    }
    if (e.outsideRequirement !== undefined && (typeof e.outsideRequirement !== "string" || e.outsideRequirement.trim() === "")) {
      fail(`pods.${pod}.outsideRequirement`, "a sentence saying why the pin is outside the requirement");
    }
    // An empty list: none (it clears a shipped entry's).
    if (e.emptyTargets !== undefined && !(Array.isArray(e.emptyTargets) && e.emptyTargets.length === 0) && !isNames(e.emptyTargets, TARGET_NAME)) {
      fail(`pods.${pod}.emptyTargets`, "a list of target names");
    }
    if (e.forwardHeaders !== undefined) {
      if (!isRecord(e.forwardHeaders)) fail(`pods.${pod}.forwardHeaders`, "an object of header paths");
      for (const [header, modules] of Object.entries(e.forwardHeaders as Record<string, unknown>)) {
        if (!isHeaderKey(header) || !isNames(modules, MODULE_NAME)) {
          fail(`pods.${pod}.forwardHeaders.${header}`, "a list of module names, under a relative path ending in .h");
        }
      }
    }
  }
}

function checkPods(file: string, config: Partial<ExpoXtoolConfig> | undefined): void {
  if (config === null || typeof config !== "object" || !("pods" in config)) return;
  checkPodEntries(file, config.pods);
}

function checkExclude(file: string, config: Partial<ExpoXtoolConfig> | undefined): void {
  if (config === null || typeof config !== "object" || !("exclude" in config)) return;
  const exclude: unknown = config.exclude;
  if (!Array.isArray(exclude) || !exclude.every((name) => typeof name === "string" && name !== "")) {
    throw new ConfigError(`${file}: exclude must be a list of package names`);
  }
}

/** The config of a project without rn-xtool.config.json or rn-xtool.config.js. */
export const DEFAULT_CONFIG: Readonly<ExpoXtoolConfig> = { metroPort: 8081 };

/** For each config `loadConfig` returned, the file each key it read came from. */
const SOURCES = new WeakMap<ExpoXtoolConfig, Partial<Record<keyof ExpoXtoolConfig, string>>>();

/** The file `loadConfig` read `key` from (`rn-xtool.config.json` or `rn-xtool.config.js`); undefined for a default. */
export function configFileOf(config: ExpoXtoolConfig, key: keyof ExpoXtoolConfig): string | undefined {
  return SOURCES.get(config)?.[key];
}

export async function loadConfig(projectRoot: string): Promise<ExpoXtoolConfig> {
  let config: ExpoXtoolConfig = { ...DEFAULT_CONFIG };
  const sources: Partial<Record<keyof ExpoXtoolConfig, string>> = {};
  const record = (file: string, values: object | undefined): void => {
    for (const key of Object.keys(values ?? {})) sources[key as keyof ExpoXtoolConfig] = file;
  };

  const jsonPath = join(projectRoot, "rn-xtool.config.json");
  if (existsSync(jsonPath)) {
    const raw = await readFile(jsonPath, "utf8");
    let parsed: Partial<ExpoXtoolConfig>;
    try {
      parsed = JSON.parse(raw) as Partial<ExpoXtoolConfig>;
    } catch (e) {
      // JSON.parse names no file, and a project has several JSON files.
      throw new Error(`rn-xtool.config.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    checkKnownLimits("rn-xtool.config.json", parsed);
    checkPods("rn-xtool.config.json", parsed);
    checkExclude("rn-xtool.config.json", parsed);
    config = { ...config, ...parsed };
    record("rn-xtool.config.json", parsed);
  }

  const jsPath = join(projectRoot, "rn-xtool.config.js");
  if (existsSync(jsPath)) {
    const mod = (await import(pathToFileURL(jsPath).href)) as { default?: Partial<ExpoXtoolConfig> };
    checkKnownLimits("rn-xtool.config.js", mod.default);
    checkPods("rn-xtool.config.js", mod.default);
    checkExclude("rn-xtool.config.js", mod.default);
    config = { ...config, ...mod.default };
    record("rn-xtool.config.js", mod.default);
  }

  SOURCES.set(config, sources);
  return config;
}
