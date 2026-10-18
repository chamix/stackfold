import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { execa, type ResultPromise } from 'execa';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `web-app-spa` plugin — Tier 5 launch check
 * (`.agents/specs/web-app-spa-tier5-launch-harness.md`, approved 2026-10-18).
 *
 * Adapted from the CLI-console pattern (`electron-ts-plugin-e2e.test.ts` /
 * `cli-console-e2e-harness.md`, extended to `web-app-standalone-html` in
 * `web-app-standalone-html-plugin-e2e.test.ts` /
 * `web-standalone-html-e2e-harness.md`): the invariant that matters is
 * "spawn the real built binary, not `plugin.buildBlueprint()` in-process" —
 * preserved here.
 *
 * This plugin already has a Tier 4 check
 * (`web-app-spa-plugin-e2e.test.ts`, pre-existing) that runs a real
 * `npm install && npm run build && npm test` per framework, gated by
 * `STACKFOLD_RUN_NETWORK_TESTS` — but never opens a browser against the
 * real build output. That gap is this file.
 *
 * Unlike `web-app-standalone-html` (single static `index.html`, opened
 * directly via `file://`, no server), Vite's default `base: '/'` means
 * this plugin's built `dist/index.html` references absolute asset paths
 * (`/assets/...`) that do not resolve under `file://` — a real static
 * server is required. `vite preview` is used (already a devDependency of
 * every generated project via `vite-react.ts`/`vite-vue.ts`/
 * `vite-vanilla.ts` — no new dependency), managed via `execa` (already a
 * root **production** dependency, used by the real `ProcessRunner` adapter
 * and by `scripts/e2e-playground.mjs`) rather than raw `child_process`, for
 * reliable cross-platform start/kill of a long-running child process.
 *
 * File named `*-tier5`, not `*-e2e`, because `-e2e` is already taken by
 * this plugin's pre-existing (non-browser) Tier 4 file — see the spec's
 * "Naming-collision resolution".
 */

const BASE_ANSWERS = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };
const FRAMEWORKS = ['react', 'vue', 'vanilla'] as const;

const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'web-app-spa plugin — launch test (tier 5): skipped — set STACKFOLD_RUN_E2E_TESTS=1 to run the real CLI-console + real-browser check (needs a Chromium binary installed locally via `npx playwright install chromium`, already required by test/023).'
  );
}

/** stackfold's own repo root, derived from this file's location (ESM-safe — no bare __dirname). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STACKFOLD_CLI = join(REPO_ROOT, 'dist/cli/index.js');

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
  // On Windows `npm` resolves to a `.cmd` shim, which execFile cannot spawn
  // directly (EINVAL). Route through `cmd.exe /c` explicitly (fixed args,
  // no untrusted input) rather than the `shell: true` option, which would
  // concatenate args into an unescaped string. (Same shape as the other two
  // Tier 5 files' own `execNpm` — duplicated, not shared, per this tier's
  // own spec's "no shared helper" decision.)
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
 * contains a space (argv array elements are never word-split).
 */
function runStackfoldInit(targetDir: string, framework: string, timeout: number): Promise<{ code: number; output: string }> {
  const args = [
    STACKFOLD_CLI,
    'init',
    'web-app-spa',
    targetDir,
    '--answer',
    `appName=${BASE_ANSWERS.appName}`,
    '--answer',
    `description=${BASE_ANSWERS.description}`,
    '--answer',
    `author=${BASE_ANSWERS.author}`,
    '--answer',
    `framework=${framework}`,
  ];
  return new Promise((resolvePromise) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, timeout }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/**
 * A one-shot `listen(0)` + immediate `close()` to get an OS-assigned free
 * port, then handed to `vite preview --port <n> --strictPort`. A tiny
 * TOCTOU window exists between this port being released and `vite preview`
 * binding it — accepted here, consistent with `--strictPort` failing loudly
 * (never silently switching ports) if that rare race is ever hit.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => (port !== null ? resolvePromise(port) : reject(new Error('could not determine a free port'))));
    });
  });
}

/** Polls `url` with a plain GET until it responds or `timeoutMs` elapses. */
function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = (): void => {
      const req = httpGet(url, (res) => {
        res.resume();
        resolvePromise();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`vite preview never answered at ${url} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

describe.skipIf(!RUN_E2E_TESTS)(
  'web-app-spa plugin — launch test (tier 5: real CLI console + real browser via vite preview)',
  () => {
    // Tracks the one `vite preview` child the currently-running test started,
    // so a failed assertion still kills it via `afterEach` instead of leaking
    // a server process across test cases.
    let activePreview: ResultPromise | undefined;

    beforeAll(async () => {
      // dist/cli/index.js must be fresh — this is the exact file runStackfoldInit() spawns.
      const build = await execNpm(['run', 'build'], REPO_ROOT, 3 * 60_000);
      expect(build.code, `stackfold build failed (needed for dist/cli/index.js):\n${build.output}`).toBe(0);
    }, 3 * 60_000 + 20_000);

    afterEach(async () => {
      if (activePreview) {
        activePreview.kill();
        await activePreview.catch(() => undefined);
        activePreview = undefined;
      }
    });

    it.each(FRAMEWORKS)(
      'framework: "%s" — real CLI init (incl. its own npm install postAction) + npm run build + vite preview + real browser renders the mounted app',
      async (framework) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-spa-tier5-${framework}-`));
        try {
          const projectDir = join(root, 'generated');

          // `web-app-spa`'s framework fragments (`vite-react.ts`/`vite-vue.ts`/
          // `vite-vanilla.ts`) each declare a `{ kind: 'npm-install' }`
          // postAction (orchestrator.ts's `toCommand()` maps it to a plain
          // `npm install`), so `stackfold init` itself already performs a
          // real install — unlike `web-app-standalone-html`, which has zero
          // postActions. A separate explicit `npm install` step here would
          // be redundant (double network I/O for no benefit), and the
          // timeout below must cover that real install, not just file
          // generation (confirmed empirically: 30s, enough for
          // `web-app-standalone-html`'s postAction-free init, undershoots
          // here and failed for real on first run against this plugin).
          const init = await runStackfoldInit(projectDir, framework, 8 * 60_000);
          expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

          const buildProject = await execNpm(['run', 'build'], projectDir, 2 * 60_000);
          expect(buildProject.code, `npm run build failed:\n${buildProject.output}`).toBe(0);

          const port = await getFreePort();
          const previewUrl = `http://localhost:${port}/`;
          activePreview = execa('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
            cwd: projectDir,
            reject: false,
          });

          await waitForServer(previewUrl, 20_000);

          const browser = await chromium.launch();
          try {
            const page = await browser.newPage();

            const consoleErrors: string[] = [];
            page.on('console', (msg) => {
              if (msg.type() === 'error') consoleErrors.push(msg.text());
            });
            page.on('pageerror', (err) => consoleErrors.push(String(err)));

            await page.goto(previewUrl, { waitUntil: 'load' });

            expect(await page.title()).toBe(BASE_ANSWERS.appName);
            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            expect(consoleErrors, `framework "${framework}" produced console/page errors: ${consoleErrors.join('; ')}`).toEqual([]);
          } finally {
            await browser.close();
          }
        } finally {
          if (activePreview) {
            activePreview.kill();
            await activePreview.catch(() => undefined);
            activePreview = undefined;
          }
          await rm(root, { recursive: true, force: true });
        }
      },
      12 * 60_000
    );
  }
);
