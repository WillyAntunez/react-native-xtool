// Row 39: the precheck's command lines against Swift Build's own, captured from six reference builds (Task 13). Each
// fixture under `fixtures/precheck/golden/<ref>/` holds the precheck's `inputs.json` of that build and Swift Build's
// argv per App compile (`commands.json`: the Swift driver's from its task store, since a Swift compile writes no
// response file, and each `CompileC`'s, whose `@…-common-args.resp` is in `responses/`). The golden is never edited
// to match the builder: a difference is fixed in `precheckCommands.ts`/`precheckGraph.ts`, or, when only the build
// folders explain it, normalised below with the command it came from.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clangArgs, swiftcArgs, type PrecheckInputs } from "../src/pipeline/precheckCommands.js";

const GOLDEN = path.join(import.meta.dirname, "fixtures", "precheck", "golden");

interface Commands {
  /** `builtin-SwiftDriver -- swiftc …` of the App target. */
  swiftDriver: string[][];
  /** The App target's `CompileC` tasks: `clang …` with `@<hash>-common-args.resp`. */
  compileC: { description: string; tool: string; argsFrom: string; args: string[] }[];
}

/** Compared flags whose value is the next element. */
const PAIRED = new Set([
  "-I",
  "-F",
  "-iquote",
  "-isystem",
  // Swift's system import path (`-Isystem <dir>`), as Swift Build passes the triple's include paths.
  "-Isystem",
  "-include",
  "-target",
  "-isysroot",
  "-sdk",
  "-x",
  "-import-objc-header",
  "-swift-version",
  "-module-name",
  "-Xfrontend",
  "-Xcc",
  "-enable-experimental-feature",
  // `package` access needs it (Swift Build: `-package-name ios_xtool`).
  "-package-name",
  // The platform's and the SDK's developer frameworks, as Swift Build's clang gets them (objc-088's `.resp`).
  "-iframework",
]);
/** Compared flags with their value joined. */
const JOINED = /^(-D|-U|-I|-F|-fmodule-map-file=|-std=|-fmodule-name=)/;
/** Compared flags without a value: these, and every `-enable-…`. */
const BARE = new Set([
  "-fobjc-arc",
  "-fno-objc-arc",
  "-fmodules",
  "-fno-cxx-modules",
  "-fcxx-modules",
  // Task 13's first false stop: without it a one-file module's file is main.swift ('main' attribute … top-level code).
  "-parse-as-library",
]);

/**
 * Every other flag of either side: ignored, and listed here so that a flag neither compared nor listed fails the test.
 * Each takes the next element as its value when `true`.
 */
const IGNORED: Record<string, boolean> = {
  // swiftc: what Swift Build's driver writes, and how it schedules its jobs and module builds.
  "-resource-dir": true,
  "-module-cache-path": true,
  "-external-plugin-path": true,
  "-index-store-path": true,
  "-output-file-map": true,
  "-clang-scanner-module-cache-path": true,
  "-sdk-module-cache-path": true,
  "-emit-module-path": true,
  "-dependency-scan-serialize-diagnostics-path": true,
  "-clang-build-session-file": true,
  "-const-gather-protocols-list": true,
  "-emit-objc-header-path": true,
  "-working-directory": true,
  "-typecheck": false,
  "-no-color-diagnostics": false,
  "-Onone": false,
  "-g": false,
  "-c": false,
  "-incremental": false,
  "-save-temps": false,
  "-color-diagnostics": false,
  "-explicit-module-build": false,
  "-emit-dependencies": false,
  "-emit-module": false,
  "-serialize-diagnostics": false,
  "-validate-clang-modules-once": false,
  "-emit-const-values": false,
  "-emit-objc-header": false,
  "-experimental-emit-module-separately": false,
  "-disable-cmo": false,
  // clang: diagnostics, warnings, outputs and code generation; -fsyntax-only checks without them.
  "-MT": true,
  "-MF": true,
  "--serialize-diagnostics": true,
  "-o": true,
  "-fsyntax-only": false,
  "-fno-color-diagnostics": false,
  "-fmessage-length=0": false,
  "-fdiagnostics-show-note-include-stack": false,
  "-fmacro-backtrace-limit=0": false,
  "-fcolor-diagnostics": false,
  "-fmodules-validate-once-per-build-session": false,
  "-fstrict-aliasing": false,
  "-gmodules": false,
  "-fpascal-strings": false,
  "-O0": false,
  "-fvisibility-inlines-hidden": false,
  "-MMD": false,
};
/** Ignored flag families: warnings, the module cache's pruning and session (the cache paths are dropped), `-j<n>`. */
const IGNORED_PREFIX = /^(-W|-fmodules-prune-|-fbuild-session-file=|-fmodules-cache-path=|-j\d+$)/;

