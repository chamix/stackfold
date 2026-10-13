/**
 * `vite-react` fragment: the opinionated-by-default UI framework for
 * `web-app-spa` (initial_scaffold.md, "Content specification"). Resolves
 * `answers.framework` — this cycle it is always `'react'`; `vue`/
 * `vanilla` are Deferred to Cycle 2 as new fragment modules, with zero
 * changes required here or in `core/composition.ts` (the OCP claim
 * SK-ADR-001 / the technical spec make explicit).
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';
import { escapeHtml, resolveSharedContext } from '../shared-questions.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const VITE_CONFIG = lines(
  "import { defineConfig } from 'vite';",
  "import react from '@vitejs/plugin-react';",
  '',
  'export default defineConfig({',
  '  plugins: [react()],',
  '});'
);

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
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>'
  );
}

const MAIN_TSX = lines(
  "import { StrictMode } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { App } from './App.js';",
  '',
  "const root = document.getElementById('root');",
  "if (!root) throw new Error('#root element not found');",
  '',
  'createRoot(root).render(',
  '  <StrictMode>',
  '    <App />',
  '  </StrictMode>',
  ');'
);

/**
 * `appName` is never string-templated into JSX text directly — no
 * hand-rolled escaper over a parsed-text context (JSX) can be complete
 * against that grammar's own metacharacters (`<`, `>`, `{`, `}`, ...)
 * without reimplementing a full HTML/JSX-text escaper. Instead it is
 * emitted as a real JS string-literal value (`JSON.stringify` already
 * correctly escapes quotes/backslashes/newlines/unicode for that context)
 * assigned to a module-level constant, and the JSX body reads it back via
 * `{APP_NAME}` — a JS expression slot. Because that is an expression
 * container, not a text child, the JSX/React transform treats whatever
 * string `APP_NAME` holds as inert text content at render time: no markup
 * parsing of its characters occurs, so `<`, `>`, `{`, `}`, quotes etc. are
 * all structurally inert regardless of value. This closes the JSX
 * structural-injection class a prior `jsEscape()` helper (now removed)
 * only partially covered.
 */
function renderAppTsx(ctx: { appName: string }): string {
  return lines(
    "import type { JSX } from 'react';",
    '',
    `const APP_NAME = ${JSON.stringify(ctx.appName)};`,
    '',
    'export function App(): JSX.Element {',
    '  return (',
    '    <main>',
    '      <h1>{APP_NAME}</h1>',
    '    </main>',
    '  );',
    '}'
  );
}

export function viteReactFragment(answers: Answers): BlueprintFragment {
  const ctx = resolveSharedContext(answers);

  return {
    id: 'vite-react',
    files: [
      {
        path: 'package.json',
        strategy: 'json-merge',
        content: JSON.stringify({
          dependencies: { react: '^19.3.0', 'react-dom': '^19.3.0' },
          devDependencies: {
            vite: '^8.3.4',
            '@vitejs/plugin-react': '^6.1.2',
            '@types/react': '^19.3.0',
            '@types/react-dom': '^19.3.0',
          },
          scripts: { dev: 'vite', build: 'vite build' },
        }),
      },
      { path: 'vite.config.ts', content: VITE_CONFIG },
      { path: 'index.html', content: renderIndexHtml(ctx) },
      { path: 'src/main.tsx', content: MAIN_TSX },
      { path: 'src/App.tsx', content: renderAppTsx(ctx) },
    ],
    postActions: [{ kind: 'npm-install' }],
  };
}
