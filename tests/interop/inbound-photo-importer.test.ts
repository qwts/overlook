import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { EnvelopeKey, KeyResolver } from '../../src/main/crypto/envelope.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import {
  deterministicInboundPhotoId,
  inboundFileName,
  InboundPhotoImporter,
  type InboundPhotoImporterOptions,
} from '../../src/main/interop/inbound-photo-importer.js';
import { InteropRepository } from '../../src/main/interop/interop-repository.js';
import { interopEnvelopeSchema } from '../../src/shared/interop/messages.js';
import { interopRecordSchema, type InteropRecord } from '../../src/shared/interop/records.js';

const KEY: EnvelopeKey = { id: 1, key: randomBytes(32) };
const RESOLVE: KeyResolver = (keyId) => (keyId === KEY.id ? KEY.key : undefined);
const EMPTY_METADATA = {
  width: null,
  height: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: null,
  gpsLat: null,
  gpsLon: null,
} as const;

function fixtureRecord(): InteropRecord {
  const envelope = interopEnvelopeSchema.parse(
    JSON.parse(readFileSync('design/handoff/contracts/v1/fixtures/valid-record-message.json', 'utf8')) as unknown,
  );
  if (envelope.payload.kind !== 'record') throw new Error('Expected record fixture.');
  return envelope.payload.record;
}

function imageBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('NO-PLAINTEXT-TEMP-MARKER')]);
}

function availableRecord(overrides: Partial<InteropRecord> = {}): InteropRecord {
  const bytes = imageBytes();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const base = fixtureRecord();
  return interopRecordSchema.parse({
    ...base,
    identity: { ...base.identity, contentHash: hash },
    title: '  Summer / reference: frame.  ',
    dimensions: { width: 640, height: 480 },
    original: { state: 'available', blobId: 'source-original', mimeType: 'image/png', byteLength: bytes.length, contentHash: hash },
    ...overrides,
  });
}

