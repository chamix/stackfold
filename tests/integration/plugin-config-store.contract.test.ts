import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realPluginConfigStore } from '../../src/infra/dynamicPluginRegistry.js';

/**
 * Real cosmiconfig contract for `realPluginConfigStore`'s `'project'` level
 * — the only code in this repo that calls cosmiconfig directly. Until now
 * every test that touched `DynamicPluginRegistry`/`cli/commands/plugin.ts`
 * stubbed `PluginConfigStore` with canned values, so cosmiconfig's own
 * search behavior (in particular its default `searchStrategy` across
 * major versions) was never exercised by any test. No double anywhere in
 * this file: real temp directories, real cosmiconfig, real fs.
 *
 * Every fixture plants an explicit `package.json` at its own root as the
 * project boundary, so a "not found" result here never accidentally
 * depends on whatever real ancestors happen to exist above the OS temp
 * directory on the machine running this suite.
 */

let root: string;

beforeEach(async () => {
  const made = await mkdtemp(join(tmpdir(), 'stackfold-plugin-config-contract-'));
  // Normalize (Windows 8.3 short names / macOS `/private` symlink) before
  // any comparison against a path cosmiconfig itself returns.
  root = realpathSync.native(made);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function writeConfig(dir: string, plugins: Record<string, unknown> = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filepath = join(dir, '.stackfold-pluginsrc.json');
  await writeFile(filepath, JSON.stringify({ plugins }), 'utf8');
  return filepath;
}

async function writePackageJson(dir: string, extra: Record<string, unknown> = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filepath = join(dir, 'package.json');
  await writeFile(filepath, JSON.stringify({ name: 'fixture', version: '0.0.0', ...extra }), 'utf8');
  return filepath;
}

describe('realPluginConfigStore — project-level search/write, real cosmiconfig (no doubles)', () => {
  it('1. config in the starting directory itself is found (regression guard — today\'s behavior)', async () => {
    const configPath = await writeConfig(root);
    await writePackageJson(root);

    const found = await realPluginConfigStore.findExistingFilepath('project', root);

    expect(found).toBe(configPath);
  });

  it('2. config in the grandparent is found by walking upward (the bug: fails without searchStrategy: "project")', async () => {
    await writePackageJson(root);
    const configPath = await writeConfig(root);
    const deeper = join(root, 'sub', 'deeper');
    await mkdir(deeper, { recursive: true });

    const found = await realPluginConfigStore.findExistingFilepath('project', deeper);

    expect(found).toBe(configPath);
  });

  it('3. nearest config wins over a topmost one when both exist in the ancestor chain', async () => {
    await writePackageJson(root);
    await writeConfig(root, { topmost: { source: 'topmost', kind: 'npm-package' } });
    const sub = join(root, 'sub');
    const nearConfigPath = await writeConfig(sub, { nearest: { source: 'nearest', kind: 'npm-package' } });
    const deeper = join(sub, 'deeper');
    await mkdir(deeper, { recursive: true });

    const found = await realPluginConfigStore.findExistingFilepath('project', deeper);

    expect(found).toBe(nearConfigPath);
  });

  it('4. a package.json boundary blocks the ascent past it — a config above that boundary is not found', async () => {
    await writePackageJson(root); // config lives here, above the sub-package boundary
    const configPath = await writeConfig(root);
    const pkgDir = join(root, 'pkg');
    await writePackageJson(pkgDir); // its own, separate project boundary, no config of its own
    const src = join(pkgDir, 'src');
    await mkdir(src, { recursive: true });

    const found = await realPluginConfigStore.findExistingFilepath('project', src);

    expect(found).not.toBe(configPath);
    expect(found).toBeUndefined();
  });

  it('5. inclusive boundary — a directory with both package.json and a config is itself still searched', async () => {
    await writePackageJson(root);
    const configPath = await writeConfig(root);
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });

    const found = await realPluginConfigStore.findExistingFilepath('project', sub);

    expect(found).toBe(configPath);
  });

  it('6. no config anywhere in the bounded tree resolves to undefined, no exception thrown', async () => {
    await writePackageJson(root);
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });

    await expect(realPluginConfigStore.findExistingFilepath('project', sub)).resolves.toBeUndefined();
  });

  it('7. a package.json with its own "stackfold-plugins" property counts as the config file itself', async () => {
    const pkgPath = await writePackageJson(root, { 'stackfold-plugins': { plugins: {} } });
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });

    const found = await realPluginConfigStore.findExistingFilepath('project', sub);
    expect(found).toBe(pkgPath);

    const writeTarget = await realPluginConfigStore.resolveWriteFilepath('project', sub);
    expect(writeTarget).toBe(join(root, '.stackfold-pluginsrc.json'));
  });

  it('8. write-path resolution: an existing ancestor config wins; no config anywhere falls back to cwd', async () => {
    await writePackageJson(root);
    const configPath = await writeConfig(root);
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });

    const withExisting = await realPluginConfigStore.resolveWriteFilepath('project', sub);
    expect(withExisting).toBe(configPath);

    const emptyRoot = await mkdtemp(join(tmpdir(), 'stackfold-plugin-config-contract-empty-'));
    const normalizedEmptyRoot = realpathSync.native(emptyRoot);
    try {
      await writePackageJson(normalizedEmptyRoot);
      const noneFound = await realPluginConfigStore.resolveWriteFilepath('project', normalizedEmptyRoot);
      expect(noneFound).toBe(join(normalizedEmptyRoot, '.stackfold-pluginsrc.json'));
    } finally {
      await rm(normalizedEmptyRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('9. end-to-end round-trip: writeEntries at the root, readEntries via the filepath found from a subdirectory', async () => {
    await writePackageJson(root);
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });

    // Nothing registered yet anywhere in the tree, so resolving the write
    // target *from the root* (as `plugin register --project` run at the
    // root would) falls back to a brand-new file at the root itself.
    const writeTarget = await realPluginConfigStore.resolveWriteFilepath('project', root);
    expect(writeTarget).toBe(join(root, '.stackfold-pluginsrc.json'));

    await realPluginConfigStore.writeEntries(writeTarget, {
      'round-trip-fixture': { source: 'my-plugin.json', kind: 'scaffold-json' },
    });

    const found = await realPluginConfigStore.findExistingFilepath('project', sub);
    expect(found).toBe(writeTarget);

    const entries = await realPluginConfigStore.readEntries(found as string);
    expect(entries).toEqual({ 'round-trip-fixture': { source: 'my-plugin.json', kind: 'scaffold-json' } });
  });
});
