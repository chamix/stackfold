/**
 * `plugin-builder` — stackfold's own meta-plugin (Task 034,
 * .agents/specs/plugin-builder-scaffold-authoring.md). `stackfold init
 * plugin-builder <dir>` scaffolds a brand-new stackfold plugin authored in
 * the declarative JSON `ScaffoldDefinition` format (D1), and registers the
 * result into stackfold's own `PluginRegistry` by patching
 * `src/cli/index.ts` via the general-purpose `patchFile` hook action (D2/D6)
 * — the first real, non-synthetic consumer of `compileScaffold()` outside
 * unit tests (spec "Grounding findings").
 *
 * This module exports only the pure `ScaffoldDefinition` data (plus the
 * small, injectable default-author resolver below) — never a compiled
 * `StackfoldPlugin` directly. `compileScaffold()` and the concrete
 * `ExpressionEvaluator` adapter are composition-root concerns (Inward
 * Dependency Rule: `plugins/` depends only on `core/`, same as every other
 * plugin's own header comment) — the actual compile happens in
 * `cli/index.ts`, which is the one place already allowed to import `infra/`.
 *
 * Intended to be run from the root of a stackfold checkout — targeting
 * `src/plugins/<pluginId>` — since its whole point (purpose #3 of the spec)
 * is extending stackfold itself, not a third party extending without
 * touching the core (that remains ARCH-001's own, separately-motivated use
 * case). The generated files' relative import depths
 * (`../../core/authoring.js` from the generated test, `../plugins/<id>/...`
 * from `src/cli/index.ts`) assume exactly that layout.
 *
 * `pluginIdSchema` below is a new, kebab-case zod schema, in the same style
 * as `core/validation.ts`'s `appNameSchema` (trim, length bound, a `refine`
 * with a clear message) — defined locally rather than added to
 * `core/validation.ts` itself, which is outside this task's declared scope
 * (.agents/current_scope.json); this keeps the *convention* shared without
 * requiring an edit to a file this task was not authorized to touch.
 *
 * Previously documented limitation, now fixed (review_report.md Blocking
 * item 1, Task 034 follow-up): `displayName`/`description` are free text
 * validated only for structure (`core/validation.ts`'s
 * `descriptionSchema`/`authorSchema` — no control chars, single line,
 * bounded length), not for JSON/JS-string-safety — a value containing a
 * literal `"` previously produced syntactically invalid output in the
 * generated `scaffold.json`. Both `writeFile` steps below that interpolate
 * these two fields into a JSON string-literal position now declare
 * `jsonEscapeKeys: ['displayName', 'description']`, which JSON-escapes
 * exactly those two context values before `content`'s Handlebars render
 * (`core/authoring.ts`'s `escapeForJsonContext()`) — plain TS
 * pre-processing of the Handlebars context object, not a Handlebars
 * helper or JSON Logic operator (still never registered — see that
 * module's header comment). `pluginId` itself carries no such risk: its
 * own schema restricts it to `[a-z0-9-]`.
 */
import { z } from 'zod';
import type { ScaffoldDefinition } from '../../core/authoring.js';
import { authorSchema, descriptionSchema, toValidate } from '../../core/validation.js';

export const DEFAULT_PLUGIN_ID = 'my-plugin';
export const DEFAULT_DISPLAY_NAME = 'My Plugin';
export const DEFAULT_PLUGIN_DESCRIPTION = 'A stackfold plugin.';

/**
 * Kebab-case: lowercase letters/digits, single hyphens, starting with a
 * letter — same convention/style as `core/validation.ts`'s `appNameSchema`
 * (trim, bounded length, a `refine` with a clear message), not a parallel
 * validation scheme (D3). See this module's header comment for why this
 * lives here instead of in `core/validation.ts`.
 */
export const pluginIdSchema = z
  .string()
  .trim()
  .min(1, 'Plugin id must not be empty.')
  .max(100, 'Plugin id must be 100 characters or fewer.')
  .refine(
    (v) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(v),
    'Plugin id must be kebab-case: lowercase letters/digits, single hyphens, starting with a letter.'
  );

