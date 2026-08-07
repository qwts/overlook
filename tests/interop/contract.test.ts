import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import path from 'node:path';

import {
  INTEROP_CONTRACT_VERSION,
  INTEROP_MAGIC,
  interopConflictActionSchema,
  interopHeaderSchema,
  interopIdentitySchema,
  interopReviewCategorySchema,
  type InteropConflictAction,
  type InteropErrorCode,
  type InteropFieldRevisions,
  type InteropIdentity,
  type InteropOperation,
  type InteropReviewCategory,
  type InteropTransferPhase,
} from '../../src/shared/interop/contract.js';
import {
  interopEnvelopeSchema,
  type InteropCounts,
  type InteropEnvelope,
  type InteropError,
  type InteropPayload,
} from '../../src/shared/interop/messages.js';
import { createInteropJsonSchemas } from '../../src/shared/interop/json-schema.js';
import { interopPairingPayloadSchema, type InteropPairingPayload } from '../../src/shared/interop/pairing-contract.js';
import { type InteropAlbum, type InteropBlobReference, type InteropRecord } from '../../src/shared/interop/records.js';
import { InteropReplayError, InteropReplayGuard, interopReplayIdentity } from '../../src/shared/interop/replay.js';
import { compareInteropRevisions, incrementInteropRevision, mergeInteropRevisions } from '../../src/shared/interop/revisions.js';
import {
  GOOGLE_DRIVE_DISCOVERY_PROTOCOL,
  INTEROP_GOOGLE_DRIVE_OWNER,
  INTEROP_PROVIDER_LIBRARY_ID,
  INTEROP_PROVIDER_LOGICAL_ROOT,
  INTEROP_PROVIDER_ROOT_NAME,
} from '../../src/main/interop/transport.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`design/handoff/contracts/v1/fixtures/${name}`, 'utf8')) as unknown;
}

const contractDirectory = 'design/handoff/contracts/v1';

const header = {
  magic: INTEROP_MAGIC,
  contractVersion: INTEROP_CONTRACT_VERSION,
  messageId: '8959e5cc-391f-4330-9563-60f70bd0119d',
  transferId: '8c42634d-d602-46ee-ac5b-20186fbd51e0',
  pairingId: 'a3267e90-2bd1-432c-bc8b-78e4704f843f',
  sourceProduct: 'image-trail',
  targetProduct: 'overlook',
  operation: 'move',
  kind: 'manifest',
  createdAt: '2026-07-16T10:00:00.000Z',
  sequence: 0,
} as const;

