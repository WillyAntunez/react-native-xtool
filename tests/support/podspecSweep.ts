/**
 * The podspec reader sweep (`tests/podspecReaderSweep.test.ts`): each library of `tests/podspec-sweep.json` installed
 * in a temp project from its pinned tarball, every podspec of it read with Ruby (the shim) and with the reduced reader,
 * and what was read against a reviewed golden in `tests/fixtures/podspec-sweep`. `RN_XTOOL_SWEEP_WRITE=1` writes the
 * goldens instead. The temp root is written as `<project>`, so a golden holds no machine's path.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, vi } from "vitest";
import { podspecResources } from "../../src/pipeline/scaffoldResources.js";
import { podDependencies, podspecFiles, podspecLines, unconditionalLineIndexes } from "../../src/project/podspecs.js";
import { packageRoot } from "../../src/tools/exec.js";
import { VENDORED_RN_SPM } from "./rnScaffold.js";
import { needsRuby } from "./ruby.js";
import { isHeavy, needsTarball, tarballPath } from "./tarballs.js";
import { tool } from "./tools.js";

const ROOT = packageRoot();
export const SWEEP_GOLDENS = path.join(ROOT, "tests", "fixtures", "podspec-sweep");

/**
 * An entry of `tests/podspec-sweep.json`: a library, the React Native it is read against, and the packages it needs. A
 * library and a React Native together name the entry: the same library may be read against several React Natives.
 */
export type SweepEntry = { spec: string; rn: string; with?: string[] };
export const SWEEP = JSON.parse(readFileSync(path.join(ROOT, "tests", "podspec-sweep.json"), "utf8")) as SweepEntry[];

const req = createRequire(path.join(VENDORED_RN_SPM, "read-podspec.js"));
const { isPodspecReadError, readPodspec, runPodspecShim, unresolvedSourcesReason } = req("./read-podspec.js");
const { defaultReadPodspec } = req("./expand-spm-dependencies.js");

const WRITE = process.env.RN_XTOOL_SWEEP_WRITE === "1";
/**
 * The error kinds of a read that stopped on a gap of the shim, from read-podspec.js's text (`source`): its
 * `SHIM_GAP_KINDS`, read so the two never drift. Throws when the list is missing or parses empty, so that no
 * reformatting of it can turn the guard off.
 */
export function shimGapKinds(source: string): ReadonlySet<string> {
  const list = /const SHIM_GAP_KINDS = \[([^\]]*)\]/.exec(source)?.[1];
  if (list === undefined) throw new Error("vendor/rn-spm/spm/read-podspec.js: SHIM_GAP_KINDS not found");
  const set = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
  if (set.size === 0) throw new Error("vendor/rn-spm/spm/read-podspec.js: SHIM_GAP_KINDS parsed empty");
  return set;
}
/** The vendored read-podspec.js's gap kinds: such a read is modelled in the shim first, never written as a golden. */
const SHIM_GAP_KINDS = shimGapKinds(readFileSync(path.join(VENDORED_RN_SPM, "read-podspec.js"), "utf8"));
/** Fields that name the reader rather than what it read: they differ by definition. */
const READER_FIELDS = new Set(["reader", "partial"]);

const tmp: string[] = [];
// Tens of thousands of files: seconds alone, and past vitest's 10 s hook timeout beside the rest of the suite.
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
}, 120_000);

const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf("@"));
const versionOf = (spec: string) => spec.slice(spec.lastIndexOf("@") + 1);
const tarballsOf = (entry: SweepEntry) => [entry.spec, entry.rn, ...(entry.with ?? [])];
/** The entry's name in titles and messages: `<spec> on <rn>`. */
export const entryName = (entry: SweepEntry) => `${entry.spec} on ${entry.rn}`;
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
  let project = projects.get(entryName(entry));
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
  projects.set(entryName(entry), (project = { root, podspecs }));
  return project;
}

/**
 * The entry's golden folder, `<spec>@rn-<React Native's version>` with a scoped name's `/` as `+` (the last `@` starts
 * React Native's version), and a podspec's golden file in it.
 */
const goldenDir = (entry: SweepEntry) =>
  path.join(SWEEP_GOLDENS, `${entry.spec.replaceAll("/", "+")}@rn-${versionOf(entry.rn)}`);
const goldenFile = (entry: SweepEntry, podspec: string) => path.join(goldenDir(entry), `${podspec.replaceAll("/", "__")}.json`);
/** The podspecs the entry's goldens are for. */
function goldenPodspecs(entry: SweepEntry): string[] {
  if (!existsSync(goldenDir(entry))) return [];
  return readdirSync(goldenDir(entry))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length).replaceAll("__", "/"))
    .sort();
}

/**
 * The entry's podspecs: its project's, or its goldens' when its tarballs are not in `dir` (`tests/.cache` by default;
 * its tests then skip or fail).
 */
export function podspecsOf(entry: SweepEntry, dir?: string): string[] {
  const here = tarballsOf(entry).every((spec) => needsTarball(spec, dir) === "");
  return here ? sweepProject(entry).podspecs : goldenPodspecs(entry);
}

/**
 * `""` when the entry's podspecs can be read here, else a title suffix that says what they need. Off CI: each tarball
 * not in `dir` (`tests/.cache` by default), and Ruby. On CI (`ci`), which fetches every tarball but the heavy ones,
 * only a heavy tarball that is not there: anything else missing fails there instead.
 */
