import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceNotFoundError,
  identify,
  locateDevice,
  NOT_RESPONDING,
  retryWhileUnreachable,
  scanPort,
  subnet24Hosts,
  tcpProbe,
} from "../../src/device/discover.js";
import { DeviceUnreachableError } from "../../src/device/errors.js";
import { FakeDevice, UDID } from "./fakeDevice.js";

describe("subnet24Hosts", () => {
  it("lists .1–.254 without our own address", () => {
    const hosts = subnet24Hosts("192.168.1.100");
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts.at(-1)).toBe("192.168.1.254");
    expect(hosts).not.toContain("192.168.1.100");
  });
  it("rejects non-IPv4 input", () => {
    expect(() => subnet24Hosts("fe80::1")).toThrow("Not an IPv4 address");
  });
});

describe("scanPort", () => {
  it("returns the hosts whose probe succeeds, in address order, within the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = vi.fn(async (h: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return h.endsWith(".10") || h.endsWith(".3");
    });
    const open = await scanPort(subnet24Hosts("192.168.1.100"), { probe, concurrency: 8 });
    expect(open).toEqual(["192.168.1.3", "192.168.1.10"]);
    expect(probe).toHaveBeenCalledTimes(253);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe("tcpProbe and identify", () => {
  let dev: FakeDevice | undefined;
  afterEach(async () => {
    await dev?.close();
    dev = undefined;
  });
  it("probes an open and a closed port", async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await tcpProbe("127.0.0.1", port, 500)).toBe(true);
    server.close();
    expect(await tcpProbe("127.0.0.1", 1, 500)).toBe(false);
  });
  it("identifies the UDID behind a lockdown port", async () => {
    dev = await FakeDevice.start();
    expect(await identify("127.0.0.1", { port: dev.lockdownPort, timeoutMs: 1000 })).toBe(UDID);
  });
});

describe("locateDevice", () => {
  const paired = async (u: string): Promise<boolean> => u === UDID;
  const unreachable = (ip: string): Promise<string> => Promise.reject(new DeviceUnreachableError(ip, 62078, "timeout"));

  it("uses an explicit IP after checking the UDID", async () => {
    const r = await locateDevice({ explicitIp: "10.0.0.5", lanIp: "10.0.0.2", udid: UDID, paired, identify: async () => UDID });
    expect(r).toEqual({ ip: "10.0.0.5", udid: UDID, scanned: false });
  });
  it("refuses another device at an explicit IP", async () => {
    await expect(
      locateDevice({ explicitIp: "10.0.0.5", lanIp: "10.0.0.2", udid: UDID, paired, identify: async () => "OTHER" }),
    ).rejects.toThrow("10.0.0.5 is iPhone OTHER, not");
  });
  it("does not scan when an explicit IP is unreachable", async () => {
    const scan = vi.fn();
    await expect(
      locateDevice({ explicitIp: "10.0.0.5", lanIp: "10.0.0.2", paired, identify: unreachable, scan }),
    ).rejects.toBeInstanceOf(DeviceUnreachableError);
    expect(scan).not.toHaveBeenCalled();
  });
  it("reuses the last known IP without scanning", async () => {
    const scan = vi.fn();
    const r = await locateDevice({ lastIp: "10.0.0.5", lanIp: "10.0.0.2", paired, identify: async () => UDID, scan });
    expect(r.ip).toBe("10.0.0.5");
    expect(scan).not.toHaveBeenCalled();
  });
  it("rescans when the IP changed (DHCP) and finds the paired iPhone by UDID", async () => {
    const logs: string[] = [];
    const ids: Record<string, string> = { "10.0.0.7": "SOME-IPAD", "10.0.0.9": UDID };
    const r = await locateDevice({
      lastIp: "10.0.0.5",
      lanIp: "10.0.0.2",
      paired,
      identify: async (ip) => ids[ip] ?? unreachable(ip),
      scan: async () => ["10.0.0.7", "10.0.0.9"],
      log: (s) => logs.push(s),
    });
    expect(r).toEqual({ ip: "10.0.0.9", udid: UDID, scanned: true });
    expect(logs[0]).toContain("scanning 10.0.0.0/24");
  });
  it("reports not found when nothing paired answers", async () => {
    await expect(
      locateDevice({ lanIp: "10.0.0.2", paired, identify: async () => "OTHER", scan: async () => ["10.0.0.7"] }),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });
  it("asks for --udid when several paired iPhones answer", async () => {
    await expect(
      locateDevice({
        lanIp: "10.0.0.2",
        paired: async () => true,
        identify: async (ip) => `U-${ip}`,
        scan: async () => ["10.0.0.7", "10.0.0.8"],
      }),
    ).rejects.toThrow("pass --udid");
  });
});

describe("retryWhileUnreachable", () => {
  it("retries 3 times 10 s apart with the wake-up message, then gives up with a hint", async () => {
    const logs: string[] = [];
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new DeviceUnreachableError("10.0.0.5", 62078, "timeout");
    });
    await expect(retryWhileUnreachable(fn, { log: (s) => logs.push(s), sleep })).rejects.toThrow(
      "did not respond over Wi‑Fi after 4 tries",
    );
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
    expect(logs).toEqual([NOT_RESPONDING, NOT_RESPONDING, NOT_RESPONDING]);
  });
  it("returns as soon as the iPhone answers", async () => {
    let n = 0;
    const r = await retryWhileUnreachable(
      async () => {
        if (n++ === 0) throw new DeviceUnreachableError("x", 1, "timeout");
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(r).toBe("ok");
  });
  it("does not retry other errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("signature");
    });
    await expect(retryWhileUnreachable(fn, { sleep: async () => {} })).rejects.toThrow("signature");
    expect(fn).toHaveBeenCalledOnce();
  });
});
