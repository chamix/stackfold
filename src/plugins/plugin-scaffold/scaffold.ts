/**
 * `plugin-scaffold` — external-plugin-authoring meta-plugin (ARCH-003
 * Decision 3, `.agents/specs/arch-003-external-plugin-authoring.md`).
 * `stackfold init plugin-scaffold <pluginId>` scaffolds a brand-new,
 * standalone stackfold plugin that needs no `stackfold` repo checkout at
 * all — unlike its sibling `plugin-builder`
 * (`src/plugins/plugin-builder/scaffold.ts`), which is a deliberate
 * self-extension tool scoped to the `stackfold` monorepo itself (it shells
 * out to `npx tsx src/cli/index.ts` and `patchFile`s `stackfold`'s own
 * `src/cli/index.ts`), this plugin's generated output imports the
 * TS-authoring DSL from the installed `stackfold` package's public
 * `"stackfold/authoring"` subpath (ARCH-003 Decision 2), never a relative
 * monorepo path, and patches nothing — there is no `stackfold`-internal
 * file to patch for an external plugin. Its final `postInit` step prints
 * the exact `stackfold plugin register` command the author runs next.
 *
 * Convention (same one `plugin-builder` already establishes for its own
 * use case — "Intended to be run from the root of a stackfold checkout" —
 * generalized here for an arbitrary author, with no repo-root assumption):
 * run `stackfold init plugin-scaffold <pluginId>` from whatever directory
 * the new plugin's own folder should be created in, using `<pluginId>`
 * itself as the target directory argument. The orchestrator's `targetDir`
 * (`resolve(cwd, directory)`, `cli/commands/init.ts`) then becomes exactly
 * the new plugin's own root. This is required, not optional:
 * `postInit`/`preInit`/`postWrite` hooks (`core/orchestrator.ts`'s
 * `runHooks()`) never receive `targetDir` at all — only `ports`/`answers`
 * — so the only way this plugin's `postInit` hook can run `stackfold
 * scaffold synth` against the right directory is by using `{{pluginId}}`
 * itself as a path relative to the real invoking process's cwd
 * (`runHookCommand`'s own documented "never `targetDir`, always the real
 * invoking process's cwd" semantics — `core/authoring.ts`'s
 * `runHookCommand` header comment), the exact mechanism `plugin-builder`
 * already relies on for its own `src/plugins/<pluginId>` convention, here
 * without the `src/plugins/` prefix since an external author has no such
 * tree.
 *
 * `postWrite` hook (review_report.md Blocking finding, ARCH-003 follow-up):
 * a fail-fast guard for the directory-argument/pluginId coupling above.
 * `HookPorts`/`HookHandler` (`core/types.ts`) never hand a hook `targetDir`
 * at all — confirmed empirically, not assumed — so no hook stage can see
 * the real directory argument directly; `preInit` runs before any file
 * exists either way, so it cannot distinguish a match from a mismatch.
 * `postWrite` is the earliest stage at which the mismatch *is* observable:
 * once files are written, the just-written `scaffold.ts` really is at
 * `<real cwd>/<directory argument>/scaffold.ts`, so checking for it at
 * `<real cwd>/<pluginId>/scaffold.ts` — the exact path `postInit`'s synth
 * step below is about to assume — tells the two cases apart. Implemented
 * as a tiny `node -e` check via the same `runHookCommand` vocabulary
 * `postInit` already uses (never a new `core/authoring.ts` action — out of
 * this task's scope), so a mismatch fails with a clear, actionable message
 * instead of the synth step's confusing "Cannot find module" error.
 *
 * `postInit` hook order: (1) `runHookCommand` → `stackfold scaffold synth
 * <pluginId>` against the real invoking process's cwd — safe to resolve
 * correctly from anywhere now that ARCH-003 Decision 1 anchors `synth()`'s
 * output path to the compiled `scaffold.ts`'s own directory, never
 * `process.cwd()`; (2) a second `runHookCommand` that merely prints the
 * exact `stackfold plugin register <pluginId>/scaffold.json` command for
 * the author to run next.
 *
 * The 4 questions and their constraints are identical to `plugin-builder`'s
 * own (same reused, hoisted `QuestionConstraints` constants — SYNTH-002 D5,
 * `.agents/specs/synth-002-declarative-validation.md` — rather than a
 * second, parallel definition). Declarative `constraints` (not a `validate`
 * closure) survive `scaffold synth` into this plugin's own `scaffold.json`
 * (which this file — unlike `plugin-builder` — has none committed of its
 * own; its generated end-user plugin's `scaffold.json` is a different file
 * entirely, written per-registration).
 */
