import { X509Certificate } from "node:crypto";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { DeviceAuthenticationError, DeviceClosedError, DeviceTimeoutError, DeviceUnreachableError } from "./errors.js";
import type { PairRecord } from "./pairRecord.js";
import { PlistChannel, type PlistDict, type PlistValue } from "./plistio.js";
import { checkUdid } from "./udid.js";

export const LOCKDOWN_PORT = 62078;
export const WIRELESS_LOCKDOWN_DOMAIN = "com.apple.mobile.wireless_lockdown";

/** Opens a raw connection to a device port: plain TCP to its IP, or a usbmuxd tunnel. */
export type Connect = ((port: number) => Promise<Duplex>) & {
  /** Where it connects, for messages ("192.168.1.10", "USB"). */
  host?: string;
};

export function tcpConnector(host: string, timeoutMs = 5000): Connect {
  const connect: Connect = (port) =>
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
  connect.host = host;
  return connect;
}

export interface TlsCredentials {
  cert: Buffer;
  key: Buffer;
  /** The iPhone's certificate from the pair record: the TLS peer must present it. */
  device?: X509Certificate;
  /** The pair record's root: a peer certificate it issued is also accepted. */
  root?: X509Certificate;
}

export function credentialsOf(record: PairRecord): TlsCredentials {
  return {
    cert: record.HostCertificate,
    key: record.HostPrivateKey,
    device: new X509Certificate(record.DeviceCertificate),
    ...(record.RootCertificate && { root: new X509Certificate(record.RootCertificate) }),
  };
}

/**
 * True when the TLS peer is the paired iPhone: it presents the pair record's DeviceCertificate
 * (or a certificate issued by the record's RootCertificate, whose key only the pairing host holds).
 */
export function isPairedPeer(peer: X509Certificate | undefined, creds: TlsCredentials): boolean {
  if (!peer) return false;
  if (creds.device && peer.fingerprint256 === creds.device.fingerprint256) return true;
  return !!creds.root && peer.checkIssued(creds.root) && peer.verify(creds.root.publicKey);
}

/**
 * Client side of the device's TLS (1.2, as iOS negotiates): we present the pair record's host
 * certificate and key. Node's CA verification is off because the device certificate is issued by
 * the pair record's own root, not a public CA; instead the peer certificate is checked against the
 * pair record (`isPairedPeer`) before the socket is handed back, so nothing is sent to an impostor.
 */
export function upgradeToTls(
  socket: Duplex,
  creds: TlsCredentials,
  what: string,
  host = "the iPhone's address",
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
    t.once("secureConnect", () =>
      done(creds.device || creds.root ? (isPairedPeer(t.getPeerX509Certificate(), creds) ? undefined : new DeviceAuthenticationError(host)) : undefined),
    );
  });
}

/** The link dropped during the session's TLS handshake; retryable like any unreachable phone. */
export class TlsHandshakeClosedError extends DeviceUnreachableError {
  constructor(host: string, port: number) {
    super(
      host,
      port,
      "the connection closed during the TLS handshake; if this keeps happening, the iPhone may no longer trust this computer: re-pair over USB with `expo-xtool setup --wifi`",
    );
    this.name = "TlsHandshakeClosedError";
  }
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

  /**
   * The device's UDID. Over Wi‑Fi iOS answers GetProhibited before StartSession (USB allows it),
   * so call it after `startSession` unless the connection goes through usbmuxd.
   */
  async udid(): Promise<string> {
    const id = await this.getValue("UniqueDeviceID");
    if (typeof id !== "string") throw new Error("lockdownd did not report UniqueDeviceID");
    return checkUdid(id, "lockdownd");
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
        secure = await upgradeToTls(raw, creds, "lockdownd session", this.connect.host);
      } catch (e) {
        raw.destroy();
        // The device drops the handshake when it no longer knows our host certificate.
        const code = (e as NodeJS.ErrnoException).code;
        if (e instanceof DeviceClosedError || code === "ECONNRESET" || code === "EPIPE") {
          // Usually a flaky link (retryable); a device that dropped our pairing answers
          // InvalidHostID before TLS instead.
          throw new TlsHandshakeClosedError(this.connect.host ?? "the iPhone", LOCKDOWN_PORT);
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
    return upgradeToTls(sock, this.creds, name, this.connect.host);
  }

  close(): void {
    this.channel.close();
  }
}
