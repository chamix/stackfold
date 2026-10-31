# stackfold

Stack-agnostic scaffolding CLI with a plugin-based generator system.

## Installation

```bash
npm install -g stackfold
```

Or run it without installing, via `npx`:

```bash
npx stackfold init electron-ts ./my-app
```

Requires Node.js **22+**.

## Quick start

```bash
stackfold list                     # see every available plugin
stackfold info electron-ts         # inspect one plugin's questions/help
stackfold init electron-ts ./my-app
```

## Why

Built to stop re-solving the same app shell from scratch for each new
personal project (starting from the `md-view` / `md-presenter` lineage
for `electron-ts`), but designed stack-agnostic from day one: the CLI
core doesn't know about Electron, React, Vue, or plain HTML — each lives
entirely in its own plugin. Adding support for another stack later means
writing another plugin, not touching the core.

## Built-in plugins

Run `stackfold list` for the live, authoritative list. As of this
release:

- **`electron-ts`** — Electron + TypeScript desktop app shell (sandboxed
  windows, external-link policy, narrow preload bridge), with optional
  Settings (Dark Mode), Skins, and About/Help features. Hand-written,
  via the `questions()`/`buildBlueprint()` plugin contract.
- **`electron-stackfold`** — functionally identical to `electron-ts`,
  authored declaratively via the scaffold-authoring system (see below).
  Kept side by side with `electron-ts` indefinitely; `stackfold` itself
  is init-only, so there's no forced migration for either.
- **`web-app-stackfold`** — a web app: a single, dependency-free
  standalone HTML file, or a Vite-powered SPA in React, Vue, or plain
  vanilla TS. One `appType` question replaces what used to be two
  separate plugins (`web-app-spa` and `web-app-standalone-html`, removed
  in this release — see [CHANGELOG](./CHANGELOG.md)).
- **`plugin-builder`** — scaffolds a brand-new stackfold plugin (as a TS
  `scaffold.ts` + synth) and registers it into stackfold's own plugin
  registry. Meant to be run from a checkout of this repo.

