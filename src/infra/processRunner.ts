/**
 * Process-execution adapter — implements the `ProcessRunner` port via
 * execa. Generic on purpose: `git init`, `npm install`, and any
 * `run-command` post-action are all just commands the orchestrator
 * interprets and hands to this port.
 *
 * Security: execa is called without `shell: true` and gets command and
 * args as a separate argv array — never a concatenated command string.
 * - POSIX: the command is exec'd directly; no shell ever sees the args.
 * - Windows: `.exe`/`.com` files are spawned directly, but `.cmd`/`.bat`
 *   shims (e.g. `npm.cmd`) and commands that don't resolve to a file are
 *   run through `cmd.exe`. In that case execa itself quotes each argument
 *   and caret-escapes cmd.exe metacharacters (twice for batch shims, which
 *   re-expand `%*`), and it rejects arguments containing CR/LF, which
 *   cmd.exe cannot escape. So args ARE parsed by a shell on Windows; they
 *   are escaped so they arrive as literal strings.
 * This relies on execa's escaping: never pass `shell: true` here, and
 * never build a command string from untrusted input.
 */
import { execa } from 'execa';
import type { ProcessRunner } from '../core/ports.js';

export class ExecaProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
    // stdio inherited so the user sees e.g. npm install progress live.
    // execa rejects with a descriptive ExecaError on non-zero exit / spawn
    // failure, which the orchestrator wraps in PostActionError.
    await execa(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
    });
  }
}
