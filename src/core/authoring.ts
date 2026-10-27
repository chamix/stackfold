/**
 * Declarative scaffold authoring (ARCH-001 Step 1 item 4,
 * .agents/specs/arch-001-scaffold-authoring.md). Structural peer of
 * `core/composition.ts`, not a replacement: a `ScaffoldDefinition` compiles
 * to a `StackfoldPlugin` via `compileScaffold()`, which registers like any
 * hand-written plugin — the orchestrator never knows the difference.
 *
 * Inward Dependency Rule: depends only on `core/types.ts`, `core/ports.ts`,
 * and `core/composition.ts` (consumed as a black box — never modified here,
 * so its collision/merge contract can't drift). No `infra/`/`cli/` import.
 * `handlebars` is used directly (same precedent as `zod` in
 * `core/validation.ts` — a third-party pure-JS library is not an outer
 * architectural layer); `json-logic-js` itself is never imported here —
 * only the `ExpressionEvaluator` port, per `infra/expressionEvaluator.ts`'s
 * header comment.
 *
 * Security (`.claude/knowledge/nodejs/security.md` "Untrusted code
 * execution"): Handlebars templates compiled here come from the
 * `ScaffoldDefinition` itself — a trusted, author-written template, never
 * unvalidated external input. This is actively enforced, not merely
 * asserted: `writeFile` declares `content` as a `literalKeys`
 * entry (see `ActionKind`/`resolveParams()` below), so expression
 * resolution never runs on `content` at all — it always reaches
 * `compileTemplate()` as the definition's own literal string, never a
 * value derived from live `answers`. (A scaffold author who passes an
 * expression-shaped value as `content` — e.g. `{ var: 'x' }` — gets a
 * clear zod validation failure at `writeFileSchema.parse()`, since
 * `content: z.string()` rejects a plain object; it is never silently
 * resolved anyway.) Only the interpolated *values* come from `answers`,
 * which are already structurally validated at the `Prompter` boundary
 * (SEC-001, `core/validation.ts`) before they ever reach here.
 * `noEscape: true` is deliberate: these are generated source/config files,
 * not HTML — default HTML-escaping would corrupt legitimate values (an
 * author name with an `&`, for instance). No custom Handlebars helper is
 * ever registered — Handlebars stays logic-less, same spirit as the
 * expression evaluator never growing a custom operator.
 */
import Handlebars from 'handlebars';
import { z } from 'zod';
import { composeBlueprint, type FileContribution, type MergeStrategy } from './composition.js';
import type { ExpressionEvaluator } from './ports.js';
import { toBridgeGlobal, toPackageName } from './stringTransforms.js';
import type {
  Answers,
  HookHandler,
  HookName,
  HookPorts,
  PluginHelp,
  PostActionDefinition,
  ProjectBlueprint,
  QuestionDefinition,
  StackfoldPlugin,
} from './types.js';

// ---------------------------------------------------------------------------
// Vocabulary registry — Command pattern as data (GoF), a generic Registry
// ---------------------------------------------------------------------------

/**
 * What a registered action name resolves to. Exactly one of three
 * categories (ARCH-001 Step 0's abstract domain):
 *   - `compose` — pure, produces a `FileContribution` (what
 *     `composeBlueprint()` already consumes).
 *   - `process` — pure, produces one of the existing `PostActionDefinition`
 *     kinds (Invariant C: never a new process-launching mechanism).
 *   - `hook`    — impure, runs with the 3 real ports (Invariant A).
 *
 * `resolve`/`handler` take `params: unknown`, not the schema's inferred
 * type: `ActionKind` is stored type-erased in a single heterogeneous
 * registry (a `Map`), so it can't carry a generic per-entry. Each
 * registration owns both its `schema` and its `resolve`/`handler`, and may
 * safely assume — because `compileScaffold()` always calls
 * `schema.parse()` before calling `resolve`/`handler` — that what arrives
 * already satisfies that schema.
 *
 * `literalKeys` names top-level `params` keys that must never be
 * expression-resolved, even though everything else in `params` is walked
 * for `{ var: ... }`-shaped expressions (see `resolveParams()` below). Only
 * the action's own registration knows which of its fields carry semantics
 * incompatible with "may be computed from live answers" — `writeFile`
 * uses this for `content`, which must stay the `ScaffoldDefinition`'s own
 * literal, author-written string, since it is later compiled as a
 * Handlebars template against `answers`.
 */
export type ActionKind =
  | {
      tag: 'compose';
      schema: z.ZodType;
      resolve: (params: unknown, ctx: Record<string, unknown>) => FileContribution;
      literalKeys?: readonly string[];
    }
  | {
      tag: 'process';
      schema: z.ZodType;
      resolve: (params: unknown, ctx: Record<string, unknown>) => PostActionDefinition;
      literalKeys?: readonly string[];
    }
  | {
      tag: 'hook';
      schema: z.ZodType;
      handler: (params: unknown, ports: HookPorts, answers: Answers) => void | Promise<void>;
      literalKeys?: readonly string[];
    };

