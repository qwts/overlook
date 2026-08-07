import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { SyncStatus } from '../../shared/library/types.js';
import { CustodyAuthorityRepository, type CustodyAuthority } from './custody-authority-repository.js';
import { CustodyHintCoordinator } from './custody-gate.js';
import { CustodyHandleResolver, custodyRemoteRoot } from './custody-handle.js';
import type { StorageProvider } from './provider.js';
import type { LibraryEntry } from '../../shared/library/registry.js';
import type { LibraryRegistryRuntime } from '../library/library-registry-runtime.js';
import { verifyCustodyReconnect } from './custody-reconnect.js';

export interface CustodyRoutingRuntimeDeps {
  readonly db: BetterSqlite3.Database;
  readonly backupTarget: StorageProvider;
  readonly libraryId: () => string;
  readonly provider: (providerId: string) => StorageProvider | undefined;
  readonly backupTargetConnected: () => boolean;
  readonly status: (photoId: string) => SyncStatus | undefined;
  readonly now: () => string;
  readonly masterKey: () => Buffer;
  readonly writeCustodyHints?: ((hints: NonNullable<LibraryEntry['custodyHints']>) => void) | undefined;
  readonly audit?: ((line: string) => void) | undefined;
}

async function accountIdentity(provider: StorageProvider): Promise<Awaited<ReturnType<StorageProvider['accountIdentity']>> | null> {
  try {
    return await provider.accountIdentity();
  } catch {
    return null;
  }
}

class ReconnectProofCoordinator {
  private readonly proofs = new Map<string, Promise<boolean>>();

  constructor(
    private readonly deps: CustodyRoutingRuntimeDeps,
    private readonly authorities: CustodyAuthorityRepository,
    private readonly custodyChanged: () => void,
  ) {}

  async verify(provider: StorageProvider): Promise<boolean> {
    let proof = this.proofs.get(provider.id);
    if (proof === undefined) {
      proof = this.prove(provider);
      this.proofs.set(provider.id, proof);
    }
    try {
      return await proof;
    } catch {
      return false;
    } finally {
      if (this.proofs.get(provider.id) === proof) this.proofs.delete(provider.id);
    }
  }

  async prepare(authority: CustodyAuthority): Promise<CustodyAuthority> {
    const provider = this.deps.provider(authority.providerId);
    if (provider === undefined) this.authorities.stageReconnectVerification(authority.providerId);
    else await this.verify(provider);
    return this.authorities.get(authority.id) ?? authority;
  }

  private async prove(provider: StorageProvider): Promise<boolean> {
    this.authorities.stageReconnectVerification(provider.id);
    const identity = await accountIdentity(provider);
    if (identity === null) return false;
    const result = await verifyCustodyReconnect(
      {
        authorities: this.authorities,
        libraryId: this.deps.libraryId,
        masterKey: this.deps.masterKey,
        now: this.deps.now,
        custodyChanged: this.custodyChanged,
      },
      { provider, identity },
    );
    return result.ok;
  }
}

/** Open-time migration/recount: legacy rows must reach the registry even if
 * no backup service is otherwise constructed before the library is sealed. */
export function refreshCustodyHints(
  db: BetterSqlite3.Database,
  registry: Pick<LibraryRegistryRuntime, 'resolveActive' | 'getRegistry'>,
): void {
  const authorities = new CustodyAuthorityRepository(db);
  new CustodyHintCoordinator({
    authorities,
    write: (hints) => registry.getRegistry().updateCustodyHints(registry.resolveActive().id, hints),
  }).refresh();
}

/** Splits selection-addressed backup work from binding-addressed custody at
 * the composition boundary so callers cannot accidentally share a facade. */
export function createCustodyRoutingRuntime(deps: CustodyRoutingRuntimeDeps) {
  const authorities = new CustodyAuthorityRepository(deps.db);
  const hintCoordinator =
    deps.writeCustodyHints === undefined ? undefined : new CustodyHintCoordinator({ authorities, write: deps.writeCustodyHints });
  const custodyChanged = (): void => {
    try {
      hintCoordinator?.refresh();
    } catch (error) {
      deps.audit?.(`CUSTODY-HINT-REFRESH-FAIL reason=${error instanceof Error ? error.message : String(error)}`);
    }
  };
  custodyChanged();
  const remoteRoot = (): string => custodyRemoteRoot(deps.libraryId());
  const reconnect = new ReconnectProofCoordinator(deps, authorities, custodyChanged);
  for (const { authority } of authorities.soleCustodyCounts()) {
    void reconnect.prepare(authority).catch(() => undefined);
  }
  if (authorities.legacyUnboundCount().items > 0 && deps.backupTargetConnected()) {
    void reconnect.verify(deps.backupTarget).catch(() => false);
  }
  const resolver = new CustodyHandleResolver({
    authorityForPhoto: (photoId) => authorities.forPhoto(photoId),
    provider: deps.provider,
    remoteRoot,
    prepareAuthority: (authority) => reconnect.prepare(authority),
  });
  const legacyAuthority = async () => {
    if (!deps.backupTargetConnected()) return null;
    const identity = await accountIdentity(deps.backupTarget);
    if (identity === null) return null;
    let authority = authorities.verified(deps.backupTarget.id, identity.accountId, remoteRoot());
    if (authority === undefined && authorities.legacyUnboundCount().items > 0) {
      if (!(await reconnect.verify(deps.backupTarget))) return null;
      authority = authorities.verified(deps.backupTarget.id, identity.accountId, remoteRoot());
    }
    if (authority === undefined) return null;
    try {
      return await resolver.resolveAuthority(authority);
    } catch {
      return null;
    }
  };
  return {
    authorities,
    resolver,
    offloadAuthority: async (bytes: number): Promise<number> => {
      const identity = await deps.backupTarget.accountIdentity();
      const authority = authorities.create({
        providerId: deps.backupTarget.id,
        accountId: identity.accountId,
        accountLabel: identity.accountLabel,
        remoteRoot: remoteRoot(),
        createdAt: deps.now(),
      });
      hintCoordinator?.beforeBinding({ providerId: authority.providerId, accountId: authority.accountId }, bytes);
      return authority.id;
    },
    custodyChanged,
    integrity: {
      authorities,
      custody: resolver,
      legacyAuthority,
      bindLegacyPhoto: (photoId: string, authorityId: number) => authorities.bindLegacyPhoto(photoId, authorityId),
      custodyChanged,
    },
    remoteProvider: async (photoId: string): Promise<StorageProvider> => {
      const authority = authorities.forPhoto(photoId);
      if (authority !== undefined) return (await resolver.resolveAuthority(authority)).provider;
      if (deps.status(photoId) === 'offloaded') return (await resolver.resolve(photoId)).provider;
      if (!deps.backupTargetConnected()) throw new Error('backup target is disconnected');
      const provider = deps.provider(deps.backupTarget.id);
      if (provider === undefined) throw new Error('backup target is unavailable');
      return provider;
    },
  };
}
