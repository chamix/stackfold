#!/usr/bin/env node
/**
 * Dev-only playground — not run by `npm test` or CI (see
 * .agents/specs/cli-console-e2e-harness.md, blast-radius item (c)): this is
 * meant to be driven by a human in real time, which Vitest has no way to
 * assert on.
 *
 * Scaffolds a real electron-ts project via the actual `stackfold` CLI
 * console (the same `node dist/cli/index.js init ...` a published install
 * would run — not the plugin API in-process), installs + builds it for
 * real, then hands off to Playwright's interactive UI mode against the
 * real built Electron app, for manual exploration/inspection.
 *
 * The generated project lives at .e2e-playground/generated (gitignored)
 * and is wiped and regenerated from scratch on every run — `stackfold init`
 * never overwrites existing files, so a stale playground would otherwise
 * silently stop reflecting template changes.
 *
 * Usage:
 *   npm run e2e:playground
 *   STACKFOLD_PLAYGROUND_MODE=debug npm run e2e:playground     # Inspector instead of UI mode
 *   STACKFOLD_PLAYGROUND_SETTINGS=false npm run e2e:playground
 *   STACKFOLD_PLAYGROUND_SKINS=false npm run e2e:playground
 *   STACKFOLD_PLAYGROUND_ABOUT_HELP=false npm run e2e:playground
 */
import { execa } from 'execa';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYGROUND_DIR = join(REPO_ROOT, '.e2e-playground');
const PROJECT_DIR = join(PLAYGROUND_DIR, 'generated');

function flag(envVar, fallback = true) {
  const raw = process.env[envVar];
  return raw === undefined ? fallback : raw !== 'false';
}

const flags = {
  includeSettings: flag('STACKFOLD_PLAYGROUND_SETTINGS'),
  includeSkins: flag('STACKFOLD_PLAYGROUND_SKINS'),
  includeAboutHelp: flag('STACKFOLD_PLAYGROUND_ABOUT_HELP'),
};

const playwrightMode = process.env['STACKFOLD_PLAYGROUND_MODE'] === 'debug' ? '--debug' : '--ui';

/** Streams the child's output live — this *is* the "levantar una consola" part. */
async function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}\n  (cwd: ${cwd})\n`);
  await execa(command, args, { cwd, stdio: 'inherit' });
}

async function main() {
  console.log(`Regenerating playground at ${PLAYGROUND_DIR} (always from scratch)...`);
  await rm(PLAYGROUND_DIR, { recursive: true, force: true });

  // Ensure dist/cli/index.js is fresh — it's the exact file we're about to spawn.
  await run('npm', ['run', 'build'], REPO_ROOT);

  await run(
    process.execPath,
    [
      join(REPO_ROOT, 'dist/cli/index.js'),
      'init',
      'electron-ts',
      PROJECT_DIR,
      '--answer',
      'appName=Playground App',
      '--answer',
      'description=stackfold e2e playground',
      '--answer',
      `author=${process.env['USERNAME'] ?? process.env['USER'] ?? 'stackfold'}`,
      '--answer',
      `includeSettings=${flags.includeSettings}`,
      '--answer',
      `includeSkins=${flags.includeSkins}`,
      '--answer',
      `includeAboutHelp=${flags.includeAboutHelp}`,
    ],
    REPO_ROOT
  );

  await run('npm', ['install', '--no-audit', '--no-fund'], PROJECT_DIR);
  await run('npm', ['run', 'build'], PROJECT_DIR);

  console.log(`\nHanding off to Playwright (${playwrightMode}) against the real built app in ${PROJECT_DIR} ...`);
  console.log(`(Re-run later without re-scaffolding: cd ${PROJECT_DIR} && npx playwright test ${playwrightMode})\n`);

  // reject:false — the UI/Inspector's own exit code shouldn't be screamed at
  // as a script "failure" (e.g. you just closing the window).
  const result = await execa('npx', ['playwright', 'test', playwrightMode], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    reject: false,
  });
  process.exitCode = result.exitCode ?? 0;
}

main().catch((err) => {
  console.error('\ne2e:playground failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
