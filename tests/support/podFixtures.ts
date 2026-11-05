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
