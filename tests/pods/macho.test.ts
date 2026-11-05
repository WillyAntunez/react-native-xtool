import { describe, expect, it } from "vitest";
import { PLATFORM_IOS, arm64Slice, highestMinIos, platformProblem, readBinary } from "../../src/pods/macho.js";
import { arArchive, fat, machO } from "../support/macho.js";

const IOS = { platform: PLATFORM_IOS, minos: "15.5" };
const SIMULATOR = { platform: 7, minos: "15.5" };
const arm = machO({ build: IOS, payload: "arm64 slice" });
const x86 = machO({ cpu: "x86_64", payload: "x86_64 slice" });
const arm64e = machO({ cpu: "arm64e", payload: "arm64e slice" });

describe("arm64Slice", () => {
  it.each([false, true])("cuts the arm64 slice out of a fat file (fat64: %s)", (fat64) => {
    const file = fat(
      [
        { cpu: "x86_64", data: x86 },
        { cpu: "arm64e", data: arm64e },
        { cpu: "arm64", data: arm },
      ],
      { fat64 },
    );
    expect(readBinary(file)).toEqual({ shape: "fat", arches: ["x86_64", "arm64e", "arm64"] });
    expect(arm64Slice(file)).toEqual(arm);
  });

  it("cuts an ar slice out of a fat static library", () => {
    const lib = arArchive([{ name: "a.o", data: arm }], { symdef: true });
    const file = fat([
      { cpu: "x86_64", data: arArchive([{ name: "a.o", data: x86 }]) },
      { cpu: "arm64", data: lib },
    ]);
    expect(arm64Slice(file)).toEqual(lib);
  });

  it("keeps a thin arm64 file", () => {
    expect(arm64Slice(arm)).toBe(arm);
    const lib = arArchive([{ name: "a.o", data: arm }]);
    expect(arm64Slice(lib)).toBe(lib);
  });

  it("has no arm64 slice in an x86_64-only or arm64e-only file", () => {
    expect(arm64Slice(fat([{ cpu: "x86_64", data: x86 }]))).toEqual({ missing: true, arches: ["x86_64"] });
    expect(arm64Slice(fat([{ cpu: "arm64e", data: arm64e }]))).toEqual({ missing: true, arches: ["arm64e"] });
    expect(arm64Slice(x86)).toEqual({ missing: true, arches: ["x86_64"] });
    expect(arm64Slice(arm64e)).toEqual({ missing: true, arches: ["arm64e"] });
    expect(arm64Slice(arArchive([{ name: "a.o", data: x86 }]))).toEqual({ missing: true, arches: ["x86_64"] });
  });

  it("has no arm64 slice in an archive without a Mach-O member (row 26)", () => {
    // LLVM bitcode from an LTO build, and an empty archive: nothing lld could link as arm64.
    const bitcode = arArchive([{ name: "bitcode.o", data: Buffer.from("BC\xc0\xde\x35\x14\x00\x00", "latin1") }], { symdef: true });
    expect(arm64Slice(bitcode)).toEqual({ missing: true, arches: [] });
    expect(arm64Slice(fat([{ cpu: "arm64", data: bitcode }]))).toEqual({ missing: true, arches: [] });
    expect(arm64Slice(Buffer.from("!<arch>\n", "latin1"))).toEqual({ missing: true, arches: [] });
  });

  it("calls a fat file whose slice lies outside it unknown", () => {
    const file = fat([{ cpu: "arm64", data: arm }]).subarray(0, 40);
    expect(readBinary(file)).toEqual({ shape: "unknown", magic: "0xcafebabe" });
    expect(arm64Slice(file)).toEqual({ missing: true, arches: [] });
  });
});

describe("reader edge cases", () => {
  it("cuts a slice aligned to 2^14, as Google's fat binaries are", () => {
    const file = fat(
      [
        { cpu: "x86_64", data: x86 },
        { cpu: "arm64", data: arm },
      ],
      { align: 1 << 14 },
    );
    expect([file.readUInt32BE(8 + 8), file.readUInt32BE(8 + 20 + 8)]).toEqual([1 << 14, 2 << 14]);
    expect(arm64Slice(file)).toEqual(arm);
    const fat64 = fat([{ cpu: "arm64", data: arm }], { fat64: true, align: 1 << 14 });
    expect(arm64Slice(fat64)).toEqual(arm);
  });

  it("calls a fat header with more than 32 architectures unknown (a Java class file has that magic)", () => {
    const slices = Array.from({ length: 33 }, () => ({ cpu: "x86_64" as const, data: x86 }));
    expect(readBinary(fat(slices))).toEqual({ shape: "unknown", magic: "0xcafebabe" });
    expect(readBinary(fat(slices.slice(0, 32))).shape).toBe("fat");
  });

  it("reads a 32-bit header with LC_VERSION_MIN_IPHONEOS", () => {
    const h = Buffer.alloc(28 + 16);
    h.writeUInt32LE(0xfeedface, 0);
    h.writeUInt32LE(12, 4);
    h.writeUInt32LE(9, 8);
    h.writeUInt32LE(1, 12);
    h.writeUInt32LE(1, 16);
    h.writeUInt32LE(16, 20);
    h.writeUInt32LE(0x25, 28);
    h.writeUInt32LE(16, 32);
    h.writeUInt32LE(9 << 16, 36);
    expect(readBinary(h)).toEqual({ shape: "macho", info: { kind: "object", cpu: "armv7", platform: PLATFORM_IOS, minos: "9.0" } });
    expect(arm64Slice(h)).toEqual({ missing: true, arches: ["armv7"] });
  });

  it("reads GNU ar long names", () => {
    const longName = "an_object_with_a_long_gnu_name.o";
    const table = Buffer.from(`${longName}/\n`, "latin1");
    const header = (name: string, size: number) =>
      Buffer.from(`${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(size).padEnd(10)}\`\n`, "latin1");
    const pad = (b: Buffer) => (b.length % 2 === 1 ? Buffer.concat([b, Buffer.from("\n")]) : b);
    const sim = machO({ build: SIMULATOR, payload: "sim" });
    const archive = Buffer.concat([
      Buffer.from("!<arch>\n", "latin1"),
      header("/", 4),
      Buffer.alloc(4),
      header("//", table.length),
      pad(table),
      header("/0", arm.length),
      pad(arm),
      header("short.o/", sim.length),
      pad(sim),
    ]);
    expect(readBinary(archive)).toEqual({
      shape: "ar",
      members: [
        { name: longName, info: { kind: "object", cpu: "arm64", platform: PLATFORM_IOS, minos: "15.5" } },
        { name: "short.o", info: { kind: "object", cpu: "arm64", platform: 7, minos: "15.5" } },
      ],
    });
    expect(platformProblem(archive)).toEqual({ member: "short.o", platform: "iOS simulator" });
  });

  it("has no arm64 slice in a thin archive of arm64e objects", () => {
    expect(arm64Slice(arArchive([{ name: "e.o", data: arm64e }]))).toEqual({ missing: true, arches: ["arm64e"] });
    expect(arm64Slice(arArchive([{ name: "a.o", data: arm }, { name: "e.o", data: arm64e }]))).toEqual({
      missing: true,
      arches: ["arm64", "arm64e"],
    });
  });
});

