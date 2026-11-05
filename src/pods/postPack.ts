/**
 * Spec goal 7: checks on the packed `App.app` before it is installed, for the failures ML Kit shows only at run time.
 * Every `resource_bundles` key of a staged pod is `App.app/<key>.bundle` with its Info.plist (rows 51, 54), no binary
 * target is embedded under `Frameworks/` (row 50), and every Objective-C class a force-loaded archive defines is in the
 * App binary (row 55: a dropped `+load` class). Nothing is repaired: a failure removes the packed app and its .ipa
 * (row 88) and stops with the list. `build` runs them after xtool-build; `install` runs them again on the app xtool
 * builds from `.build`, before it installs.
 */
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import * as plist from "plist";
import type { NmRunner } from "../pipeline/symbols.js";
import { PODS_LINK, PodsError } from "./format.js";
import type { StagedPods } from "./stage.js";
import type { PodsStepResult } from "./step.js";

export interface PostPackPods {
  /** The binary targets of the pod-binaries package: none may be a framework under `App.app/Frameworks/`. */
  binaryTargets: string[];
  /** The force-loaded archives, each with its pod: "MLKitCommon 13.0.0". */
  archives: { path: string; owner: string }[];
  /** The staged pods' resource bundles: `App.app/<key>.bundle`. */
  bundles: { key: string; owner: string }[];
}

/** What the checks read from the staged package and the pods step. */
export function postPackPods(staged: StagedPods, result: PodsStepResult): PostPackPods {
  const owner = new Map<string, string>();
  for (const w of result.wrapped) for (const f of w.frameworks) owner.set(f.name, `${w.pod} ${w.version}`);
  return {
    binaryTargets: staged.binaryTargets,
    archives: staged.links.archives.map((a) => ({ path: a, owner: owner.get(path.basename(a, ".a").replace(/^lib/, "")) ?? path.basename(a) })),
    bundles: result.bundles.map((b) => ({ key: b.key, owner: b.owner })),
  };
}

const CLASS = /^_OBJC_CLASS_\$_\S+$/;
const SHOWN = 5;

/** The Objective-C classes `file`'s arm64 code defines. */
async function definedClasses(nm: NmRunner, file: string): Promise<string[]> {
  const out = await nm(["--arch=arm64", "--defined-only", "-j", file]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => CLASS.test(l));
}

/** The App binary: `CFBundleExecutable` of App.app/Info.plist, else `App`. */
function appBinary(appBundle: string): string {
  try {
    const info = plist.parse(readFileSync(path.join(appBundle, "Info.plist"), "utf8")) as Record<string, unknown>;
    if (typeof info.CFBundleExecutable === "string" && info.CFBundleExecutable !== "") return path.join(appBundle, info.CFBundleExecutable);
  } catch {
    // xtool's own name for it.
  }
  return path.join(appBundle, "App");
}

export async function postPackChecks(appBundle: string, pods: PostPackPods, nm: NmRunner): Promise<void> {
  const items: string[] = [];
  for (const b of pods.bundles) {
    const dir = path.join(appBundle, `${b.key}.bundle`);
    if (!existsSync(dir)) items.push(`  - App.app/${b.key}.bundle is missing (${b.owner})`);
    else if (!existsSync(path.join(dir, "Info.plist"))) items.push(`  - App.app/${b.key}.bundle has no Info.plist (${b.owner})`);
  }
  for (const name of pods.binaryTargets) {
    if (existsSync(path.join(appBundle, "Frameworks", `${name}.framework`))) {
      items.push(`  - App.app/Frameworks/${name}.framework is there: xtool embedded a static binary as a dynamic framework`);
    }
  }
  if (pods.archives.length > 0) {
    const inApp = new Set(await definedClasses(nm, appBinary(appBundle)));
    const missing: string[] = [];
    for (const a of pods.archives) {
      for (const symbol of await definedClasses(nm, a.path)) {
        if (!inApp.has(symbol)) missing.push(`  - the App binary does not define ${symbol} (${a.owner}, force-loaded)`);
      }
    }
    items.push(...missing.slice(0, SHOWN), ...(missing.length > SHOWN ? [`  - and ${missing.length - SHOWN} more`] : []));
  }
  if (items.length > 0) {
    // Row 88: a refused app is not left where `run` would take it as built, nor its .ipa beside it.
    await rm(appBundle, { recursive: true, force: true });
    await rm(path.join(path.dirname(appBundle), `${path.basename(appBundle, ".app")}.ipa`), { force: true });
    throw new PodsError(`The packed app is not what the CocoaPods binaries need, so rn-xtool removed it and does not install it:\n${items.join("\n")}\nSee ${PODS_LINK}`);
  }
}
