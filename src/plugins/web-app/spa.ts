/**
 * `web-app-spa`: client-side app (Vite, React/Vue/vanilla), fetch/XHR only
 * after initial load, client-side routing-ready shell — no SSR
 * (functional_domain_webapp.md §0.1; initial_scaffold.md "spa.ts"; Cycle 2
 * "web-app plugin family (Cycle 2 — vue/vanilla frameworks for
 * web-app-spa)").
 *
 * Composes `base-ts` + a chosen UI-framework fragment + `vitest` + `eslint`,
 * exercising all three `composeBlueprint()` merge strategies at once:
 * `json-merge` (`package.json`, contributed by every fragment here),
 * `append` (`.gitignore`, `base-ts` only so far but declared `append` so a
 * later fragment can extend it without a collision), and `exclusive`
 * (every other file, each owned by exactly one fragment).
 */
import { createWebAppPlugin } from './factory.js';
import { baseTsFragment } from './fragments/base-ts.js';
import { eslintFragment } from './fragments/eslint.js';
import { viteReactFragment } from './fragments/vite-react.js';
import { viteVanillaFragment } from './fragments/vite-vanilla.js';
import { viteVueFragment } from './fragments/vite-vue.js';
import { vitestFragment } from './fragments/vitest.js';
import type { BlueprintFragment } from '../../core/composition.js';
import type { Answers } from '../../core/types.js';

/**
 * Dispatches on `answers.framework` to the chosen UI-framework fragment —
 * the ONLY new branching logic the Cycle 2 technical spec introduces
 * anywhere in the `web-app` plugin family ("2. spa.ts change"). Lives
 * here, in a flavor module, not in `factory.ts` or `core/composition.ts`
 * — this is the OCP proof: adding `vue`/`vanilla` required zero changes to
 * either of those, or to `vite-react.ts` itself. An unrecognized or
 * missing `framework` answer falls back to `'react'`, the declared
 * default — mirroring `resolveAnswers()`'s own fallback-to-default
 * behavior for callers (e.g. existing unit tests) that invoke
 * `buildBlueprint()` directly without going through the full
 * prompt-resolution pipeline.
 */
function frameworkFragment(answers: Answers): BlueprintFragment {
  switch (answers['framework']) {
    case 'vue':
      return viteVueFragment(answers);
    case 'vanilla':
      return viteVanillaFragment(answers);
    case 'react':
    default:
      return viteReactFragment(answers);
  }
}

export const webAppSpaPlugin = createWebAppPlugin({
  flavorId: 'web-app-spa',
  description: 'Client-side app (React/Vue/vanilla + Vite) that calls APIs over fetch; no SSR.',
  help: {
    name: 'Web App (SPA)',
    details:
      'A Vite-powered single-page app, client-side routing-ready, no ' +
      'server-side rendering. Choose the UI framework (React, Vue, or ' +
      'plain vanilla TS) during init; vitest + eslint are wired in ' +
      "regardless of framework. Talks to APIs over fetch/XHR only, after " +
      'the initial page load.',
  },
  flavorQuestions: [
    {
      id: 'framework',
      message: 'UI framework',
      type: 'select',
      choices: ['react', 'vue', 'vanilla'],
      default: 'react',
    },
  ],
  selectFragments: (answers) => [
    baseTsFragment(answers),
    frameworkFragment(answers),
    vitestFragment(answers),
    eslintFragment(answers),
  ],
});
