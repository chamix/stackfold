/**
 * `node-cli-stackfold` — generates a Node.js + TypeScript command-line
 * application with the same opinionated stack and the same layered structure
 * as stackfold itself: commander (commands), @inquirer/prompts (interactive
 * input), execa (child processes), cosmiconfig (config files) and zod (config
 * validation), wired as ports and adapters (`cli/` -> `core/` <- `infra/`)
 * and assembled in a single composition root.
 *
 * Four questions (`projectName`, `description`, `binName`, `author`) and 18
 * templates. The file tree is the same for every set of answers: there are no
 * toggles, so there is nothing to combine and nothing to leak between options.
 *
 * Design notes:
 * - Validation is declarative (`constraints`), so this definition has no
 *   `validate` closures. As a result the plugin has no `scaffold.js`:
 *   `src/cli/index.ts` loads the synthesized `scaffold.json`, exactly like
 *   `node-http-api-stackfold`.
 * - The authoring DSL (`defineScaffold`, `file()`) is imported from this
 *   repo's own `src/authoring/builder.js`, never from the published
 *   `stackfold/authoring` package.
 * - Escaping: `package.json` goes through `jsonEscapeKeys`, the one place
 *   `description`/`author` land in a JSON string. `src/cli/index.ts` uses
 *   `jsEscapeKeys` for the description (a single-quoted TS string literal).
 *   Everywhere else the templates interpolate with `{{{x}}}` so Handlebars
 *   does not HTML-escape Markdown or code.
 * - `binName` has a static default equal to `projectName`'s. The DSL has no
 *   default derived from another answer, and deriving it in the templates
 *   would need a conditional in every file that names the command.
 * - `MIN_NODE_VERSION` is the lowest Node.js every pinned dependency
 *   supports (cosmiconfig 10 needs ^22.18 || >=24; commander 15 needs
 *   >=22.12; vitest 5 needs ^22.12 || ^24 || >=26). `scaffold.test.ts` keeps
 *   `engines.node` and the README in agreement with it.
 *
 * Threat model: the same trusted-author, build-time model as every other
 * `scaffold.ts` in this repo; no additional mitigation is needed here.
 */
import { defineScaffold, file } from '../../authoring/builder.js';
import { loadTemplate } from '../../authoring/templateLoader.js';
import type { QuestionConstraints } from '../../core/types.js';
import { authorConstraints, descriptionConstraints } from '../../core/validation.js';

export const DEFAULT_PROJECT_NAME = 'my-cli';
export const DEFAULT_DESCRIPTION = 'A command-line tool';
export const DEFAULT_BIN_NAME = 'my-cli';
export const DEFAULT_AUTHOR = '';
/** Lowest Node.js version every dependency pinned in `templates/package.json.hbs` supports. */
export const MIN_NODE_VERSION = '22.18.0';

const dir = import.meta.dirname;

// ---------------------------------------------------------------------------
// Declarative constraints (closed vocabulary, pure data) rather than
// `validate` closures, so they survive `scaffold synth` into scaffold.json.
// `description` and `author` reuse the shared, already-tested constraints.
// ---------------------------------------------------------------------------

const projectNameConstraints: QuestionConstraints = {
  rules: [
    {
      matches: '^[a-z0-9][a-z0-9_-]{0,213}$',
      message: 'Project name must be a lowercase npm-style name: ^[a-z0-9][a-z0-9_-]{0,213}$',
    },
  ],
};

const binNameConstraints: QuestionConstraints = {
  rules: [
    {
      matches: '^[a-z0-9][a-z0-9-]{0,213}$',
      message: 'Command name must be lowercase letters, digits and hyphens, not starting with a hyphen: ^[a-z0-9][a-z0-9-]{0,213}$',
    },
  ],
};

