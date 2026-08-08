import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import type { OverlookApi } from '../../src/shared/ipc/api.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

import { mkE2eTmpDir } from './support/tmp-dir.js';

const PASSWORD = 'correct horse battery staple';
const PHOTO_COUNT = 4;

type RecoverablePhoto = Pick<
  PhotoRecord,
  | 'id'
  | 'fileName'
  | 'fileKind'
  | 'width'
  | 'height'
  | 'bytes'
  | 'contentHash'
  | 'camera'
  | 'lens'
  | 'iso'
  | 'aperture'
  | 'shutter'
  | 'focalLength'
  | 'takenAt'
  | 'gpsLat'
  | 'gpsLon'
  | 'place'
  | 'importedAt'
  | 'importSource'
  | 'favorite'
  | 'keyId'
  | 'deletedAt'
>;

interface RecoverableSnapshot {
  readonly photos: readonly RecoverablePhoto[];
  readonly albumId: string;
  readonly albumPhotoIds: readonly string[];
}

function launch(userData: string, extra: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_INSECURE_KEYSTORE: '1',
      ...extra,
    },
  });
}

async function backupSimpleSource(source: string, keyPath: string): Promise<readonly string[]> {
  const app = await launch(source, { OVERLOOK_SEED: '2', OVERLOOK_KEY_EXPORT_DESTINATION: keyPath });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const hashes = await page.evaluate<readonly string[]>(async () => {
      const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      const { photos } = await api.library.page({ source: 'all', limit: 100 });
      for (const photo of photos) await api.library.toggleFavorite({ id: photo.id });
      return photos.map((photo) => photo.contentHash);
    });
    await page.evaluate((password) => (globalThis as unknown as { overlook: OverlookApi }).overlook.keys.export({ password }), PASSWORD);
    const backup = await page.evaluate(() => (globalThis as unknown as { overlook: OverlookApi }).overlook.backup.run({}));
    expect(backup).toMatchObject({ failed: 0, skipped: null });
    return hashes;
  } finally {
    await app.close();
  }
}

function highestManifestGeneration(remoteDir: string): number {
  return Math.max(...readdirSync(join(remoteDir, 'manifest')).map((name) => Number(/^gen-(\d+)\.ovlk$/u.exec(name)?.[1] ?? Number.NaN)));
}

