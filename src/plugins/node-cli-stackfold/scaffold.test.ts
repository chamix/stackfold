import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileScaffold, type ScaffoldDefinition } from '../../core/authoring.js';
import { JsonLogicExpressionEvaluator } from '../../infra/expressionEvaluator.js';
import definition, {
  DEFAULT_AUTHOR,
  DEFAULT_BIN_NAME,
  DEFAULT_DESCRIPTION,
  DEFAULT_PROJECT_NAME,
  MIN_NODE_VERSION,
} from './scaffold.js';

// Proves node-cli-stackfold's own scaffold.ts compiles and synthesizes real
// blueprints directly (via its real default export, not the synthesized
// ./scaffold.json), so this test never depends on `stackfold scaffold synth`
// having run. The generated project itself (install, typecheck, build, its own
// tests, the packed bin) is proven by the opt-in tier-5 test.

const EXPECTED_PATHS = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  '.gitignore',
  'README.md',
  'src/cli/index.ts',
  'src/cli/commands/greet.ts',
  'src/cli/commands/doctor.ts',
  'src/core/ports.ts',
  'src/core/config.ts',
  'src/infra/prompter.ts',
  'src/infra/processRunner.ts',
  'src/infra/configStore.ts',
  'tests/unit/greet.test.ts',
  'tests/unit/doctor.test.ts',
  'tests/unit/config.test.ts',
  'tests/unit/architecture.test.ts',
  'tests/integration/cli.test.ts',
];

const BASE_ANSWERS = {
  projectName: DEFAULT_PROJECT_NAME,
  description: DEFAULT_DESCRIPTION,
  binName: DEFAULT_BIN_NAME,
  author: DEFAULT_AUTHOR,
};

const SPECIAL_ANSWERS = {
  projectName: 'acme-tools',
  description: `He said "hi" & <b>it's</b> a \\ test`,
  binName: 'acme',
  author: `Ada "Countess" O'Brien <ada@example.com> & Co\\Ltd`,
};

function buildPlugin() {
  return compileScaffold(definition as ScaffoldDefinition, new JsonLogicExpressionEvaluator());
}

function render(answers: Record<string, string> = BASE_ANSWERS): Map<string, string> {
  const blueprint = buildPlugin().buildBlueprint(answers);
  return new Map(blueprint.files.map((f) => [f.path, String(f.content)]));
}

function file(files: Map<string, string>, path: string): string {
  const content = files.get(path);
  expect(content, `${path} must be generated`).toBeDefined();
  return content as string;
}

