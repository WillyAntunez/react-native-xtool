export const XTOOL_VERSION = "1.23.0";
/**
 * sha256 of the official xtool AppImage for XTOOL_VERSION, per Linux arch.
 * Provenance: release 1.23.0 of xtool-org/xtool, assets xtool-x86_64.AppImage and xtool-aarch64.AppImage,
 * downloaded 2026-10-23 via `gh release download` and hashed with `sha256sum` (GitHub publishes no checksum).
 */
export const XTOOL_SHA256: Record<string, string | undefined> = {
  x86_64: "270fb6630baeede2cc7c516bfada2de81f99e11c00b5927f59c0cb5129bd56f7",
  aarch64: "649e8bdc799c9273ca54be1a84e7093e4be970d4780b4b22409517935dc2053b",
};
export const SWIFT_VERSION = "6.4";
export const IOS_MIN = "16.4";

export type ExpoPlugin = "installed" | "vendored";
export type ExpoPinName =
  | "expo"
  | "react-native"
  | "expo-modules-core"
  | "expo-modules-jsi"
  | "expo-modules-autolinking"
  | "expo-file-system"
  | "expo-font";
export type ExpoPinPolicy = "floor";
export type RnScripts = "installed" | "vendored";
/** Where a line's React Native artifacts come from. adapted: pre-headers-spec slots rn-xtool rebuilds (0.86). */
export type RnArtifacts = "adapted" | "published";

/** An Expo SDK rn-xtool builds: where its SwiftPM plugin comes from and the package versions it was verified with. */
export interface ExpoLine {
  kind: "expo";
  sdk: number;
  plugin: ExpoPlugin;
  policy: ExpoPinPolicy;
  scripts: RnScripts;
  artifacts: RnArtifacts;
  /** In the order the gate names them. */
  pins: Readonly<Partial<Record<ExpoPinName, string>>>;
  /** The create-expo-app templates the drift watch creates. */
  templates: readonly string[];
}

/** A React Native minor rn-xtool builds as a bare project, and where its SwiftPM scripts come from. */
export interface BareLine {
  kind: "bare";
  minor: string;
  floor: string;
  verified: readonly string[];
  scripts: RnScripts;
  artifacts: RnArtifacts;
}

export type SupportedLine = ExpoLine | BareLine;

/**
 * Every line rn-xtool supports. SDK 57 builds through the Expo 58 plugin vendored in rn-xtool, SDK 58 through the
 * installed one. On both the pins are a floor: older is refused, newer of the same release line is let through with a
 * warning (react-native stays exact). SDKs newer than the last Expo row use its plugin and pin nothing.
 */
export const SUPPORTED_LINES: readonly SupportedLine[] = [
  {
    kind: "expo",
    sdk: 57,
    plugin: "vendored",
    policy: "floor",
    scripts: "vendored",
    artifacts: "adapted",
    pins: {
      expo: "57.0.31",
      "react-native": "0.86.3",
      "expo-modules-core": "57.0.24",
      "expo-modules-autolinking": "57.0.16",
      "expo-modules-jsi": "57.1.3",
    },
    templates: ["blank-typescript"],
  },
  {
    kind: "expo",
    sdk: 58,
    plugin: "installed",
    policy: "floor",
    scripts: "installed",
    artifacts: "published",
    pins: {
      expo: "58.0.21",
      "react-native": "0.88.1",
      "expo-modules-core": "58.0.28",
      "expo-modules-jsi": "58.0.21",
      "expo-modules-autolinking": "58.0.16",
      "expo-file-system": "58.0.13",
      "expo-font": "58.0.11",
    },
    templates: ["blank-typescript", "default"],
  },
  {
    kind: "bare",
    minor: "0.86",
    floor: "0.86.2",
    verified: ["0.86.2", "0.86.3"],
    scripts: "vendored",
    artifacts: "adapted",
  },
  {
    kind: "bare",
    minor: "0.87",
    floor: "0.87.1",
    verified: ["0.87.1"],
    scripts: "vendored",
    artifacts: "published",
  },
  {
    kind: "bare",
    minor: "0.88",
    floor: "0.88.0",
    verified: ["0.88.0", "0.88.1"],
    scripts: "installed",
    artifacts: "published",
  },
];

/** "expo-57", "bare-0.88" */
export function lineId(line: SupportedLine): string {
  return line.kind === "expo" ? `expo-${line.sdk}` : `bare-${line.minor}`;
}

const expoLines = (): ExpoLine[] => SUPPORTED_LINES.filter((l): l is ExpoLine => l.kind === "expo");
/** The bare React Native rows, oldest minor first. */
export const bareLines = (): BareLine[] => SUPPORTED_LINES.filter((l): l is BareLine => l.kind === "bare");

