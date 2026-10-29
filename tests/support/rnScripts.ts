/**
 * Stub React Native SwiftPM scripts for test projects: tests/fixtures/rn-scripts/<shape> holds only what the shape
 * detector reads (each file's `module.exports` block and `.option(…` lines), copied from the RN 0.87.1 and 0.88.1 installs.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RN_SCRIPTS_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rn-scripts");

/** Gives `<rnDir>/scripts` the shape: "none" removes the SwiftPM scripts, "0.87" and "0.88" copy the fixture. */
export async function fakeRnScripts(rnDir: string, shape: "none" | "0.87" | "0.88"): Promise<void> {
  const scripts = path.join(rnDir, "scripts");
  await rm(path.join(scripts, "setup-apple-spm.js"), { force: true });
  await rm(path.join(scripts, "spm"), { recursive: true, force: true });
  if (shape === "none") return;
  await mkdir(scripts, { recursive: true });
  await cp(path.join(RN_SCRIPTS_FIXTURES, shape), scripts, { recursive: true });
}

/** The scripts shape a React Native release ships: 0.86 has none, 0.87 has the 0.87 shape, later ones the 0.88 shape. */
export function shapeForVersion(version: string): "none" | "0.87" | "0.88" {
  const [major, minor] = version.split(".");
  if (major === "0" && minor === "86") return "none";
  if (major === "0" && minor === "87") return "0.87";
  return "0.88";
}
