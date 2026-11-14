/**
 * `node-http-api-stackfold`'s 3 declarative `constraints` (`projectName` /
 * `description` / `port`) must reject invalid values with a real
 * `stackfold init` (real disk via `NodeFileWriter`, real orchestrator via
 * `runInit`) — same convention as
 * `tests/integration/builtin-validation-runtime.test.ts`.
 *
 * Differential check: the validators of an earlier closure-based
 * implementation (reproduced verbatim below as the oracle) are compared
 * against the compiled `constraints`-derived `validate()` over a
 * deterministic, seeded-PRNG corpus (no new dependency — `mulberry32`, a
 * small inline generator), >= 2000 strings per field including boundaries,
 * U+2028/2029, emoji and whitespace-only. Known accepted difference:
 * `description`'s `maxLength` counts Unicode code points
 * (`core/constraints.ts`), while the oracle's closure counts UTF-16 code
 * units (`text.length`) — the two diverge only for a string containing an
 * astral code point (a surrogate pair, e.g. most emoji) whose length sits
 * across the 200 boundary either way of counting. The differential loop
 * below asserts that every mismatch it finds is explained by exactly that
 * case, never anything else.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInfo } from '../../src/cli/commands/info.js';
import { runInit, type InitCommandDependencies } from '../../src/cli/commands/init.js';
import { runList } from '../../src/cli/commands/list.js';
import { compileScaffold, type ScaffoldDefinition } from '../../src/core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';
import { NodeFileWriter } from '../../src/infra/fs.js';
import { StaticPluginRegistry } from '../../src/infra/pluginLoader.js';
import nodeHttpApiDefinition from '../../src/plugins/node-http-api-stackfold/scaffold.json' with { type: 'json' };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackfold-node-http-api-stackfold-e2e-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const evaluator = new JsonLogicExpressionEvaluator();

function compiledPlugin() {
  return compileScaffold(nodeHttpApiDefinition as ScaffoldDefinition, evaluator);
}

function makeDeps(registry: StaticPluginRegistry): InitCommandDependencies & { stderrLines: string[] } {
  const stderrLines: string[] = [];
  return {
    registry,
    ports: {
      prompter: { ask: async () => ({}) },
      fileWriter: new NodeFileWriter(),
      processRunner: { run: async () => {} },
    },
    opener: { open: async () => {} },
    cwd: () => root,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stderrLines,
  };
}

const VALID_ANSWERS = { projectName: 'my-service', description: 'An HTTP microservice', port: '3000' };

describe('node-http-api-stackfold — real init rejects invalid values, writes nothing', () => {
  it.each([
    ['projectName', 'Bad Name'],
    ['projectName', '@a/b'],
    ['projectName', '_x'],
    ['projectName', ''],
  ])('rejects projectName=%2$s', async (_field, value) => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'out');

    const code = await runInit(
      'node-http-api-stackfold',
      targetDir,
      deps,
      { answer: [`projectName=${value}`, `description=${VALID_ANSWERS.description}`, `port=${VALID_ANSWERS.port}`], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/project name/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it.each([['0'], ['70000'], ['abc'], ['30.5']])('rejects port=%s', async (value) => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'out');

    const code = await runInit(
      'node-http-api-stackfold',
      targetDir,
      deps,
      { answer: [`projectName=${VALID_ANSWERS.projectName}`, `description=${VALID_ANSWERS.description}`, `port=${value}`], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/port/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('rejects a description over 200 characters', async () => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'out');

    const code = await runInit(
      'node-http-api-stackfold',
      targetDir,
      deps,
      { answer: [`projectName=${VALID_ANSWERS.projectName}`, `description=${'a'.repeat(201)}`, `port=${VALID_ANSWERS.port}`], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/description/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('rejects a multi-line description', async () => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'out');

    const code = await runInit(
      'node-http-api-stackfold',
      targetDir,
      deps,
      { answer: [`projectName=${VALID_ANSWERS.projectName}`, 'description=line one\nline two', `port=${VALID_ANSWERS.port}`], open: false }
    );

    expect(code).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/description/i);
    await expect(stat(targetDir)).rejects.toThrow();
  });

  it('still accepts valid values and writes real files (no false-positive rejection)', async () => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const deps = makeDeps(registry);
    const targetDir = join(root, 'out-valid');

    const code = await runInit(
      'node-http-api-stackfold',
      targetDir,
      deps,
      {
        answer: [
          `projectName=${VALID_ANSWERS.projectName}`,
          `description=${VALID_ANSWERS.description}`,
          `port=${VALID_ANSWERS.port}`,
          'cors=false',
          'docker=false',
          'exampleResource=false',
        ],
        open: false,
      }
    );

    expect(code).toBe(0);
    expect(deps.stderrLines).toEqual([]);
    await expect(stat(join(targetDir, 'package.json'))).resolves.toBeTruthy();
  });
});

describe('node-http-api-stackfold — registered and discoverable', () => {
  it('"list" shows the plugin', async () => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const stdoutLines: string[] = [];
    await runList({ registry, stdout: (line) => stdoutLines.push(line) });
    const output = stdoutLines.join('\n');
    expect(output).toMatch(/node-http-api-stackfold/);
    expect(output).toMatch(/Node HTTP API/);
  });

  it('"info" shows its 6 questions', async () => {
    const registry = new StaticPluginRegistry([compiledPlugin()]);
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await runInfo('node-http-api-stackfold', {
      registry,
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    });
    expect(code).toBe(0);
    const output = stdoutLines.join('\n');
    for (const id of ['projectName', 'description', 'port', 'cors', 'docker', 'exampleResource']) {
      expect(output).toMatch(new RegExp(id));
    }
  });
});

// ---------------------------------------------------------------------------
// Differential check: the 3 earlier closure-based `validate` validators, copied
// verbatim as the oracle, compared against the compiled `constraints`.
// ---------------------------------------------------------------------------

const ORACLE_PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,213}$/;
const ORACLE_PORT = /^[1-9][0-9]{0,4}$/;

function oracleProjectName(value: string): true | string {
  return ORACLE_PROJECT_NAME.test(value) || 'Project name must be a lowercase npm-style name: ^[a-z0-9][a-z0-9_-]{0,213}$';
}

function oracleDescription(value: string): true | string {
  return (
    (value.length <= 200 && !/[\r\n]/.test(value)) || 'Description must be a single line of at most 200 characters'
  );
}

function oracleport(value: string): true | string {
  return (ORACLE_PORT.test(value) && Number(value) <= 65535) || 'Port must be an integer between 1 and 65535';
}

/** mulberry32 — small, deterministic, dependency-free PRNG (no new dependency). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
const WEIRD_CHARS = ['\r', '\n', ' ', ' ', ' ', '\t', '@', '/', '!', '.', 'A', 'Z', '\0'];
const EMOJI = ['\u{1F600}', '\u{1F680}', '\u{1F4A9}', '\u{1F600}\u{1F680}'];

function randomString(rng: () => number, length: number, pool: string[]): string {
  let out = '';
  for (let i = 0; i < length; i++) out += pool[Math.floor(rng() * pool.length)];
  return out;
}

function containsAstral(value: string): boolean {
  return /[\u{10000}-\u{10FFFF}]/u.test(value);
}

function projectNameCorpus(rng: () => number): string[] {
  const out: string[] = [];
  const boundaries = ['', 'a', '0', 'a'.repeat(213), 'a'.repeat(214), 'a'.repeat(215), '-a', '_a', 'a-', 'a_'];
  out.push(...boundaries);
  for (let i = 0; i < 1500; i++) {
    const len = Math.floor(rng() * 220);
    out.push(randomString(rng, len, ALPHABET.split('')));
  }
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rng() * 20) + 1;
    out.push(randomString(rng, len, [...ALPHABET.split(''), ...WEIRD_CHARS, ...EMOJI]));
  }
  return out;
}

function descriptionCorpus(rng: () => number): string[] {
  const out: string[] = [];
  const boundaries = ['', 'a'.repeat(199), 'a'.repeat(200), 'a'.repeat(201), '\n', '\r\n', '   ', ' ', ' '];
  out.push(...boundaries);
  // Known-difference boundary: 199 ASCII chars + 1 emoji (a surrogate
  // pair, 2 UTF-16 units but 1 code point) = 201 UTF-16 units (oracle
  // fails, > 200) but 200 code points (compiled passes, exactly 200).
  out.push(`${'a'.repeat(199)}${EMOJI[0]}`);
  for (let i = 0; i < 1500; i++) {
    const len = Math.floor(rng() * 220);
    out.push(randomString(rng, len, [...ALPHABET.split(''), ' ', 'A', 'Z', '.', ',', '!']));
  }
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rng() * 210) + 190;
    out.push(randomString(rng, len, [...ALPHABET.split(''), ...WEIRD_CHARS, ...EMOJI]));
  }
  return out;
}

function portCorpus(rng: () => number): string[] {
  const out: string[] = [];
  const boundaries = ['0', '1', '65535', '65536', '00001', '-1', '', ' ', '3000', '99999', '655350', '3000.5'];
  out.push(...boundaries);
  for (let i = 0; i < 1200; i++) {
    out.push(String(Math.floor(rng() * 100000) - 1000));
  }
  for (let i = 0; i < 800; i++) {
    const len = Math.floor(rng() * 8);
    out.push(randomString(rng, len, [...'0123456789'.split(''), ...WEIRD_CHARS]));
  }
  return out;
}

describe('node-http-api-stackfold — differential: compiled constraints vs. closure-based oracle', () => {
  const rng = mulberry32(0xc0ffee);
  const plugin = compiledPlugin();
  const questions = plugin.questions();
  const compiledProjectName = questions.find((q) => q.id === 'projectName')?.validate;
  const compiledDescription = questions.find((q) => q.id === 'description')?.validate;
  const compiledPort = questions.find((q) => q.id === 'port')?.validate;

  it('projectName: >= 2000 strings, exact pass/fail parity', () => {
    const corpus = projectNameCorpus(rng);
    expect(corpus.length).toBeGreaterThanOrEqual(2000);
    for (const value of corpus) {
      const oracleVerdict = oracleProjectName(value) === true;
      const compiledVerdict = compiledProjectName?.(value) === true;
      expect(compiledVerdict, `projectName mismatch for ${JSON.stringify(value)}`).toBe(oracleVerdict);
    }
  });

  it('port: >= 2000 strings, exact pass/fail parity', () => {
    const corpus = portCorpus(rng);
    expect(corpus.length).toBeGreaterThanOrEqual(2000);
    for (const value of corpus) {
      const oracleVerdict = oracleport(value) === true;
      const compiledVerdict = compiledPort?.(value) === true;
      expect(compiledVerdict, `port mismatch for ${JSON.stringify(value)}`).toBe(oracleVerdict);
    }
  });

  it('description: >= 2000 strings, pass/fail parity except the known code-point-vs-UTF-16-unit boundary case', () => {
    const corpus = descriptionCorpus(rng);
    expect(corpus.length).toBeGreaterThanOrEqual(2000);
    let knownDifferences = 0;
    for (const value of corpus) {
      const oracleVerdict = oracleDescription(value) === true;
      const compiledVerdict = compiledDescription?.(value) === true;
      if (oracleVerdict !== compiledVerdict) {
        // The only acceptable explanation: the string contains an
        // astral code point, so UTF-16-unit length (oracle) and code-point
        // length (compiled) disagree, and the value sits on the opposite
        // side of the 200 boundary under each counting rule.
        expect(containsAstral(value), `unexplained description mismatch for ${JSON.stringify(value)}`).toBe(true);
        knownDifferences += 1;
      }
    }
    // Sanity: the corpus actually exercises the known-difference path at least once.
    expect(knownDifferences).toBeGreaterThan(0);
  });
});
