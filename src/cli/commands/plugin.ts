/**
 * `stackfold plugin register/unregister/list` (Task 049/SK-ADR-005,
 * ARCH-002) — the CLI surface for externally registering a plugin without
 * touching `stackfold`'s own source. Shares its "kind→import→compile→
 * smoke-test" pipeline (`loadPluginFromSource()`) and its raw config
 * read/write layer (`PluginConfigStore`) with
 * `infra/dynamicPluginRegistry.ts` — one implementation of "what a
 * registered entry is and how it resolves", reused by both the registry
 * `stackfold list`/`stackfold init` consume and this command group.
 *
 * Deliberately distinct from `stackfold list` (`cli/commands/list.ts`):
 * that command shows what `init` can use *right now* (built-ins + external
 * plugins that currently resolve, via the already-composed
 * `CompositePluginRegistry` — a broken entry is silently omitted there,
 * with only a stderr warning). `stackfold plugin list` here shows every
 * *registered* entry at both config levels, including a broken one (✗ with
 * its real error), and marks which entry wins a same-id collision.
 */
import { extname, resolve as resolvePath } from 'node:path';
import { statSync } from 'node:fs';
import type { Command } from 'commander';
import {
  loadPluginFromSource,
  realImportSource,
  realPluginConfigStore,
  type PluginConfigEntry,
  type PluginConfigLevel,
  type PluginConfigStore,
  type PluginKind,
} from '../../infra/dynamicPluginRegistry.js';
import type { ExpressionEvaluator } from '../../core/ports.js';
import type { StackfoldPlugin } from '../../core/types.js';

export interface PluginCommandDependencies {
  cwd: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  evaluator: ExpressionEvaluator;
  /** Injected for testability — defaults to `realPluginConfigStore`. */
  configStore?: PluginConfigStore;
  /** Injected for testability — defaults to `realImportSource`. */
  importSource?: (resolvedSource: string, kind: PluginKind) => Promise<unknown>;
  /** Injected for testability — defaults to a real `fs.statSync`-based check. */
  fileExists?: (path: string) => boolean;
}

export function registerPluginCommand(program: Command, deps: PluginCommandDependencies): void {
  const pluginCommand = program.command('plugin').description('Manage externally registered stackfold plugins.');

  pluginCommand
    .command('register')
    .description('Register an external plugin: a local scaffold.json/scaffold.js, or an installed npm package')
    .argument('<source>', 'Local path to scaffold.json/scaffold.js, or an npm package specifier')
    .option('--project', 'register in the project-level config instead of the global one', false)
    .action(async (source: string, options: { project?: boolean }) => {
      process.exitCode = await runPluginRegister(source, options, deps);
    });

  pluginCommand
    .command('unregister')
    .description('Remove a previously registered external plugin by id')
    .argument('<id>', 'Plugin id to remove')
    .option('--project', 'remove from the project-level config instead of the global one', false)
    .action(async (id: string, options: { project?: boolean }) => {
      process.exitCode = await runPluginUnregister(id, options, deps);
    });

  pluginCommand
    .command('list')
    .description('List registered external plugins (both levels) and their current resolution status')
    .action(async () => {
      process.exitCode = await runPluginList(deps);
    });
}

// ---------------------------------------------------------------------------
// kind detection (Task 049 spec, "Detección de kind en stackfold plugin
// register <source>")
// ---------------------------------------------------------------------------

export type KindDetection = PluginKind | 'rejected-ts';

