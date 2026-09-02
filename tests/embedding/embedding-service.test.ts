import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EmbeddingCandidateStaleError, EMBEDDING_DIMENSIONS, type EmbeddingCandidate } from '../../src/main/db/embedding-repository.js';
import { EmbeddingPoolBusyError } from '../../src/main/embedding/embedding-pool.js';
import { EmbeddingService, type EmbeddingStatus } from '../../src/main/embedding/embedding-service.js';

const CANDIDATES: readonly EmbeddingCandidate[] = [
  { photoId: 'P-1', contentHash: '1'.repeat(64), derivativeKey: '1'.repeat(64) },
  { photoId: 'P-2', contentHash: '2'.repeat(64), derivativeKey: '2'.repeat(64) },
];

interface ServiceWorld {
  readonly service: EmbeddingService;
  readonly statuses: EmbeddingStatus[];
  readonly embedded: string[];
  readonly statusReads: () => number;
  readonly oldModelPrunes: () => number;
  setAutomaticPause(reason: 'import' | 'backup' | 'battery' | null): void;
}

function world(
  options: {
    readonly candidates?: readonly EmbeddingCandidate[];
    readonly installed?: boolean;
    readonly staleFirstPut?: boolean;
    readonly available?: boolean;
    readonly initiallyEnabled?: boolean;
    readonly initiallyDeferred?: readonly string[];
    readonly downloadProgressEvents?: number;
    readonly load?: (candidate: EmbeddingCandidate) => Promise<Buffer | null>;
    readonly embed?: (candidate: EmbeddingCandidate, signal: AbortSignal) => Promise<Int8Array>;
    readonly embedText?: (text: string, signal: AbortSignal) => Promise<Int8Array>;
  } = {},
): ServiceWorld {
  const candidates = [...(options.candidates ?? CANDIDATES)];
  const completed = new Set<string>();
  const deferred = new Set(options.initiallyDeferred ?? []);
  const embedded: string[] = [];
  const statuses: EmbeddingStatus[] = [];
  let enabled = options.initiallyEnabled ?? false;
  let automaticPause: 'import' | 'backup' | 'battery' | null = null;
  let loaded: EmbeddingCandidate | undefined;
  let staleFirstPut = options.staleFirstPut ?? false;
  let statusReads = 0;
  let oldModelPrunes = 0;
  const service = new EmbeddingService({
    repository: {
      status: () => {
        statusReads += 1;
        const total = candidates.filter((candidate) => !deferred.has(candidate.photoId)).length;
        return {
          total,
          completed: completed.size,
          pending: total - completed.size,
        };
      },
      deleteStale: () => 0,
      deleteOtherModels: () => {
        oldModelPrunes += 1;
        return 0;
      },
      pending: (_modelVersion, limit) =>
        candidates.filter((candidate) => !completed.has(candidate.photoId) && !deferred.has(candidate.photoId)).slice(0, limit),
      put: (candidate) => {
        deferred.delete(candidate.photoId);
        if (staleFirstPut) {
          staleFirstPut = false;
          completed.add(candidate.photoId);
          throw new EmbeddingCandidateStaleError('fixture changed');
        }
        completed.add(candidate.photoId);
        embedded.push(candidate.photoId);
      },
      defer: (candidate) => {
        deferred.add(candidate.photoId);
      },
      clearDeferred: (_modelVersion, photoIds) => {
        const before = deferred.size;
        if (photoIds === undefined) deferred.clear();
        else for (const photoId of photoIds) deferred.delete(photoId);
        return before - deferred.size;
      },
    },
    assets: {
      installed: () => Promise.resolve(options.installed ?? true),
      ensureInstalled: (_consent, progress) => {
        const events = options.downloadProgressEvents ?? 4;
        for (let index = 1; index <= events; index += 1) {
          progress?.({ downloadedBytes: index, totalBytes: events, asset: 'model.onnx' });
        }
        return Promise.resolve();
      },
    },
    enabled: () => enabled,
    setEnabled: (next) => {
      enabled = next;
    },
    pauseReason: () => automaticPause,
    load: (candidate) => {
      loaded = candidate;
      return options.load?.(candidate) ?? Promise.resolve(Buffer.from(candidate.photoId));
    },
    embed: async (_bytes, signal) => {
      const candidate = loaded;
      if (candidate === undefined) throw new Error('fixture candidate was not loaded');
      return options.embed?.(candidate, signal) ?? new Int8Array(EMBEDDING_DIMENSIONS);
    },
    ...(options.embedText === undefined ? {} : { embedText: options.embedText }),
    emit: (status) => statuses.push(status),
    ...(options.available === undefined ? {} : { available: options.available }),
    ...(options.available === false ? { unavailableReason: 'fixture runtime unavailable' } : {}),
    pausePollMs: 1,
  });
  return {
    service,
    statuses,
    embedded,
    statusReads: () => statusReads,
    oldModelPrunes: () => oldModelPrunes,
    setAutomaticPause: (reason) => {
      automaticPause = reason;
      service.notifyWorkAvailable();
    },
  };
}

