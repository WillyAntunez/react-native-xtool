// The bundled patches against the pristine upstream packages they patch, from the pinned tarballs in tests/.cache.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatchFileName } from "../src/pipeline/patches.js";
import { packageRoot } from "../src/tools/exec.js";
import { MANIFEST, needsTarball, packageFromTarball } from "./support/tarballs.js";
import { patchTool } from "./support/tools.js";

const PATCHES = path.join(packageRoot(), "patches");
const BUNDLED = readdirSync(PATCHES)
  .filter((f) => f.endsWith(".patch"))
  .sort();
const specOf = (file: string) => {
  const info = parsePatchFileName(file);
  return info && `${info.pkg}@${info.version}`;
};

describe("bundled patches upstream", () => {
  it("every bundled patch has a pinned tarball", () => {
    expect(BUNDLED.length).toBeGreaterThan(0);
    const pinned = new Set(MANIFEST.map((e) => e.spec));
    for (const file of BUNDLED) expect(pinned.has(specOf(file) ?? ""), file).toBe(true);
  });

  for (const file of BUNDLED) {
    const spec = specOf(file) ?? file;
    const needs = needsTarball(spec);
    it.skipIf(needs !== "")(`${file} applies to its pristine package${needs}`, () => {
      const pkg = packageFromTarball(spec)!;
      // The patch is in patch-package format (a/node_modules/<name>/...): -p1 from the folder that holds node_modules.
      const name = spec.slice(0, spec.lastIndexOf("@"));
      const base = path.resolve(pkg, ...name.split("/").map(() => ".."), "..");
      const r = patchTool(["-p1", "-F0", "--dry-run", "-d", base, "-i", path.join(PATCHES, file)]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }, 60_000);
  }
});
