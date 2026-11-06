import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import { installedVersion, patchPackageScript } from "./patches.js";
import { createRequire } from "node:module";
import path from "node:path";
import { swiftHeadersEnv, type ProjectPaths } from "../paths.js";
import type { ProjectKind } from "../project/index.js";
import type { ExpoPlugin, RnScripts } from "../versions.js";
import { packageRoot, runArgv, toolEnv } from "../tools/exec.js";
import type { PodEntry } from "../config.js";
import { POD_TABLE_ENV, mergedPodTable, writePodTable, type PodBinary, type PodTable } from "../project/podTable.js";
import { readerLines, readPodspecReads } from "./podspecReads.js";

export const AUTOLINKING_CONFIG_COMMAND = [
  "npx",
  "expo-modules-autolinking",
  "react-native-config",
  "--json",
  "--platform",
  "ios",
];

/** The vendored scaffolder's resolution of RN's own config command: RCT_SPM_AUTOLINKING_CONFIG_COMMAND, else the CLI's. */
function rnConfigCommand(root: string): string[] {
  const file = path.join(vendoredScriptsRoot(), "spm", "generate-spm-autolinking-config.js");
  const { resolveConfigCommand } = createRequire(import.meta.url)(file) as { resolveConfigCommand: (root: string) => string[] };
  return resolveConfigCommand(root);
}

/**
 * The autolinking config command the SwiftPM steps get. Without `exclude`: Expo's for an Expo app, none for bare (RN
 * resolves its own, today's argv). With `exclude`: that command (on bare, the one RN would run) wrapped by
 * `scripts/exclude-config-command.js`, which sets `platforms.ios` to null for each listed package, as
 * react-native.config.js would, for rn-xtool's builds only.
 */
export function configCommandFor(root: string, kind: ProjectKind, exclude: readonly string[]): string[] | undefined {
  if (exclude.length === 0) return kind === "expo" ? AUTOLINKING_CONFIG_COMMAND : undefined;
  const inner = kind === "expo" ? AUTOLINKING_CONFIG_COMMAND : rnConfigCommand(root);
  return [
    process.execPath,
    path.join(packageRoot(), "scripts", "exclude-config-command.js"),
    "--exclude",
    JSON.stringify(exclude),
    "--",
    ...inner,
  ];
}

export function resolveRnDir(paths: ProjectPaths): string {
  const require = createRequire(import.meta.url);
  return path.dirname(
    require.resolve("react-native/package.json", { paths: [paths.root] }),
  );
}

/** RN writes `.spm-injected.json` inside `ios/<App>.xcodeproj/`; the bare `ios/` location is accepted too. */
function hasSpmMarker(iosDir: string): boolean {
  if (existsSync(path.join(iosDir, ".spm-injected.json"))) return true;
  try {
    return readdirSync(iosDir).some(
      (name) =>
        name.endsWith(".xcodeproj") &&
        existsSync(path.join(iosDir, name, ".spm-injected.json")),
    );
  } catch {
    return false;
  }
}

export function vendoredScriptsRoot(): string {
  return path.join(packageRoot(), "vendor", "rn-spm");
}

/** Expo 58's SwiftPM plugin, vendored for SDK 57 (whose `expo` ships none); E5 loads it as `expo`'s. */
export function vendoredExpoPlugin(): string {
  return path.join(packageRoot(), "vendor", "expo-spm", "spm", "plugin.js");
}

export function rnSpmArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string; exclude?: readonly string[] },
  rnDir: string = resolveRnDir(paths),
): string[] {
  const mode = hasSpmMarker(paths.ios) ? "update" : "add";
  return [
    path.join(rnDir, "scripts", "setup-apple-spm.js"),
    mode,
    "--config-command",
    JSON.stringify(configCommandFor(paths.root, "expo", opts.exclude ?? [])),
    // stdin is ignored by the runner, so prompts can never be answered: auto-accept them.
    "--yes",
    ...(opts.rnArtifactsDir
      ? ["--download", "skip", "--artifacts", opts.rnArtifactsDir]
      : []),
  ];
}

