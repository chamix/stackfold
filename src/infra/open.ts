/**
 * Native-OS "open" adapter (Task 044, UX-001 RF-3) — opens an absolute
 * path (a folder or a file) with the operating system's own default
 * application, via a 3-platform `execa` switch: `explorer` on win32,
 * `open` on darwin, `xdg-open` on every other platform (linux and the
 * handful of other POSIX platforms Node reports here — treated the same
 * as linux, since `xdg-open` is the POSIX desktop convention, not a
 * Linux-specific one).
 *
 * Deliberately CLI-layer-only (`.agents/specs/044-open-on-init-fs-cleanup.md`
 * RF-3): unlike `core/ports.ts`'s three narrow I/O ports, `ProjectOpener`
 * never flows through `StackfoldPlugin`/`ProjectBlueprint`/`runPlugin()` —
 * it is a post-`init` CLI concern (`cli/commands/init.ts`'s own post-init
 * prompt), not part of the plugin contract. It therefore lives here, in
 * `infra/`, with its own narrow interface, rather than growing
 * `core/ports.ts` for a concern `core/` never needs to see (ISP/DIP, same
 * reasoning `core/ports.ts`'s header comment already applies to its own
 * three ports).
 *
 * One method, not two ("open folder" / "open file"), because every one of
 * the three underlying commands (`explorer`/`open`/`xdg-open`) already
 * accepts either a directory or a file path and hands it to the OS's own
 * default-application resolution — no distinct behavior to model here.
 *
 * Security (`.claude/knowledge/nodejs/security.md`, SEC-001's own
 * invariant for `ExecaProcessRunner` — `infra/processRunner.ts`'s header
 * comment, which this adapter deliberately mirrors): `execa` is called
 * without `shell: true`, with `command`/`absolutePath` passed as a
 * separate argv array, never a concatenated command string. This is a
 * second, independent `execa` call site from `ExecaProcessRunner` — not a
 * `ProcessRunner`, and not reused as one, since `ProcessRunner.run()`'s own
 * `PostActionDefinition`-shaped contract has nothing to do with "open this
 * path with the OS default app" — but it inherits the exact same
 * no-`shell:true` discipline.
 */
import { execa } from 'execa';

export interface ProjectOpener {
  /** Opens `absolutePath` (a folder or a file) with the OS default application. */
  open(absolutePath: string): Promise<void>;
}

/**
 * `win32`'s `explorer.exe` is documented (and confirmed empirically here,
 * on this very machine, opening this repo's own cwd — see this task's
 * delegation report) to frequently exit non-zero even when it successfully
 * opened the folder/file it was handed. Treating that as this adapter's
 * own failure would reject a "successful" open from the caller's point of
 * view — so a rejection from `explorer` specifically is swallowed, never
 * propagated. `open` (darwin) and `xdg-open` (linux/other POSIX) carry no
 * such caveat and still propagate a real failure (e.g. the binary missing
 * entirely) normally.
 */
export class NativeOpener implements ProjectOpener {
  async open(absolutePath: string): Promise<void> {
    const { command, args } = commandFor(process.platform, absolutePath);

    try {
      await execa(command, args, { stdio: 'ignore' });
    } catch (err) {
      if (command === 'explorer') return;
      throw err;
    }
  }
}

function commandFor(platform: NodeJS.Platform, absolutePath: string): { command: string; args: string[] } {
  switch (platform) {
    case 'win32':
      return { command: 'explorer', args: [absolutePath] };
    case 'darwin':
      return { command: 'open', args: [absolutePath] };
    default:
      return { command: 'xdg-open', args: [absolutePath] };
  }
}
