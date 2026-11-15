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

// ---------------------------------------------------------------------------
// ARCH-006 slice B (`.agents/specs/arch-006-plugin-composition.md` D4;
// SK-ADR-011 Decision 4) — shared validators published through the
// `stackfold/authoring` barrel, in the same closed vocabulary as the 4
// families above (declarative `QuestionConstraints` + a zod twin for
// `toValidate()`-based authoring, equivalence guarded by
// `tests/unit/core-validation-shared.test.ts`'s fixed table). No new
// dependency (D4): `validate-npm-package-name`'s published rule set
// (https://www.npmjs.com/package/validate-npm-package-name, `lib/index.js`
// in the real v8.0.0 source — read directly, not from memory) is
// reimplemented with the vocabulary this file already has, not installed.
// ---------------------------------------------------------------------------

/**
 * `validate-npm-package-name`'s `validForNewPackages` rule set, minus its
 * `node_modules`/`favicon.ico` exclusion list and its core-module-name
 * warning — both are a fixed-string allowlist concern orthogonal to
 * *format* validation, not expressible as (and not worth forcing into) this
 * file's `matches`/`notMatches` regex vocabulary, and no plugin author's
 * `pluginId`/package-name question has ever needed to reject exactly those
 * two literal strings. Confirmed against the real source rather than
 * memory: a name is `validForNewPackages` only when it has zero errors AND
 * zero warnings; reading `lib/index.js` folds both error- and
 * warning-producing checks into one required rule set for "valid new
 * package name":
 * - length: 1-214 characters (`MAX_PACKAGE_NAME_LENGTH` above).
 * - lowercase only (a mixed-case name is a *warning*, i.e. invalid for new
 *   packages).
 * - URL-safe characters only (`encodeURIComponent(name) === name`, checked
 *   per-segment for a scoped `@scope/name`).
 * - unscoped names (and a scoped name's `@scope` segment) may use any
 *   URL-safe-lowercase character; the final segment (the unscoped name
 *   itself, or a scoped name's `pkg` part) must additionally not start with
 *   `.`/`_`/`-` (an unscoped name failing this is a hard `errors` case; the
 *   real library only enforces the `.` half of this for a scoped `pkg`
 *   segment specifically — rejecting a leading `_`/`-` there too is this
 *   validator's own, stricter-but-undocumented choice, since no real-world
 *   scoped package name intentionally starts a segment that way).
 *
 * `NPM_PACKAGE_NAME_FORMAT_SOURCE` is the *one* source of truth for this
 * shape, shared byte-for-byte between `npmPackageNameSchema` (via
 * `new RegExp(...)`) and `npmPackageNameConstraints` (the same string
 * passed straight through to `compileConstraints()`), so the two can never
 * drift on the regex itself — only the message text could, and that is
 * shared too (`NPM_PACKAGE_NAME_FORMAT_MESSAGE`).
 */
const NPM_PACKAGE_NAME_FORMAT_SOURCE = "^(?:@[a-z0-9._~!*'()-]+/)?[a-z0-9][a-z0-9._~!*'()-]*$";
const NPM_PACKAGE_NAME_FORMAT_MESSAGE =
  'Package name must be lowercase, contain only URL-safe characters, and not start with ".", "_", or "-" ' +
  '(optionally scoped as "@scope/name").';
const npmPackageNameFormatRegex = new RegExp(NPM_PACKAGE_NAME_FORMAT_SOURCE);

export const npmPackageNameSchema = z
  .string()
  .min(1, 'Package name must not be empty.')
  .max(MAX_PACKAGE_NAME_LENGTH, `Package name must be ${MAX_PACKAGE_NAME_LENGTH} characters or fewer.`)
  .regex(npmPackageNameFormatRegex, NPM_PACKAGE_NAME_FORMAT_MESSAGE);

/** Equivalent to `npmPackageNameSchema` above. */
export const npmPackageNameConstraints: QuestionConstraints = {
  minLength: { value: 1, message: 'Package name must not be empty.' },
  maxLength: { value: MAX_PACKAGE_NAME_LENGTH, message: `Package name must be ${MAX_PACKAGE_NAME_LENGTH} characters or fewer.` },
  rules: [{ matches: NPM_PACKAGE_NAME_FORMAT_SOURCE, message: NPM_PACKAGE_NAME_FORMAT_MESSAGE }],
};

/**
 * Rejects a non-positive-integer `max` immediately (fail-fast, same
 * philosophy as `core/constraints.ts`'s own `assertWellFormed()` — a
 * malformed *shape* is caught at compile/definition time, never deferred to
 * answer-validation time). Shared by `singleLineConstraints()` and
 * `singleLineSchema()` so both twins reject the exact same `max` values.
 */
function assertPositiveIntegerMax(max: number, caller: string): void {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`${caller}: "max" must be a positive integer, got ${JSON.stringify(max)}`);
  }
}

const LINE_BREAK_SOURCE = '[\\r\\n]';

/**
 * A single line of free text, `max` characters or fewer: rejects any `\n`/
 * `\r` (with its own, specific message — checked before the generic
 * control-character rule below, so a newline is reported as "must be a
 * single line" rather than lumped in with every other control character),
 * rejects any other control character, and requires a non-empty value
 * after trimming. `max` must be a positive integer (`assertPositiveIntegerMax()`
 * above) — thrown synchronously, at definition time, never at answer-validation
 * time.
 */
export function singleLineConstraints(max: number): QuestionConstraints {
  assertPositiveIntegerMax(max, 'singleLineConstraints');
  return {
    trim: true,
    minLength: { value: 1, message: 'Value must not be empty.' },
    maxLength: { value: max, message: `Value must be ${max} characters or fewer.` },
    rules: [
      { notMatches: LINE_BREAK_SOURCE, message: 'Value must be a single line.' },
      { notMatches: CONTROL_CHARS_SOURCE, message: 'Value must not contain control characters.' },
    ],
  };
}

/** Equivalent to `singleLineConstraints(max)` above. */
export function singleLineSchema(max: number): z.ZodSchema<string> {
  assertPositiveIntegerMax(max, 'singleLineSchema');
  return z
    .string()
    .trim()
    .min(1, 'Value must not be empty.')
    .max(max, `Value must be ${max} characters or fewer.`)
    .refine((v) => !new RegExp(LINE_BREAK_SOURCE).test(v), 'Value must be a single line.')
    .refine(noControlChars, 'Value must not contain control characters.');
}

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
