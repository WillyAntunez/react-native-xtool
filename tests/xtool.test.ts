import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authStatus,
  devEnv,
  installedBundleId,
  listDevices,
  parseAuthStatus,
  parseDevices,
  xtoolBin,
} from "../src/tools/xtool.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "xtool-test-"));
  dirs.push(d);
  return d;
};

describe("parseAuthStatus", () => {
  it("parses logged out", () => {
    expect(parseAuthStatus("Logged out")).toEqual({ loggedIn: false });
  });
  it("parses logged in", () => {
    const out =
      "Logged in.\n- Apple ID: someone@example.com\n- Team ID: G7T6C5W9ZU\n- Token expiry: 23/10/2027, 9:48 AM\n";
    expect(parseAuthStatus(out)).toEqual({
      loggedIn: true,
      appleId: "someone@example.com",
      teamId: "G7T6C5W9ZU",
    });
  });
});

describe("parseDevices", () => {
  it("parses a device line", () => {
    expect(parseDevices("iPhone de Willy [usb]: 00008030-001645A61EBB802E\n")).toEqual([
      { name: "iPhone de Willy", transport: "usb", udid: "00008030-001645A61EBB802E" },
    ]);
  });
  it("ignores empty output", () => {
    expect(parseDevices("")).toEqual([]);
  });
});

describe("installedBundleId", () => {
  it("prefixes team id", () => {
    expect(installedBundleId("G7T6C5W9ZU", "com.a.b")).toBe("XTL-G7T6C5W9ZU.com.a.b");
  });
});

describe("listDevices", () => {
  it("resolves [] when the binary hangs past the timeout", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    await expect(listDevices(fake, 200)).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("xtoolBin", () => {
  it("returns an explicit executable xtoolPath", () => {
    const f = join(tmp(), "x");
    writeFileSync(f, "#!/bin/sh\n");
    chmodSync(f, 0o755);
    expect(xtoolBin({ xtoolPath: f })).toBe(f);
  });
  it("throws pointing to setup when missing", () => {
    expect(() => xtoolBin({ xtoolPath: "/nonexistent/xtool" })).toThrow(
      "xtool not found at /nonexistent/xtool. Run `expo-xtool setup` first.",
    );
  });
});

describe("authStatus", () => {
  const script = (body: string): string => {
    const f = join(tmp(), "fake-xtool");
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  it("treats 'Logged out' on stderr with a non-zero exit as logged out", async () => {
    await expect(authStatus(script("echo 'Logged out' >&2\nexit 1"))).resolves.toEqual({ loggedIn: false });
  });
  it("reports an unrunnable binary with the libfuse2 hint instead of logged out", async () => {
    const bin = script("echo 'fuse: failed to open /dev/fuse' >&2\nexit 1");
    await expect(authStatus(bin)).rejects.toThrow(/xtool could not run \(exit 1\): fuse: failed to open.*libfuse2/s);
  });
  it("throws when the binary cannot be spawned", async () => {
    await expect(authStatus("/nonexistent/xtool")).rejects.toBeDefined();
  });
});

describe("devEnv", () => {
  it("exposes the generated Swift headers dir to the manifests xtool evaluates", () => {
    const env = devEnv("/app/ios-xtool");
    expect(env["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(
      "/app/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos",
    );
    expect(env.PATH).toContain(".local/share/swiftly/bin");
    expect(env.SDKROOT).toBeUndefined();
  });
});
