/**
 * Synth pipeline (SK-ADR-003 Decisions 1 and 6) — the step that takes an
 * already-loaded, in-memory `ScaffoldDefinition` (built via
 * `src/authoring/builder.ts`, or any plain object matching the same shape)
 * and turns it into the canonical, on-disk `scaffold.json`
 * `compileScaffold()` consumes at real `stackfold init` time. A pure
 * function over data plus one real, necessary side effect (the final file
 * write) — it never loads the author's TS module itself; that's
 * `src/cli/commands/scaffoldSynth.ts`'s job, the one layer this task
 * allows to do that (see that module's own header comment on the trust
 * boundary).
 *
 * Inward Dependency Rule, tooling layer (a peer of `infra/`, not `core/`
 * itself): imports `core/authoring.ts`'s `compileScaffold()` (a real smoke
 * test — Decision 6) and `infra/expressionEvaluator.ts`'s concrete
 * `JsonLogicExpressionEvaluator`, by design — this task's own instruction
 * is to run the smoke test "with a real `JsonLogicExpressionEvaluator`",
 * not a fake. Both are already-existing, unmodified modules; `core/`
 * itself gains no new dependency of its own.
 *
 * D6 — structural validation: a new top-level zod schema for
 * `ScaffoldDefinition` (grounding confirmed no such schema exists anywhere
 * today — only per-`ActionKind` param schemas live inside
 * `compileScaffold()`). It runs *before* the smoke test, so a malformed
 * definition (e.g. a non-array `steps`, a question with an invalid `type`)
 * fails with a clear, specific zod message instead of an obscure runtime
 * `TypeError` surfacing from deep inside `compileScaffold()`.
 *
 * Smoke-test scope (empirically confirmed against the real, frozen
 * `compileScaffold()`, not assumed): `compileScaffold()` alone never throws
 * synchronously for a definition that already passed the zod check above —
 * it only *constructs* the plugin object; per-step action resolution
 * (`resolveAction()`/`schema.parse()`) is lazy, happening only when
 * `buildBlueprint()` actually runs (the existing `electron-stackfold`
 * `scaffold.test.ts` precedent calls only `compileScaffold()`, which is
 * why it never previously caught e.g. an unknown action name either). To
 * make this smoke test actually fail-fast on that class of error — the
 * whole motivation behind SK-ADR-003 Decision 6 ("igual que `cdk synth`
 * valida y falla") — this also calls the compiled plugin's
 * `buildBlueprint()` once, with answers synthesized from each question's
 * own `default` (or a type-appropriate placeholder when absent). This adds
 * no disk I/O: `buildBlueprint()` is itself a pure, synchronous function
 * (`core/authoring.ts`) — it only returns an in-memory `ProjectBlueprint`,
 * never writes anything, so the "never touching the real target-project
 * disk" invariant holds exactly as before. `hooks` are deliberately NOT
 * invoked here (unlike `steps`) — a hook handler runs with real I/O ports
 * by design (Invariant A) and invoking one during `synth` would mean
 * either violating the no-disk-I/O invariant or faking those ports, which
 * is out of this cycle's scope; a hook step's `action`/`params` shape is
 * still covered by the zod check above.
 *
 * Edge-case invariant ("synth nunca escribe un scaffold.json parcial o
 * inválido" — spec, Step 0): the on-disk write only ever happens after
 * both the structural-validation and smoke-test checks pass, and even then
 * via write-to-temp-then-rename, never a direct write to the final path —
 * so a failure partway through serialization/writing can never leave a
 * partial `scaffold.json` behind; a pre-existing file at that path (if
 * any) is left exactly as it was unless the rename actually succeeds.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { compileScaffold, type ScaffoldDefinition } from '../core/authoring.js';
import type { ExpressionEvaluator } from '../core/ports.js';
import type { Answers, QuestionDefinition } from '../core/types.js';
import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';

// ---------------------------------------------------------------------------
// D6 — top-level structural validation (new; no prior full-definition schema)
// ---------------------------------------------------------------------------

const answerValueSchema = z.union([z.string(), z.boolean(), z.number()]);

const questionDefinitionSchema = z.object({
  id: z.string().trim().min(1, 'questions[] entries require a non-empty "id"'),
  message: z.string().trim().min(1, 'questions[] entries require a non-empty "message"'),
  type: z.enum(['input', 'confirm', 'select']),
  choices: z.array(z.string()).optional(),
  default: answerValueSchema.optional(),
  validate: z
    .custom<(value: string | boolean | number) => true | string>((val) => typeof val === 'function', {
      message: 'questions[].validate must be a function when present',
    })
    .optional(),
});

/** `ActionStep` — `params`/`when` stay `unknown`, same deliberate opacity `core/authoring.ts` itself uses (per-action schemas validate `params` for real, inside `compileScaffold()`). */
const actionStepSchema = z.object({
  action: z.string().trim().min(1, 'steps[]/hooks[] entries require a non-empty "action"'),
  params: z.unknown(),
  when: z.unknown().optional(),
});

const pluginHelpSchema = z.object({
  name: z.string().optional(),
  details: z.string().optional(),
});

