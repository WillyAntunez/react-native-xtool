import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

class ChecksumError extends Error {}

/** Hex sha256 of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** A download the server answered with another status than 2xx; `url` is the URL that answered (after redirects). */
export class DownloadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    statusText: string,
  ) {
    super(`HTTP ${status} ${statusText}`.trimEnd());
    this.name = "DownloadHttpError";
  }
}

/** A body of another size than expected; `cause` is the stream's error when the transfer broke off. */
export class DownloadSizeError extends Error {
  constructor(
    readonly size: number,
    readonly expected: number,
    options?: ErrorOptions,
  ) {
    super(`downloaded ${size} bytes, expected ${expected}`, options);
    this.name = "DownloadSizeError";
  }
}

/** A redirect from https to plain http, refused with `refuseHttpRedirect`; never retried. */
export class DownloadInsecureRedirectError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`${from} redirects to plain http: ${to}`);
    this.name = "DownloadInsecureRedirectError";
  }
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** GET `url`, following redirects; with `refuseHttpRedirect`, hop by hop, refusing a step from https to http. */
async function get(url: string, opts: DownloadOptions): Promise<Response> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  if (!opts.refuseHttpRedirect) return fetch(url, { redirect: "follow", headers: opts.headers, signal });
  let current = url;
  for (let hops = 0; ; hops++) {
    const res = await fetch(current, { redirect: "manual", headers: opts.headers, signal });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
    await res.body?.cancel();
    if (hops === MAX_REDIRECTS) throw new Error(`too many redirects from ${url}`);
    const next = new URL(location, current).href;
    if (current.startsWith("https:") && next.startsWith("http:")) throw new DownloadInsecureRedirectError(current, next);
    current = next;
  }
}

export interface DownloadOptions {
  /** Rejects a body of this many bytes or fewer; 1 MiB by default, none when `expectedBytes` is given. */
  minBytes?: number;
  mode?: number;
  sha256?: string;
  headers?: Record<string, string>;
  /** A body of another size is retried once, then rejected: `downloaded ${size} bytes, expected ${n}`. */
  expectedBytes?: number;
  /** Without expectedBytes: compare with the response's Content-Length when it has no Content-Encoding. */
  checkLength?: boolean;
  /** Follows redirects one by one and refuses one from https to plain http (a DownloadInsecureRedirectError). */
  refuseHttpRedirect?: boolean;
}

/** The size the body must have: `expectedBytes`, else (with `checkLength`) a plain Content-Length. */
function expectedSize(res: Response, opts: DownloadOptions): number | undefined {
  if (opts.expectedBytes !== undefined) return opts.expectedBytes;
  if (!opts.checkLength || res.headers.has("content-encoding")) return undefined;
  const length = res.headers.get("content-length");
  return length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Streams `url` to `dest` via `<dest>.<pid>.part`; checks the size and retries once. The final error keeps the last
 * failure as its `cause` (a DownloadHttpError, a DownloadSizeError, or fetch's own error with the network reason).
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const minBytes = opts.minBytes ?? (opts.expectedBytes !== undefined ? 0 : 1024 * 1024);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await get(url, opts);
      if (!res.ok || !res.body) throw new DownloadHttpError(res.status, res.url || url, res.statusText);
      const expected = expectedSize(res, opts);
      let streamErr: unknown;
      let received = 0;
      const counted = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      try {
        await pipeline(counted, createWriteStream(tmp));
      } catch (err) {
        streamErr = err;
      }
      // A broken transfer is named by what it received: the file may hold less, as unflushed writes are dropped.
      const size = streamErr === undefined ? await sizeOf(tmp) : received;
      if (expected !== undefined && size !== expected) {
        throw new DownloadSizeError(size, expected, streamErr === undefined ? undefined : { cause: streamErr });
      }
      if (streamErr !== undefined) throw streamErr;
      if (size <= minBytes) throw new Error(`downloaded file too small (${size} bytes)`);
      if (opts.sha256) {
        const actual = await sha256File(tmp);
        if (actual !== opts.sha256.toLowerCase()) {
          throw new ChecksumError(
            `checksum mismatch for ${url}: expected sha256 ${opts.sha256}, got ${actual}. If the upstream asset changed, report it at https://github.com/WillyAntunez/react-native-xtool/issues.`,
          );
        }
      }
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
      await rename(tmp, dest);
      return;
    } catch (err) {
      await rm(tmp, { force: true });
      if (err instanceof ChecksumError || err instanceof DownloadInsecureRedirectError) throw err;
      lastErr = err;
    }
  }
  console.error(`Download failed: ${url}`);
  throw new Error(`Could not download ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, {
    cause: lastErr,
  });
}
