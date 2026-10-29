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

/**
 * Expo SDKs rn-xtool builds, where their SwiftPM plugin comes from, and the package versions they were verified with.
 * SDK 57 builds only with its exact pins, through the Expo 58 plugin vendored in rn-xtool. SDK 58 uses the installed
 * plugin and its pins are a floor: older is refused, newer is let through with a warning (react-native stays exact).
 * SDK 59 and newer use the installed plugin and pin nothing.
 */
export const SUPPORTED_EXPO = {
  57: {
    plugin: "vendored",
    policy: "exact",
    pins: {
      expo: "57.0.31",
      "react-native": "0.86.3",
      "expo-modules-core": "57.0.24",
      "expo-modules-autolinking": "57.0.16",
      "expo-modules-jsi": "57.1.3",
    },
  },
  58: {
    plugin: "installed",
    policy: "floor",
    pins: {
      expo: "58.0.21",
      "react-native": "0.88.1",
      "expo-modules-core": "58.0.28",
      "expo-modules-jsi": "58.0.21",
      "expo-modules-autolinking": "58.0.16",
      "expo-file-system": "58.0.13",
      "expo-font": "58.0.11",
    },
  },
} as const;
export type ExpoPlugin = "installed" | "vendored";
export type ExpoPinName =
  | "expo"
  | "react-native"
  | "expo-modules-core"
  | "expo-modules-jsi"
  | "expo-modules-autolinking"
  | "expo-file-system"
  | "expo-font";
export type ExpoPinPolicy = "exact" | "floor";

/** SDK 58 and newer: the installed plugin; 57: the vendored one; older: unsupported. */
export function expoPluginFor(sdk: number): ExpoPlugin | undefined {
  if (sdk >= 58) return SUPPORTED_EXPO[58].plugin;
  return sdk === 57 ? SUPPORTED_EXPO[57].plugin : undefined;
}

/** The versions an SDK was verified with, in the order the gate names them; undefined when the SDK pins nothing. */
export function expoPinsFor(sdk: number): Readonly<Partial<Record<ExpoPinName, string>>> | undefined {
  return sdk === 57 || sdk === 58 ? SUPPORTED_EXPO[sdk].pins : undefined;
}

/** How an SDK's pins are read: "exact" (57) or "floor" (58); undefined when the SDK pins nothing. */
export function expoPinPolicyFor(sdk: number): ExpoPinPolicy | undefined {
  return sdk === 57 || sdk === 58 ? SUPPORTED_EXPO[sdk].policy : undefined;
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
 * Not installed is "missing". Under "exact", and for react-native under either policy, anything else than the pin is
 * "off". Under "floor" the other packages are "below" or "newer" than the pin.
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
    else if (policy === "exact" || name === "react-native") status = version === wanted ? "ok" : "off";
    else {
      const order = compareVersions(version, wanted);
      status = order < 0 ? "below" : order > 0 ? "newer" : "ok";
    }
    return { name, wanted, installed: version, status };
  });
}

/** React Native versions rn-xtool builds as bare projects, and where their SwiftPM scripts come from. */
export const SUPPORTED_RN = {
  "0.86.2": "vendored",
  "0.86.3": "vendored",
  "0.87.1": "vendored",
  "0.88.0": "installed",
  "0.88.1": "installed",
} as const;
export type RnScripts = "installed" | "vendored";

export function rnScriptsFor(version: string): RnScripts | undefined {
  return Object.hasOwn(SUPPORTED_RN, version) ? SUPPORTED_RN[version as keyof typeof SUPPORTED_RN] : undefined;
}

/** "0.86.2, 0.86.3, 0.87.1, 0.88.0 and 0.88.1" */
export function supportedRnList(): string {
  const all = Object.keys(SUPPORTED_RN);
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
