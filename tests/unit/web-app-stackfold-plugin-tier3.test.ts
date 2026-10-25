import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition from '../../src/plugins/web-app-stackfold/scaffold.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';

/**
 * `web-app-stackfold` plugin — generation integrity (tier 3: real emitted
 * code, no network). Ported from `web-app-spa-plugin-tier3.test.ts`
 * (`initial_scaffold.md`'s Cycle 1 "Test strategy" item 4, extended by
 * Cycle 2's own item 5): scaffold each SPA `appType` into a real temp
 * directory via `NodeFileWriter`, then run `tsc --noEmit` over the emitted
 * `src/`. `appType: 'standalone-html'` has no TypeScript to type-check at
 * all (same as the old `web-app-standalone-html` plugin), so it is not
 * part of this tier, same as before.
 *
 * KNOWN, DOCUMENTED GAP (carried over unchanged): `tsc --noEmit` cannot
 * type-check `.vue` single-file components at all. The `appType:
 * 'spa-vue'` case below therefore scopes its `include` to the emitted
 * `.ts` files only (`src/main.ts`, `src/App.test.ts`), explicitly
 * excluding `src/App.vue`'s own template/script-block types.
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

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

const requireFromHere = createRequire(import.meta.url);

function runTsc(tscBin: string, config: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [tscBin, '-p', config, '--pretty', 'false'], (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

const posix = (p: string): string => p.split(sep).join('/');

async function scaffold(answers: Answers, root: string): Promise<string> {
  const projectDir = join(root, 'generated');
  const writer = new NodeFileWriter();
  await writer.ensureEmptyDir(projectDir);
  const blueprint = await buildBlueprintFor(answers);
  for (const file of blueprint.files) {
    await writer.writeFile(join(projectDir, file.path), file.content);
  }
  return projectDir;
}

const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');

describe('web-app-stackfold plugin — generation integrity (tier 3: real emitted code, no network)', () => {
  it('appType: "spa-react" — scaffolds into a real temp dir and type-checks the emitted src/ with tsc --noEmit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-react-'));
    try {
      const projectDir = await scaffold({ ...ANSWERS, appType: 'spa-react' }, root);

      const reactTypesPkg = requireFromHere.resolve('@types/react/package.json');
      const reactDomTypesPkg = requireFromHere.resolve('@types/react-dom/package.json');
      const nodeTypesPkg = requireFromHere.resolve('@types/node/package.json');
      const reactTypesDir = dirname(reactTypesPkg);
      const reactDomTypesDir = dirname(reactDomTypesPkg);
      const vitestPkg = requireFromHere.resolve('vitest/package.json');
      const testingLibraryReactPkg = requireFromHere.resolve('@testing-library/react/package.json');
      const jestDomPkg = requireFromHere.resolve('@testing-library/jest-dom/package.json');

      const config = join(root, 'tsconfig.typecheck.json');
      await writeFile(
        config,
        JSON.stringify({
          extends: posix(join(projectDir, 'tsconfig.json')),
          compilerOptions: {
            noEmit: true,
            typeRoots: [
              posix(dirname(dirname(reactTypesPkg))),
              posix(dirname(dirname(reactDomTypesPkg))),
              posix(dirname(dirname(nodeTypesPkg))),
            ],
            paths: {
              react: [posix(join(reactTypesDir, 'index.d.ts'))],
              'react/jsx-runtime': [posix(join(reactTypesDir, 'jsx-runtime.d.ts'))],
              'react-dom/client': [posix(join(reactDomTypesDir, 'client.d.ts'))],
              vitest: [posix(join(dirname(vitestPkg), 'dist', 'index.d.ts'))],
              '@testing-library/react': [posix(join(dirname(testingLibraryReactPkg), 'types', 'index.d.ts'))],
              '@testing-library/jest-dom/vitest': [posix(join(dirname(jestDomPkg), 'types', 'vitest.d.ts'))],
            },
          },
          include: [posix(join(projectDir, 'src/**/*.ts')), posix(join(projectDir, 'src/**/*.tsx'))],
        })
      );

      const result = await runTsc(tscBin, config);
      expect(result.output, `tsc --noEmit failed:\n${result.output}`).toBe('');
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    'appType: "spa-vue" — scaffolds into a real temp dir and type-checks the emitted .ts files with tsc --noEmit (App.vue itself is NOT type-checked — known gap, see file-level doc comment)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-vue-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, appType: 'spa-vue' }, root);

        const rootNodeModules = dirname(dirname(requireFromHere.resolve('vue/package.json')));
        const vitestPkg = requireFromHere.resolve('vitest/package.json');
        const jestDomPkg = requireFromHere.resolve('@testing-library/jest-dom/package.json');

        const config = join(root, 'tsconfig.typecheck.json');
        await writeFile(
          config,
          JSON.stringify({
            extends: posix(join(projectDir, 'tsconfig.json')),
            compilerOptions: {
              noEmit: true,
              paths: {
                vitest: [posix(join(dirname(vitestPkg), 'dist', 'index.d.ts'))],
                '@testing-library/jest-dom/vitest': [posix(join(dirname(jestDomPkg), 'types', 'vitest.d.ts'))],
                vue: [posix(join(rootNodeModules, 'vue'))],
                '@testing-library/vue': [posix(join(rootNodeModules, '@testing-library', 'vue'))],
              },
            },
            include: [posix(join(projectDir, 'src/**/*.ts'))],
          })
        );

        const result = await runTsc(tscBin, config);
        expect(result.output, `tsc --noEmit failed:\n${result.output}`).toBe('');
        expect(result.code).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it(
    'appType: "spa-vanilla" — scaffolds into a real temp dir and type-checks the emitted src/ with tsc --noEmit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-vanilla-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, appType: 'spa-vanilla' }, root);

        const nodeTypesPkg = requireFromHere.resolve('@types/node/package.json');
        const vitestPkg = requireFromHere.resolve('vitest/package.json');
        const jestDomPkg = requireFromHere.resolve('@testing-library/jest-dom/package.json');

        const config = join(root, 'tsconfig.typecheck.json');
        await writeFile(
          config,
          JSON.stringify({
            extends: posix(join(projectDir, 'tsconfig.json')),
            compilerOptions: {
              noEmit: true,
              typeRoots: [posix(dirname(dirname(nodeTypesPkg)))],
              paths: {
                vitest: [posix(join(dirname(vitestPkg), 'dist', 'index.d.ts'))],
                '@testing-library/jest-dom/vitest': [posix(join(dirname(jestDomPkg), 'types', 'vitest.d.ts'))],
              },
            },
            include: [posix(join(projectDir, 'src/**/*.ts'))],
          })
        );

        const result = await runTsc(tscBin, config);
        expect(result.output, `tsc --noEmit failed:\n${result.output}`).toBe('');
        expect(result.code).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});

