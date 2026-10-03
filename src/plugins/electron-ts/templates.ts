import type { AnswerValue, Answers } from '../../core/types.js';

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

/** npm's package-name length limit. */
const MAX_PACKAGE_NAME_LENGTH = 214;

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
}

/** Derives a URL-safe npm package name from a human-readable app name. */
export function toPackageName(appName: string): string {
  return appName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PACKAGE_NAME_LENGTH)
    .replace(/-+$/, '');
}

/**
 * camelCases the package name into a valid JS identifier and appends a
 * fixed `Api` suffix: `my-cool-app` → `myCoolAppApi`. The spec's
 * `-([a-z])` rule is widened to `-([a-z0-9])` so a digit after a hyphen
 * (`app-2x`) can't leave a '-' behind, and a leading digit (`3d-viewer`)
 * gets an `app` prefix, since identifiers can't start with one.
 *
 * The `Api` suffix is load-bearing, not cosmetic: plausible app names
 * (e.g. "History", "Crypto", "Performance", "Origin") camelCase to names
 * that already exist on `window` (`history`, `crypto`, …), and
 * `contextBridge.exposeInMainWorld` is expected to throw when asked to
 * bind over an existing window property. A fixed suffix rules this out
 * for every input, which is cheaper to keep correct than a denylist that
 * would need maintaining against future browser globals.
 */
export function toBridgeGlobal(packageName: string): string {
  const camel = packageName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const identifier = /^[0-9]/.test(camel) ? `app${camel}` : camel;
  return `${identifier}Api`;
}

export function validateAppName(value: AnswerValue): true | string {
  const name = String(value).trim();
  if (name === '') return 'App name must not be empty.';
  if (toPackageName(name) === '') {
    return 'App name must contain at least one letter or digit.';
  }
  return true;
}

function optionalString(answers: Answers, id: string, fallback: string): string {
  const value = answers[id];
  return value === undefined ? fallback : String(value).trim();
}

/** Answers → resolved context. Throws on a missing or invalid appName. */
export function resolveContext(answers: Answers, now: Date): ResolvedContext {
  const rawAppName = answers['appName'];
  if (rawAppName === undefined) {
    throw new Error('electron-ts: missing required answer "appName"');
  }
  const appName = String(rawAppName).trim();
  const verdict = validateAppName(appName);
  if (verdict !== true) throw new Error(`electron-ts: invalid appName: ${verdict}`);

  const packageName = toPackageName(appName);
  return {
    appName,
    description: optionalString(answers, 'description', DEFAULT_DESCRIPTION),
    author: optionalString(answers, 'author', DEFAULT_AUTHOR),
    packageName,
    appId: `com.${packageName}.app`,
    bridgeGlobal: toBridgeGlobal(packageName),
    ipcPrefix: packageName,
    year: now.getFullYear(),
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
    },
    devDependencies: {
      electron: '^44.4.5',
      typescript: '^6.0.3',
      vitest: '^5.0.2',
      '@types/node': '^24.19.0',
      esbuild: '^0.28.2',
      'electron-builder': '^26.15.3',
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
  );
}

const GITIGNORE = lines('node_modules/', 'dist/', 'out/', '.vite/', '*.log');

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
 * `tsconfig.json` above is also the build config (`tsc -p tsconfig.json`
 * emits to `dist/`), so its `include`/`rootDir` can't widen to cover
 * `tests/**` and `vitest.config.ts` without tests landing in `dist/`. This
 * sibling, noEmit-only config is what `npm run typecheck` actually runs
 * against, so the generated project's own tests and vitest config are
 * type-checked too.
 */
const TSCONFIG_TYPECHECK = json({
  extends: './tsconfig.json',
  compilerOptions: { noEmit: true, rootDir: '.' },
  include: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
});

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

const WINDOW_CONFIG = lines(
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
);

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

const IPC = lines(
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
);

