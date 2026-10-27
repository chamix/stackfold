/**
 * Fragments namespaced (SK-ADR-003 Cycle 2, Task 041,
 * .agents/specs/041-scaffold-synth-fragments-cycle2.md). Lets a reusable
 * `Fragment` — the same shape as a `ScaffoldDefinition` minus
 * `id`/`description`/`help` (D1) — be written once with un-prefixed,
 * fragment-local ids, then mounted into a root scaffold (or another
 * fragment) under a caller-chosen `namespace`, with every internal
 * reference (`writeFile`'s Handlebars `content`, every other `params`
 * field, and `when`) rewritten to match, with zero special-casing for
 * nesting (D2).
 *
 * Inward Dependency Rule, tooling layer (peer of `infra/`, not `core/`
 * itself): only *types* (`ActionStep`, `ScaffoldDefinition`) and the
 * `resolveAction()` *lookup* are imported from `core/authoring.ts` — this
 * module never calls `compileScaffold()`/`buildBlueprint()` itself (see
 * `mountFragment()`'s own doc comment). `core/authoring.ts` gains zero new
 * dependents it didn't already have (`src/authoring/synth.ts` already
 * imports `compileScaffold()`); `resolveAction()` was already exported for
 * exactly this kind of external, read-only lookup.
 *
 * Separator (D2, Task 040 spike — see
 * `.agents/handoff-scaffold-synth-namespace-separator.md`): the real,
 * mechanical separator is `__` (double underscore), confirmed against real
 * Handlebars/json-logic-js render output — both engines give `.` a
 * property-navigation meaning neither `Answers` (a flat
 * `Record<string, AnswerValue>`, `core/types.ts`, unchanged by this task)
 * nor these templates ever intend. Dotted notation (`license.author`) is
 * prose-only convention in comments/docs, never a literal string here.
 */
import type { ActionStep, ScaffoldDefinition } from '../core/authoring.js';
import { resolveAction } from '../core/authoring.js';
import type { HookName, QuestionDefinition } from '../core/types.js';

/** D1 — same shape as `ScaffoldDefinition`, minus the root-only identity fields. */
export type Fragment = Omit<ScaffoldDefinition, 'id' | 'description' | 'help'>;

/** A fragment author's entry point: pure, synchronous, authoring-time-only — never reads real `answers` (Step 0 edge-case invariant). */
export type FragmentFactory<Props> = (props: Props) => Fragment;