/** The repo's own package.json: the source of truth for the dependency majors the template pins. */
const REPO_PACKAGE_JSON = JSON.parse(readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const major = (range: string): string => /(\d+)/.exec(range)?.[1] ?? '';

describe('node-cli-stackfold: its own ScaffoldDefinition compiles', () => {
  it('parses/compiles via compileScaffold() without throwing', () => {
    expect(() => buildPlugin()).not.toThrow();
  });

  it('declares projectName/description/binName/author, in that order, all free-text, with the expected defaults', () => {
    const questions = buildPlugin().questions();
    expect(questions.map((q) => q.id)).toEqual(['projectName', 'description', 'binName', 'author']);
    expect(questions.map((q) => q.type)).toEqual(['input', 'input', 'input', 'input']);
    expect(questions.map((q) => q.default)).toEqual(['my-cli', 'A command-line tool', 'my-cli', '']);
    expect(DEFAULT_PROJECT_NAME).toBe('my-cli');
    expect(DEFAULT_BIN_NAME).toBe('my-cli');
  });

  it('declares mainFile as README.md', () => {
    expect(buildPlugin().buildBlueprint(BASE_ANSWERS).mainFile).toBe('README.md');
  });

  it('defines no validate closure of its own (declarative constraints only, so no scaffold.js is needed)', () => {
    for (const q of (definition as ScaffoldDefinition).questions) {
      expect(q.validate, `${q.id} must not carry a validate closure`).toBeUndefined();
      expect(q.constraints, `${q.id} must declare constraints`).toBeDefined();
    }
  });
});

describe('node-cli-stackfold: the synthesized scaffold.json (what the CLI registers) matches scaffold.ts', () => {
  it('is byte-for-byte the same definition, so a template edit without a re-synth is caught', () => {
    const synthesized = JSON.parse(readFileSync(join(import.meta.dirname, 'scaffold.json'), 'utf8')) as ScaffoldDefinition;
    expect(synthesized).toEqual(JSON.parse(JSON.stringify(definition)));
  });
});

describe('node-cli-stackfold: generated file tree', () => {
  it('builds exactly the expected, unconditional file set', () => {
    expect([...render().keys()].sort()).toEqual([...EXPECTED_PATHS].sort());
  });

  it('builds the same tree for different answers (no conditional files)', () => {
    expect([...render(SPECIAL_ANSWERS).keys()].sort()).toEqual([...EXPECTED_PATHS].sort());
  });

  it('is deterministic: the same answers produce byte-identical files', () => {
    expect([...render(SPECIAL_ANSWERS).entries()]).toEqual([...render(SPECIAL_ANSWERS).entries()]);
  });

  it('every template under templates/ has a file() step (no orphan .hbs)', () => {
    const templatesDir = join(import.meta.dirname, 'templates');
    const onDisk = readdirSync(templatesDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.hbs'))
      .map((entry) => relative(templatesDir, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .map((p) => p.replace(/\.hbs$/, ''))
      .sort();
    expect(onDisk).toEqual([...render().keys()].sort());
  });

  it('leaves no unresolved Handlebars expression and no governance reference in any file', () => {
    for (const answers of [BASE_ANSWERS, SPECIAL_ANSWERS]) {
      for (const [path, content] of render(answers)) {
        expect(content, `${path} contains an unresolved {{`).not.toContain('{{');
        expect(content, `${path} references governance material`).not.toMatch(
          /\.agents|\.claude|SK-ADR|EXP-001|CLAUDE\.md|stackfold/i
        );
      }
    }
  });
});

describe('node-cli-stackfold: package.json', () => {
  const pkg = (answers: Record<string, string> = BASE_ANSWERS) =>
    JSON.parse(file(render(answers), 'package.json')) as Record<string, unknown>;

  it('declares an ESM package whose bin is the answered binName, shipping only dist', () => {
    const json = pkg();
    expect(json['name']).toBe('my-cli');
    expect(json['description']).toBe('A command-line tool');
    expect(json['type']).toBe('module');
    expect(json['bin']).toEqual({ 'my-cli': 'dist/cli/index.js' });
    expect(json['files']).toEqual(['dist']);
  });

  it('uses a binName that differs from the projectName', () => {
    const json = pkg(SPECIAL_ANSWERS);
    expect(json['name']).toBe('acme-tools');
    expect(json['bin']).toEqual({ acme: 'dist/cli/index.js' });
  });

  it('declares the build, typecheck, test and start scripts', () => {
    const scripts = pkg()['scripts'] as Record<string, string>;
    expect(scripts['build']).toBe('tsc -p tsconfig.json');
    expect(scripts['typecheck']).toBe('tsc --noEmit -p tsconfig.json');
    expect(scripts['test']).toBe('vitest run');
    expect(scripts['start']).toBe('node dist/cli/index.js');
  });

  it('pins the five runtime dependencies and the dev tooling to the majors this repo itself uses', () => {
    const json = pkg();
    const dependencies = json['dependencies'] as Record<string, string>;
    const devDependencies = json['devDependencies'] as Record<string, string>;
    expect(Object.keys(dependencies).sort()).toEqual(['@inquirer/prompts', 'commander', 'cosmiconfig', 'execa', 'zod']);
    expect(Object.keys(devDependencies).sort()).toEqual(['@types/node', 'typescript', 'vitest']);
    for (const [name, range] of Object.entries(dependencies)) {
      expect(major(range), `${name} major`).toBe(major(REPO_PACKAGE_JSON.dependencies[name] ?? ''));
    }
    for (const [name, range] of Object.entries(devDependencies)) {
      expect(major(range), `${name} major`).toBe(major(REPO_PACKAGE_JSON.devDependencies[name] ?? ''));
    }
  });

  it('declares an engines.node minimum that the README states too (they cannot disagree)', () => {
    const files = render();
    const engines = (JSON.parse(file(files, 'package.json')) as { engines: { node: string } }).engines.node;
    expect(engines).toBe(`>=${MIN_NODE_VERSION}`);
    expect(file(files, 'README.md')).toContain(`Node.js ${MIN_NODE_VERSION} or later`);
  });

  it('omits the author key when the author answer is empty', () => {
    expect(pkg()).not.toHaveProperty('author');
  });

  it('writes the author when one is given', () => {
    expect(pkg({ ...BASE_ANSWERS, author: 'Ada Lovelace' })['author']).toBe('Ada Lovelace');
  });
});

describe('node-cli-stackfold: special-character answers', () => {
  it('keeps package.json valid JSON and round-trips description and author exactly', () => {
    const json = JSON.parse(file(render(SPECIAL_ANSWERS), 'package.json')) as Record<string, unknown>;
    expect(json['description']).toBe(SPECIAL_ANSWERS.description);
    expect(json['author']).toBe(SPECIAL_ANSWERS.author);
  });

  it('keeps the README text intact (no HTML-escaping of the answers)', () => {
    const readme = file(render(SPECIAL_ANSWERS), 'README.md');
    expect(readme).toContain(SPECIAL_ANSWERS.description);
    expect(readme).not.toContain('&amp;');
    expect(readme).not.toContain('&quot;');
  });

  it('places the description in the composition root as a valid, correctly escaped string literal', () => {
    const index = file(render(SPECIAL_ANSWERS), 'src/cli/index.ts');
    expect(index).toContain(`.description('He said "hi" & <b>it\\'s</b> a \\\\ test')`);
    const result = ts.transpileModule(index, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(result.diagnostics ?? []).toEqual([]);
  });
});

describe('node-cli-stackfold: generated README', () => {
  let readme = '';
  beforeAll(() => {
    readme = file(render(), 'README.md');
  });
  /** Markdown headings of one level, ignoring lines inside fenced code blocks (shell comments start with `#`). */
  const headings = (level: string) => {
    let inFence = false;
    const found: string[] = [];
    for (const line of readme.split('\n')) {
      if (line.startsWith('```')) inFence = !inFence;
      else if (!inFence && line.startsWith(`${level} `)) found.push(line.slice(level.length + 1).trim());
    }
    return found;
  };

  it('has one H1 and the sections in the documented order', () => {
    expect(headings('#')).toEqual(['my-cli']);
    expect(headings('##')).toEqual(['Requirements', 'Install', 'Usage', 'Configuration', 'Development', 'Project structure']);
  });

  it('documents greet before doctor under Usage', () => {
    const usage = headings('###');
    expect(usage.indexOf('greet')).toBeGreaterThanOrEqual(0);
    expect(usage.indexOf('doctor')).toBeGreaterThan(usage.indexOf('greet'));
  });

  it('documents exactly the commands and options the code defines', () => {
    const files = render();
    const greet = file(files, 'src/cli/commands/greet.ts');
    const doctor = file(files, 'src/cli/commands/doctor.ts');
    const index = file(files, 'src/cli/index.ts');
    expect(greet).toContain(".command('greet')");
    expect(greet).toContain("'--times <n>'");
    expect(greet).toContain("'--shout'");
    expect(doctor).toContain(".command('doctor')");
    expect(index).toContain('registerGreetCommand');
    expect(index).toContain('registerDoctorCommand');
    expect(readme).toContain('my-cli greet [name]');
    expect(readme).toContain('--times <n>');
    expect(readme).toContain('--shout');
    expect(readme).toContain('my-cli doctor');
    expect(readme).toContain('DEBUG=1');
  });

  it('documents every file of the project structure it describes', () => {
    for (const path of EXPECTED_PATHS.filter((p) => p.startsWith('src/'))) {
      const name = path.split('/').pop() as string;
      expect(readme, `README mentions ${path}`).toContain(name);
    }
  });
});

describe('node-cli-stackfold: layering of the generated sources', () => {
  it('keeps core/ free of cli/ and infra/ imports and of any third-party package except zod', () => {
    for (const [path, content] of render()) {
      if (!path.startsWith('src/core/')) continue;
      const specifiers = [...content.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const specifier of specifiers) {
        const allowed = specifier === 'zod' || /^\.\/[a-z]+\.js$/.test(specifier);
        expect(allowed, `${path} imports ${specifier}`).toBe(true);
      }
    }
  });
});

describe('node-cli-stackfold: derived validate() from the declarative constraints', () => {
  const question = (id: string) => buildPlugin().questions().find((q) => q.id === id);

  it('projectName: rejects non-lowercase-npm-style names, accepts valid ones', () => {
    const projectName = question('projectName');
    expect(projectName?.validate).toBeTypeOf('function');
    for (const bad of ['Bad Name', '@a/b', '_x', '', '-x', 'a'.repeat(215)]) {
      expect(projectName?.validate?.(bad), `"${bad}"`).not.toBe(true);
    }
    for (const good of ['my-cli', 'a', 'x_y-z9', 'a'.repeat(214)]) {
      expect(projectName?.validate?.(good), `"${good}"`).toBe(true);
    }
  });

  it('binName: rejects uppercase, spaces, underscores, a leading hyphen and an empty value', () => {
    const binName = question('binName');
    for (const bad of ['Acme', 'my cli', 'my_cli', '-cli', '', '../x', 'a'.repeat(215)]) {
      expect(binName?.validate?.(bad), `"${bad}"`).not.toBe(true);
    }
    for (const good of ['acme', 'my-cli', '0tool', 'a'.repeat(214)]) {
      expect(binName?.validate?.(good), `"${good}"`).toBe(true);
    }
  });

  it('description: rejects more than 200 characters and multi-line values, accepts the boundary and an empty one', () => {
    const description = question('description');
    expect(description?.validate?.('a'.repeat(201))).not.toBe(true);
    expect(description?.validate?.('line one\nline two')).not.toBe(true);
    expect(description?.validate?.('a'.repeat(200))).toBe(true);
    expect(description?.validate?.('')).toBe(true);
    expect(description?.validate?.('A short description')).toBe(true);
  });

  it('author: accepts empty and a normal name, rejects multi-line values', () => {
    const author = question('author');
    expect(author?.validate?.('')).toBe(true);
    expect(author?.validate?.('Ada Lovelace')).toBe(true);
    expect(author?.validate?.('Ada\nLovelace')).not.toBe(true);
  });
});
