import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALE_TEMP_MS, sweepStaleTemps } from "../../src/pods/sweep.js";

const SHA = "a".repeat(64);
let cache: string;

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), "pods-sweep-"));
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

/** Creates `rel` (a folder when it ends with `/`), last changed `ageMs` ago. */
function make(rel: string, ageMs: number, now: number): void {
  const p = path.join(cache, rel);
  if (rel.endsWith("/")) {
    mkdirSync(path.join(p, "inner"), { recursive: true });
    writeFileSync(path.join(p, "inner", "f"), "x");
  } else {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "x");
  }
  const t = new Date(now - ageMs);
  utimesSync(p, t, t);
}

describe("sweepStaleTemps", () => {
  const now = Date.now();
  const old = STALE_TEMP_MS + 60 * 60_000;
  const temps = [
    "downloads/.MLImage-1.0.0-beta7.4242-0.tar.gz",
    "downloads/.MLImage-1.0.0-beta7.4242-0.tar.gz.4242.part",
    `extracted/${SHA}.tmp-4242-0/`,
    `extracted/${SHA}.tmp-4242-0.x/`,
    `extracted/${SHA}.tmp-4242-0.list`,
    `extracted/${SHA}.old-4242-0/`,
    `wrapped/${SHA}.tmp-4242-1/`,
    `wrapped/${SHA}.old-4242-1/`,
    "specs/index/all_pods_versions_1_2_3.txt.4242.tmp",
    "specs/MLImage/1.0.0-beta7.podspec.json.4242.tmp",
  ];
  const kept = [
    `downloads/${SHA}.tar.gz`,
    `extracted/${SHA}/`,
    `wrapped/${SHA}/`,
    "specs/index/all_pods_versions_1_2_3.txt",
    "specs/MLImage/1.0.0-beta7.podspec.json",
  ];

  it("removes temporary files and trees older than 24 h, and keeps the cache's entries", async () => {
    for (const rel of [...temps, ...kept]) make(rel, old, now);
    const removed = await sweepStaleTemps(cache, now);
    expect(removed.sort()).toEqual(temps.map((t) => path.join(cache, t.replace(/\/$/, ""))).sort());
    for (const rel of temps) expect(existsSync(path.join(cache, rel)), rel).toBe(false);
    for (const rel of kept) expect(existsSync(path.join(cache, rel)), rel).toBe(true);
  });

  it("keeps temporary files a running build may still use", async () => {
    for (const rel of temps) make(rel, STALE_TEMP_MS - 60 * 60_000, now);
    expect(await sweepStaleTemps(cache, now)).toEqual([]);
    for (const rel of temps) expect(existsSync(path.join(cache, rel)), rel).toBe(true);
  });

  it("does nothing without a cache", async () => {
    expect(await sweepStaleTemps(path.join(cache, "missing"), now)).toEqual([]);
  });
});
