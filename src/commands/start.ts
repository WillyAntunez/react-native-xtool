import { constants as osConstants, networkInterfaces } from "node:os";
import { onExit } from "signal-exit";
import { depsFingerprint } from "../deps.js";
import {
  announceDevServer,
  bonjourOffSwitch,
  lanAnnouncementFailure,
  type NetworkInterfaces,
} from "../devServerAnnounce.js";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { detectLanIp, findFreePort, isMetroRunning, isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import type { ProjectKind } from "../project/index.js";
import { readState, type BuildState } from "../state.js";
import { run, toolEnv } from "../tools/exec.js";

const REMEDY = "`rn-xtool build && rn-xtool install`";

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

/** The Metro command for the project kind; `clear` drops Metro's cache. */
export function metroCommand(kind: ProjectKind, port: number, clear: boolean): [string, string[]] {
  if (kind === "bare") {
    return ["npx", ["react-native", "start", "--port", String(port), ...(clear ? ["--reset-cache"] : [])]];
  }
  return ["npx", ["expo", "start", "--lan", "--port", String(port), ...(clear ? ["--clear"] : [])]];
}

export interface StartDeps {
  readState: (iosXtoolDir: string) => Promise<BuildState | undefined>;
  loadConfig: (root: string) => Promise<ExpoXtoolConfig>;
  isPortFree: (port: number) => Promise<boolean>;
  isMetroRunning: (port: number) => Promise<boolean>;
  findFreePort: (start: number) => Promise<number>;
  detectLanIp: () => Promise<string>;
  depsFingerprint: (root: string) => Promise<string>;
  run: (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<unknown>;
  /** Announces Metro over Bonjour for the dev launcher; returns the stop function. */
  announce: typeof announceDevServer;
  /** os.networkInterfaces: which interface carries the build's LAN IP. */
  networkInterfaces: () => NetworkInterfaces;
  /** signal-exit's onExit: `fn` runs, not awaited, however the process ends; returns the remover. */
  onExit: (fn: () => void) => () => void;
  /** Handles SIGINT and SIGTERM instead of dying at once; returns the remover. */
  onSignal: (fn: (signal: StopSignal) => void) => () => void;
  exit: (code: number) => void;
  /** The environment `start` runs in: a user's Bonjour off switch (CI, EXPO_UNSTABLE_BONJOUR). */
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
}

type StopSignal = "SIGINT" | "SIGTERM";

function onStopSignal(fn: (signal: StopSignal) => void): () => void {
  const handlers = { SIGINT: () => fn("SIGINT"), SIGTERM: () => fn("SIGTERM") };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  return () => {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  };
}

const realDeps: StartDeps = {
  readState,
  loadConfig,
  isPortFree: (p) => isPortFree(p),
  isMetroRunning: (p) => isMetroRunning(p),
  findFreePort: (s) => findFreePort(s),
  detectLanIp: () => detectLanIp(),
  depsFingerprint: depsFingerprint,
  run,
  announce: announceDevServer,
  networkInterfaces,
  onExit: (fn) => onExit(fn),
  onSignal: onStopSignal,
  exit: (code) => process.exit(code),
  env: process.env,
  log: (s) => console.log(s),
};

export const NO_FINGERPRINT_WARNING =
  "No dependency fingerprint recorded; run rn-xtool build to enable change detection.";

/** Bare fingerprints also cover the native project in ios/ (see `depsFingerprint`), so say so. */
export function changedSinceBuildWarning(kind: ProjectKind): string {
  return kind === "bare"
    ? "Native project or dependencies changed since the last build; the installed app may be out of date. Run `rn-xtool build && rn-xtool install` (or `rn-xtool run`)."
    : "Dependencies changed since the last build; the installed app may miss native modules. Run `rn-xtool build && rn-xtool install` (or `rn-xtool run`).";
}

export async function start(
  root: string,
  opts: { clear?: boolean } = {},
  overrides: Partial<StartDeps> = {},
): Promise<void> {
  const d: StartDeps = { ...realDeps, ...overrides };
  const state = await d.readState(projectPaths(root).iosXtool).catch(() => undefined);
  if (!state) throw new Error("No build state found. Run `rn-xtool build` first.");
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
  const missing = state.depsFingerprint === undefined;
  const depsChanged = !missing && state.depsFingerprint !== (await d.depsFingerprint(root));
  if (missing) d.log(`⚠ ${NO_FINGERPRINT_WARNING}`);
  else if (depsChanged) d.log(`⚠ ${changedSinceBuildWarning(state.kind ?? "expo")}`);
  const clear = opts.clear === true || missing || depsChanged;
  const kind = state.kind ?? "expo";
  const [cmd, args] = metroCommand(kind, state.metroPort, clear);
  // A user who turned Expo's announcement off (CI, EXPO_UNSTABLE_BONJOUR=0) gets none from rn-xtool either, and is
  // told so: the switch may come from a shell profile or a devcontainer they did not set up.
  const offSwitch = state.hasDevClient === true ? bonjourOffSwitch(d.env) : undefined;
  if (offSwitch !== undefined) {
    d.log(
      `ℹ Metro is not announced to the dev launcher: ${offSwitch} in the environment turns Bonjour off, as in Expo CLI. Open the app with the link \`rn-xtool install\` printed.`,
    );
  }
  const announces = state.hasDevClient === true && offSwitch === undefined;
  const stop = announces ? await announceForDevLauncher(root, state, d) : undefined;
  if (stop === undefined) {
    await d.run(cmd, args, { cwd: root });
    return;
  }
  // Ours replaces Expo's announcement, which carries the app config's id; bare `react-native start` announces nothing.
  const runOpts = kind === "expo" ? { cwd: root, env: toolEnv({ EXPO_UNSTABLE_BONJOUR: "0" }) } : { cwd: root };
  const stopOnce = boundedStop(stop);
  // On any other exit the stop is not awaited: a killed `start` leaves the record until its TTL ends.
  const removeExitHook = d.onExit(() => void stopOnce());
  // Ctrl+C or a kill: send the goodbye first, as Expo CLI does on SIGINT, then end as the signal would.
  const removeSignalHook = d.onSignal((signal) => {
    void stopOnce().then(() => d.exit(128 + osConstants.signals[signal]));
  });
  try {
    await d.run(cmd, args, runOpts);
  } finally {
    removeSignalHook();
    removeExitHook();
    await stopOnce();
  }
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs the announcement's stop; a stop that throws or returns no promise cannot hide Metro's result. */
const runStop = (stop: () => Promise<void>): Promise<void> => Promise.resolve().then(stop).catch(() => {});

/** How long `start` waits for the announcement's goodbye: dnssd-advertise's stop may never settle once Metro ended. */
export const STOP_GRACE_MS = 1000;

/**
 * The stop, run at most once and awaited at most STOP_GRACE_MS. The timer keeps Node's event loop alive meanwhile,
 * so a stop that never settles cannot end `rn-xtool start` with an unsettled top-level await.
 */
function boundedStop(stop: () => Promise<void>): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () =>
    (stopping ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_GRACE_MS);
      void runStop(stop).then(() => {
        clearTimeout(timer);
        resolve();
      });
    }));
}

