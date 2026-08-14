import type { PurgeService, PurgeSummary } from './purge-service.js';

export interface DrainablePurgeFacade {
  purge(photoIds: readonly string[]): Promise<PurgeSummary>;
  deletePermanently(photoIds: readonly string[]): Promise<PurgeSummary>;
  close(): void;
  drain(): Promise<void>;
}

/** Serializes destructive manual purges and gives app-lock teardown a
 * permanent admission fence plus cancellation/drain boundary. */
export function createPurgeRuntime(
  service: Pick<PurgeService, 'purge' | 'deletePermanently'>,
  workChanged: (delta: 1 | -1) => void,
): DrainablePurgeFacade {
  let controller: AbortController | null = null;
  let turn: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enqueue = (photoIds: readonly string[], permanent: boolean): Promise<PurgeSummary> => {
    const task = async () => {
      if (closed) throw new Error('purge service is closed');
      controller = new AbortController();
      workChanged(1);
      try {
        return await (permanent ? service.deletePermanently(photoIds, controller.signal) : service.purge(photoIds, controller.signal));
      } finally {
        workChanged(-1);
        controller = null;
      }
    };
    const next = turn.then(task, task);
    turn = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    purge: (photoIds) => enqueue(photoIds, false),
    deletePermanently: (photoIds) => enqueue(photoIds, true),
    close: () => {
      closed = true;
      controller?.abort();
    },
    drain: () =>
      turn.then(
        () => undefined,
        () => undefined,
      ),
  };
}
