/**
 * Interactive-prompt adapter — implements the `Prompter` port over
 * @inquirer/prompts. Plugins only declare `QuestionDefinition`s; this is
 * the one place that knows about a concrete prompting library, so a
 * non-interactive Prompter (flags/config) can later be swapped in without
 * touching plugin or orchestrator code.
 */
import { confirm, input, select } from '@inquirer/prompts';
import type { Prompter } from '../core/ports.js';
import type { AnswerValue, Answers, QuestionDefinition } from '../core/types.js';

export class InquirerPrompter implements Prompter {
  async ask(questions: QuestionDefinition[]): Promise<Answers> {
    const answers: Answers = {};
    // Sequential on purpose: prompts share one terminal.
    for (const q of questions) {
      answers[q.id] = await askOne(q);
    }
    return answers;
  }
}

async function askOne(q: QuestionDefinition): Promise<AnswerValue> {
  switch (q.type) {
    case 'input':
      return input({
        message: q.message,
        default: q.default === undefined ? undefined : String(q.default),
        validate: q.validate ? (value: string) => q.validate!(value) : undefined,
      });

    case 'confirm':
      return confirm({
        message: q.message,
        default: typeof q.default === 'boolean' ? q.default : undefined,
      });

    case 'select': {
      const choices = q.choices ?? [];
      const fallback = typeof q.default === 'string' && choices.includes(q.default) ? q.default : undefined;
      return select<string>({
        message: q.message,
        choices: choices.map((value) => ({ value, name: value })),
        default: fallback,
      });
    }
  }
}
