/**
 * Core domain types for the stackfold plugin contract
 * (.agents/specs/initial_scaffold.md — "Interfaces").
 *
 * Everything here is plain data or pure functions. A plugin declares what
 * to ask (`questions()`) and what project results from the answers
 * (`buildBlueprint()`); it never performs I/O itself — the orchestrator
 * does the asking, writing, and command execution through the ports in
 * `core/ports.ts` (functional_domain.md §3.4).
 */

export type AnswerValue = string | boolean | number;
export type Answers = Record<string, AnswerValue>;

export interface QuestionDefinition {
  id: string;
  message: string;
  type: 'input' | 'confirm' | 'select';
  /** Required when type === "select". */
  choices?: string[];
  default?: AnswerValue;
  /** Pure — no I/O. Return `true` if valid, or an error message. */
  validate?: (value: AnswerValue) => true | string;
}

export interface FileEntry {
  /** Relative to the target directory. */
  path: string;
  content: string | Buffer;
}

/**
 * Declarative follow-up actions (Command pattern, as data). Interpreted
 * centrally by the orchestrator via `ProcessRunner` — a plugin never hands
 * over executable code.
 */
export type PostActionDefinition =
  | { kind: 'git-init' }
  | { kind: 'npm-install' }
  | { kind: 'run-command'; command: string; args: string[] };

export interface ProjectBlueprint {
  files: FileEntry[];
  postActions: PostActionDefinition[];
}

export interface StackfoldPlugin {
  readonly id: string;
  readonly description: string;

  /** Pure — declares what to ask. The orchestrator does the asking. */
  questions(): QuestionDefinition[];

  /** Pure, synchronous — answers in, complete blueprint out. No I/O. */
  buildBlueprint(answers: Answers): ProjectBlueprint;
}
