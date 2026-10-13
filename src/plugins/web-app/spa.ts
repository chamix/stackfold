/**
 * `web-app-spa`: client-side app (React + Vite), fetch/XHR only after
 * initial load, client-side routing-ready shell — no SSR
 * (functional_domain_webapp.md §0.1; initial_scaffold.md "spa.ts").
 *
 * Composes `base-ts` + `vite-react` + `vitest` + `eslint`, exercising all
 * three `composeBlueprint()` merge strategies at once: `json-merge`
 * (`package.json`, contributed by every fragment here), `append`
 * (`.gitignore`, `base-ts` only in this cycle but declared `append` so a
 * later fragment can extend it without a collision), and `exclusive`
 * (every other file, each owned by exactly one fragment).
 */
import { createWebAppPlugin } from './factory.js';
import { baseTsFragment } from './fragments/base-ts.js';
import { eslintFragment } from './fragments/eslint.js';
import { viteReactFragment } from './fragments/vite-react.js';
import { vitestFragment } from './fragments/vitest.js';

export const webAppSpaPlugin = createWebAppPlugin({
  flavorId: 'web-app-spa',
  description: 'Client-side app (React + Vite) that calls APIs over fetch; no SSR.',
  flavorQuestions: [
    {
      id: 'framework',
      message: 'UI framework',
      type: 'select',
      choices: ['react'], // vue/vanilla: Cycle 2 (OCP — see initial_scaffold.md "Deferred")
      default: 'react',
    },
  ],
  selectFragments: (answers) => [
    baseTsFragment(answers),
    viteReactFragment(answers),
    vitestFragment(answers),
    eslintFragment(answers),
  ],
});
