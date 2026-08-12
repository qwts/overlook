export async function drainBeforeDeadline(tasks: readonly Promise<unknown>[], timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('library work did not drain before the lock deadline')), timeoutMs);
  });
  try {
    await Promise.race([Promise.all(tasks), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class CustodyWorkTracker {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    const remove = (): void => {
      this.active.delete(work);
    };
    void work.then(remove, remove);
    return work;
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}

/** Cancel before and after draining: an in-flight completion callback may
 * re-arm scheduled work while the barrier is waiting. */
export async function drainWithCancellationFence(
  cancelScheduled: () => void,
  tasks: readonly Promise<unknown>[],
  timeoutMs = 10_000,
): Promise<void> {
  cancelScheduled();
  await drainBeforeDeadline(tasks, timeoutMs);
  cancelScheduled();
}

export async function releaseLibraryLockAfter(work: () => Promise<void>, release: () => void): Promise<void> {
  await work();
  release();
}
