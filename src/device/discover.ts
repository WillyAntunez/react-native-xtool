import net from "node:net";
import { DeviceAuthenticationError, DeviceTimeoutError, DeviceUnreachableError, message } from "./errors.js";
import { LOCKDOWN_PORT, LockdownClient, LockdownError, tcpConnector } from "./lockdown.js";
import type { LoadedPairRecord, PairRecord } from "./pairRecord.js";
import { sameUdid } from "./usbmux.js";

/** No paired iPhone answered anywhere on the subnet. Retryable: it is usually asleep. */
export class DeviceNotFoundError extends Error {
  /** `unpaired`: descriptions of lockdown hosts that answered but accept none of our pair records. */
  constructor(subnet: string, unpaired: string[] = []) {
    super(
      `no paired iPhone answered on ${subnet} (port ${LOCKDOWN_PORT})` +
        (unpaired.length
          ? `; not paired with this computer: ${unpaired.join(", ")} — if one is yours, pair it over USB once (\`expo-xtool setup --wifi\`) or pass --pair-record <file>`
          : ""),
    );
    this.name = "DeviceNotFoundError";
  }
}

/** Every other host of `ip`'s /24 (.1–.254). */
export function subnet24Hosts(ip: string): string[] {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new Error(`Not an IPv4 address: ${ip}`);
  }
  const prefix = parts.slice(0, 3).join(".");
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) {
    const h = `${prefix}.${i}`;
    if (h !== ip) hosts.push(h);
  }
  return hosts;
}

export const subnet24 = (ip: string): string => `${ip.split(".").slice(0, 3).join(".")}.0/24`;

/** True when something accepts TCP on host:port within the timeout. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface ScanOptions {
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

/** Hosts that accept TCP on the port, probed in parallel with short timeouts. */
export async function scanPort(hosts: string[], opts: ScanOptions = {}): Promise<string[]> {
  const port = opts.port ?? LOCKDOWN_PORT;
  const timeoutMs = opts.timeoutMs ?? 800;
  const probe = opts.probe ?? tcpProbe;
  const open: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < hosts.length) {
      const h = hosts[next++]!;
      if (await probe(h, port, timeoutMs)) open.push(h);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 64, hosts.length) }, worker));
  return open.sort((a, b) => hosts.indexOf(a) - hosts.indexOf(b));
}

/** Answers lockdown, but none of our pair records opens a session on it. */
export class UnknownDeviceError extends Error {
  constructor(readonly ip: string) {
    super(
      `${ip} answers as an iPhone but accepts none of this computer's pair records (not paired with it, or its pairing was reset). ` +
        "Pair it once over USB (`expo-xtool setup --wifi`), or pass --pair-record <file>.",
    );
    this.name = "UnknownDeviceError";
  }
}

/** A pair record to try when identifying a device. */
export interface PairCandidate {
  record: PairRecord;
}

/** Pair records for `udids` (in order, duplicates and unloadable ones skipped). */
export async function pairCandidates(
  udids: (string | undefined)[],
  load: (udid: string) => Promise<LoadedPairRecord>,
): Promise<PairCandidate[]> {
  const out: PairCandidate[] = [];
  const seen = new Set<string>();
  for (const u of udids) {
    if (!u || seen.has(u.toUpperCase())) continue;
    seen.add(u.toUpperCase());
    const loaded = await load(u).catch(() => undefined);
    if (loaded) out.push({ record: loaded.record });
  }
  return out;
}

/**
 * UDID of the iPhone answering lockdown at `ip`, read only inside an authenticated session: each
 * candidate pair record is tried, and only the iPhone it belongs to both accepts the session and
 * presents the record's DeviceCertificate (a session-less UDID could be spoofed by any host, and
 * iOS refuses it over Wi‑Fi anyway with GetProhibited).
 */
export async function identify(
  ip: string,
  opts: { port?: number; timeoutMs?: number; candidates?: () => Promise<PairCandidate[]> } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const open = (): Promise<LockdownClient> =>
    LockdownClient.open(tcpConnector(ip, timeoutMs), { port: opts.port ?? LOCKDOWN_PORT, timeoutMs });
  for (const c of (await opts.candidates?.()) ?? []) {
    const l = await open();
    try {
      await l.startSession(c.record);
      return await l.udid();
    } catch (e) {
      // Not this record's iPhone (refused, or not authenticated): try the next record.
      if (!(e instanceof LockdownError || e instanceof DeviceAuthenticationError)) throw e;
    } finally {
      l.close();
    }
  }
  throw new UnknownDeviceError(ip);
}

export interface LocateOptions {
  /** `install --network <ip>`: only this address is tried. */
  explicitIp?: string;
  /** Last address the iPhone answered on (build state). */
  lastIp?: string;
  /** `--udid`: this iPhone and no other. */
  udid?: string;
  /** The remembered iPhone (build state): preferred, but another single paired iPhone may replace it. */
  preferredUdid?: string;
  /** This computer's LAN address: its /24 is scanned. */
  lanIp: string;
  /** True when we hold a pair record for the UDID. */
  paired: (udid: string) => Promise<boolean>;
  identify?: (ip: string) => Promise<string>;
  scan?: (lanIp: string) => Promise<string[]>;
  log?: (s: string) => void;
}

