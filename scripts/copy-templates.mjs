#!/usr/bin/env node
// scripts/copy-templates.mjs
//
// tsc compiles .ts -> dist/ but never copies non-TS assets. Several
// scaffold.ts modules (web-app-stackfold, electron-stackfold, plugin-builder)
// read their .hbs templates from disk via loadTemplate(import.meta.dirname, ...)
// at module load time (eager, since SK-ADR-003 / Task 043), so without this
// step the compiled binary (dist/cli/index.js, what `npm link`/`npm install -g`
// expose as `stackfold`) throws "template file not found" on every command,
// including --version. Runs as a postbuild step (see package.json).
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const SRC = 'src';
const DIST = 'dist';

let copied = 0;
for (const entry of readdirSync(SRC, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.hbs')) continue;
  const srcPath = join(entry.parentPath, entry.name);
  const destPath = join(DIST, relative(SRC, srcPath));
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  copied += 1;
}

console.log(`copy-templates: copied ${copied} .hbs file(s) from ${SRC}/ to ${DIST}/`);