describe('interoperability contract primitives', () => {
  test('accepts a cross-product version-one header and rejects same-product or future-version messages', () => {
    assert.deepEqual(interopHeaderSchema.parse(header), header);
    assert.equal(interopHeaderSchema.safeParse({ ...header, targetProduct: 'image-trail' }).success, false);
    assert.equal(interopHeaderSchema.safeParse({ ...header, contractVersion: 2 }).success, false);
    assert.equal(interopHeaderSchema.safeParse({ ...header, unknown: true }).success, false);
  });

  test('requires identity rather than accepting filename-only deduplication', () => {
    const identity = {
      interopId: '4d220c3e-16bd-4833-891c-3ef9b980b3fb',
      origin: { product: 'overlook', localId: '01JPHOTORECORD' },
      contentHash: 'a'.repeat(64),
    } as const;
    assert.deepEqual(interopIdentitySchema.parse(identity), identity);
    assert.equal(interopIdentitySchema.safeParse({ fileName: 'duplicate.jpg' }).success, false);
    assert.equal(interopIdentitySchema.safeParse({ ...identity, contentHash: 'duplicate.jpg' }).success, false);
  });

  test('publishes the exact shared review and conflict vocabulary', () => {
    assert.deepEqual(interopReviewCategorySchema.options, ['eligible', 'duplicate', 'conflict', 'metadata-only', 'unsupported', 'skipped']);
    assert.deepEqual(interopConflictActionSchema.options, ['keep-image-trail', 'keep-overlook', 'keep-both']);
  });

  test('parses the canonical record fixture and rejects the future-version fixture', () => {
    const parsed = interopEnvelopeSchema.parse(fixture('valid-record-message.json'));
    assert.equal(parsed.payload.kind, 'record');
    assert.equal(parsed.payload.kind === 'record' && parsed.payload.record.original.state, 'metadata-only');
    assert.equal(interopEnvelopeSchema.safeParse(fixture('rejected-future-version.json')).success, false);
  });

  test('rejects a mismatched header/payload kind and unsafe blob transport paths', () => {
    const valid = fixture('valid-record-message.json');
    assert.equal(
      interopEnvelopeSchema.safeParse({
        ...(valid as object),
        header: { ...(valid as { header: object }).header, kind: 'manifest' },
      }).success,
      false,
    );
    const blobMessage = {
      ...(valid as { header: object; payload: object }),
      header: { ...(valid as { header: object }).header, kind: 'blob' },
      payload: {
        kind: 'blob',
        schemaVersion: 1,
        recordInteropId: '4d220c3e-16bd-4833-891c-3ef9b980b3fb',
        role: 'original',
        blob: {
          state: 'available',
          blobId: 'original-123',
          mimeType: 'image/jpeg',
          byteLength: 42,
          contentHash: 'c'.repeat(64),
        },
        encryptedPath: '../backup/original.bin',
        chunkIndex: 0,
        chunkCount: 1,
      },
    };
    assert.equal(interopEnvelopeSchema.safeParse(blobMessage).success, false);
  });

  test('rejects the golden invalid fixture and preserves round-trip metadata exactly', () => {
    assert.equal(interopEnvelopeSchema.safeParse(fixture('invalid-record-message.json')).success, false);
    const roundTripFixture = fixture('round-trip-record-message.json');
    const parsed = interopEnvelopeSchema.parse(roundTripFixture);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), roundTripFixture);
    assert.equal(parsed.payload.kind === 'record' && parsed.payload.record.roundTripMetadata.overlook['rating'], 4);
  });

  test('publishes the canonical TypeScript contract surface', () => {
    const envelope: InteropEnvelope = interopEnvelopeSchema.parse(fixture('valid-record-message.json'));
    assert.equal(envelope.payload.kind, 'record');
    if (envelope.payload.kind !== 'record') return;
    const payload: InteropPayload = envelope.payload;
    const record: InteropRecord = envelope.payload.record;
    const album: InteropAlbum = envelope.payload.albums[0] as InteropAlbum;
    const blob: InteropBlobReference = record.original;
    const identity: InteropIdentity = record.identity;
    const fieldRevisions: InteropFieldRevisions = record.fieldRevisions;
    const operation: InteropOperation = envelope.header.operation;
    const reviewCategory: InteropReviewCategory = envelope.payload.reviewCategory;
    const conflictAction: InteropConflictAction = 'keep-both';
    const phase: InteropTransferPhase = 'reviewing';
    const errorCode: InteropErrorCode = 'replay';
    const counts: InteropCounts = {
      total: 1,
      eligible: 1,
      duplicate: 0,
      conflict: 0,
      metadataOnly: 0,
      unsupported: 0,
      skipped: 0,
      failed: 0,
      acknowledged: 0,
      finalized: 0,
    };
    const error: InteropError = {
      code: errorCode,
      message: 'Duplicate message',
      retryable: false,
      recordInteropId: identity.interopId,
    };
    const pairingPayload: InteropPairingPayload = interopPairingPayloadSchema.parse({
      schemaVersion: 1,
      pairingId: envelope.header.pairingId,
      keyId: 'interop:0de6557b-a17d-4e36-99f0-c20e64f021de',
      interopKey: Buffer.alloc(32, 7).toString('base64'),
      products: ['image-trail', 'overlook'],
      createdAt: envelope.header.createdAt,
    });

    assert.deepEqual(
      {
        payloadKind: payload.kind,
        recordId: record.identity.interopId,
        albumId: album.interopId,
        blobState: blob.state,
        identity,
        fieldRevisions,
        operation,
        reviewCategory,
        conflictAction,
        phase,
        counts,
        error,
        pairingId: pairingPayload.pairingId,
      },
      {
        payloadKind: 'record',
        recordId: identity.interopId,
        albumId: '50ca91c1-a9c7-4c98-9ab4-b075cb600424',
        blobState: 'metadata-only',
        identity,
        fieldRevisions,
        operation: 'move',
        reviewCategory: 'metadata-only',
        conflictAction: 'keep-both',
        phase: 'reviewing',
        counts,
        error,
        pairingId: envelope.header.pairingId,
      },
    );
  });
});

describe('interoperability replay identity', () => {
  test('rejects a duplicated message identity within one pairing', () => {
    const replay = fixture('replay-message.json') as { first: typeof header; replay: typeof header };
    assert.equal(interopReplayIdentity(replay.first), interopReplayIdentity(replay.replay));
    const guard = new InteropReplayGuard();
    guard.observe(replay.first);
    assert.throws(() => guard.observe(replay.replay), InteropReplayError);
  });

  test('does not collide when the same message ID belongs to a different pairing', () => {
    const guard = new InteropReplayGuard();
    guard.observe(header);
    guard.observe({ ...header, pairingId: 'fe6ef9a7-57af-460e-8525-fad45cc79afd' });
  });
});

