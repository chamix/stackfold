/**
 * Shared, zod-based structural validation for free-text answers
 * (SEC-001b — .agents/specs/sec-001-input-injection-validation.md,
 * Invariant B). Fail-fast only: rejects structurally invalid input at the
 * `Prompter` boundary before `buildBlueprint()` ever runs. Deliberately
 * not a character blocklist (`<`, `>`, backticks, …) — that duplicates
 * the escaping already verified at the render sinks (`escapeHtml()`,
 * `escapeScriptClose()`, `json()`/`JSON.stringify`) and would reject
 * legitimate input (an author name with an apostrophe, for instance).
 *
 * Also the single source of truth for `MAX_PACKAGE_NAME_LENGTH`
 * (previously duplicated verbatim in both `electron-ts/templates.ts` and
 * `web-app/shared-questions.ts`).
 */
import { z } from 'zod';
import type { QuestionConstraints } from './types.js';

/** npm registry's hard limit on the `package.json` `name` field. */
export const MAX_PACKAGE_NAME_LENGTH = 214;

const noControlChars = (value: string) => !/[\x00-\x1F\x7F]/.test(value);

export const appNameSchema = z
  .string()
  .trim()
  .min(1, 'App name must not be empty.')
  .max(100, 'App name must be 100 characters or fewer.')
  .refine(noControlChars, 'App name must not contain control characters.')
  .refine((v) => /[a-zA-Z0-9]/.test(v), 'App name must contain at least one letter or digit.');

export const descriptionSchema = z
  .string()
  .trim()
  .max(200, 'Description must be 200 characters or fewer.')
  .refine(noControlChars, 'Description must not contain control characters.')
  .refine((v) => !v.includes('\n'), 'Description must be a single line.');

export const authorSchema = z
  .string()
  .trim()
  .max(150, 'Author must be 150 characters or fewer.')
  .refine(noControlChars, 'Author must not contain control characters.')
  .refine((v) => !v.includes('\n'), 'Author must be a single line.');

/**
 * Kebab-case: lowercase letters/digits, single hyphens, starting with a
 * letter. Hoisted here from `src/plugins/plugin-builder/scaffold.ts`
 * (ARCH-003 Decision 2) once a second consumer
 * (`src/plugins/plugin-scaffold/scaffold.ts`) needed the exact same
 * plugin-id validation — same convention/style as `appNameSchema` above
 * (trim, bounded length, a `refine` with a clear message), not a parallel
 * validation scheme.
 */
export const pluginIdSchema = z
  .string()
  .trim()
  .min(1, 'Plugin id must not be empty.')
  .max(100, 'Plugin id must be 100 characters or fewer.')
  .refine(
    (v) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(v),
    'Plugin id must be kebab-case: lowercase letters/digits, single hyphens, starting with a letter.'
  );

// ---------------------------------------------------------------------------
// Migrated `QuestionConstraints` (SYNTH-002, .agents/specs/
// synth-002-declarative-validation.md D5; SK-ADR-010) — declarative,
// `core/constraints.ts`-interpreted equivalents of the 4 zod schemas above,
// for the 3 built-in plugins' questions (`plugin-builder`/`plugin-scaffold`'s
// `pluginId`/`displayName`/`description`/`author`, `web-app-stackfold`'s
// `appName`/`description`/`author`). The zod schemas themselves are NOT
// rewritten or derived from these — they stay the single source of truth for
// `toValidate()`-based authoring, and `tests/unit/core-constraints-differential.test.ts`
// guards the two from drifting apart (SK-ADR-010 Decision 5/Consequences).
//
// Each constant's shape/message/order below is read directly off its sibling
// zod schema above, field for field:
// - `trim` mirrors the schema's own leading `.trim()`.
// - `minLength`/`maxLength` mirror `.min()`/`.max()`, in the same order zod
//   declares them (zod itself checks min before max).
// - `rules` mirrors the schema's own `.refine()` calls, in declaration
//   order — `notMatches` for a `.refine(no<X>, ...)`-shaped negative check,
//   `matches` for a `.refine((v) => <regex>.test(v), ...)`-shaped positive
//   one.
// ---------------------------------------------------------------------------

const CONTROL_CHARS_SOURCE = '[\\x00-\\x1F\\x7F]';

/** Equivalent to `appNameSchema` above. */
export const appNameConstraints: QuestionConstraints = {
  trim: true,
  minLength: { value: 1, message: 'App name must not be empty.' },
  maxLength: { value: 100, message: 'App name must be 100 characters or fewer.' },
  rules: [
    { notMatches: CONTROL_CHARS_SOURCE, message: 'App name must not contain control characters.' },
    { matches: '[a-zA-Z0-9]', message: 'App name must contain at least one letter or digit.' },
  ],
};

/** Equivalent to `descriptionSchema` above. */
export const descriptionConstraints: QuestionConstraints = {
  trim: true,
  maxLength: { value: 200, message: 'Description must be 200 characters or fewer.' },
  rules: [
    { notMatches: CONTROL_CHARS_SOURCE, message: 'Description must not contain control characters.' },
    { notMatches: '\\n', message: 'Description must be a single line.' },
  ],
};

/** Equivalent to `authorSchema` above. */
export const authorConstraints: QuestionConstraints = {
  trim: true,
  maxLength: { value: 150, message: 'Author must be 150 characters or fewer.' },
  rules: [
    { notMatches: CONTROL_CHARS_SOURCE, message: 'Author must not contain control characters.' },
    { notMatches: '\\n', message: 'Author must be a single line.' },
  ],
};

/** Equivalent to `pluginIdSchema` above. */
export const pluginIdConstraints: QuestionConstraints = {
  trim: true,
  minLength: { value: 1, message: 'Plugin id must not be empty.' },
  maxLength: { value: 100, message: 'Plugin id must be 100 characters or fewer.' },
  rules: [
    {
      matches: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
      message: 'Plugin id must be kebab-case: lowercase letters/digits, single hyphens, starting with a letter.',
    },
  ],
};

/**
 * Adapts a zod string schema into the `(value: unknown) => true | string`
 * shape `QuestionDefinition.validate` expects (`core/types.ts`) — zod is
 * an implementation detail behind that existing seam, not a new port.
 */
export function toValidate(schema: z.ZodSchema<string>): (value: unknown) => true | string {
  return (value) => {
    const result = schema.safeParse(String(value));
    return result.success ? true : (result.error.issues[0]?.message ?? 'Invalid value.');
  };
}
