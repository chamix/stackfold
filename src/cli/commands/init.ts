import { Command } from 'commander';

/**
 * `stackfold init` — scaffold a new project from a plugin.
 *
 * TODO: wire to the plugin loader + orchestrator once those are real.
 * For now this just proves the CLI entry point runs end-to-end.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new project from a stackfold plugin')
    .argument('[stack]', 'Plugin/stack to use, e.g. "electron-ts"')
    .action((stack?: string) => {
      console.log(
        stack
          ? `stackfold init: "${stack}" plugin support is not implemented yet.`
          : 'stackfold init: no stack specified. Try: stackfold init electron-ts'
      );
    });
}
