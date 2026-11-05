import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import {
  listArchive,
  parseTarListing,
  parseZipListing,
  safeEntries,
  unsafeEntry,
  type ArchiveEntry,
  type ListRunner,
} from "../../src/pods/archive.js";
import { tarGz, zip, type ArchiveSpec } from "../support/archives.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pods-archive-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TAR_LISTING = [
  'drwxr-xr-x 1000/1000         0 2023-11-14 16:13 "MLKitFoo/"',
  '-rw-r--r-- 1000/1000         5 2023-11-14 16:13 "MLKitFoo/a b.txt"',
  '-rw-r--r-- 1000/1000         1 2023-11-14 16:13 "MLKitFoo/q\\"x -> y.txt"',
  'lrwxrwxrwx 1000/1000         0 2023-11-14 16:13 "MLKitFoo/l -> k" -> "../a -> /etc"',
  'crw-r--r-- 1000/1000       1,3 2023-11-14 16:13 "MLKitFoo/null"',
  'prw-r--r-- 1000/1000         0 2023-11-14 16:13 "MLKitFoo/fifo"',
  '-rw-r--r-- 1000/1000         1 2023-11-14 16:13 "MLKitFoo/nl\\nname\\303\\251"',
  'hrw-r--r-- 1000/1000         0 2023-11-14 16:13 "MLKitFoo/h" link to "MLKitFoo/a b.txt"',
  "",
].join("\n");

const ZIP_LISTING = [
  "Archive:  MLKitFoo.zip",
  "Zip file size: 1092 bytes, number of entries: 5",
  "drwxr-xr-x  3.0 unx        0 bx stor 26-Nov-05 10:57 MLKitFoo/",
  "-rw-rw-r--  3.0 unx        3 tx defN 26-Nov-05 10:57 MLKitFoo/a b.txt",
  "lrwxrwxrwx  3.0 unx       10 bx stor 26-Nov-05 10:57 MLKitFoo/l -> k",
  "crw-r--r--  2.0 unx        0 b- stor 25-Nov-05 00:00 MLKitFoo/null",
  "-rw-a--     2.0 fat        4 tx stor 25-Nov-05 00:00 MLKitFoo/dos.txt",
  "5 files, 22 bytes uncompressed, 22 bytes compressed:  0.0%",
  "",
].join("\n");

describe("archive listings", () => {
  it("parses GNU tar's verbose listing", () => {
    expect(parseTarListing(TAR_LISTING)).toEqual<ArchiveEntry[]>([
      { path: "MLKitFoo/", type: "dir" },
      { path: "MLKitFoo/a b.txt", type: "file" },
      { path: 'MLKitFoo/q"x -> y.txt', type: "file" },
      { path: "MLKitFoo/l -> k", type: "symlink", target: "../a -> /etc" },
      { path: "MLKitFoo/null", type: "special" },
      { path: "MLKitFoo/fifo", type: "special" },
      { path: "MLKitFoo/nl\nnameé", type: "file" },
      { path: "MLKitFoo/h", type: "hardlink", target: "MLKitFoo/a b.txt" },
    ]);
  });

  it("parses unzip's long listing", () => {
    expect(parseZipListing(ZIP_LISTING)).toEqual<ArchiveEntry[]>([
      { path: "MLKitFoo/", type: "dir" },
      { path: "MLKitFoo/a b.txt", type: "file" },
      { path: "MLKitFoo/l -> k", type: "symlink" },
      { path: "MLKitFoo/null", type: "special" },
      { path: "MLKitFoo/dos.txt", type: "file" },
    ]);
  });

  it("stops on a line it cannot read", () => {
    expect(() => parseTarListing("garbage\n")).toThrow(/cannot read/);
  });
});

const SAFE: ArchiveSpec[] = [
  { type: "dir", path: "MLKitFoo/" },
  { type: "dir", path: "MLKitFoo/Frameworks/" },
  { type: "file", path: "MLKitFoo/Frameworks/a b.txt", body: "hello" },
  { type: "symlink", path: "MLKitFoo/Frameworks/Current", target: "../Frameworks/./a b.txt" },
];
const write = (ext: "tar.gz" | "zip", entries: ArchiveSpec[]): string => {
  const file = path.join(dir, `MLKitFoo-1.0.0.${ext}`);
  writeFileSync(file, ext === "zip" ? zip(entries) : tarGz(entries));
  return file;
};

