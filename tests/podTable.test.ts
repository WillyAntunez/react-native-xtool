import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPodEntries } from "../src/config.js";
import { projectPaths } from "../src/paths.js";
import { emptyTargetsOf } from "../src/pods/emptyTargets.js";
import { podPinWarnings } from "../src/project/earlyChecks.js";
import { POD_TABLE_ENV, mergedPodTable, podRequirementSatisfied, writePodTable } from "../src/project/podTable.js";
import { packageRoot } from "../src/tools/exec.js";

const ROOT = packageRoot();
const SCAFFOLDER = path.join(ROOT, "vendor", "rn-spm", "spm", "scaffold-package-swift.js");
const APPAUTH = {
  url: "https://github.com/openid/AppAuth-iOS",
  exact: "3.0.0",
  products: ["AppAuth"],
  // AppAuth-iOS 3.0.0's Sources/AppAuth.h: its imports, then its iOS and Mac Catalyst branch (Sources/AppAuth/iOS).
  forwardHeaders: {
    "AppAuth/AppAuth.h": [
      "OIDAuthState.h",
      "OIDAuthStateChangeDelegate.h",
      "OIDAuthStateErrorDelegate.h",
      "OIDAuthorizationRequest.h",
      "OIDAuthorizationResponse.h",
      "OIDAuthorizationService.h",
      "OIDError.h",
      "OIDErrorUtilities.h",
      "OIDExternalUserAgent.h",
      "OIDExternalUserAgentRequest.h",
      "OIDExternalUserAgentSession.h",
      "OIDGrantTypes.h",
      "OIDIDToken.h",
      "OIDRegistrationRequest.h",
      "OIDRegistrationResponse.h",
      "OIDResponseTypes.h",
      "OIDScopes.h",
      "OIDScopeUtilities.h",
      "OIDServiceConfiguration.h",
      "OIDServiceDiscovery.h",
      "OIDTokenRequest.h",
      "OIDTokenResponse.h",
      "OIDTokenUtilities.h",
      "OIDURLSessionProvider.h",
      "OIDEndSessionRequest.h",
      "OIDEndSessionResponse.h",
      "iOS/OIDAuthState+IOS.h",
      "iOS/OIDAuthorizationService+IOS.h",
      "iOS/OIDExternalUserAgentIOS.h",
      "iOS/OIDExternalUserAgentIOSCustomBrowser.h",
      "iOS/OIDExternalUserAgentCatalyst.h",
    ],
  },
};
const INTROSPECT = { url: "https://github.com/siteline/swiftui-introspect", exact: "1.5.0", products: ["SwiftUIIntrospect"] };
/** ML Kit's source pods (spec goal 3.1; the product names G1 linked). */
const ML_KIT_SOURCES = {
  GTMSessionFetcher: {
    url: "https://github.com/google/gtm-session-fetcher",
    exact: "3.5.0",
    products: ["GTMSessionFetcherCore"],
    subspecs: { Core: ["GTMSessionFetcherCore"] },
  },
  GoogleUtilities: {
    url: "https://github.com/google/GoogleUtilities",
    exact: "8.1.5",
    products: ["GULLogger", "GULUserDefaults"],
    subspecs: { Logger: ["GULLogger"], UserDefaults: ["GULUserDefaults"] },
  },
  GoogleDataTransport: { url: "https://github.com/google/GoogleDataTransport", exact: "10.1.1", products: ["GoogleDataTransport"] },
  GoogleToolboxForMac: {
    url: "https://github.com/google/google-toolbox-for-mac",
    exact: "6.0.1",
    products: ["GTMLogger", "GTMNSData_zlib"],
    subspecs: { Logger: ["GTMLogger"], "NSData+zlib": ["GTMNSData_zlib"] },
    outsideRequirement: "4.x ships no Package.swift; 6.0.1 keeps the GTMLogger API ML Kit links against",
    emptyTargets: ["GTMDefines"],
  },
};
const SHIPPED_SOURCE = Object.fromEntries(["AppAuth", ...Object.keys(ML_KIT_SOURCES)].map((p) => [p, "rn-xtool"]));

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("the pod table", () => {
  it("the shipped table passes the config's shape check", () => {
    const shipped = JSON.parse(readFileSync(path.join(ROOT, "data", "pods.json"), "utf8")) as { pods: unknown };
    expect(() => checkPodEntries("data/pods.json", shipped.pods)).not.toThrow();
    expect(shipped).toEqual({ pods: { AppAuth: APPAUTH, ...ML_KIT_SOURCES } });
  });

  it("merges the config over rn-xtool's table over the scaffolder's", () => {
    expect(mergedPodTable()).toEqual({
      pods: { SwiftUIIntrospect: INTROSPECT, AppAuth: APPAUTH, ...ML_KIT_SOURCES },
      source: { SwiftUIIntrospect: "scaffolder", ...SHIPPED_SOURCE },
    });
    const mine = { url: "https://github.com/example/AppAuth-iOS", exact: "2.1.0", product: "AppAuth" };
    const mmkv = { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] };
    const introspect = { ...INTROSPECT, exact: "1.6.0" };
    // Per pod, the config overrides only the fields it names: AppAuth keeps its forwarder.
    expect(mergedPodTable({ AppAuth: mine, MMKV: mmkv, SwiftUIIntrospect: introspect })).toEqual({
      pods: {
        SwiftUIIntrospect: introspect,
        AppAuth: { url: mine.url, exact: "2.1.0", products: ["AppAuth"], forwardHeaders: APPAUTH.forwardHeaders },
        ...ML_KIT_SOURCES,
        MMKV: mmkv,
      },
      source: { ...SHIPPED_SOURCE, SwiftUIIntrospect: "config", AppAuth: "config", MMKV: "config" },
    });
  });

  it("merges a config entry over the shipped one field by field", () => {
    const pinned = { url: APPAUTH.url, exact: "3.1.0", products: ["AppAuth"] };
    expect(mergedPodTable({ AppAuth: pinned }).pods.AppAuth).toEqual({ ...APPAUTH, exact: "3.1.0" });
    // An empty forwardHeaders (or subspecs) removes the shipped ones.
    expect(mergedPodTable({ AppAuth: { ...pinned, forwardHeaders: {} } }).pods.AppAuth).toEqual({ ...pinned, forwardHeaders: {} });
    // `product` replaces the shipped products.
    expect(mergedPodTable({ AppAuth: { url: APPAUTH.url, exact: "3.0.0", product: "AppAuthCore" } }).pods.AppAuth).toEqual({
      ...APPAUTH,
      products: ["AppAuthCore"],
    });
    const subspecs = { Core: ["AppAuthCore"] };
    expect(mergedPodTable({ AppAuth: { ...pinned, subspecs } }).pods.AppAuth).toEqual({ ...APPAUTH, exact: "3.1.0", subspecs });
  });

  it("does not carry the shipped outsideRequirement and emptyTargets over a config pin of another version", () => {
    const toolbox = ML_KIT_SOURCES.GoogleToolboxForMac;
    const { outsideRequirement: _checked, emptyTargets: _empty, ...rest } = toolbox;
    // Another version, or another URL: the shipped reason was checked for 6.0.1 of Google's repository only.
    expect(mergedPodTable({ GoogleToolboxForMac: { url: toolbox.url, exact: "7.0.0", products: ["GTMLogger"] } }).pods.GoogleToolboxForMac).toEqual({
      ...rest,
      exact: "7.0.0",
      products: ["GTMLogger"],
    });
    expect(
      mergedPodTable({ GoogleToolboxForMac: { url: "https://github.com/example/gtm", exact: "6.0.1", products: ["GTMLogger"] } }).pods
        .GoogleToolboxForMac,
    ).not.toHaveProperty("emptyTargets");
    // The same pin keeps them, and a config's own values win.
    const same = mergedPodTable({ GoogleToolboxForMac: { url: toolbox.url, exact: "6.0.1", products: ["GTMLogger"] } }).pods.GoogleToolboxForMac;
    expect(same).toHaveProperty("outsideRequirement", toolbox.outsideRequirement);
    expect(same).toHaveProperty("emptyTargets", ["GTMDefines"]);
    expect(
      mergedPodTable({ GoogleToolboxForMac: { url: toolbox.url, exact: "7.0.0", products: ["GTMLogger"], emptyTargets: ["GTMOther"] } }).pods
        .GoogleToolboxForMac,
    ).toHaveProperty("emptyTargets", ["GTMOther"]);
    expect(
      mergedPodTable({ GoogleToolboxForMac: { url: toolbox.url, exact: "7.0.0", products: ["GTMLogger"], outsideRequirement: "mine" } }).pods
        .GoogleToolboxForMac,
    ).toHaveProperty("outsideRequirement", "mine");
  });

  it("clears the shipped emptyTargets with a config's empty list", () => {
    const toolbox = ML_KIT_SOURCES.GoogleToolboxForMac;
    const table = mergedPodTable({ GoogleToolboxForMac: { url: toolbox.url, exact: "6.0.1", products: ["GTMLogger"], emptyTargets: [] } });
    expect(table.pods.GoogleToolboxForMac).toHaveProperty("emptyTargets", []);
    expect(emptyTargetsOf(table, ["GoogleToolboxForMac"])).toEqual([]);
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
      const scaffolderShape = Object.fromEntries(
        Object.entries(ML_KIT_SOURCES).map(([pod, { outsideRequirement: _o, emptyTargets: _e, ...entry }]) => [pod, entry]),
      );
      expect(loadPodTable()).toEqual({
        SwiftUIIntrospect: INTROSPECT,
        AppAuth: APPAUTH,
        ...scaffolderShape,
        MMKV: { url: "https://github.com/Tencent/MMKV", exact: "2.2.4", products: ["MMKV"] },
      });
    } finally {
      if (saved === undefined) delete process.env[POD_TABLE_ENV];
      else process.env[POD_TABLE_ENV] = saved;
    }
    expect(POD_TABLE_ENV).toBe("RN_SPM_POD_TABLE");
  });

  it("writes the binary pods into the table file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-pods-"));
    tmp.push(root);
    const table = mergedPodTable(undefined, { GoogleMLKit: { product: "GoogleMLKit" } });
    expect(table.binary).toEqual({ GoogleMLKit: { product: "GoogleMLKit" } });
    const file = writePodTable(projectPaths(root), table);
    const written = JSON.parse(readFileSync(file, "utf8")) as { pods: Record<string, unknown> };
    expect(written.pods["GoogleMLKit"]).toEqual({ binary: { product: "GoogleMLKit" } });
    expect(written.pods["AppAuth"]).toEqual(APPAUTH);
    const { loadPodTable } = createRequire(import.meta.url)(SCAFFOLDER) as { loadPodTable(): Record<string, unknown> };
    const saved = process.env[POD_TABLE_ENV];
    process.env[POD_TABLE_ENV] = file;
    try {
      expect(loadPodTable()["GoogleMLKit"]).toEqual({ binary: { product: "GoogleMLKit" } });
    } finally {
      if (saved === undefined) delete process.env[POD_TABLE_ENV];
      else process.env[POD_TABLE_ENV] = saved;
    }
  });

  it("a table entry wins over a binary pod", () => {
    const table = mergedPodTable(undefined, { GoogleToolboxForMac: { product: "GoogleToolboxForMac" }, MLKitVision: { product: "MLKitVision" } });
    expect(table.binary).toEqual({ MLKitVision: { product: "MLKitVision" } });
    expect(table.pods.GoogleToolboxForMac).toEqual(ML_KIT_SOURCES.GoogleToolboxForMac);
    // A config entry wins too.
    const mine = { url: "https://github.com/example/mlkit-vision", exact: "1.0.0", products: ["MLKitVision"] };
    expect(mergedPodTable({ MLKitVision: mine }, { MLKitVision: { product: "MLKitVision" } }).binary).toBeUndefined();
  });

  it("package.json ships data/", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("data");
  });
});

