/**
 * A fake iPhone for unit tests: lockdownd on a random localhost port (plist framing, StartSession
 * with a TLS upgrade that checks the host certificate), one TCP+TLS port per started service, and
 * services that behave like iOS over Wi‑Fi: without a live heartbeat they drop the connection on
 * the first request.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { PlistChannel, type PlistDict } from "../../src/device/plistio.js";
import type { PairRecord } from "../../src/device/pairRecord.js";

const FIX = join(import.meta.dirname, "..", "fixtures", "device");
export const HOST_CERT = readFileSync(join(FIX, "host-cert.pem"));
export const HOST_KEY = readFileSync(join(FIX, "host-key.pem"));
const DEVICE_CERT = readFileSync(join(FIX, "device-cert.pem"));
const DEVICE_KEY = readFileSync(join(FIX, "device-key.pem"));
const DEVICE_KEY_AS_HOST = { cert: DEVICE_CERT, key: DEVICE_KEY };

export const UDID = "00008030-00000000DEADBEEF";

export const pairRecord = (over: Partial<PairRecord> = {}): PairRecord => ({
  HostID: "HOST-1",
  SystemBUID: "BUID-1",
  HostCertificate: HOST_CERT,
  HostPrivateKey: HOST_KEY,
  ...over,
});

/** A pair record whose certificate the fake device does not know. */
export const foreignPairRecord = (): PairRecord =>
  pairRecord({ HostCertificate: DEVICE_KEY_AS_HOST.cert, HostPrivateKey: DEVICE_KEY_AS_HOST.key });

export type ServiceHandler = (sock: Duplex, dev: FakeDevice) => void;

export interface FakeDeviceOptions {
  udid?: string;
  hostId?: string;
  /** iOS over Wi‑Fi: services close on the first request unless a heartbeat is answered. */
  requireHeartbeat?: boolean;
  heartbeatIntervalSec?: number;
  /** Sends no Marco at all. */
  heartbeatSilent?: boolean;
  values?: Record<string, PlistDict>;
  services?: Record<string, ServiceHandler>;
  /** Accept the TCP connection but never answer (asleep phone). */
  silent?: boolean;
}

const fingerprint = (pem: Buffer): string => new X509Certificate(pem).fingerprint256;

export class FakeDevice {
  lockdownPort = 0;
  heartbeatActive = false;
  polos = 0;
  readonly setValues: { domain: string; key: string; value: unknown }[] = [];
  readonly requests: string[] = [];
  readonly values: Record<string, PlistDict>;
  readonly udid: string;
  private servers: net.Server[] = [];
  private sockets = new Set<net.Socket>();
  private heartbeatTimers: NodeJS.Timeout[] = [];

  private constructor(readonly opts: FakeDeviceOptions) {
    this.udid = opts.udid ?? UDID;
    this.values = {
      "": { UniqueDeviceID: this.udid, DeviceName: "Fake iPhone", ProductVersion: "26.5" },
      "com.apple.mobile.wireless_lockdown": { EnableWifiConnections: false },
      ...opts.values,
    };
  }

  static async start(opts: FakeDeviceOptions = {}): Promise<FakeDevice> {
    const dev = new FakeDevice(opts);
    dev.lockdownPort = await dev.listen((s) => dev.serveLockdown(s));
    return dev;
  }

  private listen(onConn: (s: net.Socket) => void, once = false): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((s) => {
        this.sockets.add(s);
        s.on("close", () => this.sockets.delete(s));
        s.on("error", () => {});
        if (once) server.close();
        onConn(s);
      });
      this.servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  /** Server side of the TLS upgrade; resolves undefined when the host certificate is unknown. */
  private secure(raw: Duplex): Promise<tls.TLSSocket | undefined> {
    return new Promise((resolve) => {
      const t = new tls.TLSSocket(raw as net.Socket, {
        isServer: true,
        secureContext: tls.createSecureContext({ cert: DEVICE_CERT, key: DEVICE_KEY }),
        requestCert: true,
        rejectUnauthorized: false,
      });
      t.on("error", () => resolve(undefined));
      t.once("secure", () => {
        const peer = t.getPeerX509Certificate();
        if (!peer || peer.fingerprint256 !== fingerprint(HOST_CERT)) {
          t.destroy();
          raw.destroy();
          resolve(undefined);
          return;
        }
        resolve(t);
      });
    });
  }

