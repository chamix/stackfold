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
  // `jsonEscapeKeys` joins it for the same reason: it names *which* context
  // keys get escaped, an author-chosen list, never an answers-controlled
  // value (see `writeFileSchema`'s own doc comment).
  literalKeys: ['content', 'jsonEscapeKeys'],
  resolve: (params, ctx): FileContribution => {
    const { path, content, strategy, jsonEscapeKeys } = params as z.infer<typeof writeFileSchema>;
    const renderCtx = jsonEscapeKeys && jsonEscapeKeys.length > 0 ? escapeForJsonContext(ctx, jsonEscapeKeys) : ctx;
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
