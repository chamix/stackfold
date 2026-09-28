import { describe, expect, it } from 'vitest';
import { electronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { runPlugin } from '../../src/core/orchestrator.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import type { Answers, QuestionDefinition } from '../../src/core/types.js';

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app' };

function question(id: string): QuestionDefinition {
  const q = electronTsPlugin.questions().find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} not declared`);
  return q;
}

function fileContent(answers: Answers, path: string): string {
  const entry = electronTsPlugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('electron-ts plugin — identity', () => {
  it('has the stable id "electron-ts" and a description', () => {
    expect(electronTsPlugin.id).toBe('electron-ts');
    expect(electronTsPlugin.description.length).toBeGreaterThan(0);
  });

  it('is resolvable through a registry by its id (§3.5)', () => {
    const registry = new StaticPluginRegistry([electronTsPlugin]);
    expect(registry.resolve('electron-ts')).toBe(electronTsPlugin);
  });
});

describe('electron-ts plugin — questions()', () => {
  it('declares an appName text question with a default', () => {
    const q = question('appName');
    expect(q.type).toBe('input');
    expect(typeof q.default).toBe('string');
  });

  it('declares a description text question with a default', () => {
    const q = question('description');
    expect(q.type).toBe('input');
    expect(typeof q.default).toBe('string');
  });

  it.each(['', '   ', '!!!'])('appName validation rejects %j', (value) => {
    expect(question('appName').validate?.(value)).toEqual(expect.any(String));
  });

  it.each(['my-app', 'My Cool App', 'app2'])('appName validation accepts %j', (value) => {
    expect(question('appName').validate?.(value)).toBe(true);
  });

  it('appName default itself passes validation', () => {
    const q = question('appName');
    expect(q.validate?.(q.default as string)).toBe(true);
  });
});

describe('electron-ts plugin — buildBlueprint() is pure and synchronous', () => {
  it('returns a blueprint directly, not a Promise', () => {
    const result = electronTsPlugin.buildBlueprint(ANSWERS);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('is deterministic: same answers, same blueprint', () => {
    expect(electronTsPlugin.buildBlueprint({ ...ANSWERS })).toEqual(
      electronTsPlugin.buildBlueprint({ ...ANSWERS })
    );
  });

  it('does not mutate its input', () => {
    const answers = Object.freeze({ ...ANSWERS });
    expect(() => electronTsPlugin.buildBlueprint(answers)).not.toThrow();
  });

  it('throws a clear error if appName is missing (never generates from partial answers)', () => {
    expect(() => electronTsPlugin.buildBlueprint({ description: 'x' })).toThrow(/appName/);
  });
});

describe('electron-ts plugin — placeholder blueprint content', () => {
  it('emits package.json, README.md and .gitignore', () => {
    const paths = electronTsPlugin.buildBlueprint(ANSWERS).files.map((f) => f.path);
    expect(paths).toEqual(['package.json', 'README.md', '.gitignore']);
  });

  it('derives a URL-safe npm package name from the human-readable app name (§2.1)', () => {
    const pkg = JSON.parse(fileContent(ANSWERS, 'package.json'));
    expect(pkg.name).toBe('my-cool-app');
    expect(pkg.productName).toBe('My Cool App!');
    expect(pkg.description).toBe('A demo app');
    expect(pkg.private).toBe(true);
  });

  it('keeps package.json valid JSON even when answers contain quotes', () => {
    const pkg = JSON.parse(fileContent({ appName: 'Say "hi"', description: 'a "quoted" desc' }, 'package.json'));
    expect(pkg.productName).toBe('Say "hi"');
    expect(pkg.description).toBe('a "quoted" desc');
  });

  it('README names the app and states that the real implementation is pending', () => {
    const readme = fileContent(ANSWERS, 'README.md');
    expect(readme).toContain('My Cool App!');
    expect(readme.toLowerCase()).toContain('pending');
  });

  it('declares git-init as its only follow-up action', () => {
    expect(electronTsPlugin.buildBlueprint(ANSWERS).postActions).toEqual([{ kind: 'git-init' }]);
  });
});

describe('electron-ts plugin — end-to-end through the orchestrator (in-memory ports)', () => {
  it('scaffolds through the full Template Method pipeline', async () => {
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(electronTsPlugin, '/work/app', {
      prompter: { ask: async () => ({ appName: 'Demo App' }) },
      fileWriter: {
        ensureEmptyDir: async () => {},
        writeFile: async (p, c) => {
          written.set(p, c.toString());
        },
      },
      processRunner: {
        run: async (cmd, args, opts) => {
          commands.push(`${opts?.cwd}: ${[cmd, ...args].join(' ')}`);
        },
      },
    });

    expect(result.filesWritten).toEqual(['package.json', 'README.md', '.gitignore']);
    expect(JSON.parse(written.get('/work/app/package.json') ?? '').name).toBe('demo-app');
    expect(commands).toEqual(['/work/app: git init']);
  });
});
