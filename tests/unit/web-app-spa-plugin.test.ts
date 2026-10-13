import { describe, expect, it } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import type { Answers, QuestionDefinition } from '../../src/core/types.js';

/**
 * `web-app-spa` plugin — Cycle 1 (initial_scaffold.md "web-app plugin
 * family (Cycle 1)"). Exercises all three `composeBlueprint()` merge
 * strategies (`json-merge` for `package.json`, `append` for `.gitignore`,
 * `exclusive` for everything else) through the real, composed flavor —
 * `composition.test.ts` already covers the merge algorithm itself in
 * isolation; this file covers the flavor's full content invariants.
 */

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app' };

function question(id: string): QuestionDefinition {
  const q = webAppSpaPlugin.questions().find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} not declared`);
  return q;
}

function fileContent(answers: Answers, path: string): string {
  const entry = webAppSpaPlugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-spa plugin — identity', () => {
  it('has the stable id "web-app-spa" and a description', () => {
    expect(webAppSpaPlugin.id).toBe('web-app-spa');
    expect(webAppSpaPlugin.description.length).toBeGreaterThan(0);
  });

  it('is resolvable through a registry by its id, independent of any other plugin', () => {
    const registry = new StaticPluginRegistry([webAppSpaPlugin]);
    expect(registry.resolve('web-app-spa')).toBe(webAppSpaPlugin);
  });
});

describe('web-app-spa plugin — questions()', () => {
  it('declares the shared base questions followed by the flavor-specific framework question', () => {
    expect(webAppSpaPlugin.questions().map((q) => q.id)).toEqual([
      'appName',
      'description',
      'author',
      'framework',
    ]);
  });

  it('framework is a select question defaulting to react (opinionated-by-default, overridable)', () => {
    const q = question('framework');
    expect(q.type).toBe('select');
    expect(q.choices).toEqual(['react']);
    expect(q.default).toBe('react');
  });
});

describe('web-app-spa plugin — buildBlueprint() is pure and synchronous', () => {
  it('returns a blueprint directly, not a Promise', () => {
    const result = webAppSpaPlugin.buildBlueprint(ANSWERS);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('is deterministic: same answers, same blueprint', () => {
    expect(webAppSpaPlugin.buildBlueprint({ ...ANSWERS })).toEqual(webAppSpaPlugin.buildBlueprint({ ...ANSWERS }));
  });

  it('throws a clear error if appName is missing', () => {
    expect(() => webAppSpaPlugin.buildBlueprint({ description: 'x' })).toThrow(/appName/);
  });
});

describe('web-app-spa plugin — default vs. overridden framework choice (resolveAnswers fallback, no new mechanism)', () => {
  it('questions() framework default itself resolves to react when no answer is supplied', () => {
    // Mirrors orchestrator.ts's resolveAnswers() fallback-to-default behavior:
    // an unanswered question resolves to its declared default.
    const q = question('framework');
    expect(q.default).toBe('react');
  });

  it('an explicit framework answer is honored over the default (same resolution path, no special-casing)', () => {
    // Cycle 1 only ships the "react" fragment, but the plugin contract must
    // not special-case "answer === default" vs. "answer supplied" — both
    // reach buildBlueprint() identically once resolved.
    const result = webAppSpaPlugin.buildBlueprint({ ...ANSWERS, framework: 'react' });
    const defaulted = webAppSpaPlugin.buildBlueprint(ANSWERS);
    expect(result).toEqual(defaulted);
  });
});

describe('web-app-spa plugin — composed blueprint (tier 2: content invariants)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-react, vitest, eslint)', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).files.map((f) => f.path)).toEqual([
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'LICENSE',
      'vite.config.ts',
      'index.html',
      'src/main.tsx',
      'src/App.tsx',
      'vitest.config.ts',
      'src/setupTests.ts',
      'src/App.test.tsx',
      'eslint.config.js',
    ]);
  });

  it('omits LICENSE when no author is given', () => {
    expect(webAppSpaPlugin.buildBlueprint(NO_AUTHOR).files.map((f) => f.path)).not.toContain('LICENSE');
  });

  it('package.json is valid JSON merging all four fragments\' contributions under one roof', () => {
    const pkg = JSON.parse(fileContent(ANSWERS, 'package.json'));
    expect(pkg).toMatchObject({
      name: 'my-cool-app',
      version: '0.1.0',
      private: true,
      type: 'module',
    });
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

  it('.gitignore carries node_modules/ and dist/ (append strategy, single contributor this cycle)', () => {
    const lines = fileContent(ANSWERS, '.gitignore').split('\n');
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('dist/');
  });

  it('postActions are git-init (base-ts) then npm-install (vite-react), plain concatenation in fragment order', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).postActions).toEqual([
      { kind: 'git-init' },
      { kind: 'npm-install' },
    ]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', () => {
    const html = fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' },
      'index.html'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('tsconfig.json is strict, with no any-leniency added', () => {
    const tsconfig = JSON.parse(fileContent(ANSWERS, 'tsconfig.json'));
    expect(tsconfig.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, noEmit: true });
  });

  it('no free-text answer is ever interpolated into generated non-JSX TypeScript (.ts)', () => {
    // .tsx is deliberately excluded here: App.tsx legitimately displays
    // appName as its page heading (vite-react.ts's renderAppTsx), escaped
    // for JSX-text-child safety by jsEscape() (braces/backslashes) — the
    // same "free text only ever reaches generated code through an escaping
    // function" invariant, not "never reaches it at all". Plain .ts files
    // (vite.config.ts, main.tsx's sibling non-JSX modules) carry no
    // free-text interpolation at all.
    const answers = { appName: "Evil'); require('child_process", description: 'DESC_MARKER', author: 'AUTHOR_MARKER' };
    for (const { path, content } of webAppSpaPlugin.buildBlueprint(answers).files) {
      if (!path.endsWith('.ts')) continue;
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });

  it('App.tsx never string-templates appName into JSX text: it is a JSON.stringify-d module constant read back via {APP_NAME}', () => {
    const src = fileContent({ ...ANSWERS, appName: 'a{b}c\\d' }, 'src/App.tsx');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a{b}c\\d')};`);
    expect(src).toContain('<h1>{APP_NAME}</h1>');
  });

  it('App.tsx is immune to JSX structural injection via appName: an angle-bracket payload never becomes a real sibling JSX element', () => {
    // Mirrors the adversarial pattern the sibling escapeHtml() tests already
    // use two tests earlier in this file. A prior jsEscape()-based escaper
    // only handled backslashes/braces and let `<`/`>` straight through,
    // letting this exact payload compile into real sibling <img>/<h1> JSX
    // nodes (review_report.md, "web-app plugin family Cycle 1" §7).
    const payload = '</h1><img src="https://evil.example/pixel.png"/><h1>injected';
    const src = fileContent({ ...ANSWERS, appName: payload }, 'src/App.tsx');

    // The payload must only ever appear inside the JSON-stringified constant
    // (a JS string literal), never as unescaped markup elsewhere in the file.
    expect(src).toContain(`const APP_NAME = ${JSON.stringify(payload)};`);

    // Structural proof, not a substring check: isolate the actual JSX
    // returned from <main> to </main> and assert it is byte-identical to
    // the non-adversarial shape, regardless of payload. A whole-file
    // substring/count check would be fooled by the payload's own literal
    // `<h1>`/`</h1>`/`<img ...>` text, which legitimately reappears inside
    // the JSON string-literal value assigned to APP_NAME above — that
    // occurrence is inert (quoted JS text), not JSX, which is exactly the
    // property this test exists to prove.
    const jsxBlock = src.match(/<main>[\s\S]*?<\/main>/);
    expect(jsxBlock).not.toBeNull();
    expect(jsxBlock?.[0]).toBe('<main>\n      <h1>{APP_NAME}</h1>\n    </main>');
  });

  it('no branding or governance leakage in any file (§3.5)', () => {
    for (const { content } of webAppSpaPlugin.buildBlueprint(ANSWERS).files) {
      const text = content.toString().toLowerCase();
      for (const leak of ['stackfold', '.agents', 'claude-blueprints']) {
        expect(text).not.toContain(leak);
      }
    }
  });
});

describe('web-app-spa plugin — end-to-end through the orchestrator (in-memory ports)', () => {
  it('scaffolds the full file set through the full Template Method pipeline', async () => {
    const { runPlugin } = await import('../../src/core/orchestrator.js');
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(webAppSpaPlugin, '/work/app', {
      prompter: { ask: async () => ({ appName: 'Demo App', description: 'd', author: '' }) },
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
});
