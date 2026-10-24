import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallProxyError } from "../../src/device/installproxy.js";
import { tcpConnector } from "../../src/device/lockdown.js";
import { installOverWifi, stagingPath, UploadInterruptedError, type WifiInstallOptions } from "../../src/device/wifiInstall.js";
import { FakeDevice, pairRecord, UDID, type FakeDeviceOptions } from "./fakeDevice.js";

const BUNDLE = "XTL-TEAM.com.example.app";
let dev: FakeDevice | undefined;
let dir: string;
let ipa: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "expo-xtool-wifi-"));
  ipa = join(dir, "App.ipa");
  await writeFile(ipa, Buffer.alloc(300_000, 7));
});
afterEach(async () => {
  await dev?.close();
  dev = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function run(opts: FakeDeviceOptions, over: Partial<WifiInstallOptions> = {}) {
  dev = await FakeDevice.start({ requireHeartbeat: true, bundleId: BUNDLE, ...opts });
  return installOverWifi({
    ip: "127.0.0.1",
    udid: UDID,
    pairRecord: pairRecord(),
    ipaPath: ipa,
    bundleId: BUNDLE,
    connect: tcpConnector("127.0.0.1", 1000),
    lockdownPort: dev.lockdownPort,
    ...over,
  });
}

describe("stagingPath", () => {
  it("is one fixed, safe name per app under /PublicStaging", () => {
    expect(stagingPath("XTL-T.com.a.b")).toBe("/PublicStaging/expo-xtool-XTL-T.com.a.b.ipa");
    expect(stagingPath("a/b c")).toBe("/PublicStaging/expo-xtool-a_b_c.ipa");
  });
});

describe("installOverWifi", () => {
  it("stages, installs and verifies with the heartbeat running, then removes the staged file", async () => {
    const uploads: number[] = [];
    const installs: (number | undefined)[] = [];
    const r = await run({}, { onUpload: (s) => uploads.push(s), onInstall: (p) => installs.push(p) });
    expect(r.app.CFBundleIdentifier).toBe(BUNDLE);
    expect(r.bytes).toBe(300_000);
    expect(dev!.installs).toEqual([stagingPath(BUNDLE)]);
    expect(uploads.at(-1)).toBe(300_000);
    expect(installs).toEqual([5, 15, 40, 90]);
    expect(dev!.polos).toBeGreaterThanOrEqual(1);
    expect(dev!.files.size).toBe(0);
    expect(dev!.afcOps).toContain(`RemovePath ${stagingPath(BUNDLE)}`);
  });

  it("refuses to install on a different iPhone at that address", async () => {
    await expect(run({ udid: "00008030-0000000000000001" })).rejects.toThrow("not " + UDID);
    expect(dev!.installs).toEqual([]);
  });

  it("reports a dropped upload as interrupted (retryable)", async () => {
    const err = await run({ afcDropOnWrite: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadInterruptedError);
    expect(dev!.installs).toEqual([]);
  });

  it("surfaces installd errors and still cleans up the staged file", async () => {
    const err = await run({ installError: { Error: "ApplicationVerificationFailed", ErrorDescription: "expired" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InstallProxyError);
    expect(dev!.files.size).toBe(0);
  });

  it("sends nothing past StartSession to a host that is not the paired iPhone", async () => {
    const err = await run({ presentCert: (await import("./fakeDevice.js")).HOST_CERT }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("DeviceAuthenticationError");
    expect(dev!.requests).toEqual(["QueryType", "StartSession"]);
    expect(dev!.afcOps).toEqual([]);
    expect(dev!.installs).toEqual([]);
  });

  it("reports a link lost after Install started as interrupted (not retryable)", async () => {
    const { InstallInterruptedError } = await import("../../src/device/wifiInstall.js");
    const err = await run({ installDrop: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallInterruptedError);
    expect((err as Error).message).toContain("check the app on it");
    expect(dev!.installs).toHaveLength(1);
  });

  it("reports heartbeat loss during the upload as an interrupted (retryable) upload", async () => {
    await writeFile(ipa, Buffer.alloc(10 * 1024 * 1024, 1));
    const err = await run({ heartbeatDropOnWrite: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadInterruptedError);
    expect((err as Error).message).toContain("heartbeat");
    expect(dev!.installs).toEqual([]);
  });

  it("aborts cleanly when the iPhone announces SleepyTime during the install", async () => {
    const { InstallInterruptedError } = await import("../../src/device/wifiInstall.js");
    const t0 = Date.now();
    const err = await run({ installSleepy: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallInterruptedError);
    expect((err as Error).message).toContain("going to sleep");
    expect((err as Error).message).toContain("Keep the iPhone unlocked");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  for (const impostor of [{ noSessionSsl: true }, { noServiceSsl: true }]) {
    it(`uploads nothing to a peer that declines SSL (${Object.keys(impostor)[0]})`, async () => {
      const err = await run(impostor).catch((e: unknown) => e);
      expect((err as Error).name).toBe("DeviceAuthenticationError");
      expect(dev!.afcOps).toEqual([]);
      expect(dev!.installs).toEqual([]);
      if (impostor.noSessionSsl) expect(dev!.requests).toEqual(["QueryType", "StartSession"]);
    });
  }

  it("says the install completed when only the Lookup afterwards fails", async () => {
    const { VerifyFailedError } = await import("../../src/device/wifiInstall.js");
    const err = await run({ lookupDrop: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerifyFailedError);
    expect((err as Error).message).toContain("reported the install as complete");
    expect((err as Error).message).not.toContain("while it was installing");
    expect(dev!.installs).toHaveLength(1);
  });

  it("fails when the pairing is not accepted", async () => {
    await expect(run({ hostId: "SOMEONE-ELSE" })).rejects.toThrow("no longer trusts this computer");
  });
});
