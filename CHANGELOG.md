# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-31

### Added

- **External plugin registration** (Task 049, ARCH-002/SK-ADR-005):
  `stackfold plugin register <source> [--project]` / `unregister <id>
  [--project]` / `list` — register a local `scaffold.json`/`scaffold.js`,
  or an installed npm package, without touching `stackfold`'s own source.
  `PluginRegistry` (`core/ports.ts`) is now async
  (`resolve()`/`list()` return `Promise`s) — the first change to `core/`
  since ARCH-001 — enabling a genuinely lazy `DynamicPluginRegistry`
  (`infra/dynamicPluginRegistry.ts`): `stackfold init <id>` only ever
  imports the one external plugin it was asked for, never any other
  registered one. Config lives at two cosmiconfig-based levels — global
  (`~/.stackfoldrc.json`) and project (upward `cosmiconfig.search()`),
  project wins on a same-id collision. A new `CompositePluginRegistry`
  (`infra/compositePluginRegistry.ts`) composes the existing
  `StaticPluginRegistry` (built-ins) with the new dynamic one: a built-in
  always wins an id collision against an external plugin (silently in
  `resolve()`, with a stderr warning in `list()`), and a broken external
  entry (deleted file, uninstalled package, failed smoke test) is omitted
  with a warning rather than breaking `list`/`init` for everyone else.
  `register` runs the same shape-check + smoke-test validation
  (`compileScaffold()` + a `questions()`/`buildBlueprint()` dry run with
  synthesized answers) before writing anything, and records the plugin's
  own real id — never a user-chosen label. A `.ts`/`.tsx` source is
  rejected outright ("run `stackfold scaffold synth <dir>` first" —
  SK-ADR-003: TS stays authoring-time only). `cli/index.ts`'s composition
  root now wires `CompositePluginRegistry` into `init`/`list`/`info`
  instead of the raw `StaticPluginRegistry`; no new production
  dependency (`cosmiconfig` was already one, under its own
  `'stackfold-plugins'` namespace, distinct from `init.ts`'s unrelated
  `'stackfold'`-namespaced `--config` usage).
- **Post-`init` "open the project" prompt** (Task 044, UX-001): after a
  successful, interactive `stackfold init`, a new `select` prompt offers
  "Open folder" / "Open main file" (only when the plugin declares one) /
  "Don't open". Opens via a 3-platform native command switch
  (`explorer`/`open`/`xdg-open`, `src/infra/open.ts`'s new `NativeOpener`,
  via `execa`, never `shell: true`) — never a hardcoded editor. The prompt
  is skipped entirely in any of 3 cases: `--no-open`, non-interactive
  `init` (`--config`/`--answer`), or non-TTY stdout.
- **`ProjectBlueprint.mainFile?: string`** (Task 044, SK-ADR-004):
  additive field, resolved by each plugin inside its own
  `buildBlueprint(answers)` — not static plugin metadata, since
  `web-app-stackfold`'s entry point varies by its `appType` answer.
  Declarative scaffolds (`ScaffoldDefinition.mainFile`) resolve it via the
  same literal-or-JSONLogic contract `ActionStep.when` already
  established. `electron-stackfold` declares the fixed
  `'src/main/index.ts'`; `web-app-stackfold` resolves it per `appType`
  (`index.html` / `src/main.tsx` / `src/main.ts`); `plugin-builder`
  deliberately declares none. `core/orchestrator.ts`'s `ScaffoldResult`
  carries it through so the CLI layer can see it.
- **`electron-stackfold` reauthored as a TS `scaffold.ts` + synth** (Task
  043, SK-ADR-003): same mechanical port pattern as `plugin-builder`
  (Task 042), but simpler — none of its 6 questions carry `validate`
  closures or dynamic defaults, so `src/cli/index.ts` keeps loading its
  compiled `scaffold.json` unchanged. 40 sibling `.hbs` templates replace
  the old inline Handlebars `content` strings; the regenerated
  `scaffold.json` is byte-identical to the hand-written original
  (confirmed via `git diff`), and the plugin's real generated output is
  byte-identical to `main` for both the minimal- and maximal-flags cases.
