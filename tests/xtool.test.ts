import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authStatus,
  devBuild,
  devBuildIpa,
  devEnv,
  devRun,
  type DevRunner,
  installedBundleId,
  listDevices,
  parseAuthStatus,
  parseDevices,
  parseIpaPath,
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
      "Logged in.\n- Apple ID: dev@example.com\n- Team ID: ABCDE12345\n- Token expiry: 23/10/2027, 9:48 AM\n";
    expect(parseAuthStatus(out)).toEqual({
      loggedIn: true,
      appleId: "dev@example.com",
      teamId: "ABCDE12345",
    });
  });
});

describe("parseDevices", () => {
  it("parses a device line", () => {
    expect(parseDevices("Test iPhone [usb]: 00008030-000000000000000E\n")).toEqual([
      { name: "Test iPhone", transport: "usb", udid: "00008030-000000000000000E" },
    ]);
  });
  it("ignores empty output", () => {
    expect(parseDevices("")).toEqual([]);
  });
});

describe("installedBundleId", () => {
  it("prefixes team id", () => {
    expect(installedBundleId("ABCDE12345", "com.a.b")).toBe("XTL-ABCDE12345.com.a.b");
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
  it("resolves [] when a grandchild keeps stdout open after the timeout (AppImage runtime)", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, "#!/bin/sh\nsleep 60 &\nwait\n");
    chmodSync(fake, 0o755);
    const t0 = Date.now();
    await expect(listDevices(fake, 200)).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("asks xtool not to wait for a device", async () => {
    const fake = join(tmp(), "fake-xtool");
    writeFileSync(fake, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args"\n');
    chmodSync(fake, 0o755);
    await listDevices(fake, 2000);
    expect(readFileSync(join(dirname(fake), "args"), "utf8").trim()).toBe("devices --no-wait");
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

describe("devBuild / devRun", () => {
  const SWIFT_HEADERS = "/app/ios-xtool/.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos";
  const record = () => {
    const calls: { args: string[]; opts: Parameters<DevRunner>[2] }[] = [];
    const runner: DevRunner = async (_cmd, args, opts) => {
      calls.push({ args, opts });
    };
    return { calls, runner };
  };

  it("devBuild passes RN_SPM_SWIFT_HEADERS_DIR to xtool dev build", async () => {
    const { calls, runner } = record();
    await devBuild("/bin/xtool", "/app/ios-xtool", runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["dev", "build"]);
    expect(calls[0]!.opts?.cwd).toBe("/app/ios-xtool");
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(SWIFT_HEADERS);
  });

  it("devRun passes RN_SPM_SWIFT_HEADERS_DIR to xtool dev run", async () => {
    const { calls, runner } = record();
    await devRun("/bin/xtool", "/app/ios-xtool", runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["dev", "run"]);
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toBe(SWIFT_HEADERS);
  });
});

describe("parseIpaPath", () => {
  it("takes the path from xtool's last `Wrote to` line, relative to the project dir", () => {
    expect(parseIpaPath("Building…\nWrote to xtool/App.ipa\n", "/app/ios-xtool")).toBe("/app/ios-xtool/xtool/App.ipa");
    expect(parseIpaPath("Wrote to /abs/App.ipa  \n", "/x")).toBe("/abs/App.ipa");
  });
  it("is undefined without that line", () => {
    expect(parseIpaPath("Build complete", "/x")).toBeUndefined();
  });
});

describe("devBuildIpa", () => {
  it("builds, signs and packages an ipa with the Swift headers env and returns its path", async () => {
    const calls: { args: string[]; opts: Parameters<DevRunner>[2] }[] = [];
    const path = await devBuildIpa("/bin/xtool", "/app/ios-xtool", async (_cmd, args, opts) => {
      calls.push({ args, opts });
      return "Wrote to xtool/App.ipa";
    });
    expect(path).toBe("/app/ios-xtool/xtool/App.ipa");
    expect(calls[0]!.args).toEqual(["dev", "build", "--configuration", "debug", "--sign", "--ipa"]);
    expect(calls[0]!.opts?.cwd).toBe("/app/ios-xtool");
    expect(calls[0]!.opts?.env?.["RN_SPM_SWIFT_HEADERS_DIR"]).toContain("GeneratedModuleMaps-iphoneos");
  });
  it("fails clearly when xtool does not say where the ipa is", async () => {
    await expect(devBuildIpa("/bin/xtool", "/app", async () => "done")).rejects.toThrow("did not report the .ipa path");
  });
});
