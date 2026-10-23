import { createServer } from "node:net";
import { execa } from "execa";

export type Runner = (cmd: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = async (cmd, args) => {
  const { stdout } = await execa(cmd, args);
  return stdout;
};

export function parseLanIp(ipRouteOutput: string): string | undefined {
  return /\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(ipRouteOutput)?.[1];
}

export interface LanRoute {
  ip?: string;
  dev?: string;
}

/** Source address and interface of the default route, from `ip route get` output. */
export function parseLanRoute(ipRouteOutput: string): LanRoute {
  return {
    ip: parseLanIp(ipRouteOutput),
    dev: /\bdev\s+(\S+)/.exec(ipRouteOutput)?.[1],
  };
}

export function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function looksLikeTunnel(dev?: string): boolean {
  return dev !== undefined && /^(tun|tap|wg|tailscale|utun|ppp|zt)/.test(dev);
}

/** True when the detected address is unlikely to be reachable from the phone's Wi-Fi. */
export function suspiciousLanRoute(route: LanRoute): boolean {
  return route.ip !== undefined && (!isPrivateIpv4(route.ip) || looksLikeTunnel(route.dev));
}

export function tunnelWarning(route: LanRoute): string {
  return `⚠ Detected LAN IP ${route.ip} on ${route.dev ?? "unknown"} looks like a VPN/tunnel address; the iPhone may not reach Metro. Set "lanIp" in expo-xtool.config.json to your Wi‑Fi address if it fails.`;
}

export async function detectLanRoute(runner: Runner = defaultRunner): Promise<LanRoute> {
  return parseLanRoute(await runner("ip", ["-4", "route", "get", "1.1.1.1"]));
}

export async function detectLanIp(runner: Runner = defaultRunner): Promise<string> {
  const out = await runner("ip", ["-4", "route", "get", "1.1.1.1"]);
  const ip = parseLanIp(out);
  if (!ip) {
    throw new Error("Could not detect LAN IP; set lanIp in expo-xtool.config.json");
  }
  return ip;
}

export function isPortFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function findFreePort(start: number, maxTries = 10): Promise<number> {
  for (let port = start; port < start + maxTries; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${start}-${start + maxTries - 1}`);
}

/** True when a Metro packager answers on the port (its /status endpoint says so). */
export async function isMetroRunning(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.text()).trim() === "packager-status:running";
  } catch {
    return false;
  }
}
