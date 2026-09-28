import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TargetNotEmptyError } from '../../src/core/ports.js';
import { NodeFileWriter } from '../../src/infra/fs.js';

let root: string;
const writer = new NodeFileWriter();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-fs-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

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
