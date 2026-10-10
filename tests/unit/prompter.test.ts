import { describe, expect, it } from 'vitest';
import { StaticPrompter } from '../../src/infra/prompter.js';
import type { QuestionDefinition } from '../../src/core/types.js';

describe('StaticPrompter', () => {
  it('returns exactly the answers it was constructed with, regardless of questions asked', async () => {
    const prompter = new StaticPrompter({ appName: 'My App', includeSettings: true });

    const result = await prompter.ask([]);

    expect(result).toEqual({ appName: 'My App', includeSettings: true });
  });

  it('ignores the questions array entirely — no filtering by design (resolveAnswers owns that)', async () => {
    const prompter = new StaticPrompter({ appName: 'My App', includeSettings: true });
    const questions: QuestionDefinition[] = [
      { id: 'somethingElse', message: 'Unrelated?', type: 'input' },
      { id: 'anotherOne', message: 'Also unrelated?', type: 'confirm' },
    ];

    const result = await prompter.ask(questions);

    expect(result).toEqual({ appName: 'My App', includeSettings: true });
  });

  it('returns a fresh copy each call, not the same reference back', async () => {
    const original = { appName: 'My App' };
    const prompter = new StaticPrompter(original);

    const result = await prompter.ask([]);

    expect(result).toEqual(original);
    expect(result).not.toBe(original);
  });
});
