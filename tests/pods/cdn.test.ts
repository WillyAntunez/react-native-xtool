import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import {
  CDN_BASE,
  PodsNetworkError,
  cachedSpecVersions,
  networkReason,
  offlineText,
  podShard,
  podSpec,
  podVersions,
  podsUserAgent,
  specUrl,
  versionIndexUrl,
  type CdnOptions,
} from "../../src/pods/cdn.js";
import { formatSize } from "../../src/pods/format.js";
import { tilde } from "../../src/commands/setup.js";
import { podsCacheDir } from "../../src/paths.js";
import { packageRoot } from "../../src/tools/exec.js";
import { fixtureSpec } from "../support/podFixtures.js";
import { closedPortBase, startPodsServer, type PodsServer } from "../support/podsServer.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
let cache: string;
let server: PodsServer | undefined;

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), "pods-cdn-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(cache, { recursive: true, force: true });
});

const shardPath = (pod: string): string => podShard(pod).join("/");
const specPath = (pod: string, version: string): string => `/Specs/${shardPath(pod)}/${pod}/${version}/${pod}.podspec.json`;
const indexPath = (pod: string): string => `/all_pods_versions_${podShard(pod).join("_")}.txt`;
const opts = (base: string): CdnOptions => ({ base, cache, neededBy: () => LIB });

