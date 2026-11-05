import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { troubleshootingUrl } from "../../src/docs.js";
import type { NmRunner } from "../../src/pipeline/symbols.js";
import { postPackChecks, type PostPackPods } from "../../src/pods/postPack.js";

const LINK = troubleshootingUrl("cocoapods-binaries");
let dir: string;
let app: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pods-postpack-"));
  app = path.join(dir, "App.app");
  mkdirSync(app);
  writeFileSync(
    path.join(app, "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>\n',
  );
  writeFileSync(path.join(app, "App"), "binary");
  for (const key of ["LatinOCRResources", "KoreanOCRResources"]) {
    mkdirSync(path.join(app, `${key}.bundle`));
    writeFileSync(path.join(app, `${key}.bundle`, "Info.plist"), "<plist/>");
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const archive = (name: string): string => path.join(dir, "pod-binaries", "archives", `lib${name}.a`);
const pods = (): PostPackPods => ({
  binaryTargets: ["MLKitCommon", "MLKitTextRecognition", "MLKit"],
  archives: [
    { path: archive("MLKitCommon"), owner: "MLKitCommon 13.0.0" },
    { path: archive("MLKitTextRecognition"), owner: "MLKitTextRecognition 6.0.0" },
  ],
  bundles: [
    { key: "LatinOCRResources", owner: "MLKitTextRecognition 6.0.0" },
    { key: "KoreanOCRResources", owner: "MLKitTextRecognitionKorean 5.0.0" },
  ],
});
/** A fake llvm-nm: each archive defines its classes; the App binary defines `app`. */
function fakeNm(app: string[], extra: string[] = []): NmRunner {
  const defined: Record<string, string[]> = {
    [archive("MLKitCommon")]: ["_OBJC_CLASS_$_MLKITx_SRLRegistry", "_OBJC_METACLASS_$_MLKITx_SRLRegistry", "_MLKCommonFunction"],
    [archive("MLKitTextRecognition")]: ["_OBJC_CLASS_$_MLKTextRecognizer", ...extra],
  };
  return async (args) => {
    const file = args.at(-1)!;
    expect(args).toContain("--defined-only");
    const names = file.endsWith(`${path.sep}App`) ? app : defined[file];
    if (names === undefined) throw new Error(`unexpected file ${file}`);
    return [`${path.basename(file)}:`, ...names].join("\n");
  };
}
const ALL = ["_OBJC_CLASS_$_MLKITx_SRLRegistry", "_OBJC_CLASS_$_MLKTextRecognizer", "_main"];

describe("postPackChecks", () => {
  it("passes a complete app", async () => {
    await expect(postPackChecks(app, pods(), fakeNm(ALL))).resolves.toBeUndefined();
  });

  it("stops on a missing bundle or a bundle without Info.plist", async () => {
    rmSync(path.join(app, "KoreanOCRResources.bundle"), { recursive: true });
    rmSync(path.join(app, "LatinOCRResources.bundle", "Info.plist"));
    await expect(postPackChecks(app, pods(), fakeNm(ALL))).rejects.toThrow(
      "The packed app is not what the CocoaPods binaries need, so rn-xtool does not install it:\n" +
        "  - App.app/LatinOCRResources.bundle has no Info.plist (MLKitTextRecognition 6.0.0)\n" +
        "  - App.app/KoreanOCRResources.bundle is missing (MLKitTextRecognitionKorean 5.0.0)\n" +
        `See ${LINK}`,
    );
  });

  it("stops on a binary target embedded under Frameworks/", async () => {
    mkdirSync(path.join(app, "Frameworks", "MLKitCommon.framework"), { recursive: true });
    mkdirSync(path.join(app, "Frameworks", "React.framework"), { recursive: true });
    await expect(postPackChecks(app, pods(), fakeNm(ALL))).rejects.toThrow(
      "  - App.app/Frameworks/MLKitCommon.framework is there: xtool embedded a static binary as a dynamic framework\nSee",
    );
  });

  it("stops on a class a force-loaded archive defines and the App binary does not", async () => {
    const extra = ["A", "B", "C", "D", "E", "F"].map((c) => `_OBJC_CLASS_$_MLK${c}`);
    const err = await postPackChecks(app, pods(), fakeNm(["_OBJC_CLASS_$_MLKTextRecognizer"], extra)).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "The packed app is not what the CocoaPods binaries need, so rn-xtool does not install it:\n" +
        "  - the App binary does not define _OBJC_CLASS_$_MLKITx_SRLRegistry (MLKitCommon 13.0.0, force-loaded)\n" +
        "  - the App binary does not define _OBJC_CLASS_$_MLKA (MLKitTextRecognition 6.0.0, force-loaded)\n" +
        "  - the App binary does not define _OBJC_CLASS_$_MLKB (MLKitTextRecognition 6.0.0, force-loaded)\n" +
        "  - the App binary does not define _OBJC_CLASS_$_MLKC (MLKitTextRecognition 6.0.0, force-loaded)\n" +
        "  - the App binary does not define _OBJC_CLASS_$_MLKD (MLKitTextRecognition 6.0.0, force-loaded)\n" +
        "  - and 2 more\n" +
        `See ${LINK}`,
    );
  });

  it("reads the App binary's name from Info.plist", async () => {
    writeFileSync(
      path.join(app, "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>HelloWorld</string></dict></plist>\n',
    );
    const seen: string[] = [];
    const nm: NmRunner = async (args) => {
      seen.push(path.basename(args.at(-1)!));
      return args.at(-1)!.endsWith("HelloWorld") ? ALL.join("\n") : await fakeNm(ALL)(args);
    };
    await postPackChecks(app, pods(), nm);
    expect(seen).toContain("HelloWorld");
  });
});
