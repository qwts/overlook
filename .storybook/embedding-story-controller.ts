import type { OverlookApi } from '../src/shared/ipc/api.js';

type EmbeddingStatus = Awaited<ReturnType<OverlookApi['embedding']['status']>>;

export interface EmbeddingStoryController {
  readonly api: OverlookApi['embedding'];
  readonly advance: () => void;
}

export function createEmbeddingStoryController(): EmbeddingStoryController {
  let status: EmbeddingStatus = {
    phase: 'disabled',
    pauseReason: null,
    modelVersion: 'fixture-model-v1',
    total: 10,
    completed: 0,
    pending: 10,
    downloadedBytes: 0,
    downloadBytes: 154_949_606,
    error: null,
  };
  const listeners = new Set<Parameters<OverlookApi['embedding']['onChanged']>[0]>();
  const set = (next: EmbeddingStatus): Promise<EmbeddingStatus> => {
    status = next;
    for (const listener of listeners) listener(next);
    return Promise.resolve(next);
  };
  return {
    api: {
      status: () => Promise.resolve(status),
      enable: () => set({ ...status, phase: 'downloading' }),
      disable: () => set({ ...status, phase: 'disabled', pauseReason: null }),
      pause: () => set({ ...status, phase: 'paused', pauseReason: 'user' }),
      resume: () => set({ ...status, phase: 'indexing', pauseReason: null }),
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    advance: () => {
      void set({
        ...status,
        phase: 'indexing',
        downloadedBytes: status.downloadBytes,
        completed: 2,
        pending: 8,
      });
    },
  };
}
