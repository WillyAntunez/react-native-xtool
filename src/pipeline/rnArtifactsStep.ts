import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProjectPaths } from "../paths.js";
import { adaptedSlotIsCurrent, adaptSlot, ArtifactLayoutError, isHeadersSpecSlot } from "./rnArtifacts.js";
import { resolveRnDir, streamingRunner, vendoredScriptsRoot, type RnRunner } from "./rnSpm.js";

export type Flavor = "debug" | "release";

const FLAVORS: readonly Flavor[] = ["debug", "release"];

/** React Native's own artifact cache; raw slots stay here, as RN's downloader leaves them. */
export function rnArtifactsCacheRoot(): string {
  return path.join(homedir(), "Library", "Caches", "ReactNative", "spm-artifacts");
}

const BASE_ARTIFACTS = ["React", "ReactNativeDependencies", "hermes-engine"] as const;
const HEADERS_SPEC_ARTIFACTS = ["ReactNativeHeaders", "ReactNativeDependenciesHeaders"] as const;

/**
 * A raw slot the downloader finished: `artifacts.json` parses and every entry it must have points at an existing
 * xcframework (RN's five REQUIRED_ARTIFACTS for a headers-spec slot, the first three otherwise), and the Hermes
 * headers are staged. Anything less is downloaded again rather than adapted.
 */
export function rawSlotComplete(slot: string): boolean {
  let entries: Record<string, { xcframeworkPath?: unknown } | undefined>;
  try {
    entries = JSON.parse(readFileSync(path.join(slot, "artifacts.json"), "utf8")) as typeof entries;
  } catch {
    return false;
  }
  if (typeof entries !== "object" || entries === null) return false;
  const names = isHeadersSpecSlot(slot) ? [...BASE_ARTIFACTS, ...HEADERS_SPEC_ARTIFACTS] : BASE_ARTIFACTS;
  const complete = names.every((name) => {
    const xc = entries[name]?.xcframeworkPath;
    return typeof xc === "string" && existsSync(xc);
  });
  return complete && existsSync(path.join(slot, "hermes-headers", "hermes"));
}

export function downloadArtifactsArgv(version: string, flavor: Flavor, slot: string): string[] {
  return [
    path.join(vendoredScriptsRoot(), "spm", "download-spm-artifacts.js"),
    "--version",
    version,
    "--flavor",
    flavor,
    "--output",
    slot,
    "--allow-pre-headers-spec",
  ];
}

export interface RnArtifactsDeps {
  runner: RnRunner;
  log: (s: string) => void;
  cacheRoot: string;
  rnDir: string;
  adapt: typeof adaptSlot;
}

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-40).join("\n");
}

/**
 * Downloads both flavors into RN's cache when a slot is missing or incomplete, then returns the root to hand to
 * `rn-spm --artifacts`: RN's own `<cacheRoot>/<v>` for headers-spec slots, or `<paths.rnArtifacts>/<v>` holding
 * adapted copies of pre-headers-spec slots. Flavors with different layouts stop the build.
 */
export async function prepareRnArtifacts(
  paths: ProjectPaths,
  rnVersion: string,
  deps: Partial<RnArtifactsDeps> = {},
): Promise<string> {
  const runner = deps.runner ?? streamingRunner;
  const log = deps.log ?? ((s: string) => console.log(s));
  const cacheRoot = deps.cacheRoot ?? rnArtifactsCacheRoot();
  const adapt = deps.adapt ?? adaptSlot;
  const rawRoot = path.join(cacheRoot, rnVersion);
  const adaptedRoot = path.join(paths.rnArtifacts, rnVersion);

  for (const flavor of FLAVORS) {
    const slot = path.join(rawRoot, flavor);
    if (rawSlotComplete(slot)) continue;
    log(`Downloading React Native ${rnVersion} ${flavor} artifacts into ${slot}`);
    const rnDir = deps.rnDir ?? resolveRnDir(paths);
    const r = await runner("node", downloadArtifactsArgv(rnVersion, flavor, slot), {
      cwd: paths.ios,
      env: { RN_SPM_RN_ROOT: rnDir },
    });
    if (r.exitCode !== 0) {
      throw new Error(`Downloading React Native ${rnVersion} ${flavor} artifacts failed (exit ${r.exitCode}):\n${tail(r.output)}`);
    }
  }

  const headersSpec = FLAVORS.map((flavor) => isHeadersSpecSlot(path.join(rawRoot, flavor)));
  if (headersSpec.every(Boolean)) return rawRoot;
  const preSpec = FLAVORS.find((_, i) => !headersSpec[i]);
  if (headersSpec.some(Boolean)) {
    throw new ArtifactLayoutError(rnVersion, path.join(rawRoot, preSpec!), "ReactNativeHeaders.xcframework");
  }

  for (const flavor of FLAVORS) {
    const src = path.join(rawRoot, flavor);
    const dest = path.join(adaptedRoot, flavor);
    if (await adaptedSlotIsCurrent(src, dest)) continue;
    log(`Adapting React Native ${rnVersion} ${flavor} artifacts into ${dest}`);
    await adapt(src, dest, rnVersion);
  }
  return adaptedRoot;
}
