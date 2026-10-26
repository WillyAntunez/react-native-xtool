import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ProjectPaths {
  root: string;
  ios: string;
  iosBuild: string;
  xcframeworks: string;
  autolinking: string;
  expoDir: string;
  generatedIos: string;
  iosXtool: string;
  /** Per-run staging dir of bundled patches selected for the installed packages. */
  patchesDir: string;
  sources: string;
  frameworks: string;
  jsiOut: string;
  appBundle: string;
}

export function projectPaths(root: string): ProjectPaths {
  const r = resolve(root);
  const ios = join(r, "ios");
  const iosBuild = join(ios, "build");
  const autolinking = join(iosBuild, "generated", "autolinking");
  const iosXtool = join(r, "ios-xtool");
  return {
    root: r,
    ios,
    iosBuild,
    xcframeworks: join(iosBuild, "xcframeworks"),
    autolinking,
    expoDir: join(autolinking, "expo"),
    generatedIos: join(iosBuild, "generated", "ios"),
    iosXtool,
    patchesDir: join(iosXtool, ".patches"),
    sources: join(iosXtool, "Sources", "App"),
    frameworks: join(iosXtool, "Frameworks"),
    jsiOut: join(iosXtool, "jsi-out"),
    appBundle: join(iosXtool, "xtool", "App.app"),
  };
}

/**
 * Where Swift Build writes every Swift module's generated `<Module>-Swift.h` (with its module map)
 * for the app build: one flat directory per platform under xtool's scratch path (`ios-xtool/.build`).
 * Per-target copies also exist under `<Target>.build/.../Objects-normal/arm64/`, but this one is
 * shared by all modules, so a single `-I` covers any of them.
 */
export function swiftHeadersDir(iosXtool: string): string {
  return join(iosXtool, ".build", "out", "Intermediates.noindex", "GeneratedModuleMaps-iphoneos");
}

/** Read by the RN scaffolder's mixed Swift + Objective-C manifests (patches/react-native+0.88.0.patch). */
export const SWIFT_HEADERS_DIR_ENV = "RN_SPM_SWIFT_HEADERS_DIR";

/** Env that lets scaffolded mixed-language manifests find `<Module>-Swift.h`; needed wherever SwiftPM evaluates them. */
export function swiftHeadersEnv(iosXtool: string): Record<string, string> {
  return { [SWIFT_HEADERS_DIR_ENV]: swiftHeadersDir(iosXtool) };
}

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg ? xdg : join(homedir(), ".cache"), "rn-xtool");
}
