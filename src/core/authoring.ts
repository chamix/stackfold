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
      handler: (params: unknown, ports: HookPorts) => void | Promise<void>;
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
      return { files: composed.files, postActions: [...composed.postActions, ...postActions] };
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

function compileHookStep(step: ActionStep, evaluator: ExpressionEvaluator): HookHandler {
  return async (ports: HookPorts, answers: Answers): Promise<void> => {
    const kind = resolveAction(step.action);
    if (!kind) {
      throw new Error(`Unknown action "${step.action}" referenced under "hooks"`);
    }
    if (kind.tag !== 'hook') {
      throw new Error(`Action "${step.action}" is registered as "${kind.tag}", not "hook" — cannot run as a hook`);
    }

    const resolvedParams = resolveParams(step.params, evaluator, answers, kind.literalKeys);
    const parsedParams: unknown = kind.schema.parse(resolvedParams);
    await kind.handler(parsedParams, ports);
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
  literalKeys: ['content'],
  resolve: (params, ctx): FileContribution => {
    const { path, content, strategy } = params as z.infer<typeof writeFileSchema>;
    return { path, content: compileTemplate(content, ctx), ...(strategy ? { strategy } : {}) };
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
