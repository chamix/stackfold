/**
 * Core domain types for the stackfold plugin contract
 * (.agents/specs/initial_scaffold.md — "Interfaces").
 *
 * Everything here is plain data or pure functions. A plugin declares what
 * to ask (`questions()`) and what project results from the answers
 * (`buildBlueprint()`); it never performs I/O itself — the orchestrator
 * does the asking, writing, and command execution through the ports in
 * `core/ports.ts` (functional_domain.md §3.4).
 *
 * `HookName`/`HookPorts`/`HookHandler` and `StackfoldPlugin.hooks` below are
 * ARCH-001's additive extension (.agents/specs/arch-001-scaffold-authoring.md
 * — Step 1 item 2, Invariant D): a brand-new, optional field. The 3 existing
 * plugins, which never declare it, are byte-for-byte unaffected.
 */
import type { FileWriter, ProcessRunner, Prompter } from './ports.js';

export type AnswerValue = string | boolean | number;
export type Answers = Record<string, AnswerValue>;

/**
 * A single bound (`minLength`/`maxLength`) within `QuestionConstraints`
 * (SYNTH-002, `.agents/specs/synth-002-declarative-validation.md` D1).
 * `value` must be a non-negative integer; `message` is the error string
 * returned when the bound is violated. Pure data — no closures, no I/O.
 */
export interface ConstraintLimit {
  value: number;
  message: string;
}

/**
 * A single regex-shaped rule within `QuestionConstraints.rules` (D1):
 * `matches` fails when the (trimmed, per `trim`) value does NOT contain a
 * match for the regex source; `notMatches` fails when it DOES. `message` is
 * the error string returned on violation. The regex `source` carries no
 * flags — compiled via `new RegExp(source)` (core/constraints.ts) — keeping
 * the shape trivially JSON-serializable and closing off flag-based
 * surprises (e.g. a hidden `g`/`i`) for every built-in rule.
 */
export type ConstraintRule = { matches: string; message: string } | { notMatches: string; message: string };

/**
 * Declarative, closed-vocabulary validation for a single text
 * `QuestionDefinition` (SYNTH-002/SK-ADR-010) — pure data, so it survives
 * `scaffold synth` into `scaffold.json` without loss, unlike a `validate`
 * closure (SK-ADR-009). Interpreted by `core/constraints.ts`'s
 * `compileConstraints()`, which `compileScaffold()` (`core/authoring.ts`)
 * invokes once per plugin compile, never per answer. Evaluation order,
 * fixed (never author-reordered): `trim` (if set) -> `minLength` ->
 * `maxLength` -> `rules` in array order; the first violated check's
 * `message` wins. Only valid on a `type: 'input'` question — `compileScaffold()`
 * rejects `constraints` on `confirm`/`select` at compile time.
 */
export interface QuestionConstraints {
  /** When `true`, every check below evaluates the trimmed value; the stored answer is never altered. */
  trim?: boolean;
  minLength?: ConstraintLimit;
  maxLength?: ConstraintLimit;
  rules?: ConstraintRule[];
}

export interface QuestionDefinition {
  id: string;
  message: string;
  type: 'input' | 'confirm' | 'select';
  /** Required when type === "select". */
  choices?: string[];
  default?: AnswerValue;
  /** Pure — no I/O. Return `true` if valid, or an error message. */
  validate?: (value: AnswerValue) => true | string;
  /**
   * Declarative alternative/complement to `validate` (SYNTH-002) — see
   * `QuestionConstraints`'s own doc comment. When both are present,
   * `compileScaffold()` derives a `validate` that runs `constraints` first,
   * short-circuiting before the original `validate` on the first failure.
   */
  constraints?: QuestionConstraints;
}

export interface FileEntry {
  /** Relative to the target directory. */
  path: string;
  content: string | Buffer;
}

