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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compileScaffold, type ScaffoldDefinition } from '../core/authoring.js';
import { compileConstraints } from '../core/constraints.js';
import type { ExpressionEvaluator } from '../core/ports.js';
import type { Answers, QuestionConstraints, QuestionDefinition } from '../core/types.js';
import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';
import { GENERATED_MODULE_BANNER, realEsbuildEmitter, type ScaffoldModuleEmitter } from './emitModule.js';

// ---------------------------------------------------------------------------
// D6 — top-level structural validation (new; no prior full-definition schema)
// ---------------------------------------------------------------------------

const answerValueSchema = z.union([z.string(), z.boolean(), z.number()]);

/**
 * `ConstraintLimit` (SYNTH-002 D1) — strict: an unknown key (e.g. a typo)
 * is rejected here rather than silently ignored, matching
 * `scaffoldDefinitionSchema`'s existing "unknown keys rejected" convention.
 */
const constraintLimitSchema = z
  .object({
    value: z.number().int('"value" must be an integer').nonnegative('"value" must be >= 0'),
    message: z.string().min(1, '"message" must be a non-empty string'),
  })
  .strict();

/**
 * `ConstraintRule` (SYNTH-002 D1) — a discriminated-by-presence union, not
 * `z.discriminatedUnion`, since the discriminant key itself (`matches` vs.
 * `notMatches`) is the field being validated, not a sibling tag field.
 * Regex *validity* (not just "is a string") is checked by
 * `core/constraints.ts`'s own `compileConstraints()` — reached via
 * `questionConstraintsSchema`'s `superRefine` below — so an invalid regex
 * source fails with the exact same message whether caught at synth,
 * register, or direct `compileScaffold()` time (single source of truth,
 * never re-derived here).
 */
const constraintRuleSchema = z.union([
  z.object({ matches: z.string(), message: z.string().min(1, '"message" must be a non-empty string') }).strict(),
  z.object({ notMatches: z.string(), message: z.string().min(1, '"message" must be a non-empty string') }).strict(),
]);

/**
 * `QuestionConstraints` (SYNTH-002 D1/D4) — strict shape validation plus a
 * `superRefine` that actually compiles the constraints via
 * `compileConstraints()` (`core/constraints.ts`), so every fail-fast case
 * in the spec's table (invalid regex, `minLength > maxLength`, etc.) is
 * rejected with that function's own descriptive message — never
 * re-implemented as a parallel zod check that could drift from it.
 */
const questionConstraintsSchema = z
  .object({
    trim: z.boolean().optional(),
    minLength: constraintLimitSchema.optional(),
    maxLength: constraintLimitSchema.optional(),
    rules: z.array(constraintRuleSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      compileConstraints(value as QuestionConstraints);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: toMessage(err) });
    }
  });