/**
 * A path as both sides can name it, or null when the flag that names it is dropped:
 * - Swift Build's `GeneratedModuleMaps-<platform>` and the precheck's `swift-headers` → `<swift-headers>` (brief);
 * - a module map under `.build`, the precheck's synthesized one and its copy of Swift Build's importer map in
 *   `swift-headers` (expo-58-bridging's swiftDriver: the copy is the same file) → `<modulemap:<module>>` (brief);
 * - a binary target's xcframework `Headers` → `<binary-headers:<xcframework>>`, one per binary target; Swift Build's
 *   `Products/<config>/include`, where it copies those headers (every swiftDriver: `-Xcc -I…/Products/Debug-iphoneos/
 *   include`; objc-088's `.resp` files), stands for each of them (`withBinaryHeaders`); the xcframework's
 *   `module.modulemap` dropped, as clang finds the copy's in that folder (same commands);
 * - the rest of Swift Build's `Products/<config>` folder and the App's `DerivedSources`: what other targets built and
 *   what Swift Build derives, none of it there before xtool-build (every swiftDriver's `-I`/`-F`/`-Xcc -I`; objc-088's
 *   `.resp` `-I`/`-F`) → dropped. No reference has a framework-type binary target (whose framework Swift Build copies
 *   there), so the drop hides no framework search path.
 */
function normalisePath(p: string, moduleMap: boolean): string | null {
  if (moduleMap) {
    if (/\.xcframework\/[^/]+\/Headers\/module\.modulemap$/.test(p)) return null;
    const synthesized = /\/\.precheck\/modulemaps\/([^/]+)\/module\.modulemap$/.exec(p);
    if (synthesized) return `<modulemap:${synthesized[1]}>`;
    const generated = /\/(?:\.build\/.*|\.precheck\/swift-headers)\/([^/]+)\.modulemap$/.exec(p);
    if (generated) return `<modulemap:${generated[1]}>`;
  }
  const binary = /\/([^/]+)\.xcframework\/[^/]+\/Headers$/.exec(p);
  if (binary) return `<binary-headers:${binary[1]}>`;
  if (/\/\.build\/out\/Products\/[^/]+(\/|$)/.test(p) || /\/App-t\.build\/DerivedSources(-normal)?(\/|$)/.test(p)) return null;
  return p
    .replace(/\/ios-xtool\/\.build\/out\/Intermediates\.noindex\/GeneratedModuleMaps-[^/]+/, "/<swift-headers>")
    .replace(/\/ios-xtool\/\.precheck\/swift-headers/, "/<swift-headers>");
}

/**
 * Swift Build's flags for what the driver writes and how it schedules its jobs, which `-typecheck` neither writes nor
 * runs (every swiftDriver): batch mode, `@testable` access, and the debugging options a `.swiftmodule` keeps.
 */
const OUTPUT_ONLY = new Set(["-enable-batch-mode", "-enable-testing", "-Xfrontend -serialize-debugging-options"]);