/**
 * Bare apps run RN's SwiftPM steps through our driver instead of `setup-apple-spm.js add|update`:
 * same codegen, autolinking and artifact steps, minus the injection into the user's xcodeproj
 * (which `add` refuses anyway on a CocoaPods-integrated pbxproj). Only `ios/build/` is written.
 * Expo SDK 57 (the vendored Expo plugin) runs the driver too, with Expo's autolinking config command.
 * Expo SDK 58 (kind "expo", the installed plugin) gets the same config command, for its scaffold step.
 * With the config's `exclude`, every kind gets its config command wrapped by the exclude filter (configCommandFor).
 */
export function rnSpmGenerateArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string; rnScripts: RnScripts; expoPlugin?: ExpoPlugin; kind?: ProjectKind; exclude?: readonly string[] },
  rnDir: string = resolveRnDir(paths),
): string[] {
  const expo = opts.expoPlugin === "vendored" || opts.kind === "expo";
  const configCommand = configCommandFor(paths.root, expo ? "expo" : "bare", opts.exclude ?? []);
  return [
    path.join(packageRoot(), "scripts", "rn-spm-generate.js"),
    "--rn-dir",
    rnDir,
    "--app-root",
    paths.root,
    "--scripts-root",
    opts.rnScripts === "vendored" ? vendoredScriptsRoot() : path.join(rnDir, "scripts"),
    ...(configCommand !== undefined ? ["--config-command", JSON.stringify(configCommand)] : []),
    ...(opts.expoPlugin === "vendored" ? ["--expo-plugin", vendoredExpoPlugin()] : []),
    ...(opts.rnArtifactsDir ? ["--artifacts", opts.rnArtifactsDir] : []),
  ];
}

/**
 * The driver's `scaffold` step alone, for the libraries React Native named and no other: RN's
 * `setup-apple-spm.js scaffold` would force every library's scaffold and go on to inject into the
 * xcodeproj. Every project kind scaffolds through the driver, Expo SDK 58 included.
 */
export function rnSpmScaffoldArgs(
  paths: ProjectPaths,
  opts: { rnArtifactsDir?: string; rnScripts: RnScripts; expoPlugin?: ExpoPlugin; kind: ProjectKind; exclude?: readonly string[] },
  names: readonly string[],
  rnDir: string = resolveRnDir(paths),
): string[] {
  return [
    ...rnSpmGenerateArgs(paths, opts, rnDir),
    "--scaffold",
    "--results",
    paths.scaffoldResults,
    ...names.flatMap((n) => ["--only", n]),
  ];
}

/** The scaffolder's banner (SCAFFOLDER_MARKER in vendor/rn-spm/spm/scaffold-package-swift.js). */
const SCAFFOLDER_BANNER = "AUTO-SCAFFOLDED by react-native spm scaffold";

export interface ScaffoldOutcome {
  scaffolded: string[];
  failed: { name: string; reason: string; warnings: string[] }[];
  /** The files each scaffolded library's result lists as written (relative to the library); absent: no usable list. */
  files: Map<string, string[]>;
}

interface ScaffoldResultEntry {
  depName?: unknown;
  status?: unknown;
  reason?: unknown;
  warnings?: unknown;
  root?: unknown;
  files?: unknown;
}

/** A result's `files`, when it is a list of relative paths inside the library; undefined otherwise. */
function writtenFiles(files: unknown): string[] | undefined {
  if (!Array.isArray(files)) return undefined;
  const ok = files.every(
    (f): f is string => typeof f === "string" && f !== "" && !f.startsWith("/") && !f.split("/").includes(".."),
  );
  return ok ? (files as string[]) : undefined;
}

/**
 * What the scaffold step did for each library React Native named, from the driver's results file; undefined without a
 * readable one. A named library counts as scaffolded when its result is not an error (a scaffold that throws may have
 * written its manifest already) and its `Package.swift` exists and carries the scaffolder's banner (its root from the
 * results, else `node_modules/<name>`); otherwise it failed, with the scaffolder's reason, or
 * "no Package.swift was written" when it gave none, or, without any result for it, that the scaffolder did not find it.
 */
