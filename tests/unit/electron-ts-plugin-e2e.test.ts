import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElectronTsPlugin } from '../../src/plugins/electron-ts/index.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import type { Answers } from '../../src/core/types.js';

/**
 * electron-ts plugin — Cycle B2 (e2e harness + CI workflows + tier-5 launch
 * test): initial_scaffold.md's "Technical Specification: electron-ts e2e
 * harness + CI (Cycle B2)" (approved 2026-10-09).
 *
 * Tier-1/B1/Tier-2 coverage stays in the other two test files; this file
 * holds only B2-specific assertions, kept separate so the other two don't
 * keep growing (Cycle B2 spec, "Stackfold-side changes").
 */

const FIXED_NOW = new Date(2031, 5, 15);
const plugin = createElectronTsPlugin({ now: () => FIXED_NOW });

const BASE_ANSWERS: Answers = { appName: 'My Cool App!', description: 'A demo app', author: 'Ada Lovelace' };

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

const ALL_COMBINATIONS = [false, true].flatMap((includeSettings) =>
  [false, true].flatMap((includeSkins) =>
    [false, true].map((includeAboutHelp) => ({ includeSettings, includeSkins, includeAboutHelp }))
  )
);

/** The 7 new Cycle B2 files, in their declared emission order. */
const NEW_B2_PATHS = [
  'playwright.config.ts',
  'tests/e2e/support/fixtures.ts',
  'tests/e2e/support/pollUntilStable.ts',
  'tests/e2e/smoke.spec.ts',
  'tests/unit/pollUntilStable.test.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

describe('electron-ts plugin — B2 file set (tier 2: content invariants)', () => {
  it.each(ALL_COMBINATIONS)('all 7 new B2 files are unconditional, for %j', (flags) => {
    const paths = filePaths(answersFor(flags));
    for (const p of NEW_B2_PATHS) expect(paths).toContain(p);
  });

  it('B2 files are emitted at the end of the file set, in their declared order', () => {
    const paths = filePaths(BASE_ANSWERS);
    const tail = paths.slice(paths.length - NEW_B2_PATHS.length);
    expect(tail).toEqual(NEW_B2_PATHS);
  });
});

describe('electron-ts plugin — playwright.config.ts', () => {
  it('sets testDir, testMatch and the Windows worker-count mitigation', () => {
    const src = fileContent(BASE_ANSWERS, 'playwright.config.ts');
    expect(src).toContain("import { defineConfig } from '@playwright/test';");
    expect(src).toContain("testDir: './tests/e2e'");
    expect(src).toContain("testMatch: '**/*.spec.ts'");
    expect(src).toContain('workers: 2');
  });
});

describe('electron-ts plugin — tests/e2e/support/fixtures.ts', () => {
  it('passes --user-data-dir explicitly (electron.launch never forwards a userDataDir option)', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain('--user-data-dir=${userDataDir}');
    expect(src).toContain('args: [');
    expect(src).toContain("'.'");
  });

  it('strips ELECTRON_RUN_AS_NODE from the launched env', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain("key !== 'ELECTRON_RUN_AS_NODE'");
  });

  it('fails early with a clear message when dist/main/index.js is missing', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain('dist/main/index.js');
    expect(src).toMatch(/run `npm run build` first/);
  });

  it('always closes the Electron app and removes the temp user-data dir', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain('app.close()');
    expect(src).toContain('rmSync(');
  });

  it('waits for domcontentloaded rather than a fixed sleep (L2)', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain("waitForLoadState('domcontentloaded')");
    expect(src).not.toMatch(/setTimeout|sleep\(/);
  });

  it('REPO_ROOT is derived via __dirname, not the generated package.json\'s "type" field (CJS transform)', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/fixtures.ts');
    expect(src).toContain("join(__dirname, '../../..')");
  });
});

describe('electron-ts plugin — tests/e2e/support/pollUntilStable.ts (L3: pure leaf, not dead code)', () => {
  it('polls by consecutive-match count against a deadline, not a fixed sleep count', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/support/pollUntilStable.ts');
    expect(src).toContain('export async function pollUntilStable');
    expect(src).toContain('stableCount');
    expect(src).toContain('timeoutMs');
    expect(src).toContain('Object.is(');
  });
});

describe('electron-ts plugin — tests/e2e/smoke.spec.ts (§3.8 launch check)', () => {
  it.each(ALL_COMBINATIONS)('expected bridge key list matches the selected flags, for %j', (flags) => {
    const src = fileContent(answersFor(flags), 'tests/e2e/smoke.spec.ts');
    const expectedKeys = [...(flags.includeSettings ? ['settings'] : []), ...(flags.includeSkins ? ['skins'] : [])].sort();
    expect(src).toContain(`const EXPECTED_BRIDGE_KEYS: string[] = ${JSON.stringify(expectedKeys)};`);
  });

  it('derives BRIDGE_GLOBAL from the resolved context, never a free-text answer (L5)', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/smoke.spec.ts');
    expect(src).toContain('const BRIDGE_GLOBAL = "myCoolAppApi";');
  });

  it('has exactly 4 tests: launch+render, isolation, bridge surface, menu installed', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/smoke.spec.ts');
    expect(src.match(/\btest\(/g)).toHaveLength(4);
    expect(src).toContain('renders the placeholder');
    expect(src).toContain('isolated from Node');
    expect(src).toContain('only the declared surface');
    expect(src).toContain('menu is installed');
  });

  it('checks typeof require/process/module are undefined, not merely absent-looking', () => {
    const src = fileContent(BASE_ANSWERS, 'tests/e2e/smoke.spec.ts');
    expect(src).toContain("hasRequire: typeof");
    expect(src).toContain("hasProcess: typeof");
    expect(src).toContain("hasModule: typeof");
    expect(src).toContain("toBe('undefined')");
  });
});

