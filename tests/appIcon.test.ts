import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appIconRecord, findAppIcon, pickIconFile, readPngSize } from "../src/generate/appIcon.js";
import type { ProjectInfo } from "../src/project/index.js";
import { png } from "./support/png.js";

const tmps: string[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);

describe("readPngSize", () => {
  it("reads a PNG's size", () => {
    expect(readPngSize(png(1024, 1024))).toEqual({ width: 1024, height: 1024 });
    expect(readPngSize(png(1024, 1024, { cgbi: true }))).toEqual({ width: 1024, height: 1024 });
    expect(readPngSize(png(120, 100))).toEqual({ width: 120, height: 100 });
    expect(readPngSize(JPEG)).toBeUndefined();
    expect(readPngSize(png(1024, 1024).subarray(0, 10))).toBeUndefined();
    expect(readPngSize(new Uint8Array())).toBeUndefined();
  });
});

const entry = (o: object) => ({ idiom: "universal", platform: "ios", size: "1024x1024", ...o });
const dark = { appearances: [{ appearance: "luminosity", value: "dark" }] };
const tinted = { appearances: [{ appearance: "luminosity", value: "tinted" }] };
const all = () => true;

describe("pickIconFile", () => {
  it("picks the 1024 entry without appearances", () => {
    // Expo SDK 58 with ios.icon { light, dark, tinted }.
    const contents = {
      images: [
        entry({ filename: "App-Icon-1024x1024@1x.png" }),
        entry({ filename: "App-Icon-dark-1024x1024@1x.png", ...dark }),
        entry({ filename: "App-Icon-tinted-1024x1024@1x.png", ...tinted }),
      ],
      info: { version: 1, author: "expo" },
    };
    expect(pickIconFile(contents, all)).toBe("App-Icon-1024x1024@1x.png");
    expect(pickIconFile({ images: [entry({ filename: "App-Icon-dark-1024x1024@1x.png", ...dark })] }, all)).toBe(
      undefined,
    );
    expect(pickIconFile({ images: [entry({ filename: "a.png", appearances: [] })] }, all)).toBe("a.png");
  });

  it("falls back to the largest iPhone size", () => {
    const legacy = {
      images: [
        { idiom: "iphone", scale: "2x", size: "20x20", filename: "Icon-20@2x.png" },
        { idiom: "iphone", scale: "2x", size: "60x60", filename: "Icon-60@2x.png" },
        { idiom: "iphone", scale: "3x", size: "60x60", filename: "Icon-60@3x.png" },
        { idiom: "ipad", scale: "2x", size: "83.5x83.5", filename: "Icon-83.5@2x.png" },
        { idiom: "ios-marketing", scale: "1x", size: "1024x1024" },
      ],
    };
    expect(pickIconFile(legacy, all)).toBe("Icon-60@3x.png");
    expect(pickIconFile(legacy, (f) => f !== "Icon-60@3x.png")).toBe("Icon-60@2x.png");
    // The bare template lists sizes without files.
    const template = { images: legacy.images.map(({ filename: _, ...rest }) => rest) };
    expect(pickIconFile(template, all)).toBeUndefined();
    expect(pickIconFile({}, all)).toBeUndefined();
    expect(pickIconFile(null, all)).toBeUndefined();
  });
});

