import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { ProvenanceRepository } from '../../src/main/db/provenance-repository.js';
import { run } from '../../src/main/db/sql.js';
import { ProvenanceService } from '../../src/main/library/provenance-service.js';
import { PROVENANCE_EVALUATOR, buildProvenanceEvidence, type ProvenanceSource } from '../../src/shared/library/provenance.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #495 / ADR-0031 §5: evaluation is lazy, local, and bound to the subject
// bytes. A fresh record is returned without touching the original; a stale
// one (bytes or evaluator changed) is re-evaluated; an offloaded original
// defers honestly instead of inventing Unknown; Re-check always re-evaluates.

const HASH_A = 'a'.repeat(64);
const AT = '2026-09-02T10:00:00.000Z';

function photo(id: string, contentHash: string): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 42,
    contentHash,
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
    importedAt: '2026-07-14T21:00:00.000Z',
    importSource: 'camera',
    keyId: 1,
  };
}

interface Harness {
  readonly db: ReturnType<typeof openLibraryDatabase>;
  readonly service: ProvenanceService;
  readonly provenance: ProvenanceRepository;
  readonly repo: PhotosRepository;
  readonly calls: { loads: number; extracts: number; changed: string[] };
  original: Buffer | null;
  sources: ProvenanceSource[];
  sidecars: Buffer[];
}

function harness(): Harness {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-provenance-service-')), 'library.db'),
    dbKey: Buffer.alloc(32, 5),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-14T20:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  repo.insert(photo('P1', HASH_A));
  const provenance = new ProvenanceRepository(db);
  const calls = { loads: 0, extracts: 0, changed: [] as string[] };
  let clock = 0;
  const state: Harness = {
    db,
    provenance,
    repo,
    calls,
    original: Buffer.from('original bytes'),
    sources: [],
    sidecars: [],
    service: new ProvenanceService({
      repo,
      provenance,
      loadOriginal: () => {
        calls.loads += 1;
        return Promise.resolve(state.original === null ? null : Buffer.from(state.original));
      },
      loadSidecarXmp: () => Promise.resolve(state.sidecars.map((sidecar) => Buffer.from(sidecar))),
      extract: (bytes, sidecars) => {
        calls.extracts += 1;
        assert.ok(bytes.length > 0);
        assert.equal(sidecars.length, state.sidecars.length);
        return Promise.resolve(state.sources);
      },
      now: () => {
        clock += 1;
        return `2026-09-02T10:00:${String(clock).padStart(2, '0')}.000Z`;
      },
      changed: (photoId) => calls.changed.push(photoId),
    }),
  };
  return state;
}

describe('provenance service (#495)', () => {
  test('first read evaluates locally, stores the record, and owes a manifest; the next read is served from the store', async () => {
    const h = harness();
    h.sources = [{ kind: 'declaration', origin: 'exif', field: 'Software', value: 'Midjourney', claim: 'generated' }];
    const first = await h.service.get('P1');
    assert.equal(first.status, 'evaluated');
    assert.equal(first.stale, false);
    assert.equal(first.evidence?.tier, 'declared');
    assert.equal(first.evidence?.subjectHash, HASH_A);
    assert.equal(first.evidence?.evaluator, PROVENANCE_EVALUATOR);
    assert.equal(first.evidence?.network, false);
    assert.deepEqual(h.calls, { loads: 1, extracts: 1, changed: ['P1'] });
    const second = await h.service.get('P1');
    assert.deepEqual(second, first);
    assert.equal(h.calls.loads, 1);
    assert.deepEqual(h.service.current('P1'), first);
  });

  test('a record for other bytes or an older evaluator is stale and re-evaluated on read', async () => {
    const h = harness();
    h.provenance.put('P1', buildProvenanceEvidence({ subjectHash: 'b'.repeat(64), evaluatedAt: AT, sources: [] }));
    assert.equal(h.service.current('P1').stale, true);
    const payload = await h.service.get('P1');
    assert.equal(payload.stale, false);
    assert.equal(payload.evidence?.subjectHash, HASH_A);
    assert.equal(h.calls.extracts, 1);

    const old = { ...buildProvenanceEvidence({ subjectHash: HASH_A, evaluatedAt: AT, sources: [] }), evaluator: 'overlook-provenance/0' };
    h.provenance.put('P1', old);
    assert.equal(h.service.current('P1').stale, true);
    await h.service.get('P1');
    assert.equal(h.provenance.get('P1')?.evidence?.evaluator, PROVENANCE_EVALUATOR);
  });

  test('an offloaded original defers: the stale record stays visible and nothing is invented', async () => {
    const h = harness();
    h.provenance.put('P1', buildProvenanceEvidence({ subjectHash: 'b'.repeat(64), evaluatedAt: AT, sources: [] }));
    h.original = null;
    const payload = await h.service.get('P1');
    assert.equal(payload.status, 'deferred');
    assert.equal(payload.stale, true);
    assert.equal(payload.evidence?.subjectHash, 'b'.repeat(64));
    assert.equal(h.calls.extracts, 0);
    assert.deepEqual(h.calls.changed, []);
    run(h.db, 'DELETE FROM photo_provenance');
    const empty = await h.service.get('P1');
    assert.equal(empty.status, 'deferred');
    assert.equal(empty.evidence, null);
  });

  test('refresh re-evaluates unconditionally and passes sidecars to the extractor', async () => {
    const h = harness();
    await h.service.get('P1');
    h.sidecars = [Buffer.from('<x:xmpmeta/>')];
    h.sources = [{ kind: 'declaration', origin: 'xmp-sidecar', field: 'xmp:CreatorTool', value: 'DALL·E', claim: 'generated' }];
    const payload = await h.service.refresh('P1');
    assert.equal(h.calls.extracts, 2);
    assert.equal(payload.evidence?.sources[0]?.kind, 'declaration');
    assert.equal(payload.evidence?.tier, 'declared');
  });

  test('a newer stored format is shown as unsupported and is not overwritten by a read', async () => {
    const h = harness();
    h.provenance.restore([
      {
        photoId: 'P1',
        subjectHash: HASH_A,
        evaluator: 'future',
        evaluatedAt: AT,
        tier: 'verified',
        document: { version: 3, subjectHash: HASH_A },
      },
    ]);
    const payload = await h.service.get('P1');
    assert.equal(payload.evidence, null);
    assert.match(payload.unsupported ?? '', /newer/u);
    assert.equal(h.calls.extracts, 0);
    // Re-check must not let a downgraded build replace forward-compatible evidence.
    const refreshed = await h.service.refresh('P1');
    assert.equal(refreshed.evidence, null);
    assert.match(refreshed.unsupported ?? '', /newer/u);
    assert.equal(h.calls.extracts, 0);
    assert.equal(h.provenance.get('P1')?.evaluator, 'future');
  });

  test('an unknown photo is an error', async () => {
    const h = harness();
    await assert.rejects(h.service.get('nope'), /not found/u);
  });
});
