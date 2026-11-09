/**
 * Pure interpreter for `QuestionConstraints` (SYNTH-002,
 * `.agents/specs/synth-002-declarative-validation.md` D2; SK-ADR-010). No
 * I/O, no `ExpressionEvaluator`/JSONLogic — JSONLogic has no regex operator
 * and `infra/expressionEvaluator.ts`'s header comment forbids adding one
 * (security: no custom operators). `compileConstraints()` validates the
 * *shape* of `constraints` and precompiles every regex exactly once
 * (fail-fast — invariant 5 of the spec): a malformed `constraints` object
 * throws synchronously here, at compile time, never at answer-validation
 * time.
 *
 * Inward Dependency Rule: this module imports only `core/types.ts` — no
 * `infra/`, no third-party library beyond the language's own `RegExp`.
 *
 * Evaluation order (fixed, never author-configurable): `trim` (if set) ->
 * `minLength` -> `maxLength` -> `rules` in declared array order. The first
 * violated check's `message` wins. The trimmed value is what's measured and
 * matched against — the stored answer itself is never altered (mirrors
 * `toValidate(zod.trim())`'s existing semantics in `core/validation.ts`).
 *
 * Length measurement (amends D1's text, grounded against the real
 * dependency rather than the spec's own paraphrase — SYNTH-002's own
 * instruction: "el ingeniero lo confirma leyendo los schemas reales"):
 * `minLength`/`maxLength` count Unicode *code points*, not UTF-16 code
 * units — confirmed by reading `zod`'s own `$ZodCheckMaxLength`/
 * `$ZodCheckMinLength` (`node_modules/zod/v4/core/checks.js`), which
 * explicitly measures "Unicode code points, not UTF-16 units" so a
 * surrogate-pair emoji counts once, not twice. `tests/unit/
 * core-constraints-differential.test.ts` is what caught this —  a
 * UTF-16-code-unit measurement (the literal D1 text) is NOT equivalent to
 * the zod schemas being migrated for any string containing an astral
 * code point (e.g. an emoji), which SYNTH-002 acceptance criterion 1
 * explicitly requires covering. `countCodePoints()` below mirrors zod's
 * exact counting rule (every valid low/high surrogate pair counts as one;
 * an unpaired surrogate counts as one unit, same as a native `for...of`/
 * `Array.from` string iteration already does).
 *
 * ReDoS (D6, `.claude/knowledge/security/general.md` "Input validation"):
 * regex sources are author-written, synth-time data — same trust model as
 * a scaffold's own Handlebars templates (`core/authoring.ts`'s header
 * comment on "Untrusted code execution"). A pathological regex here can
 * only hang the validation of that author's own plugin; no sandbox or
 * timeout is added (accepted risk, documented in SK-ADR-010 Decision 7).
 */
import type { ConstraintLimit, ConstraintRule, QuestionConstraints } from './types.js';

/** Fixed message for a non-string value — defense in depth; `QuestionDefinition.validate`'s contract is a text-question answer, which is always a string in practice. */
const NON_STRING_MESSAGE = 'Expected a string';

/**
 * Compiles `constraints` into a `(value: unknown) => true | string`
 * function, matching `QuestionDefinition.validate`'s existing shape
 * exactly — `constraints` is just a data-driven way to produce one.
 * Throws a descriptive `Error` immediately (never later, at answer time)
 * when `constraints` itself is malformed — see `assertWellFormed()` below
 * for the exact cases.
 */
export function compileConstraints(constraints: QuestionConstraints): (value: unknown) => true | string {
  assertWellFormed(constraints);

  const compiledRules = (constraints.rules ?? []).map(compileRule);

  return (value: unknown): true | string => {
    if (typeof value !== 'string') return NON_STRING_MESSAGE;

    const subject = constraints.trim ? value.trim() : value;

    if (constraints.minLength && countCodePoints(subject) < constraints.minLength.value) {
      return constraints.minLength.message;
    }
    if (constraints.maxLength && countCodePoints(subject) > constraints.maxLength.value) {
      return constraints.maxLength.message;
    }
    for (const rule of compiledRules) {
      const verdict = rule(subject);
      if (verdict !== true) return verdict;
    }

    return true;
  };
}

interface CompiledRule {
  (subject: string): true | string;
}

function compileRule(rule: ConstraintRule): CompiledRule {
  if ('matches' in rule) {
    const regex = compileRegex(rule.matches, 'matches');
    const message = rule.message;
    return (subject) => (regex.test(subject) ? true : message);
  }
  const regex = compileRegex(rule.notMatches, 'notMatches');
  const message = rule.message;
  return (subject) => (regex.test(subject) ? message : true);
}

function compileRegex(source: string, field: 'matches' | 'notMatches'): RegExp {
  try {
    // No flags, by design (D1) — see this module's header comment.
    return new RegExp(source);
  } catch (err) {
    throw new Error(
      `Invalid QuestionConstraints: rules[].${field} is not a valid regular expression source: ${describe(err)}`
    );
  }
}

