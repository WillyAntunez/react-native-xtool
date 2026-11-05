import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { arArchive, binaryMagic, fat, machO } from "./support/macho.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "rn-xtool-pack-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("binaryMagic", () => {
  it("finds a planted ar file and a planted Mach-O file", () => {
    const files: Record<string, Buffer | string> = {
      "lib.a": arArchive([{ name: "a.o", data: machO() }]),
      "thin.a": Buffer.concat([Buffer.from("!<thin>\n"), Buffer.alloc(8)]),
      "obj.o": machO(),
      "fat.bin": fat([{ cpu: "arm64", data: machO() }]),
      "text.js": "export {};\n",
      "short": "!<a",
    };
    for (const [name, data] of Object.entries(files)) writeFileSync(path.join(tmp, name), data);
    const found = Object.fromEntries(Object.keys(files).map((n) => [n, binaryMagic(path.join(tmp, n))]));
    expect(found).toEqual({ "lib.a": "ar", "thin.a": "ar", "obj.o": "Mach-O", "fat.bin": "fat", "text.js": undefined, short: undefined });
  });
});

describe("the npm package", () => {
  let files: string[] | undefined;
  /** What `npm pack` would ship (no network, no build), listed once. */
  const listed = (): string[] => {
    if (files === undefined) {
      const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
      files = (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    }
    return files;
  };

  it("npm pack ships no Mach-O or ar file", () => {
    expect(listed().length).toBeGreaterThan(100);
    expect(listed().filter((f) => binaryMagic(path.join(ROOT, f)) !== undefined)).toEqual([]);
  });

  it("ships the pod table and the vendors' terms", () => {
    expect(listed()).toEqual(expect.arrayContaining(["data/pods.json", "data/pod-terms.json"]));
  });
});
