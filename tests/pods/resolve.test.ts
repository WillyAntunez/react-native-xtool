import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PodEntry } from "../../src/config.js";
import { troubleshootingUrl } from "../../src/docs.js";
import { podShard } from "../../src/pods/cdn.js";
import { resolveBinaryPods, type PodRoot } from "../../src/pods/resolve.js";
import type { PodTable } from "../../src/project/podTable.js";
import { podsCdnRoutes } from "../support/podFixtures.js";
import { startPodsServer, type PodsServer } from "../support/podsServer.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LIB = "@react-native-ml-kit/text-recognition";
const LANGS = ["Chinese", "Devanagari", "Japanese", "Korean"];
const ML_KIT_ROOTS: PodRoot[] = ["", ...LANGS].map((lang) => ({
  library: LIB,
  libraryVersion: "2.0.0",
  dependency: `GoogleMLKit/TextRecognition${lang}`,
  requirements: ["8.0.0"],
}));
const INDEX: Record<string, string[]> = {
  GoogleMLKit: ["7.0.0", "8.0.0", "9.0.0"],
  MLKitTextRecognition: ["5.0.0", "6.0.0"],
  ...Object.fromEntries(LANGS.map((l) => [`MLKitTextRecognition${l}`, ["4.0.0", "5.0.0"]])),
  MLKitTextRecognitionCommon: ["4.0.0", "5.0.0"],
  MLKitVision: ["8.0.0", "9.0.0"],
  MLKitCommon: ["12.0.0", "13.0.0", "14.0.0"],
  MLImage: ["0.9.0", "1.0.0-beta6", "1.0.0-beta7"],
  MLKitFoo: ["1.0.0"],
  MLKitLegacy: ["1.0.0"],
  GoogleToolboxForMac: ["4.2.1", "5.0.0"],
};
const entry = (exact: string, ...products: string[]): PodEntry => ({ url: "https://example.invalid/git/pkg", exact, products });
const TABLE_PODS: Record<string, PodEntry> = {
  GTMSessionFetcher: entry("3.5.0", "GTMSessionFetcherCore"),
  GoogleToolboxForMac: entry("6.0.1", "GTMLogger"),
  GoogleUtilities: entry("8.1.5", "GULLogger", "GULUserDefaults"),
  GoogleDataTransport: entry("10.1.1", "GoogleDataTransport"),
};
const table = (pods: Record<string, PodEntry> = TABLE_PODS): PodTable => ({
  pods,
  source: Object.fromEntries(Object.keys(pods).map((p) => [p, "rn-xtool" as const])),
});

let cache: string;
let server: PodsServer;
beforeEach(async () => {
  cache = mkdtempSync(path.join(tmpdir(), "pods-resolve-"));
  server = await startPodsServer(podsCdnRoutes(INDEX, podShard));
});
afterEach(async () => {
  await server.close();
  rmSync(cache, { recursive: true, force: true });
});

const ctx = (over: { table?: PodTable; locked?: Record<string, string> } = {}) => ({
  table: over.table ?? table(),
  locked: over.locked ?? {},
  cdn: { base: server.base, cache, neededBy: () => "an unknown library" },
});

