/**
 * The `pods` step of `build` (spec goals 1 and 5): after the early checks and before anything changes in the project,
 * the binary CocoaPods pods the scaffolded libraries depend on are resolved, checked against the iOS SDK, announced,
 * downloaded and verified against rn-xtool-pods.lock.json, extracted and wrapped in rn-xtool's cache, and the lock is
 * recorded. With the lock and a full cache it makes no request.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { filesystemOf as realFilesystemOf, sdkBundle, tilde } from "../commands/setup.js";
import { podsCacheDir } from "../paths.js";
import type { BundleSource } from "../pipeline/resourceBundles.js";
import { allowedLimitText } from "../project/earlyChecks.js";
import type { PodTable } from "../project/podTable.js";
import { packageRoot } from "../tools/exec.js";
import { makeArRunner, type ArRunner } from "./ar.js";
import { extractPod } from "./archive.js";
import { PodsNetworkError, offlineText, type CdnOptions } from "./cdn.js";
import { fetchPodArchive, headSize, verifiedCachedArchive, type DownloadPlan } from "./fetch.js";
import { PODS_LINK, PodsError, formatSize } from "./format.js";
import {
  PODS_LOCK,
  lockedVersions,
  movedLine,
  readPodsLock,
  recordedLine,
  renderPodsLock,
  reResolvedLine,
  writePodsLock,
  type LockEntry,
  type PodsLock,
} from "./lock.js";
import { binaryPinLines } from "./pins.js";
import { resolveBinaryPods, type PodRoot, type Resolution, type ResolvedBinaryPod } from "./resolve.js";
import type { PodsResult } from "./stage.js";
import { sweepStaleTemps } from "./sweep.js";
import { wrapPod, type WrappedPod } from "./wrap.js";

/**
 * The disk a downloaded byte takes: the download, its extracted tree and its wrapped copies in the cache, and the
 * app's copies in ios/build/pod-binaries and ios-xtool/Resources (spec goal 5.5, row 59; 7.5× for ML Kit in the
 * build-only proof).
 */
export const POD_DISK_FACTOR = 8;

/** What the step hands to staging and to `build`: the binary pods as the scaffolder takes them, the lock, the bundles. */
export interface PodsStepResult extends PodsResult {
  binary: Record<string, { product: string }>;
  lock: PodsLock;
  bundles: BundleSource[];
}

export interface PodsStepDeps {
  cdnBase?: string;
  /** The pods cache folder; `podsCacheDir()` by default. */
  cache?: string;
  fetch?: typeof fetch;
  ar?: ArRunner;
  filesystemOf?: (dir: string) => Promise<{ dev: number; freeBytes: number }>;
  /** The iOS SDK folder; the one `rn-xtool setup` installs by default. */
  sdkDir?: string;
  /** A spec's homepage → its terms URL; `data/pod-terms.json` by default. */
  terms?: Record<string, string>;
  /** The config file the config's pods come from, for the pin lines. */
  podsFile?: string;
  /** The config's `knownLimits.allow`: a source pod only these libraries reach is left out with a warning (row 12). */
  allowed?: readonly string[];
  /**
   * Whether the early checks already printed the allowed warning for this library and pod (its cached spec is a git
   * source): the step leaves the pod out before any CDN read and does not warn again (rows 12 and 91).
   */
  warned?: (library: string, pod: string) => boolean;
  log: (l: string) => void;
}

/** The iOS SDK in the Darwin SDK bundle `setup` installs. */
export function defaultSdkDir(): string {
  return path.join(sdkBundle(), "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs", "iPhoneOS.sdk");
}

/** `data/pod-terms.json`: a spec's homepage → the vendor's terms URL (a content fact, not a pod name). */
export function podTerms(): Record<string, string> {
  const file = path.join(packageRoot(), "data", "pod-terms.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { terms: Record<string, string> }).terms;
}

/** "a", "a and b", "a, b and c" */
const andList = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (items: Iterable<string>): string[] => [...new Set(items)].sort(byText);
const hasGlob = (p: string): boolean => /[*?[\]{}]/.test(p);

/** Sizes for the disk text: `formatSize`, in GB from 1 GB up. */
const diskSize = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : formatSize(bytes));

/** The archive kind of a pod's http source: its `type`, else its URL's extension. */
function archiveExt(b: ResolvedBinaryPod): "tar.gz" | "zip" {
  const { type, http = "" } = b.spec.source;
  if (type !== undefined) return type === "zip" ? "zip" : "tar.gz";
  return /\.zip$/i.test(new URL(http).pathname) ? "zip" : "tar.gz";
}

