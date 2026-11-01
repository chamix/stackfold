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
 * - `src/core/validation.ts` — `toValidate` (adapts a zod string schema
 *   into a `QuestionDefinition.validate` closure) plus the reusable,
 *   already-shared schemas an author's own `validate` closures commonly
 *   need: `appNameSchema`/`descriptionSchema`/`authorSchema`/
 *   `pluginIdSchema`.
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
  appNameSchema,
  authorSchema,
  descriptionSchema,
  MAX_PACKAGE_NAME_LENGTH,
  pluginIdSchema,
  toValidate,
} from '../core/validation.js';
