import { execa } from "execa";
import { accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import type { ExpoXtoolConfig } from "../config.js";
import { cacheDir, swiftHeadersEnv } from "../paths.js";
import { XTOOL_VERSION } from "../versions.js";
import { run, runTee, toolEnv } from "./exec.js";

export interface AuthStatus {
  loggedIn: boolean;
  teamId?: string;
  appleId?: string;
}
export interface Device {
  name: string;
  udid: string;
  transport: string;
}

/** Where `expo-xtool setup` downloads the pinned xtool AppImage. */
export function defaultXtoolPath(): string {
  return join(cacheDir(), `xtool-${XTOOL_VERSION}.AppImage`);
}

export function xtoolBin(config: ExpoXtoolConfig): string {
  const bin = config.xtoolPath ?? defaultXtoolPath();
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(`xtool not found at ${bin}. Run \`expo-xtool setup\` first.`);
  }
  return bin;
}

/** Error for an xtool that exited non-zero without producing any recognizable output. */
export function xtoolUnrunnableError(exitCode: number | undefined, output: string): Error {
  return new Error(
    `xtool could not run (exit ${exitCode ?? "unknown"}): ${output.trim().slice(0, 300)}. ` +
      "On Ubuntu this usually means libfuse2 is missing: sudo apt install libfuse2",
  );
}

export function parseAuthStatus(stdout: string): AuthStatus {
  if (!/^Logged in\./m.test(stdout)) return { loggedIn: false };
  const status: AuthStatus = { loggedIn: true };
  const appleId = /^- Apple ID:\s*(.+)$/m.exec(stdout)?.[1];
  const teamId = /^- Team ID:\s*(.+)$/m.exec(stdout)?.[1];
  if (appleId) status.appleId = appleId.trim();
  if (teamId) status.teamId = teamId.trim();
  return status;
}

export function parseDevices(stdout: string): Device[] {
  const devices: Device[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?) \[([^\]]+)\]:\s*(\S+)\s*$/.exec(line);
    if (m) devices.push({ name: m[1]!, transport: m[2]!, udid: m[3]! });
  }
  return devices;
}

export async function authStatus(bin: string, timeoutMs?: number): Promise<AuthStatus> {
  const r = await execa(bin, ["auth", "status"], {
    env: toolEnv(),
    extendEnv: false,
    reject: false,
    timeout: timeoutMs,
  });
  if (r.timedOut) throw new Error("timed out");
  // Non-zero exits still carry a usable message; only a failed spawn (no exit code) is fatal.
  if (r.failed && r.exitCode === undefined) throw r;
  const output = `${r.stdout}\n${r.stderr}`;
  if (r.failed && !/Logged (in|out)/.test(output)) throw xtoolUnrunnableError(r.exitCode, output);
  return parseAuthStatus(output);
}

/**
 * `xtool devices --no-wait` returns at once with no device. The timeout is a safety net, and it kills
 * the whole process group: the AppImage runtime runs xtool in a child, and killing only the launcher
 * leaves that child holding stdout, so the call would never return.
 */
export async function listDevices(bin: string, timeoutMs = 30000): Promise<Device[]> {
  const subprocess = execa(bin, ["devices", "--no-wait"], {
    env: toolEnv(),
    extendEnv: false,
    detached: true,
    timeout: timeoutMs,
  });
  const killGroup = (): void => {
    if (subprocess.pid === undefined) return;
    try {
      process.kill(-subprocess.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  };
  const timer = setTimeout(killGroup, timeoutMs);
  try {
    const r = await subprocess;
    return parseDevices(r.stdout);
  } catch (err) {
    if ((err as { timedOut?: boolean; isTerminated?: boolean }).timedOut || (err as { isTerminated?: boolean }).isTerminated) {
      killGroup();
      return [];
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function installedBundleId(teamId: string, bundleIdentifier: string): string {
  return `XTL-${teamId}.${bundleIdentifier}`;
}

/**
 * Env for `xtool dev build`/`dev run`: both re-evaluate the package manifests, and scaffolded
 * mixed-language ones read the generated Swift headers dir from it (xtool passes its env through
 * to `swift build`).
 */
export function devEnv(iosXtoolDir: string): NodeJS.ProcessEnv {
  return toolEnv(swiftHeadersEnv(iosXtoolDir));
}

/** Runs a command to completion; `run` by default, injectable for tests. */
export type DevRunner = typeof run;

export async function devBuild(bin: string, iosXtoolDir: string, runner: DevRunner = run): Promise<void> {
  await runner(bin, ["dev", "build", "--configuration", "debug"], {
    cwd: iosXtoolDir,
    nice: true,
    env: devEnv(iosXtoolDir),
  });
}

export async function devRun(bin: string, iosXtoolDir: string, runner: DevRunner = run): Promise<void> {
  await runner(bin, ["dev", "run", "--configuration", "debug", "--usb"], {
    cwd: iosXtoolDir,
    nice: true,
    env: devEnv(iosXtoolDir),
  });
}

/** Runs a command to completion and returns its output; `runTee` by default. */
export type CaptureRunner = (...args: Parameters<typeof runTee>) => Promise<string>;

/** The .ipa path from xtool's `Wrote to <path>` line (relative paths are against `cwd`). */
export function parseIpaPath(output: string, cwd: string): string | undefined {
  const matches = [...output.matchAll(/^Wrote to (.+?)\s*$/gm)];
  const last = matches.at(-1)?.[1];
  return last ? resolve(cwd, last) : undefined;
}

/** `xtool dev build --sign --ipa`: a signed .ipa to install without `dev run` (Wi‑Fi path). */
export async function devBuildIpa(bin: string, iosXtoolDir: string, runner: CaptureRunner = runTee): Promise<string> {
  const out = await runner(bin, ["dev", "build", "--configuration", "debug", "--sign", "--ipa"], {
    cwd: iosXtoolDir,
    nice: true,
    env: devEnv(iosXtoolDir),
  });
  const ipa = parseIpaPath(out, iosXtoolDir);
  if (!ipa) throw new Error("`xtool dev build --ipa` did not report the .ipa path (no `Wrote to` line)");
  return ipa;
}
