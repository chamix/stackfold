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
 * when there's no separate display name — shared by `formatPluginListEntry()`
 * and `formatPluginInfo()` so the two headings never drift apart.
 */
function pluginHeading(plugin: StackfoldPlugin): string {
  const name = pluginDisplayName(plugin);
  return name === plugin.id ? colorizeId(name) : `${name} (${colorizeId(plugin.id)})`;
}

/**
 * Width, in characters, that `formatPluginListEntry()` wraps a plugin's
 * description to (before the indent below is added). Deliberately a
 * fixed constant rather than terminal-width detection: descriptions are
 * a few sentences at most, a plain constant keeps the output identical
 * run to run (and easy to assert on in tests), and 76 columns reads
 * comfortably even on a standard 80-column terminal once the 2-space
 * `list`/`init` caller prefix is added on top.
 */
const LIST_DESCRIPTION_WIDTH = 76;
const LIST_DESCRIPTION_INDENT = '    ';

/** Greedy word-wrap: breaks `text` into lines no longer than `width` (never splits a word). */
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length > width && current !== '') {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * One plugin's `stackfold list` / "Available stacks" entry: a heading
 * line (`pluginHeading()`), then its description word-wrapped and
 * indented onto its own line(s) — so a longer description reads as a
 * short, legible paragraph instead of one line that runs past the
 * terminal's right edge and wraps wherever the terminal happens to
 * break it. Used by `list`, `info`'s "unknown stack" fallback, and
 * `init`'s own "Available stacks" error listing.
 */
export function formatPluginListEntry(plugin: StackfoldPlugin): string[] {
  return [
    pluginHeading(plugin),
    ...wrapText(plugin.description, LIST_DESCRIPTION_WIDTH).map((line) => `${LIST_DESCRIPTION_INDENT}${line}`),
  ];
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
