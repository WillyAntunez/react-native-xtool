import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readBareProject } from "../src/project/bare.js";
import { readScriptsShape, scriptsCapability, SCRIPTS_REQUIREMENTS } from "../src/project/scriptsShape.js";
import { vendoredScriptsRoot } from "../src/pipeline/rnSpm.js";
import { bareLineFor } from "../src/versions.js";
import { fakeRnScripts, RN_SCRIPTS_FIXTURES, shapeForVersion } from "./support/rnScripts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "rn-xtool-scripts-"));
  tempDirs.push(dir);
  return dir;
}

/** A react-native dir whose scripts have the fixture's shape. */
async function rnDirWith(shape: "none" | "0.87" | "0.88"): Promise<string> {
  const rnDir = path.join(await tempDir(), "node_modules", "react-native");
  await mkdir(rnDir, { recursive: true });
  await fakeRnScripts(rnDir, shape);
  return rnDir;
}

async function dropExport(scriptsRoot: string, file: string, name: string): Promise<void> {
  const p = path.join(scriptsRoot, file);
  const text = await readFile(p, "utf8");
  const without = text.replace(new RegExp(`^\\s*${name},\\n`, "m"), "");
  expect(without, `${file} lists ${name}`).not.toBe(text);
  await writeFile(p, without);
}

const MISSING_087 = [
  "setup-apple-spm.js export resolveAppIosDeploymentTarget",
  "spm/scaffold-package-swift.js export refreshScaffoldedPlatformFloors",
  "spm/sync-spm-autolinking.js option --ios-deployment-target",
];

describe("readScriptsShape", () => {
  it("lists the seven files the vendored driver and downloader call", () => {
    expect(SCRIPTS_REQUIREMENTS.map((r) => r.file)).toEqual([
      "setup-apple-spm.js",
      "spm/generate-spm-autolinking-config.js",
      "spm/scaffold-package-swift.js",
      "spm/sync-spm-autolinking.js",
      "spm/generate-spm-package.js",
      "spm/flavored-frameworks.js",
      "spm/download-spm-artifacts.js",
    ]);
  });

  it("the vendored copy has the 0.88 shape", () => {
    expect(readScriptsShape(vendoredScriptsRoot())).toEqual({ shape: "0.88", missing: [] });
  });

  it("pins each known shape", async () => {
    expect(readScriptsShape(path.join(await rnDirWith("none"), "scripts"))).toEqual({ shape: "none", missing: [] });
    expect(readScriptsShape(path.join(RN_SCRIPTS_FIXTURES, "0.87"))).toEqual({ shape: "0.87", missing: MISSING_087 });
    expect(readScriptsShape(path.join(RN_SCRIPTS_FIXTURES, "0.88"))).toEqual({ shape: "0.88", missing: [] });
  });

  it("anything else is unknown", async () => {
    const noPackage = path.join(await rnDirWith("0.88"), "scripts");
    await rm(path.join(noPackage, "spm", "generate-spm-package.js"));
    expect(readScriptsShape(noPackage)).toEqual({ shape: "unknown", missing: ["spm/generate-spm-package.js file"] });

    const old087 = path.join(await rnDirWith("0.87"), "scripts");
    await dropExport(old087, "setup-apple-spm.js", "determineVersion");
    expect(readScriptsShape(old087)).toEqual({
      shape: "unknown",
      missing: ["setup-apple-spm.js export determineVersion", ...MISSING_087],
    });

    const spmOnly = path.join(await rnDirWith("0.88"), "scripts");
    await rm(path.join(spmOnly, "setup-apple-spm.js"));
    expect(readScriptsShape(spmOnly)).toEqual({ shape: "unknown", missing: ["setup-apple-spm.js file"] });
  });

  it("reads exports from the last module.exports block only, as names or keys", async () => {
    const scripts = path.join(await rnDirWith("0.88"), "scripts");
    const file = path.join(scripts, "spm", "flavored-frameworks.js");
    // An earlier block does not count; a `key: value` entry and a comment inside the block do.
    await writeFile(
      file,
      "module.exports = {finalizeArtifactPublication};\n" +
        "module.exports = {\n  // finalizeArtifactPublication,\n  other,\n};\n",
    );
    expect(readScriptsShape(scripts)).toEqual({
      shape: "unknown",
      missing: ["spm/flavored-frameworks.js export finalizeArtifactPublication"],
    });
    await writeFile(file, "module.exports = {\n  other,\n  // Published by the driver.\n  finalizeArtifactPublication: finalize,\n};\n");
    expect(readScriptsShape(scripts)).toEqual({ shape: "0.88", missing: [] });
  });

  it("reads options in either quote style", async () => {
    const scripts = path.join(await rnDirWith("0.88"), "scripts");
    const file = path.join(scripts, "spm", "sync-spm-autolinking.js");
    await writeFile(file, '    .option("ios-deployment-target", {\nmodule.exports = {main};\n');
    expect(readScriptsShape(scripts)).toEqual({ shape: "0.88", missing: [] });
  });

  it("tells an unreadable file from a missing one", async () => {
    const scripts = path.join(await rnDirWith("0.88"), "scripts");
    const file = path.join(scripts, "spm", "flavored-frameworks.js");
    await rm(file);
    await mkdir(file);
    expect(readScriptsShape(scripts)).toEqual({ shape: "unknown", missing: ["spm/flavored-frameworks.js unreadable"] });
  });

  it("never runs the installed scripts", async () => {
    const scripts = path.join(await rnDirWith("0.88"), "scripts");
    const setup = path.join(scripts, "setup-apple-spm.js");
    await writeFile(setup, `throw new Error("executed");\n${await readFile(setup, "utf8")}`);
    expect(readScriptsShape(scripts)).toEqual({ shape: "0.88", missing: [] });
  });
});