/**
 * `web-app-stackfold` plugin — `vitest.config.ts` really inherits
 * `@vitejs/plugin-vue` via `mergeConfig()` (tier 3: real emitted code, no
 * network). Ported from `web-app-spa-plugin-tier3.test.ts`'s own
 * regression test for the same concern (`backlog.md`'s former item 1) —
 * the framework-agnostic `vitest` fragment's `vitest.config.ts.hbs` must
 * still re-apply the chosen framework's own `vite.config.ts` plugins.
 */
describe('web-app-stackfold plugin — vitest.config.ts really inherits @vitejs/plugin-vue via mergeConfig (tier 3: real emitted code, no network)', () => {
  it(
    'appType: "spa-vue" — the real, executed vitest.config.ts merges in the real @vitejs/plugin-vue instance from vite.config.ts, and keeps its own test.environment',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-vue-mergeconfig-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, appType: 'spa-vue' }, root);

        await symlink(join(process.cwd(), 'node_modules'), join(projectDir, 'node_modules'), 'junction');

        for (const name of ['vite.config.ts', 'vitest.config.ts']) {
          const source = await readFile(join(projectDir, name), 'utf8');
          const { outputText, diagnostics } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
            reportDiagnostics: true,
            fileName: name,
          });
          expect(diagnostics ?? []).toEqual([]);
          await writeFile(join(projectDir, name.replace(/\.ts$/, '.js')), outputText);
        }

        const mod = (await import(pathToFileURL(join(projectDir, 'vitest.config.js')).href)) as {
          default: { plugins?: unknown; test?: { environment?: string } };
        };
        const config = mod.default;
        const plugins = (Array.isArray(config.plugins) ? config.plugins : []).flat(Infinity) as Array<{
          name?: unknown;
        }>;

        expect(plugins.some((p) => p && p.name === 'vite:vue')).toBe(true);
        expect(config.test?.environment).toBe('jsdom');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
