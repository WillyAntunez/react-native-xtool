import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VENDORED_RN_SPM } from "./support/rnScaffold.js";
import { SHIM, needsRuby, tempDir } from "./support/ruby.js";
import { tool } from "./support/tools.js";

// How the vendored scaffolder (vendor/rn-spm/spm/read-podspec.js) picks its podspec reader and runs the Ruby shim.
// The reader's choice runs fake `ruby` scripts (a temp `bin` alone on `PATH`) and needs no Ruby; the shim's runs need
// the real one.
const req = createRequire(path.join(VENDORED_RN_SPM, "read-podspec.js"));
const readPodspecJs = req("./read-podspec.js");
const { podspecReader, runPodspecShim, isPodspecReadError, installationRootFor } = readPodspecJs;
const { readPodspec, readPodspecCached, unresolvedSourcesReason } = readPodspecJs;
const REMEDY =
  "Set RN_XTOOL_PODSPEC_READER=reduced to read it with the reduced reader for one run, and report it with rn-xtool doctor --report.";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A temp `bin` folder holding a `ruby` that runs `body` with sh: a `PATH` of its own. */
function fakeRuby(body: string): string {
  const bin = path.join(tempDir(), "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ruby"), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, "ruby"), 0o755);
  return bin;
}
const usableRuby = () => fakeRuby(`echo '{"ruby":"3.3.8","floor":"2.7.0","usable":true}'`);

/** `files` (paths relative to it) written into a temp library folder, and the path of its `Foo.podspec`. */
function library(podspec: string, files: Record<string, string> = {}): string {
  const lib = path.join(tempDir(), "lib");
  mkdirSync(lib);
  for (const [file, text] of Object.entries({ "Foo.podspec": podspec, ...files })) {
    mkdirSync(path.dirname(path.join(lib, file)), { recursive: true });
    writeFileSync(path.join(lib, file), text);
  }
  return path.join(lib, "Foo.podspec");
}
const spec = (...lines: string[]) => ["Pod::Spec.new do |s|", ' s.name = "Foo"', ...lines, "end"].join("\n");

/** The error `fn` throws. */
function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

/** The error message the shim itself writes for `podspec`, run as rn-xtool runs it. */
function shimMessage(podspec: string): string {
  const out = path.join(tempDir(), "out.json");
  tool("ruby", [SHIM, podspec, out, path.dirname(podspec)], {
    cwd: path.dirname(podspec),
    env: { PATH: process.env.PATH, RCT_NEW_ARCH_ENABLED: "1", RCT_HERMES_V1_ENABLED: "1" },
  });
  return JSON.parse(readFileSync(out, "utf8")).error.message;
}

