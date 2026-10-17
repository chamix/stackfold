import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElectronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { resolveContext } from '../../src/plugins/electron-ts/templates.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers, QuestionDefinition } from '../../src/core/types.js';

/**
 * electron-ts plugin — Tier-2 optional features (Settings / Skins /
 * About+Help): initial_scaffold.md's "Technical Specification: electron-ts
 * Tier-2 optional features" + its Decisions section (2026-10-04).
 *
 * This file covers only Tier-2-specific behavior. Tier-1 + Cycle B1
 * coverage stays in electron-ts-plugin.test.ts, unchanged.
 */

const FIXED_NOW = new Date(2031, 5, 15);
const plugin = createElectronTsPlugin({ now: () => FIXED_NOW });

const BASE_ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

function question(id: string): QuestionDefinition {
  const q = plugin.questions().find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} not declared`);
  return q;
}

function answersFor(flags: { includeSettings?: boolean; includeSkins?: boolean; includeAboutHelp?: boolean }): Answers {
  return { ...BASE_ANSWERS, ...flags };
}

function fileContent(answers: Answers, path: string): string {
  const entry = plugin.buildBlueprint(answers).files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path} not in blueprint`);
  return entry.content.toString();
}

function filePaths(answers: Answers): string[] {
  return plugin.buildBlueprint(answers).files.map((f) => f.path);
}

/**
 * Tier-1 + Cycle B1 baseline order (electron-ts-plugin.test.ts's own
 * TIER1_PATHS), with `src/main/menu.ts` inserted exactly where Decision 1
 * places it: Tier-1-baseline content now, always emitted, right after
 * `ipc.ts` and before Tier-2's own conditional files and `index.ts`.
 */
