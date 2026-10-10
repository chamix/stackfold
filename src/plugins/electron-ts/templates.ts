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
  /** Settings feature selected (Dark Mode + Show Frontmatter + Show File Tree). */
  includeSettings: boolean;
  /** Skins feature selected (named, user-editable visual presets). */
  includeSkins: boolean;
  /** About + Help windows selected (one flag gates both — Decision 2). */
  includeAboutHelp: boolean;
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
    ...(needsZod(ctx) ? { dependencies: { zod: '^4.6.5' } } : {}),
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
  ...(needsTrustedSenderRegistry(ctx) || ctx.includeSettings || ctx.includeSkins
    ? [
        '',
        "  window.on('closed', () => {",
        ...(needsTrustedSenderRegistry(ctx) ? ['    untrustWebContents(windowId);'] : []),
        ...(ctx.includeSettings ? ['    unsubscribeSettingsChange();'] : []),
        ...(ctx.includeSkins ? ['    unsubscribeSkinsChange();'] : []),
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

/** Settings feature (`ctx.includeSettings`) — Dark Mode + Show Frontmatter + Show File Tree (Decision 1: folded into Settings, no separate theme question). */
const SETTINGS_TS = lines(
  "import { z } from 'zod';",
  '',
  'export const ViewSettingsSchema = z',
  '  .object({',
  '    showFrontmatter: z.boolean(),',
  '    showFileTree: z.boolean(),',
  '    darkMode: z.boolean(),',
  '  })',
  '  .strict();',
  '',
  'export type ViewSettings = z.infer<typeof ViewSettingsSchema>;',
  '',
  'export const DEFAULT_VIEW_SETTINGS: ViewSettings = {',
  '  showFrontmatter: true,',
  '  showFileTree: true,',
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
  '  aboutWindow = window;',
  "  window.on('closed', () => {",
  '    aboutWindow = undefined;',
  '  });',
  '  window.loadURL(`data:text/html,${encodeURIComponent(buildAboutHtml())}`).catch((error: unknown) => {',
  "    console.error('Failed to load About window', error);",
  '  });',
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
  '  helpWindow = window;',
  "  window.on('closed', () => {",
  '    helpWindow = undefined;',
  '  });',
  '  window.loadURL(`data:text/html,${encodeURIComponent(buildHelpHtml())}`).catch((error: unknown) => {',
  "    console.error('Failed to load Help window', error);",
  '  });',
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
        "      label: 'Show Frontmatter',",
        "      type: 'checkbox',",
        '      checked: getSettings().showFrontmatter,',
        '      click: () => {',
        '        void setSettings({ showFrontmatter: !getSettings().showFrontmatter });',
        '      },',
        '    },',
        '    {',
        "      label: 'Show File Tree',",
        "      type: 'checkbox',",
        '      checked: getSettings().showFileTree,',
        '      click: () => {',
        '        void setSettings({ showFileTree: !getSettings().showFileTree });',
        '      },',
        '    },',
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

/** Cycle A + B1 file set, in emission order. Adding a file = adding an entry. */
export const TIER1_FILES: readonly TierFile[] = [
  { path: 'package.json', render: renderPackageJson },
  { path: 'README.md', render: renderReadme },
  { path: '.gitignore', render: constant(GITIGNORE) },
  { path: 'LICENSE', include: hasAuthor, render: renderLicense },
  { path: 'tsconfig.json', render: constant(TSCONFIG) },
  { path: 'tsconfig.typecheck.json', render: constant(TSCONFIG_TYPECHECK) },
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
  { path: 'src/renderer/app.css', render: constant(RENDERER_CSS) },
  { path: 'scripts/build.mjs', render: constant(BUILD_SCRIPT) },
  { path: 'electron-builder.yml', render: renderElectronBuilderYml },
];