/** Row 46: every framework and library a binary pod links is in the SDK rn-xtool builds with. */
function checkSdk(binary: readonly ResolvedBinaryPod[], sdk: string): void {
  if (!existsSync(path.join(sdk, "System", "Library", "Frameworks"))) return;
  let sdkName = path.basename(sdk);
  try {
    const settings = JSON.parse(readFileSync(path.join(sdk, "SDKSettings.json"), "utf8")) as { DisplayName?: unknown };
    if (typeof settings.DisplayName === "string") sdkName = settings.DisplayName;
  } catch {
    // The folder's name.
  }
  for (const b of binary) {
    const missing = (kind: string, name: string): PodsError =>
      new PodsError(
        `${b.pod} ${b.version} (needed by ${b.neededBy[0]}) links the ${kind} ${name}, which the iOS SDK rn-xtool builds with (${sdkName}) does not have. See ${PODS_LINK}`,
      );
    for (const f of uniqueSorted(b.layers.flatMap((l) => [...l.frameworks, ...l.weakFrameworks]))) {
      if (!existsSync(path.join(sdk, "System", "Library", "Frameworks", `${f}.framework`, `${f}.tbd`))) throw missing("framework", f);
    }
    for (const l of uniqueSorted(b.layers.flatMap((x) => x.libraries))) {
      if (!existsSync(path.join(sdk, "usr", "lib", `lib${l}.tbd`))) throw missing("library", l);
    }
  }
}

interface Download {
  b: ResolvedBinaryPod;
  plan: DownloadPlan;
  /** The locked file at the locked URL, in the cache and re-hashed (row 76): no request. */
  cached?: { file: string; sha256: string; size: number; moved: false };
}

/** Goal 5.3: what is downloaded, how much, from where and whose. */
function announcement(todo: readonly Download[], cache: string, terms: Record<string, string>): string {
  const libs = uniqueSorted(todo.flatMap((t) => t.b.neededBy));
  const n = todo.length;
  const sizes = todo.map((t) => t.plan.expectedBytes);
  const known = sizes.filter((s): s is number => s !== undefined);
  const sum = known.reduce((a, s) => a + s, 0);
  const total = known.length === 0 ? formatSize(undefined) : known.length < n ? `at least ${formatSize(sum)}` : formatSize(sum);
  const hosts = uniqueSorted(todo.map((t) => new URL(t.plan.url).host));
  const listed = [...todo].sort(
    (a, b) => (b.plan.expectedBytes ?? -1) - (a.plan.expectedBytes ?? -1) || byText(a.b.pod, b.b.pod),
  );
  const list = listed.map((t) => `${t.b.pod} ${t.b.version} (${formatSize(t.plan.expectedBytes)})`).join(", ");
  // One sentence per vendor: the authors and homepage, with every license text their pods give.
  const vendors = new Map<string, { authors: string[]; homepage?: string; licenses: string[] }>();
  for (const t of listed) {
    const { authors, homepage, license } = t.b.spec;
    const key = JSON.stringify([authors, homepage ?? null]);
    const v = vendors.get(key) ?? { authors, ...(homepage !== undefined ? { homepage } : {}), licenses: [] };
    const text = license.text ?? license.type;
    if (text !== undefined && !v.licenses.includes(text)) v.licenses.push(text);
    vendors.set(key, v);
  }
  const from = [...vendors.values()]
    .map((v) => {
      const parts = [
        ...(v.licenses.length > 0 ? [v.licenses.map((l) => `"${l}"`).join(", ")] : []),
        ...(v.homepage !== undefined ? [v.homepage] : []),
        ...(v.homepage !== undefined && terms[v.homepage] !== undefined ? [`terms: ${terms[v.homepage]}`] : []),
      ];
      const who = v.authors.length > 0 ? andList(v.authors) : "an unnamed vendor";
      return `From ${who}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}.`;
    })
    .join(" ");
  return (
    `ℹ pods — ${andList(libs)} need${libs.length === 1 ? "s" : ""} ${n} CocoaPods binar${n === 1 ? "y" : "ies"} that ` +
    `${n === 1 ? "is" : "are"} not in rn-xtool's cache, ${total} from ${andList(hosts)}: ${list}. ${from} ` +
    `rn-xtool keeps ${n === 1 ? "it" : "them"} in ${tilde(cache)} and does not copy ${n === 1 ? "it" : "them"} into the project.`
  );
}