export interface MountFragmentOptions {
  /** Namespace this mount is registered under — must be unique across the whole `stackfold scaffold synth` process (D4). */
  namespace: string;
  /**
   * Explicit, by-id wiring (D3) from a fragment-local question id to an
   * already-in-scope external id (another namespace's qualified id, or a
   * root id) — never auto-detected by name. A local id present here is
   * omitted entirely from the mounted fragment's `questions[]`; every
   * internal reference to it is rewritten to the external id instead.
   */
  inputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// D4 — namespace collision registry, owned by mountFragment() itself.
// ---------------------------------------------------------------------------

/**
 * Module-level, mutable by design (see this module's header + the spec's
 * "Implicaciones de este diseño" section): safe across real production runs
 * because one `stackfold scaffold synth <dir>` invocation is one process: a
 * fresh, empty registry every time. Only a long-lived process — a `vitest`
 * run exercising many independent scaffolds — needs the explicit reset
 * below between cases.
 */
const usedNamespaces = new Set<string>();

/** Test-isolation hook — call from `beforeEach()`/`afterEach()` so unrelated test cases don't see each other's namespaces as already taken. */
export function resetFragmentNamespaceRegistry(): void {
  usedNamespaces.clear();
}

// ---------------------------------------------------------------------------
// Rewrite engine (D5), ported from the Task 040 spike
// (.agents/scratch/spike-namespace-rewrite.mjs) — same regex/walk, same
// render-output-equivalence contract, now wired to a real idMap built per
// `mountFragment()` call instead of a hand-built one in a throwaway script.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handlebars text rewrite — regex with word boundaries over the mustache
 * grammar `core/authoring.ts`'s `compileTemplate()` actually compiles
 * (`{{id}}`, `{{#if id}}`, `{{#unless id}}`, `{{else}}` unchanged since it
 * never carries an id). Only ids present in `idMap` are ever touched — an
 * id that is merely a substring of another (`author` inside
 * `authorEmail`) is never matched, confirmed by the spike's adversarial
 * case. Applies only to `writeFile`'s `content` (D5) — the one action with
 * template-shaped content today.
 */
function rewriteHandlebarsIds(template: string, idMap: ReadonlyMap<string, string>): string {
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return template;

  const idsPattern = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const blockRe = new RegExp(`\\{\\{(#if|#unless)\\s+(${idsPattern})\\s*\\}\\}`, 'g');
  const bareRe = new RegExp(`\\{\\{\\s*(${idsPattern})\\s*\\}\\}`, 'g');

  let out = template.replace(blockRe, (_m, kw: string, id: string) => `{{${kw} ${idMap.get(id)}}}`);
  out = out.replace(bareRe, (_m, id: string) => `{{${idMap.get(id)}}}`);
  return out;
}

/**
 * Structural JSONLogic walk — recursively renames every `{ var: localId }`
 * leaf found anywhere inside `expr` (arrays walked element-by-element,
 * objects walked key-by-key) whenever `localId` is a known fragment-local
 * id; anything else (a literal, an id not owned by this fragment — e.g. a
 * shared root id like `appName`) passes through untouched. Same walk shape
 * `core/authoring.ts`'s own `resolveValue()` already uses to find
 * expression-shaped values, reimplemented here because renaming an id at
 * `synth` time is a distinct concern from evaluating an expression against
 * live `answers` at `buildBlueprint()` time.
 */
function rewriteJsonLogicIds(expr: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(expr)) {
    return expr.map((item) => rewriteJsonLogicIds(item, idMap));
  }
  if (isPlainObject(expr)) {
    if ('var' in expr && typeof expr.var === 'string' && idMap.has(expr.var)) {
      return { var: idMap.get(expr.var) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(expr)) {
      out[key] = rewriteJsonLogicIds(value, idMap);
    }
    return out;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Id-bearing literalKeys (Task 047, backlog items 3-4 — same review,
// 2026-10-24, as the rest of this module's rewrite engine).
//
// `literalKeys` (`core/authoring.ts`'s own `resolveParams()` contract)
// means exactly one thing there: "never expression-resolve this field
// against live `answers` at `buildBlueprint()` time." It does NOT mean
// "this field never contains a fragment-local id" — `writeFile.content`
// is the first, already-handled exception (a literalKey that DOES carry
// local ids, just as Handlebars placeholders, rewritten by
// `rewriteHandlebarsIds()` above instead of the generic JSONLogic walk).
// These two are the same exception, generalized: specific literalKeys
// fields, on specific actions, whose value is itself a plain local-id
// string (or array of them) rather than opaque scaffold-authoring config
// — so a plain idMap lookup (no Handlebars parsing, no JSONLogic walk)
// is the correct rewrite for them.
//
// `writeFile`'s `jsonEscapeKeys`/`jsEscapeKeys`/`htmlEscapeKeys`/
// `scriptCloseEscapeKeys` are all listed here, not just `jsonEscapeKeys`
// (the one backlog named): all four share the exact same shape and the
// exact same bug (`core/authoring.ts`'s own doc comments on each confirm
// they're deliberately identical in everything but escaping target —
// `jsEscapeKeys`/`htmlEscapeKeys`/`scriptCloseEscapeKeys` were added in
// Tasks 042/043, after the backlog note was written against the first
// one). Fixing only the named field would leave the three later ones
// with the identical latent gap.
//
// `deriveAnswer`'s `transform`/`suffix` are deliberately absent from its
// entry below — they are genuine opaque literals (an enum selector, a
// fixed suffix string), never an id reference, unlike `from`/`to`.
const ID_BEARING_LITERAL_KEYS: Readonly<
  Record<string, { readonly arrayFields?: readonly string[]; readonly stringFields?: readonly string[] }>
> = {
  writeFile: {
    arrayFields: ['jsonEscapeKeys', 'jsEscapeKeys', 'htmlEscapeKeys', 'scriptCloseEscapeKeys'],
  },
  deriveAnswer: {
    stringFields: ['from', 'to'],
  },
};

/**
 * `deriveAnswer`'s `to` is the one field in the whole vocabulary that
 * *introduces* a brand-new, fragment-local answers key, rather than
 * referencing one already known from `local.questions` (D1) — unlike a
 * declared question id, it never reaches `idMap` through the normal D1
 * loop in `mountFragment()`, below. Walks `steps[]` plus every hook
 * group's steps once, up front, registering each `to` into `idMap`
 * namespaced exactly like a question id (`${namespace}__${to}`) — before
 * the real rewrite pass (`rewriteStep()`/`rewriteParams()`) runs, so a
 * `from` anywhere else that reads this derived key (same hook group, a
 * different one, or `steps[]`), or a Handlebars `{{to}}` placeholder, or
 * an escape-key-family entry naming it, all resolve to the same
 * qualified id.
 *
 * Deliberately a flat collect-then-rewrite, not a single mutating walk
 * in declaration order: a `to` doesn't carry runtime step-ordering
 * information worth encoding here — only "does this literal string name
 * a locally introduced id" — and a `from` reading a `to` that hasn't
 * actually run yet at the real orchestrator's runtime is already
 * possible (and already the fragment author's own mistake) with zero
 * namespacing involved, unaffected by which pass-ordering this rewrite
 * step picks.
 */
function collectDerivedAnswerIds(
  allSteps: readonly ActionStep[],
  namespace: string,
  idMap: Map<string, string>
): void {
  for (const step of allSteps) {
    if (step.action !== 'deriveAnswer' || !isPlainObject(step.params)) continue;
    const to = step.params.to;
    if (typeof to === 'string' && to.length > 0 && !idMap.has(to)) {
      idMap.set(to, `${namespace}__${to}`);
    }
  }
}

/**
 * Rewrites one `ActionStep`'s `params`/`when` against `idMap`. `literalKeys`
 * (from `resolveAction(step.action)`, same source `core/authoring.ts`'s own
 * `resolveParams()` uses) names top-level `params` keys that are never
 * walked structurally as JSONLogic — most of them (`patchFile`'s
 * `anchor`/`path`, `deriveAnswer`'s `transform`/`suffix`) are genuine
 * opaque literals, left exactly as the fragment author wrote them. Three
 * narrow, documented exceptions carry local ids anyway and get rewritten
 * through a different path instead: `writeFile`'s `content` (Handlebars
 * text rewrite, D5, immediately below) and the `ID_BEARING_LITERAL_KEYS`
 * fields (Task 047 — plain idMap lookup, `rewriteIdBearingLiteral()`).
 */
function rewriteStep(step: ActionStep, idMap: ReadonlyMap<string, string>): ActionStep {
  const literalKeys = resolveAction(step.action)?.literalKeys ?? [];
  const params = rewriteParams(step.action, step.params, idMap, literalKeys);
  const when = step.when !== undefined ? rewriteJsonLogicIds(step.when, idMap) : undefined;

  return { action: step.action, params, ...(when !== undefined ? { when } : {}) };
}

/** A local id passes through unchanged if `idMap` has no entry for it — same "unknown id, leave it alone" convention `rewriteJsonLogicIds()` already applies. */
function rewriteIdBearingLiteral(value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === 'string' ? idMap.get(entry) ?? entry : entry));
  }
  return value;
}

function rewriteParams(
  action: string,
  params: unknown,
  idMap: ReadonlyMap<string, string>,
  literalKeys: readonly string[]
): unknown {
  if (!isPlainObject(params)) {
    return params;
  }

  const idBearing = ID_BEARING_LITERAL_KEYS[action];

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!literalKeys.includes(key)) {
      out[key] = rewriteJsonLogicIds(value, idMap);
    } else if (idBearing?.arrayFields?.includes(key) || idBearing?.stringFields?.includes(key)) {
      out[key] = rewriteIdBearingLiteral(value, idMap);
    } else {
      out[key] = value;
    }
  }

  if (action === 'writeFile' && typeof out.content === 'string') {
    out.content = rewriteHandlebarsIds(out.content, idMap);
  }

  return out;
}

