/**
 * `electron-stackfold` — Electron + TypeScript desktop app shell (sandboxed
 * windows, external-link policy, narrow preload bridge), originally
 * authored declaratively by hand as `scaffold.json` (ARCH-001/Task 037,
 * SK-ADR-002) and reauthored for Task 043
 * (.agents/specs/043-electron-stackfold-web-app-reauthor.md §0 point 1) to
 * the TS-authored `scaffold.ts` + sibling `.hbs` templates + `stackfold
 * scaffold synth` pipeline (SK-ADR-003) — the same pattern `plugin-builder`
 * was reauthored to in Task 042 (`src/plugins/plugin-builder/scaffold.ts`),
 * but simpler: none of this plugin's 6 questions declare a `validate`
 * closure or a dynamic default, so (unlike `plugin-builder`) there is no
 * function value anywhere in this `ScaffoldDefinition` that `scaffold.json`
 * would silently drop. `src/cli/index.ts` therefore keeps loading this
 * plugin's *compiled* `scaffold.json` at runtime, unchanged — this file is
 * the authoring source that `scaffold.json` is regenerated from via a real
 * `stackfold scaffold synth src/plugins/electron-stackfold` invocation, not
 * itself imported at runtime.
 *
 * A faithful, mechanical port of the previous `scaffold.json`'s
 * `questions`/`steps`/`hooks` — same question ids/messages/types/defaults,
 * same file set, same per-file `when` gates, same `jsonEscapeKeys` usage,
 * same `hooks.preInit` `deriveAnswer` steps (`packageName`/`bridgeGlobal`/
 * `year`) — not a redesign. Every former inline Handlebars `content` string
 * now lives in its own sibling `.hbs` file under `templates/`, mirroring
 * this plugin's own generated directory layout (e.g.
 * `templates/src/main/index.ts.hbs` → generated `src/main/index.ts`),
 * loaded once at module-evaluation time via `loadTemplate()`
 * (`src/authoring/templateLoader.ts`), same convention `plugin-builder`
 * already uses.
 *
 * Security (`.claude/knowledge/nodejs/security.md` "Untrusted code
 * execution"): `stackfold scaffold synth` dynamically imports and runs this
 * module to produce `scaffold.json`. This is a trusted-author build-time
 * tool over this plugin's own committed source, the same threat model
 * `core/authoring.ts`'s header comment and that security doc section
 * already document for every `scaffold.ts` in this repo — no new
 * mitigation needed here.
 */
import { defineScaffold, file, step } from '../../authoring/builder.js';
import { loadTemplate } from '../../authoring/templateLoader.js';

export const DEFAULT_APP_NAME = 'my-electron-app';
export const DEFAULT_DESCRIPTION = 'An Electron + TypeScript desktop app.';
export const DEFAULT_AUTHOR = '';

const dir = import.meta.dirname;

