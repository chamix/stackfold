import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DynamicPluginRegistry,
  loadPluginFromSource,
  type PluginConfigEntry,
  type PluginConfigStore,
  type PluginKind,
} from '../../src/infra/dynamicPluginRegistry.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import type { ScaffoldDefinition } from '../../src/core/authoring.js';

// Fixture directories/filepaths below are built via `node:path`'s own
// `resolve()`, not hardcoded POSIX string literals — `loadPluginFromSource()`
// resolves a local source against `baseDir` using the same `resolve()`, which
// normalizes to a drive-letter/backslash form on Windows. Hardcoding
// `/base/...`-style literals here would assert against a shape `resolve()`
// never actually produces on this platform.
const evaluator = new JsonLogicExpressionEvaluator();

const BASE_DIR = resolvePath('/base');
const ELSEWHERE_DIR = resolvePath('/elsewhere');
const HOME_DIR = resolvePath('/home');
const PROJ_DIR = resolvePath('/proj');

function validDefinition(id: string): ScaffoldDefinition {
  return {
    id,
    description: `${id} description`,
    questions: [{ id: 'appName', message: 'App name?', type: 'input', default: 'App' }],
    steps: [{ action: 'writeFile', params: { path: 'README.md', content: '{{appName}}' } }],
  };
}

function brokenDefinitionUnknownAction(id: string): ScaffoldDefinition {
  return {
    id,
    description: `${id} description`,
    questions: [],
    steps: [{ action: 'thisActionDoesNotExist', params: {} }],
  };
}

/** In-memory fake of `PluginConfigStore` — no real disk I/O. */
function fakeConfigStore(
  levels: Partial<Record<'global' | 'project', { filepath: string; entries: Record<string, PluginConfigEntry> }>>
): PluginConfigStore {
  const writable = { ...levels };
  return {
    async findExistingFilepath(level) {
      return writable[level]?.filepath;
    },
    async resolveWriteFilepath(level, cwd) {
      return writable[level]?.filepath ?? resolvePath(cwd, '.fake-config.json');
    },
    async readEntries(filepath) {
      for (const level of Object.values(writable)) {
        if (level?.filepath === filepath) return { ...level.entries };
      }
      return {};
    },
    async writeEntries(filepath, entries) {
      for (const key of Object.keys(writable) as Array<'global' | 'project'>) {
        if (writable[key]?.filepath === filepath) {
          writable[key] = { filepath, entries };
          return;
        }
      }
    },
  };
}

function fakeImporter(definitions: Record<string, ScaffoldDefinition>, calls: string[]) {
  return async (resolvedSource: string, _kind: PluginKind) => {
    calls.push(resolvedSource);
    const definition = definitions[resolvedSource];
    if (!definition) throw new Error(`no fake module registered for "${resolvedSource}"`);
    return { default: definition };
  };
}

describe('loadPluginFromSource', () => {
  it('imports, compiles and smoke-tests a scaffold-module source, returning the resulting StackfoldPlugin', async () => {
    const calls: string[] = [];
    const goodPath = resolvePath(BASE_DIR, 'good.js');
    const importSource = fakeImporter({ [goodPath]: validDefinition('good') }, calls);

    const plugin = await loadPluginFromSource('good.js', 'scaffold-module', BASE_DIR, evaluator, importSource);

    expect(plugin.id).toBe('good');
    expect(calls).toEqual([goodPath]);
  });

  it('resolves a local source relative to baseDir, not process.cwd()', async () => {
    const calls: string[] = [];
    const nestedPath = resolvePath(ELSEWHERE_DIR, 'nested/good.json');
    const importSource = fakeImporter({ [nestedPath]: validDefinition('good') }, calls);

    await loadPluginFromSource('nested/good.json', 'scaffold-json', ELSEWHERE_DIR, evaluator, importSource);

    expect(calls).toEqual([nestedPath]);
  });

  it('passes an npm-package source straight through, unresolved against baseDir', async () => {
    const calls: string[] = [];
    const importSource = fakeImporter({ 'some-stackfold-plugin': validDefinition('pkg') }, calls);

    await loadPluginFromSource('some-stackfold-plugin', 'npm-package', resolvePath('/irrelevant'), evaluator, importSource);

    expect(calls).toEqual(['some-stackfold-plugin']);
  });

  it('throws the real underlying error when the import itself fails', async () => {
    const importSource = async () => {
      throw new Error('ENOENT: no such file');
    };

    await expect(
      loadPluginFromSource('missing.js', 'scaffold-module', BASE_DIR, evaluator, importSource)
    ).rejects.toThrow(/ENOENT/);
  });

  it('throws a real error when the smoke test fails (unknown action)', async () => {
    const calls: string[] = [];
    const brokenPath = resolvePath(BASE_DIR, 'broken.js');
    const importSource = fakeImporter({ [brokenPath]: brokenDefinitionUnknownAction('broken') }, calls);

    await expect(
      loadPluginFromSource('broken.js', 'scaffold-module', BASE_DIR, evaluator, importSource)
    ).rejects.toThrow(/thisActionDoesNotExist/);
  });
});

