/**
 * The CocoaPods CDN: the sharded version index and the JSON specs, read with rn-xtool's User-Agent (jsDelivr, where the
 * CDN redirects, refuses requests without one) and cached under `<cache>/specs/`. A version's spec is cached once and
 * never fetched again: a published version does not change, and trunk is read-only from 2026-12-02. The version index
 * is fetched when it is missing, when it does not name the pod, or when the resolver asks (no cached version
 * satisfies a requirement).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tilde } from "../commands/setup.js";
import { packageRoot } from "../tools/exec.js";
import { PODS_LINK, PodsError } from "./format.js";
import { parsePodSpec, type PodSpec } from "./spec.js";

export const CDN_BASE = "https://cdn.cocoapods.org";
const REQUEST_TIMEOUT_MS = 60_000;

/** The first three hex digits of md5(pod). */
export function podShard(pod: string): [string, string, string] {
  const md5 = createHash("md5").update(pod).digest("hex");
  return [md5[0]!, md5[1]!, md5[2]!];
}

export function versionIndexUrl(base: string, pod: string): string {
  return `${base}/all_pods_versions_${podShard(pod).join("_")}.txt`;
}

export function specUrl(base: string, pod: string, version: string): string {
  return `${base}/Specs/${podShard(pod).join("/")}/${pod}/${version}/${pod}.podspec.json`;
}

let userAgent: string | undefined;
/** `rn-xtool/<package.json version>`. */
export function podsUserAgent(): string {
  if (userAgent === undefined) {
    const { version } = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version: string };
    userAgent = `rn-xtool/${version}`;
  }
  return userAgent;
}

export interface CdnOptions {
  base?: string;
  /** The pods cache folder (`podsCacheDir()`). */
  cache: string;
  fetch?: typeof fetch;
  /** The library that needs `pod`, for the texts. */
  neededBy: (pod: string) => string;
  /** How long a request may take; 60 s by default. */
  timeoutMs?: number;
}

/** A host rn-xtool could not reach for something not in its cache. */
export class PodsNetworkError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
    /** `the spec of GoogleMLKit 8.0.0`, `the versions of GoogleMLKit`, `MLImage 1.0.0-beta7 (7 KB)`. */
    readonly what: string,
    readonly plural: boolean,
    /** `read` for the CDN, `download` for a pod's file. */
    readonly verb: "read" | "download" = "read",
  ) {
    super(`Cannot reach ${host} (${reason}) to ${verb} ${what}`);
    this.name = "PodsNetworkError";
  }
}

/** "getaddrinfo ENOTFOUND", "connect ECONNREFUSED", else the message. */
export function networkReason(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const read = (c: unknown): string | undefined => {
    const { code, syscall } = (c ?? {}) as { code?: unknown; syscall?: unknown };
    if (typeof code !== "string") return undefined;
    return typeof syscall === "string" ? `${syscall} ${code}` : code;
  };
  const inner = (cause as { errors?: unknown[] } | undefined)?.errors?.[0];
  return read(cause) ?? read(inner) ?? (err instanceof Error ? err.message : String(err));
}

/** Goal 5.4's stop: the host, the reason, what is missing and the cache, with the home folder shown as `~`. */
export function offlineText(e: PodsNetworkError, cache: string): string {
  return `Cannot reach ${e.host} (${e.reason}) to ${e.verb} ${e.what}, which ${e.plural ? "are" : "is"} not in rn-xtool's cache (${tilde(cache)}). Connect to the network and build again; once downloaded, builds use the cache.`;
}

const NOT_ON_TRUNK =
  `rn-xtool reads pods from trunk only; map the pod to a SwiftPM package under "pods" in rn-xtool.config.json, or leave the library out with "exclude". See ${PODS_LINK}`;

/** A name rn-xtool puts in a cache path: no separator, no `.` or `..`. */
export function safeName(name: string): string {
  if (!/^[A-Za-z0-9_.+-]+$/.test(name) || name === "." || name === "..") {
    throw new PodsError(`rn-xtool cannot use "${name}" as a CocoaPods pod name or version. See ${PODS_LINK}`);
  }
  return name;
}

/** Writes through `<file>.<pid>.tmp` and a rename. */
function writeCached(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** GET `url`; the body on 200, `404` on 404; a PodsNetworkError when the host cannot be reached; else the status stop. */
async function get(url: string, what: string, plural: boolean, opts: CdnOptions): Promise<string | 404> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      redirect: "follow",
      headers: { "User-Agent": podsUserAgent() },
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PodsNetworkError(new URL(url).host, networkReason(err), what, plural);
  }
  if (res.status === 404) return 404;
  if (!res.ok) {
    const host = new URL(res.url || url).host;
    throw new PodsError(
      `${host} answered HTTP ${res.status} for ${url} (${what}). Build again later; if it keeps failing, see ${PODS_LINK}`,
    );
  }
  try {
    return await res.text();
  } catch (err) {
    throw new PodsNetworkError(new URL(url).host, networkReason(err), what, plural);
  }
}