const BASELINE_WITH_MENU = [
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
  'src/main/menu.ts',
  'src/main/index.ts',
  'src/preload/api.ts',
  'src/preload/index.ts',
  'src/renderer/index.html',
  'src/renderer/app.css',
  'scripts/build.mjs',
  'electron-builder.yml',
  'playwright.config.ts',
  'tests/e2e/support/fixtures.ts',
  'tests/e2e/support/pollUntilStable.ts',
  'tests/e2e/smoke.spec.ts',
  'tests/unit/pollUntilStable.test.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

/** Expected file set for an arbitrary flag combination, in emission order. */
function expectedFileSet(flags: { includeSettings: boolean; includeSkins: boolean; includeAboutHelp: boolean }): string[] {
  const { includeSettings, includeSkins, includeAboutHelp } = flags;
  const needsAtomic = includeSettings || includeSkins;
  // Per-process tsconfig split is needed whenever any renderer .ts file
  // exists — Skins' own renderer consumer (src/renderer/skins.ts) needs the
  // DOM lib exactly as theme.ts does (spec: skins-renderer-consumer.md).
  const needsRendererSplit = includeSettings || includeSkins;
  const ordered = [
    'package.json',
    'README.md',
    '.gitignore',
    'LICENSE',
    ...(needsRendererSplit
      ? ['tsconfig.base.json', 'tsconfig.main.json', 'tsconfig.renderer.json']
      : ['tsconfig.json']),
    'tsconfig.typecheck.json',
    'vitest.config.ts',
    'src/main/windowConfig.ts',
    'src/main/linkPolicy.ts',
    'src/main/ipc.ts',
    ...(needsAtomic ? ['src/main/atomicWriteFile.ts'] : []),
    ...(includeAboutHelp ? ['src/main/staticWindowShell.ts'] : []),
    ...(includeSettings ? ['src/main/settings.ts', 'src/main/settingsStore.ts'] : []),
    ...(includeSkins ? ['src/main/skins.ts', 'src/main/skinsStore.ts'] : []),
    ...(includeAboutHelp
      ? ['third-party-notices.json', 'help.md', 'src/main/aboutWindow.ts', 'src/main/helpWindow.ts']
      : []),
    'src/main/menu.ts',
    'src/main/index.ts',
    'src/preload/api.ts',
    'src/preload/index.ts',
    'src/renderer/index.html',
    'src/renderer/app.css',
    ...(includeSettings ? ['src/renderer/theme.ts'] : []),
    ...(includeSkins ? ['src/renderer/skins.ts'] : []),
    'scripts/build.mjs',
    'electron-builder.yml',
    'playwright.config.ts',
    'tests/e2e/support/fixtures.ts',
    'tests/e2e/support/pollUntilStable.ts',
    'tests/e2e/smoke.spec.ts',
    'tests/unit/pollUntilStable.test.ts',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
  ];
  return ordered;
}

const ALL_COMBINATIONS = [false, true].flatMap((includeSettings) =>
  [false, true].flatMap((includeSkins) =>
    [false, true].map((includeAboutHelp) => ({ includeSettings, includeSkins, includeAboutHelp }))
  )
);

describe('electron-ts plugin — Tier-2 questions()', () => {
  it('declares includeSettings, includeSkins and includeAboutHelp, each defaulting to false, after author', () => {
    const ids = plugin.questions().map((q) => q.id);
    expect(ids).toEqual(['appName', 'description', 'author', 'includeSettings', 'includeSkins', 'includeAboutHelp']);
  });

  it.each(['includeSettings', 'includeSkins', 'includeAboutHelp'])('%s is an independent confirm question defaulting to false', (id) => {
    const q = question(id);
    expect(q.type).toBe('confirm');
    expect(q.default).toBe(false);
  });
});

describe('electron-ts plugin — Tier-2 resolved context (pure derivation)', () => {
  it('defaults all three flags to false when absent from answers', () => {
    const ctx = resolveContext(BASE_ANSWERS, FIXED_NOW);
    expect(ctx.includeSettings).toBe(false);
    expect(ctx.includeSkins).toBe(false);
    expect(ctx.includeAboutHelp).toBe(false);
  });

  it('derives each flag independently from answers', () => {
    const ctx = resolveContext({ ...BASE_ANSWERS, includeSettings: true, includeAboutHelp: true }, FIXED_NOW);
    expect(ctx.includeSettings).toBe(true);
    expect(ctx.includeSkins).toBe(false);
    expect(ctx.includeAboutHelp).toBe(true);
  });

  it('no includeTheme field exists on the resolved context (Decision 1)', () => {
    const ctx = resolveContext(BASE_ANSWERS, FIXED_NOW);
    expect(ctx).not.toHaveProperty('includeTheme');
  });
});

describe('electron-ts plugin — all-flags-false baseline (Decision 1, amended guardrail)', () => {
  it('is identical to the Tier-1 file set except for the addition of src/main/menu.ts', () => {
    expect(filePaths(BASE_ANSWERS)).toEqual(BASELINE_WITH_MENU);
  });

  it('menu.ts is File -> Exit only when every Tier-2 flag is false', () => {
    const src = fileContent(BASE_ANSWERS, 'src/main/menu.ts');
    expect(src).toContain("label: 'Exit'");
    expect(src).toContain("role: 'quit'");
    expect(src).not.toContain("label: 'View'");
    expect(src).not.toContain("label: 'Help'");
    expect(src).not.toContain('getSettings');
    expect(src).not.toContain('getSkins');
    expect(src).not.toContain('openAboutWindow');
    expect(src).not.toContain('openHelpWindow');
  });

  it('src/main/index.ts unconditionally wires the application menu', () => {
    const src = fileContent(BASE_ANSWERS, 'src/main/index.ts');
    expect(src).toContain("import { buildMenuTemplate } from './menu.js';");
    expect(src).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));');
  });

  it('preload api.ts and index.ts render byte-identical to Tier-1 baseline (literal guardrail)', () => {
    const api = fileContent(BASE_ANSWERS, 'src/preload/api.ts');
    const index = fileContent(BASE_ANSWERS, 'src/preload/index.ts');
    expect(api).toContain('export const IPC_CHANNELS = {} as const satisfies Record<string, string>;');
    expect(api).toContain('export interface BridgeApi {}');
    expect(index).toContain('const api: BridgeApi = {};');
    expect(index).not.toContain('ipcRenderer');
  });

  it('package.json has no dependencies key (no zod) when neither Settings nor Skins is selected', () => {
    const pkg = JSON.parse(fileContent(BASE_ANSWERS, 'package.json'));
    expect(pkg).not.toHaveProperty('dependencies');
  });
});

