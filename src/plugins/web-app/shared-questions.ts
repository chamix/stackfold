/**
 * Shared answer namespace for every `web-app` flavor (appName/description/
 * author) — reused verbatim from `electron-ts`'s own question shape
 * (.agents/specs/initial_scaffold.md, "File set — Cycle 1"), not
 * re-derived. Deliberately standalone rather than imported from
 * `plugins/electron-ts/`: `plugins/web-app/` depends only on `core/`
 * (Inward Dependency Rule / SK-ADR-001's "Technical Specification"), and a
 * sibling-plugin import would violate that.
 *
 * Pure, no I/O. Free-text answers (appName, description, author) are only
 * ever interpolated into JSON (`JSON.stringify` handles escaping) or
 * through `escapeHtml()` below before reaching generated HTML — the same
 * "no free-text answer is ever interpolated unescaped" invariant
 * `electron-ts/templates.ts` already established.
 */
import type { Answers, QuestionDefinition } from '../../core/types.js';
import {
  MAX_PACKAGE_NAME_LENGTH,
  appNameSchema,
  authorSchema,
  descriptionSchema,
  toValidate,
} from '../../core/validation.js';

export const DEFAULT_APP_NAME = 'my-web-app';
export const DEFAULT_DESCRIPTION = 'A web app.';
export const DEFAULT_AUTHOR = '';

export interface WebAppSharedContext {
  appName: string;
  description: string;
  /** Empty when not supplied — LICENSE is then omitted entirely. */
  author: string;
  /** npm-safe slug: [a-z0-9] runs joined by single '-'. */
  packageName: string;
}

/** Derives a URL-safe npm package name from a human-readable app name. */
export function toPackageName(appName: string): string {
  return appName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PACKAGE_NAME_LENGTH)
    .replace(/-+$/, '');
}

function optionalString(answers: Answers, id: string, fallback: string): string {
  const value = answers[id];
  return value === undefined ? fallback : String(value).trim();
}

/** Answers → the shared context every fragment resolves from. Throws on a missing/invalid appName. */
export function resolveSharedContext(answers: Answers): WebAppSharedContext {
  const rawAppName = answers['appName'];
  if (rawAppName === undefined) {
    throw new Error('web-app: missing required answer "appName"');
  }
  const appName = String(rawAppName).trim();
  const verdict = toValidate(appNameSchema)(appName);
  if (verdict !== true) throw new Error(`web-app: invalid appName: ${verdict}`);

  return {
    appName,
    description: optionalString(answers, 'description', DEFAULT_DESCRIPTION),
    author: optionalString(answers, 'author', DEFAULT_AUTHOR),
    packageName: toPackageName(appName),
  };
}

/**
 * Escapes the five characters that matter for free text placed inside an
 * HTML text node or a double-quoted attribute (`&` first, so it never
 * double-escapes the entities it just produced).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every web-app flavor's question namespace starts with this one, verbatim. */
export const sharedQuestions: QuestionDefinition[] = [
  {
    id: 'appName',
    message: 'Application name',
    type: 'input',
    default: DEFAULT_APP_NAME,
    validate: toValidate(appNameSchema),
  },
  {
    id: 'description',
    message: 'Short description',
    type: 'input',
    default: DEFAULT_DESCRIPTION,
    validate: toValidate(descriptionSchema),
  },
  {
    id: 'author',
    message: 'Author (optional, used for package.json and an MIT LICENSE)',
    type: 'input',
    default: DEFAULT_AUTHOR,
    validate: toValidate(authorSchema),
  },
];
