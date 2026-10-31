import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition from '../../src/plugins/web-app-stackfold/scaffold.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';

/**
 * Stackfold's own test environment is plain Node (no `jsdom`) — unlike the
 * *generated* project, which gets `jsdom` from the framework-agnostic
 * `vitest` fragment. This minimal fake implements exactly the three DOM
 * methods `renderApp()` needs, enough to run the real, generated
 * `renderApp()` unmodified and inspect the real tree it built.
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
 * `web-app-stackfold` plugin — `appType: "spa-vanilla"` (formerly
 * `web-app-spa` with `framework: 'vanilla'`). Mirrors
 * `web-app-stackfold-plugin.test.ts`'s own "composed blueprint" structure
 * for the react path. No testing-library of any kind is involved for this
 * framework — `src/main.ts`'s own exported `renderApp()` plus
 * `vitest`+`jsdom` (framework-agnostic) is the entire test surface.
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

const ANSWERS: Answers = {
  appName: 'My Cool App!',
  description: 'A demo app',
  author: 'Ada Lovelace',
  appType: 'spa-vanilla',
};
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app', appType: 'spa-vanilla' };

async function fileContent(answers: Answers, path: string): Promise<string> {
  const blueprint = await buildBlueprintFor(answers);
  const entry = blueprint.files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-stackfold plugin — appType: "spa-vanilla" (composed blueprint)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-vanilla, vitest, eslint)', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.files.map((f) => f.path)).toEqual([
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

  it('omits LICENSE when no author is given', async () => {
    const blueprint = await buildBlueprintFor(NO_AUTHOR);
    expect(blueprint.files.map((f) => f.path)).not.toContain('LICENSE');
  });

  it('package.json has no "dependencies" entry at all and no testing-library of any kind', async () => {
    const pkg = JSON.parse(await fileContent(ANSWERS, 'package.json'));
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

  it('postActions are git-init (base-ts) then npm-install (vite-vanilla), plain concatenation in fragment order', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', async () => {
    const html = await fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', appType: 'spa-vanilla' },
      'index.html'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
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

  it('main.ts never templates appName into markup at all: it is a jsonEscapeKeys-escaped module constant assigned to Node.textContent, never innerHTML', async () => {
    const src = await fileContent({ ...ANSWERS, appName: 'a<b>c&d' }, 'src/main.ts');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a<b>c&d')};`);
    expect(src).toContain('heading.textContent = APP_NAME;');
    expect(src).not.toContain('innerHTML');
  });

  it('no free-text answer is ever interpolated into any other generated .ts file (App.test.ts)', async () => {
    const answers: Answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      appType: 'spa-vanilla',
    };
    const src = await fileContent(answers, 'src/App.test.ts');
    expect(src).not.toContain('DESC_MARKER');
    expect(src).not.toContain('AUTHOR_MARKER');
    expect(src).not.toContain('child_process');
  });

  // Task 050 (.agents/specs/050-web-app-stackfold-intro-content.md
  // §Step 1) — the opt-out intro block's safety net: `false` must be
  // byte-identical to today's (flag-omitted) output. `src/main.ts` here
  // is also the real entry point (renderApp()), not just markup.
  it('includeStackfoldIntro: false produces a byte-identical src/main.ts to today\'s (flag-omitted) output', async () => {
    const withFlagFalse = await fileContent({ ...ANSWERS, includeStackfoldIntro: false }, 'src/main.ts');
    const flagOmitted = await fileContent(ANSWERS, 'src/main.ts');
    expect(withFlagFalse).toBe(flagOmitted);
    expect(withFlagFalse).not.toContain('data:image/webp;base64,');
  });

  it('includeStackfoldIntro: true (the default) includes the Stackfold intro block in src/main.ts, via its own independent renderApp()', async () => {
    const src = await fileContent({ ...ANSWERS, includeStackfoldIntro: true }, 'src/main.ts');
    expect(src).toContain('data:image/webp;base64,');
    expect(src).toContain('heading.textContent = APP_NAME;');
  });
});

/**
 * Adversarial coverage mirroring the react/vue structural-injection
 * proofs, adapted to vanilla's own rendering mechanism (DOM API, not a
 * templating/compiler layer): a markup-breaking payload must still only
 * ever surface as a `Node.textContent` assignment, never as parsed markup
 * — proven by actually running the real, generated `renderApp()`.
 */
describe('web-app-stackfold plugin — appType: "spa-vanilla" (adversarial: real renderApp(), not a hand-rolled escaper)', () => {
  it('renderApp() renders an angle-bracket/script payload as plain text, never as a real sibling DOM element', async () => {
    const payload = '</h1><img src="https://evil.example/pixel.png"/><h1>injected';
    const src = await fileContent({ ...ANSWERS, appName: payload }, 'src/main.ts');

    const createdTags: string[] = [];
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeNode => {
        createdTags.push(tag);
        return createFakeElement(tag);
      },
      getElementById: () => null, // no "#app" mount point in this fake document
    });

    const dir = await mkdtemp(join(tmpdir(), 'stackfold-web-app-stackfold-vanilla-'));
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
