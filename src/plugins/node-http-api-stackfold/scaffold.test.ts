import { describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition, { DEFAULT_DESCRIPTION, DEFAULT_PORT, DEFAULT_PROJECT_NAME } from './scaffold.js';

// Proves node-http-api-stackfold's own scaffold.ts compiles and synthesizes
// real blueprints directly — via its real default export, not the
// synthesized ./scaffold.json — so this test never depends on `stackfold
// scaffold synth` having run. Mirrors `web-app-stackfold`/`electron-stackfold`'s
// own `scaffold.test.ts` shape.

const ALWAYS_GENERATED = [
  'package.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'vitest.config.ts',
  '.gitignore',
  'README.md',
  'src/index.ts',
  'src/server.ts',
  'src/config.ts',
  'src/logger.ts',
  'src/router.ts',
  'src/body.ts',
  'src/errors.ts',
  'src/types.ts',
  'src/routes/health.ts',
  'test/router.test.ts',
  'test/body.test.ts',
  'test/logger.test.ts',
  'test/health.test.ts',
  'test/shutdown.test.ts',
];

const CORS_FILES = ['src/middleware/cors.ts', 'test/cors.test.ts'];
const DOCKER_FILES = ['Dockerfile', '.dockerignore'];
const EXAMPLE_RESOURCE_FILES = ['src/routes/items.ts', 'src/routes/items-store.ts', 'test/items.test.ts'];

const ALL_TEMPLATE_PATHS = [...ALWAYS_GENERATED, ...CORS_FILES, ...DOCKER_FILES, ...EXAMPLE_RESOURCE_FILES];

/** Every combination of the 3 booleans, in a stable, deterministic order. */
const BOOLEAN_COMBINATIONS: Array<{ cors: boolean; docker: boolean; exampleResource: boolean }> = [
  { cors: false, docker: false, exampleResource: false },
  { cors: true, docker: false, exampleResource: false },
  { cors: false, docker: true, exampleResource: false },
  { cors: false, docker: false, exampleResource: true },
  { cors: true, docker: true, exampleResource: false },
  { cors: true, docker: false, exampleResource: true },
  { cors: false, docker: true, exampleResource: true },
  { cors: true, docker: true, exampleResource: true },
];

function expectedPaths(combo: { cors: boolean; docker: boolean; exampleResource: boolean }): string[] {
  return [
    ...ALWAYS_GENERATED,
    ...(combo.cors ? CORS_FILES : []),
    ...(combo.docker ? DOCKER_FILES : []),
    ...(combo.exampleResource ? EXAMPLE_RESOURCE_FILES : []),
  ];
}

function buildPlugin() {
  return compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
}

const BASE_ANSWERS = {
  projectName: DEFAULT_PROJECT_NAME,
  description: DEFAULT_DESCRIPTION,
  port: DEFAULT_PORT,
};

describe('node-http-api-stackfold — its own ScaffoldDefinition compiles', () => {
  it('parses/compiles via compileScaffold() without throwing', () => {
    expect(() => buildPlugin()).not.toThrow();
  });

  it('declares projectName/description/port/cors/docker/exampleResource, in that order, with the expected types/defaults', () => {
    const plugin = buildPlugin();
    const questions = plugin.questions();
    expect(questions.map((q) => q.id)).toEqual([
      'projectName',
      'description',
      'port',
      'cors',
      'docker',
      'exampleResource',
    ]);
    expect(questions.map((q) => q.type)).toEqual(['input', 'input', 'input', 'confirm', 'confirm', 'confirm']);
    expect(questions.find((q) => q.id === 'projectName')?.default).toBe(DEFAULT_PROJECT_NAME);
    expect(questions.find((q) => q.id === 'description')?.default).toBe(DEFAULT_DESCRIPTION);
    expect(questions.find((q) => q.id === 'port')?.default).toBe(DEFAULT_PORT);
    expect(questions.find((q) => q.id === 'cors')?.default).toBe(false);
    expect(questions.find((q) => q.id === 'docker')?.default).toBe(false);
    expect(questions.find((q) => q.id === 'exampleResource')?.default).toBe(false);
  });

  it('declares mainFile as README.md', () => {
    const plugin = buildPlugin();
    expect(plugin.buildBlueprint({ ...BASE_ANSWERS, cors: false, docker: false, exampleResource: false }).mainFile).toBe(
      'README.md'
    );
  });

  it.each(BOOLEAN_COMBINATIONS)(
    'builds the exact expected file set for cors=%s docker=%s exampleResource=%s (no leakage)',
    (combo) => {
      const plugin = buildPlugin();
      const blueprint = plugin.buildBlueprint({ ...BASE_ANSWERS, ...combo });
      const paths = blueprint.files.map((f) => f.path).sort();
      expect(paths).toEqual(expectedPaths(combo).sort());
    }
  );

  it('every template has a file() step (no orphan .hbs under templates/)', () => {
    const plugin = buildPlugin();
    const blueprint = plugin.buildBlueprint({ ...BASE_ANSWERS, cors: true, docker: true, exampleResource: true });
    const paths = blueprint.files.map((f) => f.path).sort();
    expect(paths).toEqual([...ALL_TEMPLATE_PATHS].sort());
  });

  it('Dockerfile is lockfile-tolerant: npm ci when package-lock.json exists, npm install otherwise', () => {
    const plugin = buildPlugin();
    const blueprint = plugin.buildBlueprint({ ...BASE_ANSWERS, cors: false, docker: true, exampleResource: false });
    const dockerfile = blueprint.files.find((f) => f.path === 'Dockerfile');
    expect(dockerfile).toBeDefined();
    const content = String(dockerfile?.content);
    expect(content).toMatch(/package-lock\.json\*/);
    expect(content).toMatch(/if \[ -f package-lock\.json \]; then npm ci; else npm install; fi/);
    expect(content).toMatch(/if \[ -f package-lock\.json \]; then npm ci --omit=dev; else npm install --omit=dev; fi/);
  });

  // validate() derived from the declarative constraints.
  describe('derived validate() from declarative constraints', () => {
    it('projectName: rejects non-lowercase-npm-style names, accepts valid ones', () => {
      const plugin = buildPlugin();
      const projectName = plugin.questions().find((q) => q.id === 'projectName');
      expect(projectName?.validate).toBeTypeOf('function');
      expect(projectName?.validate?.('Bad Name')).not.toBe(true);
      expect(projectName?.validate?.('_x')).not.toBe(true);
      expect(projectName?.validate?.('@a/b')).not.toBe(true);
      expect(projectName?.validate?.('')).not.toBe(true);
      expect(projectName?.validate?.('my-service')).toBe(true);
    });

    it('description: rejects >200 characters or multi-line, accepts a single short line', () => {
      const plugin = buildPlugin();
      const description = plugin.questions().find((q) => q.id === 'description');
      expect(description?.validate?.('a'.repeat(201))).not.toBe(true);
      expect(description?.validate?.('line one\nline two')).not.toBe(true);
      expect(description?.validate?.('A short description')).toBe(true);
    });

    it('port: rejects out-of-range/non-integer values, accepts 1-65535', () => {
      const plugin = buildPlugin();
      const port = plugin.questions().find((q) => q.id === 'port');
      expect(port?.validate?.('0')).not.toBe(true);
      expect(port?.validate?.('70000')).not.toBe(true);
      expect(port?.validate?.('abc')).not.toBe(true);
      expect(port?.validate?.('30.5')).not.toBe(true);
      expect(port?.validate?.('1')).toBe(true);
      expect(port?.validate?.('65535')).toBe(true);
      expect(port?.validate?.('3000')).toBe(true);
    });
  });
});
