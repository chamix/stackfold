import { describe, expect, it } from 'vitest';
import {
  InvalidAnswersError,
  InvalidBlueprintError,
  InvalidQuestionsError,
  PostActionError,
  ScaffoldWriteError,
  formatPostAction,
  runPlugin,
} from '../../src/core/orchestrator.js';
import type { FileWriter, ProcessRunner, Prompter } from '../../src/core/ports.js';
import type {
  Answers,
  PostActionDefinition,
  ProjectBlueprint,
  QuestionDefinition,
  StackfoldPlugin,
} from '../../src/core/types.js';

const TARGET = '/work/demo';

/** Shared call log, so tests can assert the Template Method's step order. */
type Call =
  | { step: 'questions' }
  | { step: 'ask'; questions: QuestionDefinition[] }
  | { step: 'buildBlueprint'; answers: Answers }
  | { step: 'ensureEmptyDir'; targetDir: string }
  | { step: 'writeFile'; path: string; content: string | Buffer }
  | { step: 'run'; command: string; args: string[]; cwd: string | undefined };

interface Harness {
  calls: Call[];
  plugin: StackfoldPlugin;
  ports: { prompter: Prompter; fileWriter: FileWriter; processRunner: ProcessRunner };
}

function harness(opts: {
  questions?: QuestionDefinition[];
  answers?: Answers;
  blueprint?: ProjectBlueprint | ((answers: Answers) => ProjectBlueprint);
  ensureEmptyDirError?: Error;
  failWriteOn?: string;
  failRunOn?: string;
} = {}): Harness {
  const calls: Call[] = [];
  const questions = opts.questions ?? [{ id: 'name', message: 'Name?', type: 'input' }];
  const blueprint =
    opts.blueprint ??
    ((): ProjectBlueprint => ({
      files: [{ path: 'README.md', content: '# demo' }],
      postActions: [{ kind: 'git-init' }],
    }));

  const plugin: StackfoldPlugin = {
    id: 'fake',
    description: 'fake plugin',
    questions() {
      calls.push({ step: 'questions' });
      return questions;
    },
    buildBlueprint(answers) {
      calls.push({ step: 'buildBlueprint', answers });
      return typeof blueprint === 'function' ? blueprint(answers) : blueprint;
    },
  };

  const prompter: Prompter = {
    async ask(qs) {
      calls.push({ step: 'ask', questions: qs });
      return opts.answers ?? { name: 'demo' };
    },
  };

  const fileWriter: FileWriter = {
    async ensureEmptyDir(targetDir) {
      calls.push({ step: 'ensureEmptyDir', targetDir });
      if (opts.ensureEmptyDirError) throw opts.ensureEmptyDirError;
    },
    async writeFile(path, content) {
      calls.push({ step: 'writeFile', path, content });
      if (opts.failWriteOn && path.endsWith(opts.failWriteOn)) {
        throw new Error(`disk full writing ${path}`);
      }
    },
  };

  const processRunner: ProcessRunner = {
    async run(command, args, options) {
      calls.push({ step: 'run', command, args, cwd: options?.cwd });
      if (opts.failRunOn === command) throw new Error(`${command} exited with code 1`);
    },
  };

  return { calls, plugin, ports: { prompter, fileWriter, processRunner } };
}

const steps = (calls: Call[]): string[] => calls.map((c) => c.step);

