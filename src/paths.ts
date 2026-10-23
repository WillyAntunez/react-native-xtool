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
    sources: join(iosXtool, "Sources", "App"),
    frameworks: join(iosXtool, "Frameworks"),
    jsiOut: join(iosXtool, "jsi-out"),
    appBundle: join(iosXtool, "xtool", "App.app"),
  };
}

export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg ? xdg : join(homedir(), ".cache"), "expo-xtool");
}
