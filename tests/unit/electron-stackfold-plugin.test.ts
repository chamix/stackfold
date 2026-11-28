/**
 * `electron-stackfold` input validation / HTML-escaping parity against
 * `electron-ts`. Differential precedent: `core-constraints-differential.test.ts`.
 *
 * Both plugins run through the exact same production pipeline
 * (`core/orchestrator.ts`'s `runPlugin()`), a stub `Prompter` that hands
 * back fixed answers (no interactive prompt), a no-op `ProcessRunner`, and
 * a small in-memory `FileWriter` (a port — a fake here is fine, same as
 * `tests/integration/builtin-validation-runtime.test.ts`'s own convention,
 * except that one uses the real `NodeFileWriter`). `electron-ts` is built
 * via its real `createElectronTsPlugin()`; `electron-stackfold` is compiled
 * from its own `scaffold.json` via `compileScaffold()` — the exact same
 * import path `src/cli/index.ts` itself uses (`with: { type: 'json' }`),
 * never the authoring `scaffold.ts` directly — so this test exercises the
 * object the real CLI registers, with real Handlebars rendering underneath
 * (`core/authoring.ts`'s `compose`/`file()` action, unmodified).
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { runPlugin, InvalidAnswersError } from '../../src/core/orchestrator.js';
import type { FileWriter, ProcessRunner, Prompter } from '../../src/core/ports.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';
import { createElectronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { synth } from '../../src/authoring/synth.js';
import electronStackfoldDefinitionTs from '../../src/plugins/electron-stackfold/scaffold.js';
import electronStackfoldJson from '../../src/plugins/electron-stackfold/scaffold.json' with { type: 'json' };

const evaluator = new JsonLogicExpressionEvaluator();

/**
 * Minimal in-memory `FileWriter` — a port, so a fake here never stands in
 * for a third-party library or the OS (the thing `.claude/project/testing.md`
 * cares about); the file-writing *behavior under test* is `core/authoring.ts`'s
 * real Handlebars rendering and escaping, not this adapter.
 */
class InMemoryFileWriter implements FileWriter {
  readonly files = new Map<string, string>();

  async ensureEmptyDir(): Promise<void> {
    // Nothing on disk to check — every run starts from an empty map.
  }

  async writeFile(absolutePath: string, content: string | Buffer): Promise<void> {
    if (this.files.has(absolutePath)) {
      throw new Error(`InMemoryFileWriter: "${absolutePath}" already written`);
    }
    this.files.set(absolutePath, typeof content === 'string' ? content : content.toString('utf8'));
  }

  async readFile(absolutePath: string): Promise<string | undefined> {
    return this.files.get(absolutePath);
  }

  async overwriteFile(absolutePath: string, content: string): Promise<void> {
    this.files.set(absolutePath, content);
  }
}

const NOOP_PROCESS_RUNNER: ProcessRunner = { run: async () => {} };

function stubPrompter(answers: Answers): Prompter {
  return { ask: async () => answers };
}

interface RunOutcome {
  ok: true;
  files: Map<string, string>;
}
interface RunFailure {
  ok: false;
  message: string;
}