export function scaffoldOutcome(paths: ProjectPaths, names: readonly string[]): ScaffoldOutcome | undefined {
  let entries: ScaffoldResultEntry[];
  try {
    const parsed = JSON.parse(readFileSync(paths.scaffoldResults, "utf8")) as { results?: unknown };
    if (!Array.isArray(parsed.results)) return undefined;
    entries = parsed.results as ScaffoldResultEntry[];
  } catch {
    return undefined;
  }
  const outcome: ScaffoldOutcome = { scaffolded: [], failed: [], files: new Map() };
  for (const name of names) {
    const entry = entries.find((e) => e.depName === name);
    const root = typeof entry?.root === "string" ? entry.root : path.join(paths.root, "node_modules", name);
    let manifest = "";
    try {
      manifest = readFileSync(path.join(root, "Package.swift"), "utf8");
    } catch {
      // none written
    }
    if (entry?.status !== "error" && manifest.includes(SCAFFOLDER_BANNER)) {
      outcome.scaffolded.push(name);
      const files = writtenFiles(entry?.files);
      if (files !== undefined) outcome.files.set(name, files);
      continue;
    }
    const reason =
      entry === undefined
        ? `the scaffolder did not find ${name} among the autolinked iOS libraries`
        : typeof entry.reason === "string" && entry.reason !== ""
          ? entry.reason
          : "no Package.swift was written";
    const warnings = Array.isArray(entry?.warnings) ? entry.warnings.filter((w): w is string => typeof w === "string") : [];
    outcome.failed.push({ name, reason, warnings });
  }
  return outcome;
}

/** One block per failed library: the scaffolder's reason first, then that library's own warnings. */
function scaffoldFailureMessage(failed: ScaffoldOutcome["failed"]): string {
  return failed
    .map((f) => [`Scaffolding ${f.name} failed: ${f.reason}`, ...f.warnings.map((w) => `  ! ${w}`)].join("\n"))
    .join("\n\n");
}

/**
 * Env of every React Native run. RN's scaffolder warns about mixed-language libraries when the
 * Swift headers dir is unset, and any manifest it evaluates must see the same value the xtool build
 * uses. The vendored Expo plugin takes its precompiled modules from `ios/build/expo-precompiled`. The scaffolder
 * maps CocoaPods pods with the pod table file, when given. It records each podspec read in the reads file, and reads
 * every podspec with the app's `ios/` as CocoaPods' installation root.
 */
export function rnSpmEnv(paths: ProjectPaths, expoPlugin: ExpoPlugin, podTableFile?: string): Record<string, string> {
  return {
    ...swiftHeadersEnv(paths.iosXtool),
    ...(expoPlugin === "vendored" ? { EXPO_PRECOMPILED_MODULES_PATH: paths.expoPrecompiled } : {}),
    ...(podTableFile !== undefined ? { [POD_TABLE_ENV]: podTableFile } : {}),
    RN_SPM_PODSPEC_READS: paths.podspecReads,
    RN_SPM_APP_IOS_DIR: paths.ios,
  };
}

export interface RnRunResult {
  exitCode: number;
  output: string;
}

export type RnRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<RnRunResult>;

export interface RnSpmDeps {
  runner: RnRunner;
  log: (s: string) => void;
  rnDir?: string;
  writePodTable: (paths: ProjectPaths, table: PodTable) => string;
}

/** Runs a command with nice, streaming its output live while buffering it. */
export const streamingRunner: RnRunner = async (cmd, args, opts) => {
  const [bin, argv] = runArgv(cmd, args, true);
  const child = execa(bin, argv, {
    cwd: opts.cwd,
    env: toolEnv(opts.env),
    extendEnv: false,
    stdio: ["ignore", "pipe", "pipe"],
    reject: false,
    buffer: false,
  });
  let output = "";
  // setEncoding makes the stream decode with a stateful decoder, so a multibyte
  // character split across chunks is never corrupted.
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    output += c;
    process.stdout.write(c);
  });
  child.stderr?.on("data", (c: string) => {
    output += c;
    process.stderr.write(c);
  });
  const r = await child;
  if (r.exitCode === undefined)
    output += `\n${r.shortMessage ?? r.message ?? "process failed to spawn"}`;
  return { exitCode: r.exitCode ?? 1, output };
};

