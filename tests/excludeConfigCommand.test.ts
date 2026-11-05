import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";

const ROOT = packageRoot();
const FILTER = path.join(ROOT, "scripts", "exclude-config-command.js");

/** The autolinking config command's JSON, in the CLI's shape. */
const CONFIG = {
  root: "/proj",
  dependencies: {
    "react-native-vision-camera": {
      root: "/proj/node_modules/react-native-vision-camera",
      name: "react-native-vision-camera",
      platforms: { ios: { podspecPath: "/proj/node_modules/react-native-vision-camera/VisionCamera.podspec" }, android: { sourceDir: "android" } },
    },
    "@react-native-community/netinfo": {
      root: "/proj/node_modules/@react-native-community/netinfo",
      name: "@react-native-community/netinfo",
      platforms: { ios: { podspecPath: "/proj/node_modules/@react-native-community/netinfo/react-native-netinfo.podspec" } },
    },
    "react-native-device-info": {
      root: "/proj/node_modules/react-native-device-info",
      name: "react-native-device-info",
      platforms: { ios: { podspecPath: "/proj/node_modules/react-native-device-info/RNDeviceInfo.podspec" } },
    },
  },
  project: { ios: { sourceDir: "/proj/ios" } },
};

/** Runs the filter around `node -e <script>`. */
function filter(exclude: unknown, script: string) {
  const r = spawnSync(process.execPath, [FILTER, "--exclude", JSON.stringify(exclude), "--", process.execPath, "-e", script], {
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const printing = (json: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(json))})`;

describe("exclude-config-command.js", () => {
  it("sets platforms.ios to null for each excluded package", () => {
    const r = filter(["react-native-vision-camera", "@react-native-community/netinfo"], printing(CONFIG));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as typeof CONFIG;
    expect(out.dependencies["react-native-vision-camera"].platforms).toEqual({ ios: null, android: { sourceDir: "android" } });
    expect(out.dependencies["@react-native-community/netinfo"].platforms).toEqual({ ios: null });
  });

  it("leaves other packages and unknown names alone", () => {
    const r = filter(["react-native-not-installed", "react-native-vision-camera"], printing(CONFIG));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown> & typeof CONFIG;
    expect(out.dependencies["react-native-device-info"]).toEqual(CONFIG.dependencies["react-native-device-info"]);
    expect(out.dependencies["@react-native-community/netinfo"]).toEqual(CONFIG.dependencies["@react-native-community/netinfo"]);
    expect(Object.keys(out.dependencies)).toEqual(Object.keys(CONFIG.dependencies));
    expect({ ...out, dependencies: {} }).toEqual({ ...CONFIG, dependencies: {} });
    // A package without platforms gets them with ios: null.
    const bare = filter(["lib"], printing({ ...CONFIG, dependencies: { lib: { root: "/proj/node_modules/lib" } } }));
    expect((JSON.parse(bare.stdout) as typeof CONFIG).dependencies).toEqual({ lib: { root: "/proj/node_modules/lib", platforms: { ios: null } } });
  });

  it("passes the inner command's failure through", () => {
    const r = filter(["react-native-vision-camera"], 'process.stderr.write("config failed: no react-native.config.js"); process.exit(3)');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("config failed: no react-native.config.js");
    expect(r.stdout).toBe("");
  });

  it("names the command when its output is not JSON", () => {
    const r = filter(["lib"], 'process.stdout.write("not json")');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^exclude-config-command: .* printed no JSON object: /);
  });

  it("refuses a malformed --exclude", () => {
    const r = spawnSync(process.execPath, [FILTER, "--exclude", "lib", "--", process.execPath, "-e", ""], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: node scripts/exclude-config-command.js --exclude '<json array>' -- <cmd> [args...]");
  });

  it("package.json ships the filter", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("scripts/exclude-config-command.js");
  });
});
