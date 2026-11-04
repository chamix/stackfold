import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPluginList, runPluginRegister, runPluginUnregister, type PluginCommandDependencies } from '../../src/cli/commands/plugin.js';
import { runList } from '../../src/cli/commands/list.js';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { CompositePluginRegistry } from '../../src/infra/compositePluginRegistry.js';
import { DynamicPluginRegistry } from '../../src/infra/dynamicPluginRegistry.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { ExecaProcessRunner } from '../../src/infra/processRunner.js';
import type { ProcessRunner } from '../../src/core/ports.js';
import { compileScaffold } from '../../src/core/authoring.js';
import pluginScaffoldDefinition from '../../src/plugins/plugin-scaffold/scaffold.js';

/**
 * Split out of `external-plugin-registration.test.ts` (ARCH-003 follow-up,
 * Windows EBUSY fix -- see the big comment inside the test below for the
 * full root-cause history). This is the one test from that original file
 * heavy enough -- a real `dist/` + `zod` copy, a real isolated `node`
 * subprocess for `scaffold synth` -- to deserve its own file and its own
 * generous per-test timeout, instead of sharing blast radius and slowing
 * down the three lighter hand-written-`scaffold.json` tests that stayed
 * behind in the original file.
 *
 * This repo's own root -- so a `scaffold.ts` generated into an arbitrary
 * tmpdir (outside this repo entirely) can really resolve `import ... from
 * 'stackfold/authoring'` the same way a real npm consumer's installed
 * package would: via a `node_modules/stackfold` entry a normal directory
 * walk finds, resolved through the real `package.json` "exports" map
 * (ARCH-003 Decision 2), against the real built `dist/` -- requires
 * `npm run build` to have run at least once (same precondition
 * `scripts/e2e-plugin-scaffold-playground.mjs` has, just via a symlink
 * instead of a full `npm pack`+install, since this is the fast
 * integration tier, not that script's slow real-tarball acceptance tier).
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Installs just enough of a real `node_modules/stackfold` for the
 * self-referencing `import ... from 'stackfold/authoring'` in a
 * plugin-scaffold-generated `scaffold.ts` to resolve from an arbitrary
 * `installDir` -- a minimal `package.json` carrying only the real
 * "exports" map (ARCH-003 Decision 2), plus a real *copy* of the actually
 * built `dist/authoring/` output. A copy, not a symlink/junction to this
 * live, currently-running repo: two separate real Windows runs each hit a
 * different `EBUSY`/cleanup failure tied to the junction that no amount
 * of retry tuning resolved. A plain copied directory has no link to
 * anything still in use and is removed exactly like any other temp file.
 */
async function installStackfoldAuthoringPackage(installDir: string): Promise<void> {
  const pkgDir = join(installDir, 'node_modules', 'stackfold');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'stackfold', type: 'module', exports: { './authoring': './dist/authoring/index.js' } }),
    'utf8'
  );
  await cp(join(REPO_ROOT, 'dist'), join(pkgDir, 'dist'), { recursive: true });
  await cp(join(REPO_ROOT, 'node_modules', 'zod'), join(installDir, 'node_modules', 'zod'), { recursive: true });
}

let projectDir: string;
const evaluator = new JsonLogicExpressionEvaluator();

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'stackfold-external-plugin-scaffold-'));
});

afterEach(async () => {
  await removeWithRetry(projectDir);
});

function pluginDeps(): PluginCommandDependencies & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    cwd: () => projectDir,
    evaluator,
    stdout: (l) => stdoutLines.push(l),
    stderr: (l) => stderrLines.push(l),
    stdoutLines,
    stderrLines,
  };
}

/**
 * Windows-safe recursive removal -- see `external-plugin-registration.test.ts`'s
 * own copy of this helper for the full real-Windows retry history.
 * Duplicated here (not shared via a helper module) to keep each
 * integration test file standalone and independently readable.
 */
