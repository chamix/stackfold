import type { ProjectAnswers, StackfoldPlugin } from './types.js';

/**
 * Pure orchestration logic: drives a single plugin through its lifecycle.
 * Deliberately has no direct file-system or process I/O — that belongs
 * in src/infra, wired in from src/cli. Keeping this pure is what makes
 * it unit-testable without touching disk.
 *
 * TODO: expand once the real plugin contract is designed (see core/types.ts).
 */
export async function runPlugin(
  plugin: StackfoldPlugin,
  targetDir: string
): Promise<void> {
  const answers: ProjectAnswers = await plugin.prompts();
  await plugin.generate(targetDir, answers);
}
