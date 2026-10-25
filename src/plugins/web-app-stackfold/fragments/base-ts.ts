/**
 * `base-ts` fragment, ported to the Task 041 `FragmentFactory` shape
 * (SK-ADR-003) from the old `BlueprintFragment`-shaped
 * `src/plugins/web-app/fragments/base-ts.ts` (SK-ADR-001) — same file set,
 * same per-file strategy (`json-merge` for package.json, `append` for
 * `.gitignore`, default `exclusive` for everything else), same
 * `author !== ''` gate on LICENSE.
 *
 * No local questions (confirmed during Task 043 grounding — see
 * .agents/specs/043-electron-stackfold-web-app-reauthor.md §1 Decision B):
 * every value this fragment's templates need (`packageName`, `author`,
 * `year`) is a root-level answer — `packageName`/`year` derived via
 * `hooks.preInit`'s `deriveAnswer` steps, `author` asked directly — all
 * declared in `../scaffold.ts`. `mountFragment()`'s namespace rewrite is
 * therefore a structural no-op here (an empty `questions[]` means an empty
 * idMap), exercised anyway for consistency with the other 6 fragments this
 * plugin ports (Decision B).
 *
 * `props.when` (always `WHEN_SPA` — see `../scaffold.ts`) gates every step
 * here: `web-app-standalone-html`'s old flavor never composed this
 * fragment at all (SK-ADR-001's degenerate, zero-fragment-collision path)
 * — the new single-question `appType` design (Decision A option (c))
 * reproduces that exact exclusion via `ActionStep.when` instead of two
 * separate plugins. LICENSE additionally requires `author !== ''`, same as
 * the old fragment — computed here as `{ and: [props.when,
 * WHEN_AUTHOR_PROVIDED] }`, a literal JSON Logic expression (not a
 * fragment-local question id), so `mountFragment()`'s rewrite engine
 * leaves it untouched.
 *
 * `renderLicense()`'s old `author` interpolation was never escaped in any
 * way (a plain-text file, no JSON/JS/HTML sink) — this port preserves that
 * exactly: no `jsonEscapeKeys`/`jsEscapeKeys`/`htmlEscapeKeys` on the
 * LICENSE step, for byte-identical output.
 */
import { file, gitInit } from '../../../authoring/builder.js';
import { loadTemplate } from '../../../authoring/templateLoader.js';
import type { Fragment, FragmentFactory } from '../../../authoring/fragment.js';

const dir = import.meta.dirname;

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, '../templates/base-ts/package.json.hbs');
const TSCONFIG_TEMPLATE = loadTemplate(dir, '../templates/base-ts/tsconfig.json.hbs');
const GITIGNORE_TEMPLATE = loadTemplate(dir, '../templates/base-ts/.gitignore.hbs');
const LICENSE_TEMPLATE = loadTemplate(dir, '../templates/base-ts/LICENSE.hbs');

// `{ '!!': { var: 'author' } }`, not `{ '!==': [{ var: 'author' }, ''] }` —
// the latter is fragile against an *absent* `author` key specifically:
// json-logic's `var` returns `undefined` for a missing key, and
// `undefined !== ''` is `true`, so LICENSE would wrongly activate when
// `author` is simply omitted from `answers` (as opposed to explicitly set
// to `''`). The real orchestrator's `resolveAnswers()` always fills in a
// question's declared default (`''` here) before `buildBlueprint()` ever
// runs, so this only bites a direct `buildBlueprint()` call with a
// genuinely incomplete `answers` object — exactly how both this plugin's
// own unit tests and the old `web-app` family's own tests call it. `!!`
// coalesces both "key absent" and "key present but empty string" to the
// same falsy "no author given" outcome, matching the old fragment's own
// `optionalString(answers, 'author', DEFAULT_AUTHOR)` fallback exactly.
const WHEN_AUTHOR_PROVIDED = { '!!': { var: 'author' } };

export interface BaseTsFragmentProps {
  /** `WHEN_SPA` from `../scaffold.ts` — true for every `appType` except `standalone-html`. */
  when: unknown;
}

export const baseTsFragment: FragmentFactory<BaseTsFragmentProps> = ({ when }): Fragment => ({
  questions: [],
  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { strategy: 'json-merge', when }),
    file('tsconfig.json', TSCONFIG_TEMPLATE, { when }),
    file('.gitignore', GITIGNORE_TEMPLATE, { strategy: 'append', when }),
    file('LICENSE', LICENSE_TEMPLATE, { when: { and: [when, WHEN_AUTHOR_PROVIDED] } }),
    gitInit({ when }),
  ],
});
