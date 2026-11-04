import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as plist from "plist";
import { projectPaths } from "./paths.js";
import { requireFromProject } from "./project/requireFromProject.js";

const longestFirst = (schemes: string[]): string[] => [...schemes].sort((a, b) => b.length - a.length);

/** CFBundleURLTypes[].CFBundleURLSchemes[] of an Info.plist: the longest exp+ scheme, else the longest; undefined
 *  when there is none or the plist does not parse (Expo CLI's rule, utils/scheme.js resolveExpoOrLongestScheme). */
export function devClientScheme(infoPlistXml: string): string | undefined {
  let info: unknown;
  try {
    info = plist.parse(infoPlistXml);
  } catch {
    return undefined;
  }
  const types = (info as { CFBundleURLTypes?: unknown } | null)?.CFBundleURLTypes;
  const schemes = (Array.isArray(types) ? types : []).flatMap((t: unknown) => {
    const list = (t as { CFBundleURLSchemes?: unknown } | null)?.CFBundleURLSchemes;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string" && s !== "") : [];
  });
  const expo = schemes.filter((s) => s.startsWith("exp+"));
  return longestFirst(expo.length > 0 ? expo : schemes)[0];
}

/** `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`: the legacy form SDK 57 and 58 accept. */
export function devClientDeepLink(scheme: string, metroUrl: string): string {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
}

export type QrEncoder = (text: string) => Uint8Array; // one byte per module, row-major, 1 = dark

/** toqr's toQR through requireFromProject; undefined when missing or not a function. */
export function loadQrEncoder(root: string): QrEncoder | undefined {
  const toQR = (requireFromProject(root, "toqr") as { toQR?: unknown } | undefined)?.toQR;
  return typeof toQR === "function" ? (toQR as QrEncoder) : undefined;
}

const BORDER = 2;

/** Half-block rendering with a 2-module light border: two module rows per text line. */
export function renderQr(modules: Uint8Array): string[] {
  const side = Math.sqrt(modules.length) | 0;
  const size = side + 2 * BORDER;
  const dark = (r: number, c: number): boolean => {
    const row = r - BORDER;
    const col = c - BORDER;
    return row >= 0 && row < side && col >= 0 && col < side && modules[row * side + col] === 1;
  };
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c++) {
      const upper = dark(r, c);
      const lower = r + 1 < size && dark(r + 1, c);
      line += upper ? (lower ? " " : "▄") : lower ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines;
}

export interface LinkIo {
  readInfoPlist: (root: string) => Promise<string | undefined>; // ios-xtool/Info.plist, undefined when missing
  qrEncoder: (root: string) => QrEncoder | undefined;
  isTTY: boolean; // process.stdout.isTTY === true
  columns: number | undefined; // process.stdout.columns
}

const readIosXtoolInfoPlist = (root: string): Promise<string | undefined> =>
  readFile(join(projectPaths(root).iosXtool, "Info.plist"), "utf8").catch(() => undefined);

/** The QR code's lines, or undefined when it cannot be drawn or would not fit. */
function qrLines(link: string, root: string, io: LinkIo): string[] | undefined {
  if (!io.isTTY) return undefined;
  try {
    const encode = io.qrEncoder(root);
    if (encode === undefined) return undefined;
    const modules = encode(link);
    const side = Math.sqrt(modules.length) | 0;
    if (side === 0 || side * side !== modules.length) return undefined;
    if (io.columns !== undefined && io.columns < side + 2 * BORDER) return undefined;
    return renderQr(modules);
  } catch {
    return undefined;
  }
}

/** What `install` prints for a dev-client build: the Metro URL, then the deep link as a QR code and as text. */
export async function devClientLinkLines(
  root: string,
  state: { lanIp: string; metroPort: number },
  io: Partial<LinkIo> = {},
): Promise<string[]> {
  const url = `http://${state.lanIp}:${state.metroPort}`;
  const lines = [`Metro URL for the dev launcher: ${url}`];
  const all: LinkIo = {
    readInfoPlist: io.readInfoPlist ?? readIosXtoolInfoPlist,
    qrEncoder: io.qrEncoder ?? loadQrEncoder,
    isTTY: io.isTTY ?? process.stdout.isTTY === true,
    columns: "columns" in io ? io.columns : process.stdout.columns,
  };
  const xml = await all.readInfoPlist(root).catch(() => undefined);
  const scheme = xml === undefined ? undefined : devClientScheme(xml);
  if (scheme === undefined) {
    lines.push(
      `ℹ ios-xtool/Info.plist has no URL scheme, so there is no link to open the dev client: enter ${url} in the dev launcher.`,
    );
    return lines;
  }
  const link = devClientDeepLink(scheme, url);
  const qr = qrLines(link, root, all);
  if (qr === undefined) {
    lines.push(`Open this link on the iPhone to open the app on that Metro server: ${link}`);
  } else {
    lines.push("Scan this QR code with the iPhone camera to open the app on that Metro server:", ...qr);
    lines.push(`Or open this link on the iPhone: ${link}`);
  }
  return lines;
}
