import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, sha256File } from "../src/tools/download.js";

const body = Buffer.alloc(2 * 1024 * 1024, 7);
const sha = createHash("sha256").update(body).digest("hex");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dl-"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("sha256File", () => {
  it("hashes a file", async () => {
    const f = join(dir, "a");
    writeFileSync(f, "abc");
    expect(await sha256File(f)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("downloadFile checksum", () => {
  it("accepts a matching sha256", async () => {
    const dest = join(dir, "ok");
    await downloadFile("https://x/y", dest, { sha256: sha });
    expect(readFileSync(dest).length).toBe(body.length);
  });
  it("rejects a mismatch without retrying and leaves nothing behind", async () => {
    const dest = join(dir, "bad");
    await expect(downloadFile("https://x/y", dest, { sha256: "0".repeat(64) })).rejects.toThrow(/checksum mismatch/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(dest)).toBe(false);
  });
  it("skips verification when no sha256 is given", async () => {
    await downloadFile("https://x/y", join(dir, "n"));
    expect(existsSync(join(dir, "n"))).toBe(true);
  });
});
