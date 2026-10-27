import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";

const DRIVER = path.resolve(import.meta.dirname, "../scripts/rn-spm-generate.js");
const USAGE =
  "Usage: node scripts/rn-spm-generate.js --rn-dir <abs> --app-root <abs> --scripts-root <abs> [--artifacts <root>] [--config-command <json>] [--scaffold]";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function driver(args: string[], cwd = process.cwd()) {
  return execa(process.execPath, [DRIVER, ...args], { cwd, reject: false, all: true });
}

/**
 * A fake react-native package: each stubbed RN module appends `[name, ...args]` to calls.json,
 * so the test sees which RN functions the driver calls, in what order, with what arguments.
 * `FAIL_AT` makes one of them throw (`sync-missing` throws RN's MissingManifestError).
 */
function fakeRn(vendored = false): { rnDir: string; appRoot: string; scriptsRoot: string; calls: () => unknown[][] } {
  const root = mkdtempSync(path.join(tmpdir(), "rn-spm-generate-"));
  tmp.push(root);
  const rnDir = path.join(root, "node_modules", "react-native");
  const appRoot = path.join(root, "app");
  const scriptsRoot = vendored ? path.join(root, "vendored") : path.join(rnDir, "scripts");
  mkdirSync(path.join(scriptsRoot, "spm"), { recursive: true });
  mkdirSync(rnDir, { recursive: true });
  mkdirSync(path.join(appRoot, "ios"), { recursive: true });
  const log = path.join(root, "calls.json");
  const record = `
const fs = require('node:fs');
function record(...entry) {
  const log = ${JSON.stringify(log)};
  const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
  calls.push(entry);
  fs.writeFileSync(log, JSON.stringify(calls));
  if (process.env.FAIL_AT === entry[0]) throw new Error(entry[0] + ' exploded');
}
`;
  const stubs: Record<string, string> = {
    "setup-apple-spm.js": `
module.exports = {
  resolveAppIosDeploymentTarget(args, appRoot) { record('deploymentTarget', args.xcodeprojPath, args.productName, appRoot); return '15.1'; },
  determineVersion(args, rnRoot, appRoot) { fs.writeFileSync(${JSON.stringify(log)} + '.env', String(process.env.RN_SPM_RN_ROOT)); record('determineVersion', args.version, rnRoot, appRoot); return '0.88.0'; },
  async ensureBothArtifactFlavors(args, version) {
    record('ensureBothArtifactFlavors', args.version, args.artifacts, args.downloadPolicy, version);
    return args.artifacts ? {debug: args.artifacts + '/debug', release: args.artifacts + '/release'} : {debug: '/cache/debug', release: '/cache/release'};
  },
  main() { record('setup-apple-spm main'); },
};`,
    "spm/generate-spm-autolinking-config.js": `
module.exports = {
  parseConfigCommandJson(raw, label) { return JSON.parse(raw); },
  generateAutolinkingConfig(opts) {
    record('generateAutolinkingConfig', opts.projectRoot, opts.configCommand ?? null);
    return {outputPath: opts.projectRoot + '/ios/build/generated/autolinking/autolinking.json', config: {}, rawJson: '{}'};
  },
};`,
    "spm/scaffold-package-swift.js": `
module.exports = {
  refreshScaffoldedPlatformFloors(opts) { record('refreshScaffoldedPlatformFloors', opts.appRoot, opts.autolinkingJsonPath, opts.iosDeploymentTarget); return []; },
  scaffoldAll(opts) {
    record('scaffoldAll', opts);
    return [
      {depName: 'lib-a', status: 'written', warnings: ['check the header paths']},
      {depName: 'lib-b', status: 'error', reason: 'no podspec readable'},
      {depName: 'lib-c', status: 'already-set'},
    ];
  },
};`,
    "spm/download-spm-artifacts.js": `
module.exports = {
  async resolveCacheSlotVersion(version) { record('resolveCacheSlotVersion', version); return version + '-slot'; },
};`,
    "spm/generate-spm-autolinking.js": `
class MissingManifestError extends Error {
  constructor() { super('1 autolinked native module(s) have no Package.swift.'); this.name = 'MissingManifestError'; }
}
module.exports = {MissingManifestError};`,
    "spm/sync-spm-autolinking.js": `
const {MissingManifestError} = require('./generate-spm-autolinking');
module.exports = {
  async main(argv) {
    record('sync', ...argv);
    if (process.env.FAIL_AT === 'sync-missing') {
      console.error('error: Package.swift is missing for library "lib-a" — it ships no Swift Package Manager support.');
      throw new MissingManifestError();
    }
  },
};`,
    "spm/generate-spm-package.js": `
module.exports = { main(argv) { record('generatePackage', ...argv); } };`,
    "spm/flavored-frameworks.js": `
module.exports = { finalizeArtifactPublication(appRoot) { record('finalizeArtifactPublication', appRoot); return true; } };`,
  };
  for (const [rel, body] of Object.entries(stubs))
    writeFileSync(path.join(scriptsRoot, rel), `'use strict';\n${record}\n${body}\n`);
  return {
    rnDir,
    appRoot,
    scriptsRoot,
    calls: () => JSON.parse(readFileSync(log, "utf8")) as unknown[][],
  };
}

