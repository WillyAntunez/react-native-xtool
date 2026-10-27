/**
 * Fixtures for Expo's SwiftPM plugin (`scripts/spm`), whichever copy a test exercises: the one
 * patched into the reference app, the vendored copy in `vendor/expo-spm/spm`, or the 58 copy
 * re-derived from the pristine tarball plus the shared patch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { packageRoot } from "../../src/tools/exec.js";

export type Sources = {
  hasSources: boolean;
  pureSwift: boolean;
  hasSwift: boolean;
  hasClang: boolean;
  hasCxx: boolean;
  ignoredDirs: string[];
  placeholderFiles: string[];
  vendorSources: string[];
  appleOnlyResources?: string[];
};
export type PodspecFacts = {
  linkage: object | null;
  declaresSourceFiles: boolean;
  referencesVendor: boolean;
  headerDir?: string | null;
  moduleName?: string | null;
  dependencies?: string[];
};
export type Classify = { scanAppleSources(root: string): Sources };
export type Podspec = {
  readPodspecFacts(o: { podName: string; podspecDir: string; moduleRoot: string }): PodspecFacts;
};
export type Refusal = { reason: string; [k: string]: unknown };
export type Plugin = {
  sourceLayout(i: { sources: Sources; podspec: PodspecFacts }): string | null;
  uncoveredPod(identity: object, ...refusals: Refusal[]): { refusals: Refusal[] };
  macroPluginFlags(coreModuleRoot: string): string[];
};
export type EmitContext = { frameworkSearchPath: string; outDir: string; macroFlags: string[] };
export type LocalDep = { podName: string; name: string; pkgDir: string; hasSwift: boolean };
export type Emit = (
  o: {
    moduleRoot: string;
    product: string;
    language?: string;
    sources: Sources;
    headerDir?: string | null;
    localDeps?: LocalDep[];
  },
  ctx: EmitContext,
) => { ok: { packageDep: { path: string } } };
export type Manifests = {
  emitPureSwiftSourcePackage: Emit;
  emitGeneratedSourcePackage: Emit;
  isCxxHeader(text: string): boolean;
};
export type Diagnostics = {
  classifyUnsupported(o: { pending: object[]; coreAvailable: boolean }): Refusal[];
  renderUnsupportedReport(entries: object[]): string;
  renderDroppedResourceWarning(entries: object[]): string;
};

const ROOT = packageRoot();
export const EXPO_TARBALL = path.join(ROOT, "tests", ".cache", "expo-58.0.19.tgz");
export const EXPO_INTEGRITY =
  "sha512-+MHH9Bu7OFWsAl8Ox44KgqbVIe72xbxzAi3vLPtVf14o5zHE39iCD//uw/4nyBlqZii6cFUZsvtJDbeRo5OhMA==";
export const EXPO_FETCH_CMD = "mkdir -p tests/.cache && npm pack expo@58.0.19 --pack-destination tests/.cache";
export const EXPO_SHARED_PATCH = path.join(ROOT, "patches", "expo+58.0.19.patch");

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
export function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmp.push(d);
  return d;
}

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;

/** `vendor/expo-spm/spm`: the copy rn-xtool runs for SDK 57. */
export function vendoredSpm(): string {
  return path.join(ROOT, "vendor", "expo-spm", "spm");
}

let shared58: string | null | undefined;
/**
 * Expo 58.0.19's `scripts/spm` with the shared patch applied (`patch -p4` in `package/scripts`),
 * extracted once per run from the pristine tarball; undefined without the tarball, `tar` or `patch`.
 */
export function shared58Spm(): string | undefined {
  if (shared58 === undefined) {
    shared58 = null;
    if (existsSync(EXPO_TARBALL) && has("tar") && has("patch")) {
      const dir = mkTmp("expo-58-spm-");
      const untar = spawnSync("tar", ["-xzf", EXPO_TARBALL, "-C", dir, "package/scripts/spm"], { encoding: "utf8" });
      if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
      const scripts = path.join(dir, "package", "scripts");
      const patched = spawnSync("patch", ["-p4", "-F0", "-d", scripts, "-i", EXPO_SHARED_PATCH], { encoding: "utf8" });
      if (patched.status !== 0) throw new Error(`patch failed: ${patched.stdout}${patched.stderr}`);
      // Its app-target.js loads @expo/config-plugins at require time, which the installed copy finds
      // in the app; here it finds rn-xtool's.
      symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
      shared58 = path.join(scripts, "spm");
    }
  }
  return shared58 ?? undefined;
}

const req = createRequire(import.meta.url);
/** One of the plugin's modules, from the given `scripts/spm` copy. */
export function loadSpm<T>(spm: string, file: string): T {
  return req(path.join(spm, file)) as T;
}

/** A module dir with the given files (relative path → contents); `ios/<pod>.podspec` included. */
export function moduleFixture(
  pod: string,
  files: Record<string, string>,
  podspecBody = `s.source_files = "**/*.{h,m,mm,swift}"`,
): string {
  const root = mkTmp("xtool-expo-spm-");
  writeFileSync(path.join(root, "package.json"), `{"name":"${pod.toLowerCase()}"}`);
  const all = { [`ios/${pod}.podspec`]: `Pod::Spec.new do |s|\n  s.name = '${pod}'\n  ${podspecBody}\nend\n`, ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** The plugin's view of a fixture module: scanned sources, podspec facts and the layout it picks. */
export function layoutOf(spm: string, pod: string, root: string) {
  const sources = loadSpm<Classify>(spm, "classify.js").scanAppleSources(root);
  const facts = loadSpm<Podspec>(spm, "podspec.js").readPodspecFacts({
    podName: pod,
    podspecDir: path.join(root, "ios"),
    moduleRoot: root,
  });
  return { sources, facts, layout: loadSpm<Plugin>(spm, "plugin.js").sourceLayout({ sources, podspec: facts }) };
}

/** Emits a fixture module's source package into a fresh output dir; returns its dir, a reader and its manifest. */
export function emit(
  spm: string,
  pod: string,
  root: string,
  language: string,
  sources: Sources,
  extra: { headerDir?: string | null; localDeps?: LocalDep[] } = {},
) {
  const manifests = loadSpm<Manifests>(spm, "manifests.js");
  const outDir = mkTmp("xtool-expo-out-");
  const ctx = { frameworkSearchPath: "/fw", outDir, macroFlags: [] };
  const fn = language === "pure-swift" ? manifests.emitPureSwiftSourcePackage : manifests.emitGeneratedSourcePackage;
  const dir = fn({ moduleRoot: root, product: pod, language, sources, ...extra }, ctx).ok.packageDep.path;
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  return { dir, read, manifest: read("Package.swift") };
}
