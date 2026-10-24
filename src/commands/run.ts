import { existsSync } from "node:fs";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { depsFingerprint } from "../deps.js";
import { detectLanIp, isMetroRunning, isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import { build } from "./build.js";
import { install } from "./install.js";
import { start, startDecision } from "./start.js";

export interface RunDeps {
  build: (root: string, opts: { clean?: boolean }) => Promise<void>;
  install: (root: string) => Promise<void>;
  start: (root: string, opts: { clear?: boolean }) => Promise<void>;
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  exists: (path: string) => boolean;
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  detectLanIp: () => Promise<string>;
  log: (s: string) => void;
}

const realDeps: RunDeps = {
  build,
  install,
  start,
  readState,
  depsFingerprint: depsFingerprint,
  exists: existsSync,
  loadConfig,
  isPortFree: (p) => isPortFree(p),
  isMetroRunning: (p) => isMetroRunning(p),
  detectLanIp: () => detectLanIp(),
  log: (s) => console.log(s),
};

export async function run(
  root: string,
  opts: { clean?: boolean; force?: boolean },
  overrides: Partial<RunDeps> = {},
): Promise<void> {
  const d: RunDeps = { ...realDeps, ...overrides };
  let rebuilt = true;
  if (opts.force !== true && opts.clean !== true && (await upToDate(root, d))) {
    rebuilt = false;
    d.log("Native app is up to date (no dependency changes); skipping build and install.");
  } else {
    await d.build(root, { clean: opts.clean });
    await d.install(root);
  }
  // A rebuild means dependencies changed: Metro needs a fresh cache for new plugins and modules.
  await d.start(root, rebuilt ? { clear: true } : {});
}

/** Up to date = built and installed for the current dependencies, and `start` would accept the baked port and IP. */
async function upToDate(root: string, d: RunDeps): Promise<boolean> {
  const paths = projectPaths(root);
  const state = await d.readState(paths.iosXtool).catch(() => undefined);
  if (!state?.depsFingerprint || !d.exists(paths.appBundle)) return false;
  const current = await d.depsFingerprint(root);
  if (state.depsFingerprint !== current || state.installedFingerprint !== current) return false;
  try {
    const portFree = await d.isPortFree(state.metroPort);
    const metroRunning = portFree ? false : await d.isMetroRunning(state.metroPort);
    const config = await d.loadConfig(root);
    const currentIp = config.lanIp ?? (await d.detectLanIp());
    const decision = startDecision({ portFree, metroRunning, builtIp: state.lanIp, currentIp });
    return decision === "ok" || decision === "metro-running";
  } catch {
    return false;
  }
}
