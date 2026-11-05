/**
 * A binary pod's download: fetched from the URL its spec names with rn-xtool's User-Agent, checked against
 * rn-xtool-pods.lock.json and against the spec's own checksum, and cached as `<cache>/downloads/<sha256>.<ext>`. A file
 * whose sha256 differs from the lock is deleted and never retried. Concurrent builds download into their own
 * temporary files and rename the checked file into place; the first rename wins.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DownloadHttpError, DownloadInsecureRedirectError, downloadFile } from "../tools/download.js";
import { PodsNetworkError, networkReason, podsUserAgent, safeName } from "./cdn.js";
import { PODS_LINK, PodsError, formatSize } from "./format.js";
import { PODS_LOCK, type LockEntry } from "./lock.js";

const HEAD_TIMEOUT_MS = 60_000;

export interface DownloadPlan {
  pod: string;
  version: string;
  /** The library that needs the pod, for the texts. */
  neededBy: string;
  url: string;
  ext: "tar.gz" | "zip";
  /** The pod's lock entry; one recorded for another version is not used. */
  locked?: LockEntry;
  specSha256?: string;
  specSha1?: string;
  expectedBytes?: number;
}

/** HEAD with rn-xtool's User-Agent, redirects followed: the Content-Length of a plain body, or undefined. */
export async function headSize(url: string, opts: { fetch?: typeof fetch } = {}): Promise<number | undefined> {
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": podsUserAgent() },
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    const length = res.headers.get("content-length");
    if (!res.ok || res.headers.has("content-encoding") || length === null || !/^\d+$/.test(length)) return undefined;
    return Number(length);
  } catch {
    return undefined;
  }
}

/** `<cache>/downloads/<sha256>.<ext>` when it exists. */
export function cachedArchive(cache: string, sha256: string, ext: string): string | undefined {
  const file = path.join(cache, "downloads", `${sha256}.${ext}`);
  return existsSync(file) ? file : undefined;
}

async function hashFile(file: string, algo: "sha256" | "sha1"): Promise<string> {
  const hash = createHash(algo);
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** A request failed before any answer: fetch's `TypeError("fetch failed")`. */
const unreachable = (err: unknown): boolean => err instanceof TypeError && err.message === "fetch failed";

let sequence = 0;

/**
 * The pod's archive in the cache. A locked entry whose file is cached: no request. Otherwise a download into
 * `<cache>/downloads/.<pod>-<version>.<pid>-<n>.<ext>`, then the sha256 against the lock, then the spec's sha256 or
 * sha1, then a rename to `<sha256>.<ext>` (an existing one wins, and the temporary file is removed). A plain `http://`
 * URL, or a redirect from https to plain http, is downloaded only when the lock records its sha256.
 */
export async function fetchPodArchive(
  plan: DownloadPlan,
  cache: string,
): Promise<{ file: string; sha256: string; size: number; moved: boolean }> {
  const { pod, version } = plan;
  const locked = plan.locked?.version === version ? plan.locked : undefined;
  if (locked !== undefined) {
    const file = cachedArchive(cache, locked.sha256, plan.ext);
    if (file !== undefined) return { file, sha256: locked.sha256, size: (await stat(file)).size, moved: false };
  }
  const host = new URL(plan.url).host;
  const plainHttp = (from: string): PodsError =>
    new PodsError(
      `${pod} ${version} downloads over plain http from ${from}; rn-xtool downloads it only when ${PODS_LOCK} already records its sha256. See ${PODS_LINK}`,
    );
  if (plan.url.startsWith("http://") && locked === undefined) throw plainHttp(host);
  const dir = path.join(cache, "downloads");
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${safeName(pod)}-${safeName(version)}.${process.pid}-${sequence++}.${plan.ext}`);
  try {
    try {
      await downloadFile(plan.url, tmp, {
        minBytes: 0,
        expectedBytes: plan.expectedBytes,
        checkLength: true,
        headers: { "User-Agent": podsUserAgent() },
        refuseHttpRedirect: locked === undefined,
      });
    } catch (err) {
      if (err instanceof DownloadInsecureRedirectError) throw plainHttp(new URL(err.to).host);
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof DownloadHttpError && (cause.status === 404 || cause.status === 410)) {
        throw new PodsError(
          `${host} answered ${cause.status} for ${pod} ${version} (needed by ${plan.neededBy}): ${plan.url}. The vendor no longer serves this file; a machine whose rn-xtool cache holds it keeps building. See ${PODS_LINK}`,
        );
      }
      if (unreachable(cause)) {
        throw new PodsNetworkError(host, networkReason(cause), `${pod} ${version} (${formatSize(plan.expectedBytes)})`, false, "download");
      }
      const reason = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
      throw new PodsError(`Could not download ${pod} ${version} from ${host}: ${reason}. Build again; the cache keeps what was complete.`);
    }
    const sha256 = await hashFile(tmp, "sha256");
    if (locked !== undefined && sha256 !== locked.sha256) {
      throw new PodsError(
        `The file ${host} serves for ${pod} ${version} is not the one ${PODS_LOCK} records (sha256 ${sha256} instead of ${locked.sha256}). rn-xtool does not use it. If you trust the new file, delete the "${pod}" entry from ${PODS_LOCK} and build again.`,
      );
    }
    for (const [algo, want] of [
      ["sha256", plan.specSha256],
      ["sha1", plan.specSha1],
    ] as const) {
      if (want === undefined) continue;
      const got = algo === "sha256" ? sha256 : await hashFile(tmp, "sha1");
      if (got !== want.toLowerCase()) {
        throw new PodsError(
          `The file ${host} serves for ${pod} ${version} does not match the ${algo} its spec names (${got} instead of ${want}). rn-xtool does not use it. See ${PODS_LINK}`,
        );
      }
    }
    const size = (await stat(tmp)).size;
    const file = path.join(dir, `${sha256}.${plan.ext}`);
    if (!existsSync(file)) await rename(tmp, file);
    return { file, sha256, size, moved: locked !== undefined && plan.url !== locked.url };
  } finally {
    await rm(tmp, { force: true });
  }
}
