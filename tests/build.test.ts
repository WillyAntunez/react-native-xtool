import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { build, buildSteps, chooseMetroPort, type BuildDeps } from "../src/commands/build.js";
import { loadConfig as realLoadConfig } from "../src/config.js";
import { jsiRnHeaderDirs } from "../src/pipeline/jsi.js";
import { fixLibraryManifests } from "../src/pipeline/manifests.js";
import { binaryPodCandidates as realBinaryPodCandidates, unresolvedPodLines as realUnresolvedPodLines, libraryFailures as realLibraryFailures, podPinWarnings, UnsupportedSetupError, type EarlyFailure } from "../src/project/earlyChecks.js";
import { mergedPodTable } from "../src/project/podTable.js";
import { readState, writeState } from "../src/state.js";
import { withEntitlements } from "./support/entitlements.js";
import { useGitSpecCache } from "./support/podsCache.js";

// Unmapped pods read as git sources from a cache of their own, never the machine's.
useGitSpecCache();

const expoFlags = { kind: "expo" as const, hasExpoModules: true, hasExpoConstants: true, rnArtifacts: false, expoPlugin: "installed" as const };
const bareFlags = { kind: "bare" as const, hasExpoModules: false, hasExpoConstants: false, rnArtifacts: false, expoPlugin: "installed" as const };

