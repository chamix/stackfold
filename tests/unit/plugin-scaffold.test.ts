import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import type { HookPorts } from '../../src/core/types.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition, { pluginIdSchema } from '../../src/plugins/plugin-scaffold/scaffold.js';

// Same shape as `src/plugins/electron-stackfold/scaffold.test.ts` /
// `src/plugins/plugin-builder/scaffold.test.ts` (ARCH-003 spec, blast-radius
// item (b)): compiles plugin-scaffold's own ScaffoldDefinition directly via
// its real default export, then exercises a real `buildBlueprint()` to
// smoke-test every writeFile step (same scope `src/authoring/synth.ts`'s own
// smoke test covers for a synth-time check).
describe('plugin-scaffold — its own ScaffoldDefinition (ARCH-003 Decision 3)', () => {
  it('compiles via compileScaffold() without throwing, carrying id/description/help', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());

    expect(plugin.id).toBe('plugin-scaffold');
    expect(plugin.description).toBeTruthy();
    expect(plugin.help?.name).toBe('Plugin Scaffold');
  });

  it('declares exactly the 4 questions, same ids as plugin-builder: pluginId, displayName, description, author', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    expect(plugin.questions().map((q) => q.id)).toEqual(['pluginId', 'displayName', 'description', 'author']);
  });

  it('every question has a defined, callable validate, and pluginId rejects a non-kebab-case value', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const questions = plugin.questions();

    for (const q of questions) {
      expect(typeof q.validate).toBe('function');
    }

    const pluginIdQuestion = questions.find((q) => q.id === 'pluginId');
    const verdict = pluginIdQuestion!.validate!("won't work");
    expect(verdict).not.toBe(true);
    expect(typeof verdict).toBe('string');
  });

  it('builds a real blueprint from real answers, producing the 4 standalone plugin files at the top level', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const answers = {
      pluginId: 'my-cool-plugin',
      displayName: 'My Cool Plugin',
      description: 'Does cool things.',
      author: 'Ada Lovelace',
    };

    const blueprint = plugin.buildBlueprint(answers);
    const paths = blueprint.files.map((f) => f.path);

    expect(paths).toEqual(
      expect.arrayContaining(['templates/readme.md.hbs', 'scaffold.ts', 'scaffold.test.ts', 'package.json'])
    );
  });

  it("the generated scaffold.ts imports the authoring DSL from 'stackfold/authoring', never a relative monorepo path", () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint({
      pluginId: 'my-cool-plugin',
      displayName: 'My Cool Plugin',
      description: 'Does cool things.',
      author: 'Ada Lovelace',
    });

    const generated = blueprint.files.find((f) => f.path === 'scaffold.ts');
    expect(generated).toBeDefined();
    expect(generated!.content.toString()).toContain("from 'stackfold/authoring'");
    expect(generated!.content.toString()).not.toContain('../../authoring/');
  });

  it('the generated package.json declares "type": "module" (synth()\'s documented ESM-ancestor precondition)', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const blueprint = plugin.buildBlueprint({
      pluginId: 'my-cool-plugin',
      displayName: 'My Cool Plugin',
      description: 'Does cool things.',
      author: 'Ada Lovelace',
    });

    const generatedPackageJson = blueprint.files.find((f) => f.path === 'package.json');
    expect(generatedPackageJson).toBeDefined();
    expect(JSON.parse(generatedPackageJson!.content.toString())).toMatchObject({ type: 'module' });
  });

  it('declares no patchFile step anywhere (ARCH-003 Decision 3: nothing to patch for an external plugin)', () => {
    const cliSource = JSON.stringify(definition);
    expect(cliSource).not.toContain('patchFile');
  });
});

// Blocking finding (.agents/specs/review_report.md, Decision 3): `postInit`'s
// `runHookCommand` synth step assumes the init directory argument === the
// `pluginId` answer, with nothing enforcing it. `postWrite` is the earliest
// lifecycle moment (`HookPorts` never carries `targetDir` — confirmed via
// `core/types.ts`) at which a mismatch is observable at all: once files are
// written, `<real cwd>/<directory argument>/scaffold.ts` really exists, so a
// guard checking for `<real cwd>/<pluginId>/scaffold.ts` (the exact path the
// synth step is about to assume) can fail fast with a clear message instead
// of letting the synth step's confusing "Cannot find module" error surface.
//
// Exercises the real compiled `postWrite` hook handler directly — no
// `core/orchestrator.ts` involved (out of scope) — with a real `node`
// subprocess (via a minimal `processRunner.run()` fake that always targets a
// controlled temp dir, standing in for "the real invoking process's cwd"),
// so this proves actual behavior, not merely the shape of the generated
// command.
describe('plugin-scaffold — postWrite directory/pluginId mismatch guard', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'stackfold-plugin-scaffold-guard-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function makePorts(): HookPorts {
    return {
      prompter: { ask: async () => ({}) },
      fileWriter: {
        ensureEmptyDir: async () => {
          throw new Error('not used by this guard');
        },
        writeFile: async () => {
          throw new Error('not used by this guard');
        },
        readFile: async () => undefined,
        overwriteFile: async () => {
          throw new Error('not used by this guard');
        },
      },
      // Stands in for "the real invoking process's cwd" (`core/
      // authoring.ts`'s `runHookCommand` header comment): always resolves
      // the check script against the per-test temp dir, regardless of the
      // real test runner's own cwd.
      processRunner: {
        run: async (command: string, args: string[]) => {
          execFileSync(command, args, { cwd, stdio: 'pipe' });
        },
      },
    };
  }

  function compiledGuard() {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const guard = plugin.hooks?.postWrite?.[0];
    expect(guard).toBeDefined();
    return guard!;
  }

  it('fails with a clear, actionable message when the directory argument does not match the pluginId answer', async () => {
    // Simulates `stackfold init plugin-scaffold some-dir --answer pluginId=actual-plugin-id`:
    // files landed under `some-dir` (never created here), not under
    // `actual-plugin-id`, so the guard's expected path is missing.
    const guard = compiledGuard();
    const answers = { pluginId: 'actual-plugin-id', displayName: 'X', description: 'Y', author: 'Z' };

    await expect(guard(makePorts(), answers)).rejects.toThrow(
      /did not match the pluginId answer \("actual-plugin-id"\).*Re-run: stackfold init plugin-scaffold actual-plugin-id/s
    );
  });

  it('succeeds unchanged when the directory argument matches the pluginId answer', async () => {
    // Simulates `stackfold init plugin-scaffold my-cool-plugin --answer pluginId=my-cool-plugin`:
    // the just-written scaffold.ts really is at `<cwd>/my-cool-plugin/scaffold.ts`.
    const guard = compiledGuard();
    const answers = { pluginId: 'my-cool-plugin', displayName: 'X', description: 'Y', author: 'Z' };

    await mkdir(join(cwd, 'my-cool-plugin'), { recursive: true });
    await writeFile(join(cwd, 'my-cool-plugin', 'scaffold.ts'), '// stub\n', 'utf8');

    await expect(guard(makePorts(), answers)).resolves.toBeUndefined();
  });
});

describe('pluginIdSchema (re-exported, hoisted from core/validation.ts — ARCH-003 Decision 2)', () => {
  it('enforces kebab-case (lowercase letters/digits/hyphens, starting with a letter)', () => {
    expect(pluginIdSchema.safeParse('my-cool-plugin').success).toBe(true);
    expect(pluginIdSchema.safeParse('MyCoolPlugin').success).toBe(false);
    expect(pluginIdSchema.safeParse('').success).toBe(false);
  });
});
