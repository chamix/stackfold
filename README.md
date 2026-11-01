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
today. `electron-ts` remains hand-written on purpose: it's the
reference implementation the declarative system is checked against, so
if the declarative approach can't express something `electron-ts` does
by hand, that's a signal the authoring system still has a gap to
close. Both are kept side by side indefinitely — see
[Built-in plugins](#built-in-plugins) above — and `stackfold` itself is
init-only, so neither needs to migrate to the other. See the
[CHANGELOG](./CHANGELOG.md) for how this evolved release by release.

## Authoring a plugin without a repo checkout

The `plugin-builder` path above is the recommended way to author a plugin,
but it **requires a checkout of this repository** — it shells out to `npx
tsx src/cli/index.ts scaffold synth <dir>`, a file that only exists inside
`stackfold`'s own source tree, not in anything `npm install stackfold`
gives you.

If you installed `stackfold` from npm and have no repo checkout, the path
below is how you actually author a plugin: hand-write a `scaffold.json`
against the schema documented here, then run `stackfold plugin register`.
This is not a workaround — it's the same file `plugin-builder`/`scaffold
synth` produce for you, and it's fully supported by `stackfold plugin
register`/`list`/`info`/`init`. You're just skipping the TS-authoring
step and writing the compiled artifact directly.

### The `ScaffoldDefinition` shape

A `scaffold.json` is one JSON object with these top-level fields:

| Field         | Type                              | Required | Notes |
|---------------|------------------------------------|----------|-------|
| `id`          | `string`                           | yes      | The plugin's real id — what `stackfold list`/`init <id>` use. |
| `description` | `string`                           | yes      | One-line description shown in `stackfold list`. |
| `help`        | `{ name?: string, details?: string }` | no   | Richer `stackfold info` output. `name` falls back to `id`; `details` is only shown when present. |
| `questions`   | `QuestionDefinition[]`             | yes (may be `[]`) | Prompts asked by `stackfold init`. |
| `steps`       | `ActionStep[]`                     | yes (may be `[]`) | The ordered list of file-writing/process actions that build the project. |
| `hooks`       | `{ preInit?, postWrite?, postInit?: ActionStep[] }` | no | Lifecycle actions — see "Hook-only actions" below. |
| `mainFile`    | `string` \| JSON Logic expression  | no       | Relative path (from the generated project root) `stackfold init` offers to open on success. |

#### `QuestionDefinition`

```ts
{
  id: string;            // the key this answer is stored under
  message: string;       // prompt text
  type: "input" | "confirm" | "select";
  choices?: string[];    // required when type === "select"
  default?: string | boolean | number;
}
```

> **Note:** the plugin contract also supports a `validate` function on a
> question, but a function has no JSON representation — it's only
> available to a plugin authored as TypeScript (`scaffold.ts` via
> `plugin-builder`/`scaffold synth`), never to a hand-written
> `scaffold.json`.

#### `ActionStep`

Every entry in `steps`, and every entry inside `hooks.<lifecycle>`, has
this shape:

```ts
{
  action: string;    // one of the built-in action names below
  params: object;    // shape depends on the action — see "Built-in actions"
  when?: boolean | JsonLogicExpression; // optional guard, evaluated against answers
}
```

`when` is evaluated against the collected `answers` before the step runs;
if it evaluates falsy, the step is skipped entirely (its `params` are
never even parsed). Omit `when` for a step that should always run.

### Expressions inside `params`

Most fields inside `params` may be either a literal value or a [JSON
Logic](https://jsonlogic.com/) expression evaluated against `answers` —
for example `{ "var": "appName" }` to read an answer, or `{ "cat": [{
"var": "pluginId" }, "/README.md"] }` to build a path from one. A few
specific fields are always treated as literal, author-written text and
are never expression-resolved (documented per-action below) — this is
deliberate, so a mutation target (a file path, a patch anchor) can never
be redirected by end-user input.

### Built-in actions

Actions come in two kinds: **compose/process** actions, which may only
appear in `steps`, and **hook** actions, which may only appear inside
`hooks` (see the next section). Putting a hook action in `steps`, or a
compose/process action under `hooks`, is a validation error.

| Action | Kind | Where | `params` |
|---|---|---|---|
| `mkdir` | compose | `steps` | `{ path: string }` |
| `writeFile` | compose | `steps` | `{ path: string, content: string, strategy?: "exclusive" \| "json-merge" \| "append", jsonEscapeKeys?: string[], jsEscapeKeys?: string[], htmlEscapeKeys?: string[], scriptCloseEscapeKeys?: string[] }` |
| `runCommand` | process | `steps` | `{ command: string, args?: string[] }` |
| `npmInstall` | process | `steps` | `{}` (no params) |
| `gitInit` | process | `steps` | `{}` (no params) |
| `patchFile` | hook | `hooks` only | `{ path: string, anchor: string, insert: string, position: "before" \| "after" }` |
| `deriveAnswer` | hook | `hooks` only | `{ from: string, to: string, transform: "npm-slug" \| "js-identifier-suffix" \| "current-year", suffix?: string }` |
| `runHookCommand` | hook | `hooks` only | `{ command: string, args?: string[] }` |

Details and literal-field exceptions, per action:

- **`mkdir`** — creates an (otherwise empty) directory at `path`, relative
  to the generated project root.
- **`writeFile`** — writes `content` to `path`, relative to the project
  root. `content` is rendered as a [Handlebars](https://handlebarsjs.com/)
  template against the answers (e.g. `{{appName}}`) — **`content` itself
  is always a literal string, never expression-resolved** (it's the
  Handlebars template source, not a value to compute). `strategy`
  controls what happens if another step already wrote the same `path`
  (default is effectively `"exclusive"` — a collision is an error).
  `jsonEscapeKeys`/`jsEscapeKeys`/`htmlEscapeKeys`/`scriptCloseEscapeKeys`
  each name a list of **answer keys** (not file paths) whose string value
  gets escaped for a JSON-string / single-quoted-JS-string / HTML / Vue
  SFC `</script>`-safe position before the template renders — use these
  whenever a free-text answer lands inside a position where its literal
  text could otherwise break the generated file. These four list fields
  are also always literal (never expression-resolved).
- **`runCommand`** — runs `command` with `args` as a post-action, with
  `cwd` set to the generated project's own directory.
- **`npmInstall`** / **`gitInit`** — run `npm install` / `git init` as a
  post-action in the generated project directory. Take no params.
- **`patchFile`** *(hook only)* — inserts `insert` immediately
  before/after the line containing `anchor` in the existing file at
  `path`. Idempotent (running it again when `insert` is already present
  is a no-op). **`path` is resolved relative to the real process's
  current working directory, not the generated project's `targetDir`**,
  and **`anchor`/`path` are always literal** — this action exists to
  patch a file that already exists outside the generated project (e.g.
  registering a new plugin into a CLI's own source), which is why it's a
  hook rather than a `steps` action.
- **`deriveAnswer`** *(hook only)* — computes `answers[to]` from
  `answers[from]` via a fixed transform: `npm-slug` (npm-package-name-safe
  slug), `js-identifier-suffix` (a valid JS identifier; `suffix` is
  **required** for this transform and appended to disambiguate from real
  globals), or `current-year` (ignores `from`, writes the current year).
  `from`/`to`/`transform`/`suffix` are always literal.
- **`runHookCommand`** *(hook only)* — runs `command`/`args` with no
  `cwd` override (inherits the real invoking process's cwd) — unlike
  `runCommand`, which always runs inside the generated project.

### Hook-only actions and `hooks`

`hooks` is optional and, when present, keys its actions by lifecycle
moment:

```ts
{
  preInit?: ActionStep[];   // after answers are collected, before files are built
  postWrite?: ActionStep[]; // after files are written, before post-actions run
  postInit?: ActionStep[];  // after post-actions have run
}
```

Only `patchFile`, `deriveAnswer`, and `runHookCommand` may appear here
(or any action registered elsewhere as a `"hook"` kind) — never
`mkdir`/`writeFile`/`runCommand`/`npmInstall`/`gitInit`.

### A complete, minimal example

Save this as `scaffold.json` and register it directly — no build step,
no repo checkout required:

```json
{
  "id": "hello-world",
  "description": "A minimal example plugin: a package.json and a README.",
  "questions": [
    {
      "id": "projectName",
      "message": "Project name",
      "type": "input",
      "default": "my-app"
    }
  ],
  "steps": [
    {
      "action": "writeFile",
      "params": {
        "path": "package.json",
        "content": "{\n  \"name\": \"{{projectName}}\",\n  \"version\": \"0.1.0\"\n}\n",
        "jsonEscapeKeys": ["projectName"]
      }
    },
    {
      "action": "writeFile",
      "params": {
        "path": "README.md",
        "content": "# {{projectName}}\n\nGenerated by the hello-world stackfold plugin.\n"
      }
    },
    {
      "action": "gitInit",
      "params": {}
    }
  ]
}
```

```bash
stackfold plugin register ./scaffold.json
stackfold list                     # "hello-world" now shows up
stackfold info hello-world
stackfold init hello-world ./my-app
```

> **⚠️ `stackfold scaffold synth <dir>` writes relative to your current
> working directory, not `<dir>`.** If you *do* have a repo checkout and
> author a plugin as TypeScript (`scaffold.ts`), running `stackfold
> scaffold synth <dir>` does **not** write the output next to `<dir>`. It
> always writes to `<cwd>/src/plugins/<id>/scaffold.json`, where `<cwd>`
> is the directory you ran the command *from* and `<id>` is the `id`
> declared inside `scaffold.ts` — regardless of what `<dir>` you passed.
> Run `synth` from the location whose `src/plugins/<id>/` you actually
> want written to, not from inside `<dir>` itself.

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
