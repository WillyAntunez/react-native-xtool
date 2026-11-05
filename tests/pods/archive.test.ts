import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import {
  EXTRACTED_STAMP,
  EXTRACTOR_VERSION,
  defaultListRunner,
  extractPod,
  listArchive,
  parseTarListing,
  parseZipListing,
  safeEntries,
  unsafeEntry,
  type ArchiveEntry,
  type ExtractRequest,
  type ListRunner,
} from "../../src/pods/archive.js";
import { swapIn } from "../../src/pipeline/rnArtifacts.js";
import { PodsError } from "../../src/pods/format.js";
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

  it("stops on a zip listing line it cannot read, between the header and the summary", () => {
    const lines = ZIP_LISTING.split("\n");
    lines.splice(3, 0, "?????  odd line");
    expect(() => parseZipListing(lines.join("\n"))).toThrow("rn-xtool cannot read this archive listing line: ?????  odd line");
    expect(parseZipListing("Archive:  e.zip\nZip file size: 22 bytes, number of entries: 0\nEmpty zipfile.\n")).toEqual([]);
    expect(parseZipListing("Archive:  one.zip\nZip file size: 126 bytes, number of entries: 1\n" + lines[2] + "\n1 file, 3 bytes uncompressed, 3 bytes compressed:  0.0%\n")).toHaveLength(1);
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

const FOO: ArchiveSpec[] = [
  { type: "dir", path: "Frameworks/" },
  { type: "dir", path: "Frameworks/MLKitFoo.framework/" },
  { type: "file", path: "Frameworks/MLKitFoo.framework/MLKitFoo", body: "!<arch>\n" },
  { type: "file", path: "Frameworks/MLKitFoo.framework/Headers/MLKitFoo.h", body: "// h" },
  { type: "file", path: "Frameworks/MLKitFoo.framework/Modules/module.modulemap", body: "framework module MLKitFoo {}" },
  { type: "file", path: "Resources/FooResources/model.tflite", body: "model" },
  { type: "file", path: "Resources/FooResources/sub/labels.txt", body: "labels" },
  { type: "file", path: "Other/big.bin", body: "big" },
  { type: "file", path: "NOTICES", body: "notices" },
  { type: "file", path: "README.md", body: "readme" },
];
const KEPT = [
  "Frameworks/MLKitFoo.framework/Headers/MLKitFoo.h",
  "Frameworks/MLKitFoo.framework/MLKitFoo",
  "Frameworks/MLKitFoo.framework/Modules/module.modulemap",
  "NOTICES",
  "Resources/FooResources/model.tflite",
  "Resources/FooResources/sub/labels.txt",
];
const SHA_FOO = "f".repeat(64);
/** A runner that fails every call: a reused tree must not list or extract. */
const failingRunner: ListRunner = async () => {
  throw new Error("must not run");
};
const under = (prefix: string, entries: ArchiveSpec[]): ArchiveSpec[] => [
  { type: "dir", path: `${prefix}/` },
  ...entries.map((e) => ({ ...e, path: `${prefix}/${e.path}` }) as ArchiveSpec),
];

/** Every file and link below `root`, relative, sorted; the stamp left out. */
function treeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const d of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel === "" ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) walk(p);
      else if (p !== EXTRACTED_STAMP) out.push(p);
    }
  };
  walk("");
  return out.sort();
}