describe('electron-ts plugin — .github/workflows (L6: least privilege, no secrets)', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/release.yml'])(
    '%s declares contents:read permissions and never references a secret',
    (path) => {
      const yml = fileContent(BASE_ANSWERS, path);
      expect(yml).toContain('permissions:');
      expect(yml).toContain('contents: read');
      expect(yml).not.toContain('secrets.');
      expect(yml).not.toContain('GH_TOKEN');
    }
  );

  it.each(['.github/workflows/ci.yml', '.github/workflows/release.yml'])(
    '%s pins first-party actions to a major tag, not the stale v4',
    (path) => {
      const yml = fileContent(BASE_ANSWERS, path);
      for (const action of ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/upload-artifact@v7']) {
        expect(yml).toContain(action);
      }
      expect(yml).not.toMatch(/actions\/(checkout|setup-node|upload-artifact)@v4\b/);
    }
  );

  it('ci.yml verifies every PR against main, on windows-latest, through typecheck/build/test/test:e2e', () => {
    const yml = fileContent(BASE_ANSWERS, '.github/workflows/ci.yml');
    expect(yml).toContain('pull_request:');
    expect(yml).toContain('branches: [main]');
    expect(yml).toContain('windows-latest');
    expect(yml).toContain('npm ci');
    expect(yml).toContain('cache: npm');
    expect(yml).toContain("node-version: 24");
    expect(yml).toContain('npm run typecheck');
    expect(yml).toContain('npm run build');
    expect(yml).toContain('npm test');
    expect(yml).toContain('npm run test:e2e');
    expect(yml).toContain('if: failure()');
    expect(yml).toContain('path: test-results/');
    expect(yml).toContain('if-no-files-found: ignore');
  });

  it('release.yml runs on a v*.*.* tag, packages without publishing, and uploads the installer as an artifact', () => {
    const yml = fileContent(BASE_ANSWERS, '.github/workflows/release.yml');
    expect(yml).toContain("tags: ['v*.*.*']");
    expect(yml).toContain('electron-builder --win --publish never');
    expect(yml).toContain('path: release/*.exe');
    expect(yml).toContain('if-no-files-found: error');
  });
});

describe('electron-ts plugin — package.json / .gitignore / README (B2 additions)', () => {
  it('adds the @playwright/test devDependency and the test:e2e script', () => {
    const pkg = JSON.parse(fileContent(BASE_ANSWERS, 'package.json'));
    expect(pkg.devDependencies['@playwright/test']).toBe('^1.64.0');
    expect(pkg.scripts['test:e2e']).toBe('playwright test');
    expect(pkg.scripts.test).toBe('vitest run');
  });

  it('.gitignore adds release/, test-results/ and playwright-report/', () => {
    const lines = fileContent(BASE_ANSWERS, '.gitignore').split('\n');
    for (const entry of ['release/', 'test-results/', 'playwright-report/']) {
      expect(lines).toContain(entry);
    }
  });

  it('README documents test:e2e, package, the lockfile note and the publish-switch edits', () => {
    const readme = fileContent(BASE_ANSWERS, 'README.md');
    expect(readme).toContain('test:e2e');
    expect(readme).toContain('npm run package');
    expect(readme).toMatch(/package-lock\.json/);
    expect(readme).toContain('publish: null');
    expect(readme).toContain('--publish always');
    expect(readme).toContain('contents: write');
  });
});

