/**
 * ARCH-008/D4 (1)+(2) — text-only deprecation of `electron-ts` in favor of
 * `electron-stackfold`. `.agents/specs/arch-008-deprecate-electron-ts.md`.
 *
 * Covers:
 *  - `electron-ts`'s `description`/`help.details` declare the deprecation
 *    (substitute, since-version, planned-removal version) and drop the old
 *    "recommended entry" framing (I4/I6).
 *  - `electron-stackfold`'s `description`/`help.details` no longer call
 *    `electron-ts` "recommended" (I4).
 *  - `electron-ts`'s `questions()`/`buildBlueprint()` output is unchanged —
 *    a regression guard for I1, since this task must not touch
 *    `templates.ts`, `questions()` or `buildBlueprint()`.
 *  - the other 4 built-ins' `list`/`info` text stays byte-identical (I2/I3).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createElectronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import electronStackfoldDefinition from '../../src/plugins/electron-stackfold/scaffold.js';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { formatPluginInfo, formatPluginListEntry } from '../../src/cli/pluginHelp.js';
import webAppScaffold from '../../src/plugins/web-app-stackfold/scaffold.js';
import nodeHttpApiJson from '../../src/plugins/node-http-api-stackfold/scaffold.json' with { type: 'json' };
import pluginBuilderScaffold from '../../src/plugins/plugin-builder/scaffold.js';
import pluginScaffoldScaffold from '../../src/plugins/plugin-scaffold/scaffold.js';

const evaluator = new JsonLogicExpressionEvaluator();

describe('electron-ts — deprecation text (I4/I6)', () => {
  const plugin = createElectronTsPlugin();

  it('description declares the deprecation: substitute, since-version, planned removal version', () => {
    expect(plugin.description).toMatch(/deprecated since 2\.6\.0/i);
    expect(plugin.description).toMatch(/electron-stackfold/);
    expect(plugin.description).toMatch(/3\.0\.0/);
    expect(plugin.description).toMatch(/removal planned/i);
  });

  it('help.details declares the deprecation the same way', () => {
    expect(plugin.help?.details).toMatch(/deprecated since 2\.6\.0/i);
    expect(plugin.help?.details).toMatch(/electron-stackfold/);
    expect(plugin.help?.details).toMatch(/3\.0\.0/);
    expect(plugin.help?.details).toMatch(/removal planned/i);
  });

  it('description no longer recommends electron-ts for new projects', () => {
    expect(plugin.description).not.toMatch(/recommended/i);
  });

  it('help.details no longer calls electron-ts "the recommended entry"', () => {
    expect(plugin.help?.details).not.toMatch(/recommended/i);
  });

  it('does not phrase the 3.0.0 removal with a calendar date (I6: "planned", no date)', () => {
    // No day/month-name or ISO-date-shaped token anywhere near "3.0.0".
    expect(plugin.description).not.toMatch(/3\.0\.0.*\d{4}-\d{2}-\d{2}/);
    expect(plugin.help?.details ?? '').not.toMatch(/3\.0\.0.*\d{4}-\d{2}-\d{2}/);
  });
});

describe('electron-stackfold — no longer calls electron-ts "recommended" (I4)', () => {
  const plugin = compileScaffold(electronStackfoldDefinition as ScaffoldDefinition, evaluator);

  it('description does not call electron-ts the recommended entry', () => {
    expect(plugin.description).not.toMatch(/recommended/i);
  });

  it('help.details does not call electron-ts the recommended entry', () => {
    expect(plugin.help?.details).not.toMatch(/recommended/i);
  });

  it('text names electron-ts only as the deprecated predecessor, not as "the recommended entry"', () => {
    expect(plugin.description + ' ' + (plugin.help?.details ?? '')).toMatch(/deprecated electron-ts/);
  });
});

describe('electron-ts — questions()/buildBlueprint() unchanged (I1 regression guard)', () => {
  const FIXED_NOW = new Date(2031, 5, 15);
  const plugin = createElectronTsPlugin({ now: () => FIXED_NOW });

  const ANSWERS = {
    appName: 'RegressionApp',
    description: 'A regression-guard app',
    author: 'Ada Lovelace',
    includeSettings: true,
    includeSkins: true,
    includeAboutHelp: true,
  };

  it('questions() is byte-identical to the pre-deprecation fixture', () => {
    expect(
      plugin.questions().map((q) => ({ id: q.id, type: q.type, message: q.message, default: q.default }))
    ).toEqual([
      { id: 'appName', type: 'input', message: 'Application name', default: 'my-electron-app' },
      { id: 'description', type: 'input', message: 'Short description', default: 'An Electron + TypeScript desktop app.' },
      { id: 'author', type: 'input', message: 'Author (optional, used for package.json and an MIT LICENSE)', default: '' },
      { id: 'includeSettings', type: 'confirm', message: 'Include Settings (Dark Mode)?', default: false },
      { id: 'includeSkins', type: 'confirm', message: 'Include Skins (user-editable visual presets)?', default: false },
      { id: 'includeAboutHelp', type: 'confirm', message: 'Include About + Help windows?', default: false },
    ]);
  });

  it('buildBlueprint() produces the same 39-file tree, same postActions, same byte-for-byte digest as before this task', () => {
    const blueprint = plugin.buildBlueprint(ANSWERS);
    const paths = blueprint.files.map((f) => f.path).sort();

    expect(paths).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.gitignore',
      'LICENSE',
      'README.md',
      'electron-builder.yml',
      'help.md',
      'package.json',
      'playwright.config.ts',
      'scripts/build.mjs',
      'src/main/aboutWindow.ts',
      'src/main/atomicWriteFile.ts',
      'src/main/helpWindow.ts',
      'src/main/index.ts',
      'src/main/ipc.ts',
      'src/main/linkPolicy.ts',
      'src/main/menu.ts',
      'src/main/settings.ts',
      'src/main/settingsStore.ts',
      'src/main/skins.ts',
      'src/main/skinsStore.ts',
      'src/main/staticWindowShell.ts',
      'src/main/windowConfig.ts',
      'src/preload/api.ts',
      'src/preload/index.ts',
      'src/renderer/app.css',
      'src/renderer/index.html',
      'src/renderer/skins.ts',
      'src/renderer/theme.ts',
      'tests/e2e/smoke.spec.ts',
      'tests/e2e/support/fixtures.ts',
      'tests/e2e/support/pollUntilStable.ts',
      'tests/unit/pollUntilStable.test.ts',
      'third-party-notices.json',
      'tsconfig.base.json',
      'tsconfig.main.json',
      'tsconfig.renderer.json',
      'tsconfig.typecheck.json',
      'vitest.config.ts',
    ]);
    expect(blueprint.postActions).toEqual([{ kind: 'git-init' }]);

    const digest = createHash('sha256');
    for (const f of [...blueprint.files].sort((a, b) => a.path.localeCompare(b.path))) {
      digest.update(f.path);
      digest.update('\u0000');
      digest.update(f.content.toString());
      digest.update('\u0001');
    }
    expect(digest.digest('hex')).toBe('5c18d7b9154e3296f2141217e09cc37f75b3dff16557e2448e1bbd99140fc918');
  });
});

describe('other 4 built-ins — list/info text stays byte-identical (I2/I3: no contamination from this task)', () => {
  const webApp = compileScaffold(webAppScaffold as ScaffoldDefinition, evaluator);
  const nodeHttpApi = compileScaffold(nodeHttpApiJson as ScaffoldDefinition, evaluator);
  const pluginBuilder = compileScaffold(pluginBuilderScaffold as ScaffoldDefinition, evaluator);
  const pluginScaffold = compileScaffold(pluginScaffoldScaffold as ScaffoldDefinition, evaluator);

  it('web-app-stackfold', () => {
    expect(formatPluginListEntry(webApp)).toEqual([
      'Web App (web-app-stackfold)',
      '    Web app: a standalone HTML file, or a Vite single-page app in React, Vue or',
      '    vanilla TypeScript (with vitest and ESLint).',
    ]);
    expect(formatPluginInfo(webApp)).toEqual([
      'Web App (web-app-stackfold)',
      'Web app: a standalone HTML file, or a Vite single-page app in React, Vue or vanilla TypeScript (with vitest and ESLint).',
      '',
      'Choose one appType during init: a single, dependency-free standalone HTML file (no server, no network after load), or a Vite-powered single-page app in React, Vue, or plain vanilla TS (client-side routing-ready, no SSR). vitest + eslint are wired in for every SPA choice, regardless of framework.',
      '',
      'Questions:',
      '  appName (input): Application name [default: my-web-app]',
      '  description (input): Short description [default: A web app.]',
      '  author (input): Author (optional, used for package.json and an MIT LICENSE) [default: ]',
      '  appType (select): App type [default: spa-react]',
      '  includeStackfoldIntro (confirm): Include a short Stackfold intro on the main screen? (you can remove it anytime) [default: true]',
    ]);
  });

  it('node-http-api-stackfold', () => {
    expect(formatPluginListEntry(nodeHttpApi)).toEqual([
      'Node HTTP API (node-http-api-stackfold)',
      '    Generates a dependency-free Node.js + TypeScript HTTP microservice',
      '    (node:http only) with router, JSON body parsing, structured logs,',
      '    health/readiness probes, graceful shutdown, and optional CORS, Dockerfile',
      '    and example resource.',
    ]);
    expect(formatPluginInfo(nodeHttpApi)).toEqual([
      'Node HTTP API (node-http-api-stackfold)',
      'Generates a dependency-free Node.js + TypeScript HTTP microservice (node:http only) with router, JSON body parsing, structured logs, health/readiness probes, graceful shutdown, and optional CORS, Dockerfile and example resource.',
      '',
      'Zero runtime dependencies: node:http only. Dev tooling: typescript, vitest, tsx, @types/node. Questions: projectName, description, port, cors, docker, exampleResource.',
      '',
      'Questions:',
      '  projectName (input): Project name? [default: my-service]',
      '  description (input): Short description? [default: An HTTP microservice]',
      '  port (input): Default HTTP port? [default: 3000]',
      '  cors (confirm): Include CORS support? [default: false]',
      '  docker (confirm): Include a Dockerfile? [default: false]',
      '  exampleResource (confirm): Include example resource /api/v1/items? [default: false]',
    ]);
  });

  it('plugin-builder', () => {
    expect(formatPluginListEntry(pluginBuilder)).toEqual([
      'Plugin Builder (plugin-builder)',
      '    Scaffolds a new stackfold plugin inside a stackfold repository checkout and',
      '    registers it in the CLI.',
    ]);
    expect(formatPluginInfo(pluginBuilder)).toEqual([
      'Plugin Builder (plugin-builder)',
      'Scaffolds a new stackfold plugin inside a stackfold repository checkout and registers it in the CLI.',
      '',
      'Generates a new plugin as a TypeScript scaffold.ts plus sibling .hbs templates under src/plugins/<pluginId>/, compiles its scaffold.json with `stackfold scaffold synth`, and registers it in src/cli/index.ts. Run from the root of a stackfold checkout. For a standalone plugin that needs no checkout, use `plugin-scaffold` instead.',
      '',
      'Questions:',
      '  pluginId (input): Plugin id (kebab-case, e.g. "my-cool-plugin") [default: my-plugin]',
      '  displayName (input): Display name (shown in `stackfold list`/`info`) [default: My Plugin]',
      '  description (input): Short description (shown in listings) [default: A stackfold plugin.]',
      '  author (input): Author [default: ]',
    ]);
  });

  it('plugin-scaffold', () => {
    expect(formatPluginListEntry(pluginScaffold)).toEqual([
      'Plugin Scaffold (plugin-scaffold)',
      '    Scaffolds a standalone stackfold plugin that needs no repository checkout: a',
      '    TypeScript scaffold.ts using the "stackfold/authoring" API, compiled with',
      '    `stackfold scaffold synth`. Prints the `stackfold plugin register` command',
      '    to run next.',
    ]);
    expect(formatPluginInfo(pluginScaffold)).toEqual([
      'Plugin Scaffold (plugin-scaffold)',
      'Scaffolds a standalone stackfold plugin that needs no repository checkout: a TypeScript scaffold.ts using the "stackfold/authoring" API, compiled with `stackfold scaffold synth`. Prints the `stackfold plugin register` command to run next.',
      '',
      'Generates a standalone stackfold plugin: a TypeScript scaffold.ts plus sibling .hbs templates and its own package.json ("type": "module"), importing the authoring API from the installed "stackfold" package — no repository checkout needed. Compiles its scaffold.json with `stackfold scaffold synth`, then prints the exact `stackfold plugin register` command to run next. Run `stackfold init plugin-scaffold <pluginId>` from the directory the new plugin should be created in (its own root ends up being exactly that directory).',
      '',
      'Questions:',
      '  pluginId (input): Plugin id (kebab-case, e.g. "my-cool-plugin") [default: my-plugin]',
      '  displayName (input): Display name (shown in `stackfold list`/`info`) [default: My Plugin]',
      '  description (input): Short description (shown in listings) [default: A stackfold plugin.]',
      '  author (input): Author [default: ]',
    ]);
  });

  it('none of these 4 plugins mention electron-ts anywhere in list/info text', () => {
    for (const plugin of [webApp, nodeHttpApi, pluginBuilder, pluginScaffold]) {
      expect(formatPluginListEntry(plugin).join('\n')).not.toMatch(/electron-ts/i);
      expect(formatPluginInfo(plugin).join('\n')).not.toMatch(/electron-ts/i);
    }
  });
});
