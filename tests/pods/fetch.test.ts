import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import { PodsNetworkError, offlineText, podsUserAgent } from "../../src/pods/cdn.js";
import { cachedArchive, fetchPodArchive, headSize, type DownloadPlan } from "../../src/pods/fetch.js";
import { durable } from "../../src/pods/durable.js";
import type { LockEntry } from "../../src/pods/lock.js";
import { tilde } from "../../src/commands/setup.js";
import { closedPortBase, startPodsServer, type PodsServer } from "../support/podsServer.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
const HOST = "example.invalid";
const PATH = "/dl/cpdc/0a1b2c/MLImage-1.0.0-beta7.tar.gz";
const URL_ = `https://${HOST}${PATH}`;
const body = Buffer.alloc(7000, 5);
const other = Buffer.alloc(7000, 6);
const hex = (algo: string, b: Buffer): string => createHash(algo).update(b).digest("hex");
const SHA = hex("sha256", body);
const realFetch = globalThis.fetch;
let cache: string;
let server: PodsServer | undefined;

/** Sends requests for example.invalid (https or http) to `base`, so tests use the fixtures' URLs. */
function routeTo(base: string): void {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(u.hostname === HOST ? `${base}${u.pathname}${u.search}` : input, init);
  });
}

async function serve(routes: Parameters<typeof startPodsServer>[0]): Promise<PodsServer> {
  server = await startPodsServer(routes);
  routeTo(server.base);
  return server;
}

const plan = (extra: Partial<DownloadPlan> = {}): DownloadPlan => ({
  pod: "MLImage",
  version: "1.0.0-beta7",
  neededBy: LIB,
  url: URL_,
  ext: "tar.gz",
  expectedBytes: 7000,
  ...extra,
});
const locked = (extra: Partial<LockEntry> = {}): LockEntry => ({
  version: "1.0.0-beta7",
  subspecs: [],
  url: URL_,
  size: 7000,
  sha256: SHA,
  neededBy: [LIB],
  ...extra,
});
const downloads = (): string[] => (existsSync(path.join(cache, "downloads")) ? readdirSync(path.join(cache, "downloads")) : []);

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), "pods-fetch-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  rmSync(cache, { recursive: true, force: true });
});

describe("headSize", () => {
  it("reads Content-Length with rn-xtool's User-Agent, following redirects", async () => {
    server = await startPodsServer({ "/a": { redirect: "/b" }, "/b": { body, needsUserAgent: "rn-xtool/" } });
    expect(await headSize(`${server.base}/a`)).toBe(7000);
    expect(server.requests).toEqual(["HEAD /a", "HEAD /b"]);
    expect(server.userAgents).toEqual([podsUserAgent(), podsUserAgent()]);
    expect(server.encodings).toEqual(["identity", "identity"]);
  });

  it("is undefined without an answer, or with an encoded body", async () => {
    server = await startPodsServer({ "/z": { body, headers: { "content-encoding": "gzip" } } });
    expect(await headSize(`${server.base}/missing`)).toBeUndefined();
    expect(await headSize(`${server.base}/z`)).toBeUndefined();
    expect(await headSize(`${await closedPortBase()}/a`)).toBeUndefined();
  });

  it("uses the given fetch", async () => {
    const fake = vi.fn(async () => new Response(null, { headers: { "content-length": "42" } }));
    expect(await headSize(URL_, { fetch: fake as unknown as typeof fetch })).toBe(42);
    expect(fake).toHaveBeenCalledWith(URL_, expect.objectContaining({ method: "HEAD", redirect: "follow" }));
  });
});

describe("cachedArchive", () => {
  it("names a cached download by its sha256", () => {
    expect(cachedArchive(cache, SHA, "tar.gz")).toBeUndefined();
    mkdirSync(path.join(cache, "downloads"));
    writeFileSync(path.join(cache, "downloads", `${SHA}.tar.gz`), body);
    expect(cachedArchive(cache, SHA, "tar.gz")).toBe(path.join(cache, "downloads", `${SHA}.tar.gz`));
    expect(cachedArchive(cache, SHA, "zip")).toBeUndefined();
  });
});

