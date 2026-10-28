/**
 * `web-app-stackfold` — merges the old `web-app-spa` + `web-app-standalone-html`
 * plugins (SK-ADR-001, `createWebAppPlugin()`/`BlueprintFragment`/
 * `composeBlueprint()`, `src/plugins/web-app/`) into **one** plugin,
 * authored the SK-ADR-003 way (`scaffold.ts` + `.hbs` templates +
 * `stackfold scaffold synth`), for Task 043
 * (.agents/specs/043-electron-stackfold-web-app-reauthor.md §0 point 2, §2
 * Decision A/B/C).
 *
 * Flavor/framework selection (Decision A, option (c) — approved, option
 * (b) "add `when` to `QuestionDefinition` itself" explicitly rejected as
 * disproportionate): a single `appType` select question with choices
 * `['standalone-html', 'spa-react', 'spa-vue', 'spa-vanilla']`, replacing
 * the old two-plugin + `framework` select split. Every one of the 7 old
 * `web-app` fragments is ported to the Task 041 `FragmentFactory` shape
 * (`src/authoring/fragment.ts`) and mounted via `mountFragment()` under
 * its own namespace, each receiving its own `appType`-derived `when` gate
 * as a prop (`WHEN_SPA`/`WHEN_SPA_REACT`/`WHEN_SPA_VANILLA`/
 * `WHEN_SPA_VUE`/`WHEN_STANDALONE` below) — not a fragment-local question,
 * consistent with Decision A. None of the 7 fragments declares a local
 * question of its own (confirmed during grounding — see each fragment's
 * own header comment), so `mountFragment()`'s namespace rewrite is a
 * structural no-op for all of them here; mounting through it anyway keeps
 * every fragment consistent with the one porting mechanism (Decision B).
 *
 * Mount order (`composeFragments()`'s argument order below) matters for
 * byte-identical output: the old `web-app-spa`'s own fragment order was
 * `[baseTs, frameworkFragment, vitest, eslint]` — `core/composition.ts`'s
 * `json-merge` strategy preserves first-appearance key order across
 * contributors to the same path (`package.json`). Listing `baseTs` before
 * all three `vite-*` fragments, and `vitest`/`eslint` after all three,
 * reproduces that exact relative order for whichever single `vite-*`
 * fragment is actually active per `appType` — the other two are inert
 * no-ops via their own `when` gate, so their position among themselves
 * doesn't matter. `standaloneHtml`'s position is irrelevant: mutually
 * exclusive with every other fragment via `appType`, no path overlap.
 *
 * `packageName`/`year` are root-level `hooks.preInit` `deriveAnswer`
 * steps, exactly the pattern `electron-stackfold/scaffold.ts` already
 * uses — `'npm-slug'` reuses `core/stringTransforms.ts`'s `toPackageName()`
 * verbatim, confirmed byte-identical to the old `web-app/
 * shared-questions.ts`'s own `toPackageName()`.
 *
 * `cli/index.ts` must compile this plugin from its own compiled
 * `scaffold.js`, not the synthesized `scaffold.json` — the same
 * `plugin-builder` precedent (`src/plugins/plugin-builder/scaffold.ts`'s
 * own header comment): `appName`/`description`/`author`'s `validate`
 * closures (`toValidate(appNameSchema/descriptionSchema/authorSchema)`)
 * are function values JSON cannot carry, and a JSON-compiled runtime path
 * would silently drop them.
 *
 * Security (`.claude/knowledge/nodejs/security.md` "Untrusted code
 * execution"): same trusted-author build-time threat model as every other
 * `scaffold.ts` in this repo — no new mitigation needed here beyond the
 * `htmlEscapeKeys`/`scriptCloseEscapeKeys` escape-key usage below, which
 * close two *content-generation* injection gaps (free-text answers landing
 * in generated HTML / a generated Vue SFC's own `<script>` block), not a
 * synth-time code-execution concern.
 */
import { defineScaffold, step } from '../../authoring/builder.js';
import { composeFragments, mountFragment } from '../../authoring/fragment.js';
import { appNameSchema, authorSchema, descriptionSchema, toValidate } from '../../core/validation.js';
import { baseTsFragment } from './fragments/base-ts.js';
import { eslintFragment } from './fragments/eslint.js';
import { standaloneHtmlFragment } from './fragments/standalone-html.js';
import { viteReactFragment } from './fragments/vite-react.js';
import { viteVanillaFragment } from './fragments/vite-vanilla.js';
import { viteVueFragment } from './fragments/vite-vue.js';
import { vitestFragment } from './fragments/vitest.js';

export const DEFAULT_APP_NAME = 'my-web-app';
export const DEFAULT_DESCRIPTION = 'A web app.';
export const DEFAULT_AUTHOR = '';
/**
 * Matches the old `framework` question's own default ('react') combined
 * with SPA having been the more commonly reached-for prior default plugin
 * (`web-app-spa` vs. the single-file `web-app-standalone-html`) — a
 * judgment call documented here since nothing in the old two-plugin setup
 * had a single equivalent default to port verbatim.
 */
