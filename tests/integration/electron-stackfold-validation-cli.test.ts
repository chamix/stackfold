import { execFile } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FIX-004 end-to-end: the only test that exercises the real runtime load
 * path (`src/cli/index.ts` loading `src/plugins/electron-stackfold/
 * scaffold.json`, the artifact `compileScaffold()` compiles into a live
 * plugin) and the CLI's rejection reporting, together, as a real child
 * process. Same pattern as `plugin-project-config-subdir-cli.test.ts`: `tsx`
 * running `src/cli/index.ts` directly, no build step, child `HOME`/
 * `USERPROFILE` pointed at a fresh temp dir so the real `~/.stackfoldrc.json`
 * on the host is never consulted.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = join(REPO_ROOT, 'src/cli/index.ts');
const TSX_CLI = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface RunResult {
  code: number;
  output: string;
}

function runCli(args: string[], cwd: string, fakeHome: string, timeout: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [TSX_CLI, CLI_ENTRY, ...args],
      {
        cwd,
        timeout,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
      }
    );
  });
}

let root: string;
let fakeHome: string;

beforeEach(async () => {
  const madeRoot = await mkdtemp(join(tmpdir(), 'stackfold-electron-stackfold-cli-'));
  root = realpathSync.native(madeRoot);
  const madeHome = await mkdtemp(join(tmpdir(), 'stackfold-electron-stackfold-cli-home-'));
  fakeHome = realpathSync.native(madeHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('electron-stackfold — real CLI validation end-to-end (scaffold.json runtime load path)', () => {
  it(
    'rejects a symbol-only appName: exit code != 0, stderr names "appName", target directory has no files',
    async () => {
      const targetDir = join(root, 'out-bad');

      const result = await runCli(
        [
          'init',
          'electron-stackfold',
          targetDir,
          '--no-open',
          '--answer',
          'appName=!!!',
          '--answer',
          'description=A description',
          '--answer',
          'author=Someone',
          '--answer',
          'includeSettings=false',
          '--answer',
          'includeSkins=false',
          '--answer',
          'includeAboutHelp=false',
        ],
        root,
        fakeHome,
        30_000
      );

      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/appName/);

      await expect(readdir(targetDir)).rejects.toThrow();
    },
    60_000
  );

  it(
    'accepts a valid appName: exit code 0, package.json has a non-empty name',
    async () => {
      const targetDir = join(root, 'out-good');

      const result = await runCli(
        [
          'init',
          'electron-stackfold',
          targetDir,
          '--no-open',
          '--answer',
          'appName=OK App',
          '--answer',
          'description=A description',
          '--answer',
          'author=Someone',
          '--answer',
          'includeSettings=false',
          '--answer',
          'includeSkins=false',
          '--answer',
          'includeAboutHelp=false',
        ],
        root,
        fakeHome,
        30_000
      );

      expect(result.code, `init failed:\n${result.output}`).toBe(0);

      const pkgRaw = await readFile(join(targetDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { name?: string };
      expect(pkg.name).toBeTruthy();
    },
    60_000
  );
});
