import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import type { HookPorts } from '../../core/types.js';
import definition from './scaffold.js';

// Task 042 (D-F): proves plugin-builder's own scaffold.ts compiles directly
// — via its real default export, not the synthesized ./scaffold.json — so
// this test never depends on `stackfold scaffold synth` having run.
// Resolves a possible thunk first (same convention
// `scaffoldSynth.ts`/`templates/scaffold.test.ts.hbs` already use), even
// though plugin-builder's own default export here is a plain object, not a
// thunk — kept generic so this test stays correct if that ever changes.
describe('plugin-builder — its own ScaffoldDefinition compiles (D-F)', () => {
  it('parses/compiles via compileScaffold() without throwing', async () => {
    const resolved =
      typeof definition === 'function' ? await (definition as () => unknown | Promise<unknown>)() : definition;
    expect(() => compileScaffold(resolved as ScaffoldDefinition, new JsonLogicExpressionEvaluator())).not.toThrow();
  });
});

// SYNTH-001 / SK-ADR-009 Decision 2: plugin-builder's own postInit synth
// step must pass `--no-emit-js`, so a freshly generated in-repo plugin
// never gets a `scaffold.js` shadowing its own `scaffold.ts` under `tsx`'s
// module resolution. Exercises the real compiled `postInit` handler
// directly (never re-deriving the args from the source), capturing exactly
// what `ports.processRunner.run()` was called with.
describe('plugin-builder — postInit synth step passes --no-emit-js (SYNTH-001)', () => {
  it('invokes "npx tsx src/cli/index.ts scaffold synth src/plugins/<pluginId> --no-emit-js"', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const ports: HookPorts = {
      prompter: { ask: async () => ({}) },
      fileWriter: {
        ensureEmptyDir: async () => {},
        writeFile: async () => {},
        readFile: async () => undefined,
        overwriteFile: async () => {},
      },
      processRunner: {
        run: async (command, args) => {
          calls.push({ command, args });
        },
      },
    };

    const resolved =
      typeof definition === 'function' ? await (definition as () => unknown | Promise<unknown>)() : definition;
    const plugin = compileScaffold(resolved as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const synthStep = plugin.hooks!.postInit![0]!;
    await synthStep(ports, { pluginId: 'my-cool-plugin', displayName: 'X', description: 'Y', author: 'Z' });

    expect(calls).toEqual([
      { command: 'npx', args: ['tsx', 'src/cli/index.ts', 'scaffold', 'synth', 'src/plugins/my-cool-plugin', '--no-emit-js'] },
    ]);
  });
});
