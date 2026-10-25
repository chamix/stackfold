/**
 * `standalone-html` fragment, ported to the Task 041 `FragmentFactory`
 * shape from the old `src/plugins/web-app/fragments/standalone-html.ts`
 * (SK-ADR-001) — the entire `standalone-html` `appType` in one
 * contribution: a single, dependency-free HTML file, no `package.json`,
 * no `postActions`.
 *
 * The old fragment escaped `appName`/`description` via a hand-rolled
 * `escapeHtml()` (`web-app/shared-questions.ts`, Task 014's real XSS fix)
 * before interpolating them into HTML text/attribute positions. This port
 * uses the new `htmlEscapeKeys` field instead (Task 043, "Required core/
 * amendment") — the exact same escaping logic, now a `core/authoring.ts`
 * built-in rather than a hand-rolled plugin-local helper — applied on the
 * `index.html` `writeFile` step below. Without it, `compileTemplate()`'s
 * `noEscape: true` Handlebars option (`core/authoring.ts`'s own header
 * comment) would leave `appName`/`description` completely unescaped,
 * silently reintroducing the Task 014 vulnerability.
 *
 * `props.when` (always `WHEN_STANDALONE` — see `../scaffold.ts`) gates the
 * one step: every other `appType` value never composes this fragment.
 */
import { step } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const INDEX_HTML_TEMPLATE = loadTemplate(dir, '../templates/standalone-html/index.html.hbs');

export interface StandaloneHtmlFragmentProps {
  /** `WHEN_STANDALONE` from `../scaffold.ts` — true only when `appType === 'standalone-html'`. */
  when: unknown;
}

// `step('writeFile', ...)` directly, not the `file()` sugar — `file()`
// (`src/authoring/builder.ts`, outside this task's scope to extend) only
// supports `strategy`/`jsonEscapeKeys`, not `htmlEscapeKeys`. Same
// escape-hatch precedent `plugin-builder/scaffold.ts` already uses for
// `jsEscapeKeys`.
export const standaloneHtmlFragment: FragmentFactory<StandaloneHtmlFragmentProps> = ({ when }): Fragment => ({
  questions: [],
  steps: [
    step(
      'writeFile',
      { path: 'index.html', content: INDEX_HTML_TEMPLATE, htmlEscapeKeys: ['appName', 'description'] },
      { when }
    ),
  ],
});
