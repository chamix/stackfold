/**
 * `vite-vanilla` fragment, ported to the Task 041 `FragmentFactory` shape
 * from the old `src/plugins/web-app/fragments/vite-vanilla.ts`
 * (SK-ADR-001) — same five files, same strategy/postAction shape. No
 * `dependencies` entry at all and no testing-library of any kind, same as
 * the old fragment.
 *
 * `index.html`'s `appName`/`description` use `htmlEscapeKeys`. `main.ts`'s
 * `const APP_NAME = "..."` uses `jsonEscapeKeys` — `appName` only ever
 * reaches the DOM via `Node.textContent` (never `innerHTML`), so no markup
 * injection is possible regardless of the escaped value; `jsonEscapeKeys`
 * here only protects the JS string-literal position itself, same as the
 * old fragment's own `JSON.stringify()` call.
 *
 * `props.when` (always `WHEN_SPA_VANILLA` — see `../scaffold.ts`) gates
 * every step: active only when `appType === 'spa-vanilla'`. Task 050
 * (.agents/specs/050-web-app-stackfold-intro-content.md §Step 1) adds
 * `props.introWhen`/`props.bareWhen` (`WHEN_SPA_VANILLA_INTRO`/
 * `WHEN_SPA_VANILLA_BARE`), used *only* on the `src/main.ts` step — the
 * "main display file" here is also the real entry point (`renderApp()`
 * via DOM API, no JSX/template syntax), so the intro template
 * (`main-intro.ts.hbs`) carries its own complete, independent
 * `renderApp()` that does everything the bare version does (mount into
 * `#app`, set `<h1>{appName}</h1>` via DOM API) *plus* the intro block
 * — not a partial diff layered on top of the bare one. Every other step
 * keeps using the plain `when` prop, unchanged.
 */
import { file, npmInstall, step } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/package.json.hbs');
const VITE_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/vite.config.ts.hbs');
const INDEX_HTML_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/index.html.hbs');
const MAIN_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/main.ts.hbs');
const MAIN_TS_INTRO_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/main-intro.ts.hbs');
const APP_TEST_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/App.test.ts.hbs');

export interface ViteVanillaFragmentProps {
  /** `WHEN_SPA_VANILLA` from `../scaffold.ts` — true only when `appType === 'spa-vanilla'`. */
  when: unknown;
  /** `WHEN_SPA_VANILLA_INTRO` from `../scaffold.ts` — true only when `appType === 'spa-vanilla'` and `includeStackfoldIntro` is true. Used only on the `src/main.ts` step. */
  introWhen: unknown;
  /** `WHEN_SPA_VANILLA_BARE` from `../scaffold.ts` — true only when `appType === 'spa-vanilla'` and `includeStackfoldIntro` is false. Used only on the `src/main.ts` step. */
  bareWhen: unknown;
}

export const viteVanillaFragment: FragmentFactory<ViteVanillaFragmentProps> = ({
  when,
  introWhen,
  bareWhen,
}): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('vite.config.ts', VITE_CONFIG_TEMPLATE, { when }),
    step(
      'writeFile',
      { path: 'index.html', content: INDEX_HTML_TEMPLATE, htmlEscapeKeys: ['appName', 'description'] },
      { when }
    ),
    file('src/main.ts', MAIN_TS_INTRO_TEMPLATE, { jsonEscapeKeys: ['appName'], when: introWhen }),
    file('src/main.ts', MAIN_TS_TEMPLATE, { jsonEscapeKeys: ['appName'], when: bareWhen }),
    file('src/App.test.ts', APP_TEST_TS_TEMPLATE, { when }),
    npmInstall({ when }),
  ],
});
