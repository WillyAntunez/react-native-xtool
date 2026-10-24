import { open } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { ByteReader, writeAll } from "./stream.js";

export const AFC_SERVICE = "com.apple.afc";
export const AFC_MAGIC = Buffer.from("CFA6LPAA", "latin1");
/** magic + entire_length + this_length + packet_num + operation, each u64 little-endian. */
export const AFC_HEADER_SIZE = 40;
export const AFC_MAX_CHUNK = 4 * 1024 * 1024;
export const AFC_MAX_REPLY = 1024 * 1024;

export const AfcOp = {
  Status: 0x01,
  Data: 0x02,
  RemovePath: 0x08,
  MakeDir: 0x09,
  FileOpen: 0x0d,
  FileOpenResult: 0x0e,
  FileWrite: 0x10,
  FileClose: 0x14,
} as const;

/** AFC open mode "w": O_WRONLY | O_CREAT | O_TRUNC. */
export const AFC_MODE_WRITE = 3;

const STATUS_NAMES: Record<number, string> = {
  1: "UnknownError",
  2: "OpHeaderInvalid",
  3: "NoResources",
  4: "ReadError",
  5: "WriteError",
  6: "UnknownPacketType",
  7: "InvalidArg",
  8: "ObjectNotFound",
  9: "ObjectIsDir",
  10: "PermDenied",
  11: "ServiceNotConnected",
  12: "OpTimeout",
  13: "TooMuchData",
  14: "EndOfData",
  15: "OpNotSupported",
  16: "ObjectExists",
  17: "ObjectBusy",
  18: "NoSpaceLeft",
  19: "OpWouldBlock",
  20: "IoError",
  21: "OpInterrupted",
  22: "OpInProgress",
  23: "InternalError",
};

export const AFC_OBJECT_NOT_FOUND = 8;

export class AfcStatusError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    path?: string,
  ) {
    super(
      status === 18
        ? "The iPhone is out of storage (AFC NoSpaceLeft): free some space and retry."
        : `AFC ${op}${path ? ` ${path}` : ""} failed: ${STATUS_NAMES[status] ?? `status ${status}`}`,
    );
    this.name = "AfcStatusError";
  }
}

export interface AfcHeader {
  entireLength: number;
  thisLength: number;
  packetNum: number;
  op: number;
}

export function encodeAfcHeader(h: AfcHeader): Buffer {
  const b = Buffer.alloc(AFC_HEADER_SIZE);
  AFC_MAGIC.copy(b, 0);
  b.writeBigUInt64LE(BigInt(h.entireLength), 8);
  b.writeBigUInt64LE(BigInt(h.thisLength), 16);
  b.writeBigUInt64LE(BigInt(h.packetNum), 24);
  b.writeBigUInt64LE(BigInt(h.op), 32);
  return b;
}

export function decodeAfcHeader(b: Buffer): AfcHeader {
  if (b.length < AFC_HEADER_SIZE || !b.subarray(0, 8).equals(AFC_MAGIC)) {
    throw new Error("AFC: bad packet header from the iPhone");
  }
  return {
    entireLength: Number(b.readBigUInt64LE(8)),
    thisLength: Number(b.readBigUInt64LE(16)),
    packetNum: Number(b.readBigUInt64LE(24)),
    op: Number(b.readBigUInt64LE(32)),
  };
}

/**
 * One AFC packet as buffers to write. `thisLength` covers the header and its fixed arguments
 * (`args`); bulk `data` (FileWrite) follows and only counts in `entireLength`.
 */
export function afcPacket(op: number, packetNum: number, args: Buffer, data?: Buffer): Buffer[] {
  const thisLength = AFC_HEADER_SIZE + args.length;
  const entireLength = thisLength + (data?.length ?? 0);
  const head = Buffer.concat([encodeAfcHeader({ entireLength, thisLength, packetNum, op }), args]);
  return data && data.length ? [head, data] : [head];
}

