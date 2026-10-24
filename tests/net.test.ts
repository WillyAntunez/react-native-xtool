import { createServer as createHttp } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLanIp,
  detectLanRoute,
  findFreePort,
  isMetroRunning,
  isPortFree,
  isPrivateIpv4,
  looksLikeTunnel,
  parseLanIp,
  parseLanRoute,
} from "../src/net.js";

const servers: Server[] = [];

async function holdPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("parseLanIp", () => {
  it("extracts the src address", () => {
    expect(
      parseLanIp("1.1.1.1 via 192.168.1.1 dev enp4s0 src 192.168.1.100 uid 1000"),
    ).toBe("192.168.1.100");
  });

  it("returns undefined for empty output", () => {
    expect(parseLanIp("")).toBeUndefined();
  });
});

describe("detectLanIp", () => {
  it("parses the runner output", async () => {
    const calls: Array<[string, string[]]> = [];
    const ip = await detectLanIp(async (cmd, args) => {
      calls.push([cmd, args]);
      return "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 1000\n";
    });
    expect(ip).toBe("10.0.0.5");
    expect(calls).toEqual([["ip", ["-4", "route", "get", "1.1.1.1"]]]);
  });

  it("throws when no address can be parsed", async () => {
    await expect(detectLanIp(async () => "")).rejects.toThrow(
      "Could not detect LAN IP; set lanIp in expo-xtool.config.json",
    );
  });
});

describe("isPortFree", () => {
  it("is false for a held port and true once released", async () => {
    const port = await holdPort();
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("findFreePort", () => {
  it("skips a held port", async () => {
    const port = await holdPort();
    const found = await findFreePort(port, 10);
    expect(found).not.toBe(port);
    expect(found).toBeGreaterThan(port);
    expect(found).toBeLessThan(port + 10);
  });

  it("throws when the range is exhausted", async () => {
    const port = await holdPort();
    await expect(findFreePort(port, 1)).rejects.toThrow(
      `No free port in range ${port}-${port}`,
    );
  });
});

describe("isMetroRunning", () => {
  async function serve(body: string): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createHttp((_req, res) => res.end(body));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    return { port: addr.port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("is true when the packager reports running", async () => {
    const s = await serve("packager-status:running\n");
    try {
      expect(await isMetroRunning(s.port)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("is false for another service", async () => {
    const s = await serve("hello");
    try {
      expect(await isMetroRunning(s.port)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("is false when nothing listens", async () => {
    const port = await holdPort();
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await isMetroRunning(port)).toBe(false);
  });
});

describe("parseLanRoute", () => {
  it("extracts src and dev", () => {
    expect(parseLanRoute("1.1.1.1 via 10.8.0.1 dev tun0 src 10.8.0.2 uid 1000")).toEqual({
      ip: "10.8.0.2",
      dev: "tun0",
    });
  });
  it("returns empty fields for empty output", () => {
    expect(parseLanRoute("")).toEqual({ ip: undefined, dev: undefined });
  });
});

describe("detectLanRoute", () => {
  it("returns ip and dev from the runner", async () => {
    expect(await detectLanRoute(async () => "1.1.1.1 via 192.168.1.1 dev wlp2s0 src 192.168.1.9")).toEqual({
      ip: "192.168.1.9",
      dev: "wlp2s0",
    });
  });
});

describe("isPrivateIpv4", () => {
  it.each(["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.1"])("%s is private", (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.64.0.1"])("%s is not private", (ip) => {
    expect(isPrivateIpv4(ip)).toBe(false);
  });
});

describe("looksLikeTunnel", () => {
  it.each(["tun0", "tap1", "wg0", "tailscale0", "utun3", "ppp0", "zt0abc", "cscotun0", "gpd0", "nordlynx", "proton0", "vpn0"])("%s is a tunnel", (dev) => {
    expect(looksLikeTunnel(dev)).toBe(true);
  });
  it.each(["eth0", "wlp2s0", "enp4s0", undefined])("%s is not a tunnel", (dev) => {
    expect(looksLikeTunnel(dev)).toBe(false);
  });
});