test('fresh profile restores complete state; wrong password is isolated and cancellation resumes (#291)', async () => {
  test.setTimeout(60_000);
  const source = mkE2eTmpDir('overlook-e2e-restore-source-');
  const target = mkE2eTmpDir('overlook-e2e-restore-target-');
  const keyPath = join(mkE2eTmpDir('overlook-e2e-restore-key-'), 'overlook-recovery.key');
  const expected = await (async (): Promise<RecoverableSnapshot> => {
    const sourceApp = await launch(source, { OVERLOOK_SEED: String(PHOTO_COUNT), OVERLOOK_KEY_EXPORT_DESTINATION: keyPath });
    try {
      const page = await sourceApp.firstWindow();
      await page.getByTestId('virtual-grid').waitFor();
      const snapshot = await page.evaluate<RecoverableSnapshot>(async () => {
        const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const { photos } = await api.library.page({ source: 'all', limit: 100 });
        const { album } = await api.albums.create({ name: 'Recovery proof' });
        const albumPhotoIds = photos.slice(0, 3).map((photo) => photo.id);
        await api.albums.addPhotos({ albumId: album.id, photoIds: albumPhotoIds });
        for (const photo of photos) await api.library.toggleFavorite({ id: photo.id });
        const updated = await api.library.page({ source: 'all', limit: 100 });
        return {
          photos: updated.photos.map(({ syncState: _syncState, ...recoverable }) => recoverable),
          albumId: album.id,
          albumPhotoIds,
        };
      });
      const exported = await page.evaluate(
        (password) => (globalThis as unknown as { overlook: OverlookApi }).overlook.keys.export({ password }),
        PASSWORD,
      );
      expect(exported.path).toBe(keyPath);
      const backup = await page.evaluate(() => (globalThis as unknown as { overlook: OverlookApi }).overlook.backup.run({}));
      expect(backup).toMatchObject({ failed: 0, skipped: null });
      await expect
        .poll(() =>
          page.evaluate(() => (globalThis as unknown as { overlook: OverlookApi }).overlook.library.stats()).then((s) => s.pending),
        )
        .toBe(0);
      return snapshot;
    } finally {
      await sourceApp.close();
    }
  })();

  cpSync(join(source, 'mock-remote'), join(target, 'mock-remote'), { recursive: true });
  const targetApp = await launch(target, {
    OVERLOOK_KEY_IMPORT_SOURCE: keyPath,
    OVERLOOK_RESTORE_NO_RELAUNCH: '1',
  });
  try {
    const page = await targetApp.firstWindow();
    await expect(page.getByTestId('restore-onboarding')).toBeVisible();
    await page.getByRole('button', { name: 'Choose recovery key' }).click();
    await page.getByLabel('Recovery-key password').fill('wrong password');
    await page.getByRole('button', { name: 'Discover backups' }).click();
    await expect(page.getByRole('alert')).toContainText('password is incorrect');
    expect(existsSync(join(target, 'library', 'library.db'))).toBe(false);

    await page.getByLabel('Recovery-key password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Discover backups' }).click();
    await expect(page.getByTestId('restore-library-card')).toContainText(`${String(PHOTO_COUNT)} photos`);
    await page.getByRole('button', { name: 'Verify backup' }).click();
    await expect(page.getByRole('button', { name: `Restore ${String(PHOTO_COUNT)} photos` })).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('restore-verify')).toHaveCount(0);
    await page.getByRole('button', { name: `Restore ${String(PHOTO_COUNT)} photos` }).click();
    await expect(page.getByRole('button', { name: 'Cancel and keep staged progress' })).toBeVisible();
    await page.evaluate(() => (globalThis as unknown as { overlook: OverlookApi }).overlook.restore.cancel({}));
    await expect(page.getByRole('alert')).toContainText('Restore paused');
    expect(existsSync(join(target, 'library', 'library.db'))).toBe(false);

    await page.getByRole('button', { name: 'Verify backup' }).click();
    await expect(page.getByRole('button', { name: `Restore ${String(PHOTO_COUNT)} photos` })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: `Restore ${String(PHOTO_COUNT)} photos` }).click();
    await expect.poll(() => existsSync(join(target, 'library', 'library.db')), { timeout: 30_000 }).toBe(true);
  } finally {
    await targetApp.close();
  }

  const relaunched = await launch(target);
  try {
    const page = await relaunched.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await expect(page.getByTestId('statusbar-left')).toContainText(`${String(PHOTO_COUNT)} photos`);
    await expect(page.getByTestId('restore-onboarding')).not.toBeVisible();
    const restored = await page.evaluate<RecoverableSnapshot>(async () => {
      const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      const { photos } = await api.library.page({ source: 'all', limit: 100 });
      const { albums } = await api.library.albums();
      const album = albums.find((candidate) => candidate.name === 'Recovery proof');
      if (album === undefined) throw new Error('restored album is missing');
      const members = await api.library.page({ source: 'all', albumId: album.id, limit: 100 });
      return {
        photos: photos.map(({ syncState: _syncState, ...recoverable }) => recoverable),
        albumId: album.id,
        albumPhotoIds: members.photos.map((photo) => photo.id),
      };
    });
    expect(restored).toEqual(expected);
    const first = restored.photos[0];
    expect(first).toBeDefined();
    const viewable = await page.evaluate<{ status: number; jpeg: boolean }>(`fetch('overlook-full://library/${first?.id ?? ''}').then(
      async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 };
      },
    )`);
    expect(viewable).toEqual({ status: 200, jpeg: true });
  } finally {
    await relaunched.close();
  }
});

