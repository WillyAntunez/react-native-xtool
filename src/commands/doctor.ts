import { execa } from "execa";
import { depsFingerprint } from "../deps.js";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { detectLanRoute, isPortFree, suspiciousLanRoute, tunnelWarning, type LanRoute } from "../net.js";
import { projectPaths } from "../paths.js";
import { readExpoProject } from "../project.js";
import { readState } from "../state.js";
import { NO_FINGERPRINT_WARNING } from "./start.js";
import { sha256File } from "../tools/download.js";
import { toolEnv } from "../tools/exec.js";
import { authStatus, listDevices, defaultXtoolPath, xtoolBin, xtoolUnrunnableError, type AuthStatus, type Device } from "../tools/xtool.js";
import { XTOOL_VERSION, XTOOL_SHA256, SWIFT_VERSION } from "../versions.js";
import { isExecutable, sdkBundle, swiftAtLeast, swiftMeetsMin, swiftVersionText } from "./setup.js";
import { existsSync } from "node:fs";
import { tcpProbe } from "../device/discover.js";
import { LOCKDOWN_PORT, LockdownClient } from "../device/lockdown.js";
import { parsePairRecord } from "../device/pairRecord.js";
import { listUsbDevices, readPairRecordFromUsbmux, usbmuxConnector } from "../device/usbmux.js";
import { wifiEnabled } from "./setupWifi.js";

export interface DoctorCheck {
  name: string;
  /** `info` is a note, never a problem. */
  status: "ok" | "fail" | "warn" | "info";
  detail: string;
}
export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorProbes {
  nodeVersion: () => string;
  swiftVersion: () => Promise<string | undefined>;
  /** Full path of the xtool binary, used in hints. */
  xtoolPath: () => string;
  xtoolInstalled: () => boolean;
  xtoolVersion: () => Promise<string>;
  /** sha256 of the default-path xtool binary; undefined when not checkable (custom xtoolPath, unreadable). */
  xtoolSha256: () => Promise<string | undefined>;
  sdkInstalled: () => boolean;
  authStatus: () => Promise<AuthStatus>;
  devices: () => Promise<Device[]>;
  ufwActive: () => Promise<boolean>;
  /** Source IP and interface of the default route. */
  lanRoute: () => Promise<LanRoute>;
  /** The lanIp pinned in expo-xtool.config.json, if any. */
  configLanIp: () => string | undefined;
  /** Resolves when the project is a supported Expo project; rejects with the reason otherwise. */
  expoProject: (root: string) => Promise<unknown>;
  buildState: (root: string) => Promise<{ metroPort: number; lanIp: string; depsFingerprint?: string } | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  portFree: (port: number) => Promise<boolean>;
  /** Wi‑Fi install readiness; read-only (never caches or changes anything). */
  wifi: (root?: string) => Promise<WifiProbe>;
}

export interface WifiProbe {
  /** `EnableWifiConnections` on the USB-connected iPhone, when one is connected. */
  usb?: { udid: string; enabled: boolean };
  usbError?: string;
  /** Last address the iPhone answered on (`install --network`). */
  lastIp?: string;
  reachable?: boolean;
}

const PROBE_TIMEOUT_MS = 15_000;

const SYMBOL = { ok: "✔", fail: "✖", warn: "⚠", info: "ℹ" } as const;

