#!/usr/bin/env node
// Fetches the pinned upstream tarballs the tests read (tests/tarballs.json) into tests/.cache. Not shipped in the npm
// package.
//   node scripts/fetch-test-tarballs.mjs → packs each tarball that is missing or has another integrity, once more if
//                                          npm pack fails; exits 1 with the reason when a tarball cannot be had
//   RN_XTOOL_FETCH_HEAVY=1 (or --heavy)  → also the `heavy` ones (hundreds of MB, such as skia's prebuilt binaries),
//                                          which are otherwise skipped with a line each; CI does not fetch them, so
//                                          the sweep entries that need them skip there
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** npm's integrity string for these bytes: `sha512-` and the base64 digest. */
export function integrityOf(bytes) {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

const integrityAt = (file) => (existsSync(file) ? integrityOf(readFileSync(file)) : "missing");
const messageOf = (err) => (err instanceof Error ? err.message : String(err)).trim();

export const HEAVY_FETCH = "RN_XTOOL_FETCH_HEAVY=1 node scripts/fetch-test-tarballs.mjs";

/**
 * Makes `dir` hold each entry's `file` with its `integrity`. A file already there with that integrity is kept;
 * otherwise `pack(spec, dir)` writes it, and runs once more when it fails. An entry marked `heavy` is packed only with
 * `heavy`; without it, a missing one is skipped with a line that says how to fetch it. Throws when both runs fail or
 * the file it wrote has another integrity (that file is removed).
 */
export async function fetchAll(entries, { dir, pack, log, heavy = false }) {
  mkdirSync(dir, { recursive: true });
  for (const { spec, file, integrity, heavy: isHeavy } of entries) {
    const at = path.join(dir, file);
    if (integrityAt(at) === integrity) {
      log(`${file}: cached`);
      continue;
    }
    if (isHeavy && !heavy) {
      log(`${file}: skipped (heavy; fetch it with ${HEAVY_FETCH})`);
      continue;
    }
    try {
      await pack(spec, dir);
    } catch (first) {
      log(`npm pack ${spec} failed, trying once more: ${messageOf(first)}`);
      try {
        await pack(spec, dir);
      } catch (second) {
        throw new Error(`npm pack ${spec} failed twice: ${messageOf(second)}`);
      }
    }
    const actual = integrityAt(at);
    if (actual !== integrity) {
      rmSync(at, { force: true });
      throw new Error(`${file}: integrity ${actual}, expected ${integrity}`);
    }
    log(`${file}: fetched`);
  }
}

async function npmPack(spec, dir) {
  try {
    await promisify(execFile)("npm", ["pack", spec, "--pack-destination", dir], { maxBuffer: 1 << 24 });
  } catch (err) {
    throw new Error(err?.stderr?.trim() || messageOf(err));
  }
}

const self = fileURLToPath(import.meta.url);
const isMain = () => {
  try {
    return realpathSync(path.resolve(process.argv[1] ?? "")) === realpathSync(self);
  } catch {
    return false;
  }
};
if (isMain()) {
  const tests = path.join(path.dirname(self), "..", "tests");
  const entries = JSON.parse(readFileSync(path.join(tests, "tarballs.json"), "utf8"));
  try {
    const heavy = process.env.RN_XTOOL_FETCH_HEAVY === "1" || process.argv.slice(2).includes("--heavy");
    await fetchAll(entries, { dir: path.join(tests, ".cache"), pack: npmPack, log: (s) => console.log(s), heavy });
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}
