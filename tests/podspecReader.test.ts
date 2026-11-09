import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { podspecReaderHere } from "../src/tools/podspecReader.js";
import { PODSPEC_FIXTURES, VENDORED_RN_SPM, installedCopy, podspecCopy } from "./support/rnScaffold.js";
import { SHIM, needsRuby, tempDir } from "./support/ruby.js";
import { needsTarball, packageFromTarball } from "./support/tarballs.js";
import { tool } from "./support/tools.js";

// How the vendored scaffolder (vendor/rn-spm/spm/read-podspec.js) picks its podspec reader and runs the Ruby shim.
// The reader's choice runs fake `ruby` scripts (a temp `bin` alone on `PATH`) and needs no Ruby; the shim's runs need
// the real one.
const req = createRequire(path.join(VENDORED_RN_SPM, "read-podspec.js"));
const readPodspecJs = req("./read-podspec.js");
const { podspecReader, runPodspecShim, isPodspecReadError, installationRootFor } = readPodspecJs;
const { readPodspec, readPodspecCached, unresolvedSourcesReason } = readPodspecJs;
const { flattenSubspecs, findPodspecs, spmDependencyReason, PODSPEC_TIMEOUT_MS } = readPodspecJs;
const { scaffoldPackageSwiftForDep } = req("./scaffold-package-swift.js");
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

  it("keeps the interpreter the probe names", () => {
    const bin = fakeRuby(`echo '{"ruby":"9.9.9","floor":"2.7.0","usable":true,"interpreter":"/opt/rubies/9.9.9/bin/ruby"}'`);
    expect(podspecReader({ env: { PATH: bin } })).toEqual({
      reader: "ruby",
      ruby: "9.9.9",
      interpreter: "/opt/rubies/9.9.9/bin/ruby",
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

describe("the interpreter a read runs", () => {
  it("runs the podspec with the interpreter the probe named, not the ruby on PATH", () => {
    const rn = tempDir();
    writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
    vi.stubEnv("RN_SPM_RN_ROOT", rn);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    vi.stubEnv("RN_SPM_PODSPEC_READS", undefined);
    // The interpreter: writes a model to <out.json> ($3).
    const real = path.join(tempDir(), "ruby-9.9.9");
    writeFileSync(real, `#!/bin/sh\necho '{"name":"Foo","source_files":"pinned/**/*.m"}' > "$3"\n`);
    chmodSync(real, 0o755);
    // The `ruby` on PATH: answers the probe with that interpreter, and fails any read it is given.
    const bin = fakeRuby(
      `if [ "$2" = --probe ]; then echo '{"ruby":"9.9.9","floor":"2.7.0","usable":true,"interpreter":"${real}"}'; ` +
        `else echo "the ruby on PATH ran the podspec" >&2; exit 7; fi`,
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    expect(readPodspec(library(spec())).sourceFiles).toEqual(["pinned/**/*.m"]);
  });
});

describe("the reader's own failures", () => {
  it("stop the read as a PodspecReadError and are recorded", () => {
    const rn = tempDir();
    writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
    vi.stubEnv("RN_SPM_RN_ROOT", rn);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    const reads = path.join(tempDir(), "reads.jsonl");
    vi.stubEnv("RN_SPM_PODSPEC_READS", reads);
    vi.stubEnv("PATH", fakeRuby(`echo '{"ruby":"9.9.9","floor":"2.7.0","usable":true}'`));
    const podspec = library(spec());
    // No temp folder for the shim's out file.
    const gone = path.join(tempDir(), "gone");
    vi.stubEnv("TMPDIR", gone);
    const e = thrown(() => readPodspec(podspec));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("exit");
    expect(e.message.startsWith(`${podspec}: rn-xtool could not run the podspec reader: ENOENT`)).toBe(true);
    expect(e.message).toContain(gone);
    expect(e.message.endsWith(`. ${REMEDY}`)).toBe(true);
    const line = JSON.parse(readFileSync(reads, "utf8").trim().split("\n").pop()!);
    expect(line).toMatchObject({ podspec, reader: "ruby", ok: false, error: e.message });
  });
});

describe("the reduced reader's own failures", () => {
  it("stop the read without the escape's advice", () => {
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", "reduced");
    vi.stubEnv("RN_SPM_PODSPEC_READS", undefined);
    const podspec = library(spec());
    chmodSync(podspec, 0o000);
    const e = thrown(() => readPodspec(podspec));
    chmodSync(podspec, 0o644);
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("exit");
    expect(e.message).toBe(`${podspec}: rn-xtool could not run the podspec reader: EACCES: permission denied, open '${podspec}'`);
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
    expect(e.message).toBe(`${podspec}: ruby could not run (spawnSync ruby ENOENT). ${REMEDY}`);
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

  it("gives a podspec 120 s by default", () => {
    // skia's podspec copies its prebuilt frameworks (hundreds of MB) while it is read: a slow disk needs the time.
    expect(PODSPEC_TIMEOUT_MS).toBe(120_000);
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
    expect(e.message).toBe(`${shimMessage(gap)}. ${REMEDY}`);
    const raised = library(spec(' raise "the podspec stops here"'));
    const r = thrown(() => runPodspecShim(raised));
    expect(r.kind).toBe("raised");
    expect(r.message).toBe(shimMessage(raised));
  });

  it("ends a missing ENV.fetch name with how to go on", () => {
    const fetch = library(spec(' s.summary = ENV.fetch("RN_XTOOL_TEST_UNSET")'));
    const e = thrown(() => runPodspecShim(fetch));
    expect(e.kind).toBe("raised");
    expect(shimMessage(fetch)).toBe(`${fetch}:3: key not found: "RN_XTOOL_TEST_UNSET"`);
    expect(e.message).toBe(`${shimMessage(fetch)}. ${REMEDY}`);
    // The podspec's own message that merely mentions it keeps Ruby's message.
    const own = library(spec(' raise "the build says key not found: \\"X\\""'));
    expect(thrown(() => runPodspecShim(own)).message).toBe(shimMessage(own));
  });

  it("says how ruby ended when the shim wrote nothing", () => {
    const podspec = library(spec(" exit! 3"));
    const e = thrown(() => runPodspecShim(podspec));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.message).toBe(`${podspec}: ruby exited with 3. ${REMEDY}`);
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

  it("pins the Ruby this machine's probe finds", () => {
    const choice = podspecReader({ env: { PATH: process.env.PATH } });
    expect(choice.reader).toBe("ruby");
    expect(path.isAbsolute(choice.interpreter)).toBe(true);
    accessSync(choice.interpreter, constants.X_OK);
  });

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

describe("flattenSubspecs on the shim's model", () => {
  const SVG = "react-native-svg@15.16.0";
  const unapplied = (key: string) => `The podspec sets ${key}, which a CocoaPods build applies and rn-xtool's scaffold does not.`;
  beforeEach(() => {
    const rn = tempDir();
    writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
    vi.stubEnv("RN_SPM_RN_ROOT", rn);
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    vi.stubEnv("RN_SPM_APP_IOS_DIR", undefined);
  });
  const withReader = <T>(reader: "ruby" | "reduced", read: () => T): T => {
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", reader === "reduced" ? "reduced" : undefined);
    return read();
  };
  /** The library in `root` scaffolded as rn-xtool's driver does, its app's `ios/` beside its `node_modules`. */
  function scaffold(root: string): { status: string; reason?: string; packageSwift?: string } {
    const base = path.resolve(root, "..", "..");
    vi.stubEnv("RN_SPM_RN_ROOT", path.join(base, "node_modules", "react-native"));
    const podspec = findPodspecs(root)[0];
    const dep = { name: path.basename(root), root, swiftName: "Lib", swiftNameSource: "podspec", platforms: { ios: { podspecPath: podspec } } };
    const ctx = {
      appRoot: path.join(base, "ios"),
      projectRoot: base,
      reactNativeRoot: path.join(base, "node_modules", "react-native"),
      force: true,
      dryRun: false,
      cacheSlotLabel: null,
      remote: null,
    };
    const r = scaffoldPackageSwiftForDep(dep, ctx);
    const pkg = path.join(root, "Package.swift");
    return existsSync(pkg) ? { ...r, packageSwift: readFileSync(pkg, "utf8").split(base).join("<tmp>") } : r;
  }

  it("merges ios attributes over each layer", () => {
    const m = flattenSubspecs({
      name: "Foo",
      source_files: "a/**/*.m",
      exclude_files: "x",
      ios: { exclude_files: "**/*.macos.m" },
      osx: { exclude_files: "**/*.ios.m" },
      pod_target_xcconfig: { OTHER_CFLAGS: "-DA" },
      subspecs: [{ name: "c", ios: { pod_target_xcconfig: { OTHER_CFLAGS: "-DB" } } }],
    });
    expect(m.excludeFiles).toEqual(["x", "**/*.macos.m"]);
    expect(m.preprocessorDefines.map((d: { name: string }) => d.name)).toEqual(["A", "B"]);
  });

  it("merges a hash key by key and lets ios win other values", () => {
    const m = flattenSubspecs({
      name: "Foo",
      header_dir: "generic",
      requires_arc: false,
      frameworks: "UIKit",
      pod_target_xcconfig: { OTHER_CFLAGS: "-DA", GCC_PREPROCESSOR_DEFINITIONS: ["KEPT=1"] },
      ios: {
        header_dir: "iosdir",
        requires_arc: true,
        frameworks: ["WebKit"],
        pod_target_xcconfig: { OTHER_CFLAGS: "-DB", GCC_PREPROCESSOR_DEFINITIONS: "IOS=1" },
      },
      tvos: { frameworks: "TVUIKit" },
      visionos: { frameworks: "RealityKit" },
      watchos: { frameworks: "WatchKit" },
    });
    expect(m.headerDir).toBe("iosdir");
    expect(m.requiresArc).toBe(true);
    expect(m.frameworks).toEqual(["UIKit", "WebKit"]);
    expect(m.preprocessorDefines.map((d: { name: string }) => d.name)).toEqual(["A", "B", "KEPT", "IOS"]);
  });

  it("merges a subspec's ios dependencies into its own", () => {
    const m = flattenSubspecs({
      name: "Foo",
      subspecs: [{ name: "c", dependencies: { A: [] }, ios: { dependencies: { B: [">= 1"] } }, osx: { dependencies: { C: [] } } }],
    });
    expect(m.dependencies).toEqual(["A", "B"]);
    expect(m.subspecDependencies).toEqual({ c: ["A", "B"] });
  });

  it("warns about keys the scaffold does not apply", () => {
    const m = flattenSubspecs({
      name: "Foo",
      script_phases: [{ name: "Codegen", script: "echo" }],
      ios: { info_plist: { NSCameraUsageDescription: "camera" } },
      osx: { module_map: "mac.modulemap" },
    });
    expect(m.warnings).toEqual([unapplied("script_phases"), unapplied("info_plist")]);
    expect(flattenSubspecs({ name: "Foo", prepare_command: "make", subspecs: [{ name: "c", module_map: "c.modulemap" }] }).warnings).toEqual([
      unapplied("prepare_command"),
      unapplied("module_map"),
    ]);
  });

  it.skipIf(needsRuby !== "")(`refuses a library that declares a SwiftPM dependency${needsRuby}`, () => {
    const model = flattenSubspecs({ name: "Foo", __rn_xtool__: { spm_dependencies: [{ url: "https://x/y", requirement: {}, products: ["Y"] }] } });
    expect(model.spmDependencies).toEqual([{ url: "https://x/y", products: ["Y"] }]);
    expect(flattenSubspecs({ name: "Foo" }).spmDependencies).toEqual([]);
    const root = installedCopy(
      path.dirname(
        library(
          spec(
            ' s.source_files = "ios/*.m"',
            ' spm_dependency(s, url: "https://x/y", requirement: {kind: "upToNextMajorVersion", minimumVersion: "1.0.0"}, products: ["Y"])',
          ),
          { "ios/Foo.m": "", "package.json": JSON.stringify({ name: "react-native-foo", version: "1.0.0" }) },
        ),
      ),
    );
    const podspec = path.join(root, "Foo.podspec");
    const reason = `${podspec}: uses spm_dependency(url: https://x/y, products: Y), which rn-xtool does not map yet`;
    expect(spmDependencyReason(podspec, readPodspec(podspec))).toBe(reason);
    expect(scaffold(root)).toEqual({ depName: "react-native-foo", status: "error", reason });
  });

  it.skipIf(needsRuby !== "" || needsTarball(SVG) !== "")(
    `reads react-native-svg 15.16.0's iOS excludes with Ruby${needsRuby}${needsTarball(SVG)}`,
    () => {
      const m = readPodspec(podspecCopy(path.join(packageFromTarball(SVG)!, "RNSVG.podspec")));
      expect(m.reader).toBe("ruby");
      expect(m.excludeFiles).toContain("**/*.macos.{h,m,mm}");
      expect(m.excludeFiles).not.toContain("**/*.ios.{h,m,mm}");
      expect(m.excludeFiles).not.toContain("apple/Utils/RNSVGFabricConversions.h");
    },
  );

  it.skipIf(needsRuby !== "")(`reads react-native-screens 4.24.0's locals with Ruby${needsRuby}`, () => {
    const m = readPodspec(podspecCopy(path.join(PODSPEC_FIXTURES, "RNScreens-4.24.0", "RNScreens.podspec")));
    expect(m.reader).toBe("ruby");
    expect(m.sourceFiles).toEqual(["ios/**/*.{h,m,mm,cpp,swift}", "common/cpp/**/*.{cpp,h}", "cpp/**/*.{cpp,h}"]);
    expect(m.excludeFiles).toEqual(["ios/gamma/**/*.{h,m,mm,cpp,swift}"]);
  });

  // The reduced reader cannot evaluate `defined?(install_modules_dependencies())`, so it reads both branches.
  it.skipIf(needsRuby !== "")(`scaffolds gesture-handler 2.32.0 the same with Ruby as with the reduced reader${needsRuby}`, () => {
    const fixture = path.join(PODSPEC_FIXTURES, "RNGestureHandler-2.32.0");
    const run = (reader: "ruby" | "reduced") =>
      withReader(reader, () => {
        const root = installedCopy(fixture);
        const model = readPodspec(path.join(root, "RNGestureHandler.podspec"));
        return { model, scaffolded: scaffold(root) };
      });
    const ruby = run("ruby");
    const reduced = run("reduced");
    expect([ruby.model.reader, reduced.model.reader]).toEqual(["ruby", "reduced"]);
    expect(ruby.model.sourceFiles).toEqual(["apple/**/*.{h,m,mm}"]);
    expect(reduced.model.sourceFiles).toEqual(ruby.model.sourceFiles);
    expect(ruby.model.dependencies).toEqual([]);
    expect(ruby.model.usesInstallModulesDependencies).toBe(true);
    expect(reduced.model.dependencies).toEqual(["React-Core"]);
    expect(ruby.scaffolded.status).toBe("written");
    expect(reduced.scaffolded.status).toBe("written");
    // The same manifest but for the marker's reader line (fix 29).
    expect(ruby.scaffolded.packageSwift).toMatch(/^\/\/ rn-xtool-podspec-reader: ruby$/m);
    expect(reduced.scaffolded.packageSwift).toMatch(/^\/\/ rn-xtool-podspec-reader: reduced$/m);
    const withoutReader = (pkg: string) => pkg.replace(/^\/\/ rn-xtool-podspec-reader: \w+\n/m, "");
    expect(withoutReader(reduced.scaffolded.packageSwift)).toBe(withoutReader(ruby.scaffolded.packageSwift));
  });

  it.skipIf(needsRuby !== "")(`drops a subspec on Ruby's model as on the reduced one${needsRuby}`, () => {
    // react-native-vision-camera 4.7.3's shape.
    const podspec = library(
      [
        "enableFrameProcessors = true",
        "if defined?($VCEnableFrameProcessors)",
        '  Pod::UI.puts "[VisionCamera] $VCEnableFrameProcessors is set to #{$VCEnableFrameProcessors}!"',
        "  enableFrameProcessors = $VCEnableFrameProcessors",
        "end",
        'Pod::UI.puts("[VisionCamera] VisionCamera_enableFrameProcessors is set to #{enableFrameProcessors}!")',
        "Pod::Spec.new do |s|",
        '  s.name = "VisionCamera"',
        "  s.subspec 'Core' do |core|",
        '    core.source_files = ["ios/Core/**/*.swift"]',
        "  end",
        "  s.subspec 'React' do |core|",
        '    core.source_files = ["ios/React/**/*.{h,m,swift}"]',
        '    core.dependency "React-Core"',
        "    if enableFrameProcessors",
        '      core.dependency "VisionCamera/FrameProcessors"',
        "    end",
        "  end",
        "  if enableFrameProcessors",
        "    s.subspec 'FrameProcessors' do |fp|",
        '      fp.source_files = ["ios/FrameProcessors/**/*.{h,m,mm}"]',
        '      fp.dependency "react-native-worklets-core"',
        "    end",
        "  end",
        "end",
      ].join("\n"),
    );
    for (const reader of ["ruby", "reduced"] as const) {
      const all = withReader(reader, () => readPodspec(podspec));
      expect(all.reader).toBe(reader);
      expect(all.sourceFiles).toContain("ios/FrameProcessors/**/*.{h,m,mm}");
      expect(all.dependencies).toContain("react-native-worklets-core");
      const m = withReader(reader, () => readPodspec(podspec, { dropSubspecs: ["FrameProcessors"] }));
      expect(m.sourceFiles, reader).toEqual(["ios/Core/**/*.swift", "ios/React/**/*.{h,m,swift}"]);
      expect(m.dependencies, reader).toEqual(["React-Core"]);
    }
  });
});

describe("reader failures propagate", () => {
  const { autolinkingDepToSpmTarget } = req("./generate-spm-autolinking.js");
  const { defaultReadPodspec, expandSpmDependencies } = req("./expand-spm-dependencies.js");
  beforeEach(() => {
    vi.stubEnv("RN_XTOOL_PODSPEC_READER", undefined);
    vi.stubEnv("RN_SPM_APP_IOS_DIR", undefined);
    vi.stubEnv("RN_SPM_PODSPEC_READS", undefined);
  });
  /**
   * An installed copy ({@link installedCopy}) of `react-native-foo`, whose `Foo.podspec` is `podspec` (a symlink to
   * nowhere when null), listed as autolinking.json lists it, with the autolinker's output folder beside its app's `ios/`.
   */
  function installedDep(podspec: string | null) {
    const src = path.dirname(library(spec(), { "package.json": JSON.stringify({ name: "react-native-foo", version: "1.0.0" }) }));
    const root = installedCopy(src);
    const podspecPath = path.join(root, "Foo.podspec");
    if (podspec == null) {
      rmSync(podspecPath);
      symlinkSync(path.join(root, "Missing.podspec"), podspecPath);
    } else writeFileSync(podspecPath, podspec);
    const base = path.resolve(root, "..", "..");
    vi.stubEnv("RN_SPM_RN_ROOT", path.join(base, "node_modules", "react-native"));
    const dep = { name: "react-native-foo", root, swiftName: "Foo", platforms: { ios: { podspecPath, sourceDir: root } } };
    return { root, podspecPath, dep, outputDir: path.join(base, "ios", "build", "generated", "autolinking") };
  }
  const expand = (dep: { name: string; root: string; platforms: object }, readPodspec: unknown) =>
    expandSpmDependencies([{ name: dep.name, root: dep.root, platforms: dep.platforms }], {
      readConfig: () => null,
      resolveDep: () => null,
      readSwiftpmConfig: () => null,
      readPodspec,
    });

  it.skipIf(needsRuby !== "")(`stops autolinking on a shim failure${needsRuby}`, () => {
    const { podspecPath, dep, outputDir } = installedDep(spec(' s.source_files = sources_for("ios")'));
    const e = thrown(() => autolinkingDepToSpmTarget(dep.name, dep, outputDir, new Map()));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.kind).toBe("method");
    expect(e.message.startsWith(`${podspecPath}:`)).toBe(true);
  });

  it.skipIf(needsRuby !== "")(`stops name resolution on a shim failure${needsRuby}`, () => {
    const { root, podspecPath, dep } = installedDep(["Pod::Spec.new do |s|", " s.name = compute_name()", "end"].join("\n"));
    const e = thrown(() => defaultReadPodspec(root, podspecPath));
    expect(isPodspecReadError(e)).toBe(true);
    expect(e.message.startsWith(`${podspecPath}:`)).toBe(true);
    expect(thrown(() => defaultReadPodspec(root, undefined)).message).toBe(e.message);
    expect(thrown(() => expand(dep, defaultReadPodspec)).message).toBe(e.message);
  });

  it("names a library after its npm package when its podspec computes the name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dep = { name: "react-native-foo", root: tempDir(), platforms: { ios: {} } };
      const computed = () => ({ name: "#{package['name']}", moduleName: null, headerDir: null });
      expect(expand(dep, computed)[0]).toMatchObject({ swiftName: "ReactNativeFoo", swiftNameSource: "npm" });
      const said = warn.mock.calls.map((c) => String(c[0]).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
      expect(said).toContain(
        "'react-native-foo' ships a podspec whose name is computed in Ruby, which rn-xtool does not use for names, " +
          "so it is named 'ReactNativeFoo' after its npm package instead. Set 'swiftpmConfig.name' in its package.json to override.",
      );
      expect(said).not.toMatch(/CocoaPods|different name/);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the old answer for an unreadable file", () => {
    const { root, podspecPath, dep, outputDir } = installedDep(null);
    expect(defaultReadPodspec(root, podspecPath)).toBeNull();
    expect(defaultReadPodspec(root, undefined)).toBeNull();
    expect(autolinkingDepToSpmTarget(dep.name, dep, outputDir, new Map())).toMatchObject({ name: "Foo", headerSearchPaths: undefined });
    const unreadable = () => {
      throw new Error(`readPodspec: file does not exist: ${podspecPath}`);
    };
    expect(expand(dep, unreadable)[0]).toMatchObject({ swiftNameSource: "npm" });
  });
});

describe("the podspec reader rn-xtool reports", () => {
  it("doctor and the scaffolder pick the same reader", () => {
    const forced = { ...process.env, RN_XTOOL_PODSPEC_READER: "reduced" };
    expect(podspecReaderHere(forced)).toEqual(podspecReader({ env: forced }));
    const withFake = { PATH: usableRuby() };
    expect(podspecReaderHere(withFake)).toEqual(podspecReader({ env: withFake }));
    expect(podspecReaderHere(withFake)).toEqual({ reader: "ruby", ruby: "3.3.8", forced: false, warning: null });
  });
});
