import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as plist from "plist";
import { resolveBuildVars, transformInfoPlist } from "../src/plist.js";

const template = readFileSync(
  new URL("./fixtures/Info.template.plist", import.meta.url),
  "utf8",
);

const vars = {
  PRODUCT_NAME: "App",
  PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
  PRODUCT_MODULE_NAME: "App",
  EXECUTABLE_NAME: "App",
  DEVELOPMENT_LANGUAGE: "en",
  PRODUCT_BUNDLE_PACKAGE_TYPE: "APPL",
};

describe("resolveBuildVars", () => {
  it("resolves $(PRODUCT_MODULE_NAME).SceneDelegate to App.SceneDelegate", () => {
    expect(
      resolveBuildVars(template, { ...vars, RCT_METRO_PORT: "8081" }),
    ).toContain("App.SceneDelegate");
  });

  it("resolves both $(NAME) and ${NAME} forms", () => {
    expect(resolveBuildVars("$(A)-${A}", { A: "x" })).toBe("x-x");
  });

  it("throws on unresolved variables, naming them sorted and unique", () => {
    expect(() => resolveBuildVars("$(B) ${A} $(B)", {})).toThrow(
      "Unresolved build variable(s): A, B",
    );
    const { PRODUCT_MODULE_NAME: _omit, ...rest } = vars;
    expect(() => resolveBuildVars(template, rest)).toThrow(
      /PRODUCT_MODULE_NAME/,
    );
  });

  it("throws on modifier forms and unterminated tokens", () => {
    expect(() =>
      resolveBuildVars("$(PRODUCT_NAME:rfc1034identifier)", vars),
    ).toThrow("Unresolved build variable(s): PRODUCT_NAME:rfc1034identifier");
    expect(() => resolveBuildVars("x $(A", vars)).toThrow(
      "Unresolved build variable(s): A",
    );
    expect(() => resolveBuildVars("$(A}", {})).toThrow(
      "Unresolved build variable(s): A",
    );
  });

  it("escapes XML-special characters in values", () => {
    expect(resolveBuildVars("<string>$(A)</string>", { A: "A & B" })).toBe(
      "<string>A &amp; B</string>",
    );
  });

  it("throws on RCT_METRO_PORT when not supplied", () => {
    expect(() => resolveBuildVars(template, vars)).toThrow(
      "Unresolved build variable(s): RCT_METRO_PORT",
    );
  });
});

describe("transformInfoPlist", () => {
  const opts = { vars, metroPort: 8082 };

  it("rewrites launch screen, metro port, local network keys", () => {
    const out = plist.parse(transformInfoPlist(template, opts)) as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty("UILaunchStoryboardName");
    expect(out.UILaunchScreen).toEqual({});
    expect(out.RCTMetroPort).toBe("8082");
    expect(out.NSLocalNetworkUsageDescription).toBe(
      "Connects to the Metro development server on your local network.",
    );
  });

  it("resolves SceneDelegate end to end", () => {
    const out = plist.parse(transformInfoPlist(template, opts)) as Record<
      string,
      any
    >;
    const scene =
      out.UIApplicationSceneManifest.UISceneConfigurations
        .UIWindowSceneSessionRoleApplication[0];
    expect(scene.UISceneDelegateClassName).toBe("App.SceneDelegate");
  });

  it("handles special characters in values and rejects modifier forms", () => {
    const out = plist.parse(
      transformInfoPlist(template, {
        ...opts,
        vars: { ...vars, PRODUCT_NAME: "A & B" },
      }),
    ) as Record<string, unknown>;
    expect(out.CFBundleName).toBe("A & B");
    const bad = template.replace(
      "$(PRODUCT_NAME)",
      "$(PRODUCT_NAME:rfc1034identifier)",
    );
    expect(() => transformInfoPlist(bad, opts)).toThrow(
      /PRODUCT_NAME:rfc1034identifier/,
    );
  });

  it("is idempotent and keeps _http._tcp exactly once", () => {
    const once = transformInfoPlist(template, opts);
    const twice = transformInfoPlist(once, opts);
    expect(twice).toBe(once);
    const out = plist.parse(twice) as { NSBonjourServices: string[] };
    expect(
      out.NSBonjourServices.filter((s) => s === "_http._tcp"),
    ).toHaveLength(1);
  });

  it("preserves existing NSBonjourServices entries", () => {
    const xml = plist.build({ NSBonjourServices: ["_foo._tcp"] });
    const out = plist.parse(transformInfoPlist(xml, opts)) as {
      NSBonjourServices: string[];
    };
    expect(out.NSBonjourServices).toEqual(["_foo._tcp", "_http._tcp"]);
  });
});
