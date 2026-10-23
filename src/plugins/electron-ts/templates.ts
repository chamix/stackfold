import type { Answers } from '../../core/types.js';
import { toBridgeGlobal, toPackageName } from '../../core/stringTransforms.js';
import { appNameSchema, toValidate } from '../../core/validation.js';

/**
 * electron-ts Tier-1 shell: answer resolution + the data-driven template
 * registry (initial_scaffold.md — "electron-ts Tier-1 shell (Cycle A)").
 *
 * Everything here is pure: no I/O, no async, no clock reads (the year is
 * passed in). Generated TypeScript only ever interpolates derived tokens
 * restricted to [A-Za-z0-9.-]; free-text answers (appName, description,
 * author) are confined to JSON-encoded package.json and to Markdown/plain
 * text files, so no answer can inject code into the generated project.
 */

export const DEFAULT_APP_NAME = 'my-electron-app';
export const DEFAULT_DESCRIPTION = 'An Electron + TypeScript desktop app.';
export const DEFAULT_AUTHOR = '';

/**
 * Derived tokens every Tier-1 template renders from. Internal to this
 * plugin, not a core/ type (YAGNI until a second plugin needs the shape).
 */
export interface ResolvedContext {
  appName: string;
  description: string;
  /** Empty when not supplied — LICENSE is then omitted entirely. */
  author: string;
  /** npm-safe slug: [a-z0-9] runs joined by single '-'. */
  packageName: string;
  /** Reverse-DNS id: `com.<packageName>.app`. */
  appId: string;
  /** The single `window.<bridgeGlobal>` identifier the preload exposes. */
  bridgeGlobal: string;
  /** IPC channel names are `${ipcPrefix}:<operation>`. */
  ipcPrefix: string;
  /** Copyright year for LICENSE — injected, never read from a clock here. */
  year: number;
  /** Settings feature selected (Dark Mode). */
  includeSettings: boolean;
  /** Skins feature selected (named, user-editable visual presets). */
  includeSkins: boolean;
  /** About + Help windows selected (one flag gates both — Decision 2). */
  includeAboutHelp: boolean;
}

function optionalString(answers: Answers, id: string, fallback: string): string {
  const value = answers[id];
  return value === undefined ? fallback : String(value).trim();
}

function optionalBoolean(answers: Answers, id: string, fallback: boolean): boolean {
  const value = answers[id];
  return value === undefined ? fallback : Boolean(value);
}

/** Answers → resolved context. Throws on a missing or invalid appName. */
export function resolveContext(answers: Answers, now: Date): ResolvedContext {
  const rawAppName = answers['appName'];
  if (rawAppName === undefined) {
    throw new Error('electron-ts: missing required answer "appName"');
  }
  const appName = String(rawAppName).trim();
  const verdict = toValidate(appNameSchema)(appName);
  if (verdict !== true) throw new Error(`electron-ts: invalid appName: ${verdict}`);

  const packageName = toPackageName(appName);
  return {
    appName,
    description: optionalString(answers, 'description', DEFAULT_DESCRIPTION),
    author: optionalString(answers, 'author', DEFAULT_AUTHOR),
    packageName,
    appId: `com.${packageName}.app`,
    bridgeGlobal: toBridgeGlobal(packageName, 'Api'),
    ipcPrefix: packageName,
    year: now.getFullYear(),
    includeSettings: optionalBoolean(answers, 'includeSettings', false),
    includeSkins: optionalBoolean(answers, 'includeSkins', false),
    includeAboutHelp: optionalBoolean(answers, 'includeAboutHelp', false),
  };
}

/** One generated file: where it goes, and how its content is rendered. */
export interface TierFile {
  readonly path: string;
  /** Omitted files are skipped entirely (e.g. LICENSE without an author). */
  readonly include?: (ctx: ResolvedContext) => boolean;
  readonly render: (ctx: ResolvedContext) => string;
}

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const hasAuthor = (ctx: ResolvedContext): boolean => ctx.author !== '';

/**
 * Escapes the five characters that matter for free text placed inside an
 * HTML text node or a double-quoted attribute (`&` first, so it never
 * double-escapes the entities it just produced). Required anywhere a
 * free-text answer (appName, description) is interpolated into generated
 * HTML — mirrors Cycle A's "no free-text answer is ever interpolated
 * unescaped" invariant, extended here from `.ts`/JSON contexts to HTML.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** zod is a runtime dependency of the generated app (schema validation at app
 * runtime), used by Settings and/or Skins — never devDependencies. Verified
 * against the npm registry 2026-10-04. */
const needsZod = (ctx: ResolvedContext): boolean => ctx.includeSettings || ctx.includeSkins;

/**
 * Per-process tsconfig split (Option B) is needed whenever *any* renderer
 * `.ts` file exists, not only for Settings — Skins' own renderer consumer
 * (`src/renderer/skins.ts`, spec: skins-renderer-consumer.md) needs the DOM
 * lib exactly as `theme.ts` does, and is gated on `ctx.includeSkins`
 * independently of `ctx.includeSettings`. The single shared `tsconfig.json`
 * (no DOM lib) stays correct only when *neither* flag selects a renderer
 * `.ts` file.
 */
const needsRendererSplit = (ctx: ResolvedContext): boolean => ctx.includeSettings || ctx.includeSkins;

function renderPackageJson(ctx: ResolvedContext): string {
  return json({
    name: ctx.packageName,
    productName: ctx.appName,
    version: '0.1.0',
    description: ctx.description,
    private: true,
    ...(hasAuthor(ctx) ? { author: ctx.author, license: 'MIT' } : {}),
    main: 'dist/main/index.js',
    scripts: {
      build: 'node scripts/build.mjs',
      package: 'electron-builder',
      typecheck: 'tsc --noEmit -p tsconfig.typecheck.json',
      test: 'vitest run',
      'test:e2e': 'playwright test',
    },
    ...(needsZod(ctx) ? { dependencies: { zod: '^4.6.5' } } : {}),
    devDependencies: {
      electron: '^44.4.5',
      typescript: '^6.0.3',
      vitest: '^5.0.2',
      '@types/node': '^24.19.0',
      esbuild: '^0.28.2',
      'electron-builder': '^26.15.3',
      '@playwright/test': '^1.64.0',
    },
    // Forces electron-builder's own `@electron/get@^3.0.0` dependency (and
    // its transitive `glob`/`rimraf`) off versions with a real npm-audit
    // finding (sprintf-js DoS via @electron/get@3 -> got@11 -> global-agent
    // -> roarr -> sprintf-js) or deprecation warnings (glob@7/rimraf@2/
    // inflight/boolean). Verified empirically (finding #4, 2026-10-10): a
    // real generated project installs clean and `npm run package` builds
    // with all three at their newest non-deprecated major.
    overrides: {
      '@electron/get': '^5.1.0',
      glob: '^13.0.6',
      rimraf: '^6.1.3',
    },
  });
}

function renderReadme(ctx: ResolvedContext): string {
  return lines(
    `# ${ctx.appName}`,
    '',
    ctx.description,
    '',
    '## Security posture',
    '',
    'Every window is created with `secureWebPreferences()` (`src/main/windowConfig.ts`):',
    'context isolation and the sandbox are on and Node integration is off, set',
    "explicitly rather than inherited from Electron's defaults. All in-app",
    'navigation is blocked and `window.open` is always denied (`src/main/index.ts`);',
    'external http(s) links, classified by the pure `isExternalHttpUrl()` predicate',
    'in `src/main/linkPolicy.ts`, open in the system browser instead. The renderer',
    `reaches the main process only through the named \`window.${ctx.bridgeGlobal}\` bridge`,
    'declared in `src/preload/api.ts`, which exposes no operations yet. Each new',
    'operation gets its own named channel and method there; the bridge never',
    'forwards raw Electron APIs.',
    '',
    '## Scripts',
    '',
    '- `npm run build`: compile TypeScript to `dist/`',
    '- `npm run typecheck`: type-check without emitting',
    '- `npm test`: run the unit tests',
    '- `npm run test:e2e`: launch the real built app with Playwright and run the',
    '  e2e smoke suite (run `npm run build` first)',
    '- `npm run package`: build a Windows installer with electron-builder',
    '',
    '## CI & releases',
    '',
    '`.github/workflows/ci.yml` runs on every pull request: typecheck, build,',
    'unit tests, then the e2e suite, on `windows-latest`. It runs `npm ci`,',
    'which requires a committed `package-lock.json` — this project has none',
    'until your first `npm install`, so commit it once you have run that',
    'locally; otherwise the first CI run fails loudly, by design.',
    '',
    '`.github/workflows/release.yml` runs the same checks on a `v*.*.*` tag,',
    'builds a Windows installer with electron-builder, and uploads it as a',
    'workflow artifact. It does **not** publish anywhere',
    '(`electron-builder.yml`\'s `publish: null`). To switch it to actually',
    'publishing a release, make these three edits:',
    '',
    '1. `electron-builder.yml`: change `publish: null` to a real target (e.g.',
    '   `github`).',
    '2. `release.yml`: change `--publish never` to `--publish always`.',
    '3. `release.yml`: change `permissions: contents: read` to',
    '   `contents: write`.',
    '',
    '`npm install` also needs real network access to **github.com releases**,',
    'not just the npm registry, to download the Electron and Chromium',
    'binaries (the `electron` devDependency\'s own postinstall). If that path',
    'is blocked while the registry itself is reachable, `npm install` can',
    'still "succeed" with the binary missing, and the first `npm run test:e2e`',
    'run will then attempt the download itself instead of failing cleanly at',
    'install time. Behind a corporate HTTP(S) proxy, set',
    '`ELECTRON_GET_USE_PROXY=true` (with `HTTPS_PROXY`/`HTTP_PROXY` already',
    'set) before `npm install` / `npm run package`, so the binary download',
    'picks up your proxy instead of failing outright.',
    '',
    'Relatedly, `esbuild`, `electron-builder` and `electron-winstaller` each',
    'run their own `postinstall` install script to fetch native binaries',
    '(esbuild\'s own binary; electron-builder/electron-winstaller\'s packaging',
    'helpers). That is expected behavior, not a sign of a compromised',
    'install, and nothing in this project needs `--ignore-scripts`.',
  );
}

