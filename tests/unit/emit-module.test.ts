import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENERATED_MODULE_BANNER, realEsbuildEmitter } from '../../src/authoring/emitModule.js';

/** stackfold's own repo root, derived from this file's location (ESM-safe — no bare __dirname). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDER_URL = pathToFileURL(join(REPO_ROOT, 'src/authoring/builder.ts')).href;
const TEMPLATE_LOADER_URL = pathToFileURL(join(REPO_ROOT, 'src/authoring/templateLoader.ts')).href;
const VALIDATION_URL = pathToFileURL(join(REPO_ROOT, 'src/core/validation.ts')).href;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-emit-module-test-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes `bundleText` beside the fixture dir and imports it for real. */
async function importBundle(bundleText: string): Promise<{ default: unknown }> {
  const outPath = join(root, 'scaffold.js');
  await writeFile(outPath, bundleText, 'utf8');
  return (await import(pathToFileURL(outPath).href)) as { default: unknown };
}

describe('realEsbuildEmitter.emit() — real esbuild, no fakes', () => {
  it('bundles a validate closure that survives emission and stays callable after import', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `import { defineScaffold } from '${BUILDER_URL}';
import { toValidate, pluginIdSchema } from '${VALIDATION_URL}';

export default defineScaffold({
  id: 'emit-module-closure-fixture',
  description: 'Closure survival fixture.',
  questions: [{ id: 'pluginId', message: 'Plugin id', type: 'input', validate: toValidate(pluginIdSchema) }],
  steps: [],
});
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    const definition = imported as { questions: Array<{ id: string; validate?: (v: unknown) => true | string }> };

    const validate = definition.questions[0]?.validate;
    expect(typeof validate).toBe('function');
    expect(validate!('My_CLI')).not.toBe(true);
    expect(validate!('my-cli')).toBe(true);
  });

  it('resolves a plain default-export object to an already-resolved default (no function wrapper)', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `export default { id: 'default-export-fixture', description: 'd', questions: [], steps: [] };
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    expect(imported).toEqual({ id: 'default-export-fixture', description: 'd', questions: [], steps: [] });
  });

  it('resolves a named "scaffold" export (no default export at all)', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `export const scaffold = { id: 'named-export-fixture', description: 'd', questions: [], steps: [] };
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    expect(imported).toEqual({ id: 'named-export-fixture', description: 'd', questions: [], steps: [] });
  });

  it('resolves a sync thunk (zero-arg function) default export', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `export default function build() {
  return { id: 'thunk-fixture', description: 'd', questions: [], steps: [] };
}
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    expect(imported).toEqual({ id: 'thunk-fixture', description: 'd', questions: [], steps: [] });
  });

  it('resolves an async thunk default export to an already-resolved (non-Promise) default', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `export default async function build() {
  await Promise.resolve();
  return { id: 'async-thunk-fixture', description: 'd', questions: [], steps: [] };
}
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    expect(imported).not.toBeInstanceOf(Promise);
    expect(imported).toEqual({ id: 'async-thunk-fixture', description: 'd', questions: [], steps: [] });
  });

  it('a sibling .hbs loaded via loadTemplate(import.meta.dirname, ...) resolves against the emitted output\'s own location', async () => {
    await writeFile(join(root, 'greeting.hbs'), '# {{appName}}\n', 'utf8');
    await writeFile(
      join(root, 'scaffold.ts'),
      `import { defineScaffold } from '${BUILDER_URL}';
import { loadTemplate } from '${TEMPLATE_LOADER_URL}';

const content = loadTemplate(import.meta.dirname, 'greeting.hbs');

export default defineScaffold({
  id: 'emit-module-template-fixture',
  description: 'Template fixture.',
  questions: [],
  steps: [],
  mainFile: content,
});
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    const { default: imported } = await importBundle(bundleText);
    expect((imported as { mainFile: string }).mainFile).toBe('# {{appName}}\n');
  });

  it('bundles a relative helper import (the original file can be deleted after bundling, and import() still works)', async () => {
    await writeFile(join(root, 'helper.ts'), `export const HELPER_VALUE = 'from-helper';\n`, 'utf8');
    await writeFile(
      join(root, 'scaffold.ts'),
      `import { HELPER_VALUE } from './helper.js';

export default { id: 'helper-fixture', description: HELPER_VALUE, questions: [], steps: [] };
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    await rm(join(root, 'helper.ts'));

    const { default: imported } = await importBundle(bundleText);
    expect((imported as { description: string }).description).toBe('from-helper');
  });

  it('leaves bare/package imports (e.g. zod) external — not inlined into the bundle', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `import { z } from 'zod';

const schema = z.string();
export default { id: 'zod-fixture', description: 'd', questions: [], steps: [], mainFile: typeof schema };
`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    expect(bundleText).toMatch(/from\s+"zod"/);
    // Not inlined: zod's own real source is large/distinctive; a bundled
    // copy would be many KB bigger than just an import statement.
    expect(bundleText.length).toBeLessThan(2000);
  });

  it('the generated module banner is present as the bundle\'s first line', async () => {
    await writeFile(
      join(root, 'scaffold.ts'),
      `export default { id: 'banner-fixture', description: 'd', questions: [], steps: [] };\n`,
      'utf8'
    );

    const bundleText = await realEsbuildEmitter.emit(join(root, 'scaffold.ts'));
    expect(bundleText.split(/\r?\n/, 1)[0]).toBe(GENERATED_MODULE_BANNER);
  });
});