describe("the podspec reader's choice", () => {
  it("reads with the reduced reader when Ruby is not found", () => {
    const emptyBin = path.join(tempDir(), "bin");
    mkdirSync(emptyBin);
    expect(podspecReader({ env: { PATH: emptyBin } })).toEqual({ reader: "reduced", why: "Ruby was not found", forced: false, warning: null });
  });

  it("says why a Ruby is unusable", () => {
    const old = fakeRuby(`echo '{"ruby":"2.5.1","floor":"2.7.0","usable":false,"why":"ruby 2.5.1 is older than 2.7.0"}'`);
    expect(podspecReader({ env: { PATH: old } })).toEqual({ reader: "reduced", why: "ruby 2.5.1 is older than 2.7.0", forced: false, warning: null });
    const noJson = fakeRuby(`echo "cannot load such file -- json" >&2; exit 1`);
    expect(podspecReader({ env: { PATH: noJson } })).toEqual({ reader: "reduced", why: "ruby cannot load json", forced: false, warning: null });
    const broken = fakeRuby(`echo "syntax error, unexpected" >&2; exit 1`);
    expect(podspecReader({ env: { PATH: broken } })).toEqual({
      reader: "reduced",
      why: "ruby could not run the podspec reader (syntax error, unexpected)",
      forced: false,
      warning: null,
    });
  });

  it("reads with Ruby when the probe says it is usable", () => {
    expect(podspecReader({ env: { PATH: usableRuby() } })).toEqual({ reader: "ruby", ruby: "3.3.8", forced: false, warning: null });
  });

  it("is forced to the reduced reader by RN_XTOOL_PODSPEC_READER=reduced", () => {
    expect(podspecReader({ env: { PATH: usableRuby(), RN_XTOOL_PODSPEC_READER: "reduced" } })).toEqual({
      reader: "reduced",
      why: "RN_XTOOL_PODSPEC_READER=reduced is set",
      forced: true,
      warning: null,
    });
  });

  it("names an unknown RN_XTOOL_PODSPEC_READER value", () => {
    expect(podspecReader({ env: { PATH: usableRuby(), RN_XTOOL_PODSPEC_READER: "REDUCED" } })).toEqual({
      reader: "ruby",
      ruby: "3.3.8",
      forced: false,
      warning: "RN_XTOOL_PODSPEC_READER=REDUCED is not a reader rn-xtool knows (only reduced); reading podspecs with Ruby",
    });
  });

  it("reads the variable on every call", () => {
    const bin = usableRuby();
    expect(podspecReader({ env: { PATH: bin } }).reader).toBe("ruby");
    expect(podspecReader({ env: { PATH: bin, RN_XTOOL_PODSPEC_READER: "reduced" } }).reader).toBe("reduced");
    vi.stubEnv("PATH", bin);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", "reduced");
    expect(podspecReader().forced).toBe(true);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    expect(podspecReader().reader).toBe("ruby");
  });

  it("says when the shim is missing", () => {
    const none = path.join(tempDir(), "none.rb");
    expect(podspecReader({ env: { PATH: usableRuby() }, shim: none })).toEqual({
      reader: "reduced",
      why: `the podspec reader's Ruby shim is missing from ${none}`,
      forced: false,
      warning: null,
    });
  });

  it("probes Ruby once per PATH", () => {
    const counter = path.join(tempDir(), "probes");
    const bin = fakeRuby(`echo probe >> '${counter}'\necho '{"ruby":"3.3.8","floor":"2.7.0","usable":true}'`);
    for (let i = 0; i < 3; i++) expect(podspecReader({ env: { PATH: bin } }).reader).toBe("ruby");
    expect(readFileSync(counter, "utf8")).toBe("probe\n");
    const other = fakeRuby(`echo probe >> '${counter}'\necho '{"ruby":"3.3.8","floor":"2.7.0","usable":true}'`);
    podspecReader({ env: { PATH: other } });
    expect(readFileSync(counter, "utf8")).toBe("probe\nprobe\n");
  });
});

describe("the podspec's installation root", () => {
  it("finds the installation root", () => {
    vi.stubEnv("RN_SPM_APP_IOS_DIR", "/a/ios");
    expect(installationRootFor("/p/node_modules/@s/x/X.podspec")).toBe("/a/ios");
    vi.stubEnv("RN_SPM_APP_IOS_DIR", undefined);
    expect(installationRootFor("/p/node_modules/@s/x/X.podspec")).toBe("/p/ios");
    expect(installationRootFor("/p/node_modules/expo/node_modules/y/ios/Y.podspec")).toBe("/p/ios");
    expect(installationRootFor("/q/X.podspec")).toBe("/q");
  });
});

describe("running the podspec shim without Ruby", () => {
  it("says that ruby could not run", () => {
    const podspec = library(spec());
    const emptyBin = path.join(tempDir(), "bin");
    mkdirSync(emptyBin);
    vi.stubEnv("PATH", emptyBin);
    const e = thrown(() => runPodspecShim(podspec));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("exit");
    expect(e.message).toBe(`${podspec}: ruby could not run (spawnSync ruby ENOENT)`);
  });
});