const questionDefinitionSchema = z
  .object({
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
    // SYNTH-002 (data, not a closure — never counted as a dropped closure by
    // collectClosurePaths()/synth(), unlike "validate" above): see
    // questionConstraintsSchema's own doc comment.
    constraints: questionConstraintsSchema.optional(),
  })
  // SYNTH-002 D3 (fail-fast invariant 5): "constraints" is only meaningful
  // on a "input" question — `core/authoring.ts`'s `compileScaffold()`
  // throws on the same condition at compile time; this mirrors it at synth/
  // register-validation time, before compileScaffold() ever runs, with the
  // specific offending id named in the message.
  .superRefine((question, ctx) => {
    if (question.constraints && question.type !== 'input') {
      ctx.addIssue({
        code: 'custom',
        path: ['constraints'],
        message: `questions[].constraints is only valid on a "input" question (id "${question.id}" has type "${question.type}")`,
      });
    }
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
  /**
   * Directory the output `scaffold.json` is written into (ARCH-003
   * Decision 1) — the directory containing the `scaffold.ts` actually
   * being compiled (the `<dir>` argument
   * `src/cli/commands/scaffoldSynth.ts` already resolves), never
   * `process.cwd()`-anchored. For `plugin-builder`'s own invocation
   * (`scaffold synth src/plugins/<pluginId>`), `outDir` is exactly
   * `src/plugins/<pluginId>`, giving a byte-identical output path to the
   * old, hardcoded `resolve(cwd, 'src', 'plugins', <id>, 'scaffold.json')`
   * convention — this is the regression guard for that self-extension
   * path. For an external author running `stackfold scaffold synth
   * ./my-plugin` from anywhere, output correctly lands at
   * `./my-plugin/scaffold.json`. Defaults to `process.cwd()` when omitted
   * (only exercised directly by `tests/unit/authoring-synth.test.ts`;
   * every real caller passes `outDir` explicitly).
   */
  outDir?: string;
  /** Defaults to a real `JsonLogicExpressionEvaluator` — SK-ADR-003 Decision 6's "real" smoke test, never a fake, unless a test deliberately overrides it. */
  evaluator?: ExpressionEvaluator;
}

export interface SynthResult {
  outputPath: string;
  /** New (SYNTH-001) — `questions.<id>.validate`-shaped dotted paths to every closure found, `[]` when none. */
  droppedClosures: string[];
  /** New (SYNTH-001) — set only when a `scaffold.js` module was actually written alongside `scaffold.json`. */
  modulePath?: string;
}

/**
 * Validates, smoke-tests, and writes `definition` to `scaffold.json`
 * inside `options.outDir` (ARCH-003 Decision 1 — previously always
 * `<cwd>/src/plugins/<id>/scaffold.json`, which silently assumed `cwd` was
 * a stackfold checkout root; see this module's header comment). Throws —
 * without writing anything — on any failure; see this module's header
 * comment for the invariant that guarantees that.
 *
 * JSON-only, synchronous — unchanged since before SYNTH-001 (same exact
 * behavior every existing caller/test already depends on, including the
 * original "closures silently vanish in the JSON" behavior this whole
 * task exists to stop being the *only* path). Real callers (`scaffold
 * synth`'s CLI command) use `synthWithModule()` below instead, which is
 * genuinely async (a real bundler run + a real verifying `import()`) and
 * therefore cannot share this function's synchronous-throw contract.
 */
export function synth(definition: ScaffoldDefinition, options: SynthOptions = {}): SynthResult {
  const outDir = options.outDir ?? process.cwd();
  const evaluator = options.evaluator ?? new JsonLogicExpressionEvaluator();

  validateStructurally(definition);
  smokeTest(definition, evaluator);

  const outputPath = resolve(outDir, 'scaffold.json');
  const json = `${canonicalJson(definition)}\n`;
  writeJsonAtomic(outputPath, json);

  return { outputPath, droppedClosures: collectClosurePaths(definition) };
}

// ---------------------------------------------------------------------------
// synthWithModule — SYNTH-001 / SK-ADR-009: the full JSON+JS orchestration
// ---------------------------------------------------------------------------

export interface SynthWithModuleOptions extends SynthOptions {
  /**
   * Absolute path to the author's `scaffold.ts` — required only when
   * closures are found AND `emitJs` isn't `false` (the only case that
   * actually needs to bundle something). Ignored otherwise.
   */
  scaffoldTsPath?: string;
  /** Defaults to `true` (SK-ADR-009 Decision 2's default: emit when closures exist). */
  emitJs?: boolean;
  /** Injectable (DIP) — defaults to `realEsbuildEmitter`. `tests/unit/authoring-synth.test.ts`'s own fakes return real, hand-written ESM text. */
  emitter?: ScaffoldModuleEmitter;
  /** Defaults to `(line) => console.error(line)` — used for the `--no-emit-js` degradation warning and the foreign-`scaffold.js` stale warning. */
  stderr?: (line: string) => void;
}

/**
 * The full orchestration `src/cli/commands/scaffoldSynth.ts` actually
 * calls (SK-ADR-009 Decisions 1-5): detects closures (D3), and when found
 * either degrades to a warning (`emitJs: false`) or bundles+verifies+
 * writes the canonical `scaffold.json`+`scaffold.js` pair (D1/D4), with
 * the `$synth` marker (D8) on the JSON whenever closures were dropped
 * from it. Never leaves a partial pair — see `writeModulePairAtomic()`'s
 * own comment for the write-ordering invariant.
 */
export async function synthWithModule(definition: ScaffoldDefinition, options: SynthWithModuleOptions = {}): Promise<SynthResult> {
  const outDir = options.outDir ?? process.cwd();
  const evaluator = options.evaluator ?? new JsonLogicExpressionEvaluator();
  const emitJs = options.emitJs ?? true;
  const emitter = options.emitter ?? realEsbuildEmitter;
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  validateStructurally(definition);
  smokeTest(definition, evaluator);

  const jsonPath = resolve(outDir, 'scaffold.json');
  const jsPath = resolve(outDir, 'scaffold.js');
  const droppedClosures = collectClosurePaths(definition);

  if (droppedClosures.length === 0) {
    handleStaleModule(jsPath, stderr);
    const json = `${canonicalJson(definition)}\n`;
    writeJsonAtomic(jsonPath, json);
    return { outputPath: jsonPath, droppedClosures: [] };
  }

  if (!emitJs) {
    stderr(
      `stackfold scaffold synth: dropped validate closures (re-run without --no-emit-js to keep them): ${droppedClosures.join(', ')}`
    );
    const json = `${serializeWithSynthMarker(definition, droppedClosures, undefined)}\n`;
    writeJsonAtomic(jsonPath, json);
    return { outputPath: jsonPath, droppedClosures };
  }

  if (!options.scaffoldTsPath) {
    throw new Error('synth: scaffoldTsPath is required to emit scaffold.js (pass emitJs: false to skip emission)');
  }

  // Never overwrite a `scaffold.js` this tool did not generate (e.g. an author's
  // hand-written workaround) — checked before anything is emitted or staged.
  assertModuleNotForeign(jsPath);

  const bundleText = await emitter.emit(options.scaffoldTsPath);
  const jsonWithoutMarker = canonicalJson(definition);
  const stagedModulePath = await verifyModule({ bundleText, outDir, droppedClosures, evaluator, jsonWithoutMarker });

  const jsonWithMarker = `${serializeWithSynthMarker(definition, droppedClosures, 'scaffold.js')}\n`;
  writeModulePairAtomic(jsPath, stagedModulePath, jsonPath, jsonWithMarker);

  return { outputPath: jsonPath, modulePath: jsPath, droppedClosures };
}

// ---------------------------------------------------------------------------
// Shared validation/smoke-test helpers (used by both synth() and synthWithModule())
// ---------------------------------------------------------------------------

function validateStructurally(definition: ScaffoldDefinition): void {
  const parsed = scaffoldDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new Error(`synth: invalid ScaffoldDefinition "${describeId(definition)}": ${formatZodIssues(parsed.error)}`);
  }
}