test('corrupt newest manifest falls back and reports the rejected generation (#291)', async () => {
  const source = mkE2eTmpDir('overlook-e2e-fallback-source-');
  const target = mkE2eTmpDir('overlook-e2e-fallback-target-');
  const keyPath = join(mkE2eTmpDir('overlook-e2e-fallback-key-'), 'overlook-recovery.key');
  await backupSimpleSource(source, keyPath);
  cpSync(join(source, 'mock-remote'), join(target, 'mock-remote'), { recursive: true });
  const remote = join(target, 'mock-remote');
  const validGeneration = highestManifestGeneration(remote);
  const rejectedGeneration = validGeneration + 1;
  writeFileSync(join(remote, 'manifest', `gen-${String(rejectedGeneration)}.ovlk`), 'corrupt newest manifest');

  const app = await launch(target, { OVERLOOK_KEY_IMPORT_SOURCE: keyPath, OVERLOOK_RESTORE_NO_RELAUNCH: '1' });
  try {
    const page = await app.firstWindow();
    const response = await page.evaluate(
      async ({ recoveryKeyPath, password }) => {
        const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const discovered = await api.restore.discover({ providerId: 'mock', keyPath: recoveryKeyPath, password });
        const library = discovered.libraries.find((candidate) => candidate.validation === 'valid');
        if (discovered.sessionId === null || library === undefined) return { discovery: discovered, restored: null };
        const verified = await api.restore.verify({ sessionId: discovered.sessionId, libraryId: library.libraryId });
        if (verified.result === null) return { discovery: discovered, restored: verified };
        const restored = await api.restore.run({
          sessionId: discovered.sessionId,
          libraryId: library.libraryId,
          verificationId: verified.result.verificationId,
          allowReplace: false,
        });
        return { discovery: discovered, restored };
      },
      { recoveryKeyPath: keyPath, password: PASSWORD },
    );
    expect(response.discovery.error).toBeNull();
    expect(response.restored).toMatchObject({
      error: null,
      result: { generation: validGeneration, fallbackFromGeneration: rejectedGeneration },
    });
    expect(existsSync(join(target, 'library', 'library.db'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('corrupt only-generation blob partial-restores and reports the NOT FOUND object (#291/#915)', async () => {
  const source = mkE2eTmpDir('overlook-e2e-corrupt-source-');
  const target = mkE2eTmpDir('overlook-e2e-corrupt-target-');
  const keyPath = join(mkE2eTmpDir('overlook-e2e-corrupt-key-'), 'overlook-recovery.key');
  const hashes = await backupSimpleSource(source, keyPath);
  cpSync(join(source, 'mock-remote'), join(target, 'mock-remote'), { recursive: true });
  const firstHash = hashes[0];
  expect(firstHash).toBeDefined();
  writeFileSync(join(target, 'mock-remote', 'blobs', firstHash?.slice(0, 2) ?? '', firstHash ?? ''), 'corrupt blob');

  const app = await launch(target, { OVERLOOK_KEY_IMPORT_SOURCE: keyPath, OVERLOOK_RESTORE_NO_RELAUNCH: '1' });
  try {
    const page = await app.firstWindow();
    const response = await page.evaluate(
      async ({ recoveryKeyPath, password }) => {
        const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const discovered = await api.restore.discover({ providerId: 'mock', keyPath: recoveryKeyPath, password });
        if (discovered.error !== null || discovered.sessionId === null) return { discoveryError: discovered.error, run: null };
        const library = discovered.libraries.find((candidate) => candidate.validation === 'valid');
        if (library === undefined) return { discoveryError: { reason: 'corrupt', message: 'no valid library' }, run: null };
        const verified = await api.restore.verify({ sessionId: discovered.sessionId, libraryId: library.libraryId });
        if (verified.result === null) return { discoveryError: verified.error, run: null };
        return {
          discoveryError: null,
          run: await api.restore.run({
            sessionId: discovered.sessionId,
            libraryId: library.libraryId,
            verificationId: verified.result.verificationId,
            allowReplace: false,
          }),
        };
      },
      { recoveryKeyPath: keyPath, password: PASSWORD },
    );
    // #915: with no complete retained generation, the restore recovers what
    // verifies and reports the unverifiable object instead of failing whole.
    expect(response.discoveryError).toBeNull();
    expect(response.run?.error).toBeNull();
    expect(response.run?.result).toMatchObject({
      photos: 1,
      missing: [{ kind: 'original', reason: 'failed-verification', path: `blobs/${firstHash?.slice(0, 2) ?? ''}/${firstHash ?? ''}` }],
    });
    expect(existsSync(join(target, 'library', 'library.db'))).toBe(true);
    expect(existsSync(join(target, 'library', 'restore-report.json'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('activation failure rolls the existing library back through the full restore path (#291)', async () => {
  const source = mkE2eTmpDir('overlook-e2e-rollback-source-');
  const target = mkE2eTmpDir('overlook-e2e-rollback-target-');
  const keyPath = join(mkE2eTmpDir('overlook-e2e-rollback-key-'), 'overlook-recovery.key');
  const restoredHashes = await backupSimpleSource(source, keyPath);

  const targetSetup = await launch(target, { OVERLOOK_SEED: '1' });
  let activeHashes: readonly string[];
  try {
    const page = await targetSetup.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    activeHashes = await page.evaluate(async () => {
      const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      return (await api.library.page({ source: 'all', limit: 100 })).photos.map((photo) => photo.contentHash);
    });
  } finally {
    await targetSetup.close();
  }
  expect(activeHashes).toHaveLength(1);
  rmSync(join(target, 'mock-remote'), { recursive: true, force: true });
  cpSync(join(source, 'mock-remote'), join(target, 'mock-remote'), { recursive: true });

  const failing = await launch(target, {
    OVERLOOK_KEY_IMPORT_SOURCE: keyPath,
    OVERLOOK_RESTORE_FAULT: 'activation',
    OVERLOOK_RESTORE_NO_RELAUNCH: '1',
  });
  try {
    const page = await failing.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const response = await page.evaluate(
      async ({ recoveryKeyPath, password }) => {
        const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
        const discovered = await api.restore.discover({ providerId: 'mock', keyPath: recoveryKeyPath, password });
        const library = discovered.libraries.find((candidate) => candidate.validation === 'valid');
        if (discovered.sessionId === null || library === undefined) return null;
        const verified = await api.restore.verify({ sessionId: discovered.sessionId, libraryId: library.libraryId });
        if (verified.result === null) return verified;
        return api.restore.run({
          sessionId: discovered.sessionId,
          libraryId: library.libraryId,
          verificationId: verified.result.verificationId,
          allowReplace: true,
        });
      },
      { recoveryKeyPath: keyPath, password: PASSWORD },
    );
    expect(response?.result).toBeNull();
    expect(response?.error).toMatchObject({ reason: 'io', message: 'injected activation failure' });
  } finally {
    await failing.close();
  }

  expect(existsSync(join(target, 'library.restore-previous'))).toBe(false);
  expect(existsSync(join(target, 'library.restore-staging', 'library.db'))).toBe(true);
  const relaunched = await launch(target);
  try {
    const page = await relaunched.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const currentHashes = await page.evaluate(async () => {
      const api = (globalThis as unknown as { overlook: OverlookApi }).overlook;
      return (await api.library.page({ source: 'all', limit: 100 })).photos.map((photo) => photo.contentHash);
    });
    expect(currentHashes).toEqual(activeHashes);
    expect(currentHashes).not.toEqual(restoredHashes);
  } finally {
    await relaunched.close();
  }
});