describe("scriptsCapability", () => {
  it("matches today's table for every supported version", async () => {
    for (const v of ["0.86.2", "0.86.3", "0.86.4", "0.87.1", "0.87.2", "0.88.0", "0.88.1", "0.88.2"]) {
      const rnDir = await rnDirWith(shapeForVersion(v));
      const cap = scriptsCapability(rnDir, v);
      expect(cap.mode, v).toBe(bareLineFor(v)!.scripts);
      expect(cap.recognised, v).toBe(true);
      expect(cap.missing, v).toEqual(shapeForVersion(v) === "0.87" ? MISSING_087 : []);
    }
  });

  it("falls back to the version table for an unknown shape", async () => {
    const rnDir = await rnDirWith("0.88");
    await dropExport(path.join(rnDir, "scripts"), "spm/flavored-frameworks.js", "finalizeArtifactPublication");
    const missing = ["spm/flavored-frameworks.js export finalizeArtifactPublication"];
    expect(scriptsCapability(rnDir, "0.88.1")).toEqual({ shape: "unknown", missing, recognised: false, mode: "installed" });
    expect(scriptsCapability(rnDir, "0.85.0")).toEqual({ shape: "unknown", missing, recognised: false, mode: undefined });
  });

  it("a complete shape without a bundled patch of its line is unknown", async () => {
    expect(scriptsCapability(await rnDirWith("0.88"), "0.87.2")).toEqual({
      shape: "0.88",
      missing: ["no bundled react-native patch for 0.87"],
      recognised: false,
      mode: "vendored",
    });
    const noPatches = await tempDir();
    await writeFile(path.join(noPatches, "expo+58.0.21.patch"), "");
    expect(scriptsCapability(await rnDirWith("0.88"), "0.88.1", noPatches)).toEqual({
      shape: "0.88",
      missing: ["no bundled react-native patch for 0.88"],
      recognised: false,
      mode: "installed",
    });
  });

  it("an older shape on a line with a bundled patch is not recognised", async () => {
    // The bundled react-native patch edits the installed 0.88-shaped scripts: none or 0.87 there is a damaged install.
    const expected = ["react-native 0.88's own SwiftPM scripts, which rn-xtool's 0.88 patch expects"];
    expect(scriptsCapability(await rnDirWith("none"), "0.88.1")).toEqual({
      shape: "none",
      missing: expected,
      recognised: false,
      mode: "installed",
    });
    expect(scriptsCapability(await rnDirWith("0.87"), "0.88.1")).toEqual({
      shape: "0.87",
      missing: expected,
      recognised: false,
      mode: "installed",
    });
    // Without a bundled patch of the line, the same shapes pick the vendored scripts.
    const noRnPatch = await tempDir();
    expect(scriptsCapability(await rnDirWith("none"), "0.88.1", noRnPatch)).toEqual({
      shape: "none",
      missing: [],
      recognised: true,
      mode: "vendored",
    });
    // A bundled patch of 0.87 would make the 0.87 shape unrecognised on that line too.
    const rn087Patch = await tempDir();
    await writeFile(path.join(rn087Patch, "react-native+0.87.1.patch"), "");
    expect(scriptsCapability(await rnDirWith("0.87"), "0.87.2", rn087Patch)).toEqual({
      shape: "0.87",
      missing: ["react-native 0.87's own SwiftPM scripts, which rn-xtool's 0.87 patch expects"],
      recognised: false,
      mode: "vendored",
    });
  });

  it("finds the bundled patch of the line in the given dir", async () => {
    const patches = await tempDir();
    await writeFile(path.join(patches, "react-native+0.89.0.patch"), "");
    expect(scriptsCapability(await rnDirWith("0.88"), "0.89.3", patches)).toEqual({
      shape: "0.88",
      missing: [],
      recognised: true,
      mode: "installed",
    });
  });
});

