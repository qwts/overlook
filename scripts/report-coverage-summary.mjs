#!/usr/bin/env node

// Renders a Markdown coverage summary for the PR run: c8 line/branch totals against the ratcheting
// floor from .c8rc.json, plus the acceptance coverage-map distribution (#82) and any flow that
// lacks automated coverage. Appends to $GITHUB_STEP_SUMMARY when set (so it shows on the run's
// Checks tab), otherwise prints to stdout. This is a REPORTER, never a gate — it always exits 0;
// the coverage gate is c8's own check-coverage and the map gate is check-e2e-coverage-map.mjs. It
// runs even when those gates fail, since a red run is exactly when you want to read the numbers.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDirectory = process.cwd();

async function readJson(relativePath) {
  // Never throw: a missing OR malformed input degrades to null so this reporter can't become a gate.
  try {
    return JSON.parse(await readFile(path.join(rootDirectory, relativePath), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Coverage summary: could not read ${relativePath} (${error?.message ?? error}); skipping it.`);
    }
    return null;
  }
}

function statusIcon(passed) {
  return passed ? '✅' : '❌';
}

// A percentage two decimals above its floor hides how little room that is: at ~110k lines, 90.01%
// against a 90 floor is five lines. Reporting the margin in the metric's own units is what makes a
// thin ratchet legible BEFORE a PR trips it. Still a reporter — this number gates nothing.
export function marginFor(metric, floor) {
  if (!metric || typeof floor !== 'number' || typeof metric.covered !== 'number' || typeof metric.total !== 'number') return null;
  // c8 compares covered/total against the floor, so the smallest passing count is the ceiling of
  // the floor's share — one below it is already red.
  return metric.covered - Math.ceil((floor / 100) * metric.total);
}

export function marginCell(label, metric, floor) {
  const margin = marginFor(metric, floor);
  if (margin === null) return '—';
  const unit = label.toLowerCase();
  if (margin < 0) return `${margin} ${unit}`;
  return `+${margin} ${unit}`;
}

export function coverageRow(label, metric, floor) {
  if (!metric || typeof metric.pct !== 'number') {
    return `| ${label} | _n/a_ | ${floor ?? '—'} | — | — |`;
  }
  const pct = metric.pct.toFixed(2);
  const covered = `${metric.covered}/${metric.total}`;
  if (typeof floor !== 'number') {
    return `| ${label} | ${pct}% (${covered}) | — | — | — |`;
  }
  return `| ${label} | ${pct}% (${covered}) | ${floor}% | ${marginCell(label, metric, floor)} | ${statusIcon(metric.pct >= floor)} |`;
}

function renderCoverageSection(summary, thresholds) {
  if (!summary?.total) {
    return ['### Code coverage', '', '_No `coverage/coverage-summary.json` found — the coverage step may not have run._'];
  }
  const { total } = summary;
  return [
    '### Code coverage',
    '',
    '| Metric | Covered | Floor | Margin | |',
    '| --- | --- | --- | --- | --- |',
    coverageRow('Lines', total.lines, thresholds.lines),
    coverageRow('Branches', total.branches, thresholds.branches),
    coverageRow('Functions', total.functions, thresholds.functions),
    coverageRow('Statements', total.statements, thresholds.statements),
    '',
    '_Floors ratchet upward only (`.c8rc.json`); a ❌ fails the CI coverage gate. Margin is how many covered units this run could lose before that happens._',
  ];
}

const AUTOMATED_COVERAGE_TYPES = new Set(['playwright-e2e', 'storybook', 'unit-dom']);

function renderCoverageMapSection(coverageMap) {
  const entries = Array.isArray(coverageMap?.entries) ? coverageMap.entries : [];
  if (entries.length === 0) {
    return ['### Acceptance coverage map', '', '_No `tests/e2e/coverage-map.json` entries found._'];
  }

  const distribution = new Map();
  const unautomated = [];
  for (const entry of entries) {
    // Guard against a malformed entry (coverage not an array) — degrade, don't throw.
    const coverages = Array.isArray(entry.coverage) ? entry.coverage : [];
    const types = new Set(coverages.map((coverage) => coverage.type));
    for (const type of types) distribution.set(type, (distribution.get(type) ?? 0) + 1);
    const hasAutomated = [...types].some((type) => AUTOMATED_COVERAGE_TYPES.has(type));
    if (!hasAutomated) unautomated.push({ id: entry.id, types: [...types].sort() });
  }

  const distributionLine = [...distribution.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(' · ');

  const lines = [
    '### Acceptance coverage map',
    '',
    `${entries.length} canonical flows — flow count per coverage source (a flow may use several, so these can sum to more than ${entries.length}): ${distributionLine}`,
    '',
  ];
  if (unautomated.length === 0) {
    lines.push('✅ Every flow has automated coverage.');
  } else {
    lines.push(`⚠️ ${unautomated.length} flow(s) with **no automated coverage** (manual/deferred only):`);
    for (const flow of unautomated) lines.push(`- \`${flow.id}\` — ${flow.types.join(', ')}`);
  }
  return lines;
}

async function main() {
  const [summary, coverageMap, c8Config] = await Promise.all([
    readJson('coverage/coverage-summary.json'),
    readJson('tests/e2e/coverage-map.json'),
    readJson('.c8rc.json'),
  ]);

  const thresholds = {
    lines: c8Config?.lines,
    branches: c8Config?.branches,
    functions: c8Config?.functions,
    statements: c8Config?.statements,
  };

  // On GitHub Actions, surface each failed floor as an ::error annotation so the run summary names
  // the failing metric instead of a blank "Error:" from the (separate, already-failed) c8 gate step.
  // Annotations render regardless of this step's exit code, so this stays a reporter: still exit 0.
  if (process.env.GITHUB_ACTIONS && summary?.total) {
    for (const [label, key] of [
      ['Lines', 'lines'],
      ['Branches', 'branches'],
      ['Functions', 'functions'],
      ['Statements', 'statements'],
    ]) {
      const metric = summary.total[key];
      const floor = thresholds[key];
      if (typeof metric?.pct === 'number' && typeof floor === 'number' && metric.pct < floor) {
        console.log(
          `::error title=Coverage::${label} coverage ${metric.pct.toFixed(2)}% is below the .c8rc.json floor of ${floor}% (covered ${metric.covered}/${metric.total}).`,
        );
      }
    }
  }

  const markdown = [
    '## Test coverage',
    '',
    ...renderCoverageSection(summary, thresholds),
    '',
    ...renderCoverageMapSection(coverageMap),
    '',
  ].join('\n');

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(summaryPath, `${markdown}\n`);
      console.log('Wrote coverage summary to the GitHub step summary.');
    } catch (error) {
      // Fall back to stdout rather than failing the step — this is a reporter, never a gate.
      console.warn(`Coverage summary: could not write the step summary (${error?.message ?? error}); printing instead.`);
      console.log(markdown);
    }
  } else {
    console.log(markdown);
  }
}

// Guarded so the row helpers above can be imported by their test without this reporter running,
// reading the workspace, and printing a summary into the test output.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