const registry = new Map<string, ActionKind>();

/** Registers (or overwrites) a named action in the vocabulary. */
export function registerAction(name: string, kind: ActionKind): void {
  registry.set(name, kind);
}

/** Looks up a registered action by name; `undefined` if nothing is registered under it. */
export function resolveAction(name: string): ActionKind | undefined {
  return registry.get(name);
}

// ---------------------------------------------------------------------------
// ScaffoldDefinition — the authoring-time, in-memory domain model
// ---------------------------------------------------------------------------

/** A single Command-as-data step: an action name plus its opaque params. */
export interface ActionStep {
  action: string;
  params: unknown;
  /**
   * JSONLogic expression (or a literal boolean) evaluated against
   * `answers` before this step runs (Task 035). Absent ⇒ the step always
   * runs — zero behavior change for any `ScaffoldDefinition` that predates
   * this field. If it evaluates falsy, the step is skipped entirely: for
   * compose/process, no `FileContribution`/`PostActionDefinition` is
   * added (and `resolveParams()`/`schema.parse()` never run for it — the
   * unchosen branch doesn't need valid params); for a hook step, the
   * handler is never invoked.
   */
  when?: unknown;
}

export interface ScaffoldDefinition {
  id: string;
  description: string;
  help?: PluginHelp;
  questions: QuestionDefinition[];
  /** compose + process actions, in order — compiled into the blueprint. */
  steps: ActionStep[];
  /** hook actions only, keyed by lifecycle moment — compiled into `HookHandler[]`. */
  hooks?: Partial<Record<HookName, ActionStep[]>>;
  /**
   * Optional (Task 044, UX-001/SK-ADR-004): resolves onto
   * `ProjectBlueprint.mainFile`. Same literal-or-JSONLogic contract as
   * `ActionStep.when` above — a plain value is used as-is, a JSONLogic
   * expression is evaluated against `answers` via the injected
   * `ExpressionEvaluator`. Absent ⇒ the compiled blueprint has no
   * `mainFile` key at all (never `mainFile: undefined`) — zero behavior
   * change for every `ScaffoldDefinition` that predates this field.
   */
  mainFile?: unknown;
}

/**
 * Compiles an in-memory `ScaffoldDefinition` into a `StackfoldPlugin`,
 * indistinguishable at runtime from a hand-written one. Synchronous and
 * pure except for the resulting `HookHandler`s, which are impure by nature
 * (Invariant E) and only ever run later, when the orchestrator calls them.
 */
export function compileScaffold(definition: ScaffoldDefinition, evaluator: ExpressionEvaluator): StackfoldPlugin {
  const hooks = definition.hooks ? compileHooks(definition.hooks, evaluator) : undefined;

  return {
    id: definition.id,
    description: definition.description,
    ...(definition.help ? { help: definition.help } : {}),
    ...(hooks ? { hooks } : {}),

    questions(): QuestionDefinition[] {
      return definition.questions;
    },

    buildBlueprint(answers: Answers): ProjectBlueprint {
      const contributions: FileContribution[] = [];
      const postActions: PostActionDefinition[] = [];

      for (const step of definition.steps) {
        if (isGatedOff(step, evaluator, answers)) {
          continue;
        }

        const kind = resolveAction(step.action);
        if (!kind) {
          throw new Error(`Scaffold "${definition.id}" references unknown action "${step.action}"`);
        }
        if (kind.tag === 'hook') {
          throw new Error(
            `Scaffold "${definition.id}": action "${step.action}" is a "hook" action and cannot appear in ` +
              '"steps" (compose/process only) — declare it under "hooks" instead'
          );
        }

        const resolvedParams = resolveParams(step.params, evaluator, answers, kind.literalKeys);
        const parsedParams: unknown = kind.schema.parse(resolvedParams);

        if (kind.tag === 'compose') {
          contributions.push(kind.resolve(parsedParams, answers));
        } else {
          postActions.push(kind.resolve(parsedParams, answers));
        }
      }

      // `composeBlueprint()` (`core/composition.ts`) is consumed as a black
      // box, unmodified: it already resolves the collision/merge question
      // (exclusive/json-merge/append) for the files this scaffold
      // contributes. One fragment, since a single `ScaffoldDefinition`
      // compiles to a single plugin.
      const composed = composeBlueprint([{ id: definition.id, files: contributions }]);
      return {
        files: composed.files,
        postActions: [...composed.postActions, ...postActions],
        ...(definition.mainFile !== undefined
          ? { mainFile: evaluator.evaluate(definition.mainFile, answers) as string }
          : {}),
      };
    },
  };
}

