/**
 * The weekly exploration of older lines (report only): create a fresh project for each explored Expo SDK and bare
 * React Native minor, run the capability detector on it and write one table row per target to the workflow summary.
 * It opens no issue. Whatever cannot be found out (a create or a probe that failed) reads "unknown" (failure row 10).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  detectCapabilities,
  unsupportedReason,
  type Capabilities,
  type PodspecFeature,
} from "../project/capabilities.js";
import { createProject, type Run } from "./check.js";
import type { WatchTarget } from "./targets.js";

export interface ExploreRow {
  id: string;
  installed: string;
  scripts: string;
  artifacts: string;
  expoPlugin: string;
  expoModules: string;
  podspecs: string;
  reason: string;
}

const COLUMNS: readonly [keyof ExploreRow, string][] = [
  ["id", "Target"],
  ["installed", "Installed"],
  ["scripts", "SwiftPM scripts"],
  ["artifacts", "Artifacts"],
  ["expoPlugin", "Expo plugin"],
  ["expoModules", "Expo modules"],
  ["podspecs", "Podspec features"],
  ["reason", "Reason"],
];

/** A cell for a fact the project does not have (no expo on a bare project). */
const NONE = "—";
const ERROR_LINE = /\berror\b|ERR!|\bfailed\b|✖/i;

/** Every cell "unknown", with the reason. */
function unknownRow(id: string, reason: string): ExploreRow {
  return {
    id,
    installed: "unknown",
    scripts: "unknown",
    artifacts: "unknown",
    expoPlugin: "unknown",
    expoModules: "unknown",
    podspecs: "unknown",
    reason,
  };
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function capped(line: string | undefined): string {
  if (line === undefined) return "(no output)";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** What a failed create printed that says why: its first error line, else its last line (npx's notices come first). */
function createHeadline(output: string): string {
  const all = nonEmptyLines(output);
  return capped(all.find((l) => ERROR_LINE.test(l)) ?? all.at(-1));
}

/** The first line of an error's message. */
function errorHeadline(e: unknown): string {
  return capped(nonEmptyLines(e instanceof Error ? e.message : String(e))[0]);
}

function artifactsCell(c: Capabilities): string {
  const a = c.artifacts;
  if (a === undefined) return NONE;
  if (a.status === "missing") return `missing: ${a.missing.join(", ")}`;
  if (a.status === "unknown" && a.detail !== undefined) return `unknown (${a.detail})`;
  return a.status;
}

function podspecsCell(podspecs: Record<PodspecFeature, string[]>): string {
  const used = Object.entries(podspecs).filter(([, pkgs]) => pkgs.length > 0);
  return used.length === 0 ? "none" : used.map(([feature, pkgs]) => `${feature}: ${pkgs.join(", ")}`).join("; ");
}

/** One row from what the detector found. */
function capabilityRow(id: string, c: Capabilities): ExploreRow {
  const installed = [
    ...(c.expoVersion === undefined ? [] : [`expo ${c.expoVersion}`]),
    ...(c.rnVersion === undefined ? [] : [`react-native ${c.rnVersion}`]),
  ];
  return {
    id,
    installed: installed.length === 0 ? "nothing installed" : installed.join(", "),
    scripts: c.scripts?.shape ?? NONE,
    artifacts: artifactsCell(c),
    expoPlugin: c.expoPlugin ?? NONE,
    expoModules: c.expoModules ?? NONE,
    podspecs: podspecsCell(c.podspecs),
    reason: unsupportedReason(c) ?? "covered by a supported line",
  };
}

/**
 * Explores one target in `dir`: creates it the way the daily check does (one retry after a network failure; skipped
 * with `existing`), then detects its capabilities. Never throws: a failed create or detector gives a row of "unknown".
 */
export async function exploreTarget(
  t: WatchTarget,
  dir: string,
  deps: { run: Run; capabilities?: typeof detectCapabilities; existing?: boolean },
): Promise<ExploreRow> {
  if (!deps.existing) {
    try {
      const created = await createProject(t, dir, deps.run);
      if (created.kind !== undefined) {
        return unknownRow(t.id, `could not create: ${createHeadline(created.step.output)}`);
      }
    } catch (e) {
      return unknownRow(t.id, `could not create: ${errorHeadline(e)}`);
    }
  }
  try {
    return capabilityRow(t.id, await (deps.capabilities ?? detectCapabilities)(dir));
  } catch (e) {
    return unknownRow(t.id, `could not detect: ${errorHeadline(e)}`);
  }
}

/** A Markdown cell: pipes escaped, on one line. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");
}

/** The exploration's Markdown table: the header, then one row each, in the order given. */
export function exploreTable(rows: ExploreRow[]): string {
  const header = `| ${COLUMNS.map(([, title]) => title).join(" | ")} |`;
  const rule = `|${COLUMNS.map(() => " --- |").join("")}`;
  const body = rows.map((r) => `| ${COLUMNS.map(([key]) => cell(r[key])).join(" | ")} |`);
  return `${[header, rule, ...body].join("\n")}\n`;
}

/** The rows in target order; a target without a row (its explore job did not finish) reads "unknown". */
export function exploreRowsFor(targets: readonly WatchTarget[], rows: readonly ExploreRow[]): ExploreRow[] {
  return targets.map(
    (t) => rows.find((r) => r.id === t.id) ?? unknownRow(t.id, "could not explore: the explore job did not finish"),
  );
}

function isExploreRow(v: unknown): v is ExploreRow {
  if (v === null || typeof v !== "object") return false;
  const record = v as Record<string, unknown>;
  return COLUMNS.every(([key]) => typeof record[key] === "string");
}

/** Every row under `dir` (the downloaded explore artifacts, merged or not); a missing folder holds none. */
export async function readExploreRows(dir: string): Promise<{ rows: ExploreRow[]; errors: string[] }> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], errors: [] };
    throw e;
  }
  const rows: ExploreRow[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (isExploreRow(parsed)) rows.push(parsed);
      else errors.push(`${f}: not an exploration row`);
    } catch (e) {
      errors.push(`${f}: unreadable row: ${(e as Error).message}`);
    }
  }
  return { rows, errors };
}
