import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import sharp from 'sharp';

import { mkE2eTmpDir } from './support/tmp-dir.js';
import { serializeBoard, type Board } from '../../src/shared/moodboard/board.js';

// End-to-end verification of the Moodboard view (#515 / #697): the view renders
// in the real app, and a board's layout persists byte-stably across an app
// restart against the encrypted library store (invariant I2). Layout metadata
// only — no original pixels are touched.

interface BoardResult {
  readonly board: Board | null;
}

const SAVED_BOARD: Board = {
  id: 'board-local',
  title: 'Restart proof',
  notes: 'kept across restart',
  size: { width: 1920, height: 1080 },
  background: 'navy',
  placements: [
    {
      id: 'a',
      photoId: 'photo-a',
      x: 12,
      y: 34,
      w: 260,
      h: 190,
      rotation: 30,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      z: 1,
      groupId: null,
    },
    { id: 'b', photoId: 'photo-b', x: 400, y: 220, w: 200, h: 150, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, z: 2, groupId: null },
  ],
};

test('Moodboard view renders and its layout survives an app restart (I2)', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-moodboard-');
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '3', OVERLOOK_INSECURE_KEYSTORE: '1' },
    });

  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();

    // Switch to the Moodboard view; the role=application canvas renders and the
    // parallel reading-order list is present for assistive tech.
    await page.getByRole('radio', { name: 'Moodboard' }).click();
    await expect(page.getByRole('application', { name: /Moodboard canvas/ })).toBeVisible();
    await expect(page.getByLabel('Placements in reading order')).toBeAttached();

    // Persist a known board through the validated IPC, then read it back.
    // String-form evaluate: window.overlook is not typed in the e2e project.
    await page.evaluate(`window.overlook.boards.save({ board: ${JSON.stringify(SAVED_BOARD)} })`);
    const saved = await page.evaluate<BoardResult>(`window.overlook.boards.get({ boardId: 'board-local' })`);
    if (saved.board === null) throw new Error('board was not persisted');
    expect(serializeBoard(saved.board)).toBe(serializeBoard(SAVED_BOARD));

    await app.close();

    // Relaunch against the same encrypted library — the EXACT canonical board
    // returns, so a drift in any field (size/crop/z/groupId, either placement)
    // fails this evidence rather than passing on a partial match.
    app = await launch();
    page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const restored = await page.evaluate<BoardResult>(`window.overlook.boards.get({ boardId: 'board-local' })`);
    if (restored.board === null) throw new Error('board did not survive restart');
    expect(serializeBoard(restored.board)).toBe(serializeBoard(SAVED_BOARD));
  } finally {
    await app.close();
  }
});

test('Moodboard exports a color-managed PNG at declared dimensions (I4, I6)', async () => {
  const userData = mkE2eTmpDir('overlook-e2e-moodboard-export-');
  const destination = mkE2eTmpDir('overlook-e2e-moodboard-output-');
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OVERLOOK_USER_DATA: userData,
      OVERLOOK_SEED: '3',
      OVERLOOK_INSECURE_KEYSTORE: '1',
      OVERLOOK_EXPORT_DESTINATION: destination,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    await page.getByRole('radio', { name: 'Moodboard' }).click();
    await expect(page.getByRole('application', { name: /Moodboard canvas/u })).toBeVisible();
    await page.getByRole('button', { name: 'Export board' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export board' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Width').fill('320');
    await dialog.getByLabel('Height').fill('240');
    await dialog.getByRole('radio', { name: 'Display P3' }).click();
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await dialog.getByRole('button', { name: 'Export board' }).click();
    await expect(dialog.getByText(/Board exported with \d+ placements?\./u)).toBeVisible({ timeout: 30_000 });

    const files = readdirSync(destination);
    expect(files).toEqual(['Summer palette.png']);
    const metadata = await sharp(join(destination, files[0] ?? '')).metadata();
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.format).toBe('png');
    expect(metadata.icc?.length ?? 0).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
