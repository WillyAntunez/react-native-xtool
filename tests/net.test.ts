import { createServer as createHttp } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { detectLanIp, findFreePort, isMetroRunning, isPortFree, parseLanIp } from "../src/net.js";

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
