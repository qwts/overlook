import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { PhotoRecord } from '../../src/shared/library/types.js';
import { mkE2eTmpDir } from './support/tmp-dir.js';

// Create a real VP8 WebM using Electron's own encoder, then feed those bytes
// through the encrypted fixture and production offscreen poster decoder.
test('Inspector video retry repairs preview and source dimensions without restart (#1098)', async () => {
  test.setTimeout(60_000);
  const userData = mkE2eTmpDir('overlook-video-repair-');
  const source = join(userData, 'source.webm');
  const env = { ...process.env, OVERLOOK_USER_DATA: userData, OVERLOOK_SEED: '3', OVERLOOK_E2E: '1', OVERLOOK_INSECURE_KEYSTORE: '1' };
  const encoder = await electron.launch({ args: ['.'], env });
  try {
    const page = await encoder.firstWindow();
    await page.getByTestId('virtual-grid').waitFor();
    const bytes = await page.evaluate<number[]>(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('canvas unavailable');
      const stream = canvas.captureStream(0);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error('video fixture encoding failed'));
      });
      recorder.start();
      try {
        for (let frame = 0; frame < 10; frame++) {
          context.fillStyle = frame % 2 === 0 ? '#123456' : '#abcdef';
          context.fillRect(0, 0, 96, 64);
          stream.getVideoTracks()[0].requestFrame();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        recorder.stop();
        await stopped;
        return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
    })()`);
    expect(bytes.length).toBeGreaterThan(0);
    writeFileSync(source, Buffer.from(bytes));
  } finally {
    await encoder.close();
  }
  const app = await electron.launch({ args: ['.'], env: { ...env, OVERLOOK_SEED_VIDEO_REPAIR: source } });
  try {
    const page = await app.firstWindow();
    const id = '01J8VIDEOREPAIR000000000001';
    await page.getByRole('button', { name: 'Unavailable 1', exact: true }).click();
    const row = page.locator(`[data-quick-action-photo-id="${id}"]`);
    await row.click();
    await page.keyboard.press('i');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Retry repair', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unavailable', exact: false })).toHaveCount(0);
    const result = await page.evaluate<{ photo: PhotoRecord | null }>(`window.overlook.library.get(${JSON.stringify({ id })})`);
    expect(result.photo).toMatchObject({ fileKind: 'video', previewFailure: null, dimensionStatus: 'verified', width: 96, height: 64 });
    await page.getByRole('button', { name: 'All Photos 4', exact: true }).click();
    await expect(row).toBeVisible();
  } finally {
    await app.close();
  }
});