describe('runPlugin — Template Method sequence', () => {
  it('asks, builds the blueprint, ensures the target, writes files, then runs post-actions — in that order', async () => {
    const h = harness({
      blueprint: {
        files: [
          { path: 'package.json', content: '{}' },
          { path: 'src/index.ts', content: 'export {};' },
        ],
        postActions: [{ kind: 'git-init' }, { kind: 'npm-install' }],
      },
    });

    await runPlugin(h.plugin, TARGET, h.ports);

    expect(steps(h.calls)).toEqual([
      'questions',
      'ask',
      'buildBlueprint',
      'ensureEmptyDir',
      'writeFile',
      'writeFile',
      'run',
      'run',
    ]);
  });

  it('passes the plugin question schema to the prompter and the resolved answers to buildBlueprint', async () => {
    const questions: QuestionDefinition[] = [
      { id: 'name', message: 'Name?', type: 'input' },
      { id: 'ts', message: 'TS?', type: 'confirm' },
    ];
    const h = harness({ questions, answers: { name: 'demo', ts: true } });

    await runPlugin(h.plugin, TARGET, h.ports);

    expect(h.calls).toContainEqual({ step: 'ask', questions });
    expect(h.calls).toContainEqual({ step: 'buildBlueprint', answers: { name: 'demo', ts: true } });
  });

  it('writes each file at targetDir joined with its relative path, in blueprint order', async () => {
    const h = harness({
      blueprint: {
        files: [
          { path: 'a.txt', content: 'A' },
          { path: 'src/nested/b.ts', content: Buffer.from('B') },
        ],
        postActions: [],
      },
    });

    await runPlugin(h.plugin, TARGET, h.ports);

    const writes = h.calls.filter((c) => c.step === 'writeFile');
    expect(writes).toEqual([
      { step: 'writeFile', path: '/work/demo/a.txt', content: 'A' },
      { step: 'writeFile', path: '/work/demo/src/nested/b.ts', content: Buffer.from('B') },
    ]);
  });

  it('does not double the separator when targetDir has a trailing slash', async () => {
    const h = harness();
    await runPlugin(h.plugin, '/work/demo/', h.ports);
    expect(h.calls).toContainEqual({ step: 'writeFile', path: '/work/demo/README.md', content: '# demo' });
  });

  it('maps each declarative post-action onto a ProcessRunner call with cwd = targetDir', async () => {
    const h = harness({
      blueprint: {
        files: [],
        postActions: [
          { kind: 'git-init' },
          { kind: 'npm-install' },
          { kind: 'run-command', command: 'node', args: ['--version'] },
        ],
      },
    });

    await runPlugin(h.plugin, TARGET, h.ports);

    expect(h.calls.filter((c) => c.step === 'run')).toEqual([
      { step: 'run', command: 'git', args: ['init'], cwd: TARGET },
      { step: 'run', command: 'npm', args: ['install'], cwd: TARGET },
      { step: 'run', command: 'node', args: ['--version'], cwd: TARGET },
    ]);
  });

  it('returns a summary of what was written and run', async () => {
    const h = harness();
    const result = await runPlugin(h.plugin, TARGET, h.ports);
    expect(result).toEqual({
      targetDir: TARGET,
      filesWritten: ['README.md'],
      postActionsRun: [{ kind: 'git-init' }],
    });
  });
});

