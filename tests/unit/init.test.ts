import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { formatPostAction } from '../../src/core/orchestrator.js';
import { TargetNotEmptyError, type PluginRegistry } from '../../src/core/ports.js';
import type { PostActionDefinition, ProjectBlueprint, StackfoldPlugin } from '../../src/core/types.js';

const CWD = resolve('/base/dir');

function fakePlugin(id: string, blueprint: ProjectBlueprint): StackfoldPlugin {
  return {
    id,
    description: `${id} description`,
    questions: () => [],
    buildBlueprint: () => blueprint,
  };
}

const DEFAULT_BLUEPRINT: ProjectBlueprint = {
  files: [
    { path: 'a.txt', content: 'A' },
    { path: 'b.txt', content: 'B' },
  ],
  postActions: [{ kind: 'git-init' }],
};

function setup(opts: {
  blueprint?: ProjectBlueprint;
  askError?: Error;
  ensureEmptyDirError?: Error;
  failWriteOn?: string;
  failRunOn?: string;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ensuredDirs: string[] = [];
  const writes: string[] = [];
  const runs: string[] = [];

  const plugins = [fakePlugin('fake', opts.blueprint ?? DEFAULT_BLUEPRINT), fakePlugin('other', DEFAULT_BLUEPRINT)];
  const registry: PluginRegistry = {
    resolve: (id) => plugins.find((p) => p.id === id),
    list: () => [...plugins],
  };

  const deps: InitCommandDependencies = {
    registry,
    ports: {
      prompter: {
        ask: async () => {
          if (opts.askError) throw opts.askError;
          return {};
        },
      },
      fileWriter: {
        ensureEmptyDir: async (dir) => {
          ensuredDirs.push(dir);
          if (opts.ensureEmptyDirError) throw opts.ensureEmptyDirError;
        },
        writeFile: async (path) => {
          if (opts.failWriteOn && path.endsWith(opts.failWriteOn)) throw new Error('disk full');
          writes.push(path);
        },
      },
      processRunner: {
        run: async (command, args) => {
          if (opts.failRunOn === command) throw new Error(`${command} exited with code 1`);
          runs.push([command, ...args].join(' '));
        },
      },
    },
    cwd: () => CWD,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };

  return { deps, stdout, stderr, ensuredDirs, writes, runs };
}

/** Lines following `title` in the output, up to the next non-indented line. */
function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(title));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    items.push(line.trim());
  }
  return items;
}

describe('runInit — argument handling (exit 1, nothing touched)', () => {
  it('missing stack: exit 1, usage and the available stacks on stderr', async () => {
    const s = setup();

    expect(await runInit(undefined, 'my-app', s.deps)).toBe(1);

    expect(s.stderr.join('\n')).toMatch(/no stack specified/);
    expect(section(s.stderr, 'Available stacks:')).toEqual(['fake  fake description', 'other  other description']);
    expect(s.ensuredDirs).toEqual([]);
    expect(s.stdout).toEqual([]);
  });

  it('unknown stack: exit 1, names the stack and lists the available ones', async () => {
    const s = setup();

    expect(await runInit('rails', 'my-app', s.deps)).toBe(1);

    expect(s.stderr.join('\n')).toContain('unknown stack "rails"');
    expect(section(s.stderr, 'Available stacks:')).toHaveLength(2);
    expect(s.ensuredDirs).toEqual([]);
  });

  it('missing directory: exit 1, usage names the resolved stack', async () => {
    const s = setup();

    expect(await runInit('fake', undefined, s.deps)).toBe(1);

    expect(s.stderr.join('\n')).toMatch(/no target directory specified.*stackfold init fake <directory>/);
    expect(s.ensuredDirs).toEqual([]);
  });
});

