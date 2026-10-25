/**
 * Authoring-time builder functions (SK-ADR-003 Decision 3) — CDK-flavored
 * sugar over the exact `ScaffoldDefinition`/`ActionStep` shapes
 * `core/authoring.ts`/`core/types.ts` already define, unchanged. A
 * scaffold author calls `defineScaffold()` plus the small step helpers
 * below to assemble `questions`/`steps`/`hooks` without hand-writing
 * `{ action: 'writeFile', params: {...} }` object literals (and, longer
 * term, without the JSON-escaping friction SK-ADR-003's Context section
 * documents for `scaffold.json` written by hand).
 *
 * Deliberately a thin, pure, declarative data builder — no live resource
 * graph, no global unique-id tree (ADR Decision 3's explicit scope
 * reduction versus real CDK/CDKTF): every function here is synchronous,
 * side-effect-free, and returns plain data immediately. There is nothing
 * to "synth" at this layer beyond returning that data — `src/authoring/
 * synth.ts` is the pipeline that validates/smoke-tests/writes it.
 *
 * Inward Dependency Rule, tooling layer (peer of `infra/`/`cli/`, not
 * `core/` itself): only *types* are imported from `core/authoring.ts`/
 * `core/types.ts` — no runtime import from `core/` is needed, since this
 * module never calls anything in it, only shapes data to match it.
 *
 * Naming note: the helper for the already-registered `writeFile` action
 * (`core/authoring.ts`'s vocabulary registry) is deliberately named
 * `file()`, not `writeFile()` — naming it `writeFile()` here, returning an
 * `ActionStep` whose `action` field is the *string* `'writeFile'`, would
 * read as though this module re-implements that action rather than merely
 * describing one invocation of it. `mkdir`/`runCommand`/`npmInstall`/
 * `gitInit` keep the same name as their action string: no such ambiguity
 * there, since this module exports no action *implementation* under any of
 * those four names, only a step-shaped-data constructor.
 */
import type { ActionStep, ScaffoldDefinition } from '../core/authoring.js';
import type { HookName, PluginHelp, QuestionDefinition } from '../core/types.js';

/** `defineScaffold()`'s input — field-for-field `ScaffoldDefinition`, named for readability at the call site. */
export interface DefineScaffoldInput {
  id: string;
  description: string;
  help?: PluginHelp;
  questions: QuestionDefinition[];
  steps: ActionStep[];
  hooks?: Partial<Record<HookName, ActionStep[]>>;
  /** Task 044 (UX-001/SK-ADR-004) — field-for-field `ScaffoldDefinition.mainFile`. */
  mainFile?: unknown;
}

/**
 * CDK-style entry point. Builds exactly the `ScaffoldDefinition`
 * `compileScaffold()` (and, in this cycle, `src/authoring/synth.ts`)
 * already consume — a thin, identity-shaped assembly, not a
 * transformation, so a scaffold author gets typed fields/autocomplete
 * instead of hand-shaping a bare object literal. `help`/`hooks` are only
 * present on the result when actually supplied, matching
 * `ScaffoldDefinition`'s own optional fields exactly (and keeping the
 * eventual serialized JSON free of stray `"help": undefined`-shaped noise).
 */
export function defineScaffold(input: DefineScaffoldInput): ScaffoldDefinition {
  return {
    id: input.id,
    description: input.description,
    ...(input.help ? { help: input.help } : {}),
    questions: input.questions,
    steps: input.steps,
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.mainFile !== undefined ? { mainFile: input.mainFile } : {}),
  };
}

/** Shared by every step helper below: an optional per-step `when` gate (Task 035, `ActionStep.when`). */
export interface StepOptions {
  when?: unknown;
}

/** Attaches `when` to a step only if the caller actually supplied one — `ActionStep.when` stays entirely absent otherwise. */
function withWhen(step: Omit<ActionStep, 'when'>, when: unknown): ActionStep {
  return when !== undefined ? { ...step, when } : step;
}

export type WriteFileStrategy = 'exclusive' | 'json-merge' | 'append';

export interface FileStepOptions extends StepOptions {
  strategy?: WriteFileStrategy;
  jsonEscapeKeys?: string[];
}

/**
 * Builds a `writeFile` `ActionStep`. `content` is meant to be the author's
 * own literal Handlebars-template string — e.g. loaded via
 * `src/authoring/templateLoader.ts`'s `loadTemplate()` from a sibling
 * `.hbs` file — never a value computed from anything answer-shaped (same
 * discipline `core/authoring.ts`'s `literalKeys: ['content', ...]`
 * already enforces structurally at compile time; this helper does not
 * re-enforce it, it just doesn't get in the way of it).
 */
export function file(path: string, content: string, opts: FileStepOptions = {}): ActionStep {
  const { when, strategy, jsonEscapeKeys } = opts;
  return withWhen(
    {
      action: 'writeFile',
      params: {
        path,
        content,
        ...(strategy ? { strategy } : {}),
        ...(jsonEscapeKeys ? { jsonEscapeKeys } : {}),
      },
    },
    when
  );
}

/** Builds a `mkdir` `ActionStep`. */
export function mkdir(path: string, opts: StepOptions = {}): ActionStep {
  return withWhen({ action: 'mkdir', params: { path } }, opts.when);
}

export interface RunCommandStepOptions extends StepOptions {
  args?: string[];
}

/** Builds a `runCommand` `ActionStep`. */
export function runCommand(command: string, opts: RunCommandStepOptions = {}): ActionStep {
  const { when, args } = opts;
  return withWhen({ action: 'runCommand', params: { command, ...(args ? { args } : {}) } }, when);
}

/** Builds an `npmInstall` `ActionStep` (no params). */
export function npmInstall(opts: StepOptions = {}): ActionStep {
  return withWhen({ action: 'npmInstall', params: {} }, opts.when);
}

/** Builds a `gitInit` `ActionStep` (no params). */
export function gitInit(opts: StepOptions = {}): ActionStep {
  return withWhen({ action: 'gitInit', params: {} }, opts.when);
}

/**
 * Escape hatch for any other registered action without its own named
 * helper above (today: `patchFile`/`deriveAnswer`, both hook-only, plus any
 * future `registerAction()` addition). Still pure, typed-at-the-call-site
 * data — the caller supplies the action name and its params exactly as
 * `core/authoring.ts`'s registry expects; no new vocabulary is introduced
 * here.
 */
export function step(action: string, params: unknown, opts: StepOptions = {}): ActionStep {
  return withWhen({ action, params }, opts.when);
}
