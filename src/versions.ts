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
export const MIN_EXPO_SDK = 58;
