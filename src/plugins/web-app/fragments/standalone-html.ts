/**
 * `standalone-html` fragment: the entire `web-app-standalone-html` flavor
 * in one contribution (initial_scaffold.md, "Content specification") — a
 * single, dependency-free HTML file. No `package.json` contribution at
 * all, no `postActions`: this is the degenerate case that validates the
 * composition model needs no special-casing anywhere in the orchestrator
 * (SK-ADR-001's "Consequences"; functional_domain_webapp.md §3.7).
 */
import type { Answers } from '../../../core/types.js';
import type { BlueprintFragment } from '../../../core/composition.js';
import { escapeHtml, resolveSharedContext } from '../shared-questions.js';

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;

function renderIndexHtml(ctx: { appName: string; description: string }): string {
  return lines(
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <meta name="description" content="${escapeHtml(ctx.description)}" />`,
    `    <title>${escapeHtml(ctx.appName)}</title>`,
    '    <style>',
    '      body {',
    '        font-family: system-ui, sans-serif;',
    '        display: flex;',
    '        min-height: 100vh;',
    '        margin: 0;',
    '        align-items: center;',
    '        justify-content: center;',
    '      }',
    '    </style>',
    '  </head>',
    '  <body>',
    `    <main><h1>${escapeHtml(ctx.appName)}</h1></main>`,
    '    <script>',
    '      // No network calls after initial load — this is a standalone,',
    "      // dependency-free file, not a lightweight SPA (functional_domain_webapp.md §1).",
    '    </script>',
    '  </body>',
    '</html>'
  );
}

export function standaloneHtmlFragment(answers: Answers): BlueprintFragment {
  const ctx = resolveSharedContext(answers);

  return {
    id: 'standalone-html',
    files: [{ path: 'index.html', content: renderIndexHtml(ctx) }],
  };
}
