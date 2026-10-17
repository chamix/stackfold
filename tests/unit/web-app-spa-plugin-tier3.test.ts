import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers } from '../../src/core/types.js';

/**
 * `web-app-spa` plugin — generation integrity (tier 3: real emitted code,
 * no network). `.agents/specs/initial_scaffold.md`'s Cycle 1 "Test
 * strategy" item 4 (extended by Cycle 2's own item 5, "scaffold all three
 * `framework` values into real temp dirs"): scaffold the flavor into a
 * real temp directory via `NodeFileWriter` (the same `mkdtemp(tmpdir(),
 * ...)` lifecycle `tests/unit/electron-ts-plugin.test.ts`'s own tier-3
 * section uses), then run `tsc --noEmit` over the emitted `src/`.
 *
 * This is a real, strict type-check (`tsc --noEmit`, not a syntax-only
 * `ts.transpileModule` pass) — the review that mandated this test
 * (`.agents/specs/review_report.md`, "web-app plugin family Cycle 1") was
 * explicit that exactly this kind of generation-integrity check "would
 * very plausibly have caught Blocking item 1 directly" (the JSX-injection
 * gap fixed elsewhere in this same follow-up). A weaker, parse-only check
 * would not carry that same regression-catching weight.
 *
 * KNOWN, DOCUMENTED GAP (Cycle 2 technical spec §3): `tsc --noEmit` cannot
 * type-check `.vue` single-file components at all — it only sees `.ts`
 * files. The `framework: 'vue'` case below therefore scopes its `include`
 * to the emitted `.ts` files only (`src/main.ts`, `src/App.test.ts`),
 * explicitly excluding `src/App.vue`'s own template/script-block types.
 * Adding `vue-tsc` to close that gap is deferred per regla de tres (not
 * silently fixed, not silently ignored — see the spec).
 */
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
  for (const file of webAppSpaPlugin.buildBlueprint(answers).files) {
    await writer.writeFile(join(projectDir, file.path), file.content);
  }
  return projectDir;
}

const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');

