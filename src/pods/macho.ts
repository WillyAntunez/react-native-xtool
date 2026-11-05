/**
 * A small Mach-O reader (spec goal 2.1), in place of `llvm-lipo`, which the Swift toolchain does not ship: fat and
 * fat64 headers, thin 64-bit Mach-O headers and their platform load commands, and `ar` archives (BSD `#1/<n>` and GNU
 * names). It cuts the arm64 device slice out of a fat file; arm64e is not arm64.
 */

export interface MachOInfo {
  kind: "object" | "dylib" | "execute" | "bundle" | "other";
  cpu: string;
  /** LC_BUILD_VERSION's platform; LC_VERSION_MIN_<os> counts as that OS's device platform. */
  platform?: number;
  minos?: string;
}

export type BinaryShape =
  | { shape: "fat"; arches: string[] }
  | { shape: "macho"; info: MachOInfo }
  | { shape: "ar"; members: { name: string; info?: MachOInfo }[] }
  | { shape: "unknown"; magic: string };

export const PLATFORM_IOS = 2;

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const AR_MAGIC = "!<arch>\n";
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_MASK = 0xff000000;
/** More architectures than any real fat file holds: CAFEBABE is also a Java class file's magic. */
const MAX_FAT_ARCHES = 32;

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_VERSION_MIN_TVOS = 0x2f;
const LC_VERSION_MIN_WATCHOS = 0x30;
const LC_BUILD_VERSION = 0x32;
const VERSION_MIN_PLATFORM: Record<number, number> = {
  [LC_VERSION_MIN_MACOSX]: 1,
  [LC_VERSION_MIN_IPHONEOS]: PLATFORM_IOS,
  [LC_VERSION_MIN_TVOS]: 3,
  [LC_VERSION_MIN_WATCHOS]: 4,
};

const PLATFORM_NAMES: Record<number, string> = {
  1: "macOS",
  2: "iOS",
  3: "tvOS",
  4: "watchOS",
  5: "bridgeOS",
  6: "Mac Catalyst",
  7: "iOS simulator",
  8: "tvOS simulator",
  9: "watchOS simulator",
  10: "DriverKit",
  11: "visionOS",
  12: "visionOS simulator",
};
const platformName = (p: number): string => PLATFORM_NAMES[p] ?? `platform ${p}`;

const KINDS: Record<number, MachOInfo["kind"]> = { 1: "object", 2: "execute", 6: "dylib", 8: "bundle" };

function cpuName(type: number, subtype: number): string {
  const sub = (subtype & ~CPU_SUBTYPE_MASK) >>> 0;
  if (type === CPU_TYPE_ARM64) return sub === 0 ? "arm64" : sub === 2 ? "arm64e" : `arm64 (subtype ${sub})`;
  if (type === 0x0200000c) return "arm64_32";
  if (type === 0x01000007) return sub === 8 ? "x86_64h" : "x86_64";
  if (type === 7) return "i386";
  if (type === 12) return ({ 9: "armv7", 11: "armv7s", 12: "armv7k" } as Record<number, string>)[sub] ?? "arm";
  return `cpu ${type}/${sub}`;
}

/** xxxx.yy.zz → `17.0`, `16.4.1`. */
function versionText(v: number): string {
  const patch = v & 0xff;
  return `${v >>> 16}.${(v >>> 8) & 0xff}${patch === 0 ? "" : `.${patch}`}`;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface FatArch {
  cpu: string;
  isArm64: boolean;
  offset: number;
  size: number;
}

/** The fat header's architectures, or undefined when the file is not a well-formed fat file. */
function fatArches(buf: Buffer): FatArch[] | undefined {
  if (buf.length < 8) return undefined;
  const magic = buf.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return undefined;
  const count = buf.readUInt32BE(4);
  const entry = magic === FAT_MAGIC_64 ? 32 : 20;
  if (count === 0 || count > MAX_FAT_ARCHES || buf.length < 8 + entry * count) return undefined;
  const arches: FatArch[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + entry * i;
    const type = buf.readUInt32BE(at);
    const subtype = buf.readUInt32BE(at + 4);
    const offset = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
    const size = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12);
    if (offset < 8 + entry * count || offset + size > buf.length) return undefined;
    const isArm64 = type === CPU_TYPE_ARM64 && ((subtype & ~CPU_SUBTYPE_MASK) >>> 0) === 0;
    arches.push({ cpu: cpuName(type, subtype), isArm64, offset, size });
  }
  return arches;
}

/** A thin Mach-O header and its platform load commands; undefined for anything else. */
function machOInfo(buf: Buffer): MachOInfo | undefined {
  if (buf.length < 28) return undefined;
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return undefined;
  const info: MachOInfo = {
    kind: KINDS[buf.readUInt32LE(12)] ?? "other",
    cpu: cpuName(buf.readUInt32LE(4), buf.readUInt32LE(8)),
  };
  const ncmds = buf.readUInt32LE(16);
  let at = magic === MH_MAGIC_64 ? 32 : 28;
  for (let i = 0; i < ncmds && at + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    if (size < 8 || at + size > buf.length) break;
    if (cmd === LC_BUILD_VERSION && size >= 16 && info.platform === undefined) {
      info.platform = buf.readUInt32LE(at + 8);
      info.minos = versionText(buf.readUInt32LE(at + 12));
    } else if (VERSION_MIN_PLATFORM[cmd] !== undefined && size >= 16 && info.platform === undefined) {
      info.platform = VERSION_MIN_PLATFORM[cmd];
      info.minos = versionText(buf.readUInt32LE(at + 8));
    }
    at += size;
  }
  return info;
}

interface ArMember {
  name: string;
  data: Buffer;
}

