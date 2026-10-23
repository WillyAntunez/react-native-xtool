import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RuntimeFramework {
  id: string;
  name: string;
  executable: string;
  /** Absolute dir containing <name>.framework. */
  searchPath: string;
  frameworkDir: string;
}

interface ManifestSlice {
  libraryIdentifier: string;
  libraryPath: string;
}

interface ManifestFramework {
  id: string;
  frameworkName: string;
  executableName: string;
  linkage: string;
  slices: ManifestSlice[];
  artifactRelativePath: string;
}

export function readFlavoredFrameworks(
  xcframeworksDir: string,
  flavor: "debug" | "release",
  slice = "ios-arm64",
): RuntimeFramework[] {
  const manifestPath = path.join(xcframeworksDir, "flavored-frameworks.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `flavored-frameworks.json not found in ${xcframeworksDir}; run the React Native SwiftPM pipeline first`,
    );
  }
  let manifest: { version: number; frameworks: ManifestFramework[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifest.version !== 1) {
    throw new Error(`Unsupported flavored-frameworks.json version ${manifest.version}; expected 1`);
  }
  if (!Array.isArray(manifest.frameworks)) {
    throw new Error(`Invalid ${manifestPath}: "frameworks" must be an array`);
  }
  const result: RuntimeFramework[] = [];
  for (const fw of manifest.frameworks) {
    if (fw.linkage !== "dynamic") continue;
    const match = fw.slices.find((s) => s.libraryIdentifier === slice);
    if (!match) continue;
    const searchPath = path.join(xcframeworksDir, flavor, fw.artifactRelativePath, slice);
    result.push({
      id: fw.id,
      name: fw.frameworkName,
      executable: fw.executableName,
      searchPath,
      frameworkDir: path.join(searchPath, match.libraryPath),
    });
  }
  return result;
}

export function jsiFramework(jsiOutDir: string): RuntimeFramework {
  return {
    id: "expo-modules-jsi",
    name: "ExpoModulesJSI",
    executable: "ExpoModulesJSI",
    searchPath: jsiOutDir,
    frameworkDir: path.join(jsiOutDir, "ExpoModulesJSI.framework"),
  };
}

export async function stageFrameworks(frameworks: RuntimeFramework[], destDir: string): Promise<void> {
  const resolved = path.resolve(destDir);
  if (
    !path.isAbsolute(destDir) ||
    path.basename(resolved) === "" ||
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(os.homedir()) ||
    resolved === path.resolve(process.cwd())
  ) {
    throw new Error(`Refusing to stage frameworks into unsafe directory: ${destDir}`);
  }
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  for (const fw of frameworks) {
    await cp(fw.frameworkDir, path.join(destDir, `${fw.name}.framework`), {
      recursive: true,
      dereference: true,
    });
  }
}
