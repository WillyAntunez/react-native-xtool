import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../src/docs.js";
import { checkCodegenClasses, codegenClasses, hasCodegenClasses } from "../src/pipeline/codegenClasses.js";
import type { NmRunner } from "../src/pipeline/symbols.js";

const LINK = troubleshootingUrl("rctthirdpartycomponentsprovider-thirdpartyfabriccomponents");
let root: string;
let app: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codegen-classes-"));
  app = path.join(root, "ios-xtool", "xtool", "App.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(path.join(app, "App"), "binary");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const codegenDir = () => path.join(root, "ios", "build", "generated", "ios", "ReactCodegen");
/** React Native's generated RCTThirdPartyComponentsProvider.mm with these mapping lines. */
function components(lines: string[]): void {
  mkdirSync(codegenDir(), { recursive: true });
  writeFileSync(
    path.join(codegenDir(), "RCTThirdPartyComponentsProvider.mm"),
    "#import <Foundation/Foundation.h>\n\n@implementation RCTThirdPartyComponentsProvider\n\n" +
      "+ (NSDictionary<NSString *, Class<RCTComponentViewProtocol>> *)thirdPartyFabricComponents\n{\n" +
      "  dispatch_once(&nativeComponentsToken, ^{\n    thirdPartyComponents = @{\n" +
      lines.map((l) => `\t\t${l}\n`).join("") +
      "    };\n  });\n\n  return thirdPartyComponents;\n}\n\n@end\n",
  );
}
/** React Native's generated RCTModuleProviders.mm with these mapping lines. */
function modules(lines: string[]): void {
  mkdirSync(codegenDir(), { recursive: true });
  writeFileSync(
    path.join(codegenDir(), "RCTModuleProviders.mm"),
    "@implementation RCTModuleProviders\n\n+ (NSDictionary<NSString *, id<RCTModuleProvider>> *)moduleProviders\n{\n" +
      "  dispatch_once(&onceToken, ^{\n    NSDictionary<NSString *, NSString *> * moduleMapping = @{\n" +
      lines.map((l) => `      \t\t${l}\n`).join("") +
      "    };\n\n    for (NSString *key in moduleMapping) {\n" +
      '      if (!klass) {\n        RCTLogError(@"Module provider %@ cannot be found in the runtime", moduleProviderName);\n      }\n' +
      "    }\n  });\n  return providers;\n}\n\n@end\n",
  );
}
const screen = (component: string, cls: string) => `@"${component}": NSClassFromString(@"${cls}"), // react-native-screens`;
/** A fake llvm-nm: each Mach-O defines these Objective-C classes. */
function fakeNm(byFile: Record<string, string[]>, seen: string[] = []): NmRunner {
  return async (args) => {
    expect(args).toEqual(["--arch=arm64", "--defined-only", "-j", args.at(-1)!]);
    const file = args.at(-1)!;
    seen.push(path.relative(app, file));
    const classes = byFile[path.relative(app, file)];
    if (classes === undefined) throw new Error(`unexpected file ${file}`);
    return ["_main", ...classes.flatMap((c) => [`_OBJC_CLASS_$_${c}`, `_OBJC_METACLASS_$_${c}`])].join("\n");
  };
}

describe("codegenClasses", () => {
  it("reads the component and module providers, with the library each line names", () => {
    components([
      '@"RNSScreen": NSClassFromString(@"RNSScreenView"), // react-native-screens',
      '@"RNDateTimePicker": NSClassFromString(@"RNDateTimePickerComponentView"), // @react-native-community/datetimepicker',
      '@"Legacy": [LegacyView class],',
    ]);
    modules(['@"RNCWebViewModule": @"RNCWebViewModule", // react-native-webview']);
    expect(codegenClasses(path.join(root, "ios", "build", "generated", "ios"))).toEqual([
      { kind: "component", name: "RNSScreen", className: "RNSScreenView", library: "react-native-screens" },
      {
        kind: "component",
        name: "RNDateTimePicker",
        className: "RNDateTimePickerComponentView",
        library: "@react-native-community/datetimepicker",
      },
      { kind: "component", name: "Legacy", className: "LegacyView" },
      { kind: "module", name: "RNCWebViewModule", className: "RNCWebViewModule", library: "react-native-webview" },
    ]);
    expect(hasCodegenClasses(root)).toBe(true);
  });

  it("finds nothing without providers, or with empty ones", () => {
    expect(hasCodegenClasses(root)).toBe(false);
    components([]);
    modules([]);
    expect(hasCodegenClasses(root)).toBe(false);
  });
});

describe("checkCodegenClasses", () => {
  it("passes when every class is in the App binary or an embedded framework, and keeps the app", async () => {
    components([screen("RNSScreen", "RNSScreenView"), '@"SwiftView": NSClassFromString(@"MyKit.SwiftView"), // my-kit']);
    modules(['@"RNCWebViewModule": @"RNCWebViewModule", // react-native-webview']);
    mkdirSync(path.join(app, "Frameworks", "MyKit.framework"), { recursive: true });
    writeFileSync(path.join(app, "Frameworks", "MyKit.framework", "MyKit"), "binary");
    writeFileSync(path.join(root, "ios-xtool", "xtool", "App.ipa"), "ipa");
    const seen: string[] = [];
    const nm = fakeNm({ App: ["RNSScreenView", "RNCWebViewModule"], "Frameworks/MyKit.framework/MyKit": ["_TtC5MyKit9SwiftView"] }, seen);
    await expect(checkCodegenClasses(root, app, nm)).resolves.toEqual([]);
    expect(seen).toEqual(["App", "Frameworks/MyKit.framework/MyKit"]);
    expect(existsSync(app)).toBe(true);
    expect(existsSync(path.join(root, "ios-xtool", "xtool", "App.ipa"))).toBe(true);
  });

  it("does not read the binaries when codegen wrote no providers", async () => {
    await expect(checkCodegenClasses(root, app, async () => expect.fail("nm ran"))).resolves.toEqual([]);
  });

  it("refuses an app without the classes react-native-screens 4.24.0 declares, and removes it and its .ipa", async () => {
    // The real app's crash: RNScreens.o compiled from the common subspec's C++ alone, so no RNS class was linked.
    const screens = [
      ["RNSFullWindowOverlay", "RNSFullWindowOverlay"],
      ["RNSModalScreen", "RNSModalScreen"],
      ["RNSScreenContainer", "RNSScreenContainerView"],
      ["RNSScreenContentWrapper", "RNSScreenContentWrapper"],
      ["RNSScreenFooter", "RNSScreenFooter"],
      ["RNSScreen", "RNSScreenView"],
      ["RNSScreenNavigationContainer", "RNSScreenNavigationContainerView"],
      ["RNSScreenStackHeaderConfig", "RNSScreenStackHeaderConfig"],
      ["RNSScreenStackHeaderSubview", "RNSScreenStackHeaderSubview"],
      ["RNSScreenStack", "RNSScreenStackView"],
    ];
    components([
      '@"RNGestureHandlerButton": NSClassFromString(@"RNGestureHandlerButtonComponentView"), // react-native-gesture-handler',
      ...screens.map(([c, cls]) => screen(c!, cls!)),
    ]);
    writeFileSync(path.join(root, "ios-xtool", "xtool", "App.ipa"), "ipa");
    const nm = fakeNm({ App: ["RNGestureHandlerButtonComponentView", "AppDelegate"] });
    await expect(checkCodegenClasses(root, app, nm)).rejects.toThrow(
      "React Native's codegen names classes the packed app does not define, so rn-xtool removed it and does not install it:\n" +
        "  - RNSFullWindowOverlay (component RNSFullWindowOverlay, react-native-screens)\n" +
        "  - RNSModalScreen (component RNSModalScreen, react-native-screens)\n" +
        "  - RNSScreenContainerView (component RNSScreenContainer, react-native-screens)\n" +
        "  - RNSScreenContentWrapper (component RNSScreenContentWrapper, react-native-screens)\n" +
        "  - RNSScreenFooter (component RNSScreenFooter, react-native-screens)\n" +
        "  - RNSScreenView (component RNSScreen, react-native-screens)\n" +
        "  - RNSScreenNavigationContainerView (component RNSScreenNavigationContainer, react-native-screens)\n" +
        "  - RNSScreenStackHeaderConfig (component RNSScreenStackHeaderConfig, react-native-screens)\n" +
        "  - and 2 more\n" +
        "With a component class missing, the app would crash at start: +[RCTThirdPartyComponentsProvider " +
        "thirdPartyFabricComponents] throws NSInvalidArgumentException (-[__NSPlaceholderDictionary " +
        "initWithObjects:forKeys:count:]: attempt to insert nil object).\n" +
        "Check the sources of node_modules/react-native-screens/Package.swift: its target was built without the files " +
        "that define them. A scaffold persisted in patches/ by an older rn-xtool can be the cause: delete that patch, " +
        "reinstall the library and build again.\n" +
        `See ${LINK}`,
    );
    expect(existsSync(app)).toBe(false);
    expect(existsSync(path.join(root, "ios-xtool", "xtool", "App.ipa"))).toBe(false);
  });

  it("names a missing module provider, and a library from its package.json when the provider line does not", async () => {
    components(['@"FooView": NSClassFromString(@"FooComponentView"),', '@"Bar": [BarView class],']);
    modules(['@"RNCWebViewModule": @"RNCWebViewModule", // react-native-webview']);
    const foo = path.join(root, "node_modules", "react-native-foo");
    mkdirSync(foo, { recursive: true });
    writeFileSync(
      path.join(foo, "package.json"),
      JSON.stringify({ name: "react-native-foo", codegenConfig: { ios: { components: { FooView: { className: "FooComponentView" } } } } }),
    );
    const autolinking = path.join(root, "ios", "build", "generated", "autolinking");
    mkdirSync(autolinking, { recursive: true });
    writeFileSync(path.join(autolinking, "autolinking.json"), JSON.stringify({ dependencies: { "react-native-foo": { root: foo } } }));
    const error = await checkCodegenClasses(root, app, fakeNm({ App: ["AppDelegate"] })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      "  - FooComponentView (component FooView, react-native-foo)\n" +
        "  - BarView (component Bar, a library)\n" +
        "  - RNCWebViewModule (module RNCWebViewModule, react-native-webview)\n",
    );
    expect(message).toContain('With a module class missing, React Native logs "Module provider <class> cannot be found in the runtime"');
    expect(message).toContain("Check the sources of node_modules/react-native-foo/Package.swift, node_modules/react-native-webview/Package.swift:");
  });

  it("only says so when the binaries list no class at all (a stripped binary), and keeps the app", async () => {
    components([screen("RNSScreen", "RNSScreenView")]);
    await expect(checkCodegenClasses(root, app, fakeNm({ App: [] }))).resolves.toEqual([
      "ℹ The packed app's binaries list no Objective-C class symbols, so rn-xtool could not check the 1 classes React " +
        "Native's codegen providers name.",
    ]);
    expect(existsSync(app)).toBe(true);
  });
});
