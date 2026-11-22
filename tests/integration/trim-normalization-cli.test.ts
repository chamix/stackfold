import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * FIX-005 end-to-end (symptom 1): real CLI as a child process, no build
 * step — `tsx` running `src/cli/index.ts` directly, same pattern as
 * `electron-stackfold-validation-cli.test.ts`/`plugin-project-config-subdir-cli.test.ts`.
 * Before this fix, `plugin-scaffold`'s `postWrite` guard compared the
 * *padded* stored `pluginId` against the real written directory and failed
 * with a message blaming the `init` directory argument, then rolled the
 * write back. After this fix the stored `pluginId` is trimmed by
 * `core/orchestrator.ts`'s `resolveAnswers()` before the guard ever runs, so
 * a padded answer with a matching (unpadded) directory argument succeeds.
 *
 * `plugin-scaffold`'s `postInit` hook also runs a real `stackfold scaffold
 * synth <pluginId>` command (`core/authoring.ts`'s `runHookCommand`,
 * resolved via `ports.processRunner.run()` -> the real `ExecaProcessRunner`
 * for a real CLI run) against whatever `stackfold` binary PATH resolution
 * finds — unrelated to this fix and not installed globally in this test
 * environment. A tiny no-op `stackfold` shim is put on the child's PATH
 * (ahead of everything else) purely so `postInit` succeeds and the process
 * exits 0, exactly as the spec's acceptance criterion requires; it has
 * nothing to do with the behavior under test (the `postWrite` guard).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_ENTRY = join(REPO_ROOT, 'src/cli/index.ts');
const TSX_CLI = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface RunResult {
  code: number;
  output: string;
}

function runCli(args: string[], cwd: string, fakeHome: string, path: string, timeout: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [TSX_CLI, CLI_ENTRY, ...args],
      {
        cwd,
        timeout,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, PATH: path, Path: path },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
      }
    );
  });
}

/**
 * A no-op `stackfold` on PATH — see this file's header comment. Both a
 * plain POSIX shell script and a Windows `.cmd` shim are written; whichever
 * one the OS's own PATHEXT/exec resolution picks up is the one that runs.
 */
async function createFakeStackfoldBin(dir: string): Promise<void> {
  const shPath = join(dir, 'stackfold');
  await writeFile(shPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(shPath, 0o755);
  await writeFile(join(dir, 'stackfold.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
}

let root: string;
let fakeHome: string;
let fakeBin: string;

beforeEach(async () => {
  const madeRoot = await mkdtemp(join(tmpdir(), 'stackfold-trim-cli-'));
  root = realpathSync.native(madeRoot);
  const madeHome = await mkdtemp(join(tmpdir(), 'stackfold-trim-cli-home-'));
  fakeHome = realpathSync.native(madeHome);
  const madeBin = await mkdtemp(join(tmpdir(), 'stackfold-trim-cli-bin-'));
  fakeBin = realpathSync.native(madeBin);
  await createFakeStackfoldBin(fakeBin);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(fakeBin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('plugin-scaffold — real CLI, padded pluginId vs. matching directory argument (FIX-005 symptom 1)', () => {
  it(
    'a padded pluginId answer with a matching (unpadded) directory argument succeeds end to end',
    async () => {
      const path = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;

      const result = await runCli(
        [
          'init',
          'plugin-scaffold',
          'my-plugin',
          '--no-open',
          '--answer',
          'pluginId= my-plugin ',
          '--answer',
          'displayName=My Plugin',
          '--answer',
          'description=A plugin',
          '--answer',
          'author=Ada Lovelace',
        ],
        root,
        fakeHome,
        path,
        30_000
      );

      expect(result.code, `init failed:\n${result.output}`).toBe(0);
      expect(result.output).not.toMatch(/did not match the pluginId answer/);
      expect(existsSync(join(root, 'my-plugin', 'scaffold.ts'))).toBe(true);
    },
    60_000
  );
});
