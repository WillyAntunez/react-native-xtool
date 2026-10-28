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
 * Expo SDKs rn-xtool builds, and where their SwiftPM plugin comes from. SDK 57 builds only with these exact
 * versions, through the Expo 58 plugin vendored in rn-xtool; SDK 58 and newer use the installed plugin.
 */
export const SUPPORTED_EXPO = {
  57: {
    plugin: "vendored",
    pins: {
      expo: "57.0.31",
      "react-native": "0.86.3",
      "expo-modules-core": "57.0.24",
      "expo-modules-autolinking": "57.0.16",
      "expo-modules-jsi": "57.1.3",
    },
  },
  58: { plugin: "installed" },
} as const;
export type ExpoPlugin = "installed" | "vendored";
export type ExpoPinName = keyof (typeof SUPPORTED_EXPO)[57]["pins"];

/** SDK 58 and newer: the installed plugin; 57: the vendored one; older: unsupported. */
export function expoPluginFor(sdk: number): ExpoPlugin | undefined {
  if (sdk >= 58) return SUPPORTED_EXPO[58].plugin;
  return sdk === 57 ? SUPPORTED_EXPO[57].plugin : undefined;
}

/** The exact versions an SDK needs, in the order the gate names them; undefined when the SDK pins nothing. */
export function expoPinsFor(sdk: number): Readonly<Record<ExpoPinName, string>> | undefined {
  return sdk === 57 ? SUPPORTED_EXPO[57].pins : undefined;
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

/** Numeric x.y.z comparison (anything after the patch number is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}
