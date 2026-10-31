import { describe, expect, it } from 'vitest';
import { CompositePluginRegistry } from '../../src/infra/compositePluginRegistry.js';
import type { PluginRegistry } from '../../src/core/ports.js';
import type { StackfoldPlugin } from '../../src/core/types.js';

function fakePlugin(id: string): StackfoldPlugin {
  return {
    id,
    description: `${id} plugin`,
    questions: () => [],
    buildBlueprint: () => ({ files: [], postActions: [] }),
  };
}

function fakeRegistry(plugins: StackfoldPlugin[]): PluginRegistry {
  return {
    resolve: async (id) => plugins.find((p) => p.id === id),
    list: async () => [...plugins],
  };
}

describe('CompositePluginRegistry', () => {
  it('resolve(): returns the first registry match, trying registries in constructor order', async () => {
    const a = fakePlugin('a');
    const b = fakePlugin('b');
    const registry = new CompositePluginRegistry([fakeRegistry([a]), fakeRegistry([b])]);

    await expect(registry.resolve('a')).resolves.toBe(a);
    await expect(registry.resolve('b')).resolves.toBe(b);
  });

  it('resolve(): returns undefined when no composed registry has the id', async () => {
    const registry = new CompositePluginRegistry([fakeRegistry([]), fakeRegistry([])]);
    await expect(registry.resolve('nope')).resolves.toBeUndefined();
  });

  it('resolve(): a collision silently prefers the earlier registry — no error, no warning', async () => {
    const builtin = fakePlugin('shared');
    const external = fakePlugin('shared');
    const stderr: string[] = [];
    const registry = new CompositePluginRegistry([fakeRegistry([builtin]), fakeRegistry([external])], {
      stderr: (l) => stderr.push(l),
    });

    await expect(registry.resolve('shared')).resolves.toBe(builtin);
    expect(stderr).toEqual([]);
  });

  it('list(): concatenates every composed registry, deduping by id', async () => {
    const a = fakePlugin('a');
    const b = fakePlugin('b');
    const registry = new CompositePluginRegistry([fakeRegistry([a]), fakeRegistry([b])]);

    expect((await registry.list()).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('list(): on a colliding id, keeps the earlier registry\'s plugin and warns to stderr about the dropped one', async () => {
    const builtin = fakePlugin('shared');
    const external = fakePlugin('shared');
    const stderr: string[] = [];
    const registry = new CompositePluginRegistry([fakeRegistry([builtin]), fakeRegistry([external])], {
      stderr: (l) => stderr.push(l),
    });

    const result = await registry.list();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(builtin);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/shared/);
  });
});
