import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `node-http-api-stackfold` plugin — Tier 5 launch check. Opt-in, gated like
 * `web-app-stackfold-plugin-tier5.test.ts`
 * — spawns the REAL built binary (`dist/cli/index.js`), generates each of
 * the 8 boolean combinations in its own temp dir, then runs a real `npm
 * install`/`typecheck`/`build`/`test` on the generated project. For the
 * minimal (all-false) and full (all-true) combinations it also starts the
 * built server on a free port and probes `/health` and `/ready` — the
 * proof that the devDependency majors pinned in `package.json.hbs`
 * (TypeScript 6.x/vitest 5.x/`@types/node` ^22) work for the generated project.
 *
 * Docker is NOT exercised here (it is not assumed to be installed); the
 * `Dockerfile` content is verified by
 * `scaffold.test.ts` (a real blueprint assertion) and by reading.
 */

const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'node-http-api-stackfold plugin — launch test (tier 5): skipped — set STACKFOLD_RUN_E2E_TESTS=1 to run the real CLI + npm install/typecheck/build/test matrix.'
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

/** Spawns the real, built `stackfold` CLI — not `plugin.buildBlueprint()` — the same binary a console user runs. */
function runStackfoldInit(
  targetDir: string,
  answers: { cors: boolean; docker: boolean; exampleResource: boolean },
  timeout: number
): Promise<{ code: number; output: string }> {
  const args = [
    STACKFOLD_CLI,
    'init',
    'node-http-api-stackfold',
    targetDir,
    '--answer',
    'projectName=my-service',
    '--answer',
    'description=An HTTP microservice',
    '--answer',
    'port=3000',
    '--answer',
    `cors=${answers.cors}`,
    '--answer',
    `docker=${answers.docker}`,
    '--answer',
    `exampleResource=${answers.exampleResource}`,
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
          reject(new Error(`server never answered at ${url} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

function httpGetJson(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, reject) => {
    httpGet(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      res.on('end', () => {
        try {
          resolvePromise({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

const BOOLEAN_COMBINATIONS: Array<{ cors: boolean; docker: boolean; exampleResource: boolean }> = [
  { cors: false, docker: false, exampleResource: false },
  { cors: true, docker: false, exampleResource: false },
  { cors: false, docker: true, exampleResource: false },
  { cors: false, docker: false, exampleResource: true },
  { cors: true, docker: true, exampleResource: false },
  { cors: true, docker: false, exampleResource: true },
  { cors: false, docker: true, exampleResource: true },
  { cors: true, docker: true, exampleResource: true },
];

describe.skipIf(!RUN_E2E_TESTS)('node-http-api-stackfold plugin — launch test (tier 5: real CLI + real npm matrix)', () => {
  let activeServerPid: number | undefined;

  afterEach(async () => {
    if (activeServerPid !== undefined) {
      try {
        process.kill(activeServerPid);
      } catch {
        // already exited — nothing to clean up
      }
      activeServerPid = undefined;
    }
  });

  it.each(BOOLEAN_COMBINATIONS)(
    'cors=$cors docker=$docker exampleResource=$exampleResource — real CLI init + npm install/typecheck/build/test',
    async (combo) => {
      const root = await mkdtemp(
        join(tmpdir(), `stackfold-node-http-api-tier5-${combo.cors}-${combo.docker}-${combo.exampleResource}-`)
      );
      try {
        const projectDir = join(root, 'generated');

        const init = await runStackfoldInit(projectDir, combo, 60_000);
        expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

        const install = await execNpm(['install'], projectDir, 3 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const typecheck = await execNpm(['run', 'typecheck'], projectDir, 60_000);
        expect(typecheck.code, `npm run typecheck failed:\n${typecheck.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const test = await execNpm(['test'], projectDir, 2 * 60_000);
        expect(test.code, `npm test failed:\n${test.output}`).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    5 * 60_000
  );

  it(
    'minimal (all false) — the built server answers /health and /ready',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-node-http-api-tier5-probe-minimal-'));
      try {
        const projectDir = join(root, 'generated');
        const port = await getFreePort();

        const init = await runStackfoldInit(projectDir, { cors: false, docker: false, exampleResource: false }, 60_000);
        expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

        const install = await execNpm(['install'], projectDir, 3 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const child = execFile(process.execPath, ['dist/index.js'], {
          cwd: projectDir,
          env: { ...process.env, PORT: String(port) },
        });
        activeServerPid = child.pid;

        try {
          await waitForServer(`http://127.0.0.1:${port}/health`, 20_000);

          const health = await httpGetJson(`http://127.0.0.1:${port}/health`);
          expect(health.status).toBe(200);
          expect(health.body).toEqual({ status: 'ok' });

          const ready = await httpGetJson(`http://127.0.0.1:${port}/ready`);
          expect(ready.status).toBe(200);
          expect(ready.body).toEqual({ status: 'ready' });
        } finally {
          child.kill();
          activeServerPid = undefined;
        }
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    3 * 60_000
  );

  it(
    'full (all true) — the built server answers /health and /ready',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-node-http-api-tier5-probe-full-'));
      try {
        const projectDir = join(root, 'generated');
        const port = await getFreePort();

        const init = await runStackfoldInit(projectDir, { cors: true, docker: true, exampleResource: true }, 60_000);
        expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

        const install = await execNpm(['install'], projectDir, 3 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const child = execFile(process.execPath, ['dist/index.js'], {
          cwd: projectDir,
          env: { ...process.env, PORT: String(port) },
        });
        activeServerPid = child.pid;

        try {
          await waitForServer(`http://127.0.0.1:${port}/health`, 20_000);

          const health = await httpGetJson(`http://127.0.0.1:${port}/health`);
          expect(health.status).toBe(200);
          expect(health.body).toEqual({ status: 'ok' });

          const ready = await httpGetJson(`http://127.0.0.1:${port}/ready`);
          expect(ready.status).toBe(200);
          expect(ready.body).toEqual({ status: 'ready' });
        } finally {
          child.kill();
          activeServerPid = undefined;
        }
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    3 * 60_000
  );
});
