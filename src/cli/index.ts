#!/usr/bin/env node
/**
 * CLI composition root — the only layer that instantiates concrete infra/
 * adapters and plugins and wires them into core/ (Inward Dependency Rule).
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerInfoCommand } from './commands/info.js';
import { registerInitCommand } from './commands/init.js';
import { registerListCommand } from './commands/list.js';
import { defaultGitUserName, NodeFileWriter } from '../infra/fs.js';
import { StaticPluginRegistry } from '../infra/pluginLoader.js';
import { ExecaProcessRunner } from '../infra/processRunner.js';
import { InquirerPrompter } from '../infra/prompter.js';
// stackfold-plugin-imports:start
import { compileScaffold, type ScaffoldDefinition } from '../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';
import { electronTsPlugin } from '../plugins/electron-ts/index.js';
import { webAppSpaPlugin, webAppStandaloneHtmlPlugin } from '../plugins/web-app/index.js';
import { createPluginBuilderDefinition } from '../plugins/plugin-builder/index.js';
// stackfold-plugin-imports:end

/**
 * Compiles any declaratively-authored (`ScaffoldDefinition`) plugin into a
 * real `StackfoldPlugin` (ARCH-001/Task 034) — the one place in the CLI
 * allowed to import `infra/` (Inward Dependency Rule: `plugins/` stays
 * `core/`-only, so this compile step lives here, in the composition root).
 * Shared by `plugin-builder` itself below and by any future plugin
 * `plugin-builder` generates (its own `patchFile` hooks insert a
 * `compileScaffold(...)` call referencing this same instance — see
 * `plugins/plugin-builder/index.ts`).
 */
const expressionEvaluator = new JsonLogicExpressionEvaluator();

const registry = new StaticPluginRegistry([
  electronTsPlugin,
  webAppSpaPlugin,
  webAppStandaloneHtmlPlugin,
  compileScaffold(createPluginBuilderDefinition({ gitUserName: defaultGitUserName }), expressionEvaluator),
  compileScaffold(
    (await import('../plugins/electron-stackfold/scaffold.json', { with: { type: 'json' } })).default as ScaffoldDefinition,
    expressionEvaluator
  ),
  // stackfold-plugin-registry:end
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };

const program = new Command();

program
  .name('stackfold')
  .description('Stack-agnostic scaffolding CLI with a plugin-based generator system.')
  .version(version);

registerInitCommand(program, {
  registry,
  ports: {
    prompter: new InquirerPrompter(),
    fileWriter: new NodeFileWriter(),
    processRunner: new ExecaProcessRunner(),
  },
  cwd: () => process.cwd(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

registerListCommand(program, {
  registry,
  stdout: (line) => console.log(line),
});

registerInfoCommand(program, {
  registry,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

await program.parseAsync();
