import type { Command } from 'commander';
import type { PluginRegistry } from '../../core/ports.js';
import { formatPluginListLine } from '../pluginHelp.js';

export interface ListCommandDependencies {
  registry: PluginRegistry;
  stdout: (line: string) => void;
}

/**
 * `stackfold list` — every registered plugin, one line each: display
 * name (falls back to `id`) plus description. Shares its line format
 * with `init`'s own "Available stacks" error listing, via
 * `pluginHelp.ts`.
 */
export function registerListCommand(program: Command, deps: ListCommandDependencies): void {
  program
    .command('list')
    .description('List available stackfold plugins')
    .action(() => {
      runList(deps);
    });
}

export function runList(deps: ListCommandDependencies): void {
  const { registry, stdout } = deps;
  const plugins = registry.list();

  if (plugins.length === 0) {
    stdout('No plugins registered.');
    return;
  }

  stdout('Available stacks:');
  for (const plugin of plugins) stdout(`  ${formatPluginListLine(plugin)}`);
}
