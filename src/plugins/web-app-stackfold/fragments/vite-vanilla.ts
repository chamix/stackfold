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
 * every step: active only when `appType === 'spa-vanilla'`.
 */
import { file, npmInstall, step } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/package.json.hbs');
const VITE_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/vite.config.ts.hbs');
const INDEX_HTML_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/index.html.hbs');
const MAIN_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/main.ts.hbs');
const APP_TEST_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vanilla/App.test.ts.hbs');

export interface ViteVanillaFragmentProps {
  /** `WHEN_SPA_VANILLA` from `../scaffold.ts` — true only when `appType === 'spa-vanilla'`. */
  when: unknown;
}

export const viteVanillaFragment: FragmentFactory<ViteVanillaFragmentProps> = ({ when }): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('vite.config.ts', VITE_CONFIG_TEMPLATE, { when }),
    step(
      'writeFile',
      { path: 'index.html', content: INDEX_HTML_TEMPLATE, htmlEscapeKeys: ['appName', 'description'] },
      { when }
    ),
    file('src/main.ts', MAIN_TS_TEMPLATE, { jsonEscapeKeys: ['appName'], when }),
    file('src/App.test.ts', APP_TEST_TS_TEMPLATE, { when }),
    npmInstall({ when }),
  ],
});
