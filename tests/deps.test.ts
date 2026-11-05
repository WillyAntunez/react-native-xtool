import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprintOf, depsFingerprint } from "../src/deps.js";

/** The version `rn-xtool --version` prints. */
const RN_XTOOL_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

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
    expect(missing).toBe(fingerprintOf(["a@1.0.0", "b@missing", `rn-xtool@${RN_XTOOL_VERSION}`]));
  });
  it("changes with rn-xtool's own version, so an upgrade rebuilds", async () => {
    const root = project(deps, { a: "1.0.0", b: "2.0.0" });
    const old = await depsFingerprint(root, { toolVersion: "0.1.0-alpha.5" });
    expect(await depsFingerprint(root, { toolVersion: "0.1.0-alpha.5" })).toBe(old);
    expect(await depsFingerprint(root, { toolVersion: "0.1.0-alpha.6" })).not.toBe(old);
    expect(await depsFingerprint(root)).toBe(await depsFingerprint(root, { toolVersion: RN_XTOOL_VERSION }));
  });
  it("changes with patch files and ignores other files", async () => {
    const base = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }));
    const patched = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }, ["a+1.0.0.patch", "README.md"]));
    const patchedOnly = await depsFingerprint(project(deps, { a: "1.0.0", b: "2.0.0" }, ["a+1.0.0.patch"]));
    expect(patched).not.toBe(base);
    expect(patched).toBe(patchedOnly);
  });
  it("the fingerprint changes with the lock", async () => {
    const root = project(deps, { a: "1.0.0", b: "2.0.0" });
    const none = await depsFingerprint(root);
    writeFileSync(join(root, "rn-xtool-pods.lock.json"), '{ "lockfileVersion": 1, "pods": {} }\n');
    const empty = await depsFingerprint(root);
    expect(empty).not.toBe(none);
    expect(await depsFingerprint(root)).toBe(empty);
    writeFileSync(join(root, "rn-xtool-pods.lock.json"), '{ "lockfileVersion": 1, "pods": { "X": {} } }\n');
    expect(await depsFingerprint(root)).not.toBe(empty);
  });
});

describe("depsFingerprint of a bare project", () => {
  const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

  /** The template project; with `withObjc`, the mixed-target pbxproj fixture with every file it lists on disk. */
  function bare(o: { withObjc?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "deps-bare-"));
    cpSync(join(fixtures, "bare"), root, { recursive: true });
    if (o.withObjc) {
      cpSync(join(fixtures, "pbxproj", "with-objc.pbxproj"), join(root, "ios", "HelloWorld.xcodeproj", "project.pbxproj"));
      for (const [rel, text] of Object.entries({
        "Native/NativeModule.m": "// module\n",
        "Native/NativeModule.h": "// header\n",
        "HelloWorld-Bridging-Header.h": "// bridging\n",
        "Fonts/Inter.ttf": "font",
        "Base.lproj/Localizable.strings": "base",
        "es.lproj/Localizable.strings": "es",
        "Base.lproj/Intro.storyboard": "<document/>",
      })) {
        mkdirSync(join(root, "ios", "HelloWorld", rel, ".."), { recursive: true });
        writeFileSync(join(root, "ios", "HelloWorld", rel), text);
      }
    }
    const at = (rel: string) => join(root, "ios", rel);
    const edit = (rel: string, f: (s: string) => string) => writeFileSync(at(rel), f(readFileSync(at(rel), "utf8")));
    return { root, edit };
  }

  it("changes with the app target's sources, the pbxproj and the Info.plist, by content", async () => {
    const { root, edit } = bare();
    const base = await depsFingerprint(root);
    edit("HelloWorld/AppDelegate.swift", (s) => s); // same bytes, newer mtime
    expect(await depsFingerprint(root)).toBe(base);
    edit("HelloWorld/AppDelegate.swift", (s) => `${s}// edited\n`);
    const swift = await depsFingerprint(root);
    expect(swift).not.toBe(base);
    edit("HelloWorld.xcodeproj/project.pbxproj", (s) => s.replaceAll("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.1;"));
    const pbx = await depsFingerprint(root);
    expect(pbx).not.toBe(swift);
    edit("HelloWorld/Info.plist", (s) => s.replace("<dict>", "<dict>\n\t<key>X</key>\n\t<string>y</string>"));
    expect(await depsFingerprint(root)).not.toBe(pbx);
  });

  it("changes with Objective-C sources, headers, the bridging header and resources", async () => {
    const { root, edit } = bare({ withObjc: true });
    let previous = await depsFingerprint(root);
    for (const rel of [
      "HelloWorld/Native/NativeModule.m",
      "HelloWorld/Native/NativeModule.h",
      "HelloWorld/HelloWorld-Bridging-Header.h",
      "HelloWorld/Fonts/Inter.ttf",
      "HelloWorld/es.lproj/Localizable.strings",
    ]) {
      edit(rel, (s) => `${s}\n// edited`);
      const next = await depsFingerprint(root);
      expect(next, rel).not.toBe(previous);
      previous = next;
    }
  });

  it("keeps an Expo project's fingerprint to its dependencies and patches", async () => {
    const root = project({ expo: "^58.0.0" }, { expo: "58.0.1" });
    writeFileSync(join(root, "app.json"), JSON.stringify({ expo: { name: "a" } }));
    mkdirSync(join(root, "ios", "a.xcodeproj"), { recursive: true });
    writeFileSync(join(root, "ios", "a.xcodeproj", "project.pbxproj"), "// not read for expo");
    expect(await depsFingerprint(root)).toBe(fingerprintOf(["expo@58.0.1", `rn-xtool@${RN_XTOOL_VERSION}`]));
  });
});
