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
 * `web-app-stackfold` plugin — Tier 5 launch check. Merges
 * `web-app-spa-plugin-tier5.test.ts` (real CLI console + real browser via
 * `vite preview`, per framework) and `web-app-standalone-html-plugin-e2e.test.ts`
 * (real CLI console + real browser via `file://`, zero post-load network)
 * into one file covering all 4 `appType` values of the merged plugin — the
 * invariant that matters from both originals is preserved: "spawn the real
 * built binary, not `plugin.buildBlueprint()` in-process".
 *
 * `appType: 'standalone-html'` has no build/`vite preview` step at all
 * (zero `package.json`); it opens the single emitted `index.html` directly
 * via `file://` instead, same as the old `web-app-standalone-html` plugin's
 * own tier-5 check.
 */

const BASE_ANSWERS = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };
const SPA_APP_TYPES = ['spa-react', 'spa-vue', 'spa-vanilla'] as const;

const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'web-app-stackfold plugin — launch test (tier 5): skipped — set STACKFOLD_RUN_E2E_TESTS=1 to run the real CLI-console + real-browser check (needs a Chromium binary installed locally via `npx playwright install chromium`).'
  );
}

/** stackfold's own repo root, derived from this file's location (ESM-safe — no bare __dirname). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STACKFOLD_CLI = join(REPO_ROOT, 'dist/cli/index.js');

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
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
 * non-interactive `--answer` path, the same binary a console user runs.
 *
 * `extraAnswers` (Task 050,
 * .agents/specs/050-web-app-stackfold-intro-content.md §Step 1) —
 * optional, additional `--answer key=value` flags appended after the 4
 * base ones, e.g. `{ includeStackfoldIntro: 'false' }`. Defaults to none
 * — every pre-existing call site keeps behaving exactly as before.
 */
function runStackfoldInit(
  targetDir: string,
  appType: string,
  timeout: number,
  extraAnswers: Record<string, string> = {}
): Promise<{ code: number; output: string }> {
  const args = [
    STACKFOLD_CLI,
    'init',
    'web-app-stackfold',
    targetDir,
    '--answer',
    `appName=${BASE_ANSWERS.appName}`,
    '--answer',
    `description=${BASE_ANSWERS.description}`,
    '--answer',
    `author=${BASE_ANSWERS.author}`,
    '--answer',
    `appType=${appType}`,
    ...Object.entries(extraAnswers).flatMap(([key, value]) => ['--answer', `${key}=${value}`]),
  ];
  return new Promise((resolvePromise) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, timeout }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

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
  'web-app-stackfold plugin — launch test (tier 5: real CLI console + real browser)',
  () => {
    let activePreview: ResultPromise | undefined;

    beforeAll(async () => {
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

    it.each(SPA_APP_TYPES)(
      'appType: "%s" — real CLI init (incl. its own npm install postAction) + npm run build + vite preview + real browser renders the mounted app',
      async (appType) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-stackfold-tier5-${appType}-`));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, appType, 8 * 60_000);
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
            expect(consoleErrors, `appType "${appType}" produced console/page errors: ${consoleErrors.join('; ')}`).toEqual(
              []
            );
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

    // Task 050 (.agents/specs/050-web-app-stackfold-intro-content.md
    // §Step 1) — the opt-out intro block's safety net: `false` must
    // still render exactly as today (no intro image, same bare h1), and
    // `true` (the default) must render the intro image alongside it,
    // with zero console/page errors either way.
    it.each(SPA_APP_TYPES)(
      'appType: "%s" — includeStackfoldIntro: false renders the same bare app as today (no Stackfold intro image)',
      async (appType) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-stackfold-tier5-intro-false-${appType}-`));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, appType, 8 * 60_000, { includeStackfoldIntro: 'false' });
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

            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            expect(await page.locator('img[alt="Stackfold"]').count()).toBe(0);
            expect(consoleErrors, `appType "${appType}" produced console/page errors: ${consoleErrors.join('; ')}`).toEqual(
              []
            );
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

    it.each(SPA_APP_TYPES)(
      'appType: "%s" — includeStackfoldIntro: true (the default) renders the Stackfold intro image alongside the app',
      async (appType) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-stackfold-tier5-intro-true-${appType}-`));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, appType, 8 * 60_000, { includeStackfoldIntro: 'true' });
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

            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            const introImageSrc = await page.locator('img[alt="Stackfold"]').getAttribute('src');
            expect(introImageSrc).toMatch(/^data:image\/webp;base64,/);
            expect(consoleErrors, `appType "${appType}" produced console/page errors: ${consoleErrors.join('; ')}`).toEqual(
              []
            );
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

    it(
      'appType: "standalone-html" — real CLI init produces an index.html a real browser renders correctly, with zero network requests after load',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-tier5-standalone-html-'));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, 'standalone-html', 30_000);
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

            let loaded = false;
            const requestsAfterLoad: string[] = [];
            page.on('request', (req) => {
              if (loaded) requestsAfterLoad.push(req.url());
            });

            await page.goto(indexHtmlUrl, { waitUntil: 'load' });
            loaded = true;

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

    // Task 050 (.agents/specs/050-web-app-stackfold-intro-content.md
    // §Step 1) — the opt-out intro block's safety net, standalone-html's
    // own `file://` + zero-post-load-network invariant unaffected either
    // way (the intro image is a literal data-URI, never a network fetch).
    it(
      'appType: "standalone-html" — includeStackfoldIntro: false renders the same bare index.html as today (no Stackfold intro image)',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-tier5-standalone-html-intro-false-'));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, 'standalone-html', 30_000, { includeStackfoldIntro: 'false' });
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

            let loaded = false;
            const requestsAfterLoad: string[] = [];
            page.on('request', (req) => {
              if (loaded) requestsAfterLoad.push(req.url());
            });

            await page.goto(indexHtmlUrl, { waitUntil: 'load' });
            loaded = true;

            await page.waitForTimeout(500);

            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            expect(await page.locator('img[alt="Stackfold"]').count()).toBe(0);
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

    it(
      'appType: "standalone-html" — includeStackfoldIntro: true (the default) renders the Stackfold intro image, still with zero network requests after load',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-tier5-standalone-html-intro-true-'));
        try {
          const projectDir = join(root, 'generated');

          const init = await runStackfoldInit(projectDir, 'standalone-html', 30_000, { includeStackfoldIntro: 'true' });
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

            let loaded = false;
            const requestsAfterLoad: string[] = [];
            page.on('request', (req) => {
              if (loaded) requestsAfterLoad.push(req.url());
            });

            await page.goto(indexHtmlUrl, { waitUntil: 'load' });
            loaded = true;

            await page.waitForTimeout(500);

            expect((await page.locator('h1').textContent())?.trim()).toBe(BASE_ANSWERS.appName);
            const introImageSrc = await page.locator('img[alt="Stackfold"]').getAttribute('src');
            expect(introImageSrc).toMatch(/^data:image\/webp;base64,/);
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