describe("readBareProject scripts mode", () => {
  /** A bare template whose react-native (0.88.1, 0.88 scripts) lives at `rnDir`, outside `node_modules` of the root. */
  async function bareWithRnAt(root: string, rnDir: string): Promise<void> {
    await cp(path.join(fixtures, "bare"), root, { recursive: true });
    await mkdir(rnDir, { recursive: true });
    await writeFile(path.join(rnDir, "package.json"), JSON.stringify({ name: "react-native", version: "0.88.1" }));
    await fakeRnScripts(rnDir, "0.88");
  }

  it("reads the scripts of the react-native the build resolves", async () => {
    // Linked: node_modules/react-native is a symlink to a dir outside the project.
    const linked = path.join(await tempDir(), "app");
    const outside = path.join(await tempDir(), "react-native");
    await bareWithRnAt(linked, outside);
    await mkdir(path.join(linked, "node_modules"), { recursive: true });
    await symlink(outside, path.join(linked, "node_modules", "react-native"), "dir");
    expect((await readBareProject(linked)).rnScripts).toBe("installed");

    // Hoisted: react-native is installed in a parent's node_modules (a workspace), none under the app.
    const workspace = await tempDir();
    const app = path.join(workspace, "packages", "app");
    await bareWithRnAt(app, path.join(workspace, "node_modules", "react-native"));
    expect(existsSync(path.join(app, "node_modules", "react-native"))).toBe(false);
    expect((await readBareProject(app)).rnScripts).toBe("installed");
  });

  it("takes the line's row when the shape is not recognised", async () => {
    const root = await tempDir();
    const rnDir = path.join(root, "node_modules", "react-native");
    await bareWithRnAt(root, rnDir);
    // 0.88.1 with no scripts or the 0.87 shape (a damaged install): the 0.88 line's row, not the vendored scripts.
    for (const shape of ["none", "0.87"] as const) {
      await fakeRnScripts(rnDir, shape);
      expect((await readBareProject(root)).rnScripts, shape).toBe("installed");
    }
    // Unknown: the 0.88 line's row.
    await fakeRnScripts(rnDir, "0.88");
    await rm(path.join(rnDir, "scripts", "spm", "generate-spm-package.js"));
    expect((await readBareProject(root)).rnScripts).toBe("installed");
  });
});

const repoRoot = path.resolve(here, "..");
const referenceApps = ["app-bare-086", "app-bare-087", "app-bare"].map((a) => path.resolve(repoRoot, "..", a));

describe.skipIf(!referenceApps.every((a) => existsSync(path.join(a, "node_modules", "react-native", "scripts"))))(
  "the reference apps",
  () => {
    it("detects the installed shapes of the reference apps", () => {
      const shapes = referenceApps.map((a) => readScriptsShape(path.join(a, "node_modules", "react-native", "scripts")));
      expect(shapes).toEqual([
        { shape: "none", missing: [] },
        { shape: "0.87", missing: MISSING_087 },
        { shape: "0.88", missing: [] },
      ]);
    });
  },
);