function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 1. `.ts`/`.tsx` → always rejected, existence irrelevant (TS is
 *    authoring-time only — SK-ADR-003).
 * 2. Resolves (relative to `cwd`) to an existing local file ending `.json`
 *    → `scaffold-json`.
 * 3. Ditto ending `.js`/`.mjs` → `scaffold-module`.
 * 4. Anything else (no path separator, or doesn't exist locally) →
 *    `npm-package`.
 */
export function detectPluginKind(
  source: string,
  cwd: string,
  fileExists: (path: string) => boolean = defaultFileExists
): KindDetection {
  const ext = extname(source).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'rejected-ts';

  const resolvedPath = resolvePath(cwd, source);
  if (ext === '.json' && fileExists(resolvedPath)) return 'scaffold-json';
  if ((ext === '.js' || ext === '.mjs') && fileExists(resolvedPath)) return 'scaffold-module';
  return 'npm-package';
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export async function runPluginRegister(
  source: string,
  options: { project?: boolean },
  deps: PluginCommandDependencies
): Promise<number> {
  const { stdout, stderr } = deps;
  const cwd = deps.cwd();
  const store = deps.configStore ?? realPluginConfigStore;
  const importSource = deps.importSource ?? realImportSource;
  const fileExists = deps.fileExists ?? defaultFileExists;

  const kind = detectPluginKind(source, cwd, fileExists);
  if (kind === 'rejected-ts') {
    stderr(
      `stackfold plugin register: "${source}" is a TypeScript scaffold source — TS is authoring-time only, ` +
        'never a runtime contract. Run "stackfold scaffold synth <dir>" first, then register the resulting ' +
        'scaffold.json.'
    );
    return 1;
  }

  let plugin: StackfoldPlugin;
  try {
    plugin = await loadPluginFromSource(source, kind, cwd, deps.evaluator, importSource);
  } catch (err) {
    stderr(`stackfold plugin register: ${toMessage(err)}`);
    return 1;
  }

  const level: PluginConfigLevel = options.project ? 'project' : 'global';
  const filepath = await store.resolveWriteFilepath(level, cwd);
  const entries = await store.readEntries(filepath);
  const updated: Record<string, PluginConfigEntry> = { ...entries, [plugin.id]: { source, kind } };
  await store.writeEntries(filepath, updated);

  stdout(`stackfold plugin register: registered "${plugin.id}" (${kind}) in ${filepath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

export async function runPluginUnregister(
  id: string,
  options: { project?: boolean },
  deps: PluginCommandDependencies
): Promise<number> {
  const { stdout, stderr } = deps;
  const cwd = deps.cwd();
  const store = deps.configStore ?? realPluginConfigStore;
  const level: PluginConfigLevel = options.project ? 'project' : 'global';

  const filepath = await store.findExistingFilepath(level, cwd);
  if (!filepath) {
    stderr(`stackfold plugin unregister: no ${level} plugin config found — nothing to remove.`);
    return 1;
  }

  const entries = await store.readEntries(filepath);
  if (!(id in entries)) {
    stderr(`stackfold plugin unregister: "${id}" is not registered at the ${level} level (${filepath}).`);
    return 1;
  }

  const updated = { ...entries };
  delete updated[id];
  await store.writeEntries(filepath, updated);

  stdout(`stackfold plugin unregister: removed "${id}" from ${filepath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// list (registered entries, both levels — distinct from `stackfold list`)
// ---------------------------------------------------------------------------

export async function runPluginList(deps: PluginCommandDependencies): Promise<number> {
  const { stdout } = deps;
  const cwd = deps.cwd();
  const store = deps.configStore ?? realPluginConfigStore;
  const importSource = deps.importSource ?? realImportSource;

  const globalFilepath = await store.findExistingFilepath('global', cwd);
  const projectFilepath = await store.findExistingFilepath('project', cwd);
  const globalEntries = globalFilepath ? await store.readEntries(globalFilepath) : {};
  const projectEntries = projectFilepath ? await store.readEntries(projectFilepath) : {};

  if (Object.keys(globalEntries).length === 0 && Object.keys(projectEntries).length === 0) {
    stdout('No external plugins registered.');
    return 0;
  }

  const sections: Array<{
    label: PluginConfigLevel;
    filepath: string;
    entries: Record<string, PluginConfigEntry>;
    otherEntries: Record<string, PluginConfigEntry>;
  }> = [];
  if (Object.keys(projectEntries).length > 0 && projectFilepath) {
    sections.push({ label: 'project', filepath: projectFilepath, entries: projectEntries, otherEntries: globalEntries });
  }
  if (Object.keys(globalEntries).length > 0 && globalFilepath) {
    sections.push({ label: 'global', filepath: globalFilepath, entries: globalEntries, otherEntries: projectEntries });
  }

  for (const section of sections) {
    stdout(`${section.label} (${section.filepath}):`);
    for (const [id, entry] of Object.entries(section.entries)) {
      const overridden = section.label === 'global' && id in section.otherEntries;
      const status = await describeResolutionStatus(entry, section.filepath, deps.evaluator, importSource);
      const suffix = overridden ? ' (overridden by project)' : '';
      stdout(`  ${id} [${entry.kind}] ${entry.source} — ${status}${suffix}`);
    }
  }

  return 0;
}

async function describeResolutionStatus(
  entry: PluginConfigEntry,
  configFilepath: string,
  evaluator: ExpressionEvaluator,
  importSource: (resolvedSource: string, kind: PluginKind) => Promise<unknown>
): Promise<string> {
  const baseDir = resolvePath(configFilepath, '..');
  try {
    await loadPluginFromSource(entry.source, entry.kind, baseDir, evaluator, importSource);
    return '✓ resolves';
  } catch (err) {
    return `✗ ${toMessage(err)}`;
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
