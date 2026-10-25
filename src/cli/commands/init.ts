import { resolve, join } from 'node:path';
import { cosmiconfig } from 'cosmiconfig';
import type { Command } from 'commander';
import {
  PostActionError,
  ScaffoldWriteError,
  formatPostAction,
  runPlugin,
  type OrchestratorPorts,
  type ScaffoldResult,
} from '../../core/orchestrator.js';
import type { PluginRegistry } from '../../core/ports.js';
import type { Answers, AnswerValue, QuestionDefinition } from '../../core/types.js';
import type { ProjectOpener } from '../../infra/open.js';
import { StaticPrompter } from '../../infra/prompter.js';
import { formatPluginListLine } from '../pluginHelp.js';

/**
 * The `claude-blueprints` governance workflow drops these into a target
 * directory before `stackfold init` ever runs (see testing finding #1 in
 * initial_scaffold.md). This allowlist is a composition-root concern: core/
 * (`ports.ts`, `fs.ts`, `orchestrator.ts`) stays generic and never learns
 * what "governance" means — it only ever sees `ignoreEntries`. Not
 * user-configurable; no second case exists yet (regla de tres).
 */
const GOVERNANCE_ENTRIES = ['.git', '.agents', '.claude', 'CLAUDE.md'] as const;

export interface InitCommandDependencies {
  registry: PluginRegistry;
  ports: OrchestratorPorts;
  /** Base for resolving a relative target directory. */
  cwd: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /**
   * Task 044 (UX-001 RF-3): opens the scaffolded folder/main file with the
   * OS default application, at the end of a successful, interactive
   * `init`. A CLI-layer-only dependency — never part of
   * `OrchestratorPorts`/the plugin contract (see `infra/open.ts`'s own
   * header comment).
   */
  opener: ProjectOpener;
}

/**
 * `stackfold init <stack> <directory>` — scaffold a new project from a
 * plugin. All concrete dependencies are injected by the composition root
 * (cli/index.ts).
 */
export function registerInitCommand(program: Command, deps: InitCommandDependencies): void {
  program
    .command('init')
    .description('Scaffold a new project from a stackfold plugin')
    .argument('[stack]', 'Plugin/stack to use, e.g. "electron-ts"')
    .argument('[directory]', 'Target directory (must be empty or not exist yet)')
    .option('--force', 'scaffold into a non-empty directory anyway (existing files are still never overwritten)', false)
    .option('--config <path>', 'load non-interactive answers from a config file (json/yaml/js via cosmiconfig)')
    .option(
      '--answer <keyValue>',
      'set one answer directly, repeatable: key=value ("true"/"false" become booleans, everything else stays a string)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[]
    )
    .option('--no-open', "don't prompt to open the project after a successful init")
    .action(
      async (
        stack?: string,
        directory?: string,
        options?: { force?: boolean; config?: string; answer?: string[]; open?: boolean }
      ) => {
        process.exitCode = await runInit(stack, directory, deps, {
          force: options?.force ?? false,
          config: options?.config,
          answer: options?.answer ?? [],
          open: options?.open ?? true,
        });
      }
    );
}

/** Returns the process exit code; never throws. */
export async function runInit(
  stack: string | undefined,
  directory: string | undefined,
  deps: InitCommandDependencies,
  options?: { force?: boolean; config?: string; answer?: string[]; open?: boolean }
): Promise<number> {
  const { registry, stdout, stderr } = deps;

  if (!stack) {
    stderr('stackfold init: no stack specified. Usage: stackfold init <stack> <directory>');
    printAvailable(registry, stderr);
    return 1;
  }

  const plugin = registry.resolve(stack);
  if (!plugin) {
    stderr(`stackfold init: unknown stack "${stack}".`);
    printAvailable(registry, stderr);
    return 1;
  }

  if (!directory) {
    stderr(`stackfold init: no target directory specified. Usage: stackfold init ${plugin.id} <directory>`);
    return 1;
  }

  const targetDir = resolve(deps.cwd(), directory);

  try {
    const nonInteractiveAnswers = await resolveNonInteractiveAnswers(
      options?.config,
      options?.answer ?? [],
      deps.cwd()
    );
    const ports =
      nonInteractiveAnswers === undefined
        ? deps.ports
        : { ...deps.ports, prompter: new StaticPrompter(nonInteractiveAnswers) };

    const result = await runPlugin(plugin, targetDir, ports, {
      force: options?.force ?? false,
      ignoreEntries: GOVERNANCE_ENTRIES,
    });
    stdout(`Scaffolded ${plugin.id} project in ${result.targetDir} (${result.filesWritten.length} files).`);

    await maybePromptToOpen(result, deps, options, nonInteractiveAnswers);

    return 0;
  } catch (err) {
    reportFailure(err, stderr);
    return isPromptAbort(err) ? 130 : 1;
  }
}

const OPEN_FOLDER = 'Open folder';
const OPEN_MAIN_FILE = 'Open main file';
const DONT_OPEN = "Don't open";

