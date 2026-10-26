import { LockdownClient, LockdownError, WIRELESS_LOCKDOWN_DOMAIN } from "../device/lockdown.js";
import {
  loadPairRecord,
  pairRecordCachePath,
  type LoadedPairRecord,
  type PairRecordSources,
} from "../device/pairRecord.js";
import {
  listUsbDevices,
  readPairRecordFromUsbmux,
  sameUdid,
  usbmuxConnector,
  type MuxDevice,
} from "../device/usbmux.js";

export const WIFI_KEY = "EnableWifiConnections";

type Lockdown = Pick<LockdownClient, "startSession" | "getValue" | "setValue" | "close">;

export interface SetupWifiDeps {
  listUsbDevices?: () => Promise<MuxDevice[]>;
  /** Lockdown over usbmuxd (USB) to the given usbmuxd device id. */
  openLockdown?: (deviceId: number) => Promise<Lockdown>;
  loadPairRecord?: (udid: string, src: PairRecordSources) => Promise<LoadedPairRecord>;
  log?: (s: string) => void;
}

export interface SetupWifiOptions {
  /** Explicit confirmation to change the setting on the iPhone. */
  yes?: boolean;
  udid?: string;
}

/** The iPhone's `EnableWifiConnections`; never written yet reads as off. */
export async function wifiEnabled(lockdown: Pick<LockdownClient, "getValue">): Promise<boolean> {
  try {
    return (await lockdown.getValue(WIFI_KEY, WIRELESS_LOCKDOWN_DOMAIN)) === true;
  } catch (e) {
    if (e instanceof LockdownError && e.code === "MissingValue") return false;
    throw e;
  }
}

/** Picks the USB iPhone to use (the only one, or the one matching `udid`). */
export function pickUsbDevice(devices: MuxDevice[], udid?: string): MuxDevice {
  const matching = udid ? devices.filter((d) => sameUdid(d.udid, udid)) : devices;
  if (matching.length === 0) {
    throw new Error(
      `No iPhone${udid ? ` ${udid}` : ""} connected over USB. Connect it with the cable, unlock it and tap Trust, then re-run \`rn-xtool setup --wifi\`.`,
    );
  }
  if (matching.length > 1) {
    throw new Error(`Several iPhones are connected over USB (${matching.map((d) => d.udid).join(", ")}): pass --udid <udid>.`);
  }
  return matching[0]!;
}

/**
 * One-time USB step for Wi‑Fi installs: caches the pair record and turns on the iPhone's
 * "connect via network" lockdown setting (only with `--yes`).
 */
export async function setupWifi(opts: SetupWifiOptions, deps: SetupWifiDeps = {}): Promise<void> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const device = pickUsbDevice(await (deps.listUsbDevices ?? listUsbDevices)(), opts.udid);
  const { record } = await (deps.loadPairRecord ?? loadPairRecord)(device.udid, {
    fromUsbmux: (udid) => readPairRecordFromUsbmux(udid),
  });
  const lockdown = await (deps.openLockdown ?? ((id: number) => LockdownClient.open(usbmuxConnector(id))))(device.deviceId);
  try {
    await lockdown.startSession(record);
    const name = await lockdown.getValue("DeviceName").catch(() => undefined);
    const label = `${typeof name === "string" ? `${name} ` : ""}(${device.udid})`;
    log(`✔ Pair record cached at ${pairRecordCachePath(device.udid)} (lets Wi‑Fi installs work without the cable)`);
    if (await wifiEnabled(lockdown)) {
      log(`✔ Wi‑Fi connections are already enabled on ${label}; nothing to change.`);
    } else if (!opts.yes) {
      log(`This sets ${WIFI_KEY}=true in ${WIRELESS_LOCKDOWN_DOMAIN} on ${label}, so it accepts installs over Wi‑Fi from computers it trusts.`);
      throw new Error("Nothing changed on the iPhone: re-run with --yes to confirm (`rn-xtool setup --wifi --yes`).");
    } else {
      await lockdown.setValue(WIRELESS_LOCKDOWN_DOMAIN, WIFI_KEY, true);
      if (!(await wifiEnabled(lockdown))) throw new Error(`The iPhone did not keep ${WIFI_KEY}=true`);
      log(`✔ Set ${WIFI_KEY}=true in ${WIRELESS_LOCKDOWN_DOMAIN} on ${label}.`);
    }
    log("Next: unplug the cable, keep the iPhone unlocked on the same Wi‑Fi, and run `rn-xtool install --network`.");
  } finally {
    lockdown.close();
  }
}