- **`web-app-stackfold` — merges `web-app-spa` + `web-app-standalone-html`
  into one plugin** (Task 043, SK-ADR-003): the old two-plugin,
  TS-`switch`-dispatched flavor/framework model is replaced by a single
  `appType` select (`standalone-html`/`spa-react`/`spa-vue`/`spa-vanilla`)
  gating 7 fragments ported via `mountFragment()`/`composeFragments()`
  (Task 041) with `ActionStep.when` — the first use of that combination
  in this codebase. `src/cli/index.ts` registers it by compiling
  `scaffold.js` directly (not `scaffold.json`), same reason as
  `plugin-builder`: its `appName`/`description`/`author` questions carry
  real `validate` closures. Generated output is byte-identical to the two
  old plugins' across all 4 `appType` values, independently reconfirmed
  by review via a `git worktree` of `main`.
- **`htmlEscapeKeys` / `scriptCloseEscapeKeys` — new `writeFile` escape
  mechanisms** (Task 043, `core/authoring.ts`): mirror the existing
  `jsonEscapeKeys`/`jsEscapeKeys` pattern (Task 034/042). Added because
  porting `web-app`'s `standalone-html` and `vite-vue` fragments to the
  DSL (whose `compileTemplate()` runs Handlebars with `noEscape: true`)
  would otherwise have silently dropped two real, previously-fixed
  defenses: `escapeHtml()`'s HTML-entity escaping (closing a Task-014 XSS
  finding) and `escapeScriptClose()`'s SFC-parser guard (preventing a
  crafted `appName` from breaking out of a Vue `<script setup>` block via
  a `</script` substring). Both proven with real adversarial payloads —
  the latter via a real `@vue/compiler-sfc` parse plus an `eval()`
  round-trip, not just a string check.
- **`runHookCommand` — a `tag:'hook'` counterpart to `runCommand`** (Task
  042, D-B — .agents/specs/042-plugin-builder-ts-authoring.md): runs an
  external command via `ports.processRunner.run()` with the real invoking
  process's cwd, never `targetDir` — the structural gap `runCommand`
  (always run with `cwd: targetDir`, `core/orchestrator.ts`) can't fill
  for a scaffold whose own `targetDir` isn't the directory it needs to
  invoke a sibling command against. Same params shape as `runCommand`
  (`command`, `args`), no `cwd` field at all (deliberate: not
  configurable, so "never targetDir" is structural, not an option an
  author could pass wrong), `literalKeys: []` (unlike `patchFile`/
  `deriveAnswer`: neither field controls where a mutation lands, so
  `args` may legitimately be computed from answers).