function compileHooks(
  hooks: Partial<Record<HookName, ActionStep[]>>,
  evaluator: ExpressionEvaluator
): Partial<Record<HookName, HookHandler[]>> {
  const compiled: Partial<Record<HookName, HookHandler[]>> = {};

  for (const hookName of Object.keys(hooks) as HookName[]) {
    const steps = hooks[hookName];
    if (!steps) continue;
    compiled[hookName] = steps.map((step) => compileHookStep(step, evaluator));
  }

  return compiled;
}

function isGatedOff(step: ActionStep, evaluator: ExpressionEvaluator, answers: Answers): boolean {
  return step.when !== undefined && !evaluator.evaluate(step.when, answers);
}

function compileHookStep(step: ActionStep, evaluator: ExpressionEvaluator): HookHandler {
  return async (ports: HookPorts, answers: Answers): Promise<void> => {
    if (isGatedOff(step, evaluator, answers)) {
      return;
    }

    const kind = resolveAction(step.action);
    if (!kind) {
      throw new Error(`Unknown action "${step.action}" referenced under "hooks"`);
    }
    if (kind.tag !== 'hook') {
      throw new Error(`Action "${step.action}" is registered as "${kind.tag}", not "hook" — cannot run as a hook`);
    }

    const resolvedParams = resolveParams(step.params, evaluator, answers, kind.literalKeys);
    const parsedParams: unknown = kind.schema.parse(resolvedParams);
    await kind.handler(parsedParams, ports, answers);
  };
}

// ---------------------------------------------------------------------------
// Expression resolution (ARCH-001 Step 1 item 4, pipeline step 1)
// ---------------------------------------------------------------------------

/**
 * Resolves every "expression-shaped" value nested inside `params` against
 * `answers`, before an action ever sees it. Convention (undocumented at the
 * type level, since `ActionStep.params` is intentionally opaque `unknown`):
 * a plain object found *within* `params` — anywhere except `params` itself
 * — is a JSON Logic rule (e.g. `{ "var": "appName" }`) and is evaluated
 * wholesale via `evaluator.evaluate()`; `params` itself is the action's own
 * data shape, never evaluated as a whole. Arrays are walked element-by-
 * element so an expression can appear as one entry among literals (e.g. a
 * `runCommand` arg list). Primitives pass through unchanged.
 *
 * `literalKeys` (from the action's own `ActionKind` registration) carves
 * out an exception: a top-level `params` key named in it is passed through
 * completely untouched — not walked, not expression-resolved — because
 * that field's value must remain the `ScaffoldDefinition`'s own literal
 * authoring-time data (see `writeFile`'s `content`, and this module's
 * header comment). If the author passed an expression there
 * anyway, it reaches the action's zod schema as a plain object/array
 * rather than a resolved value, so `schema.parse()` is what rejects it.
 */
function resolveParams(
  params: unknown,
  evaluator: ExpressionEvaluator,
  answers: Answers,
  literalKeys: readonly string[] = []
): unknown {
  if (literalKeys.length === 0 || !isPlainObject(params)) {
    return resolveValue(params, evaluator, answers, true);
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    resolved[key] = literalKeys.includes(key) ? val : resolveValue(val, evaluator, answers);
  }
  return resolved;
}

function resolveValue(value: unknown, evaluator: ExpressionEvaluator, answers: Answers, isContainer = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, evaluator, answers));
  }

  if (isPlainObject(value)) {
    if (isContainer) {
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = resolveValue(val, evaluator, answers);
      }
      return resolved;
    }
    return evaluator.evaluate(value, answers);
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

// ---------------------------------------------------------------------------
// Built-in actions (Invariant B — a JSON-only scaffold needs zero of these
// written in TypeScript). Each declares its own zod schema for `params`,
// consistent with `core/validation.ts`'s SEC-001 convention.
// ---------------------------------------------------------------------------

const mergeStrategySchema: z.ZodType<MergeStrategy> = z.enum(['exclusive', 'json-merge', 'append']);

const mkdirSchema = z.object({
  path: z.string().trim().min(1, 'mkdir requires a non-empty "path"'),
});

