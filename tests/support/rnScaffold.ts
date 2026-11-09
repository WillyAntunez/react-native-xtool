/**
 * Runs React Native's SwiftPM scaffolder (`scripts/spm/scaffold-package-swift.js`, whichever copy a
 * test loads) over real libraries, the way rn-xtool's driver does (`scaffoldAll`, a cache slot label;
 * forced by default, so every copy is scaffolded afresh), and collects what it wrote.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { packageRoot } from "../../src/tools/exec.js";

const ROOT = packageRoot();
export const VENDORED_RN_SPM = path.join(ROOT, "vendor", "rn-spm", "spm");
export const SCAFFOLD_GOLDEN = path.join(ROOT, "tests", "fixtures", "scaffold-golden");
export const PODSPEC_FIXTURES = path.join(ROOT, "tests", "fixtures", "podspecs");
/** The pristine React Native that `vendor/rn-spm` derives from, and its npm integrity. */
export const RN_TARBALL = path.join(ROOT, "tests", ".cache", "react-native-0.88.0.tgz");
export const RN_INTEGRITY =
  "sha512-v/wee0nYWcammMYBnSat/e3WY/5iaf9YQOMcBrfKT/wPApPPlHp94hgZovBtwhMuthR01yc/8cGn0FpFTE/C4A==";

/**
 * The app whose installed {@link GOLDEN_LIBS} the scaffold golden reads: `RN_XTOOL_REF_APP` in `env`, else
 * `../app-golden` beside the repo, a reference app that holds exactly those libraries at the golden's versions.
 */
export function goldenApp(env: NodeJS.ProcessEnv = process.env): string {
  return env["RN_XTOOL_REF_APP"] ?? path.resolve(ROOT, "..", "app-golden");
}

/** The libraries whose scaffolds the reference app persists in `patches/`. */
export const GOLDEN_LIBS = [
  "react-native-screens",
  "react-native-pager-view",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "react-native-worklets",
  "react-native-svg",
  "react-native-webview",
  "@react-native-community/datetimepicker",
];

const SCAFFOLDER_MARKER = "AUTO-SCAFFOLDED by react-native spm scaffold";
/** What the scaffolder writes into a library besides a marked Package.swift. */
const SCAFFOLD_OUTPUTS = ["Package@swift-6.5.swift", "react-native-spm-prefix.h", "include", "rn-spm-swift", "rn-spm-react-headers", "rn-spm-pod-headers"];
/** Not native code: left out of the copies to keep them small. */
const NOT_COPIED = new Set(["android", "node_modules", "lib", "src", "windows"]);

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmp.push(d);
  return d;
}

export type ScaffoldResult = { depName: string; status: string; reason?: string; warnings?: string[]; reader?: string };
type ScaffoldAll = { scaffoldAll(o: object): ScaffoldResult[] };

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : e.isFile() ? [path.join(rel, e.name)] : [],
  );
}

/** A React Native root the vendored scripts read the version macros from (edit E2). */
export function withRnRoot<T>(version: string, run: () => T): T {
  const rn = mkTmp("rn-scaffold-rn-");
  writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version }));
  const saved = process.env["RN_SPM_RN_ROOT"];
  process.env["RN_SPM_RN_ROOT"] = rn;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["RN_SPM_RN_ROOT"];
    else process.env["RN_SPM_RN_ROOT"] = saved;
  }
}

/**
 * An installed copy of the library in `src`, as an app's install lays it out: `<tmp>/node_modules/<its package name>`
 * (by value; only `files`, relative to `src`, when given), beside a `node_modules/react-native` of `rnVersion` and the
 * app's `ios/` folder. Reading a podspec runs it, and its Ruby helpers look React Native up from there. Its folder.
 */
export function installedCopy(src: string, { files, rnVersion = "0.86.3" }: { files?: string[]; rnVersion?: string } = {}): string {
  const base = mkTmp("rn-scaffold-installed-");
  const pkg = path.join(src, "package.json");
  const name = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name : undefined;
  const root = path.join(base, "node_modules", name ?? path.basename(src));
  mkdirSync(root, { recursive: true });
  for (const f of files ?? readdirSync(src)) {
    if (existsSync(path.join(src, f))) cpSync(path.join(src, f), path.join(root, f), { recursive: true, dereference: true });
  }
  mkdirSync(path.join(base, "node_modules", "react-native"));
  writeFileSync(path.join(base, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: rnVersion }));
  mkdirSync(path.join(base, "ios"));
  return root;
}

/**
 * An installed copy ({@link installedCopy}) of a library podspec, with what it reads (package.json, svg's scripts/):
 * reading a podspec runs it, and nothing it may write must land in the shared pristine tree. The copy's podspec.
 */
export function podspecCopy(file: string): string {
  const name = path.basename(file);
  return path.join(installedCopy(path.dirname(file), { files: [name, "package.json", "scripts"] }), name);
}

/**
 * Copies each library (`name` → its source dir) into a temp `node_modules`, drops the scaffolder's
 * earlier output (a persisted scaffold patch), runs `scaffoldAll` over them with `spmDir`, and
 * returns each library's status and every file the run created or changed, keyed
 * `<name>/<relative path>`, with the temp root replaced by `<tmp>`. The temp tree is an app's install: `<tmp>/app`
 * with its package.json and `ios/` (`RN_SPM_APP_IOS_DIR` for the run), beside a `node_modules/react-native` of 0.86.3,
 * so a podspec read by Ruby finds React Native and the app as in a project. The libraries in `noIos` are listed
 * without an iOS platform, as autolinking lists a package a config takes out of iOS. `options` are passed
 * to `scaffoldAll` over the defaults (`force: true` among them), and `rerun` runs it again on the same copies.
 */