export function renderReport(checks: DoctorCheck[]): string {
  return checks.map((c) => `${SYMBOL[c.status]} ${c.name} — ${c.detail}`).join("\n");
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function realProbes(config: ExpoXtoolConfig): DoctorProbes {
  const bin = (): string => xtoolBin(config);
  return {
    nodeVersion: () => process.versions.node,
    swiftVersion: () => swiftVersionText(PROBE_TIMEOUT_MS),
    xtoolPath: () => config.xtoolPath ?? defaultXtoolPath(),
    xtoolInstalled: () => isExecutable(config.xtoolPath ?? defaultXtoolPath()),
    xtoolSha256: async () => {
      if (config.xtoolPath) return undefined;
      try {
        return await sha256File(defaultXtoolPath());
      } catch {
        return undefined;
      }
    },
    xtoolVersion: async () => {
      const r = await execa(bin(), ["--version"], {
        env: toolEnv(),
        extendEnv: false,
        reject: false,
        timeout: PROBE_TIMEOUT_MS,
      });
      if (r.timedOut) throw new Error("timed out");
      if (r.failed && r.exitCode !== 0) throw xtoolUnrunnableError(r.exitCode, `${r.stdout}\n${r.stderr}`);
      return `${r.stdout}\n${r.stderr}`.trim();
    },
    sdkInstalled: () => existsSync(sdkBundle()),
    authStatus: () => authStatus(bin(), PROBE_TIMEOUT_MS),
    devices: () => listDevices(bin(), 10_000),
    ufwActive: async () => {
      const r = await execa("systemctl", ["is-active", "ufw"], { reject: false });
      return r.stdout.trim() === "active";
    },
    lanRoute: () => detectLanRoute(),
    configLanIp: () => config.lanIp,
    expoProject: (root) => readExpoProject(root),
    buildState: (root) => readState(projectPaths(root).iosXtool),
    depsFingerprint: (root) => depsFingerprint(root),
    portFree: (port) => isPortFree(port),
    wifi: (root) => probeWifi(root),
  };
}

async function probeWifi(root?: string): Promise<WifiProbe> {
  const probe: WifiProbe = {};
  const [device] = await listUsbDevices().catch(() => []);
  if (device) {
    try {
      const bytes = await readPairRecordFromUsbmux(device.udid);
      if (!bytes) throw new Error("usbmuxd has no pair record — tap Trust on the iPhone");
      const lockdown = await LockdownClient.open(usbmuxConnector(device.deviceId), { timeoutMs: 5000 });
      try {
        await lockdown.startSession(parsePairRecord(bytes, "usbmuxd pair record"));
        probe.usb = { udid: device.udid, enabled: await wifiEnabled(lockdown) };
      } finally {
        lockdown.close();
      }
    } catch (e) {
      probe.usbError = message(e);
    }
  }
  const state = root ? await readState(projectPaths(root).iosXtool).catch(() => undefined) : undefined;
  if (state?.deviceIp) {
    probe.lastIp = state.deviceIp;
    probe.reachable = await tcpProbe(state.deviceIp, LOCKDOWN_PORT, 2000);
  }
  return probe;
}

/** Wi‑Fi installs are optional: this check warns at most. */
export function wifiCheck(p: WifiProbe): Omit<DoctorCheck, "name"> {
  const notes: string[] = [];
  let status: DoctorCheck["status"] = "ok";
  if (p.usb) {
    if (p.usb.enabled) notes.push(`enabled on ${p.usb.udid}`);
    else {
      status = "warn";
      notes.push(`Wi‑Fi connections are off on ${p.usb.udid} — run expo-xtool setup --wifi --yes`);
    }
  }
  if (p.usbError) notes.push(`could not read the setting over USB (${p.usbError})`);
  if (p.lastIp) {
    if (p.reachable) notes.push(`iPhone answers at ${p.lastIp}:${LOCKDOWN_PORT}`);
    else {
      status = "warn";
      notes.push(
        `last known iPhone address ${p.lastIp} does not answer on port ${LOCKDOWN_PORT} (asleep or locked, another network, a firewall, or a new IP — install --network rescans)`,
      );
    }
  }
  if (!p.usb && !p.lastIp) {
    if (!p.usbError) return { status: "info", detail: "not set up (optional) — see `expo-xtool setup --wifi`" };
    status = "info";
  }
  return { status, detail: notes.join("; ") };
}

async function check(name: string, fn: () => Promise<Omit<DoctorCheck, "name">>): Promise<DoctorCheck> {
  try {
    return { name, ...(await fn()) };
  } catch (e) {
    return { name, status: "fail", detail: message(e) };
  }
}

export async function doctorWithProbes(p: DoctorProbes, root?: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = async (name: string, fn: () => Promise<Omit<DoctorCheck, "name">>): Promise<void> => {
    checks.push(await check(name, fn));
  };

  await add("node", async () => {
    const v = p.nodeVersion();
    return { status: Number(v.split(".")[0]) >= 20 ? "ok" : "fail", detail: v };
  });
  await add("swift", async () => {
    const v = await p.swiftVersion();
    if (!v) return { status: "fail", detail: "not found — run expo-xtool setup" };
    return swiftMeetsMin(v)
      ? { status: "ok", detail: v }
      : { status: "fail", detail: `${v} (need ${SWIFT_VERSION}+) — run expo-xtool setup` };
  });
  const swiftCheck = checks.find((c) => c.name === "swift");
  if (swiftCheck?.status === "ok" && swiftAtLeast(swiftCheck.detail, "6.5")) {
    checks.push({
      name: "swift-manifests",
      status: "info",
      detail:
        "Swift 6.5+: mixed Swift + Objective-C packages use the 6.5 manifest form (untested): Package@swift-6.5.swift, SE-0541, no experimentalMultiLang flag",
    });
  }
  await add("xtool", async () => {
    if (!p.xtoolInstalled()) return { status: "fail", detail: "not found — run expo-xtool setup" };
    const v = await p.xtoolVersion();
    if (!v.includes(XTOOL_VERSION)) {
      return { status: "warn", detail: `expected ${XTOOL_VERSION}, got ${v || "unknown"}` };
    }
    const pinned = XTOOL_SHA256[process.arch === "arm64" ? "aarch64" : "x86_64"];
    const actual = pinned ? await p.xtoolSha256() : undefined;
    if (pinned && actual && actual !== pinned) {
      return { status: "warn", detail: `${XTOOL_VERSION}, but sha256 ${actual} differs from the pinned ${pinned} — delete ${p.xtoolPath()} and run expo-xtool setup` };
    }
    return { status: "ok", detail: XTOOL_VERSION };
  });
  await add("darwin-sdk", async () =>
    p.sdkInstalled()
      ? { status: "ok", detail: "installed" }
      : { status: "fail", detail: "not found — run expo-xtool setup --xcode-xip <path>" },
  );
  await add("apple-login", async () => {
    if (!p.xtoolInstalled()) return { status: "fail", detail: "xtool not installed" };
    const a = await p.authStatus();
    return a.loggedIn
      ? { status: "ok", detail: `Apple ID ${a.appleId ?? "unknown"}, Team ID ${a.teamId ?? "unknown"}` }
      : { status: "fail", detail: `logged out — run ${p.xtoolPath()} auth login` };
  });
  await add("device", async () => {
    if (!p.xtoolInstalled()) return { status: "warn", detail: "xtool not installed" };
    let d: Device | undefined;
    try {
      [d] = await p.devices();
    } catch (e) {
      return { status: "warn", detail: message(e) };
    }
    return d
      ? { status: "ok", detail: `${d.name} (${d.transport})` }
      : { status: "warn", detail: "no USB device found — connect and unlock your iPhone" };
  });
  await add("wifi", async () => {
    try {
      return wifiCheck(await p.wifi(root));
    } catch (e) {
      return { status: "warn", detail: message(e) };
    }
  });
  const stateResult =
    root === undefined
      ? undefined
      : await p.buildState(root).then(
          (state) => ({ state }),
          (error: unknown) => ({ error }),
        );
  const knownPort = stateResult && "state" in stateResult ? stateResult.state?.metroPort : undefined;
  await add("firewall", async () => {
    let active: boolean;
    try {
      active = await p.ufwActive();
    } catch {
      return { status: "ok", detail: "could not query ufw" };
    }
    return active
      ? {
          status: "warn",
          detail: `ufw is active: allow the Metro port, e.g. sudo ufw allow ${knownPort ?? "<port>"}/tcp`,
        }
      : { status: "ok", detail: "ufw not active" };
  });

  await add("lan-ip", async () => {
    const pinned = p.configLanIp();
    if (pinned) return { status: "ok", detail: `${pinned} (from config)` };
    const route = await p.lanRoute().catch((): LanRoute => ({}));
    if (!route.ip) {
      return { status: "fail", detail: 'could not detect the LAN IP; set "lanIp" in expo-xtool.config.json' };
    }
    return suspiciousLanRoute(route)
      ? { status: "warn", detail: tunnelWarning(route).replace(/^⚠ /, "") }
      : { status: "ok", detail: `${route.ip} (${route.dev ?? "unknown"})` };
  });

  if (root !== undefined && stateResult) {
    await add("expo-sdk", async () => {
      await p.expoProject(root);
      return { status: "ok", detail: "supported Expo project" };
    });
    await add("build-state", async () => {
      if ("error" in stateResult) {
        return { status: "warn", detail: `unreadable build state (${message(stateResult.error)}) — run expo-xtool build` };
      }
      const state = stateResult.state;
      return state
        ? { status: "ok", detail: `port ${state.metroPort}, ip ${state.lanIp}` }
        : { status: "warn", detail: "no build yet — run expo-xtool build" };
    });
    if ("state" in stateResult && stateResult.state) {
      const { metroPort, depsFingerprint } = stateResult.state;
      await add("deps", async () => {
        if (depsFingerprint === undefined) return { status: "warn", detail: NO_FINGERPRINT_WARNING };
        return depsFingerprint === (await p.depsFingerprint(root))
          ? { status: "ok", detail: "unchanged since last build" }
          : { status: "warn", detail: "dependencies changed since last build — run expo-xtool build && expo-xtool install" };
      });
      await add("metro-port", async () =>
        (await p.portFree(metroPort))
          ? { status: "ok", detail: `port ${metroPort} is free` }
          : { status: "warn", detail: `port ${metroPort} is busy` },
      );
    }
  }

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

export async function doctor(root?: string, probes?: DoctorProbes): Promise<DoctorReport> {
  const config = await loadConfig(root ?? process.cwd());
  return doctorWithProbes(probes ?? realProbes(config), root);
}