describe("buildSteps", () => {
  it("runs pods first and pod-binaries right before rn-spm, only with binary pods", () => {
    expect(buildSteps({ ...bareFlags, rnArtifacts: true, hasIos: true, clean: true, pods: true })).toEqual([
      "pods", "clean", "patches", "rn-artifacts", "pod-binaries", "rn-spm", "frameworks", "generate", "xtool-build",
    ]);
    expect(buildSteps({ ...expoFlags, hasIos: false, clean: false, pods: true })).toEqual([
      "pods", "prebuild", "patches", "pod-binaries", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
    const sdk57 = { ...expoFlags, expoPlugin: "vendored" as const, rnArtifacts: true, hasIos: true, clean: false };
    expect(buildSteps({ ...sdk57, pods: true })).toEqual([
      "pods", "patches", "rn-artifacts", "jsi", "pod-binaries", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("plans today's steps for a project without binary pods", () => {
    for (const flags of [expoFlags, bareFlags]) {
      for (const clean of [false, true]) {
        const plain = buildSteps({ ...flags, hasIos: true, clean });
        expect(buildSteps({ ...flags, hasIos: true, clean, pods: false })).toEqual(plain);
        expect(plain).not.toContain("pods");
        expect(plain).not.toContain("pod-binaries");
      }
    }
  });
  it("starts with prebuild when ios/ is missing", () => {
    expect(buildSteps({ ...expoFlags, hasIos: false, clean: false })[0]).toBe("prebuild");
  });
  it("omits prebuild when ios/ exists", () => {
    expect(buildSteps({ ...expoFlags, hasIos: true, clean: false })).toEqual([
      "patches", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("uses prebuild --clean when clean", () => {
    const steps = buildSteps({ ...expoFlags, hasIos: true, clean: true });
    expect(steps[0]).toBe("prebuild --clean");
    expect(steps).not.toContain("prebuild");
  });
  it("keeps the expo steps whatever the module flags say", () => {
    expect(buildSteps({ ...expoFlags, hasExpoConstants: false, hasIos: true, clean: false })).toEqual(
      buildSteps({ ...expoFlags, hasIos: true, clean: false }),
    );
  });
  it("bare pure: no prebuild, jsi or app-config", () => {
    expect(buildSteps({ ...bareFlags, hasIos: false, clean: false })).toEqual([
      "patches", "rn-spm", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("bare --clean cleans instead of prebuilding", () => {
    const steps = buildSteps({ ...bareFlags, hasIos: true, clean: true });
    expect(steps).toEqual(["clean", "patches", "rn-spm", "frameworks", "generate", "xtool-build"]);
  });
  it("bare hybrid: jsi with expo modules, app-config only with expo-constants", () => {
    const hybrid = { ...bareFlags, hasExpoModules: true, hasIos: true, clean: false };
    expect(buildSteps(hybrid)).toEqual(["patches", "rn-spm", "jsi", "frameworks", "generate", "xtool-build"]);
    expect(buildSteps({ ...hybrid, hasExpoConstants: true })).toEqual([
      "patches", "rn-spm", "jsi", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("bare vendored: rn-artifacts between patches and rn-spm", () => {
    expect(buildSteps({ ...bareFlags, rnArtifacts: true, hasIos: true, clean: false })).toEqual([
      "patches", "rn-artifacts", "rn-spm", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("expo 58 (installed plugin) never gets rn-artifacts", () => {
    expect(buildSteps({ ...expoFlags, rnArtifacts: true, hasIos: true, clean: false })).not.toContain("rn-artifacts");
  });
  it("expo 57: jsi before rn-spm, with rn-artifacts", () => {
    const sdk57 = { ...expoFlags, expoPlugin: "vendored" as const, rnArtifacts: true, hasIos: true, clean: false };
    expect(buildSteps(sdk57)).toEqual([
      "patches", "rn-artifacts", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
    expect(buildSteps({ ...sdk57, rnArtifacts: false })).toEqual([
      "patches", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
  it("expo 57 --clean re-creates artifacts and JSI headers before rn-spm", () => {
    expect(buildSteps({ ...expoFlags, expoPlugin: "vendored", rnArtifacts: true, hasIos: true, clean: true })).toEqual([
      "prebuild --clean", "patches", "rn-artifacts", "jsi", "rn-spm", "app-config", "frameworks", "generate", "xtool-build",
    ]);
  });
});

type ProjectOver = { kind?: "expo" | "bare"; hasExpoModules?: boolean; hasExpoConstants?: boolean; hasDevClient?: boolean; hasRnCli?: boolean; rnVersion?: string };

function setup(over: { isPortFree?: (p: number) => Promise<boolean>; isMetroRunning?: (p: number) => Promise<boolean>; hasIos?: boolean; cfg?: object; route?: { ip?: string; dev?: string }; project?: ProjectOver & { rnScripts?: "installed" | "vendored"; expoPlugin?: "installed" | "vendored" }; applyPatches?: BuildDeps["applyPatches"]; installFailures?: BuildDeps["installFailures"]; libraryFailures?: BuildDeps["libraryFailures"]; emptyTargets?: BuildDeps["emptyTargets"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "build-"));
  const calls: string[] = [];
  const logs: string[] = [];
  const rec = (n: string) => async () => {
    calls.push(n);
  };
  const writeIosXtool = vi.fn(async () => {
    calls.push("generate");
  });
  const deps: BuildDeps = {
    loadConfig: async () => ({ metroPort: 8081, ...over.cfg }),
    installFailures: over.installFailures ?? (() => []),
    libraryFailures: over.libraryFailures ?? (() => []),
    podPinWarnings: () => [],
    readProject: async () =>
      ({
        kind: "expo",
        bundleIdentifier: "com.example.app",
        hasExpoModules: true,
        hasExpoConstants: true,
        hasDevClient: false,
        rnVersion: "0.88.0",
        rnScripts: "installed",
        expoPlugin: "installed",
        ...over.project,
      }) as never,
    exists: () => over.hasIos ?? false,
    remove: async (path) => {
      calls.push(`remove ${path}`);
    },
    prebuild: async (_r, clean) => {
      calls.push(clean ? "prebuild --clean" : "prebuild");
    },
    applyPatches: over.applyPatches ?? rec("patches"),
    fixLibraryManifests: async () => {},
    prepareRnArtifacts: async (_paths, version) => {
      calls.push("rn-artifacts");
      return `/adapted/${version}`;
    },
    runRnSpm: rec("rn-spm"),
    buildJsi: async () => {
      calls.push("jsi");
      return { name: "ExpoModulesJSI" } as never;
    },
    generateAppConfig: rec("app-config"),
    readFrameworks: () => [{ name: "A" } as never],
    checkFrameworkSymbols: async () => {},
    stageFrameworks: rec("frameworks"),
    writeIosXtool,
    isPortFree: over.isPortFree ?? (async () => true),
    isMetroRunning: over.isMetroRunning ?? (async () => false),
    findFreePort: async (s) => s,
    detectLanIp: async () => "10.0.0.7",
    detectLanRoute: async () => over.route ?? { ip: "10.0.0.7", dev: "eth0" },
    devBuild: rec("xtool-build"),
    xtoolBin: () => "/bin/xtool",
    readState,
    depsFingerprint: async () => "fp-test",
    unbundledResources: () => [],
    resourceBundles: () => [],
    binaryPodCandidates: () => [],
    unresolvedPodLines: () => [],
    pods: async () => {
      throw new Error("no pods step without candidates");
    },
    stagePods: async () => {
      throw new Error("no pod-binaries step without pods");
    },
    postPack: async () => {
      calls.push("post-pack");
    },
    emptyTargets: over.emptyTargets ?? (() => []),
    log: (s) => logs.push(s),
  };
  return { root, calls, logs, deps, writeIosXtool };
}

describe("build", () => {
  it("prints the resource line once, after rn-spm", async () => {
    const t = setup();
    const roots: string[] = [];
    const unbundledResources = (root: string) => {
      roots.push(root);
      return [{ pkg: "react-native-device-info", items: ["PrivacyInfo.xcprivacy"] }];
    };
    await build(t.root, {}, { ...t.deps, unbundledResources });
    const line =
      "ℹ Not copied into the app: react-native-device-info (PrivacyInfo.xcprivacy). Development builds run without them; " +
      "privacy manifests are read only at App Store submission.";
    expect(t.logs.filter((l) => l === line)).toHaveLength(1);
    const at = t.logs.indexOf(line);
    expect(t.logs[at - 1]).toMatch(/^✔ rn-spm \(/);
    expect(roots).toEqual([t.root]);

    const quiet = setup();
    await build(quiet.root, {}, quiet.deps);
    expect(quiet.logs.some((l) => l.startsWith("ℹ Not copied into the app"))).toBe(false);
  });

  it("hands the scaffolded libraries' resource bundles to generate, read after rn-spm", async () => {
    const t = setup();
    const bundle = { key: "RNSVGFilters", baseDir: "/p/svg", globs: ["apple/**/*.iphoneos.metallib"], owner: "react-native-svg" };
    const resourceBundles = (root: string) => {
      t.calls.push(`bundles ${root === t.root}`);
      return [bundle];
    };
    await build(t.root, {}, { ...t.deps, resourceBundles });
    expect(t.calls.indexOf("bundles true")).toBeGreaterThan(t.calls.indexOf("rn-spm"));
    expect((t.writeIosXtool.mock.calls[0] as unknown[])[0]).toMatchObject({ resourceBundles: [bundle] });
    const plain = setup();
    await build(plain.root, {}, plain.deps);
    expect((plain.writeIosXtool.mock.calls[0] as unknown[])[0]).not.toHaveProperty("resourceBundles");
  });

  it("names a scaffolded bundle that would hold one file name twice in the ℹ line, and builds on without it", async () => {
    const t = setup();
    const dir = mkdtempSync(join(tmpdir(), "build-dup-bundle-"));
    for (const f of ["a/x.metallib", "b/x.metallib"]) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), f);
    }
    const bundle = { key: "Twice", baseDir: dir, globs: ["**/*.metallib"], owner: "react-native-foo" };
    await build(t.root, {}, { ...t.deps, resourceBundles: () => [bundle] });
    expect(t.logs).toContain("ℹ Not copied into the app: react-native-foo (Twice.bundle). Code that loads them at run time does not find them.");
    expect((t.writeIosXtool.mock.calls[0] as unknown[])[0]).not.toHaveProperty("resourceBundles");
  });

  describe("binary pods", () => {
    const LIB = "@react-native-ml-kit/text-recognition";
    const ROOT = { library: LIB, libraryVersion: "2.0.0", dependency: "GoogleMLKit/TextRecognition", requirements: ["8.0.0"] };
    const BUNDLE = { key: "LatinOCRResources", baseDir: "/c/extracted/x", globs: ["Resources/LatinOCRResources/**"], owner: "MLKitTextRecognition 6.0.0" };
    const LINKS = { archives: ["/r/ios/build/pod-binaries/archives/libMLKitCommon.a"], frameworks: ["UIKit"], libraries: ["z"], weakFrameworks: [], emptyTargets: ["GTMDefines"] };
    const RESULT = {
      resolution: { binary: [], sources: [], roots: [{ pod: "GoogleMLKit", libraries: [LIB] }], changed: [] },
      wrapped: [],
      binary: { GoogleMLKit: { product: "GoogleMLKit" } },
      lock: { lockfileVersion: 1 as const, pods: {} },
      bundles: [BUNDLE],
    };
    function withPods(over: Parameters<typeof setup>[0] = {}) {
      const t = setup(over);
      const seen: { roots?: unknown; table?: unknown; staged?: unknown } = {};
      const deps: BuildDeps = {
        ...t.deps,
        binaryPodCandidates: () => [ROOT],
        pods: async (root, roots, table) => {
          t.calls.push(`pods ${root === t.root}`);
          seen.roots = roots;
          seen.table = table;
          return RESULT;
        },
        stagePods: async (_paths, result) => {
          t.calls.push("pod-binaries");
          seen.staged = result;
          return { dir: "/r/ios/build/pod-binaries", links: LINKS, binaryTargets: ["MLKitCommon"], products: ["GoogleMLKit"] };
        },
      };
      return { ...t, deps, seen };
    }

    it("runs pods before prebuild and pod-binaries before rn-spm", async () => {
      const t = withPods();
      await build(t.root, {}, t.deps);
      expect(t.calls.slice(0, 5)).toEqual(["pods true", "prebuild", "patches", "pod-binaries", "rn-spm"]);
      expect(t.seen.roots).toEqual([ROOT]);
      expect(t.seen.table).toEqual(mergedPodTable());
      expect(t.seen.staged).toBe(RESULT);
      expect(t.logs).toContain("▸ pods");
      expect(t.logs).toContain("▸ pod-binaries");
    });

    it("prints the not-resolved line after the early checks", async () => {
      const t = withPods({ cfg: { exclude: ["other-lib"] } });
      const pkg = join(t.root, "node_modules", LIB);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(t.root, "package.json"), JSON.stringify({ name: "app", dependencies: { [LIB]: "2.0.0" } }));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: LIB, version: "2.0.0" }));
      writeFileSync(join(pkg, "RNMLKitTextRecognition.podspec"), "Pod::Spec.new do |s|\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\nend\n");
      const podsCache = mkdtempSync(join(tmpdir(), "build-pods-cache-"));
      const seen: unknown[] = [];
      await build(t.root, {}, {
        ...t.deps,
        libraryFailures: (root, opts) => realLibraryFailures(root, { ...opts, podsCache }),
        unresolvedPodLines: (root, opts) => {
          seen.push(opts);
          return realUnresolvedPodLines(root, { ...opts, podsCache });
        },
      });
      const line = `ℹ pods — GoogleMLKit (from ${LIB}) is not resolved yet; rn-xtool build reads its spec from the CocoaPods CDN.`;
      expect(t.logs.filter((l) => l === line)).toHaveLength(1);
      expect(t.logs.indexOf(line)).toBeLessThan(t.logs.indexOf("▸ pods"));
      expect(seen).toEqual([{ exclude: ["other-lib"] }]);
    });

    it("hands knownLimits.allow to the pods step, with the pods the early checks already allowed", async () => {
      const allowedFailure: EarlyFailure = { id: "unmapped-pod", allowKey: LIB, reason: `${LIB} 2.0.0: GitPod.`, pods: ["GitPod"] };
      const other: EarlyFailure = { id: "vendored-binaries", allowKey: "react-native-other", reason: "react-native-other 1.0.0: binaries." };
      const t = withPods({ cfg: { knownLimits: { allow: [LIB, "react-native-other"] } }, libraryFailures: () => [allowedFailure, other] });
      let opts: Parameters<BuildDeps["pods"]>[3] | undefined;
      await build(t.root, {}, { ...t.deps, pods: async (_root, _roots, _table, o) => ((opts = o), RESULT) });
      expect(opts?.allowed).toEqual([LIB, "react-native-other"]);
      expect(opts?.warned?.(LIB, "GitPod")).toBe(true);
      expect(opts?.warned?.(LIB, "OtherPod")).toBe(false);
      expect(opts?.warned?.("react-native-other", "GitPod")).toBe(false);
      expect(t.calls).toContain("rn-spm");
    });

    it("stops on an unreachable CDN before anything changes", async () => {
      const t = withPods();
      const pods = async () => {
        t.calls.push("pods");
        throw new Error("Cannot reach cdn.cocoapods.org (getaddrinfo ENOTFOUND) to read the versions of GoogleMLKit, which are not in rn-xtool's cache (~/.cache/rn-xtool/pods).");
      };
      await expect(build(t.root, {}, { ...t.deps, pods })).rejects.toThrow("Cannot reach cdn.cocoapods.org");
      expect(t.calls).toEqual(["pods"]);
    });

    it("stages pod-binaries on every build before rn-spm", async () => {
      const t = withPods({ hasIos: true });
      await build(t.root, {}, t.deps);
      await build(t.root, {}, t.deps);
      expect(t.calls.filter((c) => c === "pod-binaries")).toHaveLength(2);
      expect(t.calls.filter((c) => c === "pod-binaries" || c === "rn-spm")).toEqual(["pod-binaries", "rn-spm", "pod-binaries", "rn-spm"]);
    });

    it("stops when staging fails", async () => {
      const t = withPods();
      const stagePods = async () => {
        throw new Error("rn-xtool writes CocoaPods binaries only outside node_modules");
      };
      await expect(build(t.root, {}, { ...t.deps, stagePods })).rejects.toThrow("only outside node_modules");
      expect(t.calls).not.toContain("rn-spm");
      expect(t.calls).not.toContain("generate");
    });

    it("does no pods work for an excluded library", async () => {
      const t = withPods({ cfg: { exclude: [LIB] } });
      const pkg = join(t.root, "node_modules", LIB);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(t.root, "package.json"), JSON.stringify({ name: "app", dependencies: { [LIB]: "2.0.0" } }));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: LIB, version: "2.0.0" }));
      writeFileSync(join(pkg, "RNMLKitTextRecognition.podspec"), "Pod::Spec.new do |s|\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\nend\n");
      await build(t.root, {}, { ...t.deps, binaryPodCandidates: realBinaryPodCandidates });
      expect(t.calls.some((c) => c.startsWith("pods") || c === "pod-binaries")).toBe(false);
      const kept = withPods();
      mkdirSync(join(kept.root, "node_modules"), { recursive: true });
      writeFileSync(join(kept.root, "package.json"), JSON.stringify({ name: "app", dependencies: { [LIB]: "2.0.0" } }));
      mkdirSync(join(kept.root, "node_modules", LIB), { recursive: true });
      for (const f of ["package.json", "RNMLKitTextRecognition.podspec"]) writeFileSync(join(kept.root, "node_modules", LIB, f), readFileSync(join(pkg, f)));
      await build(kept.root, {}, { ...kept.deps, binaryPodCandidates: realBinaryPodCandidates });
      expect(kept.calls).toContain("pods true");
    });

    it("passes the binary pods to the patches and rn-spm steps", async () => {
      const applyPatches = vi.fn(async () => {});
      const t = withPods({ applyPatches });
      const runRnSpm = vi.fn(async () => {});
      await build(t.root, {}, { ...t.deps, runRnSpm });
      expect(applyPatches).toHaveBeenCalledWith(t.root, expect.objectContaining({ podTable: mergedPodTable(undefined, RESULT.binary) }));
      expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ binary: RESULT.binary }));
    });

    it("runs the checks after xtool-build only with binary pods", async () => {
      const t = withPods();
      const seen: unknown[] = [];
      await build(t.root, {}, {
        ...t.deps,
        postPack: async (app, pods) => {
          t.calls.push("post-pack");
          seen.push([app, pods]);
        },
      });
      expect(t.calls.slice(-2)).toEqual(["xtool-build", "post-pack"]);
      expect(seen).toEqual([
        [
          join(t.root, "ios-xtool", "xtool", "App.app"),
          { binaryTargets: ["MLKitCommon"], archives: [{ path: LINKS.archives[0], owner: "libMLKitCommon.a" }], bundles: [{ key: BUNDLE.key, owner: BUNDLE.owner }] },
        ],
      ]);
      expect((await readState(join(t.root, "ios-xtool")))?.depsFingerprint).toBe("fp-test");

      const failing = withPods();
      const postPack = async () => {
        throw new Error("The packed app is not what the CocoaPods binaries need");
      };
      await expect(build(failing.root, {}, { ...failing.deps, postPack })).rejects.toThrow("The packed app is not");
      expect((await readState(join(failing.root, "ios-xtool")))?.depsFingerprint).toBeUndefined();

      const plain = setup();
      await build(plain.root, {}, plain.deps);
      expect(plain.calls).not.toContain("post-pack");
    });

    it("passes the links and the bundles to generate", async () => {
      const svg = { key: "RNSVGFilters", baseDir: "/p/svg", globs: ["apple/**/*.iphoneos.metallib"], owner: "react-native-svg" };
      const t = withPods({ emptyTargets: () => ["GTMDefines", "Other"] });
      await build(t.root, {}, { ...t.deps, resourceBundles: () => [svg] });
      expect((t.writeIosXtool.mock.calls[0] as unknown[])[0]).toMatchObject({
        pods: LINKS,
        emptyTargets: ["GTMDefines", "Other"],
        resourceBundles: [BUNDLE, svg],
      });
    });
  });

  it("leaves no fingerprint in the state when xtool-build fails", async () => {
    const t = setup();
    const devBuild = async () => {
      throw new Error("xtool failed");
    };
    await expect(build(t.root, {}, { ...t.deps, devBuild })).rejects.toThrow("xtool failed");
    const state = await readState(join(t.root, "ios-xtool"));
    expect(state?.metroPort).toBe(8081);
    expect(state?.depsFingerprint).toBeUndefined();
  });

  it("records the dependency fingerprint in the state", async () => {
    const t = setup();
    await build(t.root, {}, t.deps);
    expect((await readState(join(t.root, "ios-xtool")))?.depsFingerprint).toBe("fp-test");
  });

  it("hands the linked table pods' empty targets to generate, and nothing without them", async () => {
    const seen: unknown[] = [];
    const t = setup({
      cfg: { pods: { X: { url: "https://example.invalid/x", exact: "1.0.0", products: ["X"] } } },
      emptyTargets: (_root, opts) => {
        seen.push(opts.pods);
        return ["GTMDefines"];
      },
    });
    await build(t.root, {}, t.deps);
    expect((t.writeIosXtool.mock.calls[0] as unknown[])[0]).toMatchObject({ emptyTargets: ["GTMDefines"] });
    expect(seen).toEqual([{ X: { url: "https://example.invalid/x", exact: "1.0.0", products: ["X"] } }]);
    // Row 90: install writes them again before its own xtool build.
    expect((await readState(join(t.root, "ios-xtool")))?.emptyTargets).toEqual(["GTMDefines"]);
    const plain = setup();
    await build(plain.root, {}, plain.deps);
    expect((plain.writeIosXtool.mock.calls[0] as unknown[])[0]).not.toHaveProperty("emptyTargets");
    expect(await readState(join(plain.root, "ios-xtool"))).not.toHaveProperty("emptyTargets");
  });

  it("runs steps in order, passes port/ip and writes state", async () => {
    const t = setup();
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { metroPort: number; lanIp: string; frameworks: unknown[] };
    expect(ctx.metroPort).toBe(8081);
    expect(ctx.lanIp).toBe("10.0.0.7");
    expect(ctx.frameworks).toHaveLength(2);
    const state = await readState(join(t.root, "ios-xtool"));
    expect(state).toMatchObject({ version: 1, metroPort: 8081, lanIp: "10.0.0.7", bundleIdentifier: "com.example.app" });
    expect(t.logs).toContain("▸ patches");
    expect(t.logs.some((l) => /^✔ patches \(\d+(\.\d+)?s\)$/.test(l))).toBe(true);
  });
  it("skips prebuild when ios exists and honors config lanIp", async () => {
    const t = setup({ hasIos: true, cfg: { lanIp: "1.2.3.4" } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: true, clean: false }));
    expect((await readState(join(t.root, "ios-xtool")))?.lanIp).toBe("1.2.3.4");
  });
  it("prebuilds with --clean", async () => {
    const t = setup({ hasIos: true });
    await build(t.root, { clean: true }, t.deps);
    expect(t.calls[0]).toBe("prebuild --clean");
  });
  it("removes the ios/ a failed prebuild left and says so (row 53)", async () => {
    for (const [hasIos, clean] of [[false, false], [true, true]] as const) {
      const t = setup({ hasIos });
      let wroteIos = false;
      const prebuild = async (_r: string, c: boolean) => {
        t.calls.push(c ? "prebuild --clean" : "prebuild");
        wroteIos = true;
        throw new Error("Command failed with exit code 1: npx expo prebuild --platform ios --no-install");
      };
      const exists = () => hasIos || wroteIos;
      const error = await build(t.root, { clean }, { ...t.deps, prebuild, exists }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(
        "Command failed with exit code 1: npx expo prebuild --platform ios --no-install\n" +
          "The failed prebuild left ios/ half-written, so rn-xtool removed it; the next build runs expo prebuild again.",
      );
      expect(t.calls).toEqual([clean ? "prebuild --clean" : "prebuild", `remove ${join(t.root, "ios")}`]);
    }
  });
  it("rethrows the error unchanged when the failed prebuild wrote no ios/", async () => {
    const t = setup();
    const failure = new Error("Command failed with exit code 1: npx expo prebuild --platform ios --no-install");
    const error = await build(t.root, {}, {
      ...t.deps,
      prebuild: async () => {
        t.calls.push("prebuild");
        throw failure;
      },
    }).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(t.calls).toEqual(["prebuild"]);
  });
  it("says so when the half-written ios/ cannot be removed", async () => {
    const t = setup();
    let wroteIos = false;
    const error = await build(t.root, {}, {
      ...t.deps,
      exists: () => wroteIos,
      prebuild: async () => {
        wroteIos = true;
        throw new Error("Command failed with exit code 1: npx expo prebuild --platform ios --no-install");
      },
      remove: async () => {
        throw new Error("EACCES: permission denied");
      },
    }).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "Command failed with exit code 1: npx expo prebuild --platform ios --no-install\n" +
        "The failed prebuild left ios/ half-written, and rn-xtool could not remove it (EACCES: permission denied); delete " +
        "ios/ before the next build, or run rn-xtool build --clean.",
    );
  });
  it("passes the scripts and plugin sources to the patches step", async () => {
    const applyPatches = vi.fn(async () => {});
    const t = setup({ applyPatches, project: { kind: "bare", rnScripts: "vendored" } });
    await build(t.root, {}, t.deps);
    expect(applyPatches).toHaveBeenCalledWith(t.root, { rnScripts: "vendored", expoPlugin: "installed", podTable: mergedPodTable(), kind: "bare" });
    const sdk57 = vi.fn(async () => {});
    const t57 = setup({ applyPatches: sdk57, project: { kind: "expo", rnScripts: "vendored", expoPlugin: "vendored", rnVersion: "0.86.3" } });
    await build(t57.root, {}, t57.deps);
    expect(sdk57).toHaveBeenCalledWith(t57.root, { rnScripts: "vendored", expoPlugin: "vendored", podTable: mergedPodTable(), kind: "expo" });
    const sdk58 = vi.fn(async () => {});
    const t58 = setup({ applyPatches: sdk58, project: { kind: "expo" } });
    await build(t58.root, {}, t58.deps);
    expect(sdk58).toHaveBeenCalledWith(t58.root, { rnScripts: "installed", expoPlugin: "installed", podTable: mergedPodTable(), kind: "expo" });
  });

  it("build passes the kind to runRnSpm and skips prebuild for bare", async () => {
    const t = setup({ project: { kind: "bare", hasExpoModules: false, hasExpoConstants: false } });
    const runRnSpm = vi.fn(async () => {
      t.calls.push("rn-spm");
    });
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(t.calls).toEqual(buildSteps({ ...bareFlags, hasIos: false, clean: false }));
    expect(runRnSpm).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), { rnArtifactsDir: undefined, kind: "bare", rnScripts: "installed", expoPlugin: "installed" });
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A"]);
  });
  it("passes the merged pod table to the patches step", async () => {
    const pods = { AppAuth: { url: "https://github.com/example/AppAuth-iOS", exact: "2.1.0", products: ["AppAuth"] } };
    const applyPatches = vi.fn(async () => {});
    const t = setup({ cfg: { pods }, project: { kind: "bare" }, applyPatches });
    await build(t.root, {}, t.deps);
    expect(applyPatches).toHaveBeenCalledWith(t.root, expect.objectContaining({ podTable: mergedPodTable(pods) }));
  });
  it("passes the config's pods to runRnSpm", async () => {
    const pods = { AppAuth: { url: "https://github.com/example/AppAuth-iOS", exact: "2.1.0", products: ["AppAuth"] } };
    const t = setup({ cfg: { pods }, project: { kind: "bare" } });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pods }));
  });
  it("passes the config's exclude to runRnSpm", async () => {
    const t = setup({ cfg: { exclude: ["react-native-vision-camera"] }, project: { kind: "bare" } });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ exclude: ["react-native-vision-camera"] }));
  });
  it("passes the scripts source to runRnSpm", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored" } });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rnScripts: "vendored" }));
  });

  it("runs rn-artifacts for a bare project on vendored scripts", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3", hasExpoModules: false, hasExpoConstants: false } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(["patches", "rn-artifacts", "rn-spm", "frameworks", "generate", "xtool-build"]);
    expect(t.logs).toContain("▸ rn-artifacts");
  });
  it("passes the prepared artifacts root to runRnSpm", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, runRnSpm });
    expect(prepareRnArtifacts).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), "0.86.3");
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/adapted/0.86.3", kind: "bare", rnScripts: "vendored", expoPlugin: "installed" });
  });
  it("rnArtifactsDir bypasses rn-artifacts", async () => {
    const t = setup({ cfg: { rnArtifactsDir: "/mine" }, project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, runRnSpm });
    expect(prepareRnArtifacts).not.toHaveBeenCalled();
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/mine", kind: "bare", rnScripts: "vendored", expoPlugin: "installed" });
    expect(t.logs).not.toContain("▸ rn-artifacts");
  });
  it("never runs rn-artifacts for installed scripts", async () => {
    const prepareRnArtifacts = vi.fn(async () => "/adapted/x");
    const bare = setup({ project: { kind: "bare", rnScripts: "installed" } });
    await build(bare.root, {}, { ...bare.deps, prepareRnArtifacts });
    const expo = setup();
    await build(expo.root, {}, { ...expo.deps, prepareRnArtifacts });
    expect(prepareRnArtifacts).not.toHaveBeenCalled();
  });
  const sdk57 = { kind: "expo" as const, rnScripts: "vendored" as const, expoPlugin: "vendored" as const, rnVersion: "0.86.3" };
  it("expo 57 --clean re-creates artifacts and JSI headers before rn-spm", async () => {
    const t = setup({ hasIos: true, project: sdk57 });
    await build(t.root, { clean: true }, t.deps);
    const order = buildSteps({ ...expoFlags, expoPlugin: "vendored", rnArtifacts: true, hasIos: true, clean: true });
    expect(t.calls).toEqual(order);
    expect(t.logs.filter((l) => l.startsWith("▸ "))).toEqual(order.map((s) => `▸ ${s}`));
  });
  it("expo 57 builds JSI from the prepared artifacts", async () => {
    const t = setup({ hasIos: true, project: sdk57 });
    const prepareRnArtifacts = vi.fn(async () => "/adapted/0.86.3");
    const buildJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, prepareRnArtifacts, buildJsi, runRnSpm });
    expect(buildJsi).toHaveBeenCalledWith(expect.objectContaining({ root: t.root }), {
      rnHeaders: jsiRnHeaderDirs("/adapted/0.86.3"),
      headersXcframework: true,
    });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/adapted/0.86.3", kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" });
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A", "ExpoModulesJSI"]);

    const u = setup({ hasIos: true, cfg: { rnArtifactsDir: "/mine" }, project: sdk57 });
    const prepare = vi.fn(async () => "/adapted/0.86.3");
    const jsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const spm = vi.fn(async () => {});
    await build(u.root, {}, { ...u.deps, prepareRnArtifacts: prepare, buildJsi: jsi, runRnSpm: spm });
    expect(prepare).not.toHaveBeenCalled();
    expect(jsi).toHaveBeenCalledWith(expect.anything(), { rnHeaders: jsiRnHeaderDirs("/mine"), headersXcframework: true });
    expect(spm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: "/mine", kind: "expo", rnScripts: "vendored", expoPlugin: "vendored" });
  });
  it("expo 58 and bare plans are unchanged", async () => {
    const t = setup({ hasIos: true });
    const buildJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, buildJsi, runRnSpm });
    expect(buildJsi.mock.calls).toEqual([[expect.objectContaining({ root: t.root })]]);
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: undefined, kind: "expo", rnScripts: "installed", expoPlugin: "installed" });
    const b = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: false } });
    const bareJsi = vi.fn(async () => ({ name: "ExpoModulesJSI" }) as never);
    await build(b.root, {}, { ...b.deps, buildJsi: bareJsi });
    expect(bareJsi.mock.calls).toEqual([[expect.objectContaining({ root: b.root })]]);
  });
  it("makes library manifests portable in the patches step, after patch-package and before rn-spm", async () => {
    const manifests = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "manifests");
    const t = setup({ hasIos: true });
    const lib = join(t.root, "node_modules", "react-native-worklets");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "Package.swift"), readFileSync(join(manifests, "react-native-worklets.Package.swift")));
    const order: string[] = [];
    let seenByRnSpm = "";
    await build(t.root, {}, {
      ...t.deps,
      applyPatches: async () => {
        order.push("patch-package");
      },
      fixLibraryManifests: async (root, log) => {
        order.push("manifests");
        await fixLibraryManifests(root, log);
      },
      runRnSpm: async () => {
        order.push("rn-spm");
        seenByRnSpm = readFileSync(join(lib, "Package.swift"), "utf8");
      },
    });
    expect(order).toEqual(["patch-package", "manifests", "rn-spm"]);
    expect(seenByRnSpm).toBe(readFileSync(join(manifests, "react-native-worklets.portable.Package.swift"), "utf8"));
    const line = "manifest — made react-native-worklets's Package.swift portable to Linux (CFGetTypeID)";
    const at = (l: string) => t.logs.findIndex((x) => x === l || x.startsWith(`${l} (`));
    expect(at("▸ patches")).toBeLessThan(at(line));
    expect(at(line)).toBeLessThan(at("✔ patches"));
    expect(t.logs.filter((l) => l.startsWith("▸ "))).toEqual(
      buildSteps({ ...expoFlags, hasIos: true, clean: false }).map((s) => `▸ ${s}`),
    );
  });

  it("checks symbols before staging", async () => {
    const jsi = { name: "ExpoModulesJSI" } as never;
    const frameworks = [{ name: "A" }, { name: "B" }] as never[];
    const order: unknown[][] = [];
    const t = setup({ hasIos: true });
    await build(t.root, {}, {
      ...t.deps,
      buildJsi: async () => jsi,
      readFrameworks: (...args) => {
        order.push(["readFrameworks", ...args]);
        return frameworks;
      },
      checkFrameworkSymbols: async (...args) => {
        order.push(["checkFrameworkSymbols", ...args]);
      },
      stageFrameworks: async (...args) => {
        order.push(["stageFrameworks", ...args]);
      },
    });
    expect(order.map((c) => c[0])).toEqual(["readFrameworks", "checkFrameworkSymbols", "stageFrameworks"]);
    expect(order[1]).toEqual(["checkFrameworkSymbols", t.root, [...frameworks, jsi]]);
    expect(order[2][1]).toEqual([...frameworks, jsi]);

    const r = setup({ hasIos: true });
    const stageFrameworks = vi.fn(async () => {});
    const devBuild = vi.fn(async () => {});
    const checkFrameworkSymbols = async () => {
      throw new Error("ExpoFileSystem.framework needs 2 symbols");
    };
    await expect(build(r.root, {}, { ...r.deps, checkFrameworkSymbols, stageFrameworks, devBuild })).rejects.toThrow(
      "ExpoFileSystem.framework needs 2 symbols",
    );
    expect(stageFrameworks).not.toHaveBeenCalled();
    expect(devBuild).not.toHaveBeenCalled();

    const kinds = [
      { over: { hasIos: true, project: sdk57 }, flags: { ...expoFlags, expoPlugin: "vendored" as const, rnArtifacts: true, hasIos: true } },
      { over: { hasIos: true }, flags: { ...expoFlags, hasIos: true } },
      { over: { project: { kind: "bare" as const, hasExpoModules: false, hasExpoConstants: false } }, flags: { ...bareFlags, hasIos: false } },
    ];
    for (const { over, flags } of kinds) {
      const k = setup(over);
      const check = vi.fn(async () => {});
      await build(k.root, {}, { ...k.deps, checkFrameworkSymbols: check });
      expect(check).toHaveBeenCalledOnce();
      expect(k.logs.filter((l) => l.startsWith("▸ "))).toEqual(buildSteps({ ...flags, clean: false }).map((s) => `▸ ${s}`));
    }
  });
  it("records the React Native version in the state", async () => {
    const t = setup({ project: { kind: "bare", rnScripts: "vendored", rnVersion: "0.86.3" } });
    await build(t.root, {}, t.deps);
    expect((await readState(join(t.root, "ios-xtool")))?.rnVersion).toBe("0.86.3");
  });

  it("passes the expo kind to runRnSpm", async () => {
    const t = setup({ hasIos: true });
    const runRnSpm = vi.fn(async () => {});
    await build(t.root, {}, { ...t.deps, runRnSpm });
    expect(runRnSpm).toHaveBeenCalledWith(expect.anything(), { rnArtifactsDir: undefined, kind: "expo", rnScripts: "installed", expoPlugin: "installed" });
  });
  it("builds the JSI framework for a bare project with expo modules, app-config only with expo-constants", async () => {
    const t = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: false } });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(["patches", "rn-spm", "jsi", "frameworks", "generate", "xtool-build"]);
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { frameworks: { name: string }[] };
    expect(ctx.frameworks.map((f) => f.name)).toEqual(["A", "ExpoModulesJSI"]);
    const u = setup({ project: { kind: "bare", hasExpoModules: true, hasExpoConstants: true } });
    await build(u.root, {}, u.deps);
    expect(u.calls).toContain("app-config");
  });
  it("stops before reading the project on a known unsupported install", async () => {
    const r1: EarlyFailure = { id: "pnpm", allowKey: "pnpm", reason: "This project was installed with pnpm." };
    const r2: EarlyFailure = { id: "hoisted", allowKey: "hoisted", reason: "react-native is installed in ../../node_modules/react-native." };
    const h = (key: string) => `To build anyway, add "${key}" to knownLimits.allow in rn-xtool.config.json.`;
    for (const [failures, message] of [
      [[r1], `${r1.reason}\n${h("pnpm")}`],
      [[r1, r2], `rn-xtool cannot build this project yet:\n- ${r1.reason}\n  ${h("pnpm")}\n- ${r2.reason}\n  ${h("hoisted")}`],
    ] as const) {
      const roots: string[] = [];
      const libraryFailures = vi.fn(() => []);
      const t = setup({
        installFailures: (root) => {
          roots.push(root);
          return [...failures];
        },
        libraryFailures,
      });
      const readProject = vi.fn(t.deps.readProject);
      const error = await build(t.root, {}, { ...t.deps, readProject }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedSetupError);
      expect((error as UnsupportedSetupError).name).toBe("UnsupportedSetupError");
      expect((error as UnsupportedSetupError).message).toBe(message);
      expect((error as UnsupportedSetupError).failures).toEqual(failures);
      expect(roots).toEqual([t.root]);
      expect(readProject).not.toHaveBeenCalled();
      expect(libraryFailures).toHaveBeenCalledWith(t.root, {});
      expect(t.calls).toEqual([]);
      expect(t.logs.filter((l) => l.startsWith("▸"))).toEqual([]);
    }
  });
  it("stops on a refused library before reading the project or writing anything", async () => {
    const r1: EarlyFailure = { id: "vendored-binaries", allowKey: "lib", reason: "lib 1.0.0: its podspec declares vendored_frameworks." };
    const r2: EarlyFailure = { id: "vendored-sources", allowKey: "expo-sqlite", reason: "expo-sqlite 58.0.14: its podspec builds C sources." };
    const h = (key: string) => `To build anyway, add "${key}" to knownLimits.allow in rn-xtool.config.json.`;
    for (const [failures, message] of [
      [[r1], `${r1.reason}\n${h("lib")}`],
      [[r1, r2], `rn-xtool cannot build this project yet:\n- ${r1.reason}\n  ${h("lib")}\n- ${r2.reason}\n  ${h("expo-sqlite")}`],
    ] as const) {
      const t = setup({ hasIos: true });
      const roots: string[] = [];
      const libraryFailures = vi.fn((root: string) => {
        roots.push(root);
        return [...failures];
      });
      const readProject = vi.fn(t.deps.readProject);
      const error = await build(t.root, {}, { ...t.deps, libraryFailures, readProject }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedSetupError);
      expect((error as UnsupportedSetupError).message).toBe(message);
      expect(roots).toEqual([t.root]);
      expect(readProject).not.toHaveBeenCalled();
      expect(t.calls).toEqual([]);
      expect(t.logs.filter((l) => l.startsWith("▸"))).toEqual([]);
    }
  });
  it("a refused bare project built with --clean keeps ios/build", async () => {
    const lib: EarlyFailure = { id: "vendored-binaries", allowKey: "lib", reason: "lib 1.0.0 declares binaries." };
    const t = setup({ hasIos: true, project: { kind: "bare" }, libraryFailures: () => [lib] });
    const iosBuild = join(t.root, "ios", "build");
    mkdirSync(iosBuild, { recursive: true });
    writeFileSync(join(iosBuild, "keep"), "");
    const remove = vi.fn(async (path: string) => {
      t.calls.push(`remove ${path}`);
    });
    await expect(build(t.root, { clean: true }, { ...t.deps, remove })).rejects.toBeInstanceOf(UnsupportedSetupError);
    expect(remove).not.toHaveBeenCalled();
    expect(t.calls).toEqual([]);
    expect(readFileSync(join(iosBuild, "keep"), "utf8")).toBe("");
  });
  it("a refused Expo project without ios/ gets no prebuild", async () => {
    const lib: EarlyFailure = { id: "vendored-binaries", allowKey: "lib", reason: "lib 1.0.0 declares binaries." };
    for (const clean of [false, true]) {
      const t = setup({ hasIos: false, libraryFailures: () => [lib] });
      await expect(build(t.root, { clean }, t.deps)).rejects.toBeInstanceOf(UnsupportedSetupError);
      expect(t.calls).toEqual([]);
    }
  });
  it("builds a project whose patches/ create the library's Package.swift", async () => {
    const name = "@react-native-async-storage/async-storage";
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "app", dependencies: { [name]: "3.1.1" } }),
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "3.1.1" }),
      [`node_modules/${name}/AsyncStorage.podspec`]:
        'Pod::Spec.new do |s|\n  s.ios.vendored_frameworks = "apple-frameworks/SharedAsyncStorage.xcframework"\nend\n',
    };
    const write = (root: string, extra: Record<string, string> = {}) => {
      for (const [rel, text] of Object.entries({ ...files, ...extra })) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
    };
    const refused = setup({ hasIos: true, libraryFailures: realLibraryFailures });
    write(refused.root);
    await expect(build(refused.root, {}, refused.deps)).rejects.toBeInstanceOf(UnsupportedSetupError);
    expect(refused.calls).toEqual([]);

    const persisted = setup({ hasIos: true, libraryFailures: realLibraryFailures });
    write(persisted.root, {
      "patches/@react-native-async-storage+async-storage+3.1.1.patch":
        `diff --git a/node_modules/${name}/Package.swift b/node_modules/${name}/Package.swift\nnew file mode 100644\n` +
        `--- /dev/null\n+++ b/node_modules/${name}/Package.swift\n@@ -0,0 +1,2 @@\n+// swift-tools-version: 6.0\n+import PackageDescription\n`,
    });
    await build(persisted.root, {}, persisted.deps);
    expect(persisted.calls).toEqual(buildSteps({ ...expoFlags, hasIos: true, clean: false }));
  });
  it("stops on an unmapped pod before anything changes", async () => {
    const name = "@react-native-ml-kit/text-recognition";
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "app", dependencies: { [name]: "2.0.0" } }),
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "2.0.0" }),
      [`node_modules/${name}/RNMLKitTextRecognition.podspec`]:
        "Pod::Spec.new do |s|\n  s.dependency 'React'\n  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\nend\n",
    };
    const t0 = setup({ hasIos: true, libraryFailures: realLibraryFailures });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(t0.root, rel)), { recursive: true });
      writeFileSync(join(t0.root, rel), text);
    }
    const error = await build(t0.root, {}, t0.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedSetupError);
    expect((error as UnsupportedSetupError).failures.map((f) => [f.id, f.allowKey])).toEqual([["unmapped-pod", name]]);
    expect((error as Error).message).toMatch(/^@react-native-ml-kit\/text-recognition 2\.0\.0: its podspec depends on the CocoaPods pod GoogleMLKit,/);
    expect(t0.calls).toEqual([]);

    // The config's pods map it: the build goes on.
    const pods = { GoogleMLKit: { url: "https://github.com/example/mlkit", exact: "8.0.0", products: ["MLKitTextRecognition"] } };
    const mapped = setup({ hasIos: true, cfg: { pods }, libraryFailures: realLibraryFailures });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(mapped.root, rel)), { recursive: true });
      writeFileSync(join(mapped.root, rel), text);
    }
    await build(mapped.root, {}, mapped.deps);
    expect(mapped.calls).toEqual(buildSteps({ ...expoFlags, hasIos: true, clean: false }));
  });
  it("logs the pod pins that miss a podspec's requirement after the early checks", async () => {
    const pods = { AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "1.7.5", products: ["AppAuth"] } };
    const seen: unknown[] = [];
    const t = setup({ hasIos: true, cfg: { pods } });
    const line = '⚠ AppAuth 1.7.5 (rn-xtool.config.json) is outside react-native-app-auth\'s requirement ">= 1.7.6"';
    await build(t.root, {}, {
      ...t.deps,
      podPinWarnings: (root, opts) => {
        seen.push(root, opts);
        return [line];
      },
    });
    expect(seen).toEqual([t.root, { pods }]);
    expect(t.logs.indexOf(line)).toBeGreaterThanOrEqual(0);
    expect(t.logs.indexOf(line)).toBeLessThan(t.logs.findIndex((l) => l.startsWith("▸")));

    // The real check on a project with react-native-app-auth's shape.
    const real = setup({ hasIos: true, cfg: { pods } });
    const lib = join(real.root, "node_modules", "react-native-app-auth");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(real.root, "package.json"), JSON.stringify({ name: "app", dependencies: { "react-native-app-auth": "8.5.1" } }));
    writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "react-native-app-auth", version: "8.5.1" }));
    writeFileSync(join(lib, "react-native-app-auth.podspec"), "Pod::Spec.new do |s|\n  s.dependency 'AppAuth', '>= 1.7.6'\nend\n");
    await build(real.root, {}, { ...real.deps, podPinWarnings: (root, opts) => podPinWarnings(root, mergedPodTable(opts.pods), opts) });
    expect(real.logs).toContain(line);

    // With "pods" in rn-xtool.config.js, the line names that file.
    writeFileSync(join(real.root, "rn-xtool.config.js"), `export default ${JSON.stringify({ pods })};\n`);
    real.logs.length = 0;
    await build(real.root, {}, {
      ...real.deps,
      loadConfig: realLoadConfig,
      podPinWarnings: (root, opts) => podPinWarnings(root, mergedPodTable(opts.pods), opts),
    });
    expect(real.logs).toContain(line.replace("rn-xtool.config.json", "rn-xtool.config.js"));
  });

  it("passes the project kind to the library checks (row 49: bare refuses an unlisted pod sibling)", async () => {
    const kinds: unknown[] = [];
    const run = async (files: Record<string, string>, cfg: object = {}) => {
      const t = setup({
        cfg,
        // A refusal stops the build right after the checks.
        libraryFailures: (_root, opts) => {
          kinds.push(opts.kind);
          return [{ id: "unlisted-sibling", allowKey: "lib", reason: "lib 1.0.0: refused." }];
        },
      });
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(t.root, rel)), { recursive: true });
        writeFileSync(join(t.root, rel), text);
      }
      await expect(build(t.root, {}, t.deps)).rejects.toBeInstanceOf(UnsupportedSetupError);
    };
    await run({ "package.json": JSON.stringify({ name: "app" }), "ios/HelloWorld.xcodeproj/project.pbxproj": "" });
    await run({ "package.json": JSON.stringify({ name: "app", dependencies: { expo: "*" } }), "app.json": JSON.stringify({ expo: {} }) });
    await run({ "package.json": JSON.stringify({ name: "app", dependencies: { expo: "*" } }), "app.json": "{}" }, { projectKind: "expo" });
    // Undetectable: the checks run as before, without a kind.
    await run({});
    expect(kinds).toEqual(["bare", "expo", "expo", undefined]);
  });

  it("prints the exclude lines first and passes exclude to the checks", async () => {
    const exclude = ["react-native-mmkv-lib"];
    const seen: unknown[] = [];
    const t = setup({
      hasIos: true,
      cfg: { exclude },
      libraryFailures: (root, opts) => {
        seen.push(["libraryFailures", opts]);
        return [];
      },
    });
    mkdirSync(join(t.root, "node_modules", "react-native-mmkv-lib"), { recursive: true });
    writeFileSync(join(t.root, "package.json"), JSON.stringify({ name: "app", dependencies: { "react-native-mmkv-lib": "1.0.0" } }));
    writeFileSync(join(t.root, "node_modules", "react-native-mmkv-lib", "package.json"), JSON.stringify({ name: "react-native-mmkv-lib", version: "1.0.0" }));
    writeFileSync(join(t.root, "node_modules", "react-native-mmkv-lib", "MmkvLib.podspec"), "Pod::Spec.new do |s|\n  s.dependency 'MMKV'\nend\n");
    const applyPatches = vi.fn(async () => {});
    await build(t.root, {}, {
      ...t.deps,
      applyPatches,
      podPinWarnings: (_root, opts) => {
        seen.push(["podPinWarnings", opts]);
        return [];
      },
    });
    expect(seen).toEqual([
      ["libraryFailures", { exclude }],
      ["podPinWarnings", { exclude }],
    ]);
    expect(applyPatches).toHaveBeenCalledWith(t.root, expect.objectContaining({ exclude }));
    const info = t.logs.findIndex((l) => l.startsWith("ℹ exclude — left out of this iOS build: react-native-mmkv-lib (rn-xtool.config.json)."));
    expect(info).toBeGreaterThanOrEqual(0);
    expect(info).toBeLessThan(t.logs.findIndex((l) => l.startsWith("▸")));

    // The real early check: the excluded library's unmapped pod is not refused.
    const real = setup({ hasIos: true, cfg: { exclude }, libraryFailures: realLibraryFailures });
    mkdirSync(join(real.root, "node_modules", "react-native-mmkv-lib"), { recursive: true });
    writeFileSync(join(real.root, "package.json"), JSON.stringify({ name: "app", dependencies: { "react-native-mmkv-lib": "1.0.0" } }));
    writeFileSync(join(real.root, "node_modules", "react-native-mmkv-lib", "package.json"), JSON.stringify({ name: "react-native-mmkv-lib", version: "1.0.0" }));
    writeFileSync(join(real.root, "node_modules", "react-native-mmkv-lib", "MmkvLib.podspec"), "Pod::Spec.new do |s|\n  s.dependency 'MMKV'\nend\n");
    await expect(build(real.root, {}, { ...real.deps, loadConfig: async () => ({ metroPort: 8081 }) })).rejects.toThrow(UnsupportedSetupError);
    await build(real.root, {}, real.deps);
    expect(real.calls).toContain("xtool-build");
  });

  it("prints no exclude line without exclude", async () => {
    const t = setup({ hasIos: true });
    await build(t.root, {}, t.deps);
    expect(t.logs.filter((l) => l.includes("exclude"))).toEqual([]);
  });

  it("prints the entitlement lines before compiling and stops on a missing file", async () => {
    const aps = "⚠ aps-environment is not available on a free team; the build continues without it; push notifications fail at runtime.";
    const ents = { file: "/x/ios/App/App.entitlements", rel: "ios/App/App.entitlements", dict: { "aps-environment": "development" } };
    for (const kind of ["bare", "expo"] as const) {
      const seen: unknown[] = [];
      const t = setup({ hasIos: kind === "bare", project: { kind } });
      await build(t.root, {}, {
        ...t.deps,
        readEntitlements: (project, ios) => {
          seen.push([project.bundleIdentifier, ios, [...t.calls]]);
          return ents;
        },
      });
      // Expo: right after expo prebuild; bare: before anything changes.
      expect(seen).toEqual([["com.example.app", join(t.root, "ios"), kind === "expo" ? ["prebuild"] : []]]);
      const at = t.logs.indexOf(aps);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(t.logs.indexOf("▸ patches"));
    }

    // The real reader on a bare app whose CODE_SIGN_ENTITLEMENTS names a missing file.
    const real = setup({ hasIos: true, project: { kind: "bare" } });
    mkdirSync(join(real.root, "ios", "HelloWorld.xcodeproj"), { recursive: true });
    const src = readFileSync(new URL("./fixtures/pbxproj/with-objc.pbxproj", import.meta.url), "utf8");
    writeFileSync(join(real.root, "ios", "HelloWorld.xcodeproj", "project.pbxproj"), withEntitlements(src, "HelloWorld/HelloWorld.entitlements"));
    const readProject: BuildDeps["readProject"] = async (...args) => ({ ...(await real.deps.readProject(...args)), root: real.root });
    await expect(build(real.root, {}, { ...real.deps, readProject })).rejects.toThrow(
      "CODE_SIGN_ENTITLEMENTS names ios/HelloWorld/HelloWorld.entitlements, which does not exist; xtool cannot sign the app " +
        "without it. Fix the setting or create the file.",
    );
    expect(real.calls).toEqual([]);
  });

  it("warns and builds on when rn-xtool.config.json allows every refusal", async () => {
    const pnpm: EarlyFailure = { id: "pnpm", allowKey: "pnpm", reason: "This project was installed with pnpm." };
    const hoisted: EarlyFailure = { id: "hoisted", allowKey: "hoisted", reason: "react-native is hoisted." };
    const lib: EarlyFailure = { id: "vendored-binaries", allowKey: "@scope/lib", reason: "@scope/lib 1.0.0 declares binaries." };
    const t = setup({
      cfg: { knownLimits: { allow: ["pnpm", "hoisted", "@scope/lib", "not-installed"] } },
      installFailures: () => [pnpm, hoisted],
      libraryFailures: () => [lib],
    });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
    const allowed = " (allowed by rn-xtool.config.json knownLimits.allow; the build may fail later)";
    expect(t.logs.filter((l) => l.startsWith("⚠ known-limits"))).toEqual([
      `⚠ known-limits — ${pnpm.reason}${allowed}`,
      `⚠ known-limits — ${hoisted.reason}${allowed}`,
      `⚠ known-limits — ${lib.reason}${allowed}`,
    ]);
  });
  it("still stops on the refusals the allow list does not name", async () => {
    const pnpm: EarlyFailure = { id: "pnpm", allowKey: "pnpm", reason: "This project was installed with pnpm." };
    const hoisted: EarlyFailure = { id: "hoisted", allowKey: "hoisted", reason: "react-native is hoisted." };
    const t = setup({ cfg: { knownLimits: { allow: ["pnpm", "react-native"] } }, installFailures: () => [pnpm, hoisted] });
    await expect(build(t.root, {}, t.deps)).rejects.toThrow(
      'react-native is hoisted.\nTo build anyway, add "hoisted" to knownLimits.allow in rn-xtool.config.json.',
    );
    expect(t.calls).toEqual([]);
    const lib: EarlyFailure = { id: "vendored-binaries", allowKey: "@scope/lib", reason: "@scope/lib 1.0.0 declares binaries." };
    const u = setup({ hasIos: true, cfg: { knownLimits: { allow: ["other-lib"] } }, libraryFailures: () => [lib] });
    await expect(build(u.root, {}, u.deps)).rejects.toBeInstanceOf(UnsupportedSetupError);
    expect(u.calls).toEqual([]);
  });
  it("builds as before without known limits", async () => {
    const t = setup({ installFailures: () => [], libraryFailures: () => [] });
    await build(t.root, {}, t.deps);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
  });
  it("stops a bare build before any step when @react-native-community/cli is missing", async () => {
    const t = setup({ hasIos: true, project: { kind: "bare", hasRnCli: false } });
    await expect(build(t.root, { clean: true }, t.deps)).rejects.toThrow(
      /@react-native-community\/cli is not installed.*npm install --save-dev @react-native-community\/cli/s,
    );
    expect(t.calls).toEqual([]);
  });
  it("cleans ios/build and ios-xtool instead of prebuilding a bare project", async () => {
    const t = setup({ hasIos: true, project: { kind: "bare" } });
    await build(t.root, { clean: true }, t.deps);
    expect(t.calls.slice(0, 2)).toEqual([`remove ${join(t.root, "ios", "build")}`, `remove ${join(t.root, "ios-xtool")}`]);
    expect(t.calls.some((c) => c.startsWith("prebuild"))).toBe(false);
    expect(t.logs).toContain("▸ clean");
  });
  it("records the project kind and the dev client in the state", async () => {
    const t = setup({ project: { kind: "bare", hasDevClient: true } });
    await build(t.root, {}, t.deps);
    expect(await readState(join(t.root, "ios-xtool"))).toMatchObject({ kind: "bare", hasDevClient: true });
    const e = setup();
    await build(e.root, {}, e.deps);
    expect(await readState(join(e.root, "ios-xtool"))).toMatchObject({ kind: "expo", hasDevClient: false });
  });
  it("records the auto-reload helper in the state only when it generates it", async () => {
    for (const kind of ["expo", "bare"] as const) {
      const t = setup({ project: { kind } });
      await build(t.root, {}, t.deps);
      expect(await readState(join(t.root, "ios-xtool"))).toMatchObject({ devSupport: true });
      const d = setup({ project: { kind, hasDevClient: true } });
      await build(d.root, {}, d.deps);
      expect(await readState(join(d.root, "ios-xtool"))).not.toHaveProperty("devSupport");
    }
  });
  it("picks another port when the configured one is busy", async () => {
    const t = setup({ isPortFree: async () => false });
    t.deps.findFreePort = async (s) => s + 3;
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Port 8081 is busy; baking Metro port 8085 into the app.");
    const ctx = (t.writeIosXtool.mock.calls[0] as unknown[])[0] as { metroPort: number };
    expect(ctx.metroPort).toBe(8085);
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8085);
  });
  it("keeps the configured port when our own Metro holds it", async () => {
    const t = setup({ isPortFree: async () => false, isMetroRunning: async () => true });
    const find = vi.fn(async (s: number) => s + 1);
    t.deps.findFreePort = find;
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Metro is already running on port 8081; keeping it.");
    expect(find).not.toHaveBeenCalled();
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8081);
  });
  it("does not probe Metro when the port is free", async () => {
    const probe = vi.fn(async () => true);
    const t = setup({ isMetroRunning: probe });
    await build(t.root, {}, t.deps);
    expect(probe).not.toHaveBeenCalled();
  });
  const warning = (l: string) => l.includes("looks like a VPN/tunnel address");
  it("warns, without blocking, when the detected route is a tunnel", async () => {
    const t = setup({ route: { ip: "10.8.0.2", dev: "tun0" } });
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain(
      '⚠ Detected LAN IP 10.8.0.2 on tun0 looks like a VPN/tunnel address; the iPhone may not reach Metro. Set "lanIp" in rn-xtool.config.json to your Wi‑Fi address if it fails.',
    );
    expect(t.calls).toContain("xtool-build");
  });
  it("does not warn for a private Wi-Fi route or a pinned lanIp", async () => {
    const a = setup();
    await build(a.root, {}, a.deps);
    expect(a.logs.some(warning)).toBe(false);
    const b = setup({ cfg: { lanIp: "1.2.3.4" }, route: { ip: "10.8.0.2", dev: "tun0" } });
    await build(b.root, {}, b.deps);
    expect(b.logs.some(warning)).toBe(false);
  });
});

