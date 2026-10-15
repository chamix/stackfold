/**
 * `vitest` fragment: framework-agnostic test runner setup for
 * `web-app-spa` (initial_scaffold.md, Cycle 2 "0. Boundary correction
 * carried in from Cycle 1"). Every framework fragment (`vite-react`,
 * `vite-vue`, `vite-vanilla`) owns its own smoke test file and its own
 * testing-library devDependency, if any — this fragment only owns what
 * every framework shares: the `vitest` runner itself, `jsdom`, and
 * `@testing-library/jest-dom`'s matchers (these operate on raw DOM nodes,
 * not framework-specific render output, so they belong here regardless of
 * which framework is chosen). Prior to this cycle this fragment also
 * hardcoded `@testing-library/react` and `src/App.test.tsx` — a latent SRP
 * violation fixed here by relocating both, unchanged, into
 * `vite-react.ts` (see that file's own doc comment). Contributes no
 * `postActions` of its own — `npm install` (contributed by the chosen
 * framework fragment) already covers installing this fragment's own
 * devDependency.
 *
 * `vitest.config.ts` merges the chosen framework fragment's own sibling
 * `vite.config.ts` (via `mergeConfig`) rather than defining an empty,
 * plugin-free config of its own. This is load-bearing, not cosmetic: Vite
 * and Vitest resolve `vite.config.ts`/`vitest.config.ts` as two
 * *independent* config files — when both exist, `vitest run` uses only
 * `vitest.config.ts`, never falling back to `vite.config.ts`'s plugins.
 * `.tsx` (react) survives this by accident (esbuild's own built-in JSX
 * transform needs no plugin), but `.vue` has no built-in Vite/esbuild
 * support at all — without re-applying `vite.config.ts`'s
 * `@vitejs/plugin-vue()` here too, `vitest run` cannot parse `App.vue` at
 * all ("Install @vitejs/plugin-vue to handle .vue files", confirmed
 * empirically against the real, generated project). Importing and merging
 * the sibling config, rather than hardcoding plugin knowledge here, keeps
 * this fragment framework-agnostic: it only assumes every UI-framework
 * fragment contributes a `vite.config.ts` with a default-exported config
 * — true for `vite-react`/`vite-vue`/`vite-vanilla` alike, and for any
 * future framework fragment, with zero changes needed here when a new one
 * is added (the same OCP guarantee the rest of this cycle establishes).
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const VITEST_CONFIG = lines(
  "import { defineConfig, mergeConfig } from 'vitest/config';",
  "import viteConfig from './vite.config.js';",
  '',
  'export default mergeConfig(',
  '  viteConfig,',
  '  defineConfig({',
  '    test: {',
  "      environment: 'jsdom',",
  "      setupFiles: ['./src/setupTests.ts'],",
  '    },',
  '  })',
  ');'
);

/**
 * Registers `@testing-library/jest-dom`'s matchers (`toBeInTheDocument()`
 * et al.) against vitest's `expect` via the `/vitest` subpath export's
 * module augmentation — zero manual `expect.extend()` boilerplate needed.
 * Wired in via `VITEST_CONFIG`'s `test.setupFiles` below.
 */
const SETUP_TESTS = lines("import '@testing-library/jest-dom/vitest';");

export function vitestFragment(_answers: Answers): BlueprintFragment {
  return {
    id: 'vitest',
    files: [
      {
        path: 'package.json',
        strategy: 'json-merge',
        content: JSON.stringify({
          devDependencies: {
            vitest: '^5.0.4',
            jsdom: '^27.4.0',
            '@testing-library/jest-dom': '^7.0.1',
          },
          scripts: { test: 'vitest run' },
        }),
      },
      { path: 'vitest.config.ts', content: VITEST_CONFIG },
      { path: 'src/setupTests.ts', content: SETUP_TESTS },
    ],
  };
}
