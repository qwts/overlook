#!/usr/bin/env node

// Agent-context gate (#718, ENG-0006). Three checks over the files that steer
// agents:
//
//   1. AGENTS.md length is a DOWNWARD ratchet, like a coverage floor inverted.
//      Progressive disclosure only holds if growth costs something.
//   2. Every vendor adapter points at the canonical file, so no vendor's agent
//      is reading a file that has quietly become a second source of truth.
//   3. No substantial paragraph is shared between AGENTS.md and an adapter —
//      "a shared fact stated in two agent files is a bug" (ENG-0006 item 1).
//
// (3) overlaps docs-gov's `duplicateParagraphs` rule for the markdown files in
// its `include` list, but `.cursor/rules/*.mdc` sits outside that list entirely,
// which is exactly where a duplicated process-guard rule would hide.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CANONICAL = 'AGENTS.md';

// Ratchet. Lower it whenever a pass removes content; raising it requires a
// stated reason in the PR that does so, the same bar as a docs-gov token budget.
export const AGENTS_MAX_LINES = 230;

const ADAPTERS = ['CLAUDE.md', '.github/copilot-instructions.md'];
const ADAPTER_DIRS = ['.cursor/rules'];

// Long enough that shared vocabulary and short imperative bullets do not trip
// it; short enough to catch a restated rule or paragraph.
const DUPLICATE_MIN_LENGTH = 160;

function countLines(text) {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.length === 0 ? 0 : body.split('\n').length;
}

function adapterFiles(readDir) {
  const extra = ADAPTER_DIRS.flatMap((dir) =>
    readDir(dir)
      .filter((entry) => entry.endsWith('.md') || entry.endsWith('.mdc'))
      .map((entry) => `${dir}/${entry}`),
  );
  return [...ADAPTERS, ...extra];
}

// Markdown/frontmatter noise removed so a reflowed copy still matches.
function normalizeParagraph(paragraph) {
  return paragraph
    .replaceAll(/[`*_>#]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function paragraphs(text) {
  return text
    .split(/\n\s*\n/u)
    .map(normalizeParagraph)
    .filter((paragraph) => paragraph.length >= DUPLICATE_MIN_LENGTH);
}

export function evaluateAgentContext({ readText, readDir, maxLines = AGENTS_MAX_LINES }) {
  const failures = [];

  const canonical = readText(CANONICAL);
  const lines = countLines(canonical);
  if (lines > maxLines) {
    failures.push(
      `${CANONICAL} is ${lines} lines, over its ${maxLines}-line budget. The budget is a downward ratchet: ` +
        `move depth into docs/ and link it, or raise AGENTS_MAX_LINES in this script with a reason in the PR.`,
    );
  }

  const canonicalParagraphs = new Set(paragraphs(canonical));

  for (const file of adapterFiles(readDir)) {
    const text = readText(file);
    if (text === null) {
      failures.push(`${file} is listed as a vendor adapter but does not exist.`);
      continue;
    }
    if (!text.includes(CANONICAL)) {
      failures.push(`${file} must point at ${CANONICAL} — a vendor adapter that stands alone becomes a second source of truth.`);
    }
    for (const paragraph of paragraphs(text)) {
      if (canonicalParagraphs.has(paragraph)) {
        failures.push(`${file} repeats a paragraph from ${CANONICAL}: "${paragraph.slice(0, 80)}…". Link to it instead.`);
      }
    }
  }

  return failures;
}

function main() {
  const root = process.cwd();
  const readText = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const readDir = (dir) => {
    try {
      return readdirSync(path.join(root, dir));
    } catch {
      return [];
    }
  };

  const failures = evaluateAgentContext({ readText, readDir });
  if (failures.length > 0) {
    console.error(`Agent-context gate failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Agent-context gate OK: ${CANONICAL} within ${AGENTS_MAX_LINES} lines, adapters thin and pointing home.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
