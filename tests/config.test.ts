import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { cacheDir, projectPaths } from "../src/paths.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "expo-xtool-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081 });
  });

  it("merges expo-xtool.config.json over defaults", async () => {
    await writeFile(join(dir, "expo-xtool.config.json"), '{"metroPort": 8082, "lanIp": "10.0.0.2"}');
    expect(await loadConfig(dir)).toEqual({ metroPort: 8082, lanIp: "10.0.0.2" });
  });

  it("merges expo-xtool.config.js default export over json", async () => {
    await writeFile(join(dir, "expo-xtool.config.json"), '{"metroPort": 8082, "lanIp": "10.0.0.2"}');
    await writeFile(join(dir, "expo-xtool.config.js"), "export default { metroPort: 9000 };\n");
    expect(await loadConfig(dir)).toEqual({ metroPort: 9000, lanIp: "10.0.0.2" });
  });
});

describe("projectPaths", () => {
  it("derives all paths from root", () => {
    const p = projectPaths("/p");
    expect(p.root).toBe("/p");
    expect(p.iosXtool).toBe("/p/ios-xtool");
    expect(p.xcframeworks).toBe("/p/ios/build/xcframeworks");
    expect(p.expoDir).toBe("/p/ios/build/generated/autolinking/expo");
    expect(p.generatedIos).toBe("/p/ios/build/generated/ios");
    expect(p.sources).toBe("/p/ios-xtool/Sources/App");
    expect(p.jsiOut).toBe("/p/ios-xtool/jsi-out");
    expect(p.appBundle).toBe("/p/ios-xtool/xtool/App.app");
  });
});

describe("cacheDir", () => {
  const saved = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
  });

  it("honours XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = "/x";
    expect(cacheDir()).toBe("/x/expo-xtool");
  });

  it("falls back to ~/.cache", () => {
    delete process.env.XDG_CACHE_HOME;
    expect(cacheDir()).toMatch(/\.cache[\\/]expo-xtool$/);
  });
});
