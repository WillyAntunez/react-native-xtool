import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import { fetchAll, integrityOf } from "../scripts/fetch-test-tarballs.mjs";
import { EXPO_INTEGRITY, mkTmp } from "./support/expoSpm.js";
import { RN_INTEGRITY } from "./support/rnScaffold.js";
import { FETCH_HINT, HEAVY_FETCH_HINT, isHeavy, needsTarball, packageFromTarball, patchedSpm, tarballPath } from "./support/tarballs.js";

type Entry = { spec: string; file: string; integrity: string; heavy?: true };
const MANIFEST = JSON.parse(readFileSync(path.join(packageRoot(), "tests", "tarballs.json"), "utf8")) as Entry[];

const BYTES = new TextEncoder().encode("a pinned tarball\n");
const GOOD: Entry = { spec: "expo@58.0.21", file: "expo-58.0.21.tgz", integrity: integrityOf(BYTES) };
const quiet = () => {};

/** A `pack` that fails `failures` times, then writes `bytes` as the entry's file, as `npm pack` does. */
function packer(failures: number, bytes: Uint8Array = BYTES) {
  let left = failures;
  return vi.fn(async (_spec: string, dir: string) => {
    if (left-- > 0) throw new Error("registry said 503");
    // npm pack exits 254 when the destination folder is missing.
    if (!existsSync(dir)) throw new Error(`ENOENT: ${dir}`);
    writeFileSync(path.join(dir, GOOD.file), bytes);
  });
}

describe("integrityOf", () => {
  it("is npm's sha512 integrity string", () => {
    expect(integrityOf(BYTES)).toBe("sha512-" + createHash("sha512").update(BYTES).digest("base64"));
  });
});

describe("fetchAll", () => {
  it("retries a failed pack once", async () => {
    const dir = mkTmp("tarballs-retry-");
    const pack = packer(1);
    await expect(fetchAll([GOOD], { dir, pack, log: quiet })).resolves.toBeUndefined();
    expect(pack).toHaveBeenCalledTimes(2);
    expect(pack).toHaveBeenCalledWith("expo@58.0.21", dir);
    expect(readFileSync(path.join(dir, GOOD.file))).toEqual(Buffer.from(BYTES));
  });

  it("gives up after the second failure", async () => {
    const pack = packer(2);
    await expect(fetchAll([GOOD], { dir: mkTmp("tarballs-twice-"), pack, log: quiet })).rejects.toThrow(
      new Error("npm pack expo@58.0.21 failed twice: registry said 503"),
    );
    expect(pack).toHaveBeenCalledTimes(2);
  });

  it("rejects a file whose integrity is not the pinned one", async () => {
    const wrong = new TextEncoder().encode("something else\n");
    await expect(fetchAll([GOOD], { dir: mkTmp("tarballs-wrong-"), pack: packer(0, wrong), log: quiet })).rejects.toThrow(
      new Error(`expo-58.0.21.tgz: integrity ${integrityOf(wrong)}, expected ${GOOD.integrity}`),
    );
  });

  it("does not pack a file already present with the pinned integrity", async () => {
    const dir = mkTmp("tarballs-present-");
    writeFileSync(path.join(dir, GOOD.file), BYTES);
    const pack = packer(0);
    await fetchAll([GOOD], { dir, pack, log: quiet });
    expect(pack).not.toHaveBeenCalled();
  });

  it("packs again over a present file with the wrong integrity", async () => {
    const dir = mkTmp("tarballs-stale-");
    writeFileSync(path.join(dir, GOOD.file), "truncated");
    const pack = packer(0);
    await fetchAll([GOOD], { dir, pack, log: quiet });
    expect(pack).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(dir, GOOD.file))).toEqual(Buffer.from(BYTES));
  });

  it("creates a missing cache folder before packing", async () => {
    const dir = path.join(mkTmp("tarballs-mkdir-"), "tests", ".cache");
    const pack = packer(0);
    await fetchAll([GOOD], { dir, pack, log: quiet });
    expect(pack).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dir, GOOD.file))).toBe(true);
  });

  it("skips a heavy tarball unless asked, and says how to fetch it", async () => {
    const dir = mkTmp("tarballs-heavy-");
    const heavy: Entry = { ...GOOD, heavy: true };
    const lines: string[] = [];
    const pack = packer(0);
    await fetchAll([heavy], { dir, pack, log: (s) => lines.push(s) });
    expect(pack).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, GOOD.file))).toBe(false);
    await fetchAll([heavy], { dir, pack, log: (s) => lines.push(s), heavy: true });
    await fetchAll([heavy], { dir, pack, log: (s) => lines.push(s) });
    expect(pack).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "expo-58.0.21.tgz: skipped (heavy; fetch it with RN_XTOOL_FETCH_HEAVY=1 node scripts/fetch-test-tarballs.mjs)",
      "expo-58.0.21.tgz: fetched",
      "expo-58.0.21.tgz: cached",
    ]);
  });

  it("says what it fetched and what it kept", async () => {
    const dir = mkTmp("tarballs-log-");
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    await fetchAll([GOOD], { dir, pack: packer(0), log: (s) => lines.push(s) });
    await fetchAll([GOOD], { dir, pack: packer(0), log: (s) => lines.push(s) });
    expect(lines).toEqual(["expo-58.0.21.tgz: fetched", "expo-58.0.21.tgz: cached"]);
  });
});

