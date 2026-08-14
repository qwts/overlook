import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { injectAxe, getViolations } from 'axe-playwright';

import { evaluateSurface, findOrphanedEntries } from '../a11y/budget.js';
import type { RuleCounts, ViolationBudget } from '../a11y/budget.js';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// The composed-surface half of the a11y gate (#398). The story lane
// (.storybook/test-runner.ts) audits every story, but it mounts each component in
// ISOLATION — so it structurally cannot see the failures that only exist once the real app
// composes them: duplicate/missing landmarks, focus order across regions, an overlay that
// leaves the shell behind it in the a11y tree, live regions colliding.
//
// These flows are the composed surfaces that the audit ranked highest-risk. Both lanes
// share tests/a11y/budget.ts so "over budget" means the same thing in each.
const budget = JSON.parse(readFileSync(join(process.cwd(), 'tests/a11y/violation-budget.json'), 'utf8')) as ViolationBudget;

// The SC 2.4.11 probe below runs inside the renderer via page.evaluate, where the DOM
// exists — but the test FILE is Node code, typed by the root tsconfig at `lib: ["ES2022"]`
// with no DOM globals. The DOM test lane (#135) does not help here: it is scoped to
// `tests/dom/**` with its own happy-dom tsconfig and does not extend to `tests/e2e/**`,
// which stays Node-typed because Playwright drives a real out-of-process browser. Widening
// `lib` for every e2e test would let them reach DOM globals that don't exist in their own
// runtime, so the probe is instead typed against the minimal DOM surface it touches.
interface ProbeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
interface ProbeAnimation {
  readonly playState: string;
}
interface ProbeElement {
  readonly tagName: string;
  readonly className: unknown;
  readonly offsetParent: unknown;
  focus(): void;
  contains(other: ProbeElement | null): boolean;
  getAnimations(): readonly ProbeAnimation[];
  getBoundingClientRect(): ProbeRect;
}
declare const document: {
  querySelectorAll(selectors: string): Iterable<ProbeElement>;
  elementFromPoint(x: number, y: number): ProbeElement | null;
  readonly activeElement: ProbeElement | null;
};
declare function getComputedStyle(element: ProbeElement): { readonly position: string };

// Flows this run actually audited. playwright.config.ts sets fullyParallel: false, so the
// tests in this file run serially — but not necessarily in one PROCESS: a test failure
// followed by an explicitly retried diagnostic run can restart the worker, wiping module
// state recorded before the failure. The set is therefore mirrored to a file under
// test-results/ (cleared by Playwright at run start) and the closure test at the bottom
// reads the union, so a diagnostic retry cannot silently downgrade closure enforcement.
const visitedFlows = new Set<string>();
const visitedFlowsFile = join(process.cwd(), 'test-results', 'a11y-visited-flows.txt');

function recordVisitedFlow(id: string): void {
  visitedFlows.add(id);
  mkdirSync(dirname(visitedFlowsFile), { recursive: true });
  appendFileSync(visitedFlowsFile, `${id}\n`);
}

function allVisitedFlows(): ReadonlySet<string> {
  const union = new Set(visitedFlows);
  if (existsSync(visitedFlowsFile)) {
    for (const id of readFileSync(visitedFlowsFile, 'utf8').split('\n')) if (id) union.add(id);
  }
  return union;
}

async function launchSeeded(slug: string, seed: string): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkE2eTmpDir(`overlook-e2e-a11y-${slug}-`);
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: seed,
      OVERLOOK_INSECURE_KEYSTORE: '1',
    },
  });
  const page = await app.firstWindow();
  await page.getByTestId('virtual-grid').waitFor();
  // A REAL tile, not a placeholder cell — the #189 cold-start race. Auditing before the
  // first page lands would measure an empty grid and bank a meaningless zero.
  await page.locator('.ovl-tile__img').first().waitFor();
  await injectAxe(page);
  return { app, page };
}

function countByRule(violations: readonly { id: string }[]): RuleCounts {
  const counts: Record<string, number> = {};
  for (const violation of violations) counts[violation.id] = (counts[violation.id] ?? 0) + 1;
  return counts;
}

async function assertWithinBudget(page: Page, id: string): Promise<void> {
  recordVisitedFlow(id);
  // getViolations takes axe's RunOptions DIRECTLY as its third argument — not the
  // {axeOptions} wrapper that checkA11y takes. Passing the wrapper type-checks as a
  // loose object but is silently ignored at runtime, which audits against axe's full
  // default rule set (best-practice rules included) instead of the WCAG 2.2 AA tags.
  const violations = await getViolations(page, undefined, { runOnly: { type: 'tag', values: [...budget.tags] } });
  const verdict = evaluateSurface({ id, observed: countByRule(violations), entries: budget.flows });
  const detail = violations.map((violation) => `  - [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}`).join('\n');
  expect(verdict.ok, `${verdict.reason ?? ''}\n${detail}`).toBe(true);
}

