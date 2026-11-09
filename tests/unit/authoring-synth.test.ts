import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScaffoldDefinition } from '../../src/core/authoring.js';
import { scaffoldDefinitionSchema, synth, synthWithModule } from '../../src/authoring/synth.js';
import { GENERATED_MODULE_BANNER, type ScaffoldModuleEmitter } from '../../src/authoring/emitModule.js';

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
  // ARCH-003 Decision 1 regression guard: `plugin-builder`'s own invocation
  // (`scaffold synth src/plugins/<pluginId>`) resolves `outDir` to exactly
  // `src/plugins/<pluginId>`, so passing that same nested path as `outDir`
  // here must still produce the byte-identical final path the old,
  // hardcoded `resolve(cwd, 'src', 'plugins', <id>, 'scaffold.json')`
  // convention always did.
  const pluginOutDir = () => join(root, 'src', 'plugins', 'fixture-plugin');

  it('writes a well-formed definition to scaffold.json inside outDir', () => {
    const result = synth(VALID_DEFINITION, { outDir: pluginOutDir() });

    const expectedPath = join(pluginOutDir(), 'scaffold.json');
    expect(result.outputPath).toBe(expectedPath);
  });

  it('the written file is valid, formatted JSON matching the definition exactly', async () => {
    const result = synth(VALID_DEFINITION, { outDir: pluginOutDir() });

    const raw = await readFile(result.outputPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(VALID_DEFINITION);
    expect(raw).toContain('\n');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('the written scaffold.json is itself consumable by compileScaffold() directly', async () => {
    const result = synth(VALID_DEFINITION, { outDir: pluginOutDir() });
    const raw = await readFile(result.outputPath, 'utf8');
    const parsed = JSON.parse(raw) as ScaffoldDefinition;

    const { compileScaffold } = await import('../../src/core/authoring.js');
    const { JsonLogicExpressionEvaluator } = await import('../../src/infra/expressionEvaluator.js');
    expect(() => compileScaffold(parsed, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  it('throws on structural validation failure and never writes any file', async () => {
    const invalid = { ...VALID_DEFINITION, steps: 'not-an-array' } as unknown as ScaffoldDefinition;

    expect(() => synth(invalid, { outDir: pluginOutDir() })).toThrow();

    await expect(stat(pluginOutDir())).rejects.toThrow();
  });

  it('throws when compileScaffold() smoke test fails (unknown action) and never writes any file', async () => {
    const invalid: ScaffoldDefinition = {
      ...VALID_DEFINITION,
      steps: [{ action: 'thisActionDoesNotExist', params: {} }],
    };

    expect(() => synth(invalid, { outDir: pluginOutDir() })).toThrow(/thisActionDoesNotExist|smoke test/);

    await expect(stat(pluginOutDir())).rejects.toThrow();
  });

  it('never overwrites/corrupts a pre-existing scaffold.json when a later synth() call fails', async () => {
    synth(VALID_DEFINITION, { outDir: pluginOutDir() });
    const outputPath = join(pluginOutDir(), 'scaffold.json');
    const before = await readFile(outputPath, 'utf8');

    const invalid: ScaffoldDefinition = { ...VALID_DEFINITION, steps: [{ action: 'nope', params: {} }] };
    expect(() => synth(invalid, { outDir: pluginOutDir() })).toThrow();

    const after = await readFile(outputPath, 'utf8');
    expect(after).toBe(before);
  });

  it('leaves no stray temp file behind after a successful write', async () => {
    const result = synth(VALID_DEFINITION, { outDir: pluginOutDir() });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(pluginOutDir());
    expect(entries).toEqual(['scaffold.json']);
    expect(result.outputPath.endsWith('scaffold.json')).toBe(true);
  });

  it('creates the outDir directory tree when it does not already exist', async () => {
    await synth(VALID_DEFINITION, { outDir: pluginOutDir() });
    const dirStat = await stat(pluginOutDir());
    expect(dirStat.isDirectory()).toBe(true);
  });

  it('defaults outDir to process.cwd() when not supplied', async () => {
    // Temporarily chdir into the per-test tmpdir (created by beforeEach,
    // removed by afterEach) so the real process.cwd() default can be
    // exercised for real, without ever risking a write into the actual
    // repo tree. Restored in `finally` even if synth() itself throws.
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const result = synth(VALID_DEFINITION, {});

      const expectedPath = join(root, 'scaffold.json');
      expect(result.outputPath).toBe(expectedPath);

      const raw = await readFile(result.outputPath, 'utf8');
      expect(JSON.parse(raw)).toEqual(VALID_DEFINITION);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ARCH-003 Decision 1 — the actual bug fix: an external author's
  // `outDir` is never required to look like `src/plugins/<id>` at all.
  it('writes beside an arbitrary outDir that is NOT src/plugins/<id> (external-author case)', async () => {
    const externalOutDir = join(root, 'my-plugin');
    const result = synth(VALID_DEFINITION, { outDir: externalOutDir });

    const expectedPath = join(externalOutDir, 'scaffold.json');
    expect(result.outputPath).toBe(expectedPath);

    const raw = await readFile(expectedPath, 'utf8');
    expect(JSON.parse(raw)).toEqual(VALID_DEFINITION);

    // Confirms this really didn't fall back to the old src/plugins/<id> convention.
    await expect(stat(join(root, 'src'))).rejects.toThrow();
  });
});

// SYNTH-001 / SK-ADR-009 — synthWithModule(): the full orchestration (D1-D8).
describe('synthWithModule', () => {
  const pluginOutDir = () => join(root, 'plugin');

  const DEFINITION_WITH_VALIDATE: ScaffoldDefinition = {
    id: 'closure-fixture',
    description: 'Closure fixture.',
    questions: [{ id: 'name', message: 'Name', type: 'input', validate: () => true }],
    steps: [{ action: 'mkdir', params: { path: 'src' } }],
  };

  /** Real, hand-written ESM text — never a mock of `esbuild` itself (per `emitModule.ts`'s own header comment). */
  const matchingFakeEmitter: ScaffoldModuleEmitter = {
    async emit() {
      return `${GENERATED_MODULE_BANNER}
export default {
  id: 'closure-fixture',
  description: 'Closure fixture.',
  questions: [{ id: 'name', message: 'Name', type: 'input', validate: (value) => true }],
  steps: [{ action: 'mkdir', params: { path: 'src' } }],
};
`;
    },
  };

  const divergingFakeEmitter: ScaffoldModuleEmitter = {
    async emit() {
      return `${GENERATED_MODULE_BANNER}
export default {
  id: 'closure-fixture-WRONG-ID',
  description: 'Closure fixture.',
  questions: [{ id: 'name', message: 'Name', type: 'input', validate: (value) => true }],
  steps: [{ action: 'mkdir', params: { path: 'src' } }],
};
`;
    },
  };

  it('no closures: writes only scaffold.json, no scaffold.js, no $synth key', async () => {
    const result = await synthWithModule(VALID_DEFINITION, { outDir: pluginOutDir() });

    expect(result.droppedClosures).toEqual([]);
    expect(result.modulePath).toBeUndefined();
    await expect(stat(join(pluginOutDir(), 'scaffold.js'))).rejects.toThrow();

    const raw = await readFile(result.outputPath, 'utf8');
    expect(JSON.parse(raw)).not.toHaveProperty('$synth');
  });

  it('closures + emitJs (default): writes the verified pair, with a $synth marker naming the module', async () => {
    const result = await synthWithModule(DEFINITION_WITH_VALIDATE, {
      outDir: pluginOutDir(),
      scaffoldTsPath: join(pluginOutDir(), 'scaffold.ts'),
      emitter: matchingFakeEmitter,
    });

    expect(result.droppedClosures).toEqual(['questions.name.validate']);
    expect(result.modulePath).toBe(join(pluginOutDir(), 'scaffold.js'));

    const jsonRaw = JSON.parse(await readFile(result.outputPath, 'utf8'));
    expect(jsonRaw.$synth).toEqual({ droppedClosures: ['questions.name.validate'], module: 'scaffold.js' });
    expect(jsonRaw.questions[0]).not.toHaveProperty('validate');

    const moduleRaw = await readFile(result.modulePath!, 'utf8');
    expect(moduleRaw.split(/\r?\n/, 1)[0]).toBe(GENERATED_MODULE_BANNER);
  });

  it('parity mismatch (diverging fake emitter): throws, and writes NEITHER file', async () => {
    await expect(
      synthWithModule(DEFINITION_WITH_VALIDATE, {
        outDir: pluginOutDir(),
        scaffoldTsPath: join(pluginOutDir(), 'scaffold.ts'),
        emitter: divergingFakeEmitter,
      })
    ).rejects.toThrow(/parity/i);

    await expect(stat(join(pluginOutDir(), 'scaffold.json'))).rejects.toThrow();
    await expect(stat(join(pluginOutDir(), 'scaffold.js'))).rejects.toThrow();
    // verifyModule() does create outDir itself (mkdirSync, same as the
    // existing JSON-only writer always has) before staging its temp .mjs —
    // the real invariant is "no leftover temp file", not "the directory
    // itself never gets created".
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(pluginOutDir())).resolves.toEqual([]);
  });

  it('a stale scaffold.js (carrying the generated banner) is removed when this run has no closures', async () => {
    await mkdir(pluginOutDir(), { recursive: true });
    await writeFile(join(pluginOutDir(), 'scaffold.js'), `${GENERATED_MODULE_BANNER}\nexport default {};\n`, 'utf8');

    await synthWithModule(VALID_DEFINITION, { outDir: pluginOutDir() });

    await expect(stat(join(pluginOutDir(), 'scaffold.js'))).rejects.toThrow();
  });

  it('a foreign scaffold.js (no generated banner) is left untouched, with a warning, when this run has no closures', async () => {
    await mkdir(pluginOutDir(), { recursive: true });
    const foreignContent = '// hand-written, not from synth\nexport default {};\n';
    await writeFile(join(pluginOutDir(), 'scaffold.js'), foreignContent, 'utf8');

    const warnings: string[] = [];
    await synthWithModule(VALID_DEFINITION, { outDir: pluginOutDir(), stderr: (l) => warnings.push(l) });

    const after = await readFile(join(pluginOutDir(), 'scaffold.js'), 'utf8');
    expect(after).toBe(foreignContent);
    expect(warnings.some((l) => l.includes('scaffold.js'))).toBe(true);
  });

  it('closures + emitJs with a foreign scaffold.js (no generated banner): throws before writing or emitting anything, and leaves the foreign file untouched', async () => {
    await mkdir(pluginOutDir(), { recursive: true });
    const foreignContent = '// hand-written workaround, not from synth\nexport default {};\n';
    await writeFile(join(pluginOutDir(), 'scaffold.js'), foreignContent, 'utf8');

    let emitterCalled = false;
    const countingEmitter: ScaffoldModuleEmitter = {
      async emit(path) {
        emitterCalled = true;
        return matchingFakeEmitter.emit(path);
      },
    };

    const failure = synthWithModule(DEFINITION_WITH_VALIDATE, {
      outDir: pluginOutDir(),
      scaffoldTsPath: join(pluginOutDir(), 'scaffold.ts'),
      emitter: countingEmitter,
    });
    await expect(failure).rejects.toThrow(/not generated by synth/);
    await expect(failure).rejects.toThrow(/--no-emit-js/);

    expect(emitterCalled).toBe(false);
    expect(await readFile(join(pluginOutDir(), 'scaffold.js'), 'utf8')).toBe(foreignContent);
    // Nothing else was written: no scaffold.json, no staged/temp files.
    expect(await readdir(pluginOutDir())).toEqual(['scaffold.js']);
  });

  it('closures + emitJs with a scaffold.js that synth itself generated earlier (carries the banner): regenerates it normally', async () => {
    await mkdir(pluginOutDir(), { recursive: true });
    await writeFile(join(pluginOutDir(), 'scaffold.js'), `${GENERATED_MODULE_BANNER}\nexport default {};\n`, 'utf8');

    const result = await synthWithModule(DEFINITION_WITH_VALIDATE, {
      outDir: pluginOutDir(),
      scaffoldTsPath: join(pluginOutDir(), 'scaffold.ts'),
      emitter: matchingFakeEmitter,
    });

    expect(result.modulePath).toBe(join(pluginOutDir(), 'scaffold.js'));
    expect(await readFile(result.modulePath!, 'utf8')).toContain("id: 'closure-fixture'");
  });

  it('closures + --no-emit-js with a foreign scaffold.js: succeeds and leaves the foreign file untouched', async () => {
    await mkdir(pluginOutDir(), { recursive: true });
    const foreignContent = '// hand-written workaround, not from synth\nexport default {};\n';
    await writeFile(join(pluginOutDir(), 'scaffold.js'), foreignContent, 'utf8');

    const result = await synthWithModule(DEFINITION_WITH_VALIDATE, {
      outDir: pluginOutDir(),
      emitJs: false,
      stderr: () => {},
    });

    expect(result.modulePath).toBeUndefined();
    expect(await readFile(join(pluginOutDir(), 'scaffold.js'), 'utf8')).toBe(foreignContent);
  });

  it('--no-emit-js (emitJs: false) with closures present: writes JSON with $synth (no module field), warns on stderr, succeeds', async () => {
    const warnings: string[] = [];
    const result = await synthWithModule(DEFINITION_WITH_VALIDATE, {
      outDir: pluginOutDir(),
      emitJs: false,
      stderr: (l) => warnings.push(l),
    });

    expect(result.droppedClosures).toEqual(['questions.name.validate']);
    expect(result.modulePath).toBeUndefined();
    await expect(stat(join(pluginOutDir(), 'scaffold.js'))).rejects.toThrow();

    const jsonRaw = JSON.parse(await readFile(result.outputPath, 'utf8'));
    expect(jsonRaw.$synth).toEqual({ droppedClosures: ['questions.name.validate'] });
    expect(jsonRaw.$synth.module).toBeUndefined();

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('questions.name.validate');
  });

  it('throws on structural validation failure before ever touching the emitter or the disk', async () => {
    const invalid = { ...VALID_DEFINITION, steps: 'not-an-array' } as unknown as ScaffoldDefinition;
    let emitterCalled = false;
    const neverCalledEmitter: ScaffoldModuleEmitter = {
      async emit() {
        emitterCalled = true;
        return '';
      },
    };

    await expect(
      synthWithModule(invalid, { outDir: pluginOutDir(), emitter: neverCalledEmitter })
    ).rejects.toThrow();

    expect(emitterCalled).toBe(false);
    await expect(stat(pluginOutDir())).rejects.toThrow();
  });
});
