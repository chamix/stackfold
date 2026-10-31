/**
 * External plugin registration (Task 049/SK-ADR-005, ARCH-002) —
 * `DynamicPluginRegistry` implements the (now-async) `PluginRegistry` port
 * via two layered `cosmiconfig('stackfold-plugins')` config levels. Not the
 * only place that uses this module: `cli/commands/plugin.ts`'s
 * `register`/`unregister`/`list` subcommands reuse `loadPluginFromSource()`
 * (the kind→import→compile→smoke-test pipeline) and `PluginConfigStore`
 * (reading/writing the raw config files) directly — this registry and that
 * command group share one implementation of "what a registered entry is
 * and how it resolves", never two.
 *
 * Config shape (both levels, Task 049 spec): `{ "plugins": { "<id>": {
 * "source": "<string>", "kind": "scaffold-json"|"scaffold-module"|
 * "npm-package" } } }`. `kind` is recorded once at `register` time, never
 * re-detected here.
 *   - Global: a fixed path, `~/.stackfoldrc.json`, loaded via
 *     `cosmiconfig(...).load(...)` — never `.search()`, so "which config"
 *     never depends on the invoking cwd.
 *   - Project: `cosmiconfig(...).search(cwd)`, the standard upward search.
 *   - An id present at both levels: the project entry wins (last-merged
 *     into `#resolveEntries()`'s map, see below).
 *
 * `cosmiconfig('stackfold-plugins')` is a dedicated moduleName, distinct
 * from the unrelated `cosmiconfig('stackfold')` `cli/commands/init.ts`
 * already uses for `--config` answer files — two unrelated concerns, two
 * namespaces, never conflated (SK-ADR-005's own header comment).
 *
 * Real laziness (acceptance criterion): `resolve(id)` only ever imports the
 * one entry it was asked for — `#resolveEntries()` reads config metadata
 * only (ids/source/kind), never imports a module. `list()` necessarily
 * materializes every entry (that's what the command asks for); a single
 * broken entry (import throws, or the smoke test fails) is omitted with a
 * warning to stderr rather than failing the whole call — the acceptance
 * criterion that an external plugin breaking after registration must never
 * take `stackfold list`/`init` down for the others.
 *
 * Security (`.claude/knowledge/nodejs/security.md`, "Untrusted code
 * execution"): registering and resolving an external plugin runs that
 * plugin's own code the moment it's imported — the same trust level as
 * `npm install`ing any dependency, per this task's explicit "Fuera de
 * alcance" (no new sandboxing). Every import here is of a source the user
 * themselves registered.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { compileScaffold, type ScaffoldDefinition } from '../core/authoring.js';
import type { ExpressionEvaluator, PluginRegistry } from '../core/ports.js';
import type { Answers, QuestionDefinition, StackfoldPlugin } from '../core/types.js';

export const PLUGIN_CONFIG_MODULE_NAME = 'stackfold-plugins';
export const GLOBAL_CONFIG_PATH = join(homedir(), '.stackfoldrc.json');
/** Used only when no existing project-level config file was found to write back to. */
export const DEFAULT_PROJECT_CONFIG_FILENAME = '.stackfold-pluginsrc.json';

export type PluginKind = 'scaffold-json' | 'scaffold-module' | 'npm-package';

export interface PluginConfigEntry {
  /** As given by the user at `register` time — a local path or an npm specifier, verbatim. */
  source: string;
  kind: PluginKind;
}

const pluginKindSchema = z.enum(['scaffold-json', 'scaffold-module', 'npm-package']);
const pluginConfigEntrySchema = z.object({ source: z.string().min(1), kind: pluginKindSchema });
const pluginsFileSchema = z.object({ plugins: z.record(z.string(), pluginConfigEntrySchema).optional() });

// ---------------------------------------------------------------------------
// loadPluginFromSource — the shared kind→import→compile→smoke-test pipeline
// ---------------------------------------------------------------------------

/**
 * Real, production `import()`-based loader, keyed by `kind` (SK-ADR-005 /
 * Task 049 spec's unification: the 3 sources all collapse to the same
 * `compileScaffold()` input, differing only in *how they're imported*).
 * Exported so `cli/commands/plugin.ts`'s `register` command (and tests
 * elsewhere) can reference the exact default without re-deriving it.
 */
export async function realImportSource(resolvedSource: string, kind: PluginKind): Promise<unknown> {
  if (kind === 'npm-package') {
    return import(resolvedSource);
  }
  const moduleUrl = pathToFileURL(resolvedSource).href;
  if (kind === 'scaffold-json') {
    return import(moduleUrl, { with: { type: 'json' } });
  }
  return import(moduleUrl);
}

/**
 * Resolves `source` relative to `baseDir` for the two local kinds (per-entry
 * `baseDir`: the config file's own directory, per SK-ADR-005 — portability
 * for a committed project config). `npm-package` sources are never resolved
 * against a directory — handed to `import()` as the bare specifier the user
 * gave, exactly as Node's own module resolution expects.
 */
