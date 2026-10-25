/**
 * Shared `.hbs` template loader (SK-ADR-003 Decision 4) — reads a template
 * file from disk, relative to a given base directory, and returns its raw
 * string content for a scaffold author to inline into a `file()`/
 * `writeFile` step's `content` at synth time (`src/authoring/synth.ts`
 * never calls this itself — a `ScaffoldDefinition` handed to `synth()` is
 * already fully resolved; this loader runs earlier, from inside the
 * author's own `scaffold.ts` module, while it's being evaluated).
 *
 * Exists so every plugin author shares one small, well-tested disk read
 * instead of each hand-rolling its own `node:fs` call — the same ergonomics
 * motivation as every other shared helper in `src/authoring/`.
 *
 * `src/authoring/` is tooling (a peer of `infra/`/`cli/`), not `core/` —
 * real `node:fs`/`node:path` imports are fine here, unlike `core/
 * authoring.ts`, which explicitly may not import either (see that module's
 * own header comment on the Inward Dependency Rule).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reads `relativePath` resolved against `baseDir` and returns its raw text
 * content, untouched — no Handlebars compilation, no escaping. The caller
 * (typically a scaffold author's own `scaffold.ts`, passing `baseDir =
 * import.meta.dirname` or an equivalent sibling-directory path) decides
 * what to do with the string, usually handing it straight to `file()`'s
 * `content` parameter (`src/authoring/builder.ts`).
 *
 * Throws a clear, specific error — naming the resolved absolute path — if
 * the file does not exist or can't be read, rather than letting a bare
 * `ENOENT` propagate.
 */
export function loadTemplate(baseDir: string, relativePath: string): string {
  const absolutePath = resolve(baseDir, relativePath);

  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      throw new Error(`loadTemplate: template file not found at "${absolutePath}"`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`loadTemplate: failed to read "${absolutePath}": ${message}`);
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}
