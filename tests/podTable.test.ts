import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPodEntries } from "../src/config.js";
import { projectPaths } from "../src/paths.js";
import { POD_TABLE_ENV, mergedPodTable, writePodTable } from "../src/project/podTable.js";
import { packageRoot } from "../src/tools/exec.js";

const ROOT = packageRoot();
const SCAFFOLDER = path.join(ROOT, "vendor", "rn-spm", "spm", "scaffold-package-swift.js");
const APPAUTH = {
  url: "https://github.com/openid/AppAuth-iOS",
  exact: "3.0.0",
  products: ["AppAuth"],
  forwardHeaders: { "AppAuth/AppAuth.h": ["AppAuthCore", "AppAuth"] },
};
const INTROSPECT = { url: "https://github.com/siteline/swiftui-introspect", exact: "1.5.0", products: ["SwiftUIIntrospect"] };

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("the pod table", () => {
  it("the shipped table passes the config's shape check", () => {
    const shipped = JSON.parse(readFileSync(path.join(ROOT, "data", "pods.json"), "utf8")) as { pods: unknown };
    expect(() => checkPodEntries("data/pods.json", shipped.pods)).not.toThrow();
    expect(shipped).toEqual({ pods: { AppAuth: APPAUTH } });
  });

  it("merges the config over rn-xtool's table over the scaffolder's", () => {
    expect(mergedPodTable()).toEqual({
      pods: { SwiftUIIntrospect: INTROSPECT, AppAuth: APPAUTH },
      source: { SwiftUIIntrospect: "scaffolder", AppAuth: "rn-xtool" },
    });
    const mine = { url: "https://github.com/example/AppAuth-iOS", exact: "2.1.0", product: "AppAuth" };
    const mmkv = { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] };
    const introspect = { ...INTROSPECT, exact: "1.6.0" };
    expect(mergedPodTable({ AppAuth: mine, MMKV: mmkv, SwiftUIIntrospect: introspect })).toEqual({
      pods: { SwiftUIIntrospect: introspect, AppAuth: mine, MMKV: mmkv },
      source: { SwiftUIIntrospect: "config", AppAuth: "config", MMKV: "config" },
    });
  });

  it("writes the merged table under ios/build, where the scaffolder reads it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-pods-"));
    tmp.push(root);
    const paths = projectPaths(root);
    const file = writePodTable(paths, mergedPodTable({ MMKV: { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] } }));
    expect(file).toBe(path.join(root, "ios", "build", "rn-xtool-pods.json"));
    const { loadPodTable } = createRequire(import.meta.url)(SCAFFOLDER) as { loadPodTable(): Record<string, unknown> };
    const saved = process.env[POD_TABLE_ENV];
    process.env[POD_TABLE_ENV] = file;
    try {
      expect(loadPodTable()).toEqual({
        SwiftUIIntrospect: INTROSPECT,
        AppAuth: APPAUTH,
        MMKV: { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] },
      });
    } finally {
      if (saved === undefined) delete process.env[POD_TABLE_ENV];
      else process.env[POD_TABLE_ENV] = saved;
    }
    expect(POD_TABLE_ENV).toBe("RN_SPM_POD_TABLE");
  });

  it("package.json ships data/", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("data");
  });
});
