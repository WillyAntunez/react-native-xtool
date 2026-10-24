import { decodePlist, type PlistValue } from "./plistio.js";

/** The parts of a usbmuxd/lockdown pair record that a host needs to open a session. */
export interface PairRecord {
  HostID: string;
  SystemBUID: string;
  /** PEM. */
  HostCertificate: Buffer;
  /** PEM. */
  HostPrivateKey: Buffer;
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
  const missing = [
    typeof dict.HostID === "string" ? undefined : "HostID",
    typeof dict.SystemBUID === "string" ? undefined : "SystemBUID",
    cert ? undefined : "HostCertificate",
    key ? undefined : "HostPrivateKey",
  ].filter(Boolean);
  if (missing.length) throw new Error(`${source} is not a usable pair record (missing ${missing.join(", ")})`);
  const record: PairRecord = {
    HostID: dict.HostID as string,
    SystemBUID: dict.SystemBUID as string,
    HostCertificate: cert!,
    HostPrivateKey: key!,
  };
  const root = asBuffer(dict.RootCertificate);
  const escrow = asBuffer(dict.EscrowBag);
  if (root) record.RootCertificate = root;
  if (escrow) record.EscrowBag = escrow;
  if (typeof dict.WiFiMACAddress === "string") record.WiFiMACAddress = dict.WiFiMACAddress;
  return record;
}