function rewriteHooks(
  hooks: Partial<Record<HookName, ActionStep[]>>,
  idMap: ReadonlyMap<string, string>
): Partial<Record<HookName, ActionStep[]>> {
  const out: Partial<Record<HookName, ActionStep[]>> = {};
  for (const hookName of Object.keys(hooks) as HookName[]) {
    const steps = hooks[hookName];
    if (!steps) continue;
    out[hookName] = steps.map((step) => rewriteStep(step, idMap));
  }
  return out;
}

// ---------------------------------------------------------------------------
// mountFragment() — D3 (default/override inputs) + D4 (collision registry)
// ---------------------------------------------------------------------------

/**
 * Invokes `factory(props)` and returns a new `Fragment` with every local id
 * namespaced (D1-D3), after first registering `namespace` in the
 * module-level collision registry (D4) — throws immediately, before
 * `factory()` even runs, if `namespace` was already used by an earlier
 * `mountFragment()` call in this process (or this `vitest` run, absent an
 * explicit `resetFragmentNamespaceRegistry()` between cases).
 *
 * Never writes to disk, never calls `compileScaffold()`/`buildBlueprint()`/
 * `synth()` — purely a data transform. The caller composes the result into
 * a real `ScaffoldDefinition` (directly, or via `composeFragments()`) and
 * passes that through Cycle 1's unchanged `synth()` pipeline.
 */