test('a11y: the composed shell — sidebar, toolbar, grid, and status bar together', async () => {
  const { app, page } = await launchSeeded('shell', '12');
  try {
    await expect(page.getByRole('navigation', { name: 'Library' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Photo tools' })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('All Photos');
    await expect(page.getByRole('contentinfo')).toBeVisible();
    const firstPhoto = page.locator('.ovl-grid__cell').first();
    await expect(firstPhoto).toHaveAttribute('aria-posinset', '1');
    await expect(firstPhoto).toHaveAttribute('aria-setsize', '12');
    await expect(firstPhoto.locator('.ovl-tile__open')).toHaveAccessibleName(/Open IMG_\d+\.(?:JPG|RAF)/u);
    await assertWithinBudget(page, 'shell-grid');
  } finally {
    await app.close();
  }
});

test('a11y: the lightbox over the shell', async () => {
  const { app, page } = await launchSeeded('lightbox', '4');
  try {
    const firstPhotoLabel = (await page.locator('.ovl-grid__cell').first().locator('.ovl-tile__open').getAttribute('aria-label')) ?? '';
    const firstPhotoName = firstPhotoLabel.replace(/^Open /u, '').split(',')[0] ?? '';
    await page.locator('.ovl-grid__cell').first().click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect(page.getByTestId('screen-reader-announcer-polite')).toContainText(firstPhotoName);
    await assertWithinBudget(page, 'shell-lightbox');
  } finally {
    await app.close();
  }
});

test('a11y: the inspector rail open beside the grid', async () => {
  const { app, page } = await launchSeeded('inspector', '12');
  try {
    await page.locator('.ovl-grid__cell').first().click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('i');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await assertWithinBudget(page, 'shell-inspector');
  } finally {
    await app.close();
  }
});

test('a11y: a modal dialog stacked over the shell', async () => {
  const { app, page } = await launchSeeded('dialog', '12');
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const disconnect = page.getByRole('button', { name: 'Disconnect' });
    await expect(disconnect).toBeVisible();
    // The Settings toolbar click can leave the pointer where the asynchronously
    // rendered provider action appears. Audit its settled resting state, not a
    // 120 ms primary→secondary background transition under an accidental hover.
    await page.locator('.ovl-dialog__title').hover();
    await expect
      .poll(() =>
        disconnect.evaluate(
          (button) => (button as unknown as ProbeElement).getAnimations().filter((animation) => animation.playState === 'running').length,
        ),
      )
      .toBe(0);
    await assertWithinBudget(page, 'shell-settings-dialog');
  } finally {
    await app.close();
  }
});

test('a11y: a selection active in the grid', async () => {
  const { app, page } = await launchSeeded('selection', '12');
  try {
    await page.locator('.ovl-tile__select').first().click();
    await expect(page.getByTestId('selection-pill')).toBeVisible();
    await expect(page.getByTestId('screen-reader-announcer-polite')).toHaveText('1 photo selected');
    await assertWithinBudget(page, 'shell-selection');
  } finally {
    await app.close();
  }
});

// SC 2.4.11 Focus Not Obscured (Minimum) — new at AA in WCAG 2.2, and axe has NO rule
// for it, so without this the app's "WCAG 2.2 AA" claim rests on nothing for this
// criterion. It is a composed-surface question by nature: it needs a floating overlay and
// a focusable target underneath, which no isolated story has.
//
// The criterion is "entirely hidden WHEN the component receives keyboard focus" — both
// halves matter. Measuring the resting state instead reports every reveal-on-hover
// control as a failure (.ovl-sidebar__album-actions is opacity:0 until :focus-within),
// which is exactly backwards. So: focus each element, then measure that state.
test('a11y: no focused control is entirely hidden behind the app chrome (SC 2.4.11)', async () => {
  const { app, page } = await launchSeeded('obscured', '96');
  try {
    // Selection active, so the floating pill is up: the realistic worst case is a
    // floating bar over the grid it floats above.
    await page.locator('.ovl-tile__select').first().click();
    await expect(page.getByTestId('selection-pill')).toBeVisible();

    const obscured = await page.evaluate((): string[] => {
      const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const firstClass = (el: ProbeElement): string =>
        typeof el.className === 'string' && el.className !== '' ? (el.className.split(' ')[0] ?? '') : el.tagName;
      const hits: string[] = [];
      for (const node of document.querySelectorAll(FOCUSABLE)) {
        if (node.offsetParent === null && getComputedStyle(node).position !== 'fixed') continue;
        node.focus();
        if (document.activeElement !== node) continue; // not really focusable; not this SC's problem
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Sample a 3x3 grid inset from the edges. "Entirely hidden" is the bar the SC
        // sets, so ANY sample landing on the element itself (or its own subtree) clears
        // it — a partially covered control is not a 2.4.11 failure.
        let visibleSomewhere = false;
        const blockers = new Set<string>();
        for (const fx of [0.15, 0.5, 0.85]) {
          for (const fy of [0.15, 0.5, 0.85]) {
            const top = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
            // Off-viewport is a scrolling question, not this criterion.
            if (top === null || top === node || node.contains(top) || top.contains(node)) {
              visibleSomewhere = true;
              break;
            }
            blockers.add(firstClass(top));
          }
          if (visibleSomewhere) break;
        }
        if (!visibleSomewhere) {
          hits.push(
            `${node.tagName.toLowerCase()}.${firstClass(node)} (${Math.round(rect.width)}x${Math.round(rect.height)}) behind: ${[...blockers].join(', ')}`,
          );
        }
      }
      return hits;
    });

    expect(obscured, `Focused controls entirely hidden behind other content (SC 2.4.11):\n${obscured.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
  }
});

// Declared last on purpose: it asserts over what the tests above recorded. Renaming or
// deleting a flow without touching its budget row would otherwise leave debt behind that
// nothing evaluates — the row's `spec` file still exists, so the static check cannot see
// it either (PR #408 review). Skipped under --grep, where a partial run is expected.
test('a11y: every budgeted flow was actually audited', () => {
  const visited = allVisitedFlows();
  test.skip(visited.size < 5, 'partial run (--grep); closure only holds for the full file');
  const orphans = findOrphanedEntries({ entries: budget.flows, visited });
  expect(orphans, `Budgeted flows that no test audits: ${orphans.join(', ')}. Delete the entry or restore the flow.`).toEqual([]);
});
