import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DevSeedParts } from './dev-seed.js';
import { sampleJpeg } from './seed.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { run } from '../db/sql.js';

/** E2E-only recorded failures over a real encrypted, decodable video. Existing
 * posters keep background capture from consuming the explicit-retry fixture. */
export async function seedVideoRepair(parts: DevSeedParts, sourcePath: string): Promise<void> {
  const id = '01J8VIDEOREPAIR000000000001';
  const photos = new PhotosRepository(parts.db);
  if (photos.get(id) !== undefined) return;
  await parts.blobStore.init();
  const key = parts.currentKey();
  const ref = await parts.blobStore.putOriginal(Readable.from([await readFile(sourcePath)]), key, id);
  photos.insert({
    id,
    fileName: 'repair-video.webm',
    fileKind: 'video',
    width: 0,
    height: 0,
    bytes: ref.bytes,
    contentHash: ref.contentHash,
    keyId: key.id,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-09-23T00:00:00.000Z',
    importSource: 'seed',
  });
  for (const size of ['thumb', 'mid'] as const) {
    await parts.blobStore.putThumb(Readable.from([sampleJpeg(1)]), key, id, ref.contentHash, size);
  }
  run(parts.db, "UPDATE photos SET preview_failure = 'decode-failed', dimension_status = 'unavailable' WHERE id = ?", id);
  photos.setGalleryPolicy({ showUnavailable: false, minimumMegapixels: null });
}
