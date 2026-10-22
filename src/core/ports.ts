/**
 * Ports: the boundaries `infra/` implements and `cli/` wires in
 * (.agents/specs/initial_scaffold.md — "Interfaces"). Three narrow ports
 * rather than one I/O god-interface (ISP), plus the plugin registry.
 */
import type { Answers, QuestionDefinition, StackfoldPlugin } from './types.js';

export interface Prompter {
  ask(questions: QuestionDefinition[]): Promise<Answers>;
}

/**
 * Part of the `FileWriter` contract: the typed rejection for "target
 * exists and is not empty" (functional_domain §3.3), so core, the CLI and
 * any adapter or fake can recognise this case by type, not by message.
 */
export class TargetNotEmptyError extends Error {
  constructor(public readonly targetDir: string) {
    super(
      `Target directory ${targetDir} already exists and is not empty. ` +
        'stackfold only scaffolds into an empty or non-existent directory.'
    );
    this.name = 'TargetNotEmptyError';
  }
}

export interface FileWriter {
  /**
   * Creates targetDir if it does not exist. Rejects with
   * `TargetNotEmptyError` if targetDir exists and is non-empty; rejects
   * with another error if targetDir exists but is not a directory — this
   * second rejection is never bypassed, by either option below (see
   * initial_scaffold.md, "ensureEmptyDir must tolerate known governance
   * artifacts (testing finding #1)").
   *
   * `options.force`, when true, skips the non-empty check entirely (the
   * "not a directory" rejection still applies). `options.ignoreEntries`
   * names entries that don't count against emptiness when deciding
   * whether targetDir is non-empty; it has no effect when `force` is
   * true. Omitting `options` (or passing an empty `ignoreEntries`)
   * preserves today's behavior exactly.
   */
  ensureEmptyDir(
    targetDir: string,
    options?: { force?: boolean; ignoreEntries?: readonly string[] }
  ): Promise<void>;
  writeFile(absolutePath: string, content: string | Buffer): Promise<void>;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

export interface PluginRegistry {
  resolve(id: string): StackfoldPlugin | undefined;
  list(): StackfoldPlugin[];
}

/**
 * Fourth port (ARCH-001, Step 1 item 1): resolves an "expression-shaped"
 * value against a context — today always `Answers` (`core/authoring.ts`).
 * `infra/expressionEvaluator.ts` is the sole adapter, a thin wrapper over
 * `json-logic-js` — a restricted, non-Turing-complete rule format, never an
 * `eval`. No escape hatch (custom operator, string execution, etc.) is ever
 * added on top of it.
 */
export interface ExpressionEvaluator {
  evaluate(expr: unknown, context: Record<string, unknown>): unknown;
}