Beyond the built-ins, you can register your own plugins without
touching stackfold's source — see
[External plugins](#external-plugins) below.

## Usage

### `stackfold init [stack] [directory]`

Scaffolds a new project from a plugin into `directory` (created if
missing; must otherwise be empty, unless `--force` is given — existing
files are still never overwritten).

```bash
stackfold init electron-ts ./my-app
```

By default, `init` asks its questions interactively and, on success,
offers to open the generated project (folder, or its main file when the
plugin declares one) with your OS's default handler. Use `--no-open` to
skip that prompt.

It also runs **non-interactively**, for scripts and CI:

```bash
stackfold init electron-ts ./out --config config.json
stackfold init electron-ts ./out --answer appName="CI Smoke Test" --answer includeSettings=false
```

- `--config <path>` loads answers from a json/yaml/js file (via
  [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)).
- `--answer key=value` sets one answer directly; repeatable.
  `"true"`/`"false"` become booleans, everything else stays a string.
- `--answer` wins over `--config` on a shared key. Giving neither flag
  keeps the normal interactive prompts.

### `stackfold list` / `stackfold info <stack>`

```bash
stackfold list              # every available plugin (built-in + registered)
stackfold info electron-ts  # one plugin's description, prerequisites, questions
```

A plugin's richer help (display name, details prose) is optional in the
plugin contract — both commands work the same with or without it,
falling back to the plugin's id and its mandatory one-line description.

### `stackfold scaffold synth <dir>`

Compiles a TS-authored scaffold module (`scaffold.ts`, plus any sibling
`.hbs` template files) into the canonical `scaffold.json` that stackfold
actually loads at runtime. This is the tool plugin authors run — see
[Writing a plugin](#writing-a-plugin) below.

## External plugins

Register a plugin stackfold doesn't ship with, without editing
stackfold's own source:

```bash
stackfold plugin register ./path/to/scaffold.json      # or scaffold.js
stackfold plugin register some-npm-package              # an installed npm package
stackfold plugin register ./path/to/scaffold.json --project  # project-level instead of global

stackfold plugin list                                    # see what's registered, and its resolution status
stackfold plugin unregister <id>                         # remove a registration
```

Registration validates the source before writing anything (shape-check
plus a real smoke test — `questions()`/`buildBlueprint()` invoked with
synthesized answers) and records the plugin's *real* id, never a
user-chosen label. A `.ts`/`.tsx` source is rejected outright — run
`stackfold scaffold synth <dir>` first.

Config lives at two levels, both resolved via cosmiconfig:

- **Global** — `~/.stackfoldrc.json`, available in every project.
- **Project** — the nearest config file found searching upward from the
  current directory; wins over the global config on a same-id
  collision.

A built-in plugin always wins an id collision against an external one.
A broken external entry (deleted file, uninstalled package, failed
validation) is skipped with a warning rather than breaking `list`/`init`
for everyone else.

## Writing a plugin

The recommended path is `plugin-builder`:

```bash
stackfold init plugin-builder   # from a checkout of this repo
```

It scaffolds a new plugin under `src/plugins/<id>/` as a TS
`scaffold.ts` plus sibling `.hbs` templates, synthesizes its canonical
`scaffold.json` via a real `stackfold scaffold synth` call, and
registers it into `src/cli/index.ts`.

Under the hood, a scaffold author describes a plugin declaratively:
`questions` (optionally with `when` conditions and `deriveAnswer` steps
that compute an answer from others — e.g. slugify a name), an ordered
list of `ActionStep`s (`mkdir`, `writeFile`, `runCommand`,
`runHookCommand`, `npmInstall`, `gitInit`, plus any `registerAction()`
extension), and optional lifecycle hooks (`preInit`, `postWrite`,
`postInit`). File content in `writeFile` is templated with
[Handlebars](https://github.com/handlebars-lang/handlebars.js) — never
`eval`. Reusable pieces ("fragments") can be mounted into a scaffold via
`mountFragment()`/`composeFragments()`, each namespaced
Terraform-module-style so two fragments never collide on a question id.

This authoring system is how 3 of the 4 built-in plugins
(`electron-stackfold`, `web-app-stackfold`, `plugin-builder`) are built
today; `electron-ts` remains hand-written as a comparison/reference
implementation, with no forced migration. The full design rationale
lives in this project's governance ADRs (SK-ADR-002/003/005 — tracked
outside this public repo; see the [CHANGELOG](./CHANGELOG.md) for a
plain-language summary of each change).

## Architecture

Clean-architecture-ish layering, dependencies point inward:

```
src/
  core/       domain types + pure orchestration logic (no I/O):
              types, orchestrator, the declarative scaffold-authoring
              compiler (authoring.ts), validation
  plugins/    one folder per built-in stack (electron-ts,
              electron-stackfold, web-app-stackfold, plugin-builder),
              each implementing the plugin contract
  infra/      adapters: file system, git/process execution (execa),
              prompts (@inquirer), the composite + dynamic plugin
              registries, expression evaluation (json-logic-js)
  cli/        composition root — commander wiring, entry point
```

`core/` has zero dependencies on `infra/` or `plugins/`; it only depends
on its own types. `cli/` is the only layer allowed to wire concrete
adapters into the orchestrator.

Four ports define the boundary between `core/` and `infra/`:
`Prompter`, `FileWriter`, `ProcessRunner`, and `ExpressionEvaluator`
(a restricted, non-Turing-complete [json-logic-js](https://github.com/jwadhams/json-logic-js)
expression, never an `eval`). Plugin *resolution* goes through a fourth
port, `PluginRegistry` — asynchronous as of this release, so that
registering an external plugin never has to eagerly load every other
registered plugin, only the one actually requested.

## Stack

- [commander](https://github.com/tj/commander.js) — CLI framework
- [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js) — interactive prompts
- [execa](https://github.com/sindresorhus/execa) — process execution
- [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — plugin/config discovery
- [zod](https://github.com/colinhacks/zod) — validation
- [handlebars](https://github.com/handlebars-lang/handlebars.js) — file content templating in the scaffold-authoring system
- [json-logic-js](https://github.com/jwadhams/json-logic-js) — expression evaluation behind the `ExpressionEvaluator` port
- [picocolors](https://github.com/alexeyraspopov/picocolors) — terminal color (zero deps, chosen over `chalk` after the September 2025 npm supply-chain compromise)
- TypeScript **6.x** (deliberately not 7's native compiler yet —
  `typescript-eslint` support isn't there for it as of this writing)

## Development

```bash
npm install
npm run dev -- init electron-ts ./tmp/out     # run the CLI without building
npm run dev -- list
npm run build                                  # tsc -> dist/, then copies .hbs templates
npm test                                       # vitest
npm run test:coverage
npm run typecheck                              # tsc --noEmit
```

## License

MIT — see [LICENSE](./LICENSE).
