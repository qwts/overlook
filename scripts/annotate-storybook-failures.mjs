#!/usr/bin/env node

// Turns a failed `test-storybook` run into one GitHub ::error annotation per failing story.
// The jest reporter's summary is long and coloured; a single annotation truncates after a
// few stories and the raw log is the only other place the detail lands (not reachable from
// every network). One annotation per story keeps every verdict readable from the run summary
// and the checks API. Usage: node scripts/annotate-storybook-failures.mjs <log-file>
//
// The heading line is `● <Title> › <Story> › play-test`; the lines that follow, up to the
// jest code frame, carry the assertion or the axe verdict. Blocks are deduplicated because
// jest prints each failure twice (inline, then in the summary).

import { readFileSync } from 'node:fs';
import process from 'node:process';

// Built from the code point so the control character never sits in a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
const MAX_MESSAGE = 1200;
const MAX_ANNOTATIONS = 40;

/** Strips ANSI colour codes and the concurrently `[test] ` prefix. */
export function cleanLine(line) {
  return line
    .replace(ANSI, '')
    .replace(/^\[[a-z]+\]\s?/u, '')
    .trimEnd();
}

/** Parses failure blocks out of a test-storybook log. */
export function parseFailures(log) {
  const failures = new Map();
  let current = null;
  for (const raw of log.split('\n')) {
    const line = cleanLine(raw);
    const heading = /^\s*●\s+(.+?)\s+›\s+play-test\s*$/u.exec(line);
    if (heading !== null) {
      current = { title: heading[1], lines: [] };
      if (!failures.has(current.title)) failures.set(current.title, current);
      else current = null;
      continue;
    }
    if (current === null) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // The code frame and the stack end the useful part of a block.
    if (/^(>\s*)?\d+\s*\|/u.test(trimmed) || /^at\s/u.test(trimmed) || trimmed.startsWith('|')) {
      current = null;
      continue;
    }
    current.lines.push(trimmed);
  }
  return [...failures.values()];
}

function escapeAnnotation(text) {
  return text.replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A');
}

function main() {
  const [logPath] = process.argv.slice(2);
  if (logPath === undefined) {
    console.error('usage: annotate-storybook-failures.mjs <log-file>');
    process.exit(2);
  }
  const failures = parseFailures(readFileSync(logPath, 'utf8'));
  if (failures.length === 0) {
    console.log('::error title=Storybook failure::test-storybook failed without a parseable story failure; see the step log.');
    return;
  }
  for (const failure of failures.slice(0, MAX_ANNOTATIONS)) {
    const message = failure.lines.join('\n').slice(0, MAX_MESSAGE) || 'play-test failed (no message captured)';
    console.log(
      `::error file=.storybook/test-runner.ts,line=1,title=Storybook: ${escapeAnnotation(failure.title)}::${escapeAnnotation(message)}`,
    );
  }
  if (failures.length > MAX_ANNOTATIONS) {
    console.log(
      `::error title=Storybook failure::${failures.length - MAX_ANNOTATIONS} more failing stories not annotated; see the step log.`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