export interface PluginBuilderOptions {
  /**
   * Default-author resolution, injected — same discipline as every other
   * concrete adapter in this codebase (`NodeFileWriter`, `ExecaProcessRunner`,
   * `InquirerPrompter`, `JsonLogicExpressionEvaluator`): `cli/index.ts` (the
   * composition root) is the one place that chooses the concrete,
   * `node:child_process`-backed probe (`defaultGitUserName`, now in
   * `infra/fs.ts`) and injects it here — never defaulted inside this
   * plugin module (review follow-up, Should-fix #2). Required, not
   * optional: there is no plugin-module-local default left to fall back
   * to, by design.
   *
   * Open item resolution (spec, "Open item carried into Step 2"): the
   * author default **must** be a synchronous read, not a `preInit` hook. A
   * `QuestionDefinition.default` has to be a plain value already present
   * on the question *before* `ports.prompter.ask()` ever runs — and
   * `runPlugin()`'s fixed step order (`core/orchestrator.ts`) only reaches
   * `preInit` *after* `ask()` returns. By the time a `preInit` hook could
   * run, the prompt (and whatever default it showed) has already happened
   * — a hook can never retroactively change what default the user was
   * shown. A synchronous read is therefore the only mechanism that can
   * possibly work here, not merely the simpler one; see `infra/fs.ts`'s
   * `defaultGitUserName()` doc comment for the rest of that reasoning.
   */
  gitUserName: () => string;
}

/**
 * Uniformly treats a failure of `gitUserName` — the real default
 * (`infra/fs.ts`'s `defaultGitUserName`), or any injected override — as
 * "nothing to give" and falls back to `''`, the same "author is optional,
 * empty when not supplied" convention `web-app`/`electron-ts` already use
 * (`DEFAULT_AUTHOR = ''`) — never a thrown error, since an absent git
 * identity is an expected, common environment, not a bug.
 *
 * Narrowed (review follow-up, Should-fix #3): only a thrown `Error` is
 * treated this way. `gitUserName`'s signature (`() => string`) carries no
 * typed error contract, so this is the most precise net that can be cast
 * without coupling this generic resolver to one specific probe's error
 * shape — a thrown non-`Error` value (a string, a number — never how a
 * failed `execSync()` or an ordinary injected override fails) is treated
 * as unexpected and rethrown rather than silently swallowed, instead of
 * the previous blanket `catch {}`, which caught literally anything.
 */
function resolveDefaultAuthor(gitUserName: () => string): string {
  try {
    return gitUserName();
  } catch (err) {
    if (err instanceof Error) return '';
    throw err;
  }
}

/**
 * The generated plugin's own manifest (D1 — authored in the declarative
 * JSON `ScaffoldDefinition` format). Handlebars-templated against the real
 * answers (same mechanism as every other `writeFile` built-in; this is the
 * literal, author-written `content` for the *outer* writeFile step below —
 * `\\n` sequences here are literal two-character escapes, deliberately
 * preserved so the *inner* JSON's own string value contains real newlines
 * once parsed, not a line break in this outer template itself).
 */
const PLUGIN_MANIFEST_TEMPLATE = `{
  "id": "{{pluginId}}",
  "description": "{{description}}",
  "help": { "name": "{{displayName}}" },
  "questions": [],
  "steps": [
    { "action": "writeFile", "params": { "path": "README.md", "content": "# {{displayName}}\\n\\n{{description}}\\n" } }
  ]
}
`;

/**
 * Minimal vitest test, generated alongside the manifest, proving it parses
 * against the authoring system's own zod schemas (functional domain's
 * Output contract: "a passing test that proves the definition parses").
 * Assumes the conventional `src/plugins/<pluginId>/` depth back to
 * `src/core/`/`src/infra/` (see this module's header comment).
 */
const PLUGIN_TEST_TEMPLATE = `import { describe, expect, it } from 'vitest';
import { compileScaffold } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition from './scaffold.json' with { type: 'json' };

describe('{{pluginId}} — generated ScaffoldDefinition', () => {
  it('parses/compiles via compileScaffold() without throwing', () => {
    expect(() => compileScaffold(definition, new JsonLogicExpressionEvaluator())).not.toThrow();
  });
});
`;

/** `src/cli/index.ts`'s one-time anchor markers (purely additive — see that file). */
const IMPORTS_ANCHOR = '// stackfold-plugin-imports:end';
const REGISTRY_ANCHOR = '// stackfold-plugin-registry:end';

/**
 * Builds `plugin-builder`'s own `ScaffoldDefinition`. A factory, not a bare
 * constant, so tests can inject `gitUserName` and avoid a real `git` call
 * (same reason `createElectronTsPlugin()` takes an options bag for `now`).
 */
