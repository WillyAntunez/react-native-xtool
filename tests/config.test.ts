import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, checkPodEntries, configFileOf, loadConfig } from "../src/config.js";
import { cacheDir, projectPaths } from "../src/paths.js";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-xtool-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081 });
  });

  it("merges rn-xtool.config.json over defaults", async () => {
    await writeFile(join(dir, "rn-xtool.config.json"), '{"metroPort": 8082, "lanIp": "10.0.0.2"}');
    expect(await loadConfig(dir)).toEqual({ metroPort: 8082, lanIp: "10.0.0.2" });
  });

  it("merges rn-xtool.config.js default export over json", async () => {
    await writeFile(join(dir, "rn-xtool.config.json"), '{"metroPort": 8082, "lanIp": "10.0.0.2"}');
    await writeFile(join(dir, "rn-xtool.config.js"), "export default { metroPort: 9000 };\n");
    expect(await loadConfig(dir)).toEqual({ metroPort: 9000, lanIp: "10.0.0.2" });
  });

  it("names rn-xtool.config.json when it is not valid JSON", async () => {
    await writeFile(join(dir, "rn-xtool.config.json"), '{ "projectKind": "expo", }\n');
    await expect(loadConfig(dir)).rejects.toThrow(/^rn-xtool\.config\.json: .*JSON/);
  });

  it("reads knownLimits.allow", async () => {
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ knownLimits: { allow: ["pnpm", "@scope/lib"] } }));
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081, knownLimits: { allow: ["pnpm", "@scope/lib"] } });
  });

  it("names a knownLimits of the wrong type", async () => {
    const cases: [unknown, string][] = [
      ["pnpm", "knownLimits must be an object with an allow list"],
      [["pnpm"], "knownLimits must be an object with an allow list"],
      [null, "knownLimits must be an object with an allow list"],
      [{ allow: "pnpm" }, "knownLimits.allow must be a list of package names or \"pnpm\", \"pnp\", \"hoisted\""],
      [{ allow: ["pnpm", 3] }, "knownLimits.allow must be a list of package names or \"pnpm\", \"pnp\", \"hoisted\""],
      [{ allow: [""] }, "knownLimits.allow must be a list of package names or \"pnpm\", \"pnp\", \"hoisted\""],
    ];
    for (const [knownLimits, message] of cases) {
      await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ knownLimits }));
      const error = await loadConfig(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).name).toBe("ConfigError");
      expect((error as ConfigError).message).toBe(`rn-xtool.config.json: ${message}`);
    }
    await rm(join(dir, "rn-xtool.config.json"));
    await writeFile(join(dir, "rn-xtool.config.js"), "export default { knownLimits: { allow: [1] } };\n");
    await expect(loadConfig(dir)).rejects.toThrow(/^rn-xtool\.config\.js: knownLimits\.allow must be/);
  });

  const APPAUTH = {
    url: "https://github.com/openid/AppAuth-iOS",
    exact: "3.0.0",
    products: ["AppAuth"],
    forwardHeaders: { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] },
  };

  it("reads pods", async () => {
    const pods = {
      AppAuth: APPAUTH,
      SwiftUIIntrospect: { url: "https://github.com/siteline/swiftui-introspect", exact: "1.5.0", product: "SwiftUIIntrospect" },
      GoogleUtilities: { url: "https://github.com/google/GoogleUtilities.git", exact: "8.1.0-beta.1", products: ["GULEnvironment"], subspecs: { Logger: ["GULLogger"] } },
      GoogleToolboxForMac: {
        url: "https://github.com/google/google-toolbox-for-mac",
        exact: "6.0.1",
        products: ["GTMLogger"],
        outsideRequirement: "checked by hand",
        emptyTargets: ["GTMDefines"],
      },
      // An empty list: none (it clears the shipped entry's).
      GTMSessionFetcher: { url: "https://github.com/google/gtm-session-fetcher.git", exact: "3.5.0", products: ["GTMSessionFetcherCore"], emptyTargets: [] },
    };
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ pods }));
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081, pods });
    await rm(join(dir, "rn-xtool.config.json"));
    await writeFile(join(dir, "rn-xtool.config.js"), `export default { pods: ${JSON.stringify({ AppAuth: APPAUTH })} };\n`);
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081, pods: { AppAuth: APPAUTH } });
  });

  const entry = (over: Record<string, unknown>) => ({ AppAuth: { ...APPAUTH, ...over } });
  const without = (key: string) => {
    const e: Record<string, unknown> = { ...APPAUTH };
    delete e[key];
    return { AppAuth: e };
  };
  const OBJECT = "pods must be an object of CocoaPods pod names";
  const URL = "pods.AppAuth.url must be a git URL (https://…)";
  const EXACT = "pods.AppAuth.exact must be a version such as 3.0.0";
  const PRODUCTS = "pods.AppAuth.products must be a list of product names";
  const OUTSIDE = "pods.AppAuth.outsideRequirement must be a sentence saying why the pin is outside the requirement";
  const EMPTY_TARGETS = "pods.AppAuth.emptyTargets must be a list of target names";
  const FORWARD = (h: string) => `pods.AppAuth.forwardHeaders.${h} must be a list of module names, under a relative path ending in .h`;
  it.each<[string, unknown, string]>([
    ["a list", ["AppAuth"], OBJECT],
    ["null", null, OBJECT],
    ["a string", "AppAuth", OBJECT],
    ["a subspec as a pod name", { "AppAuth/Core": APPAUTH }, 'pods.AppAuth/Core must be a CocoaPods pod name (no "/", spaces or quotes)'],
    ["a pod name with a space", { "App Auth": APPAUTH }, 'pods.App Auth must be a CocoaPods pod name (no "/", spaces or quotes)'],
    ["an empty pod name", { "": APPAUTH }, 'pods."" must be a CocoaPods pod name (no "/", spaces or quotes)'],
    ["an entry that is not an object", { AppAuth: "3.0.0" }, URL],
    ["no url", without("url"), URL],
    ["a url without https", entry({ url: "github.com/openid/AppAuth-iOS" }), URL],
    ["a url with a quote", entry({ url: 'https://github.com/x"y' }), URL],
    ["no exact", without("exact"), EXACT],
    ["a range as exact", entry({ exact: ">= 1.7.6" }), EXACT],
    ["a two-part exact", entry({ exact: "3.0" }), EXACT],
    ["neither products nor product", without("products"), PRODUCTS],
    ["an empty products", entry({ products: [] }), PRODUCTS],
    ["a products string", entry({ products: "AppAuth" }), PRODUCTS],
    ["a product name with a quote", entry({ products: ['App"Auth'] }), PRODUCTS],
    ["an empty product", { AppAuth: { url: APPAUTH.url, exact: "3.0.0", product: "" } }, PRODUCTS],
    ["a subspec without a list", entry({ subspecs: { Core: "AppAuthCore" } }), "pods.AppAuth.subspecs.Core must be a list of product names"],
    ["a subspec with an empty list", entry({ subspecs: { Core: [] } }), "pods.AppAuth.subspecs.Core must be a list of product names"],
    ["a header key that leaves the folder", entry({ forwardHeaders: { "../x.h": ["AppAuth"] } }), FORWARD("../x.h")],
    ["an absolute header key", entry({ forwardHeaders: { "/abs.h": ["AppAuth"] } }), FORWARD("/abs.h")],
    ["a header key that is not a header", entry({ forwardHeaders: { "AppAuth/AppAuth.m": ["AppAuth"] } }), FORWARD("AppAuth/AppAuth.m")],
    ["a header without modules", entry({ forwardHeaders: { "AppAuth/AppAuth.h": [] } }), FORWARD("AppAuth/AppAuth.h")],
    ["a module that is not a module name", entry({ forwardHeaders: { "AppAuth/AppAuth.h": ["App Auth"] } }), FORWARD("AppAuth/AppAuth.h")],
    ["an outsideRequirement that is not a string", entry({ outsideRequirement: 4 }), OUTSIDE],
    ["an empty outsideRequirement", entry({ outsideRequirement: " " }), OUTSIDE],
    ["an emptyTargets string", entry({ emptyTargets: "GTMDefines" }), EMPTY_TARGETS],
    ["an emptyTargets entry that is a path", entry({ emptyTargets: ["../GTMDefines"] }), EMPTY_TARGETS],
  ])("names a pods entry of the wrong shape: %s", async (_name, pods, message) => {
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ pods }));
    const error = await loadConfig(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(`rn-xtool.config.json: ${message}`);
    await rm(join(dir, "rn-xtool.config.json"));
    await writeFile(join(dir, "rn-xtool.config.js"), `export default { pods: ${JSON.stringify(pods)} };\n`);
    await expect(loadConfig(dir)).rejects.toThrow(`rn-xtool.config.js: ${message}`);
    expect(() => checkPodEntries("data/pods.json", pods)).toThrow(`data/pods.json: ${message}`);
  });

  it("names the file each key comes from", async () => {
    expect(configFileOf(await loadConfig(dir), "exclude")).toBeUndefined();
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude: ["a"], metroPort: 9000 }));
    expect(configFileOf(await loadConfig(dir), "exclude")).toBe("rn-xtool.config.json");
    await writeFile(join(dir, "rn-xtool.config.js"), "export default { exclude: ['b'] };\n");
    const both = await loadConfig(dir);
    expect(both.exclude).toEqual(["b"]);
    expect(configFileOf(both, "exclude")).toBe("rn-xtool.config.js");
    expect(configFileOf(both, "metroPort")).toBe("rn-xtool.config.json");
    expect(configFileOf({ metroPort: 8081, exclude: ["c"] }, "exclude")).toBeUndefined();
  });

  it("reads exclude", async () => {
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude: ["react-native-vision-camera", "@scope/lib"] }));
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081, exclude: ["react-native-vision-camera", "@scope/lib"] });
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude: [] }));
    expect(await loadConfig(dir)).toEqual({ metroPort: 8081, exclude: [] });
  });

  it.each([
    ["a string", "react-native-vision-camera"],
    ["a number list", [1, 2]],
    ["an empty string", [""]],
    ["an object", { "react-native-vision-camera": true }],
    ["null", null],
  ])("names an exclude of the wrong shape: %s", async (_name, exclude) => {
    const message = "exclude must be a list of package names";
    await writeFile(join(dir, "rn-xtool.config.json"), JSON.stringify({ exclude }));
    const error = await loadConfig(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(`rn-xtool.config.json: ${message}`);
    await rm(join(dir, "rn-xtool.config.json"));
    await writeFile(join(dir, "rn-xtool.config.js"), `export default { exclude: ${JSON.stringify(exclude)} };\n`);
    await expect(loadConfig(dir)).rejects.toThrow(`rn-xtool.config.js: ${message}`);
  });

  it("rejects when rn-xtool.config.js exists but fails to load", async () => {
    await writeFile(join(dir, "rn-xtool.config.js"), 'import "nonexistent-module-xyz";\nexport default {};\n');
    await expect(loadConfig(dir)).rejects.toThrow();
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
    expect(cacheDir()).toBe("/x/rn-xtool");
  });

  it("falls back to ~/.cache", () => {
    delete process.env.XDG_CACHE_HOME;
    expect(cacheDir()).toMatch(/\.cache[\\/]rn-xtool$/);
  });
});
