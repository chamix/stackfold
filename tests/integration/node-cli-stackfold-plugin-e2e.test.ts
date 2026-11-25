/**
 * `node-cli-stackfold`'s declarative `constraints` (`projectName`, `description`,
 * `binName`, `author`) must reject invalid values with a real `stackfold init`
 * (real disk via `NodeFileWriter`, real orchestrator via `runInit`), and write
 * nothing when they do. Same convention as
 * `tests/integration/builtin-validation-runtime.test.ts` and
 * `node-http-api-stackfold-plugin-e2e.test.ts`.
 *
 * The plugin is compiled from the synthesized `scaffold.json`, the exact
 * artifact `src/cli/index.ts` registers. The last block spawns the real CLI
 * entry point (`src/cli/index.ts`, through tsx) and proves the registration
 * itself: `list` and `info` against the real built-in registry.
 */
import { execa } from 'execa';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInfo } from '../../src/cli/commands/info.js';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { runList } from '../../src/cli/commands/list.js';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import nodeCliDefinition from '../../src/plugins/node-cli-stackfold/scaffold.json' with { type: 'json' };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-node-cli-stackfold-e2e-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const evaluator = new JsonLogicExpressionEvaluator();

function compiledPlugin() {
  return compileScaffold(nodeCliDefinition as ScaffoldDefinition, evaluator);
}

function makeDeps(registry: StaticPluginRegistry): InitCommandDependencies & { stderrLines: string[] } {
  const stderrLines: string[] = [];
  return {
    registry,
    ports: {
      prompter: { ask: async () => ({}) },
      fileWriter: new NodeFileWriter(),
      processRunner: { run: async () => {} },
    },
    opener: { open: async () => {} },
    cwd: () => root,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stderrLines,
  };
}

const VALID = { projectName: 'my-cli', description: 'A command-line tool', binName: 'my-cli', author: '' };

function answersWith(override: Partial<Record<keyof typeof VALID, string>>): string[] {
  return Object.entries({ ...VALID, ...override }).map(([key, value]) => `${key}=${value}`);
}

/** Runs a real `init` with `override` applied to otherwise valid answers; resolves the exit code and what it printed/wrote. */
async function initWith(override: Partial<Record<keyof typeof VALID, string>>) {
  const deps = makeDeps(new StaticPluginRegistry([compiledPlugin()]));
  const targetDir = join(root, 'out');
  const code = await runInit('node-cli-stackfold', targetDir, deps, { answer: answersWith(override), open: false });
  return { code, targetDir, stderr: deps.stderrLines.join('\n') };
}

describe('node-cli-stackfold: real init rejects invalid values and writes nothing', () => {
  it.each(['Bad Name', '@a/b', '_x', '', 'UPPER', 'a b', '-x'])('rejects projectName=%j', async (value) => {
    const { code, targetDir, stderr } = await initWith({ projectName: value });
    expect(code).toBe(1);
    expect(stderr).toMatch(/project name/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it.each(['Acme', 'my cli', 'my_cli', '-cli', '', '../x', 'a/b'])('rejects binName=%j', async (value) => {
    const { code, targetDir, stderr } = await initWith({ binName: value });
    expect(code).toBe(1);
    expect(stderr).toMatch(/command name/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('rejects a description over 200 characters', async () => {
    const { code, targetDir, stderr } = await initWith({ description: 'a'.repeat(201) });
    expect(code).toBe(1);
    expect(stderr).toMatch(/description/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('rejects a multi-line description', async () => {
    const { code, targetDir, stderr } = await initWith({ description: 'line one\nline two' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/description/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('rejects a multi-line author', async () => {
    const { code, targetDir, stderr } = await initWith({ author: 'Ada\nLovelace' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/author/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('still accepts valid values and writes the real project (no false-positive rejection)', async () => {
    const { code, targetDir, stderr } = await initWith({});
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const pkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ 'my-cli': 'dist/cli/index.js' });
    await expect(stat(join(targetDir, 'src/cli/index.ts'))).resolves.toBeTruthy();
    await expect(stat(join(targetDir, 'tests/integration/cli.test.ts'))).resolves.toBeTruthy();
  });

  it('writes a bin name that differs from the project name, and special characters survive', async () => {
    const { code, targetDir } = await initWith({
      projectName: 'acme-tools',
      binName: 'acme',
      description: `He said "hi" & <b>it's</b> a \\ test`,
      author: `Ada "Countess" O'Brien <ada@example.com>`,
    });
    expect(code).toBe(0);
    const pkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg['bin']).toEqual({ acme: 'dist/cli/index.js' });
    expect(pkg['description']).toBe(`He said "hi" & <b>it's</b> a \\ test`);
    expect(pkg['author']).toBe(`Ada "Countess" O'Brien <ada@example.com>`);
  });
});

describe('node-cli-stackfold: discoverable through list and info', () => {
  it('"list" shows the plugin', async () => {
    const stdoutLines: string[] = [];
    await runList({ registry: new StaticPluginRegistry([compiledPlugin()]), stdout: (line) => stdoutLines.push(line) });
    const output = stdoutLines.join('\n');
    expect(output).toMatch(/node-cli-stackfold/);
    expect(output).toMatch(/Node CLI/);
  });

  it('"info" shows its 4 questions with their defaults', async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await runInfo('node-cli-stackfold', {
      registry: new StaticPluginRegistry([compiledPlugin()]),
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    });
    expect(code).toBe(0);
    const output = stdoutLines.join('\n');
    expect(output).toMatch(/projectName \(input\).*\[default: my-cli\]/);
    expect(output).toMatch(/description \(input\).*\[default: A command-line tool\]/);
    expect(output).toMatch(/binName \(input\).*\[default: my-cli\]/);
    expect(output).toMatch(/author \(input\)/);
    expect(output.match(/\(input\)/g)).toHaveLength(4);
  });
});

describe('node-cli-stackfold: registered in the real CLI (src/cli/index.ts)', () => {
  it('"stackfold list" and "stackfold info node-cli-stackfold" work against the real built-in registry', async () => {
    const cli = (...args: string[]) =>
      execa(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { cwd: REPO_ROOT, reject: false });

    const list = await cli('list');
    expect(list.exitCode, list.stderr).toBe(0);
    expect(list.stdout).toContain('node-cli-stackfold');

    const info = await cli('info', 'node-cli-stackfold');
    expect(info.exitCode, info.stderr).toBe(0);
    for (const id of ['projectName', 'description', 'binName', 'author']) {
      expect(info.stdout).toContain(id);
    }
  }, 120_000);
});
