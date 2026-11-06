/**
 * The podspec reader sweep (`tests/podspecReaderSweep.test.ts`): each library of `tests/podspec-sweep.json` installed
 * in a temp project from its pinned tarball, every podspec of it read with Ruby (the shim) and with the reduced reader,
 * and what was read against a reviewed golden in `tests/fixtures/podspec-sweep`. `RN_XTOOL_SWEEP_WRITE=1` writes the
 * goldens instead. The temp root is written as `<project>`, so a golden holds no machine's path.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, vi } from "vitest";
import { podspecResources } from "../../src/pipeline/scaffoldResources.js";
import { podDependencies, podspecFiles, podspecLines, unconditionalLineIndexes } from "../../src/project/podspecs.js";
import { packageRoot } from "../../src/tools/exec.js";
import { VENDORED_RN_SPM } from "./rnScaffold.js";
import { needsTarball, tarballPath } from "./tarballs.js";
import { tool } from "./tools.js";

const ROOT = packageRoot();
export const SWEEP_GOLDENS = path.join(ROOT, "tests", "fixtures", "podspec-sweep");

/** An entry of `tests/podspec-sweep.json`: a library, the React Native it is read against, and the packages it needs. */
export type SweepEntry = { spec: string; rn: string; with?: string[] };
export const SWEEP = JSON.parse(readFileSync(path.join(ROOT, "tests", "podspec-sweep.json"), "utf8")) as SweepEntry[];

const req = createRequire(path.join(VENDORED_RN_SPM, "read-podspec.js"));
const { readPodspec, runPodspecShim, unresolvedSourcesReason } = req("./read-podspec.js");
const { defaultReadPodspec } = req("./expand-spm-dependencies.js");

const WRITE = process.env.RN_XTOOL_SWEEP_WRITE === "1";
/** Fields that name the reader rather than what it read: they differ by definition. */
const READER_FIELDS = new Set(["reader", "partial"]);

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf("@"));
const versionOf = (spec: string) => spec.slice(spec.lastIndexOf("@") + 1);
const tarballsOf = (entry: SweepEntry) => [entry.spec, entry.rn, ...(entry.with ?? [])];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `spec`'s tarball extracted into `dir` (only `members` of it when given). */
function extract(spec: string, dir: string, members: string[] = []): void {
  const file = tarballPath(spec);
  if (file === undefined) throw new Error(`${spec}: not cached or not pinned in tests/tarballs.json${needsTarball(spec)}`);
  mkdirSync(dir, { recursive: true });
  const r = tool("tar", ["-xzf", file, "-C", dir, "--strip-components=1", ...members.map((m) => `package/${m}`)]);
  if (r.status !== 0) throw new Error(`tar failed for ${spec}: ${r.stderr}`);
}

const projects = new Map<string, { root: string; podspecs: string[] }>();
/**
 * The entry's project, made once per run: a temp `<root>` with `package.json` and `ios/`, the library and each `with`
 * package in `<root>/node_modules/<name>`, and React Native's `package.json` and `scripts/` in
 * `<root>/node_modules/react-native`. `podspecs` are the library's podspec files that exist, relative to it.
 */
export function sweepProject(entry: SweepEntry): { root: string; podspecs: string[] } {
  let project = projects.get(entry.spec);
  if (project) return project;
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rn-xtool-sweep-")));
  tmp.push(root);
  const modules = path.join(root, "node_modules");
  for (const spec of [entry.spec, ...(entry.with ?? [])]) extract(spec, path.join(modules, nameOf(spec)));
  extract(entry.rn, path.join(modules, "react-native"), ["package.json", "scripts"]);
  mkdirSync(path.join(root, "ios"));
  const dependencies = Object.fromEntries(tarballsOf(entry).map((spec) => [nameOf(spec), versionOf(spec)]));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "sweep-app", version: "1.0.0", dependencies }));
  const lib = path.join(modules, nameOf(entry.spec));
  const podspecs = podspecFiles(lib).filter((f) => existsSync(f)).map((f) => path.relative(lib, f));
  projects.set(entry.spec, (project = { root, podspecs }));
  return project;
}

/** The entry's golden folder, and a podspec's golden file in it. */
const goldenDir = (entry: SweepEntry) => path.join(SWEEP_GOLDENS, entry.spec.replaceAll("/", "+"));
const goldenFile = (entry: SweepEntry, podspec: string) => path.join(goldenDir(entry), `${podspec.replaceAll("/", "__")}.json`);
/** The podspecs the entry's goldens are for. */
function goldenPodspecs(entry: SweepEntry): string[] {
  if (!existsSync(goldenDir(entry))) return [];
  return readdirSync(goldenDir(entry))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length).replaceAll("__", "/"))
    .sort();
}