function smokeTest(definition: ScaffoldDefinition, evaluator: ExpressionEvaluator): void {
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
}

function canonicalJson(definition: ScaffoldDefinition): string {
  return JSON.stringify(definition, null, 2);
}

/**
 * `$synth` marker (D8): parses the plain `JSON.stringify(definition)`
 * round-trip (which already drops every function value — the exact
 * mechanism this whole task exists to stop being silent about) and adds
 * the top-level `$synth` key naming every dropped closure path plus the
 * module to register instead (`module` omitted when `--no-emit-js`
 * suppressed emission).
 */
function serializeWithSynthMarker(definition: ScaffoldDefinition, droppedClosures: string[], moduleFilename: string | undefined): string {
  const plain = JSON.parse(canonicalJson(definition)) as Record<string, unknown>;
  const marker: Record<string, unknown> = { droppedClosures };
  if (moduleFilename !== undefined) marker.module = moduleFilename;
  return JSON.stringify({ $synth: marker, ...plain }, null, 2);
}

// ---------------------------------------------------------------------------
// D3 — generic/defensive closure detection
// ---------------------------------------------------------------------------

/**
 * Deep-walks `value`, collecting a dotted path for every function value
 * found. Today this only ever finds `questions.<id>.validate`, but the
 * walk itself is generic — any future closure anywhere in a
 * `ScaffoldDefinition` is found the same way, with no special-casing.
 * Array elements carrying a string `id` are labeled by that `id` (so
 * `questions[].validate` reads as `questions.<id>.validate`, per SK-ADR-009);
 * elements without one fall back to their numeric index.
 */
