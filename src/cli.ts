import { createRequire } from "node:module";
import { Command } from "commander";
import { build } from "./commands/build.js";
import { install } from "./commands/install.js";
import { setup } from "./commands/setup.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command()
    .name("expo-xtool")
    .description("Build Expo iOS dev builds on Linux via xtool")
    .version(pkg.version);
  program
    .command("setup")
    .description("Install Swift, xtool and the Darwin SDK")
    .option("--xcode-xip <path>", "path to Xcode.xip (needed to install the Darwin SDK)")
    .action(async (o: { xcodeXip?: string }) => {
      await setup({ xcodeXip: o.xcodeXip });
    });
  program
    .command("install")
    .description("Build, sign and install the app on a USB-connected iPhone")
    .action(async () => {
      await install(process.cwd());
    });
  program
    .command("build")
    .description("Prebuild if needed, run the SwiftPM pipeline and build with xtool")
    .option("--clean", "re-run expo prebuild --clean")
    .action(async (o: { clean?: boolean }) => {
      await build(process.cwd(), { clean: o.clean });
    });
  return program;
}