/** The entry's podspecs: its project's, or its goldens' when its tarballs are not here (its tests then skip or fail). */
export function podspecsOf(entry: SweepEntry): string[] {
  const here = tarballsOf(entry).every((spec) => needsTarball(spec) === "");
  return here ? sweepProject(entry).podspecs : goldenPodspecs(entry);
}

/** `value` with its object keys sorted, at every depth; arrays keep their order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
  );
}

/** Where two lists disagree: what only the TypeScript reader has, and what only the shim has, each sorted. */
function disagreement(ts: string[], shim: string[]): { onlyTs: string[]; onlyShim: string[] } {
  const only = (a: string[], b: string[]) => [...new Set(a.filter((x) => !b.includes(x)))].sort();
  return { onlyTs: only(ts, shim), onlyShim: only(shim, ts) };
}

/** `<key> => <glob>` for each glob of the `resource_bundles` hashes of the shim's spec and the subspecs it selects, for iOS. */
function shimBundles(raw: any): string[] {
  const subspecs: any[] = Array.isArray(raw.subspecs) ? raw.subspecs : [];
  const none = raw.default_subspecs === "none" || raw.default_subspec === "none";
  const wanted = Array.isArray(raw.default_subspecs) ? new Set(raw.default_subspecs) : undefined;
  const layers = [raw, ...(none ? [] : subspecs.filter((s) => wanted === undefined || wanted.has(s?.name)))];
  return layers.flatMap((layer) =>
    [layer?.resource_bundles, layer?.ios?.resource_bundles].flatMap((bundles) =>
      bundles !== null && typeof bundles === "object"
        ? Object.entries(bundles).flatMap(([key, globs]) => [globs].flat().map((glob) => `${key} => ${String(glob)}`))
        : [],
    ),
  );
}

/** The TypeScript readers' `resource_bundles`, as `<key> => <glob>`: those rn-xtool builds into the app. */
function tsBundles(text: string): string[] {
  return [...podspecResources(text).bundles].flatMap(([key, globs]) => globs.map((glob) => `${key} => ${glob}`));
}

/** The pod dependencies early checks read: on the podspec's unconditional lines. */
function tsDependencies(text: string): string[] {
  const lines = podspecLines(text);
  return podDependencies(unconditionalLineIndexes(text).map((i) => lines[i]!)).map((d) => d.name);
}

type Names = { name: string | null; moduleName: string | null; headerDir: string | null } | null;
/** The names `defaultReadPodspec` gives the library under the reader in effect, or the error it threw. */
function names(lib: string, podspec: string): Names | { error: string } {
  try {
    const n = defaultReadPodspec(lib, podspec);
    return n == null ? null : { name: n.name ?? null, moduleName: n.moduleName ?? null, headerDir: n.headerDir ?? null };
  } catch (e) {
    return { error: message(e) };
  }
}

/** What one read of a podspec gives: its model or error, its names. */
function readWith(reader: "ruby" | "reduced", lib: string, podspec: string): { model?: any; error?: string; names: unknown } {
  vi.stubEnv("RN_XTOOL_PODSPEC_READER", reader === "reduced" ? "reduced" : undefined);
  try {
    return { model: readPodspec(podspec), names: names(lib, podspec) };
  } catch (e) {
    return { error: message(e), names: names(lib, podspec) };
  }
}

/** The reduced reader's read, beside the shim's: the fields that differ, its refusal or its error. */
function reducedAgainst(shim: { model?: any }, reduced: { model?: any; error?: string }, podspec: string): object {
  if (reduced.error !== undefined) return { error: reduced.error };
  const refused: string | null = unresolvedSourcesReason(podspec, reduced.model);
  if (refused != null) return { refused };
  const fields = new Set([...Object.keys(shim.model ?? {}), ...Object.keys(reduced.model)]);
  const differs = Object.fromEntries(
    [...fields]
      .filter((f) => !READER_FIELDS.has(f) && !isDeepStrictEqual(shim.model?.[f], reduced.model[f]))
      .map((f) => [f, reduced.model[f] ?? null]),
  );
  return { differs };
}