import { defineScaffold, step } from '../../authoring/builder.js';
import { loadTemplate } from '../../authoring/templateLoader.js';
import {
  authorConstraints,
  descriptionConstraints,
  pluginIdConstraints,
  pluginIdSchema,
} from '../../core/validation.js';

export { pluginIdSchema };

export const DEFAULT_PLUGIN_ID = 'my-plugin';
export const DEFAULT_DISPLAY_NAME = 'My Plugin';
export const DEFAULT_PLUGIN_DESCRIPTION = 'A stackfold plugin.';
export const DEFAULT_AUTHOR = '';

/**
 * The 4 sibling `.hbs` templates loaded here, once, at module-evaluation
 * time (same convention every other `scaffold.ts`'s own `loadTemplate()`
 * calls already use): the generated plugin's own
 * `templates/readme.md.hbs`, `scaffold.ts`, `scaffold.test.ts`, and
 * `package.json`. Each is Handlebars-rendered against plugin-scaffold's
 * *own* answers (`writeFile`'s existing `content` mechanism,
 * `core/authoring.ts`) when `buildBlueprint()` runs below — the
 * `{{pluginId}}`/`{{displayName}}`/`{{description}}` placeholders inside
 * each one are substituted at that point, so the generated plugin's own
 * files land on disk with those values already literal.
 */
const README_TEMPLATE = loadTemplate(import.meta.dirname, 'templates/readme.md.hbs');
const SCAFFOLD_TS_TEMPLATE = loadTemplate(import.meta.dirname, 'templates/scaffold.ts.hbs');
const SCAFFOLD_TEST_TS_TEMPLATE = loadTemplate(import.meta.dirname, 'templates/scaffold.test.ts.hbs');
const PACKAGE_JSON_TEMPLATE = loadTemplate(import.meta.dirname, 'templates/package.json.hbs');

