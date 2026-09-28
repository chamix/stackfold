import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  PostActionError,
  ScaffoldWriteError,
  formatPostAction,
  runPlugin,
  type OrchestratorPorts,
} from '../../core/orchestrator.js';
import type { PluginRegistry } from '../../core/ports.js';

export interface InitCommandDependencies {
  registry: PluginRegistry;
  ports: OrchestratorPorts;
  /** Base for resolving a relative target directory. */
  cwd: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
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
    .action(async (stack?: string, directory?: string) => {
      process.exitCode = await runInit(stack, directory, deps);
    });
}

/** Returns the process exit code; never throws. */
export async function runInit(
  stack: string | undefined,
  directory: string | undefined,
  deps: InitCommandDependencies
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
    const result = await runPlugin(plugin, targetDir, deps.ports);
    stdout(`Scaffolded ${plugin.id} project in ${result.targetDir} (${result.filesWritten.length} files).`);
    return 0;
  } catch (err) {
    reportFailure(err, stderr);
    return isPromptAbort(err) ? 130 : 1;
  }
}

function printAvailable(registry: PluginRegistry, write: (line: string) => void): void {
  write('Available stacks:');
  for (const p of registry.list()) write(`  ${p.id}  ${p.description}`);
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
