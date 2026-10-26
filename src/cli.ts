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
import { setupWifi } from "./commands/setupWifi.js";
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
    .option("--wifi", "one-time USB step for Wi‑Fi installs: cache the pair record, enable Wi‑Fi connections on the iPhone")
    .option("--yes", "with --wifi: confirm changing the iPhone's Wi‑Fi connections setting")
    .option("--udid <udid>", "with --wifi: which USB iPhone to set up")
    .action(
      action(async (o: { xcodeXip?: string; wifi?: boolean; yes?: boolean; udid?: string }) => {
        if (o.wifi) {
          await setupWifi({ yes: o.yes, udid: o.udid });
          return;
        }
        if (o.yes || o.udid) throw new Error("--yes and --udid only apply to setup --wifi");
        const config = await loadConfig(process.cwd());
        await setup({ xcodeXip: o.xcodeXip ?? config.xcodeXipPath, xtoolPath: config.xtoolPath });
      }),
    );
  program
    .command("install")
    .description("Build, sign and install the app on the iPhone (USB by default, Wi‑Fi with --network)")
    .option("--network [ip]", "install over Wi‑Fi (finds the iPhone on the LAN when no IP is given)")
    .option("--udid <udid>", "which paired iPhone to use over Wi‑Fi")
    .option("--pair-record <file>", "pair record to use over Wi‑Fi (e.g. copied from /var/lib/lockdown on WSL2)")
    .action(
      action(async (o: { network?: boolean | string; udid?: string; pairRecord?: string }) => {
        if (!o.network && (o.udid || o.pairRecord)) throw new Error("--udid and --pair-record need --network");
        await install(process.cwd(), {}, o);
      }),
    );
  program
    .command("build")
    .description("Prebuild if needed (Expo), run the SwiftPM pipeline and build with xtool")
    .option("--clean", "re-run expo prebuild --clean (Expo) or remove ios/build and ios-xtool (bare)")
    .action(
      action(async (o: { clean?: boolean }) => {
        await build(process.cwd(), { clean: o.clean });
      }),
    );
  program
    .command("start")
    .description("Start Metro on the port and LAN IP the app was built for")
    .option("--clear", "reset Metro's cache (expo start --clear, react-native start --reset-cache)")
    .action(
      action(async (o: { clear?: boolean }) => {
        await start(process.cwd(), { clear: o.clear });
      }),
    );
  program
    .command("run")
    .description("Build and install when needed, then start Metro")
    .option("--clean", "clean like build --clean (always rebuilds)")
    .option("--force", "always rebuild and reinstall")
    .option("--network [ip]", "install over Wi‑Fi (see install --network)")
    .option("--udid <udid>", "which paired iPhone to use over Wi‑Fi")
    .option("--pair-record <file>", "pair record to use over Wi‑Fi")
    .action(
      action(
        async (o: { clean?: boolean; force?: boolean; network?: boolean | string; udid?: string; pairRecord?: string }) => {
          if (!o.network && (o.udid || o.pairRecord)) throw new Error("--udid and --pair-record need --network");
          await run(process.cwd(), o);
        },
      ),
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
