import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ExpoXtoolConfig {
  xcodeXipPath?: string;
  metroPort: number;
  lanIp?: string;
  rnArtifactsDir?: string;
  xtoolPath?: string;
  projectKind?: "expo" | "bare";
}

/** The config of a project without rn-xtool.config.json or rn-xtool.config.js. */
export const DEFAULT_CONFIG: Readonly<ExpoXtoolConfig> = { metroPort: 8081 };

export async function loadConfig(projectRoot: string): Promise<ExpoXtoolConfig> {
  let config: ExpoXtoolConfig = { ...DEFAULT_CONFIG };

  const jsonPath = join(projectRoot, "rn-xtool.config.json");
  if (existsSync(jsonPath)) {
    const raw = await readFile(jsonPath, "utf8");
    config = { ...config, ...(JSON.parse(raw) as Partial<ExpoXtoolConfig>) };
  }

  const jsPath = join(projectRoot, "rn-xtool.config.js");
  if (existsSync(jsPath)) {
    const mod = (await import(pathToFileURL(jsPath).href)) as { default?: Partial<ExpoXtoolConfig> };
    config = { ...config, ...mod.default };
  }

  return config;
}