/** One flag (`-I<dir>`, `-Xcc -DDEBUG=1`, `-target arm64-apple-ios16.4`) normalised, or null when it is dropped. */
function normaliseFlag(flag: string, value?: string): string | null {
  if (OUTPUT_ONLY.has(value === undefined ? flag : `${flag} ${value}`)) return null;
  if (flag === "-Xcc") {
    // The importer's module cache pruning (every swiftDriver): dropped with the module cache paths.
    if (IGNORED_PREFIX.test(value!)) return null;
    const inner = normaliseFlag(value!);
    return inner === null ? null : `-Xcc ${inner}`;
  }
  if (flag === "-I" || flag === "-F") return normaliseFlag(`${flag}${value}`);
  if (value !== undefined) return `${flag} ${value}`;
  const joined = /^(-I|-F|-fmodule-map-file=)(.+)$/.exec(flag);
  if (joined) {
    const p = normalisePath(joined[2]!, joined[1] === "-fmodule-map-file=");
    return p === null ? null : `${joined[1]}${p}`;
  }
  return flag;
}

/**
 * The compared flags of an argv, normalised and each once; `?<flag>` for one neither compared nor ignored. A
 * `-fmodule-map-file=` is kept per map, so two maps of one module show as two, and a binary target's header folder per
 * flag, so a binary target named twice, or left out, shows.
 */
function flags(argv: string[]): string[] {
  const out: string[] = [];
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n]!;
    let flag: string | null;
    if (PAIRED.has(a)) flag = normaliseFlag(a, argv[++n]);
    else if (BARE.has(a) || a.startsWith("-enable-") || JOINED.test(a)) flag = normaliseFlag(a);
    else if (a in IGNORED) {
      if (IGNORED[a]) n++;
      continue;
    } else if (IGNORED_PREFIX.test(a) || !a.startsWith("-")) continue;
    else flag = `?${a}`;
    if (flag !== null) out.push(flag);
  }
  const seen = new Set<string>();
  return out.filter((f) => {
    if (f.includes("-fmodule-map-file=<modulemap:") || f.includes("<binary-headers:")) return true;
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}

/** `a` without one occurrence of each element of `b`. */
function without(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((x) => {
    const at = left.indexOf(x);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

/** What Swift Build passes and the precheck does not (`missing`), and the reverse (`extra`), compared flags only. */
export function compareFlags(ours: string[], theirs: string[]): { missing: string[]; extra: string[] } {
  const a = flags(ours);
  const b = flags(theirs);
  return { missing: without(b, a), extra: without(a, b) };
}

/**
 * The include folders `argv` names with the flags in `kinds` (`-I` for clang; `-I` and `-F` for swiftc; `-Xcc -I` for
 * swiftc's importer), in order: `<flag> <normalised folder>`, each at its first place, dropped ones left out. clang
 * searches them in this order, so a header two of them hold resolves to the first. With `graph`, each run of the
 * package graph's header folders is one `<flag> <graph>` at the run's place: Swift Build orders them by the package
 * graph, which the fixtures do not hold (`inputs.json` has the folders, in rn-xtool's order), so the order inside a
 * run is not compared, but a graph folder placed among the target's own folders still shows; `compareFlags` compares
 * the folders a run holds.
 */
function includeOrder(argv: string[], kinds: string[], graph: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n]!;
    if (a === "-Isystem") {
      n++;
      continue;
    }
    let kind: string | undefined;
    let folder: string | undefined;
    if (a === "-Xcc") {
      const value = argv[++n] ?? "";
      if (kinds.includes("-Xcc -I") && value.startsWith("-I")) [kind, folder] = ["-Xcc -I", value.slice(2)];
    } else {
      kind = kinds.find((k) => !k.startsWith("-Xcc") && (a === k || a.startsWith(k)));
      if (kind !== undefined) folder = a === kind ? argv[++n]! : a.slice(kind.length);
    }
    if (kind === undefined || folder === undefined) continue;
    const p = normalisePath(folder, false);
    if (p === null) continue;
    const concrete = `${kind} ${p}`;
    if (seen.has(concrete)) continue;
    seen.add(concrete);
    const entry = graph.has(p) ? `${kind} <graph>` : concrete;
    if (entry.endsWith(" <graph>") && out.at(-1) === entry) continue;
    out.push(entry);
  }
  return out;
}

/** The graph's header folders of `inputs`, normalised (its binary targets' as `withBinaryHeaders` names them). */
const graphFolders = (inputs: PrecheckInputs): Set<string> => new Set(inputs.graph.headerDirs.flatMap((d) => normalisePath(d, false) ?? []));

/**
 * Swift Build's `argv` with its `Products/<config>/include` (`-I<dir>`, `-I <dir>`, `-Xcc -I<dir>`) named once per
 * binary target of the graph whose headers it copies there: the xcframework `Headers` folders of `inputs.graph`.
 */
function withBinaryHeaders(argv: string[], inputs: PrecheckInputs): string[] {
  const binaries = inputs.graph.headerDirs.filter((d) => /\.xcframework\/[^/]+\/Headers$/.test(d));
  const products = /\/\.build\/out\/Products\/[^/]+\/include$/;
  const out: string[] = [];
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n]!;
    if (a === "-Xcc" && argv[n + 1]?.startsWith("-I") && products.test(argv[n + 1]!.slice(2))) {
      out.push(...binaries.flatMap((d) => ["-Xcc", `-I${d}`]));
      n++;
    } else if (a === "-I" && products.test(argv[n + 1] ?? "")) {
      out.push(...binaries.flatMap((d) => ["-I", d]));
      n++;
    } else if (a.startsWith("-I") && products.test(a.slice(2))) {
      out.push(...binaries.map((d) => `-I${d}`));
    } else {
      out.push(a);
    }
  }
  return out;
}

