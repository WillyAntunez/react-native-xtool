/**
 * Hand-made archives for the extraction tests: a ustar writer (gzipped) and a stored-zip writer, both able to write
 * entries a safe archive never holds (an absolute path, a `..` segment, a device file, a link that leaves the tree).
 */
import { crc32, gzipSync } from "node:zlib";

export type ArchiveSpec =
  | { type: "file"; path: string; body?: string | Buffer; mode?: number }
  | { type: "dir"; path: string }
  | { type: "symlink"; path: string; target: string }
  | { type: "hardlink"; path: string; target: string }
  | { type: "chardev"; path: string }
  | { type: "fifo"; path: string };

function field(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(buf, offset);
}

const octal = (n: number, length: number): string => `${n.toString(8).padStart(length - 1, "0")}\0`;

function tarHeader(e: ArchiveSpec, size: number): Buffer {
  const h = Buffer.alloc(512);
  let name = e.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/");
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  field(h, 0, 100, name);
  const mode = e.type === "dir" ? 0o755 : e.type === "symlink" ? 0o777 : e.type === "file" ? (e.mode ?? 0o644) : 0o644;
  field(h, 100, 8, octal(mode, 8));
  field(h, 108, 8, octal(1000, 8));
  field(h, 116, 8, octal(1000, 8));
  field(h, 124, 12, octal(size, 12));
  field(h, 136, 12, octal(1_700_000_000, 12));
  h.fill(" ", 148, 156);
  const flag = { file: "0", hardlink: "1", symlink: "2", chardev: "3", dir: "5", fifo: "6" }[e.type];
  field(h, 156, 1, flag);
  if (e.type === "symlink" || e.type === "hardlink") field(h, 157, 100, e.target);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  field(h, 265, 32, "me");
  field(h, 297, 32, "me");
  if (e.type === "chardev") {
    field(h, 329, 8, octal(1, 8));
    field(h, 337, 8, octal(3, 8));
  }
  field(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** A gzipped ustar archive of `entries`, in order. */
export function tarGz(entries: readonly ArchiveSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.type === "file" ? Buffer.from(e.body ?? "") : Buffer.alloc(0);
    parts.push(tarHeader(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;

/** A zip of `entries`, stored (no compression), made on Unix (the mode in the external attributes). Zip has no hard links. */
export function zip(entries: readonly ArchiveSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (e.type === "hardlink") throw new Error("a zip cannot hold a hard link");
    const name = Buffer.from(e.type === "dir" && !e.path.endsWith("/") ? `${e.path}/` : e.path, "utf8");
    const data =
      e.type === "file" ? Buffer.from(e.body ?? "") : e.type === "symlink" ? Buffer.from(e.target, "utf8") : Buffer.alloc(0);
    const mode = {
      file: S_IFREG | (e.type === "file" ? (e.mode ?? 0o644) : 0),
      dir: S_IFDIR | 0o755,
      symlink: S_IFLNK | 0o777,
      chardev: S_IFCHR | 0o644,
      fifo: S_IFIFO | 0o644,
    }[e.type];
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5b65, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5b65, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
