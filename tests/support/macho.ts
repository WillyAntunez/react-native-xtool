import { closeSync, openSync, readSync } from "node:fs";

/**
 * Hand-made Mach-O files for the wrap tests: a 64-bit header with a chosen file type, CPU and platform load command,
 * fat and fat64 wrappers, and BSD `ar` archives with `#1/<n>` long names and a `__.SYMDEF` member. No vendor byte.
 */

export const CPU = {
  arm64: [0x0100000c, 0],
  arm64e: [0x0100000c, 0x80000002],
  x86_64: [0x01000007, 3],
} as const satisfies Record<string, readonly [number, number]>;
export type Cpu = keyof typeof CPU;

export const FILETYPE = { object: 1, execute: 2, dylib: 6, bundle: 8 } as const;

const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_BUILD_VERSION = 0x32;
const LC_SEGMENT_64 = 0x19;

/** `17.0` or `16.4.1` → xxxx.yy.zz. */
const encodeVersion = (v: string): number => {
  const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
  return (a << 16) | (b << 8) | c;
};

export interface MachOOptions {
  filetype?: keyof typeof FILETYPE;
  cpu?: Cpu;
  /** LC_BUILD_VERSION: platform 2 is iOS, 7 the iOS simulator. */
  build?: { platform: number; minos: string };
  /** LC_VERSION_MIN_IPHONEOS. */
  versionMin?: string;
  /** Bytes after the load commands, so slices differ. */
  payload?: string;
}

/** A 64-bit little-endian Mach-O: header, an empty LC_SEGMENT_64, the platform command, then `payload`. */
export function machO(o: MachOOptions = {}): Buffer {
  const cmds: Buffer[] = [];
  const segment = Buffer.alloc(72);
  segment.writeUInt32LE(LC_SEGMENT_64, 0);
  segment.writeUInt32LE(72, 4);
  cmds.push(segment);
  if (o.build !== undefined) {
    const c = Buffer.alloc(24);
    c.writeUInt32LE(LC_BUILD_VERSION, 0);
    c.writeUInt32LE(24, 4);
    c.writeUInt32LE(o.build.platform, 8);
    c.writeUInt32LE(encodeVersion(o.build.minos), 12);
    c.writeUInt32LE(encodeVersion("18.0"), 16);
    cmds.push(c);
  }
  if (o.versionMin !== undefined) {
    const c = Buffer.alloc(16);
    c.writeUInt32LE(LC_VERSION_MIN_IPHONEOS, 0);
    c.writeUInt32LE(16, 4);
    c.writeUInt32LE(encodeVersion(o.versionMin), 8);
    c.writeUInt32LE(encodeVersion("18.0"), 12);
    cmds.push(c);
  }
  const body = Buffer.concat(cmds);
  const h = Buffer.alloc(32);
  const [type, subtype] = CPU[o.cpu ?? "arm64"];
  h.writeUInt32LE(0xfeedfacf, 0);
  h.writeUInt32LE(type, 4);
  h.writeUInt32LE(subtype >>> 0, 8);
  h.writeUInt32LE(FILETYPE[o.filetype ?? "object"], 12);
  h.writeUInt32LE(cmds.length, 16);
  h.writeUInt32LE(body.length, 20);
  return Buffer.concat([h, body, Buffer.from(o.payload ?? "")]);
}

/** A fat (CAFEBABE) or fat64 (CAFEBABF) file around `slices`, each aligned to `align` bytes (8 by default). */
export function fat(slices: { cpu: Cpu; data: Buffer }[], opts: { fat64?: boolean; align?: number } = {}): Buffer {
  const align = opts.align ?? 8;
  const entry = opts.fat64 ? 32 : 20;
  const header = Buffer.alloc(8 + entry * slices.length);
  header.writeUInt32BE(opts.fat64 ? 0xcafebabf : 0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts: Buffer[] = [header];
  let offset = header.length;
  slices.forEach((s, i) => {
    const pad = (align - (offset % align)) % align;
    if (pad > 0) parts.push(Buffer.alloc(pad));
    offset += pad;
    const [type, subtype] = CPU[s.cpu];
    const at = 8 + entry * i;
    header.writeUInt32BE(type, at);
    header.writeUInt32BE(subtype >>> 0, at + 4);
    if (opts.fat64) {
      header.writeBigUInt64BE(BigInt(offset), at + 8);
      header.writeBigUInt64BE(BigInt(s.data.length), at + 16);
      header.writeUInt32BE(Math.log2(align), at + 24);
    } else {
      header.writeUInt32BE(offset, at + 8);
      header.writeUInt32BE(s.data.length, at + 12);
      header.writeUInt32BE(Math.log2(align), at + 16);
    }
    parts.push(s.data);
    offset += s.data.length;
  });
  return Buffer.concat(parts);
}

function arHeader(name: string, size: number): Buffer {
  const field = (v: string, n: number): string => v.padEnd(n, " ").slice(0, n);
  return Buffer.from(
    field(name, 16) + field("0", 12) + field("0", 6) + field("0", 6) + field("100644", 8) + field(String(size), 10) + "`\n",
    "latin1",
  );
}

/**
 * A BSD `ar` archive (`!<arch>\n`): names longer than 15 bytes or with a space are written as `#1/<n>`, and
 * `symdef` adds a `__.SYMDEF` member first. Members are padded to an even size.
 */
export function arArchive(members: { name: string; data: Buffer }[], opts: { symdef?: boolean } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from("!<arch>\n", "latin1")];
  const all = opts.symdef ? [{ name: "__.SYMDEF", data: Buffer.alloc(8) }, ...members] : members;
  for (const m of all) {
    let data = m.data;
    let name = m.name;
    if (name.length > 15 || name.includes(" ")) {
      const raw = Buffer.from(name, "latin1");
      const padded = Buffer.alloc(raw.length + ((8 - (raw.length % 8)) % 8));
      raw.copy(padded);
      name = `#1/${padded.length}`;
      data = Buffer.concat([padded, data]);
    }
    parts.push(arHeader(name, data.length), data);
    if (data.length % 2 === 1) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);

/**
 * The kind of binary a file starts as: an `ar` archive (`!<arch>\n` or `!<thin>\n`), a Mach-O (32 or 64 bit, either
 * byte order) or a fat file; undefined for anything else (row 65's check on the npm package).
 */
export function binaryMagic(file: string): "ar" | "Mach-O" | "fat" | undefined {
  const head = Buffer.alloc(8);
  const fd = openSync(file, "r");
  let n: number;
  try {
    n = readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  const text = head.subarray(0, n).toString("latin1");
  if (text === "!<arch>\n" || text === "!<thin>\n") return "ar";
  if (n < 4) return undefined;
  const magic = head.readUInt32BE(0);
  if (MACHO_MAGICS.has(magic)) return "Mach-O";
  if (FAT_MAGICS.has(magic)) return "fat";
  return undefined;
}
