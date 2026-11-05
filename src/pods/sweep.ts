/**
 * Temporary files and trees a killed build left in the pods cache: downloads in progress (`downloads/.<pod>-…`),
 * trees being assembled or swapped out (`<sha256>.tmp-<pid>-<n>…`, `<sha256>.old-<pid>-<n>`), and spec files being
 * written (`….<pid>.tmp`). The `pods` step removes those older than a day when it starts; a running build's own
 * temporary files are younger.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const STALE_TEMP_MS = 24 * 60 * 60_000;

const TREE_TEMP = /\.(tmp|old)-\d+-\d+(\..+)?$/;
const SPEC_TEMP = /\.\d+\.tmp$/;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Removes the cache's temporary entries last changed more than 24 h before `now`; returns their paths. */
export async function sweepStaleTemps(cache: string, now: number = Date.now()): Promise<string[]> {
  const candidates: string[] = [];
  for (const n of await names(path.join(cache, "downloads"))) {
    if (n.startsWith(".")) candidates.push(path.join(cache, "downloads", n));
  }
  for (const area of ["extracted", "wrapped"]) {
    for (const n of await names(path.join(cache, area))) {
      if (TREE_TEMP.test(n)) candidates.push(path.join(cache, area, n));
    }
  }
  const specs = path.join(cache, "specs");
  for (const sub of await names(specs)) {
    for (const n of await names(path.join(specs, sub))) {
      if (SPEC_TEMP.test(n)) candidates.push(path.join(specs, sub, n));
    }
  }
  const removed: string[] = [];
  for (const p of candidates) {
    try {
      if (now - (await lstat(p)).mtimeMs <= STALE_TEMP_MS) continue;
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // Another build removed it first, or it cannot be removed: the sweep is best-effort.
    }
  }
  return removed;
}