export function collectClosurePaths(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'function') return [path.join('.')];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectClosurePaths(item, [...path, arrayItemLabel(item, index)]));
  }
  if (isPlainRecord(value)) {
    return Object.entries(value).flatMap(([key, v]) => collectClosurePaths(v, [...path, key]));
  }
  return [];
}

function arrayItemLabel(item: unknown, index: number): string {
  return isPlainRecord(item) && typeof item.id === 'string' ? item.id : String(index);
}

/** Mirrors `collectClosurePaths()`'s own id-vs-index labeling, so a path it produced can be re-resolved against a (re-)imported object. */
function getAtPath(value: unknown, segments: string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const byId = current.find((item) => isPlainRecord(item) && item.id === segment);
      current = byId !== undefined ? byId : current[Number(segment)];
    } else if (isPlainRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// D4 — module verification (write-to-temp .mjs, real import(), checks)
// ---------------------------------------------------------------------------

interface VerifyModuleParams {
  bundleText: string;
  outDir: string;
  droppedClosures: string[];
  evaluator: ExpressionEvaluator;
  /** `canonicalJson(definition)` — the exact text the final `scaffold.json` will contain, minus the `$synth` key. */
  jsonWithoutMarker: string;
}

/**
 * Writes `bundleText` to a temp `.mjs` file *in `outDir`* (so
 * `import.meta.dirname`/bare-specifier resolution inside the bundle
 * matches where `scaffold.js` will actually end up, and so ESM parsing is
 * guaranteed regardless of the nearest `package.json`'s `"type"`), then
 * `import()`s it for real (`pathToFileURL` — never a bare path string;
 * Windows file-URL correctness matters here) and runs every SK-ADR-009
 * Decision 4 check. On success, returns that temp file's own path
 * unchanged (the caller renames it into place — no second write). On any
 * failure, deletes the temp file and re-throws, so nothing is ever written
 * anywhere else.
 */
async function verifyModule(params: VerifyModuleParams): Promise<string> {
  const { bundleText, outDir, droppedClosures, evaluator, jsonWithoutMarker } = params;
  const tmpPath = join(outDir, `.scaffold.js.${process.pid}.${Date.now()}.tmp.mjs`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(tmpPath, bundleText, 'utf8');

  try {
    const imported = (await import(pathToFileURL(tmpPath).href)) as { default?: unknown };
    const importedDefault = imported.default;

    const parsed = scaffoldDefinitionSchema.safeParse(importedDefault);
    if (!parsed.success) {
      throw new Error(`synth: emitted scaffold.js default export failed structural validation: ${formatZodIssues(parsed.error)}`);
    }

    for (const closurePath of droppedClosures) {
      const value = getAtPath(importedDefault, closurePath.split('.'));
      if (typeof value !== 'function') {
        throw new Error(`synth: emitted scaffold.js lost the closure expected at "${closurePath}" (parity check)`);
      }
    }

    const actualJson = JSON.stringify(importedDefault, null, 2);
    if (actualJson !== jsonWithoutMarker) {
      throw new Error(
        'synth: parity check failed — scaffold.js\'s default export does not JSON.stringify to the same content as scaffold.json (excluding $synth)'
      );
    }

    smokeTest(importedDefault as ScaffoldDefinition, evaluator);
  } catch (err) {
    unlinkIfExists(tmpPath);
    throw err instanceof Error ? err : new Error(toMessage(err));
  }

  return tmpPath;
}

// ---------------------------------------------------------------------------
// Atomic writes + stale handling
// ---------------------------------------------------------------------------

/**
 * Renames the already-verified, already-on-disk staged module
 * (`stagedModulePath`, from `verifyModule()`) into `jsPath` first, then
 * writes+renames `scaffold.json` (temp-then-rename, same pattern
 * `writeJsonAtomic()` already uses). Rename order matters (SK-ADR-009
 * Decision 3's edge-case invariant): if the second rename fails, the
 * thrown error explicitly names *both* paths as now-inconsistent, since a
 * human now needs to reconcile them — a fresh `scaffold.js` sitting next
 * to a stale/missing `scaffold.json`. Never leaves a `.tmp`/`.tmp.mjs`
 * file behind on any path through this function.
 */
function writeModulePairAtomic(jsPath: string, stagedModulePath: string, jsonPath: string, jsonContent: string): void {
  try {
    renameSync(stagedModulePath, jsPath);
  } catch (err) {
    unlinkIfExists(stagedModulePath);
    throw new Error(`synth: failed to write "${jsPath}": ${toMessage(err)}`);
  }

  const jsonDir = dirname(jsonPath);
  const jsonTmpPath = join(jsonDir, `.scaffold.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(jsonTmpPath, jsonContent, 'utf8');
    renameSync(jsonTmpPath, jsonPath);
  } catch (err) {
    unlinkIfExists(jsonTmpPath);
    throw new Error(
      `synth: wrote "${jsPath}" but failed to write "${jsonPath}" — these two files are now inconsistent and need ` +
        `manual reconciliation: ${toMessage(err)}`
    );
  }
}

/**
 * SK-ADR-009 Decision 4 — stale-handling: a pre-existing `scaffold.js`
 * whose first line is exactly `GENERATED_MODULE_BANNER` is `synth`'s own
 * previous output, now stale (this run found no closures), and is
 * deleted. A `scaffold.js` without that exact first line is never
 * `synth`'s own — left completely untouched, with a warning.
 */
function handleStaleModule(jsPath: string, stderr: (line: string) => void): void {
  const firstLine = readFirstLine(jsPath);
  if (firstLine === undefined) return;

  if (firstLine === GENERATED_MODULE_BANNER) {
    unlinkSync(jsPath);
  } else {
    stderr(`stackfold scaffold synth: "${jsPath}" exists but was not generated by synth — leaving it untouched.`);
  }
}

/**
 * SK-ADR-009 Decision 4 (extended to the closures path) — a pre-existing
 * `scaffold.js` whose first line is not `GENERATED_MODULE_BANNER` was not
 * written by `synth` (typically an author's hand-written workaround) and is
 * never overwritten: this throws *before* anything is emitted, staged or
 * written, so the foreign file and any existing `scaffold.json` stay exactly
 * as they were. A banner-marked file (synth's own earlier output) or no file
 * at all passes.
 */
function assertModuleNotForeign(jsPath: string): void {
  const firstLine = readFirstLine(jsPath);
  if (firstLine === undefined || firstLine === GENERATED_MODULE_BANNER) return;
  throw new Error(
    `synth: "${jsPath}" already exists and was not generated by synth — refusing to overwrite it. ` +
      'Move it aside, or re-run with --no-emit-js to skip emitting scaffold.js.'
  );
}

/** First line of `path`, or `undefined` when the file does not exist. */
function readFirstLine(path: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
  return content.split(/\r?\n/, 1)[0];
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
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
