import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScaffoldDefinition } from '../../src/core/authoring.js';
import { scaffoldDefinitionSchema, synth } from '../../src/authoring/synth.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-synth-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const VALID_DEFINITION: ScaffoldDefinition = {
  id: 'fixture-plugin',
  description: 'A fixture plugin.',
  questions: [{ id: 'appName', message: 'App name', type: 'input', default: 'my-app' }],
  steps: [
    { action: 'mkdir', params: { path: 'src' } },
    { action: 'writeFile', params: { path: 'README.md', content: '# {{appName}}\n' } },
  ],
};

describe('scaffoldDefinitionSchema', () => {
  it('accepts a well-formed ScaffoldDefinition', () => {
    expect(scaffoldDefinitionSchema.safeParse(VALID_DEFINITION).success).toBe(true);
  });

  it('accepts hooks when present', () => {
    const withHooks: ScaffoldDefinition = {
      ...VALID_DEFINITION,
      hooks: { postInit: [{ action: 'patchFile', params: { path: 'x', anchor: 'y', insert: 'z', position: 'after' } }] },
    };
    expect(scaffoldDefinitionSchema.safeParse(withHooks).success).toBe(true);
  });

  it('rejects a missing/empty id', () => {
    expect(scaffoldDefinitionSchema.safeParse({ ...VALID_DEFINITION, id: '' }).success).toBe(false);
  });

  it('rejects a non-array "steps"', () => {
    expect(scaffoldDefinitionSchema.safeParse({ ...VALID_DEFINITION, steps: 'nope' }).success).toBe(false);
  });

  it('rejects a question with an invalid "type"', () => {
    const bad = { ...VALID_DEFINITION, questions: [{ id: 'a', message: 'm', type: 'weird' }] };
    expect(scaffoldDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a step missing "params"', () => {
    const bad = { ...VALID_DEFINITION, steps: [{ action: 'mkdir' }] };
    expect(scaffoldDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate questions[].id, with no fragments involved (D6, Task 041 amendment)', () => {
    const withDuplicateIds = {
      ...VALID_DEFINITION,
      questions: [
        { id: 'appName', message: 'App name', type: 'input' },
        { id: 'appName', message: 'App name again', type: 'input' },
      ],
    };

    const result = scaffoldDefinitionSchema.safeParse(withDuplicateIds);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('appName'))).toBe(true);
    }
  });
});

describe('synth', () => {
  it('writes a well-formed definition to src/plugins/<id>/scaffold.json under cwd', () => {
    const result = synth(VALID_DEFINITION, { cwd: root });

    const expectedPath = join(root, 'src', 'plugins', 'fixture-plugin', 'scaffold.json');
    expect(result.outputPath).toBe(expectedPath);
  });

  it('the written file is valid, formatted JSON matching the definition exactly', async () => {
    const result = synth(VALID_DEFINITION, { cwd: root });

    const raw = await readFile(result.outputPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(VALID_DEFINITION);
    expect(raw).toContain('\n');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('the written scaffold.json is itself consumable by compileScaffold() directly', async () => {
    const result = synth(VALID_DEFINITION, { cwd: root });
    const raw = await readFile(result.outputPath, 'utf8');
    const parsed = JSON.parse(raw) as ScaffoldDefinition;

    const { compileScaffold } = await import('../../src/core/authoring.js');
    const { JsonLogicExpressionEvaluator } = await import('../../src/infra/expressionEvaluator.js');
    expect(() => compileScaffold(parsed, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  it('throws on structural validation failure and never writes any file', async () => {
    const invalid = { ...VALID_DEFINITION, steps: 'not-an-array' } as unknown as ScaffoldDefinition;

    expect(() => synth(invalid, { cwd: root })).toThrow();

    const outputDir = join(root, 'src', 'plugins', 'fixture-plugin');
    await expect(stat(outputDir)).rejects.toThrow();
  });

  it('throws when compileScaffold() smoke test fails (unknown action) and never writes any file', async () => {
    const invalid: ScaffoldDefinition = {
      ...VALID_DEFINITION,
      steps: [{ action: 'thisActionDoesNotExist', params: {} }],
    };

    expect(() => synth(invalid, { cwd: root })).toThrow(/thisActionDoesNotExist|smoke test/);

    const outputDir = join(root, 'src', 'plugins', 'fixture-plugin');
    await expect(stat(outputDir)).rejects.toThrow();
  });

  it('never overwrites/corrupts a pre-existing scaffold.json when a later synth() call fails', async () => {
    synth(VALID_DEFINITION, { cwd: root });
    const outputPath = join(root, 'src', 'plugins', 'fixture-plugin', 'scaffold.json');
    const before = await readFile(outputPath, 'utf8');

    const invalid: ScaffoldDefinition = { ...VALID_DEFINITION, steps: [{ action: 'nope', params: {} }] };
    expect(() => synth(invalid, { cwd: root })).toThrow();

    const after = await readFile(outputPath, 'utf8');
    expect(after).toBe(before);
  });

  it('leaves no stray temp file behind after a successful write', async () => {
    const result = synth(VALID_DEFINITION, { cwd: root });
    const dir = join(root, 'src', 'plugins', 'fixture-plugin');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries).toEqual(['scaffold.json']);
    expect(result.outputPath.endsWith('scaffold.json')).toBe(true);
  });

  it('creates the src/plugins/<id>/ directory tree when it does not already exist', async () => {
    await synth(VALID_DEFINITION, { cwd: root });
    const dirStat = await stat(join(root, 'src', 'plugins', 'fixture-plugin'));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('defaults cwd to process.cwd() when not supplied', async () => {
    // Temporarily chdir into the per-test tmpdir (created by beforeEach,
    // removed by afterEach) so the real process.cwd() default can be
    // exercised for real, without ever risking a write into the actual
    // repo tree. Restored in `finally` even if synth() itself throws.
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const result = synth(VALID_DEFINITION, {});

      const expectedPath = join(root, 'src', 'plugins', 'fixture-plugin', 'scaffold.json');
      expect(result.outputPath).toBe(expectedPath);

      const raw = await readFile(result.outputPath, 'utf8');
      expect(JSON.parse(raw)).toEqual(VALID_DEFINITION);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
