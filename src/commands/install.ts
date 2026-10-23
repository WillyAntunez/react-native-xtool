import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { projectPaths } from "../paths.js";
import { readExpoProject } from "../project.js";
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
    readProject?: (root: string) => Promise<{ bundleIdentifier: string }>;
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
  const project = await (x.readProject ?? readExpoProject)(root);
  await (x.devRun ?? devRun)(bin, projectPaths(root).iosXtool);
  const id = installedBundleId(auth.teamId, project.bundleIdentifier);
  log(`Installed ${id} on ${devices[0]!.name}`);
  log(firstRunChecklist(auth.appleId));
}
