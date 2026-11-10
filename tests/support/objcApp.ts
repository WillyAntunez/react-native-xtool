/**
 * The Objective-C fixture app (React Native's pre-0.77 Objective-C template, MIT) copied into a temp project root.
 * `template`: the template's layout (`ios/ObjcApp/{main.m,AppDelegate.h,AppDelegate.mm}`); `root-group`: the trial's
 * layout, those three files next to `ios/ObjcApp.xcodeproj` and in the project's main group (Info.plist stays in
 * `ios/ObjcApp`).
 */
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const ROOT_GROUP_FILES = ["main.m", "AppDelegate.h", "AppDelegate.mm"];

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The temp project root (its real path), with `node_modules/react-native/package.json` at 0.88.1 and nothing else installed. */
export function objcApp(layout: "template" | "root-group"): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xt-objc-")));
  tmp.push(root);
  cpSync(path.join(FIXTURES, "objc-app"), root, { recursive: true });
  const rn = path.join(root, "node_modules", "react-native");
  mkdirSync(rn, { recursive: true });
  writeFileSync(path.join(rn, "package.json"), JSON.stringify({ name: "react-native", version: "0.88.1" }));
  if (layout === "root-group") {
    const ios = path.join(root, "ios");
    copyFileSync(path.join(FIXTURES, "pbxproj", "objc-root-group.pbxproj"), path.join(ios, "ObjcApp.xcodeproj", "project.pbxproj"));
    for (const name of ROOT_GROUP_FILES) renameSync(path.join(ios, "ObjcApp", name), path.join(ios, name));
  }
  return root;
}
