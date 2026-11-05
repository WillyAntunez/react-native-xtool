/**
 * What happens to each entitlement key when xtool signs the app, read from xtool's source at the tag rn-xtool pins
 * (`ENTITLEMENTS_CHECKED_WITH`), and whether Apple gives it to a free team:
 * - xtool decodes only `EntitlementContainer.supportedTypes` (Sources/XKit/Model/Entitlements/EntitlementTypes.swift).
 *   On a free team it keeps the decoded ones whose capability is not marked paid
 *   (`filter { $0.anyCapability?.isFree != false }`, DeveloperServicesAddAppOperation.swift) and drops the rest, unknown
 *   keys included, without a word. On a paid team an unknown key stays in the signature, but xtool enables no
 *   capability for it on the App ID.
 * - `appleFree` is Apple's "Supported capabilities (iOS)" free column: App Groups, Background Modes, Data Protection,
 *   HealthKit, HomeKit, Inter-App Audio, Keychain Sharing, Maps and Wireless Accessory Configuration.
 * A test ties `ENTITLEMENTS_CHECKED_WITH` to `XTOOL_VERSION`: every xtool bump re-reads the types and the free filter.
 */

/** The xtool release whose source this table was read from. */
export const ENTITLEMENTS_CHECKED_WITH = "1.24.0";

export interface EntitlementInfo {
  /** free: decoded and kept on a free team; paid: decoded, dropped on a free team; unknown: not decoded (dropped). */
  xtool: "free" | "paid" | "unknown";
  /** Whether Apple's free column lists the capability. */
  appleFree: boolean;
  /** What the app loses at runtime without it, for the ⚠ line. */
  phrase?: string;
}

/** The phrase for a key without one. */
export const GENERIC_PHRASE = "the feature that needs it does not work at runtime";

export const ENTITLEMENT_TABLE: Readonly<Record<string, EntitlementInfo>> = {
  // supportedTypes without a capability: kept on every team (xtool rewrites the first three to the app's own team).
  "application-identifier": { xtool: "free", appleFree: true },
  "com.apple.developer.team-identifier": { xtool: "free", appleFree: true },
  "keychain-access-groups": {
    xtool: "free",
    appleFree: true,
    phrase: "sharing keychain items with other apps fails at runtime",
  },
  "get-task-allow": { xtool: "free", appleFree: true },
  // supportedTypes with a capability, and its isFree.
  "aps-environment": { xtool: "paid", appleFree: false, phrase: "push notifications fail at runtime" },
  // 1.24.0: `isFree: false` ("FIXME: Enable app groups on free accounts").
  "com.apple.security.application-groups": {
    xtool: "paid",
    appleFree: true,
    phrase: "sharing data with other apps and extensions through the group fails at runtime",
  },
  "com.apple.developer.networking.multipath": {
    xtool: "paid",
    appleFree: false,
    phrase: "connections use a single network path at runtime",
  },
  "com.apple.networking.vpn.configuration": {
    xtool: "paid",
    appleFree: false,
    phrase: "setting up a personal VPN fails at runtime",
  },
  "com.apple.developer.siri": { xtool: "paid", appleFree: false, phrase: "Siri requests to the app fail at runtime" },
  "inter-app-audio": { xtool: "free", appleFree: true },
  "com.apple.external-accessory.wireless-configuration": { xtool: "free", appleFree: true },
  "com.apple.developer.wifi-aware": { xtool: "paid", appleFree: false, phrase: "Wi-Fi Aware fails at runtime" },
  "com.apple.developer.homekit": { xtool: "free", appleFree: true },
  "com.apple.developer.healthkit": { xtool: "free", appleFree: true },
  "com.apple.developer.applesignin": { xtool: "paid", appleFree: false, phrase: "Sign in with Apple fails at runtime" },
  // Not in supportedTypes (associated domains and network extension are commented out there; data protection has a
  // type that is not listed).
  "com.apple.developer.associated-domains": {
    xtool: "unknown",
    appleFree: false,
    phrase: "universal links and shared web credentials do not work at runtime",
  },
  "com.apple.developer.networking.networkextension": {
    xtool: "unknown",
    appleFree: false,
    phrase: "the app's network extensions fail at runtime",
  },
  "com.apple.developer.default-data-protection": {
    xtool: "unknown",
    appleFree: true,
    phrase: "files keep the default protection",
  },
  "com.apple.developer.networking.wifi-info": {
    xtool: "unknown",
    appleFree: false,
    phrase: "reading the Wi-Fi network name returns nothing at runtime",
  },
  "com.apple.developer.networking.HotspotConfiguration": {
    xtool: "unknown",
    appleFree: false,
    phrase: "joining Wi-Fi networks from the app fails at runtime",
  },
  "com.apple.developer.device-information.user-assigned-device-name": {
    xtool: "unknown",
    appleFree: false,
    phrase: "the device name reads as the generic model name at runtime",
  },
  "com.apple.developer.nfc.readersession.formats": {
    xtool: "unknown",
    appleFree: false,
    phrase: "reading NFC tags fails at runtime",
  },
  "com.apple.developer.icloud-services": { xtool: "unknown", appleFree: false, phrase: "iCloud fails at runtime" },
};
