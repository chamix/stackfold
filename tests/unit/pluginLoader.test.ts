import { describe, expect, it } from 'vitest';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
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

describe('StaticPluginRegistry', () => {
  it('implements the PluginRegistry port', () => {
    const registry: PluginRegistry = new StaticPluginRegistry([fakePlugin('a')]);
    expect(registry.resolve('a')?.id).toBe('a');
  });

  it('resolves a plugin by its stable id', () => {
    const a = fakePlugin('a');
    const b = fakePlugin('b');
    const registry = new StaticPluginRegistry([a, b]);

    expect(registry.resolve('a')).toBe(a);
    expect(registry.resolve('b')).toBe(b);
  });

  it('returns undefined for an unknown id', () => {
    const registry = new StaticPluginRegistry([fakePlugin('a')]);
    expect(registry.resolve('nope')).toBeUndefined();
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'does not resolve object-prototype key %j as a plugin',
    (key) => {
      const registry = new StaticPluginRegistry([fakePlugin('a')]);
      expect(registry.resolve(key)).toBeUndefined();
    }
  );

  it('lists plugins in registration order', () => {
    const registry = new StaticPluginRegistry([fakePlugin('b'), fakePlugin('a')]);
    expect(registry.list().map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('returns a defensive copy from list()', () => {
    const registry = new StaticPluginRegistry([fakePlugin('a')]);
    registry.list().push(fakePlugin('evil'));
    expect(registry.list().map((p) => p.id)).toEqual(['a']);
  });

  it('is not affected by later mutation of the array it was built from', () => {
    const plugins = [fakePlugin('a')];
    const registry = new StaticPluginRegistry(plugins);
    plugins.push(fakePlugin('b'));
    expect(registry.resolve('b')).toBeUndefined();
  });

  it('rejects two plugins with the same id', () => {
    expect(() => new StaticPluginRegistry([fakePlugin('a'), fakePlugin('a')])).toThrow(/duplicate.*"a"/i);
  });

  it('rejects a plugin with an empty id', () => {
    expect(() => new StaticPluginRegistry([fakePlugin('')])).toThrow(/id/i);
  });
});
