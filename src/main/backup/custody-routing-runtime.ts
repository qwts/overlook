import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { SyncStatus } from '../../shared/library/types.js';
import { CustodyAuthorityRepository, type CustodyAuthority } from './custody-authority-repository.js';
import { CustodyHintCoordinator } from './custody-gate.js';
import { CustodyHandleResolver, CustodyResolutionError, custodyRemoteRoot } from './custody-handle.js';
import { raceWithAbort, type ProviderAccountIdentity, type StorageProvider } from './provider.js';
import type { LibraryEntry } from '../../shared/library/registry.js';
import type { LibraryRegistryRuntime } from '../library/library-registry-runtime.js';
import { verifyCustodyReconnect } from './custody-reconnect.js';
import type { PhotoCustodyState, PhotoCustodyStatus } from '../../shared/backup/custody-status.js';

export interface CustodyRoutingRuntimeDeps {
  readonly db: BetterSqlite3.Database;
  readonly backupTarget: StorageProvider;
  readonly libraryId: () => string;
  readonly provider: (providerId: string) => StorageProvider | undefined;
  readonly backupTargetConnected: () => boolean;
  readonly status: (photoId: string) => SyncStatus | undefined;
  readonly now: () => string;
  readonly masterKey: () => Buffer;
  readonly persistAccountIdentity?: ((providerId: string, identity: ProviderAccountIdentity) => boolean) | undefined;
  readonly writeCustodyHints?: ((hints: NonNullable<LibraryEntry['custodyHints']>) => void) | undefined;
  readonly audit?: ((line: string) => void) | undefined;
}

async function accountIdentity(
  provider: StorageProvider,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<StorageProvider['accountIdentity']>> | null> {
  try {
    return await raceWithAbort(provider.accountIdentity(signal), signal);
  } catch {
    return null;
  }
}

class ReconnectProofCoordinator {
  private readonly proofs = new Map<string, Promise<Awaited<ReturnType<typeof verifyCustodyReconnect>>>>();
  private readonly active = new Set<Promise<unknown>>();
  private abortController = new AbortController();
  private pauseDepth = 0;
  private closed = false;

  constructor(
    private readonly deps: CustodyRoutingRuntimeDeps,
    private readonly authorities: CustodyAuthorityRepository,
    private readonly custodyChanged: () => void,
  ) {}

  async verify(provider: StorageProvider): Promise<Awaited<ReturnType<typeof verifyCustodyReconnect>>> {
    return this.track(this.verifyTracked(provider));
  }

  async prepare(authority: CustodyAuthority): Promise<{
    readonly authority: CustodyAuthority;
    readonly reconnectFailure?: 'wrong-account' | 'unavailable';
  }> {
    return this.track(this.prepareTracked(authority));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort(new Error('library closing'));
    await Promise.allSettled([...this.active]);
    this.proofs.clear();
  }

  async pause(): Promise<() => void> {
    this.pauseDepth += 1;
    if (this.pauseDepth === 1) this.abortController.abort(new Error('provider authorization changing'));
    await Promise.allSettled([...this.active]);
    this.proofs.clear();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauseDepth -= 1;
      if (this.pauseDepth === 0 && !this.closed) this.abortController = new AbortController();
    };
  }

  private async verifyTracked(provider: StorageProvider): Promise<Awaited<ReturnType<typeof verifyCustodyReconnect>>> {
    if (this.closed || this.pauseDepth > 0) return { ok: false, reason: 'unavailable' };
    const providerId = provider.id;
    let proof = this.proofs.get(providerId);
    if (proof === undefined) {
      proof = this.prove(provider);
      this.proofs.set(providerId, proof);
    }
    try {
      return await proof;
    } catch {
      return { ok: false, reason: 'unavailable' };
    } finally {
      if (this.proofs.get(providerId) === proof) this.proofs.delete(providerId);
    }
  }

  private async prepareTracked(authority: CustodyAuthority): Promise<{
    readonly authority: CustodyAuthority;
    readonly reconnectFailure?: 'wrong-account' | 'unavailable';
  }> {
    const provider = this.deps.provider(authority.providerId);
    let reconnectFailure: 'wrong-account' | 'unavailable' | undefined;
    if (provider === undefined) this.authorities.stageReconnectVerification(authority.providerId);
    else {
      const result = await this.verify(provider);
      if (!result.ok) reconnectFailure = result.reason;
    }
    return {
      authority: this.authorities.get(authority.id) ?? authority,
      ...(reconnectFailure === undefined ? {} : { reconnectFailure }),
    };
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  private async prove(provider: StorageProvider): Promise<Awaited<ReturnType<typeof verifyCustodyReconnect>>> {
    this.authorities.stageReconnectVerification(provider.id);
    const signal = this.abortController.signal;
    const identity = await accountIdentity(provider, signal);
    if (identity === null) return { ok: false, reason: 'unavailable' };
    const result = await verifyCustodyReconnect(
      {
        authorities: this.authorities,
        libraryId: this.deps.libraryId,
        masterKey: this.deps.masterKey,
        now: this.deps.now,
        custodyChanged: this.custodyChanged,
      },
      { provider, identity, signal },
    );
    if (
      !result.ok &&
      result.reason === 'wrong-account' &&
      result.replacementIdentity !== undefined &&
      this.deps.persistAccountIdentity?.(provider.id, result.replacementIdentity) !== true
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    return result;
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

function createCustodyStatus(
  deps: CustodyRoutingRuntimeDeps,
  authorities: CustodyAuthorityRepository,
  resolver: CustodyHandleResolver,
): (photoId: string) => Promise<PhotoCustodyStatus> {
  return async (photoId) => {
    const authority = authorities.forPhoto(photoId);
    if (authority === undefined) {
      return {
        state: authorities.isLegacyUnbound(photoId) ? 'legacy-unbound' : 'available',
        providerId: null,
        providerLabel: null,
        accountLabel: null,
      };
    }
    const provider = deps.provider(authority.providerId);
    const identity = {
      providerId: authority.providerId,
      providerLabel: provider?.label ?? authority.providerId,
      accountLabel: authority.accountLabel,
    };
    if (authority.state === 'provider-required') return { state: 'provider-required', ...identity };
    let state: PhotoCustodyState = 'available';
    try {
      await resolver.resolveAuthority(authority);
    } catch (error) {
      state =
        error instanceof CustodyResolutionError
          ? error.reason === 'custody-disconnected'
            ? 'disconnected'
            : error.reason === 'custody-wrong-account'
              ? 'wrong-account'
              : 'unavailable'
          : 'unavailable';
    }
    return { state, ...identity };
  };
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
  const custodyStatus = createCustodyStatus(deps, authorities, resolver);
  const legacyAuthority = async () => {
    if (!deps.backupTargetConnected()) return null;
    const identity = await accountIdentity(deps.backupTarget);
    if (identity === null) return null;
    let authority = authorities.verified(deps.backupTarget.id, identity.accountId, remoteRoot());
    if (authority === undefined && authorities.legacyUnboundCount().items > 0) {
      await reconnect.verify(deps.backupTarget);
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
    custodyStatus,
    close: () => reconnect.close(),
    pauseReconnectProofs: () => reconnect.pause(),
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
