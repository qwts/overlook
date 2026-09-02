import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from './support/app.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

// #495 acceptance over the real app: the provenance fixtures import through
// the ordinary flow and the Inspector's Provenance section renders each
// honest state from the evidence main evaluated locally — a declared
// generator (Declared · AI-generated), a present-but-unvalidated credential
// (Declared, "not validated by this build", never Verified), and a file with
// no evidence (Unknown, with the copy that Unknown is not "human-made").
// Re-check re-evaluates and keeps the same answer.

const FIXTURES = join(import.meta.dirname, '../fixtures/provenance');
const CARD_FILES = ['declared-generator.jpg', 'credential-stub.jpg', 'unknown.jpg'] as const;

function makeCard(): string {
  const card = join(mkE2eTmpDir('overlook-e2e-provenance-'), 'PROVENANCE-FIXTURES');
  mkdirSync(card);
  for (const name of CARD_FILES) copyFileSync(join(FIXTURES, name), join(card, name));
  return card;
}

test('AI provenance: declared, credential present, unknown — honest Inspector states', async ({ launchOverlook }) => {
  test.setTimeout(90_000);
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-provenance-',
    readyTestId: null,
    env: { OVERLOOK_IMPORT_SOURCE: makeCard() },
  });
  await page.getByRole('button', { name: 'Start a new library' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('PROVENANCE-FIXTURES', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import 3 photos' }).click();
  await expect(page.getByText('All 3 photos imported and encrypted.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Show in library' }).click();
  await expect(page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const section = inspector.getByTestId('inspector-provenance');
  const tier = inspector.getByTestId('inspector-provenance-tier');
  // Grid order is the library page order; map file names to tile indexes.
  const order = await page.evaluate<string[]>(
    `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => p.fileName))`,
  );
  expect([...order].sort()).toEqual([...CARD_FILES].sort());

  const open = async (fileName: string): Promise<void> => {
    await page.locator('.ovl-grid__cell').nth(order.indexOf(fileName)).click();
    await expect(page.getByTestId('lightbox')).toContainText(fileName);
    await page.keyboard.press('i');
    await expect(section).toHaveAttribute('data-status', 'evaluated');
  };
  const close = async (): Promise<void> => {
    await page.keyboard.press('i');
    await page.keyboard.press('Escape');
  };

  await open('declared-generator.jpg');
  await expect(section).toHaveAttribute('data-tier', 'declared');
  await expect(tier).toHaveText('Declared');
  await expect(section).toContainText('AI-generated — declared by metadata, not verified');
  await expect(section).toContainText('Adobe Firefly 3.0');
  await expect(section).toContainText('trainedAlgorithmicMedia');
  await expect(section).toContainText('not proof');
  await expect(section).toContainText('no network');
  await close();

  await open('credential-stub.jpg');
  await expect(section).toHaveAttribute('data-tier', 'declared');
  await expect(section).toContainText('Content Credentials present — not validated by this build');
  await expect(section).toContainText('unverifiable');
  await expect(section).not.toContainText('Verified provenance');
  await close();

  await open('unknown.jpg');
  await expect(section).toHaveAttribute('data-tier', 'unknown');
  await expect(tier).toHaveText('Unknown');
  await expect(section).toContainText('No supported evidence');
  await expect(section).toContainText('Unknown is not a claim that a person made this image.');
  // Re-check re-evaluates locally and lands on the same honest answer.
  await inspector.getByRole('button', { name: 'Re-check' }).click();
  await expect(section).toHaveAttribute('data-status', 'evaluated');
  await expect(section).toHaveAttribute('data-tier', 'unknown');
  await expect(section).toHaveAttribute('data-stale', 'false');
});