export const DEFAULT_APP_TYPE = 'spa-react';

export const APP_TYPE_CHOICES = ['standalone-html', 'spa-react', 'spa-vue', 'spa-vanilla'] as const;

// ---------------------------------------------------------------------------
// `appType`-derived `when` gates (Decision A option (c)) — plain JSON Logic
// literals, never a fragment-local question id, so `mountFragment()`'s
// rewrite engine leaves every one of these untouched.
// ---------------------------------------------------------------------------

const WHEN_SPA = { '!=': [{ var: 'appType' }, 'standalone-html'] };
const WHEN_SPA_REACT = { '==': [{ var: 'appType' }, 'spa-react'] };
const WHEN_SPA_VANILLA = { '==': [{ var: 'appType' }, 'spa-vanilla'] };
const WHEN_SPA_VUE = { '==': [{ var: 'appType' }, 'spa-vue'] };
const WHEN_STANDALONE = { '==': [{ var: 'appType' }, 'standalone-html'] };

/**
 * Task 044 (UX-001/SK-ADR-004, rollout table) — the case that motivated
 * SK-ADR-004: the entry point varies by `appType`, so it's a JSONLogic
 * conditional resolved inside `buildBlueprint()`, not a static plugin
 * literal. `standalone-html` → `index.html`; `spa-react` → `src/main.tsx`
 * (JSX entry); `spa-vue`/`spa-vanilla` → `src/main.ts` (no JSX).
 */
const MAIN_FILE_BY_APP_TYPE = {
  if: [
    WHEN_STANDALONE,
    'index.html',
    WHEN_SPA_REACT,
    'src/main.tsx',
    'src/main.ts',
  ],
};

// ---------------------------------------------------------------------------
// Mount every fragment under its own namespace (Task 041), passing each its
// own `appType`-derived gate. See this module's header comment for why mount
// order matters (byte-identical `package.json` key order).
// ---------------------------------------------------------------------------

const baseTs = mountFragment(baseTsFragment, { when: WHEN_SPA }, { namespace: 'baseTs' });
const viteReact = mountFragment(viteReactFragment, { when: WHEN_SPA_REACT }, { namespace: 'viteReact' });
const viteVanilla = mountFragment(viteVanillaFragment, { when: WHEN_SPA_VANILLA }, { namespace: 'viteVanilla' });
const viteVue = mountFragment(viteVueFragment, { when: WHEN_SPA_VUE }, { namespace: 'viteVue' });
const vitest = mountFragment(vitestFragment, { when: WHEN_SPA }, { namespace: 'vitest' });
const eslint = mountFragment(eslintFragment, { when: WHEN_SPA }, { namespace: 'eslint' });
const standaloneHtml = mountFragment(
  standaloneHtmlFragment,
  { when: WHEN_STANDALONE },
  { namespace: 'standaloneHtml' }
);

const composed = composeFragments(baseTs, viteReact, viteVanilla, viteVue, vitest, eslint, standaloneHtml);

export default defineScaffold({
  id: 'web-app-stackfold',
  description:
    'Web app (standalone HTML, or an SPA in React/Vue/vanilla + Vite) — merges the old web-app-spa and ' +
    'web-app-standalone-html plugins into one, authored via the scaffold-authoring system.',
  help: {
    name: 'Web App',
    details:
      'Choose one appType during init: a single, dependency-free standalone HTML file (no server, no network ' +
      'after load), or a Vite-powered single-page app in React, Vue, or plain vanilla TS (client-side routing-' +
      'ready, no SSR). vitest + eslint are wired in for every SPA choice, regardless of framework. Replaces the ' +
      'old web-app-spa/web-app-standalone-html plugins — same generated output per choice, one merged plugin.',
  },

  questions: [
    {
      id: 'appName',
      message: 'Application name',
      type: 'input',
      default: DEFAULT_APP_NAME,
      validate: toValidate(appNameSchema),
    },
    {
      id: 'description',
      message: 'Short description',
      type: 'input',
      default: DEFAULT_DESCRIPTION,
      validate: toValidate(descriptionSchema),
    },
    {
      id: 'author',
      message: 'Author (optional, used for package.json and an MIT LICENSE)',
      type: 'input',
      default: DEFAULT_AUTHOR,
      validate: toValidate(authorSchema),
    },
    {
      id: 'appType',
      message: 'App type',
      type: 'select',
      choices: [...APP_TYPE_CHOICES],
      default: DEFAULT_APP_TYPE,
    },
    ...composed.questions,
  ],

  steps: composed.steps,

  mainFile: MAIN_FILE_BY_APP_TYPE,

  hooks: {
    preInit: [
      step('deriveAnswer', { from: 'appName', to: 'packageName', transform: 'npm-slug' }),
      step('deriveAnswer', { from: 'appName', to: 'year', transform: 'current-year' }),
    ],
  },
});
