/**
 * `vite-vue` fragment: the Vue 3 UI framework option for `web-app-spa`
 * (initial_scaffold.md, Cycle 2 "web-app plugin family (Cycle 2 —
 * vue/vanilla frameworks for web-app-spa)", "1. New fragments"). Mirrors
 * `vite-react.ts`'s shape (package.json contribution, vite.config.ts,
 * index.html, an entry point, an app component, a smoke test, an
 * `npm-install` postAction) — this is the OCP proof `spa.ts`'s
 * `frameworkFragment()` dispatch depends on: adding this module required
 * zero changes to `core/composition.ts`, `factory.ts`, `base-ts.ts`,
 * `eslint.ts`, or `vite-react.ts`.
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';
import { escapeHtml, resolveSharedContext } from '../shared-questions.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

const VITE_CONFIG = lines(
  "import { defineConfig } from 'vite';",
  "import vue from '@vitejs/plugin-vue';",
  '',
  'export default defineConfig({',
  '  plugins: [vue()],',
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
    '    <div id="app"></div>',
    '    <script type="module" src="/src/main.ts"></script>',
    '  </body>',
    '</html>'
  );
}

const MAIN_TS = lines(
  "import { createApp } from 'vue';",
  "import App from './App.vue';",
  '',
  "createApp(App).mount('#app');"
);

/**
 * `tsc --noEmit` cannot type-check `.vue` single-file components (it only
 * sees `.ts` files) — the technical spec's known, documented gap (§3): no
 * `vue-tsc` is added this cycle. But `src/main.ts` (a real `.ts` file)
 * still imports `./App.vue`, and that import needs *some* module
 * declaration to resolve at all, independent of ever checking App.vue's
 * own internal types — this ambient wildcard shim is exactly that,
 * nothing more (confirmed empirically: without it, `tsc --noEmit` fails
 * with "Cannot find module './App.vue'" even though `vite`/`esbuild`
 * resolve the same import at build/dev time without any shim, via their
 * own bundler-aware loaders, not `tsc`'s module resolution).
 */
const ENV_SHIM = lines(
  "declare module '*.vue' {",
  "  import type { DefineComponent } from 'vue';",
  '',
  '  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;',
  '  export default component;',
  '}'
);

/**
 * Prevents a literal "</script" (case-insensitive) substring inside the
 * JSON-stringified value from prematurely closing the SFC's own
 * `<script setup>` container block during `@vue/compiler-sfc`'s
 * tag-scanning parse phase. Confirmed empirically (own adversarial test,
 * `web-app-spa-plugin-vue.test.ts`, "App.vue never lets a closing-script-
 * tag payload break the SFC's own <script> block"): the SFC parser scans
 * for the literal closing-tag text the same way a browser parsing raw
 * HTML does, with no awareness of JS string-literal context, so an
 * unescaped `</script` inside the string literal's own text would split
 * the file into two sibling <script> blocks regardless of what valid JS
 * surrounds it. Inserting a backslash before the "/" is a semantically
 * inert JS-string escape ("\/" evaluates to "/" at runtime) that still
 * breaks up the exact character sequence the tag scanner looks for.
 */
function escapeScriptClose(jsonLiteral: string): string {
  return jsonLiteral.replace(/<\/script/gi, '<\\/script');
}

/**
 * `appName` is never string-templated into the `<template>` block's text
 * directly. It is emitted as a real JS string-literal value
 * (`JSON.stringify` plus `escapeScriptClose()` above) assigned to a
 * module-level constant in `<script setup>`, and `<template>` reads it
 * back via `{{ APP_NAME }}` — a Vue expression-interpolation slot.
 * `@vue/compiler-sfc` compiles that slot to a `toDisplayString(...)` call
 * wrapped in a TEXT-flagged VNode (confirmed by compiling the real
 * template through the real compiler — own adversarial test), i.e. a DOM
 * text node: no markup parsing of `APP_NAME`'s characters occurs at
 * render time regardless of value. This closes the same structural-
 * injection class `vite-react.ts`'s `renderAppTsx()` closes for JSX — via
 * Vue's own interpolation mechanism and its own adversarial proof, not a
 * copy of React's.
 */
function renderAppVue(ctx: { appName: string }): string {
  const appNameLiteral = escapeScriptClose(JSON.stringify(ctx.appName));
  return lines(
    '<script setup lang="ts">',
    `const APP_NAME = ${appNameLiteral};`,
    '</script>',
    '',
    '<template>',
    '  <main>',
    '    <h1>{{ APP_NAME }}</h1>',
    '  </main>',
    '</template>'
  );
}

const APP_TEST = lines(
  "import { render, screen } from '@testing-library/vue';",
  "import { describe, expect, it } from 'vitest';",
  "import App from './App.vue';",
  '',
  "describe('App', () => {",
  "  it('renders', () => {",
  '    render(App);',
  '    expect(screen.getByRole(\'main\')).toBeInTheDocument();',
  '  });',
  '});'
);

export function viteVueFragment(answers: Answers): BlueprintFragment {
  const ctx = resolveSharedContext(answers);

  return {
    id: 'vite-vue',
    files: [
      {
        path: 'package.json',
        strategy: 'json-merge',
        content: JSON.stringify({
          dependencies: { vue: '^3.5.44' },
          devDependencies: {
            vite: '^8.3.4',
            '@vitejs/plugin-vue': '^6.0.10',
            '@testing-library/vue': '^8.1.0',
          },
          scripts: { dev: 'vite', build: 'vite build' },
        }),
      },
      { path: 'vite.config.ts', content: VITE_CONFIG },
      { path: 'index.html', content: renderIndexHtml(ctx) },
      { path: 'src/main.ts', content: MAIN_TS },
      { path: 'src/env.d.ts', content: ENV_SHIM },
      { path: 'src/App.vue', content: renderAppVue(ctx) },
      { path: 'src/App.test.ts', content: APP_TEST },
    ],
    postActions: [{ kind: 'npm-install' }],
  };
}
