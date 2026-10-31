import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition from '../../src/plugins/web-app-stackfold/scaffold.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';

/**
 * `web-app-stackfold` plugin — build integrity (tier 4: network, opt-in).
 * Ported from `web-app-spa-plugin-e2e.test.ts`
 * (`initial_scaffold.md`'s Cycle 1 "Test strategy" item 5, extended by
 * Cycle 2's own item 6): scaffold each SPA `appType` into a real temp dir,
 * then run the real pipeline a generated project's own user would run —
 * `npm install`, `npm run build`, `npm run test` — and assert every step
 * exits 0. `appType: 'standalone-html'` has no build pipeline at all (zero
 * `package.json`, zero `postActions`), so it has no equivalent tier-4
 * check — same as the old `web-app-standalone-html` plugin.
 *
 * Gated the same way `web-app-spa-plugin-e2e.test.ts` was: opt-in only,
 * behind `STACKFOLD_RUN_NETWORK_TESTS`.
 */
const evaluator = new JsonLogicExpressionEvaluator();
const plugin: StackfoldPlugin = compileScaffold(definition as ScaffoldDefinition, evaluator);

async function buildBlueprintFor(answers: Answers) {
  const live = { ...answers };
  for (const handler of plugin.hooks?.preInit ?? []) {
    await handler(
      {
        prompter: { async ask() { return {}; } },
        fileWriter: {
          async ensureEmptyDir() {},
          async writeFile() {},
          async readFile() { return undefined; },
          async overwriteFile() {},
        },
        processRunner: { async run() {} },
      },
      live
    );
  }
  return plugin.buildBlueprint(live);
}

const BASE_ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };
const APP_TYPES = ['spa-react', 'spa-vue', 'spa-vanilla'] as const;

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
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
    'web-app-stackfold plugin — build integrity (tier 4): skipped — set STACKFOLD_RUN_NETWORK_TESTS=1 to run the real `npm install` + `npm run build` + `npm run test` check.'
  );
}

describe.skipIf(!RUN_NETWORK_TESTS)(
  'web-app-stackfold plugin — build integrity (tier 4: real npm install + build + test)',
  () => {
    it.each(APP_TYPES)(
      'appType: "%s" — npm install + npm run build + npm run test all succeed against the real, registry-resolved dependency graph',
      async (appType) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-stackfold-e2e-${appType}-`));
        try {
          const projectDir = join(root, 'generated');
          const writer = new NodeFileWriter();
          await writer.ensureEmptyDir(projectDir);
          const blueprint = await buildBlueprintFor({ ...BASE_ANSWERS, appType });
          for (const file of blueprint.files) {
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

    // Task 050 (.agents/specs/050-web-app-stackfold-intro-content.md
    // §Step 1) — the opt-out intro block's safety net: `false` must be
    // byte-identical to today's (flag-omitted) output.
    it.each(APP_TYPES)(
      'appType: "%s" — includeStackfoldIntro: false produces byte-identical scaffolded files to today\'s (flag-omitted) output',
      async (appType) => {
        const withFlagFalse = await buildBlueprintFor({ ...BASE_ANSWERS, appType, includeStackfoldIntro: false });
        const flagOmitted = await buildBlueprintFor({ ...BASE_ANSWERS, appType });
        expect(withFlagFalse.files.map((f) => ({ path: f.path, content: f.content.toString() }))).toEqual(
          flagOmitted.files.map((f) => ({ path: f.path, content: f.content.toString() }))
        );
      }
    );

    it.each(APP_TYPES)(
      'appType: "%s" — includeStackfoldIntro: true (the default) still succeeds through npm install + npm run build + npm run test, with the intro block present',
      async (appType) => {
        const root = await mkdtemp(join(tmpdir(), `stackfold-web-app-stackfold-e2e-intro-${appType}-`));
        try {
          const projectDir = join(root, 'generated');
          const writer = new NodeFileWriter();
          await writer.ensureEmptyDir(projectDir);
          const blueprint = await buildBlueprintFor({ ...BASE_ANSWERS, appType, includeStackfoldIntro: true });
          const mainDisplayPath = appType === 'spa-react' ? 'src/App.tsx' : appType === 'spa-vue' ? 'src/App.vue' : 'src/main.ts';
          const mainDisplayContent = blueprint.files.find((f) => f.path === mainDisplayPath)?.content.toString();
          expect(mainDisplayContent).toContain('data:image/webp;base64,');
          for (const file of blueprint.files) {
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
  }
);
