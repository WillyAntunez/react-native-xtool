import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixLibraryManifests, makeManifestPortable, MANIFEST_FIXES, ManifestWriteError } from "../src/pipeline/manifests.js";
import { applyPatches } from "../src/pipeline/patches.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "manifests");
/** react-native-worklets 0.13.0's Package.swift, trimmed after `stringifyFlagValue` (reanimated 4.7.1 has the same block). */
const BROKEN = readFileSync(join(fixtures, "react-native-worklets.Package.swift"), "utf8");
/** BROKEN with the persisted patch from the old docs applied (`patch -p1`). */
const PORTABLE = readFileSync(join(fixtures, "react-native-worklets.portable.Package.swift"), "utf8");
const PERSISTED_PATCH = "react-native-worklets+0.13.0.patch";

const LOG_LINE = (pkg: string) => `manifest — made ${pkg}'s Package.swift portable to Linux (CFGetTypeID)`;

describe("makeManifestPortable", () => {
  it("has one known snippet, CFGetTypeID", () => {
    expect(MANIFEST_FIXES.map((f) => f.name)).toEqual(["CFGetTypeID"]);
  });

  it("rewrites the exact snippet to the documented portable form", () => {
    const r = makeManifestPortable(BROKEN);
    expect(r.fixes).toEqual(["CFGetTypeID"]);
    // Byte-identical to the old docs' patch, so that patch still counts as applied afterwards.
    expect(r.text).toBe(PORTABLE);
  });

  it("tolerates indentation and whitespace variations", () => {
    const variant = BROKEN.replace(
      "        if CFGetTypeID(number) == CFBooleanGetTypeID() {",
      "\t\tif  CFGetTypeID( value )==CFBooleanGetTypeID( )  {  ",
    );
    expect(variant).not.toBe(BROKEN);
    const r = makeManifestPortable(variant);
    expect(r.fixes).toEqual(["CFGetTypeID"]);
    expect(r.text).toContain(
      [
        "#if canImport(Darwin)",
        "\t\tlet isBoolean = CFGetTypeID(value) == CFBooleanGetTypeID()",
        "#else",
        '\t\tlet isBoolean = String(cString: value.objCType) == "c"',
        "#endif",
        "\t\tif isBoolean {",
        "            return number.boolValue",
      ].join("\n"),
    );
    expect(r.text).not.toMatch(/if\s+CFGetTypeID/);
  });

  it("leaves an already fixed manifest alone", () => {
    expect(makeManifestPortable(PORTABLE)).toEqual({ text: PORTABLE, fixes: [] });
    expect(makeManifestPortable(makeManifestPortable(BROKEN).text).fixes).toEqual([]);
  });

  it("leaves an unrelated manifest alone", () => {
    const expoManifest = readFileSync(join(fixtures, "..", "expo-Package.swift"), "utf8");
    expect(makeManifestPortable(expoManifest)).toEqual({ text: expoManifest, fixes: [] });
  });

  it("leaves a manifest untouched when the snippet appears in a form it does not know", () => {
    const unknown = [
      "        if CFGetTypeID(number) == CFBooleanGetTypeID() && strict {",
      "        if CFGetTypeID(number) == CFBooleanGetTypeID() { return \"bool\" }",
      "        guard CFGetTypeID(number) != CFBooleanGetTypeID() else {",
      "        let isBoolean = CFGetTypeID(number) == CFBooleanGetTypeID()",
    ];
    for (const line of unknown) {
      const text = BROKEN.replace("        if CFGetTypeID(number) == CFBooleanGetTypeID() {", line);
      expect(makeManifestPortable(text)).toEqual({ text, fixes: [] });
    }
  });

  it("makes no partial edit when a known snippet sits next to an unknown use", () => {
    const text = `${BROKEN}\nlet strictBool = { (n: NSNumber) in CFGetTypeID(n) == CFBooleanGetTypeID() }\n`;
    expect(makeManifestPortable(text)).toEqual({ text, fixes: [] });
  });

  const SNIPPET = "        if CFGetTypeID(number) == CFBooleanGetTypeID() {";

  it("leaves a manifest with two matches untouched", () => {
    const second = ["func strictFlag(_ number: NSNumber) -> Bool {", SNIPPET, "            return true", "        }", "    return false", "}", ""];
    const text = `${BROKEN}\n${second.join("\n")}`;
    expect(makeManifestPortable(text)).toEqual({ text, fixes: [] });
  });

  it("leaves a match inside a comment, a string or a conditional guard untouched", () => {
    const wrapped = [
      ["/*", SNIPPET, "*/"],
      ['let doc = """', SNIPPET, '"""'],
      ["#if canImport(Darwin)", SNIPPET, "            return nil", "        }", "#endif"],
      ["#if !os(Linux)", SNIPPET, "            return nil", "        }", "#endif"],
    ];
    for (const lines of wrapped) {
      const text = `${PORTABLE}\n${lines.join("\n")}\n`;
      expect(makeManifestPortable(text)).toEqual({ text, fixes: [] });
    }
  });

  it("does not read a /* inside a multi-line string as a comment", () => {
    const text = [
      'let doc = """',
      "/* not a comment",
      '"""',
      BROKEN,
      "let strictBool = { (n: NSNumber) in CFGetTypeID(n) == CFBooleanGetTypeID() }",
      "// end */",
      "",
    ].join("\n");
    expect(makeManifestPortable(text)).toEqual({ text, fixes: [] });
    // The known snippet alone, between that string and a later `*/` (in a glob), is plain code and is fixed.
    const wrap = (body: string) => `let doc = """\n/* not a comment\n"""\n${body}let headers = "ios/**/*.h"\n`;
    expect(makeManifestPortable(wrap(BROKEN))).toEqual({ text: wrap(PORTABLE), fixes: ["CFGetTypeID"] });
  });

  it("keeps CRLF line endings, and leaves mixed line endings alone", () => {
    const crlf = BROKEN.replace(/\n/g, "\r\n");
    expect(makeManifestPortable(crlf)).toEqual({ text: PORTABLE.replace(/\n/g, "\r\n"), fixes: ["CFGetTypeID"] });
    const mixed = BROKEN.replace("\n", "\r\n");
    expect(makeManifestPortable(mixed)).toEqual({ text: mixed, fixes: [] });
  });
});