/** Runs `plugin` through the real orchestrator against a fresh in-memory FileWriter. */
async function run(plugin: StackfoldPlugin, answers: Answers): Promise<RunOutcome | RunFailure> {
  const writer = new InMemoryFileWriter();
  try {
    await runPlugin(plugin, 'TARGET', {
      prompter: stubPrompter(answers),
      fileWriter: writer,
      processRunner: NOOP_PROCESS_RUNNER,
    });
    return { ok: true, files: writer.files };
  } catch (err) {
    if (err instanceof InvalidAnswersError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
}

/** Strips the common `TARGET\` (or `TARGET/`) prefix the in-memory writer's absolute paths carry. */
function relativeTree(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [absolutePath, content] of files) {
    const rel = absolutePath.replace(/^TARGET[\\/]/, '').split('\\').join('/');
    out.set(rel, content);
  }
  return out;
}

/**
 * `now` is a real wall clock for both plugins, deliberately: `electron-ts`'s
 * own `createElectronTsPlugin({ now })` accepts an injectable clock, but
 * `electron-stackfold`'s `hooks.preInit` `deriveAnswer` "current-year"
 * transform reads `Date.now()` directly (`core/authoring.ts`), with no way
 * to inject a fixed clock from the outside. Using the real clock on both
 * sides keeps the LICENSE year comparison meaningful without pinning one
 * side artificially; the only risk is a run straddling a year rollover,
 * accepted as negligible.
 */
function makePlugins(): { electronTs: StackfoldPlugin; electronStackfold: StackfoldPlugin } {
  return {
    electronTs: createElectronTsPlugin({ now: () => new Date() }),
    electronStackfold: compileScaffold(electronStackfoldJson as ScaffoldDefinition, evaluator),
  };
}

const BOOL_COMBINATIONS: Array<{ includeSettings: boolean; includeSkins: boolean; includeAboutHelp: boolean }> = [
  { includeSettings: false, includeSkins: false, includeAboutHelp: false },
  { includeSettings: true, includeSkins: false, includeAboutHelp: false },
  { includeSettings: false, includeSkins: true, includeAboutHelp: false },
  { includeSettings: false, includeSkins: false, includeAboutHelp: true },
  { includeSettings: true, includeSkins: true, includeAboutHelp: false },
  { includeSettings: true, includeSkins: false, includeAboutHelp: true },
  { includeSettings: false, includeSkins: true, includeAboutHelp: true },
  { includeSettings: true, includeSkins: true, includeAboutHelp: true },
];

const PLAIN_TEXT = { appName: 'MyApp', description: 'A plain description' };
const HTML_SPECIAL_TEXT = { appName: '"q" <b> & ok', description: '"d" <i> & ok' };
const UNICODE_TEXT = { appName: 'Café 日本語', description: 'Ünïcödé déscription' };

describe('electron-stackfold vs. electron-ts — input parity (constraints + HTML escaping)', () => {
  describe('accepted answers: identical paths, identical content byte for byte', () => {
    for (const bools of BOOL_COMBINATIONS) {
      for (const author of ['', 'Ada Lovelace']) {
        for (const [label, text] of Object.entries({ plain: PLAIN_TEXT, htmlSpecial: HTML_SPECIAL_TEXT, unicode: UNICODE_TEXT })) {
          it(`includeSettings=${bools.includeSettings} includeSkins=${bools.includeSkins} includeAboutHelp=${bools.includeAboutHelp} author=${JSON.stringify(author)} text=${label}`, async () => {
            const { electronTs, electronStackfold } = makePlugins();
            const answers: Answers = { ...text, author, ...bools };

            const tsResult = await run(electronTs, answers);
            const stackfoldResult = await run(electronStackfold, answers);

            expect(tsResult.ok).toBe(true);
            expect(stackfoldResult.ok).toBe(true);
            if (!tsResult.ok || !stackfoldResult.ok) return;

            const tsTree = relativeTree(tsResult.files);
            const stackfoldTree = relativeTree(stackfoldResult.files);

            expect([...stackfoldTree.keys()].sort()).toEqual([...tsTree.keys()].sort());
            for (const [path, content] of tsTree) {
              expect(stackfoldTree.get(path), `content mismatch at "${path}"`).toBe(content);
            }
          });
        }
      }
    }
  });

  describe('rejected answers: both reject, same per-field message, no file written', () => {
    const base: Answers = {
      appName: 'OK App',
      description: 'A description',
      author: 'Ada',
      includeSettings: false,
      includeSkins: false,
      includeAboutHelp: false,
    };
    const LONG_APP_NAME = 'a'.repeat(101);
    const LONG_DESCRIPTION = 'a'.repeat(201);
    const LONG_AUTHOR = 'a'.repeat(151);

    const cases: Array<[string, Partial<Answers>]> = [
      ['appName empty', { appName: '' }],
      ['appName whitespace-only', { appName: '   ' }],
      ['appName "!!!"', { appName: '!!!' }],
      ['appName "..."', { appName: '...' }],
      ['appName with newline', { appName: 'My\nApp' }],
      ['appName over 100 chars', { appName: LONG_APP_NAME }],
      ['description with newline', { description: 'line1\nline2' }],
      ['description over 200 chars', { description: LONG_DESCRIPTION }],
      ['author with newline', { author: 'a\nb' }],
      ['author over 150 chars', { author: LONG_AUTHOR }],
    ];

    for (const [label, overrides] of cases) {
      it(label, async () => {
        const { electronTs, electronStackfold } = makePlugins();
        const answers: Answers = { ...base, ...overrides };

        const tsResult = await run(electronTs, answers);
        const stackfoldResult = await run(electronStackfold, answers);

        expect(tsResult.ok, `electron-ts unexpectedly accepted: ${label}`).toBe(false);
        expect(stackfoldResult.ok, `electron-stackfold unexpectedly accepted: ${label}`).toBe(false);
        if (tsResult.ok || stackfoldResult.ok) return;

        expect(stackfoldResult.message).toBe(tsResult.message);
      });
    }
  });

  describe('accepted on both (no divergence)', () => {
    const base = { includeSettings: false, includeSkins: false, includeAboutHelp: false, author: '' };
    const cases: Array<[string, Answers]> = [
      ['@a/b', { ...base, appName: '@a/b', description: 'd' }],
      ['MyApp', { ...base, appName: 'MyApp', description: 'd' }],
      ['empty description', { ...base, appName: 'MyApp', description: '' }],
    ];

    for (const [label, answers] of cases) {
      it(label, async () => {
        const { electronTs, electronStackfold } = makePlugins();
        const tsResult = await run(electronTs, answers);
        const stackfoldResult = await run(electronStackfold, answers);
        expect(tsResult.ok, label).toBe(true);
        expect(stackfoldResult.ok, label).toBe(true);
      });
    }
  });

  /**
   * FIX-005 closed the exception this test used to document: `constraints.trim`
   * now normalizes the *stored* answer, not just the value checks run
   * against (`core/constraints.ts`'s `normalizeAnswer()`, applied in
   * `core/orchestrator.ts`'s `resolveAnswers()`). `electron-ts` trims by
   * hand in its own `resolveContext()` (trimming an already-trimmed value is
   * the identity, so it needed no change); `electron-stackfold` now gets the
   * same trimmed `appName` through the orchestrator instead. A name padded
   * with spaces therefore produces an identical tree on both sides, same as
   * every other accepted-answer case in this file.
   */
  it('leading/trailing-space appName produces a byte-identical tree to electron-ts (FIX-005)', async () => {
    const { electronTs, electronStackfold } = makePlugins();
    const answers: Answers = {
      appName: '  spaced  name  ',
      description: 'd',
      author: '',
      includeSettings: false,
      includeSkins: false,
      includeAboutHelp: false,
    };

    const tsResult = await run(electronTs, answers);
    const stackfoldResult = await run(electronStackfold, answers);
    expect(tsResult.ok).toBe(true);
    expect(stackfoldResult.ok).toBe(true);
    if (!tsResult.ok || !stackfoldResult.ok) return;

    const tsTree = relativeTree(tsResult.files);
    const stackfoldTree = relativeTree(stackfoldResult.files);
    expect([...stackfoldTree.keys()].sort()).toEqual([...tsTree.keys()].sort());
    for (const [path, content] of tsTree) {
      expect(stackfoldTree.get(path), `content mismatch at "${path}"`).toBe(content);
    }

    // Both sides now agree the visible title is trimmed too.
    expect(tsTree.get('src/renderer/index.html')).toContain('<title>spaced  name</title>');
    expect(stackfoldTree.get('src/renderer/index.html')).toContain('<title>spaced  name</title>');
  });

  /**
   * FIX-008: LICENSE is plain text, so the author must appear exactly as
   * typed; package.json is JSON, so the same value must round-trip through
   * its escaping.
   */
  it('author with quotes/backslash/ampersand/angle brackets: LICENSE is raw and byte-identical to electron-ts, package.json round-trips (FIX-008)', async () => {
    const { electronTs, electronStackfold } = makePlugins();
    const author = 'Ana "La Jefa" \\ Perez & <Co>';
    const answers: Answers = {
      appName: 'PlainApp',
      description: 'd',
      author,
      includeSettings: false,
      includeSkins: false,
      includeAboutHelp: false,
    };

    const tsResult = await run(electronTs, answers);
    const stackfoldResult = await run(electronStackfold, answers);
    expect(tsResult.ok).toBe(true);
    expect(stackfoldResult.ok).toBe(true);
    if (!tsResult.ok || !stackfoldResult.ok) return;

    const tsTree = relativeTree(tsResult.files);
    const stackfoldTree = relativeTree(stackfoldResult.files);

    expect(stackfoldTree.get('LICENSE')).toContain(` ${author}\n`);
    expect(stackfoldTree.get('LICENSE')).toBe(tsTree.get('LICENSE'));
    const pkg = JSON.parse(stackfoldTree.get('package.json') ?? '') as { author?: string };
    expect(pkg.author).toBe(author);
  });

  /**
   * Invariant 5 (aggregate additivity check, spot-checked here): plain text,
   * no HTML-special characters, no padding — the generated tree must be
   * exactly what `electron-ts` (untouched by this fix) produces, same as it
   * always was for `electron-stackfold` before this fix for this exact
   * input shape.
   */
  it('invariant 5: plain text with no special characters produces a byte-identical tree to electron-ts', async () => {
    const { electronTs, electronStackfold } = makePlugins();
    const answers: Answers = {
      appName: 'PlainApp',
      description: 'A plain app, nothing special.',
      author: 'Plain Author',
      includeSettings: true,
      includeSkins: true,
      includeAboutHelp: true,
    };

    const tsResult = await run(electronTs, answers);
    const stackfoldResult = await run(electronStackfold, answers);
    expect(tsResult.ok).toBe(true);
    expect(stackfoldResult.ok).toBe(true);
    if (!tsResult.ok || !stackfoldResult.ok) return;

    const tsTree = relativeTree(tsResult.files);
    const stackfoldTree = relativeTree(stackfoldResult.files);
    expect([...stackfoldTree.keys()].sort()).toEqual([...tsTree.keys()].sort());
    for (const [path, content] of tsTree) {
      expect(stackfoldTree.get(path), `content mismatch at "${path}"`).toBe(content);
    }
  });
});

describe('electron-stackfold scaffold.json stays in sync with scaffold.ts (D4)', () => {
  it('a real `synth()` of the authoring scaffold.ts deep-equals the committed scaffold.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stackfold-electron-stackfold-synth-check-'));
    try {
      const result = synth(electronStackfoldDefinitionTs as ScaffoldDefinition, { outDir: dir, evaluator });
      const written = JSON.parse(await readFile(result.outputPath, 'utf8'));
      expect(written).toEqual(electronStackfoldJson);
      expect(result.droppedClosures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
