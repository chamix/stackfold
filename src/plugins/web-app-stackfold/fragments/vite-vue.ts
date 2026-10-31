/**
 * `vite-vue` fragment, ported to the Task 041 `FragmentFactory` shape from
 * the old `src/plugins/web-app/fragments/vite-vue.ts` (SK-ADR-001) — same
 * seven files, same strategy/postAction shape.
 *
 * `App.vue`'s `const APP_NAME = "..."` needs BOTH `jsonEscapeKeys` (the
 * JS string-literal escape) AND `scriptCloseEscapeKeys` (Task 043 review
 * follow-up, approved alongside `htmlEscapeKeys`) — in that order
 * (`core/authoring.ts`'s `writeFile` resolver applies `scriptClose` after
 * `json`), reproducing the old fragment's own
 * `escapeScriptClose(JSON.stringify(ctx.appName))` call exactly: without
 * the second pass, a crafted `appName` containing a literal `</script`
 * could split this generated SFC into two sibling `<script>` blocks during
 * Vue's own tag-scanning parse (the old fragment's own adversarial test,
 * ported into `tests/unit/authoring.test.ts`'s `scriptCloseEscapeKeys`
 * block).
 *
 * `props.when` (always `WHEN_SPA_VUE` — see `../scaffold.ts`) gates every
 * step: active only when `appType === 'spa-vue'`. Task 050
 * (.agents/specs/050-web-app-stackfold-intro-content.md §Step 1) adds
 * `props.introWhen`/`props.bareWhen` (`WHEN_SPA_VUE_INTRO`/
 * `WHEN_SPA_VUE_BARE`), used *only* on the `src/App.vue` step — the
 * "main display file" — split into two mutually-exclusive `writeFile`
 * steps instead; every other step keeps using the plain `when` prop,
 * unchanged.
 */
import { file, npmInstall, step } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/package.json.hbs');
const VITE_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/vite.config.ts.hbs');
const INDEX_HTML_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/index.html.hbs');
const MAIN_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/main.ts.hbs');
const ENV_D_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/env.d.ts.hbs');
const APP_VUE_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/App.vue.hbs');
const APP_VUE_INTRO_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/App-intro.vue.hbs');
const APP_TEST_TS_TEMPLATE = loadTemplate(dir, '../templates/vite-vue/App.test.ts.hbs');

export interface ViteVueFragmentProps {
  /** `WHEN_SPA_VUE` from `../scaffold.ts` — true only when `appType === 'spa-vue'`. */
  when: unknown;
  /** `WHEN_SPA_VUE_INTRO` from `../scaffold.ts` — true only when `appType === 'spa-vue'` and `includeStackfoldIntro` is true. Used only on the `src/App.vue` step. */
  introWhen: unknown;
  /** `WHEN_SPA_VUE_BARE` from `../scaffold.ts` — true only when `appType === 'spa-vue'` and `includeStackfoldIntro` is false. Used only on the `src/App.vue` step. */
  bareWhen: unknown;
}

export const viteVueFragment: FragmentFactory<ViteVueFragmentProps> = ({ when, introWhen, bareWhen }): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('vite.config.ts', VITE_CONFIG_TEMPLATE, { when }),
    step(
      'writeFile',
      { path: 'index.html', content: INDEX_HTML_TEMPLATE, htmlEscapeKeys: ['appName', 'description'] },
      { when }
    ),
    file('src/main.ts', MAIN_TS_TEMPLATE, { when }),
    file('src/env.d.ts', ENV_D_TS_TEMPLATE, { when }),
    step(
      'writeFile',
      {
        path: 'src/App.vue',
        content: APP_VUE_INTRO_TEMPLATE,
        jsonEscapeKeys: ['appName'],
        scriptCloseEscapeKeys: ['appName'],
      },
      { when: introWhen }
    ),
    step(
      'writeFile',
      {
        path: 'src/App.vue',
        content: APP_VUE_TEMPLATE,
        jsonEscapeKeys: ['appName'],
        scriptCloseEscapeKeys: ['appName'],
      },
      { when: bareWhen }
    ),
    file('src/App.test.ts', APP_TEST_TS_TEMPLATE, { when }),
    npmInstall({ when }),
  ],
});
