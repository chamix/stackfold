/**
 * File-system adapter — implements the `FileWriter` port over node:fs so
 * core/ and plugins/ never import node:fs directly.
 */
import { execSync } from 'node:child_process';
import { lstat, mkdir, readFile as fsReadFile, readdir, rmdir, unlink, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { TargetNotEmptyError, type FileRemover, type FileWriter } from '../core/ports.js';

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

  /**
   * New (Task 034). `resolve()` resolves a relative path against
   * `process.cwd()` the same way `ensureEmptyDir`/`writeFile` already do —
   * `patchFile` (core/authoring.ts) relies on exactly this for its own
   * `path` param, which is deliberately not pre-resolved to an absolute
   * path by core/ (Inward Dependency Rule: no node:path there).
   */
  async readFile(absolutePath: string): Promise<string | undefined> {
    try {
      return await fsReadFile(resolve(absolutePath), 'utf8');
    } catch (err) {
      if (isErrnoCode(err, 'ENOENT')) return undefined;
      throw err;
    }
  }

  /**
   * New (Task 034). Unlike `writeFile`, this overwrites an existing file —
   * reserved for hook-level actions (e.g. `patchFile`) that already read
   * the file first and know it exists. No exclusive "wx" flag here; that
   * guarantee belongs to `writeFile` alone and is untouched by this method.
   */
  async overwriteFile(absolutePath: string, content: string): Promise<void> {
    const file = resolve(absolutePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/**
 * File-system adapter for `FileRemover` (ARCH-004 / SK-ADR-006) — the
 * orchestrator's own, narrow deletion capability over node:fs. A single
 * instance is wired once in `cli/index.ts` and reused for every `init` run;
 * `root` (the run's `targetDir`) is passed in on every call rather than
 * held as instance state, so containment is always verified against the
 * run that is actually compensating, never a stale value.
 *
 * Security invariants (`.claude/knowledge/security/general.md` —
 * deletion + path containment):
 *   - Every path is `resolve()`d and verified to sit strictly *inside*
 *     `root` before anything touches disk; `root` itself is never a valid
 *     target (D4 — `targetDir` is never removed, even if mis-passed here).
 *   - `removeFile` `lstat`s first (never following a symlink) and refuses
 *     anything that is not a plain file — a symlink or a directory is left
 *     untouched, not deleted.
 *   - No recursive delete anywhere: `unlink` for files, `rmdir` for
 *     directories (which itself refuses a non-empty directory).
 *   - A missing path is tolerated as a no-op in both methods — the journal
 *     entry is already gone, which is the desired end state, not a failure.
 */
export class NodeFileRemover implements FileRemover {
  constructor(
    private readonly options: { maxRetries?: number; retryDelayMs?: number } = {}
  ) {}

  async removeFile(absolutePath: string, root: string): Promise<void> {
    const file = resolve(absolutePath);
    const base = resolve(root);
    assertContained(file, base);

    const stats = await lstat(file).catch((err) => {
      if (isErrnoCode(err, 'ENOENT')) return undefined;
      throw err;
    });
    if (stats === undefined) return;

    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to remove ${file}: not a regular file (symlink or directory).`);
    }

    await this.withRetries(async () => {
      try {
        await unlink(file);
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) return;
        throw err;
      }
    });
  }

  async removeDirIfEmpty(absolutePath: string, root: string): Promise<void> {
    const dir = resolve(absolutePath);
    const base = resolve(root);
    assertContained(dir, base);

    await this.withRetries(async () => {
      try {
        await rmdir(dir);
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT') || isErrnoCode(err, 'ENOTEMPTY')) return;
        throw err;
      }
    });
  }

  /**
   * Bounded retries (D6) for the transient Windows `EBUSY`/`EPERM` a
   * freshly written file's handle can still briefly hold. Any other error
   * (containment violation, refusal, genuine permission failure) is never
   * retried — it is already final.
   */
  private async withRetries(fn: () => Promise<void>): Promise<void> {
    const maxRetries = this.options.maxRetries ?? 5;
    const retryDelayMs = this.options.retryDelayMs ?? 50;

    for (let attempt = 0; ; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        const retryable = isErrnoCode(err, 'EBUSY') || isErrnoCode(err, 'EPERM');
        if (!retryable || attempt >= maxRetries) throw err;
        await delay(retryDelayMs);
      }
    }
  }
}

/**
 * `root` is never itself a valid target (D4) — `absolutePath` must sit
 * strictly below it, not equal to it.
 */
function assertContained(absolutePath: string, root: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolutePath === root || !absolutePath.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to remove ${absolutePath}: outside root ${root}.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Real `git config --get user.name` read (Task 034 review follow-up,
 * Should-fix #2). Relocated here from `plugins/plugin-builder/scaffold.ts` —
 * a concrete, `node:child_process`-backed adapter belongs in `infra/`,
 * chosen and injected by `cli/index.ts` (the composition root), the same
 * discipline already applied to `NodeFileWriter`/`ExecaProcessRunner`/
 * `InquirerPrompter`/`JsonLogicExpressionEvaluator` — never defaulted
 * inside a plugin module.
 *
 * Deliberately synchronous: `plugin-builder`'s "author" question needs
 * this value as a plain `QuestionDefinition.default` *before*
 * `ports.prompter.ask()` ever runs (see `plugin-builder/scaffold.ts`'s own
 * `PluginBuilderOptions.gitUserName` doc comment for the full reasoning —
 * a `preInit` hook runs too late to retroactively change what default the
 * user was already shown). Throws whenever the probe itself fails (git not
 * installed, no global `user.name` configured, or any other non-zero
 * exit) — the caller (`resolveDefaultAuthor()`) is responsible for
 * treating that failure as "no local git identity available," not this
 * function.
 */
export function defaultGitUserName(): string {
  return execSync('git config --get user.name', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
