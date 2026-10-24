import { nativeDepsFingerprint } from "../deps.js";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { detectLanIp, findFreePort, isMetroRunning, isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import { run } from "../tools/exec.js";

const REMEDY = "`expo-xtool build && expo-xtool install`";

export function portMismatchMessage(built: number, wanted: number): string {
  return `App was built for Metro port ${built}, but that port is busy (not a Metro bundler). Free port ${built}, or run ${REMEDY} to rebuild for port ${wanted}.`;
}

export function ipMismatchMessage(built: string, current: string): string {
  return `App was built for LAN IP ${built}, but this machine is now ${current}. Run ${REMEDY} so the app can find Metro.`;
}

/** An IP mismatch wins over everything: the app cannot reach Metro at the wrong address. */
export function startDecision(input: {
  portFree: boolean;
  metroRunning: boolean;
  builtIp: string;
  currentIp: string;
}): "ok" | "metro-running" | "port-mismatch" | "ip-mismatch" {
  if (input.builtIp !== input.currentIp) return "ip-mismatch";
  if (!input.portFree && input.metroRunning) return "metro-running";
  if (!input.portFree) return "port-mismatch";
  return "ok";
}

export interface StartDeps {
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
  detectLanIp: () => Promise<string>;
  depsFingerprint: (root: string) => Promise<string>;
  run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<unknown>;
  log: (s: string) => void;
}

const realDeps: StartDeps = {
  readState,
  loadConfig,
  isPortFree: (p) => isPortFree(p),
  isMetroRunning: (p) => isMetroRunning(p),
  findFreePort: (s) => findFreePort(s),
  detectLanIp: () => detectLanIp(),
  depsFingerprint: nativeDepsFingerprint,
  run,
  log: (s) => console.log(s),
};

export const DEPS_CHANGED_WARNING =
  "Dependencies changed since the last build; the installed app may miss native modules. Run `expo-xtool build && expo-xtool install` (or `expo-xtool run`).";

export async function start(
  root: string,
  opts: { clear?: boolean } = {},
  overrides: Partial<StartDeps> = {}): Promise<void> {
  const d: StartDeps = { ...realDeps, ...overrides };
  const state = await d.readState(projectPaths(root).iosXtool).catch(() => undefined);
  if (!state) throw new Error("No build state found. Run `expo-xtool build` first.");
  const portFree = await d.isPortFree(state.metroPort);
  const config = await d.loadConfig(root);
  const currentIp = config.lanIp ?? (await d.detectLanIp());
  const metroRunning = portFree ? false : await d.isMetroRunning(state.metroPort);
  const decision = startDecision({ portFree, metroRunning, builtIp: state.lanIp, currentIp });
  if (decision === "metro-running") {
    d.log(
      `Metro is already running on port ${state.metroPort} (http://${currentIp}:${state.metroPort}). Nothing to start — open the app on your iPhone.`,
    );
    return;
  }
  if (decision !== "ok") {
    const message =
      decision === "port-mismatch"
        ? portMismatchMessage(state.metroPort, await d.findFreePort(state.metroPort + 1))
        : ipMismatchMessage(state.lanIp, currentIp);
    throw new Error(message);
  }
  const depsChanged = state.depsFingerprint === undefined || state.depsFingerprint !== (await d.depsFingerprint(root));
  if (depsChanged) d.log(`⚠ ${DEPS_CHANGED_WARNING}`);
  const clear = opts.clear === true || depsChanged;
  await d.run("npx", ["expo", "start", "--lan", "--port", String(state.metroPort), ...(clear ? ["--clear"] : [])], {
    cwd: root,
  });
}
