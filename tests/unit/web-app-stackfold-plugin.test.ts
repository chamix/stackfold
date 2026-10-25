import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import definition from '../../src/plugins/web-app-stackfold/scaffold.js';
import type { Answers, QuestionDefinition, StackfoldPlugin } from '../../src/core/types.js';

/**
 * `web-app-stackfold` plugin — Task 043
 * (.agents/specs/043-electron-stackfold-web-app-reauthor.md §0 point 2):
 * merges the old `web-app-spa` (framework: react, default) and
 * `web-app-standalone-html` plugins into one, authored via the
 * scaffold-authoring system (SK-ADR-003). Replaces
 * `web-app-spa-plugin.test.ts` + `web-app-standalone-html-plugin.test.ts`
 * — same assertions, ported onto the single merged plugin, `appType`
 * replacing the old `framework` select + the old two-plugin split
 * (Decision A option (c)).
 *
 * `buildBlueprintFor()` mimics `core/orchestrator.ts`'s real
 * `runPlugin()` sequence closely enough for a unit test: run
 * `hooks.preInit` (where `packageName`/`year` are derived) against a
 * mutable copy of `answers`, then call `buildBlueprint()` — necessary
 * because (unlike the old `web-app` family's inline
 * `resolveSharedContext()`) this plugin's templates read `packageName`/
 * `year` as real, pre-populated answers, not values `buildBlueprint()`
 * derives itself.
 */
const evaluator = new JsonLogicExpressionEvaluator();
const plugin: StackfoldPlugin = compileScaffold(definition as ScaffoldDefinition, evaluator);

async function buildBlueprintFor(answers: Answers) {
  const live = { ...answers };
  for (const handler of plugin.hooks?.preInit ?? []) {
    await handler(
      {
        prompter: { async ask() { return {}; } },
        fileWriter: {
          async ensureEmptyDir() {},
          async writeFile() {},
          async readFile() { return undefined; },
          async overwriteFile() {},
        },
        processRunner: { async run() {} },
      },
      live
    );
  }
  return plugin.buildBlueprint(live);
}

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace', appType: 'spa-react' };
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app', appType: 'spa-react' };
const BASE_STANDALONE: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace', appType: 'standalone-html' };

