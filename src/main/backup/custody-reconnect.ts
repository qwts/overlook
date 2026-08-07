import type { Readable } from 'node:stream';

import { openRecoveryBootstrap } from './recovery-bootstrap.js';
import { custodyRemoteRoot } from './custody-handle.js';
import type { CustodyAuthorityRepository } from './custody-authority-repository.js';
import type { ProviderAccountIdentity, StorageProvider } from './provider.js';

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;

export type CustodyReconnectResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'wrong-account' | 'unavailable' };

export interface CustodyReconnectDeps {
  readonly authorities: Pick<CustodyAuthorityRepository, 'create' | 'legacyUnboundCount' | 'markVerified' | 'stageReconnectVerification'>;
  readonly libraryId: () => string;
  readonly masterKey: () => Buffer;
  readonly now: () => string;
  readonly custodyChanged?: (() => void) | undefined;
}

async function readBootstrap(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > MAX_BOOTSTRAP_BYTES) {
      stream.destroy();
      throw new Error('recovery bootstrap exceeds the size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
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
  input: { readonly provider: StorageProvider; readonly identity: ProviderAccountIdentity },
): Promise<CustodyReconnectResult> {
  const candidates = deps.authorities.stageReconnectVerification(input.provider.id);
  const hasLegacy = deps.authorities.legacyUnboundCount().items > 0;
  if (candidates.length === 0 && !hasLegacy) return { ok: true };

  const libraryId = deps.libraryId();
  const remoteRoot = custodyRemoteRoot(libraryId);
  const accountMatches = candidates.filter((authority) => authority.accountId === input.identity.accountId);
  if (candidates.length > 0 && accountMatches.length === 0) {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'wrong-account' };
  }
  const exactMatches = accountMatches.filter((authority) => authority.remoteRoot === remoteRoot);
  if (accountMatches.length > 0 && exactMatches.length === 0) {
    notifyCustodyChanged(deps);
    return { ok: false, reason: 'unavailable' };
  }

  const masterKey = deps.masterKey();
  let namespaceProven: boolean;
  try {
    const bootstrap = openRecoveryBootstrap(await readBootstrap(await input.provider.getStream('recovery/bootstrap.ovrb')), masterKey);
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
    const confirmedIdentity = await input.provider.accountIdentity();
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
  return candidates.some((authority) => authority.accountId !== input.identity.accountId)
    ? { ok: false, reason: 'wrong-account' }
    : { ok: true };
}
