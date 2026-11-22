/**
 * FIX-005 — per-plugin, observable symptoms of `constraints.trim` now
 * normalizing the *stored* answer (`core/constraints.ts`'s
 * `normalizeAnswer()`, applied by `core/orchestrator.ts`'s
 * `resolveAnswers()`), rather than only the value checks run against.
 * Each case here runs the real `runPlugin()` orchestrator against an
 * in-memory `FileWriter` — same minimal-fake-port convention as
 * `tests/unit/electron-stackfold-plugin.test.ts` (a port is an
 * appropriate fake here; the behavior under test is `core/orchestrator.ts`'s
 * real `resolveAnswers()`/`normalizeAnswer()` and each plugin's real
 * Handlebars templates, never this adapter) — never
 * `plugin.buildBlueprint()` called directly, since that would skip
 * `resolveAnswers()` entirely and prove nothing about this fix.
 *
 * Registered in `test:unit:plugins` and excluded from `test:unit`
 * (`package.json`), the same convention every sibling plugin-level test
 * file in this repo already follows.
 */
import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { runPlugin } from '../../src/core/orchestrator.js';
import type { FileWriter, ProcessRunner, Prompter } from '../../src/core/ports.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import webAppStackfoldDefinition from '../../src/plugins/web-app-stackfold/scaffold.js';
import pluginScaffoldDefinition from '../../src/plugins/plugin-scaffold/scaffold.js';

/**
 * Minimal in-memory `FileWriter` — a port, not a third-party library or the
 * OS (see this file's header comment). Mirrors
 * `electron-stackfold-plugin.test.ts`'s own fake exactly.
 */
class InMemoryFileWriter implements FileWriter {
  readonly files = new Map<string, string>();

  async ensureEmptyDir(): Promise<void> {}

  async writeFile(absolutePath: string, content: string | Buffer): Promise<void> {
    this.files.set(absolutePath, typeof content === 'string' ? content : content.toString('utf8'));
  }

  async readFile(absolutePath: string): Promise<string | undefined> {
    return this.files.get(absolutePath);
  }

  async overwriteFile(absolutePath: string, content: string): Promise<void> {
    this.files.set(absolutePath, content);
  }
}

const NOOP_PROCESS_RUNNER: ProcessRunner = { run: async () => {} };

function stubPrompter(answers: Answers): Prompter {
  return { ask: async () => answers };
}

async function run(plugin: StackfoldPlugin, answers: Answers): Promise<Map<string, string>> {
  const writer = new InMemoryFileWriter();
  await runPlugin(plugin, 'TARGET', {
    prompter: stubPrompter(answers),
    fileWriter: writer,
    processRunner: NOOP_PROCESS_RUNNER,
  });
  return writer.files;
}

/** Strips the common `TARGET\` (or `TARGET/`) prefix the in-memory writer's absolute paths carry. */
function relativeTree(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [absolutePath, content] of files) {
    const rel = absolutePath.replace(/^TARGET[\\/]/, '').split('\\').join('/');
    out.set(rel, content);
  }
  return out;
}

const evaluator = new JsonLogicExpressionEvaluator();
const webAppStackfoldPlugin: StackfoldPlugin = compileScaffold(
  webAppStackfoldDefinition as ScaffoldDefinition,
  evaluator
);
const pluginScaffoldPlugin: StackfoldPlugin = compileScaffold(
  pluginScaffoldDefinition as ScaffoldDefinition,
  evaluator
);

describe('web-app-stackfold — a padded appName/description is stored trimmed (FIX-005)', () => {
  const BASE: Answers = {
    appName: '  spaced  name  ',
    description: '  a padded description  ',
    author: 'Ada Lovelace',
    appType: 'standalone-html',
    includeStackfoldIntro: false,
  };

  it('<title> and the meta description in index.html carry the trimmed appName/description', async () => {
    const files = relativeTree(await run(webAppStackfoldPlugin, BASE));
    const html = files.get('index.html') ?? '';
    expect(html).toContain('<title>spaced  name</title>');
    expect(html).toContain('content="a padded description"');
    expect(html).not.toContain('  spaced  name  ');
    expect(html).not.toContain('  a padded description  ');
  });

  it('package.json\'s description field is trimmed (name is already slugged and unaffected) — SPA flavor, which has a package.json', async () => {
    const files = relativeTree(await run(webAppStackfoldPlugin, { ...BASE, appType: 'spa-vanilla' }));
    const pkg = JSON.parse(files.get('package.json') ?? '{}') as { name?: string; description?: string };
    expect(pkg.description).toBe('a padded description');
  });
});

describe('web-app-stackfold — a whitespace-only author no longer produces a blank-holder LICENSE (FIX-005)', () => {
  const BASE: Answers = {
    appName: 'My App',
    description: 'A description',
    author: '   ',
    appType: 'spa-vanilla',
    includeStackfoldIntro: false,
  };

  it('author="   " is stored as "" after trimming, so the author-gated LICENSE step is skipped entirely', async () => {
    const files = relativeTree(await run(webAppStackfoldPlugin, BASE));
    expect(files.has('LICENSE')).toBe(false);
  });

  it('a real (non-blank) author still produces a LICENSE with that author as its holder', async () => {
    const files = relativeTree(await run(webAppStackfoldPlugin, { ...BASE, author: 'Ada Lovelace' }));
    expect(files.get('LICENSE')).toContain('Ada Lovelace');
  });
});

describe('plugin-scaffold — a padded pluginId is stored trimmed (FIX-005)', () => {
  const BASE: Answers = {
    pluginId: '  my-plugin  ',
    displayName: 'My Plugin',
    description: 'A plugin',
    author: 'Ada Lovelace',
  };

  it('the generated scaffold.ts declares the trimmed id, not the padded one', async () => {
    const files = relativeTree(await run(pluginScaffoldPlugin, BASE));
    const scaffoldTs = files.get('scaffold.ts') ?? '';
    expect(scaffoldTs).toContain("id: 'my-plugin'");
    expect(scaffoldTs).not.toContain("id: '  my-plugin  '");
  });
});
