import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `withRetries()` is private and only reacts to errors real filesystems raise
// transiently on Windows (EBUSY/EPERM), so it is exercised here by making the
// `unlink` the remover calls fail on demand. Everything else stays real.
const unlinkMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: (...args: Parameters<typeof actual.unlink>) => unlinkMock(...args) ?? actual.unlink(...args),
  };
});

import { NodeFileRemover } from '../../src/infra/fs.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('NodeFileRemover — bounded retries on transient Windows errors (D6)', () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    unlinkMock.mockReset();
    root = await mkdtemp(join(tmpdir(), 'stackfold-fs-retries-'));
    file = join(root, 'a.txt');
    await writeFile(file, 'x');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retries EBUSY and succeeds once the lock clears', async () => {
    unlinkMock.mockImplementationOnce(() => Promise.reject(errno('EBUSY'))).mockImplementationOnce(() => Promise.reject(errno('EPERM')));
    const remover = new NodeFileRemover({ maxRetries: 5, retryDelayMs: 1 });

    await expect(remover.removeFile(file, root)).resolves.toBeUndefined();

    // 2 failures + the real unlink on the third attempt (the mock returns undefined, falling through).
    expect(unlinkMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last transient error', async () => {
    unlinkMock.mockImplementation(() => Promise.reject(errno('EBUSY')));
    const remover = new NodeFileRemover({ maxRetries: 2, retryDelayMs: 1 });

    await expect(remover.removeFile(file, root)).rejects.toMatchObject({ code: 'EBUSY' });

    expect(unlinkMock).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it('does not retry an error that is not transient', async () => {
    unlinkMock.mockImplementation(() => Promise.reject(errno('EACCES')));
    const remover = new NodeFileRemover({ maxRetries: 5, retryDelayMs: 1 });

    await expect(remover.removeFile(file, root)).rejects.toMatchObject({ code: 'EACCES' });

    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });
});
