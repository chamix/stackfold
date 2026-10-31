import type { Command } from 'commander';
import type { PluginRegistry } from '../../core/ports.js';
import { formatPluginInfo, formatPluginListEntry } from '../pluginHelp.js';

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
    .action(async (stack: string) => {
      process.exitCode = await runInfo(stack, deps);
    });
}

/** Returns the process exit code; never throws. */
export async function runInfo(stack: string, deps: InfoCommandDependencies): Promise<number> {
  const { registry, stdout, stderr } = deps;

  const plugin = await registry.resolve(stack);
  if (!plugin) {
    stderr(`stackfold info: unknown stack "${stack}".`);
    stderr('Available stacks:');
    (await registry.list()).forEach((p, index) => {
      if (index > 0) stderr('');
      for (const line of formatPluginListEntry(p)) stderr(`  ${line}`);
    });
    return 1;
  }

  for (const line of formatPluginInfo(plugin)) stdout(line);
  return 0;
}
