import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import { EMPTY_AR_ARCHIVE, headersXcframeworkInfoPlist, readXcframeworkLibraries } from "../../src/pipeline/rnArtifacts.js";
import { PodsError } from "../../src/pods/format.js";
import {
  POD_SLICE,
  frameworkModuleMap,
  generatedModuleMap,
  rewriteFrameworkModuleMap,
  writeHeadersXcframework,
} from "../../src/pods/xcframework.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
const LABEL = "MLKitVision 9.0.0 (needed by @react-native-ml-kit/text-recognition)";
const MAP_REL = "Frameworks/MLKitVision.framework/Modules/module.modulemap";
/** MLKitVision's shape: a framework module with an umbrella header, `module *` and link lines. */
const VISION_MAP = `framework module MLKitVision {
  umbrella header "MLKitVision.h"
  export *
  module * { export * }
  link framework "AVFoundation"
  link framework "CoreMedia"
  link "c++"
}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pods-xcf-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, text = ""): void {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}

describe("rewriteFrameworkModuleMap", () => {
  it("rewrites a framework module map and keeps its link lines", () => {
    expect(rewriteFrameworkModuleMap(VISION_MAP, MAP_REL, LABEL)).toBe(VISION_MAP.replace("framework module", "module"));
  });

  it("keeps comments, attributes and strings that mention frameworks", () => {
    const text = `// a framework module, generated\n/* framework module X */ framework  module MLKitVision [system] {\n  header "framework module.h"\n  link framework "UIKit"\n}\n`;
    expect(rewriteFrameworkModuleMap(text, MAP_REL, LABEL)).toBe(
      `// a framework module, generated\n/* framework module X */ module MLKitVision [system] {\n  header "framework module.h"\n  link framework "UIKit"\n}\n`,
    );
  });

  it("keeps a module map without a framework module as it is", () => {
    const text = 'module MLKitVision {\n  header "MLKitVision.h"\n  export *\n}\n';
    expect(rewriteFrameworkModuleMap(text, MAP_REL, LABEL)).toBe(text);
  });

  it.each([
    ["a framework submodule", "framework module A {\n  explicit framework module B {\n    header \"B.h\"\n  }\n}\n"],
    ["a framework submodule", "framework module A {\n  framework module B {}\n}\n"],
    ["another framework module", "framework module A {}\nframework module A_Private {}\n"],
    ['an umbrella directory ("Headers")', 'framework module A {\n  umbrella "Headers"\n  export *\n}\n'],
    ['a path relative to the framework ("../PrivateHeaders/A+Private.h")', 'framework module A {\n  private header "../PrivateHeaders/A+Private.h"\n}\n'],
    ['a path relative to the framework ("/usr/include/a.h")', 'module A {\n  textual header "/usr/include/a.h"\n}\n'],
  ])("stops on %s", (what, text) => {
    expect(() => rewriteFrameworkModuleMap(text, MAP_REL, LABEL)).toThrow(
      new PodsError(`${LABEL}: ${MAP_REL} names the framework bundle (${what}), which rn-xtool cannot rewrite for SwiftPM. See ${LINK}`),
    );
  });
});

describe("frameworkModuleMap", () => {
  const FW = "Frameworks/MLKitVision.framework";

  it("rewrites the framework's own module map", async () => {
    write(`${FW}/Modules/module.modulemap`, VISION_MAP);
    write(`${FW}/Headers/MLKitVision.h`);
    expect(await frameworkModuleMap(path.join(dir, FW), "MLKitVision", FW, LABEL)).toBe(VISION_MAP.replace("framework module", "module"));
  });

  it("generates a module map from the umbrella header", async () => {
    write(`${FW}/Headers/MLKitVision.h`);
    expect(await frameworkModuleMap(path.join(dir, FW), "MLKitVision", FW, LABEL)).toBe(
      'module MLKitVision {\n  umbrella header "MLKitVision.h"\n  export *\n  module * { export * }\n}\n',
    );
    expect(generatedModuleMap("MLKitVision")).toBe(
      'module MLKitVision {\n  umbrella header "MLKitVision.h"\n  export *\n  module * { export * }\n}\n',
    );
  });

  it("stops without a module map and without an umbrella header", async () => {
    write(`${FW}/Headers/Other.h`);
    await expect(frameworkModuleMap(path.join(dir, FW), "MLKitVision", FW, LABEL)).rejects.toThrow(
      new PodsError(
        `${LABEL}: ${FW} has no Modules/module.modulemap and no Headers/MLKitVision.h, so rn-xtool cannot make a module for it. See ${LINK}`,
      ),
    );
  });

  it("stops on a private module map", async () => {
    write(`${FW}/Modules/module.modulemap`, VISION_MAP);
    write(`${FW}/Modules/module.private.modulemap`, "framework module MLKitVision_Private {}\n");
    await expect(frameworkModuleMap(path.join(dir, FW), "MLKitVision", FW, LABEL)).rejects.toThrow(
      new PodsError(
        `${LABEL}: ${FW}/Modules/module.private.modulemap names the framework bundle (a module.private.modulemap), which rn-xtool cannot rewrite for SwiftPM. See ${LINK}`,
      ),
    );
  });

  it("stops on a framework submodule, naming the map", async () => {
    write(`${FW}/Modules/module.modulemap`, "framework module MLKitVision {\n  explicit framework module X {}\n}\n");
    await expect(frameworkModuleMap(path.join(dir, FW), "MLKitVision", FW, LABEL)).rejects.toThrow(
      `${LABEL}: ${MAP_REL} names the framework bundle (a framework submodule)`,
    );
  });
});

describe("writeHeadersXcframework", () => {
  it("writes the Info.plist headersXcframeworkInfoPlist writes, and reads back", async () => {
    write("src/MLKitVision.h", "// umbrella");
    const map = generatedModuleMap("MLKitVision");
    const xcf = await writeHeadersXcframework(path.join(dir, "out"), "MLKitVision", { from: path.join(dir, "src"), files: ["MLKitVision.h"] }, map);
    expect(xcf).toBe(path.join(dir, "out", "MLKitVision.xcframework"));
    expect(readFileSync(path.join(xcf, "Info.plist"), "utf8")).toBe(headersXcframeworkInfoPlist("MLKitVision", [POD_SLICE]));
    expect(readXcframeworkLibraries(xcf)).toEqual([POD_SLICE]);
    expect(readFileSync(path.join(xcf, "ios-arm64", "libMLKitVision-ios-arm64.a"))).toEqual(EMPTY_AR_ARCHIVE);
    expect(readFileSync(path.join(xcf, "ios-arm64", "Headers", "MLKitVision", "module.modulemap"), "utf8")).toBe(map);
    expect(readFileSync(path.join(xcf, "ios-arm64", "Headers", "MLKitVision", "MLKitVision.h"), "utf8")).toBe("// umbrella");
  });

  it("keeps nested header folders", async () => {
    write("src/MLKitVision.h");
    write("src/Private/Deep/MLKVisionImage+Internal.h", "deep");
    const xcf = await writeHeadersXcframework(
      path.join(dir, "out"),
      "MLKitVision",
      { from: path.join(dir, "src"), files: ["MLKitVision.h", "Private/Deep/MLKVisionImage+Internal.h"] },
      generatedModuleMap("MLKitVision"),
    );
    expect(readFileSync(path.join(xcf, "ios-arm64", "Headers", "MLKitVision", "Private", "Deep", "MLKVisionImage+Internal.h"), "utf8")).toBe("deep");
  });
});
