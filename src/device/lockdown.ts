import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { DeviceClosedError, DeviceTimeoutError, DeviceUnreachableError } from "./errors.js";
import type { PairRecord } from "./pairRecord.js";
import { PlistChannel, type PlistDict, type PlistValue } from "./plistio.js";

export const LOCKDOWN_PORT = 62078;
export const WIRELESS_LOCKDOWN_DOMAIN = "com.apple.mobile.wireless_lockdown";

/** Opens a raw connection to a device port: plain TCP to its IP, or a usbmuxd tunnel. */
export type Connect = (port: number) => Promise<Duplex>;

export function tcpConnector(host: string, timeoutMs = 5000): Connect {
  return (port) =>
    new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      // Keep a listener for the socket's whole life: later errors surface as a closed connection.
      s.on("error", () => {});
      const fail = (reason: string): void => {
        clearTimeout(timer);
        s.destroy();
        reject(new DeviceUnreachableError(host, port, reason));
      };
      const timer = setTimeout(() => fail(`no TCP answer within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
      s.once("error", (e: NodeJS.ErrnoException) => fail(e.code ?? e.message));
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        s.on("error", () => {});
        s.setNoDelay(true);
        resolve(s);
      });
    });
}

export interface TlsCredentials {
  cert: Buffer;
  key: Buffer;
}

export function credentialsOf(record: PairRecord): TlsCredentials {
  return { cert: record.HostCertificate, key: record.HostPrivateKey };
}

/**
 * Client side of the device's TLS: the pair record's host certificate and key, no server
 * verification (the device certificate is self-issued), TLS 1.2 as negotiated by iOS.
 */
export function upgradeToTls(
  socket: Duplex,
  creds: TlsCredentials,
  what: string,
  timeoutMs = 10_000,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      socket,
      cert: creds.cert,
      key: creds.key,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    });
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        t.destroy();
        reject(err);
      } else {
        resolve(t);
      }
    };
    const timer = setTimeout(() => done(new DeviceTimeoutError(`${what} TLS handshake`, timeoutMs)), timeoutMs);
    t.on("error", (e) => done(e));
    t.once("close", () => done(new DeviceClosedError(`${what} TLS handshake`)));
    t.once("secureConnect", () => done());
  });
}

export class LockdownError extends Error {
  constructor(
    readonly request: string,
    readonly code: string,
    detail?: string,
  ) {
    super(lockdownErrorMessage(request, code, detail));
    this.name = "LockdownError";
  }
}

const REPAIR_HINT =
  "Connect it by USB once, tap Trust on the iPhone, then run `expo-xtool setup --wifi`.";

export function lockdownErrorMessage(request: string, code: string, detail?: string): string {
  switch (code) {
    case "InvalidHostID":
    case "PairingRejected":
      return `The iPhone no longer trusts this computer (its pairing was removed or belongs to another host). ${REPAIR_HINT}`;
    case "PasswordProtected":
      return "The iPhone is locked: unlock it and try again.";
    case "InvalidService":
      return `The iPhone refused to start ${detail ?? "a service"} (InvalidService).`;
    default:
      return `lockdownd ${request}${detail ? ` (${detail})` : ""} failed: ${code}`;
  }
}

export interface ServiceInfo {
  port: number;
  ssl: boolean;
}

export interface LockdownOptions {
  port?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** lockdownd client (port 62078): length-prefixed XML plists, TLS after StartSession. */
export class LockdownClient {
  private creds: TlsCredentials | undefined;
  sessionId: string | undefined;

  private constructor(
    private channel: PlistChannel,
    private readonly connect: Connect,
    private readonly timeoutMs: number,
  ) {}

  static async open(connect: Connect, opts: LockdownOptions = {}): Promise<LockdownClient> {
    const sock = await connect(opts.port ?? LOCKDOWN_PORT);
    const client = new LockdownClient(new PlistChannel(sock, "lockdownd"), connect, opts.timeoutMs ?? 15_000);
    try {
      const type = await client.queryType();
      if (type !== "com.apple.mobile.lockdown") {
        throw new Error(`Not an iPhone lockdown service (QueryType answered ${type})`);
      }
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  async request(request: string, extra: PlistDict = {}, what?: string): Promise<PlistDict> {
    const resp = await this.channel.request({ Label: "expo-xtool", Request: request, ...extra }, this.timeoutMs);
    if (resp.Error !== undefined) throw new LockdownError(request, String(resp.Error), what);
    if (resp.Request !== request) {
      throw new Error(`lockdownd answered ${String(resp.Request)} to ${request}`);
    }
    return resp;
  }

  async queryType(): Promise<string> {
    return String((await this.request("QueryType")).Type);
  }

  async getValue(key?: string, domain?: string): Promise<PlistValue | undefined> {
    const extra: PlistDict = {};
    if (domain) extra.Domain = domain;
    if (key) extra.Key = key;
    return (await this.request("GetValue", extra, [domain, key].filter(Boolean).join(" "))).Value;
  }

  /** UDID as reported before (or after) a session; works without a pair record. */
  async udid(): Promise<string> {
    const all = await this.getValue();
    const id = all && typeof all === "object" ? (all as PlistDict).UniqueDeviceID : undefined;
    if (typeof id !== "string") throw new Error("lockdownd did not report UniqueDeviceID");
    return id;
  }

  async setValue(domain: string, key: string, value: PlistValue): Promise<void> {
    await this.request("SetValue", { Domain: domain, Key: key, Value: value }, `${domain} ${key}`);
  }

  /** Validates the pairing and switches the lockdown connection to TLS when the device asks for it. */
  async startSession(record: PairRecord): Promise<void> {
    const resp = await this.request("StartSession", { HostID: record.HostID, SystemBUID: record.SystemBUID });
    const creds = credentialsOf(record);
    if (resp.EnableSessionSSL === true) {
      const raw = this.channel.detach();
      let secure: tls.TLSSocket;
      try {
        secure = await upgradeToTls(raw, creds, "lockdownd session");
      } catch (e) {
        raw.destroy();
        // The device drops the handshake when it no longer knows our host certificate.
        const code = (e as NodeJS.ErrnoException).code;
        if (e instanceof DeviceClosedError || code === "ECONNRESET" || code === "EPIPE") {
          throw new LockdownError("StartSession", "PairingRejected");
        }
        throw e;
      }
      this.channel = new PlistChannel(secure, "lockdownd");
    }
    this.creds = creds;
    this.sessionId = typeof resp.SessionID === "string" ? resp.SessionID : undefined;
  }

  async startService(name: string): Promise<ServiceInfo> {
    const resp = await this.request("StartService", { Service: name }, name);
    const port = Number(resp.Port);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`lockdownd gave no port for ${name}`);
    return { port, ssl: resp.EnableServiceSSL === true };
  }

  /** StartService, connect to the returned port, and wrap it in TLS when `EnableServiceSSL`. */
  async openService(name: string): Promise<Duplex> {
    const info = await this.startService(name);
    const sock = await this.connect(info.port);
    if (!info.ssl) return sock;
    if (!this.creds) {
      sock.destroy();
      throw new Error(`${name} needs TLS but no session was started`);
    }
    return upgradeToTls(sock, this.creds, name);
  }

  close(): void {
    this.channel.close();
  }
}