- **`plugin-builder` v2 — reauthored as a TS `scaffold.ts` + synth** (Task
  042, SK-ADR-003): `src/plugins/plugin-builder/index.ts` (a TS factory
  function taking an injected `gitUserName`) is gone, replaced by
  `src/plugins/plugin-builder/scaffold.ts` (authored via
  `defineScaffold()`/`loadTemplate()`/`step()`, `src/authoring/builder.ts`),
  3 sibling `.hbs` templates, and a committed `scaffold.json` produced by a
  real `stackfold scaffold synth` run (never hand-written). Unlike
  `electron-stackfold`, `src/cli/index.ts` registers plugin-builder by
  compiling its `scaffold.js` module directly rather than importing
  `scaffold.json` — deliberate, not an oversight: `scaffold.ts`'s 4
  questions declare real `validate` closures, and JSON can't carry
  function values, so a JSON-compiled runtime path would silently drop
  every one of them (found by independent review, confirmed by direct
  reproduction, now covered by a regression test asserting the real
  `cli/index.ts` import specifier). `scaffold.json` stays committed as the
  synth-verified canonical artifact — it's just not what's loaded at
  runtime for this one plugin. The generated plugin it scaffolds is now
  TS-authored too — its own `scaffold.ts` + `templates/readme.md.hbs` +
  `scaffold.test.ts` (importing `./scaffold.js`, never `./scaffold.json` —
  proves the definition compiles without depending on `synth` having run),
  a `postInit` hook chain of (1) `runHookCommand` → `stackfold scaffold
  synth src/plugins/<pluginId>` against the repo root, (2)/(3) the same
  two `patchFile` insertions v1 already had, registering the new plugin
  into `src/cli/index.ts`. The order is the whole mechanism (no new
  error-handling code): `runHooks()`'s existing abort-on-throw
  (`core/orchestrator.ts`) means a failed synth — a malformed generated
  `scaffold.ts`, a broken template — never leaves `src/cli/index.ts`
  patched to import a `scaffold.json` that doesn't exist. The `author`
  question (both plugin-builder's own and the generated plugin's) now
  carries a plain, static `default: ''` — the same convention `web-app`/
  `electron-ts` already use — rather than v1's dynamic `git config
  user.name` lookup, which had no viable injection point once
  plugin-builder stopped compiling via a TS factory function (Task 042
  Open item 1). The generated plugin's own `scaffold.ts` now escapes
  `displayName`/`description` for safe interpolation into a TS string
  literal via a new `jsEscapeKeys` field on `writeFile` (mirroring the
  existing JSON-context `jsonEscapeKeys`, backed by a new
  `escapeForJsContext()` helper in `core/authoring.ts`) — a `displayName`/
  `description` containing a single quote (ordinary, schema-accepted free
  text) now produces valid, parseable TypeScript instead of a broken
  generated file (found by independent review, fixed, confirmed by direct
  reproduction against both the pre-fix and post-fix output).
- **`mountFragment()` — fragments namespaced** (Task 041, SK-ADR-003 Cycle
  2): a new `src/authoring/fragment.ts`, built with zero changes to
  `src/core/*.ts`. A `Fragment` (the same shape as a `ScaffoldDefinition`
  minus `id`/`description`/`help`) can be written once, with un-prefixed,
  fragment-local question ids, and mounted into a root scaffold (or
  another fragment) via `mountFragment(factory, props, { namespace,
  inputs? })`. Every internal reference — `writeFile`'s Handlebars
  `content` (regex-based, word-bounded rewrite) and every other
  non-`literalKeys` `params` field plus `when` (structural JSONLogic
  `{ var: ... }` walk, bounded by `resolveAction()`'s own `literalKeys`) —
  is rewritten to `${namespace}__${localId}` by default, or to an
  explicit, mount-site-supplied external id via `inputs` (never
  auto-detected by name). The real separator is `__`, not `.` — confirmed
  against real Handlebars/json-logic-js render output in Task 040's spike
  (`.agents/handoff-scaffold-synth-namespace-separator.md`): both engines
  give `.` a property-navigation meaning a flat `Answers` map doesn't
  intend. Namespace collisions are caught immediately at mount time by a
  module-level registry inside `mountFragment()` itself (`Set<string>`,
  with `resetFragmentNamespaceRegistry()` exported for test isolation) —
  not deferred to a later composition step. `composeFragments(...)` /
  `mergeHooks(a, b)` are a purely structural merge on top (concat
  `questions`/`steps`, concat `hooks` per `HookName` in declaration order
  — the same semantics `core/authoring.ts`'s `compileHooks()` already
  uses), with no collision logic of their own, since that is fully
  covered by `mountFragment()`'s registry. `mountFragment()` never writes
  to disk and never calls `compileScaffold()`/`synth()` itself — the
  flattened `Fragment`/`ScaffoldDefinition` still goes through Cycle 1's
  unchanged `synth()` pipeline. **Amendment to `src/authoring/synth.ts`**
  (independent of fragments, a residual gap found while designing the
  namespace registry): `scaffoldDefinitionSchema` gains a `.superRefine()`
  that fails with a specific message (`` questions[].id "X" appears more
  than once ``) whenever a `ScaffoldDefinition` declares a duplicate
  `questions[].id`, whatever produced it — a fragment bug or a
  hand-written duplicate, no fragments involved.
- **TS-authored scaffolds + `stackfold scaffold synth <dir>`** (Task 039,
  SK-ADR-003 Cycle 1): a new `src/authoring/` tooling layer, outside
  `core/` and built with zero changes to `core/authoring.ts`/`core/
  types.ts`/`core/ports.ts`. `src/authoring/builder.ts` adds small, typed,
  CDK-flavored builder functions (`defineScaffold()`, `file()`, `mkdir()`,
  `runCommand()`, `npmInstall()`, `gitInit()`, `step()`) that return plain
  data matching the existing `ScaffoldDefinition`/`ActionStep` shapes —
  `file()`, not `writeFile()`, to avoid reading as a re-implementation of
  the already-registered `writeFile` action. `src/authoring/
  templateLoader.ts` adds a shared `loadTemplate(baseDir, relativePath)`
  that reads a sibling `.hbs` file's raw content from disk, for inlining
  into a `file()` step's `content`. `src/authoring/synth.ts` adds the
  `synth()` pipeline: a new top-level zod schema structurally validates
  the given `ScaffoldDefinition` (no such schema existed before — only
  per-`ActionKind` schemas inside `compileScaffold()`), then a real smoke
  test calls `compileScaffold()` *and* the compiled plugin's
  `buildBlueprint()` (still pure, no disk I/O) with answers synthesized
  from each question's own default, so an unknown action name or bad step
  shape fails fast instead of only being caught much later. Only on
  success is the definition serialized to formatted JSON and written,
  write-to-temp-then-rename, to the canonical `src/plugins/<id>/
  scaffold.json` path — never a partial/invalid file on any failure.
  `src/cli/commands/scaffoldSynth.ts` wires this into a real `stackfold
  scaffold synth <dir>` subcommand, the one place allowed to load and run
  the author's own `scaffold.ts` module at command time, via `tsx`'s
  existing `tsImport()` API (already a devDependency — no new one added).
  Fragments/namespacing are explicitly out of scope for this cycle (Task
  041, SK-ADR-003 Cycle 2).
- **`dev` script for electron-ts / electron-stackfold** (Task 037): a new
  `scripts.dev` entry (`npm run build && electron .`) added to both plugin
  templates' generated `package.json` and documented in their generated
  `README.md`, letting a developer rebuild and launch the real Electron
  window with one command instead of invoking `electron` manually or
  running the full `package` installer flow for a quick manual check.
- **`plugin-builder` plugin** (Task 034): `stackfold init plugin-builder <dir>`
  scaffolds a brand-new stackfold plugin, authored in the declarative JSON
  `ScaffoldDefinition` format and compiled via `compileScaffold()` — the
  first real consumer of that authoring system outside unit tests — and
  registers the result into stackfold's own plugin registry by patching
  `src/cli/index.ts` at two one-time anchor markers.
- **`patchFile` hook action** (`core/authoring.ts`): a new, general-purpose,
  reusable `ScaffoldDefinition` hook action that idempotently inserts text
  immediately before/after a literal anchor line in an existing file,
  failing loudly (never guessing an insertion point) if the file or the
  anchor is missing. `insert` is expression-resolved against answers;
  `path`/`anchor` stay the scaffold author's own literal text.
- **Per-step `when` conditional** (`core/authoring.ts`, Task 035): a new,
  optional `ActionStep.when` field — a JSONLogic expression (or a literal
  boolean) evaluated against `answers` — gates whether a step runs at
  all, for both `steps` (compose/process) and `hooks` entries. A falsy
  `when` skips a compose/process step entirely (no
  `FileContribution`/`PostActionDefinition` added, and its params are
  never resolved/validated) or skips a hook step's handler entirely.
  Purely additive: absent `when` reproduces today's behavior exactly for
  every existing `ScaffoldDefinition`.
- **`FileWriter` port** (`core/ports.ts`, `infra/fs.ts`): two new methods,
  `readFile()` (returns `undefined` for a missing file) and
  `overwriteFile()` (unlike `writeFile`, overwrites an existing file) —
  used only by hook-level actions such as `patchFile`, never by the
  `compose`/`writeFile` path. `writeFile`'s own exclusive "never silently
  overwrite" semantics are unchanged.
- **`deriveAnswer` hook action** (`core/authoring.ts`, Task 036): a new
  `ScaffoldDefinition` hook action that computes a new `answers` entry from
  an existing one, via one of three closed transforms — `npm-slug`
  (`toPackageName()`), `js-identifier-suffix` (`toBridgeGlobal()` with an
  explicit, required `suffix`), and `current-year` (reads `Date.now()`
  directly, no injectable clock). `from`/`to`/`transform`/`suffix` are all
  `literalKeys`, same rationale as `patchFile`'s `path`/`anchor`: they are
  field names/mode selectors the scaffold author writes, never values
  computed from live answers. `toPackageName()`/`toBridgeGlobal()`
  themselves moved out of `plugins/electron-ts/templates.ts` into a new
  shared `core/stringTransforms.ts`, so both `deriveAnswer` and
  `electron-ts` reuse the same implementation; `toBridgeGlobal()`'s `Api`
  suffix is no longer hardcoded — every caller (including `electron-ts`'s
  own `resolveContext()`) now passes it explicitly, with zero behavior
  change for `electron-ts`.

### Changed

- **`stackfold init`**: `description` and `author` now go through structural
  validation (zod-based, same as `appName`) and reject control characters,
  embedded newlines, and overlong input — previously these two fields
  accepted anything. A narrow, security-motivated tightening (SEC-001b);
  legitimate free text (apostrophes, accented names, emoji) is unaffected.
- **`writeFile` hook action** (`core/authoring.ts`): new, optional
  `jsonEscapeKeys` param — names context (answers) keys whose string value
  gets JSON-string-escaped before `content` is Handlebars-rendered, for a
  scaffold author whose `content` places free text inside a JSON
  string-literal position. Purely additive; omitted (or empty) reproduces
  prior behavior exactly.
- **`defaultGitUserName()`** (the real `git config --get user.name` probe
  behind `plugin-builder`'s "author" default) moved from
  `plugins/plugin-builder/index.ts` to `infra/fs.ts`, and is now injected by
  `cli/index.ts` — the composition root, same as every other concrete
  adapter — rather than defaulted inside the plugin module.
- **`stackfold list` / `info`'s "Available stacks" listing** (`pluginHelp.ts`'s
  new `formatPluginListEntry()`): each plugin now prints as its own
  heading-plus-description block — the description word-wrapped and
  indented onto its own line(s), with a blank line between plugins —
  instead of one long, un-wrapped line that collided with the terminal's
  right edge. Internal governance references (`ARCH-001`, `SK-ADR-003`,
  `Task NNN`) were also dropped from every plugin's `description`/
  `help.details`: they're dev-lifecycle artifacts tracked in `.agents/`
  and on GitHub, with no value to someone just picking a stack.

### Removed

- **`web-app-spa` and `web-app-standalone-html` plugins** — merged into
  the single `web-app-stackfold` plugin (see Added, above). Running
  `stackfold init web-app-spa` or
  `stackfold init web-app-standalone-html` now fails with "unknown
  stack". **This is the sole reason this release is `2.0.0`** rather
  than a `1.x` minor — everything else in this release is additive or
  an internal fix. Migration:
  - `stackfold init web-app-standalone-html` →
    `stackfold init web-app-stackfold --answer appType=standalone-html`
  - `stackfold init web-app-spa` (React) →
    `stackfold init web-app-stackfold --answer appType=spa-react`
  - `stackfold init web-app-spa` (Vue) →
    `stackfold init web-app-stackfold --answer appType=spa-vue`
  - `stackfold init web-app-spa` (vanilla) →
    `stackfold init web-app-stackfold --answer appType=spa-vanilla`

### Fixed

- **`package.json`'s `main` field** pointed at
  `./dist/core/index.js`, a file that has never existed (there is no
  `core/index.ts`) — dropped. `stackfold` is consumed via its `bin`
  entry, never as a library import, so no replacement entry point is
  needed.
- **Stale build output in `dist/`**: `tsc` never cleans its own output
  directory, so compiled artifacts from the now-removed `web-app`
  plugin (and other deleted sources) were still being packed into the
  npm tarball. Cleaned before cutting this release.

- **`mountFragment()`'s rewrite engine** (Task 047) now also renames
  local-id references inside `writeFile`'s
  `jsonEscapeKeys`/`jsEscapeKeys`/`htmlEscapeKeys`/`scriptCloseEscapeKeys`
  and `deriveAnswer`'s `from`/`to`, matching every other local-id
  reference (Handlebars placeholders, JSONLogic `when`) that was already
  namespaced on mount. `deriveAnswer`'s `to` — which introduces a new
  fragment-local answers key, rather than referencing an existing
  question — is now namespaced too, and registered before the rewrite
  pass runs so any later `from`/escape-key/template reference to it
  resolves consistently, regardless of which step or hook group either
  side lives in. No shipped plugin combines `mountFragment()` with either
  field yet; this closes a latent gap for future fragment authors.
- **`deriveAnswer` hook action, `transform: 'js-identifier-suffix'`**
  (Task 046): `suffix` is now required and non-empty when this transform
  is used — a step that omitted it used to silently produce an
  identifier with no suffix at all, exactly the collision risk
  `toBridgeGlobal()` was written to avoid.
- **`deriveAnswer` hook action**: a `from` that names an `answers` key
  with no value (a typo, or a step-ordering mistake) now throws, instead
  of silently resolving to an empty string — matching the rest of the
  action vocabulary (`patchFile` throws on a missing file;
  `electron-ts` throws on a missing `appName`). Does not apply to
  `transform: 'current-year'`, which never reads `from`.
- **`plugin-builder`'s generated `scaffold.json`** could become
  syntactically invalid JSON when `displayName`/`description` contained a
  literal `"` (ordinary, schema-accepted free text) — the generated
  plugin's own `scaffold.test.ts` would then fail at import time. Both
  fields are now JSON-escaped (via `writeFile`'s new `jsonEscapeKeys`)
  before being interpolated into the manifest.
- **`patchFile` hook action**: `path` is now a `literalKeys` entry (never
  expression-resolved against answers), matching `anchor`'s existing
  protection — `patchFile` runs uncontained (no `targetDir` sandboxing,
  Invariant A), so an answers-derived `path` would have been an
  uncontained, answer-controlled overwrite target.
- **`resolveDefaultAuthor()`**'s blanket `catch {}` narrowed to only treat a
  thrown `Error` as "no local git identity available"; a thrown non-`Error`
  value now propagates instead of being silently swallowed.

## [1.0.0] - 2026-10-18

### Added

- **`electron-ts` plugin**: Electron + TypeScript project generator with an
  optional Tier-2 feature set (Settings, Skins, About/Help windows),
  non-interactive scaffolding via `--config`/`--answer` flags, and a CI
  workflow for generated projects.
- **`web-app-spa` plugin**: single-page-app generator supporting React, Vue,
  and vanilla JS/TS via composable blueprint fragments shared with
  `web-app-standalone-html`.
- **`web-app-standalone-html` plugin**: zero-build, dependency-free static
  HTML project generator.
- `stackfold list` and `stackfold info <stack>` commands, with optional
  per-plugin CLI help metadata (`PluginHelp`).
- Plugin contract built on a pure `questions()`/`buildBlueprint()` split with
  injected `Prompter`/`FileWriter`/`ProcessRunner` ports (hexagonal
  architecture) orchestrated via a Template Method.
- Multi-tier automated test suite per plugin, including Tier-5 checks that
  spawn the real built CLI binary and a real browser to verify the
  generated project actually launches.

### Fixed

- `stackfold list`/`init` showed a plugin's display name instead of its
  `id` in the "Available stacks" listing — only `id` is a valid argument
  to `init`.
- npm tarball was missing a `"files"` allowlist, which would have published
  internal governance artifacts (`.agents/`, `.claude/`, `CLAUDE.md`)
  alongside the package.

[1.0.0]: https://github.com/chamix/stackfold/releases/tag/v1.0.0
