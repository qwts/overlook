import type { Readable } from 'node:stream';

import { openRecoveryBootstrap } from './recovery-bootstrap.js';
import { custodyRemoteRoot } from './custody-handle.js';
import type { CustodyAuthorityRepository } from './custody-authority-repository.js';
import { raceWithAbort, type ProviderAccountIdentity, type StorageProvider } from './provider.js';

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;

export type CustodyReconnectResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'wrong-account' | 'unavailable' };

export interface CustodyReconnectDeps {
  readonly authorities: Pick<CustodyAuthorityRepository, 'create' | 'legacyUnboundCount' | 'markVerified' | 'stageReconnectVerification'>;
  readonly libraryId: () => string;
  readonly masterKey: () => Buffer;
  readonly now: () => string;
  readonly custodyChanged?: (() => void) | undefined;
}

async function readBootstrap(stream: Readable, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  const abort = (): void => {
    stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('reconnect proof aborted'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const value of stream) {
      signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      length += chunk.length;
      if (length > MAX_BOOTSTRAP_BYTES) {
        stream.destroy();
        throw new Error('recovery bootstrap exceeds the size limit');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function bootstrapStream(provider: StorageProvider, signal?: AbortSignal): Promise<Readable> {
  const pending = provider.getStream('recovery/bootstrap.ovrb');
  try {
    return await raceWithAbort(pending, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      void pending.then(
        (stream) => stream.destroy(),
        () => undefined,
      );
    }
    throw error;
  }
}

function notifyCustodyChanged(deps: CustodyReconnectDeps): void {
  try {
    deps.custodyChanged?.();
  } catch {
    // Registry hints are conservative derived state. A refresh failure must
    // never mask the durable authority transition or its typed result.
  }
}

/** Proves reconnect authority in the ADR-0028 order: provider subject first,
 * then an authenticated library bootstrap. The provider credential remains a
 * usable backup target when this returns a custody failure. */
export async function verifyCustodyReconnect(
  deps: CustodyReconnectDeps,
  input: { readonly provider: StorageProvider; readonly identity: ProviderAccountIdentity; readonly signal?: AbortSignal },
): Promise<CustodyReconnectResult> {
  input.signal?.throwIfAborted();
  const candidates = deps.authorities.stageReconnectVerification(input.provider.id);
  const hasLegacy = deps.authorities.legacyUnboundCount().items > 0;
  if (candidates.length === 0 && !hasLegacy) return { ok: true };

  const libraryId = deps.libraryId();
  const remoteRoot = custodyRemoteRoot(libraryId);
  const accountMatches = candidates.filter((authority) => authority.accountId === input.identity.accountId);
  if (candidates.length > 0 && accountMatches.length === 0 && !hasLegacy) {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'wrong-account' };
  }
  const exactMatches = accountMatches.filter((authority) => authority.remoteRoot === remoteRoot);
  if (accountMatches.length > 0 && exactMatches.length === 0 && !hasLegacy) {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'unavailable' };
  }

  const masterKey = deps.masterKey();
  let namespaceProven: boolean;
  try {
    const bootstrap = openRecoveryBootstrap(
      await readBootstrap(await bootstrapStream(input.provider, input.signal), input.signal),
      masterKey,
    );
    namespaceProven = bootstrap.libraryId === libraryId;
  } catch {
    namespaceProven = false;
  } finally {
    masterKey.fill(0);
  }
  if (!namespaceProven) {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const confirmedIdentity = await raceWithAbort(input.provider.accountIdentity(input.signal), input.signal);
    if (confirmedIdentity.accountId !== input.identity.accountId) {
      notifyCustodyChanged(deps);
      return { ok: false, reason: 'wrong-account' };
    }
  } catch {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'unavailable' };
  }

  const verifiedAt = deps.now();
  let authorityIds = exactMatches.map((authority) => authority.id);
  if (hasLegacy && authorityIds.length === 0) {
    const authority = deps.authorities.create({
      providerId: input.provider.id,
      accountId: input.identity.accountId,
      accountLabel: input.identity.accountLabel,
      remoteRoot,
      createdAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
    });
    authorityIds = [authority.id];
  }
  deps.authorities.markVerified(authorityIds, verifiedAt);
  notifyCustodyChanged(deps);
  if (candidates.some((authority) => authority.accountId !== input.identity.accountId)) {
    return { ok: false, reason: 'wrong-account' };
  }
  return accountMatches.length > 0 && exactMatches.length === 0 ? { ok: false, reason: 'unavailable' } : { ok: true };
}