const records = new Map<string, unknown>();
/**
 * What the readers read of the entry's `podspec` (relative to the library), in the golden's shape, with the project's
 * root written as `<project>` and keys sorted: Ruby's model, where the reduced reader differs from it, both readers'
 * names, what the podspec used of its environment and of React Native's helpers, and where the TypeScript readers of
 * `src/` (early checks' dependency lines, the scaffold's resource bundles) disagree with the shim. Made once per run;
 * every environment stub is undone after it.
 */
export function record(entry: SweepEntry, podspec: string): unknown {
  const key = `${entry.spec}\0${podspec}`;
  if (records.has(key)) return records.get(key);
  const { root } = sweepProject(entry);
  const lib = path.join(root, "node_modules", nameOf(entry.spec));
  const file = path.join(lib, podspec);
  vi.stubEnv("RN_SPM_RN_ROOT", path.join(root, "node_modules", "react-native"));
  vi.stubEnv("RN_SPM_APP_IOS_DIR", path.join(root, "ios"));
  vi.stubEnv("RN_SPM_PODSPEC_READS", undefined);
  try {
    const shim = readWith("ruby", lib, file);
    const reduced = readWith("reduced", lib, file);
    const raw: any = shim.error === undefined ? runPodspecShim(file).raw : undefined;
    const text = readFileSync(file, "utf8");
    const used = (k: "env" | "helpers"): string[] => [...new Set<string>(raw?.__rn_xtool__?.[k] ?? [])].sort();
    const golden = {
      shim: shim.error === undefined ? shim.model : { error: shim.error },
      reduced: reducedAgainst(shim, reduced, file),
      names: { shim: shim.names, reduced: reduced.names },
      env: used("env"),
      helpers: used("helpers"),
      tsReaders:
        raw === undefined
          ? null
          : {
              dependencies: disagreement(tsDependencies(text), shim.model.dependencies),
              resourceBundles: disagreement(tsBundles(text), shimBundles(raw)),
            },
    };
    const value = JSON.parse(JSON.stringify(sorted(golden)).replaceAll(root, "<project>"));
    records.set(key, value);
    return value;
  } finally {
    vi.unstubAllEnvs();
  }
}

/** The podspec's golden; with `RN_XTOOL_SWEEP_WRITE=1`, its {@link record} written as the golden first. */
export function golden(entry: SweepEntry, podspec: string): unknown {
  const file = goldenFile(entry, podspec);
  if (WRITE) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record(entry, podspec), null, 2)}\n`);
  }
  if (!existsSync(file)) {
    throw new Error(`no golden at ${path.relative(ROOT, file)}; write it with RN_XTOOL_SWEEP_WRITE=1 and review it`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Each golden whose library's names differ between the readers, as `<spec> <podspec>: <shim> ≠ <reduced>`. */
export function nameDifferences(): string[] {
  return SWEEP.flatMap((entry) =>
    goldenPodspecs(entry).flatMap((podspec) => {
      const { names: n } = JSON.parse(readFileSync(goldenFile(entry, podspec), "utf8")) as { names: { shim: unknown; reduced: unknown } };
      return isDeepStrictEqual(n.shim, n.reduced) ? [] : [`${entry.spec} ${podspec}: ${JSON.stringify(n.shim)} ≠ ${JSON.stringify(n.reduced)}`];
    }),
  );
}

/**
 * What the goldens folder holds that no sweep entry's podspec owns (a folder of no entry, a golden of no podspec), and
 * each podspec without a golden, by path under `tests/fixtures/podspec-sweep`. An entry whose tarballs are not here is
 * checked for its folder only.
 */
export function orphanGoldens(): string[] {
  const dirs = new Set(SWEEP.map((entry) => path.basename(goldenDir(entry))));
  const found = existsSync(SWEEP_GOLDENS) ? readdirSync(SWEEP_GOLDENS).sort() : [];
  const strays = found.filter((d) => !dirs.has(d)).map((d) => `${d}/ (no entry)`);
  return [
    ...strays,
    ...SWEEP.flatMap((entry) => {
      const podspecs = podspecsOf(entry);
      const goldens = goldenPodspecs(entry);
      const rel = (p: string) => path.relative(SWEEP_GOLDENS, goldenFile(entry, p));
      return [
        ...goldens.filter((p) => !podspecs.includes(p)).map((p) => `${rel(p)} (no podspec)`),
        ...podspecs.filter((p) => !goldens.includes(p)).map((p) => `${rel(p)} (no golden)`),
      ];
    }),
  ];
}