  private async serveLockdown(sock: net.Socket): Promise<void> {
    if (this.opts.silent) return;
    let ch = new PlistChannel(sock, "fake lockdownd");
    let session = false;
    for (;;) {
      let req: PlistDict;
      try {
        req = await ch.recv();
      } catch {
        return;
      }
      const name = String(req.Request);
      this.requests.push(name);
      const reply = (extra: PlistDict): Promise<void> => ch.send({ Request: name, ...extra });
      switch (name) {
        case "QueryType":
          await reply({ Type: "com.apple.mobile.lockdown" });
          break;
        case "GetValue": {
          const domain = typeof req.Domain === "string" ? req.Domain : "";
          if (domain && !session) {
            await reply({ Error: "InvalidSession" });
            break;
          }
          const dict = this.values[domain] ?? {};
          const key = typeof req.Key === "string" ? req.Key : undefined;
          if (key && dict[key] === undefined) await reply({ Error: "MissingValue" });
          else await reply({ Value: key ? dict[key]! : dict });
          break;
        }
        case "SetValue": {
          if (!session) {
            await reply({ Error: "InvalidSession" });
            break;
          }
          const domain = String(req.Domain);
          this.values[domain] = { ...this.values[domain], [String(req.Key)]: req.Value! };
          this.setValues.push({ domain, key: String(req.Key), value: req.Value });
          await reply({});
          break;
        }
        case "StartSession": {
          if (req.HostID !== (this.opts.hostId ?? "HOST-1")) {
            await reply({ Error: "InvalidHostID" });
            break;
          }
          await reply({ SessionID: "S-1", EnableSessionSSL: true });
          const raw = ch.detach();
          const t = await this.secure(raw);
          if (!t) return;
          ch = new PlistChannel(t, "fake lockdownd");
          session = true;
          break;
        }
        case "StartService": {
          const service = String(req.Service);
          const handler = this.handlerFor(service);
          if (!session || !handler) {
            await reply({ Error: session ? "InvalidService" : "InvalidSession" });
            break;
          }
          const port = await this.listen(async (raw) => {
            const t = await this.secure(raw);
            if (t) handler(t, this);
          }, true);
          await reply({ Service: service, Port: port, EnableServiceSSL: true });
          break;
        }
        default:
          await reply({ Error: "UnknownRequest" });
      }
    }
  }

  private handlerFor(service: string): ServiceHandler | undefined {
    if (this.opts.services?.[service]) return this.gate(this.opts.services[service]!);
    if (service === "com.apple.mobile.heartbeat") return (s) => this.serveHeartbeat(s);
    return undefined;
  }

  /** Mimics iOS over Wi‑Fi: without a heartbeat, the first request closes the connection. */
  private gate(handler: ServiceHandler): ServiceHandler {
    return (sock, dev) => {
      // Registered before the handler's own listener, so a request never gets an answer.
      if (this.opts.requireHeartbeat) {
        sock.on("data", () => {
          if (!this.heartbeatActive) sock.destroy();
        });
      }
      handler(sock, dev);
    };
  }

  private async serveHeartbeat(sock: Duplex): Promise<void> {
    if (this.opts.heartbeatSilent) return;
    const ch = new PlistChannel(sock, "fake heartbeat");
    const interval = this.opts.heartbeatIntervalSec ?? 10;
    sock.once("close", () => (this.heartbeatActive = false));
    for (;;) {
      try {
        await ch.send({ Command: "Marco", Interval: interval, SupportsSleepyTime: true });
        const polo = await ch.recv(interval * 1000 + 2000);
        if (polo.Command !== "Polo") throw new Error("bad polo");
      } catch {
        this.heartbeatActive = false;
        sock.destroy();
        return;
      }
      this.polos++;
      this.heartbeatActive = true;
      await new Promise<void>((r) => this.heartbeatTimers.push(setTimeout(r, interval * 1000)));
    }
  }

  /** Simulates the iPhone dropping off the network: every open connection dies. */
  dropAll(): void {
    this.heartbeatActive = false;
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    for (const t of this.heartbeatTimers) clearTimeout(t);
    for (const s of this.sockets) s.destroy();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
