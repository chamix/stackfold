/**
 * `stackfold scaffold synth <dir>` (SK-ADR-003 Decision 2) — the one place
 * in the CLI allowed to load and *execute* a scaffold author's own
 * `scaffold.ts` module at command time, then hand the resulting in-memory
 * `ScaffoldDefinition` to `src/authoring/synth.ts`'s pipeline.
 *
 * `<dir>` is the directory containing the author's `scaffold.ts` (and any
 * sibling `.hbs` files it loads via `src/authoring/templateLoader.ts`).
 *
 * Module-loading mechanism: `tsx`'s existing programmatic API,
 * `tsImport()` (`tsx/esm/api`) — `tsx` is a runtime `dependency`
 * (`^4.23.15`; also used by this repo's own `"dev": "tsx
 * src/cli/index.ts"` script) so that `scaffold synth` keeps working for a
 * plain `npm install`'d consumer, not just inside this repo's own
 * `node_modules` (PKG-001, 2026-11-01). `tsImport` itself is imported
 * dynamically inside `loadScaffoldDefinition()` below rather than at this
 * module's top level, so that starting the CLI for any other command
 * (`list`, `info`, `init`, `plugin register`, etc.) never loads `tsx` at
 * all. `tsImport()` registers tsx's ESM loader hooks just long enough to
 * resolve+execute the one specifier it's given (including that module's
 * own further imports — e.g. a scaffold's `import { file } from
 * '../../authoring/builder.js'`), then returns the resolved module
 * namespace object.
 *
 * Export convention (this task's call, documented here since the spec left
 * it open): `scaffold.ts`'s default export (falling back to a named
 * `scaffold` export) may be either a `ScaffoldDefinition` object directly,
 * or a thunk — a zero-argument function (sync or async) returning one.
 * Supporting the thunk form lets an author defer any setup (e.g. resolving
 * `import.meta.dirname` before calling `loadTemplate()`) to call time
 * rather than module-evaluation time, without requiring it.
 *
 * Precondition (undocumented at the type level, but real): `<dir>` must
 * resolve under an ESM-`"type": "module"` package context — the same one
 * every other `.ts` file in this repository already lives under. Every
 * `src/plugins/<id>/` directory already satisfies this by inheriting the
 * repo root's own `package.json`; an external author's directory would
 * need an equivalent ancestor `package.json`. This is not enforced here —
 * Node's own module resolution already fails loudly (or silently
 * double-wraps a CommonJS-style default export) otherwise, which is
 * surfaced to the caller as a load failure either way.
 *
 * Security / trust boundary (`.claude/knowledge/nodejs/security.md`,
 * "Untrusted code execution"): this dynamically imports and *runs*
 * arbitrary TypeScript the moment this command executes — no sandboxing is
 * added around it, deliberately. The threat model here is the same one
 * every other `ScaffoldDefinition`/`registerAction()` hook in this
 * codebase already assumes (see `core/authoring.ts`'s own header comment
 * on Handlebars templates being "a trusted, author-written template, never
 * unvalidated external input"): a scaffold author is a trusted party
 * running their own build tooling against their own `scaffold.ts`, the
 * same way they'd already trust `tsc`/`vitest`/any other dev-time tool in
 * their own repository to run arbitrary code on their behalf. `synth` is a
 * build-time tool invoked by the person *authoring* the plugin — it never
 * runs against untrusted end-user input, and nothing about this command
 * changes once `stackfold init` itself runs (which only ever consumes the
 * already-synthesized, already-committed `scaffold.json`).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import type { ScaffoldDefinition } from '../../core/authoring.js';
import { synth, type SynthOptions } from '../../authoring/synth.js';

export interface ScaffoldSynthCommandDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Base for resolving the canonical `src/plugins/<id>/scaffold.json` output path (`src/authoring/synth.ts`'s own `cwd`). */
  cwd: () => string;
}

/**
 * Registers the `scaffold` command group and its one `synth` subcommand —
 * additive, same pattern `registerInitCommand`/`registerListCommand`/
 * `registerInfoCommand` already establish.
 */
export function registerScaffoldSynthCommand(program: Command, deps: ScaffoldSynthCommandDependencies): void {
  const scaffoldCommand = program.command('scaffold').description('Scaffold-authoring tooling (TS → scaffold.json).');

  scaffoldCommand
    .command('synth')
    .description('Compiles a TS-authored scaffold module (scaffold.ts) into the canonical scaffold.json')
    .argument('<dir>', 'Directory containing scaffold.ts (and any sibling .hbs files)')
    .action(async (dir: string) => {
      process.exitCode = await runScaffoldSynth(dir, deps);
    });
}

/** Returns the process exit code; never throws. */
export async function runScaffoldSynth(dir: string, deps: ScaffoldSynthCommandDependencies): Promise<number> {
  const { stdout, stderr, cwd } = deps;
  const scaffoldTsPath = resolve(dir, 'scaffold.ts');

  let definition: ScaffoldDefinition;
  try {
    definition = await loadScaffoldDefinition(scaffoldTsPath);
  } catch (err) {
    stderr(`stackfold scaffold synth: failed to load "${scaffoldTsPath}": ${toMessage(err)}`);
    return 1;
  }

  try {
    const options: SynthOptions = { cwd: cwd() };
    const result = synth(definition, options);
    stdout(`stackfold scaffold synth: wrote ${result.outputPath}`);
    return 0;
  } catch (err) {
    stderr(`stackfold scaffold synth: ${toMessage(err)}`);
    return 1;
  }
}

/**
 * Loads `scaffoldTsPath` via `tsImport()` and resolves its exported
 * `ScaffoldDefinition` per the convention documented in this module's
 * header comment (default export, falling back to a named `scaffold`
 * export; either value directly, or a thunk producing one).
 */
async function loadScaffoldDefinition(scaffoldTsPath: string): Promise<ScaffoldDefinition> {
  const moduleUrl = pathToFileURL(scaffoldTsPath).href;
  // Lazily imported here (not at module top level) so that starting the CLI
  // for any other command (`list`, `info`, `init`, `plugin register`, etc.)
  // never loads `tsx` at all — only `scaffold synth` actually needs it.
  const { tsImport } = await import('tsx/esm/api');
  const loaded = (await tsImport(moduleUrl, import.meta.url)) as Record<string, unknown>;

  const exported = 'default' in loaded ? loaded.default : loaded.scaffold;
  if (exported === undefined) {
    throw new Error(`"${scaffoldTsPath}" has no default export and no named "scaffold" export`);
  }

  const resolved = typeof exported === 'function' ? await (exported as () => unknown | Promise<unknown>)() : exported;
  return resolved as ScaffoldDefinition;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
