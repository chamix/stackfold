import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import type { Answers } from '../../src/core/types.js';

/**
 * Stackfold's own test environment is plain Node (no `jsdom`) — unlike the
 * *generated* project, which gets `jsdom` from the framework-agnostic
 * `vitest` fragment. Rather than add `jsdom` as a new root devDependency
 * just to exercise three DOM calls (`document.createElement`,
 * `Node.appendChild`, `Element.replaceChildren`), this minimal fake
 * implements exactly those three methods — enough to run the real,
 * generated `renderApp()` unmodified and inspect the real tree it built,
 * without reimplementing any of `renderApp()`'s own escaping/assembly
 * logic (the thing this test exists to verify).
 */
interface FakeNode {
  tagName: string;
  textContent: string;
  children: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
}

function createFakeElement(tagName: string): FakeNode {
  return {
    tagName,
    textContent: '',
    children: [],
    appendChild(child: FakeNode): FakeNode {
      this.children.push(child);
      return child;
    },
  };
}

/**
 * `web-app-spa` plugin — `framework: 'vanilla'` (initial_scaffold.md,
 * Cycle 2 "web-app plugin family (Cycle 2 — vue/vanilla frameworks for
 * web-app-spa)"). Mirrors `web-app-spa-plugin.test.ts`'s own "composed
 * blueprint" structure for the react path. No testing-library of any
 * kind is involved for this framework — `src/main.ts`'s own exported
 * `renderApp()` plus `vitest`+`jsdom` (framework-agnostic) is the entire
 * test surface.
 */

const ANSWERS: Answers = {
  appName: 'My Cool App!',
  description: 'A demo app',
  author: 'Ada Lovelace',
  framework: 'vanilla',
};
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app', framework: 'vanilla' };

function fileContent(answers: Answers, path: string): string {
  const entry = webAppSpaPlugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-spa plugin — framework: "vanilla" (composed blueprint)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-vanilla, vitest, eslint)', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).files.map((f) => f.path)).toEqual([
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'LICENSE',
      'vite.config.ts',
      'index.html',
      'src/main.ts',
      'src/App.test.ts',
      'vitest.config.ts',
      'src/setupTests.ts',
      'eslint.config.js',
    ]);
  });

  it('omits LICENSE when no author is given', () => {
    expect(webAppSpaPlugin.buildBlueprint(NO_AUTHOR).files.map((f) => f.path)).not.toContain('LICENSE');
  });

  it('package.json has no "dependencies" entry at all and no testing-library of any kind', () => {
    const pkg = JSON.parse(fileContent(ANSWERS, 'package.json'));
    expect(pkg).toMatchObject({ name: 'my-cool-app', version: '0.1.0', private: true, type: 'module' });
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toEqual({
      vite: '^8.3.4',
      vitest: '^5.0.4',
      jsdom: '^27.4.0',
      '@testing-library/jest-dom': '^7.0.1', // framework-agnostic (vitest fragment) — not framework-specific testing-library
      eslint: '^10.11.0',
      'typescript-eslint': '^8.70.1',
    });
    for (const key of Object.keys(pkg.devDependencies)) {
      expect(key).not.toMatch(/testing-library\/(react|vue)/);
    }
    expect(pkg.scripts).toEqual({ dev: 'vite', build: 'vite build', test: 'vitest run' });
  });

  it('postActions are git-init (base-ts) then npm-install (vite-vanilla), plain concatenation in fragment order', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', () => {
    const html = fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', framework: 'vanilla' },
      'index.html'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no branding or governance leakage in any file (§3.5)', () => {
    for (const { content } of webAppSpaPlugin.buildBlueprint(ANSWERS).files) {
      const text = content.toString().toLowerCase();
      for (const leak of ['stackfold', '.agents', 'claude-blueprints']) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it('main.ts never templates appName into markup at all: it is a JSON.stringify-d module constant assigned to Node.textContent, never innerHTML', () => {
    const src = fileContent({ ...ANSWERS, appName: 'a<b>c&d' }, 'src/main.ts');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a<b>c&d')};`);
    expect(src).toContain('heading.textContent = APP_NAME;');
    expect(src).not.toContain('innerHTML');
  });

  it('no free-text answer is ever interpolated into any other generated .ts file (App.test.ts)', () => {
    const answers: Answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      framework: 'vanilla',
    };
    const src = fileContent(answers, 'src/App.test.ts');
    expect(src).not.toContain('DESC_MARKER');
    expect(src).not.toContain('AUTHOR_MARKER');
    expect(src).not.toContain('child_process');
  });
});

/**
 * Adversarial coverage mirroring the react/vue structural-injection
 * proofs, adapted to vanilla's own rendering mechanism (DOM API, not a
 * templating/compiler layer): a markup-breaking payload must still only
 * ever surface as a `Node.textContent` assignment, never as parsed markup
 * — proven by actually running the real, generated `renderApp()` and
 * asserting no extra sibling element was ever created, not merely a
 * substring check.
 */
describe('web-app-spa plugin — framework: "vanilla" (adversarial: real renderApp(), not a hand-rolled escaper)', () => {
  it('renderApp() renders an angle-bracket/script payload as plain text, never as a real sibling DOM element', async () => {
    const payload = '</h1><img src="https://evil.example/pixel.png"/><h1>injected';
    const src = fileContent({ ...ANSWERS, appName: payload }, 'src/main.ts');

    const createdTags: string[] = [];
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeNode => {
        createdTags.push(tag);
        return createFakeElement(tag);
      },
      getElementById: () => null, // no "#app" mount point in this fake document
    });

    // Real generated source, loaded from a real temp file (same
    // mkdtemp(tmpdir()) lifecycle `web-app-spa-plugin-tier3.test.ts`/
    // `web-app-spa-plugin-e2e.test.ts` already use), not a hand-rolled
    // reimplementation of renderApp()'s logic — this proves the actual
    // generated module, not a stand-in for it.
    const dir = await mkdtemp(join(tmpdir(), 'stackfold-web-app-spa-vanilla-'));
    try {
      const file = join(dir, 'main.ts');
      await writeFile(file, src, 'utf8');
      const mod: { renderApp: (c: FakeNode & { replaceChildren(...nodes: FakeNode[]): void }) => void } = await import(
        pathToFileURL(file).href
      );

      const container = createFakeElement('div') as FakeNode & { replaceChildren(...nodes: FakeNode[]): void };
      container.replaceChildren = function replaceChildren(...nodes: FakeNode[]): void {
        this.children = nodes;
      };
      mod.renderApp(container);

      // No <img> was ever created, despite the payload containing literal
      // "<img ...>" text — only the two elements renderApp() itself
      // constructs (main, h1) ever get created, and the raw payload ends
      // up solely as a text-content assignment.
      expect(createdTags).toEqual(['main', 'h1']);
      expect(container.children).toHaveLength(1);
      const main = container.children[0]!;
      expect(main.tagName).toBe('main');
      expect(main.children).toHaveLength(1);
      const heading = main.children[0]!;
      expect(heading.tagName).toBe('h1');
      expect(heading.textContent).toBe(payload);
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