// ---------------------------------------------------------------------------
// Sibling `.hbs` templates — one per generated file, loaded once here,
// mirroring the destination path each is written to below (plus `.hbs`).
// ---------------------------------------------------------------------------

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, 'templates/package.json.hbs');
const README_TEMPLATE = loadTemplate(dir, 'templates/README.md.hbs');
const GITIGNORE_TEMPLATE = loadTemplate(dir, 'templates/.gitignore.hbs');
const LICENSE_TEMPLATE = loadTemplate(dir, 'templates/LICENSE.hbs');
const TSCONFIG_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.json.hbs');
const TSCONFIG_BASE_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.base.json.hbs');
const TSCONFIG_MAIN_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.main.json.hbs');
const TSCONFIG_RENDERER_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.renderer.json.hbs');
const TSCONFIG_TYPECHECK_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.typecheck.json.hbs');
const VITEST_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/vitest.config.ts.hbs');
const MAIN_WINDOW_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/src/main/windowConfig.ts.hbs');
const MAIN_LINK_POLICY_TEMPLATE = loadTemplate(dir, 'templates/src/main/linkPolicy.ts.hbs');
const MAIN_IPC_TEMPLATE = loadTemplate(dir, 'templates/src/main/ipc.ts.hbs');
const MAIN_ATOMIC_WRITE_FILE_TEMPLATE = loadTemplate(dir, 'templates/src/main/atomicWriteFile.ts.hbs');
const MAIN_STATIC_WINDOW_SHELL_TEMPLATE = loadTemplate(dir, 'templates/src/main/staticWindowShell.ts.hbs');
const MAIN_SETTINGS_TEMPLATE = loadTemplate(dir, 'templates/src/main/settings.ts.hbs');
const MAIN_SETTINGS_STORE_TEMPLATE = loadTemplate(dir, 'templates/src/main/settingsStore.ts.hbs');
const MAIN_SKINS_TEMPLATE = loadTemplate(dir, 'templates/src/main/skins.ts.hbs');
const MAIN_SKINS_STORE_TEMPLATE = loadTemplate(dir, 'templates/src/main/skinsStore.ts.hbs');
const THIRD_PARTY_NOTICES_TEMPLATE = loadTemplate(dir, 'templates/third-party-notices.json.hbs');
const HELP_MD_TEMPLATE = loadTemplate(dir, 'templates/help.md.hbs');
const MAIN_ABOUT_WINDOW_TEMPLATE = loadTemplate(dir, 'templates/src/main/aboutWindow.ts.hbs');
const MAIN_HELP_WINDOW_TEMPLATE = loadTemplate(dir, 'templates/src/main/helpWindow.ts.hbs');
const MAIN_MENU_TEMPLATE = loadTemplate(dir, 'templates/src/main/menu.ts.hbs');
const MAIN_INDEX_TEMPLATE = loadTemplate(dir, 'templates/src/main/index.ts.hbs');
const PRELOAD_API_TEMPLATE = loadTemplate(dir, 'templates/src/preload/api.ts.hbs');
const PRELOAD_INDEX_TEMPLATE = loadTemplate(dir, 'templates/src/preload/index.ts.hbs');
const RENDERER_INDEX_HTML_TEMPLATE = loadTemplate(dir, 'templates/src/renderer/index.html.hbs');
const RENDERER_APP_CSS_TEMPLATE = loadTemplate(dir, 'templates/src/renderer/app.css.hbs');
const RENDERER_THEME_TEMPLATE = loadTemplate(dir, 'templates/src/renderer/theme.ts.hbs');
const RENDERER_SKINS_TEMPLATE = loadTemplate(dir, 'templates/src/renderer/skins.ts.hbs');
const BUILD_SCRIPT_TEMPLATE = loadTemplate(dir, 'templates/scripts/build.mjs.hbs');
const ELECTRON_BUILDER_YML_TEMPLATE = loadTemplate(dir, 'templates/electron-builder.yml.hbs');
const PLAYWRIGHT_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/playwright.config.ts.hbs');
const E2E_FIXTURES_TEMPLATE = loadTemplate(dir, 'templates/tests/e2e/support/fixtures.ts.hbs');
const E2E_POLL_UNTIL_STABLE_TEMPLATE = loadTemplate(dir, 'templates/tests/e2e/support/pollUntilStable.ts.hbs');
const UNIT_POLL_UNTIL_STABLE_TEST_TEMPLATE = loadTemplate(dir, 'templates/tests/unit/pollUntilStable.test.ts.hbs');
const E2E_SMOKE_SPEC_TEMPLATE = loadTemplate(dir, 'templates/tests/e2e/smoke.spec.ts.hbs');
const CI_WORKFLOW_TEMPLATE = loadTemplate(dir, 'templates/.github/workflows/ci.yml.hbs');
const RELEASE_WORKFLOW_TEMPLATE = loadTemplate(dir, 'templates/.github/workflows/release.yml.hbs');

// ---------------------------------------------------------------------------
// Shared `when` gates — reused verbatim across multiple steps below, same
// JSON Logic shapes `scaffold.json` already declared per file.
// ---------------------------------------------------------------------------

const WHEN_AUTHOR_PROVIDED = { '!==': [{ var: 'author' }, ''] };
const WHEN_SETTINGS_OR_SKINS = { or: [{ var: 'includeSettings' }, { var: 'includeSkins' }] };
const WHEN_NOT_SETTINGS_OR_SKINS = { '!': WHEN_SETTINGS_OR_SKINS };
const WHEN_SETTINGS = { var: 'includeSettings' };
const WHEN_SKINS = { var: 'includeSkins' };
const WHEN_ABOUT_HELP = { var: 'includeAboutHelp' };

