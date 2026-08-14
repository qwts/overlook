import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Metric {
  readonly pct?: number;
  readonly covered?: number;
  readonly total?: number;
}

interface ReporterModule {
  readonly marginFor: (metric: Metric | null, floor: number | undefined) => number | null;
  readonly marginCell: (label: string, metric: Metric | null, floor: number | undefined) => string;
  readonly coverageRow: (label: string, metric: Metric | null, floor: number | undefined) => string;
}

const { marginFor, marginCell, coverageRow } = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/report-coverage-summary.mjs')).href
)) as ReporterModule;

// The floor is a ratchet raised to just under actual, so "90.01% against 90" reads comfortable and
// is five lines. The margin column states that in the metric's own units. It gates nothing — c8's
// own check-coverage remains the gate.
describe('coverage summary margin (#995 follow-up)', () => {
  it('reports how many covered units the run can lose before the floor breaks', () => {
    assert.equal(marginFor({ pct: 90.01, covered: 99011, total: 110000 }, 90), 11);
    assert.equal(marginFor({ pct: 90, covered: 90, total: 100 }, 90), 0);
  });

  it('goes negative once the run is already below the floor', () => {
    assert.equal(marginFor({ pct: 89.5, covered: 895, total: 1000 }, 90), -5);
    assert.equal(marginCell('Lines', { pct: 89.5, covered: 895, total: 1000 }, 90), '-5 lines');
  });

  it('has no margin to state without both a metric and a floor', () => {
    assert.equal(marginFor(null, 90), null);
    assert.equal(marginFor({ pct: 90, covered: 90, total: 100 }, undefined), null);
    assert.equal(marginCell('Functions', null, 90), '—');
  });

  it('keeps every row at the table width, floor or no floor', () => {
    const cells = (row: string): number => row.split('|').length;
    const withFloor = coverageRow('Lines', { pct: 90.01, covered: 99011, total: 110000 }, 90);

    assert.match(withFloor, /\| \+11 lines \|/u);
    assert.equal(cells(withFloor), cells(coverageRow('Branches', { pct: 81, covered: 81, total: 100 }, undefined)));
    assert.equal(cells(withFloor), cells(coverageRow('Statements', null, 90)));
  });
});
