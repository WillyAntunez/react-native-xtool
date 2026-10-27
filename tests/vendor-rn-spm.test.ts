import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";

const ROOT = packageRoot();
const VENDOR = path.join(ROOT, "vendor", "rn-spm");
const TARBALL = path.join(ROOT, "tests", ".cache", "react-native-0.88.0.tgz");
const INTEGRITY =
  "sha512-v/wee0nYWcammMYBnSat/e3WY/5iaf9YQOMcBrfKT/wPApPPlHp94hgZovBtwhMuthR01yc/8cGn0FpFTE/C4A==";
const FETCH_CMD = "mkdir -p tests/.cache && npm pack react-native@0.88.0 --pack-destination tests/.cache";
/** The patch is in patch-package format (a/node_modules/react-native/scripts/...): strip 4 to land in scripts/. */
const PATCH_STRIP = "-p4";
const EXTRACT = ["package/scripts/setup-apple-spm.js", "package/scripts/spm", "package/scripts/codegen/templates/Package.swift.spm-template"];
const NOT_UPSTREAM = new Set(["README.md", "LICENSE", "package.json", "rn-xtool-edits.patch"]);

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const skipReason = !existsSync(TARBALL)
  ? `pristine tarball missing; run: ${FETCH_CMD}`
  : !has("tar") || !has("patch")
    ? "tar and patch are required"
    : null;
const provenance = skipReason ? it.skip : it;

const tmp: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
  );
}

const req = createRequire(path.join(VENDOR, "spm", "download-spm-artifacts.js"));
const spmUtils = () => req("./spm-utils.js");
const downloader = () => req("./download-spm-artifacts.js");
const podspec = () => req("./read-podspec.js");

describe("vendor/rn-spm provenance", () => {
  provenance("the cached tarball is react-native 0.88.0", () => {
    expect("sha512-" + createHash("sha512").update(readFileSync(TARBALL)).digest("base64")).toBe(INTEGRITY);
  });

  provenance("vendor/rn-spm is react-native 0.88.0 with our patch and rn-xtool-edits.patch applied", () => {
    const dir = mkTmp("vendor-rn-spm-");
    expect(spawnSync("tar", ["-xzf", TARBALL, "-C", dir, ...EXTRACT]).status).toBe(0);
    const scripts = path.join(dir, "package", "scripts");
    const patchOne = (strip: string, file: string) =>
      spawnSync("patch", [strip, "-F0", "-d", scripts, "-i", file], { encoding: "utf8" });
    const first = patchOne(PATCH_STRIP, path.join(ROOT, "patches", "react-native+0.88.0.patch"));
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const second = patchOne("-p1", path.join(VENDOR, "rn-xtool-edits.patch"));
    expect(second.status, second.stdout + second.stderr).toBe(0);

    const expected = listFiles(scripts).sort();
    const actual = listFiles(VENDOR).filter((f) => !NOT_UPSTREAM.has(f)).sort();
    expect(actual).toEqual(expected);
    for (const f of expected) {
      expect(readFileSync(path.join(VENDOR, f)).equals(readFileSync(path.join(scripts, f))), f).toBe(true);
    }
  });

  provenance("LICENSE is react-native 0.88.0's", () => {
    const out = spawnSync("tar", ["-xzOf", TARBALL, "package/LICENSE"], { maxBuffer: 1 << 24 });
    expect(out.status).toBe(0);
    expect(readFileSync(path.join(VENDOR, "LICENSE")).equals(out.stdout)).toBe(true);
  });
});

describe("vendor/rn-spm dependencies and edits", () => {
  it("the vendored scripts resolve yargs and micromatch from rn-xtool", () => {
    const nm = path.join(packageRoot(), "node_modules");
    expect(req.resolve("yargs").startsWith(nm)).toBe(true);
    expect(req.resolve("micromatch").startsWith(nm)).toBe(true);
  });

  it("E1 installs the codegen template from the vendored copy", () => {
    const app = mkTmp("vendor-e1-app-");
    mkdirSync(path.join(app, "build", "generated", "ios"), { recursive: true });
    const noScripts = mkTmp("vendor-e1-rn-");
    spmUtils().installSpmCodegenTemplate(app, noScripts);
    expect(readFileSync(path.join(app, "build", "generated", "ios", "Package.swift"))).toEqual(
      readFileSync(path.join(VENDOR, "codegen", "templates", "Package.swift.spm-template")),
    );
  });

  it("E2 reads the React Native version macros from RN_SPM_RN_ROOT", () => {
    const rn = mkTmp("vendor-e2-rn-");
    writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
    const write = () => {
      const f = path.join(mkTmp("vendor-e2-spec-"), "Lib.podspec");
      writeFileSync(
        f,
        `Pod::Spec.new do |s|\n  s.name = "Lib"\n  s.compiler_flags = "-DREACT_NATIVE_MINOR_VERSION=#{x}"\nend\n`,
      );
      return f;
    };
    const saved = process.env.RN_SPM_RN_ROOT;
    try {
      process.env.RN_SPM_RN_ROOT = rn;
      const model = podspec().readPodspecCached(write());
      expect(model.preprocessorDefines).toContainEqual(
        expect.objectContaining({ name: "REACT_NATIVE_MINOR_VERSION", value: "86" }),
      );
      delete process.env.RN_SPM_RN_ROOT;
      expect(() => podspec().readPodspecCached(write())).toThrow(/RN_SPM_RN_ROOT is not set/);
    } finally {
      if (saved === undefined) delete process.env.RN_SPM_RN_ROOT;
      else process.env.RN_SPM_RN_ROOT = saved;
    }
  });

  it("E3 refuses to download without RN_SPM_RN_ROOT", async () => {
    const saved = process.env.RN_SPM_RN_ROOT;
    const savedExit = process.exitCode;
    delete process.env.RN_SPM_RN_ROOT;
    try {
      await expect(downloader().main(["--version", "0.86.3", "--output", mkTmp("vendor-e3-")])).rejects.toThrow(
        /RN_SPM_RN_ROOT is not set/,
      );
    } finally {
      if (saved !== undefined) process.env.RN_SPM_RN_ROOT = saved;
      process.exitCode = savedExit;
    }
  });

  it("E4 keeps a pre-headers-spec slot only when asked", () => {
    const slot = mkTmp("vendor-e4-");
    const entries = () => ({
      React: { xcframeworkPath: path.join(slot, "React.xcframework"), url: "u" },
      ReactNativeDependencies: { xcframeworkPath: path.join(slot, "ReactNativeDependencies.xcframework"), url: "u" },
    });
    const kept = entries();
    downloader().addHeadersCompanions(kept, slot, true);
    expect(Object.keys(kept).sort()).toEqual(["React", "ReactNativeDependencies"]);

    const savedExit = process.exitCode;
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => downloader().addHeadersCompanions(entries(), slot, false)).toThrow(
        /ReactNativeHeaders\.xcframework is missing from the artifact slot/,
      );
    } finally {
      console.error = spy;
      process.exitCode = savedExit;
    }
  });
});
