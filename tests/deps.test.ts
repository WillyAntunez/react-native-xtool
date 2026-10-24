import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintOf, depsFingerprint } from "../src/deps.js";

function project(deps: Record<string, string>, installed: Record<string, string>, patches: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "deps-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ version }));
  }
  if (patches.length) {
    mkdirSync(join(root, "patches"));
    for (const p of patches) writeFileSync(join(root, "patches", p), "");
  }
  return root;
}

describe("fingerprintOf", () => {
  it("ignores order and changes with content", () => {
    expect(fingerprintOf(["a@1", "b@2"])).toBe(fingerprintOf(["b@2", "a@1"]));
    expect(fingerprintOf(["a@1"])).not.toBe(fingerprintOf(["a@2"]));
  });
});

describe("depsFingerprint", () => {
  const deps = { a: "^1.0.0", b: "~2.0.0" };
  it("is stable for the same project", async () => {
    const root = project(deps, { a: "1.0.0", b: "2.0.0" });
    expect(await depsFingerprint(root)).toBe(await depsFingerprint(root));
  });
  it("changes with the installed version, not the range", async () => {
    const one = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }));
    const two = await depsFingerprint(project(deps, { a: "1.1.0", b: "2.0.0" }));
    expect(one).not.toBe(two);
  });
  it("marks uninstalled dependencies as missing", async () => {
    const missing = await depsFingerprint(project(deps, { a: "1.0.0" }));
    expect(missing).toBe(fingerprintOf(["a@1.0.0", "b@missing"]));
  });
  it("changes with patch files and ignores other files", async () => {
    const base = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }));
    const patched = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }, ["a+1.0.0.patch", "README.md"]));
    const patchedOnly = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }, ["a+1.0.0.patch"]));
    expect(patched).not.toBe(base);
    expect(patched).toBe(patchedOnly);
  });
});