describe("listing an archive with the host's tar and unzip", () => {
  it.each(["tar.gz", "zip"] as const)("lists a %s, with its link targets", async (ext) => {
    const entries = await listArchive(write(ext, SAFE), ext);
    expect(entries).toEqual<ArchiveEntry[]>([
      { path: "MLKitFoo/", type: "dir" },
      { path: "MLKitFoo/Frameworks/", type: "dir" },
      { path: "MLKitFoo/Frameworks/a b.txt", type: "file" },
      { path: "MLKitFoo/Frameworks/Current", type: "symlink", target: "../Frameworks/./a b.txt" },
    ]);
    expect(unsafeEntry(entries)).toBeUndefined();
  });

  const cases: [string, ArchiveSpec, string][] = [
    ["an absolute path", { type: "file", path: "/etc/rn-xtool-test", body: "x" }, "has an absolute path"],
    ["a .. segment", { type: "file", path: "MLKitFoo/../../up", body: "x" }, "goes up with .."],
    ["a device file", { type: "chardev", path: "MLKitFoo/null" }, "is a device or special file"],
    ["a fifo", { type: "fifo", path: "MLKitFoo/fifo" }, "is a device or special file"],
    ["an absolute link", { type: "symlink", path: "MLKitFoo/etc", target: "/etc" }, "is a link that points outside the archive"],
    ["a link that leaves the tree", { type: "symlink", path: "MLKitFoo/up", target: "../../x" }, "is a link that points outside the archive"],
  ];
  describe.each(["tar.gz", "zip"] as const)("a %s", (ext) => {
    it.each(cases)("refuses %s", async (_, bad, why) => {
      const entries = await listArchive(write(ext, [...SAFE, bad]), ext);
      expect(unsafeEntry(entries)).toEqual({ entry: bad.path, why });
    });

    it("refuses a link that leaves the tree through another link", async () => {
      const chain: ArchiveSpec[] = [
        { type: "symlink", path: "MLKitFoo/d/b", target: ".." },
        { type: "symlink", path: "MLKitFoo/a", target: "d/b/../.." },
      ];
      const entries = await listArchive(write(ext, [...SAFE, ...chain]), ext);
      expect(unsafeEntry(entries)).toEqual({ entry: "MLKitFoo/a", why: "is a link that points outside the archive" });
    });

    it("accepts a link that stays inside", async () => {
      const inside: ArchiveSpec[] = [
        { type: "symlink", path: "MLKitFoo/d/b", target: ".." },
        { type: "symlink", path: "MLKitFoo/top", target: "d/b/Frameworks/a b.txt" },
      ];
      expect(unsafeEntry(await listArchive(write(ext, [...SAFE, ...inside]), ext))).toBeUndefined();
    });
  });

  it.each([
    ["MLKitFoo/../../etc/passwd", "is a link that points outside the archive"],
    ["/etc/passwd", "is a link that points outside the archive"],
  ])("refuses a tar hard link to %s", async (target, why) => {
    const entries = await listArchive(write("tar.gz", [...SAFE, { type: "hardlink", path: "MLKitFoo/h", target }]), "tar.gz");
    expect(unsafeEntry(entries)).toEqual({ entry: "MLKitFoo/h", why });
  });

  it("accepts a tar hard link inside the archive", async () => {
    const entries = await listArchive(
      write("tar.gz", [...SAFE, { type: "hardlink", path: "MLKitFoo/h", target: "MLKitFoo/Frameworks/a b.txt" }]),
      "tar.gz",
    );
    expect(unsafeEntry(entries)).toBeUndefined();
  });
});

describe("safeEntries", () => {
  it("refuses an unsafe archive naming the archive and the entry", async () => {
    const file = write("tar.gz", [...SAFE, { type: "file", path: "MLKitFoo/../../up", body: "x" }]);
    await expect(safeEntries(file, "tar.gz", { pod: "MLKitFoo", version: "1.0.0" })).rejects.toThrow(
      `rn-xtool refuses to extract MLKitFoo-1.0.0.tar.gz (MLKitFoo 1.0.0): its entry "MLKitFoo/../../up" goes up with ... Nothing was extracted. See ${LINK}`,
    );
  });

  it("returns the entries of a safe archive", async () => {
    const entries = await safeEntries(write("zip", SAFE), "zip", { pod: "MLKitFoo", version: "1.0.0" });
    expect(entries).toHaveLength(4);
  });

  it("names sudo apt install unzip for a zip without unzip", async () => {
    const run: ListRunner = async (cmd) => {
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    };
    await expect(safeEntries(write("zip", SAFE), "zip", { pod: "MLKitFoo", version: "1.0.0" }, run)).rejects.toThrow(
      "MLKitFoo 1.0.0 is a .zip download, and unzip is not installed. Install it (sudo apt install unzip) and build again.",
    );
  });

  it("names a listing that fails", async () => {
    const file = path.join(dir, "broken.tar.gz");
    writeFileSync(file, "not an archive");
    await expect(safeEntries(file, "tar.gz", { pod: "MLKitFoo", version: "1.0.0" })).rejects.toThrow(
      /rn-xtool cannot list broken\.tar\.gz \(MLKitFoo 1\.0\.0\): /,
    );
  });
});
