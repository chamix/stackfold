import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectPluginKind,
  runPluginList,
  runPluginRegister,
  runPluginUnregister,
  type PluginCommandDependencies,
} from '../../src/cli/commands/plugin.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import type { PluginConfigEntry, PluginConfigStore, PluginKind } from '../../src/infra/dynamicPluginRegistry.js';
import type { ScaffoldDefinition } from '../../src/core/authoring.js';

const evaluator = new JsonLogicExpressionEvaluator();
const CWD = resolvePath('/project');

function validDefinition(id: string): ScaffoldDefinition {
  return {
    id,
    description: `${id} description`,
    questions: [],
    steps: [],
  };
}

function brokenDefinition(): ScaffoldDefinition {
  return {
    id: 'whatever-this-never-gets-used',
    description: 'broken',
    questions: [],
    steps: [{ action: 'thisActionDoesNotExist', params: {} }],
  };
}

/** In-memory fake `PluginConfigStore` — no real disk I/O. */
function fakeConfigStore(initial: Partial<Record<'global' | 'project', { filepath: string; entries: Record<string, PluginConfigEntry> }>> = {}) {
  const writable: Partial<Record<'global' | 'project', { filepath: string; entries: Record<string, PluginConfigEntry> }>> = {
    ...initial,
  };
  const store: PluginConfigStore = {
    async findExistingFilepath(level) {
      return writable[level]?.filepath;
    },
    async resolveWriteFilepath(level, cwd) {
      return writable[level]?.filepath ?? resolvePath(cwd, level === 'global' ? '.stackfoldrc.json' : '.stackfold-pluginsrc.json');
    },
    async readEntries(filepath) {
      for (const level of Object.values(writable)) {
        if (level?.filepath === filepath) return { ...level.entries };
      }
      return {};
    },
    async writeEntries(filepath, entries) {
      // Determine which level `filepath` belongs to: an already-known
      // level's own filepath wins; otherwise fall back to the filename
      // convention `resolveWriteFilepath()`'s own default produces
      // (".stackfoldrc.json" for global, anything else — e.g.
      // ".stackfold-pluginsrc.json" — for a brand-new project-level file).
      let level: 'global' | 'project';
      if (writable.global?.filepath === filepath) level = 'global';
      else if (writable.project?.filepath === filepath) level = 'project';
      else level = filepath.endsWith('.stackfoldrc.json') ? 'global' : 'project';
      writable[level] = { filepath, entries };
    },
  };
  return { store, writable };
}

function fakeImporter(definitions: Record<string, ScaffoldDefinition>) {
  return async (resolvedSource: string, _kind: PluginKind) => {
    const definition = definitions[resolvedSource];
    if (!definition) throw new Error(`no fake module registered for "${resolvedSource}"`);
    return { default: definition };
  };
}

function baseDeps(overrides: Partial<PluginCommandDependencies> = {}): { deps: PluginCommandDependencies; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: PluginCommandDependencies = {
    cwd: () => CWD,
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    evaluator,
    ...overrides,
  };
  return { deps, stdout, stderr };
}

describe('detectPluginKind', () => {
  it('rejects .ts sources outright, regardless of existence', () => {
    expect(detectPluginKind('scaffold.ts', CWD, () => true)).toBe('rejected-ts');
    expect(detectPluginKind('scaffold.ts', CWD, () => false)).toBe('rejected-ts');
  });

  it('rejects .tsx sources outright', () => {
    expect(detectPluginKind('scaffold.tsx', CWD, () => true)).toBe('rejected-ts');
  });

  it('an existing local .json file is scaffold-json', () => {
    expect(detectPluginKind('./plugin.json', CWD, () => true)).toBe('scaffold-json');
  });

  it('an existing local .js file is scaffold-module', () => {
    expect(detectPluginKind('./plugin.js', CWD, () => true)).toBe('scaffold-module');
  });

  it('an existing local .mjs file is scaffold-module', () => {
    expect(detectPluginKind('./plugin.mjs', CWD, () => true)).toBe('scaffold-module');
  });

  it('a .json path that does not exist locally falls through to npm-package', () => {
    expect(detectPluginKind('./plugin.json', CWD, () => false)).toBe('npm-package');
  });

  it('a bare specifier with no path separator is npm-package', () => {
    expect(detectPluginKind('some-stackfold-plugin', CWD, () => false)).toBe('npm-package');
  });
});