describe("readBinary", () => {
  it("tells an object, a dylib and an archive apart", () => {
    expect(readBinary(arm)).toEqual({ shape: "macho", info: { kind: "object", cpu: "arm64", platform: 2, minos: "15.5" } });
    expect(readBinary(machO({ filetype: "dylib" }))).toEqual({ shape: "macho", info: { kind: "dylib", cpu: "arm64" } });
    expect(readBinary(machO({ filetype: "execute" }))).toMatchObject({ info: { kind: "execute" } });
    expect(readBinary(machO({ filetype: "bundle" }))).toMatchObject({ info: { kind: "bundle" } });
    expect(readBinary(arArchive([{ name: "a.o", data: arm }]))).toEqual({
      shape: "ar",
      members: [{ name: "a.o", info: { kind: "object", cpu: "arm64", platform: 2, minos: "15.5" } }],
    });
  });

  it("reads archive members with BSD long names, and skips the symbol table", () => {
    const odd = machO({ payload: "odd" });
    const lib = arArchive(
      [
        { name: "MLKVisionImage_with_a_long_name.o", data: odd },
        { name: "with space.o", data: arm },
        { name: "notes.txt", data: Buffer.from("not mach-o") },
      ],
      { symdef: true },
    );
    expect(readBinary(lib)).toEqual({
      shape: "ar",
      members: [
        { name: "MLKVisionImage_with_a_long_name.o", info: { kind: "object", cpu: "arm64" } },
        { name: "with space.o", info: { kind: "object", cpu: "arm64", platform: 2, minos: "15.5" } },
        { name: "notes.txt" },
      ],
    });
  });

  it("calls a !<thin> archive unknown", () => {
    expect(readBinary(Buffer.from("!<thin>\n0000000000"))).toEqual({ shape: "unknown", magic: "!<thin>" });
    expect(readBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toEqual({ shape: "unknown", magic: "0x7f454c46" });
    expect(readBinary(Buffer.alloc(0))).toEqual({ shape: "unknown", magic: "an empty file" });
  });
});

describe("platformProblem", () => {
  it("reports a simulator platform in an object and in an archive member", () => {
    expect(platformProblem(machO({ build: SIMULATOR }))).toEqual({ platform: "iOS simulator" });
    const lib = arArchive([
      { name: "good.o", data: arm },
      { name: "sim.o", data: machO({ build: SIMULATOR }) },
    ]);
    expect(platformProblem(lib)).toEqual({ member: "sim.o", platform: "iOS simulator" });
    expect(platformProblem(machO({ build: { platform: 6, minos: "14.0" } }))).toEqual({ platform: "Mac Catalyst" });
    expect(platformProblem(machO({ build: { platform: 1, minos: "11.0" } }))).toEqual({ platform: "macOS" });
  });

  it("accepts an object without a platform load command", () => {
    expect(platformProblem(machO())).toBeUndefined();
    expect(platformProblem(arArchive([{ name: "a.o", data: machO() }, { name: "b.o", data: arm }]))).toBeUndefined();
  });

  it("accepts LC_VERSION_MIN_IPHONEOS as iOS", () => {
    expect(platformProblem(machO({ versionMin: "12.0" }))).toBeUndefined();
  });
});

describe("highestMinIos", () => {
  it("reads the highest minos over LC_BUILD_VERSION and LC_VERSION_MIN_IPHONEOS", () => {
    const lib = arArchive([
      { name: "a.o", data: machO({ build: { platform: PLATFORM_IOS, minos: "15.5" } }) },
      { name: "b.o", data: machO({ versionMin: "17.0.1" }) },
      { name: "c.o", data: machO({ build: { platform: PLATFORM_IOS, minos: "16.4" } }) },
      { name: "d.o", data: machO() },
    ]);
    expect(highestMinIos(lib)).toBe("17.0.1");
    expect(highestMinIos(machO({ build: { platform: PLATFORM_IOS, minos: "12.0" } }))).toBe("12.0");
    expect(highestMinIos(machO())).toBeUndefined();
  });
});