describe('runPlugin — §3.1 no partial answers reach transformation', () => {
  it('fills in declared defaults for unanswered questions', async () => {
    const h = harness({
      questions: [
        { id: 'name', message: 'Name?', type: 'input' },
        { id: 'port', message: 'Port?', type: 'input', default: 3000 },
      ],
      answers: { name: 'demo' },
    });

    await runPlugin(h.plugin, TARGET, h.ports);

    expect(h.calls).toContainEqual({ step: 'buildBlueprint', answers: { name: 'demo', port: 3000 } });
  });

  it('drops answers for ids the plugin never declared', async () => {
    const h = harness({ answers: { name: 'demo', injected: 'x' } });
    await runPlugin(h.plugin, TARGET, h.ports);
    expect(h.calls).toContainEqual({ step: 'buildBlueprint', answers: { name: 'demo' } });
  });

  it.each<[string, QuestionDefinition[], Answers]>([
    ['a required answer is missing', [{ id: 'name', message: 'Name?', type: 'input' }], {}],
    [
      'validate() returns a message',
      [{ id: 'name', message: 'Name?', type: 'input', validate: (v) => (v === 'ok' ? true : 'must be ok') }],
      { name: 'nope' },
    ],
    ['a confirm answer is not a boolean', [{ id: 'ts', message: 'TS?', type: 'confirm' }], { ts: 'yes' }],
    ['an input answer is a boolean', [{ id: 'name', message: 'Name?', type: 'input' }], { name: true }],
    [
      'a select answer is not one of its choices',
      [{ id: 'ui', message: 'UI?', type: 'select', choices: ['react', 'vue'] }],
      { ui: 'angular' },
    ],
  ])('rejects with InvalidAnswersError when %s, before building or touching disk', async (_label, questions, answers) => {
    const h = harness({ questions, answers });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidAnswersError);
    expect(steps(h.calls)).toEqual(['questions', 'ask']);
  });

  it('reports every failing question id, not just the first', async () => {
    const h = harness({
      questions: [
        { id: 'a', message: 'A?', type: 'input' },
        { id: 'b', message: 'B?', type: 'confirm' },
      ],
      answers: {},
    });

    const err = await runPlugin(h.plugin, TARGET, h.ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidAnswersError);
    expect((err as InvalidAnswersError).issues.map((i) => i.questionId)).toEqual(['a', 'b']);
  });

  it.each<[string, QuestionDefinition[]]>([
    ['a select question has no choices', [{ id: 'ui', message: 'UI?', type: 'select' }]],
    ['a select question has an empty choices list', [{ id: 'ui', message: 'UI?', type: 'select', choices: [] }]],
    [
      'two questions share an id',
      [
        { id: 'name', message: 'Name?', type: 'input' },
        { id: 'name', message: 'Name again?', type: 'input' },
      ],
    ],
  ])('rejects a malformed question schema (%s) before prompting the user', async (_label, questions) => {
    const h = harness({ questions });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidQuestionsError);
    expect(steps(h.calls)).toEqual(['questions']);
  });
});

describe('runPlugin — blueprint validation happens before the target is touched', () => {
  it.each([
    ['parent traversal', '../escape.txt'],
    ['nested parent traversal', 'src/../../escape.txt'],
    ['POSIX absolute path', '/etc/passwd'],
    ['Windows drive path', 'C:\\Windows\\evil.dll'],
    ['Windows drive-relative path', 'C:evil.dll'],
    ['UNC path', '\\\\server\\share\\x'],
    ['backslash traversal', 'src\\..\\..\\escape.txt'],
    ['empty path', ''],
    ['empty segment', 'src//a.ts'],
    ['dot segment', 'src/./a.ts'],
    ['trailing slash (directory, not file)', 'src/'],
    ['NUL byte', 'a\u0000.txt'],
    ['colon (NTFS alternate data stream)', 'a.txt:stream'],
  ])('rejects %s (%j) with InvalidBlueprintError', async (_label, badPath) => {
    const h = harness({ blueprint: { files: [{ path: badPath, content: 'x' }], postActions: [] } });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidBlueprintError);
    expect(steps(h.calls)).not.toContain('ensureEmptyDir');
    expect(steps(h.calls)).not.toContain('writeFile');
  });

  it('rejects duplicate file paths, case-insensitively (Windows/macOS filesystems)', async () => {
    const h = harness({
      blueprint: {
        files: [
          { path: 'README.md', content: 'a' },
          { path: 'readme.md', content: 'b' },
        ],
        postActions: [],
      },
    });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidBlueprintError);
    expect(steps(h.calls)).not.toContain('ensureEmptyDir');
  });

  it('rejects a run-command action with an empty command', async () => {
    const h = harness({
      blueprint: { files: [], postActions: [{ kind: 'run-command', command: '  ', args: [] }] },
    });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidBlueprintError);
    expect(steps(h.calls)).not.toContain('ensureEmptyDir');
  });

  it('rejects an unknown post-action kind (e.g. from an untyped JS plugin)', async () => {
    const h = harness({
      blueprint: {
        files: [],
        postActions: [{ kind: 'rm-rf' } as unknown as ProjectBlueprint['postActions'][number]],
      },
    });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toBeInstanceOf(InvalidBlueprintError);
    expect(steps(h.calls)).not.toContain('ensureEmptyDir');
  });

  it('propagates a buildBlueprint() failure without touching the target', async () => {
    const h = harness({
      blueprint: () => {
        throw new Error('plugin bug');
      },
    });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toThrow('plugin bug');
    expect(steps(h.calls)).not.toContain('ensureEmptyDir');
  });
});

