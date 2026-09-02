import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { FingerprintCandidate, FingerprintDeferralReason, FingerprintIndexStatus } from '../../src/main/db/fingerprint-repository.js';
import { DuplicateIndexService, type FingerprintStore } from '../../src/main/library/duplicate-index-service.js';
import { FingerprintDecodeError } from '../../src/main/library/perceptual-fingerprint.js';
import type { FingerprintEntry } from '../../src/shared/library/duplicate-groups.js';
import { FINGERPRINT_VERSION } from '../../src/shared/library/perceptual-hash.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

// #650 index service over an in-memory store: one sequential pass that
// resumes from the pending cursor, defers honestly, stops on close, and a
// derived review that is cached until the index, the library or the #482
// classification changes.

const SAME = ['0000000000000000', 'ffffffffffffffff', 'ffffffffffffffff', 'ffffffffffffffff'];

interface Row {
  candidate: FingerprintCandidate;
  version: string;
  rotations: readonly string[] | null;
  reason: FingerprintDeferralReason | null;
}

class MemoryStore implements FingerprintStore {
  readonly rows = new Map<string, Row>();
  readonly photos = new Map<string, { candidate: FingerprintCandidate; isOriginal: boolean; variantSourceId: string | null }>();

  add(photoId: string, overrides: { isOriginal?: boolean; variantSourceId?: string | null; contentHash?: string } = {}): void {
    this.photos.set(photoId, {
      candidate: { photoId, contentHash: overrides.contentHash ?? `hash-${photoId}`, derivativeKey: `key-${photoId}` },
      isOriginal: overrides.isOriginal ?? false,
      variantSourceId: overrides.variantSourceId ?? null,
    });
  }

  private fresh(photoId: string, version: string): Row | undefined {
    const row = this.rows.get(photoId);
    const photo = this.photos.get(photoId);
    if (row === undefined || photo === undefined) return undefined;
    return row.version === version && row.candidate.contentHash === photo.candidate.contentHash ? row : undefined;
  }

  pending(version: string, limit: number): readonly FingerprintCandidate[] {
    return [...this.photos.values()]
      .filter(({ candidate }) => this.fresh(candidate.photoId, version) === undefined)
      .slice(0, limit)
      .map(({ candidate }) => candidate);
  }

  status(version: string): FingerprintIndexStatus {
    const ids = [...this.photos.keys()];
    const indexed = ids.filter((id) => this.fresh(id, version)?.rotations !== null && this.fresh(id, version) !== undefined).length;
    const deferred = ids.filter((id) => this.fresh(id, version)?.reason !== null && this.fresh(id, version) !== undefined).length;
    return { total: ids.length, indexed, deferred, pending: ids.length - indexed - deferred };
  }

  entries(version: string): readonly FingerprintEntry[] {
    return [...this.photos.values()].flatMap((photo) => {
      const row = this.fresh(photo.candidate.photoId, version);
      if (row?.rotations === null || row === undefined) return [];
      return [
        {
          photoId: photo.candidate.photoId,
          contentHash: photo.candidate.contentHash,
          variantSourceId: photo.variantSourceId,
          isOriginal: photo.isOriginal,
          rotations: row.rotations,
        },
      ];
    });
  }

  put(candidate: FingerprintCandidate, version: string, rotations: readonly string[]): boolean {
    if (this.photos.get(candidate.photoId)?.candidate.contentHash !== candidate.contentHash) return false;
    this.rows.set(candidate.photoId, { candidate, version, rotations, reason: null });
    return true;
  }

  defer(candidate: FingerprintCandidate, version: string, reason: FingerprintDeferralReason): boolean {
    this.rows.set(candidate.photoId, { candidate, version, rotations: null, reason });
    return true;
  }

  invalidate(photoIds: readonly string[]): number {
    let removed = 0;
    for (const id of photoIds) if (this.rows.delete(id)) removed += 1;
    return removed;
  }

  invalidateAll(): number {
    const removed = this.rows.size;
    this.rows.clear();
    return removed;
  }

