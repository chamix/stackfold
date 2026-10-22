import { describe, expect, it } from 'vitest';
import { compileScaffold } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { createPluginBuilderDefinition, pluginIdSchema } from '../../src/plugins/plugin-builder/index.js';
import type { FileWriter } from '../../src/core/ports.js';
import type { HookPorts, ScaffoldDefinition } from '../../src/core/types.js';

const ANSWERS = {
  pluginId: 'my-cool-plugin',
  displayName: 'My Cool Plugin',
  description: 'Does cool things.',
  author: 'Ada Lovelace',
};

/**
 * `gitUserName` is required (review follow-up, Should-fix #2 — `cli/index.ts`
 * is the only place that wires the real, `infra/fs.ts`-backed probe). Every
 * test below that doesn't itself care what the "author" question's default
 * resolves to builds its own definition through this fixed fake, mirroring
 * the "author default" describe block's own existing injection style.
 */
function buildDefinition(): ScaffoldDefinition {
  return createPluginBuilderDefinition({ gitUserName: () => 'Ada Lovelace' });
}

/** In-memory `FileWriter` fake, Map-backed — same style as the orchestrator/authoring test fakes. */
function fakeFileWriter(initialFiles: Record<string, string> = {}): FileWriter {
  const store = new Map(Object.entries(initialFiles));
  return {
    async ensureEmptyDir() {},
    async writeFile(path, content) {
      store.set(path, content.toString());
    },
    async readFile(path) {
      return store.get(path);
    },
    async overwriteFile(path, content) {
      store.set(path, content);
    },
  };
}

function fakePorts(initialFiles: Record<string, string> = {}): HookPorts & { fileWriter: FileWriter } {
  return {
    prompter: { async ask() { return {}; } },
    fileWriter: fakeFileWriter(initialFiles),
    processRunner: { async run() {} },
  };
}