describe("tests/tarballs.json", () => {
  it("pins each spec once, under the file name npm pack gives it", () => {
    expect(new Set(MANIFEST.map((e) => e.spec)).size).toBe(MANIFEST.length);
    for (const { spec, file, integrity } of MANIFEST) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at).replace(/^@/, "").replace("/", "-");
      expect(file, spec).toBe(`${name}-${spec.slice(at + 1)}.tgz`);
      expect(integrity, spec).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    // `heavy` is set to true or left out.
    for (const entry of MANIFEST) expect([undefined, true], entry.spec).toContain(entry.heavy);
  });

  it("matches the provenance tests", () => {
    const integrity = (spec: string) => MANIFEST.find((e) => e.spec === spec)?.integrity;
    expect(integrity("expo@58.0.19")).toBe(EXPO_INTEGRITY);
    expect(integrity("react-native@0.88.0")).toBe(RN_INTEGRITY);
  });
});

describe("tests/support/tarballs", () => {
  it("names the fetch command when a tarball is not cached", () => {
    expect(FETCH_HINT).toBe("run: node scripts/fetch-test-tarballs.mjs");
    expect(tarballPath("left-pad@0.0.0")).toBeUndefined();
    expect(packageFromTarball("left-pad@0.0.0")).toBeUndefined();
    expect(needsTarball("left-pad@0.0.0")).toBe(" (needs left-pad@0.0.0 pinned in tests/tarballs.json)");
  });

  const pinned = MANIFEST.find((e) => e.spec === "expo@58.0.21")!;
  it("skips a tarball that is not cached", () => {
    const dir = mkTmp("tarballs-absent-");
    expect(tarballPath(pinned.spec, dir)).toBeUndefined();
    expect(needsTarball(pinned.spec, dir)).toBe(
      " (needs tests/.cache/expo-58.0.21.tgz; run: node scripts/fetch-test-tarballs.mjs)",
    );
  });

  it("fails, not skips, on a cached tarball whose checksum does not match", () => {
    const dir = mkTmp("tarballs-mismatch-");
    writeFileSync(path.join(dir, pinned.file), "truncated");
    expect(needsTarball(pinned.spec, dir)).toBe("");
    expect(() => tarballPath(pinned.spec, dir)).toThrow(
      new Error("tests/.cache/expo-58.0.21.tgz: integrity mismatch; re-run node scripts/fetch-test-tarballs.mjs"),
    );
  });

  it("gives a heavy tarball that is not cached the heavy fetch command", () => {
    const heavy = MANIFEST.find((e) => e.heavy)!;
    expect(HEAVY_FETCH_HINT).toBe("run: RN_XTOOL_FETCH_HEAVY=1 node scripts/fetch-test-tarballs.mjs");
    expect([isHeavy(heavy.spec), isHeavy(pinned.spec), isHeavy("left-pad@0.0.0")]).toEqual([true, false, false]);
    expect(needsTarball(heavy.spec, mkTmp("tarballs-heavy-absent-"))).toBe(` (needs tests/.cache/${heavy.file}; ${HEAVY_FETCH_HINT})`);
  });

  const rn = "react-native@0.88.1";
  it.skipIf(needsTarball(rn) !== "")(`patches its own copy, once, and leaves the pristine one alone${needsTarball(rn)}`, () => {
    const pristine = packageFromTarball(rn)!;
    const spm = patchedSpm(rn)!;
    expect(patchedSpm(rn)).toBe(spm);
    expect(packageFromTarball(rn)).toBe(pristine);
    expect(path.dirname(path.dirname(spm))).not.toBe(pristine);
    expect(readFileSync(path.join(spm, "read-podspec.js"), "utf8")).toContain("function evaluateRubyLocals");
    expect(readFileSync(path.join(pristine, "scripts", "spm", "read-podspec.js"), "utf8")).not.toContain(
      "function evaluateRubyLocals",
    );
    // Its scripts load yargs and micromatch, which an app would have installed; here they come from rn-xtool.
    expect(existsSync(path.join(spm, "..", "..", "node_modules", "yargs"))).toBe(true);
    expect(existsSync(path.join(pristine, "node_modules"))).toBe(false);
  }, 60_000);
});