describe('runPlugin — §3.3 no pre-existing project is touched', () => {
  it('propagates an ensureEmptyDir() rejection and writes nothing', async () => {
    const h = harness({ ensureEmptyDirError: new Error('target is not empty') });

    await expect(runPlugin(h.plugin, TARGET, h.ports)).rejects.toThrow('target is not empty');
    expect(steps(h.calls)).not.toContain('writeFile');
    expect(steps(h.calls)).not.toContain('run');
  });
});

describe('runPlugin — §3.2 best-effort failure reporting', () => {
  it('on a write failure, stops and reports exactly which files were and were not written', async () => {
    const h = harness({
      blueprint: {
        files: [
          { path: 'a.txt', content: 'A' },
          { path: 'b.txt', content: 'B' },
          { path: 'c.txt', content: 'C' },
        ],
        postActions: [{ kind: 'git-init' }],
      },
      failWriteOn: 'b.txt',
    });

    const err = await runPlugin(h.plugin, TARGET, h.ports).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScaffoldWriteError);
    const writeErr = err as ScaffoldWriteError;
    expect(writeErr.targetDir).toBe(TARGET);
    expect(writeErr.writtenFiles).toEqual(['a.txt']);
    expect(writeErr.failedFile).toBe('b.txt');
    expect(writeErr.pendingFiles).toEqual(['c.txt']);
    expect(writeErr.cause).toBeInstanceOf(Error);
    expect(writeErr.message).toContain('b.txt');
    // No further writes and no post-actions after the failure.
    expect(h.calls.filter((c) => c.step === 'writeFile')).toHaveLength(2);
    expect(steps(h.calls)).not.toContain('run');
  });

  it('on a post-action failure, reports completed, failed, and pending actions', async () => {
    const h = harness({
      blueprint: {
        files: [{ path: 'a.txt', content: 'A' }],
        postActions: [
          { kind: 'git-init' },
          { kind: 'npm-install' },
          { kind: 'run-command', command: 'node', args: ['build.js'] },
        ],
      },
      failRunOn: 'npm',
    });

    const err = await runPlugin(h.plugin, TARGET, h.ports).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PostActionError);
    const actionErr = err as PostActionError;
    expect(actionErr.filesWritten).toEqual(['a.txt']);
    expect(actionErr.completedActions).toEqual([{ kind: 'git-init' }]);
    expect(actionErr.failedAction).toEqual({ kind: 'npm-install' });
    expect(actionErr.pendingActions).toEqual([{ kind: 'run-command', command: 'node', args: ['build.js'] }]);
    expect(actionErr.cause).toBeInstanceOf(Error);
    expect(h.calls.filter((c) => c.step === 'run')).toHaveLength(2);
  });
});

describe('formatPostAction — the single human-readable form of a post-action', () => {
  it.each<[PostActionDefinition, string]>([
    [{ kind: 'git-init' }, 'git init'],
    [{ kind: 'npm-install' }, 'npm install'],
    [{ kind: 'run-command', command: 'node', args: ['build.js', '--prod'] }, 'node build.js --prod'],
    [{ kind: 'run-command', command: 'make', args: [] }, 'make'],
  ])('formats %j as %j', (action, expected) => {
    expect(formatPostAction(action)).toBe(expected);
  });

  it('matches the command the orchestrator actually runs', async () => {
    const actions: PostActionDefinition[] = [
      { kind: 'git-init' },
      { kind: 'npm-install' },
      { kind: 'run-command', command: 'node', args: ['x.js'] },
    ];
    const h = harness({ blueprint: { files: [], postActions: actions } });

    await runPlugin(h.plugin, TARGET, h.ports);

    const ran = h.calls.flatMap((c) => (c.step === 'run' ? [[c.command, ...c.args].join(' ')] : []));
    expect(ran).toEqual(actions.map(formatPostAction));
  });
});