describe('runInit — success', () => {
  it('exit 0, reports the target and file count on stdout', async () => {
    const s = setup();

    expect(await runInit('fake', 'my-app', s.deps)).toBe(0);

    expect(s.stdout).toEqual([`Scaffolded fake project in ${resolve(CWD, 'my-app')} (2 files).`]);
    expect(s.stderr).toEqual([]);
    expect(s.runs).toEqual(['git init']);
  });

  it('resolves a relative directory against the injected cwd', async () => {
    const s = setup();
    await runInit('fake', 'nested/my-app', s.deps);
    expect(s.ensuredDirs).toEqual([resolve(CWD, 'nested/my-app')]);
  });

  it('keeps an absolute directory as-is', async () => {
    const s = setup();
    const absolute = resolve('/elsewhere/project');
    await runInit('fake', absolute, s.deps);
    expect(s.ensuredDirs).toEqual([absolute]);
  });
});

describe('runInit — failures', () => {
  it('Ctrl+C in a prompt (ExitPromptError): exit 130, says nothing was written', async () => {
    // Same shape @inquirer/prompts rejects with; runInit detects it by name.
    const abort = new Error('User force closed the prompt with SIGINT');
    abort.name = 'ExitPromptError';
    const s = setup({ askError: abort });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(130);

    expect(s.stderr).toEqual(['stackfold init: aborted. Nothing was written.']);
    expect(s.ensuredDirs).toEqual([]);
  });

  it('non-empty target (TargetNotEmptyError): exit 1, reports it, writes nothing', async () => {
    const s = setup({ ensureEmptyDirError: new TargetNotEmptyError(resolve(CWD, 'my-app')) });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(1);

    expect(s.stderr.join('\n')).toContain('already exists and is not empty');
    expect(s.writes).toEqual([]);
  });

  it('any other error: exit 1 with its message', async () => {
    const s = setup({ ensureEmptyDirError: new Error('EACCES: permission denied') });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(1);

    expect(s.stderr[0]).toBe('stackfold init: EACCES: permission denied');
  });

  it('ScaffoldWriteError: exit 1, lists written, failed and not-written files', async () => {
    const s = setup({
      blueprint: {
        files: [
          { path: 'a.txt', content: 'A' },
          { path: 'b.txt', content: 'B' },
          { path: 'c.txt', content: 'C' },
          { path: 'd.txt', content: 'D' },
        ],
        postActions: [{ kind: 'git-init' }],
      },
      failWriteOn: 'b.txt',
    });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(1);

    expect(s.stderr[0]).toMatch(/^stackfold init: Failed to write "b\.txt"/);
    expect(section(s.stderr, 'Written before the failure')).toEqual(['a.txt']);
    expect(section(s.stderr, 'Failed:')).toEqual(['b.txt']);
    expect(section(s.stderr, 'Not written:')).toEqual(['c.txt', 'd.txt']);
    expect(s.runs).toEqual([]);
  });

  it('PostActionError: exit 1, lists completed actions and the failed + pending ones to run by hand', async () => {
    const actions: PostActionDefinition[] = [
      { kind: 'git-init' },
      { kind: 'npm-install' },
      { kind: 'run-command', command: 'node', args: ['build.js', '--prod'] },
    ];
    const s = setup({ blueprint: { files: [{ path: 'a.txt', content: 'A' }], postActions: actions }, failRunOn: 'npm' });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(1);

    expect(s.stderr[0]).toMatch(/^stackfold init: All files were written/);
    expect(section(s.stderr, 'Completed follow-up actions:')).toEqual(['git init']);
    expect(section(s.stderr, 'Not run')).toEqual(['npm install', 'node build.js --prod']);
  });

  it('the "run these by hand" text uses the same formatter as the orchestrator (no drift)', async () => {
    const actions: PostActionDefinition[] = [
      { kind: 'npm-install' },
      { kind: 'run-command', command: 'node', args: ['x.js'] },
    ];
    const s = setup({ blueprint: { files: [], postActions: actions }, failRunOn: 'npm' });

    await runInit('fake', 'my-app', s.deps);

    expect(section(s.stderr, 'Not run')).toEqual(actions.map(formatPostAction));
  });
});
