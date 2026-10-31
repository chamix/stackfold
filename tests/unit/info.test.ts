import { describe, expect, it } from 'vitest';
import { runInfo } from '../../src/cli/commands/info.js';
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

describe('runInfo', () => {
  it('prints the resolved plugin\'s formatted info and returns 0', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const plugin = fakePlugin('fake', 'fake description', { name: 'Fake Stack', details: 'More prose.' });
    const registry: PluginRegistry = {
      resolve: async (id) => (id === 'fake' ? plugin : undefined),
      list: async () => [plugin],
    };

    const code = await runInfo('fake', { registry, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });

    expect(code).toBe(0);
    expect(stdout).toEqual(['Fake Stack (fake)', 'fake description', '', 'More prose.']);
    expect(stderr).toEqual([]);
  });

  it('reports an unknown stack on stderr, lists available stacks, and returns 1', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const plugin = fakePlugin('fake', 'fake description');
    const registry: PluginRegistry = { resolve: async () => undefined, list: async () => [plugin] };

    const code = await runInfo('rails', { registry, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      'stackfold info: unknown stack "rails".',
      'Available stacks:',
      '  fake',
      '      fake description',
    ]);
  });
});
