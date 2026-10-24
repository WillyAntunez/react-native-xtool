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

/** Streams `url` to `dest` via a temp file; verifies size and retries once. */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { minBytes?: number; mode?: number; sha256?: string } = {},
): Promise<void> {
  const minBytes = opts.minBytes ?? 1024 * 1024;
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      const { size } = await stat(tmp);
      if (size <= minBytes) throw new Error(`downloaded file too small (${size} bytes)`);
      if (opts.sha256) {
        const actual = await sha256File(tmp);
        if (actual !== opts.sha256.toLowerCase()) {
          throw new ChecksumError(`checksum mismatch for ${url}: expected sha256 ${opts.sha256}, got ${actual}. If the upstream asset changed, report it at https://github.com/WillyAntunez/expo-xtool/issues; the pin lives in src/versions.ts.`);
        }
      }
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
      await rename(tmp, dest);
      return;
    } catch (err) {
      await rm(tmp, { force: true });
      if (err instanceof ChecksumError) throw err;
      lastErr = err;
    }
  }
  console.error(`Download failed: ${url}`);
  throw new Error(`Could not download ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
