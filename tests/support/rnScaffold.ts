/**
 * Runs React Native's SwiftPM scaffolder (`scripts/spm/scaffold-package-swift.js`, whichever copy a
 * test loads) over real libraries, the way rn-xtool's driver does (`scaffoldAll`, `force`, a cache
 * slot label), and collects what it wrote.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { packageRoot } from "../../src/tools/exec.js";

const ROOT = packageRoot();
export const VENDORED_RN_SPM = path.join(ROOT, "vendor", "rn-spm", "spm");
export const SCAFFOLD_GOLDEN = path.join(ROOT, "tests", "fixtures", "scaffold-golden");
export const PODSPEC_FIXTURES = path.join(ROOT, "tests", "fixtures", "podspecs");

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
const SCAFFOLD_OUTPUTS = ["Package@swift-6.5.swift", "react-native-spm-prefix.h", "include", "rn-spm-swift", "rn-spm-react-headers"];
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

export type ScaffoldResult = { depName: string; status: string; reason?: string; warnings?: string[] };
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
 * Copies each library (`name` → its source dir) into a temp `node_modules`, drops the scaffolder's
 * earlier output (a persisted scaffold patch), runs `scaffoldAll` over them with `spmDir`, and
 * returns each library's status and every file the run created or changed, keyed
 * `<name>/<relative path>`, with the temp root replaced by `<tmp>`.
 */
export function scaffoldLibraries(
  spmDir: string,
  libs: Record<string, string>,
): { statuses: Record<string, string>; results: ScaffoldResult[]; files: Record<string, string>; roots: Record<string, string> } {
  const base = mkTmp("rn-scaffold-");
  const projectRoot = path.join(base, "app");
  const appRoot = path.join(projectRoot, "ios");
  const dependencies: Record<string, object> = {};
  const before = new Map<string, Buffer>();
  const roots: Record<string, string> = {};
  for (const [name, src] of Object.entries(libs)) {
    const root = path.join(base, "node_modules", name);
    roots[name] = root;
    cpSync(src, root, {
      recursive: true,
      filter: (f) => path.dirname(f) !== src || !NOT_COPIED.has(path.basename(f)),
    });
    const manifest = path.join(root, "Package.swift");
    if (existsSync(manifest) && readFileSync(manifest, "utf8").includes(SCAFFOLDER_MARKER)) rmSync(manifest);
    for (const out of SCAFFOLD_OUTPUTS) rmSync(path.join(root, out), { recursive: true, force: true });
    for (const f of listFiles(root)) before.set(path.join(name, f), readFileSync(path.join(root, f)));
    const podspec = readdirSync(root).find((f) => f.endsWith(".podspec"));
    const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
    dependencies[name] = {
      root,
      name,
      platforms: {
        ios: { podspecPath: podspec ? path.join(root, podspec) : null, version, configurations: [], scriptPhases: [] },
      },
    };
  }
  const autolinkingJsonPath = path.join(appRoot, "build", "generated", "autolinking", "autolinking.json");
  mkdirSync(path.dirname(autolinkingJsonPath), { recursive: true });
  writeFileSync(autolinkingJsonPath, JSON.stringify({ root: projectRoot, dependencies }, null, 2));

  const { scaffoldAll } = createRequire(import.meta.url)(path.join(spmDir, "scaffold-package-swift.js")) as ScaffoldAll;
  const results = withRnRoot("0.86.3", () =>
    scaffoldAll({
      appRoot,
      projectRoot,
      reactNativeRoot: path.join(base, "node_modules", "react-native"),
      autolinkingJsonPath,
      iosDeploymentTarget: "16.4",
      cacheSlotLabel: "0.86.3/dual-flavor",
      force: true,
    }),
  );

  const files: Record<string, string> = {};
  for (const [name, root] of Object.entries(roots)) {
    for (const f of listFiles(root)) {
      const key = path.join(name, f);
      const now = readFileSync(path.join(root, f));
      if (!before.get(key)?.equals(now)) files[key] = now.toString("utf8").split(base).join("<tmp>");
    }
  }
  const statuses = Object.fromEntries(results.map((r) => [r.depName, r.status]));
  return { statuses, results, files, roots };
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
