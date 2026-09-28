#!/usr/bin/env node
/**
 * CLI composition root — the only layer that instantiates concrete infra/
 * adapters and plugins and wires them into core/ (Inward Dependency Rule).
 */
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { NodeFileWriter } from '../infra/fs.js';
import { StaticPluginRegistry } from '../infra/pluginLoader.js';
import { ExecaProcessRunner } from '../infra/processRunner.js';
import { InquirerPrompter } from '../infra/prompter.js';
import { electronTsPlugin } from '../plugins/electron-ts/index.js';

const registry = new StaticPluginRegistry([electronTsPlugin]);

const program = new Command();

program
  .name('stackfold')
  .description('Stack-agnostic scaffolding CLI with a plugin-based generator system.')
  .version('0.1.0');

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

await program.parseAsync();
