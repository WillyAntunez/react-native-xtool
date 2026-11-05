import { describe, expect, it } from "vitest";
import { ENTITLEMENT_TABLE, ENTITLEMENTS_CHECKED_WITH, GENERIC_PHRASE } from "../src/project/entitlementTable.js";
import { XTOOL_VERSION } from "../src/versions.js";

describe("entitlement table", () => {
  it("the table was checked with the pinned xtool", () => {
    expect(
      ENTITLEMENTS_CHECKED_WITH,
      "xtool changed: re-read supportedTypes, isFree and the free filter at the new tag (plan Task E1)",
    ).toBe(XTOOL_VERSION);
  });

  it("holds every type xtool 1.24.0 decodes, with its flag", () => {
    // EntitlementContainer.supportedTypes (Sources/XKit/Model/Entitlements/EntitlementTypes.swift at the 1.24.0 tag),
    // each with its capability's isFree (DeveloperServicesCapability.swift); a type without a capability is kept on a
    // free team (`filter { $0.anyCapability?.isFree != false }`), so it reads "free".
    const decoded: Record<string, "free" | "paid"> = {
      "application-identifier": "free",
      "com.apple.developer.team-identifier": "free",
      "keychain-access-groups": "free",
      "get-task-allow": "free",
      "aps-environment": "paid",
      "com.apple.security.application-groups": "paid",
      "com.apple.developer.networking.multipath": "paid",
      "com.apple.networking.vpn.configuration": "paid",
      "com.apple.developer.siri": "paid",
      "inter-app-audio": "free",
      "com.apple.external-accessory.wireless-configuration": "free",
      "com.apple.developer.wifi-aware": "paid",
      "com.apple.developer.homekit": "free",
      "com.apple.developer.healthkit": "free",
      "com.apple.developer.applesignin": "paid",
    };
    for (const [key, flag] of Object.entries(decoded)) expect([key, ENTITLEMENT_TABLE[key]?.xtool]).toEqual([key, flag]);
    const known = Object.entries(ENTITLEMENT_TABLE).filter(([, info]) => info.xtool !== "unknown").map(([key]) => key);
    expect(known.sort()).toEqual(Object.keys(decoded).sort());
  });

  it("holds the work app's keys", () => {
    const keys: [string, { xtool: string; appleFree: boolean }][] = [
      ["com.apple.developer.networking.wifi-info", { xtool: "unknown", appleFree: false }],
      ["com.apple.developer.networking.HotspotConfiguration", { xtool: "unknown", appleFree: false }],
      ["keychain-access-groups", { xtool: "free", appleFree: true }],
      ["com.apple.developer.device-information.user-assigned-device-name", { xtool: "unknown", appleFree: false }],
      ["aps-environment", { xtool: "paid", appleFree: false }],
      ["com.apple.developer.associated-domains", { xtool: "unknown", appleFree: false }],
      ["com.apple.developer.default-data-protection", { xtool: "unknown", appleFree: true }],
      ["com.apple.developer.nfc.readersession.formats", { xtool: "unknown", appleFree: false }],
      ["com.apple.developer.icloud-services", { xtool: "unknown", appleFree: false }],
      ["com.apple.developer.networking.networkextension", { xtool: "unknown", appleFree: false }],
    ];
    for (const [key, flags] of keys) expect([key, ENTITLEMENT_TABLE[key]]).toEqual([key, expect.objectContaining(flags)]);
    // Personal VPN's own key: xtool decodes only com.apple.networking.vpn.configuration.
    expect(ENTITLEMENT_TABLE["com.apple.developer.networking.vpn.api"]).toEqual(
      expect.objectContaining({ xtool: "unknown", appleFree: false, phrase: "setting up a personal VPN fails at runtime" }),
    );
    // Apple's free column: App Groups, Data Protection, HealthKit, HomeKit, Inter-App Audio, Keychain Sharing and
    // Wireless Accessory Configuration are the entitlement-backed ones.
    for (const key of [
      "com.apple.security.application-groups",
      "com.apple.developer.healthkit",
      "com.apple.developer.homekit",
      "inter-app-audio",
      "com.apple.external-accessory.wireless-configuration",
    ]) {
      expect([key, ENTITLEMENT_TABLE[key]?.appleFree]).toEqual([key, true]);
    }
    expect(ENTITLEMENT_TABLE["aps-environment"]?.phrase).toBe("push notifications fail at runtime");
    expect(ENTITLEMENT_TABLE["com.apple.developer.networking.wifi-info"]?.phrase).toBe(
      "reading the Wi-Fi network name returns nothing at runtime",
    );
    expect(ENTITLEMENT_TABLE["com.apple.developer.default-data-protection"]?.phrase).toBe("files keep the default protection");
    expect(GENERIC_PHRASE).toBe("the feature that needs it does not work at runtime");
  });
});
