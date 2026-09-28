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
 */
import type { FileWriter, ProcessRunner, Prompter } from './ports.js';
import type {
  AnswerValue,
  Answers,
  PostActionDefinition,
  ProjectBlueprint,
  QuestionDefinition,
  StackfoldPlugin,
} from './types.js';

export interface OrchestratorPorts {
  prompter: Prompter;
  fileWriter: FileWriter;
  processRunner: ProcessRunner;
}

export interface ScaffoldResult {
  targetDir: string;
  /** Relative paths, in the order they were written. */
  filesWritten: string[];
  postActionsRun: PostActionDefinition[];
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
    cause: unknown
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
  ports: OrchestratorPorts
): Promise<ScaffoldResult> {
  const questions = plugin.questions();
  assertValidQuestions(plugin.id, questions);

  const rawAnswers = await ports.prompter.ask(questions);
  const answers = resolveAnswers(questions, rawAnswers);

  const blueprint = plugin.buildBlueprint(answers);
  const plannedFiles = planFiles(plugin.id, targetDir, blueprint);

  await ports.fileWriter.ensureEmptyDir(targetDir);

  const filesWritten = await writeFiles(targetDir, plannedFiles, ports.fileWriter);
  const postActionsRun = await runPostActions(
    targetDir,
    filesWritten,
    blueprint.postActions,
    ports.processRunner
  );

  return { targetDir, filesWritten, postActionsRun };
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