describe.skipIf(needsRuby !== "")(`running the podspec shim${needsRuby}`, () => {
  it("reads a podspec with Ruby", () => {
    const podspec = library(spec(' puts "hello from the podspec"', ' s.version = "1.2.3"'));
    const { raw, output } = runPodspecShim(podspec);
    expect(raw).toMatchObject({ name: "Foo", version: "1.2.3" });
    expect(output).toBe("hello from the podspec\n");
  });

  it("runs the podspec with a fixed environment", () => {
    vi.stubEnv("RUBYOPT", "-rnonexistent");
    vi.stubEnv("BUNDLE_GEMFILE", "/x");
    vi.stubEnv("GEM_HOME", "/y");
    vi.stubEnv("RCT_NEW_ARCH_ENABLED", "0");
    const podspec = library(spec(" s.summary = [ENV['RUBYOPT'], ENV['GEM_HOME'], ENV['RCT_NEW_ARCH_ENABLED']].inspect"));
    expect(runPodspecShim(podspec).raw.summary).toBe('[nil, nil, "1"]');
  });

  it("runs the podspec in its folder", () => {
    const podspec = library(spec(' s.summary = File.read("./flags.json").strip'), { "flags.json": '{"fabric":true}\n' });
    expect(runPodspecShim(podspec).raw.summary).toBe('{"fabric":true}');
  });

  it("gives the podspec an empty stdin", () => {
    const podspec = library(spec(" s.summary = $stdin.read.to_s.length.to_s"));
    const start = Date.now();
    expect(runPodspecShim(podspec).raw.summary).toBe("0");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("stops a podspec that does not finish", () => {
    const podspec = library(spec(" sleep 5"));
    const e = thrown(() => runPodspecShim(podspec, { timeoutMs: 1000 }));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.code).toBe("RN_SPM_PODSPEC_READ");
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe(`${podspec} did not finish in 1 s. ${REMEDY}`);
  });

  it("ends a shim gap with how to go on", () => {
    const gap = library(spec(' s.source_files = sources_for("ios")'));
    const e = thrown(() => runPodspecShim(gap));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("method");
    expect(e.message).toBe(`${shimMessage(gap)} ${REMEDY}`);
    const raised = library(spec(' raise "the podspec stops here"'));
    const r = thrown(() => runPodspecShim(raised));
    expect(r.kind).toBe("raised");
    expect(r.message).toBe(shimMessage(raised));
  });

  it("says how ruby ended when the shim wrote nothing", () => {
    const podspec = library(spec(" exit! 3"));
    const e = thrown(() => runPodspecShim(podspec));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.message).toBe(`${podspec}: ruby exited with 3`);
  });

  it("removes its temp out folder", () => {
    const [ok, raised, slow] = [library(spec()), library(spec(' raise "no"')), library(spec(" sleep 5"))];
    const tmp = tempDir();
    vi.stubEnv("TMPDIR", tmp);
    runPodspecShim(ok);
    thrown(() => runPodspecShim(raised));
    thrown(() => runPodspecShim(slow, { timeoutMs: 500 }));
    expect(tool("ls", ["-A", tmp]).stdout).toBe("");
  });

  it("reads a library reached through a symlink", () => {
    const proj = tempDir();
    const elsewhere = path.join(tempDir(), "lib");
    mkdirSync(path.join(elsewhere, "scripts"), { recursive: true });
    writeFileSync(path.join(elsewhere, "scripts", "v.rb"), 'LIB_FROM_SCRIPTS = "from scripts/v.rb"\n');
    writeFileSync(path.join(elsewhere, "package.json"), '{"version":"4.5.6"}\n');
    writeFileSync(
      path.join(elsewhere, "Lib.podspec"),
      [
        'require_relative "scripts/v"',
        'package = JSON.parse(File.read(File.join(__dir__, "package.json")))',
        "Pod::Spec.new do |s|",
        ' s.name = "Lib"',
        ' s.version = package["version"]',
        " s.summary = LIB_FROM_SCRIPTS",
        " s.description = Pod::Config.instance.installation_root.to_s",
        "end",
      ].join("\n"),
    );
    mkdirSync(path.join(proj, "node_modules"));
    symlinkSync(elsewhere, path.join(proj, "node_modules", "lib"));
    vi.stubEnv("RN_SPM_APP_IOS_DIR", undefined);
    const podspec = path.join(proj, "node_modules", "lib", "Lib.podspec");
    expect(installationRootFor(podspec)).toBe(path.join(proj, "ios"));
    const { raw } = runPodspecShim(podspec);
    expect(raw).toMatchObject({ name: "Lib", version: "4.5.6", summary: "from scripts/v.rb", description: path.join(proj, "ios") });
    expect(existsSync(path.join(proj, "ios"))).toBe(false);
  });
});