export function scaffoldLibraries(
  spmDir: string,
  libs: Record<string, string>,
  { noIos = [], options = {} }: { noIos?: string[]; options?: Record<string, unknown> } = {},
): {
  statuses: Record<string, string>;
  results: ScaffoldResult[];
  files: Record<string, string>;
  roots: Record<string, string>;
  rerun: (options: Record<string, unknown>) => ScaffoldResult[];
} {
  const base = mkTmp("rn-scaffold-");
  const projectRoot = path.join(base, "app");
  const appRoot = path.join(projectRoot, "ios");
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  mkdirSync(path.join(base, "node_modules", "react-native"), { recursive: true });
  writeFileSync(path.join(base, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.86.3" }));
  const dependencies: Record<string, object> = {};
  const before = new Map<string, Buffer>();
  const roots: Record<string, string> = {};
  for (const [name, src] of Object.entries(libs)) {
    const root = path.join(base, "node_modules", name);
    roots[name] = root;
    // By value: a symlinked library (an RN_XTOOL_REF_APP replica's) would otherwise be copied as the link, and the
    // scaffolder would write into the library it points at.
    const real = realpathSync(src);
    cpSync(real, root, {
      recursive: true,
      dereference: true,
      filter: (f) => path.dirname(f) !== real || !NOT_COPIED.has(path.basename(f)),
    });
    const manifest = path.join(root, "Package.swift");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes(SCAFFOLDER_MARKER)) rmSync(manifest);
    for (const out of SCAFFOLD_OUTPUTS) rmSync(path.join(root, out), { recursive: true, force: true });
    // A clang-only target's module map, in its public headers directory.
    for (const f of listFiles(root).filter((f) => path.basename(f) === "module.modulemap")) {
      if (readFileSync(path.join(root, f), "utf8").includes(SCAFFOLDER_MARKER)) rmSync(path.join(root, f));
    }
    for (const f of listFiles(root)) before.set(path.join(name, f), readFileSync(path.join(root, f)));
    const podspec = readdirSync(root).find((f) => f.endsWith(".podspec"));
    const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
    dependencies[name] = {
      root,
      name,
      platforms: {
        ios: noIos.includes(name)
          ? null
          : { podspecPath: podspec ? path.join(root, podspec) : null, version, configurations: [], scriptPhases: [] },
      },
    };
  }
  const autolinkingJsonPath = path.join(appRoot, "build", "generated", "autolinking", "autolinking.json");
  mkdirSync(path.dirname(autolinkingJsonPath), { recursive: true });
  writeFileSync(autolinkingJsonPath, JSON.stringify({ root: projectRoot, dependencies }, null, 2));

  const { scaffoldAll } = createRequire(import.meta.url)(path.join(spmDir, "scaffold-package-swift.js")) as ScaffoldAll;
  const run = (over: Record<string, unknown>) => {
    const saved = process.env["RN_SPM_APP_IOS_DIR"];
    process.env["RN_SPM_APP_IOS_DIR"] = appRoot;
    try {
      return withRnRoot("0.86.3", () =>
        scaffoldAll({
          appRoot,
          projectRoot,
          reactNativeRoot: path.join(base, "node_modules", "react-native"),
          autolinkingJsonPath,
          iosDeploymentTarget: "16.4",
          cacheSlotLabel: "0.86.3/dual-flavor",
          force: true,
          ...over,
        }),
      );
    } finally {
      if (saved === undefined) delete process.env["RN_SPM_APP_IOS_DIR"];
      else process.env["RN_SPM_APP_IOS_DIR"] = saved;
    }
  };
  const results = run(options);

  const files: Record<string, string> = {};
  for (const [name, root] of Object.entries(roots)) {
    for (const f of listFiles(root)) {
      const key = path.join(name, f);
      const now = readFileSync(path.join(root, f));
      if (!before.get(key)?.equals(now)) files[key] = now.toString("utf8").split(base).join("<tmp>");
    }
  }
  const statuses = Object.fromEntries(results.map((r) => [r.depName, r.status]));
  return { statuses, results, files, roots, rerun: run };
}

/** The golden files written by {@link scaffoldLibraries} for {@link GOLDEN_LIBS}. */
export function readGolden(): { statuses: Record<string, string>; files: Record<string, string> } {
  const statuses = JSON.parse(readFileSync(path.join(SCAFFOLD_GOLDEN, "statuses.json"), "utf8")) as Record<string, string>;
  const files: Record<string, string> = {};
  for (const lib of GOLDEN_LIBS) {
    const dir = path.join(SCAFFOLD_GOLDEN, lib);
    if (!existsSync(dir)) continue;
    for (const f of listFiles(dir)) files[path.join(lib, f)] = readFileSync(path.join(dir, f), "utf8");
  }
  return { statuses, files };
}

/** Writes `golden` (a {@link scaffoldLibraries} run over {@link GOLDEN_LIBS}) as the golden files {@link readGolden} reads. */
export function writeGolden(golden: { statuses: Record<string, string>; files: Record<string, string> }): void {
  for (const lib of GOLDEN_LIBS) rmSync(path.join(SCAFFOLD_GOLDEN, lib), { recursive: true, force: true });
  mkdirSync(SCAFFOLD_GOLDEN, { recursive: true });
  writeFileSync(path.join(SCAFFOLD_GOLDEN, "statuses.json"), `${JSON.stringify(golden.statuses, null, 2)}\n`);
  for (const [key, text] of Object.entries(golden.files)) {
    const file = path.join(SCAFFOLD_GOLDEN, key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
