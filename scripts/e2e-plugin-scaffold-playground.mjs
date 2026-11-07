#!/usr/bin/env node
/**
 * ARCH-003 acceptance test — "external plugin authoring without a repo
 * checkout." Everything `tests/unit/`/`tests/integration/` exercise in
 * this cycle still runs inside this repo's own `node_modules` context
 * (`tsx`/`vitest` resolved from here), which can never actually prove the
 * thing this task exists to fix: that a plugin author with nothing but
 * `npm install stackfold` — no checkout, no access to this repo's own
 * `node_modules` — can author, synth, register, and use a new plugin.
 *
 * This script proves exactly that, end to end, against a real packed
 * tarball (same method PKG-001/#54 fixed and was manually verified
 * against — moving `tsx` to `dependencies` — though that fix itself
 * shipped without an automated pack-based regression test; this script is
 * the first one):
 *
 *   1. `npm run build` + `npm pack` this repo into a real tarball.
 *   2. `npm install <tarball>` into a brand-new, empty sandbox directory
 *      (outside this repo's own `node_modules` resolution entirely).
 *   3. `stackfold init plugin-scaffold <pluginId>` (the installed bin,
 *      resolved via PATH, not `npx tsx src/cli/index.ts`) from a fresh
 *      working directory inside the sandbox.
 *   4. Confirm the generated `scaffold.ts`'s `import ... from
 *      'stackfold/authoring'` really resolves against the installed
 *      package (step 3's own `postInit` hook already runs `stackfold
 *      scaffold synth <pluginId>`, which loads and executes that import;
 *      this script also re-runs `scaffold synth` explicitly afterward as
 *      an idempotency check).
 *   5. `stackfold plugin register <pluginId>/scaffold.json --project`.
 *   6. `stackfold init <pluginId> <output dir>` — the newly registered
 *      plugin actually scaffolds a real project.
 *
 * Not run by `npm test`/CI (same convention as `scripts/e2e-playground.mjs`
 * — this is a human-triggered acceptance check, not a unit/integration
 * tier): it shells out to a real `npm install` against a freshly packed
 * tarball, which is slow and network/registry-cache-dependent in ways a
 * fast test suite should never be.
 *
 * Usage:
 *   npm run e2e:plugin-scaffold
 */
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PLUGIN_ID = 'hello-world-plugin';
const ANSWERS = {
  pluginId: PLUGIN_ID,
  displayName: 'Hello World Plugin',
  description: 'A plugin authored without a stackfold repo checkout.',
  author: 'ARCH-003 e2e script',
};

function log(step, message) {
  console.log(`\n[${step}] ${message}`);
}

