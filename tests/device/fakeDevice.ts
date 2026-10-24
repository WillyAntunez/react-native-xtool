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
import { AFC_HEADER_SIZE, AfcOp, afcPacket, decodeAfcHeader, u64 } from "../../src/device/afc.js";
import { PlistChannel, type PlistDict } from "../../src/device/plistio.js";
import { ByteReader } from "../../src/device/stream.js";
import type { PairRecord } from "../../src/device/pairRecord.js";

const FIX = join(import.meta.dirname, "..", "fixtures", "device");
export const HOST_CERT = readFileSync(join(FIX, "host-cert.pem"));
export const HOST_KEY = readFileSync(join(FIX, "host-key.pem"));
const DEVICE_CERT = readFileSync(join(FIX, "device-cert.pem"));
const DEVICE_KEY = readFileSync(join(FIX, "device-key.pem"));
/** Same key as DEVICE_CERT, issued by ROOT_CERT (as iOS pairing does). */
export const DEVICE_SIGNED_CERT = readFileSync(join(FIX, "device-signed-cert.pem"));
export const ROOT_CERT = readFileSync(join(FIX, "root-cert.pem"));
export const DEVICE_CERT_PEM = DEVICE_CERT;
const DEVICE_KEY_AS_HOST = { cert: DEVICE_CERT, key: DEVICE_KEY };

export const UDID = "00008030-00000000DEADBEEF";

