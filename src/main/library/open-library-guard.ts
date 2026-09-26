/** Runs library open under the process lock. A throw on the first acquire
 * releases the lock so a failed unwrap does not look like another instance. */
export function openWithLibraryLock<T>(options: {
  readonly dataDir: string;
  readonly instanceId: string;
  readonly heldRelease: (() => void) | undefined;
  readonly acquire: (dataDir: string, instanceId: string) => () => void;
  readonly open: () => T;
}): { readonly value: T; readonly release: () => void } {
  const acquiredNow = options.heldRelease === undefined;
  const release = options.heldRelease ?? options.acquire(options.dataDir, options.instanceId);
  try {
    return { value: options.open(), release };
  } catch (error) {
    if (acquiredNow) release();
    throw error;
  }
}
