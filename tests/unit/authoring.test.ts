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
import { toBridgeGlobal, toPackageName } from '../../src/core/stringTransforms.js';
import type { Answers, HookPorts } from '../../src/core/types.js';
// Task 035, acceptance criterion 5's "real JSONLogic" case: the only test in
// this file importing the real adapter rather than `FakeEvaluator` — test
// code, not a `core/` production import, so the Inward Dependency Rule
// (`core/authoring.ts`'s own header comment) does not govern this file. See
// the `per-step "when" conditionals` describe block below for why.
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';

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

/**
 * `files` seeds the fake `FileWriter`'s in-memory store (Task 034's
 * `readFile`/`overwriteFile`, consistent with `orchestrator.test.ts`'s own
 * Map-backed fake style). Omitting it — every call above this point in the
 * file — reproduces the exact previous behavior (`readFile` always
 * resolving `undefined`, `overwriteFile` never called), since no existing
 * test exercises either new method.
 */
function fakePorts(files: Record<string, string> = {}): HookPorts {
  const store = new Map(Object.entries(files));
  return {
    prompter: { async ask() { return {}; } },
    fileWriter: {
      async ensureEmptyDir() {},
      async writeFile() {},
      async readFile(path: string) {
        return store.get(path);
      },
      async overwriteFile(path: string, content: string) {
        store.set(path, content);
      },
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

// Task 035 (.agents/specs/scaffold-step-when-conditional.md §Step 0/Step 1).
// `when` is a direct, additive extension of `ActionStep` — absent ⇒ the
// step always runs (every test above this point never sets it, and all
// keep passing unchanged, which is the regression guarantee acceptance
// criterion 1 asks for). Present ⇒ evaluated as a JSONLogic expression (or
// literal boolean, acceptance criterion 4) against `answers`, gating
// whether the step runs at all — before `resolveAction()`/`resolveParams()`/
// `schema.parse()` for compose/process steps, and before the handler itself
// for hook steps.
describe('compileScaffold — per-step "when" conditionals', () => {
  describe('compose/process steps (buildBlueprint())', () => {
    it('a compose step with when: false is skipped entirely — no FileContribution, and its (invalid) params are never resolved/validated', () => {
      const def = definition({
        id: 'when-false-compose',
        steps: [
          // Missing the required "content" key — would throw at
          // `writeFileSchema.parse()` if params resolution/validation ran
          // for this step at all. `{ const: false }` (not a bare `false`
          // literal — `FakeEvaluator` only understands `var`/`const`-shaped
          // objects; the bare-boolean case is covered separately below
          // against the real evaluator) is enough to exercise the gating
          // mechanics in isolation.
          { action: 'writeFile', params: { path: 'skip.txt' }, when: { const: false } },
        ],
      });
      const evaluator = new FakeEvaluator();

      const blueprint = compileScaffold(def, evaluator).buildBlueprint({});

      expect(blueprint.files).toEqual([]);
      expect(blueprint.postActions).toEqual([]);
      // The gate runs against the real answers; `resolveParams()` never ran
      // for this step, so the evaluator was never asked to resolve
      // anything *inside* params either — the only call it ever saw is the
      // `when` check itself.
      expect(evaluator.calls).toEqual([{ expr: { const: false }, context: {} }]);
    });

    it('a compose step with when: true runs normally', () => {
      const def = definition({
        id: 'when-true-compose',
        steps: [{ action: 'writeFile', params: { path: 'run.txt', content: 'hi' }, when: { const: true } }],
      });

      const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

      expect(blueprint.files).toEqual([{ path: 'run.txt', content: 'hi' }]);
    });

    it('a step with no "when" at all still runs — explicit regression case for acceptance criterion 1', () => {
      const def = definition({
        id: 'when-absent-compose',
        steps: [step('writeFile', { path: 'always.txt', content: 'hi' })],
      });

      const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

      expect(blueprint.files).toEqual([{ path: 'always.txt', content: 'hi' }]);
    });

    it('a process step with when: false is skipped — no PostActionDefinition added, and its (invalid) params are never validated', () => {
      const def = definition({
        id: 'when-false-process',
        steps: [
          // Empty "command" — would throw at `runCommandSchema.parse()` if
          // params resolution/validation ran for this step at all.
          { action: 'runCommand', params: { command: '' }, when: { const: false } },
        ],
      });

      const blueprint = compileScaffold(def, new FakeEvaluator()).buildBlueprint({});

      expect(blueprint.postActions).toEqual([]);
    });

    it('when evaluated via a JSONLogic expression (not a literal) against real answers, resolved through the injected evaluator', () => {
      const def = definition({
        id: 'when-expression-compose',
        steps: [{ action: 'writeFile', params: { path: 'cond.txt', content: 'hi' }, when: { var: 'shouldWrite' } }],
      });
      const evaluator = new FakeEvaluator();

      const skipped = compileScaffold(def, evaluator).buildBlueprint({ shouldWrite: false });
      expect(skipped.files).toEqual([]);

      const ran = compileScaffold(def, evaluator).buildBlueprint({ shouldWrite: true });
      expect(ran.files).toEqual([{ path: 'cond.txt', content: 'hi' }]);
    });
  });

  describe('hook steps (compileHookStep())', () => {
    it('a hook step with when: false, evaluated against the real answers passed to the handler (not {}), is skipped — the handler never runs', async () => {
      let invocations = 0;
      registerAction('test-when-hook', {
        tag: 'hook',
        schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
        handler: () => {
          invocations += 1;
        },
      });

      const def = definition({
        id: 'when-hook-gated',
        hooks: { postInit: [{ action: 'test-when-hook', params: {}, when: { var: 'shouldRun' } }] },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      // Deliberately not calling buildBlueprint() first — same precedent as
      // the existing preInit test above: the handler's own `answers`
      // parameter is what must gate it, not anything buildBlueprint() set
      // up. Real answers, not `{}` — the evaluator must see them.
      await plugin.hooks!.postInit![0]!(fakePorts(), { shouldRun: false, other: 'field' });

      expect(invocations).toBe(0);
      expect(evaluator.calls).toContainEqual({
        expr: { var: 'shouldRun' },
        context: { shouldRun: false, other: 'field' },
      });
    });

    it('a hook step with when: true, evaluated against the real answers passed to the handler, runs normally', async () => {
      let invocations = 0;
      let seenMessage: unknown;
      registerAction('test-when-hook-runs', {
        tag: 'hook',
        schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
        handler: (params) => {
          invocations += 1;
          seenMessage = (params as { message: unknown }).message;
        },
      });

      const def = definition({
        id: 'when-hook-runs',
        hooks: {
          postInit: [
            { action: 'test-when-hook-runs', params: { message: { var: 'greeting' } }, when: { var: 'shouldRun' } },
          ],
        },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      const answers = { shouldRun: true, greeting: 'hello world' };
      await plugin.hooks!.postInit![0]!(fakePorts(), answers);

      expect(invocations).toBe(1);
      expect(seenMessage).toBe('hello world');
      expect(evaluator.calls).toContainEqual({ expr: { var: 'shouldRun' }, context: answers });
    });

    it('a hook step with no "when" at all still invokes the handler — explicit regression case', async () => {
      let invocations = 0;
      registerAction('test-when-absent-hook', {
        tag: 'hook',
        schema: { parse: (v: unknown) => v } as ActionKind extends { schema: infer S } ? S : never,
        handler: () => {
          invocations += 1;
        },
      });

      const def = definition({
        id: 'when-absent-hook',
        hooks: { postInit: [step('test-when-absent-hook', {})] },
      });
      const plugin = compileScaffold(def, new FakeEvaluator());

      await plugin.hooks!.postInit![0]!(fakePorts(), {});

      expect(invocations).toBe(1);
    });
  });

  // Acceptance criterion 4: a literal boolean (not a JSONLogic rule object)
  // must work as unconditional run/skip. `FakeEvaluator` only understands
  // `var`/`const`-shaped objects (it throws on anything else, including a
  // bare `true`/`false`), so this needs the real `json-logic-js` adapter —
  // confirmed empirically (spec's Hallazgo B) that `jsonLogic.apply(true, ctx)
  // === true` and `jsonLogic.apply(false, ctx) === false` with zero
  // special-casing in the gate itself.
  describe('literal boolean "when" (acceptance criterion 4, real JsonLogicExpressionEvaluator)', () => {
    it('when: true (bare boolean) runs the step unconditionally', () => {
      const def = definition({
        id: 'when-literal-true',
        steps: [{ action: 'writeFile', params: { path: 'always-on.txt', content: 'hi' }, when: true }],
      });

      const blueprint = compileScaffold(def, new JsonLogicExpressionEvaluator()).buildBlueprint({});

      expect(blueprint.files).toEqual([{ path: 'always-on.txt', content: 'hi' }]);
    });

    it('when: false (bare boolean) skips the step unconditionally, without needing a real JSONLogic rule', () => {
      const def = definition({
        id: 'when-literal-false',
        steps: [{ action: 'writeFile', params: { path: 'always-off.txt' }, when: false }],
      });

      const blueprint = compileScaffold(def, new JsonLogicExpressionEvaluator()).buildBlueprint({});

      expect(blueprint.files).toEqual([]);
    });
  });

  // Acceptance criterion 5's last bullet: de-risk real JSONLogic `or`/`!==`
  // semantics against the exact shapes `electron-ts`'s own
  // `needsRendererSplit`/`hasAuthor` conditions use today, ahead of the
  // future `electron-stackfold` migration (spec's Hallazgo A). Wired through
  // `compileScaffold()` end-to-end with the real adapter, not `FakeEvaluator`
  // — `FakeEvaluator` only understands `var`/`const` and cannot exercise
  // `or`/`!==` at all.
  describe('real JSONLogic or/!== semantics — electron-ts\'s needsRendererSplit/hasAuthor conditions', () => {
    const needsRendererSplit = { or: [{ var: 'includeSettings' }, { var: 'includeSkins' }] };
    const hasAuthor = { '!==': [{ var: 'author' }, ''] };

    function rendererSplitDefinition(): ScaffoldDefinition {
      return definition({
        id: 'electron-ts-like',
        steps: [
          { action: 'writeFile', params: { path: 'renderer/index.ts', content: 'renderer' }, when: needsRendererSplit },
          { action: 'writeFile', params: { path: 'LICENSE', content: 'by {{author}}' }, when: hasAuthor },
          step('writeFile', { path: 'main.ts', content: 'main' }),
        ],
      });
    }

    it('neither includeSettings nor includeSkins, no author: only the unconditional file is produced', () => {
      const blueprint = compileScaffold(rendererSplitDefinition(), new JsonLogicExpressionEvaluator()).buildBlueprint({
        includeSettings: false,
        includeSkins: false,
        author: '',
      });

      expect(blueprint.files.map((f) => f.path)).toEqual(['main.ts']);
    });

    it('includeSettings true (includeSkins false): the "or" resolves truthy, the renderer split file is produced', () => {
      const blueprint = compileScaffold(rendererSplitDefinition(), new JsonLogicExpressionEvaluator()).buildBlueprint({
        includeSettings: true,
        includeSkins: false,
        author: '',
      });

      expect(blueprint.files.map((f) => f.path)).toEqual(['renderer/index.ts', 'main.ts']);
    });

    it('includeSkins true (includeSettings false): the "or" still resolves truthy', () => {
      const blueprint = compileScaffold(rendererSplitDefinition(), new JsonLogicExpressionEvaluator()).buildBlueprint({
        includeSettings: false,
        includeSkins: true,
        author: '',
      });

      expect(blueprint.files.map((f) => f.path)).toEqual(['renderer/index.ts', 'main.ts']);
    });

    it('a non-empty author: the "!==" resolves truthy, the LICENSE file is produced', () => {
      const blueprint = compileScaffold(rendererSplitDefinition(), new JsonLogicExpressionEvaluator()).buildBlueprint({
        includeSettings: false,
        includeSkins: false,
        author: 'Ada Lovelace',
      });

      expect(blueprint.files.map((f) => f.path)).toEqual(['LICENSE', 'main.ts']);
    });

    it('both conditions truthy: both gated files are produced, alongside the unconditional one, in step order', () => {
      const blueprint = compileScaffold(rendererSplitDefinition(), new JsonLogicExpressionEvaluator()).buildBlueprint({
        includeSettings: true,
        includeSkins: true,
        author: 'Ada Lovelace',
      });

      expect(blueprint.files.map((f) => f.path)).toEqual(['renderer/index.ts', 'LICENSE', 'main.ts']);
    });
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

  // Blocking item 1 (review_report.md, Task 034 follow-up): `jsonEscapeKeys`
  // JSON-string-escapes the named context values before Handlebars renders
  // `content` — for a `content` template that places a free-text answer
  // inside a JSON string-literal position.
  describe('jsonEscapeKeys (review follow-up, Blocking item 1)', () => {
    it('JSON-escapes only the named context keys before rendering, leaving others untouched', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'scaffold.json',
        content: '{ "description": "{{description}}", "author": "{{author}}" }',
        jsonEscapeKeys: ['description'],
      });

      const result = kind.resolve(parsed, { description: 'Does "cool" things.', author: 'A & B' });

      expect(result).toEqual({
        path: 'scaffold.json',
        content: '{ "description": "Does \\"cool\\" things.", "author": "A & B" }',
      });
      expect(() => JSON.parse(result.content.toString())).not.toThrow();
    });

    it('omitting jsonEscapeKeys (or an empty array) reproduces today\'s behavior exactly — no escaping', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({ path: 'a.txt', content: 'Hello {{name}}!' });

      expect(kind.resolve(parsed, { name: 'World "Quoted"' })).toEqual({
        path: 'a.txt',
        content: 'Hello World "Quoted"!',
      });
    });

    it('never expression-resolves "jsonEscapeKeys" — it is always the author\'s own literal list', () => {
      const def = definition({
        id: 'write-file-json-escape-literal',
        steps: [
          step('writeFile', {
            path: 'out.json',
            content: '{ "x": "{{x}}" }',
            jsonEscapeKeys: { var: 'untrustedKeys' },
          }),
        ],
      });
      const evaluator = new FakeEvaluator();

      expect(() => compileScaffold(def, evaluator).buildBlueprint({ x: 'a', untrustedKeys: ['x'] })).toThrow();
      expect(evaluator.calls).toEqual([]);
    });
  });

  // Task 042 review follow-up (review_report.md Blocking #2): `jsEscapeKeys`
  // escapes the named context values for a single-quoted JS/TS string
  // literal position before Handlebars renders `content` — mirrors
  // `jsonEscapeKeys` above exactly, same shape, different escaping target.
  describe('jsEscapeKeys (Task 042 review follow-up, Blocking item 2)', () => {
    it('escapes backslashes and single quotes (in that order) for only the named context keys, leaving others untouched', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'scaffold.ts',
        content: "description: '{{description}}', note: '{{note}}'",
        jsEscapeKeys: ['description'],
      });

      const result = kind.resolve(parsed, { description: "It's a thing", note: "untouched 'quote'" });

      expect(result).toEqual({
        path: 'scaffold.ts',
        content: "description: 'It\\'s a thing', note: 'untouched 'quote''",
      });
    });

    it('escapes a literal backslash before a trailing quote without double-escaping (order matters)', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'scaffold.ts',
        content: "path: '{{path}}'",
        jsEscapeKeys: ['path'],
      });

      const result = kind.resolve(parsed, { path: 'C:\\temp' });

      expect(result).toEqual({ path: 'scaffold.ts', content: "path: 'C:\\\\temp'" });
    });

    it('omitting jsEscapeKeys (or an empty array) reproduces today\'s behavior exactly — no escaping', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({ path: 'a.txt', content: "Hello {{name}}!" });

      expect(kind.resolve(parsed, { name: "World's" })).toEqual({
        path: 'a.txt',
        content: "Hello World's!",
      });
    });

    it('never expression-resolves "jsEscapeKeys" — it is always the author\'s own literal list', () => {
      const def = definition({
        id: 'write-file-js-escape-literal',
        steps: [
          step('writeFile', {
            path: 'out.ts',
            content: "x: '{{x}}'",
            jsEscapeKeys: { var: 'untrustedKeys' },
          }),
        ],
      });
      const evaluator = new FakeEvaluator();

      expect(() => compileScaffold(def, evaluator).buildBlueprint({ x: "a'b", untrustedKeys: ['x'] })).toThrow();
      expect(evaluator.calls).toEqual([]);
    });

    it('composes independently with jsonEscapeKeys: each applies only to its own named keys', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'mixed.txt',
        content: '{ "json": "{{jsonVal}}" } -- jsString: \'{{jsVal}}\'',
        jsonEscapeKeys: ['jsonVal'],
        jsEscapeKeys: ['jsVal'],
      });

      const result = kind.resolve(parsed, { jsonVal: 'has "quotes"', jsVal: "has 'quotes'" });

      expect(result).toEqual({
        path: 'mixed.txt',
        content: '{ "json": "has \\"quotes\\"" } -- jsString: \'has \\\'quotes\\\'\'',
      });
    });
  });

  // Task 043 (.agents/specs/043-electron-stackfold-web-app-reauthor.md,
  // "Required core/ amendment"): `htmlEscapeKeys` HTML-escapes the named
  // context values for an HTML text node / double-quoted attribute
  // position before Handlebars renders `content` — mirrors
  // `jsonEscapeKeys`/`jsEscapeKeys` above exactly, same shape, different
  // escaping target. Exists because `web-app-stackfold`'s
  // `standalone-html` fragment (ported from the old `web-app` family's
  // hand-rolled `escapeHtml()`, Task 014's real XSS fix) would otherwise
  // silently lose that protection: `writeFile`'s `content` is compiled
  // with `noEscape: true` (this module's own header comment), so without
  // this field a free-text answer placed in HTML gets zero escaping.
  describe('htmlEscapeKeys (Task 043, "Required core/ amendment")', () => {
    it('HTML-escapes (&, <, >, ", \' — in that order) only the named context keys, leaving others untouched', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'index.html',
        content: '<title>{{appName}}</title><meta content="{{description}}">',
        htmlEscapeKeys: ['appName', 'description'],
      });

      const result = kind.resolve(parsed, {
        appName: `<img src=x onerror=alert(1)>`,
        description: 'A & B "quoted" \'single\'',
      });

      expect(result).toEqual({
        path: 'index.html',
        content:
          '<title>&lt;img src=x onerror=alert(1)&gt;</title>' +
          '<meta content="A &amp; B &quot;quoted&quot; &#39;single&#39;">',
      });
    });

    it('adversarial: a real <img src=x onerror=...> payload never becomes a live tag — it comes out fully entity-escaped', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'index.html',
        content: '<main><h1>{{appName}}</h1></main>',
        htmlEscapeKeys: ['appName'],
      });

      const result = kind.resolve(parsed, { appName: '<img src=x onerror=alert(1)>' });
      const html = result.content.toString();

      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('omitting htmlEscapeKeys (or an empty array) reproduces today\'s behavior exactly — no escaping', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({ path: 'a.txt', content: 'Hello {{name}}!' });

      expect(kind.resolve(parsed, { name: 'World <b>bold</b>' })).toEqual({
        path: 'a.txt',
        content: 'Hello World <b>bold</b>!',
      });
    });

    it('never expression-resolves "htmlEscapeKeys" — it is always the author\'s own literal list', () => {
      const def = definition({
        id: 'write-file-html-escape-literal',
        steps: [
          step('writeFile', {
            path: 'out.html',
            content: '<p>{{x}}</p>',
            htmlEscapeKeys: { var: 'untrustedKeys' },
          }),
        ],
      });
      const evaluator = new FakeEvaluator();

      expect(() => compileScaffold(def, evaluator).buildBlueprint({ x: '<b>a</b>', untrustedKeys: ['x'] })).toThrow();
      expect(evaluator.calls).toEqual([]);
    });

    it('composes independently with jsonEscapeKeys/jsEscapeKeys: each applies only to its own named keys', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'mixed.txt',
        content: '{ "json": "{{jsonVal}}" } -- jsString: \'{{jsVal}}\' -- html: {{htmlVal}}',
        jsonEscapeKeys: ['jsonVal'],
        jsEscapeKeys: ['jsVal'],
        htmlEscapeKeys: ['htmlVal'],
      });

      const result = kind.resolve(parsed, {
        jsonVal: 'has "quotes"',
        jsVal: "has 'quotes'",
        htmlVal: '<b>bold</b>',
      });

      expect(result).toEqual({
        path: 'mixed.txt',
        content:
          '{ "json": "has \\"quotes\\"" } -- jsString: \'has \\\'quotes\\\'\' -- html: &lt;b&gt;bold&lt;/b&gt;',
      });
    });
  });

  // Task 043 review follow-up (approved alongside `htmlEscapeKeys` above):
  // `scriptCloseEscapeKeys` breaks up any case-insensitive `</script`
  // substring before `content` is Handlebars-rendered. Exists because
  // `web-app-stackfold`'s `vite-vue` fragment ports the old
  // `web-app/fragments/vite-vue.ts`'s `App.vue` generation, which embeds a
  // free-text answer (`appName`) inside a `<script setup>` block via a
  // JSON-stringified JS string literal — without this field, a payload
  // containing a literal `</script` would split the generated SFC into two
  // sibling `<script>` blocks during Vue's own tag-scanning parse, the
  // exact regression the old fragment's own adversarial test ("App.vue
  // never lets a closing-script-tag payload break the SFC's own <script>
  // block") already guarded against.
  describe('scriptCloseEscapeKeys (Task 043 review follow-up)', () => {
    it('breaks up a case-insensitive </script substring for only the named context keys, leaving others untouched', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'App.vue',
        content: 'const A = "{{a}}"; const B = "{{b}}";',
        scriptCloseEscapeKeys: ['a'],
      });

      const result = kind.resolve(parsed, { a: 'evil</SCRIPT><script>', b: 'untouched</script>' });

      // Matches the old `escapeScriptClose()`'s own replacement text
      // exactly: `.replace(/<\/script/gi, '<\\/script')` substitutes a
      // fixed, lowercase literal regardless of the matched text's own
      // casing — a case-insensitive *match*, not a case-preserving one.
      expect(result).toEqual({
        path: 'App.vue',
        content: 'const A = "evil<\\/script><script>"; const B = "untouched</script>";',
      });
    });

    it('composes with jsonEscapeKeys in the same order the old vite-vue.ts fragment applied them: JSON-string-escape first, then the script-close guard', () => {
      // Mirrors the old web-app/fragments/vite-vue.ts's own
      // `escapeScriptClose(JSON.stringify(ctx.appName))` call order
      // exactly — `jsonEscapeKeys` resolves first, `scriptCloseEscapeKeys`
      // runs against its already-escaped result (core/authoring.ts's own
      // `writeFile` resolver doc comment).
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'App.vue',
        content: 'const APP_NAME = "{{appName}}";',
        jsonEscapeKeys: ['appName'],
        scriptCloseEscapeKeys: ['appName'],
      });

      const result = kind.resolve(parsed, { appName: 'evil</script><script>alert(1)</script>' });

      expect(result).toEqual({
        path: 'App.vue',
        content: 'const APP_NAME = "evil<\\/script><script>alert(1)<\\/script>";',
      });
    });

    // Ported, at the writeFile-action level, from the old
    // web-app-spa-plugin-vue.test.ts's own adversarial test of the exact
    // same name — real @vue/compiler-sfc parse, not a hand-rolled check —
    // proving the escaped output stays a single, well-formed <script
    // setup> block even against this exact payload.
    it("App.vue never lets a closing-script-tag payload break the SFC's own <script> block", async () => {
      const { parse } = await import('@vue/compiler-sfc');
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({
        path: 'App.vue',
        // `\{{ APP_NAME }}` (one literal backslash immediately before the
        // mustache, no space) is Handlebars's own escape syntax for a
        // literal, un-evaluated `{{ APP_NAME }}` in the output — needed
        // because this content is itself a Handlebars template compiled by
        // `compileTemplate()`, and `{{ APP_NAME }}` is genuinely the Vue
        // SFC's own interpolation syntax we want to end up in the
        // rendered output, not a Handlebars variable reference (there is
        // no `APP_NAME` answer).
        content:
          '<script setup lang="ts">\nconst APP_NAME = "{{appName}}";\n</script>\n\n<template>\n  <main>\n    <h1>\\{{ APP_NAME }}</h1>\n  </main>\n</template>\n',
        jsonEscapeKeys: ['appName'],
        scriptCloseEscapeKeys: ['appName'],
      });

      const payload = 'evil</script><script>alert(1)</script>';
      const result = kind.resolve(parsed, { appName: payload });
      const src = result.content.toString();

      const { descriptor, errors } = parse(src, { filename: 'App.vue' });
      expect(errors).toEqual([]);
      expect(descriptor.scriptSetup?.content).toContain('APP_NAME');
      expect(descriptor.template?.content).toContain('{{ APP_NAME }}');

      // eslint-disable-next-line no-eval
      const runtimeValue: unknown = eval(descriptor.scriptSetup!.content.match(/APP_NAME = (.*);/)![1]!);
      expect(runtimeValue).toBe(payload);
    });

    it('omitting scriptCloseEscapeKeys (or an empty array) reproduces today\'s behavior exactly — no escaping', () => {
      const kind = resolveAction('writeFile') as Extract<ActionKind, { tag: 'compose' }>;
      const parsed = kind.schema.parse({ path: 'a.txt', content: 'Hello {{name}}!' });

      expect(kind.resolve(parsed, { name: 'World</script>' })).toEqual({
        path: 'a.txt',
        content: 'Hello World</script>!',
      });
    });

    it('never expression-resolves "scriptCloseEscapeKeys" — it is always the author\'s own literal list', () => {
      const def = definition({
        id: 'write-file-script-close-escape-literal',
        steps: [
          step('writeFile', {
            path: 'out.vue',
            content: 'const x = "{{x}}";',
            scriptCloseEscapeKeys: { var: 'untrustedKeys' },
          }),
        ],
      });
      const evaluator = new FakeEvaluator();

      expect(() =>
        compileScaffold(def, evaluator).buildBlueprint({ x: '</script>', untrustedKeys: ['x'] })
      ).toThrow();
      expect(evaluator.calls).toEqual([]);
    });
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

