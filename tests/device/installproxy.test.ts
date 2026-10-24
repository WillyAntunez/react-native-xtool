import { afterEach, describe, expect, it } from "vitest";
import { Heartbeat } from "../../src/device/heartbeat.js";
import {
  INSTALL_PROXY_SERVICE,
  installErrorMessage,
  InstallProxyClient,
  InstallProxyError,
  interpretInstallMessage,
} from "../../src/device/installproxy.js";
import { LockdownClient, tcpConnector } from "../../src/device/lockdown.js";
import { FakeDevice, pairRecord, type FakeDeviceOptions } from "./fakeDevice.js";

describe("interpretInstallMessage", () => {
  it("reads progress", () => {
    expect(interpretInstallMessage({ Status: "VerifyingApplication", PercentComplete: 40 })).toEqual({
      kind: "progress",
      percent: 40,
      status: "VerifyingApplication",
    });
  });
  it("detects completion", () => {
    expect(interpretInstallMessage({ Status: "Complete" })).toEqual({ kind: "done" });
  });
  it("turns Error into an InstallProxyError with the description", () => {
    const e = interpretInstallMessage({ Error: "PackageInspectionFailed", ErrorDescription: "bad zip", ErrorDetail: -1 });
    expect(e.kind).toBe("error");
    const err = (e as { error: InstallProxyError }).error;
    expect(err.code).toBe("PackageInspectionFailed");
    expect(err.message).toBe("installd failed to install the app (PackageInspectionFailed: bad zip)");
  });
});

describe("installErrorMessage", () => {
  it("maps ApplicationVerificationFailed to an expired/invalid signature and re-run hint", () => {
    const m = installErrorMessage("ApplicationVerificationFailed", "Failed to verify code signature");
    expect(m).toContain("expired");
    expect(m).toContain("Re-run `expo-xtool install --network`");
    expect(m).toContain("first one over USB");
    expect(m).toContain("installd: ApplicationVerificationFailed: Failed to verify code signature");
  });
  it("maps DeviceOSVersionTooLow", () => {
    expect(installErrorMessage("DeviceOSVersionTooLow")).toContain("newer iOS");
  });
  it("maps both spellings of the install restriction", () => {
    expect(installErrorMessage("InstallProhibited")).toContain("Installing Apps");
    expect(installErrorMessage("InstallationProhibited")).toContain("Installing Apps");
  });
});

describe("InstallProxyClient against a fake iPhone", () => {
  let dev: FakeDevice | undefined;
  let lockdown: LockdownClient | undefined;
  let hb: Heartbeat | undefined;
  afterEach(async () => {
    hb?.stop();
    lockdown?.close();
    await dev?.close();
    [dev, lockdown, hb] = [undefined, undefined, undefined];
  });

  async function installd(opts: FakeDeviceOptions = {}): Promise<InstallProxyClient> {
    dev = await FakeDevice.start({ requireHeartbeat: true, ...opts });
    lockdown = await LockdownClient.open(tcpConnector("127.0.0.1", 2000), { port: dev.lockdownPort, timeoutMs: 2000 });
    await lockdown.startSession(pairRecord());
    hb = await Heartbeat.start(lockdown);
    return new InstallProxyClient(await lockdown.openService(INSTALL_PROXY_SERVICE), { deadlineMs: 2000 });
  }

  it("installs a staged package, reporting progress until Complete, then finds it via Lookup", async () => {
    const c = await installd({ bundleId: "XTL-T.com.a.b" });
    dev!.files.set("/PublicStaging/x.ipa", Buffer.from("zip"));
    const seen: (number | undefined)[] = [];
    await c.install("/PublicStaging/x.ipa", (pct) => seen.push(pct));
    expect(seen).toEqual([5, 15, 40, 90]);
    const apps = await c.lookup(["XTL-T.com.a.b", "com.other"]);
    expect(Object.keys(apps)).toEqual(["XTL-T.com.a.b"]);
    expect(apps["XTL-T.com.a.b"]!.CFBundleVersion).toBe("1");
    c.close();
  });

  it("gives up at the overall deadline when installd goes silent", async () => {
    const c = await installd({ installStall: true });
    dev!.files.set("/PublicStaging/x.ipa", Buffer.from("zip"));
    const quick = new InstallProxyClient(await lockdown!.openService(INSTALL_PROXY_SERVICE), { deadlineMs: 150 });
    const t0 = Date.now();
    await expect(quick.install("/PublicStaging/x.ipa")).rejects.toThrow("no answer from the iPhone");
    expect(Date.now() - t0).toBeLessThan(1500);
    quick.close();
    c.close();
  });

  it("fails with the mapped installd error", async () => {
    const c = await installd({
      installError: { Error: "ApplicationVerificationFailed", ErrorDescription: "Failed to verify code signature" },
    });
    const err = await c.install("/PublicStaging/x.ipa").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallProxyError);
    expect((err as Error).message).toContain("expired");
    c.close();
  });
});
