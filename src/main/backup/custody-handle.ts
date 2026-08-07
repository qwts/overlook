import type { CustodyAuthority } from './custody-authority-repository.js';
import type { StorageProvider } from './provider.js';

export type CustodyFailureReason = 'custody-disconnected' | 'custody-wrong-account' | 'custody-unavailable';

export class CustodyResolutionError extends Error {
  override readonly name = 'CustodyResolutionError';

  constructor(readonly reason: CustodyFailureReason) {
    super(reason);
  }
}

export interface CustodyHandle {
  readonly authority: CustodyAuthority;
  readonly provider: StorageProvider;
}

export interface CustodyHandleDependencies {
  readonly authorityForPhoto: (photoId: string) => CustodyAuthority | undefined;
  readonly provider: (providerId: string) => StorageProvider | undefined;
  readonly remoteRoot: () => string;
  readonly prepareAuthority?:
    | ((authority: CustodyAuthority) => Promise<{
        readonly authority: CustodyAuthority;
        readonly reconnectFailure?: 'wrong-account' | 'unavailable';
      }>)
    | undefined;
}

/** The canonical namespace represented by a library-scoped provider instance. */
export function custodyRemoteRoot(libraryId: string): string {
  return `/Overlook/${libraryId}/`;
}

/** Resolves sole-remote operations only from the row's recorded authority.
 * Provider selection is deliberately absent from this interface. */
export class CustodyHandleResolver {
  constructor(private readonly deps: CustodyHandleDependencies) {}

  async resolve(photoId: string): Promise<CustodyHandle> {
    const authority = this.deps.authorityForPhoto(photoId);
    if (authority === undefined) throw new CustodyResolutionError('custody-unavailable');
    return this.resolveAuthority(authority);
  }

  async resolveAuthority(authority: CustodyAuthority): Promise<CustodyHandle> {
    let reconnectFailure: 'wrong-account' | 'unavailable' | undefined;
    if (this.deps.prepareAuthority !== undefined) {
      try {
        const prepared = await this.deps.prepareAuthority(authority);
        authority = prepared.authority;
        reconnectFailure = prepared.reconnectFailure;
      } catch (error) {
        if (error instanceof CustodyResolutionError) throw error;
        throw new CustodyResolutionError('custody-unavailable');
      }
    }
    const provider = this.deps.provider(authority.providerId);
    if (provider === undefined) throw new CustodyResolutionError('custody-disconnected');

    let authState: Awaited<ReturnType<StorageProvider['authState']>>;
    try {
      authState = await provider.authState();
    } catch {
      throw new CustodyResolutionError('custody-unavailable');
    }
    if (authState === 'not-connected') throw new CustodyResolutionError('custody-disconnected');
    if (authState !== 'connected') throw new CustodyResolutionError('custody-unavailable');

    let accountId: string;
    try {
      accountId = (await provider.accountIdentity()).accountId;
    } catch {
      throw new CustodyResolutionError('custody-unavailable');
    }
    if (accountId !== authority.accountId) throw new CustodyResolutionError('custody-wrong-account');
    if (authority.state === 'provider-required') {
      throw new CustodyResolutionError(reconnectFailure === 'unavailable' ? 'custody-unavailable' : 'custody-disconnected');
    }
    if (this.deps.remoteRoot() !== authority.remoteRoot) throw new CustodyResolutionError('custody-unavailable');

    return { authority, provider };
  }
}
