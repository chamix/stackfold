import { describe, expect, it } from 'vitest';
import { formatPluginInfo, formatPluginListEntry, pluginDisplayName } from '../../src/cli/pluginHelp.js';
import type { QuestionDefinition, StackfoldPlugin } from '../../src/core/types.js';

function fakePlugin(overrides: Partial<StackfoldPlugin> & { id: string; description: string }): StackfoldPlugin {
  return {
    questions: () => [],
    buildBlueprint: () => ({ files: [], postActions: [] }),
    ...overrides,
  };
}

describe('pluginDisplayName', () => {
  it('falls back to the plugin id when help.name is absent', () => {
    const plugin = fakePlugin({ id: 'web-app-spa', description: 'desc' });
    expect(pluginDisplayName(plugin)).toBe('web-app-spa');
  });

  it('falls back to the plugin id when help itself is absent', () => {
    const plugin = fakePlugin({ id: 'web-app-spa', description: 'desc', help: {} });
    expect(pluginDisplayName(plugin)).toBe('web-app-spa');
  });

  it('uses help.name when provided', () => {
    const plugin = fakePlugin({ id: 'web-app-spa', description: 'desc', help: { name: 'Web App (SPA)' } });
    expect(pluginDisplayName(plugin)).toBe('Web App (SPA)');
  });
});

describe('formatPluginListEntry', () => {
  it('returns a heading line plus the description on its own indented line, with no help ' +
    '(name falls back to id, so no parens)', () => {
    const plugin = fakePlugin({ id: 'fake', description: 'fake description' });
    expect(formatPluginListEntry(plugin)).toEqual(['fake', '    fake description']);
  });

  it('includes the plugin id in parens alongside the display name when help.name is set — ' +
    'the id is the literal value `stackfold init <stack>` expects (manual testing finding, 2026-10-18: ' +
    'list used to print only the display name, with no way to recover the id from it)', () => {
    const plugin = fakePlugin({ id: 'fake', description: 'fake description', help: { name: 'Fake Stack' } });
    expect(formatPluginListEntry(plugin)).toEqual(['Fake Stack (fake)', '    fake description']);
  });

  it('word-wraps a description longer than the list width onto several indented lines, ' +
    'never splitting a word (visual-readability fix, 2026-10-27: a long description used to run ' +
    'past the terminal edge as one line and wrap wherever the terminal happened to break it)', () => {
    const longDescription =
      'Electron plus TypeScript desktop app shell with sandboxed windows, an external link policy, ' +
      'and a narrow preload bridge, authored declaratively via the scaffold authoring system as a ' +
      'functional port of the hand written plugin it replaces.';
    const plugin = fakePlugin({ id: 'fake', description: longDescription });
    const lines = formatPluginListEntry(plugin);

    expect(lines[0]).toBe('fake');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('    ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(lines.slice(1).join(' ').replace(/\s+/g, ' ').trim()).toBe(longDescription);
  });
});

describe('formatPluginInfo', () => {
  it('omits the details section entirely when help is absent', () => {
    const plugin = fakePlugin({ id: 'fake', description: 'fake description' });
    const lines = formatPluginInfo(plugin);

    expect(lines).toEqual(['fake', 'fake description']);
  });

  it('omits the details section when help is present but details is not', () => {
    const plugin = fakePlugin({ id: 'fake', description: 'fake description', help: { name: 'Fake Stack' } });
    const lines = formatPluginInfo(plugin);

    expect(lines).toEqual(['Fake Stack (fake)', 'fake description']);
  });

  it('includes the details block when provided, after a blank line', () => {
    const plugin = fakePlugin({
      id: 'fake',
      description: 'fake description',
      help: { name: 'Fake Stack', details: 'Longer prose about the plugin.' },
    });
    const lines = formatPluginInfo(plugin);

    expect(lines).toEqual(['Fake Stack (fake)', 'fake description', '', 'Longer prose about the plugin.']);
  });

  it('lists questions, including a default when one is declared', () => {
    const questions: QuestionDefinition[] = [
      { id: 'appName', message: 'Application name', type: 'input', default: 'my-app' },
      { id: 'includeFoo', message: 'Include foo?', type: 'confirm', default: false },
    ];
    const plugin = fakePlugin({ id: 'fake', description: 'fake description', questions: () => questions });
    const lines = formatPluginInfo(plugin);

    expect(lines).toEqual([
      'fake',
      'fake description',
      '',
      'Questions:',
      '  appName (input): Application name [default: my-app]',
      '  includeFoo (confirm): Include foo? [default: false]',
    ]);
  });

  it('omits the questions section entirely when there are none', () => {
    const plugin = fakePlugin({ id: 'fake', description: 'fake description' });
    expect(formatPluginInfo(plugin)).not.toContain('Questions:');
  });
});
