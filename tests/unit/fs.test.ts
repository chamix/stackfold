import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { symlinkSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TargetNotEmptyError } from '../../src/core/ports.js';
import { NodeFileRemover, NodeFileWriter } from '../../src/infra/fs.js';

let root: string;
const writer = new NodeFileWriter();
const remover = new NodeFileRemover();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-fs-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * This repo's own Windows runs cannot create filesystem symlinks without
 * elevation/Developer Mode (observed directly: `EPERM`) — see the
 * delegation's own Windows-quirks note. Probed once, synchronously, so the
 * one "symlink refused" test below degrades to a documented skip instead of
 * a false failure on an environment that can't exercise it at all.
 */
const symlinksSupported = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'stackfold-fs-symlink-probe-'));
  try {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'probe');
    symlinkSync(target, join(dir, 'link.txt'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe('NodeFileWriter.ensureEmptyDir — §3.3 no pre-existing project is touched', () => {
  it('creates a target that does not exist yet (including missing parents)', async () => {
    const target = join(root, 'a', 'b', 'new-project');

    await writer.ensureEmptyDir(target);

    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it('accepts an existing empty directory and leaves it empty', async () => {
    const target = join(root, 'empty');
    await mkdir(target);

    await expect(writer.ensureEmptyDir(target)).resolves.toBeUndefined();
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects a non-empty directory with TargetNotEmptyError and leaves its contents untouched', async () => {
    const target = join(root, 'existing');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'original');

    const err = await writer.ensureEmptyDir(target).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TargetNotEmptyError);
    expect((err as TargetNotEmptyError).targetDir).toBe(target);
    expect(await readdir(target)).toEqual(['keep.txt']);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('treats a directory containing only a dotfile as non-empty', async () => {
    const target = join(root, 'dotfile-only');
    await mkdir(target);
    await writeFile(join(target, '.git'), '');

    await expect(writer.ensureEmptyDir(target)).rejects.toBeInstanceOf(TargetNotEmptyError);
  });

  it('rejects a target path that is an existing file, without modifying it', async () => {
    const target = join(root, 'a-file');
    await writeFile(target, 'not a dir');

    await expect(writer.ensureEmptyDir(target)).rejects.toThrow(/not a directory/);
    expect(await readFile(target, 'utf8')).toBe('not a dir');
  });
});

describe('NodeFileWriter.ensureEmptyDir — governance allowlist & --force (testing finding #1)', () => {
  it('ignores the named entries when deciding emptiness', async () => {
    const target = join(root, 'governance-only');
    await mkdir(target);
    await writeFile(join(target, '.git'), '');
    await mkdir(join(target, '.agents'));

    await expect(
      writer.ensureEmptyDir(target, { ignoreEntries: ['.git', '.agents'] })
    ).resolves.toBeUndefined();
    expect(await readdir(target)).toEqual(['.agents', '.git']);
  });

  it('still rejects when a non-ignored entry sits alongside the ignored ones', async () => {
    const target = join(root, 'governance-plus-real');
    await mkdir(target);
    await writeFile(join(target, '.git'), '');
    await mkdir(join(target, '.agents'));
    await writeFile(join(target, 'real-file.txt'), 'conflict');

    await expect(
      writer.ensureEmptyDir(target, { ignoreEntries: ['.git', '.agents'] })
    ).rejects.toBeInstanceOf(TargetNotEmptyError);
  });

  it('force:true skips the non-empty check and leaves existing content untouched', async () => {
    const target = join(root, 'forced');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'original');

    await expect(writer.ensureEmptyDir(target, { force: true })).resolves.toBeUndefined();
    expect(await readdir(target)).toEqual(['keep.txt']);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('force:true still rejects when the target path is an existing file', async () => {
    const target = join(root, 'forced-file');
    await writeFile(target, 'not a dir');

    await expect(writer.ensureEmptyDir(target, { force: true })).rejects.toThrow(/not a directory/);
    expect(await readFile(target, 'utf8')).toBe('not a dir');
  });
});

describe('NodeFileWriter.writeFile', () => {
  it('writes string content, creating nested parent directories', async () => {
    const file = join(root, 'proj', 'src', 'deep', 'index.ts');

    await writer.writeFile(file, 'export {};');

    expect(await readFile(file, 'utf8')).toBe('export {};');
  });

  it('writes Buffer content byte-for-byte', async () => {
    const file = join(root, 'bin.dat');
    const bytes = Buffer.from([0, 1, 2, 255]);

    await writer.writeFile(file, bytes);

    expect(await readFile(file)).toEqual(bytes);
  });

  it('refuses to overwrite an existing file (wx) and leaves it untouched', async () => {
    const file = join(root, 'exists.txt');
    await writeFile(file, 'original');

    const err = await writer.writeFile(file, 'replacement').catch((e: unknown) => e);

    expect((err as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(await readFile(file, 'utf8')).toBe('original');
  });
});

describe('NodeFileRemover.removeFile — ARCH-004/SK-ADR-006 deletion invariants', () => {
  it('removes a plain file that is inside root', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'A');

    await remover.removeFile(file, root);

    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a nested plain file that is inside root', async () => {
    const file = join(root, 'src', 'nested', 'b.ts');
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(file, 'B');

    await remover.removeFile(file, root);

    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tolerates a path that is already missing (no-op, does not throw)', async () => {
    const file = join(root, 'never-existed.txt');
    await expect(remover.removeFile(file, root)).resolves.toBeUndefined();
  });

  it('rejects a path that resolves outside root, and leaves it untouched', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'stackfold-fs-outside-'));
    const outsideFile = join(outsideRoot, 'escape.txt');
    await writeFile(outsideFile, 'should survive');

    try {
      await expect(remover.removeFile(outsideFile, root)).rejects.toThrow(/outside root/);
      expect(await readFile(outsideFile, 'utf8')).toBe('should survive');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects removing root itself, even if it were (mis-)passed as the target path', async () => {
    await expect(remover.removeFile(root, root)).rejects.toThrow(/outside root/);
  });

  it('refuses a directory (not a plain file) and leaves it untouched', async () => {
    const dir = join(root, 'a-directory');
    await mkdir(dir);

    await expect(remover.removeFile(dir, root)).rejects.toThrow(/not a regular file/);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it.skipIf(!symlinksSupported)(
    'refuses a symlink and leaves both it and its target untouched',
    async () => {
      const target = join(root, 'target.txt');
      await writeFile(target, 'real content');
      const link = join(root, 'link.txt');
      await symlink(target, link, 'file');

      await expect(remover.removeFile(link, root)).rejects.toThrow(/not a regular file|symlink/);
      expect(await readFile(target, 'utf8')).toBe('real content');
    }
  );
});

describe('NodeFileRemover.removeDirIfEmpty — ARCH-004/SK-ADR-006 deletion invariants', () => {
  it('removes an empty directory that is inside root', async () => {
    const dir = join(root, 'empty-sub');
    await mkdir(dir);

    await remover.removeDirIfEmpty(dir, root);

    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a non-empty directory untouched, without throwing', async () => {
    const dir = join(root, 'non-empty');
    await mkdir(dir);
    await writeFile(join(dir, 'keep.txt'), 'keep me');

    await expect(remover.removeDirIfEmpty(dir, root)).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual(['keep.txt']);
  });

  it('tolerates an already-missing directory (no-op, does not throw)', async () => {
    const dir = join(root, 'never-existed-dir');
    await expect(remover.removeDirIfEmpty(dir, root)).resolves.toBeUndefined();
  });

  it('rejects a call targeting root itself, even when root is empty (D4: targetDir is never removed)', async () => {
    await expect(remover.removeDirIfEmpty(root, root)).rejects.toThrow(/outside root/);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('rejects a directory that resolves outside root', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'stackfold-fs-outside-'));
    try {
      await expect(remover.removeDirIfEmpty(outsideRoot, root)).rejects.toThrow(/outside root/);
      expect((await stat(outsideRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('prunes deepest-first when called bottom-up, leaving root behind', async () => {
    const nested = join(root, 'src', 'nested');
    await mkdir(nested, { recursive: true });

    await remover.removeDirIfEmpty(nested, root);
    await remover.removeDirIfEmpty(join(root, 'src'), root);

    await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