const writeFileSchema = z.object({
  path: z.string().trim().min(1, 'writeFile requires a non-empty "path"'),
  content: z.string(),
  strategy: mergeStrategySchema.optional(),
  /**
   * Names of top-level context (answers) keys whose *string* value must be
   * JSON-string-escaped before `content` is Handlebars-rendered (Task 034
   * review follow-up, review_report.md Blocking item 1) — for a scaffold
   * author whose `content` places a free-text answer inside a JSON
   * string-literal position (e.g. a generated `scaffold.json`). Resolved by
   * `escapeForJsonContext()` below: plain TS pre-processing of the
   * Handlebars context object, never a Handlebars helper or a JSON Logic
   * operator (this module's header comment) — `content`'s own
   * interpolation mechanism is untouched; only the values it sees are
   * pre-escaped. Omitted (or empty) reproduces today's behavior exactly.
   */
  jsonEscapeKeys: z.array(z.string()).optional(),
  /**
   * Names of top-level context (answers) keys whose *string* value must be
   * escaped for a single-quoted JS/TS string-literal position before
   * `content` is Handlebars-rendered (Task 042 review follow-up,
   * review_report.md Blocking item 2) — for a scaffold author whose
   * `content` places a free-text answer inside a single-quoted TS string
   * literal (e.g. a generated `scaffold.ts`), where an unescaped apostrophe
   * would otherwise produce an unterminated string literal. Resolved by
   * `escapeForJsContext()` below: plain TS pre-processing of the Handlebars
   * context object, independent of (and composable with) `jsonEscapeKeys`
   * — same shape, same never-answers-controlled author-chosen-list
   * reasoning, different escaping target. Omitted (or empty) reproduces
   * today's behavior exactly.
   */
  jsEscapeKeys: z.array(z.string()).optional(),
  /**
   * Names of top-level context (answers) keys whose *string* value must be
   * HTML-escaped (`&` first, then `<`, `>`, `"`, `'`) before `content` is
   * Handlebars-rendered (Task 043, §"Required core/ amendment" —
   * .agents/specs/043-electron-stackfold-web-app-reauthor.md) — for a
   * scaffold author whose `content` places a free-text answer inside an
   * HTML text node or a double-quoted attribute (e.g. a generated
   * `index.html`). Mirrors `jsonEscapeKeys`/`jsEscapeKeys` exactly: same
   * shape, same never-answers-controlled author-chosen-list reasoning,
   * independent and composable with both, different escaping target.
   * Resolved by `escapeForHtmlContext()` below, reusing the exact escaping
   * order the former hand-rolled `web-app/shared-questions.ts`'s
   * `escapeHtml()` already used (Task 014's real XSS fix, carried forward
   * so this port doesn't silently reintroduce it — see
   * `src/plugins/web-app-stackfold/scaffold.ts`'s own header comment).
   * Omitted (or empty) reproduces today's behavior exactly.
   */
  htmlEscapeKeys: z.array(z.string()).optional(),
  /**
   * Names of top-level context (answers) keys whose *string* value must
   * have any case-insensitive `</script` substring broken up (`<\/script`)
   * before `content` is Handlebars-rendered (Task 043 review follow-up,
   * approved alongside `htmlEscapeKeys` above) — for a scaffold author
   * whose `content` places a free-text answer inside a Vue SFC's `<script
   * setup>` block (e.g. a generated `App.vue`), where the SFC parser scans
   * for that literal tag-closing text during its own tag-scanning parse
   * phase, with no awareness of JS string-literal context — an unescaped
   * `</script` there would split the file into two sibling `<script>`
   * blocks regardless of what valid JS surrounds it. Mirrors
   * `jsonEscapeKeys`/`jsEscapeKeys`/`htmlEscapeKeys` exactly: same shape,
   * same never-answers-controlled author-chosen-list reasoning,
   * independent and composable with all three, different escaping target.
   * Resolved by `escapeScriptCloseContext()` below, reusing the exact
   * `escapeScriptClose()` transform the former
   * `web-app/fragments/vite-vue.ts` already used. Omitted (or empty)
   * reproduces today's behavior exactly.
   */
  scriptCloseEscapeKeys: z.array(z.string()).optional(),
});

const runCommandSchema = z.object({
  command: z.string().trim().min(1, 'runCommand requires a non-empty "command"'),
  args: z.array(z.string()).default([]),
});

/** `npmInstall`/`gitInit` take no params — any key at all is a scaffold-authoring mistake. */
const noParamsSchema = z.object({}).strict();

function compileTemplate(content: string, ctx: Record<string, unknown>): string {
  // `noEscape: true` — see this module's header comment.
  const template = Handlebars.compile(content, { noEscape: true, strict: false });
  return template(ctx);
}

/**
 * Shallow copy of `ctx` with each named key's *string* value replaced by
 * its JSON-string-escaped inner content — `JSON.stringify(value).slice(1,
 * -1)`, the escaped characters only, assuming the template itself already
 * supplies the surrounding quotes (true of every current call site). Keys
 * absent from `ctx`, and non-string values, pass through unchanged. Plain
 * TS, not a Handlebars helper — see `writeFileSchema`'s `jsonEscapeKeys`
 * doc comment for why.
 */
