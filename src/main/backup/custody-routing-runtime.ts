import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { SyncStatus } from '../../shared/library/types.js';
import { CustodyAuthorityRepository } from './custody-authority-repository.js';
import { CustodyHintCoordinator } from './custody-gate.js';
import { CustodyHandleResolver, custodyRemoteRoot } from './custody-handle.js';
import type { StorageProvider } from './provider.js';
import type { LibraryEntry } from '../../shared/library/registry.js';

export interface CustodyRoutingRuntimeDeps {
  readonly db: BetterSqlite3.Database;
  readonly backupTarget: StorageProvider;
  readonly libraryId: () => string;
  readonly provider: (providerId: string) => StorageProvider | undefined;
  readonly backupTargetConnected: () => boolean;
  readonly status: (photoId: string) => SyncStatus | undefined;
  readonly now: () => string;
  readonly writeCustodyHints?: ((hints: NonNullable<LibraryEntry['custodyHints']>) => void) | undefined;
  readonly audit?: ((line: string) => void) | undefined;
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
  const resolver = new CustodyHandleResolver({
    authorityForPhoto: (photoId) => authorities.forPhoto(photoId),
    provider: deps.provider,
    remoteRoot,
  });
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
