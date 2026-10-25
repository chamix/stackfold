import { describe, expect, it } from 'vitest';
import {
  defineScaffold,
  file,
  gitInit,
  mkdir,
  npmInstall,
  runCommand,
  step,
} from '../../src/authoring/builder.js';

describe('defineScaffold', () => {
  it('builds a ScaffoldDefinition matching its input field-for-field', () => {
    const definition = defineScaffold({
      id: 'my-plugin',
      description: 'A plugin.',
      questions: [{ id: 'appName', message: 'App name', type: 'input' }],
      steps: [{ action: 'mkdir', params: { path: 'src' } }],
    });

    expect(definition).toEqual({
      id: 'my-plugin',
      description: 'A plugin.',
      questions: [{ id: 'appName', message: 'App name', type: 'input' }],
      steps: [{ action: 'mkdir', params: { path: 'src' } }],
    });
  });

  it('omits "help" entirely when not supplied', () => {
    const definition = defineScaffold({ id: 'p', description: 'd', questions: [], steps: [] });

    expect('help' in definition).toBe(false);
  });

  it('includes "help" when supplied', () => {
    const definition = defineScaffold({
      id: 'p',
      description: 'd',
      help: { name: 'P', details: 'More prose.' },
      questions: [],
      steps: [],
    });

    expect(definition.help).toEqual({ name: 'P', details: 'More prose.' });
  });

  it('omits "hooks" entirely when not supplied', () => {
    const definition = defineScaffold({ id: 'p', description: 'd', questions: [], steps: [] });

    expect('hooks' in definition).toBe(false);
  });

  it('includes "hooks" when supplied', () => {
    const definition = defineScaffold({
      id: 'p',
      description: 'd',
      questions: [],
      steps: [],
      hooks: { postInit: [{ action: 'patchFile', params: {} }] },
    });

    expect(definition.hooks).toEqual({ postInit: [{ action: 'patchFile', params: {} }] });
  });

  // Task 044 (UX-001/SK-ADR-004): `mainFile` passthrough — same
  // present-only-when-supplied contract as `help`/`hooks` above.
  it('omits "mainFile" entirely when not supplied', () => {
    const definition = defineScaffold({ id: 'p', description: 'd', questions: [], steps: [] });

    expect('mainFile' in definition).toBe(false);
  });

  it('includes a literal "mainFile" when supplied', () => {
    const definition = defineScaffold({
      id: 'p',
      description: 'd',
      questions: [],
      steps: [],
      mainFile: 'src/main/index.ts',
    });

    expect(definition.mainFile).toBe('src/main/index.ts');
  });

  it('includes a JSONLogic-expression-shaped "mainFile" when supplied, untouched', () => {
    const expr = { if: [{ '==': [{ var: 'appType' }, 'standalone-html'] }, 'index.html', 'src/main.ts'] };
    const definition = defineScaffold({ id: 'p', description: 'd', questions: [], steps: [], mainFile: expr });

    expect(definition.mainFile).toEqual(expr);
  });
});

describe('file()', () => {
  it('builds a writeFile ActionStep with just path+content', () => {
    expect(file('README.md', '# Hi\n')).toEqual({
      action: 'writeFile',
      params: { path: 'README.md', content: '# Hi\n' },
    });
  });

  it('includes "strategy" only when supplied', () => {
    expect(file('a.json', '{}', { strategy: 'json-merge' })).toEqual({
      action: 'writeFile',
      params: { path: 'a.json', content: '{}', strategy: 'json-merge' },
    });
  });

  it('includes "jsonEscapeKeys" only when supplied', () => {
    expect(file('a.json', '{"x":"{{x}}"}', { jsonEscapeKeys: ['x'] })).toEqual({
      action: 'writeFile',
      params: { path: 'a.json', content: '{"x":"{{x}}"}', jsonEscapeKeys: ['x'] },
    });
  });

  it('includes "when" only when supplied', () => {
    const withWhen = file('a.txt', 'x', { when: { var: 'includeA' } });
    const withoutWhen = file('a.txt', 'x');

    expect(withWhen).toEqual({ action: 'writeFile', params: { path: 'a.txt', content: 'x' }, when: { var: 'includeA' } });
    expect('when' in withoutWhen).toBe(false);
  });
});

describe('mkdir()', () => {
  it('builds a mkdir ActionStep', () => {
    expect(mkdir('src')).toEqual({ action: 'mkdir', params: { path: 'src' } });
  });

  it('includes "when" only when supplied', () => {
    expect(mkdir('src', { when: true })).toEqual({ action: 'mkdir', params: { path: 'src' }, when: true });
  });
});

describe('runCommand()', () => {
  it('builds a runCommand ActionStep with no args by default', () => {
    expect(runCommand('echo')).toEqual({ action: 'runCommand', params: { command: 'echo' } });
  });

  it('includes "args" only when supplied', () => {
    expect(runCommand('echo', { args: ['hi'] })).toEqual({
      action: 'runCommand',
      params: { command: 'echo', args: ['hi'] },
    });
  });
});

describe('npmInstall()/gitInit()', () => {
  it('build their respective no-params ActionSteps', () => {
    expect(npmInstall()).toEqual({ action: 'npmInstall', params: {} });
    expect(gitInit()).toEqual({ action: 'gitInit', params: {} });
  });

  it('include "when" only when supplied', () => {
    expect(npmInstall({ when: false })).toEqual({ action: 'npmInstall', params: {}, when: false });
    expect(gitInit({ when: false })).toEqual({ action: 'gitInit', params: {}, when: false });
  });
});

describe('step()', () => {
  it('builds an arbitrary named ActionStep, untouched', () => {
    expect(step('deriveAnswer', { from: 'appName', to: 'slug', transform: 'npm-slug' })).toEqual({
      action: 'deriveAnswer',
      params: { from: 'appName', to: 'slug', transform: 'npm-slug' },
    });
  });

  it('includes "when" only when supplied', () => {
    expect(step('gitInit', {}, { when: { var: 'x' } })).toEqual({
      action: 'gitInit',
      params: {},
      when: { var: 'x' },
    });
  });
});