function escapeForJsonContext(ctx: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const escaped: Record<string, unknown> = { ...ctx };
  for (const key of keys) {
    const value = escaped[key];
    if (typeof value === 'string') {
      escaped[key] = JSON.stringify(value).slice(1, -1);
    }
  }
  return escaped;
}

/**
 * Shallow copy of `ctx` with each named key's *string* value replaced by
 * its single-quoted-JS/TS-string-literal-escaped form — backslashes
 * escaped first, then single quotes (order matters: escaping the quote
 * first would re-escape the backslash just introduced, under-escaping the
 * result) — assuming the template itself already supplies the surrounding
 * single quotes (true of every current call site). Also escapes newlines/
 * carriage returns, since a literal line break breaks a single-line string
 * literal the same way an unescaped quote does. Keys absent from `ctx`,
 * and non-string values, pass through unchanged. Plain TS, not a
 * Handlebars helper — see `writeFileSchema`'s `jsEscapeKeys` doc comment
 * for why.
 */
function escapeForJsContext(ctx: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const escaped: Record<string, unknown> = { ...ctx };
  for (const key of keys) {
    const value = escaped[key];
    if (typeof value === 'string') {
      escaped[key] = value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
    }
  }
  return escaped;
}

/**
 * Shallow copy of `ctx` with each named key's *string* value replaced by
 * its HTML-escaped form — `&` first (so it never double-escapes the
 * entities it just produced), then `<`, `>`, `"`, `'` — assuming the
 * template itself places the value inside an HTML text node or a
 * double-quoted attribute (true of every current call site). Keys absent
 * from `ctx`, and non-string values, pass through unchanged. Plain TS, not
 * a Handlebars helper — see `writeFileSchema`'s `htmlEscapeKeys` doc
 * comment for why. Same five-character escaping order as the former
 * hand-rolled `web-app/shared-questions.ts`'s `escapeHtml()` (Task 014) —
 * reused here, not re-derived, so this port carries the exact same
 * protection forward.
 *
 * Exported (Task 043 review follow-up, `tests/unit/core-validation-injection.test.ts`'s
 * SEC-001a adversarial matrix): the former `web-app/shared-questions.ts`'s
 * `escapeHtml()` was a standalone, directly-testable sink; once `web-app/`
 * is deleted, this is the one surviving equivalent — exported so that
 * shared matrix can still unit-test the escaping sink itself directly,
 * independent of any one plugin's `buildBlueprint()` composition.
 */
