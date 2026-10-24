import { afterEach, describe, expect, it } from "vitest";
import { DeviceClosedError, HeartbeatLostError } from "../../src/device/errors.js";
import { Heartbeat, heartbeatStep } from "../../src/device/heartbeat.js";
import { LockdownClient, tcpConnector } from "../../src/device/lockdown.js";
import { PlistChannel } from "../../src/device/plistio.js";
import { FakeDevice, pairRecord, type FakeDeviceOptions } from "./fakeDevice.js";

let dev: FakeDevice | undefined;
let lockdown: LockdownClient | undefined;
afterEach(async () => {
  lockdown?.close();
  lockdown = undefined;
  await dev?.close();
  dev = undefined;
});

const echo = {
  "com.example.echo": (sock: import("node:stream").Duplex) => {
    const ch = new PlistChannel(sock, "echo");
    ch.recv().then((m) => ch.send({ Echo: m.Say! })).catch(() => {});
  },
};

async function session(opts: FakeDeviceOptions): Promise<LockdownClient> {
  dev = await FakeDevice.start(opts);
  lockdown = await LockdownClient.open(tcpConnector("127.0.0.1", 2000), { port: dev.lockdownPort, timeoutMs: 2000 });
  await lockdown.startSession(pairRecord());
  return lockdown;
}

describe("heartbeatStep", () => {
  it("answers Marco with Polo and keeps the interval", () => {
    expect(heartbeatStep({ Command: "Marco", Interval: 10, SupportsSleepyTime: true })).toEqual({
      reply: { Command: "Polo" },
      intervalSec: 10,
    });
  });
  it("defaults the interval when missing", () => {
    expect(heartbeatStep({ Command: "Marco" }).intervalSec).toBe(10);
  });
  it("flags SleepyTime", () => {
    expect(heartbeatStep({ Command: "SleepyTime" })).toEqual({ sleeping: true });
  });
  it("ignores unknown commands", () => {
    expect(heartbeatStep({ Command: "Other" })).toEqual({});
  });
});

describe("Heartbeat", () => {
  it("is what keeps Wi‑Fi services alive (without it the first request is dropped)", async () => {
    const l = await session({ requireHeartbeat: true, services: echo });
    const bare = new PlistChannel(await l.openService("com.example.echo"), "echo");
    await expect(bare.request({ Say: "hi" }, 2000)).rejects.toBeInstanceOf(DeviceClosedError);

    const hb = await Heartbeat.start(l);
    const ch = new PlistChannel(await l.openService("com.example.echo"), "echo");
    expect(await ch.request({ Say: "hi" }, 2000)).toEqual({ Echo: "hi" });
    hb.stop();
    ch.close();
  });

  it("answers every Marco until stopped, then stops cleanly", async () => {
    const l = await session({ heartbeatIntervalSec: 0.02 });
    const hb = await Heartbeat.start(l);
    await new Promise((r) => setTimeout(r, 150));
    expect(dev!.polos).toBeGreaterThan(3);
    hb.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(hb.failure).toBeUndefined();
  });

  it("fails start when no Marco arrives in time", async () => {
    const l = await session({ heartbeatSilent: true });
    await expect(Heartbeat.start(l, { firstMarcoTimeoutMs: 50 })).rejects.toThrow("no answer from the iPhone");
  });

  it("rejects `lost` and fails guarded operations when the iPhone drops", async () => {
    const l = await session({ heartbeatIntervalSec: 0.02 });
    const hb = await Heartbeat.start(l, { slackMs: 100 });
    const pending = hb.guard(new Promise(() => {}));
    dev!.dropAll();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatLostError);
    expect(hb.failure).toBeInstanceOf(HeartbeatLostError);
  });

  it("treats SleepyTime as a lost heartbeat", async () => {
    const l = await session({
      services: {
        "com.apple.mobile.heartbeat": (sock) => {
          const ch = new PlistChannel(sock, "hb");
          void (async () => {
            await ch.send({ Command: "Marco", Interval: 1 });
            await ch.recv();
            await ch.send({ Command: "SleepyTime" });
          })().catch(() => {});
        },
      },
    });
    const hb = await Heartbeat.start(l);
    await expect(hb.lost).rejects.toThrow("going to sleep");
  });
});
