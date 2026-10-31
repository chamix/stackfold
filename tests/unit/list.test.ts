import { describe, expect, it } from 'vitest';
import { runList } from '../../src/cli/commands/list.js';
import type { PluginRegistry } from '../../src/core/ports.js';
import type { StackfoldPlugin } from '../../src/core/types.js';

function fakePlugin(id: string, description: string, help?: StackfoldPlugin['help']): StackfoldPlugin {
  return {
    id,
    description,
    help,
    questions: () => [],
    buildBlueprint: () => ({ files: [], postActions: [] }),
  };
}

describe('runList', () => {
  it('lists every registered plugin as its own block, separated by a blank line', async () => {
    const stdout: string[] = [];
    const registry: PluginRegistry = {
      resolve: async () => undefined,
      list: async () => [fakePlugin('fake', 'fake description'), fakePlugin('other', 'other description')],
    };

    await runList({ registry, stdout: (l) => stdout.push(l) });

    expect(stdout).toEqual([
      'Available stacks:',
      '  fake',
      '      fake description',
      '',
      '  other',
      '      other description',
    ]);
  });

  it('uses the display name from help.name when present', async () => {
    const stdout: string[] = [];
    const registry: PluginRegistry = {
      resolve: async () => undefined,
      list: async () => [fakePlugin('fake', 'fake description', { name: 'Fake Stack' })],
    };

    await runList({ registry, stdout: (l) => stdout.push(l) });

    expect(stdout).toEqual(['Available stacks:', '  Fake Stack (fake)', '      fake description']);
  });

  it('reports no plugins registered rather than an empty list', async () => {
    const stdout: string[] = [];
    const registry: PluginRegistry = { resolve: async () => undefined, list: async () => [] };

    await runList({ registry, stdout: (l) => stdout.push(l) });

    expect(stdout).toEqual(['No plugins registered.']);
  });
});