export interface Located {
  ip: string;
  udid: string;
  scanned: boolean;
}

/** Paired iPhones answered, but not the wanted one (or too many to choose): waiting will not help. */
export class OtherIPhonesError extends Error {
  constructor(found: { ip: string; udid: string }[], wanted?: string) {
    super(
      `Found ${found.map((f) => `paired iPhone ${f.udid} at ${f.ip}`).join(", ")}` +
        `${wanted ? `, but not iPhone ${wanted}` : ""}; pass --udid <udid> to choose.`,
    );
    this.name = "OtherIPhonesError";
  }
}

/**
 * Finds the iPhone's address: the explicit IP, else the last known one, else a /24 scan for
 * port 62078 — always confirming the UDID, since any Apple device may answer there.
 */
export async function locateDevice(o: LocateOptions): Promise<Located> {
  const ident = o.identify ?? ((ip: string) => identify(ip));
  const scan = o.scan ?? ((lanIp: string) => scanPort(subnet24Hosts(lanIp)));
  const log = o.log ?? (() => {});
  const isStrict = (udid: string): boolean => !!o.udid && sameUdid(udid, o.udid);
  const isPreferred = (udid: string): boolean => !!o.preferredUdid && sameUdid(udid, o.preferredUdid);

  if (o.explicitIp) {
    const udid = await ident(o.explicitIp);
    if (o.udid && !isStrict(udid)) throw new Error(`${o.explicitIp} is iPhone ${udid}, not ${o.udid}`);
    return { ip: o.explicitIp, udid, scanned: false };
  }
  if (o.lastIp) {
    try {
      const udid = await ident(o.lastIp);
      // A wanted --udid is returned even unpaired: loading its pair record then explains the fix.
      if (o.udid ? isStrict(udid) : (!o.preferredUdid || isPreferred(udid)) && (await o.paired(udid))) {
        return { ip: o.lastIp, udid, scanned: false };
      }
      log(`iPhone ${udid} answers at ${o.lastIp}, not the one expected; scanning ${subnet24(o.lanIp)}…`);
    } catch (e) {
      log(`iPhone not at ${o.lastIp} (${message(e)}); scanning ${subnet24(o.lanIp)}…`);
    }
  } else {
    log(`Looking for the iPhone on ${subnet24(o.lanIp)}…`);
  }
  const answered: { ip: string; udid: string }[] = [];
  const unknown: string[] = [];
  for (const ip of await scan(o.lanIp)) {
    try {
      answered.push({ ip, udid: await ident(ip) });
    } catch (e) {
      if (e instanceof UnknownDeviceError) unknown.push(`a device at ${ip}`);
    }
  }
  const paired: { ip: string; udid: string }[] = [];
  const unpaired: string[] = [];
  for (const c of answered) {
    if (await o.paired(c.udid)) paired.push(c);
    else unpaired.push(`${c.udid} at ${c.ip}`);
  }
  // Unpaired answers may be someone else's iPhone while ours sleeps: still "not found" (retryable).
  const notFound = (): DeviceNotFoundError => new DeviceNotFoundError(subnet24(o.lanIp), [...unpaired, ...unknown]);

  if (o.udid) {
    const hit = answered.find((c) => isStrict(c.udid));
    if (hit) return { ...hit, scanned: true };
    if (paired.length) throw new OtherIPhonesError(paired, o.udid);
    throw notFound();
  }
  if (o.preferredUdid) {
    const hit = paired.find((c) => isPreferred(c.udid));
    if (hit) return { ...hit, scanned: true };
    if (paired.length === 1) {
      log(`The remembered iPhone ${o.preferredUdid} did not answer; using paired iPhone ${paired[0]!.udid} at ${paired[0]!.ip}.`);
    }
  }
  if (paired.length === 1) return { ...paired[0]!, scanned: true };
  if (paired.length > 1) throw new OtherIPhonesError(paired, o.preferredUdid);
  throw notFound();
}

export const NOT_RESPONDING = "iPhone did not respond over Wi‑Fi — unlock it and keep it awake, retrying…";

/** "The iPhone is not there right now" failures: worth waiting for the user to wake it. */
export function isUnreachable(e: unknown): boolean {
  return e instanceof DeviceUnreachableError || e instanceof DeviceNotFoundError || e instanceof DeviceTimeoutError;
}

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  log?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `fn`, retrying a bounded number of times (default 3 × 10 s) while the iPhone is unreachable. */
export async function retryWhileUnreachable<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  const delayMs = o.delayMs ?? 10_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isUnreachable(e)) throw e;
      if (attempt >= retries) {
        throw new Error(
          `iPhone did not respond over Wi‑Fi after ${retries + 1} tries (${message(e)}). ` +
            "Unlock it and keep the screen on, check it is on the same Wi‑Fi as this computer, " +
            "and that nothing blocks TCP port 62078; or connect it by USB and run `expo-xtool install`.",
        );
      }
      o.log?.(NOT_RESPONDING);
      await sleep(delayMs);
    }
  }
}