async function removeWithRetry(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function compositeRegistry() {
  const staticRegistry = new StaticPluginRegistry([]);
  const dynamicRegistry = new DynamicPluginRegistry({ evaluator, cwd: () => projectDir });
  return new CompositePluginRegistry([staticRegistry, dynamicRegistry]);
}

describe('external plugin — plugin-scaffold-authored (ARCH-003 follow-up)', () => {
  it(
    'plugin-scaffold generates a standalone, no-checkout plugin that can itself be registered and unregistered',
    async () => {
      const pluginId = 'hello-from-plugin-scaffold';
      // directory === pluginId, by design (ARCH-003 Decision 3's confirmed convention).
      const targetDir = join(projectDir, pluginId);

      const realProcessRunner = new ExecaProcessRunner();
      // Hybrid ProcessRunner (Windows EBUSY root-caused via a real Windows
      // run -- two earlier theories here were tried and ruled out by real
      // evidence; see below): the `stackfold scaffold synth <pluginId>`
      // step shells out to a REAL node subprocess running this repo's own
      // built `dist/cli/index.js` -- never `runScaffoldSynth()` in-process,
      // and never a bare `stackfold` command (this test runs inside the
      // repo's own `node_modules` context, which has no global/linked
      // `stackfold` bin on PATH; that specific gap -- an npm consumer's
      // *installed* bin resolving from PATH -- is what
      // `scripts/e2e-plugin-scaffold-playground.mjs` already proves
      // separately, against a real packed tarball). The two `node -e`
      // `postWrite`/`postInit` hook steps (plugin-scaffold's own
      // `scaffold.ts`) stay intercepted and re-implemented in-process below
      // -- they never dynamically `import()` anything under `projectDir`
      // (one is an `fs.existsSync` check, the other a `console.log`), so
      // there is nothing for them to hold onto.
      //
      // Root-cause history (two ruled-out theories, kept here so a future
      // reader doesn't re-try them): (1) a real `node -e` child's cwd
      // sitting inside `projectDir` while `runHookCommand` omits `cwd`
      // (`core/authoring.ts`'s header comment) -- plausible, but
      // intercepting both `node -e` steps so NO real child ever ran with
      // that cwd made no difference on a real Windows run, ruling it out.
      // (2) `tsImport()` (`tsx/esm/api`, used by the in-process
      // `runScaffoldSynth()` to load `scaffold.ts` and, through its own
      // `import 'stackfold/authoring'`, the whole copied
      // `node_modules/stackfold/dist` tree) never calling the `unregister()`
      // its own `register()` hands back, leaving its ESM loader hooks
      // registered for the rest of the process's life -- also plausible,
      // also tried (`register()` + `.import()` + explicit `.unregister()`
      // in `scaffoldSynth.ts`), also made no difference on a real Windows
      // run. That same run, with a diagnostic wait inserted right before
      // this file's shared `afterEach` cleanup (15s, then 50s), STILL
      // failed identically -- ruling out "transient, just needs more time"
      // (antivirus/OS scan settling) too: whatever holds the directory is
      // held for the process's whole remaining life, not released by
      // waiting.
      //
      // What actually fits every real-Windows data point: the ONE thing
      // that's different about this step, versus the otherwise-identical
      // `tests/integration/scaffold-synth-cli.test.ts` (which also
      // `tsImport()`s a `scaffold.ts` under its own tmpdir, then `rm()`s
      // that tmpdir right after, with no retry at all, and never fails) --
      // is running that import *in the very same long-lived Vitest worker
      // process* that then tries to delete the directory, for a MUCH
      // larger import graph (the whole copied `dist/` + `zod`, not two
      // small fixture files). A real `stackfold scaffold synth` invocation
      // is its own OS process that exits completely before a user's shell
      // ever gets to delete anything -- so running it as a real, separate
      // `node` child process here (not in-process) reproduces that same
      // guarantee: whatever Windows-side state the import left behind is
      // released when the child exits, deterministically, well before this
      // test's own `afterEach` runs.
      const hybridProcessRunner: ProcessRunner = {
        async run(command, args, options) {
          if (command === 'stackfold' && args[0] === 'scaffold' && args[1] === 'synth') {
            const cliEntry = join(REPO_ROOT, 'dist', 'cli', 'index.js');
            await realProcessRunner.run('node', [cliEntry, 'scaffold', 'synth', args[2]], options);
            return;
          }
          if (command === 'node' && args[0] === '-e') {
            const script = String(args[1] ?? '');
            // (1) postWrite fail-fast guard -- see plugin-scaffold's own
            // scaffold.ts header comment ("postWrite hook"). Re-implemented
            // here as the real fs check it performs, not a no-op: a real
            // directory/pluginId mismatch must still fail this test the
            // same way it would fail a real `stackfold init`.
            if (script.includes('after writing files, but it is missing')) {
              const expected = join(process.cwd(), pluginId, 'scaffold.ts');
              if (!existsSync(expected)) {
                throw new Error(
                  `plugin-scaffold: expected to find "${expected}" after writing files, but it is missing. This means the init directory argument did not match the pluginId answer ("${pluginId}"). Re-run: stackfold init plugin-scaffold ${pluginId}`
                );
              }
              return;
            }
            // (2) postInit "next command" banner -- purely informational
            // (`console.log`), nothing this test asserts on; safe to no-op.
            return;
          }
          await realProcessRunner.run(command, args, options);
        },
      };

      const initStdout: string[] = [];
      const initStderr: string[] = [];
      await installStackfoldAuthoringPackage(projectDir);

      // `plugin-scaffold` is a built-in, so unlike the other tests in this
      // file (which deliberately test against zero built-ins), this one
      // registry really needs it -- same compile-from-scaffold.js wiring
      // `src/cli/index.ts` itself uses (its `validate` closures must stay
      // live, never compiled from `scaffold.json`).
      const registryWithPluginScaffold = new CompositePluginRegistry([
        new StaticPluginRegistry([compileScaffold(pluginScaffoldDefinition, evaluator)]),
        new DynamicPluginRegistry({ evaluator, cwd: () => projectDir }),
      ]);

      const initDeps: InitCommandDependencies = {
        registry: registryWithPluginScaffold,
        ports: {
          prompter: {
            ask: async () => ({
              pluginId,
              displayName: 'Hello From Plugin Scaffold',
              description: 'A plugin authored without a stackfold repo checkout, via plugin-scaffold.',
              author: 'Integration test',
            }),
          },
          fileWriter: new NodeFileWriter(),
          processRunner: hybridProcessRunner,
        },
        opener: { open: async () => {} },
        cwd: () => projectDir,
        stdout: (l) => initStdout.push(l),
        stderr: (l) => initStderr.push(l),
      };

      // `runHookCommand` steps run with no cwd override -- they inherit the
      // real invoking process's cwd -- so this test chdirs into projectDir
      // for the duration of `runInit`, the same way a real user running
      // `stackfold init plugin-scaffold <id>` from `projectDir` would.
      const originalCwd = process.cwd();
      process.chdir(projectDir);
      let initCode: number;
      try {
        initCode = await runInit('plugin-scaffold', targetDir, initDeps, { open: false });
      } finally {
        process.chdir(originalCwd);
      }

      expect(initStderr).toEqual([]);
      expect(initCode).toBe(0);

      const scaffoldTsPath = join(targetDir, 'scaffold.ts');
      const scaffoldJsonPath = join(targetDir, 'scaffold.json');
      await expect(readFile(scaffoldTsPath, 'utf8')).resolves.toContain(`id: '${pluginId}'`);
      const scaffoldJson = JSON.parse(await readFile(scaffoldJsonPath, 'utf8')) as { id: string };
      expect(scaffoldJson.id).toBe(pluginId);

      // No special early removal needed anymore: `node_modules/stackfold`
      // is now a plain copied directory (see `installStackfoldAuthoringPackage`'s
      // own comment), not a junction -- the shared `afterEach` below
      // handles it like any other file under `projectDir`.

      // Register the plugin-scaffold-authored plugin for real.
      const registerDeps = pluginDeps();
      const registerCode = await runPluginRegister(scaffoldJsonPath, { project: true }, registerDeps);
      expect(registerDeps.stderrLines).toEqual([]);
      expect(registerCode).toBe(0);

      const pluginListDeps = pluginDeps();
      await runPluginList(pluginListDeps);
      expect(pluginListDeps.stdoutLines.join('\n')).toMatch(new RegExp(`${pluginId}.*. resolves`));

      const listStdout: string[] = [];
      await runList({ registry: compositeRegistry(), stdout: (l) => listStdout.push(l) });
      expect(listStdout.join('\n')).toContain(pluginId);

      // Unregister it.
      const unregisterDeps = pluginDeps();
      const unregisterCode = await runPluginUnregister(pluginId, { project: true }, unregisterDeps);
      expect(unregisterCode).toBe(0);

      const pluginListAfter = pluginDeps();
      await runPluginList(pluginListAfter);
      expect(pluginListAfter.stdoutLines.join('\n')).not.toContain(pluginId);

      const listStdoutAfter: string[] = [];
      await runList({ registry: compositeRegistry(), stdout: (l) => listStdoutAfter.push(l) });
      expect(listStdoutAfter.join('\n')).not.toContain(pluginId);

    },
    // Real fs copies (`dist/` + `zod`) + a real `synth` pass; generous since
    // observed to vary meaningfully by environment I/O (1.3s-12.5s across
    // runs on the same machine).
    60000
  );
});
