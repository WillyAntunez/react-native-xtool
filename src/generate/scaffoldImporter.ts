import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** The line rn-xtool's scaffolder writes in a mixed manifest: the Swift importer paths, package-relative, as JSON. */
export const IMPORTER_MARKER = "// rn-xtool-swift-importer-paths: ";

const MARKER_RX = /^\/\/ rn-xtool-swift-importer-paths: (.*)$/m;

const packageRelative = (p: unknown): p is string =>
  typeof p === "string" && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");

/**
 * The header search paths every scaffolded mixed library records for Swift importers of its umbrella (screens'
 * RNSReactBaseView.h needs `ios/bridging`), so the App's Swift can import it too. Libraries are read at React
 * Native's `<autolinkingDir>/libs/<name>` aliases and their paths resolved against the real library directory;
 * de-duplicated, in lib-name then marker order. Empty without libs/ or without a marker.
 */
export async function scaffoldedImporterPaths(autolinkingDir: string): Promise<string[]> {
  const libsDir = join(autolinkingDir, "libs");
  let names: string[];
  try {
    names = (await readdir(libsDir)).sort();
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const name of names) {
    let dir: string;
    let manifest: string;
    try {
      dir = await realpath(join(libsDir, name));
      manifest = await readFile(join(dir, "Package.swift"), "utf8");
    } catch {
      continue;
    }
    const marker = MARKER_RX.exec(manifest)?.[1];
    if (marker === undefined) continue;
    let list: unknown;
    try {
      list = JSON.parse(marker);
    } catch {
      list = undefined;
    }
    if (!Array.isArray(list) || !list.every(packageRelative)) {
      throw new Error(
        `${join(dir, "Package.swift")} records its Swift importer paths as ${marker.trim()}, which is not a JSON array of ` +
          "paths inside the package. rn-xtool's scaffolder writes that line: remove the library's scaffolded patch if the " +
          "app has one, reinstall the library and build again so it is scaffolded again, or report it to rn-xtool.",
      );
    }
    for (const p of list) paths.add(`${dir}/${p}`);
  }
  return [...paths];
}
