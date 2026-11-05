import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkReason } from "../src/pods/cdn.js";
import { DownloadInsecureRedirectError, downloadFile, sha256File } from "../src/tools/download.js";
import { closedPortBase, startPodsServer, type PodsServer } from "./support/podsServer.js";

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
  it("does not point the user at a source file", async () => {
    const err = await downloadFile("https://x/y", join(dir, "bad"), { sha256: "0".repeat(64) }).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`expected sha256 ${"0".repeat(64)}, got ${sha}`);
    expect((err as Error).message).not.toMatch(/src\/|versions\.ts/);
  });
  it("skips verification when no sha256 is given", async () => {
    await downloadFile("https://x/y", join(dir, "n"));
    expect(existsSync(join(dir, "n"))).toBe(true);
  });
});

describe("downloadFile sizes, headers and causes", () => {
  let server: PodsServer | undefined;
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const small = Buffer.alloc(7000, 3);

  it("accepts a 7 KB file when the expected size says so", async () => {
    server = await startPodsServer({ "/MLImage.tar.gz": { body: small } });
    const dest = join(dir, "a");
    await downloadFile(`${server.base}/MLImage.tar.gz`, dest, { minBytes: 0, expectedBytes: 7000 });
    expect(readFileSync(dest)).toEqual(small);
    const dest2 = join(dir, "b");
    await downloadFile(`${server.base}/MLImage.tar.gz`, dest2, { expectedBytes: 7000 });
    expect(readFileSync(dest2)).toEqual(small);
  });

  it("still rejects a small file when no size is expected", async () => {
    server = await startPodsServer({ "/MLImage.tar.gz": { body: small } });
    await expect(downloadFile(`${server.base}/MLImage.tar.gz`, join(dir, "a"))).rejects.toThrow(/too small \(7000 bytes\)/);
  });

  it("accepts a body equal to the expected size", async () => {
    server = await startPodsServer({ "/f": { body: small } });
    await downloadFile(`${server.base}/f`, join(dir, "a"), { expectedBytes: 7000, checkLength: true });
    expect(server.requests).toEqual(["GET /f"]);
  });

  it("retries a body of another size than expected, then names both sizes", async () => {
    server = await startPodsServer({ "/f": { body: small } });
    const dest = join(dir, "a");
    await expect(downloadFile(`${server.base}/f`, dest, { expectedBytes: 8000 })).rejects.toThrow(
      "downloaded 7000 bytes, expected 8000",
    );
    expect(server.requests).toEqual(["GET /f", "GET /f"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("retries a body shorter than Content-Length, then names both sizes", async () => {
    server = await startPodsServer({ "/f": { body: small, truncate: { at: 3000 } } });
    const err = await downloadFile(`${server.base}/f`, join(dir, "a"), { minBytes: 0, checkLength: true }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("downloaded 3000 bytes, expected 7000");
    expect(server.requests).toEqual(["GET /f", "GET /f"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("succeeds when the retry gets the whole body", async () => {
    server = await startPodsServer({ "/f": { body: small, truncate: { at: 3000, times: 1 } } });
    const dest = join(dir, "a");
    await downloadFile(`${server.base}/f`, dest, { expectedBytes: 7000 });
    expect(readFileSync(dest)).toEqual(small);
    expect(server.requests).toEqual(["GET /f", "GET /f"]);
  });

  it("sends the given headers", async () => {
    server = await startPodsServer({ "/f": { body: small, needsUserAgent: "rn-xtool/" } });
    await downloadFile(`${server.base}/f`, join(dir, "a"), { minBytes: 0, headers: { "User-Agent": "rn-xtool/1.2.3" } });
    expect(server.userAgents).toEqual(["rn-xtool/1.2.3"]);
  });

  it("keeps the network failure as the cause", async () => {
    const base = await closedPortBase();
    const err = await downloadFile(`${base}/f`, join(dir, "a")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBeDefined();
    expect(networkReason((err as Error).cause)).toBe("connect ECONNREFUSED");
  });

  it("keeps the HTTP status in the cause", async () => {
    server = await startPodsServer();
    const err = await downloadFile(`${server.base}/gone`, join(dir, "a")).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/HTTP 404/);
    expect(((err as Error).cause as { status?: number }).status).toBe(404);
  });
});

describe("downloadFile redirects", () => {
  const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });

  it("refuses a redirect from https to plain http when asked, without a retry", async () => {
    const f = vi.fn(async (url: string) => (url === "https://a.invalid/f" ? redirect("http://b.invalid/g") : new Response(body)));
    vi.stubGlobal("fetch", f);
    const dest = join(dir, "a");
    const err = await downloadFile("https://a.invalid/f", dest, { refuseHttpRedirect: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadInsecureRedirectError);
    expect(err).toMatchObject({ from: "https://a.invalid/f", to: "http://b.invalid/g" });
    expect(f.mock.calls.map(([u]) => u)).toEqual(["https://a.invalid/f"]);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("follows redirects that stay on https, hop by hop, when asked", async () => {
    const f = vi.fn(async (url: string) =>
      url === "https://a.invalid/f" ? redirect("/g") : url === "https://a.invalid/g" ? redirect("https://c.invalid/h") : new Response(body),
    );
    vi.stubGlobal("fetch", f);
    const dest = join(dir, "a");
    await downloadFile("https://a.invalid/f", dest, { refuseHttpRedirect: true });
    expect(readFileSync(dest)).toEqual(body);
    expect(f.mock.calls.map(([u]) => u)).toEqual(["https://a.invalid/f", "https://a.invalid/g", "https://c.invalid/h"]);
  });

  it("stops after 20 redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => redirect("/loop")));
    const err = await downloadFile("https://a.invalid/f", join(dir, "a"), { refuseHttpRedirect: true }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/too many redirects/);
  });
});