/**
 * Task 044 (UX-001 RF-1/RF-4): the post-init "open the project" prompt.
 * Three-way skip, in this exact order (spec's own acceptance criteria,
 * reusing `resolveNonInteractiveAnswers()`'s and UX-002's established
 * non-interactive criteria — no new mechanism):
 *   1. `--no-open` (`options.open === false`).
 *   2. `init` ran non-interactively (`nonInteractiveAnswers !== undefined`
 *      — `--config`/`--answer` were given, so `ports.prompter` is already
 *      a `StaticPrompter`, not a real interactive one).
 *   3. `!process.stdout.isTTY` (no interactive terminal to prompt into).
 *
 * A rejected/aborted prompt (Ctrl+C, `ExitPromptError`) is NOT caught
 * here — it propagates up into `runInit()`'s own `catch`, the same
 * `isPromptAbort(err)` handling every other prompt rejection in this file
 * already gets (exit code 130).
 */
async function maybePromptToOpen(
  result: ScaffoldResult,
  deps: InitCommandDependencies,
  options: { open?: boolean } | undefined,
  nonInteractiveAnswers: Answers | undefined
): Promise<void> {
  if (options?.open === false || nonInteractiveAnswers !== undefined || !process.stdout.isTTY) {
    return;
  }

  const choices = [OPEN_FOLDER, ...(result.mainFile !== undefined ? [OPEN_MAIN_FILE] : []), DONT_OPEN];
  const question: QuestionDefinition = {
    id: 'openChoice',
    message: 'Open the project now?',
    type: 'select',
    choices,
  };

  const answers = await deps.ports.prompter.ask([question]);
  const choice = answers[question.id];

  if (choice === OPEN_FOLDER) {
    await deps.opener.open(result.targetDir);
  } else if (choice === OPEN_MAIN_FILE && result.mainFile !== undefined) {
    await deps.opener.open(join(result.targetDir, result.mainFile));
  }
}

/**
 * Testing finding #2 — non-interactive `init` via config file + `--answer`
 * flags. Returns `undefined` when neither is given, meaning "stay
 * interactive" (today's `InquirerPrompter` behavior is unchanged); the
 * caller never even touches `cosmiconfig` in that case.
 *
 * Does no filtering/validation of its own — `resolveAnswers()` in the
 * orchestrator already drops undeclared keys, type-checks, and applies
 * each question's own `validate()`. This just produces the raw, possibly-
 * partial `Answers` map `StaticPrompter` will hand back verbatim.
 */
export async function resolveNonInteractiveAnswers(
  configPath: string | undefined,
  answerFlags: string[],
  cwd: string
): Promise<Answers | undefined> {
  if (configPath === undefined && answerFlags.length === 0) return undefined;

  let configAnswers: Answers = {};
  if (configPath !== undefined) {
    const result = await cosmiconfig('stackfold').load(resolve(cwd, configPath));
    const config = result?.config;
    if (result === null || typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`stackfold init: config file "${configPath}" must contain an object of answers.`);
    }
    configAnswers = config as Answers;
  }

  const overrideAnswers: Answers = {};
  for (const entry of answerFlags) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`stackfold init: --answer must be in the form key=value, got "${entry}".`);
    }
    const key = entry.slice(0, separatorIndex);
    const rawValue = entry.slice(separatorIndex + 1);
    overrideAnswers[key] = coerceAnswerValue(rawValue);
  }

  return { ...configAnswers, ...overrideAnswers };
}

function coerceAnswerValue(raw: string): AnswerValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function printAvailable(registry: PluginRegistry, write: (line: string) => void): void {
  write('Available stacks:');
  for (const p of registry.list()) write(`  ${formatPluginListLine(p)}`);
}

/** Best-effort failure reporting (initial_scaffold.md §3.2 resolution). */
function reportFailure(err: unknown, write: (line: string) => void): void {
  if (isPromptAbort(err)) {
    write('stackfold init: aborted. Nothing was written.');
    return;
  }

  write(`stackfold init: ${err instanceof Error ? err.message : String(err)}`);

  if (err instanceof ScaffoldWriteError) {
    listSection(write, 'Written before the failure (remove or keep by hand):', err.writtenFiles);
    listSection(write, 'Failed:', [err.failedFile]);
    listSection(write, 'Not written:', err.pendingFiles);
  } else if (err instanceof PostActionError) {
    listSection(write, 'Completed follow-up actions:', err.completedActions.map(formatPostAction));
    listSection(write, 'Not run (run these by hand in the project directory):', [
      formatPostAction(err.failedAction),
      ...err.pendingActions.map(formatPostAction),
    ]);
  }
}

function listSection(write: (line: string) => void, title: string, items: string[]): void {
  if (items.length === 0) return;
  write(title);
  for (const item of items) write(`  ${item}`);
}

/** @inquirer/prompts rejects with ExitPromptError on Ctrl+C. */
function isPromptAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}
