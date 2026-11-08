/**
 * The orchestrator: drives one `StackfoldPlugin` (Strategy) through a fixed
 * sequence of steps (Template Method) — .agents/specs/initial_scaffold.md,
 * "Pattern Application (GoF)":
 *
 *   1. collect answers         (Prompter port)        — §3.1
 *   2. build blueprint         (plugin, pure + sync)  — §2
 *   3. validate blueprint      (pure, before any I/O)
 *   4. ensure target is empty  (FileWriter port)      — §3.3
 *   5. write files, in order   (FileWriter port)      — §3.2, best-effort
 *   6. run post-actions        (ProcessRunner port)   — declarative Commands
 *
 * No plugin can reorder or skip a step. This module depends only on
 * `core/` types and ports — no node:fs / node:path / execa here (Inward
 * Dependency Rule); concrete adapters are injected by the CLI.
 *
 * Atomicity is deliberately best-effort, not staged+atomic (resolved
 * sub-decision in initial_scaffold.md): on failure we stop and report
 * exactly what was and wasn't done, rather than rolling back.
 *
 * ARCH-004 / SK-ADR-006 amends that last sentence for two specific failure
 * classes (`ScaffoldWriteError`, and a `HookError` raised in `postWrite`):
 * when the optional `FileRemover` port is supplied and the caller did not
 * ask to `keepOnFailure`, the orchestrator compensates (Unit of Work-style)
 * by removing the files *it itself wrote* during this run, in reverse
 * order, then pruning directories left empty strictly below `targetDir`
 * (never `targetDir` itself). No other failure class, and no plugin/hook
 * side effect (patchFile edits, `npm install`, `git init`), is ever undone.
 * Without the port (or with `keepOnFailure`), behavior is byte-for-byte
 * today's best-effort reporting.
 */
import type { FileRemover, FileWriter, ProcessRunner, Prompter } from './ports.js';
import type {
  AnswerValue,
  Answers,
  HookName,
  HookPorts,
  PostActionDefinition,
  ProjectBlueprint,
  QuestionDefinition,
  StackfoldPlugin,
} from './types.js';

export interface OrchestratorPorts {
  prompter: Prompter;
  fileWriter: FileWriter;
  processRunner: ProcessRunner;
  /**
   * Optional (ARCH-004, D3). Absent on every pre-ARCH-004 caller/fake —
   * rollback is then skipped entirely and behavior is unchanged
   * (Invariant 5, backward compatible). Held by the orchestrator only;
   * never forwarded into `HookPorts` (Invariant A).
   */
  fileRemover?: FileRemover;
}

/** One rollback compensation's outcome — attached to the triggering error. */
export interface RollbackOutcome {
  rolledBack: string[];
  rollbackFailures: RollbackFailure[];
}

export interface RollbackFailure {
  path: string;
  reason: string;
}

const NO_ROLLBACK: RollbackOutcome = { rolledBack: [], rollbackFailures: [] };

export interface ScaffoldResult {
  targetDir: string;
  /** Relative paths, in the order they were written. */
  filesWritten: string[];
  postActionsRun: PostActionDefinition[];
  /**
   * Optional (Task 044, UX-001/SK-ADR-004): copied verbatim from
   * `blueprint.mainFile` when the plugin declared one — never
   * `mainFile: undefined` otherwise. `cli/commands/init.ts` has no other
   * way to see this field, since every other `ProjectBlueprint` property
   * besides `files`/`postActions` is otherwise dropped on the way out of
   * `runPlugin()`.
   */
  mainFile?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The plugin's declared question schema is malformed (a plugin bug). */
export class InvalidQuestionsError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly issues: string[]
  ) {
    super(`Plugin "${pluginId}" declared an invalid question schema:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidQuestionsError';
  }
}

export interface AnswerIssue {
  questionId: string;
  message: string;
}

/** §3.1 — the collected answers are incomplete or fail validation. */
export class InvalidAnswersError extends Error {
  constructor(public readonly issues: AnswerIssue[]) {
    super(`Invalid answers:\n  - ${issues.map((i) => `${i.questionId}: ${i.message}`).join('\n  - ')}`);
    this.name = 'InvalidAnswersError';
  }
}

/** The plugin produced a blueprint that cannot be safely executed (a plugin bug). */
export class InvalidBlueprintError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly issues: string[]
  ) {
    super(`Plugin "${pluginId}" produced an invalid blueprint:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidBlueprintError';
  }
}

