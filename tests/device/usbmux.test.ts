import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plist from "plist";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockdownClient } from "../../src/device/lockdown.js";
import { loadPairRecord, pairedUdids, PairRecordMissingError } from "../../src/device/pairRecord.js";
import { decodePlist, type PlistDict } from "../../src/device/plistio.js";
import {
  encodeMuxPacket,
  listUsbDevices,
  readPairRecordFromUsbmux,
  sameUdid,
  usbmuxAddress,
  usbmuxConnector,
} from "../../src/device/usbmux.js";
import { FakeDevice, HOST_CERT, HOST_KEY, UDID } from "./fakeDevice.js";

const RECORD = Buffer.from(
  plist.build({
    HostID: "HOST-1",
    SystemBUID: "BUID-1",
    HostCertificate: HOST_CERT,
    HostPrivateKey: HOST_KEY,
    DeviceCertificate: HOST_CERT,
  }),
);

let dir: string;
let servers: net.Server[] = [];
let dev: FakeDevice | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "expo-xtool-mux-"));
});
afterEach(async () => {
  for (const s of servers) s.close();
  servers = [];
  await dev?.close();
  dev = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A fake usbmuxd on a unix socket; `Connect` to 62078 is tunnelled to `lockdownPort`. */
async function fakeUsbmuxd(opts: { record?: Buffer; lockdownPort?: number; seen?: PlistDict[] }): Promise<string> {
  const path = join(dir, "usbmuxd.sock");
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on("error", () => {});
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16 && buf.length >= buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        const tag = buf.readUInt32LE(12);
        const msg = decodePlist(buf.subarray(16, len));
        buf = buf.subarray(len);
        opts.seen?.push(msg);
        const reply = (r: PlistDict): boolean => s.write(encodeMuxPacket(tag, r));
        switch (msg.MessageType) {
          case "ListDevices":
            reply({
              DeviceList: [
                { DeviceID: 7, MessageType: "Attached", Properties: { ConnectionType: "USB", DeviceID: 7, SerialNumber: UDID } },
                { DeviceID: 9, MessageType: "Attached", Properties: { ConnectionType: "Network", DeviceID: 9, SerialNumber: "x" } },
                { DeviceID: 10, MessageType: "Attached", Properties: { ConnectionType: "USB", DeviceID: 10, SerialNumber: "0000803000000000CAFEF00D" } },
                { DeviceID: 11, MessageType: "Attached", Properties: { ConnectionType: "USB", DeviceID: 11, SerialNumber: "../evil" } },
              ],
            });
            break;
          case "ReadPairRecord":
            reply(opts.record ? { PairRecordData: opts.record } : { MessageType: "Result", Number: 2 });
            break;
          case "Connect": {
            const port = Number(msg.PortNumber);
            if (port !== ((62078 & 0xff) << 8 | 62078 >> 8) || !opts.lockdownPort) {
              reply({ MessageType: "Result", Number: 3 });
              break;
            }
            reply({ MessageType: "Result", Number: 0 });
            s.off("data", onData);
            const up = net.connect(opts.lockdownPort, "127.0.0.1");
            up.on("error", () => s.destroy());
            s.pipe(up).pipe(s);
            return;
          }
        }
      }
    };
    s.on("data", onData);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return path;
}

describe("usbmuxAddress", () => {
  it("defaults to /var/run/usbmuxd and honours USBMUXD_SOCKET_ADDRESS", () => {
    expect(usbmuxAddress({})).toEqual({ path: "/var/run/usbmuxd" });
    expect(usbmuxAddress({ USBMUXD_SOCKET_ADDRESS: "UNIX:/tmp/m" })).toEqual({ path: "/tmp/m" });
    expect(usbmuxAddress({ USBMUXD_SOCKET_ADDRESS: "127.0.0.1:27015" })).toEqual({ host: "127.0.0.1", port: 27015 });
  });
});

describe("encodeMuxPacket", () => {
  it("writes a little-endian plist header with the tag", () => {
    const p = encodeMuxPacket(5, { MessageType: "ListDevices" });
    expect(p.readUInt32LE(0)).toBe(p.length);
    expect([p.readUInt32LE(4), p.readUInt32LE(8), p.readUInt32LE(12)]).toEqual([1, 8, 5]);
    expect(decodePlist(p.subarray(16))).toMatchObject({ MessageType: "ListDevices", ProgName: "expo-xtool" });
  });
});

