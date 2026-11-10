import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * End-to-end: spawns the real `stackfold` CLI (via `tsx`, no build step
 * required — modeled on `web-app-stackfold-plugin-tier5.test.ts`'s real-
 * CLI-process pattern, not `scaffold-synth-cli.test.ts`'s in-process one)
 * to prove `plugin register --project`/`plugin list`/`init` all find the
 * project-level config from a subdirectory, and correctly do NOT find it
 * from outside the project boundary.
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
  const madeRoot = await mkdtemp(join(tmpdir(), 'stackfold-plugin-subdir-cli-'));
  root = realpathSync.native(madeRoot);
  const madeHome = await mkdtemp(join(tmpdir(), 'stackfold-plugin-subdir-cli-home-'));
  // Isolates the real ~/.stackfoldrc.json on the host machine from this run
  // (the global level is fixed and must never participate here).
  fakeHome = realpathSync.native(madeHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('plugin project config — found from a subdirectory via the real CLI (no doubles)', () => {
  it(
    'registers at the project root, then "plugin list" and "init" both see it from a subdirectory',
    async () => {
      await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n', 'utf8');
      await writeFile(
        join(root, 'my-plugin.json'),
        JSON.stringify({
          id: 'subdir-fixture',
          description: 'A fixture plugin for the project-config-subdirectory CLI test.',
          questions: [{ id: 'appName', message: 'App name?', type: 'input', default: 'Fixture App' }],
          steps: [{ action: 'writeFile', params: { path: 'README.md', content: '# {{appName}}\n' } }],
        }),
        'utf8'
      );

      const register = await runCli(['plugin', 'register', 'my-plugin.json', '--project'], root, fakeHome, 30_000);
      expect(register.code, `register failed:\n${register.output}`).toBe(0);
      expect(register.output).toContain('registered "subdir-fixture"');

      const subdir = join(root, 'sub', 'deeper');
      await mkdir(subdir, { recursive: true });

      const list = await runCli(['plugin', 'list'], subdir, fakeHome, 30_000);
      expect(list.code, `plugin list failed:\n${list.output}`).toBe(0);
      expect(list.output).toMatch(/subdir-fixture.*✓ resolves/);

      const targetDir = join(subdir, 'scaffolded-app');
      const init = await runCli(
        ['init', 'subdir-fixture', targetDir, '--no-open', '--answer', 'appName=Subdir App'],
        subdir,
        fakeHome,
        30_000
      );
      expect(init.code, `init failed:\n${init.output}`).toBe(0);

      const { readFile } = await import('node:fs/promises');
      const written = await readFile(join(targetDir, 'README.md'), 'utf8');
      expect(written).toBe('# Subdir App\n');
    },
    60_000
  );

  it(
    'a sibling directory outside the project boundary does not see the registered plugin',
    async () => {
      await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"0.0.0"}\n', 'utf8');
      await writeFile(
        join(root, 'my-plugin.json'),
        JSON.stringify({
          id: 'outside-fixture',
          description: 'A fixture plugin that must stay invisible outside the project boundary.',
          questions: [],
          steps: [{ action: 'writeFile', params: { path: 'README.md', content: '# hi\n' } }],
        }),
        'utf8'
      );

      const register = await runCli(['plugin', 'register', 'my-plugin.json', '--project'], root, fakeHome, 30_000);
      expect(register.code, `register failed:\n${register.output}`).toBe(0);

      // A sibling tmpdir, with its own package.json boundary — never an
      // ancestor of `root`, so the registered config must not be visible.
      const outsideMade = await mkdtemp(join(tmpdir(), 'stackfold-plugin-subdir-cli-outside-'));
      const outside = realpathSync.native(outsideMade);
      try {
        await writeFile(join(outside, 'package.json'), '{"name":"outside","version":"0.0.0"}\n', 'utf8');

        const list = await runCli(['plugin', 'list'], outside, fakeHome, 30_000);
        expect(list.code, `plugin list failed:\n${list.output}`).toBe(0);
        expect(list.output).not.toContain('outside-fixture');
        expect(list.output).toContain('No external plugins registered.');
      } finally {
        await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    60_000
  );
});
