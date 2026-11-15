/**
 * ARCH-006 slice B (`.agents/specs/arch-006-plugin-composition.md` D4;
 * SK-ADR-011 Decision 4) — differential equivalence between
 * `npmPackageNameConstraints`/`singleLineConstraints(max)` and their zod
 * twins, over a FIXED TABLE of valid/invalid cases (not an open-ended
 * random corpus like `tests/unit/core-constraints-differential.test.ts` —
 * D4 explicitly calls for a fixed table here). Same discipline as that
 * file: `compileConstraints(constraints)(value)` must equal
 * `toValidate(schema)(value)` exactly — `true`, or the identical error
 * message string.
 */
import { describe, expect, it } from 'vitest';
import {
  npmPackageNameConstraints,
  npmPackageNameSchema,
  singleLineConstraints,
  singleLineSchema,
  toValidate,
} from '../../src/core/validation.js';
import { compileConstraints } from '../../src/core/constraints.js';

// ---------------------------------------------------------------------------
// npmPackageNameConstraints / npmPackageNameSchema
// ---------------------------------------------------------------------------

describe('npmPackageNameConstraints vs. npmPackageNameSchema (ARCH-006 slice B)', () => {
  const zodValidate = toValidate(npmPackageNameSchema);
  const constraintsValidate = compileConstraints(npmPackageNameConstraints);

  // Fixed table — every case named in the delegation prompt: scoped names,
  // boundary lengths (right at 214 and over), leading dot, leading
  // underscore, uppercase letters, spaces, URL-unsafe characters, and the
  // empty string. Plus the exact "Valid Names" examples from
  // `validate-npm-package-name`'s own README (verified against the real
  // v8.0.0 source, `lib/index.js` — see `src/core/validation.ts`'s header
  // comment on this validator).
  const VALID_NAMES: string[] = [
    'some-package',
    'example.com',
    'under_score',
    '123numeric',
    '@npm/thingy',
    '@jane/foo.js',
    'a',
    'a'.repeat(214), // boundary: exactly at the max length
  ];

  const INVALID_NAMES: string[] = [
    '', // empty string
    '.leading-dot',
    '_leading-underscore',
    'MyPackage', // uppercase letters
    'my package', // spaces
    'my@package', // URL-unsafe character (not the scope-prefix position)
    'my/package/extra', // URL-unsafe shape (more than one slash)
    'a'.repeat(215), // boundary: one over the max length
    '@Scope/name', // uppercase in the scope segment
    '@scope/.leading-dot', // leading dot in the scoped pkg segment
  ];

  for (const name of [...VALID_NAMES, ...INVALID_NAMES]) {
    it(`agrees with the zod schema for ${JSON.stringify(name)}`, () => {
      expect(constraintsValidate(name)).toEqual(zodValidate(name));
    });
  }

  it('actually accepts every VALID_NAMES entry (sanity: the table itself is not vacuous)', () => {
    for (const name of VALID_NAMES) {
      expect(zodValidate(name), `expected ${JSON.stringify(name)} to be valid`).toBe(true);
    }
  });

  it('actually rejects every INVALID_NAMES entry (sanity: the table itself is not vacuous)', () => {
    for (const name of INVALID_NAMES) {
      expect(zodValidate(name), `expected ${JSON.stringify(name)} to be invalid`).not.toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// singleLineConstraints(max) / singleLineSchema(max)
// ---------------------------------------------------------------------------

describe('singleLineConstraints(max) vs. singleLineSchema(max) (ARCH-006 slice B)', () => {
  const max = 10;
  const zodValidate = toValidate(singleLineSchema(max));
  const constraintsValidate = compileConstraints(singleLineConstraints(max));

  const CASES: string[] = [
    '',
    '   ',
    'hello',
    'a'.repeat(max),
    'a'.repeat(max + 1),
    'line one\nline two',
    'carriage\rreturn',
    'tab\tis fine',
    'A\x07B',
    '  padded  ',
  ];

  for (const value of CASES) {
    it(`agrees with the zod schema for ${JSON.stringify(value)}`, () => {
      expect(constraintsValidate(value)).toEqual(zodValidate(value));
    });
  }

  it('rejects a value containing a line break with the single-line message specifically (short enough that maxLength never preempts it)', () => {
    const shortValueWithBreak = 'a\nb'; // well under max (10), isolates the line-break rule
    expect(zodValidate(shortValueWithBreak)).toBe('Value must be a single line.');
    expect(constraintsValidate(shortValueWithBreak)).toBe('Value must be a single line.');
  });

  describe('max validation (fail-fast, both twins)', () => {
    const invalidMaxValues = [0, -1, 1.5, Number.NaN];

    for (const invalidMax of invalidMaxValues) {
      it(`singleLineConstraints(${invalidMax}) throws`, () => {
        expect(() => singleLineConstraints(invalidMax)).toThrow();
      });

      it(`singleLineSchema(${invalidMax}) throws`, () => {
        expect(() => singleLineSchema(invalidMax)).toThrow();
      });
    }
  });
});
