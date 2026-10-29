import { execa } from "execa";
import { depsFingerprint } from "../deps.js";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { detectLanRoute, isPortFree, suspiciousLanRoute, tunnelWarning, type LanRoute } from "../net.js";
import { projectPaths } from "../paths.js";
import { MissingBundleIdentifierError, readProject, RN_CLI_MISSING, type ProjectKind } from "../project/index.js";
import { openPbxproj } from "../project/pbxproj.js";
import { makeNmRunner } from "../pipeline/symbols.js";
import { readState } from "../state.js";
import { NO_FINGERPRINT_WARNING } from "./start.js";
import { sha256File } from "../tools/download.js";
import { toolEnv } from "../tools/exec.js";
import { authStatus, listDevices, defaultXtoolPath, xtoolBin, xtoolUnrunnableError, type AuthStatus, type Device } from "../tools/xtool.js";
import { XTOOL_VERSION, XTOOL_SHA256, SWIFT_VERSION, type ExpoPlugin, type RnScripts } from "../versions.js";
import { isExecutable, sdkBundle, swiftAtLeast, swiftMeetsMin, swiftVersionText } from "./setup.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  /** The LLVM version of the Swift toolchain's llvm-nm (G4 needs it); rejects with LLVM_NM_MISSING when it is missing. */
  llvmNmVersion: () => Promise<string>;
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
  /** The lanIp pinned in rn-xtool.config.json, if any. */
  configLanIp: () => string | undefined;
  /** Reads the project without writing anything; rejects with the detect/read error. */
  project: (root: string) => Promise<ProjectProbe>;
  buildState: (root: string) => Promise<{ metroPort: number; lanIp: string; depsFingerprint?: string; kind?: ProjectKind } | undefined>;
  depsFingerprint: (root: string) => Promise<string>;
  portFree: (port: number) => Promise<boolean>;
  /** Wi‑Fi install readiness; read-only (never caches or changes anything). */
  wifi: (root?: string) => Promise<WifiProbe>;
}

export interface ProjectProbe {
  kind: ProjectKind;
  rnVersion: string;
  rnScripts: RnScripts;
  expoPlugin: ExpoPlugin;
  sdkVersion?: number;
  bundleIdentifier: string;
  hasExpoModules: boolean;
  /** bare: the app target and the `.xcodeproj` it lives in. */
  target?: { name: string; xcodeproj: string };
  /** Warnings the reader logged, e.g. expo-modules-core installed without `use_expo_modules!` in the Podfile. */
  warnings: string[];
}

/** The real `project` probe: `readProject` in read-only mode, its warnings captured instead of printed. */
export async function readProjectProbe(root: string): Promise<ProjectProbe> {
  const warnings: string[] = [];
  const info = await readProject(root, { writeDefaults: false, log: (line) => warnings.push(line.replace(/^⚠ /, "")) });
  if (info.kind === "bare" && info.hasRnCli === false) warnings.push(RN_CLI_MISSING);
  return {
    kind: info.kind,
    rnVersion: info.rnVersion,
    rnScripts: info.rnScripts,
    expoPlugin: info.expoPlugin,
    ...(info.sdkVersion !== undefined && { sdkVersion: info.sdkVersion }),
    bundleIdentifier: info.bundleIdentifier,
    hasExpoModules: info.hasExpoModules,
    ...(info.kind === "bare" && {
      target: { name: info.iosTargetName, xcodeproj: `${openPbxproj(join(root, "ios")).projectName}.xcodeproj` },
    }),
    warnings,
  };
}

function projectSummary(p: ProjectProbe): string {
  if (p.kind === "expo") {
    const vendored = p.expoPlugin === "vendored" ? " (vendored Expo SwiftPM plugin and SwiftPM scripts)" : "";
    return `expo SDK ${p.sdkVersion ?? "unknown"}, React Native ${p.rnVersion}${vendored}`;
  }
  const kind = p.hasExpoModules ? "bare + expo modules, React Native" : "bare React Native";
  const scripts = p.rnScripts === "vendored" ? " (vendored SwiftPM scripts)" : "";
  return `${kind} ${p.rnVersion}${scripts}${p.target ? `, target ${p.target.name} (${p.target.xcodeproj})` : ""}`;
}