describe("sameUdid", () => {
  it("ignores the dash usbmuxd may drop", () => {
    expect(sameUdid("00008030-00000000DEADBEEF", "0000803000000000deadbeef")).toBe(true);
  });
});

describe("usbmuxd client", () => {
  it("reads a pair record", async () => {
    const path = await fakeUsbmuxd({ record: RECORD });
    expect(await readPairRecordFromUsbmux(UDID, { path })).toEqual(RECORD);
  });
  it("returns undefined when usbmuxd has no record or is not running", async () => {
    const path = await fakeUsbmuxd({});
    expect(await readPairRecordFromUsbmux(UDID, { path })).toBeUndefined();
    expect(await readPairRecordFromUsbmux(UDID, { path: join(dir, "missing.sock") })).toBeUndefined();
  });
  it("lists only USB devices", async () => {
    const path = await fakeUsbmuxd({});
    expect(await listUsbDevices({ path })).toEqual([
      { deviceId: 7, udid: UDID, connectionType: "USB" },
      { deviceId: 10, udid: "00008030-00000000CAFEF00D", connectionType: "USB" },
    ]);
    expect(await listUsbDevices({ path: join(dir, "missing.sock") })).toEqual([]);
  });
  it("tunnels lockdown over Connect with the port byte-swapped", async () => {
    dev = await FakeDevice.start({ udidBeforeSession: true });
    const path = await fakeUsbmuxd({ lockdownPort: dev.lockdownPort });
    const l = await LockdownClient.open(usbmuxConnector(7, { path }), { timeoutMs: 2000 });
    expect(await l.udid()).toBe(UDID);
    l.close();
  });
});

describe("loadPairRecord", () => {
  const cacheDir = (): string => join(dir, "cache");
  it("prefers usbmuxd and caches the record privately", async () => {
    const r = await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir, fromUsbmux: async () => RECORD });
    expect(r.source).toBe("usbmuxd");
    const file = join(cacheDir(), `${UDID}.plist`);
    expect(await readFile(file)).toEqual(RECORD);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it("falls back to the cache when usbmuxd is down", async () => {
    await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir, fromUsbmux: async () => RECORD });
    const r = await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir, fromUsbmux: async () => undefined });
    expect(r.source).toBe(join(cacheDir(), `${UDID}.plist`));
  });
  it("reads usbmuxd's store directly and caches it", async () => {
    await writeFile(join(dir, `${UDID}.plist`), RECORD);
    const r = await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir });
    expect(r.source).toBe(join(dir, `${UDID}.plist`));
    expect(await readFile(join(cacheDir(), `${UDID}.plist`))).toEqual(RECORD);
  });
  it("uses --pair-record as given", async () => {
    const file = join(dir, "copied.plist");
    await writeFile(file, RECORD);
    const r = await loadPairRecord(UDID, { override: file, cacheDir: cacheDir(), fromUsbmux: async () => undefined });
    expect(r.record.HostID).toBe("HOST-1");
  });
  it("explains both pairing paths when nothing is found", async () => {
    const err = await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairRecordMissingError);
    expect((err as Error).message).toContain("setup --wifi");
    expect((err as Error).message).toContain("--pair-record");
  });
  it("refuses a UDID that is not one before touching any path", async () => {
    await expect(loadPairRecord("../../etc/passwd", { cacheDir: cacheDir(), lockdownDir: dir })).rejects.toThrow(
      "invalid UDID",
    );
  });
  it("makes an existing cache dir private and leaves no temp file", async () => {
    const { mkdir, readdir } = await import("node:fs/promises");
    await mkdir(cacheDir(), { mode: 0o755 });
    await loadPairRecord(UDID, { cacheDir: cacheDir(), lockdownDir: dir, fromUsbmux: async () => RECORD });
    expect((await stat(cacheDir())).mode & 0o777).toBe(0o700);
    expect(await readdir(cacheDir())).toEqual([`${UDID}.plist`]);
  });
  it("lists paired UDIDs from the cache and the store", async () => {
    await writeFile(join(dir, `${UDID}.plist`), RECORD);
    await writeFile(join(dir, "SystemConfiguration.plist"), "x");
    expect(await pairedUdids({ cacheDir: cacheDir(), lockdownDir: dir })).toEqual([UDID]);
  });
});
