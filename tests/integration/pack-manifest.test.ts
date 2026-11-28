import { execa } from 'execa';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FIX-006 — packaging guard (G2-a). Runs the real `npm pack --dry-run
 * --json` (no doubles, no network: `--dry-run` never hits the registry
 * or writes a tarball) and asserts the published manifest against the
 * *real* `dist/` tree, not a hand-written list of names — so a future
 * template or test file is covered automatically (functional_domain.md
 * invariant 5).
 *
 * Requires `dist/` to already be built, same precondition as
 * `external-plugin-scaffold.test.ts`'s own real-`dist/` tests — this
 * repo's CI always runs `npm run build` before `npm test` (see
 * `ci.yml`), so that's never a cold path in practice. A missing `dist/`
 * fails loudly with a message telling the operator to build first,
 * rather than silently skipping (there is nothing less confusing than a
 * green suite that never actually checked the manifest).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');

const COMPILED_TEST_MODULE = /\.test\.(js|js\.map|d\.ts)$/;

/** Recursively lists every file under `dir`, as POSIX-style paths relative to `base`. */
function listFilesRecursive(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      results.push(relative(base, full).split('\\').join('/'));
    }
  }
  return results;
}

/** The real `npm pack --dry-run --json` manifest for this repo, as packaged file paths. */
async function packedManifestPaths(): Promise<string[]> {
  const { stdout: raw } = await execa('npm', ['pack', '--dry-run', '--json'], { cwd: REPO_ROOT });
  const parsed = JSON.parse(raw) as
    | Array<{ files: Array<{ path: string }> }>
    | Record<string, { files: Array<{ path: string }> }>;
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return entry.files.map((f) => f.path.split('\\').join('/'));
}

let distFiles: string[];
let manifestPaths: Set<string>;

beforeAll(async () => {
  if (!existsSync(DIST_DIR)) {
    throw new Error(
      `pack-manifest.test.ts requires a built dist/ — run "npm run build" first (expected to find: ${DIST_DIR})`
    );
  }
  distFiles = listFilesRecursive(DIST_DIR, REPO_ROOT);
  manifestPaths = new Set(await packedManifestPaths());
  // The real `npm pack` takes ~10 s on Windows under load, past the default hook timeout.
}, 60_000);

describe('npm pack manifest (FIX-006)', () => {
  it('packages every .hbs template and scaffold.json found under dist/', () => {
    const mustBePacked = distFiles.filter((p) => p.endsWith('.hbs') || p.endsWith('scaffold.json'));
    expect(mustBePacked.length).toBeGreaterThan(0); // sanity: the real dist/ actually has templates

    const missing = mustBePacked.filter((p) => !manifestPaths.has(p));
    expect(missing).toEqual([]);
  });

  it('never packages a compiled test module (*.test.js, *.test.js.map, *.test.d.ts)', () => {
    const packedTestModules = [...manifestPaths].filter((p) => COMPILED_TEST_MODULE.test(p));
    expect(packedTestModules).toEqual([]);
  });
});
