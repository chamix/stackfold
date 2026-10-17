# stackfold

Stack-agnostic scaffolding CLI with a plugin-based generator system.

## Status

Three plugins implemented and tested:

- **`electron-ts`** — Electron + TypeScript desktop app shell (sandboxed
  windows, external-link policy, narrow preload bridge), with optional
  Settings (Dark Mode), Skins, and About/Help features.
- **`web-app-spa`** — client-side app (React, Vue, or vanilla + Vite)
  that calls APIs over fetch; no SSR.
- **`web-app-standalone-html`** — a single, dependency-free HTML file —
  no server, no network call after the initial load.

## Why

Built to stop re-solving the same app shell from scratch for each new
personal project (starting from the `md-view` / `md-presenter` lineage
for `electron-ts`), but designed stack-agnostic from day one: the CLI
core doesn't know about Electron, React, Vue, or plain HTML — each lives
entirely in its own plugin. Adding support for another stack later means
writing another plugin, not touching the core.

## Architecture

Clean-architecture-ish layering, dependencies point inward:

```
src/
  core/       domain types + pure orchestration logic (no I/O)
  plugins/    one folder per supported stack, each implementing the
              plugin contract (electron-ts, web-app-spa,
              web-app-standalone-html)
  infra/      adapters: file system, git (execa), prompts (@inquirer),
              plugin discovery (cosmiconfig)
  cli/        composition root — commander wiring, entry point
```

`core/` has zero dependencies on `infra/` or `plugins/`; it only depends
on its own types. `cli/` is the only layer allowed to wire concrete
adapters into the orchestrator.

## Stack

- [commander](https://github.com/tj/commander.js) — CLI framework
- [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js) — interactive prompts
- [execa](https://github.com/sindresorhus/execa) — process execution
- [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — plugin/config discovery
- [zod](https://github.com/colinhacks/zod) — validation
- TypeScript **6.x** (deliberately not 7's native compiler yet —
  `typescript-eslint` support isn't there for it as of this writing)

## Development

```bash
npm install
npm run dev -- init electron-ts   # run the CLI without building
npm run dev -- init web-app-spa
npm run dev -- init web-app-standalone-html
npm run build                     # tsc -> dist/
npm test                          # vitest
npm run typecheck                 # tsc --noEmit
```

`init` also runs non-interactively via `--config <path>` (answers loaded
from a json/yaml/js file through cosmiconfig) and/or repeatable
`--answer key=value` flags (`--answer` wins over `--config` on a shared
key; neither flag given keeps the normal interactive prompts):

```bash
stackfold init electron-ts ./out --config config.json
stackfold init electron-ts ./out --answer appName="CI Smoke Test" --answer includeSettings=false
```

## License

MIT — see [LICENSE](./LICENSE).
