import type { Duplex } from "node:stream";
import { PlistChannel, type PlistDict } from "./plistio.js";

export const INSTALL_PROXY_SERVICE = "com.apple.mobile.installation_proxy";

export class InstallProxyError extends Error {
  constructor(
    readonly code: string,
    readonly description?: string,
  ) {
    super(installErrorMessage(code, description));
    this.name = "InstallProxyError";
  }
}

const HINTS: Record<string, string> = {
  ApplicationVerificationFailed:
    "The iPhone rejected the app's signature: it is invalid or expired (free Apple ID signatures last 7 days), or the provisioning profile does not include this iPhone. Re-run `expo-xtool install --network` to re-sign.",
  DeviceOSVersionTooLow:
    "The app needs a newer iOS than this iPhone runs: update the iPhone or lower the deployment target.",
  InstallProhibited:
    "The iPhone does not allow installing apps: check Screen Time → Content & Privacy Restrictions → iTunes & App Store Purchases → Installing Apps, or a device-management profile.",
};
// Some tools spell it out; installd itself sends InstallProhibited.
HINTS.InstallationProhibited = HINTS.InstallProhibited!;

/** Readable installd error that still carries installd's own code and description verbatim. */
export function installErrorMessage(code: string, description?: string): string {
  const detail = description ? `${code}: ${description}` : code;
  const hint = HINTS[code];
  return hint ? `${hint}\n  installd: ${detail}` : `installd failed to install the app (${detail})`;
}

export type InstallEvent =
  | { kind: "progress"; percent?: number; status?: string }
  | { kind: "done" }
  | { kind: "error"; error: InstallProxyError };

/** One installd reply during Install: an error, the final `Complete`, or a progress step. */
export function interpretInstallMessage(msg: PlistDict): InstallEvent {
  if (msg.Error !== undefined) {
    const description = typeof msg.ErrorDescription === "string" ? msg.ErrorDescription : undefined;
    return { kind: "error", error: new InstallProxyError(String(msg.Error), description) };
  }
  if (msg.Status === "Complete") return { kind: "done" };
  const event: InstallEvent = { kind: "progress" };
  if (typeof msg.PercentComplete === "number") event.percent = msg.PercentComplete;
  if (typeof msg.Status === "string") event.status = msg.Status;
  return event;
}

export type InstallProgress = (percent: number | undefined, status: string | undefined) => void;

export const LOOKUP_ATTRIBUTES = ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "SignerIdentity"];

export class InstallProxyClient {
  private readonly ch: PlistChannel;

  constructor(
    stream: Duplex,
    private readonly opts: { deadlineMs?: number; timeoutMs?: number } = {},
  ) {
    this.ch = new PlistChannel(stream, "installation_proxy");
  }

  /**
   * Installs a package already staged over AFC. installd can go quiet for a while (signature
   * checks, unzipping), so there is one deadline for the whole install (default 10 min) rather
   * than a short per-message timeout.
   */
  async install(packagePath: string, onProgress?: InstallProgress, clientOptions: PlistDict = {}): Promise<void> {
    const deadline = Date.now() + (this.opts.deadlineMs ?? 600_000);
    await this.ch.send({ Command: "Install", PackagePath: packagePath, ClientOptions: clientOptions });
    for (;;) {
      const event = interpretInstallMessage(await this.ch.recv(Math.max(1, deadline - Date.now())));
      if (event.kind === "error") throw event.error;
      if (event.kind === "done") return;
      onProgress?.(event.percent, event.status);
    }
  }

  /** Installed apps by bundle id (only those found). */
  async lookup(bundleIds: string[], attributes = LOOKUP_ATTRIBUTES): Promise<Record<string, PlistDict>> {
    const resp = await this.ch.request(
      { Command: "Lookup", ClientOptions: { BundleIDs: bundleIds, ReturnAttributes: attributes } },
      this.opts.timeoutMs ?? 30_000,
    );
    if (resp.Error !== undefined) throw new InstallProxyError(String(resp.Error), resp.ErrorDescription as string | undefined);
    const result = resp.LookupResult;
    return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, PlistDict>) : {};
  }

  close(): void {
    this.ch.close();
  }
}
