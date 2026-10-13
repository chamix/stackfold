/**
 * Composition primitive for multi-fragment plugin families
 * (.agents/SK-ADR-001 — "Composable blueprint fragments for multi-flavor
 * plugins"; .agents/specs/initial_scaffold.md — "Technical Specification:
 * web-app plugin family (Cycle 1)").
 *
 * `composeBlueprint()` merges an ordered list of `BlueprintFragment`s into
 * one `ProjectBlueprint`, per `functional_domain_webapp.md` §1's three
 * combination rules made concrete:
 *   - `exclusive` (default) — exactly one fragment may contribute a given
 *     path; a second contributor is a composition-time defect.
 *   - `json-merge` — contributions are JSON-parseable partial objects,
 *     deep-merged key-by-key in fragment order; a scalar/array leaf
 *     conflict is a defect, identical leaf values are not.
 *   - `append` — contributions are treated as newline-separated text and
 *     line-concatenated, de-duplicating exact-duplicate lines while
 *     keeping each line's first-occurrence position.
 *
 * Pure and synchronous — no I/O, same discipline as `buildBlueprint()`
 * itself. Depends only on `core/orchestrator.ts` (one import,
 * `InvalidBlueprintError` — reusing the existing "plugin produced an
 * invalid blueprint" error category rather than introducing a new error
 * class) and `core/types.ts`. This is a one-way dependency:
 * `orchestrator.ts` never imports from this module.
 *
 * `postActions` are NOT one of the three file-merge strategies above —
 * they are simply concatenated across fragments, in fragment order. This
 * is deliberately simpler than the file-merge case and is called out
 * explicitly here so a future reader doesn't look for a fourth merge
 * strategy that doesn't exist.
 */
import { InvalidBlueprintError } from './orchestrator.js';
import type { FileEntry, PostActionDefinition, ProjectBlueprint } from './types.js';

export type MergeStrategy = 'exclusive' | 'json-merge' | 'append';

export interface FileContribution {
  path: string;
  /** For 'json-merge': a JSON-parseable object literal, pre-stringified. */
  content: string | Buffer;
  /** Default: 'exclusive'. */
  strategy?: MergeStrategy;
}

export interface BlueprintFragment {
  /** Identifies this fragment in collision error messages. */
  id: string;
  files: FileContribution[];
  postActions?: PostActionDefinition[];
}

interface Contribution {
  fragmentId: string;
  contribution: FileContribution;
}

/**
 * Merges `fragments` in the given order into one `ProjectBlueprint`.
 * Throws `InvalidBlueprintError` (pluginId = the fragment ids joined with
 * "+", for traceability) on any exclusive collision or json-merge leaf
 * conflict — before any file in the result is considered valid. Zero
 * fragments produces an empty, valid `ProjectBlueprint`.
 */
export function composeBlueprint(fragments: readonly BlueprintFragment[]): ProjectBlueprint {
  const pluginId = fragments.map((f) => f.id).join('+');
  const issues: string[] = [];

  const byPath = new Map<string, Contribution[]>();
  const pathOrder: string[] = [];

  for (const fragment of fragments) {
    for (const file of fragment.files) {
      const existing = byPath.get(file.path);
      if (existing) {
        existing.push({ fragmentId: fragment.id, contribution: file });
      } else {
        byPath.set(file.path, [{ fragmentId: fragment.id, contribution: file }]);
        pathOrder.push(file.path);
      }
    }
  }

  const files: FileEntry[] = [];

  for (const path of pathOrder) {
    // Always set by the loop above for every entry in pathOrder.
    const contributions = byPath.get(path) as Contribution[];

    if (contributions.length === 1) {
      files.push({ path, content: contributions[0]!.contribution.content });
      continue;
    }

    const strategy = effectiveStrategy(path, contributions, issues);

    switch (strategy) {
      case 'exclusive': {
        const ids = contributions.map((c) => c.fragmentId).join(', ');
        issues.push(
          `file path ${JSON.stringify(path)}: exclusive collision between fragments [${ids}] — ` +
            'only one fragment may contribute this path'
        );
        break;
      }
      case 'json-merge': {
        try {
          files.push({ path, content: mergeJson(path, contributions) });
        } catch (cause) {
          issues.push(cause instanceof Error ? cause.message : String(cause));
        }
        break;
      }
      case 'append': {
        files.push({ path, content: mergeAppend(contributions) });
        break;
      }
    }
  }

  if (issues.length > 0) throw new InvalidBlueprintError(pluginId, issues);

  const postActions = fragments.flatMap((f) => f.postActions ?? []);
  return { files, postActions };
}