export function mountFragment<Props>(
  factory: FragmentFactory<Props>,
  props: Props,
  options: MountFragmentOptions
): Fragment {
  const { namespace, inputs = {} } = options;

  if (usedNamespaces.has(namespace)) {
    throw new Error(`mountFragment: namespace "${namespace}" is already in use — choose a different namespace`);
  }
  usedNamespaces.add(namespace);

  const local = factory(props);

  const idMap = new Map<string, string>();
  const questions: QuestionDefinition[] = [];

  for (const question of local.questions) {
    const override = inputs[question.id];
    if (override !== undefined) {
      // D3: explicit override — never re-asked, omitted from questions[].
      idMap.set(question.id, override);
      continue;
    }
    const qualified = `${namespace}__${question.id}`;
    idMap.set(question.id, qualified);
    questions.push({ ...question, id: qualified });
  }

  // Task 047 — register every `deriveAnswer.to` across *all* of this
  // fragment's steps (root `steps[]` and every hook group) into `idMap`
  // before any rewriting happens, so it behaves exactly like a declared
  // question id to every `from`/escape-key-family/Handlebars reference
  // that reads it, regardless of which step or hook group either side
  // lives in. See `collectDerivedAnswerIds()`'s own doc comment for why
  // this is a separate, up-front pass rather than folded into the walk
  // below.
  const allLocalSteps = [...local.steps, ...Object.values(local.hooks ?? {}).flat()];
  collectDerivedAnswerIds(allLocalSteps, namespace, idMap);

  const steps = local.steps.map((step) => rewriteStep(step, idMap));
  const hooks = local.hooks ? rewriteHooks(local.hooks, idMap) : undefined;

  return { questions, steps, ...(hooks ? { hooks } : {}) };
}

// ---------------------------------------------------------------------------
// composeFragments() / mergeHooks() — D4 simplification: purely structural
// merge, no collision logic of its own (that responsibility is fully
// covered by mountFragment()'s registry, above).
// ---------------------------------------------------------------------------

/**
 * Concatenates `hooks` across two (possibly absent) hook maps, per
 * `HookName`, in declaration order — the exact same semantics
 * `core/authoring.ts`'s `compileHooks()` already applies when a single
 * `ScaffoldDefinition` declares multiple steps under one lifecycle moment.
 * Returns `undefined` when the merged result would carry no hooks at all,
 * matching `ScaffoldDefinition.hooks`/`Fragment.hooks`'s own "absent is a
 * fully supported state" convention.
 */
export function mergeHooks(
  a: Partial<Record<HookName, ActionStep[]>> | undefined,
  b: Partial<Record<HookName, ActionStep[]>> | undefined
): Partial<Record<HookName, ActionStep[]>> | undefined {
  if (!a && !b) return undefined;

  const out: Partial<Record<HookName, ActionStep[]>> = {};
  const names = new Set<HookName>([...(a ? (Object.keys(a) as HookName[]) : []), ...(b ? (Object.keys(b) as HookName[]) : [])]);

  for (const name of names) {
    const merged = [...(a?.[name] ?? []), ...(b?.[name] ?? [])];
    if (merged.length > 0) out[name] = merged;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Purely structural merge (D4): concatenates `questions`/`steps` across all
 * given fragments in declaration order, and merges `hooks` the same way
 * `mergeHooks()` does above. No validation of its own — every fragment that
 * reaches here already passed through `mountFragment()`'s namespace
 * registry (or was authored directly without namespacing, the caller's
 * choice), and the eventual flattened `ScaffoldDefinition` still goes
 * through `synth.ts`'s structural validation (including the D6
 * duplicate-`questions[].id` refine) before anything is written.
 */
export function composeFragments(...fragments: Fragment[]): Fragment {
  const questions = fragments.flatMap((fragment) => fragment.questions);
  const steps = fragments.flatMap((fragment) => fragment.steps);
  const hooks = fragments.reduce<Partial<Record<HookName, ActionStep[]>> | undefined>(
    (acc, fragment) => mergeHooks(acc, fragment.hooks),
    undefined
  );

  return { questions, steps, ...(hooks ? { hooks } : {}) };
}
