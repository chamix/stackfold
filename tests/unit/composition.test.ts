import { describe, expect, it } from 'vitest';
import { composeBlueprint, type BlueprintFragment } from '../../src/core/composition.js';
import { InvalidBlueprintError } from '../../src/core/orchestrator.js';

function fragment(partial: Partial<BlueprintFragment> & { id: string }): BlueprintFragment {
  return { files: [], ...partial };
}

describe('composeBlueprint — zero fragments', () => {
  it('returns an empty, valid ProjectBlueprint without crashing', () => {
    expect(composeBlueprint([])).toEqual({ files: [], postActions: [] });
  });
});

describe('composeBlueprint — exclusive (default) strategy', () => {
  it('passes a single contributor straight through unchanged', () => {
    const result = composeBlueprint([
      fragment({ id: 'a', files: [{ path: 'README.md', content: '# Hi\n' }] }),
    ]);
    expect(result.files).toEqual([{ path: 'README.md', content: '# Hi\n' }]);
  });

  it('throws InvalidBlueprintError naming both fragment ids and the path on a collision', () => {
    const fragments = [
      fragment({ id: 'frag-a', files: [{ path: 'index.html', content: '<html>a</html>' }] }),
      fragment({ id: 'frag-b', files: [{ path: 'index.html', content: '<html>b</html>' }] }),
    ];

    let caught: unknown;
    try {
      composeBlueprint(fragments);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidBlueprintError);
    const err = caught as InvalidBlueprintError;
    expect(err.issues.join('\n')).toMatch(/frag-a/);
    expect(err.issues.join('\n')).toMatch(/frag-b/);
    expect(err.issues.join('\n')).toMatch(/index\.html/);
  });

  it('a non-colliding path from each fragment is unaffected by an unrelated collision', () => {
    const fragments = [
      fragment({
        id: 'a',
        files: [
          { path: 'a-only.txt', content: 'a' },
          { path: 'shared.txt', content: 'x' },
        ],
      }),
      fragment({ id: 'b', files: [{ path: 'shared.txt', content: 'y' }] }),
    ];
    expect(() => composeBlueprint(fragments)).toThrow(InvalidBlueprintError);
  });
});