/** §3.2 (best-effort) — a file write failed partway through. */
export class ScaffoldWriteError extends Error {
  constructor(
    public readonly targetDir: string,
    public readonly writtenFiles: string[],
    public readonly failedFile: string,
    public readonly pendingFiles: string[],
    cause: unknown,
    /**
     * ARCH-004/D5: populated only when a `FileRemover` was supplied and
     * `keepOnFailure` was not set — `[]` otherwise (legacy shape,
     * unchanged message/other fields).
     */
    public readonly rolledBack: string[] = [],
    public readonly rollbackFailures: RollbackFailure[] = []
  ) {
    super(
      `Failed to write "${failedFile}" into ${targetDir}: ${errorMessage(cause)}. ` +
        `${writtenFiles.length} file(s) were written before the failure; ` +
        `${pendingFiles.length} file(s) were not written.`,
      { cause }
    );
    this.name = 'ScaffoldWriteError';
  }
}

/**
 * A plugin's hook handler (ARCH-001 Step 1 item 3) threw. Deliberately not
 * `PostActionError` — a hook is arbitrary code with an entirely different
 * signature (`HookHandler`, not `PostActionDefinition`), not a declarative
 * Command; conflating the two error categories would lose that distinction
 * in the error report. `hookName` identifies which of the 3 lifecycle
 * moments (preInit/postWrite/postInit) was running; `handlerIndex` is the
 * position of the specific handler within that moment's array (a plugin may
 * register more than one handler per moment, same as `blueprint.postActions`
 * is itself an ordered list).
 */
export class HookError extends Error {
  constructor(
    public readonly hookName: HookName,
    public readonly handlerIndex: number,
    cause: unknown,
    /**
     * ARCH-004/D5: the files the orchestrator had written by the time this
     * hook ran — `[]` for `preInit` (runs before any write), the full
     * written list for `postWrite`/`postInit`. Previously `HookError` gave
     * no visibility into this at all.
     */
    public readonly filesWritten: string[] = [],
    /** Populated only for a `postWrite` failure with rollback actually run. */
    public readonly rolledBack: string[] = [],
    public readonly rollbackFailures: RollbackFailure[] = []
  ) {
    super(`Hook "${hookName}" handler #${handlerIndex} failed: ${errorMessage(cause)}`, { cause });
    this.name = 'HookError';
  }
}

/** §3.2 (best-effort) — all files were written but a follow-up action failed. */
export class PostActionError extends Error {
  constructor(
    public readonly targetDir: string,
    public readonly filesWritten: string[],
    public readonly completedActions: PostActionDefinition[],
    public readonly failedAction: PostActionDefinition,
    public readonly pendingActions: PostActionDefinition[],
    cause: unknown
  ) {
    super(
      `All files were written to ${targetDir}, but post-action "${formatPostAction(failedAction)}" failed: ` +
        `${errorMessage(cause)}.`,
      { cause }
    );
    this.name = 'PostActionError';
  }
}

// ---------------------------------------------------------------------------
// Template Method
// ---------------------------------------------------------------------------

export async function runPlugin(
  plugin: StackfoldPlugin,
  targetDir: string,
  ports: OrchestratorPorts,
  options?: { force?: boolean; ignoreEntries?: readonly string[]; keepOnFailure?: boolean }
): Promise<ScaffoldResult> {
  const questions = plugin.questions();
  assertValidQuestions(plugin.id, questions);

  const rawAnswers = await ports.prompter.ask(questions);
  const answers = resolveAnswers(questions, rawAnswers);

  // ARCH-004 Invariant A: hooks get a NEW object carrying exactly these 3
  // ports — never `ports` itself, so a hook can never reach `fileRemover`
  // (the orchestrator's own, non-negotiable deletion capability).
  const hookPorts: HookPorts = {
    prompter: ports.prompter,
    fileWriter: ports.fileWriter,
    processRunner: ports.processRunner,
  };

  await runHooks('preInit', plugin.hooks, hookPorts, answers, []);

  const blueprint = plugin.buildBlueprint(answers);
  const plannedFiles = planFiles(plugin.id, targetDir, blueprint);

  await ports.fileWriter.ensureEmptyDir(targetDir, options);

  let filesWritten: string[];
  try {
    filesWritten = await writeFiles(targetDir, plannedFiles, ports.fileWriter);
  } catch (err) {
    throw await attachRollback(err, targetDir, ports, options?.keepOnFailure ?? false);
  }

  try {
    await runHooks('postWrite', plugin.hooks, hookPorts, answers, filesWritten);
  } catch (err) {
    throw await attachRollback(err, targetDir, ports, options?.keepOnFailure ?? false);
  }

  const postActionsRun = await runPostActions(
    targetDir,
    filesWritten,
    blueprint.postActions,
    ports.processRunner
  );

  await runHooks('postInit', plugin.hooks, hookPorts, answers, filesWritten);

  return {
    targetDir,
    filesWritten,
    postActionsRun,
    ...(blueprint.mainFile !== undefined ? { mainFile: blueprint.mainFile } : {}),
  };
}

