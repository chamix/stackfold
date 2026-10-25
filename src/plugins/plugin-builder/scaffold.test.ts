import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
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
