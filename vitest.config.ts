import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Vitest 5's own default `exclude` dropped `**/dist/**` (now just
     * `node_modules` + `.git` — confirmed against the installed
     * `vitest@5.0.2` source, `node_modules/vitest/dist/chunks/defaults.*.js`).
     * Without this, any local `npm run build` leaves compiled
     * `dist/plugins/*/scaffold.test.js` files that Vitest's default
     * include glob picks up and runs as real suites — and they always
     * fail, since `tsc` (the `build` script) never copies the `.hbs`
     * templates `loadTemplate()` needs alongside the compiled JS.
     * Root-caused 2026-10-25 (Task 045) after a real `npm run build &&
     * npm run test` run surfaced 3 failing "suites" under `dist/` with
     * `loadTemplate: template file not found` — not a flake, fully
     * reproducible whenever `dist/` exists locally. Likely also the
     * real root cause of the Task 044 review's reported Vitest-worker
     * instability (a `dist/` build at some point in that session, then
     * 33 parallel workers repeatedly hitting the same import-time crash).
     */
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
  },
});
