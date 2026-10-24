import { afterEach, describe, expect, it } from "vitest";
import { pickUsbDevice, setupWifi, type SetupWifiDeps } from "../src/commands/setupWifi.js";
import { LockdownClient, tcpConnector } from "../src/device/lockdown.js";
import { FakeDevice, pairRecord, UDID } from "./device/fakeDevice.js";

let dev: FakeDevice | undefined;
afterEach(async () => {
  await dev?.close();
  dev = undefined;
});

const usb = { deviceId: 7, udid: UDID, connectionType: "USB" };

async function deps(values?: Record<string, unknown>): Promise<{ d: SetupWifiDeps; logs: string[] }> {
  dev = await FakeDevice.start(values ? { values: values as never } : {});
  const port = dev.lockdownPort;
  const logs: string[] = [];
  return {
    logs,
    d: {
      listUsbDevices: async () => [usb],
      loadPairRecord: async () => ({ record: pairRecord(), source: "usbmuxd" }),
      openLockdown: async () => LockdownClient.open(tcpConnector("127.0.0.1", 1000), { port, timeoutMs: 1000 }),
      log: (s) => logs.push(s),
    },
  };
}

describe("pickUsbDevice", () => {
  it("needs a USB iPhone", () => {
    expect(() => pickUsbDevice([])).toThrow("No iPhone connected over USB");
  });
  it("asks for --udid with several", () => {
    expect(() => pickUsbDevice([usb, { ...usb, deviceId: 8, udid: "OTHER" }])).toThrow("pass --udid");
  });
  it("matches --udid ignoring the dash", () => {
    expect(pickUsbDevice([usb], UDID.replace("-", "")).deviceId).toBe(7);
  });
});

describe("setupWifi", () => {
  it("changes nothing without --yes and says what it would do", async () => {
    const { d, logs } = await deps();
    await expect(setupWifi({}, d)).rejects.toThrow("re-run with --yes");
    expect(dev!.setValues).toEqual([]);
    expect(logs.join("\n")).toContain("This sets EnableWifiConnections=true in com.apple.mobile.wireless_lockdown");
  });

  it("sets EnableWifiConnections with --yes, verifies it and prints what it did", async () => {
    const { d, logs } = await deps();
    await setupWifi({ yes: true }, d);
    expect(dev!.setValues).toEqual([{ domain: "com.apple.mobile.wireless_lockdown", key: "EnableWifiConnections", value: true }]);
    const text = logs.join("\n");
    expect(text).toContain("Set EnableWifiConnections=true in com.apple.mobile.wireless_lockdown on Fake iPhone");
    expect(text).toContain("Pair record cached at");
    expect(text).toContain("install --network");
  });

  it("leaves an already enabled iPhone alone", async () => {
    const { d, logs } = await deps({ "com.apple.mobile.wireless_lockdown": { EnableWifiConnections: true } });
    await setupWifi({ yes: true }, d);
    expect(dev!.setValues).toEqual([]);
    expect(logs.join("\n")).toContain("already enabled");
  });
});