async function harness(overrides: Partial<InboundPhotoImporterOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-inbound-photo-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'wrapped-test', '2026-07-21T18:00:00.000Z')`);
  const photos = new PhotosRepository(db);
  const interop = new InteropRepository(db);
  const blobs = new BlobStore({ dataDir });
  await blobs.init();
  const options: InboundPhotoImporterOptions = {
    db,
    photos,
    interop,
    blobs,
    currentKey: () => KEY,
    resolveKey: RESOLVE,
    thumbnails: { generateFor: () => Promise.resolve({ generated: false, width: null, height: null }) },
    now: () => '2026-07-21T18:00:00.000Z',
    metadata: () => Promise.resolve(EMPTY_METADATA),
    ...overrides,
  };
  return { dataDir, db, photos, interop, blobs, importer: new InboundPhotoImporter(options) };
}

function hooks() {
  const calls: string[] = [];
  return {
    calls,
    value: {
      blobCommitted: () => calls.push('blob'),
      databaseCommitted: () => calls.push('database'),
    },
  };
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap((entry) =>
    entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
  );
}

test('imports a detected original into encrypted custody before one native database commit', async () => {
  const world = await harness();
  const record = availableRecord();
  const stages = hooks();
  const accepted = await world.importer.acceptOriginal(record, [], 'eligible', imageBytes(), stages.value);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(stages.calls, ['blob', 'database']);
  const photoId = deterministicInboundPhotoId(record.identity.interopId);
  const photo = world.photos.get(photoId);
  assert.equal(photo?.fileName, 'Summer reference frame.png');
  assert.equal(photo?.takenAt, null, 'bookmark timestamp was not promoted to EXIF takenAt');
  assert.equal(photo?.contentHash, record.identity.contentHash);
  assert.equal(world.interop.getRecord(record.identity.interopId)?.localPhotoId, photoId);
  assert.equal(await world.blobs.verifyOriginal(record.identity.contentHash ?? '', RESOLVE, photoId), true);
  const marker = Buffer.from('NO-PLAINTEXT-TEMP-MARKER');
  for (const file of files(world.dataDir)) assert.equal(readFileSync(file).includes(marker), false, `plaintext leaked to ${file}`);
  world.db.close();
});

test('fallback naming is stable and signature/mime mismatches are retained', async () => {
  const record = availableRecord({ title: null });
  assert.equal(inboundFileName(record, 'png'), `Image Trail capture ${record.identity.interopId.slice(0, 8)}.png`);
  const world = await harness();
  const mismatch = interopRecordSchema.parse({ ...record, original: { ...record.original, mimeType: 'image/jpeg' } });
  const result = await world.importer.acceptOriginal(mismatch, [], 'eligible', imageBytes(), hooks().value);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? '', /media type does not match/u);
  assert.equal(world.photos.get(deterministicInboundPhotoId(record.identity.interopId)), undefined);
  world.db.close();
});

test('a surviving variant of a purged root verifies the shared original under its asset owner (#496)', async () => {
  const world = await harness();
  const first = availableRecord();
  await world.importer.acceptOriginal(first, [], 'eligible', imageBytes(), hooks().value);
  const rootId = deterministicInboundPhotoId(first.identity.interopId);
  const root = world.photos.get(rootId);
  assert.ok(root);
  const variantId = '01J8VRNT0000000000000000V1';
  new VariantRepository(world.db).duplicate(root, variantId, '2026-07-21T18:05:00.000Z');
  world.photos.softDelete([rootId]);
  world.photos.purgeRow(rootId);
  const duplicate = interopRecordSchema.parse({
    ...first,
    identity: {
      ...first.identity,
      interopId: '5f2c7a90-3b1e-4d2a-9c8e-7a6b5c4d3e2f',
      origin: { product: 'image-trail', localId: 'bookmark-variant' },
    },
  });
  const linked = await world.importer.acceptOriginal(duplicate, [], 'duplicate', imageBytes(), hooks().value);
  assert.equal(linked.accepted, true, linked.reason ?? '');
  assert.equal(linked.targetLocalId, variantId);
  world.db.close();
});

test('links verified native duplicates and metadata-only records without fabricating photos', async () => {
  const world = await harness();
  const first = availableRecord();
  await world.importer.acceptOriginal(first, [], 'eligible', imageBytes(), hooks().value);
  const duplicate = interopRecordSchema.parse({
    ...first,
    identity: {
      ...first.identity,
      interopId: '4414e2b1-1ca1-4448-a890-5a4976593e33',
      origin: { product: 'image-trail', localId: 'bookmark-duplicate' },
    },
  });
  const linked = await world.importer.acceptOriginal(duplicate, [], 'duplicate', imageBytes(), hooks().value);
  assert.equal(linked.targetLocalId, deterministicInboundPhotoId(first.identity.interopId));
  assert.equal(world.interop.getRecord(duplicate.identity.interopId)?.localPhotoId, linked.targetLocalId);

  const metadataBase = fixtureRecord();
  const metadata = interopRecordSchema.parse({
    ...metadataBase,
    identity: {
      ...metadataBase.identity,
      interopId: '45f8e56c-c1a3-4d8b-b94a-3a5c72e52733',
      origin: { product: 'image-trail', localId: 'bookmark-metadata-only' },
    },
  });
  const copied = world.importer.acceptWithoutOriginal(metadata, [], 'metadata-only', hooks().value);
  assert.equal(copied.accepted, true);
  assert.match(copied.reason ?? '', /source original was retained/u);
  assert.equal(world.interop.getRecord(metadata.identity.interopId)?.localPhotoId, null);
  assert.equal(world.photos.get(deterministicInboundPhotoId(metadata.identity.interopId)), undefined);
  world.db.close();
});

test('retains a locally classified conflict even when its bytes match native custody', async () => {
  const world = await harness();
  const first = availableRecord();
  await world.importer.acceptOriginal(first, [], 'eligible', imageBytes(), hooks().value);
  const conflictBase = availableRecord();
  const conflict = interopRecordSchema.parse({
    ...conflictBase,
    identity: {
      ...conflictBase.identity,
      interopId: '19618411-4c0c-4a41-8750-840c95169b4a',
      origin: { product: 'image-trail', localId: 'bookmark-conflict' },
    },
  });
  const retained = await world.importer.acceptOriginal(conflict, [], 'conflict', imageBytes(), hooks().value);
  assert.equal(retained.accepted, false);
  assert.equal(retained.reviewCategory, 'conflict');
  assert.equal(world.interop.getRecord(conflict.identity.interopId), undefined);
  world.db.close();
});

test('database failure rolls back photo and ledger while leaving the verified blob resumable', async () => {
  const baseline = await harness();
  const failing = new InboundPhotoImporter({
    db: baseline.db,
    photos: baseline.photos,
    blobs: baseline.blobs,
    currentKey: () => KEY,
    resolveKey: RESOLVE,
    thumbnails: { generateFor: () => Promise.resolve({ generated: false, width: null, height: null }) },
    now: () => '2026-07-21T18:00:00.000Z',
    metadata: () => Promise.resolve(EMPTY_METADATA),
    interop: {
      putRecord: () => {
        throw new Error('injected interop link failure');
      },
      putAlbum: () => undefined,
    },
  });
  const record = availableRecord();
  await assert.rejects(failing.acceptOriginal(record, [], 'eligible', imageBytes(), hooks().value), /injected interop link failure/u);
  const photoId = deterministicInboundPhotoId(record.identity.interopId);
  assert.equal(baseline.photos.get(photoId), undefined);
  assert.equal(await baseline.blobs.verifyOriginal(record.identity.contentHash ?? '', RESOLVE, photoId), true);
  baseline.db.close();
});
