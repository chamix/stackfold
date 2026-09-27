/**
 * Core domain types for the stackfold plugin contract.
 *
 * NOTE: this is a placeholder shape, just enough for the skeleton to
 * compile and run end-to-end. The real plugin contract (lifecycle hooks,
 * how a plugin declares its prompts/templates/post-init steps, how the
 * orchestrator composes several plugins) is deliberately deferred —
 * to be designed once claude-blueprints governance is deployed on this
 * repo, not improvised ahead of that.
 */

export interface ProjectAnswers {
  [key: string]: string | boolean | number;
}

export interface StackfoldPlugin {
  /** Unique plugin id, e.g. "electron-ts". */
  name: string;
  description: string;

  /** Collect whatever this plugin needs from the user. */
  prompts(): Promise<ProjectAnswers>;

  /** Write the generated project into targetDir. */
  generate(targetDir: string, answers: ProjectAnswers): Promise<void>;
}
