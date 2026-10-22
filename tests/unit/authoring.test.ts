import { describe, expect, it } from 'vitest';
import {
  compileScaffold,
  registerAction,
  resolveAction,
  type ActionKind,
  type ActionStep,
  type ScaffoldDefinition,
} from '../../src/core/authoring.js';
import type { ExpressionEvaluator } from '../../src/core/ports.js';
import type { Answers, HookPorts } from '../../src/core/types.js';

/**
 * A minimal, self-contained `ExpressionEvaluator` test-double (per the
 * delegation's instruction to exercise expression resolution against a
 * double, not the real `json-logic-js` adapter). Supports exactly the two
 * shapes these tests need: `{ var: <answers key> }` and `{ const: <value> }`
 * — enough to prove `compileScaffold()` calls `evaluate()` with the right
 * expression and context, without depending on real JSON Logic semantics.
 */
class FakeEvaluator implements ExpressionEvaluator {
  calls: Array<{ expr: unknown; context: Record<string, unknown> }> = [];

  evaluate(expr: unknown, context: Record<string, unknown>): unknown {
    this.calls.push({ expr, context });
    if (isRecord(expr) && 'var' in expr) return context[String(expr.var)];
    if (isRecord(expr) && 'const' in expr) return expr.const;
    throw new Error(`FakeEvaluator: unsupported expression ${JSON.stringify(expr)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fakePorts(): HookPorts {
  return {
    prompter: { async ask() { return {}; } },
    fileWriter: {
      async ensureEmptyDir() {},
      async writeFile() {},
    },
    processRunner: { async run() {} },
  };
}

function step(action: string, params: unknown): ActionStep {
  return { action, params };
}

function definition(partial: Partial<ScaffoldDefinition> & { id: string }): ScaffoldDefinition {
  return { description: 'a test scaffold', questions: [], steps: [], ...partial };
}

describe('registerAction / resolveAction — the generic vocabulary registry', () => {
  it('resolves a registered action by name', () => {
    const kind: ActionKind = {
      tag: 'compose',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      resolve: () => ({ path: 'x.txt', content: 'x' }),
    };
    registerAction('test-custom-compose', kind);
    expect(resolveAction('test-custom-compose')).toBe(kind);
  });

  it('returns undefined for a name nothing was ever registered under', () => {
    expect(resolveAction('test-totally-unregistered-action')).toBeUndefined();
  });

  it('overwrites a previous registration under the same name', () => {
    const first: ActionKind = {
      tag: 'process',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      resolve: () => ({ kind: 'git-init' }),
    };
    const second: ActionKind = {
      tag: 'process',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      resolve: () => ({ kind: 'npm-install' }),
    };
    registerAction('test-overwrite-me', first);
    registerAction('test-overwrite-me', second);
    expect(resolveAction('test-overwrite-me')).toBe(second);
  });

  it('the 5 built-ins are registered by default (module load), no setup required', () => {
    expect(resolveAction('mkdir')?.tag).toBe('compose');
    expect(resolveAction('writeFile')?.tag).toBe('compose');
    expect(resolveAction('runCommand')?.tag).toBe('process');
    expect(resolveAction('npmInstall')?.tag).toBe('process');
    expect(resolveAction('gitInit')?.tag).toBe('process');
  });
});

describe('compileScaffold — identity passthrough', () => {
  it('produces a StackfoldPlugin carrying id/description/help/questions unchanged', () => {
    const def = definition({
      id: 'my-scaffold',
      description: 'My scaffold',
      help: { name: 'My Scaffold', details: 'Long prose.' },
      questions: [{ id: 'appName', message: 'App name?', type: 'input' }],
    });

    const plugin = compileScaffold(def, new FakeEvaluator());

    expect(plugin.id).toBe('my-scaffold');
    expect(plugin.description).toBe('My scaffold');
    expect(plugin.help).toEqual({ name: 'My Scaffold', details: 'Long prose.' });
    expect(plugin.questions()).toEqual(def.questions);
  });

  it('omits help entirely when the definition does not declare it', () => {
    const plugin = compileScaffold(definition({ id: 'bare' }), new FakeEvaluator());
    expect(plugin.help).toBeUndefined();
  });

  it('omits hooks entirely when the definition does not declare any', () => {
    const plugin = compileScaffold(definition({ id: 'no-hooks' }), new FakeEvaluator());
    expect(plugin.hooks).toBeUndefined();
  });
});

describe('compileScaffold — compose actions compile to files via composeBlueprint()', () => {
  it('a single writeFile step produces one file', () => {
    const def = definition({
      id: 'writer',
      steps: [step('writeFile', { path: 'README.md', content: '# Hello' })],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

    expect(blueprint.files).toEqual([{ path: 'README.md', content: '# Hello' }]);
  });

  it('multiple compose steps all contribute files, in step order', () => {
    const def = definition({
      id: 'multi-writer',
      steps: [
        step('mkdir', { path: 'src' }),
        step('writeFile', { path: 'a.txt', content: 'A' }),
        step('writeFile', { path: 'b.txt', content: 'B' }),
      ],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

    expect(blueprint.files.map((f) => f.path)).toEqual(['src/.gitkeep', 'a.txt', 'b.txt']);
  });

  it('reuses composeBlueprint()\'s own collision handling — two exclusive writes to the same path throw', () => {
    const def = definition({
      id: 'colliding',
      steps: [
        step('writeFile', { path: 'dup.txt', content: 'A' }),
        step('writeFile', { path: 'dup.txt', content: 'B' }),
      ],
    });

    expect(() => compileScaffold(def, new FakeEvaluator()).buildBlueprint({})).toThrow(/exclusive collision/);
  });

  it('reuses composeBlueprint()\'s json-merge strategy for two writeFile steps targeting the same path', () => {
    const def = definition({
      id: 'json-merging',
      steps: [
        step('writeFile', { path: 'package.json', content: '{"name":"demo"}', strategy: 'json-merge' }),
        step('writeFile', {
          path: 'package.json',
          content: '{"scripts":{"test":"vitest run"}}',
          strategy: 'json-merge',
        }),
      ],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});
    const pkg = JSON.parse(blueprint.files[0]!.content.toString());

    expect(pkg).toEqual({ name: 'demo', scripts: { test: 'vitest run' } });
  });
});

describe('compileScaffold — process actions compile to post-actions', () => {
  it('runCommand/npmInstall/gitInit steps all contribute post-actions, in step order', () => {
    const def = definition({
      id: 'proc',
      steps: [
        step('gitInit', {}),
        step('runCommand', { command: 'node', args: ['build.js'] }),
        step('npmInstall', {}),
      ],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

    expect(blueprint.postActions).toEqual([
      { kind: 'git-init' },
      { kind: 'run-command', command: 'node', args: ['build.js'] },
      { kind: 'npm-install' },
    ]);
  });

  it('compose and process steps interleave correctly into files vs. postActions', () => {
    const def = definition({
      id: 'mixed',
      steps: [step('writeFile', { path: 'a.txt', content: 'A' }), step('gitInit', {}), step('npmInstall', {})],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

    expect(blueprint.files).toEqual([{ path: 'a.txt', content: 'A' }]);
    expect(blueprint.postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });
});

describe('compileScaffold — expression resolution against answers', () => {
  it('resolves an expression-shaped param value via the injected evaluator, against answers', () => {
    const def = definition({
      id: 'expr-writer',
      steps: [step('writeFile', { path: { var: 'fileName' }, content: 'body' })],
    });
    const evaluator = new FakeEvaluator();

    const blueprint = compileScaffold(def, evaluator).buildBlueprint({ fileName: 'notes.md' });

    expect(blueprint.files).toEqual([{ path: 'notes.md', content: 'body' }]);
    expect(evaluator.calls).toContainEqual({ expr: { var: 'fileName' }, context: { fileName: 'notes.md' } });
  });

  it('resolves an expression nested inside an array param (runCommand args)', () => {
    const def = definition({
      id: 'expr-args',
      steps: [step('runCommand', { command: 'echo', args: ['static', { var: 'dynamicArg' }] })],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({ dynamicArg: 'computed' });

    expect(blueprint.postActions).toEqual([
      { kind: 'run-command', command: 'echo', args: ['static', 'computed'] },
    ]);
  });

  it('does not treat the top-level params object itself as an expression', () => {
    const def = definition({
      id: 'top-level-literal',
      steps: [step('writeFile', { path: 'plain.txt', content: 'literal' })],
    });
    const evaluator = new FakeEvaluator();

    compileScaffold(def, evaluator).buildBlueprint({});

    expect(evaluator.calls).toEqual([]);
  });

  // B1 (review_report.md) regression: `content` must always be the
  // ScaffoldDefinition's own literal, author-written string — never a
  // value produced by expression resolution — because it is compiled as a
  // Handlebars template against the *full* `answers` object. Before the
  // fix, an expression-shaped `content` resolved to an end-user's free-text
  // answer, which was then template-compiled and could leak sibling answer
  // fields the scaffold author never intended to expose through it.
  it('never expression-resolves writeFile\'s "content" — an expression-shaped content is rejected by zod, not silently resolved (B1)', () => {
    const def = definition({
      id: 'expr-content-writer',
      steps: [step('writeFile', { path: 'out.txt', content: { var: 'userFreeText' } })],
    });
    const evaluator = new FakeEvaluator();

    expect(() =>
      compileScaffold(def, evaluator).buildBlueprint({
        userFreeText: 'leaked secret field below:\n{{secretField}}',
        secretField: 'topSecretOnlyMeantForInternalUse',
      })
    ).toThrow();
    // The evaluator must never even be asked to resolve `content` —
    // confirms this is a validation rejection, not a resolve-then-fail.
    expect(evaluator.calls).toEqual([]);
  });

  it('a literal, author-written "content" string still Handlebars-compiles against answers correctly (content stays an interpolation target, not an expression)', () => {
    const def = definition({
      id: 'literal-content-writer',
      steps: [step('writeFile', { path: 'out.txt', content: 'Hello {{name}}!' })],
    });

    const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({
      name: 'World',
      secretField: 'topSecretOnlyMeantForInternalUse',
    });

    expect(blueprint.files).toEqual([{ path: 'out.txt', content: 'Hello World!' }]);
  });

  it('still resolves expressions in other writeFile params ("path") even though "content" is exempt', () => {
    const def = definition({
      id: 'expr-path-literal-content',
      steps: [step('writeFile', { path: { var: 'fileName' }, content: 'static body' })],
    });
    const evaluator = new FakeEvaluator();

    const blueprint = compileScaffold(def, evaluator).buildBlueprint({ fileName: 'dynamic.txt' });

    expect(blueprint.files).toEqual([{ path: 'dynamic.txt', content: 'static body' }]);
  });
});

describe('compileScaffold — hooks compile to HookHandler[] closing over evaluator + answers', () => {
  it('a postInit hook step resolves its expression against the answers from that buildBlueprint() call', async () => {
    registerAction('test-record-message', {
      tag: 'hook',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      handler: (params) => {
        received.push((params as { message: string }).message);
      },
    });
    const received: string[] = [];

    const def = definition({
      id: 'hooked',
      hooks: { postInit: [step('test-record-message', { message: { var: 'greeting' } })] },
    });

    const plugin = compileScaffold(def, new FakeEvaluator());
    plugin.buildBlueprint({ greeting: 'hello world' });

    expect(plugin.hooks?.postInit).toHaveLength(1);
    await plugin.hooks!.postInit![0]!(fakePorts(), { greeting: 'hello world' });

    expect(received).toEqual(['hello world']);
  });

  it('passes the real ports through to the compiled hook handler', async () => {
    let seenPorts: HookPorts | undefined;
    registerAction('test-capture-ports', {
      tag: 'hook',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      handler: (_params, ports) => {
        seenPorts = ports;
      },
    });

    const def = definition({ id: 'ports-hook', hooks: { postWrite: [step('test-capture-ports', {})] } });
    const plugin = compileScaffold(def, new FakeEvaluator());
    plugin.buildBlueprint({});

    const ports = fakePorts();
    await plugin.hooks!.postWrite![0]!(ports, {});

    expect(seenPorts).toBe(ports);
  });

  it('a preInit hook step resolves its expression against the real answers passed to the compiled handler, even though buildBlueprint() has not run yet for this invocation', async () => {
    let seenMessage: unknown;
    registerAction('test-record-raw', {
      tag: 'hook',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      handler: (params) => {
        seenMessage = (params as { message: unknown }).message;
      },
    });

    const def = definition({
      id: 'preinit-hook',
      hooks: { preInit: [step('test-record-raw', { message: { var: 'greeting' } })] },
    });
    const plugin = compileScaffold(def, new FakeEvaluator());

    // Deliberately NOT calling buildBlueprint() first — mirrors the real
    // orchestrator's order, where preInit fires before buildBlueprint(). The
    // real `answers` now arrive as the handler's own second parameter
    // (threaded by the orchestrator), not via any state buildBlueprint()
    // previously had to populate first.
    await plugin.hooks!.preInit![0]!(fakePorts(), { greeting: 'hello from preInit' });

    expect(seenMessage).toBe('hello from preInit');
  });

  it('a hook ActionStep referencing a non-hook action throws when the handler runs', async () => {
    const def = definition({ id: 'bad-hook-ref', hooks: { postInit: [step('writeFile', { path: 'x', content: 'y' })] } });
    const plugin = compileScaffold(def, new FakeEvaluator());
    plugin.buildBlueprint({});

    await expect(plugin.hooks!.postInit![0]!(fakePorts(), {})).rejects.toThrow(/not "hook"/);
  });

  it('a hook ActionStep referencing an unknown action throws when the handler runs', async () => {
    const def = definition({ id: 'unknown-hook-ref', hooks: { postInit: [step('nope-not-registered', {})] } });
    const plugin = compileScaffold(def, new FakeEvaluator());
    plugin.buildBlueprint({});

    await expect(plugin.hooks!.postInit![0]!(fakePorts(), {})).rejects.toThrow(/[Uu]nknown action/);
  });
});

describe('compileScaffold — misuse guards', () => {
  it('throws when steps[] references an unknown action', () => {
    const def = definition({ id: 'unknown-step', steps: [step('does-not-exist', {})] });
    expect(() => compileScaffold(def, new FakeEvaluator()).buildBlueprint({})).toThrow(/unknown action/);
  });

  it('throws when steps[] references a hook-kind action (hooks belong under "hooks", not "steps")', () => {
    registerAction('test-hook-only', {
      tag: 'hook',
      schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
      handler: () => {},
    });
    const def = definition({ id: 'misplaced-hook', steps: [step('test-hook-only', {})] });

    expect(() => compileScaffold(def, new FakeEvaluator()).buildBlueprint({})).toThrow(/"hook"/);
  });
});

describe('built-in action: mkdir (compose)', () => {
  it('produces a .gitkeep marker file at the given path', () => {
    const kind = resolveAction('mkdir');
    expect(kind?.tag).toBe('compose');
    const parsed = kind!.schema.parse({ path: 'empty-dir' });
    expect((kind as Extract<ActionKind, { tag: 'compose' }>).resolve(parsed, {})).toEqual({
      path: 'empty-dir/.gitkeep',
      content: '',
    });
  });

  it('rejects malformed params (missing path) via zod', () => {
    const kind = resolveAction('mkdir');
    expect(() => kind!.schema.parse({})).toThrow();
  });

  it('rejects an empty path via zod', () => {
    const kind = resolveAction('mkdir');
    expect(() => kind!.schema.parse({ path: '' })).toThrow();
  });
});

describe('built-in action: writeFile (compose)', () => {
  it('compiles content via Handlebars against the context before producing the FileContribution', () => {
    const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
    const parsed = kind.schema.parse({ path: 'README.md', content: 'Hello {{appName}}!' });
    expect(kind.resolve(parsed, { appName: 'Demo' })).toEqual({ path: 'README.md', content: 'Hello Demo!' });
  });

  it('does not HTML-escape interpolated values (generated text/source files, not HTML)', () => {
    const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
    const parsed = kind.schema.parse({ path: 'notes.txt', content: 'Author: {{author}}' });
    expect(kind.resolve(parsed, { author: 'A & B <tag>' })).toEqual({
      path: 'notes.txt',
      content: 'Author: A & B <tag>',
    });
  });

  it('forwards an optional merge strategy onto the FileContribution', () => {
    const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
    const parsed = kind.schema.parse({ path: 'package.json', content: '{}', strategy: 'json-merge' });
    expect(kind.resolve(parsed, {})).toEqual({ path: 'package.json', content: '{}', strategy: 'json-merge' });
  });

  it('rejects malformed params (content is not a string) via zod', () => {
    const kind = resolveAction('writeFile');
    expect(() => kind!.schema.parse({ path: 'a.txt', content: 42 })).toThrow();
  });
});

describe('built-in action: runCommand (process)', () => {
  it('maps 1:1 onto a run-command PostActionDefinition', () => {
    const kind = resolveAction('runCommand') as Extract<ActionKind, { tag: 'process' }>;
    const parsed = kind.schema.parse({ command: 'node', args: ['build.js'] });
    expect(kind.resolve(parsed, {})).toEqual({ kind: 'run-command', command: 'node', args: ['build.js'] });
  });

  it('defaults args to an empty array when omitted', () => {
    const kind = resolveAction('runCommand') as Extract<ActionKind, { tag: 'process' }>;
    const parsed = kind.schema.parse({ command: 'node' });
    expect(kind.resolve(parsed, {})).toEqual({ kind: 'run-command', command: 'node', args: [] });
  });

  it('rejects malformed params (empty command) via zod', () => {
    const kind = resolveAction('runCommand');
    expect(() => kind!.schema.parse({ command: '   ', args: [] })).toThrow();
  });
});

describe('built-in action: npmInstall (process) — sugar over the npm-install kind', () => {
  it('produces { kind: "npm-install" }', () => {
    const kind = resolveAction('npmInstall') as Extract<ActionKind, { tag: 'process' }>;
    const parsed = kind.schema.parse({});
    expect(kind.resolve(parsed, {})).toEqual({ kind: 'npm-install' });
  });

  it('rejects malformed params (unexpected key) via zod', () => {
    const kind = resolveAction('npmInstall');
    expect(() => kind!.schema.parse({ unexpected: true })).toThrow();
  });
});

describe('built-in action: gitInit (process) — sugar over the git-init kind', () => {
  it('produces { kind: "git-init" }', () => {
    const kind = resolveAction('gitInit') as Extract<ActionKind, { tag: 'process' }>;
    const parsed = kind.schema.parse({});
    expect(kind.resolve(parsed, {})).toEqual({ kind: 'git-init' });
  });

  it('rejects malformed params (unexpected key) via zod', () => {
    const kind = resolveAction('gitInit');
    expect(() => kind!.schema.parse({ unexpected: true })).toThrow();
  });
});