/** The members of an `ar` archive, symbol tables (`__.SYMDEF*`, GNU `/` and `//`) left out; undefined when malformed. */
function arMembers(buf: Buffer): ArMember[] | undefined {
  const members: ArMember[] = [];
  let gnuNames: Buffer | undefined;
  let at = AR_MAGIC.length;
  while (at < buf.length) {
    if (buf.length - at === 1 && buf[at] === 0x0a) break;
    if (at + 60 > buf.length || buf.toString("latin1", at + 58, at + 60) !== "`\n") return undefined;
    const rawName = buf.toString("latin1", at, at + 16).trimEnd();
    const sizeText = buf.toString("latin1", at + 48, at + 58).trim();
    if (!/^\d+$/.test(sizeText)) return undefined;
    const size = Number(sizeText);
    let start = at + 60;
    const end = start + size;
    if (end > buf.length) return undefined;
    let name = rawName;
    const bsd = /^#1\/(\d+)$/.exec(rawName);
    if (bsd !== null) {
      const n = Number(bsd[1]);
      if (n > size) return undefined;
      name = buf.toString("utf8", start, start + n).replace(/\0+$/, "");
      start += n;
    } else if (rawName === "//") {
      gnuNames = buf.subarray(start, end);
      name = "";
    } else if (/^\/\d+$/.test(rawName) && gnuNames !== undefined) {
      const from = Number(rawName.slice(1));
      const stop = gnuNames.indexOf("/\n", from);
      name = gnuNames.toString("utf8", from, stop === -1 ? gnuNames.length : stop);
    } else if (rawName !== "/" && rawName.endsWith("/")) {
      name = rawName.slice(0, -1);
    }
    if (name !== "" && name !== "/" && !name.startsWith("__.SYMDEF")) members.push({ name, data: buf.subarray(start, end) });
    at = end + (end % 2);
  }
  return members;
}

const isAr = (buf: Buffer): boolean => buf.length >= AR_MAGIC.length && buf.toString("latin1", 0, AR_MAGIC.length) === AR_MAGIC;

/** `!<thin>` for printable leading bytes, else the first four bytes in hex. */
function magicText(buf: Buffer): string {
  if (buf.length === 0) return "an empty file";
  const head = buf.subarray(0, 8).toString("latin1").replace(/[\n\0]+$/, "");
  if (head.length > 0 && /^[\x20-\x7e]+$/.test(head)) return head;
  return `0x${buf.subarray(0, 4).toString("hex")}`;
}

export function readBinary(buf: Buffer): BinaryShape {
  const arches = fatArches(buf);
  if (arches !== undefined) return { shape: "fat", arches: arches.map((a) => a.cpu) };
  const info = machOInfo(buf);
  if (info !== undefined) return { shape: "macho", info };
  if (isAr(buf)) {
    const members = arMembers(buf);
    if (members !== undefined) {
      return {
        shape: "ar",
        members: members.map((m) => {
          const i = machOInfo(m.data);
          return i === undefined ? { name: m.name } : { name: m.name, info: i };
        }),
      };
    }
  }
  return { shape: "unknown", magic: magicText(buf) };
}

/**
 * The arm64 device slice: from a fat file, the slice with CPU_TYPE_ARM64 and subtype ALL (capability bits masked;
 * arm64e is not arm64); a thin arm64 Mach-O, or an archive whose Mach-O members are all arm64, as it is.
 */
export function arm64Slice(buf: Buffer): Buffer | { missing: true; arches: string[] } {
  const arches = fatArches(buf);
  if (arches !== undefined) {
    const arm = arches.find((a) => a.isArm64);
    return arm === undefined ? { missing: true, arches: arches.map((a) => a.cpu) } : buf.subarray(arm.offset, arm.offset + arm.size);
  }
  const shape = readBinary(buf);
  if (shape.shape === "macho") return shape.info.cpu === "arm64" ? buf : { missing: true, arches: [shape.info.cpu] };
  if (shape.shape === "ar") {
    const cpus = [...new Set(shape.members.flatMap((m) => (m.info === undefined ? [] : [m.info.cpu])))];
    return cpus.every((c) => c === "arm64") ? buf : { missing: true, arches: cpus };
  }
  return { missing: true, arches: [] };
}

/** The Mach-O infos of a thin slice: the file itself, or each archive member, with the member's name. */
function sliceInfos(slice: Buffer): { member?: string; info: MachOInfo }[] {
  const shape = readBinary(slice);
  if (shape.shape === "macho") return [{ info: shape.info }];
  if (shape.shape === "ar") return shape.members.flatMap((m) => (m.info === undefined ? [] : [{ member: m.name, info: m.info }]));
  return [];
}

/**
 * The first object, or archive member, built for another platform than iOS ("iOS simulator", "macOS", "Mac
 * Catalyst", …). One without a platform load command is accepted (MLKitTextRecognitionCommon's objects have none).
 */
export function platformProblem(slice: Buffer): { member?: string; platform: string } | undefined {
  for (const { member, info } of sliceInfos(slice)) {
    if (info.platform === undefined || info.platform === PLATFORM_IOS) continue;
    return member === undefined ? { platform: platformName(info.platform) } : { member, platform: platformName(info.platform) };
  }
  return undefined;
}

/** The highest iOS minimum over LC_BUILD_VERSION and LC_VERSION_MIN_IPHONEOS, in the slice or its members. */
export function highestMinIos(slice: Buffer): string | undefined {
  let best: string | undefined;
  for (const { info } of sliceInfos(slice)) {
    if (info.platform !== PLATFORM_IOS || info.minos === undefined) continue;
    if (best === undefined || compareVersions(info.minos, best) > 0) best = info.minos;
  }
  return best;
}
