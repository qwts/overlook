#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveRemoval(root, candidate) {
  if (candidate === '' || isAbsolute(candidate)) throw new Error(`cleanup path must be relative: ${candidate}`);
  const target = resolve(root, candidate);
  const relation = relative(root, target);
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`cleanup path escapes the repository: ${candidate}`);
  }
  return target;
}

export async function removePaths(root, candidates) {
  await Promise.all(candidates.map((candidate) => rm(resolveRemoval(root, candidate), { recursive: true, force: true })));
}

async function main() {
  const candidates = process.argv.slice(2);
  if (candidates.length === 0) throw new Error('usage: remove-paths.mjs <relative-path> [relative-path...]');
  await removePaths(process.cwd(), candidates);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
