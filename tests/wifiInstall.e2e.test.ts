/**
 * Opt-in E2E against a real iPhone on the LAN (it installs an app on it):
 *
 *   RN_XTOOL_E2E_WIFI=1 RN_XTOOL_E2E_WIFI_IP=192.168.1.10 \
 *   RN_XTOOL_E2E_WIFI_IPA=/path/App.ipa RN_XTOOL_E2E_WIFI_BUNDLE_ID=XTL-<team>.<bundle id> \
 *   npx vitest run tests/wifiInstall.e2e.test.ts
 *
 * The iPhone must be paired with this computer (usbmuxd record or our cache) and have Wi‑Fi
 * connections enabled. An asleep phone fails after the bounded 3 × 10 s retry; it never hangs.
 */
import { describe, expect, it } from "vitest";
import { identify, pairCandidates, retryWhileUnreachable } from "../src/device/discover.js";
import { loadPairRecord, pairedUdids } from "../src/device/pairRecord.js";
import { readPairRecordFromUsbmux } from "../src/device/usbmux.js";
import { installOverWifi } from "../src/device/wifiInstall.js";

const env = process.env;
const enabled = env.RN_XTOOL_E2E_WIFI === "1";

describe.skipIf(!enabled)("Wi‑Fi install on a real iPhone", () => {
  it("installs the signed ipa and finds it with Lookup", async () => {
    const ip = env.RN_XTOOL_E2E_WIFI_IP;
    const ipaPath = env.RN_XTOOL_E2E_WIFI_IPA;
    const bundleId = env.RN_XTOOL_E2E_WIFI_BUNDLE_ID;
    if (!ip || !ipaPath || !bundleId) {
      throw new Error("Set RN_XTOOL_E2E_WIFI_IP, RN_XTOOL_E2E_WIFI_IPA and RN_XTOOL_E2E_WIFI_BUNDLE_ID");
    }
    const t0 = Date.now();
    const result = await retryWhileUnreachable(
      async () => {
        const load = (u: string) => loadPairRecord(u, { fromUsbmux: (x) => readPairRecordFromUsbmux(x) });
        const udid =
          env.RN_XTOOL_E2E_WIFI_UDID ??
          (await identify(ip, { candidates: async () => pairCandidates(await pairedUdids(), load) }));
        const { record, source } = await load(udid);
        console.log(`iPhone ${udid} at ${ip}, pair record from ${source}`);
        let lastTenth = -1;
        return installOverWifi({
          ip,
          udid,
          pairRecord: record,
          ipaPath,
          bundleId,
          onUpload: (sent, total) => {
            const tenth = Math.floor((sent / total) * 10);
            if (tenth !== lastTenth) console.log(`upload ${(lastTenth = tenth) * 10}%`);
          },
          onInstall: (pct, status) => console.log(`install ${status ?? ""} ${pct ?? ""}`),
        });
      },
      { log: (s) => console.log(s) },
    );
    console.log(
      `installed ${bundleId} ${String(result.app.CFBundleShortVersionString)} (${String(result.app.CFBundleVersion)}): ` +
        `${result.bytes} bytes, upload ${result.uploadMs} ms, install ${result.installMs} ms, total ${Date.now() - t0} ms`,
    );
    expect(result.app.CFBundleIdentifier).toBe(bundleId);
  }, 600_000);
});
