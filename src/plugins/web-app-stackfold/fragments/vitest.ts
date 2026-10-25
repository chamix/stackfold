/**
 * `vitest` fragment, ported to the Task 041 `FragmentFactory` shape from
 * the old `src/plugins/web-app/fragments/vitest.ts` (SK-ADR-001) — same
 * three files, same `json-merge` strategy on `package.json`, no
 * `postActions` of its own.
 *
 * `props.when` (always `WHEN_SPA` — see `../scaffold.ts`) gates every
 * step: `web-app-standalone-html`'s old flavor never composed this
 * fragment at all.
 */
import { file } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/vitest/package.json.hbs');
const VITEST_CONFIG_TEMPLATE = loadTemplate(dir, '../templates/vitest/vitest.config.ts.hbs');
const SETUP_TESTS_TEMPLATE = loadTemplate(dir, '../templates/vitest/setupTests.ts.hbs');

export interface VitestFragmentProps {
  /** `WHEN_SPA` from `../scaffold.ts` — true for every `appType` except `standalone-html`. */
  when: unknown;
}

export const vitestFragment: FragmentFactory<VitestFragmentProps> = ({ when }): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('vitest.config.ts', VITEST_CONFIG_TEMPLATE, { when }),
    file('src/setupTests.ts', SETUP_TESTS_TEMPLATE, { when }),
  ],
});
