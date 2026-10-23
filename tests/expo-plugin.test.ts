import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

// Exercises the PATCHED Expo SwiftPM plugin (patches/expo+58.0.17.patch) as installed in the
// reference app (override with EXPO_XTOOL_REF_APP). Skipped when that app is not on this machine.
const APP = process.env["EXPO_XTOOL_REF_APP"] ?? "/home/willy/Desktop/willy/expo-ios-linux/app";
const MANIFESTS = path.join(APP, "node_modules/expo/scripts/spm/manifests.js");
const COMMITTED_PATCH = path.resolve(import.meta.dirname, "../patches/expo+58.0.17.patch");
// The functional test re-runs `setup-apple-spm.js update` and rewrites the app's ios/build, so it
// is opt-in: EXPO_XTOOL_E2E=1.
const e2e = process.env["EXPO_XTOOL_E2E"] === "1";
const available = existsSync(MANIFESTS) && existsSync(path.join(APP, "ios/build"));

describe.skipIf(!available)("patched Expo SwiftPM plugin", () => {
  it("the committed patch carries the umbrella-header hunk", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    const hunk = patch.split(/^diff --git /m).find((h) => h.includes("scripts/spm/manifests.js")) ?? "";
    expect(hunk).toContain("umbrella.h");
    expect(hunk).toContain("-import-objc-header");
  });

  it("the committed patch matches an actual bridging-header assignment and writes umbrella.h only on change", () => {
    const patch = readFileSync(COMMITTED_PATCH, "utf8");
    const m = /\+.*\/(SWIFT_OBJC_BRIDGING_HEADER\[.*?\)\/)\.test\(/.exec(patch);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!.slice(0, -1).replace(/\/$/, ""));
    expect(re.test("s.pod_target_xcconfig = { 'SWIFT_OBJC_BRIDGING_HEADER' => 'a.h' }")).toBe(true);
    expect(re.test("SWIFT_OBJC_BRIDGING_HEADER = a.h")).toBe(true);
    expect(re.test("# SWIFT_OBJC_BRIDGING_HEADER is not set here")).toBe(false);
    expect(patch).toContain("if (current !== umbrellaSource) fs.writeFileSync(umbrella, umbrellaSource);");
  });

  it("the installed copy carries the umbrella-header hunk", () => {
    const src = readFileSync(MANIFESTS, "utf8");
    expect(src).toContain("declaresBridgingHeader");
    expect(src).toContain("umbrella.h");
    expect(src).toContain("-import-objc-header");
  });

  it.skipIf(!e2e)("emits umbrella.h and the bridging-header flag for ExpoImagePicker", async () => {
    const shims = path.resolve(import.meta.dirname, "../shims");
    const env = {
      ...process.env,
      PATH: [path.join(homedir(), ".local/share/swiftly/bin"), shims, process.env["PATH"]].join(path.delimiter),
    };
    await execa(
      "node",
      [
        "../node_modules/react-native/scripts/setup-apple-spm.js",
        "update",
        "--yes",
        "--config-command",
        '["npx","expo-modules-autolinking","react-native-config","--json","--platform","ios"]',
      ],
      { cwd: path.join(APP, "ios"), env },
    );
    const dir = path.join(APP, "ios/build/generated/autolinking/expo/expo-source/ExpoImagePicker");
    expect(readFileSync(path.join(dir, "umbrella.h"), "utf8")).toBe(
      "#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>\n",
    );
    expect(readFileSync(path.join(dir, "Package.swift"), "utf8")).toContain(
      `"-import-objc-header", "${path.join(dir, "umbrella.h")}"`,
    );
  }, 120_000);
});
