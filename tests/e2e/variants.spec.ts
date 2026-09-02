import { expect, test } from './support/app.js';

// #496 acceptance over the real app: Duplicate from the context menu creates
// a sibling variant that shares the original's content hash but owns its
// own derivative key and previews; the Inspector's Variants section lists
// the family and Promote moves the representative. Nothing here touches
// the original bytes.

interface Row {
  readonly id: string;
  readonly fileName: string;
  readonly contentHash: string;
  readonly derivativeKey: string;
  readonly variantSourceId: string | null;
}

const PAGE_ROWS = `window.overlook.library.page({ source: 'all', limit: 10 }).then((r) => r.photos.map((p) => ({ id: p.id, fileName: p.fileName, contentHash: p.contentHash, derivativeKey: p.derivativeKey, variantSourceId: p.variantSourceId })))`;

test('variants: Duplicate creates a sibling over one original; the Inspector lists the family and Promote moves the representative', async ({
  launchOverlook,
}) => {
  test.setTimeout(90_000);
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-variants-', env: { OVERLOOK_SEED: '2' } });
  await page.locator('.ovl-tile__img').first().waitFor();
  const cells = page.locator('.ovl-grid__cell');
  await expect(cells).toHaveCount(2);

  const openButtons = page.getByRole('button', { name: /^Open IMG_/u });
  await openButtons.nth(0).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: /Actions for IMG_/u });
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.locator('.ovl-toast-host')).toContainText('Duplicated 1 photo');
  await expect(cells).toHaveCount(3);

  const rows = await page.evaluate<Row[]>(PAGE_ROWS);
  const duplicate = rows.find((row) => row.variantSourceId !== null);
  expect(duplicate).toBeDefined();
  if (duplicate === undefined) return;
  const source = rows.find((row) => row.id === duplicate.variantSourceId);
  expect(source).toBeDefined();
  if (source === undefined) return;
  expect(duplicate.contentHash).toBe(source.contentHash);
  expect(duplicate.derivativeKey).not.toBe(source.derivativeKey);
  expect(duplicate.fileName).toBe(source.fileName);
  // The duplicate's tile is served under its own key — a real preview, not a broken image.
  const tile = cells.nth(rows.indexOf(duplicate)).locator('.ovl-tile__img');
  await expect
    .poll(() =>
      tile.evaluate((node) => {
        const element = node as unknown as { readonly naturalWidth: number };
        return element.naturalWidth;
      }),
    )
    .toBeGreaterThan(0);

  await cells.nth(rows.indexOf(duplicate)).click();
  await expect(page.getByTestId('lightbox')).toContainText(duplicate.fileName);
  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const section = inspector.getByTestId('inspector-variants');
  await expect(section).toHaveAttribute('data-count', '2');
  await expect(inspector.getByTestId('inspector-variants-count')).toHaveText('2 variants');
  await expect(section).toHaveAttribute('data-representative', '');
  const variantRows = section.getByTestId('inspector-variant');
  await expect(variantRows).toHaveCount(2);
  await expect(section.locator(`[data-photo-id="${duplicate.id}"] button[aria-current="true"]`)).toBeDisabled();

  await section
    .locator(`[data-photo-id="${source.id}"]`)
    .getByRole('button', { name: /^Promote /u })
    .click();
  await expect(section).toHaveAttribute('data-representative', source.id);
  await expect(section.locator(`[data-photo-id="${source.id}"]`)).toContainText('Representative');
  await expect(section.locator(`[data-photo-id="${duplicate.id}"]`).getByRole('button', { name: /^Promote /u })).toBeVisible();

  // Opening the sibling from the list follows it in the lightbox.
  await section
    .locator(`[data-photo-id="${source.id}"]`)
    .getByRole('button', { name: /^Show /u })
    .click();
  await expect(section.locator(`[data-photo-id="${source.id}"] button[aria-current="true"]`)).toBeDisabled();

  // Duplicate from the Inspector adds a third variant to the same family.
  await section.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(section).toHaveAttribute('data-count', '3');
  await expect(cells).toHaveCount(4);
  const after = await page.evaluate<Row[]>(PAGE_ROWS);
  expect(new Set(after.filter((row) => row.contentHash === source.contentHash).map((row) => row.derivativeKey)).size).toBe(3);
});
