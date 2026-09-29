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
   * `TargetNotEmptyError` if targetDir exists and is non-empty
   * (functional_domain §3.3); rejects with another error if targetDir
   * exists but is not a directory.
   */
  ensureEmptyDir(targetDir: string): Promise<void>;
  writeFile(absolutePath: string, content: string | Buffer): Promise<void>;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

export interface PluginRegistry {
  resolve(id: string): StackfoldPlugin | undefined;
  list(): StackfoldPlugin[];
}