export function escapeForHtmlContext(ctx: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const escaped: Record<string, unknown> = { ...ctx };
  for (const key of keys) {
    const value = escaped[key];
    if (typeof value === 'string') {
      escaped[key] = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  }
  return escaped;
}

/**
 * Shallow copy of `ctx` with each named key's *string* value replaced by
 * a version where every case-insensitive `</script` substring has a
 * backslash inserted before the `/` (`<\/script`) — a semantically inert
 * JS-string escape (`"\/"` evaluates to `"/"` at runtime) that still
 * breaks up the exact character sequence a Vue SFC's own tag-scanning
 * parser looks for, independent of any surrounding JS string-literal
 * quoting. Keys absent from `ctx`, and non-string values, pass through
 * unchanged. Plain TS, not a Handlebars helper — see `writeFileSchema`'s
 * `scriptCloseEscapeKeys` doc comment for why. Same transform as the
 * former `web-app/fragments/vite-vue.ts`'s own `escapeScriptClose()`.
 */
function escapeScriptCloseContext(ctx: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const escaped: Record<string, unknown> = { ...ctx };
  for (const key of keys) {
    const value = escaped[key];
    if (typeof value === 'string') {
      escaped[key] = value.replace(/<\/script/gi, '<\\/script');
    }
  }
  return escaped;
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

registerAction('mkdir', {
  tag: 'compose',
  schema: mkdirSchema,
  resolve: (params): FileContribution => {
    const { path } = params as z.infer<typeof mkdirSchema>;
    // `ProjectBlueprint`/`FileEntry` model files, not directories — there
    // is no standalone "empty directory" entity to contribute. A
    // conventional empty-directory marker materializes the directory via
    // the normal file-write path, the same trick most flat-file-list
    // scaffolding tools use for this exact gap.
    return { path: `${trimTrailingSlashes(path)}/.gitkeep`, content: '' };
  },
});

registerAction('writeFile', {
  tag: 'compose',
  schema: writeFileSchema,
  // `content` is always the `ScaffoldDefinition`'s own literal string —
  // never expression-resolved — so it's compiled as a Handlebars template
  // against real `answers` without ever becoming an answers-controlled
  // template itself. See this module's header comment and `resolveParams`.
  // `jsonEscapeKeys`/`jsEscapeKeys` join it for the same reason: each names
  // *which* context keys get escaped, an author-chosen list, never an
  // answers-controlled value (see `writeFileSchema`'s own doc comments).
  literalKeys: ['content', 'jsonEscapeKeys', 'jsEscapeKeys', 'htmlEscapeKeys', 'scriptCloseEscapeKeys'],
  resolve: (params, ctx): FileContribution => {
    const { path, content, strategy, jsonEscapeKeys, jsEscapeKeys, htmlEscapeKeys, scriptCloseEscapeKeys } =
      params as z.infer<typeof writeFileSchema>;
    // Independent, composable passes: each only touches the keys it names,
    // in isolation from the other. `scriptCloseEscapeKeys` runs last,
    // after `jsonEscapeKeys`, so a key using both (e.g. a Vue SFC's
    // `const APP_NAME = "{{appName}}";`) gets the exact same result as the
    // old `escapeScriptClose(JSON.stringify(appName))` call order — the
    // script-close guard applies to the already-JSON-escaped text, not the
    // raw answer.
    let renderCtx = ctx;
    if (jsEscapeKeys && jsEscapeKeys.length > 0) renderCtx = escapeForJsContext(renderCtx, jsEscapeKeys);
    if (jsonEscapeKeys && jsonEscapeKeys.length > 0) renderCtx = escapeForJsonContext(renderCtx, jsonEscapeKeys);
    if (htmlEscapeKeys && htmlEscapeKeys.length > 0) renderCtx = escapeForHtmlContext(renderCtx, htmlEscapeKeys);
    if (scriptCloseEscapeKeys && scriptCloseEscapeKeys.length > 0) {
      renderCtx = escapeScriptCloseContext(renderCtx, scriptCloseEscapeKeys);
    }
    return { path, content: compileTemplate(content, renderCtx), ...(strategy ? { strategy } : {}) };
  },
});

registerAction('runCommand', {
  tag: 'process',
  schema: runCommandSchema,
  resolve: (params): PostActionDefinition => {
    const { command, args } = params as z.infer<typeof runCommandSchema>;
    return { kind: 'run-command', command, args };
  },
});

registerAction('npmInstall', {
  tag: 'process',
  schema: noParamsSchema,
  resolve: (): PostActionDefinition => ({ kind: 'npm-install' }),
});

registerAction('gitInit', {
  tag: 'process',
  schema: noParamsSchema,
  resolve: (): PostActionDefinition => ({ kind: 'git-init' }),
});

// ---------------------------------------------------------------------------
// patchFile (Task 034 — .agents/specs/plugin-builder-scaffold-authoring.md,
// "New vocabulary: patchFile"). The only built-in "hook" action today, and a
// general-purpose, reusable one (D6): edits an existing file at a fixed
// anchor line, idempotently. Exists because registering a freshly generated
// plugin into stackfold's own `src/cli/index.ts` (`plugin-builder`) needs to
// *patch an existing file already known to exist* — something no `compose`
// action may ever do (Invariant A: compose/writeFile stays inside
// `targetDir` and never overwrites; patchFile is deliberately a hook, the
// one existing trusted escape valve, and relies on the new
// `FileWriter.readFile()`/`overwriteFile()` pair for exactly that).
//
// `params.path` is resolved relative to `process.cwd()` by the `FileWriter`
// implementation (see `infra/fs.ts`'s `resolve()`) — NOT subject to
// `targetDir` containment, by design (grounding: hooks already run with the
// same unrestricted ports the orchestrator itself has). `core/` still never
// imports node:path/node:fs directly (Inward Dependency Rule): `path` is
// handed to the port as-is.
//
// `literalKeys: ['anchor', 'path']`: `anchor` must always stay the scaffold
// author's own literal, hand-written marker text — never a value an
// expression could redirect — mirroring `writeFile`'s own `content`
// protection (B1) for the same reason (a field whose exact text controls
// *where* a mutation lands must never be computed from free-text answers).
// `path` joins it for the same reason (review follow-up, Should-fix #4):
// unlike `writeFile`'s `path`, contained to `targetDir` via
// `planFiles()`/`checkRelativePath()`, `patchFile` runs as a hook with no
// such containment at all (Invariant A, intentional and unchanged) — so an
// answers-derived `path` would be an uncontained, answer-controlled
// overwrite target with zero validation. `path` is, in practice, always the
// scaffold author's own literal string (a real file never computed from
// end-user free text), so protecting it costs nothing. `insert` is NOT in
// `literalKeys`: it legitimately needs to be computed from `answers` (e.g.
// a generated plugin's own id, via JSON Logic's `cat`/`var`), exactly the
// way `writeFile`'s own non-literal params already support — the existing
// generic `resolveParams()`/`resolveValue()` pipeline below, not a second
// resolution mechanism invented for this one action.
// ---------------------------------------------------------------------------

const patchFileSchema = z.object({
  path: z.string().trim().min(1, 'patchFile requires a non-empty "path"'),
  anchor: z.string().min(1, 'patchFile requires a non-empty "anchor"'),
  insert: z.string(),
  position: z.enum(['before', 'after']),
});

/**
 * Inserts `insert` immediately before/after the line containing `anchor`.
 * Pure string surgery — no node:fs here (Inward Dependency Rule); the I/O
 * lives entirely in the `handler` below, via the injected `FileWriter`.
 */
function insertAtAnchor(content: string, anchor: string, insert: string, position: 'before' | 'after'): string {
  const anchorIndex = content.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`patchFile: anchor ${JSON.stringify(anchor)} not found`);
  }

  if (position === 'before') {
    const lineStart = content.lastIndexOf('\n', anchorIndex - 1) + 1;
    return content.slice(0, lineStart) + insert + content.slice(lineStart);
  }

  const nextNewline = content.indexOf('\n', anchorIndex);
  const insertAt = nextNewline === -1 ? content.length : nextNewline + 1;
  return content.slice(0, insertAt) + insert + content.slice(insertAt);
}