async function waitFor(world: ServiceWorld, phase: EmbeddingStatus['phase']): Promise<EmbeddingStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = world.service.status();
    if (status.phase === phase) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`embedding service did not reach ${phase}`);
}

describe('EmbeddingService', () => {
  test('an unsupported native target stays disabled without downloading or indexing', async () => {
    const subject = world({ available: false, installed: false });

    assert.deepEqual(subject.service.enable(), {
      phase: 'unavailable',
      pauseReason: null,
      modelVersion: subject.service.status().modelVersion,
      total: 2,
      completed: 0,
      pending: 2,
      downloadedBytes: 0,
      downloadBytes: 0,
      error: 'fixture runtime unavailable',
    });
    assert.deepEqual(subject.embedded, []);
    await subject.service.close();
  });

  test('explicit enable downloads once and indexes the resumable query to completion', async () => {
    const subject = world({ installed: false });

    assert.equal(subject.service.status().phase, 'disabled');
    assert.equal(subject.service.enable().phase, 'downloading');
    assert.deepEqual(await waitFor(subject, 'ready'), {
      phase: 'ready',
      pauseReason: null,
      modelVersion: subject.service.status().modelVersion,
      total: 2,
      completed: 2,
      pending: 0,
      downloadedBytes: 4,
      downloadBytes: 4,
      error: null,
    });
    assert.deepEqual(subject.embedded, ['P-1', 'P-2']);
    await subject.service.close();
  });

  test('download progress is bounded instead of querying full-library status per chunk', async () => {
    const subject = world({ installed: false, downloadProgressEvents: 5_000 });

    subject.service.enable();
    await waitFor(subject, 'ready');

    assert.ok(subject.statusReads() < 30, `download progress performed ${String(subject.statusReads())} status queries`);
    await subject.service.close();
  });

  test('a missing derivative is durably deferred without blocking later photos and repair reactivates it', async () => {
    let firstAvailable = false;
    const subject = world({
      load: (candidate) => {
        if (candidate.photoId === 'P-1' && !firstAvailable) return Promise.resolve(null);
        return Promise.resolve(Buffer.from(candidate.photoId));
      },
    });

    subject.service.enable();
    assert.deepEqual(await waitFor(subject, 'ready'), {
      phase: 'ready',
      pauseReason: null,
      modelVersion: subject.service.status().modelVersion,
      total: 1,
      completed: 1,
      pending: 0,
      downloadedBytes: 0,
      downloadBytes: 0,
      error: null,
    });
    assert.deepEqual(subject.embedded, ['P-2']);

    firstAvailable = true;
    subject.service.notifyEligibilityChanged(['P-1']);
    for (let attempt = 0; attempt < 200 && subject.embedded.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(subject.embedded, ['P-2', 'P-1']);
    assert.equal((await waitFor(subject, 'ready')).total, 2);
    await subject.service.close();
  });

  test('startup preserves durable deferrals until eligibility changes', async () => {
    const subject = world({ initiallyEnabled: true, initiallyDeferred: ['P-1'] });

    subject.service.start();
    await waitFor(subject, 'ready');

    assert.deepEqual(subject.embedded, ['P-2']);
    await subject.service.close();
  });

  test('superseded model rows are pruned only after the current sweep completes', async () => {
    const subject = world();

    subject.service.enable();
    await waitFor(subject, 'ready');

    assert.equal(subject.oldModelPrunes(), 1);
    await subject.service.close();
  });

  test('user pause cancels the in-flight job and resume requeues it', async () => {
    let attempts = 0;
    const subject = world({
      candidates: CANDIDATES.slice(0, 1),
      embed: (_candidate, signal) => {
        attempts += 1;
        if (attempts > 1) return Promise.resolve(new Int8Array(EMBEDDING_DIMENSIONS));
        return new Promise<Int8Array>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
        });
      },
    });

    subject.service.enable();
    await waitFor(subject, 'indexing');
    assert.equal(subject.service.pause().pauseReason, 'user');
    assert.equal((await waitFor(subject, 'paused')).pending, 1);
    subject.service.resume();
    await waitFor(subject, 'ready');
    assert.equal(attempts, 2);
    assert.deepEqual(subject.embedded, ['P-1']);
    await subject.service.close();
  });

  test('automatic work and battery pauses retain the queue until the constraint clears', async () => {
    const subject = world({ candidates: CANDIDATES.slice(0, 1) });
    subject.setAutomaticPause('import');
    subject.service.enable();

    const paused = await waitFor(subject, 'paused');
    assert.equal(paused.pauseReason, 'import');
    assert.deepEqual(subject.embedded, []);
    subject.setAutomaticPause(null);
    await waitFor(subject, 'ready');
    assert.deepEqual(subject.embedded, ['P-1']);
    await subject.service.close();
  });

  test('a candidate changed during inference is skipped instead of poisoning the sweep', async () => {
    const subject = world({ staleFirstPut: true });
    subject.service.enable();

    const ready = await waitFor(subject, 'ready');
    assert.equal(ready.error, null);
    assert.deepEqual(subject.embedded, ['P-2']);
    await subject.service.close();
  });

  test('disable aborts work and preserves completed rows for a later resume', async () => {
    const subject = world({
      candidates: CANDIDATES.slice(0, 1),
      embed: (_candidate, signal) =>
        new Promise<Int8Array>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
        }),
    });
    subject.service.enable();
    await waitFor(subject, 'indexing');

    assert.equal(subject.service.disable().phase, 'disabled');
    assert.equal(subject.service.status().pending, 1);
    await subject.service.close();
  });

  test('query reports every readiness and worker-contention outcome', async () => {
    const disabled = world();
    assert.deepEqual(await disabled.service.query('tram'), { embedding: null, fallback: 'disabled' });
    await disabled.service.close();

    const unavailable = world({ available: false, embedText: () => Promise.resolve(new Int8Array(EMBEDDING_DIMENSIONS)) });
    assert.deepEqual(await unavailable.service.query('tram'), { embedding: null, fallback: 'unavailable' });
    await unavailable.service.close();

    const indexing = world({ installed: false, embedText: () => Promise.resolve(new Int8Array(EMBEDDING_DIMENSIONS)) });
    indexing.service.enable();
    assert.deepEqual(await indexing.service.query('tram'), { embedding: null, fallback: 'indexing' });
    await indexing.service.close();

    const ready = world({
      candidates: [],
      initiallyEnabled: true,
      embedText: (text) => Promise.resolve(new Int8Array([text.length])),
    });
    ready.service.start();
    await waitFor(ready, 'ready');
    const result = await ready.service.query('tram');
    assert.equal(result.fallback, null);
    assert.deepEqual(result.embedding, new Int8Array([4]));
    await ready.service.close();

    const busy = world({
      candidates: [],
      initiallyEnabled: true,
      embedText: () => Promise.reject(new EmbeddingPoolBusyError()),
    });
    busy.service.start();
    await waitFor(busy, 'ready');
    assert.deepEqual(await busy.service.query('tram'), { embedding: null, fallback: 'busy' });
    await busy.service.close();

    const failed = world({ candidates: [], initiallyEnabled: true, embedText: () => Promise.reject(new Error('fixture failed')) });
    failed.service.start();
    await waitFor(failed, 'ready');
    assert.deepEqual(await failed.service.query('tram'), { embedding: null, fallback: 'error' });
    await failed.service.close();
  });
});
