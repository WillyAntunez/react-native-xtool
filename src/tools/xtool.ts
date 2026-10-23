import { execa } from "execa";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { ExpoXtoolConfig } from "../config.js";
import { cacheDir } from "../paths.js";
import { XTOOL_VERSION } from "../versions.js";
import { run, toolEnv } from "./exec.js";

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

export function xtoolBin(config: ExpoXtoolConfig): string {
  const bin = config.xtoolPath ?? join(cacheDir(), `xtool-${XTOOL_VERSION}.AppImage`);
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    throw new Error(`xtool not found at ${bin}. Run \`expo-xtool setup\` first.`);
  }
  return bin;
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

export async function authStatus(bin: string): Promise<AuthStatus> {
  const r = await execa(bin, ["auth", "status"], { env: toolEnv(), extendEnv: false });
  return parseAuthStatus(r.stdout);
}

/** `xtool devices` hangs forever with no device, so it is killed after `timeoutMs` and yields []. */
export async function listDevices(bin: string, timeoutMs = 30000): Promise<Device[]> {
  try {
    const r = await execa(bin, ["devices"], { env: toolEnv(), extendEnv: false, timeout: timeoutMs });
    return parseDevices(r.stdout);
  } catch (err) {
    if ((err as { timedOut?: boolean }).timedOut) return [];
    throw err;
  }
}

export function installedBundleId(teamId: string, bundleIdentifier: string): string {
  return `XTL-${teamId}.${bundleIdentifier}`;
}

export async function devBuild(bin: string, iosXtoolDir: string): Promise<void> {
  await run(bin, ["dev", "build", "--configuration", "debug"], { cwd: iosXtoolDir, nice: true });
}

export async function devRun(bin: string, iosXtoolDir: string): Promise<void> {
  await run(bin, ["dev", "run", "--configuration", "debug", "--usb"], { cwd: iosXtoolDir, nice: true });
}
