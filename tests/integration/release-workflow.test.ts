import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SEC-002 — contract of the real release workflow: a pushed tag may only
 * *stage* a version (a human approves it on the registry with 2FA), and the
 * GitHub Release stays a draft until then.
 *
 * This checks the workflow's **text**, with no network and no YAML parser.
 * It says nothing about how GitHub Actions or the npm registry actually
 * behave; only a real release run proves that.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const LINES = RAW.split(/\r?\n/);

/** A line as the shell/YAML would act on it: no indentation, no trailing or whole-line `#` comment. */
function code(line: string): string {
  return line.replace(/(^|\s)#.*$/, '').trim();
}

const JOB_HEADER = /^ {2}([\w-]+):\s*$/;

/** The untouched lines of one job: from its `  <id>:` header up to the next job header (or end of file). */
function rawJobLines(id: string): string[] {
  const start = LINES.indexOf(`  ${id}:`);
  expect(start, `job "${id}" not found`).toBeGreaterThanOrEqual(0);
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex((line) => JOB_HEADER.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The code lines of one job. */
function jobLines(id: string): string[] {
  return rawJobLines(id)
    .map(code)
    .filter((line) => line !== '');
}

/** Anything that could take part in publishing a GitHub Release from a shell script. */
const WATCHED = /\bgh\b|publish_draft|draft=false/i;

/**
 * Drops a `#` comment without being fooled by a `#` inside quotes. When in
 * doubt it keeps the text (the scan then over-reports, never under-reports):
 * a would-be comment that has both a quote and a watched word is kept, since
 * on the second line of a multi-line string it would really be code.
 */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === '\\' && quote !== "'") i++;
    else if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      const comment = line.slice(i);
      return WATCHED.test(comment) && /["'`]/.test(comment) ? line : line.slice(0, i);
    }
  }
  return line;
}

/** The whole workflow as commands: comments dropped, backslash continuations joined, whitespace collapsed. */
function logicalLines(): string[] {
  const result: string[] = [];
  let pending = '';
  for (const line of LINES) {
    const stripped = stripComment(line);
    // An odd run of trailing backslashes continues the line; a comment never does.
    if (stripped === line && (/\\*$/.exec(line)?.[0].length ?? 0) % 2 === 1) {
      pending += line.slice(0, -1);
      continue;
    }
    const joined = (pending + stripped).replace(/\s+/g, ' ').trim();
    pending = '';
    if (joined !== '') result.push(joined);
  }
  return pending === '' ? result : [...result, pending.trim()];
}

/**
 * `echo` of exactly one double-quoted string that runs nothing: it ends the
 * line (so nothing is chained, piped or redirected after it) and holds no
 * unescaped quote, backtick or `$(`.
 */