/** Streams the child's output live and throws loudly (with full context) on a non-zero exit. */
async function run(label, command, args, options) {
  console.log(`\n$ ${command} ${args.join(' ')}\n  (cwd: ${options.cwd})\n`);
  try {
    return await execa(command, args, { stdio: 'inherit', ...options });
  } catch (err) {
    throw new Error(`[${label}] "${command} ${args.join(' ')}" failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  log('1/6', 'Building and packing this repo into a real tarball...');
  await run('build', 'npm', ['run', 'build'], { cwd: REPO_ROOT });

  const packDestination = await mkdtemp(join(tmpdir(), 'stackfold-pack-'));
  console.log(`\n$ npm pack --json --pack-destination ${packDestination}\n  (cwd: ${REPO_ROOT})\n`);
  // Deliberately NOT `stdio: 'inherit'` here (unlike every other `run()`
  // call below) — this is the one command whose stdout this script needs
  // to parse as JSON, so it's captured instead of streamed live.
  const { stdout: packJson } = await execa('npm', ['pack', '--json', '--pack-destination', packDestination], {
    cwd: REPO_ROOT,
  });
  const [{ filename: tarballName }] = JSON.parse(packJson);
  const tarballPath = join(packDestination, tarballName);
  await stat(tarballPath); // throws loudly if npm pack silently produced nothing at this path

  log('2/6', `Installing the packed tarball into a brand-new, empty sandbox (no repo node_modules involved)...`);
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'stackfold-plugin-scaffold-sandbox-'));
  const sandboxWorkDir = join(sandboxRoot, 'work'); // distinct from the sandbox's own node_modules
  await mkdir(sandboxWorkDir, { recursive: true });

  await run(
    'npm init',
    'npm',
    ['init', '--yes', '--scope=stackfold-e2e-sandbox'],
    { cwd: sandboxRoot }
  );
  await run('npm install', 'npm', ['install', tarballPath, '--no-audit', '--no-fund'], { cwd: sandboxRoot });

  const binDir = join(sandboxRoot, 'node_modules', '.bin');
  await stat(join(binDir, process.platform === 'win32' ? 'stackfold.cmd' : 'stackfold'));
  // Every subsequent `stackfold` invocation below resolves via PATH alone
  // (never an absolute dist/cli/index.js path, and never `npx tsx ...`) —
  // including the ones `plugin-scaffold`'s own `postInit` hook shells out
  // to internally, since execa inherits this same env by default.
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };

  log('3/6', `Running "stackfold init plugin-scaffold ${PLUGIN_ID}" from the sandbox work dir...`);
  await run(
    'init plugin-scaffold',
    'stackfold',
    [
      'init',
      'plugin-scaffold',
      PLUGIN_ID,
      '--no-open',
      ...Object.entries(ANSWERS).flatMap(([key, value]) => ['--answer', `${key}=${value}`]),
    ],
    { cwd: sandboxWorkDir, env }
  );

  const pluginDir = join(sandboxWorkDir, PLUGIN_ID);
  const scaffoldJsonPath = join(pluginDir, 'scaffold.json');

  log('4/6', "Confirming the generated scaffold.ts's import from 'stackfold/authoring' really resolved...");
  // plugin-scaffold's own postInit hook already ran `scaffold synth` as
  // part of step 3 above — if `import ... from 'stackfold/authoring'`
  // inside the generated scaffold.ts had failed to resolve, that hook
  // (and therefore the whole `init` command) would already have failed
  // loudly. This existence check plus an explicit, idempotent re-run below
  // is the positive confirmation.
  await stat(scaffoldJsonPath);
  const scaffoldJson = JSON.parse(await readFile(scaffoldJsonPath, 'utf8'));
  if (scaffoldJson.id !== PLUGIN_ID) {
    throw new Error(`expected synthesized scaffold.json id to be "${PLUGIN_ID}", got "${scaffoldJson.id}"`);
  }

  await run('scaffold synth (idempotency re-run)', 'stackfold', ['scaffold', 'synth', PLUGIN_ID], {
    cwd: sandboxWorkDir,
    env,
  });

  log('5/6', `Registering ${PLUGIN_ID} at the project level...`);
  await run('plugin register', 'stackfold', ['plugin', 'register', join(PLUGIN_ID, 'scaffold.json'), '--project'], {
    cwd: sandboxWorkDir,
    env,
  });

  log('6/6', `Using the newly registered plugin: "stackfold init ${PLUGIN_ID} <output dir>"...`);
  const generatedProjectDir = join(sandboxWorkDir, 'generated-from-new-plugin');
  await run('init <new-id>', 'stackfold', ['init', PLUGIN_ID, generatedProjectDir, '--no-open'], {
    cwd: sandboxWorkDir,
    env,
  });

  const readmePath = join(generatedProjectDir, 'README.md');
  await stat(readmePath);
  const readme = await readFile(readmePath, 'utf8');
  if (!readme.includes(ANSWERS.displayName)) {
    throw new Error(`expected generated README.md to contain "${ANSWERS.displayName}", got:\n${readme}`);
  }

  console.log('\n✔ ARCH-003 external-plugin-authoring loop succeeded end to end, with no repo checkout involved.');

  await rm(packDestination, { recursive: true, force: true });
  await rm(sandboxRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('\ne2e:plugin-scaffold failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
