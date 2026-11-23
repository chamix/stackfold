import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ARCH-008/D4 (3) — the one test that exercises the real, *built* CLI
 * (`dist/cli/index.js`, the exact file `src/cli/index.ts` compiles to and the
 * exact binary a console user runs), as a real child process, with
 * `NO_COLOR=1` so assertions compare plain text. Same risk class as FIX-004:
 * `electron-stackfold`'s runtime load path reads the *compiled*
 * `src/plugins/electron-stackfold/scaffold.json`, not `scaffold.ts` directly
 * (`src/cli/index.ts`'s own composition root) — a stale `scaffold.json` would
 * pass every unit test that imports `scaffold.ts` while still shipping the
 * old text to a real user. Only a child process against `dist/` catches that.
 *
 * Precondition: `npm run build` must have run at least once before this
 * file runs — the same precondition `external-plugin-scaffold.test.ts` and
 * the `*-tier5.test.ts` CLI integration tests already document for their own
 * `dist/cli/index.js` child-process checks; this is the fast/cheap tier
 * (`stackfold list`/`info`, no `npm install`), so unlike those it is not
 * gated behind an opt-in env var.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STACKFOLD_CLI = join(REPO_ROOT, 'dist/cli/index.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBuiltCli(args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [STACKFOLD_CLI, ...args],
      { cwd: REPO_ROOT, timeout, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ code, stdout, stderr });
      }
    );
  });
}

describe('real built CLI (dist/cli/index.js) — ARCH-008 deprecation text', () => {
  it(
    '`stackfold list` exits 0 and shows electron-ts deprecated, electron-stackfold as its successor',
    async () => {
      const result = await runBuiltCli(['list'], 30_000);

      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/electron-ts\)[\s\S]*?Deprecated since 2\.6\.0/);
      expect(result.stdout).toMatch(/removal planned for 3\.0\.0/);
      expect(result.stdout).toMatch(/electron-stackfold/);
      expect(result.stdout).toMatch(/successor of the deprecated electron-ts/);
      expect(result.stdout).not.toMatch(/recommended/i);
    },
    60_000
  );

  it(
    '`stackfold info electron-ts` exits 0 and its description/help.details declare the deprecation',
    async () => {
      const result = await runBuiltCli(['info', 'electron-ts'], 30_000);

      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/Deprecated since 2\.6\.0, removal planned for 3\.0\.0/);
      expect(result.stdout).toMatch(/use electron-stackfold \(same output\)/);
      expect(result.stdout).not.toMatch(/recommended/i);
    },
    60_000
  );

  it(
    '`stackfold info electron-stackfold` exits 0 and no longer calls electron-ts "recommended"',
    async () => {
      const result = await runBuiltCli(['info', 'electron-stackfold'], 30_000);

      expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/successor of the deprecated electron-ts/);
      expect(result.stdout).not.toMatch(/recommended/i);
      expect(result.stdout).not.toMatch(/\(alternative\)/);
    },
    60_000
  );
});
