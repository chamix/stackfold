import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition from './scaffold.json' with { type: 'json' };

describe('electron-stackfold — generated ScaffoldDefinition', () => {
  it('parses/compiles via compileScaffold() without throwing', () => {
    expect(() => compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator())).not.toThrow();
  });
});