describe("extractPod", () => {
  let cache: string;
  beforeEach(() => {
    cache = path.join(dir, "cache");
  });
  const request = (archive: string, ext: "tar.gz" | "zip", extra: Partial<ExtractRequest> = {}): ExtractRequest => ({
    archive,
    ext,
    sha256: SHA_FOO,
    pod: "MLKitFoo",
    version: "1.0.0",
    flatten: false,
    keep: ["Frameworks/MLKitFoo.framework", "Resources/FooResources/**", "NOTICES"],
    required: ["Frameworks/MLKitFoo.framework"],
    ...extra,
  });
  const extracted = (): string[] => (existsSync(path.join(cache, "extracted")) ? readdirSync(path.join(cache, "extracted")) : []);

  it.each(["tar.gz", "zip"] as const)("extracts only the paths the spec needs (%s)", async (ext) => {
    const dest = await extractPod(request(write(ext, FOO), ext), cache);
    expect(path.relative(cache, dest)).toMatch(new RegExp(`^extracted/${SHA_FOO}-[0-9a-f]{16}$`));
    expect(treeFiles(dest)).toEqual(KEPT);
    expect(readFileSync(path.join(dest, "Resources/FooResources/sub/labels.txt"), "utf8")).toBe("labels");
    expect(JSON.parse(readFileSync(path.join(dest, EXTRACTED_STAMP), "utf8"))).toEqual({
      extractorVersion: EXTRACTOR_VERSION,
      sha256: SHA_FOO,
      keep: ["Frameworks/MLKitFoo.framework", "NOTICES", "Resources/FooResources/**"],
      flatten: false,
    });
    expect(extracted()).toEqual([path.basename(dest)]);
  });

  it.each(["tar.gz", "zip"] as const)("strips the top-level folder of a flatten archive (%s)", async (ext) => {
    const dest = await extractPod(request(write(ext, under("MLKitFoo-1.0.0", FOO)), ext, { flatten: true }), cache);
    expect(treeFiles(dest)).toEqual(KEPT);
  });

  it("keeps the layout of a flatten archive with several top-level entries", async () => {
    const dest = await extractPod(request(write("tar.gz", FOO), "tar.gz", { flatten: true }), cache);
    expect(treeFiles(dest)).toEqual(KEPT);
  });

  it("brings the target of a kept link along", async () => {
    const entries: ArchiveSpec[] = [
      ...FOO,
      { type: "file", path: "Shared/libFoo.a", body: "!<arch>\n" },
      { type: "symlink", path: "Frameworks/MLKitFoo.framework/libFoo.a", target: "../../Shared/libFoo.a" },
    ];
    const dest = await extractPod(request(write("tar.gz", entries), "tar.gz"), cache);
    expect(treeFiles(dest)).toContain("Shared/libFoo.a");
    expect(readFileSync(path.join(dest, "Frameworks/MLKitFoo.framework/libFoo.a"), "utf8")).toBe("!<arch>\n");
    expect(treeFiles(dest)).not.toContain("Other/big.bin");
  });

  it.each(["tar.gz", "zip"] as const)(
    "names the expected path and the archive's top-level entries when a vendored path is missing (%s)",
    async (ext) => {
      const file = write(ext, [...under("MLKitFoo-1.0.0", FOO), { type: "file", path: "LICENSE", body: "l" }]);
      await expect(extractPod(request(file, ext), cache)).rejects.toThrow(
        `MLKitFoo 1.0.0: its spec names Frameworks/MLKitFoo.framework, which the download does not hold. Its top-level entries: LICENSE, MLKitFoo-1.0.0/. See ${LINK}`,
      );
      expect(extracted()).toEqual([]);
    },
  );

  it.each([
    ["tar.gz", "Frameworks/up", "../.."],
    ["zip", "Frameworks/up", "../.."],
    ["tar.gz", "x", "../MLKitFoo-1.0.0/NOTICES"],
    ["zip", "x", "../MLKitFoo-1.0.0/NOTICES"],
  ] as const)("checks a flatten archive's links against the kept folder (%s, %s -> %s)", async (ext, link, target) => {
    const file = write(ext, under("MLKitFoo-1.0.0", [...FOO, { type: "symlink", path: link, target }]));
    await expect(extractPod(request(file, ext, { flatten: true }), cache)).rejects.toThrow(
      `rn-xtool refuses to extract MLKitFoo-1.0.0.${ext} (MLKitFoo 1.0.0): its entry "MLKitFoo-1.0.0/${link}" is a link that points outside the archive. Nothing was extracted. See ${LINK}`,
    );
    expect(extracted()).toEqual([]);
  });

  it.each(["tar.gz", "zip"] as const)("accepts a flatten archive's link that stays in the kept folder (%s)", async (ext) => {
    const link: ArchiveSpec = { type: "symlink", path: "Frameworks/MLKitFoo.framework/NOTICES", target: "../../NOTICES" };
    const dest = await extractPod(request(write(ext, under("MLKitFoo-1.0.0", [...FOO, link])), ext, { flatten: true }), cache);
    expect(readFileSync(path.join(dest, "Frameworks/MLKitFoo.framework/NOTICES"), "utf8")).toBe(readFileSync(path.join(dest, "NOTICES"), "utf8"));
  });

  it("refuses a flatten tar's hard link outside the kept folder", async () => {
    const file = write("tar.gz", [
      ...under("MLKitFoo-1.0.0", FOO),
      { type: "hardlink", path: "MLKitFoo-1.0.0/h", target: "Elsewhere/NOTICES" },
    ]);
    await expect(extractPod(request(file, "tar.gz", { flatten: true }), cache)).rejects.toThrow(/its entry "MLKitFoo-1\.0\.0\/h"/);
  });

  it("names the archive and the pod when the extraction fails, without the cache's path", async () => {
    const file = write("tar.gz", FOO);
    const broken: ListRunner = async (cmd, args) => {
      if (!args.includes("-xzf")) return defaultListRunner(cmd, args);
      throw Object.assign(new Error(`Command failed with exit code 2: tar -xzf ${file} -C ${cache}/extracted/x`), {
        exitCode: 2,
        stderr: `tar: ${file}: Cannot read: Input/output error\ntar: Exiting with failure status`,
      });
    };
    const err = (await extractPod(request(file, "tar.gz"), cache, broken).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PodsError);
    expect(err.message).toBe(
      `rn-xtool could not extract MLKitFoo-1.0.0.tar.gz (MLKitFoo 1.0.0): tar: MLKitFoo-1.0.0.tar.gz: Cannot read: Input/output error. See ${LINK}`,
    );
    const silent: ListRunner = async (cmd, args) => {
      if (!args.includes("-xzf")) return defaultListRunner(cmd, args);
      throw Object.assign(new Error(`Command failed with exit code 2: tar -xzf ${file}`), { exitCode: 2, stderr: "" });
    };
    await expect(extractPod(request(file, "tar.gz"), cache, silent)).rejects.toThrow(
      `rn-xtool could not extract MLKitFoo-1.0.0.tar.gz (MLKitFoo 1.0.0): tar exited with code 2. See ${LINK}`,
    );
    expect(extracted()).toEqual([]);
  });

  it("names the archive when unzip cannot extract a member under a link", async () => {
    const file = write("zip", [
      ...FOO,
      { type: "symlink", path: "Frameworks/MLKitFoo.framework/sub", target: "." },
      { type: "file", path: "Frameworks/MLKitFoo.framework/sub/b.h", body: "b" },
    ]);
    const err = (await extractPod(request(file, "zip"), cache).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PodsError);
    expect(err.message).toMatch(/^rn-xtool could not extract MLKitFoo-1\.0\.0\.zip \(MLKitFoo 1\.0\.0\): /);
    expect(err.message).not.toContain(dir);
  });

  it("refuses an unsafe archive and extracts nothing", async () => {
    const file = write("tar.gz", [...FOO, { type: "symlink", path: "Frameworks/MLKitFoo.framework/x", target: "/etc" }]);
    await expect(extractPod(request(file, "tar.gz"), cache)).rejects.toThrow(/rn-xtool refuses to extract MLKitFoo-1\.0\.0\.tar\.gz/);
    expect(extracted()).toEqual([]);
  });

  it("reuses a stamped tree", async () => {
    const file = write("tar.gz", FOO);
    const dest = await extractPod(request(file, "tar.gz"), cache);
    writeFileSync(path.join(dest, "marker"), "kept");
    rmSync(file);
    expect(await extractPod(request(file, "tar.gz"), cache)).toBe(dest);
    expect(readFileSync(path.join(dest, "marker"), "utf8")).toBe("kept");
  });

  it("rebuilds a tree without its stamp", async () => {
    const file = write("tar.gz", FOO);
    const dest = await extractPod(request(file, "tar.gz"), cache);
    rmSync(path.join(dest, EXTRACTED_STAMP));
    writeFileSync(path.join(dest, "marker"), "stale");
    await extractPod(request(file, "tar.gz"), cache);
    expect(treeFiles(dest)).toEqual(KEPT);
    expect(existsSync(path.join(dest, EXTRACTED_STAMP))).toBe(true);
    expect(extracted()).toEqual([path.basename(dest)]);
  });

  it("keeps one tree per selection of one archive, one after the other", async () => {
    const file = write("tar.gz", FOO);
    const notices = await extractPod(request(file, "tar.gz", { keep: ["NOTICES"], required: [] }), cache);
    const all = await extractPod(request(file, "tar.gz"), cache);
    expect(all).not.toBe(notices);
    expect(treeFiles(notices)).toEqual(["NOTICES"]);
    expect(treeFiles(all)).toEqual(KEPT);
    expect(await extractPod(request(file, "tar.gz", { keep: ["NOTICES"], required: [] }), cache, failingRunner)).toBe(notices);
    expect(extracted().sort()).toEqual([path.basename(notices), path.basename(all)].sort());
  });

  it("keeps one tree per selection of one archive, at the same time", async () => {
    const file = write("tar.gz", FOO);
    const [notices, all, flat] = await Promise.all([
      extractPod(request(file, "tar.gz", { keep: ["NOTICES"], required: [] }), cache),
      extractPod(request(file, "tar.gz"), cache),
      extractPod(request(file, "tar.gz", { flatten: true }), cache),
    ]);
    expect(new Set([notices, all, flat]).size).toBe(3);
    expect(treeFiles(notices)).toEqual(["NOTICES"]);
    expect(treeFiles(all)).toEqual(KEPT);
    expect(treeFiles(flat)).toEqual(KEPT);
  });

  it.each(["tar.gz", "zip"] as const)("writes the stamp last (%s)", async (ext) => {
    const file = write(ext, FOO);
    const failing: ListRunner = async (cmd, args) => {
      const out = await defaultListRunner(cmd, args);
      if (args.includes("-x") || args.includes("-xzf") || args.includes("-d")) throw new Error("disk full");
      return out;
    };
    await expect(extractPod(request(file, ext), cache, failing)).rejects.toThrow("disk full");
    expect(extracted()).toEqual([]);
    const dest = await extractPod(request(file, ext), cache);
    await expect(extractPod(request(file, ext, { keep: ["NOTICES"], required: [] }), cache, failing)).rejects.toThrow("disk full");
    expect(treeFiles(dest)).toEqual(KEPT);
    expect(existsSync(path.join(dest, EXTRACTED_STAMP))).toBe(true);
    expect(extracted()).toEqual([path.basename(dest)]);
  });

  it("writes the stamp into the tree before it swaps the tree in", async () => {
    const file = write("tar.gz", FOO);
    const stamped: boolean[] = [];
    const swap: typeof swapIn = async (tmp, dest, old) => {
      stamped.push(existsSync(path.join(tmp, EXTRACTED_STAMP)));
      await swapIn(tmp, dest, old);
    };
    const dest = await extractPod(request(file, "tar.gz"), cache, defaultListRunner, swap);
    expect(stamped).toEqual([true]);
    expect(existsSync(path.join(dest, EXTRACTED_STAMP))).toBe(true);
  });

  it("lets a tree another build stamped during the swap win", async () => {
    const file = write("tar.gz", FOO);
    // The other build swaps its own finished tree in first, so this build's rename fails.
    const swap: typeof swapIn = async (tmp, dest) => {
      cpSync(tmp, dest, { recursive: true });
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rename '${tmp}' -> '${dest}'`), { code: "ENOTEMPTY" });
    };
    const dest = await extractPod(request(file, "tar.gz"), cache, defaultListRunner, swap);
    expect(treeFiles(dest)).toEqual(KEPT);
    expect(extracted()).toEqual([path.basename(dest)]);
    const failing: typeof swapIn = async () => {
      throw new Error("rename failed");
    };
    await expect(extractPod(request(file, "tar.gz", { keep: ["NOTICES"], required: [] }), cache, defaultListRunner, failing)).rejects.toThrow(
      "rename failed",
    );
  });

  it("two extractions of one archive both succeed", async () => {
    const file = write("tar.gz", FOO);
    const [a, b] = await Promise.all([extractPod(request(file, "tar.gz"), cache), extractPod(request(file, "tar.gz"), cache)]);
    expect(a).toBe(b);
    expect(treeFiles(a)).toEqual(KEPT);
    expect(existsSync(path.join(a, EXTRACTED_STAMP))).toBe(true);
    expect(extracted()).toEqual([path.basename(a)]);
  });
});