describe('electron-ts plugin — content invariants across all 8 flag combinations', () => {
  it.each(ALL_COMBINATIONS)('exact file set for %j', (flags) => {
    const answers = answersFor(flags);
    expect(filePaths(answers)).toEqual(expectedFileSet(flags));
  });

  it.each(ALL_COMBINATIONS)('dependencies.zod presence for %j', (flags) => {
    const answers = answersFor(flags);
    const pkg = JSON.parse(fileContent(answers, 'package.json'));
    if (flags.includeSettings || flags.includeSkins) {
      expect(pkg.dependencies).toEqual({ zod: '^4.6.5' });
    } else {
      expect(pkg).not.toHaveProperty('dependencies');
    }
  });

  it.each(ALL_COMBINATIONS)('top-level menu sections for %j', (flags) => {
    const answers = answersFor(flags);
    const src = fileContent(answers, 'src/main/menu.ts');
    // File is always present.
    expect(src).toContain("label: 'File'");
    if (flags.includeSettings || flags.includeSkins) {
      expect(src).toContain("label: 'View'");
    } else {
      expect(src).not.toContain("label: 'View'");
    }
    if (flags.includeAboutHelp) {
      expect(src).toContain("const helpItems: MenuItemConstructorOptions[] = [");
    } else {
      expect(src).not.toContain('helpItems');
    }
  });

  it.each(ALL_COMBINATIONS)('no disabled-but-present menu item or dead IPC channel for %j (guardrail 2)', (flags) => {
    const answers = answersFor(flags);
    const menu = fileContent(answers, 'src/main/menu.ts');
    if (!flags.includeSettings) {
      expect(menu).not.toContain('getSettings');
      expect(menu).not.toContain('setSettings');
    }
    if (!flags.includeSkins) {
      expect(menu).not.toContain('getSkins');
      expect(menu).not.toContain('buildSkinSubmenu');
    }
    if (!flags.includeAboutHelp) {
      expect(menu).not.toContain('openAboutWindow');
      expect(menu).not.toContain('openHelpWindow');
    }

    const api = fileContent(answers, 'src/preload/api.ts');
    if (!flags.includeSettings) expect(api).not.toContain('settings');
    if (!flags.includeSkins) expect(api).not.toContain('skins');
  });

  it.each(ALL_COMBINATIONS)('independent composability: Skins never assumes settings.json exists, and vice versa (guardrail 4) for %j', (flags) => {
    const answers = answersFor(flags);
    const paths = filePaths(answers);
    if (flags.includeSkins && !flags.includeSettings) {
      expect(paths).not.toContain('src/main/settings.ts');
      expect(paths).not.toContain('src/main/settingsStore.ts');
    }
    if (flags.includeSettings && !flags.includeSkins) {
      expect(paths).not.toContain('src/main/skins.ts');
      expect(paths).not.toContain('src/main/skinsStore.ts');
    }
  });

  it.each(ALL_COMBINATIONS)(
    'renderer index.html has the theme <script> tag iff includeSettings, for %j',
    (flags) => {
      const answers = answersFor(flags);
      const html = fileContent(answers, 'src/renderer/index.html');
      if (flags.includeSettings) {
        expect(html).toContain('<script type="module" src="./theme.js"></script>');
      } else {
        expect(html).not.toContain('./theme.js');
      }
    }
  );

  it.each(ALL_COMBINATIONS)(
    'renderer index.html has the skins <script> tag iff includeSkins, for %j',
    (flags) => {
      const answers = answersFor(flags);
      const html = fileContent(answers, 'src/renderer/index.html');
      if (flags.includeSkins) {
        expect(html).toContain('<script type="module" src="./skins.js"></script>');
      } else {
        expect(html).not.toContain('./skins.js');
      }
    }
  );

  it.each(ALL_COMBINATIONS.filter((f) => !f.includeSettings && !f.includeSkins))(
    'renderer index.html has no <script> tag at all when neither Settings nor Skins is selected, for %j',
    (flags) => {
      const answers = answersFor(flags);
      const html = fileContent(answers, 'src/renderer/index.html');
      expect(html).not.toContain('<script');
    }
  );

  it.each(ALL_COMBINATIONS)(
    'renderer app.css has the .theme-dark rule iff includeSettings, for %j',
    (flags) => {
      const answers = answersFor(flags);
      const css = fileContent(answers, 'src/renderer/app.css');
      if (flags.includeSettings) {
        expect(css).toContain('.theme-dark');
      } else {
        expect(css).not.toContain('theme-dark');
      }
    }
  );

  it.each(ALL_COMBINATIONS.filter((f) => f.includeSettings))(
    'src/renderer/theme.ts consumes the bridge, never ipcRenderer/require directly, for %j (guardrail §3.4)',
    (flags) => {
      const answers = answersFor(flags);
      const theme = fileContent(answers, 'src/renderer/theme.ts');
      expect(theme).toContain('.settings.get()');
      expect(theme).toContain('.settings.onChange(');
      expect(theme).not.toContain('ipcRenderer');
      expect(theme).not.toContain('require(');
    }
  );

  it.each(ALL_COMBINATIONS.filter((f) => f.includeSkins))(
    'src/renderer/skins.ts consumes the bridge, never ipcRenderer/require directly, for %j (guardrail §3.4)',
    (flags) => {
      const answers = answersFor(flags);
      const skins = fileContent(answers, 'src/renderer/skins.ts');
      expect(skins).toContain('.skins.list()');
      expect(skins).toContain('.skins.getActive()');
      expect(skins).toContain('.skins.onChange(');
      expect(skins).toContain("getElementById('skin')");
      expect(skins).not.toContain('ipcRenderer');
      expect(skins).not.toContain('require(');
    }
  );

  it('skinsStore.ts setActiveSkinName() body notifies listeners, same as setSkins()/rereadSkinsOnFocus() (spec: skins-renderer-consumer.md)', () => {
    const src = fileContent({ ...BASE_ANSWERS, includeSkins: true }, 'src/main/skinsStore.ts');
    const match = src.match(/export function setActiveSkinName\(name: string\): void \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('listeners.forEach((listener) => listener(current.skins));');
  });

  it('tsconfig.renderer.json declares DOM lib and tsconfig.main.json does not, for an includeSettings: true combination', () => {
    const answers = answersFor({ includeSettings: true, includeSkins: false, includeAboutHelp: false });
    const rendererConfig = fileContent(answers, 'tsconfig.renderer.json');
    const mainConfig = fileContent(answers, 'tsconfig.main.json');
    expect(rendererConfig).toContain('DOM');
    expect(mainConfig).not.toContain('DOM');
  });

  it.each(ALL_COMBINATIONS.filter((f) => f.includeSettings || f.includeSkins))(
    'tsconfig.renderer.json overrides module/moduleResolution to emit real browser ESM, independent of package.json "type" (%j) (review_report.md §5 fix)',
    (flags) => {
      const answers = answersFor(flags);
      const rendererConfig = JSON.parse(fileContent(answers, 'tsconfig.renderer.json'));
      // `tsconfig.base.json` sets module/moduleResolution to NodeNext, which
      // ties *emitted* format to package.json's "type" field (absent in the
      // generated project) — that would emit CommonJS for a file loaded via
      // `<script type="module">`, throwing `ReferenceError: exports is not
      // defined in ES module scope` at real app launch. The renderer config
      // must override both fields so emission is real ESM regardless of
      // package.json's "type" field.
      expect(rendererConfig.compilerOptions.module).toBe('ES2022');
      expect(rendererConfig.compilerOptions.moduleResolution).toBe('bundler');

      const mainConfig = JSON.parse(fileContent(answers, 'tsconfig.main.json'));
      const baseConfig = JSON.parse(fileContent(answers, 'tsconfig.base.json'));
      // main/preload must keep the inherited NodeNext pairing untouched —
      // preload still needs esbuild's CJS bundle under sandbox: true.
      expect(mainConfig.compilerOptions.module).toBeUndefined();
      expect(mainConfig.compilerOptions.moduleResolution).toBeUndefined();
      expect(baseConfig.compilerOptions.module).toBe('NodeNext');
      expect(baseConfig.compilerOptions.moduleResolution).toBe('NodeNext');
    }
  );

  it('no branding leakage in any Tier-2 file, across all combinations (guardrail 3)', () => {
    for (const flags of ALL_COMBINATIONS) {
      for (const { content } of plugin.buildBlueprint(answersFor(flags)).files) {
        const text = content.toString().toLowerCase();
        for (const leak of ['stackfold', 'md-view', '.agents', 'run_log', 'backlog.md']) {
          expect(text).not.toContain(leak);
        }
      }
    }
  });
});

describe('electron-ts plugin — main/index.ts wires the trust registry at window create/close (S4)', () => {
  it.each(ALL_COMBINATIONS)('trustWebContents/untrustWebContents call-site wiring for %j', (flags) => {
    const answers = answersFor(flags);
    const src = fileContent(answers, 'src/main/index.ts');
    const needsTrustedSenderRegistry = flags.includeSettings || flags.includeSkins;

    if (needsTrustedSenderRegistry) {
      expect(src).toContain("import { trustWebContents, untrustWebContents } from './ipc.js';");
      // Must capture webContents.id, not BaseWindow's own id — isTrustedSender
      // compares event.sender.id (a WebContents id) against this registry.
      expect(src).toContain('const windowId = window.webContents.id;');

      const newWindowIndex = src.indexOf('new BrowserWindow');
      const trustIndex = src.indexOf('trustWebContents(windowId);');
      const closedIndex = src.indexOf("window.on('closed'");
      const untrustIndex = src.indexOf('untrustWebContents(windowId);');

      expect(newWindowIndex).toBeGreaterThan(-1);
      expect(trustIndex).toBeGreaterThan(newWindowIndex);
      expect(closedIndex).toBeGreaterThan(trustIndex);
      expect(untrustIndex).toBeGreaterThan(closedIndex);

      // untrustWebContents must live inside the 'closed' handler body, not
      // merely somewhere later in the file: it must precede that handler's
      // own closing `});`.
      const closedHandlerEnd = src.indexOf('});', closedIndex);
      expect(closedHandlerEnd).toBeGreaterThan(-1);
      expect(untrustIndex).toBeLessThan(closedHandlerEnd);
    } else {
      expect(src).not.toContain('trustWebContents');
      expect(src).not.toContain('untrustWebContents');
      expect(src).not.toContain("'./ipc.js'");
    }
  });
});

describe('electron-ts plugin — main/index.ts closes About/Help windows when main window closes (lifecycle fix)', () => {
  it.each(ALL_COMBINATIONS)('closeAboutWindow/closeHelpWindow call-site wiring for %j', (flags) => {
    const answers = answersFor(flags);
    const src = fileContent(answers, 'src/main/index.ts');

    if (flags.includeAboutHelp) {
      expect(src).toContain("import { closeAboutWindow } from './aboutWindow.js';");
      expect(src).toContain("import { closeHelpWindow } from './helpWindow.js';");

      const closedIndex = src.indexOf("window.on('closed'");
      const closeAboutIndex = src.indexOf('closeAboutWindow();');
      const closeHelpIndex = src.indexOf('closeHelpWindow();');

      expect(closedIndex).toBeGreaterThan(-1);
      expect(closeAboutIndex).toBeGreaterThan(closedIndex);
      expect(closeHelpIndex).toBeGreaterThan(closedIndex);

      // Both calls must live inside the 'closed' handler body, not merely
      // somewhere later in the file: they must precede that handler's own
      // closing `});` (same pattern asserted for untrustWebContents, S4).
      const closedHandlerEnd = src.indexOf('});', closedIndex);
      expect(closedHandlerEnd).toBeGreaterThan(-1);
      expect(closeAboutIndex).toBeLessThan(closedHandlerEnd);
      expect(closeHelpIndex).toBeLessThan(closedHandlerEnd);
    } else {
      expect(src).not.toContain('closeAboutWindow');
      expect(src).not.toContain('closeHelpWindow');
    }
  });
});

describe('electron-ts plugin — aboutWindow.ts/helpWindow.ts export a close function (lifecycle fix)', () => {
  it.each(['src/main/aboutWindow.ts', 'src/main/helpWindow.ts'])('%s exports a close function, a safe no-op when not open', (path) => {
    const src = fileContent({ ...BASE_ANSWERS, includeAboutHelp: true }, path);
    const exportName = path.includes('about') ? 'closeAboutWindow' : 'closeHelpWindow';
    expect(src).toContain(`export function ${exportName}`);
  });
});

describe('electron-ts plugin — About window omits Author row with no author (guardrail 4)', () => {
  it('aboutWindow.ts reuses the same optional-author pattern as LICENSE/hasAuthor', () => {
    const src = fileContent({ ...BASE_ANSWERS, author: '', includeAboutHelp: true }, 'src/main/aboutWindow.ts');
    expect(src).toContain('pkg.author ?');
  });
});

describe('electron-ts plugin — static-window CSP (About/Help)', () => {
  it.each(['src/main/aboutWindow.ts', 'src/main/helpWindow.ts'])('%s builds its CSP from the same STYLE_CSS it ships inline', (path) => {
    const src = fileContent({ ...BASE_ANSWERS, includeAboutHelp: true }, path);
    expect(src).toContain('buildStaticWindowCsp(STYLE_CSS)');
    expect(src).toContain('<style>${STYLE_CSS}</style>');
  });

  it.each(['src/main/aboutWindow.ts', 'src/main/helpWindow.ts'])('%s calls window.setMenu(null) so it does not inherit the main app menu', (path) => {
    const src = fileContent({ ...BASE_ANSWERS, includeAboutHelp: true }, path);
    expect(src).toContain('window.setMenu(null)');
  });

  it('staticWindowShell.ts pins style-src to a SHA-256 hash and sets script-src/base-uri/form-action to none', () => {
    const src = fileContent({ ...BASE_ANSWERS, includeAboutHelp: true }, 'src/main/staticWindowShell.ts');
    expect(src).toContain("createHash('sha256')");
    expect(src).toContain("style-src 'sha256-");
    expect(src).toContain("script-src 'none'");
    expect(src).toContain("base-uri 'none'");
    expect(src).toContain("form-action 'none'");
    expect(src).toContain('http-equiv="Content-Security-Policy"');
  });

  it('windowConfig.ts staticWindowOptions() has no preload key (no bridge for About/Help)', () => {
    const src = fileContent({ ...BASE_ANSWERS, includeAboutHelp: true }, 'src/main/windowConfig.ts');
    const fn = src.slice(src.indexOf('export function staticWindowOptions'));
    expect(fn).not.toContain('preload:');
    expect(fn).toContain('contextIsolation: true');
    expect(fn).toContain('nodeIntegration: false');
    expect(fn).toContain('sandbox: true');
    expect(fn).toContain('resizable: false');
    expect(fn).toContain('minimizable: false');
    expect(fn).toContain('maximizable: false');
    expect(fn).toContain('fullscreenable: false');
  });

  it('windowConfig.ts omits staticWindowOptions() entirely when includeAboutHelp is false', () => {
    const src = fileContent(BASE_ANSWERS, 'src/main/windowConfig.ts');
    expect(src).not.toContain('staticWindowOptions');
  });
});

describe('electron-ts plugin — no free-text answer ever interpolated into generated TypeScript (Tier-2 files)', () => {
  it('Settings/Skins/AboutHelp templates never embed free-text answers verbatim', () => {
    const answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
      includeSettings: true,
      includeSkins: true,
      includeAboutHelp: true,
    };
    for (const { path, content } of plugin.buildBlueprint(answers).files) {
      if (!path.endsWith('.ts')) continue;
      const text = content.toString();
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('child_process');
    }
  });
});

