import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { detectLanIp, findFreePort, isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import { run } from "../tools/exec.js";

const REMEDY = "`expo-xtool build && expo-xtool install`";

export function portMismatchMessage(built: number, wanted: number): string {
  return `App was built for Metro port ${built}, but that port is busy. Free port ${built}, or run ${REMEDY} to rebuild for port ${wanted}.`;
}

export function ipMismatchMessage(built: string, current: string): string {
  return `App was built for LAN IP ${built}, but this machine is now ${current}. Run ${REMEDY} so the app can find Metro.`;
}

export function startDecision(input: {
  portFree: boolean;
  builtIp: string;
  currentIp: string;
}): "ok" | "port-mismatch" | "ip-mismatch" {
  if (!input.portFree) return "port-mismatch";
  if (input.builtIp !== input.currentIp) return "ip-mismatch";
  return "ok";
}

export interface StartDeps {
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  isPortFree: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
  detectLanIp: () => Promise<string>;
  run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<unknown>;
}

const realDeps: StartDeps = {
  readState,
  loadConfig,
  isPortFree: (p) => isPortFree(p),
  findFreePort: (s) => findFreePort(s),
  detectLanIp: () => detectLanIp(),
  run,
};

export async function start(root: string, overrides: Partial<StartDeps> = {}): Promise<void> {
  const d: StartDeps = { ...realDeps, ...overrides };
  const state = await d.readState(projectPaths(root).iosXtool);
  if (!state) throw new Error("No build state found. Run `expo-xtool build` first.");
  const portFree = await d.isPortFree(state.metroPort);
  const config = await d.loadConfig(root);
  const currentIp = config.lanIp ?? (await d.detectLanIp());
  const decision = startDecision({ portFree, builtIp: state.lanIp, currentIp });
  if (decision !== "ok") {
    const message =
      decision === "port-mismatch"
        ? portMismatchMessage(state.metroPort, await d.findFreePort(state.metroPort + 1))
        : ipMismatchMessage(state.lanIp, currentIp);
    throw new Error(message);
  }
  await d.run("npx", ["expo", "start", "--lan", "--port", String(state.metroPort)], { cwd: root });
}
