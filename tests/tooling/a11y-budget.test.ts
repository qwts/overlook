import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { budgetFor, evaluateSurface, findOrphanedEntries, totalViolations } from '../a11y/budget.js';
import type { BudgetEntry } from '../a11y/budget.js';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const entries: readonly BudgetEntry[] = [
  { id: 'budgeted-surface', story: 'x.stories.tsx', rules: { 'color-contrast': 3, 'button-name': 1 }, issues: [409, 410] },
];

describe('a11y violation budget verdicts (#398)', () => {
  // Acceptance scenario 2: "Seeding a deliberate violation in a story turns the axe gate
  // red." An unbudgeted surface is the case a newly-broken story actually hits — the
  // budget lists only known debt, so anything new is compared against an implicit zero.
  test('an unlisted surface is budgeted at zero, so a new violation fails', () => {
    const verdict = evaluateSurface({ id: 'brand-new-story', observed: { 'button-name': 1 }, entries });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /1× button-name \(budgeted 0\)/u);
    assert.match(verdict.reason ?? '', /does not rise/u);
  });

  test('a clean unlisted surface passes', () => {
    assert.deepEqual(evaluateSurface({ id: 'brand-new-story', observed: {}, entries }), { ok: true });
  });

  test('a budgeted surface at exactly its budget passes', () => {
    const observed = { 'color-contrast': 3, 'button-name': 1 };
    assert.deepEqual(evaluateSurface({ id: 'budgeted-surface', observed, entries }), { ok: true });
  });

  test('a budgeted surface over its budget fails and names the owning issues', () => {
    const verdict = evaluateSurface({ id: 'budgeted-surface', observed: { 'color-contrast': 4, 'button-name': 1 }, entries });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /4× color-contrast \(budgeted 3\)/u);
    assert.match(verdict.reason ?? '', /#409, #410/u);
  });

  // The hole a bare total left open (PR #408 review): swap one rule for another at the
  // same count and the surface still sums to 4, so a brand-new critical regression rides
  // in behind existing contrast debt.
  test('a NEW rule at the same total still fails — totals are not identities', () => {
    const verdict = evaluateSurface({ id: 'budgeted-surface', observed: { 'color-contrast': 3, 'aria-required-attr': 1 }, entries });
    assert.equal(verdict.ok, false);
    assert.equal(totalViolations({ 'color-contrast': 3, 'aria-required-attr': 1 }), totalViolations(entries[0]!.rules));
    assert.match(verdict.reason ?? '', /1× aria-required-attr \(budgeted 0\)/u);
  });

  // The ratchet's other direction: an unrecorded improvement leaves a stale number that
  // silently permits regression back up to it.
  test('a budgeted surface under its budget fails, demanding the win be banked', () => {
    const verdict = evaluateSurface({ id: 'budgeted-surface', observed: { 'color-contrast': 1, 'button-name': 1 }, entries });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /now below budget/u);
    assert.match(verdict.reason ?? '', /"color-contrast":1/u);
  });

  test('a fixed surface is told to delete its entry, not zero it', () => {
    const verdict = evaluateSurface({ id: 'budgeted-surface', observed: {}, entries });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /delete the entry/u);
  });

  // A change can fix one rule and break another at once; merging on the strength of the
  // improvement is exactly the mistake.
  test('a regression outranks a simultaneous improvement in the message', () => {
    const verdict = evaluateSurface({ id: 'budgeted-surface', observed: { 'color-contrast': 1, 'button-name': 5 }, entries });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /above budget/u);
    assert.match(verdict.reason ?? '', /5× button-name \(budgeted 1\)/u);
  });

  test('budgetFor finds a listed entry and returns undefined otherwise', () => {
    assert.equal(budgetFor(entries, 'budgeted-surface')?.rules['color-contrast'], 3);
    assert.equal(budgetFor(entries, 'nope'), undefined);
  });
});

