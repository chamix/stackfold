import type { Command } from 'commander';
import type { PluginRegistry } from '../../core/ports.js';
import { formatPluginInfo, formatPluginListLine } from '../pluginHelp.js';

export interface InfoCommandDependencies {
  registry: PluginRegistry;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * `stackfold info <stack>` — a single plugin's detailed help: display
 * name, description, its optional `help.details` prose (omitted when the
 * plugin doesn't provide one), and the questions it will ask.
 */
export function registerInfoCommand(program: Command, deps: InfoCommandDependencies): void {
  program
    .command('info')
    .description("Show a stackfold plugin's detailed help")
    .argument('<stack>', 'Plugin/stack id, e.g. "electron-ts"')
    .action((stack: string) => {
      process.exitCode = runInfo(stack, deps);
    });
}

/** Returns the process exit code; never throws. */
export function runInfo(stack: string, deps: InfoCommandDependencies): number {
  const { registry, stdout, stderr } = deps;

  const plugin = registry.resolve(stack);
  if (!plugin) {
    stderr(`stackfold info: unknown stack "${stack}".`);
    stderr('Available stacks:');
    for (const p of registry.list()) stderr(`  ${formatPluginListLine(p)}`);
    return 1;
  }

  for (const line of formatPluginInfo(plugin)) stdout(line);
  return 0;
}
