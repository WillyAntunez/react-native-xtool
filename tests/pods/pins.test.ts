import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { podShard } from "../../src/pods/cdn.js";
import { binaryPinLines } from "../../src/pods/pins.js";
import { resolveBinaryPods, type PodRoot, type Resolution } from "../../src/pods/resolve.js";
import { mergedPodTable } from "../../src/project/podTable.js";
import { podsCdnRoutes } from "../support/podFixtures.js";
import { startPodsServer, type PodsServer } from "../support/podsServer.js";

const LIB = "@react-native-ml-kit/text-recognition";
const LANGS = ["Chinese", "Devanagari", "Japanese", "Korean"];
const ML_KIT_ROOTS: PodRoot[] = ["", ...LANGS].map((lang) => ({
  library: LIB,
  libraryVersion: "2.0.0",
  dependency: `GoogleMLKit/TextRecognition${lang}`,
  requirements: ["8.0.0"],
}));
const INDEX: Record<string, string[]> = {
  GoogleMLKit: ["8.0.0"],
  MLKitTextRecognition: ["6.0.0"],
  ...Object.fromEntries(LANGS.map((l) => [`MLKitTextRecognition${l}`, ["5.0.0"]])),
  MLKitTextRecognitionCommon: ["5.0.0"],
  MLKitVision: ["9.0.0"],
  MLKitCommon: ["13.0.0"],
  MLImage: ["1.0.0-beta7"],
};

let cache: string;
let server: PodsServer;
beforeEach(async () => {
  cache = mkdtempSync(path.join(tmpdir(), "pods-pins-"));
  server = await startPodsServer(podsCdnRoutes(INDEX, podShard));
});
afterEach(async () => {
  await server.close();
  rmSync(cache, { recursive: true, force: true });
});

const resolve = (table = mergedPodTable()): Promise<Resolution> =>
  resolveBinaryPods(ML_KIT_ROOTS, { table, locked: {}, cdn: { base: server.base, cache, neededBy: () => LIB } });

describe("ML Kit's source pods in the table", () => {
  it("maps every subspec ML Kit's graph reaches to a product", async () => {
    const r = await resolve();
    expect(r.sources.map((s) => s.pod)).toEqual(["GTMSessionFetcher", "GoogleDataTransport", "GoogleToolboxForMac", "GoogleUtilities"]);
    for (const s of r.sources) {
      // Each subspec is named by the entry itself, not left to the entry's products.
      for (const sub of s.subspecs) expect(s.entry.subspecs?.[sub], `${s.pod}/${sub}`).toEqual(expect.arrayContaining([expect.any(String)]));
      if (s.subspecs.length === 0) expect(s.entry.products?.length, s.pod).toBeGreaterThan(0);
    }
  });

  it("marks the GoogleToolboxForMac override as checked: one ℹ line, no ⚠", async () => {
    const table = mergedPodTable();
    expect(binaryPinLines(await resolve(table), table)).toEqual([
      'ℹ GoogleToolboxForMac 6.0.1 (rn-xtool table) is outside MLKitCommon\'s and MLKitVision\'s requirement ">= 4.2.1, < 5.0": ' +
        "4.x ships no Package.swift; 6.0.1 keeps the GTMLogger API ML Kit links against",
    ]);
  });

  it("warns about a pin outside a binary pod's requirement", async () => {
    const table = mergedPodTable({
      GoogleUtilities: { url: "https://github.com/google/GoogleUtilities", exact: "7.0.0", products: ["GULLogger"] },
    });
    const lines = binaryPinLines(await resolve(table), table, "rn-xtool.config.js");
    expect(lines).toContain('⚠ GoogleUtilities 7.0.0 (rn-xtool.config.js) is outside MLKitCommon\'s requirement "~> 8.0"');
    expect(lines.filter((l) => l.startsWith("⚠"))).toHaveLength(1);
    // Without the file name, the config's own default.
    expect(binaryPinLines(await resolve(table), table)).toContain(
      '⚠ GoogleUtilities 7.0.0 (rn-xtool.config.json) is outside MLKitCommon\'s requirement "~> 8.0"',
    );
  });
});
