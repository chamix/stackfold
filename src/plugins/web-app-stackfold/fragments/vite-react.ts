/**
 * `vite-react` fragment, ported to the Task 041 `FragmentFactory` shape
 * from the old `src/plugins/web-app/fragments/vite-react.ts` (SK-ADR-001)
 * — same six files, same `json-merge` strategy on `package.json`, same
 * `npm-install` postAction.
 *
 * `index.html`'s `appName`/`description` use the new `htmlEscapeKeys`
 * field (same reasoning as `standalone-html.ts`'s own doc comment).
 * `App.tsx`'s `const APP_NAME = "..."` uses `jsonEscapeKeys` — the
 * template itself supplies the surrounding double quotes, and
 * `escapeForJsonContext()`'s `JSON.stringify(value).slice(1, -1)`
 * reconstructs exactly `JSON.stringify(ctx.appName)`, the old fragment's
 * own expression, byte-for-byte. `appName` is still never string-templated
 * into JSX *text* directly — it is read back via the `{APP_NAME}` JS
 * expression slot, the same structural-injection immunity the old fragment
 * documented (JSX treats that slot as inert text, not parsed markup).
 *
 * `props.when` (always `WHEN_SPA_REACT` — see `../scaffold.ts`) gates
 * every step: active only when `appType === 'spa-react'`. Task 050
 * (.agents/specs/050-web-app-stackfold-intro-content.md §Step 1) adds
 * `props.introWhen`/`props.bareWhen` (`WHEN_SPA_REACT_INTRO`/
 * `WHEN_SPA_REACT_BARE`), used *only* on the `src/App.tsx` step — the
 * "main display file" — which is split into two mutually-exclusive
 * `writeFile` steps instead; every other step keeps using the plain
 * `when` prop, unchanged.
 */
import { file, npmInstall, step } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/vite-react/package.json.hbs');
const VITE_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/vite-react/vite.config.ts.hbs');
const INDEX_HTML_TEMPLATE = loadTemplate(dir, '../templates/vite-react/index.html.hbs');
const MAIN_TSX_TEMPLATE = loadTemplate(dir, '../templates/vite-react/main.tsx.hbs');
const APP_TSX_TEMPLATE = loadTemplate(dir, '../templates/vite-react/App.tsx.hbs');
const APP_TSX_INTRO_TEMPLATE = loadTemplate(dir, '../templates/vite-react/App-intro.tsx.hbs');
const APP_TEST_TSX_TEMPLATE = loadTemplate(dir, '../templates/vite-react/App.test.tsx.hbs');

export interface ViteReactFragmentProps {
  /** `WHEN_SPA_REACT` from `../scaffold.ts` — true only when `appType === 'spa-react'`. */
  when: unknown;
  /** `WHEN_SPA_REACT_INTRO` from `../scaffold.ts` — true only when `appType === 'spa-react'` and `includeStackfoldIntro` is true. Used only on the `src/App.tsx` step. */
  introWhen: unknown;
  /** `WHEN_SPA_REACT_BARE` from `../scaffold.ts` — true only when `appType === 'spa-react'` and `includeStackfoldIntro` is false. Used only on the `src/App.tsx` step. */
  bareWhen: unknown;
}

export const viteReactFragment: FragmentFactory<ViteReactFragmentProps> = ({
  when,
  introWhen,
  bareWhen,
}): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('vite.config.ts', VITE_CONFIG_TEMPLATE, { when }),
    // `step('writeFile', ...)` directly — `file()`'s sugar has no
    // `htmlEscapeKeys` support (see `standalone-html.ts`'s own comment).
    step(
      'writeFile',
      { path: 'index.html', content: INDEX_HTML_TEMPLATE, htmlEscapeKeys: ['appName', 'description'] },
      { when }
    ),
    file('src/main.tsx', MAIN_TSX_TEMPLATE, { when }),
    file('src/App.tsx', APP_TSX_INTRO_TEMPLATE, { jsonEscapeKeys: ['appName'], when: introWhen }),
    file('src/App.tsx', APP_TSX_TEMPLATE, { jsonEscapeKeys: ['appName'], when: bareWhen }),
    file('src/App.test.tsx', APP_TEST_TSX_TEMPLATE, { when }),
    npmInstall({ when }),
  ],
});
