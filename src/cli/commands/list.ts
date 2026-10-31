import type { Command } from 'commander';
import type { PluginRegistry } from '../../core/ports.js';
import { formatPluginListEntry } from '../pluginHelp.js';

export interface ListCommandDependencies {
  registry: PluginRegistry;
  stdout: (line: string) => void;
}

/**
 * `stackfold list` — every registered plugin, one block each: display
 * name (falls back to `id`) plus its word-wrapped description. Shares
 * its entry format with `init`'s own "Available stacks" error listing,
 * via `pluginHelp.ts`.
 */
export function registerListCommand(program: Command, deps: ListCommandDependencies): void {
  program
    .command('list')
    .description('List available stackfold plugins')
    .action(async () => {
      await runList(deps);
    });
}

export async function runList(deps: ListCommandDependencies): Promise<void> {
  const { registry, stdout } = deps;
  const plugins = await registry.list();

  if (plugins.length === 0) {
    stdout('No plugins registered.');
    return;
  }

  stdout('Available stacks:');
  plugins.forEach((plugin, index) => {
    if (index > 0) stdout('');
    for (const line of formatPluginListEntry(plugin)) stdout(`  ${line}`);
  });
}
