import { describe, expect, it, vi } from 'vitest';
import { runPlugin } from '../../src/core/orchestrator.js';
import type { StackfoldPlugin } from '../../src/core/types.js';

describe('runPlugin', () => {
  it('calls prompts() then generate() with the collected answers', async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    const fakePlugin: StackfoldPlugin = {
      name: 'fake',
      description: 'fake plugin for orchestrator test',
      prompts: vi.fn().mockResolvedValue({ appName: 'demo' }),
      generate,
    };

    await runPlugin(fakePlugin, '/tmp/demo');

    expect(fakePlugin.prompts).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith('/tmp/demo', { appName: 'demo' });
  });
});
