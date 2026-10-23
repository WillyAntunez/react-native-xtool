import { describe, expect, it } from "vitest";
import { appConfigArgs } from "../src/pipeline/appConfig.js";
import { jsiArgv } from "../src/pipeline/jsi.js";
import { projectPaths } from "../src/paths.js";

describe("appConfigArgs", () => {
  it("orders script, root, dest, platform, flags", () => {
    expect(appConfigArgs("/n/expo-constants", "/app", "/app/ios-xtool/EXConstants.bundle")).toEqual([
      "/n/expo-constants/scripts/getAppConfig.js",
      "/app",
      "/app/ios-xtool/EXConstants.bundle",
      "ios",
      "true",
      "development",
    ]);
  });
});

describe("jsiArgv", () => {
  it("passes root and jsiOut to the build script", () => {
    const p = projectPaths("/app");
    const argv = jsiArgv(p);
    expect(argv[0]).toMatch(/scripts\/build-expo-modules-jsi\.sh$/);
    expect(argv.slice(1)).toEqual(["/app", "/app/ios-xtool/jsi-out"]);
  });
});