/**
 * The strategy that governs a multi-contributor path is the one declared
 * by its first contributor (default 'exclusive'); a later contributor
 * declaring a different strategy for the same path is itself a defect,
 * recorded alongside whatever that strategy's own merge produces.
 */
function effectiveStrategy(path: string, contributions: Contribution[], issues: string[]): MergeStrategy {
  const strategy = contributions[0]!.contribution.strategy ?? 'exclusive';
  for (const { fragmentId, contribution } of contributions) {
    const declared = contribution.strategy ?? 'exclusive';
    if (declared !== strategy) {
      issues.push(
        `file path ${JSON.stringify(path)}: fragment "${fragmentId}" declared merge strategy ` +
          `${JSON.stringify(declared)}, conflicting with ${JSON.stringify(strategy)} declared earlier for this path`
      );
    }
  }
  return strategy;
}

// ---------------------------------------------------------------------------
// 'json-merge'
// ---------------------------------------------------------------------------

function mergeJson(path: string, contributions: Contribution[]): string {
  let merged: Record<string, unknown> = {};
  for (const { fragmentId, contribution } of contributions) {
    const parsed = parseJsonObject(path, fragmentId, contribution.content);
    merged = mergeObjects(path, [], merged, parsed);
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function parseJsonObject(path: string, fragmentId: string, content: string | Buffer): Record<string, unknown> {
  const text = content.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `file path ${JSON.stringify(path)}: fragment "${fragmentId}" contributed invalid JSON for a ` +
        `json-merge file: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `file path ${JSON.stringify(path)}: fragment "${fragmentId}" contributed a non-object value for a ` +
        'json-merge file'
    );
  }
  return parsed;
}

/**
 * Recursive, order-of-first-appearance merge (initial_scaffold.md,
 * "Resolving SK-ADR-001's two open questions" §2). At each level: both
 * sides a plain object for the same key → recurse; both sides a
 * non-object value (string/number/boolean/array) for the same leaf key →
 * conflict unless the values are deep-equal. A key's position in the
 * result is the position it first appeared in, across fragments in order
 * — guaranteed here because object spread preserves existing key order
 * and new keys are appended as they're encountered.
 */
function mergeObjects(
  filePath: string,
  keyPath: readonly string[],
  base: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    const nextKeyPath = [...keyPath, key];

    if (!Object.hasOwn(result, key)) {
      result[key] = value;
      continue;
    }

    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = mergeObjects(filePath, nextKeyPath, existing, value);
    } else if (deepEqual(existing, value)) {
      result[key] = existing;
    } else {
      throw new Error(
        `file path ${JSON.stringify(filePath)}: json-merge conflict at key ${JSON.stringify(nextKeyPath.join('.'))} ` +
          `(${JSON.stringify(existing)} vs ${JSON.stringify(value)})`
      );
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 'append'
// ---------------------------------------------------------------------------

/** Line-concatenates contributions, de-duplicating while keeping each line's first-occurrence position. */
function mergeAppend(contributions: Contribution[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const { contribution } of contributions) {
    const text = contribution.content.toString();
    for (const line of text.split('\n')) {
      if (line === '') continue; // drop blank lines from a trailing "\n"
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
