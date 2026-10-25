import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileScaffold } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition, { pluginIdSchema } from '../../src/plugins/plugin-builder/scaffold.js';
import type { FileWriter } from '../../src/core/ports.js';
import type { HookPorts, ScaffoldDefinition } from '../../src/core/types.js';

const ANSWERS = {
  pluginId: 'my-cool-plugin',
  displayName: 'My Cool Plugin',
  description: 'Does cool things.',
  author: 'Ada Lovelace',
};

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
    prompter: {
      async ask() {
        return {};
      },
    },
    fileWriter: fakeFileWriter(initialFiles),
    processRunner: {
      async run() {},
    },
  };
}

// Task 042 (D-A): plugin-builder is now a fully ordinary scaffold.ts-authored
// plugin — no factory function, no injected `gitUserName` (Open item 1,
// option (a)). Its own `scaffold.test.ts` (new) owns "does plugin-builder's
// own definition compile" — this file keeps only the identity/question
// assertions that aren't already covered there, plus the two describe
// blocks below (registration round-trip + the new ordering invariant).
describe('plugin-builder — its own ScaffoldDefinition (D-A, Task 042)', () => {
  it('compiles via compileScaffold() without throwing, carrying id/description/help', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());

    expect(plugin.id).toBe('plugin-builder');
    expect(plugin.description).toBeTruthy();
    expect(plugin.help?.name).toBe('Plugin Builder');
  });

  it('declares exactly the 4 questions, unchanged from v1: pluginId, displayName, description, author', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    expect(plugin.questions().map((q) => q.id)).toEqual(['pluginId', 'displayName', 'description', 'author']);
  });

  // Replaces v1's "author default (D3, Open Item)" describe block (dropped
  // entirely — Task 042, Open item 1, option (a)): there is no more dynamic
  // `gitUserName()` injection. The "author" question now carries the same
  // plain, static `default: ''` convention `web-app`/`electron-ts` already
  // use when there is no override.
  it('the "author" question carries a plain, static default (\'\') — no dynamic git-identity lookup', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const authorQuestion = plugin.questions().find((q) => q.id === 'author');
    expect(authorQuestion?.default).toBe('');
  });
});

// Task 042 review follow-up (review_report.md Blocking #1): the real
// `stackfold init plugin-builder` runtime path compiles this plugin from
// whatever `src/cli/index.ts` actually imports — if that were
// `scaffold.json` (JSON cannot carry function values), every `validate`
// closure declared above would be silently dropped and
// `core/orchestrator.ts`'s `resolveAnswers()` would fall through to
// "always valid." These two tests tie directly to `cli/index.ts`'s actual
// wiring (not a separately-constructed fixture) and to the compiled
// object's live behavior, so a future regression back to a JSON-compiled
// runtime path fails loudly here.
describe('plugin-builder — validation stays live against the exact object cli/index.ts registers (review_report.md Blocking #1)', () => {
  it('src/cli/index.ts registers plugin-builder by importing its TS-compiled scaffold.js, never scaffold.json', () => {
    const cliSource = readFileSync(new URL('../../src/cli/index.ts', import.meta.url), 'utf8');
    const pluginBuilderImport = cliSource.match(/await import\('\.\.\/plugins\/plugin-builder\/([^']+)'/);

    expect(pluginBuilderImport?.[1]).toBe('scaffold.js');
  });

  it('every question on the scaffold.js-compiled plugin (the exact object cli/index.ts registers) has a defined, callable validate, and pluginId rejects a non-kebab-case value', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const questions = plugin.questions();

    expect(questions).toHaveLength(4);
    for (const q of questions) {
      expect(typeof q.validate).toBe('function');
    }

    const pluginIdQuestion = questions.find((q) => q.id === 'pluginId');
    const verdict = pluginIdQuestion!.validate!("won't work");

    expect(verdict).not.toBe(true);
    expect(typeof verdict).toBe('string');
  });
});

describe('pluginIdSchema', () => {
  it('enforces kebab-case (lowercase letters/digits/hyphens, starting with a letter)', () => {
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
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
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

// New (Task 042, D-C's edge-case invariant — "El synth real condiciona el
// registro"): the *order* of plugin-builder's postInit hooks — runHookCommand
// first, both patchFile steps after — is the entire mechanism that keeps a
// failed synth from ever leaving src/cli/index.ts patched to import a
// scaffold.json that was never written. No new error-handling code is being
// tested here: `runHooks()` (core/orchestrator.ts) already aborts on the
// first handler that throws (a plain `for` loop awaiting each handler in
// turn — a thrown error stops the loop before any later handler runs), and
// this test exercises exactly that control flow, directly against the
// compiled hook chain.
describe('plugin-builder — postInit hook ordering (D-C): a failed synth never leaves cli/index.ts patched', () => {
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

  it("aborts before either patchFile step runs when runHookCommand's underlying process call throws", async () => {
    const ports = fakePorts({ [CLI_PATH]: MOCK_CLI_INDEX });
    ports.processRunner = {
      async run() {
        throw new Error('scaffold synth failed: malformed scaffold.ts');
      },
    };

    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const handlers = plugin.hooks!.postInit!;

    await expect(
      (async () => {
        for (const handler of handlers) {
          await handler(ports, ANSWERS);
        }
      })()
    ).rejects.toThrow(/scaffold synth failed/);

    // Neither patchFile step ever ran: the file is byte-for-byte unchanged.
    expect(await ports.fileWriter.readFile(CLI_PATH)).toBe(MOCK_CLI_INDEX);
  });
});

// Task 042 review follow-up (review_report.md Blocking #2): SCAFFOLD_TS_TEMPLATE
// interpolates `displayName`/`description` into single-quoted TS string
// literals with Handlebars noEscape:true. An apostrophe in either — ordinary,
// schema-accepted free text ("It's a thing") — previously produced an
// unterminated string literal: invalid TypeScript. `jsEscapeKeys` on that
// writeFile step (src/plugins/plugin-builder/scaffold.ts) now escapes them.
// This is checked by actually parsing the generated output with the
// TypeScript compiler (`ts.transpileModule`, the same convention already
// used in electron-ts-plugin.test.ts/-tier2.test.ts/web-app-spa-plugin-tier3.test.ts
// for "does this generated TS actually parse"), not just a substring match.
describe('plugin-builder — generated scaffold.ts escapes apostrophes in displayName/description (review_report.md Blocking #2)', () => {
  it('produces syntactically valid TS when description/displayName contain an apostrophe', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint({
      ...ANSWERS,
      displayName: "It's a Thing",
      description: "It's a thing that does stuff.",
    });

    const generated = blueprint.files.find((f) => f.path === `${ANSWERS.pluginId}/scaffold.ts`);
    expect(generated).toBeDefined();

    const { diagnostics } = ts.transpileModule(generated!.content.toString(), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: 'scaffold.ts',
    });

    expect(diagnostics ?? []).toEqual([]);
    // Belt-and-suspenders: the literal escaped substring really is there.
    expect(generated!.content.toString()).toContain("description: 'It\\'s a thing that does stuff.'");
    expect(generated!.content.toString()).toContain("help: { name: 'It\\'s a Thing' }");
  });
});
