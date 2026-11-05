/**
 * The table of CocoaPods pods with a SwiftPM package that the scaffolder maps a podspec's `s.dependency` with: the
 * vendored scaffolder's baseline (KNOWN_POD_SPM_PACKAGES), then rn-xtool's own entries (`data/pods.json`), then the
 * config's `pods`, merged field by field per pod. rn-xtool writes the merged table to `ios/build/rn-xtool-pods.json`
 * and names it to the scaffolder in RN_SPM_POD_TABLE (read by `loadPodTable` in
 * vendor/rn-spm/spm/scaffold-package-swift.js and in the 0.88 patches).
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

/**
 * `over` on top of `base`, field by field: the fields `over` names replace those of `base`, and the others stay (an
 * empty `forwardHeaders` or `subspecs` removes them). `product` is read as `products: [product]`.
 */
function mergePodEntry(base: PodEntry | undefined, over: PodEntry): PodEntry {
  const { product, ...rest } = over;
  const named: PodEntry = rest.products === undefined && product !== undefined ? { ...rest, products: [product] } : rest;
  const { product: _replaced, ...kept } = base ?? ({} as Partial<PodEntry>);
  return { ...kept, ...named } as PodEntry;
}

/**
 * The scaffolder's baseline, then data/pods.json, then the config's pods. Per pod, a later entry overrides the fields it
 * names and keeps the others: pinning AppAuth to another version keeps its forwardHeaders.
 */
export function mergedPodTable(configPods?: Record<string, PodEntry>): PodTable {
  const table: PodTable = { pods: {}, source: {} };
  const layers: [PodSource, Record<string, PodEntry>][] = [
    ["scaffolder", scaffolderBaseline()],
    ["rn-xtool", shippedPods()],
    ["config", configPods ?? {}],
  ];
  for (const [source, pods] of layers) {
    for (const [pod, entry] of Object.entries(pods)) {
      table.pods[pod] = mergePodEntry(table.pods[pod], entry);
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

/** A version's numeric segments (`3.0.0` → [3, 0, 0]); undefined when one is not a number (`1.0.0-beta`, `#{v}`). */
function segments(version: string): number[] | undefined {
  const parts = version.split(".");
  return parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : undefined;
}

/** -1, 0 or 1; a missing segment counts as 0. */
function compareSegments(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * Whether `version` meets every CocoaPods requirement in `requirements`: `= x` or a bare `x`, `!=`, `>`, `>=`, `<`, `<=`
 * and `~> a.b` (>= a.b, < a+1) or `~> a.b.c` (>= a.b.c, < a.(b+1)). Items are trimmed and may hold several requirements
 * separated by commas. Segments compare numerically. A requirement rn-xtool cannot read (an interpolation, a
 * prerelease) is taken as met: the check warns only about a mismatch it can show. The binary-pod resolver chooses
 * versions with the strict matcher instead (`satisfiesAll` in src/pods/versions.ts).
 */
export function podRequirementSatisfied(version: string, requirements: readonly string[]): boolean {
  const have = segments(version.trim());
  if (have === undefined) return true;
  return requirements
    .flatMap((r) => r.split(","))
    .map((r) => r.trim())
    .filter((r) => r !== "")
    .every((requirement) => {
      const m = /^(=|!=|>=|<=|>|<|~>)?\s*(\S+)$/.exec(requirement);
      const want = m === null ? undefined : segments(m[2]!);
      if (m === null || want === undefined) return true;
      const c = compareSegments(have, want);
      switch (m[1] ?? "=") {
        case "=":
          return c === 0;
        case "!=":
          return c !== 0;
        case ">":
          return c > 0;
        case ">=":
          return c >= 0;
        case "<":
          return c < 0;
        case "<=":
          return c <= 0;
        default: {
          // `~>`: at least the version, below the next release of its second-to-last segment.
          const upper = want.length > 1 ? want.slice(0, -1) : [...want];
          upper[upper.length - 1]! += 1;
          return c >= 0 && compareSegments(have, upper) < 0;
        }
      }
    });
}
