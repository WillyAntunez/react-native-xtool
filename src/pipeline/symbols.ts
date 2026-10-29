/**
 * G4, precompiled symbol coherence: every non-weak symbol an embedded framework imports from another embedded
 * framework must be exported by it. This is dyld's launch-time check, run on Linux with the Swift toolchain's
 * `llvm-nm`, so a precompiled module built against another expo-modules-core (or JSI, React, Hermes) stops the build
 * instead of crashing the app with "Symbol not found". C++ layout drift and by-name runtime lookups are not seen.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execa } from "execa";
import type { RuntimeFramework } from "../frameworks.js";
import { expoPackageDir } from "../project/expo.js";
import { toolEnv } from "../tools/exec.js";
import { SWIFT_VERSION } from "../versions.js";

/** Runs `llvm-nm` with `args`; resolves to its stdout. */
export type NmRunner = (args: string[]) => Promise<string>;

export const LLVM_NM_MISSING =
  "llvm-nm was not found on the Swift toolchain's PATH; rn-xtool checks the precompiled frameworks with it. " +
  `Run \`rn-xtool setup\` to install Swift ${SWIFT_VERSION} through swiftly.`;

export function makeNmRunner(bin = "llvm-nm", timeoutMs?: number): NmRunner {
  return async (args) => {
    try {
      const r = await execa(bin, args, { env: toolEnv(), extendEnv: false, timeout: timeoutMs });
      return r.stdout;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(LLVM_NM_MISSING);
      throw new Error(`llvm-nm ${args.join(" ")} failed: ${(e as { stderr?: unknown }).stderr ?? String(e)}`);
    }
  };
}

/** The device slice's undefined symbols, each with its two-level-namespace library: `(from <Lib>)`. */
export function nmImportArgs(binary: string): string[] {
  return ["--arch=arm64", "-m", "--undefined-only", binary];
}

/** The device slice's exported symbol names, one per line. */
export function nmExportArgs(binary: string): string[] {
  return ["--arch=arm64", "--defined-only", "--extern-only", "-j", binary];
}

/** Sorted by UTF-16 code unit: LC_ALL=C order for symbol names. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// `(undefined) external <sym> (from <Lib>)`, allowing llvm-nm's bracketed attributes; `weak external` never matches.
const IMPORT_LINE = /^\s*\(undefined\)\s+(?:\[[^\]]*\]\s+)*external (.+) \(from ([^()]+)\)\s*$/;

/** Library → its strong imports, unique and sorted; weak imports and lines without `(from …)` are dropped. */
export function parseNmImports(text: string): Map<string, string[]> {
  const byLib = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    const m = IMPORT_LINE.exec(line);
    if (!m) continue;
    const [, symbol, lib] = m;
    if (!byLib.has(lib)) byLib.set(lib, new Set());
    byLib.get(lib)!.add(symbol);
  }
  return new Map([...byLib].map(([lib, symbols]) => [lib, [...symbols].sort(byCodeUnit)]));
}

export function parseNmExports(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  );
}

export interface SymbolGap {
  framework: RuntimeFramework;
  from: RuntimeFramework;
  missing: string[];
}

/**
 * The imports each scanned framework makes from another scanned framework (matched by executable name) that it does
 * not export. Libraries outside the set (system libraries, the Swift runtime) are ignored. Gaps come in scan order,
 * then by library name.
 */
export function symbolGaps(
  scanned: readonly { fw: RuntimeFramework; imports: Map<string, string[]>; exports: Set<string> }[],
): SymbolGap[] {
  const gaps: SymbolGap[] = [];
  for (const { fw, imports } of scanned) {
    for (const lib of [...imports.keys()].sort(byCodeUnit)) {
      const provider = scanned.find((s) => s.fw.executable === lib);
      if (provider === undefined) continue;
      const missing = imports.get(lib)!.filter((s) => !provider.exports.has(s));
      if (missing.length > 0) gaps.push({ framework: fw, from: provider.fw, missing });
    }
  }
  return gaps;
}

export interface FrameworkOrigin {
  pkg: string;
  version?: string;
  /** Relative to the project's real path. */
  dir?: string;
  builtByRnXtool: boolean;
}

