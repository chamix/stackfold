import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Root cause (Task 045, 2026-10-25) of the 11 "flaky-looking" ANSI
     * mismatches in info/init/list/pluginHelp.test.ts, previously logged
     * in backlog.md with no confirmed cause: `picocolors` (the actual
     * color library, read from node_modules/picocolors/picocolors.js)
     * force-enables color whenever `process.platform === 'win32'`,
     * unconditionally -- it never checks `isTTY` or `CI` for that branch.
     * On Camilo's own Windows machine this is always true, so every run
     * there emits real ANSI escapes against assertions written as plain
     * strings. It is not flaky and never was: it is 100% deterministic
     * by platform, which is exactly why it never reproduced from a
     * non-Windows device-bridge session. `NO_COLOR` is the one env var
     * picocolors' own check actually honors unconditionally (`FORCE_COLOR
     * ` set to any non-empty string, including "0", reads as truthy in
     * its check and would make this worse, not better -- confirmed by
     * reading the source, not assumed). Setting it here, once, for every
     * test run on every platform, is more correct than patching each
     * assertion to strip ANSI: these are plain-string CLI-output
     * contract tests, and a test run should never depend on the ambient
     * terminal's real color-capability to be deterministic.
     */
    env: {
      NO_COLOR: '1',
    },
    /**
     * Vitest 5's own default `exclude` dropped the `dist` glob entirely
     * (now just `node_modules` and `.git` — confirmed against the
     * installed `vitest@5.0.2` source,
     * `node_modules/vitest/dist/chunks/defaults.*.js`). Older versions
     * excluded `dist` by default; this one no longer does.
     *
     * Without an explicit exclude here, any local `npm run build` leaves
     * compiled `scaffold.test.js` files under each plugin's `dist`
     * output directory, and Vitest's default include glob picks them up
     * and runs them as real suites. They always fail: `tsc` (the
     * `build` script) never copies the `.hbs` templates `loadTemplate()`
     * needs alongside the compiled JS.
     *
     * Root-caused 2026-10-25 (Task 045) after a real `npm run build`
     * followed by `npm run test` surfaced 3 failing "suites" with
     * `loadTemplate: template file not found` — not a flake, fully
     * reproducible whenever a `dist` build exists locally. Likely also
     * the real root cause of the Task 044 review's reported Vitest
     * worker instability (a `dist` build at some point in that session,
     * then many parallel workers repeatedly hitting the same
     * import-time crash).
     */
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    /**
     * Coverage tooling (backlog item deferred across Tasks 039 and 041,
     * resolved 2026-10-25, Task 045) and thresholds per claude-blueprints'
     * ADR-015 ("Minimum coverage threshold as a Pre-Delivery/Review
     * checkpoint"): lines/statements/functions >= 80%, branches >= 75%
     * -- the de-facto baseline ADR-015 cites, enforced here at the
     * tool-config level (non-zero exit on an unmet threshold) rather than
     * by manually parsing a percentage, so `full-stack-engineer.md`'s
     * Pre-Delivery run and `code-reviewer.md`'s independent verdict-gate
     * run (both `npm run test:coverage`) get a real, auditable signal.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'src/plugins/**/templates/**',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