/** `argv` with each `@<file>.resp` replaced by its arguments (one line, space-separated, from `responses/`). */
function expandResponses(ref: string, argv: string[]): string[] {
  return argv.flatMap((a) => {
    if (!a.startsWith("@")) return [a];
    // The Swift driver's `@App.SwiftFileList` lists the sources: positional, not compared.
    if (a.endsWith(".SwiftFileList")) return [];
    const file = path.join(GOLDEN, ref, "responses", path.basename(a));
    return readFileSync(file, "utf8").trim().split(/\s+/);
  });
}

/**
 * `theirs` without the module maps Swift Build writes for the graph's Swift targets (a target with no module of the
 * graph) that `ours` does not name: each names that target's generated `-Swift.h`, which only Swift Build's compile of
 * the target writes (objc-088's `.resp` files: AutolinkedAggregate). Expo's importer maps, which the precheck names
 * too, stay.
 */
function withoutSwiftTargetMaps(theirs: string[], ours: string[], inputs: PrecheckInputs): string[] {
  const modules = new Set(inputs.graph.modules);
  const swiftTargets = new Set(inputs.graph.targets.filter((t) => !modules.has(t)));
  const named = new Set(ours.flatMap((a) => /\/([^/]+)\.modulemap$/.exec(a)?.[1] ?? []));
  return theirs.filter((a) => {
    const m = /^-fmodule-map-file=.*\/GeneratedModuleMaps-[^/]+\/([^/]+)\.modulemap$/.exec(a);
    return m === null || !swiftTargets.has(m[1]!) || named.has(m[1]!);
  });
}

