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
import { registerScaffoldSynthCommand } from './commands/scaffoldSynth.js';
import { NodeFileWriter } from '../infra/fs.js';
import { StaticPluginRegistry } from '../infra/pluginLoader.js';
import { ExecaProcessRunner } from '../infra/processRunner.js';
import { InquirerPrompter } from '../infra/prompter.js';
// stackfold-plugin-imports:start
import { compileScaffold, type ScaffoldDefinition } from '../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';
import { electronTsPlugin } from '../plugins/electron-ts/index.js';
// stackfold-plugin-imports:end

/**
 * Compiles any declaratively-authored (`ScaffoldDefinition`) plugin into a
 * real `StackfoldPlugin` (ARCH-001/Task 034) — the one place in the CLI
 * allowed to import `infra/` (Inward Dependency Rule: `plugins/` stays
 * `core/`-only, so this compile step lives here, in the composition root).
 * Shared by `plugin-builder` itself below — compiled directly from its own
 * `scaffold.js` (not `scaffold.json`), so its questions' `validate`
 * closures stay live (Task 042 review follow-up, review_report.md Blocking
 * #1 — JSON cannot carry function values, so a JSON-compiled runtime path
 * silently dropped every `validate` closure) — and by any future plugin
 * `plugin-builder` generates (its own `patchFile` hooks insert a
 * `compileScaffold(...)` call referencing this same instance, sourced from
 * that generated plugin's own `scaffold.json` — an ordinary generated
 * plugin has no TS factory/validate concerns of its own, so JSON is fine
 * there; see `plugins/plugin-builder/scaffold.ts`).
 */
const expressionEvaluator = new JsonLogicExpressionEvaluator();

const registry = new StaticPluginRegistry([
  electronTsPlugin,
  compileScaffold(
    (await import('../plugins/electron-stackfold/scaffold.json', { with: { type: 'json' } })).default as ScaffoldDefinition,
    expressionEvaluator
  ),
  compileScaffold((await import('../plugins/plugin-builder/scaffold.js')).default, expressionEvaluator),
  // web-app-stackfold (Task 043) compiles from its own `scaffold.js`, not
  // `scaffold.json` — same reason as `plugin-builder` above: its
  // `appName`/`description`/`author` questions carry `validate: toValidate(...)`
  // closures (function values JSON cannot carry), so a JSON-compiled
  // runtime path would silently drop them.
  compileScaffold((await import('../plugins/web-app-stackfold/scaffold.js')).default, expressionEvaluator),
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

registerScaffoldSynthCommand(program, {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  cwd: () => process.cwd(),
});

await program.parseAsync();