// ---------------------------------------------------------------------------
// ARCH-004 / SK-ADR-006 — rollback on a D1 failure class
// ---------------------------------------------------------------------------

/**
 * Only `ScaffoldWriteError` and a `HookError` raised in `postWrite` are D1
 * rollback triggers. Everything else (`InvalidAnswersError`,
 * `InvalidBlueprintError`, a `preInit`/`postInit` `HookError`,
 * `PostActionError`, an `ensureEmptyDir()` rejection) is returned
 * unchanged — the output there is either untouched or already complete,
 * and the existing "do this by hand" UX is deliberate (see the ADR).
 *
 * When this IS a trigger but rollback does not actually run (no
 * `fileRemover`, or `keepOnFailure`), the error is still replaced — never
 * mutated — with an equivalent one carrying explicit, empty
 * `rolledBack`/`rollbackFailures`, so callers never have to special-case
 * "undefined" vs "legacy, nothing attempted".
 */
async function attachRollback(
  err: unknown,
  targetDir: string,
  ports: OrchestratorPorts,
  keepOnFailure: boolean
): Promise<unknown> {
  if (err instanceof ScaffoldWriteError) {
    const outcome = await runCompensation(err.writtenFiles, targetDir, ports, keepOnFailure);
    return new ScaffoldWriteError(
      err.targetDir,
      err.writtenFiles,
      err.failedFile,
      err.pendingFiles,
      err.cause,
      outcome.rolledBack,
      outcome.rollbackFailures
    );
  }

  if (err instanceof HookError && err.hookName === 'postWrite') {
    const outcome = await runCompensation(err.filesWritten, targetDir, ports, keepOnFailure);
    return new HookError(
      err.hookName,
      err.handlerIndex,
      err.cause,
      err.filesWritten,
      outcome.rolledBack,
      outcome.rollbackFailures
    );
  }

  return err;
}

async function runCompensation(
  journal: string[],
  targetDir: string,
  ports: OrchestratorPorts,
  keepOnFailure: boolean
): Promise<RollbackOutcome> {
  if (!ports.fileRemover || keepOnFailure) return NO_ROLLBACK;
  return compensate(targetDir, journal, ports.fileRemover);
}

/**
 * Removes journaled files in reverse order (D4/Invariant 2), then prunes
 * directories left empty strictly below `targetDir`, deepest first —
 * `targetDir` itself is never a candidate. A failure removing one file
 * never stops the rest of the journal from being attempted, and is
 * reported in `rollbackFailures`, never thrown past this function
 * (Invariant 4: rollback failing never masks the original error).
 */
async function compensate(
  targetDir: string,
  journal: string[],
  fileRemover: FileRemover
): Promise<RollbackOutcome> {
  const base = stripTrailingSeparators(targetDir);
  const rolledBack: string[] = [];
  const rollbackFailures: RollbackFailure[] = [];
  const candidateDirs = new Set<string>();

  for (const relativePath of [...journal].reverse()) {
    const segments = relativePath.split(/[\\/]/);
    const absolutePath = `${base}/${segments.join('/')}`;

    try {
      await fileRemover.removeFile(absolutePath, targetDir);
      rolledBack.push(relativePath);

      let dir = base;
      for (const segment of segments.slice(0, -1)) {
        dir = `${dir}/${segment}`;
        candidateDirs.add(dir);
      }
    } catch (cause) {
      rollbackFailures.push({ path: relativePath, reason: errorMessage(cause) });
    }
  }

  const deepestFirst = [...candidateDirs].sort(
    (a, b) => b.split('/').length - a.split('/').length
  );
  for (const dir of deepestFirst) {
    // Best-effort pruning only — a non-empty or already-missing directory
    // is expected and not a failure; any other adapter-level error is
    // swallowed too (an empty leftover directory is an explicitly accepted
    // outcome, D4).
    await fileRemover.removeDirIfEmpty(dir, targetDir).catch(() => undefined);
  }

  return { rolledBack, rollbackFailures };
}

