import type { Duplex } from "node:stream";
import * as plist from "plist";
import { ByteReader, writeAll } from "./stream.js";

export type PlistValue = plist.PlistValue;
export type PlistDict = { [key: string]: PlistValue };

/** Lockdown and its plist services never send anything near this; a bigger length means desync. */
const MAX_FRAME = 16 * 1024 * 1024;

/** 4-byte big-endian length + XML plist: the framing of lockdownd and every plist service. */
export function encodePlistFrame(obj: PlistDict): Buffer {
  const body = Buffer.from(plist.build(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/**
 * Replies may be XML or binary (`bplist00`). Note: `plist.parse(Uint8Array)` always assumes
 * binary, so XML must be passed as a string.
 */
export function decodePlist(body: Buffer): PlistDict {
  const value =
    body.subarray(0, 6).toString("latin1") === "bplist"
      ? plist.parseBinary(new Uint8Array(body))
      : plist.parse(body.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date || value instanceof Uint8Array) {
    throw new Error("Unexpected plist from the iPhone: expected a dictionary");
  }
  return value as PlistDict;
}

/** Request/response plist messaging over one socket. */
export class PlistChannel {
  private reader: ByteReader;

  constructor(
    readonly stream: Duplex,
    readonly what: string,
  ) {
    this.reader = new ByteReader(stream, what);
  }

  send(obj: PlistDict): Promise<void> {
    return writeAll(this.stream, encodePlistFrame(obj));
  }

  async recv(timeoutMs?: number): Promise<PlistDict> {
    const len = (await this.reader.read(4, timeoutMs)).readUInt32BE(0);
    if (len > MAX_FRAME) throw new Error(`${this.what}: frame too large (${len} bytes)`);
    return decodePlist(await this.reader.read(len, timeoutMs));
  }

  async request(obj: PlistDict, timeoutMs?: number): Promise<PlistDict> {
    await this.send(obj);
    return this.recv(timeoutMs);
  }

  /** Stops reading so the socket can be wrapped (TLS); returns the raw stream. */
  detach(): Duplex {
    const rest = this.reader.detach();
    if (rest.length) throw new Error(`${this.what}: unexpected ${rest.length} bytes before TLS upgrade`);
    return this.stream;
  }

  close(): void {
    this.stream.destroy();
  }
}