registerAction('patchFile', {
  tag: 'hook',
  schema: patchFileSchema,
  literalKeys: ['anchor', 'path'],
  handler: async (params, ports): Promise<void> => {
    const { path, anchor, insert, position } = params as z.infer<typeof patchFileSchema>;

    const current = await ports.fileWriter.readFile(path);
    if (current === undefined) {
      throw new Error(`patchFile: "${path}" does not exist`);
    }

    // Idempotent: re-running the same registration (or resuming after a
    // previous partial run) never duplicates `insert`.
    if (current.includes(insert)) return;

    const patched = insertAtAnchor(current, anchor, insert, position);
    await ports.fileWriter.overwriteFile(path, patched);
  },
});

// ---------------------------------------------------------------------------
// deriveAnswer (Task 036 — .agents/specs/arch-001-task036-derived-answers.md
// §Step 1 item 5): a hook action that computes a new `answers` entry from an
// existing one, via one of a fixed, closed set of transforms. Exists for the
// `electron-ts` → `electron-stackfold` migration (future work, not part of
// this task), which needs `packageName`/`bridgeGlobal`-shaped values
// available as real `answers` entries a scaffold's own `steps`/`hooks` can
// reference — today those are computed inline inside `templates.ts`'s own
// `resolveContext()`, invisible to a `ScaffoldDefinition`.
//
// `literalKeys: ['from', 'to', 'transform', 'suffix']`: all four are field
// names/mode selectors the scaffold author writes at authoring time — which
// answers key to read, which to write, which transform to run, which fixed
// suffix string to append — never values computed from live `answers`,
// mirroring `patchFile`'s own `path`/`anchor` protection (same rationale: a
// field that controls *where a mutation lands or what kind it is* must never
// be answer-controlled).
//
// Deliberately a closed, 3-case switch, not an action-per-transform or a
// general transformation language: `npm-slug`/`js-identifier-suffix`/
// `current-year` are exactly the three derivations `electron-stackfold`
// needs, reusing `toPackageName`/`toBridgeGlobal` verbatim rather than
// re-implementing them a second time (Invariant: one derivation, one
// implementation). Growing this into a general string-transform DSL is an
// explicit non-goal — a scaffold that needs something this switch doesn't
// cover is a `hook` action of its own, not a new case bolted on here.
//
// `current-year` reads `Date.now()` (via `new Date()`) directly, with no
// injectable clock: `compileScaffold()`'s public signature does not thread a
// clock through to hook handlers, and adding one for this single case isn't
// worth the ripple. The existing `electron-ts` plugin's own `year` field is
// still produced the normal way (`resolveContext(answers, now)`, clock
// injected by its caller) — this transform only matters for a
// `ScaffoldDefinition` that wants a copyright year as a real `answers` entry.
// ---------------------------------------------------------------------------

