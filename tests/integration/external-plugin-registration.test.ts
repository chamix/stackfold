import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPluginList, runPluginRegister, type PluginCommandDependencies } from '../../src/cli/commands/plugin.js';
import { runList, type ListCommandDependencies } from '../../src/cli/commands/list.js';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { CompositePluginRegistry } from '../../src/infra/compositePluginRegistry.js';
import { DynamicPluginRegistry } from '../../src/infra/dynamicPluginRegistry.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { ProjectOpener } from '../../src/infra/open.js';

/**
 * Real end-to-end: a real `scaffold.json` on real disk, registered via the
 * real `stackfold plugin register --project` pipeline (real cosmiconfig
 * search/write, real dynamic `import()`, real `compileScaffold()`, real
 * smoke test) — never a fake for any of those. The global level is never
 * touched by this test (it's a fixed `~/.stackfoldrc.json` path outside any
 * tmpdir) — `--project` keeps everything scoped under the test's own
 * tmpdir, per Task 049's acceptance criteria: "register a real scaffold.json
 * in a tmpdir, confirm `stackfold list` shows it and `stackfold init` can
 * use it".
 */

let projectDir: string;
let targetDir: string;
const evaluator = new JsonLogicExpressionEvaluator();

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'stackfold-external-plugin-'));
  targetDir = join(projectDir, 'scaffolded-app');
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function pluginDeps(): PluginCommandDependencies & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    cwd: () => projectDir,
    evaluator,
    stdout: (l) => stdoutLines.push(l),
    stderr: (l) => stderrLines.push(l),
    stdoutLines,
    stderrLines,
  };
}

function compositeRegistry() {
  const staticRegistry = new StaticPluginRegistry([]);
  const dynamicRegistry = new DynamicPluginRegistry({ evaluator, cwd: () => projectDir });
  return new CompositePluginRegistry([staticRegistry, dynamicRegistry]);
}

describe('external plugin registration — real end-to-end (tmpdir, --project)', () => {
  it('a registered valid scaffold.json shows up in both "stackfold plugin list" and "stackfold list", and "stackfold init" can scaffold from it', async () => {
    const sourcePath = join(projectDir, 'my-plugin.json');
    await writeFile(
      sourcePath,
      JSON.stringify({
        id: 'external-fixture',
        description: 'An externally registered fixture plugin.',
        questions: [{ id: 'appName', message: 'App name?', type: 'input', default: 'Fixture App' }],
        steps: [{ action: 'writeFile', params: { path: 'README.md', content: '# {{appName}}\n' } }],
      }),
      'utf8'
    );

    // 1. Register (--project) — real cosmiconfig write under projectDir.
    const registerDeps = pluginDeps();
    const registerCode = await runPluginRegister('my-plugin.json', { project: true }, registerDeps);
    expect(registerDeps.stderrLines).toEqual([]);
    expect(registerCode).toBe(0);

    const configPath = join(projectDir, '.stackfold-pluginsrc.json');
    const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as { plugins: Record<string, unknown> };
    expect(rawConfig.plugins).toEqual({ 'external-fixture': { source: 'my-plugin.json', kind: 'scaffold-json' } });

    // 2. `stackfold plugin list` — the registered-entries view, resolves ✓.
    const pluginListDeps = pluginDeps();
    await runPluginList(pluginListDeps);
    expect(pluginListDeps.stdoutLines.join('\n')).toMatch(/external-fixture.*✓ resolves/);

    // 3. `stackfold list` — the composed, "available for init" view.
    const listStdout: string[] = [];
    const listDeps: ListCommandDependencies = { registry: compositeRegistry(), stdout: (l) => listStdout.push(l) };
    await runList(listDeps);
    expect(listStdout.join('\n')).toContain('external-fixture');

    // 4. `stackfold init external-fixture <dir>` — scaffolds a real project
    // using only this one externally registered plugin.
    const openCalls: string[] = [];
    const opener: ProjectOpener = { open: async (p) => { openCalls.push(p); } };
    const initDeps: InitCommandDependencies = {
      registry: compositeRegistry(),
      ports: {
        prompter: { ask: async () => ({}) },
        fileWriter: new NodeFileWriter(),
        processRunner: { run: async () => {} },
      },
      opener,
      cwd: () => projectDir,
      stdout: () => {},
      stderr: () => {},
    };

    const initCode = await runInit('external-fixture', targetDir, initDeps, { open: false });

    expect(initCode).toBe(0);
    const written = await readFile(join(targetDir, 'README.md'), 'utf8');
    expect(written).toBe('# Fixture App\n');
  });

  it('an invalid scaffold.json (unknown action, fails the smoke test) is never registered', async () => {
    const sourcePath = join(projectDir, 'broken-plugin.json');
    await writeFile(
      sourcePath,
      JSON.stringify({
        id: 'broken-fixture',
        description: 'Broken.',
        questions: [],
        steps: [{ action: 'thisActionDoesNotExist', params: {} }],
      }),
      'utf8'
    );

    const registerDeps = pluginDeps();
    const code = await runPluginRegister('broken-plugin.json', { project: true }, registerDeps);

    expect(code).toBe(1);
    expect(registerDeps.stderrLines[0]).toMatch(/thisActionDoesNotExist/);

    const configPath = join(projectDir, '.stackfold-pluginsrc.json');
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});