function question(id: string): QuestionDefinition {
  const q = plugin.questions().find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} not declared`);
  return q;
}

async function fileContent(answers: Answers, path: string): Promise<string> {
  const blueprint = await buildBlueprintFor(answers);
  const entry = blueprint.files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-stackfold plugin — identity', () => {
  it('has the stable id "web-app-stackfold" and a description', () => {
    expect(plugin.id).toBe('web-app-stackfold');
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  it('is resolvable through a registry by its id, independent of any other plugin', () => {
    const registry = new StaticPluginRegistry([plugin]);
    expect(registry.resolve('web-app-stackfold')).toBe(plugin);
  });
});

describe('web-app-stackfold plugin — questions()', () => {
  it('declares appName/description/author followed by a single appType select (Decision A option (c))', () => {
    expect(plugin.questions().map((q) => q.id)).toEqual(['appName', 'description', 'author', 'appType']);
  });

  it('appType is a select question with the 4 expected choices, defaulting to spa-react', () => {
    const q = question('appType');
    expect(q.type).toBe('select');
    expect(q.choices).toEqual(['standalone-html', 'spa-react', 'spa-vue', 'spa-vanilla']);
    expect(q.default).toBe('spa-react');
  });
});

describe('web-app-stackfold plugin — buildBlueprint() is pure and synchronous (once preInit hooks have run)', () => {
  it('returns a blueprint directly, not a Promise', async () => {
    const live = { ...ANSWERS };
    for (const handler of plugin.hooks?.preInit ?? []) {
      await handler({ prompter: { async ask() { return {}; } }, fileWriter: { async ensureEmptyDir() {}, async writeFile() {}, async readFile() { return undefined; }, async overwriteFile() {} }, processRunner: { async run() {} } }, live);
    }
    const result = plugin.buildBlueprint(live);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('is deterministic: same answers, same blueprint', async () => {
    expect(await buildBlueprintFor({ ...ANSWERS })).toEqual(await buildBlueprintFor({ ...ANSWERS }));
  });

  // Architecture-driven divergence from the old web-app family's own
  // `resolveSharedContext()` (which explicitly threw when `appName` was
  // missing): the SK-ADR-003 DSL has no equivalent internal guard inside
  // `buildBlueprint()` — a missing answer simply renders as an empty
  // Handlebars interpolation. Required-ness is enforced earlier, at the
  // `Prompter` boundary, by each question's own `validate` closure (see
  // `scaffold.test.ts`'s own "rejects an invalid appName" case) — the same
  // contract every other SK-ADR-003 plugin in this repo already has
  // (`electron-stackfold`/`plugin-builder` have no such internal throw
  // either). A direct `buildBlueprint()` call that skips the real
  // orchestrator's `resolveAnswers()` (which always fills in a declared
  // default) simply gets empty text in that position, not an exception.
  it('does not throw when appName is missing — renders an empty interpolation instead (validate() is the real guard, at the Prompter boundary)', () => {
    const result = plugin.buildBlueprint({ description: 'x', appType: 'spa-react' });
    const indexHtml = result.files.find((f) => f.path === 'index.html');
    expect(indexHtml?.content.toString()).toContain('<title></title>');
  });
});

describe('web-app-stackfold plugin — appType: "spa-react" (composed blueprint, formerly web-app-spa default)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-react, vitest, eslint)', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.files.map((f) => f.path)).toEqual([
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'LICENSE',
      'vite.config.ts',
      'index.html',
      'src/main.tsx',
      'src/App.tsx',
      'src/App.test.tsx',
      'vitest.config.ts',
      'src/setupTests.ts',
      'eslint.config.js',
    ]);
  });

  it('omits LICENSE when no author is given', async () => {
    const blueprint = await buildBlueprintFor(NO_AUTHOR);
    expect(blueprint.files.map((f) => f.path)).not.toContain('LICENSE');
  });

  it("package.json is valid JSON merging all four fragments' contributions under one roof", async () => {
    const pkg = JSON.parse(await fileContent(ANSWERS, 'package.json'));
    expect(pkg).toMatchObject({ name: 'my-cool-app', version: '0.1.0', private: true, type: 'module' });
    expect(pkg.dependencies).toEqual({ react: '^19.3.0', 'react-dom': '^19.3.0' });
    expect(pkg.devDependencies).toEqual({
      vite: '^8.3.4',
      '@vitejs/plugin-react': '^6.1.2',
      vitest: '^5.0.4',
      jsdom: '^27.4.0',
      '@testing-library/react': '^16.3.3',
      '@testing-library/jest-dom': '^7.0.1',
      '@types/react': '^19.3.0',
      '@types/react-dom': '^19.3.0',
      eslint: '^10.11.0',
      'typescript-eslint': '^8.70.1',
    });
    expect(pkg.scripts).toEqual({ dev: 'vite', build: 'vite build', test: 'vitest run' });
  });

  it('.gitignore carries node_modules/ and dist/ (append strategy, single contributor)', async () => {
    const lines = (await fileContent(ANSWERS, '.gitignore')).split('\n');
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('dist/');
  });

  it('postActions are git-init (base-ts) then npm-install (vite-react), plain concatenation in fragment order', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw (htmlEscapeKeys)', async () => {
    const html = await fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', appType: 'spa-react' },
      'index.html'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('tsconfig.json is strict, with no any-leniency added', async () => {
    const tsconfig = JSON.parse(await fileContent(ANSWERS, 'tsconfig.json'));
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, noEmit: true });
  });

  it('no free-text answer is ever interpolated into generated non-JSX TypeScript (.ts)', async () => {
    const answers: Answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      appType: 'spa-react',
    };
    const blueprint = await buildBlueprintFor(answers);
    for (const { path, content } of blueprint.files) {
      if (!path.endsWith('.ts')) continue;
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });

  it('App.tsx never string-templates appName into JSX text: it is a jsonEscapeKeys-escaped module constant read back via {APP_NAME}', async () => {
    const src = await fileContent({ ...ANSWERS, appName: 'a{b}c\\d' }, 'src/App.tsx');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a{b}c\\d')};`);
    expect(src).toContain('<h1>{APP_NAME}</h1>');
  });

  it('App.tsx is immune to JSX structural injection via appName: an angle-bracket payload never becomes a real sibling JSX element', async () => {
    const payload = '</h1><img src="https://evil.example/pixel.png"/><h1>injected';
    const src = await fileContent({ ...ANSWERS, appName: payload }, 'src/App.tsx');

    expect(src).toContain(`const APP_NAME = ${JSON.stringify(payload)};`);

    const jsxBlock = src.match(/<main>[\s\S]*?<\/main>/);
    expect(jsxBlock).not.toBeNull();
    expect(jsxBlock?.[0]).toBe('<main>\n      <h1>{APP_NAME}</h1>\n    </main>');
  });

  it('no branding or governance leakage in any file (§3.5)', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    for (const { content } of blueprint.files) {
      const text = content.toString().toLowerCase();
      for (const leak of ['stackfold', '.agents', 'claude-blueprints']) {
        expect(text).not.toContain(leak);
      }
    }
  });
});

