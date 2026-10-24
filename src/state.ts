import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BuildState {
  version: 1;
  metroPort: number;
  lanIp: string;
  bundleIdentifier: string;
  builtAt: string;
  /** Hash of the installed dependencies at build time; absent in states written by older versions. */
  depsFingerprint?: string;
  /** depsFingerprint of the build that `install` last put on the device. */
  installedFingerprint?: string;
  /** UDID of the iPhone that `install` last installed on (USB or Wi‑Fi). */
  installedUdid?: string;
  /** Last address the iPhone answered on over Wi‑Fi (`install --network`). */
  deviceIp?: string;
  /** UDID of the iPhone last installed over Wi‑Fi. */
  deviceUdid?: string;
}

const STATE_FILE = ".expo-xtool-state.json";

export async function writeState(iosXtoolDir: string, state: BuildState): Promise<void> {
  await mkdir(iosXtoolDir, { recursive: true });
  await writeFile(join(iosXtoolDir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export async function readState(iosXtoolDir: string): Promise<BuildState | undefined> {
  const file = join(iosXtoolDir, STATE_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let parsed: Partial<BuildState>;
  try {
    parsed = JSON.parse(raw) as Partial<BuildState>;
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed.version !== 1) {
    throw new Error(`Unsupported state version ${String(parsed.version)} in ${file}; expected 1. Run expo-xtool build.`);
  }
  return parsed as BuildState;
}

/**
 * Records where the iPhone answered over Wi‑Fi (and, after an install, the installed build's
 * fingerprint) in one write; a no-op before the first build.
 */
export async function rememberDevice(
  iosXtoolDir: string,
  device: { deviceIp: string; deviceUdid: string; installedUdid?: string; installedFingerprint?: string },
): Promise<void> {
  const state = await readState(iosXtoolDir);
  if (state) await writeState(iosXtoolDir, { ...state, ...device });
}