describe("compareFlags", () => {
  const out = "/home/me/app/ios-xtool/.build/out";
  const precheck = "/home/me/app/ios-xtool/.precheck";

  it("compares the flag classes after normalisation and ignores the rest", () => {
    const theirs = ["-I", `${out}/Intermediates.noindex/GeneratedModuleMaps-iphoneos`, `-fmodule-map-file=${out}/x/ExpoUI.modulemap`];
    const ours = [`-I${precheck}/swift-headers`, `-fmodule-map-file=${precheck}/modulemaps/ExpoUI/module.modulemap`, "-fsyntax-only"];
    expect(compareFlags([...ours, "-Wall", "-DA", "-DA"], [...theirs, "-O0", "-DA"])).toEqual({ missing: [], extra: [] });
    expect(compareFlags(["-x", "objective-c"], ["-x", "objective-c++"])).toEqual({ missing: ["-x objective-c++"], extra: ["-x objective-c"] });
  });

  it("counts two maps of one module, and names a flag it does not know", () => {
    const maps = [`-fmodule-map-file=${precheck}/swift-headers/ExpoUI.modulemap`, `-fmodule-map-file=${precheck}/modulemaps/ExpoUI/module.modulemap`];
    expect(compareFlags(maps, [`-fmodule-map-file=${out}/x/ExpoUI.modulemap`, "-fnew-flag"])).toEqual({
      missing: ["?-fnew-flag"],
      extra: ["-fmodule-map-file=<modulemap:ExpoUI>"],
    });
  });
});

const refs = readdirSync(GOLDEN).filter((r) => existsSync(path.join(GOLDEN, r, "commands.json")));

describe("the precheck's command lines against Swift Build's (row 39)", () => {
  it("has all six references", () => {
    expect(refs.sort()).toEqual(["bare-085", "bare-086", "bare-087", "bare-088", "expo-58-bridging", "objc-088"]);
    // Each reference compares at least one command: an empty commands.json would pass its tests vacuously.
    for (const ref of refs) {
      const { swiftDriver, compileC } = JSON.parse(readFileSync(path.join(GOLDEN, ref, "commands.json"), "utf8")) as Commands;
      expect(swiftDriver.length + compileC.length, ref).toBeGreaterThan(0);
    }
  });

  for (const ref of refs) {
    const inputs = JSON.parse(readFileSync(path.join(GOLDEN, ref, "inputs.json"), "utf8")) as PrecheckInputs;
    const commands = JSON.parse(readFileSync(path.join(GOLDEN, ref, "commands.json"), "utf8")) as Commands;
    const swiftFiles = Object.keys(inputs.app.origins).filter((f) => f.endsWith(".swift"));

    for (const argv of commands.swiftDriver) {
      it(`${ref}: swiftc gets Swift Build's flags`, () => {
        // `builtin-SwiftDriver -- <swiftc> …`
        const theirs = withBinaryHeaders(expandResponses(ref, argv.slice(argv.indexOf("--") + 2)), inputs);
        expect(compareFlags(swiftcArgs(inputs, swiftFiles), theirs)).toEqual({ missing: [], extra: [] });
        expect(includeOrder(swiftcArgs(inputs, swiftFiles), ["-I", "-F"])).toEqual(includeOrder(theirs, ["-I", "-F"]));
        const importer = (argv: string[]) => includeOrder(argv, ["-Xcc -I"], graphFolders(inputs));
        expect(importer(swiftcArgs(inputs, swiftFiles))).toEqual(importer(theirs));
      });
    }
    for (const task of commands.compileC) {
      const file = task.args[task.args.indexOf("-c") + 1]!;
      it(`${ref}: ${path.basename(file)} gets Swift Build's flags`, () => {
        const ours = clangArgs(inputs, file);
        const theirs = withBinaryHeaders(withoutSwiftTargetMaps(expandResponses(ref, task.args.slice(1)), ours, inputs), inputs);
        expect(compareFlags(ours, theirs)).toEqual({ missing: [], extra: [] });
        expect(includeOrder(ours, ["-I"], graphFolders(inputs))).toEqual(includeOrder(theirs, ["-I"], graphFolders(inputs)));
      });
    }
  }
});
