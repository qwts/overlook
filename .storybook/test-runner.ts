import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { getStoryContext } from '@storybook/test-runner';
import type { TestRunnerConfig } from '@storybook/test-runner';
import { injectAxe, getViolations } from 'axe-playwright';
import type { Result } from 'axe-core';

import { evaluateSurface } from '../tests/a11y/budget';
import type { RuleCounts, ViolationBudget } from '../tests/a11y/budget';

// The a11y gate for the story lane (#398). Every story in test:stories:ci is audited by
// axe against the WCAG 2.2 AA tag set and checked against tests/a11y/violation-budget.json.
// This rides the EXISTING gate rather than adding a lane: the test-runner already boots
// chromium and visits every story, so the marginal cost is one axe pass per theme.
//
// Stories render components in isolation, which is the lane's strength (a violation names
// one component) and its blind spot: landmark uniqueness, focus order across regions, and
// live-region collisions only exist in a composed app. tests/e2e/a11y.spec.ts covers those.
const budgetPath = join(process.cwd(), 'tests/a11y/violation-budget.json');
const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as ViolationBudget;

// The audit lane (#398): OVERLOOK_A11Y_REPORT=<path> collects observed counts and full
// violation detail instead of asserting, which is how the budget's opening numbers and the
// wiki audit report were produced. Never set in CI — the gate must assert.
//
// JSONL, appended per story: the test-runner is jest, so every story FILE gets its own
// worker process. An in-memory array would be per-worker and the last writer would win —
// which is exactly what an early version of this did, reporting a confident zero.
const reportPath = process.env['OVERLOOK_A11Y_REPORT'];
if (reportPath !== undefined) mkdirSync(dirname(reportPath), { recursive: true });

// Every story this lane actually audits, appended for the orphan check that runs after the
// suite (scripts/check-a11y-budget.mjs --visited). Same per-worker constraint as the report,
// hence a file rather than a module-level Set. See OVERLOOK_A11Y_VISITED in test:stories:ci.
const visitedPath = process.env['OVERLOOK_A11Y_VISITED'];
if (visitedPath !== undefined) mkdirSync(dirname(visitedPath), { recursive: true });

export function countByRule(violations: readonly Result[]): RuleCounts {
  const counts: Record<string, number> = {};
  for (const violation of violations) counts[violation.id] = (counts[violation.id] ?? 0) + 1;
  return counts;
}

const config: TestRunnerConfig = {
  async preVisit(page) {
    await injectAxe(page);
  },

  async postVisit(page, context) {
    const storyContext = await getStoryContext(page, context);

    // A story may opt out with `parameters: { a11y: { disable: true } }` — reserved for
    // stories that deliberately render a broken state. None do today; the escape hatch
    // exists so a future one does not force the budget to absorb intentional damage.
    const a11yParameter: unknown = storyContext.parameters['a11y'];
    const disabled =
      typeof a11yParameter === 'object' && a11yParameter !== null && (a11yParameter as { disable?: unknown }).disable === true;
    if (disabled) return;

    // Scope to the story root, not <body>: Storybook's own chrome is not our surface, and
    // auditing it would put someone else's violations in our budget.
    //
    // The third argument is axe's RunOptions DIRECTLY — not the {axeOptions} wrapper that
    // checkA11y takes. The wrapper shape is silently ignored here, which audits against
    // axe's full default rule set instead of the WCAG 2.2 AA tags the budget declares.
    if (visitedPath !== undefined) appendFileSync(visitedPath, `${context.id}\n`);

    for (const variant of [
      { theme: 'dark', contrast: 'normal' },
      { theme: 'dark', contrast: 'more' },
      { theme: 'light', contrast: 'normal' },
      { theme: 'light', contrast: 'more' },
    ] as const) {
      await page.evaluate(({ theme, contrast }) => {
        document.documentElement.dataset['theme'] = theme;
        if (contrast === 'more') document.documentElement.dataset['contrast'] = 'more';
        else delete document.documentElement.dataset['contrast'];
        document.documentElement.style.colorScheme = theme;
      }, variant);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

      const violations = await getViolations(page, '#storybook-root', { runOnly: { type: 'tag', values: [...budget.tags] } });

      if (reportPath !== undefined) {
        const record = {
          id: context.id,
          title: storyContext.title,
          name: storyContext.name,
          theme: variant.theme,
          contrast: variant.contrast,
          rules: countByRule(violations),
          violations,
        };
        appendFileSync(reportPath, `${JSON.stringify(record)}\n`);
        continue;
      }

      const verdict = evaluateSurface({ id: context.id, observed: countByRule(violations), entries: budget.stories });
      if (!verdict.ok) {
        const detail = violations
          .flatMap((violation) => [
            `  - [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}`,
            ...violation.nodes.map((node) => `      ${node.target.join(' ')}: ${node.failureSummary ?? 'no failure summary'}`),
          ])
          .join('\n');
        throw new Error(`[${variant.theme}/${variant.contrast}] ${verdict.reason}\n${detail}`);
      }
    }
  },
};

export default config;
