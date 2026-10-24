import { PassThrough } from "node:stream";
import * as plist from "plist";
import { describe, expect, it } from "vitest";
import { DeviceClosedError, DeviceTimeoutError } from "../../src/device/errors.js";
import { decodePlist, encodePlistFrame, PlistChannel } from "../../src/device/plistio.js";
import { ByteReader } from "../../src/device/stream.js";

describe("encodePlistFrame", () => {
  it("prefixes an XML plist with its big-endian length", () => {
    const frame = encodePlistFrame({ Request: "QueryType" });
    const len = frame.readUInt32BE(0);
    expect(len).toBe(frame.length - 4);
    const body = frame.subarray(4).toString("utf8");
    expect(body).toContain("<string>QueryType</string>");
    expect(plist.parse(body)).toEqual({ Request: "QueryType" });
  });
});

describe("decodePlist", () => {
  it("parses XML bodies", () => {
    expect(decodePlist(Buffer.from(plist.build({ a: 1 })))).toEqual({ a: 1 });
  });
  it("parses binary bodies", () => {
    expect(decodePlist(Buffer.from(plist.buildBinary({ Command: "Marco", Interval: 10 })))).toEqual({
      Command: "Marco",
      Interval: 10,
    });
  });
  it("rejects a non-dictionary plist", () => {
    expect(() => decodePlist(Buffer.from(plist.build(["x"])))).toThrow("expected a dictionary");
  });
});

describe("ByteReader", () => {
  it("returns exact byte counts across chunk boundaries", async () => {
    const s = new PassThrough();
    const r = new ByteReader(s, "test");
    s.write(Buffer.from([1, 2]));
    s.write(Buffer.from([3, 4, 5]));
    expect([...(await r.read(3))]).toEqual([1, 2, 3]);
    expect([...(await r.read(2))]).toEqual([4, 5]);
  });
  it("waits for data that arrives later", async () => {
    const s = new PassThrough();
    const r = new ByteReader(s, "test");
    const p = r.read(2);
    setTimeout(() => s.write(Buffer.from([7, 8])), 5);
    expect([...(await p)]).toEqual([7, 8]);
  });
  it("fails with DeviceClosedError on EOF", async () => {
    const s = new PassThrough();
    const r = new ByteReader(s, "heartbeat");
    s.end(Buffer.from([1]));
    const err = await r.read(4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceClosedError);
    expect((err as Error).message).toContain("heartbeat");
  });
  it("fails with DeviceTimeoutError after the timeout", async () => {
    const r = new ByteReader(new PassThrough(), "afc");
    const err = await r.read(1, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceTimeoutError);
  });
});

describe("PlistChannel", () => {
  it("round-trips frames written by the peer", async () => {
    const s = new PassThrough();
    const ch = new PlistChannel(s, "lockdown");
    s.write(encodePlistFrame({ Type: "com.apple.mobile.lockdown" }));
    expect(await ch.recv()).toEqual({ Type: "com.apple.mobile.lockdown" });
  });
  it("accepts binary plist frames", async () => {
    const s = new PassThrough();
    const ch = new PlistChannel(s, "heartbeat");
    const body = Buffer.from(plist.buildBinary({ Command: "Marco" }));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    s.write(Buffer.concat([head, body]));
    expect(await ch.recv()).toEqual({ Command: "Marco" });
  });
  it("refuses absurd frame lengths instead of buffering forever", async () => {
    const s = new PassThrough();
    const ch = new PlistChannel(s, "lockdown");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(0xffffffff);
    s.write(head);
    await expect(ch.recv()).rejects.toThrow("frame too large");
  });
});
