import Handlebars from 'handlebars';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionStep } from '../../src/core/authoring.js';
import type { Answers, QuestionDefinition } from '../../src/core/types.js';
import {
  composeFragments,
  mergeHooks,
  mountFragment,
  resetFragmentNamespaceRegistry,
  type Fragment,
} from '../../src/authoring/fragment.js';
import { JsonLogicExpressionEvaluator } from '../../src/infra/expressionEvaluator.js';

const evaluator = new JsonLogicExpressionEvaluator();

function renderHandlebars(content: string, answers: Answers): string {
  return Handlebars.compile(content, { noEscape: true, strict: false })(answers);
}

/** A minimal question, just enough shape for `mountFragment()`'s own concerns (id/type). */
function q(id: string, type: QuestionDefinition['type'] = 'input'): QuestionDefinition {
  return { id, message: id, type };
}

beforeEach(() => {
  resetFragmentNamespaceRegistry();
});

// ---------------------------------------------------------------------------
// D4 — namespace collision registry, owned by mountFragment() itself.
// ---------------------------------------------------------------------------

describe('mountFragment — namespace registry (D4)', () => {
  const emptyFragment = (): Fragment => ({ questions: [], steps: [] });

  it('mounts successfully the first time a namespace is used', () => {
    expect(() => mountFragment(emptyFragment, {}, { namespace: 'license' })).not.toThrow();
  });

  it('throws immediately, at mount time, when a namespace is reused', () => {
    mountFragment(emptyFragment, {}, { namespace: 'license' });
    expect(() => mountFragment(emptyFragment, {}, { namespace: 'license' })).toThrow(/license/);
  });

  it('throws before factory() runs for the colliding mount', () => {
    mountFragment(emptyFragment, {}, { namespace: 'license' });
    let factoryRan = false;
    const trackedFactory = (): Fragment => {
      factoryRan = true;
      return emptyFragment();
    };
    expect(() => mountFragment(trackedFactory, {}, { namespace: 'license' })).toThrow();
    expect(factoryRan).toBe(false);
  });

  it('resetFragmentNamespaceRegistry() allows a namespace to be reused across independent test cases', () => {
    mountFragment(emptyFragment, {}, { namespace: 'license' });
    resetFragmentNamespaceRegistry();
    expect(() => mountFragment(emptyFragment, {}, { namespace: 'license' })).not.toThrow();
  });

  it('two different namespaces never collide with each other', () => {
    expect(() => {
      mountFragment(emptyFragment, {}, { namespace: 'license' });
      mountFragment(emptyFragment, {}, { namespace: 'readme' });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// D1/D3 — default namespaced questions + explicit `inputs` override wiring.
// ---------------------------------------------------------------------------

describe('mountFragment — default namespacing + inputs override (D1/D3)', () => {
  const licenseFragment = (): Fragment => ({
    questions: [q('author'), q('includeAuthor', 'confirm')],
    steps: [{ action: 'writeFile', params: { path: 'LICENSE', content: '{{author}}' } }],
  });

  it('namespaces every local question id to "${namespace}__${id}" by default', () => {
    const mounted = mountFragment(licenseFragment, {}, { namespace: 'license' });
    expect(mounted.questions.map((question) => question.id)).toEqual(['license__author', 'license__includeAuthor']);
  });

  it('an id overridden via "inputs" is omitted entirely from questions[]', () => {
    const mounted = mountFragment(licenseFragment, {}, {
      namespace: 'license',
      inputs: { author: 'root__author' },
    });
    expect(mounted.questions.map((question) => question.id)).toEqual(['license__includeAuthor']);
  });

  it('rewrites internal references to an overridden id to the external id, not a namespaced one', () => {
    const mounted = mountFragment(licenseFragment, {}, {
      namespace: 'license',
      inputs: { author: 'root__author' },
    });
    const step = mounted.steps[0] as ActionStep;
    expect((step.params as { content: string }).content).toBe('{{root__author}}');
  });

  it('never calls factory() with live answers — only the authoring-time props it was given', () => {
    const propsSeen: unknown[] = [];
    const factory = (props: { greeting: string }): Fragment => {
      propsSeen.push(props);
      return { questions: [], steps: [] };
    };
    mountFragment(factory, { greeting: 'hi' }, { namespace: 'ns' });
    expect(propsSeen).toEqual([{ greeting: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// D5 — rewrite engine, ported from the Task 040 spike
// (.agents/scratch/spike-namespace-rewrite.mjs). Render-output equivalence
// is the actual assertion in every case: compile the fragment unnamespaced
// (against local-id answers) and namespaced (against qualified-id answers,
// via a real mountFragment() call), and compare the two real renders.
// ---------------------------------------------------------------------------

describe('mountFragment — Handlebars rewrite engine (D5, ported spike battery)', () => {
  /** Mounts a single writeFile fragment with the given template as its content, returning the rewritten content. */
  function mountedContent(tpl: string, localIds: string[], namespace = 'license'): string {
    const fragment = (): Fragment => ({
      questions: localIds.map((id) => q(id)),
      steps: [{ action: 'writeFile', params: { path: 'OUT', content: tpl } }],
    });
    const mounted = mountFragment(fragment, {}, { namespace });
    const step = mounted.steps[0] as ActionStep;
    return (step.params as { content: string }).content;
  }

  it('bare var simple', () => {
    const tpl = 'Copyright (c) {{author}}';
    const rendA = renderHandlebars(tpl, { author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author']), { license__author: 'Camilo' });
    expect(rendB).toBe(rendA);
  });

  it('adversarial: id is a substring of another identifier (authorEmail) — never touched', () => {
    const tpl = 'Contact: {{authorEmail}}, by {{author}}';
    const rendA = renderHandlebars(tpl, { authorEmail: 'c@x.com', author: 'Camilo' });
    const rewritten = mountedContent(tpl, ['author']);
    expect(rewritten).toContain('{{authorEmail}}');
    expect(rewritten).not.toContain('license__authorEmail');
    const rendB = renderHandlebars(rewritten, { authorEmail: 'c@x.com', license__author: 'Camilo' });
    expect(rendB).toBe(rendA);
  });

  it('#if block + bare var inside', () => {
    const tpl = '{{#if includeAuthor}}Author: {{author}}{{/if}}';
    const rendA = renderHandlebars(tpl, { includeAuthor: true, author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author', 'includeAuthor']), {
      license__includeAuthor: true,
      license__author: 'Camilo',
    });
    expect(rendB).toBe(rendA);
  });

  it('#unless block', () => {
    const tpl = '{{#unless includeAuthor}}Anonymous{{/unless}}{{#if includeAuthor}}{{author}}{{/if}}';
    const rendA = renderHandlebars(tpl, { includeAuthor: false, author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author', 'includeAuthor']), {
      license__includeAuthor: false,
      license__author: 'Camilo',
    });
    expect(rendB).toBe(rendA);
  });

  it('varied internal whitespace: {{ author }}, {{#if  includeAuthor }}', () => {
    const tpl = '{{ author }} / {{#if  includeAuthor }}yes{{/if}}';
    const rendA = renderHandlebars(tpl, { author: 'Camilo', includeAuthor: true });
    const rendB = renderHandlebars(mountedContent(tpl, ['author', 'includeAuthor']), {
      license__author: 'Camilo',
      license__includeAuthor: true,
    });
    expect(rendB).toBe(rendA);
  });

  it('{{else}} with no id passes through untouched', () => {
    const tpl = '{{#if includeAuthor}}{{author}}{{else}}anon{{/if}}';
    const rendA = renderHandlebars(tpl, { includeAuthor: false, author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author', 'includeAuthor']), {
      license__includeAuthor: false,
      license__author: 'Camilo',
    });
    expect(rendB).toBe(rendA);
  });

  it('multiple occurrences of the same id', () => {
    const tpl = '{{author}} wrote this. Thanks {{author}}!';
    const rendA = renderHandlebars(tpl, { author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author']), { license__author: 'Camilo' });
    expect(rendB).toBe(rendA);
  });

  it('id inside a JSON-escaped string (same shape as a real package.json template)', () => {
    const tpl = '{\n  "author": "{{author}}"\n}';
    const rendA = renderHandlebars(tpl, { author: 'Camilo' });
    const rendB = renderHandlebars(mountedContent(tpl, ['author']), { license__author: 'Camilo' });
    expect(rendB).toBe(rendA);
  });

  it('nesting: a fragment-internal mountFragment() call is namespaced again by the outer mount, two levels deep', () => {
    // Mimics the spec's recursive-by-construction invariant (D2/Step 0 item
    // 4): readmeFragment() internally mounts licenseFragment() under
    // 'license', producing an already-qualified 'license__author' id; the
    // outer mount (namespace 'readme') must prefix that once more, to
    // 'readme__license__author' — no special-cased nesting logic anywhere.
    const innerLicenseFragment = (): Fragment => ({
      questions: [q('author')],
      steps: [{ action: 'writeFile', params: { path: 'LICENSE', content: '{{author}}' } }],
    });
    const outerReadmeFragment = (): Fragment => {
      const license = mountFragment(innerLicenseFragment, {}, { namespace: 'license' });
      return {
        questions: [...license.questions],
        steps: [
          ...license.steps,
          { action: 'writeFile', params: { path: 'README.md', content: 'See {{license__author}}' } },
        ],
      };
    };

    const mounted = mountFragment(outerReadmeFragment, {}, { namespace: 'readme' });
    expect(mounted.questions.map((question) => question.id)).toEqual(['readme__license__author']);

    const licenseStep = mounted.steps[0] as ActionStep;
    const readmeStep = mounted.steps[1] as ActionStep;
    expect((licenseStep.params as { content: string }).content).toBe('{{readme__license__author}}');
    expect((readmeStep.params as { content: string }).content).toBe('See {{readme__license__author}}');

    const rendA = renderHandlebars('See {{license__author}}', { license__author: 'Camilo' });
    const rendB = renderHandlebars((readmeStep.params as { content: string }).content, {
      readme__license__author: 'Camilo',
    });
    expect(rendB).toBe(rendA);
  });
});

describe('mountFragment — JSONLogic rewrite engine (D5, ported spike battery)', () => {
  /** Mounts a fragment whose single step gates on `when`, returning the rewritten `when`. */
  function mountedWhen(when: unknown, localIds: string[], namespace = 'license'): unknown {
    const fragment = (): Fragment => ({
      questions: localIds.map((id) => q(id)),
      steps: [{ action: 'mkdir', params: { path: 'x' }, when }],
    });
    const mounted = mountFragment(fragment, {}, { namespace });
    return (mounted.steps[0] as ActionStep).when;
  }

  it('var simple', () => {
    const expr = { var: 'author' };
    const a = evaluator.evaluate(expr, { author: 'x' });
    const rewritten = mountedWhen(expr, ['author']);
    const b = evaluator.evaluate(rewritten, { license__author: 'x' });
    expect(b).toEqual(a);
  });

  it('nested and/!== mixed with a literal', () => {
    const expr = { and: [{ var: 'includeAuthor' }, { '!==': [{ var: 'author' }, ''] }] };
    const a = evaluator.evaluate(expr, { includeAuthor: true, author: 'x' });
    const rewritten = mountedWhen(expr, ['author', 'includeAuthor']);
    const b = evaluator.evaluate(rewritten, { license__includeAuthor: true, license__author: 'x' });
    expect(b).toEqual(a);
  });

  it('a var absent from the fragment\'s own questions (e.g. a shared root id like appName) is left untouched', () => {
    const expr = { var: 'appName' };
    const a = evaluator.evaluate(expr, { appName: 'root-val' });
    const rewritten = mountedWhen(expr, []);
    expect(rewritten).toEqual(expr);
    const b = evaluator.evaluate(rewritten, { appName: 'root-val' });
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// composeFragments() / mergeHooks() — purely structural merge (D4
// simplification), same concat-by-HookName semantics as
// core/authoring.ts's compileHooks().
// ---------------------------------------------------------------------------

describe('composeFragments()', () => {
  it('concatenates questions/steps across fragments, in declaration order', () => {
    const a: Fragment = { questions: [q('a1')], steps: [{ action: 'mkdir', params: { path: 'a' } }] };
    const b: Fragment = { questions: [q('b1')], steps: [{ action: 'mkdir', params: { path: 'b' } }] };

    const composed = composeFragments(a, b);

    expect(composed.questions.map((question) => question.id)).toEqual(['a1', 'b1']);
    expect(composed.steps.map((step) => (step.params as { path: string }).path)).toEqual(['a', 'b']);
  });

  it('merges hooks per HookName, concatenating in declaration order', () => {
    const a: Fragment = {
      questions: [],
      steps: [],
      hooks: { postInit: [{ action: 'patchFile', params: { path: '1' } }] },
    };
    const b: Fragment = {
      questions: [],
      steps: [],
      hooks: { postInit: [{ action: 'patchFile', params: { path: '2' } }], preInit: [{ action: 'deriveAnswer', params: {} }] },
    };

    const composed = composeFragments(a, b);

    expect(composed.hooks?.postInit?.map((step) => (step.params as { path: string }).path)).toEqual(['1', '2']);
    expect(composed.hooks?.preInit).toHaveLength(1);
  });

  it('omits "hooks" entirely when no fragment declares any', () => {
    const composed = composeFragments({ questions: [], steps: [] }, { questions: [], steps: [] });
    expect('hooks' in composed).toBe(false);
  });

  it('does no collision detection of its own — that is mountFragment()\'s job (D4)', () => {
    // Two fragments with a literally duplicate question id compose without
    // throwing; catching this is synth.ts's D6 refine's job, not
    // composeFragments()'s.
    const a: Fragment = { questions: [q('dup')], steps: [] };
    const b: Fragment = { questions: [q('dup')], steps: [] };
    expect(() => composeFragments(a, b)).not.toThrow();
    expect(composeFragments(a, b).questions).toHaveLength(2);
  });
});

describe('mergeHooks()', () => {
  it('returns undefined when both inputs are undefined', () => {
    expect(mergeHooks(undefined, undefined)).toBeUndefined();
  });

  it('returns the other side untouched (shape-wise) when one side is undefined', () => {
    const hooks = { postInit: [{ action: 'patchFile', params: { path: '1' } }] };
    expect(mergeHooks(hooks, undefined)).toEqual(hooks);
    expect(mergeHooks(undefined, hooks)).toEqual(hooks);
  });

  it('concatenates matching HookName arrays from both sides, in order', () => {
    const a = { postInit: [{ action: 'patchFile', params: { path: '1' } }] };
    const b = { postInit: [{ action: 'patchFile', params: { path: '2' } }] };
    expect(mergeHooks(a, b)).toEqual({
      postInit: [{ action: 'patchFile', params: { path: '1' } }, { action: 'patchFile', params: { path: '2' } }],
    });
  });
});
