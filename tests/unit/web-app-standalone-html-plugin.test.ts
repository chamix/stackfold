import { describe, expect, it } from 'vitest';
import { webAppStandaloneHtmlPlugin } from '../../src/plugins/web-app/standalone-html.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import { runPlugin } from '../../src/core/orchestrator.js';
import type { Answers } from '../../src/core/types.js';

/**
 * `web-app-standalone-html` plugin — Cycle 1 (initial_scaffold.md "web-app
 * plugin family (Cycle 1)"). The zero-fragment-collision, zero-
 * `postActions` degenerate path through `composeBlueprint()`
 * (SK-ADR-001's "Consequences"; functional_domain_webapp.md §3.7): exactly
 * one file, no `package.json`, no follow-up actions — and none of that
 * requires any special-casing in `core/orchestrator.ts`.
 */

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

describe('web-app-standalone-html plugin — identity', () => {
  it('has the stable id "web-app-standalone-html" and a description', () => {
    expect(webAppStandaloneHtmlPlugin.id).toBe('web-app-standalone-html');
    expect(webAppStandaloneHtmlPlugin.description.length).toBeGreaterThan(0);
  });

  it('is resolvable through a registry by its id, independent of any other plugin', () => {
    const registry = new StaticPluginRegistry([webAppStandaloneHtmlPlugin]);
    expect(registry.resolve('web-app-standalone-html')).toBe(webAppStandaloneHtmlPlugin);
  });
});

describe('web-app-standalone-html plugin — questions()', () => {
  it('declares only the shared base questions — no flavor-specific question at all', () => {
    expect(webAppStandaloneHtmlPlugin.questions().map((q) => q.id)).toEqual(['appName', 'description', 'author']);
  });
});

describe('web-app-standalone-html plugin — buildBlueprint() is pure and synchronous', () => {
  it('returns a blueprint directly, not a Promise', () => {
    const result = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('is deterministic: same answers, same blueprint', () => {
    expect(webAppStandaloneHtmlPlugin.buildBlueprint({ ...ANSWERS })).toEqual(
      webAppStandaloneHtmlPlugin.buildBlueprint({ ...ANSWERS })
    );
  });

  it('throws a clear error if appName is missing', () => {
    expect(() => webAppStandaloneHtmlPlugin.buildBlueprint({ description: 'x' })).toThrow(/appName/);
  });
});

describe('web-app-standalone-html plugin — composed blueprint (the degenerate case)', () => {
  it('emits exactly one file: index.html', () => {
    const result = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS);
    expect(result.files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('emits no package.json at all — zero deps, by design', () => {
    const result = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS);
    expect(result.files.some((f) => f.path === 'package.json')).toBe(false);
  });

  it('emits zero postActions', () => {
    expect(webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS).postActions).toEqual([]);
  });

  it('index.html names the app and its description, self-contained (inline style/script only)', () => {
    const html = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS).files[0]!.content.toString();
    expect(html).toContain('<title>My Cool App!</title>');
    expect(html).toContain('A demo app');
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*\shref="https?:/);
  });

  it('index.html escapes HTML-breaking appName/description instead of interpolating them raw', () => {
    const html = webAppStandaloneHtmlPlugin
      .buildBlueprint({ appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' })
      .files[0]!.content.toString();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('no branding or governance leakage (§3.5)', () => {
    const html = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS).files[0]!.content.toString().toLowerCase();
    for (const leak of ['stackfold', '.agents', 'claude-blueprints']) {
      expect(html).not.toContain(leak);
    }
  });
});

/**
 * Minimal, dependency-free structural check that the emitted file actually
 * parses as well-formed HTML — the spec's "no network tier needed...open
 * the single emitted HTML file and assert it parses" requirement
 * (initial_scaffold.md Cycle 1 "Test strategy" item). Neither this repo's
 * own devDependencies nor root package.json (out of scope for this task)
 * carry an HTML parser (no jsdom/happy-dom/linkedom/parse5/htmlparser2), so
 * this is a minimal balanced/ordered-tag check scoped to exactly the
 * handful of structural elements this single emitted file ever contains
 * (html/head/body) — not a general-purpose parser.
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

describe('web-app-standalone-html plugin — emitted file is a well-formed HTML document (parse-style check)', () => {
  it('starts with <!doctype html> and nests head/body inside html, each tag matched and in order', () => {
    const html = webAppStandaloneHtmlPlugin.buildBlueprint(ANSWERS).files[0]!.content.toString();
    assertWellFormedHtmlDocument(html);
  });

  it('stays well-formed even with an HTML-breaking appName/description (escaping never corrupts document structure)', () => {
    const html = webAppStandaloneHtmlPlugin
      .buildBlueprint({ appName: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' })
      .files[0]!.content.toString();
    assertWellFormedHtmlDocument(html);
  });
});

describe('web-app-standalone-html plugin — end-to-end through the orchestrator (in-memory ports), no special-casing needed', () => {
  it('scaffolds the single file with zero post-actions run, through the unmodified Template Method pipeline', async () => {
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(webAppStandaloneHtmlPlugin, '/work/app', {
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

    expect(result.filesWritten).toEqual(['index.html']);
    expect(written.has('/work/app/index.html')).toBe(true);
    expect(result.postActionsRun).toEqual([]);
    expect(commands).toEqual([]);
  });
});