function resolveSourcePath(source: string, kind: PluginKind, baseDir: string): string {
  return kind === 'npm-package' ? source : resolvePath(baseDir, source);
}

/**
 * Imports `source` (per `kind`), compiles it via `compileScaffold()`
 * (same function the CLI composition root already uses for built-ins —
 * Task 049 spec's "ningún código nuevo de ejecución"), and runs a real
 * smoke test (`questions()` + a `buildBlueprint()` call with answers
 * synthesized from each question) before returning the resulting
 * `StackfoldPlugin`. Throws the real underlying error — from the import,
 * `compileScaffold()`, or the smoke test — without any generic wrapper, so
 * a caller (this module's own `DynamicPluginRegistry`, or
 * `cli/commands/plugin.ts`'s `register`) can surface it verbatim.
 *
 * `importSource` is injectable (defaults to `realImportSource`) — the one
 * seam every unit test in this module's own test file and
 * `plugin-command.test.ts` uses to avoid real disk/network I/O.
 */
export async function loadPluginFromSource(
  source: string,
  kind: PluginKind,
  baseDir: string,
  evaluator: ExpressionEvaluator,
  importSource: (resolvedSource: string, kind: PluginKind) => Promise<unknown> = realImportSource
): Promise<StackfoldPlugin> {
  const resolvedSource = resolveSourcePath(source, kind, baseDir);
  const moduleNamespace = await importSource(resolvedSource, kind);
  const definition = extractDefaultExport(moduleNamespace, resolvedSource);
  const plugin = compileScaffold(definition as ScaffoldDefinition, evaluator);
  runSmokeTest(plugin);
  return plugin;
}

function extractDefaultExport(moduleNamespace: unknown, source: string): unknown {
  if (typeof moduleNamespace !== 'object' || moduleNamespace === null || !('default' in moduleNamespace)) {
    throw new Error(`"${source}" has no default export`);
  }
  return (moduleNamespace as { default: unknown }).default;
}

/**
 * Real smoke test (Task 049 spec, Decisión confirmada #4): invokes the
 * compiled plugin's own `questions()`, then a `buildBlueprint()` call with
 * answers synthesized from each question — same pattern
 * `src/authoring/synth.ts`'s own `synth()` already uses for `scaffold
 * synth` (reimplemented here, not imported: `authoring/synth.ts` is outside
 * this task's scope, and its `syntheticAnswers()` helper isn't exported).
 * Still pure/synchronous, no disk I/O — `buildBlueprint()` only returns an
 * in-memory `ProjectBlueprint`.
 */
function runSmokeTest(plugin: StackfoldPlugin): void {
  const answers = syntheticAnswers(plugin.questions());
  plugin.buildBlueprint(answers);
}

function syntheticAnswers(questions: QuestionDefinition[]): Answers {
  const answers: Answers = {};
  for (const question of questions) {
    if (question.default !== undefined) {
      answers[question.id] = question.default;
      continue;
    }
    switch (question.type) {
      case 'confirm':
        answers[question.id] = false;
        break;
      case 'select':
        answers[question.id] = question.choices?.[0] ?? '';
        break;
      default:
        answers[question.id] = '';
        break;
    }
  }
  return answers;
}

// ---------------------------------------------------------------------------
// PluginConfigStore — reading/writing the raw 2-level config (shared with
// `cli/commands/plugin.ts`'s register/unregister/list commands)
// ---------------------------------------------------------------------------

export type PluginConfigLevel = 'global' | 'project';