export default defineScaffold({
  id: 'plugin-scaffold',
  description:
    'Scaffolds a brand-new, standalone stackfold plugin that needs no repo checkout — authored as a TS ' +
    'scaffold.ts importing the public "stackfold/authoring" DSL, synthesized via a real `stackfold scaffold ' +
    "synth` invocation, with the exact `stackfold plugin register` command printed at the end.",
  help: {
    name: 'Plugin Scaffold',
    details:
      'Generates a new, standalone stackfold plugin as a TS-authored scaffold.ts + sibling .hbs templates + ' +
      'its own package.json ("type": "module"), importing the authoring DSL from the installed "stackfold" ' +
      'package itself — no repo checkout needed. Synthesizes its canonical scaffold.json via a real ' +
      '`stackfold scaffold synth` invocation, then prints the exact `stackfold plugin register` command to ' +
      'run next. Run `stackfold init plugin-scaffold <pluginId>` from the directory the new plugin should be ' +
      'created in (its own root ends up being exactly that directory).',
  },

  questions: [
    {
      id: 'pluginId',
      message: 'Plugin id (kebab-case, e.g. "my-cool-plugin")',
      type: 'input',
      default: DEFAULT_PLUGIN_ID,
      constraints: pluginIdConstraints,
    },
    {
      id: 'displayName',
      message: 'Display name (shown in `stackfold list`/`info`)',
      type: 'input',
      default: DEFAULT_DISPLAY_NAME,
      constraints: descriptionConstraints,
    },
    {
      id: 'description',
      message: 'Short description (shown in listings)',
      type: 'input',
      default: DEFAULT_PLUGIN_DESCRIPTION,
      constraints: descriptionConstraints,
    },
    {
      id: 'author',
      message: 'Author',
      type: 'input',
      default: DEFAULT_AUTHOR,
      constraints: authorConstraints,
    },
  ],

  // Literal paths (unlike plugin-builder's pluginId-prefixed ones): this
  // plugin's own `targetDir` IS the new plugin's root (see this module's
  // header comment on the required directory-argument convention), so
  // every generated file lands directly at the top level, no pluginId
  // prefix needed.
  steps: [
    step('writeFile', { path: 'templates/readme.md.hbs', content: README_TEMPLATE }),
    step('writeFile', {
      path: 'scaffold.ts',
      content: SCAFFOLD_TS_TEMPLATE,
      // Same apostrophe-escaping fix as plugin-builder's own scaffold.ts
      // step (review_report.md Blocking #2, Task 042): displayName/
      // description are ordinary free text interpolated into single-quoted
      // TS string literals; an apostrophe would otherwise produce an
      // unterminated string literal. pluginId needs no escaping — its own
      // kebab-case schema already excludes apostrophes.
      jsEscapeKeys: ['displayName', 'description'],
    }),
    step('writeFile', { path: 'scaffold.test.ts', content: SCAFFOLD_TEST_TS_TEMPLATE }),
    step('writeFile', { path: 'package.json', content: PACKAGE_JSON_TEMPLATE }),
  ],

  hooks: {
    postWrite: [
      // Fail-fast guard — see this module's header comment ("postWrite
      // hook"). Checks for "<real cwd>/<pluginId>/scaffold.ts"; if absent,
      // the directory argument given to `stackfold init plugin-scaffold
      // <dir>` did not match the `pluginId` answer, and the process exits
      // non-zero with a clear, actionable message (surfaced as a
      // `HookError` by `core/orchestrator.ts`, same as any other failed
      // `postWrite` handler) instead of letting `postInit`'s synth step
      // fail with a confusing "Cannot find module" error.
      step('runHookCommand', {
        command: 'node',
        args: [
          '-e',
          {
            cat: [
              "const fs=require('fs');const path=require('path');const id='",
              { var: 'pluginId' },
              "';const p=path.join(process.cwd(), id, 'scaffold.ts');if(!fs.existsSync(p)){console.error('plugin-scaffold: expected to find \"'+p+'\" after writing files, but it is missing. This means the init directory argument did not match the pluginId answer (\"'+id+'\"). Re-run: stackfold init plugin-scaffold '+id);process.exit(1);}",
            ],
          },
        ],
      }),
    ],
    postInit: [
      // (1) Synth the just-written scaffold.ts into its canonical
      // scaffold.json — against the real cwd of the invoking process
      // (never targetDir, see this module's header comment), via the
      // bare installed `stackfold` binary (PATH/npx resolution), never
      // `npx tsx src/cli/index.ts` (that invocation style is
      // plugin-builder's self-extension-only mechanism). Safe now that
      // ARCH-003 Decision 1 makes synth()'s output path correct for an
      // arbitrary outDir.
      step('runHookCommand', {
        command: 'stackfold',
        args: ['scaffold', 'synth', { var: 'pluginId' }],
      }),
      // (2) No file to patch — print the exact next command instead.
      step('runHookCommand', {
        command: 'node',
        args: [
          '-e',
          {
            cat: ["console.log('\\nNext: stackfold plugin register ", { var: 'pluginId' }, "/scaffold.json\\n')"],
          },
        ],
      }),
    ],
  },
});