describe('plugin-builder — its own ScaffoldDefinition validates/compiles (D1)', () => {
  it('compiles via compileScaffold() without throwing, carrying id/description/help', () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());

    expect(plugin.id).toBe('plugin-builder');
    expect(plugin.description).toBeTruthy();
    expect(plugin.help?.name).toBe('Plugin Builder');
  });

  it('declares exactly the 4 questions from D3: pluginId, displayName, description, author', () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    expect(plugin.questions().map((q) => q.id)).toEqual(['pluginId', 'displayName', 'description', 'author']);
  });

  it('buildBlueprint() produces the generated plugin\'s manifest + test file, under <pluginId>/', () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint(ANSWERS);

    expect(blueprint.files.map((f) => f.path)).toEqual(['my-cool-plugin/scaffold.json', 'my-cool-plugin/scaffold.test.ts']);
  });

  it("the generated manifest's content is itself a valid ScaffoldDefinition that compileScaffold() accepts", () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint(ANSWERS);
    const manifestFile = blueprint.files.find((f) => f.path === 'my-cool-plugin/scaffold.json');

    const parsed = JSON.parse(manifestFile!.content.toString());
    expect(parsed).toEqual({
      id: 'my-cool-plugin',
      description: 'Does cool things.',
      help: { name: 'My Cool Plugin' },
      questions: [],
      steps: [
        {
          action: 'writeFile',
          params: { path: 'README.md', content: '# My Cool Plugin\n\nDoes cool things.\n' },
        },
      ],
    });

    expect(() => compileScaffold(parsed, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  // Blocking item 1 (review_report.md): `displayName`/`description` only
  // pass `descriptionSchema` structural validation — a literal `"` is
  // ordinary, schema-accepted free text, and previously produced
  // syntactically invalid JSON in the generated manifest.
  it('JSON-escapes displayName/description so a literal `"` still produces valid JSON that round-trips the original values (Blocking item 1)', () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    const answersWithQuotes = {
      ...ANSWERS,
      displayName: 'My "Cool" Plugin',
      description: 'Does "cool" things.',
    };

    const blueprint = plugin.buildBlueprint(answersWithQuotes);
    const manifestFile = blueprint.files.find((f) => f.path === 'my-cool-plugin/scaffold.json');

    // The invariant itself: this must not throw.
    const parsed = JSON.parse(manifestFile!.content.toString());

    // Round-trips the *original*, unescaped values — not a double-escaped
    // string (`JSON.parse` undoes exactly the one escaping layer applied).
    expect(parsed.description).toBe('Does "cool" things.');
    expect(parsed.help).toEqual({ name: 'My "Cool" Plugin' });
    expect(parsed.steps[0].params.content).toBe('# My "Cool" Plugin\n\nDoes "cool" things.\n');

    // The spec's own invariant: the generated manifest must itself be a
    // valid ScaffoldDefinition that compileScaffold() accepts.
    expect(() => compileScaffold(parsed, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  it("the generated test file imports compileScaffold()'s evaluator and the manifest it sits beside", () => {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint(ANSWERS);
    const testFile = blueprint.files.find((f) => f.path === 'my-cool-plugin/scaffold.test.ts');

    expect(testFile!.content.toString()).toContain("import definition from './scaffold.json' with { type: 'json' };");
    expect(testFile!.content.toString()).toContain('my-cool-plugin');
  });
});

describe('plugin-builder — author default (D3, Open Item)', () => {
  it('uses the injected gitUserName() result as the "author" question default', () => {
    const definition = createPluginBuilderDefinition({ gitUserName: () => 'Grace Hopper' });
    const plugin = compileScaffold(definition, new JsonLogicExpressionEvaluator());

    const authorQuestion = plugin.questions().find((q) => q.id === 'author');
    expect(authorQuestion?.default).toBe('Grace Hopper');
  });

  it('falls back to "" when gitUserName() throws (no local git identity available) rather than propagating', () => {
    const definition = createPluginBuilderDefinition({
      gitUserName: () => {
        throw new Error('git: command not found');
      },
    });

    const authorQuestion = definition.questions.find((q) => q.id === 'author');
    expect(authorQuestion?.default).toBe('');
  });

  it('pluginIdSchema enforces kebab-case (lowercase letters/digits/hyphens, starting with a letter)', () => {
    expect(pluginIdSchema.safeParse('my-cool-plugin').success).toBe(true);
    expect(pluginIdSchema.safeParse('MyCoolPlugin').success).toBe(false);
    expect(pluginIdSchema.safeParse('-leading-hyphen').success).toBe(false);
    expect(pluginIdSchema.safeParse('').success).toBe(false);
  });
});

describe('plugin-builder — registration round-trip (D2/D6, patchFile against src/cli/index.ts)', () => {
  const CLI_PATH = 'src/cli/index.ts';

  const MOCK_CLI_INDEX = `import { StaticPluginRegistry } from '../infra/pluginLoader.js';
// stackfold-plugin-imports:start
import { electronTsPlugin } from '../plugins/electron-ts/index.js';
// stackfold-plugin-imports:end

const registry = new StaticPluginRegistry([
  electronTsPlugin,
  // stackfold-plugin-registry:end
]);
`;

  async function runPostInitHooks(ports: HookPorts, answers: Record<string, string>): Promise<void> {
    const plugin = compileScaffold(buildDefinition(), new JsonLogicExpressionEvaluator());
    for (const handler of plugin.hooks!.postInit!) {
      await handler(ports, answers);
    }
  }

  it('inserts the shared import line (before the imports anchor) and a pluginId-specific registry entry (before the registry anchor)', async () => {
    const ports = fakePorts({ [CLI_PATH]: MOCK_CLI_INDEX });

    await runPostInitHooks(ports, ANSWERS);

    const patched = await ports.fileWriter.readFile(CLI_PATH);
    expect(patched).toBe(
      `import { StaticPluginRegistry } from '../infra/pluginLoader.js';
// stackfold-plugin-imports:start
import { electronTsPlugin } from '../plugins/electron-ts/index.js';
import { compileScaffold } from '../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../infra/expressionEvaluator.js';
// stackfold-plugin-imports:end

const registry = new StaticPluginRegistry([
  electronTsPlugin,
  compileScaffold((await import('../plugins/my-cool-plugin/scaffold.json', { with: { type: 'json' } })).default, expressionEvaluator),
  // stackfold-plugin-registry:end
]);
`
    );
  });

  it('is idempotent: re-running the registration for the same pluginId does not duplicate either insertion', async () => {
    const ports = fakePorts({ [CLI_PATH]: MOCK_CLI_INDEX });

    await runPostInitHooks(ports, ANSWERS);
    const afterFirstRun = await ports.fileWriter.readFile(CLI_PATH);

    await runPostInitHooks(ports, ANSWERS);
    const afterSecondRun = await ports.fileWriter.readFile(CLI_PATH);

    expect(afterSecondRun).toBe(afterFirstRun);
  });

  it('registering two different pluginIds produces two distinct registry entries, each present exactly once', async () => {
    const ports = fakePorts({ [CLI_PATH]: MOCK_CLI_INDEX });

    await runPostInitHooks(ports, ANSWERS);
    await runPostInitHooks(ports, { ...ANSWERS, pluginId: 'another-plugin' });

    const patched = await ports.fileWriter.readFile(CLI_PATH);
    expect(patched).toContain("'../plugins/my-cool-plugin/scaffold.json'");
    expect(patched).toContain("'../plugins/another-plugin/scaffold.json'");
    expect(patched?.match(/compileScaffold\(\(await import/g)).toHaveLength(2);
  });

  it('throws loudly (never guessing an insertion point) when src/cli/index.ts is missing the registry anchor', async () => {
    const noAnchor = MOCK_CLI_INDEX.replace('  // stackfold-plugin-registry:end\n', '');
    const ports = fakePorts({ [CLI_PATH]: noAnchor });

    await expect(runPostInitHooks(ports, ANSWERS)).rejects.toThrow(/anchor/i);
  });

  it('throws loudly when src/cli/index.ts does not exist', async () => {
    const ports = fakePorts(); // no files seeded

    await expect(runPostInitHooks(ports, ANSWERS)).rejects.toThrow(/does not exist/i);
  });
});
