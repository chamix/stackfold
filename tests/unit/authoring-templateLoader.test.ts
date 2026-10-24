import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTemplate } from '../../src/authoring/templateLoader.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-templateLoader-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadTemplate', () => {
  it('reads a real .hbs file from disk, relative to baseDir, and returns its raw content untouched', async () => {
    const content = '# {{appName}}\n\n{{#if includeFoo}}Has foo.{{/if}}\n';
    await writeFile(join(root, 'README.md.hbs'), content, 'utf8');

    expect(loadTemplate(root, 'README.md.hbs')).toBe(content);
  });

  it('resolves a nested relative path against baseDir', async () => {
    const nestedDir = join(root, 'templates');
    await import('node:fs/promises').then((fs) => fs.mkdir(nestedDir));
    const content = 'nested content\n';
    await writeFile(join(nestedDir, 'file.hbs'), content, 'utf8');

    expect(loadTemplate(root, 'templates/file.hbs')).toBe(content);
  });

  it('throws a clear, specific error naming the resolved path when the file does not exist', () => {
    expect(() => loadTemplate(root, 'missing.hbs')).toThrow(/missing\.hbs/);
  });

  it('never Handlebars-compiles or otherwise transforms the content', async () => {
    const content = '{{#if x}}{{y}}{{/if}} literal braces stay literal';
    await writeFile(join(root, 'raw.hbs'), content, 'utf8');

    expect(loadTemplate(root, 'raw.hbs')).toBe(content);
  });
});