// ---------------------------------------------------------------------------
// Hook invocation points (ARCH-001 Step 1 item 3)
// ---------------------------------------------------------------------------

/**
 * Runs every handler registered for `hookName`, in array order. A no-op
 * when `hooks` is absent or has no handlers for this moment — the path every
 * pre-ARCH-001 plugin takes, unchanged. Each handler call is individually
 * wrapped so a failure identifies exactly which handler (by index) failed.
 *
 * `answers` is the same `Answers` reference `runPlugin()` resolved for this
 * invocation, handed to every handler at all three lifecycle moments — never
 * recomputed per call, so a `preInit` handler sees the real answers just as
 * `postWrite`/`postInit` already did.
 */
async function runHooks(
  hookName: HookName,
  hooks: StackfoldPlugin['hooks'],
  ports: HookPorts,
  answers: Answers,
  filesWritten: string[]
): Promise<void> {
  const handlers = hooks?.[hookName];
  if (!handlers || handlers.length === 0) return;

  for (const [index, handler] of handlers.entries()) {
    try {
      await handler(ports, answers);
    } catch (cause) {
      throw new HookError(hookName, index, cause, filesWritten);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1 — questions & answers (pure)
// ---------------------------------------------------------------------------

function assertValidQuestions(pluginId: string, questions: QuestionDefinition[]): void {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const q of questions) {
    if (!q.id) issues.push('a question has an empty id');
    if (seen.has(q.id)) issues.push(`duplicate question id "${q.id}"`);
    seen.add(q.id);
    if (q.type === 'select' && (!q.choices || q.choices.length === 0)) {
      issues.push(`select question "${q.id}" must declare at least one choice`);
    }
  }

  if (issues.length > 0) throw new InvalidQuestionsError(pluginId, issues);
}

/**
 * §3.1: every declared question resolved (answer or default), every answer
 * of the right type and passing its validation rule. Undeclared keys are
 * dropped so a plugin only ever sees answers to questions it asked.
 */
function resolveAnswers(questions: QuestionDefinition[], raw: Answers): Answers {
  const resolved: Answers = {};
  const issues: AnswerIssue[] = [];

  for (const q of questions) {
    const value: AnswerValue | undefined = Object.hasOwn(raw, q.id) ? raw[q.id] : q.default;

    if (value === undefined) {
      issues.push({ questionId: q.id, message: 'no answer given and no default declared' });
      continue;
    }

    const typeIssue = checkAnswerType(q, value);
    if (typeIssue) {
      issues.push({ questionId: q.id, message: typeIssue });
      continue;
    }

    const verdict = q.validate ? q.validate(value) : true;
    if (verdict !== true) {
      issues.push({ questionId: q.id, message: verdict });
      continue;
    }

    resolved[q.id] = value;
  }

  if (issues.length > 0) throw new InvalidAnswersError(issues);
  return resolved;
}

function checkAnswerType(q: QuestionDefinition, value: AnswerValue): string | undefined {
  switch (q.type) {
    case 'confirm':
      return typeof value === 'boolean' ? undefined : `expected a yes/no answer, got ${typeof value}`;
    case 'input':
      return typeof value === 'string' || typeof value === 'number'
        ? undefined
        : `expected text, got ${typeof value}`;
    case 'select':
      return typeof value === 'string' && (q.choices ?? []).includes(value)
        ? undefined
        : `expected one of: ${(q.choices ?? []).join(', ')}`;
  }
}

// ---------------------------------------------------------------------------
// Step 3 — blueprint validation (pure)
// ---------------------------------------------------------------------------

interface PlannedFile {
  relativePath: string;
  absolutePath: string;
  content: string | Buffer;
}

/**
 * Validates the whole blueprint up front — before the target directory is
 * touched — and resolves each entry's absolute path. Implemented with plain
 * string handling (no node:path) to keep core/ free of runtime modules; the
 * rules are deliberately strict so the result is the same on POSIX and
 * Windows.
 */
function planFiles(pluginId: string, targetDir: string, blueprint: ProjectBlueprint): PlannedFile[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const base = stripTrailingSeparators(targetDir);
  const planned: PlannedFile[] = [];

  for (const entry of blueprint.files) {
    const pathIssue = checkRelativePath(entry.path);
    if (pathIssue) {
      issues.push(`file path ${JSON.stringify(entry.path)}: ${pathIssue}`);
      continue;
    }

    const segments = entry.path.split(/[\\/]/);
    // Case-insensitive: Windows and default macOS filesystems would collide.
    const key = segments.join('/').toLowerCase();
    if (seen.has(key)) {
      issues.push(`duplicate file path ${JSON.stringify(entry.path)}`);
      continue;
    }
    seen.add(key);

    planned.push({
      relativePath: entry.path,
      absolutePath: `${base}/${segments.join('/')}`,
      content: entry.content,
    });
  }

  for (const action of blueprint.postActions) {
    const actionIssue = checkPostAction(action);
    if (actionIssue) issues.push(actionIssue);
  }

  if (issues.length > 0) throw new InvalidBlueprintError(pluginId, issues);
  return planned;
}

function checkRelativePath(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return 'must be a non-empty relative path';
  if (path.includes('\0')) return 'must not contain NUL bytes';
  if (path.includes(':')) return 'must not contain ":" (drive letters / alternate data streams)';
  if (path.startsWith('/') || path.startsWith('\\')) return 'must be relative, not absolute';

  for (const segment of path.split(/[\\/]/)) {
    if (segment === '') return 'must not contain empty segments or a trailing separator';
    if (segment === '.' || segment === '..') return 'must not contain "." or ".." segments';
  }
  return undefined;
}

function checkPostAction(action: PostActionDefinition): string | undefined {
  switch (action.kind) {
    case 'git-init':
    case 'npm-install':
      return undefined;
    case 'run-command':
      if (typeof action.command !== 'string' || action.command.trim() === '') {
        return 'run-command post-action must declare a non-empty command';
      }
      if (!Array.isArray(action.args) || action.args.some((a) => typeof a !== 'string')) {
        return `run-command "${action.command}" must declare args as an array of strings`;
      }
      return undefined;
    default:
      return `unknown post-action kind ${JSON.stringify((action as { kind: unknown }).kind)}`;
  }
}

function stripTrailingSeparators(dir: string): string {
  return dir.replace(/[\\/]+$/, '');
}

// ---------------------------------------------------------------------------
// Steps 5 & 6 — execution (via ports), best-effort reporting on failure
// ---------------------------------------------------------------------------

async function writeFiles(
  targetDir: string,
  planned: PlannedFile[],
  fileWriter: FileWriter
): Promise<string[]> {
  const written: string[] = [];

  for (const [index, file] of planned.entries()) {
    try {
      await fileWriter.writeFile(file.absolutePath, file.content);
    } catch (cause) {
      throw new ScaffoldWriteError(
        targetDir,
        written,
        file.relativePath,
        planned.slice(index + 1).map((f) => f.relativePath),
        cause
      );
    }
    written.push(file.relativePath);
  }

  return written;
}

async function runPostActions(
  targetDir: string,
  filesWritten: string[],
  actions: PostActionDefinition[],
  processRunner: ProcessRunner
): Promise<PostActionDefinition[]> {
  const completed: PostActionDefinition[] = [];

  for (const [index, action] of actions.entries()) {
    const { command, args } = toCommand(action);
    try {
      await processRunner.run(command, args, { cwd: targetDir });
    } catch (cause) {
      throw new PostActionError(
        targetDir,
        filesWritten,
        completed,
        action,
        actions.slice(index + 1),
        cause
      );
    }
    completed.push(action);
  }

  return completed;
}

/** Central interpreter for the declarative post-action Commands. */
function toCommand(action: PostActionDefinition): { command: string; args: string[] } {
  switch (action.kind) {
    case 'git-init':
      return { command: 'git', args: ['init'] };
    case 'npm-install':
      return { command: 'npm', args: ['install'] };
    case 'run-command':
      return { command: action.command, args: [...action.args] };
  }
}

/**
 * The single human-readable form of a post-action, derived from the same
 * mapping `runPostActions` executes — so any "run this by hand" text shown
 * to the user can never drift from what actually runs.
 */
export function formatPostAction(action: PostActionDefinition): string {
  const { command, args } = toCommand(action);
  return [command, ...args].join(' ');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
