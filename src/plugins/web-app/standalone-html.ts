/**
 * `web-app-standalone-html`: a single, dependency-free HTML file — no
 * server, no network call of any kind after the initial load, no
 * persisted state (functional_domain_webapp.md §0.2). Composes exactly
 * one fragment (`standalone-html`), proving the zero-collision,
 * zero-`postActions` degenerate path through `composeBlueprint()`
 * requires no special-casing anywhere (SK-ADR-001's "Consequences").
 */
import { createWebAppPlugin } from './factory.js';
import { standaloneHtmlFragment } from './fragments/standalone-html.js';

export const webAppStandaloneHtmlPlugin = createWebAppPlugin({
  flavorId: 'web-app-standalone-html',
  description: 'A single, dependency-free HTML file — no server, no network after load.',
  flavorQuestions: [],
  selectFragments: (answers) => [standaloneHtmlFragment(answers)],
});