const deriveAnswerSchema = z
  .object({
    from: z.string().trim().min(1, 'deriveAnswer requires a non-empty "from"'),
    to: z.string().trim().min(1, 'deriveAnswer requires a non-empty "to"'),
    transform: z.enum(['npm-slug', 'js-identifier-suffix', 'current-year']),
    suffix: z.string().optional(),
  })
  // Backlog item (cross-verification Task 036, 2026-10-22; fixed Task
  // 046, 2026-10-27): `suffix` was `z.string().optional()` with no
  // constraint, so a scaffold author could omit it for
  // `js-identifier-suffix` and the handler would silently fall back to
  // `suffix ?? ''` — producing an identifier with NO suffix at all,
  // exactly the case `stringTransforms.ts`'s `toBridgeGlobal()` already
  // documents as unsafe (collision with real `window` globals like
  // `history`/`crypto`). `suffix` is only meaningful for this one
  // transform, so the constraint is expressed as a `.refine()` here
  // rather than restructuring the schema into a discriminated union —
  // the two other transforms (`npm-slug`, `current-year`) never read
  // `suffix` at all.
  .refine(
    (value) =>
      value.transform !== 'js-identifier-suffix' || (value.suffix?.trim().length ?? 0) > 0,
    {
      message: 'deriveAnswer requires a non-empty "suffix" when transform is "js-identifier-suffix"',
      path: ['suffix'],
    },
  );

registerAction('deriveAnswer', {
  tag: 'hook',
  schema: deriveAnswerSchema,
  literalKeys: ['from', 'to', 'transform', 'suffix'],
  handler: (params, _ports, answers): void => {
    const { from, to, transform, suffix } = params as z.infer<typeof deriveAnswerSchema>;
    // Backlog item (same cross-verification, 2026-10-22; fixed Task 046,
    // 2026-10-27): a `from` that doesn't name a real `answers` entry
    // (typo, or an answer never populated) used to silence into `''`
    // via `answers[from] ?? ''`, unlike the rest of the vocabulary
    // (`patchFile` throws if its target doesn't exist; `electron-ts`
    // throws if `appName` is missing). `current-year` is exempt: it
    // never reads `answers[from]` at all (`from` is accepted but
    // unused for that one case, by design — see the file-level comment
    // above this block).
    if (transform !== 'current-year' && answers[from] === undefined) {
      throw new Error(
        `deriveAnswer: answers["${from}"] is undefined — check "from" for a typo or a step ordering issue`,
      );
    }
    switch (transform) {
      case 'npm-slug':
        answers[to] = toPackageName(String(answers[from]));
        break;
      case 'js-identifier-suffix':
        answers[to] = toBridgeGlobal(String(answers[from]), suffix ?? '');
        break;
      case 'current-year':
        answers[to] = new Date().getFullYear();
        break;
    }
  },
});

// ---------------------------------------------------------------------------
// runHookCommand (Task 042, D-B —
// .agents/specs/042-plugin-builder-ts-authoring.md "Nueva vocabulary"). A
// general-purpose, reusable "hook" action that runs an external command via
// `ports.processRunner.run()` with the real invoking process's cwd — never
// `targetDir`. Deliberately the `tag:'hook'` counterpart to the existing
// `runCommand` (`tag:'process'`) action: same params shape (`command`,
// `args`), different tag and a structurally different cwd semantic.
// `runCommand`-as-a-`PostActionDefinition` is always run with `cwd:
// targetDir` (`core/orchestrator.ts`'s `runPostActions()` hardcodes this for
// every `tag:'process'` step) — the wrong cwd for a scaffold (like
// plugin-builder) whose own `targetDir` is not the repo root it needs to
// invoke a sibling CLI command against. A hook has no such constraint: it
// runs with the same unrestricted ports the orchestrator itself has, so
// omitting `options.cwd` entirely when calling `ports.processRunner.run()`
// lets `ExecaProcessRunner` (`infra/processRunner.ts`) fall through to
// execa's own default — the real cwd of the process that invoked `stackfold
// init` in the first place.
//
// `literalKeys: []` — deliberate, unlike `patchFile`/`deriveAnswer`: neither
// `command` nor `args` carries the "controls where a mutation lands"
// semantics that justify protecting a field from expression resolution
// there. `command` is normally an author-chosen literal by nature (a fixed
// binary name); `args` legitimately needs values computed from `answers`
// (e.g. a generated plugin's own id interpolated into a synth invocation),
// exactly like `runCommand`'s own `args` already supports via the existing,
// generic `resolveParams()`/`resolveValue()` pipeline — no new resolution
// mechanism introduced for this action.
//
// No `cwd` field in `runHookCommandSchema` at all — deliberate: the cwd is
// always "the cwd real of the invoking process", never configurable by the
// scaffold author, so the "never targetDir" guarantee is structural, not an
// option someone could pass wrong.
// ---------------------------------------------------------------------------

const runHookCommandSchema = z.object({
  command: z.string().trim().min(1, 'runHookCommand requires a non-empty "command"'),
  args: z.array(z.string()).default([]),
});

registerAction('runHookCommand', {
  tag: 'hook',
  schema: runHookCommandSchema,
  literalKeys: [],
  handler: async (params, ports): Promise<void> => {
    const { command, args } = params as z.infer<typeof runHookCommandSchema>;
    await ports.processRunner.run(command, args); // cwd deliberately omitted — see header comment above.
  },
});
