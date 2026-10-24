import net from "node:net";
import { DeviceTimeoutError, DeviceUnreachableError, message } from "./errors.js";
import { LOCKDOWN_PORT, LockdownClient, tcpConnector } from "./lockdown.js";
import { sameUdid } from "./usbmux.js";

/** No paired iPhone answered anywhere on the subnet. Retryable: it is usually asleep. */
export class DeviceNotFoundError extends Error {
  constructor(subnet: string, unpaired: { ip: string; udid: string }[] = []) {
    super(
      `no paired iPhone answered on ${subnet} (port ${LOCKDOWN_PORT})` +
        (unpaired.length
          ? `; unpaired: ${unpaired.map((c) => `${c.udid} at ${c.ip}`).join(", ")} — if one is yours, pair it over USB once (\`expo-xtool setup --wifi\`) or pass --pair-record <file> with --udid <udid>`
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

/** UDID of the iPhone answering lockdown at `ip` (no pair record needed). */
export async function identify(ip: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const l = await LockdownClient.open(tcpConnector(ip, timeoutMs), { port: opts.port ?? LOCKDOWN_PORT, timeoutMs });
  try {
    return await l.udid();
  } finally {
    l.close();
  }
}

export interface LocateOptions {
  /** `install --network <ip>`: only this address is tried. */
  explicitIp?: string;
  /** Last address the iPhone answered on (build state). */
  lastIp?: string;
  /** Wanted iPhone; when unset, the one paired iPhone found wins. */
  udid?: string;
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

/**
 * Finds the iPhone's address: the explicit IP, else the last known one, else a /24 scan for
 * port 62078 — always confirming the UDID, since any Apple device may answer there.
 */
export async function locateDevice(o: LocateOptions): Promise<Located> {
  const ident = o.identify ?? ((ip: string) => identify(ip));
  const scan = o.scan ?? ((lanIp: string) => scanPort(subnet24Hosts(lanIp)));
  const log = o.log ?? (() => {});
  const wanted = (udid: string): boolean => (o.udid ? sameUdid(udid, o.udid) : true);

  if (o.explicitIp) {
    const udid = await ident(o.explicitIp);
    if (!wanted(udid)) throw new Error(`${o.explicitIp} is iPhone ${udid}, not ${o.udid}`);
    return { ip: o.explicitIp, udid, scanned: false };
  }
  if (o.lastIp) {
    try {
      const udid = await ident(o.lastIp);
      // A wanted --udid is returned even unpaired: loading its pair record then explains the fix.
      if (wanted(udid) && (o.udid || (await o.paired(udid)))) return { ip: o.lastIp, udid, scanned: false };
      log(`${wanted(udid) ? `iPhone ${udid} (not paired with this computer)` : "Another device"} answers at ${o.lastIp}; scanning ${subnet24(o.lanIp)}…`);
    } catch (e) {
      log(`iPhone not at ${o.lastIp} (${message(e)}); scanning ${subnet24(o.lanIp)}…`);
    }
  } else {
    log(`Looking for the iPhone on ${subnet24(o.lanIp)}…`);
  }
  const candidates: { ip: string; udid: string }[] = [];
  for (const ip of await scan(o.lanIp)) {
    const udid = await ident(ip).catch(() => undefined);
    if (udid && wanted(udid)) candidates.push({ ip, udid });
  }
  const found = o.udid ? candidates : [];
  if (!o.udid) for (const c of candidates) if (await o.paired(c.udid)) found.push(c);
  // Unpaired answers may be someone else's iPhone while ours sleeps: still "not found" (retryable).
  if (found.length === 0) throw new DeviceNotFoundError(subnet24(o.lanIp), candidates);
  if (found.length > 1) {
    throw new Error(
      `Several paired iPhones answer on the LAN (${found.map((f) => `${f.udid} at ${f.ip}`).join(", ")}): pass --udid <udid>.`,
    );
  }
  return { ...found[0]!, scanned: true };
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