/**
 * Declarative follow-up actions (Command pattern, as data). Interpreted
 * centrally by the orchestrator via `ProcessRunner` — a plugin never hands
 * over executable code.
 */
export type PostActionDefinition =
  | { kind: 'git-init' }
  | { kind: 'npm-install' }
  | { kind: 'run-command'; command: string; args: string[] };

export interface ProjectBlueprint {
  files: FileEntry[];
  postActions: PostActionDefinition[];
  /**
   * Optional (UX-001/SK-ADR-004): the project's "main" file, relative to
   * targetDir, if this plugin+answers combination has an obvious one.
   * Resolved from `answers` here, not declared as static plugin
   * metadata — some plugins (`web-app-stackfold`) have an entry point
   * that varies by answer (e.g. `appType`), which static metadata
   * cannot express.
   */
  mainFile?: string;
}

/**
 * Optional, richer CLI help for a plugin, beyond the mandatory one-line
 * `description` (used in listings). Deliberately optional on the whole
 * contract (see `StackfoldPlugin.help`) — desirable, never mandatory, so
 * a new plugin isn't blocked on writing prose before it can be
 * registered. `src/cli/pluginHelp.ts` degrades gracefully, field by
 * field, when a plugin omits this or any of its properties.
 */
export interface PluginHelp {
  /** Display name shown in listings/`info`. Falls back to the plugin's `id` when absent. */
  name?: string;
  /**
   * Longer-form help: usage notes, prerequisites, examples. Shown by
   * `stackfold info <stack>` only when present — this line/section is
   * omitted entirely from the output otherwise, never a placeholder.
   */
  details?: string;
}

/**
 * The three moments in `runPlugin()`'s execution lifecycle (ARCH-001
 * Invariant E) a plugin may hook into — not part of the pure blueprint, the
 * only impure category of action by definition:
 *   - `preInit`   — after answers are collected, before the blueprint is built.
 *   - `postWrite` — after files are written, before post-actions run.
 *   - `postInit`  — after post-actions have run.
 */
export type HookName = 'preInit' | 'postWrite' | 'postInit';

/**
 * The only I/O a hook ever receives (ARCH-001 Invariant A, non-negotiable):
 * the same three ports already injected into the orchestrator — never
 * ambient access to the real filesystem/process/stdin. Mirrors
 * `OrchestratorPorts` (`core/orchestrator.ts`) field-for-field; kept as a
 * separate type here since `core/types.ts` is the pure-data module and
 * `OrchestratorPorts` belongs to the orchestrator.
 *
 * A `HookHandler` also receives the real `answers` resolved for this
 * `runPlugin()` invocation as its second parameter — the same reference at
 * all three lifecycle moments (preInit/postWrite/postInit), since answers
 * never change within one invocation.
 */
export interface HookPorts {
  prompter: Prompter;
  fileWriter: FileWriter;
  processRunner: ProcessRunner;
}

export type HookHandler = (ports: HookPorts, answers: Answers) => void | Promise<void>;

export interface StackfoldPlugin {
  readonly id: string;
  readonly description: string;

  /**
   * Optional, richer help shown by `stackfold list`/`stackfold info`.
   * Absent entirely is a fully supported, first-class state — see
   * `PluginHelp`'s own doc comment.
   */
  readonly help?: PluginHelp;

  /**
   * Optional, additive (ARCH-001 Invariant D): handlers to run at each of
   * the 3 lifecycle moments, in array order. A plugin that omits this
   * field — every plugin before ARCH-001 — runs exactly as it did before;
   * the orchestrator treats an absent `hooks` field, or an absent slot
   * within it, as a no-op.
   */
  readonly hooks?: Partial<Record<HookName, HookHandler[]>>;

  /** Pure — declares what to ask. The orchestrator does the asking. */
  questions(): QuestionDefinition[];

  /** Pure, synchronous — answers in, complete blueprint out. No I/O. */
  buildBlueprint(answers: Answers): ProjectBlueprint;
}