export interface PluginConfigStore {
  /** The existing file for this level, if any — `undefined` if nothing is registered there yet. */
  findExistingFilepath(level: PluginConfigLevel, cwd: string): Promise<string | undefined>;
  /**
   * The file to write to for this level: the existing one if found (unless
   * it's a `package.json` — writing a whole embedded-property file back is
   * out of this task's scope, so a fresh dedicated file is used instead),
   * else a brand-new default path.
   */
  resolveWriteFilepath(level: PluginConfigLevel, cwd: string): Promise<string>;
  /** `{}` when the file doesn't exist. Throws on malformed JSON or a config shape that fails `pluginsFileSchema`. */
  readEntries(filepath: string): Promise<Record<string, PluginConfigEntry>>;
  /** Overwrites `filepath`'s `"plugins"` map with `entries` (creating the file/directory if needed). */
  writeEntries(filepath: string, entries: Record<string, PluginConfigEntry>): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function findExistingFilepath(level: PluginConfigLevel, cwd: string): Promise<string | undefined> {
  if (level === 'global') {
    try {
      await readFile(GLOBAL_CONFIG_PATH, 'utf8');
      return GLOBAL_CONFIG_PATH;
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
  }

  const explorer = cosmiconfig(PLUGIN_CONFIG_MODULE_NAME);
  const result = await explorer.search(cwd);
  if (!result || result.isEmpty) return undefined;
  return result.filepath;
}

async function resolveWriteFilepath(level: PluginConfigLevel, cwd: string): Promise<string> {
  if (level === 'global') return GLOBAL_CONFIG_PATH;

  const existing = await findExistingFilepath('project', cwd);
  if (existing && !existing.endsWith('package.json')) return existing;
  return join(cwd, DEFAULT_PROJECT_CONFIG_FILENAME);
}

async function readEntries(filepath: string): Promise<Record<string, PluginConfigEntry>> {
  let text: string;
  try {
    text = await readFile(filepath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return {};
    throw new Error(`stackfold: failed to read "${filepath}": ${toMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`stackfold: "${filepath}" is not valid JSON: ${toMessage(err)}`);
  }

  const result = pluginsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`stackfold: "${filepath}" has an invalid plugin-config shape: ${formatZodIssues(result.error)}`);
  }
  return { ...(result.data.plugins ?? {}) };
}

async function writeEntries(filepath: string, entries: Record<string, PluginConfigEntry>): Promise<void> {
  await mkdir(dirname(filepath), { recursive: true });
  await writeFile(filepath, `${JSON.stringify({ plugins: entries }, null, 2)}\n`, 'utf8');
}

/** Real, production `PluginConfigStore` — reads/writes the actual filesystem. */
export const realPluginConfigStore: PluginConfigStore = {
  findExistingFilepath,
  resolveWriteFilepath,
  readEntries,
  writeEntries,
};

// ---------------------------------------------------------------------------
// DynamicPluginRegistry
// ---------------------------------------------------------------------------

export interface DynamicPluginRegistryDependencies {
  evaluator: ExpressionEvaluator;
  /** Base for the project-level `cosmiconfig(...).search()`. */
  cwd: () => string;
  /** Defaults to `(line) => console.error(line)`. */
  stderr?: (line: string) => void;
  /** Injected for testability — defaults to `realPluginConfigStore`. */
  configStore?: PluginConfigStore;
  /** Injected for testability — defaults to `realImportSource`. */
  importSource?: (resolvedSource: string, kind: PluginKind) => Promise<unknown>;
}

interface ResolvedEntry {
  id: string;
  entry: PluginConfigEntry;
  /** The config file's own directory this entry's relative `source` resolves against. */
  baseDir: string;
}

export class DynamicPluginRegistry implements PluginRegistry {
  readonly #evaluator: ExpressionEvaluator;
  readonly #cwd: () => string;
  readonly #stderr: (line: string) => void;
  readonly #configStore: PluginConfigStore;
  readonly #importSource: (resolvedSource: string, kind: PluginKind) => Promise<unknown>;

  constructor(deps: DynamicPluginRegistryDependencies) {
    this.#evaluator = deps.evaluator;
    this.#cwd = deps.cwd;
    this.#stderr = deps.stderr ?? ((line) => console.error(line));
    this.#configStore = deps.configStore ?? realPluginConfigStore;
    this.#importSource = deps.importSource ?? realImportSource;
  }

  /**
   * Reads config *metadata only* from both levels — never imports a module.
   * This is what keeps `resolve()` genuinely lazy: it calls this, then
   * imports (via `loadPluginFromSource`) only the one matching entry.
   * Project entries are merged in after global ones, so an id present at
   * both levels ends up keyed to the project entry (SK-ADR-005: project
   * wins).
   */
  async #resolveEntries(): Promise<Map<string, ResolvedEntry>> {
    const cwd = this.#cwd();
    const merged = new Map<string, ResolvedEntry>();

    for (const level of ['global', 'project'] as const) {
      const filepath = await this.#configStore.findExistingFilepath(level, cwd);
      if (!filepath) continue;
      const entries = await this.#configStore.readEntries(filepath);
      const baseDir = dirname(filepath);
      for (const [id, entry] of Object.entries(entries)) {
        merged.set(id, { id, entry, baseDir });
      }
    }

    return merged;
  }

  async #materialize(resolved: ResolvedEntry): Promise<StackfoldPlugin> {
    return loadPluginFromSource(resolved.entry.source, resolved.entry.kind, resolved.baseDir, this.#evaluator, this.#importSource);
  }

  async resolve(id: string): Promise<StackfoldPlugin | undefined> {
    const entries = await this.#resolveEntries();
    const resolved = entries.get(id);
    if (!resolved) return undefined;
    return this.#materialize(resolved);
  }

  async list(): Promise<StackfoldPlugin[]> {
    const entries = await this.#resolveEntries();
    const plugins: StackfoldPlugin[] = [];

    for (const resolved of entries.values()) {
      try {
        plugins.push(await this.#materialize(resolved));
      } catch (err) {
        this.#stderr(
          `stackfold: external plugin "${resolved.id}" (${resolved.entry.source}) is registered but failed to ` +
            `load: ${toMessage(err)}`
        );
      }
    }

    return plugins;
  }
}
