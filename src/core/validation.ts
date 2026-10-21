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