const INERT_ECHO = /^echo "(?:\\.|\$(?!\()|[^"\\`$])*"$/;

const SUMMARY_CLOSE = '} >> "$GITHUB_STEP_SUMMARY"';
const PUBLISH_DRAFT_ASSIGNMENT = 'publish_draft="gh release edit $GITHUB_REF_NAME --draft=false"';
const PUBLISH_DRAFT_LATEST = 'publish_draft+=" --latest"';

/** The single `{ ... } >> "$GITHUB_STEP_SUMMARY"` group: its position and the lines inside it. */
function summaryGroup(lines: string[]): { open: number; close: number; body: string[] } {
  expect(lines.filter((l) => l === '{')).toHaveLength(1);
  expect(lines.filter((l) => l === SUMMARY_CLOSE)).toHaveLength(1);
  const open = lines.indexOf('{');
  const close = lines.indexOf(SUMMARY_CLOSE);
  expect(close).toBeGreaterThan(open);
  return { open, close, body: lines.slice(open + 1, close) };
}

/** Every `permissions` key in the file with the job that owns it and its nested lines, indentation included. */
function permissionBlocks(): { job: string | null; block: string[] }[] {
  const lines = LINES.map((l) => stripComment(l).trimEnd()).filter((l) => l !== '');
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const blocks: { job: string | null; block: string[] }[] = [];
  let section = '';
  let job: string | null = null;
  lines.forEach((line, index) => {
    if (indentOf(line) === 0) {
      section = line;
      job = null;
    } else if (section === 'jobs:') job = JOB_HEADER.exec(line)?.[1] ?? job;
    if (!/(?:^\s*(?:-\s+)?|[{,]\s*)["']?permissions["']?\s*:/.test(line)) return;
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((l) => indentOf(l) <= indentOf(line));
    blocks.push({ job, block: [line, ...(end === -1 ? rest : rest.slice(0, end))] });
  });
  return blocks;
}

/** Index of the first line satisfying `predicate`; fails the test when there is none. */
function indexOfLine(lines: string[], predicate: (line: string) => boolean, what: string): number {
  const index = lines.findIndex(predicate);
  expect(index, `expected ${what}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('release workflow — staged publishing only (SEC-002)', () => {
  it('never mentions a direct publish, comments included', () => {
    const offending = LINES.filter((line) => line.includes('npm publish'));
    expect(offending).toEqual([]);
  });

  it('ends the publish job by staging: --tag next for prereleases, the default tag otherwise', () => {
    // Whole-line equality: the `--tag next` line cannot satisfy the plain one.
    expect(jobLines('publish').slice(-5)).toEqual([
      'if [[ "$GITHUB_REF_NAME" == *-* ]]; then',
      'npm stage publish --tag next',
      'else',
      'npm stage publish',
      'fi',
    ]);
  });

  it('fails closed on an npm too old for staged publishing, right after setup-node and before anything else runs', () => {
    const lines = jobLines('publish');
    const setupNode = indexOfLine(lines, (l) => l.startsWith('- uses: actions/setup-node@'), 'the setup-node step');
    const required = indexOfLine(lines, (l) => l === 'required=11.15.0', 'the minimum npm version');
    const install = indexOfLine(lines, (l) => l === '- run: npm ci', 'the npm ci step');
    const stage = indexOfLine(lines, (l) => l.startsWith('npm stage publish'), 'a stage command');

    expect(required).toBeGreaterThan(setupNode);
    expect(required).toBeLessThan(install);
    expect(required).toBeLessThan(stage);
    // No other step may sit between setup-node and the guard.
    expect(lines.slice(setupNode + 1, required).filter((l) => l.startsWith('- '))).toHaveLength(1);

    expect(lines.slice(required, install)).toEqual([
      'required=11.15.0',
      'current="$(npm --version)"',
      'if [ "$(printf \'%s\\n\' "$required" "$current" | sort -V | head -n1)" != "$required" ]; then',
      'echo "::error::npm $current does not support staged publishing (needs >= $required)"',
      'exit 1',
      'fi',
    ]);
  });

  it('never installs or upgrades npm in the publish job', () => {
    const installs = jobLines('publish').filter((l) => /\bnpm\s+(install|i)\b.*\bnpm\b/.test(l));
    expect(installs).toEqual([]);
  });

  it('keeps OIDC trusted publishing: id-token and the npm-publish environment, no stored token', () => {
    const lines = jobLines('publish');
    expect(lines).toContain('id-token: write');
    expect(lines).toContain('environment: npm-publish');
    expect(RAW).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it('grants exactly the expected permissions, and declares no other permissions block', () => {
    expect(permissionBlocks()).toEqual([
      { job: null, block: ['permissions: {}'] },
      { job: 'publish', block: ['    permissions:', '      contents: read', '      id-token: write'] },
      { job: 'github-release', block: ['    permissions:', '      contents: write'] },
    ]);
    expect(LINES.map(stripComment).filter((l) => /write-all|read-all/.test(l))).toEqual([]);
  });

  it('lets nothing in the publish job be skipped or fail silently: no if:, no continue-on-error', () => {
    const lines = rawJobLines('publish').map(stripComment);
    expect(lines.filter((l) => l.includes('continue-on-error'))).toEqual([]);
    // YAML keys only (block, `- if:` and flow style): a shell `if` has no colon after it.
    expect(lines.filter((l) => /(?:^\s*(?:-\s+)?|[{,]\s*)["']?if["']?\s*:/.test(l))).toEqual([]);
  });

  it('keeps the pre-publish gates: tag on main, tag matches version, build, test, smoke:pack', () => {
    const lines = jobLines('publish');
    expect(lines).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(lines).toContain('run: test "v$(node -p "require(\'./package.json\').version")" = "$GITHUB_REF_NAME"');
    const stage = indexOfLine(lines, (l) => l.startsWith('npm stage publish'), 'a stage command');
    for (const gate of ['- run: npm run build', '- run: npm test', '- run: npm run smoke:pack']) {
      expect(indexOfLine(lines, (l) => l === gate, gate)).toBeLessThan(stage);
    }
  });
});

describe('release workflow — the GitHub Release never precedes the registry (SEC-002)', () => {
  it('creates the release as a draft, marks prereleases, and never passes --latest to the create command', () => {
    const lines = jobLines('github-release');

    // Every place the create flags are built or extended.
    const flagAssignments = lines.filter((l) => /\bflags\+?=/.test(l));
    expect(flagAssignments).toEqual(['flags=(--verify-tag --draft)', 'flags+=(--prerelease)']);

    // Every create command, with its backslash continuations joined.
    const script = lines.join('\n').replace(/\\\n/g, ' ').split('\n');
    const creates = script.filter((l) => l.includes('gh release create'));
    expect(creates.length).toBeGreaterThan(0);
    for (const command of creates) {
      expect(command).toContain('"${flags[@]}"');
      expect(command).not.toContain('--latest');
    }
  });

  /*
   * Limits of a text check: it does not catch a command whose name is built
   * to hide it (`g""h`, `$tool`, a word split mid-letter), a redefined
   * `echo`, or a release published without `gh` (another action, `curl`,
   * a script file). Those are left to code review.
   */
  it('runs no gh command anywhere except the two draft `gh release create` calls', () => {
    const lines = logicalLines();
    const { open, close } = summaryGroup(lines);
    // Not executed: the one assignment that only stores text, and inert echoes into the summary.
    const executed = lines.filter(
      (l, i) => /\bgh\b/.test(l) && l !== PUBLISH_DRAFT_ASSIGNMENT && !(i > open && i < close && INERT_ECHO.test(l))
    );
    expect(executed).toEqual([
      'gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --notes-file notes.md "${flags[@]}"',
      'gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --generate-notes "${flags[@]}"',
    ]);
  });

  it('only ever stores and prints the publish command: --draft=false and publish_draft never run', () => {
    const lines = logicalLines();
    const { open, close } = summaryGroup(lines);
    expect(lines.filter((l) => /draft=false/i.test(l))).toEqual([PUBLISH_DRAFT_ASSIGNMENT]);
    expect(lines.filter((l, i) => l.includes('publish_draft') && !(i > open && i < close && INERT_ECHO.test(l)))).toEqual([
      PUBLISH_DRAFT_ASSIGNMENT,
      PUBLISH_DRAFT_LATEST,
    ]);
  });

  it('builds the summary out of inert echo lines only, so quoting a command never runs it', () => {
    const { body } = summaryGroup(logicalLines());
    expect(body.length).toBeGreaterThan(0);
    expect(body.filter((l) => l !== 'echo' && !INERT_ECHO.test(l))).toEqual([]);
  });

  it('asks to try the staged tarball itself before approving it', () => {
    const summary = summaryGroup(logicalLines()).body.join('\n');
    const inOrder = [
      'npm stage download <stage-id>',
      'empty temporary folder',
      'npm install <path-to-the-downloaded-tgz>',
      'npx --no-install stackfold --version',
      'npx --no-install stackfold list',
      'npm stage approve <stage-id>',
      '$publish_draft',
    ];
    const positions = inOrder.map((text) => summary.indexOf(text));
    expect(inOrder.filter((_, i) => positions[i] === -1)).toEqual([]);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('writes the pending manual steps to the job summary', () => {
    const lines = jobLines('github-release');
    expect(lines.some((l) => l.includes('>> "$GITHUB_STEP_SUMMARY"'))).toBe(true);
    const script = lines.join('\n');
    expect(script).toContain('npm stage approve');
    expect(script).toContain('--draft=false');
  });

  it('still runs only after the publish job', () => {
    expect(jobLines('github-release')).toContain('needs: publish');
    expect(jobLines('publish')).toContain('name: stage on npm');
  });
});