/**
 * Announces Metro for expo-dev-launcher under the id of the app `install` put on the iPhone: Expo SDK 58's launcher
 * lists only servers announced with its own (signed) bundle id. Returns the stop function, or undefined when
 * nothing was announced and Metro keeps its own announcement.
 */
async function announceForDevLauncher(
  root: string,
  state: BuildState,
  d: StartDeps,
): Promise<(() => Promise<void>) | undefined> {
  const id = state.installedBundleId;
  if (id === undefined) {
    d.log(
      "ℹ No installed bundle id recorded: run `rn-xtool install` once so `start` can announce Metro under the app's real id (Expo SDK 58's dev launcher hides other servers).",
    );
    return undefined;
  }
  // Only an error that names the LAN interface is reported (once): errors on other interfaces (a Docker veth) or on
  // none are ignored, as Expo CLI ignores them all. dnssd-advertise reports them seconds after Metro started with
  // Expo's announcement off, so they can only be reported.
  const failedOnLan = lanAnnouncementFailure(state.lanIp, d.networkInterfaces());
  let warned = false;
  const onError = (e: unknown): void => {
    if (warned || !failedOnLan(e)) return;
    warned = true;
    d.log(
      `⚠ The Metro announcement for the dev launcher failed (${reasonOf(e)}). Open the app with the link \`rn-xtool install\` printed, or turn off "Match bundle identifier" in the launcher's Settings.`,
    );
  };
  try {
    const stop = await d.announce({
      root,
      name: state.name ?? state.slug ?? "app",
      slug: state.slug ?? "app",
      port: state.metroPort,
      iosBundleIdentifier: id,
      onError,
    });
    d.log(`ℹ Announcing Metro to the dev launcher as ${id}.`);
    return stop;
  } catch (e) {
    warned = true; // Expo's announcement stays on: nothing of ours to report on.
    d.log(
      (state.kind ?? "expo") === "bare"
        ? `ℹ Could not announce Metro for the dev launcher (${reasonOf(e)}); \`react-native start\` does not announce it, so the launcher will not list it. Open the app with the link \`rn-xtool install\` printed.`
        : `ℹ Could not announce Metro for the dev launcher (${reasonOf(e)}); Expo announces it under the app config's bundle id, which Expo SDK 58's dev launcher hides unless "Match bundle identifier" is off in its Settings.`,
    );
    return undefined;
  }
}
