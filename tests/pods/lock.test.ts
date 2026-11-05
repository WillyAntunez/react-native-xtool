import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import {
  LockError,
  PODS_LOCK,
  lockedVersions,
  movedLine,
  readPodsLock,
  recordedLine,
  renderPodsLock,
  reResolvedLine,
  unusedLockEntries,
  writePodsLock,
  type LockEntry,
  type PodsLock,
} from "../../src/pods/lock.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
const sha = (c: string): string => c.repeat(64);
const entry = (version: string, over: Partial<LockEntry> = {}): LockEntry => ({
  version,
  subspecs: [],
  url: `https://example.invalid/dl/pod-${version}.tar.gz`,
  size: 7000,
  sha256: sha("a"),
  neededBy: [LIB],
  ...over,
});
const LOCK: PodsLock = {
  lockfileVersion: 1,
  pods: {
    MLKitVision: entry("9.0.0", { sha256: sha("b"), size: 351000 }),
    GoogleMLKit: entry("8.0.0", { subspecs: ["TextRecognition", "MLKitCore"], sha256: sha("c") }),
    MLImage: entry("1.0.0-beta7"),
  },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pods-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("rn-xtool-pods.lock.json", () => {
  it("reads a missing lock as empty", () => {
    expect(PODS_LOCK).toBe("rn-xtool-pods.lock.json");
    expect(readPodsLock(root)).toEqual({ lockfileVersion: 1, pods: {} });
  });

  it("renders sorted keys, stable across writes", () => {
    const text = renderPodsLock(LOCK);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text).pods)).toEqual(["GoogleMLKit", "MLImage", "MLKitVision"]);
    expect(Object.keys(JSON.parse(text).pods.GoogleMLKit)).toEqual(["neededBy", "sha256", "size", "subspecs", "url", "version"]);
    expect(JSON.parse(text).pods.GoogleMLKit.subspecs).toEqual(["MLKitCore", "TextRecognition"]);
    expect(text).toContain('\n  "pods": {\n    "GoogleMLKit": {\n      "neededBy": [');
    writePodsLock(root, LOCK);
    const first = readFileSync(path.join(root, PODS_LOCK), "utf8");
    expect(first).toBe(text);
    writePodsLock(root, readPodsLock(root));
    expect(readFileSync(path.join(root, PODS_LOCK), "utf8")).toBe(first);
    expect(readPodsLock(root)).toEqual(JSON.parse(text));
  });

  it("writes through a temporary file", () => {
    writePodsLock(root, LOCK);
    const file = path.join(root, PODS_LOCK);
    expect(fs.renameSync).toHaveBeenCalledWith(`${file}.${process.pid}.tmp`, file);
    expect(readdirSync(root)).toEqual([PODS_LOCK]);
  });

  it.each([
    ["bad JSON", "{ nope", /^rn-xtool-pods\.lock\.json is not a lock rn-xtool can read \(.+\); fix it, or delete it to record the files again\. See /],
    ["another lockfileVersion", JSON.stringify({ lockfileVersion: 2, pods: {} }), "(lockfileVersion must be 1)"],
    ["pods as a list", JSON.stringify({ lockfileVersion: 1, pods: [] }), "(pods must be an object of pod names)"],
    ["a short sha256", JSON.stringify({ lockfileVersion: 1, pods: { MLImage: entry("1.0.0-beta7", { sha256: "abc" }) } }), "(pods.MLImage.sha256 must be a sha256 in hex)"],
    ["a size as text", JSON.stringify({ lockfileVersion: 1, pods: { MLImage: { ...entry("1.0.0-beta7"), size: "7 KB" } } }), "(pods.MLImage.size must be a number of bytes)"],
    ["no version", JSON.stringify({ lockfileVersion: 1, pods: { MLImage: { ...entry("1"), version: undefined } } }), "(pods.MLImage.version must be a version)"],
    ["subspecs as text", JSON.stringify({ lockfileVersion: 1, pods: { MLImage: { ...entry("1"), subspecs: "Core" } } }), "(pods.MLImage.subspecs must be a list of names)"],
    ["a URL that is not one", JSON.stringify({ lockfileVersion: 1, pods: { MLImage: { ...entry("1"), url: "dl/x" } } }), "(pods.MLImage.url must be a URL)"],
  ])("names a lock it cannot read: %s", (_name, text, message) => {
    writeFileSync(path.join(root, PODS_LOCK), text);
    expect(() => readPodsLock(root)).toThrow(LockError);
    if (typeof message === "string") {
      expect(() => readPodsLock(root)).toThrow(
        `rn-xtool-pods.lock.json is not a lock rn-xtool can read ${message}; fix it, or delete it to record the files again. See ${LINK}`,
      );
    } else {
      expect(() => readPodsLock(root)).toThrow(message);
    }
  });

  it("names a lock with merge conflict markers", () => {
    const text = renderPodsLock(LOCK).replace(
      '    "MLImage": {',
      `<<<<<<< HEAD\n    "MLImage": {\n=======\n    "MLImage": {\n>>>>>>> feature/other\n`,
    );
    writeFileSync(path.join(root, PODS_LOCK), text);
    expect(() => readPodsLock(root)).toThrow(
      `rn-xtool-pods.lock.json has merge conflict markers; keep either side and build again: rn-xtool checks every file against the hashes it keeps. See ${LINK}`,
    );
  });

  it("keeps unused entries and lists them", () => {
    writePodsLock(root, { lockfileVersion: 1, pods: { ...LOCK.pods, MLKitFoo: entry("1.0.0", { neededBy: ["react-native-foo"] }) } });
    const lock = readPodsLock(root);
    expect(lockedVersions(lock)).toEqual({ GoogleMLKit: "8.0.0", MLImage: "1.0.0-beta7", MLKitFoo: "1.0.0", MLKitVision: "9.0.0" });
    expect(unusedLockEntries(lock, new Set(["GoogleMLKit", "MLImage", "MLKitVision"]))).toEqual(["MLKitFoo 1.0.0"]);
    expect(unusedLockEntries(lock, new Set(["GoogleMLKit"]))).toEqual(["MLImage 1.0.0-beta7", "MLKitFoo 1.0.0", "MLKitVision 9.0.0"]);
    expect(Object.keys(readPodsLock(root).pods)).toContain("MLKitFoo");
  });

  it("words the recorded, re-resolved and moved lines", () => {
    expect(recordedLine(10)).toBe(
      "ℹ pods — recorded the sha256 of 10 downloads in rn-xtool-pods.lock.json; commit it, so other machines check that they get the same files.",
    );
    expect(recordedLine(1)).toBe(
      "ℹ pods — recorded the sha256 of 1 download in rn-xtool-pods.lock.json; commit it, so other machines check that they get the same files.",
    );
    expect(
      reResolvedLine({ pod: "MLKitCommon", from: "12.0.0", to: "13.0.0", requirement: "~> 13.0.0", by: `GoogleMLKit 8.0.0, needed by ${LIB}` }),
    ).toBe(
      `ℹ pods — MLKitCommon: rn-xtool-pods.lock.json records 12.0.0, which no longer meets "~> 13.0.0" (GoogleMLKit 8.0.0, needed by ${LIB}); now 13.0.0, recorded in rn-xtool-pods.lock.json`,
    );
    expect(movedLine("MLImage", "1.0.0-beta7", "https://example.invalid/dl/new/MLImage-1.0.0-beta7.tar.gz")).toBe(
      "ℹ pods — MLImage 1.0.0-beta7 moved to https://example.invalid/dl/new/MLImage-1.0.0-beta7.tar.gz; same file (its sha256 matches rn-xtool-pods.lock.json), so the lock's URL is updated",
    );
  });
});