describe('electron-ts plugin — branding leakage + L5 hostile input (B2 files)', () => {
  it('no stackfold/md-view string in any of the 7 new files', () => {
    for (const p of NEW_B2_PATHS) {
      const text = fileContent(BASE_ANSWERS, p).toLowerCase();
      expect(text).not.toContain('stackfold');
      expect(text).not.toContain('md-view');
    }
  });

  it('no free-text answer is ever interpolated into a new .ts file (L5)', () => {
    const answers = {
      appName: "Evil'); require('child_process",
      description: 'DESC_MARKER',
      author: 'AUTHOR_MARKER',
    };
    for (const p of NEW_B2_PATHS.filter((path) => path.endsWith('.ts'))) {
      const text = fileContent(answers, p);
      expect(text).not.toContain('DESC_MARKER');
      expect(text).not.toContain('AUTHOR_MARKER');
      expect(text).not.toContain('child_process');
    }
  });
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

async function typecheckCombination(flags: {
  includeSettings: boolean;
  includeSkins: boolean;
  includeAboutHelp: boolean;
}): Promise<{ code: number; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stackfold-electron-ts-b2-'));
  try {
    const projectDir = join(root, 'generated');
    const writer = new NodeFileWriter();
    await writer.ensureEmptyDir(projectDir);
    for (const file of plugin.buildBlueprint(answersFor(flags)).files) {
      await writer.writeFile(join(projectDir, file.path), file.content);
    }

    const electronPkg = requireFromHere.resolve('electron/package.json');
    const nodeTypesPkg = createRequire(electronPkg).resolve('@types/node/package.json');
    const playwrightTestPkg = requireFromHere.resolve('@playwright/test/package.json');
    const vitestConfigTypes = join(dirname(requireFromHere.resolve('vitest/package.json')), 'config.d.ts');
    const needsZod = flags.includeSettings || flags.includeSkins;
    const zodPkg = needsZod ? requireFromHere.resolve('zod/package.json') : undefined;

    const posix = (p: string): string => p.split(sep).join('/');
    const config = join(root, 'tsconfig.typecheck.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: posix(join(projectDir, 'tsconfig.typecheck.json')),
        compilerOptions: {
          typeRoots: [posix(dirname(dirname(nodeTypesPkg))), posix(dirname(dirname(electronPkg)))],
          paths: {
            'vitest/config': [posix(vitestConfigTypes)],
            '@playwright/test': [posix(dirname(playwrightTestPkg))],
            ...(zodPkg ? { zod: [posix(dirname(zodPkg))] } : {}),
          },
        },
        include: [
          posix(join(projectDir, 'src/**/*.ts')),
          posix(join(projectDir, 'tests/**/*.ts')),
          posix(join(projectDir, 'playwright.config.ts')),
        ],
      })
    );

    const tscBin = join(dirname(requireFromHere.resolve('typescript/package.json')), 'bin', 'tsc');
    return await runTsc(tscBin, config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('electron-ts plugin — B2 generation integrity (tier 4: tsc --noEmit over tests/e2e/** too)', () => {
  it.each([
    { includeSettings: false, includeSkins: false, includeAboutHelp: false },
    { includeSettings: true, includeSkins: true, includeAboutHelp: true },
  ])('type-checks cleanly, including tests/e2e/** and playwright.config.ts, for %j', async (flags) => {
    const result = await typecheckCombination(flags);
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  }, 60_000);
});

function execNpm(args: string[], cwd: string, timeout: number): Promise<{ code: number; output: string }> {
  // On Windows `npm` resolves to a `.cmd` shim, which execFile cannot spawn
  // directly (EINVAL). Route through `cmd.exe /c` explicitly (fixed args,
  // no untrusted input) rather than the `shell: true` option, which would
  // concatenate args into an unescaped string.
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : ['npm', args];
  return new Promise((resolvePromise) => {
    execFile(cmd, cmdArgs, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/**
 * Tier 5 (new, Cycle B2 spec "Test strategy" item 5): the real pipeline —
 * generate -> `npm install` (WITHOUT --ignore-scripts: the Electron binary
 * must actually download) -> `npm run build` -> `npm run test:e2e` -> assert
 * exit 0 — for both the all-flags-false and all-flags-true combinations.
 * Needs a real display and real network access, so it is opt-in only.
 */
const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'electron-ts plugin — launch test (tier 5): skipped — set STACKFOLD_RUN_E2E_TESTS=1 to run the real install+build+test:e2e check (needs a display, ~15 min).'
  );
}

describe.skipIf(!RUN_E2E_TESTS)('electron-ts plugin — launch test (tier 5: real install + build + test:e2e)', () => {
  it.each([
    ['all-flags-false', { includeSettings: false, includeSkins: false, includeAboutHelp: false }],
    ['all-flags-true', { includeSettings: true, includeSkins: true, includeAboutHelp: true }],
  ] as const)(
    '%s: npm install + npm run build + npm run test:e2e all succeed, and the generated unit tests (incl. pollUntilStable) pass',
    async (_label, flags) => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-electron-ts-e2e-'));
      try {
        const projectDir = join(root, 'generated');
        const writer = new NodeFileWriter();
        await writer.ensureEmptyDir(projectDir);
        for (const file of plugin.buildBlueprint(answersFor(flags)).files) {
          await writer.writeFile(join(projectDir, file.path), file.content);
        }

        // No --ignore-scripts: the Electron (and Playwright browser/driver)
        // postinstall must actually run so the launch below has a real binary.
        const install = await execNpm(['install', '--no-audit', '--no-fund'], projectDir, 10 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const build = await execNpm(['run', 'build'], projectDir, 2 * 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const unitTests = await execNpm(['test'], projectDir, 2 * 60_000);
        expect(unitTests.code, `npm test failed:\n${unitTests.output}`).toBe(0);

        const e2e = await execNpm(['run', 'test:e2e'], projectDir, 5 * 60_000);
        expect(e2e.code, `npm run test:e2e failed:\n${e2e.output}`).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    15 * 60_000
  );
});