describe.skipIf(needsRuby !== "")(`readPodspec${needsRuby}`, () => {
  const INSTALL_RUBY =
    "Install Ruby (sudo apt install ruby) so rn-xtool reads the podspec as CocoaPods does, or give the library a Package.swift of its own.";
  beforeEach(() => {
    const rn = tempDir();
    writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
    vi.stubEnv("RN_SPM_RN_ROOT", rn);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    vi.stubEnv("RN_SPM_PODSPEC_READS", undefined);
  });
  const forceReduced = () => vi.stubEnv("RN_XTOOL_PODSPEC_READER", "reduced");

  it("reads with Ruby and says so", () => {
    const podspec = library(spec(' s.version = "1.0.0"', ' s.source_files = "ios/**/*.{h,m}"'));
    expect(readPodspec(podspec)).toMatchObject({
      reader: "ruby",
      partial: false,
      name: "Foo",
      version: "1.0.0",
      sourceFiles: ["ios/**/*.{h,m}"],
    });
  });

  it("never falls back after a shim failure", () => {
    const podspec = library(spec(' s.source_files = sources_for("ios")'));
    const e = thrown(() => readPodspec(podspec));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("method");
  });

  it("reads with the reduced reader when forced", () => {
    forceReduced();
    expect(readPodspec(library(spec()))).toMatchObject({ reader: "reduced", partial: true, name: "Foo" });
  });

  it("keeps the literal identity fields", () => {
    const podspec = library(
      [
        "package = JSON.parse(File.read(File.join(__dir__, 'package.json')))",
        "Pod::Spec.new do |s|",
        " s.name = package['name']",
        " s.version = package['version']",
        ' s.module_name = "Foo"',
        "end",
      ].join("\n"),
      { "package.json": JSON.stringify({ name: "react-native-foo", version: "1.2.3" }) },
    );
    expect(readPodspec(podspec)).toMatchObject({ reader: "ruby", name: "", version: "", moduleName: "Foo" });
    forceReduced();
    expect(readPodspec(podspec)).toMatchObject({ reader: "reduced", name: "", version: "", moduleName: "Foo" });
  });

  it("marks React core from the helper actually called", () => {
    expect(readPodspec(library(spec(" install_modules_dependencies(s)"))).usesInstallModulesDependencies).toBe(true);
    const notCalled = library(spec(" install_modules_dependencies(s) if false"));
    expect(readPodspec(notCalled).usesInstallModulesDependencies).toBe(false);
    forceReduced();
    expect(readPodspec(notCalled).usesInstallModulesDependencies).toBe(true);
  });

  it("caches per reader", () => {
    const podspec = library(spec());
    const ruby = readPodspecCached(podspec);
    expect(readPodspecCached(podspec)).toBe(ruby);
    forceReduced();
    const reduced = readPodspecCached(podspec);
    expect(reduced).not.toBe(ruby);
    expect([ruby.reader, reduced.reader]).toEqual(["ruby", "reduced"]);
  });

  it("never runs pod", () => {
    const marker = path.join(tempDir(), "pod-ran");
    const bin = path.join(tempDir(), "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pod"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(path.join(bin, "pod"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    const podspec = library(spec());
    expect(readPodspec(podspec).reader).toBe("ruby");
    readPodspecCached(podspec);
    forceReduced();
    readPodspec(podspec);
    expect(existsSync(marker)).toBe(false);
    expect(readPodspecJs).not.toHaveProperty("runPodIpcSpec");
  });

  it("appends each read to RN_SPM_PODSPEC_READS", () => {
    const reads = path.join(tempDir(), "reads.jsonl");
    vi.stubEnv("RN_SPM_PODSPEC_READS", reads);
    const lines = () => {
      const text = readFileSync(reads, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    };
    const ruby = podspecReader().ruby;
    const ok = library(spec(" s.summary = ENV['RCT_NEW_ARCH_ENABLED']", " install_modules_dependencies(s)"));
    readPodspecCached(ok);
    const okLine = {
      podspec: ok,
      reader: "ruby",
      forced: false,
      ruby,
      env: ["RCT_NEW_ARCH_ENABLED"],
      helpers: ["install_modules_dependencies"],
      ok: true,
    };
    expect(lines()).toEqual([okLine]);
    const bad = library(spec(' s.source_files = sources_for("ios")'));
    const e = thrown(() => readPodspecCached(bad));
    readPodspecCached(ok);
    expect(lines()).toEqual([
      okLine,
      { podspec: bad, reader: "ruby", forced: false, ruby, env: [], helpers: [], ok: false, error: e.message },
    ]);
  });

  it("tells a refused glob to install Ruby", () => {
    forceReduced();
    const podspec = library(spec(' s.source_files = sources_for("ios")'));
    const reason: string = unresolvedSourcesReason(podspec, readPodspec(podspec));
    expect(reason.slice(-INSTALL_RUBY.length - 1)).toBe(` ${INSTALL_RUBY}`);
  });
});
