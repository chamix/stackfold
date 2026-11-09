import { describe, expect, it } from 'vitest';
import { compileConstraints } from '../../src/core/constraints.js';
import type { QuestionConstraints } from '../../src/core/types.js';

describe('compileConstraints — shape/order (SYNTH-002 D2)', () => {
  it('returns true for a value satisfying every check', () => {
    const check = compileConstraints({ trim: true, minLength: { value: 1, message: 'too short' } });
    expect(check('hi')).toBe(true);
  });

  it('non-string value => fixed "Expected a string" message', () => {
    const check = compileConstraints({ minLength: { value: 1, message: 'too short' } });
    expect(check(42)).toBe('Expected a string');
    expect(check(true)).toBe('Expected a string');
    expect(check(undefined)).toBe('Expected a string');
    expect(check(null)).toBe('Expected a string');
    expect(check({})).toBe('Expected a string');
  });

  describe('trim', () => {
    it('evaluates checks against the trimmed value when trim: true', () => {
      const check = compileConstraints({ trim: true, minLength: { value: 1, message: 'too short' } });
      expect(check('   ')).toBe('too short');
    });

    it('evaluates checks against the raw value when trim is absent/false', () => {
      const check = compileConstraints({ maxLength: { value: 2, message: 'too long' } });
      // "   " has length 3 untrimmed -> violates maxLength 2, proving no implicit trim.
      expect(check('   ')).toBe('too long');
    });
  });

  describe('minLength / maxLength measure Unicode code points, not UTF-16 units (matches zod — see core/constraints.ts header comment)', () => {
    it('a single astral emoji (2 UTF-16 units, 1 code point) counts as length 1', () => {
      const check = compileConstraints({ maxLength: { value: 1, message: 'too long' } });
      expect('😀'.length).toBe(2); // sanity: UTF-16 surrogate pair
      expect(check('😀')).toBe(true);
    });

    it('rejects 2 emoji (4 UTF-16 units, 2 code points) against maxLength: 1', () => {
      const check = compileConstraints({ maxLength: { value: 1, message: 'too long' } });
      expect(check('😀😀')).toBe('too long');
    });
  });

  describe('minLength / maxLength boundaries', () => {
    const bounded: QuestionConstraints = {
      minLength: { value: 2, message: 'min' },
      maxLength: { value: 4, message: 'max' },
    };
    const check = compileConstraints(bounded);

    it.each([
      ['', 'min'],
      ['a', 'min'],
      ['ab', true],
      ['abcd', true],
      ['abcde', 'max'],
    ])('length boundary %j => %j', (value, expected) => {
      expect(check(value)).toBe(expected);
    });
  });

  describe('rules — matches/notMatches', () => {
    it('"matches" fails when the value does NOT contain a match', () => {
      const check = compileConstraints({ rules: [{ matches: '[0-9]', message: 'needs a digit' }] });
      expect(check('abc')).toBe('needs a digit');
      expect(check('abc1')).toBe(true);
    });

    it('"notMatches" fails when the value DOES contain a match', () => {
      const check = compileConstraints({ rules: [{ notMatches: '[0-9]', message: 'no digits allowed' }] });
      expect(check('abc1')).toBe('no digits allowed');
      expect(check('abc')).toBe(true);
    });

    it('rules are evaluated in declared array order', () => {
      const check = compileConstraints({
        rules: [
          { matches: 'A', message: 'needs A' },
          { matches: 'B', message: 'needs B' },
        ],
      });
      // Missing both -> first rule's message wins.
      expect(check('xx')).toBe('needs A');
      // Has A, missing B -> second rule's message.
      expect(check('xA')).toBe('needs B');
    });
  });

  describe('first-failure-wins ordering: trim -> minLength -> maxLength -> rules[]', () => {
    it('a string violating minLength (and, were it reached, the rule too) reports minLength\'s message first', () => {
      const check = compileConstraints({
        trim: true,
        minLength: { value: 5, message: 'minLength message' },
        maxLength: { value: 10, message: 'maxLength message' },
        rules: [{ matches: 'Z', message: 'rule message' }],
      });
      // Trimmed value "ab" (length 2) violates minLength (5) first — it
      // also lacks "Z" (would fail the rule), but minLength short-circuits
      // before the rule is ever evaluated.
      expect(check('  ab  ')).toBe('minLength message');
    });

    it('a string passing minLength but failing maxLength and the rule reports maxLength\'s message', () => {
      const check = compileConstraints({
        minLength: { value: 1, message: 'minLength message' },
        maxLength: { value: 2, message: 'maxLength message' },
        rules: [{ matches: 'Z', message: 'rule message' }],
      });
      expect(check('abc')).toBe('maxLength message');
    });

    it('a string passing length bounds but failing two rules reports the first rule\'s message', () => {
      const check = compileConstraints({
        rules: [
          { matches: 'Z', message: 'first rule message' },
          { notMatches: 'a', message: 'second rule message' },
        ],
      });
      expect(check('abc')).toBe('first rule message');
    });
  });
});

describe('compileConstraints — malformed constraints (fail-fast, SYNTH-002 invariant 5)', () => {
  it.each([
    ['not an object', 'not-an-object' as unknown as QuestionConstraints],
    ['null', null as unknown as QuestionConstraints],
    ['array', [] as unknown as QuestionConstraints],
    ['unknown top-level key', { bogus: true } as unknown as QuestionConstraints],
    ['non-boolean trim', { trim: 'yes' } as unknown as QuestionConstraints],
    ['minLength missing value', { minLength: { message: 'm' } } as unknown as QuestionConstraints],
    ['minLength negative value', { minLength: { value: -1, message: 'm' } }],
    ['minLength non-integer value', { minLength: { value: 1.5, message: 'm' } }],
    ['minLength NaN value', { minLength: { value: NaN, message: 'm' } }],
    ['minLength empty message', { minLength: { value: 1, message: '' } }],
    ['minLength unknown key', { minLength: { value: 1, message: 'm', extra: 1 } } as unknown as QuestionConstraints],
    ['maxLength negative value', { maxLength: { value: -1, message: 'm' } }],
    ['minLength > maxLength', { minLength: { value: 5, message: 'm' }, maxLength: { value: 1, message: 'm' } }],
    ['rules not an array', { rules: {} } as unknown as QuestionConstraints],
    ['rule with neither matches nor notMatches', { rules: [{ message: 'm' }] } as unknown as QuestionConstraints],
    [
      'rule with both matches and notMatches',
      { rules: [{ matches: 'a', notMatches: 'b', message: 'm' }] } as unknown as QuestionConstraints,
    ],
    ['rule with unknown key', { rules: [{ matches: 'a', message: 'm', extra: 1 }] } as unknown as QuestionConstraints],
    ['rule with empty message', { rules: [{ matches: 'a', message: '' }] }],
    ['rule with invalid regex source', { rules: [{ matches: '(unterminated', message: 'm' }] }],
  ])('throws for: %s', (_label, bad) => {
    expect(() => compileConstraints(bad)).toThrow();
  });

  it('throws synchronously at compile time, never deferred to the returned check function', () => {
    expect(() => compileConstraints({ rules: [{ matches: '(unterminated', message: 'm' }] })).toThrow();
  });
});
