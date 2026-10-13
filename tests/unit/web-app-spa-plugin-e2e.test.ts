import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers } from '../../src/core/types.js';

/**
 * `web-app-spa` plugin — build integrity (tier 4: network, opt-in).
 * `.agents/specs/initial_scaffold.md`'s Cycle 1 "Test strategy" item 5:
 * scaffold the flavor into a real temp dir, then run the real pipeline a
 * generated project's own user would run — `npm install` (no
 * `--ignore-scripts`: the point of this tier is proving the real,
 * registry-resolved dependency graph actually installs and works, not
 * just that the build tool itself runs), `npm run build`, `npm run test`
 * — and assert every step exits 0.
 *
 * Gated the same way `tests/unit/electron-ts-plugin.test.ts`'s own tier-4
 * "build integrity" section and `tests/unit/electron-ts-plugin-e2e.test.ts`
 * are: opt-in only, behind an explicit env var, so this suite never
 * silently runs real network I/O nor silently flakes in a
 * network-restricted environment/CI run. `STACKFOLD_RUN_NETWORK_TESTS` is
 * reused verbatim (not a new var name) — this check is a network/build
 * check like `electron-ts-plugin.test.ts`'s own tier-4 test, not a
 * display-requiring Playwright launch like
 * `electron-ts-plugin-e2e.test.ts`'s `STACKFOLD_RUN_E2E_TESTS` tier.
 */
const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
  // On Windows `npm` resolves to a `.cmd` shim, which execFile cannot spawn
  // directly (EINVAL). Route through `cmd.exe /c` explicitly (fixed args,
  // no untrusted input) rather than the `shell: true` option, which would
  // concatenate args into an unescaped string.
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : ['npm', args];
  return new Promise((resolvePromise) => {
    execFile(cmd, cmdArgs, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

const RUN_NETWORK_TESTS = process.env['STACKFOLD_RUN_NETWORK_TESTS'] === '1';
if (!RUN_NETWORK_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'web-app-spa plugin — build integrity (tier 4): skipped — set STACKFOLD_RUN_NETWORK_TESTS=1 to run the real `npm install` + `npm run build` + `npm run test` check.'
  );
}

describe.skipIf(!RUN_NETWORK_TESTS)('web-app-spa plugin — build integrity (tier 4: real npm install + build + test)', () => {
  it(
    'npm install + npm run build + npm run test all succeed against the real, registry-resolved dependency graph',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-e2e-'));
      try {
        const projectDir = join(root, 'generated');
        const writer = new NodeFileWriter();
        await writer.ensureEmptyDir(projectDir);
        for (const file of webAppSpaPlugin.buildBlueprint(ANSWERS).files) {
          await writer.writeFile(join(projectDir, file.path), file.content);
        }

        const install = await execNpm(['install', '--no-audit', '--no-fund'], projectDir, 8 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 2 * 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const unitTests = await execNpm(['test'], projectDir, 2 * 60_000);
        expect(unitTests.code, `npm test failed:\n${unitTests.output}`).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10 * 60_000
  );
});
