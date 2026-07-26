import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EmbeddingCandidateStaleError, EMBEDDING_DIMENSIONS, type EmbeddingCandidate } from '../../src/main/db/embedding-repository.js';
import { EmbeddingService, type EmbeddingStatus } from '../../src/main/embedding/embedding-service.js';

const CANDIDATES: readonly EmbeddingCandidate[] = [
  { photoId: 'P-1', contentHash: '1'.repeat(64) },
  { photoId: 'P-2', contentHash: '2'.repeat(64) },
];

interface ServiceWorld {
  readonly service: EmbeddingService;
  readonly statuses: EmbeddingStatus[];
  readonly embedded: string[];
  setAutomaticPause(reason: 'import' | 'backup' | 'battery' | null): void;
}

function world(
  options: {
    readonly candidates?: readonly EmbeddingCandidate[];
    readonly installed?: boolean;
    readonly staleFirstPut?: boolean;
    readonly available?: boolean;
    readonly embed?: (candidate: EmbeddingCandidate, signal: AbortSignal) => Promise<Int8Array>;
  } = {},
): ServiceWorld {
  const candidates = [...(options.candidates ?? CANDIDATES)];
  const completed = new Set<string>();
  const embedded: string[] = [];
  const statuses: EmbeddingStatus[] = [];
  let enabled = false;
  let automaticPause: 'import' | 'backup' | 'battery' | null = null;
  let loaded: EmbeddingCandidate | undefined;
  let staleFirstPut = options.staleFirstPut ?? false;
  const service = new EmbeddingService({
    repository: {
      status: () => ({
        total: candidates.length,
        completed: completed.size,
        pending: candidates.length - completed.size,
      }),
      deleteStale: () => 0,
      pending: (_modelVersion, limit) => candidates.filter((candidate) => !completed.has(candidate.photoId)).slice(0, limit),
      put: (candidate) => {
        if (staleFirstPut) {
          staleFirstPut = false;
          completed.add(candidate.photoId);
          throw new EmbeddingCandidateStaleError('fixture changed');
        }
        completed.add(candidate.photoId);
        embedded.push(candidate.photoId);
      },
    },
    assets: {
      installed: () => Promise.resolve(options.installed ?? true),
      ensureInstalled: (_consent, progress) => {
        progress?.({ downloadedBytes: 4, totalBytes: 4, asset: 'model.onnx' });
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
      return Promise.resolve(Buffer.from(candidate.photoId));
    },
    embed: async (_bytes, signal) => {
      const candidate = loaded;
      if (candidate === undefined) throw new Error('fixture candidate was not loaded');
      return options.embed?.(candidate, signal) ?? new Int8Array(EMBEDDING_DIMENSIONS);
    },
    emit: (status) => statuses.push(status),
    ...(options.available === undefined ? {} : { available: options.available }),
    ...(options.available === false ? { unavailableReason: 'fixture runtime unavailable' } : {}),
    pausePollMs: 1,
  });
  return {
    service,
    statuses,
    embedded,
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
});
