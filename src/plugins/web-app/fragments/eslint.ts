/**
 * `eslint` fragment: lint setup for `web-app-spa` (initial_scaffold.md,
 * "Content specification"). Contributes no `postActions` of its own —
 * `npm install` (contributed by `vite-react`) already covers installing
 * this fragment's own devDependencies.
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const ESLINT_CONFIG = lines(
  "import tseslint from 'typescript-eslint';",
  '',
  'export default tseslint.config(',
  '  ...tseslint.configs.recommended,',
  '  {',
  "    ignores: ['dist/**', 'node_modules/**'],",
  '  }',
  ');'
);

export function eslintFragment(_answers: Answers): BlueprintFragment {
  return {
    id: 'eslint',
    files: [
      {
        path: 'package.json',
        strategy: 'json-merge',
        content: JSON.stringify({
          devDependencies: {
            eslint: '^10.11.0',
            'typescript-eslint': '^8.70.1',
          },
        }),
      },
      { path: 'eslint.config.js', content: ESLINT_CONFIG },
    ],
  };
}