describe("the CocoaPods CDN", () => {
  it("computes the shard, the index URL and the spec URL", () => {
    const md5 = createHash("md5").update("GoogleMLKit").digest("hex");
    const shard = [md5[0], md5[1], md5[2]];
    expect(podShard("GoogleMLKit")).toEqual(shard);
    expect(versionIndexUrl(CDN_BASE, "GoogleMLKit")).toBe(`https://cdn.cocoapods.org/all_pods_versions_${shard.join("_")}.txt`);
    expect(specUrl(CDN_BASE, "GoogleMLKit", "8.0.0")).toBe(
      `https://cdn.cocoapods.org/Specs/${shard.join("/")}/GoogleMLKit/8.0.0/GoogleMLKit.podspec.json`,
    );
  });

  it("names rn-xtool and its version in the User-Agent", async () => {
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version: string };
    expect(podsUserAgent()).toBe(`rn-xtool/${version}`);
  });

  it("keeps its cache under rn-xtool's cache folder", () => {
    const before = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/home/me/.cache";
    try {
      expect(podsCacheDir()).toBe("/home/me/.cache/rn-xtool/pods");
    } finally {
      if (before === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = before;
    }
  });

  it("follows the redirect and sends rn-xtool's User-Agent", async () => {
    const at = specPath("GoogleMLKit", "8.0.0");
    server = await startPodsServer({
      [at]: { redirect: `/cocoa${at}` },
      [`/cocoa${at}`]: { body: JSON.stringify(fixtureSpec("GoogleMLKit", "8.0.0")), needsUserAgent: "rn-xtool/" },
    });
    const spec = await podSpec("GoogleMLKit", "8.0.0", opts(server.base));
    expect(spec.name).toBe("GoogleMLKit");
    expect(server.requests).toEqual([`GET ${at}`, `GET /cocoa${at}`]);
    expect(server.userAgents).toEqual([podsUserAgent(), podsUserAgent()]);
    expect(existsSync(path.join(cache, "specs", "GoogleMLKit", "8.0.0.podspec.json"))).toBe(true);
    expect(readdirSync(path.join(cache, "specs", "GoogleMLKit"))).toEqual(["8.0.0.podspec.json"]);
  });

  it("reads a cached spec without a request", async () => {
    server = await startPodsServer({ [specPath("MLImage", "1.0.0-beta7")]: { body: JSON.stringify(fixtureSpec("MLImage", "1.0.0-beta7")) } });
    await podSpec("MLImage", "1.0.0-beta7", opts(server.base));
    expect(server.requests).toHaveLength(1);
    const again = await podSpec("MLImage", "1.0.0-beta7", opts(server.base));
    expect(again.version).toBe("1.0.0-beta7");
    expect(server.requests).toHaveLength(1);
    expect(cachedSpecVersions("MLImage", cache)).toEqual(["1.0.0-beta7"]);
    expect(cachedSpecVersions("MLKitCommon", cache)).toEqual([]);
  });

  it("does not cache a spec it cannot read", async () => {
    server = await startPodsServer({ [specPath("MLImage", "1.0.0-beta7")]: { body: "<!DOCTYPE html>" } });
    await expect(podSpec("MLImage", "1.0.0-beta7", opts(server.base))).rejects.toThrow(
      `The spec of MLImage 1.0.0-beta7 has a "spec" value rn-xtool cannot read ("<!DOCTYPE html>"). See ${LINK}`,
    );
    expect(cachedSpecVersions("MLImage", cache)).toEqual([]);
  });

  it("reads the version index, and reads it from the cache the next time", async () => {
    server = await startPodsServer({
      [indexPath("MLKitCommon")]: { body: "Other/1.0.0\nMLKitCommon/12.0.0/13.0.0/13.0.1\n" },
    });
    expect(await podVersions("MLKitCommon", opts(server.base))).toEqual(["12.0.0", "13.0.0", "13.0.1"]);
    expect(await podVersions("MLKitCommon", opts(server.base))).toEqual(["12.0.0", "13.0.0", "13.0.1"]);
    expect(server.requests).toHaveLength(1);
    server.routes[indexPath("MLKitCommon")] = { body: "MLKitCommon/12.0.0/13.0.0/13.0.1/14.0.0\n" };
    expect(await podVersions("MLKitCommon", { ...opts(server.base), refresh: true })).toContain("14.0.0");
    expect(server.requests).toHaveLength(2);
    expect(existsSync(path.join(cache, "specs", "index", `all_pods_versions_${podShard("MLKitCommon").join("_")}.txt`))).toBe(true);
  });

  it("reads the index again once when the cached one does not name the pod", async () => {
    const file = path.join(cache, "specs", "index", `all_pods_versions_${podShard("MLKitCommon").join("_")}.txt`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "Other/1.0.0\n");
    server = await startPodsServer({ [indexPath("MLKitCommon")]: { body: "MLKitCommon/13.0.0\n" } });
    expect(await podVersions("MLKitCommon", opts(server.base))).toEqual(["13.0.0"]);
    expect(server.requests).toHaveLength(1);
  });

  it("stops on a 404 naming the pod, the version, the URL and the library", async () => {
    server = await startPodsServer();
    const url = `${server.base}${specPath("MLKitCommon", "99.0.0")}`;
    await expect(podSpec("MLKitCommon", "99.0.0", opts(server.base))).rejects.toThrow(
      `MLKitCommon 99.0.0 (needed by ${LIB}) is not on the CocoaPods trunk: ${url} answered 404. rn-xtool reads pods from trunk only; map the pod to a SwiftPM package under "pods" in rn-xtool.config.json, or leave the library out with "exclude". See ${LINK}`,
    );
  });

  it("stops when the version list does not name the pod", async () => {
    server = await startPodsServer({ [indexPath("PrivatePod")]: { body: "Other/1.0.0\n" } });
    const url = `${server.base}${indexPath("PrivatePod")}`;
    await expect(podVersions("PrivatePod", opts(server.base))).rejects.toThrow(
      `PrivatePod (needed by ${LIB}) is not on the CocoaPods trunk: its version list ${url} does not name it. rn-xtool reads pods from trunk only; map the pod to a SwiftPM package under "pods" in rn-xtool.config.json, or leave the library out with "exclude". See ${LINK}`,
    );
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a pod name or version that would leave the cache, without a request", async () => {
    server = await startPodsServer();
    await expect(podSpec("MLImage", "../x", opts(server.base))).rejects.toThrow(
      `rn-xtool cannot use "../x" as a CocoaPods pod name or version. See ${LINK}`,
    );
    await expect(podSpec("..", "1.0.0", opts(server.base))).rejects.toThrow(`rn-xtool cannot use ".." as a CocoaPods pod name`);
    await expect(podVersions("a/b", opts(server.base))).rejects.toThrow(`rn-xtool cannot use "a/b" as a CocoaPods pod name`);
    expect(server.requests).toEqual([]);
    expect(readdirSync(cache)).toEqual([]);
  });

  it("gives up on a CDN that does not answer, as an unreachable one", async () => {
    server = await startPodsServer({ [specPath("MLImage", "1.0.0-beta7")]: { hang: true } });
    const err = await podSpec("MLImage", "1.0.0-beta7", { ...opts(server.base), timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodsNetworkError);
    expect((err as PodsNetworkError).reason).toBe("The operation was aborted due to timeout");
  });

  it("names the HTTP status of any other answer", async () => {
    server = await startPodsServer({
      [specPath("MLKitVision", "9.0.0")]: { status: 500, body: "oops" },
      [indexPath("MLKitVision")]: { status: 503, body: "busy" },
    });
    const host = new URL(server.base).host;
    await expect(podSpec("MLKitVision", "9.0.0", opts(server.base))).rejects.toThrow(
      `${host} answered HTTP 500 for ${server.base}${specPath("MLKitVision", "9.0.0")} (the spec of MLKitVision 9.0.0). Build again later; if it keeps failing, see ${LINK}`,
    );
    await expect(podVersions("MLKitVision", opts(server.base))).rejects.toThrow(
      `${host} answered HTTP 503 for ${server.base}${indexPath("MLKitVision")} (the versions of MLKitVision). Build again later; if it keeps failing, see ${LINK}`,
    );
  });

  it("names the host, the reason and the cache when the CDN cannot be reached", async () => {
    const base = await closedPortBase();
    const host = new URL(base).host;
    const err = await podSpec("GoogleMLKit", "8.0.0", opts(base)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodsNetworkError);
    const e = err as PodsNetworkError;
    expect(e).toMatchObject({ host, reason: "connect ECONNREFUSED", what: "the spec of GoogleMLKit 8.0.0", plural: false });
    expect(offlineText(e, cache)).toBe(
      `Cannot reach ${host} (connect ECONNREFUSED) to read the spec of GoogleMLKit 8.0.0, which is not in rn-xtool's cache (${tilde(cache)}). Connect to the network and build again; once downloaded, builds use the cache.`,
    );
    const index = (await podVersions("GoogleMLKit", opts(base)).catch((x: unknown) => x)) as PodsNetworkError;
    expect(offlineText(index, path.join(homedir(), ".cache", "rn-xtool", "pods"))).toBe(
      `Cannot reach ${host} (connect ECONNREFUSED) to read the versions of GoogleMLKit, which are not in rn-xtool's cache (~/.cache/rn-xtool/pods). Connect to the network and build again; once downloaded, builds use the cache.`,
    );
  });

  it.each([
    [{ cause: { syscall: "getaddrinfo", code: "ENOTFOUND" } }, "getaddrinfo ENOTFOUND"],
    [Object.assign(new TypeError("fetch failed"), { cause: { syscall: "connect", code: "ECONNREFUSED" } }), "connect ECONNREFUSED"],
    [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "ECONNRESET"],
    [new Error("socket hang up"), "socket hang up"],
  ])("reads the network reason of %o", (err, reason) => {
    expect(networkReason(err)).toBe(reason);
  });

  it("formats sizes", () => {
    expect(formatSize(40332871)).toBe("40.3 MB");
    expect(formatSize(351000)).toBe("0.4 MB");
    expect(formatSize(100000)).toBe("0.1 MB");
    expect(formatSize(99999)).toBe("0.1 MB");
    expect(formatSize(99499)).toBe("99 KB");
    expect(formatSize(7000)).toBe("7 KB");
    expect(formatSize(undefined)).toBe("size unknown");
  });
});