describe('a11y budget orphan closure (#398)', () => {
  // Renaming a story export leaves the FILE in place, so path existence still passes while
  // the runtime lane silently stops evaluating that id (PR #408 review).
  test('an entry no lane visited is reported as orphaned', () => {
    assert.deepEqual(findOrphanedEntries({ entries, visited: new Set(['something-else']) }), ['budgeted-surface']);
  });

  test('a visited entry is not orphaned', () => {
    assert.deepEqual(findOrphanedEntries({ entries, visited: new Set(['budgeted-surface']) }), []);
  });
});

describe('a11y budget file and gate wiring (#398)', () => {
  test('every budget entry names an owning issue, real rules, and a real file', () => {
    const budget: unknown = JSON.parse(source('tests/a11y/violation-budget.json'));
    const { stories, flows } = budget as { stories: BudgetEntry[]; flows: BudgetEntry[] };

    assert.ok(Array.isArray(stories), 'the story budget is an array, including when every violation has been fixed');
    assert.ok(Array.isArray(flows), 'the flow budget is an array, including when every violation has been fixed');
    for (const entry of [...stories, ...flows]) {
      assert.ok(totalViolations(entry.rules) > 0, `${entry.id}: zeroed entries are deleted, not kept`);
      for (const [rule, count] of Object.entries(entry.rules)) {
        assert.ok(count > 0, `${entry.id}: rule ${rule} is dropped at zero, not kept`);
      }
      assert.ok(entry.issues.length > 0, `${entry.id}: budgeted debt names an owner`);
      // The path the runtime lanes key off must exist, or the entry is permitting
      // violations on a surface that no longer renders.
      const path = entry.story ?? entry.spec;
      assert.ok(path !== undefined && path.length > 0, `${entry.id}: names its file`);
      assert.doesNotThrow(() => readFileSync(join(process.cwd(), path ?? '')), `${entry.id}: ${path ?? ''} exists`);
    }
  });

  test('the budget audits the full WCAG 2.2 AA tag set (#398)', () => {
    const budget = JSON.parse(source('tests/a11y/violation-budget.json')) as { tags: string[] };
    for (const tag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']) {
      assert.ok(budget.tags.includes(tag), `tag ${tag} is audited`);
    }
  });

  test('the check script refuses unowned, zeroed, orphaned, and untyped entries (#398)', () => {
    const script = source('scripts/check-a11y-budget.mjs');
    assert.match(script, /"issues" must list at least one issue number/u);
    assert.match(script, /"rules" must be an object mapping axe rule ids to counts/u);
    assert.match(script, /must have a positive integer count/u);
    assert.match(script, /which does not exist/u);
    assert.match(script, /duplicate entry/u);
    assert.match(script, /REQUIRED_TAGS/u);
    // An empty visited file means the lane never ran — failing every entry as orphaned
    // would be catastrophic advice.
    assert.match(script, /recorded nothing/u);
  });

  test('both axe lanes are wired into the gates, incl. the orphan check (#398)', () => {
    const packageJson = source('package.json');
    assert.match(packageJson, /"check:a11y-budget": "node scripts\/check-a11y-budget\.mjs"/u);
    // The static validator rides `npm run ci`; the runtime lanes ride the story and E2E jobs.
    assert.match(packageJson, /"ci": ".*check:a11y-budget.*"/u);
    // The orphan check can only run where the lane actually visited stories.
    assert.match(packageJson, /"test:stories:ci:inner": ".*OVERLOOK_A11Y_VISITED.*--visited.*--lane stories"/u);
    assert.match(source('.storybook/test-runner.ts'), /getViolations/u);
    assert.match(source('tests/e2e/a11y.spec.ts'), /getViolations/u);
    assert.match(source('tests/e2e/a11y.spec.ts'), /every budgeted flow was actually audited/u);
    assert.match(source('.github/workflows/ci.yml'), /check:a11y-budget/u);
  });
});
