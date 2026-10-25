/**
 * `eslint` fragment, ported to the Task 041 `FragmentFactory` shape from
 * the old `src/plugins/web-app/fragments/eslint.ts` (SK-ADR-001) — same
 * two files, same `json-merge` strategy on `package.json`, no
 * `postActions` of its own (`npm install`, contributed by whichever
 * `vite-*` fragment is active, already covers installing these
 * devDependencies).
 *
 * `props.when` (always `WHEN_SPA` — see `../scaffold.ts`) gates both
 * steps: `web-app-standalone-html`'s old flavor never composed this
 * fragment at all.
 */
import { file } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/eslint/package.json.hbs');
const ESLINT_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/eslint/eslint.config.js.hbs');

export interface EslintFragmentProps {
  /** `WHEN_SPA` from `../scaffold.ts` — true for every `appType` except `standalone-html`. */
  when: unknown;
}

export const eslintFragment: FragmentFactory<EslintFragmentProps> = ({ when }): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('eslint.config.js', ESLINT_CONFIG_TEMPLATE, { when }),
  ],
});
