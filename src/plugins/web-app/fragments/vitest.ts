/**
 * `vitest` fragment: test runner setup for `web-app-spa`
 * (initial_scaffold.md, "Content specification"). Contributes no
 * `postActions` of its own — `npm install` (contributed by `vite-react`)
 * already covers installing this fragment's own devDependency.
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const VITEST_CONFIG = lines(
  "import { defineConfig } from 'vitest/config';",
  '',
  'export default defineConfig({',
  '  test: {',
  "    environment: 'jsdom',",
  "    setupFiles: ['./src/setupTests.ts'],",
  '  },',
  '});'
);

const APP_TEST = lines(
  "import { render, screen } from '@testing-library/react';",
  "import { describe, expect, it } from 'vitest';",
  "import { App } from './App.js';",
  '',
  "describe('App', () => {",
  "  it('renders', () => {",
  '    render(<App />);',
  '    expect(screen.getByRole(\'main\')).toBeInTheDocument();',
  '  });',
  '});'
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
            '@testing-library/react': '^16.3.3',
            '@testing-library/jest-dom': '^7.0.1',
          },
          scripts: { test: 'vitest run' },
        }),
      },
      { path: 'vitest.config.ts', content: VITEST_CONFIG },
      { path: 'src/setupTests.ts', content: SETUP_TESTS },
      { path: 'src/App.test.tsx', content: APP_TEST },
    ],
  };
}
