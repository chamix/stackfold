/**
 * `base-ts` fragment: the TypeScript/package.json/LICENSE skeleton shared
 * by every `web-app` flavor that ships a real npm project (not
 * `web-app-standalone-html`, which never selects this fragment) —
 * initial_scaffold.md, "Content specification".
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';
import { resolveSharedContext } from '../shared-questions.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Strict TS config for a browser-targeted, Vite-bundled project: `noEmit`
 * because Vite (via esbuild/`@vitejs/plugin-react`) does the actual
 * transpilation — `tsc` here is a type-checker only, same split
 * `electron-ts`'s own generated `tsconfig.typecheck.json` makes explicit.
 * `strict`/`noUncheckedIndexedAccess` match `electron-ts`'s own baseline
 * rigor; no `any` leniency added here.
 */
const TSCONFIG = json({
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
    strict: true,
    noUncheckedIndexedAccess: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'vite.config.ts'],
});

const GITIGNORE = lines('node_modules/', 'dist/');

function renderLicense(author: string, year: number): string {
  return lines(
    'MIT License',
    '',
    `Copyright (c) ${year} ${author}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.'
  );
}

/**
 * `now`: injected clock for the LICENSE copyright year, same discipline as
 * `electron-ts`'s own `ElectronTsPluginOptions.now` — buildBlueprint() has
 * no hidden input, so the same answers and clock give the same blueprint.
 */
export function baseTsFragment(answers: Answers, now: () => Date = () => new Date()): BlueprintFragment {
  const ctx = resolveSharedContext(answers);

  const files: BlueprintFragment['files'] = [
    {
      path: 'package.json',
      strategy: 'json-merge',
      content: JSON.stringify({ name: ctx.packageName, version: '0.1.0', private: true, type: 'module' }),
    },
    { path: 'tsconfig.json', content: TSCONFIG },
    { path: '.gitignore', strategy: 'append', content: GITIGNORE },
  ];

  if (ctx.author !== '') {
    files.push({ path: 'LICENSE', content: renderLicense(ctx.author, now().getFullYear()) });
  }

  return {
    id: 'base-ts',
    files,
    postActions: [{ kind: 'git-init' }],
  };
}
