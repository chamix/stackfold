# stackfold

Stack-agnostic scaffolding CLI with a plugin-based generator system.

## Status

Early scaffold. The CLI runs end-to-end (`stackfold init <stack>`) but no
plugin is implemented yet — `init` reports "not implemented" for every
stack, on purpose, so the wiring can be proven before any real generator
logic lands.

## Why

Built to stop re-solving the same Electron+TypeScript app shell from
scratch for each new personal project (starting from the `md-view` /
`md-presenter` lineage), but designed stack-agnostic from day one: the
CLI core doesn't know about Electron — that lives entirely in the
`electron-ts` plugin. Adding support for another stack later means
writing another plugin, not touching the core.

## Architecture

Clean-architecture-ish layering, dependencies point inward:

```
src/
  core/       domain types + pure orchestration logic (no I/O)
  plugins/    one folder per supported stack, each implementing the
              plugin contract (electron-ts is the first)
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
npm run build                     # tsc -> dist/
npm test                          # vitest
npm run typecheck                 # tsc --noEmit
```

## License

MIT — see [LICENSE](./LICENSE).
