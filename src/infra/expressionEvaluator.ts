/**
 * Expression-evaluation adapter — implements the `ExpressionEvaluator` port
 * (`core/ports.ts`) via `json-logic-js` (ARCH-001 Step 1 item 5, ADR
 * decision 4). The only file allowed to import `json-logic-js` (ADR-001
 * blast-radius note): `core/authoring.ts` depends only on the port.
 *
 * Security (`.claude/knowledge/nodejs/security.md`, "Untrusted code
 * execution"): JSON Logic is a restricted, non-Turing-complete rule format
 * by construction — not an `eval`, and this adapter is a pure pass-through.
 * No custom operator is ever registered here (`jsonLogic.add_operation()` is
 * never called): doing so would be exactly the escape hatch this guidance
 * warns against (e.g. an operator that shells out or evaluates a string).
 */
import jsonLogic, { type RulesLogic } from 'json-logic-js';
import type { ExpressionEvaluator } from '../core/ports.js';

export class JsonLogicExpressionEvaluator implements ExpressionEvaluator {
  evaluate(expr: unknown, context: Record<string, unknown>): unknown {
    // The port deliberately types `expr` as `unknown` (`core/ports.ts`) —
    // any scaffold-authored value may be handed here, and it's
    // `json-logic-js` itself (not this adapter) that is the sole authority
    // on what counts as valid rule shape, including rejecting the rest.
    return jsonLogic.apply(expr as RulesLogic, context);
  }
}
