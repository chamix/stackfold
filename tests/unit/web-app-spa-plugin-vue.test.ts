import { compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import type { Answers } from '../../src/core/types.js';

/**
 * `web-app-spa` plugin — `framework: 'vue'` (initial_scaffold.md, Cycle 2
 * "web-app plugin family (Cycle 2 — vue/vanilla frameworks for
 * web-app-spa)"). Mirrors `web-app-spa-plugin.test.ts`'s own "composed
 * blueprint" structure for the react path, plus Vue-specific adversarial
 * coverage the technical spec calls out by name: own payloads, own
 * compiler (`@vue/compiler-sfc`), not a copy of the JSX test.
 */

const ANSWERS: Answers = {
  appName: 'My Cool App!',
  description: 'A demo app',
  author: 'Ada Lovelace',
  framework: 'vue',
};
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app', framework: 'vue' };

function fileContent(answers: Answers, path: string): string {
  const entry = webAppSpaPlugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('web-app-spa plugin — framework: "vue" (composed blueprint)', () => {
  it('emits the expected file set, in fragment order (base-ts, vite-vue, vitest, eslint)', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).files.map((f) => f.path)).toEqual([
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

  it('omits LICENSE when no author is given', () => {
    expect(webAppSpaPlugin.buildBlueprint(NO_AUTHOR).files.map((f) => f.path)).not.toContain('LICENSE');
  });

  it('package.json is valid JSON merging all four fragments\' contributions under one roof', () => {
    const pkg = JSON.parse(fileContent(ANSWERS, 'package.json'));
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

  it('postActions are git-init (base-ts) then npm-install (vite-vue), plain concatenation in fragment order', () => {
    expect(webAppSpaPlugin.buildBlueprint(ANSWERS).postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', () => {
    const html = fileContent(
      { appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', framework: 'vue' },
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

  it('no free-text answer is ever interpolated into generated plain .ts (main.ts, env.d.ts, App.test.ts)', () => {
    const answers: Answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      framework: 'vue',
    };
    for (const { path, content } of webAppSpaPlugin.buildBlueprint(answers).files) {
      if (!path.endsWith('.ts')) continue; // .vue is covered by the adversarial tests below, not here
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });

  it('App.vue never string-templates appName into <template> text: it is a JSON.stringify-d module constant in <script setup>, read back via {{ APP_NAME }}', () => {
    const src = fileContent({ ...ANSWERS, appName: 'a{b}c\\d' }, 'src/App.vue');
    expect(src).toContain(`const APP_NAME = ${JSON.stringify('a{b}c\\d')};`);
    expect(src).toContain('<h1>{{ APP_NAME }}</h1>');
  });
});

/**
 * Adversarial coverage specific to Vue's own compiler/interpolation
 * semantics — own payloads, own compiler (`@vue/compiler-sfc`), per the
 * technical spec's explicit instruction not to reuse the JSX test
 * verbatim.
 */
describe('web-app-spa plugin — framework: "vue" (adversarial: real @vue/compiler-sfc, not a hand-rolled escaper)', () => {
  it('App.vue never lets a closing-script-tag payload break the SFC\'s own <script> block', () => {
    const payload = 'evil</script><script>alert(1)</script>';
    const src = fileContent({ ...ANSWERS, appName: payload }, 'src/App.vue');

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

  it('App.vue is immune to Vue mustache-interpolation injection via appName: a "{{ }}" payload never becomes a second, attacker-controlled expression slot', () => {
    // Because APP_NAME is a JS string constant read back through a single
    // `{{ APP_NAME }}` expression slot, Vue's compiler evaluates the
    // *identifier* APP_NAME once — it never re-parses APP_NAME's own
    // string *value* for further "{{ }}" syntax. Proven structurally by
    // compiling the real <template> block and asserting the render
    // function treats the whole slot as a single toDisplayString() TEXT
        // VNode, not a dynamically re-interpolated string.
    const payload = '}}<script>alert(1)</script>{{ 7*7 }}';
    const src = fileContent({ ...ANSWERS, appName: payload }, 'src/App.vue');

    const { descriptor, errors } = parse(src, { filename: 'App.vue' });
    expect(errors).toEqual([]);

    const compiled = compileTemplate({ id: 'x', source: descriptor.template!.content, filename: 'App.vue' });
    expect(compiled.errors).toEqual([]);
    expect(compiled.code).toContain('toDisplayString(_ctx.APP_NAME)');
    expect(compiled.code).not.toContain('7*7');
    expect(compiled.code).not.toContain('alert(1)');
  });

  it('App.vue\'s compiled render function always reads a single static toDisplayString(APP_NAME) TEXT node, regardless of payload', () => {
    const src = fileContent(ANSWERS, 'src/App.vue');
    const { descriptor } = parse(src, { filename: 'App.vue' });
    const compiled = compileTemplate({ id: 'x', source: descriptor.template!.content, filename: 'App.vue' });
    expect(compiled.errors).toEqual([]);
    expect(compiled.code).toMatch(/_createElementVNode\("h1", null, _toDisplayString\(_ctx\.APP_NAME\), 1 \/\* TEXT \*\/\)/);
  });
});
