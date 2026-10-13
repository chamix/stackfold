import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers } from '../../src/core/types.js';

/**
 * `web-app-spa` plugin — generation integrity (tier 3: real emitted code,
 * no network). `.agents/specs/initial_scaffold.md`'s Cycle 1 "Test
 * strategy" item 4: scaffold the flavor into a real temp directory via
 * `NodeFileWriter` (the same `mkdtemp(tmpdir(), ...)` lifecycle
 * `tests/unit/electron-ts-plugin.test.ts`'s own tier-3 section at
 * `describe('electron-ts plugin — generation integrity (tier 3: real
 * emitted code)'` uses), then run `tsc --noEmit` over the emitted `src/`.
 *
 * This is a real, strict type-check (`tsc --noEmit`, not a syntax-only
 * `ts.transpileModule` pass) — the review that mandated this test
 * (`.agents/specs/review_report.md`, "web-app plugin family Cycle 1") was
 * explicit that exactly this kind of generation-integrity check "would
 * very plausibly have caught Blocking item 1 directly" (the JSX-injection
 * gap fixed elsewhere in this same follow-up). A weaker, parse-only check
 * would not carry that same regression-catching weight.
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

describe('web-app-spa plugin — generation integrity (tier 3: real emitted code, no network)', () => {
  it('scaffolds into a real temp dir and type-checks the emitted src/ with tsc --noEmit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-'));
    try {
      const projectDir = join(root, 'generated');
      const writer = new NodeFileWriter();
      await writer.ensureEmptyDir(projectDir);
      for (const file of webAppSpaPlugin.buildBlueprint(ANSWERS).files) {
        await writer.writeFile(join(projectDir, file.path), file.content);
      }

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

      const posix = (p: string): string => p.split(sep).join('/');
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

      const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');
      const result = await runTsc(tscBin, config);
      expect(result.output, `tsc --noEmit failed:\n${result.output}`).toBe('');
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
