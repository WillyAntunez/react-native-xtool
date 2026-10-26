'use strict';

/**
 * Runs React Native's SwiftPM pipeline (`setup-apple-spm.js add`, steps 1-5) without step 6, the
 * in-place injection into the app's .xcodeproj: expo-xtool never builds with the xcodeproj, and a
 * bare app's pbxproj is CocoaPods-integrated, which `add` refuses. Only `<app-root>/ios/build/` is
 * written. RN's own modules (required from --rn-dir) do the work; this file only sequences them.
 *
 * `--scaffold` instead runs RN's `scaffold` step alone: it writes a Package.swift into each autolinked
 * library that ships a podspec but no manifest. RN's own `setup-apple-spm.js scaffold` cannot be
 * used: after scaffolding it falls through into the whole `add` pipeline, injection included.
 *
 * Exit codes: 0 ok, 2 the autolinker reported libraries without a Package.swift (its `error:`
 * lines are already printed), 1 anything else.
 */

const path = require('node:path');
const {parseArgs} = require('node:util');

const USAGE =
  'Usage: node scripts/rn-spm-generate.js --rn-dir <abs> --app-root <abs> [--artifacts <root>] [--config-command <json>] [--scaffold]';

function parseCli(argv) {
  let values;
  try {
    ({values} = parseArgs({
      args: argv,
      options: {
        'rn-dir': {type: 'string'},
        'app-root': {type: 'string'},
        artifacts: {type: 'string'},
        'config-command': {type: 'string'},
        scaffold: {type: 'boolean'},
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return null;
  }
  const rnDir = values['rn-dir'];
  const appRoot = values['app-root'];
  if (rnDir == null || appRoot == null) return null;
  if (!path.isAbsolute(rnDir) || !path.isAbsolute(appRoot)) return null;
  return {
    rnDir,
    projectRoot: appRoot,
    artifacts: values.artifacts ?? null,
    configCommand: values['config-command'] ?? null,
    scaffold: values.scaffold === true,
  };
}

async function generate(cli) {
  const rn = rel => require(path.join(cli.rnDir, 'scripts', rel));
  const setup = rn('setup-apple-spm.js');
  const {generateAutolinkingConfig, parseConfigCommandJson} = rn(
    'spm/generate-spm-autolinking-config.js',
  );
  const {refreshScaffoldedPlatformFloors, scaffoldAll} = rn(
    'spm/scaffold-package-swift.js',
  );

  // RN's "app root" is the iOS dir: build/ lives under it.
  const appRoot = path.join(cli.projectRoot, 'ios');
  // The SetupArgs fields setup-apple-spm.js's helpers read. --artifacts means offline, like
  // `--download skip --artifacts <root>`: validate the {debug,release} slots, never fetch.
  const args = {
    version: null,
    artifacts: cli.artifacts,
    downloadPolicy: cli.artifacts != null ? 'skip' : 'auto',
    xcodeprojPath: null,
    productName: null,
  };

  // 1. autolinking config → build/generated/autolinking/autolinking.json
  console.log('Generating autolinking.json (CLI config)...');
  const config = generateAutolinkingConfig({
    projectRoot: cli.projectRoot,
    configCommand:
      cli.configCommand != null
        ? parseConfigCommandJson(cli.configCommand, '--config-command')
        : undefined,
  });
  // Reads the pbxproj's deployment target; never writes it.
  const iosDeploymentTarget = setup.resolveAppIosDeploymentTarget(args, appRoot);
  const version = setup.determineVersion(args, cli.rnDir, appRoot);
  console.log(`React Native version: ${version}`);

  if (cli.scaffold) {
    await scaffold(rn, scaffoldAll, {
      appRoot,
      projectRoot: cli.projectRoot,
      reactNativeRoot: cli.rnDir,
      autolinkingJsonPath: config.outputPath,
      iosDeploymentTarget,
      version,
    });
    return 0;
  }

  const {main: sync} = rn('spm/sync-spm-autolinking.js');
  const {main: generatePackage} = rn('spm/generate-spm-package.js');
  const {finalizeArtifactPublication} = rn('spm/flavored-frameworks.js');

  for (const r of refreshScaffoldedPlatformFloors({
    appRoot,
    autolinkingJsonPath: config.outputPath,
    iosDeploymentTarget,
  })) {
    console.log(`Refreshed platform floor in ${r.path}: ${r.from} → ${r.to}`);
  }

  // 2. codegen, build/generated/autolinking/Package.swift, header farm
  try {
    await sync([
      '--app-root',
      appRoot,
      '--react-native-root',
      cli.rnDir,
      '--ios-deployment-target',
      iosDeploymentTarget,
    ]);
  } catch (e) {
    if (e != null && e.name === 'MissingManifestError') return 2;
    throw e;
  }

  // 3. both artifact flavors (download into RN's cache slots, or validate --artifacts)
  const dirs = await setup.ensureBothArtifactFlavors(args, version);

  // 4. build/xcframeworks/Package.swift + flavored-frameworks.json
  console.log('Generating xcframeworks sub-package...');
  generatePackage([
    '--app-root',
    appRoot,
    '--react-native-root',
    cli.rnDir,
    '--version',
    version,
    '--debug-artifacts-dir',
    dirs.debug,
    '--release-artifacts-dir',
    dirs.release,
  ]);
  // RN promotes the pending artifact stamp once its injection succeeded; there is none here.
  finalizeArtifactPublication(appRoot);
  return 0;
}

// Mirrors setup-apple-spm.js `runScaffold`, except that a scaffoldAll throw propagates (exit 1).
async function scaffold(rn, scaffoldAll, opts) {
  const {version, ...scaffoldOpts} = opts;
  // The slot label is written into each manifest so SwiftPM re-resolves on a slot change; RN
  // scaffolds without it when the slot cannot be resolved.
  let cacheSlotLabel = null;
  try {
    const {resolveCacheSlotVersion} = rn('spm/download-spm-artifacts.js');
    cacheSlotLabel = `${await resolveCacheSlotVersion(version)}/dual-flavor`;
  } catch {}
  const results = scaffoldAll({...scaffoldOpts, cacheSlotLabel, force: true});

  const written = results.filter(r => r.status === 'written');
  if (written.length > 0) {
    console.log(`Scaffolded Package.swift for ${written.length} dep(s):`);
    for (const r of written) console.log(`  • ${r.depName}`);
  }
  for (const r of written) {
    for (const w of r.warnings ?? []) console.log(`  ! ${r.depName}: ${w}`);
  }
  for (const r of results.filter(x => x.status === 'error')) {
    console.error(`  ! ${r.depName}: ${r.reason}`);
  }
}

const cli = parseCli(process.argv.slice(2));
if (cli == null) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  generate(cli).then(
    code => {
      process.exitCode = code;
    },
    e => {
      console.error(`rn-spm-generate: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