describe("rn-spm-generate.js", () => {
  it("the driver script parses its arguments", async () => {
    for (const args of [
      ["--help"],
      [],
      ["--rn-dir", "/rn"],
      ["--rn-dir", "relative/rn", "--app-root", "/app"],
      ["--rn-dir", "/rn", "--app-root", "/app"],
      ["--rn-dir", "/rn", "--app-root", "/app", "--scripts-root", "scripts"],
      ["--rn-dir", "/rn", "--app-root", "/app", "--scripts-root", "/s", "--bogus"],
      ["--rn-dir", "/rn", "--app-root", "/app", "--scripts-root", "/s", "extra"],
      ["--rn-dir", "/rn", "--app-root", "/app", "--scripts-root", "/s", "--scaffold=yes"],
    ]) {
      const r = await driver(args);
      expect(r.exitCode, args.join(" ")).toBe(1);
      expect(r.stderr.trim()).toBe(USAGE);
    }
  });

  it("runs RN's steps 1-5 against <app-root>/ios and never the xcodeproj injection", async () => {
    const rn = fakeRn();
    const ios = path.join(rn.appRoot, "ios");
    const r = await driver(["--rn-dir", rn.rnDir, "--scripts-root", rn.scriptsRoot, "--app-root", rn.appRoot], ios);
    expect(r.exitCode, r.all).toBe(0);
    const json = path.join(ios, "build/generated/autolinking/autolinking.json");
    expect(rn.calls()).toEqual([
      ["generateAutolinkingConfig", rn.appRoot, null],
      ["deploymentTarget", null, null, ios],
      ["determineVersion", null, rn.rnDir, ios],
      ["refreshScaffoldedPlatformFloors", ios, json, "15.1"],
      ["sync", "--app-root", ios, "--react-native-root", rn.rnDir, "--ios-deployment-target", "15.1"],
      ["ensureBothArtifactFlavors", null, null, "auto", "0.88.0"],
      [
        "generatePackage",
        "--app-root",
        ios,
        "--react-native-root",
        rn.rnDir,
        "--version",
        "0.88.0",
        "--debug-artifacts-dir",
        "/cache/debug",
        "--release-artifacts-dir",
        "/cache/release",
      ],
      ["finalizeArtifactPublication", ios],
    ]);
  });

  it("loads RN's modules from --scripts-root", async () => {
    const rn = fakeRn(true);
    const ios = path.join(rn.appRoot, "ios");
    const r = await driver(["--rn-dir", rn.rnDir, "--app-root", rn.appRoot, "--scripts-root", rn.scriptsRoot], ios);
    expect(r.exitCode, r.all).toBe(0);
    expect(rn.calls().map((c) => c[0])).toEqual([
      "generateAutolinkingConfig",
      "deploymentTarget",
      "determineVersion",
      "refreshScaffoldedPlatformFloors",
      "sync",
      "ensureBothArtifactFlavors",
      "generatePackage",
      "finalizeArtifactPublication",
    ]);
    expect(rn.calls()[2]).toEqual(["determineVersion", null, rn.rnDir, ios]);
  });

  it("exports RN_SPM_RN_ROOT to the scripts", async () => {
    const rn = fakeRn(true);
    const r = await driver(["--rn-dir", rn.rnDir, "--app-root", rn.appRoot, "--scripts-root", rn.scriptsRoot]);
    expect(r.exitCode, r.all).toBe(0);
    expect(readFileSync(path.join(rn.appRoot, "..", "calls.json.env"), "utf8")).toBe(rn.rnDir);
  });

  it("uses an offline artifact root without downloading, and forwards the config command", async () => {
    const rn = fakeRn();
    const cmd = ["npx", "react-native", "config"];
    const r = await driver([
      "--rn-dir",
      rn.rnDir,
      "--scripts-root",
      rn.scriptsRoot,
      "--app-root",
      rn.appRoot,
      "--artifacts",
      "/art",
      "--config-command",
      JSON.stringify(cmd),
    ]);
    expect(r.exitCode, r.all).toBe(0);
    const calls = rn.calls();
    expect(calls[0]).toEqual(["generateAutolinkingConfig", rn.appRoot, cmd]);
    expect(calls.find((c) => c[0] === "ensureBothArtifactFlavors")).toEqual([
      "ensureBothArtifactFlavors",
      null,
      "/art",
      "skip",
      "0.88.0",
    ]);
    expect(calls.find((c) => c[0] === "generatePackage")!.slice(-4)).toEqual([
      "--debug-artifacts-dir",
      "/art/debug",
      "--release-artifacts-dir",
      "/art/release",
    ]);
  });

  it("exits 2 with RN's missing-manifest lines when the autolinker reports them", async () => {
    const rn = fakeRn();
    const r = await execa(
      process.execPath,
      [DRIVER, "--rn-dir", rn.rnDir, "--scripts-root", rn.scriptsRoot, "--app-root", rn.appRoot],
      { reject: false, all: true, env: { FAIL_AT: "sync-missing" } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.all).toContain('error: Package.swift is missing for library "lib-a"');
    expect(rn.calls().map((c) => c[0])).not.toContain("ensureBothArtifactFlavors");
  });

  it("--scaffold writes RN's scaffolded manifests and runs no other pipeline step", async () => {
    const rn = fakeRn();
    const ios = path.join(rn.appRoot, "ios");
    const r = await driver(["--rn-dir", rn.rnDir, "--scripts-root", rn.scriptsRoot, "--app-root", rn.appRoot, "--scaffold"]);
    expect(r.exitCode, r.all).toBe(0);
    expect(rn.calls()).toEqual([
      ["generateAutolinkingConfig", rn.appRoot, null],
      ["deploymentTarget", null, null, ios],
      ["determineVersion", null, rn.rnDir, ios],
      ["resolveCacheSlotVersion", "0.88.0"],
      [
        "scaffoldAll",
        {
          appRoot: ios,
          projectRoot: rn.appRoot,
          reactNativeRoot: rn.rnDir,
          autolinkingJsonPath: path.join(ios, "build/generated/autolinking/autolinking.json"),
          cacheSlotLabel: "0.88.0-slot/dual-flavor",
          iosDeploymentTarget: "15.1",
          force: true,
        },
      ],
    ]);
    expect(r.stdout).toContain("Scaffolded Package.swift for 1 dep(s):");
    expect(r.stdout).toContain("  • lib-a");
    expect(r.stdout).toContain("  ! lib-a: check the header paths");
    expect(r.stderr).toContain("  ! lib-b: no podspec readable");
    expect(r.all).not.toContain("lib-c");
  });

  it("--scaffold still scaffolds without a cache slot label, and exits 1 when scaffolding throws", async () => {
    const rn = fakeRn();
    const run = (FAIL_AT: string) =>
      execa(process.execPath, [DRIVER, "--rn-dir", rn.rnDir, "--scripts-root", rn.scriptsRoot, "--app-root", rn.appRoot, "--scaffold"], {
        reject: false,
        all: true,
        env: { FAIL_AT },
      });
    const noSlot = await run("resolveCacheSlotVersion");
    expect(noSlot.exitCode, noSlot.all).toBe(0);
    const scaffold = rn.calls().find((c) => c[0] === "scaffoldAll")![1] as { cacheSlotLabel: unknown };
    expect(scaffold.cacheSlotLabel).toBeNull();
    const failed = await run("scaffoldAll");
    expect(failed.exitCode).toBe(1);
    expect(failed.all).toContain("scaffoldAll exploded");
  });

  it.each(["generateAutolinkingConfig", "sync", "ensureBothArtifactFlavors", "generatePackage"])(
    "exits 1 naming the error when %s fails",
    async (step) => {
      const rn = fakeRn();
      const r = await execa(
        process.execPath,
        [DRIVER, "--rn-dir", rn.rnDir, "--scripts-root", rn.scriptsRoot, "--app-root", rn.appRoot],
        { reject: false, all: true, env: { FAIL_AT: step } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.all).toContain(`${step} exploded`);
      expect(rn.calls().map((c) => c[0])).not.toContain("finalizeArtifactPublication");
    },
  );
});
