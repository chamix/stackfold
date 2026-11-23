#!/usr/bin/env node
/**
 * FIX-006 — packaging guard (G2-c). The one check that walks the exact
 * path a real `npm install stackfold` user takes: pack a real tarball,
 * install it into a brand-new sandbox (no repo `node_modules` involved),
 * then run the *installed* binary. `pack-manifest.test.ts` (vitest,
 * `tests/integration/`) checks the manifest without installing anything;
 * this script is the thing that actually proves the installed CLI
 * starts — the exact failure mode from the 2.6.0 incident
 * (`loadTemplate: template file not found` on every command, including
 * `--version`, because `plugin-builder` loads its templates eagerly).
 *
 * Run via `npm run smoke:pack`. Called from `ci.yml` on every push/PR and
 * from `release.yml` after `npm test` and before `Publish`.
 *
 * Isolation rules (`.claude/project/testing.md`): a fresh per-run temp
 * root, `HOME`/`USERPROFILE` pointed at it so no real user-level npm
 * state leaks in, paths normalized with `fs.realpathSync.native`, no
 * symlinks/junctions, cleanup via `fs.rm(..., { recursive: true, force:
 * true, maxRetries: 10, retryDelay: 100 })`.
 */
import { execa } from 'execa';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = join(REPO_ROOT, 'dist');

function log(step, message) {
  console.log(`\n[${step}] ${message}`);
}

/** Streams the child's output live and throws loudly (with full context, raw output included) on a non-zero exit. */
async function run(label, command, args, options) {
  console.log(`\n$ ${command} ${args.join(' ')}\n  (cwd: ${options.cwd})\n`);
  try {
    return await execa(command, args, { stdio: 'inherit', ...options });
  } catch (err) {
    throw new Error(`[${label}] "${command} ${args.join(' ')}" failed:\n${err instanceof Error ? err.message : err}`);
  }
}

/** Runs a command, captures stdout, and throws with the raw captured output (not just the error message) on failure. */
async function runCaptured(label, command, args, options) {
  console.log(`\n$ ${command} ${args.join(' ')}\n  (cwd: ${options.cwd})\n`);
  try {
    const result = await execa(command, args, options);
    console.log(result.stdout);
    return result;
  } catch (err) {
    const stdout = err && typeof err === 'object' && 'stdout' in err ? err.stdout : '';
    const stderr = err && typeof err === 'object' && 'stderr' in err ? err.stderr : '';
    throw new Error(
      `[${label}] "${command} ${args.join(' ')}" failed.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    );
  }
}

async function main() {
  if (!existsSync(DIST_DIR)) {
    throw new Error(`smoke:pack requires a built dist/ — run "npm run build" first (expected to find: ${DIST_DIR})`);
  }

  const { version: expectedVersion } = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(REPO_ROOT, 'package.json'), 'utf8')
  );

  // Built-in plugin ids, derived from dist/plugins/* — never hardcoded, so
  // a future plugin is covered automatically (functional_domain.md
  // invariant 5).
  const pluginIds = (await readdir(join(DIST_DIR, 'plugins'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (pluginIds.length === 0) {
    throw new Error(`expected at least one built-in plugin under ${join(DIST_DIR, 'plugins')}, found none`);
  }

  const tmpRootRaw = await mkdtemp(join(tmpdir(), 'stackfold-smoke-pack-'));
  const tmpRoot = realpathSync.native(tmpRootRaw);
  const homeDir = join(tmpRoot, 'home');
  const packDestination = join(tmpRoot, 'pack');
  const sandboxRoot = join(tmpRoot, 'sandbox');
  await mkdir(homeDir, { recursive: true });
  await mkdir(packDestination, { recursive: true });
  await mkdir(sandboxRoot, { recursive: true });

  // Isolates user-level npm state (config, cache lookups) so this run
  // never depends on — or mutates — the real operator's home directory.
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };

  try {
    log('1/3', 'Packing this repo into a real tarball (no network, no doubles)...');
    await run('npm pack', 'npm', ['pack', '--pack-destination', packDestination], { cwd: REPO_ROOT, env });
    const tarballs = (await readdir(packDestination)).filter((name) => name.endsWith('.tgz'));
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one .tgz in ${packDestination}, found: ${JSON.stringify(tarballs)}`);
    }
    const tarballPath = join(packDestination, tarballs[0]);

    log('2/3', 'Installing the packed tarball into a brand-new sandbox (no repo node_modules involved)...');
    await writeFile(
      join(sandboxRoot, 'package.json'),
      JSON.stringify({ name: 'stackfold-smoke-pack-sandbox', private: true }),
      'utf8'
    );
    await run('npm install', 'npm', ['install', tarballPath, '--no-audit', '--no-fund'], { cwd: sandboxRoot, env });

    const cliEntry = join(sandboxRoot, 'node_modules', 'stackfold', 'dist', 'cli', 'index.js');
    if (!existsSync(cliEntry)) {
      throw new Error(`expected the installed CLI entry point at "${cliEntry}", but it does not exist`);
    }

    log('3/3', 'Running the installed binary: "--version" and "list"...');
    const versionResult = await runCaptured('stackfold --version', 'node', [cliEntry, '--version'], {
      cwd: sandboxRoot,
      env,
    });
    const printedVersion = versionResult.stdout.trim();
    if (printedVersion !== expectedVersion) {
      throw new Error(`expected "stackfold --version" to print "${expectedVersion}", got "${printedVersion}"`);
    }

    const listResult = await runCaptured('stackfold list', 'node', [cliEntry, 'list'], { cwd: sandboxRoot, env });
    const missingFromList = pluginIds.filter((id) => !listResult.stdout.includes(id));
    if (missingFromList.length > 0) {
      throw new Error(
        `"stackfold list" is missing built-in plugin id(s) ${JSON.stringify(missingFromList)}.\n--- stdout ---\n${listResult.stdout}`
      );
    }

    console.log('\n✔ smoke:pack: the installed tarball starts and lists every built-in plugin.');
  } finally {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error('\nsmoke:pack failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