describe('published interoperability artifacts', () => {
  test('maps every companion epic scenario to current cross-repository evidence', () => {
    const output = execFileSync(process.execPath, ['scripts/check-interop-acceptance.mjs'], { encoding: 'utf8' });
    assert.equal(output, 'Verified 10 interop scenarios with 40 automated evidence references; manual 0/4.\n');
  });

  test('refuses companion evidence from a checkout that is not pinned to the reviewed revision', () => {
    const result = spawnSync(process.execPath, ['scripts/check-interop-acceptance.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, INTEROP_IMAGE_TRAIL_ROOT: process.cwd() },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence checkout must be pinned/u);
  });

  test('matches the generated Draft 2020-12 schemas byte-for-byte', () => {
    for (const [fileName, schema] of Object.entries(createInteropJsonSchemas())) {
      assert.equal(readFileSync(path.join(contractDirectory, fileName), 'utf8'), `${JSON.stringify(schema, null, 2)}\n`);
    }
  });

  test('checksums every published schema and golden fixture', () => {
    const lines = readFileSync(path.join(contractDirectory, 'SHA256SUMS'), 'utf8').trim().split('\n');
    const coveredPaths = new Set<string>();
    for (const line of lines) {
      const match = /^(?<hash>[a-f0-9]{64}) {2}(?<relativePath>.+)$/u.exec(line);
      assert.ok(match?.groups);
      const relativePath = match.groups['relativePath'] ?? '';
      const contents = readFileSync(path.join(contractDirectory, relativePath));
      assert.equal(createHash('sha256').update(contents).digest('hex'), match.groups['hash']);
      coveredPaths.add(relativePath);
    }
    for (const schemaFile of Object.keys(createInteropJsonSchemas())) assert.ok(coveredPaths.has(schemaFile));
    assert.ok(coveredPaths.has('acceptance-evidence.json'));
    assert.ok(coveredPaths.has('provider-root.json'));
    for (const fixtureName of [
      'corrupt-pairing-bundle.json',
      'invalid-record-message.json',
      'rejected-future-version.json',
      'replay-message.json',
      'round-trip-record-message.json',
      'sealed-transport.json',
      'valid-pairing-bundle.json',
      'valid-record-message.json',
    ]) {
      assert.ok(coveredPaths.has(path.join('fixtures', fixtureName)));
    }
    assert.ok(coveredPaths.has('sealed-blob.md'));
  });

  test('pins the provider-relative root consumed by every interop adapter', () => {
    const providerRoot = JSON.parse(readFileSync(path.join(contractDirectory, 'provider-root.json'), 'utf8')) as unknown;
    assert.deepEqual(providerRoot, {
      schemaVersion: 1,
      pathSemantics: 'provider-relative',
      rootName: INTEROP_PROVIDER_ROOT_NAME,
      libraryId: INTEROP_PROVIDER_LIBRARY_ID,
      logicalPath: INTEROP_PROVIDER_LOGICAL_ROOT,
      googleDriveOwner: INTEROP_GOOGLE_DRIVE_OWNER,
      googleDriveDiscovery: GOOGLE_DRIVE_DISCOVERY_PROTOCOL,
    });
  });

  test('uses a password-derived wrapping key distinct from the random interoperability key', () => {
    const bundle = fixture('valid-pairing-bundle.json') as {
      kdf: { salt: string; iterations: number };
      cipher: { ciphertext: string };
    };
    const wrappingKey = pbkdf2Sync('fixture-password', Buffer.from(bundle.kdf.salt, 'base64'), bundle.kdf.iterations, 32, 'sha256');
    const interopKey = Buffer.from([...Array.from({ length: 32 }, (_value, index) => index + 32)]);
    try {
      assert.notDeepEqual(wrappingKey, interopKey);
      assert.equal(bundle.cipher.ciphertext.includes(interopKey.toString('base64')), false);
      assert.equal(JSON.stringify(bundle).includes('interopKey'), false);
    } finally {
      wrappingKey.fill(0);
      interopKey.fill(0);
    }
  });
});

describe('interoperability revision vectors', () => {
  test('distinguishes ordered, equal, and concurrent revisions', () => {
    assert.equal(compareInteropRevisions({ imageTrail: 1, overlook: 2 }, { imageTrail: 1, overlook: 2 }), 'equal');
    assert.equal(compareInteropRevisions({ imageTrail: 1, overlook: 2 }, { imageTrail: 2, overlook: 2 }), 'before');
    assert.equal(compareInteropRevisions({ imageTrail: 3, overlook: 2 }, { imageTrail: 2, overlook: 2 }), 'after');
    assert.equal(compareInteropRevisions({ imageTrail: 3, overlook: 1 }, { imageTrail: 2, overlook: 2 }), 'concurrent');
  });

  test('increments one actor without mutating the input and merges by component maximum', () => {
    const initial = { imageTrail: 4, overlook: 7 };
    assert.deepEqual(incrementInteropRevision(initial, 'image-trail'), { imageTrail: 5, overlook: 7 });
    assert.deepEqual(incrementInteropRevision(initial, 'overlook'), { imageTrail: 4, overlook: 8 });
    assert.deepEqual(initial, { imageTrail: 4, overlook: 7 });
    assert.deepEqual(mergeInteropRevisions({ imageTrail: 5, overlook: 3 }, { imageTrail: 2, overlook: 8 }), {
      imageTrail: 5,
      overlook: 8,
    });
  });
});