export const pairRecord = (over: Partial<PairRecord> = {}): PairRecord => ({
  HostID: "HOST-1",
  SystemBUID: "BUID-1",
  HostCertificate: HOST_CERT,
  HostPrivateKey: HOST_KEY,
  DeviceCertificate: DEVICE_CERT,
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
  /**
   * Answer UniqueDeviceID before a session (USB-style). By default the fake behaves like iOS 26
   * over Wi‑Fi: GetProhibited, and the session-less dictionary has no UniqueDeviceID.
   */
  udidBeforeSession?: boolean;
  /** Certificate presented in TLS (default: the pair record's DeviceCertificate). */
  presentCert?: Buffer;
  /** Impostor: StartSession succeeds without EnableSessionSSL and the session stays plaintext. */
  noSessionSsl?: boolean;
  /** Impostor: services are offered without EnableServiceSSL (plaintext ports). */
  noServiceSsl?: boolean;
  /** AFC: kill the connection when this write (1-based) arrives, like a Wi‑Fi drop. */
  afcDropOnWrite?: number;
  /** AFC: answer FileWrite with this status (e.g. 18 NoSpaceLeft). */
  afcWriteStatus?: number;
  /** installd: bundle id an installed package registers as. */
  bundleId?: string;
  /** installd: fail Install with this reply. */
  installError?: PlistDict;
  /** installd: after the first progress message, drop every connection (Wi‑Fi lost mid-install). */
  installDrop?: boolean;
  /** installd: after the first progress message, go silent. */
  installStall?: boolean;
  /** Once (first upload only): on this AFC write, kill just the heartbeat connection. */
  heartbeatDropOnWrite?: number;
  /** installd: after the first progress message, the heartbeat announces SleepyTime. */
  installSleepy?: boolean;
  /** installd: the iPhone drops off the network when Lookup arrives (after a successful Install). */
  lookupDrop?: boolean;
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
  /** AFC filesystem: closed files by path. */
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  readonly afcOps: string[] = [];
  maxAfcWrite = 0;
  /** installd: PackagePaths given to Install, and the apps it registered. */
  readonly installs: string[] = [];
  readonly apps: Record<string, PlistDict> = {};
  private servers: net.Server[] = [];
  private sockets = new Set<net.Socket>();
  private heartbeatTimers: NodeJS.Timeout[] = [];
  private heartbeat: { sock: Duplex; ch: PlistChannel } | undefined;
  private heartbeatDropped = false;

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
        secureContext: tls.createSecureContext({
          cert: this.opts.presentCert ?? DEVICE_CERT,
          key: this.opts.presentCert?.equals(HOST_CERT) ? HOST_KEY : DEVICE_KEY,
        }),
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
          let dict = this.values[domain] ?? {};
          const key = typeof req.Key === "string" ? req.Key : undefined;
          if (!session && !this.opts.udidBeforeSession) {
            if (key === "UniqueDeviceID") {
              await reply({ Error: "GetProhibited", Key: key });
              break;
            }
            const { UniqueDeviceID: _hidden, ...rest } = dict;
            dict = rest;
          }
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
          if (this.opts.noSessionSsl) {
            await reply({ SessionID: "S-1", EnableSessionSSL: false });
            session = true;
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
          const plain = this.opts.noServiceSsl === true;
          const port = await this.listen(async (raw) => {
            const t = plain ? raw : await this.secure(raw);
            if (t) handler(t, this);
          }, true);
          await reply({ Service: service, Port: port, EnableServiceSSL: !plain });
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
    if (service === "com.apple.mobile.installation_proxy") {
      return this.gate((s) => void this.serveInstallProxy(s).catch(() => s.destroy()));
    }
    if (service === "com.apple.afc") return this.gate((s) => void this.serveAfc(s).catch(() => s.destroy()));
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
    this.heartbeat = { sock, ch };
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

  private async serveAfc(sock: Duplex): Promise<void> {
    const r = new ByteReader(sock, "fake afc");
    const open = new Map<bigint, { path: string; chunks: Buffer[] }>();
    let nextHandle = 1n;
    let writes = 0;
    const cstr = (b: Buffer): string => b.subarray(0, b.indexOf(0)).toString("utf8");
    for (;;) {
      const h = decodeAfcHeader(await r.read(AFC_HEADER_SIZE));
      const rest = await r.read(h.entireLength - AFC_HEADER_SIZE);
      const args = rest.subarray(0, h.thisLength - AFC_HEADER_SIZE);
      const data = rest.subarray(h.thisLength - AFC_HEADER_SIZE);
      const status = (n: number): boolean => sock.write(Buffer.concat(afcPacket(AfcOp.Status, h.packetNum, u64(n))));
      switch (h.op) {
        case AfcOp.MakeDir:
          this.afcOps.push(`MakeDir ${cstr(args)}`);
          this.dirs.add(cstr(args));
          status(0);
          break;
        case AfcOp.RemovePath: {
          const path = cstr(args);
          this.afcOps.push(`RemovePath ${path}`);
          status(this.files.delete(path) ? 0 : 8);
          break;
        }
        case AfcOp.FileOpen: {
          const path = cstr(args.subarray(8));
          this.afcOps.push(`FileOpen ${path} mode ${args.readBigUInt64LE(0)}`);
          const handle = nextHandle++;
          open.set(handle, { path, chunks: [] });
          sock.write(Buffer.concat(afcPacket(AfcOp.FileOpenResult, h.packetNum, u64(handle))));
          break;
        }
        case AfcOp.FileWrite: {
          writes++;
          if (this.opts.heartbeatDropOnWrite === writes && !this.heartbeatDropped) {
            this.heartbeatDropped = true;
            this.heartbeatActive = false;
            this.heartbeat?.sock.destroy();
          }
          if (this.opts.afcDropOnWrite === writes) {
            this.dropAll();
            return;
          }
          this.maxAfcWrite = Math.max(this.maxAfcWrite, data.length);
          open.get(args.readBigUInt64LE(0))!.chunks.push(Buffer.from(data));
          status(this.opts.afcWriteStatus ?? 0);
          break;
        }
        case AfcOp.FileClose: {
          const f = open.get(args.readBigUInt64LE(0))!;
          this.afcOps.push(`FileClose ${f.path}`);
          this.files.set(f.path, Buffer.concat(f.chunks));
          status(0);
          break;
        }
        default:
          status(15);
      }
    }
  }

  private async serveInstallProxy(sock: Duplex): Promise<void> {
    const ch = new PlistChannel(sock, "fake installd");
    for (;;) {
      const req = await ch.recv();
      if (req.Command === "Install") {
        const path = String(req.PackagePath);
        this.installs.push(path);
        if (this.opts.installError) {
          await ch.send({ Status: "VerifyingApplication", PercentComplete: 40 });
          await ch.send(this.opts.installError);
          continue;
        }
        if (!this.files.has(path)) {
          await ch.send({ Error: "PackageInspectionFailed", ErrorDescription: `no package at ${path}` });
          continue;
        }
        for (const [status, pct] of [["CreatingStagingDirectory", 5], ["ExtractingPackage", 15], ["VerifyingApplication", 40], ["GeneratingApplicationMap", 90]] as const) {
          await ch.send({ Status: status, PercentComplete: pct });
          if (this.opts.installDrop) {
            this.dropAll();
            return;
          }
          if (this.opts.installStall) return;
          if (this.opts.installSleepy) {
            await this.heartbeat?.ch.send({ Command: "SleepyTime" }).catch(() => {});
            return;
          }
        }
        const id = this.opts.bundleId ?? "com.example.app";
        this.apps[id] = { CFBundleIdentifier: id, CFBundleShortVersionString: "1.0.0", CFBundleVersion: "1" };
        await ch.send({ Status: "Complete" });
      } else if (req.Command === "Lookup") {
        if (this.opts.lookupDrop) {
          this.dropAll();
          return;
        }
        const ids = ((req.ClientOptions as PlistDict | undefined)?.BundleIDs as string[] | undefined) ?? Object.keys(this.apps);
        const result: PlistDict = {};
        for (const id of ids) if (this.apps[id]) result[id] = this.apps[id]!;
        await ch.send({ LookupResult: result, Status: "Complete" });
      } else {
        await ch.send({ Error: "UnknownCommand" });
      }
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