describe('composeBlueprint — json-merge strategy', () => {
  it('deep-merges dependencies/devDependencies/scripts from multiple fragments into one object', () => {
    const fragments = [
      fragment({
        id: 'base',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({ name: 'demo', dependencies: { react: '^19.0.0' } }),
          },
        ],
      }),
      fragment({
        id: 'vitest',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({
              devDependencies: { vitest: '^5.0.0' },
              scripts: { test: 'vitest run' },
            }),
          },
        ],
      }),
      fragment({
        id: 'vite',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({
              devDependencies: { vite: '^8.0.0' },
              scripts: { dev: 'vite' },
            }),
          },
        ],
      }),
    ];

    const result = composeBlueprint(fragments);
    const pkg = JSON.parse(result.files.find((f) => f.path === 'package.json')!.content.toString());

    expect(pkg).toEqual({
      name: 'demo',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vitest: '^5.0.0', vite: '^8.0.0' },
      scripts: { test: 'vitest run', dev: 'vite' },
    });
  });

  it('throws on a leaf-value conflict, naming the key path', () => {
    const fragments = [
      fragment({
        id: 'a',
        files: [{ path: 'package.json', strategy: 'json-merge', content: JSON.stringify({ type: 'module' }) }],
      }),
      fragment({
        id: 'b',
        files: [{ path: 'package.json', strategy: 'json-merge', content: JSON.stringify({ type: 'commonjs' }) }],
      }),
    ];

    let caught: unknown;
    try {
      composeBlueprint(fragments);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidBlueprintError);
    expect((caught as InvalidBlueprintError).issues.join('\n')).toMatch(/type/);
  });

  it('does not throw when both sides declare an identical leaf value', () => {
    const fragments = [
      fragment({
        id: 'a',
        files: [{ path: 'package.json', strategy: 'json-merge', content: JSON.stringify({ type: 'module' }) }],
      }),
      fragment({
        id: 'b',
        files: [{ path: 'package.json', strategy: 'json-merge', content: JSON.stringify({ type: 'module' }) }],
      }),
    ];
    expect(() => composeBlueprint(fragments)).not.toThrow();
  });

  it('a leaf-value conflict nested under a shared object key is reported with the full key path', () => {
    const fragments = [
      fragment({
        id: 'a',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({ dependencies: { react: '^18.0.0' } }),
          },
        ],
      }),
      fragment({
        id: 'b',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
          },
        ],
      }),
    ];
    let caught: unknown;
    try {
      composeBlueprint(fragments);
    } catch (err) {
      caught = err;
    }
    expect((caught as InvalidBlueprintError).issues.join('\n')).toMatch(/dependencies\.react/);
  });

  it('output key order is a regression-pinned snapshot of order-of-first-appearance across fragments', () => {
    const fragments = [
      fragment({
        id: 'base',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({ name: 'demo', version: '0.1.0', private: true, type: 'module' }),
          },
        ],
      }),
      fragment({
        id: 'vite-react',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({
              dependencies: { react: '^19.3.0', 'react-dom': '^19.3.0' },
              devDependencies: { vite: '^8.3.4' },
              scripts: { dev: 'vite', build: 'vite build' },
            }),
          },
        ],
      }),
      fragment({
        id: 'vitest',
        files: [
          {
            path: 'package.json',
            strategy: 'json-merge',
            content: JSON.stringify({ devDependencies: { vitest: '^5.0.4' }, scripts: { test: 'vitest run' } }),
          },
        ],
      }),
    ];

    const result = composeBlueprint(fragments);
    const raw = result.files.find((f) => f.path === 'package.json')!.content.toString();

    expect(Object.keys(JSON.parse(raw))).toEqual([
      'name',
      'version',
      'private',
      'type',
      'dependencies',
      'devDependencies',
      'scripts',
    ]);
    expect(Object.keys(JSON.parse(raw).devDependencies)).toEqual(['vite', 'vitest']);
    expect(Object.keys(JSON.parse(raw).scripts)).toEqual(['dev', 'build', 'test']);
    expect(raw).toBe(`${raw.trimEnd()}\n`);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('throws when a fragment contributes non-JSON content to a json-merge path', () => {
    const fragments = [
      fragment({
        id: 'a',
        files: [{ path: 'package.json', strategy: 'json-merge', content: '{ not: json' }],
      }),
      fragment({
        id: 'b',
        files: [{ path: 'package.json', strategy: 'json-merge', content: JSON.stringify({ type: 'module' }) }],
      }),
    ];
    expect(() => composeBlueprint(fragments)).toThrow(InvalidBlueprintError);
  });
});

describe('composeBlueprint — append strategy', () => {
  it('concatenates contributions and dedupes exact-duplicate lines, preserving first occurrence position', () => {
    const fragments = [
      fragment({ id: 'base', files: [{ path: '.gitignore', strategy: 'append', content: 'node_modules/\ndist/\n' }] }),
      fragment({ id: 'extra', files: [{ path: '.gitignore', strategy: 'append', content: 'dist/\n.env\n' }] }),
    ];

    const result = composeBlueprint(fragments);
    const content = result.files.find((f) => f.path === '.gitignore')!.content.toString();

    expect(content).toBe('node_modules/\ndist/\n.env\n');
  });

  it('a single append contributor passes through with its content unchanged', () => {
    const fragments = [fragment({ id: 'a', files: [{ path: '.gitignore', strategy: 'append', content: 'dist/\n' }] })];
    expect(composeBlueprint(fragments).files).toEqual([{ path: '.gitignore', content: 'dist/\n' }]);
  });
});

describe('composeBlueprint — postActions', () => {
  it('concatenates postActions across fragments, in fragment order, as a plain array (not an aspect merge)', () => {
    const fragments = [
      fragment({ id: 'base-ts', files: [], postActions: [{ kind: 'git-init' }] }),
      fragment({ id: 'vite-react', files: [], postActions: [{ kind: 'npm-install' }] }),
    ];
    expect(composeBlueprint(fragments).postActions).toEqual([{ kind: 'git-init' }, { kind: 'npm-install' }]);
  });

  it('a fragment that omits postActions contributes none', () => {
    const fragments = [fragment({ id: 'standalone-html', files: [] })];
    expect(composeBlueprint(fragments).postActions).toEqual([]);
  });
});