describe("resolveBinaryPods", () => {
  it("resolves ML Kit's graph to ten binary pods and four source pods", async () => {
    const r = await resolveBinaryPods(ML_KIT_ROOTS, ctx());
    expect(r.binary.map((b) => `${b.pod} ${b.version}`)).toEqual([
      "GoogleMLKit 8.0.0",
      "MLImage 1.0.0-beta7",
      "MLKitCommon 13.0.0",
      "MLKitTextRecognition 6.0.0",
      "MLKitTextRecognitionChinese 5.0.0",
      "MLKitTextRecognitionCommon 5.0.0",
      "MLKitTextRecognitionDevanagari 5.0.0",
      "MLKitTextRecognitionJapanese 5.0.0",
      "MLKitTextRecognitionKorean 5.0.0",
      "MLKitVision 9.0.0",
    ]);
    const mlkit = r.binary.find((b) => b.pod === "GoogleMLKit")!;
    expect(mlkit.headersOnly).toBe(true);
    expect(mlkit.subspecs).toEqual(["MLKitCore", "TextRecognition", ...LANGS.map((l) => `TextRecognition${l}`)]);
    expect(mlkit.chain).toEqual([]);
    expect(mlkit.layers.flatMap((l) => l.sourceFiles)).toEqual(["MLKitCore/Sources/MLKit.h"]);
    for (const b of r.binary) {
      expect(b.neededBy).toEqual([LIB]);
      expect(b.roots).toEqual(["GoogleMLKit"]);
      expect(b.spec.version).toBe(b.version);
      if (b.pod !== "GoogleMLKit") expect(b.headersOnly).toBe(false);
    }
    expect(r.binary.find((b) => b.pod === "MLImage")!.chain).toEqual(["GoogleMLKit 8.0.0", "MLKitTextRecognition 6.0.0", "MLKitVision 9.0.0"]);
    expect(r.sources.map((s) => [s.pod, s.subspecs])).toEqual([
      ["GTMSessionFetcher", ["Core"]],
      ["GoogleDataTransport", []],
      ["GoogleToolboxForMac", ["Logger", "NSData+zlib"]],
      ["GoogleUtilities", ["Logger", "UserDefaults"]],
    ]);
    const toolbox = r.sources.find((s) => s.pod === "GoogleToolboxForMac")!;
    expect(toolbox.entry).toBe(TABLE_PODS.GoogleToolboxForMac);
    expect(toolbox.requiredBy).toEqual([
      { from: "MLKitCommon", requirements: [">= 4.2.1", "< 5.0"] },
      { from: "MLKitVision", requirements: [">= 4.2.1", "< 5.0"] },
    ]);
    expect(r.roots).toEqual([{ pod: "GoogleMLKit", libraries: [LIB] }]);
    expect(r.changed).toEqual([]);
  });

  it("resolves MLImage 1.0.0-beta7 for its exact requirement", async () => {
    const r = await resolveBinaryPods(
      [{ library: "react-native-image", libraryVersion: "1.0.0", dependency: "MLImage", requirements: [" 1.0.0-beta7"] }],
      ctx(),
    );
    expect(r.binary.map((b) => `${b.pod} ${b.version}`)).toEqual(["MLImage 1.0.0-beta7"]);
    expect(r.roots).toEqual([{ pod: "MLImage", libraries: ["react-native-image"] }]);
  });

  it("never asks for nanopb or PromisesObjC, nor for the source pods the table maps", async () => {
    await resolveBinaryPods(ML_KIT_ROOTS, ctx());
    const specs = server.requests.filter((r) => r.includes("/Specs/"));
    expect(specs.filter((r) => /nanopb|PromisesObjC|GTMSessionFetcher|GoogleUtilities|GoogleDataTransport|GoogleToolboxForMac/.test(r))).toEqual([]);
    expect(specs).toHaveLength(10);
  });

  it("names every library that reaches a pod, and the roots", async () => {
    const r = await resolveBinaryPods(
      [
        ...ML_KIT_ROOTS,
        { library: "react-native-vision", libraryVersion: "3.0.0", dependency: "MLKitVision", requirements: ["~> 9.0"] },
      ],
      ctx(),
    );
    expect(r.binary.find((b) => b.pod === "MLKitVision")!.neededBy).toEqual([LIB, "react-native-vision"]);
    expect(r.binary.find((b) => b.pod === "MLKitVision")!.roots).toEqual(["GoogleMLKit", "MLKitVision"]);
    expect(r.binary.find((b) => b.pod === "MLKitVision")!.chain).toEqual([]);
    expect(r.binary.find((b) => b.pod === "GoogleMLKit")!.neededBy).toEqual([LIB]);
    expect(r.roots).toEqual([
      { pod: "GoogleMLKit", libraries: [LIB] },
      { pod: "MLKitVision", libraries: ["react-native-vision"] },
    ]);
  });

  it("keeps the locked version while it satisfies the requirements", async () => {
    server.routes[`/all_pods_versions_${podShard("MLKitCommon").join("_")}.txt`] = { body: "MLKitCommon/13.0.0/13.0.1\n" };
    const r = await resolveBinaryPods(ML_KIT_ROOTS, ctx({ locked: { MLKitCommon: "13.0.0", GoogleMLKit: "8.0.0" } }));
    expect(r.binary.find((b) => b.pod === "MLKitCommon")!.version).toBe("13.0.0");
    expect(r.changed).toEqual([]);
  });

  it("resolves again when the locked version no longer satisfies them", async () => {
    const r = await resolveBinaryPods(ML_KIT_ROOTS, ctx({ locked: { MLKitCommon: "12.0.0" } }));
    expect(r.binary.find((b) => b.pod === "MLKitCommon")!.version).toBe("13.0.0");
    expect(r.changed).toEqual([
      { pod: "MLKitCommon", from: "12.0.0", to: "13.0.0", requirement: "~> 13.0.0", by: `GoogleMLKit 8.0.0, needed by ${LIB}` },
    ]);
  });

  it("names the library when a locked root pod no longer satisfies it", async () => {
    const r = await resolveBinaryPods(ML_KIT_ROOTS, ctx({ locked: { GoogleMLKit: "7.0.0" } }));
    expect(r.changed).toEqual([
      { pod: "GoogleMLKit", from: "7.0.0", to: "8.0.0", requirement: "8.0.0", by: `${LIB} 2.0.0` },
    ]);
  });

  it("lists each requirement and who imposed it when no version satisfies them all", async () => {
    const roots: PodRoot[] = [
      ML_KIT_ROOTS[0]!,
      { library: "react-native-foo", libraryVersion: "1.2.0", dependency: "MLKitFoo", requirements: ["1.0.0"] },
    ];
    await expect(resolveBinaryPods(roots, ctx())).rejects.toThrow(
      `No version of MLKitCommon satisfies every requirement: "~> 13.0.0" (GoogleMLKit 8.0.0, needed by ${LIB}), "~> 14.0" (MLKitFoo 1.0.0, needed by react-native-foo). rn-xtool resolves CocoaPods versions without backtracking; leave one of the libraries out with "exclude" in rn-xtool.config.json. See ${LINK}`,
    );
  });

  it("joins the items of one requirement and names a library's own", async () => {
    const roots: PodRoot[] = [
      { library: "react-native-a", libraryVersion: "1.0.0", dependency: "MLKitCommon", requirements: [">= 12.0", "< 13.0"] },
      { library: "react-native-b", libraryVersion: "2.0.0", dependency: "MLKitCommon", requirements: ["~> 14.0"] },
    ];
    await expect(resolveBinaryPods(roots, ctx())).rejects.toThrow(
      `No version of MLKitCommon satisfies every requirement: ">= 12.0, < 13.0" (react-native-a 1.0.0), "~> 14.0" (react-native-b 2.0.0).`,
    );
  });

  it("says any version when no requirement names one and only prereleases are listed", async () => {
    server.routes[`/all_pods_versions_${podShard("MLKitXeno").join("_")}.txt`] = { body: "MLKitXeno/1.0.0-beta1\n" };
    const roots: PodRoot[] = [{ library: "react-native-xeno", libraryVersion: "1.0.0", dependency: "MLKitXeno", requirements: [] }];
    await expect(resolveBinaryPods(roots, ctx())).rejects.toThrow(
      `No version of MLKitXeno satisfies every requirement: any version (react-native-xeno 1.0.0). rn-xtool resolves`,
    );
  });

  it("stops on a source pod without a table entry, with the chain", async () => {
    const { GoogleToolboxForMac: _left, ...pods } = TABLE_PODS;
    await expect(resolveBinaryPods(ML_KIT_ROOTS, ctx({ table: table(pods) }))).rejects.toThrow(
      `${LIB} 2.0.0: its podspec depends on the CocoaPods pod GoogleMLKit, and through it (GoogleMLKit 8.0.0 → MLKitCommon 13.0.0) on the CocoaPods pod GoogleToolboxForMac, which has no SwiftPM package rn-xtool knows. Add one under "pods" in rn-xtool.config.json: { "pods": { "GoogleToolboxForMac": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, or leave the library out with "exclude". See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")}`,
    );
  });

  it("stops on a source pod a library names itself, as block 2 does", async () => {
    const { GoogleToolboxForMac: _left, ...pods } = TABLE_PODS;
    const roots: PodRoot[] = [
      { library: "react-native-gtm", libraryVersion: "0.1.0", dependency: "GoogleToolboxForMac/Logger", requirements: ["~> 4.2"] },
    ];
    await expect(resolveBinaryPods(roots, ctx({ table: table(pods) }))).rejects.toThrow(
      `react-native-gtm 0.1.0: its podspec depends on the CocoaPods pod GoogleToolboxForMac, which has no SwiftPM package rn-xtool knows. Add one under "pods" in rn-xtool.config.json: { "pods": { "GoogleToolboxForMac": { "url": "<git URL>", "exact": "<version>", "products": ["<product>"] } } }, or leave the library out with "exclude". See ${troubleshootingUrl("libraries-that-depend-on-cocoapods-pods")}`,
    );
  });

  it("stops on a pod in a shape rn-xtool does not cover", async () => {
    const roots: PodRoot[] = [
      { library: "react-native-legacy", libraryVersion: "1.0.0", dependency: "MLKitLegacy", requirements: ["~> 1.0"] },
    ];
    await expect(resolveBinaryPods(roots, ctx())).rejects.toThrow(
      `MLKitLegacy 1.0.0 (needed by react-native-legacy) ships vendored libraries (Libraries/libMLKitLegacy.a); rn-xtool links static CocoaPods binaries only. Leave the library out with "exclude" in rn-xtool.config.json. See ${LINK}`,
    );
  });

  it("refreshes the version index once when no cached version satisfies", async () => {
    const index = `/all_pods_versions_${podShard("MLKitCommon").join("_")}.txt`;
    const file = path.join(cache, "specs", "index", index.slice(1));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "MLKitCommon/12.0.0\n");
    server.routes[index] = { body: "MLKitCommon/12.0.0/13.0.0\n" };
    const r = await resolveBinaryPods(
      [{ library: "react-native-common", libraryVersion: "1.0.0", dependency: "MLKitCommon", requirements: ["~> 13.0.0"] }],
      ctx({ table: table() }),
    );
    expect(r.binary.map((b) => `${b.pod} ${b.version}`)).toEqual(["MLKitCommon 13.0.0"]);
    expect(server.requests.filter((q) => q.includes("all_pods_versions"))).toEqual([`GET ${index}`]);
  });

  it("makes no request when the lock and the cache hold everything", async () => {
    const locked = Object.fromEntries((await resolveBinaryPods(ML_KIT_ROOTS, ctx())).binary.map((b) => [b.pod, b.version]));
    server.requests.length = 0;
    const r = await resolveBinaryPods(ML_KIT_ROOTS, ctx({ locked }));
    expect(r.binary).toHaveLength(10);
    expect(server.requests).toEqual([]);
  });

  it("names an unreadable requirement and who imposed it", async () => {
    const roots: PodRoot[] = [
      { library: "react-native-odd", libraryVersion: "1.0.0", dependency: "MLKitCommon", requirements: ["#{version}"] },
    ];
    await expect(resolveBinaryPods(roots, ctx())).rejects.toThrow(
      `rn-xtool cannot read the requirement "#{version}" on MLKitCommon (react-native-odd 1.0.0). See ${LINK}`,
    );
  });
});
