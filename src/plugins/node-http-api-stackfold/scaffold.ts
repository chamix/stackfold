/**
 * `node-http-api-stackfold` — generates a dependency-free Node.js + TypeScript
 * HTTP microservice (`node:http` only).
 *
 * Six questions (`projectName`, `description`, `port`, and the optional
 * `cors`, `docker` and `exampleResource`) and 27 templates, gated by `when`
 * on the three booleans.
 *
 * Design notes:
 * - Validation of `projectName`/`description`/`port` is declarative
 *   (`constraints`), so this definition has no `validate` closures. As a
 *   result the plugin has no `scaffold.js`: `src/cli/index.ts` loads the
 *   synthesized `scaffold.json`, exactly like `electron-stackfold`.
 * - The authoring DSL (`defineScaffold`, `file()`) is imported from this
 *   repo's own `src/authoring/builder.js`, never from the published
 *   `stackfold/authoring` package. `file()` passes `jsonEscapeKeys` /
 *   `jsEscapeKeys` through to the `writeFile` action.
 * - `templates/Dockerfile.hbs` is lockfile-tolerant (`npm ci` when
 *   `package-lock.json` exists, `npm install` otherwise), so a freshly
 *   generated project, which has no lockfile yet, can `docker build`.
 * - `templates/package.json.hbs` pins the generated project's
 *   devDependencies to the same majors this repo uses (TypeScript 6.x,
 *   vitest 5.x, `@types/node` ^22); the opt-in matrix in
 *   `tests/integration/node-http-api-stackfold-plugin-tier5.test.ts` proves
 *   the generated projects still install, typecheck, build and pass.
 *
 * Threat model: the same trusted-author, build-time model as every other
 * `scaffold.ts` in this repo; no additional mitigation is needed here.
 */
import { defineScaffold, file } from '../../authoring/builder.js';
import { loadTemplate } from '../../authoring/templateLoader.js';
import type { QuestionConstraints } from '../../core/types.js';

export const DEFAULT_PROJECT_NAME = 'my-service';
export const DEFAULT_DESCRIPTION = 'An HTTP microservice';
export const DEFAULT_PORT = '3000';

const dir = import.meta.dirname;

/** `when` gate on a boolean answer — a plain JSON Logic literal, as in `electron-stackfold`/`web-app-stackfold`. */
function on(answerId: string): unknown {
  return { var: answerId };
}

// ---------------------------------------------------------------------------
// Declarative constraints (closed vocabulary, pure data) rather than
// `validate` closures, so they survive `scaffold synth` into scaffold.json.
// ---------------------------------------------------------------------------

const projectNameConstraints: QuestionConstraints = {
  rules: [
    {
      matches: '^[a-z0-9][a-z0-9_-]{0,213}$',
      message: 'Project name must be a lowercase npm-style name: ^[a-z0-9][a-z0-9_-]{0,213}$',
    },
  ],
};

const DESCRIPTION_MESSAGE = 'Description must be a single line of at most 200 characters';

const descriptionConstraints: QuestionConstraints = {
  maxLength: { value: 200, message: DESCRIPTION_MESSAGE },
  rules: [{ notMatches: '[\\r\\n]', message: DESCRIPTION_MESSAGE }],
};

/**
 * Anchored, integer-only 1-65535 port regex — equivalent to
 * `/^[1-9][0-9]{0,4}$/.test(text) && Number(text) <= 65535`, expressed as a
 * single regex so it survives `scaffold synth` as data.
 */
const PORT_PATTERN =
  '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$';

const portConstraints: QuestionConstraints = {
  rules: [{ matches: PORT_PATTERN, message: 'Port must be an integer between 1 and 65535' }],
};

// ---------------------------------------------------------------------------
// Sibling `.hbs` templates — loaded once at module-evaluation time (same
// convention as `electron-stackfold`/`plugin-builder`).
// ---------------------------------------------------------------------------

const PACKAGE_JSON_TEMPLATE = loadTemplate(dir, 'templates/package.json.hbs');
const TSCONFIG_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.json.hbs');
const TSCONFIG_TEST_JSON_TEMPLATE = loadTemplate(dir, 'templates/tsconfig.test.json.hbs');
const VITEST_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/vitest.config.ts.hbs');
const GITIGNORE_TEMPLATE = loadTemplate(dir, 'templates/.gitignore.hbs');
const README_TEMPLATE = loadTemplate(dir, 'templates/README.md.hbs');
const SRC_INDEX_TEMPLATE = loadTemplate(dir, 'templates/src/index.ts.hbs');
const SRC_SERVER_TEMPLATE = loadTemplate(dir, 'templates/src/server.ts.hbs');
const SRC_CONFIG_TEMPLATE = loadTemplate(dir, 'templates/src/config.ts.hbs');
const SRC_LOGGER_TEMPLATE = loadTemplate(dir, 'templates/src/logger.ts.hbs');
const SRC_ROUTER_TEMPLATE = loadTemplate(dir, 'templates/src/router.ts.hbs');
const SRC_BODY_TEMPLATE = loadTemplate(dir, 'templates/src/body.ts.hbs');
const SRC_ERRORS_TEMPLATE = loadTemplate(dir, 'templates/src/errors.ts.hbs');
const SRC_TYPES_TEMPLATE = loadTemplate(dir, 'templates/src/types.ts.hbs');
const SRC_ROUTES_HEALTH_TEMPLATE = loadTemplate(dir, 'templates/src/routes/health.ts.hbs');
const TEST_ROUTER_TEMPLATE = loadTemplate(dir, 'templates/test/router.test.ts.hbs');
const TEST_BODY_TEMPLATE = loadTemplate(dir, 'templates/test/body.test.ts.hbs');
const TEST_LOGGER_TEMPLATE = loadTemplate(dir, 'templates/test/logger.test.ts.hbs');
const TEST_HEALTH_TEMPLATE = loadTemplate(dir, 'templates/test/health.test.ts.hbs');
const TEST_SHUTDOWN_TEMPLATE = loadTemplate(dir, 'templates/test/shutdown.test.ts.hbs');
// Optional: cors.
const SRC_MIDDLEWARE_CORS_TEMPLATE = loadTemplate(dir, 'templates/src/middleware/cors.ts.hbs');
const TEST_CORS_TEMPLATE = loadTemplate(dir, 'templates/test/cors.test.ts.hbs');
// Optional: docker.
const DOCKERFILE_TEMPLATE = loadTemplate(dir, 'templates/Dockerfile.hbs');
const DOCKERIGNORE_TEMPLATE = loadTemplate(dir, 'templates/.dockerignore.hbs');
// Optional: exampleResource.
const SRC_ROUTES_ITEMS_TEMPLATE = loadTemplate(dir, 'templates/src/routes/items.ts.hbs');
const SRC_ROUTES_ITEMS_STORE_TEMPLATE = loadTemplate(dir, 'templates/src/routes/items-store.ts.hbs');
const TEST_ITEMS_TEMPLATE = loadTemplate(dir, 'templates/test/items.test.ts.hbs');

