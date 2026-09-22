import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { ProviderError, raceWithAbort, type StorageProvider } from './provider.js';

const fingerprint = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().nonnegative() });

export const pendingManifestMutationSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().min(1),
  libraryId: z.string().min(1),
  path: z.string().regex(/^(?:recovery\/bootstrap\.ovrb|manifest\/gen-[1-9]\d*\.ovlk)$/u),
  expected: fingerprint.nullable(),
  before: fingerprint.nullable(),
  settled: z.boolean(),
});
export type PendingManifestMutation = z.infer<typeof pendingManifestMutationSchema>;

export interface ManifestPublicationJournal {
  readonly load: () => PendingManifestMutation | null;
  /** Persist before a mutation; clearing an intent does not clear manifest debt. */
  readonly save: (pending: PendingManifestMutation | null) => void;
}

/** A timeout does not prove rollback. Retrying a mutable bootstrap while an
 * earlier replacement may still land can invalidate a newer recovery chain. */
export class ManifestPublication {
  private accountId = '';
  private readonly providerId: string;

  constructor(
    private readonly provider: StorageProvider,
    private readonly libraryId: string,
    private readonly journal: ManifestPublicationJournal,
    readonly signal: AbortSignal,
  ) {
    this.providerId = provider.id;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.provider.id !== this.providerId) throw new Error('manifest publication provider changed');
    const result = await raceWithAbort(operation(), this.signal);
    this.signal.throwIfAborted();
    if (this.provider.id !== this.providerId) throw new Error('manifest publication provider changed');
    return result;
  }

  reportFailure(audit: (line: string) => void, callerSignal?: AbortSignal): void {
    const reason = callerSignal?.aborted === true ? 'cancelled' : this.signal.aborted ? 'timeout' : 'unavailable';
    const outcome = this.journal.load() === null ? 'incomplete' : 'unknown';
    audit(`MANIFEST-PUBLISH-FAIL reason=${reason} outcome=${outcome}`);
  }

  async reconcile(): Promise<void> {
    this.accountId = (await this.execute(() => this.provider.accountIdentity(this.signal))).accountId;
    const pending = this.journal.load();
    if (pending === null) return;
    if (pending.providerId !== this.providerId || pending.libraryId !== this.libraryId || pending.accountId !== this.accountId)
      throw new Error('manifest publication outcome unknown: original provider account required');
    const remote = await this.fingerprint(pending.path);
    const matches = (expected: PendingManifestMutation['expected']): boolean =>
      remote === null ? expected === null : expected !== null && remote.sha256 === expected.sha256 && remote.bytes === expected.bytes;
    if (
      (!pending.settled && matches(pending.expected) && matches(pending.before)) ||
      (!matches(pending.expected) && !(pending.settled && matches(pending.before)))
    )
      throw new Error('manifest publication outcome unknown: previous mutation not reconciled');
    this.journal.save(null);
  }

  private async fingerprint(path: string): Promise<PendingManifestMutation['expected']> {
    try {
      return await this.execute(() => this.provider.verify(path));
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'not-found') throw error;
      this.signal.throwIfAborted();
      return null;
    }
  }

  private async mutate(operation: () => Promise<unknown>, pending: PendingManifestMutation): Promise<void> {
    try {
      await this.execute(operation);
      this.journal.save({ ...pending, settled: true });
    } catch (error) {
      // A rejected network request can still commit remotely. Only an explicit
      // pre-mutation refusal proves that retry cannot race a late write.
      if (!this.signal.aborted && error instanceof ProviderError && error.mutationNotStarted)
        this.journal.save({ ...pending, settled: true });
      throw error;
    }
  }

  async putVerified(path: string, bytes: Buffer): Promise<void> {
    const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const pending = await this.begin(path, expected);
    const stream = Readable.from([bytes]);
    // Providers that are still consuming input can stop immediately. Buffered
    // or native writes remain uncertain until their recorded bytes are verified.
    const abort = (): void => {
      stream.destroy();
    };
    this.signal.addEventListener('abort', abort, { once: true });
    try {
      await this.mutate(() => this.provider.put(path, stream), pending);
      const remote = await this.execute(() => this.provider.verify(path));
      if (remote.sha256 !== expected.sha256 || remote.bytes !== expected.bytes)
        throw new ProviderError(`verify mismatch for ${path}`, 'corrupt');
      this.journal.save(null);
    } finally {
      this.signal.removeEventListener('abort', abort);
      stream.destroy();
    }
  }

  async remove(path: string): Promise<void> {
    const pending = await this.begin(path, null);
    await this.mutate(() => this.provider.delete(path), pending);
    this.journal.save(null);
  }

  private async begin(path: string, expected: PendingManifestMutation['expected']): Promise<PendingManifestMutation> {
    this.signal.throwIfAborted();
    if (this.journal.load() !== null) throw new Error('manifest publication outcome unknown: reconciliation required');
    const before = await this.fingerprint(path);
    const pending = pendingManifestMutationSchema.parse({
      providerId: this.providerId,
      accountId: this.accountId,
      libraryId: this.libraryId,
      path,
      expected,
      before,
      settled: false,
    });
    this.journal.save(pending);
    return pending;
  }
}

const MANIFEST_GENERATION_PATH = /^manifest\/gen-(\d+)\.ovlk$/u;

export function nextManifestPublication(entries: readonly { readonly path: string }[]): {
  readonly generation: number;
  readonly previousPath: string | null;
} {
  let previous: { readonly generation: number; readonly path: string } | null = null;
  for (const { path } of entries) {
    const match = MANIFEST_GENERATION_PATH.exec(path);
    if (match === null) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error(`invalid manifest generation path ${path}`);
    }
    if (previous === null || generation > previous.generation) previous = { generation, path };
  }
  if (previous !== null && previous.generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error('manifest generation space is exhausted');
  }
  return { generation: (previous?.generation ?? 0) + 1, previousPath: previous?.path ?? null };
}

/** Only older generations are eligible: an unrelated/newer listing entry
 * cannot count toward retention and evict the verified predecessor. */
export function staleManifestPaths(entries: readonly { readonly path: string }[], generation: number): readonly string[] {
  return entries
    .filter(({ path }) => {
      const number = Number(MANIFEST_GENERATION_PATH.exec(path)?.[1]);
      return Number.isSafeInteger(number) && number > 0 && number < generation - 1;
    })
    .map(({ path }) => path);
}