// RN's other variant (`..., and it ships no podspec so it cannot be scaffolded`) is not scaffoldable.
const MISSING_RE =
  /error: Package\.swift is missing for library "([^"]+)"(?!, and it ships no podspec)/;
// RN's autolinker reports a library without a manifest that mixes Swift and C-family sources with
// this distinct message instead. Our patched scaffolder emits a mixed-language target for it.
const MIXED_RE = /error: "([^"]+)" has mixed Swift \+ Objective-C\/C\+\+ sources/;
const CREATED_RE = /Created file (patches\/\S+\.patch)/;

/** Scaffoldable libraries RN reports as lacking a Package.swift (has a podspec), deduped, in first-seen order. */
export function parseMissingPackageSwift(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const name = MISSING_RE.exec(line)?.[1] ?? MIXED_RE.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * `--patch-dir patches` is relative to the project root: the user's patches, not rn-xtool's.
 * `--exclude` replaces patch-package's default (`package\.json$`): it also drops SwiftPM build
 * artifacts (`.build/.lock`, `CACHEDIR.TAG`, ...). package.json stays excluded on purpose:
 * `swiftpmConfig.name` falls back to the podspec name, so the scaffolded manifest does not need it.
 */
export const PERSIST_EXCLUDE = "(^|/)\\.build/|^package\\.json$";
/** `include`: patch-package's `--include`, the paths the patch may hold (persistInclude); absent: the whole package. */
export function persistScaffoldArgv(name: string, include?: string): [string, string[]] {
  return [
    process.execPath,
    [
      patchPackageScript(),
      name,
      "--patch-dir",
      "patches",
      "--exclude",
      PERSIST_EXCLUDE,
      ...(include !== undefined ? ["--include", include] : []),
    ],
  ];
}

/** Directories the scaffolder writes and removes as a whole: past PERSIST_PATHS_MAX paths, one entry each. */
const SCAFFOLDER_DIRS = ["rn-spm-pod-headers/", "rn-spm-react-headers/", "rn-spm-swift/"];
const PERSIST_PATHS_MAX = 200;
/** Under Linux's 128 KiB limit on one argument; a longer `--include` would not spawn. */
const PERSIST_INCLUDE_MAX = 100_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * patch-package's `--include` for a scaffold: each path the scaffold wrote and each path the library's existing patch
 * holds (a hand fix in it stays), relative to the library, anchored and escaped, in that order, once each. Past
 * PERSIST_PATHS_MAX paths, those under a directory the scaffolder owns whole become that directory's prefix, so the
 * argument stays short whatever the number of forwarders. Build outputs under the library (Gradle's `android/build`)
 * match none of them.
 */
export function persistInclude(written: readonly string[], existing: readonly string[]): string {
  const paths = [...new Set([...written, ...existing])];
  const collapse = paths.length > PERSIST_PATHS_MAX;
  const entries = paths.map((p) => {
    const dir = collapse ? SCAFFOLDER_DIRS.find((d) => p.startsWith(d)) : undefined;
    return dir !== undefined ? `^${escapeRegExp(dir)}` : `^${escapeRegExp(p)}$`;
  });
  return [...new Set(entries)].join("|");
}

/**
 * The files `name`'s patch (patch-package's format, `diff --git a/node_modules/<name>/<path> b/…`) touches, relative
 * to the library, both sides of a rename included. Undefined when it has no such header, or a header it cannot read
 * (a quoted path, a path outside the library).
 */
export function patchedPaths(text: string, name: string): string[] | undefined {
  const headers = text.split("\n").filter((l) => l.startsWith("diff --git "));
  if (headers.length === 0) return undefined;
  const prefix = `node_modules/${name}/`;
  const paths: string[] = [];
  for (const header of headers) {
    const rest = header.slice("diff --git ".length);
    if (!rest.startsWith(`a/${prefix}`)) return undefined;
    // `a/<p> b/<q>`: paths may hold spaces, so take the split whose sides are equal, else the only one.
    const splits = [...rest.matchAll(/ b\//g)].map((m) => [rest.slice(2, m.index), rest.slice(m.index + 3)] as const);
    const split = splits.find(([a, b]) => a === b) ?? (splits.length === 1 ? splits[0] : undefined);
    if (split === undefined || !split.every((p) => p.startsWith(prefix) && p.length > prefix.length)) return undefined;
    for (const p of split) {
      const rel = p.slice(prefix.length);
      if (!paths.includes(rel)) paths.push(rel);
    }
  }
  return paths;
}

/**
 * What a persisted scaffold holds: `--include` for the scaffold's files and those of the library's patches in `patches`
 * (`before`), or, when either list is missing, undefined with the `ℹ` line saying why (patch-package then diffs the
 * whole package).
 */
function persistScope(name: string, files: string[] | undefined, before: Map<string, Buffer>): { include?: string; note?: string } {
  const whole = "so its patch holds every file that differs from a clean copy";
  if (files === undefined) {
    return { note: `ℹ The scaffold did not list the files it wrote in ${name}: persisting its whole package, ${whole}` };
  }
  const existing: string[] = [];
  const prefix = `${name.replace("/", "+")}+`;
  for (const [file, bytes] of before) {
    // `<name>+<version>….patch`; not a nested package's `<name>++<other>+<version>.patch`.
    if (!/^\d/.test(file.slice(prefix.length))) continue;
    const paths = patchedPaths(bytes.toString("utf8"), name);
    if (paths === undefined) {
      return { note: `ℹ Could not tell which files patches/${file} changes: persisting ${name}'s whole package, ${whole}` };
    }
    existing.push(...paths);
  }
  const include = persistInclude(files, existing);
  if (include.length > PERSIST_INCLUDE_MAX) {
    return { note: `ℹ ${name}'s scaffold wrote too many files to list for patch-package: persisting its whole package, ${whole}` };
  }
  return { include };
}

/** patch-package prints `✔ Created file patches/<x>.patch`; prefer that over guessing the name. */
function createdPatchFile(output: string): string | undefined {
  return CREATED_RE.exec(output)?.[1];
}

function computedPatchFile(root: string, name: string): string {
  const version = installedVersion(root, name) ?? "unknown";
  return `patches/${name.replace("/", "+")}+${version}.patch`;
}

/** Mach-O (thin, both byte orders, 32 and 64 bits) and fat magics, as latin1 text. */
const BINARY_MAGICS = ["\xcf\xfa\xed\xfe", "\xfe\xed\xfa\xcf", "\xce\xfa\xed\xfe", "\xfe\xed\xfa\xce", "\xca\xfe\xba\xbe", "\xbe\xba\xfe\xca", "\xca\xfe\xba\xbf", "\xbf\xba\xfe\xca"];
const AR_MAGICS = ["!<arch>", "!<thin>"];

/**
 * The path of the first file of a patch (read as latin1, so every byte is one character) that is binary: a
 * `GIT binary patch` hunk, git's `Binary files … differ`, or an added file whose content starts with an `ar` or Mach-O
 * magic. Undefined for a text-only patch (spec goal 6.3).
 */
export function binaryInPatch(text: string): string | undefined {
  for (const section of text.split(/^(?=diff --git )/m)) {
    const file = /^diff --git a\/(.*?) b\/(.*)$/m.exec(section)?.[2];
    if (file === undefined) continue;
    if (/^GIT binary patch$/m.test(section) || /^Binary files .* differ$/m.test(section)) return file;
    if (!/^new file mode /m.test(section)) continue;
    const first = /^@@[^\n]*\n\+(.*)$/m.exec(section)?.[1] ?? "";
    if ([...AR_MAGICS, ...BINARY_MAGICS].some((m) => first.startsWith(m))) return file;
  }
  return undefined;
}

/** The library's files in `patches/` (`<name with + for />+…`), with their bytes. */
function libraryPatches(root: string, name: string): Map<string, Buffer> {
  const dir = path.join(root, "patches");
  const prefix = `${name.replace("/", "+")}+`;
  const files = new Map<string, Buffer>();
  try {
    for (const f of readdirSync(dir)) if (f.startsWith(prefix)) files.set(f, readFileSync(path.join(dir, f)));
  } catch {
    // no patches/
  }
  return files;
}

/** Puts the library's patch files back as `before` holds them: new ones removed, changed ones rewritten. */
function restorePatches(root: string, name: string, before: Map<string, Buffer>): void {
  const dir = path.join(root, "patches");
  for (const f of libraryPatches(root, name).keys()) if (!before.has(f)) rmSync(path.join(dir, f), { force: true });
  if (before.size > 0) mkdirSync(dir, { recursive: true });
  for (const [f, bytes] of before) writeFileSync(path.join(dir, f), bytes);
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/**
 * Why patch-package failed, in one line: its error line (`**ERROR** …`, `Error: …`), else the step it was on with the
 * status its crash dump names, else `exit <code>`. Never its `patch-package <version>` banner or a progress line alone.
 */
export function patchPackageReason(output: string, exitCode: number): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  // `error: null` is a field of the crash dump patch-package prints, not an error.
  const said = lines.find((l) => /^(\*\*ERROR\*\*|error:|npm ERR!|ERR!|✖)/i.test(l) && !/^error:\s*null,?$/i.test(l));
  if (said !== undefined) return said;
  const step = lines.filter((l) => l.startsWith("• ")).at(-1)?.slice(2);
  const status = /^status:\s*(\d+)/m.exec(lines.join("\n"))?.[1];
  if (step !== undefined && status !== undefined) return `${step} failed (status ${status})`;
  const other = lines.find((l) => !/^patch-package \d/.test(l) && !l.startsWith("• "));
  return other ?? `exit ${exitCode}`;
}

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-40).join("\n");
}

export async function runRnSpm(
  paths: ProjectPaths,
  opts: {
    rnArtifactsDir?: string;
    kind: ProjectKind;
    rnScripts: RnScripts;
    expoPlugin: ExpoPlugin;
    /** The config's pods, merged over rn-xtool's table for the scaffolder. */
    pods?: Record<string, PodEntry>;
    /** The config's exclude: left out of the autolinking JSON every run reads (configCommandFor). */
    exclude?: readonly string[];
    /** The binary pods the `pods` step resolved, handed to the scaffolder in the table file (fix 27). */
    binary?: Record<string, PodBinary>;
  },
  deps: Partial<RnSpmDeps> = {},
): Promise<void> {
  // Expo 58 runs `setup-apple-spm.js add --yes`, which may edit the xcodeproj: never pick it by default.
  if (opts.kind !== "bare" && opts.kind !== "expo") {
    throw new Error(`runRnSpm needs the project kind ("expo" or "bare"), got ${String(opts.kind)}`);
  }
  if (opts.kind === "expo" && opts.rnScripts === "vendored" && opts.expoPlugin !== "vendored") {
    throw new Error(
      `runRnSpm: Expo projects on vendored SwiftPM scripts need the vendored Expo plugin, got expoPlugin "${opts.expoPlugin}"`,
    );
  }
  // Only the vendored scripts read RN_SPM_EXPO_PLUGIN (edit E5): React Native's own would leave Expo modules unlinked.
  if (opts.expoPlugin === "vendored" && opts.rnScripts !== "vendored") {
    throw new Error(
      `runRnSpm: the vendored Expo plugin needs the vendored SwiftPM scripts, got rnScripts "${opts.rnScripts}"`,
    );
  }
  const runner = deps.runner ?? streamingRunner;
  const log = deps.log ?? ((s: string) => console.log(s));
  const rnDir = deps.rnDir ?? resolveRnDir(paths);
  // Bare apps and Expo SDK 57 never run `setup-apple-spm.js add|update`: only the driver.
  const driver = opts.kind === "bare" || opts.expoPlugin === "vendored";
  const rnArgs = driver ? rnSpmGenerateArgs(paths, opts, rnDir) : rnSpmArgs(paths, opts, rnDir);
  // Every run gets the table: the scaffold step reads it, whichever project kind runs it.
  const podTableFile = (deps.writePodTable ?? writePodTable)(paths, mergedPodTable(opts.pods, opts.binary));
  const env = rnSpmEnv(paths, opts.expoPlugin, podTableFile);
  // A file a previous run left must never stand for this run's reads.
  rmSync(paths.podspecReads, { force: true });
  try {
    const first = await runner("node", rnArgs, { cwd: paths.ios, env });
    if (first.exitCode === 0) return;

    const names = parseMissingPackageSwift(first.output);
    if (names.length === 0)
      throw new Error(
        `React Native SwiftPM setup failed (exit ${first.exitCode}):\n${tail(first.output)}`,
      );

    log(`▸ scaffold — generating Package.swift for: ${names.join(", ")}`);
    // A file a previous run left must never stand for this run's.
    rmSync(paths.scaffoldResults, { force: true });
    const sc = await runner("node", rnSpmScaffoldArgs(paths, opts, names, rnDir), { cwd: paths.ios, env });
    const scaffoldFailed = () => new Error(`React Native spm scaffold failed (exit ${sc.exitCode}):\n${tail(sc.output)}`);
    const outcome = scaffoldOutcome(paths, names);
    if (outcome === undefined && sc.exitCode !== 0) throw scaffoldFailed();

    // Only what was scaffolded is persisted; a failed library stops the build before React Native runs again.
    for (const name of outcome?.scaffolded ?? names) {
      // The library's patch as it was: put back when the new one would carry a binary file.
      const before = libraryPatches(paths.root, name);
      // The scaffold's files and the existing patch's, never the rest of the package (build outputs).
      const scope = persistScope(name, outcome?.files.get(name), before);
      if (scope.note !== undefined) log(scope.note);
      const [cmd, args] = persistScaffoldArgv(name, scope.include);
      let failure: string | undefined;
      let persisted = "";
      try {
        const r = await runner(cmd, args, { cwd: paths.root });
        persisted = r.output;
        if (r.exitCode !== 0) failure = patchPackageReason(r.output, r.exitCode);
      } catch (e) {
        failure = firstLine(e instanceof Error ? e.message : String(e)) || "spawn error";
      }
      if (failure !== undefined) {
        log(
          `⚠ Could not persist ${name}'s Package.swift to patches/ (${failure}). The build continues; it will be re-scaffolded on the next fresh install.`,
        );
        continue;
      }
      const patchFile = createdPatchFile(persisted) ?? computedPatchFile(paths.root, name);
      // Every patch file of the library that is new or changed, and the one it names: the guard fails closed (row 40).
      const after = libraryPatches(paths.root, name);
      const changed = [...after].filter(([f, bytes]) => !before.get(f)?.equals(bytes)).map(([, bytes]) => bytes);
      let named: Buffer | undefined;
      try {
        named = readFileSync(path.join(paths.root, patchFile));
      } catch {
        // Not under the name it printed.
      }
      if (named === undefined && changed.length === 0) {
        restorePatches(paths.root, name, before);
        log(`⚠ Did not persist ${name}'s scaffold: rn-xtool could not read ${patchFile} to check it for binary files`);
        continue;
      }
      const binary = [...changed, ...(named !== undefined ? [named] : [])]
        .map((bytes) => binaryInPatch(bytes.toString("latin1")))
        .find((b) => b !== undefined);
      if (binary !== undefined) {
        restorePatches(paths.root, name, before);
        log(`⚠ Did not persist ${name}'s scaffold: the patch would contain a binary file (${binary})`);
        continue;
      }
      log(`✔ scaffold — persisted ${patchFile}`);
    }
    if (outcome !== undefined && outcome.failed.length > 0) throw new Error(scaffoldFailureMessage(outcome.failed));
    if (sc.exitCode !== 0) throw scaffoldFailed();

    const second = await runner("node", rnArgs, { cwd: paths.ios, env });
    if (second.exitCode !== 0) {
      throw new Error(
        `React Native SwiftPM setup still failed after scaffolding ${names.join(", ")} (exit ${second.exitCode}):\n${tail(second.output)}`,
      );
    }
  } finally {
    // Once per run, every React Native run's reads together; also when one failed, before its error.
    for (const line of readerLines(readPodspecReads(paths.podspecReads))) log(line);
  }
}
