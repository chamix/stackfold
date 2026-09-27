import type { ProjectAnswers, StackfoldPlugin } from '../../core/types.js';

/**
 * First stackfold plugin: Electron + TypeScript app shell.
 *
 * This is where the Tier 1 shell extracted from md-view lands (see the
 * md-presenter extraction handoff and SK-ADR-001..006): windowConfig,
 * linkPolicy, the BridgeApi preload pattern, build/CI config, e2e
 * fixtures, plus the opt-in Tier 2 features (settings, appState/What's
 * New, Help window).
 *
 * TODO: this is a stub. Real implementation lands in S2 (copy Tier 1
 * into templates/, split what today is md-view's index.ts into
 * bootstrap vs. domain, parametrize the tokens listed in the handoff §4).
 */
export const electronTsPlugin: StackfoldPlugin = {
  name: 'electron-ts',
  description: 'Electron + TypeScript desktop app shell (secure BridgeApi preload, settings, appState/What\'s New, Help window).',

  async prompts(): Promise<ProjectAnswers> {
    throw new Error('electron-ts plugin: prompts() not implemented yet');
  },

  async generate(_targetDir: string, _answers: ProjectAnswers): Promise<void> {
    throw new Error('electron-ts plugin: generate() not implemented yet');
  },
};
