import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `web-app-standalone-html` plugin — Tier 5 launch check
 * (`.agents/specs/web-standalone-html-e2e-harness.md`, approved 2026-10-17).
 *
 * Adapted from the CLI-console pattern introduced for `electron-ts`
 * (`electron-ts-plugin-e2e.test.ts` / `cli-console-e2e-harness.md`): the
 * invariant that matters is "spawn the real built binary, not
 * `plugin.buildBlueprint()` in-process" — preserved here. The
 * install/build/`test:e2e` pipeline has no equivalent for this plugin: it
 * emits exactly one file, zero `package.json`, zero `postActions` (the
 * deliberate degenerate case, SK-ADR-001's "Consequences"). So instead of
 * installing/building a generated project, this tier opens the single
 * emitted `index.html` directly in a real browser via `file://` and
 * verifies the plugin's own documented contract — "no network call of any
 * kind after the initial load" (`standalone-html.ts`'s header comment) —
 * which until now was only checked by string-inspection, never by a real
 * browser actually loading the page.
 */

const BASE_ANSWERS = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'web-app-standalone-html plugin — launch test (tier 5): skipped — set STACKFOLD_RUN_E2E_TESTS=1 to run the real CLI-console + real-browser check (needs a Chromium binary installed locally via `npx playwright install chromium`).'
  );
}

/** stackfold's own repo root, derived from this file's location (ESM-safe — no bare __dirname). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STACKFOLD_CLI = join(REPO_ROOT, 'dist/cli/index.js');

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
  // On Windows `npm` resolves to a `.cmd` shim, which execFile cannot spawn
  // directly (EINVAL). Route through `cmd.exe /c` explicitly (fixed args,
  // no untrusted input) rather than the `shell: true` option, which would
  // concatenate args into an unescaped string. (Same shape as
  // `electron-ts-plugin-e2e.test.ts`'s own `execNpm` — duplicated, not
  // shared, per this tier's own spec's "no shared helper" decision.)
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : ['npm', args];
  return new Promise((resolvePromise) => {
    execFile(cmd, cmdArgs, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/**
 * Spawns the real, built `stackfold` CLI — not `plugin.buildBlueprint()` —
 * so this tier actually exercises `cli/index.ts`/Commander/the
 * non-interactive `--answer` path, the same binary a console user runs. No
 * shell, so no quoting/injection concerns even though `BASE_ANSWERS.appName`
 * contains a space (L5 precedent: argv array elements are never
 * word-split).
 */
function runStackfoldInit(targetDir: string, timeout: number): Promise<{ code: number; output: string }> {
  const args = [
    STACKFOLD_CLI,
    'init',
    'web-app-standalone-html',
    targetDir,
    '--answer',
    `appName=${BASE_ANSWERS.appName}`,
    '--answer',
    `description=${BASE_ANSWERS.description}`,
    '--answer',
    `author=${BASE_ANSWERS.author}`,
  ];
  return new Promise((resolvePromise) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, timeout }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

describe.skipIf(!RUN_E2E_TESTS)(
  'web-app-standalone-html plugin — launch test (tier 5: real CLI console + real browser, zero post-load network)',
  () => {
    beforeAll(async () => {
      // dist/cli/index.js must be fresh — this is the exact file runStackfoldInit() spawns.
      const build = await execNpm(['run', 'build'], REPO_ROOT, 2 * 60_000);
      expect(build.code, `stackfold build failed (needed for dist/cli/index.js):\n${build.output}`).toBe(0);
    }, 2 * 60_000 + 20_000);

    it(
      '`stackfold init` via the real CLI console produces an index.html a real browser renders correctly, with zero network requests after load',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-standalone-html-e2e-'));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, 30_000);
          expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

          const indexHtmlUrl = `file://${join(projectDir, 'index.html')}`;

          const browser = await chromium.launch();
          try {
            const page = await browser.newPage();

            const consoleErrors: string[] = [];
            page.on('console', (msg) => {
              if (msg.type() === 'error') consoleErrors.push(msg.text());
            });
            page.on('pageerror', (err) => consoleErrors.push(String(err)));

            // Requests are only counted once `loaded` flips true — the
            // initial navigation's own request(s) are expected and not the
            // thing under test; only *post-load* activity would violate the
            // plugin's "no network call after the initial load" contract.
            let loaded = false;
            const requestsAfterLoad: string[] = [];
            page.on('request', (req) => {
              if (loaded) requestsAfterLoad.push(req.url());
            });

            await page.goto(indexHtmlUrl, { waitUntil: 'load' });
            loaded = true;

            // Proving an *absence* of a later network call needs a bounded
            // dwell window, unlike pollUntilStable.ts's L2 pattern (which
            // polls for a *presence* and can return as soon as it appears —
            // there is nothing to poll for here, only something that must
            // keep not happening).
            await page.waitForTimeout(500);

            expect(await page.title()).toBe(BASE_ANSWERS.appName);
            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            expect(consoleErrors).toEqual([]);
            expect(requestsAfterLoad).toEqual([]);
          } finally {
            await browser.close();
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);
