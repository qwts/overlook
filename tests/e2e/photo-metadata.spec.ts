import { expect, test } from './support/app.js';

const FIRST = '01J8SEEDPHOTO0000';
const SECOND = '01J8SEEDPHOTO0001';

test('photo metadata edits, bulk tags, live search, and restart persistence (#508)', async ({ launchOverlook }) => {
  const first = await launchOverlook({ prefix: 'overlook-e2e-photo-metadata-', env: { OVERLOOK_SEED: '3' } });
  await first.page.locator('.ovl-tile__img').first().waitFor();
  await first.page.getByRole('button', { name: 'Select IMG_4021.RAF' }).click();
  await first.page.keyboard.press('i');

  const inspector = first.page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  await inspector.getByLabel('Title').fill('Lisbon night');
  await inspector.getByLabel('Description').fill('Portfolio walk by the water');
  await inspector.getByLabel('Add tag').fill('Portfolio');
  await inspector.getByLabel('Add tag').press('Enter');
  await inspector.getByRole('button', { name: 'Save metadata' }).click();
  await expect(inspector).toContainText('Updated 1; 0 unchanged; 0 unavailable.');

  const search = first.page.getByRole('searchbox', { name: 'Search library' });
  await search.fill('portfolio');
  await expect(first.page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(1);
  await search.fill('');
  // The cleared query lands after the debounce; wait for the whole seed back
  // before building the pair.
  await expect(first.page.getByTestId('virtual-grid').locator('.ovl-grid__cell')).toHaveCount(3);

  // An explicit selection only survives a search while its photo stays on
  // the loaded page (app-state photos/loaded); a slow index can land a page
  // without it first, so re-establish the first photo if the search dropped it.
  const pill = first.page.getByTestId('selection-pill');
  if (!(await pill.isVisible())) await first.page.getByRole('button', { name: 'Select IMG_4021.RAF' }).click();
  await expect(pill).toContainText('1 selected');
  await first.page.getByRole('button', { name: 'Select IMG_4028.JPG' }).click();
  await expect(pill).toContainText('2 selected');
  await expect(inspector.getByRole('button', { name: 'Apply to 2 photos' })).toBeVisible();
  await inspector.getByLabel('Add tag').fill('Shared set');
  await inspector.getByLabel('Add tag').press('Enter');
  await inspector.getByRole('button', { name: 'Apply to 2 photos' }).click();
  await expect(inspector).toContainText('Updated 2; 0 unchanged; 0 unavailable.');
  await first.close();

  const second = await launchOverlook({ userData: first.userData });
  const persisted = await second.page.evaluate<{
    first: { title: string | null; description: string | null; tags: readonly string[] } | null;
    second: { tags: readonly string[] } | null;
  }>(`Promise.all([
    window.overlook.library.get({ id: '${FIRST}' }),
    window.overlook.library.get({ id: '${SECOND}' })
  ]).then(([first, second]) => ({
    first: first.photo === null ? null : { title: first.photo.title, description: first.photo.description, tags: first.photo.tags },
    second: second.photo === null ? null : { tags: second.photo.tags }
  }))`);
  expect(persisted.first).toEqual({
    title: 'Lisbon night',
    description: 'Portfolio walk by the water',
    tags: ['Portfolio', 'Shared set'],
  });
  expect(persisted.second?.tags).toEqual(['Shared set']);
});
