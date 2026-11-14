import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm, input, select } from '@inquirer/prompts';
import { InquirerPrompter, StaticPrompter } from '../../src/infra/prompter.js';
import type { QuestionDefinition } from '../../src/core/types.js';

// Stand-in for the terminal: these tests prove the adapter's own mapping
// (QuestionDefinition -> inquirer options, answers keyed by id, sequencing),
// not inquirer's rendering or key handling, which is the library's own contract.
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

const inputMock = vi.mocked(input);
const confirmMock = vi.mocked(confirm);
const selectMock = vi.mocked(select);

describe('InquirerPrompter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty map and never prompts when there are no questions', async () => {
    const result = await new InquirerPrompter().ask([]);

    expect(result).toEqual({});
    expect(inputMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  describe('input questions', () => {
    it('passes the message and leaves default/validate undefined when the question has neither', async () => {
      inputMock.mockResolvedValueOnce('My App');

      const result = await new InquirerPrompter().ask([{ id: 'appName', message: 'App name?', type: 'input' }]);

      expect(result).toEqual({ appName: 'My App' });
      expect(inputMock).toHaveBeenCalledTimes(1);
      expect(inputMock).toHaveBeenCalledWith({ message: 'App name?', default: undefined, validate: undefined });
    });

    it('stringifies the default, since inquirer input defaults are always strings', async () => {
      inputMock.mockResolvedValueOnce('3000');

      await new InquirerPrompter().ask([{ id: 'port', message: 'Port?', type: 'input', default: 3000 }]);

      expect(inputMock).toHaveBeenCalledWith(expect.objectContaining({ default: '3000' }));
    });

    it('keeps an empty-string default instead of treating it as absent', async () => {
      inputMock.mockResolvedValueOnce('');

      await new InquirerPrompter().ask([{ id: 'desc', message: 'Description?', type: 'input', default: '' }]);

      expect(inputMock).toHaveBeenCalledWith(expect.objectContaining({ default: '' }));
    });

    it("forwards the question's validate function: true passes through, an error message is returned as-is", async () => {
      inputMock.mockResolvedValueOnce('ok');
      const validate = vi.fn((value: string | number | boolean) => (value === 'ok' ? (true as const) : 'must be "ok"'));

      await new InquirerPrompter().ask([{ id: 'name', message: 'Name?', type: 'input', validate }]);

      const options = inputMock.mock.calls[0]![0];
      expect(options.validate).toBeTypeOf('function');
      expect(options.validate!('ok')).toBe(true);
      expect(options.validate!('nope')).toBe('must be "ok"');
      expect(validate).toHaveBeenCalledWith('ok');
      expect(validate).toHaveBeenCalledWith('nope');
    });
  });

  describe('confirm questions', () => {
    it('passes a boolean default through unchanged, including false', async () => {
      confirmMock.mockResolvedValueOnce(false);

      const result = await new InquirerPrompter().ask([
        { id: 'intro', message: 'Include intro?', type: 'confirm', default: false },
      ]);

      expect(result).toEqual({ intro: false });
      expect(confirmMock).toHaveBeenCalledWith({ message: 'Include intro?', default: false });
    });

    it('drops a non-boolean default instead of coercing it', async () => {
      confirmMock.mockResolvedValueOnce(true);

      await new InquirerPrompter().ask([{ id: 'intro', message: 'Include intro?', type: 'confirm', default: 'yes' }]);

      expect(confirmMock).toHaveBeenCalledWith({ message: 'Include intro?', default: undefined });
    });

    it('leaves the default undefined when the question has none', async () => {
      confirmMock.mockResolvedValueOnce(true);

      await new InquirerPrompter().ask([{ id: 'intro', message: 'Include intro?', type: 'confirm' }]);

      expect(confirmMock).toHaveBeenCalledWith({ message: 'Include intro?', default: undefined });
    });
  });

  describe('select questions', () => {
    const choices = ['spa-react', 'spa-vue', 'spa-vanilla'];

    it('maps each choice to a {value, name} pair and keeps a default that is one of the choices', async () => {
      selectMock.mockResolvedValueOnce('spa-vue');

      const result = await new InquirerPrompter().ask([
        { id: 'appType', message: 'App type?', type: 'select', choices, default: 'spa-vue' },
      ]);

      expect(result).toEqual({ appType: 'spa-vue' });
      expect(selectMock).toHaveBeenCalledWith({
        message: 'App type?',
        choices: [
          { value: 'spa-react', name: 'spa-react' },
          { value: 'spa-vue', name: 'spa-vue' },
          { value: 'spa-vanilla', name: 'spa-vanilla' },
        ],
        default: 'spa-vue',
      });
    });

    it('drops a default that is not among the choices rather than handing inquirer an invalid one', async () => {
      selectMock.mockResolvedValueOnce('spa-react');

      await new InquirerPrompter().ask([
        { id: 'appType', message: 'App type?', type: 'select', choices, default: 'angular' },
      ]);

      expect(selectMock).toHaveBeenCalledWith(expect.objectContaining({ default: undefined }));
    });

    it('drops a non-string default even when its string form would match a choice', async () => {
      selectMock.mockResolvedValueOnce('1');

      await new InquirerPrompter().ask([
        { id: 'level', message: 'Level?', type: 'select', choices: ['1', '2'], default: 1 },
      ]);

      expect(selectMock).toHaveBeenCalledWith(expect.objectContaining({ default: undefined }));
    });

    it('treats missing choices as an empty list and never sets a default', async () => {
      selectMock.mockResolvedValueOnce('');

      await new InquirerPrompter().ask([{ id: 'appType', message: 'App type?', type: 'select', default: 'spa-vue' }]);

      expect(selectMock).toHaveBeenCalledWith({ message: 'App type?', choices: [], default: undefined });
    });
  });

  describe('ask() across several questions', () => {
    it('keys each answer by its question id, whatever the prompt type', async () => {
      inputMock.mockResolvedValueOnce('My App');
      confirmMock.mockResolvedValueOnce(true);
      selectMock.mockResolvedValueOnce('b');
      const questions: QuestionDefinition[] = [
        { id: 'appName', message: 'Name?', type: 'input' },
        { id: 'git', message: 'Init git?', type: 'confirm' },
        { id: 'flavor', message: 'Flavor?', type: 'select', choices: ['a', 'b'] },
      ];

      const result = await new InquirerPrompter().ask(questions);

      expect(result).toEqual({ appName: 'My App', git: true, flavor: 'b' });
    });

    it('prompts strictly one at a time, in declared order (prompts share one terminal)', async () => {
      const events: string[] = [];
      inputMock.mockImplementationOnce(async () => {
        events.push('input:start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('input:end');
        return 'x';
      });
      confirmMock.mockImplementationOnce(async () => {
        events.push('confirm:start');
        return true;
      });

      await new InquirerPrompter().ask([
        { id: 'first', message: 'First?', type: 'input' },
        { id: 'second', message: 'Second?', type: 'confirm' },
      ]);

      expect(events).toEqual(['input:start', 'input:end', 'confirm:start']);
    });

    it('stops at the first rejected prompt (e.g. Ctrl+C) and propagates the error without asking the rest', async () => {
      const cancelled = new Error('User force closed the prompt');
      inputMock.mockRejectedValueOnce(cancelled);

      await expect(
        new InquirerPrompter().ask([
          { id: 'first', message: 'First?', type: 'input' },
          { id: 'second', message: 'Second?', type: 'confirm' },
        ]),
      ).rejects.toBe(cancelled);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    it('lets a later duplicate id overwrite an earlier answer (last write wins)', async () => {
      inputMock.mockResolvedValueOnce('first').mockResolvedValueOnce('second');

      const result = await new InquirerPrompter().ask([
        { id: 'dup', message: 'One?', type: 'input' },
        { id: 'dup', message: 'Two?', type: 'input' },
      ]);

      expect(result).toEqual({ dup: 'second' });
    });
  });
});

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