function packageDirFrom(from: string, pkg: string): string | undefined {
  try {
    return path.dirname(createRequire(path.join(from, "package.json")).resolve(`${pkg}/package.json`));
  } catch {
    return undefined;
  }
}

function packageJsonAt(dir: string | undefined): Record<string, any> | undefined {
  if (dir === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The npm package a framework comes from, read where the build resolves it. */
export function frameworkOrigin(root: string, fw: RuntimeFramework): FrameworkOrigin {
  let pkg: string;
  let dir: string | undefined;
  switch (fw.id) {
    case "react":
    case "react-native-dependencies":
    case "hermes":
      pkg = "react-native";
      dir = expoPackageDir(root, "react-native");
      break;
    case "expo-modules-core":
    case "expo-modules-worklets": // core ships ExpoModulesWorklets
      pkg = "expo-modules-core";
      dir = expoPackageDir(root, "expo-modules-core");
      break;
    case "expo-modules-jsi":
      pkg = "expo-modules-jsi";
      dir = expoPackageDir(root, "expo-modules-jsi");
      break;
    default: {
      pkg = fw.id;
      const expoDir = expoPackageDir(root, "expo");
      dir = (expoDir === undefined ? undefined : packageDirFrom(expoDir, pkg)) ?? packageDirFrom(root, pkg);
    }
  }
  if (dir === undefined) return { pkg: fw.id, builtByRnXtool: false };
  const version = packageJsonAt(dir)?.version;
  return {
    pkg,
    ...(typeof version === "string" && { version }),
    dir: path.relative(realpathSync(root), realpathSync(dir)),
    builtByRnXtool: fw.id === "expo-modules-jsi",
  };
}

function originText(o: FrameworkOrigin): string {
  if (o.dir === undefined) return o.pkg;
  const name = o.version === undefined ? o.pkg : `${o.pkg} ${o.version}`;
  return `${name}, ${o.builtByRnXtool ? "built by rn-xtool from" : "from"} ${o.dir}`;
}

/** For a gap against ExpoModulesJSI: the jsi range the installed expo-modules-core declares. */
function jsiNote(root: string): string {
  const core = packageJsonAt(expoPackageDir(root, "expo-modules-core"));
  const range = core?.dependencies?.["expo-modules-jsi"];
  if (typeof core?.version !== "string" || typeof range !== "string") return "";
  return ` (expo-modules-core ${core.version} declares expo-modules-jsi ${range})`;
}

/** G4's error: one line per gap. `npx expo install --fix` only where expo is installed (Expo and hybrid apps). */
export function symbolGapMessage(root: string, gaps: readonly SymbolGap[]): string {
  const fix = expoPackageDir(root, "expo") === undefined ? "Remove" : "Run `npx expo install --fix`, remove";
  return gaps
    .map(({ framework: f, from: l, missing }) => {
      const lib = frameworkOrigin(root, l);
      const n = missing.length;
      const note = l.id === "expo-modules-jsi" ? jsiNote(root) : "";
      return (
        `${f.name}.framework (${originText(frameworkOrigin(root, f))}) needs ${n} ${n === 1 ? "symbol" : "symbols"} ` +
        `that ${l.name}.framework (${originText(lib)}) does not export, for example ${missing[0]}. ` +
        "The app would crash at launch (dyld: Symbol not found). " +
        `Its precompiled binary was built against another ${lib.pkg}${note}. ` +
        `${fix} any pin or lockfile hold on ${lib.pkg}, reinstall, and build again.`
      );
    })
    .join("\n");
}

/** G4: scans each framework's `<frameworkDir>/<executable>` with llvm-nm and throws when an import is missing. */
export async function checkFrameworkSymbols(
  root: string,
  fws: readonly RuntimeFramework[],
  nm: NmRunner = makeNmRunner(),
): Promise<void> {
  const scanned = [];
  for (const fw of fws) {
    const binary = path.join(fw.frameworkDir, fw.executable);
    const imports = parseNmImports(await nm(nmImportArgs(binary)));
    const exports = parseNmExports(await nm(nmExportArgs(binary)));
    scanned.push({ fw, imports, exports });
  }
  const gaps = symbolGaps(scanned);
  if (gaps.length > 0) throw new Error(symbolGapMessage(root, gaps));
}
