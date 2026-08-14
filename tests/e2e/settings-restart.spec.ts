import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

import { mkE2eTmpDir } from './support/tmp-dir.js';

// #116 exit criteria: the settings round-trip proven through a REAL app
// restart — values changed in run one persist to disk, and run two both
// reports them over IPC and RENDERS from them (grid order, disconnected
// card) without any user action.

function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '2',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_PCLOUD_ENABLED: '1',
      OVERLOOK_PCLOUD_CLIENT_ID: 'public-e2e-client',
    },
  });
}

test('settings persist across an app restart and re-render the UI', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-settings-restart-');

  // Run one: change sort, Wi-Fi, bandwidth, and disconnect the provider.
  // Same try/finally as run two — a run-one failure must not orphan the
  // app holding the temp profile (PR #215 review).
  const first = await launch(userData);
  try {
    const page = await first.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.locator('.ovl-tile__img').first().waitFor();
    // Date order (default): the newest-by-date seed row leads.
    await expect(page.locator('.ovl-tile__open').first()).toHaveAccessibleName(/^Open IMG_4021\.RAF,/u);

    await page.evaluate(
      `window.overlook.settings.set({ patch: { sortOrder: 'size', wifiOnly: false, bandwidthLimit: 40, providerId: null, appearance: 'light' } })`,
    );
  } finally {
    await first.close();
  }

  // Run two: the same profile reports AND renders the persisted values.
  const second = await launch(userData);
  try {
    const page = await second.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    const persisted = await page.evaluate<{
      settings: { sortOrder: string; wifiOnly: boolean; bandwidthLimit: number; providerId: string | null; appearance: string };
    }>(`window.overlook.settings.get()`);
    expect(persisted.settings).toMatchObject({
      sortOrder: 'size',
      wifiOnly: false,
      bandwidthLimit: 40,
      providerId: null,
      appearance: 'light',
    });

    // #395: the persisted mode reaches native chrome and the blocking HTML
    // bootstrap before the renderer paints app content.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(new URL(page.url()).searchParams.get('theme')).toBe('light');
    expect(
      await second.evaluate(({ BrowserWindow, nativeTheme }) => ({
        background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase(),
        source: nativeTheme.themeSource,
      })),
    ).toEqual({ background: '#f7f8fa', source: 'light' });

    // The grid comes up in the persisted order with no user action: size's
    // id-DESC tiebreak leads with IMG_4028 (seed rows share one byte size).
    await expect(page.locator('.ovl-tile__open').first()).toHaveAccessibleName(/^Open IMG_4028\.JPG,/u);

    // The dialog re-renders the persisted state too: disconnected card,
    // backup-specific controls hidden (#239), import Copy/Move still usable.
    // The bandwidth value itself persists in the store even while its
    // control is hidden.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('provider-card')).toContainText('Not connected');
    await expect(page.getByRole('radio', { name: 'Copy' })).toBeEnabled();
    await expect(page.getByRole('slider', { name: 'Upload bandwidth limit' })).toBeHidden();
    const stored = await page.evaluate<{ settings: { bandwidthLimit: number } }>(`window.overlook.settings.get()`);
    expect(stored.settings.bandwidthLimit).toBe(40);

    // And a manual backup stays blocked while disconnected — the restart
    // did not silently reconnect anything.
    const blocked = await page.evaluate<{ skipped: string | null }>(`window.overlook.backup.run({})`);
    expect(blocked.skipped).toBe('disconnected');
  } finally {
    await second.close();
  }
});

test('pCloud disconnect clears real profile custody and persists across restart', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-pcloud-disconnect-');
  const first = await launch(userData);
  try {
    const page = await first.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.evaluate(`window.overlook.settings.set({ patch: { providerId: 'pcloud' } })`);
  } finally {
    await first.close();
  }

  const custodyDir = join(userData, 'provider-auth', 'pcloud');
  const custodyFile = join(custodyDir, 'pcloud-auth.bin');
  const record = JSON.stringify({
    accessToken: 'e2e-local-only-token',
    apiHost: 'api.pcloud.com',
    connectedAt: '2026-07-18T00:00:00.000Z',
    accountId: '927001',
    accountLabel: 'owner@pcloud.e2e',
  });
  mkdirSync(custodyDir, { recursive: true });
  writeFileSync(custodyFile, Buffer.from(Buffer.from(record, 'utf8').map((byte) => byte ^ 0x5f)));

  const second = await launch(userData);
  try {
    const page = await second.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const results = await page.evaluate<readonly { ok: boolean; reason: string | null }[]>(
      `Promise.all([
        window.overlook.backup.disconnect({ providerId: 'pcloud' }),
        window.overlook.backup.disconnect({ providerId: 'pcloud' })
      ])`,
    );
    expect(results).toEqual([
      { ok: true, reason: null },
      { ok: true, reason: null },
    ]);
    expect(existsSync(custodyFile)).toBe(false);
    const settings = await page.evaluate<{ settings: { providerId: string | null } }>(`window.overlook.settings.get()`);
    expect(settings.settings.providerId).toBe(null);
  } finally {
    await second.close();
  }

  const persisted = JSON.parse(readFileSync(join(userData, 'library', 'settings.json'), 'utf8')) as { providerId?: unknown };
  expect(persisted.providerId).toBe(null);

  const third = await launch(userData);
  try {
    const page = await third.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const settings = await page.evaluate<{ settings: { providerId: string | null } }>(`window.overlook.settings.get()`);
    expect(settings.settings.providerId).toBe(null);
    expect(existsSync(custodyFile)).toBe(false);
  } finally {
    await third.close();
  }
});