const MAIN_INDEX = lines(
  "import { join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  "import { app, BrowserWindow, shell } from 'electron';",
  "import { isExternalHttpUrl } from './linkPolicy.js';",
  "import { secureWebPreferences } from './windowConfig.js';",
  '',
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
  '}',
  '',
  "app.on('window-all-closed', () => {",
  "  if (process.platform !== 'darwin') app.quit();",
  '});',
  '',
  'app',
  '  .whenReady()',
  '  .then(() => {',
  '    createWindow();',
  "    app.on('activate', () => {",
  '      if (BrowserWindow.getAllWindows().length === 0) createWindow();',
  '    });',
  '  })',
  '  .catch((error: unknown) => {',
  "    console.error('Failed to start', error);",
  '    app.quit();',
  '  });',
);

function renderPreloadApi(ctx: ResolvedContext): string {
  return lines(
    '/**',
    ' * The complete, enumerable surface between renderer and main process.',
    ' * There are zero channels today; the bridge still exists and stays narrow.',
    ' * To add an operation: one entry here named',
    ` * \`${ctx.ipcPrefix}:<operation>\`, one method on BridgeApi, and a main-process`,
    ' * handler registered through `registerHandler()` (`src/main/ipc.ts`),',
    ' * which validates the event sender before acting. Never expose ipcRenderer',
    ' * itself or a wildcard channel.',
    ' */',
    'export const IPC_CHANNELS = {} as const satisfies Record<string, string>;',
    '',
    '// Zero methods today; extended per channel, never wildcarded.',
    'export interface BridgeApi {}',
  );
}

function renderPreloadIndex(ctx: ResolvedContext): string {
  return lines(
    "import { contextBridge } from 'electron';",
    "import type { BridgeApi } from './api.js';",
    '',
    'const api: BridgeApi = {};',
    '',
    `contextBridge.exposeInMainWorld('${ctx.bridgeGlobal}', api);`,
  );
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
    '  </body>',
    '</html>',
  );
}

const RENDERER_CSS = lines(
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

/**
 * The explicit asset manifest the handoff asked for (§5.1) — generated
 * *output* a scaffolded project runs, not stackfold's own build (SOLID
 * Boundary Scan, Cycle B1 spec). `format: 'cjs'` is required, not a style
 * choice: `sandbox: true` loads the preload as CommonJS, never ESM.
 */
const BUILD_SCRIPT = lines(
  '#!/usr/bin/env node',
  "import { execSync } from 'node:child_process';",
  "import { cpSync, mkdirSync } from 'node:fs';",
  "import { dirname } from 'node:path';",
  "import { build as esbuildBuild } from 'esbuild';",
  '',
  "execSync('tsc -p tsconfig.json', { stdio: 'inherit' });",
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
    'win:',
    '  target:',
    '    - nsis',
    '    - portable',
    'publish: null',
  );
}

/** Cycle A + B1 file set, in emission order. Adding a file = adding an entry. */
export const TIER1_FILES: readonly TierFile[] = [
  { path: 'package.json', render: renderPackageJson },
  { path: 'README.md', render: renderReadme },
  { path: '.gitignore', render: constant(GITIGNORE) },
  { path: 'LICENSE', include: hasAuthor, render: renderLicense },
  { path: 'tsconfig.json', render: constant(TSCONFIG) },
  { path: 'tsconfig.typecheck.json', render: constant(TSCONFIG_TYPECHECK) },
  { path: 'vitest.config.ts', render: constant(VITEST_CONFIG) },
  { path: 'src/main/windowConfig.ts', render: constant(WINDOW_CONFIG) },
  { path: 'src/main/linkPolicy.ts', render: constant(LINK_POLICY) },
  { path: 'src/main/ipc.ts', render: constant(IPC) },
  { path: 'src/main/index.ts', render: constant(MAIN_INDEX) },
  { path: 'src/preload/api.ts', render: renderPreloadApi },
  { path: 'src/preload/index.ts', render: renderPreloadIndex },
  { path: 'src/renderer/index.html', render: renderRendererIndexHtml },
  { path: 'src/renderer/app.css', render: constant(RENDERER_CSS) },
  { path: 'scripts/build.mjs', render: constant(BUILD_SCRIPT) },
  { path: 'electron-builder.yml', render: renderElectronBuilderYml },
];
