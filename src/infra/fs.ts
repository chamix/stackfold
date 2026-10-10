/**
 * File-system adapter — implements the `FileWriter` port over node:fs so
 * core/ and plugins/ never import node:fs directly.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TargetNotEmptyError, type FileWriter } from '../core/ports.js';

export class NodeFileWriter implements FileWriter {
  /**
   * Creates targetDir if it doesn't exist; rejects with TargetNotEmptyError
   * if it exists and is non-empty, or with a plain Error if it exists but
   * is not a directory (functional_domain §3.3; `options.force` never
   * bypasses this second rejection — see testing finding #1 in
   * initial_scaffold.md).
   *
   * `options.force` skips the non-empty check entirely. Otherwise,
   * `options.ignoreEntries` is filtered out of the directory listing
   * before deciding emptiness. No options (or an empty `ignoreEntries`)
   * is identical to today's behavior.
   */
  async ensureEmptyDir(
    targetDir: string,
    options?: { force?: boolean; ignoreEntries?: readonly string[] }
  ): Promise<void> {
    const dir = resolve(targetDir);

    let isDirectory: boolean;
    try {
      isDirectory = (await stat(dir)).isDirectory();
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) {
        await mkdir(dir, { recursive: true });
        return;
      }
      throw err;
    }

    if (!isDirectory) {
      throw new Error(`Target path ${dir} already exists and is not a directory.`);
    }
    if (options?.force) {
      return;
    }

    const entries = await readdir(dir);
    const ignored = new Set(options?.ignoreEntries ?? []);
    const remaining = ignored.size > 0 ? entries.filter((entry) => !ignored.has(entry)) : entries;
    if (remaining.length > 0) {
      throw new TargetNotEmptyError(dir);
    }
  }

  /**
   * Writes a single file, creating parent directories as needed. Uses the
   * exclusive "wx" flag so an existing file is never silently overwritten
   * (§3.3) — e.g. if something else created it after ensureEmptyDir().
   */
  async writeFile(absolutePath: string, content: string | Buffer): Promise<void> {
    const file = resolve(absolutePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