describe('built-in action: patchFile (hook) — Task 034', () => {
  const PATH = 'src/cli/index.ts';
  const ANCHOR = '// stackfold-plugin-registry:end';

  function patchFileKind(): Extract<ActionKind, { tag: 'hook' }> {
    return resolveAction('patchFile') as Extract<ActionKind, { tag: 'hook' }>;
  }

  it('is registered as a "hook" action with literalKeys: ["anchor", "path"]', () => {
    const kind = patchFileKind();
    expect(kind.tag).toBe('hook');
    expect(kind.literalKeys).toEqual(['anchor', 'path']);
  });

  it('inserts "insert" immediately before the anchor line', async () => {
    const content = `a\n${ANCHOR}\nb\n`;
    const ports = fakePorts({ [PATH]: content });
    const kind = patchFileKind();
    const parsed = kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'new\n', position: 'before' });

    await kind.handler(parsed, ports, {});

    expect(await ports.fileWriter.readFile(PATH)).toBe(`a\nnew\n${ANCHOR}\nb\n`);
  });

  it('inserts "insert" immediately after the anchor line', async () => {
    const content = `a\n${ANCHOR}\nb\n`;
    const ports = fakePorts({ [PATH]: content });
    const kind = patchFileKind();
    const parsed = kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'new\n', position: 'after' });

    await kind.handler(parsed, ports, {});

    expect(await ports.fileWriter.readFile(PATH)).toBe(`a\n${ANCHOR}\nnew\nb\n`);
  });

  it('is idempotent: a second run with the same "insert" text already present is a no-op', async () => {
    const already = `a\nnew\n${ANCHOR}\nb\n`;
    const ports = fakePorts({ [PATH]: already });
    const kind = patchFileKind();
    const parsed = kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'new\n', position: 'before' });

    await kind.handler(parsed, ports, {});

    expect(await ports.fileWriter.readFile(PATH)).toBe(already);
  });

  it('throws loudly, never guessing an insertion point, when the anchor is missing from the file', async () => {
    const ports = fakePorts({ [PATH]: 'no anchor here\n' });
    const kind = patchFileKind();
    const parsed = kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'new\n', position: 'before' });

    await expect(kind.handler(parsed, ports, {})).rejects.toThrow(/anchor/i);
  });

  it('throws loudly when the target file does not exist', async () => {
    const ports = fakePorts(); // no files seeded
    const kind = patchFileKind();
    const parsed = kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'new\n', position: 'before' });

    await expect(kind.handler(parsed, ports, {})).rejects.toThrow(/does not exist/i);
  });

  it('rejects malformed params (missing position) via zod', () => {
    const kind = patchFileKind();
    expect(() => kind.schema.parse({ path: PATH, anchor: ANCHOR, insert: 'x' })).toThrow();
  });

  describe('expression resolution through compileScaffold()', () => {
    it('resolves "insert" against answers — composing a plugin-id-derived registration line', async () => {
      const content = `a\n${ANCHOR}\nb\n`;
      const ports = fakePorts({ [PATH]: content });
      const def = definition({
        id: 'patchfile-insert-resolved',
        hooks: {
          postInit: [step('patchFile', { path: PATH, anchor: ANCHOR, insert: { var: 'registrationLine' }, position: 'before' })],
        },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      await plugin.hooks!.postInit![0]!(ports, { registrationLine: 'myPlugin,\n' });

      expect(await ports.fileWriter.readFile(PATH)).toBe(`a\nmyPlugin,\n${ANCHOR}\nb\n`);
      expect(evaluator.calls).toContainEqual({ expr: { var: 'registrationLine' }, context: { registrationLine: 'myPlugin,\n' } });
    });

    it('never expression-resolves "anchor" — an expression-shaped anchor is rejected by zod, not silently resolved', async () => {
      const def = definition({
        id: 'patchfile-anchor-literal',
        hooks: {
          postInit: [
            step('patchFile', { path: PATH, anchor: { var: 'untrustedAnchor' }, insert: 'x', position: 'before' }),
          ],
        },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      await expect(plugin.hooks!.postInit![0]!(fakePorts(), { untrustedAnchor: ANCHOR })).rejects.toThrow();
      // The evaluator must never even be asked to resolve "anchor".
      expect(evaluator.calls).toEqual([]);
    });

    it('"path" stays literal — a plain string param is passed through untouched (not an expression evaluator call)', async () => {
      const content = `a\n${ANCHOR}\nb\n`;
      const ports = fakePorts({ [PATH]: content });
      const def = definition({
        id: 'patchfile-path-literal',
        hooks: { postInit: [step('patchFile', { path: PATH, anchor: ANCHOR, insert: 'x\n', position: 'before' })] },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      await plugin.hooks!.postInit![0]!(ports, {});

      expect(await ports.fileWriter.readFile(PATH)).toBe(`a\nx\n${ANCHOR}\nb\n`);
      expect(evaluator.calls).toEqual([]);
    });

    // Should-fix #4 (review_report.md): `path` runs uncontained (Invariant
    // A — `patchFile` is a hook, no `targetDir` containment at all), so an
    // answers-derived `path` must never be possible, mirroring `anchor`'s
    // own protection immediately above.
    it('never expression-resolves "path" — an expression-shaped path is rejected by zod, not silently resolved', async () => {
      const def = definition({
        id: 'patchfile-path-literal-rejected',
        hooks: {
          postInit: [
            step('patchFile', { path: { var: 'untrustedPath' }, anchor: ANCHOR, insert: 'x', position: 'before' }),
          ],
        },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      await expect(plugin.hooks!.postInit![0]!(fakePorts(), { untrustedPath: PATH })).rejects.toThrow();
      // The evaluator must never even be asked to resolve "path".
      expect(evaluator.calls).toEqual([]);
    });
  });
});

describe('built-in action: deriveAnswer (hook) — Task 036', () => {
  function deriveAnswerKind(): Extract<ActionKind, { tag: 'hook' }> {
    return resolveAction('deriveAnswer') as Extract<ActionKind, { tag: 'hook' }>;
  }

  it('is registered as a "hook" action with literalKeys: ["from", "to", "transform", "suffix"]', () => {
    const kind = deriveAnswerKind();
    expect(kind.tag).toBe('hook');
    expect(kind.literalKeys).toEqual(['from', 'to', 'transform', 'suffix']);
  });

  describe('transform: npm-slug', () => {
    it('slugifies a plain app name', async () => {
      const kind = deriveAnswerKind();
      const answers: Answers = { appName: 'My Cool App' };
      const parsed = kind.schema.parse({ from: 'appName', to: 'packageName', transform: 'npm-slug' });

      await kind.handler(parsed, fakePorts(), answers);

      expect(answers['packageName']).toBe('my-cool-app');
    });

    it.each([
      ['Ünïcödé Äpp', 'unicode-app'],
      ['UPPER CASE', 'upper-case'],
      ['weird!!!@@@name???', 'weird-name'],
      ['!!!', ''],
    ])('slugifies %j to %j (adversarial input)', async (appName, expected) => {
      const kind = deriveAnswerKind();
      const answers: Answers = { appName };
      const parsed = kind.schema.parse({ from: 'appName', to: 'packageName', transform: 'npm-slug' });

      await kind.handler(parsed, fakePorts(), answers);

      expect(answers['packageName']).toBe(expected);
    });
  });

  describe('transform: js-identifier-suffix', () => {
    it('camelCases and appends the given "suffix" — not hardcoded to "Api"', async () => {
      const kind = deriveAnswerKind();
      const answers: Answers = { packageName: 'my-cool-app' };
      const parsed = kind.schema.parse({
        from: 'packageName',
        to: 'bridgeGlobal',
        transform: 'js-identifier-suffix',
        suffix: 'Api',
      });

      await kind.handler(parsed, fakePorts(), answers);

      expect(answers['bridgeGlobal']).toBe('myCoolAppApi');
    });

    it('uses a different "suffix" to prove parametrization, not just the default-shaped case', async () => {
      const kind = deriveAnswerKind();
      const answers: Answers = { packageName: 'my-cool-app' };
      const parsed = kind.schema.parse({
        from: 'packageName',
        to: 'bridgeGlobal',
        transform: 'js-identifier-suffix',
        suffix: 'Bridge',
      });

      await kind.handler(parsed, fakePorts(), answers);

      expect(answers['bridgeGlobal']).toBe('myCoolAppBridge');
    });
  });

  describe('transform: current-year', () => {
    it('writes the real current year — no injectable clock', async () => {
      const kind = deriveAnswerKind();
      const answers: Answers = {};
      const parsed = kind.schema.parse({ from: 'unused', to: 'year', transform: 'current-year' });

      await kind.handler(parsed, fakePorts(), answers);

      expect(answers['year']).toBe(new Date().getFullYear());
    });
  });

  it('chains two deriveAnswer steps — npm-slug feeding js-identifier-suffix, mirroring electron-stackfold (future work)', async () => {
    const slugKind = deriveAnswerKind();
    const suffixKind = resolveAction('deriveAnswer') as Extract<ActionKind, { tag: 'hook' }>;
    const answers: Answers = { appName: 'My Cool App' };

    const slugParams = slugKind.schema.parse({ from: 'appName', to: 'packageName', transform: 'npm-slug' });
    await slugKind.handler(slugParams, fakePorts(), answers);

    const suffixParams = suffixKind.schema.parse({
      from: 'packageName',
      to: 'bridgeGlobal',
      transform: 'js-identifier-suffix',
      suffix: 'Api',
    });
    await suffixKind.handler(suffixParams, fakePorts(), answers);

    expect(answers).toEqual({
      appName: 'My Cool App',
      packageName: 'my-cool-app',
      bridgeGlobal: 'myCoolAppApi',
    });
  });

  it('rejects malformed params (invalid transform) via zod', () => {
    const kind = deriveAnswerKind();
    expect(() => kind.schema.parse({ from: 'x', to: 'y', transform: 'not-a-real-transform' })).toThrow();
  });

  describe('wired through the real pipeline (compileScaffold() → compileHookStep())', () => {
    it('a preInit deriveAnswer step, compiled via compileScaffold(), derives "packageName" into the real answers object passed to the compiled handler', async () => {
      const def = definition({
        id: 'derive-answer-preinit-wired',
        hooks: {
          preInit: [step('deriveAnswer', { from: 'appName', to: 'packageName', transform: 'npm-slug' })],
        },
      });
      const plugin = compileScaffold(def, new FakeEvaluator());
      const answers: Answers = { appName: 'My Cool App' };

      // Deliberately NOT calling buildBlueprint() first — mirrors the real
      // orchestrator's order (preInit fires before buildBlueprint()) and the
      // existing preInit precedent above. This exercises the actual
      // compileHookStep() call site — `kind.handler(parsedParams, ports,
      // answers)` — rather than calling `kind.handler` directly, which is
      // all the describe block above this one does.
      await plugin.hooks!.preInit![0]!(fakePorts(), answers);

      expect(answers['packageName']).toBe('my-cool-app');
    });
  });
});

// Task 042 (D-B, .agents/specs/042-plugin-builder-ts-authoring.md): a
// general-purpose "hook" action that runs an external command with the real
// invoking process's cwd — never `targetDir` — unlike `runCommand` (a
// `tag:'process'` action, always run with `cwd: targetDir` by
// `core/orchestrator.ts`'s `runPostActions()`). Exists so a hook (e.g.
// plugin-builder's own `postInit`) can shell out to `stackfold scaffold
// synth <dir>` against the repo root it was itself invoked from.
describe('built-in action: runHookCommand (hook) — Task 042 (D-B)', () => {
  function runHookCommandKind(): Extract<ActionKind, { tag: 'hook' }> {
    return resolveAction('runHookCommand') as Extract<ActionKind, { tag: 'hook' }>;
  }

  it('is registered as a "hook" action with an empty literalKeys (unlike patchFile/deriveAnswer)', () => {
    const kind = runHookCommandKind();
    expect(kind.tag).toBe('hook');
    expect(kind.literalKeys).toEqual([]);
  });

  it('runs the given command/args through ports.processRunner.run(), omitting "cwd" entirely — never targetDir', async () => {
    const calls: Array<{ command: string; args: string[]; options: { cwd?: string } | undefined }> = [];
    const ports: HookPorts = {
      prompter: {
        async ask() {
          return {};
        },
      },
      fileWriter: {
        async ensureEmptyDir() {},
        async writeFile() {},
        async readFile() {
          return undefined;
        },
        async overwriteFile() {},
      },
      processRunner: {
        async run(command, args, options) {
          calls.push({ command, args, options });
        },
      },
    };
    const kind = runHookCommandKind();
    const parsed = kind.schema.parse({
      command: 'npx',
      args: ['tsx', 'src/cli/index.ts', 'scaffold', 'synth', 'src/plugins/my-plugin'],
    });

    await kind.handler(parsed, ports, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('npx');
    expect(calls[0]!.args).toEqual(['tsx', 'src/cli/index.ts', 'scaffold', 'synth', 'src/plugins/my-plugin']);
    // The whole point of runHookCommand vs runCommand (D-B): cwd is never
    // passed at all — structurally impossible to configure, not merely
    // defaulted to undefined by an options object — so this always runs
    // with the real invoking process's cwd.
    expect(calls[0]!.options).toBeUndefined();
  });

  it('defaults args to an empty array when omitted', () => {
    const kind = runHookCommandKind();
    const parsed = kind.schema.parse({ command: 'git' });
    expect(parsed).toEqual({ command: 'git', args: [] });
  });

  it('rejects malformed params (empty command) via zod', () => {
    const kind = runHookCommandKind();
    expect(() => kind.schema.parse({ command: '   ', args: [] })).toThrow();
  });

  describe('expression resolution through compileScaffold() — literalKeys: [] means "args" entries may be computed from answers', () => {
    it('resolves an args entry built via { var: "pluginId" } JSON Logic against answers, unlike patchFile\'s anchor/path (which reject this via literalKeys)', async () => {
      const received: Array<{ command: string; args: string[] }> = [];
      const ports = fakePorts();
      ports.processRunner = {
        async run(command, args) {
          received.push({ command, args });
        },
      };

      const def = definition({
        id: 'run-hook-command-expr',
        hooks: {
          postInit: [step('runHookCommand', { command: 'npx', args: ['tsx', { var: 'pluginId' }] })],
        },
      });
      const evaluator = new FakeEvaluator();
      const plugin = compileScaffold(def, evaluator);

      await plugin.hooks!.postInit![0]!(ports, { pluginId: 'my-cool-plugin' });

      expect(received).toEqual([{ command: 'npx', args: ['tsx', 'my-cool-plugin'] }]);
    });
  });
});

/**
 * Direct unit coverage for `core/stringTransforms.ts` (Task 036). This
 * module has no `electron-ts`-specific test file of its own — its only
 * existing coverage was indirect, through `electron-ts-plugin.test.ts`'s
 * `resolveContext()` tests — and a new `tests/unit/stringTransforms.test.ts`
 * is out of this task's scope (`.agents/current_scope.json` names
 * `tests/unit/authoring.test.ts` only), so these cases live here instead,
 * in their own describe block. See the delegation's report for the explicit
 * flag to the Lead about whether a follow-up should relocate this block to
 * its own file.
 */
describe('core/stringTransforms.ts — toPackageName / toBridgeGlobal (Task 036, direct coverage)', () => {
  describe('toPackageName', () => {
    it('slugifies a plain, human-readable name', () => {
      expect(toPackageName('My Cool App')).toBe('my-cool-app');
    });

    it('normalizes accented/unicode characters by stripping combining diacritics', () => {
      expect(toPackageName('Ünïcödé Äpp')).toBe('unicode-app');
    });

    it('lowercases uppercase input', () => {
      expect(toPackageName('UPPER CASE')).toBe('upper-case');
    });

    it('collapses symbols/punctuation runs into single hyphens, trimmed at both ends', () => {
      expect(toPackageName('weird!!!@@@name???')).toBe('weird-name');
    });

    it('slugifies to an empty string when every character is stripped', () => {
      expect(toPackageName('!!!')).toBe('');
    });
  });

  describe('toBridgeGlobal', () => {
    it('camelCases a hyphenated package name and appends the given suffix', () => {
      expect(toBridgeGlobal('my-cool-app', 'Api')).toBe('myCoolAppApi');
    });

    it('requires an explicit suffix — a different suffix produces a different identifier', () => {
      expect(toBridgeGlobal('my-cool-app', 'Bridge')).toBe('myCoolAppBridge');
    });

    it('prefixes with "app" when the camelCased result would start with a digit', () => {
      expect(toBridgeGlobal('3d-viewer', 'Api')).toBe('app3dViewerApi');
    });

    it('produces a valid JS identifier for a digit immediately after a hyphen', () => {
      expect(toBridgeGlobal('app-2x', 'Api')).toBe('app2xApi');
    });
  });
});
