import type { OverlookApi } from '../../src/shared/ipc/api.js';
import { test, expect } from './support/app.js';

test('natural-language semantic search surfaces a photo with honest applied-mode metadata', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({
    prefix: 'overlook-e2e-semantic-search-',
    env: { OVERLOOK_SEED: '16', OVERLOOK_SEMANTIC_QUERY_DIMENSION: '0' },
  });
  await page.getByRole('radio', { name: 'Semantic' }).click();
  await page.getByRole('searchbox', { name: 'Search library' }).fill('a neon tram at dusk');
  await expect(page.locator('.ovl-toolbar__hint[role="status"]')).toContainText('Semantic results');
  await expect(page.getByRole('button', { name: 'Open IMG_4021.RAF' })).toBeVisible();

  const result = await page.evaluate(() =>
    (globalThis as unknown as { overlook: OverlookApi }).overlook.library.page({
      source: 'all',
      limit: 16,
      query: 'a neon tram at dusk',
      searchMode: 'semantic',
    }),
  );
  expect(result.search).toMatchObject({ requestedMode: 'semantic', appliedMode: 'semantic', fallbackReason: null });
  expect(result.photos[0]?.id).toBe('01J8SEEDPHOTO0000');
});

test('an unavailable semantic index visibly falls back to exact keyword results', async ({ launchOverlook }) => {
  const { page } = await launchOverlook({ prefix: 'overlook-e2e-semantic-fallback-', env: { OVERLOOK_SEED: '16' } });
  await page.getByRole('radio', { name: 'Semantic' }).click();
  await page.getByRole('searchbox', { name: 'Search library' }).fill('Lisbon');
  await expect(page.locator('.ovl-toolbar__hint[role="status"]')).toContainText('Semantic is off; showing keyword results');
  await expect(page.getByRole('button', { name: 'Open IMG_4021.RAF' })).toBeVisible();
});