/** The row of an SDK that has one (57 and 58); undefined for any other SDK. */
export function expoLineFor(sdk: number): ExpoLine | undefined {
  return expoLines().find((l) => l.sdk === sdk);
}

/** The row of the version's "<major>.<minor>", prereleases included; undefined when that minor has no row. */
export function bareLineFor(version: string): BareLine | undefined {
  const minor = /^(\d+\.\d+)\./.exec(version)?.[1];
  return minor === undefined ? undefined : bareLines().find((l) => l.minor === minor);
}

/** An SDK's row's plugin; SDKs newer than the last Expo row take its plugin; older ones are unsupported. */
export function expoPluginFor(sdk: number): ExpoPlugin | undefined {
  const line = expoLineFor(sdk);
  if (line !== undefined) return line.plugin;
  const newest = expoLines().at(-1);
  return newest !== undefined && sdk > newest.sdk ? newest.plugin : undefined;
}

/** The versions an SDK was verified with, in the order the gate names them; undefined when the SDK pins nothing. */
export function expoPinsFor(sdk: number): Readonly<Partial<Record<ExpoPinName, string>>> | undefined {
  return expoLineFor(sdk)?.pins;
}

/** How an SDK's pins are read: "floor" (57 and 58); undefined when the SDK pins nothing. */
export function expoPinPolicyFor(sdk: number): ExpoPinPolicy | undefined {
  return expoLineFor(sdk)?.policy;
}

export type PinStatus = "ok" | "missing" | "off" | "below" | "newer";
export interface PinCheck {
  name: ExpoPinName;
  wanted: string;
  installed: string | undefined;
  status: PinStatus;
}

/**
 * Each of the SDK's pins against the installed versions, in table order; undefined when the SDK pins nothing.
 * Not installed is "missing". react-native is exact: anything else than the pin is "off". The other packages are
 * "off" on another release line than the pin (expo-modules-jsi 58.x on SDK 57), else "below" or "newer" than it.
 */
export function checkPins(
  sdk: number,
  installed: Partial<Record<ExpoPinName, string | undefined>>,
): PinCheck[] | undefined {
  const pins = expoPinsFor(sdk);
  const policy = expoPinPolicyFor(sdk);
  if (pins === undefined || policy === undefined) return undefined;
  return (Object.entries(pins) as [ExpoPinName, string][]).map(([name, wanted]) => {
    const version = installed[name];
    let status: PinStatus;
    if (version === undefined) status = "missing";
    else if (name === "react-native") status = version === wanted ? "ok" : "off";
    else if (releaseLine(version) !== releaseLine(wanted)) status = "off";
    else {
      const order = compareVersions(version, wanted);
      status = order < 0 ? "below" : order > 0 ? "newer" : "ok";
    }
    return { name, wanted, installed: version, status };
  });
}

/** A version's release line: "0.y" for "0.y.z", else the major ("57.1.4" → "57"; "58.0.21-rc.1" → "58"). */
export function releaseLine(version: string): string {
  const [major = "", minor = ""] = version.split(/[.+-]/, 2);
  return major === "0" ? `0.${minor}` : major;
}

export type RnLineStatus = "verified" | "newer" | "below" | "prerelease" | "unsupported";

/**
 * A bare React Native version against its minor's row: "verified" (in the row's list), "newer" (a release at or above
 * the floor that was not verified: built with a warning), "below" the floor, "prerelease" (anything but a plain x.y.z
 * release, refused), or "unsupported" (no row for the minor, and then no `line`).
 */
export function rnLineStatus(version: string): { status: RnLineStatus; line?: BareLine } {
  const line = bareLineFor(version);
  if (line === undefined) return { status: "unsupported" };
  if (line.verified.includes(version)) return { status: "verified", line };
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { status: "prerelease", line };
  return { status: compareVersions(version, line.floor) < 0 ? "below" : "newer", line };
}

/** "0.86.x from 0.86.2, 0.87.x from 0.87.1 and 0.88.x from 0.88.0" */
export function supportedRnList(): string {
  const all = bareLines().map((l) => `${l.minor}.x from ${l.floor}`);
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

/**
 * Semver precedence: x.y.z numerically, then a prerelease (`-rc.1`) below its release, prereleases by their dot-separated
 * identifiers (numeric ones numerically and below alphanumeric ones); build metadata (`+…`) is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", ...pre] = v.split("+", 1)[0]!.split("-");
    const nums = core.split(".", 3).map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre: pre.length > 0 ? pre.join("-").split(".") : [] };
  };
  const [va, vb] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) if ((va.nums[i] ?? 0) !== (vb.nums[i] ?? 0)) return (va.nums[i] ?? 0) - (vb.nums[i] ?? 0);
  if (va.pre.length === 0 || vb.pre.length === 0) return vb.pre.length - va.pre.length;
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const [x, y] = [va.pre[i]!, vb.pre[i]!];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return va.pre.length - vb.pre.length;
}
