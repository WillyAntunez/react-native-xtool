import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { cacheDir } from "../paths.js";
import { decodePlist, type PlistValue } from "./plistio.js";
import { checkUdid, UDID_PATTERN } from "./udid.js";

/** The parts of a usbmuxd/lockdown pair record that a host needs to open a session. */
export interface PairRecord {
  HostID: string;
  SystemBUID: string;
  /** PEM. */
  HostCertificate: Buffer;
  /** PEM. */
  HostPrivateKey: Buffer;
  /** PEM: the certificate the iPhone presents in TLS; used to authenticate it. */
  DeviceCertificate: Buffer;
  RootCertificate?: Buffer;
  EscrowBag?: Buffer;
  WiFiMACAddress?: string;
}

const asBuffer = (v: PlistValue | undefined): Buffer | undefined =>
  v instanceof Uint8Array ? Buffer.from(v) : typeof v === "string" ? Buffer.from(v) : undefined;

/** Parses an XML or binary pair record; `source` names it in errors. */
export function parsePairRecord(bytes: Buffer, source: string): PairRecord {
  let dict;
  try {
    dict = decodePlist(bytes);
  } catch (e) {
    throw new Error(`${source} is not a pair record: ${e instanceof Error ? e.message : String(e)}`);
  }
  const cert = asBuffer(dict.HostCertificate);
  const key = asBuffer(dict.HostPrivateKey);
  const device = asBuffer(dict.DeviceCertificate);
  const missing = [
    typeof dict.HostID === "string" ? undefined : "HostID",
    typeof dict.SystemBUID === "string" ? undefined : "SystemBUID",
    cert ? undefined : "HostCertificate",
    key ? undefined : "HostPrivateKey",
    device ? undefined : "DeviceCertificate",
  ].filter(Boolean);
  if (missing.length) throw new Error(`${source} is not a usable pair record (missing ${missing.join(", ")})`);
  const record: PairRecord = {
    HostID: dict.HostID as string,
    SystemBUID: dict.SystemBUID as string,
    HostCertificate: cert!,
    HostPrivateKey: key!,
    DeviceCertificate: device!,
  };
  const root = asBuffer(dict.RootCertificate);
  const escrow = asBuffer(dict.EscrowBag);
  // Unreadable credentials fail here, before anything (HostID included) is sent to a device.
  const unreadable = (name: string, check: () => unknown): void => {
    try {
      check();
    } catch (e) {
      throw new Error(`${source} has an unreadable ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  unreadable("HostCertificate", () => new X509Certificate(cert!));
  unreadable("HostPrivateKey", () => createPrivateKey(key!));
  unreadable("DeviceCertificate", () => new X509Certificate(device!));
  if (root) unreadable("RootCertificate", () => new X509Certificate(root));
  if (root) record.RootCertificate = root;
  if (escrow) record.EscrowBag = escrow;
  if (typeof dict.WiFiMACAddress === "string") record.WiFiMACAddress = dict.WiFiMACAddress;
  return record;
}

export const LOCKDOWN_DIR = "/var/lib/lockdown";

export function pairRecordCacheDir(): string {
  return join(cacheDir(), "pair-records");
}

export function pairRecordCachePath(udid: string, dir = pairRecordCacheDir()): string {
  return join(dir, `${udid}.plist`);
}

export class PairRecordMissingError extends Error {
  constructor(udid: string, cachePath: string) {
    super(
      [
        `No pair record for iPhone ${udid}. Pair it once over USB: connect the cable, tap Trust on the iPhone, then run \`rn-xtool setup --wifi\`.`,
        `On WSL2 or another machine: copy ${LOCKDOWN_DIR}/${udid}.plist from a Linux host where the iPhone is paired to ${cachePath}, or pass --pair-record <file>.`,
      ].join("\n"),
    );
    this.name = "PairRecordMissingError";
  }
}

export interface PairRecordSources {
  /** `--pair-record <file>`: used as-is, never cached. */
  override?: string;
  cacheDir?: string;
  lockdownDir?: string;
  /** usbmuxd ReadPairRecord; undefined when usbmuxd is down or has no record. */
  fromUsbmux?: (udid: string) => Promise<Buffer | undefined>;
}

export interface LoadedPairRecord {
  record: PairRecord;
  source: string;
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** The record holds the host private key: keep the cache private to the user. */
export async function cachePairRecord(udid: string, bytes: Buffer, dir = pairRecordCacheDir()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = pairRecordCachePath(checkUdid(udid, "pair record"), dir);
  // Written private from the start, then renamed: never a readable or half-written record.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return file;
}

/**
 * Finds the pair record for `udid`: `--pair-record`, then usbmuxd (which also serves stored
 * records with the cable unplugged), then our cache, then usbmuxd's own store. Records found in
 * usbmuxd are copied to the cache so later Wi‑Fi installs work without usbmuxd.
 */
export async function loadPairRecord(udid: string, src: PairRecordSources = {}): Promise<LoadedPairRecord> {
  const dir = src.cacheDir ?? pairRecordCacheDir();
  if (!src.override) checkUdid(udid, "pair record lookup");
  if (src.override) {
    const bytes = await readIfExists(src.override);
    if (!bytes) throw new Error(`Pair record not found: ${src.override}`);
    return { record: parsePairRecord(bytes, src.override), source: src.override };
  }
  const fromMux = await src.fromUsbmux?.(udid).catch(() => undefined);
  if (fromMux) {
    const record = parsePairRecord(fromMux, "usbmuxd pair record");
    await cachePairRecord(udid, fromMux, dir);
    return { record, source: "usbmuxd" };
  }
  const cached = pairRecordCachePath(udid, dir);
  const fromCache = await readIfExists(cached);
  if (fromCache) return { record: parsePairRecord(fromCache, cached), source: cached };
  const stored = join(src.lockdownDir ?? LOCKDOWN_DIR, `${udid}.plist`);
  const fromStore = await readIfExists(stored).catch(() => undefined);
  if (fromStore) {
    const record = parsePairRecord(fromStore, stored);
    await cachePairRecord(udid, fromStore, dir);
    return { record, source: stored };
  }
  throw new PairRecordMissingError(udid, cached);
}

const UDID_FILE = new RegExp(`${UDID_PATTERN.source.slice(0, -1)}\\.plist$`);

/** UDIDs we hold a pair record for (cache and usbmuxd's store). */
export async function pairedUdids(src: PairRecordSources = {}): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of [src.cacheDir ?? pairRecordCacheDir(), src.lockdownDir ?? LOCKDOWN_DIR]) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      const m = UDID_FILE.exec(n);
      if (m) found.add(m[1]!);
    }
  }
  return [...found].sort();
}
