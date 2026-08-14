import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from './support/app.js';

interface Endpoint {
  readonly port: number;
  readonly token: string;
}

test('explicit Finder consent publishes and revokes the authenticated read-only projection (#797)', async ({ launchOverlook }) => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'overlook-e2e-file-provider-'));
  const endpointPath = path.join(stateDirectory, 'endpoint.json');
  const running = await launchOverlook({
    prefix: 'overlook-e2e-file-provider-profile-',
    env: { OVERLOOK_SEED: '3', OVERLOOK_FILE_PROVIDER_STATE_DIRECTORY: stateDirectory },
  });
  const { page } = running;
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByTestId('settings-dialog');
  const consent = dialog.getByRole('checkbox', { name: /Finder decrypts originals on demand/u });
  const enable = dialog.getByRole('button', { name: 'Enable Finder access' });
  await expect(enable).toBeDisabled();
  await consent.check();
  await enable.click();
  await expect(dialog.getByText(/Finder access is on/u)).toBeVisible();
  await expect.poll(() => existsSync(endpointPath)).toBe(true);

  const endpoint = JSON.parse(readFileSync(endpointPath, 'utf8')) as Endpoint;
  const response = await fetch(`http://127.0.0.1:${String(endpoint.port)}/v1/enumerate?parent=root`, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
  });
  expect(response.status).toBe(200);
  const items = (await response.json()) as readonly { readonly name: string; readonly readOnly: boolean }[];
  expect(items.map(({ name }) => name)).toEqual(['IMG_4021.RAF', 'IMG_4028.JPG', 'IMG_4035.JPG']);
  expect(items.every(({ readOnly }) => readOnly)).toBe(true);

  await dialog.getByRole('button', { name: 'Disable Finder access' }).click();
  await expect(dialog.getByRole('button', { name: 'Enable Finder access' })).toBeVisible();
  await expect.poll(() => existsSync(endpointPath)).toBe(false);
  await expect(fetch(`http://127.0.0.1:${String(endpoint.port)}/v1/enumerate?parent=root`)).rejects.toThrow();
});