/**
 * Validates the *shape* of `constraints` (never reachable by an end-user
 * answer — this runs once, at compile/synth/register time). Throws a
 * descriptive `Error` naming the exact field at fault for every malformed
 * case in the spec's fail-fast table: unknown top-level key, non-boolean
 * `trim`, a limit that isn't a non-negative integer, an empty limit/rule
 * message, `minLength > maxLength`, an invalid regex source, or a rule
 * object that is neither `matches` nor `notMatches` (or declares both/an
 * unknown key).
 */
function assertWellFormed(constraints: QuestionConstraints): void {
  if (typeof constraints !== 'object' || constraints === null || Array.isArray(constraints)) {
    throw new Error('Invalid QuestionConstraints: expected an object');
  }

  const knownKeys = new Set(['trim', 'minLength', 'maxLength', 'rules']);
  for (const key of Object.keys(constraints)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Invalid QuestionConstraints: unknown key "${key}"`);
    }
  }

  if (constraints.trim !== undefined && typeof constraints.trim !== 'boolean') {
    throw new Error('Invalid QuestionConstraints: "trim" must be a boolean when present');
  }

  if (constraints.minLength !== undefined) assertWellFormedLimit(constraints.minLength, 'minLength');
  if (constraints.maxLength !== undefined) assertWellFormedLimit(constraints.maxLength, 'maxLength');

  if (
    constraints.minLength !== undefined &&
    constraints.maxLength !== undefined &&
    constraints.minLength.value > constraints.maxLength.value
  ) {
    throw new Error('Invalid QuestionConstraints: "minLength" must not be greater than "maxLength"');
  }

  if (constraints.rules !== undefined) {
    if (!Array.isArray(constraints.rules)) {
      throw new Error('Invalid QuestionConstraints: "rules" must be an array when present');
    }
    constraints.rules.forEach((rule, index) => assertWellFormedRule(rule, index));
  }
}

function assertWellFormedLimit(limit: ConstraintLimit, field: 'minLength' | 'maxLength'): void {
  if (typeof limit !== 'object' || limit === null || Array.isArray(limit)) {
    throw new Error(`Invalid QuestionConstraints: "${field}" must be an object with "value"/"message"`);
  }

  const extraKeys = Object.keys(limit).filter((key) => key !== 'value' && key !== 'message');
  if (extraKeys.length > 0) {
    throw new Error(`Invalid QuestionConstraints: "${field}" has unknown key "${extraKeys[0]}"`);
  }

  if (typeof limit.value !== 'number' || !Number.isInteger(limit.value) || limit.value < 0) {
    throw new Error(`Invalid QuestionConstraints: "${field}.value" must be a non-negative integer`);
  }
  if (typeof limit.message !== 'string' || limit.message.length === 0) {
    throw new Error(`Invalid QuestionConstraints: "${field}.message" must be a non-empty string`);
  }
}

function assertWellFormedRule(rule: ConstraintRule, index: number): void {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    throw new Error(`Invalid QuestionConstraints: rules[${index}] must be an object`);
  }

  const hasMatches = 'matches' in rule;
  const hasNotMatches = 'notMatches' in rule;
  if (hasMatches === hasNotMatches) {
    throw new Error(`Invalid QuestionConstraints: rules[${index}] must declare exactly one of "matches"/"notMatches"`);
  }

  const extraKeys = Object.keys(rule).filter((key) => key !== 'matches' && key !== 'notMatches' && key !== 'message');
  if (extraKeys.length > 0) {
    throw new Error(`Invalid QuestionConstraints: rules[${index}] has unknown key "${extraKeys[0]}"`);
  }

  const source = hasMatches ? (rule as { matches: unknown }).matches : (rule as { notMatches: unknown }).notMatches;
  if (typeof source !== 'string') {
    throw new Error(`Invalid QuestionConstraints: rules[${index}].${hasMatches ? 'matches' : 'notMatches'} must be a string`);
  }
  if (typeof rule.message !== 'string' || rule.message.length === 0) {
    throw new Error(`Invalid QuestionConstraints: rules[${index}].message must be a non-empty string`);
  }
  // Regex validity is checked by compileRule()/compileRegex() — kept there so the
  // exact invalid-regex error message is produced in one place only.
  compileRegex(source, hasMatches ? 'matches' : 'notMatches');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HIGH_SURROGATE = /[\ud800-\udbff]/;

/**
 * Counts Unicode code points, matching zod's own
 * `util.codePointLength()` exactly (`node_modules/zod/v4/core/util.js`) —
 * see this module's header comment ("Length measurement"). A fast path
 * (plain `.length`) when no high surrogate is present at all; otherwise
 * each valid high/low surrogate pair counts once instead of twice, same
 * as a native `for...of`/`Array.from` iteration over the string.
 */
function countCodePoints(value: string): number {
  const units = value.length;
  if (!HIGH_SURROGATE.test(value)) return units;

  let count = units;
  for (let i = 0; i < units - 1; i++) {
    const high = value.charCodeAt(i);
    const low = value.charCodeAt(i + 1);
    if ((high & 0xfc00) === 0xd800 && (low & 0xfc00) === 0xdc00) {
      count--;
      i++;
    }
  }
  return count;
}