describe('DynamicPluginRegistry', () => {
  it('resolve(): returns undefined when the id is registered at neither level', async () => {
    const registry = new DynamicPluginRegistry({
      evaluator,
      cwd: () => PROJ_DIR,
      configStore: fakeConfigStore({}),
    });

    await expect(registry.resolve('nope')).resolves.toBeUndefined();
  });

  it('resolve(): imports and returns only the one requested entry, never the others (real laziness)', async () => {
    const calls: string[] = [];
    const aPath = resolvePath(HOME_DIR, 'a.json');
    const bPath = resolvePath(HOME_DIR, 'b.json');
    const importSource = fakeImporter({ [aPath]: validDefinition('a'), [bPath]: validDefinition('b') }, calls);
    const registry = new DynamicPluginRegistry({
      evaluator,
      cwd: () => PROJ_DIR,
      importSource,
      configStore: fakeConfigStore({
        global: {
          filepath: resolvePath(HOME_DIR, '.stackfoldrc.json'),
          entries: { a: { source: 'a.json', kind: 'scaffold-json' }, b: { source: 'b.json', kind: 'scaffold-json' } },
        },
      }),
    });

    const plugin = await registry.resolve('a');

    expect(plugin?.id).toBe('a');
    expect(calls).toEqual([aPath]);
  });

  it('list(): materializes every registered entry across both levels', async () => {
    const calls: string[] = [];
    const aPath = resolvePath(HOME_DIR, 'a.json');
    const bPath = resolvePath(PROJ_DIR, 'b.json');
    const importSource = fakeImporter({ [aPath]: validDefinition('a'), [bPath]: validDefinition('b') }, calls);
    const registry = new DynamicPluginRegistry({
      evaluator,
      cwd: () => PROJ_DIR,
      importSource,
      configStore: fakeConfigStore({
        global: { filepath: resolvePath(HOME_DIR, '.stackfoldrc.json'), entries: { a: { source: 'a.json', kind: 'scaffold-json' } } },
        project: {
          filepath: resolvePath(PROJ_DIR, '.stackfold-pluginsrc.json'),
          entries: { b: { source: 'b.json', kind: 'scaffold-json' } },
        },
      }),
    });

    const plugins = await registry.list();

    expect(plugins.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('list(): omits a broken entry with a stderr warning instead of throwing, and keeps the healthy ones', async () => {
    const calls: string[] = [];
    const goodPath = resolvePath(HOME_DIR, 'good.json');
    const brokenPath = resolvePath(HOME_DIR, 'broken.json');
    const importSource = fakeImporter(
      { [goodPath]: validDefinition('good'), [brokenPath]: brokenDefinitionUnknownAction('broken') },
      calls
    );
    const stderr: string[] = [];
    const registry = new DynamicPluginRegistry({
      evaluator,
      cwd: () => PROJ_DIR,
      importSource,
      stderr: (l) => stderr.push(l),
      configStore: fakeConfigStore({
        global: {
          filepath: resolvePath(HOME_DIR, '.stackfoldrc.json'),
          entries: {
            good: { source: 'good.json', kind: 'scaffold-json' },
            broken: { source: 'broken.json', kind: 'scaffold-json' },
          },
        },
      }),
    });

    const plugins = await registry.list();

    expect(plugins.map((p) => p.id)).toEqual(['good']);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/broken/);
  });

  it('a project-level id collides with a global-level id: the project entry wins', async () => {
    const calls: string[] = [];
    const globalSharedPath = resolvePath(HOME_DIR, 'shared.json');
    const projectSharedPath = resolvePath(PROJ_DIR, 'shared.json');
    const importSource = fakeImporter(
      { [globalSharedPath]: validDefinition('shared'), [projectSharedPath]: validDefinition('shared') },
      calls
    );
    const registry = new DynamicPluginRegistry({
      evaluator,
      cwd: () => PROJ_DIR,
      importSource,
      configStore: fakeConfigStore({
        global: {
          filepath: resolvePath(HOME_DIR, '.stackfoldrc.json'),
          entries: { shared: { source: 'shared.json', kind: 'scaffold-json' } },
        },
        project: {
          filepath: resolvePath(PROJ_DIR, '.stackfold-pluginsrc.json'),
          entries: { shared: { source: 'shared.json', kind: 'scaffold-json' } },
        },
      }),
    });

    await registry.resolve('shared');

    expect(calls).toEqual([projectSharedPath]);
  });
});