describe("chooseMetroPort", () => {
  const mk = (free: number[], metro: number[], previous?: number) => ({
    configured: 8081,
    previous,
    isPortFree: async (p: number) => free.includes(p),
    isMetroRunning: async (p: number) => metro.includes(p),
    findFreePort: async (s: number) => s,
  });
  it("configured-free", async () => {
    expect(await chooseMetroPort(mk([8081], [], 8082))).toEqual({ port: 8081, reason: "configured-free" });
  });
  it("configured-metro", async () => {
    expect(await chooseMetroPort(mk([], [8081, 8082], 8082))).toEqual({ port: 8081, reason: "configured-metro" });
  });
  it("previous-free", async () => {
    expect(await chooseMetroPort(mk([8082], [], 8082))).toEqual({ port: 8082, reason: "previous-free" });
  });
  it("previous-metro (the Docker-on-8081 regression)", async () => {
    expect(await chooseMetroPort(mk([], [8082], 8082))).toEqual({ port: 8082, reason: "previous-metro" });
  });
  it("fallback when previous is busy and not Metro", async () => {
    expect(await chooseMetroPort(mk([], [], 8082))).toEqual({ port: 8082, reason: "fallback" });
  });
  it("fallback without previous", async () => {
    expect(await chooseMetroPort(mk([], []))).toEqual({ port: 8082, reason: "fallback" });
  });
  it("ignores previous when equal to configured", async () => {
    const probe = vi.fn(async () => false);
    const r = await chooseMetroPort({ ...mk([], [], 8081), isPortFree: probe });
    expect(r.reason).toBe("fallback");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("build previous port", () => {
  it("keeps the previous build's Metro port when the configured one is busy", async () => {
    const t = setup({ isPortFree: async () => false, isMetroRunning: async (p) => p === 8082 });
    await writeState(join(t.root, "ios-xtool"), { version: 1, metroPort: 8082, lanIp: "x", bundleIdentifier: "b", builtAt: "t" });
    await build(t.root, {}, t.deps);
    expect(t.logs).toContain("Port 8081 is busy (not a Metro bundler); keeping the previous build's port 8082 where Metro is running.");
    expect((await readState(join(t.root, "ios-xtool")))?.metroPort).toBe(8082);
  });
});

describe("build keeps the Wi‑Fi device", () => {
  it("carries deviceIp and deviceUdid over from the previous state", async () => {
    const t = setup();
    const dir = join(t.root, "ios-xtool");
    await writeState(dir, { version: 1, metroPort: 8081, lanIp: "x", bundleIdentifier: "b", builtAt: "t", deviceIp: "192.168.1.10", deviceUdid: "U" });
    await build(t.root, {}, t.deps);
    const s = await readState(dir);
    expect([s?.deviceIp, s?.deviceUdid]).toEqual(["192.168.1.10", "U"]);
  });
});

describe("build keeps the installed id", () => {
  it("keeps a matching installed id across builds", async () => {
    const t = setup({ project: { name: "My App", slug: "my-app" } });
    const dir = join(t.root, "ios-xtool");
    const previous = { version: 1 as const, metroPort: 8081, lanIp: "x", builtAt: "t", installedBundleId: "XTL-TEAMID0000.com.example.app" };
    await writeState(dir, { ...previous, bundleIdentifier: "com.example.app" });
    await build(t.root, {}, t.deps);
    expect(await readState(dir)).toMatchObject({ installedBundleId: "XTL-TEAMID0000.com.example.app", name: "My App", slug: "my-app" });

    const changed = setup({ project: { bundleIdentifier: "com.example.other", name: "My App", slug: "my-app" } });
    const changedDir = join(changed.root, "ios-xtool");
    await writeState(changedDir, { ...previous, bundleIdentifier: "com.example.app" });
    await build(changed.root, {}, changed.deps);
    const s = await readState(changedDir);
    expect(s?.bundleIdentifier).toBe("com.example.other");
    expect(s).not.toHaveProperty("installedBundleId");
    expect(s).toMatchObject({ name: "My App", slug: "my-app" });
  });

  it("records the app config icon when it runs expo prebuild", async () => {
    const t = setup({ hasIos: false });
    const icon = join(t.root, "assets", "icon.png");
    mkdirSync(dirname(icon), { recursive: true });
    writeFileSync(icon, "first");
    const readProject = t.deps.readProject;
    t.deps.readProject = async (...a) => ({ ...(await readProject(...a)), root: t.root, appIconSource: icon });
    await build(t.root, {}, t.deps);
    const dir = join(t.root, "ios-xtool");
    const recorded = (await readState(dir))?.prebuildIcon;
    expect(recorded).toEqual({ path: "assets/icon.png", sha256: createHash("sha256").update("first").digest("hex") });
    expect(t.writeIosXtool.mock.calls[0]?.[0]).toMatchObject({ prebuildIcon: recorded });

    // Without prebuild the record stays, so the edit is reported.
    writeFileSync(icon, "edited");
    t.deps.exists = () => true;
    await build(t.root, {}, t.deps);
    expect((await readState(dir))?.prebuildIcon).toEqual(recorded);
    expect(t.writeIosXtool.mock.calls[1]?.[0]).toMatchObject({ prebuildIcon: recorded });
  });

  it("records the app config icon silently when nothing recorded it", async () => {
    // The user ran expo prebuild, so build runs none; then a state from before the record existed.
    const t = setup({ hasIos: true });
    const icon = join(t.root, "assets", "icon.png");
    mkdirSync(dirname(icon), { recursive: true });
    writeFileSync(icon, "first");
    const readProject = t.deps.readProject;
    t.deps.readProject = async (...a) => ({ ...(await readProject(...a)), root: t.root, appIconSource: icon });
    await build(t.root, {}, t.deps);
    expect(t.calls).not.toContain("prebuild");
    const dir = join(t.root, "ios-xtool");
    const first = { path: "assets/icon.png", sha256: createHash("sha256").update("first").digest("hex") };
    expect((await readState(dir))?.prebuildIcon).toEqual(first);
    expect(t.writeIosXtool.mock.calls[0]?.[0]).toMatchObject({ prebuildIcon: first });

    // Kept on the next build, so a later edit is reported.
    writeFileSync(icon, "edited");
    await build(t.root, {}, t.deps);
    expect((await readState(dir))?.prebuildIcon).toEqual(first);

    const { prebuildIcon: _, ...older } = (await readState(dir))!;
    await writeState(dir, older);
    await build(t.root, {}, t.deps);
    expect((await readState(dir))?.prebuildIcon).toEqual({ ...first, sha256: createHash("sha256").update("edited").digest("hex") });
  });

  it("records no app icon for a bare app", async () => {
    const t = setup({ hasIos: true, project: { kind: "bare" } });
    await build(t.root, {}, t.deps);
    expect(await readState(join(t.root, "ios-xtool"))).not.toHaveProperty("prebuildIcon");
  });

  it("reads no id it cannot match", async () => {
    const cases: [string, string][] = [
      ["XTL-TEAMID0000.com.example.app", "example.app"],
      ["XTL-TEAMID0000.com.example.app", "app"],
      ["com.example.app", "com.example.app"],
      ["XTL-TEAMID0000.comXexample.app", "com.example.app"],
      ["XTL-.com.example.app", "com.example.app"],
    ];
    for (const [installedBundleId, bundleIdentifier] of cases) {
      const t = setup({ project: { bundleIdentifier } });
      const dir = join(t.root, "ios-xtool");
      await writeState(dir, { version: 1, metroPort: 8081, lanIp: "x", builtAt: "t", bundleIdentifier, installedBundleId });
      await build(t.root, {}, t.deps);
      expect(await readState(dir), installedBundleId).not.toHaveProperty("installedBundleId");
    }
  });
});

describe("build corrupt state", () => {
  it("warns, ignores the unreadable state, continues and rewrites it", async () => {
    const t = setup();
    const dir = join(t.root, "ios-xtool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".rn-xtool-state.json"), "{not json");
    await build(t.root, {}, t.deps);
    expect(t.logs.some((l) => l.startsWith("⚠ Ignoring unreadable build state (") && l.endsWith("a fresh one will be written."))).toBe(true);
    expect(t.calls).toEqual(buildSteps({ ...expoFlags, hasIos: false, clean: false }));
    expect((await readState(dir))?.metroPort).toBe(8081);
  });
});
