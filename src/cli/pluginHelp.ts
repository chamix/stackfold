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
 *
 * `pluginHeading()` additionally always surfaces the plugin's `id` — the
 * literal value `stackfold init <stack>` expects — highlighted when the
 * terminal supports color (manual testing finding, 2026-10-18: `list`
 * used to print only `help.name`, e.g. "Standalone HTML", with no way to
 * recover the id, e.g. "web-app-standalone-html", actually needed as the
 * `init` argument). Color goes through `picocolors`, chosen over `chalk`
 * for having zero dependencies and no security history (`chalk@5.6.1`
 * was one of the packages compromised in the September 2025 npm
 * supply-chain attack) — see `.agents/backlog.md`. `picocolors` itself
 * decides whether color is actually emitted (`NO_COLOR`, `FORCE_COLOR`,
 * non-TTY stdout all honored), so this file never has to check that.
 */
import pc from 'picocolors';
import type { QuestionDefinition, StackfoldPlugin } from '../core/types.js';

/** The plugin's display name, falling back to its registry `id`. */
export function pluginDisplayName(plugin: StackfoldPlugin): string {
  return plugin.help?.name ?? plugin.id;
}

/** Bold + cyan when the terminal supports color; the id verbatim otherwise. */
function colorizeId(id: string): string {
  return pc.bold(pc.cyan(id));
}

/**
 * `"<displayName> (<id>)"` when they differ, or just the (colorized) id
 * when there's no separate display name — shared by `formatPluginListLine()`
 * and `formatPluginInfo()` so the two headings never drift apart.
 */
function pluginHeading(plugin: StackfoldPlugin): string {
  const name = pluginDisplayName(plugin);
  return name === plugin.id ? colorizeId(name) : `${name} (${colorizeId(plugin.id)})`;
}

/** One line: `"<heading>  <description>"` — used in every stack listing. */
export function formatPluginListLine(plugin: StackfoldPlugin): string {
  return `${pluginHeading(plugin)}  ${plugin.description}`;
}

/**
 * Full `stackfold info <stack>` body, as independent lines (easy to unit
 * test and to join with the caller's own newline convention).
 */
export function formatPluginInfo(plugin: StackfoldPlugin): string[] {
  const lines: string[] = [];

  lines.push(pluginHeading(plugin));
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
