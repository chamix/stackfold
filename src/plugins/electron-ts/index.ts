import type {
  AnswerValue,
  Answers,
  ProjectBlueprint,
  QuestionDefinition,
  StackfoldPlugin,
} from '../../core/types.js';

/**
 * First stackfold plugin: Electron + TypeScript app shell.
 *
 * PLACEHOLDER OUTPUT. This proves the full contract end-to-end
 * (questions → pure blueprint → orchestrator writes + post-actions) with a
 * minimal project: package.json, README.md, .gitignore, then `git init`.
 *
 * The real Tier 1 shell extracted from md-view (windowConfig, linkPolicy,
 * the BridgeApi preload pattern, build/CI config, e2e fixtures, plus the
 * opt-in Tier 2 features) is separate, larger future work — see the
 * md-presenter extraction handoff and SK-ADR-001..006.
 *
 * Everything here is pure data / pure functions: no I/O, no async
 * (functional_domain §2, §3.4).
 */

const DEFAULT_APP_NAME = 'my-electron-app';
const DEFAULT_DESCRIPTION = 'An Electron + TypeScript desktop app.';
/** npm's package-name length limit. */
const MAX_PACKAGE_NAME_LENGTH = 214;

/** Derives a URL-safe npm package name from a human-readable app name (§2.1). */
function toPackageName(appName: string): string {
  return appName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PACKAGE_NAME_LENGTH)
    .replace(/-+$/, '');
}

function validateAppName(value: AnswerValue): true | string {
  const name = String(value).trim();
  if (name === '') return 'App name must not be empty.';
  if (toPackageName(name) === '') {
    return 'App name must contain at least one letter or digit.';
  }
  return true;
}

function requireString(answers: Answers, id: string): string {
  const value = answers[id];
  if (value === undefined) {
    throw new Error(`electron-ts: missing required answer "${id}"`);
  }
  return String(value).trim();
}

function optionalString(answers: Answers, id: string, fallback: string): string {
  const value = answers[id];
  return value === undefined ? fallback : String(value).trim();
}

function renderPackageJson(packageName: string, appName: string, description: string): string {
  const pkg = {
    name: packageName,
    productName: appName,
    version: '0.1.0',
    description,
    private: true,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function renderReadme(appName: string, description: string): string {
  return [
    `# ${appName}`,
    '',
    description,
    '',
    '> Scaffolded by `stackfold init electron-ts`.',
    '>',
    '> **Note:** the full Electron + TypeScript shell (secure BridgeApi preload,',
    '> settings, appState/What\'s New, Help window) is pending — this placeholder',
    '> project only proves the stackfold pipeline end-to-end.',
    '',
  ].join('\n');
}

const GITIGNORE = ['node_modules/', 'dist/', 'out/', '*.log', ''].join('\n');

export const electronTsPlugin: StackfoldPlugin = {
  id: 'electron-ts',
  description:
    "Electron + TypeScript desktop app shell (secure BridgeApi preload, settings, appState/What's New, Help window).",

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
    ];
  },

  buildBlueprint(answers: Answers): ProjectBlueprint {
    const appName = requireString(answers, 'appName');
    const verdict = validateAppName(appName);
    if (verdict !== true) throw new Error(`electron-ts: invalid appName: ${verdict}`);

    const description = optionalString(answers, 'description', DEFAULT_DESCRIPTION);
    const packageName = toPackageName(appName);

    return {
      files: [
        { path: 'package.json', content: renderPackageJson(packageName, appName, description) },
        { path: 'README.md', content: renderReadme(appName, description) },
        { path: '.gitignore', content: GITIGNORE },
      ],
      postActions: [{ kind: 'git-init' }],
    };
  },
};
