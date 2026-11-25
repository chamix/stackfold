import { execa } from 'execa';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `node-cli-stackfold` plugin: Tier 5 launch check. Opt-in, gated like the
 * other tier-5 suites. It spawns the REAL built binary (`dist/cli/index.js`),
 * generates a project from two answer sets (the defaults and a set full of
 * special characters, with a command name that differs from the project name),
 * then runs the real `npm install`, `npm run typecheck`, `npm run build` and
 * `npm test` on it. Finally it packs the generated project, installs the
 * tarball as a global package into a temporary prefix and runs the installed
 * command (`<bin> greet World`, `<bin> doctor`), which is the closest a test
 * can get to what a user does after `npm install -g`.
 *
 * Needs a built stackfold (`npm run build`) and network access to the npm
 * registry. Windows specifics (the `.cmd` shim of the installed bin, path
 * handling) are only proven by a real run on Windows.
 */

const RUN_E2E_TESTS = process.env['STACKFOLD_RUN_E2E_TESTS'] === '1';
if (!RUN_E2E_TESTS) {
  // eslint-disable-next-line no-console
  console.info(
    'node-cli-stackfold plugin: launch test (tier 5): skipped. Set STACKFOLD_RUN_E2E_TESTS=1 to run the real CLI + npm install/typecheck/build/test/pack/global-install check.'
  );
}

/** stackfold's own repo root, derived from this file's location (ESM-safe: no bare __dirname). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STACKFOLD_CLI = join(REPO_ROOT, 'dist/cli/index.js');

interface Outcome {
  code: number;
  output: string;
}

/** Runs a command without a shell, never rejecting; execa resolves `npm`/`.cmd` shims on Windows. */
async function run(command: string, args: string[], cwd: string, timeout: number): Promise<Outcome> {
  const result = await execa(command, args, { cwd, timeout, reject: false, all: true });
  return { code: result.exitCode ?? 1, output: String(result.all ?? '').trim() };
}

/** Spawns the real, built `stackfold` CLI (not `plugin.buildBlueprint()`), the same binary a console user runs. */
function runStackfoldInit(targetDir: string, answers: Record<string, string>): Promise<Outcome> {
  const answerArgs = Object.entries(answers).flatMap(([key, value]) => ['--answer', `${key}=${value}`]);
  return run(process.execPath, [STACKFOLD_CLI, 'init', 'node-cli-stackfold', targetDir, ...answerArgs], REPO_ROOT, 60_000);
}

const ANSWER_SETS: Array<{ label: string; answers: Record<string, string> }> = [
  {
    label: 'default answers',
    answers: { projectName: 'my-cli', description: 'A command-line tool', binName: 'my-cli', author: '' },
  },
  {
    label: 'special characters, binName different from projectName',
    answers: {
      projectName: 'acme-tools',
      description: `He said "hi" & <b>it's</b> a \\ test`,
      binName: 'acme',
      author: `Ada "Countess" O'Brien <ada@example.com> & Co\\Ltd`,
    },
  },
];

describe.skipIf(!RUN_E2E_TESTS)('node-cli-stackfold plugin: launch test (tier 5: real CLI + real npm)', () => {
  it.each(ANSWER_SETS)(
    '$label: init, install, typecheck, build, test, pack, global install, run the installed command',
    async ({ answers }) => {
      const root = await mkdtemp(join(tmpdir(), 'stackfold-node-cli-tier5-'));
      try {
        const projectDir = join(root, 'generated');
        const packDir = join(root, 'pack');
        const prefix = join(root, 'prefix');
        const bin = answers['binName'] as string;

        const init = await runStackfoldInit(projectDir, answers);
        expect(init.code, `stackfold init failed:\n${init.output}`).toBe(0);

        const install = await run('npm', ['install'], projectDir, 3 * 60_000);
        expect(install.code, `npm install failed:\n${install.output}`).toBe(0);

        const typecheck = await run('npm', ['run', 'typecheck'], projectDir, 60_000);
        expect(typecheck.code, `npm run typecheck failed:\n${typecheck.output}`).toBe(0);

        const build = await run('npm', ['run', 'build'], projectDir, 60_000);
        expect(build.code, `npm run build failed:\n${build.output}`).toBe(0);

        const test = await run('npm', ['test'], projectDir, 4 * 60_000);
        expect(test.code, `npm test failed:\n${test.output}`).toBe(0);

        await mkdir(packDir, { recursive: true });
        const pack = await run('npm', ['pack', '--pack-destination', packDir], projectDir, 2 * 60_000);
        expect(pack.code, `npm pack failed:\n${pack.output}`).toBe(0);
        const tarball = (await readdir(packDir)).find((name) => name.endsWith('.tgz'));
        expect(tarball, `no tarball in ${packDir}`).toBeDefined();

        const globalInstall = await run(
          'npm',
          ['install', '--global', '--prefix', prefix, join(packDir, tarball as string)],
          root,
          3 * 60_000
        );
        expect(globalInstall.code, `npm install --global failed:\n${globalInstall.output}`).toBe(0);

        // npm puts a global package's bin in <prefix>/bin on POSIX and <prefix>/<name>.cmd on Windows.
        const installedBin = process.platform === 'win32' ? join(prefix, `${bin}.cmd`) : join(prefix, 'bin', bin);

        const greet = await run(installedBin, ['greet', 'World'], root, 60_000);
        expect(greet.code, `${bin} greet failed:\n${greet.output}`).toBe(0);
        expect(greet.output).toBe('Hello, World!');

        const doctor = await run(installedBin, ['doctor'], root, 60_000);
        expect(doctor.code, `${bin} doctor failed:\n${doctor.output}`).toBe(0);
        expect(doctor.output).toMatch(/^node: v\d+\.\d+\.\d+/);

        const help = await run(installedBin, ['--help'], root, 60_000);
        expect(help.code, `${bin} --help failed:\n${help.output}`).toBe(0);
        expect(help.output).toContain(`Usage: ${bin}`);
        expect(help.output).toContain(answers['description'] as string);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    12 * 60_000
  );
});