  deleteOtherVersions(version: string): number {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.version !== version) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

function record(id: string): PhotoRecord {
  return { id, fileName: `${id}.jpg`, isOriginal: false } as PhotoRecord;
}

function harness(
  overrides: Partial<ConstructorParameters<typeof DuplicateIndexService>[0]> & { readonly bytes?: (id: string) => Buffer | null } = {},
) {
  const store = new MemoryStore();
  const loads: string[] = [];
  const notified: FingerprintIndexStatus[] = [];
  const load =
    overrides.load ??
    ((candidate: FingerprintCandidate) =>
      Promise.resolve(overrides.bytes === undefined ? Buffer.from([1]) : overrides.bytes(candidate.photoId)));
  const service = new DuplicateIndexService({
    repository: store,
    fingerprint: () => Promise.resolve(SAME),
    records: (ids) => ids.map(record),
    changed: (status) => {
      notified.push(status);
    },
    notifyEvery: 2,
    yieldTurn: () => Promise.resolve(),
    ...overrides,
    load: (candidate, signal) => {
      loads.push(candidate.photoId);
      return load(candidate, signal);
    },
  });
  return { store, service, loads, notified };
}

async function settle(): Promise<void> {
  // The pass yields per candidate; a few macrotask turns let it drain.
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('duplicate index service (#650)', () => {
  test('one pass fingerprints every pending photo, notifies progress, and the review groups the matches', async () => {
    const { store, service, loads, notified } = harness();
    store.add('P1');
    store.add('P2');
    store.add('P3');
    service.schedule();
    await settle();
    assert.deepEqual(loads, ['P1', 'P2', 'P3']);
    assert.deepEqual(service.status(), { total: 3, indexed: 3, deferred: 0, pending: 0 });
    assert.ok(notified.length >= 2, 'progress every N rows plus the final status');
    assert.deepEqual(notified.at(-1), { total: 3, indexed: 3, deferred: 0, pending: 0 });
    const review = service.review();
    assert.equal(review.version, FINGERPRINT_VERSION);
    assert.deepEqual(
      review.groups.map((group) => group.photoIds),
      [['P1', 'P2', 'P3']],
    );
    assert.deepEqual(
      service.reviewWithPhotos().groups[0]?.photos.map((photo) => photo.fileName),
      ['P1.jpg', 'P2.jpg', 'P3.jpg'],
    );
    assert.equal(service.review(), review, 'cached until something changes');
    await service.close();
  });

  test('a missing derivative and undecodable bytes are deferred with their reason; the pass keeps moving', async () => {
    const { store, service } = harness({
      bytes: (id) => (id === 'P2' ? null : Buffer.from([1])),
      fingerprint: (bytes) => (bytes.length === 1 ? Promise.resolve(SAME) : Promise.reject(new FingerprintDecodeError('nope'))),
    });
    store.add('P1');
    store.add('P2');
    store.add('P3');
    service.schedule();
    await settle();
    assert.equal(store.rows.get('P2')?.reason, 'derivative-unavailable');
    assert.deepEqual(service.status(), { total: 3, indexed: 2, deferred: 1, pending: 0 });
    const { store: other, service: corrupt } = harness({
      bytes: () => Buffer.from([1, 2]),
      fingerprint: () => Promise.reject(new FingerprintDecodeError('nope')),
    });
    other.add('P9');
    corrupt.schedule();
    await settle();
    assert.equal(other.rows.get('P9')?.reason, 'undecodable');
    await service.close();
    await corrupt.close();
  });

  test('eligibility changes re-index exactly the named photos and drop the cached review', async () => {
    const { store, service, loads } = harness();
    store.add('P1');
    store.add('P2');
    service.schedule();
    await settle();
    const before = service.review();
    service.notifyEligibilityChanged(['P2']);
    await settle();
    assert.deepEqual(loads, ['P1', 'P2', 'P2']);
    assert.notEqual(service.review(), before);
    await service.close();
  });

  test('an Original marker change (#482) invalidates the answer without touching the index', async () => {
    const { store, service, loads } = harness();
    store.add('P1');
    store.add('P2');
    service.schedule();
    await settle();
    assert.equal(service.review().groups.length, 1);
    const photo = store.photos.get('P1');
    assert.ok(photo !== undefined);
    photo.isOriginal = true;
    assert.equal(service.review().groups.length, 1, 'still the cached answer');
    service.notifyClassificationChanged(['P1']);
    assert.equal(service.review().groups.length, 0, 'the pair is no longer eligible');
    await settle();
    assert.deepEqual(loads, ['P1', 'P2'], 'no re-indexing was owed');
    await service.close();
  });

  test('close stops the pass mid-way and a fresh service resumes from the cursor', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loads: string[] = [];
    const { store, service } = harness({
      load: async (candidate) => {
        loads.push(candidate.photoId);
        if (candidate.photoId === 'P2') await gate;
        return Buffer.from([1]);
      },
    });
    store.add('P1');
    store.add('P2');
    store.add('P3');
    service.schedule();
    await settle();
    const closing = service.close();
    release?.();
    await closing;
    assert.deepEqual(loads, ['P1', 'P2']);
    assert.ok(store.rows.has('P1'));
    assert.ok(!store.rows.has('P2'), 'a result arriving after close is not stored');
    service.schedule();
    await settle();
    assert.deepEqual(loads, ['P1', 'P2'], 'a closed service never restarts');
    const resumed = new DuplicateIndexService({
      repository: store,
      load: (candidate) => {
        loads.push(candidate.photoId);
        return Promise.resolve(Buffer.from([1]));
      },
      fingerprint: () => Promise.resolve(SAME),
      records: (ids) => ids.map(record),
      yieldTurn: () => Promise.resolve(),
    });
    resumed.schedule();
    await settle();
    assert.deepEqual(loads, ['P1', 'P2', 'P2', 'P3']);
    await resumed.close();
  });

  test('rescan drops every row, deferred ones included, and starts over; a stale candidate is skipped without a row', async () => {
    const { store, service, loads } = harness({ bytes: (id) => (id === 'P0' ? null : Buffer.from([1])) });
    store.add('P1');
    store.add('P0');
    service.schedule();
    await settle();
    assert.equal(store.rows.get('P0')?.reason, 'derivative-unavailable');
    const status = service.rescan();
    assert.equal(status.pending, 2, 'a deferred row is dropped and retried like a hashed one');
    await settle();
    assert.deepEqual(loads, ['P1', 'P0', 'P1', 'P0']);
    // The photo moved under the indexer: the first put refuses the stale
    // candidate, the cursor re-reads the row, the second put stores it.
    let moved = false;
    const stale = harness({
      load: (candidate) => {
        const photo = stale.store.photos.get('P2');
        if (photo !== undefined && !moved) {
          moved = true;
          photo.candidate = { ...candidate, contentHash: 'moved' };
        }
        return Promise.resolve(Buffer.from([1]));
      },
    });
    stale.store.add('P2');
    stale.service.schedule();
    await settle();
    assert.deepEqual(stale.loads, ['P2', 'P2']);
    assert.equal(stale.store.rows.get('P2')?.candidate.contentHash, 'moved');
    await service.close();
    await stale.service.close();
  });
});
