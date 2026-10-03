import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElectronTsPlugin, electronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { resolveContext } from '../../src/plugins/electron-ts/templates.js';
import { runPlugin } from '../../src/core/orchestrator.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers, QuestionDefinition } from '../../src/core/types.js';

const FIXED_NOW = new Date(2031, 5, 15);
const plugin = createElectronTsPlugin({ now: () => FIXED_NOW });

const ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };
const NO_AUTHOR: Answers = { appName: 'My Cool App!', description: 'A demo app' };

const TIER1_PATHS = [
  'package.json',
  'README.md',
  '.gitignore',
  'LICENSE',
  'tsconfig.json',
  'tsconfig.typecheck.json',
  'vitest.config.ts',
  'src/main/windowConfig.ts',
  'src/main/linkPolicy.ts',
  'src/main/ipc.ts',
  'src/main/index.ts',
  'src/preload/api.ts',
  'src/preload/index.ts',
];

function question(id: string): QuestionDefinition {
  const q = plugin.questions().find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} not declared`);
  return q;
}

function fileContent(answers: Answers, path: string): string {
  const entry = plugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

describe('electron-ts plugin — identity', () => {
  it('has the stable id "electron-ts" and a description', () => {
    expect(electronTsPlugin.id).toBe('electron-ts');
    expect(electronTsPlugin.description.length).toBeGreaterThan(0);
  });

  it('is resolvable through a registry by its id', () => {
    const registry = new StaticPluginRegistry([electronTsPlugin]);
    expect(registry.resolve('electron-ts')).toBe(electronTsPlugin);
  });

  it('the default export and the factory produce the same questions', () => {
    expect(electronTsPlugin.questions().map((q) => q.id)).toEqual(plugin.questions().map((q) => q.id));
  });
});

describe('electron-ts plugin — questions()', () => {
  it('declares appName, description and author, in that order', () => {
    expect(plugin.questions().map((q) => q.id)).toEqual(['appName', 'description', 'author']);
  });

  it.each(['appName', 'description'])('declares %s as a text question with a string default', (id) => {
    const q = question(id);
    expect(q.type).toBe('input');
    expect(typeof q.default).toBe('string');
  });

  it('declares author as an optional text question whose default is empty', () => {
    const q = question('author');
    expect(q.type).toBe('input');
    expect(q.default).toBe('');
    expect(q.validate?.('') ?? true).toBe(true);
  });

  it.each(['', '   ', '!!!'])('appName validation rejects %j', (value) => {
    expect(question('appName').validate?.(value)).toEqual(expect.any(String));
  });

  it.each(['my-app', 'My Cool App', 'app2', '3D Viewer'])('appName validation accepts %j', (value) => {
    expect(question('appName').validate?.(value)).toBe(true);
  });

  it('appName default itself passes validation', () => {
    const q = question('appName');
    expect(q.validate?.(q.default as string)).toBe(true);
  });

  it('no question can weaken the security posture (§3.1)', () => {
    const ids = plugin.questions().map((q) => q.id.toLowerCase());
    for (const forbidden of ['sandbox', 'contextisolation', 'nodeintegration', 'websecurity', 'navigation']) {
      expect(ids.some((id) => id.includes(forbidden))).toBe(false);
    }
  });
});

describe('electron-ts plugin — resolved context (tier 1: pure derivation)', () => {
  it('derives packageName, appId, bridgeGlobal and ipcPrefix from the app name', () => {
    expect(resolveContext(ANSWERS, FIXED_NOW)).toEqual({
      appName: 'My Cool App!',
      description: 'A demo app',
      author: 'Ada Lovelace',
      packageName: 'my-cool-app',
      appId: 'com.my-cool-app.app',
      bridgeGlobal: 'myCoolAppApi',
      ipcPrefix: 'my-cool-app',
      year: 2031,
    });
  });

  it.each([
    ['my-cool-app', 'myCoolAppApi'],
    ['Single', 'singleApi'],
    ['app 2x', 'app2xApi'],
    ['v2 Beta', 'v2BetaApi'],
    ['3D Viewer', 'app3dViewerApi'],
    ['Ünïcödé Äpp', 'unicodeAppApi'],
  ])('bridgeGlobal for %j is the valid JS identifier %j', (appName, expected) => {
    const { bridgeGlobal } = resolveContext({ appName }, FIXED_NOW);
    expect(bridgeGlobal).toBe(expected);
    expect(bridgeGlobal).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  it.each(['History', 'Crypto', 'Performance', 'Navigator', 'Origin', 'Screen', 'Name', 'Status', 'Document', 'Location'])(
    'bridgeGlobal for the plausible app name %j gets the Api suffix, so it never collides with window.%j (N3)',
    (appName) => {
      const { bridgeGlobal } = resolveContext({ appName }, FIXED_NOW);
      expect(bridgeGlobal).toMatch(/Api$/);
      expect(bridgeGlobal).not.toBe(appName.toLowerCase());
      expect(bridgeGlobal.toLowerCase()).not.toBe(appName.toLowerCase());
    }
  );

  it('trims answers and defaults description/author when absent', () => {
    const ctx = resolveContext({ appName: '  Demo  ' }, FIXED_NOW);
    expect(ctx.appName).toBe('Demo');
    expect(ctx.author).toBe('');
    expect(ctx.description.length).toBeGreaterThan(0);
  });

  it('throws a clear error if appName is missing or invalid (never generates from partial answers)', () => {
    expect(() => resolveContext({ description: 'x' }, FIXED_NOW)).toThrow(/appName/);
    expect(() => resolveContext({ appName: '!!!' }, FIXED_NOW)).toThrow(/appName/);
  });
});

describe('electron-ts plugin — buildBlueprint() is pure and synchronous', () => {
  it('returns a blueprint directly, not a Promise', () => {
    const result = plugin.buildBlueprint(ANSWERS);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('is deterministic: same answers, same blueprint', () => {
    expect(plugin.buildBlueprint({ ...ANSWERS })).toEqual(plugin.buildBlueprint({ ...ANSWERS }));
  });

  it('does not mutate its input', () => {
    const answers = Object.freeze({ ...ANSWERS });
    expect(() => plugin.buildBlueprint(answers)).not.toThrow();
  });

  it('throws a clear error if appName is missing', () => {
    expect(() => plugin.buildBlueprint({ description: 'x' })).toThrow(/appName/);
  });

  it('declares git-init as its only follow-up action', () => {
    expect(plugin.buildBlueprint(ANSWERS).postActions).toEqual([{ kind: 'git-init' }]);
  });
});

describe('electron-ts plugin — Tier-1 file set (tier 2: content invariants)', () => {
  it('emits exactly the Cycle A file set, in order, when an author is given', () => {
    expect(plugin.buildBlueprint(ANSWERS).files.map((f) => f.path)).toEqual(TIER1_PATHS);
  });

  it.each([NO_AUTHOR, { ...NO_AUTHOR, author: '' }, { ...NO_AUTHOR, author: '   ' }])(
    'omits LICENSE (no placeholder legal text) when author is empty: %j',
    (answers) => {
      expect(plugin.buildBlueprint(answers).files.map((f) => f.path)).toEqual(
        TIER1_PATHS.filter((p) => p !== 'LICENSE')
      );
    }
  );

  it('LICENSE is MIT with the author and the current year', () => {
    const license = fileContent(ANSWERS, 'LICENSE');
    expect(license).toMatch(/^MIT License/);
    expect(license).toContain('Copyright (c) 2031 Ada Lovelace');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('package.json carries identity, exact dependency pins and scripts', () => {
    const pkg = JSON.parse(fileContent(ANSWERS, 'package.json'));
    expect(pkg).toMatchObject({
      name: 'my-cool-app',
      productName: 'My Cool App!',
      version: '0.1.0',
      description: 'A demo app',
      private: true,
      author: 'Ada Lovelace',
      license: 'MIT',
      main: 'dist/main/index.js',
    });
    expect(pkg.devDependencies).toEqual({
      electron: '^44.4.5',
      typescript: '^6.0.3',
      vitest: '^5.0.2',
      '@types/node': '^24.19.0',
    });
    expect(pkg.scripts).toMatchObject({
      typecheck: 'tsc --noEmit -p tsconfig.typecheck.json',
      test: 'vitest run',
    });
  });

  it('package.json omits author/license when no author is given', () => {
    const pkg = JSON.parse(fileContent(NO_AUTHOR, 'package.json'));
    expect(pkg).not.toHaveProperty('author');
    expect(pkg).not.toHaveProperty('license');
  });

  it('keeps package.json valid JSON even when answers contain quotes', () => {
    const pkg = JSON.parse(
      fileContent({ appName: 'Say "hi"', description: 'a "quoted" desc', author: 'O"Brien' }, 'package.json')
    );
    expect(pkg.productName).toBe('Say "hi"');
    expect(pkg.description).toBe('a "quoted" desc');
    expect(pkg.author).toBe('O"Brien');
  });

  it('README names the app, documents the security posture and is no longer a placeholder', () => {
    const readme = fileContent(ANSWERS, 'README.md');
    expect(readme).toContain('# My Cool App!');
    expect(readme).toContain('A demo app');
    expect(readme).toMatch(/security/i);
    expect(readme).toContain('window.myCoolAppApi');
    expect(readme.toLowerCase()).not.toContain('placeholder');
    expect(readme.toLowerCase()).not.toContain('pending');
  });

  it('.gitignore covers dependencies, build output and caches', () => {
    const lines = fileContent(ANSWERS, '.gitignore').split('\n');
    for (const entry of ['node_modules/', 'dist/', 'out/', '.vite/']) expect(lines).toContain(entry);
  });

  it('tsconfig.json targets Electron 44 / Node 24 strictly', () => {
    const tsconfig = JSON.parse(fileContent(ANSWERS, 'tsconfig.json'));
    expect(tsconfig.compilerOptions).toMatchObject({
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      types: ['node', 'electron'],
    });
  });

  it("vitest.config.ts uses the node environment (no jsdom)", () => {
    const config = fileContent(ANSWERS, 'vitest.config.ts');
    expect(config).toContain("environment: 'node'");
    expect(config).not.toContain('jsdom');
  });

  it('windowConfig.ts sets all three isolation keys explicitly (§3.1)', () => {
    const src = fileContent(ANSWERS, 'src/main/windowConfig.ts');
    expect(src).toContain('contextIsolation: true');
    expect(src).toContain('nodeIntegration: false');
    expect(src).toContain('sandbox: true');
    expect(src).toContain('preload: preloadPath');
    expect(src).toContain("import type { BrowserWindowConstructorOptions } from 'electron'");
    expect(src).not.toMatch(/^import (?!type)/m);
  });

  it('no generated file weakens the security posture anywhere', () => {
    for (const { content } of plugin.buildBlueprint(ANSWERS).files) {
      const text = content.toString();
      expect(text).not.toMatch(/contextIsolation:\s*false/);
      expect(text).not.toMatch(/nodeIntegration:\s*true/);
      expect(text).not.toMatch(/sandbox:\s*false/);
      expect(text).not.toMatch(/webSecurity:\s*false/);
      expect(text).not.toContain('allowRunningInsecureContent');
    }
  });

  it('linkPolicy.ts parses with URL rather than comparing strings', () => {
    const src = fileContent(ANSWERS, 'src/main/linkPolicy.ts');
    expect(src).toContain('export function isExternalHttpUrl(url: string, appOrigin: string): boolean');
    expect(src).toContain('new URL(url)');
    expect(src).not.toMatch(/startsWith|indexOf|includes\(/);
  });

  it('ipc.ts provides a sender-validated registration point for every future channel (N1)', () => {
    const src = fileContent(ANSWERS, 'src/main/ipc.ts');
    expect(src).toContain("import { ipcMain, type IpcMainInvokeEvent } from 'electron';");
    expect(src).toContain('export function registerHandler(');
    expect(src).toContain('isTrustedSender: (event: IpcMainInvokeEvent) => boolean,');
    expect(src).toContain('ipcMain.handle(channel, (event, ...args) => {');
    expect(src).toContain('if (!isTrustedSender(event)) {');
  });

  it('tsconfig.typecheck.json extends the build config without widening it, and covers tests/** and vitest.config.ts (N4)', () => {
    const typecheckConfig = JSON.parse(fileContent(ANSWERS, 'tsconfig.typecheck.json'));
    expect(typecheckConfig.extends).toBe('./tsconfig.json');
    expect(typecheckConfig.compilerOptions).toMatchObject({ noEmit: true, rootDir: '.' });
    expect(typecheckConfig.include).toEqual(['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts']);

    const buildConfig = JSON.parse(fileContent(ANSWERS, 'tsconfig.json'));
    expect(buildConfig.include).toEqual(['src/**/*.ts']);
    expect(buildConfig.compilerOptions.rootDir).toBe('src');
  });

  it('main/index.ts wires windowConfig and linkPolicy into navigation and window-open control', () => {
    const src = fileContent(ANSWERS, 'src/main/index.ts');
    expect(src).toContain("from './windowConfig.js'");
    expect(src).toContain("from './linkPolicy.js'");
    expect(src).toContain('secureWebPreferences(PRELOAD_PATH)');
    expect(src).toContain("app.on('web-contents-created'");
    expect(src).toContain("contents.on('will-navigate'");
    expect(src).toContain('event.preventDefault()');
    expect(src).toContain('contents.setWindowOpenHandler(');
    expect(src).toContain("return { action: 'deny' }");
    expect(src).toContain('isExternalHttpUrl(url, APP_ORIGIN)');
    expect(src).toContain('shell.openExternal(url)');
  });

  it('will-navigate blocks every navigation: preventDefault() is the unconditional first statement', () => {
    // Approved deviation from the spec snippet (electron/security.md): the
    // shell has no in-app navigation, so file:, data: and custom-scheme
    // navigations must be blocked too, not only external http(s) ones.
    const src = fileContent(ANSWERS, 'src/main/index.ts');
    const handler = src.match(/contents\.on\('will-navigate', \((\w+)\) => \{\n([\s\S]*?)\n {2}\}\);/);
    expect(handler, 'single-parameter will-navigate handler not found').not.toBeNull();
    const [, eventParam, body] = handler as RegExpMatchArray;
    const statements = (body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'));
    expect(statements[0]).toBe(`${eventParam}.preventDefault();`);
    expect((body ?? '').match(/preventDefault/g)).toHaveLength(1);
    // Non-deprecated Electron 44 form: the URL comes from the event itself.
    expect(body).toContain(`isExternalHttpUrl(${eventParam}.url, APP_ORIGIN)`);
  });

  it('preload api.ts declares an empty but explicit channel map and bridge surface (§3.3)', () => {
    const src = fileContent(ANSWERS, 'src/preload/api.ts');
    expect(src).toContain('export const IPC_CHANNELS = {} as const satisfies Record<string, string>;');
    expect(src).toContain('export interface BridgeApi {}');
    expect(src).toContain('my-cool-app:');
  });

  it('preload index.ts exposes exactly one named bridge and never raw ipcRenderer (§3.3)', () => {
    const src = fileContent(ANSWERS, 'src/preload/index.ts');
    expect(src).toContain("contextBridge.exposeInMainWorld('myCoolAppApi', api);");
    expect(src).toContain('const api: BridgeApi = {};');
    expect(src.match(/exposeInMainWorld/g)).toHaveLength(1);
    expect(src).not.toContain('ipcRenderer');
  });

  it('no free-text answer is ever interpolated into generated TypeScript', () => {
    const answers = { appName: "Evil'); require('child_process", description: 'DESC_MARKER', author: 'AUTHOR_MARKER' };
    for (const { path, content } of plugin.buildBlueprint(answers).files) {
      if (!path.endsWith('.ts')) continue;
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });

  it('no branding or governance leakage in any file (§3.4, §3.5)', () => {
    for (const { content } of plugin.buildBlueprint(ANSWERS).files) {
      const text = content.toString().toLowerCase();
      for (const leak of ['stackfold', 'md-view', '.agents', 'run_log', 'backlog.md', 'claude-blueprints']) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it('emits no Tier-2 content (§3.6)', () => {
    const paths = plugin.buildBlueprint(ANSWERS).files.map((f) => f.path.toLowerCase());
    for (const tier2 of ['settings', 'appstate', 'whatsnew', 'help']) {
      expect(paths.some((p) => p.includes(tier2))).toBe(false);
    }
  });
});

describe('electron-ts plugin — generation integrity (tier 3: real emitted code)', () => {
  let root: string;
  let projectDir: string;
  let isExternalHttpUrl: (url: string, appOrigin: string) => boolean;
  let registerHandler: (
    channel: string,
    isTrustedSender: (event: unknown) => boolean,
    handler: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
  let ipcHandleCalls: Array<{ channel: string; cb: (...args: unknown[]) => unknown }>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'stackfold-electron-ts-'));
    projectDir = join(root, 'generated');
    const writer = new NodeFileWriter();
    await writer.ensureEmptyDir(projectDir);
    for (const file of plugin.buildBlueprint(ANSWERS).files) {
      await writer.writeFile(join(projectDir, file.path), file.content);
    }

    // Compile the linkPolicy.ts that was actually written to disk — not a
    // hand-copied duplicate — and import the emitted module.
    const source = await readFile(join(projectDir, 'src/main/linkPolicy.ts'), 'utf8');
    const { outputText, diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: 'linkPolicy.ts',
    });
    expect(diagnostics ?? []).toEqual([]);
    const emitted = join(root, 'linkPolicy.mjs');
    await writeFile(emitted, outputText);
    ({ isExternalHttpUrl } = await import(pathToFileURL(emitted).href));

    // ipc.ts imports `ipcMain` from 'electron', which only exists as a real
    // API inside the Electron runtime. A minimal stub package, resolved by
    // Node's ordinary module resolution from the emitted file's own
    // directory, exercises the exact export ipc.ts actually uses
    // (`ipcMain.handle`) without needing the real Electron binary.
    const electronStubDir = join(root, 'node_modules', 'electron');
    await writer.ensureEmptyDir(electronStubDir);
    await writer.writeFile(
      join(electronStubDir, 'package.json'),
      JSON.stringify({ name: 'electron', version: '0.0.0-stub', type: 'module', main: 'index.mjs' })
    );
    await writer.writeFile(
      join(electronStubDir, 'index.mjs'),
      [
        'export const handleCalls = [];',
        'export const ipcMain = {',
        '  handle(channel, cb) {',
        '    handleCalls.push({ channel, cb });',
        '  },',
        '};',
        '',
      ].join('\n')
    );
    ({ handleCalls: ipcHandleCalls } = await import(pathToFileURL(join(electronStubDir, 'index.mjs')).href));

    const ipcSource = await readFile(join(projectDir, 'src/main/ipc.ts'), 'utf8');
    const { outputText: ipcOutput, diagnostics: ipcDiagnostics } = ts.transpileModule(ipcSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
      fileName: 'ipc.ts',
    });
    expect(ipcDiagnostics ?? []).toEqual([]);
    const emittedIpc = join(root, 'ipc.mjs');
    await writeFile(emittedIpc, ipcOutput);
    ({ registerHandler } = await import(pathToFileURL(emittedIpc).href));
  });

  afterAll(async () => {
    if (projectDir) await rm(join(projectDir, '..'), { recursive: true, force: true });
  });

  it('writes every blueprint file byte-for-byte through NodeFileWriter', async () => {
    for (const file of plugin.buildBlueprint(ANSWERS).files) {
      expect(await readFile(join(projectDir, file.path), 'utf8')).toBe(file.content.toString());
    }
  });

  it('emitted registerHandler rejects before calling handler when isTrustedSender returns false (N1)', () => {
    const handlerSpy = { called: false };
    registerHandler(
      'untrusted:channel',
      () => false,
      () => {
        handlerSpy.called = true;
        return 'should never run';
      }
    );
    const registration = ipcHandleCalls.find((call) => call.channel === 'untrusted:channel');
    expect(registration).toBeDefined();
    const fakeEvent = {};
    expect(() => registration?.cb(fakeEvent)).toThrow(
      'Rejected IPC call on "untrusted:channel" from an untrusted sender.'
    );
    expect(handlerSpy.called).toBe(false);
  });

  it('emitted registerHandler calls handler and returns its result when isTrustedSender returns true (N1)', () => {
    registerHandler(
      'trusted:channel',
      () => true,
      (_event, ...args) => ['handled', ...args]
    );
    const registration = ipcHandleCalls.find((call) => call.channel === 'trusted:channel');
    expect(registration).toBeDefined();
    const fakeEvent = {};
    expect(registration?.cb(fakeEvent, 'a', 'b')).toEqual(['handled', 'a', 'b']);
  });

  it.each([
    ['same origin', 'https://app.example/page', 'https://app.example', false],
    ['same origin, trailing path and query', 'https://app.example:443/a?b=c#d', 'https://app.example', false],
    ['cross origin (https)', 'https://evil.example/', 'https://app.example', true],
    ['cross origin (http)', 'http://evil.example/', 'https://app.example', true],
    ['cross origin (scheme downgrade)', 'http://app.example/', 'https://app.example', true],
    ['cross origin (port)', 'https://app.example:8443/', 'https://app.example', true],
    ['cross origin (lookalike prefix)', 'https://app.example.evil.test/', 'https://app.example', true],
    ['packaged file:// app, any http(s) link', 'https://docs.example/', 'null', true],
    ['non-http scheme (file)', 'file:///etc/passwd', 'https://app.example', false],
    ['non-http scheme (mailto)', 'mailto:someone@example.com', 'https://app.example', false],
    ['non-http scheme (javascript)', 'javascript:alert(1)', 'https://app.example', false],
    ['unparsable input', 'not a url', 'https://app.example', false],
    ['empty input', '', 'https://app.example', false],
  ])('emitted isExternalHttpUrl: %s', (_label, url, origin, expected) => {
    expect(isExternalHttpUrl(url, origin)).toBe(expected);
  });

  it('the generated project type-checks with `tsc --noEmit` against real Electron 44 types', async () => {
    // The tmp project has no node_modules of its own, so a test-only
    // tsconfig extends the generated one and resolves its `types` entries
    // from stackfold's node_modules:
    //  - `electron`: stackfold's devDependency (types only; no binary is
    //    downloaded), matching the generated project's `^44.4.5` pin.
    //  - `node`: the @types/node that electron itself resolves. Today that
    //    is electron's nested 24.x copy, matching the generated project's
    //    `^24.19.0` pin, not stackfold's own 26.x. The major is asserted
    //    below so a hoisting change can't silently swap in 26.x.
    const electronPkg = requireFromHere.resolve('electron/package.json');
    const nodeTypesPkg = createRequire(electronPkg).resolve('@types/node/package.json');
    const nodeTypesVersion: string = JSON.parse(await readFile(nodeTypesPkg, 'utf8')).version;
    expect(nodeTypesVersion).toMatch(/^24\./);

    const posix = (p: string): string => p.split(sep).join('/');
    const config = join(projectDir, '..', 'tsconfig.typecheck.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: posix(join(projectDir, 'tsconfig.json')),
        compilerOptions: {
          noEmit: true,
          typeRoots: [posix(dirname(dirname(nodeTypesPkg))), posix(dirname(dirname(electronPkg)))],
        },
        include: [posix(join(projectDir, 'src/**/*.ts'))],
      })
    );

    const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');
    const result = await runTsc(tscBin, config);
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  }, 60_000);

  it('the generated typecheck script (tsconfig.typecheck.json) type-checks src/**, tests/** and vitest.config.ts together (N4)', async () => {
    // Exercises the config the generated `npm run typecheck` script actually
    // runs (`tsc --noEmit -p tsconfig.typecheck.json`), emitted at the
    // project root next to tsconfig.json. The fixture project has no
    // node_modules of its own, so this wrapper — like the src-only check
    // above — extends the *emitted* config and resolves `electron`/`node`
    // via stackfold's node_modules, plus a `paths` entry so the emitted
    // vitest.config.ts's `import ... from 'vitest/config'` resolves too.
    const electronPkg = requireFromHere.resolve('electron/package.json');
    const nodeTypesPkg = createRequire(electronPkg).resolve('@types/node/package.json');
    const vitestConfigTypes = join(dirname(requireFromHere.resolve('vitest/package.json')), 'config.d.ts');

    const posix = (p: string): string => p.split(sep).join('/');
    const config = join(root, 'tsconfig.typecheck-script.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: posix(join(projectDir, 'tsconfig.typecheck.json')),
        compilerOptions: {
          typeRoots: [posix(dirname(dirname(nodeTypesPkg))), posix(dirname(dirname(electronPkg)))],
          paths: { 'vitest/config': [posix(vitestConfigTypes)] },
        },
      })
    );

    const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');
    const result = await runTsc(tscBin, config);
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  }, 60_000);
});

const requireFromHere = createRequire(import.meta.url);

function runTsc(tscBin: string, config: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [tscBin, '-p', config, '--pretty', 'false'], (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

describe('electron-ts plugin — end-to-end through the orchestrator (in-memory ports)', () => {
  it('scaffolds the Tier-1 file set through the full Template Method pipeline', async () => {
    const written = new Map<string, string>();
    const commands: string[] = [];

    const result = await runPlugin(plugin, '/work/app', {
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

    expect(result.filesWritten).toEqual(TIER1_PATHS.filter((p) => p !== 'LICENSE'));
    expect(JSON.parse(written.get('/work/app/package.json') ?? '').name).toBe('demo-app');
    expect(commands).toEqual(['/work/app: git init']);
  });
});
