import { afterEach, describe, expect, it } from "vitest";
import * as plist from "plist";
import { DeviceUnreachableError } from "../../src/device/errors.js";
import {
  LockdownClient,
  LockdownError,
  lockdownErrorMessage,
  tcpConnector,
  WIRELESS_LOCKDOWN_DOMAIN,
} from "../../src/device/lockdown.js";
import { parsePairRecord } from "../../src/device/pairRecord.js";
import { PlistChannel } from "../../src/device/plistio.js";
import { FakeDevice, foreignPairRecord, HOST_CERT, HOST_KEY, pairRecord, UDID } from "./fakeDevice.js";

let dev: FakeDevice | undefined;
afterEach(async () => {
  await dev?.close();
  dev = undefined;
});

const open = async (d: FakeDevice): Promise<LockdownClient> =>
  LockdownClient.open(tcpConnector("127.0.0.1", 2000), { port: d.lockdownPort, timeoutMs: 2000 });

describe("parsePairRecord", () => {
  it("reads the host credentials from an XML record", () => {
    const xml = plist.build({
      HostID: "H",
      SystemBUID: "B",
      HostCertificate: HOST_CERT,
      HostPrivateKey: HOST_KEY,
      EscrowBag: Buffer.from([1, 2]),
      WiFiMACAddress: "14:7d:da:ed:7d:8c",
    });
    const r = parsePairRecord(Buffer.from(xml), "x.plist");
    expect(r.HostID).toBe("H");
    expect(r.HostCertificate.toString()).toContain("BEGIN CERTIFICATE");
    expect(r.EscrowBag).toEqual(Buffer.from([1, 2]));
  });
  it("reads a binary record", () => {
    const bin = plist.buildBinary({ HostID: "H", SystemBUID: "B", HostCertificate: HOST_CERT, HostPrivateKey: HOST_KEY });
    expect(parsePairRecord(Buffer.from(bin), "x").SystemBUID).toBe("B");
  });
  it("names the missing keys", () => {
    expect(() => parsePairRecord(Buffer.from(plist.build({ HostID: "H" })), "rec.plist")).toThrow(
      "rec.plist is not a usable pair record (missing SystemBUID, HostCertificate, HostPrivateKey)",
    );
  });
});

describe("lockdownErrorMessage", () => {
  it("explains a removed pairing with the re-pair recipe", () => {
    expect(lockdownErrorMessage("StartSession", "InvalidHostID")).toContain("setup --wifi");
  });
  it("asks to unlock on PasswordProtected", () => {
    expect(lockdownErrorMessage("StartService", "PasswordProtected")).toContain("unlock");
  });
});

describe("tcpConnector", () => {
  it("maps a refused port to DeviceUnreachableError", async () => {
    // Port 1 on localhost is closed.
    await expect(tcpConnector("127.0.0.1", 1000)(1)).rejects.toBeInstanceOf(DeviceUnreachableError);
  });
});

describe("LockdownClient", () => {
  it("reads the UDID before a session where the device allows it (USB)", async () => {
    dev = await FakeDevice.start({ udidBeforeSession: true });
    const l = await open(dev);
    expect(await l.udid()).toBe(UDID);
    l.close();
  });

  it("gets GetProhibited for the UDID before a session over Wi‑Fi, and the UDID inside one", async () => {
    dev = await FakeDevice.start();
    const l = await open(dev);
    const err = await l.udid().catch((e: unknown) => e);
    expect((err as LockdownError).code).toBe("GetProhibited");
    await l.startSession(pairRecord());
    expect(await l.udid()).toBe(UDID);
    l.close();
  });

  it("times out on a phone that accepts TCP but never answers", async () => {
    dev = await FakeDevice.start({ silent: true });
    await expect(
      LockdownClient.open(tcpConnector("127.0.0.1", 1000), { port: dev.lockdownPort, timeoutMs: 100 }),
    ).rejects.toThrow("no answer from the iPhone");
  });

  it("upgrades the session to TLS and reads domain values over it", async () => {
    dev = await FakeDevice.start();
    const l = await open(dev);
    await l.startSession(pairRecord());
    expect(l.sessionId).toBe("S-1");
    expect(await l.getValue("EnableWifiConnections", WIRELESS_LOCKDOWN_DOMAIN)).toBe(false);
    await l.setValue(WIRELESS_LOCKDOWN_DOMAIN, "EnableWifiConnections", true);
    expect(dev.setValues).toEqual([{ domain: WIRELESS_LOCKDOWN_DOMAIN, key: "EnableWifiConnections", value: true }]);
    l.close();
  });

  it("reports an unknown HostID as a removed pairing", async () => {
    dev = await FakeDevice.start({ hostId: "OTHER" });
    const l = await open(dev);
    const err = await l.startSession(pairRecord()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockdownError);
    expect((err as LockdownError).code).toBe("InvalidHostID");
    l.close();
  });

  it("reports a TLS drop during StartSession as a rejected pairing", async () => {
    dev = await FakeDevice.start();
    const l = await open(dev);
    const err = await l.startSession(foreignPairRecord()).catch((e: unknown) => e);
    expect((err as LockdownError).code).toBe("PairingRejected");
    l.close();
  });

  it("opens a TLS service connection on the port StartService returns", async () => {
    dev = await FakeDevice.start({
      services: {
        "com.example.echo": (sock) => {
          const ch = new PlistChannel(sock, "echo");
          ch.recv().then((m) => ch.send({ Echo: m.Say! })).catch(() => {});
        },
      },
    });
    const l = await open(dev);
    await l.startSession(pairRecord());
    const ch = new PlistChannel(await l.openService("com.example.echo"), "echo");
    expect(await ch.request({ Say: "hi" }, 2000)).toEqual({ Echo: "hi" });
    ch.close();
    l.close();
  });

  it("surfaces StartService errors", async () => {
    dev = await FakeDevice.start();
    const l = await open(dev);
    await l.startSession(pairRecord());
    await expect(l.openService("com.apple.nope")).rejects.toThrow("refused to start com.apple.nope");
    l.close();
  });
});
