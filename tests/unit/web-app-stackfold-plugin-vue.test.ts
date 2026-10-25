import { compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import definition from '../../src/plugins/web-app-stackfold/scaffold.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';

/**
 * `web-app-stackfold` plugin — `appType: "spa-vue"` (formerly
 * `web-app-spa` with `framework: 'vue'`). Mirrors
 * `web-app-stackfold-plugin.test.ts`'s own "composed blueprint" structure
 * for the react path, plus Vue-specific adversarial coverage: own
 * payloads, own compiler (`@vue/compiler-sfc`), not a copy of the JSX
 * test. Also covers the `scriptCloseEscapeKeys` defense (Task 043 review
 * follow-up) this fragment's `App.vue` now relies on — the exact old
 * adversarial test this port must not silently lose.
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
  appType: 'spa-vue',
};
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app', appType: 'spa-vue' };

async function fileContent(answers: Answers, path: string): Promise<string> {
  const blueprint = await buildBlueprintFor(answers);
  const entry = blueprint.files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-stackfold plugin — appType: "spa-vue" (composed blueprint)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-vue, vitest, eslint)', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.files.map((f) => f.path)).toEqual([
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'LICENSE',
      'vite.config.ts',
      'index.html',
      'src/main.ts',
      'src/env.d.ts',
      'src/App.vue',
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

  it("package.json is valid JSON merging all four fragments' contributions under one roof", async () => {
    const pkg = JSON.parse(await fileContent(ANSWERS, 'package.json'));
    expect(pkg).toMatchObject({ name: 'my-cool-app', version: '0.1.0', private: true, type: 'module' });
    expect(pkg.dependencies).toEqual({ vue: '^3.5.44' });
    expect(pkg.devDependencies).toEqual({
      vite: '^8.3.4',
      '@vitejs/plugin-vue': '^6.0.10',
      '@testing-library/vue': '^8.1.0',
      vitest: '^5.0.4',
      jsdom: '^27.4.0',
      '@testing-library/jest-dom': '^7.0.1',
      eslint: '^10.11.0',
      'typescript-eslint': '^8.70.1',
    });
    expect(pkg.scripts).toEqual({ dev: 'vite', build: 'vite build', test: 'vitest run' });
  });

  it('postActions are git-init (base-ts) then npm-install (vite-vue), plain concatenation in fragment order', async () => {
    const blueprint = await buildBlueprintFor(ANSWERS);
    expect(blueprint.postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', async () => {
    const html = await fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', appType: 'spa-vue' },
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

  it('no free-text answer is ever interpolated into generated plain .ts (main.ts, env.d.ts, App.test.ts)', async () => {
    const answers: Answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      appType: 'spa-vue',
    };
    const blueprint = await buildBlueprintFor(answers);
    for (const { path, content } of blueprint.files) {
      if (!path.endsWith('.ts')) continue; // .vue is covered by the adversarial tests below, not here
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });

  it('App.vue never string-templates appName into <template> text: it is a jsonEscapeKeys-escaped module constant in <script setup>, read back via {{ APP_NAME }}', async () => {
    const src = await fileContent({ ...ANSWERS, appName: 'a{b}c\\d' }, 'src/App.vue');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a{b}c\\d')};`);
    expect(src).toContain('<h1>{{ APP_NAME }}</h1>');
  });
});

/**
 * Adversarial coverage specific to Vue's own compiler/interpolation
 * semantics — own payloads, own compiler (`@vue/compiler-sfc`), per the
 * old technical spec's explicit instruction not to reuse the JSX test
 * verbatim. The first case here is the exact regression
 * `scriptCloseEscapeKeys` (Task 043 review follow-up) exists to prevent.
 */
describe('web-app-stackfold plugin — appType: "spa-vue" (adversarial: real @vue/compiler-sfc, not a hand-rolled escaper)', () => {
  it("App.vue never lets a closing-script-tag payload break the SFC's own <script> block", async () => {
    const payload = 'evil</script><script>alert(1)</script>';
    const src = await fileContent({ ...ANSWERS, appName: payload }, 'src/App.vue');

    const { descriptor, errors } = parse(src, { filename: 'App.vue' });
    expect(errors).toEqual([]);
    expect(descriptor.scriptSetup?.content).toContain('APP_NAME');
    expect(descriptor.template?.content).toContain('{{ APP_NAME }}');

    // The escaped literal, evaluated as real JS, still yields the exact,
    // unescaped original payload — the fix is cosmetic to the SFC parser
    // only, never a mutation of the actual runtime value.
    // eslint-disable-next-line no-eval
    const runtimeValue: unknown = eval(descriptor.scriptSetup!.content.match(/APP_NAME = (.*);/)![1]!);
    expect(runtimeValue).toBe(payload);
  });

  it('App.vue is immune to Vue mustache-interpolation injection via appName: a "{{ }}" payload never becomes a second, attacker-controlled expression slot', async () => {
    const payload = '}}<script>alert(1)</script>{{ 7*7 }}';
    const src = await fileContent({ ...ANSWERS, appName: payload }, 'src/App.vue');

    const { descriptor, errors } = parse(src, { filename: 'App.vue' });
    expect(errors).toEqual([]);

    const compiled = compileTemplate({ id: 'x', source: descriptor.template!.content, filename: 'App.vue' });
    expect(compiled.errors).toEqual([]);
    expect(compiled.code).toContain('toDisplayString(_ctx.APP_NAME)');
    expect(compiled.code).not.toContain('7*7');
    expect(compiled.code).not.toContain('alert(1)');
  });

  it("App.vue's compiled render function always reads a single static toDisplayString(APP_NAME) TEXT node, regardless of payload", async () => {
    const src = await fileContent(ANSWERS, 'src/App.vue');
    const { descriptor } = parse(src, { filename: 'App.vue' });
    const compiled = compileTemplate({ id: 'x', source: descriptor.template!.content, filename: 'App.vue' });
    expect(compiled.errors).toEqual([]);
    expect(compiled.code).toMatch(/_createElementVNode\("h1", null, _toDisplayString\(_ctx\.APP_NAME\), 1 \/\* TEXT \*\/\)/);
  });
});
