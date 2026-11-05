/**
 * The table of CocoaPods pods with a SwiftPM package that the scaffolder maps a podspec's `s.dependency` with: the
 * vendored scaffolder's baseline (KNOWN_POD_SPM_PACKAGES), then rn-xtool's own entries (`data/pods.json`), then the
 * config's `pods`. rn-xtool writes the merged table to `ios/build/rn-xtool-pods.json` and names it to the scaffolder in
 * RN_SPM_POD_TABLE (read by `loadPodTable` in vendor/rn-spm/spm/scaffold-package-swift.js and in the 0.88 patches).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { checkPodEntries, type PodEntry } from "../config.js";
import type { ProjectPaths } from "../paths.js";
import { packageRoot } from "../tools/exec.js";

export const POD_TABLE_ENV = "RN_SPM_POD_TABLE";

/** Where an entry of the merged table comes from. */
export type PodSource = "scaffolder" | "rn-xtool" | "config";
export interface PodTable {
  pods: Record<string, PodEntry>;
  source: Record<string, PodSource>;
}

function scaffolderBaseline(): Record<string, PodEntry> {
  const file = path.join(packageRoot(), "vendor", "rn-spm", "spm", "scaffold-package-swift.js");
  return (createRequire(import.meta.url)(file) as { KNOWN_POD_SPM_PACKAGES: Record<string, PodEntry> }).KNOWN_POD_SPM_PACKAGES;
}

/** rn-xtool's own entries, checked with the config's rules. */
function shippedPods(): Record<string, PodEntry> {
  const { pods } = JSON.parse(readFileSync(path.join(packageRoot(), "data", "pods.json"), "utf8")) as { pods: unknown };
  checkPodEntries("data/pods.json", pods);
  return pods as Record<string, PodEntry>;
}

/** The scaffolder's baseline, then data/pods.json, then the config's pods; per pod, the later entry wins whole. */
export function mergedPodTable(configPods?: Record<string, PodEntry>): PodTable {
  const table: PodTable = { pods: {}, source: {} };
  const layers: [PodSource, Record<string, PodEntry>][] = [
    ["scaffolder", scaffolderBaseline()],
    ["rn-xtool", shippedPods()],
    ["config", configPods ?? {}],
  ];
  for (const [source, pods] of layers) {
    for (const [pod, entry] of Object.entries(pods)) {
      table.pods[pod] = entry;
      table.source[pod] = source;
    }
  }
  return table;
}

/** Writes the table to `ios/build/rn-xtool-pods.json` and returns that path. */
export function writePodTable(paths: ProjectPaths, table: PodTable): string {
  const file = path.join(paths.iosBuild, "rn-xtool-pods.json");
  mkdirSync(paths.iosBuild, { recursive: true });
  writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
  return file;
}
