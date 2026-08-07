import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/app.js';

test('selected photos enter the bounded native drag materializer (#796)', async ({ launchOverlook }) => {
  const destination = mkdtempSync(join(tmpdir(), 'overlook-e2e-native-drag-'));
  const running = await launchOverlook({
    prefix: 'overlook-e2e-native-drag-profile-',
    env: { OVERLOOK_SEED: '3', OVERLOOK_NATIVE_DRAG_DESTINATION: destination },
  });
  await running.page.locator('.ovl-tile__img').first().waitFor();
  await expect
    .poll(() => running.page.evaluate<{ available: boolean; reason: string | null }>('window.overlook.nativeDrag.status()'))
    .toEqual({ available: true, reason: null });
  await running.page.getByRole('button', { name: 'Select IMG_4021.RAF' }).click();
  await running.page.getByRole('button', { name: 'Select IMG_4028.JPG' }).click();

  const transfer = await running.page.evaluateHandle(
    () => new (globalThis as unknown as { DataTransfer: new () => object }).DataTransfer(),
  );
  await running.page.getByRole('button', { name: /Open IMG_4021\.RAF/u }).dispatchEvent('dragstart', { dataTransfer: transfer });
  await expect
    .poll(() =>
      readdirSync(destination)
        .sort()
        .map((name) => [name, readFileSync(join(destination, name)).length > 0]),
    )
    .toEqual([
      ['IMG_4021.RAF', true],
      ['IMG_4028.JPG', true],
    ]);
  expect(readFileSync(join(destination, 'IMG_4021.RAF')).length).toBeGreaterThan(0);
  expect(readFileSync(join(destination, 'IMG_4028.JPG')).length).toBeGreaterThan(0);
  await transfer.dispose();
});