describe("findAppIcon", () => {
  /** A project whose icon set holds `files`; no set when `files` is undefined. */
  async function project(files?: Record<string, string | Uint8Array>) {
    const root = await mkdtemp(join(tmpdir(), "app-icon-"));
    tmps.push(root);
    const target = join(root, "ios", "app");
    await mkdir(target, { recursive: true });
    const set = join(target, "Images.xcassets", "AppIcon.appiconset");
    if (files !== undefined) {
      await mkdir(set, { recursive: true });
      for (const [name, body] of Object.entries(files)) await writeFile(join(set, name), body);
    }
    const info = { root, iosTargetDir: target } as ProjectInfo;
    return { root, set, info };
  }
  const contents = (filename: string) => JSON.stringify({ images: [entry({ filename })] });
  const ADD = 'Add a 1024×1024 PNG to it to give the app an icon (Expo: set "icon" in the app config, then run `rn-xtool build --clean`).';

  it("explains a missing or empty icon set", async () => {
    const missing = await project();
    expect(await findAppIcon(missing.info, { bundleRootNames: [] })).toEqual({
      lines: [`ℹ No app icon: ios/app/Images.xcassets/AppIcon.appiconset does not exist. ${ADD}`],
    });
    const listsNone = `ℹ No app icon: ios/app/Images.xcassets/AppIcon.appiconset lists no PNG in its Contents.json. ${ADD}`;
    for (const files of [{}, { "Contents.json": "{" }, { "Contents.json": contents("gone.png") }]) {
      const p = await project(files);
      expect(await findAppIcon(p.info, { bundleRootNames: [] })).toEqual({ lines: [listsNone] });
    }
  });

  it("skips a file that is not a PNG", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": JPEG });
    expect(await findAppIcon(p.info, { bundleRootNames: [] })).toEqual({
      lines: [
        "ℹ No app icon: ios/app/Images.xcassets/AppIcon.appiconset/icon.png is not a PNG file. Replace it with a 1024×1024 PNG.",
      ],
    });
  });

  it("never fails on an entry that names no file or a folder", async () => {
    const listsNone = `ℹ No app icon: ios/app/Images.xcassets/AppIcon.appiconset lists no PNG in its Contents.json. ${ADD}`;
    const odd = JSON.stringify({ images: [entry({ filename: "" }), entry({ filename: "folder.png" })] });
    const p = await project({ "Contents.json": odd });
    await mkdir(join(p.set, "folder.png"));
    expect(await findAppIcon(p.info, { bundleRootNames: [] })).toEqual({ lines: [listsNone] });

    const fallback = JSON.stringify({
      images: [entry({ filename: "" }), { idiom: "iphone", scale: "3x", size: "60x60", filename: "icon.png" }],
    });
    const q = await project({ "Contents.json": fallback, "icon.png": png(180, 180) });
    expect((await findAppIcon(q.info, { bundleRootNames: [] })).source).toBe(join(q.set, "icon.png"));
  });

  it.skipIf(process.getuid?.() === 0)("treats an unreadable icon as not a PNG (needs a non-root user)", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(1024, 1024) });
    await chmod(join(p.set, "icon.png"), 0o000);
    expect(await findAppIcon(p.info, { bundleRootNames: [] })).toEqual({
      lines: [
        "ℹ No app icon: ios/app/Images.xcassets/AppIcon.appiconset/icon.png is not a PNG file. Replace it with a 1024×1024 PNG.",
      ],
    });
  });

  it("uses the icon", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(1024, 1024) });
    expect(await findAppIcon(p.info, { bundleRootNames: ["Inter.ttf"] })).toEqual({
      source: join(p.set, "icon.png"),
      lines: ["ℹ App icon: ios/app/Images.xcassets/AppIcon.appiconset/icon.png (1024×1024)"],
    });
  });

  it("warns about a small or stretched icon but uses it", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(120, 100) });
    const file = "ios/app/Images.xcassets/AppIcon.appiconset/icon.png";
    expect(await findAppIcon(p.info, { bundleRootNames: [] })).toEqual({
      source: join(p.set, "icon.png"),
      lines: [
        `⚠ App icon ${file} is 120×100, not square: iOS stretches it. Use a 1024×1024 PNG.`,
        `⚠ App icon ${file} is 120×100, smaller than 180×180: it looks blurry on the home screen. Use a 1024×1024 PNG.`,
        `ℹ App icon: ${file} (120×100)`,
      ],
    });
  });

  it("warns when the app config icon changed since build ran expo prebuild", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(1024, 1024) });
    await mkdir(join(p.root, "assets"));
    const configIcon = join(p.root, "assets", "icon.png");
    await writeFile(configIcon, png(1024, 1024));
    const withSource = { ...p.info, appIconSource: configIcon };
    const prebuildIcon = await appIconRecord(withSource);
    expect(prebuildIcon).toEqual({ path: "assets/icon.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const used = "ℹ App icon: ios/app/Images.xcassets/AppIcon.appiconset/icon.png (1024×1024)";
    const STALE =
      "⚠ The app config icon assets/icon.png changed since the last expo prebuild wrote ios/app/Images.xcassets/AppIcon.appiconset: run `rn-xtool build --clean` to use it.";
    const linesOf = async (info: ProjectInfo, record = prebuildIcon) =>
      (await findAppIcon(info, { bundleRootNames: [], prebuildIcon: record })).lines;

    // Touched, or rewritten with the same content (a git checkout): no warning.
    const later = new Date(Date.now() + 60_000);
    await utimes(configIcon, later, later);
    expect(await linesOf(withSource)).toEqual([used]);
    await writeFile(configIcon, png(1024, 1024));
    expect(await linesOf(withSource)).toEqual([used]);

    // Edited.
    await writeFile(configIcon, png(1024, 1024, { cgbi: true }));
    expect(await linesOf(withSource)).toEqual([STALE, used]);
    // No record: no warning (build records the current icon first when it has none).
    expect((await findAppIcon(withSource, { bundleRootNames: [] })).lines).toEqual([used]);

    // The config now names another, older file.
    const other = join(p.root, "assets", "other.png");
    await writeFile(other, png(1024, 1024));
    const earlier = new Date("2020-01-01T00:00:00Z");
    await utimes(other, earlier, earlier);
    expect(await linesOf({ ...p.info, appIconSource: other })).toEqual([
      STALE.replace("assets/icon.png", "assets/other.png"),
      used,
    ]);
    // Prebuild ran without an icon in the config, which names one now.
    expect(await linesOf(withSource, {})).toEqual([STALE, used]);
    // The config's icon is missing: nothing to use.
    await rm(configIcon);
    expect(await linesOf(withSource)).toEqual([used]);
  });

  it("explains Icon Composer icons", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(1024, 1024) });
    const info = { ...p.info, appIconSource: join(p.root, "assets", "app.icon") };
    expect(await findAppIcon(info, { bundleRootNames: [] })).toEqual({
      lines: [
        'ℹ No app icon: assets/app.icon is an Icon Composer icon, which needs Xcode\'s actool. Set a 1024×1024 PNG as "icon" in the app config, then run `rn-xtool build --clean`.',
      ],
    });
  });

  it("refuses the AppIcon.png name clash", async () => {
    const p = await project({ "Contents.json": contents("icon.png"), "icon.png": png(1024, 1024) });
    expect(await findAppIcon(p.info, { bundleRootNames: ["Inter.ttf", "AppIcon.png"] })).toEqual({
      lines: [
        "⚠ No app icon: an app resource is copied to the app bundle as AppIcon.png, the name rn-xtool gives the icon. Rename that resource to give the app its icon.",
      ],
    });
  });
});
