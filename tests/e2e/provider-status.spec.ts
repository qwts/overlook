import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mkE2eTmpDir } from './support/tmp-dir.js';
import type { OverlookApi } from '../../src/shared/ipc/api.js';

const GOOGLE_CLIENT_ID = 'overlook-e2e.apps.googleusercontent.com';

type ProviderId = 'google-drive' | 'pcloud' | 'icloud-drive';

function launch(userData: string, providerId: ProviderId, stall: boolean): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '1',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_ICLOUD_FAKE: '1',
      OVERLOOK_GOOGLE_DRIVE_CLIENT_ID: GOOGLE_CLIENT_ID,
      OVERLOOK_PCLOUD_ENABLED: '1',
      OVERLOOK_PCLOUD_CLIENT_ID: 'public-e2e-client',
      ...(stall
        ? {
            OVERLOOK_PROVIDER_STORAGE_STALL: providerId,
            OVERLOOK_PROVIDER_STORAGE_TIMEOUT_MS: '1500',
          }
        : {}),
    },
  });
}

function sealForInsecureKeystore(record: object): Buffer {
  return Buffer.from(Buffer.from(JSON.stringify(record), 'utf8').map((byte) => byte ^ 0x5f));
}

function seedCredential(userData: string, providerId: Exclude<ProviderId, 'icloud-drive'>): void {
  const directory = join(userData, 'provider-auth', providerId);
  mkdirSync(directory, { recursive: true });
  if (providerId === 'pcloud') {
    writeFileSync(
      join(directory, 'pcloud-auth.bin'),
      sealForInsecureKeystore({
        accessToken: 'e2e-local-only-token',
        apiHost: 'api.pcloud.com',
        connectedAt: '2026-07-22T00:00:00.000Z',
        accountId: '73001',
        accountLabel: 'owner@pcloud.e2e',
      }),
    );
    return;
  }
  writeFileSync(
    join(directory, 'google-drive-auth.bin'),
    sealForInsecureKeystore({
      clientId: GOOGLE_CLIENT_ID,
      refreshToken: 'e2e-local-only-refresh-token',
      connectedAt: '2026-07-22T00:00:00.000Z',
      accountId: 'e2e-google-permission',
      accountLabel: 'owner@google.e2e',
    }),
  );
}

for (const providerId of ['google-drive', 'pcloud', 'icloud-drive'] as const) {
  test(`${providerId} renders Connected independently from native capacity and survives restart`, async () => {
    const userData = mkE2eTmpDir(`overlook-e2e-provider-status-${providerId}-`);

    if (providerId !== 'icloud-drive') {
      const bootstrap = await launch(userData, providerId, false);
      try {
        const page = await bootstrap.firstWindow();
        await page.getByTestId('virtual-grid').waitFor();
        await page.evaluate((id) => {
          const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
          return overlook.settings.set({ patch: { providerId: id } });
        }, providerId);
      } finally {
        await bootstrap.close();
      }
      seedCredential(userData, providerId);
    }

    const app = await launch(userData, providerId, true);
    try {
      const page = await app.firstWindow();
      await page.getByTestId('virtual-grid').waitFor();
      if (providerId === 'icloud-drive') {
        expect(
          await page.evaluate((id) => {
            const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
            return overlook.backup.connect({ providerId: id });
          }, providerId),
        ).toEqual({
          ok: true,
          reason: null,
        });
      }

      const authority = await page.evaluate(async (id) => {
        const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const storage = overlook.backup.providerStorage({ providerId: id });
        Object.assign(globalThis, { __overlookProviderStorage: storage });
        const started = performance.now();
        const status = await Promise.race([
          overlook.backup.providerStatus({ providerId: id }),
          new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
        ]);
        return { status, elapsedMs: performance.now() - started };
      }, providerId);
      expect(authority.status).not.toBe('timed-out');
      expect(authority.status).toMatchObject({ connected: true, provider: { id: providerId } });
      expect(authority.elapsedMs).toBeLessThan(500);

      await page.getByRole('button', { name: 'Settings' }).click();
      const card = page.getByTestId('provider-card');
      await expect(card).toContainText('Connected');
      await expect(card.getByRole('button', { name: 'Disconnect provider' })).toBeEnabled();
      await expect(card).not.toContainText('Checking connection…');
      await expect(card).not.toContainText('Used by Overlook');
      await expect(card).not.toContainText('Measuring your backups');

      const capacity = await page.evaluate<{
        capacity: unknown;
        capacityRoute: string;
      }>(`globalThis.__overlookProviderStorage`);
      expect(capacity.capacity).toBe(null);
      expect(capacity.capacityRoute).toBe(providerId === 'icloud-drive' ? 'system-settings' : 'none');
    } finally {
      await app.close();
    }

    const restarted = await launch(userData, providerId, false);
    try {
      const page = await restarted.firstWindow();
      await page.getByTestId('virtual-grid').waitFor();
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const overlook = (globalThis as unknown as { overlook: OverlookApi }).overlook;
            return overlook.backup.providerStatus({ providerId: id });
          }, providerId),
        )
        .toMatchObject({ connected: true, provider: { id: providerId } });
    } finally {
      await restarted.close();
    }
  });
}