export const cstring = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
export const u64 = (n: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export type UploadProgress = (sentBytes: number, totalBytes: number) => void;

/** The subset of AFC (`com.apple.afc`, rooted at /var/mobile/Media) needed to stage an .ipa. */
export class AfcClient {
  private packetNum = 0;
  private readonly reader: ByteReader;

  constructor(
    private readonly stream: Duplex,
    private readonly timeoutMs = 60_000,
  ) {
    this.reader = new ByteReader(stream, "AFC");
  }

  private async op(op: number, name: string, args: Buffer, data?: Buffer, path?: string): Promise<{ op: number; body: Buffer }> {
    const num = this.packetNum++;
    await writeAll(this.stream, afcPacket(op, num, args, data));
    const head = decodeAfcHeader(await this.reader.read(AFC_HEADER_SIZE, this.timeoutMs));
    // Replies to these operations are tiny; a huge length means a desynced or hostile peer.
    if (head.entireLength < AFC_HEADER_SIZE || head.entireLength - AFC_HEADER_SIZE > AFC_MAX_REPLY) {
      throw new Error(`AFC: bad reply length ${head.entireLength}`);
    }
    const body = await this.reader.read(head.entireLength - AFC_HEADER_SIZE, this.timeoutMs);
    if (head.packetNum !== num) throw new Error(`AFC: reply ${head.packetNum} to request ${num}`);
    if (head.op === AfcOp.Status) {
      const status = body.length >= 8 ? Number(body.readBigUInt64LE(0)) : 1;
      if (status !== 0) throw new AfcStatusError(name, status, path);
    }
    return { op: head.op, body };
  }

  /** mkdir -p. */
  async makeDir(path: string): Promise<void> {
    await this.op(AfcOp.MakeDir, "MakeDir", cstring(path), undefined, path);
  }

  async removePath(path: string): Promise<void> {
    await this.op(AfcOp.RemovePath, "RemovePath", cstring(path), undefined, path);
  }

  async fileOpen(path: string, mode = AFC_MODE_WRITE): Promise<bigint> {
    const r = await this.op(AfcOp.FileOpen, "FileOpen", Buffer.concat([u64(mode), cstring(path)]), undefined, path);
    if (r.op !== AfcOp.FileOpenResult || r.body.length < 8) throw new Error(`AFC: FileOpen ${path} returned no handle`);
    return r.body.readBigUInt64LE(0);
  }

  async fileWrite(handle: bigint, data: Buffer): Promise<void> {
    await this.op(AfcOp.FileWrite, "FileWrite", u64(handle), data);
  }

  async fileClose(handle: bigint): Promise<void> {
    await this.op(AfcOp.FileClose, "FileClose", u64(handle));
  }

  /** Streams `localPath` to `remotePath` in chunks (never holds the whole file in memory). */
  async upload(
    localPath: string,
    remotePath: string,
    opts: { chunkSize?: number; onProgress?: UploadProgress } = {},
  ): Promise<number> {
    const chunkSize = Math.min(opts.chunkSize ?? AFC_MAX_CHUNK, AFC_MAX_CHUNK);
    const file = await open(localPath, "r");
    try {
      const total = (await file.stat()).size;
      const handle = await this.fileOpen(remotePath);
      const buf = Buffer.allocUnsafe(chunkSize);
      let sent = 0;
      opts.onProgress?.(0, total);
      while (sent < total) {
        const { bytesRead } = await file.read(buf, 0, chunkSize, sent);
        if (bytesRead === 0) throw new Error(`${localPath} shrank while uploading`);
        await this.fileWrite(handle, buf.subarray(0, bytesRead));
        sent += bytesRead;
        opts.onProgress?.(sent, total);
      }
      await this.fileClose(handle);
      return total;
    } finally {
      await file.close();
    }
  }

  close(): void {
    this.stream.destroy();
  }
}
