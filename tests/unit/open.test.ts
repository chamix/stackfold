import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Task 044 (UX-001 RF-3): `src/infra/open.ts`'s `NativeOpener` is the one
// file in this task allowed to call `execa` for the "open with the OS
// default app" concern — mocked here the same way any infra/ adapter test
// would mock its one external dependency, since there is no prior
// `processRunner.test.ts` precedent to mirror for `execa` mocking in this
// repo.
const execaMock = vi.fn();
vi.mock('execa', () => ({ execa: execaMock }));

const { NativeOpener } = await import('../../src/infra/open.js');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('NativeOpener — 3-platform switch via execa', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execaMock.mockReset();
  });

  afterAll(() => {
    setPlatform(originalPlatform);
  });

  it('win32: shells out to "explorer" with the path as a single argv entry', async () => {
    setPlatform('win32');
    execaMock.mockResolvedValue({ exitCode: 0 });

    await new NativeOpener().open('C:\\work\\demo');

    expect(execaMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execaMock.mock.calls[0]!;
    expect(command).toBe('explorer');
    expect(args).toEqual(['C:\\work\\demo']);
    // SEC-001/the no-shell:true invariant (ExecaProcessRunner's own header
    // comment) — never passed here, under any platform.
    expect(options?.shell).not.toBe(true);
  });

  it('darwin: shells out to "open" with the path as a single argv entry', async () => {
    setPlatform('darwin');
    execaMock.mockResolvedValue({ exitCode: 0 });

    await new NativeOpener().open('/work/demo');

    const [command, args, options] = execaMock.mock.calls[0]!;
    expect(command).toBe('open');
    expect(args).toEqual(['/work/demo']);
    expect(options?.shell).not.toBe(true);
  });

  it('linux: shells out to "xdg-open" with the path as a single argv entry', async () => {
    setPlatform('linux');
    execaMock.mockResolvedValue({ exitCode: 0 });

    await new NativeOpener().open('/work/demo');

    const [command, args, options] = execaMock.mock.calls[0]!;
    expect(command).toBe('xdg-open');
    expect(args).toEqual(['/work/demo']);
    expect(options?.shell).not.toBe(true);
  });

  it('never passes shell: true to execa, on any platform (SEC-001 invariant)', async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      setPlatform(platform);
      execaMock.mockReset();
      execaMock.mockResolvedValue({ exitCode: 0 });

      await new NativeOpener().open('/work/demo');

      const options = execaMock.mock.calls[0]![2];
      expect(options === undefined || options.shell !== true).toBe(true);
    }
  });

  // Real-world grounding (confirmed empirically against this machine's own
  // explorer.exe, opening this repo's own cwd): `explorer.exe` frequently
  // exits non-zero even though it successfully opened the folder — this
  // adapter must not surface that as a failure for win32/"explorer"
  // specifically.
  it('win32: a non-zero-exit rejection from "explorer" is swallowed, not propagated — explorer.exe opening a folder successfully is known to still exit non-zero', async () => {
    setPlatform('win32');
    const explorerError = Object.assign(new Error('Command failed with exit code 1: explorer C:\\work\\demo'), {
      exitCode: 1,
    });
    execaMock.mockRejectedValue(explorerError);

    await expect(new NativeOpener().open('C:\\work\\demo')).resolves.toBeUndefined();
  });

  it('darwin: a rejection from "open" still propagates — only the win32/explorer case is special-cased', async () => {
    setPlatform('darwin');
    const openError = new Error('open: command not found');
    execaMock.mockRejectedValue(openError);

    await expect(new NativeOpener().open('/work/demo')).rejects.toThrow('open: command not found');
  });

  it('linux: a rejection from "xdg-open" still propagates', async () => {
    setPlatform('linux');
    const xdgError = new Error('xdg-open: command not found');
    execaMock.mockRejectedValue(xdgError);

    await expect(new NativeOpener().open('/work/demo')).rejects.toThrow('xdg-open: command not found');
  });
});