describe('runPluginRegister', () => {
  it('rejects a .ts source with an explicit message, writing nothing', async () => {
    const { store, writable } = fakeConfigStore();
    const { deps, stderr } = baseDeps({ configStore: store, fileExists: () => true });

    const code = await runPluginRegister('scaffold.ts', {}, deps);

    expect(code).toBe(1);
    expect(stderr[0]).toMatch(/scaffold synth/);
    expect(writable.global).toBeUndefined();
  });

  it('registers a valid local scaffold.json under its real compiled id, in the global config by default', async () => {
    const sourcePath = resolvePath(CWD, 'mi-plugin.json');
    const { store, writable } = fakeConfigStore();
    const importSource = fakeImporter({ [sourcePath]: validDefinition('real-id') });
    const { deps, stdout, stderr } = baseDeps({
      configStore: store,
      importSource,
      fileExists: (p) => p === sourcePath,
    });

    const code = await runPluginRegister('mi-plugin.json', {}, deps);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout[0]).toMatch(/real-id/);
    expect(writable.global?.entries).toEqual({ 'real-id': { source: 'mi-plugin.json', kind: 'scaffold-json' } });
    expect(writable.project).toBeUndefined();
  });

  it('--project registers in the project-level config instead', async () => {
    const sourcePath = resolvePath(CWD, 'mi-plugin.json');
    const { store, writable } = fakeConfigStore();
    const importSource = fakeImporter({ [sourcePath]: validDefinition('real-id') });
    const { deps } = baseDeps({ configStore: store, importSource, fileExists: (p) => p === sourcePath });

    const code = await runPluginRegister('mi-plugin.json', { project: true }, deps);

    expect(code).toBe(0);
    expect(writable.project?.entries).toEqual({ 'real-id': { source: 'mi-plugin.json', kind: 'scaffold-json' } });
    expect(writable.global).toBeUndefined();
  });

  it('a source that fails the smoke test is never registered — real error surfaced, config untouched', async () => {
    const sourcePath = resolvePath(CWD, 'broken.json');
    const { store, writable } = fakeConfigStore();
    const importSource = fakeImporter({ [sourcePath]: brokenDefinition() });
    const { deps, stderr } = baseDeps({ configStore: store, importSource, fileExists: (p) => p === sourcePath });

    const code = await runPluginRegister('broken.json', {}, deps);

    expect(code).toBe(1);
    expect(stderr[0]).toMatch(/thisActionDoesNotExist/);
    expect(writable.global).toBeUndefined();
  });

  it('preserves other already-registered entries when adding a new one', async () => {
    const sourcePath = resolvePath(CWD, 'new-plugin.json');
    const { store, writable } = fakeConfigStore({
      global: { filepath: resolvePath(CWD, '.stackfoldrc.json'), entries: { existing: { source: 'x.json', kind: 'scaffold-json' } } },
    });
    const importSource = fakeImporter({ [sourcePath]: validDefinition('new-id') });
    const { deps } = baseDeps({ configStore: store, importSource, fileExists: (p) => p === sourcePath });

    await runPluginRegister('new-plugin.json', {}, deps);

    expect(writable.global?.entries).toEqual({
      existing: { source: 'x.json', kind: 'scaffold-json' },
      'new-id': { source: 'new-plugin.json', kind: 'scaffold-json' },
    });
  });
});

describe('runPluginUnregister', () => {
  it('removes a registered id from the global config', async () => {
    const { store, writable } = fakeConfigStore({
      global: {
        filepath: resolvePath(CWD, '.stackfoldrc.json'),
        entries: { keep: { source: 'k.json', kind: 'scaffold-json' }, drop: { source: 'd.json', kind: 'scaffold-json' } },
      },
    });
    const { deps, stdout } = baseDeps({ configStore: store });

    const code = await runPluginUnregister('drop', {}, deps);

    expect(code).toBe(0);
    expect(stdout[0]).toMatch(/drop/);
    expect(writable.global?.entries).toEqual({ keep: { source: 'k.json', kind: 'scaffold-json' } });
  });

  it('reports an error and exits 1 when the level has no config at all', async () => {
    const { store } = fakeConfigStore();
    const { deps, stderr } = baseDeps({ configStore: store });

    const code = await runPluginUnregister('anything', {}, deps);

    expect(code).toBe(1);
    expect(stderr[0]).toMatch(/no (global )?plugin config/i);
  });

  it('reports an error and exits 1 when the id is not registered at that level', async () => {
    const { store } = fakeConfigStore({
      global: { filepath: resolvePath(CWD, '.stackfoldrc.json'), entries: { keep: { source: 'k.json', kind: 'scaffold-json' } } },
    });
    const { deps, stderr } = baseDeps({ configStore: store });

    const code = await runPluginUnregister('nope', {}, deps);

    expect(code).toBe(1);
    expect(stderr[0]).toMatch(/not registered/);
  });
});

describe('runPluginList', () => {
  it('reports nothing registered at either level', async () => {
    const { store } = fakeConfigStore();
    const { deps, stdout } = baseDeps({ configStore: store });

    const code = await runPluginList(deps);

    expect(code).toBe(0);
    expect(stdout).toEqual(['No external plugins registered.']);
  });

  it('shows a resolving entry as ✓ and a broken one as ✗ with its real error', async () => {
    const goodPath = resolvePath(CWD, 'good.json');
    const brokenPath = resolvePath(CWD, 'broken.json');
    const { store } = fakeConfigStore({
      global: {
        filepath: resolvePath(CWD, '.stackfoldrc.json'),
        entries: {
          good: { source: 'good.json', kind: 'scaffold-json' },
          broken: { source: 'broken.json', kind: 'scaffold-json' },
        },
      },
    });
    const importSource = fakeImporter({ [goodPath]: validDefinition('good'), [brokenPath]: brokenDefinition() });
    const { deps, stdout } = baseDeps({ configStore: store, importSource });

    const code = await runPluginList(deps);

    expect(code).toBe(0);
    const joined = stdout.join('\n');
    expect(joined).toMatch(/good.*✓/);
    expect(joined).toMatch(/broken.*✗.*thisActionDoesNotExist/);
  });

  it('marks a project-level entry that overrides a same-id global entry', async () => {
    const globalPath = resolvePath(CWD, 'global-version.json');
    const projectPath = resolvePath(CWD, 'project-version.json');
    const { store } = fakeConfigStore({
      global: {
        filepath: resolvePath(CWD, '.stackfoldrc.json'),
        entries: { shared: { source: 'global-version.json', kind: 'scaffold-json' } },
      },
      project: {
        filepath: resolvePath(CWD, '.stackfold-pluginsrc.json'),
        entries: { shared: { source: 'project-version.json', kind: 'scaffold-json' } },
      },
    });
    const importSource = fakeImporter({ [globalPath]: validDefinition('shared'), [projectPath]: validDefinition('shared') });
    const { deps, stdout } = baseDeps({ configStore: store, importSource });

    await runPluginList(deps);

    const joined = stdout.join('\n');
    expect(joined).toMatch(/overridden by project/);
  });
});