/** An answer that is not what was asked for (a proxy's or a captive portal's page): not cached, named. */
function notWhatWasAsked(url: string, what: string, kind: string, text: string): PodsError {
  const shown = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return new PodsError(
    `${new URL(url).host} answered ${url} (${what}) with something other than ${kind} ("${shown}"). Build again later; if it keeps failing, see ${PODS_LINK}`,
  );
}

/** Every line is `Name` or `Name/version/…`. */
const isVersionIndex = (text: string): boolean => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.length > 0 && lines.every((l) => /^[^\s/<>"']+(\/[^\s/<>"']+)*$/.test(l.trim()));
};

function indexFile(cache: string, pod: string): string {
  return path.join(cache, "specs", "index", `all_pods_versions_${podShard(pod).join("_")}.txt`);
}

/** The versions an index file lists for `pod`, or undefined when it does not name it. */
function versionsIn(text: string, pod: string): string[] | undefined {
  for (const line of text.split(/\r?\n/)) {
    const [name, ...versions] = line.trim().split("/");
    if (name === pod) return versions.filter((v) => v !== "");
  }
  return undefined;
}

/**
 * The versions trunk lists for `pod`, from `<cache>/specs/index/all_pods_versions_<a>_<b>_<c>.txt`; fetched when
 * missing, when it does not name the pod, or with `refresh`.
 */
export async function podVersions(pod: string, opts: CdnOptions & { refresh?: boolean }): Promise<string[]> {
  const file = indexFile(opts.cache, safeName(pod));
  if (!opts.refresh && existsSync(file)) {
    const cached = versionsIn(readFileSync(file, "utf8"), pod);
    if (cached !== undefined) return cached;
  }
  const url = versionIndexUrl(opts.base ?? CDN_BASE, pod);
  const what = `the versions of ${pod}`;
  const text = await get(url, what, true, opts);
  if (text !== 404 && !isVersionIndex(text)) throw notWhatWasAsked(url, what, "a CocoaPods version list", text);
  const versions = text === 404 ? undefined : versionsIn(text, pod);
  // Only a list that names the pod is cached: one that does not is read again next time.
  if (text !== 404 && versions !== undefined) writeCached(file, text);
  if (versions === undefined) {
    throw new PodsError(
      `${pod} (needed by ${opts.neededBy(pod)}) is not on the CocoaPods trunk: its version list ${url} does not name it. ${NOT_ON_TRUNK}`,
    );
  }
  return versions;
}

function specFile(cache: string, pod: string, version: string): string {
  return path.join(cache, "specs", safeName(pod), `${safeName(version)}.podspec.json`);
}

/** Parses a spec's text; text that is not JSON is named as the spec's unreadable value. */
function parseSpecText(text: string, pod: string, version: string): PodSpec {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return parsePodSpec(json, { pod, version });
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** The spec of `pod` `version`, from `<cache>/specs/<pod>/<version>.podspec.json`; fetched only when missing, never again. */
export async function podSpec(pod: string, version: string, opts: CdnOptions): Promise<PodSpec> {
  const file = specFile(opts.cache, pod, version);
  if (existsSync(file)) return parseSpecText(readFileSync(file, "utf8"), pod, version);
  const url = specUrl(opts.base ?? CDN_BASE, pod, version);
  const what = `the spec of ${pod} ${version}`;
  const text = await get(url, what, false, opts);
  if (text === 404) {
    throw new PodsError(
      `${pod} ${version} (needed by ${opts.neededBy(pod)}) is not on the CocoaPods trunk: ${url} answered 404. ${NOT_ON_TRUNK}`,
    );
  }
  if (!isJson(text)) throw notWhatWasAsked(url, what, "a JSON spec", text);
  const spec = parseSpecText(text, pod, version);
  writeCached(file, text);
  return spec;
}

/** The versions of `pod` whose spec is cached; read by the offline early check. */
export function cachedSpecVersions(pod: string, cache: string): string[] {
  let names: string[];
  try {
    names = readdirSync(path.join(cache, "specs", safeName(pod)));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".podspec.json")).map((n) => n.slice(0, -".podspec.json".length));
}
