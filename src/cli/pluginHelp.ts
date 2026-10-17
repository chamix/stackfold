/**
 * Pure formatting helpers over the optional `StackfoldPlugin.help`
 * metadata (`core/types.ts`'s `PluginHelp`) — shared by `stackfold list`,
 * `stackfold info <stack>`, and `init`'s own "Available stacks" error
 * listing, so the three never drift into slightly different formats.
 *
 * Every function here degrades gracefully when `help` (or one of its
 * fields) is absent: there is no placeholder text, the corresponding
 * line/section is simply left out (initial design discussion — "ayuda
 * específica, opcional, deseable pero no mandatoria").
 */
import type { QuestionDefinition, StackfoldPlugin } from '../core/types.js';

/** The plugin's display name, falling back to its registry `id`. */
export function pluginDisplayName(plugin: StackfoldPlugin): string {
  return plugin.help?.name ?? plugin.id;
}

/** One line: `"<displayName>  <description>"` — used in every stack listing. */
export function formatPluginListLine(plugin: StackfoldPlugin): string {
  return `${pluginDisplayName(plugin)}  ${plugin.description}`;
}

/**
 * Full `stackfold info <stack>` body, as independent lines (easy to unit
 * test and to join with the caller's own newline convention).
 */
export function formatPluginInfo(plugin: StackfoldPlugin): string[] {
  const name = pluginDisplayName(plugin);
  const lines: string[] = [];

  lines.push(name === plugin.id ? name : `${name} (${plugin.id})`);
  lines.push(plugin.description);

  if (plugin.help?.details) {
    lines.push('');
    lines.push(plugin.help.details);
  }

  const questions = plugin.questions();
  if (questions.length > 0) {
    lines.push('');
    lines.push('Questions:');
    for (const question of questions) lines.push(`  ${formatQuestionLine(question)}`);
  }

  return lines;
}

function formatQuestionLine(question: QuestionDefinition): string {
  const defaultPart = question.default === undefined ? '' : ` [default: ${question.default}]`;
  return `${question.id} (${question.type}): ${question.message}${defaultPart}`;
}
