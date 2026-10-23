/**
 * Shared, pure string-derivation helpers (Task 036,
 * .agents/specs/arch-001-task036-derived-answers.md §Step 1 item 3).
 *
 * Originally lived inside `plugins/electron-ts/templates.ts` as that
 * plugin's own private helpers; moved here, verbatim in behavior (save for
 * `toBridgeGlobal`'s now-explicit `suffix`), so a second plugin (and the new
 * `deriveAnswer` hook action in `core/authoring.ts`) can reuse the exact
 * same derivation instead of re-implementing it. Pure data in, data out — no
 * I/O, no `answers` dependency, no clock reads — so it sits comfortably in
 * `core/` under the Inward Dependency Rule (`core/authoring.ts`'s own header
 * comment): depends only on `core/validation.ts` for the shared
 * `MAX_PACKAGE_NAME_LENGTH` constant.
 */
import { MAX_PACKAGE_NAME_LENGTH } from './validation.js';

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

/**
 * camelCases the package name into a valid JS identifier and appends the
 * given `suffix`: `toBridgeGlobal('my-cool-app', 'Api')` → `myCoolAppApi`.
 * The spec's `-([a-z])` rule is widened to `-([a-z0-9])` so a digit after a
 * hyphen (`app-2x`) can't leave a '-' behind, and a leading digit
 * (`3d-viewer`) gets an `app` prefix, since identifiers can't start with one.
 *
 * `suffix` is required, not defaulted, by design: a fixed, explicit suffix
 * is load-bearing, not cosmetic — plausible app names (e.g. "History",
 * "Crypto", "Performance", "Origin") camelCase to names that already exist
 * on `window` (`history`, `crypto`, …), and APIs like
 * `contextBridge.exposeInMainWorld` are expected to throw when asked to bind
 * over an existing window property. A fixed suffix rules this out for every
 * input, which is cheaper to keep correct than a denylist that would need
 * maintaining against future browser globals. Requiring the caller to pass
 * it explicitly (rather than defaulting to `'Api'` here) keeps that choice
 * where it's actually made — by each caller, per its own `window` surface —
 * instead of silently baking one caller's convention into the shared helper.
 */
export function toBridgeGlobal(packageName: string, suffix: string): string {
  const camel = packageName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const identifier = /^[0-9]/.test(camel) ? `app${camel}` : camel;
  return `${identifier}${suffix}`;
}
