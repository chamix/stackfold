/**
 * SYNTH-002 acceptance criterion 7 / R1
 * (`.agents/specs/synth-002-declarative-validation.md`): after migrating
 * `plugin-builder`/`plugin-scaffold`/`web-app-stackfold`'s 4 (families of)
 * questions from `validate: toValidate(...)` closures to declarative
 * `constraints`, a real `stackfold init` must still reject the exact same
 * invalid values it rejected before — the derived `validate` really is
 * active at runtime, not merely present on the in-memory object.
 *
 * Real disk, real orchestrator, real `NodeFileWriter` (same convention as
 * `tests/integration/scaffold-synth-cli.test.ts`'s own "validate stays
 * active" case) — a fake `FileWriter` could mask a regression where the
 * question's `validate` never actually runs before files are written.
 * Imports each plugin's real `scaffold.ts` directly (the same module
 * `cli/index.ts` itself compiles — see `src/plugins/plugin-builder/
 * scaffold.ts`'s own header comment on why `cli/index.ts` loads
 * `scaffold.js`, never `scaffold.json`, for these 3), so this exercises
 * the exact object the real CLI registers.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import pluginBuilderDefinition from '../../src/plugins/plugin-builder/scaffold.js';
import pluginScaffoldDefinition from '../../src/plugins/plugin-scaffold/scaffold.js';
import webAppStackfoldDefinition from '../../src/plugins/web-app-stackfold/scaffold.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-builtin-validation-runtime-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const evaluator = new JsonLogicExpressionEvaluator();

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

describe('built-in plugins — derived validate (constraints) stays active against the real compiled object (SYNTH-002 R1/criterion 7)', () => {
  it('plugin-builder: rejects a non-kebab-case pluginId, writes nothing', async () => {
    const registry = new StaticPluginRegistry([
      compileScaffold(pluginBuilderDefinition as ScaffoldDefinition, evaluator),
    ]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'plugin-builder-out');

    const code = await runInit(
      'plugin-builder',
      targetDir,
      deps,
      { answer: ['pluginId=NotKebabCase', 'displayName=X', 'description=Y', 'author=Z'], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/kebab-case/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('plugin-scaffold: rejects a non-kebab-case pluginId, writes nothing', async () => {
    const registry = new StaticPluginRegistry([
      compileScaffold(pluginScaffoldDefinition as ScaffoldDefinition, evaluator),
    ]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'my-cool-plugin');

    const code = await runInit(
      'plugin-scaffold',
      targetDir,
      deps,
      { answer: ['pluginId=NotKebabCase', 'displayName=X', 'description=Y', 'author=Z'], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/kebab-case/i);
    await expect(stat(join(targetDir, 'scaffold.ts'))).rejects.toThrow();
  });

  it('web-app-stackfold: rejects an empty appName, writes nothing', async () => {
    const registry = new StaticPluginRegistry([
      compileScaffold(webAppStackfoldDefinition as ScaffoldDefinition, evaluator),
    ]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'web-app-out');

    const code = await runInit(
      'web-app-stackfold',
      targetDir,
      deps,
      { answer: ['appName=', 'description=A demo', 'author=', 'appType=spa-react'], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/app name/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('web-app-stackfold: still accepts a valid appName and writes real files (no false-positive rejection)', async () => {
    const registry = new StaticPluginRegistry([
      compileScaffold(webAppStackfoldDefinition as ScaffoldDefinition, evaluator),
    ]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'web-app-out-valid');

    const code = await runInit(
      'web-app-stackfold',
      targetDir,
      deps,
      {
        answer: ['appName=My Cool App', 'description=A demo', 'author=Ada Lovelace', 'appType=standalone-html'],
        open: false,
      }
    );

    expect(code).toBe(0);
    expect(deps.stderrLines).toEqual([]);
    await expect(stat(join(targetDir, 'index.html'))).resolves.toBeTruthy();
  });
});
