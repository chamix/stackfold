/**
 * Public authoring entry point (ARCH-003 Decision 2) — published as the
 * `"./authoring"` subpath export (`package.json`'s `exports` map), so a
 * plugin author with only `npm install stackfold` (no repo checkout) has a
 * documented, stable module to `import` the TS-authoring DSL from, instead
 * of reverse-engineering compiled `dist/core/authoring.*` or reaching past
 * this package's public surface into a relative monorepo path that was
 * never meant to be imported externally.
 *
 * A pure barrel — every symbol below is re-exported from its real home,
 * unchanged, so this module introduces no new behavior of its own:
 * - `src/authoring/builder.ts` — `defineScaffold`/`step`/`file`/`mkdir`/
 *   `runCommand`/`npmInstall`/`gitInit`, the CDK-flavored builder sugar
 *   over `ScaffoldDefinition`/`ActionStep`.
 * - `src/authoring/templateLoader.ts` — `loadTemplate`, the shared `.hbs`
 *   sibling-file reader.
 * - `src/authoring/fragment.ts` (ARCH-006 slice A, SK-ADR-011) —
 *   `mountFragment`/`composeFragments`/`mergeHooks`/
 *   `resetFragmentNamespaceRegistry` and the `Fragment`/`FragmentFactory`/
 *   `MountFragmentOptions` types: the fragment-composition primitive
 *   (SK-ADR-003 Cycle 2), now reachable by an external author with only
 *   `npm install stackfold` — previously it lived only at the internal
 *   `src/authoring/fragment.ts` path, unreachable through the published
 *   `exports` map (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Every export here is
 *   SemVer contract (SK-ADR-011 Decision 3): the function signatures, the
 *   `__` namespace separator visible in the ids `mountFragment()` produces,
 *   and the namespace-registry behavior `resetFragmentNamespaceRegistry()`
 *   resets.
 * - `src/core/validation.ts` — `toValidate` (adapts a zod string schema
 *   into a `QuestionDefinition.validate` closure) plus the reusable,
 *   already-shared schemas an author's own `validate` closures commonly
 *   need: `appNameSchema`/`descriptionSchema`/`authorSchema`/
 *   `pluginIdSchema`/`npmPackageNameSchema`/`singleLineSchema` (the last
 *   two added by ARCH-006 slice B). Also their SYNTH-002
 *   `QuestionConstraints` equivalents (`appNameConstraints`/
 *   `descriptionConstraints`/`authorConstraints`/`pluginIdConstraints`/
 *   `npmPackageNameConstraints`/`singleLineConstraints`) — declarative data
 *   an author can assign directly to a question's `constraints` field,
 *   surviving `scaffold synth` into `scaffold.json` without loss, unlike a
 *   `validate` closure (SK-ADR-009).
 *
 * Re-exporting `fragment.ts` means this barrel's runtime import graph is no
 * longer limited to `builder.ts`/`templateLoader.ts`/`validation.ts`
 * (`zod` only): `fragment.ts` imports `resolveAction()` from
 * `../core/authoring.js` at runtime (not just its types), and loading that
 * module evaluates its own top-level `import Handlebars from 'handlebars'`
 * — so this barrel now transitively reaches `handlebars` too, confirmed by
 * grepping `dist/authoring/index.js`'s real compiled import graph (SK-ADR-011
 * Decision 5). For an npm-installed consumer this is invisible (`handlebars`
 * is already a `dependencies` entry); it only means the ARCH-003
 * integration test's `node_modules/stackfold` fixture copy must carry
 * `handlebars` alongside `zod` now, not `zod` alone.
 *
 * Deliberately does NOT re-export `synth()` itself (`src/authoring/
 * synth.ts`) — that pipeline is invoked exclusively through the `stackfold
 * scaffold synth <dir>` CLI command (`src/cli/commands/scaffoldSynth.ts`),
 * never imported and called directly from an author's own `scaffold.ts`;
 * nothing about that boundary changes here.
 */
export {
  defineScaffold,
  file,
  gitInit,
  mkdir,
  npmInstall,
  runCommand,
  step,
  type DefineScaffoldInput,
  type FileStepOptions,
  type RunCommandStepOptions,
  type StepOptions,
  type WriteFileStrategy,
} from './builder.js';
export { loadTemplate } from './templateLoader.js';
export {
  composeFragments,
  mergeHooks,
  mountFragment,
  resetFragmentNamespaceRegistry,
  type Fragment,
  type FragmentFactory,
  type MountFragmentOptions,
} from './fragment.js';
export {
  appNameConstraints,
  appNameSchema,
  authorConstraints,
  authorSchema,
  descriptionConstraints,
  descriptionSchema,
  MAX_PACKAGE_NAME_LENGTH,
  npmPackageNameConstraints,
  npmPackageNameSchema,
  pluginIdConstraints,
  pluginIdSchema,
  singleLineConstraints,
  singleLineSchema,
  toValidate,
} from '../core/validation.js';
