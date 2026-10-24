# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

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