const hookNameSchema = z.enum(['preInit', 'postWrite', 'postInit']);

/**
 * Exported for `tests/unit/authoring-synth.test.ts` to exercise directly.
 * Deliberately not pinned to `z.ZodType<ScaffoldDefinition>`: this is a
 * structural *shape* check (D6), not a re-derivation of the TS type —
 * `core/authoring.ts`'s own type remains the single source of truth for
 * the contract itself.
 */
export const scaffoldDefinitionSchema = z
  .object({
    id: z.string().trim().min(1, 'ScaffoldDefinition requires a non-empty "id"'),
    description: z.string().trim().min(1, 'ScaffoldDefinition requires a non-empty "description"'),
    help: pluginHelpSchema.optional(),
    questions: z.array(questionDefinitionSchema),
    steps: z.array(actionStepSchema),
    hooks: z.partialRecord(hookNameSchema, z.array(actionStepSchema)).optional(),
  })
  // D6 (Task 041 amendment, 2026-10-24) — a gap residual to fragments/
  // namespacing: nothing before this validated that `questions[].id` is
  // unique across the whole definition, whatever produced the duplicate
  // (a fragment bug that somehow evades mountFragment()'s namespace
  // registry, or a hand-written root question colliding with another by
  // accident, no fragments involved at all). `superRefine()` (rather than
  // `refine()`) so the specific duplicated id can be named in the issue
  // message, not folded into a generic one.
  .superRefine((definition, ctx) => {
    const duplicateId = findDuplicateQuestionId(definition.questions);
    if (duplicateId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message: `questions[].id "${duplicateId}" appears more than once`,
      });
    }
  });

/** Returns the first `id` seen twice in `questions`, or `undefined` if every id is unique. */
function findDuplicateQuestionId(questions: { id: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) return question.id;
    seen.add(question.id);
  }
  return undefined;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// Synth pipeline
// ---------------------------------------------------------------------------

export interface SynthOptions {
  /** Base directory the canonical `src/plugins/<id>/scaffold.json` path is resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to a real `JsonLogicExpressionEvaluator` — SK-ADR-003 Decision 6's "real" smoke test, never a fake, unless a test deliberately overrides it. */
  evaluator?: ExpressionEvaluator;
}

export interface SynthResult {
  outputPath: string;
}

/**
 * Validates, smoke-tests, and writes `definition` to its canonical
 * `src/plugins/<id>/scaffold.json` path (same convention `plugin-builder`'s
 * own generated manifests already use). Throws — without writing anything
 * — on any failure; see this module's header comment for the invariant
 * that guarantees that.
 */
export function synth(definition: ScaffoldDefinition, options: SynthOptions = {}): SynthResult {
  const cwd = options.cwd ?? process.cwd();
  const evaluator = options.evaluator ?? new JsonLogicExpressionEvaluator();

  const parsed = scaffoldDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new Error(`synth: invalid ScaffoldDefinition "${describeId(definition)}": ${formatZodIssues(parsed.error)}`);
  }

  try {
    const plugin = compileScaffold(definition, evaluator);
    // See this module's header comment ("Smoke-test scope"): exercising
    // buildBlueprint() too — still pure, no disk I/O — is what actually
    // makes this fail-fast on a bad step (e.g. an unknown action name),
    // which compileScaffold() alone never catches.
    plugin.buildBlueprint(syntheticAnswers(definition.questions));
  } catch (err) {
    throw new Error(`synth: compileScaffold() smoke test failed for "${definition.id}": ${toMessage(err)}`);
  }

  const outputPath = resolve(cwd, 'src', 'plugins', definition.id, 'scaffold.json');
  const json = `${JSON.stringify(definition, null, 2)}\n`;
  writeJsonAtomic(outputPath, json);

  return { outputPath };
}

/**
 * Synthesizes a throwaway `Answers` map for the smoke test only — never
 * written anywhere, never seen outside this function. Each question's own
 * `default` wins when present; otherwise a type-appropriate placeholder
 * (`confirm` → `false`, `select` → its first choice, `input` → `''`), just
 * enough for `buildBlueprint()` to run every step for real.
 */
function syntheticAnswers(questions: QuestionDefinition[]): Answers {
  const answers: Answers = {};
  for (const question of questions) {
    if (question.default !== undefined) {
      answers[question.id] = question.default;
      continue;
    }
    switch (question.type) {
      case 'confirm':
        answers[question.id] = false;
        break;
      case 'select':
        answers[question.id] = question.choices?.[0] ?? '';
        break;
      default:
        answers[question.id] = '';
        break;
    }
  }
  return answers;
}

function describeId(definition: ScaffoldDefinition): string {
  return isPlainRecord(definition) && typeof definition.id === 'string' ? definition.id : '(unknown id)';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write-to-temp-then-rename: `scaffold.json` either ends up fully written
 * (rename succeeded) or is left exactly as it was before this call — never
 * partially overwritten, even if the process were interrupted mid-write.
 */
function writeJsonAtomic(outputPath: string, content: string): void {
  const dir = dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.scaffold.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, outputPath);
}
