/**
 * The podspec reads the vendored scaffolder records in `RN_SPM_PODSPEC_READS` (`recordPodspecRead` in
 * vendor/rn-spm/spm/read-podspec.js): one JSON line per read, turned here into the `⚠` line `rn-spm` prints and the
 * lines of `doctor --report`. The `ENV` names a podspec read never go to the terminal during a build (R4).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { troubleshootingUrl } from "../docs.js";

export interface PodspecRead {
  /** The podspec's absolute path. */
  podspec: string;
  reader: "ruby" | "reduced";
  /** Why the reduced reader read it. */
  why?: string;
  /** `RN_XTOOL_PODSPEC_READER=reduced` picked the reduced reader. */
  forced: boolean;
  /** The Ruby version that read it. */
  ruby?: string;
  /** What the reader choice warned about (an unknown `RN_XTOOL_PODSPEC_READER` value). */
  warning?: string;
  /** The `ENV` names the podspec read. */
  env: string[];
  helpers: string[];
  ok: boolean;
  error?: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** One line of the file, or undefined when it is not a read. */
function podspecRead(line: string): PodspecRead | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.podspec !== "string" || (o.reader !== "ruby" && o.reader !== "reduced")) return undefined;
  const why = text(o.why);
  const ruby = text(o.ruby);
  const warning = text(o.warning);
  const error = text(o.error);
  return {
    podspec: o.podspec,
    reader: o.reader,
    ...(why !== undefined ? { why } : {}),
    forced: o.forced === true,
    ...(ruby !== undefined ? { ruby } : {}),
    ...(warning !== undefined ? { warning } : {}),
    env: strings(o.env),
    helpers: strings(o.helpers),
    ok: o.ok === true,
    ...(error !== undefined ? { error } : {}),
  };
}

/** The reads `file` records, in order: none without the file; a line that is not a read is skipped. */
export function readPodspecReads(file: string): PodspecRead[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(podspecRead)
    .filter((r): r is PodspecRead => r !== undefined);
}

const REDUCED = "so rn-xtool read the podspecs with its reduced reader, which evaluates a subset of Ruby";

/**
 * What `rn-spm` prints about its reads, once per run: the reader choice's warning, then, when the reduced reader read
 * a podspec, why and what to do (the escape named when it was used, R2). Nothing when Ruby read every podspec.
 */
export function readerLines(reads: PodspecRead[]): string[] {
  const lines: string[] = [];
  const warning = reads.find((r) => r.warning !== undefined)?.warning;
  if (warning !== undefined) lines.push(`⚠ ${warning}`);
  const reduced = reads.find((r) => r.reader === "reduced");
  if (reduced !== undefined) {
    const see = `See ${troubleshootingUrl("podspec-reader")}`;
    lines.push(
      reduced.forced
        ? `⚠ RN_XTOOL_PODSPEC_READER=reduced is set, ${REDUCED}; unset it to read them as CocoaPods does. ${see}`
        : `⚠ ${reduced.why ?? "Ruby was not used"}, ${REDUCED}; install Ruby (sudo apt install ruby) to read them as ` +
            `CocoaPods does. ${see}`,
    );
  }
  return lines;
}

/** Each podspec read (once, though several runs read it) with the sorted `ENV` names its reads used, path from `root`. */
function podspecEnvNames(reads: PodspecRead[], root: string): [string, string[]][] {
  const names = new Map<string, Set<string>>();
  for (const r of reads) {
    const set = names.get(r.podspec) ?? new Set<string>();
    for (const n of r.env) set.add(n);
    names.set(r.podspec, set);
  }
  return [...names]
    .filter(([, set]) => set.size > 0)
    .map(([podspec, set]): [string, string[]] => [path.relative(root, podspec), [...set].sort()]);
}

/** `ℹ podspec ENV — <podspec>: A, B` per podspec that read any `ENV` name: for the build log, never the terminal (R4). */
export function podspecEnvLines(reads: PodspecRead[], root: string): string[] {
  return podspecEnvNames(reads, root).map(([podspec, names]) => `ℹ podspec ENV — ${podspec}: ${names.join(", ")}`);
}

/**
 * `doctor --report`'s lines for the last `rn-spm`'s reads: `podspec reader: <ruby 3.3.8 | reduced: <why>> (last rn-spm,
 * <n> podspecs)`, or `podspec reader: not recorded` without any; then `podspec ENV:` and one `  <podspec>: A, B` line per
 * podspec that read any `ENV` name.
 */
export function podspecReportLines(reads: PodspecRead[], root: string): string[] {
  if (reads.length === 0) return ["podspec reader: not recorded"];
  const reduced = reads.find((r) => r.reader === "reduced");
  const reader = reduced !== undefined ? `reduced: ${reduced.why ?? "unknown"}` : `ruby ${reads[0]!.ruby ?? "unknown"}`;
  const n = new Set(reads.map((r) => r.podspec)).size;
  const env = podspecEnvNames(reads, root);
  return [
    `podspec reader: ${reader} (last rn-spm, ${n} ${n === 1 ? "podspec" : "podspecs"})`,
    ...(env.length > 0 ? ["podspec ENV:", ...env.map(([podspec, names]) => `  ${podspec}: ${names.join(", ")}`)] : []),
  ];
}