const GITIGNORE = lines(
  'node_modules/',
  'dist/',
  'out/',
  '.vite/',
  '*.log',
  'release/',
  'test-results/',
  'playwright-report/'
);

function renderLicense(ctx: ResolvedContext): string {
  return lines(
    'MIT License',
    '',
    `Copyright (c) ${ctx.year} ${ctx.author}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  );
}

/**
 * Single shared tsconfig — emitted only when `ctx.includeSettings` is
 * false (no renderer `.ts` file exists in that case, so there is nothing
 * to decouple per-process). Byte-identical to the project's original
 * baseline (initial_scaffold.md "Revised plan for Open Decision 1").
 */
const TSCONFIG = json({
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
    noUncheckedIndexedAccess: true,
    types: ['node', 'electron'],
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
  },
  include: ['src/**/*.ts'],
});

/**
 * Per-process tsconfig split (Option B, approved 2026-10-10) — emitted
 * only when `ctx.includeSettings` is true, replacing the single
 * `tsconfig.json` above. `tsconfig.base.json` holds only the options
 * every process shares; `lib`/`types`/`outDir`/`rootDir`/`include` differ
 * per process and live in the two files below it, so Node/Electron
 * ambient types never leak into renderer scope and DOM lib never leaks
 * into main/preload scope.
 */
const TSCONFIG_BASE = json({
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noUncheckedIndexedAccess: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
  },
});

const TSCONFIG_MAIN = json({
  extends: './tsconfig.base.json',
  compilerOptions: {
    lib: ['ES2023'],
    types: ['node', 'electron'],
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
});

/**
 * Renderer output is loaded by `<script type="module">` in
 * `index.html` -- native browser ESM scope, not Node's module loader.
 * `tsconfig.base.json`'s `module: 'NodeNext'` ties *emitted* format to
 * the generated `package.json`'s `"type"` field (absent here, so
 * `NodeNext` would emit CommonJS -- `exports`/`require` -- which throws
 * `ReferenceError: exports is not defined` in that ES-module scope).
 * Override `module`/`moduleResolution` here, for the renderer config
 * only, so emission is real ESM (`export`/`import`) regardless of
 * `package.json`'s `type` field: `'ES2022'` emits genuine ES modules,
 * and `'bundler'` resolution matches (browser-target resolution that
 * doesn't key off `package.json` `type` the way `NodeNext` does).
 * `tsconfig.base.json`/`tsconfig.main.json` are untouched -- main and
 * preload keep `NodeNext`/CJS-compatible resolution, which preload
 * still needs for esbuild's CJS bundle under `sandbox: true`.
 */
const TSCONFIG_RENDERER = json({
  extends: './tsconfig.base.json',
  compilerOptions: {
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    types: [],
    module: 'ES2022',
    moduleResolution: 'bundler',
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src/renderer/**/*.ts'],
});

/**
 * `tsconfig.json` (or its per-process split) is also the build config, so
 * its `include`/`rootDir` can't widen to cover `tests/**` and
 * `vitest.config.ts` without tests landing in `dist/`. This sibling,
 * noEmit-only config is what `npm run typecheck` actually runs against, so
 * the generated project's own tests and vitest config are type-checked
 * too — always present, in both branches (initial_scaffold.md "Revised
 * plan for Open Decision 1").
 *
 * `includeSettings: false` extends the single shared `tsconfig.json`,
 * unchanged from the project's original baseline. `includeSettings: true`
 * does **not** extend either per-process config — merging two different
 * `include` roots through `extends` adds more indirection than it saves
 * for a dev-convenience file — and instead inlines the union of both
 * processes' options directly, since this file's job (a single, broader,
 * noEmit-only superset covering tests too) was never meant to mirror the
 * build path's own per-process strictness.
 */
const TSCONFIG_TYPECHECK = json({
  extends: './tsconfig.json',
  compilerOptions: { noEmit: true, rootDir: '.' },
  include: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
});

const TSCONFIG_TYPECHECK_SPLIT = json({
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    rootDir: '.',
    strict: true,
    noUncheckedIndexedAccess: true,
    types: ['node', 'electron'],
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    skipLibCheck: true,
  },
  include: [
    'src/main/**/*.ts',
    'src/preload/**/*.ts',
    'src/renderer/**/*.ts',
    'tests/**/*.ts',
    'vitest.config.ts',
  ],
});

function renderTsconfigTypecheck(ctx: ResolvedContext): string {
  return needsRendererSplit(ctx) ? TSCONFIG_TYPECHECK_SPLIT : TSCONFIG_TYPECHECK;
}

const VITEST_CONFIG = lines(
  "import { defineConfig } from 'vitest/config';",
  '',
  'export default defineConfig({',
  '  test: {',
  "    environment: 'node',",
  "    include: ['tests/**/*.test.ts'],",
  '    passWithNoTests: true,',
  '  },',
  '});',
);

/**
 * Tier-1 content unchanged. `staticWindowOptions()` is appended — never
 * replacing anything above it — only when `includeAboutHelp` is selected
 * (initial_scaffold.md Tier-2 spec, "Static-window shell"). About/Help have
 * no bridge, so there is no `preload` key at all to isolate.
 */
function renderWindowConfig(ctx: ResolvedContext): string {
  const parts = [
    "import type { BrowserWindowConstructorOptions } from 'electron';",
    '',
    '/**',
    ' * The non-negotiable security posture for every window.',
    ' * Every key here is explicit even where it matches an Electron default —',
    ' * an explicit value survives a future default change.',
    ' */',
    'export function secureWebPreferences(',
    '  preloadPath: string',
    "): BrowserWindowConstructorOptions['webPreferences'] {",
    '  return {',
    '    contextIsolation: true,',
    '    nodeIntegration: false,',
    '    sandbox: true,',
    '    preload: preloadPath,',
    '  };',
    '}',
  ];
  if (ctx.includeAboutHelp) {
    parts.push(
      '',
      '/**',
      ' * Options for a static, non-interactive window (About/Help): the same',
      ' * isolation posture as `secureWebPreferences()`, with no `preload` key —',
      ' * these windows have no bridge, so there is nothing to isolate a preload',
      ' * script for (the narrow-bridge invariant, satisfied by zero bridge).',
      ' */',
      'export function staticWindowOptions(): BrowserWindowConstructorOptions {',
      '  return {',
      '    width: 640,',
      '    height: 480,',
      '    resizable: false,',
      '    minimizable: false,',
      '    maximizable: false,',
      '    fullscreenable: false,',
      '    webPreferences: {',
      '      contextIsolation: true,',
      '      nodeIntegration: false,',
      '      sandbox: true,',
      '    },',
      '  };',
      '}'
    );
  }
  return lines(...parts);
}

const LINK_POLICY = lines(
  '/**',
  ' * True for any http(s) URL that isn\'t same-origin with `appOrigin`.',
  ' * Parses with URL; never compares raw strings (prefix checks are',
  ' * trivially bypassed, e.g. `https://app.example.evil.test`).',
  ' */',
  'export function isExternalHttpUrl(url: string, appOrigin: string): boolean {',
  '  let parsed: URL;',
  '  try {',
  '    parsed = new URL(url);',
  '  } catch {',
  '    return false; // unparsable is not "external http" — caller\'s default wins',
  '  }',
  "  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;",
  '  return parsed.origin !== appOrigin;',
  '}',
);

const needsTrustedSenderRegistry = (ctx: ResolvedContext): boolean => ctx.includeSettings || ctx.includeSkins;

/**
 * Tier-1 content unchanged. Appends a shared trusted-webContents registry —
 * never replacing anything above it — only when a Tier-2 feature actually
 * registers an IPC channel (Settings and/or Skins).
 */
function renderIpc(ctx: ResolvedContext): string {
  const parts = [
    "import { ipcMain, type IpcMainInvokeEvent } from 'electron';",
    '',
    '/**',
    ' * Registers an IPC handler that only runs for senders belonging to this',
    " * app's own window tree. Every future channel must be registered through",
    ' * this, never through `ipcMain.handle` directly — see electron/security.md.',
    ' */',
    'export function registerHandler(',
    '  channel: string,',
    '  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,',
    '  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown',
    '): void {',
    '  ipcMain.handle(channel, (event, ...args) => {',
    '    if (!isTrustedSender(event)) {',
    '      throw new Error(`Rejected IPC call on "${channel}" from an untrusted sender.`);',
    '    }',
    '    return handler(event, ...args);',
    '  });',
    '}',
  ];
  if (needsTrustedSenderRegistry(ctx)) {
    parts.push(
      '',
      '/**',
      ' * Tracks which webContents belong to this app\'s own window tree, so',
      ' * every registerHandler() call above can validate its sender.',
      ' */',
      'const trustedWebContentsIds = new Set<number>();',
      '',
      'export function trustWebContents(id: number): void {',
      '  trustedWebContentsIds.add(id);',
      '}',
      '',
      'export function untrustWebContents(id: number): void {',
      '  trustedWebContentsIds.delete(id);',
      '}',
      '',
      'export function isTrustedSender(event: IpcMainInvokeEvent): boolean {',
      '  return trustedWebContentsIds.has(event.sender.id);',
      '}'
    );
  }
  return lines(...parts);
}

/**
 * Composition root. Tier-1 content (window lifecycle + navigation policy)
 * is unchanged; Settings/Skins startup wiring and the unconditional
 * application menu (Decision 5 — menu.ts is Tier-1 baseline content now)
 * are appended conditionally, never altering what's already there.
 */
function renderMainIndex(ctx: ResolvedContext): string {
  const parts = [
  "import { join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  "import { app, BrowserWindow, Menu, shell } from 'electron';",
  "import { isExternalHttpUrl } from './linkPolicy.js';",
  "import { secureWebPreferences } from './windowConfig.js';",
  "import { buildMenuTemplate } from './menu.js';",
  ...(needsTrustedSenderRegistry(ctx) ? ["import { trustWebContents, untrustWebContents } from './ipc.js';"] : []),
  ...(ctx.includeAboutHelp
    ? [
        "import { closeAboutWindow } from './aboutWindow.js';",
        "import { closeHelpWindow } from './helpWindow.js';",
      ]
    : []),
  ...(ctx.includeSettings
    ? [
        "import {",
        '  SETTINGS_CHANNELS,',
        '  loadSettingsAtStartup,',
        '  onSettingsChange,',
        '  registerSettingsIpcHandlers,',
        '  rereadSettingsOnFocus,',
        "} from './settingsStore.js';",
      ]
    : []),
  ...(ctx.includeSkins
    ? [
        "import {",
        '  SKINS_CHANNELS,',
        '  loadSkinsAtStartup,',
        '  onSkinsChange,',
        '  registerSkinsIpcHandlers,',
        '  rereadSkinsOnFocus,',
        "} from './skinsStore.js';",
      ]
    : []),
  '',
  ...(ctx.includeSettings ? ['registerSettingsIpcHandlers();', ''] : []),
  ...(ctx.includeSkins ? ['registerSkinsIpcHandlers();', ''] : []),
  '// Composition root: app lifecycle + window creation only. Paths assume the',
  '// compiled layout dist/main, dist/preload and dist/renderer.',
  "const PRELOAD_PATH = join(__dirname, '..', 'preload', 'index.js');",
  "const RENDERER_URL = pathToFileURL(join(__dirname, '..', 'renderer', 'index.html'));",
  '',
  '/**',
  ' * Derived from how the renderer is loaded, not hardcoded: a file:// URL has',
  ' * the opaque origin "null", so every http(s) URL counts as external. If the',
  ' * renderer is ever served over http(s) instead, derive this from that URL.',
  ' */',
  'const APP_ORIGIN = RENDERER_URL.origin;',
  '',
  'function openExternally(url: string): void {',
  '  shell.openExternal(url).catch((error: unknown) => {',
  "    console.error('Failed to open external URL', url, error);",
  '  });',
  '}',
  '',
  "app.on('web-contents-created', (_event, contents) => {",
  '  // The shell has no in-app navigation: block every attempt, and hand',
  '  // external http(s) links to the OS browser.',
  "  contents.on('will-navigate', (event) => {",
  '    event.preventDefault();',
  '    if (isExternalHttpUrl(event.url, APP_ORIGIN)) {',
  '      openExternally(event.url);',
  '    }',
  '  });',
  '  contents.setWindowOpenHandler(({ url }) => {',
  '    if (isExternalHttpUrl(url, APP_ORIGIN)) {',
  '      openExternally(url);',
  '    }',
  "    return { action: 'deny' };",
  '  });',
  '});',
  '',
  'function createWindow(): void {',
  '  const window = new BrowserWindow({',
  '    width: 1024,',
  '    height: 768,',
  '    show: false,',
  '    webPreferences: secureWebPreferences(PRELOAD_PATH),',
  '  });',
  "  window.once('ready-to-show', () => window.show());",
  '  window.loadURL(RENDERER_URL.href).catch((error: unknown) => {',
  "    console.error('Failed to load renderer', error);",
  '  });',
  ...(needsTrustedSenderRegistry(ctx)
    ? [
        '',
        '  const windowId = window.webContents.id;',
        '  trustWebContents(windowId);',
      ]
    : []),
  ...(ctx.includeSettings
    ? [
        '',
        "  window.on('focus', () => {",
        '    rereadSettingsOnFocus().catch((error: unknown) => {',
        "      console.error('Failed to reread settings', error);",
        '    });',
        '  });',
        '  const unsubscribeSettingsChange = onSettingsChange((settings) => {',
        '    window.webContents.send(SETTINGS_CHANNELS.changed, settings);',
        '  });',
      ]
    : []),
  ...(ctx.includeSkins
    ? [
        '',
        "  window.on('focus', () => {",
        '    rereadSkinsOnFocus().catch((error: unknown) => {',
        "      console.error('Failed to reread skins', error);",
        '    });',
        '  });',
        '  const unsubscribeSkinsChange = onSkinsChange((skins) => {',
        '    window.webContents.send(SKINS_CHANNELS.changed, skins);',
        '  });',
      ]
    : []),
  ...(needsTrustedSenderRegistry(ctx) || ctx.includeSettings || ctx.includeSkins || ctx.includeAboutHelp
    ? [
        '',
        "  window.on('closed', () => {",
        ...(needsTrustedSenderRegistry(ctx) ? ['    untrustWebContents(windowId);'] : []),
        ...(ctx.includeSettings ? ['    unsubscribeSettingsChange();'] : []),
        ...(ctx.includeSkins ? ['    unsubscribeSkinsChange();'] : []),
        ...(ctx.includeAboutHelp ? ['    closeAboutWindow();', '    closeHelpWindow();'] : []),
        '  });',
      ]
    : []),
  '}',
  '',
  "app.on('window-all-closed', () => {",
  "  if (process.platform !== 'darwin') app.quit();",
  '});',
  '',
  'app',
  '  .whenReady()',
  '  .then(async () => {',
  '    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));',
  ...(ctx.includeSettings ? ['    await loadSettingsAtStartup();'] : []),
  ...(ctx.includeSkins ? ['    await loadSkinsAtStartup();'] : []),
  '    createWindow();',
  "    app.on('activate', () => {",
  '      if (BrowserWindow.getAllWindows().length === 0) createWindow();',
  '    });',
  '  })',
  '  .catch((error: unknown) => {',
  "    console.error('Failed to start', error);",
  '    app.quit();',
  '  });',
  ];
  return lines(...parts);
}

/**
 * Conditional-composition idiom (initial_scaffold.md Tier-2 spec): each
 * selected feature contributes its own channel entries and BridgeApi
 * members; nothing is ever stubbed out for a feature that wasn't chosen.
 * With all three flags false this renders byte-identical to today's
 * Tier-1 output.
 */
function renderPreloadApi(ctx: ResolvedContext): string {
  const typeImports: string[] = [];
  if (ctx.includeSettings) typeImports.push("import type { ViewSettings } from '../main/settings.js';");
  if (ctx.includeSkins) typeImports.push("import type { Skin } from '../main/skins.js';");

  const channelLines: string[] = [];
  if (ctx.includeSettings) {
    channelLines.push(
      `  settingsGet: '${ctx.ipcPrefix}:settings:get',`,
      `  settingsSet: '${ctx.ipcPrefix}:settings:set',`,
      `  settingsChanged: '${ctx.ipcPrefix}:settings:changed',`
    );
  }
  if (ctx.includeSkins) {
    channelLines.push(
      `  skinsList: '${ctx.ipcPrefix}:skins:list',`,
      `  skinsGetActive: '${ctx.ipcPrefix}:skins:getActive',`,
      `  skinsSetActive: '${ctx.ipcPrefix}:skins:setActive',`,
      `  skinsChanged: '${ctx.ipcPrefix}:skins:onChange',`
    );
  }

  const bridgeMembers: string[] = [];
  if (ctx.includeSettings) {
    bridgeMembers.push(
      '  settings: {',
      '    get(): Promise<ViewSettings>;',
      '    set(patch: Partial<ViewSettings>): Promise<ViewSettings>;',
      '    onChange(callback: (settings: ViewSettings) => void): () => void;',
      '  };'
    );
  }
  if (ctx.includeSkins) {
    bridgeMembers.push(
      '  skins: {',
      '    list(): Promise<Skin[]>;',
      '    getActive(): Promise<string | undefined>;',
      '    setActive(name: string): Promise<void>;',
      '    onChange(callback: (skins: Skin[]) => void): () => void;',
      '  };'
    );
  }

  const parts = [
    ...typeImports,
    ...(typeImports.length > 0 ? [''] : []),
    '/**',
    ' * The complete, enumerable surface between renderer and main process.',
    ' * There are zero channels today; the bridge still exists and stays narrow.',
    ' * To add an operation: one entry here named',
    ` * \`${ctx.ipcPrefix}:<operation>\`, one method on BridgeApi, and a main-process`,
    ' * handler registered through `registerHandler()` (`src/main/ipc.ts`),',
    ' * which validates the event sender before acting. Never expose ipcRenderer',
    ' * itself or a wildcard channel.',
    ' */',
  ];

  if (channelLines.length === 0) {
    parts.push('export const IPC_CHANNELS = {} as const satisfies Record<string, string>;');
  } else {
    parts.push('export const IPC_CHANNELS = {', ...channelLines, '} as const satisfies Record<string, string>;');
  }

  parts.push('');
  if (bridgeMembers.length === 0) {
    parts.push('// Zero methods today; extended per channel, never wildcarded.', 'export interface BridgeApi {}');
  } else {
    parts.push('export interface BridgeApi {', ...bridgeMembers, '}');
  }

  return lines(...parts);
}

function renderPreloadIndex(ctx: ResolvedContext): string {
  const needsIpcRenderer = ctx.includeSettings || ctx.includeSkins;

  const apiMembers: string[] = [];
  if (ctx.includeSettings) {
    apiMembers.push(
      '  settings: {',
      '    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet) as Promise<ViewSettings>,',
      '    set: (patch) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, patch) as Promise<ViewSettings>,',
      '    onChange: (callback) => {',
      '      const listener = (_event: IpcRendererEvent, settings: ViewSettings) => callback(settings);',
      '      ipcRenderer.on(IPC_CHANNELS.settingsChanged, listener);',
      '      return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, listener);',
      '    },',
      '  },'
    );
  }
  if (ctx.includeSkins) {
    apiMembers.push(
      '  skins: {',
      '    list: () => ipcRenderer.invoke(IPC_CHANNELS.skinsList) as Promise<Skin[]>,',
      '    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.skinsGetActive) as Promise<string | undefined>,',
      '    setActive: (name) => ipcRenderer.invoke(IPC_CHANNELS.skinsSetActive, name) as Promise<void>,',
      '    onChange: (callback) => {',
      '      const listener = (_event: IpcRendererEvent, skins: Skin[]) => callback(skins);',
      '      ipcRenderer.on(IPC_CHANNELS.skinsChanged, listener);',
      '      return () => ipcRenderer.removeListener(IPC_CHANNELS.skinsChanged, listener);',
      '    },',
      '  },'
    );
  }

  const parts = [
    needsIpcRenderer
      ? "import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';"
      : "import { contextBridge } from 'electron';",
    needsIpcRenderer
      ? "import { IPC_CHANNELS, type BridgeApi } from './api.js';"
      : "import type { BridgeApi } from './api.js';",
    ...(ctx.includeSettings ? ["import type { ViewSettings } from '../main/settings.js';"] : []),
    ...(ctx.includeSkins ? ["import type { Skin } from '../main/skins.js';"] : []),
    '',
  ];

  if (apiMembers.length === 0) {
    parts.push('const api: BridgeApi = {};');
  } else {
    parts.push('const api: BridgeApi = {', ...apiMembers, '};');
  }

  parts.push('', `contextBridge.exposeInMainWorld('${ctx.bridgeGlobal}', api);`);
  return lines(...parts);
}

const constant = (content: string) => (): string => content;

/**
 * Deliberately inert placeholder renderer (initial_scaffold.md — Cycle B1):
 * no inline `<script>` — pointless under `sandbox: true`/`contextIsolation`
 * with zero bridge operations to call (functional_domain.md §1 "Build/CI
 * shape" — the asset set must include *something* `main/index.ts` can load
 * as window content, not a real UI; Tier 3 replaces this entirely).
 *
 * No tool/plugin self-attribution here (functional_domain.md §3.4 "no
 * branding leakage" — enforced literally, no exception): content is a pure
 * function of this project's own resolved context only.
 */
function renderRendererIndexHtml(ctx: ResolvedContext): string {
  const appName = escapeHtml(ctx.appName);
  const description = escapeHtml(ctx.description);
  return lines(
    '<!doctype html>',
    '<html>',
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <title>${appName}</title>`,
    '    <link rel="stylesheet" href="./app.css" />',
    '  </head>',
    '  <body>',
    '    <main>',
    `      <h1>${appName}</h1>`,
    `      <p>${description}</p>`,
    '    </main>',
    ...(ctx.includeSettings ? ['    <script type="module" src="./theme.js"></script>'] : []),
    ...(ctx.includeSkins ? ['    <script type="module" src="./skins.js"></script>'] : []),
    '  </body>',
    '</html>',
  );
}

/**
 * Dark Mode wired to a real renderer consumer (functional_domain_tier2.md
 * correction "Dark Mode wired end-to-end in the renderer", testing finding
 * #9). Generated only when `ctx.includeSettings` is true — no new IPC
 * channel, no new main/preload surface: `settings.get()` and
 * `settings.onChange()` already exist on `BridgeApi`. Appearance state is
 * pure CSS class state on the document root (§3.1), never inline-style
 * mutation, and the script never reaches for `ipcRenderer` or `require`
 * directly — it only ever calls through the narrow, already-validated
 * bridge (§3.4).
 */
function renderRendererThemeTs(ctx: ResolvedContext): string {
  return lines(
    "import type { BridgeApi } from '../preload/api.js';",
    '',
    'declare global {',
    '  interface Window {',
    `    ${ctx.bridgeGlobal}: BridgeApi;`,
    '  }',
    '}',
    '',
    `const bridge = window.${ctx.bridgeGlobal};`,
    '',
    'function applyTheme(darkMode: boolean): void {',
    "  document.documentElement.classList.toggle('theme-dark', darkMode);",
    '}',
    '',
    'void bridge.settings.get().then((settings) => applyTheme(settings.darkMode));',
    'bridge.settings.onChange((settings) => applyTheme(settings.darkMode));',
  );
}

/**
 * Skins wired to a real renderer consumer (spec: skins-renderer-consumer.md,
 * 2026-10-17 — Decision 4 shipped the mechanism with zero presets; nothing
 * in the renderer ever applied one). Generated only when `ctx.includeSkins`
 * is true. Structurally the direct analog of `renderRendererThemeTs`: no new
 * IPC surface — `skins.list()`/`skins.getActive()`/`skins.onChange()`
 * already exist on `BridgeApi` — and the script never reaches for
 * `ipcRenderer` or `require` directly, only the narrow bridge (§3.4). The
 * active skin's `css` is applied as `textContent` on a dedicated
 * `<style id="skin">` element (created lazily if absent), never a `<link>`
 * href swap, because `Skin.css` is an inline CSS string, not a file path.
 * `onChange()`'s callback payload is the skin list only, never the active
 * name, so `applyActiveSkin()` re-fetches `getActive()` on every
 * notification rather than trusting the callback argument — this is also
 * what makes the `setActiveSkinName()` listener-notification fix (same
 * spec) visibly matter: without it, picking a skin from the menu would
 * never trigger this re-apply. A missing/removed active skin
 * (`getActive()` resolving to `undefined`) is a safe no-op: the `<style>`
 * tag is cleared, not left stale.
 */
function renderRendererSkinsTs(ctx: ResolvedContext): string {
  return lines(
    "import type { BridgeApi } from '../preload/api.js';",
    '',
    'declare global {',
    '  interface Window {',
    `    ${ctx.bridgeGlobal}: BridgeApi;`,
    '  }',
    '}',
    '',
    `const bridge = window.${ctx.bridgeGlobal};`,
    '',
    'function styleTag(): HTMLStyleElement {',
    "  let tag = document.getElementById('skin') as HTMLStyleElement | null;",
    '  if (!tag) {',
    "    tag = document.createElement('style');",
    "    tag.id = 'skin';",
    '    document.head.appendChild(tag);',
    '  }',
    '  return tag;',
    '}',
    '',
    'async function applyActiveSkin(): Promise<void> {',
    '  const [skins, activeName] = await Promise.all([bridge.skins.list(), bridge.skins.getActive()]);',
    '  const active = skins.find((skin) => skin.name === activeName);',
    "  styleTag().textContent = active?.css ?? '';",
    '}',
    '',
    'void applyActiveSkin();',
    'bridge.skins.onChange(() => void applyActiveSkin());',
  );
}

/**
 * Conditional-composition idiom (same as elsewhere in this file): the
 * dark-mode rule is appended, never replacing the base rule, only when
 * `ctx.includeSettings` is true. Byte-identical to the original
 * `RENDERER_CSS` constant when the flag is false (functional_domain_tier2.md
 * correction §3.3). No curated palette beyond a minimal background/
 * foreground swap (§3.2) — cosmetic placeholder content only.
 */
function renderRendererCss(ctx: ResolvedContext): string {
  const base = lines(
    'html, body {',
    '  height: 100%;',
    '  margin: 0;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  font-family: system-ui, sans-serif;',
    '  text-align: center;',
    '}',
  );
  if (!ctx.includeSettings) return base;
  return base + lines(
    '',
    'html.theme-dark, body.theme-dark {',
    '  background: #1e1e1e;',
    '  color: #f0f0f0;',
    '}',
  );
}

/**
 * The explicit asset manifest the handoff asked for (§5.1) — generated
 * *output* a scaffolded project runs, not stackfold's own build (SOLID
 * Boundary Scan, Cycle B1 spec). `format: 'cjs'` is required, not a style
 * choice: `sandbox: true` loads the preload as CommonJS, never ESM.
 *
 * Constant -> function of `ctx` (Option B, per-process tsconfig split):
 * with `includeSettings: false` this renders byte-identical to the
 * original single-`tsc` baseline; with it true, `tsc -p tsconfig.json`
 * is replaced by two independent passes (main+preload, then renderer —
 * either order is fine, neither depends on the other's output). The
 * esbuild preload-bundling step and the static-asset `ASSETS` copy list
 * are unchanged either way.
 */
function renderBuildScript(ctx: ResolvedContext): string {
  const tscCalls = needsRendererSplit(ctx)
    ? [
        "execSync('tsc -p tsconfig.main.json', { stdio: 'inherit' });",
        '',
        "execSync('tsc -p tsconfig.renderer.json', { stdio: 'inherit' });",
      ]
    : ["execSync('tsc -p tsconfig.json', { stdio: 'inherit' });"];

  return lines(
    '#!/usr/bin/env node',
    "import { execSync } from 'node:child_process';",
    "import { cpSync, mkdirSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "import { build as esbuildBuild } from 'esbuild';",
    '',
    ...tscCalls,
    '',
    'await esbuildBuild({',
    "  entryPoints: ['src/preload/index.ts'],",
    "  outfile: 'dist/preload/index.js',",
    '  bundle: true,',
    "  platform: 'node',",
    "  format: 'cjs', // required: sandbox: true loads the preload as CJS",
    "  external: ['electron'],",
    '});',
    '',
    '// Explicit asset manifest (handoff debt item #1) — add an entry here,',
    '// never a bare `cp -r` in package.json, when renderer assets grow.',
    'const ASSETS = [',
    "  ['src/renderer/index.html', 'dist/renderer/index.html'],",
    "  ['src/renderer/app.css', 'dist/renderer/app.css'],",
    '];',
    'for (const [from, to] of ASSETS) {',
    '  mkdirSync(dirname(to), { recursive: true });',
    '  cpSync(from, to);',
    '}',
  );
}

/**
 * `publish: null`, not `github`, deliberately (Cycle B1 spec): a freshly
 * scaffolded project has no repo/releases to publish to yet. appId and
 * productName are JSON-quoted so free-text answers can never break the
 * YAML document's structure.
 */
function renderElectronBuilderYml(ctx: ResolvedContext): string {
  return lines(
    `appId: ${JSON.stringify(ctx.appId)}`,
    `productName: ${JSON.stringify(ctx.appName)}`,
    'directories:',
    '  output: release',
    'files:',
    '  - dist/**',
    ...(ctx.includeAboutHelp ? ['  - third-party-notices.json', '  - help.md'] : []),
    'win:',
    '  target:',
    '    - nsis',
    '    - portable',
    'publish: null',
  );
}

// ---------------------------------------------------------------------------
// Tier-2 optional features (Settings / Skins / About+Help) — each feature's
// render functions are grouped together (SRP, initial_scaffold.md Tier-2
// spec's "SOLID Boundary Scan").
// ---------------------------------------------------------------------------

const needsAtomicWriteFile = (ctx: ResolvedContext): boolean => ctx.includeSettings || ctx.includeSkins;

/**
 * Shared by Settings and Skins: writes to a sibling temp file then renames
 * over the target. `fs.rename` is atomic on the same filesystem, which a
 * local app-data file always is. Never duplicated between the two stores.
 */
const ATOMIC_WRITE_FILE = lines(
  "import { randomBytes } from 'node:crypto';",
  "import { rename, writeFile } from 'node:fs/promises';",
  "import { dirname, join } from 'node:path';",
  '',
  '/**',
  ' * Atomically replaces `targetPath`\'s content: writes to a sibling temp',
  ' * file, then renames it over the target.',
  ' */',
  'export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {',
  '  const tempPath = join(dirname(targetPath), `.${randomBytes(6).toString(\'hex\')}.tmp`);',
  "  await writeFile(tempPath, content, 'utf8');",
  '  await rename(tempPath, targetPath);',
  '}'
);

/**
 * Shared by About and Help (`ctx.includeAboutHelp`): the generated app's own
 * **runtime** HTML escaper and static-window CSP builder — distinct from,
 * and never sharing code with, this plugin's own generation-time
 * `escapeHtml()` above (one runs when `stackfold init` renders a template
 * string; the other runs inside the scaffolded app whenever it builds
 * About/Help HTML from live data — a deliberate generation/runtime split).
 */
const STATIC_WINDOW_SHELL = lines(
  "import { createHash } from 'node:crypto';",
  '',
  '/** Escapes free text for safe placement inside an HTML text node. */',
  'export function escapeHtml(value: string): string {',
  '  return value',
  "    .replace(/&/g, '&amp;')",
  "    .replace(/</g, '&lt;')",
  "    .replace(/>/g, '&gt;')",
  '    .replace(/"/g, \'&quot;\')',
  '    .replace(/\\\'/g, \'&#39;\');',
  '}',
  '',
  '/**',
  ' * Builds the <meta http-equiv="Content-Security-Policy"> tag for a',
  ' * static, non-interactive window (About/Help) — delivered via a <meta>',
  ' * tag, never an HTTP header, since there is no HTTP response for a',
  " * `data:` URL to attach one to (electron/security.md's \"Static-window",
  ' * CSP\" section). The style-src hash is derived from the exact inline',
  ' * <style> CSS passed in, so the policy can never drift from the content',
  ' * it actually guards.',
  ' */',
  'export function buildStaticWindowCsp(inlineStyleCss: string): string {',
  "  const hash = createHash('sha256').update(inlineStyleCss, 'utf8').digest('base64');",
  '  const policy = [',
  '    "default-src \'none\'",',
  '    `style-src \'sha256-${hash}\'`,',
  '    "script-src \'none\'",',
  '    "base-uri \'none\'",',
  '    "form-action \'none\'",',
  "  ].join('; ');",
  '  return `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;',
  '}'
);

/** Settings feature (`ctx.includeSettings`) — Dark Mode (Decision 1: folded into Settings, no separate theme question). */
const SETTINGS_TS = lines(
  "import { z } from 'zod';",
  '',
  'export const ViewSettingsSchema = z',
  '  .object({',
  '    darkMode: z.boolean(),',
  '  })',
  '  .strict();',
  '',
  'export type ViewSettings = z.infer<typeof ViewSettingsSchema>;',
  '',
  'export const DEFAULT_VIEW_SETTINGS: ViewSettings = {',
  '  darkMode: false,',
  '};'
);

/**
 * Self-healing load/reread/write, per functional_domain_tier2.md §1/§3.5:
 * missing file -> in-memory defaults, nothing written; corrupt file ->
 * self-heal, no backup (settings has no user-authored content to protect);
 * a failed reread never touches `current`.
 */
function renderSettingsStore(ctx: ResolvedContext): string {
  return lines(
    "import { join } from 'node:path';",
    "import { readFile } from 'node:fs/promises';",
    "import { app } from 'electron';",
    "import { atomicWriteFile } from './atomicWriteFile.js';",
    "import { registerHandler, isTrustedSender } from './ipc.js';",
    "import { ViewSettingsSchema, DEFAULT_VIEW_SETTINGS, type ViewSettings } from './settings.js';",
    '',
    `export const SETTINGS_CHANNELS = {`,
    `  get: '${ctx.ipcPrefix}:settings:get',`,
    `  set: '${ctx.ipcPrefix}:settings:set',`,
    `  changed: '${ctx.ipcPrefix}:settings:changed',`,
    '} as const;',
    '',
    "const SETTINGS_PATH = (): string => join(app.getPath('userData'), 'settings.json');",
    '',
    'let current: ViewSettings = DEFAULT_VIEW_SETTINGS;',
    'const listeners = new Set<(settings: ViewSettings) => void>();',
    '',
    'async function readAndValidate(): Promise<ViewSettings | undefined> {',
    '  let raw: string;',
    '  try {',
    "    raw = await readFile(SETTINGS_PATH(), 'utf8');",
    '  } catch {',
    '    return undefined; // missing file -> caller keeps in-memory defaults, writes nothing',
    '  }',
    '  let json: unknown;',
    '  try {',
    '    json = JSON.parse(raw);',
    '  } catch {',
    '    return undefined; // corrupt (invalid JSON) -> self-heal, no backup',
    '  }',
    '  const parsed = ViewSettingsSchema.safeParse(json);',
    '  return parsed.success ? parsed.data : undefined; // corrupt (wrong shape) -> self-heal, no backup',
    '}',
    '',
    'export async function loadSettingsAtStartup(): Promise<void> {',
    '  current = (await readAndValidate()) ?? DEFAULT_VIEW_SETTINGS;',
    '}',
    '',
    '/** Re-reads on window focus; a failed read never touches `current`. */',
    'export async function rereadSettingsOnFocus(): Promise<void> {',
    '  const next = await readAndValidate();',
    '  if (next !== undefined) {',
    '    current = next;',
    '    listeners.forEach((listener) => listener(current));',
    '  }',
    '}',
    '',
    'export function getSettings(): ViewSettings {',
    '  return current;',
    '}',
    '',
    'export async function setSettings(patch: Partial<ViewSettings>): Promise<ViewSettings> {',
    '  current = ViewSettingsSchema.parse({ ...current, ...patch });',
    "  await atomicWriteFile(SETTINGS_PATH(), `${JSON.stringify(current, null, 2)}\\n`);",
    '  listeners.forEach((listener) => listener(current));',
    '  return current;',
    '}',
    '',
    'export function onSettingsChange(listener: (settings: ViewSettings) => void): () => void {',
    '  listeners.add(listener);',
    '  return () => listeners.delete(listener);',
    '}',
    '',
    'export function registerSettingsIpcHandlers(): void {',
    '  registerHandler(SETTINGS_CHANNELS.get, isTrustedSender, () => getSettings());',
    '  registerHandler(SETTINGS_CHANNELS.set, isTrustedSender, (_event, patch) =>',
    '    setSettings(patch as Partial<ViewSettings>)',
    '  );',
    '}'
  );
}

/** Skins feature (`ctx.includeSkins`) — ships the mechanism with zero presets (Decision 4). */
const SKINS_TS = lines(
  "import { z } from 'zod';",
  '',
  'export const SkinSchema = z',
  '  .object({',
  '    name: z.string().min(1),',
  '    css: z.string(),',
  '  })',
  '  .strict();',
  '',
  'export const SkinsFileSchema = z',
  '  .object({',
  '    skins: z.array(SkinSchema),',
  '  })',
  '  .strict();',
  '',
  'export type Skin = z.infer<typeof SkinSchema>;',
  'export type SkinsFile = z.infer<typeof SkinsFileSchema>;',
  '',
  '// Zero presets — a freshly scaffolded app has no visual identity of its own yet.',
  'export const DEFAULT_SKINS_FILE: SkinsFile = { skins: [] };'
);

/**
 * Structurally identical to settingsStore.ts, with the one documented
 * asymmetry: a corrupt skins.json is copied to `skins.json.bak` before
 * self-healing (`fs.copyFile`, not `atomicWriteFile` — a preservation copy
 * of existing content, not a new write), because unlike Settings, Skins
 * holds user-authored content that must never be destroyed silently.
 * Active-skin selection is in-memory-only (not part of the persisted
 * schema): it resets on each launch, same "mechanism without curated
 * content" spirit as the zero-preset list itself.
 */
function renderSkinsStore(ctx: ResolvedContext): string {
  return lines(
    "import { join } from 'node:path';",
    "import { copyFile, readFile } from 'node:fs/promises';",
    "import { app } from 'electron';",
    "import { atomicWriteFile } from './atomicWriteFile.js';",
    "import { registerHandler, isTrustedSender } from './ipc.js';",
    "import { SkinsFileSchema, DEFAULT_SKINS_FILE, type Skin, type SkinsFile } from './skins.js';",
    '',
    `export const SKINS_CHANNELS = {`,
    `  list: '${ctx.ipcPrefix}:skins:list',`,
    `  getActive: '${ctx.ipcPrefix}:skins:getActive',`,
    `  setActive: '${ctx.ipcPrefix}:skins:setActive',`,
    `  changed: '${ctx.ipcPrefix}:skins:onChange',`,
    '} as const;',
    '',
    "export const SKINS_PATH = (): string => join(app.getPath('userData'), 'skins.json');",
    '',
    'let current: SkinsFile = DEFAULT_SKINS_FILE;',
    '// Intentionally in-memory-only (not part of SkinsFileSchema/skins.json):',
    '// the active skin selection resets to none on every relaunch.',
    'let activeSkinName: string | undefined;',
    'const listeners = new Set<(skins: Skin[]) => void>();',
    '',
    'async function readAndValidate(): Promise<SkinsFile | undefined> {',
    '  let raw: string;',
    '  try {',
    "    raw = await readFile(SKINS_PATH(), 'utf8');",
    '  } catch {',
    '    return undefined; // missing file -> caller keeps in-memory defaults, writes nothing',
    '  }',
    '  let json: unknown;',
    '  try {',
    '    json = JSON.parse(raw);',
    '  } catch {',
    '    // corrupt (invalid JSON) -> back up the user-authored content before self-healing',
    '    await copyFile(SKINS_PATH(), `${SKINS_PATH()}.bak`);',
    '    return undefined;',
    '  }',
    '  const parsed = SkinsFileSchema.safeParse(json);',
    '  if (parsed.success) return parsed.data;',
    '  // corrupt (wrong shape) -> back up the user-authored content before self-healing',
    '  await copyFile(SKINS_PATH(), `${SKINS_PATH()}.bak`);',
    '  return undefined;',
    '}',
    '',
    'export async function loadSkinsAtStartup(): Promise<void> {',
    '  current = (await readAndValidate()) ?? DEFAULT_SKINS_FILE;',
    '}',
    '',
    '/** Re-reads on window focus; a failed read never touches `current`. */',
    'export async function rereadSkinsOnFocus(): Promise<void> {',
    '  const next = await readAndValidate();',
    '  if (next !== undefined) {',
    '    current = next;',
    '    listeners.forEach((listener) => listener(current.skins));',
    '  }',
    '}',
    '',
    'export function getSkins(): SkinsFile {',
    '  return current;',
    '}',
    '',
    'export async function setSkins(skins: Skin[]): Promise<SkinsFile> {',
    '  current = SkinsFileSchema.parse({ skins });',
    "  await atomicWriteFile(SKINS_PATH(), `${JSON.stringify(current, null, 2)}\\n`);",
    '  listeners.forEach((listener) => listener(current.skins));',
    '  return current;',
    '}',
    '',
    'export function getActiveSkinName(): string | undefined {',
    '  return activeSkinName;',
    '}',
    '',
    'export function setActiveSkinName(name: string): void {',
    '  if (!current.skins.some((skin) => skin.name === name)) {',
    '    throw new Error(`Unknown skin "${name}"`);',
    '  }',
    '  activeSkinName = name;',
    '  listeners.forEach((listener) => listener(current.skins));',
    '}',
    '',
    'export function onSkinsChange(listener: (skins: Skin[]) => void): () => void {',
    '  listeners.add(listener);',
    '  return () => listeners.delete(listener);',
    '}',
    '',
    'export function registerSkinsIpcHandlers(): void {',
    '  registerHandler(SKINS_CHANNELS.list, isTrustedSender, () => getSkins().skins);',
    '  registerHandler(SKINS_CHANNELS.getActive, isTrustedSender, () => getActiveSkinName());',
    '  registerHandler(SKINS_CHANNELS.setActive, isTrustedSender, (_event, name) => {',
    '    if (typeof name !== \'string\') {',
    "      throw new Error('skins:setActive requires a string skin name');",
    '    }',
    '    setActiveSkinName(name);',
    '  });',
    '}'
  );
}

/** About + Help (`ctx.includeAboutHelp`) — ships an empty mechanism, nothing fabricated (Decision 3). */
const THIRD_PARTY_NOTICES_JSON = json([]);

const HELP_MD = lines('# Help', '', "Add your app's help content here.");

/**
 * Reads the running app's own package.json (already in-process) plus
 * third-party-notices.json, renders HTML through the static-window shell.
 * No preload, no IPC — a one-shot render of data already available in the
 * main process. The "Author" row is simply absent when the generated
 * app's own package.json has no `author` field, which already happens
 * automatically when `ctx.author === ''` (package.json's own `hasAuthor`
 * gate) — no second gate is needed here.
 */
const ABOUT_WINDOW = lines(
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { app, BrowserWindow } from 'electron';",
  "import { staticWindowOptions } from './windowConfig.js';",
  "import { buildStaticWindowCsp, escapeHtml } from './staticWindowShell.js';",
  '',
  'interface PackageMetadata {',
  '  productName?: string;',
  '  name?: string;',
  '  version?: string;',
  '  description?: string;',
  '  author?: string;',
  '}',
  '',
  'interface ThirdPartyNotice {',
  '  name: string;',
  '  version: string;',
  '  license: string;',
  '}',
  '',
  'const STYLE_CSS = [',
  "  'body { font-family: system-ui, sans-serif; margin: 2rem; }',",
  "  'h1 { font-size: 1.25rem; }',",
  "  'dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }',",
  "].join('\\n');",
  '',
  'function readOwnPackageJson(): PackageMetadata {',
  "  const raw = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8');",
  '  return JSON.parse(raw) as PackageMetadata;',
  '}',
  '',
  'function readThirdPartyNotices(): ThirdPartyNotice[] {',
  '  try {',
  "    const raw = readFileSync(join(app.getAppPath(), 'third-party-notices.json'), 'utf8');",
  '    const parsed: unknown = JSON.parse(raw);',
  '    return Array.isArray(parsed) ? (parsed as ThirdPartyNotice[]) : [];',
  '  } catch {',
  '    return [];',
  '  }',
  '}',
  '',
  'function renderNoticesHtml(notices: ThirdPartyNotice[]): string {',
  '  if (notices.length === 0) {',
  "    return '<p>No third-party dependencies are listed yet.</p>';",
  '  }',
  '  const items = notices',
  '    .map((n) => `<li>${escapeHtml(n.name)} ${escapeHtml(n.version)} — ${escapeHtml(n.license)}</li>`)',
  "    .join('\\n');",
  '  return `<ul>${items}</ul>`;',
  '}',
  '',
  'function buildAboutHtml(): string {',
  '  const pkg = readOwnPackageJson();',
  '  const notices = readThirdPartyNotices();',
  "  const appName = escapeHtml(pkg.productName ?? pkg.name ?? 'This app');",
  "  const version = escapeHtml(pkg.version ?? '0.0.0');",
  "  const description = escapeHtml(pkg.description ?? '');",
  "  const authorRow = pkg.author ? `<dt>Author</dt><dd>${escapeHtml(pkg.author)}</dd>` : '';",
  '  return [',
  "    '<!doctype html>',",
  "    '<html>',",
  "    '<head>',",
  '    \'<meta charset="utf-8" />\',',
  '    buildStaticWindowCsp(STYLE_CSS),',
  '    `<title>About ${appName}</title>`,',
  '    `<style>${STYLE_CSS}</style>`,',
  "    '</head>',",
  "    '<body>',",
  '    `<h1>${appName}</h1>`,',
  '    `<p>${description}</p>`,',
  "    '<dl>',",
  '    `<dt>Version</dt><dd>${version}</dd>`,',
  '    authorRow,',
  "    '</dl>',",
  "    '<h2>Third-party software</h2>',",
  '    renderNoticesHtml(notices),',
  "    '</body>',",
  "    '</html>',",
  "  ].join('\\n');",
  '}',
  '',
  'let aboutWindow: BrowserWindow | undefined;',
  '',
  'export function openAboutWindow(): void {',
  '  if (aboutWindow) {',
  '    aboutWindow.focus();',
  '    return;',
  '  }',
  '  const window = new BrowserWindow(staticWindowOptions());',
  '  window.setMenu(null);',
  '  aboutWindow = window;',
  "  window.on('closed', () => {",
  '    aboutWindow = undefined;',
  '  });',
  '  window.loadURL(`data:text/html,${encodeURIComponent(buildAboutHtml())}`).catch((error: unknown) => {',
  "    console.error('Failed to load About window', error);",
  '  });',
  '}',
  '',
  'export function closeAboutWindow(): void {',
  '  aboutWindow?.close();',
  '}'
);

/**
 * Reads the bundled help.md as plain text, rendered inside an escaped
 * <pre> block — no Markdown-to-HTML dependency (explicitly out of scope
 * for one placeholder file).
 */
const HELP_WINDOW = lines(
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { app, BrowserWindow } from 'electron';",
  "import { staticWindowOptions } from './windowConfig.js';",
  "import { buildStaticWindowCsp, escapeHtml } from './staticWindowShell.js';",
  '',
  'const STYLE_CSS = [',
  "  'body { font-family: system-ui, sans-serif; margin: 2rem; }',",
  "  'pre { white-space: pre-wrap; font-family: inherit; }',",
  "].join('\\n');",
  '',
  'function readHelpText(): string {',
  '  try {',
  "    return readFileSync(join(app.getAppPath(), 'help.md'), 'utf8');",
  '  } catch {',
  "    return '';",
  '  }',
  '}',
  '',
  'function buildHelpHtml(): string {',
  '  const text = escapeHtml(readHelpText());',
  '  return [',
  "    '<!doctype html>',",
  "    '<html>',",
  "    '<head>',",
  '    \'<meta charset="utf-8" />\',',
  '    buildStaticWindowCsp(STYLE_CSS),',
  "    '<title>Help</title>',",
  '    `<style>${STYLE_CSS}</style>`,',
  "    '</head>',",
  "    '<body>',",
  '    `<pre>${text}</pre>`,',
  "    '</body>',",
  "    '</html>',",
  "  ].join('\\n');",
  '}',
  '',
  'let helpWindow: BrowserWindow | undefined;',
  '',
  'export function openHelpWindow(): void {',
  '  if (helpWindow) {',
  '    helpWindow.focus();',
  '    return;',
  '  }',
  '  const window = new BrowserWindow(staticWindowOptions());',
  '  window.setMenu(null);',
  '  helpWindow = window;',
  "  window.on('closed', () => {",
  '    helpWindow = undefined;',
  '  });',
  '  window.loadURL(`data:text/html,${encodeURIComponent(buildHelpHtml())}`).catch((error: unknown) => {',
  "    console.error('Failed to load Help window', error);",
  '  });',
  '}',
  '',
  'export function closeHelpWindow(): void {',
  '  helpWindow?.close();',
  '}'
);

/**
 * Menu composition (new Tier-1 baseline content, Decision 5): File always
 * present with exactly Exit; View present iff Settings and/or Skins is
 * selected; Help present iff About+Help is selected. Ordinary conditional
 * array-building (rejected a generic per-feature contribution-registry for
 * exactly three known features — regla de tres, same judgment as Cycle A's
 * Strategy-registry choice).
 */
function renderMenuTs(ctx: ResolvedContext): string {
  const imports = [
    "import { Menu, shell, type MenuItemConstructorOptions } from 'electron';",
  ];
  if (ctx.includeSettings) imports.push("import { getSettings, setSettings } from './settingsStore.js';");
  if (ctx.includeSkins) {
    imports.push("import { getActiveSkinName, getSkins, setActiveSkinName, SKINS_PATH } from './skinsStore.js';");
  }
  if (ctx.includeAboutHelp) {
    imports.push("import { openAboutWindow } from './aboutWindow.js';", "import { openHelpWindow } from './helpWindow.js';");
  }

  const body: string[] = [];
  if (ctx.includeSkins) {
    body.push(
      '// Active skin selection is in-memory-only and resets on relaunch (see skinsStore.ts).',
      'function buildSkinSubmenu(): MenuItemConstructorOptions[] {',
      '  const activeSkinName = getActiveSkinName();',
      '  return getSkins().skins.map((skin) => ({',
      '    label: skin.name,',
      "    type: 'checkbox' as const,",
      '    checked: skin.name === activeSkinName,',
      '    click: () => setActiveSkinName(skin.name),',
      '  }));',
      '}',
      ''
    );
  }

  body.push(
    'export function buildMenuTemplate(): MenuItemConstructorOptions[] {',
    "  const fileItems: MenuItemConstructorOptions[] = [{ label: 'Exit', role: 'quit' }];",
    ''
  );

  if (ctx.includeSettings || ctx.includeSkins) {
    body.push('  const viewItems: MenuItemConstructorOptions[] = [];');
    if (ctx.includeSettings) {
      body.push(
        '  viewItems.push(',
        '    {',
        "      label: 'Dark Mode',",
        "      type: 'checkbox',",
        '      checked: getSettings().darkMode,',
        '      click: () => {',
        '        void setSettings({ darkMode: !getSettings().darkMode });',
        '      },',
        '    }',
        '  );'
      );
    }
    if (ctx.includeSkins) {
      body.push(
        '  viewItems.push(',
        "    { label: 'Skin', submenu: buildSkinSubmenu() },",
        '    {',
        "      label: 'Edit Skins…',",
        '      click: () => {',
        '        void shell.openPath(SKINS_PATH());',
        '      },',
        '    }',
        '  );'
      );
    }
    body.push('');
  }

  if (ctx.includeAboutHelp) {
    body.push(
      '  const helpItems: MenuItemConstructorOptions[] = [',
      "    { label: 'Help', click: () => openHelpWindow() },",
      "    { label: 'About', click: () => openAboutWindow() },",
      '  ];',
      ''
    );
  }

  body.push("  const template: MenuItemConstructorOptions[] = [{ label: 'File', submenu: fileItems }];");
  if (ctx.includeSettings || ctx.includeSkins) {
    body.push(
      '  if (viewItems.length > 0) {',
      "    template.push({ label: 'View', submenu: viewItems });",
      '  }'
    );
  }
  if (ctx.includeAboutHelp) {
    body.push(
      '  if (helpItems.length > 0) {',
      "    template.push({ label: 'Help', submenu: helpItems });",
      '  }'
    );
  }
  body.push('  return template;', '}');

  return lines(...imports, '', ...body);
}

// ---------------------------------------------------------------------------
// Cycle B2: e2e harness (Playwright) + generated CI workflows
// (initial_scaffold.md — "electron-ts e2e harness + CI (Cycle B2)").
// Every entry below is unconditional Tier-1 baseline content, present in
// every generated project regardless of any Tier-2 flag (functional_domain.md
// §3.8 — "a generated app must actually start" — this is what proves it).
// ---------------------------------------------------------------------------

const PLAYWRIGHT_CONFIG = lines(
  "import { defineConfig } from '@playwright/test';",
  '',
  'export default defineConfig({',
  "  testDir: './tests/e2e',",
  "  testMatch: '**/*.spec.ts',",
  '  // Capped at 2: running more concurrent Electron processes caused',
  '  // intermittent hard worker-process crashes on Windows (fastfail, exit code',
  '  // 3221226505) under the CPU-count default. Measured mitigation; root cause',
  '  // not isolated. Revisit if it ever gets its own investigation.',
  '  workers: 2,',
  '});'
);

/**
 * E2E harness shape (functional_domain.md "E2E harness shape"): launch the
 * real built app, give every run its own disposable data directory, strip
 * the one env var that would make Electron run as plain Node, and wait for
 * a real load-state signal rather than a fixed sleep (L2 — no further
 * rendererReady/failureCapture helpers at this cycle).
 */
const E2E_FIXTURES = lines(
  "import { existsSync, mkdtempSync, rmSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';",
  '',
  "// The generated package.json has no \"type\": \"module\", so this file runs as",
  '// CommonJS under Playwright\'s TS transform and __dirname is available.',
  "const REPO_ROOT = join(__dirname, '../../..');",
  '',
  'function requireBuiltMain(): void {',
  "  if (!existsSync(join(REPO_ROOT, 'dist/main/index.js'))) {",
  "    throw new Error('dist/main/index.js is missing — run `npm run build` first.');",
  '  }',
  '}',
  '',
  '/**',
  ' * electron.launch()\'s env option requires string values only (no',
  ' * `undefined`), unlike `process.env` itself. ELECTRON_RUN_AS_NODE is',
  ' * stripped so the launched app runs as a real Electron app, not plain Node.',
  ' */',
  'function launchEnv(): Record<string, string> {',
  '  const env: Record<string, string> = {};',
  '  for (const [key, value] of Object.entries(process.env)) {',
  "    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;",
  '  }',
  '  return env;',
  '}',
  '',
  'export const test = base.extend<{',
  '  userDataDir: string;',
  '  electronApp: ElectronApplication;',
  '  window: Page;',
  '}>({',
  '  userDataDir: async ({}, use) => {',
  "    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));",
  '    try {',
  '      await use(dir);',
  '    } finally {',
  '      // Windows can briefly hold Chromium files open after the app closes.',
  '      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });',
  '    }',
  '  },',
  '',
  '  electronApp: async ({ userDataDir }, use) => {',
  '    requireBuiltMain();',
  '    // --user-data-dir= is load-bearing, not cosmetic: electron.launch()',
  '    // builds argv from `args` only and never reads a `userDataDir` option,',
  '    // so every run would otherwise share the real, shared profile.',
  '    const app = await electron.launch({',
  "      args: [`--user-data-dir=${userDataDir}`, '.'],",
  '      cwd: REPO_ROOT,',
  '      env: launchEnv(),',
  '    });',
  '    try {',
  '      await use(app);',
  '    } finally {',
  '      await app.close();',
  '    }',
  '  },',
  '',
  '  window: async ({ electronApp }, use) => {',
  '    const window = await electronApp.firstWindow();',
  "    await window.waitForLoadState('domcontentloaded');",
  '    await use(window);',
  '  },',
  '});',
  '',
  "export { expect } from '@playwright/test';"
);

/**
 * Pure leaf helper (initial_scaffold.md L3): polls `read()` until it returns
 * the same value `stableCount` times in a row, or throws once `timeoutMs`
 * elapses — "wait for a stable state, not a fixed sleep"
 * (functional_domain.md "E2E harness shape"). Comparison is by `Object.is`,
 * so T should be a primitive (a count, a length, a flag), not an object that
 * changes identity on every read.
 */
const POLL_UNTIL_STABLE = lines(
  'export interface PollUntilStableOptions {',
  '  /** Maximum total time to wait, in ms. Default 5000. */',
  '  timeoutMs?: number;',
  '  /** Delay between polls, in ms. Default 50. */',
  '  intervalMs?: number;',
  '  /** Consecutive identical reads required before considering the value stable. Default 3. */',
  '  stableCount?: number;',
  '}',
  '',
  'export async function pollUntilStable<T>(',
  '  read: () => T | Promise<T>,',
  '  options: PollUntilStableOptions = {}',
  '): Promise<T> {',
  '  const timeoutMs = options.timeoutMs ?? 5000;',
  '  const intervalMs = options.intervalMs ?? 50;',
  '  const stableCount = options.stableCount ?? 3;',
  '  if (stableCount < 1) {',
  "    throw new Error('pollUntilStable: stableCount must be at least 1');",
  '  }',
  '',
  '  const deadline = Date.now() + timeoutMs;',
  '  let lastValue: T | undefined;',
  '  let consecutive = 0;',
  '',
  '  for (;;) {',
  '    const value = await read();',
  '    consecutive = consecutive > 0 && Object.is(value, lastValue) ? consecutive + 1 : 1;',
  '    lastValue = value;',
  '',
  '    if (consecutive >= stableCount) return value;',
  '    if (Date.now() >= deadline) {',
  '      throw new Error(`pollUntilStable: timed out after ${timeoutMs}ms waiting for a stable value`);',
  '    }',
  "    await new Promise((resolve) => setTimeout(resolve, intervalMs));",
  '  }',
  '}'
);

/** Exercises the pure leaf above directly (L3 — shipped, not dead code). */
const POLL_UNTIL_STABLE_TEST = lines(
  "import { describe, expect, it } from 'vitest';",
  "import { pollUntilStable } from '../e2e/support/pollUntilStable.js';",
  '',
  "describe('pollUntilStable', () => {",
  "  it('resolves once the same value is read stableCount times in a row', async () => {",
  '    let i = 0;',
  '    const read = () => {',
  '      i += 1;',
  '      return i < 3 ? i : 3; // settles at 3 from the 3rd read onward',
  '    };',
  '    const result = await pollUntilStable(read, { intervalMs: 1, stableCount: 3, timeoutMs: 1000 });',
  '    expect(result).toBe(3);',
  '  });',
  '',
  "  it('throws once timeoutMs elapses without a stable value', async () => {",
  '    let i = 0;',
  '    await expect(',
  '      pollUntilStable(',
  '        () => {',
  '          i += 1;',
  '          return i;',
  '        },',
  '        { intervalMs: 1, stableCount: 2, timeoutMs: 20 }',
  '      )',
  '    ).rejects.toThrow(/timed out/);',
  '  });',
  '',
  "  it('rejects a stableCount below 1', async () => {",
  '    await expect(pollUntilStable(() => 1, { stableCount: 0 })).rejects.toThrow(/stableCount/);',
  '  });',
  '',
  "  it('supports an async read()', async () => {",
  "    const result = await pollUntilStable(async () => 'done', { stableCount: 2, intervalMs: 1, timeoutMs: 500 });",
  "    expect(result).toBe('done');",
  '  });',
  '});'
);

/**
 * The §3.8 launch check — 4 tests. No free-text answer is ever
 * interpolated (L5): BRIDGE_GLOBAL and EXPECTED_BRIDGE_KEYS are derived
 * tokens only (ctx.bridgeGlobal, and a flag-derived key list), never
 * appName/description/author.
 */
function renderSmokeSpec(ctx: ResolvedContext): string {
  const expectedBridgeKeys = [...(ctx.includeSettings ? ['settings'] : []), ...(ctx.includeSkins ? ['skins'] : [])].sort();

  return lines(
    "import { test, expect } from './support/fixtures.js';",
    '',
    `const BRIDGE_GLOBAL = ${JSON.stringify(ctx.bridgeGlobal)};`,
    `const EXPECTED_BRIDGE_KEYS: string[] = ${JSON.stringify(expectedBridgeKeys)};`,
    '',
    "test.describe('smoke', () => {",
    "  test('launches and renders the placeholder', async ({ electronApp, window }) => {",
    '    expect(electronApp.windows()).toHaveLength(1);',
    "    const heading = window.locator('h1');",
    '    await expect(heading).toBeVisible();',
    '    expect(await heading.textContent()).toBe(await window.title());',
    '  });',
    '',
    "  test('renderer is isolated from Node', async ({ window }) => {",
    '    const result = await window.evaluate(() => ({',
    "      hasRequire: typeof (globalThis as Record<string, unknown>)['require'],",
    "      hasProcess: typeof (globalThis as Record<string, unknown>)['process'],",
    "      hasModule: typeof (globalThis as Record<string, unknown>)['module'],",
    '    }));',
    "    expect(result.hasRequire).toBe('undefined');",
    "    expect(result.hasProcess).toBe('undefined');",
    "    expect(result.hasModule).toBe('undefined');",
    '  });',
    '',
    "  test('bridge exposes only the declared surface', async ({ window }) => {",
    '    const keys = await window.evaluate(',
    '      (bridgeGlobal) => Object.keys((globalThis as Record<string, unknown>)[bridgeGlobal] ?? {}).sort(),',
    '      BRIDGE_GLOBAL',
    '    );',
    '    expect(keys).toEqual(EXPECTED_BRIDGE_KEYS);',
    '  });',
    '',
    "  test('application menu is installed', async ({ electronApp }) => {",
    '    const labels = await electronApp.evaluate(({ Menu }) =>',
    '      (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label)',
    '    );',
    "    expect(labels).toContain('File');",
    '  });',
    '});'
  );
}

/**
 * Least-privilege, no secrets anywhere (L6, D2): verifies on every PR, on
 * `windows-latest`, through typecheck/build/unit/e2e. `npm ci` requires a
 * committed lockfile (L4) — documented in the generated README.
 */
const CI_WORKFLOW = lines(
  'name: CI',
  'on:',
  '  pull_request:',
  '    branches: [main]',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  verify:',
  '    runs-on: windows-latest',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '      - uses: actions/setup-node@v7',
  '        with:',
  '          node-version: 24',
  '          cache: npm',
  '      - run: npm ci',
  '      - run: npm run typecheck',
  '      - run: npm run build',
  '      - run: npm test',
  '      - run: npm run test:e2e',
  '      - uses: actions/upload-artifact@v7',
  '        if: failure()',
  '        with:',
  '          name: test-results',
  '          path: test-results/',
  '          if-no-files-found: ignore'
);

/**
 * Builds and uploads an installer as a workflow artifact; never publishes
 * (D3 — consistent with electron-builder.yml's `publish: null`). The
 * generated README documents the three edits needed to switch this to
 * actually publishing.
 */
const RELEASE_WORKFLOW = lines(
  'name: Release',
  'on:',
  '  push:',
  "    tags: ['v*.*.*']",
  'permissions:',
  '  contents: read',
  'jobs:',
  '  release:',
  '    runs-on: windows-latest',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '      - uses: actions/setup-node@v7',
  '        with:',
  '          node-version: 24',
  '          cache: npm',
  '      - run: npm ci',
  '      - run: npm run typecheck',
  '      - run: npm run build',
  '      - run: npm test',
  '      - run: npm run test:e2e',
  '      - run: npx electron-builder --win --publish never',
  '      - uses: actions/upload-artifact@v7',
  '        with:',
  '          name: release',
  '          path: release/*.exe',
  '          if-no-files-found: error'
);

/** Cycle A + B1 file set, in emission order. Adding a file = adding an entry. */
export const TIER1_FILES: readonly TierFile[] = [
  { path: 'package.json', render: renderPackageJson },
  { path: 'README.md', render: renderReadme },
  { path: '.gitignore', render: constant(GITIGNORE) },
  { path: 'LICENSE', include: hasAuthor, render: renderLicense },
  { path: 'tsconfig.json', include: (ctx) => !needsRendererSplit(ctx), render: constant(TSCONFIG) },
  { path: 'tsconfig.base.json', include: needsRendererSplit, render: constant(TSCONFIG_BASE) },
  { path: 'tsconfig.main.json', include: needsRendererSplit, render: constant(TSCONFIG_MAIN) },
  { path: 'tsconfig.renderer.json', include: needsRendererSplit, render: constant(TSCONFIG_RENDERER) },
  { path: 'tsconfig.typecheck.json', render: renderTsconfigTypecheck },
  { path: 'vitest.config.ts', render: constant(VITEST_CONFIG) },
  { path: 'src/main/windowConfig.ts', render: renderWindowConfig },
  { path: 'src/main/linkPolicy.ts', render: constant(LINK_POLICY) },
  { path: 'src/main/ipc.ts', render: renderIpc },
  { path: 'src/main/atomicWriteFile.ts', include: needsAtomicWriteFile, render: constant(ATOMIC_WRITE_FILE) },
  { path: 'src/main/staticWindowShell.ts', include: (ctx) => ctx.includeAboutHelp, render: constant(STATIC_WINDOW_SHELL) },
  { path: 'src/main/settings.ts', include: (ctx) => ctx.includeSettings, render: constant(SETTINGS_TS) },
  { path: 'src/main/settingsStore.ts', include: (ctx) => ctx.includeSettings, render: renderSettingsStore },
  { path: 'src/main/skins.ts', include: (ctx) => ctx.includeSkins, render: constant(SKINS_TS) },
  { path: 'src/main/skinsStore.ts', include: (ctx) => ctx.includeSkins, render: renderSkinsStore },
  { path: 'third-party-notices.json', include: (ctx) => ctx.includeAboutHelp, render: constant(THIRD_PARTY_NOTICES_JSON) },
  { path: 'help.md', include: (ctx) => ctx.includeAboutHelp, render: constant(HELP_MD) },
  { path: 'src/main/aboutWindow.ts', include: (ctx) => ctx.includeAboutHelp, render: constant(ABOUT_WINDOW) },
  { path: 'src/main/helpWindow.ts', include: (ctx) => ctx.includeAboutHelp, render: constant(HELP_WINDOW) },
  { path: 'src/main/menu.ts', render: renderMenuTs },
  { path: 'src/main/index.ts', render: renderMainIndex },
  { path: 'src/preload/api.ts', render: renderPreloadApi },
  { path: 'src/preload/index.ts', render: renderPreloadIndex },
  { path: 'src/renderer/index.html', render: renderRendererIndexHtml },
  { path: 'src/renderer/app.css', render: renderRendererCss },
  { path: 'src/renderer/theme.ts', include: (ctx) => ctx.includeSettings, render: renderRendererThemeTs },
  { path: 'src/renderer/skins.ts', include: (ctx) => ctx.includeSkins, render: renderRendererSkinsTs },
  { path: 'scripts/build.mjs', render: renderBuildScript },
  { path: 'electron-builder.yml', render: renderElectronBuilderYml },
  // Cycle B2 — e2e harness + CI (initial_scaffold.md), all unconditional.
  { path: 'playwright.config.ts', render: constant(PLAYWRIGHT_CONFIG) },
  { path: 'tests/e2e/support/fixtures.ts', render: constant(E2E_FIXTURES) },
  { path: 'tests/e2e/support/pollUntilStable.ts', render: constant(POLL_UNTIL_STABLE) },
  { path: 'tests/e2e/smoke.spec.ts', render: renderSmokeSpec },
  { path: 'tests/unit/pollUntilStable.test.ts', render: constant(POLL_UNTIL_STABLE_TEST) },
  { path: '.github/workflows/ci.yml', render: constant(CI_WORKFLOW) },
  { path: '.github/workflows/release.yml', render: constant(RELEASE_WORKFLOW) },
];
