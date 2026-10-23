import { mkdtemp, rm, mkdir, cp, readFile, readdir, lstat, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPackageSwift } from "../src/generate/packageSwift.js";
import { renderXtoolYml } from "../src/generate/xtoolYml.js";
import { writeIosXtool } from "../src/generate/iosXtool.js";
import { projectPaths } from "../src/paths.js";
import type { ExpoProject } from "../src/project.js";
import type { RuntimeFramework } from "../src/frameworks.js";

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fw = (name: string, searchPath: string): RuntimeFramework => ({
  id: name,
  name,
  executable: `${searchPath}/${name}.framework/${name}`,
  searchPath,
  frameworkDir: `${searchPath}/${name}.framework`,
});
const frameworks = [fw("React", "/a/b"), fw("hermesvm", "/a/b"), fw("ExpoFont", "/c/d")];

describe("renderPackageSwift", () => {
  const out = renderPackageSwift({
    iosDir: "/p/ios",
    compileInterfacesDir: "/p/ci",
    frameworks,
    iosMin: "16.4",
  });
  it("links frameworks and one -F per unique searchPath", () => {
    expect(out).toContain('.linkedFramework("hermesvm")');
    expect(out.match(/"-F", "\/a\/b"/g)).toHaveLength(1);
    expect(out.match(/"-F", "\/c\/d"/g)).toHaveLength(1);
    expect(out).toContain('.unsafeFlags(["-F", "/p/ci"])');
  });
  it("sets language modes, platform and dependencies", () => {
    expect(out).toContain("swiftLanguageModes: [.v5]");
    expect(out).toContain("cxxLanguageStandard: .cxx20");
    expect(out).toContain('platforms: [.iOS("16.4")]');
    expect(out).toContain('.package(name: "ReactNative", path: "/p/ios/build/xcframeworks")');
  });
  it("escapes quotes and backslashes", () => {
    const o = renderPackageSwift({ iosDir: '/p"x\\y', compileInterfacesDir: "/c", frameworks: [], iosMin: "16.4" });
    expect(o).toContain('/p\\"x\\\\y/build/xcframeworks');
  });
});

describe("renderXtoolYml", () => {
  it("renders defaults", () => {
    const y = renderXtoolYml({ bundleIdentifier: "com.example.app" });
    expect(y).toContain("bundleID: com.example.app");
    for (const r of ["Frameworks", "ip.txt", "EXConstants.bundle"]) expect(y).toContain(`  - ${r}`);
  });
  it("honours explicit resources", () => {
    const y = renderXtoolYml({ bundleIdentifier: "a.b", resources: ["X"] });
    expect(y).toContain("  - X");
    expect(y).not.toContain("ip.txt");
  });
});

describe("writeIosXtool", () => {
  it("writes the package and is idempotent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "xt7-"));
    tmps.push(tmp);
    const target = join(tmp, "ios", "app");
    await mkdir(target, { recursive: true });
    await cp(new URL("./fixtures/ios-target", import.meta.url).pathname, target, { recursive: true });
    const paths = projectPaths(tmp);
    const project: ExpoProject = {
      root: tmp, name: "app", slug: "app", version: "1.0.0", buildNumber: "1",
      bundleIdentifier: "com.example.app", sdkVersion: 58, iosTargetName: "app", iosTargetDir: target,
    } as ExpoProject;
    const ctx = { project, paths, frameworks, metroPort: 8081, lanIp: "192.168.1.5" };
    await writeIosXtool(ctx);
    await writeIosXtool(ctx);

    expect((await readdir(paths.iosXtool)).sort()).toEqual(
      [".gitignore", "Info.plist", "Package.swift", "Sources", "ip.txt", "xtool.yml"],
    );
    expect((await readdir(paths.sources)).sort()).toEqual(
      ["AppDelegate.swift", "ExpoModulesProvider.swift", "SceneDelegate.swift"],
    );
    const link = join(paths.sources, "ExpoModulesProvider.swift");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).not.toMatch(/^\//);
    expect(await readFile(join(paths.iosXtool, "Info.plist"), "utf8")).toContain("App.SceneDelegate");
    expect(await readFile(join(paths.iosXtool, "ip.txt"), "utf8")).toBe("192.168.1.5\n");
    expect(await readFile(join(paths.iosXtool, ".gitignore"), "utf8")).toBe("*\n");
    const pkg = await readFile(join(paths.iosXtool, "Package.swift"), "utf8");
    expect(pkg.match(/"-F"/g)).toHaveLength(3); // compile-interfaces + 2 unique searchPaths
  });
});
