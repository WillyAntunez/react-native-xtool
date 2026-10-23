import { execa } from "execa";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readExpoProject } from "../project.js";
import { readState } from "../state.js";
import { toolEnv } from "../tools/exec.js";
import { authStatus, listDevices, defaultXtoolPath, xtoolBin, xtoolUnrunnableError, type AuthStatus, type Device } from "../tools/xtool.js";
import { XTOOL_VERSION, SWIFT_VERSION } from "../versions.js";
import { isExecutable, sdkBundle, swiftMeetsMin, swiftVersionText } from "./setup.js";
import { existsSync } from "node:fs";

export interface DoctorCheck {
  name: string;
  status: "ok" | "fail" | "warn";
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
  sdkInstalled: () => boolean;
  authStatus: () => Promise<AuthStatus>;
  devices: () => Promise<Device[]>;
  ufwActive: () => Promise<boolean>;
  /** Resolves when the project is a supported Expo project; rejects with the reason otherwise. */
  expoProject: (root: string) => Promise<unknown>;
  buildState: (root: string) => Promise<{ metroPort: number; lanIp: string } | undefined>;
  portFree: (port: number) => Promise<boolean>;
}

const PROBE_TIMEOUT_MS = 15_000;

const SYMBOL = { ok: "✔", fail: "✖", warn: "⚠" } as const;

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
    expoProject: (root) => readExpoProject(root),
    buildState: (root) => readState(projectPaths(root).iosXtool),
    portFree: (port) => isPortFree(port),
  };
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
  await add("xtool", async () => {
    if (!p.xtoolInstalled()) return { status: "fail", detail: "not found — run expo-xtool setup" };
    const v = await p.xtoolVersion();
    return v.includes(XTOOL_VERSION)
      ? { status: "ok", detail: XTOOL_VERSION }
      : { status: "warn", detail: `expected ${XTOOL_VERSION}, got ${v || "unknown"}` };
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

  if (root !== undefined && stateResult) {
    await add("expo-sdk", async () => {
      await p.expoProject(root);
      return { status: "ok", detail: "supported Expo project" };
    });
    await add("build-state", async () => {
      if ("error" in stateResult) throw stateResult.error;
      const state = stateResult.state;
      return state
        ? { status: "ok", detail: `port ${state.metroPort}, ip ${state.lanIp}` }
        : { status: "warn", detail: "no build yet — run expo-xtool build" };
    });
    if ("state" in stateResult && stateResult.state) {
      const { metroPort } = stateResult.state;
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
