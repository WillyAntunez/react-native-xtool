import { statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { ProjectInfo } from "../project/index.js";

/** The icon's name in ios-xtool and in the app bundle; xtool.yml's iconPath names it. */
export const APP_ICON_FILE = "AppIcon.png";

export interface PngSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** readPngSize looks at no more than this many bytes. */
const PNG_HEAD_BYTES = 64;

/** PNG signature (89 50 4E 47 0D 0A 1A 0A), then IHDR width and height (big-endian at bytes 16 and 20); an
 *  Apple-crushed PNG's leading CgBI chunk is skipped. Undefined when it is not a PNG. Reads no more than 64 bytes. */
export function readPngSize(bytes: Uint8Array): PngSize | undefined {
  const head = bytes.subarray(0, PNG_HEAD_BYTES);
  if (head.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => head[i] !== b)) return undefined;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  let chunk = PNG_SIGNATURE.length;
  // A chunk: length (4 bytes), type (4), data (length), CRC (4).
  if (chunk + 8 <= head.length && type(chunk + 4) === "CgBI") chunk += 12 + view.getUint32(chunk);
  if (chunk + 16 > head.length || type(chunk + 4) !== "IHDR") return undefined;
  return { width: view.getUint32(chunk + 8), height: view.getUint32(chunk + 12) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "60x60" and "3x" → 180; NaN when either is not a number. */
function pixels(size: unknown, scale: unknown): number {
  const side = typeof size === "string" ? Number(size.split("x")[0]) : NaN;
  const factor = scale === undefined ? 1 : typeof scale === "string" ? Number(scale.replace(/x$/, "")) : NaN;
  return side * factor;
}

/** From an appiconset Contents.json: entries with a string `filename`, no `appearances` (or an empty one), and a file
 *  that `exists`. The `size: "1024x1024"` entry first; else the iphone or universal entry with the most pixels
 *  (size × scale). */
export function pickIconFile(contents: unknown, exists: (filename: string) => boolean): string | undefined {
  const images = isRecord(contents) && Array.isArray(contents.images) ? contents.images : [];
  const usable = images.filter(
    (e): e is Record<string, unknown> & { filename: string } =>
      isRecord(e) &&
      typeof e.filename === "string" &&
      (e.appearances === undefined || (Array.isArray(e.appearances) && e.appearances.length === 0)) &&
      exists(e.filename),
  );
  const marketing = usable.find((e) => e.size === "1024x1024");
  if (marketing !== undefined) return marketing.filename;
  let best: { filename: string; pixels: number } | undefined;
  for (const e of usable) {
    if (e.idiom !== "iphone" && e.idiom !== "universal") continue;
    const p = pixels(e.size, e.scale);
    if (Number.isFinite(p) && (best === undefined || p > best.pixels)) best = { filename: e.filename, pixels: p };
  }
  return best?.filename;
}

/** The app config icon as `build` records it when it runs expo prebuild: its path from the project root and the
 *  sha256 of its content; no hash when it cannot be read, nothing without an icon in the config. */
export interface IconRecord {
  path?: string;
  sha256?: string;
}

export async function appIconRecord(project: ProjectInfo): Promise<IconRecord> {
  const icon = project.appIconSource;
  if (icon === undefined) return {};
  const path = relative(project.root, icon);
  try {
    return { path, sha256: createHash("sha256").update(await readFile(icon)).digest("hex") };
  } catch {
    return { path };
  }
}

export interface AppIcon {
  /** The PNG to use as the app icon; absent when the app gets none. */
  source?: string;
  /** What to tell the user, in order. */
  lines: string[];
}

/** A regular file (an entry's empty filename names the set's own folder); false when it cannot be checked. */
function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** The first bytes of `file`, enough for readPngSize. */
async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = new Uint8Array(PNG_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PNG_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The app icon from `<iosTargetDir>/Images.xcassets/AppIcon.appiconset`, as expo prebuild writes it (and Xcode for
 * bare apps). Only the PNG header is checked: no image library. A missing or unusable icon never fails the build.
 * `bundleRootNames` are the app resources copied to the bundle root; one named AppIcon.png would clash with the icon.
 * `prebuildIcon` is the app config icon recorded when `build` last ran expo prebuild.
 */
export async function findAppIcon(
  project: ProjectInfo,
  opts: { bundleRootNames: string[]; prebuildIcon?: IconRecord },
): Promise<AppIcon> {
  const rel = (p: string) => relative(project.root, p);
  const set = join(project.iosTargetDir, "Images.xcassets", "AppIcon.appiconset");
  const add =
    'Add a 1024×1024 PNG to it to give the app an icon (Expo: set "icon" in the app config, then run `rn-xtool build --clean`).';
  const configIcon = project.appIconSource;
  if (configIcon?.endsWith(".icon")) {
    return {
      lines: [
        `ℹ No app icon: ${rel(configIcon)} is an Icon Composer icon, which needs Xcode's actool. Set a 1024×1024 PNG as "icon" in the app config, then run \`rn-xtool build --clean\`.`,
      ],
    };
  }
  if (!statSync(set, { throwIfNoEntry: false })?.isDirectory()) {
    return { lines: [`ℹ No app icon: ${rel(set)} does not exist. ${add}`] };
  }
  let contents: unknown;
  try {
    contents = JSON.parse(await readFile(join(set, "Contents.json"), "utf8"));
  } catch {
    contents = undefined;
  }
  const filename = pickIconFile(contents, (f) => isFile(join(set, f)));
  if (filename === undefined) {
    return { lines: [`ℹ No app icon: ${rel(set)} lists no PNG in its Contents.json. ${add}`] };
  }
  const file = join(set, filename);
  const size = readPngSize(await readHead(file).catch(() => new Uint8Array()));
  if (size === undefined) {
    return { lines: [`ℹ No app icon: ${rel(file)} is not a PNG file. Replace it with a 1024×1024 PNG.`] };
  }
  if (opts.bundleRootNames.includes(APP_ICON_FILE)) {
    return {
      lines: [
        `⚠ No app icon: an app resource is copied to the app bundle as ${APP_ICON_FILE}, the name rn-xtool gives the icon. Rename that resource to give the app its icon.`,
      ],
    };
  }
  const { width: w, height: h } = size;
  const lines: string[] = [];
  // expo prebuild writes the set once; `build` reruns it only with --clean, so a changed app config icon is not in it.
  // Compared by content, not mtime: a git checkout of an unchanged icon is no change, another older file is one.
  const recorded = opts.prebuildIcon;
  if (configIcon !== undefined && recorded !== undefined) {
    const now = await appIconRecord(project);
    if (now.sha256 !== undefined && (now.path !== recorded.path || now.sha256 !== recorded.sha256)) {
      lines.push(
        `⚠ The app config icon ${rel(configIcon)} changed since the last expo prebuild wrote ${rel(set)}: run \`rn-xtool build --clean\` to use it.`,
      );
    }
  }
  if (w !== h) lines.push(`⚠ App icon ${rel(file)} is ${w}×${h}, not square: iOS stretches it. Use a 1024×1024 PNG.`);
  if (w < 180 || h < 180) {
    lines.push(
      `⚠ App icon ${rel(file)} is ${w}×${h}, smaller than 180×180: it looks blurry on the home screen. Use a 1024×1024 PNG.`,
    );
  }
  lines.push(`ℹ App icon: ${rel(file)} (${w}×${h})`);
  return { source: file, lines };
}