describe("pod pins and podspec requirements", () => {
  it.each<[string, string[], boolean]>([
    ["3.0.0", [">= 1.7.6"], true],
    ["3.0.0", ["~> 1.0"], false],
    ["1.5.9", ["~> 1.5.0"], true],
    ["1.6.0", ["~> 1.5.0"], false],
    ["1.5.0", ["~> 1.5.0"], true],
    ["1.4.9", ["~> 1.5.0"], false],
    ["1.9.0", ["~> 1.0"], true],
    ["2.0.0", ["~> 1"], false],
    ["3.0.0", ["= 3.0.0"], true],
    ["3.0.1", ["= 3.0.0"], false],
    ["3.0.0", ["3.0"], true],
    ["3.0.0", ["> 3"], false],
    ["3.0.1", ["> 3"], true],
    ["3.0.0", ["< 3"], false],
    ["2.9.9", ["< 3"], true],
    ["3.0.0", ["<= 3.0"], true],
    ["3.0.0", ["!= 3.0.0"], false],
    ["1.5.0", ["  >= 1.0", " < 2.0 "], true],
    ["2.0.0", [">= 1.0", "< 2.0"], false],
    ["1.5.0", [">= 1.0, < 2.0"], true],
    ["1.5.0", [], true],
    ["1.5.0", ["~> #{version}"], true],
  ])("%s against %j: %s", (version, requirements, expected) => {
    expect(podRequirementSatisfied(version, requirements)).toBe(expected);
  });

  /** A project with react-native-app-auth's shape; `requirement` is its AppAuth requirement. */
  function appAuthProject(requirement: string, rnConfig?: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "rn-xtool-pins-"));
    tmp.push(root);
    const lib = path.join(root, "node_modules", "react-native-app-auth");
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { "react-native-app-auth": "8.5.1" } }));
    writeFileSync(path.join(lib, "package.json"), JSON.stringify({ name: "react-native-app-auth", version: "8.5.1" }));
    writeFileSync(
      path.join(lib, "react-native-app-auth.podspec"),
      `Pod::Spec.new do |s|\n  s.dependency 'React-Core'\n  s.dependency 'AppAuth', ${requirement}\nend\n`,
    );
    if (rnConfig !== undefined) writeFileSync(path.join(root, "react-native.config.js"), rnConfig);
    return root;
  }

  it("warns when the pinned version misses the podspec's requirement", () => {
    const root = appAuthProject("'>= 4.0'");
    expect(podPinWarnings(root, mergedPodTable())).toEqual([
      '⚠ AppAuth 3.0.0 (rn-xtool table) is outside react-native-app-auth\'s requirement ">= 4.0"',
    ]);
    const pods = { AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "3.1.0", products: ["AppAuth"] } };
    expect(podPinWarnings(appAuthProject("'>= 1.7.6', '< 3.1'"), mergedPodTable(pods))).toEqual([
      '⚠ AppAuth 3.1.0 (rn-xtool.config.json) is outside react-native-app-auth\'s requirement ">= 1.7.6, < 3.1"',
    ]);
  });

  it("prints an ℹ line for a pin the entry marks as checked", () => {
    const pods = { AppAuth: { url: "https://github.com/openid/AppAuth-iOS", exact: "3.0.0", products: ["AppAuth"], outsideRequirement: "3.x keeps the API it uses" } };
    expect(podPinWarnings(appAuthProject("'>= 4.0'"), mergedPodTable(pods))).toEqual([
      'ℹ AppAuth 3.0.0 (rn-xtool.config.json) is outside react-native-app-auth\'s requirement ">= 4.0": 3.x keeps the API it uses',
    ]);
  });

  it("prints nothing when the requirement holds or the library is excluded", () => {
    expect(podPinWarnings(appAuthProject("'>= 1.7.6'"), mergedPodTable())).toEqual([]);
    expect(podPinWarnings(appAuthProject("'>= 4.0'"), mergedPodTable(), { exclude: ["react-native-app-auth"] })).toEqual([]);
    const outOfIos = "module.exports = { dependencies: { 'react-native-app-auth': { platforms: { ios: null } } } };\n";
    expect(podPinWarnings(appAuthProject("'>= 4.0'", outOfIos), mergedPodTable())).toEqual([]);
  });
});
