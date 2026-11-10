/**
 * SYNTH-002 acceptance criterion 1 (`.agents/specs/synth-002-declarative-validation.md`):
 * for each of the 4 migrated families, `compileConstraints(Xconstraints)(v)`
 * must equal `toValidate(Xschema)(v)` (same `true`, or the exact same error
 * message string) over (i) the real SEC-001 adversarial corpus — reused by
 * literal copy from `tests/unit/core-validation-injection.test.ts`, which
 * this file never imports from or edits (per that file's own blast-radius
 * protection) — and (ii) >=2000 deterministic pseudo-random strings via a
 * hand-rolled seeded PRNG (no new dependency — ADR-016 does not apply).
 */
import { describe, expect, it } from 'vitest';
import {
  appNameConstraints,
  appNameSchema,
  authorConstraints,
  authorSchema,
  descriptionConstraints,
  descriptionSchema,
  pluginIdConstraints,
  pluginIdSchema,
  toValidate,
} from '../../src/core/validation.js';
import { compileConstraints } from '../../src/core/constraints.js';
import type { QuestionConstraints } from '../../src/core/types.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// SEC-001 corpus — copied verbatim (payload literals only) from
// tests/unit/core-validation-injection.test.ts, never imported from it (that
// file's own blast-radius note: reused, never edited, never depended upon by
// a sibling test file in a way that would need touching it to extend).
// ---------------------------------------------------------------------------
const SEC_001_CORPUS: string[] = [
  '',
  '   ',
  '!!!',
  '\n',
  '\t',
  'my-app',
  'My Cool App',
  'app2',
  '3D Viewer',
  'a'.repeat(10_000),
  'My\x01App',
  'App‮😀Name',
  '<script>alert(1)</script>App',
  '</script><script>evil()</script>App',
  'App"; DROP TABLE x; --',
  'App`rm -rf /`',
  'App$(whoami)',
  'A\x07B',
  'line one\nline two',
  'Text ‮😀 more',
  '<script>alert(1)</script>',
  '</script><script>evil()</script>',
  '"; DROP TABLE x; --',
  '`rm -rf /`',
  '$(whoami)',
  'my-cool-plugin',
  'MyCoolPlugin',
  '-leading-hyphen',
];

// ---------------------------------------------------------------------------
// Deterministic pseudo-random string generator (mulberry32 + a small
// weighted alphabet) — no new dependency (`npm pack --dry-run`'s "files"
// field is unaffected; ADR-016 does not apply, nothing is added to
// package.json). Fixed seed => byte-identical corpus on every run.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code points drawn from, weighted toward the interesting edge cases the spec names explicitly. */
const ALPHABET_POOLS: ReadonlyArray<readonly number[]> = [
  // ASCII letters/digits/punctuation
  Array.from({ length: 95 }, (_, i) => 0x20 + i),
  // control characters (the exact [\x00-\x1F\x7F] class the schemas reject)
  [...Array.from({ length: 32 }, (_, i) => i), 0x7f],
  // RTL override + a couple of emoji code points (surrogate-pair-safe via String.fromCodePoint)
  [0x202e, 0x1f600, 0x1f601, 0x1f389],
  // JS line/paragraph separators
  [0x2028, 0x2029],
  // whitespace
  [0x20, 0x09, 0x0a, 0x0d],
];

function randomString(rand: () => number, maxLength: number): string {
  const length = Math.floor(rand() * (maxLength + 1));
  let out = '';
  for (let i = 0; i < length; i++) {
    const pool = ALPHABET_POOLS[Math.floor(rand() * ALPHABET_POOLS.length)]!;
    const codePoint = pool[Math.floor(rand() * pool.length)]!;
    out += String.fromCodePoint(codePoint);
  }
  return out;
}

function generateCorpus(seed: number, count: number, maxLength: number): string[] {
  const rand = mulberry32(seed);
  const corpus: string[] = [];
  for (let i = 0; i < count; i++) {
    corpus.push(randomString(rand, maxLength));
  }
  return corpus;
}

const RANDOM_CORPUS = generateCorpus(0xc0ffee, 2_000, 250);

/** Exact length boundaries named by the spec's acceptance criterion 1: 0, 1, max, max+1 — per family, below. */
function lengthBoundaryStrings(max: number): string[] {
  return ['', 'a', 'a'.repeat(max), 'a'.repeat(max + 1)];
}

interface Family {
  name: string;
  schema: z.ZodSchema<string>;
  constraints: QuestionConstraints;
  max: number;
}

const FAMILIES: Family[] = [
  { name: 'appName', schema: appNameSchema, constraints: appNameConstraints, max: 100 },
  { name: 'description', schema: descriptionSchema, constraints: descriptionConstraints, max: 200 },
  { name: 'author', schema: authorSchema, constraints: authorConstraints, max: 150 },
  { name: 'pluginId', schema: pluginIdSchema, constraints: pluginIdConstraints, max: 100 },
];

describe('core/constraints.ts differential equivalence vs. zod (SYNTH-002 acceptance criterion 1)', () => {
  for (const family of FAMILIES) {
    describe(`family: ${family.name}`, () => {
      const zodValidate = toValidate(family.schema);
      const constraintsValidate = compileConstraints(family.constraints);
      const fullCorpus = [...SEC_001_CORPUS, ...RANDOM_CORPUS, ...lengthBoundaryStrings(family.max)];

      // One test per family (not one per string): a rule change that breaks equivalence would otherwise
      // fail hundreds of generated tests at once. Mismatches are collected and the first 10 are shown.
      it('agrees with the zod schema for every corpus string', () => {
        const mismatches: Array<{ value: string; constraints: true | string; zod: true | string }> = [];
        for (const value of fullCorpus) {
          const fromConstraints = constraintsValidate(value) as true | string;
          const fromZod = zodValidate(value) as true | string;
          if (fromConstraints !== fromZod) {
            mismatches.push({ value: JSON.stringify(value), constraints: fromConstraints, zod: fromZod });
          }
        }
        expect(mismatches.slice(0, 10), `${mismatches.length} mismatching string(s) out of ${fullCorpus.length}`).toEqual([]);
      });

      it(`exercises >= 2000 pseudo-random strings (actual: ${fullCorpus.length})`, () => {
        expect(fullCorpus.length).toBeGreaterThanOrEqual(2000);
      });
    });
  }
});
