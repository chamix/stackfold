import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition from './scaffold.js';

// Task 043 (.agents/specs/043-electron-stackfold-web-app-reauthor.md §0 point
// 1, SK-ADR-003): proves electron-stackfold's own scaffold.ts compiles and
// synthesizes a real blueprint directly — via its real default export, not
// the synthesized ./scaffold.json — so this test never depends on `stackfold
// scaffold synth` having run. Mirrors `src/plugins/plugin-builder/
// scaffold.test.ts`'s own shape (same thunk-resolution convention, kept
// generic even though this default export, like plugin-builder's, is a
// plain object, not a thunk).
describe('electron-stackfold — its own ScaffoldDefinition compiles (SK-ADR-003)', () => {
  it('parses/compiles via compileScaffold() without throwing', async () => {
    const resolved =
      typeof definition === 'function' ? await (definition as () => unknown | Promise<unknown>)() : definition;
    expect(() => compileScaffold(resolved as ScaffoldDefinition, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  it('builds a real blueprint from its own default answers without throwing', async () => {
    const resolved =
      typeof definition === 'function' ? await (definition as () => unknown | Promise<unknown>)() : definition;
    const plugin = compileScaffold(resolved as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const defaults = Object.fromEntries(
      plugin.questions().map((q) => [q.id, q.default ?? (q.type === 'confirm' ? false : '')])
    );
    expect(() => plugin.buildBlueprint(defaults)).not.toThrow();
  });

  // Task 044 (UX-001/SK-ADR-004, rollout table): electron-stackfold's entry
  // point is fixed, independent of answers — a plain literal, same pattern
  // as a literal boolean `when` today.
  it('declares mainFile as the fixed src/main/index.ts entry point', async () => {
    const resolved =
      typeof definition === 'function' ? await (definition as () => unknown | Promise<unknown>)() : definition;
    const plugin = compileScaffold(resolved as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const defaults = Object.fromEntries(
      plugin.questions().map((q) => [q.id, q.default ?? (q.type === 'confirm' ? false : '')])
    );
    expect(plugin.buildBlueprint(defaults).mainFile).toBe('src/main/index.ts');
  });
});
