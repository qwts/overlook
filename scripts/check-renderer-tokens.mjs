#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// An unresolvable var() fails silently — the property falls back to its
// initial value — so a guessed token name ships as a missing radius, size, or
// surface instead of an error (#1286). Every name a stylesheet reads must be
// declared somewhere a stylesheet or component can set it.
const CSS_DECLARATION = /(?<![\w-])(--[\w-]+)\s*:/gu;
const CSS_USE = /var\(\s*(--[\w-]+)/gu;
const SCRIPT_PROPERTY = /['"`](--[\w-]+)['"`]/gu;

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
}

export function findUndefinedCustomProperties(files) {
  const declared = new Set();
  const stylesheets = [];
  for (const { file, source } of files) {
    if (file.endsWith('.css')) {
      const searchable = withoutComments(source);
      for (const match of searchable.matchAll(CSS_DECLARATION)) declared.add(match[1]);
      stylesheets.push({ file, searchable });
    } else if (/\.tsx?$/u.test(file)) {
      for (const match of source.matchAll(SCRIPT_PROPERTY)) declared.add(match[1]);
    }
  }
  const violations = [];
  for (const { file, searchable } of stylesheets) {
    for (const match of searchable.matchAll(CSS_USE)) {
      if (declared.has(match[1])) continue;
      const line = searchable.slice(0, match.index ?? 0).split('\n').length;
      violations.push({ file, line, property: match[1] });
    }
  }
  return violations;
}

async function sourceFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath, root)));
    else if (entry.isFile() && /\.(?:css|tsx?)$/u.test(entry.name)) {
      files.push({ file: path.relative(root, entryPath).replaceAll(path.sep, '/'), source: await readFile(entryPath, 'utf8') });
    }
  }
  return files;
}

async function main() {
  const rendererRoot = path.join(process.cwd(), 'src/renderer');
  const violations = findUndefinedCustomProperties(await sourceFiles(rendererRoot));
  if (violations.length === 0) {
    console.log('Renderer custom-property gate OK.');
    return;
  }
  console.error('Renderer CSS reads custom properties that nothing declares (see src/renderer/src/styles/tokens/):');
  for (const violation of violations) console.error(`- src/renderer/${violation.file}:${violation.line}: ${violation.property}`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