describe('web-app-spa plugin — generation integrity (tier 3: real emitted code, no network)', () => {
  it('framework: "react" — scaffolds into a real temp dir and type-checks the emitted src/ with tsc --noEmit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-react-'));
    try {
      const projectDir = await scaffold({ ...ANSWERS, framework: 'react' }, root);

      // The fixture project has no node_modules of its own (no network
      // tier): a test-only tsconfig extends the emitted one and resolves
      // only what this repo's own devDependencies can provide. Mirrors
      // `electron-ts-plugin.test.ts`'s own tier-3 mechanism (`typeRoots`
      // pointing at the real `@types` directory, plus explicit `paths`
      // entries for packages that ship their own types outside `@types`):
      // `react`, `react-dom`, `@testing-library/react`,
      // `@testing-library/jest-dom` and their `@types/*` counterparts are
      // all real root devDependencies of stackfold itself (type-resolution
      // use only — stackfold's own runtime code never imports them).
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
    'framework: "vue" — scaffolds into a real temp dir and type-checks the emitted .ts files with tsc --noEmit (App.vue itself is NOT type-checked — known gap, see file-level doc comment)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-vue-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, framework: 'vue' }, root);

        // Narrowed per `.agents/backlog.md`'s own Should-fix (Cycle 2
        // review): this block previously fell back to a single wildcard
        // `'*'` `paths` entry mapping *every* bare specifier into
        // stackfold's root `node_modules`, justified at the time by
        // `@testing-library/vue`'s own type declarations pulling in a
        // long transitive chain (`@vue/test-utils`,
        // `@testing-library/dom`, `pretty-format`,
        // `vue-component-type-helpers`, `type-fest`, ...). Empirically
        // re-verified here (by removing the wildcard and reading `tsc`'s
        // own "Cannot find module" output): with `include` scoped to only
        // `main.ts`/`App.test.ts` (never `App.vue` — see the known gap
        // below), `tsc --noEmit` only ever needs to resolve the two
        // specifiers these two files import directly, `vue` and
        // `@testing-library/vue` — it never has to fully elaborate that
        // package's own internal transitive chain for this limited
        // surface. Two explicit entries below replace the wildcard,
        // mapping only those two real root devDependencies — same
        // "type-resolution only, never imported by stackfold's own
        // runtime code" guarantee the react block's explicit mapping
        // gives, now equally precise for vue. `App.vue` itself is never
        // in `include` below — only the two real `.ts` files (`main.ts`,
        // `App.test.ts`) are, which is exactly the scope the known gap
        // (file-level doc comment above) documents.
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
                // `vitest` and `@testing-library/jest-dom/vitest`'s real
                // `.d.ts` files live under subpaths their own package.json
                // "exports" maps resolve, not at a location a bare
                // directory mapping can reach by naive path substitution —
                // same explicit entries the react block above needs, for
                // the same reason.
                vitest: [posix(join(dirname(vitestPkg), 'dist', 'index.d.ts'))],
                '@testing-library/jest-dom/vitest': [posix(join(dirname(jestDomPkg), 'types', 'vitest.d.ts'))],
                // The two bare specifiers `main.ts`/`App.test.ts` actually
                // import — see the file-level narrowing note above this
                // block for why these two replace the former wildcard.
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
    'framework: "vanilla" — scaffolds into a real temp dir and type-checks the emitted src/ with tsc --noEmit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-vanilla-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, framework: 'vanilla' }, root);

        // No framework-specific package at all for this path — the only
        // non-`@types/node` resolution `src/main.ts`/`src/App.test.ts`
        // need is `vitest` itself (framework-agnostic, contributed by the
        // `vitest` fragment).
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
 * `web-app-spa` plugin — `vitest.config.ts` really inherits
 * `@vitejs/plugin-vue` via `mergeConfig()` (tier 3: real emitted code, no
 * network). Regression test for `.agents/backlog.md`'s former item 1
 * (Cycle 2 review `Should-fix`, `RUN_LOG.md` 2026-10-15 entry): the real
 * `mergeConfig()` fix (`vitest.ts`'s doc comment explains why
 * `vitest.config.ts` must re-apply `vite.config.ts`'s own plugins — Vite
 * and Vitest resolve the two config files independently, so `vitest run`
 * never falls back to `vite.config.ts`'s `plugins` on its own) was
 * previously covered only by the network-gated tier-4 suite
 * (`web-app-spa-plugin-e2e.test.ts`, `STACKFOLD_RUN_NETWORK_TESTS=1`),
 * with zero coverage in the default tier.
 *
 * Executes the *actual* generated `vite.config.ts`/`vitest.config.ts`
 * content for real (same `ts.transpileModule` + dynamic `import()`
 * technique `electron-ts-plugin-tier2.test.ts`'s own self-healing section
 * uses for "real emitted code"), rather than re-deriving the same shape
 * by hand-calling `mergeConfig()`/`vue()` directly — a hand-rolled
 * reconstruction would not catch a typo or omission in the fragment's own
 * emitted text.
 *
 * To resolve the generated files' own bare imports (`vite`,
 * `vitest/config`, `@vitejs/plugin-vue`, `vue`) without a real `npm
 * install` — keeping this tier-3 (no network), not tier-4 — a
 * `node_modules` directory junction is created inside the scaffolded
 * project, pointing at stackfold's own root `node_modules`: all four
 * packages are already real root devDependencies of stackfold itself
 * (confirmed by `web-app-spa-plugin-vue.test.ts`'s own `package.json`
 * assertion), so this resolves the exact same installed packages a real
 * `npm install` in the generated project would have fetched, without
 * fetching anything. `fs.symlink(..., 'junction')` is used (not a plain
 * directory symlink) for Windows compatibility without elevated
 * privileges — confirmed empirically against both the fix (plugin found)
 * and, via fault injection against a reverted `vitest.ts`, the original
 * bug (plugin missing, assertion fails) before this test was added.
 */
describe('web-app-spa plugin — vitest.config.ts really inherits @vitejs/plugin-vue via mergeConfig (tier 3: real emitted code, no network)', () => {
  it(
    'framework: "vue" — the real, executed vitest.config.ts merges in the real @vitejs/plugin-vue instance from vite.config.ts, and keeps its own test.environment',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-vue-mergeconfig-'));
      try {
        const projectDir = await scaffold({ ...ANSWERS, framework: 'vue' }, root);

        // No real `npm install`: junction stackfold's own node_modules in,
        // so the generated files' bare imports resolve to packages
        // already installed here (see file-level doc comment above).
        await symlink(join(process.cwd(), 'node_modules'), join(projectDir, 'node_modules'), 'junction');

        for (const name of ['vite.config.ts', 'vitest.config.ts']) {
          const source = await readFile(join(projectDir, name), 'utf8');
          const { outputText, diagnostics } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
            reportDiagnostics: true,
            fileName: name,
          });
          expect(diagnostics ?? []).toEqual([]);
          // vitest.config.ts's own emitted source literally imports
          // './vite.config.js' (anticipating a compiled JS sibling) — the
          // generated package.json already declares "type": "module", so
          // writing the transpiled output under that same .js name is
          // both correct and required for that relative import to resolve.
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
