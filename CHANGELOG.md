# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`stackfold init`**: `description` and `author` now go through structural
  validation (zod-based, same as `appName`) and reject control characters,
  embedded newlines, and overlong input — previously these two fields
  accepted anything. A narrow, security-motivated tightening (SEC-001b);
  legitimate free text (apostrophes, accented names, emoji) is unaffected.

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