function missingBundleIdDetail(err: MissingBundleIdentifierError): string {
  if (err.configFile === "project.pbxproj") {
    // Bare projects are never written to: the user sets it in Xcode or in the pbxproj.
    return `PRODUCT_BUNDLE_IDENTIFIER is missing for the app target in ${err.configFile}; add "${err.suggestion}" (or your own) to it`;
  }
  return err.configFile.endsWith(".json")
    ? `ios.bundleIdentifier is missing in ${err.configFile}; rn-xtool build writes "${err.suggestion}" there`
    : `ios.bundleIdentifier is missing in ${err.configFile}; add "${err.suggestion}" (or your own) to it`;
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
    llvmNmVersion: async () =>
      /LLVM version (\S+)/.exec(await makeNmRunner("llvm-nm", PROBE_TIMEOUT_MS)(["--version"]))?.[1] ?? "unknown",
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
    project: (root) => readProjectProbe(root),
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
      notes.push(`Wi‑Fi connections are off on ${p.usb.udid} — run rn-xtool setup --wifi --yes`);
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
    if (!p.usbError) return { status: "info", detail: "not set up (optional) — see `rn-xtool setup --wifi`" };
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
    if (!v) return { status: "fail", detail: "not found — run rn-xtool setup" };
    return swiftMeetsMin(v)
      ? { status: "ok", detail: v }
      : { status: "fail", detail: `${v} (need ${SWIFT_VERSION}+) — run rn-xtool setup` };
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
  // Every build's frameworks step (G4) runs it, with no bypass: a missing one fails here instead of minutes into a build.
  await add("llvm-nm", async () => ({ status: "ok", detail: `LLVM ${await p.llvmNmVersion()}` }));
  await add("xtool", async () => {
    if (!p.xtoolInstalled()) return { status: "fail", detail: "not found — run rn-xtool setup" };
    const v = await p.xtoolVersion();
    if (!v.includes(XTOOL_VERSION)) {
      return { status: "warn", detail: `expected ${XTOOL_VERSION}, got ${v || "unknown"}` };
    }
    const pinned = XTOOL_SHA256[process.arch === "arm64" ? "aarch64" : "x86_64"];
    const actual = pinned ? await p.xtoolSha256() : undefined;
    if (pinned && actual && actual !== pinned) {
      return { status: "warn", detail: `${XTOOL_VERSION}, but sha256 ${actual} differs from the pinned ${pinned} — delete ${p.xtoolPath()} and run rn-xtool setup` };
    }
    return { status: "ok", detail: XTOOL_VERSION };
  });
  await add("darwin-sdk", async () =>
    p.sdkInstalled()
      ? { status: "ok", detail: "installed" }
      : { status: "fail", detail: "not found — run rn-xtool setup --xcode-xip <path>" },
  );
  await add("apple-login", async () => {
    if (!p.xtoolInstalled()) return { status: "fail", detail: "xtool not installed" };
    const a = await p.authStatus();
    return a.loggedIn
      ? { status: "ok", detail: `Apple ID ${a.appleId ?? "unknown"}, Team ID ${a.teamId ?? "unknown"}` }
      : { status: "fail", detail: `logged out — run rn-xtool auth login` };
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
      return { status: "fail", detail: 'could not detect the LAN IP; set "lanIp" in rn-xtool.config.json' };
    }
    return suspiciousLanRoute(route)
      ? { status: "warn", detail: tunnelWarning(route).replace(/^⚠ /, "") }
      : { status: "ok", detail: `${route.ip} (${route.dev ?? "unknown"})` };
  });

  if (root !== undefined && stateResult) {
    const projectResult = await Promise.resolve()
      .then(() => p.project(root))
      .then(
        (info) => ({ info }),
        (error: unknown) => ({ error }),
      );
    await add("project", async () => {
      if ("error" in projectResult) {
        if (projectResult.error instanceof MissingBundleIdentifierError) {
          return { status: "info", detail: "kind and versions are shown once the bundle identifier is set (see project-config)" };
        }
        throw projectResult.error;
      }
      const { info } = projectResult;
      return info.warnings.length > 0
        ? { status: "warn", detail: [projectSummary(info), ...info.warnings].join("; ") }
        : { status: "ok", detail: projectSummary(info) };
    });
    await add("project-config", async () => {
      if ("info" in projectResult) return { status: "ok", detail: `bundle identifier ${projectResult.info.bundleIdentifier}` };
      const err = projectResult.error;
      return err instanceof MissingBundleIdentifierError
        ? { status: "warn", detail: missingBundleIdDetail(err) }
        : { status: "info", detail: "not checked: the project could not be read (see project)" };
    });
    await add("build-state", async () => {
      if ("error" in stateResult) {
        return { status: "warn", detail: `unreadable build state (${message(stateResult.error)}) — run rn-xtool build` };
      }
      const state = stateResult.state;
      return state
        ? { status: "ok", detail: `port ${state.metroPort}, ip ${state.lanIp}` }
        : { status: "warn", detail: "no build yet — run rn-xtool build" };
    });
    if ("state" in stateResult && stateResult.state) {
      const { metroPort, depsFingerprint, kind } = stateResult.state;
      const changed = kind === "bare" ? "native project or dependencies changed" : "dependencies changed";
      await add("deps", async () => {
        if (depsFingerprint === undefined) return { status: "warn", detail: NO_FINGERPRINT_WARNING };
        return depsFingerprint === (await p.depsFingerprint(root))
          ? { status: "ok", detail: "unchanged since last build" }
          : { status: "warn", detail: `${changed} since last build — run rn-xtool build && rn-xtool install` };
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