export function sweepSkipReason(entry: SweepEntry, ci = process.env.CI === "true", dir?: string): string {
  const needs = (specs: string[]) => specs.map((spec) => needsTarball(spec, dir)).join("");
  return ci ? needs(tarballsOf(entry).filter(isHeavy)) : needs(tarballsOf(entry)) + needsRuby;
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

type Read = { model?: any; error?: string; kind?: string | null; names: unknown };
/** What one read of a podspec gives: its model, or its error and the error's kind (`PodspecReadError`'s); its names. */
function readWith(reader: "ruby" | "reduced", lib: string, podspec: string): Read {
  vi.stubEnv("RN_XTOOL_PODSPEC_READER", reader === "reduced" ? "reduced" : undefined);
  try {
    return { model: readPodspec(podspec), names: names(lib, podspec) };
  } catch (e) {
    return { error: message(e), kind: isPodspecReadError(e) ? String((e as { kind: unknown }).kind) : null, names: names(lib, podspec) };
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
 * root written as `<project>`, rn-xtool's as `<repo>`, and keys sorted: Ruby's model, where the reduced reader differs from it, both readers'
 * names, what the podspec used of its environment and of React Native's helpers, and where the TypeScript readers of
 * `src/` (early checks' dependency lines, the scaffold's resource bundles) disagree with the shim. Made once per run;
 * every environment stub is undone after it.
 */
export function record(entry: SweepEntry, podspec: string): unknown {
  const key = `${entryName(entry)}\0${podspec}`;
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
      shim: shim.error === undefined ? shim.model : { error: shim.error, kind: shim.kind },
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
    const value = JSON.parse(JSON.stringify(sorted(golden)).replaceAll(root, "<project>").replaceAll(ROOT, "<repo>"));
    records.set(key, value);
    return value;
  } finally {
    vi.unstubAllEnvs();
  }
}

/**
 * A record's text as a golden file. Throws for a record that must not become one: a Ruby read that stopped on a gap of
 * the shim (modelled in the shim first), or text that holds an absolute path (a temp folder, rn-xtool's checkout or a
 * home folder).
 */
export function goldenText(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const shim = (value as { shim?: { error?: unknown; kind?: unknown } } | null)?.shim;
  if (typeof shim?.kind === "string" && SHIM_GAP_KINDS.has(shim.kind)) {
    throw new Error(`a gap of the shim (${shim.kind}): ${String(shim.error)}; model it in the shim before writing the golden`);
  }
  // The folder that holds the home folders, any user's.
  const homes = `${path.dirname(homedir())}${path.sep}`;
  const absolute = [tmpdir(), ROOT, homes].find((p) => text.includes(p));
  if (absolute !== undefined) throw new Error(`the golden would hold the absolute path ${absolute}; normalise it in record()`);
  return text;
}

/** The podspec's golden; with `RN_XTOOL_SWEEP_WRITE=1`, its {@link record} written as the golden first ({@link goldenText}). */
export function golden(entry: SweepEntry, podspec: string): unknown {
  const file = goldenFile(entry, podspec);
  if (WRITE) {
    const text = goldenText(record(entry, podspec));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  if (!existsSync(file)) {
    throw new Error(`no golden at ${path.relative(ROOT, file)}; write it with RN_XTOOL_SWEEP_WRITE=1 and review it`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Each golden whose library's names differ between the readers, as `<spec> on <rn> <podspec>: <shim> ≠ <reduced>`. */
export function nameDifferences(): string[] {
  return SWEEP.flatMap((entry) =>
    goldenPodspecs(entry).flatMap((podspec) => {
      const { names: n } = JSON.parse(readFileSync(goldenFile(entry, podspec), "utf8")) as { names: { shim: unknown; reduced: unknown } };
      return isDeepStrictEqual(n.shim, n.reduced) ? [] : [`${entryName(entry)} ${podspec}: ${JSON.stringify(n.shim)} ≠ ${JSON.stringify(n.reduced)}`];
    }),
  );
}

/**
 * What the goldens folder holds that no sweep entry's podspec owns (a folder of no entry, a golden of no podspec), each
 * entry without a goldens folder, and each podspec without a golden, by path under `tests/fixtures/podspec-sweep`. An
 * entry whose tarballs are not in `dir` (`tests/.cache` by default) is checked for its folder only, and on CI (`ci`),
 * which fetched every tarball but the heavy ones, it is listed with the others it needs.
 */
export function orphanGoldens(entries: readonly SweepEntry[] = SWEEP, ci = process.env.CI === "true", dir?: string): string[] {
  const dirs = new Set(entries.map((entry) => path.basename(goldenDir(entry))));
  const found = existsSync(SWEEP_GOLDENS) ? readdirSync(SWEEP_GOLDENS).sort() : [];
  const strays = found.filter((d) => !dirs.has(d)).map((d) => `${d}/ (no entry)`);
  return [
    ...strays,
    ...entries.flatMap((entry) => {
      const missing = tarballsOf(entry)
        .filter((spec) => !isHeavy(spec))
        .map((spec) => needsTarball(spec, dir))
        .join("");
      const needs = ci && missing !== "" ? [`${entryName(entry)}${missing}`] : [];
      if (!existsSync(goldenDir(entry))) return [`${path.basename(goldenDir(entry))}/ (no goldens)`, ...needs];
      const podspecs = podspecsOf(entry, dir);
      const goldens = goldenPodspecs(entry);
      const rel = (p: string) => path.relative(SWEEP_GOLDENS, goldenFile(entry, p));
      return [
        ...needs,
        ...goldens.filter((p) => !podspecs.includes(p)).map((p) => `${rel(p)} (no podspec)`),
        ...podspecs.filter((p) => !goldens.includes(p)).map((p) => `${rel(p)} (no golden)`),
      ];
    }),
  ];
}