describe('electron-ts plugin — Tier-2 generation integrity (real emitted code)', () => {
  const requireFromHere = createRequire(import.meta.url);

  function runTsc(tscBin: string, config: string): Promise<{ code: number; output: string }> {
    return new Promise((resolvePromise) => {
      execFile(process.execPath, [tscBin, '-p', config, '--pretty', 'false'], (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
      });
    });
  }

  async function typecheckCombination(flags: {
    includeSettings: boolean;
    includeSkins: boolean;
    includeAboutHelp: boolean;
  }): Promise<{ code: number; output: string }> {
    const root = await mkdtemp(join(tmpdir(), 'stackfold-electron-ts-tier2-'));
    try {
      const projectDir = join(root, 'generated');
      const writer = new NodeFileWriter();
      await writer.ensureEmptyDir(projectDir);
      for (const file of plugin.buildBlueprint(answersFor(flags)).files) {
        await writer.writeFile(join(projectDir, file.path), file.content);
      }

      const electronPkg = requireFromHere.resolve('electron/package.json');
      const nodeTypesPkg = createRequire(electronPkg).resolve('@types/node/package.json');
      const zodPkg = requireFromHere.resolve('zod/package.json');

      const posix = (p: string): string => p.split(sep).join('/');
      const config = join(root, 'tsconfig.typecheck.json');
      await writeFile(
        config,
        JSON.stringify({
          // `tsconfig.typecheck.json` always exists (both the single-shared-
          // config and per-process-split branches), unlike `tsconfig.json`
          // which is only emitted when `includeSettings` is false — see
          // initial_scaffold.md "Revised plan for Open Decision 1".
          extends: posix(join(projectDir, 'tsconfig.typecheck.json')),
          compilerOptions: {
            noEmit: true,
            typeRoots: [posix(dirname(dirname(nodeTypesPkg))), posix(dirname(dirname(electronPkg)))],
            paths: { zod: [posix(dirname(zodPkg))] },
          },
          include: [posix(join(projectDir, 'src/**/*.ts'))],
        })
      );

      const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');
      return await runTsc(tscBin, config);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Sampled, not exhaustive (initial_scaffold.md Tier-2 spec, test strategy
  // item 4): all-false, all-true, and each single-flag-alone — 5 of 8.
  it.each([
    { includeSettings: false, includeSkins: false, includeAboutHelp: false },
    { includeSettings: true, includeSkins: true, includeAboutHelp: true },
    { includeSettings: true, includeSkins: false, includeAboutHelp: false },
    { includeSettings: false, includeSkins: true, includeAboutHelp: false },
    { includeSettings: false, includeSkins: false, includeAboutHelp: true },
  ])('type-checks cleanly for %j', async (flags) => {
    const result = await typecheckCombination(flags);
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  }, 60_000);
});

describe('electron-ts plugin — self-healing persisted-file behavior (real emitted code)', () => {
  const requireFromHere = createRequire(import.meta.url);
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'stackfold-tier2-selfheal-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function emitModule(relDir: string, files: Record<string, string>, userDataDir: string) {
    const dir = join(workDir, relDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const electronStubDir = join(dir, 'node_modules', 'electron');
    await mkdir(electronStubDir, { recursive: true });
    await writeFile(
      join(electronStubDir, 'package.json'),
      JSON.stringify({ name: 'electron', version: '0.0.0-stub', type: 'module', main: 'index.mjs' })
    );
    await writeFile(
      join(electronStubDir, 'index.mjs'),
      [
        'export const handleCalls = [];',
        'export const ipcMain = { handle(channel, cb) { handleCalls.push({ channel, cb }); } };',
        `export const app = { getPath: () => ${JSON.stringify(userDataDir)} };`,
        '',
      ].join('\n')
    );

    for (const [name, content] of Object.entries(files)) {
      const source = content;
      const { outputText, diagnostics } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
        reportDiagnostics: true,
        fileName: name,
      });
      expect(diagnostics ?? []).toEqual([]);
      await writeFile(join(dir, name.replace(/\.ts$/, '.js')), outputText);
    }

    return dir;
  }

  describe('settingsStore.ts', () => {
    let dir: string;
    let userDataDir: string;

    beforeAll(async () => {
      userDataDir = join(workDir, 'settings-userdata');
      await mkdir(userDataDir, { recursive: true });
      const ctx = resolveContext({ ...BASE_ANSWERS, includeSettings: true }, FIXED_NOW);
      const settingsTs = fileContent({ ...BASE_ANSWERS, includeSettings: true }, 'src/main/settings.ts');
      const atomicTs = fileContent({ ...BASE_ANSWERS, includeSettings: true }, 'src/main/atomicWriteFile.ts');
      const ipcTs = fileContent({ ...BASE_ANSWERS, includeSettings: true }, 'src/main/ipc.ts');
      const storeTs = fileContent({ ...BASE_ANSWERS, includeSettings: true }, 'src/main/settingsStore.ts');
      void ctx;
      dir = await emitModule(
        'settings',
        {
          'settings.ts': settingsTs,
          'atomicWriteFile.ts': atomicTs,
          'ipc.ts': ipcTs,
          'settingsStore.ts': storeTs,
        },
        userDataDir
      );
    });

    afterEach(async () => {
      await rm(join(userDataDir, 'settings.json'), { force: true });
    });

    it('missing file: loadSettingsAtStartup keeps in-memory defaults and writes nothing', async () => {
      const mod = await import(pathToFileURL(join(dir, 'settingsStore.js')).href);
      await mod.loadSettingsAtStartup();
      expect(mod.getSettings()).toEqual({ darkMode: false });
      await expect(stat(join(userDataDir, 'settings.json'))).rejects.toThrow();
    });

    it('corrupt file: self-heals to defaults with no backup', async () => {
      await writeFile(join(userDataDir, 'settings.json'), '{ not valid json');
      const mod = await import(pathToFileURL(join(dir, 'settingsStore.js')).href + '?corrupt=1');
      await mod.loadSettingsAtStartup();
      expect(mod.getSettings()).toEqual({ darkMode: false });
      await expect(stat(join(userDataDir, 'settings.json.bak'))).rejects.toThrow();
    });

    it('setSettings validates, atomic-writes, and a subsequent load reads it back', async () => {
      const mod = await import(pathToFileURL(join(dir, 'settingsStore.js')).href + '?write=1');
      await mod.setSettings({ darkMode: true });
      const written = JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8'));
      expect(written.darkMode).toBe(true);
    });

    it('a failed reread never mutates current state', async () => {
      const mod = await import(pathToFileURL(join(dir, 'settingsStore.js')).href + '?reread=1');
      await mod.loadSettingsAtStartup();
      const before = mod.getSettings();
      await rm(join(userDataDir, 'settings.json'), { force: true });
      await writeFile(join(userDataDir, 'settings.json'), 'not json at all {{{');
      await mod.rereadSettingsOnFocus();
      expect(mod.getSettings()).toEqual(before);
    });

    it('registerSettingsIpcHandlers rejects an untrusted sender and allows a trusted one (settings:get)', async () => {
      const { handleCalls } = await import(pathToFileURL(join(dir, 'node_modules', 'electron', 'index.mjs')).href);
      const ipcMod = await import(pathToFileURL(join(dir, 'ipc.js')).href);
      const mod = await import(pathToFileURL(join(dir, 'settingsStore.js')).href + '?sender=1');
      mod.registerSettingsIpcHandlers();

      const registration = handleCalls.find((call: { channel: string }) => call.channel === 'my-cool-app:settings:get');
      expect(registration).toBeDefined();

      const untrustedEvent = { sender: { id: 9001 } };
      expect(() => registration.cb(untrustedEvent)).toThrow(/untrusted sender/);

      ipcMod.trustWebContents(9002);
      const trustedEvent = { sender: { id: 9002 } };
      expect(registration.cb(trustedEvent)).toEqual({ darkMode: false });
    });
  });

  describe('skinsStore.ts', () => {
    let dir: string;
    let userDataDir: string;

    beforeAll(async () => {
      userDataDir = join(workDir, 'skins-userdata');
      await mkdir(userDataDir, { recursive: true });
      dir = await emitModule(
        'skins',
        {
          'skins.ts': fileContent({ ...BASE_ANSWERS, includeSkins: true }, 'src/main/skins.ts'),
          'atomicWriteFile.ts': fileContent({ ...BASE_ANSWERS, includeSkins: true }, 'src/main/atomicWriteFile.ts'),
          'ipc.ts': fileContent({ ...BASE_ANSWERS, includeSkins: true }, 'src/main/ipc.ts'),
          'skinsStore.ts': fileContent({ ...BASE_ANSWERS, includeSkins: true }, 'src/main/skinsStore.ts'),
        },
        userDataDir
      );
    });

    it('missing file: loadSkinsAtStartup keeps zero-preset defaults and writes nothing', async () => {
      const mod = await import(pathToFileURL(join(dir, 'skinsStore.js')).href);
      await mod.loadSkinsAtStartup();
      expect(mod.getSkins()).toEqual({ skins: [] });
      await expect(stat(join(userDataDir, 'skins.json'))).rejects.toThrow();
    });

    it('corrupt file: backs up to skins.json.bak before self-healing', async () => {
      await writeFile(join(userDataDir, 'skins.json'), '{ not valid json, skins corrupted');
      const mod = await import(pathToFileURL(join(dir, 'skinsStore.js')).href + '?corrupt=1');
      await mod.loadSkinsAtStartup();
      expect(mod.getSkins()).toEqual({ skins: [] });
      const backup = await readFile(join(userDataDir, 'skins.json.bak'), 'utf8');
      expect(backup).toContain('not valid json, skins corrupted');
      await rm(join(userDataDir, 'skins.json'), { force: true });
      await rm(join(userDataDir, 'skins.json.bak'), { force: true });
    });

    it('a failed reread never mutates current state', async () => {
      await rm(join(userDataDir, 'skins.json'), { force: true });
      const mod = await import(pathToFileURL(join(dir, 'skinsStore.js')).href + '?reread=1');
      await mod.loadSkinsAtStartup();
      const before = mod.getSkins();
      await writeFile(join(userDataDir, 'skins.json'), 'not json {{{');
      await mod.rereadSkinsOnFocus();
      expect(mod.getSkins()).toEqual(before);
      await rm(join(userDataDir, 'skins.json'), { force: true });
    });

    it('setActiveSkinName() notifies listeners, not just setSkins()/rereadSkinsOnFocus() (spec: skins-renderer-consumer.md)', async () => {
      const mod = await import(pathToFileURL(join(dir, 'skinsStore.js')).href + '?activename=1');
      await mod.setSkins([{ name: 'dark', css: 'body { color: red; }' }]);
      const seen: unknown[] = [];
      const unsubscribe = mod.onSkinsChange((skins: unknown) => seen.push(skins));
      mod.setActiveSkinName('dark');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([{ name: 'dark', css: 'body { color: red; }' }]);
      unsubscribe();
    });

    it('registerSkinsIpcHandlers rejects an untrusted sender and allows a trusted one (skins:list)', async () => {
      const { handleCalls } = await import(pathToFileURL(join(dir, 'node_modules', 'electron', 'index.mjs')).href);
      const ipcMod = await import(pathToFileURL(join(dir, 'ipc.js')).href);
      const mod = await import(pathToFileURL(join(dir, 'skinsStore.js')).href + '?sender=1');
      mod.registerSkinsIpcHandlers();

      const registration = handleCalls.find((call: { channel: string }) => call.channel === 'my-cool-app:skins:list');
      expect(registration).toBeDefined();

      const untrustedEvent = { sender: { id: 9101 } };
      expect(() => registration.cb(untrustedEvent)).toThrow(/untrusted sender/);

      ipcMod.trustWebContents(9102);
      const trustedEvent = { sender: { id: 9102 } };
      expect(registration.cb(trustedEvent)).toEqual([]);
    });
  });
});

const RUN_NETWORK_TESTS = process.env['STACKFOLD_RUN_NETWORK_TESTS'] === '1';
if (!RUN_NETWORK_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'electron-ts plugin Tier-2 — build integrity: skipped — set STACKFOLD_RUN_NETWORK_TESTS=1 to run the real `npm install` + `npm run build` check for the all-true combination.'
  );
}

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : ['npm', args];
  return new Promise((resolvePromise) => {
    execFile(cmd, cmdArgs, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

describe.skipIf(!RUN_NETWORK_TESTS)('electron-ts plugin Tier-2 — build integrity (all-true, real npm install + build)', () => {
  it(
    'npm install + npm run build resolves zod and produces dist/main/index.js, dist/preload/index.js and dist/renderer/index.html',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-electron-ts-tier2-build-'));
      try {
        const projectDir = join(root, 'generated');
        const writer = new NodeFileWriter();
        await writer.ensureEmptyDir(projectDir);
        const answers = answersFor({ includeSettings: true, includeSkins: true, includeAboutHelp: true });
        for (const file of plugin.buildBlueprint(answers).files) {
          await writer.writeFile(join(projectDir, file.path), file.content);
        }

        const install = await execNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], projectDir, 8 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 2 * 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        for (const relPath of ['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html']) {
          const info = await stat(join(projectDir, relPath));
          expect(info.isFile(), `expected ${relPath} to exist after build`).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    10 * 60_000
  );
});
