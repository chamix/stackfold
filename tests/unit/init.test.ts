import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerInitCommand, runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { formatPostAction } from '../../src/core/orchestrator.js';
import { TargetNotEmptyError, type PluginRegistry } from '../../src/core/ports.js';
import type { Answers, PostActionDefinition, ProjectBlueprint, QuestionDefinition, StackfoldPlugin } from '../../src/core/types.js';
import type { ProjectOpener } from '../../src/infra/open.js';

const CWD = resolve('/base/dir');

function fakePlugin(
  id: string,
  blueprint: ProjectBlueprint,
  opts: { questions?: QuestionDefinition[]; onBuildBlueprint?: (answers: Answers) => void } = {}
): StackfoldPlugin {
  return {
    id,
    description: `${id} description`,
    questions: () => opts.questions ?? [],
    buildBlueprint: (answers) => {
      opts.onBuildBlueprint?.(answers);
      return blueprint;
    },
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
  /** Pretend pre-existing entries in the target dir, for exercising ensureEmptyDir's allowlist/force logic. */
  pretendEntries?: string[];
  /** Questions the "fake" plugin declares (testing finding #2 — non-interactive answer resolution needs real declared questions, since resolveAnswers() drops undeclared keys). */
  questions?: QuestionDefinition[];
  /** Captures the Answers object the "fake" plugin's buildBlueprint() actually received. */
  onBuildBlueprint?: (answers: Answers) => void;
  /** Overrides the default fake ask() implementation (default returns {}). */
  ask?: (questions: QuestionDefinition[]) => Promise<Answers>;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ensuredDirs: string[] = [];
  const ensuredOptions: Array<{ force?: boolean; ignoreEntries?: readonly string[] } | undefined> = [];
  const writes: string[] = [];
  const runs: string[] = [];
  const askCalls: number[] = [];
  /** Task 044 (UX-001): every `questions` array ever handed to `ask()`, in call order. */
  const askedQuestions: QuestionDefinition[][] = [];
  /** Task 044 (UX-001): every path `opener.open()` was called with, in call order. */
  const openCalls: string[] = [];
  const opener: ProjectOpener = {
    open: async (absolutePath) => {
      openCalls.push(absolutePath);
    },
  };

  const plugins = [
    fakePlugin('fake', opts.blueprint ?? DEFAULT_BLUEPRINT, { questions: opts.questions, onBuildBlueprint: opts.onBuildBlueprint }),
    fakePlugin('other', DEFAULT_BLUEPRINT),
  ];
  const registry: PluginRegistry = {
    resolve: (id) => plugins.find((p) => p.id === id),
    list: () => [...plugins],
  };

  const deps: InitCommandDependencies = {
    registry,
    opener,
    ports: {
      prompter: {
        ask: async (questions) => {
          askCalls.push(1);
          askedQuestions.push(questions);
          if (opts.askError) throw opts.askError;
          if (opts.ask) return opts.ask(questions);
          return {};
        },
      },
      fileWriter: {
        ensureEmptyDir: async (dir, options) => {
          ensuredDirs.push(dir);
          ensuredOptions.push(options);
          if (opts.ensureEmptyDirError) throw opts.ensureEmptyDirError;

          const remaining = options?.force
            ? []
            : (opts.pretendEntries ?? []).filter((e) => !(options?.ignoreEntries ?? []).includes(e));
          if (remaining.length > 0) throw new TargetNotEmptyError(dir);
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

  return { deps, stdout, stderr, ensuredDirs, ensuredOptions, writes, runs, askCalls, askedQuestions, openCalls };
}

/**
 * Collects the indented lines following `title` (trimmed), stopping at the
 * first non-blank, non-indented line. Blank lines are skipped rather than
 * treated as the end of the section — `formatPluginListEntry()` (and the
 * `printAvailable()`/`runList()` callers that use it) separate each
 * plugin's block with one, so a multi-plugin listing still reads as a
 * single section here.
 */
function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(title));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === '') continue;
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
    expect(section(s.stderr, 'Available stacks:')).toEqual(['fake', 'fake description', 'other', 'other description']);
    expect(s.ensuredDirs).toEqual([]);
    expect(s.stdout).toEqual([]);
  });

  it('unknown stack: exit 1, names the stack and lists the available ones', async () => {
    const s = setup();

    expect(await runInit('rails', 'my-app', s.deps)).toBe(1);

    expect(s.stderr.join('\n')).toContain('unknown stack "rails"');
    expect(section(s.stderr, 'Available stacks:')).toHaveLength(4); // 2 plugins x (heading + description)
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

describe('runInit / registerInitCommand — --force and the governance allowlist (testing finding #1)', () => {
  function buildProgram(deps: InitCommandDependencies): Command {
    const program = new Command();
    program.exitOverride();
    registerInitCommand(program, deps);
    return program;
  }

  it('stackfold init <stack> <dir> --force succeeds into a non-empty directory, via the CLI command', async () => {
    const s = setup({ pretendEntries: ['leftover.txt'] });
    const program = buildProgram(s.deps);
    process.exitCode = undefined;

    await program.parseAsync(['init', 'fake', 'my-app', '--force'], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(s.stderr).toEqual([]);
    expect(s.ensuredOptions).toHaveLength(1);
    expect(s.ensuredOptions[0]?.force).toBe(true);
    expect(s.ensuredOptions[0]?.ignoreEntries).toEqual(expect.arrayContaining(['.git', '.agents', '.claude', 'CLAUDE.md']));

    process.exitCode = undefined;
  });

  it('a directory containing only the default governance entries succeeds without --force', async () => {
    const s = setup({ pretendEntries: ['.agents', 'CLAUDE.md'] });
    const program = buildProgram(s.deps);
    process.exitCode = undefined;

    await program.parseAsync(['init', 'fake', 'my-app'], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(s.stderr).toEqual([]);
    expect(s.ensuredOptions[0]?.force).toBe(false);
    expect(s.ensuredOptions[0]?.ignoreEntries).toEqual(expect.arrayContaining(['.agents', 'CLAUDE.md']));

    process.exitCode = undefined;
  });

  it('rejects a non-empty directory with a real conflicting file, --force omitted, same as today', async () => {
    const s = setup({ pretendEntries: ['real-conflict.txt'] });
    const program = buildProgram(s.deps);
    process.exitCode = undefined;

    await program.parseAsync(['init', 'fake', 'my-app'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(s.stderr.join('\n')).toContain('already exists and is not empty');

    process.exitCode = undefined;
  });
});

describe('runInit — non-interactive answers via --config / --answer (testing finding #2)', () => {
  const QUESTIONS: QuestionDefinition[] = [
    { id: 'appName', message: 'App name?', type: 'input' },
    { id: 'includeSettings', message: 'Include settings?', type: 'confirm' },
  ];

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stackfold-init-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('a config-file-only run resolves answers from a real temp JSON file and buildBlueprint() receives them', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ appName: 'My Cool App', includeSettings: true }));

    let received: Answers | undefined;
    const s = setup({ questions: QUESTIONS, onBuildBlueprint: (answers) => (received = answers) });

    expect(await runInit('fake', 'my-app', s.deps, { config: configPath })).toBe(0);

    expect(received).toEqual({ appName: 'My Cool App', includeSettings: true });
    expect(s.askCalls).toEqual([]);
  });

  it('--answer alone (no --config) works', async () => {
    let received: Answers | undefined;
    const s = setup({ questions: QUESTIONS, onBuildBlueprint: (answers) => (received = answers) });

    expect(
      await runInit('fake', 'my-app', s.deps, { answer: ['appName=CLI App', 'includeSettings=false'] })
    ).toBe(0);

    expect(received).toEqual({ appName: 'CLI App', includeSettings: false });
    expect(s.askCalls).toEqual([]);
  });

  it('--config + --answer together: --answer wins on a shared key', async () => {
    const configPath = join(tmpDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ appName: 'From Config', includeSettings: false }));

    let received: Answers | undefined;
    const s = setup({ questions: QUESTIONS, onBuildBlueprint: (answers) => (received = answers) });

    expect(
      await runInit('fake', 'my-app', s.deps, { config: configPath, answer: ['includeSettings=true'] })
    ).toBe(0);

    expect(received).toEqual({ appName: 'From Config', includeSettings: true });
  });

  it('a malformed --answer (no "=") fails cleanly before any file-system work', async () => {
    const s = setup({ questions: QUESTIONS });

    expect(await runInit('fake', 'my-app', s.deps, { answer: ['noequalsign'] })).toBe(1);

    expect(s.stderr.join('\n')).toContain('--answer must be in the form key=value, got "noequalsign"');
    expect(s.ensuredDirs).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  it('--config pointing at a nonexistent file fails cleanly', async () => {
    const missing = join(tmpDir, 'does-not-exist.json');
    const s = setup({ questions: QUESTIONS });

    expect(await runInit('fake', 'my-app', s.deps, { config: missing })).toBe(1);

    expect(s.stderr[0]).toMatch(/^stackfold init: /);
    expect(s.ensuredDirs).toEqual([]);
  });

  it('neither flag given still goes through the existing injected Prompter, unchanged (regression guard)', async () => {
    let received: Answers | undefined;
    const s = setup({
      questions: QUESTIONS,
      onBuildBlueprint: (answers) => (received = answers),
      ask: async () => ({ appName: 'From Interactive Prompt', includeSettings: true }),
    });

    expect(await runInit('fake', 'my-app', s.deps, {})).toBe(0);

    expect(s.askCalls).toEqual([1]);
    expect(received).toEqual({ appName: 'From Interactive Prompt', includeSettings: true });
  });
});

// Task 044 (UX-001 RF-1/RF-4): post-init "open the project" prompt. The
// three-way skip (--no-open / non-interactive / non-TTY) and the prompt's
// own choice set/action are exercised against the real `runInit()`, the
// same fake-ports harness every other describe block above already uses —
// just with its new `opener` fake and a controllable `process.stdout.isTTY`.
describe('runInit — post-init "open the project" prompt (UX-001, Task 044)', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  // The init-flow's own "ask" (for the plugin's declared questions) always
  // returns {} by default in this harness — the open-prompt is the only
  // question ever actually asked for the "fake" plugin's own empty
  // `questions()`, so asserting on `s.askedQuestions` unambiguously
  // identifies the open-prompt's own choice set.
  function openPromptQuestion(s: ReturnType<typeof setup>) {
    const q = s.askedQuestions.at(-1)?.[0];
    if (!q) throw new Error('expected the open-prompt question to have been asked');
    return q;
  }

  it('offers "Open folder"/"Open main file"/"Don\'t open" when the blueprint declares a mainFile', async () => {
    const s = setup({ blueprint: { ...DEFAULT_BLUEPRINT, mainFile: 'src/main.ts' } });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(0);

    const question = openPromptQuestion(s);
    expect(question.type).toBe('select');
    expect(question.choices).toEqual(['Open folder', 'Open main file', "Don't open"]);
  });

  it('offers only "Open folder"/"Don\'t open" when the blueprint declares no mainFile', async () => {
    const s = setup(); // DEFAULT_BLUEPRINT has no mainFile

    expect(await runInit('fake', 'my-app', s.deps)).toBe(0);

    const question = openPromptQuestion(s);
    expect(question.choices).toEqual(['Open folder', "Don't open"]);
  });

  it('"Open folder" calls opener.open() with the resolved targetDir', async () => {
    const s = setup({ ask: async () => ({ openChoice: 'Open folder' }) });

    await runInit('fake', 'my-app', s.deps);

    expect(s.openCalls).toEqual([resolve(CWD, 'my-app')]);
  });

  it('"Open main file" calls opener.open() with targetDir joined with the blueprint\'s mainFile', async () => {
    const s = setup({
      blueprint: { ...DEFAULT_BLUEPRINT, mainFile: 'src/main.ts' },
      ask: async () => ({ openChoice: 'Open main file' }),
    });

    await runInit('fake', 'my-app', s.deps);

    expect(s.openCalls).toEqual([join(resolve(CWD, 'my-app'), 'src/main.ts')]);
  });

  it('"Don\'t open" calls opener.open() zero times', async () => {
    const s = setup({ ask: async () => ({ openChoice: "Don't open" }) });

    await runInit('fake', 'my-app', s.deps);

    expect(s.openCalls).toEqual([]);
  });

  it('--no-open skips the prompt entirely — opener.open() is never called, and no extra ask() happens', async () => {
    const s = setup();

    expect(await runInit('fake', 'my-app', s.deps, { open: false })).toBe(0);

    expect(s.askCalls).toEqual([1]); // only the plugin's own (empty) questions() call
    expect(s.openCalls).toEqual([]);
  });

  // Commander's negated-flag convention (--force/--config/--answer's own
  // sibling options above --no-open in registerInitCommand): confirms
  // `--no-open` on the real CLI command actually produces `options.open
  // === false` all the way through to `maybePromptToOpen()`'s skip check —
  // not just that `runInit({ open: false })` behaves correctly when called
  // directly (every other test in this describe block).
  it('--no-open via the real registerInitCommand/Commander parse also skips the prompt', async () => {
    const s = setup();
    const program = new Command();
    program.exitOverride();
    registerInitCommand(program, s.deps);
    process.exitCode = undefined;

    await program.parseAsync(['init', 'fake', 'my-app', '--no-open'], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(s.openCalls).toEqual([]);
    expect(s.askCalls).toEqual([1]); // only the plugin's own (empty) questions() call

    process.exitCode = undefined;
  });

  it('non-interactive mode (--answer given) skips the prompt entirely', async () => {
    const s = setup({ questions: [{ id: 'appName', message: 'App name?', type: 'input' }] });

    expect(await runInit('fake', 'my-app', s.deps, { answer: ['appName=Demo'] })).toBe(0);

    expect(s.askCalls).toEqual([]); // StaticPrompter never calls ask() at all
    expect(s.openCalls).toEqual([]);
  });

  it('non-TTY stdout skips the prompt entirely, even though neither --no-open nor non-interactive answers were given', async () => {
    process.stdout.isTTY = false;
    const s = setup();

    expect(await runInit('fake', 'my-app', s.deps)).toBe(0);

    expect(s.askCalls).toEqual([1]); // only the plugin's own (empty) questions() call
    expect(s.openCalls).toEqual([]);
  });

  it('a Ctrl+C (ExitPromptError) in the open-prompt propagates into the existing abort handling: exit 130', async () => {
    const abort = new Error('User force closed the prompt with SIGINT');
    abort.name = 'ExitPromptError';
    let askCount = 0;
    const s = setup({
      ask: async () => {
        askCount += 1;
        if (askCount === 1) return {}; // the plugin's own (empty) questions() call
        throw abort; // the open-prompt's own call
      },
    });

    expect(await runInit('fake', 'my-app', s.deps)).toBe(130);
    expect(s.openCalls).toEqual([]);
  });
});
