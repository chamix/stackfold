import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition, { APP_TYPE_CHOICES } from './scaffold.js';

// Task 043 (.agents/specs/043-electron-stackfold-web-app-reauthor.md §0
// point 2, SK-ADR-003): proves web-app-stackfold's own scaffold.ts compiles
// and synthesizes a real blueprint directly — via its real default export,
// not the synthesized ./scaffold.json — so this test never depends on
// `stackfold scaffold synth` having run. Mirrors `plugin-builder`/
// `electron-stackfold`'s own `scaffold.test.ts` shape, plus a real
// `buildBlueprint()` smoke call per `appType` value (this plugin's own
// mutually-exclusive-selection surface, the thing those two simpler plugins
// don't have).
describe('web-app-stackfold — its own ScaffoldDefinition compiles (SK-ADR-003)', () => {
  it('parses/compiles via compileScaffold() without throwing', () => {
    expect(() => compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator())).not.toThrow();
  });

  it('declares appName/description/author/appType, in that order', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    expect(plugin.questions().map((q) => q.id)).toEqual(['appName', 'description', 'author', 'appType']);
  });

  it('appType is a select question with the 4 expected choices, defaulting to spa-react', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const appType = plugin.questions().find((q) => q.id === 'appType');
    expect(appType?.type).toBe('select');
    expect(appType?.choices).toEqual(['standalone-html', 'spa-react', 'spa-vue', 'spa-vanilla']);
    expect(appType?.default).toBe('spa-react');
  });

  it.each(APP_TYPE_CHOICES)('builds a real blueprint for appType=%s without throwing', (appType) => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace', appType };
    expect(() => plugin.buildBlueprint(answers)).not.toThrow();
  });

  it('rejects an invalid appName at the validate() boundary (the reason this plugin must compile from scaffold.js, not scaffold.json)', () => {
    const plugin = compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
    const appName = plugin.questions().find((q) => q.id === 'appName');
    expect(appName?.validate).toBeTypeOf('function');
    expect(appName?.validate?.('')).not.toBe(true);
    expect(appName?.validate?.('Valid Name')).toBe(true);
  });
});