/** A temp project with `node_modules/<pkg>/` holding the given files. */
function project(libs: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "manifests-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  for (const [pkg, files] of Object.entries(libs)) {
    const dir = join(root, "node_modules", pkg);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  }
  return root;
}

const manifest = (root: string, pkg: string, name = "Package.swift") =>
  readFileSync(join(root, "node_modules", pkg, name), "utf8");

describe("fixLibraryManifests", () => {
  it("fixes top-level and scoped libraries, one log line each", async () => {
    const pkgJson = (name: string) => JSON.stringify({ name, version: "1.0.0" });
    const root = project({
      "react-native-reanimated": { "package.json": pkgJson("react-native-reanimated"), "Package.swift": BROKEN },
      "@acme/native": {
        "package.json": pkgJson("@acme/native"),
        "Package.swift": BROKEN,
        "Package@swift-6.0.swift": BROKEN,
      },
      "react-native-screens": { "package.json": pkgJson("react-native-screens"), "Package.swift": "// swift-tools-version: 6.0\n" },
      "left-pad": { "package.json": pkgJson("left-pad"), "index.js": "" },
    });
    const lines: string[] = [];
    await fixLibraryManifests(root, (l) => lines.push(l));
    expect(manifest(root, "react-native-reanimated")).toBe(PORTABLE);
    expect(manifest(root, "@acme/native")).toBe(PORTABLE);
    expect(manifest(root, "@acme/native", "Package@swift-6.0.swift")).toBe(PORTABLE);
    expect(manifest(root, "react-native-screens")).toBe("// swift-tools-version: 6.0\n");
    expect(lines).toEqual([
      "manifest — made @acme/native's Package.swift and Package@swift-6.0.swift portable to Linux (CFGetTypeID)",
      LOG_LINE("react-native-reanimated"),
    ]);
  });

  it("skips a package linked from outside the project's node_modules, and says so", async () => {
    const root = project({ "react-native-worklets": { "Package.swift": BROKEN } });
    const source = mkdtempSync(join(tmpdir(), "manifests-fork-"));
    writeFileSync(join(source, "Package.swift"), BROKEN);
    symlinkSync(source, join(root, "node_modules", "myfork"));
    // A link that stays inside node_modules (pnpm's layout) is still the project's own copy.
    const store = join(root, "node_modules", ".store", "inner");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "Package.swift"), BROKEN);
    symlinkSync(store, join(root, "node_modules", "inner"));
    const lines: string[] = [];
    await fixLibraryManifests(root, (l) => lines.push(l));
    expect(readFileSync(join(source, "Package.swift"), "utf8")).toBe(BROKEN);
    expect(readFileSync(join(store, "Package.swift"), "utf8")).toBe(PORTABLE);
    expect(manifest(root, "react-native-worklets")).toBe(PORTABLE);
    expect(lines).toEqual([
      LOG_LINE("inner"),
      `manifest — skipped myfork: it is a link to ${relative(realpathSync(root), realpathSync(source))}; apply the portable manifest in its source`,
      LOG_LINE("react-native-worklets"),
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("names the file and the remedy when node_modules is read-only", async () => {
    const root = project({ "react-native-worklets": { "Package.swift": BROKEN } });
    chmodSync(join(root, "node_modules", "react-native-worklets", "Package.swift"), 0o444);
    const err = (await fixLibraryManifests(root, () => {}).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ManifestWriteError);
    expect(err.message).toBe(
      "Could not write node_modules/react-native-worklets/Package.swift (EACCES) to make it portable to Linux: " +
        "node_modules is read-only; make it writable or apply the portable manifest yourself.",
    );
  });

  it("is a quiet no-op on a second run and without node_modules", async () => {
    const root = project({ "react-native-worklets": { "Package.swift": BROKEN } });
    await fixLibraryManifests(root, () => {});
    const lines: string[] = [];
    await fixLibraryManifests(root, (l) => lines.push(l));
    await fixLibraryManifests(mkdtempSync(join(tmpdir(), "manifests-empty-")), (l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(manifest(root, "react-native-worklets")).toBe(PORTABLE);
  });
});

describe("persisted patches from the old docs", () => {
  /** The project's `patches/` holds the old docs' patch-package patch; patch-package itself runs. */
  function patchedProject(content: string): string {
    const root = project({
      "react-native-worklets": {
        "package.json": JSON.stringify({ name: "react-native-worklets", version: "0.13.0" }),
        "Package.swift": content,
      },
    });
    mkdirSync(join(root, "patches"));
    writeFileSync(join(root, "patches", PERSISTED_PATCH), readFileSync(join(fixtures, PERSISTED_PATCH)));
    return root;
  }

  it("keep applying, and the manifest step then finds nothing to do", async () => {
    const root = patchedProject(BROKEN);
    const lines: string[] = [];
    await applyPatches(root, undefined, { rnScripts: "vendored", log: (l) => lines.push(l) });
    expect(manifest(root, "react-native-worklets")).toBe(PORTABLE);
    await fixLibraryManifests(root, (l) => lines.push(l));
    expect(manifest(root, "react-native-worklets")).toBe(PORTABLE);
    expect(lines).toEqual([]);
  }, 30_000);

  it("still count as applied on a manifest rn-xtool already fixed", async () => {
    const root = patchedProject(BROKEN);
    await fixLibraryManifests(root, () => {});
    await applyPatches(root, undefined, { rnScripts: "vendored", log: () => {} });
    expect(manifest(root, "react-native-worklets")).toBe(PORTABLE);
  }, 30_000);
});
