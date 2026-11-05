/** The hand-written CocoaPods JSON specs of tests/fixtures/pods/specs, in ML Kit's shape (placeholder URLs). */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POD_SPECS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pods", "specs");

/** The fixture spec of `pod` `version`, parsed. */
export function fixtureSpec(pod: string, version: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(POD_SPECS_DIR, pod, `${version}.podspec.json`), "utf8")) as Record<string, unknown>;
}

/** Every fixture: pod → its versions. */
export function fixturePods(): Record<string, string[]> {
  return Object.fromEntries(
    readdirSync(POD_SPECS_DIR).map((pod) => [
      pod,
      readdirSync(path.join(POD_SPECS_DIR, pod)).map((f) => f.replace(/\.podspec\.json$/, "")),
    ]),
  );
}

/**
 * The routes of a CDN that lists `index` (pod → versions) in its sharded version files and serves every fixture spec
 * at its CDN path.
 */
export function podsCdnRoutes(
  index: Record<string, string[]>,
  shard: (pod: string) => [string, string, string],
): Record<string, { body: string }> {
  const routes: Record<string, { body: string }> = {};
  const files = new Map<string, string[]>();
  for (const [pod, versions] of Object.entries(index)) {
    const file = `/all_pods_versions_${shard(pod).join("_")}.txt`;
    files.set(file, [...(files.get(file) ?? []), [pod, ...versions].join("/")]);
  }
  for (const [file, lines] of files) routes[file] = { body: `${lines.join("\n")}\n` };
  for (const [pod, versions] of Object.entries(fixturePods())) {
    for (const version of versions) {
      routes[`/Specs/${shard(pod).join("/")}/${pod}/${version}/${pod}.podspec.json`] = {
        body: JSON.stringify(fixtureSpec(pod, version)),
      };
    }
  }
  return routes;
}