export function createPluginBuilderDefinition(options: PluginBuilderOptions): ScaffoldDefinition {
  const defaultAuthor = resolveDefaultAuthor(options.gitUserName);

  return {
    id: 'plugin-builder',
    description:
      "Scaffolds a brand-new stackfold plugin, authored declaratively (a ScaffoldDefinition), and registers it into stackfold's own plugin registry.",
    help: {
      name: 'Plugin Builder',
      details:
        'Generates a new stackfold plugin as a declarative ScaffoldDefinition (JSON) under ' +
        'src/plugins/<pluginId>/, plus a vitest test proving it parses, and registers it into ' +
        'src/cli/index.ts via the patchFile hook action. Run from the root of a stackfold checkout.',
    },

    questions: [
      {
        id: 'pluginId',
        message: 'Plugin id (kebab-case, e.g. "my-cool-plugin")',
        type: 'input',
        default: DEFAULT_PLUGIN_ID,
        validate: toValidate(pluginIdSchema),
      },
      {
        id: 'displayName',
        message: 'Display name (shown in `stackfold list`/`info`)',
        type: 'input',
        default: DEFAULT_DISPLAY_NAME,
        validate: toValidate(descriptionSchema),
      },
      {
        id: 'description',
        message: 'Short description (shown in listings)',
        type: 'input',
        default: DEFAULT_PLUGIN_DESCRIPTION,
        validate: toValidate(descriptionSchema),
      },
      {
        id: 'author',
        message: 'Author',
        type: 'input',
        default: defaultAuthor,
        validate: toValidate(authorSchema),
      },
    ],

    steps: [
      {
        action: 'writeFile',
        params: {
          path: { cat: [{ var: 'pluginId' }, '/scaffold.json'] },
          content: PLUGIN_MANIFEST_TEMPLATE,
          // Blocking item 1 (review_report.md): `displayName`/`description`
          // both land inside a JSON string-literal position in
          // PLUGIN_MANIFEST_TEMPLATE (`"description": "{{description}}"`,
          // `"help": { "name": "{{displayName}}" }`, and again inside the
          // nested README `content` string) — JSON-escaped before render
          // so ordinary, schema-accepted free text (e.g. a literal `"`)
          // can never produce invalid JSON. `pluginId` needs no entry here
          // — its own schema already restricts it to `[a-z0-9-]`.
          jsonEscapeKeys: ['displayName', 'description'],
        },
      },
      {
        action: 'writeFile',
        params: {
          path: { cat: [{ var: 'pluginId' }, '/scaffold.test.ts'] },
          content: PLUGIN_TEST_TEMPLATE,
        },
      },
    ],

    hooks: {
      postInit: [
        // Import line: the two symbols the registry-entry step below needs
        // to compile+register the generated manifest. Not pluginId-specific
        // — `cli/index.ts`'s own wiring of `plugin-builder` itself already
        // adds these, so in practice this step is idempotent from the very
        // first run; it stays self-healing (and exercises the mechanism for
        // real, D5/purpose #1) if that wiring were ever missing.
        {
          action: 'patchFile',
          params: {
            path: 'src/cli/index.ts',
            anchor: IMPORTS_ANCHOR,
            insert: {
              cat: [
                "import { compileScaffold } from '../core/authoring.js';\n",
                "import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';\n",
              ],
            },
            position: 'before',
          },
        },
        // Registry entry: pluginId-specific — a fresh, unique line per
        // generated plugin. Deliberately a dynamic `import()` of the JSON
        // manifest (top-level await, same as `cli/index.ts`'s own
        // `await program.parseAsync()`) compiled inline via the already-
        // imported `compileScaffold()`/`expressionEvaluator` — this needs
        // no JS identifier derived from `pluginId` (kebab-case is not a
        // valid identifier) and so never collides across multiple
        // plugin-builder runs for different plugin ids.
        {
          action: 'patchFile',
          params: {
            path: 'src/cli/index.ts',
            anchor: REGISTRY_ANCHOR,
            insert: {
              cat: [
                "  compileScaffold((await import('../plugins/",
                { var: 'pluginId' },
                "/scaffold.json', { with: { type: 'json' } })).default, expressionEvaluator),\n",
              ],
            },
            position: 'before',
          },
        },
      ],
    },
  };
}
