/**
 * Placeholders for SwiftPM targets without sources (row 81): Swift Build compiles nothing for a header-only target such
 * as GoogleToolboxForMac 6.0.1's `GTMDefines`, so it never writes `GTMDefines.o`, but it still lists that object at
 * link (`Build input file cannot be found`). The table entry names such targets (`emptyTargets`), and rn-xtool writes
 * an empty arm64 object in their place before xtool-build, the one clang writes for an empty C file.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PodTable } from "../project/podTable.js";

/** Where Swift Build writes and links the targets' objects in `ios-xtool/` (`xtool dev build --configuration debug`). */
export const EMPTY_TARGETS_DIR = [".build", "out", "Products", "Debug-iphoneos"] as const;

const TARGET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The 336-byte MH_OBJECT clang writes for an empty C file (`clang -target arm64-apple-ios<minIos> -c`): an empty
 * `__TEXT,__text` section, LC_BUILD_VERSION for iOS, and a symbol table holding only the section's local `ltmp0`.
 */
export function emptyArm64Object(minIos: string): Buffer {
  const [major = 0, minor = 0, patch = 0] = minIos.split(".").map(Number);
  const b = Buffer.alloc(336);
  let o = 0;
  const u32 = (v: number): void => {
    b.writeUInt32LE(v >>> 0, o);
    o += 4;
  };
  const u64 = (v: number): void => {
    b.writeBigUInt64LE(BigInt(v), o);
    o += 8;
  };
  const name = (s: string): void => {
    b.write(s, o, "latin1");
    o += 16;
  };
  // mach_header_64: arm64, MH_OBJECT, 4 commands of 280 bytes, MH_SUBSECTIONS_VIA_SYMBOLS.
  [0xfeedfacf, 0x0100000c, 0, 1, 4, 280, 0x2000, 0].forEach(u32);
  // LC_SEGMENT_64 with one section.
  u32(0x19), u32(152), name(""), u64(0), u64(0), u64(312), u64(0), u32(7), u32(7), u32(1), u32(0);
  name("__text"), name("__TEXT"), u64(0), u64(0), u32(312), u32(0), u32(0), u32(0), u32(0x80000000), u32(0), u32(0), u32(0);
  // LC_BUILD_VERSION: iOS, minos, no SDK, no tools.
  u32(0x32), u32(24), u32(2), u32((major << 16) | (minor << 8) | patch), u32(0), u32(0);
  // LC_SYMTAB: one symbol at 312, 8 bytes of strings at 328.
  u32(0x2), u32(24), u32(312), u32(1), u32(328), u32(8);
  // LC_DYSYMTAB: the one local symbol.
  u32(0xb), u32(80), u32(0), u32(1), u32(1), u32(0), u32(1), u32(0);
  o += 12 * 4;
  // nlist_64 `ltmp0`: N_SECT, section 1, value 0.
  u32(1), b.writeUInt8(0x0e, o++), b.writeUInt8(1, o++), (o += 2), u64(0);
  b.write("\0ltmp0\0\0", o, "latin1");
  return b;
}

/**
 * Writes `<Target>.o` for each target under `ios-xtool/.build/out/Products/Debug-iphoneos`, through a temporary file
 * and a rename. A file there is kept only when it is byte for byte the object this writes (row 84): a write cut short,
 * a full disk or a foreign file is never trusted. Returns the targets it wrote.
 */
export async function writeEmptyTargetObjects(iosXtool: string, targets: readonly string[], minIos: string): Promise<string[]> {
  const written: string[] = [];
  const dir = path.join(iosXtool, ...EMPTY_TARGETS_DIR);
  const object = emptyArm64Object(minIos);
  for (const target of [...new Set(targets)]) {
    if (!TARGET_NAME.test(target)) throw new Error(`internal error: ${target} is not a target name`);
    const file = path.join(dir, `${target}.o`);
    if (existsSync(file) && readFileSync(file).equals(object)) continue;
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, object);
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
    written.push(target);
  }
  return written;
}

/** The `emptyTargets` of the table entries of the pods the app links, sorted. */
export function emptyTargetsOf(table: PodTable, pods: Iterable<string>): string[] {
  return [...new Set([...pods].flatMap((pod) => table.pods[pod]?.emptyTargets ?? []))].sort();
}
