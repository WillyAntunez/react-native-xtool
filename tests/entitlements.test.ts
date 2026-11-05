import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EntitlementsError, readEntitlements } from "../src/project/entitlements.js";
import type { ProjectInfo } from "../src/project/index.js";
import { plistOf, withEntitlements } from "./support/entitlements.js";

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const BARE_PBXPROJ = new URL("./fixtures/pbxproj/with-objc.pbxproj", import.meta.url);
const EXPO_PBXPROJ = new URL("./fixtures/pbxproj/expo-libapp.pbxproj", import.meta.url);

async function bare(debug: string | undefined, release?: string) {
  const root = await mkdtemp(join(tmpdir(), "rn-xtool-ent-"));
  tmps.push(root);
  const ios = join(root, "ios");
  await mkdir(join(ios, "HelloWorld.xcodeproj"), { recursive: true });
  await mkdir(join(ios, "HelloWorld"), { recursive: true });
  await writeFile(join(ios, "HelloWorld.xcodeproj", "project.pbxproj"), withEntitlements(await readFile(BARE_PBXPROJ, "utf8"), debug, release));
  const project = { kind: "bare", root, bundleIdentifier: "com.example.app" } as ProjectInfo;
  return { root, ios, project };
}

async function expo() {
  const root = await mkdtemp(join(tmpdir(), "rn-xtool-ent-expo-"));
  tmps.push(root);
  const ios = join(root, "ios");
  await mkdir(join(ios, "LibApp.xcodeproj"), { recursive: true });
  await mkdir(join(ios, "LibApp"), { recursive: true });
  await writeFile(join(ios, "LibApp.xcodeproj", "project.pbxproj"), await readFile(EXPO_PBXPROJ, "utf8"));
  const project = { kind: "expo", root, bundleIdentifier: "com.example.app" } as ProjectInfo;
  return { root, ios, project };
}

describe("readEntitlements", () => {
  it("reads CODE_SIGN_ENTITLEMENTS (bare)", async () => {
    const { ios, project } = await bare('"$(TARGET_NAME)/HelloWorld.entitlements"');
    await writeFile(join(ios, "HelloWorld", "HelloWorld.entitlements"), plistOf("<dict>\n<key>aps-environment</key>\n<string>development</string>\n</dict>"));
    expect(readEntitlements(project, ios)).toEqual({
      file: join(ios, "HelloWorld", "HelloWorld.entitlements"),
      rel: "ios/HelloWorld/HelloWorld.entitlements",
      dict: { "aps-environment": "development" },
    });
  });

  it("reads the Debug configuration's file", async () => {
    const { ios, project } = await bare("HelloWorld/Debug.entitlements", "HelloWorld/Release.entitlements");
    await writeFile(join(ios, "HelloWorld", "Debug.entitlements"), plistOf("<dict>\n<key>get-task-allow</key>\n<true/>\n</dict>"));
    await writeFile(join(ios, "HelloWorld", "Release.entitlements"), plistOf("<dict>\n<key>aps-environment</key>\n<string>production</string>\n</dict>"));
    expect(readEntitlements(project, ios)?.dict).toEqual({ "get-task-allow": true });
  });

  it("reads the Expo prebuild's entitlements", async () => {
    const { ios, project } = await expo();
    await writeFile(
      join(ios, "LibApp", "LibApp.entitlements"),
      plistOf("<dict>\n<key>com.apple.developer.associated-domains</key>\n<array>\n<string>applinks:example.com</string>\n</array>\n</dict>"),
    );
    expect(readEntitlements(project, ios)).toEqual({
      file: join(ios, "LibApp", "LibApp.entitlements"),
      rel: "ios/LibApp/LibApp.entitlements",
      dict: { "com.apple.developer.associated-domains": ["applinks:example.com"] },
    });
  });

  it("resolves $(PRODUCT_BUNDLE_IDENTIFIER) and keeps $(AppIdentifierPrefix)", async () => {
    const { ios, project } = await bare("$(SRCROOT)/HelloWorld/HelloWorld.entitlements");
    await writeFile(
      join(ios, "HelloWorld", "HelloWorld.entitlements"),
      plistOf(
        "<dict>\n<key>keychain-access-groups</key>\n<array>\n<string>$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n" +
          "<string>$(TeamIdentifierPrefix)shared</string>\n</array>\n<key>com.apple.security.application-groups</key>\n" +
          "<array>\n<string>group.$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n<string>group.$(PRODUCT_NAME).$(UNKNOWN_SETTING)</string>\n</array>\n</dict>",
      ),
    );
    expect(readEntitlements(project, ios)?.dict).toEqual({
      "keychain-access-groups": ["$(AppIdentifierPrefix)com.example.app", "$(TeamIdentifierPrefix)shared"],
      "com.apple.security.application-groups": ["group.com.example.app", "group.HelloWorld.$(UNKNOWN_SETTING)"],
    });
  });

  it("without the setting or an Xcode project: undefined", async () => {
    const { ios, project } = await bare(undefined);
    expect(readEntitlements(project, ios)).toBeUndefined();
    const empty = await bare('""');
    expect(readEntitlements(empty.project, empty.ios)).toBeUndefined();
    expect(readEntitlements(project, join(ios, "missing"))).toBeUndefined();
  });

  it("refuses a missing entitlements file", async () => {
    const { ios, project } = await bare("HelloWorld/HelloWorld.entitlements");
    const error = (() => {
      try {
        readEntitlements(project, ios);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(EntitlementsError);
    expect((error as Error).message).toBe(
      "CODE_SIGN_ENTITLEMENTS names ios/HelloWorld/HelloWorld.entitlements, which does not exist; xtool cannot sign the app " +
        "without it. Fix the setting or create the file.",
    );
  });

  it.each([
    ["an array", plistOf("<array>\n<string>aps-environment</string>\n</array>")],
    ["a string", plistOf("<string>aps-environment</string>")],
    ["no property list", "aps-environment = development\n"],
    ["an empty file", ""],
  ])("refuses a file that is not a dictionary: %s", async (_name, text) => {
    const { ios, project } = await bare("HelloWorld/HelloWorld.entitlements");
    await writeFile(join(ios, "HelloWorld", "HelloWorld.entitlements"), text);
    expect(() => readEntitlements(project, ios)).toThrow(
      new EntitlementsError(
        "ios/HelloWorld/HelloWorld.entitlements (CODE_SIGN_ENTITLEMENTS) is not a property list dictionary; xtool cannot sign the app with it.",
      ),
    );
  });
});
