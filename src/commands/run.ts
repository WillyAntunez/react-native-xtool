import { existsSync } from "node:fs";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { depsFingerprint } from "../deps.js";
import { listUsbDevices } from "../device/usbmux.js";
import { sameUdid } from "../device/udid.js";
import { detectLanIp, isMetroRunning, isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import { build } from "./build.js";
import { install, type InstallOptions } from "./install.js";
import { start, startDecision } from "./start.js";

export interface RunDeps {
  build: (root: string, opts: { clean?: boolean }) => Promise<void>;
  install: (root: string, opts: InstallOptions) => Promise<void>;
  start: (root: string, opts: { clear?: boolean }) => Promise<void>;
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  exists: (path: string) => boolean;
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  detectLanIp: () => Promise<string>;
  /** UDIDs of iPhones connected over USB now (empty when none or usbmuxd is down). */
  usbUdids: () => Promise<string[]>;
  log: (s: string) => void;
}

const realDeps: RunDeps = {
  build,
  install: (root, opts) => install(root, {}, opts),
  start,
  readState,
  depsFingerprint: depsFingerprint,
  exists: existsSync,
  loadConfig,
  isPortFree: (p) => isPortFree(p),
  isMetroRunning: (p) => isMetroRunning(p),
  detectLanIp: () => detectLanIp(),
  usbUdids: async () => (await listUsbDevices().catch(() => [])).map((d) => d.udid),
  log: (s) => console.log(s),
};

export async function run(
  root: string,
  opts: { clean?: boolean; force?: boolean } & InstallOptions,
  overrides: Partial<RunDeps> = {},
): Promise<void> {
  const d: RunDeps = { ...realDeps, ...overrides };
  let rebuilt = true;
  if (opts.force !== true && opts.clean !== true && (await upToDate(root, d, opts))) {
    rebuilt = false;
    d.log("Native app is up to date (no dependency changes); skipping build and install.");
  } else {
    await d.build(root, { clean: opts.clean });
    // `--network [ip]` (and its --udid / --pair-record) go straight to install.
    await d.install(root, { network: opts.network, udid: opts.udid, pairRecord: opts.pairRecord });
  }
  // A rebuild means dependencies changed: Metro needs a fresh cache for new plugins and modules.
  await d.start(root, rebuilt ? { clear: true } : {});
}

/** Up to date = built and installed for the current dependencies, and `start` would accept the baked port and IP. */
async function upToDate(root: string, d: RunDeps, opts: InstallOptions): Promise<boolean> {
  const paths = projectPaths(root);
  const state = await d.readState(paths.iosXtool).catch(() => undefined);
  if (!state?.depsFingerprint || !d.exists(paths.appBundle)) return false;
  const current = await d.depsFingerprint(root);
  if (state.depsFingerprint !== current || state.installedFingerprint !== current) return false;
  // Installed, but on which iPhone? Another target counts as not installed.
  const target = opts.network ? (opts.udid ?? state.deviceUdid) : (await d.usbUdids())[0];
  if (target && !(state.installedUdid && sameUdid(state.installedUdid, target))) return false;
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
