/**
 * Reading the project's dependencies and their podspecs as text: where each dependency is installed and which podspec
 * files autolinking would read. A leaf module, shared by capabilities.ts and earlyChecks.ts. Nothing is evaluated.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * `<spec>.<name> =` or `<spec>.ios.<name> =`: a pod attribute being set for iOS, not a Ruby variable or a `==` test.
 * Another platform's attribute (`<spec>.osx.<name> =`, `.tvos.`, `.visionos.`, `.watchos.`) does not count.
 */
export function attribute(name: string): RegExp {
  return new RegExp(`(?<![\\w.])[A-Za-z_]\\w*\\.(?:ios\\.)?${name}\\s*=(?!=)`);
}

export function readJson(file: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory `pkg` resolves to from `root`, along Node's node_modules lookup paths (a package whose `exports`
 * hides package.json still counts).
 */
function packageDir(root: string, pkg: string): string | undefined {
  const lookup = createRequire(path.join(root, "package.json")).resolve.paths(pkg) ?? [];
  return lookup.map((dir) => path.join(dir, pkg)).find((dir) => existsSync(path.join(dir, "package.json")));
}

/** The `*.podspec` files directly in `dir`, sorted. */
function podspecsIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".podspec"))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * The podspec files of the package at `dir`, where autolinking looks: the package root (React Native's CLI), `ios/`
 * (Expo modules) and the `podspecPath` an `expo-module.config.json` declares under `apple`, else `ios`. A declared
 * path is listed whether or not it exists; readers skip the files they cannot read.
 */
export function podspecFiles(dir: string): string[] {
  const config = readJson(path.join(dir, "expo-module.config.json"));
  const declared: unknown = (config?.apple ?? config?.ios)?.podspecPath;
  const declaredFiles = (Array.isArray(declared) ? declared : [declared])
    .filter((p): p is string => typeof p === "string")
    .map((p) => path.join(dir, p));
  return [...new Set([...podspecsIn(dir), ...podspecsIn(path.join(dir, "ios")), ...declaredFiles])];
}

/** Not autolinked: react-native's own podspecs describe the core, whose artifacts are reported on their own. */
const NOT_AUTOLINKED = new Set(["react-native"]);

/**
 * The package.json `dependencies` of `root` (sorted by name, react-native left out) that resolve from it, with the
 * directory each resolves to. Listed packages that are not installed are left out.
 */
export function dependencyDirs(root: string): { name: string; dir: string }[] {
  const deps = readJson(path.join(root, "package.json"))?.dependencies;
  const names = deps !== null && typeof deps === "object" ? Object.keys(deps).filter((n) => !NOT_AUTOLINKED.has(n)).sort() : [];
  return names.flatMap((name) => {
    const dir = packageDir(root, name);
    return dir === undefined ? [] : [{ name, dir }];
  });
}
