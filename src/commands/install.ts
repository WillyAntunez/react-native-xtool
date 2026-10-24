import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { projectPaths } from "../paths.js";
import { readState, type BuildState } from "../state.js";
import {
  authStatus,
  devRun,
  installedBundleId,
  listDevices,
  xtoolBin,
  type AuthStatus,
  type Device,
} from "../tools/xtool.js";

export interface InstallDeps {
  xtool?: {
    loadConfig?: (root: string) => Promise<ExpoXtoolConfig>;
    bin?: (config: ExpoXtoolConfig) => string;
    authStatus?: (bin: string) => Promise<AuthStatus>;
    listDevices?: (bin: string) => Promise<Device[]>;
    readState?: (iosXtoolDir: string) => Promise<Pick<BuildState, "bundleIdentifier" | "metroPort" | "lanIp"> | undefined>;
    devRun?: (bin: string, iosXtoolDir: string) => Promise<void>;
  };
  log?: (s: string) => void;
}

export function firstRunChecklist(appleId: string | undefined): string {
  return [
    "First-run checklist:",
    "  - Enable Developer Mode: Settings → Privacy & Security → Developer Mode (the phone reboots).",
    `  - Trust the developer certificate: Settings → General → VPN & Device Management → Apple Development: ${appleId ?? "<your Apple ID>"} → Trust.`,
    "  - Allow Local Network access when iOS asks (needed to reach Metro).",
    "  - With a free Apple ID the signature expires in 7 days; reinstall the app with `expo-xtool install`.",
  ].join("\n");
}

export async function install(root: string, deps: InstallDeps = {}): Promise<void> {
  const x = deps.xtool ?? {};
  const log = deps.log ?? ((s: string) => console.log(s));
  const config = await (x.loadConfig ?? loadConfig)(root);
  const bin = (x.bin ?? xtoolBin)(config);
  const auth = await (x.authStatus ?? authStatus)(bin);
  if (!auth.loggedIn) {
    throw new Error(`Not logged in to Apple Developer Services. Run: ${bin} auth login`);
  }
  if (!auth.teamId) {
    throw new Error(
      `Could not determine the Apple Team ID from \`xtool auth status\`; run \`${bin} auth login\` again.`,
    );
  }
  const devices = (await (x.listDevices ?? listDevices)(bin)).filter((d) => d.transport === "usb");
  if (devices.length === 0) {
    throw new Error(
      "No iPhone found over USB. Connect it, tap Trust on the phone, and enable Developer Mode (Settings → Privacy & Security).",
    );
  }
  const iosXtool = projectPaths(root).iosXtool;
  const state = await (x.readState ?? readState)(iosXtool).catch(() => undefined);
  if (!state) throw new Error("No build found. Run `expo-xtool build` first.");
  await (x.devRun ?? devRun)(bin, iosXtool);
  const id = installedBundleId(auth.teamId, state.bundleIdentifier);
  log(`Installed ${id} on ${devices[0]!.name}`);
  log(`Metro URL for the dev launcher: http://${state.lanIp}:${state.metroPort}`);
  log(firstRunChecklist(auth.appleId));
}
