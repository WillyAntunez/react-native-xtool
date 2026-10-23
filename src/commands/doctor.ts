import { execa } from "execa";
import { loadConfig, type ExpoXtoolConfig } from "../config.js";
import { isPortFree } from "../net.js";
import { projectPaths } from "../paths.js";
import { readExpoProject } from "../project.js";
import { readState } from "../state.js";
import { toolEnv } from "../tools/exec.js";
import { authStatus, listDevices, xtoolBin, type AuthStatus, type Device } from "../tools/xtool.js";
import { XTOOL_VERSION, SWIFT_VERSION } from "../versions.js";
import { isExecutable, sdkBundle, swiftMeetsMin, swiftVersionText, xtoolPath } from "./setup.js";
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

const SYMBOL = { ok: "✔", fail: "✖", warn: "⚠" } as const;

export function renderReport(checks: DoctorCheck[]): string {
  return checks.map((c) => `${SYMBOL[c.status]} ${c.name} — ${c.detail}`).join("\n");
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function realProbes(config: ExpoXtoolConfig): DoctorProbes {
  const bin = (): string => xtoolBin(config);
  return {
    nodeVersion: () => process.versions.node,
    swiftVersion: swiftVersionText,
    xtoolInstalled: () => isExecutable(config.xtoolPath ?? xtoolPath()),
    xtoolVersion: async () => {
      const r = await execa(bin(), ["--version"], { env: toolEnv(), extendEnv: false, reject: false });
      return `${r.stdout}\n${r.stderr}`.trim();
    },
    sdkInstalled: () => existsSync(sdkBundle()),
    authStatus: () => authStatus(bin()),
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
      : { status: "fail", detail: "logged out — run xtool auth login" };
  });
  await add("device", async () => {
    if (!p.xtoolInstalled()) return { status: "warn", detail: "xtool not installed" };
    const [d] = await p.devices();
    return d
      ? { status: "ok", detail: `${d.name} (${d.transport})` }
      : { status: "warn", detail: "no USB device found — connect and unlock your iPhone" };
  });
  await add("firewall", async () =>
    (await p.ufwActive())
      ? { status: "warn", detail: "ufw is active: allow the Metro port, e.g. sudo ufw allow <port>/tcp" }
      : { status: "ok", detail: "ufw not active" },
  );

  if (root !== undefined) {
    await add("expo-sdk", async () => {
      await p.expoProject(root);
      return { status: "ok", detail: "supported Expo project" };
    });
    const state = await p.buildState(root).catch((e: unknown) => e as Error);
    if (state instanceof Error) {
      checks.push({ name: "build-state", status: "fail", detail: state.message });
    } else if (!state) {
      checks.push({ name: "build-state", status: "warn", detail: "no build yet — run expo-xtool build" });
    } else {
      checks.push({ name: "build-state", status: "ok", detail: `port ${state.metroPort}, ip ${state.lanIp}` });
      await add("metro-port", async () =>
        (await p.portFree(state.metroPort))
          ? { status: "ok", detail: `port ${state.metroPort} is free` }
          : { status: "warn", detail: `port ${state.metroPort} is busy` },
      );
    }
  }

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

export async function doctor(root?: string, probes?: DoctorProbes): Promise<DoctorReport> {
  const config = await loadConfig(root ?? process.cwd());
  return doctorWithProbes(probes ?? realProbes(config), root);
}
