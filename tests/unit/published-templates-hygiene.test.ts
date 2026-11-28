import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FIX-009 — permanent guard: nothing a built-in plugin can emit into a
 * user's project (every `.hbs` template, plus every synthesized
 * `scaffold.json`, which embeds them) may reference this project's internal
 * material. Reads the real files under `src/plugins/`.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'src', 'plugins');
const INTERNAL_REFERENCE = /functional_domain|initial_scaffold|SK-ADR|\.agents\//;

function publishedSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return publishedSources(full);
    return entry.name.endsWith('.hbs') || entry.name === 'scaffold.json' ? [full] : [];
  });
}

describe('published plugin templates carry no internal project references (FIX-009)', () => {
  const files = publishedSources(PLUGINS_DIR);

  it('actually scans both templates and synthesized blueprints', () => {
    expect(files.some((f) => f.endsWith('.hbs'))).toBe(true);
    expect(files.some((f) => f.endsWith('scaffold.json'))).toBe(true);
  });

  it('no .hbs or scaffold.json under src/plugins/ matches an internal reference', () => {
    const offenders = files
      .filter((f) => INTERNAL_REFERENCE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).split('\\').join('/'))
      .sort();
    expect(offenders).toEqual([]);
  });
});