describe('web-app-stackfold plugin — appType: "standalone-html" (the degenerate case, formerly web-app-standalone-html)', () => {
  it('emits exactly one file: index.html', async () => {
    const blueprint = await buildBlueprintFor(BASE_STANDALONE);
    expect(blueprint.files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('emits no package.json at all — zero deps, by design', async () => {
    const blueprint = await buildBlueprintFor(BASE_STANDALONE);
    expect(blueprint.files.some((f) => f.path === 'package.json')).toBe(false);
  });

  it('emits zero postActions', async () => {
    const blueprint = await buildBlueprintFor(BASE_STANDALONE);
    expect(blueprint.postActions).toEqual([]);
  });

  it('index.html names the app and its description, self-contained (inline style/script only)', async () => {
    const html = await fileContent(BASE_STANDALONE, 'index.html');
    expect(html).toContain('<title>My Cool App!</title>');
    expect(html).toContain('A demo app');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*\shref="https?:/);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw (htmlEscapeKeys)', async () => {
    const html = await fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', appType: 'standalone-html' },
      'index.html'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('adversarial: a real <img src=x onerror=...> appName payload comes out fully entity-escaped, never a live tag', async () => {
    const html = await fileContent({ ...BASE_STANDALONE, appName: '<img src=x onerror=alert(1)>' }, 'index.html');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no branding or governance leakage (§3.5)', async () => {
    const html = (await fileContent(BASE_STANDALONE, 'index.html')).toLowerCase();
    for (const leak of ['stackfold', '.agents', 'claude-blueprints']) {
      expect(html).not.toContain(leak);
    }
  });
});

/**
 * Minimal, dependency-free structural check that the emitted standalone
 * file actually parses as well-formed HTML — ported from
 * `web-app-standalone-html-plugin.test.ts`.
 */
function assertWellFormedHtmlDocument(html: string): void {
  expect(html.startsWith('<!doctype html>')).toBe(true);

  const openHtml = html.indexOf('<html');
  expect(openHtml, 'expected an opening <html ...>').toBeGreaterThanOrEqual(0);
  const openHead = html.indexOf('<head>', openHtml);
  expect(openHead, 'expected <head> after <html ...>').toBeGreaterThan(openHtml);
  const closeHead = html.indexOf('</head>', openHead);
  expect(closeHead, 'expected </head> after <head>').toBeGreaterThan(openHead);
  const openBody = html.indexOf('<body>', closeHead);
  expect(openBody, 'expected <body> after </head>').toBeGreaterThan(closeHead);
  const closeBody = html.indexOf('</body>', openBody);
  expect(closeBody, 'expected </body> after <body>').toBeGreaterThan(openBody);
  const closeHtml = html.indexOf('</html>', closeBody);
  expect(closeHtml, 'expected </html> after </body>').toBeGreaterThan(closeBody);
}

describe('web-app-stackfold plugin — standalone-html emitted file is a well-formed HTML document (parse-style check)', () => {
  it('starts with <!doctype html> and nests head/body inside html, each tag matched and in order', async () => {
    const html = await fileContent(BASE_STANDALONE, 'index.html');
    assertWellFormedHtmlDocument(html);
  });

  it('stays well-formed even with an HTML-breaking appName/description (escaping never corrupts document structure)', async () => {
    const html = await fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', appType: 'standalone-html' },
      'index.html'
    );
    assertWellFormedHtmlDocument(html);
  });
});

describe('web-app-stackfold plugin — end-to-end through the orchestrator (in-memory ports)', () => {
  it('scaffolds the full SPA file set through the full Template Method pipeline (appType: spa-react)', async () => {
    const { runPlugin } = await import('../../src/core/orchestrator.js');
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(plugin, '/work/app', {
      prompter: { ask: async () => ({ appName: 'Demo App', description: 'd', author: '', appType: 'spa-react' }) },
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

    expect(result.filesWritten).not.toContain('LICENSE');
    expect(JSON.parse(written.get('/work/app/package.json') ?? '').name).toBe('demo-app');
    expect(commands).toEqual(['/work/app: git init', '/work/app: npm install']);
  });

  it('scaffolds the single standalone file with zero post-actions run, through the unmodified pipeline (appType: standalone-html)', async () => {
    const { runPlugin } = await import('../../src/core/orchestrator.js');
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(plugin, '/work/app', {
      prompter: { ask: async () => ({ appName: 'Demo App', description: 'd', author: '', appType: 'standalone-html' }) },
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

    expect(result.filesWritten).toEqual(['index.html']);
    expect(written.has('/work/app/index.html')).toBe(true);
    expect(result.postActionsRun).toEqual([]);
    expect(commands).toEqual([]);
  });
});
