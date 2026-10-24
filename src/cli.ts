import { createRequire } from "node:module";
import path from "node:path";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { build } from "./commands/build.js";
import { doctor, renderReport } from "./commands/doctor.js";
import { install } from "./commands/install.js";
import { run } from "./commands/run.js";
import { setup } from "./commands/setup.js";
import { start } from "./commands/start.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  };
}

export function buildProgram(): Command {
  const program = new Command()
    .name("expo-xtool")
    .description("Build Expo iOS dev builds on Linux via xtool")
    .version(pkg.version);
  program
    .command("setup")
    .description("Install Swift, xtool and the Darwin SDK")
    .option("--xcode-xip <path>", "path to Xcode.xip (needed to install the Darwin SDK)")
    .action(
      action(async (o: { xcodeXip?: string }) => {
        const config = await loadConfig(process.cwd());
        await setup({ xcodeXip: o.xcodeXip ?? config.xcodeXipPath, xtoolPath: config.xtoolPath });
      }),
    );
  program
    .command("install")
    .description("Build, sign and install the app on a USB-connected iPhone")
    .action(
      action(async () => {
        await install(process.cwd());
      }),
    );
  program
    .command("build")
    .description("Prebuild if needed, run the SwiftPM pipeline and build with xtool")
    .option("--clean", "re-run expo prebuild --clean")
    .action(
      action(async (o: { clean?: boolean }) => {
        await build(process.cwd(), { clean: o.clean });
      }),
    );
  program
    .command("start")
    .description("Start Metro on the port and LAN IP the app was built for")
    .option("--clear", "start Metro with --clear (reset its cache)")
    .action(
      action(async (o: { clear?: boolean }) => {
        await start(process.cwd(), { clear: o.clear });
      }),
    );
  program
    .command("run")
    .description("Build and install when needed, then start Metro")
    .option("--clean", "re-run expo prebuild --clean (always rebuilds)")
    .option("--if-needed", "skip build and install when dependencies are unchanged (default)")
    .option("--force", "always rebuild and reinstall")
    .action(
      action(async (o: { clean?: boolean; force?: boolean }) => {
        await run(process.cwd(), { clean: o.clean, force: o.force });
      }),
    );
  program
    .command("doctor")
    .description("Check the toolchain, login, device and project")
    .action(
      action(async () => {
        const cwd = process.cwd();
        const report = await doctor(existsSync(path.join(cwd, "app.json")) ? cwd : undefined);
        console.log(renderReport(report.checks));
        if (!report.ok) throw new Error("doctor found problems");
      }),
    );
  return program;
}
