/**
 * `vite-vanilla` fragment: the dependency-free UI framework option for
 * `web-app-spa` (initial_scaffold.md, Cycle 2 "web-app plugin family
 * (Cycle 2 — vue/vanilla frameworks for web-app-spa)", "1. New
 * fragments"). No `dependencies` entry at all and no testing-library of
 * any kind — the smoke test exercises `renderApp()` directly against a
 * real jsdom element, for which `vitest`+`jsdom` (already contributed by
 * the framework-agnostic `vitest` fragment) is sufficient. Same OCP proof
 * as `vite-vue.ts`: adding this module required zero changes to
 * `core/composition.ts`, `factory.ts`, `base-ts.ts`, `eslint.ts`,
 * `vite-react.ts`, or `vite-vue.ts`.
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';
import { escapeHtml, resolveSharedContext } from '../shared-questions.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const VITE_CONFIG = lines("import { defineConfig } from 'vite';", '', 'export default defineConfig({});');

function renderIndexHtml(ctx: { appName: string; description: string }): string {
  return lines(
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <meta name="description" content="${escapeHtml(ctx.description)}" />`,
    `    <title>${escapeHtml(ctx.appName)}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="app"></div>',
    '    <script type="module" src="/src/main.ts"></script>',
    '  </body>',
    '</html>'
  );
}

/**
 * `appName` reaches the DOM only through `Node.textContent`, never
 * through `innerHTML`/string-templated markup — the same "no free-text
 * answer is ever interpolated into markup unescaped" invariant the other
 * two framework fragments uphold via an escaping function is upheld here
 * by construction instead: `textContent` never parses its argument as
 * markup, regardless of value, so no escaping function is needed for this
 * path at all. `JSON.stringify` is still used to embed `appName` as a
 * valid JS string-literal source token (quotes/backslashes/newlines/
 * unicode) — the same discipline `vite-react.ts`/`vite-vue.ts` use for
 * their own module-level constants, independent of any markup concern.
 *
 * `renderApp()` is exported *and* invoked eagerly at module load, exactly
 * as the technical spec requires — which is also why the module-load
 * bootstrap below does not throw when `#app` is absent (unlike
 * `vite-react.ts`'s/`vite-vue.ts`'s own bootstraps, which do): this same
 * module is imported directly by `src/App.test.ts`'s smoke test, in a
 * jsdom environment with no `#app` element in the document, and an
 * unconditional throw at module-evaluation time would fail that import
 * before any test body ever ran. Silently no-op-ing when there is no
 * mount point is a deliberate, safe default for a bootstrap script that
 * doubles as a directly-importable, directly-testable module.
 */
function renderMainTs(ctx: { appName: string }): string {
  return lines(
    `const APP_NAME = ${JSON.stringify(ctx.appName)};`,
    '',
    'export function renderApp(container: HTMLElement): void {',
    "  const main = document.createElement('main');",
    "  const heading = document.createElement('h1');",
    '  heading.textContent = APP_NAME;',
    '  main.appendChild(heading);',
    '  container.replaceChildren(main);',
    '}',
    '',
    "const root = document.getElementById('app');",
    'if (root) renderApp(root);'
  );
}

const APP_TEST = lines(
  "import { describe, expect, it } from 'vitest';",
  "import { renderApp } from './main.js';",
  '',
  "describe('renderApp', () => {",
  "  it('renders a <main> element containing a heading', () => {",
  "    const container = document.createElement('div');",
  '    renderApp(container);',
  "    expect(container.querySelector('main')).not.toBeNull();",
  "    expect(container.querySelector('h1')).not.toBeNull();",
  '  });',
  '});'
);

export function viteVanillaFragment(answers: Answers): BlueprintFragment {
  const ctx = resolveSharedContext(answers);

  return {
    id: 'vite-vanilla',
    files: [
      {
        path: 'package.json',
        strategy: 'json-merge',
        content: JSON.stringify({
          devDependencies: { vite: '^8.3.4' },
          scripts: { dev: 'vite', build: 'vite build' },
        }),
      },
      { path: 'vite.config.ts', content: VITE_CONFIG },
      { path: 'index.html', content: renderIndexHtml(ctx) },
      { path: 'src/main.ts', content: renderMainTs(ctx) },
      { path: 'src/App.test.ts', content: APP_TEST },
    ],
    postActions: [{ kind: 'npm-install' }],
  };
}
