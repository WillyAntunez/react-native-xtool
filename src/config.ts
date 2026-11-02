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
  /**
   * Refusals of `doctor --project` and `build` to let through, as warnings: a package name allows that library's,
   * "pnpm", "pnp" or "hoisted" that install-level refusal. The build may then fail later.
   */
  knownLimits?: { allow: string[] };
}

/** A config file whose content has the wrong shape; the message names the file and the key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Throws a ConfigError naming `file` when its `knownLimits` is not `{ allow: string[] }`. */
function checkKnownLimits(file: string, config: Partial<ExpoXtoolConfig> | undefined): void {
  if (config === null || typeof config !== "object" || !("knownLimits" in config)) return;
  const knownLimits: unknown = config.knownLimits;
  if (knownLimits === null || typeof knownLimits !== "object" || Array.isArray(knownLimits)) {
    throw new ConfigError(`${file}: knownLimits must be an object with an allow list`);
  }
  const allow: unknown = (knownLimits as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string" && entry !== "")) {
    throw new ConfigError(`${file}: knownLimits.allow must be a list of package names or "pnpm", "pnp", "hoisted"`);
  }
}

/** The config of a project without rn-xtool.config.json or rn-xtool.config.js. */
export const DEFAULT_CONFIG: Readonly<ExpoXtoolConfig> = { metroPort: 8081 };

export async function loadConfig(projectRoot: string): Promise<ExpoXtoolConfig> {
  let config: ExpoXtoolConfig = { ...DEFAULT_CONFIG };

  const jsonPath = join(projectRoot, "rn-xtool.config.json");
  if (existsSync(jsonPath)) {
    const raw = await readFile(jsonPath, "utf8");
    let parsed: Partial<ExpoXtoolConfig>;
    try {
      parsed = JSON.parse(raw) as Partial<ExpoXtoolConfig>;
    } catch (e) {
      // JSON.parse names no file, and a project has several JSON files.
      throw new Error(`rn-xtool.config.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    checkKnownLimits("rn-xtool.config.json", parsed);
    config = { ...config, ...parsed };
  }

  const jsPath = join(projectRoot, "rn-xtool.config.js");
  if (existsSync(jsPath)) {
    const mod = (await import(pathToFileURL(jsPath).href)) as { default?: Partial<ExpoXtoolConfig> };
    checkKnownLimits("rn-xtool.config.js", mod.default);
    config = { ...config, ...mod.default };
  }

  return config;
}
