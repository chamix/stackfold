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
import { NodeFileWriter } from '../infra/fs.js';
import { StaticPluginRegistry } from '../infra/pluginLoader.js';
import { ExecaProcessRunner } from '../infra/processRunner.js';
import { InquirerPrompter } from '../infra/prompter.js';
import { electronTsPlugin } from '../plugins/electron-ts/index.js';
import { webAppSpaPlugin, webAppStandaloneHtmlPlugin } from '../plugins/web-app/index.js';

const registry = new StaticPluginRegistry([electronTsPlugin, webAppSpaPlugin, webAppStandaloneHtmlPlugin]);

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
