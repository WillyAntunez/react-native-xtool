import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ExpoXtoolConfig {
  xcodeXipPath?: string;
  metroPort: number;
  lanIp?: string;
  rnArtifactsDir?: string;
  xtoolPath?: string;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function loadConfig(projectRoot: string): Promise<ExpoXtoolConfig> {
  let config: ExpoXtoolConfig = { metroPort: 8081 };

  try {
    const raw = await readFile(join(projectRoot, "expo-xtool.config.json"), "utf8");
    config = { ...config, ...(JSON.parse(raw) as Partial<ExpoXtoolConfig>) };
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  const jsPath = join(projectRoot, "expo-xtool.config.js");
  try {
    const mod = (await import(pathToFileURL(jsPath).href)) as { default?: Partial<ExpoXtoolConfig> };
    config = { ...config, ...mod.default };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && !isMissing(err)) throw err;
  }

  return config;
}