// ---------------------------------------------------------------------------
// Sibling `.hbs` templates, loaded once at module-evaluation time (same
// convention as `node-http-api-stackfold`).
// ---------------------------------------------------------------------------

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, 'templates/package.json.hbs');
const TSCONFIG_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.json.hbs');
const VITEST_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/vitest.config.ts.hbs');
const GITIGNORE_TEMPLATE = loadTemplate(dir, 'templates/.gitignore.hbs');
const README_TEMPLATE = loadTemplate(dir, 'templates/README.md.hbs');
const SRC_CLI_INDEX_TEMPLATE = loadTemplate(dir, 'templates/src/cli/index.ts.hbs');
const SRC_CLI_GREET_TEMPLATE = loadTemplate(dir, 'templates/src/cli/commands/greet.ts.hbs');
const SRC_CLI_DOCTOR_TEMPLATE = loadTemplate(dir, 'templates/src/cli/commands/doctor.ts.hbs');
const SRC_CORE_PORTS_TEMPLATE = loadTemplate(dir, 'templates/src/core/ports.ts.hbs');
const SRC_CORE_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/src/core/config.ts.hbs');
const SRC_INFRA_PROMPTER_TEMPLATE = loadTemplate(dir, 'templates/src/infra/prompter.ts.hbs');
const SRC_INFRA_PROCESS_RUNNER_TEMPLATE = loadTemplate(dir, 'templates/src/infra/processRunner.ts.hbs');
const SRC_INFRA_CONFIG_STORE_TEMPLATE = loadTemplate(dir, 'templates/src/infra/configStore.ts.hbs');
const TEST_UNIT_GREET_TEMPLATE = loadTemplate(dir, 'templates/tests/unit/greet.test.ts.hbs');
const TEST_UNIT_DOCTOR_TEMPLATE = loadTemplate(dir, 'templates/tests/unit/doctor.test.ts.hbs');
const TEST_UNIT_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/tests/unit/config.test.ts.hbs');
const TEST_UNIT_ARCHITECTURE_TEMPLATE = loadTemplate(dir, 'templates/tests/unit/architecture.test.ts.hbs');
const TEST_INTEGRATION_CLI_TEMPLATE = loadTemplate(dir, 'templates/tests/integration/cli.test.ts.hbs');

/** Answers that reach a JSON string position in `package.json`. */
const PACKAGE_JSON_ESCAPE_KEYS = ['projectName', 'binName', 'description', 'author'];

export default defineScaffold({
  id: 'node-cli-stackfold',
  description:
    'Generates a Node.js + TypeScript command-line application with the same opinionated stack and layered ' +
    'structure as stackfold: commander, @inquirer/prompts, execa, cosmiconfig and zod, wired as ports and ' +
    'adapters, with unit tests on in-memory fakes and an integration test that runs the built binary.',
  help: {
    name: 'Node CLI',
    details:
      'Runtime dependencies: commander, @inquirer/prompts, execa, cosmiconfig, zod. Dev tooling: typescript, vitest, ' +
      '@types/node. Layout: cli/ -> core/ <- infra/, assembled in one composition root. Ships two sample commands ' +
      '(greet, doctor). Questions: projectName, description, binName, author.',
  },

  questions: [
    {
      id: 'projectName',
      message: 'Project name?',
      type: 'input',
      default: DEFAULT_PROJECT_NAME,
      constraints: projectNameConstraints,
    },
    {
      id: 'description',
      message: 'Short description?',
      type: 'input',
      default: DEFAULT_DESCRIPTION,
      constraints: descriptionConstraints,
    },
    {
      id: 'binName',
      message: 'Command name (the executable users will type)?',
      type: 'input',
      default: DEFAULT_BIN_NAME,
      constraints: binNameConstraints,
    },
    {
      id: 'author',
      message: 'Author (optional, written to package.json)?',
      type: 'input',
      default: DEFAULT_AUTHOR,
      constraints: authorConstraints,
    },
  ],

  steps: [
    file('package.json', PACKAGE_JSON_TEMPLATE, { jsonEscapeKeys: PACKAGE_JSON_ESCAPE_KEYS }),
    file('tsconfig.json', TSCONFIG_JSON_TEMPLATE),
    file('vitest.config.ts', VITEST_CONFIG_TEMPLATE),
    file('.gitignore', GITIGNORE_TEMPLATE),
    file('README.md', README_TEMPLATE),
    file('src/cli/index.ts', SRC_CLI_INDEX_TEMPLATE, { jsEscapeKeys: ['description'] }),
    file('src/cli/commands/greet.ts', SRC_CLI_GREET_TEMPLATE),
    file('src/cli/commands/doctor.ts', SRC_CLI_DOCTOR_TEMPLATE),
    file('src/core/ports.ts', SRC_CORE_PORTS_TEMPLATE),
    file('src/core/config.ts', SRC_CORE_CONFIG_TEMPLATE),
    file('src/infra/prompter.ts', SRC_INFRA_PROMPTER_TEMPLATE),
    file('src/infra/processRunner.ts', SRC_INFRA_PROCESS_RUNNER_TEMPLATE),
    file('src/infra/configStore.ts', SRC_INFRA_CONFIG_STORE_TEMPLATE),
    file('tests/unit/greet.test.ts', TEST_UNIT_GREET_TEMPLATE),
    file('tests/unit/doctor.test.ts', TEST_UNIT_DOCTOR_TEMPLATE),
    file('tests/unit/config.test.ts', TEST_UNIT_CONFIG_TEMPLATE),
    file('tests/unit/architecture.test.ts', TEST_UNIT_ARCHITECTURE_TEMPLATE),
    file('tests/integration/cli.test.ts', TEST_INTEGRATION_CLI_TEMPLATE),
  ],

  mainFile: 'README.md',
});