/** A stop for the user: an unreachable host becomes goal 5.4's text naming the cache. */
function stopOf(err: unknown, cache: string): unknown {
  return err instanceof PodsNetworkError ? new PodsError(offlineText(err, cache)) : err;
}

export async function runPodsStep(root: string, candidates: readonly PodRoot[], table: PodTable, d: PodsStepDeps): Promise<PodsStepResult> {
  const cache = d.cache ?? podsCacheDir();
  const lock = readPodsLock(root);
  const podOf = (dependency: string): string => dependency.split("/")[0]!;
  // Row 91: the git-source pods the early checks allowed are left out before any CDN read, so a build with the lock and a
  // full cache makes no request.
  const roots = candidates.filter((r) => d.warned?.(r.library, podOf(r.dependency)) !== true);
  const empty: Resolution = { binary: [], sources: [], roots: [], changed: [] };
  if (roots.length === 0) return { resolution: empty, wrapped: [], binary: {}, lock, bundles: [] };
  // Row 73: what a crashed build left behind.
  await sweepStaleTemps(cache);

  const cdn: CdnOptions = {
    ...(d.cdnBase !== undefined ? { base: d.cdnBase } : {}),
    cache,
    ...(d.fetch !== undefined ? { fetch: d.fetch } : {}),
    neededBy: (pod) => (roots.find((r) => podOf(r.dependency) === pod) ?? roots[0]!).library,
  };
  let resolution: Resolution;
  try {
    const allowed = d.allowed ?? [];
    resolution = await resolveBinaryPods(roots, {
      table,
      locked: lockedVersions(lock),
      cdn,
      ...(allowed.length > 0 ? { allowed: (library: string) => allowed.includes(library) } : {}),
    });
  } catch (err) {
    throw stopOf(err, cache);
  }
  for (const dropped of resolution.dropped ?? []) {
    if (dropped.libraries.every((library) => d.warned?.(library, dropped.pod) === true)) continue;
    d.log(`⚠ known-limits — ${allowedLimitText(dropped)}`);
  }
  checkSdk(resolution.binary, d.sdkDir ?? defaultSdkDir());

  const all: Download[] = await Promise.all(resolution.binary.map(async (b) => {
    const locked: LockEntry | undefined = lock.pods[b.pod];
    const ext = archiveExt(b);
    const url = b.spec.source.http!;
    const plan: DownloadPlan = {
      pod: b.pod,
      version: b.version,
      neededBy: b.neededBy[0] ?? roots[0]!.library,
      url,
      ext,
      ...(locked !== undefined ? { locked } : {}),
      ...(b.spec.source.sha256 !== undefined ? { specSha256: b.spec.source.sha256 } : {}),
      ...(b.spec.source.sha1 !== undefined ? { specSha1: b.spec.source.sha1 } : {}),
    };
    // Hashed now, so a damaged file is announced and counted by the disk check like a missing one (review M2).
    const cached = locked?.version === b.version && locked.url === url ? await verifiedCachedArchive(cache, locked, ext) : undefined;
    return { b, plan, ...(cached !== undefined ? { cached } : {}) };
  }));
  const todo = all.filter((t) => t.cached === undefined);
  if (todo.length > 0) {
    await Promise.all(
      todo.map(async (t) => {
        const size = await headSize(t.plan.url, d.fetch !== undefined ? { fetch: d.fetch } : {});
        if (size !== undefined) t.plan.expectedBytes = size;
      }),
    );
    // Row 59: the downloads, their extracted and wrapped trees and the per-app copies (factor 8), checked on the cache's
    // filesystem. A file HEAD gives no length for counts with the size the lock records for this version (review M3).
    const sizeOf = (t: Download): number =>
      t.plan.expectedBytes ?? (t.plan.locked?.version === t.b.version ? t.plan.locked.size : undefined) ?? 0;
    const bytes = todo.reduce((a, t) => a + sizeOf(t), 0);
    const need = bytes * POD_DISK_FACTOR;
    const { freeBytes } = await (d.filesystemOf ?? realFilesystemOf)(cache);
    if (freeBytes < need) {
      throw new PodsError(
        `Not enough free disk space for the CocoaPods binaries: the filesystem of ${tilde(cache)} has ${diskSize(freeBytes)} free, ` +
          `and rn-xtool needs about ${diskSize(need)} there (${todo.length} download${todo.length === 1 ? "" : "s"} ${diskSize(bytes)}, ` +
          `unpacked, wrapped and per-app copies ${diskSize(need - bytes)}). Free some space, then build again.`,
      );
    }
    d.log(announcement(todo, cache, d.terms ?? podTerms()));
  }

  // The downloads first, largest first as announced, so an unreachable host names what is still missing.
  const order = [...todo].sort((a, b) => (b.plan.expectedBytes ?? -1) - (a.plan.expectedBytes ?? -1) || byText(a.b.pod, b.b.pod));
  const fetched = new Map<string, { file: string; sha256: string; size: number; moved: boolean }>();
  for (const t of all) if (t.cached !== undefined) fetched.set(t.b.pod, t.cached);
  for (const [i, t] of order.entries()) {
    try {
      fetched.set(t.b.pod, await fetchPodArchive(t.plan, cache));
    } catch (err) {
      if (!(err instanceof PodsNetworkError)) throw err;
      const more = order.length - i - 1;
      const what = more > 0 ? `${err.what} (and ${more} more)` : err.what;
      throw stopOf(new PodsNetworkError(err.host, err.reason, what, more > 0 || err.plural, err.verb), cache);
    }
  }

  const wrapped: WrappedPod[] = [];
  const bundles: BundleSource[] = [];
  const ar = d.ar ?? makeArRunner();
  for (const { b, plan } of all) {
    const got = fetched.get(b.pod)!;
    const keep = uniqueSorted(
      b.layers.flatMap((l) => [
        ...l.vendoredFrameworks,
        ...Object.values(l.resourceBundles).flat(),
        ...l.sourceFiles,
        ...l.preservePaths,
        ...(l.moduleMap !== undefined ? [l.moduleMap] : []),
      ]),
    );
    const required = uniqueSorted(b.layers.flatMap((l) => l.vendoredFrameworks).filter((p) => !hasGlob(p)));
    const extracted = await extractPod(
      {
        archive: got.file,
        ext: plan.ext,
        sha256: got.sha256,
        pod: b.pod,
        version: b.version,
        // CocoaPods flattens a tarball holding one folder unless the spec says otherwise; a zip only when asked.
        flatten: b.spec.source.flatten ?? plan.ext === "tar.gz",
        keep,
        required,
      },
      cache,
    );
    wrapped.push(
      await wrapPod(
        { pod: b.pod, version: b.version, sha256: got.sha256, neededBy: plan.neededBy, extracted, spec: b.spec, layers: b.layers, headersOnly: b.headersOnly },
        cache,
        ar,
      ),
    );
    const byKey = new Map<string, string[]>();
    for (const l of b.layers) {
      for (const [key, globs] of Object.entries(l.resourceBundles)) {
        const known = byKey.get(key) ?? [];
        byKey.set(key, [...known, ...globs.filter((g) => !known.includes(g))]);
      }
    }
    for (const [key, globs] of byKey) bundles.push({ key, baseDir: extracted, globs, owner: `${b.pod} ${b.version}` });
  }

  // The lock: every resolved pod's entry, the entries no library needs kept (open question 7).
  const pods: Record<string, LockEntry> = { ...lock.pods };
  let recorded = 0;
  const moved: string[] = [];
  for (const { b, plan } of all) {
    const got = fetched.get(b.pod)!;
    const before = lock.pods[b.pod];
    if (before === undefined || before.version !== b.version || before.sha256 !== got.sha256) recorded++;
    if (got.moved) moved.push(movedLine(b.pod, b.version, plan.url));
    pods[b.pod] = { version: b.version, subspecs: b.subspecs, url: plan.url, size: got.size, sha256: got.sha256, neededBy: b.neededBy };
  }
  const next: PodsLock = { lockfileVersion: 1, pods };
  const file = path.join(root, PODS_LOCK);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (resolution.binary.length > 0 && renderPodsLock(next) !== current) writePodsLock(root, next);

  const privacy = uniqueSorted(wrapped.flatMap((w) => w.frameworks.filter((f) => f.privacy.length > 0).map((f) => `${f.name}.framework`)));
  const lines = [
    ...resolution.changed.map(reResolvedLine),
    ...moved,
    ...wrapped.flatMap((w) => w.warnings),
    ...(privacy.length > 0
      ? [
          `ℹ pods — not copied into the app: the PrivacyInfo.xcprivacy inside ${andList(privacy)}. Development builds run without them; ` +
            "privacy manifests are read only at App Store submission.",
        ]
      : []),
    ...binaryPinLines(resolution, table, d.podsFile),
    ...(recorded > 0 ? [recordedLine(recorded)] : []),
  ];
  for (const line of lines) d.log(line);
  return {
    resolution,
    wrapped,
    binary: Object.fromEntries(resolution.roots.map((r) => [r.pod, { product: r.pod }])),
    lock: next,
    bundles,
  };
}
