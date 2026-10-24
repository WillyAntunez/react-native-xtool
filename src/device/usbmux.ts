import net from "node:net";
import type { Duplex } from "node:stream";
import * as plist from "plist";
import type { Connect } from "./lockdown.js";
import { decodePlist, type PlistDict } from "./plistio.js";
import { ByteReader, writeAll } from "./stream.js";

export const USBMUXD_SOCKET = "/var/run/usbmuxd";

/** usbmuxd's socket, honouring libimobiledevice's `USBMUXD_SOCKET_ADDRESS` (`UNIX:/path` or `host:port`). */
export function usbmuxAddress(env: NodeJS.ProcessEnv = process.env): net.NetConnectOpts {
  const v = env.USBMUXD_SOCKET_ADDRESS;
  if (!v) return { path: USBMUXD_SOCKET };
  if (v.startsWith("UNIX:")) return { path: v.slice(5) };
  const m = /^(.+):(\d+)$/.exec(v);
  return m ? { host: m[1]!, port: Number(m[2]) } : { path: v };
}

export class UsbmuxUnavailableError extends Error {
  constructor(reason: string) {
    super(`usbmuxd is not running (${reason})`);
    this.name = "UsbmuxUnavailableError";
  }
}

const HEADER = 16;
const VERSION_PLIST = 1;
const MESSAGE_PLIST = 8;

/** usbmuxd plist protocol: u32 LE total length, version 1, message 8 (plist), tag; then XML. */
export function encodeMuxPacket(tag: number, msg: PlistDict): Buffer {
  const body = Buffer.from(
    plist.build({ ClientVersionString: "expo-xtool", ProgName: "expo-xtool", kLibUSBMuxVersion: 3, ...msg }),
  );
  const h = Buffer.alloc(HEADER);
  h.writeUInt32LE(HEADER + body.length, 0);
  h.writeUInt32LE(VERSION_PLIST, 4);
  h.writeUInt32LE(MESSAGE_PLIST, 8);
  h.writeUInt32LE(tag, 12);
  return Buffer.concat([h, body]);
}

export interface MuxDevice {
  deviceId: number;
  udid: string;
  connectionType: string;
}

/** usbmuxd may report new-style UDIDs with or without the dash. */
export const sameUdid = (a: string, b: string): boolean =>
  a.replace(/-/g, "").toUpperCase() === b.replace(/-/g, "").toUpperCase();

export class UsbmuxClient {
  private tag = 0;
  private readonly reader: ByteReader;

  private constructor(
    private readonly sock: net.Socket,
    private readonly timeoutMs: number,
  ) {
    this.reader = new ByteReader(sock, "usbmuxd");
  }

  static open(address: net.NetConnectOpts = usbmuxAddress(), timeoutMs = 3000): Promise<UsbmuxClient> {
    return new Promise((resolve, reject) => {
      const s = net.connect(address);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new UsbmuxUnavailableError("timed out"));
      }, timeoutMs);
      s.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        s.destroy();
        reject(new UsbmuxUnavailableError(e.code ?? e.message));
      });
      s.once("connect", () => {
        clearTimeout(timer);
        s.removeAllListeners("error");
        s.on("error", () => {});
        resolve(new UsbmuxClient(s, timeoutMs));
      });
    });
  }

  async request(msg: PlistDict): Promise<PlistDict> {
    const tag = ++this.tag;
    await writeAll(this.sock, encodeMuxPacket(tag, msg));
    const head = await this.reader.read(HEADER, this.timeoutMs);
    const len = head.readUInt32LE(0);
    if (len < HEADER || len > 16 * 1024 * 1024) throw new Error(`usbmuxd sent a bad packet length ${len}`);
    const body = await this.reader.read(len - HEADER, this.timeoutMs);
    if (head.readUInt32LE(12) !== tag) throw new Error("usbmuxd answered out of order");
    return decodePlist(body);
  }

  async listDevices(): Promise<MuxDevice[]> {
    const resp = await this.request({ MessageType: "ListDevices" });
    const list = Array.isArray(resp.DeviceList) ? resp.DeviceList : [];
    return list.flatMap((item) => {
      const p = (item as PlistDict).Properties as PlistDict | undefined;
      if (!p || typeof p.SerialNumber !== "string") return [];
      return [{ deviceId: Number(p.DeviceID ?? (item as PlistDict).DeviceID), udid: p.SerialNumber, connectionType: String(p.ConnectionType ?? "") }];
    });
  }

  /** The raw pair record bytes usbmuxd stores for `udid`, or undefined when it has none. */
  async readPairRecord(udid: string): Promise<Buffer | undefined> {
    const resp = await this.request({ MessageType: "ReadPairRecord", PairRecordID: udid });
    return resp.PairRecordData instanceof Uint8Array ? Buffer.from(resp.PairRecordData) : undefined;
  }

  /** Turns this connection into a raw tunnel to `port` on the device (consumes the client). */
  async connect(deviceId: number, port: number): Promise<Duplex> {
    // usbmuxd wants the port in network byte order.
    const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff);
    const resp = await this.request({ MessageType: "Connect", DeviceID: deviceId, PortNumber: swapped });
    if (resp.MessageType !== "Result" || resp.Number !== 0) {
      this.close();
      throw new Error(`usbmuxd could not connect to port ${port} on the iPhone (result ${String(resp.Number)})`);
    }
    const rest = this.reader.detach();
    if (rest.length) this.sock.unshift(rest);
    this.sock.setNoDelay(true);
    return this.sock;
  }

  close(): void {
    this.sock.destroy();
  }
}

/** Opens device ports through usbmuxd (USB), one usbmuxd connection per device connection. */
export function usbmuxConnector(deviceId: number, address?: net.NetConnectOpts): Connect {
  return async (port) => (await UsbmuxClient.open(address)).connect(deviceId, port);
}

/** Every device usbmuxd currently sees over USB; empty when usbmuxd is not running. */
export async function listUsbDevices(address?: net.NetConnectOpts): Promise<MuxDevice[]> {
  let mux: UsbmuxClient;
  try {
    mux = await UsbmuxClient.open(address);
  } catch (e) {
    if (e instanceof UsbmuxUnavailableError) return [];
    throw e;
  }
  try {
    return (await mux.listDevices()).filter((d) => d.connectionType === "USB");
  } finally {
    mux.close();
  }
}

/** ReadPairRecord through usbmuxd; undefined when usbmuxd is down or has no record. */
export async function readPairRecordFromUsbmux(udid: string, address?: net.NetConnectOpts): Promise<Buffer | undefined> {
  let mux: UsbmuxClient;
  try {
    mux = await UsbmuxClient.open(address);
  } catch (e) {
    if (e instanceof UsbmuxUnavailableError) return undefined;
    throw e;
  }
  try {
    return await mux.readPairRecord(udid);
  } finally {
    mux.close();
  }
}
