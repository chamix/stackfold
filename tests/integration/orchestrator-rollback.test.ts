import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { compileScaffold } from '../../src/core/authoring.js';
import type { PluginRegistry } from '../../src/core/ports.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileRemover, NodeFileWriter } from '../../src/infra/fs.js';
import { ExecaProcessRunner } from '../../src/infra/processRunner.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import pluginScaffoldDefinition from '../../src/plugins/plugin-scaffold/scaffold.js';

/**
 * ARCH-004 / SK-ADR-006, real-disk proof: the exact `plugin-scaffold`
 * directory/pluginId mismatch ARCH-003 left uncleaned (the backlog item
 * this task closes) now rolls back by default, and `--keep-on-failure`
 * restores today's "leave the partial files in place" behavior exactly.
 *
 * Real `NodeFileWriter` + `NodeFileRemover` + a real `ExecaProcessRunner`
 * (the `postWrite` guard really is a `node -e` child process — see
 * `plugin-scaffold/scaffold.ts`'s own header comment) — never fakes, since
 * this is the one tier meant to prove actual disk state, not call order.
 *
 * `postInit` (the real `stackfold scaffold synth` + `npm`/`git` steps) never
 * runs in either case here: the `postWrite` guard fails first every time,
 * by construction (directory argument deliberately mismatched from the
 * `pluginId` answer) — so this test needs no built `dist/`, no
 * `node_modules/stackfold` install, unlike the heavier
 * `external-plugin-scaffold.test.ts` success-path sibling.
 */
const evaluator = new JsonLogicExpressionEvaluator();

let projectDir: string;
let originalCwd: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'stackfold-rollback-'));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function registry(): PluginRegistry {
  return new StaticPluginRegistry([compileScaffold(pluginScaffoldDefinition, evaluator)]);
}

function initDeps(opts: { withFileRemover: boolean }): InitCommandDependencies & { stderrLines: string[] } {
  const stderrLines: string[] = [];
  return {
    registry: registry(),
    ports: {
      prompter: {
        ask: async () => ({
          pluginId: 'actual-plugin-id',
          displayName: 'X',
          description: 'Y',
          author: 'Z',
        }),
      },
      fileWriter: new NodeFileWriter(),
      processRunner: new ExecaProcessRunner(),
      ...(opts.withFileRemover ? { fileRemover: new NodeFileRemover() } : {}),
    },
    opener: { open: async () => {} },
    cwd: () => projectDir,
    stdout: () => {},
    stderr: (l) => stderrLines.push(l),
    stderrLines,
  };
}

describe('plugin-scaffold directory/pluginId mismatch — real-disk rollback (ARCH-003 follow-up)', () => {
  it(
    'rolls back by default: exits non-zero and leaves no files behind',
    async () => {
      // Directory argument ("mismatched-dir") deliberately does not match
      // the pluginId answer ("actual-plugin-id") — the exact ARCH-003 guard
      // failure shape.
      const targetDir = join(projectDir, 'mismatched-dir');
      await mkdir(targetDir, { recursive: true });
      const deps = initDeps({ withFileRemover: true });

      process.chdir(projectDir);
      let code: number;
      try {
        code = await runInit('plugin-scaffold', targetDir, deps, { open: false });
      } finally {
        process.chdir(originalCwd);
      }

      expect(code).toBe(1);
      expect(deps.stderrLines.join('\n')).toContain('did not match the pluginId answer');
      expect(deps.stderrLines.join('\n')).toMatch(/Rolled back \d+ file\(s\)\./);

      // No files left behind — the 4 files plugin-scaffold's own
      // buildBlueprint() writes (templates/readme.md.hbs, scaffold.ts,
      // scaffold.test.ts, package.json) are all gone; only the (D4) empty
      // targetDir itself may remain.
      await expect(readdir(targetDir)).resolves.toEqual([]);
    },
    30000
  );

  it(
    '--keep-on-failure: exits non-zero but leaves the partial files in place, same as today',
    async () => {
      const targetDir = join(projectDir, 'mismatched-dir-2');
      await mkdir(targetDir, { recursive: true });
      const deps = initDeps({ withFileRemover: true });

      process.chdir(projectDir);
      let code: number;
      try {
        code = await runInit('plugin-scaffold', targetDir, deps, { open: false, keepOnFailure: true });
      } finally {
        process.chdir(originalCwd);
      }

      expect(code).toBe(1);
      expect(deps.stderrLines.join('\n')).toContain('did not match the pluginId answer');
      expect(deps.stderrLines.join('\n')).toContain('Written before the failure (remove or keep by hand):');
      expect(deps.stderrLines.join('\n')).not.toMatch(/Rolled back/);

      const entries = await readdir(targetDir);
      expect(entries.sort()).toEqual(['package.json', 'scaffold.test.ts', 'scaffold.ts', 'templates']);
    },
    30000
  );
});
