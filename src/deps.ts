import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** sha256 over the sorted entries; order of the input never matters. */
export function fingerprintOf(entries: string[]): string {
  return createHash("sha256")
    .update([...entries].sort().join("\n"))
    .digest("hex");
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Fingerprint of everything that can make the installed app or the Metro cache stale:
 * every dependency/devDependency at its INSTALLED version, plus the patches/*.patch names.
 *
 * Deliberately no native/JS distinction: JS-only changes also need a Metro cache reset,
 * and telling native dependencies apart reliably needs the autolinking pass.
 */
export async function nativeDepsFingerprint(root: string): Promise<string> {
  const pkg = await readJson(join(root, "package.json"));
  const names = new Set<string>([
    ...Object.keys((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...Object.keys((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  ]);
  const entries = await Promise.all(
    [...names].map(async (name) => {
      const installed = await readJson(join(root, "node_modules", name, "package.json"));
      const version = typeof installed?.version === "string" ? installed.version : "missing";
      return `${name}@${version}`;
    }),
  );
  let patches: string[] = [];
  try {
    patches = (await readdir(join(root, "patches"))).filter((f) => f.endsWith(".patch")).map((f) => `patch:${f}`);
  } catch {
    // no patches directory
  }
  return fingerprintOf([...entries, ...patches]);
}
