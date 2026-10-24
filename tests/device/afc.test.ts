import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AFC_HEADER_SIZE,
  AFC_SERVICE,
  AfcClient,
  AfcOp,
  afcPacket,
  AfcStatusError,
  cstring,
  decodeAfcHeader,
  encodeAfcHeader,
} from "../../src/device/afc.js";
import { isConnectionFailure } from "../../src/device/errors.js";
import { Heartbeat } from "../../src/device/heartbeat.js";
import { LockdownClient, tcpConnector } from "../../src/device/lockdown.js";
import { FakeDevice, pairRecord, type FakeDeviceOptions } from "./fakeDevice.js";

describe("AFC packet codec", () => {
  it("round-trips a header", () => {
    const h = { entireLength: 100, thisLength: 48, packetNum: 3, op: AfcOp.FileWrite };
    const b = encodeAfcHeader(h);
    expect(b.length).toBe(AFC_HEADER_SIZE);
    expect(b.subarray(0, 8).toString()).toBe("CFA6LPAA");
    expect(decodeAfcHeader(b)).toEqual(h);
  });
  it("rejects a bad magic", () => {
    expect(() => decodeAfcHeader(Buffer.alloc(40))).toThrow("bad packet header");
  });
  it("counts only header + args in this_length and the data in entire_length (FileWrite)", () => {
    const [head, data] = afcPacket(AfcOp.FileWrite, 0, Buffer.alloc(8), Buffer.alloc(1000));
    const h = decodeAfcHeader(head!);
    expect(h.thisLength).toBe(48);
    expect(h.entireLength).toBe(1048);
    expect(data!.length).toBe(1000);
  });
  it("uses entire_length = this_length without data", () => {
    const parts = afcPacket(AfcOp.MakeDir, 1, cstring("/PublicStaging"));
    expect(parts).toHaveLength(1);
    const h = decodeAfcHeader(parts[0]!);
    expect(h.entireLength).toBe(h.thisLength);
    expect(h.entireLength).toBe(40 + "/PublicStaging".length + 1);
  });
  it("explains NoSpaceLeft", () => {
    expect(new AfcStatusError("FileWrite", 18).message).toContain("out of storage");
    expect(new AfcStatusError("RemovePath", 8, "/x").message).toBe("AFC RemovePath /x failed: ObjectNotFound");
  });
});

describe("AfcClient against a fake iPhone", () => {
  let dev: FakeDevice | undefined;
  let lockdown: LockdownClient | undefined;
  let hb: Heartbeat | undefined;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "expo-xtool-afc-"));
  });
  afterEach(async () => {
    hb?.stop();
    lockdown?.close();
    await dev?.close();
    [dev, lockdown, hb] = [undefined, undefined, undefined];
    await rm(dir, { recursive: true, force: true });
  });

  async function afc(opts: FakeDeviceOptions = {}): Promise<AfcClient> {
    dev = await FakeDevice.start({ requireHeartbeat: true, ...opts });
    lockdown = await LockdownClient.open(tcpConnector("127.0.0.1", 2000), { port: dev.lockdownPort, timeoutMs: 2000 });
    await lockdown.startSession(pairRecord());
    hb = await Heartbeat.start(lockdown);
    return new AfcClient(await lockdown.openService(AFC_SERVICE), 2000);
  }

  async function localFile(size: number): Promise<{ path: string; bytes: Buffer }> {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7) & 0xff;
    const path = join(dir, "App.ipa");
    await writeFile(path, bytes);
    return { path, bytes };
  }

  it("streams a file in bounded chunks and reports progress", async () => {
    const client = await afc();
    const { path, bytes } = await localFile(10_000);
    const progress: number[] = [];
    await client.makeDir("/PublicStaging");
    const total = await client.upload(path, "/PublicStaging/a.ipa", {
      chunkSize: 4096,
      onProgress: (sent) => progress.push(sent),
    });
    expect(total).toBe(10_000);
    expect(dev!.files.get("/PublicStaging/a.ipa")).toEqual(bytes);
    expect(dev!.maxAfcWrite).toBe(4096);
    expect(progress).toEqual([0, 4096, 8192, 10_000]);
    expect(dev!.afcOps).toContain("FileOpen /PublicStaging/a.ipa mode 3");
    client.close();
  });

  it("caps chunks at 4 MB", async () => {
    const client = await afc();
    const { path } = await localFile(5 * 1024 * 1024);
    await client.upload(path, "/PublicStaging/big.ipa", { chunkSize: 64 * 1024 * 1024 });
    expect(dev!.maxAfcWrite).toBe(4 * 1024 * 1024);
    client.close();
  });

  it("removes a staged file and reports missing ones", async () => {
    const client = await afc();
    const { path } = await localFile(10);
    await client.upload(path, "/PublicStaging/a.ipa");
    await client.removePath("/PublicStaging/a.ipa");
    expect(dev!.files.has("/PublicStaging/a.ipa")).toBe(false);
    await expect(client.removePath("/PublicStaging/a.ipa")).rejects.toThrow("ObjectNotFound");
    client.close();
  });

  it("surfaces a device status on write", async () => {
    const client = await afc({ afcWriteStatus: 18 });
    const { path } = await localFile(10);
    await expect(client.upload(path, "/PublicStaging/a.ipa")).rejects.toThrow("out of storage");
    client.close();
  });

  it("fails with a closed connection when Wi‑Fi drops mid-upload", async () => {
    const client = await afc({ afcDropOnWrite: 2 });
    const { path } = await localFile(10_000);
    const err = await client.upload(path, "/PublicStaging/a.ipa", { chunkSize: 4096 }).catch((e: unknown) => e);
    // EOF or RST depending on timing: both are a lost connection.
    expect(isConnectionFailure(err)).toBe(true);
  });
});
