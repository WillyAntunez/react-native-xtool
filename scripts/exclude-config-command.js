'use strict';

/**
 * Wraps React Native's autolinking config command for rn-xtool.config.json's `exclude`:
 *
 *   node scripts/exclude-config-command.js --exclude '<json array>' -- <cmd> [args...]
 *
 * Runs the command (cwd inherited), then prints its JSON with `dependencies[<name>].platforms.ios` set to null for each
 * excluded package it lists: what `platforms: { ios: null }` in react-native.config.js produces, for rn-xtool's builds
 * only. Autolinking, the scaffolder and codegen (which reads the autolinking.json written from this output) leave those
 * packages out. A non-zero exit passes the command's output and exit code through.
 */

const {spawnSync} = require('node:child_process');

const USAGE =
  "Usage: node scripts/exclude-config-command.js --exclude '<json array>' -- <cmd> [args...]";

function parseCli(argv) {
  const sep = argv.indexOf('--');
  if (argv[0] !== '--exclude' || sep !== 2 || argv.length < 4) return null;
  let exclude;
  try {
    exclude = JSON.parse(argv[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(exclude) || !exclude.every(n => typeof n === 'string' && n !== '')) return null;
  return {exclude, command: argv.slice(3)};
}

function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli == null) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const [cmd, ...args] = cli.command;
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (typeof r.stderr === 'string') process.stderr.write(r.stderr);
  if (r.error != null) {
    process.stderr.write(`exclude-config-command: '${cli.command.join(' ')}' could not run: ${r.error.message}\n`);
    return 1;
  }
  if (r.status !== 0) {
    if (typeof r.stdout === 'string') process.stdout.write(r.stdout);
    return typeof r.status === 'number' ? r.status : 1;
  }
  let config;
  try {
    config = JSON.parse(r.stdout);
  } catch {
    config = undefined;
  }
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    process.stderr.write(
      `exclude-config-command: '${cli.command.join(' ')}' printed no JSON object: ${String(r.stdout).slice(0, 200)}\n`,
    );
    return 1;
  }
  const deps = config.dependencies;
  if (deps != null && typeof deps === 'object') {
    for (const name of cli.exclude) {
      const dep = deps[name];
      if (dep == null || typeof dep !== 'object') continue;
      dep.platforms = {...(dep.platforms != null && typeof dep.platforms === 'object' ? dep.platforms : {}), ios: null};
    }
  }
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

process.exitCode = main();
