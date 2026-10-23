import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Streams `url` to `dest` via a temp file; verifies size and retries once. */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { minBytes?: number; mode?: number } = {},
): Promise<void> {
  const minBytes = opts.minBytes ?? 1024 * 1024;
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      const { size } = await stat(tmp);
      if (size <= minBytes) throw new Error(`downloaded file too small (${size} bytes)`);
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
      await rename(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      await rm(tmp, { force: true });
    }
  }
  console.error(`Download failed: ${url}`);
  throw new Error(`Could not download ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