describe("fetchPodArchive", () => {
  it("downloads MLImage's small archive", async () => {
    const s = await serve({ [PATH]: { body, needsUserAgent: "rn-xtool/" } });
    const got = await fetchPodArchive(plan(), cache);
    expect(got).toEqual({ file: path.join(cache, "downloads", `${SHA}.tar.gz`), sha256: SHA, size: 7000, moved: false });
    expect(readFileSync(got.file)).toEqual(body);
    expect(downloads()).toEqual([`${SHA}.tar.gz`]);
    expect(s.userAgents).toEqual([podsUserAgent()]);
    expect(s.encodings).toEqual(["identity"]);
  });

  it("downloads without an expected size", async () => {
    await serve({ [PATH]: { body } });
    const got = await fetchPodArchive(plan({ expectedBytes: undefined }), cache);
    expect(got.size).toBe(7000);
  });

  it("makes no request for a locked file already cached", async () => {
    const s = await serve({ [PATH]: { body } });
    mkdirSync(path.join(cache, "downloads"));
    writeFileSync(path.join(cache, "downloads", `${SHA}.tar.gz`), body);
    const got = await fetchPodArchive(plan({ locked: locked() }), cache);
    expect(got).toEqual({ file: path.join(cache, "downloads", `${SHA}.tar.gz`), sha256: SHA, size: 7000, moved: false });
    expect(s.requests).toEqual([]);
  });

  it("downloads again a locked file whose cached bytes changed", async () => {
    const s = await serve({ [PATH]: { body } });
    mkdirSync(path.join(cache, "downloads"));
    writeFileSync(path.join(cache, "downloads", `${SHA}.tar.gz`), body.subarray(0, 4096));
    const got = await fetchPodArchive(plan({ locked: locked() }), cache);
    expect(got).toEqual({ file: path.join(cache, "downloads", `${SHA}.tar.gz`), sha256: SHA, size: 7000, moved: false });
    expect(readFileSync(got.file)).toEqual(body);
    expect(s.requests).toEqual([`GET ${PATH}`]);
  });

  it("syncs a download and its folder before it counts as cached", async () => {
    await serve({ [PATH]: { body } });
    const synced: string[] = [];
    const file = vi.spyOn(durable, "syncFile").mockImplementation(async (p) => void synced.push(p));
    const folder = vi.spyOn(durable, "syncDir").mockImplementation(async (p) => void synced.push(`${p}/`));
    await fetchPodArchive(plan(), cache);
    file.mockRestore();
    folder.mockRestore();
    expect(synced).toHaveLength(2);
    expect(path.dirname(synced[0]!)).toBe(path.join(cache, "downloads"));
    expect(synced[1]).toBe(`${path.join(cache, "downloads")}/`);
  });

  it("downloads a locked file that is not cached and checks it", async () => {
    const s = await serve({ [PATH]: { body } });
    const got = await fetchPodArchive(plan({ locked: locked() }), cache);
    expect(got.sha256).toBe(SHA);
    expect(s.requests).toEqual([`GET ${PATH}`]);
  });

  it("deletes a file whose sha256 differs from the lock and stops without a retry", async () => {
    const s = await serve({ [PATH]: { body: other } });
    await expect(fetchPodArchive(plan({ locked: locked() }), cache)).rejects.toThrow(
      `The file ${HOST} serves for MLImage 1.0.0-beta7 is not the one rn-xtool-pods.lock.json records (sha256 ${hex("sha256", other)} instead of ${SHA}). rn-xtool does not use it. If you trust the new file, delete the "MLImage" entry from rn-xtool-pods.lock.json and build again.`,
    );
    expect(s.requests).toEqual([`GET ${PATH}`]);
    expect(downloads()).toEqual([]);
  });

  it("updates the URL when the moved file has the locked sha256", async () => {
    const moved = "/dl/cpdc/ffff/MLImage-1.0.0-beta7.tar.gz";
    await serve({ [moved]: { body } });
    const got = await fetchPodArchive(plan({ url: `https://${HOST}${moved}`, locked: locked() }), cache);
    expect(got.moved).toBe(true);
    expect(got.sha256).toBe(SHA);
  });

  it("downloads a locked, cached file from its spec's new URL and checks it against the lock", async () => {
    const moved = "/dl/cpdc/ffff/MLImage-1.0.0-beta7.tar.gz";
    const s = await serve({ [moved]: { body } });
    mkdirSync(path.join(cache, "downloads"));
    writeFileSync(path.join(cache, "downloads", `${SHA}.tar.gz`), body);
    const got = await fetchPodArchive(plan({ url: `https://${HOST}${moved}`, locked: locked() }), cache);
    expect(got).toEqual({ file: path.join(cache, "downloads", `${SHA}.tar.gz`), sha256: SHA, size: 7000, moved: true });
    expect(s.requests).toEqual([`GET ${moved}`]);
    expect(downloads()).toEqual([`${SHA}.tar.gz`]);
    s.routes[moved] = { body: other };
    await expect(fetchPodArchive(plan({ url: `https://${HOST}${moved}`, locked: locked() }), cache)).rejects.toThrow(
      `is not the one rn-xtool-pods.lock.json records (sha256 ${hex("sha256", other)} instead of ${SHA})`,
    );
    expect(readFileSync(path.join(cache, "downloads", `${SHA}.tar.gz`))).toEqual(body);
  });

  it("treats a moved file with another sha256 as a mismatch", async () => {
    const moved = "/dl/cpdc/ffff/MLImage-1.0.0-beta7.tar.gz";
    await serve({ [moved]: { body: other } });
    await expect(fetchPodArchive(plan({ url: `https://${HOST}${moved}`, locked: locked() }), cache)).rejects.toThrow(
      `is not the one rn-xtool-pods.lock.json records (sha256 ${hex("sha256", other)} instead of ${SHA})`,
    );
    expect(downloads()).toEqual([]);
  });

  it("does not check a file against the lock entry of another version", async () => {
    await serve({ [PATH]: { body } });
    const got = await fetchPodArchive(plan({ locked: locked({ version: "1.0.0-beta6", sha256: "a".repeat(64) }) }), cache);
    expect(got).toMatchObject({ sha256: SHA, moved: false });
  });

  it.each(["sha256", "sha1"] as const)("checks a spec's own %s when it names one", async (algo) => {
    await serve({ [PATH]: { body } });
    const key = algo === "sha256" ? "specSha256" : "specSha1";
    const good = await fetchPodArchive(plan({ [key]: hex(algo, body).toUpperCase() }), cache);
    expect(good.sha256).toBe(SHA);
    rmSync(path.join(cache, "downloads"), { recursive: true });
    const want = hex(algo, other);
    await expect(fetchPodArchive(plan({ [key]: want }), cache)).rejects.toThrow(
      `The file ${HOST} serves for MLImage 1.0.0-beta7 does not match the ${algo} its spec names (${hex(algo, body)} instead of ${want}). rn-xtool does not use it. See ${LINK}`,
    );
    expect(downloads()).toEqual([]);
  });

  it.each([404, 410])("stops on a %i naming the host, the URL and the pod", async (status) => {
    await serve({ [PATH]: { status, body: "gone" } });
    await expect(fetchPodArchive(plan(), cache)).rejects.toThrow(
      `${HOST} answered ${status} for MLImage 1.0.0-beta7 (needed by ${LIB}): ${URL_}. The vendor no longer serves this file; a machine whose rn-xtool cache holds it keeps building. See ${LINK}`,
    );
    expect(downloads()).toEqual([]);
  });

  it("names the host and the reason of another failure, in its one line", async () => {
    await serve({ [PATH]: { status: 500, body: "oops" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(fetchPodArchive(plan(), cache)).rejects.toThrow(
      `Could not download MLImage 1.0.0-beta7 from ${HOST}: HTTP 500 Internal Server Error. Build again; the cache keeps what was complete.`,
    );
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("retries a partial download once, then names both sizes", async () => {
    const s = await serve({ [PATH]: { body, truncate: { at: 3000 } } });
    await expect(fetchPodArchive(plan(), cache)).rejects.toThrow(
      `Could not download MLImage 1.0.0-beta7 from ${HOST}: downloaded 3000 bytes, expected 7000. Build again; the cache keeps what was complete.`,
    );
    expect(s.requests).toHaveLength(2);
    expect(downloads()).toEqual([]);
  });

  it("checks a partial download against Content-Length without an expected size", async () => {
    const s = await serve({ [PATH]: { body, truncate: { at: 3000, times: 1 } } });
    const got = await fetchPodArchive(plan({ expectedBytes: undefined }), cache);
    expect(got.size).toBe(7000);
    expect(s.requests).toHaveLength(2);
  });

  it("two downloads of one file both end with one cached copy", async () => {
    await serve({ [PATH]: { body } });
    const [a, b] = await Promise.all([fetchPodArchive(plan(), cache), fetchPodArchive(plan(), cache)]);
    expect(a.file).toBe(b.file);
    expect(readFileSync(a.file)).toEqual(body);
    expect(downloads()).toEqual([`${SHA}.tar.gz`]);
  });

  it("reports an unreachable host as a PodsNetworkError", async () => {
    routeTo(await closedPortBase());
    const err = await fetchPodArchive(plan(), cache).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodsNetworkError);
    expect(offlineText(err as PodsNetworkError, cache)).toBe(
      `Cannot reach ${HOST} (connect ECONNREFUSED) to download MLImage 1.0.0-beta7 (7 KB), which is not in rn-xtool's cache (${tilde(cache)}). Connect to the network and build again; once downloaded, builds use the cache.`,
    );
    expect(downloads()).toEqual([]);
  });

  it("refuses a plain http URL the lock does not record, without a request", async () => {
    const s = await serve({ [PATH]: { body } });
    await expect(fetchPodArchive(plan({ url: `http://${HOST}${PATH}` }), cache)).rejects.toThrow(
      `MLImage 1.0.0-beta7 downloads over plain http from ${HOST}; rn-xtool downloads it only when rn-xtool-pods.lock.json already records its sha256. See ${LINK}`,
    );
    expect(s.requests).toEqual([]);
  });

  it("follows a redirect that stays on https", async () => {
    const s = await serve({ [PATH]: { redirect: "/moved.tar.gz" }, "/moved.tar.gz": { body } });
    const got = await fetchPodArchive(plan(), cache);
    expect(got.sha256).toBe(SHA);
    expect(s.requests).toEqual([`GET ${PATH}`, "GET /moved.tar.gz"]);
  });

  it("refuses a redirect from https to plain http that the lock does not record", async () => {
    const s = await serve({ [PATH]: { redirect: `http://plain.${HOST}/f.tar.gz` }, "/f.tar.gz": { body } });
    await expect(fetchPodArchive(plan(), cache)).rejects.toThrow(
      `MLImage 1.0.0-beta7 downloads over plain http from plain.${HOST}; rn-xtool downloads it only when rn-xtool-pods.lock.json already records its sha256. See ${LINK}`,
    );
    expect(s.requests).toEqual([`GET ${PATH}`]);
    expect(downloads()).toEqual([]);
  });

  it("follows a redirect to plain http when the lock records the file, and checks it", async () => {
    const s = await serve({ "/f.tar.gz": { body } });
    s.routes[PATH] = { redirect: `${s.base}/f.tar.gz` };
    const got = await fetchPodArchive(plan({ locked: locked() }), cache);
    expect(got).toMatchObject({ sha256: SHA, moved: false });
    expect(s.requests).toEqual([`GET ${PATH}`, "GET /f.tar.gz"]);
    rmSync(path.join(cache, "downloads"), { recursive: true });
    s.routes["/f.tar.gz"] = { body: other };
    await expect(fetchPodArchive(plan({ locked: locked() }), cache)).rejects.toThrow(
      "is not the one rn-xtool-pods.lock.json records",
    );
  });

  it.each([
    [`HTTP://${HOST}${PATH}`, "plain http"],
    [`ftp://${HOST}${PATH}`, "ftp"],
  ])("refuses %s, which is not https, when the lock does not record it", async (url, over) => {
    const s = await serve({ [PATH]: { body } });
    await expect(fetchPodArchive(plan({ url }), cache)).rejects.toThrow(
      `MLImage 1.0.0-beta7 downloads over ${over} from ${HOST}; rn-xtool downloads it only when rn-xtool-pods.lock.json already records its sha256. See ${LINK}`,
    );
    expect(s.requests).toEqual([]);
  });

  it("downloads a plain http URL the lock records, and checks it", async () => {
    const httpUrl = `http://${HOST}${PATH}`;
    await serve({ [PATH]: { body } });
    const got = await fetchPodArchive(plan({ url: httpUrl, locked: locked({ url: httpUrl }) }), cache);
    expect(got).toMatchObject({ sha256: SHA, moved: false });
    rmSync(path.join(cache, "downloads"), { recursive: true });
    server!.routes[PATH] = { body: other };
    await expect(fetchPodArchive(plan({ url: httpUrl, locked: locked({ url: httpUrl }) }), cache)).rejects.toThrow(
      "is not the one rn-xtool-pods.lock.json records",
    );
  });
});
