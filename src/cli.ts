import { createRequire } from "node:module";
import { Command } from "commander";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildProgram(): Command {
  return new Command()
    .name("expo-xtool")
    .description("Build Expo iOS dev builds on Linux via xtool")
    .version(pkg.version);
}
