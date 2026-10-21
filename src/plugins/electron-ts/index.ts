import type { Answers, ProjectBlueprint, QuestionDefinition, StackfoldPlugin } from '../../core/types.js';
import { DEFAULT_APP_NAME, DEFAULT_AUTHOR, DEFAULT_DESCRIPTION, TIER1_FILES, resolveContext } from './templates.js';
import { appNameSchema, authorSchema, descriptionSchema, toValidate } from '../../core/validation.js';

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
    help: {
      name: 'Electron + TypeScript',
      details:
        'Generates a Tier-1 Electron shell: context isolation + a disabled ' +
        'Node integration renderer, a narrow typed preload bridge (no raw ' +
        'ipcRenderer exposure), and a policy that opens external links in ' +
        'the OS browser instead of a new Electron window. ' +
        'Settings (Dark Mode), Skins (user-editable visual presets) and ' +
        'About/Help windows are optional, prompted during init. ' +
        'Requires Node 22+ and enough disk/network for the Electron binary ' +
        'download on first `npm install`.',
    },

    questions(): QuestionDefinition[] {
      return [
        {
          id: 'appName',
          message: 'Application name',
          type: 'input',
          default: DEFAULT_APP_NAME,
          validate: toValidate(appNameSchema),
        },
        {
          id: 'description',
          message: 'Short description',
          type: 'input',
          default: DEFAULT_DESCRIPTION,
          validate: toValidate(descriptionSchema),
        },
        {
          id: 'author',
          message: 'Author (optional, used for package.json and an MIT LICENSE)',
          type: 'input',
          default: DEFAULT_AUTHOR,
          validate: toValidate(authorSchema),
        },
        {
          id: 'includeSettings',
          message: 'Include Settings (Dark Mode)?',
          type: 'confirm',
          default: false,
        },
        {
          id: 'includeSkins',
          message: 'Include Skins (user-editable visual presets)?',
          type: 'confirm',
          default: false,
        },
        {
          id: 'includeAboutHelp',
          message: 'Include About + Help windows?',
          type: 'confirm',
          default: false,
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