export default defineScaffold({
  id: 'electron-stackfold',
  description:
    'Electron + TypeScript desktop app shell (sandboxed windows, external-link policy, narrow preload bridge) — ' +
    'authored declaratively via the scaffold-authoring system, a functional port of electron-ts.',
  help: {
    name: 'Electron + TypeScript (declarative)',
    details:
      'Generates the same Tier-1 Electron shell as electron-ts: context isolation + a disabled Node integration ' +
      'renderer, a narrow typed preload bridge (no raw ipcRenderer exposure), and a policy that opens external ' +
      'links in the OS browser instead of a new Electron window. Settings (Dark Mode), Skins (user-editable ' +
      'visual presets) and About/Help windows are optional, prompted during init. Authored as a declarative ' +
      'ScaffoldDefinition rather than hand-written TypeScript — see electron-ts for the original. ' +
      'Requires Node 22+ and enough disk/network for the Electron binary download on first `npm install`.',
  },

  questions: [
    {
      id: 'appName',
      message: 'Application name',
      type: 'input',
      default: DEFAULT_APP_NAME,
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
  ],

  // Task 044 (UX-001/SK-ADR-004, rollout table): fixed entry point,
  // independent of answers — a plain literal, same contract as a literal
  // boolean `when` already uses elsewhere in this file.
  mainFile: 'src/main/index.ts',

  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { jsonEscapeKeys: ['appName', 'description', 'author'] }),
    file('README.md', README_TEMPLATE),
    file('.gitignore', GITIGNORE_TEMPLATE),
    file('LICENSE', LICENSE_TEMPLATE, { jsonEscapeKeys: ['author'], when: WHEN_AUTHOR_PROVIDED }),
    file('tsconfig.json', TSCONFIG_JSON_TEMPLATE, { when: WHEN_NOT_SETTINGS_OR_SKINS }),
    file('tsconfig.base.json', TSCONFIG_BASE_JSON_TEMPLATE, { when: WHEN_SETTINGS_OR_SKINS }),
    file('tsconfig.main.json', TSCONFIG_MAIN_JSON_TEMPLATE, { when: WHEN_SETTINGS_OR_SKINS }),
    file('tsconfig.renderer.json', TSCONFIG_RENDERER_JSON_TEMPLATE, { when: WHEN_SETTINGS_OR_SKINS }),
    file('tsconfig.typecheck.json', TSCONFIG_TYPECHECK_JSON_TEMPLATE),
    file('vitest.config.ts', VITEST_CONFIG_TEMPLATE),
    file('src/main/windowConfig.ts', MAIN_WINDOW_CONFIG_TEMPLATE),
    file('src/main/linkPolicy.ts', MAIN_LINK_POLICY_TEMPLATE),
    file('src/main/ipc.ts', MAIN_IPC_TEMPLATE),
    file('src/main/atomicWriteFile.ts', MAIN_ATOMIC_WRITE_FILE_TEMPLATE, { when: WHEN_SETTINGS_OR_SKINS }),
    file('src/main/staticWindowShell.ts', MAIN_STATIC_WINDOW_SHELL_TEMPLATE, { when: WHEN_ABOUT_HELP }),
    file('src/main/settings.ts', MAIN_SETTINGS_TEMPLATE, { when: WHEN_SETTINGS }),
    file('src/main/settingsStore.ts', MAIN_SETTINGS_STORE_TEMPLATE, { when: WHEN_SETTINGS }),
    file('src/main/skins.ts', MAIN_SKINS_TEMPLATE, { when: WHEN_SKINS }),
    file('src/main/skinsStore.ts', MAIN_SKINS_STORE_TEMPLATE, { when: WHEN_SKINS }),
    file('third-party-notices.json', THIRD_PARTY_NOTICES_TEMPLATE, { when: WHEN_ABOUT_HELP }),
    file('help.md', HELP_MD_TEMPLATE, { when: WHEN_ABOUT_HELP }),
    file('src/main/aboutWindow.ts', MAIN_ABOUT_WINDOW_TEMPLATE, { when: WHEN_ABOUT_HELP }),
    file('src/main/helpWindow.ts', MAIN_HELP_WINDOW_TEMPLATE, { when: WHEN_ABOUT_HELP }),
    file('src/main/menu.ts', MAIN_MENU_TEMPLATE),
    file('src/main/index.ts', MAIN_INDEX_TEMPLATE),
    file('src/preload/api.ts', PRELOAD_API_TEMPLATE),
    file('src/preload/index.ts', PRELOAD_INDEX_TEMPLATE),
    file('src/renderer/index.html', RENDERER_INDEX_HTML_TEMPLATE),
    file('src/renderer/app.css', RENDERER_APP_CSS_TEMPLATE),
    file('src/renderer/theme.ts', RENDERER_THEME_TEMPLATE, { when: WHEN_SETTINGS }),
    file('src/renderer/skins.ts', RENDERER_SKINS_TEMPLATE, { when: WHEN_SKINS }),
    file('scripts/build.mjs', BUILD_SCRIPT_TEMPLATE),
    file('electron-builder.yml', ELECTRON_BUILDER_YML_TEMPLATE, { jsonEscapeKeys: ['appName'] }),
    file('playwright.config.ts', PLAYWRIGHT_CONFIG_TEMPLATE),
    file('tests/e2e/support/fixtures.ts', E2E_FIXTURES_TEMPLATE),
    file('tests/e2e/support/pollUntilStable.ts', E2E_POLL_UNTIL_STABLE_TEMPLATE),
    file('tests/unit/pollUntilStable.test.ts', UNIT_POLL_UNTIL_STABLE_TEST_TEMPLATE),
    file('tests/e2e/smoke.spec.ts', E2E_SMOKE_SPEC_TEMPLATE),
    file('.github/workflows/ci.yml', CI_WORKFLOW_TEMPLATE),
    file('.github/workflows/release.yml', RELEASE_WORKFLOW_TEMPLATE),
    step('gitInit', {}),
  ],

  hooks: {
    preInit: [
      step('deriveAnswer', { from: 'appName', to: 'packageName', transform: 'npm-slug' }),
      step('deriveAnswer', { from: 'packageName', to: 'bridgeGlobal', transform: 'js-identifier-suffix', suffix: 'Api' }),
      step('deriveAnswer', { from: 'appName', to: 'year', transform: 'current-year' }),
    ],
  },
});
