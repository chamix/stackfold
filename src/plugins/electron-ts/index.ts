import type { Answers, ProjectBlueprint, QuestionDefinition, StackfoldPlugin } from '../../core/types.js';
import {
  DEFAULT_APP_NAME,
  DEFAULT_AUTHOR,
  DEFAULT_DESCRIPTION,
  TIER1_FILES,
  resolveContext,
  validateAppName,
} from './templates.js';

/**
 * electron-ts plugin: a secure Electron + TypeScript Tier-1 app shell
 * (initial_scaffold.md — "electron-ts Tier-1 shell (Cycle A)").
 *
 * questions() and buildBlueprint() are pure and synchronous; file content
 * lives in the TIER1_FILES registry in ./templates.ts.
 */

export interface ElectronTsPluginOptions {
  /**
   * Clock for the LICENSE copyright year. Injected so buildBlueprint() has
   * no hidden input: the same answers and clock give the same blueprint.
   */
  now?: () => Date;
}

export function createElectronTsPlugin(options: ElectronTsPluginOptions = {}): StackfoldPlugin {
  const now = options.now ?? (() => new Date());

  return {
    id: 'electron-ts',
    description:
      'Electron + TypeScript desktop app shell (sandboxed windows, external-link policy, narrow preload bridge).',

    questions(): QuestionDefinition[] {
      return [
        {
          id: 'appName',
          message: 'Application name',
          type: 'input',
          default: DEFAULT_APP_NAME,
          validate: validateAppName,
        },
        {
          id: 'description',
          message: 'Short description',
          type: 'input',
          default: DEFAULT_DESCRIPTION,
        },
        {
          id: 'author',
          message: 'Author (optional, used for package.json and an MIT LICENSE)',
          type: 'input',
          default: DEFAULT_AUTHOR,
        },
      ];
    },

    buildBlueprint(answers: Answers): ProjectBlueprint {
      const ctx = resolveContext(answers, now());
      return {
        files: TIER1_FILES.filter((file) => file.include?.(ctx) ?? true).map((file) => ({
          path: file.path,
          content: file.render(ctx),
        })),
        postActions: [{ kind: 'git-init' }],
      };
    },
  };
}

export const electronTsPlugin: StackfoldPlugin = createElectronTsPlugin();
