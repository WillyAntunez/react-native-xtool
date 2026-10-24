import { AFC_SERVICE, AfcClient, type UploadProgress } from "./afc.js";
import { isConnectionFailure, message } from "./errors.js";
import { Heartbeat, type HeartbeatOptions } from "./heartbeat.js";
import { INSTALL_PROXY_SERVICE, InstallProxyClient, type InstallProgress } from "./installproxy.js";
import { LockdownClient, tcpConnector, type Connect } from "./lockdown.js";
import type { PairRecord } from "./pairRecord.js";
import type { PlistDict } from "./plistio.js";
import { sameUdid } from "./usbmux.js";

export const STAGING_DIR = "/PublicStaging";

/** One fixed name per app: a later run overwrites (truncates) whatever an interrupted one left. */
export function stagingPath(bundleId: string): string {
  return `${STAGING_DIR}/expo-xtool-${bundleId.replace(/[^A-Za-z0-9._-]/g, "_")}.ipa`;
}

/** The connection died while the .ipa was being staged; worth one more try. */
export class UploadInterruptedError extends Error {
  constructor(readonly reason: unknown) {
    super(`The upload to the iPhone was interrupted (${message(reason)})`);
    this.name = "UploadInterruptedError";
  }
}

export interface WifiInstallOptions {
  ip: string;
  udid: string;
  pairRecord: PairRecord;
  ipaPath: string;
  /** Installed bundle id (with xtool's `XTL-<team>.` prefix), used to verify. */
  bundleId: string;
  onUpload?: UploadProgress;
  onInstall?: InstallProgress;
  /** Tests: where lockdown and service ports are reached. */
  connect?: Connect;
  lockdownPort?: number;
  heartbeat?: HeartbeatOptions;
  connectTimeoutMs?: number;
}

export interface WifiInstallResult {
  app: PlistDict;
  bytes: number;
  uploadMs: number;
  installMs: number;
}

const CLEANUP_TIMEOUT_MS = 5000;

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

/**
 * Installs a signed .ipa over plain lockdown TCP (port 62078): session with the USB-made pair
 * record, heartbeat for the whole run, AFC upload to /PublicStaging, installd Install, Lookup.
 */
export async function installOverWifi(o: WifiInstallOptions): Promise<WifiInstallResult> {
  const connect = o.connect ?? tcpConnector(o.ip, o.connectTimeoutMs ?? 5000);
  const lockdown = await LockdownClient.open(connect, { port: o.lockdownPort });
  const remote = stagingPath(o.bundleId);
  let hb: Heartbeat | undefined;
  let afc: AfcClient | undefined;
  let staged = false;
  try {
    const udid = await lockdown.udid();
    if (!sameUdid(udid, o.udid)) throw new Error(`${o.ip} is iPhone ${udid}, not ${o.udid}`);
    await lockdown.startSession(o.pairRecord);
    // Must be answering before any other service connection is used.
    hb = await Heartbeat.start(lockdown, o.heartbeat);

    const t0 = Date.now();
    let bytes: number;
    try {
      afc = new AfcClient(await hb.guard(lockdown.openService(AFC_SERVICE)));
      await hb.guard(afc.makeDir(STAGING_DIR));
      staged = true;
      bytes = await hb.guard(afc.upload(o.ipaPath, remote, { onProgress: o.onUpload }));
    } catch (e) {
      throw isConnectionFailure(e) ? new UploadInterruptedError(e) : e;
    }
    const t1 = Date.now();

    const installd = new InstallProxyClient(await hb.guard(lockdown.openService(INSTALL_PROXY_SERVICE)));
    try {
      await hb.guard(installd.install(remote, o.onInstall));
    } finally {
      installd.close();
    }
    const t2 = Date.now();

    const lookup = new InstallProxyClient(await hb.guard(lockdown.openService(INSTALL_PROXY_SERVICE)));
    let apps: Record<string, PlistDict>;
    try {
      apps = await hb.guard(lookup.lookup([o.bundleId]));
    } finally {
      lookup.close();
    }
    const app = apps[o.bundleId];
    if (!app) throw new Error(`installd reported success, but ${o.bundleId} is not installed on the iPhone`);
    return { app, bytes, uploadMs: t1 - t0, installMs: t2 - t1 };
  } finally {
    // Best effort: installd may already have consumed the file, and a dead link cannot clean up
    // (the next run overwrites the same name anyway).
    if (afc && staged && hb && !hb.failure) await within(afc.removePath(remote).catch(() => {}), CLEANUP_TIMEOUT_MS);
    afc?.close();
    hb?.stop();
    lockdown.close();
  }
}