const WHEN_CORS = on('cors');
const WHEN_DOCKER = on('docker');
const WHEN_EXAMPLE_RESOURCE = on('exampleResource');

export default defineScaffold({
  id: 'node-http-api-stackfold',
  description:
    'Generates a dependency-free Node.js + TypeScript HTTP microservice (node:http only) with router, JSON ' +
    'body parsing, structured logs, health/readiness probes, graceful shutdown, and optional CORS, Dockerfile ' +
    'and example resource.',
  help: {
    name: 'Node HTTP API',
    details:
      'Zero runtime dependencies: node:http only. Dev tooling: typescript, vitest, tsx, @types/node. Questions: ' +
      'projectName, description, port, cors, docker, exampleResource.',
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
      id: 'port',
      message: 'Default HTTP port?',
      type: 'input',
      default: DEFAULT_PORT,
      constraints: portConstraints,
    },
    { id: 'cors', message: 'Include CORS support?', type: 'confirm', default: false },
    { id: 'docker', message: 'Include a Dockerfile?', type: 'confirm', default: false },
    { id: 'exampleResource', message: 'Include example resource /api/v1/items?', type: 'confirm', default: false },
  ],

  steps: [
    // Always generated.
    file('package.json', PACKAGE_JSON_TEMPLATE, { jsonEscapeKeys: ['projectName', 'description'] }),
    file('tsconfig.json', TSCONFIG_JSON_TEMPLATE),
    file('tsconfig.test.json', TSCONFIG_TEST_JSON_TEMPLATE),
    file('vitest.config.ts', VITEST_CONFIG_TEMPLATE),
    file('.gitignore', GITIGNORE_TEMPLATE),
    file('README.md', README_TEMPLATE),
    file('src/index.ts', SRC_INDEX_TEMPLATE),
    file('src/server.ts', SRC_SERVER_TEMPLATE),
    file('src/config.ts', SRC_CONFIG_TEMPLATE, { jsEscapeKeys: ['projectName'] }),
    file('src/logger.ts', SRC_LOGGER_TEMPLATE),
    file('src/router.ts', SRC_ROUTER_TEMPLATE),
    file('src/body.ts', SRC_BODY_TEMPLATE),
    file('src/errors.ts', SRC_ERRORS_TEMPLATE),
    file('src/types.ts', SRC_TYPES_TEMPLATE),
    file('src/routes/health.ts', SRC_ROUTES_HEALTH_TEMPLATE),
    file('test/router.test.ts', TEST_ROUTER_TEMPLATE),
    file('test/body.test.ts', TEST_BODY_TEMPLATE),
    file('test/logger.test.ts', TEST_LOGGER_TEMPLATE),
    file('test/health.test.ts', TEST_HEALTH_TEMPLATE),
    file('test/shutdown.test.ts', TEST_SHUTDOWN_TEMPLATE),
    // Optional: cors.
    file('src/middleware/cors.ts', SRC_MIDDLEWARE_CORS_TEMPLATE, { when: WHEN_CORS }),
    file('test/cors.test.ts', TEST_CORS_TEMPLATE, { when: WHEN_CORS }),
    // Optional: docker.
    file('Dockerfile', DOCKERFILE_TEMPLATE, { when: WHEN_DOCKER }),
    file('.dockerignore', DOCKERIGNORE_TEMPLATE, { when: WHEN_DOCKER }),
    // Optional: exampleResource.
    file('src/routes/items.ts', SRC_ROUTES_ITEMS_TEMPLATE, { when: WHEN_EXAMPLE_RESOURCE }),
    file('src/routes/items-store.ts', SRC_ROUTES_ITEMS_STORE_TEMPLATE, { when: WHEN_EXAMPLE_RESOURCE }),
    file('test/items.test.ts', TEST_ITEMS_TEMPLATE, { when: WHEN_EXAMPLE_RESOURCE }),
  ],

  mainFile: 'README.md',
});
